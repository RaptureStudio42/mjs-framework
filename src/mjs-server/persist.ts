// mjs-server/persist — brique OPTIONNELLE de persistance par bdd au choix : ZÉRO dépendance,
// interfaçage par simple duck-typing (« au choix » = n'importe quel
// objet qui expose les 4 fonctions ci-dessous marche, mémoire/fichier/pont HTTP fournis ici, Redis/SQL
// à venir SANS toucher cette façade). La persistance DURE reste chez l'appli hôte quand elle
// passe par le pont (persist-bridge.ts pousse, ne stocke jamais lui-même).
//
// CONTRAT (duck-typing STRICT — seules ces 3 fonctions sont vérifiées, `flush` est optionnel) :
//   load()             → Promise<{id, données}[]>  — lu UNE FOIS au boot, avant que le serveur
//                         n'accepte la moindre connexion (cf. index.ts, app.listen())
//   save(id, données)  → void | Promise<void>       — écrit/remplace l'entrée `id` (`données` =
//                         partie.serialize(), cf. game.ts) — jamais attendu par l'appelant
//   remove(id)         → void | Promise<void>       — supprime l'entrée `id`, no-op si absente
//   flush()?           → void | Promise<void>       — vidange/synchronisation finale, appelée par
//                         app.stop() APRÈS la rafale de sauvegardes en attente
//
// ENCODAGE — `données` devient du TEXTE par encodeSnapshot()/decodeSnapshot() (ci-dessous), JAMAIS
// par une colonne typée du moteur : la règle et sa raison à la section « encodage du snapshot ».
//
// CÂBLAGE (mjsServer(opts), cf. index.ts) — `opts.persist` accepte soit un adaptateur NU (défauts
// appliqués), soit `{ adaptateur, debounce?, snapshotEvery? }` (validation stricte façon
// resolveGameDef, clé inconnue → suggestion). ABSENT = AUCUN hook armé, zéro coût (pas une Map, pas
// un timer créés) — cf. createPersistEngine, qui retourne `null` tout de suite dans ce cas.
//
// DÉBOUNCE (défaut 150 ms) — chaque mutation DIFFUSÉE d'une partie (cf. game.ts _broadcastState,
// hook `_onMutate`) réarme un setTimeout par partie : N mutations rapprochées → 1 seul save(), celui
// qui capture l'état APRÈS la dernière. `snapshotEvery` (défaut 0 = désactivé) est le PLANCHER : sous
// mutation CONTINUE (chaque coup réarme le débounce avant qu'il n'expire), un débounce pur ne sauve
// JAMAIS — snapshotEvery force un save des parties encore sales à intervalle fixe, garantissant une
// borne supérieure de fraîcheur même dans ce cas.
//
// CYCLE DE VIE — matchmaking.ts est le SEUL appelant (ownership des Game, cf. son commentaire de
// tête) : armGame() posée après CHAQUE create()/restauration, forgetGame() posée dans
// onGameDestroyed() SAUF pendant app.stop() (détruire pour un arrêt serveur ne doit PAS effacer la
// partie du stockage — elle doit revivre au prochain boot via load(), cf. matchmaking.ts `stopping`).
// app.stop() (index.ts) : stop() = rafale finale des débounces en attente PUIS flush() adaptateur.
//
//   import { mjsServer, MemoryPersistAdapter } from 'modularjs-framework/mjs-server'
//   app = mjsServer({ persist: { adaptateur: new MemoryPersistAdapter(), debounce: 150 } })

import type { MjsWsLogFn } from '../mjs-ws/index.js'
import type { Game, MjsServerGameSnapshot } from './game.js'
import { t } from '../messages/index.js'

// --- le contrat -------------------------------------------------------------------------------

export interface MjsServerPersistAdapter {
  load(): Promise<Array<{ id: string; data: MjsServerGameSnapshot }>>
  save(id: string, data: MjsServerGameSnapshot): void | Promise<void>
  remove(id: string): void | Promise<void>
  flush?(): void | Promise<void>
}

