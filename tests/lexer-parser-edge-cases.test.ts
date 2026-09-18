// Cas limites du lexer et du parseur — un describe par point.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { tokenize } from '../src/lexer/index.js'
import { parse } from '../src/parser/index.js'
import { transpile } from '../src/transpiler/index.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// mount — copie de tests/state-collection-reactivity.test.ts:16-40 (shadow clos, `el._shadow`)
async function mount(name: string, source: string) {
  const root = mjsTmp(`lexer-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { window, el }
}

describe('backtick imbriqué dans le SCANNER PRINCIPAL', () => {
  it('gabarit intact (aucune } parasite) et $y réécrit, imbrication à 1 niveau', () => {
    const src = 'x = `a${ `inner${1}inner` }b` + $y'
    const out = tokenize(src)
    assert.doesNotMatch(out, /`}inner/, 'aucune } parasite juste après le 2e backtick ouvrant')
    assert.equal(out, 'x = `a${ `inner${1}inner` }b` + $.y')
  })

  it('$z réécrit en $.z dans une interpolation imbriquée à 2 niveaux', () => {
    const src = 'x = `a${ `b${$z}` }`'
    assert.equal(tokenize(src), 'x = `a${ `b${$.z}` }`')
  })

  it('témoin — gabarit simple (1 seul niveau) reste correct', () => {
    assert.equal(tokenize('`hello ${$x}`'), '`hello ${$.x}`')
  })

  it('témoin — chaîne simple contenant un backtick reste littérale', () => {
    assert.equal(tokenize("'un ` seul' + $x"), "'un ` seul' + $.x")
  })
})

