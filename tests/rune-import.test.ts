// Régression — deux volets liés :
//
//   1. lintNoRawImport ASSOUPLI : seul un `import('…')` à chemin LITTÉRAL
//      (Literal, ou TemplateLiteral SANS expression) reste banni — un
//      argument CALCULÉ (Identifier, MemberExpression, CallExpression,
//      template AVEC expression…) est invisible au graphe de dépendances de
//      toute façon, l'interdire n'apportait aucune garantie.
//
//   2. Nouvelle rune `µimport('chemin.js')` / `mjsimport('chemin.js')` —
//      chargement PARESSEUX d'un module ES à chemin LITTÉRAL, empreinte
//      résolue au build via `µasset` (comme `@import`, mais sans injecter le
//      module en tête de fichier). Réécrite en `µ._mjs_import(µasset('chemin.js'))`
//      par les DEUX moteurs de sucre (script : applyMjsSugarToScript ;
//      cleanJs : interpolations/handlers), corps partagé sigils.ts.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { lintNoRawImport, applyMjsSugarToScript, transpile } from '../src/transpiler/index.js'
import { cleanJs } from '../src/generator/utils.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('lintNoRawImport assoupli : seul un chemin LITTÉRAL reste banni', () => {
  it("import('lit') (chemin littéral) → throw, nouveau message orientant vers @import/µimport", () => {
    assert.throws(
      () => lintNoRawImport(`import('lit')`, '<script>'),
      /\[ModularJS\].*chemin littéral interdit.*@import nom 'chemin'.*µimport/s
    )
  })

  it('import(maVar) (identifiant calculé) → autorisé, invisible au graphe de toute façon', () => {
    assert.doesNotThrow(() => lintNoRawImport(`import(maVar)`, '<script>'))
  })

  it('import(`x.js`) (template SANS expression, équivalent à un littéral) → refusé', () => {
    assert.throws(() => lintNoRawImport('import(`x.js`)', '<script>'), /chemin littéral interdit/)
  })

  it("import(`${'a'}.js`) (template AVEC expression) → autorisé", () => {
    assert.doesNotThrow(() => lintNoRawImport("import(`${'a'}.js`)", '<script>'))
  })

  it("import(µasset('x')) (argument = appel de fonction) → autorisé", () => {
    assert.doesNotThrow(() => lintNoRawImport(`import(µasset('x'))`, '<script>'))
  })
})