export interface MjsServerPersistOptions {
  adapter: MjsServerPersistAdapter
  /** ms — regroupe les saves rapprochés d'UNE MÊME partie, défaut 150 */
  debounce?: number
  /** ms — plancher périodique (parties encore sales), défaut 0 = désactivé (débounce pur) */
  snapshotEvery?: number
}

/** `opts.persist` accepte l'adaptateur NU ou la forme objet avec réglages — cf. resolvePersistOption */
export type MjsServerPersistOption = MjsServerPersistAdapter | MjsServerPersistOptions

export interface MjsServerResolvedPersist {
  adapter: MjsServerPersistAdapter
  debounce: number
  snapshotEvery: number
}

export const DEFAULT_PERSIST_DEBOUNCE = 150

// --- encodage du snapshot — LE point de passage texte de TOUS les adaptateurs ------------------
// RÈGLE : un adaptateur écrit du TEXTE et encode LUI-MÊME — jamais une colonne typée du moteur
// (`JSON` MySQL, `JSONB` Postgres…). Un type délégué au moteur se lit différemment selon le
// moteur : le MÊME schéma a rendu du Hash sous MySQL et de la String sous MariaDB (leçon
// vécue — `t.json` = alias LONGTEXT côté MariaDB). Texte + encodage explicite =
// indépendant du moteur, donc infaillible. C'est aussi pourquoi le DDL de persist-sql.ts déclare
// `data TEXT` et pourquoi `dialect` ne sert QU'À la syntaxe des paramètres bind.
// Les 3 adaptateurs de stockage (sql/redis/file) passent par cette paire — un cas particulier à
// traiter un jour (valeur cyclique, Date, très gros payload) se traite ICI, une fois, pour les
// trois. persist-bridge.ts n'en est pas : il n'encode pas un état mais une ENVELOPPE HTTP
// ({op, id, data}), et c'est le back qui stocke.

/** état sérialisé d'une partie → texte, la forme stockée par TOUS les adaptateurs */
export function encodeSnapshot(data: MjsServerGameSnapshot): string {
  return JSON.stringify(data)
}

/** texte relu (colonne SQL, champ de hash Redis, fichier) → état de partie. THROW si illisible :
 *  l'appelant journalise et saute l'entrée, jamais un crash de boot (cf. load() des adaptateurs) */
export function decodeSnapshot(raw: unknown): MjsServerGameSnapshot {
  return JSON.parse(String(raw)) as MjsServerGameSnapshot
}

// --- suggestion orthographique — MÊME algorithme que game.ts (Levenshtein ≤ 2), réimplémenté ici
// à l'identique (~15 lignes) pour la MÊME raison que game.ts : importer depuis un module voisin
// pour 15 lignes serait un couplage disproportionné, cf. son commentaire de tête ---

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[a.length][b.length]
}

function suggestKey(key: string, validKeys: Iterable<string>): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const k of validKeys) { const d = levenshtein(key, k); if (d < bestDist) { bestDist = d; best = k } }
  return best !== null && bestDist <= 2 ? best : null
}

function keyUnknown(prefix: string, k: string, known: Iterable<string>): Error {
  const suggestion = suggestKey(k, known)
  const hint = suggestion ? t('serveur.cle-inconnue-suggestion', { suggestion: suggestion }) : ''
  return new Error(t('serveur.cle-inconnue', { prefix: prefix, k: k, hint: hint, clesValides: Array.from(known).join(', ') }))
}

const KNOWN_PERSIST_KEYS = new Set(['adapter', 'debounce', 'snapshotEvery'])

// duck-typing STRICT (cf. commentaire de tête) — MÊME principe que isAdapterInstance de
// mjs-ws/index.ts : la présence des 3 fonctions suffit à trancher, jamais d'instanceof (isAnAdapter)
function isAnAdapter(x: unknown): x is MjsServerPersistAdapter {
  const a = x as Record<string, unknown> | null | undefined
  return !!a && typeof a === 'object'
    && typeof a.load === 'function' && typeof a.save === 'function' && typeof a.remove === 'function'
}

