// mjs-server/matchmaking — l'entrée : trames µgame:play/move/leave/resync (cf. index.ts pour le
// tableau complet des trames). Possède les 3 registres vivants (file d'attente par type, parties
// par id, codes → id de partie) — game.ts ne connaît RIEN de ça, il ne gère qu'UNE instance.
//
// µgame:play { type, code? } — discrimination par TYPE de `code`, jamais par sa seule présence :
//   - absent                → file d'attente publique (`places` atteintes → partie créée)
//   - `true` (booléen)      → crée une partie privée NEUVE, code généré (réponse le porte)
//   - "XXXXX" (chaîne)      → rejoint la partie privée existant à ce code (inconnu → erreur)
// `code` sous quelque forme que ce soit exige `def.code === true`, sinon erreur claire.

import type { MjsWsApp, MjsWsClient } from '../mjs-ws/index.js'
import type { MjsServerResolvedDef } from './game-def.js'
import { Game, createGame, restoreGame, peerIdOf } from './game.js'
import type { MjsServerSeat, MjsServerGameSnapshot, MjsServerGameStats } from './game.js'
// anti-triche — quota de coups PAR IDENTITÉ agrégé (cf. quotasIdentite plus bas), MÊME
// primitive que game.ts::_consumeToken/_consumeHashToken (guard.ts, déjà composée là-bas)
import { TokenBucket } from '../mjs-ws/guard.js'
// anti-brute-force sur le CODE de partie privée — MÊME classe/patron que
// accounts.ts::account:login (failuresByIp), réutilisée TELLE QUELLE (jamais réimplémentée), cf.
// codeFailures plus bas
import { FailureBucket } from '../mjs-ws/accounts.js'
// couture persistance (persist.ts) — `null` si opts.persist absent (cf. index.ts) :
// TOUS les call-sites ci-dessous passent par `persist?.` (optional chaining), zéro coût sinon
import type { MjsServerPersistEngine } from './persist.js'
import { t } from '../messages/index.js'

const ALPHABET_CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'   // sans 0/O/1/I — ambiguïté typographique
const CODE_LENGTH = 5

// anti-brute-force code de partie privée (32^5 ≈ 33M codes, aucun autre rempart
// que le rate-limit transport générique) — défaut CONSERVATEUR toujours actif (contrairement à
// movesPerIdentity, opt-in) : `codePerIp` de createMatchmaking (dernier paramètre) vaut CE défaut tant
// qu'aucun appelant direct n'en passe un autre (index.ts n'en expose PAS encore l'option publique,
// hors périmètre de ce correctif) ; `null` explicite désactive le verrou.
const DEFAULT_CODE_PAR_IP_CAPACITY  = 10
const DEFAULT_CODE_PAR_IP_WINDOW_MS = 60000   // 10 échecs/min/IP

// plafond de la file d'attente publique — sans lui, `queues` (une entrée par
// IDENTITÉ distincte, cf. idempotence de file plus bas) grossit sans borne : N identités qui jouent
// µgame:play sans jamais atteindre def.seats font gonfler la mémoire indéfiniment. Défaut
// TOUJOURS actif (même politique que codePerIp) — `null` explicite désactive le plafond.
const DEFAULT_QUEUE_CAP = 1000

export interface MjsServerMatchmaking {
  /** cf. index.ts — composé avec opts.onDisconnect (MJS-WS), jamais appelé pour un client jamais assis nulle part */
  onClientDisconnect(client: MjsWsClient): void
  /** cf. index.ts — app.stop() : coupe tous les setTimeout vivants (aucun ne doit survivre à l'arrêt) */
  destroyAll(): void
  /** persist.ts (boot, AVANT le vrai listen) — restaure UNE partie depuis un instantané dans les
   *  registres parties/codes ; `false` si `données.type` n'est déclaré par AUCUN app.game() (log
   *  côté appelant, entrée ignorée, jamais un throw qui bloquerait tout le boot pour une seule
   *  partie orpheline). Id restauré JAMAIS réattribué ensuite (cf. generateGameId plus bas). */
  restoreGameFromSnapshot(data: MjsServerGameSnapshot): boolean
}

