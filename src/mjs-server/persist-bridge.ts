// mjs-server/persist-bridge — adaptateur PONT du contrat MjsServerPersistAdapter (cf. persist.ts) :
// POUSSE l'état vers un back HTTP (Rails/PHP…) par requêtes signées HMAC-SHA256. Réutilise TELLE
// QUELLE la machinerie de signature SORTANTE du pont MJS-WS — signCanonical/canonicalString,
// src/mjs-ws/bridge.ts, déjà `export function` (import direct, AUCUNE modification de MJS-WS requise,
// MÊME précédent que game.ts qui importe TokenBucket depuis mjs-ws/guard.ts) — même en-têtes
// (x-mjs-ws-timestamp/x-mjs-ws-signature), même chaîne canonique `${ts}.${MÉTHODE}.${chemin}.${corps}`.
// La persistance DURE reste chez le back : cet adaptateur ne
// stocke jamais rien lui-même, il pousse et lit à travers le réseau.
//
// CONTRAT SUR LE FIL — une seule URL, 3 opérations :
//   POST url  {"op":"save",   "id":"game7", "data":{…game.serialize()…}}  → 2xx = ok
//   POST url  {"op":"remove", "id":"game7"}                                     → 2xx = ok
//   GET  url  (corps vide)  → 2xx, {"ok":true,"games":[{"id":"game7","data":{…}}, …]}
//
// Pseudo-recette Ruby côté back (Rails, Sinatra… n'importe quoi qui sait vérifier une HMAC) — VÉRIFIE
// la signature ET l'horodatage AVANT d'agir (même modèle que le webhook docs/23-mjs-ws.md §7.5, déjà
// correct) : corps BRUT jamais re-sérialisé, MÊME chaîne canonique que ci-dessus (corps vide pour le
// GET), comparaison à temps constant, rejet 401 si signature fausse OU horodatage hors fenêtre (± 300 s).
// Copier cette recette SANS la vérification expose save/remove/load de n'importe quelle partie à tous :
//   SECRET = ENV.fetch('MJS_SERVEUR_PERSIST_SECRET')                         # même secret que { secret: … } côté TS
//   def verifie!(ts, corps)                                               # halt 401 si signature/horodatage invalides
//     halt 401 if ts.nil? || (Time.now.to_i - ts.to_i).abs > 300
//     attendue = OpenSSL::HMAC.hexdigest('SHA256', SECRET, "#{ts}.#{request.request_method}.#{request.path}.#{corps}")
//     halt 401 unless Rack::Utils.secure_compare(attendue, request.env['HTTP_X_MJS_WS_SIGNATURE'].to_s)
//   end
//   post('/mjs-server/persist') { corps = request.body.read; verifie!(request.env['HTTP_X_MJS_WS_TIMESTAMP'], corps)
//     body = JSON.parse(corps)                                            # {op, id, data?} — APRÈS vérification
//     case body['op']
//     when 'save'   then Game.upsert(id: body['id'], data: body['data'].to_json)
//     when 'remove' then Game.where(id: body['id']).delete_all end }
//   get('/mjs-server/persist') { verifie!(request.env['HTTP_X_MJS_WS_TIMESTAMP'], '')                  # GET = corps vide → même chaîne canonique
//     { ok: true, games: Game.all.map { |p| { id: p.id, data: JSON.parse(p.data) } } }.to_json }
//
// Échecs réseau — MÊME politique que les webhooks sortants MJS-WS (0/2/10 s, cf. bridge.ts
// WEBHOOK_RETRY_DELAYS_MS) : 3 tentatives puis abandon + warn, JAMAIS bloquant — la partie continue
// en mémoire (le prochain save() rattrapera l'état dès qu'il repasse, aucune action requise).
//
//   import { mjsServer, BridgePersistAdapter } from 'mjs-framework/mjs-server'
//   app = mjsServer({ persist: new BridgePersistAdapter({ url: 'https://back/mjs-server/persist', secret: 'xyz' }) })

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { signCanonical, canonicalString, isLoopbackHost } from '../mjs-ws/bridge.js'
import type { MjsWsLogFn, MjsWsLogLevel } from '../mjs-ws/index.js'
import type { MjsServerPersistAdapter } from './persist.js'
import type { MjsServerGameSnapshot } from './game.js'
import { t } from '../messages/index.js'