/** Résout `opts.persist` — `undefined`/`null`/`false` → `null` (désactivé, AUCUN hook armé côté
 *  index.ts). Validation STRICTE de la forme objet (clé inconnue → suggestion), MÊME patron que
 *  resolveGameDef (game.ts) : throw immédiat, jamais un défaut silencieux sur une clé mal typée. */
export function resolvePersistOption(raw: MjsServerPersistOption | undefined | null | false): MjsServerResolvedPersist | null {
  if (!raw) return null
  const prefix = '[MJS-Server] opts.persist'
  if (isAnAdapter(raw)) return { adapter: raw, debounce: DEFAULT_PERSIST_DEBOUNCE, snapshotEvery: 0 }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(t('serveur.persist-option-invalide', { prefix: prefix, received: JSON.stringify(raw) }))
  }
  for (const k of Object.keys(raw)) if (!KNOWN_PERSIST_KEYS.has(k)) throw keyUnknown(prefix, k, KNOWN_PERSIST_KEYS)
  if (!isAnAdapter(raw.adapter)) {
    throw new Error(t('serveur.persist-adaptateur-invalide', { prefix: prefix, received: JSON.stringify(raw.adapter) }))
  }
  if (raw.debounce !== undefined && (typeof raw.debounce !== 'number' || !Number.isFinite(raw.debounce) || raw.debounce < 0)) {
    throw new Error(t('serveur.persist-debounce-invalide', { prefix: prefix, received: JSON.stringify(raw.debounce) }))
  }
  if (raw.snapshotEvery !== undefined && (typeof raw.snapshotEvery !== 'number' || !Number.isFinite(raw.snapshotEvery) || raw.snapshotEvery < 0)) {
    throw new Error(t('serveur.persist-snapshotevery-invalide', { prefix: prefix, received: JSON.stringify(raw.snapshotEvery) }))
  }
  return {
    adapter:    raw.adapter,
    debounce:      raw.debounce ?? DEFAULT_PERSIST_DEBOUNCE,
    snapshotEvery: raw.snapshotEvery ?? 0,
  }
}

// --- adaptateur mémoire — référence minimale, sert aussi de fixture de test -------------------

export class MemoryPersistAdapter implements MjsServerPersistAdapter {
  private _store = new Map<string, MjsServerGameSnapshot>()

  async load(): Promise<Array<{ id: string; data: MjsServerGameSnapshot }>> {
    return Array.from(this._store.entries()).map(([id, data]) => ({ id, data }))
  }

  save(id: string, data: MjsServerGameSnapshot): void { this._store.set(id, data) }
  remove(id: string): void { this._store.delete(id) }
  flush(): void {}
}

// --- le moteur — débounce par partie + plancher périodique + boot/arrêt -----------------------
// SEUL appelant : matchmaking.ts (ownership des Game, cf. son commentaire de tête) — ce fichier
// ne construit JAMAIS de Game lui-même (ni create() ni restoreGameFromSnapshot()), il ne connaît QUE
// serialize()/l'instance qu'on lui passe — le lookup de `def` par type (jeux.get) et la
// construction restent 100% dans matchmaking.ts (cf. index.ts pour le câblage app.listen()).

export interface MjsServerPersistEngine {
  /** posée sur CHAQUE partie vivante (fraîche OU restaurée) — arme le hook `_onMutate` */
  armGame(game: Game): void
  /** miroir — annule le débounce en attente puis adaptateur.remove(id) (JAMAIS l'inverse : une
   *  sauvegarde tardive qui ressusciterait une entrée tout juste supprimée, cf. commentaire de tête) */
  forgetGame(id: string): void
  /** AU BOOT (index.ts, app.listen(), AVANT le vrai listen) — `restore` = fourni par
   *  matchmaking.ts, construit la Game et retourne `false` si le type est inconnu (log ici) */
  loadAtBoot(restore: (data: MjsServerGameSnapshot) => boolean): Promise<void>
  /** app.stop() — rafale finale des débounces en attente PUIS flush() de l'adaptateur */
  stop(): Promise<void>
}

