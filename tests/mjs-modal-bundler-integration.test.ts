// Test neuf — intégration RÉELLE bundler ↔ mjs_modal.ts.
// Les autres fichiers mjs-modal-*.test.ts chargent
// mjs_init.ts + mjs_modal.ts directement (harnais rapide, isolé) ; celui-ci prouve que le VRAI
// pipeline Bundler produit bien la même chose :
//   1. `mjs_modal.ts` est réellement dans le CANONICAL du bundler (src/bundler/index.ts) —
//      présent en 'all'/défaut, ABSENT en 'core' (tree-shake du module optionnel 'modal').
//   2. Le manifest (writeManifest) émet `µ._runtimeLabels = {...}` INCONDITIONNELLEMENT — même
//      en 'core' (sans le module 'modal' lui-même), et reflète la clé `lang` de mjs.config.json
//      (fr par défaut, en si `lang:"en"`) via `getMessagesLang()`/`RUNTIME_LABELS`
//      (src/runtime-labels.ts).
//   3. Bout-en-bout : core + manifest RÉELLEMENT compilés, chargés dans un happy-dom Window,
//      `µ.config.confirm = true` + `µ.confirm(...)` déclenche RÉELLEMENT `µ.modal.fire` (pas un
//      mock) — le clic sur le bouton confirm résout la promesse à `true`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { setMessagesLang } from '../src/messages/index.js'
import { assertAbsent } from './helpers/dom-assert.js'
import { mjsTmp } from './helpers/tmp.js'

// bundle.js n'importe plus le cœur statiquement : son corps vit dans `import(µCore).then(async ({ µ }) => {…})`,
// que ce harnais (cœur et manifeste évalués ensemble, sans serveur) ne peut pas résoudre. On garde le préfixe
// (µCore/µPaths/µDeps, préchargement) et le corps du `.then()`, évalués dans la portée du cœur.
function manifestSync(raw: string): string {
  const bodyStart = raw.indexOf('const µReady = ')
  const body = raw.match(/const µReady = import\(µCore\)\.then\(async \(\{ µ \}\) => \{\n([\s\S]*)\n\}\);\nif \(typeof window/)
  assert.ok(bodyStart >= 0 && body, `corps du manifeste introuvable (forme inattendue) :\n${raw}`)
  return [raw.slice(0, bodyStart), body![1]].join('\n')
}

// Composant trivial : compile() a besoin d'au moins un fichier source pour produire un build
// représentatif (même patron que tests/ujs-shadow-confirm.test.ts) — sans rapport avec µ.modal
// lui-même, juste un point d'entrée .mjs minimal.
const COMPONENT = `<p>hop</p>\n`

async function buildProject(cfgExtra: any): Promise<{ root: string; outDir: string; manifestPath: string }> {
  const root = mjsTmp('modal-e2e')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'hop.mjs'), COMPONENT)
  const manifestPath = join(root, 'bundle.js')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', ...cfgExtra,
  }))
  const found = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts = resolveBundlerOpts(found!.config, found!.configDir)
  const bundler = new Bundler(opts as any)
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  return { root, outDir, manifestPath }
}

function coreContent(outDir: string): string {
  const files = readdirSync(outDir)
  const coreFile = files.find((f) => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, coreFile!), 'utf-8')
}

function readRuntimeLabels(manifestPath: string): any {
  const content = readFileSync(manifestPath, 'utf-8')
  const m = content.match(/µ\._runtimeLabels = (\{.*?\});/)
  assert.ok(m, 'µ._runtimeLabels doit être émis dans le manifest')
  return JSON.parse(m![1])
}

describe('mjs_modal — CANONICAL/tree-shake (module optionnel \'modal\')', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it("runtime absent (défaut 'all') : mjs_modal.ts RÉELLEMENT dans le core bundlé", async function () {
    const { outDir } = await buildProject({})
    const core = coreContent(outDir)
    assert.ok(core.includes('mjs-modal-backdrop'), 'la feuille CSS de mjs_modal.ts doit être concaténée dans mjs_core-*.js')
    assert.ok(/µ\.modal\s*=\s*\{/.test(core), 'µ.modal = {...} doit être défini dans le core')
  })

  it("runtime:'core' : mjs_modal.ts ABSENT du core bundlé (tree-shaké, module optionnel)", async function () {
    const { outDir } = await buildProject({ runtime: 'core' })
    const core = coreContent(outDir)
    assert.equal(core.includes('mjs-modal-backdrop'), false, 'core seul ne doit PAS embarquer mjs_modal.ts')
  })

  it("runtime:['modal'] (sans 'ujs') : mjs_modal.ts présent, utilisable de façon 100% autonome (µ.modal PAS seulement interne à @confirm)", async function () {
    const { outDir } = await buildProject({ runtime: ['modal'] })
    const core = coreContent(outDir)
    assert.ok(core.includes('mjs-modal-backdrop'))
    assert.equal(core.includes('_mjs_ujsOnClick'), false, "mjs_ujs.ts ne doit PAS être entraîné par 'modal' seul")
  })
})

