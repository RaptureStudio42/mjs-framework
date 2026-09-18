// mjs-server/game — validation STRICTE de la définition d'un jeu (`app.game(type, def)`), MÊME
// patron que bundler/config.ts (clé inconnue = échec immédiat, suggestion orthographique sur
// les fautes de frappe via un `suggestKey` local — celui de bundler/config.ts n'est pas exporté,
// et importer le compilateur depuis MJS-Server serait un couplage absurde ; même algorithme,
// réimplémenté ici en ~15 lignes). Résout tous les défauts UNE SEULE FOIS ici — game.ts et
// matchmaking.ts ne revoient jamais `def` brut, seulement ce résultat déjà normalisé.

import type { Game, MjsServerSeat } from './game.js'
// valeur (pas juste un type) importée de game.ts — jamais l'inverse : game.ts ne dépend QUE
// des types de ce fichier (import type, effacé à la compilation), le sens runtime reste À SENS
// UNIQUE (game.ts → game.ts) — aucun cycle d'import réel entre les deux modules.
import { RESERVED_TIMER_NAMES } from './game.js'
// anti-triche (détection par coup, cf. game.ts::_antiCheatGuard) — types SEULS
// (aucun cycle runtime, MÊME patron que MjsServerLockstepDivergence plus bas) : les signatures
// def.suspect/onSuspicion sont DÉCLARÉES ici mais RÉSOLUES/appelées côté game.ts, qui possède déjà
// les 3 interfaces (contexte/résultat/événement) — évite de les dupliquer dans les deux fichiers.
import type { MjsServerSuspectContext, MjsServerSuspectResult, MjsServerSuspicionEvent } from './game.js'
// anti-triche (avertissement def.view absente, cf. resolveGameDef plus bas) — MÊME type
// que opts.onLog (mjs-ws/core.ts), réexporté par l'index public : import TYPE seul, aucun cycle
// runtime (MJS-WS ne dépend jamais de MJS-Server, cf. mjs-server/index.ts qui compose PAR-DESSUS MJS-WS).
import type { MjsWsLogFn } from '../mjs-ws/index.js'
// anti-triche (durcissement quorum, cf. lockstep.ts tête de fichier) — type SEUL, aucun
// cycle runtime (lockstep.ts n'importe rien de MJS-Server, cf. son commentaire de tête)
import type { MjsServerLockstepDivergence } from './lockstep.js'
import { t } from '../messages/index.js'

// --- suggestion orthographique (distance de Levenshtein ≤ 2, sinon aucune) -------------------

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[a.length][b.length]
}

function suggestKey(key: string, validKeys: Iterable<string>): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const k of validKeys) { const d = levenshtein(key, k); if (d < bestDist) { bestDist = d; best = k } }
  return best !== null && bestDist <= 2 ? best : null
}

function keyUnknown(prefix: string, k: string, known: Iterable<string>): Error {
  const suggestion = suggestKey(k, known)
  const hint = suggestion ? t('serveur.cle-inconnue-suggestion', { suggestion: suggestion }) : ''
  return new Error(t('serveur.cle-inconnue', { prefix: prefix, k: k, hint: hint, clesValides: Array.from(known).join(', ') }))
}

// extracteur PAR DÉFAUT de def.history (compensation de lag) QUAND def.space est déclaré —
// instantané léger de TOUTES les entités indexées par le space ; sans space, `extraire` est
// OBLIGATOIRE (aucun repli possible, cf. validation plus bas) — cf. mjs-server/history.ts
function extractFromSpace(game: Game): Record<string, { x: number; y: number }> {
  return game.space ? game.space._snapshot() : {}
}

// --- forme BRUTE (fournie par l'appli hôte à app.game(type, def)) ----------------------------

export interface MjsServerTurnsDef {
  /** 'roundrobin' = ordre des sièges (ordre d'arrivée) ; fn = calcule le prochain joueur soi-même */
  order?: 'roundrobin' | ((game: Game) => MjsServerSeat | string | null)
  /** ms — minuterie de tour auto-réarmée à chaque changement de `partie.turn` */
  timeout?: number
}

export interface MjsServerLimitsDef {
  /** [n, fenêtreMs] — seau à jetons PAR SIÈGE (réutilise TokenBucket de mjs-ws/guard.ts). Clé
   *  ABSENTE (ou `limits` entier absent) → défaut DEFAULT_MOVES_LIMIT (anti-triche, quota
   *  systématique, cf. plus bas) ; `null` EXPLICITE désactive tout quota (à la charge de l'auteur,
   *  cf. resolveGameDef). */
  moves?: [number, number] | null
  /** anti-triche — ms, intervalle MINIMAL entre deux coups du MÊME siège (horloge SERVEUR,
   *  jamais côté client) ; absent = aucun contrôle de cadence instantanée. DISTINCT de `moves`
   *  ci-dessus (débit MOYEN sur une fenêtre) : ceci borne la RAFALE, cf. game.ts::
   *  _antiCheatGuard. Un coup trop rapproché est journalisé (raison 'rate') ET rejeté —
   *  aucune variante « log seul » pour cette garde-ci (contrairement à def.suspect). */
  moveIntervalMs?: number
}

export interface MjsServerHooksDef {
  onCreate?: (game: Game) => void
  onJoin?: (game: Game, player: MjsServerSeat) => void
  onLeave?: (game: Game, player: MjsServerSeat) => void
  onEnd?: (game: Game, result: unknown) => void
  onTurnTimeout?: (game: Game) => void
}

