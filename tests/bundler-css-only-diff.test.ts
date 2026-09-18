// Rechargement CSS à chaud en dev : diff « css-only » du bundler.
//
// En mode watch, le bundler mémorise par fichier composant le dernier
// TranspileData ET (filet central) le hash de chaque fichier émis. Au
// recompile suivant, `stats.cssOnly` vaut :
//   - un payload {components, sheets, root?} si CHAQUE changement du tour est
//     soit un composant dont SEUL le baseCss diffère, soit une feuille de
//     stylesheetsDir présente des deux côtés avec un CSS différent ;
//   - `null` sinon (script/template touché, fichier ou feuille ajouté/retiré,
//     module .civet co-changé, erreur de compile… — repli reload complet) ;
//   - `undefined` hors watch (jamais calculé).
// Le bundle sur disque est réécrit normalement dans TOUS les cas.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool, type CompileStats } from '../src/bundler/index.js'

const COMP_V1 = [
  '<script lang="coffee">',
  '$titre = "salut"',
  '</script>',
  '<p class="t">{$titre}</p>',
  '<style>',
  '.t',
  '  color: red',
  '</style>',
].join('\n')

// même script/template, SEUL le CSS change
const COMP_V2_CSS = COMP_V1.replace('color: red', 'color: blue')

// le TEMPLATE change (le CSS aussi peu importe) → jamais css-only
const COMP_V2_TPL = COMP_V1.replace('<p class="t">', '<p class="t" id="autre">')

function makeProject(prefix: string) {
  const root = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const stylesDir = join(root, 'styles')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(stylesDir, { recursive: true })
  return { root, srcDir, stylesDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

function makeBundler(p: ReturnType<typeof makeProject>, tracking = true): Bundler {
  const b = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir })
  // arme le suivi comme le fait `watch()` (testé bout-en-bout plus bas) sans
  // payer chokidar dans chaque cas unitaire
  if (tracking) (b as any).cssOnlyTracking = true
  return b
}

