// Tests du CLIENT µschema (mjs_schema.ts) — VRAI serveur MJS-WS (MemoryTransport) + VRAI
// client (mjs_socket.ts + mjs_schema.ts concaténés, `new Function('µ', src)(µ)`), MÊME patron que
// tests/socket-game.test.ts / tests/mjs-server-action.test.ts. Le registre « côté test » (déclarations
// serveur) et le registre CLIENT (déclarations `µx.schema(...)`) sont deux registres INDÉPENDANTS —
// prouve l'interopérabilité réelle (fil binaire), jamais une relecture d'état interne partagé.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, list, bits } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { creerRegistre, defSchema, encode, serialiserDefinitions } from '../src/schema/core.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const socketSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')
const schemaSrc = readFileSync(join(__dirname, '../src/runtime/mjs_schema.ts'), 'utf8')
// CONCATÉNÉS dans UN seul new Function, ordre CANONIQUE du bundler (mjs_socket.ts PUIS mjs_schema.ts,
// cf. src/bundler/index.ts resolveRuntimeFiles) — mjs_schema.ts référence `µ._mjschemaXxx` que
// mjs_socket.ts consulte en garde (`if (µ._mjschemaXxx) {...}`), jamais l'inverse.
const clientSrc = socketSrc + '\n' + schemaSrc

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

// espionne les octets réellement passés à WebSocket.send() — enveloppe, ne REMPLACE jamais le
// traitement RÉEL du client (le hello/toute trame suivante continue de partir normalement).
function spySend(sock: any): any[] {
  const out: any[] = []
  const orig = sock._mjs_ws.send.bind(sock._mjs_ws)
  sock._mjs_ws.send = (data: any) => { out.push(data); return orig(data) }
  return out
}

// même patron en réception — enveloppe ws.onmessage (déjà posé par le VRAI client au moment de
// l'appel, cf. call-sites : toujours APRÈS connect()+tick()).
function spyReceive(sock: any): any[] {
  const out: any[] = []
  const orig = sock._mjs_ws.onmessage.bind(sock._mjs_ws)
  sock._mjs_ws.onmessage = (ev: any) => { out.push(ev.data); orig(ev) }
  return out
}