/** mode ACTION (tick > 0 requis) — tampon circulaire de positions passées pour la
 *  compensation de lag serveur (game.rewind/game.timeSeenBy, cf. mjs-server/history.ts) : au tir,
 *  le serveur peut « remonter le temps » aux positions que LE TIREUR voyait (sa latence + son
 *  retard d'interpolation) plutôt que de comparer contre les positions déjà avancées. */
export interface MjsServerHistoryDef {
  /** entrées de l'anneau — entier ≥ 1 (typiquement 20-30 pour couvrir ~1s à 20-30Hz) */
  ticks: number
  /** instantané { id → {x, y} } au tick courant — défaut : snapshot de `def.space` (requiert
   *  `space` déclaré) ; SANS `space`, cette clé est OBLIGATOIRE (aucun repli possible) */
  extract?: (game: Game) => Record<string, { x: number; y: number }>
  /** ms — retard d'interpolation déclaré côté client (cf. runtime µ.interp `retard`), utilisé par
   *  game.timeSeenBy — défaut 2 × période de tick (cohérent avec µ.interp `retard: 2`) */
  interp?: number
}

export interface MjsServerGameDef {
  /** 'authoritative' (défaut) : la salle simule via state/moves/intents/simulate… | 'lockstep' :
   *  la salle NE SIMULE RIEN — seuls les ORDRES (µgame:move) circulent, groupés par
   *  tick et diffusés à l'identique à tous (µgame:orders, cf. mjs-server/lockstep.ts pour le contrat
   *  complet). Liste FERMÉE d'interdits en 'lockstep' : state/view/deltas/intents/simulate/space/history
   *  (déclarer l'un d'eux avec mode:'lockstep' est une erreur claire, cf. resolveGameDef ci-dessous). */
  mode?: 'authoritative' | 'lockstep'
  /** sièges requis pour démarrer — entier ≥ 1 */
  seats: number
  /** parties privées par code court — défaut false */
  code?: boolean
  /** ms — fenêtre de confirmation des sièges issus de la file d'attente, cf. matchmaking.ts */
  seatTtl?: number
  /** 0 = pur événementiel (tour par tour, v1) ; 1-60 = mode ACTION, boucle à tick (cf.
   *  intents/simulate) — en mode 'lockstep', REQUIS (> 0) : cadence de regroupement des
   *  ordres, cf. def.mode */
  tick?: number
  /** état initial — appelé une fois à la création de la partie — INTERDIT en mode 'lockstep' (aucun
   *  état serveur), cf. def.mode */
  state?: (game: Game) => unknown
  moves: Record<string, (game: Game, player: MjsServerSeat, p: unknown) => unknown>
  /** vue filtrée par joueur — défaut : état entier (aucun filtrage) */
  view?: (game: Game, player: MjsServerSeat | null) => unknown
  /** phase → coups permis (moves ET intents, même registre) — absent = aucune restriction de phase */
  phases?: Record<string, string[]>
  turns?: MjsServerTurnsDef
  /** minuteries NOMMÉES — l'échéance appelle timers[nom](partie), cf. partie.timer() */
  timers?: Record<string, (game: Game) => void>
  limits?: MjsServerLimitsDef
  /** ms — partie sans plus aucun joueur CONNECTÉ → détruite après ce délai, défaut 60000 */
  emptyTtl?: number
  hooks?: MjsServerHooksDef
  /** mode 'lockstep' EXCLUSIVEMENT (erreur si déclaré hors lockstep) — anti-triche (durcissement
   *  quorum, cf. mjs-server/lockstep.ts receiveHash) : `info.suspects` = sièges identifiés (auto-
   *  contradiction OU minoritaires face au hash majoritaire), JAMAIS la majorité honnête — le jeu
   *  DÉCIDE de la suite (rien/log/fin, aucun comportement automatique imposé), en plus de la
   *  diffusion µgame:event 'divergence' {tick, suspects, raison} à tous les joueurs (cf.
   *  game.ts::_receiveHash). */
  onDivergence?: (game: Game, info: MjsServerLockstepDivergence) => void
  /** mode 'lockstep' SEULEMENT (erreur si déclaré hors lockstep) — plafonne le journal d'ordres
   *  (cf. lockstep.ts) à `maxTicks` DERNIERS ticks, en ANNEAU (les plus vieux purgés à chaque tick
   *  clos) ; absent = illimité (défaut HISTORIQUE inchangé, cf. lockstep.ts commentaire de tête
   *  « JOURNAL »). TRADE-OFF assumé : un client qui rate plus de `maxTicks` ticks (déconnexion
   *  longue) reçoit à la reconnexion un journal TRONQUÉ — resync déterministe impossible à
   *  reconstituer pour lui (aucun snapshot d'état ici, cf. def.mode). */
  lockstepJournal?: { maxTicks: number }
  /** mode ACTION (tick > 0 requis) — intentions NOMMÉES reçues via µgame:move, mises en FILE par
   *  joueur (la DERNIÈRE valeur gagne par nom) et appliquées à CHAQUE tick, jamais à réception —
   *  cf. game.ts _onMove/_applyIntents. Un nom ne peut pas être à la fois dans
   *  `moves` et `intents` (ambiguïté refusée à la déclaration). */
  intents?: Record<string, (game: Game, player: MjsServerSeat, p: unknown) => unknown>
  /** mode ACTION (tick > 0 requis) — appelée UNE FOIS PAR TICK, après les intentions en file ;
   *  `dt` = ms RÉELLEMENT écoulées depuis le tick précédent (mesuré, jamais la période nominale
   *  figée — correction de dérive simple, cf. game.ts _runTick) */
  simulate?: (game: Game, dt: number) => void
  /** mode ACTION (tick > 0 requis), optionnel — 2e boucle à SA PROPRE cadence `hz`, indépendante
   *  de `tick` (régénération, victoire, IA lente…) */
  slowTick?: { hz: number; fn: (game: Game) => void }
  /** diffusion par DELTA profond PAR JOUEUR (au lieu de la vue complète à chaque état) — défaut
   *  false, compatibilité v1 STRICTE. Repli automatique vers la vue complète : 1re diffusion à ce
   *  joueur, réponse à µgame:resync, ou delta plus volumineux que ~60 % du JSON de la vue.
   *  Orthogonal à `tick` (utilisable en mode événementiel classique aussi). */
  deltas?: boolean
  /** zone d'intérêt OPTIONNELLE — grille de cellules carrées de taille `cell`, exposée en
   *  `partie.space` (src/mjs-server/space.ts : .set/.remove/.query). UTILITAIRE nu, aucun filtrage
   *  imposé — le jeu s'en sert où il veut (typiquement dans `view` ou `simulate`). */
  space?: { cell: number }
  /** mode ACTION (tick > 0 requis) — compensation de lag serveur, cf. MjsServerHistoryDef */
  history?: MjsServerHistoryDef
  /** anti-triche (détection par coup, OPT-IN, anti-triche poussé au maximum) —
   *  hook MÉTIER (« le jeu sait ce qui est plausible ») appelé pour CHAQUE coup, sur les 3 branches
   *  (classique/intents/lockstep), APRÈS résolution du siège auteur + autorisation phase/tour, AVANT
   *  toute exécution/mise en file/ordre — cf. MjsServerSuspectContext/MjsServerSuspectResult
   *  (game.ts) pour le contrat exact, game.ts::_antiCheatGuard pour l'orchestration. */
  suspect?: (move: string, context: MjsServerSuspectContext) => MjsServerSuspectResult
  /** anti-triche (détection par coup, OPT-IN) — active la vérification de séquence
   *  ANTI-REJEU : chaque coup peut porter un numéro croissant (`_n` s'il existe déjà côté µ.predict,
   *  SINON `_s` dédié) que le serveur compare au dernier accepté PAR SIÈGE — rejette tout coup à seq
   *  ≤ dernier (rejeu/doublon) ou trop en avance (fenêtre fixe, cf. game.ts ANTIREJEU_FENETRE).
   *  Cohabite SANS CONFLIT avec `_n`/`_ack` de µ.predict (réconciliation, cf. game.ts::
   *  _extractAntiReplaySeq) : lecture SEULE de `_n`, jamais consommé/muté — un coup SANS _n ni _s
   *  n'est jamais bloqué par cette garde (rétro-compat totale). Littéralement `true` ou absent —
   *  aucune autre valeur. */
  antiReplay?: true
  /** anti-triche (détection par coup) — appelé à CHAQUE événement journalisé (def.suspect
   *  véridique, violation antiRejeu, violation limits.moveIntervalMs), REJETÉ ou log-seul — MÊME
   *  forme que l'entrée du journal (cf. MjsServerSuspicionEvent, game.ts::_antiCheatLog() pour
   *  la relecture a posteriori). L'appli hôte décide de la suite (bannir/logguer/rien), aucun
   *  comportement automatique imposé — MÊME philosophie que def.onDivergence ci-dessus. */
  onSuspicion?: (event: MjsServerSuspicionEvent) => void
  /** anti-triche (spectateurs, OPT-IN, anti-triche poussé au maximum) — vue
   *  SÛRE dédiée aux clients SPECTATEURS (cf. partie._addSpectator/_spectatorView) : appelée à
   *  la place de `view` pour ces clients-là (jamais de siège, jamais dans `partie.players`).
   *  Absent → repli sur `view` SEULEMENT si l'auteur l'a lui-même déclaré (appelée avec `joueur:
   *  null` en 2e argument — marqueur clair, cf. sa signature déjà nullable) ; si NI l'un NI l'autre
   *  n'est déclaré, un spectateur ne reçoit JAMAIS l'état par défaut (repli `{}` + avertissement,
   *  cf. game.ts::_spectatorView — anti-fuite, symétrique du repli par défaut mais volontairement
   *  plus strict : pas d'état par défaut pour un rôle en LECTURE SEULE). Mode-agnostique (autorisé
   *  aussi en 'lockstep', où `view` est par ailleurs interdit — un spectateur lockstep n'a que ce
   *  que l'auteur choisit de lui exposer explicitement). */
  spectatorView?: (game: Game) => unknown
}

