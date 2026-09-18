// journal — magasin NDJSON du journal d'erreurs 3 étages (étage 1). Deux fichiers PLATS
// (server/client), un enregistrement par SIGNATURE (jamais un par occurrence) : une erreur qui
// se répète incrémente un compteur au lieu de faire grossir le fichier sans borne. Conçu pour
// être robuste à l'excès — AUCUNE des opérations exposées ne lève jamais (cf. `record`/`list`/
// `purge`/`flush`/`close`) : un journal qui plante l'appli qu'il est censé surveiller serait absurde.
//
// Pas de précédent NDJSON dans ce projet — écriture ATOMIQUE (tmp + renameSync, même patron que
// `Bundler.writeFileAtomicAlways`, bundler/index.ts) mais DÉBOUNCÉE (~1s, cf. RELOAD_DEBOUNCE_MS
// de cli/ws.ts pour le même motif clearTimeout/setTimeout) : chaque `record()` ne réécrit pas le
// fichier immédiatement, une rafale d'erreurs coalesce en une poignée d'écritures disque.
//
// `process.on('exit', …)` best-effort (flush du dernier état avant que le process ne parte) —
// insuffisant SEUL : `systemctl stop` envoie SIGTERM, qui termine Node SANS jamais atteindre ce
// hook — jusqu'à DEBOUNCE_MS (1s) d'erreurs fraîchement enregistrées perdues à CHAQUE
// redéploiement. `ensureSigtermHook()` comble ce trou : `process.once('SIGTERM', …)` flush puis
// SE RÉ-ENVOIE le signal (`process.kill(process.pid, 'SIGTERM')`) — `once` s'étant auto-retiré
// dès le premier appel, ce 2e SIGTERM ne trouve plus aucun listener et Node reprend son
// comportement PAR DÉFAUT (terminaison, code de sortie 143 préservé pour l'appelant, ex. systemd).
//
// COROLLAIRE à connaître, et c'est la raison d'être de `close()` : une écriture encore en attente
// au moment du hook 'exit' passe par `writeAtomic`, qui RECRÉE le dossier cible s'il a disparu
// entre-temps (mkdirSync recursive). En production c'est voulu (mieux vaut recréer un dossier de
// logs effacé sous les pieds du serveur que perdre les dernières erreurs d'un `systemctl stop`) ;
// pour un appelant à durée de vie courte — test, script, commande one-shot — c'est un dossier qui
// RESSUSCITE après son propre ménage. `close()` solde et se retire du hook : le cas disparaît.
//
// PAS de `process.on('SIGINT', …)` en revanche : vérifié
// empiriquement (aucun listener SIGINT préexistant dans `mjs serve`) qu'ajouter un listener SIGINT
// qui ne fait QUE flush (sans `process.exit()` ni ré-émission façon SIGTERM ci-dessus) SUPPRIME
// le comportement de terminaison PAR DÉFAUT de Ctrl+C (le process reste vivant tant que rien
// n'appelle `process.exit()`) — régression bien pire que la perte, best-effort, de quelques
// entrées non encore flushées. Un listener PAR ÉVÉNEMENT ('exit'/'SIGTERM'), PARTAGÉ (module-level,
// jamais un par instance), évite tout MaxListenersExceededWarning au fil des nombreux
// `createJournal()` d'une suite de tests.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { t } from '../messages/index.js'

export type JournalSource = 'server' | 'client'

export interface JournalEntryInput {
  message: string
  pile?: string
  url?: string
  version?: string | null
  ua?: string
}

export interface JournalEntry {
  ts: number
  source: JournalSource
  signature: string
  message: string
  pile: string
  url: string
  version: string | null
  ua?: string
  n: number
  premier: number
  dernier: number
}

export interface JournalOptions {
  dir: string
  maxEntries?: number
  maxBytes?: number
}

export interface Journal {
  record(source: JournalSource, entry: JournalEntryInput): void
  list(): JournalEntry[]
  purge(source?: JournalSource | null): void
  flush(): void
  /** Solde les écritures en attente PUIS retire ce journal du hook de sortie (`process.on('exit')`)
   *  — à appeler par tout appelant à DURÉE DE VIE COURTE (test, script, commande CLI one-shot) qui
   *  ne veut pas voir son dossier de logs recréé après coup. Idempotent. Un `record()` postérieur
   *  reste honoré, mais écrit IMMÉDIATEMENT (plus de débounce à rattraper) : jamais de perte muette. */
  close(): void
}

/** Callback pré-gaté (déjà tranché selon `journal.server`, cf. render-server.ts) branché sur les
 *  5 points de capture serveur — `source` et `version` sont posés par l'appelant (startRenderServer),
 *  chaque point ne fournit que ce qu'il connaît. INERTE (no-op) si l'étage serveur est désactivé —
 *  aucun des call-sites n'a besoin de tester la config lui-même. */
