// mjs-server/partie — l'instance de partie : état applicatif (`state`, librement muté par les
// coups), sièges, phase, tour, minuteries NOMMÉES (sérialisables, jamais de fermeture stockée),
// journal borné, diffusion groupée par microtâche (mode événementiel, tick=0) OU par tick (mode
// action, tick>0). Tout ce qui est marqué `_` en tête n'est PAS un contrat public MjsServerApp —
// usage interne exclusif de matchmaking.ts (sœur de confiance, pas une app hôte : aucun besoin des
// gardes `(x as any)` que core.ts réserve à ses accroches de test, cf. son commentaire de tête).
//
// MODE ACTION (def.tick > 0, 1-60 Hz, cf. game.ts) — 3 pièces :
//  - intentions (def.intents) — reçues par _onMove comme un move, mais mises en FILE par
//    joueur (_intentQueue, dernière valeur gagne par nom) au lieu d'être exécutées ; la boucle
//    (setInterval, _startTickLoop/_runTick) déroule à chaque tick : intentions en file
//    (ordre des SIÈGES) → def.simulate(partie, dt RÉEL mesuré) → UNE diffusion (_broadcastTick).
//    `_markDirty` (microtâche) devient un NO-OP tant que tick>0 : la cadence de diffusion
//    appartient exclusivement à la boucle dans ce mode (jamais les deux à la fois). Les moves
//    classiques restent exécutés IMMÉDIATEMENT, hors boucle (ex. chat) — cf. _onMove.
//    def.slowTick optionnel = 2e setInterval à sa propre cadence, indépendante de `tick`.
//    Boucle démarrée dès le 1er siège CONNECTÉ (_checkEmpty, y compris _createSeat), coupée à la
//    vidange, à .end() et à ._destroy() — jamais de setInterval résiduel.
//  - deltas (def.deltas, ORTHOGONAL à tick) — _buildFrame calcule PAR JOUEUR un diff profond
//    (deepDiff plus bas) entre la vue courante et `_lastViews` (dernière vue ENVOYÉE à CE
//    joueur) ; repli vue complète en 1re diffusion/resync/delta trop gros (>60% du JSON de la vue).
//    Défaut false = frame IDENTIQUE au v1 (compatibilité stricte, cf. tests/socket-game.test.ts).
//  - persistance (_onMutate) — à cadence de tick, l'appeler à CHAQUE tick serait trop bavard ;
//    _markDirty() throttle localement (TICK_PERSIST_THROTTLE_MS), le lissage/l'écriture
//    réels restent 100% gouvernés par persist.ts (débounce/snapshotEvery, inchangés).
//
// Sièges/tour/minuteries — quelques décisions v1 assumées :
//  - .next() (roundrobin) fait tourner le tour parmi TOUS les sièges occupés, connectés ou non —
//    aucun « saut » automatique d'un siège déconnecté (fidèle à « pas de kick automatique v1 »).
//    Le VRAI filet contre un tour bloqué par un absent, c'est turns.timeout (générique, déjà
//    demandé), pas un filtrage caché en plus.
//  - .end() n'impose AUCUNE phase — si l'auteur veut fermer les coups après la fin, il déclare sa
//    propre phase 'fin' à coups vides dans `def.phases` et l'atteint lui-même via `.to('fin')`.
//  - .end() arme une grâce de destruction = `def.emptyTtl` (réutilisé, pas de clé de config en
//    plus) : la partie reste interrogeable (resync) le temps que les clients encaissent la fin.

import type { MjsWsApp, MjsWsClient } from '../mjs-ws/index.js'
import { TokenBucket, errMessage } from '../mjs-ws/guard.js'
import type { MjsServerResolvedDef } from './game-def.js'
import { createSpace } from './space.js'
import type { MjsServerSpace } from './space.js'
// compensation de lag — tampon circulaire de positions, cf. history.ts pour le contrat complet
import { createHistory } from './history.js'
import type { MjsServerHistory, MjsServerHistoryPositions, MjsServerHistoryMeta } from './history.js'
// mode lockstep — la salle ne simule rien, cf. lockstep.ts pour le contrat complet
import { createLockstep } from './lockstep.js'
import type { MjsServerLockstep, MjsServerLockstepTick } from './lockstep.js'
import { t } from '../messages/index.js'

// id de peer = identity.id si présent, sinon l'id de connexion — RÉIMPLÉMENTATION LOCALE de
// mjs-ws/rooms.ts peerIdOf (non exportée par l'index public de MJS-WS —
// composition sur l'API PUBLIQUE seulement) — MÊME logique, à la ligne près. Conséquence à
// connaître : sans `opts.auth` côté MJS-WS, chaque reconnexion change d'id (repli sur l'id de
// connexion, qui ne survit jamais à une coupure) — µgame:resync ne peut alors JAMAIS retrouver
// un siège après coupure. Une identité stable (opts.auth) est le prix de la reprise v1.
export function peerIdOf(client: MjsWsClient): string {
  const identity = client.identity
  if (identity && typeof identity === 'object' && 'id' in (identity as object)) {
    const raw = (identity as Record<string, unknown>).id
    // chaîne vide/blanche = pas d'identité stable (auth mal typée…) — repli sur l'id de connexion,
    // sinon deux connexions distinctes collisionnent sur le même siège
    if (raw != null && String(raw).trim() !== '') return String(raw)
  }
  return client.id
}

// noms de minuterie RÉSERVÉS (internes à MJS-Server) — jamais un nom d'auteur valide dans
// `def.timers` (game.ts le refuse à la déclaration) NI en argument direct de `partie.timer()`
// (refusé aussi, cf. plus bas) : même politique que le préfixe 'µgame:' des trames (index.ts).
export const RESERVED_TIMER_NAMES = new Set(['µturn', 'µmatch', 'µempty'])

const JOURNAL_MAX = 200
// mode action — throttle LOCAL de _markDirty (persistance), INDÉPENDANT de def.tick (jusqu'à
// 60 Hz) : borne la fréquence d'APPEL du hook _onMutate, jamais la logique d'écriture elle-même
// (100% chez persist.ts, débounce/snapshotEvery inchangés) — cf. commentaire de tête du fichier
const TICK_PERSIST_THROTTLE_MS = 100
// anti-triche (µgame:hash, cf. _consumeHashToken plus bas) — budget FIXE, PAS de clé
// def.limits dédiée (garde volontairement SIMPLE) : même chiffre que
// DEFAULT_MOVES_LIMIT (game.ts, 30/1000ms) — largement au-dessus d'un usage légitime (µ.lockstep
// hache par défaut toutes les 60 ticks, cf. mjs_lockstep.ts), bloque un flood de hash par ailleurs
// VALIDES mais coûteux à traiter (Map par tick, cf. lockstep.ts) ; canal DISTINCT de `_buckets`
// (coups) — jamais mélangé, cf. _bucketsHash.
const HASH_LIMIT: [number, number] = [30, 1000]
// anti-triche (détection par coup) — anneau borné DÉDIÉ (JAMAIS mélangé à `journal`, le
// journal COURT v1 des coups CLASSIQUEMENT appliqués ci-dessus, cf. commentaire de tête du fichier)
const ANTICHEAT_LOG_MAX = 100
// anti-triche (def.antiRejeu) — fenêtre MAXIMALE d'avance de séquence acceptée en 1 coup :
// protège contre un `_n`/`_s` empoisonné à une valeur énorme, qui ferait paraître tout coup FUTUR
// légitime « en retard » pour toujours (dernier resterait bloqué à cette valeur aberrante) — budget
// FIXE, garde volontairement SIMPLE (MÊME esprit que HASH_LIMIT ci-dessus, pas de clé def dédiée)
const ANTIREPLAY_WINDOW = 1000

/** une opération de delta (cf. _buildFrame) — `v` pose/remplace la valeur au chemin `p`
 *  ('a.2.b', à points, jamais échappés — LIMITE v1 documentée : une clé de vue contenant un point
 *  littéral casserait le chemin), `x: 1` supprime la clé finale du chemin. */
export interface MjsServerDeltaOp { p: string; v?: unknown; x?: 1 }

/** diff profond RÉCURSIF (objets/tableaux traités UNIFORMÉMENT via Object.keys — un index de
 *  tableau n'est jamais qu'une clé numérique), scalaires comparés par égalité STRICTE. Un
 *  changement de FORME (objet<->tableau/scalaire) OU un tableau qui RÉTRÉCIT remplace tout le
 *  sous-arbre EN BLOC à ce chemin — plutôt qu'une récursion incohérente entre deux formes
 *  différentes, ou un diff par clé qui émettrait un `x:1` par index retiré (cf. juste plus bas). */
