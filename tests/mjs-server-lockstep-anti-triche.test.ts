// Tests anti-triche (durcissement du détecteur de divergence lockstep, anti-cheat au
// maximum) — problème confirmé sur lockstep.ts:90-117 + la branche lockstep de
// game.ts + matchmaking.ts handlerHash : `receiveHash` retenait le PREMIER hash vu par tick comme
// RÉFÉRENCE, sans quorum ni validation du tick contre l'avancement réel — un seul siège pouvait (1)
// pré-empoisonner un tick FUTUR (poser son hash bidon pour lui MAINTENANT, avant que les honnêtes n'y
// arrivent — leur VRAI hash, plus tard, aurait alors semblé « divergent ») ou (2) s'auto-déclencher
// une divergence en s'envoyant 2 hash différents pour le même tick, SEUL ; `hashParTick`/
// `tickDejaDivergent` n'étaient en plus JAMAIS bornées (fuite mémoire par flood de ticks inventés).
// Ce fichier couvre le nouveau modèle (cf. mjs-server/lockstep.ts tête de fichier « DIVERGENCE ») :
//  - QUORUM — la référence d'un tick ne se fige QU'à la majorité ABSOLUE des sièges COURANTS
//    (floor(N/2)+1) ; tests DIRECTS sur createLockstep() (pas de socket — plus rapide/précis pour ces
//    cas limites que le harnais bout-en-bout, cf. tests/mjs-server-lockstep.test.ts test g et
//    tests/socket-lockstep.test.ts test d pour la couverture bout-en-bout via de VRAIS clients).
//  - AUTO-CONTRADICTION — un siège qui se contredit lui-même est flaggé IMMÉDIATEMENT.
//  - FENÊTRE — hash hors [tickCourant-64, tickCourant+4] REJETÉ ; structure BORNÉE (introspection
//    _tailleHash(), MÊME statut « interne aux tests » que _clear/_restaurerJournal).
//  - N pair scindé 50/50 — AUCUNE déclaration (indécidable sans arbitre extérieur, politique assumée).
//  - câblage game.ts (harnais DIRECT fakeApp/fakeClient/createGame, MÊME patron que la section 4
//    de tests/mjs-server-anti-triche.test.ts) : sieges = sièges OCCUPÉS, onDivergence {tick,suspects,
//    raison}, anti-abus dédié _consumeHashToken (canal DISTINCT des coups).
// PIÈGE local (tests DIRECTS sur createLockstep()/partie fraîche) : tickCompte démarre à 0 et
// n'avance QUE via closeTick() — un test SYNCHRONE (jamais de tick réel écoulé) doit donc utiliser
// des ticks ≤ DELAI_AVANT_TICKS (4) pour rester DANS la fenêtre, sous peine de voir son hash rejeté
// par la fenêtre plutôt que par la logique testée (section 3 EXPLOITE ce fait pour tester la fenêtre
// elle-même — ticks volontairement hors bornes).
import assert from 'node:assert/strict'
import { createLockstep, resolveGameDef, createGame } from '../src/mjs-server/index.js'

// --- harnais DIRECT (sans transport) — MÊME patron que tests/mjs-server-anti-triche.test.ts section 4,
// pour les mécaniques internes non observables sur le fil (quorum, auto-contradiction, seau à jetons) --
function fakeApp(): any { return { send() {} } }
function fakeClient(identityId: string): any {
  return { id: 'fake-' + identityId, identity: { id: identityId }, latency: null, meta: {}, send() {}, close() {} }
}