const RETRY_DELAYS_MS    = [2000, 10000]   // délai AVANT chaque retentative — essai initial sans délai (0/2/10 s, cf. commentaire de tête)
const DEFAULT_TIMEOUT_MS = 5000            // même défaut que wh.timeoutMs (webhooks sortants, bridge.ts)

export interface BridgePersistAdapterOpts {
  /** URL du back qui reçoit save/remove (POST) et sert load (GET) */
  url: string
  /** secret de signature HMAC — MÊME algorithme que le pont MJS-WS, secret INDÉPENDANT (pas forcément le même) */
  secret: string
  onLog?: MjsWsLogFn
  /** ms — défaut 5000 */
  timeoutMs?: number
  /** échappatoire EXPLICITE à la garde TLS du constructeur — autorise `url` en
   *  http:// même hors loopback (127.0.0.1/localhost/::1/[::1]). Défaut false : à n'activer qu'en
   *  connaissance de cause (réseau interne de confiance, tunnel déjà chiffré en amont…), jamais par défaut. */
  allowInsecure?: boolean
}

function defaultLog(level: MjsWsLogLevel, message: string, meta?: unknown): void {
  const line = `[mjs-server:persist-bridge] ${message}`
  if (level === 'error') console.error(line, meta ?? '')
  else if (level === 'warn') console.warn(line, meta ?? '')
  else console.log(line, meta ?? '')
}

// garde TLS — MÊME logique que src/mjs-ws/proxy.ts::estLoopback, RÉPLIQUÉE ici
// plutôt qu'importée (périmètre différent : hostname d'une URL de PERSISTANCE, pas de proxy de
// décision — cf. commentaire jumeau côté proxy.ts pour le détail du raisonnement) : 127.0.0.1/::1
// (isLoopbackHost, bridge.ts, réutilisée telle quelle) + leurs alias usuels localhost/[::1] (jamais
// couverts par isLoopbackHost, qui ne voit que le host D'ÉCOUTE du pont).
function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return isLoopbackHost(h) || h === 'localhost' || h === '[::1]'
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

interface HttpResponse { status: number; body: string }

/** une requête signée — MÊME enveloppe que postJson (bridge.ts), généralisée GET/POST ici (`load`
 *  est un GET à corps vide, canonicalString() reste le MÊME format quelle que soit la méthode). */
function signedRequest(target: URL, method: string, secret: string, body: string, timeoutMs: number): Promise<HttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const ts  = Math.floor(Date.now() / 1000)
    const sig = signCanonical(secret, canonicalString(ts, method, target.pathname + target.search, body))
    const requester = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = requester(target, {
      method,
      headers: {
        'content-type':      'application/json; charset=utf-8',
        'content-length':    Buffer.byteLength(body),
        'x-mjs-ws-timestamp': String(ts),
        'x-mjs-ws-signature': sig,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error(t('serveur.persist-bridge-delai-depasse'))))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** 1 essai + jusqu'à RETRY_DELAYS_MS.length retentatives — `null` = abandon (tous les essais épuisés) */
async function withRetries(run: () => Promise<HttpResponse>, onFailure: (err: unknown, attempt: number) => void): Promise<HttpResponse | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const rep = await run()
      if (rep.status >= 200 && rep.status < 300) return rep
      throw new Error(t('serveur.persist-bridge-reponse-http', { status: rep.status }))
    } catch (err) {
      onFailure(err, attempt)
      if (attempt >= RETRY_DELAYS_MS.length) return null
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }
}

export class BridgePersistAdapter implements MjsServerPersistAdapter {
  private _target: URL
  private _secret: string
  private _onLog: MjsWsLogFn
  private _timeoutMs: number
  private _enVol = new Set<Promise<void>>()

