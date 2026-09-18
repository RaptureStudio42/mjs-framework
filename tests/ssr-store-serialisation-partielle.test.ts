// SSR — une SEULE clé non sérialisable dans le store `$$` (référence circulaire créée
// PENDANT le rendu par le composant lui-même) ne doit PLUS faire perdre TOUT le store partagé.
// Avant ce correctif, `serializeGlobal` (renderToString.ts) appelait `JSON.stringify` UNE FOIS sur
// l'objet ENTIER : la moindre clé fautive faisait échouer l'appel entier, `sharedScript` sortait
// VIDE (même les clés parfaitement saines disparaissaient avec), et `RenderResult.warnings` ne
// disait RIEN (seul un `console.warn` serveur, invisible de l'appelant).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR renderToString — sérialisation du store $$ clé par clé', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('une clé circulaire ($$b) est omise et nommée dans warnings — les autres clés ($$a) survivent', async function () {
    const root = mjsTmp('store-serial-partielle')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'circ.mjs'), `
<script lang="coffee">
$$a = 1
$$b = { name: 'x' }
$$b.self = $$b
</script>
<p>{$$a}</p>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-circ' })

    assert.match(res.sharedScript, /"a":1/, 'la clé $$a (saine) doit survivre dans sharedScript')
    assert.doesNotMatch(res.sharedScript, /"b"/, 'la clé $$b (circulaire) ne doit PAS apparaître dans sharedScript')
    assert.ok(res.warnings.some(w => /"b"/.test(w)),
      `un warning doit citer la clé fautive "b" — warnings reçus : ${JSON.stringify(res.warnings)}`)
  })

  it("aucune clé fautive : comportement inchangé, sharedScript complet, pas de warning de sérialisation", async function () {
    const root = mjsTmp('store-serial-partielle-ok')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'sain.mjs'), `
<script lang="coffee">
$$x = 1
$$y = 'texte'
</script>
<p>{$$x}</p>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-sain' })
    assert.match(res.sharedScript, /"x":1/)
    assert.match(res.sharedScript, /"y":"texte"/)
    assert.equal(res.warnings.length, 0, `aucun warning attendu ici : ${JSON.stringify(res.warnings)}`)
  })
})
