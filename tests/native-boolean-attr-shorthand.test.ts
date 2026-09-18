// Sucre « booléens de props » — un attribut HTML5 RÉELLEMENT booléen écrit NU
// (`<input disabled>`, `<ol reversed>`) compile désormais comme la liaison
// dynamique `disabled={true}`, au lieu de rester un marqueur `type:'boolean'`
// inerte (jeté en silence par le générateur : l'attribut n'existait dans le
// template statique que par la sérialisation du HTML source, sans aucune
// liaison — donc rien côté composant/{for}).
//
// La réécriture vit dans parser/index.ts (parseAttrs) : `{type:'boolean'}` →
// `{type:'dynamic', expr:'true'}`, sur allowlist MJS_NATIVE_BOOLEAN_ATTRS. Quatre
// gardes protègent des chemins existants, chacune couverte ici :
//   - nom préfixé `@` → `<details @open>` garde son chemin dédié
//     (tests/details-open-boolean-prop.test.ts) ;
//   - tag À TIRET (composant MJS, `<@view>` → `metamjs-view`, web component
//     tiers) → le générateur y route tout attribut dynamique vers `_set()` /
//     `node[nom]=`, jamais dans le template : `<mjs-enfant hidden>` y perdrait
//     son attribut et ne serait PLUS caché ;
//   - tag `<@slot>` → son 1er attribut nu est un nom de slot (`<@slot default>`
//     = slot nommé « default », pas un booléen) ;
//   - nom hors allowlist → prop de composant, `data-*`, nom arbitraire : le parser laisse
//     le type `boolean` intact ; SUR UN COMPOSANT (nom à tiret), le générateur écrit
//     désormais `nom='true'` (`booleanAttr()`) —
//     restent nus : `popover`, `translate`, tout nom préfixé `mjs-`. Sur une balise
//     native, toujours nu, strictement inchangé.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('parser — sucre booléens de props (attribut HTML5 nu → liaison dynamique true)', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  // `fileName` par défaut 'comp.mjs' (comportement inchangé pour tous les appels existants) ;
  // les deux tests <@view> qui déclarent aussi @routes (router-aware)
  // passent 'comp.page.mjs', sinon le marqueur manque et la garde .page.mjs refuse le build
  // AVANT même d'atteindre le codegen que ces tests veulent examiner. `comp-` (readdirSync
  // ci-dessous) reste le préfixe du fichier haché quel que soit le nom source (pageAwareBaseName).
  async function compileComp(html: string, fileName = 'comp.mjs'): Promise<{ errors: string[]; code: string | null }> {
    const root = mjsTmp('boolattr')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, fileName), html)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    let code: string | null = null
    if (stats.errors.length === 0) {
      const compFile = readdirSync(outDir).find(f => /^comp-/.test(f))!
      code = readFileSync(join(outDir, compFile), 'utf-8')
    }
    await bundler.close()
    return { errors: stats.errors.map(e => e.message), code }
  }

  // signature de codegen d'un composant : le template cloné + tous les appels de
  // mise à jour d'attribut émis. Comparer CETTE extraction (et pas le fichier
  // entier) évite le bruit non pertinent (nom de fichier haché, entêtes).
  function codegenSig(code: string): string {
    return code.split('\n')
      .filter(l => /_mjs_cloneTpl\(|_mjs_updAttr\(|_mjs_updAttrNode\(/.test(l))
      .map(l => l.trim())
      .join('\n')
  }

  it("<input disabled> (nu) compile EXACTEMENT comme <input disabled={true}> — vraie liaison dynamique", async () => {
    const nu = await compileComp(`
<script lang="coffee">
</script>
<input disabled>
`)
    const explicite = await compileComp(`
<script lang="coffee">
</script>
<input disabled={true}>
`)
    assert.deepEqual(nu.errors, [])
    assert.deepEqual(explicite.errors, [])
    assert.match(nu.code!, /this\._mjs_updAttr\('a1',\s*'disabled',\s*true\)/,
      "AVANT le sucre : {type:'boolean'} inerte — AUCUN _mjs_updAttr émis, l'attribut n'était qu'un résidu du template statique")
    assert.equal(codegenSig(nu.code!), codegenSig(explicite.code!),
      'la forme nue doit produire le MÊME codegen que la forme explicite `={true}` (même chemin dynamic())')
  })

  it("<ol reversed> (nu) : le chemin générique marche même hors de MJS_BOOLEAN_PROPS (liste SÉPARÉE du générateur)", async () => {
    // `reversed` n'est PAS dans MJS_BOOLEAN_PROPS (generator/attributes/index.ts,
    // generator/compile.ts, runtime/mjs_element.ts) — la liste qui arbitre
    // propriété IDL vs setAttribute. La valeur réécrite étant la constante
    // compile-time `true`, le repli setAttribute écrit `reversed="true"` :
    // sémantique HTML de PRÉSENCE ⇒ correct dans les deux régimes.
    const nu = await compileComp(`
<script lang="coffee">
</script>
<ol reversed><li>a</li></ol>
`)
    const explicite = await compileComp(`
<script lang="coffee">
</script>
<ol reversed={true}><li>a</li></ol>
`)
    assert.deepEqual(nu.errors, [])
    assert.deepEqual(explicite.errors, [])
    assert.match(nu.code!, /this\._mjs_updAttr\('a1',\s*'reversed',\s*true\)/)
    assert.match(nu.code!, /_mjs_cloneTpl\("<ol reversed=''>/)
    assert.equal(codegenSig(nu.code!), codegenSig(explicite.code!))
  })

  it('dans un {for} : la liaison est bien reportée par nœud (_mjs_updAttrNode), pas perdue', async () => {
    const { errors, code } = await compileComp(`
<script lang="coffee">
$items = [1, 2]
</script>
<ul>{for it in $items}<li><input disabled></li>{end}</ul>
`)
    assert.deepEqual(errors, [])
    assert.match(code!, /µ\._mjs_updAttrNode\(\w+,\s*'disabled',\s*true\)/,
      'le chemin {for} passe par _mjs_updAttrNode — même sémantique que la racine (cf. runtime/mjs_element.ts)')
  })

  it('GARDE @ — <details @open> compile EXACTEMENT comme avant (chemin dédié intact)', async () => {
    const { errors, code } = await compileComp(`
<script lang="coffee">
</script>
<details @open><summary>s</summary>contenu</details>
`)
    assert.deepEqual(errors, [])
    assert.match(code!, /_mjs_cloneTpl\("<details open>/,
      "`@open` nu reste STATIQUE (booléen figé dans le template) — la réécriture ne doit jamais voir un nom préfixé @")
    assert.doesNotMatch(code!, /_mjs_updAttr\w*\([^)]*'open'/,
      'aucune liaison dynamique ne doit apparaître : ce serait la preuve que la garde `!name.startsWith(\'@\')` a sauté')
  })

  it('GARDE <@view> — le 1er attribut nu reste un id (`<@view unId>` → id="unId")', async () => {
    const { errors, code } = await compileComp(`
<script lang="coffee">
@routes = '/': 'x'
</script>
<div><@view unId></div>
`, 'comp.page.mjs')
    assert.deepEqual(errors, [])
    assert.match(code!, /<metamjs-view id='unId'><\/metamjs-view>/)
  })

  it('GARDE <@view> — même avec un nom DE L\'ALLOWLIST : `<@view default>` → id="default", jamais une liaison', async () => {
    const { errors, code } = await compileComp(`
<script lang="coffee">
@routes = '/': 'x'
</script>
<div><@view default></div>
`, 'comp.page.mjs')
    assert.deepEqual(errors, [])
    assert.match(code!, /<metamjs-view id='default'><\/metamjs-view>/)
    assert.doesNotMatch(code!, /_mjs_updAttr\w*\([^)]*'default'/)
  })

  it('GARDE <@slot> — `<@slot default>` reste le slot NOMMÉ "default" (régression précise visée)', async () => {
    // `default` est À LA FOIS un booléen HTML5 valide (<track default>) et un nom
    // de slot on ne peut plus plausible : sans la garde sur node.name === 'slot',
    // parseDom (~520) ne trouverait plus un premier attribut `type:'boolean'` à
    // convertir en name="…" → le slot perdait son nom.
    const { errors, code } = await compileComp(`
<script lang="coffee">
</script>
<div><@slot default></@slot></div>
`)
    assert.deepEqual(errors, [])
    assert.match(code!, /<slot name='default'><\/slot>/)
    assert.doesNotMatch(code!, /_mjs_updAttr\w*\([^)]*'default'/)
  })

  it("attribut nu sur un composant (`<mjs-foo bar>`) : émis `bar='true'`, statique, jamais `_mjs_updAttr`", async () => {
    const { errors, code } = await compileComp(`
<script lang="coffee">
</script>
<mjs-foo bar></mjs-foo>
`)
    assert.deepEqual(errors, [])
    assert.match(code!, /_mjs_cloneTpl\("<mjs-foo bar='true'><\/mjs-foo>"\)/,
      "attribut nu sur un composant → `nom='true'`, littéral dans le template")
    assert.doesNotMatch(code!, /_mjs_updAttr\w*\([^)]*'bar'/,
      "reste STATIQUE : aucune liaison dynamique, la valeur 'true' est écrite une fois pour toutes dans le gabarit")
  })

  it('exceptions qui restent nues sur un composant : `mjs-*` (marqueur interne) et `popover`', async () => {
    const mjsPrefixe = await compileComp(`
<script lang="coffee">
</script>
<mjs-foo mjs-light></mjs-foo>
`)
    assert.deepEqual(mjsPrefixe.errors, [])
    assert.match(mjsPrefixe.code!, /_mjs_cloneTpl\("<mjs-foo mjs-light><\/mjs-foo>"\)/,
      "un nom préfixé mjs- est un marqueur interne (BARE_ATTR_KEEP_NATIVE élargi) : jamais réécrit en 'true'")
    const popover = await compileComp(`
<script lang="coffee">
</script>
<my-widget popover></my-widget>
`)
    assert.deepEqual(popover.errors, [])
    assert.match(popover.code!, /_mjs_cloneTpl\("<my-widget popover><\/my-widget>"\)/,
      'popover reste dans BARE_ATTR_KEEP_NATIVE (src/generator/attributes/index.ts) : exception nommée à la liste')
  })

  it("attribut nu sur un composant à tiret (`<mjs-enfant hidden>`) : émis `hidden='true'`, l'hôte reste caché", async () => {
    // Sur un tag à tiret, dynamic() (generator/attributes/index.ts, `isWc`) émettrait
    // `node._set('hidden', true)` et n'écrirait RIEN dans le template : l'attribut
    // disparaîtrait du DOM, la feuille de style UA ne cacherait plus rien. On reste
    // donc sur `type:'boolean'`, géré par `booleanAttr()` — qui écrit maintenant
    // `hidden='true'` au lieu du nu d'avant :
    // `hidden` cache pour TOUTE valeur non retirée, l'hôte reste donc bien caché.
    const { errors, code } = await compileComp(`
<script lang="coffee">
</script>
<mjs-enfant hidden></mjs-enfant>
`)
    assert.deepEqual(errors, [])
    assert.match(code!, /_mjs_cloneTpl\("<mjs-enfant hidden='true'><\/mjs-enfant>"\)/,
      "hidden nu sur un composant devient littéralement hidden='true' dans le template")
    assert.doesNotMatch(code!, /_set\('hidden'/,
      "router vers _set() ferait perdre l'attribut : régression silencieuse (aucune erreur, élément visible)")
  })

  it("attribut nu sur un composant tiers (`<my-widget disabled>`) : émis `disabled='true'`, lu par présence ou par la chaîne", async () => {
    // Sans `._set`, dynamic() retomberait sur `node['disabled'] = true` : un expando
    // sans effet sur un custom element tiers, et toujours aucun attribut. On reste
    // donc sur `type:'boolean'` → `booleanAttr()` écrit maintenant `disabled='true'`
    // un composant tiers qui lit `disabled` par
    // PRÉSENCE ou par la chaîne 'true' le voit dans les deux cas.
    const { errors, code } = await compileComp(`
<script lang="coffee">
</script>
<my-widget disabled></my-widget>
`)
    assert.deepEqual(errors, [])
    assert.match(code!, /_mjs_cloneTpl\("<my-widget disabled='true'><\/my-widget>"\)/)
    assert.doesNotMatch(code!, /_mjs_updAttr\w*\([^)]*'disabled'|_set\('disabled'/)
  })

  it("fidélité préservée — `<input disabled=\"\">` (vide QUOTÉ) reste statique, il n'est pas un attribut nu", async () => {
    const { errors, code } = await compileComp(`
<script lang="coffee">
</script>
<input disabled="">
`)
    assert.deepEqual(errors, [])
    assert.doesNotMatch(code!, /_mjs_updAttr\w*\([^)]*'disabled'/,
      "seul l'attribut SANS `=` est réécrit ; le parser distingue déjà les deux (type:'static' val:'')")
  })
})
