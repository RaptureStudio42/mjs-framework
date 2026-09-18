// Test de l'API publique programmatique.

import assert from 'node:assert/strict'
import * as api from '../src/index.js'

describe('public API surface', () => {
  it('expose les functions de transpilation', () => {
    assert.equal(typeof api.transpile, 'function')
    assert.equal(typeof api.transpileFile, 'function')
    assert.equal(typeof api.injectTemplate, 'function')
  })

  it('expose Bundler', () => {
    assert.equal(typeof api.Bundler, 'function')
    const b = new api.Bundler({ sourceDir: '/tmp/x', outputDir: '/tmp/y', manifestPath: '/tmp/z.js' })
    assert.equal(typeof b.compile, 'function')
    assert.equal(typeof b.watch, 'function')
  })

  it('expose les utilitaires de config', () => {
    assert.equal(typeof api.findConfig, 'function')
    assert.equal(typeof api.resolveBundlerOpts, 'function')
  })

  it('expose le minifier', () => {
    assert.equal(typeof api.minifyJs, 'function')
  })

  it('expose le serveur et HMR', () => {
    assert.equal(typeof api.StaticServer, 'function')
    assert.equal(typeof api.HMRServer, 'function')
    assert.equal(typeof api.hmrClientSnippet, 'function')
  })

  it('expose les building blocks (lexer/parser/analyzer/generator)', () => {
    assert.equal(typeof api.tokenize, 'function')
    assert.equal(typeof api.parse, 'function')
    assert.equal(typeof api.compileHtml, 'function')
    assert.equal(typeof api.Analyzer, 'function')
    assert.equal(typeof api.analyze, 'function')
    assert.equal(typeof api.transformReactiveWrites, 'function')
  })

  it('expose les language adapters', () => {
    assert.equal(typeof api.getAdapter, 'function')
    assert.equal(typeof api.resolveLang, 'function')
    assert.ok(api.adapters.civet)
    assert.ok(api.adapters.coffee)
    assert.ok(api.adapters.ts)
    assert.ok(api.adapters.js)
  })

  it('expose le compileur CSS', () => {
    assert.equal(typeof api.compileCss, 'function')
  })

  it('use case typique : transpile programmatique', async () => {
    const { output } = await api.transpile(
      `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`,
      { moduleName: 'test' }
    )
    assert.match(output, /class MjsTest/)
  })
})
