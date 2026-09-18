// Routeur — paramètres de route OPTIONNELS façon Rails : `(:id)`.
// Les parenthèses rendent le segment facultatif → une seule route couvre les deux
// cas (`/posts` ET `/posts/42`), au lieu de déclarer deux fois la même route. Un
// param optionnel absent vaut `undefined`.
//
// mjs_router.ts n'a pas d'ESM et ne fait qu'assigner `µ.Router` → on l'évalue avec
// un `µ` factice (le bloc top-level est gardé par `window`/`µ.state`, donc ignoré).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER = join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts')

describe('routeur — paramètres optionnels `(:id)`', function () {
  const µ: any = {}
  // eslint-disable-next-line no-new-func
  new Function('µ', readFileSync(ROUTER, 'utf-8'))(µ)
  const match = (url: string, route: string): any => µ.Router._mjs_matchRoute(url, route)

  it('`/posts/(:id)` matche `/posts` (id undefined) ET `/posts/42` (id=42)', function () {
    const sans = match('/posts', '/posts/(:id)')
    assert.equal(sans.ok, true, '/posts matche la route optionnelle')
    assert.ok('id' in sans.params, 'la clé id existe')
    assert.equal(sans.params.id, undefined, 'id = undefined quand le segment est absent')

    const avec = match('/posts/42', '/posts/(:id)')
    assert.equal(avec.ok, true, '/posts/42 matche')
    assert.equal(avec.params.id, '42', 'id capturé quand présent')
  })

  it('un segment EN TROP fait ÉCHOUER `/posts/(:id)` (match EXACT)', function () {
    // MATCH EXACT : une route sans `*` ne matche que
    // l'adresse qu'elle décrit, ni plus ni moins. `/posts/42/extra` n'est PAS
    // `/posts/(:id)` — l'absorber silencieusement masquait les fautes de frappe
    // et rendait `&all` inatteignable. Un layout dont un enfant route le reste
    // du chemin s'écrit explicitement `/posts/(:id)/*` (assertion suivante).
    assert.equal(match('/posts/42/extra', '/posts/(:id)').ok, false)

    const explicite = match('/posts/42/extra', '/posts/(:id)/*')
    assert.equal(explicite.ok, true, 'le catch-all explicite route bien le sous-arbre')
    assert.equal(explicite.params.id, '42', 'le param reste capturé')
    assert.equal(explicite.params.rest, 'extra', 'le reste du chemin est lisible dans &rest')
    assert.deepEqual(explicite.params.all, ['extra'], 'et en tableau dans &all')
  })

  it('un param REQUIS `:id` ne matche toujours PAS si absent (inchangé)', function () {
    assert.equal(match('/posts', '/posts/:id').ok, false, ':id requis absent → pas de match')
    assert.equal(match('/posts/42', '/posts/:id').params.id, '42')
  })

  it('routes statiques + catch-all `*` inchangés', function () {
    assert.equal(match('/about', '/about').ok, true)
    // MATCH EXACT — `/about/x` ne matche PAS `/about` : cf. le fichier
    // dédié router-exact-match.test.ts.
    assert.equal(match('/about/x', '/about').ok, false)
    assert.equal(match('/files/a/b', '/files/*').params.rest, 'a/b')
    assert.deepEqual(match('/files/a/b', '/files/*').params.all, ['a', 'b'])
    assert.equal(match('/', '/').ok, true)
  })

  it('spécificité : un littéral l\'emporte sur un optionnel (`/posts/new` > `/posts/(:id)`)', function () {
    assert.ok(
      µ.Router._mjs_staticSegs('/posts/new') > µ.Router._mjs_staticSegs('/posts/(:id)'),
      'le segment littéral compte comme statique, pas l\'optionnel',
    )
  })
})
