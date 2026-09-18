// PARITÉ entre les deux façons de déclarer une table de routes :
//   A. `@routes = …` dans le `<script>` (table calculée, forme historique)
//   B. le bloc racine `<routes target="…">` (table écrite à la main, forme récente)
// Le bloc compile en `this.routes = { '<target>': { '<chemin>': '<composant>' } }`, posé
// AVANT le code du `<script>` — même forme que ce que `@routes` produit lui-même. Chaque
// test compile les DEUX formes pour la MÊME table, puis prouve un comportement identique :
// soit la table `this.routes` produite (deepEqual), soit une exécution de routage réelle
// contre `µ.Router._mjs_matchRoute`/`_mjs_sortedPaths` (mêmes utilitaires que router-exact-match.test.ts).
//
// Ce fichier ne refait PAS tests/routes-block.test.ts (extraction, erreurs de forme du bloc) :
// il compare seulement les DEUX chemins de compilation entre eux.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { transpile } from '../src/transpiler/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER   = join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts')
const routerSrc = readFileSync(ROUTER, 'utf-8')

// µ factice, une seule fois — µ.Router._mjs_matchRoute/_mjs_sortedPaths sont des fonctions pures
const µ: any = {}
// eslint-disable-next-line no-new-func
new Function('µ', routerSrc)(µ)

// extrait la table posée par `this.routes = {…};` (premier `{…}` équilibré après l'assignation)
// et l'évalue — valable pour les DEUX formes, le bloc comme `@routes` produisent le même JS
function extractRoutesTable(output: string): any {
  const ri = output.indexOf('this.routes')
  assert.ok(ri >= 0, 'this.routes absent de la sortie')
  const open = output.indexOf('{', ri)
  assert.ok(open >= 0, 'accolade ouvrante absente')
  let depth = 0, end = open
  for (let k = open; k < output.length; k++) {
    if (output[k] === '{') depth++
    else if (output[k] === '}') { depth--; if (depth === 0) { end = k; break } }
  }
  const raw = output.slice(open, end + 1)
  // eslint-disable-next-line no-new-func
  return new Function(`return (${raw})`)()
}

