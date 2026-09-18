// Test de régression — levée des 2 limitations documentées dans
// ssr-topo-sort-cycle-detection.test.ts (commentaire en tête) pour les
// modules autonomes `.module.civet` (`.civet`/`.coffee` compilés seuls,
// hors `.mjs` composant, via `_compileScriptModuleInner`) :
//
//   1. `@import` À L'INTÉRIEUR d'un module autonome n'était pas reconnu
//      (Civet le parsait littéralement comme `this.import(...)`, absurde) —
//      même canal que les composants .mjs désormais (extractDirectives).
//
//   2. Un `import {x} from './y.module.civet'` NATIF dans un module
//      compilait tel quel SANS réécriture vers le nom haché → variable
//      `undefined` en prod, silencieusement, même sans circularité.
//      Décision de design : pas de réécriture — REJET explicite, un seul
//      canal d'import partout (`@import nom 'chemin'`), même garde que les
//      composants .mjs (`lintNoRawImport`).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { renderToString } from '../src/server/renderToString.js'
import { mjsTmp } from './helpers/tmp.js'

// PORTABILITÉ Node ≥ 22 : les .js émis sont de l'ESM, mais le dossier de sortie est
// un tmp SANS package.json — Node les prend alors pour du CommonJS, détecte l'ESM et
// repasse par `require(esm)`, chemin qui refuse les graphes A→B→C (ERR_REQUIRE_CYCLE_
// MODULE). Un projet réel a toujours un package.json ; on le pose donc ici aussi
function outDirEsm(outDir: string) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'package.json'), '{"type":"module"}')
}

