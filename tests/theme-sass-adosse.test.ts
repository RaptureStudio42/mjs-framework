// `$x` ADOSSÉ à `$$x` — un `$$x` déclaré dans le <theme> de BASE
// expose désormais son nom au SASS : un `<style>` qui lit `$x` sans l'avoir déclaré reçoit la
// valeur en préambule, et le build peut de nouveau la PARCOURIR et la COMPARER.
//
// Ce que ces tests verrouillent, et pourquoi :
//   · les trois pièges MUETS (`@each`, `@if`, fonction de couleur sur un `var()`)
//     disparaissent quand on écrit `$x` — c'était tout l'objectif ;
//   · une variable SASS déclarée SUR PLACE garde la main : on ne double jamais une déclaration
//     de l'auteur (sinon un `$gap: 2px` local serait écrasé par la valeur du thème) ;
//   · seul le bloc SANS NOM nourrit le préambule : une variante ne vaut que quand elle est
//     active, la figer au build donnerait une valeur arbitraire ;
//   · `$x` sans `$$x` derrière échoue TOUJOURS (Undefined variable) — aucun silence nouveau ;
//   · rien n'est émis quand personne ne lit : le CSS d'un composant qui n'écrit pas de `$x`
//     est inchangé, à l'octet près.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'
import { rewriteStyleVars } from '../src/transpiler/style-vars.js'

