// MATCH EXACT DES ROUTES.
//
// Le routeur matchait par PRÉFIXE : une route `/a` matchait aussi `/a/b`, `/a/b/c`…
// L'intention était le routage imbriqué (une route large injecte un layout, qui
// déclare à son tour son propre `@routes` pour la suite du chemin), mais le prix
// était une ABSORPTION SILENCIEUSE : `/admin/nimportequoi` affichait la page
// `/admin` sans qu'aucune erreur ne signale le segment en trop, et sans moyen de
// le lire. Deux conséquences mesurées :
//   - une faute de frappe dans une URL rendait une page PLAUSIBLE au lieu d'une 404 ;
//   - dans une table `{'/a': X, '/a/*': Y}`, `/a` (préfixe, 0 wildcard) gagnait le
//     tri de spécificité pour `/a/b` → `&all` n'était JAMAIS posé, le catch-all
//     déclaré juste à côté restait mort.
//
// Nouvelle règle : une route matche si et seulement si TOUS ses segments ET tous
// ceux de l'URL sont consommés. Un sous-arbre se déclare EXPLICITEMENT avec `*`
// (`'/admin/*'`) — même contrat que React Router v6 (`path="admin/*"` obligatoire
// pour des routes descendantes déclarées ailleurs) et que Vue Router (dont le
// parent ne matche que via ses `children`).
//
// Le corollaire est dans mjs_router.ts `_mjs_checkNoMatch` : une URL que plus aucune
// route ne matche n'est plus un écran blanc silencieux (cf. router-no-match.test.ts).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER = join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts')
const routerSrc = readFileSync(ROUTER, 'utf-8')