describe('bundler — diff « css-only » (rechargement CSS à chaud)', function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it('hors watch : stats.cssOnly reste undefined (jamais calculé)', async () => {
    const p = makeProject('cssonly-off')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    const b = makeBundler(p, false)
    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.equal(stats.cssOnly, undefined)
  })

  it('build initial sous watch : null (aucune baseline, repli reload)', async () => {
    const p = makeProject('cssonly-init')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    const b = makeBundler(p)
    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.equal(stats.cssOnly, null)
  })

  it('SEUL le <style> change → payload css-only avec le CSS scopé du composant', async () => {
    const p = makeProject('cssonly-hit')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    const b = makeBundler(p)
    await b.compile()

    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V2_CSS)
    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.ok(stats.cssOnly, 'un changement 100 % CSS doit produire un payload css-only')
    const css = stats.cssOnly!.components['mjs-comp']
    assert.ok(css, `le tag mjs-comp doit figurer dans le payload (reçu : ${JSON.stringify(Object.keys(stats.cssOnly!.components))})`)
    assert.match(css, /^:host\{display:block\}/, 'le CSS du payload doit être le CSS SCOPÉ (préfixe :host{display}) — même formule que _mjs_baseCss côté runtime')
    assert.match(css, /blue/)
    assert.ok(!css.includes('red'))
    assert.deepEqual(stats.cssOnly!.sheets, {})
    assert.equal(stats.cssOnly!.root, undefined)
  })

  it('le TEMPLATE change → null (repli reload complet)', async () => {
    const p = makeProject('cssonly-tpl')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    const b = makeBundler(p)
    await b.compile()

    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V2_TPL)
    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.equal(stats.cssOnly, null)
  })

  it('le <script> change → null', async () => {
    const p = makeProject('cssonly-script')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    const b = makeBundler(p)
    await b.compile()

    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1.replace('"salut"', '"bonjour"'))
    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.equal(stats.cssOnly, null)
  })

  it('batch MIXTE (css d\'un composant + script d\'un autre) → null', async () => {
    const p = makeProject('cssonly-mixte')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    writeFileSync(join(p.srcDir, 'autre.mjs'), COMP_V1)
    const b = makeBundler(p)
    await b.compile()

    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V2_CSS)
    writeFileSync(join(p.srcDir, 'autre.mjs'), COMP_V1.replace('"salut"', '"bonjour"'))
    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.equal(stats.cssOnly, null, 'UN SEUL fichier non-css dans le lot disqualifie tout le lot')
  })

  it('deux composants changent TOUS DEUX de CSS seul → payload avec les deux tags', async () => {
    const p = makeProject('cssonly-deux')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    writeFileSync(join(p.srcDir, 'autre.mjs'), COMP_V1)
    const b = makeBundler(p)
    await b.compile()

    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V2_CSS)
    writeFileSync(join(p.srcDir, 'autre.mjs'), COMP_V1.replace('color: red', 'color: green'))
    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.ok(stats.cssOnly)
    assert.match(stats.cssOnly!.components['mjs-comp'], /blue/)
    assert.match(stats.cssOnly!.components['mjs-autre'], /green/)
  })

  it('feuille PARTAGÉE (stylesheetsDir) seule modifiée → payload sheets', async () => {
    const p = makeProject('cssonly-sheet')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    writeFileSync(join(p.stylesDir, 'theme.scss'), '.a { color: red; }')
    const b = makeBundler(p)
    await b.compile()

    writeFileSync(join(p.stylesDir, 'theme.scss'), '.a { color: blue; }')
    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.ok(stats.cssOnly, 'une feuille partagée modifiée seule doit être css-only')
    assert.deepEqual(stats.cssOnly!.components, {})
    assert.match(stats.cssOnly!.sheets['theme'], /blue/)
  })

  it('mjs_root.{sass,scss} modifié seul → payload root', async () => {
    const p = makeProject('cssonly-root')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    writeFileSync(join(p.stylesDir, 'mjs_root.scss'), 'body { margin: 0; }')
    const b = makeBundler(p)
    await b.compile()

    writeFileSync(join(p.stylesDir, 'mjs_root.scss'), 'body { margin: 4px; }')
    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.ok(stats.cssOnly)
    assert.match(stats.cssOnly!.root!, /margin:\s*4px/)
  })

  it('feuille partagée AJOUTÉE → null (µ.CSS[name] naît au chargement de la page)', async () => {
    const p = makeProject('cssonly-sheetadd')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    writeFileSync(join(p.stylesDir, 'theme.scss'), '.a { color: red; }')
    const b = makeBundler(p)
    await b.compile()

    writeFileSync(join(p.stylesDir, 'neuve.scss'), '.b { color: pink; }')
    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.equal(stats.cssOnly, null)
  })

  it('composant SUPPRIMÉ dans le même lot qu\'un changement css → null', async () => {
    const p = makeProject('cssonly-del')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    writeFileSync(join(p.srcDir, 'mort.mjs'), COMP_V1)
    const b = makeBundler(p)
    await b.compile()

    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V2_CSS)
    unlinkSync(join(p.srcDir, 'mort.mjs'))
    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.equal(stats.cssOnly, null)
  })

  it('module .coffee co-changé dans le lot → null (filet central des émissions)', async () => {
    const p = makeProject('cssonly-module')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    writeFileSync(join(p.srcDir, 'util.coffee'), 'value = 1\n')
    const b = makeBundler(p)
    await b.compile()

    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V2_CSS)
    writeFileSync(join(p.srcDir, 'util.coffee'), 'value = 2\n')
    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.equal(stats.cssOnly, null, 'le module recompilé n\'est pas du CSS : reload complet obligatoire')
  })

  it('erreur SASS dans le <style> → stats.errors non vide ET cssOnly null (overlay, jamais de hot-swap)', async () => {
    const p = makeProject('cssonly-sasserr')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    const b = makeBundler(p)
    await b.compile()

    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1.replace('<style>', '<style lang="scss">').replace('.t\n  color: red', '.t { color: #{ }'))
    const stats = await b.compile()
    assert.ok(stats.errors.length > 0)
    assert.equal(stats.cssOnly, null)
  })

  it('recompile SANS aucun changement de contenu → null (jamais un payload vide)', async () => {
    const p = makeProject('cssonly-noop')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    const b = makeBundler(p)
    await b.compile()

    const stats = await b.compile()
    assert.equal(stats.errors.length, 0)
    assert.equal(stats.cssOnly, null)
  })

  it('bout-en-bout via watch() : onRecompile reçoit les stats, un changement 100 % CSS produit cssOnly', async function () {
    const p = makeProject('cssonly-watch')
    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V1)
    const b = makeBundler(p, false) // watch() arme lui-même le suivi

    const events: Array<{ path: string; stats?: CompileStats }> = []
    const watchDone = b.watch({ onRecompile: (path, stats) => events.push({ path, stats }) })
    await watchDone
    assert.equal(events.length, 1)
    assert.equal(events[0].path, '<initial>')
    assert.equal(events[0].stats?.cssOnly, null, 'build initial = null (reload), suivi bien ARMÉ par watch()')

    writeFileSync(join(p.srcDir, 'comp.mjs'), COMP_V2_CSS)
    const start = Date.now()
    while (events.length < 2 && Date.now() - start < 20000) {
      await new Promise(r => setTimeout(r, 50))
    }
    assert.ok(events.length >= 2, `timeout : recompile jamais déclenchée (events : ${JSON.stringify(events.map(e => e.path))})`)
    const last = events[events.length - 1]
    assert.ok(last.stats?.cssOnly, 'le changement de <style> seul doit produire un payload css-only via watch()')
    assert.match(last.stats!.cssOnly!.components['mjs-comp'], /blue/)
  })
})
