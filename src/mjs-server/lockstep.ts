// mjs-server/lockstep — moteur du mode salle 'lockstep' (def.mode) : la salle NE SIMULE
// RIEN (cf. game.ts pour la liste FERMÉE d'interdits state/view/deltas/intents/simulate/space/histo) —
// SEULS les ORDRES (µgame:move reçus, jamais exécutés côté serveur) circulent, groupés PAR TICK et
// diffusés à l'IDENTIQUE à tous les joueurs (µgame:orders, cf. game.ts::_broadcastTickOrders) :
// l'égalité stricte d'entrée entre clients est le cœur du déterminisme (tous simulent le MÊME modèle
// à partir des MÊMES ordres, dans le MÊME ordre — jeux STR/combat/rejouabilité).
//
// GRAINE (seed, µgame:start) — PAS de Math.random en dur : `deterministicSeed(id)` hache
// l'id de partie (FNV-1a 32 bits, PURE) — l'id embarque déjà le COMPTEUR monotone de création
// ('partieN', cf. matchmaking.ts generateGameId), donc CE hash dérive bien « d'un compteur + de
// l'id ». Conséquence utile : la graine est TOUJOURS ré-dérivable depuis `id` seul —
// aucun besoin de la persister séparément (cf. `_restoreJournal`, appelé SANS graine explicite).
//
// JOURNAL — append-only, illimité PAR DÉFAUT (contrairement à `Game.journal`, le journal court v1
// des coups CLASSIQUES, cf. game.ts commentaire de tête) : la rejouabilité lockstep exige
// l'historique COMPLET depuis la genèse (µgame:resync renvoie tout, le client rejoue, cf.
// mjs_lockstep.ts) — une partie lockstep TRÈS longue fait donc grandir ce tableau sans borne tant que
// rien ne la borne explicitement (limite v1 documentée, comme le double `_lastViews`/
// `_intentQueue` déjà pris ailleurs). Bornable en OPT-IN via
// `def.lockstepJournal.maxTicks` (cf. game.ts, paramètre `maxTicks` de `createLockstep` plus bas) :
// anneau qui purge les plus VIEUX ticks au-delà du seuil — comportement HISTORIQUE (illimité)
// inchangé tant que `maxTicks` reste absent ; un futur snapshot+troncature périodique (préservant la
// reprise AU-DELÀ de la fenêtre) reste HORS SCOPE ici.
//
// PERSISTANCE (µpersist) — `Game.serialize()` (mode lockstep) inclut `{ journal: journal() }` (PAS
// la graine, ré-dérivable de `id`) à la place de `state` : « save = l'append des ordres » au sens
// CONCEPTUEL (ce qui est persisté EST le journal d'ordres, jamais un état simulé) — MÉCANIQUEMENT,
// chaque save() réécrit le journal COMPLET à ce jour (même contrat adaptateur.save « écrit/remplace »
// que le mode authoritative, cf. persist.ts) : pas un append incrémental fichier/bdd, qui exigerait de
// faire évoluer le CONTRAT des adaptateurs (persist-file/redis/sql/bridge.ts), hors scope actuel.
//
// DIVERGENCE (anti-triche, durcissement quorum) — le client annonce périodiquement un hash
// FNV de son état (µgame:hash {tick, h}, cf. mjs_lockstep.ts) ; `receiveHash` NE retient PLUS « le
// 1er hash vu = référence » (troué : un seul siège pouvait pré-empoisonner un tick FUTUR avant que
// les honnêtes n'y arrivent, ou déclencher lui-même une divergence en s'envoyant 2 hash contradictoires
// à lui seul) — deux mécanismes INDÉPENDANTS, chacun identifie le(s) SUSPECT(S), jamais la majorité :
//  1. AUTO-CONTRADICTION — un siège qui rapporte deux hash DIFFÉRENTS pour le MÊME tick est flaggé
//     suspect IMMÉDIATEMENT (preuve interne, ne dépend d'aucun autre siège ni d'aucun quorum).
//  2. QUORUM — la référence d'un tick ne se fige QUE quand un hash atteint la MAJORITÉ ABSOLUE des
//     sièges COURANTS (floor(N/2)+1 sur N, jamais parmi les seuls sièges ayant déjà répondu) : par
//     construction, DEUX hash différents ne peuvent JAMAIS atteindre tous les deux ce seuil pour le
//     même tick (pigeonhole) — une fois figée, la référence ne se retourne donc plus jamais. Tout
//     siège dont le hash diffère (déjà rapporté OU rapporté plus tard) devient suspect. Cas N PAIR
//     strictement scindé (aucune valeur n'atteint jamais floor(N/2)+1, même une fois TOUS les sièges
//     rapportés — ex. 2 sièges en désaccord, 1 contre 1) : politique ASSUMÉE = AUCUNE déclaration
//     (indécidable sans arbitre extérieur — jamais un « premier arrivé blâme le second » arbitraire).
// FENÊTRE — tout hash pour un tick hors de [tickCourant−FENETRE_TICKS, tickCourant+DELAI_AVANT_TICKS]
// est REJETÉ d'emblée (silence, jamais stocké) : ferme le pré-empoisonnement (l'attaquant ne peut
// plus poser une fausse entrée bien avant que les honnêtes n'atteignent ce tick) ET borne la mémoire
// (éviction active à chaque closeTick(), en plus du refus à l'entrée — cf. createLockstep plus bas).
// Un seau à jetons DÉDIÉ (game.ts::_consumeHashToken, TokenBucket de mjs-ws/guard.ts) filtre en
// amont un flood de hash par ailleurs VALIDES mais coûteux à traiter, cf. game.ts::_receiveHash.

