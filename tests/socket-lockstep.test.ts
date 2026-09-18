// Tests CLIENT+SERVEUR du lockstep déterministe — DEUX vrais
// clients µ.socket + µ.lockstep (mjs_socket.ts + mjs_game.ts + mjs_det.ts + mjs_lockstep.ts,
// CONCATÉNÉS dans le MÊME `new Function`, ordre CANONIQUE du bundler) contre un VRAI serveur MJS-Server
// (MemoryTransport), MÊME patron que tests/socket-netcode.test.ts. Couvre : les deux clients reçoivent
// la MÊME séquence d'ordres, leurs états locaux CONVERGENT bit-à-bit (hash identique), µ.random(seed)
// donne la même séquence aux deux, une divergence FORCÉE (appliquer volontairement différent d'un
// client — simule un bug/cheat/désync, cf. commentaire du test dédié) est détectée PAR QUORUM
// (anti-triche, cf. mjs-server/lockstep.ts — le test dédié utilise 3 clients, une majorité
// absolue à 2 étant structurellement indécidable, cf. son commentaire), une reconnexion
// (µgame:resync) rejoue le journal et ramène l'état au même résultat.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsServer } from '../src/mjs-server/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsServerApp, MjsServerOptions } from '../src/mjs-server/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = ['mjs_socket.ts', 'mjs_game.ts', 'mjs_det.ts', 'mjs_lockstep.ts']
  .map(f => readFileSync(join(__dirname, '../src/runtime/'+ f), 'utf8'))
  .join('\n')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

async function startApp(opts: MjsServerOptions = {}): Promise<{ transport: MemoryTransport; app: MjsServerApp }> {
  const transport = new MemoryTransport()
  const app = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, ...opts })
  await app.listen()
  return { transport, app }
}

// garde `µ` (pas seulement le socket) — MÊME nécessité que tests/socket-netcode.test.ts : µ.lockstep
// est posé sur CE `µ`-là, propre à chaque client
async function connecterAvecMu(transport: MemoryTransport, id: string): Promise<{ µ: any; sock: any }> {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  const µ = makeMu()
  const sock = µ.socket('memory://'+ id, { auth: () => ({ id }), reconnect: { enabled: false } })
  sock.connect()
  await tick()
  return { µ, sock }
}

function declarerJeuLockstep(app: MjsServerApp, overrides: Record<string, any> = {}): void {
  app.game('rts-lockstep', { mode: 'lockstep', seats: 2, code: true, tick: 40, seatTtl: 300, emptyTtl: 300, moves: {}, ...overrides })
}

// espionne les trames µgame:hash SORTANTES (patch de sock.send, cf. commentaire du test « converge »)
function espionnerHash(sock: any): any[] {
  const vus: any[] = []
  const original = sock.send.bind(sock)
  sock.send = function(type: string, payload: any, opts?: any) {
    if (type === 'µgame:hash') vus.push(payload)
    return original(type, payload, opts)
  }
  return vus
}

// installe 2 clients dans la MÊME partie privée (code), chacun avec son propre `appliquer` (permet de
// simuler une divergence, cf. le test dédié) — `µ.lockstep` est appelé JUSTE APRÈS `sock.game()`
// (synchrone, AVANT tout aller-retour réseau), cf. mjs_lockstep.ts tête de fichier.
async function deuxClientsLockstep(transport: MemoryTransport, appliquerX: (etat: any, ordre: any) => void, appliquerY: (etat: any, ordre: any) => void, every = 4): Promise<{ sockx: any; socky: any; partieX: any; partieY: any; etatX: any; etatY: any }> {
  const { µ: µx, sock: sockx } = await connecterAvecMu(transport, 'x')
  const partieX = sockx.game('rts-lockstep', { code: true })
  const etatX = µx.lockstep(partieX, { state0: () => ({ compte: 0 }), apply: appliquerX, every })
  await tick(30)
  const code = partieX.state.code
  const { µ: µy, sock: socky } = await connecterAvecMu(transport, 'y')
  const partieY = socky.game('rts-lockstep', { code })
  const etatY = µy.lockstep(partieY, { state0: () => ({ compte: 0 }), apply: appliquerY, every })
  await tick(30)
  return { sockx, socky, partieX, partieY, etatX, etatY }
}

const appliquerAjouter = (etat: any, ordre: any) => { if (ordre.move === 'ajouter') etat.compte += ordre.p.n }

