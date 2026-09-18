// DURCI : un 2e bloc <script module>/<script>/<style> lève désormais une ERREUR DE COMPILATION (avant : un simple warning, non fatal).
//
// Test de régression :
// `extractSections` (utilisée pour le composant RACINE ET pour chaque partial
// `<@include>`) ne gardait que le PREMIER `<script module>`, PREMIER
// `<script>` (hors module), et PREMIER `<style>` trouvés — un 2e bloc de
// n'importe laquelle de ces catégories était PERTE DE CODE SILENCIEUSE :
// aucun warning, aucune erreur, le build restait vert alors que le composant
// est réellement incomplet.
//
// Fix : `extractSections` gagnait un simple `warnings: string[]`
// (non vide dès qu'une catégorie a plus d'UNE occurrence) — le comportement de
// garder SEULEMENT la 1ʳᵉ restait inchangé, on signalait sans casser le build.
//
// Durcissement (décision explicite) : un warning reste un style
// perdu à l'insu du dev s'il ne lit pas les logs — un doublon lève maintenant
// `throw new Error(...)`, build ROUGE explicite. `warnings` ne reçoit donc plus
// jamais rien depuis `extractSections` (champ conservé vide — d'autres maillons
// de la chaîne le lisent encore, cf. sections.ts). Composant racine ET partial
// <@include> sont concernés (même fonction `extractSections` pour les deux) ;
// pour un partial, `getSections` (macros.ts) re-throw l'erreur préfixée de son
// `<@include target>` — même précision que l'ancien enrobage des warnings :
// l'erreur nomme le composant parent (enrobage bundler) ET le partial fautif.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { extractSections } from '../src/transpiler/sections.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('extractSections — 2e <script>/<style> lève une erreur de compilation (pas silencieusement jeté)', function () {
  it('2 <script> (hors module) : throw nommant le compte', () => {
    assert.throws(
      () => extractSections(`
<script>
premier = 1
</script>
<p>x</p>
<script>
second = 2
</script>
`),
      /\[ModularJS\] 2 balises <script>/,
    )
  })

  it('2 <style> : throw nommant le compte', () => {
    assert.throws(
      () => extractSections(`<style>\n.a{color:red}\n</style>\n<p>x</p>\n<style>\n.b{color:blue}\n</style>\n`),
      /\[ModularJS\] 2 balises <style>/,
    )
  })

  it('2 <script module> : throw nommant le compte', () => {
    assert.throws(
      () => extractSections(`<script module>\npremier := 1\n</script>\n<script module>\nsecond := 2\n</script>\n<p>x</p>\n`),
      /\[ModularJS\] 2 balises <script module>/,
    )
  })

  it('cas nominal (1 seul de chaque) : aucune erreur, warnings vide (pas de régression)', () => {
    const r = extractSections(`<script module>\nx := 1\n</script>\n<script>\ny = 2\n</script>\n<style>\n.a{}\n</style>\n<p>ok</p>\n`)
    assert.match(r.module.raw, /x := 1/)
    assert.match(r.script.raw, /y = 2/)
    assert.deepEqual(r.warnings, [])
  })
})

