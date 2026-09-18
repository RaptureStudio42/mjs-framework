// `<@head><title>…</title></@head>` — le titre du document suit la page (navigation, 1ʳᵉ brique).
//
// AVANT ce correctif, `µ._setHead` faisait un `appendChild` de TOUS les nœuds, `<title>` compris.
// La spécification HTML est formelle : le titre du document est celui du PREMIER `<title>` de
// l'arbre — et toute page en a déjà un. Le second était donc inerte : la doc et la leçon 16-5
// enseignaient un titre réactif qui ne changeait jamais rien à l'onglet.
//
// Correctif : un `<title>` dans `<@head>` n'est plus un nœud ajouté, il écrit `document.title` ;
// le titre d'avant est mémorisé et rendu quand le composant s'endort (hook sleep, celui-là même
// qui retire les autres nœuds injectés).
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { assertAbsent } from './helpers/dom-assert.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script>
$n = 1
</script>

<@head>
  <title>Page {$n}</title>
  <meta name="mjs-test" content={"n" + $n}>
</@head>

<button class="inc" @click={$n += 1}>+</button>
`

// deuxième page, montée PAR-DESSUS la première : le dépilement doit se faire dans l'ordre
const COMPONENT_B = `
<@head>
  <title>Seconde page</title>
</@head>

<p>b</p>
`

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

describe('runtime — <@head><title> écrit document.title (et le rend en partant)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it("le titre suit la page, sans jamais ajouter un 2e <title> inerte, et revient au démontage", async function () {
    const root   = mjsTmp('head-title')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'headttl.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any      = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files    = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^headttl-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    win.eval(`
      ${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}
      globalThis.µ = µ;
      ${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}
    `)

    // titre de la page hôte AVANT toute injection — c'est lui qui devra revenir
    document.title = 'Mon site'

    document.body.innerHTML = '<mjs-headttl></mjs-headttl>'
    const el: any = document.body.firstElementChild
    await new Promise((r) => setTimeout(r, 80))

    assert.equal(document.title, 'Page 1', "AVANT le fix : le <title> injecté était un 2e titre inerte, l'onglet gardait 'Mon site'")
    assert.equal(document.head.querySelectorAll('title').length, 1, 'JAMAIS un second <title> dans le head — il ne servirait à rien')

    const meta = document.head.querySelector('meta[name="mjs-test"]')
    assert.ok(meta, 'les AUTRES nœuds du <@head> sont injectés normalement')
    assert.equal(meta.getAttribute('content'), 'n1')

    // réactivité : le $n lu dans le <@head> re-déclenche l'injection
    el._shadow.querySelector('button.inc').click()
    await new Promise((r) => setTimeout(r, 80))

    assert.equal(document.title, 'Page 2', 'le titre suit la variable réactive')
    assert.equal(document.head.querySelectorAll('title').length, 1, 'toujours un seul <title>')
    assert.equal(document.head.querySelector('meta[name="mjs-test"]').getAttribute('content'), 'n2', 'le meta est réconcilié EN PLACE')

    // départ de la page (hook sleep — le même qui retire les nœuds injectés)
    el.remove()
    await new Promise((r) => setTimeout(r, 80))

    assert.equal(document.title, 'Mon site', "une page qu'on quitte ne doit pas emporter son titre sur la suivante")
    assertAbsent(document.head.querySelector('meta[name="mjs-test"]'), 'le meta injecté repart avec le composant')

    win.close?.()
  })

  it('deux composants empilés se dépilent dans le bon ordre — B rend le titre de A, A rend celui du site', async function () {
    const root   = mjsTmp('head-title2')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'headttl.mjs'), COMPONENT)
    writeFileSync(join(srcDir, 'headttlb.mjs'), COMPONENT_B)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any      = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const lire  = (re: RegExp) => stripEsm(readFileSync(join(outDir, files.find((f: string) => re.test(f))!), 'utf-8'))

    win.eval(`
      ${lire(/^mjs_core-/)}
      globalThis.µ = µ;
      ${lire(/^headttl-/)}
      ${lire(/^headttlb-/)}
    `)

    document.title = 'Mon site'

    document.body.innerHTML = '<mjs-headttl></mjs-headttl>'
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(document.title, 'Page 1')

    document.body.insertAdjacentHTML('beforeend', '<mjs-headttlb></mjs-headttlb>')
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(document.title, 'Seconde page', 'dernier écrivain gagnant')

    document.body.lastElementChild.remove()
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(document.title, 'Page 1', 'B rend le titre qu\'il avait trouvé — celui de A, pas celui du site')

    document.body.lastElementChild.remove()
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(document.title, 'Mon site', 'A rend enfin celui du site')

    win.close?.()
  })

  it("un titre changé à la main entre-temps n'est jamais écrasé par le démontage", async function () {
    const root   = mjsTmp('head-title3')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'headttl.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any      = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const lire  = (re: RegExp) => stripEsm(readFileSync(join(outDir, files.find((f: string) => re.test(f))!), 'utf-8'))

    win.eval(`
      ${lire(/^mjs_core-/)}
      globalThis.µ = µ;
      ${lire(/^headttl-/)}
    `)

    document.title = 'Mon site'
    document.body.innerHTML = '<mjs-headttl></mjs-headttl>'
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(document.title, 'Page 1')

    document.title = 'Écrit à la main'
    document.body.firstElementChild.remove()
    await new Promise((r) => setTimeout(r, 80))

    assert.equal(document.title, 'Écrit à la main', "le composant ne rend son ancien titre que s'il est encore l'affiché")

    win.close?.()
  })
})
