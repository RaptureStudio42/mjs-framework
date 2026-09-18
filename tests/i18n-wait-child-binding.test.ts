// i18n `placeholder: wait` + liaison two-way vers un composant enfant qui EXIGE sa
// prop au montage (`µmount ->` garde, cf. src/core-modules/color.mjs) : cas réel
// (`showcase-theme-editor.mjs`, `<@color value=!{$panel} editable>`) — le PREMIER rendu réel du
// parent n'arrive qu'à la résolution du fragment i18n (gel `_mjs_i18n_hold`, mjs_element.ts), donc
// APRÈS que le parent soit déjà CONNECTÉ (shadow root déjà attaché au document) : la création de
// l'enfant lors de ce rendu différé l'insère directement dans un arbre DÉJÀ LIVE.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { stripEsm, fileToId, ssrScopeFile, topoSortFiles } from '../src/server/renderToString.js'
import { mjsTmp } from './helpers/tmp.js'
import { i18nBootLines } from './helpers/i18n-eval.js'

describe("i18n wait + liaison two-way vers un enfant qui exige sa prop au montage", function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it("le composant enfant reçoit sa valeur AVANT µmount, même sur le rendu différé par l'attente i18n", async () => {
    const root = mjsTmp('i18n-wait-child')
    const srcDir = join(root, 'app')
    const outDir = join(root, 'out')
    mkdirSync(join(srcDir, 'i18n', 'fr'), { recursive: true })
    writeFileSync(join(srcDir, 'i18n', 'fr.yml'), 'titre: Bienvenue\n')
    writeFileSync(join(srcDir, 'i18n', 'fr', 'panel.yml'), 'label: Panneau\n')

    writeFileSync(join(srcDir, 'pickerchild.mjs'), `
<script>
  $value = ''

  µmount ->
    µ.error('[pickerchild] value requis') unless $value
</script>

<span class="v">{$value}</span>
`)
    writeFileSync(join(srcDir, 'waitparent.mjs'), `
@i18n 'panel'

<script>
  $panel = '#112233'
</script>

<p class="t">{µt('label')}</p>
<@pickerchild value=!{$panel}>
`)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
      i18n: { default: 'fr', placeholder: 'wait' },
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const errors: any[] = []
    window.console.error = (...args: any[]) => { errors.push(args.join(' ')) }

    let resolveFetch: (v: any) => void = () => {}
    const fetchGate = new Promise((r) => { resolveFetch = r })
    window.fetch = async (url: string) => {
      await fetchGate
      const m = url.match(/\/i18n\/([^/]+)\/([^/]+\.json)$/)!
      return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(join(outDir, 'i18n', m[1], m[2]), 'utf-8')) }
    }

    const files = readdirSync(outDir).filter((f: string) => f.endsWith('.js'))
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
    // cascade de modules — bundle.js n'importe plus le cœur STATIQUEMENT : son corps
    // (µ.paths = …; µ._i18nData = …; …) vit dans un `.then(async ({ µ }) => {…})` gardé par
    // un VRAI `import(µCore)` dynamique (cf. writeManifest, bundler/index.ts), que `stripEsm`
    // laisse volontairement intact (pas un import STATIQUE). Cet `import()` ne résoudrait
    // JAMAIS ici (chemin web, aucun serveur/fichier réel à cette URL dans ce harnais
    // synthétique) : préfixe (µCore/µPaths/µDeps + préchargement) et corps extraits
    // séparément, évalués tels quels — jamais l'`import()` lui-même.
    const rawManifest = readFileSync(join(root, 'bundle.js'), 'utf-8')
    const bodyStart = rawManifest.indexOf('const µReady = ')
    const bodyMatch = rawManifest.match(/const µReady = import\(µCore\)\.then\(async \(\{ µ \}\) => \{\n([\s\S]*)\n\}\);\nif \(typeof window/)
    assert.ok(bodyMatch, `corps du manifeste introuvable (forme inattendue de writeManifest) :\n${rawManifest}`)
    const manifestSrc = [
      stripEsm(rawManifest.slice(0, bodyStart)),
      bodyMatch![1],
    ].join('\n').replace(/window\.µ\s*=\s*µ;?/, '')
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))
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

    // Composant déjà CONNECTÉ dans le document AVANT la résolution du fragment i18n (gel `wait`).
    document.body.insertAdjacentHTML('beforeend', '<mjs-waitparent></mjs-waitparent>')
    const el = document.body.querySelector('mjs-waitparent')
    await new Promise(r => setTimeout(r, 30))
    assert.equal((el._shadow.querySelector('p.t')?.textContent ?? '').trim(), '', 'rien de rendu avant résolution (mode wait)')

    resolveFetch!(null)
    await new Promise(r => setTimeout(r, 60))

    assert.equal(el._shadow.querySelector('p.t').textContent.trim(), 'Panneau', 'fragment i18n arrivé, parent rendu')
    const child = el._shadow.querySelector('mjs-pickerchild')
    assert.ok(child, "l'enfant a bien été créé par le rendu différé")
    assert.equal(child._shadow.querySelector('span.v').textContent.trim(), '#112233', "l'enfant affiche la valeur two-way — pas vide")
    assert.deepEqual(errors, [], `AUCUNE erreur µ.error au montage de l'enfant (garde value-requis) — reçues : ${JSON.stringify(errors)}`)
  })
})
