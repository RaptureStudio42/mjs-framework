// SSR — `{await $p}` dont la promesse REJETTE, sans branche `{error}` déclarée dans le
// template, doit signaler quelque chose dans `RenderResult.warnings` — le rendu vide (aucune
// branche affichée) reste inchangé, mais `state.error` (l'objet Error réel) est connu côté SERVEUR
// au moment de sérialiser et ne doit plus disparaître en silence total (avant ce correctif :
// `warnings` restait vide, seul le HTML devenait un `<div></div>` muet).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR renderToString — {await} rejetée sans branche {error} : warning serveur', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('sans branche {error} : rendu vide inchangé, MAIS un warning cite le message de rejet', async function () {
    const root = mjsTmp('await-reject-sans-branche')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'noerr.mjs'), `
<script lang="coffee">
$p = new Promise (resolve, reject) -> reject(new Error('boom-sans-handler'))
</script>
<div class="wrap">
{await $p}
  <p class="pending">chargement…</p>
{success val}
  <p class="ok">{val}</p>
{end}
</div>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-noerr', settleMs: 800 })

    assert.ok(!res.html.includes('pending'), "le contenu final ne doit plus être l'état 'pending' figé")
    assert.ok(!/class="ok"/.test(res.html), 'pas de branche success affichée (logique)')
    assert.ok(res.warnings.some(w => /boom-sans-handler/.test(w)),
      `un warning doit citer le message de l'erreur rejetée — warnings reçus : ${JSON.stringify(res.warnings)}`)
  })

  it('AVEC branche {error} déclarée (contrôle) : comportement inchangé, la branche affiche le message', async function () {
    const root = mjsTmp('await-reject-avec-branche')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'witherr.mjs'), `
<script lang="coffee">
$p = new Promise (resolve, reject) -> reject(new Error('boom-avec-handler'))
</script>
<div class="wrap">
{await $p}
  <p class="pending">chargement…</p>
{success val}
  <p class="ok">{val}</p>
{error err}
  <p class="err">ERREUR: {err.message}</p>
{end}
</div>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-witherr', settleMs: 800 })
    assert.ok(res.html.includes('ERREUR: boom-avec-handler'), 'la branche {error} déclarée doit toujours afficher le message')
    // Garde-fou — le rejet est CONSOMMÉ par la branche {error} : aucun avertissement
    // ne doit partir (avant correctif : `st.status === 'error'` seul déclenchait le warning quand même).
    assert.equal(res.warnings.length, 0,
      `branche {error} présente : ZÉRO avertissement attendu — warnings reçus : ${JSON.stringify(res.warnings)}`)
  })
})
