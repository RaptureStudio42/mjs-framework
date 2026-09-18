// µ._mjs_isPreloadableLink ignorait `mjs-method` : un lien `<a href="/posts/42"
// @method="delete" @preload="on">` était jugé préchargeable — au montage (eager) ou au survol
// (hover), µ._mjs_preloadLink déclenchait un VRAI fetch réseau GET, systématiquement PERDU (le clic
// réel passe par µ._mjs_navDispatch, qui ne consulte JAMAIS le cache de préchargement) — et,
// sur un serveur qui ne serait pas strictement REST, un vrai déclenchement de mutation au survol.
// `mjs-method="get"` explicite reste préchargeable (même verbe que le préchargement lui-même).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function installPreload(µ: any, window: any) {
  new Function('µ', extractMarked(UJS_SRC, '_mjs_normPreload'))(µ)
  new Function('µ', 'window', extractMarked(UJS_SRC, '_mjs_isPreloadableLink'))(µ, window)
  new Function('µ', extractMarked(UJS_SRC, '_mjs_effectivePreload'))(µ)
}

// Fixture réaliste : lien SUPPRESSION,
// préchargement forcé 'on' via l'attribut (priorité max, cas réaliste : un item de liste).
function makeLink(attrs: Record<string, string>) {
  const attributes: Record<string, string> = { ...attrs }
  return {
    tagName: 'A',
    origin: 'http://x', target: '', protocol: 'http:',
    pathname: '/posts/42', search: '', hash: '', href: 'http://x/posts/42',
    hasAttribute: (n: string) => Object.prototype.hasOwnProperty.call(attributes, n),
    getAttribute: (n: string) => (Object.prototype.hasOwnProperty.call(attributes, n) ? attributes[n] : null),
    getRootNode: () => null,
  }
}

function installFetchSpy(µ: any) {
  const fetchCalls: any[] = []
  µ._mjs_ajaxRequest = function () {} // juste pour passer le typeof check de _mjs_navRequest
  µ._mjs_navRequest = function (method: string, url: string) { fetchCalls.push({ method, url }) }
  µ._mjs_preloaded = new Set()
  µ._mjs_preloadCache = new Map()
  return fetchCalls
}

describe('mjs_ujs — µ._mjs_isPreloadableLink : un lien @method (autre que get) ne fetche jamais au survol/eager', function () {
  it('mjs-method="delete" : _mjs_isPreloadableLink rend false', function () {
    const µ: any = { _mjs_navNoUjs: () => false, preload: { view: 'off', page: 'off' } }
    const win = { location: { origin: 'http://x' } }
    installPreload(µ, win)
    const link = makeLink({ 'mjs-method': 'delete', 'data-mjs-preload': 'on' })
    assert.equal(µ._mjs_isPreloadableLink(link), false, "AVANT le fix : true — mjs-method jamais consulté")
  })

  it("mjs-method=\"delete\" : µ._mjs_preloadLink('eager') ne déclenche AUCUN fetch réseau", function () {
    const µ: any = { _mjs_navNoUjs: () => false, preload: { view: 'off', page: 'off' } }
    const win = { location: { origin: 'http://x', pathname: '/', search: '' } }
    installPreload(µ, win)
    new Function('µ', 'window', extractMarked(UJS_SRC, '_mjs_preloadLink'))(µ, win)
    const fetchCalls = installFetchSpy(µ)
    const link = makeLink({ 'mjs-method': 'delete', 'data-mjs-preload': 'on' })

    µ._mjs_preloadLink(link, 'eager')

    assert.deepEqual(fetchCalls, [], "AVANT le fix : un GET partait réellement sur l'URL de suppression")
  })

  it('mjs-method="POST" (casse haute, autre verbe) : toujours refusé', function () {
    const µ: any = { _mjs_navNoUjs: () => false, preload: { view: 'off', page: 'off' } }
    const win = { location: { origin: 'http://x' } }
    installPreload(µ, win)
    const link = makeLink({ 'mjs-method': 'POST', 'data-mjs-preload': 'on' })
    assert.equal(µ._mjs_isPreloadableLink(link), false)
  })

  it('mjs-method="get" explicite : reste préchargeable (même verbe que le préchargement)', function () {
    const µ: any = { _mjs_navNoUjs: () => false, preload: { view: 'off', page: 'off' } }
    const win = { location: { origin: 'http://x' } }
    installPreload(µ, win)
    const link = makeLink({ 'mjs-method': 'get', 'data-mjs-preload': 'on' })
    assert.equal(µ._mjs_isPreloadableLink(link), true)
  })

  it('sans mjs-method (lien ordinaire) : comportement inchangé, préchargeable', function () {
    const µ: any = { _mjs_navNoUjs: () => false, preload: { view: 'off', page: 'off' } }
    const win = { location: { origin: 'http://x' } }
    installPreload(µ, win)
    const link = makeLink({ 'data-mjs-preload': 'on' })
    assert.equal(µ._mjs_isPreloadableLink(link), true)
  })
})
