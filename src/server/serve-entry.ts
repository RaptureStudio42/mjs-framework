// serve-entry — chargeur d'entrée serveur `.server.mjs` pour `mjs serve`. RÉUTILISE
// l'appareillage déjà posé pour `mjs ws`/`mjs serveur`
// (cli/ws.ts → cli/server-entry.ts) : même format `.server.mjs` (dialecte Civet des
// composants + grammaire @import, compilation vers un fichier réel sous le cache, import via
// URL file:// cache-bustée), même debounce de rechargement à chaud. Différence
// avec `mjs ws` : ce chargeur est ENTIÈREMENT OPTIONNEL — une appli `mjs serve` sans props/
// actions serveur n'a besoin d'aucun fichier d'entrée : aucun fichier trouvé → chargeur INACTIF
// en silence (cas normal), jamais une erreur (contrairement à `resolveEntryPath` de `mjs ws`,
// qui EXIGE une entry et lève si absente).
//
// Contrat du module : `export default { props?: {...}, actions?: {...} }` — chaque clé de
// `props`/`actions` est un MOTIF de route (mêmes motifs que `render.routes`, cf. render-routes.ts),
// la valeur une fonction : `props['/x/:id'] = (params, req) => objet` (peut être async),
// `actions['/x/:id'] = (params, body, req) => { redirect } | { errors }` — le SENS du retour
// est interprété par l'appelant (render-server.ts) : ce module ne fait QUE router vers la
// bonne fonction, jamais n'interprète son résultat.

import { existsSync, watch as fsWatch } from 'node:fs'
import { resolve, dirname } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { MjsConfig } from '../bundler/config.js'
import { importEntryModule, WATCHED_EXT, RELOAD_DEBOUNCE_MS } from '../cli/ws.js'
import { matchPattern } from './render-routes.js'
import type { RecordServerFn } from './journal.js'
import { t } from '../messages/index.js'

type RouteFn    = (...args: any[]) => unknown
type RouteTable = Record<string, RouteFn>
type Match      = { fn: RouteFn, params: Record<string, string | string[]> }

export interface ServeEntry {
  propsFor(pathname: string, req: IncomingMessage): Promise<Record<string, unknown>>
  actionFor(pathname: string): Match | null
  close(): void
}

// défauts dans l'ordre — résolution SILENCIEUSE (contrairement à `mjs ws`) : cf. commentaire
// de tête, aucune entry trouvée n'est jamais une erreur ici.
const ENTRY_DEFAULTS = ['serve.server.mjs', 'server/serve.server.mjs']

function resolveServeEntryPath(configDir: string, configEntry: string | undefined): string | null {
  if (configEntry !== undefined) {
    const p = resolve(configDir, configEntry)
    return existsSync(p) ? p : null
  }
  for (const rel of ENTRY_DEFAULTS) {
    const p = resolve(configDir, rel)
    if (existsSync(p)) return p
  }
  return null
}

// objet-plan (pas un tableau, pas null) — une forme inattendue est traitée comme absente,
// jamais un crash (philosophie zéro coupure des chargeurs `.server.mjs`). Exportée : réutilisée
// par render-server.ts pour valider la forme du retour d'une action (redirect/errors).
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// tri par spécificité — MÊME critère que resolvePage (render-routes.ts) : segments littéraux
// décroissants puis longueur (un motif '/x/:id' cède la place à '/x/edit' si les deux matchent).
function staticSegs(pattern: string): number {
  return pattern.split('/').filter(s => s && s[0] !== ':' && s !== '*').length
}
function findMatch(table: RouteTable, pathname: string): Match | null {
  const patterns = Object.keys(table).sort((a, b) => staticSegs(b) - staticSegs(a) || b.length - a.length)
  for (const pattern of patterns) {
    const params = matchPattern(pattern, pathname)
    if (params) return { fn: table[pattern], params }
  }
  return null
}

