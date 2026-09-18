// `@import µ$$X 'chemin'` est LA forme unique d'import d'un singleton
// (`export µ$$X` côté module) ; se CONSOMME en `µ$$X`. `@import §§X 'chemin'`
// (ancienne écriture) est désormais une erreur de migration explicite : `§§X`
// redevient PUR contexte réactif d'ancêtres, plus jamais un singleton.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('@import µ$$X — forme unique d\'import d\'un singleton', () => {
  it('compile : import généré `import { $count }` présent', async () => {
    const src = `@import µ$$count 'p'\n<p>{µ$$count.value}</p>`
    const { output } = await transpile(src, { moduleName: 'importsingle1' })
    assert.match(output, /import \{ \$count \} from/)
  })

  it('la ligne @import ne fuit PAS dans le template compilé (µ._mjs_cloneTpl)', async () => {
    // NB : le nom réel du helper runtime est `µ._mjs_cloneTpl` (src/runtime/mjs_init.ts)
    const src = `@import µ$$count 'p'\n<p>{µ$$count.value}</p>`
    const { output } = await transpile(src, { moduleName: 'importsingle2' })
    const cloneTplCalls = output.match(/µ\._mjs_cloneTpl\("[^"]*"\)/g) ?? []
    assert.ok(cloneTplCalls.length > 0, 'au moins un appel µ._mjs_cloneTpl attendu')
    for (const call of cloneTplCalls) {
      assert.doesNotMatch(call, /@import/, `template compilé ne doit jamais contenir '@import' : ${call}`)
    }
  })

  it('`@import §§count` (ancienne écriture) → throw, message vérifié', async () => {
    const src = `@import §§count 'p'\n<p>{§§count.value}</p>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'importsingle3' }),
      /« @import §§count ».*@import µ\$\$count/s
    )
  })

  it('corps `µ$$count.value++` après `@import µ$$count` compile comme avant (consommation)', async () => {
    const src = `@import µ$$count 'p'\n<button @click={µ$$count.value++}>{µ$$count.value}</button>`
    const { output } = await transpile(src, { moduleName: 'importsingle4' })
    assert.match(output, /\$count\.value\+\+/, 'la consommation µ$$count.value++ doit router vers $count.value++')
    assert.match(output, /\$count\.value/, 'la lecture µ$$count.value doit router vers $count.value')
    assert.doesNotMatch(output, /µ\$\$count/, 'aucun µ$$ ne doit subsister')
  })

  it('`export µ$$count = 0` (côté exportateur) reste inchangé', async () => {
    // NB : le pipeline complet (transpile → Civet) compile `?=`→`??=` et
    // ajoute `var` sur l'export — vérifié sur pièce (comportement inchangé
    // par ce changement, juste la forme finale post-Civet, pas la forme Civet
    // intermédiaire qu'affiche `applyMjsSugarToScript` seul).
    const src = `<script module>\nexport µ$$count = 0\n</script>\n<p>module</p>`
    const { output } = await transpile(src, { moduleName: 'importsingle5' })
    assert.match(output, /export var \$count = µ_state\.count/, 'la déclaration µ$$ doit toujours router vers µ.state')
    assert.match(output, /µ_state\.count \?\?= µ\.state\(0\)/)
  })

  it('`@import §§x` DANS un bloc <pre>/<code> (doc) ne throw PAS (maskDocBlocks respecté)', async () => {
    const src = `<pre><code>@import §§x 'p'</code></pre>\n<p>Exemple de doc, pas une vraie directive.</p>`
    const { output } = await transpile(src, { moduleName: 'importsingle6' })
    assert.match(output, /§§x/, 'le §§x affiché en doc doit survivre littéralement, sans throw')
  })

  it('`µ$$count` SANS `@import µ$$count` correspondant → erreur singleton-sans-import', async () => {
    const src = `<p>{µ$$count.value}</p>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'importsingle7' }),
      /« µ\$\$count » utilisé sans « @import µ\$\$count »/
    )
  })

  it('`§§count`/`$count`/`$$count` sur un nom importé (`@import µ$$count`) → erreur mauvaise-consommation', async () => {
    const base = (usage: string) => `@import µ$$count 'p'\n<p>{${usage}}</p>`
    await assert.rejects(() => transpile(base('§§count.value'), { moduleName: 'importsingle8a' }), /µ\$\$count/)
    await assert.rejects(() => transpile(base('$count.value'), { moduleName: 'importsingle8b' }), /µ\$\$count/)
    await assert.rejects(() => transpile(base('$$count.value'), { moduleName: 'importsingle8c' }), /µ\$\$count/)
  })

  it('`§§clé` SANS import (contexte pur d\'ancêtres) reste `_mjs_getRCtx`, jamais un import', async () => {
    const src = `<script>\n  §§theme = { color: 'dark' }\n</script>\n<p>{§§theme.color}</p>`
    const { output } = await transpile(src, { moduleName: 'importsingle9' })
    assert.match(output, /_mjs_setRCtx\('theme',/, 'déclaration §§ → setRCtx, intact')
    assert.match(output, /_mjs_getRCtx\('theme'\)/, 'lecture §§ → getRCtx, intact')
  })

  it('équivalence de câblage : `@import µ$$count` + `µ$$count` compile EXACTEMENT le même import/handler que l\'ancien `@import §§count` + `§§count`', async () => {
    // Câblage figé (INVARIANT) : seule la surface syntaxique de
    // la SOURCE a changé (µ$$ au lieu de §§) — la réduction externe reste
    // `$count`, même chemin externalVars/externalReactives qu'avant. Les 2
    // lignes ci-dessous sont les mêmes que testées séparément par les `it`
    // "import généré" et "corps … compile comme avant", regroupées ici pour
    // affirmer explicitement la non-régression de câblage en un seul test.
    const src = `@import µ$$count 'p'\n<button @click={µ$$count.value++}>{µ$$count.value}</button>`
    const { output } = await transpile(src, { moduleName: 'importsingle10' })
    assert.match(output, /import \{ \$count \} from/, 'import généré identique à l\'ancien §§-import')
    assert.match(output, /\$count\.value\+\+/, 'écriture identique à l\'ancienne consommation §§')
    assert.match(output, /\$count\.value/, 'lecture identique à l\'ancienne consommation §§')
  })

  // La pré-passe 0-bis
  // (µ$$X→$X) ne masquait que `maskDocBlocks` (pre/code/commentaires HTML) :
  // une chaîne/un commentaire JS du <script> qui MENTIONNE `µ$$X` en exemple
  // faisait throw à tort (aucun import réel) ou, pire, voyait son TEXTE
  // corrompu en silence si le nom était par ailleurs importé (cas 13
  // ci-dessous). Les 4 `it` suivants couvrent les 4 cas reproduits.
  it('cas 1 — commentaire JS qui MENTIONNE µ$$count (non importé) ne throw PAS', async () => {
    const src = `<script>\n  // note: on utilise µ$$count ici plus tard\n  x = 1\n</script>\n<p>{x}</p>`
    const { output } = await transpile(src, { moduleName: 'importsingle11' })
    assert.match(output, /µ\$\$count ici plus tard/, 'le commentaire doit survivre littéralement')
    // (?<!\$) exclut le `$count` qui termine littéralement « µ$$count » (le
    // commentaire lui-même) — seul un `$count` BARE (câblage réel, absent ici)
    // ferait échouer cette assertion.
    assert.doesNotMatch(output, /(?<!\$)\$count\b/, 'aucun câblage $count ne doit apparaître (aucun import réel)')
  })

  it('cas 2 — chaîne JS qui MENTIONNE µ$$count (non importée) ne throw PAS, la chaîne garde µ$$count littéral', async () => {
    const src = `<script>\n  msg = "utilise µ$$count pas §§count"\n</script>\n<p>{msg}</p>`
    const { output } = await transpile(src, { moduleName: 'importsingle12' })
    assert.match(output, /"utilise µ\$\$count pas §§count"/, 'la chaîne doit survivre INTACTE, µ$$count non réécrit')
  })

  it('cas 3 (le plus grave) — @import µ$$count + chaîne qui MENTIONNE µ$$count + usage RÉEL : usage câblé vers $count, chaîne INTACTE (pas de corruption silencieuse)', async () => {
    const src = `@import µ$$count 'p'\n<script>\n  msg = "le singleton s'appelle µ$$count"\n</script>\n<p>{µ$$count.value}</p>`
    const { output } = await transpile(src, { moduleName: 'importsingle13' })
    assert.match(output, /\$count\.value/, 'usage réel {µ$$count.value} câblé vers $count.value')
    assert.match(output, /"le singleton s'appelle µ\$\$count"/, 'la chaîne ne doit PAS être corrompue en "...s\'appelle $count"')
  })

  it('cas 4 — texte HTML STATIQUE (hors <code>, hors {…}) qui MENTIONNE µ$$count ne throw PAS, texte préservé (parité avec l\'ancien §§ : generator/compile.ts `case \'text\'` n\'exécute jamais de sigil sur le texte statique)', async () => {
    const src = `<p>Le symbole µ$$count identifie ce compteur.</p>`
    const { output } = await transpile(src, { moduleName: 'importsingle14' })
    assert.match(output, /Le symbole µ\$\$count identifie ce compteur\./, 'texte statique préservé littéralement')
  })

  it('non-régression — µ$$orphelin en CODE RÉEL (hors chaîne/commentaire/texte statique) sans import → throw TOUJOURS', async () => {
    const src = `<p>{µ$$orphelin.value}</p>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'importsingle15' }),
      /« µ\$\$orphelin » utilisé sans « @import µ\$\$orphelin »/
    )
  })
})