function deepDiff(chemin: string, old: unknown, fresh: unknown, ops: MjsServerDeltaOp[]): void {
  if (old === fresh) return
  const oldObj = typeof old === 'object' && old !== null
  const newObj   = typeof fresh === 'object' && fresh !== null
  if (!oldObj || !newObj || Array.isArray(old) !== Array.isArray(fresh)) {
    ops.push({ p: chemin, v: fresh })
    return
  }
  // rétrécissement de tableau : un diff par clé émettrait `{x:1}` sur les index retirés — `delete`
  // côté client (cf. mjs_game.ts::_applyDeltaOps) laisse un TROU et ne corrige pas `.length`, d'où
  // un `undefined` en queue. Remplacement du sous-arbre EN BLOC = seul cas sûr ; un
  // tableau qui GRANDIT ou se réordonne à longueur ÉGALE garde le diff par clé (l'affectation
  // d'index étend `.length` toute seule côté client, aucun souci).
  if (Array.isArray(old) && Array.isArray(fresh) && fresh.length < old.length) {
    ops.push({ p: chemin, v: fresh })
    return
  }
  const keys = new Set([...Object.keys(old as object), ...Object.keys(fresh as object)])
  for (const key of keys) {
    const subPath = chemin ? chemin +'.'+ key : key
    const inOld = Object.prototype.hasOwnProperty.call(old, key)
    const inFresh   = Object.prototype.hasOwnProperty.call(fresh, key)
    if (inOld && !inFresh) { ops.push({ p: subPath, x: 1 }); continue }
    if (!inOld && inFresh) { ops.push({ p: subPath, v: (fresh as Record<string, unknown>)[key] }); continue }
    deepDiff(subPath, (old as Record<string, unknown>)[key], (fresh as Record<string, unknown>)[key], ops)
  }
}

export interface MjsServerSeat {
  readonly seat: number
  /** identity.id (ou id de connexion en repli, cf. peerIdOf) — stable across reconnexions SEULEMENT avec une identité authentifiée */
  readonly id: string
  /** connexions LIVE représentant ce siège en ce moment — 0+ (0 = déconnecté, cf. `connected`) */
  readonly clients: Set<MjsWsClient>
  connected: boolean
}

interface JournalEntry {
  move: string
  player: string
  p: unknown
  at: number
}

// --- anti-triche (détection par coup, TOUT opt-in via def, cf. _antiCheatGuard
// plus bas) — 3 mesures indépendantes (def.suspect métier / def.antiRejeu séquence / def.limits.
// moveIntervalMs cadence) qui partagent le MÊME journal borné + les MÊMES compteurs agrégés ---------

/** contexte transmis à def.suspect EN PLUS de `coup` (1er argument) — SURFACE MINIMALE, jamais le
 *  MjsServerSeat complet (`.clients` resterait une fuite d'état interne) : `siege` est
 *  l'INDEX numérique (même convention que _broadcastSeats()), `partie` est l'instance ENTIÈRE (MÊME
 *  accès que def.moves/intents/simulate/view, cf. game.ts) ; `type`/`tour`/`phase` = raccourcis vers
 *  partie.type/tour/phase (évite un détour par `partie.xxx` pour les 3 lectures les plus courantes).
 *  `p` (anti-triche) — charge BRUTE du coup, TELLE QUE REÇUE (jamais consommée
 *  ni mutée avant cet appel, cf. _onMove) : permet au hook d'inspecter le CONTENU du coup,
 *  pas seulement son nom — ajout PUREMENT ADDITIF, rétro-compatible (un def.suspect existant qui
 *  ignorait déjà les champs en trop du contexte continue de fonctionner à l'identique). */
export interface MjsServerSuspectContext {
  seat: number
  game: Game
  type: string
  turn: string | null
  phase: string | null
  p: unknown
}

/** retour de def.suspect — falsy (false/undefined/void) = RAS ; `true` = suspect journalisé SEUL,
 *  JAMAIS rejeté tout seul (politique de rejet PAR DÉFAUT : explicite uniquement, cf. tests) ;
 *  `{ raison?, rejeter? }` = suspect journalisé + REJETÉ si `rejeter:true` (raison par défaut
 *  'suspect' si omise) — cf. _antiCheatGuard. */
export type MjsServerSuspectResult = boolean | { reason?: string; reject?: boolean } | void

/** un événement du journal anti-triche (cf. _antiCheatLogBuf/_reportSuspicion) — MÊME forme
 *  transmise telle quelle à def.onSuspicion. `type` ICI = nom du COUP concerné (à ne pas confondre
 *  avec MjsServerSuspectContext.type = game.type, un objet différent). */
export interface MjsServerSuspicionEvent {
  time: number
  seat: number
  type: string
  reason: string
  /** `true` = le coup a été REJETÉ (pas appliqué) — sous-ensemble des événements journalisés, cf. _antiCheatLogBuf */
  rejected: boolean
}

/** compteurs anti-triche AGRÉGÉS pour l'app ENTIÈRE (tous jeux/parties confondus, jamais
 *  réinitialisés à la destruction d'UNE partie — même politique que garde.kicksDebit &c. côté
 *  mjs-ws/stats.ts) — cf. index.ts::mjsServer() pour la création + le greffage ADDITIF sur
 *  app.stats() (`game: {...}`, rétro-compatible : un mjsWs() nu ou un app.stats() déjà consommé
 *  ailleurs ne perd rien), matchmaking.ts pour le rattachement à CHAQUE partie (MÊME patron que
 *  `_onMutate`/persist.ts::armGame). */
export interface MjsServerGameStats {
  /** def.suspect véridique (rejeté ou non) + violations antiRejeu/moveIntervalMs (TOUJOURS rejetées) */
  suspectMoves: number
  /** sous-ensemble de coupsSuspects RÉELLEMENT rejeté (coup non appliqué) */
  rejectedMoves: number
}

interface TimerSnapshot { name: string; at: number }
interface SeatSnapshot {
  seat: number
  id: string
  connected: boolean
  // anti-triche par joueur — `undefined` si le joueur n'a
  // encore envoyé aucun coup à antiRejeu/cadence, jamais 0 par défaut (0 serait une SÉQUENCE valide)
  lastAntiReplaySeq?: number
  lastMoveAt?: number
}

/** cf. .serialize()/restoreGameFromSnapshot() — la couture de la persistance à venir */
export interface MjsServerGameSnapshot {
  id: string
  type: string
  code: string | null
  state: unknown
  phase: string | null
  turn: string | null
  seq: number
  journal: JournalEntry[]
  seats: Array<SeatSnapshot | null>
  timers: TimerSnapshot[]
  /** mode lockstep — µpersist = JOURNAL D'ORDRES (cf. lockstep.ts) — `undefined` pour
   *  une partie 'authoritative' (absent après un aller-retour JSON, rétro-compat totale des anciens
   *  instantanés). Pas de `seed` : ré-dérivée de `id` à la restauration, cf. deterministicSeed. */
  lockstep?: { journal: MjsServerLockstepTick[] }
}

export class Game {
  readonly id: string
  readonly type: string
  code: string | null = null
  state: unknown
  phase: string | null
  turn: string | null = null
  seq = 0
  journal: JournalEntry[] = []
  players: Array<MjsServerSeat | null>

