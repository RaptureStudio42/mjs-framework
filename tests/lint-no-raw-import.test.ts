// Test de régression — demande utilisateur explicite (hors catalogue) : un `import … from …` ES classique écrit DANS
// un <script>/<script module> doit déclencher une ERREUR DE COMPILATION MJS
// — seule la directive `@import nom 'chemin'` (racine du fichier) reste un
// import valide. AVANT ce fix, un import ES classique passait tel quel
// (Civet/TS/JS l'acceptent nativement) et fonctionnait souvent (esbuild le
// résout ensuite comme un import Node/ESM normal) mais échappait TOTALEMENT
// au graphe de dépendances du bundler (`partialDependents`/watch) — deux
// mécanismes d'import parallèles et incohérents dans le même projet,
// silencieusement.

import assert from 'node:assert/strict'
import { lintNoRawImport, transpile } from '../src/transpiler/index.js'

describe('lintNoRawImport — unitaire (AST, pas de regex sur le source brut)', () => {
  it("import nommé (`import {x} from 'y'`) → throw explicite MJS", () => {
    assert.throws(
      () => lintNoRawImport(`import { x } from 'y';\nconsole.log(x);`, '<script>'),
      /\[ModularJS\].*import ES classique.*@import/s
    )
  })

  it("import par défaut (`import x from 'y'`) → throw", () => {
    assert.throws(() => lintNoRawImport(`import x from 'y';`, '<script>'), /@import/)
  })

  it("import namespace (`import * as x from 'y'`) → throw", () => {
    assert.throws(() => lintNoRawImport(`import * as x from 'y';`, '<script>'), /@import/)
  })

  it("import à effet de bord seul (`import 'y'`) → throw", () => {
    assert.throws(() => lintNoRawImport(`import 'y';`, '<script>'), /@import/)
  })

  it("import() dynamique, même niché dans une fonction → throw", () => {
    assert.throws(
      () => lintNoRawImport(`function load() { return import('y'); }`, '<script>'),
      /@import/
    )
  })

  it('le message identifie la section (<script> vs <script module>)', () => {
    assert.throws(() => lintNoRawImport(`import x from 'y';`, '<script module>'), /<script module>/)
  })

  it('aucun import : ne throw jamais (cas nominal, non-régression)', () => {
    assert.doesNotThrow(() => lintNoRawImport(`const x = 1;\nfunction f() { return x + 1; }`, '<script>'))
  })

  it('le mot "import" dans une CHAÎNE littérale : pas de faux positif (AST, pas de regex texte)', () => {
    assert.doesNotThrow(() => lintNoRawImport(`const msg = "please import your data";`, '<script>'))
  })

  it('le mot "import" dans un COMMENTAIRE : pas de faux positif', () => {
    assert.doesNotThrow(() => lintNoRawImport(`// import stuff here manually\nconst x = 1;`, '<script>'))
  })

  it('JS vide/absent : no-op silencieux', () => {
    assert.doesNotThrow(() => lintNoRawImport('', '<script>'))
    assert.doesNotThrow(() => lintNoRawImport(undefined as any, '<script>'))
  })

  it('JS mal formé (échec de parse acorn) : retourne silencieusement, ne masque pas une autre erreur', () => {
    assert.doesNotThrow(() => lintNoRawImport('function ( {', '<script>'))
  })

  it("`export` seul (sans import) : jamais concerné", () => {
    assert.doesNotThrow(() => lintNoRawImport(`export const x = 1;`, '<script>'))
  })
})

describe('lintNoRawImport — bout-en-bout (transpile réel)', function () {
  this.timeout(8000)

  it("<script> avec un import ES classique : transpile() rejette avec l'erreur MJS", async () => {
    const src = [
      '<script lang="js">',
      "import { helper } from './helper.js'",
      'const x = helper()',
      '</script>',
      '<p>{x}</p>',
    ].join('\n')
    await assert.rejects(
      () => transpile(src, { moduleName: 'noimport1' }),
      /\[ModularJS\].*import ES classique.*@import/s
    )
  })

  it('<script module> avec un import ES classique : transpile() rejette aussi', async () => {
    const src = [
      '<script module lang="js">',
      "import { helper } from './helper.js'",
      '</script>',
      '<script lang="js">',
      'const x = 1',
      '</script>',
      '<p>{x}</p>',
    ].join('\n')
    await assert.rejects(
      () => transpile(src, { moduleName: 'noimport2' }),
      /\[ModularJS\].*import ES classique.*<script module>/s
    )
  })

  it("la directive `@import` légitime (racine du fichier) n'est JAMAIS vue par ce lint (non-régression critique)", async () => {
    const src = [
      "@import helper 'shared/utils.module.civet'",
      '<script lang="civet">$x = helper()</script>',
      '<div>{$x}</div>',
    ].join('\n')
    const resolveAsset = async () => `/assets/modularJS_compiled/utils-DEADBEEF.js`
    const { output } = await transpile(src, {
      moduleName: 'noimport3',
      defaultScriptLang: 'civet',
      resolveAsset,
    })
    assert.match(output, /DEADBEEF/, "@import doit continuer à fonctionner normalement, aucun throw")
  })

  it("`@import` légitime PLUS un import ES classique en trop dans <script module> : ce DERNIER reste rejeté (l'exemption ne couvre QUE les imports injectés par la directive)", async () => {
    const src = [
      "@import helper 'shared/utils.module.civet'",
      '<script module lang="js">',
      "import { sournois } from './sournois.js'",
      '</script>',
      '<script lang="civet">$x = helper()</script>',
      '<div>{$x}</div>',
    ].join('\n')
    const resolveAsset = async () => `/assets/modularJS_compiled/utils-DEADBEEF.js`
    await assert.rejects(
      () => transpile(src, { moduleName: 'noimport5', defaultScriptLang: 'civet', resolveAsset }),
      /\[ModularJS\].*import ES classique.*<script module>/s
    )
  })

  it('un <script> normal sans aucun import compile sans erreur (non-régression générale)', async () => {
    const src = [
      '<script lang="civet">',
      '$x = 1',
      '</script>',
      '<p>{$x}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'noimport4', defaultScriptLang: 'civet' })
    assert.match(output, /\$\.x/)
    assert.match(output, /µ\._def\(/)
  })
})