// --- forme RÉSOLUE (défauts appliqués, consommée par game.ts/matchmaking.ts) ---------------

export interface MjsServerResolvedDef {
  readonly type: string
  /** cf. MjsServerGameDef.mode — TOUJOURS résolu ('authoritative' par défaut), jamais absent */
  readonly mode: 'authoritative' | 'lockstep'
  readonly seats: number
  readonly code: boolean
  readonly seatTtl: number
  readonly tick: number
  /** `null` en mode 'lockstep' (interdit, cf. def.mode) — sinon TOUJOURS une fonction (requis) */
  readonly state: ((game: Game) => unknown) | null
  readonly moves: Record<string, (game: Game, player: MjsServerSeat, p: unknown) => unknown>
  /** `null` en mode 'lockstep' (interdit — aucun état serveur à filtrer, cf. def.mode) */
  readonly view: ((game: Game, player: MjsServerSeat | null) => unknown) | null
  readonly phases: Record<string, string[]> | null
  readonly turns: { order: 'roundrobin' | ((game: Game) => MjsServerSeat | string | null); timeout: number } | null
  readonly timers: Record<string, (game: Game) => void>
  readonly limits: { moves: [number, number] | null; moveIntervalMs: number | null }
  readonly emptyTtl: number
  readonly hooks: MjsServerHooksDef
  readonly onDivergence: ((game: Game, info: MjsServerLockstepDivergence) => void) | null
  /** cf. MjsServerGameDef.lockstepJournal — `null` = illimité (défaut, absent de la déclaration) */
  readonly lockstepJournal: { maxTicks: number } | null
  readonly intents: Record<string, (game: Game, player: MjsServerSeat, p: unknown) => unknown>
  readonly simulate: ((game: Game, dt: number) => void) | null
  readonly slowTick: { hz: number; fn: (game: Game) => void } | null
  readonly deltas: boolean
  readonly space: { cell: number } | null
  readonly history: { ticks: number; extract: (game: Game) => Record<string, { x: number; y: number }>; interp: number } | null
  /** anti-triche — cf. MjsServerGameDef.suspect */
  readonly suspect: ((move: string, context: MjsServerSuspectContext) => MjsServerSuspectResult) | null
  /** anti-triche — cf. MjsServerGameDef.antiRejeu ; TOUJOURS résolu (false par défaut), jamais absent */
  readonly antiReplay: boolean
  /** anti-triche — cf. MjsServerGameDef.onSuspicion */
  readonly onSuspicion: ((event: MjsServerSuspicionEvent) => void) | null
  /** anti-triche — cf. MjsServerGameDef.spectatorView ; RÉSOLU UNE SEULE FOIS ici (inclut
   *  déjà le repli sur le `view` AUTEUR le cas échéant, cf. resolveGameDef) — `null` = aucune vue
   *  sûre disponible, game.ts applique alors son repli {} + avertissement. */
  readonly spectatorView: ((game: Game) => unknown) | null
  /** logger résolu (opts.onLog ?? defaultLog, cf. index.ts) — porté jusqu'ici UNIQUEMENT pour
   *  l'avertissement runtime spectateur-sans-vue (cf. game.ts::_spectatorView, throttlé UNE FOIS
   *  PAR PARTIE) ; toutes les AUTRES validations restent des throw À LA DÉCLARATION (cf. tête de
   *  fichier) — ce champ est le SEUL log conservé après résolution. */
  readonly log: MjsWsLogFn
}

