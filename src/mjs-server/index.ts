// MJS-Server — module de jeu OPTIONNEL au-dessus de MJS-WS (src/mjs-ws/, intouché sauf une accroche
// générique ajoutée à sa demande, cf. plus bas) : couche « salle de partie » COMPOSÉE par-dessus
// l'API PUBLIQUE MJS-WS (app.serve/on/send/sendUser/clients/stop…), jamais par réimplémentation.
// API magique : la couche de trames µgame: est INVISIBLE pour l'appli hôte, qui ne voit que
// `app.game(type, def)` + les objets `partie` passés à ses moves/vues/hooks. Tour par tour
// événementiel par défaut (tick=0) ; mode ACTION à boucle de tick (tick 1-60 Hz, intentions,
// deltas par joueur, zones d'intérêt) — cf. game.ts (validation) et game.ts (commentaire de tête).
// def.mode : 'authoritative' (défaut, décrit ci-dessus, INCHANGÉ) | 'lockstep' — la
// salle ne simule RIEN, seuls les ORDRES (µgame:move) circulent, groupés par tick et diffusés à
// l'identique à tous (µgame:orders) ; cf. mjs-server/lockstep.ts pour le contrat complet, et plus bas
// pour les trames spécifiques (µgame:orders/hash, formes lockstep de play/start/resync).
//
//   import { mjsServer } from 'modularjs-framework/mjs-server'
//   app = mjsServer({ auth: (hello) => ({ id: hello.auth.uid }) })   // MÊMES options que mjsWs()
//   app.game('morpion', {
//     places: 2, code: true,
//     state: (partie) => ({ grille: Array(9).fill(null) }),
//     moves: { jouer: (partie, joueur, p) => { partie.state.grille[p.i] = joueur.id; partie.next() } },
//     turns: { order: 'roundrobin', timeout: 30000 },
//   })
//   await app.listen()
//
// Le PROTOCOLE INTERNE (préfixe 'µgame:' RÉSERVÉ — app.serve/app.on d'un type 'µgame:*' par
// l'appli hôte → erreur claire immédiate) :
//
// Requêtes CLIENT → SERVEUR (app.serve, µ:ack en retour — succès = valeur, throw = ack d'erreur) :
//   µgame:play   { type, code?, spectateur? } → { attente: n } (file, pas encore complet)
//                                         | { partie, siege, phase, tour, seq, code, ...info } (assis)
//                                       `code` discriminé par TYPE, jamais par sa seule présence :
//                                         absent = file publique ; `true` = crée une partie privée
//                                         NEUVE (code généré, porté par la réponse) ; chaîne =
//                                         rejoint la partie privée à ce code (inconnu → erreur).
//                                       `code` sous quelque forme exige `def.code === true`.
//                                       `spectateur: true` (anti-triche, opt-in) — rejoint
//                                         EN LECTURE SEULE (`siege: null`, `places` inchangé) une
//                                         partie EXISTANTE adressée PAR CODE UNIQUEMENT (exige
//                                         `def.code === true` + un `code` chaîne — jamais la file
//                                         publique, ambiguë entre plusieurs parties du même type) ;
//                                         `...info` = `{ view }` via def.spectatorView (repli sur
//                                         def.view SI l'auteur l'a déclaré, SINON `{}` — jamais
//                                         l'état brut par défaut, cf. mjs-server/game.ts::
//                                         _spectatorView). Tout µgame:move ultérieur → rejeté
//                                         (« spectateur : lecture seule »).
//                                       `...info` (game.ts::_infoMode) = `{ view }` (authoritative)
//                                         | `{ seed, journal }` (lockstep — journal
//                                         COMPLET des ordres à ce jour, cf. mjs-server/lockstep.ts).
//   µgame:move   { partie, coup, p? }  → { ok: true, resultat } — throw (garde interne OU le move
//                                       lui-même) → ack d'erreur, comme tout app.serve() normal.
//                                       Mode lockstep : `resultat` toujours `undefined`
//                                       — le coup n'est PAS exécuté, il devient un ORDRE mis en file
//                                       pour le tick courant (diffusé à tous, cf. µgame:orders).
//   µgame:leave  { partie }            → { ok: true } — vide le siège (≠ déconnexion, qui le garde)
//   µgame:resync { partie }            → { partie, siege, phase, tour, seq, code, ...info } (cf.
//                                       µgame:play ci-dessus pour `...info`) — rattache CETTE
//                                       connexion à son siège (identité stable requise, cf.
//                                       peerIdOf/game.ts) et renvoie une info fraîche COMPLÈTE ;
//                                       en lockstep, le client REJOUE le journal reçu (cf. µ.lockstep).
//
// Requête CLIENT → SERVEUR fire-and-forget (app.on, PAS d'ack — mode lockstep) :
//   µgame:hash { partie, tick, h }     — hash FNV périodique de l'état local (cf. µ.lockstep,
//                                       src/runtime/mjs_lockstep.ts) ; le serveur compare les hashs
//                                       reçus au MÊME tick (cf. mjs-server/lockstep.ts receiveHash) —
//                                       concordants = silence, différents = µgame:event 'divergence'.
//
// Poussées SERVEUR → CLIENT (app.send, sans ack) :
//   µgame:state { partie, vue, phase, tour, seq }         — à CHAQUE mutation, SA vue par joueur,
//                                                          groupée par microtâche (tick=0) ou 1×/tick
//                                                          (mode action, tick>0) ; def.deltas: true
//                                                          remplace `vue` par `delta` (opérations
//                                                          {p,v}/{p,x:1}, cf. game.ts) SAUF repli
//                                                          vue complète (1re fois/resync/trop gros)
//                                                          — zéro trame si rien n'a changé. ABSENTE
//                                                          en mode lockstep (cf. µgame:orders).
//   µgame:orders { partie, tick, ordres: [{joueur,coup,p}] } — mode lockstep SEUL : 1×
//                                                          PAR TICK (boucle def.tick, MÊME cadence
//                                                          que le mode action), TOUJOURS diffusée
//                                                          (même `ordres: []`) — MÊME trame pour TOUS
//                                                          les sièges (l'égalité d'entrée est le cœur
//                                                          du déterminisme), cf. mjs-server/lockstep.ts.
//   µgame:event { partie, type, p }                       — partie.send(type, p), libre ; `type:
//                                                          'divergence'` {tick} réservé au mode
//                                                          lockstep (cf. def.onDivergence)
//   µgame:seat  { partie, places, sieges: [{siege,connecte}|null] } — roster, à chaque changement
//   µgame:start { partie, siege, phase, tour, seq, code, ...info } — 1re fois `places` atteint, aux
//                                                          sièges qui n'ont PAS eux-mêmes déclenché
//                                                          la complétion (qui l'ont via leur ack) ;
//                                                          `...info` cf. µgame:play ci-dessus
//   µgame:end   { partie, resultat }                      — partie.end(resultat), ou annulation
//                                                          (resultat: {annulee:true, raison})
//   µgame:left  { partie, siege }                         — départ volontaire d'un AUTRE joueur
//
// Accroche MJS-WS ajoutée (accroche PUBLIQUE, minimale, générique,
// testée côté MJS-WS) : `opts.onDisconnect(client, reason)`, cf. src/mjs-ws/index.ts + core.ts +
// docs/23-mjs-ws.md §1/§8.2. MJS-Server s'en sert pour marquer un siège déconnecté (jamais un kick
// auto v1) SANS exiger `opts.bridge` (webhook HTTP) juste pour ça — composée avec un éventuel
// `onDisconnect` déjà fourni par l'appli hôte (les deux tournent, jamais l'un à la place de l'autre).

