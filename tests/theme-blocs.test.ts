// Bloc <theme> et passe `$$` des contextes de style.
//
// Ce que ces tests verrouillent, et pourquoi :
//   · UN SEUL préfixe — `$$gap` sort en `--mjs-gap` QUEL QUE SOIT le module. Le
//     renommage par composant (`--card-gap`) a été explicitement refusé : ce qui est
//     déclaré doit cascader dans toute la descendance et rester surchargeable.
//   · DOUBLE SÉLECTEUR — `:where(:host, mjs-x)` matche dans le shadow ET dans le
//     document (mode `mjs-light`), la liste indulgente ignorant l'item invalide de
//     chaque côté. Mesuré Firefox 1532 + Chromium 1228 avant d'écrire une ligne.
//   · LES CHAÎNES SONT SACRÉES — `content: "$$x"` reste littéral, sinon un texte
//     affiché à l'écran partirait en `var(...)`.
//   · UN FICHIER DE THÈME NE REND RIEN — il déclare, un point c'est tout : du HTML
//     ou un `<script>` dedans est une erreur, pas un silence.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'
import { compileThemeFile, assembleThemes, themeNameOf, isThemeFile } from '../src/bundler/themes.js'
import { rewriteStyleVars } from '../src/transpiler/style-vars.js'