interface Entry { game: Game; handle: ReturnType<typeof setTimeout> | null; dirty: boolean }

/** `resolved === null` (opts.persist absent) → retourne `null` tout de suite, AUCUNE Map ni timer
 *  créés — zéro coût, cf. commentaire de tête. */
export function createPersistEngine(resolved: MjsServerResolvedPersist | null, onLog: MjsWsLogFn): MjsServerPersistEngine | null {
  if (!resolved) return null
  const entries = new Map<string, Entry>()
  let snapshotTimer: ReturnType<typeof setInterval> | null = null

  function runSave(e: Entry): Promise<void> {
    e.dirty = false
    return Promise.resolve(resolved.adapter.save(e.game.id, e.game.serialize()))
      .catch(err => { onLog('warn', t('serveur.persist-save-echoue', { id: e.game.id }), { err: err instanceof Error ? err.message : String(err) }) })
  }

  function scheduleSave(game: Game): void {
    const e = entries.get(game.id)
    if (!e) return   // partie non suivie — ne devrait pas arriver, armGame() couvre fraîche+restaurée
    e.dirty = true
    if (e.handle) clearTimeout(e.handle)
    e.handle = setTimeout(() => { e.handle = null; void runSave(e) }, resolved.debounce)
  }

  if (resolved.snapshotEvery > 0) {
    snapshotTimer = setInterval(() => {
      for (const e of entries.values()) {
        if (!e.dirty) continue
        if (e.handle) { clearTimeout(e.handle); e.handle = null }
        void runSave(e)
      }
    }, resolved.snapshotEvery)
  }

  return {
    armGame(game: Game): void {
      entries.set(game.id, { game, handle: null, dirty: false })
      game._onMutate = () => scheduleSave(game)
    },

    forgetGame(id: string): void {
      const e = entries.get(id)
      if (e?.handle) clearTimeout(e.handle)
      entries.delete(id)
      Promise.resolve(resolved.adapter.remove(id))
        .catch(err => onLog('warn', t('serveur.persist-remove-echoue', { id: id }), { err: err instanceof Error ? err.message : String(err) }))
    },

    async loadAtBoot(restore: (data: MjsServerGameSnapshot) => boolean): Promise<void> {
      let brut: Array<{ id: string; data: MjsServerGameSnapshot }>
      try {
        brut = await resolved.adapter.load()
      } catch (err) {
        onLog('warn', t('serveur.persist-load-echoue'), { err: err instanceof Error ? err.message : String(err) })
        return
      }
      for (const { data } of brut) {
        try {
          // `data` peut être `null` (colonne SQL NULL, fichier `null` JSON valide,
          // cf. decodeSnapshot) — `data?.id`/`data?.type` : sinon CETTE ligne lève à son tour, hors
          // de tout try, et fait fuir loadAtBoot() entier (boot cassé pour UNE seule entrée)
          if (!restore(data)) onLog('warn', t('serveur.persist-partie-ignoree', { id: data?.id, type: data?.type }))
        } catch (err) {
          onLog('warn', t('serveur.persist-restauration-echouee', { id: data?.id }), { err: err instanceof Error ? err.message : String(err) })
        }
      }
    },

    async stop(): Promise<void> {
      if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null }
      const pending: Array<Promise<void>> = []
      for (const e of entries.values()) {
        if (e.handle) { clearTimeout(e.handle); e.handle = null }
        if (e.dirty) pending.push(runSave(e))
      }
      await Promise.allSettled(pending)
      await resolved.adapter.flush?.()
    },
  }
}
