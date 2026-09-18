// Tests des CAS LIMITES de la reprise de session (sessions.ts) —
// suite de tests/mjs-ws-resume.test.ts (le cœur y est : protocole, tampon,
// rejeu, reprise). Ici : débordement du tampon, multi-onglets (agrégation),
// µ:bye/close() d'un parqué, rotation de clé, validation de la config
// ws.resume et priorités entry/config du CLI. Même harnais : vrai client
// µ.socket + MemoryTransport + espions de trames routés par URL.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import { findConfig } from '../src/bundler/config.js'
import { buildRunPlan } from '../src/cli/ws.js'
import type { EntryContract } from '../src/cli/ws.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

interface Spy { in?: Array<{ url: string; msg: any }>; out?: Array<{ url: string; msg: any }> }

// factory WebSocket UNIQUE routée par URL — cf. mjs-ws-resume.test.ts pour le pourquoi
function wireWebSocket(transport: MemoryTransport, perUrl: Record<string, Spy> = {}): void {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) {
    const ws: any = transport.connect({ url, protocols })
    const spy = perUrl[url]
    if (spy && spy.in) {
      const bucket = spy.in
      let real: any = null
      Object.defineProperty(ws, 'onmessage', {
        get() { return real },
        set(fn: any) { real = fn && ((ev: any) => { bucket.push({ url, msg: JSON.parse(ev.data) }); fn(ev) }) },
      })
    }
    if (spy && spy.out) {
      const bucket   = spy.out
      const origSend = ws.send.bind(ws)
      ws.send = (data: string) => { bucket.push({ url, msg: JSON.parse(data) }); origSend(data) }
    }
    return ws
  }
}

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