export type RecordServerFn = (entry: { message: string, pile?: string, url?: string }) => void

const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_MAX_BYTES   = 1_048_576
const DEBOUNCE_MS         = 1000
// Cap défensif du champ STOCKÉ `message` — aligné sur le plafond déjà posé par l'endpoint POST
// (render-server.ts, 2 Ko) : un filet pour les AUTRES appelants (les 5 points de capture serveur,
// qui ne pré-tronquent rien eux-mêmes), jamais une 2e troncature visible pour l'endpoint.
const MAX_MESSAGE_CHARS       = 2048
// Extrait utilisé UNIQUEMENT pour la clé de GROUPEMENT (signature) — cf. le JSDoc de `record()` :
// « message (1re ligne, ≤300 c.) » qualifie la signature, PAS le champ stocké.
const MAX_SIGNATURE_MSG_CHARS = 300
const MAX_PILE_CHARS          = 8192

const FILE_BY_SOURCE: Record<JournalSource, string> = {
  server: 'mjs-errors-server.ndjson',
  client: 'mjs-errors-client.ndjson',
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

function firstLine(s: string): string {
  const i = s.indexOf('\n')
  return i === -1 ? s : s.slice(0, i)
}

// `message`/`pile` reçus ICI sont déjà les valeurs STOCKÉES (post-troncature MAX_MESSAGE_CHARS/
// MAX_PILE_CHARS, cf. record()) — la signature en dérive un extrait PLUS ÉTROIT (1re ligne, ≤300 c.
// pour le message ; 1re ligne seule pour la pile), sans jamais réduire ce qui est écrit sur disque.
function signatureOf(message: string, pile: string, url: string): string {
  return truncate(firstLine(message), MAX_SIGNATURE_MSG_CHARS) + '\n' + firstLine(pile) + '\n' + url
}

function serialize(entries: JournalEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')
}

// retire l'entrée au `dernier` le plus ANCIEN (purge FIFO) — recherche linéaire, journaux bornés
// (≤ quelques centaines d'entrées par défaut), pas besoin d'une structure plus élaborée.
function removeOldest(entries: JournalEntry[]): void {
  if (entries.length === 0) return
  let idx = 0
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].dernier < entries[idx].dernier) idx = i
  }
  entries.splice(idx, 1)
}

function enforceCaps(entries: JournalEntry[], maxEntries: number, maxBytes: number): void {
  while (entries.length > maxEntries) removeOldest(entries)
  while (entries.length > 0 && Buffer.byteLength(serialize(entries), 'utf-8') > maxBytes) removeOldest(entries)
}

// écriture atomique (tmp + renameSync, même patron que Bundler.writeFileAtomicAlways) — dossier
// créé PARESSEUSEMENT ici (jamais avant le tout premier write réel).
function writeAtomic(target: string, content: string): void {
  const dir = dirname(target)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  writeFileSync(tmp, content, 'utf-8')
  try {
    renameSync(tmp, target)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* best-effort */ }
    throw e
  }
}

// chargement paresseux d'un fichier NDJSON existant — une ligne invalide (JSON cassé, vide, pas
// un objet) est IGNORÉE en silence, jamais un crash (le fichier peut avoir été tronqué par un
// arrêt brutal précédent).
function loadFile(path: string): JournalEntry[] {
  if (!existsSync(path)) return []
  const out: JournalEntry[] = []
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return []
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed as JournalEntry)
    } catch { /* ligne corrompue ignorée */ }
  }
  return out
}

// listener 'exit' UNIQUE, partagé par TOUTES les instances (jamais un par createJournal() —
// éviterait un MaxListenersExceededWarning au fil d'une suite de tests qui en crée des dizaines).
const pendingFlushes = new Set<() => void>()
let exitHookInstalled = false
function ensureExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const fn of pendingFlushes) {
      try { fn() } catch { /* best-effort */ }
    }
  })
}

// listener 'SIGTERM' UNIQUE, même garde que ensureExitHook — `once` (jamais `on`) : le
// flush tourne UNE fois puis le listener s'auto-retire, ensuite le process SE RÉ-ENVOIE le même
// signal ; au 2e passage plus aucun listener n'est en place, Node reprend sa terminaison PAR
// DÉFAUT (cf. commentaire d'en-tête).
let sigtermHookInstalled = false
function ensureSigtermHook(): void {
  if (sigtermHookInstalled) return
  sigtermHookInstalled = true
  process.once('SIGTERM', () => {
    for (const fn of pendingFlushes) {
      try { fn() } catch { /* best-effort */ }
    }
    process.kill(process.pid, 'SIGTERM')
  })
}

