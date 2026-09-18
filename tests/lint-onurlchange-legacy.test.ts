// Garde-fou V1 `@onUrlChange = ` (élagage du pont router V1) —
// mjs_router.ts n'appelle plus QUE `_mjs_hooks.urlChange`, posé par la rune
// `µurlChange (path, params) -> …`. `@onUrlChange = ->` / `this.onUrlChange = `
// restent du Coffee/Civet banal (`@` = `this.`) qui COMPILE sans erreur, mais
// le hook n'est alors JAMAIS invoqué par le routeur — panne SILENCIEUSE.
// transpile() émet donc un AVERTISSEMENT console (jamais bloquant : le nom
// `onUrlChange` reste légal pour tout autre usage). Motif de test : monkey-
// patch console.warn, comme lint-max-state-vars.test.ts.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

// espionne console.warn le temps d'un transpile (motif lint-max-state-vars.test.ts)
async function warnsOnUrlChange(src: string): Promise<string | null> {
  const orig = console.warn
  let caught: string | null = null
  console.warn = (...a: unknown[]) => { const s = String(a[0]); if (s.includes('onUrlChange')) caught = s }
  try { await transpile(src, { moduleName: 'onurlchange-probe' }) } finally { console.warn = orig }
  return caught
}

describe('lint onUrlChange legacy — avertissement forme V1 retirée', function () {
  this.timeout(30000)

  it('`@onUrlChange = (path) -> …` (forme Coffee `@` = this.) déclenche le warning', async () => {
    const src = ['<script>', '@onUrlChange = (path) -> µlog(path)', '</script>', '<p>ok</p>'].join('\n')
    const msg = await warnsOnUrlChange(src)
    assert.ok(msg, 'un avertissement devait être émis')
    assert.match(msg as unknown as string, /forme V1 retirée/)
    assert.match(msg as unknown as string, /µurlChange \(path, params\) ->/)
    assert.match(msg as unknown as string, /onurlchange-probe/)
  })

  it('`this.onUrlChange = function(path) {…}` (lang js explicite) déclenche le warning', async () => {
    const src = ['<script lang="js">', 'this.onUrlChange = function(path) { console.log(path) }', '</script>', '<p>ok</p>'].join('\n')
    assert.ok(await warnsOnUrlChange(src), 'un avertissement devait être émis')
  })

  it('la rune canonique `µurlChange (path, params) -> …` reste silencieuse', async () => {
    const src = ['<script>', 'µurlChange (path, params) -> µlog(path)', '</script>', '<p>ok</p>'].join('\n')
    assert.equal(await warnsOnUrlChange(src), null)
  })

  it('un composant sans rapport (aucun onUrlChange) reste silencieux', async () => {
    const src = ['<script>', '$x = 1', '</script>', '<p>{$x}</p>'].join('\n')
    assert.equal(await warnsOnUrlChange(src), null)
  })

  it('une comparaison `this.onUrlChange === null` (pas une affectation) reste silencieuse', async () => {
    const src = ['<script>', 'x = (this.onUrlChange === null)', '</script>', '<p>ok</p>'].join('\n')
    assert.equal(await warnsOnUrlChange(src), null)
  })

  it('un identifiant sans rapport (`onUrlChangeHandler`) reste silencieux (frontière de mot)', async () => {
    const src = ['<script>', 'onUrlChangeHandler = 1', '</script>', '<p>{onUrlChangeHandler}</p>'].join('\n')
    assert.equal(await warnsOnUrlChange(src), null)
  })

  it('une mention en commentaire (# …) reste silencieuse (masquage chaînes/commentaires)', async () => {
    const src = ['<script>', '# migration : @onUrlChange = est retiré, utiliser µurlChange', 'x = 1', '</script>', '<p>{x}</p>'].join('\n')
    assert.equal(await warnsOnUrlChange(src), null)
  })

  it('une mention en chaîne littérale reste silencieuse (masquage chaînes/commentaires)', async () => {
    const src = ['<script>', "µlog('ancien : this.onUrlChange = , nouveau : µurlChange')", '</script>', '<p>ok</p>'].join('\n')
    assert.equal(await warnsOnUrlChange(src), null)
  })

  it('`@onUrlChange = ` dans <script module> reste silencieux (scan limité au <script> composant)', async () => {
    const src = ['<script module>', '@onUrlChange = 1', '</script>', '<p>ok</p>'].join('\n')
    await assert.doesNotReject(() => transpile(src, { moduleName: 'onurlchange-module-probe' }))
  })
})