describe('MJS-WS — reprise de session, cas limites', () => {
  it('1. débordement maxBuffered pendant la grâce → session NON reprenable : retour = frais, JAMAIS de rejeu partiel', async () => {
    const { transport, app } = await startApp({ resume: { maxBuffered: 3 }, onLog: () => {} })
    const recu: any[] = []
    wireWebSocket(transport, { 'memory://e1': { in: recu } })
    const µ = makeMu(); const s = µ.socket('memory://e1', { reconnect: { backoff: [50], jitter: 0 } })
    s.connect(); await tick()
    const w1 = recu.find(f => f.msg.t === 'µ:welcome')!.msg
    const clientRef = Array.from(app.clients)[0]

    s._mjs_ws.close(1006, 'coupure simulée')
    await tick()   // parqué — la reconnexion attend 50 ms
    for (let i = 1; i <= 5; i++) app.send(clientRef, 'flot', { i })   // 5 > maxBuffered 3 → débordé, tampon VIDÉ
    await tick(90)
    assert.equal(s.state, 'open')
    const w2 = recu.filter(f => f.msg.t === 'µ:welcome')[1].msg
    assert.equal(w2.p.resumed, false, 'tampon débordé = session non reprenable, accueil frais')
    assert.notEqual(w2.p.session.id, w1.p.session.id)
    assert.ok(!recu.some(f => f.msg.t === 'flot'), 'AUCUNE trame rejouée — jamais un rejeu partiel (ni 3 sur 5, ni rien)')
    s.destroy(); await app.stop()
  })

  it('2. multi-onglets : A coupe (grâce) → l\'utilisateur reste présent (B vivant) ; B coupe aussi → UN leave, à l\'expiration du DERNIER', async () => {
    const { transport, app } = await startApp({ resume: { grace: 150 }, auth: (hello: any) => ({ id: hello.auth.uid }), onLog: () => {} })
    const recuO: any[] = []
    wireWebSocket(transport, { 'memory://e2o': { in: recuO } })
    const µA = makeMu(); const sA = µA.socket('memory://e2a', { auth: () => ({ uid: 7 }), reconnect: { enabled: false } })
    sA.connect(); await tick()
    const µB = makeMu(); const sB = µB.socket('memory://e2b', { auth: () => ({ uid: 7 }), reconnect: { enabled: false } })
    sB.connect(); await tick()
    const µO = makeMu(); const sO = µO.socket('memory://e2o', { auth: () => ({ uid: 'obs' }) })
    sO.connect(); sO.presence(); await tick()
    recuO.length = 0

    const leaves = () => recuO.filter(f => f.msg.t === 'µ:presence' && f.msg.p.op === 'leave' && f.msg.p.id === '7')
    sA._mjs_ws.close(1006, 'coupure onglet A')       // t0 — A parqué, expirera à ~150
    await tick(80)
    sB._mjs_ws.close(1006, 'coupure onglet B')       // t0+80 — B parqué, expirera à ~230
    await tick(30)                                // t0+110 : les DEUX parqués
    assert.equal(leaves().length, 0, 'les deux onglets parqués : l\'utilisateur est toujours là')
    await tick(75)                                // t0+185 : A expiré (150), B encore en grâce (230)
    assert.equal(leaves().length, 0, 'A expiré mais B encore parqué : toujours aucun leave (agrégation)')
    await tick(100)                               // t0+285 : B expiré aussi
    assert.equal(leaves().length, 1, 'LE leave part à l\'expiration du DERNIER onglet — exactement un')
    sA.destroy(); sB.destroy(); sO.destroy(); await app.stop()
  })

  it('3. close() serveur d\'un PARQUÉ (µ:bye impossible à livrer) : session détruite et purge IMMÉDIATES — pas à l\'expiration', async () => {
    const { transport, app } = await startApp({ resume: true, auth: (hello: any) => ({ id: hello.auth.uid }), onLog: () => {} })
    const recuA: any[] = []; const recuO: any[] = []
    wireWebSocket(transport, { 'memory://e3a': { in: recuA }, 'memory://e3o': { in: recuO } })
    const µA = makeMu(); const sA = µA.socket('memory://e3a', { auth: () => ({ uid: 'a' }), reconnect: { backoff: [80], jitter: 0 } })
    sA.connect(); sA.room('zone'); await tick()
    const wA = recuA.find(f => f.msg.t === 'µ:welcome')!.msg
    const µO = makeMu(); const sO = µO.socket('memory://e3o', { auth: () => ({ uid: 'obs' }) })
    sO.connect(); sO.presence(); await tick()
    recuO.length = 0
    const clientA = Array.from(app.clients).find((c: any) => c.identity.id === 'a')!

    sA._mjs_ws.close(1006, 'coupure simulée')
    await tick()                       // parqué (grâce 30 s — bien plus long que ce test)
    app.send(clientA, 'notif', {})     // tamponné
    clientA.close('fini')              // fermeture DÉFINITIVE d'un parqué → purge immédiate
    await tick()
    const leaves = recuO.filter(f => f.msg.t === 'µ:presence' && f.msg.p.op === 'leave' && f.msg.p.id === 'a')
    assert.equal(leaves.length, 1, 'leave émis TOUT DE SUITE (purge immédiate), pas à l\'expiration de la grâce')
    assert.equal(app.room('zone').size, 0)

    await tick(100)                    // le client revient (backoff 80 ms), session morte en main
    assert.equal(sA.state, 'open')
    const w2 = recuA.filter(f => f.msg.t === 'µ:welcome')[1].msg
    assert.equal(w2.p.resumed, false, 'session détruite par close() : retour = accueil frais')
    assert.notEqual(w2.p.session.id, wA.p.session.id)
    assert.ok(!recuA.some(f => f.msg.t === 'notif'), 'le tampon est mort avec la session')
    sA.destroy(); sO.destroy(); await app.stop()
  })

  it('4. clé tournée : après une reprise, l\'ANCIENNE clé ne marche plus (seule la dernière reçue ouvre la session)', async () => {
    const { transport, app } = await startApp({ resume: true, onLog: () => {} })
    const recu: any[] = []
    wireWebSocket(transport, { 'memory://e4': { in: recu } })
    const µ = makeMu(); const s = µ.socket('memory://e4', { reconnect: { backoff: [50], jitter: 0 } })
    s.connect(); await tick()
    const w1 = recu.find(f => f.msg.t === 'µ:welcome')!.msg   // session {id, clé}

    s._mjs_ws.close(1006, 'coupure 1')
    await tick(90)                                            // REPRISE normale — le welcome 2 porte une clé différente (tournée)
    const w2 = recu.filter(f => f.msg.t === 'µ:welcome')[1].msg
    assert.equal(w2.p.resumed, true)
    assert.notEqual(w2.p.session.key, w1.p.session.key)

    s._mjs_ws.close(1006, 'coupure 2')
    await tick()
    s._mjs_session = { id: w1.p.session.id, key: w1.p.session.key }   // rejoue l'ANCIENNE clé — morte depuis la rotation
    await tick(90)
    assert.equal(s.state, 'open')
    const w3 = recu.filter(f => f.msg.t === 'µ:welcome')[2].msg
    assert.equal(w3.p.resumed, false, 'l\'ancienne clé ne rouvre JAMAIS la session')
    assert.notEqual(w3.p.session.id, w1.p.session.id)
    s.destroy(); await app.stop()
  })

  // double coupure PENDANT une reprise (la connexion qui PORTE la reprise retombe à son
  // tour, PENDANT le await de welcome()) : AVANT le fix, finishResume tournait quand même la clé
  // de session (sessionsEngine.issue()) puis tentait d'envoyer le µ:welcome correspondant — mais
  // la connexion étant re-parquée entre-temps, sendRaw() le tamponnait AU LIEU DE l'envoyer. La
  // clé requise pour déverrouiller ce tampon se retrouvait alors PRISONNIÈRE du tampon lui-même
  // (deadlock) : le client, qui n'a jamais vu passer cette clé neuve, ne pouvait plus JAMAIS
  // reprendre sa session avec la clé qu'il possède réellement (l'ancienne, jamais invalidée côté
  // client) — perte silencieuse et DÉFINITIVE de la reprenabilité (+ de tout message tamponné
  // entre-temps, la session orpheline restant injoignable jusqu'à l'expiration de sa grâce).
  it('4b. double coupure PENDANT la reprise (retombe pendant le welcome() async) : la clé EN COURS reste valable, aucune session injoignable', async () => {
    let releaseWelcome: (() => void) | null = null
    const { transport, app } = await startApp({
      resume: true,
      onLog:  () => {},
      welcome: () => new Promise<void>(resolve => { releaseWelcome = () => resolve() }),
    })
    const recu: any[] = []
    wireWebSocket(transport, { 'memory://e4b': { in: recu } })
    const µ = makeMu()
    const s = µ.socket('memory://e4b', { reconnect: { enabled: false } })

    // 1er hello — welcome() attend le portail, on le libère tout de suite pour celui-ci
    s.connect(); await tick()
    assert.ok(releaseWelcome, 'welcome() du 1er hello doit être en attente')
    releaseWelcome!(); await tick()
    const w1 = recu.filter(f => f.msg.t === 'µ:welcome')[0].msg
    assert.equal(w1.p.resumed, false)
    const originalKey = w1.p.session.key

    // coupure 1 → parqué
    s._mjs_ws.close(1006, 'coupure 1'); await tick()

    // reconnexion (2e connexion) → reprise réclamée avec la clé ORIGINALE, finishResume DÉMARRE
    // et se bloque sur welcome() — on ne libère PAS le portail cette fois
    releaseWelcome = null
    s.connect(); await tick()
    assert.ok(releaseWelcome, 'welcome() de la 1re tentative de reprise doit être en attente')
    const gateAvortee = releaseWelcome!

    // PENDANT que finishResume attend TOUJOURS son welcome(), la connexion qui PORTE cette
    // reprise retombe À SON TOUR (2e coupure — le cœur de cette course)
    s._mjs_ws.close(1006, 'coupure 2 — pendant la reprise'); await tick()

    // on libère MAINTENANT le welcome() de cette reprise avortée
    gateAvortee(); await tick()
    // rien de plus n'a dû partir vers le client (welcome tamponné, jamais délivré à une
    // connexion déjà morte une 2e fois)
    assert.equal(recu.filter(f => f.msg.t === 'µ:welcome').length, 1, 'le µ:welcome de la reprise avortée ne doit JAMAIS atteindre le client')

    // reconnexion (3e connexion) — le client rejoue TOUJOURS sa clé ORIGINALE (il n'en a jamais
    // reçu d'autre) : la reprise DOIT réussir si le fix tient (la clé n'a pas été tournée en vain)
    releaseWelcome = null
    s.connect(); await tick()
    assert.ok(releaseWelcome, 'welcome() de la 2e tentative de reprise doit être en attente')
    releaseWelcome!(); await tick()

    assert.equal(s.state, 'open')
    const welcomes = recu.filter(f => f.msg.t === 'µ:welcome')
    const w2 = welcomes[welcomes.length - 1].msg
    assert.equal(w2.p.resumed, true, 'la reprise avec la clé ORIGINALE doit réussir — sinon la session est devenue injoignable (deadlock)')
    assert.equal(w2.p.session.id, w1.p.session.id, 'même id de session tout du long')
    assert.notEqual(w2.p.session.key, originalKey, 'la clé finit quand même par tourner — juste pas pendant la tentative avortée')

    s.destroy(); await app.stop()
  })

  it('5. validation config ws.resume : clé inconnue → suggestion, type faux → erreur, entier ≤ 0 → erreur, formes valides acceptées', () => {
    const write = (config: unknown): string => {
      const root = mjsTmp('resume-cfg')
      writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(config))
      return root
    }
    assert.throws(() => findConfig(write({ ws: { resume: { grace: 5000, maxBufferd: 10 } } })), /ws\.resume\.maxBufferd : clé inconnue — tu voulais dire 'maxBuffered' \?/)
    assert.throws(() => findConfig(write({ ws: { resume: 'oui' } })), /ws\.resume doit être true, false ou un objet/)
    assert.throws(() => findConfig(write({ ws: { resume: { grace: 0 } } })), /ws\.resume\.grace doit être un entier > 0/)
    assert.throws(() => findConfig(write({ ws: { resume: { maxBytes: 12.5 } } })), /ws\.resume\.maxBytes doit être un entier > 0/)
    assert.equal(findConfig(write({ ws: { resume: true } }))!.config.ws!.resume, true)
    assert.deepEqual(findConfig(write({ ws: { resume: { grace: 5000, maxBuffered: 100, maxBytes: 1024 } } }))!.config.ws!.resume, { grace: 5000, maxBuffered: 100, maxBytes: 1024 })
  })

  it('6. CLI (buildRunPlan) : ws.resume transmis depuis la config ; entry + config → warn doublon et l\'ENTRY prime en bloc', () => {
    const warns: string[] = []
    const warn = (message: string) => { warns.push(message) }

    // config seule → transmise telle quelle
    const seul: EntryContract = { options: {} }
    const planA = buildRunPlan(seul, { resume: { grace: 5000 } }, undefined, warn)
    assert.deepEqual(planA.options.resume, { grace: 5000 })
    assert.equal(warns.length, 0)

    // entry + config → warn + l'entry prime EN BLOC (y compris un false explicite)
    const deux: EntryContract = { options: { resume: false } }
    const planB = buildRunPlan(deux, { resume: true }, undefined, warn)
    assert.equal(planB.options.resume, false, 'l\'entry prime — même pour couper (resume: false) face à un true en config')
    assert.equal(warns.length, 1)
    assert.match(warns[0], /resume défini à la fois dans l'entry et dans mjs\.config\.json \(ws\.resume\) — l'entry prime/)
  })
})