  readonly app: MjsWsApp
  readonly def: MjsServerResolvedDef
  // tout ce qui suit est `_`-préfixé PAR CONVENTION (pas de `private` TS, MÊME parti pris que
  // MjsWsClientImpl côté mjs-ws/core.ts, cf. son commentaire de tête) : matchmaking.ts (sœur de
  // confiance) et les factory functions plus bas (hors de la classe) y accèdent directement.
  _onDestroy: (game: Game) => void
  _dirty = false
  _destroyed = false
  /** `true` dès le PREMIER .end() réussi (cf. .end() plus bas) — SÉPARÉE de `_destroyed` : une partie
   *  finie mais encore dans sa fenêtre de grâce `emptyTtl` est `_ended=true, _destroyed=false` (toujours
   *  interrogeable, cf. commentaire de tête). Rend .end() IDEMPOTENT — sans elle, un move métier
   *  qui rappelle partie.end() (pattern resign/gameOver, avant que
   *  la grâce ne rende `_destroyed` vrai) rejouait hooks.onEnd + µgame:end + réarmait `µempty` à
   *  volonté (double récompense, resultat spoofé, partie maintenue en vie indéfiniment). Jamais
   *  réinitialisée (aucun « re-end » possible, MÊME esprit que `_started` ci-dessus). */
  _ended = false
  /** `true` dès que `places` a été atteint une 1re fois (cf. matchmaking.ts µgame:start) — jamais réinitialisé */
  _started = false
  _buckets: Array<TokenBucket | null> = []
  /** anti-triche (µgame:hash) — seau à jetons DÉDIÉ par siège, canal DISTINCT de `_buckets`
   *  (coups) : cf. HASH_LIMIT/_consumeHashToken plus bas. */
  _bucketsHash: Array<TokenBucket | null> = []
  _unconfirmedSeats: Set<string> | null = null
  _timers = new Map<string, { at: number; handle: ReturnType<typeof setTimeout> }>()
  /** couture persistance (persist.ts) — posée par MjsServerPersistEngine.armGame()
   *  UNIQUEMENT si `opts.persist` est actif (sinon `null`, jamais assignée, zéro coût) : appelée à
   *  CHAQUE diffusion d'état (cf. _broadcastState ci-dessous), jamais dans le chemin chaud lui-même
   *  (le débounce/l'écriture réelle vivent entièrement côté persist.ts). */
  _onMutate: ((game: Game) => void) | null = null
  // --- mode action (cf. commentaire de tête) ----------------------------------------
  /** zone d'intérêt OPTIONNELLE (def.space) — `null` si non déclarée, cf. space.ts */
  space: MjsServerSpace | null = null
  /** tampon circulaire de positions (def.histo) — `null` si non déclaré, cf. history.ts */
  _history: MjsServerHistory | null = null
  /** mode lockstep (def.mode:'lockstep') — `null` hors lockstep, cf. lockstep.ts */
  _lockstep: MjsServerLockstep | null = null
  _tickHandle: ReturnType<typeof setInterval> | null = null
  _slowTickHandle: ReturnType<typeof setInterval> | null = null
  /** Date.now() du tick précédent — sert à mesurer `dt` RÉEL (cf. _runTick) */
  _lastTick = 0
  /** compteur de tick MONOTONE (def.histo) — jamais réinitialisé, sert de méta à rewind() */
  _tickCount = 0
  /** intentions en attente — joueur.id → (nom → dernier payload reçu), vidée à chaque tick */
  _intentQueue = new Map<string, Map<string, unknown>>()
  /** deltas (def.deltas) — joueur.id → dernière vue NORMALISÉE (JSON round-trip) envoyée */
  _lastViews = new Map<string, unknown>()
  /** couture _ack (netcode) — joueur.id → dernier `_n` APPLIQUÉ (jamais en arrière) ;
   *  `_n` est un numéro d'ordre OPTIONNEL posé par le CLIENT (µ.predict, cf.
   *  src/runtime/mjs_predict.ts) aux côtés du payload d'une intention — absent chez un jeu qui ne
   *  l'utilise pas, `_ack` n'apparaît alors JAMAIS sur la trame (cf. _buildFrame). */
  _lastAppliedN = new Map<string, number>()
  _lastPersistMark = 0
  // --- anti-triche (détection par coup, cf. section dédiée plus bas) -----------------
  /** def.antiRejeu — joueur.id → dernier seq ACCEPTÉ (`_n` s'il existe déjà côté predict, SINON `_s`
   *  dédié, cf. _extractAntiReplaySeq) — INDÉPENDANTE de `_lastAppliedN` ci-dessus (celle-ci sert
   *  SEULEMENT l'`_ack` de réconciliation predict, jamais un rejet) : lire `_n` ici ne consomme rien,
   *  ne mute rien côté predict — les deux Maps avancent en parallèle, sans jamais s'influencer. */
  _lastAntiReplaySeq = new Map<string, number>()
  /** def.limits.moveIntervalMs — joueur.id → Date.now() du dernier coup ACCEPTÉ (horloge SERVEUR,
   *  jamais côté client) — canal DISTINCT de `_buckets` (débit MOYEN, cf. plus bas) : borne la
   *  RAFALE/cadence instantanée, pas le débit sur la fenêtre. */
  _lastMoveAt = new Map<string, number>()
  /** anneau borné (JOURNAL_ANTITRICHE_MAX) des coups suspects/rejetés de CETTE partie — cf.
   *  _antiCheatLog() (lecture défensive) / _reportSuspicion (écriture) */
  _antiCheatLogBuf: MjsServerSuspicionEvent[] = []
  /** compteurs APP-ENTIÈRE — posé par matchmaking.ts APRÈS la construction (MÊME patron que
   *  `_onMutate`/persist.ts::armGame), `null` UNIQUEMENT quand une Game est construite HORS
   *  mjsServer() (fakeApp() des tests directs, cf. tests/mjs-server-anti-triche*.test.ts) — jamais en
   *  usage réel : mjsServer() (index.ts) l'arme TOUJOURS, coût négligible (même politique « toujours
   *  actif » que le registre mjs-ws/stats.ts lui-même, cf. son commentaire de tête). */
  _gameStats: MjsServerGameStats | null = null

  // --- anti-triche (spectateurs + quota inter-parties, TOUT opt-in,
  // anti-triche poussé au maximum) -------------------------------------------------------------------
  /** connexions SPECTATRICES (lecture seule) — jamais dans `this.players`, jamais comptées dans
   *  `places` (cf. _addSpectator) ; nettoyé au départ volontaire (_leave) ET à la
   *  déconnexion (_onDisconnect), cf. leurs commentaires respectifs. */
  _spectators = new Set<MjsWsClient>()
  /** avertissement « spectateur sans vue sûre » émis AU PLUS UNE FOIS par partie (jamais par
   *  diffusion — un mode action jusqu'à 60Hz spammerait sinon), cf. _spectatorView. */
  _warnedSpectatorNoView = false
  /** quota de coups PAR IDENTITÉ agrégé APP-ENTIÈRE (cf. MjsServerAntiTricheOptions.movesPerIdentity,
   *  index.ts) — posé par matchmaking.ts::create() APRÈS construction (MÊME patron que `_gameStats`
   *  ci-dessus) ; `null` = option absente (AUCUN contrôle) OU Game construite HORS mjsServer()
   *  (harnais direct des tests). Le registre RÉEL (Map identité→TokenBucket) vit ENTIÈREMENT dans
   *  matchmaking.ts (seul point qui voit toutes les parties vivantes) — cette fonction n'est qu'un
   *  simple PONT, zéro état ici. */
  _identityQuota: ((id: string) => boolean) | null = null

  constructor(app: MjsWsApp, def: MjsServerResolvedDef, onDestroy: (game: Game) => void, id: string) {
    this.app        = app
    this.def        = def
    this.type       = def.type
    this._onDestroy = onDestroy
    this.id         = id
    this.players    = new Array(def.seats).fill(null)
    this.phase      = def.phases ? (Object.keys(def.phases)[0] ?? null) : null
    this.space      = def.space ? createSpace(def.space.cell) : null
    this._history     = def.history ? createHistory(def.history.ticks) : null
    this._lockstep  = def.mode === 'lockstep' ? createLockstep(id, def.lockstepJournal?.maxTicks ?? null) : null
  }

  // --- API publique (contrat du design MJS-Server) --------------------------------------------

  /** tour suivant — 'roundrobin' (ordre des sièges) ou `turns.order` fourni ; no-op sans `turns` */
  next(): void {
    if (!this.def.turns) return
    const order = this.def.turns.order
    const nextSeat = order === 'roundrobin' ? this._nextRoundrobin() : order(this)
    this.turn = typeof nextSeat === 'string' ? nextSeat : (nextSeat ? nextSeat.id : null)
    this._armTurnTimeout()
    this._markDirty()
  }

  /** change de phase — valide contre `def.phases` SI déclaré (sinon libre, aucune restriction) */
  to(phase: string): void {
    if (this.def.phases && !(phase in this.def.phases)) {
      throw new Error(t('serveur.partie-phase-inconnue', { phase: phase, phases: Object.keys(this.def.phases).join(', ') }))
    }
    this.phase = phase
    this._markDirty()
  }

  /** arme/réarme une minuterie NOMMÉE — à l'échéance, appelle `def.timers[nom](partie)`.
   *  Sérialisable ({nom, à}, cf. serialize()) : jamais de fermeture stockée. */
  timer(name: string, ms: number): void {
    if (RESERVED_TIMER_NAMES.has(name)) throw new Error(t('serveur.partie-timer-nom-reserve', { nom: name }))
    this._armByName(name, ms)
  }

  /** événement applicatif (µgame:event) à tous les sièges CONNECTÉS */
  send(type: string, p?: unknown): void {
    this._broadcastTo('µgame:event', { type, p })
  }

  /** vue filtrée par joueur (`def.view`, défaut = état entier) — jamais accédée à `def` en dehors de
   *  ce fichier. Throw en mode 'lockstep' (def.view est `null`, cf. game.ts) — ne devrait jamais être
   *  appelée pour une partie lockstep (aucun état serveur), cf. _infoMode/_broadcastTickOrders. */
  viewFor(player: MjsServerSeat | null): unknown {
    if (!this.def.view) throw new Error(t('serveur.partie-vuede-lockstep'))
    return this.def.view(this, player)
  }

  /** partie du protocole SPÉCIFIQUE au mode — 'authoritative' : `{ view: viewFor(player) }` ;
   *  'lockstep' : `{ seed, journal }` (graine + historique COMPLET des ordres, cf. lockstep.ts) — le
   *  client rejoue le journal pour rattraper l'état commun (cf. µ.lockstep, mjs_lockstep.ts). Point
   *  UNIQUE consommé par les 3 réponses qui portent l'identité de siège (seatResponse/pushStart
   *  côté matchmaking.ts, _resync ci-dessous) — jamais dupliqué. */
  _infoMode(player: MjsServerSeat | null): Record<string, unknown> {
    if (this.def.mode === 'lockstep') return { seed: this._lockstep!.seed, journal: this._lockstep!.journal() }
    return { view: this.viewFor(player) }
  }

  /** compensation de lag serveur (def.histo) — rembobine le tampon d'historique à l'instant
   *  `instantMs` (ms epoch, Date.now()-like ; borné : plus vieille entrée dispo si `instantMs` est
   *  trop ancien, entrée du tick COURANT si `instantMs` est dans le futur, cf. history.ts) : appelle
   *  `fn(positionsFigées, méta)` et RETOURNE tel quel son résultat. `positionsFigées` = COPIE gelée
   *  (Object.freeze, l'objet ET chaque {x,y}) de l'instantané retenu — jamais l'original de l'anneau,
   *  jamais mutable (cf. history.ts pour la justification). Throw si `def.histo` n'est pas déclaré, ou
   *  si le tampon est vide (aucun tick encore écoulé, ou partie détruite). */
  rewind<T>(instantMs: number, fn: (positions: MjsServerHistoryPositions, meta: MjsServerHistoryMeta) => T): T {
    if (!this._history) throw new Error(t('serveur.partie-rembobiner-sans-histo'))
    return this._history.rewind(instantMs, fn)
  }

