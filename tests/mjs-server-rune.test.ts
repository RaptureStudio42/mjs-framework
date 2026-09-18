// µserver (= µ.server) — rune PUBLIQUE, valeur SIMPLE non réactive (contrairement
// au trio µonline/µvisible/µready) indiquant le contexte d'exécution : true côté
// SSR, false côté client. Compilation (lexer/cleanJs) couverte par
// mu-short-globals.test.ts — ce fichier couvre le RENDU réel : la branche
// `{if µserver}`/`{if not µserver}` sort bien côté serveur (happy-dom), et le
// moteur navigateur (render-browser.ts) pose lui aussi `µ.server = true` malgré
// son `µ._isServer` volontairement absent (@mount y tourne pour de vrai).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('µserver — contexte SSR/client au rendu (happy-dom)', () => {
  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('{if µserver}/{if not µserver} : la branche SERVEUR sort, la branche CLIENT est absente', async function () {
    this.timeout(30000)
    const root = mjsTmp('server-rune')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'ctx.mjs'), `
<script lang="coffee">
</script>
{if µserver}<p class="s">COTE-SERVEUR</p>{end}
{if not µserver}<p class="c">COTE-CLIENT</p>{end}
`)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-ctx' })
    assert.match(res.html, /COTE-SERVEUR/, 'µserver doit être vrai au rendu happy-dom (branche serveur affichée)')
    assert.doesNotMatch(res.html, /COTE-CLIENT/, 'la branche "not µserver" ne doit JAMAIS sortir au SSR')
  })

  it('µserver reste lisible en interpolation directe ({µserver}), valeur booléenne simple', async function () {
    this.timeout(30000)
    const root = mjsTmp('server-rune-interp')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'flag.mjs'), `
<script lang="coffee">
</script>
<p class="flag">{µserver}</p>
`)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-flag' })
    assert.match(res.html, /class="flag">true</, '{µserver} interpolé doit afficher le booléen "true" au SSR')
  })
})