export const DEFAULT_SEAT_TTL  = 10000
export const DEFAULT_EMPTY_TTL = 60000
/** anti-triche (durcissement) — quota de coups PAR SIÈGE appliqué QUAND
 *  `limits.moves` est ABSENT (jamais si l'auteur a déclaré SA propre valeur, `null` compris, cf.
 *  resolveGameDef) : 30 coups/s (capacité 30, refill 30/s — même ordre de grandeur que
 *  mjs-ws/index.ts::DEFAULT_LIMITS.rate=40/s, sibling au niveau transport). CHANGEMENT DE
 *  COMPORTEMENT assumé : avant, l'absence de `limits.moves` valait AUCUN quota. Un jeu mode ACTION
 *  à tick élevé (def.tick > 30) qui envoie légitimement >30 intentions/s DOIT déclarer SA propre
 *  `limits.moves` dimensionnée à son tick (ou `null` pour désactiver) — ce défaut cible le cas
 *  courant (jeu social/tour par tour à cadence humaine), pas le netcode haute fréquence. */
export const DEFAULT_MOVES_LIMIT: [number, number] = [30, 1000]

const KNOWN_GAME_KEYS              = new Set(['mode', 'seats', 'code', 'seatTtl', 'tick', 'state', 'moves', 'view', 'phases', 'turns', 'timers', 'limits', 'emptyTtl', 'hooks', 'onDivergence', 'lockstepJournal', 'intents', 'simulate', 'slowTick', 'deltas', 'space', 'history', 'suspect', 'antiReplay', 'onSuspicion', 'spectatorView'])
const KNOWN_TURNS_KEYS             = new Set(['order', 'timeout'])
const KNOWN_LIMITS_KEYS            = new Set(['moves', 'moveIntervalMs'])
const KNOWN_HOOKS_KEYS             = new Set(['onCreate', 'onJoin', 'onLeave', 'onEnd', 'onTurnTimeout'])
const KNOWN_SLOWTICK_KEYS          = new Set(['hz', 'fn'])
const KNOWN_SPACE_KEYS             = new Set(['cell'])
const KNOWN_HISTORY_KEYS             = new Set(['ticks', 'extract', 'interp'])
// mode 'lockstep' SEULEMENT — cf. MjsServerGameDef.lockstepJournal
const KNOWN_LOCKSTEP_JOURNAL_KEYS = new Set(['maxTicks'])

/** Valide + résout `def` pour `type` — throw immédiat (message français, préfixé) au premier
 *  problème rencontré. Jamais de valeur par défaut SILENCIEUSE sur une clé mal typée : soit elle
 *  est absente (défaut appliqué), soit elle est présente et DOIT être du bon type. */