/** Câble les 4 handlers `µgame:*` sur `baseServe` (jamais `app.serve` lui-même — déjà gardé par
 *  index.ts contre le préfixe réservé au moment où ce module tourne) et possède les registres.
 *  `baseOn` — MÊME esprit que `baseServe`, pour µgame:hash : fire-and-forget (PAS
 *  d'ack, cf. mjs-ws/core.ts routeAppMessage — un message SANS id n'invoque jamais un handler serve(),
 *  seulement les abonnés on()), cf. handlerHash plus bas.
 *  `persist` — `null` si `opts.persist` absent, cf. persist.ts pour le contrat.
 *  `gameStats` (anti-triche) — compteurs APP-ENTIÈRE créés par index.ts::mjsServer(), rattachés
 *  à CHAQUE partie ci-dessous (MÊME patron que `persist?.armGame`) : jamais `null` en usage réel
 *  (seul le défaut sert les tests qui appellent createMatchmaking directement sans passer par mjsServer()).
 *  `movesPerIdentity` (anti-triche) — cf. MjsServerAntiTricheOptions.movesPerIdentity
 *  (index.ts, déjà validée [n, fenêtreMs] à cet appel) : `null` = option absente, AUCUN contrôle
 *  (défaut, MÊME politique que persist/gameStats ci-dessus pour les tests directs).
 *  `codePerIp` — [capacité, fenêtreMs] pour le verrou anti-brute-force sur les
 *  tentatives de join par CODE échouées (cf. codeFailures plus bas) ; défaut TOUJOURS actif
 *  (DEFAULT_CODE_PAR_IP_*, contrairement à movesPerIdentity qui est opt-in) — `null` explicite pour
 *  désactiver. index.ts n'expose PAS encore d'option publique pour le repasser (hors périmètre). */