export function createJournal(opts: JournalOptions): Journal {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxBytes   = opts.maxBytes ?? DEFAULT_MAX_BYTES

  // état par source — chargé paresseusement (1re opération qui le touche), dirty + timer de
  // debounce propres à CHAQUE fichier (server/client sont deux ressources indépendantes).
  const tables: Record<JournalSource, { entries: JournalEntry[] | null, dirty: boolean, timer: ReturnType<typeof setTimeout> | null }> = {
    server: { entries: null, dirty: false, timer: null },
    client: { entries: null, dirty: false, timer: null },
  }
  let warned = false
  let closed = false

  const warnOnce = (e: unknown): void => {
    if (warned) return
    warned = true
    const erreur = e instanceof Error ? e.message : String(e)
    console.warn(t('server.journal-ecriture-echec', { erreur }))
  }

  const pathFor = (source: JournalSource): string => join(opts.dir, FILE_BY_SOURCE[source])

  const getEntries = (source: JournalSource): JournalEntry[] => {
    const table = tables[source]
    if (table.entries === null) table.entries = loadFile(pathFor(source))
    return table.entries
  }

  const flushSource = (source: JournalSource): void => {
    const table = tables[source]
    if (table.timer) { clearTimeout(table.timer); table.timer = null }
    if (!table.dirty || table.entries === null) return
    try {
      writeAtomic(pathFor(source), serialize(table.entries))
      table.dirty = false
    } catch (e) {
      warnOnce(e)
    }
  }

  const scheduleFlush = (source: JournalSource): void => {
    const table = tables[source]
    table.dirty = true
    if (table.timer) clearTimeout(table.timer)
    // journal soldé (close()) : plus aucun hook de sortie derrière pour rattraper un différé —
    // on écrit TOUT DE SUITE plutôt que de perdre l'entrée (jamais un no-op muet)
    if (closed) { flushSource(source); return }
    table.timer = setTimeout(() => flushSource(source), DEBOUNCE_MS)
    // best-effort : un timer actif garderait le process éveillé (setTimeout non-ref) — un
    // serveur `mjs serve` tourne de toute façon en continu, mais un script one-shot (test, CLI)
    // qui créerait un journal puis quitterait sans jamais appeler flush()/close() ne doit pas
    // rester bloqué 1s de plus pour rien.
    table.timer.unref?.()
  }

  // flusher NOMMÉ (jamais une lambda anonyme posée à la volée) : close() doit pouvoir le retirer
  // de `pendingFlushes` — un Set ne sait supprimer que la référence exacte qu'on lui a donnée
  const flushBoth = (): void => { flushSource('server'); flushSource('client') }
  pendingFlushes.add(flushBoth)
  ensureExitHook()
  ensureSigtermHook()

  return {
    record(source, input) {
      try {
        const message = truncate(String(input.message ?? ''), MAX_MESSAGE_CHARS)
        const pile     = truncate(String(input.pile ?? ''), MAX_PILE_CHARS)
        const url      = String(input.url ?? '')
        const signature = signatureOf(message, pile, url)
        const now = Date.now()
        const entries = getEntries(source)
        const existing = entries.find((e) => e.signature === signature)
        if (existing) {
          existing.n++
          existing.dernier = now
          if (input.version !== undefined) existing.version = input.version
          if (input.ua !== undefined) existing.ua = input.ua
        } else {
          const entry: JournalEntry = {
            ts: now, source, signature, message, pile, url,
            version: input.version ?? null, n: 1, premier: now, dernier: now,
          }
          if (input.ua !== undefined) entry.ua = input.ua
          entries.push(entry)
        }
        enforceCaps(entries, maxEntries, maxBytes)
        scheduleFlush(source)
      } catch (e) {
        warnOnce(e)
      }
    },
    list() {
      try {
        return [...getEntries('server'), ...getEntries('client')].sort((a, b) => b.dernier - a.dernier)
      } catch (e) {
        warnOnce(e)
        return []
      }
    },
    purge(source) {
      try {
        const targets: JournalSource[] = source ? [source] : ['server', 'client']
        for (const s of targets) {
          tables[s].entries = []
          scheduleFlush(s)
        }
      } catch (e) {
        warnOnce(e)
      }
    },
    flush() {
      try {
        flushSource('server')
        flushSource('client')
      } catch (e) {
        warnOnce(e)
      }
    },
    close() {
      if (closed) return
      closed = true
      try {
        flushSource('server')
        flushSource('client')
      } catch (e) {
        warnOnce(e)
      }
      pendingFlushes.delete(flushBoth)
    },
  }
}
