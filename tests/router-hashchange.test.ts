import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS = join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts')
const ROUTER = join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts')

// Routage natif sur `hashchange` : un `location.hash = '#/…'` PROGRAMMATIQUE
// (ou une édition directe du fragment) doit router, alors que seuls les clics
// de liens et le back/forward le faisaient. Garde-fous indispensables :
//   - ne router que les hash de route (`#/…`), pas les ancres `#section` ;
//   - ne pas re-router quand back/forward a déjà navigué (popstate émet aussi
//     hashchange) → comparaison au `_mjs_lastNavPath` posé par navigate().
describe('routeur — routage natif sur hashchange', function () {
  const ujs = readFileSync(UJS, 'utf-8')
  const router = readFileSync(ROUTER, 'utf-8')

  it('mjs_ujs installe un listener hashchange qui route', function () {
    assert.match(ujs, /addEventListener\(\s*'hashchange'/, 'listener hashchange présent')
    assert.match(ujs, /ref\.navigate\(window\.location\.href,\s*false\)/, 'le listener appelle Router.navigate')
  })

  it('ne route que les hash de route (#/…), pas les ancres #section', function () {
    assert.match(ujs, /!hash\.startsWith\('#\/'\)/, "garde : ignore les hash qui ne commencent pas par '#/'")
  })

  it('saute le double back/forward via _mjs_lastNavPath', function () {
    assert.match(ujs, /matchPath === ref\._mjs_lastNavPath/, 'garde anti-double sur _mjs_lastNavPath')
  })

  it('navigate() mémorise le chemin dans _mjs_lastNavPath', function () {
    assert.match(router, /this\._mjs_lastNavPath\s*=\s*matchPath/, 'navigate pose _mjs_lastNavPath')
  })
})