describe('mjs_modal — µ._runtimeLabels : émission INCONDITIONNELLE du manifest, TOUTES langues', function () {
  this.timeout(30000)
  afterEach(() => { setMessagesLang('fr') }) // jamais laisser fuiter l'état global vers d'autres tests
  after(async () => { await terminateSharedWorkerPool() })

  // Le manifest n'émet plus UNE langue choisie au build (ancienne forme
  // plate `{ modal: …, toast: … }`) mais TOUTES les langues de src/runtime-labels.ts, plus
  // `µ._runtimeLabelsLang` (langue de repli du build : `i18n.default` du projet, sinon la clé
  // `lang` du CLI) — le choix de la langue AFFICHÉE se fait au runtime, via µ._mjs_label
  // (mjs_init.ts, cf. tests/runtime-labels-langue-affichee.test.ts).
  const FR = { modal: { ok: 'OK', cancel: 'Annuler', deny: 'Non' }, router: { notFound: 'Page introuvable', noRoute: 'Aucune route ne correspond à cette adresse.', declared: 'Routes déclarées' }, toast: { success: 'Succès', error: 'Erreur', warning: 'Attention', info: 'Info' }, ujs: { sendFailed: 'Échec de l\'envoi — le serveur n\'a pas répondu.' } }
  const EN = { modal: { ok: 'OK', cancel: 'Cancel', deny: 'No' }, router: { notFound: 'Page not found', noRoute: 'No route matches this address.', declared: 'Declared routes' }, toast: { success: 'Success', error: 'Error', warning: 'Warning', info: 'Info' }, ujs: { sendFailed: 'Sending failed — the server did not respond.' } }

  it('lang absente (défaut fr) : µ._runtimeLabels sert les DEUX langues, µ._runtimeLabelsLang vaut "fr"', async function () {
    const { manifestPath } = await buildProject({})
    const labels = readRuntimeLabels(manifestPath)
    assert.deepEqual(labels.fr, FR)
    assert.deepEqual(labels.en, EN)
    const manifest = readFileSync(manifestPath, 'utf-8')
    assert.ok(manifest.includes('µ._runtimeLabelsLang = "fr";'), 'langue de repli fr par défaut (clé lang absente)')
  })

  it("lang:'en' : µ._runtimeLabels sert QUAND MÊME les deux langues, µ._runtimeLabelsLang vaut \"en\"", async function () {
    const { manifestPath } = await buildProject({ lang: 'en' })
    const labels = readRuntimeLabels(manifestPath)
    assert.deepEqual(labels.fr, FR)
    assert.deepEqual(labels.en, EN)
    const manifest = readFileSync(manifestPath, 'utf-8')
    assert.ok(manifest.includes('µ._runtimeLabelsLang = "en";'), 'langue de repli en suit la clé lang du CLI')
  })

  it("runtime:'core' (module 'modal' ABSENT du bundle) : µ._runtimeLabels quand même émis — inconditionnel, contrairement à µ._i18nData", async function () {
    const { manifestPath } = await buildProject({ runtime: 'core' })
    const labels = readRuntimeLabels(manifestPath)
    assert.deepEqual(labels.fr, FR)
    assert.deepEqual(labels.en, EN)
  })

  it("i18n:{default:'en'} SANS lang : µ._runtimeLabelsLang suit la langue du PROJET, pas celle du CLI", async function () {
    const { manifestPath } = await buildProject({ i18n: { default: 'en' } })
    const manifest = readFileSync(manifestPath, 'utf-8')
    assert.ok(manifest.includes('µ._runtimeLabelsLang = "en";'), 'i18n.default prime sur la clé lang du CLI (absente ici)')
  })
})

