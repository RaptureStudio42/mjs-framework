// Tests CIBLÉS de l'adaptateur `ws` par défaut (src/mjs-ws/transport-ws.ts) — le transport `ws`
// RÉEL (par opposition à MemoryTransport, omniprésent ailleurs dans la suite) n'avait quasi aucun
// test dédié avant ce fichier. Couvre les 3 défauts confirmés face à transport-uws.ts :
//  (a) `maxPayload` câblé jusqu'à la bibliothèque `ws` (resolveTransport ET construction directe,
//      PIÈGE spread `undefined` évité — cf. commentaire de tête transport-ws.ts) ;
//  (b) `start()` : une erreur SERVEUR tardive (après 'listening', ex. EMFILE) ne tue plus le
//      process — écouteur d'erreur PERMANENT posé après le retrait de celui de démarrage ;
//  (c) `stop()` BORNÉ : un client resté connecté sans fermeture propre ne fait plus pendre stop()
//      jusqu'à ~30s (CLOSE_TIMEOUT interne de `ws`) — STOP_TIMEOUT_MS force un terminate().
//
// SOCKET RÉEL, port éphémère ALÉATOIRE (même patron que tests/hmr.test.ts) : `ws` est une
// dépendance NORMALE de ModularJS (jamais conditionnelle comme le smoke uWebSockets.js de
// mjs-ws-transport-uws.test.ts) — ces tests tournent donc TOUJOURS, aucune garde existsSync().
// Introspection via champs privés (`(transport as any)._wss`/`._opts`) : MÊME précédent que
// `(t as any)._opts.maxPayload` dans mjs-ws-transport-uws.test.ts — pas de nouvelle surface
// publique ajoutée pour les seuls besoins du test (cf. repli documenté, écarté
// ICI : le socket réel s'est avéré fiable, pas besoin d'exposer `maxPayloadResolu`).

import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { WsTransport } from '../src/mjs-ws/transport-ws.js'
import { resolveTransport, DEFAULT_LIMITS } from '../src/mjs-ws/index.js'

// PLUS DE TIRAGE AU SORT — `50000 + rand(5000)` tirait DANS la plage éphémère du noyau
// (`net.ipv4.ip_local_port_range` = 32768-60999 ici) et liait SANS REPRISE : sous charge, une
// connexion sortante quelconque tenait déjà le port et le `listen` partait en `EADDRINUSE`. Un
// rouge intermittent qui ressemble à une régression coûte cher plus tard — c'est exactement ce
// qui est arrivé, ce fichier rejoué seul : 7/7 verts.
// Remède : `port: 0` — le NOYAU choisit un port réellement libre, et on le relit après `start()`.
// Plus de plage à réserver, donc plus de collision possible avec les autres fichiers non plus.
function portOf(transport: WsTransport): number {
  const adresse = (transport as any)._wss.address()
  assert.ok(adresse && typeof adresse.port === 'number', 'le serveur doit être lié avant de lire son port')
  return adresse.port
}

