// Test de régression — `serializeGlobal`
// (renderToString.ts) n'échappait QUE `</` dans le JSON sérialisé de
// `µ.store` avant de l'injecter dans un
// `<script type="application/json">`. Le parsing HTML entre dans un état
// "script data (double) escaped" dès qu'un contenu SCRIPT contient `<!--`
// PUIS `<script` — dans cet état, un `</script>` LITTÉRAL (même le VRAI,
// posé juste après le JSON) n'est PLUS reconnu comme terminateur : le
// parseur avale tout le reste de la page (dont le `<script>` qui charge le
// bundle) comme simple texte — bundle jamais exécuté. Un store contenant
// `<!--` puis `<script` (donnée utilisateur stockée réactivement — un
// commentaire, un pseudo…) suffit à déclencher ceci ; `</` seul ne protège
// pas contre `<!--`/`<script` isolés.
//
// Fix : échapper TOUT `<` en `<` — échappement JSON VALIDE (round-trip
// exact via JSON.parse côté client) qui élimine tout déclencheur possible.
//
// Mineur lié, même fonction : un échec de JSON.stringify (référence
// circulaire, BigInt) était avalé en silence (balise vide, divergence
// SSR/client silencieuse) — désormais un `console.warn`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR renderToString — serializeGlobal : échappement complet de `<` (pas seulement `</`)', () => {
  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("une valeur store contenant '<!--' PUIS '<script' ne laisse AUCUN '<' littéral dans le JSON sérialisé", async function () {
    this.timeout(30000)
    const root = mjsTmp('ssr-escape')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'banner.mjs'), `
<script lang="coffee">
</script>
<div class="g">Bonjour {$$comment}</div>
`)
    const payload = "<!--evil--><script>alert(1)</script>"
    const res = await renderToString({
      sourceDir: srcDir,
      tag: 'mjs-banner',
      store: { comment: payload },
    })

    // Isole le contenu du <script type="application/json" id="__mjs_store">…</script>
    const m = res.sharedScript.match(/id="__mjs_store">([\s\S]*?)<\/script>/)
    assert.ok(m, `bloc __mjs_store introuvable. sharedScript:\n${res.sharedScript}`)
    const jsonInScript = m![1]

    assert.doesNotMatch(jsonInScript, /</,
      "AVANT le fix : seul '</' était échappé — '<!--' et '<script' isolés survivaient tels quels, déclenchant l'état HTML 'script data double escaped' qui aurait avalé le </script> RÉEL et tout le reste de la page")

    // Round-trip : le client doit récupérer EXACTEMENT la valeur d'origine.
    const parsed = JSON.parse(jsonInScript)
    assert.equal(parsed.comment, payload, "l'échappement \\u003c doit être réversible sans perte via JSON.parse")

    await terminateSharedWorkerPool()
  })

  it('un store JSON-sérialisable normal (sans caractères spéciaux) continue de fonctionner (pas de régression)', async function () {
    this.timeout(30000)
    const root = mjsTmp('ssr-escape-normal')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'banner.mjs'), `
<script lang="coffee">
</script>
<div class="g">Bonjour {$$user}</div>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-banner', store: { user: 'Ada' } })
    assert.match(res.sharedScript, /id="__mjs_store"/)
    assert.match(res.sharedScript, /Ada/)
  })
})
