// normalizeUrlPrefix ne retirait que les slashs FINAUX ('/app//' → '/app') ; un slash INITIAL
// REDOUBLÉ ('//app') COMMENCE quand même par '/' — validateConfig (config.ts:1169) ne vérifie
// QUE ce test-là — et traverse la validation tel quel : chaque URL d'asset composée en
// '${urlPrefix}/${fichier}' devient '//app/fichier', une URL PROTOCOL-RELATIVE côté navigateur
// (pointe vers l'hôte 'app', pas vers un chemin du même site). Fix : les slashs répétés se
// réduisent à un seul PARTOUT dans le préfixe (initiaux ET internes), avant même le retrait du
// slash final.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { findConfig, normalizeUrlPrefix } from '../src/bundler/config.js'

describe('urlPrefix : slashs répétés réduits à un seul, y compris en tête', () => {
  it('normalizeUrlPrefix : slash initial REDOUBLÉ réduit ("//app" → "/app")', () => {
    assert.equal(normalizeUrlPrefix('//app'), '/app')
  })

  it('normalizeUrlPrefix : slash interne redoublé réduit ("/a//b" → "/a/b")', () => {
    assert.equal(normalizeUrlPrefix('/a//b'), '/a/b')
  })

  it('normalizeUrlPrefix : non-régression slash final et racine pure', () => {
    assert.equal(normalizeUrlPrefix('/app/'), '/app')
    assert.equal(normalizeUrlPrefix('/app//'), '/app')
    assert.equal(normalizeUrlPrefix('/app'), '/app')
    assert.equal(normalizeUrlPrefix('/'), '')
    assert.equal(normalizeUrlPrefix('///'), '')
    assert.equal(normalizeUrlPrefix(''), '')
  })

  it("findConfig() : urlPrefix '//app' (double slash initial) → normalisé en '/app', jamais protocol-relative", () => {
    const root = mjsTmp('prefix-doubleslash')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', urlPrefix: '//app' }))
    const found = findConfig(root)
    assert.equal(found?.config.urlPrefix, '/app')
  })

  it("findConfig() : urlPrefix '/a//b' (slash interne redoublé) → normalisé en '/a/b'", () => {
    const root = mjsTmp('prefix-doubleslash-interne')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', urlPrefix: '/a//b' }))
    const found = findConfig(root)
    assert.equal(found?.config.urlPrefix, '/a/b')
  })
})