function connectReal(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

// ============================================================================================
// (a) maxPayload câblé jusqu'à la bibliothèque `ws`
// ============================================================================================

describe("mjs-ws/transport-ws — maxPayload câblé jusqu'à la bibliothèque `ws`", () => {
  it('opts.maxPayload explicite posé tel quel sur le WebSocketServer natif (pas le défaut ws, 100 Mo)', async () => {
    const transport = new WsTransport({ port: 0, host: '127.0.0.1', maxPayload: 12345 })
    await transport.start()
    try {
      assert.equal((transport as any)._wss.options.maxPayload, 12345)
    } finally {
      await transport.stop()
    }
  })

  it("aucun maxPayload fourni (usage standalone) → défaut LOCAL 65536, jamais `undefined` ni le défaut natif ws (100 Mo) — PIÈGE du spread d'options confirmé contre node_modules/ws (8.20.0) : `{ maxPayload: undefined }` explicite ÉCRASE le défaut interne de la lib, `?? DEFAULT_MAX_PAYLOAD` l'évite", async () => {
    const transport = new WsTransport({ port: 0, host: '127.0.0.1' })
    await transport.start()
    try {
      assert.equal((transport as any)._wss.options.maxPayload, 65536)
    } finally {
      await transport.stop()
    }
  })

  it("resolveTransport('ws', …) câble limits.maxPayload résolue — MÊME câblage que pour 'uws' (index.ts)", () => {
    const t = resolveTransport('ws', undefined, undefined, { ...DEFAULT_LIMITS, maxPayload: 999 })
    assert.ok(t instanceof WsTransport)
    assert.equal((t as any)._opts.maxPayload, 999)
  })

  it('une trame dépassant maxPayload est refusée PENDANT la réception (code 1009 natif) — AVANT le fix, seul core.ts (APRÈS réassemblage complet) la refusait', async function () {
    this.timeout(5000)
    const transport = new WsTransport({ port: 0, host: '127.0.0.1', maxPayload: 1024 })
    transport.onConnection((conn) => { conn.onMessage = () => {} })
    await transport.start()
    const port = portOf(transport)
    try {
      const client = await connectReal(port)
      const closedCode = new Promise<number>((resolve) => client.once('close', (code: number) => resolve(code)))
      client.send('x'.repeat(5000))   // > 1024 (maxPayload posé ci-dessus)
      assert.equal(await closedCode, 1009, 'fermeture native de `ws` (WS_ERR_UNSUPPORTED_MESSAGE_LENGTH), pas un timeout ni une autre cause')
    } finally {
      await transport.stop()
    }
  })
})

// ============================================================================================
// (b) écouteur d'erreur PERMANENT après démarrage — une erreur serveur tardive ne tue plus le process
// ============================================================================================

describe("mjs-ws/transport-ws — écouteur d'erreur PERMANENT après démarrage", () => {
  it("start() résolu → l'écouteur de DÉMARRAGE (reject) est retiré, un SEUL écouteur permanent reste, une erreur tardive ne lève plus (AVANT le fix : 'error' sans écouteur = crash process)", async () => {
    const transport = new WsTransport({ port: 0, host: '127.0.0.1' })
    await transport.start()
    try {
      const wss = (transport as any)._wss
      assert.equal(wss.listenerCount('error'), 1, "un SEUL écouteur 'error' doit rester après démarrage (le permanent — jamais empilé avec celui de démarrage)")
      // simule une erreur serveur TARDIVE (ex. EMFILE) sans épuiser réellement les descripteurs —
      // AVANT le fix, ce même écouteur était encore le `reject` de start() (déjà réglée depuis
      // longtemps) : un `emit('error', …)` sans écouteur restant ferait planter le process ENTIER
      // (comportement Node par défaut sur un EventEmitter). `assert.doesNotThrow` est donc la
      // preuve directe que le process survivrait à une VRAIE erreur tardive.
      assert.doesNotThrow(() => wss.emit('error', new Error('EMFILE simulé')), 'une erreur serveur tardive ne doit JAMAIS faire planter le process')
    } finally {
      await transport.stop()
    }
  })
})

// ============================================================================================
// (c) stop() BORNÉ — un client jamais fermé proprement ne fait plus pendre stop() ~30s
// ============================================================================================

describe('mjs-ws/transport-ws — stop() BORNÉ (client jamais fermé proprement)', function () {
  this.timeout(6000)

  it("un client réel resté ouvert (aucun close() jamais envoyé, des deux côtés) ne fait plus pendre stop() jusqu'à ~30s — résout sous ~3,5s (STOP_TIMEOUT_MS=2500 + marge)", async () => {
    const transport = new WsTransport({ port: 0, host: '127.0.0.1' })
    await transport.start()
    const port = portOf(transport)

    const client = await connectReal(port)
    let clientClosedCode: number | null = null
    client.once('close', (code: number) => { clientClosedCode = code })

    const t0 = Date.now()
    await transport.stop()
    const elapsed = Date.now() - t0

    assert.ok(elapsed < 3500, `stop() doit résoudre sous ~3,5s (pas ~30s, cf. CLOSE_TIMEOUT interne de \`ws\`) — a pris ${elapsed}ms`)
    assert.ok(elapsed >= 2400, `sanity : ne doit pas résoudre AVANT le délai normal d'attente (STOP_TIMEOUT_MS=2500) — a pris ${elapsed}ms, la connexion n'a peut-être jamais été comptabilisée côté serveur`)

    // laisse le temps au terminate() forcé de se propager jusqu'au client (FIN/RST TCP)
    await new Promise(r => setTimeout(r, 300))
    assert.notEqual(clientClosedCode, null, 'le client DOIT avoir été fermé de force (terminate(), pas un close() propre) par le timeout de stop() — jamais laissé pendre indéfiniment côté serveur')
  })

  it('tous les clients déjà fermés proprement → stop() résout BIEN AVANT le timeout (pas de régression de latence sur le cas nominal)', async () => {
    const transport = new WsTransport({ port: 0, host: '127.0.0.1' })
    await transport.start()
    const port = portOf(transport)

    const client = await connectReal(port)
    await new Promise<void>((resolve) => { client.once('close', () => resolve()); client.close(1000, 'départ propre') })

    const t0 = Date.now()
    await transport.stop()
    const elapsed = Date.now() - t0

    assert.ok(elapsed < 1000, `aucun client actif restant : stop() doit résoudre quasi immédiatement, jamais attendre STOP_TIMEOUT_MS — a pris ${elapsed}ms`)
  })
})
