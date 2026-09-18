// Tests persistance de MJS-Server (persist.ts/persist-file.ts/persist-bridge.ts) — MÊME
// harnais que tests/mjs-server-core.test.ts (VRAI client µ.socket sur MemoryTransport). Couvre : le
// contrat façade (validation, duck-typing, zéro coût si absent), le débounce/plancher périodique,
// les 3 adaptateurs fournis (mémoire/fichier/pont HTTP signé), la restauration au boot (état fidèle,
// minuterie réarmée, code rejoignable) et la rafale finale de app.stop().
//
// DIFFÉRENCE délibérée avec le harnais de mjs-server-core/matchmaking.test.ts : ici `creerApp()` ne
// fait PAS `.listen()` elle-même — la restauration tourne DANS `.listen()` (cf. index.ts), donc
// `app.game(...)` doit être appelé AVANT (ordre documenté en tête d'index.ts), jamais après comme
// le permettent les autres suites (qui n'exercent jamais opts.persist).
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mjsServer, createGame, resolvePersistOption, createPersistEngine,
  MemoryPersistAdapter, FilePersistAdapter, BridgePersistAdapter,
  encodeSnapshot, decodeSnapshot,
} from '../src/mjs-server/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsServerApp, MjsServerOptions } from '../src/mjs-server/index.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil : délai dépassé — condition jamais vraie')
    await tick(10)
  }
}

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

function connecter(transport: MemoryTransport, id: string): any {
  const µ = makeClient(transport)
  return µ.socket('memory://' + id, { auth: () => ({ id }), reconnect: { enabled: false } })
}

/** NE fait PAS `.listen()` — cf. commentaire de tête (app.game() doit être appelé avant) */
function creerApp(opts: MjsServerOptions = {}): { transport: MemoryTransport; app: MjsServerApp } {
  const transport = new MemoryTransport()
  const app = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, ...opts })
  return { transport, app }
}

/** jeu de référence — places 2, code, 1 seul move 'inc', minuterie de tour NOMMÉE via
 *  hooks.onTurnTimeout qui pose un flag observable (plus simple à vérifier après restauration
 *  qu'un roundrobin implicite) — `turns: undefined` en override désactive complètement le tour
 *  (tests qui veulent plusieurs coups libres sans jongler avec qui a la main) */
function declarerJeu(app: MjsServerApp, overrides: Record<string, any> = {}): void {
  const { hooks: hooksOverride, ...autres } = overrides
  app.game('duel', {
    seats: 2,
    code: true,
    seatTtl: 500,
    emptyTtl: 150,
    state: () => ({ n: 0, timeoutFired: false }),
    moves: { inc: (game: any) => { game.state.n++; game.next() } },
    phases: { jeu: ['inc'] },
    turns: { order: 'roundrobin', timeout: 200 },
    ...autres,
    hooks: { onTurnTimeout: (game: any) => { game.state.timeoutFired = true }, ...hooksOverride },
  })
}

function fakeApp(): any { return { send() {} } }

