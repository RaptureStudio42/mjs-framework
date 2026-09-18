// Test de régression — le build "dit la vérité" quand un composant
// .mjs tombe en échec de compilation. 3 sous-failles du même motif (« erreur
// avalée/masquée → sortie trompeuse ») :
//
//   (a) collectSizes() scannait TOUT outputDir (pas seulement ce qui vient
//       d'être produit) : un composant en échec CE tour (jamais réécrit)
//       réapparaissait dans le tableau des tailles via son ANCIEN fichier
//       hashé, comme s'il venait d'être fraîchement compilé.
//   (b) printBuildReport() (cli.ts) affichait la ligne ✅ même quand
//       stats.errors n'était pas vide — rien ne signalait au premier coup
//       d'œil qu'un composant était cassé.
//   (c) this.manifest repart à `{}` en tête de compile() : un composant en
//       échec perdait DÉFINITIVEMENT son entrée µ.paths, alors que son
//       fichier hashé du build PRÉCÉDENT survit tel quel dans outputDir
//       (cleanupOldHashes ne se déclenche que sur un writeHashed RÉUSSI du
//       même baseName, jamais pour un composant en échec) → le tag
//       <mjs-baseName> restait dans le HTML, son import 404, écran blanc
//       silencieux.
//
// Fix (c) : recoverFailedComponentManifest() repêche l'entrée dans l'ANCIEN
// bundle_modular.js écrit sur disque, si son fichier hashé existe toujours.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { t, setMessagesLang } from '../src/messages/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function makeProject() {
  const root = mjsTmp('failed-component')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { srcDir, outDir, manifest: join(root, 'bundle.js') }
}

