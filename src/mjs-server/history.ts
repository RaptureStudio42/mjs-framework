// mjs-server/histo — tampon circulaire d'instantanés de positions (def.histo, cf. game.ts),
// pour la compensation de lag SERVEUR (« lag compensation », doc réseau Source) :
// à chaque tick, game.ts pousse un instantané LÉGER { tick, à, positions } dans un anneau de
// def.histo.ticks entrées (game.ts _broadcastTick, APRÈS def.simulate) ; game.rewind(instantMs,
// fn) retrouve l'entrée la plus proche d'un instant PASSÉ (typiquement « ce que le tireur voyait »,
// cf. game.timeSeenBy) et laisse le jeu y valider un tir SANS que la position courante (déjà
// avancée pendant l'aller réseau) ne fausse le résultat.
//
// ALLOCATION — chaque `pousser` ALLOUE un nouvel objet `{tick, à, positions}` par slot (pas de
// réutilisation/mutation en place d'un wrapper existant) : taille bornée (def.histo.ticks, dizaines
// typiquement) et fréquence bornée (def.tick, ≤ 60 Hz) rendent le coût GC négligeable face au travail
// déjà fait à chaque tick (simulate + diffusion) — réutiliser aurait exigé une politique de mutation
// en place plus fragile (un `extraire` maison pourrait garder une référence à son objet `positions`
// au-delà d'un tick) pour un gain non mesuré. SIMPLICITÉ retenue.
//
// BORNES DE rewind() — recherche par plus proche voisin sur `à` (timestamp) : les entrées sont
// TOUJOURS poussées dans l'ordre chronologique (monotone croissant), donc la plus proche voisine d'un
// instant plus ancien que la plus vieille entrée dispo EST cette plus vieille entrée (repli borne
// basse), et symétriquement pour un instant futur (repli borne haute, l'entrée COURANTE) — aucune
// branche séparée n'est nécessaire, le plus-proche-voisin implémente déjà le bornage.
//
// GEL LECTURE SEULE — rewind() construit une COPIE gelée (Object.freeze, l'objet racine ET
// chaque entrée {x,y}) de l'instantané retenu avant de la passer à `fn` : jamais l'objet original
// stocké dans l'anneau (qui reste mutable pour un futur `pousser`), jamais nu non plus (une mutation
// accidentelle du jeu dans son handler de tir throw immédiatement plutôt que de corrompre le tampon
// en silence).

import { t } from '../messages/index.js'

export interface MjsServerHistoryPositions {
  [id: string]: { x: number; y: number }
}

interface MjsServerHistoryEntry {
  tick: number
  at: number
  positions: MjsServerHistoryPositions
}

export interface MjsServerHistoryMeta {
  tick: number
  at: number
  /** ms — |instant demandé − à de l'entrée retenue| (0 = correspondance exacte dispo) */
  gap: number
}

export interface MjsServerHistory {
  /** pousse l'instantané du tick courant — écrase circulairement la plus ancienne entrée au-delà de `ticks` */
  pousser(tick: number, at: number, positions: MjsServerHistoryPositions): void
  /** rembobine à l'instant `instantMs` (ms epoch, borné — cf. commentaire de tête) et RETOURNE le résultat de `fn` */
  rewind<T>(instantMs: number, fn: (positions: MjsServerHistoryPositions, meta: MjsServerHistoryMeta) => T): T
  /** vide le tampon — appelée à la fin de partie (cf. game.ts _destroy) */
  _clear(): void
}

/** construit un tampon circulaire de `taille` entrées (> 0) — cf. commentaire de tête */
export function createHistory(size: number): MjsServerHistory {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(t('serveur.histo-ticks-invalide', { received: JSON.stringify(size) }))
  }
  const ring: (MjsServerHistoryEntry | null)[] = new Array(size).fill(null)
  let cursor = 0   // prochain index d'ÉCRITURE
  let filled = 0   // nombre d'entrées valides dispo (plafonne à `taille`)

  return {
    pousser(tick, at, positions) {
      ring[cursor] = { tick, at, positions }
      cursor = (cursor + 1) % size
      if (filled < size) filled++
    },

    rewind(instantMs, fn) {
      if (filled === 0) throw new Error(t('serveur.histo-tampon-vide'))
      let best: MjsServerHistoryEntry | null = null
      let bestGap = Infinity
      for (let i = 0; i < filled; i++) {
        const entry = ring[(cursor - 1 - i + size) % size]!   // parcourt les entrées valides, de la plus RÉCENTE vers la plus ancienne
        const gap = Math.abs(instantMs - entry.at)
        if (gap < bestGap) { bestGap = gap; best = entry }
      }
      const chosenEntry = best!
      const frozenPositions: MjsServerHistoryPositions = {}
      for (const id of Object.keys(chosenEntry.positions)) frozenPositions[id] = Object.freeze({ ...chosenEntry.positions[id] })
      Object.freeze(frozenPositions)
      return fn(frozenPositions, { tick: chosenEntry.tick, at: chosenEntry.at, gap: bestGap })
    },

    _clear() { ring.fill(null); cursor = 0; filled = 0 },
  }
}
