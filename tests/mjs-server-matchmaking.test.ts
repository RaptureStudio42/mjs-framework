// Tests appariement de MJS-Server (file d'attente, code privé, sièges/reconnexion/déconnexion,
// emptyTtl) contre le VRAI client µ.socket — MÊME harnais que tests/mjs-ws-core.test.ts et
// tests/mjs-server-core.test.ts. Jeu de référence ICI : un COMPTEUR minimal (places 2, code activé,
// aucune phase/tour — la mécanique de jeu elle-même est déjà couverte par mjs-server-core.test.ts,
// ce fichier porte sur l'APPARIEMENT). Tous les délais sont volontairement COURTS.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsServer } from '../src/mjs-server/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
// FailureBucket — unit direct, cf. describe('anti-brute-force sur le code…') plus
// bas : MÊME classe que matchmaking.ts::codeFailures, réexportée par l'index public mjs-ws (comme le
// fait déjà tests/mjs-ws-accounts.test.ts pour account:login).
import { FailureBucket } from '../src/mjs-ws/index.js'
import type { MjsServerApp, MjsServerOptions } from '../src/mjs-server/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

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

// identité = hello.auth TEL QUEL (passe-plat, cf. mjs-server-core.test.ts) — requis pour que
// peerIdOf() donne un id STABLE (le point même de plusieurs tests ici : resync, déconnexion)
async function startApp(opts: MjsServerOptions = {}): Promise<{ transport: MemoryTransport; app: MjsServerApp }> {
  const transport = new MemoryTransport()
  const app = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, ...opts })
  await app.listen()
  return { transport, app }
}

function connecter(transport: MemoryTransport, id: string): any {
  const µ = makeClient(transport)
  return µ.socket('memory://' + id, { auth: () => ({ id }), reconnect: { enabled: false } })
}

/** jeu minimal — un seul move 'inc', aucune phase/tour (l'appariement est le sujet de ce fichier) */
function declarerCompteur(app: MjsServerApp, overrides: Record<string, any> = {}): void {
  app.game('compteur', {
    seats: 2,
    code: true,
    seatTtl: 60,
    emptyTtl: 80,
    state: () => ({ n: 0 }),
    moves: { inc: (game: any) => { game.state.n++ } },
    ...overrides,
  })
}

