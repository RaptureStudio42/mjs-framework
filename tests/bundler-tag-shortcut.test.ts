// Test neuf — bundler/index.ts : résolution UNIQUE du
// raccourci <@nom> (projet PUIS cœur), <@mjs-nom> (ancienne notation dédiée
// au cœur) désormais une ERREUR DE MIGRATION, balises littérales
// mjs-*/mjs-core-* écrites à la main, gardes sur les noms de fichiers projet
// (réservé / préfixe core-), compilation TRANSITIVE des modules cœur
// référencés sous leur nom PLAT. Patron `buildProject` calqué sur
// tests/mjs-modal-bundler-integration.test.ts.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

async function buildProject(files: Record<string, string>, extraOpts: any = {}): Promise<{ root: string; srcDir: string; outDir: string; stats: any }> {
  const root = mjsTmp('tagshortcut')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const full = join(srcDir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), ...extraOpts })
  const stats = await bundler.compile()
  return { root, srcDir, outDir, stats }
}

function messages(stats: any): string {
  return stats.errors.map((e: any) => e.message).join('\n')
}

function readComponent(outDir: string, name: string): string {
  const files = readdirSync(outDir)
  const f = files.find((f) => new RegExp(`^${name}-[a-f0-9]{8}\\.js$`).test(f))
  assert.ok(f, `${name}-*.js doit exister dans ${outDir} (trouvés : ${files.join(', ')})`)
  return readFileSync(join(outDir, f!), 'utf-8')
}

function makeCoreCatalog(root: string, files: Record<string, string>): string {
  const coreDir = join(root, 'core-modules')
  mkdirSync(coreDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(coreDir, rel), content)
  return coreDir
}

describe('bundler — raccourci-dev <@nom> valide → build vert, <mjs-nom> dans le gabarit', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('self-close <@panier/> + panier.mjs présent → <mjs-panier></mjs-panier>', async () => {
    const { outDir, stats } = await buildProject({
      'hote.mjs': '<div><@panier/></div>',
      'panier.mjs': '<p>panier</p>',
    })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.match(readComponent(outDir, 'hote'), /<mjs-panier><\/mjs-panier>/)
  })

  it('forme ouvrante+fermante <@panier>…</@panier> → même réécriture', async () => {
    const { outDir, stats } = await buildProject({
      'hote.mjs': '<div><@panier></@panier></div>',
      'panier.mjs': '<p>panier</p>',
    })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.match(readComponent(outDir, 'hote'), /<mjs-panier><\/mjs-panier>/)
  })

  it('multi-tiret <@rt-x> valide via ALIAS court (doc/doc-rt-x.mjs) → <mjs-rt-x>', async () => {
    const { outDir, stats } = await buildProject({
      'hote.mjs': '<div><@rt-x/></div>',
      'doc/doc-rt-x.mjs': '<p>rt-x</p>',
    })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.match(readComponent(outDir, 'hote'), /<mjs-rt-x><\/mjs-rt-x>/)
  })
})

describe('bundler — raccourci-dev <@nom> INCONNU → erreur agrégée + suggestion levenshtein', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('<@slect> (typo, select.mjs présent) → « balise <@slect> inconnue » + « <@select> (composant du projet) »', async () => {
    const root = mjsTmp('tagshortcut-core')
    const coreModulesDir = makeCoreCatalog(root, {})  // catalogue cœur DE TEST vide — isolé du vrai src/core-modules/
    const { stats } = await buildProject({
      'hote.mjs': '<div><@slect/></div>',
      'select.mjs': '<p>select</p>',
    }, { coreModulesDir })
    assert.ok(stats.errors.length > 0, 'le build doit échouer')
    const msg = messages(stats)
    assert.match(msg, /balise <@slect> inconnue/)
    assert.match(msg, /résolution projet puis cœur/)
    assert.match(msg, /ni balise réservée, ni composant du projet, ni module cœur/)
    assert.match(msg, /<@select>/)
    assert.match(msg, /composant du projet/)
  })

  it('<@slect> — distance ÉGALE projet/cœur (select.mjs des deux côtés) → départage gagné par le PROJET', async () => {
    const root = mjsTmp('tagshortcut-core')
    const coreModulesDir = makeCoreCatalog(root, { 'select.mjs': '<p>cœur select</p>' })  // même nom que le projet → distances Levenshtein à égalité
    const { stats } = await buildProject({
      'hote.mjs': '<div><@slect/></div>',
      'select.mjs': '<p>select</p>',
    }, { coreModulesDir })
    assert.ok(stats.errors.length > 0, 'le build doit échouer')
    assert.match(messages(stats), /<@select> \(composant du projet\)/)
  })

  it('<@slott> (typo d\'une réservée) → suggestion « <@slot> (balise réservée) »', async () => {
    const root = mjsTmp('tagshortcut-core')
    const coreModulesDir = makeCoreCatalog(root, {})  // isolé du vrai src/core-modules/
    const { stats } = await buildProject({ 'hote.mjs': '<div><@slott/></div>' }, { coreModulesDir })
    assert.ok(stats.errors.length > 0)
    const msg = messages(stats)
    assert.match(msg, /<@slot>/)
    assert.match(msg, /balise réservée/)
  })
})

