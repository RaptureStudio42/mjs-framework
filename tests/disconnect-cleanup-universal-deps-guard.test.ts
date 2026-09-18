// disconnectedCallback() (mjs_element.ts) appelait µ._mjs_cleanupUniversalDeps(this) SANS garde —
// un cœur qui s'en passerait un jour (mjs_runes.ts reste aujourd'hui dans le cœur strict) planterait
// à CHAQUE déconnexion de composant, en silence nulle part ailleurs. Garde défensive
// `typeof … === 'function'`, même patron que les nettoyages voisins du même bloc (i18n). Ici
// `_mjs_cleanupUniversalDeps` reste bel et bien du cœur aujourd'hui : ce test simule son absence en
// la retirant après le montage, pas par une configuration réelle — c'est un prérequis de
// robustesse, pas un changement de comportement observable.

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
  const root = mjsTmp('disco-guard')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'discog.mjs'), '<p>x</p>\n')

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
  return { win, document }
}

function mount(document: any, tag: string): any {
  document.body.innerHTML = `<${tag}></${tag}>`
  return document.body.firstElementChild
}

describe('mjs_element.ts — disconnectedCallback() tolère µ._mjs_cleanupUniversalDeps absent', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('cas normal : µ._mjs_cleanupUniversalDeps est bien appelé à la déconnexion', async function () {
    const { win, document } = await loadHarness()
    const el = mount(document, 'mjs-discog')
    await new Promise((r) => setTimeout(r, 80))

    let calls = 0
    const orig = win.µ._mjs_cleanupUniversalDeps
    win.µ._mjs_cleanupUniversalDeps = function (...args: any[]) { calls++; return orig.apply(this, args) }

    assert.doesNotThrow(() => el.disconnectedCallback())
    assert.equal(calls, 1, 'la garde ne doit jamais empêcher un appel réel quand la fonction existe')

    win.close?.()
  })

  it('µ._mjs_cleanupUniversalDeps ABSENT : aucune exception, le nettoyage suivant tourne quand même', async function () {
    const { win, document } = await loadHarness()
    const el = mount(document, 'mjs-discog')
    await new Promise((r) => setTimeout(r, 80))

    // simule un cœur futur sans mjs_runes.ts : la fonction manque réellement au moment du
    // démontage, pas juste un mock qui jette.
    delete win.µ._mjs_cleanupUniversalDeps

    let storeUnsubCalls = 0
    const origStoreUnsub = win.µ._mjs_storeUnsubscribe
    win.µ._mjs_storeUnsubscribe = function (...args: any[]) { storeUnsubCalls++; return origStoreUnsub.apply(this, args) }

    assert.doesNotThrow(() => el.disconnectedCallback(), 'la déconnexion ne doit jamais planter si µ._mjs_cleanupUniversalDeps manque')
    assert.equal(storeUnsubCalls, 1, 'le nettoyage voisin (_mjs_storeUnsubscribe) doit tourner malgré tout : la garde ne coupe QUE l\'appel manquant')

    win.close?.()
  })
})