describe('MJS-Server — appariement (file, code, sièges, reconnexion, déconnexion, emptyTtl)', () => {
  it('1. code : créer génère un code court, rejoindre avec ce code assoit le 2e joueur (le fondateur reçoit µgame:start)', async () => {
    const { transport, app } = await startApp()
    declarerCompteur(app)
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    let demarrage: any = null
    sA.on('µgame:start', (p: any) => { demarrage = p })
    const repA = await sA.request('µgame:play', { type: 'compteur', code: true })
    assert.equal(repA.seat, 0)
    assert.equal(typeof repA.code, 'string')
    assert.ok(/^[A-Z2-9]{5}$/.test(repA.code), `code court, alphabet sans ambiguïté typographique, reçu : ${repA.code}`)

    const sB = connecter(transport, 'b'); sB.connect(); await tick()
    const repB = await sB.request('µgame:play', { type: 'compteur', code: repA.code })
    assert.equal(repB.seat, 1)
    assert.equal(repB.game, repA.game)
    await tick()
    assert.ok(demarrage, 'le fondateur doit avoir reçu µgame:start quand le 2e joueur complète la partie')
    assert.equal(demarrage.seat, 0)
    assert.equal(demarrage.game, repA.game)
    await app.stop()
  })

  it("2. code : rejoindre un code inconnu → erreur claire ; un jeu sans def.code refuse toute demande de code", async () => {
    const { transport, app } = await startApp({ onLog: () => {} })   // 2 refus INTENTIONNELS — pas de bruit
    declarerCompteur(app)
    app.game('sans-code', { seats: 2, state: () => ({}), moves: {} })
    const s = connecter(transport, 'a'); s.connect(); await tick()
    await assert.rejects(s.request('µgame:play', { type: 'compteur', code: 'ZZZZZ' }), (e: any) => /code inconnu/i.test(e))
    await assert.rejects(s.request('µgame:play', { type: 'sans-code', code: true }), (e: any) => /parties privées/i.test(e))
    await app.stop()
  })

  it("3. file d'attente publique : { attente } avant complétion, appariement dès que le 2e joueur arrive", async () => {
    const { transport, app } = await startApp()
    declarerCompteur(app)
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    const repA = await sA.request('µgame:play', { type: 'compteur' })
    assert.deepEqual(repA, { queue: 1 })
    const sB = connecter(transport, 'b'); sB.connect(); await tick()
    const repB = await sB.request('µgame:play', { type: 'compteur' })
    assert.equal(repB.seat, 1)
    assert.equal(typeof repB.game, 'string')
    assert.match(repB.game, /^game\d+$/, "id de partie généré — anglais lui aussi, il circule sur le fil et dort dans les instantanés (cf. scripts/migrate-games-fr-to-en.mjs)")
    await app.stop()
  })

  it("4. siège expiré (file) : un joueur appareillé mais jamais confirmé → partie annulée, l'autre prévenu", async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    declarerCompteur(app)
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    const sB = connecter(transport, 'b'); sB.connect(); await tick()
    const finsB: any[] = []
    sB.on('µgame:end', (p: any) => finsB.push(p))
    await sA.request('µgame:play', { type: 'compteur' })   // A en file, puis ne fait plus RIEN (jamais confirmé)
    const repB = await sB.request('µgame:play', { type: 'compteur' })   // B complète le groupe — appelant DIRECT = confirmé d'office
    assert.equal(repB.seat, 1)
    await tick(90)   // seatTtl = 60ms dépassé — A n'a jamais renvoyé la moindre trame
    assert.equal(finsB.length, 1, 'B doit recevoir µgame:end (annulation)')
    assert.equal(finsB[0].result.cancelled, true)
    assert.equal(finsB[0].result.reason, 'seat-expired')
    await app.stop()
  })

  it('5. resync après reconnexion : nouvelle connexion, même identité → vue complète, siège retrouvé, seq cohérent', async () => {
    const { transport, app } = await startApp()
    declarerCompteur(app)
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    const repA = await sA.request('µgame:play', { type: 'compteur', code: true })
    const sB = connecter(transport, 'b'); sB.connect(); await tick()
    await sB.request('µgame:play', { type: 'compteur', code: repA.code })
    await sA.request('µgame:move', { game: repA.game, move: 'inc' })
    await tick()

    sA._mjs_ws.close(1006, 'coupure simulée')
    await tick()
    const sA2 = connecter(transport, 'a')   // MÊME identité ('a'), connexion NEUVE
    sA2.connect(); await tick()
    const resync = await sA2.request('µgame:resync', { game: repA.game })
    assert.equal(resync.seat, 0)
    assert.equal(resync.view.n, 1, 'état conservé après reconnexion')
    assert.equal(typeof resync.seq, 'number')
    assert.ok(resync.seq >= 1)
    await app.stop()
  })

  it('6. déconnexion définitive : marquée dans µgame:seat (connecte:false), le siège reste, la partie survit', async () => {
    const { transport, app } = await startApp()
    declarerCompteur(app)
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    const repA = await sA.request('µgame:play', { type: 'compteur', code: true })
    const sB = connecter(transport, 'b'); sB.connect(); await tick()
    await sB.request('µgame:play', { type: 'compteur', code: repA.code })
    const seats: any[] = []
    sB.on('µgame:seat', (p: any) => seats.push(p))

    sA._mjs_ws.close(1006, 'déconnexion définitive')
    await tick()
    const dernier = seats[seats.length - 1]
    assert.equal(dernier.seats[0].connected, false)
    assert.equal(dernier.seats[1].connected, true)

    // la partie SURVIT — B peut encore jouer (pas de kick automatique v1, tour par tour social)
    const ack = await sB.request('µgame:move', { game: repA.game, move: 'inc' })
    assert.equal(ack.ok, true)
    await app.stop()
  })

  it('7. emptyTtl : plus aucun joueur connecté → partie détruite après le délai (resync et code ensuite : introuvables)', async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    declarerCompteur(app)
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    const repA = await sA.request('µgame:play', { type: 'compteur', code: true })
    sA._mjs_ws.close(1006, 'plus personne')
    await tick()
    await tick(100)   // emptyTtl = 80ms, largement dépassé

    const sA2 = connecter(transport, 'a'); sA2.connect(); await tick()
    await assert.rejects(sA2.request('µgame:resync', { game: repA.game }), (e: any) => /introuvable/i.test(e))
    // le code lui-même doit être libéré — pas de fuite du registre de codes
    await assert.rejects(sA2.request('µgame:play', { type: 'compteur', code: repA.code }), (e: any) => /code inconnu/i.test(e))
    await app.stop()
  })
})