describe('bundler — raccourci <@nom> résolu par le cœur (catalogue de test coreModulesDir)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('<@tst> (bare, PAS de projet homonyme) + tst.mjs au catalogue → build vert, manifest.tst (PLAT), chunk émis, <mjs-tst> dans le gabarit', async () => {
    const root = mjsTmp('tagshortcut-core')
    const coreModulesDir = makeCoreCatalog(root, { 'tst.mjs': '<p>cœur tst</p>' })
    const { outDir, stats } = await buildProject({ 'hote.mjs': '<div><@tst/></div>' }, { coreModulesDir })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.ok(stats.manifest['tst'], 'manifest doit exposer la clé PLATE tst (plus de préfixe core-)')
    assert.equal(stats.manifest['core-tst'], undefined, 'l\'ancienne clé core-tst ne doit plus jamais être écrite')
    const files = readdirSync(outDir)
    assert.ok(files.some((f) => /^tst-[a-f0-9]{8}\.js$/.test(f)), `chunk tst-*.js attendu parmi : ${files.join(', ')}`)
    assert.match(readComponent(outDir, 'hote'), /<mjs-tst><\/mjs-tst>/)
  })

  it('<@tsst> (typo) → erreur + suggestion mentionnant <@tst>', async () => {
    const root = mjsTmp('tagshortcut-core')
    const coreModulesDir = makeCoreCatalog(root, { 'tst.mjs': '<p>cœur tst</p>' })
    const { stats } = await buildProject({ 'hote.mjs': '<div><@tsst/></div>' }, { coreModulesDir })
    assert.ok(stats.errors.length > 0)
    assert.match(messages(stats), /<@tst>/)
  })

  it('transitivité : tst.mjs référence <@tst2> (bare) → tst2 aussi au manifeste (clé PLATE)', async () => {
    const root = mjsTmp('tagshortcut-core')
    const coreModulesDir = makeCoreCatalog(root, {
      'tst.mjs': '<div><p>cœur tst</p><@tst2/></div>',
      'tst2.mjs': '<p>cœur tst2</p>',
    })
    const { stats } = await buildProject({ 'hote.mjs': '<div><@tst/></div>' }, { coreModulesDir })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.ok(stats.manifest['tst'], 'tst attendu au manifeste')
    assert.ok(stats.manifest['tst2'], 'tst2 (référencé TRANSITIVEMENT par tst.mjs) attendu au manifeste')
  })

  // la règle « un module cœur ne référence QUE du cœur » DISPARAÎT : un module cœur
  // qui référence <@panier> (composant PROJET) résout désormais avec SUCCÈS (même résolution
  // projet-puis-cœur, qu'elle vienne d'un fichier projet ou d'un module cœur).
  it('override projet-sur-cœur : un module cœur (tst.mjs) référence <@panier>, le CŒUR a AUSSI un module "panier" — le PROJET prime quand même', async () => {
    const root = mjsTmp('tagshortcut-core')
    const coreModulesDir = makeCoreCatalog(root, {
      'tst.mjs': '<div><@panier/></div>',
      'panier.mjs': '<p>panier CŒUR — ne doit JAMAIS être choisi</p>',
    })
    const { outDir, stats } = await buildProject({
      'hote.mjs': '<div><@tst/></div>',
      'panier.mjs': '<p>panier PROJET</p>',
    }, { coreModulesDir })
    assert.equal(stats.errors.length, 0, messages(stats), 'le build doit réussir : plus de règle « cœur ne référence que du cœur »')
    assert.ok(stats.manifest['tst'], 'le module cœur tst doit être compilé (référencé par hote.mjs)')
    const files = readdirSync(outDir)
    const panierFiles = files.filter((f) => /^panier-[a-f0-9]{8}\.js$/.test(f))
    assert.equal(panierFiles.length, 1, `un seul chunk panier-*.js attendu (celui du projet) parmi : ${files.join(', ')}`)
    const panierOut = readFileSync(join(outDir, panierFiles[0]), 'utf-8')
    assert.match(panierOut, /panier PROJET/, 'le contenu compilé doit être celui DU PROJET (override)')
    assert.doesNotMatch(panierOut, /panier CŒUR/, 'le panier du cœur ne doit jamais être compilé (masqué par le projet)')
  })

  it('<@mjs-tst/> (ANCIENNE notation retirée) → ERREUR DE MIGRATION, même si tst.mjs existe réellement au catalogue cœur', async () => {
    const root = mjsTmp('tagshortcut-core')
    const coreModulesDir = makeCoreCatalog(root, { 'tst.mjs': '<p>cœur tst</p>' })
    const { stats } = await buildProject({ 'hote.mjs': '<div><@mjs-tst/></div>' }, { coreModulesDir })
    assert.ok(stats.errors.length > 0, 'le build doit échouer (notation retirée), même si tst.mjs existe')
    const msg = messages(stats)
    assert.match(msg, /« <@mjs-tst> » est retirée/)
    assert.match(msg, /écris « <@tst> »/)
  })
})

