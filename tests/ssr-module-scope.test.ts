// SSR — portée par fichier (Option A : portée totale par module, façon vrai ESM).
// Le SSR concatène tous les `.js` dans UN SEUL contexte d'éval. Sans portée par
// fichier, deux fichiers déclarant/exportant un même nom se télescopent (crash sur
// une variable privée, ou « dernier gagne » sur un export). `ssrScopeFile` restaure
// la portée : corps en IIFE, imports en destructuration locale depuis les namespaces.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString, createSSRRenderer } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR — portée des modules partagés (anti-collision)', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it('deux modules avec la MÊME variable PRIVÉE `data` ne se télescopent plus', async function () {
    this.timeout(30000)
    const src = mjsTmp('modscope-priv')
    mkdirSync(src, { recursive: true })
    // `data` privé de même nom dans deux modules : compilé en `const data`, il
    // planterait l'éval (« Identifier 'data' has already been declared ») sans la
    // portée par fichier — que la page les importe ou non (tout est concaténé).
    writeFileSync(join(src, 'a.module.civet'), `data := [1, 2, 3]\nexport totalA := data.length\n`)
    writeFileSync(join(src, 'b.module.civet'), `data := [10, 20]\nexport totalB := data.length\n`)
    writeFileSync(join(src, 'page.mjs'), `<p class="r">rendu OK malgré deux modules « data »</p>\n`)

    const res = await renderToString({ sourceDir: src, tag: 'mjs-page' })
    assert.match(res.html, /rendu OK/, 'chaque module garde son `data` privé')
  })

  it('deux modules exportant le MÊME nom ne plantent pas', async function () {
    this.timeout(30000)
    const src = mjsTmp('modscope-exp')
    mkdirSync(src, { recursive: true })
    // Cas réel (rapture : `trapFocus` ×3, `setupCrossfade` ×2) : deux modules
    // exportent le même nom. Chacun dans sa portée → aucune redéclaration fatale.
    writeFileSync(join(src, 'c.module.civet'), `export helper = -> 'C'\n`)
    writeFileSync(join(src, 'd.module.civet'), `export helper = -> 'D'\n`)
    writeFileSync(join(src, 'page.mjs'), `<p class="r">deux exports « helper » cohabitent</p>\n`)

    const res = await renderToString({ sourceDir: src, tag: 'mjs-page' })
    assert.match(res.html, /cohabitent/, 'l\'éval ne plante pas sur le doublon d\'export')
  })

  it('deux composants important le même nom depuis DEUX modules → chacun le SIEN', async function () {
    this.timeout(30000)
    const src = mjsTmp('modscope-a')
    mkdirSync(src, { recursive: true })
    // `tint` exporté par deux modules DIFFÉRENTS, importé par deux composants
    // distincts. Avec la portée par fichier (Option A), chaque composant appelle
    // le `tint` de SON module. Sans (scope plat « dernier gagne »), les deux
    // afficheraient la même valeur (celle du module chargé en dernier).
    writeFileSync(join(src, 'red.module.civet'), `export tint := -> 'ROUGE'\n`)
    writeFileSync(join(src, 'blue.module.civet'), `export tint := -> 'BLEU'\n`)
    writeFileSync(join(src, 'card-red.mjs'), `@import tint 'red.module.civet'\n\n<p class="r">{tint()}</p>\n`)
    writeFileSync(join(src, 'card-blue.mjs'), `@import tint 'blue.module.civet'\n\n<p class="b">{tint()}</p>\n`)

    const renderer = await createSSRRenderer({ sourceDir: src })
    try {
      const red = await renderer.renderToString('mjs-card-red')
      const blue = await renderer.renderToString('mjs-card-blue')
      assert.match(red.html, /ROUGE/, 'card-red doit rendre le tint de red')
      assert.doesNotMatch(red.html, /BLEU/, 'card-red ne doit PAS voir le tint de blue')
      assert.match(blue.html, /BLEU/, 'card-blue doit rendre le tint de blue')
    } finally {
      await renderer.close()
    }
  })
})
