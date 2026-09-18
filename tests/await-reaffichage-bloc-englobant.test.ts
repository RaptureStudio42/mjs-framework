// {if}/{key} racine autour d'un {await} : le contenu ne reapparaissait pas
// apres masquage puis affichage. Cause : l'ancre TEXTE d'un {await} (`s-<id>`/`e-<id>`,
// FRERE du contenu, pas descendant) sortait de `_mjs_destroyNodeAndChildren` par la branche
// `nodeType !== 1` SANS jamais passer par `_mjs_mjsPurgeSubtreeState` — seul un nœud ELEMENT
// y passait. `_mjs_awaitMap`/`_mjs_awaitLastRender` restaient donc peuples a la fermeture de la
// branche {if}/{key} englobante ; au re-affichage, `_mjs_updAwait` retrouve la MEME promesse
// et le MEME dernier statut rendu (`targetKey === lastRender`) → `_mjs_updIf` n'est jamais
// rappele sur les ancres fraiches (vides) → le contenu du {await} manque.
//
// RÈGLE MOCHA : jamais un nœud DOM passe a assert.equal/deepEqual — la
// suite se fige a 13 Go. Toute presence/absence est castee en booleen (`!!node`), tout
// texte lu via `?.textContent` (string ou null), jamais le nœud lui-meme.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// compile un ou plusieurs .mjs (bundler complet) et monte `<rootTag>` dans une fenetre
// happy-dom fraiche — calque de tests/attributes-await-booleens-props.test.ts (mountFiles)
async function mountFiles(files: Record<string, string>, rootTag: string): Promise<{ window: any; document: any; el: any; errors: any[] }> {
  const root   = mjsTmp('a3-16-await-reaff')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, src] of Object.entries(files)) writeFileSync(join(srcDir, name), src)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats   = await bundler.compile()
  if (stats.errors.length > 0) return { window: null, document: null, el: null, errors: stats.errors }
  const window: any   = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const outFiles = readdirSync(outDir)
  const coreFile = outFiles.find((f: string) => /^mjs_core-/.test(f))!
  const jsFiles  = outFiles.filter((f: string) => f.endsWith('.js') && f !== coreFile && f !== 'bundle.js')
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))
  const compCode = jsFiles.map((f: string) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))).join('\n')
  window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
  document.body.insertAdjacentHTML('beforeend', `<${rootTag}></${rootTag}>`)
  const el = document.body.querySelector(rootTag)
  return { window, document, el, errors: [] }
}

const tick = () => new Promise((r) => setTimeout(r, 150))