import { mjsWs } from '../mjs-ws/index.js'
import type { MjsWsApp, MjsWsLogLevel, MjsWsOptions, MjsWsStatsSnapshot } from '../mjs-ws/index.js'
import { resolveGameDef } from './game-def.js'
import type { MjsServerGameDef, MjsServerResolvedDef } from './game-def.js'
import { createMatchmaking } from './matchmaking.js'
import type { MjsServerMatchmaking } from './matchmaking.js'
// anti-triche (détection par coup) — compteurs APP-ENTIÈRE greffés sur app.stats() ci-dessous
import type { MjsServerGameStats } from './game.js'
// persistance optionnelle (persist.ts) — absent (opts.persist) = AUCUN hook armé,
// cf. son commentaire de tête pour le contrat complet (adaptateurs mémoire/fichier/pont fournis
// à côté, persist-file.ts/persist-bridge.ts, jamais importés ICI — zéro dépendance croisée)
import { resolvePersistOption, createPersistEngine } from './persist.js'
import type { MjsServerPersistOption } from './persist.js'
import { t } from '../messages/index.js'

// resolveGameDef, matchmaking.ts::create(), restoreGameFromSnapshot(), Game — pas seulement des types : couture de la
// persistance à venir ET utilisées par les tests pour exercer directement des
// mécaniques internes non observables sur le fil (journal borné, anti-abus, aller-retour
// serialize/restore) sans avoir à faire déborder un plateau de morpion 3×3, cf. tests/mjs-server-core.test.ts.
export { resolveGameDef } from './game-def.js'
export type { MjsServerGameDef, MjsServerTurnsDef, MjsServerLimitsDef, MjsServerHooksDef, MjsServerHistoryDef, MjsServerResolvedDef } from './game-def.js'
export { Game, createGame, restoreGame, peerIdOf } from './game.js'
export type { MjsServerSeat, MjsServerGameSnapshot, MjsServerDeltaOp } from './game.js'
// anti-triche (détection par coup, cf. game.ts::_antiCheatGuard) — types du
// contrat def.suspect/antiRejeu/onSuspicion + compteurs app.stats().game, cf. plus bas dans ce fichier
export type { MjsServerSuspectContext, MjsServerSuspectResult, MjsServerSuspicionEvent, MjsServerGameStats } from './game.js'
// zone d'intérêt optionnelle — cf. space.ts pour le contrat complet
export { createSpace } from './space.js'
export type { MjsServerSpace } from './space.js'
// compensation de lag serveur — tampon circulaire, cf. history.ts pour le contrat complet
export { createHistory } from './history.js'
export type { MjsServerHistory, MjsServerHistoryPositions, MjsServerHistoryMeta } from './history.js'
// mode lockstep déterministe — cf. lockstep.ts pour le contrat complet ; utilisées par
// les tests pour exercer directement le moteur (journal/divergence) sans faire tourner un vrai jeu
export { createLockstep, deterministicSeed } from './lockstep.js'
export type { MjsServerLockstep, MjsServerLockstepOrder, MjsServerLockstepTick, MjsServerLockstepDivergence } from './lockstep.js'
// persistance optionnelle — façade + adaptateur mémoire ICI ; fichier/pont dans
// leurs propres fichiers (persist-file.ts/persist-bridge.ts), réexportés tels quels par symétrie
// encodeSnapshot/decodeSnapshot exportés POUR l'appli : un adaptateur maison doit encoder du texte
// avec la MÊME paire que les nôtres, jamais confier le typage au moteur (cf. persist.ts, la règle)
export { resolvePersistOption, createPersistEngine, MemoryPersistAdapter, DEFAULT_PERSIST_DEBOUNCE, encodeSnapshot, decodeSnapshot } from './persist.js'
export type { MjsServerPersistAdapter, MjsServerPersistOptions, MjsServerPersistOption, MjsServerResolvedPersist, MjsServerPersistEngine } from './persist.js'
export { FilePersistAdapter } from './persist-file.js'
export type { FilePersistAdapterOpts } from './persist-file.js'
export { BridgePersistAdapter } from './persist-bridge.js'
export type { BridgePersistAdapterOpts } from './persist-bridge.js'
export { RedisPersistAdapter } from './persist-redis.js'
export type { RedisPersistAdapterOpts } from './persist-redis.js'
export { SqlPersistAdapter } from './persist-sql.js'
export type { SqlPersistAdapterOpts, SqlDialect } from './persist-sql.js'
// contrat TYPÉ optionnel (confort DX) — cf. contract.ts (ZÉRO runtime, COMPOSÉ
// par-dessus mjs-ws/contract.ts), docs/24-mjs-server.md « Contrat typé »
export { asTypedGame, defineTypedGame } from './contract.js'
export type { MjsServerGameContract, MjsServerReservedState, TypedGame, MjsGameLoose, TypedGameDef } from './contract.js'
// paquets activables (cf. src/mjs-ws/packages.ts) — RÉ-EXPORTÉS ici pour
// l'ergonomie d'un fichier serveur MJS-Server pur (`import { mjsServer, definePackage } from
// 'modularjs-framework/mjs-server'`, sans import séparé depuis 'modularjs-framework/ws'). `app.use` lui-même n'a besoin
// d'AUCUNE ligne ici : hérité tel quel de MJS-WS (MjsServerApp extends MjsWsApp ci-dessous, l'objet
// app retourné par mjsWs() le porte déjà) — ce ré-export ne fait que rendre `definePackage`/
// `echoPackage`/`MjsPackage` atteignables depuis ce module, ZÉRO logique dupliquée.
export { definePackage, echoPackage } from '../mjs-ws/index.js'
export type { MjsPackage } from '../mjs-ws/index.js'

