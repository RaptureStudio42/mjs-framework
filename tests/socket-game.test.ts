// Tests du CLIENT réactif sock.game (mjs_game.ts) contre un VRAI serveur MJS-Server (MemoryTransport)
// — même patron que tests/mjs-server-core.test.ts/mjs-server-matchmaking.test.ts (`new Function('µ',
// src)(stub)`, MemoryTransport, morpion de référence). Ici le µ.state STUB est un peu plus riche
// que les autres tests socket-* (Proxy set MINIMAL + Set d'abonnés par clé, cf. reactiveState
// ci-dessous) : nécessaire pour PROUVER qu'une mutation du store déclenche un abonné réactif (une
// simple relecture après coup, comme le fait le reste de la suite socket-*, ne le prouverait pas).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsServer } from '../src/mjs-server/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsServerApp } from '../src/mjs-server/index.js'
import type { MjsWsOptions } from '../src/mjs-ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const socketSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')
const gameSrc   = readFileSync(join(__dirname, '../src/runtime/mjs_game.ts'), 'utf8')
// CONCATÉNÉS dans UN seul new Function — mjs_game.ts référence `MjsSocket` en identifiant NU (pas
// `µ.MjsSocket` : mjs_socket.ts ne l'expose pas), donc même patron que la concaténation RÉELLE du
// bundler (src/bundler/index.ts, ordre canonique 'mjs_socket.ts' PUIS 'mjs_game.ts').
const clientSrc = socketSrc + '\n' + gameSrc

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// store réactif MINIMAL (Proxy set + Set d'abonnés PAR CLÉ) — remplace le stub plat `state: (i) =>
// ({...i})` des autres tests socket-* : celui-ci ne prouve qu'une RELECTURE après coup, alors que
// il faut prouver qu'une mutation déclenche un VRAI abonné réactif. Le contrat PUBLIC
// vu par mjs_game.ts (lecture/écriture de propriétés ordinaires, aucune API `.subscribe` connue de
// lui) reste identique à la vraie µ.state (mjs_runes.ts) — seul le mécanisme de notification est
// simplifié ici (Set explicite par clé + watchKey() ci-dessous, plutôt que le tracking implicite
// par composant actif µ._mjs_initStack/µ.activeComponent, hors de portée d'un test Node sans DOM).
const __gameStoreSubs = new WeakMap<object, Map<string, Set<() => void>>>()
function reactiveState(init: any): any {
  const target: any = { ...init }
  const subs = new Map<string, Set<() => void>>()
  const proxy = new Proxy(target, {
    set(obj, key, value) {
      obj[key as string] = value
      const s = subs.get(key as string)
      if (s) s.forEach(fn => fn())
      return true
    },
    deleteProperty(obj, key) {
      delete obj[key as string]
      return true
    },
  })
  __gameStoreSubs.set(proxy, subs)
  return proxy
}
function watchKey(store: any, key: string, fn: () => void): void {
  const subs = __gameStoreSubs.get(store)
  if (!subs) return
  let s = subs.get(key)
  if (!s) { s = new Set(); subs.set(key, s) }
  s.add(fn)
}

function makeMu(): any {
  const µ: any = { state: reactiveState, error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsServerApp }> {
  const transport = new MemoryTransport()
  const app = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, ...opts })
  await app.listen()
  return { transport, app }
}

// morpion de référence SIMPLIFIÉ (pas de phase 'waiting'/prêt-check — hors sujet ICI, déjà couvert
// par tests/mjs-server-core.test.ts) : tour par tour dès les 2 sièges occupés, vue qui masque un
// champ privé par joueur (secrets), + un move 'finir' pour tester end() sans logique de victoire.
function declarerMorpion(app: MjsServerApp): void {
  app.game('morpion', {
    seats: 2,
    code: true,
    seatTtl: 300,
    emptyTtl: 5000,
    state: () => ({ grille: Array(9).fill(null), lettres: {}, secrets: {} }),
    moves: {
      jouer: (game: any, player: any, p: any) => {
        if (game.state.grille[p.i] != null) throw new Error('case occupée')
        game.state.grille[p.i] = game.state.lettres[player.id]
        game.next()
        return { ok: true }
      },
      finir: (game: any) => { game.end({ gagnant: 'x' }) },
    },
    view: (game: any, player: any) => {
      const { secrets, ...pub } = game.state
      return { ...pub, monSecret: player ? secrets[player.id] : null }
    },
    turns: { order: 'roundrobin' },
    hooks: {
      onJoin: (game: any, player: any) => {
        const lettre = game.players.filter(Boolean).length === 1 ? 'X' : 'O'
        game.state.lettres[player.id] = lettre
        game.state.secrets[player.id] = 'secret-de-' + lettre
        if (game.players.filter(Boolean).length === game.def.seats) game.next()
      },
    },
  })
}