describe('thèmes — bloc <theme> dans un composant', function () {
  it('pose les variables de thème sur un double sélecteur (shadow + mode light)', async function () {
    const { data } = await transpile('<theme>\n  $$gap: 12px\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /:where\(:host,mjs-card\)\{--mjs-gap: ?12px\}/)
  })

  it('une variante nommée sort sur un sélecteur d\'attribut', async function () {
    const { data } = await transpile('<theme name="gold">\n  $$brand: gold\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /:where\(:host\(\[theme=.?gold.?\]\),mjs-card\[theme=.?gold.?\]\)\{--mjs-brand: ?gold\}/)
    assert.deepEqual(data.themeVariants, ['gold'])
  })

  // une balise de SECTION n'atteint jamais le DOM : un
  // attribut qu'elle ne reconnaît pas est désormais une ERREUR de compilation, plus un
  // retrait silencieux. `<theme>` n'accepte que `name` et `lang` (checkSectionAttrs, sections.ts).
  it('`extends` sur `<theme>` : ERREUR de compilation, attribut inconnu (seuls `name` et `lang`)', async function () {
    await assert.rejects(
      () => transpile('<theme name="gold" extends="dark">\n  $$brand: gold\n</theme>\n<div>x</div>\n', { moduleName: 'card' }),
      (err: any) => {
        assert.match(err.message, /<theme extends>/, 'nomme la balise et l\'attribut fautif')
        assert.match(err.message, /name, lang/, 'énumère les deux seuls attributs attendus')
        return true
      },
    )
  })

  it('AUCUN préfixe de module : deux composants déclarent le MÊME nom de variable', async function () {
    const a = await transpile('<theme>\n  $$gap: 12px\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    const b = await transpile('<theme>\n  $$gap: 4px\n</theme>\n<div>x</div>\n', { moduleName: 'list' })
    assert.ok(a.data.baseCss.includes('--mjs-gap'), 'card doit écrire --mjs-gap')
    assert.ok(b.data.baseCss.includes('--mjs-gap'), 'list doit écrire --mjs-gap AUSSI (pas de --list-gap)')
    assert.ok(!a.data.baseCss.includes('--card-'), 'aucun préfixe dérivé du nom de module')
    assert.ok(!b.data.baseCss.includes('--list-'), 'aucun préfixe dérivé du nom de module')
  })

  it('`$$x` dans un <style> est une LECTURE', async function () {
    const { data } = await transpile('<style>\n  :host\n    gap: $$gap\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /gap:var\(--mjs-gap\)/)
  })

  it('un `$$` dans une CHAÎNE reste littéral', async function () {
    const { data } = await transpile('<style>\n  :host::after\n    content: "$$pas-touche"\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.ok(data.baseCss.includes('"$$pas-touche"'), `chaîne réécrite à tort : ${data.baseCss}`)
  })

  // SYNTAXE UNIFIÉE — surcharger depuis un <style> s'écrivait
  // `--mjs-panel-accent: #f472b6`, avec le préfixe à la main, alors que LIRE s'écrivait
  // `$$panel-accent`. Une seule notion, deux écritures : supprimé. `$$x: valeur` en tête de
  // ligne DÉCLARE partout, et c'est le compilateur qui pose le préfixe.
  it('déclarer un `$$` dans <style> SURCHARGE la variable de thème', async function () {
    const { data } = await transpile('<style>\n  :host\n    $$gap: 12px\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /--mjs-gap: ?12px/)
    assert.ok(!data.baseCss.includes('$$gap'), `le $$ n'a pas été réécrit : ${data.baseCss}`)
  })

  it('la surcharge marche dans un sélecteur IMBRIQUÉ, comme en CSS', async function () {
    const { data } = await transpile('<style>\n  strong\n    color: $$panel-accent\n\n    &.alt-accent\n      $$panel-accent: #f472b6\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /color:var\(--mjs-panel-accent\)/)
    assert.match(data.baseCss, /strong\.alt-accent\{--mjs-panel-accent: ?#f472b6\}/)
  })

  it('lecture et déclaration cohabitent sur la même ligne', async function () {
    const { data } = await transpile('<style>\n  :host\n    $$hover: $$brand\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /--mjs-hover: ?var\(--mjs-brand\)/)
  })

  // `::` n'est pas `:` — la règle dit « suivi de DEUX-POINTS », pas « d'un ou deux ». Sans ce
  // garde, `$$x::after` en tête de ligne sortait en `--mjs-x::after` : une propriété custom sans
  // valeur exploitable, muette à l'écran.
  it('`$$x::after` en tête de ligne reste une LECTURE — et fait échouer le build, jamais un CSS muet', async function () {
    await assert.rejects(() => transpile('<style>\n  $$sel::after\n    content: ""\n</style>\n<div>x</div>\n', { moduleName: 'card' }))
  })

  // LIMITE ASSUMÉE — une surcharge se pose sur ce qui matche un sélecteur, donc il en faut un.
  // Hors sélecteur c'était SASS qui refusait, avec un « Expected identifier » cryptique devant
  // une ligne parfaitement raisonnable ; désormais le compilateur reconnaît le cas et
  // dit quoi faire. Racine = colonne 0 (SASS indenté) ET aucune accolade ouverte (SCSS/CSS).
  it('une déclaration à la racine du <style> est refusée par MJS, avec le remède', async function () {
    await assert.rejects(() => transpile('<style>\n$$gap: 12px\n</style>\n<div>x</div>\n', { moduleName: 'card' }), /\$\$gap est déclaré à la racine du <style> \(ligne 2\).*besoin d'un sélecteur/s)
  })

  it('le message nomme le VARIANT quand la faute est dans un <style name>', async function () {
    await assert.rejects(() => transpile('<style name="bandeau">\n$$gap: 12px\n</style>\n<div>x</div>\n', { moduleName: 'card' }), /racine du <style name="bandeau">/)
  })

  it('en SCSS, la racine se mesure aux ACCOLADES, pas à l\'indentation', async function () {
    const { data } = await transpile('<style lang="scss">\nstrong {\n$$gap: 4px;\n}\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /strong\{--mjs-gap: ?4px\}/)
    await assert.rejects(() => transpile('<style lang="scss">\n$$gap: 4px;\n</style>\n<div>x</div>\n', { moduleName: 'card' }), /racine du <style>/)
  })

  it('dans un <theme>, la déclaration à plat reste LA norme', async function () {
    const { data } = await transpile('<theme>\n$$gap: 12px\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /--mjs-gap: ?12px/)
  })

  it('le préfixe suit la config `varPrefix`', async function () {
    const { data } = await transpile('<theme>\n  $$brand: red\n</theme>\n<div>x</div>\n', { moduleName: 'card', varPrefix: 'app' })
    assert.match(data.baseCss, /--app-brand/)
    assert.ok(!data.baseCss.includes('--mjs-brand'))
  })

  it('deux blocs sans nom = erreur ; deux noms différents = accepté', async function () {
    await assert.rejects(() => transpile('<theme>\n  $$a: 1\n</theme>\n<theme>\n  $$b: 2\n</theme>\n<div>x</div>\n', { moduleName: 'card' }), /deux blocs <theme>/)
    const { data } = await transpile('<theme>\n  $$a: 1px\n</theme>\n<theme name="gold">\n  $$b: 2px\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.ok(data.baseCss.includes('--mjs-a') && data.baseCss.includes('--mjs-b'))
  })

  it('le registre remonte les variables déclarées, leur ligne et leur commentaire', async function () {
    const { data } = await transpile('<theme>\n  // couleur d\'accent\n  $$brand: gold\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.equal(data.themeVars.length, 1)
    assert.equal(data.themeVars[0].name, 'brand')
    assert.equal(data.themeVars[0].doc, 'couleur d\'accent')
    assert.equal(data.themeVars[0].variant, '')
  })

  it('le HTML du composant survit intact à côté des blocs', async function () {
    const { data } = await transpile('<theme>\n  $$a: 1px\n</theme>\n<div class="card">salut</div>\n', { moduleName: 'card' })
    assert.match(data.surgicalHtml, /salut/)
    assert.ok(!data.surgicalHtml.includes('$$a'), 'le bloc <theme> ne doit pas fuir dans le HTML')
  })
})

describe('thèmes — fichiers *.theme.mjs', function () {
  it('reconnaît un fichier de thème et en déduit le nom', function () {
    assert.equal(isThemeFile('/app/themes/sombre.theme.mjs'), true)
    assert.equal(isThemeFile('/app/card.mjs'), false)
    assert.equal(themeNameOf('/app/themes/sombre.theme.mjs'), 'sombre')
  })

  it('émet un sélecteur d\'attribut SANS :root — c\'est ce qui permet les thèmes imbriqués', function () {
    const th = compileThemeFile('<theme>\n  $$surface: #232936\n</theme>\n', '/app/sombre.theme.mjs')
    assert.ok(!th.css.includes(':root'), `le :root doit avoir disparu : ${th.css}`)
    assert.match(th.css, /\[data-mjs-theme=.?sombre.?\]/)
    assert.match(th.css, /\[theme=.?sombre.?\]/)
    assert.equal(th.name, 'sombre')
  })

  it('le thème par DÉFAUT vaut aussi sans attribut (:root)', function () {
    const th = compileThemeFile('<theme>\n  $$surface: #fff\n</theme>\n', '/app/light.theme.mjs', { defaultTheme: 'light' })
    assert.match(th.css, /:where\(:root\)/)
  })

  it('refuse ce qui n\'est pas une déclaration de variables', function () {
    assert.throws(() => compileThemeFile('<theme>\n  $$a: 1px\n</theme>\n<div>coucou</div>\n', '/app/x.theme.mjs'), /contient du HTML/)
    assert.throws(() => compileThemeFile('<style>\n  :host\n    color: red\n</style>\n', '/app/x.theme.mjs'), /aucun bloc <theme>/)
    assert.throws(() => compileThemeFile('<theme name="gold">\n  $$a: 1px\n</theme>\n', '/app/x.theme.mjs'), /le nom vient du FICHIER/)
  })

  // fichiers de thème — « le fichier ne contient QUE des blocs <theme> (+ commentaires) » :
  // TOLÉRÉ (commentaire HTML et blanc autour) vs REFUSÉ (tout le reste), les deux côtés.
  it('TOLÉRÉ — un commentaire HTML avant le bloc <theme> compile normalement', function () {
    const th = compileThemeFile('<!-- palette maison -->\n<theme>\n  $$surface: #232936\n</theme>\n', '/app/sombre.theme.mjs')
    assert.match(th.css, /--mjs-surface: ?#232936/)
  })

  it('TOLÉRÉ — commentaires HTML avant ET après le bloc <theme>', function () {
    const th = compileThemeFile('<!-- avant -->\n<theme>\n  $$a: 1px\n</theme>\n<!-- après -->\n', '/app/x.theme.mjs')
    assert.match(th.css, /--mjs-a: ?1px/)
  })

  it('REFUSÉ — un commentaire HTML ne sauve pas une vraie balise à côté', function () {
    assert.throws(() => compileThemeFile('<!-- ok -->\n<theme>\n  $$a: 1px\n</theme>\n<div>coucou</div>\n', '/app/x.theme.mjs'), /contient du HTML/)
  })

  it('REFUSÉ — du texte nu (pas un commentaire) hors du bloc reste une erreur', function () {
    assert.throws(() => compileThemeFile('du texte\n<theme>\n  $$a: 1px\n</theme>\n', '/app/x.theme.mjs'), /contient du HTML/)
  })

  it('le thème par défaut sort EN PREMIER — sinon son :root reprend la main sur <html>', function () {
    const dark  = compileThemeFile('<theme>\n  $$page: #171b24\n</theme>\n', '/app/dark.theme.mjs',  { defaultTheme: 'light' })
    const gold  = compileThemeFile('<theme>\n  $$page: #e0a526\n</theme>\n', '/app/gold.theme.mjs',  { defaultTheme: 'light' })
    const light = compileThemeFile('<theme>\n  $$page: #f4f6f9\n</theme>\n', '/app/light.theme.mjs', { defaultTheme: 'light' })
    const css   = assembleThemes([dark, gold, light], 'light')
    assert.ok(css.indexOf(':where(:root)') < css.indexOf('data-mjs-theme=dark'), `le défaut (porteur du :root) doit précéder les autres : ${css}`)
    assert.ok(css.indexOf('data-mjs-theme=dark') < css.indexOf('data-mjs-theme=gold'), 'le reste reste alphabétique (CSS reproductible)')
  })

  // un thème n'émet QUE ce qu'il déclare : le reste descend depuis au-dessus (calque, esprit CSS)
  it('un thème n\'APLATIT rien : il n\'émet que ce qu\'il déclare', function () {
    const clair  = compileThemeFile('<theme>\n  $$a: 1px\n  $$b: 2px\n</theme>\n', '/app/clair.theme.mjs')
    const sombre = compileThemeFile('<theme>\n  $$a: 9px\n</theme>\n', '/app/sombre.theme.mjs')
    assert.ok(sombre.css.includes('--mjs-a'), 'sombre déclare bien a')
    assert.ok(!sombre.css.includes('--mjs-b'), 'sombre ne recopie PAS le b de clair — il le laisse descendre')
    assert.ok(clair.css.includes('--mjs-b'))
  })

  // même contrat pour un fichier *.theme.mjs : `extends`
  // n'est plus retiré en silence, compileThemeFile refuse de compiler avec attribut inconnu.
  it('`extends` sur `<theme>` (*.theme.mjs) : ERREUR de compilation, attribut inconnu (seuls `name` et `lang`)', function () {
    assert.throws(
      () => compileThemeFile('<theme extends="dark">\n  $$brand: #d4af37\n</theme>\n', '/app/gold.theme.mjs'),
      (err: any) => {
        assert.match(err.message, /<theme extends>/, 'nomme la balise et l\'attribut fautif')
        assert.match(err.message, /name, lang/, 'énumère les deux seuls attributs attendus')
        return true
      },
    )
  })
})

// ----------------------------------------------------------------------------
// COMMENTAIRE `//` EN FIN DE LIGNE DE DÉCLARATION (défaut trouvé)
//
// dart-sass ne parse PAS la valeur d'une custom property : elle passe telle quelle,
// `//` compris. Sur `color: red // note` il retire le commentaire ; sur
// `--mjs-accent: #3b82f6 // note` il le GARDE, la valeur devient invalide, et le
// `var()` qui la lit retombe muettement à sa valeur initiale. Le `<theme>` n'écrit
// QUE des custom properties : il prenait le défaut de plein fouet — mais un `<style>`
// qui déclare `--x` ou `$$x` sous un sélecteur le prenait tout autant.
// ----------------------------------------------------------------------------
describe('thèmes — commentaire `//` en fin de ligne de déclaration', function () {
  it('<theme> : le commentaire de fin de ligne ne part PAS dans la valeur', async function () {
    const { data } = await transpile('<theme>\n  $$accent: #3b82f6   // palette de base\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.ok(!data.baseCss.includes('//'), `la valeur emporte le commentaire : ${data.baseCss}`)
    assert.match(data.baseCss, /--mjs-accent: ?#3b82f6\}/)
  })

  it('<theme> : une custom property écrite en clair est protégée pareil', async function () {
    const { data } = await transpile('<theme>\n  --panel-bg: #1b2230   // fond\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.ok(!data.baseCss.includes('//'), `la valeur emporte le commentaire : ${data.baseCss}`)
    assert.match(data.baseCss, /--panel-bg: ?#1b2230\}/)
  })

  it('<style> : `$$x: v // note` sous un sélecteur est protégé aussi', async function () {
    const { data } = await transpile('<style>\n  .a\n    $$accent: #3b82f6   // note\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.ok(!data.baseCss.includes('//'), `la valeur emporte le commentaire : ${data.baseCss}`)
  })

  it('<style> : `--x: v // note` sous un sélecteur est protégé aussi', async function () {
    const { data } = await transpile('<style>\n  .a\n    --x: 4px   // note\n    padding: var(--x)\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.ok(!data.baseCss.includes('//'), `la valeur emporte le commentaire : ${data.baseCss}`)
    assert.match(data.baseCss, /--x: ?4px;/)
  })

  it('lang="css" : même protection, `//` n\'y a jamais été un commentaire', async function () {
    const { data } = await transpile('<theme lang="css">\n  $$accent: #3b82f6   // palette\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.ok(!data.baseCss.includes('//'), `la valeur emporte le commentaire : ${data.baseCss}`)
  })

  it('TÉMOIN — `url(http://…)` n\'est pas un commentaire et survit intact', async function () {
    const { data } = await transpile('<theme>\n  $$bg: url(http://a.tld/x.png)\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /--mjs-bg: ?url\(http:\/\/a\.tld\/x\.png\)/)
  })

  it('TÉMOIN — un `//` DANS une chaîne reste littéral', async function () {
    const { data } = await transpile('<theme>\n  $$sep: "a // b"\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /--mjs-sep: ?"a \/\/ b"/)
  })

  it('TÉMOIN — un commentaire SEUL sur sa ligne continue d\'être retiré', async function () {
    const { data } = await transpile('<theme>\n  // palette\n  $$accent: #3b82f6\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.ok(!data.baseCss.includes('//'), `le commentaire seul doit sauter : ${data.baseCss}`)
    assert.match(data.baseCss, /--mjs-accent: ?#3b82f6/)
  })

  it('TÉMOIN — un commentaire `/* */` de fin de ligne reste (CSS valide, retiré par le navigateur)', async function () {
    const { data } = await transpile('<theme>\n  $$accent: #3b82f6   /* palette */\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /--mjs-accent: ?#3b82f6 ?\/\* palette \*\//)
  })

  it('TÉMOIN — sur une propriété ORDINAIRE, dart-sass retirait déjà le commentaire', async function () {
    const { data } = await transpile('<style>\n  .a\n    color: red   // note\n</style>\n<div>x</div>\n', { moduleName: 'card' })
    assert.equal(data.baseCss.trim(), '.a{color:red}')
  })

  // Les deux morsures trouvées ensuite : le retrait ne doit pas manger
  // une VALEUR qui commence par `//` (URL sans protocole), ni se déclencher sur une ligne
  // qui n'est pas la sienne (le scanner ne rafraîchissait pas `lineStart` en traversant un
  // commentaire de bloc multi-lignes — un `--x:` d'AVANT le bloc faisait alors autorité).
  it('une URL SANS PROTOCOLE en valeur survit — `//` y ouvre la valeur, pas un commentaire', async function () {
    const { data } = await transpile('<theme>\n  --cdn: //cdn.exemple.tld/lib.js\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(data.baseCss, /--cdn: ?\/\/cdn\.exemple\.tld\/lib\.js/)
  })

  it('idem en `$$`, et idem avec plusieurs blancs après le deux-points', async function () {
    const a = await transpile('<theme>\n  $$cdn: //cdn.exemple.tld/lib.js\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    const b = await transpile('<theme>\n  $$cdn:    //cdn.exemple.tld/lib.js\n</theme>\n<div>x</div>\n', { moduleName: 'card' })
    assert.match(a.data.baseCss, /--mjs-cdn: ?\/\/cdn\.exemple\.tld\/lib\.js/)
    assert.match(b.data.baseCss, /--mjs-cdn: ?\/\/cdn\.exemple\.tld\/lib\.js/)
  })

  it('un commentaire de bloc MULTI-LIGNES ne déplace plus l\'autorité de la ligne', function () {
    const rw = rewriteStyleVars('.foo {\n  --x: red; /* multi\nligne\ncomm */ background: red // vrai commentaire\n}\n')
    assert.ok(rw.code.includes('// vrai commentaire'), `le commentaire d\'une AUTRE ligne ne doit pas être mangé : ${JSON.stringify(rw.code)}`)
  })

  it('et la ligne d\'après retrouve sa vraie ligne source', function () {
    const rw = rewriteStyleVars('$$a: 1px\n/* bloc\nmulti */\n$$b: 2px\n')
    assert.deepEqual(rw.declared.map(d => [d.name, d.line]), [['a', 1], ['b', 4]])
  })
})