describe('rewriteMuImport, moteur SCRIPT (applyMjsSugarToScript)', () => {
  // La réécriture ne vit plus DANS applyMjsSugarToScript :
  // `import` reste dans MU_SCRIPT_RUNES (sigils.ts), `µimport(...)` traverse
  // donc cette fonction INTACT, tel un simple appel de fonction. La
  // réécriture réelle se fait désormais EN AVAL, en AST, sur le JS déjà
  // compilé (rewriteMuImportAst, sigils.ts — cf. tests/muimport-gabarit.test.ts
  // pour la couverture bout-en-bout et unitaire).
  it("µimport('vendor/three.js') traverse applyMjsSugarToScript INTACT (réécrit en aval, cf. rewriteMuImportAst)", () => {
    const out = applyMjsSugarToScript(`THREE = await µimport('vendor/three.js')`, 'js')
    assert.match(out, /µimport\('vendor\/three\.js'\)/)
    assert.doesNotMatch(out, /µ\._mjs_import\(/)
  })

  it('alias mjsimport(...) : même non-réécriture ICI (traverse intact)', () => {
    const out = applyMjsSugarToScript(`THREE = await mjsimport('vendor/three.js')`, 'js')
    assert.match(out, /mjsimport\('vendor\/three\.js'\)/)
    assert.doesNotMatch(out, /µ\._mjs_import\(/)
  })

  it('une CHAÎNE "µimport(\'x.js\')" reste INTACTE, zéro throw', () => {
    assert.doesNotThrow(() => {
      const out = applyMjsSugarToScript(`msg = "µimport('x.js') est une rune"`, 'js')
      assert.match(out, /"µimport\('x\.js'\) est une rune"/)
    })
  })

  it("un COMMENTAIRE `// µimport('x.js')` reste INTACT, zéro throw", () => {
    assert.doesNotThrow(() => {
      const out = applyMjsSugarToScript("// µimport('x.js')\nx = 1", 'js')
      assert.match(out, /\/\/ µimport\('x\.js'\)/)
    })
  })

  it("µimporter('x.js') (identifiant plus long) reste INTACT — pas cette rune", () => {
    const out = applyMjsSugarToScript(`x = µimporter('x.js')`, 'js')
    assert.match(out, /µ\.importer\('x\.js'\)/)
    assert.doesNotMatch(out, /µ\._mjs_import\(/)
  })

  it("<script module> : µimport(...) réécrit pareillement (bout-en-bout transpile())", async function () {
    this.timeout(8000)
    const src = [
      '<script module lang="js">',
      "export const load = () => µimport('vendor/three.js')",
      '</script>',
      '<script lang="js">',
      'const x = 1',
      '</script>',
      '<p>{x}</p>',
    ].join('\n')
    // transpile() SEUL ne substitue PAS le µasset(...) (résolution de hash =
    // rôle du bundler, cf. resolveMagicAssets/ASSET_RE, bundler/index.ts) —
    // on vérifie donc la réécriture jusqu'à ce stade, la substitution finale
    // étant couverte par le test E2E bundler plus bas.
    const { output } = await transpile(src, { moduleName: 'muimport-module' })
    assert.match(output, /µ\._mjs_import\(µasset\('vendor\/three\.js'\)\)/)
  })
})

describe('rewriteMuImport, moteur cleanJs (interpolations/handlers)', () => {
  it("handler inline @click={µimport('x.js').then(...)} réécrit (chemin cleanJs)", () => {
    const out = cleanJs(`µimport('x.js').then(cb)`, [])
    assert.equal(out, `µ._mjs_import(µasset('x.js')).then(cb)`)
  })

  it('alias mjsimport(...) : même réécriture côté cleanJs', () => {
    const out = cleanJs(`mjsimport('x.js')`, [])
    assert.equal(out, `µ._mjs_import(µasset('x.js'))`)
  })

  it("une CHAÎNE 'µimport(\\'x.js\\')' reste INTACTE, zéro throw", () => {
    assert.doesNotThrow(() => {
      const out = cleanJs(`'µimport(\\'x.js\\')'`, [])
      assert.equal(out, `'µimport(\\'x.js\\')'`)
    })
  })

  // ALIGNÉ sur le script (cf. le test miroir plus haut, moteur applyMjsSugarToScript :
  // `µimporter` PROLONGE `import`, la règle universelle ne l'exclut pas non plus —
  // même sucre universel µfoo → µ.foo désormais partagé par cleanJs, sigils.ts
  // MU_UNIVERSAL_BODY). « pas cette rune » reste vrai : jamais confondu avec
  // `µ._mjs_import(µasset(...))`, la substitution SPÉCIFIQUE de rewriteMuImport.
  it("µimporter('x.js') (identifiant plus long) : ALIGNÉ sur le script — pointé, pas cette rune", () => {
    const out = cleanJs(`µimporter('x.js')`, [])
    assert.equal(out, `µ.importer('x.js')`)
  })

  it("bout-en-bout transpile() : @click={µimport('x.js')} compile en µ._mjs_import(µasset(...)) dans le handler", async function () {
    this.timeout(8000)
    const src = [
      '<script lang="js">',
      'const onClick = () => {}',
      '</script>',
      `<button @click={µimport('vendor/lib.js').then(onClick)}>go</button>`,
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'muimport-handler' })
    // le batch d'inlines réinjecte le résultat de
    // cleanJs DANS applyMjsSugarToScript (transpiler/index.ts) — le sucre
    // universel y pointe `µasset` en `µ.asset` (pas dans MU_SCRIPT_RUNES,
    // seul `import` y est) : forme POINTÉE ici, mais ASSET_RE/ASSET_CALL_RE
    // (bundler/index.ts) reconnaissent les deux indifféremment, cf. test E2E.
    assert.match(output, /µ\._mjs_import\(µ\.?asset\('vendor\/lib\.js'\)\)\.then\(onClick\)/)
  })
})

describe('rewriteMuImport : erreurs (chemin non littéral / mauvaise extension)', () => {
  // applyMjsSugarToScript ne réécrit (et ne valide) plus
  // µimport lui-même : ces 2 erreurs sont désormais détectées EN AVAL, en
  // AST, sur le JS compilé (rewriteMuImportAst) — cf.
  // tests/muimport-gabarit.test.ts pour les throw bout-en-bout/unitaires.
  it('µimport(maVar) (argument calculé) traverse applyMjsSugarToScript SANS throw ici (détecté en aval, cf. rewriteMuImportAst)', () => {
    assert.doesNotThrow(() => applyMjsSugarToScript(`x = µimport(maVar)`, 'js'))
  })

  it("µimport('style.css') (extension non .js) traverse applyMjsSugarToScript SANS throw ici (détecté en aval)", () => {
    assert.doesNotThrow(() => applyMjsSugarToScript(`x = µimport('style.css')`, 'js'))
  })

  it('µimport(variable) → même erreur côté cleanJs (interpolation/handler)', () => {
    assert.throws(
      () => cleanJs(`µimport(maVar)`, []),
      /\[ModularJS\] µimport exige un chemin littéral/
    )
  })

  it("µimport('style.css') → même erreur côté cleanJs", () => {
    assert.throws(
      () => cleanJs(`µimport('style.css')`, []),
      /\[ModularJS\] µimport ne charge que des modules ES « \.js » .*style\.css/
    )
  })
})

describe('E2E bundler : µimport(\'vendor/lib.js\') littéral, build réel', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("composant avec µimport('vendor/lib.js') : build vert, µasset substitué en chemin haché, fichier vendor publié", async function () {
    const root = mjsTmp('muimport-e2e')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(join(srcDir, 'vendor'), { recursive: true })

    writeFileSync(join(srcDir, 'vendor', 'lib.js'), 'export const x = 1\n')
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<script lang="js">',
      "  const load = async () => await µimport('vendor/lib.js')",
      '</script>',
      '<p>ok</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e) => e.message).join('\n'))

    const files = readdirSync(outDir)
    const compFile = files.find((f) => /^comp-/.test(f))
    assert.ok(compFile, `comp-<hash>.js doit exister : ${files.join(', ')}`)
    const content = readFileSync(join(outDir, compFile!), 'utf8')
    assert.match(
      content, /µ\._mjs_import\('[^']*lib-[a-f0-9]{8}\.js'\)/,
      `le µasset('vendor/lib.js') doit avoir été substitué en chemin haché. contenu:\n${content}`
    )

    const hashedLib = files.find((f) => /^lib-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(hashedLib, `lib-<hash>.js doit être publié dans outputDir : ${files.join(', ')}`)

    await bundler.close()
  })
})