describe('mjs_modal — bout-en-bout RÉEL : µ.config.confirm=true → µ.confirm() → µ.modal.fire (pas un mock)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('core + manifest compilés et chargés réellement : µ.confirm("Sûr ?") ouvre la VRAIE modale, clic confirm résout true', async function () {
    const { outDir, manifestPath } = await buildProject({})
    const core = readFileSync(join(outDir, readdirSync(outDir).find((f) => /^mjs_core-/.test(f))!), 'utf-8')
    const manifest = readFileSync(manifestPath, 'utf-8')
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    window.eval(`${stripEsm(core)}\nglobalThis.µ = µ;\n${stripEsm(manifestSync(manifest))}`)

    assert.ok(window.µ, 'µ doit être exposé globalement')
    assert.ok(window.µ.modal && typeof window.µ.modal.fire === 'function', 'µ.modal.fire doit exister (module réellement bundlé)')
    // µ._runtimeLabels porte désormais TOUTES les langues (plus une forme plate)
    assert.equal(window.µ._runtimeLabels.fr.modal.ok, 'OK', 'manifest réellement appliqué')

    window.µ.config.confirm = true
    const p = window.µ.confirm('Sûr ?')
    assert.ok(p && typeof p.then === 'function', 'µ.confirm doit retourner une promesse quand config.confirm=true')

    const box = document.body.querySelector('.mjs-modal-box')
    assert.ok(box, 'la VRAIE modale doit être insérée dans le document')
    assert.equal(box.querySelector('.mjs-modal-content').textContent, 'Sûr ?', 'le message transmis à µ.confirm doit apparaître dans la modale')

    box.querySelector('.mjs-modal-confirm').click()
    const result = await p
    assert.equal(result, true, 'µ.confirm doit résoudre exactement le booléen (pas l\'objet {isConfirmed,...} brut)')
    assertAbsent(document.body.querySelector('.mjs-modal-box'), 'la modale doit être retirée après résolution')
  })

  it('core + manifest compilés (build fr par défaut) : le titre du toast suit la langue AFFICHÉE (<html lang>), pas la langue figée au build', async function () {
    const { outDir, manifestPath } = await buildProject({})
    const core = readFileSync(join(outDir, readdirSync(outDir).find((f) => /^mjs_core-/.test(f))!), 'utf-8')
    const manifest = readFileSync(manifestPath, 'utf-8')
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    window.eval(`${stripEsm(core)}\nglobalThis.µ = µ;\n${stripEsm(manifestSync(manifest))}`)

    document.documentElement.lang = 'en'
    window.µ.modal.notify('x', { type: 'error' })
    assert.equal(document.body.querySelector('.mjs-toast-title').textContent, 'Error', 'build fr par défaut, mais affichage anglais')

    document.documentElement.lang = 'fr'
    window.µ.modal.notify('y', { type: 'error' })
    const titres = Array.from(document.body.querySelectorAll('.mjs-toast-title')).map((el: any) => el.textContent)
    assert.deepEqual(titres, ['Error', 'Erreur'], 'le 1er toast garde son titre déjà rendu, le 2e suit la nouvelle langue affichée')
  })

  it("µ.config.confirm=true mais runtime = ['ujs'] SANS 'modal' : repli window.confirm, pas de crash", async function () {
    const { outDir, manifestPath } = await buildProject({ runtime: ['ujs'] })
    const core = readFileSync(join(outDir, readdirSync(outDir).find((f) => /^mjs_core-/.test(f))!), 'utf-8')
    const manifest = readFileSync(manifestPath, 'utf-8')
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')

    const window: any = new Window({ url: 'http://localhost/' })
    window.eval(`${stripEsm(core)}\nglobalThis.µ = µ;\n${stripEsm(manifestSync(manifest))}`)
    assert.equal(window.µ.modal, undefined, "précondition : 'modal' n'est pas dans ce build")

    let confirmCalls = 0
    window.confirm = () => { confirmCalls++; return true }
    window.µ.config.confirm = true
    const warnCalls: any[] = []
    window.µ.warn = (...a: any[]) => warnCalls.push(a)

    const res = window.µ.confirm('Sûr ?')
    assert.equal(res, true, 'repli synchrone sur window.confirm (pas de µ.modal disponible)')
    assert.equal(confirmCalls, 1)
    assert.equal(warnCalls.length, 1)
    assert.match(warnCalls[0][0], /µ\.modal/)
  })
})