describe('bundler — gardes sur les fichiers du projet (nom réservé / préfixe core-)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('fichier head.mjs (basename réservé) → erreur', async () => {
    const { stats } = await buildProject({ 'head.mjs': '<p>x</p>' })
    assert.ok(stats.errors.length > 0)
    assert.match(messages(stats), /RÉSERVÉE/)
  })

  it('fichier core-x.mjs (préfixe core- réservé) → erreur', async () => {
    const { stats } = await buildProject({ 'core-x.mjs': '<p>x</p>' })
    assert.ok(stats.errors.length > 0)
    assert.match(messages(stats), /préfixe RÉSERVÉ au catalogue interne des modules cœur/)
  })

  // un ALIAS court n'est qu'un confort : contrairement au basename (guards ci-dessus,
  // erreur dure inchangée), une collision d'ALIAS avec une réservée/core- cède en silence
  // (avertissement) plutôt que de bloquer tout le build pour un simple raccourci.
  it('alias court en collision avec une réservée (doc/doc-view.mjs → alias "view") → build VERT + avertissement, nom long fonctionne, <@view> garde son sens réservé', async () => {
    const { outDir, stats } = await buildProject({
      'doc/doc-view.mjs': '<p>x</p>',
      // <@view> exige le marqueur .page.mjs sur son hôte ; le
      // stripping (pageAwareBaseName) laisse l'identité 'hote' inchangée (readComponent
      // ci-dessous continue de chercher hote-<hash>.js, jamais hote.page-<hash>.js).
      'hote.page.mjs': '<div><@doc-view/></div>\n<@view app-content>',
    })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.ok(stats.warnings.some((w: string) => w.includes("'view'")), `un avertissement doit mentionner l'alias 'view' (reçu : ${stats.warnings.join(' | ')})`)
    const out = readComponent(outDir, 'hote')
    assert.match(out, /<mjs-doc-view><\/mjs-doc-view>/)  // le nom long continue de marcher
    assert.match(out, /metamjs-view/)  // <@view> reste réécrite en metamjs-view, jamais vers le composant
    assert.equal(stats.manifest['view'], undefined, `la clé courte 'view' (alias abandonné) ne doit pas résoudre vers doc-view.mjs (reçu : ${stats.manifest['view']})`)
  })

  it('alias court en collision avec le préfixe core- (x/x-core-thing.mjs → alias "core-thing") → build VERT + avertissement, nom long fonctionne', async () => {
    const { outDir, stats } = await buildProject({
      'x/x-core-thing.mjs': '<p>y</p>',
      'hote2.mjs': '<div><@x-core-thing/></div>',
    })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.ok(stats.warnings.some((w: string) => w.includes("'core-thing'")), `un avertissement doit mentionner l'alias 'core-thing' (reçu : ${stats.warnings.join(' | ')})`)
    assert.match(readComponent(outDir, 'hote2'), /<mjs-x-core-thing><\/mjs-x-core-thing>/)  // le nom long continue de marcher
    assert.equal(stats.manifest['core-thing'], undefined, `la clé courte 'core-thing' (alias abandonné) ne doit pas résoudre vers x-core-thing.mjs (reçu : ${stats.manifest['core-thing']})`)
  })
})

