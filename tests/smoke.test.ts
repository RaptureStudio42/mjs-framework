// Smoke test — valide que la chaîne mocha + tsx fonctionne et que les modules
// src/ peuvent être chargés.

import assert from 'node:assert/strict'

describe('smoke', () => {
  it('lexer module loads', async () => {
    const lexer = await import('../src/lexer/index.js')
    assert.equal(typeof lexer.tokenize, 'function')
  })

  it('parser module loads', async () => {
    const parser = await import('../src/parser/index.js')
    assert.equal(typeof parser.parse, 'function')
  })

  it('analyzer module loads', async () => {
    const analyzer = await import('../src/analyzer/index.js')
    assert.equal(typeof analyzer.analyze, 'function')
  })

  it('generator module loads', async () => {
    const generator = await import('../src/generator/index.js')
    assert.equal(typeof generator.compile, 'function')
  })

  it('bundler module loads', async () => {
    const bundler = await import('../src/bundler/index.js')
    assert.equal(typeof bundler.Bundler, 'function')
  })

  it('bundler is constructible', async () => {
    const { Bundler } = await import('../src/bundler/index.js')
    const b = new Bundler({ manifestPath: '/tmp/manifest.js', outputDir: '/tmp/out' })
    assert.ok(b)
    assert.equal(typeof b.compile, 'function')
    assert.equal(typeof b.watch, 'function')
  })
})
