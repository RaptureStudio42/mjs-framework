// Canonicalisation du slash final : `#/about/` → `#/about` (redirection propre,
// façon `trailingSlash: 'never'`). On teste la LOGIQUE réelle `_mjs_canonHash` +
// `_mjs_canonicalizeUrl` (exécutées, avec un `window` mocké), puis le câblage
// boot/navigate/hashchange en assertion source.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts'), 'utf-8')
const UJS = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

describe('routeur — canonicalisation du slash final', () => {
  // Init `µ` + import du routeur DIFFÉRÉS dans un `before` (pas au top-level) :
  // mocha exécute tous les tops-levels au chargement PUIS les hooks. Poser un `µ`
  // partiel au top-level privait d'autres suites (spring → `µ.Ticker`) de leurs
  // clés. Dans un `before`, `µ` est déjà pleinement initialisé par sa suite
  // propriétaire ; on se contente d'y ajouter log/warn/error, sans rien écraser.
  let Router: any
  before(async () => {
    const g = globalThis as any
    g.µ = g.µ || {}
    g.µ.log = g.µ.log || function () {}
    g.µ.warn = g.µ.warn || function () {}
    g.µ.error = g.µ.error || function () {}
    await import('../src/runtime/mjs_router.js') // définit µ.Router
    Router = g.µ.Router
  })

  describe('_mjs_canonHash (logique pure)', () => {
    it('retire le slash final : #/about/ → #/about', () => {
      assert.equal(Router._mjs_canonHash('#/about/'), '#/about')
    })
    it('préserve la racine #/', () => {
      assert.equal(Router._mjs_canonHash('#/'), '#/')
    })
    it('conserve la query : #/liste/?tri=nom → #/liste?tri=nom', () => {
      assert.equal(Router._mjs_canonHash('#/liste/?tri=nom'), '#/liste?tri=nom')
    })
    it('idempotent sur une forme déjà propre', () => {
      assert.equal(Router._mjs_canonHash('#/about'), '#/about')
    })
    it('réduit les slashs multiples : #/a// → #/a', () => {
      assert.equal(Router._mjs_canonHash('#/a//'), '#/a')
    })
    it('laisse une ancre native #section intacte', () => {
      assert.equal(Router._mjs_canonHash('#section'), '#section')
    })
    it('segment paramétré : #/posts/42/ → #/posts/42', () => {
      assert.equal(Router._mjs_canonHash('#/posts/42/'), '#/posts/42')
    })
  })

  describe('_mjs_canonicalizeUrl (replaceState, sans entrée d’historique)', () => {
    function withWindow(win: any, fn: () => void) {
      const g = globalThis as any
      const had = 'window' in g
      const prev = g.window
      g.window = win
      try { fn() } finally { if (had) g.window = prev; else delete g.window }
    }

    it('réécrit l’URL courante vers la forme sans slash', () => {
      const calls: string[] = []
      withWindow({
        location: { hash: '#/about/', pathname: '/tuto', search: '' },
        history: { state: { k: 1 }, replaceState: (_s: any, _t: any, u: string) => calls.push(u) },
      }, () => Router._mjs_canonicalizeUrl())
      assert.deepEqual(calls, ['/tuto#/about'])
    })

    it('ne fait rien si déjà canonique (aucun replaceState → pas de boucle)', () => {
      const calls: string[] = []
      withWindow({
        location: { hash: '#/about', pathname: '/', search: '' },
        history: { state: null, replaceState: (_s: any, _t: any, u: string) => calls.push(u) },
      }, () => Router._mjs_canonicalizeUrl())
      assert.equal(calls.length, 0)
    })

    it('ignore une ancre native #section (ne touche pas au scroll)', () => {
      const calls: string[] = []
      withWindow({
        location: { hash: '#section', pathname: '/', search: '' },
        history: { state: null, replaceState: (_s: any, _t: any, u: string) => calls.push(u) },
      }, () => Router._mjs_canonicalizeUrl())
      assert.equal(calls.length, 0)
    })
  })

  describe('câblage (assertion source)', () => {
    it('navigate() canonicalise la destination avant pushState', () => {
      assert.match(ROUTER, /_mjs_canonHash\(destination\.slice\(_hi\)\)/)
      assert.match(ROUTER, /pushState\(\{\}, '', _dest\)/)
    })
    it('initComponent() nettoie l’URL de départ au boot', () => {
      assert.match(ROUTER, /initComponent:[\s\S]{0,240}this\._mjs_canonicalizeUrl\(\)/)
    })
    it('_mjs_canonicalizeUrl utilise replaceState (pas pushState)', () => {
      assert.match(ROUTER, /_mjs_canonicalizeUrl:\s*function[\s\S]{0,500}history\.replaceState/)
    })
    it('le listener hashchange canonicalise avant de router', () => {
      // Limite remontée à 1200 : le fix du garde-fou
      // hashchange (comparaison AUSSI de la query, pas seulement matchPath)
      // a ajouté un commentaire explicatif
      // entre les deux appels, sans changer leur ORDRE (ce que ce test vérifie).
      assert.match(UJS, /_mjs_canonicalizeUrl\(\)[\s\S]{0,1200}navigate\(window\.location\.href/)
    })
  })
})