describe('bundler — build honnête quand un composant .mjs tombe', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('1er build sain, 2e build avec 1 composant cassé sur 2 : tailles honnêtes (a) + repêchage manifeste + warning (c)', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'good.mjs'), '<p>je compile toujours</p>')
    writeFileSync(join(srcDir, 'logo.png'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(srcDir, 'broken.mjs'), [
      '<script lang="coffee">',
      "  path = µasset('logo.png')",
      '</script>',
      '<p>{path}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })

    // build 1 — tout compile, 'broken' publie normalement son entrée.
    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const oldBrokenPath = stats1.manifest['broken']
    assert.ok(oldBrokenPath, "'broken' doit être dans le manifest du build 1")
    const oldBrokenFilename = oldBrokenPath!.split('/').pop()!
    assert.ok(readdirSync(outDir).includes(oldBrokenFilename), 'le fichier hashé du build 1 doit exister sur disque')

    // build 2 — casse broken.mjs (asset référencé maintenant absent du disque).
    writeFileSync(join(srcDir, 'broken.mjs'), [
      '<script lang="coffee">',
      "  path = µasset('missing-now.png')",
      '</script>',
      '<p>{path}</p>',
    ].join('\n'))
    const stats2 = await bundler.compile()

    assert.ok(stats2.errors.length > 0, 'build 2 doit signaler broken.mjs en échec')

    // (i)/(iv) — 'broken' NE DOIT PAS apparaître dans le tableau des
    // tailles : son ancien fichier est toujours sur disque, mais n'a pas été
    // ÉMIS ce tour (recoverFailedComponentManifest n'appelle jamais writeHashed).
    assert.ok(!stats2.sizes.some(s => s.name === 'broken'),
      `AVANT le fix : le composant en échec réapparaissait dans le tableau des tailles via son ANCIEN fichier survivant. sizes: ${JSON.stringify(stats2.sizes)}`)
    // 'good', lui, a été recompilé ce tour → doit rester présent.
    assert.ok(stats2.sizes.some(s => s.name === 'good'), "'good' (recompilé ce tour) doit rester dans le tableau des tailles")

    // (iii) — le manifest en mémoire ET sur disque contiennent ENCORE
    // l'entrée de l'ancien hash, le fichier hashé existe toujours, et
    // stats.warnings signale la récupération.
    assert.equal(stats2.manifest['broken'], oldBrokenPath,
      "AVANT le fix : l'entrée manifeste de 'broken' disparaissait (this.manifest reparti à {} sans repli) — import 404, écran blanc")
    assert.ok(readdirSync(outDir).includes(oldBrokenFilename), 'le fichier hashé du build 1 doit SURVIVRE (jamais nettoyé, jamais réécrit pour un composant en échec)')
    const manifestOnDisk = readFileSync(manifest, 'utf-8')
    // valeur COMPACTE dans le manifeste publié (préfixe commun factorisé une fois, cf.
    // writeManifest) : c'est le nom du fichier qu'on y retrouve, pas l'URL entière.
    assert.ok(manifestOnDisk.includes(`"broken":"${oldBrokenFilename}"`),
      "l'entrée réinjectée doit SURVIVRE à la génération de publicManifest (writeManifest) — pas juste vivre en mémoire")
    const warningsJoined = stats2.warnings.join('\n')
    assert.match(warningsJoined, /broken/, 'stats.warnings doit mentionner le composant récupéré')
    assert.ok(warningsJoined.includes(oldBrokenFilename), "stats.warnings doit mentionner l'ancien fichier hashé toujours servi")

    await bundler.close()
  })

  it("build cassé SANS ancien bundle (composant cassé DÈS le 1er build) → pas d'entrée, pas de crash, pas de message trompeur (iv)", async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'good.mjs'), '<p>ok</p>')
    // AUCUN 'never-existed.png' créé : l'asset référencé est absent dès le départ,
    // et manifestPath n'existe pas encore (tout premier compile() de ce bundler).
    writeFileSync(join(srcDir, 'broken.mjs'), [
      '<script lang="coffee">',
      "  path = µasset('never-existed.png')",
      '</script>',
      '<p>{path}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0, 'broken.mjs doit échouer dès ce premier build')
    assert.equal(stats.manifest['broken'], undefined,
      "pas d'ancien bundle sur disque → aucun repêchage possible → pas d'entrée (comportement historique, pas de crash)")
    assert.ok(!stats.sizes.some(s => s.name === 'broken'))
    assert.ok(!stats.warnings.some(w => w.includes('ancienne version')),
      "aucune récupération n'a eu lieu → aucun message de repêchage trompeur")

    await bundler.close()
  })

  // (ii) — printBuildReport() n'est pas exportable/importable sans risque
  // (cli.ts exécute son run() top-level avec process.exit() dès l'import : le
  // même choix — lecture de source ciblée plutôt qu'exécution — est déjà établi
  // dans ce dépôt, cf. tests/cli-context-alias-wiring.test.ts).
  it("cli.ts — printBuildReport loggue la clé 'cli.build-rapport-echecs' AVANT 'cli.build-rapport', sous condition stats.errors.length > 0", function () {
    const cliSrc = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf-8')
    const fnStart = cliSrc.indexOf('function printBuildReport')
    assert.ok(fnStart >= 0, 'printBuildReport introuvable dans cli.ts (structure a changé ?)')
    const fnEnd = cliSrc.indexOf('\nconst USAGE', fnStart)
    assert.ok(fnEnd > fnStart, 'fin de printBuildReport introuvable (structure de cli.ts a changé ?)')
    const fnBody = cliSrc.slice(fnStart, fnEnd)

    const idxEchecs = fnBody.indexOf("t('cli.build-rapport-echecs'")
    const idxRapport = fnBody.indexOf("t('cli.build-rapport'")
    assert.ok(idxEchecs >= 0, "appel à la clé 'cli.build-rapport-echecs' introuvable dans printBuildReport")
    assert.ok(idxRapport >= 0, "appel à la clé 'cli.build-rapport' introuvable dans printBuildReport")
    assert.ok(idxEchecs < idxRapport,
      "AVANT le fix : la ligne ✅ ('cli.build-rapport') s'affichait même avec des erreurs, sans ligne ✗ avant elle")
    assert.match(fnBody.slice(0, idxEchecs), /stats\.errors\.length\s*>\s*0/,
      'la ligne ✗ doit être conditionnée à stats.errors.length > 0')
  })

  it("clé catalogue 'cli.build-rapport-echecs' — fr/en, forme « ✗ N … »", function () {
    assert.equal(t('cli.build-rapport-echecs', { nb: 3 }), '✗ 3 en échec')
    setMessagesLang('en')
    try {
      assert.equal(t('cli.build-rapport-echecs', { nb: 3 }), '✗ 3 failed')
    } finally {
      setMessagesLang('fr') // restaure — LANG est un état global partagé entre fichiers de test
    }
  })

  // Régression : this.emittedThisCompile = new Set()
  // vivait ligne ~1040, APRÈS l'étape 1 (bundleRuntime(), qui appelle déjà writeHashed()
  // et marque 'mjs_core-<hash>.js') — le reset l'effaçait aussitôt après coup. Résultat : le
  // runtime disparaissait du tableau des tailles sur TOUT build, pas seulement en cas d'échec
  // (bug plus large que prévu). Fix : reset déplacé AVANT l'étape 1.
  it("build 100% sain (aucune erreur) : 'mjs_core' (runtime) est TOUJOURS dans stats.sizes", async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'good.mjs'), '<p>ok</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const core = stats.sizes.find(s => s.name === 'mjs_core')
    assert.ok(core, `AVANT le fix : 'mjs_core' était TOUJOURS absent de stats.sizes (reset emittedThisCompile après bundleRuntime()) — sizes: ${JSON.stringify(stats.sizes)}`)
    assert.ok(core!.bytes > 0)

    await bundler.close()
  })

  // un composant en échec ne doit PAS voir son ANCIENNE
  // sortie rester référencée dans un `mjs build` : la version repêchée peut importer un
  // `mjs_core-<hash>.js` supprimé depuis, et la page meurt au navigateur alors que le build
  // se termine « vert » (constaté en production sur un cas réel). Le repêchage
  // reste la règle en `dev`/`serve` (site utilisable pendant qu'on corrige une faute de frappe).
  it("keepFailedComponents:false : aucun repêchage, l'entrée disparaît et le message le dit", async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'good.mjs'), '<p>je compile toujours</p>')
    writeFileSync(join(srcDir, 'logo.png'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(srcDir, 'broken.mjs'), ['<script lang="coffee">', "  path = µasset('logo.png')", '</script>', '<p>{path}</p>'].join('\n'))

    const sain = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats1 = await sain.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const ancienChemin = stats1.manifest['broken']
    assert.ok(ancienChemin, "'broken' doit être au manifeste du build sain")
    await sain.close()

    writeFileSync(join(srcDir, 'broken.mjs'), ['<script lang="coffee">', "  path = µasset('missing-now.png')", '</script>', '<p>{path}</p>'].join('\n'))
    const strict = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, keepFailedComponents: false })
    const stats2 = await strict.compile()

    assert.ok(stats2.errors.length > 0, 'le composant cassé doit être une erreur de build')
    assert.equal(stats2.manifest['broken'], undefined, "l'ancienne version ne doit plus être référencée")
    const surDisque = readFileSync(manifest, 'utf-8')
    assert.ok(!surDisque.includes('"broken":'), "le manifeste écrit ne doit plus porter la clé du composant en échec")
    const avertissements = stats2.warnings.join('\n')
    assert.ok(!avertissements.includes('reste servie'), "plus de message « ancienne version reste servie »")
    assert.match(avertissements, /broken/, 'le composant en échec reste nommé')
    assert.ok(stats2.warnings.some(w => w.includes(t('bundler.index.composant-echec-non-repeche', { nom: 'broken' }))), `message dédié attendu, reçu :\n${avertissements}`)

    await strict.close()
  })

  it('par défaut (dev/serve) le repêchage reste actif : rien ne change sans le drapeau', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'logo.png'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(srcDir, 'broken.mjs'), ['<script lang="coffee">', "  path = µasset('logo.png')", '</script>', '<p>{path}</p>'].join('\n'))
    const b = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const s1 = await b.compile()
    const ancien = s1.manifest['broken']
    writeFileSync(join(srcDir, 'broken.mjs'), ['<script lang="coffee">', "  path = µasset('missing-now.png')", '</script>', '<p>{path}</p>'].join('\n'))
    const s2 = await b.compile()
    assert.equal(s2.manifest['broken'], ancien, 'sans le drapeau, le repêchage historique tient')
    await b.close()
  })

  it("cli.ts passe keepFailedComponents:false hors dev/serve", function () {
    const source = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf-8')
    assert.match(source, /keepFailedComponents:\s*[^,\n]*(dev|serve)/, "cli.ts doit transmettre l'option au Bundler en fonction de la commande")
  })

  it("clé catalogue 'bundler.index.composant-echec-non-repeche' présente en fr ET en", function () {
    setMessagesLang('fr')
    const fr = t('bundler.index.composant-echec-non-repeche', { nom: 'x' })
    setMessagesLang('en')
    const en = t('bundler.index.composant-echec-non-repeche', { nom: 'x' })
    setMessagesLang('fr')
    assert.ok(fr.includes('x') && fr.length > 20, `fr inattendu : ${fr}`)
    assert.ok(en.includes('x') && en.length > 20, `en inattendu : ${en}`)
    assert.notEqual(fr, en, 'les deux langues doivent différer')
  })
})
