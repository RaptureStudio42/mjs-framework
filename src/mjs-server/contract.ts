// mjs-server/contract — contrat TYPÉ optionnel pour app.game/sock.game (confort DX),
// COMPOSÉ par-dessus mjs-ws/contract.ts (MÊME philosophie que le reste de MJS-Server — cf. tête de
// index.ts : « couche COMPOSÉE par-dessus l'API PUBLIQUE MJS-WS, jamais par réimplémentation »).
// ZÉRO runtime : que des types + des fonctions d'un retour direct (cast, cf. mjs-ws/contract.ts
// pour la RÉALITÉ complète — compilation séparée .server.mjs/.mjs, coût nul à l'exécution).

import type { Game, MjsServerSeat } from './game.js'
import type { MjsServerGameDef } from './game-def.js'
import type { MjsWsResultOf } from '../mjs-ws/contract.js'

// --- le contrat : forme que l'appli déclare pour UN jeu -----------------------------------------

/**
 * Contrat d'un jeu MJS-Server — l'appli en déclare UNE interface par type de jeu (cf.
 * docs/24-mjs-server.md « Contrat typé ») :
 *
 *   interface MorpionContrat extends MjsServerGameContract {
 *     view: { grille: Array<string | null> }
 *     moves: { jouer: (p: { i: number }) => boolean }
 *   }
 *
 * `view` = la vue par joueur telle que `def.view` la calcule (fusionnée À PLAT dans `partie.state`
 * côté client, cf. MjsServerReservedState). `moves` = les coups déclarés par `def.moves`, VUS DU
 * CLIENT : nom → (p) => résultat (un seul paramètre — `partie`/`joueur` restent des détails
 * SERVEUR, cf. TypedGameDef si tu veux aussi border `app.game()` lui-même).
 */
export interface MjsServerGameContract {
  view?: Record<string, any>
  moves?: Record<string, (p: any) => any>
}

type AnyMoves = Record<string, (p: any) => any>
type ViewOf<G extends MjsServerGameContract>  = G['view'] extends Record<string, any> ? G['view'] : Record<string, unknown>
type MovesOf<G extends MjsServerGameContract> = G['moves'] extends AnyMoves ? G['moves'] : AnyMoves

/** méta-clés RÉSERVÉES fusionnées dans `partie.state` À CÔTÉ de la vue (cf. mjs_game.ts, tête de
 *  fichier, et docs/24-mjs-server.md §7 « Le store réactif — À PLAT ») — un jeu dont la vue porterait
 *  un de ces noms se ferait ÉCRASER ; ce type ne fait qu'en documenter la forme pour TypedGame. */
export interface MjsServerReservedState {
  gameId: string | null
  seat: number | null
  phase: string | null
  turn: string | null
  seq: number | null
  code: string | null
  queue: number | null
  status: 'waiting' | 'playing' | 'finished' | 'left' | 'error'
  seats: Array<{ seat: number; connected: boolean } | null> | null
  result: unknown
  error: string | null
}

// --- TypedGame<G> — vue typée de la poignée renvoyée par sock.game(type, opts) ----------------
//
// RÉALITÉ (cf. mjs-ws/contract.ts « RÉALITÉ » pour le contexte complet) : `src/runtime/mjs_game.ts`
// est LUI AUSSI exclu du typecheck (tsconfig.json, `exclude: ["src/runtime/**/*.ts"]`) — la
// poignée `h` qu'il construit (state/move/on/leave) n'a jamais eu de type TS. `MjsGameLoose`
// ci-dessous en est une RECONSTRUCTION MANUELLE (cf. tête de mjs_game.ts pour le contrat exact).

export interface MjsGameLoose {
  readonly state: Record<string, unknown>
  move(name: string, p?: unknown): Promise<unknown>
  on(evt: string, fn: (p: any) => void): () => void
  leave(): void
}

/** vue typée de `partie` — MÊME objet, juste `state`/`move` bornés au contrat `G` (`on`/`leave`
 *  traversent INCHANGÉS, cf. MjsGameLoose — hors périmètre). */
export type TypedGame<G extends MjsServerGameContract> = Omit<MjsGameLoose, 'state' | 'move'> & {
  readonly state: ViewOf<G> & MjsServerReservedState
  move<K extends keyof MovesOf<G> & string>(name: K, p: Parameters<MovesOf<G>[K]>[0]): Promise<MjsWsResultOf<MovesOf<G>[K]>>
}

/** cast SEUL — MÊME contrat que asTypedApp/asTypedSocket (mjs-ws/contract.ts) : donne à la poignée
 *  renvoyée par `sock.game(type, opts)` (typée `any`, cf. RÉALITÉ) le typage `TypedGame<G>`. */
export function asTypedGame<G extends MjsServerGameContract>(game: MjsGameLoose, _contract?: G): TypedGame<G> {
  return game as unknown as TypedGame<G>
}

// --- TypedGameDef<G> — vue typée de `def` côté app.game(type, def) (bonus symétrique) -----------
//
// Non explicitement demandé au départ (seul `TypedGame` côté client était visé) — ajouté
// pour que le MÊME contrat borde aussi le bout SERVEUR (`app.game()`), symétrique de TypedApp côté
// MJS-WS (cf. le BUT « bout-en-bout » : « marche pour serve/request, send/on,
// game/move »). Facile à retirer si non désiré : n'affecte que ce fichier, jamais game.ts.
// `partie`/`joueur` restent les VRAIS types serveur (Game/MjsServerSeat, cf. game.ts) — seuls
// `p` et le résultat, les deux bouts qui traversent le réseau, sont bornés au contrat `G`.

export type TypedGameDef<G extends MjsServerGameContract> = Omit<MjsServerGameDef, 'view' | 'moves'> & {
  view?: (game: Game, player: MjsServerSeat | null) => ViewOf<G>
  moves: {
    [K in keyof MovesOf<G> & string]: (game: Game, player: MjsServerSeat, p: Parameters<MovesOf<G>[K]>[0]) =>
      MjsWsResultOf<MovesOf<G>[K]> | Promise<MjsWsResultOf<MovesOf<G>[K]>>
  }
}

/** cast SEUL — donne à `def` (avant `app.game(type, def)`) le typage `TypedGameDef<G>`. */
export function defineTypedGame<G extends MjsServerGameContract>(def: TypedGameDef<G>): MjsServerGameDef {
  return def as unknown as MjsServerGameDef
}