  /** compensation de lag serveur (def.histo) — instant (ms epoch) que CE joueur voyait au
   *  moment où il a agi = maintenant − (latence aller estimée de SA connexion + retard
   *  d'interpolation déclaré, def.histo.interp) ; latence lue sur `client.latency` (MJS-WS, déjà
   *  mesurée par le réservoir ping/pong, cf. mjs-ws/core.ts handlePing) de la 1re connexion LIVE de
   *  ce siège — déconnecté ou latence pas-encore-mesurée (`null`) replient sur 0 (aucune
   *  compensation par défaut, jamais un throw pour une mesure simplement absente). Throw si
   *  `def.histo` n'est pas déclaré (pas de `interp` par défaut sans lui). */
  timeSeenBy(player: MjsServerSeat): number {
    if (!this.def.history) throw new Error(t('serveur.partie-instantvupar-sans-histo'))
    let latency = 0
    for (const client of player.clients) { latency = client.latency ?? 0; break }
    return Date.now() - (latency + this.def.history.interp)
  }

  /** fin de partie — µgame:end + hooks.onEnd, puis destruction après une grâce `def.emptyTtl`
   *  (laisse un dernier resync voir l'issue avant que la partie ne disparaisse du registre).
   *  IDEMPOTENT (cf. `_ended`) : un 2e appel (avant OU après la grâce) est un NO-OP total — pas de
   *  2e diffusion µgame:end, pas de 2e hooks.onEnd, pas de réarmement de `µempty` (sinon la partie
   *  resterait vivante indéfiniment tant qu'un move rejoue .end() sous le quota limits.moves). */
  end(result: unknown): void {
    if (this._destroyed || this._ended) return
    this._ended = true
    this._stopTickLoop()
    this._broadcastTo('µgame:end', { result })
    this.def.hooks.onEnd?.(this, result)
    this._armByName('µempty', this.def.emptyTtl)
  }

  /** état+phase+sièges+minuteries+journal → objet JSON-able — couture de la persistance.
   *  Mode lockstep : `lockstep: { journal }` REMPLACE `state` conceptuellement (µpersist =
   *  journal d'ordres, cf. lockstep.ts) — `state` reste présent mais vaut `undefined` (jamais assigné,
   *  cf. le constructeur matchmaking.ts::create()), élidé par JSON.stringify. */
  serialize(): MjsServerGameSnapshot {
    return {
      id:      this.id,
      type:    this.type,
      code:    this.code,
      state:   this.state,
      phase:   this.phase,
      turn:    this.turn,
      seq:     this.seq,
      journal: this.journal.slice(),
      // anti-triche par joueur repeuplé au restore — _buckets (cadence flood) repart PLEIN
      // par design (TokenBucket non sérialisable proprement, risque moindre qu'un rejeu accepté)
      seats: this.players.map(j => j ? { seat: j.seat, id: j.id, connected: j.connected, lastAntiReplaySeq: this._lastAntiReplaySeq.get(j.id), lastMoveAt: this._lastMoveAt.get(j.id) } : null),
      timers: Array.from(this._timers.entries()).map(([name, t]) => ({ name, at: t.at })),
      lockstep: this._lockstep ? { journal: this._lockstep.journal() } : undefined,
    }
  }

  // --- usage interne (matchmaking.ts) — hors du contrat MjsServerApp -------------------------

  /** siège existant occupé par CETTE connexion, sinon `null` */
  _findSeatOf(client: MjsWsClient): MjsServerSeat | null {
    return this.players.find((j): j is MjsServerSeat => j !== null && j.clients.has(client)) ?? null
  }

  /** assigne un siège à cette connexion — POINT D'ENTRÉE UNIQUE, appelé par TOUT chemin
   *  d'attribution (file publique ET code privé, cf. matchmaking.ts::playQueued/createWithCode/
   *  joinWithCode) : la dédup ci-dessous les couvre donc tous les trois d'un coup.
   *
   *  Dédup par IDENTITÉ (anti-triche) — si `peerIdOf(client)` occupe DÉJÀ un siège de
   *  CETTE partie (2e onglet d'une même session, spam de µgame:play après appariement…), on
   *  RÉATTACHE cette connexion au siège EXISTANT (MÊME logique que _reattachSeat — une
   *  reconnexion/2e onglet, réutilisée telle quelle) plutôt que d'en créer un 2e : sans ça, une
   *  identité pourrait voir SES DEUX mains cachées à la fois et casser le tour par tour (2 sièges
   *  = 2 `joueur.id` identiques dans `this.players`, cf. game.ts:321-331). Choix
   *  assumé : RÉATTACHER (jamais refuser) — symétrique de _resync, qui fait déjà exactement ça
   *  pour reconnecter un onglet après coupure ; refuser aurait cassé le cas légitime « 2 onglets
   *  ouverts par erreur, l'utilisateur ferme le premier » (le 2e doit continuer à fonctionner).
   *  Les identités ANONYMES (pas d'identity.id stable, repli sur l'id de CONNEXION — cf. peerIdOf)
   *  restent distinctes PAR CONSTRUCTION : chaque connexion sans identité stable EST sa propre
   *  identité, la dédup y est inévitablement inopérante — limite documentée, pas un trou (seule
   *  une identité authentifiée stable, cf. opts.auth, bénéficie de la protection).
   *
   *  Sinon (aucun siège existant pour cette identité) : assigne un siège NEUF (1er emplacement
   *  libre) — throw si complète. */
  _createSeat(client: MjsWsClient): MjsServerSeat {
    const existing = this._reattachSeat(client)
    if (existing) { this._broadcastSeats(); return existing }
    const index = this.players.findIndex(j => j === null)
    if (index === -1) throw new Error(t('serveur.partie-complete'))
    const player: MjsServerSeat = { seat: index, id: peerIdOf(client), clients: new Set([client]), connected: true }
    this.players[index] = player
    this.def.hooks.onJoin?.(this, player)
    this._broadcastSeats()
    this._markDirty()
    this._checkEmpty()   // démarre la boucle de tick au 1er siège CONNECTÉ (mode action, cf. _checkEmpty) — no-op en mode événementiel (tick=0)
    return player
  }

  /** rattache CETTE connexion à un siège EXISTANT de même identité (reconnexion) — `null` si aucun */
  _reattachSeat(client: MjsWsClient): MjsServerSeat | null {
    const id = peerIdOf(client)
    const player = this.players.find((j): j is MjsServerSeat => j !== null && j.id === id) ?? null
    if (!player) return null
    player.clients.add(client)
    player.connected = true
    this._checkEmpty()
    return player
  }

  /** µgame:resync — rattache + info fraîche COMPLÈTE (vue, ou seed+journal en mode lockstep, cf.
   *  _infoMode : « à la reconnexion, le client reçoit seed + journal et rejoue ») */
  _resync(client: MjsWsClient): { seat: number; info: Record<string, unknown> } {
    const player = this._reattachSeat(client)
    if (!player) throw new Error(t('serveur.partie-pas-dans-partie'))
    this._confirmSeat(player.id)
    this._broadcastSeats()
    const info = this._infoMode(player)
    // resync = TOUJOURS une vue complète (jamais un delta) ; en mode deltas
    // (authoritative SEUL — lockstep n'a pas de `vue`, cf. _infoMode), ce qui vient d'être envoyé
    // DEVIENT la baseline — le prochain _buildFrame() pourra delta-er dessus au lieu de
    // re-considérer ce joueur comme « jamais vu » (repli inutile)
    if (this.def.deltas) this._lastViews.set(player.id, JSON.parse(JSON.stringify(info.view)))
    return { seat: player.seat, info }
  }

  // --- spectateurs (anti-triche, lecture seule) ------------------------------------

  /** rejoint comme SPECTATEUR — n'occupe AUCUN siège (jamais dans `this.players`, jamais compté
   *  dans `places`) : ajoute la connexion à `_spectators` et renvoie une info fraîche COMPLÈTE
   *  (MÊME enveloppe `{view}` que seatResponse/_resync côté matchmaking.ts, cf. _infoSpectateur)
   *  pour l'ack de la requête. Tout µgame:move ultérieur de cette connexion est rejeté PAR
   *  CONSTRUCTION (_findSeatOf ne cherche que dans `this.players`, cf. _onMove plus
   *  bas — message précisé « spectateur : lecture seule »). Idempotent (Set) : rejouer la même
   *  requête avec la MÊME connexion ne fait rien de plus. */
  _addSpectator(client: MjsWsClient): { view: unknown } {
    this._spectators.add(client)
    return this._spectatorInfo()
  }

  /** vue SÛRE d'un spectateur — cf. def.spectatorView (game.ts::resolveGameDef, RÉSOUT DÉJÀ le
   *  repli sur le `view` AUTEUR le cas échéant, jamais le défaut état-complet) : `null` = aucune
   *  vue sûre disponible pour CE jeu → repli `{}` STRICT (JAMAIS l'état brut à un spectateur par
   *  défaut), avec un avertissement émis UNE SEULE FOIS par partie (guard
   *  `_warnedSpectatorNoView` ci-dessous — jamais par diffusion, un mode action à 60Hz spammerait sinon). */
  _spectatorView(): unknown {
    if (this.def.spectatorView) return this.def.spectatorView(this)
    if (!this._warnedSpectatorNoView) {
      this._warnedSpectatorNoView = true
      this.def.log('warn', t('serveur.partie-spectateur-sans-vue', { type: this.type }))
    }
    return {}
  }

