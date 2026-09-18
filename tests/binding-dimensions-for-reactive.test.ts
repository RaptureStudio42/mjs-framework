// Test de régression — "dimensions=! inertes dans {for}" : `bindingDimensions`
// (attributes/index.ts, `clientWidth=!{...}`/`clientHeight=!{...}` etc. avec
// ResizeObserver) forçait `reactive=false` INCONDITIONNELLEMENT dans le
// contexte `{for}` — toute écriture retour passait par une assignation BRUTE
// (`$.x = v`), justifiée pour le cas `item.field` (item est déjà un Proxy
// vivant qui notifie tout seul, cf. `_mjs_wrapDeep`) mais qui laisse un
// `$.simpleVar` TOP-LEVEL/PARTAGÉ (ex. un widget dont la taille observée est
// commune à toutes les rows) totalement INERTE : **vérifié empiriquement**
// que `_state.sharedWidth` mutait bien mais qu'AUCUN texte interpolé ne se
// mettait à jour (`_state` est un objet ORDINAIRE, une assignation
// brute ne passe jamais par `_mjs_invalidate`).
//
// Fix : router vers `µ._set(_mjsThis, 'name', …)` dès que la cible est un
// `$.simpleVar` (peu importe root ou for) — `_mjsThis` est la référence stable
// au composant capturée par closure depuis `init()`, déjà utilisée ailleurs
// dans ce fichier en contexte `for` (ex. le dispatch filtré `@class`/attr).
// Combiné avec le fix compile.ts (structVars pour les vars externes
// interpolées dans un `{for}`, cf. for-body-outer-var-text-reactivity.test.ts)
// pour que le texte se re-rende réellement.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('generator/attributes — bindingDimensions en {for}', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  async function compileComp(name: string, html: string) {
    const root = mjsTmp('dimfor')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, `${name}.mjs`), html)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const compFile = readdirSync(outDir).find((f: string) => new RegExp(`^${name}-`).test(f))!
    return { outDir, compCode: readFileSync(join(outDir, compFile), 'utf-8') }
  }

  it("$.simpleVar PARTAGÉ lié depuis un {for} : écrit via µ._set(_mjsThis, …), plus une assignation brute", async () => {
    const { compCode } = await compileComp('dimforgen1', `
<script lang="coffee">
$items = ['a', 'b']
$sharedWidth = 0
</script>
{for item in $items}
<div clientWidth=!{$sharedWidth}><span>{item}</span></div>
{end}
`)
    assert.match(compCode, /µ\._set\(_mjsThis,\s*'sharedWidth',\s*t\.clientWidth\)/,
      "AVANT le fix : émettait '$.sharedWidth = t.clientWidth' — mute _state SANS jamais invalider")
    assert.doesNotMatch(compCode, /\$\.sharedWidth\s*=\s*t\.clientWidth/)
  })

  it("item.field (cas courant, PAS un $.simpleVar) : continue d'utiliser l'assignation brute (le Proxy de l'item notifie déjà tout seul — pas de régression)", async () => {
    const { compCode } = await compileComp('dimforgen2', `
<script lang="coffee">
$items = [{name:'a', width:0}]
</script>
{for item in $items}
<div clientWidth=!{item.width}><span>{item.name}</span></div>
{end}
`)
    assert.match(compCode, /item\.width\s*=\s*t\.clientWidth/,
      'item.width reste une assignation directe sur le Proxy vivant (comportement déjà correct, à ne pas changer)')
    assert.doesNotMatch(compCode, /µ\._set\(_mjsThis,\s*'width'/,
      "item.width n'est PAS un $.simpleVar : ne doit PAS être routé vers µ._set")
  })

  it('root (hors {for}) : toujours µ._set(this, …) — comportement inchangé (non-régression du fix précédent)', async () => {
    const { compCode } = await compileComp('dimforgen3', `
<script lang="coffee">
</script>
<div clientWidth=!{$w}><span>{$w}</span></div>
`)
    assert.match(compCode, /µ\._set\(this,\s*'w',\s*t\.clientWidth\)/)
  })

  it('bout-en-bout : un ResizeObserver simulé sur UNE row met à jour le texte de TOUTES les rows (var partagée)', async function () {
    const root = mjsTmp('dimforrun')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'dimforrun.mjs'), `
<script lang="coffee">
$items = ['a', 'b']
$sharedWidth = 0
</script>
{for item in $items}
<div clientWidth=!{$sharedWidth}><span class="lbl">{item}:{$sharedWidth}</span></div>
{end}
`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const compFile = readdirSync(outDir).find((f: string) => /^dimforrun-/.test(f))!
    const compCode = readFileSync(join(outDir, compFile), 'utf-8')
    const coreFile = readdirSync(outDir).find((f: string) => /^mjs_core-/.test(f))!

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const captured: any[] = []
    win.ResizeObserver = class {
      cb: any
      constructor(cb: any) { this.cb = cb; captured.push(cb) }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(compCode)}`)

    document.body.innerHTML = '<mjs-dimforrun></mjs-dimforrun>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 60))

    const divs = el._shadow.querySelectorAll('div')
    assert.equal(divs.length, 2)
    assert.equal(captured.length, 2, 'un ResizeObserver par row')

    Object.defineProperty(divs[0], 'clientWidth', { value: 222, configurable: true })
    captured[0]([{ target: divs[0] }])
    await new Promise(r => setTimeout(r, 60))

    const labels = [...el._shadow.querySelectorAll('.lbl')].map((n: any) => n.textContent.trim())
    assert.deepEqual(labels, ['a:222', 'b:222'],
      "AVANT le double fix : restait ['a:0','b:0'] malgré _state.sharedWidth déjà à 222")

    win.close?.()
    await bundler.close()
  })
})
