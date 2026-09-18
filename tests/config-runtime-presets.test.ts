// Préréglages `runtime` (RUNTIME_PRESETS, bundler/config.ts) — « paquets activables » CLIENT
// au-dessus des modules optionnels (branding MJS-WS/MJS-Server : marque de
// produit en surface, les clés de config restent en minuscules-tirets — tirets impossibles en
// identifiant JS, cf. mjsWs/mjsServer dans src/mjs-ws|mjs-server/index.ts, les identifiants API
// correspondants). Vérifie :
//   - déballage + dédup de chaque préréglage (mjs-ws/mjs-server/chat/comptes/lobby) en modules optionnels connus ;
//   - mélange préréglage + module nu, dédup si recouvrement, ordre d'apparition préservé ;
//   - préréglage RÉSERVÉ (liste vide) : avertit, n'ajoute rien, ne fait JAMAIS échouer — AUCUN de la
//     table actuelle n'est plus dans ce cas (mécanisme couvert via un nom bidon, cf. plus bas) ;
//   - 'chat', 'accounts' et 'lobby' NE SONT PLUS réservés : ['socket','schema','smooth','chat'|'accounts'|'lobby'],
//     combinables entre eux et avec 'mjs-ws'/'mjs-server' (dédup du recouvrement) — combinaison
//     COMPLÈTE ['mjs-server','chat','accounts','lobby'] testée bout-en-bout ;
//   - préréglage inconnu OU module inconnu : même erreur stricte que l'existant (non-régression) ;
//   - 'all'/'core' : INCHANGÉS (non-tableaux, jamais passés à expandRuntimePresets) ;
//   - bout-en-bout : la valeur qui atteint RÉELLEMENT le Bundler (resolveBundlerOpts →
//     Bundler.resolveRuntimeFiles) reflète le déballage — pas seulement la validation.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts, expandRuntimePresets, RUNTIME_PRESETS } from '../src/bundler/config.js'

const tmp = (cfg: any) => {
  const root = mjsTmp('rtpreset')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(cfg))
  return root
}

// espionne console.warn le temps d'un appel (même motif que lint-max-state-vars.test.ts)
function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const orig = console.warn
  const warnings: string[] = []
  console.warn = (...a: unknown[]) => { warnings.push(String(a[0])) }
  try {
    const result = fn()
    return { result, warnings }
  } finally {
    console.warn = orig
  }
}

describe('bundler/config — table RUNTIME_PRESETS', () => {
  it("'mjs-ws' → ['socket', 'schema', 'smooth']", () => {
    assert.deepEqual(RUNTIME_PRESETS['mjs-ws'], ['socket', 'schema', 'smooth'])
  })

  it("'mjs-server' → les 9 modules attendus (socket/schema/smooth + tout le netcode)", () => {
    assert.deepEqual(RUNTIME_PRESETS['mjs-server'], [
      'socket', 'schema', 'smooth', 'game', 'interp', 'predict', 'det', 'lockstep', 'optimistic',
    ])
  })

  it("'chat' → ['socket', 'schema', 'smooth', 'chat'] (n'est plus réservé)", () => {
    assert.deepEqual(RUNTIME_PRESETS.chat, ['socket', 'schema', 'smooth', 'chat'])
  })

  it("'accounts' → ['socket', 'schema', 'smooth', 'accounts'] (n'est plus réservé)", () => {
    assert.deepEqual(RUNTIME_PRESETS.accounts, ['socket', 'schema', 'smooth', 'accounts'])
  })

  it("'lobby' → ['socket', 'schema', 'smooth', 'lobby'] (n'est plus réservé)", () => {
    assert.deepEqual(RUNTIME_PRESETS.lobby, ['socket', 'schema', 'smooth', 'lobby'])
  })

  it("préréglage RÉSERVÉ (liste vide) — mécanisme CONSERVÉ mais plus aucun exemple réel : sondé via une clé bidon injectée puis retirée, cf. describe suivant", () => {
    assert.equal(Object.values(RUNTIME_PRESETS).some(preset => preset.length === 0), false, 'aucun préréglage de la table actuelle ne devrait plus être vide')
  })
})

