// µmount : nettoyage par valeur de retour (sucre, symétrique µeffect/@attach) :
// « oui, en sucre pur, équivalent exact à appeler la même logique dans µdestroy, jamais à µsleep ».
// Implémentation : `_mjs_hook` (mjs_element.ts) enveloppe le callback `mount`,
// enregistre son retour via `_mjs_onDestroy` si c'est une fonction. Couvre : appel
// réel une seule fois à la destruction définitive, AUCUN appel sur un simple
// déplacement DOM (disconnect+reconnect même tick, sans destruction — cf.
// lifecycle-reconnect-dead-flag.test.ts), binding `this`/`@` correct dans le
// cleanup capturé (piège : `_mjs_destroy_cbs` invoque ses callbacks NUS).

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('µmount — nettoyage par retour (jamais à µsleep, une fois à la destruction)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  async function buildAndMount(name: string, src: string) {
    const root = mjsTmp(`mcr-${name}`)
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, `${name}.mjs`), src)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
    const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))!
    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))}`)
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>'
    const a = document.getElementById('a')
    const el = document.createElement(`mjs-${name}`)
    a.appendChild(el)
    await sleep(80)
    return { win, document, a, el }
  }

  it('a. destruction définitive (removeChild, jamais réinséré) : le cleanup tourne EXACTEMENT 1 fois', async () => {
    const src = `
<script lang="coffee">
$n = 1

µmount ->
  window.__aMountRuns = (window.__aMountRuns or 0) + 1
  ->
    window.__aCleanupRuns = (window.__aCleanupRuns or 0) + 1
</script>
<p>&#123;$n&#125;</p>
`
    const { win, a, el } = await buildAndMount('a-destroy', src)
    assert.equal(win.__aMountRuns, 1, 'µmount tiré 1x au montage')
    assert.equal(win.__aCleanupRuns, undefined, 'cleanup pas encore tiré tant que le composant est monté')
    a.removeChild(el)
    await sleep(60)
    assert.equal(win.__aCleanupRuns, 1, 'cleanup tiré EXACTEMENT 1x à la destruction définitive')
  })

  it('b. déplacement DOM même tick (disconnect+reconnect SANS destruction) : le cleanup NE tourne PAS', async () => {
    const src = `
<script lang="coffee">
$n = 1

µmount ->
  window.__bMountRuns = (window.__bMountRuns or 0) + 1
  ->
    window.__bCleanupRuns = (window.__bCleanupRuns or 0) + 1
</script>
<p>&#123;$n&#125;</p>
`
    const { win, document, a, el } = await buildAndMount('b-move', src)
    assert.equal(win.__bMountRuns, 1, 'µmount tiré 1x au montage')
    const b = document.getElementById('b')
    // Pas d'`await` entre les deux lignes : le déplacement doit rester dans le
    // MÊME tick, avant que le microtask de destruction différée ne s'exécute
    // (cf. lifecycle-reconnect-dead-flag.test.ts, même motif).
    a.removeChild(el)
    b.appendChild(el)
    await sleep(60)
    assert.equal(win.__bCleanupRuns, undefined, 'cleanup NON tiré : le composant a seulement été déplacé, jamais détruit')
    assert.equal(win.__bMountRuns, 1, 'µmount ne se redéclenche pas non plus sur un simple déplacement (comportement pré-existant, inchangé)')
    assert.equal(el.isConnected, true, 'reconnecté dans #b')
  })

  it('c. le cleanup capturé voit le bon `this` (`@`) — piège _mjs_destroy_cbs (callbacks appelés NUS)', async () => {
    const src = `
<script lang="coffee">
$n = 1
@label = 'depuis-mount'

µmount ->
  ->
    window.__cLabel = @label
</script>
<p>&#123;$n&#125;</p>
`
    const { win, a, el } = await buildAndMount('c-thisbind', src)
    a.removeChild(el)
    await sleep(60)
    assert.equal(win.__cLabel, 'depuis-mount', '`@label` lu correctement dans le cleanup — this bindé sur l\'instance, pas undefined')
  })

  it('d. µmount SANS retour (cas courant, aucun cleanup) : toujours sans erreur, aucun cleanup fantôme', async () => {
    const src = `
<script lang="coffee">
$n = 1

µmount ->
  window.__dMountRuns = (window.__dMountRuns or 0) + 1
  return
</script>
<p>&#123;$n&#125;</p>
`
    const { win, a, el } = await buildAndMount('d-noreturn', src)
    assert.equal(win.__dMountRuns, 1, 'µmount tiré normalement')
    a.removeChild(el)
    await sleep(60)
    assert.equal(win.__dCleanupRuns, undefined, 'aucun cleanup fantôme quand µmount ne retourne rien')
  })

  it('e. µsleep (hook séparé) tire sur le déplacement, le cleanup de µmount non — preuve directe de la séparation des 2 branches', async () => {
    const src = `
<script lang="coffee">
$n = 1

µmount ->
  ->
    window.__eCleanupRuns = (window.__eCleanupRuns or 0) + 1

µsleep ->
  window.__eSleepRuns = (window.__eSleepRuns or 0) + 1
</script>
<p>&#123;$n&#125;</p>
`
    const { win, document, a, el } = await buildAndMount('e-sleepvsdestroy', src)
    const b = document.getElementById('b')
    a.removeChild(el)
    b.appendChild(el)
    await sleep(60)
    assert.equal(win.__eSleepRuns, 1, 'µsleep tire bien à CHAQUE déconnexion, y compris un simple déplacement')
    assert.equal(win.__eCleanupRuns, undefined, 'le cleanup de µmount ne tire PAS à µsleep — seulement à une vraie destruction')
    // destruction définitive ensuite : le cleanup doit alors tirer.
    b.removeChild(el)
    await sleep(60)
    assert.equal(win.__eCleanupRuns, 1, 'puis EXACTEMENT 1x à la destruction définitive qui suit')
  })
})
