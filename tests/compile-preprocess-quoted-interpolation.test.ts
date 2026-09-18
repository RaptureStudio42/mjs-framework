// Test de régression :
// `preprocess()` (generator/compile.ts) développe le raccourci `{name}` (attribut
// nu → `name="{name}"`, ex. `<div {isActive}>`) via une regex qui ne se
// souciait PAS de savoir si `{name}` apparaît DANS une valeur d'attribut DÉJÀ
// quotée. Un `{name}` entouré d'espaces N'IMPORTE OÙ dans la chaîne
// d'attributs matchait — y compris au milieu d'une valeur littérale comme
// `class="foo {isActive} bar"` (une interpolation espacée, cas d'usage
// courant pour composer une classe CSS avec du texte fixe autour). Résultat :
// l'attribut était DÉTRUIT (guillemet refermé prématurément, texte orphelin
// hors de toute paire attribut=valeur — `class='foo isActive=' bar>`), ET
// l'interpolation elle-même perdue (aucune liaison réactive émise).
//
// Fix : une seule regex avec les valeurs quotées comme alternatives
// PRIORITAIRES — une valeur quotée entière est matchée et consommée en un
// bloc (donc inchangée), avant que le raccourci ne puisse s'appliquer À
// L'INTÉRIEUR de son contenu.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { preprocess } from '../src/generator/compile.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('generator/compile — preprocess() : le raccourci {name} ne mutile plus une interpolation DANS une valeur quotée', function () {
  it('interpolation espacée au milieu d\'une valeur d\'attribut DOUBLE-quotée : inchangée (pas de raccourci appliqué dedans)', () => {
    const out = preprocess(`<div class="foo {isActive} bar">contenu</div>`)
    assert.equal(out, `<div class="foo {isActive} bar">contenu</div>`,
      "AVANT le fix : produisait <div class='foo isActive=' bar>contenu</div> — attribut détruit")
  })

  it('interpolation espacée au milieu d\'une valeur d\'attribut SIMPLE-quotée : inchangée', () => {
    const out = preprocess(`<div class='foo {isActive} bar'>contenu</div>`)
    assert.equal(out, `<div class='foo {isActive} bar'>contenu</div>`)
  })

  it('le raccourci {name} RÉEL (hors de toute valeur quotée) continue de fonctionner (pas de régression)', () => {
    const out = preprocess(`<div {isActive}>contenu</div>`)
    assert.equal(out, `<div isActive="{isActive}">contenu</div>`)
  })

  it('le raccourci {$name} (préfixe $) continue de fonctionner', () => {
    const out = preprocess(`<div {$count}>contenu</div>`)
    assert.equal(out, `<div count="{$count}">contenu</div>`)
  })

  it('mélange : raccourci nu ET valeur quotée avec interpolation sur la MÊME balise — chacun traité correctement', () => {
    const out = preprocess(`<div {isActive} class="foo {x} bar">contenu</div>`)
    assert.equal(out, `<div isActive="{isActive}" class="foo {x} bar">contenu</div>`)
  })

  it('plusieurs attributs quotés avec interpolation espacée sur la même balise : tous préservés', () => {
    const out = preprocess(`<div class="a {x} b" title="c {y} d">contenu</div>`)
    assert.equal(out, `<div class="a {x} b" title="c {y} d">contenu</div>`)
  })
})

describe('bundler — intégration : une interpolation espacée dans un attribut quoté produit une liaison réactive correcte', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  it('class="foo {isActive} bar" compile en _mjs_updAttr avec le texte environnant préservé (pas juste la valeur nue)', async function () {
    const root = mjsTmp('b9')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), `
<script lang="coffee">
isActive = true
</script>
<div class="foo {isActive} bar">contenu</div>
`)
    const outDir = join(root, 'out')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const compFile = readdirSync(outDir).find(f => /^comp-/.test(f))!
    const code = readFileSync(join(outDir, compFile), 'utf-8')
    assert.match(code, /_mjs_updAttr\('a1',\s*'class',\s*`foo \$\{isActive\} bar`\)/,
      "AVANT le fix : soit une erreur de compile, soit un HTML mutilé sans AUCUNE liaison _mjs_updAttr émise pour class")
    assert.doesNotMatch(code, /_mjs_cloneTpl\("<div class='foo isActive=/,
      "le gabarit statique ne doit plus contenir la structure mutilée")
    await bundler.close()
  })
})
