// Test neuf — module cœur radio : COMPORTEMENT runtime en happy-dom, harnais
// build+happy-dom copié de tests/core-checkbox-indeterminate.test.ts:1-47 (lui-même
// copié de tests/core-toggles.test.ts:1-52).
//
// Bug ciblé : `@closest('form') ?? document` (radio.mjs) ne traverse jamais une
// frontière shadow — un groupe <mjs-radio> rendu dans le shadow root d'un composant
// CONTENEUR (donc SANS <form> dans ce même shadow) retombe sur `document`, qui ne
// voit jamais l'intérieur d'un shadow (fermé ici, cf. mjs_element.ts mode:'closed') :
// l'exclusion mutuelle du groupe est perdue, plusieurs boutons peuvent rester cochés.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// HOST = le composant conteneur TIERS : compilé en <mjs-hote>, SON PROPRE shadow root
// (fermé). `#grp-form` a un <form> dans ce même shadow (cas déjà couvert par
// closest('form'), non-régression) ; `#grp-noform` n'a AUCUN <form>, ni dans ce shadow
// ni ailleurs — exactement le scénario qui retombait sur `document` avant correctif.
const HOST = [
  '<form id="grp-form" @noUJS>',
  '  <@radio name="taille" value="s">S</@radio>',
  '  <@radio name="taille" value="m">M</@radio>',
  '  <@radio name="taille" value="l">L</@radio>',
  '</form>',
  '<div id="grp-noform">',
  '  <@radio name="couleur" value="rouge">Rouge</@radio>',
  '  <@radio name="couleur" value="vert">Vert</@radio>',
  '  <@radio name="couleur" value="bleu">Bleu</@radio>',
  '</div>',
].join('\n')

async function buildAndMount(hostSource: string): Promise<{ window: any; document: any; hote: any }> {
  const root = mjsTmp('core-radio')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'hote.mjs'), hostSource)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const files = readdirSync(outDir)
  const pick = (re: RegExp) => {
    const f = files.find((f) => re.test(f))
    assert.ok(f, `chunk attendu ${re} parmi ${files.join(', ')}`)
    return f!
  }
  const chunkFiles = [pick(/^mjs_core-/), pick(/^radio-/), pick(/^hote-/)]
  const code = chunkFiles.map((f) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))).join('\n')

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  window.eval(`${code}\nglobalThis.µ = µ;`)
  document.body.innerHTML = '<mjs-hote></mjs-hote>'
  await new Promise((r) => setTimeout(r, 80))
  const hote = document.body.querySelector('mjs-hote')
  return { window, document, hote }
}

// simule ce que fait un navigateur réel sur un clic radio : le natif passe à
// checked=true PUIS l'événement change se déclenche (@onChange l'écoute)
function check(win: any, native: any) {
  native.checked = true
  native.dispatchEvent(new win.Event('change', { bubbles: true, cancelable: true, composed: true }))
}

async function tick(ms = 30) {
  await new Promise((r) => setTimeout(r, ms))
}

describe('mjs-radio — exclusion mutuelle du groupe', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('groupe SANS <form>, dans le shadow root du composant hôte : cocher le 2e décoche le 1er', async () => {
    const { window, hote } = await buildAndMount(HOST)
    const radios = Array.from(hote._shadow.querySelectorAll('#grp-noform mjs-radio')) as any[]
    assert.equal(radios.length, 3, 'les 3 <mjs-radio> du groupe doivent être rendus dans le shadow de l\'hôte')
    const natives = radios.map((r: any) => r._shadow.querySelector('input.native'))

    check(window, natives[0])
    await tick()
    assert.equal(natives[0].checked, true, 'le 1er radio coché doit porter checked=true')

    check(window, natives[1])
    await tick()
    assert.equal(natives[1].checked, true, 'le 2e radio coché doit porter checked=true')
    assert.equal(natives[0].checked, false, 'le 1er radio doit repasser à checked=false (exclusion mutuelle du groupe)')
  })

  it('groupe DANS un <form> (même shadow) : cocher le 2e décoche le 1er — non-régression', async () => {
    const { window, hote } = await buildAndMount(HOST)
    const radios = Array.from(hote._shadow.querySelectorAll('#grp-form mjs-radio')) as any[]
    const natives = radios.map((r: any) => r._shadow.querySelector('input.native'))

    check(window, natives[0])
    await tick()
    assert.equal(natives[0].checked, true)

    check(window, natives[1])
    await tick()
    assert.equal(natives[1].checked, true)
    assert.equal(natives[0].checked, false, 'exclusion mutuelle via <form> : déjà correcte avant le fix, doit le rester')
  })
})