describe('bundler — balises littérales mjs-*/mjs-core-* écrites à la main', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('<mjs-core-x> littéral dans un gabarit dev → erreur (n\'existe plus, jamais écrite à la main)', async () => {
    const { stats } = await buildProject({ 'hote.mjs': '<div><mjs-core-x></mjs-core-x></div>' })
    assert.ok(stats.errors.length > 0)
    const msg = messages(stats)
    assert.match(msg, /n'existe plus/)
    assert.match(msg, /<@x>/)
  })

  it('<mjs-typo> littéral inconnu → build VERT + avertissement dans stats.warnings', async () => {
    const { stats } = await buildProject({ 'hote.mjs': '<div><mjs-typo></mjs-typo></div>' })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.ok(stats.warnings.some((w: string) => w.includes('mjs-typo')), `un avertissement doit mentionner mjs-typo (reçu : ${stats.warnings.join(' | ')})`)
  })

  it('<mjs-panier> littéral CONNU (panier.mjs présent) → aucun avertissement', async () => {
    const { stats } = await buildProject({
      'hote.mjs': '<div><mjs-panier></mjs-panier></div>',
      'panier.mjs': '<p>panier</p>',
    })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.equal(stats.warnings.some((w: string) => w.includes('mjs-panier')), false, `aucun avertissement ne doit mentionner mjs-panier (reçu : ${stats.warnings.join(' | ')})`)
  })

  // kind 'litteral-dev' : même logique que 'raccourci-dev' — inconnu du PROJET mais
  // connu du CŒUR → inclusion SILENCIEUSE (aucun avertissement), pas juste un raccourci `@`.
  it('<mjs-select> littéral INCONNU du projet mais CONNU du cœur (catalogue réel) → résout le cœur SANS avertissement', async () => {
    const { outDir, stats } = await buildProject({ 'hote.mjs': '<div><mjs-select></mjs-select></div>' })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.equal(stats.warnings.some((w: string) => w.includes('mjs-select')), false, `aucun avertissement ne doit mentionner mjs-select (reçu : ${stats.warnings.join(' | ')})`)
    assert.ok(stats.manifest['select'], 'le module cœur select doit être compilé (clé PLATE)')
    assert.match(readComponent(outDir, 'hote'), /<mjs-select>/)
  })
})

describe('bundler — les 12 balises réservées restent INTACTES à travers tout le pipeline', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('<@slot>/<@include>/<@head>/<@window>/<@view>/<@failed>/<@element>/<@module> ensemble → build vert, rien remonté en avertissement', async () => {
    const { outDir, stats } = await buildProject({
      // <@view app-content> en toute fin exige le marqueur .page.mjs.
      'hote.page.mjs': [
        '<script>',
        '@onScroll = ->',
        '@onEnter = (err, reset) ->',
        '</script>',
        '<@window @scroll={@onScroll} />',
        '<@head><title>Titre</title></@head>',
        '<article>',
        '  <@include partiel>',
        '  <header><@slot title/></header>',
        '  <@element $tag>texte</@element>',
        '  <@module $comp>repli</@module>',
        '</article>',
        '<@failed err reset>',
        '  <p>💥 {err.message}</p>',
        '</@failed>',
        '<@view app-content>',
      ].join('\n'),
      '_partiel.mjs': '<p>partiel inclus</p>',
    })
    assert.equal(stats.errors.length, 0, messages(stats))
    const out = readComponent(outDir, 'hote')
    // le partiel <@include> est inliné TEXTUELLEMENT — son contenu doit être présent
    assert.match(out, /partiel inclus/)
    // <@view> reste réécrite en metamjs-view (comportement historique, cf. parser)
    assert.match(out, /metamjs-view/)
    // <@slot> reste réécrite en slot
    assert.match(out, /<slot/)
    // aucune des 12 balises réservées ne doit jamais remonter comme un warning
    // (« ne correspond à aucun composant » — signature du canal litteral-dev-inconnue)
    assert.equal(stats.warnings.some((w: string) => /ne correspond à aucun composant/.test(w)), false, `aucun avertissement attendu (reçu : ${stats.warnings.join(' | ')})`)
  })
})