export async function createServeEntry(config: MjsConfig, configDir: string, recordServer?: RecordServerFn): Promise<ServeEntry> {
  const entryPath = resolveServeEntryPath(configDir, config.render?.entry)
  if (!entryPath) return { propsFor: async () => ({}), actionFor: () => null, close: () => {} }

  let props: RouteTable   = {}
  let actions: RouteTable = {}
  let active = false

  async function load(): Promise<void> {
    const wasActive = active
    try {
      const mod  = await importEntryModule(entryPath!, configDir)
      const dflt = mod ? mod.default : undefined
      if (!isPlainObject(dflt)) {
        const recu = dflt === undefined ? t('cli.aucun-export-defaut') : (Array.isArray(dflt) ? t('cli.un-tableau') : typeof dflt)
        throw new Error(t('cli.entry-doit-export-default', { produit: 'mjs serve', entryPath: entryPath!, recu }))
      }
      for (const cle of Object.keys(dflt)) {
        if (cle === 'props' || cle === 'actions') continue
        console.warn(t('server.entry-cle-ignoree', { cle }))
      }
      props   = isPlainObject(dflt.props)   ? dflt.props   as RouteTable : {}
      actions = isPlainObject(dflt.actions) ? dflt.actions as RouteTable : {}
      active  = true
      console.log(t('server.entry-charge', { fichier: entryPath }))
    } catch (err) {
      const erreur = err instanceof Error ? err.message : String(err)
      console.error(t('server.entry-echec', { fichier: entryPath, erreur, actif: wasActive }))
      // (point 4/5 de capture) — chargement/rechargement de l'entry : AUCUN appelant en aval
      // (contrairement à propsFor/actionFor, cf. leurs propres catch) — le journal doit être touché
      // ICI, seul endroit qui voit jamais cet échec.
      recordServer?.({ message: erreur, pile: err instanceof Error ? err.stack : undefined, url: entryPath })
    }
  }

  await load()

  // rechargement à chaud, sérialisé par le couple `running`/`pending` — MÊME machinerie que
  // cli/ws.ts : un debounce peut redéclencher pendant qu'un chargement précédent
  // tourne encore ; un échec de rechargement LOG (ci-dessus) et garde l'ancien `props`/`actions`
  // (jamais écrasés avant qu'un chargement complet réussisse, cf. load() : les réassignations
  // n'arrivent qu'après le parsing du contrat).
  // Un compteur `_generation` était incrémenté ici et JAMAIS lu ; le commentaire parlait
  // de « sérialisé par génération » et faisait croire à une garde de fraîcheur qui n'existe pas.
  // Retiré plutôt que branché : `running`/`pending` sérialisent déjà, à eux seuls et pour de bon.
  let running = false, pending = false
  function schedule(): void {
    if (running) { pending = true; return }
    runLoop()
  }
  function runLoop(): void {
    running = true
    void load().finally(() => {
      running = false
      if (pending) { pending = false; runLoop() }
    })
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const watcher = fsWatch(dirname(entryPath), { persistent: true, recursive: false }, (_event, filename) => {
    if (!filename || !WATCHED_EXT.test(filename)) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { debounceTimer = null; schedule() }, RELOAD_DEBOUNCE_MS)
  })

  return {
    async propsFor(pathname, req) {
      if (!active) return {}
      const match = findMatch(props, pathname)
      if (!match) return {}
      let result: unknown
      try {
        result = await match.fn(match.params, req)
      } catch (err) {
        const erreur = err instanceof Error ? err.message : String(err)
        console.error(t('server.entry-props-echec', { pathname, erreur }))
        throw err   // l'appelant (branche GET protocole) répond 500
      }
      if (!isPlainObject(result)) {
        console.warn(t('server.entry-props-invalides', { pathname }))
        return {}
      }
      return result
    },
    actionFor(pathname) {
      if (!active) return null
      return findMatch(actions, pathname)
    },
    close() {
      watcher.close()
      if (debounceTimer) clearTimeout(debounceTimer)
    },
  }
}