describe("MJS-Server — anti-triche (lockstep : détection de divergence PAR QUORUM, jamais au 1er hash)", () => {

  describe('1. lockstep.ts::receiveHash — quorum (majorité ABSOLUE floor(N/2)+1, jamais parmi les seuls sièges ayant répondu)', () => {
    it("3 sièges, 2 hash CONCORDANTS (A) + 1 DIFFÉRENT (B) → divergence AVEC le siège minoritaire identifié, JAMAIS la majorité — ordre d'arrivée INDIFFÉRENT (minoritaire en dernier OU en premier)", () => {
      // minoritaire (z) en DERNIER
      const ls1 = createLockstep('p1')
      assert.equal(ls1.receiveHash('x', 1, 'A', 3), null, '1er vote — quorum(3)=2 pas encore atteint')
      assert.equal(ls1.receiveHash('y', 1, 'A', 3), null, '2e vote POUR A — majorité atteinte, mais x/y CONCORDENT (rien à signaler)')
      assert.deepEqual(ls1.receiveHash('z', 1, 'B', 3), { tick: 1, suspects: ['z'], reason: 'quorum' })

      // minoritaire (z) en PREMIER — MÊME verdict (la référence se fige à la MAJORITÉ, jamais au 1er
      // arrivé — c'est précisément le trou comblé ici : « 1er hash = référence » aurait ici blâmé x et y)
      const ls2 = createLockstep('p2')
      assert.equal(ls2.receiveHash('z', 1, 'B', 3), null)
      assert.equal(ls2.receiveHash('x', 1, 'A', 3), null, '1 seul vote pour A — pas encore la majorité')
      assert.deepEqual(ls2.receiveHash('y', 1, 'A', 3), { tick: 1, suspects: ['z'], reason: 'quorum' }, 'A franchit la majorité — z (arrivé AVANT) identifié suspect a posteriori')
    })

    it("le cas « 1 seul siège rapporte un hash bidon » ne déclenche RIEN à lui seul, MÊME pour un tick dans la fenêtre valide (pas de quorum atteignable par 1 vote seul — cf. section 3 pour le cas complémentaire, tick hors fenêtre)", () => {
      const ls = createLockstep('p3')
      assert.equal(ls.receiveHash('mechant', 3, 'bidon', 5), null, 'sieges=5 → majorité=3, un seul vote ne peut jamais suffire')
    })

    it("N pair strictement scindé (2 sièges, 1 hash chacun, DIFFÉRENTS) → AUCUNE déclaration, MÊME en répétant — politique ASSUMÉE (indécidable sans arbitre extérieur, cf. tête de fichier lockstep.ts)", () => {
      const ls = createLockstep('p4')
      assert.equal(ls.receiveHash('a', 1, 'aaa', 2), null)
      assert.equal(ls.receiveHash('b', 1, 'bbb', 2), null, "floor(2/2)+1=2 : AUCUNE des 2 valeurs (1 vote chacune) n'atteint jamais ce seuil")
      // répéter la MÊME valeur ne fait PAS gonfler le décompte (dédup par siège) — le tie reste un tie
      assert.equal(ls.receiveHash('a', 1, 'aaa', 2), null)
      assert.equal(ls.receiveHash('b', 1, 'bbb', 2), null)
    })

    it('non-régression : hash CONCORDANTS (tous les sièges, même valeur) ne déclenchent JAMAIS de divergence', () => {
      const ls = createLockstep('p5')
      assert.equal(ls.receiveHash('a', 3, 'pareil', 2), null)
      assert.equal(ls.receiveHash('b', 3, 'pareil', 2), null, 'quorum(2)=2 atteint, mais AUCUN suspect (tout le monde concorde) — silence')
    })

    it('pré-empoisonnement DÉSAMORCÉ : 1 seul siège pose un hash bidon EN AVANCE pour un tick pas encore atteint → n\'impose RIEN (1 vote ne peut jamais fixer la référence) ; les honnêtes qui arrivent ENSUITE établissent la VRAIE référence et identifient le POSEUR comme suspect — jamais l\'inverse (c\'est exactement le trou fermé ici)', () => {
      const ls = createLockstep('p6')
      // 'mechant' pose un hash bidon pour le tick 2 AVANT même que le jeu ne l'ait atteint (tickCompte=0)
      assert.equal(ls.receiveHash('mechant', 2, 'poison', 3), null, '1 seul vote — quorum(3)=2 jamais atteint par ce seul hash')
      ls.closeTick(); ls.closeTick()   // le jeu avance réellement jusqu'au tick 2
      assert.equal(ls.receiveHash('honnete1', 2, 'vrai', 3), null, '2 valeurs DIFFÉRENTES à 1 vote chacune — pas encore de majorité')
      assert.deepEqual(ls.receiveHash('honnete2', 2, 'vrai', 3), { tick: 2, suspects: ['mechant'], reason: 'quorum' }, 'la VRAIE valeur (2 votes honnêtes) devient la référence — le poison isolé est identifié suspect')
    })
  })

  describe('2. lockstep.ts::receiveHash — auto-contradiction (preuve interne, IMMÉDIATE, sans attendre le quorum)', () => {
    it('un même siège qui rapporte 2 hash DIFFÉRENTS pour le MÊME tick est flaggé suspect IMMÉDIATEMENT — jamais 2 fois pour le même tick ensuite', () => {
      const ls = createLockstep('p7')
      assert.equal(ls.receiveHash('a', 1, 'h1', 5), null, '1er rapport — rien à signaler')
      assert.deepEqual(ls.receiveHash('a', 1, 'h2', 5), { tick: 1, suspects: ['a'], reason: 'auto-contradiction' }, 'MÊME siège, hash DIFFÉRENT, MÊME tick — suspect immédiat, 5 sièges mais AUCUN quorum requis')
      assert.equal(ls.receiveHash('a', 1, 'h3', 5), null, 'déjà signalé pour ce tick — jamais 2 fois')
      assert.equal(ls.receiveHash('a', 1, 'h1', 5), null, 'même le 1er hash (revu) ne re-signale pas — a reste flaggé une fois pour toutes sur ce tick')
    })
  })

  describe('3. lockstep.ts — fenêtre bornée [tickCourant-64, tickCourant+4] (ferme le pré-empoisonnement lointain ET la fuite mémoire)', () => {
    it('hash pour un tick TRÈS futur (tickCourant+10000) → rejeté d\'emblée, jamais stocké (_tailleHash reste à 0)', () => {
      const ls = createLockstep('p8')
      assert.equal(ls.receiveHash('mechant', 10000, 'poison', 3), null)
      assert.equal(ls._hashSize(), 0, 'rejeté à l\'entrée — jamais entré dans la structure')
    })

    it('flood de ticks INVENTÉS dans la fenêtre valide → la structure ne dépasse JAMAIS FENETRE_TICKS+DELAI_AVANT_TICKS+1 (69) ticks, et l\'éviction à closeTick() la RAMÈNE à 0 quand le jeu avance', () => {
      const ls = createLockstep('p9')
      // tickCompte=0 — inonde TOUS les ticks valides de la fenêtre [-64, +4] avec un hash chacun,
      // sieges=100 pour ne JAMAIS déclencher de quorum (chaque siège 'flood<t>' est distinct — 1 vote
      // isolé par hash) : ce test porte UNIQUEMENT sur le STOCKAGE, pas sur la détection
      for (let t = -64; t <= 4; t++) ls.receiveHash('flood' + t, t, 'x' + t, 100)
      assert.equal(ls._hashSize(), 69, 'exactement les 69 ticks valides (-64..+4 inclus)')
      // tente D'AUTRES ticks hors fenêtre — n'ajoutent RIEN (déjà couvert plus haut, reconfirmé ici
      // dans le contexte du flood — la fenêtre plafonne la structure INDÉPENDAMMENT du nombre de tentatives)
      ls.receiveHash('flood', 5, 'y', 100)
      ls.receiveHash('flood', -65, 'y', 100)
      assert.equal(ls._hashSize(), 69, 'toujours 69 — hors fenêtre = jamais stocké, même après des dizaines de tentatives')
      // avance le jeu de 70 ticks RÉELS (closeTick est synchrone — pas besoin d'attendre) : l'éviction
      // active purge au fil de l'eau tout ce qui sort de la fenêtre, jusqu'à ce qu'AUCUNE des 69
      // entrées floodées (tick max = 4) ne puisse plus jamais rentrer dans la fenêtre courante
      for (let i = 0; i < 70; i++) ls.closeTick()
      assert.equal(ls._hashSize(), 0, 'jeu long : les vieilles entrées sont RÉELLEMENT évincées, pas seulement rendues inaccessibles')
    })
  })

  describe('4. game.ts — câblage (harnais DIRECT, MÊME patron que mjs-server-anti-triche.test.ts section 4)', () => {
    function declarerLockstepDirect(overrides: Record<string, any> = {}): any {
      return resolveGameDef('lockstep-direct', { mode: 'lockstep', seats: 4, tick: 10, moves: {}, ...overrides })
    }

    it('_receiveHash : sieges = sièges OCCUPÉS courants (relu à chaque appel) ; def.onDivergence + µgame:event reçoivent {tick, suspects, raison} — jamais la majorité honnête', () => {
      const divergences: any[] = []
      const def = declarerLockstepDirect({ onDivergence: (_p: any, info: any) => divergences.push(info) })
      const game = createGame(fakeApp(), def, () => {}, 'pquorum1')
      const c1 = fakeClient('j1'); const c2 = fakeClient('j2'); const c3 = fakeClient('j3')
      game._createSeat(c1); game._createSeat(c2); game._createSeat(c3)
      game._receiveHash(c1, 3, 'aaa')
      game._receiveHash(c2, 3, 'aaa')
      assert.equal(divergences.length, 0, 'x/y concordent — pas encore de divergence (z n\'a pas encore rapporté)')
      game._receiveHash(c3, 3, 'bbb')
      assert.equal(divergences.length, 1)
      assert.deepEqual(divergences[0], { tick: 3, suspects: ['j3'], reason: 'quorum' }, 'siège MINORITAIRE identifié (j3), jamais j1/j2')
      game._destroy()
    })

    it("_receiveHash : sièges DÉCONNECTÉS comptent quand même dans `sieges` (MÊME politique que le tour par tour roundrobin — cf. commentaire de tête game.ts, .next() tourne parmi TOUS les sièges occupés, connectés ou non) — CONSÉQUENCE assumée : un siège déconnecté qui n'a encore rien rapporté retarde le quorum tant qu'il occupe la partie, jusqu'à son propre rapport (ou son départ, hors scope ici)", () => {
      const divergences: any[] = []
      const def = declarerLockstepDirect({ onDivergence: (_p: any, info: any) => divergences.push(info) })
      const game = createGame(fakeApp(), def, () => {}, 'pquorum2')
      const c1 = fakeClient('j1'); const c2 = fakeClient('j2'); const c3 = fakeClient('j3'); const c4 = fakeClient('j4')
      game._createSeat(c1); game._createSeat(c2); game._createSeat(c3); game._createSeat(c4)
      game._onDisconnect(c4)   // j4 déconnecté — reste OCCUPANT du siège (pas de kick auto v1)
      game._receiveHash(c1, 3, 'aaa')
      game._receiveHash(c2, 3, 'aaa')
      game._receiveHash(c3, 3, 'bbb')
      // sieges = 4 (j4 compte, déconnecté ou non) → majorité = floor(4/2)+1 = 3 ; 'aaa' n'a que 2
      // votes → PAS de quorum, MÊME si les 3 sièges CONNECTÉS ont TOUS rapporté (2 contre 1) : un
      // siège déconnecté qui n'a jamais parlé retarde le verdict tant qu'il occupe la partie — cf. le
      // même trade-off déjà assumé pour .next() (commentaire de tête de game.ts)
      assert.equal(divergences.length, 0, "2 voix sur 3 CONNECTÉES ne suffisent pas quand sieges=4 (j4 compte) — majorité=3 pas atteinte")
      // j4 finit par rapporter — via une RECONNEXION (nouvelle connexion RÉATTACHÉE, cf. _reattachSeat) :
      // réutiliser `c4` tel quel serait invalide, _onDisconnect l'a RETIRÉ de joueur.clients
      // (_findSeatOf(c4) ne le retrouverait plus, cf. game.ts) — MÊME modélisation qu'une vraie
      // reconnexion (µgame:resync/play sur une NOUVELLE connexion, jamais l'ancienne)
      const c4b = fakeClient('j4')
      game._reattachSeat(c4b)
      game._receiveHash(c4b, 3, 'aaa')
      assert.equal(divergences.length, 1)
      assert.deepEqual(divergences[0], { tick: 3, suspects: ['j3'], reason: 'quorum' }, 'la majorité (3 votes aaa) se fige dès que j4 parle — j3 (bbb) identifié suspect')
      game._destroy()
    })

    it('_receiveHash : auto-contradiction câblée bout-en-bout — un siège seul, sans les autres, déclenche def.onDivergence IMMÉDIATEMENT', () => {
      const divergences: any[] = []
      const def = declarerLockstepDirect({ onDivergence: (_p: any, info: any) => divergences.push(info) })
      const game = createGame(fakeApp(), def, () => {}, 'pauto1')
      const c1 = fakeClient('j1')
      game._createSeat(c1); game._createSeat(fakeClient('j2')); game._createSeat(fakeClient('j3'))
      game._receiveHash(c1, 1, 'h1')
      game._receiveHash(c1, 1, 'h2')
      assert.equal(divergences.length, 1)
      assert.deepEqual(divergences[0], { tick: 1, suspects: ['j1'], reason: 'auto-contradiction' })
      game._destroy()
    })

    it("_consumeHashToken : anti-abus DÉDIÉ — un flood de rapports par ailleurs VALIDES (69 ticks distincts, TOUS dans la fenêtre — cf. section 3) au-delà du budget (HASH_LIMIT=[30,1000]) est silencieusement ignoré, jamais un throw (fire-and-forget, cf. matchmaking.ts::handlerHash) : le seau à jetons coupe BIEN AVANT la limite naturelle de la fenêtre (69)", () => {
      const def = declarerLockstepDirect()
      const game = createGame(fakeApp(), def, () => {}, 'phf1')
      const c1 = fakeClient('j1')
      game._createSeat(c1); game._createSeat(fakeClient('j2')); game._createSeat(fakeClient('j3'))
      for (let t = -64; t <= 4; t++) assert.doesNotThrow(() => game._receiveHash(c1, t, 'h' + t))
      const size = game._lockstep!._hashSize()
      assert.ok(size > 0, 'les premiers rapports (sous le budget) doivent bien être traités')
      assert.ok(size <= 30, `plafonné par HASH_LIMIT (30/1000ms), bien avant la limite naturelle de la fenêtre (69) — taille=${size}`)
      game._destroy()
    })

    it("_consumeHashToken est un canal DISTINCT de _consumeToken (coups) — épuiser le budget hash n'affecte JAMAIS le budget des coups", () => {
      const def = declarerLockstepDirect()
      const game = createGame(fakeApp(), def, () => {}, 'pcd1')
      const c1 = fakeClient('j1')
      game._createSeat(c1); game._createSeat(fakeClient('j2')); game._createSeat(fakeClient('j3'))
      for (let t = -64; t <= 4; t++) game._receiveHash(c1, t, 'h' + t)   // épuise le budget HASH (69 tentatives, budget=30)
      assert.doesNotThrow(() => game._onMove(c1, 'bouger', {}), 'le budget des COUPS (canal distinct, _buckets) doit rester intact')
      game._destroy()
    })
  })

  describe('5. lockstep.ts::createLockstep — journal borné (opt-in maxTicks, cf. game.ts lockstepJournal) — anneau, comportement HISTORIQUE (illimité) inchangé quand absent', () => {
    it('createLockstep(id, 5) + 20 closeTick() → journal() plafonné à 5 entrées, les 5 DERNIERS ticks (les plus vieux évincés)', () => {
      const ls = createLockstep('px', 5)
      for (let i = 0; i < 20; i++) ls.closeTick()
      assert.equal(ls.journal().length, 5, 'anneau plafonné à maxTicks')
      assert.equal(ls.journal()[0].tick, 16, 'les plus VIEUX évincés — ne restent que les 5 derniers (16..20)')
    })
  })
})