describe('µ.schema — client (mjs_schema.ts, vrai serveur MJS-WS MemoryTransport, vrai client mjs_socket)', () => {
  it('1. déclaration miroir des deux côtés — sock.send part en BINAIRE (Uint8Array sur le fil), app.on reçoit l\'objet décodé', async () => {
    const { transport, app } = await startApp()
    app.schema('pos', { x: 'i16', y: 'i16' })
    const recus: any[] = []
    app.on('pos', (p) => recus.push(p))

    const µx = makeClient(transport)
    µx.schema('pos', { x: 'i16', y: 'i16' })   // MÊME déclaration, registre CLIENT indépendant
    const sx = µx.socket('memory://x1', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    sx.connect()
    await tick()

    const sent = spySend(sx)
    sx.send('pos', { x: 12, y: -7 })
    await tick()

    assert.equal(sent.length, 1)
    assert.ok(sent[0] instanceof Uint8Array, 'la trame envoyée doit être un Uint8Array (binaire), jamais une string JSON')
    assert.equal(recus.length, 1)
    assert.deepEqual(recus[0], { x: 12, y: -7 })
    await app.stop()
  })

  it('2. sens serveur→client — app.send() encode en binaire, sock.on reçoit l\'objet décodé (trame REÇUE = Uint8Array)', async () => {
    const { transport, app } = await startApp()
    app.schema('etat', { hp: 'u8', pseudo: 'str8' })

    const µx = makeClient(transport)
    µx.schema('etat', { hp: 'u8', pseudo: 'str8' })
    const sx = µx.socket('memory://x2', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    sx.connect()
    await tick()

    const received = spyReceive(sx)
    const got: any[] = []
    sx.on('etat', (p: any) => got.push(p))

    const client = Array.from(app.clients)[0]
    app.send(client, 'etat', { hp: 80, pseudo: 'Zora' })
    await tick()

    assert.equal(received.length, 1)
    assert.ok(received[0] instanceof Uint8Array, 'la trame reçue doit être un Uint8Array (binaire)')
    assert.equal(got.length, 1)
    assert.deepEqual(got[0], { hp: 80, pseudo: 'Zora' })
    await app.stop()
  })

  it('3. hello — schemaHash TOUJOURS émis dès que le module schema est chargé (même un registre local VIDE a un hash — sinon le serveur ne pousserait jamais µ:schema, cf. mjs-ws/core.ts::pushSchemaIfMismatch, « jamais de µ:schema pour rien » si clientHash est ABSENT)', async () => {
    const { transport, app } = await startApp()
    app.schema('x', { n: 'u8' })

    const µx = makeClient(transport)
    µx.schema('x', { n: 'u8' })
    const sx = µx.socket('memory://x3a', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    sx.connect()
    const sentX = spySend(sx)   // AVANT le 1er tick — capture le hello lui-même
    await tick()
    const helloX = JSON.parse(sentX[0])
    assert.equal(helloX.t, 'µ:hello')
    assert.equal(typeof helloX.p.schemaHash, 'string')

    const µy = makeClient(transport)   // AUCUN µy.schema() déclaré — registre local VIDE
    const sy = µy.socket('memory://x3b', { auth: () => ({ id: 'y' }), reconnect: { enabled: false } })
    sy.connect()
    const sentY = spySend(sy)
    await tick()
    const helloY = JSON.parse(sentY[0])
    assert.equal(typeof helloY.p.schemaHash, 'string', 'un registre VIDE a quand même un hash (celui du registre vide) — sinon jamais de bootstrap paresseux possible')
    assert.notEqual(helloY.p.schemaHash, helloX.p.schemaHash, 'hash différent de celui du client x (qui A déclaré \'x\') — preuve que ce n\'est pas une valeur bidon fixe')
    await app.stop()
  })

  it('4. client SANS registre local + serveur AVEC schéma — µ:schema poussée DÈS le handshake (hash vide ≠ hash serveur), le client charge puis décode ensuite', async () => {
    const { transport, app } = await startApp()
    app.schema('pos', { x: 'i16', y: 'i16' })

    const µx = makeClient(transport)   // AUCUN µx.schema() — registre client vide au départ
    assert.equal(µx._mjs_mjschemaRegistre, null, 'sanity — aucun registre local AVANT toute connexion')
    const sx = µx.socket('memory://x4', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    sx.connect()
    await tick()

    assert.ok(µx._mjs_mjschemaRegistre, 'le registre client a dû être créé PENDANT le handshake (hello envoie quand même un hash — celui du registre vide — qui diffère du serveur, cf. test 3 ; le serveur pousse alors µ:schema juste après son welcome)')

    const got: any[] = []
    sx.on('pos', (p: any) => got.push(p))
    const client = Array.from(app.clients)[0]
    app.send(client, 'pos', { x: 5, y: -5 })
    await tick()

    assert.equal(got.length, 1)
    assert.deepEqual(got[0], { x: 5, y: -5 })
    await app.stop()
  })

  it('5a. binary:false — coupe-circuit ENVOI seul : sock.send() reste JSON même pour un type schématisé', async () => {
    const { transport, app } = await startApp()
    app.schema('pos', { x: 'i16', y: 'i16' })
    const recus: any[] = []
    app.on('pos', (p) => recus.push(p))

    const µx = makeClient(transport)
    µx.schema('pos', { x: 'i16', y: 'i16' })
    const sx = µx.socket('memory://x5a', { auth: () => ({ id: 'x' }), reconnect: { enabled: false }, binary: false })
    sx.connect()
    await tick()

    const sent = spySend(sx)
    sx.send('pos', { x: 1, y: 2 })
    await tick()

    const dernier = sent[sent.length - 1]
    assert.equal(typeof dernier, 'string', 'binary:false → JSON (string), jamais un Uint8Array')
    assert.deepEqual(JSON.parse(dernier), { t: 'pos', p: { x: 1, y: 2 } })
    assert.equal(recus.length, 1, 'le serveur (codec \'auto\') route aussi bien le JSON que le binaire pour un type schématisé')
    assert.deepEqual(recus[0], { x: 1, y: 2 })
    await app.stop()
  })

  it('5b. binary:false — la RÉCEPTION décode quand même (le serveur encode indépendamment du hello de ce client)', async () => {
    const { transport, app } = await startApp()
    app.schema('pos', { x: 'i16', y: 'i16' })

    const µx = makeClient(transport)
    µx.schema('pos', { x: 'i16', y: 'i16' })
    const sx = µx.socket('memory://x5b', { auth: () => ({ id: 'x' }), reconnect: { enabled: false }, binary: false })
    sx.connect()
    await tick()

    const got: any[] = []
    sx.on('pos', (p: any) => got.push(p))
    const received = spyReceive(sx)
    const client = Array.from(app.clients)[0]
    app.send(client, 'pos', { x: 9, y: 9 })
    await tick()

    assert.ok(received[received.length - 1] instanceof Uint8Array, 'le serveur encode quand même en binaire (décision 100% serveur, cf. mjs-ws/core.ts::sendRaw) — un client sourd casserait la réception dès que le serveur schématise')
    assert.equal(got.length, 1)
    assert.deepEqual(got[0], { x: 9, y: 9 })
    await app.stop()
  })

  it('6. id de schéma inconnu à la réception — ignoré silencieusement, sans crash (un seul avertissement, jamais un par trame)', async () => {
    const { transport, app } = await startApp()
    app.schema('x', { n: 'u8' })

    const warnings: any[] = []
    const µx: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: (...a: any[]) => warnings.push(a), log: () => {} }
    new Function('µ', clientSrc)(µx)
    µx.schema('x', { n: 'u8' })   // registre CLIENT non vide (id 0 = 'x') — nécessaire pour distinguer « pas de registre » de « id hors registre »
    ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
    const sx = µx.socket('memory://x6', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    sx.connect()
    await tick()

    // injection directe d'un id hors registre (250) — jamais produit par un vrai serveur en accord
    assert.doesNotThrow(() => { sx._mjs_ws.onmessage({ data: new Uint8Array([250]) }) })
    sx._mjs_ws.onmessage({ data: new Uint8Array([250]) })   // 2e trame au MÊME id — toujours pas de 2e avertissement
    await tick()

    assert.equal(warnings.length, 1, 'un seul avertissement, même après plusieurs trames au même id inconnu')
    await app.stop()
  })

  it('7. aller-retour de chaque famille de types via le fil (u16/i16/f32/str8 accentué/list/bits), dans les DEUX sens', async () => {
    const { transport, app } = await startApp()
    app.schema('mix', { a: 'u16', b: 'i16', c: 'f32', d: 'str8', e: list('str8'), f: bits(['vivant', 'vip']) })
    const recus: any[] = []
    app.on('mix', (p) => recus.push(p))

    const µx = makeClient(transport)
    µx.schema('mix', { a: 'u16', b: 'i16', c: 'f32', d: 'str8', e: µx.list('str8'), f: µx.bits(['vivant', 'vip']) })
    const sx = µx.socket('memory://x7', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    sx.connect()
    await tick()

    const charge = { a: 65000, b: -12000, c: 3.5, d: 'café à Noël', e: ['un', 'café', 'crème'], f: { vivant: true, vip: false } }
    sx.send('mix', charge)
    await tick()

    assert.equal(recus.length, 1)
    assert.equal(recus[0].a, 65000)
    assert.equal(recus[0].b, -12000)
    assert.equal(recus[0].c, 3.5)
    assert.equal(recus[0].d, 'café à Noël')
    assert.deepEqual(recus[0].e, ['un', 'café', 'crème'])
    assert.deepEqual(recus[0].f, { vivant: true, vip: false })

    // sens INVERSE (serveur → client), même charge
    const got: any[] = []
    sx.on('mix', (p: any) => got.push(p))
    const client = Array.from(app.clients)[0]
    app.send(client, 'mix', charge)
    await tick()
    assert.equal(got.length, 1)
    assert.equal(got[0].a, 65000)
    assert.equal(got[0].d, 'café à Noël')
    assert.deepEqual(got[0].e, ['un', 'café', 'crème'])
    assert.deepEqual(got[0].f, { vivant: true, vip: false })
    await app.stop()
  })

  it("8. codec 'binary' strict — comportement réel : sock.request() (JSON à id) vers un type SANS schéma est REJETÉ, pas d'exception pour l'id (cf. mjs-ws/core.ts::handleRaw → schemaEngine.rejectIfStrictText, appelée SANS regarder msg.id) ; un type SCHÉMATISÉ, lui, passe très bien en pub/sub", async () => {
    const { transport, app } = await startApp({ codec: 'binary', onLog: () => {} })
    app.schema('ok', { x: 'u8' })
    app.serve('salut', async (p: any) => ({ echo: p }))   // type SANS schéma, acquitté par id

    const µx = makeClient(transport)
    µx.schema('ok', { x: 'u8' })
    const sx = µx.socket('memory://x8', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    sx.connect()
    await tick()

    await assert.rejects(
      sx.request('salut', { msg: 'coucou' }, { timeout: 200 }),
      (e: any) => e && e.code === 'timeout',
      'sock.request() vers un type SANS schéma, en codec binary strict, finit par expirer — le serveur la rejette (µ:error) AVANT de router vers serve(), aucun µ:ack ne peut donc jamais arriver'
    )
    assert.equal(app.stats().messages.texteRejete, 1, 'la requête JSON a bien été comptée REJETÉE côté serveur')

    // un type SCHÉMATISÉ, lui, passe très bien en pub/sub (send/on) — la limite porte sur request() à
    // id (toujours JSON, cf. mjs_schema.ts), pas sur les schémas en général.
    const recus: any[] = []
    app.on('ok', (p) => recus.push(p))
    const sent = spySend(sx)
    sx.send('ok', { x: 7 })
    await tick()
    assert.ok(sent[sent.length - 1] instanceof Uint8Array)
    assert.deepEqual(recus[0], { x: 7 })
    await app.stop()
  })

  it('9. déclaration miroir (même hash) — aucune µ:schema poussée : le registre client garde la MÊME référence après connexion', async () => {
    const { transport, app } = await startApp()
    app.schema('pos', { x: 'i16', y: 'i16' })

    const µx = makeClient(transport)
    µx.schema('pos', { x: 'i16', y: 'i16' })
    const registreAvant = µx._mjs_mjschemaRegistre
    const sx = µx.socket('memory://x9', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    sx.connect()
    await tick()

    assert.equal(µx._mjs_mjschemaRegistre, registreAvant, 'même référence — jamais remplacé, les hash concordaient donc le serveur n\'a rien poussé')
    await app.stop()
  })

  it('10. tampon court — une trame binaire arrivée PENDANT le remplacement du registre (µ:schema) est rejouée juste après, pas perdue', () => {
    const dispatched: any[] = []
    const sockFake = { opts: {}, _mjs_dispatch: (nom: string, msg: any) => dispatched.push({ nom: nom, p: msg.p }) }

    const µx: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
    new Function('µ', clientSrc)(µx)

    // simule le DÉBUT d'un remplacement de registre (comme le ferait µ._mjs_mjschemaOnPush juste avant de recharger)
    µx._mjs_mjschemaSwapping = true

    const rServeur = creerRegistre()
    defSchema(rServeur, 'pos', { x: 'i16', y: 'i16' })
    const trame = encode(rServeur, 'pos', { x: 3, y: 4 })

    µx._mjs_mjschemaOnBinary(sockFake, trame)
    assert.equal(dispatched.length, 0, 'tamponnée pendant le remplacement, pas encore dispatchée')
    assert.equal(µx._mjs_mjschemaBuffered.length, 1)

    // le remplacement « se termine » (µ:schema livre les MÊMES définitions que rServeur) — rejoue le tampon
    const definitions = serialiserDefinitions(rServeur)
    µx._mjs_mjschemaOnPush(sockFake, { p: { version: definitions.hash, definitions: definitions } })

    assert.equal(dispatched.length, 1, 'la trame tamponnée doit avoir été rejouée après coup, pas perdue')
    assert.deepEqual(dispatched[0], { nom: 'pos', p: { x: 3, y: 4 } })
  })
})
