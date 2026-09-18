// Le dictionnaire i18n du PROJET peut surcharger les libellés du runtime
// (toasts, modale…) par des clés RACINE réservées `mjs.<groupe>.<clé>` (mjs_init.ts µ._mjs_label,
// mjs_i18n.ts µ._mjs_i18nLookup) — utile pour un projet dans une langue absente de la table fr/en du
// framework (ici l'allemand), ou pour changer un seul mot sans toucher src/runtime-labels.ts.
// Build RÉEL (pas de simulacre du contrat runtime) : patron Bundler + happy-dom de
// tests/i18n-e2e.test.ts / tests/mjs-modal-bundler-integration.test.ts — `ssrScopeFile`/
// `topoSortFiles` pour isoler chaque fichier compilé dans sa PROPRE portée (comme le vrai ESM),
// `mjsTmp()` pour un dossier temporaire nettoyé automatiquement. Un seul composant trivial, SANS
// `@i18n` (les clés `mjs.*` vivent dans le dictionnaire RACINE, embarqué au build — aucun fetch de
// section à stuber ici).
//
// Scénario couvert :
//   i18n/fr.json = { mjs: { toast: { success: 'Bravo' } } }   — surcharge du toast succès
//   i18n/en.json = { titre: 'Welcome' }                       — AUCUNE surcharge mjs.*
//   i18n/de.json = { mjs: { toast: { success: 'Erfolg' } } }  — allemand, absent de la table framework
//   config i18n.default = 'fr'                                — langue de repli du build

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { stripEsm, fileToId, ssrScopeFile, topoSortFiles } from '../src/server/renderToString.js'
import { mjsTmp } from './helpers/tmp.js'
import { i18nBootLines } from './helpers/i18n-eval.js'

function seedI18nDict(srcDir: string): void {
  const i18nDir = join(srcDir, 'i18n')
  mkdirSync(i18nDir, { recursive: true })
  writeFileSync(join(i18nDir, 'fr.json'), JSON.stringify({ mjs: { toast: { success: 'Bravo' } } }))
  writeFileSync(join(i18nDir, 'en.json'), JSON.stringify({ titre: 'Welcome' }))
  writeFileSync(join(i18nDir, 'de.json'), JSON.stringify({ mjs: { toast: { success: 'Erfolg' } } }))
}