const RESERVED_PREFIX = 'µgame:'

/** app.stats() d'une MjsServerApp — instantané MJS-WS (mjs-ws/stats.ts, INCHANGÉ) + `jeu` : compteurs
 *  anti-triche agrégés (cf. MjsServerGameStats, game.ts) — extension PUREMENT ADDITIVE,
 *  greffée au moment du snapshot (cf. mjsServer() ci-dessous), jamais dans mjs-ws/stats.ts lui-même :
 *  MJS-Server COMPOSE sur l'API PUBLIQUE MJS-WS (cf. commentaire de tête du fichier), il ne modifie
 *  jamais son registre interne — un app.stats() consommé côté HTTP (bridge.ts GET /stats, /metrics
 *  JSON, /state) voit `jeu` automatiquement, la recomposition passe par LA MÊME clé `stats` de l'app. */
export interface MjsServerStatsSnapshot extends MjsWsStatsSnapshot {
  game: MjsServerGameStats
}

export interface MjsServerApp extends MjsWsApp {
  /** déclare un type de jeu — throw si `type` déjà déclaré, ou si `def` est invalide (game.ts, validation stricte) */
  game(type: string, def: MjsServerGameDef): void
  /** cf. MjsServerStatsSnapshot — TOUJOURS disponible, indépendant de opts.stats (comme app.stats()
   *  MJS-WS, cf. son commentaire) ; `jeu` reste à {0,0} tant qu'aucun jeu déclaré ne journalise quoi
   *  que ce soit (cf. game.ts::_reportSuspicion). */
  stats(): MjsServerStatsSnapshot
}

