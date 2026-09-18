// Panne MUETTE : une chaîne JAMAIS refermée dans un attribut faisait compiler le
// composant « avec succès » et rendre du VIDE. `extractBalanced` (src/parser/index.ts) consommait
// jusqu'à la fin du fichier et retournait sans jamais signaler que le délimiteur n'était pas fermé :
// l'expression avalait tout le reste du HTML, le template devenait `""`, le nœud entier disparaissait
// sans un mot. Une compilation verte qui rend un composant vide est le pire signal possible.
//
// Remède : sortie de boucle par fin de fichier avec une chaîne ouverte ou une accolade non refermée
// → erreur de compilation, avec la ligne de l'OUVERTURE.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../src/parser/index.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('délimiteur non fermé — la compilation ne peut plus être verte sur du vide', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  async function compileComp(html: string): Promise<{ errors: string[]; code: string | null }> {
    const root   = mjsTmp('unclosed')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), html)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    let code: string | null = null
    if (stats.errors.length === 0) {
      const compFile = readdirSync(outDir).find(f => /^comp-/.test(f))
      if (compFile) code = readFileSync(join(outDir, compFile), 'utf-8')
    }
    await bundler.close()
    return { errors: stats.errors.map(e => e.message), code }
  }

  // les 4 formes mesurées : 0 erreur, template `""`, nœud disparu
  const FORMES: Array<[string, string]> = [
    ['@flip',        "<li @flip={duration: 300, easing: 'ab\\}>x</li>"],
    ['@style.prop',  "<div @style.color={'ab\\}>x</div>"],
    ['attribut nu',  "<div title={'ab\\}>x</div>"],
    ['@class{}',     "<div @class{'ab\\}>x</div>"],
  ]

  for (const [nom, html] of FORMES) {
    it(`${nom} — chaîne non refermée : erreur de compilation, plus de template vide`, async () => {
      const r = await compileComp(html)
      assert.equal(r.errors.length, 1, `attendu 1 erreur, obtenu ${r.errors.length} (code émis : ${r.code ? 'oui' : 'non'})`)
      assert.match(r.errors[0], /NON FERM/i)
      assert.match(r.errors[0], /ligne/i, 'le message doit situer l\'ouverture')
    })
  }

  it('accolade non refermée (sans chaîne) : erreur, pas de silence', () => {
    // aucun `}` nulle part : l'expression avale le reste du fichier
    assert.throws(() => parse('<div title={ f(1, 2 >x</div>'), /NON FERM/i)
    assert.throws(() => parse('<p>{ $a + $b</p>'), /NON FERM/i)
    // le `}` PRÉSENT ferme bien l'expression — pas de faux positif
    assert.equal(parse('<div title={ f(1, 2) }>x</div>').children[0].attrs[0].expr, ' f(1, 2) ')
  })

  // Le scanner de chaînes ne connaissait NI les littéraux regex NI les commentaires : un guillemet
  // dedans ouvrait une chaîne fantôme qui ne se refermait jamais. Avant la garde ces composants
  // rendaient du VIDE en silence (`_mjs_cloneTpl("")`, tout le document suivant avalé) ; avec la garde
  // seule, ils échouaient à la compilation. Les deux sont faux : ce sont des expressions valides.
  it('regex littérale portant un guillemet : compile, et le nœud est bien rendu', async () => {
    const r = await compileComp('<div title={$s.replace(/[\'"]/g, \'\')}>x</div>\n<p title="z">fin</p>')
    assert.deepEqual(r.errors, [])
    assert.match(r.code!, /<p title='z'>fin<\/p>/, 'le frère qui suit ne doit plus être avalé')
    assert.match(r.code!, /replace\(\/\['"\]\/g, ''\)/, 'la regex arrive INTACTE dans le code émis')
  })

  it('regex et commentaires dans une expression — parse sans chaîne fantôme', () => {
    assert.equal(parse("<div title={$s.replace(/['\"]/g, '')}>x</div>").children.length, 1)
    assert.equal(parse("<p>{ $a /* isn't finished */ + $b }</p>").children[0].children[0].expr, "$a /* isn't finished */ + $b")
    assert.equal(parse("<p>{ $a // c'est fini\n }</p>").children[0].children[0].expr, "$a // c'est fini")
    assert.equal(parse('<p>{ $s.match(/a\\/b/) }</p>').children[0].children[0].expr, '$s.match(/a\\/b/)')
    assert.equal(parse("<p>{ $s.split(/[/'\"]/) }</p>").children[0].children[0].expr, "$s.split(/[/'\"]/)")
  })

  it('une DIVISION reste une division (pas de regex fantôme qui avalerait la suite)', () => {
    assert.equal(parse('<p>{ $a / $b }<b>fin</b></p>').children[0].children.length, 2)
    assert.equal(parse('<p>{ $a / 2 } et { $c / 3 }</p>').children[0].children[0].expr, '$a / 2')
    assert.equal(parse('<p>{ f($x) / g($y) }<i>z</i></p>').children[0].children[1].name, 'i')
    assert.equal(parse('<p>{ $t[0] / $t[1] }<i>z</i></p>').children[0].children[1].name, 'i')
  })

  // Le motif de mots-clés matchait un ÉTAT nommé comme un mot-clé
  // (`$` et `.` ne sont pas des caractères de mot), et `++`/`--` étaient pris pour des opérateurs
  // préfixes — la division partait en regex et avalait le document (ou pire, capturait du garbage
  // refermé « par accident » sur un `}` de texte, l'erreur ne tombant qu'une couche plus loin).
  it('un état nommé comme un mot-clé JS divise toujours ($in, $of, $do, $obj.in)', () => {
    for (const nom of ['$in', '$of', '$do', '$new', '$case', '$obj.in', '$obj.of']) {
      assert.equal(parse(`<p>{ ${nom} / 2 }<b>fin</b></p>`).children[0].children.length, 2, nom)
      assert.equal(parse(`<p>{ ${nom} / 2 }</p>`).children[0].children[0].expr, `${nom} / 2`, nom)
    }
    assert.equal(parse('<div>{ $in / 2 }</div><p>caption</p>').children.length, 2)
    assert.equal(parse('<p>{ $in / 2 } a/b} tail</p>').children[0].children[0].expr, '$in / 2')
  })

  it('post-incrément suivi d\'une division : pas de regex fantôme', () => {
    assert.equal(parse('<p>{ $a++ / 2 }<b>fin</b></p>').children[0].children[0].expr, '$a++ / 2')
    assert.equal(parse('<p>{ $a-- / 2 }<b>fin</b></p>').children[0].children[0].expr, '$a-- / 2')
    assert.equal(parse('<p>{ ++$a / 2 }<b>fin</b></p>').children[0].children.length, 2)
  })

  it('le même piège sur les AUTRES points d\'appel (blocs, spread, slot)', () => {
    assert.equal((parse('{if $in / 2 > 1}<b>x</b>{end}').children[0] as any).branches[0].expr, '$in / 2 > 1')
    assert.equal(parse('{const total = $of / 2}<b>x</b>').children[0].expr, '$of / 2')
    assert.equal(parse('<div {...($in / 2)}>x</div>').children[0].attrs[0].expr, '($in / 2)')
    assert.equal(parse('<@slot {$in / 2}>').children[0].attrs[0].expr, '$in / 2')
  })

  // Régression — le scanner apprend `//` comme commentaire de LIGNE, qui court jusqu'au
  // saut de ligne. Sur la forme NATURELLE d'un attribut, tout tient sur une ligne : le `}` fermant
  // partait DANS le commentaire, l'expression n'était jamais refermée, et la garde toute neuve
  // levait sur du code qui compilait la veille. Le test d'origine ne couvrait que la forme avec
  // `\n` explicite avant le `}` — l'angle mort exact. Remède : un commentaire de ligne s'arrête
  // AUSSI sur le délimiteur fermant de l'expression, jamais il ne l'avale.
  it("commentaire `//` MONO-LIGNE : le `}` de fin n'est plus avalé", () => {
    assert.equal(parse('<div title={$x // texte explicatif}>bonjour</div>').children[0].attrs[0].expr, '$x // texte explicatif')
    assert.equal(parse('<div title={$x // texte explicatif}>bonjour</div>').children[0].children[0].content, 'bonjour')
    assert.equal(parse('<p>{ $a // fin de calcul }<b>suite</b></p>').children[0].children.length, 2)
    assert.equal(parse('<p>{ $a // fin }</p>').children[0].children[0].expr, '$a // fin')
    // les autres points d'appel : bloc, spread, slot, @class{}
    assert.equal((parse('{if $a // vrai ?}<b>x</b>{end}').children[0] as any).branches[0].expr, '$a // vrai ?')
    assert.equal(parse('<div {...($a // reste)}>x</div>').children[0].attrs[0].expr, '($a // reste)')
    assert.equal(parse("<div @class{$on ? 'a' : 'b' // bascule}>x</div>").children[0].name, 'div')
    // et la forme MULTI-ligne reste intacte : là, c'est bien le saut de ligne qui ferme le commentaire
    assert.equal(parse("<p>{ $a // c'est fini\n }</p>").children[0].children[0].expr, "$a // c'est fini")
    assert.equal(parse('<div title={\n  $x // note\n}>bonjour</div>').children[0].children[0].content, 'bonjour')
  })

  // MESURE — le `//` mono-ligne ne compilait de toute façon PAS : Civet refuse une
  // expression d'une seule ligne qui se termine par un commentaire (`comp.expr:1:26 Failed to
  // parse`). L'avaleur ne rendait donc pas du code vert rouge — il rendait un message MENSONGER
  // (« délimiteur non fermé », avec tout le reste du document dans l'extrait) à la place du vrai.
  // Ce que le remède garantit : le diagnostic redevient celui de l'expression elle-même.
  it('`//` mono-ligne : le diagnostic n\'est plus « NON FERMÉE » mais celui de l\'expression', async () => {
    const r = await compileComp('<div title={$x // texte explicatif}>bonjour</div>\n<script>\n$x = 1\n</script>\n')
    assert.equal(r.errors.length, 1)
    assert.doesNotMatch(r.errors[0], /NON FERM/i, 'plus de faux « délimiteur non fermé »')
    assert.match(r.errors[0], /Civet/i)
  })

  // le cas qui compile VRAIMENT : commentaire de ligne suivi de code sur la ligne d'après
  it('`//` multi-ligne avec du code APRÈS : compile toujours vert', async () => {
    const r = await compileComp('<div title={\n  $x // note\n  + 1\n}>bonjour</div>\n<script>\n$x = 1\n</script>\n')
    assert.deepEqual(r.errors, [])
    const r2 = await compileComp('<p>{ $x // note\n  + 1 }</p>\n<script>\n$x = 1\n</script>\n')
    assert.deepEqual(r2.errors, [])
  })

  // une URL `https://…` dans une chaîne n'est PAS un commentaire (déjà couvert par le scanner de
  // chaînes) — mais hors chaîne, le `//` d'une URL nue reste un commentaire, comme en JS
  it("non-régression — `https://` DANS une chaîne n'ouvre pas de commentaire", () => {
    assert.equal(parse("<a href={'https://x.test/a'}>x</a>").children[0].attrs[0].expr, "'https://x.test/a'")
    assert.equal(parse("<a href={'https://x.test/a'}>x</a>").children[0].children[0].content, 'x')
  })

  it('non-régression — les formes SAINES parsent toujours', () => {
    assert.equal(parse("<div title={'ab'}>x</div>").children[0].attrs[0].expr, "'ab'")
    assert.equal(parse("{$path.replace('c:\\\\', '')}<p>fin</p>").children.length, 2)
    assert.equal(parse('<p>{ f({a: 1}) }</p>').children[0].children[0].expr, 'f({a: 1})')
    assert.equal(parse('<p>{{ $brut }}</p>').children[0].children[0].expr, '$brut')
    assert.equal(parse("<div @class{$on ? 'a' : 'b'}>x</div>").children[0].attrs[0].name, "@class{$on ? 'a' : 'b'}")
    assert.equal(parse('<div @style.width={`${$w}px`}>x</div>').children[0].attrs[0].expr, '`${$w}px`')
  })

  // `extractBalanced` connaissait déjà les regex/commentaires mais
  // traitait un backtick comme une chaîne OPAQUE : le premier AUTRE backtick rencontré refermait la
  // chaîne, MÊME s'il était dans une chaîne `'…'` IMBRIQUÉE À L'INTÉRIEUR d'un `${…}`. Mesuré :
  // `` `a${ 'x`y' }b` `` levait une fausse « chaîne non fermée » (le backtick de 'x`y' était pris
  // pour LE backtick de fermeture). Remède : dans la branche `inString`, un `$` suivi de `{` ouvre
  // une récursion sur `extractBalanced(scanner, '}')` — l'imbrication passe alors par LE MÊME
  // scanner (chaînes/regex/commentaires dedans gérés pareil qu'au premier niveau).
  it('backtick imbriqué contenant un AUTRE backtick, dans une chaîne : ne referme plus au mauvais endroit', () => {
    assert.equal(parse("<p>{ `a${ 'x`y' }b` }</p>").children[0].children[0].expr, "`a${ 'x`y' }b`")
  })

  it('backtick doublement imbriqué `${ `${ 1 }` }` : compile toujours', () => {
    assert.equal(parse('<p>{ `${ `${ 1 }` }` }</p>').children[0].children[0].expr, '`${ `${ 1 }` }`')
  })

  it('accolade en chaîne DANS une interpolation (`${ \'}\' }`) : le texte rendu contient bien a}b', async () => {
    const r = await compileComp("<p>{ `a${ '}' }b` }</p>")
    assert.deepEqual(r.errors, [])
    const m = r.code!.match(/_mjs_updText\('t1', ([\s\S]*?)\);\s*\}\]/)
    assert.ok(m, '_mjs_updText introuvable dans le code émis')
    assert.equal(Function('return (' + m![1] + ')')(), 'a}b')
  })

  it('backtick JAMAIS refermé (avec `${…}` bien formé dedans) : erreur bornée « CHAÎNE NON FERMÉE », pas de boucle', () => {
    const debut = Date.now()
    assert.throws(() => parse('<p>{ `a${ 1 }b'), /CHAÎNE NON FERMÉE/)
    assert.ok(Date.now() - debut < 1000, 'pas de boucle infinie')
  })
})