describe('MJS-Server — anti-triche (quota de coups par identité, opts.antiTriche.movesPerIdentity, agrégé sur TOUTES les parties vivantes)', () => {
  function declarerDeuxCases(app: MjsServerApp): void {
    app.game('quota-jeu', {
      seats: 1, code: true, seatTtl: 300, emptyTtl: 5000,
      state: () => ({ n: 0 }),
      moves: { inc: (game: any) => { game.state.n++ } },
    })
  }

  it('une identité qui dépasse le quota CUMULÉ sur 2 parties → les coups au-delà sont rejetés, quelle que soit la partie visée', async () => {
    const { transport, app } = await startApp({ onLog: () => {}, antiCheat: { movesPerIdentity: [3, 10000] } })
    declarerDeuxCases(app)
    const s = connecter(transport, 'bot'); s.connect(); await tick()
    const repA = await s.request('µgame:play', { type: 'quota-jeu', code: true })
    const repB = await s.request('µgame:play', { type: 'quota-jeu', code: true })
    assert.notEqual(repA.game, repB.game, 'bien 2 parties DISTINCTES pour la MÊME identité')

    // 3 coups au total, RÉPARTIS entre les 2 parties — le quota est CUMULÉ, jamais par partie
    await s.request('µgame:move', { game: repA.game, move: 'inc' })
    await s.request('µgame:move', { game: repB.game, move: 'inc' })
    await s.request('µgame:move', { game: repA.game, move: 'inc' })
    // le 4e coup, quelle que soit la partie visée, doit être rejeté (quota [3, 10000ms] dépassé)
    await assert.rejects(s.request('µgame:move', { game: repB.game, move: 'inc' }), (e: any) => /quota/i.test(String(e)))
    await assert.rejects(s.request('µgame:move', { game: repA.game, move: 'inc' }), (e: any) => /quota/i.test(String(e)))
    assert.equal(app.stats().game.rejectedMoves, 2, 'les rejets quota passent par LA MÊME infrastructure anti-triche (journal/stats/onSuspicion)')
    await app.stop()
  })

  it('sous le seuil (réparti sur 2 parties) → tous les coups acceptés, aucun rejet', async () => {
    const { transport, app } = await startApp({ antiCheat: { movesPerIdentity: [10, 10000] } })
    declarerDeuxCases(app)
    const s = connecter(transport, 'ok'); s.connect(); await tick()
    const repA = await s.request('µgame:play', { type: 'quota-jeu', code: true })
    const repB = await s.request('µgame:play', { type: 'quota-jeu', code: true })
    for (let i = 0; i < 3; i++) await s.request('µgame:move', { game: repA.game, move: 'inc' })
    for (let i = 0; i < 3; i++) await s.request('µgame:move', { game: repB.game, move: 'inc' })
    assert.equal(app.stats().game.rejectedMoves, 0)
    await app.stop()
  })

  it('option ABSENTE → aucun contrôle inter-parties, même une identité très active sur plusieurs parties', async () => {
    const { transport, app } = await startApp()   // pas de opts.antiTriche
    declarerDeuxCases(app)
    const s = connecter(transport, 'libre'); s.connect(); await tick()
    const repA = await s.request('µgame:play', { type: 'quota-jeu', code: true })
    const repB = await s.request('µgame:play', { type: 'quota-jeu', code: true })
    for (let i = 0; i < 20; i++) await s.request('µgame:move', { game: repA.game, move: 'inc' })
    for (let i = 0; i < 20; i++) await s.request('µgame:move', { game: repB.game, move: 'inc' })
    assert.equal(app.stats().game.rejectedMoves, 0)
    await app.stop()
  })

  it('validation : opts.antiTriche.movesPerIdentity doit être [n entier ≥ 1, fenêtreMs > 0] ou null/absent', () => {
    const t = () => new MemoryTransport()
    assert.throws(() => mjsServer({ transport: t(), antiCheat: { movesPerIdentity: [0, 1000] as any } }), /movesPerIdentity/)
    assert.throws(() => mjsServer({ transport: t(), antiCheat: { movesPerIdentity: [3, 0] as any } }), /movesPerIdentity/)
    assert.throws(() => mjsServer({ transport: t(), antiCheat: { movesPerIdentity: 'x' as any } }), /movesPerIdentity/)
    assert.doesNotThrow(() => mjsServer({ transport: t(), antiCheat: { movesPerIdentity: null } }))
    assert.doesNotThrow(() => mjsServer({ transport: t() }))
  })

  it('validation : opts.antiCheat.codePerIp doit être [n entier ≥ 1, fenêtreMs > 0] ou null/absent', () => {
    const t = () => new MemoryTransport()
    assert.throws(() => mjsServer({ transport: t(), antiCheat: { codePerIp: [0, 1000] as any } }), /codePerIp/)
    assert.throws(() => mjsServer({ transport: t(), antiCheat: { codePerIp: [3, 0] as any } }), /codePerIp/)
    assert.throws(() => mjsServer({ transport: t(), antiCheat: { codePerIp: 'x' as any } }), /codePerIp/)
    assert.doesNotThrow(() => mjsServer({ transport: t(), antiCheat: { codePerIp: null } }), 'null EXPLICITE désactive le verrou, jamais rejeté')
    assert.doesNotThrow(() => mjsServer({ transport: t() }), 'absent → défaut de matchmaking.ts, jamais rejeté')
  })

  // Le quota agrégé était SUPPRIMÉ dès qu'une identité
  // n'occupait plus aucun siège (nettoyerQuotaIdentiteSiVide), recréé PLEIN au siège suivant : un
  // simple leave+rejoin agissait comme un reset gratuit, défaisant le but anti-farm multi-parties.
  // Corrigé : le bucket SURVIT au leave/rejoin, purgé UNIQUEMENT par TTL = fenêtreMs d'inactivité
  // (cf. purgerQuotasIdentiteExpires, matchmaking.ts).
  describe('rétention du quota par identité (leave/rejoin ne réinitialise plus)', () => {
    it('quota [3, 60000] épuisé → leave → rejoin (partie NEUVE) → le 4e coup reste REFUSÉ', async () => {
      const { transport, app } = await startApp({ onLog: () => {}, antiCheat: { movesPerIdentity: [3, 60000] } })
      declarerDeuxCases(app)
      const s = connecter(transport, 'bruteur'); s.connect(); await tick()
      const repA = await s.request('µgame:play', { type: 'quota-jeu', code: true })
      await s.request('µgame:move', { game: repA.game, move: 'inc' })
      await s.request('µgame:move', { game: repA.game, move: 'inc' })
      await s.request('µgame:move', { game: repA.game, move: 'inc' })   // 3e — épuise le quota [3, 60000]
      await s.request('µgame:leave', { game: repA.game })   // quitte AVANT de tenter le 4e coup

      const repB = await s.request('µgame:play', { type: 'quota-jeu', code: true })   // rejoint une partie NEUVE, MÊME identité
      assert.notEqual(repB.game, repA.game, 'bien une partie NEUVE — pas un simple resync de la précédente')
      await assert.rejects(
        s.request('µgame:move', { game: repB.game, move: 'inc' }),
        (e: any) => /quota/i.test(String(e)),
        'le leave+rejoin ne doit PAS avoir rechargé le quota — 4e coup cumulé, toujours refusé (avant correctif : accepté)',
      )
      assert.equal(app.stats().game.rejectedMoves, 1)
      await app.stop()
    })

    it("non-régression — une identité SOUS le quota qui leave/rejoin normalement n'est pas faussement bloquée", async () => {
      const { transport, app } = await startApp({ antiCheat: { movesPerIdentity: [5, 60000] } })
      declarerDeuxCases(app)
      const s = connecter(transport, 'tranquille'); s.connect(); await tick()
      const repA = await s.request('µgame:play', { type: 'quota-jeu', code: true })
      await s.request('µgame:move', { game: repA.game, move: 'inc' })   // 1 coup sur 5 — largement sous le quota
      await s.request('µgame:leave', { game: repA.game })

      const repB = await s.request('µgame:play', { type: 'quota-jeu', code: true })
      // 4 coups de plus (total cumulé 5 — encore dans le budget) — tous acceptés
      for (let i = 0; i < 4; i++) await s.request('µgame:move', { game: repB.game, move: 'inc' })
      assert.equal(app.stats().game.rejectedMoves, 0, "le leave/rejoin n'a ni consommé ni faussement bloqué le quota restant")
      await app.stop()
    })

    it("anti-fuite — un bucket inactif depuis plus de fenêtreMs redevient PLEIN au prochain accès (purge/recréation TTL, jamais bloqué à vie)", async () => {
      const { transport, app } = await startApp({ onLog: () => {}, antiCheat: { movesPerIdentity: [2, 60] } })   // fenêtre COURTE (60ms) pour un test rapide
      declarerDeuxCases(app)
      const s = connecter(transport, 'idle'); s.connect(); await tick()
      const repA = await s.request('µgame:play', { type: 'quota-jeu', code: true })
      await s.request('µgame:move', { game: repA.game, move: 'inc' })
      await s.request('µgame:move', { game: repA.game, move: 'inc' })   // quota [2, 60ms] épuisé
      await assert.rejects(s.request('µgame:move', { game: repA.game, move: 'inc' }), (e: any) => /quota/i.test(String(e)))

      await tick(90)   // > fenêtreMs (60ms) sans AUCUNE activité — le bucket est GARANTI plein (refill borné à sa capacité)
      const ack = await s.request('µgame:move', { game: repA.game, move: 'inc' })
      assert.equal(
        ack.ok, true,
        "le quota redevient PLEIN après la fenêtre d'inactivité — preuve indirecte que le bucket n'est jamais bloqué à vie ni retenu " +
        "indéfiniment (l'état interne `quotasIdentite` est privé, non observable directement — MÊME limite documentée pour FailureBucket, cf. tests/mjs-ws-accounts.test.ts)",
      )
      await app.stop()
    })
  })
})