export function resolveGameDef(type: string, raw: MjsServerGameDef, log: MjsWsLogFn = () => {}): MjsServerResolvedDef {
  const prefix = `[MJS-Server] game('${type}')`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(t('serveur.game-def-invalide', { prefix: prefix }))
  }
  for (const k of Object.keys(raw)) if (!KNOWN_GAME_KEYS.has(k)) throw keyUnknown(prefix, k, KNOWN_GAME_KEYS)

  if (!Number.isInteger(raw.seats) || raw.seats < 1) {
    throw new Error(t('serveur.game-places-invalide', { prefix: prefix, received: JSON.stringify(raw.seats) }))
  }
  if (raw.code !== undefined && typeof raw.code !== 'boolean') {
    throw new Error(t('serveur.game-code-invalide', { prefix: prefix, received: JSON.stringify(raw.code), receivedType: typeof raw.code }))
  }
  if (raw.seatTtl !== undefined && (typeof raw.seatTtl !== 'number' || !Number.isFinite(raw.seatTtl) || raw.seatTtl <= 0)) {
    throw new Error(t('serveur.game-seatttl-invalide', { prefix: prefix, received: JSON.stringify(raw.seatTtl) }))
  }
  if (raw.tick !== undefined && (typeof raw.tick !== 'number' || !Number.isFinite(raw.tick) || raw.tick < 0)) {
    throw new Error(t('serveur.game-tick-invalide', { prefix: prefix, received: JSON.stringify(raw.tick) }))
  }
  const tickHz = raw.tick ?? 0
  if (tickHz > 0 && (tickHz < 1 || tickHz > 60)) {
    throw new Error(t('serveur.game-tick-hors-plage', { prefix: prefix, tickHz: tickHz }))
  }

  // mode salle — 'authoritative' (défaut, comportement ACTUEL inchangé) | 'lockstep'
  // (la salle ne simule rien, cf. mjs-server/lockstep.ts) — déterminé TÔT : gouverne les checks state/
  // view/deltas/intents/simulate/space/history/onDivergence ci-dessous (liste FERMÉE, cf. def.mode).
  if (raw.mode !== undefined && raw.mode !== 'authoritative' && raw.mode !== 'lockstep') {
    throw new Error(t('serveur.game-mode-invalide', { prefix: prefix, received: JSON.stringify(raw.mode) }))
  }
  const mode = raw.mode ?? 'authoritative'
  if (mode === 'lockstep' && tickHz === 0) {
    throw new Error(t('serveur.game-tick-requis-lockstep', { prefix: prefix }))
  }

  if (mode === 'lockstep') {
    if (raw.state !== undefined) throw new Error(t('serveur.game-state-interdit-lockstep', { prefix: prefix }))
  } else if (typeof raw.state !== 'function') {
    throw new Error(t('serveur.game-state-requis', { prefix: prefix, received: JSON.stringify(raw.state) }))
  }
  if (typeof raw.moves !== 'object' || raw.moves === null || Array.isArray(raw.moves)) {
    throw new Error(t('serveur.game-moves-requis', { prefix: prefix }))
  }
  for (const [name, fn] of Object.entries(raw.moves)) {
    if (typeof fn !== 'function') throw new Error(t('serveur.game-moves-nom-invalide', { prefix: prefix, nom: name, received: JSON.stringify(fn) }))
  }
  if (raw.view !== undefined) {
    if (mode === 'lockstep') throw new Error(t('serveur.game-view-interdit-lockstep', { prefix: prefix }))
    if (typeof raw.view !== 'function') throw new Error(t('serveur.game-view-invalide', { prefix: prefix, received: JSON.stringify(raw.view) }))
  }
  if (raw.onDivergence !== undefined) {
    if (mode !== 'lockstep') throw new Error(t('serveur.game-ondivergence-hors-lockstep', { prefix: prefix }))
    if (typeof raw.onDivergence !== 'function') throw new Error(t('serveur.game-ondivergence-invalide', { prefix: prefix, received: JSON.stringify(raw.onDivergence) }))
  }
  if (raw.lockstepJournal !== undefined) {
    if (mode !== 'lockstep') throw new Error(t('serveur.game-lockstepjournal-hors-lockstep', { prefix: prefix }))
    if (typeof raw.lockstepJournal !== 'object' || raw.lockstepJournal === null || Array.isArray(raw.lockstepJournal)) {
      throw new Error(t('serveur.game-lockstepjournal-invalide', { prefix: prefix }))
    }
    for (const k of Object.keys(raw.lockstepJournal)) if (!KNOWN_LOCKSTEP_JOURNAL_KEYS.has(k)) throw keyUnknown(`${prefix}.lockstepJournal`, k, KNOWN_LOCKSTEP_JOURNAL_KEYS)
    if (!Number.isInteger(raw.lockstepJournal.maxTicks) || raw.lockstepJournal.maxTicks < 1) {
      throw new Error(t('serveur.game-lockstepjournal-maxticks-invalide', { prefix: prefix, received: JSON.stringify(raw.lockstepJournal.maxTicks) }))
    }
  }
  if (raw.phases !== undefined) {
    if (typeof raw.phases !== 'object' || raw.phases === null || Array.isArray(raw.phases)) {
      throw new Error(t('serveur.game-phases-invalide', { prefix: prefix }))
    }
    for (const [phase, allowed] of Object.entries(raw.phases)) {
      if (!Array.isArray(allowed) || allowed.some(c => typeof c !== 'string')) {
        throw new Error(t('serveur.game-phases-valeur-invalide', { prefix: prefix, phase: phase, received: JSON.stringify(allowed) }))
      }
    }
  }
  if (raw.turns !== undefined) {
    if (typeof raw.turns !== 'object' || raw.turns === null || Array.isArray(raw.turns)) {
      throw new Error(t('serveur.game-turns-invalide', { prefix: prefix }))
    }
    for (const k of Object.keys(raw.turns)) if (!KNOWN_TURNS_KEYS.has(k)) throw keyUnknown(`${prefix}.turns`, k, KNOWN_TURNS_KEYS)
    if (raw.turns.order !== undefined && raw.turns.order !== 'roundrobin' && typeof raw.turns.order !== 'function') {
      throw new Error(t('serveur.game-turns-order-invalide', { prefix: prefix, received: JSON.stringify(raw.turns.order) }))
    }
    if (raw.turns.timeout !== undefined && (typeof raw.turns.timeout !== 'number' || !Number.isFinite(raw.turns.timeout) || raw.turns.timeout <= 0)) {
      throw new Error(t('serveur.game-turns-timeout-invalide', { prefix: prefix, received: JSON.stringify(raw.turns.timeout) }))
    }
  }
  if (raw.timers !== undefined) {
    if (typeof raw.timers !== 'object' || raw.timers === null || Array.isArray(raw.timers)) {
      throw new Error(t('serveur.game-timers-invalide', { prefix: prefix }))
    }
    for (const [name, fn] of Object.entries(raw.timers)) {
      if (RESERVED_TIMER_NAMES.has(name)) throw new Error(t('serveur.game-timers-nom-reserve', { prefix: prefix, nom: name }))
      if (typeof fn !== 'function') throw new Error(t('serveur.game-timers-nom-invalide', { prefix: prefix, nom: name, received: JSON.stringify(fn) }))
    }
  }
  if (raw.limits !== undefined) {
    if (typeof raw.limits !== 'object' || raw.limits === null || Array.isArray(raw.limits)) {
      throw new Error(t('serveur.game-limits-invalide', { prefix: prefix }))
    }
    for (const k of Object.keys(raw.limits)) if (!KNOWN_LIMITS_KEYS.has(k)) throw keyUnknown(`${prefix}.limits`, k, KNOWN_LIMITS_KEYS)
    // `null` EXPLICITE = désactivation ASSUMÉE du quota (cf. DEFAULT_MOVES_LIMIT) — jamais
    // destructuré comme un tuple (piège : `[n, fenetre] = null` lève un TypeError générique, pas
    // notre message d'erreur clair ci-dessous) ; seul `undefined` (clé absente) applique le défaut.
    if (raw.limits.moves !== undefined && raw.limits.moves !== null) {
      const [n, window] = raw.limits.moves
      if (!Array.isArray(raw.limits.moves) || raw.limits.moves.length !== 2 || !Number.isInteger(n) || n < 1 || typeof window !== 'number' || window <= 0) {
        throw new Error(t('serveur.game-limits-moves-invalide', { prefix: prefix, received: JSON.stringify(raw.limits.moves) }))
      }
    }
    // anti-triche — cf. MjsServerLimitsDef.moveIntervalMs
    if (raw.limits.moveIntervalMs !== undefined && (typeof raw.limits.moveIntervalMs !== 'number' || !Number.isFinite(raw.limits.moveIntervalMs) || raw.limits.moveIntervalMs <= 0)) {
      throw new Error(t('serveur.game-limits-moveintervalms-invalide', { prefix: prefix, received: JSON.stringify(raw.limits.moveIntervalMs) }))
    }
  }
  if (raw.emptyTtl !== undefined && (typeof raw.emptyTtl !== 'number' || !Number.isFinite(raw.emptyTtl) || raw.emptyTtl <= 0)) {
    throw new Error(t('serveur.game-emptyttl-invalide', { prefix: prefix, received: JSON.stringify(raw.emptyTtl) }))
  }
  if (raw.hooks !== undefined) {
    if (typeof raw.hooks !== 'object' || raw.hooks === null || Array.isArray(raw.hooks)) {
      throw new Error(t('serveur.game-hooks-invalide', { prefix: prefix }))
    }
    for (const k of Object.keys(raw.hooks)) if (!KNOWN_HOOKS_KEYS.has(k)) throw keyUnknown(`${prefix}.hooks`, k, KNOWN_HOOKS_KEYS)
    for (const [name, fn] of Object.entries(raw.hooks)) {
      if (fn !== undefined && typeof fn !== 'function') throw new Error(t('serveur.game-hooks-nom-invalide', { prefix: prefix, nom: name, received: JSON.stringify(fn) }))
    }
  }

  // --- mode ACTION : intents/simulate/slowTick exigent tick > 0 — sans boucle, rien ne
  // les appellerait jamais (cf. commentaires d'interface ci-dessus) ; deltas/space restent ORTHOGONAUX
  // (slowTick N'EST PAS dans la liste fermée d'interdits lockstep, cf. def.mode — reste autorisé)
  if (raw.intents !== undefined) {
    if (mode === 'lockstep') throw new Error(t('serveur.game-intents-interdit-lockstep', { prefix: prefix }))
    if (typeof raw.intents !== 'object' || raw.intents === null || Array.isArray(raw.intents)) {
      throw new Error(t('serveur.game-intents-invalide', { prefix: prefix }))
    }
    if (tickHz === 0) throw new Error(t('serveur.game-intents-tick-requis', { prefix: prefix }))
    for (const [name, fn] of Object.entries(raw.intents)) {
      if (typeof fn !== 'function') throw new Error(t('serveur.game-intents-nom-invalide', { prefix: prefix, nom: name, received: JSON.stringify(fn) }))
      if (raw.moves && name in raw.moves) throw new Error(t('serveur.game-intents-nom-collision', { prefix: prefix, nom: name }))
    }
  }
  if (raw.simulate !== undefined) {
    if (mode === 'lockstep') throw new Error(t('serveur.game-simulate-interdit-lockstep', { prefix: prefix }))
    if (typeof raw.simulate !== 'function') throw new Error(t('serveur.game-simulate-invalide', { prefix: prefix, received: JSON.stringify(raw.simulate) }))
    if (tickHz === 0) throw new Error(t('serveur.game-simulate-tick-requis', { prefix: prefix }))
  }
  if (raw.slowTick !== undefined) {
    if (typeof raw.slowTick !== 'object' || raw.slowTick === null || Array.isArray(raw.slowTick)) {
      throw new Error(t('serveur.game-slowtick-invalide', { prefix: prefix }))
    }
    for (const k of Object.keys(raw.slowTick)) if (!KNOWN_SLOWTICK_KEYS.has(k)) throw keyUnknown(`${prefix}.slowTick`, k, KNOWN_SLOWTICK_KEYS)
    if (typeof raw.slowTick.hz !== 'number' || !Number.isFinite(raw.slowTick.hz) || raw.slowTick.hz <= 0) {
      throw new Error(t('serveur.game-slowtick-hz-invalide', { prefix: prefix, received: JSON.stringify(raw.slowTick.hz) }))
    }
    if (typeof raw.slowTick.fn !== 'function') throw new Error(t('serveur.game-slowtick-fn-invalide', { prefix: prefix, received: JSON.stringify(raw.slowTick.fn) }))
    if (tickHz === 0) throw new Error(t('serveur.game-slowtick-tick-requis', { prefix: prefix }))
  }
  if (raw.deltas !== undefined) {
    if (mode === 'lockstep') throw new Error(t('serveur.game-deltas-interdit-lockstep', { prefix: prefix }))
    if (typeof raw.deltas !== 'boolean') throw new Error(t('serveur.game-deltas-invalide', { prefix: prefix, received: JSON.stringify(raw.deltas) }))
  }
  if (raw.space !== undefined) {
    if (mode === 'lockstep') throw new Error(t('serveur.game-space-interdit-lockstep', { prefix: prefix }))
    if (typeof raw.space !== 'object' || raw.space === null || Array.isArray(raw.space)) {
      throw new Error(t('serveur.game-space-invalide', { prefix: prefix }))
    }
    for (const k of Object.keys(raw.space)) if (!KNOWN_SPACE_KEYS.has(k)) throw keyUnknown(`${prefix}.space`, k, KNOWN_SPACE_KEYS)
    if (typeof raw.space.cell !== 'number' || !Number.isFinite(raw.space.cell) || raw.space.cell <= 0) {
      throw new Error(t('serveur.game-space-cell-invalide', { prefix: prefix, received: JSON.stringify(raw.space.cell) }))
    }
  }

  // --- historique de positions (def.history) — tampon circulaire pour la compensation de
  // lag serveur (cf. mjs-server/history.ts) ; ORTHOGONAL à deltas/space, mais exige tick > 0 (même
  // raison que intents/simulate/slowTick : sans boucle, aucun tick à historiser)
  if (raw.history !== undefined) {
    if (mode === 'lockstep') throw new Error(t('serveur.game-histo-interdit-lockstep', { prefix: prefix }))
    if (typeof raw.history !== 'object' || raw.history === null || Array.isArray(raw.history)) {
      throw new Error(t('serveur.game-histo-invalide', { prefix: prefix }))
    }
    for (const k of Object.keys(raw.history)) if (!KNOWN_HISTORY_KEYS.has(k)) throw keyUnknown(`${prefix}.history`, k, KNOWN_HISTORY_KEYS)
    if (tickHz === 0) throw new Error(t('serveur.game-histo-tick-requis', { prefix: prefix }))
    if (!Number.isInteger(raw.history.ticks) || raw.history.ticks < 1) {
      throw new Error(t('serveur.game-histo-ticks-invalide', { prefix: prefix, received: JSON.stringify(raw.history.ticks) }))
    }
    if (raw.history.extract !== undefined && typeof raw.history.extract !== 'function') {
      throw new Error(t('serveur.game-histo-extraire-invalide', { prefix: prefix, received: JSON.stringify(raw.history.extract) }))
    }
    if (!raw.history.extract && !raw.space) {
      throw new Error(t('serveur.game-histo-extraire-requis', { prefix: prefix }))
    }
    if (raw.history.interp !== undefined && (typeof raw.history.interp !== 'number' || !Number.isFinite(raw.history.interp) || raw.history.interp < 0)) {
      throw new Error(t('serveur.game-histo-interp-invalide', { prefix: prefix, received: JSON.stringify(raw.history.interp) }))
    }
  }

  // --- anti-triche (détection par coup, TOUT opt-in) — MODE-AGNOSTIQUE (autorisé aussi
  // bien en 'authoritative' qu'en 'lockstep', contrairement à state/view/deltas/intents/simulate/
  // space/histo ci-dessus : un ORDRE lockstep reste un coup pour ces 3 gardes génériques, cf.
  // game.ts::_antiCheatGuard) — AUCUNE restriction de mode ici, volontairement.
  if (raw.suspect !== undefined && typeof raw.suspect !== 'function') {
    throw new Error(t('serveur.game-suspect-invalide', { prefix: prefix, received: JSON.stringify(raw.suspect) }))
  }
  if (raw.antiReplay !== undefined && raw.antiReplay !== true) {
    throw new Error(t('serveur.game-antirejeu-invalide', { prefix: prefix, received: JSON.stringify(raw.antiReplay) }))
  }
  if (raw.onSuspicion !== undefined && typeof raw.onSuspicion !== 'function') {
    throw new Error(t('serveur.game-onsuspicion-invalide', { prefix: prefix, received: JSON.stringify(raw.onSuspicion) }))
  }
  // anti-triche (spectateurs) — mode-agnostique, MÊME esprit que suspect/antiRejeu/
  // onSuspicion ci-dessus (aucune restriction de mode ici, volontairement).
  if (raw.spectatorView !== undefined && typeof raw.spectatorView !== 'function') {
    throw new Error(t('serveur.game-spectatorview-invalide', { prefix: prefix, received: JSON.stringify(raw.spectatorView) }))
  }

  // vue sûre par défaut (anti-triche, AVERTISSEMENT SEUL — jamais un throw, rétro-compat
  // solo/plateau public assumée) — def.view ABSENTE sur un jeu à PLUSIEURS sièges : le défaut de
  // `view` juste en dessous (raw.view ?? état ENTIER) diffuse alors partie.state COMPLET à TOUS
  // les sièges, secrets par joueur compris — fuite SILENCIEUSE si l'auteur ne le sait pas. Exclu
  // en 'lockstep' : `view` y est INTERDIT (aucun état serveur à filtrer, cf. le check plus haut,
  // `raw.view` y est donc TOUJOURS `undefined`) — avertir serait un faux positif systématique,
  // rien à masquer dans ce mode (seuls les ORDRES circulent, cf. def.mode).
  if (raw.view === undefined && mode !== 'lockstep' && raw.seats > 1) {
    // PAS `${prefix}` ICI (contrairement aux `throw` du reste du fichier) — `prefix` embarque déjà
    // '[MJS-Server] ', OR `log()` passe par defaultLog (cf. index.ts) qui préfixe LUI-MÊME `[MJS-Server]
    // ${message}` : le composer aurait doublé le tag ('[MJS-Server] [MJS-Server] game(...)'), MÊME
    // convention que les log('warn'/'error', …) internes de mjs-ws/core.ts (jamais auto-préfixés,
    // le tag vient TOUJOURS du seul wrapper defaultLog/onLog).
    log('warn', t('serveur.game-view-absente-avertissement', { type: type }))
  }

  return {
    type,
    mode:     mode,
    seats:   raw.seats,
    code:     raw.code ?? false,
    seatTtl:  raw.seatTtl ?? DEFAULT_SEAT_TTL,
    tick:     raw.tick ?? 0,
    state:    mode === 'lockstep' ? null : raw.state!,
    moves:    raw.moves,
    view:     mode === 'lockstep' ? null : (raw.view ?? ((game: Game) => (game as unknown as { state: unknown }).state)),
    phases:   raw.phases ?? null,
    turns:    raw.turns ? { order: raw.turns.order ?? 'roundrobin', timeout: raw.turns.timeout ?? 30000 } : null,
    timers:   raw.timers ?? {},
    // `??` serait FAUX ici : il confondrait `null` explicite (désactivation VOULUE) avec `undefined`
    // (clé absente) et réappliquerait le défaut dans les DEUX cas — seule une comparaison stricte à
    // `undefined` distingue « l'auteur n'a rien dit » de « l'auteur a dit null » (cf. DEFAULT_MOVES_LIMIT)
    limits:   { moves: raw.limits?.moves !== undefined ? raw.limits.moves : DEFAULT_MOVES_LIMIT, moveIntervalMs: raw.limits?.moveIntervalMs ?? null },
    emptyTtl: raw.emptyTtl ?? DEFAULT_EMPTY_TTL,
    hooks:    raw.hooks ?? {},
    onDivergence: raw.onDivergence ?? null,
    lockstepJournal: raw.lockstepJournal ? { maxTicks: raw.lockstepJournal.maxTicks } : null,
    intents:  raw.intents ?? {},
    simulate: raw.simulate ?? null,
    slowTick: raw.slowTick ? { hz: raw.slowTick.hz, fn: raw.slowTick.fn } : null,
    deltas:   raw.deltas ?? false,
    space:    raw.space ? { cell: raw.space.cell } : null,
    history:    raw.history ? { ticks: raw.history.ticks, extract: raw.history.extract ?? extractFromSpace, interp: raw.history.interp ?? (2 * (1000 / tickHz)) } : null,
    // anti-triche — cf. def.suspect/antiRejeu/onSuspicion plus haut
    suspect:     raw.suspect ?? null,
    antiReplay:   raw.antiReplay ?? false,
    onSuspicion: raw.onSuspicion ?? null,
    // anti-triche — cf. def.spectatorView plus haut : repli sur le `view` AUTEUR (jamais
    // le défaut état-complet, cf. raw.view !== undefined — PAS `raw.view` seul, qui vaudrait aussi
    // pour le défaut déjà appliqué à `view` résolu plus haut) UNIQUEMENT hors lockstep (raw.view y
    // est de toute façon TOUJOURS undefined, cf. validation plus haut — garde explicite quand même,
    // MÊME style défensif que le `view` résolu lui-même juste au-dessus).
    spectatorView: raw.spectatorView ?? (raw.view !== undefined && mode !== 'lockstep' ? (game: Game) => raw.view!(game, null) : null),
    log,
  }
}