  /** enveloppe `{view}` d'un spectateur — MÊME point unique que _infoMode(player) pour les sièges,
   *  mais SANS branche lockstep (seed/journal) : un spectateur ne rejoue rien localement, une
   *  simple vue lui suffit quel que soit `def.mode` (def.spectatorView reste mode-agnostique,
   *  cf. game.ts). */
  _spectatorInfo(): { view: unknown } {
    return { view: this._spectatorView() }
  }

  /** µgame:leave volontaire — vide le siège (contrairement à une déconnexion, qui le garde). Gère
   *  aussi un spectateur (anti-triche) : retrait silencieux de `_spectators`, AUCUNE
   *  diffusion µgame:left (réservée aux sièges, cf. _broadcastSeats) — permet à sock.leave() côté
   *  client de fonctionner SANS changement, qu'il s'agisse d'une poignée siège OU spectateur. */
  _leave(client: MjsWsClient): void {
    const player = this._findSeatOf(client)
    if (player) {
      this.players[player.seat] = null
      this.def.hooks.onLeave?.(this, player)
      this._broadcastTo('µgame:left', { seat: player.seat })
      if (this.def.turns && this.turn === player.id) this.next()
      this._broadcastSeats()
      this._markDirty()
      this._checkEmpty()
      return
    }
    if (this._spectators.delete(client)) return
    throw new Error(t('serveur.partie-pas-assis'))
  }

  /** déconnexion (MJS-WS opts.onDisconnect) — marque le siège déconnecté SANS le vider ; la
   *  partie continue (tour par tour social, pas de kick auto v1). Un spectateur (anti-triche),
   *  lui, est retiré PURE ET SIMPLEMENT (aucun « siège déconnecté » à conserver pour un
   *  rôle en lecture seule — cf. _addSpectator, jamais de resync spectateur v1). Retourne
   *  `true` si ce client occupait bien un siège OU regardait ICI (matchmaking s'en sert pour
   *  arrêter de chercher ailleurs). */
  _onDisconnect(client: MjsWsClient): boolean {
    const player = this.players.find((j): j is MjsServerSeat => j !== null && j.clients.has(client)) ?? null
    if (player) {
      player.clients.delete(client)
      if (player.clients.size === 0) player.connected = false
      this._broadcastSeats()
      this._markDirty()
      this._checkEmpty()
      return true
    }
    return this._spectators.delete(client)
  }

  /** coup reçu — vérifs (assis, phase, tour, anti-abus) puis `def.moves[coup](partie, joueur, p)` ;
   *  un throw (garde ICI ou dans le move lui-même) remonte tel quel — matchmaking.ts le laisse
   *  filer jusqu'à app.serve (µ:ack{e:true}, comme tout serve() normal). */
  _onMove(client: MjsWsClient, move: string, p: unknown): unknown {
    // partie déjà terminée (fenêtre de grâce `emptyTtl`) — la partie reste interrogeable (resync)
    // mais plus JOUABLE : aucun coup ne mute l'état ni ne se diffuse après .end()
    if (this._ended) throw new Error(t('serveur.partie-terminee'))
    const player = this._findSeatOf(client)
    if (!player) {
      // anti-triche — message DÉDIÉ pour un spectateur CONNU (plutôt que le message
      // générique ci-dessous) : _findSeatOf ne cherche que dans `this.players`, un spectateur
      // n'y est jamais — cette garde est donc déjà, PAR CONSTRUCTION, ce qui rejette tout
      // µgame:move d'un spectateur (rien à ajouter côté autorisation, juste un message plus clair).
      if (this._spectators.has(client)) throw new Error(t('serveur.partie-spectateur-lecture-seule'))
      throw new Error(t('serveur.partie-pas-assis'))
    }
    if (this.def.phases && !(this.def.phases[this.phase ?? ''] ?? []).includes(move)) {
      throw new Error(t('serveur.partie-coup-interdit-phase', { coup: move, phase: this.phase }))
    }
    // `this.turn === null` = aucun tour encore établi (avant le 1er .next(), ex. une phase
    // d'attente/prêt-check) : personne n'est bloqué tant que .next() n'a jamais tourné une 1re
    // fois — la garde ne parle qu'une fois un VRAI tour en cours
    if (this.def.turns && this.turn !== null && this.turn !== player.id) throw new Error(t('serveur.partie-pas-votre-tour'))

    // anti-triche (détection par coup, TOUT opt-in — def.suspect/antiRejeu/limits.
    // moveIntervalMs) — cf. _antiCheatGuard : s'applique UNIFORMÉMENT aux 3 branches
    // ci-dessous (lockstep compris — un ORDRE est un coup pour ces gardes génériques, cf. sa
    // propre doc), AVANT toute exécution/mise en file/ordre ; no-op quasi total si rien n'est déclaré.
    this._antiCheatGuard(player, move, p)

    // mode lockstep — AUCUNE exécution serveur : chaque µgame:move devient un ORDRE en
    // file pour le tick COURANT (cf. lockstep.ts addOrder), diffusé GROUPÉ par _broadcastTickOrders
    // au tick suivant — jamais de résultat (l'ack matchmaking.ts::handlerMove reste {ok:true,
    // resultat:undefined}, INCHANGÉ), jamais `this.journal` (celui-ci reste le journal COURT v1 du
    // mode authoritative, cf. commentaire de tête — le VRAI journal lockstep vit dans `this._lockstep`,
    // illimité, cf. son fichier). `coup` n'est PAS validé contre `def.moves` — n'importe quel nom
    // devient un ordre valide (aucune whitelist demandée : chaque µgame:move reçu devient
    // un ORDRE, sans condition).
    if (this.def.mode === 'lockstep') {
      if (!this._consumeToken(player)) throw new Error(t('serveur.partie-trop-de-coups'))
      this._confirmSeat(player.id)
      this._lockstep!.addOrder(player.id, move, p)
      return undefined
    }

    // le jeton anti-abus se consomme AVANT toute résolution du nom de coup (intent ou classique) —
    // sinon un spam de noms INEXISTANTS n'entame jamais le seau (contournement du quota)
    if (!this._consumeToken(player)) throw new Error(t('serveur.partie-trop-de-coups'))

    // mode action (def.intents, MÊME canal µgame:move que les coups classiques) — MISE EN FILE,
    // JAMAIS exécutée ici : la DERNIÈRE valeur gagne par nom (un spam de 'bouger' ne garde que la
    // dernière direction) ; appliquée par la boucle au tick suivant
    // (_applyIntents) — ni journal (débit trop élevé pour les 200 entrées bornées, cf.
    // commentaire de tête du fichier) ni _markDirty (l'état n'a pas encore changé)
    const intentFn = this.def.intents[move]
    if (intentFn) {
      this._confirmSeat(player.id)
      let queue = this._intentQueue.get(player.id)
      if (!queue) { queue = new Map(); this._intentQueue.set(player.id, queue) }
      queue.set(move, p)
      return undefined
    }

    const fn = this.def.moves[move]
    if (!fn) throw new Error(t('serveur.partie-coup-inconnu', { coup: move }))
    this._confirmSeat(player.id)
    const result = fn(this, player, p)
    this.journal.push({ move, player: player.id, p, at: Date.now() })
    if (this.journal.length > JOURNAL_MAX) this.journal.shift()
    this._markDirty()
    return result
  }

  /** µgame:hash (mode lockstep ; anti-triche) — reçoit un hash d'état
   *  PÉRIODIQUE d'un joueur pour `tick` (cf. lockstep.ts receiveHash pour le modèle quorum +
   *  auto-contradiction + fenêtre) — SILENCIEUX en fonctionnement normal (hashs concordants, ou
   *  quorum pas encore atteint) ; une divergence identifiée (auto-contradiction OU minorité face au
   *  hash majoritaire, JAMAIS la majorité elle-même) → µgame:event 'divergence' à TOUS +
   *  def.onDivergence (le jeu décide). `sieges` = TOUS les sièges OCCUPÉS de cette
   *  partie, connectés ou non (MÊME politique que le tour par tour roundrobin, cf. commentaire de
   *  tête) — relu à CET appel (jamais figé), sert de base à la majorité absolue côté lockstep.ts.
   *  Anti-abus dédié AVANT tout traitement (_consumeHashToken, cf. HASH_LIMIT) : au-delà du
   *  budget, le rapport est silencieusement ignoré (comme toute autre garde ICI). No-op si
   *  non-lockstep/joueur inconnu — jamais un throw : trame reçue via app.on (fire-and-forget, cf.
   *  matchmaking.ts::handlerHash), aucun ack possible de toute façon. */
  _receiveHash(client: MjsWsClient, tick: number, h: string): void {
    // même garde que _onMove — une partie terminée ne mute ni ne diffuse plus rien,
    // fire-and-forget : on ignore silencieusement plutôt que throw (aucun ack possible ici)
    if (this._ended) return
    if (this.def.mode !== 'lockstep' || !this._lockstep) return
    const player = this._findSeatOf(client)
    if (!player) return
    if (!this._consumeHashToken(player)) return
    const seats = this.players.filter((j): j is MjsServerSeat => j !== null).length
    const divergence = this._lockstep.receiveHash(player.id, tick, h, seats)
    if (!divergence) return
    this.send('divergence', divergence)
    this.def.onDivergence?.(this, divergence)
  }