export interface MjsServerLockstepOrder {
  player: string
  move: string
  p: unknown
}

export interface MjsServerLockstepTick {
  tick: number
  orders: MjsServerLockstepOrder[]
}

export interface MjsServerLockstepDivergence {
  tick: number
  /** sièges identifiés comme suspects pour ce tick — JAMAIS la majorité honnête (cf. tête de
   *  fichier) ; toujours ≥ 1 entrée quand cet objet existe (jamais renvoyé vide, cf. receiveHash) */
  suspects: string[]
  /** 'auto-contradiction' = CE siège s'est contredit lui-même (2 hash différents, même tick — preuve
   *  interne) ; 'quorum' = hash minoritaire face à la référence MAJORITAIRE établie (cf. tête de fichier) */
  reason: 'auto-contradiction' | 'quorum'
}

export interface MjsServerLockstep {
  readonly seed: number
  /** file un ordre pour le tick COURANT (pas encore diffusé) — cf. Game._onMove */
  addOrder(player: string, move: string, p: unknown): void
  /** clôt le tick courant (ordres accumulés + avance le compteur), journalise (append), évince les
   *  entrées de divergence sorties de la fenêtre (cf. tête de fichier « FENÊTRE ») et retourne le
   *  groupe à diffuser — TOUJOURS renvoyé, même `ordres: []` (le tick lui-même est l'horloge commune
   *  que les clients doivent avancer — jamais de trame sautée faute d'ordre) */
  closeTick(): MjsServerLockstepTick
  /** journal COMPLET depuis la genèse (rejouabilité, µgame:play/start/resync — cf. game.ts _infoMode) */
  journal(): MjsServerLockstepTick[]
  /** reçoit un hash annoncé par un joueur pour `tick` (cf. tête de fichier pour le modèle quorum +
   *  auto-contradiction + fenêtre) — `null` si rien à signaler (hash hors fenêtre REJETÉ, quorum pas
   *  encore atteint, ou hash concordant — hashs concordants = rien à signaler).
   *  `sieges` = nombre de sièges OCCUPÉS courants (connectés ou non, MÊME politique que le tour par
   *  tour roundrobin — cf. game.ts commentaire de tête) : relu à CET appel, jamais figé à la
   *  création (cf. game.ts::_receiveHash pour le calcul). */
  receiveHash(player: string, tick: number, h: string, seats: number): MjsServerLockstepDivergence | null
  /** persistance (µpersist) — restaure le journal depuis un instantané (cf. restoreGameFromSnapshot) : reprend
   *  la numérotation de tick JUSTE APRÈS la dernière entrée restaurée, jamais une renumérotation qui
   *  collisionnerait avec l'historique déjà connu des clients. No-op sur un journal vide. */
  _restoreJournal(journal: MjsServerLockstepTick[]): void
  /** introspection interne (tests/diagnostics — MÊME statut que _clear/_restoreJournal, PAS un
   *  contrat public MjsServerApp) — nombre de ticks actuellement retenus pour la détection de
   *  divergence ; TOUJOURS ≤ FENETRE_TICKS + DELAI_AVANT_TICKS + 1 (borné, cf. tête de fichier). */
  _hashSize(): number
  _clear(): void
}

