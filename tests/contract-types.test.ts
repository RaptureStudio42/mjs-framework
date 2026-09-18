// tests/contract-types.test.ts — preuve que le contrat TYPÉ (
// src/mjs-ws/contract.ts + src/mjs-server/contract.ts) FONCTIONNE (auto-complétion/inférence) ET
// REFUSE le mauvais usage. Le VRAI test est `npx tsc --noEmit` : chaque `@ts-expect-error`
// ci-dessous DOIT être une erreur RÉELLE (retirer l'un d'eux EN FAIT la preuve —
// contrôle fait puis annulé). mocha, lui, n'exécute que des identités triviales
// (asTypedApp(app) === app…) — le reste (fonctions `_typeChecks*`) n'est JAMAIS appelé à
// l'exécution : le corps d'une fonction jamais invoquée est quand même intégralement
// TYPE-CHECKÉ par tsc, donc zéro risque de crash tout en exerçant le contrat pour de vrai.

import assert from 'node:assert/strict'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { asTypedApp, asTypedSocket } from '../src/mjs-ws/contract.js'
import type { MjsWsContract, TypedApp, TypedSocket, MjsSocketLoose } from '../src/mjs-ws/contract.js'
import { asTypedGame, defineTypedGame } from '../src/mjs-server/contract.js'
import type { MjsServerGameContract, TypedGame, MjsGameLoose } from '../src/mjs-server/contract.js'

// --- contrat d'exemple MJS-WS — MÊME esprit que la recette doc (docs/23-mjs-ws.md « Contrat typé ») ---
interface MonContrat extends MjsWsContract {
  serves: {
    achat: (p: { prix: number }) => { solde: number }
  }
  sends: {
    chat: { texte: string; auteur: string }
  }
}

// --- contrat d'exemple MJS-Server — MÊME esprit que docs/24-mjs-server.md « Contrat typé » ---
interface MorpionContrat extends MjsServerGameContract {
  view: { grille: Array<string | null> }
  moves: {
    jouer: (p: { i: number }) => boolean
  }
}

describe('contract-types — contrat typé bout-en-bout', () => {
  it('asTypedApp/asTypedSocket/asTypedPartie sont des casts IDENTITÉ (zéro wrapping à l\'exécution)', async () => {
    const app = mjsWs({ transport: new MemoryTransport(), heartbeat: 0 })
    const typedApp = asTypedApp<MonContrat>(app)
    assert.strictEqual(typedApp, app)

    const sockStub = {} as unknown as MjsSocketLoose
    const typedSock = asTypedSocket<MonContrat>(sockStub)
    assert.strictEqual(typedSock, sockStub)

    const partieStub = {} as unknown as MjsGameLoose
    const typedPartie = asTypedGame<MorpionContrat>(partieStub)
    assert.strictEqual(typedPartie, partieStub)

    await app.stop()
  })

  it('defineTypedGame est un cast IDENTITÉ (zéro wrapping à l\'exécution)', () => {
    const def = {
      seats: 2,
      state: () => ({ grille: Array(9).fill(null) }),
      view:  (game: any) => ({ grille: game.state.grille }),
      moves: {
        jouer: (game: any, player: any, p: { i: number }) => { game.state.grille[p.i] = player.id; return true },
      },
    }
    const typedDef = defineTypedGame<MorpionContrat>(def)
    assert.strictEqual(typedDef, def)
  })
})

// ==================================================================================================
// EXERCICES DE TYPE — jamais appelées (cf. tête de fichier). Chaque ligne `@ts-expect-error`
// DOIT être une VRAIE erreur de compilation ; chaque ligne SANS DOIT compiler. `npx tsc --noEmit`
// est l'unique arbitre — c'est TOUT le test.
// ==================================================================================================

async function _typeChecksApp(typed: TypedApp<MonContrat>): Promise<void> {
  // usage correct — p inféré {prix:number}, retour attendu {solde:number}
  typed.serve('achat', (p, _client) => ({ solde: 100 - p.prix }))
  typed.on('chat', (p, _client) => { p.texte.toUpperCase() })
  typed.send(null as any, 'chat', { texte: 'salut', auteur: 'Zora' })
  typed.sendUser('7', 'chat', { texte: 'salut', auteur: 'Zora' })

  // @ts-expect-error — type de requête INCONNU du contrat
  typed.serve('inconnu', (_p, _client) => ({}))
  // @ts-expect-error — mauvais payload (clé 'pri' au lieu de 'prix')
  typed.serve('achat', (_p: { pri: number }, _client) => ({ solde: 100 }))
  // @ts-expect-error — mauvais type de retour ('sold' au lieu de 'solde')
  typed.serve('achat', (p, _client) => ({ sold: 100 - p.prix }))
  // @ts-expect-error — mauvais payload envoyé à send() (clé 'auteur' manquante)
  typed.send(null as any, 'chat', { texte: 'salut' })
  // @ts-expect-error — type de message INCONNU du contrat sur on()
  typed.on('inconnu', (_p, _client) => {})
}

async function _typeChecksSocket(typed: TypedSocket<MonContrat>): Promise<void> {
  // usage correct — retour de request() inféré {solde:number}, 'welcome' toujours utilisable
  const r = await typed.request('achat', { prix: 40 })
  r.solde.toFixed(2)
  typed.on('chat', (p) => { p.texte.toUpperCase() })
  typed.on('welcome', (p) => { p })
  typed.send('chat', { texte: 'salut', auteur: 'Zora' })

  // @ts-expect-error — type de requête INCONNU du contrat
  typed.request('inconnu', {})
  // @ts-expect-error — mauvais payload (clé 'pri' au lieu de 'prix')
  typed.request('achat', { pri: 40 })
  // @ts-expect-error — .resultat n'existe pas sur { solde: number }
  typed.request('achat', { prix: 40 }).then(rep => rep.result)
  // @ts-expect-error — mauvais payload envoyé à send()
  typed.send('chat', { texte: 'salut' })
}

async function _typeChecksPartie(typed: TypedGame<MorpionContrat>): Promise<void> {
  // usage correct — vue + méta réservées fusionnées, résultat de move() inféré boolean
  typed.state.grille[0]
  typed.state.status
  const ok = await typed.move('jouer', { i: 4 })
  ok === true

  // @ts-expect-error — coup INCONNU du contrat
  typed.move('trichoter', {})
  // @ts-expect-error — mauvais payload (clé 'j' au lieu de 'i')
  typed.move('jouer', { j: 4 })
  // @ts-expect-error — 'grill' n'existe pas sur la vue déclarée (typo pour 'grille')
  typed.state.grill
}