  /** ouvre la fenêtre de confirmation seatTtl (parties issues de la file, cf. matchmaking.ts) —
   *  `unconfirmedIds` = sièges qui n'ont pas eux-mêmes déclenché la complétion du groupe. */
  _armConfirmWindow(unconfirmedIds: string[], ms: number): void {
    if (unconfirmedIds.length === 0) return
    this._unconfirmedSeats = new Set(unconfirmedIds)
    this._armByName('µmatch', ms)
  }

  /** un siège « arrive » (coup, resync — cf. leurs appelants ci-dessus) : sort de la fenêtre de confirmation */
  _confirmSeat(id: string): void {
    if (!this._unconfirmedSeats) return
    this._unconfirmedSeats.delete(id)
    if (this._unconfirmedSeats.size === 0) { this._disarm('µmatch'); this._unconfirmedSeats = null }
  }

  /** force la destruction (timers coupés) — appelée par les échéances internes ET par
   *  index.ts (app.stop()) pour ne laisser AUCUN setTimeout survivre à l'arrêt du serveur */
  _destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    this._stopTickLoop()   // garde-fou ULTIME — inconditionnel, même si des sièges restaient connectés (cf. .end()/_checkEmpty pour les arrêts normaux)
    this.space?._clear()
    this._history?._clear()
    this._lockstep?._clear()
    for (const t of this._timers.values()) clearTimeout(t.handle)
    this._timers.clear()
    this._onDestroy(this)
  }

  // --- diffusion ------------------------------------------------------------------------------

  /** bas niveau : MÊME charge `p` à tous les sièges CONNECTÉS (µgame:end/left/seat/event) */
  _broadcastTo(type: string, p: Record<string, unknown>): void {
    const frame = { game: this.id, ...p }
    for (const player of this.players) {
      if (!player) continue
      for (const client of player.clients) this.app.send(client, type, frame)
    }
  }

  /** µgame:seat — instantané léger du roster (places/connexion), séparé de µgame:state */
  _broadcastSeats(): void {
    const seats = this.players.map(j => j ? { seat: j.seat, connected: j.connected } : null)
    this._broadcastTo('µgame:seat', { seatCount: this.def.seats, seats })
  }

  /** construit la trame µgame:state POUR CE JOUEUR — vue complète (défaut, ou repli deltas) ou
   *  delta (def.deltas actif) ; `null` = rien à envoyer (deltas actif, AUCUN changement pour lui
   *  depuis la dernière fois — zéro trame). Chemin non-delta byte-identique
   *  au v1 (MÊME ordre de clés) — compatibilité stricte, cf. tests/socket-game.test.ts.
   *  `_ack` (netcode) : MÉTA de trame (jamais dans `vue`/`delta`, jamais dans le JEU) —
   *  posé UNIQUEMENT si CE joueur a déjà fait appliquer au moins un `_n` (cf. `_lastAppliedN` /
   *  `_extractN`) ; absent sinon, `meta` est alors un objet VIDE dont le spread ne change RIEN à la
   *  forme historique de la trame — rétro-compat totale pour un jeu qui n'utilise jamais `_n`. */
  _buildFrame(player: MjsServerSeat): Record<string, unknown> | null {
    const ack = this._lastAppliedN.get(player.id)
    const meta = ack != null ? { _ack: ack } : {}
    if (!this.def.deltas) return { game: this.id, view: this.viewFor(player), phase: this.phase, turn: this.turn, seq: this.seq, ...meta }

    const base = { game: this.id, phase: this.phase, turn: this.turn, seq: this.seq, ...meta }
    // normalisation JSON — MÊME forme que ce qui voyage réellement sur le fil (le transport
    // JSON.stringify la trame de toute façon) : clone STABLE, jamais aliasé à partie.state (une vue
    // qui réutilise des objets internes mutés en place casserait le diff)
    const viewNorm = JSON.parse(JSON.stringify(this.viewFor(player))) as unknown
    if (!this._lastViews.has(player.id)) {
      this._lastViews.set(player.id, viewNorm)
      return { ...base, view: viewNorm }   // repli : 1re diffusion à CE joueur
    }
    const ops: MjsServerDeltaOp[] = []
    deepDiff('', this._lastViews.get(player.id), viewNorm, ops)
    this._lastViews.set(player.id, viewNorm)
    if (ops.length === 0) return null   // rien n'a changé POUR LUI — aucune trame

    const viewSize   = JSON.stringify(viewNorm).length
    const deltaSize = JSON.stringify(ops).length
    if (deltaSize > viewSize * 0.6) return { ...base, view: viewNorm }   // repli : delta trop gros
    return { ...base, delta: ops }
  }

  /** diffuse à CHAQUE siège SA trame (ou rien, cf. _buildFrame) — `seq` incrémenté UNE fois
   *  par APPEL (round de diffusion, pas par joueur ni par mutation brute) ; partagée par
   *  _broadcastState (microtâche, tick=0) et _broadcastTick (1×/tick, tick>0) — seule la CADENCE change. */
  _broadcastToPlayers(): void {
    this.seq++
    for (const player of this.players) {
      if (!player) continue
      const frame = this._buildFrame(player)
      if (!frame) continue
      for (const client of player.clients) this.app.send(client, 'µgame:state', frame)
    }
    this._broadcastToSpectators()
  }

  /** anti-triche — diffuse l'état à TOUS les spectateurs (vue SÛRE, cf. _spectatorView) :
   *  contrairement aux sièges (cf. _buildFrame), TOUJOURS une vue COMPLÈTE, jamais de delta —
   *  simplicité assumée (aucun `_lastViews` par spectateur : lecture seule, pas de couture
   *  predict/ack à préserver). No-op si aucun spectateur (Set vide, coût nul). Appelée depuis
   *  _broadcastToPlayers (couvre événementiel ET action) ET _broadcastTickOrders (lockstep, qui ne
   *  passe jamais par _broadcastToPlayers) — MÊME `seq` que la diffusion joueurs du round. */
  _broadcastToSpectators(): void {
    if (this._spectators.size === 0) return
    const frame = { game: this.id, ...this._spectatorInfo(), phase: this.phase, turn: this.turn, seq: this.seq }
    for (const client of this._spectators) this.app.send(client, 'µgame:state', frame)
  }

  /** mode événementiel (tick=0) — groupe les mutations d'une même microtâche en UNE diffusion */
  _broadcastState(): void {
    this._dirty = false
    if (this._destroyed) return
    this._broadcastToPlayers()
    this._onMutate?.(this)
  }

  /** mode action (tick>0) — UNE diffusion PAR TICK, après def.simulate (cf. _runTick) ;
   *  jamais additionnée à _broadcastState (_markDirty est un no-op tant que tick>0, cf. plus bas).
   *  Pousse aussi l'instantané d'historique (def.histo, cf. history.ts) — MÊME emplacement
   *  « après simulate, 1×/tick » que la diffusion, avant elle (l'ordre entre les deux n'a pas
   *  d'importance, aucune dépendance croisée) : compensation de lag serveur, cf. game.rewind. */
  _broadcastTick(): void {
    if (this._destroyed) return
    if (this._history) { this._tickCount++; this._history.pousser(this._tickCount, Date.now(), this.def.history!.extract(this)) }
    this._broadcastToPlayers()
    this._markDirtyTick()
  }

  /** mode lockstep — clôt le tick courant (lockstep.ts : ordres accumulés + journal) et
   *  DIFFUSE la MÊME trame à TOUS les sièges connectés (µgame:orders {tick, ordres}) — même frame pour
   *  tous, l'égalité d'entrée est le cœur du déterminisme (cf. commentaire de tête de lockstep.ts).
   *  TOUJOURS diffusé, MÊME sans ordre (tick vide) : le tick lui-même est l'horloge commune que les
   *  clients doivent avancer (jamais de trame sautée faute d'ordre). `seq` réutilisé
   *  comme compteur de tick (cf. commentaire de _runTick) — jamais incrémenté par
   *  _broadcastToPlayers ici (aucune vue/delta en lockstep, cf. _infoMode). */
  _broadcastTickOrders(): void {
    if (this._destroyed) return
    const group = this._lockstep!.closeTick()
    this.seq = group.tick
    this._broadcastTo('µgame:orders', { tick: group.tick, orders: group.orders })
    this._broadcastToSpectators()
    this._markDirtyTick()
  }

  /** groupe les mutations d'une même microtâche en UNE diffusion — SUSPENDU
   *  en mode action (def.tick > 0) : la cadence de diffusion appartient alors exclusivement à la
   *  boucle de tick (_broadcastTick), jamais à une microtâche (cf. commentaire de tête du fichier) */
  _markDirty(): void {
    if (this.def.tick > 0) return
    if (this._dirty || this._destroyed) return
    this._dirty = true
    queueMicrotask(() => this._broadcastState())
  }

  /** persistance en mode action — cf. commentaire de tête (throttle LOCAL, indépendant du débounce
   *  de persist.ts qui reste seul maître du LISSAGE/de l'ÉCRITURE réels) */
  _markDirtyTick(): void {
    if (this._destroyed || !this._onMutate) return
    const now = Date.now()
    if (now - this._lastPersistMark < TICK_PERSIST_THROTTLE_MS) return
    this._lastPersistMark = now
    this._onMutate(this)
  }

  /** aucun siège CONNECTÉ → arme la destruction après `emptyTtl` (+ coupe la boucle de tick) ; un
   *  retour désarme ET (re)démarre la boucle (mode action) — couvre aussi bien un 1er siège frais
   *  (cf. _createSeat) qu'un resync après coupure (cf. _reattachSeat) */
  _checkEmpty(): void {
    if (this.players.some(j => j && j.connected)) { this._disarm('µempty'); this._startTickLoop(); return }
    this._armByName('µempty', this.def.emptyTtl)
    this._stopTickLoop()
  }

  // --- mode action — boucle de tick (def.tick Hz) + slowTick (def.slowTick) -------------------

  /** démarre la boucle — no-op si déjà tournante/tick=0/partie détruite (cf. _checkEmpty, .end(),
   *  ._destroy() pour les points d'arrêt : AUCUN setInterval ne doit jamais rester résiduel) */
  _startTickLoop(): void {
    if (this.def.tick <= 0 || this._tickHandle || this._destroyed) return
    const period = 1000 / this.def.tick
    this._lastTick = Date.now()
    this._tickHandle = setInterval(() => this._runTick(), period)
    if (this.def.slowTick) {
      const slowPeriod = 1000 / this.def.slowTick.hz
      this._slowTickHandle = setInterval(() => { if (!this._destroyed) this._guardTick('slowTick', () => this.def.slowTick!.fn(this)) }, slowPeriod)
    }
  }

  _stopTickLoop(): void {
    if (this._tickHandle) { clearInterval(this._tickHandle); this._tickHandle = null }
    if (this._slowTickHandle) { clearInterval(this._slowTickHandle); this._slowTickHandle = null }
  }

  /** garde-fou boucle de tick — capture SYNC (throw) et ASYNC (rejet) du seul code
   *  JEU appelé nu dans le setInterval (def.intents/def.simulate/def.slowTick.fn) : sans elle, une
   *  exception y est invisible (diffusion broadcast, aucun client à qui répondre). Log seul, AUCUN
   *  changement de gameplay. NE PAS l'étendre au code interne du framework (_broadcastTick,
   *  _broadcastTickOrders, _applyIntents elle-même) — un throw là est un bug framework à
   *  laisser remonter, pas à masquer. */
  _guardTick(what: string, fn: () => unknown): void {
    try {
      const r = fn()
      if (r && typeof (r as any).then === 'function') {
        (r as Promise<unknown>).catch((err: unknown) => this.def.log('error', t('serveur.partie-tick-rejete', { quoi: what, msg: errMessage(err) })))
      }
    } catch (err) {
      this.def.log('error', t('serveur.partie-tick-leve', { quoi: what, msg: errMessage(err) }))
    }
  }

  /** intentions en file → def.simulate → UNE diffusion. `dt` = écart RÉEL mesuré depuis le tick
   *  précédent (Date.now(), jamais la période nominale figée) — correction de dérive SIMPLE : le
   *  `setInterval` peut driver légèrement, la simulation reçoit quand même le temps VRAIMENT écoulé.
   *  Mode lockstep : AUCUNE intention/simulation serveur (interdites, cf. game.ts) —
   *  clôture du tick d'ordres SEULE (_broadcastTickOrders), cf. commentaire de tête du fichier. */
  _runTick(): void {
    if (this._destroyed) return
    const now = Date.now()
    const dt = now - this._lastTick
    this._lastTick = now
    if (this.def.mode === 'lockstep') { this._broadcastTickOrders(); return }
    this._applyIntents()
    this._guardTick('simulate', () => this.def.simulate?.(this, dt))
    this._broadcastTick()
  }

  /** applique la file accumulée depuis le tick précédent — ordre des SIÈGES (arrivée), PAS l'ordre
   *  de réception réseau ; la file est vidée après coup (nouvelle fenêtre pour le tick suivant).
   *  Couture _ack (netcode) : `_extractN` détache un `_n` numérique éventuel AVANT
   *  l'appel à `fn` — le jeu reçoit un payload STRICTEMENT identique à ce qu'il recevrait sans la
   *  couture, aucune fuite de méta-donnée protocole dans `def.intents`. */
  _applyIntents(): void {
    if (this._intentQueue.size === 0) return
    for (const player of this.players) {
      if (!player) continue
      const queue = this._intentQueue.get(player.id)
      if (!queue) continue
      for (const [name, p] of queue) { const fn = this.def.intents[name]; if (fn) this._guardTick('intent:'+ name, () => fn(this, player, this._extractN(player.id, p))) }
    }
    this._intentQueue.clear()
  }

  /** détache `_n` (numéro d'ordre CLIENT optionnel, cf. commentaire de `_lastAppliedN`) d'un
   *  payload d'intention — `p` inchangé si absent/non-numérique (rétro-compat totale). Avance
   *  `_lastAppliedN[joueurId]` au PLUS GRAND `_n` vu (jamais en arrière — l'ordre des sièges
   *  n'est pas forcément l'ordre d'émission), renvoie un CLONE superficiel de `p` sans `_n`. */
  _extractN(playerId: string, p: unknown): unknown {
    if (!p || typeof p !== 'object' || !('_n' in (p as object))) return p
    const { _n, ...reste } = p as Record<string, unknown>
    if (typeof _n === 'number') {
      const last = this._lastAppliedN.get(playerId)
      if (last == null || _n > last) this._lastAppliedN.set(playerId, _n)
    }
    return reste
  }

  _cancel(reason: string): void {
    this._broadcastTo('µgame:end', { result: { cancelled: true, reason } })
    this._destroy()
  }

  // --- minuteries — {nom, à} sérialisable, jamais de fermeture stockée (cf. .timer() public) ---

  _armByName(name: string, ms: number): void {
    const onExpire = RESERVED_TIMER_NAMES.has(name) ? () => this._onReservedTimer(name) : () => { const fn = this.def.timers[name]; if (fn) fn(this) }
    this._arm(name, ms, onExpire)
  }

  _arm(name: string, ms: number, onExpire: () => void): void {
    const existing = this._timers.get(name)
    if (existing) clearTimeout(existing.handle)
    const at = Date.now() + ms
    const handle = setTimeout(() => { this._timers.delete(name); onExpire() }, ms)
    this._timers.set(name, { at, handle })
  }

  _disarm(name: string): void {
    const existing = this._timers.get(name)
    if (existing) { clearTimeout(existing.handle); this._timers.delete(name) }
  }

  _armTurnTimeout(): void {
    if (!this.def.turns || !this.def.turns.timeout) return
    this._armByName('µturn', this.def.turns.timeout)
  }

  _onReservedTimer(name: string): void {
    if (name === 'µturn') this._onTurnExpired()
    else if (name === 'µmatch') this._onMatchExpired()
    else if (name === 'µempty') this._onEmptyExpired()
  }

  _onTurnExpired(): void {
    if (this.def.hooks.onTurnTimeout) this.def.hooks.onTurnTimeout(this)
    else this.next()
  }

  _onMatchExpired(): void {
    if (!this._unconfirmedSeats || this._unconfirmedSeats.size === 0) return
    this._cancel('seat-expired')
  }

  _onEmptyExpired(): void {
    this._destroy()
  }

  // --- anti-abus (limits.moves) — seau à jetons PAR SIÈGE, TokenBucket réutilisée de mjs-ws/guard.ts ---

  _consumeToken(player: MjsServerSeat): boolean {
    const cfg = this.def.limits.moves
    if (!cfg) return true
    const [n, windowMs] = cfg
    let bucket = this._buckets[player.seat]
    if (!bucket) { bucket = new TokenBucket(n, n / (windowMs / 1000)); this._buckets[player.seat] = bucket }
    return bucket.take()
  }

  // anti-triche (µgame:hash) — seau à jetons DÉDIÉ par siège, budget FIXE HASH_LIMIT (PAS
  // de clé def.limits, cf. son commentaire) : canal INDÉPENDANT de _consumeToken (coups) —
  // spammer ses coups n'épuise jamais le budget hash, et réciproquement.
  _consumeHashToken(player: MjsServerSeat): boolean {
    const [n, windowMs] = HASH_LIMIT
    let bucket = this._bucketsHash[player.seat]
    if (!bucket) { bucket = new TokenBucket(n, n / (windowMs / 1000)); this._bucketsHash[player.seat] = bucket }
    return bucket.take()
  }

  // --- anti-triche (détection par coup, TOUT opt-in — anti-triche poussé au
  // maximum) — 3 mesures INDÉPENDANTES appelées depuis _onMove, chacune protégée par SA
  // PROPRE clé `def` : un jeu qui n'en déclare AUCUNE ne paie que 3 lectures de propriété `undefined`
  // par coup (zéro Map peuplée, zéro entrée de journal, zéro appel à def.onSuspicion) --------------

  /** garde composite — def.suspect (métier) → def.antiRejeu (séquence) → def.limits.moveIntervalMs
   *  (cadence serveur), DANS CET ORDRE. Chaque sous-garde qui REJETTE journalise+compte D'ABORD
   *  (_reportSuspicion) PUIS throw — même convention que _consumeToken ci-dessus : un refus ICI
   *  redevient une ack d'erreur classique côté client (cf. commentaire de tête de _onMove),
   *  aucun canal d'erreur spécial à connaître. Ne throw JAMAIS si les 3 options sont absentes. */
  _antiCheatGuard(player: MjsServerSeat, move: string, p: unknown): void {
    if (this.def.suspect) {
      const r = this.def.suspect(move, { seat: player.seat, game: this, type: this.type, turn: this.turn, phase: this.phase, p })
      if (r) {
        // `true` littéral (typeof !== 'object') = journalisé SEUL, JAMAIS rejeté tout seul — seule
        // la forme objet `{rejeter:true}` déclenche un rejet (politique par défaut EXPLICITE
        // uniquement, cf. MjsServerSuspectResult/tests : « true sans rejet → appliqué mais journalisé »)
        const reject = typeof r === 'object' && r.reject === true
        const reason  = (typeof r === 'object' && r.reason) || 'suspect'
        this._reportSuspicion(player, move, reason, reject)
        if (reject) throw new Error(t('serveur.partie-coup-rejete-suspect', { coup: move, raison: reason }))
      }
    }

    if (this.def.antiReplay) {
      const seq = this._extractAntiReplaySeq(p)
      // aucun _n/_s numérique attaché à CE coup → rien à vérifier, jamais un faux rejet (cf.
      // commentaire de _extractAntiReplaySeq : rétro-compat totale pour un coup qui n'en porte pas)
      if (seq != null) {
        const last = this._lastAntiReplaySeq.get(player.id)
        if (last != null && seq <= last) {
          this._reportSuspicion(player, move, 'rejeu', true)
          throw new Error(t('serveur.partie-coup-rejete-rejeu', { coup: move, seq: seq, dernier: last }))
        }
        if (last != null && seq - last > ANTIREPLAY_WINDOW) {
          this._reportSuspicion(player, move, 'rejeu-fenetre', true)
          throw new Error(t('serveur.partie-coup-rejete-sequence-avance', { coup: move, seq: seq, dernier: last }))
        }
        this._lastAntiReplaySeq.set(player.id, seq)
      }
    }

    if (this.def.limits.moveIntervalMs) {
      const now = Date.now()
      const last = this._lastMoveAt.get(player.id)
      if (last != null && now - last < this.def.limits.moveIntervalMs) {
        this._reportSuspicion(player, move, 'rate', true)
        throw new Error(t('serveur.partie-coup-rejete-cadence', { coup: move }))
      }
      this._lastMoveAt.set(player.id, now)
    }

    // anti-triche (opt-in, anti-triche poussé au maximum) — quota de coups PAR
    // IDENTITÉ agrégé sur TOUTES les parties vivantes de l'app (cf. MjsServerAntiTricheOptions.
    // movesPerIdentity, index.ts) : borne un bot qui farme plusieurs parties EN PARALLÈLE, aveugle
    // à limits.moves/moveIntervalMs ci-dessus (PAR SIÈGE, PAR PARTIE). `_identityQuota` est un
    // simple PONT vers le registre RÉEL (Map identité→TokenBucket), tenu ENTIÈREMENT par
    // matchmaking.ts (seul point qui voit toutes les parties vivantes, cf. son commentaire) — posé
    // APRÈS construction, MÊME patron que `_gameStats` (cf. matchmaking.ts::create()) ; `null` =
    // option absente, AUCUN contrôle (défaut). Réutilise _reportSuspicion (journal + _gameStats +
    // def.onSuspicion) — MÊME infrastructure que les 3 gardes ci-dessus, rien de dupliqué.
    if (this._identityQuota && !this._identityQuota(player.id)) {
      this._reportSuspicion(player, move, 'quota-identite', true)
      throw new Error(t('serveur.partie-coup-rejete-quota-identite', { coup: move }))
    }
  }

  /** lit un numéro de séquence CLIENT depuis `p` pour def.antiRejeu — réutilise `_n` s'il est
   *  présent (MÊME champ que µ.predict, cf. _extractN/_lastAppliedN un peu plus haut) SANS le
   *  consommer ni y toucher : simple LECTURE, la réconciliation predict (_ack) continue EXACTEMENT
   *  comme avant, cette méthode ne mute jamais `p` ni `_lastAppliedN`. Sinon replie sur `_s`, un
   *  champ DÉDIÉ pour les coups qui n'utilisent pas predict (classique/lockstep). `null` si aucun
   *  des deux n'est un nombre — l'anti-rejeu ne bloque alors RIEN pour ce coup précis. */
  _extractAntiReplaySeq(p: unknown): number | null {
    if (!p || typeof p !== 'object') return null
    const obj = p as Record<string, unknown>
    if (typeof obj._n === 'number') return obj._n
    if (typeof obj._s === 'number') return obj._s
    return null
  }

  /** journalise + compte un événement anti-triche (anneau borné JOURNAL_ANTITRICHE_MAX,
   *  compteurs `_gameStats` cf. index.ts, hook def.onSuspicion) — appelée UNIQUEMENT par les 3 gardes
   *  de _antiCheatGuard ci-dessus. */
  _reportSuspicion(player: MjsServerSeat, type: string, reason: string, rejected: boolean): void {
    const event: MjsServerSuspicionEvent = { time: Date.now(), seat: player.seat, type, reason, rejected }
    this._antiCheatLogBuf.push(event)
    if (this._antiCheatLogBuf.length > ANTICHEAT_LOG_MAX) this._antiCheatLogBuf.shift()
    if (this._gameStats) {
      this._gameStats.suspectMoves++
      if (rejected) this._gameStats.rejectedMoves++
    }
    this.def.onSuspicion?.(event)
  }

  /** lecture du journal anti-triche (cf. _reportSuspicion) — exposée pour les tests et l'appli
   *  hôte (bannir/logguer sur historique, au-delà du hook temps réel def.onSuspicion) ; COPIE
   *  défensive (jamais l'anneau interne, MÊME politique que .serialize()/journal.slice()). */
  _antiCheatLog(): MjsServerSuspicionEvent[] {
    return this._antiCheatLogBuf.slice()
  }

  // --- tour par tour (turns.order 'roundrobin') ------------------------------------------------

  /** ordre = celui des SIÈGES occupés (index croissant), connectés ou non — cf. commentaire de tête */
  _nextRoundrobin(): MjsServerSeat | null {
    const seats = this.players.filter((j): j is MjsServerSeat => j !== null)
    if (seats.length === 0) return null
    const currentIdx = seats.findIndex(j => j.id === this.turn)
    return seats[currentIdx === -1 ? 0 : (currentIdx + 1) % seats.length]
  }
}

