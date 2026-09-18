// connectedCallback()/disconnectedCallback() (mjs_element.ts) appelaient µ._mjs_storeSubscribe/
// µ._mjs_storeUnsubscribe SANS garde — `vault` (mjs_store_globals.ts) est un module OPTIONNEL,
// jamais forcé par les autres modules détectés : un projet dont `runtime` explicite l'omet (ou `runtime:'core'`)
// planterait à CHAQUE connexion d'un composant qui lit `$$x`, et à CHAQUE déconnexion de
// N'IMPORTE QUEL composant (`_mjs_storeUnsubscribe` est appelée INCONDITIONNELLEMENT, même pour
// un composant qui ne lit AUCUN `$$x`). Gardes défensives `typeof … === 'function'`, même
// patron que tests/disconnect-cleanup-universal-deps-guard.test.ts : absence SIMULÉE par
// retrait après montage (ici : avant montage, pour couvrir aussi le côté connectedCallback) —
// pas une config réelle, un prérequis de robustesse.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
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

async function loadHarness() {
  const root = mjsTmp('disco-store-guard')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  // `$$compteur` (store global statisé) : pose `_mjs_storeKeys` sur le composant compilé —
  // c'est ce qui rend `µ._mjs_storeSubscribe` atteignable au montage. `runtime` par défaut (donc
  // 'vault' RÉELLEMENT dans ce bundle) : l'absence testée plus bas est SIMULÉE au runtime,
  // jamais une config qui ferait planter la ligne module-level `µ._storeDeclare(...)`
  // (émise par le compilateur pour TOUT usage de `$$x`, hors périmètre de cette garde).
  writeFileSync(join(srcDir, 'discog.mjs'), '<p>{$$compteur}</p>\n')

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const win: any = new Window({ url: 'http://localhost/' })
  const document: any = win.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => /^discog-/.test(f))
  assert.ok(coreFile && compFile, 'core + composant compilés')

  win.eval(`
    ${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}
    globalThis.µ = µ;
    ${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}
  `)
  assert.equal(typeof win.µ._mjs_storeSubscribe, 'function', "préalable : 'vault' doit être RÉELLEMENT dans ce bundle (sinon µ._storeDeclare aurait déjà planté au chargement)")
  return { win, document }
}

function mount(document: any, tag: string): any {
  document.body.innerHTML = `<${tag}></${tag}>`
  return document.body.firstElementChild
}

describe('mjs_element.ts — connectedCallback()/disconnectedCallback() tolèrent µ._mjs_storeSubscribe/µ._mjs_storeUnsubscribe absents', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('les deux ABSENTES (simulé, avant montage) : aucune exception au montage ni au démontage', async function () {
    const { win, document } = await loadHarness()
    delete win.µ._mjs_storeSubscribe
    delete win.µ._mjs_storeUnsubscribe

    let el: any
    assert.doesNotThrow(() => { el = mount(document, 'mjs-discog') }, 'connectedCallback ne doit jamais planter sans µ._mjs_storeSubscribe')
    await new Promise((r) => setTimeout(r, 80))
    assert.doesNotThrow(() => el.disconnectedCallback(), 'disconnectedCallback ne doit jamais planter sans µ._mjs_storeUnsubscribe')

    win.close?.()
  })

  it('cas normal : présentes, elles sont bien APPELÉES — la garde ne coupe jamais un appel réel', async function () {
    const { win, document } = await loadHarness()
    let subCalls = 0, unsubCalls = 0
    const origSub = win.µ._mjs_storeSubscribe
    const origUnsub = win.µ._mjs_storeUnsubscribe
    win.µ._mjs_storeSubscribe = function (...args: any[]) { subCalls++; return origSub.apply(this, args) }
    win.µ._mjs_storeUnsubscribe = function (...args: any[]) { unsubCalls++; return origUnsub.apply(this, args) }

    const el = mount(document, 'mjs-discog')
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(subCalls, 1, '_mjs_storeSubscribe doit être appelée au montage dès qu\'elle existe (le composant lit $$compteur)')

    el.disconnectedCallback()
    assert.equal(unsubCalls, 1, '_mjs_storeUnsubscribe doit être appelée au démontage dès qu\'elle existe')

    win.close?.()
  })
})