/** anti-triche (opt-in, anti-triche poussé au maximum) — options APP-ENTIÈRE
 *  (par opposition aux options PAR JEU de MjsServerGameDef.suspect/antiRejeu/limits.moveIntervalMs) :
 *  seul matchmaking.ts voit TOUTES les parties vivantes à la fois, cf. mjs-server/matchmaking.ts. */
export interface MjsServerAntiCheatOptions {
  /** quota de coups PAR IDENTITÉ agrégé sur TOUTES les parties vivantes de l'app (borne un bot qui
   *  farme plusieurs parties EN PARALLÈLE — les quotas def.limits.moves/moveIntervalMs restent PAR
   *  SIÈGE, PAR PARTIE, aveugles à ce cas précis) — `[n, fenêtreMs]`, MÊME convention TokenBucket
   *  que def.limits.moves (cf. mjs-server/matchmaking.ts::identityQuotaOk). Défaut `undefined`/`null`
   *  = AUCUN contrôle (opt-in explicite, MÊME politique que def.limits.moveIntervalMs). Registre
   *  tenu par matchmaking.ts (seul point qui voit toutes les parties vivantes d'un coup d'œil),
   *  nettoyé quand l'identité ne siège plus nulle part (cf. son commentaire de tête). */
  movesPerIdentity?: [number, number] | null
  /** anti-brute-force sur le CODE de partie privée (cf. matchmaking.ts
   *  ::DEFAULT_CODE_PAR_IP_*) — `[n, fenêtreMs]`, MÊME convention TokenBucket que movesPerIdentity
   *  ci-dessus. Défaut `undefined`/absent = le défaut TOUJOURS actif de matchmaking.ts (verrou
   *  conservateur, contrairement à movesPerIdentity qui est opt-in) ; `null` explicite désactive. */
  codePerIp?: [number, number] | null
}

