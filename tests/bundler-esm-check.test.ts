// Test de régression — garde-fou « build vert qui ment » (incident app cliente) :
// une parenthèse orpheline compilée (RHS entièrement
// parenthésé, V0.1.1) passait le build SANS AUCUNE erreur (`stats.errors`
// vide) et ne cassait qu'à l'import navigateur, silencieusement — 7 gabarits
// morts au rendu chez l'utilisateur, découverts après coup.
//
// Fix : `assertValidEsm` (bundler/index.ts) parse CHAQUE JS émis via acorn
// (`ecmaVersion: 'latest', sourceType: 'module'`) — au point d'écriture
// unique `writeHashed()` (tout JS hashé, quel que soit le site d'appel) ET au
// point d'écriture du manifeste (`writeManifest()`, `bundle_modular.js`).
// Toute syntaxe ESM invalide fait désormais throw AVANT écriture disque, avec
// fichier:ligne:colonne + la ligne fautive — même esprit que
// `[bundler/minify]` (minify.ts:152).
//
// MISE À JOUR (mandat app cliente) — la CAUSE RACINE de ce motif
// précis (deep-set d'un store singleton dont le RHS est ENTIÈREMENT
// parenthésé) a ENSUITE été corrigée À LA SOURCE (`closeRhs()`,
// src/generator/path-tracker.ts : acorn exclut les parenthèses redondantes de
// `node.right` mais les CONSOMME dans `node.end` — l'écart `[right.end,
// node.end)`, avant, n'était écrasé nulle part). Le test « fixture V0.1.1 »
// ci-dessous est donc désormais un test de NON-RÉGRESSION du fix RACINE
// (build vert, sortie ESM valide, comportement runtime correct) — le
// garde-fou `assertValidEsm`, LUI, continue de tourner sur des motifs
// synthétiques délibérément cassés (les 4 autres `it` de ce fichier).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import * as acorn from 'acorn'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — assertValidEsm : garde-fou ESM sur chaque JS émis (incident app cliente)', function () {
  this.timeout(15000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('writeHashed(.js) avec du JS syntaxiquement VALIDE : aucun throw', function () {
    const root = mjsTmp('esm-check-valid')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    assert.doesNotThrow(() => bundler.writeHashed('probe', '.js', 'export const a = 1\n'))
  })

  it('writeHashed(.js) avec une parenthèse orpheline : throw `[bundler/esm-check]` avec fichier, ligne:colonne, et la ligne fautive', function () {
    const root = mjsTmp('esm-check-invalid')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    assert.throws(
      () => bundler.writeHashed('probe', '.js', 'const a = foo())\n'),
      (err: any) => {
        assert.match(err.message, /\[bundler\/esm-check\]/, 'préfixe orientant attendu')
        assert.match(err.message, /probe\.js/, 'nom du fichier émis cité')
        assert.match(err.message, /:\d+:\d+/, 'position ligne:colonne attendue')
        assert.match(err.message, /const a = foo\(\)\)/, 'la ligne fautive doit être citée')
        return true
      }
    )
  })

  it('writeHashed(.css) avec du texte invalide en JS : AUCUN throw (garde scopée .js uniquement)', function () {
    const root = mjsTmp('esm-check-nonjs')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    assert.doesNotThrow(() => bundler.writeHashed('style-probe', '.css', 'const a = foo())\n'), 'un .css invalide en JS ne doit JAMAIS passer par assertValidEsm')
  })

  it("intégration — fixture V0.1.1 (RHS entièrement parenthésé d'un store singleton) : build VERT, sortie ESM valide, et le `+1` s'applique bien UNE SEULE fois à l'exécution (0→1)", async function () {
    const root = mjsTmp('esm-check-v011')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    // Motif V0.1.1 (assignation deep-set d'un store singleton dont le RHS est
    // ENTIÈREMENT parenthésé) : AVANT le fix racine (`closeRhs()`,
    // path-tracker.ts), le generator émettait une parenthèse fermante
    // orpheline dans ce JS et `stats.errors` restait vide (build vert qui
    // ment). Le fix racine étant désormais livré, ce composant doit compiler
    // PROPREMENT et se comporter correctement à l'exécution.
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<script>',
      '$$boot = {wallet: {coins: 0}}',
      '$$boot.wallet.coins = (($$boot.wallet.coins or 0) + 1)',
      '</script>',
      '<p>{$$boot.wallet.coins}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, 'build VERT attendu (fix racine livré) : '+ stats.errors.map(e => e.message).join('\n'))

    // Sortie ESM valide : acorn parse le JS du composant émis — vérifié ici
    // EXPLICITEMENT, en plus de l'absence d'erreur de build (qui, elle,
    // passe déjà par ce même parse via assertValidEsm).
    const files = readdirSync(outDir)
    const compFile = files.find((f) => /^comp-/.test(f))
    assert.ok(compFile, 'le composant doit avoir été émis')
    const compSource = readFileSync(join(outDir, compFile), 'utf-8')
    assert.doesNotThrow(() => acorn.parse(compSource, { ecmaVersion: 'latest', sourceType: 'module' }), 'sortie JS invalide (parenthèse orpheline ?)')

    // Comportement runtime : monte le composant en happy-dom (même harnais que
    // les tests runtime voisins, ex. event-delegation.test.ts) et vérifie que
    // le `+1` s'applique bien UNE SEULE fois (0→1, pas 0→2 ni 0→0).
    const coreFile = files.find((f) => /^mjs_core-/.test(f))
    assert.ok(coreFile, 'le core doit avoir été émis')
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))
    const compCode = stripEsm(compSource)

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
    document.body.innerHTML = '<mjs-comp></mjs-comp>'
    const el = document.body.firstElementChild
    await new Promise((r) => setTimeout(r, 100))

    assert.equal(window.eval('µ.store.boot.wallet.coins'), 1, "le `+1` doit s'appliquer UNE SEULE fois : 0 → 1")
    assert.equal(el._shadow.querySelector('p')?.textContent, '1', 'le rendu doit refléter la même valeur')

    try { window.close?.() } catch (_e) { /* ignore */ }
    await bundler.close()
  })

  // Le garde-fou ci-dessus (assertValidEsm,
  // scope JS COMPILÉ par le bundler) laissait un 2e trou : resolveOneAsset(),
  // branche « Binaires : copie raw avec hash » (tout ext hors .civet/.coffee/.mjs),
  // copiait un `.js` référencé en asset brut via µasset() SANS AUCUNE validation.
  // Fix : assertParsableJs (dual-parse module PUIS script — un vendor n'est pas
  // forcément ESM) appelée dans cette branche avant écriture.
  it("intégration — vendor .js CASSÉ copié RAW via µasset() (branche « Binaires » de resolveOneAsset, trou débusqué) : le build échoue désormais, jamais stats.errors vide", async function () {
    const root = mjsTmp('esm-check-asset-broken')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // AVANT le fix : resolveOneAsset() copiait ce .js tel quel, stats.errors
    // restait vide — build vert qui ment.
    writeFileSync(join(srcDir, 'vendor-broken.js'), 'function broken( {\n  return 1\n')
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<script>',
      "$lien = µasset('vendor-broken.js')",
      '</script>',
      '<p>{$lien}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0, 'AVANT le fix : ce vendor .js cassé était copié tel quel par resolveOneAsset, stats.errors restait vide (build vert qui ment)')
    const messages = stats.errors.map((e) => e.message).join('\n')
    assert.match(messages, /\[bundler\/esm-check\]/, "l'erreur doit venir du garde-fou ESM")
    assert.match(messages, /vendor-broken/, 'le nom du vendor fautif doit être cité')
    await bundler.close()
  })

  it("intégration — vendor .js NON-ESM mais VALIDE en script classique (`with`) référencé via µasset() : tolérance dual-parse, build vert, fichier copié tel quel", async function () {
    const root = mjsTmp('esm-check-asset-with')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    // `with` : SyntaxError en module strict, valide en script classique — un
    // vendor UMD/legacy légitime ne doit pas être rejeté par une garde ESM
    // strict-only.
    writeFileSync(join(srcDir, 'vendor-with.js'), 'with ({}) {}\n')
    writeFileSync(join(srcDir, 'comp2.mjs'), [
      '<script>',
      "$lien = µasset('vendor-with.js')",
      '</script>',
      '<p>{$lien}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, stats.errors.map((e) => e.message).join('\n'))
    const copied = readdirSync(outDir).some((f) => /^vendor-with-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(copied, 'le vendor .js valide en script classique doit être copié tel quel dans outputDir')
    await bundler.close()
  })
})
