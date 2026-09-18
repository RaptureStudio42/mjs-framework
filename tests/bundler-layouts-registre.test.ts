// Variants (`<style name="…">`) + registre des variables de thème $$.
//
// Deux mécaniques distinctes, un seul fichier de tests :
//   · TRAVAIL 1 — le build écrit chaque variant dans un fichier satellite STABLE
//     `<outputDir>/<mod>.<nom>.css`, exactement l'URL que le runtime construit lui-même
//     (`${this._mjs_dir}${this._mjs_modName}.${name}.css`, cf. template.ts). Piège vérifié
//     ICI : un rebuild qui change le CONTENU du variant doit RÉÉCRIRE le fichier —
//     `writeFileAtomic` (pensé pour des noms hashés) SKIPPE dès que le fichier existe déjà,
//     quel que soit son contenu, et l'aurait laissé PÉRIMÉ.
//   · TRAVAIL 2 — une variable `$$x` LUE que personne ne DÉCLARE (ni un thème de l'app, ni un
//     composant, ni le framework) est presque toujours une faute de frappe : la valeur est
//     VIDE à l'écran, sans la moindre erreur de compilation — le pire des symptômes, muet.
//     Une variable déclarée par au moins deux composants est un usage NORMAL (l'esprit CSS
//     d'une variable qui cascade) — simple information, jamais un reproche.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const stylesDir = join(root, 'styles')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(stylesDir, { recursive: true })
  return { root, srcDir, stylesDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

// stylesheetsDir pointe vers un dossier FRAIS et vide à chaque test : sans ça, le défaut
// résoudrait vers le vrai `app/modularjs/styles` du dépôt courant (CWD du test runner) —
// aucun risque fonctionnel (lecture seule), mais une isolation propre coûte une ligne.
function makeBundler(p: ReturnType<typeof makeProject>) {
  return new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir })
}

describe('bundler — variants : fichier satellite <mod>.<nom>.css', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('un composant avec <style name="bandeau"> écrit son satellite, avec le CSS attendu', async function () {
    const p = makeProject('layout-sat')
    writeFileSync(join(p.srcDir, 'carte.mjs'), [
      '<style name="bandeau">',
      '  :host',
      '    display: flex',
      '</style>',
      '<div>x</div>',
    ].join('\n'))

    const bundler = makeBundler(p)
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const satPath = join(p.outDir, 'carte.bandeau.css')
    assert.ok(existsSync(satPath), `satellite manquant : ${satPath}`)
    assert.match(readFileSync(satPath, 'utf-8'), /display:flex/)
    await bundler.close()
  })

  it('rebuild après modification du contenu du variant : le satellite est MIS À JOUR', async function () {
    const p = makeProject('layout-rebuild')
    const source = (color: string) => [
      '<style name="bandeau">',
      '  :host',
      `    color: ${color}`,
      '</style>',
      '<div>x</div>',
    ].join('\n')
    writeFileSync(join(p.srcDir, 'carte.mjs'), source('red'))

    const bundler = makeBundler(p)
    await bundler.compile()
    const satPath = join(p.outDir, 'carte.bandeau.css')
    assert.match(readFileSync(satPath, 'utf-8'), /red/)

    writeFileSync(join(p.srcDir, 'carte.mjs'), source('blue'))
    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))
    const second = readFileSync(satPath, 'utf-8')
    assert.match(second, /blue/)
    assert.ok(!second.includes('red'),
      `AVANT le fix : une écriture façon writeFileAtomic (skip si le fichier existe déjà) aurait laissé le satellite PÉRIMÉ. contenu actuel :\n${second}`)
    await bundler.close()
  })

  // repro EXACTE : COMPILE 1 (froid, cache MISS) → suppression manuelle du
  // satellite (ménage du dossier de sortie, SOURCE inchangée) → COMPILE 2 sur la MÊME instance
  // (cache HIT — `mjs dev`/Bundler.watch() vit tout une session sur UN SEUL Bundler) → le
  // satellite doit être de retour. AVANT le fix, la branche cache-hit de `_compileMjsInner` ne
  // testait `existsSync` QUE sur le `.js` principal et ne réécrivait jamais `cached.layoutCss`.
  it('cache hit (même instance, source INCHANGÉE) après suppression manuelle du satellite : il revient', async function () {
    const p = makeProject('layout-cachehit')
    writeFileSync(join(p.srcDir, 'carte.mjs'), [
      '<style name="bandeau">',
      '  :host',
      '    display: flex',
      '</style>',
      '<div>x</div>',
    ].join('\n'))

    const bundler = makeBundler(p)
    const stats1 = await bundler.compile()   // COMPILE 1 (froid)
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const satPath = join(p.outDir, 'carte.bandeau.css')
    assert.ok(existsSync(satPath), `satellite absent après le compile froid : ${satPath}`)

    unlinkSync(satPath)   // ménage manuel du dossier de sortie — SOURCE inchangée
    assert.ok(!existsSync(satPath), 'le satellite doit avoir disparu avant le 2e compile')

    const stats2 = await bundler.compile()   // COMPILE 2 — MÊME instance, cache CHAUD
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))
    assert.ok(existsSync(satPath),
      `AVANT le fix : un cache hit ne réécrivait JAMAIS un satellite manquant — reste absent : ${satPath}`)
    assert.match(readFileSync(satPath, 'utf-8'), /display:flex/)
    await bundler.close()
  })
})