export interface MjsServerOptions extends MjsWsOptions {
  /** persistance optionnelle (persist.ts) — absent = AUCUN hook armé, zéro coût. Adaptateur NU ou
   *  `{ adaptateur, debounce?, snapshotEvery? }`, cf. persist.ts pour le contrat complet. */
  persist?: MjsServerPersistOption
  /** anti-triche — cf. MjsServerAntiTricheOptions. Nom DÉLIBÉRÉMENT distinct de `limits`
   *  (héritée de MjsWsOptions — transport : rate/burst/maxPayload/maxConnections… — jamais
   *  réutilisée ici : MJS-WS reste intouché, cf. tête de fichier, et une interface ne peut de toute
   *  façon pas redéfinir `limits` avec une forme incompatible de celle héritée). */
  antiCheat?: MjsServerAntiCheatOptions
}

function defaultLog(level: MjsWsLogLevel, message: string, meta?: unknown): void {
  const line = `[MJS-Server] ${message}`
  if (level === 'error') console.error(line, meta ?? '')
  else if (level === 'warn') console.warn(line, meta ?? '')
  else console.log(line, meta ?? '')
}

/** Construit une app MJS-Server — MÊMES options que `mjsWs(opts)` (réutilise `mjsWs()` public tel
 *  quel), augmentée de `.game()` + `opts.persist` (persist.ts). `opts.serve`/`opts.on` d'un type
 *  'µgame:*' par l'appli hôte lèvent — cette plomberie reste invisible, réservée aux 4 handlers
 *  internes de matchmaking.ts. */