// variante : MÊME morpion, mais def.deltas:true + un move `retirer` qui SUPPRIME une clé
// (jamais exercé par le morpion normal, cf. test j) — champ `marques` dédié à ce seul usage, ABSENT
// du morpion classique (sans incidence sur les tests a-h : deux types de jeu SÉPARÉS, comparés par
// leurs stores finaux sur deux parties jouées pareil).
function declarerMorpionDelta(app: MjsServerApp): void {
  app.game('morpion-delta', {
    seats: 2,
    code: true,
    seatTtl: 300,
    emptyTtl: 5000,
    deltas: true,
    state: () => ({ grille: Array(9).fill(null), lettres: {}, secrets: {}, marques: {} }),
    moves: {
      jouer: (game: any, player: any, p: any) => {
        if (game.state.grille[p.i] != null) throw new Error('case occupée')
        game.state.grille[p.i] = game.state.lettres[player.id]
        game.state.marques[String(p.i)] = player.id
        game.next()
        return { ok: true }
      },
      retirer: (game: any, player: any, p: any) => { delete game.state.marques[String(p.i)]; return { ok: true } },
      finir:   (game: any) => { game.end({ gagnant: 'x' }) },
    },
    view: (game: any, player: any) => {
      const { secrets, ...pub } = game.state
      return { ...pub, monSecret: player ? secrets[player.id] : null }
    },
    turns: { order: 'roundrobin' },
    hooks: {
      onJoin: (game: any, player: any) => {
        const lettre = game.players.filter(Boolean).length === 1 ? 'X' : 'O'
        game.state.lettres[player.id] = lettre
        game.state.secrets[player.id] = 'secret-de-' + lettre
        if (game.players.filter(Boolean).length === game.def.seats) game.next()
      },
    },
  })
}

// rétrécissement de tableau (cf. mjs-server/game.ts::deepDiff) — jeu MINIMAL 1 place
// dont la vue porte un SEUL champ `items` (tableau) : `retirer` le fait RÉTRÉCIR de DEUX éléments
// d'un coup (pas un seul) — un retrait UNIQUE en queue serait accidentellement « rattrapé » par la
// seule défense client (une suite de x:1 en queue, chacun splicé, reste correcte par coïncidence
// pour UN retrait) ; DEUX x:1 appliqués en séquence par `.splice` DÉSYNCHRONISENT leurs propres
// index (le 2e splice vise une position déjà décalée par le 1er) — seul le remplacement EN BLOC
// côté serveur (le vrai correctif, cause racine) reste correct dans ce cas, cf. test l plus bas.
// Jeu tiers dédié, sans incidence sur morpion/morpion-delta (cf. commentaire de declarerMorpionDelta).
function declarerListeDelta(app: MjsServerApp): void {
  app.game('liste-delta', {
    seats: 1,
    code: true,
    deltas: true,
    // `bulk` = champ INERTE (jamais modifié) — donne à la vue assez de « bulk » pour que le delta
    // (2 ops sur `items`) reste SOUS le seuil de repli 60% de _buildFrame (MÊME nécessité que
    // le 2e joueur de test g, mjs-server-action.test.ts) : sans lui, un delta minuscule sur une vue
    // minuscule déclencherait TOUJOURS le repli vue complète — le test ne prouverait alors RIEN sur
    // deepDiff (constaté : sans `bulk`, le test l reste vert même serveur non corrigé).
    state: () => ({ items: ['a', 'b', 'c', 'd'], bulk: 'remplissage-'.repeat(10) }),
    moves: {
      retirer: (game: any) => { game.state.items.pop(); game.state.items.pop(); return { ok: true } },
    },
    view: (game: any) => ({ items: game.state.items, bulk: game.state.bulk }),
  })
}

