// Clé `logLevel` (mjs.config.json) — niveau de la console NAVIGATEUR (µ.log/µ.warn/µ.error,
// mjs_init.ts) ET sortie du BUILD (liste `pure` du minifieur, cf. bundler/minify.ts), réglés
// par la MÊME clé. Chaîne (même niveau dev/prod) ou objet `{ dev?, prod? }` (un niveau par
// environnement, sous-clé absente = défaut de cet environnement). Niveaux, du plus bavard au
// plus muet : 'log' > 'warn' > 'error' > 'silent'. Défauts : dev 'log', prod 'warn'.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findConfig, resolveBundlerOpts, resolveLogLevel, logLevelAllows } from '../src/bundler/config.js'
import { buildPureList, LOG_LEVEL_PURE_BASE } from '../src/bundler/minify.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

after(() => sweepRegistered())

function writeConfig(logLevel: unknown): string {
  const root = mjsTmp('log-level')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ logLevel }))
  return root
}

describe('logLevel — validation de mjs.config.json', () => {
  it('chaîne valide ("warn") passe et atteint resolveBundlerOpts telle quelle', () => {
    const root = writeConfig('warn')
    const found = findConfig(root)
    assert.ok(found)
    const opts = resolveBundlerOpts(found!.config, found!.configDir)
    assert.equal(opts.logLevel, 'warn')
  })

  it('objet valide { dev?, prod? } passe et atteint resolveBundlerOpts telle quelle', () => {
    const root = writeConfig({ dev: 'log', prod: 'error' })
    const found = findConfig(root)
    assert.ok(found)
    const opts = resolveBundlerOpts(found!.config, found!.configDir)
    assert.deepEqual(opts.logLevel, { dev: 'log', prod: 'error' })
  })

  it('objet à une seule sous-clé passe (l\'autre est facultative)', () => {
    const root = writeConfig({ prod: 'silent' })
    assert.doesNotThrow(() => findConfig(root))
  })

  it('niveau inconnu (chaîne) → erreur nommant les niveaux valides', () => {
    const root = writeConfig('zorglub')
    assert.throws(() => findConfig(root), /logLevel invalide : 'zorglub'/)
    assert.throws(() => findConfig(root), /Valeurs valides : log, warn, error, silent/)
  })

  it('niveau inconnu (sous-clé dev) → erreur dédiée nommant la sous-clé et les niveaux valides', () => {
    const root = writeConfig({ dev: 'trace' })
    assert.throws(() => findConfig(root), /logLevel\.dev invalide : 'trace'/)
  })

  it('sous-clé inconnue → erreur « clé inconnue »', () => {
    const root = writeConfig({ dev: 'log', staging: 'warn' })
    assert.throws(() => findConfig(root), /logLevel\.staging : clé inconnue/)
  })

  it('valeur de mauvais type (nombre) → erreur', () => {
    const root = writeConfig(42)
    assert.throws(() => findConfig(root), /'logLevel' doit être une chaîne ou un objet/)
  })

  it('valeur de mauvais type (tableau) → erreur (un tableau n\'est pas l\'objet { dev?, prod? } attendu)', () => {
    const root = writeConfig(['warn'])
    assert.throws(() => findConfig(root), /'logLevel' doit être une chaîne ou un objet/)
  })
})

describe('resolveLogLevel — défauts par environnement', () => {
  it('chaîne : même niveau dans les deux environnements', () => {
    assert.equal(resolveLogLevel('error', 'dev'), 'error')
    assert.equal(resolveLogLevel('error', 'prod'), 'error')
  })

  it('objet complet : chaque environnement lit sa propre sous-clé', () => {
    assert.equal(resolveLogLevel({ dev: 'log', prod: 'error' }, 'dev'), 'log')
    assert.equal(resolveLogLevel({ dev: 'log', prod: 'error' }, 'prod'), 'error')
  })

  it('sous-clé absente → défaut de CET environnement', () => {
    assert.equal(resolveLogLevel({ prod: 'error' }, 'dev'), 'log')
    assert.equal(resolveLogLevel({ dev: 'log' }, 'prod'), 'warn')
  })

  it('logLevel absent (undefined) → défauts des deux environnements', () => {
    assert.equal(resolveLogLevel(undefined, 'dev'), 'log')
    assert.equal(resolveLogLevel(undefined, 'prod'), 'warn')
  })
})

describe('logLevelAllows — rangs (log > warn > error > silent)', () => {
  it('un niveau autorise toujours son propre rang', () => {
    assert.equal(logLevelAllows('log', 'log'), true)
    assert.equal(logLevelAllows('warn', 'warn'), true)
    assert.equal(logLevelAllows('error', 'error'), true)
    assert.equal(logLevelAllows('silent', 'silent'), true)
  })

  it('un niveau plus bavard autorise un rang plus muet', () => {
    assert.equal(logLevelAllows('log', 'warn'), true)
    assert.equal(logLevelAllows('log', 'error'), true)
    assert.equal(logLevelAllows('warn', 'error'), true)
  })

  it('un niveau plus muet masque un rang plus bavard', () => {
    assert.equal(logLevelAllows('error', 'warn'), false)
    assert.equal(logLevelAllows('warn', 'log'), false)
    assert.equal(logLevelAllows('silent', 'error'), false)
  })
})

describe('buildPureList — liste `pure` du minifieur pour les 4 niveaux', () => {
  it("'log' : liste vide, rien n'est retiré", () => {
    assert.deepEqual(buildPureList('log'), [])
  })

  it("'warn' : liste actuelle inchangée (défaut de production)", () => {
    assert.deepEqual(buildPureList('warn'), LOG_LEVEL_PURE_BASE)
    assert.deepEqual(buildPureList('warn'), ['console.log', 'console.info', 'console.debug', 'µ.log'])
  })

  it("'error' : liste actuelle + console.warn/µ.warn", () => {
    assert.deepEqual(buildPureList('error'), ['console.log', 'console.info', 'console.debug', 'µ.log', 'console.warn', 'µ.warn'])
  })

  it("'silent' : liste 'error' + console.error/µ.error", () => {
    assert.deepEqual(buildPureList('silent'), ['console.log', 'console.info', 'console.debug', 'µ.log', 'console.warn', 'µ.warn', 'console.error', 'µ.error'])
  })

  it('buildPureList ne mute jamais LOG_LEVEL_PURE_BASE (garde-fou copie défensive)', () => {
    const before = [...LOG_LEVEL_PURE_BASE]
    buildPureList('silent')
    assert.deepEqual(LOG_LEVEL_PURE_BASE, before)
  })
})