describe('MJS-Server — persistance (persist.ts/persist-file.ts/persist-bridge.ts)', () => {
  it("1. mémoire : mutation → débounce → save() ; nouvelle app avec le MÊME adaptateur restaure fidèlement (état/phase/tour/code) ; stop() garantit le flush", async () => {
    const store = new MemoryPersistAdapter()
    const { transport, app } = creerApp({ persist: { adapter: store, debounce: 20 } })
    declarerJeu(app)
    await app.listen()
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    const repA = await sA.request('µgame:play', { type: 'duel', code: true })
    const sB = connecter(transport, 'b'); sB.connect(); await tick()
    await sB.request('µgame:play', { type: 'duel', code: repA.code })
    await sA.request('µgame:move', { game: repA.game, move: 'inc' })
    await app.stop()   // rafale finale — aucune attente du débounce nécessaire pour que ce soit écrit

    const brut = await store.load()
    assert.equal(brut.length, 1)
    assert.equal(brut[0].data.state.n, 1)
    assert.equal(brut[0].data.phase, 'jeu')
    assert.equal(brut[0].data.turn, 'a')
    assert.equal(brut[0].data.code, repA.code)

    const { transport: t2, app: app2 } = creerApp({ persist: { adapter: store, debounce: 20 } })
    declarerJeu(app2)
    await app2.listen()   // restaure AVANT d'accepter la moindre connexion
    const sA2 = connecter(t2, 'a'); sA2.connect(); await tick()
    const resync = await sA2.request('µgame:resync', { game: repA.game })
    assert.equal(resync.view.n, 1)
    assert.equal(resync.phase, 'jeu')
    assert.equal(resync.turn, 'a')
    await app2.stop()
  })

  it("2. débounce : 3 coups rapprochés (async, hors microtâche) → 1 seul save(), reflétant l'état FINAL", async () => {
    let appels = 0; let dernier: any = null
    const spy = { load: async () => [], save: (_id: string, data: any) => { appels++; dernier = data }, remove: () => {} }
    const { transport, app } = creerApp({ persist: { adapter: spy, debounce: 60 } })
    declarerJeu(app, { turns: undefined })   // tour désactivé — A peut jouer librement plusieurs fois de suite
    await app.listen()
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    const repA = await sA.request('µgame:play', { type: 'duel', code: true })
    await sA.request('µgame:move', { game: repA.game, move: 'inc' })
    await sA.request('µgame:move', { game: repA.game, move: 'inc' })
    await sA.request('µgame:move', { game: repA.game, move: 'inc' })
    assert.equal(appels, 0, 'sanity : le débounce (60ms) ne doit pas encore avoir livré')
    await tick(100)
    assert.equal(appels, 1, '3 coups rapprochés (< 60ms) doivent produire UN SEUL save()')
    assert.equal(dernier.state.n, 3, "le save unique doit refléter l'état APRÈS le 3e coup")
    await app.stop()
  })

  it("3. fichier : écrire → NOUVELLE app sur le MÊME dossier (crash simulé, SANS stop() propre) → la partie REVIT (état/phase/tour identiques, minuterie réarmée qui tire), le code privé reste joignable", async function () {
    this.timeout(8000)
    const dir = mjsTmp('persist-file-crash')
    const { transport: t1, app: app1 } = creerApp({ persist: { adapter: new FilePersistAdapter({ dir }), debounce: 20 } })
    declarerJeu(app1, { turns: { order: 'roundrobin', timeout: 300 } })
    await app1.listen()
    const sA = connecter(t1, 'a'); sA.connect(); await tick()
    const repA = await sA.request('µgame:play', { type: 'duel', code: true })
    const sB = connecter(t1, 'b'); sB.connect(); await tick()
    await sB.request('µgame:play', { type: 'duel', code: repA.code })
    await sA.request('µgame:move', { game: repA.game, move: 'inc' })   // tour → 'a' (1er next()), µtour armé à +300ms

    await tick(120)   // largement assez pour le débounce (20ms) + l'écriture disque, largement AVANT les 300ms du tour
    // « crash » — app1 n'est JAMAIS arrêtée proprement (pas de app1.stop()) : la reprise ne doit
    // dépendre QUE de ce qui est déjà sur disque, jamais d'un hook de fermeture propre

    const { transport: t2, app: app2 } = creerApp({ persist: { adapter: new FilePersistAdapter({ dir }), debounce: 20 }, onLog: () => {} })   // le 3e joueur refusé plus bas est INTENTIONNEL — pas de bruit
    declarerJeu(app2, { turns: { order: 'roundrobin', timeout: 300 } })
    await app2.listen()   // charge + restaure AVANT d'accepter la moindre connexion (cf. index.ts)

    const sA2 = connecter(t2, 'a'); sA2.connect(); await tick()
    const resync = await sA2.request('µgame:resync', { game: repA.game })
    assert.equal(resync.view.n, 1, 'état identique')
    assert.equal(resync.phase, 'jeu', 'phase identique')
    assert.equal(resync.turn, 'a', 'tour identique')

    await tick(220)   // le reste du délai de tour (≈180ms au boot d'app2) doit s'épuiser et tirer
    const resync2 = await sA2.request('µgame:resync', { game: repA.game })
    assert.equal(resync2.view.timeoutFired, true, 'la minuterie de tour RÉARMÉE par la restauration doit avoir fini par tirer')

    const sC = connecter(t2, 'c'); sC.connect(); await tick()
    await assert.rejects(
      sC.request('µgame:play', { type: 'duel', code: repA.code }),
      (e: any) => /complète/i.test(e),
      'le code privé doit rester résolu vers LA MÊME partie (déjà pleine) — pas "code inconnu"',
    )

    await app2.stop()
  })

  it('4. fin de partie RÉELLE (emptyTtl, tous déconnectés) → remove() appelé, entrée absente de load() (contrairement à un arrêt serveur, cf. test 1)', async () => {
    const store = new MemoryPersistAdapter()
    const { transport, app } = creerApp({ persist: { adapter: store, debounce: 10 } })
    declarerJeu(app, { emptyTtl: 60 })
    await app.listen()
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    const repA = await sA.request('µgame:play', { type: 'duel', code: true })
    await sA.request('µgame:move', { game: repA.game, move: 'inc' })
    await tick(40)
    assert.equal((await store.load()).length, 1, 'sanity : la partie est bien persistée avant sa fin')

    sA._mjs_ws.close(1006, 'plus personne')
    await tick()
    await tick(150)   // emptyTtl = 60ms largement dépassé → _destroy() → forgetGame() → remove()
    assert.equal((await store.load()).length, 0, 'entrée supprimée du stockage après une VRAIE destruction')
    await app.stop()
  })

  it('5. fichier corrompu (JSON invalide) ignoré sans crash — load() ne throw jamais, warn émis, les entrées SAINES survivent', async () => {
    const dir = mjsTmp('persist-file-corrupt')
    writeFileSync(join(dir, 'partie1.json'), JSON.stringify({
      id: 'partie1', type: 'duel', code: null, state: { n: 0 }, phase: null, turn: null, seq: 0, journal: [], seats: [], timers: [],
    }))
    writeFileSync(join(dir, 'partie2.json'), "{ ceci n'est pas du JSON valide")
    const warns: string[] = []
    const adapter = new FilePersistAdapter({ dir, onLog: (level, message) => { if (level === 'warn') warns.push(message) } })
    const brut = await adapter.load()
    assert.equal(brut.length, 1, 'seule la partie SAINE est chargée')
    assert.equal(brut[0].id, 'partie1')
    assert.ok(warns.some(m => /corrompu/i.test(m)), 'un warn doit signaler le fichier corrompu')
  })

  it("6. adaptateur maison (objet littéral, PAS une classe) — duck-typing accepté, appelé normalement", async () => {
    let saveAppele = false
    const maison = { load: async () => [], save: (_id: string, _d: any) => { saveAppele = true }, remove: (_id: string) => {} }
    assert.ok(resolvePersistOption({ adapter: maison, debounce: 5 }), 'un littéral exposant load/save/remove doit être accepté (duck-typing strict)')

    const { transport, app } = creerApp({ persist: { adapter: maison, debounce: 5 } })
    declarerJeu(app, { turns: undefined })
    await app.listen()
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    const repA = await sA.request('µgame:play', { type: 'duel', code: true })
    await sA.request('µgame:move', { game: repA.game, move: 'inc' })   // seul en jeu (turns désactivé) — pas besoin d'un 2e siège
    await tick(30)
    assert.ok(saveAppele, "save() de l'adaptateur maison doit avoir été appelé")
    await app.stop()
  })

  it('7. pont HTTP : signature HMAC vérifiée par un VRAI serveur node:http, save/remove reçus avec le bon secret', async function () {
    this.timeout(8000)
    const SECRET = 'secret-persist-bridge-test'
    const received: any[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body      = Buffer.concat(chunks).toString('utf8')
        const ts        = req.headers['x-mjs-ws-timestamp']
        const sig       = req.headers['x-mjs-ws-signature']
        const canonical = ts +'.'+ req.method +'.'+ req.url +'.'+ body
        const expected  = createHmac('sha256', SECRET).update(canonical).digest('hex')
        if (expected !== sig) { res.writeHead(401); res.end('signature invalide'); return }
        if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, games: [] })); return }
        received.push(JSON.parse(body))
        res.writeHead(200); res.end('ok')
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as any).port
    const adapter = new BridgePersistAdapter({ url: `http://127.0.0.1:${port}/mjs-server/persist`, secret: SECRET })

    const { transport, app } = creerApp({ persist: { adapter, debounce: 10 } })
    declarerJeu(app, { turns: undefined, emptyTtl: 60 })
    await app.listen()
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    const repA = await sA.request('µgame:play', { type: 'duel', code: true })
    await sA.request('µgame:move', { game: repA.game, move: 'inc' })
    await waitUntil(() => received.some(m => m.op === 'save'), 3000)
    const save = received.find(m => m.op === 'save')
    assert.equal(save.id, repA.game)
    assert.equal(save.data.state.n, 1)

    sA._mjs_ws.close(1006, 'fin')
    await tick()
    await tick(150)   // emptyTtl = 60ms largement dépassé
    await waitUntil(() => received.some(m => m.op === 'remove'), 3000)
    assert.equal(received.find(m => m.op === 'remove').id, repA.game)

    await app.stop()
    await new Promise<void>(r => server.close(() => r()))
  })

  it("8. stop() : rafale finale — un débounce encore en attente (loin d'avoir expiré) est quand même livré, PUIS flush() de l'adaptateur", async () => {
    let saveAppels = 0; let flushAppele = false
    const adapter = {
      load: async () => [],
      save: (_id: string, _d: any) => { saveAppels++ },
      remove: (_id: string) => {},
      flush: async () => { flushAppele = true },
    }
    const { transport, app } = creerApp({ persist: { adapter, debounce: 5000 } })   // 5 s — jamais atteint naturellement ici
    declarerJeu(app, { turns: undefined })
    await app.listen()
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    const repA = await sA.request('µgame:play', { type: 'duel', code: true })
    await sA.request('µgame:move', { game: repA.game, move: 'inc' })
    assert.equal(saveAppels, 0, "sanity : le débounce de 5s n'a pas encore livré")
    await app.stop()
    assert.equal(saveAppels, 1, 'stop() doit forcer la livraison du débounce en attente')
    assert.ok(flushAppele, "flush() de l'adaptateur doit être appelé après la rafale")
  })

  it('9. opts.persist absent : resolvePersistOption/createPersistEngine → null, AUCUN hook armé (Game._onMutate reste null)', () => {
    assert.equal(resolvePersistOption(undefined), null)
    assert.equal(resolvePersistOption(null), null)
    assert.equal(createPersistEngine(null, () => {}), null)

    const def: any = {
      type: 't9', seats: 1, code: false, seatTtl: 1000, tick: 0, state: () => ({}), moves: {},
      view: (p: any) => p.state, phases: null, turns: null, timers: {}, limits: { moves: null }, emptyTtl: 1000, hooks: {},
    }
    const game = createGame(fakeApp(), def, () => {}, 'p9')
    assert.equal(game._onMutate, null, "sans moteur de persistance, _onMutate n'est JAMAIS assigné")
    game._destroy()
  })

  it('10. validation stricte (opts.persist) : clé inconnue → suggestion, adaptateur invalide → erreur claire', () => {
    const bidule = { load: async () => [], save: () => {}, remove: () => {} }
    assert.throws(
      () => resolvePersistOption({ adapter: bidule, debunce: 10 } as any),
      (e: any) => /debunce/.test(e.message) && /tu voulais dire 'debounce'/.test(e.message),
    )
    assert.throws(
      () => resolvePersistOption({ adapter: { load: async () => [] } } as any),
      /adapter doit exposer/,
    )
    assert.throws(
      () => resolvePersistOption({ adapter: bidule, debounce: -5 } as any),
      /debounce doit être un nombre ≥ 0/,
    )
    assert.throws(
      () => resolvePersistOption({ adapter: bidule, snapshotEvery: 'jamais' } as any),
      /snapshotEvery doit être un nombre/,
    )
  })

  it('11. snapshotEvery : plancher périodique — sous mutation CONTINUE (débounce sans cesse réarmé), le plancher force quand même un save', async function () {
    this.timeout(5000)
    let saveAppels = 0
    const adapter = { load: async () => [], save: () => { saveAppels++ }, remove: () => {} }
    const resolved = resolvePersistOption({ adapter, debounce: 40, snapshotEvery: 60 })!
    const engine = createPersistEngine(resolved, () => {})!
    const partieFake: any = { id: 'pf', serialize: () => ({}), _onMutate: null }
    engine.armGame(partieFake)

    // mutation continue — réarme le débounce (40ms) toutes les 15ms : un pur débounce ne
    // livrerait JAMAIS (toujours réarmé avant expiration) — le plancher (60ms) doit passer outre
    const fin = Date.now() + 200
    while (Date.now() < fin) { partieFake._onMutate(partieFake); await tick(15) }
    assert.ok(saveAppels >= 1, 'le plancher périodique doit avoir forcé au moins un save malgré la mutation continue')
    await engine.stop()
  })
})

