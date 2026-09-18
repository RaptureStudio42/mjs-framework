// compile : directive @flash (vocabulaire fermé popup/console/silent), comblant le trou
// découvert (le runtime lisait déjà mjs-flash, aucune règle @flash → mjs-flash
// n'existait côté transpiler). Volet COMPILE seulement (preprocessHtml, transpiler/index.ts) — même
// style que tests/transpiler-callback-confirm.test.ts (transpile() appelé directement, pas le
// Bundler complet — inutile ici, la directive ne touche pas au système de fichiers/imports). Le
// volet runtime (µ._mjs_navFlashPolicy) est couvert par ses propres tests, non repris ici.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('transpiler — @flash', () => {
  it('@flash="popup" (guillemets doubles) → mjs-flash="popup" dans le composant compilé', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @flash="popup">Suppr</a>`
    const { output } = await transpile(src, { moduleName: 'fl1' })
    assert.match(output, /mjs-flash=['"]popup['"]/)
  })

  it("@flash='console' (guillemets simples) → mjs-flash=\"console\"", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<form @flash='console'>x</form>`
    const { output } = await transpile(src, { moduleName: 'fl2' })
    assert.match(output, /mjs-flash=['"]console['"]/)
  })

  it('@flash="silent" → mjs-flash="silent"', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @flash="silent">x</button>`
    const { output } = await transpile(src, { moduleName: 'fl3' })
    assert.match(output, /mjs-flash=['"]silent['"]/)
  })

  it('valeur HORS popup/console/silent (ex. "loud") → ERREUR de compile explicite', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @flash="loud">x</a>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'fl4' }),
      /@flash.*"popup".*"console".*"silent".*entre guillemets/s,
    )
  })

  it('forme ACCOLADES @flash={expr} → ERREUR de compile explicite (piège écouteur DOM fantôme)', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @flash={someExpr}>x</a>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'fl5' }),
      /@flash.*"popup".*"console".*"silent".*entre guillemets/s,
    )
  })

  it('attribut natif d\'un autre nom (data-flash="popup", pas la directive @flash) reste intact', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<div data-flash="popup">x</div>`
    const { output } = await transpile(src, { moduleName: 'fl6' })
    assert.match(output, /data-flash=['"]popup['"]/)
    assert.doesNotMatch(output, /mjs-flash=/)
  })
})
