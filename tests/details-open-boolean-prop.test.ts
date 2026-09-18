// Test de régression :
// `@booleanProp` (`@open`/`@checked`/`@disabled`/etc., ex. `<details @open>`)
// forçait INCONDITIONNELLEMENT vers `bindingStandard` — qui n'accepte QUE la
// forme two-way bien formée `!{…}`. Par construction, une valeur `!{…}` bien
// formée est DÉJÀ interceptée par la règle générale « !{…} → binding_standard »
// (valable pour n'importe quel attribut, préfixé @ ou non) — donc CE bloc
// n'était jamais atteint QUE pour les 2 AUTRES formes, que `bindingStandard`
// rejette TOUJOURS avec une erreur cryptique :
//   - `<details @open>` (nu, aucune expression à lier) — DEVRAIT être statique.
//   - `<details @open={isExpanded}>` (dynamique unidirectionnel) — un cas
//     d'usage courant, sans besoin d'écrire en retour vers `isExpanded`.
// Fix : router chaque forme vers le handler qui la comprend réellement
// (`dynamic()`/`booleanAttr()`) au lieu de toujours forcer `bindingStandard`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('generator/attributes — @booleanProp (<details @open>)', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  async function compileComp(html: string): Promise<{ errors: string[]; code: string | null }> {
    const root = mjsTmp('b10')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), html)
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

  it("<details @open> nu (bare) compile SANS ERREUR — statique, équivalent à <details open>", async () => {
    const { errors, code } = await compileComp(`
<script lang="coffee">
</script>
<details @open><summary>s</summary>contenu</details>
`)
    assert.deepEqual(errors, [], "AVANT le fix : [binding_standard] expected !{...} pattern, got \"true\"")
    assert.match(code!, /_mjs_cloneTpl\("<details open>/)
  })

  it('<details @open={expr}> (dynamique unidirectionnel) compile SANS ERREUR et produit une liaison réactive correcte', async () => {
    const { errors, code } = await compileComp(`
<script lang="coffee">
isExpanded = true
</script>
<details @open={isExpanded}><summary>s</summary>contenu</details>
`)
    assert.deepEqual(errors, [], "AVANT le fix : [binding_standard] expected !{...} pattern, got \"true\"")
    assert.match(code!, /_mjs_updAttr\('a1',\s*'open',\s*isExpanded\)/,
      "la liaison doit cibler l'attribut PUR 'open' (pas '@open'), déléguée à _mjs_updAttr/_mjs_updAttrNode " +
      "(qui gère déjà correctement le retrait du booléen sur false/null/undefined)")
  })

  it('<details @open=!{$x}> (two-way) : cible le VRAI attribut "open" (pas "@open"), via la propriété DOM booléenne, et écoute "toggle" (pas "input")', async () => {
    const { errors, code } = await compileComp(`
<script lang="coffee">
$isExpanded = true
</script>
<details @open=!{$isExpanded}><summary>s</summary>contenu</details>
`)
    assert.deepEqual(errors, [])
    assert.doesNotMatch(code!, /['"]@open['"]/,
      'AVANT le fix : node.setAttribute(\'@open\', …) — le "@" jamais retiré, un attribut BIDON, "open" natif jamais affecté')
    assert.match(code!, /node\.open\s*!==\s*!!\$\.isExpanded/,
      "AVANT le fix : node.setAttribute('open', …) — écrit la CHAÎNE 'false' quand isExpanded=false, ne RETIRE jamais l'attribut (toujours ouvert)")
    assert.match(code!, /_mjs_bindEvents\(\{"toggle":/,
      "AVANT le fix : écoutait 'input', un événement que <details> ne déclenche JAMAIS — le sens DOM→modèle du two-way ne se déclenchait jamais")
    assert.match(code!, /µ\._set\(_mjsThis,\s*'isExpanded',\s*el\.open\)/,
      "la lecture DOM→modèle doit utiliser la PROPRIÉTÉ el.open (booléen propre), pas el.getAttribute('open') (chaîne '' au lieu de true)")
  })

  it("@click (event listener normal, PAS un boolean prop) continue de fonctionner (pas de régression)", async () => {
    const { errors, code } = await compileComp(`
<script lang="coffee">
onClick = -> console.log('clicked')
</script>
<button @click={onClick()}>go</button>
`)
    assert.deepEqual(errors, [])
    // Modèle d'événements délégué (1 listener global) :
    // pas d'addEventListener par nœud — l'id se retrouve dans _mjs_bindEvents.
    // Index `0` : avant, `state.inlines`/
    // `state.events` n'étaient PAS reset entre pre-pass et real pass → chaque
    // handler émis EN DOUBLE, l'index vivant était donc `1` (après l'entrée MORTE
    // de la pre-pass en 0). Le reset des deux passes ramène l'unique handler à `0`.
    assert.match(code!, /_mjs_bindEvents\(\{"click":\{"e1":0\}\}\)/)
  })
})