/** Restaure une partie depuis un instantané `serialize()` — sièges reconstruits SANS connexion
 *  live (`clients` vide, `connected: false` : personne n'est encore rattaché après un redémarrage,
 *  cf. µgame:resync pour le rattachement). Minuteries réarmées au DÉLAI RESTANT (à - maintenant,
 *  jamais négatif). Ni `def.state()` ni `hooks.onCreate` ne re-tournent (restaurer ≠ créer). Mode
 *  lockstep : `data.lockstep.journal` repeuple `partie._lockstep` (déjà construit avec
 *  la MÊME graine, ré-dérivée de `data.id`, cf. lockstep.ts deterministicSeed) — no-op si absent
 *  (partie authoritative, ou lockstep restaurée depuis un instantané antérieur). */
export function restoreGame(app: MjsWsApp, def: MjsServerResolvedDef, onDestroy: (game: Game) => void, data: MjsServerGameSnapshot): Game {
  const game = new Game(app, def, onDestroy, data.id)
  game.code    = data.code
  game.state   = data.state
  game.phase   = data.phase
  game.turn    = data.turn
  game.seq     = data.seq
  game.journal = data.journal.slice()
  game.players = data.seats.map(s => s ? { seat: s.seat, id: s.id, clients: new Set<MjsWsClient>(), connected: false } : null)
  // anti-triche par joueur — repeuple _lastAntiReplaySeq/_lastMoveAt AVANT tout rattachement,
  // sinon un rejeu bloqué avant l'arrêt repasserait après restauration (_buckets repart plein, par design)
  for (const s of data.seats) {
    if (!s) continue
    if (s.lastAntiReplaySeq != null) game._lastAntiReplaySeq.set(s.id, s.lastAntiReplaySeq)
    if (s.lastMoveAt != null) game._lastMoveAt.set(s.id, s.lastMoveAt)
  }
  if (game._lockstep && data.lockstep) game._lockstep._restoreJournal(data.lockstep.journal)
  for (const { name, at } of data.timers) game._armByName(name, Math.max(0, at - Date.now()))
  return game
}

/** Crée une partie FRAÎCHE — `def.state(partie)` puis `hooks.onCreate` (dans cet ordre : l'état
 *  existe déjà quand onCreate le lit). Seul point d'entrée normal — jamais `new Game()` direct
 *  hors de ce fichier (le state ne serait pas initialisé). Mode lockstep : `def.state`
 *  est `null` (interdit, cf. game.ts) — `partie.state` reste `undefined`, jamais assigné. */
export function createGame(app: MjsWsApp, def: MjsServerResolvedDef, onDestroy: (game: Game) => void, id: string): Game {
  const game = new Game(app, def, onDestroy, id)
  if (def.state) game.state = def.state(game)
  def.hooks.onCreate?.(game)
  return game
}