describe("µ.lockstep — client+serveur, 2 vrais clients", () => {
  it('a. les DEUX clients reçoivent la MÊME séquence d\'ordres (µgame:orders identiques, même tick, même contenu)', async () => {
    const { transport, app } = await startApp()
    declarerJeuLockstep(app)
    const recusX: any[] = [], recusY: any[] = []
    const { sockx: _sockx, socky: _socky, partieX, partieY } = await deuxClientsLockstep(transport, appliquerAjouter, appliquerAjouter)
    partieX.on('orders', (f: any) => recusX.push(f))
    partieY.on('orders', (f: any) => recusY.push(f))
    await partieX.move('ajouter', { n: 3 })
    await partieY.move('ajouter', { n: 4 })
    await tick(90)
    const avecOrdresX = recusX.filter(f => f.orders.length > 0)
    const avecOrdresY = recusY.filter(f => f.orders.length > 0)
    assert.ok(avecOrdresX.length >= 1)
    assert.deepEqual(avecOrdresX, avecOrdresY, 'strictement la MÊME séquence de trames pour les deux clients')
    await app.stop()
  })

  it('b. états locaux CONVERGENT bit-à-bit : mêmes ordres appliqués dans le même ordre ⇒ hashs finaux IDENTIQUES (silence, aucune divergence)', async () => {
    const { transport, app } = await startApp()
    const divergences: any[] = []
    declarerJeuLockstep(app, { onDivergence: (_p: any, info: any) => divergences.push(info) })
    const { sockx, socky, partieX, partieY, etatX, etatY } = await deuxClientsLockstep(transport, appliquerAjouter, appliquerAjouter, 2)
    const hashesX = espionnerHash(sockx), hashesY = espionnerHash(socky)
    await partieX.move('ajouter', { n: 10 })
    await partieY.move('ajouter', { n: -3 })
    await tick(150)
    assert.equal(etatX.compte, etatY.compte, 'même valeur numérique des deux côtés')
    assert.ok(hashesX.length >= 1 && hashesY.length >= 1, 'au moins un hash annoncé de chaque côté')
    // compare les hashs au MÊME tick — même valeur (convergence bit-à-bit)
    const tickCommun = hashesX.map(h => h.tick).find(t => hashesY.some(h => h.tick === t))
    assert.ok(tickCommun != null, 'au moins un tick de hash commun aux deux clients')
    assert.equal(hashesX.find(h => h.tick === tickCommun)!.h, hashesY.find(h => h.tick === tickCommun)!.h)
    assert.equal(divergences.length, 0, 'hashs concordants ⇒ silence, aucune divergence signalée')
    await app.stop()
  })

  it('c. µ.random(seed) donne la MÊME séquence aux deux clients (graine partagée, cf. µgame:start)', async () => {
    const { transport, app } = await startApp()
    declarerJeuLockstep(app)
    const { etatX, etatY } = await deuxClientsLockstep(transport, appliquerAjouter, appliquerAjouter)
    assert.ok(etatX.rng && etatY.rng, 'rng dispo dès la réception du seed (start)')
    const seqX = Array.from({ length: 8 }, () => etatX.rng.next())
    const seqY = Array.from({ length: 8 }, () => etatY.rng.next())
    assert.deepEqual(seqX, seqY)
    await app.stop()
  })

  it("d. divergence par QUORUM (anti-triche) : appliquer volontairement DIFFÉRENT chez un client — simule un bug/cheat/désync → détectée (event + onDivergence), le siège DIVERGENT identifié, JAMAIS la majorité honnête. ADAPTÉ au modèle quorum (cf. mjs-server/lockstep.ts tête de fichier) : à 2 sièges, un désaccord X/Y est un tie 1 contre 1 qui n'atteint JAMAIS la majorité absolue floor(2/2)+1=2 (indécidable SANS arbitre extérieur — cf. tests/mjs-server-lockstep-anti-triche.test.ts pour ce cas précis, qui ne déclenche RIEN) ; 3e client Z HONNÊTE ajouté ICI pour qu'une vraie majorité (X+Z) existe et isole Y.", async () => {
    const { transport, app } = await startApp()
    const divergences: any[] = []
    declarerJeuLockstep(app, { seats: 3, onDivergence: (_p: any, info: any) => divergences.push(info) })
    // Y applique un calcul VOLONTAIREMENT différent (+1 en trop) — l'état local de Y S'ÉCARTE de X
    // après le MÊME ordre reçu : simule une divergence sans avoir besoin de poker un état interne
    // privé (µ.lockstep n'expose que le store RÉACTIF, jamais l'objet `etat` interne mutable, cf.
    // mjs_lockstep.ts — cette technique atteint le MÊME effet observable : deux clients qui ont vu les
    // mêmes ordres mais calculé un état différent).
    const appliquerDivergent = (etat: any, ordre: any) => { if (ordre.move === 'ajouter') etat.compte += ordre.p.n + 1 }
    const { sockx: _sockx, socky: _socky, partieX, partieY: _partieY } = await deuxClientsLockstep(transport, appliquerAjouter, appliquerDivergent, 2)
    // 3e siège HONNÊTE (même appliquer que X) — cf. commentaire de tête du test : requis pour qu'une
    // majorité absolue existe à 3 sièges (floor(3/2)+1=2, X+Z l'atteignent, Y reste seul en désaccord)
    const { µ: µz, sock: sockz } = await connecterAvecMu(transport, 'z')
    const code = partieX.state.code
    const partieZ = sockz.game('rts-lockstep', { code })
    µz.lockstep(partieZ, { state0: () => ({ compte: 0 }), apply: appliquerAjouter, every: 2 })
    await tick(30)
    const eventsX: any[] = []
    partieX.on('event', (f: any) => eventsX.push(f))
    await partieX.move('ajouter', { n: 5 })
    await tick(150)
    assert.ok(divergences.length >= 1, 'au moins une divergence détectée par le serveur')
    assert.ok(divergences.every((d: any) => d.suspects.includes('y')), 'le siège DIVERGENT (y) toujours identifié')
    assert.ok(divergences.every((d: any) => !d.suspects.includes('x') && !d.suspects.includes('z')), 'jamais la majorité honnête (x, z) blâmée')
    assert.ok(eventsX.some(e => e.type === 'divergence'), "µgame:event 'divergence' reçu par les clients")
    await app.stop()
  })

  it('e. reconnexion (µgame:resync) : rejeu du journal COMPLET depuis le début → l\'état local revient AU MÊME résultat', async () => {
    const { transport, app } = await startApp()
    declarerJeuLockstep(app)
    const { sockx, partieX, etatX } = await deuxClientsLockstep(transport, appliquerAjouter, appliquerAjouter)
    await partieX.move('ajouter', { n: 7 })
    await tick(90)
    const compteAvant = etatX.compte
    assert.ok(compteAvant >= 7)
    // simule une reconnexion — MÊME chemin client que _mjs_onGameWelcome (cf. mjs_game.ts), déclenché
    // directement plutôt que via une vraie coupure de transport (accès `_`-préfixé volontaire, MÊME
    // esprit que les tests internes de mjs-server-action.test.ts)
    await sockx._mjs_resyncGame(partieX)
    await tick(60)
    assert.equal(etatX.compte, compteAvant, 'après rejeu intégral du journal, résultat identique')
    await app.stop()
  })

  it('f. état local exposé IMMÉDIATEMENT (etat0 amorcé avant tout aller-retour réseau) — pas d\'attente du 1er événement', async () => {
    const { transport, app } = await startApp()
    declarerJeuLockstep(app)
    const { µ, sock } = await connecterAvecMu(transport, 'x')
    const game = sock.game('rts-lockstep', { code: true })
    const etat = µ.lockstep(game, { state0: () => ({ compte: 42 }), apply: appliquerAjouter })
    assert.equal(etat.compte, 42, 'disponible SYNCHRONEMENT, avant toute réponse serveur')
    await tick(60)
    await app.stop()
  })

  it('g. .stop() coupe les abonnements — plus aucune mise à jour de l\'état local après arrêt', async () => {
    const { transport, app } = await startApp()
    declarerJeuLockstep(app)
    const { partieX, etatX } = await deuxClientsLockstep(transport, appliquerAjouter, appliquerAjouter)
    etatX.stop()
    const compteAvant = etatX.compte
    await partieX.move('ajouter', { n: 99 })
    await tick(90)
    assert.equal(etatX.compte, compteAvant, 'aucune mise à jour après .stop()')
    await app.stop()
  })

  it("h. divergence hors mode lockstep : `frame.seed` absent (jeu authoritative) → µ.lockstep reste INERTE, jamais un throw", async () => {
    const { transport, app } = await startApp()
    app.game('classique', { seats: 1, tick: 0, state: () => ({ x: 0 }), moves: { jouer: (p: any) => { p.state.x = 1 } } })
    const { µ, sock } = await connecterAvecMu(transport, 'x')
    const game = sock.game('classique')
    const etat = µ.lockstep(game, { state0: () => ({ compte: 0 }), apply: appliquerAjouter })
    await tick(60)
    assert.equal(etat.compte, 0, 'jamais réinitialisé/rejoué — la partie n\'est pas en mode lockstep')
    await app.stop()
  })
})
