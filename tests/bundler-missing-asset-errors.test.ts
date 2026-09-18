// Régression — 2 défauts liés (motif
// dominant de tout ce volet : « erreur avalée → build vert ») :
//
//   1. `preResolveAssets`/`resolveMagicAssets` ne reconnaissaient QUE la
//      forme `µasset`/`µ.asset` — un projet configuré en sigil 'mjs'
//      (`mjs.asset('X')`) ne voyait jamais son asset pré-résolu : le
//      transpiler (qui, lui, connaît le sigil configuré et NORMALISE
//      `mjs.asset` → `µ.asset` avant de chercher dans le dict) ne trouvait
//      rien dans un dict qui n'avait jamais reçu l'entrée, et retombait sur
//      le placeholder `/MISSING_MJS_ASSET:X` — qui survivait jusqu'au
//      fichier écrit sur disque, SANS AUCUNE erreur ni warning.
//
//   2. Plus largement : un asset RÉFÉRENCÉ mais ABSENT du disque (typo de
//      chemin, fichier jamais ajouté) produisait le MÊME placeholder
//      silencieux — build VERT (stats.errors vide) avec un lien/image cassé
//      livré en prod, découvert seulement par un utilisateur qui clique
//      dessus.
//
// Fix : (a) `preResolveAssets`/`resolveMagicAssets` reconnaissent aussi
// `mjs.asset(...)`. (b) `resolveMagicAssets` — dernier point de passage avant
// minify+écriture pour tout le contenu compilé — throw désormais si un
// placeholder `/MISSING_MJS_ASSET:` survit, remonté par l'appelant dans
// `stats.errors` : plus jamais de build vert avec un asset cassé.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject() {
  const root = mjsTmp('missing-asset')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { srcDir, outDir, manifest: join(root, 'bundle.js') }
}

describe('bundler — assets : sigil mjs.asset() reconnu, asset manquant = erreur de build', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("mjs.asset('X') (sigil alternatif) est pré-résolu — pas de MISSING_MJS_ASSET dans la sortie", async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'logo.png'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<script lang="coffee">',
      "  path = mjs.asset('logo.png')",
      '</script>',
      '<p>{path}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, sigil: 'mjs' })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const compFile = readdirSync(outDir).find((f) => /^comp-/.test(f))!
    assert.ok(compFile, 'comp-<hash>.js doit exister')
    const content = readFileSync(join(outDir, compFile), 'utf8')
    assert.doesNotMatch(
      content, /MISSING_MJS_ASSET/,
      "AVANT le fix : mjs.asset() n'était jamais pré-résolu par le bundler → placeholder figé dans la sortie, build vert",
    )
  })

  it('un asset référencé mais ABSENT du disque devient une ERREUR de build (pas un build vert avec placeholder cassé)', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    // AUCUN fichier 'missing.png' créé.
    writeFileSync(join(srcDir, 'comp2.mjs'), [
      '<script lang="coffee">',
      "  path = µasset('missing.png')",
      '</script>',
      '<p>{path}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(
      stats.errors.length > 0,
      "AVANT le fix : un asset manquant produisait un build VERT (0 erreur) avec un placeholder /MISSING_MJS_ASSET cassé écrit sur disque",
    )
    assert.match(stats.errors.map((e) => e.message).join('\n'), /missing\.png/)

    // Le fichier ne doit pas non plus être publié dans le manifest avec un
    // placeholder cassé.
    const compFile = readdirSync(outDir).find((f) => /^comp2-/.test(f))
    if (compFile) {
      const content = readFileSync(join(outDir, compFile), 'utf8')
      assert.doesNotMatch(content, /MISSING_MJS_ASSET/, 'si un fichier existe malgré tout, il ne doit pas contenir le placeholder cassé')
    }
  })

  it('un asset EXISTANT (µasset classique) continue de fonctionner normalement', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'icon.svg'), '<svg></svg>')
    writeFileSync(join(srcDir, 'comp3.mjs'), [
      '<script lang="coffee">',
      "  path = µasset('icon.svg')",
      '</script>',
      '<p>{path}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e) => e.message).join('\n'))
  })

  // Régression : `µasset('../…')`
  // résolvait HORS sourceDir puis COPIAIT le fichier ciblé dans outputDir
  // (exfiltration si les sources ne sont pas 100% de confiance). Confinement
  // strict sous sourceDir → traité comme « asset introuvable », jamais copié.
  it("µasset('../…') (path traversal hors sourceDir) est bloqué : erreur, fichier JAMAIS copié", async function () {
    const { srcDir, outDir, manifest } = makeProject()
    // Fichier secret HORS sourceDir (dans le parent de src/).
    const parent = join(srcDir, '..')
    writeFileSync(join(parent, 'secret.txt'), 'TOP SECRET')
    writeFileSync(join(srcDir, 'evil.mjs'), [
      '<script lang="coffee">',
      "  path = µasset('../secret.txt')",
      '</script>',
      '<p>{path}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0,
      'un path traversal doit être refusé (asset introuvable), pas résolu silencieusement')
    // Le secret ne doit JAMAIS avoir été copié dans outputDir.
    const copied = readdirSync(outDir).filter((f) => /^secret-/.test(f))
    assert.equal(copied.length, 0,
      `AVANT le fix : '../secret.txt' était résolu HORS sourceDir et COPIÉ dans outputDir. trouvé: ${copied.join(', ')}`)

    await bundler.close()
  })

  // Régression : un correctif précédent a
  // rendu FATAL tout placeholder /MISSING_MJS_ASSET survivant. Mais un
  // `µasset('…')` AFFICHÉ en EXEMPLE dans un `<pre>`/`<code>` de doc/tuto (pas
  // une vraie référence) était extrait, résolu (fichier absent → placeholder),
  // puis cassait TOUT le build. Fix : masquer `<pre>`/`<code>` en preResolveAssets
  // ET dans le scan fatal — un placeholder confiné dans un bloc de code ne fait
  // plus échouer le build. Un vrai asset manquant HORS `<pre>` reste fatal.
  it("un µasset('…') affiché en EXEMPLE dans un <pre> de doc ne casse PAS le build", async function () {
    const { srcDir, outDir, manifest } = makeProject()
    // Fichier INEXISTANT, mais dans un <pre> = simple exemple de code montré au lecteur.
    writeFileSync(join(srcDir, 'lesson.mjs'), [
      '<p>Pour un asset local :</p>',
      "<pre>img src=µasset('images/nonexistent.png')</pre>",
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0,
      `AVANT le fix : un µasset() affiché en exemple dans un <pre> était résolu → placeholder → cassait TOUT le build. errors:\n${stats.errors.map((e) => e.message).join('\n')}`)

    await bundler.close()
  })
})