describe('{if}/{key} racine autour de {await} : reapparition apres masquage/affichage', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('{if} autour de {await}{success}<p> statique : absent apres hide, present (texte) apres show', async () => {
    const src = [
      '<script>', "$show = true", "$p = Promise.resolve(1)", '</script>',
      '{if $show}',
      '{await $p}{success d}',
      '<p class="hello">hello</p>',
      '{end}',
      '{end}',
      '<button class="hide" @click={$show = false}>hide</button>',
      '<button class="show" @click={$show = true}>show</button>',
    ].join('\n')
    const { el, errors } = await mountFiles({ 'a316t1.mjs': src }, 'mjs-a316t1')
    assert.equal(errors.length, 0, JSON.stringify(errors))
    await tick()
    assert.equal(!!el._shadow.querySelector('.hello'), true, 'avant hide : present')
    el._shadow.querySelector('.hide').click()
    await tick()
    assert.equal(!!el._shadow.querySelector('.hello'), false, 'apres hide : absent')
    el._shadow.querySelector('.show').click()
    await tick()
    const p = el._shadow.querySelector('.hello')
    assert.equal(!!p, true, 'apres show : present')
    assert.equal(p ? p.textContent : null, 'hello', 'apres show : texte correct')
  })

  it('meme structure avec binding {d} dans le {await} : la valeur resolue reapparait apres show', async () => {
    const src = [
      '<script>', "$show = true", "$p = Promise.resolve(42)", '</script>',
      '{if $show}',
      '{await $p}{success d}',
      '<p class="hello">{d}</p>',
      '{end}',
      '{end}',
      '<button class="hide" @click={$show = false}>hide</button>',
      '<button class="show" @click={$show = true}>show</button>',
    ].join('\n')
    const { el, errors } = await mountFiles({ 'a316t2.mjs': src }, 'mjs-a316t2')
    assert.equal(errors.length, 0, JSON.stringify(errors))
    await tick()
    el._shadow.querySelector('.hide').click()
    await tick()
    assert.equal(!!el._shadow.querySelector('.hello'), false, 'apres hide : absent')
    el._shadow.querySelector('.show').click()
    await tick()
    const p = el._shadow.querySelector('.hello')
    assert.equal(!!p, true, 'apres show : present')
    assert.equal(p ? p.textContent : null, '42', 'apres show : binding correctement rendu')
  })

  it('{key $k} racine autour de {await} : changer la cle (nouvelle branche) fait reapparaitre le contenu', async () => {
    const src = [
      '<script>', "$k = 1", "$p = Promise.resolve(1)", '</script>',
      '{key $k}',
      '{await $p}{success d}',
      '<p class="hello">hello</p>',
      '{end}',
      '{end}',
      '<button class="chg" @click={$k = 2}>chg</button>',
    ].join('\n')
    const { el, errors } = await mountFiles({ 'a316t3.mjs': src }, 'mjs-a316t3')
    assert.equal(errors.length, 0, JSON.stringify(errors))
    await tick()
    assert.equal(!!el._shadow.querySelector('.hello'), true, 'avant changement de cle : present')
    el._shadow.querySelector('.chg').click()
    await tick()
    assert.equal(!!el._shadow.querySelector('.hello'), true, 'apres changement de cle (nouvelle branche) : present')
  })

  it('hide/show x3 de suite : present a chaque show, jamais de doublon', async () => {
    const src = [
      '<script>', "$show = true", "$p = Promise.resolve(1)", '</script>',
      '{if $show}',
      '{await $p}{success d}',
      '<p class="hello">hello</p>',
      '{end}',
      '{end}',
      '<button class="hide" @click={$show = false}>hide</button>',
      '<button class="show" @click={$show = true}>show</button>',
    ].join('\n')
    const { el, errors } = await mountFiles({ 'a316t4.mjs': src }, 'mjs-a316t4')
    assert.equal(errors.length, 0, JSON.stringify(errors))
    await tick()
    for (let i = 1; i <= 3; i++) {
      el._shadow.querySelector('.hide').click()
      await tick()
      assert.equal(!!el._shadow.querySelector('.hello'), false, `tour ${i} : apres hide, absent`)
      el._shadow.querySelector('.show').click()
      await tick()
      assert.equal(el._shadow.querySelectorAll('.hello').length, 1, `tour ${i} : apres show, present une seule fois (pas de doublon)`)
    }
  })

  it('non-regression : {await} SEUL (sans {if} englobant), rechargement de la promesse : le contenu persiste', async () => {
    const src = [
      '<script>', "$p = Promise.resolve(1)", "reload = -> $p = Promise.resolve(1)", '</script>',
      '{await $p}{success d}',
      '<p class="hello">hello</p>',
      '{end}',
      '<button class="reload" @click={reload}>reload</button>',
    ].join('\n')
    const { el, errors } = await mountFiles({ 'a316t5a.mjs': src }, 'mjs-a316t5a')
    assert.equal(errors.length, 0, JSON.stringify(errors))
    await tick()
    assert.equal(!!el._shadow.querySelector('.hello'), true, 'avant reload : present')
    el._shadow.querySelector('.reload').click()
    await tick()
    assert.equal(!!el._shadow.querySelector('.hello'), true, 'apres reload : present')
  })

  it('non-regression : {if} SEUL (sans {await} dedans), hide/show : le contenu reapparait', async () => {
    const src = [
      '<script>', "$show = true", '</script>',
      '{if $show}',
      '<p class="hello">hello</p>',
      '{end}',
      '<button class="hide" @click={$show = false}>hide</button>',
      '<button class="show" @click={$show = true}>show</button>',
    ].join('\n')
    const { el, errors } = await mountFiles({ 'a316t5b.mjs': src }, 'mjs-a316t5b')
    assert.equal(errors.length, 0, JSON.stringify(errors))
    await tick()
    el._shadow.querySelector('.hide').click()
    await tick()
    assert.equal(!!el._shadow.querySelector('.hello'), false, 'apres hide : absent')
    el._shadow.querySelector('.show').click()
    await tick()
    assert.equal(!!el._shadow.querySelector('.hello'), true, 'apres show : present')
  })

  it('{if} autour de {await} dont la promesse REJETTE ({error err}) : le bloc error reapparait apres hide/show', async () => {
    const src = [
      '<script>', "$show = true", "$p = Promise.reject(new Error('boom'))", '</script>',
      '{if $show}',
      '{await $p}{success d}',
      '<p class="hello">hello</p>',
      '{error err}',
      '<p class="oops">{err.message}</p>',
      '{end}',
      '{end}',
      '<button class="hide" @click={$show = false}>hide</button>',
      '<button class="show" @click={$show = true}>show</button>',
    ].join('\n')
    const { el, errors } = await mountFiles({ 'a316t6.mjs': src }, 'mjs-a316t6')
    assert.equal(errors.length, 0, JSON.stringify(errors))
    await tick()
    assert.equal(!!el._shadow.querySelector('.oops'), true, 'avant hide : bloc error present')
    el._shadow.querySelector('.hide').click()
    await tick()
    assert.equal(!!el._shadow.querySelector('.oops'), false, 'apres hide : absent')
    el._shadow.querySelector('.show').click()
    await tick()
    const p = el._shadow.querySelector('.oops')
    assert.equal(!!p, true, 'apres show : bloc error reapparait')
    assert.equal(p ? p.textContent : null, 'boom', 'apres show : texte de l\'erreur correct')
  })
})
