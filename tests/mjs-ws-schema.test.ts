// Tests d'INTÉGRATION µschema côté serveur — MemoryTransport + client BRUT simulé,
// MÊME patron que tests/mjs-ws-binary.test.ts : on pilote nous-mêmes le hello pour garder la main
// sur le canal binaire (le VRAI client µ.socket ne décode pas encore le binaire — ce sera pour
// plus tard). Le registre « côté test » (schema/core.ts) est déclaré SÉPARÉMENT du serveur (même
// nom/champs/ordre) — prouve l'INTEROPÉRABILITÉ réelle (deux registres indépendants qui
// s'accordent produisent des octets compatibles), jamais une relecture d'état interne partagé.
import assert from 'node:assert/strict'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { creerRegistre, defSchema, encode, decode, hashRegistre, chargerDefinitions } from '../src/schema/core.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

// connexion brute + hello — `recu` s'enrichit de TOUTE trame reçue ensuite (texte OU binaire),
// pour toute la durée du test (même référence retournée, mutée en continu par onmessage).
async function connectHello(transport: MemoryTransport, url: string, helloP: Record<string, unknown> = {}): Promise<{ ws: any; recu: unknown[] }> {
  const ws = transport.connect({ url })
  const recu: unknown[] = []
  await tick()
  ws.onmessage = (ev: any) => recu.push(ev.data)
  ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, ...helloP } }))
  await tick()
  return { ws, recu }
}

const jsonOf       = (recu: unknown[]): any[] => recu.filter((d): d is string => typeof d === 'string').map(d => JSON.parse(d))
const binOf        = (recu: unknown[]): Uint8Array[] => recu.filter((d): d is Uint8Array => d instanceof Uint8Array)
const framesOfType = (recu: unknown[], t: string): any[] => jsonOf(recu).filter(f => f.t === t)