// Code de partie privée brute-forçable (alphabet 32^5 ≈
// 33M codes, aucun rempart dédié). Verrou ANTI-BRUTE-FORCE ajouté PAR IP sur les tentatives de join
// par code ÉCHOUÉES (code inexistant), MÊME classe/patron que accounts.ts::account:login
// (FailureBucket, guard.ts::TokenBucket réutilisés tels quels) — défaut TOUJOURS actif (10 échecs/min/IP,
// cf. matchmaking.ts::DEFAULT_CODE_PAR_IP_*), AUCUNE option publique à passer ici (index.ts n'expose
// pas encore `opts.antiCheat.codePerIp`).
describe('MJS-Server — anti-brute-force sur le code de partie privée', () => {
  it("10 tentatives de code faux depuis la MÊME IP → la 11e refusée (lockout), quel que soit le code essayé ensuite", async () => {
    const { transport, app } = await startApp({ onLog: () => {} })   // défaut createMatchmaking = codePerIp [10, 60000]
    declarerCompteur(app)
    const s = connecter(transport, 'attaquant'); s.connect(); await tick()

    for (let i = 0; i < 10; i++) {
      await assert.rejects(
        s.request('µgame:play', { type: 'compteur', code: 'FAUX' + i }),
        (e: any) => /code inconnu/i.test(String(e)),
        `tentative ${i + 1}/10 — encore dans le budget (10), refus NORMAL 'code inconnu'`,
      )
    }
    // 11e tentative — seau [10, 60000] épuisé PAR CETTE tentative même (reclassement immédiat, MÊME
    // contrat que FailureBucket::recordFailure côté accounts.ts) → message DIFFÉRENT, plus 'code inconnu'
    await assert.rejects(
      s.request('µgame:play', { type: 'compteur', code: 'ENCOREFAUX' }),
      (e: any) => /trop de tentatives/i.test(String(e)),
      '11e tentative — lockout, PAS un simple code inconnu de plus',
    )
    // 12e — toujours verrouillée (fenêtre active), même avec un AUTRE code
    await assert.rejects(
      s.request('µgame:play', { type: 'compteur', code: 'ZZZZZ' }),
      (e: any) => /trop de tentatives/i.test(String(e)),
    )
    await app.stop()
  })

  it("un code VALIDE réussit malgré des échecs récents (sous le seuil) et n'est PAS comptabilisé comme un échec", async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    declarerCompteur(app)
    const fondateur = connecter(transport, 'fondatrice'); fondateur.connect(); await tick()
    const repFondateur = await fondateur.request('µgame:play', { type: 'compteur', code: true })

    const s = connecter(transport, 'joueuse'); s.connect(); await tick()
    // 3 échecs — largement SOUS le seuil par défaut (10) — le prochain join valide ne doit pas être bloqué
    for (let i = 0; i < 3; i++) {
      await assert.rejects(s.request('µgame:play', { type: 'compteur', code: 'RATE' + i }), (e: any) => /code inconnu/i.test(String(e)))
    }
    const repJoueuse = await s.request('µgame:play', { type: 'compteur', code: repFondateur.code })
    assert.equal(repJoueuse.seat, 1, 'le code VALIDE réussit — pas de faux-positif de lockout sous le seuil')
    assert.equal(repJoueuse.game, repFondateur.game)

    // le join valide n'a PAS consommé le budget d'échec au-delà de ses 3 échecs réels — 6 échecs de
    // plus (3 + 6 = 9, toujours < 10) doivent encore recevoir 'code inconnu', pas le lockout
    for (let i = 3; i < 9; i++) {
      await assert.rejects(s.request('µgame:play', { type: 'compteur', code: 'RATE' + i }), (e: any) => /code inconnu/i.test(String(e)), `échec ${i + 1}/9 — toujours dans le budget`)
    }
    await app.stop()
  })

  it("un code inconnu suivi d'un code invalide (format) ou 'partie complète' ne pollue pas le compte d'échecs au-delà des VRAIS codes inconnus", async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    declarerCompteur(app)   // places: 2
    const a = connecter(transport, 'a'); a.connect(); await tick()
    const repA = await a.request('µgame:play', { type: 'compteur', code: true })
    const b = connecter(transport, 'b'); b.connect(); await tick()
    await b.request('µgame:play', { type: 'compteur', code: repA.code })   // partie COMPLÈTE (places: 2)

    const c = connecter(transport, 'c'); c.connect(); await tick()
    // 'partie complète' (code RÉEL, juste plein) — PAS un échec de code, ne consomme rien
    await assert.rejects(c.request('µgame:play', { type: 'compteur', code: repA.code }), (e: any) => /complète/i.test(String(e)))
    // code vide — refusé bon marché AVANT toute résolution (handlerPlay), ne consomme rien non plus
    await assert.rejects(c.request('µgame:play', { type: 'compteur', code: '' }), (e: any) => /code invalide/i.test(String(e)))
    // 10 VRAIS codes inconnus ensuite — toujours le comportement normal (budget intact malgré ce qui précède)
    for (let i = 0; i < 10; i++) {
      await assert.rejects(c.request('µgame:play', { type: 'compteur', code: 'X' + i }), (e: any) => /code inconnu/i.test(String(e)))
    }
    await assert.rejects(c.request('µgame:play', { type: 'compteur', code: 'X10' }), (e: any) => /trop de tentatives/i.test(String(e)), 'la 11e tentative de VRAI code inconnu déclenche bien le lockout — comme si rien avant ne comptait')
    await app.stop()
  })

  // MemoryTransport ne fournit JAMAIS deux adresses IP distinctes en test (cf. transport.ts,
  // client.meta.address toujours undefined) — MÊME limite que accounts.ts::account:login, qui
  // teste donc l'isolation PAR CLÉ directement sur FailureBucket (tests 15-17, 30 de
  // tests/mjs-ws-accounts.test.ts) plutôt qu'en bout-en-bout. `codeFailures` (matchmaking.ts) est la
  // MÊME classe, instanciée de la MÊME façon ([capacité, fenêtreMs]) — l'isolation par IP repose sur
  // exactement la même garantie, déjà prouvée ; ce test la reconfirme localement pour ce module.
  it("opts.antiCheat.codePerIp REÇU par matchmaking.ts : [2, 60000] → lockout dès la 3e tentative (au lieu du défaut 10)", async () => {
    const { transport, app } = await startApp({ onLog: () => {}, antiCheat: { codePerIp: [2, 60000] } })
    declarerCompteur(app)
    const s = connecter(transport, 'attaquant-b'); s.connect(); await tick()

    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        s.request('µgame:play', { type: 'compteur', code: 'FAUX' + i }),
        (e: any) => /code inconnu/i.test(String(e)),
        `tentative ${i + 1}/2 — encore dans le budget RÉDUIT (2)`,
      )
    }
    // 3e tentative — seau [2, 60000] déjà épuisé, PLUS PETIT que le défaut [10, 60000] — la preuve
    // que la valeur passée par opts.antiCheat.codePerIp est bien celle appliquée
    await assert.rejects(
      s.request('µgame:play', { type: 'compteur', code: 'ENCOREFAUX' }),
      (e: any) => /trop de tentatives/i.test(String(e)),
      '3e tentative — lockout AVEC le budget réduit (défaut [10,…] aurait laissé passer)',
    )
    await app.stop()
  })

  it("IP différente = compteur indépendant (isolation prouvée sur FailureBucket, MÊME classe/instanciation que codeFailures — cf. tests 15-17/30 de mjs-ws-accounts.test.ts)", () => {
    const seau = new FailureBucket(10, 60000)
    const now = 1000
    for (let i = 0; i < 10; i++) assert.equal(seau.recordFailure('1.2.3.4', now), true, `IP A — échec ${i + 1}/10, encore dans le budget`)
    assert.equal(seau.recordFailure('1.2.3.4', now), false, 'IP A — 11e échec, seau épuisé')
    assert.equal(seau.isBlocked('1.2.3.4', now), true, 'IP A — verrouillée')
    assert.equal(seau.isBlocked('5.6.7.8', now), false, "IP B — totalement INDÉPENDANTE, encore dans son budget plein")
    assert.equal(seau.recordFailure('5.6.7.8', now), true, "IP B — 1er échec, son propre budget, pas affecté par l'épuisement de l'IP A")
  })
})