describe('routeur — match EXACT des routes', function () {
  describe('_mjs_matchRoute — unitaire', function () {
    const µ: any = { log() {}, warn() {}, error() {} }
    new Function('µ', routerSrc)(µ)
    const match = (url: string, route: string): any => µ.Router._mjs_matchRoute(url, route)

    it('une route statique matche son adresse EXACTE, et elle seule', function () {
      assert.equal(match('/about', '/about').ok, true)
      assert.equal(match('/about/x', '/about').ok, false, "'/about' ne doit plus absorber '/about/x'")
      assert.equal(match('/about/x/y', '/about').ok, false)
    })

    it('route paramétrée `/posts/:id` : matche `/posts/42`, PAS `/posts/42/comments`', function () {
      const exact = match('/posts/42', '/posts/:id')
      assert.equal(exact.ok, true)
      assert.equal(exact.params.id, '42')
      assert.equal(match('/posts/42/comments', '/posts/:id').ok, false, 'segment en trop → pas de match')
    })

    it('route optionnelle `/posts/(:id)` : matche `/posts` et `/posts/42`, PAS `/posts/42/extra`', function () {
      assert.equal(match('/posts', '/posts/(:id)').ok, true)
      assert.equal(match('/posts/42', '/posts/(:id)').params.id, '42')
      assert.equal(match('/posts/42/extra', '/posts/(:id)').ok, false)
    })

    it('racine `/` : inchangée, ne matche QUE `/`', function () {
      assert.equal(match('/', '/').ok, true)
      assert.equal(match('/anything', '/').ok, false, 'la racine ne doit JAMAIS devenir un catch-all implicite')
    })

    it('un segment LITTÉRAL qui diverge rejette toujours (segments entiers, pas un startsWith brut)', function () {
      assert.equal(match('/contact', '/about').ok, false)
      assert.equal(match('/about-us', '/about').ok, false)
    })

    it('`*` reste LA façon de router un sous-arbre — et il capture tout le reste (&rest chaîne, &all tableau)', function () {
      assert.equal(match('/files/a/b/c', '/files/*').params.rest, 'a/b/c')
      assert.deepEqual(match('/files/a/b/c', '/files/*').params.all, ['a', 'b', 'c'])
      assert.equal(match('/files', '/files/*').ok, true, 'un catch-all matche aussi la racine du sous-arbre')
      assert.equal(match('/files', '/files/*').params.rest, '', 'sans reste, &rest est la chaîne vide')
      assert.deepEqual(match('/files', '/files/*').params.all, [], 'sans reste, &all est le tableau vide')
    })

    it('layout imbriqué : la forme explicite `/admin/*` couvre ce que `/admin` couvrait par préfixe', function () {
      for (const url of ['/admin', '/admin/users', '/admin/users/42']) {
        assert.equal(match(url, '/admin/*').ok, true, `${url} doit matcher /admin/*`)
      }
      assert.equal(match('/admin/users', '/admin').ok, false, 'la forme NUE, elle, ne couvre plus le sous-arbre')
    })

    it("le tri de spécificité redevient utile : dans {'/a', '/a/*'}, `/a/b` ne peut plus être capté que par `/a/*`", function () {
      const paths = µ.Router._mjs_sortedPaths({ '/a': 'X', '/a/*': 'Y' })
      // `/a` reste trié devant (0 wildcard), mais il ne matche plus `/a/b` :
      // la boucle de `_mjs_injectViewsForComponent` continue jusqu'à `/a/*`.
      const premierQuiMatche = paths.find((p: string) => µ.Router._mjs_matchRoute('/a/b', p).ok)
      assert.equal(premierQuiMatche, '/a/*', "avant, '/a' captait '/a/b' par préfixe et &rest restait vide")
      assert.equal(µ.Router._mjs_matchRoute('/a/b', '/a/*').params.rest, 'b', '&rest est enfin posé')
      assert.deepEqual(µ.Router._mjs_matchRoute('/a/b', '/a/*').params.all, ['b'], '&all aussi, en tableau')
      // Et l'URL `/a` nue, que les DEUX motifs matchent, revient bien au plus précis.
      const pourANu = paths.find((p: string) => µ.Router._mjs_matchRoute('/a', p).ok)
      assert.equal(pourANu, '/a')
    })
  })

  describe('_mjs_injectViewsForComponent — intégration', function () {
    const g: any = globalThis
    let win: any
    before(() => {
      win = new Window({ url: 'http://localhost/' })
      g.window ??= win
      g.document ??= win.document
    })

    const monter = (µ: any, routes: any) => {
      const viewNode: any = win.document.createElement('metamjs-view')
      viewNode.id = 'main'
      const shadow = { querySelector: (sel: string) => sel.includes('#main') ? viewNode : null }
      const comp: any = { tagName: 'MJS-APP', _shadow: shadow, routes: { main: routes } }
      return { viewNode, comp }
    }

    it("un layout déclaré `/dashboard/*` reste injecté quand l'URL descend d'un niveau", function () {
      const µ: any = { log() {}, warn() {}, error() {} }
      new Function('µ', routerSrc)(µ)
      const { viewNode, comp } = monter(µ, { '/dashboard/*': 'layout' })

      µ.Router._mjs_injectViewsForComponent(comp, '/dashboard')
      assert.equal(viewNode.firstElementChild?.tagName?.toLowerCase(), 'mjs-layout', 'layout injecté sur la racine du sous-arbre')

      µ.Router._mjs_injectViewsForComponent(comp, '/dashboard/settings')
      assert.equal(viewNode.firstElementChild?.tagName?.toLowerCase(), 'mjs-layout', 'le layout reste en place sur l\'enfant')
    })

    it("le même layout déclaré SANS `*` se vide dès que l'URL descend (c'est le changement)", function () {
      const µ: any = { log() {}, warn() {}, error() {} }
      new Function('µ', routerSrc)(µ)
      const { viewNode, comp } = monter(µ, { '/dashboard': 'layout' })

      µ.Router._mjs_injectViewsForComponent(comp, '/dashboard')
      assert.ok(viewNode.firstElementChild, 'toujours injecté sur son adresse exacte')

      µ.Router._mjs_injectViewsForComponent(comp, '/dashboard/settings')
      assert.equal(viewNode.innerHTML, '', "'/dashboard/settings' n'est plus absorbé — il faut écrire '/dashboard/*'")
    })

    it("une route SANS rapport avec l'URL courante vide bien la vue (inchangé)", function () {
      const µ: any = { log() {}, warn() {}, error() {} }
      new Function('µ', routerSrc)(µ)
      const { viewNode, comp } = monter(µ, { '/dashboard': 'layout' })
      µ.Router._mjs_injectViewsForComponent(comp, '/dashboard')
      assert.ok(viewNode.firstElementChild)

      µ.Router._mjs_injectViewsForComponent(comp, '/autre-section')
      assert.equal(viewNode.innerHTML, '')
    })
  })
})
