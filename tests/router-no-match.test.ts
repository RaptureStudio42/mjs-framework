// AUCUNE ROUTE POUR L'URL COURANTE — fallback d'erreur VISIBLE.
//
// Corollaire du passage au match exact (cf. router-exact-match.test.ts) : les URLs
// qui étaient absorbées en silence tombent maintenant « à côté ». Jusqu'ici, ce cas
// vidait toutes les <@view> et n'écrivait qu'une ligne `µ.log` (invisible sans
// `µ.debug`) — écran blanc, aucune explication.
//
// Règle retenue, VOLONTAIREMENT GLOBALE : l'erreur ne tire que si AUCUNE route
// d'AUCUN composant routé ne matche. Une page à plusieurs <@view> aux tables
// indépendantes a le droit de n'en remplir qu'une (barre latérale routée sur les
// seules pages qui la méritent) — le vidage d'UNE zone reste donc silencieux.
//
// Échappatoire : déclarer `'/*'` rend le cas structurellement inatteignable.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { assertAbsent } from './helpers/dom-assert.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER = join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts')
const routerSrc = readFileSync(ROUTER, 'utf-8')

describe('routeur — aucune route ne matche : erreur visible', function () {
  const g: any = globalThis
  let win: any
  before(() => {
    win = new Window({ url: 'http://localhost/' })
    g.window ??= win
    g.document ??= win.document
  })

  // Monte un µ neuf + un composant routé, et renvoie de quoi observer.
  const scene = (routes: any, config?: any) => {
    const errors: any[] = []
    const warns: any[] = []
    const µ: any = { log() {}, warn: (...a: any[]) => warns.push(a), error: (...a: any[]) => errors.push(a), config: config ?? {} }
    new Function('µ', routerSrc)(µ)
    const viewNode: any = win.document.createElement('metamjs-view')
    viewNode.id = 'main'
    const comp: any = {
      tagName: 'MJS-APP',
      _shadow: { querySelector: (sel: string) => sel.includes('#main') ? viewNode : null },
      querySelector: () => null,
      routes: { main: routes },
    }
    µ.Router._mjs_awareComponents.add(comp)
    return { µ, comp, viewNode, errors, warns }
  }

  it('URL sans preneur : µ.error + panneau injecté dans la première <@view>', function () {
    const { µ, comp, viewNode, errors } = scene({ '/': 'home', '/about': 'about' })
    µ.Router._mjs_injectViewsForComponent(comp, '/nimportequoi')
    µ.Router._mjs_checkNoMatch('/nimportequoi')

    assert.equal(errors.length, 1, 'une erreur console, exactement')
    assert.match(String(errors[0][0]), /\/nimportequoi/, "le message nomme l'URL fautive")
    assert.match(String(errors[0][0]), /\/about/, 'et liste les routes déclarées')
    assert.match(String(errors[0][0]), /'\/\*'/, 'et rappelle la route de repli')

    const box = viewNode.querySelector('[data-mjs-route-error]')
    assert.ok(box, 'un panneau est injecté dans la vue')
    assert.match(box.textContent, /introuvable/i, 'titre lisible par un utilisateur final')
    assert.match(box.textContent, /\/nimportequoi/, "l'adresse fautive est affichée")
    assert.ok(viewNode.querySelector('style'), 'le panneau apporte son style (il vit en shadow, la CSS de l\'app ne l\'atteint pas)')
    assert.doesNotMatch(box.textContent, /margin:/, 'la feuille est à CÔTÉ du message, pas dedans (copier-coller propre)')
  })

  it('le détail développeur (liste des routes) n\'apparaît dans le panneau que sous µ.debug', function () {
    const sansDebug = scene({ '/': 'home', '/about': 'about' })
    sansDebug.µ.Router._mjs_checkNoMatch('/x')
    assert.doesNotMatch(sansDebug.viewNode.textContent, /Routes déclarées|Declared routes/, 'rien de technique pour un visiteur')

    const avecDebug = scene({ '/': 'home', '/about': 'about' })
    avecDebug.µ.debug = true
    avecDebug.µ.Router._mjs_checkNoMatch('/x')
    assert.match(avecDebug.viewNode.textContent, /Routes déclarées/, 'le développeur, lui, voit les routes')
  })

  it('une route qui matche : aucune erreur, et un panneau précédent est retiré', function () {
    const { µ, viewNode, errors } = scene({ '/': 'home', '/about': 'about' })
    µ.Router._mjs_checkNoMatch('/x')
    assert.ok(viewNode.querySelector('[data-mjs-route-error]'), 'panneau posé')

    µ.Router._mjs_checkNoMatch('/about')
    assert.equal(errors.length, 1, 'aucune erreur de plus sur une URL valide')
    assertAbsent(viewNode.querySelector('[data-mjs-route-error]'), 'le panneau a été retiré')
  })

  it("une route de repli `'/*'` rend le cas inatteignable", function () {
    const { µ, errors, viewNode } = scene({ '/': 'home', '/*': 'not-found-page' })
    µ.Router._mjs_checkNoMatch('/nimportequoi')
    assert.equal(errors.length, 0, "le catch-all matche : c'est la page 404 de l'application qui s'affiche, pas la nôtre")
    assertAbsent(viewNode.querySelector('[data-mjs-route-error]'))
  })

  it('µ.config.routeNotFound : `warn` = console seule, `silent` = comportement d\'avant', function () {
    const w = scene({ '/': 'home' }, { routeNotFound: 'warn' })
    w.µ.Router._mjs_checkNoMatch('/x')
    assert.equal(w.errors.length, 0)
    assert.equal(w.warns.length, 1, 'un avertissement, pas une erreur')
    assertAbsent(w.viewNode.querySelector('[data-mjs-route-error]'), 'rien à l\'écran')

    const s = scene({ '/': 'home' }, { routeNotFound: 'silent' })
    s.µ.Router._mjs_checkNoMatch('/x')
    assert.equal(s.errors.length, 0)
    assert.equal(s.warns.length, 0)
    assertAbsent(s.viewNode.querySelector('[data-mjs-route-error]'))
  })

  it('table de routes VIDE : on ne crie pas (composant routé dont les @routes ne sont pas encore peuplées)', function () {
    const { µ, errors } = scene({})
    µ.Router._mjs_checkNoMatch('/x')
    assert.equal(errors.length, 0)
  })

  it('multi-zones : une seule zone remplie suffit à taire l\'erreur (le vidage par zone reste silencieux)', function () {
    const errors: any[] = []
    const µ: any = { log() {}, warn() {}, error: (...a: any[]) => errors.push(a), config: {} }
    new Function('µ', routerSrc)(µ)
    const principale: any = win.document.createElement('metamjs-view')
    principale.id = 'main'
    const laterale: any = win.document.createElement('metamjs-view')
    laterale.id = 'side'
    const comp: any = {
      tagName: 'MJS-APP',
      _shadow: { querySelector: (sel: string) => sel.includes('#main') ? principale : (sel.includes('#side') ? laterale : null) },
      querySelector: () => null,
      // la zone latérale n'existe QUE sur l'accueil — cas légitime
      routes: { main: { '/': 'home', '/about': 'about' }, side: { '/': 'home-side' } },
    }
    µ.Router._mjs_awareComponents.add(comp)

    µ.Router._mjs_injectViewsForComponent(comp, '/about')
    µ.Router._mjs_checkNoMatch('/about')
    assert.equal(errors.length, 0, "la latérale se vide sans bruit tant que la principale a trouvé sa page")
    assert.equal(laterale.innerHTML, '', 'la zone sans route est bien vidée, comme avant')
  })

  it('le contrôle est DIFFÉRÉ (les composants montent un par un au démarrage)', function () {
    assert.match(routerSrc, /_mjs_scheduleNoMatchCheck:\s*function/, 'ordonnancement différé présent')
    assert.match(routerSrc, /requestAnimationFrame\(run\)/, 'reporté d\'une frame')
    assert.match(routerSrc, /if \(this\._mjs_noMatchPending\) \{ return; \}/, 'un seul contrôle par salve')
    assert.match(routerSrc, /if \(µ\._isServer \|\| typeof document === 'undefined'\) \{ return; \}/, 'jamais côté serveur')
  })
})