// Garde TLS — load() restaure TOUT l'état à partir de la RÉPONSE de cette URL : en
// http:// non-loopback, un MITM peut la forger. Le constructeur de BridgePersistAdapter refuse donc
// http:// hors loopback, sauf allowInsecure:true. MÊME garde/mêmes 4 formes loopback que le proxy de
// décisions (cf. tests/mjs-ws-proxy.test.ts, décrivant « garde TLS »/proxy.ts::estLoopback) — purement
// synchrone (constructeur), aucun serveur/harnais nécessaire ici.
describe('mjs-server/persist-bridge — garde TLS du constructeur', () => {
  it('1. http:// non-loopback → throw au constructeur, message clair MITM', () => {
    assert.throws(
      () => new BridgePersistAdapter({ url: 'http://back.example.com/mjs-server/persist', secret: 'x' }),
      /http:\/\/ non-loopback/,
    )
  })

  it('2. http://127.0.0.1:x → OK (loopback IPv4)', () => {
    assert.doesNotThrow(() => new BridgePersistAdapter({ url: 'http://127.0.0.1:4000/mjs-server/persist', secret: 'x' }))
  })

  it("3. http://localhost:x → OK (loopback, alias 'localhost')", () => {
    assert.doesNotThrow(() => new BridgePersistAdapter({ url: 'http://localhost:4000/mjs-server/persist', secret: 'x' }))
  })

  it('4. http://[::1]:x → OK (loopback IPv6 entre crochets)', () => {
    assert.doesNotThrow(() => new BridgePersistAdapter({ url: 'http://[::1]:4000/mjs-server/persist', secret: 'x' }))
  })

  it('5. https://back non-loopback → OK (TLS, garde non applicable)', () => {
    assert.doesNotThrow(() => new BridgePersistAdapter({ url: 'https://back.example.com/mjs-server/persist', secret: 'x' }))
  })

  it('6. http:// non-loopback + allowInsecure:true → OK (échappatoire explicite)', () => {
    assert.doesNotThrow(() => new BridgePersistAdapter({ url: 'http://back.example.com/mjs-server/persist', secret: 'x', allowInsecure: true }))
  })
})