export function createMatchmaking(app: MjsWsApp, gameDefs: Map<string, MjsServerResolvedDef>, baseServe: MjsWsApp['serve'], baseOn: MjsWsApp['on'], persist: MjsServerPersistEngine | null = null, gameStats: MjsServerGameStats | null = null, movesPerIdentity: [number, number] | null = null, codePerIp: [number, number] | null = [DEFAULT_CODE_PAR_IP_CAPACITY, DEFAULT_CODE_PAR_IP_WINDOW_MS], queueCap: number | null = DEFAULT_QUEUE_CAP): MjsServerMatchmaking {
  const queues     = new Map<string, MjsWsClient[]>()     // type → tickets FIFO
  const queuedType = new Map<MjsWsClient, string>()        // reverse index — retrait O(1) sur déconnexion
  // idempotence de file (anti-triche) — type → Set des IDENTITÉS (peerIdOf) déjà
  // en file pour ce type : empêche un spam de µgame:play (même connexion qui rejoue, OU 2e onglet
  // de la MÊME identité) de pousser plusieurs tickets — cf. matchmaking.ts:130-152
  // (file.push SANS idempotence → N tickets → N sièges fantômes → partie jamais vidée). Nettoyé
  // aux DEUX points de sortie de la file (appariement ET déconnexion, cf. plus bas) — jamais laissé
  // traîner. Indépendant de `queuedType` ci-dessus (celui-ci reste keyé par CONNEXION, pour le
  // retrait O(1) du tableau `queues` lui-même — inchangé).
  const queuedIdentities = new Map<string, Set<string>>()
  const games    = new Map<string, Game>()
  const codes      = new Map<string, string>()             // code → id de partie
  // anti-triche — quota de coups PAR IDENTITÉ agrégé sur TOUTES les parties vivantes (cf.
  // movesPerIdentity plus haut) : SEUL endroit qui voit toutes les parties (cf. tête de fichier) —
  // un seau à jetons (TokenBucket) PAR IDENTITÉ, jamais par partie : TOUTES les parties d'une même
  // identité PARTAGENT LE MÊME bucket (Map keyée SEULEMENT par id), c'est précisément ce qui borne
  // le farm multi-parties. Attaché à CHAQUE partie via `partie._identityQuota` (MÊME patron que
  // `_gameStats`, cf. create()/restoreGameFromSnapshot plus bas) ; vide et jamais consultée si
  // `movesPerIdentity` est `null` (coût nul, cf. identityQuotaOk).
  // RÉTENTION (corrigé) — le bucket d'une identité NE SE RÉINITIALISE JAMAIS sur
  // un simple leave/rejoin (cf. l'ancien nettoyerQuotaIdentiteSiVide, qui le SUPPRIMAIT dès le siège
  // vide — un rejoin recréait alors un bucket PLEIN, reset gratuit du quota agrégé). Purge désormais
  // UNIQUEMENT par TTL = fenêtreMs (movesPerIdentity[1]) depuis le dernier `take()` — cf.
  // purgeExpiredIdentityQuotas plus bas pour la justification (passé ce délai le seau est de toute
  // façon GARANTI plein, purger et recréer à la demande est donc STRICTEMENT équivalent à le garder).
  // `lastSeen` = date du dernier take(), Map ré-insérée en fin d'accès (ordre = ancienneté) — MÊME
  // patron que accounts.ts::FailureBucket::_touch, réutilisé en esprit ici (structure interne différente,
  // le bucket doit rester attaché à `partie._identityQuota` via la closure identityQuotaOk).
  const identityQuotas = new Map<string, { bucket: TokenBucket; lastSeen: number }>()
  // anti-brute-force code de partie privée (cf. tête de fichier) — PAR IP,
  // FailureBucket (accounts.ts) réutilisée telle quelle : `isBlocked` AVANT toute résolution de code
  // (cf. checkCodeLockout), `recordCodeFailure` SEULEMENT sur code inexistant — jamais sur 'partie
  // complète' (code réel, pas une tentative de deviner) ni
  // sur un code invalide/format (déjà refusé bon marché par handlerPlay, avant d'arriver ici). `null`
  // si `codePerIp` désactivé (coût nul).
  const codeFailures = codePerIp ? new FailureBucket(codePerIp[0], codePerIp[1]) : null
  let _gameCounter = 0
  // true PENDANT app.stop() (destroyAll) — cf. onGameDestroyed : détruire pour un ARRÊT SERVEUR
  // ne doit JAMAIS effacer la partie du stockage persistant (elle doit revivre au prochain boot via
  // persist.ts load()), contrairement à une VRAIE fin de partie (end/emptyTtl/annulation de sièges)
  let stopping = false

  function generateGameId(): string { return 'game' + (++_gameCounter) }

  /** create() + armGame() persistance — SEUL point d'entrée pour une partie FRAÎCHE
   *  (les 3 call-sites ci-dessous), symétrique de restoreGameFromSnapshot pour une partie
   *  RESTAURÉE : les deux chemins arment la MÊME couture, jamais deux logiques qui divergent. */
  function create(def: MjsServerResolvedDef): Game {
    const game = createGame(app, def, onGameDestroyed, generateGameId())
    game._gameStats = gameStats
    // anti-triche — `null` si movesPerIdentity absent (cf. tête de fichier) : game.ts
    // court-circuite alors la garde entièrement (if (this._identityQuota && ...)), coût nul.
    if (movesPerIdentity) game._identityQuota = identityQuotaOk
    persist?.armGame(game)
    return game
  }

  function generateCode(): string {
    let code: string
    do {
      code = ''
      for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET_CODE[Math.floor(Math.random() * ALPHABET_CODE.length)]
    } while (codes.has(code))
    return code
  }

  function onGameDestroyed(game: Game): void {
    games.delete(game.id)
    if (game.code) codes.delete(game.code)
    // cf. `stopping` ci-dessus — un arrêt serveur détruit les parties vivantes (timers coupés)
    // SANS jamais les effacer du stockage persistant, seule une VRAIE fin de partie le fait
    if (!stopping) persist?.forgetGame(game.id)
    // anti-triche — la destruction d'une partie est un point d'activité naturel pour
    // borner `quotasIdentite` (cf. purgeExpiredIdentityQuotas plus bas) ; PLUS d'occupation de
    // siège consultée ici (cf. tête de fichier « RÉTENTION ») — un bucket
    // ne dépend plus de la présence en siège, seulement du TTL.
    if (movesPerIdentity) purgeExpiredIdentityQuotas(Date.now())
  }

  // --- anti-triche (quota de coups par identité, cf. quotasIdentite/movesPerIdentity
  // plus haut) — seau à jetons PAR IDENTITÉ, PARTAGÉ entre toutes ses parties vivantes -----------

  const QUOTA_IDENTITY_SWEEP_MAX = 8   // borne le coût d'un passage — MÊME patron que accounts.ts::ECHEC_SWEEP_MAX

  function identityQuotaOk(id: string): boolean {
    if (!movesPerIdentity) return true
    const now = Date.now()
    purgeExpiredIdentityQuotas(now)
    let entry = identityQuotas.get(id)
    if (entry) identityQuotas.delete(id)   // ré-insère en fin ci-dessous — ordre = ancienneté de dernier accès
    else entry = { bucket: new TokenBucket(movesPerIdentity[0], movesPerIdentity[0] / (movesPerIdentity[1] / 1000)), lastSeen: now }
    entry.lastSeen = now
    identityQuotas.set(id, entry)
    return entry.bucket.take()
  }

  /** purge les buckets INACTIFS depuis plus de `movesPerIdentity[1]` (fenêtreMs) — cf. « RÉTENTION »
   *  en tête de fichier pour la justification complète : passé ce délai sans `take()`, le TokenBucket
   *  est GARANTI plein (refill continu borné à sa capacité) donc le purger puis le recréer à la
   *  demande (cf. identityQuotaOk) est STRICTEMENT équivalent à le garder — zéro perte de rigueur du
   *  quota, zéro fuite mémoire (une identité qui ne rejoue plus jamais finit purgée). PLUS aucune
   *  dépendance à l'occupation de siège (contrairement à l'ancien nettoyerQuotaIdentiteSiVide,
   *  remplacé) : un leave/rejoin, quelle que soit la partie visée, ne touche
   *  JAMAIS `lastSeen`. Balayage borné (`QUOTA_IDENTITE_SWEEP_MAX`) sur une Map ordonnée par
   *  ancienneté d'accès (ré-insertion dans identityQuotaOk) — s'arrête au premier bucket encore
   *  valide, MÊME patron que accounts.ts::FailureBucket::_touch. No-op si l'option est absente. */
  function purgeExpiredIdentityQuotas(now: number): void {
    if (!movesPerIdentity) return
    const ttl = movesPerIdentity[1]
    let evicted = 0
    for (const [id, entry] of identityQuotas) {
      if (now - entry.lastSeen <= ttl) break
      identityQuotas.delete(id)
      if (++evicted >= QUOTA_IDENTITY_SWEEP_MAX) break
    }
  }

  // --- idempotence de file (anti-triche, cf. queuedIdentities plus haut) -------

  function isQueued(type: string, id: string): boolean {
    return queuedIdentities.get(type)?.has(id) ?? false
  }

  function enqueue(type: string, id: string): void {
    let s = queuedIdentities.get(type)
    if (!s) { s = new Set(); queuedIdentities.set(type, s) }
    s.add(id)
  }

  function dequeue(type: string, id: string): void {
    queuedIdentities.get(type)?.delete(id)
  }

  /** cherche, parmi les parties VIVANTES (encore dans le registre `parties` — cf.
   *  onGameDestroyed, jamais de fenêtre où une partie détruite y traînerait encore : la
   *  suppression est SYNCHRONE dans le même appel que _destroy()) de CE type, celle où cette
   *  IDENTITÉ (peerIdOf) occupe déjà un siège — balayage O(n) sur les parties vivantes, MÊME
   *  échelle v1 que onClientDisconnect plus bas (pas d'index inverse, cf. son commentaire).
   *  Scopé par TYPE (jamais cross-type) : une même identité PEUT légitimement occuper un siège
   *  dans plusieurs parties de types DIFFÉRENTS (v1 ne l'empêche pas, cf. onClientDisconnect) —
   *  seule la dédup INTRA-type est visée ici. Utilisé par playQueued pour réattacher un 2e
   *  onglet/spam de µgame:play À LA PARTIE où il est déjà assis plutôt que de créer un 2e ticket
   *  (qui, via la dédup de game.ts::_createSeat, finirait de toute façon par réattacher — ceci
   *  évite juste de repasser par une file/un appariement pour rien). */
  function findGameOfIdentity(type: string, id: string): Game | null {
    for (const game of games.values()) {
      if (game.type !== type) continue
      if (game.players.some(j => j !== null && j.id === id)) return game
    }
    return null
  }

  // `game._infoMode(player)` porte `{view}` (authoritative) OU `{seed, journal}`
  // (lockstep, cf. game.ts) : SEUL endroit qui varie entre les deux modes, spread tel quel.
  function seatResponse(game: Game, player: MjsServerSeat): unknown {
    return { game: game.id, seat: player.seat, ...game._infoMode(player), phase: game.phase, turn: game.turn, seq: game.seq, code: game.code }
  }

  /** µgame:start poussé à un siège NON appelant direct — l'appelant direct reçoit l'équivalent via sa propre réponse */
  function pushStart(game: Game, player: MjsServerSeat): void {
    const frame = { game: game.id, seat: player.seat, ...game._infoMode(player), phase: game.phase, turn: game.turn, seq: game.seq, code: game.code }
    for (const client of player.clients) app.send(client, 'µgame:start', frame)
  }

  /** 1re fois que `places` est atteint → µgame:start à tous les AUTRES sièges déjà occupés (jamais deux fois) */
  function markStartedIfFull(game: Game, directPlayer: MjsServerSeat | null): void {
    if (game._started) return
    const full = game.players.filter((j): j is MjsServerSeat => j !== null).length === game.def.seats
    if (!full) return
    game._started = true
    for (const autre of game.players) { if (autre && autre !== directPlayer) pushStart(game, autre) }
  }

  // --- code : créer / rejoindre ----------------------------------------------------------------

  function createWithCode(def: MjsServerResolvedDef, client: MjsWsClient): unknown {
    const game = create(def)
    game.code = generateCode()
    codes.set(game.code, game.id)
    games.set(game.id, game)
    const player = game._createSeat(client)
    markStartedIfFull(game, player)
    return seatResponse(game, player)
  }

  // anti-brute-force code (cf. codeFailures plus haut) — `ipOf` MÊME fonction que
  // accounts.ts::ipDe (copiée, pas importée : un paquet n'a pas à dépendre d'un autre pour un
  // one-liner, MÊME raison que accounts.ts a copié bridge.ts::createBridgeRateLimiter en tête de
  // fichier). `undefined` (transport qui n'expose pas l'IP, ex. MemoryTransport en test) retombe sur
  // UNE clé 'unknown' partagée — PAS le même choix que core.ts::maxConnectionsPerIp (qui EXEMPTE les
  // IP inconnues), volontairement : ici mieux vaut un faux-partage bénin (IP inconnues limitées
  // ENSEMBLE) qu'un verrou totalement inopérant derrière un proxy qui ne transmet jamais l'IP.
  function ipOf(client: MjsWsClient): string { return client.meta.address ?? 'unknown' }

  /** refuse IMMÉDIATEMENT (avant toute résolution de code) si cette IP est déjà en pénalité — MÊME
   *  message qu'un rejet ordinaire du module (throw new Error), rien de spécifique côté client. */
  function checkCodeLockout(client: MjsWsClient): void {
    if (!codeFailures) return
    if (codeFailures.isBlocked(ipOf(client))) throw new Error(t('serveur.matchmaking-trop-tentatives-code'))
  }

  /** à appeler UNIQUEMENT sur code INEXISTANT (cf. call-sites) — jamais sur 'partie complète' (code
   *  RÉEL, pas une tentative de deviner) ni sur un format déjà refusé bon marché par handlerPlay.
   *  Retourne `true` = encore DANS le budget (reste 'code inconnu' normal) ; `false` = CET appel
   *  vient de faire déborder le seau — reclassement IMMÉDIAT de la réponse EN COURS en lockout,
   *  MÊME contrat/raison que accounts.ts::FailureBucket::recordFailure (cf. son commentaire) : sans
   *  ce reclassement, la tentative qui déclenche le verrou recevrait encore 'code inconnu', et
   *  seule la SUIVANTE verrait le lockout (cf. checkCodeLockout, qui ne s'applique qu'AVANT
   *  résolution) — décalage d'un cran par rapport au seuil configuré (`codePerIp[0]`). */
  function recordCodeFailure(client: MjsWsClient): boolean {
    return codeFailures ? codeFailures.recordFailure(ipOf(client)) : true
  }

  function joinWithCode(def: MjsServerResolvedDef, client: MjsWsClient, code: string): unknown {
    checkCodeLockout(client)
    const gameId = codes.get(code)
    const game = gameId !== undefined ? games.get(gameId) : undefined
    if (!game) throw new Error(recordCodeFailure(client) ? t('serveur.matchmaking-code-inconnu', { code: code }) : t('serveur.matchmaking-trop-tentatives-code'))
    const alreadySeated = game._findSeatOf(client)
    if (alreadySeated) return seatResponse(game, alreadySeated)   // même connexion qui rejoue play : idempotent
    const player = game._createSeat(client)   // throw 'partie complète' si déjà pleine — PAS un échec de code, non comptabilisé
    markStartedIfFull(game, player)
    return seatResponse(game, player)
  }

  // --- file d'attente publique --------------------------------------------------------------

  // v1 — seatTtl couvre UNIQUEMENT les sièges issus de la file (le
  // fondateur d'une partie par code est confirmé par sa propre requête, rien à surveiller tant
  // qu'il reste connecté ; emptyTtl suffit à purger un fondateur qui repart sans jamais recevoir
  // personne). À l'expiration : la partie ENTIÈRE est annulée (pas de re-complétion depuis la
  // file) — le plus simple des deux choix envisagés, documenté ici.
  function playQueued(def: MjsServerResolvedDef, client: MjsWsClient): unknown {
    // idempotence (anti-triche) — CETTE identité (peerIdOf, cf. game.ts) est
    // déjà en file OU déjà assise dans une partie VIVANTE de ce type : ignore/réattache plutôt que
    // de pousser un 2e ticket (cf. matchmaking.ts:130-152 — un spam de µgame:play
    // prenait autant de tickets que d'appels, jusqu'à des sièges fantômes qui ne vident jamais la
    // partie). Déjà en file → réponse IDENTIQUE à celle du 1er ticket (même {attente}, aucun 2e
    // push) ; déjà assise → réattache CETTE connexion au siège existant (_createSeat dédup en
    // interne, cf. game.ts) et renvoie sa réponse de siège, comme si elle rejouait play() après
    // coup — jamais un 2e siège, jamais une 2e partie.
    const id = peerIdOf(client)
    if (isQueued(def.type, id)) return { queue: (queues.get(def.type) ?? []).length }
    const existingGame = findGameOfIdentity(def.type, id)
    if (existingGame) {
      const player = existingGame._createSeat(client)
      return seatResponse(existingGame, player)
    }

    let queue = queues.get(def.type)
    if (!queue) { queue = []; queues.set(def.type, queue) }
    // plafond — refuse le ticket AVANT de le pousser, jamais une file qui
    // grossit sans borne (queueCap null = plafond désactivé, cf. tête de fichier)
    if (queueCap !== null && queue.length >= queueCap) throw new Error(t('serveur.matchmaking-file-pleine', { type: def.type }))
    queue.push(client)
    queuedType.set(client, def.type)
    enqueue(def.type, id)
    if (queue.length < def.seats) return { queue: queue.length }

    const tickets = queue.splice(0, def.seats)
    for (const t of tickets) { queuedType.delete(t); dequeue(def.type, peerIdOf(t)) }
    const game = create(def)
    games.set(game.id, game)
    game._started = true   // née complète par construction — jamais un 2e µgame:start pour elle

    const unconfirmedIds: string[] = []
    let callerSeat: MjsServerSeat | null = null
    for (const ticket of tickets) {
      const player = game._createSeat(ticket)
      if (ticket === client) callerSeat = player
      else { unconfirmedIds.push(player.id); pushStart(game, player) }
    }
    game._armConfirmWindow(unconfirmedIds, def.seatTtl)
    return seatResponse(game, callerSeat!)
  }

  // --- spectateurs (anti-triche, lecture seule) ------------------------------------

  /** rejoint une partie EXISTANTE comme spectateur — adressée PAR CODE, MÊME registre `codes` que
   *  joinWithCode : aucune ambiguïté possible (contrairement à la file publique, où plusieurs
   *  parties du MÊME type peuvent être vivantes en parallèle — rien n'identifierait LAQUELLE
   *  regarder). N'occupe AUCUN siège (cf. partie._addSpectator) — jamais de _createSeat,
   *  jamais de marquerDemarreeSiComplete. `siege: null` EXPLICITE (jamais `undefined`) — MÊME
   *  invariant que côté client (store.siege = null tant que jamais assis, cf. mjs_game.ts). */
  function joinAsSpectator(client: MjsWsClient, code: string): unknown {
    checkCodeLockout(client)   // MÊME verrou anti-brute-force que joinWithCode — même registre `codes`, même risque de devinette
    const gameId = codes.get(code)
    const game = gameId !== undefined ? games.get(gameId) : undefined
    if (!game) throw new Error(recordCodeFailure(client) ? t('serveur.matchmaking-code-inconnu', { code: code }) : t('serveur.matchmaking-trop-tentatives-code'))
    const info = game._addSpectator(client)
    return { game: game.id, seat: null, spectator: true, phase: game.phase, turn: game.turn, seq: game.seq, code: game.code, ...info }
  }

  // --- les 4 handlers µgame:* --------------------------------------------------------------

  function handlerPlay(p: any, client: MjsWsClient): unknown {
    if (typeof p?.type !== 'string') throw new Error(t('serveur.matchmaking-play-type-manquant'))
    const def = gameDefs.get(p.type)
    if (!def) throw new Error(t('serveur.matchmaking-type-jeu-inconnu', { type: p.type }))
    // anti-triche — drapeau spectateur SUR µgame:play (jamais une trame séparée : réutilise
    // l'ack/le rejeu-après-coupure déjà câblés côté client, cf. mjs_game.ts).
    // Adressage PAR CODE UNIQUEMENT (cf. joinAsSpectator) : une file publique peut avoir
    // PLUSIEURS parties du même type vivantes en parallèle, rien n'identifierait laquelle regarder.
    if (p.spectator !== undefined && p.spectator !== true) throw new Error(t('serveur.matchmaking-spectateur-doit-etre-bool'))
    if (p.spectator === true) {
      if (!def.code) throw new Error(t('serveur.matchmaking-spectateur-sans-code-prive', { type: p.type }))
      if (typeof p.code !== 'string' || p.code === '') throw new Error(t('serveur.matchmaking-spectateur-code-requis'))
      return joinAsSpectator(client, p.code)
    }
    if (p.code === true) {
      if (!def.code) throw new Error(t('serveur.matchmaking-jeu-sans-parties-privees', { type: p.type }))
      return createWithCode(def, client)
    }
    if (typeof p.code === 'string') {
      if (p.code === '') throw new Error(t('serveur.matchmaking-code-invalide'))
      if (!def.code) throw new Error(t('serveur.matchmaking-jeu-sans-parties-privees', { type: p.type }))
      return joinWithCode(def, client, p.code)
    }
    if (p.code !== undefined) throw new Error(t('serveur.matchmaking-code-invalide'))
    return playQueued(def, client)
  }

  // coups async : `await` fait remonter une éventuelle rejection au try/catch de
  // routeAppMessage (mjs-ws/core.ts — log + µ:ack{e:true,p:errMessage(err)}) ; SANS lui, un move
  // async n'était JAMAIS attendu ici, donc un rejet ultérieur devenait orphelin (jamais loggué ni
  // renvoyé). Corrige aussi un bug de VALEUR : un move async RÉUSSI renvoyait `{}` (Promise
  // sérialisée telle quelle) au lieu de sa vraie valeur de résolution. AUCUN nouveau format
  // d'erreur — celui déjà utilisé par tout throw synchrone.
  async function handlerMove(p: any, client: MjsWsClient): Promise<unknown> {
    if (typeof p?.game !== 'string') throw new Error(t('serveur.matchmaking-move-partie-manquante'))
    if (typeof p?.move !== 'string') throw new Error(t('serveur.matchmaking-move-coup-manquant'))
    const game = games.get(p.game)
    if (!game) throw new Error(t('serveur.matchmaking-partie-introuvable'))
    return { ok: true, result: await game._onMove(client, p.move, p.p) }
  }

  function handlerLeave(p: any, client: MjsWsClient): unknown {
    if (typeof p?.game !== 'string') throw new Error(t('serveur.matchmaking-leave-partie-manquante'))
    const game = games.get(p.game)
    if (!game) throw new Error(t('serveur.matchmaking-partie-introuvable'))
    game._leave(client)   // gère aussi bien un siège qu'un spectateur, cf. son commentaire
    // anti-triche — le quota de CETTE identité n'est JAMAIS réinitialisé par ce leave (cf.
    // « RÉTENTION » en tête de fichier) : simple point d'activité pour borner
    // `quotasIdentite` par TTL, rien de plus.
    if (movesPerIdentity) purgeExpiredIdentityQuotas(Date.now())
    return { ok: true }
  }

  function handlerResync(p: any, client: MjsWsClient): unknown {
    if (typeof p?.game !== 'string') throw new Error(t('serveur.matchmaking-resync-partie-manquante'))
    const game = games.get(p.game)
    if (!game) throw new Error(t('serveur.matchmaking-partie-introuvable'))
    const { seat, info } = game._resync(client)
    return { game: game.id, seat, ...info, phase: game.phase, turn: game.turn, seq: game.seq, code: game.code }
  }

  // µgame:hash — fire-and-forget (PAS d'ack, cf. commentaire de createMatchmaking) :
  // trame malformée ou partie/joueur introuvable → silencieusement ignorée (best-effort, jamais un
  // throw qui n'aurait de toute façon personne à qui le remonter).
  function handlerHash(p: any, client: MjsWsClient): void {
    if (typeof p?.game !== 'string' || typeof p?.tick !== 'number' || typeof p?.h !== 'string') return
    const game = games.get(p.game)
    game?._receiveHash(client, p.tick, p.h)
  }

  baseServe('µgame:play', handlerPlay)
  baseServe('µgame:move', handlerMove)
  baseServe('µgame:leave', handlerLeave)
  baseServe('µgame:resync', handlerResync)
  baseOn('µgame:hash', handlerHash)

  return {
    onClientDisconnect(client: MjsWsClient): void {
      // file d'attente — retire le ticket s'il y est encore (hygiène : garantit qu'un siège
      // issu de la file n'est JAMAIS attribué à une connexion déjà morte, cf. seatTtl au-dessus)
      const type = queuedType.get(client)
      if (type !== undefined) {
        queuedType.delete(client)
        dequeue(type, peerIdOf(client))
        const queue = queues.get(type)
        if (queue) { const i = queue.indexOf(client); if (i !== -1) queue.splice(i, 1) }
      }
      // un même client PEUT occuper un siège dans plusieurs parties (types différents, v1 ne
      // l'empêche pas) — parcours de toutes les parties vivantes (échelle v1 : pas d'index inverse)
      for (const game of games.values()) game._onDisconnect(client)
      // anti-triche — le siège reste OCCUPÉ après une déconnexion (v1, pas de kick auto,
      // cf. _onDisconnect) ; le quota de cette identité n'y est PLUS lié
      // (cf. « RÉTENTION » en tête de fichier) — simple point d'activité pour la purge par TTL.
      if (movesPerIdentity) purgeExpiredIdentityQuotas(Date.now())
    },

    destroyAll(): void {
      stopping = true
      for (const game of Array.from(games.values())) game._destroy()
    },

    restoreGameFromSnapshot(data: MjsServerGameSnapshot): boolean {
      const def = gameDefs.get(data.type)
      if (!def) return false
      const game = restoreGame(app, def, onGameDestroyed, data)
      game._gameStats = gameStats
      if (movesPerIdentity) game._identityQuota = identityQuotaOk
      games.set(game.id, game)
      if (game.code) codes.set(game.code, game.id)
      // ids restaurés JAMAIS réattribués ensuite — sans ça, une partie fraîche créée après un
      // redémarrage pourrait un jour recevoir le MÊME id qu'une partie restaurée encore vivante
      // (compteur reparti de 0) et écraser silencieusement son entrée dans `games`. Un instantané
      // d'AVANT l'anglicisation porte `partie<n>` (pas encore passé par migrate-games-fr-to-en) :
      // volontairement PAS lu ici — espace de noms disjoint de `game<n>`, aucune collision possible
      const m = /^game(\d+)$/.exec(game.id)
      if (m) _gameCounter = Math.max(_gameCounter, Number(m[1]))
      persist?.armGame(game)
      return true
    },
  }
}