/** graine déterministe — FNV-1a 32 bits de l'id de partie, cf. commentaire de tête.
 *  PURE (aucun état, aucun Math.random) : même id ⇒ même graine, TOUJOURS — testable, reproductible.
 *  MÊME algorithme que le hash d'état CÔTÉ CLIENT (mjs_lockstep.ts::_mjlockstepFnv) — isomorphe au
 *  sens large (même famille d'algorithme), bien que ces deux usages hachent des entrées différentes. */
export function deterministicSeed(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// anti-triche — fenêtre de tolérance des hash autour du tick courant (cf. tête de fichier
// « FENÊTRE ») : ~64 ticks en arrière (rejoue une latence/déconnexion raisonnable), petite marge en
// avant (course bénigne hash/clôture de tick — PAS une fenêtre pour un hash réellement futur, cf.
// receiveHash plus bas).
const TICKS_WINDOW     = 64
const DELAY_BEFORE_TICKS = 4

/** état de divergence d'UN tick — remplace l'ancien couple hashParTick/tickDejaDivergent (« 1er hash
 *  = référence ») : tous les hash vus par siège + décompte par valeur + référence gelée une fois la
 *  majorité absolue atteinte + sièges déjà signalés (jamais 2 fois pour le même siège/tick), cf. tête
 *  de fichier. */
interface TickHashState {
  perPlayer: Map<string, string>
  comptes: Map<string, number>
  reference: string | null
  signales: Set<string>
}

const absoluteMajority = (seats: number): number => Math.floor(seats / 2) + 1

/** construit le moteur lockstep d'UNE partie — `id` sert à dériver la graine (cf. deterministicSeed) ;
 *  le journal démarre VIDE (partie fraîche, cf. matchmaking.ts::create()) — `_restoreJournal` le repeuple pour
 *  une partie RESTAURÉE (cf. restoreGameFromSnapshot), sans jamais changer la graine (ré-dérivée de `id`, donc
 *  déjà identique à l'originale — aucune valeur à restaurer séparément). */
export function createLockstep(id: string, maxTicks: number | null = null): MjsServerLockstep {
  const seed = deterministicSeed(id)
  let fullJournal: MjsServerLockstepTick[] = []
  let currentOrders: MjsServerLockstepOrder[] = []
  let tickCount = 0
  // divergence (anti-triche) — PAR TICK, cf. TickHashState ; bornée par éviction dans
  // closeTick() (au-delà du simple refus à l'entrée dans receiveHash, cf. tête de fichier)
  const hashesPerTick = new Map<number, TickHashState>()

  return {
    get seed() { return seed },

    addOrder(player, move, p) {
      currentOrders.push({ player, move, p })
    },

    closeTick() {
      tickCount++
      const group: MjsServerLockstepTick = { tick: tickCount, orders: currentOrders }
      currentOrders = []
      fullJournal.push(group)
      // journal borné (opt-in, def.lockstepJournal.maxTicks, cf. game.ts) — MÊME idiome que
      // l'éviction hashesParTick juste en dessous : anneau, purge les plus VIEUX ticks au-delà de
      // `maxTicks` ; `maxTicks` null (défaut, absent de la déclaration) = illimité, comportement
      // HISTORIQUE inchangé (cf. commentaire de tête « JOURNAL »)
      if (maxTicks != null && fullJournal.length > maxTicks) fullJournal.splice(0, fullJournal.length - maxTicks)
      // éviction active — sans ça, une entrée qui a un jour reçu UN hash reste en mémoire
      // indéfiniment une fois hors fenêtre (le refus à l'entrée dans receiveHash empêche
      // seulement la CRÉATION de nouvelles entrées hors fenêtre, jamais la purge des anciennes au
      // fil du temps) : c'est CETTE éviction qui borne réellement la durée de vie de la partie.
      const threshold = tickCount - TICKS_WINDOW
      for (const t of hashesPerTick.keys()) if (t < threshold) hashesPerTick.delete(t)
      return group
    },

    journal() { return fullJournal },

    receiveHash(player, tick, h, seats) {
      // hors fenêtre — REJETÉ d'emblée, jamais stocké (ferme le pré-empoisonnement d'un tick
      // lointain ET la fuite mémoire par ticks inventés, cf. tête de fichier)
      if (tick < tickCount - TICKS_WINDOW || tick > tickCount + DELAY_BEFORE_TICKS) return null

      let state = hashesPerTick.get(tick)
      if (!state) { state = { perPlayer: new Map(), comptes: new Map(), reference: null, signales: new Set() }; hashesPerTick.set(tick, state) }

      const previous = state.perPlayer.get(player)

      // auto-contradiction — CE siège a déjà rapporté un hash DIFFÉRENT pour ce tick : preuve
      // interne, suspect IMMÉDIAT, sans attendre le quorum (cf. tête de fichier). Le hash déjà
      // enregistré n'est JAMAIS écrasé (garde le 1er vote pour le décompte ci-dessous, stable).
      if (previous !== undefined && previous !== h) {
        if (state.signales.has(player)) return null   // déjà signalé pour ce tick — jamais 2 fois
        state.signales.add(player)
        return { tick, suspects: [player], reason: 'auto-contradiction' }
      }

      if (previous === undefined) {
        state.perPlayer.set(player, h)
        state.comptes.set(h, (state.comptes.get(h) ?? 0) + 1)
      }

      // référence déjà figée pour ce tick (majorité atteinte à un appel PRÉCÉDENT) — comparaison
      // directe, jamais de retour en arrière possible (cf. tête de fichier : pigeonhole)
      if (state.reference !== null) {
        if (h === state.reference || state.signales.has(player)) return null
        state.signales.add(player)
        return { tick, suspects: [player], reason: 'quorum' }
      }

      // pas encore de référence — CE hash vient-il de franchir la majorité ABSOLUE de `sieges` ?
      if ((state.comptes.get(h) ?? 0) < absoluteMajority(seats)) return null   // quorum pas encore atteint — silence, on attend d'autres rapports

      state.reference = h
      const suspects: string[] = []
      for (const [j, hj] of state.perPlayer) {
        if (hj !== h && !state.signales.has(j)) { state.signales.add(j); suspects.push(j) }
      }
      return suspects.length > 0 ? { tick, suspects, reason: 'quorum' } : null   // personne à blâmer — silence
    },

    _restoreJournal(journal) {
      if (journal.length === 0) return
      // MÊME plafond qu'à l'éviction en direct (closeTick ci-dessus) — une restauration ne doit
      // jamais réintroduire plus de `maxTicks` ticks qu'un journal vécu normalement n'en garderait
      fullJournal = maxTicks != null && journal.length > maxTicks ? journal.slice(journal.length - maxTicks) : journal.slice()
      tickCount = fullJournal[fullJournal.length - 1].tick
    },

    _hashSize() { return hashesPerTick.size },

    _clear() { fullJournal = []; currentOrders = []; hashesPerTick.clear() },
  }
}
