// Test de régression — les objets natifs "exotiques" (CanvasRenderingContext2D,
// CSSStyleDeclaration, DOMRect…) ne doivent PAS être wrappés dans le Proxy de
// réactivité. Leurs méthodes font un brand-check sur `this` (internal slots) et
// rejettent un Proxy avec « X called on an object that does not implement
// interface … ».
//
// Bug vécu (tuto canvas) : `$context = $canvas.getContext('2d')` puis
// `$context.beginPath()` → TypeError, car `_mjs_wrapDeep` wrappait le contexte et
// `val.bind(proxy)` passait le Proxy comme `this` à `beginPath`.
//
// Fix : `_mjs_wrapDeep` ne wrappe que plain object / instance user (`[object
// Object]`), Array, Map/Set/Date/RegExp. Tout objet natif exotique → renvoyé
// brut.
//
// Le test couvre LES DEUX côtés :
//   A. un faux objet "natif" (Symbol.toStringTag custom + méthode qui vérifie
//      l'identité de `this`) appelé via `$X` fonctionne → preuve qu'il est brut.
//   B. une instance de classe utilisateur GARDE sa réactivité (méthode liée au
//      proxy, mutation `@w += n` re-render) — on ne casse pas le fix "Box".

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { assertAbsent } from './helpers/dom-assert.js'

const COMPONENT = `
<script lang="coffee">
# Faux objet "natif" : tag custom + méthode qui exige this === l'objet brut
# (simule le brand-check d'un CanvasRenderingContext2D).
makeNative = ->
  o = {}
  Object.defineProperty(o, Symbol.toStringTag, { value: 'FakeCtx' })
  o.draw = ->
    throw new TypeError('draw appelé sur le mauvais receiver (Proxy ?)') if this isnt o
    'drawn'
  o

$ctx = makeNative()
$result = '-'

# Instance de classe utilisateur : sa méthode DOIT muter via le proxy.
class Box
  constructor: ->
    @w = 0
  grow: (n) ->
    @w += n

$box = new Box()

go = ->
  $result = $ctx.draw()
  $box.grow(7)
</script>

<button @click={go}>go</button>
<p class="out">{$result}/{$box.w}</p>
`

describe('runtime — objets natifs exotiques non wrappés (brand-check this)', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('A: méthode native via $X marche (this brut) — B: classe user garde la réactivité', async function () {
    const root = mjsTmp('native-proxy')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'fakectx.mjs'), COMPONENT)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^fakectx-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    document.body.innerHTML = '<mjs-fakectx></mjs-fakectx>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    // Pas de crash fatal au mount.
    assert.ok(el._shadow, 'shadow monté')
    assertAbsent(el._shadow.querySelector('.mjs-fatal-error'), 'aucune erreur fatale au mount')

    // Avant clic : "-/0"
    const out0 = el._shadow.querySelector('.out')
    assert.equal(out0.textContent, '-/0', `état initial attendu "-/0", obtenu "${out0.textContent}"`)

    // Clic → go() : $ctx.draw() (méthode native) + $box.grow(7) (classe user)
    el._shadow.querySelector('button').dispatchEvent(
      new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 60))

    const out1 = el._shadow.querySelector('.out')
    // A: draw() a renvoyé 'drawn' (donc this était l'objet brut, pas le Proxy).
    // B: box.grow(7) a muté ET re-rendu → w === 7.
    assert.equal(out1.textContent, 'drawn/7',
      `attendu "drawn/7" (A: méthode native OK + B: réactivité classe user). obtenu "${out1.textContent}". ` +
      `Si "-/0" ou erreur fatale : l'objet natif a été wrappé et draw() a throw sur le Proxy.`)

    win.close?.()
  })
})
