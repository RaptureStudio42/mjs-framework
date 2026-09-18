// Joker `*` — DEUX symboles (cf. CHANGELOG) :
//   &rest — la queue de l'URL rejointe par '/' (chaîne, exactement ce que rendait
//           `&all` avant ce correctif).
//   &all  — le TABLEAU des segments décodés (itérer, compter) — `&all.join('/')`
//           reconstruit `&rest`.
// Un seul point de vérité côté runtime (mjs_router.ts `_matchSegs`) : le tableau
// est calculé une fois, `rest` en découle par `.join('/')`.

import { strict as assert } from 'node:assert'
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER = join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts')
const routerSrc = readFileSync(ROUTER, 'utf-8')

describe('routeur — joker * : &rest (chaîne) et &all (tableau)', function () {
  describe('_mjs_matchRoute — unitaire', function () {
    const µ: any = { log() {}, warn() {}, error() {} }
    new Function('µ', routerSrc)(µ)
    const match = (url: string, route: string): any => µ.Router._mjs_matchRoute(url, route)

    it("/docs/api/v1 contre /docs/* : rest === 'api/v1', all === ['api','v1']", function () {
      const r = match('/docs/api/v1', '/docs/*')
      assert.equal(r.ok, true)
      assert.equal(r.params.rest, 'api/v1')
      assert.ok(Array.isArray(r.params.all), 'all doit être un tableau')
      assert.equal(r.params.all.join('|'), 'api|v1')
    })

    it("zéro segment — /docs contre /docs/* : rest === '', all === [] (longueur 0)", function () {
      const r = match('/docs', '/docs/*')
      assert.equal(r.ok, true)
      assert.equal(r.params.rest, '')
      assert.ok(Array.isArray(r.params.all))
      assert.equal(r.params.all.length, 0)
    })

    it('segments encodés — /docs/a%2Fb/c contre /docs/* : décodage PAR SEGMENT conservé (all.length === 2, pas 3)', function () {
      // Le `/` encodé DANS un segment
      // (`a%2Fb`) redevient un `/` littéral APRÈS décodage : `rest` (join) le fait
      // donc ressembler à 3 morceaux, alors que l'URL n'avait que 2 segments — c'est
      // `all.length` qui dit la vérité sur le nombre de segments réels.
      const r = match('/docs/a%2Fb/c', '/docs/*')
      assert.equal(r.ok, true)
      assert.equal(r.params.all.length, 2)
      assert.deepEqual(r.params.all, ['a/b', 'c'])
      assert.equal(r.params.rest, 'a/b/c')
    })

    it('segment vide au milieu — /docs//c contre /docs/* : le double slash est absorbé AVANT le matching (jamais de segment vide dans all)', function () {
      // `_mjs_matchRoute` découpe avec `.split('/').filter(Boolean)` (mjs_router.ts
      // ~223-224) : un segment vide ne survit jamais jusqu'à `_matchSegs`.
      const r = match('/docs//c', '/docs/*')
      assert.equal(r.ok, true)
      assert.deepEqual(r.params.all, ['c'])
      assert.equal(r.params.rest, 'c')
    })

    it('combinaison :id + * sur la même route — les trois clés cohabitent', function () {
      const r = match('/posts/42/comments/1', '/posts/:id/*')
      assert.equal(r.ok, true)
      assert.equal(r.params.id, '42')
      assert.equal(r.params.rest, 'comments/1')
      assert.deepEqual(r.params.all, ['comments', '1'])
    })
  })

  describe('réactivité — un composant qui lit &rest/&all suit la navigation', function () {
    after(async () => { await terminateSharedWorkerPool() })

    // Strip ESM pour eval sous happy-dom (pas de loader module) — copié tel quel
    // de router-url-struct-lock.test.ts (même contrainte, même harnais).
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    it('naviguer de /docs/a/b à /docs/x/y/z puis /docs met à jour &rest ET la liste rendue sur &all', async function () {
      this.timeout(30000)

      const root = mjsTmp('router-rest-all')
      const srcDir = join(root, 'src')
      const outDir = join(root, 'out')
      mkdirSync(srcDir, { recursive: true })

      // route auto-référencée (pas de `<@view>` déclarée ici → aucune injection,
      // aucun risque de montage récursif) : seul le fait d'être « router-aware »
      // (présence de `@routes`) compte pour peupler µ.url.params.
      // @routes exige le marqueur .page.mjs sur son hôte ; l'identité
      // du composant (tag mjs-route-rest-all, préfixe du fichier haché) survit au stripping.
      writeFileSync(join(srcDir, 'route-rest-all.page.mjs'), `
<script lang="coffee">
@routes =
  'main':
    '/docs/*': 'route-rest-all'
</script>
<p class="rest">{&rest}</p>
<ul class="all">
{for seg in &all}
<li class="seg">{seg}</li>
{end}
</ul>
`)

      const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, `${stats.errors.map(e => e.message).join('\n')}`)

      const window = new Window({ url: 'http://localhost/#/docs/a/b' })
      const document: any = window.document

      const files = readdirSync(outDir)
      const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
      const compFile = files.find((f: string) => /^route-rest-all-/.test(f))
      assert.ok(coreFile && compFile, 'core et route-rest-all doivent être compilés')

      const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
      const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))

      try {
        window.eval(`
          ${coreCode}
          globalThis.µ = µ;
          ${compCode}
        `)
      } catch (e: any) {
        throw new Error(`Eval bundle dans happy-dom : ${e.message}`)
      }

      const tag = 'mjs-route-rest-all'
      assert.ok(window.customElements.get(tag), `${tag} doit être enregistré`)

      document.body.innerHTML = `<${tag}></${tag}>`
      const el: any = document.body.firstElementChild
      await new Promise(r => setTimeout(r, 50))

      assert.equal(el._shadow?.querySelector('.rest')?.textContent, 'a/b', "départ à /docs/a/b : &rest affiche 'a/b'")
      assert.equal(el._shadow?.querySelectorAll('.seg').length, 2, 'départ : 2 <li> pour 2 segments')

      window.eval(`µ.Router.to('/docs/x/y/z');`)
      await new Promise(r => setTimeout(r, 50))
      assert.equal(el._shadow?.querySelector('.rest')?.textContent, 'x/y/z', 'après navigation vers une queue plus longue, &rest suit')
      assert.equal(el._shadow?.querySelectorAll('.seg').length, 3, 'et la liste sur &all suit aussi (3 segments)')

      window.eval(`µ.Router.to('/docs');`)
      await new Promise(r => setTimeout(r, 50))
      assert.equal(el._shadow?.querySelector('.rest')?.textContent, '', 'zéro segment : &rest redevient vide')
      assert.equal(el._shadow?.querySelectorAll('.seg').length, 0, 'et la liste se vide (0 <li>)')

      window.close?.()
    })
  })
})