describe('bundler — doublon de section propagé dans stats.errors (build ROUGE)', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant racine avec 2 <style> : stats.errors contient le message (build ROUGE, erreur de compilation)', async function () {
    const root = mjsTmp('section-warn-comp')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<p class="x">contenu</p>',
      '<style lang="css">',    // lang="css" explicite : le défaut sass-indenté rejetterait cette syntaxe à accolades (hors sujet ici)
      '.x { color: red; }',
      '</style>',
      '<style lang="css">',
      '.x { color: blue; }',
      '</style>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.ok(
      stats.errors.some(e => e.message.includes('comp.mjs') && /\[ModularJS\] 2 balises <style>/.test(e.message)),
      `un 2e <style> doit désormais faire échouer le build. errors: ${JSON.stringify(stats.errors.map(e => e.message))}`,
    )
    assert.ok(!stats.warnings.some(w => /balises</.test(w)), 'plus émis en warning depuis le durcissement')
    await bundler.close()
  })

  it('partial <@include> avec 2 <script> : l\'erreur nomme le partial fautif (<@include widget>) ET le parent', async function () {
    const root = mjsTmp('section-warn-partial')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, '_widget.mjs'), [
      '<p>widget</p>',
      '<script>',
      'a = 1',
      '</script>',
      '<script>',
      'b = 2',
      '</script>',
    ].join('\n'))
    writeFileSync(join(srcDir, 'page.mjs'), '<@include widget>\n<p>page</p>\n')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    // Message attendu : `[bundler] …/page.mjs: <@include widget> : [ModularJS] 2
    // balises <script> …` — le parent via l'enrobage bundler, le partial fautif
    // via le re-throw préfixé de `getSections` (macros.ts). Sans ce dernier, le
    // throw brut d'extractSections ne nommait QUE le parent (régression de
    // précision vs l'ancien warning, corrigée).
    assert.ok(
      stats.errors.some(e => e.message.includes('page.mjs') && /<@include widget> :/.test(e.message) && /\[ModularJS\] 2 balises <script>/.test(e.message)),
      `l'erreur doit nommer le partial fautif ET le parent. errors: ${JSON.stringify(stats.errors.map(e => e.message))}`,
    )
    await bundler.close()
  })

  it('cas nominal (aucun doublon) : aucune erreur, aucun warning de section (pas de régression)', async function () {
    const root = mjsTmp('section-warn-ok')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>ok</p>\n<style>\n.a{color:red}\n</style>\n')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.ok(!stats.warnings.some(w => /balises</.test(w)), `warnings: ${JSON.stringify(stats.warnings)}`)
    await bundler.close()
  })
})