describe('modules autonomes .module.civet — @import fonctionnel, import natif rejeté', function () {
  this.timeout(30000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("A `@import`e B (2 .module.civet réels sur disque, build bundler) : le JS émis de A référence le nom HACHÉ de B, exécution réelle correcte", async function () {
    const root = mjsTmp('modimport-chain')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    outDirEsm(outDir)

    writeFileSync(join(srcDir, 'b.module.civet'), `export hi = -> 'B'\n`)
    writeFileSync(join(srcDir, 'a.module.civet'), `@import hi 'b.module.civet'\n\nexport greet = -> hi() + '-A'\n`)

    // urlPrefix = outDir (chemin ABSOLU) : le webPath émis par resolveMagicAssets
    // devient alors directement un chemin FILESYSTEM réel — permet d'`import()`
    // dynamiquement le module compilé et de vérifier une exécution RÉELLE (pas
    // juste une inspection textuelle du JS émis).
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), urlPrefix: outDir })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const aPath = bundler.manifest['a.module']
    const bPath = bundler.manifest['b.module']
    assert.ok(aPath, `manifest doit contenir 'a.module' : ${JSON.stringify(Object.keys(bundler.manifest))}`)
    assert.ok(bPath, `manifest doit contenir 'b.module'`)

    const aContent = readFileSync(aPath, 'utf-8')
    assert.ok(aContent.includes(basename(bPath)),
      `le JS émis de A doit référencer le nom HACHÉ de B (${basename(bPath)}). contenu:\n${aContent}`)

    const mod: any = await import(pathToFileURL(aPath).href)
    assert.equal(mod.greet(), 'B-A', "exécution réelle : greet() = hi() + '-A' = 'B-A' (ordre/résolution corrects)")

    await bundler.close()
  })

  it("un composant .mjs `@import`e A qui `@import`e B : chaîne complète OK en SSR (non-régression du canal .mjs existant)", async function () {
    const src = mjsTmp('modimport-mjschain')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'core.module.civet'), `export double = (n) -> n * 2\n`)
    writeFileSync(join(src, 'wrapper.module.civet'), `@import double 'core.module.civet'\n\nexport quad = (n) -> double(double(n))\n`)
    writeFileSync(join(src, 'page.mjs'), `@import quad 'wrapper.module.civet'\n\n<p class="r">{quad(3)}</p>\n`)

    const res = await renderToString({ sourceDir: src, tag: 'mjs-page' })
    assert.match(res.html, />12</, "quad(3) = double(double(3)) = 12 : chaîne .mjs → .civet → .civet résolue correctement en SSR")
  })

  it("import natif `import {x} from './b.module.civet'` dans un module → erreur de compilation explicite orientant vers @import", async function () {
    const root = mjsTmp('modimport-rawimport')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'b.module.civet'), `export hi = -> 'B'\n`)
    writeFileSync(join(srcDir, 'a.module.civet'), `import { hi } from './b.module.civet'\n\nexport greet = -> hi() + '-A'\n`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0, 'un import ES natif doit être rejeté à la compilation (jamais une variable undefined silencieuse)')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /import ES classique/)
    assert.match(msg, /@import/, "le message doit orienter vers `@import nom 'chemin'`")
    await bundler.close()
  })

  it('`@import §§X` (ancienne écriture du singleton réactif exporté) dans un module → erreur explicite (réservé aux composants .mjs)', async function () {
    const root = mjsTmp('modimport-singleton')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'b.module.civet'), `export hi = -> 'B'\n`)
    writeFileSync(join(srcDir, 'a.module.civet'), `@import §§hi 'b.module.civet'\n\nexport greet = -> hi() + '-A'\n`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0, 'un `@import §§X` doit être rejeté dans un module autonome')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /singleton réactif/)
    assert.match(msg, /composant/i, 'le message doit orienter vers un composant .mjs')
    await bundler.close()
  })

  // garde ÉTENDUE : la forme COURANTE d'import d'un singleton (`µ$$X`)
  // doit être rejetée exactement pareil dans un module (un module fournisseur
  // n'importe pas de singleton, quelle que soit l'écriture, ancienne ou actuelle).
  it('`@import µ$$X` (singleton réactif exporté, forme courante) dans un module → erreur explicite (réservé aux composants .mjs)', async function () {
    const root = mjsTmp('modimport-singleton-mu')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'b.module.civet'), `export hi = -> 'B'\n`)
    writeFileSync(join(srcDir, 'a.module.civet'), `@import µ$$hi 'b.module.civet'\n\nexport greet = -> hi() + '-A'\n`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0, 'un `@import µ$$X` doit être rejeté dans un module autonome')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /singleton réactif/)
    assert.match(msg, /composant/i, 'le message doit orienter vers un composant .mjs')
    await bundler.close()
  })

  it('cycle A↔B via @import → erreur propre, PAS de blocage (timeout court, filet de sécurité compileWithDedup)', async function () {
    const root = mjsTmp('modimport-cycle')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'a.module.civet'), `@import bThing 'b.module.civet'\n\nexport aThing = -> bThing()\n`)
    writeFileSync(join(srcDir, 'b.module.civet'), `@import aThing 'a.module.civet'\n\nexport bThing = -> aThing()\n`)

    // Timeout court (défaut prod : 12000ms) — cf. bundler-compile-dedup-cycle.test.ts,
    // même filet de sécurité (2 fichiers TOUS DEUX top-level, chacun sa propre
    // chaîne racine, invisible à l'autre : seul le timeout de compileWithDedup
    // le rattrape).
    const bundler = new Bundler({
      sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js'),
      dedupWaitTimeoutMs: 300,
    })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      'un cycle @import doit produire une erreur propre, jamais un build silencieusement "réussi" avec un cycle non résolu, ni un hang')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /Cycle @import|bloquée depuis.*probable dépendance circulaire/)
    await bundler.close()
  })

  it("stamp de cache salé avec les @import : B change SEUL (A inchangé) → rebuild incrémental (même instance/cache) → le JS de A référence le NOUVEAU hash de B, plus de cache-hit périmé", async function () {
    const root = mjsTmp('modimport-incr-stale')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    outDirEsm(outDir)

    writeFileSync(join(srcDir, 'b.module.civet'), `export hi = -> 'B1'\n`)
    writeFileSync(join(srcDir, 'a.module.civet'), `@import hi 'b.module.civet'\n\nexport greet = -> hi() + '-A'\n`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), urlPrefix: outDir })

    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const aPath1 = bundler.manifest['a.module']
    const bPath1 = bundler.manifest['b.module']
    const aContent1 = readFileSync(aPath1, 'utf-8')
    assert.ok(aContent1.includes(basename(bPath1)), 'build 1 : A doit référencer le hash initial de B')

    // SEUL B change sur disque — A reste identique octet pour octet.
    writeFileSync(join(srcDir, 'b.module.civet'), `export hi = -> 'B2'\n`)

    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))
    const aPath2 = bundler.manifest['a.module']
    const bPath2 = bundler.manifest['b.module']

    assert.notEqual(bPath2, bPath1, 'B a changé de contenu : son hashedPath doit changer')
    const aContent2 = readFileSync(aPath2, 'utf-8')
    assert.ok(aContent2.includes(basename(bPath2)),
      `le JS émis de A doit référencer le NOUVEAU hash de B (${basename(bPath2)}) après rebuild incrémental. contenu:\n${aContent2}`)
    assert.ok(!aContent2.includes(basename(bPath1)),
      `le JS émis de A ne doit PLUS référencer l'ANCIEN hash de B (${basename(bPath1)}) — cache-hit périmé`)

    // Exécution réelle : greet() doit désormais refléter B2, pas un B1 figé
    // par un cache-hit périmé pointant un fichier disparu.
    const mod: any = await import(pathToFileURL(aPath2).href)
    assert.equal(mod.greet(), 'B2-A', "exécution réelle post-rebuild : greet() = hi() + '-A' = 'B2-A'")

    await bundler.close()
  })

  it("le sel @import est TRANSITIF (A→B→C) : seul C change → B recompile ET A suit (référence le NOUVEAU hash de B, exécution = C2-B-A)", async function () {
    const root = mjsTmp('modimport-transitive')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    outDirEsm(outDir)

    writeFileSync(join(srcDir, 'c.module.civet'), `export leaf = -> 'C1'\n`)
    writeFileSync(join(srcDir, 'b.module.civet'), `@import leaf 'c.module.civet'\n\nexport hi = -> leaf() + '-B'\n`)
    writeFileSync(join(srcDir, 'a.module.civet'), `@import hi 'b.module.civet'\n\nexport greet = -> hi() + '-A'\n`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), urlPrefix: outDir })

    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const aPath1 = bundler.manifest['a.module']
    const bPath1 = bundler.manifest['b.module']

    // SEUL C change — B et A restent identiques octet pour octet.
    writeFileSync(join(srcDir, 'c.module.civet'), `export leaf = -> 'C2'\n`)

    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))
    const aPath2 = bundler.manifest['a.module']
    const bPath2 = bundler.manifest['b.module']

    assert.notEqual(bPath2, bPath1, 'B @import-e C : son hashedPath doit changer (profondeur 1, déjà couvert)')
    assert.notEqual(aPath2, aPath1,
      'A @import-e B (transitivement C) : son hashedPath doit AUSSI changer — sinon cache-hit périmé (bug déjà rencontré)')
    const aContent2 = readFileSync(aPath2, 'utf-8')
    assert.ok(aContent2.includes(basename(bPath2)),
      `le JS émis de A doit référencer le NOUVEAU hash de B (${basename(bPath2)}). contenu:\n${aContent2}`)
    assert.ok(!aContent2.includes(basename(bPath1)),
      `le JS émis de A ne doit PLUS référencer l'ANCIEN hash de B (${basename(bPath1)}) — cache-hit périmé transitif`)

    const mod: any = await import(pathToFileURL(aPath2).href)
    assert.equal(mod.greet(), 'C2-B-A', "exécution réelle : greet() = hi() + '-A' = (leaf()+'-B') + '-A' = 'C2-B-A'")

    await bundler.close()
  })

  it("profondeur 3 (A→B→C→D) : seul D change → toute la chaîne suit (A, B, C recompilent, exécution reflète D2)", async function () {
    const root = mjsTmp('modimport-transitive-depth3')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    outDirEsm(outDir)

    writeFileSync(join(srcDir, 'd.module.civet'), `export leaf = -> 'D1'\n`)
    writeFileSync(join(srcDir, 'c.module.civet'), `@import leaf 'd.module.civet'\n\nexport mid = -> leaf() + '-C'\n`)
    writeFileSync(join(srcDir, 'b.module.civet'), `@import mid 'c.module.civet'\n\nexport hi = -> mid() + '-B'\n`)
    writeFileSync(join(srcDir, 'a.module.civet'), `@import hi 'b.module.civet'\n\nexport greet = -> hi() + '-A'\n`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), urlPrefix: outDir })

    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const aPath1 = bundler.manifest['a.module']

    // SEUL D change, tout en bas de la chaîne à 3 sauts de A.
    writeFileSync(join(srcDir, 'd.module.civet'), `export leaf = -> 'D2'\n`)

    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))
    const aPath2 = bundler.manifest['a.module']

    assert.notEqual(aPath2, aPath1, "A doit recompiler alors que D est à 3 sauts (profondeur 3, pas juste 1 ou 2)")

    const mod: any = await import(pathToFileURL(aPath2).href)
    assert.equal(mod.greet(), 'D2-C-B-A',
      "exécution réelle : greet() = hi() + '-A' = (mid()+'-B') + '-A' = ((leaf()+'-C')+'-B') + '-A' = 'D2-C-B-A'")

    await bundler.close()
  })

  it("côté COMPOSANT (.mjs) : un .mjs @import-e A qui @import-e B, seul B change (même instance Bundler, cache incrémental) → le .mjs recompile et référence le NOUVEAU hash de A (bénéfice partagé de la fermeture transitive)", async function () {
    const root = mjsTmp('modimport-transitive-component')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    outDirEsm(outDir)

    writeFileSync(join(srcDir, 'b.module.civet'), `export leaf = -> 'B1'\n`)
    writeFileSync(join(srcDir, 'a.module.civet'), `@import leaf 'b.module.civet'\n\nexport mid = -> leaf() + '-A'\n`)
    writeFileSync(join(srcDir, 'page.mjs'), `@import mid 'a.module.civet'\n\n<p class="r">{mid()}</p>\n`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), urlPrefix: outDir })

    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const pagePath1 = bundler.manifest['page']
    const aPath1 = bundler.manifest['a.module']
    assert.ok(pagePath1, `manifest doit contenir 'page' : ${JSON.stringify(Object.keys(bundler.manifest))}`)

    // SEUL B change — A et page.mjs restent identiques octet pour octet.
    writeFileSync(join(srcDir, 'b.module.civet'), `export leaf = -> 'B2'\n`)

    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))
    const pagePath2 = bundler.manifest['page']
    const aPath2 = bundler.manifest['a.module']

    assert.notEqual(aPath2, aPath1, 'A @import-e B : son hashedPath doit changer (profondeur 1, déjà couvert)')
    assert.notEqual(pagePath2, pagePath1,
      'page.mjs @import-e A (transitivement B) : son hashedPath doit AUSSI changer — sinon cache-hit périmé côté composant')
    const pageContent2 = readFileSync(pagePath2, 'utf-8')
    assert.ok(pageContent2.includes(basename(aPath2)),
      `le JS émis de page.mjs doit référencer le NOUVEAU hash de A (${basename(aPath2)}). contenu:\n${pageContent2}`)

    await bundler.close()
  })

  it("le sel @import NE casse PAS le cache-hit légitime : un fichier SANS rapport change → A garde le MÊME hashedPath, jamais réécrit", async function () {
    const root = mjsTmp('modimport-incr-unrelated')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    outDirEsm(outDir)

    writeFileSync(join(srcDir, 'b.module.civet'), `export hi = -> 'B'\n`)
    writeFileSync(join(srcDir, 'a.module.civet'), `@import hi 'b.module.civet'\n\nexport greet = -> hi() + '-A'\n`)
    writeFileSync(join(srcDir, 'c.module.civet'), `export unrelated = -> 'C1'\n`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), urlPrefix: outDir })

    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const aPath1 = bundler.manifest['a.module']
    const aMtime1 = statSync(aPath1).mtimeMs

    // Laisse passer un peu de temps réel : si A était (à tort) réécrit, son
    // mtime bougerait forcément par rapport à cette mesure.
    await new Promise((r) => setTimeout(r, 20))

    // C n'a AUCUN rapport avec A (ni @import, ni asset partagé) — seul lui change.
    writeFileSync(join(srcDir, 'c.module.civet'), `export unrelated = -> 'C2'\n`)

    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))
    const aPath2 = bundler.manifest['a.module']
    const aMtime2 = statSync(aPath2).mtimeMs

    assert.equal(aPath2, aPath1, 'A doit garder EXACTEMENT le même hashedPath (cache-hit, pas de recompilation totale à chaque build)')
    assert.equal(aMtime2, aMtime1, "A n'a jamais dû être réécrit sur disque (writeHashed n'est appelé que sur cache MISS)")

    await bundler.close()
  })
})
