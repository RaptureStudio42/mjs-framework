// µ.Store — mutation d'un ÉLÉMENT OBJET niché dans une collection native (Array/Map/Set/Date)
// restait totalement muette. `_mjs_buildProxy` (mjs_store.ts) ne wrappait récursivement un
// sous-objet QUE si le CONTENEUR courant n'était pas lui-même une collection native
// (`!isBuiltIn`, cf. `isBuiltIn` calculé sur la cible à l'entrée du proxy) : `store.data.list[0]`
// rendait donc l'objet BRUT, sans proxy interposé, et `store.data.list[0].n = 99` mutait en
// silence — zéro trap, zéro notification. `µ.state` (mjs_runes.ts, `_wrap`) n'a PAS cette garde :
// son proxy `coll` rappelle `_wrap(v, rootKey)` SANS CONDITION sur chaque valeur lue, wrappant
// donc déjà correctement les éléments objets d'un tableau/Map. Trouvé en revue le 23/09 : le fix
// documenté dans mjs_runes.ts (« un ÉLÉMENT objet d'une collection restait BRUT ») n'avait jamais
// été porté sur µ.Store, alors que la doc (docs/14-stores.md) recommande PRÉCISÉMENT ce
// mécanisme pour un état structuré (panier, liste d'entités) — exactement la forme qui casse.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

async function mount(name: string, source: string) {
  const root = mjsTmp(`storearr-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { window, el }
}

describe('µ.Store — réactivité d\'un élément objet niché dans une collection native', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('`store.data.list[0].n = 99` (élément d\'un Array) re-rend', async () => {
    const src = [
      '<script lang="coffee">',
      '@box = new µStore({list: [{n: 1}]})',
      '</script>',
      '<p class="n">{@box.data.list[0].n}</p>',
    ].join('\n')
    const { window, el } = await mount('storelist', src)
    const n = () => el._shadow.querySelector('.n').textContent.trim()
    assert.equal(n(), '1', 'valeur initiale')

    window.eval(`document.querySelector('mjs-storelist').box.data.list[0].n = 99;`)
    await new Promise(r => setTimeout(r, 90))
    assert.equal(n(), '99', 'AVANT le fix : élément de tableau non wrappé (isBuiltIn du CONTENEUR bloquait le wrap récursif) — mutation muette')
  })

  it('`store.data.map.get(\'a\').n = 99` (valeur d\'un Map) re-rend', async () => {
    const src = [
      '<script lang="coffee">',
      "@box = new µStore({map: new Map([['a', {n: 1}]])})",
      '</script>',
      "<p class=\"n\">{@box.data.map.get('a').n}</p>",
    ].join('\n')
    const { window, el } = await mount('storemap', src)
    const n = () => el._shadow.querySelector('.n').textContent.trim()
    assert.equal(n(), '1', 'valeur initiale')

    window.eval(`document.querySelector('mjs-storemap').box.data.map.get('a').n = 99;`)
    await new Promise(r => setTimeout(r, 90))
    assert.equal(n(), '99', 'même défaut que list[0] : valeur d\'un Map non wrappée')
  })

  it('contrôle — objet plat NICHÉ (pas dans une collection) reste réactif, comme avant le fix', async () => {
    const src = [
      '<script lang="coffee">',
      '@box = new µStore({user: {profile: {n: 1}}})',
      '</script>',
      '<p class="n">{@box.data.user.profile.n}</p>',
    ].join('\n')
    const { window, el } = await mount('storenested', src)
    const n = () => el._shadow.querySelector('.n').textContent.trim()
    assert.equal(n(), '1')
    window.eval(`document.querySelector('mjs-storenested').box.data.user.profile.n = 99;`)
    await new Promise(r => setTimeout(r, 90))
    assert.equal(n(), '99', 'ce cas marchait déjà avant le fix — non-régression')
  })
})