/** MÊME rôle qu'asseoirDeux, paramétrée par TYPE de jeu (morpion classique ET morpion-delta
 *  cohabitent dans ce fichier) — asseoirDeux (non touchée) reste dédiée aux tests a-h existants. */
async function asseoirDeuxType(transport: MemoryTransport, type: string): Promise<{ sx: any; so: any; hx: any; ho: any }> {
  const µx = makeClient(transport)
  const sx = µx.socket('memory://x-' + type, { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
  const hx = sx.game(type)
  await tick()
  const µo = makeClient(transport)
  const so = µo.socket('memory://o-' + type, { auth: () => ({ id: 'o' }), reconnect: { enabled: false } })
  const ho = so.game(type)
  await tick()
  return { sx, so, hx, ho }
}

/** connecte 2 clients authentifiés (identités STABLES — requis pour resync) et les fait asseoir
 *  via la file publique — X (siège 0) apprend son siège en attente PUIS en-jeu (poussée µgame:start,
 *  déjà en file quand O la complète), O (siège 1) l'apprend directement dans l'ack de sa requête. */
async function asseoirDeux(transport: MemoryTransport): Promise<{ sx: any; so: any; hx: any; ho: any }> {
  const µx = makeClient(transport)
  const sx = µx.socket('memory://x', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
  const hx = sx.game('morpion')
  await tick()
  const µo = makeClient(transport)
  const so = µo.socket('memory://o', { auth: () => ({ id: 'o' }), reconnect: { enabled: false } })
  const ho = so.game('morpion')
  await tick()
  return { sx, so, hx, ho }
}

describe('sock.game — client réactif du protocole µgame:* (morpion, 2 clients, vrai serveur MJS-Server)', () => {
  it("a. appariement par la file : le 1er voit sa position, les DEUX passent en-jeu à l'arrivée du 2e (stores remplis)", async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app)
    const µx = makeClient(transport)
    const sx = µx.socket('memory://x', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    const hx = sx.game('morpion')
    assert.equal(hx.state.status, 'waiting')
    await tick()
    assert.equal(hx.state.queue, 1, 'seul en file : position 1')
    assert.equal(hx.state.gameId, null)

    const µo = makeClient(transport)
    const so = µo.socket('memory://o', { auth: () => ({ id: 'o' }), reconnect: { enabled: false } })
    const ho = so.game('morpion')
    await tick()

    assert.equal(hx.state.status, 'playing')
    assert.equal(ho.state.status, 'playing')
    assert.equal(hx.state.seat, 0)
    assert.equal(ho.state.seat, 1)
    assert.equal(hx.state.gameId, ho.state.gameId)
    assert.deepEqual(hx.state.grille, Array(9).fill(null))
    await app.stop()
  })

  it('b. coup valide : LES DEUX stores se mettent à jour (vue secrète non fuitée) — et prouve la réactivité (abonné déclenché par la mutation)', async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app)
    const { hx, ho } = await asseoirDeux(transport)
    assert.equal(hx.state.secrets, undefined, 'le champ brut secrets (tous les joueurs) ne doit jamais fuiter')
    assert.notEqual(hx.state.monSecret, ho.state.monSecret)

    let fired = false
    watchKey(hx.state, 'grille', () => { fired = true })

    const result = await hx.move('jouer', { i: 4 })
    assert.deepEqual(result, { ok: true })
    await tick()

    assert.equal(hx.state.grille[4], 'X')
    assert.equal(ho.state.grille[4], 'X', 'grille PARTAGÉE — les deux la voient identique')
    assert.ok(fired, "la mutation du store (grille réécrite par _syncGameStore) doit avoir déclenché l'abonné réactif")
    await app.stop()
  })

  it('c. coup hors tour : Promise rejetée, store INTACT', async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    declarerMorpion(app)
    const { ho } = await asseoirDeux(transport)   // tour établi à X (siège 0) dès les 2 sièges occupés
    const grilleAvant = ho.state.grille.slice()
    await assert.rejects(ho.move('jouer', { i: 0 }), (e: any) => /tour/i.test(String(e)))
    assert.deepEqual(ho.state.grille, grilleAvant, 'aucune mutation après un refus')
    await app.stop()
  })

  it('d. seq : un µgame:state ANCIEN rejoué à la main (injecté sur le vrai faux WebSocket) est ignoré', async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app)
    const { sx, hx } = await asseoirDeux(transport)
    await hx.move('jouer', { i: 0 })
    await tick()
    const seqAvant = hx.state.seq
    const grilleAvant = hx.state.grille.slice()
    assert.ok(seqAvant >= 1)

    // injection À LA MAIN d'une trame µgame:state PÉRIMÉE (seq === dernier vu, donc <=) — seule
    // façon de forcer ce cas contre un VRAI serveur, qui n'en renverrait jamais un de lui-même
    // (même technique que mjs-server-matchmaking.test.ts test 5/6/7 : `sA._mjs_ws...` en accès direct).
    sx._mjs_ws.onmessage({ data: JSON.stringify({
      t: 'µgame:state',
      p: { game: hx.state.gameId, view: { grille: ['PIRATÉ'] }, phase: null, turn: 'x', seq: seqAvant },
    }) })

    assert.equal(hx.state.seq, seqAvant, 'le seq ne doit pas bouger')
    assert.deepEqual(hx.state.grille, grilleAvant, 'le state périmé (seq <= dernier vu) ne doit PAS avoir été appliqué')
    await app.stop()
  })

  it('e. reconnexion : coupure (backoff [50], JAMAIS [0] — piège connu qui rend un test vert pour de mauvaises raisons) → resync AUTO, store fidèle, la partie continue', async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app)
    const µx = makeClient(transport)
    const sx = µx.socket('memory://x', { auth: () => ({ id: 'x' }), reconnect: { backoff: [50], jitter: 0 } })
    const hx = sx.game('morpion')
    const µo = makeClient(transport)
    const so = µo.socket('memory://o', { auth: () => ({ id: 'o' }), reconnect: { enabled: false } })
    const ho = so.game('morpion')
    await tick()
    assert.equal(hx.state.status, 'playing')
    const storeRef = hx.state

    await hx.move('jouer', { i: 4 })   // confirme X (sort de la fenêtre seatTtl) + tour → O
    await tick()

    sx._mjs_ws.close(1006, 'coupure simulée')
    assert.equal(sx.state, 'reconnecting')

    await ho.move('jouer', { i: 0 })   // O joue PENDANT que X est coupé
    await tick(200)   // > backoff 50ms — laisse la reconnexion + µ:hello/µ:welcome + resync auto se dérouler

    assert.equal(sx.state, 'open', 'le socket doit avoir repris tout seul')
    assert.equal(hx.state.status, 'playing')
    assert.equal(hx.state, storeRef, "MÊME référence de store — un template lié dessus n'a rien à re-souscrire")
    assert.equal(hx.state.seat, 0, 'siège retrouvé après reconnexion (identité stable)')
    assert.equal(hx.state.grille[4], 'X')
    assert.equal(hx.state.grille[0], 'O', 'coup joué PENDANT la coupure : store rechargé fidèlement par le resync')

    const ack = await hx.move('jouer', { i: 1 })   // preuve que la partie continue : tour revenu à X
    assert.deepEqual(ack, { ok: true })
    await app.stop()
  })

  it('f. partie privée par code : créer → code dans le store ; rejoindre par code ; code inconnu → statut erreur', async () => {
    const { transport, app } = await startApp({ onLog: () => {} })   // le refus de code (ZZZZZ) est INTENTIONNEL
    declarerMorpion(app)
    const µx = makeClient(transport)
    const sx = µx.socket('memory://x', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    const hx = sx.game('morpion', { code: true })
    await tick()
    assert.equal(hx.state.status, 'playing', "le fondateur est assis d'office (1/2), la partie attend juste le 2e")
    assert.ok(/^[A-Z2-9]{5}$/.test(hx.state.code), `code court attendu, reçu : ${hx.state.code}`)

    const µo = makeClient(transport)
    const so = µo.socket('memory://o', { auth: () => ({ id: 'o' }), reconnect: { enabled: false } })
    const ho = so.game('morpion', { code: hx.state.code })
    await tick()
    assert.equal(ho.state.status, 'playing')
    assert.equal(ho.state.gameId, hx.state.gameId)
    assert.equal(ho.state.code, hx.state.code)

    const µz = makeClient(transport)
    const sz = µz.socket('memory://z', { auth: () => ({ id: 'z' }), reconnect: { enabled: false } })
    const hz = sz.game('morpion', { code: 'ZZZZZ' })
    await tick()
    assert.equal(hz.state.status, 'error')
    assert.ok(/code inconnu/i.test(hz.state.error), `message d'erreur attendu, reçu : ${hz.state.erreur}`)
    await app.stop()
  })

  it('g. end : statut finie + resultat, chez les DEUX joueurs', async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app)
    const { hx, ho } = await asseoirDeux(transport)
    const finsX: any[] = []; const finsO: any[] = []
    hx.on('end', (p: any) => finsX.push(p))
    ho.on('end', (p: any) => finsO.push(p))

    await hx.move('finir', {})
    await tick()

    assert.equal(hx.state.status, 'finished')
    assert.deepEqual(hx.state.result, { gagnant: 'x' })
    assert.equal(ho.state.status, 'finished')
    assert.deepEqual(ho.state.result, { gagnant: 'x' })
    assert.equal(finsX.length, 1)
    assert.equal(finsO.length, 1)
    await app.stop()
  })

  it("h. leave : quittée chez soi (immédiat, optimiste), l'autre reçoit left", async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app)
    const { hx, ho } = await asseoirDeux(transport)
    const lefts: any[] = []
    ho.on('left', (p: any) => lefts.push(p))

    hx.leave()
    assert.equal(hx.state.status, 'left', 'statut posé SYNCHRONE, avant même la moindre réponse serveur')
    await tick()

    assert.equal(lefts.length, 1)
    assert.equal(lefts[0].seat, 0)
    await app.stop()
  })

  it('i. deltas — un jeu def.deltas:true joué de bout en bout converge EXACTEMENT vers le même store client qu\'en mode vue complète', async () => {
    async function jouerEtRecupererStore(type: string): Promise<any> {
      const { transport, app } = await startApp()
      if (type === 'morpion-delta') { declarerMorpionDelta(app) } else { declarerMorpion(app) }
      const { hx, ho } = await asseoirDeuxType(transport, type)
      // séquence de coups FIXE, IDENTIQUE dans les deux modes
      await hx.move('jouer', { i: 4 }); await tick()
      await ho.move('jouer', { i: 0 }); await tick()
      await hx.move('jouer', { i: 8 }); await tick()
      await ho.move('jouer', { i: 1 }); await tick()
      await hx.move('jouer', { i: 2 }); await tick()
      const store = { grille: hx.state.grille, lettres: hx.state.lettres, monSecret: hx.state.monSecret }
      await app.stop()
      return store
    }

    const storeDelta   = await jouerEtRecupererStore('morpion-delta')
    const storeComplet = await jouerEtRecupererStore('morpion')
    assert.notDeepEqual(storeDelta.grille, Array(9).fill(null), 'sanity — la partie a bien progressé (pas juste deux grilles vides identiques par vacuité)')
    assert.deepEqual(storeDelta, storeComplet, 'même séquence de coups → store client IDENTIQUE, que le serveur envoie des deltas ou des vues complètes')
  })

  it('j. deltas — suppression de clé (x:1) appliquée côté client : retrait EFFECTIF, pas juste une valeur undefined', async () => {
    const { transport, app } = await startApp()
    declarerMorpionDelta(app)
    const { hx, ho } = await asseoirDeuxType(transport, 'morpion-delta')

    await hx.move('jouer', { i: 4 })
    await tick()
    assert.equal(hx.state.marques['4'], 'x', 'sanity — la clé existe avant le retrait')

    await ho.move('jouer', { i: 0 })   // tour par tour (roundrobin) : repasse le tour à X avant son 2e coup
    await tick()

    await hx.move('retirer', { i: 4 })
    await tick()
    assert.equal(Object.prototype.hasOwnProperty.call(hx.state.marques, '4'), false, 'la clé doit avoir disparu du store (x:1 → delete), pas rester en `undefined`')
    await app.stop()
  })

  it('k. deltas — resync après coupure reste correct : la reconnexion renvoie TOUJOURS une vue complète (jamais un delta périmé), le store converge malgré la coupure', async () => {
    const { transport, app } = await startApp()
    declarerMorpionDelta(app)
    const µx = makeClient(transport)
    const sx = µx.socket('memory://kx', { auth: () => ({ id: 'x' }), reconnect: { backoff: [50], jitter: 0 } })
    const hx = sx.game('morpion-delta')
    const µo = makeClient(transport)
    const so = µo.socket('memory://ko', { auth: () => ({ id: 'o' }), reconnect: { enabled: false } })
    const ho = so.game('morpion-delta')
    await tick()
    assert.equal(hx.state.status, 'playing')

    await hx.move('jouer', { i: 4 })
    await tick()

    sx._mjs_ws.close(1006, 'coupure simulée')
    assert.equal(sx.state, 'reconnecting')

    await ho.move('jouer', { i: 0 })   // O joue PENDANT que X est coupé
    await tick(200)   // > backoff 50ms — laisse la reconnexion + resync auto se dérouler

    assert.equal(sx.state, 'open', 'le socket doit avoir repris tout seul')
    assert.equal(hx.state.status, 'playing')
    assert.equal(hx.state.grille[4], 'X')
    assert.equal(hx.state.grille[0], 'O', 'coup joué PENDANT la coupure : store rechargé fidèlement par le resync (vue COMPLÈTE, jamais un delta périmé)')

    const ack = await hx.move('jouer', { i: 1 })   // preuve que la partie continue normalement après resync
    assert.deepEqual(ack, { ok: true })
    await app.stop()
  })

  it("l. deltas — tableau qui RÉTRÉCIT : le client reconstruit la BONNE longueur, pas un trou/undefined en queue (cf. mjs-server/game.ts::deepDiff)", async () => {
    const { transport, app } = await startApp()
    declarerListeDelta(app)
    const µx = makeClient(transport)
    const sx = µx.socket('memory://ld', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    const hx = sx.game('liste-delta', { code: true })
    await tick()
    assert.deepEqual(hx.state.items, ['a', 'b', 'c', 'd'], 'sanity — vue complète initiale (4 éléments)')

    const frames: any[] = []
    sx.on('µgame:state', (p: any) => frames.push(p))
    await hx.move('retirer', {})   // items passe de 4 à 2 éléments — VRAI flux socket, VRAI _applyDeltaOps
    await tick()

    assert.ok(frames.length >= 1, 'au moins une diffusion attendue après le retrait')
    assert.equal(hx.state.items.length, 2, 'la longueur doit refléter le rétrécissement (2), pas rester à 4 avec des trous/résidus')
    assert.deepEqual(hx.state.items, ['a', 'b'], 'contenu exact — aucun `undefined`/résidu en queue')
    assert.equal(1 in hx.state.items, true, "l'index 1 doit être un VRAI élément ('b'), pas un trou")
    assert.equal(2 in hx.state.items, false, "l'index 2 ne doit plus exister du tout (pas même comme trou laissé par delete)")
    await app.stop()
  })

  it("m. deltas — défense en profondeur client : un `x:1` qui viserait quand même un index de tableau splice au lieu de delete (jamais émis par le serveur depuis le fix, cf. test l — ici injecté à la main comme le test d)", async () => {
    const { transport, app } = await startApp()
    declarerListeDelta(app)
    const µx = makeClient(transport)
    const sx = µx.socket('memory://ldx', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    const hx = sx.game('liste-delta', { code: true })
    await tick()
    assert.deepEqual(hx.state.items, ['a', 'b', 'c', 'd'])
    const seqAvant = hx.state.seq

    // injection À LA MAIN d'UN SEUL op `x:1` ciblant un index de tableau — MÊME technique que le
    // test d (accès direct à `sx._mjs_ws`) : le VRAI serveur n'émet plus jamais cette forme depuis le
    // fix (cf. deepDiff), mais le client doit rester correct si elle arrivait quand même (défense
    // en profondeur À ELLE SEULE, cf. commentaire de declarerListeDelta : garantie pour UN op, pas
    // pour une séquence — d'où le test l séparé qui, lui, prouve le VRAI correctif serveur).
    sx._mjs_ws.onmessage({ data: JSON.stringify({
      t: 'µgame:state',
      p: { game: hx.state.gameId, delta: [{ p: 'items.0', x: 1 }], phase: hx.state.phase, turn: hx.state.turn, seq: seqAvant + 1 },
    }) })

    assert.deepEqual(hx.state.items, ['b', 'c', 'd'], 'splice (pas delete) : le trou est comblé, pas de `undefined` en tête')
    assert.equal(hx.state.items.length, 3)
    await app.stop()
  })
})