// Compile un projet frais (dossier `mjsTmp` isolé, un seul composant TRIVIAL, sans rapport avec le
// scénario — juste un point d'entrée .mjs, même patron que tests/mjs-modal-bundler-integration.test.ts)
// puis charge core + manifest RÉELLEMENT compilés dans une Window happy-dom neuve.
async function setupProject(): Promise<{ window: any; document: any }> {
  const root = mjsTmp('labels-surcharge')
  const srcDir = join(root, 'app')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  seedI18nDict(srcDir)
  writeFileSync(join(srcDir, 'hop.mjs'), '<p>hop</p>\n')

  const bundler = new Bundler({
    sourceDir: srcDir,
    outputDir: outDir,
    manifestPath: join(root, 'bundle.js'),
    i18n: { default: 'fr' },
  } as any)
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document

  const files = readdirSync(outDir).filter((f: string) => f.endsWith('.js'))
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
  // cascade de modules — bundle.js n'importe plus le cœur STATIQUEMENT : son corps
  // (µ.paths = …; µ._i18nData = …; …) vit désormais DANS un `.then(async ({ µ }) => {…})`,
  // gardé par un VRAI `import(µCore)` dynamique (cf. writeManifest, bundler/index.ts) — que
  // `stripEsm` laisse volontairement intact (ce n'est pas un import STATIQUE). Cet
  // `import()` ne résoudrait JAMAIS ici (chemin web `bundler.urlPrefix`, aucun serveur ni
  // fichier réel à cette URL dans ce harnais synthétique) : le corps du `.then()` ne
  // tournerait donc jamais, `µ._i18nData`/`µ.paths` resteraient inertes. On extrait le
  // PRÉFIXE (µCore/µPaths/µDeps + bloc modulepreload) et le CORPS séparément, évalués tels
  // quels dans la MÊME portée que le cœur — jamais l'`import()` lui-même.
  const rawManifest = readFileSync(join(root, 'bundle.js'), 'utf-8')
  const bodyStart = rawManifest.indexOf('const µReady = ')
  const bodyMatch = rawManifest.match(/const µReady = import\(µCore\)\.then\(async \(\{ µ \}\) => \{\n([\s\S]*)\n\}\);\nif \(typeof window/)
  assert.ok(bodyMatch, `corps du manifeste introuvable (forme inattendue de writeManifest) :\n${rawManifest}`)
  const manifestSrc = [
    stripEsm(rawManifest.slice(0, bodyStart)),
    bodyMatch![1],
  ].join('\n').replace(/window\.µ\s*=\s*µ;?/, '')
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))

  // Composants restants (ici : le seul `hop.mjs` compilé) — chacun dans sa PROPRE IIFE via
  // `ssrScopeFile` (portée réelle façon ESM), topo-triés par dépendances. Même nécessité qu'en
  // build minifié (cf. l'en-tête de tests/i18n-e2e.test.ts) : jamais de concaténation à plat.
  const otherFiles = files.filter((f: string) => f !== coreFile)
  const idByFile = new Map(otherFiles.map((f: string) => [f, fileToId(f)]))
  const resolve = (url: string): string | null => idByFile.get(url.split('/').pop() || '') ?? null
  const scoped = otherFiles.map((f: string) => {
    const id = idByFile.get(f)!
    const { code, deps } = ssrScopeFile(readFileSync(join(outDir, f), 'utf-8'), id, resolve)
    return { f, id, code, deps }
  })
  const depsById = new Map(scoped.map((s: any) => [s.id, s.deps]))
  const idToFile = new Map(scoped.map((s: any) => [s.id, s.f]))
  const codeById = new Map(scoped.map((s: any) => [s.id, s.code]))
  const sortedIds = topoSortFiles(scoped.map((s: any) => s.id), depsById, idToFile)
  const componentCode = sortedIds.map((id: string) => codeById.get(id)!).join('\n')

  // fichiers de langue semés juste après le corps du manifeste (aucun résolveur ESM dans
  // un `eval()` de script classique) — cf. tests/helpers/i18n-eval.ts.
  window.eval(`${coreCode}\n${i18nBootLines(join(root, 'bundle.js'), outDir)}\n${manifestSrc}\nglobalThis.µ = µ;\n${componentCode}`)
  return { window, document }
}

// titres de TOUS les toasts actuellement affichés, dans l'ordre de création — jamais les nœuds
// eux-mêmes (assertion sur un tableau de chaînes uniquement, cf. règle du projet).
function toastTitles(document: any): string[] {
  return Array.from(document.body.querySelectorAll('.mjs-toast-title')).map((el: any) => el.textContent)
}

describe('mjs_init/mjs_i18n — dictionnaire du PROJET surcharge les libellés du runtime (build RÉEL)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it("(1) boot fr : mjs.toast.success surchargé par i18n/fr.json → 'Bravo' (le projet gagne sur « Succès »)", async function () {
    const { window, document } = await setupProject()
    window.µ.modal.notify('x', { type: 'success' })
    assert.deepEqual(toastTitles(document), ['Bravo'])
  })

  it("(2) __mjsLang='en' PUIS toast DANS LE MÊME TICK → 'Success' (langue demandée, table en)", async function () {
    const { window, document } = await setupProject()
    window.µ._storeSet('__mjsLang', 'en')
    window.µ.modal.notify('y', { type: 'success' })
    assert.deepEqual(toastTitles(document), ['Success'], "i18n/en.json n'a AUCUNE clé mjs.* : ne doit surtout pas hériter de l'override français du projet")
  })

  it("(3) __mjsLang='de' : mjs.toast.success surchargé ('Erfolg') ; mjs.toast.error absent partout (de ET fr projet) → repli sur la langue de repli du build (fr) → 'Erreur'", async function () {
    const { window, document } = await setupProject()
    window.µ._storeSet('__mjsLang', 'de')
    window.µ.modal.notify('a', { type: 'success' })
    window.µ.modal.notify('b', { type: 'error' })
    assert.deepEqual(toastTitles(document), ['Erfolg', 'Erreur'])
  })

  it("(4) µ.modal.fire en fr, sans surcharge dans le dictionnaire projet : bouton annuler 'Annuler' (aucune régression)", async function () {
    const { window, document } = await setupProject()
    window.µ.modal.fire({ text: 'x', showCancelButton: true })
    assert.equal(document.body.querySelector('.mjs-modal-cancel').textContent, 'Annuler')
  })
})
