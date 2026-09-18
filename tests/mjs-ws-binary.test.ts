// Tests des trames BINAIRES (socle du futur µschema) — src/mjs-ws/transport.ts
// (représentation interne Uint8Array) + core.ts (handleBinaryRaw : videur, garde de taille,
// routage vers l'accroche interne). MÊME patron « boucle complète » que les autres fichiers
// mjs-ws-*.test.ts, mais le CLIENT est ici le faux WebSocket brut de MemoryTransport (`ws.send()`
// accepte directement un Uint8Array) — le VRAI client µ.socket n'encode/n'envoie que du texte
// pour l'instant (le décodage µschema viendra plus tard), il n'a donc rien à apporter à CES tests précis.
import assert from 'node:assert/strict'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsClient, MjsWsOptions } from '../src/mjs-ws/index.js'

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

// connexion brute authentifiée — même geste que tests/mjs-ws-core.test.ts #9/#11 (pas le VRAI
// client µ.socket : on pilote nous-mêmes le hello pour garder la main sur le canal binaire).
async function connectAuthenticated(transport: MemoryTransport, url: string): Promise<any> {
  const ws = transport.connect({ url })
  await tick()
  ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1 } }))
  await tick()
  return ws
}

describe('MJS-WS — trames binaires (socle du futur µschema)', () => {
  it('a. binaire sous limits.maxPayload, SANS accroche posée → connexion vivante, binaireRecues+binaireIgnorees comptés', async () => {
    const { transport, app } = await startApp()
    const ws = await connectAuthenticated(transport, 'memory://bin-a')
    let closed = false
    ws.onclose = () => { closed = true }
    ws.send(new Uint8Array([1, 2, 3, 4]))
    await tick()
    assert.equal(closed, false, 'aucune accroche posée : ignorée, jamais fermée')
    const snap = app.stats()
    assert.equal(snap.messages.binaireRecues, 1)
    assert.equal(snap.messages.binaireIgnorees, 1, 'sans accroche interne, la trame authentifiée reste ignorée')
    await app.stop()
  })

  it('b. binaire AU-DELÀ de limits.maxPayload → même traitement qu\'un texte trop gros (kick charge, 1009)', async () => {
    const { transport, app } = await startApp({ limits: { maxPayload: 200 }, onLog: () => {} })   // kick INTENTIONNEL
    const ws = await connectAuthenticated(transport, 'memory://bin-b')
    let closedCode: number | null = null
    ws.onclose = (ev: any) => { closedCode = ev.code }
    ws.send(new Uint8Array(500))
    await tick()
    assert.equal(closedCode, 1009, 'même code que le kick « payload trop volumineux » côté texte')
    const snap = app.stats()
    assert.equal(snap.garde.kicksChargeUtile, 1, 'même compteur de garde que pour un texte trop gros')
    assert.equal(snap.messages.binaireRecues, 1, 'comptée même kickée — même politique que messages.recus côté texte')
    await app.stop()
  })

  it('c. accroche interne posée en `as any` → les octets arrivent INTACTS (comparaison byte à byte) avec le bon client', async () => {
    const { transport, app } = await startApp()
    const received: Array<{ clientId: string; bytes: Uint8Array }> = []
    ;(app as any)._binaryHandler = (client: MjsWsClient, bytes: Uint8Array) => { received.push({ clientId: client.id, bytes }) }
    const ws = await connectAuthenticated(transport, 'memory://bin-c')
    const expected = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
    ws.send(expected)
    await tick()
    assert.equal(received.length, 1)
    const client = Array.from(app.clients)[0] as MjsWsClient
    assert.equal(received[0].clientId, client.id, 'routée vers le BON client')
    assert.deepEqual(Array.from(received[0].bytes), Array.from(expected), 'octets intacts, byte à byte')
    assert.equal(app.stats().messages.binaireIgnorees, 0, 'routée avec succès : jamais comptée « ignorée »')
    await app.stop()
  })

  it('d. binaire AVANT le hello (pas encore authentifié) → ignorée + comptée, jamais de crash, le hello JSON reste possible ensuite', async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    const ws = transport.connect({ url: 'memory://bin-d' })
    await tick()
    let closed = false
    ws.onclose = () => { closed = true }
    ws.send(new Uint8Array([1, 2, 3]))
    await tick()
    assert.equal(closed, false, 'aucun crash ni fermeture — juste ignorée')
    assert.equal(app.stats().messages.binaireIgnorees, 1)
    assert.equal(app.stats().connexions.actives, 0, 'jamais authentifiée par une trame binaire — le hello reste JSON obligatoire')

    const recu: any[] = []
    ws.onmessage = (ev: any) => recu.push(JSON.parse(ev.data))
    ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1 } }))
    await tick()
    assert.ok(recu.some(f => f.t === 'µ:welcome'), 'le hello JSON classique fonctionne toujours après la trame binaire ignorée')
    await app.stop()
  })

  it('e. rafale binaire > burst → kick débit (garde.kicksDebit), le videur n\'est PAS contourné par un flot binaire', async () => {
    const { transport, app } = await startApp({ limits: { rate: 5, burst: 5, kickAfter: 3 }, onLog: () => {} })   // kick INTENTIONNEL
    const ws = await connectAuthenticated(transport, 'memory://bin-e')
    let closedCode: number | null = null
    ws.onclose = (ev: any) => { closedCode = ev.code }
    for (let i = 0; i < 30; i++) ws.send(new Uint8Array([i]))
    await tick(60)
    assert.equal(closedCode, 1008, 'même code que le kick « débit dépassé » côté texte')
    assert.ok(app.stats().garde.kicksDebit >= 1)
    await app.stop()
  })
})