describe('MJS-WS — µschema (intégration serveur, client brut simulé)', () => {
  it('1. entrant — trame binaire encodée par un registre INDÉPENDANT (même déclaration) → décodée, routée vers app.on comme un message texte normal', async () => {
    const { transport, app } = await startApp()
    app.schema('pos', { x: 'i16', y: 'i16' })
    const recus: any[] = []
    app.on('pos', (p, client) => recus.push({ p, id: client.id }))
    const { ws } = await connectHello(transport, 'memory://s1')

    const registreTest = creerRegistre()
    defSchema(registreTest, 'pos', { x: 'i16', y: 'i16' })   // MÊME déclaration, registre SÉPARÉ
    ws.send(encode(registreTest, 'pos', { x: -7, y: 42 }))
    await tick()

    assert.equal(recus.length, 1)
    assert.deepEqual(recus[0].p, { x: -7, y: 42 })
    assert.equal(app.stats().messages.binaireRecues, 1)
    assert.equal(app.stats().messages.binaireIgnorees, 0)
  })

  it('2. sortant — app.send()/broadcast()/room().send() encodent en binaire quand le type a un schéma, décodable par un registre indépendant', async () => {
    const { transport, app } = await startApp()
    app.schema('etat', { hp: 'u8', pseudo: 'str8' })
    const { recu } = await connectHello(transport, 'memory://s2')
    const client = Array.from(app.clients)[0]

    app.send(client, 'etat', { hp: 80, pseudo: 'Zora' })
    app.broadcast('etat', { hp: 55, pseudo: 'Elfe' })
    app.room('salle-vide').send('etat', { hp: 10, pseudo: 'Nain' })   // aucun membre — ne lève pas, ne produit rien
    await tick()

    const binaires = binOf(recu)
    assert.equal(binaires.length, 2, 'send() + broadcast() → 2 trames binaires (room vide → 0 destinataire)')
    const registreTest = creerRegistre()
    defSchema(registreTest, 'etat', { hp: 'u8', pseudo: 'str8' })
    assert.deepEqual(binaires.map(b => decode(registreTest, b).objet), [{ hp: 80, pseudo: 'Zora' }, { hp: 55, pseudo: 'Elfe' }])
  })

  it('3. codec \'binary\' strict — texte applicatif REJETÉ (compté + µ:error throttlé) ; envoi SANS schéma → throw à l\'envoi, déterministe même sans destinataire', async () => {
    const { transport, app } = await startApp({ codec: 'binary', onLog: () => {} })
    app.schema('ok', { x: 'u8' })
    // AUCUN client connecté ici — le throw ne dépend PAS d'un destinataire (cf. « erreur de dev claire »)
    assert.throws(() => app.broadcast('sansSchema', { a: 1 }), /SANS schéma déclaré/)

    const { ws, recu } = await connectHello(transport, 'memory://s3')
    ws.send(JSON.stringify({ t: 'chatTexte', p: { msg: 'salut' } }))
    await tick()

    assert.equal(app.stats().messages.texteRejete, 1)
    assert.ok(framesOfType(recu, 'µ:error').length >= 1, 'µ:error reçu pour le texte applicatif rejeté')
  })

  it('4. codec \'json\' — coupe-circuit : un type SCHÉMATISÉ part quand même en JSON, jamais un octet de binaire émis', async () => {
    const { transport, app } = await startApp({ codec: 'json' })
    app.schema('pos', { x: 'i16', y: 'i16' })
    const { recu } = await connectHello(transport, 'memory://s4')
    const client = Array.from(app.clients)[0]
    app.send(client, 'pos', { x: 1, y: 2 })
    await tick()
    assert.equal(binOf(recu).length, 0, 'codec json → jamais de binaire, même schématisé')
    assert.deepEqual(framesOfType(recu, 'pos')[0].p, { x: 1, y: 2 })
  })

  it('5. µ:welcome porte schemaHash SEULEMENT si un registre existe — clé ABSENTE sans schéma déclaré', async () => {
    const { transport: t1, app: a1 } = await startApp()
    a1.schema('x', { n: 'u8' })
    const { recu: r1 } = await connectHello(t1, 'memory://s5a')
    assert.equal(typeof framesOfType(r1, 'µ:welcome')[0].p.schemaHash, 'string')

    const { transport: t2 } = await startApp()   // AUCUN schéma déclaré
    const { recu: r2 } = await connectHello(t2, 'memory://s5b')
    const welcome2 = framesOfType(r2, 'µ:welcome')[0]
    assert.equal(Object.prototype.hasOwnProperty.call(welcome2.p, 'schemaHash'), false, 'non-régression — pas même un `undefined` explicite')
  })

  it('6. hello.schemaHash différent → µ:schema poussée juste après welcome, DÉFINITIONS rechargeables ET décodables (voyage complet)', async () => {
    const { transport, app } = await startApp()
    app.schema('pos', { x: 'i16', y: 'i16' })
    const attendu = (() => { const r = creerRegistre(); defSchema(r, 'pos', { x: 'i16', y: 'i16' }); return hashRegistre(r) })()

    const { recu } = await connectHello(transport, 'memory://s6', { schemaHash: 'pas-le-bon-hash' })
    const welcome     = framesOfType(recu, 'µ:welcome')[0]
    const schemaFrame = framesOfType(recu, 'µ:schema')[0]
    assert.ok(schemaFrame, 'µ:schema poussée juste après le welcome')
    assert.equal(welcome.p.schemaHash, attendu)
    assert.equal(schemaFrame.p.version, attendu)

    const rechargé = chargerDefinitions(schemaFrame.p.definitions)
    const client = Array.from(app.clients)[0]
    app.send(client, 'pos', { x: 12, y: -3 })
    await tick()
    const dernierBinaire = binOf(recu).at(-1)!
    assert.deepEqual(decode(rechargé, dernierBinaire).objet, { x: 12, y: -3 })
  })

  it('6b. hello.schemaHash IDENTIQUE au serveur → aucune µ:schema poussée (rien à synchroniser)', async () => {
    const { transport, app } = await startApp()
    app.schema('pos', { x: 'i16', y: 'i16' })
    const hashServeur = (() => { const r = creerRegistre(); defSchema(r, 'pos', { x: 'i16', y: 'i16' }); return hashRegistre(r) })()
    const { recu } = await connectHello(transport, 'memory://s6b', { schemaHash: hashServeur })
    assert.equal(framesOfType(recu, 'µ:schema').length, 0)
  })

  it('7. entrant — id de schéma inconnu → binaireIgnorees compté ; µ:error throttlé SEULEMENT en mode \'binary\' (silence en \'auto\')', async () => {
    const { transport: t1, app: a1 } = await startApp()
    a1.schema('x', { n: 'u8' })
    const { ws: ws1, recu: r1 } = await connectHello(t1, 'memory://s7a')
    ws1.send(new Uint8Array([250]))   // id hors registre (un seul schéma déclaré → id 0 valide, 250 ne l'est pas)
    await tick()
    assert.equal(a1.stats().messages.binaireIgnorees, 1)
    assert.equal(framesOfType(r1, 'µ:error').length, 0, 'mode auto — silencieux (pas de canal de reconnaissance gratuit)')

    const { transport: t2, app: a2 } = await startApp({ codec: 'binary', onLog: () => {} })
    a2.schema('x', { n: 'u8' })
    const { ws: ws2, recu: r2 } = await connectHello(t2, 'memory://s7b')
    ws2.send(new Uint8Array([250]))
    await tick()
    assert.equal(a2.stats().messages.binaireIgnorees, 1)
    assert.ok(framesOfType(r2, 'µ:error').length >= 1, 'mode binary — signalée par µ:error throttlé')
  })

  it('8. non-régression — AUCUN schéma déclaré : trame JSON strictement identique, que opts.schema soit absent ou un registre EXPLICITEMENT vide', async () => {
    const { transport: t1, app: a1 } = await startApp()
    const { recu: r1 } = await connectHello(t1, 'memory://s8a')
    a1.send(Array.from(a1.clients)[0], 'chat', { texte: 'salut' })

    const { transport: t2, app: a2 } = await startApp({ codec: 'auto', schemas: {} })
    const { recu: r2 } = await connectHello(t2, 'memory://s8b')
    a2.send(Array.from(a2.clients)[0], 'chat', { texte: 'salut' })
    await tick()

    assert.equal(binOf(r1).length, 0)
    assert.equal(binOf(r2).length, 0)
    assert.deepEqual(framesOfType(r1, 'chat')[0], framesOfType(r2, 'chat')[0], 'même charge — aucun octet binaire nulle part, dans les deux cas')
  })

  it('9. codec \'binary\' strict — app.send()/sendUser()/room().send() lèvent TOUS pour un type sans schéma (pas seulement broadcast) ; un type schématisé passe', async () => {
    const { transport, app } = await startApp({ codec: 'binary', onLog: () => {} })
    app.schema('ok', { x: 'u8' })
    await connectHello(transport, 'memory://s9')
    const client = Array.from(app.clients)[0]
    assert.throws(() => app.send(client, 'inconnu', {}), /SANS schéma déclaré/)
    assert.throws(() => app.sendUser('personne', 'inconnu', {}), /SANS schéma déclaré/, 'déterministe même sans destinataire correspondant')
    assert.throws(() => app.room('salle').send('inconnu', {}), /SANS schéma déclaré/)
    assert.doesNotThrow(() => app.send(client, 'ok', { x: 1 }))
  })

  it('10. entrant, contenu binaire MALFORMÉ (id connu, décodage lève, cf. schema/core.ts::bornerLecture) → log interne throttlé 1×/fenêtre par client, jamais un par trame (flood ≠ travail de log non borné)', async () => {
    const logs: unknown[] = []
    const { transport, app } = await startApp({
      codec: 'binary',
      onLog: (level, message, meta) => { if (String(message).includes('décodage en échec')) logs.push({ level, message, meta }) },
    })
    app.schema('msg', { texte: 'str16' })
    const { ws, recu } = await connectHello(transport, 'memory://s10')

    // id valide (0, seul schéma déclaré) + préfixe str16 annonçant 100 octets, AUCUN octet de
    // contenu ensuite → decode() lève RangeError (cf. schema/core.ts::bornerLecture, fix jumeau).
    const malformee = new Uint8Array([0, 100, 0])
    for (let i = 0; i < 5; i++) ws.send(malformee)
    await tick()

    assert.equal(app.stats().messages.binaireIgnorees, 5, 'chaque trame malformée compte, throttlée ou non (compteur jamais gagé par le throttle)')
    assert.equal(logs.length, 1, 'AVANT le fix : 1 log par trame reçue (5) — APRÈS : throttlé comme sendThrottledError, 1 seul log pour la fenêtre')
    assert.equal(framesOfType(recu, 'µ:error').length, 1, 'µ:error client — même fenêtre partagée que le log (une seule porte throttleActif)')
  })
})