// mutations `routes['cible']['/chemin'] = 'composant'` (forme mixte, complément au bloc)
function extractMutations(output: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = []
  const re = /routes\[(['"])([^'"]+)\1\]\[(['"])([^'"]+)\3\]\s*=\s*(['"])([^'"]+)\5/g
  for (const m of output.matchAll(re)) out.push([m[2], m[4], m[6]])
  return out
}

// noms de composants préchargés au compile-time (`µ.Autoloader?.load?.('mjs-<composant>')`)
function extractPreloads(output: string): string[] {
  return [...output.matchAll(/µ\.Autoloader\?\.load\?\.\('mjs-([a-z0-9-]+)'\)/g)].map(m => m[1])
}

// résout une URL contre une table de routes d'UNE cible, exactement comme le fait
// `_mjs_injectViewsForComponent` : premier motif matchant dans l'ordre de `_mjs_sortedPaths`
function resolve(routeMap: Record<string, string>, url: string): { component: string, params: any } | null {
  for (const path of µ.Router._mjs_sortedPaths(routeMap)) {
    const m = µ.Router._mjs_matchRoute(url, path)
    if (m.ok) return { component: routeMap[path], params: m.params }
  }
  return null
}

describe('parité <routes target="…"> vs @routes — mêmes tables, même comportement', function () {
  this.timeout(30000)

  // 1. route racine `/` et route simple `/a`
  it('route racine et route simple', async () => {
    const a = await transpile(['<script>', "@routes = { 'main': { '/': 'home-page', '/a': 'a-page' } }", '</script>', '<p/>'].join('\n'), { moduleName: 'parity-1-a' })
    const b = await transpile(['<routes target="main">', '  /   home-page', '  /a  a-page', '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-1-b' })
    const tblA = extractRoutesTable(a.output)
    const tblB = extractRoutesTable(b.output)
    assert.deepEqual(tblA, tblB)
    for (const url of ['/', '/a', '/x']) assert.deepEqual(resolve(tblA.main, url), resolve(tblB.main, url), url)
  })

  // 2. paramètre :id (injection &id, valeur chaîne)
  it('paramètre :id — même composant capturé, même valeur CHAÎNE', async () => {
    const a = await transpile(['<script>', "@routes = { 'main': { '/posts/:id': 'post-page' } }", '</script>', '<p/>'].join('\n'), { moduleName: 'parity-2-a' })
    const b = await transpile(['<routes target="main">', '  /posts/:id   post-page', '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-2-b' })
    const tblA = extractRoutesTable(a.output)
    const tblB = extractRoutesTable(b.output)
    assert.deepEqual(tblA, tblB)
    const rA = resolve(tblA.main, '/posts/42')!
    const rB = resolve(tblB.main, '/posts/42')!
    assert.deepEqual(rA, rB)
    assert.equal(typeof rA.params.id, 'string', 'id reste une CHAÎNE')
    assert.equal(rA.params.id, '42')
  })

  // 3. plusieurs paramètres dans une même route
  it('plusieurs paramètres', async () => {
    const path = '/posts/:id/comments/:cid'
    const a = await transpile(['<script>', `@routes = { 'main': { '${path}': 'comment-page' } }`, '</script>', '<p/>'].join('\n'), { moduleName: 'parity-3-a' })
    const b = await transpile(['<routes target="main">', `  ${path}   comment-page`, '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-3-b' })
    const tblA = extractRoutesTable(a.output)
    const tblB = extractRoutesTable(b.output)
    assert.deepEqual(tblA, tblB)
    const rA = resolve(tblA.main, '/posts/1/comments/2')!
    const rB = resolve(tblB.main, '/posts/1/comments/2')!
    assert.deepEqual(rA, rB)
    assert.deepEqual(rA.params, { id: '1', cid: '2' })
  })

  // 4. paramètre optionnel (:id), en fin de route — les DEUX formes l'acceptent
  it('paramètre optionnel (:id) en fin de route — présent et absent', async () => {
    const a = await transpile(['<script>', "@routes = { 'main': { '/posts/(:id)': 'posts-page' } }", '</script>', '<p/>'].join('\n'), { moduleName: 'parity-4-a' })
    const b = await transpile(['<routes target="main">', '  /posts/(:id)   posts-page', '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-4-b' })
    const tblA = extractRoutesTable(a.output)
    const tblB = extractRoutesTable(b.output)
    assert.deepEqual(tblA, tblB)
    for (const url of ['/posts', '/posts/42']) assert.deepEqual(resolve(tblA.main, url), resolve(tblB.main, url), url)
  })

  // Ancienne DIVERGENCE, CORRIGÉE — le bloc `<routes>` refusait l'optionnel
  // ailleurs qu'en dernier segment (« mal formé ») alors que le routeur le matche par retour
  // arrière (cf. tests/router-optional-mid-segment.test.ts) et que `@routes` l'acceptait déjà :
  // le validateur était plus strict que le moteur qu'il alimente, et migrer d'une forme à
  // l'autre cassait la compilation. `validateRoutePath` (src/transpiler/sections.ts) est aligné.
  it('optionnel (:x) en MILIEU de route — les deux formes compilent et routent pareil', async () => {
    const path = '/a/(:x)/b'
    const a = await transpile(['<script>', `@routes = { 'main': { '${path}': 'mid-page' } }`, '</script>', '<p/>'].join('\n'), { moduleName: 'parity-4-mid-a' })
    const b = await transpile(['<routes target="main">', `  ${path}   mid-page`, '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-4-mid-b' })
    const tblA = extractRoutesTable(a.output)
    const tblB = extractRoutesTable(b.output)
    assert.deepEqual(tblA, tblB)
    for (const url of ['/a/b', '/a/42/b', '/a/b/c']) assert.deepEqual(resolve(tblA.main, url), resolve(tblB.main, url), url)
    assert.deepEqual(resolve(tblA.main, '/a/42/b')!.params, { x: '42' })
  })

  // Même famille : le LITTÉRAL optionnel `(archive)` — facultatif, ne capture rien (préfixe
  // d'URL optionnel, cf. docs/17-router.md § « Segment optionnel façon Rails »). Le routeur le
  // gère, `@routes` l'acceptait, le bloc le refusait : aligné depuis.
  it('littéral optionnel (archive) — les deux formes compilent et routent pareil', async () => {
    const path = '/(archive)/posts'
    const a = await transpile(['<script>', `@routes = { 'main': { '${path}': 'posts-page' } }`, '</script>', '<p/>'].join('\n'), { moduleName: 'parity-4-lit-a' })
    const b = await transpile(['<routes target="main">', `  ${path}   posts-page`, '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-4-lit-b' })
    const tblA = extractRoutesTable(a.output)
    const tblB = extractRoutesTable(b.output)
    assert.deepEqual(tblA, tblB)
    for (const url of ['/posts', '/archive/posts', '/autre/posts']) assert.deepEqual(resolve(tblA.main, url), resolve(tblB.main, url), url)
  })

  // 5. joker `*` catch-all et son injection &rest/&all
  it('catch-all `*` en fin de route — &rest/&all identiques', async () => {
    const a = await transpile(['<script>', "@routes = { 'main': { '/files/*': 'files-page' } }", '</script>', '<p/>'].join('\n'), { moduleName: 'parity-5-a' })
    const b = await transpile(['<routes target="main">', '  /files/*   files-page', '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-5-b' })
    const tblA = extractRoutesTable(a.output)
    const tblB = extractRoutesTable(b.output)
    assert.deepEqual(tblA, tblB)
    for (const url of ['/files', '/files/a/b/c']) assert.deepEqual(resolve(tblA.main, url), resolve(tblB.main, url), url)
    assert.equal(resolve(tblA.main, '/files/a/b/c')!.params.rest, 'a/b/c')
    assert.deepEqual(resolve(tblA.main, '/files/a/b/c')!.params.all, ['a', 'b', 'c'])
  })

  // 6. match EXACT : `/a` ne matche pas `/a/b`, le sous-arbre s'écrit `/a/*`
  it('match EXACT — `/a` ne matche pas `/a/b`, `/a/*` couvre le sous-arbre', async () => {
    const a = await transpile(['<script>', "@routes = { 'main': { '/a': 'a-page', '/a/*': 'a-subtree' } }", '</script>', '<p/>'].join('\n'), { moduleName: 'parity-6-a' })
    const b = await transpile(['<routes target="main">', '  /a     a-page', '  /a/*   a-subtree', '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-6-b' })
    const tblA = extractRoutesTable(a.output)
    const tblB = extractRoutesTable(b.output)
    assert.deepEqual(tblA, tblB)
    for (const url of ['/a', '/a/b', '/a/b/c']) assert.deepEqual(resolve(tblA.main, url), resolve(tblB.main, url), url)
    assert.equal(resolve(tblA.main, '/a')!.component, 'a-page', 'le littéral exact reste le plus spécifique')
    assert.equal(resolve(tblA.main, '/a/b')!.component, 'a-subtree', "'/a' n'absorbe plus '/a/b'")
  })

  // 7. absence de preneur — même comportement (aucune route ne matche)
  it('aucune route ne matche — même absence des deux côtés', async () => {
    const a = await transpile(['<script>', "@routes = { 'main': { '/': 'home-page', '/about': 'about-page' } }", '</script>', '<p/>'].join('\n'), { moduleName: 'parity-7-a' })
    const b = await transpile(['<routes target="main">', '  /        home-page', '  /about   about-page', '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-7-b' })
    const tblA = extractRoutesTable(a.output)
    const tblB = extractRoutesTable(b.output)
    assert.equal(resolve(tblA.main, '/nimportequoi'), null)
    assert.equal(resolve(tblB.main, '/nimportequoi'), null)
  })

  // 8. deux cibles (target) distinctes cohabitant dans le même composant
  it('deux cibles distinctes cohabitent, chacune sa table', async () => {
    const a = await transpile(['<script>', "@routes = { 'main': { '/': 'home-page' }, 'side': { '/nav': 'nav-page' } }", '</script>', '<p/>'].join('\n'), { moduleName: 'parity-8-a' })
    const b = await transpile([
      '<routes target="main">', '  /   home-page', '</routes>',
      '<routes target="side">', '  /nav   nav-page', '</routes>',
      '<p/>',
    ].join('\n'), { moduleName: 'parity-8-b' })
    const tblA = extractRoutesTable(a.output)
    const tblB = extractRoutesTable(b.output)
    assert.deepEqual(tblA, tblB)
    assert.deepEqual(resolve(tblA.main, '/'), resolve(tblB.main, '/'))
    assert.deepEqual(resolve(tblA.side, '/nav'), resolve(tblB.side, '/nav'))
  })

  // 9. slash final — canonicalisation identique des deux côtés (mécanisme runtime
  //    PARTAGÉ, `_mjs_canonHash`/`_mjs_canonicalizeUrl` : indépendant de la forme de déclaration ;
  //    ce test le prouve en confrontant les DEUX tables à la même URL canonicalisée à la main)
  it('slash final — même chemin canonique, même résolution des deux côtés', async () => {
    const a = await transpile(['<script>', "@routes = { 'main': { '/a': 'a-page' } }", '</script>', '<p/>'].join('\n'), { moduleName: 'parity-9-a' })
    const b = await transpile(['<routes target="main">', '  /a   a-page', '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-9-b' })
    const tblA = extractRoutesTable(a.output)
    const tblB = extractRoutesTable(b.output)
    const canon = µ.Router._mjs_canonHash('#/a/') // même utilitaire runtime que _mjs_canonicalizeUrl
    assert.equal(canon, '#/a', 'le slash final est retiré par le routeur, indépendamment de la table')
    const url = canon.slice(1)
    assert.deepEqual(resolve(tblA.main, url), resolve(tblB.main, url))
    assert.equal(resolve(tblA.main, url)!.component, 'a-page')
  })

  // 10. préchargement compile-time — mêmes appels Autoloader?.load?. émis
  it('préchargement compile-time identique', async () => {
    const a = await transpile(['<script>', "@routes = { 'main': { '/': 'home-page', '/guide': 'guide-page' } }", '</script>', '<p/>'].join('\n'), { moduleName: 'parity-10-a' })
    const b = await transpile(['<routes target="main">', '  /        home-page', '  /guide   guide-page', '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-10-b' })
    const preA = extractPreloads(a.output).sort()
    const preB = extractPreloads(b.output).sort()
    assert.deepEqual(preA, preB)
    assert.deepEqual(preA, ['guide-page', 'home-page'])
  })

  // 11. ordre de déclaration — même ensemble de routes, ordre différent → même résolution
  //     (le tri de spécificité de `_mjs_sortedPaths` ne dépend pas de l'ordre d'écriture)
  it('ordre de déclaration sans effet sur la résolution', async () => {
    const aOrdered   = await transpile(['<script>', "@routes = { 'main': { '/posts/new': 'new-page', '/posts/(:id)': 'posts-page' } }", '</script>', '<p/>'].join('\n'), { moduleName: 'parity-11-a1' })
    const aReordered = await transpile(['<script>', "@routes = { 'main': { '/posts/(:id)': 'posts-page', '/posts/new': 'new-page' } }", '</script>', '<p/>'].join('\n'), { moduleName: 'parity-11-a2' })
    const bOrdered   = await transpile(['<routes target="main">', '  /posts/new       new-page', '  /posts/(:id)     posts-page', '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-11-b1' })
    const bReordered = await transpile(['<routes target="main">', '  /posts/(:id)     posts-page', '  /posts/new       new-page', '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-11-b2' })
    const tables = [aOrdered, aReordered, bOrdered, bReordered].map(r => extractRoutesTable(r.output).main)
    for (const url of ['/posts/new', '/posts/42']) {
      const results = tables.map(t => resolve(t, url))
      for (const r of results) assert.deepEqual(r, results[0], url)
    }
    assert.equal(resolve(tables[0], '/posts/new')!.component, 'new-page', 'le littéral reste plus spécifique que l\'optionnel, quel que soit l\'ordre déclaré')
  })

  // 12. forme mixte — bloc <routes> + @routes['cible']['/x'] = 'composant' en complément
  //     → table finale identique à la même table écrite entièrement dans l'une OU l'autre forme
  it('forme mixte (bloc + complément script) == table écrite entièrement en A == entièrement en B', async () => {
    const mixed = await transpile([
      '<routes target="main">',
      '  /   home-page',
      '</routes>',
      '<script>',
      "@routes['main']['/extra'] = 'extra-page'",
      '</script>',
      '<p/>',
    ].join('\n'), { moduleName: 'parity-12-mixed' })

    const pureA = await transpile(['<script>', "@routes = { 'main': { '/': 'home-page', '/extra': 'extra-page' } }", '</script>', '<p/>'].join('\n'), { moduleName: 'parity-12-pure-a' })
    const pureB = await transpile(['<routes target="main">', '  /        home-page', '  /extra   extra-page', '</routes>', '<p/>'].join('\n'), { moduleName: 'parity-12-pure-b' })

    // reconstitue la table finale de la forme mixte : base du bloc + mutations du script
    const mixedBase = extractRoutesTable(mixed.output)
    const mixedFinal = JSON.parse(JSON.stringify(mixedBase))
    for (const [target, path, comp] of extractMutations(mixed.output)) {
      mixedFinal[target] ??= {}
      mixedFinal[target][path] = comp
    }

    const tblPureA = extractRoutesTable(pureA.output)
    const tblPureB = extractRoutesTable(pureB.output)
    assert.deepEqual(mixedFinal, tblPureA)
    assert.deepEqual(mixedFinal, tblPureB)
    assert.deepEqual(resolve(mixedFinal.main, '/extra'), resolve(tblPureA.main, '/extra'))
  })
})
