// detectRouterAware (élagage du pont V1 `@onUrlChange`) — un composant
// est enregistré dans µ.Router (`this._mjs_is_router_aware = true`) s'il pose la
// rune `µurlChange (path, params) -> …` (compilée en `this._mjs_hook('urlChange', fn)`)
// ET/OU déclare `@routes`. AVANT ce fix, seule la voie `@routes` marchait
// réellement : la détection scannait `this.urlChange`/`this.onUrlChange` en
// MemberExpression, un motif que la rune ne produit JAMAIS (elle compile en
// CallExpression `this._mjs_hook('urlChange', …)`) — un composant posant
// SEULEMENT la rune (sans @routes, ex. une vue imbriquée sous <@view>) n'était
// donc jamais enregistré, son hook jamais invoqué. La forme V1 morte
// (`@onUrlChange = ->` / `this.onUrlChange = …`, jamais lue par mjs_router.ts)
// est, elle, délibérément absente de la détection — cf. lint-onurlchange-legacy
// pour l'avertissement compile-time qui oriente un dev l'écrivant encore.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('detectRouterAware — this._mjs_is_router_aware', function () {
  this.timeout(30000)

  it('rune `µurlChange` SEULE (sans @routes) marque le composant router-aware', async () => {
    const src = ['<script>', 'µurlChange (path, params) -> µlog(path)', '</script>', '<p>ok</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'rt-aware-rune-only' })
    assert.match(output, /_mjs_is_router_aware = true/)
  })

  it('`@routes` SEUL (sans rune µurlChange) marque le composant router-aware', async () => {
    const src = ['<script>', '@routes =', "  '/': 'home-page'", '</script>', '<p>ok</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'rt-aware-routes-only' })
    assert.match(output, /_mjs_is_router_aware = true/)
  })

  it('la forme V1 morte `@onUrlChange = ->` (sans @routes) NE marque PAS router-aware', async () => {
    const src = ['<script>', '@onUrlChange = (path) -> µlog(path)', '</script>', '<p>ok</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'rt-aware-v1-dead' })
    assert.doesNotMatch(output, /_mjs_is_router_aware/)
  })

  it('un composant sans rune ni @routes reste NON router-aware', async () => {
    const src = ['<script>', '$x = 1', '</script>', '<p>{$x}</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'rt-aware-neither' })
    assert.doesNotMatch(output, /_mjs_is_router_aware/)
  })
})