describe('§nom = expr suivi d\'un commentaire de fin de ligne', () => {
  it('exemple exact docs/13-contexte.md:75 — §canvas = { addItem }   # commentaire', async () => {
    const src = [
      '<script>',
      '  addItem = -> 1',
      '  §canvas = { addItem }   # le service exposé aux descendants',
      '</script>',
      '<p>ok</p>',
    ].join('\n')
    await assert.doesNotReject(transpile(src, { moduleName: 'ctx-comment-a' }))
  })

  it('§§compteur = items # c (contexte réactif de sous-arbre)', async () => {
    const src = [
      '<script>',
      '  items = [1, 2, 3]',
      '  §§compteur = items # c',
      '</script>',
      '<p>ok</p>',
    ].join('\n')
    await assert.doesNotReject(transpile(src, { moduleName: 'ctx-comment-b' }))
  })

  it('§x = 1 # c suivi d\'une ligne $y = 2 → $y bien déclaré', async () => {
    const src = [
      '<script>',
      '  §x = 1 # c',
      '  $y = 2',
      '</script>',
      '<p>{$y}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'ctx-comment-c' })
    assert.match(output, /"y":\s*1/, 'y déclaré dans _mjs_var_bits')
    assert.match(output, /µ\._set\(_mjsThis, 'y', 2\)/, 'affectation $y = 2 compilée, non tronquée par le commentaire précédent')
    assert.match(output, /\$\.y\b/, 'lecture $y → $.y dans le template')
  })

  it('témoin — sans commentaire, inchangé (§ simple et §§ toujours compilables)', async () => {
    const srcSimple = ['<script>', '  §x = 1', '</script>', '<p>ok</p>'].join('\n')
    const srcReactif = ['<script>', '  items = []', '  §§compteur = items', '</script>', '<p>ok</p>'].join('\n')
    await assert.doesNotReject(transpile(srcSimple, { moduleName: 'ctx-temoin-a' }))
    await assert.doesNotReject(transpile(srcReactif, { moduleName: 'ctx-temoin-b' }))
  })
})

describe('commentaire HTML <!-- … --> inerte au parseur', () => {
  it('parse() : un seul enfant, le <p> — le commentaire ne produit ni texte ni expr', () => {
    const root = parse('<!-- {brokenExpr} --><p>ok</p>')
    assert.equal(root.children.length, 1)
    assert.equal(root.children[0].type, 'tag')
    assert.equal(root.children[0].name, 'p')
  })

  it('transpile() : $x jamais déclaré, caché dans un commentaire, compile sans erreur, sortie sans <!-- ni $.x', async () => {
    const src = [
      '<script>',
      '  y = 1',
      '</script>',
      '<!-- {$x} -->',
      '<p>ok</p>',
    ].join('\n')
    const p = transpile(src, { moduleName: 'comment-x' })
    await assert.doesNotReject(p)
    const { output } = await p
    assert.equal(output.includes('<!--'), false)
    // $.x : dépend AUSSI du masquage des commentaires dans preprocessHtml (transpiler/index.ts,
    // en amont du parseur) — mon périmètre s'arrête au parseur ; les deux
    // sont posés au moment de ce test, d'où l'assertion complète.
    assert.equal(/\$\.x\b/.test(output), false)
  })

  it('montage happy-dom : innerHTML du shadow ne contient pas <!--', async () => {
    const src = [
      '<script>',
      '  x = 1',
      '</script>',
      '<!-- {brokenExpr} -->',
      '<p class="ok">visible</p>',
    ].join('\n')
    const { el } = await mount('cmthtml', src)
    const html = el._shadow.innerHTML as string
    assert.equal(html.includes('<!--'), false)
    assert.equal(html.includes('brokenExpr'), false)
    assert.equal(el._shadow.querySelector('.ok').textContent.trim(), 'visible')
  })

  it('commentaire sur 3 lignes puis fermante orpheline volontaire ligne 5 : le numéro de ligne reste juste', () => {
    const src = [
      '<p>avant</p>',
      '<!-- ligne a',
      'ligne b',
      'ligne c -->',
      '</div>',
    ].join('\n')
    assert.throws(() => parse(src), /ligne 5/)
  })

  it('commentaire non refermé → erreur claire avec la ligne d\'ouverture', () => {
    assert.throws(() => parse('<p>a</p>\n<!-- jamais fermé'), /ligne 2/)
  })

  it('commentaire à l\'intérieur d\'un {if} → branche intacte (le <p> compile, rien ne fuit)', () => {
    const root = parse('{if $x}<!-- note {brokenExpr} --><p>a</p>{end}')
    const branch = root.children[0].branches[0]
    const hasCommentText = branch.children.some(n => n.type === 'text' && (n.content ?? '').includes('<!--'))
    const hasBrokenExpr = branch.children.some(n => n.type === 'expr' && n.expr === 'brokenExpr')
    const pTag = branch.children.find(n => n.type === 'tag' && n.name === 'p')
    assert.equal(hasCommentText, false)
    assert.equal(hasBrokenExpr, false)
    assert.notEqual(pTag, undefined, 'le <p> doit être présent dans la branche')
  })
})

describe('balise HTML jamais fermée jusqu\'à la fin du fichier', () => {
  it('<div>\\n<p>\\n<span>texte → erreur citant span, ligne 3 (la plus profonde)', () => {
    const src = '<div>\n<p>\n<span>texte'
    assert.throws(() => parse(src), /span/)
    assert.throws(() => parse(src), /ligne 3/)
  })

  it('<p>a<span>b</span> → erreur citant p, ligne 1 (span, lui, est bien fermé)', () => {
    const src = '<p>a<span>b</span>'
    assert.throws(() => parse(src), /\bp\b/)
    assert.throws(() => parse(src), /ligne 1/)
  })

  it('<div><br><img src="x"></div> → OK (éléments vides, aucune fausse alerte)', () => {
    const root = parse('<div><br><img src="x"></div>')
    assert.equal(root.children[0].name, 'div')
    assert.equal(root.children[0].children.length, 2)
  })

  it('<x/> seul → OK (auto-fermante, jamais concernée)', () => {
    const root = parse('<x/>')
    assert.equal(root.children[0].name, 'x')
    assert.equal(root.children[0].children.length, 0)
  })

  it('<@slot> nu en fin de fichier → OK, même arbre que <@slot></@slot> et <@slot/>', () => {
    const nu = parse('<div>x</div>\n<@slot>').children.at(-1)
    const ferme = parse('<div>x</div>\n<@slot></@slot>').children.at(-1)
    const auto = parse('<div>x</div>\n<@slot/>').children.at(-1)
    assert.deepEqual(nu, ferme)
    assert.deepEqual(nu, auto)
    assert.equal(nu.name, 'slot')
    assert.equal(nu.children.length, 0)
  })

  it('<@slot name> nu en fin de fichier → OK, même arbre que <@slot name></@slot>', () => {
    const nu = parse('<div>x</div>\n<@slot name>').children.at(-1)
    const ferme = parse('<div>x</div>\n<@slot name></@slot>').children.at(-1)
    assert.deepEqual(nu, ferme)
  })

  it('<@slot {i}> nu en fin de fichier → OK, même arbre que <@slot {i}></@slot>', () => {
    const nu = parse('<div>x</div>\n<@slot {i}>').children.at(-1)
    const ferme = parse('<div>x</div>\n<@slot {i}></@slot>').children.at(-1)
    assert.deepEqual(nu, ferme)
  })

  it('<@slot>contenu de repli, jamais fermé (EOF) → reste une erreur (repli à délimiter)', () => {
    const src = '<div>x</div>\n<@slot>contenu de repli'
    assert.throws(() => parse(src), /\bslot\b/)
    assert.throws(() => parse(src), /ligne 2/)
  })

  it('transpile() : composant qui se termine par <@slot> nu → compile, slot bien émis', async () => {
    const r = await transpile('<div>x</div>\n<@slot>', { moduleName: 'a4-slot-eof-nu' })
    assert.match(r.output, /<slot><\/slot>|<slot\s*\/>/)
  })
})

describe('docs/02-composant.md — raccourci d\'attribut nu retiré, commentaire HTML documenté', () => {
  const docPath = join(__dirname, '..', 'docs', '02-composant.md')
  const doc = () => readFileSync(docPath, 'utf-8')

  it('l\'exemple <img> n\'utilise plus le raccourci {src} nu, refusé par le parseur', () => {
    assert.doesNotMatch(doc(), /<img \{src\} alt=/)
    assert.match(doc(), /<img src=\{src\} alt="\{name\} dances\." \/>/)
  })

  it('aucune autre occurrence du raccourci nu dans TOUTE la doc (grep de contrôle)', () => {
    const occurrences = doc().match(/<[a-z-]* \{[a-zA-Z_$]*\}/g) ?? []
    assert.deepEqual(occurrences, [])
  })

  it('la section du markup documente le commentaire HTML (ignoré, jamais dans le DOM)', () => {
    const section = doc().split('## Le markup')[1]?.split('\n## ')[0] ?? ''
    assert.match(section, /commentaire html/i)
    assert.match(section, /jamais (dans le|interprété)/i)
  })
})

describe('attribut dupliqué sur une balise = erreur générique au parseur (filet)', () => {
  it('<a @confirm="A" data-x=">" @confirm="B">x</a> via transpile() → erreur (dupliqué)', async () => {
    await assert.rejects(transpile('<a @confirm="A" data-x=">" @confirm="B">x</a>', { moduleName: 'a3-1-confirm-dup' }), /dupliqu/)
  })

  it('<div title="a" title="b"> → erreur parser.attribut-duplique, nomme l\'attribut, la balise et la ligne', () => {
    assert.throws(() => parse('<div title="a" title="b">x</div>'), /dupliqu/)
    assert.throws(() => parse('<div title="a" title="b">x</div>'), /title/)
    assert.throws(() => parse('<div title="a" title="b">x</div>'), /\bdiv\b/)
    assert.throws(() => parse('<div title="a" title="b">x</div>'), /ligne 1/)
  })

  it('<div class="a" @class{$x}="b"> → OK, `class` et `@class{$x}` sont deux noms différents', () => {
    const root = parse('<div class="a" @class{$.x}="b">c</div>')
    assert.equal(root.children[0].attrs.length, 2)
  })

  it('<a @confirm="A">x</a><a @confirm="B">y</a> → OK, deux balises distinctes', () => {
    assert.doesNotThrow(() => parse('<a @confirm="A">x</a><a @confirm="B">y</a>'))
  })

  it('@class{a}="x" @class{b}="y" sur la même balise → OK, deux conditions ne collisionnent jamais', () => {
    const root = parse('<div @class{a}="x" @class{b}="y">c</div>')
    assert.equal(root.children[0].attrs.length, 2)
  })

  it('@style.color={…} @style.width={…} sur la même balise → OK, deux propriétés différentes', () => {
    const root = parse('<div @style.color={1} @style.width={2}>c</div>')
    assert.equal(root.children[0].attrs.length, 2)
  })

  it('mjs-confirm=\'A\' mjs-confirm=\'B\' (déjà réécrit par preprocessHtml) → erreur, c\'est le filet', () => {
    assert.throws(() => parse('<div mjs-confirm=\'A\' mjs-confirm=\'B\'>c</div>'), /dupliqu/)
  })

  it('@Title="a" @title="b" → OK, la casse distingue les noms (traitée ailleurs)', () => {
    assert.doesNotThrow(() => parse('<div @Title="a" @title="b">c</div>'))
  })
})

describe('numéros de ligne justes après un bloc <script>/<style> retiré (sections.ts)', () => {
  it('balise non fermée en ligne 6, après un <script> de 4 lignes → le message cite 6 (pas 2)', async () => {
    const src = ['<script>', '$x = 1', '$y = 2', '</script>', '<div>', '<span>'].join('\n')
    await assert.rejects(transpile(src, { moduleName: 'a3-2-unclosed-tag' }), /ligne 6/)
  })

  it('{await} imbriqué dans {for} en ligne 6, après un <script> de 4 lignes → le message cite ligne 6', async () => {
    const src = [
      '<script>', '  $items = [1,2,3]', '  $p = Promise.resolve(1)', '</script>',
      '{for it in $items}',
      '<li>{await $p}{success v}{v}{error err}{err.message}{end}</li>',
      '{end}', '',
    ].join('\n')
    await assert.rejects(transpile(src, { moduleName: 'a3-2-await-line' }), /ligne 6/)
  })

  it('témoin — sans <script>, le numéro de ligne reste inchangé', async () => {
    const src = ['<div>', '<span>'].join('\n')
    await assert.rejects(transpile(src, { moduleName: 'a3-2-witness-noscript' }), /ligne 2/)
  })

  it('<style> multi-lignes avant le HTML → même correctif que <script> (ligne 6)', async () => {
    const src = ['<style>', '.a', '  color: red', '</style>', '<div>', '<span>'].join('\n')
    await assert.rejects(transpile(src, { moduleName: 'a3-2-style-before' }), /ligne 6/)
  })
})