// FIX faille lexer de sections — un `</script>`/`</style>` DANS un
// LITTÉRAL (chaîne, heredoc, commentaire) du code tronquait l'extraction de
// section (les 4 regex matchaient à plat, aveugles au contexte). Voir
// src/transpiler/sections.ts (vues masquées `maskedCivet`/`maskedStyle`) et
// src/lexer/index.ts (`maskInertSameLength`).
describe('extractSections — `</script>`/`</style>` dans un littéral ne tronque plus l\'extraction', () => {
  it('`</script>` dans une chaîne double : script.raw complet, html sans résidu', () => {
    const r = extractSections(`<p>avant</p>\n<script>\nx = "</script>"\ny = 2\n</script>\n<p>après</p>\n`)
    assert.match(r.script.raw, /x = "<\/script>"/)
    assert.match(r.script.raw, /y = 2/)
    assert.doesNotMatch(r.html, /<\/script>/)
    assert.match(r.html, /avant/)
    assert.match(r.html, /après/)
  })

  it('`</script>` dans une chaîne simple : script.raw complet', () => {
    const r = extractSections(`<script>\nx = '</script>'\ny = 2\n</script>\n`)
    assert.match(r.script.raw, /x = '<\/script>'/)
    assert.match(r.script.raw, /y = 2/)
  })

  it('`</script>` dans un heredoc """…""" : script.raw complet', () => {
    const src = `<script>\nx = """\ntexte avec </script> dedans\n"""\ny = 2\n</script>\n`
    const r = extractSections(src)
    assert.match(r.script.raw, /texte avec <\/script> dedans/)
    assert.match(r.script.raw, /y = 2/)
  })

  it('`</script>` dans un commentaire `#…` : script.raw complet', () => {
    const r = extractSections(`<script>\n# commentaire </script> ici\ny = 2\n</script>\n`)
    assert.match(r.script.raw, /y = 2/)
    assert.match(r.script.raw, /commentaire <\/script> ici/)
  })

  it('`</script>` dans un bloc `###…###` : script.raw complet', () => {
    const r = extractSections(`<script>\n###\nbloc </script> commenté\n###\ny = 2\n</script>\n`)
    assert.match(r.script.raw, /y = 2/)
    assert.match(r.script.raw, /bloc <\/script> commenté/)
  })

  it('`</style>` dans une chaîne SASS : style.raw complet', () => {
    const r = extractSections(`<style lang="scss">\ncontent: "</style>";\n.a { color: red; }\n</style>\n`)
    assert.match(r.style.raw, /content: "<\/style>";/)
    assert.match(r.style.raw, /\.a \{ color: red; \}/)
    assert.equal(r.style.lang, 'scss')
  })

  it('style monoligne + `#123` (couleur hex) suivi d\'autre chose sur la même ligne : pas de sur-masquage', () => {
    const r = extractSections(`<style>\np\n  color: #123 solid\n</style>\n`)
    assert.match(r.style.raw, /color: #123 solid/)
  })

  it('lang="civet" et lang="scss" toujours détectés (attrs originaux, même avec littéral dans le corps)', () => {
    const rScript = extractSections(`<script lang="civet">\nx = "</script>"\n</script>\n`)
    assert.equal(rScript.script.lang, 'civet')
    const rStyle = extractSections(`<style lang="scss">\ncontent: "</style>";\n</style>\n`)
    assert.equal(rStyle.style.lang, 'scss')
  })

  it('1 vrai bloc <script> + `</script>` en chaîne : PAS de throw', () => {
    assert.doesNotThrow(() => extractSections(`<script>\nx = "</script>"\ny = 2\n</script>\n`))
  })

  it('2 vrais blocs <script> : throw toujours levé (pas contourné par le masquage)', () => {
    assert.throws(
      () => extractSections(`<script>\nx = "</script>"\npremier = 1\n</script>\n<script>\nsecond = 2\n</script>\n`),
      /\[ModularJS\] 2 balises <script>/,
    )
  })

  it('<@head> contenant un <script src> : toujours masqué/restauré (non-régression)', () => {
    const r = extractSections(`<@head>\n<script src="https://cdn.example.com/analytics.js"></script>\n</@head>\n<script>\nz = 3\n</script>\n<p>hi</p>\n`)
    assert.match(r.script.raw, /z = 3/)
    assert.match(r.html, /analytics\.js/)
  })
})

// GARDE-FOU reliquats lexer — 2 corruptions restaient SILENCIEUSES
// malgré le masquage ci-dessus : (a) backtick imbriqué dans une interpolation,
// (b) chaîne non terminée contenant `</script>` par erreur de frappe. Les deux
// tronquent la vraie section <script> et laissent fuir un `</script>` orphelin
// dans le HTML résiduel — désormais détecté après extraction et levé en throw.
describe('extractSections — `</script>`/`</style>` orphelin dans le HTML résiduel : throw clair', () => {
  // CAS (a) RÉSOLU À LA SOURCE : le masquage des littéraux
  // repose désormais sur un lecteur à niveaux (cf. lexer-backtick-imbrique.test.ts),
  // le backtick imbriqué est correctement refermé et l'extraction ne part plus en
  // vrille. Le garde-fou n'a donc plus rien à rattraper ici — il reste en poste
  // pour les cas (b) et (c) ci-dessous.
  it('backtick imbriqué dans une interpolation (`…${`</script>`}…`) : extraction CORRECTE, plus de throw', () => {
    const r = extractSections('<script>\nx = `foo ${`</script>`} bar`\ny = 2\n</script>\n<p>hi</p>\n')
    assert.match(r.script.raw, /y = 2/)
    assert.match(r.html, /<p>hi<\/p>/)
  })

  it('chaîne simple non terminée contenant `</script>` (typo) : throw clair', () => {
    assert.throws(
      () => extractSections("<script>\nx = 'foo </script>\ny = 2\n</script>\n"),
      /\[ModularJS\] un <\/script> orphelin traîne dans le HTML du composant/,
    )
  })

  it('non-régression : composant normal complet (module + script + style + html) ne throw pas', () => {
    assert.doesNotThrow(() => extractSections(
      '<script module>\nx := 1\n</script>\n<script>\ny = 2\n</script>\n<style>\n.a{color:red}\n</style>\n<p>ok {$y}</p>\n',
    ))
  })
})

// Un BOM (U+FEFF) en tête de
// fichier (PowerShell `Out-File`/Notepad) empêchait `^[ \t]*<script…` de
// matcher : aucune section trouvée, tout partait en HTML, throw trompeur
// (message backtick/chaîne non fermée). Strippé en tête d'`extractSections`.
describe('extractSections — BOM (U+FEFF) en tête de fichier', () => {
  it('BOM en tête : sections extraites normalement (pas de throw, pas de fuite en HTML)', () => {
    const src = '﻿<script>\nx = 1\n</script>\n<div>hi</div>\n'
    const r = extractSections(src)
    assert.match(r.script.raw, /x = 1/)
    assert.match(r.html, /<div>hi<\/div>/)
    assert.doesNotMatch(r.html, /<\/script>/)
  })

  it('BOM + module/script/style complets : rien n\'est perdu', () => {
    const src = '﻿<script module>\nx := 1\n</script>\n<script>\ny = 2\n</script>\n<style>\n.a{color:red}\n</style>\n<p>ok</p>\n'
    const r = extractSections(src)
    assert.match(r.module.raw, /x := 1/)
    assert.match(r.script.raw, /y = 2/)
    assert.match(r.style.raw, /\.a\{color:red\}/)
    assert.match(r.html, /<p>ok<\/p>/)
  })
})

// `<SCRIPT>`/`<Script>` (casse à
// l'ouverture) : les 3 regex d'extraction sont sensibles à la casse, donc pas
// reconnues comme section ; l'orphan-guard (case-insensible) intercepte QUAND
// MÊME la fuite (pas silencieux), mais son message doit nommer la vraie cause
// (choix conservateur : message enrichi plutôt que regex d'extraction en `i`,
// cf. commentaire dans sections.ts).
describe('extractSections — balise d\'ouverture en majuscules (<SCRIPT>) : throw avec message clair', () => {
  it('<SCRIPT>…</script> : throw mentionnant la casse (pas juste backtick/chaîne)', () => {
    assert.throws(
      () => extractSections('<SCRIPT>\nx = 1\n</script>\n<p>hi</p>\n'),
      /\[ModularJS\] un <\/script> orphelin.*majuscules non reconnue/s,
    )
  })
})

// Le masquage <pre>/<code>
// de l'orphan-guard (jadis introduit ici) a été RETIRÉ : sa regex LAZY sans vérification
// d'appariement masquait à
// travers un `<pre>` NON FERMÉ, avalant au passage une vraie fuite
// d'extraction (FAUX NÉGATIF) — cf. commentaire sections.ts. Le
// garde est désormais STRICT : un `</script>`/`</style>` orphelin throw
// TOUJOURS, y compris dans un `<pre>`/`<code>`. Le faux positif que le
// masquage couvrait (`</script>` LITTÉRAL non échappé affiché en texte) est à
// ZÉRO occurrence sur les 572 .mjs réels d'un site en production : tous échappent en
// `&lt;/script&gt;`.
describe('extractSections — orphan-guard STRICT (masquage <pre>/<code> retiré)', () => {
  it('RÉGRESSION couverte : <pre> non fermé + vraie fuite (chaîne non fermée avec </script>) + </pre> distant sans rapport : throw (aurait été un faux négatif silencieux avec le masquage lazy)', () => {
    const src = '<pre>doc non fermé\n<script>\nx = \'foo </script>\ny = 2\n</script>\n<p>texte</p>\n</pre>\n'
    assert.throws(
      () => extractSections(src),
      /\[ModularJS\] un <\/script> orphelin traîne dans le HTML du composant/,
    )
  })

  it('vraie fuite simple (chaîne tronquée avec </script>, sans <pre>) : throw (inchangé)', () => {
    assert.throws(
      () => extractSections("<script>\nx = 'foo </script>\ny = 2\n</script>\n"),
      /\[ModularJS\] un <\/script> orphelin traîne dans le HTML du composant/,
    )
  })

  it('composant normal : vrai <script>+</script> et <pre> bien fermé affichant du code ÉCHAPPÉ (&lt;/script&gt;) : PAS de throw (cas réel du corpus)', () => {
    const src = '<pre><code>&lt;/script&gt;literal</code></pre>\n<script>\ny = 2\n</script>\n'
    const r = extractSections(src)
    assert.match(r.html, /<pre><code>&lt;\/script&gt;literal<\/code><\/pre>/)
    assert.match(r.script.raw, /y = 2/)
  })

  it('<pre><code></script>literal</code></pre> NON échappé : désormais throw (comportement strict voulu — 0 occurrence réelle)', () => {
    const src = '<pre><code></script>literal</code></pre>\n<script>\ny = 2\n</script>\n'
    assert.throws(
      () => extractSections(src),
      /\[ModularJS\] un <\/script> orphelin traîne dans le HTML du composant/,
    )
  })

  // La « vraie fuite » de ce test était le backtick imbriqué, corrigé à la
  // source. On garde le même composant (avec son <pre>/<code>) mais on le teste
  // sur la fuite qui, elle, subsiste : la chaîne non terminée.
  it('non-régression : une VRAIE fuite (chaîne non terminée) throw toujours, même si le composant a par ailleurs un <pre>/<code> bien formé', () => {
    const src = "<pre><code>doc</code></pre>\n<script>\nx = 'foo </script>\ny = 2\n</script>\n"
    assert.throws(
      () => extractSections(src),
      /\[ModularJS\] un <\/script> orphelin traîne dans le HTML du composant/,
    )
  })
})