describe('variables de thème — le `$` SASS adossé au `$$`', function () {
  it('`color: $accent` prend la valeur du <theme> de base', async function () {
    const { data } = await transpile('<theme>\n  $$accent: #3b82f6\n</theme>\n<style>\n  .a\n    color: $accent\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /\.a\{color:#3b82f6\}/)
  })

  it('`@each` sur une liste de thème déroule VRAIMENT (le piège muet nº1)', async function () {
    const { data } = await transpile('<theme>\n  $$tailles: 4px, 8px\n</theme>\n<style>\n  @each $t in $tailles\n    .gap-#{$t}\n      gap: $t\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /\.gap-4px\{gap:4px\}/)
    assert.match(data.baseCss, /\.gap-8px\{gap:8px\}/)
  })

  it('`@if` compare pour de vrai (le piège muet nº2)', async function () {
    const { data } = await transpile('<theme>\n  $$accent: #3b82f6\n</theme>\n<style>\n  .a\n    @if $accent == #3b82f6\n      color: red\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /\.a\{color:red\}/)
  })

  it('une fonction de couleur accepte la valeur (le piège nº3)', async function () {
    const { data } = await transpile('<theme>\n  $$accent: #3b82f6\n</theme>\n<style>\n  @use "sass:color"\n  .a\n    color: color.adjust($accent, $lightness: -10%)\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.ok(!/\$accent/.test(data.baseCss), 'la valeur doit être résolue au build')
    assert.match(data.baseCss, /\.a\{color:/)
  })

  it('le préambule se glisse APRÈS un `@use` — jamais devant', async function () {
    const { data } = await transpile('<theme>\n  $$accent: #3b82f6\n</theme>\n<style>\n  @use "sass:color"\n\n  .a\n    color: $accent\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /\.a\{color:#3b82f6\}/)
  })

  it('une déclaration SASS locale garde la main — jamais doublée', async function () {
    const { data } = await transpile('<theme>\n  $$gap: 12px\n</theme>\n<style>\n  $gap: 2px\n  .a\n    padding: $gap\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /\.a\{padding:2px\}/)
  })

  it('un `$$` de VARIANTE nommée ne nourrit pas le préambule', async function () {
    await assert.rejects(
      () => transpile('<theme name="gold">\n  $$accent: gold\n</theme>\n<style>\n  .a\n    color: $accent\n</style>\n<div>x</div>\n', { moduleName: 'card' }),
      /Undefined variable/,
    )
  })

  it('un `$x` sans `$$x` derrière échoue toujours', async function () {
    await assert.rejects(
      () => transpile('<style>\n  .a\n    color: $inconnu\n</style>\n<div>x</div>\n', { moduleName: 'card' }),
      /Undefined variable/,
    )
  })

  it('une déclinaison `<style name="…">` reçoit le même préambule', async function () {
    const { data } = await transpile('<theme>\n  $$accent: #3b82f6\n</theme>\n<style name="bandeau">\n  .a\n    color: $accent\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.layoutCss.bandeau, /\.a\{color:#3b82f6\}/)
  })

  it('une valeur DÉRIVÉE (`$$hover: $$brand`) reste utilisable comme valeur', async function () {
    const { data } = await transpile('<theme>\n  $$brand: #f00\n  $$hover: $$brand\n</theme>\n<style>\n  .a\n    color: $hover\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /\.a\{color:var\(--mjs-brand\)\}/)
  })

  it('témoin — sans `$x` lu, le CSS est inchangé', async function () {
    const sansTheme = await transpile('<style>\n  .a\n    color: red\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    const avecTheme = await transpile('<theme>\n  $$accent: #3b82f6\n</theme>\n<style>\n  .a\n    color: red\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.ok(avecTheme.data.baseCss.endsWith(sansTheme.data.baseCss), 'le <style> doit sortir identique')
  })

  it('la valeur capturée est nettoyée du commentaire de fin de ligne', function () {
    const rw = rewriteStyleVars('$$accent: #3b82f6 // palette\n')
    assert.equal(rw.declared[0].value, '#3b82f6')
  })

  it('une valeur qui COMMENCE par `//` reste entière', function () {
    const rw = rewriteStyleVars('$$cdn: //cdn.exemple.tld/lib.js\n')
    assert.equal(rw.declared[0].value, '//cdn.exemple.tld/lib.js')
  })

  it('recense le `$` simple : lu vs déclaré', function () {
    const rw = rewriteStyleVars('$base: 1px\n.a\n  padding: $base $autre\n  content: "$dans-une-chaine"\n')
    assert.deepEqual(rw.sassDeclared, ['base'])
    assert.deepEqual(rw.sassRead, ['base', 'autre'])
  })

  // --- les 4 défauts trouvés en testant aussi les cas limites ---

  it('une surcharge SOUS UN SÉLECTEUR du <theme> ne devient PAS la valeur figée', async function () {
    const { data } = await transpile('<theme>\n  $$accent: #3b82f6\n\n  &.chaud\n    $$accent: orange\n</theme>\n<style>\n  .a\n    color: $accent\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /\.a\{color:#3b82f6\}/, 'la valeur de BASE, jamais celle de la variante conditionnelle')
    assert.ok(!/orange/.test(data.baseCss.split('.a{')[1] ?? ''), 'orange ne doit pas fuiter dans la règle')
  })

  it('l\'ordre d\'écriture ne change rien (surcharge écrite AVANT la racine)', async function () {
    const { data } = await transpile('<theme>\n  &.chaud\n    $$accent: orange\n\n  $$accent: #3b82f6\n</theme>\n<style>\n  .a\n    color: $accent\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /\.a\{color:#3b82f6\}/)
  })

  it('une valeur qui contient une interpolation `#{…}` est capturée ENTIÈRE', async function () {
    const rw = rewriteStyleVars('$$width: 2px\n$$color: red\n$$border: #{$$width} solid #{$$color}\n')
    assert.equal(rw.declared[2].value, '#{var(--mjs-width)} solid #{var(--mjs-color)}')
  })

  it('et elle passe le build une fois adossée', async function () {
    const { data } = await transpile('<theme>\n  $$width: 2px\n  $$color: red\n  $$border: #{$$width} solid #{$$color}\n</theme>\n<style>\n  .a\n    border: $border\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /\.a\{border:var\(--mjs-width\) solid var\(--mjs-color\)\}/)
  })

  it('une valeur SCSS multi-lignes entre parenthèses n\'est pas coupée au saut de ligne', function () {
    const rw = rewriteStyleVars('$$shadow: (0 1px 2px rgba(0,0,0,.1),\n  0 2px 4px rgba(0,0,0,.1));\n')
    assert.equal(rw.declared[0].value, '(0 1px 2px rgba(0,0,0,.1),\n  0 2px 4px rgba(0,0,0,.1))')
  })

  it('un `$x` LOCAL à un sélecteur ne prive pas le reste du bloc de l\'adossage', async function () {
    const { data } = await transpile('<theme>\n  $$gap: 12px\n</theme>\n<style>\n  .local\n    $gap: 2px\n    padding: $gap\n  .other\n    margin: $gap\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /\.local\{padding:2px\}/, 'la portée locale garde la main chez elle')
    assert.match(data.baseCss, /\.other\{margin:12px\}/, 'ailleurs, la valeur du thème s\'applique')
  })

  it('une branche MORTE (`@if false`) ne désarme plus l\'adossage', async function () {
    const { data } = await transpile('<theme>\n  $$accent: #3b82f6\n</theme>\n<style>\n  .a\n    @if false\n      $accent: purple\n    color: $accent\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /\.a\{color:#3b82f6\}/)
  })

  it('témoin — une déclaration à la RACINE du <style>, elle, garde toujours la main', async function () {
    const { data } = await transpile('<theme>\n  $$gap: 12px\n</theme>\n<style>\n  $gap: 2px\n  .a\n    padding: $gap\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /\.a\{padding:2px\}/)
  })

  // --- les trous ouverts par les correctifs eux-mêmes ---

  it('une valeur à accolades NUES (`{a:1}`) est capturée entière', function () {
    const rw = rewriteStyleVars('$$config: {a:1}\n')
    assert.equal(rw.declared[0].value, '{a:1}')
  })

  it('le <theme> sort la valeur ENTIÈRE (`$$config` lu en `$$` marche)', async function () {
    const { data } = await transpile('<theme>\n  $$config: {a:1}\n</theme>\n<style>\n  .a\n    content: $$config\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /--mjs-config: ?\{a:1\}/, 'la déclaration ne doit plus être tronquée à `{a:1`')
  })

  it('un littéral `{…}` n\'est pas une expression SASS : l\'adossage échoue FRANCHEMENT', async function () {
    // limite de dart-sass, pas de la capture : `$x: {a:1}` n'est pas une valeur SASS légale. Ce qui
    // compte, c'est que ça crie (et en montrant la valeur), au lieu de sortir un CSS faux en silence
    await assert.rejects(
      () => transpile('<theme>\n  $$config: {a:1}\n</theme>\n<style>\n  .a\n    content: $config\n</style>\n<div>x</div>\n', { moduleName: 'card' }),
      /Expected expression/,
    )
  })

  it('une parenthèse jamais refermée ne fait plus fuiter le nom du voisin dans la valeur', function () {
    const rw = rewriteStyleVars('$$x: (1,2\n$$y: 5px\n$$z: 9px\n')
    assert.ok(!rw.declared[0].value.includes('--mjs-y'), `x ne doit pas avaler le nom de y (vu : ${JSON.stringify(rw.declared[0].value)})`)
    assert.ok(!rw.declared[1].value.includes('--mjs-z'), `y ne doit pas avaler le nom de z (vu : ${JSON.stringify(rw.declared[1].value)})`)
    assert.equal(rw.declared[2].value, '9px')
  })

  it('témoin — un `}` qui referme un bloc ouvert AVANT la déclaration la ferme bien (SCSS)', function () {
    const rw = rewriteStyleVars(':host {\n  $$gap: 12px }\n')
    assert.equal(rw.declared[0].value, '12px')
  })

  it('témoin — une accolade dans une CHAÎNE ne compte pas', function () {
    const rw = rewriteStyleVars('$$a: "{"\n$$b: 2px\n')
    assert.equal(rw.declared[0].value, '"{"')
    assert.equal(rw.declared[1].value, '2px')
  })

  it('en SCSS aussi, valeur close par le point-virgule', function () {
    const rw = rewriteStyleVars(':host {\n  $$gap: 12px; color: red;\n}')
    assert.equal(rw.declared[0].value, '12px')
  })
})
