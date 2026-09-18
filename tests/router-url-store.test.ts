import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER = join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts')

// Objet URL réactif dédié `µ.url` (namespace FRAMEWORK, pas le store applicatif
// `$$`) + sucre de navigation `µ.Router.to '/route'`. Le routeur reflète l'URL
// courante dans `µ.url` à chaque navigation ; l'API publique ne demande jamais
// le `#`.
describe('routeur — µ.url + µ.Router.to', function () {
  const router = readFileSync(ROUTER, 'utf-8')

  it('expose une méthode `to` qui préfixe le hash et délègue à navigate', function () {
    assert.match(router, /\bto:\s*function\s*\(\s*route/, 'méthode to définie')
    assert.match(router, /dest = '#' \+ route/, "to préfixe '#' devant une route '/…'")
    assert.match(router, /return this\.navigate\(dest/, 'to délègue à navigate')
  })

  it('_mjs_updateUrlStore écrit µ.url (dédié, PAS µ.store) avec les 5 champs', function () {
    assert.match(router, /_mjs_updateUrlStore:\s*function/, 'méthode _mjs_updateUrlStore définie')
    assert.match(router, /if \(!µ\.url\) \{ µ\.url = µ\.state\(\{\}\); \}/, 'µ.url est un µ.state dédié créé à la volée')
    for (const field of ['href', 'path', 'params', 'query', 'hash']) {
      assert.match(router, new RegExp(`µ\\.url\\.${field} = `), `écrit µ.url.${field}`)
    }
    assert.doesNotMatch(router, /µ\.store\.url =/, 'ne pollue PAS µ.store (le store applicatif $$)')
    assert.match(router, /typeof µ\.state !== 'function'/, 'garde SSR / µ.state absent')
  })

  it('navigate() et initComponent() rafraîchissent le store', function () {
    // `_mjs_updateUrlStore` relit
    // `loc.hash`/`href`/`search` : il DOIT venir APRÈS le (r)emplacement
    // d'historique. Appelé AVANT le pushState (comme jusqu'à ce fix), il
    // figeait l'ancienne URL sur un `to('/x?a=1')` programmatique. Ancrage
    // tolérant : pushState … updateUrlStore, dans cet ordre.
    assert.match(router, /window\.history\.pushState\(\{\}, '', _dest\);[\s\S]{0,1000}this\._mjs_updateUrlStore\(matchPath\)/, 'navigate met à jour le store APRÈS le (r)emplacement d\'historique')
    // Ancrage TOLÉRANT : `_mjs_scheduleNoMatchCheck` s'intercale désormais
    // entre les deux — seul l'ORDRE compte (store à jour AVANT l'injection).
    assert.match(router, /this\._mjs_updateUrlStore\(matchPath\);[\s\S]{0,600}return this\._mjs_injectViewsForComponent/, 'initComponent met à jour le store au mount')
  })

  it('snapshot initial au boot du runtime', function () {
    // Bug slash final au chargement direct : le boot canonicalise l'URL
    // AVANT le snapshot — sinon un hash sale au premier chargement (sans composant
    // routé pour le nettoyer) reste figé sale dans µ.url à vie.
    assert.match(router, /if \(typeof window !== 'undefined' && typeof µ\.state === 'function'\) \{\s*µ\.Router\._mjs_canonicalizeUrl\(\);\s*µ\.Router\._mjs_updateUrlStore\(\);/, 'init boot présent (canonicalise puis snapshot)')
  })
})