describe('expandRuntimePresets — déballage + dédup (pure, testable hors config)', () => {
  it("['mjs-server'] → exactement les 9 modules attendus, aucun avertissement", () => {
    const { modules, warnings } = expandRuntimePresets(['mjs-server'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth', 'game', 'interp', 'predict', 'det', 'lockstep', 'optimistic'])
    assert.equal(modules.length, 9)
    assert.deepEqual(warnings, [])
  })

  it("['mjs-ws', 'router'] → socket,schema,smooth,router (module nu après le préréglage)", () => {
    const { modules, warnings } = expandRuntimePresets(['mjs-ws', 'router'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth', 'router'])
    assert.deepEqual(warnings, [])
  })

  it("['mjs-ws', 'socket'] → dédup (socket déjà apporté par le préréglage, pas de doublon)", () => {
    const { modules } = expandRuntimePresets(['mjs-ws', 'socket'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth'])
  })

  it("['router', 'mjs-ws'] → ordre d'apparition préservé (module nu AVANT le préréglage)", () => {
    const { modules } = expandRuntimePresets(['router', 'mjs-ws'])
    assert.deepEqual(modules, ['router', 'socket', 'schema', 'smooth'])
  })

  it("['mjs-ws', 'mjs-server'] → deux préréglages, dédup du recouvrement (socket/schema/smooth communs)", () => {
    const { modules } = expandRuntimePresets(['mjs-ws', 'mjs-server'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth', 'game', 'interp', 'predict', 'det', 'lockstep', 'optimistic'])
  })

  it("['chat'] → socket,schema,smooth,chat, aucun avertissement (n'est plus réservé)", () => {
    const { modules, warnings } = expandRuntimePresets(['chat'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth', 'chat'])
    assert.deepEqual(warnings, [])
  })

  it("['mjs-ws', 'chat'] → dédup du recouvrement (socket/schema/smooth communs), 'chat' en plus", () => {
    const { modules, warnings } = expandRuntimePresets(['mjs-ws', 'chat'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth', 'chat'])
    assert.deepEqual(warnings, [])
  })

  it("['mjs-server', 'chat'] → les 9 modules de mjs-server + 'chat' en plus", () => {
    const { modules, warnings } = expandRuntimePresets(['mjs-server', 'chat'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth', 'game', 'interp', 'predict', 'det', 'lockstep', 'optimistic', 'chat'])
    assert.deepEqual(warnings, [])
  })

  it("['accounts'] → socket,schema,smooth,comptes, aucun avertissement (n'est plus réservé)", () => {
    const { modules, warnings } = expandRuntimePresets(['accounts'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth', 'accounts'])
    assert.deepEqual(warnings, [])
  })

  it("['mjs-ws', 'accounts'] → dédup du recouvrement (socket/schema/smooth communs), 'accounts' en plus", () => {
    const { modules, warnings } = expandRuntimePresets(['mjs-ws', 'accounts'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth', 'accounts'])
    assert.deepEqual(warnings, [])
  })

  it("['mjs-server', 'chat', 'accounts'] → les 9 modules de mjs-server + chat + comptes, dédup, aucun avertissement", () => {
    const { modules, warnings } = expandRuntimePresets(['mjs-server', 'chat', 'accounts'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth', 'game', 'interp', 'predict', 'det', 'lockstep', 'optimistic', 'chat', 'accounts'])
    assert.deepEqual(warnings, [])
  })

  it("['lobby'] → socket,schema,smooth,lobby, aucun avertissement (n'est plus réservé)", () => {
    const { modules, warnings } = expandRuntimePresets(['lobby'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth', 'lobby'])
    assert.deepEqual(warnings, [])
  })

  it("['mjs-ws', 'lobby'] → dédup du recouvrement (socket/schema/smooth communs), 'lobby' en plus", () => {
    const { modules, warnings } = expandRuntimePresets(['mjs-ws', 'lobby'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth', 'lobby'])
    assert.deepEqual(warnings, [])
  })

  it("['mjs-server', 'chat', 'accounts', 'lobby'] (combinaison COMPLÈTE) → tous les modules, dédup, aucun avertissement", () => {
    const { modules, warnings } = expandRuntimePresets(['mjs-server', 'chat', 'accounts', 'lobby'])
    assert.deepEqual(modules, ['socket', 'schema', 'smooth', 'game', 'interp', 'predict', 'det', 'lockstep', 'optimistic', 'chat', 'accounts', 'lobby'])
    assert.deepEqual(warnings, [])
  })

  it("préréglage RÉSERVÉ (liste vide) — mécanisme CONSERVÉ, sondé via une clé bidon injectée puis retirée (aucun préréglage réel n'est plus vide, cf. describe précédent)", () => {
    ;(RUNTIME_PRESETS as any)._sonde_reserve_test = []
    try {
      const { modules, warnings } = expandRuntimePresets(['_sonde_reserve_test', 'router'])
      assert.deepEqual(modules, ['router'], "le préréglage vide n'ajoute AUCUN module")
      assert.equal(warnings.length, 1)
      assert.ok(warnings.some(w => w.includes("'_sonde_reserve_test'")))
    } finally {
      delete (RUNTIME_PRESETS as any)._sonde_reserve_test   // jamais de fuite vers les autres tests
    }
  })

  it("un nom qui n'est ni préréglage ni module connu passe TEL QUEL (la validation stricte s'en charge)", () => {
    const { modules, warnings } = expandRuntimePresets(['bogus'])
    assert.deepEqual(modules, ['bogus'])
    assert.deepEqual(warnings, [])
  })

  it('tableau vide → tableau vide, aucun avertissement', () => {
    assert.deepEqual(expandRuntimePresets([]), { modules: [], warnings: [] })
  })
})

describe('validateRuntimeConfig (via findConfig) — préréglages dans mjs.config.json', () => {
  it("runtime: ['mjs-server'] valide sans erreur (déballé en modules optionnels connus)", () => {
    assert.doesNotThrow(() => findConfig(tmp({ runtime: ['mjs-server'] })))
  })

  it("runtime: ['mjs-ws', 'router'] valide sans erreur", () => {
    assert.doesNotThrow(() => findConfig(tmp({ runtime: ['mjs-ws', 'router'] })))
  })

  it("runtime: ['chat'] valide, AUCUN avertissement (n'est plus réservé)", () => {
    const root = tmp({ runtime: ['chat'] })
    const { result, warnings } = captureWarnings(() => findConfig(root))
    assert.ok(result, 'devrait trouver le config (ne lève pas)')
    assert.deepEqual(warnings, [])
  })

  it("runtime: ['mjs-ws', 'chat'] et ['mjs-server', 'chat'] valides sans erreur", () => {
    assert.doesNotThrow(() => findConfig(tmp({ runtime: ['mjs-ws', 'chat'] })))
    assert.doesNotThrow(() => findConfig(tmp({ runtime: ['mjs-server', 'chat'] })))
  })

  it("runtime: ['accounts'] valide, AUCUN avertissement (n'est plus réservé)", () => {
    const root = tmp({ runtime: ['accounts'] })
    const { result, warnings } = captureWarnings(() => findConfig(root))
    assert.ok(result, 'devrait trouver le config (ne lève pas)')
    assert.deepEqual(warnings, [])
  })

  it("runtime: ['mjs-server', 'chat', 'accounts'] (combinaison complète) valide sans erreur", () => {
    assert.doesNotThrow(() => findConfig(tmp({ runtime: ['mjs-server', 'chat', 'accounts'] })))
  })

  it("runtime: ['lobby'] valide, AUCUN avertissement (n'est plus réservé)", () => {
    const root = tmp({ runtime: ['lobby'] })
    const { result, warnings } = captureWarnings(() => findConfig(root))
    assert.ok(result, 'devrait trouver le config (ne lève pas)')
    assert.deepEqual(warnings, [])
  })

  it("runtime: ['mjs-server', 'chat', 'accounts', 'lobby'] (combinaison COMPLÈTE, les 3 paquets) valide sans erreur", () => {
    assert.doesNotThrow(() => findConfig(tmp({ runtime: ['mjs-server', 'chat', 'accounts', 'lobby'] })))
  })

  it('runtime: [\'mjs-ws\'] ne déclenche AUCUN avertissement (pas un préréglage réservé)', () => {
    const { warnings } = captureWarnings(() => findConfig(tmp({ runtime: ['mjs-ws'] })))
    assert.deepEqual(warnings, [])
  })

  it("préréglage inconnu (typo 'mjs-servuer') → même erreur stricte qu'un module inconnu", () => {
    assert.throws(() => findConfig(tmp({ runtime: ['mjs-servuer'] })), /module inconnu 'mjs-servuer'/)
  })

  it('module inconnu (comportement existant préservé) → erreur stricte claire', () => {
    assert.throws(() => findConfig(tmp({ runtime: ['routr'] })), /module inconnu 'routr'/)
  })

  it("un préréglage + un module CŒUR dans le même tableau → toujours refusé (fait déjà partie du CŒUR)", () => {
    assert.throws(() => findConfig(tmp({ runtime: ['mjs-ws', 'element'] })), /fait déjà partie du CŒUR/)
  })

  it("'all' inchangé (chaîne, jamais passée à expandRuntimePresets)", () => {
    assert.equal(findConfig(tmp({ runtime: 'all' }))!.config.runtime, 'all')
  })

  it("'core' inchangé", () => {
    assert.equal(findConfig(tmp({ runtime: 'core' }))!.config.runtime, 'core')
  })
})

describe('resolveBundlerOpts — valeur RÉELLEMENT transmise au Bundler', () => {
  it("runtime: ['mjs-server'] → renvoie les 9 modules déballés (pas le nom du préréglage)", () => {
    const opts = resolveBundlerOpts({ runtime: ['mjs-server'] }, '/tmp')
    assert.deepEqual(opts.runtime, ['socket', 'schema', 'smooth', 'game', 'interp', 'predict', 'det', 'lockstep', 'optimistic'])
  })

  it("runtime: ['mjs-ws', 'router'] → renvoie socket,schema,smooth,router", () => {
    const opts = resolveBundlerOpts({ runtime: ['mjs-ws', 'router'] }, '/tmp')
    assert.deepEqual(opts.runtime, ['socket', 'schema', 'smooth', 'router'])
  })

  it("runtime: ['chat'] → renvoie socket,schema,smooth,chat (pas le nom du préréglage)", () => {
    const opts = resolveBundlerOpts({ runtime: ['chat'] }, '/tmp')
    assert.deepEqual(opts.runtime, ['socket', 'schema', 'smooth', 'chat'])
  })

  it("runtime: ['accounts'] → renvoie socket,schema,smooth,comptes (pas le nom du préréglage)", () => {
    const opts = resolveBundlerOpts({ runtime: ['accounts'] }, '/tmp')
    assert.deepEqual(opts.runtime, ['socket', 'schema', 'smooth', 'accounts'])
  })

  it("runtime: ['mjs-server', 'chat', 'accounts'] → les 9 modules + chat + comptes, dédup", () => {
    const opts = resolveBundlerOpts({ runtime: ['mjs-server', 'chat', 'accounts'] }, '/tmp')
    assert.deepEqual(opts.runtime, ['socket', 'schema', 'smooth', 'game', 'interp', 'predict', 'det', 'lockstep', 'optimistic', 'chat', 'accounts'])
  })

  it("runtime: ['lobby'] → renvoie socket,schema,smooth,lobby (pas le nom du préréglage)", () => {
    const opts = resolveBundlerOpts({ runtime: ['lobby'] }, '/tmp')
    assert.deepEqual(opts.runtime, ['socket', 'schema', 'smooth', 'lobby'])
  })

  it("runtime: ['mjs-server', 'chat', 'accounts', 'lobby'] → les 9 modules + chat + comptes + lobby, dédup", () => {
    const opts = resolveBundlerOpts({ runtime: ['mjs-server', 'chat', 'accounts', 'lobby'] }, '/tmp')
    assert.deepEqual(opts.runtime, ['socket', 'schema', 'smooth', 'game', 'interp', 'predict', 'det', 'lockstep', 'optimistic', 'chat', 'accounts', 'lobby'])
  })

  it("runtime: 'all' → INCHANGÉ (non-régression)", () => {
    assert.equal(resolveBundlerOpts({ runtime: 'all' }, '/tmp').runtime, 'all')
  })

  it("runtime: 'core' → INCHANGÉ (non-régression)", () => {
    assert.equal(resolveBundlerOpts({ runtime: 'core' }, '/tmp').runtime, 'core')
  })

  it('runtime absent → undefined (non-régression)', () => {
    assert.equal(resolveBundlerOpts({}, '/tmp').runtime, undefined)
  })

  it("runtime: ['router'] (aucun préréglage) → INCHANGÉ, même référence de contenu qu'avant", () => {
    assert.deepEqual(resolveBundlerOpts({ runtime: ['router'] }, '/tmp').runtime, ['router'])
  })
})

describe('bout-en-bout — le préréglage atteint réellement Bundler.resolveRuntimeFiles()', () => {
  it("runtime: ['mjs-server'] (via resolveBundlerOpts) sélectionne exactement les 9 fichiers mjs_*.ts attendus, zéro avertissement d'ergonomie", () => {
    const opts = resolveBundlerOpts({ runtime: ['mjs-server'] }, '/tmp')
    const b = new Bundler({ runtime: opts.runtime })
    const { files, warnings, coreOnly } = b.resolveRuntimeFiles()
    const expectedOptionalFiles = [
      'mjs_smooth.ts', 'mjs_socket.ts', 'mjs_schema.ts', 'mjs_optimistic.ts', 'mjs_game.ts', 'mjs_interp.ts', 'mjs_predict.ts', 'mjs_det.ts', 'mjs_lockstep.ts',
    ]
    for (const f of expectedOptionalFiles) assert.ok(files.includes(f), `${f} attendu dans la sélection réelle du bundle`)
    // rien d'autre en trop (routeur/ujs/flip/ajax/vault/easing/spring absents du préréglage)
    for (const extra of ['mjs_router.ts', 'mjs_ujs.ts', 'mjs_flip.ts', 'mjs_ajax.ts', 'mjs_store_globals.ts', 'mjs_easing.ts', 'mjs_spring.ts']) {
      assert.ok(!files.includes(extra), `${extra} ne devrait PAS être sélectionné par 'mjs-server'`)
    }
    assert.equal(coreOnly, false)
    assert.deepEqual(warnings, [], `préréglage conçu pour ne déclencher aucun avertissement d'ergonomie croisée : ${warnings.join('; ')}`)
  })

  it("runtime: ['mjs-ws'] sélectionne socket/schema/smooth réellement, zéro avertissement", () => {
    const opts = resolveBundlerOpts({ runtime: ['mjs-ws'] }, '/tmp')
    const b = new Bundler({ runtime: opts.runtime })
    const { files, warnings } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_socket.ts'))
    assert.ok(files.includes('mjs_schema.ts'))
    assert.ok(files.includes('mjs_smooth.ts'))
    assert.ok(!files.includes('mjs_game.ts'), "mjs-ws n'inclut pas le module de jeu")
    assert.deepEqual(warnings, [])
  })

  it("runtime: ['chat'] sélectionne réellement mjs_socket/schema/smooth/chat.ts, zéro avertissement", () => {
    const opts = resolveBundlerOpts({ runtime: ['chat'] }, '/tmp')
    const b = new Bundler({ runtime: opts.runtime })
    const { files, warnings, coreOnly } = b.resolveRuntimeFiles()
    for (const f of ['mjs_socket.ts', 'mjs_schema.ts', 'mjs_smooth.ts', 'mjs_chat.ts']) assert.ok(files.includes(f), `${f} attendu dans la sélection réelle du bundle`)
    assert.ok(!files.includes('mjs_game.ts'), "'chat' n'inclut pas le module de jeu")
    assert.equal(coreOnly, false)
    assert.deepEqual(warnings, [])
  })

  it("runtime: ['accounts'] sélectionne réellement mjs_socket/schema/smooth/comptes.ts, zéro avertissement", () => {
    const opts = resolveBundlerOpts({ runtime: ['accounts'] }, '/tmp')
    const b = new Bundler({ runtime: opts.runtime })
    const { files, warnings, coreOnly } = b.resolveRuntimeFiles()
    for (const f of ['mjs_socket.ts', 'mjs_schema.ts', 'mjs_smooth.ts', 'mjs_accounts.ts']) assert.ok(files.includes(f), `${f} attendu dans la sélection réelle du bundle`)
    assert.ok(!files.includes('mjs_game.ts'), "'accounts' n'inclut pas le module de jeu")
    assert.ok(!files.includes('mjs_chat.ts'), "'accounts' n'inclut pas le module de chat")
    assert.equal(coreOnly, false)
    assert.deepEqual(warnings, [])
  })

  it("runtime: ['mjs-server', 'chat', 'accounts'] (combinaison complète) sélectionne TOUS les fichiers attendus, zéro avertissement", () => {
    const opts = resolveBundlerOpts({ runtime: ['mjs-server', 'chat', 'accounts'] }, '/tmp')
    const b = new Bundler({ runtime: opts.runtime })
    const { files, warnings, coreOnly } = b.resolveRuntimeFiles()
    const attendus = [
      'mjs_socket.ts', 'mjs_schema.ts', 'mjs_smooth.ts', 'mjs_game.ts', 'mjs_interp.ts', 'mjs_predict.ts',
      'mjs_det.ts', 'mjs_lockstep.ts', 'mjs_optimistic.ts', 'mjs_chat.ts', 'mjs_accounts.ts',
    ]
    for (const f of attendus) assert.ok(files.includes(f), `${f} attendu dans la sélection réelle du bundle`)
    assert.equal(coreOnly, false)
    assert.deepEqual(warnings, [])
  })

  it("runtime: ['lobby'] sélectionne réellement mjs_socket/schema/smooth/lobby.ts, zéro avertissement", () => {
    const opts = resolveBundlerOpts({ runtime: ['lobby'] }, '/tmp')
    const b = new Bundler({ runtime: opts.runtime })
    const { files, warnings, coreOnly } = b.resolveRuntimeFiles()
    for (const f of ['mjs_socket.ts', 'mjs_schema.ts', 'mjs_smooth.ts', 'mjs_lobby.ts']) assert.ok(files.includes(f), `${f} attendu dans la sélection réelle du bundle`)
    assert.ok(!files.includes('mjs_game.ts'), "'lobby' n'inclut pas le module de jeu")
    assert.ok(!files.includes('mjs_chat.ts'), "'lobby' n'inclut pas le module de chat")
    assert.ok(!files.includes('mjs_accounts.ts'), "'lobby' n'inclut pas le module de comptes")
    assert.equal(coreOnly, false)
    assert.deepEqual(warnings, [])
  })

  it("runtime: ['mjs-server', 'chat', 'accounts', 'lobby'] (combinaison COMPLÈTE, les 3 paquets applicatifs) sélectionne TOUS les fichiers attendus, zéro avertissement", () => {
    const opts = resolveBundlerOpts({ runtime: ['mjs-server', 'chat', 'accounts', 'lobby'] }, '/tmp')
    const b = new Bundler({ runtime: opts.runtime })
    const { files, warnings, coreOnly } = b.resolveRuntimeFiles()
    const attendus = [
      'mjs_socket.ts', 'mjs_schema.ts', 'mjs_smooth.ts', 'mjs_game.ts', 'mjs_interp.ts', 'mjs_predict.ts',
      'mjs_det.ts', 'mjs_lockstep.ts', 'mjs_optimistic.ts', 'mjs_chat.ts', 'mjs_accounts.ts', 'mjs_lobby.ts',
    ]
    for (const f of attendus) assert.ok(files.includes(f), `${f} attendu dans la sélection réelle du bundle`)
    assert.equal(coreOnly, false)
    assert.deepEqual(warnings, [], `combinaison conçue pour ne déclencher aucun avertissement d'ergonomie croisée : ${warnings.join('; ')}`)
  })
})
