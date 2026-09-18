// Test de régression — `createSSRRenderer`/`renderToString` ne transmettaient
// NI `sigil`, NI `contextAlias`, NI `stylesheetsDir` au `Bundler` qu'ils
// construisent en interne. Un projet configuré en sigil `'mjs'` (ou avec des
// styles partagés dans un dossier non standard) obtenait un rendu SSR CASSÉ
// ou NON STYLÉ, alors que `mjs build`/`mjs dev` (qui transmettent bien ces
// options à LEUR PROPRE Bundler, cf. cli.ts) fonctionnaient normalement —
// incohérence CSR/SSR silencieuse.
//
// Fix : `SSRRendererOptions` gagne `sigil`/`contextAlias`/`stylesheetsDir`,
// transmis au `new Bundler({...})` interne ; `render-request.ts` les
// transmet à son tour depuis `MjsConfig`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR — sigil/stylesheetsDir transmis au Bundler interne (pas seulement mjs build/dev)', function () {
  this.timeout(30000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("sigil:'mjs' — un composant utilisant la forme ASCII (mjs.inspect) ne plante PAS le rendu SSR", async function () {
    const root = mjsTmp('ssr-sigil')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // `mjs.inspect` (forme ASCII) — reconnue UNIQUEMENT si le Bundler
    // interne du SSR reçoit sigil:'mjs' (sinon reste `mjs.inspect(...)`
    // littéral dans la sortie → `mjs` est un global INDÉFINI à l'éval SSR →
    // TypeError au montage du composant).
    writeFileSync(join(srcDir, 'comp.mjs'), `
<script lang="coffee">
$count = 0
mjs.inspect $count
</script>
<p>{$count}</p>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-comp', sigil: 'mjs' })
    assert.match(res.html, /<p/,
      "AVANT le fix : sigil non transmis au Bundler interne du SSR → mjs.inspect jamais réécrit en µ.inspect → TypeError à l'éval ('mjs' n'est pas défini)")
  })

  it('stylesheetsDir custom — le Bundler interne du SSR scanne bien CE dossier (pas le défaut, vide)', async function () {
    const root = mjsTmp('ssr-styles')
    const srcDir = join(root, 'src')
    const stylesDir = join(root, 'mes-styles-a-moi')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>ok</p>')
    // Fichier SASS délibérément CASSÉ dans le dossier custom : si le Bundler
    // interne du SSR le scanne bien (stylesheetsDir correctement transmis),
    // `compile()` throw (une erreur SASS n'est plus avalée) —
    // preuve INDIRECTE mais fiable que ce chemin précis a été pris en
        // compte (une preuve "positive" — vérifier qu'un style VALIDE est
    // appliqué — n'est pas observable de façon fiable via le HTML retourné,
    // les styles PARTAGÉS n'étant pas nécessairement ré-inlinés dans le
    // fragment SSR d'UN composant).
    writeFileSync(join(stylesDir, 'casse.scss'), '.x { color: ; !!! pas du sass valide')

    await assert.rejects(
      renderToString({ sourceDir: srcDir, tag: 'mjs-comp', stylesheetsDir: stylesDir }),
      /erreur|Error/i,
      "AVANT le fix : stylesheetsDir custom non transmis au Bundler interne du SSR → ce dossier (et son fichier cassé) n'est JAMAIS scanné → aucune erreur, MAIS aussi aucun style partagé chargé, silencieusement non stylé")
  })
})