describe('bundler — registre des variables de thème $$', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('un $$typo lu et déclaré nulle part produit un avertissement variable-inconnue', async function () {
    const p = makeProject('var-typo')
    writeFileSync(join(p.srcDir, 'carte.mjs'), [
      '<style>',
      '  :host',
      '    color: $$typo',
      '</style>',
      '<div>x</div>',
    ].join('\n'))

    const bundler = makeBundler(p)
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(stats.warnings.some(w => w.includes('$$typo est lu par') && w.includes('carte')),
      `avertissement variable-inconnue attendu. warnings:\n${stats.warnings.join('\n')}`)
    await bundler.close()
  })

  it('une variable lue par un composant et déclarée par le <theme> d\'un AUTRE composant : aucun avertissement', async function () {
    const p = makeProject('var-cross')
    writeFileSync(join(p.srcDir, 'lecteur.mjs'), [
      '<style>',
      '  :host',
      '    gap: $$gap',
      '</style>',
      '<div>x</div>',
    ].join('\n'))
    writeFileSync(join(p.srcDir, 'declarant.mjs'), '<theme>\n  $$gap: 12px\n</theme>\n<div>y</div>\n')

    const bundler = makeBundler(p)
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.equal(stats.warnings.length, 0,
      `aucun avertissement attendu (variable déclarée ailleurs, cascade normale). warnings:\n${stats.warnings.join('\n')}`)
    await bundler.close()
  })

  it('une variable du framework ($$surface) lue par un composant : aucun avertissement', async function () {
    const p = makeProject('var-framework')
    writeFileSync(join(p.srcDir, 'carte.mjs'), [
      '<style>',
      '  :host',
      '    background: $$surface',
      '</style>',
      '<div>x</div>',
    ].join('\n'))

    const bundler = makeBundler(p)
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.equal(stats.warnings.length, 0,
      `$$surface est déclaré par le framework (mjs_init.ts) : aucun avertissement attendu. warnings:\n${stats.warnings.join('\n')}`)
    await bundler.close()
  })

  it('une même variable déclarée par deux composants produit une information variable-partagee', async function () {
    const p = makeProject('var-shared')
    writeFileSync(join(p.srcDir, 'carte.mjs'), '<theme>\n  $$gap: 12px\n</theme>\n<div>x</div>\n')
    writeFileSync(join(p.srcDir, 'liste.mjs'), '<theme>\n  $$gap: 4px\n</theme>\n<div>y</div>\n')

    const bundler = makeBundler(p)
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(stats.warnings.some(w => w.includes('$$gap est déclaré par') && w.includes('carte') && w.includes('liste')),
      `information variable-partagee attendue. warnings:\n${stats.warnings.join('\n')}`)
    await bundler.close()
  })

  it('projet sans thème ni $$ : zéro message, pas de .mjs-theme-vars.json', async function () {
    const p = makeProject('var-none')
    writeFileSync(join(p.srcDir, 'carte.mjs'), '<style>\n  :host\n    color: red\n</style>\n<div>x</div>\n')

    const bundler = makeBundler(p)
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.equal(stats.warnings.length, 0, `aucun avertissement attendu. warnings:\n${stats.warnings.join('\n')}`)
    assert.ok(!existsSync(join(p.outDir, '.mjs-theme-vars.json')), 'aucun registre attendu — le projet n\'utilise pas les thèmes')
    await bundler.close()
  })

  // registre des variables de thème, défaut 1 — un artefact déposé dans public/ ne doit
  // JAMAIS publier l'arborescence absolue de la machine de build.
  it('le fichier de registre ne publie AUCUN chemin absolu de la machine de build', async function () {
    const p = makeProject('var-relpath')
    const compPath = join(p.srcDir, 'carte.mjs')
    writeFileSync(compPath, '<theme>\n  $$gap: 12px\n</theme>\n<div>x</div>\n')

    const bundler = makeBundler(p)
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const registry = JSON.parse(readFileSync(join(p.outDir, '.mjs-theme-vars.json'), 'utf-8'))
    const decl = registry.gap.declarations[0]
    assert.ok(!decl.file.startsWith('/'), `chemin ABSOLU publié dans le registre : ${decl.file}`)
    assert.equal(decl.file, relative(process.cwd(), compPath))
    await bundler.close()
  })

  // registre des variables de thème, défaut 2 — mjs_init.ts pose $$surface PUIS $$fg sur
  // LA MÊME ligne (un seul template literal CSS) juste après un commentaire d'explication qui ne
  // parle QUE de la structure d'ensemble : seule la 1re déclaration qui suit IMMÉDIATEMENT ce
  // commentaire (surface) peut en hériter, jamais les suivantes sur la même ligne (fg…).
  it('un commentaire ne documente QUE la déclaration qui le suit immédiatement, jamais la suivante sur la même ligne', async function () {
    const p = makeProject('var-doc')
    writeFileSync(join(p.srcDir, 'carte.mjs'), '<style>\n  :host\n    color: $$fg\n    background: $$surface\n</style>\n<div>x</div>\n')

    const bundler = makeBundler(p)
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const registry = JSON.parse(readFileSync(join(p.outDir, '.mjs-theme-vars.json'), 'utf-8'))
    const surface = registry.surface.declarations.find((d: any) => d.declaredBy === 'framework')
    const fg      = registry.fg.declarations.find((d: any) => d.declaredBy === 'framework')
    assert.ok(surface && fg, `déclarations framework introuvables : ${JSON.stringify({ surface: registry.surface, fg: registry.fg })}`)
    assert.equal(surface.doc, 'jeu différent de celui du document.', `doc légitime de $$surface changée : "${surface.doc}"`)
    assert.equal(fg.doc, '',
      `AVANT le fix : $$fg (2e --mjs- de la même ligne que $$surface dans mjs_init.ts) héritait à tort du commentaire de $$surface. doc actuel : "${fg.doc}"`)
    await bundler.close()
  })

  // registre des variables de thème, défaut 3 — ThemeVar.variant existe côté transpiler
  // mais n'atterrissait pas dans le registre : reproduit l'extrait authentique
  // (`<theme name="gold">` qui redéclare le même nom que le bloc de base).
  it('la variante d\'une déclaration $$ (bloc <theme name="…">) atterrit dans le registre', async function () {
    const p = makeProject('var-variant')
    writeFileSync(join(p.srcDir, 'card.mjs'), [
      '<theme>',
      '  $$card-accent: var(--mjs-accent)',
      '</theme>',
      '<theme name="gold">',
      '  $$card-accent: #e0a526',
      '</theme>',
      '<div>x</div>',
    ].join('\n'))

    const bundler = makeBundler(p)
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const registry = JSON.parse(readFileSync(join(p.outDir, '.mjs-theme-vars.json'), 'utf-8'))
    const decls = registry['card-accent'].declarations
    assert.equal(decls.length, 2, `2 déclarations attendues : ${JSON.stringify(decls)}`)
    const gold = decls.find((d: any) => d.value === '#e0a526')
    const base = decls.find((d: any) => d.value.includes('var('))
    assert.ok(gold && base, `déclarations introuvables : ${JSON.stringify(decls)}`)
    assert.equal(gold.variant, 'gold', `AVANT le fix : variant absent/vide alors que #e0a526 vient de <theme name="gold"> : ${JSON.stringify(gold)}`)
    assert.equal(base.variant, '', `le bloc de base doit garder variant vide : ${JSON.stringify(base)}`)
    await bundler.close()
  })
})