// La paire est LE point de passage texte des 3 adaptateurs (cf. persist.ts, « encodage du
// snapshot ») : ces tests verrouillent son contrat directement, sans passer par un adaptateur —
// le jour où elle gagne un traitement particulier, c'est ici qu'on verra ce qui change.
describe('mjs-server/persist — encodeSnapshot/decodeSnapshot, le contrat de la paire', () => {
  const snapshot = { id: 'game7', type: 'duel', state: { n: 3, accents: 'éàü', nested: { a: [1, 2, { b: null }] } }, timers: [{ name: 'µturn', at: 1700000000000 }] } as any

  it('1. encodeSnapshot rend du TEXTE, et exactement celui de JSON.stringify (format historique inchangé)', () => {
    const texte = encodeSnapshot(snapshot)
    assert.equal(typeof texte, 'string')
    assert.equal(texte, JSON.stringify(snapshot))
  })

  it('2. aller-retour : decodeSnapshot(encodeSnapshot(x)) rend x, accents et imbrication compris', () => {
    assert.deepEqual(decodeSnapshot(encodeSnapshot(snapshot)), snapshot)
  })

  it('3. decodeSnapshot accepte les 3 formes que rendent les moteurs : string (fichier), Buffer (redis), objet String (pilote SQL exotique)', () => {
    const texte = encodeSnapshot(snapshot)
    assert.deepEqual(decodeSnapshot(texte), snapshot)
    assert.deepEqual(decodeSnapshot(Buffer.from(texte)), snapshot)
    assert.deepEqual(decodeSnapshot(new String(texte)), snapshot)
  })

  it('4. entrée illisible : decodeSnapshot LÈVE (l\'adaptateur journalise et saute l\'entrée, jamais un crash de boot)', () => {
    assert.throws(() => decodeSnapshot('{pas du json'), SyntaxError)
    assert.throws(() => decodeSnapshot(undefined), SyntaxError)   // String(undefined) = 'undefined', invalide
  })

  // comportement HISTORIQUE, conservé tel quel par la mutualisation (l'ancien code faisait déjà
  // JSON.parse(String(x))) : une colonne SQL à NULL donne la chaîne 'null', qui est du JSON VALIDE —
  // l'entrée n'est donc PAS sautée, elle remonte avec `data: null`. Verrouillé ici pour que le jour
  // où on décide de la sauter, ce soit une décision visible et pas un effet de bord
  it('5. valeur nulle (colonne SQL à NULL) : rend null SANS lever — hérité, l\'entrée n\'est pas sautée', () => {
    assert.equal(decodeSnapshot(null), null)
  })
})