  constructor(opts: BridgePersistAdapterOpts) {
    if (!opts.url) throw new Error(t('serveur.persist-bridge-url-manquant'))
    if (!opts.secret) throw new Error(t('serveur.persist-bridge-secret-manquant'))
    this._target    = new URL(opts.url)
    // garde TLS — load() restaure TOUT l'état (parties en cours, vues éventuellement
    // porteuses d'identité) à partir de la RÉPONSE de cette URL : en http:// non-loopback, un
    // attaquant EN CHEMIN (MITM) peut la forger. On refuse donc http:// dès que l'hôte n'est pas
    // loopback, SAUF opts.allowInsecure:true (échappatoire EXPLICITE). CHANGEMENT DE COMPORTEMENT :
    // une telle URL était acceptée SANS garde avant ce correctif. NB — même note
    // que proxy.ts : https:// protège le TRANSPORT, pas l'authenticité du CONTENU de la réponse ;
    // signer la réponse elle-même reste un durcissement complémentaire À FAIRE, hors périmètre ici.
    if (this._target.protocol === 'http:' && !isLoopback(this._target.hostname) && !opts.allowInsecure) {
      throw new Error(t('serveur.persist-bridge-http-non-loopback', { url: opts.url }))
    }
    this._secret    = opts.secret
    this._onLog     = opts.onLog ?? defaultLog
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async load(): Promise<Array<{ id: string; data: MjsServerGameSnapshot }>> {
    const rep = await withRetries(
      () => signedRequest(this._target, 'GET', this._secret, '', this._timeoutMs),
      (err, attempt) => this._onLog('warn', t('serveur.persist-bridge-load-tentative-echouee', { tentative: attempt + 1 }), { err: err instanceof Error ? err.message : String(err) }),
    )
    if (!rep) { this._onLog('warn', t('serveur.persist-bridge-load-abandonne')); return [] }
    try {
      const json = JSON.parse(rep.body)
      const games = Array.isArray(json?.games) ? json.games : []
      // contrairement à persist-file/sql/redis (decodeSnapshot par entrée), le back
      // rendait `{id,data}[]` SANS validation de forme — une entrée `{id:'g1',data:null}` rejoint le
      // même problème au boot (loadAtBoot), un id numérique ou absent n'a jamais de sens en aval
      const bien = games.filter((e: any) => typeof e?.id === 'string' && e.id !== '' && typeof e?.data === 'object' && e.data !== null)
      if (bien.length !== games.length) this._onLog('warn', t('serveur.persist-bridge-load-entrees-invalides', { nb: games.length - bien.length }))
      return bien
    } catch (err) {
      this._onLog('warn', t('serveur.persist-bridge-load-reponse-illisible'), { err: err instanceof Error ? err.message : String(err) })
      return []
    }
  }

  save(id: string, data: MjsServerGameSnapshot): void { this._pousser({ op: 'save', id, data }, `save('${id}')`) }
  remove(id: string): void { this._pousser({ op: 'remove', id }, `remove('${id}')`) }

  async flush(): Promise<void> {
    await Promise.allSettled(Array.from(this._enVol))
  }

  // garde-fou — .catch() AVANT .finally() : une promesse orpheline rejetée ne doit
  // JAMAIS devenir un unhandledRejection (Node 20 tue le process dessus). En pratique avecRetentatives
  // catche déjà tout en interne (jamais un rejet ici) — filet de sécurité, MÊME patron que les 3
  // autres adaptateurs (persist-file/sql/redis.ts).
  private _suivre(p: Promise<void>, label: string): void {
    this._enVol.add(p)
    p.catch(err => this._onLog('warn', t('serveur.persist-backend-rejet-non-intercepte', { backend: 'bridge', label: label }), { err: err instanceof Error ? err.message : String(err) }))
      .finally(() => this._enVol.delete(p))
  }

  private _pousser(payload: unknown, label: string): void {
    const body = JSON.stringify(payload)
    const p = withRetries(
      () => signedRequest(this._target, 'POST', this._secret, body, this._timeoutMs),
      (err, attempt) => this._onLog('warn', t('serveur.persist-bridge-tentative-echouee', { label: label, tentative: attempt + 1 }), { err: err instanceof Error ? err.message : String(err) }),
    ).then((rep) => {
      if (!rep) this._onLog('warn', t('serveur.persist-bridge-abandonne-apres-tentatives', { label: label, tentatives: RETRY_DELAYS_MS.length + 1 }))
    })
    this._suivre(p, label)
  }
}
