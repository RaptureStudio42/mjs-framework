// Régression : les text nodes 100 % blancs entre deux balises
// étaient avalés par le strip du whitespace même sous un ancêtre <pre> (white-space:
// pre, blanc significatif) — spans de code coloré collés dans le rendu final.
// Fix : ancêtre pre/textarea exempté du strip (stackKeepsWhitespace).

import assert from 'node:assert/strict'
import { extractPaths, generateCreateFnBody } from '../src/generator/paths.js'
import { transpile } from '../src/transpiler/index.js'

describe('paths.ts — blancs préservés sous <pre>/<textarea>', () => {

  describe('extractPaths', () => {
    it('sous <pre> direct : newline+indent ET ligne vide conservés tels quels', () => {
      const html = "<pre class='code'><span class='ln'>a</span>\n<span class='kw'>b</span>\n\n<span class='tag'>c</span>\n</pre>"
      const result = extractPaths(html, { stripWhitespace: true })
      assert.equal(result.cleanHtml, html)
    })

    it("sous <pre> avec un BLOCK_CONTAINER descendant (c'est l'ancêtre qui compte, pas le parent direct)", () => {
      const html = '<pre><div>\n  <span>a</span>\n</div></pre>'
      const result = extractPaths(html, { stripWhitespace: true })
      assert.equal(result.cleanHtml, html)
    })

    it('hors <pre> : comportement inchangé, newline pretty-print toujours stripé', () => {
      const html = '<div>\n  <span>a</span>\n  <span>b</span>\n</div>'
      const result = extractPaths(html, { stripWhitespace: true })
      assert.equal(result.cleanHtml, '<div><span>a</span><span>b</span></div>')
    })

    it('hors <pre> : espace solitaire sans newline toujours préservé', () => {
      const html = '<div><span>a</span> <span>b</span></div>'
      const result = extractPaths(html, { stripWhitespace: true })
      assert.equal(result.cleanHtml, html)
    })
  })

  describe('generateCreateFnBody (mode imperative, forcé par une interpolation)', () => {
    it('sous <pre> : le chunk blanc est bien émis (createTextNode du newline+indent)', () => {
      const html = '<div>${x}<pre><span>a</span>\n  <span>b</span></pre></div>'
      const result = generateCreateFnBody(html)
      assert.ok(result.body.includes(JSON.stringify('\n  ')), `chunk blanc absent du body\nbody: ${result.body}`)
    })

    it('hors <pre> : miroir, le chunk blanc reste stripé (aucun createTextNode dédié)', () => {
      const html = '<div>${x}<span>a</span>\n  <span>b</span></div>'
      const result = generateCreateFnBody(html)
      assert.ok(!result.body.includes(JSON.stringify('\n  ')), `chunk blanc émis à tort\nbody: ${result.body}`)
    })
  })

  describe('bout en bout via transpile — spans de code coloré sous <pre> ne collent plus', function () {
    this.timeout(8000)

    it('newline simple ET ligne vide entre spans sous <pre> : préservés dans le template compilé', async () => {
      const src = [
        '<pre class="code"><span class="ln">&lt;script&gt;</span>',
        '<span class="kw">sock</span> = ...',
        '<span class="ln">&lt;/script&gt;</span>',
        '',
        '<span class="tag">&lt;button</span></pre>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'prews1' })
      const tplMatch = output.match(/_mjs_cloneTpl\("([^"]+)"\)/)
      assert.ok(tplMatch, 'template trouvé dans _mjs_cloneTpl')
      const tpl = tplMatch![1]
      assert.ok(
        tpl.includes("</span>\\n<span class='kw'>"),
        `newline entre </span> et <span class='kw'> non préservé\nTemplate: ${tpl}`
      )
      assert.ok(
        tpl.includes("</span>\\n\\n<span class='tag'>"),
        `ligne vide entre </span> et <span class='tag'> non préservée\nTemplate: ${tpl}`
      )
    })

    it('cas miroir hors <pre> : 2 spans dans un div séparés par newline+indent restent collés', async () => {
      const src = [
        '<div>',
        '<span class="a">x</span>',
        '<span class="b">y</span>',
        '</div>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'prews2' })
      const tplMatch = output.match(/_mjs_cloneTpl\("([^"]+)"\)/)
      assert.ok(tplMatch, 'template trouvé dans _mjs_cloneTpl')
      assert.equal(tplMatch![1], "<div><span class='a'>x</span><span class='b'>y</span></div>")
    })
  })
})