export function mjsServer(opts: MjsServerOptions = {}): MjsServerApp {
  const gameDefs = new Map<string, MjsServerResolvedDef>()
  // affecté APRÈS l'app (matchmaking a besoin de `app.send`), capturé par closure — MÊME patron
  // que bridgeEngine/clusterEngine dans mjs-ws/core.ts (cf. son commentaire de tête, createCore)
  let matchmaking: MjsServerMatchmaking | null = null
  // persistance — `null` si opts.persist absent, AUCUN hook armé dans ce cas (cf.
  // persist.ts createPersistEngine, qui court-circuite tout avant la moindre Map/timer)
  const persistEngine = createPersistEngine(resolvePersistOption(opts.persist), opts.onLog ?? defaultLog)
  // anti-triche (détection par coup) — compteurs APP-ENTIÈRE, TOUJOURS créés (coût
  // négligible, MÊME politique « toujours actif » que mjs-ws/stats.ts) : rattachés à CHAQUE partie
  // par matchmaking.ts (armés comme `_onMutate`/persist.ts::armGame), greffés sur app.stats()
  // plus bas (cf. MjsServerStatsSnapshot) — restent à {0,0} tant qu'aucun jeu déclaré n'utilise
  // def.suspect/antiRejeu/limits.moveIntervalMs (cf. game.ts::_reportSuspicion).
  const gameStats: MjsServerGameStats = { suspectMoves: 0, rejectedMoves: 0 }
  // anti-triche — cf. MjsServerAntiTricheOptions.movesPerIdentity ; validé ICI (throw
  // immédiat, MÊME philosophie « pas de valeur par défaut silencieuse sur une clé mal typée » que
  // resolveGameDef, cf. game.ts) — matchmaking.ts fait confiance à cette forme déjà normalisée,
  // jamais de revalidation côté registre lui-même. `undefined`/`null` (option absente OU désactivée
  // explicitement) → `null`, AUCUN contrôle (opt-in, cf. commentaire de l'option elle-même).
  const movesPerIdentity = opts.antiCheat?.movesPerIdentity ?? null
  if (movesPerIdentity !== null) {
    if (!Array.isArray(movesPerIdentity) || movesPerIdentity.length !== 2) {
      throw new Error(t('serveur.index-movesperidentity-invalide', { received: JSON.stringify(movesPerIdentity) }))
    }
    const [n, window] = movesPerIdentity
    if (!Number.isInteger(n) || n < 1 || typeof window !== 'number' || window <= 0) {
      throw new Error(t('serveur.index-movesperidentity-invalide', { received: JSON.stringify(movesPerIdentity) }))
    }
  }
  // cf. MjsServerAntiTricheOptions.codePerIp ; `undefined` (option absente)
  // reste `undefined` et LAISSE createMatchmaking appliquer son propre défaut (verrou toujours
  // actif) — seul un `null` EXPLICITE désactive, seul un tableau est validé (MÊME philosophie que
  // movesPerIdentity ci-dessus, résolution différente puisque le défaut n'est pas « aucun contrôle »)
  const codePerIp = opts.antiCheat?.codePerIp
  if (codePerIp !== undefined && codePerIp !== null) {
    if (!Array.isArray(codePerIp) || codePerIp.length !== 2) {
      throw new Error(t('serveur.index-codeperip-invalide', { received: JSON.stringify(codePerIp) }))
    }
    const [n, window] = codePerIp
    if (!Number.isInteger(n) || n < 1 || typeof window !== 'number' || window <= 0) {
      throw new Error(t('serveur.index-codeperip-invalide', { received: JSON.stringify(codePerIp) }))
    }
  }

  // µschema × 'µgame:' — le préfixe réservé vaut AUSSI pour les schémas binaires.
  // Sans cette garde, déclarer un schéma sous un nom 'µgame:*' PASSE (aucun filtre ne l'exclut, cf.
  // mjs-ws/schema.ts::isControlType, qui ne connaît que 'µ:') et la trame part en BINAIRE — mais sa
  // charge utile est `view`/`delta`, un OBJET, seule forme que µschema v1 ne sait pas décrire
  // (scalaires, list(), bits() — cf. src/schema/core.ts::validerType). Un champ d'un type inattendu
  // s'encode en valeur ZÉRO sans lever : l'état du jeu partirait VIDE sur le fil, panne muette.
  // Refusé aux DEUX portes — `opts.schemas` ici (consommé par mjsWs avant tout greffage), app.schema
  // plus bas. Contre-preuve du danger réel : tests/mjs-server-core.test.ts, test 15.
  for (const nom of Object.keys(opts.schemas ?? {})) {
    if (nom.startsWith(RESERVED_PREFIX)) throw new Error(t('serveur.index-schema-prefixe-reserve', { type: nom, prefix: RESERVED_PREFIX }))
  }

  const app = mjsWs({
    ...opts,
    onDisconnect(client, reason) {
      matchmaking?.onClientDisconnect(client)
      opts.onDisconnect?.(client, reason)
    },
  }) as MjsServerApp

  // capturées AVANT la garde ci-dessous — la plomberie interne (matchmaking.ts) doit pouvoir
  // enregistrer 'µgame:*' elle-même ; seule l'app HÔTE est bloquée sur ce préfixe
  const baseServe  = app.serve
  const baseOn     = app.on
  const baseSchema = app.schema
  const baseStop   = app.stop
  const baseListen = app.listen
  // capturé AVANT le greffage `jeu` plus bas (cf. app.stats =) — MÊME patron que baseServe/baseOn
  // ci-dessus : `app.stats` ici est ENCORE la version MJS-WS nue (mjs-ws/stats.ts, aucun `jeu`).
  const baseStats  = app.stats

  matchmaking = createMatchmaking(app, gameDefs, baseServe, baseOn, persistEngine, gameStats, movesPerIdentity, codePerIp)

  app.serve = (type, handler) => {
    if (type.startsWith(RESERVED_PREFIX)) throw new Error(t('serveur.index-serve-prefixe-reserve', { type: type, prefix: RESERVED_PREFIX }))
    baseServe(type, handler)
  }
  app.on = (type, handler) => {
    if (type.startsWith(RESERVED_PREFIX)) throw new Error(t('serveur.index-on-prefixe-reserve', { type: type, prefix: RESERVED_PREFIX }))
    baseOn(type, handler)
  }
  // cf. la garde `opts.schemas` plus haut — MÊME motif, seconde porte
  app.schema = (nom, champs) => {
    if (nom.startsWith(RESERVED_PREFIX)) throw new Error(t('serveur.index-schema-prefixe-reserve', { type: nom, prefix: RESERVED_PREFIX }))
    baseSchema(nom, champs)
  }
  // anti-triche — greffe ADDITIVE de `jeu` sur l'instantané MJS-WS (cf. MjsServerStatsSnapshot
  // en tête de fichier) : COPIE défensive (jamais `gameStats` lui-même, MÊME politique que
  // mjs-ws/stats.ts::snapshot() pour ses propres familles de compteurs) — bridge.ts (GET /stats,
  // /metrics, /state) lit `ctx.app.stats()` en LIVE à chaque requête, donc voit `jeu` automatiquement.
  app.stats = (): MjsServerStatsSnapshot => ({ ...baseStats(), game: { ...gameStats } })
  app.listen = async () => {
    // restauration (persist.ts) AVANT que le serveur n'accepte la moindre connexion — un client
    // ne doit jamais pouvoir arriver sur une partie persistée pas encore revenue à la vie
    if (persistEngine) await persistEngine.loadAtBoot(data => matchmaking!.restoreGameFromSnapshot(data))
    await baseListen()
  }
  app.stop = async () => {
    // rafale finale de persistance AVANT destroyAll() — capture les minuteries encore vivantes
    // (à - maintenant) ; destroyAll() les VIDE (cf. game.ts _destroy), un ordre inversé
    // sauverait des parties SANS leurs minuteries en cours (perdues au prochain redémarrage)
    if (persistEngine) await persistEngine.stop()
    // coupe tous les setTimeout des parties vivantes (tour/appariement/vide/minuteries d'auteur)
    // AVANT le stop MJS-WS — aucun timer ne doit survivre à l'arrêt du serveur (cf. matchmaking.ts)
    matchmaking!.destroyAll()
    await baseStop()
  }

  app.game = (type, def) => {
    if (gameDefs.has(type)) throw new Error(t('serveur.index-game-deja-declare', { type: type }))
    // opts.onLog ?? defaultLog — MÊME patron que persistEngine plus haut (cf. son commentaire) :
    // resolveGameDef reste une fonction PURE par défaut (log no-op si appelée directement, cf. les
    // ~15 call-sites de tests) ; seule CETTE app réelle branche le vrai logger (anti-triche,
    // avertissement def.view absente).
    gameDefs.set(type, resolveGameDef(type, def, opts.onLog ?? defaultLog))
  }

  return app
}
