// Compilateur ModularJS V2 (générateur : paths.ts/compile.ts/
// path-tracker.ts) : sept cas limites, chacun avec son `describe`.
// Montage happy-dom : calque de tests/state-collection-reactivity.test.ts:16-40 (`el._shadow`,
// shadow clos, attente 60-80 ms, jamais un nœud DOM dans une assertion — chaînes/nombres/booléens
// seulement). Là où happy-dom diverge du navigateur (`<pre>`/`<textarea>`), la preuve passe aussi par la FONCTION
// PURE (extractPaths) en plus du montage.

import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { transpile } from '../src/transpiler/index.js'
import { extractPaths, generateCreateFnBody } from '../src/generator/paths.js'
import { compile } from '../src/generator/compile.js'
import { parse } from '../src/parser/index.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// calque tests/state-collection-reactivity.test.ts:16-40 — UN composant (un seul fichier .mjs)
async function mount(name: string, source: string) {
  const root = mjsTmp(`compile-${name}`)
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
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { window, el }
}

// même recette, MULTI-fichiers (un parent + deux enfants avec leur propre µmount) —
// calque de tests/await-reaffichage-bloc-englobant.test.ts (mountFiles)
async function mountFiles(files: Record<string, string>, rootTag: string) {
  const root = mjsTmp('compile-multi')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, src] of Object.entries(files)) writeFileSync(join(srcDir, name), src)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const outFiles = readdirSync(outDir)
  const coreFile = outFiles.find((f: string) => /^mjs_core-/.test(f))!
  const jsFiles = outFiles.filter((f: string) => f.endsWith('.js') && f !== coreFile && f !== 'bundle.js')
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${jsFiles.map((f: string) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))).join('\n')}`)
  document.body.innerHTML = `<${rootTag}></${rootTag}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { window, el }
}

describe('compilateur (paths.ts/compile.ts)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  describe('<p> contenant un élément de flow content : erreur de compilation', function () {
    it('<p>avant<div>{$y}</div>apres</p> → erreur citant div', async () => {
      await assert.rejects(
        () => transpile('<p>avant<div>{$y}</div>apres</p>\n', { moduleName: 'd1-p-div' }),
        (e: any) => { assert.match(e.message, /<div>/); return true },
      )
    })

    it('<p>a<span>{$y}</span>b</p> → OK (span est inline, pas dans P_CLOSING_TAGS)', async () => {
      const out = await transpile('<p>a<span>{$y}</span>b</p>\n', { moduleName: 'd1-p-span' })
      assert.equal(typeof out.output, 'string')
    })

    it('<div><p>{$y}</p></div> → OK (p ouvert alors que le courant est div, pas p)', async () => {
      const out = await transpile('<div><p>{$y}</p></div>\n', { moduleName: 'd1-div-p' })
      assert.equal(typeof out.output, 'string')
    })

    it('<p>x</p><div>y</div> → OK (p déjà refermé : frères, pas parent/enfant)', async () => {
      const out = await transpile('<p>x</p><div>y</div>\n', { moduleName: 'd1-p-then-div' })
      assert.equal(typeof out.output, 'string')
    })
  })

  describe('<pre>/<textarea> : le 1er retour à la ligne se retire', function () {
    it('extractPaths : <pre>\\n<marker></pre> ne compte plus qu\'UN enfant sous <pre>', () => {
      const info = extractPaths('<pre>\n<script type=\'mjs/marker\' mjs-t=\'t1\'></script></pre>')
      assert.deepEqual(info.paths['t1'], [0, 0])
      assert.equal(Object.keys(info.paths).length, 1)
    })

    it('<pre>\\n\\nligne</pre> : un seul \\n retiré, le second reste', () => {
      const info = extractPaths('<pre>\n\nligne</pre>')
      assert.equal(info.cleanHtml, '<pre>\nligne</pre>')
    })

    it('<pre>texte</pre> (pas de \\n initial) : inchangé', () => {
      const info = extractPaths('<pre>texte</pre>')
      assert.equal(info.cleanHtml, '<pre>texte</pre>')
    })

    it('<textarea>\\ntexte</textarea> : même retrait côté raw-text', () => {
      const info = extractPaths('<textarea>\ntexte</textarea>')
      assert.equal(info.cleanHtml, '<textarea>texte</textarea>')
    })

    it('montage happy-dom : le binding juste après le \\n initial reste vivant', async () => {
      const src = ['<script>', "  $x = 'un'", '</script>', '<pre>', '{$x}</pre>', ''].join('\n')
      const { el } = await mount('d2pre', src)
      const texte = () => el._shadow.querySelector('pre').textContent
      assert.equal(texte(), 'un')
      el._set('x', 'deux')
      await new Promise(r => setTimeout(r, 60))
      assert.equal(texte(), 'deux')
    })
  })

  describe('SVG en mode impératif : namespace correct', function () {
    it('generateCreateFnBody(forceImperative) sur <svg><circle> : createElementNS, plus de createElement("circle")', () => {
      const info = generateCreateFnBody('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"></circle></svg>', { forceImperative: true })
      assert.equal(info.body.includes('createElementNS'), true)
      assert.equal(/createElement\((["'])circle\1\)/.test(info.body), false)
    })

    it('témoin HTML ordinaire (pas de SVG) : createElementNS absent, inchangé', () => {
      const info = generateCreateFnBody('<div><span></span></div>', { forceImperative: true })
      assert.equal(info.body.includes('createElementNS'), false)
    })

    it('svg + await + if frère : createElementNS présent, createElement("circle") absent', async () => {
      const src = [
        '<script>', '  $data = Promise.resolve(5)', '  $warn = false', '</script>',
        '<svg viewBox="0 0 10 10">',
        '{await $data}', '<p>...</p>',
        '{success v}', '<circle cx="5" cy="5" r={v}></circle>', '{if $warn}<text>!</text>{end}',
        '{error err}', '<p>{err.message}</p>',
        '{end}', '</svg>', '',
      ].join('\n')
      const out = await transpile(src, { moduleName: 'd3-svg-await' })
      assert.equal(out.output.includes('createElementNS'), true)
      assert.equal(/createElement\((["'])circle\1\)/.test(out.output), false)
    })

    it('montage happy-dom : circle.namespaceURI === SVG_NS une fois la promesse résolue', async () => {
      const src = [
        '<script>', '  $data = Promise.resolve(5)', '  $warn = false', '</script>',
        '<svg viewBox="0 0 10 10">',
        '{await $data}', '<p>...</p>',
        '{success v}', '<circle cx="5" cy="5" r={v}></circle>', '{if $warn}<text>!</text>{end}',
        '{error err}', '<p>{err.message}</p>',
        '{end}', '</svg>', '',
      ].join('\n')
      const { el } = await mount('d3svgmount', src)
      await new Promise(r => setTimeout(r, 200))
      const ns = el._shadow.querySelector('circle')?.namespaceURI ?? null
      assert.equal(ns, 'http://www.w3.org/2000/svg')
    })
  })

  describe('{await} imbriqué dans {for} : erreur de compilation', function () {
    it('{for it in $items}<li>{await $p}{success v}{v}{error err}{err.message}{end}</li>{end} → erreur', async () => {
      const src = [
        '<script>', '  $items = [1,2,3]', '  $p = Promise.resolve(1)', '</script>',
        '{for it in $items}',
        '<li>{await $p}{success v}{v}{error err}{err.message}{end}</li>',
        '{end}', '',
      ].join('\n')
      await assert.rejects(
        () => transpile(src, { moduleName: 'd4-await-in-for' }),
        (e: any) => { assert.match(e.message, /\{await\}/); assert.match(e.message, /\{for\}/); return true },
      )
    })

    it('{if} à la racine autour de {await} : OK — asymétrie for/if conservée', async () => {
      const src = [
        '<script>', '  $ok = true', '  $p = Promise.resolve(1)', '</script>',
        '{if $ok}',
        '{await $p}{success v}<p>{v}</p>{error err}<p>{err.message}</p>{end}',
        '{end}', '',
      ].join('\n')
      const out = await transpile(src, { moduleName: 'd4-await-in-if' })
      assert.equal(out.output.includes('_mjs_updAwait'), true)
    })

    it('docs/05-blocs.md § {await} : la restriction for/if est écrite', () => {
      const doc = readFileSync(join(__dirname, '..', 'docs', '05-blocs.md'), 'utf-8')
      const section = doc.slice(doc.indexOf('## Promesses'), doc.indexOf('## Re-montage forcé'))
      assert.match(section, /imbriqué dans un `\{for\}`/)
      assert.match(section, /permis/)
    })
  })

  describe('guillemet non fermé dans un attribut : erreur au lieu du silence', function () {
    it('generateCreateFnBody(forceImperative) : erreur citant div, plus de fragment vide', () => {
      assert.throws(
        () => generateCreateFnBody("<div title='a'b'>text</div><p>after</p>", { forceImperative: true }),
        /<div>/,
      )
    })

    it('extractPaths : même entrée, même famille d\'erreur', () => {
      assert.throws(
        () => extractPaths("<div title='a'b'>text</div><p>after</p>"),
        /<div>/,
      )
    })

    it('témoin : apostrophe DANS des guillemets doubles (title="a\'b") → OK, valeur préservée', () => {
      const info = extractPaths(`<div title="a'b">text</div>`)
      assert.equal(info.cleanHtml, `<div title="a'b">text</div>`)
    })
  })

  describe('{key {objet}} : littéral recréé à chaque évaluation → remonte même sans changement de valeur', function () {
    it('clé littéral objet remonte à CHAQUE _mjs_renderStruct ; clé primitive (contrôle) reste stable', async () => {
      const files = {
        'key-obj-child.mjs': [
          '<script lang="coffee">',
          'µmount ->',
          "  window.__mjsD6ObjMountCount = (window.__mjsD6ObjMountCount or 0) + 1",
          '</script>',
          '<p>obj</p>', '',
        ].join('\n'),
        'key-prim-child.mjs': [
          '<script lang="coffee">',
          'µmount ->',
          "  window.__mjsD6PrimMountCount = (window.__mjsD6PrimMountCount or 0) + 1",
          '</script>',
          '<p>prim</p>', '',
        ].join('\n'),
        'key-parent.mjs': [
          '<script>', '  $x = 5', '  $y = false', '</script>',
          '{key {a: $x}}', '<@key-obj-child/>', '{end}',
          '{key $x}', '<@key-prim-child/>', '{end}',
          '{if $y}<span class="trig"></span>{end}',
          '<button class="toggle" @click={$y = !$y}>toggle</button>', '',
        ].join('\n'),
      }
      const { el, window } = await mountFiles(files, 'mjs-key-parent')

      assert.equal(window.__mjsD6ObjMountCount, 1, 'objet : monté 1x à l\'init')
      assert.equal(window.__mjsD6PrimMountCount, 1, 'primitif : monté 1x à l\'init')

      // toggle $y : structVar SANS RAPPORT avec $x — _mjs_renderStruct rejoue TOUT le
      // composant (dispatch coarse, cf. _mjs_renderStructVars), $x lui-même n'a pas bougé.
      const toggle = () => { el._shadow.querySelector('.toggle').click() }
      toggle()
      await new Promise(r => setTimeout(r, 80))
      assert.equal(window.__mjsD6ObjMountCount, 2, 'objet : REMONTE alors que $x n\'a pas changé (preuve du bug)')
      assert.equal(window.__mjsD6PrimMountCount, 1, 'primitif : reste stable (contrôle — _mjs_key_cache === val)')

      toggle()
      await new Promise(r => setTimeout(r, 80))
      assert.equal(window.__mjsD6ObjMountCount, 3, 'objet : remonte ENCORE au 2e passage non lié à $x')
      assert.equal(window.__mjsD6PrimMountCount, 1, 'primitif : toujours stable')
    })

    it('docs/05-blocs.md § {key} avertit sur les littéraux objet/tableau', () => {
      const doc = readFileSync(join(__dirname, '..', 'docs', '05-blocs.md'), 'utf-8')
      const section = doc.slice(doc.indexOf('## Re-montage forcé'), doc.indexOf('## Constante locale'))
      assert.match(section, /valeur stable/)
      assert.match(section, /littéral objet/)
    })
  })

  describe('docs/05-blocs.md:65 corrigé : la mutation profonde EST suivie depuis une méthode ordinaire', function () {
    it('l\'affirmation fausse (mutation depuis <script> non suivie) a disparu, remplacée par le comportement réel', () => {
      const doc = readFileSync(join(__dirname, '..', 'docs', '05-blocs.md'), 'utf-8')
      assert.equal(/ne re-rend pas le `\{for\}`/.test(doc), false)
      assert.match(doc, /d'où qu'elle vienne/)
    })
  })

  describe('<p> + flow content : garde étendue à TOUTE la pile, pas seulement son sommet', function () {
    it('extractPaths : <p>a<b>x<div>y</div>z</b>b</p> — élément COURANT = <b>, le <p> reste plus bas dans la pile : erreur quand même', () => {
      assert.throws(
        () => extractPaths('<p>a<b>x<div>y</div>z</b>b</p>'),
        /<div>/,
      )
    })

    it('generateCreateFnBody(forceImperative) : même cas — mode impératif, jusqu\'ici NON protégé, erreur aussi', () => {
      assert.throws(
        () => generateCreateFnBody('<p>a<b>x<div>y</div>z</b>b</p>', { forceImperative: true }),
        /<div>/,
      )
    })

    it('{await}{success} contenant un {for} : <p>avant{for x in items}{x}{end}<div>flow</div>apres</p> force le mode impératif — refusé', async () => {
      const src = [
        '<script>', '  $p = Promise.resolve([1,2,3])', '</script>',
        '{await $p}',
        '{success items}',
        '<p>avant{for x in items}{x}{end}<div>flow</div>apres</p>',
        '{end}', '',
      ].join('\n')
      await assert.rejects(
        () => transpile(src, { moduleName: 'd2-1-await-for-p-div' }),
        (e: any) => { assert.match(e.message, /<div>/); return true },
      )
    })

    it('témoin : <p>a<span>{$y}</span>b</p> → toujours OK (span n\'est pas dans P_CLOSING_TAGS)', async () => {
      const out = await transpile('<p>a<span>{$y}</span>b</p>\n', { moduleName: 'd2-1-temoin-span' })
      assert.equal(typeof out.output, 'string')
    })

    it('témoin : <div><p>{$y}</p></div> → toujours OK (le <p> qui s\'ouvre n\'a AUCUN <p> plus haut dans la pile)', async () => {
      const out = await transpile('<div><p>{$y}</p></div>\n', { moduleName: 'd2-1-temoin-div-p' })
      assert.equal(typeof out.output, 'string')
    })
  })

  describe('<foreignObject> repasse en HTML : ses enfants ne sont plus créés en namespace SVG', function () {
    it('generateCreateFnBody(forceImperative) : <svg><foreignObject><div>x</div><input></foreignObject><circle/></svg> — HTML sous foreignObject, SVG hors', () => {
      const html = '<svg><foreignObject><div>x</div><input></foreignObject><circle/></svg>'
      const info = generateCreateFnBody(html, { forceImperative: true })
      assert.match(info.body, /createElement\((["'])div\1\)/, 'div : createElement nu (HTML)')
      assert.doesNotMatch(info.body, /createElementNS\([^,]*,\s*(["'])div\1\)/, 'div : plus de createElementNS')
      assert.match(info.body, /createElement\((["'])input\1\)/, 'input : createElement nu (HTML)')
      assert.match(info.body, /createElementNS\([^,]*svg[^,]*,\s*(["'])circle\1\)/, 'circle : createElementNS(svg) — hors foreignObject, inchangé')
      assert.match(info.body, /createElementNS\([^,]*svg[^,]*,\s*(["'])foreignobject\1\)/, 'foreignObject lui-même reste un élément SVG : createElementNS(svg)')
    })

    // montage en mode IMPÉRATIF (branche {await} avec un bloc frère) : c'est le seul chemin que le
    // correctif touche — en mode clone, le namespace vient du parseur HTML du navigateur
    // (juste dans Chromium/Firefox, FAUX sous happy-dom qui laisse le <div> en SVG : limite connue)
    it('montage happy-dom (mode impératif) : namespaceURI du <div> sous <foreignObject> est XHTML (pas SVG)', async () => {
      const src = [
        '<script>',
        '$p = Promise.resolve(1)',
        '$w = false',
        '</script>',
        '<svg viewBox="0 0 10 10">',
        '{await $p}<p>...</p>{success v}<foreignObject width="10" height="10"><div class="sonde">{v}</div></foreignObject>{if $w}<text>!</text>{end}{error err}<p>{err.message}</p>{end}',
        '</svg>', '',
      ].join('\n')
      const { el } = await mount('d2-2-foreignobject', src)
      await new Promise(r => setTimeout(r, 120))
      const div = el._shadow.querySelector('.sonde')
      assert.ok(div, 'le <div> de la branche success est monté')
      assert.equal(div.namespaceURI, 'http://www.w3.org/1999/xhtml')
    })
  })

  describe('{await} imbriqué dans {for} : la ligne citée dans le message', function () {
    it('parse() : if/for/await/key/const posent tous .line sur LEUR PROPRE nœud, comme tag (parser/index.ts)', () => {
      const src = [
        '{if $a}b{end}',
        '{for x in $xs}y{end}',
        '{await $p}{success v}{v}{end}',
        '{key $k}z{end}',
        '{const c = 1}',
        '',
      ].join('\n')
      const root = parse(src)
      const flowNodes = root.children.filter((n) => n.type !== 'text')
      assert.deepEqual(flowNodes.map((n) => n.type), ['if', 'for', 'await', 'key', 'const'])
      assert.deepEqual(flowNodes.map((n) => n.line), [1, 2, 3, 4, 5])
    })

    it('nearestLine() a disparu de compile.ts (retirée, devenue inutile)', () => {
      const src = readFileSync(join(__dirname, '..', 'src', 'generator', 'compile.ts'), 'utf-8')
      assert.equal(/function nearestLine/.test(src), false)
    })

    it('compile() direct, {await} en ligne 6 (aucun <script> devant, aucun décalage possible) → le message cite ligne 6', () => {
      const pad = Array.from({ length: 4 }, (_, i) => `<!-- pad${i} -->`)
      const src = ['{for it in $items}', ...pad, '<li>{await $p}{success v}{v}{error err}{err.message}{end}</li>', '{end}', ''].join('\n')
      assert.throws(() => compile(src, { moduleName: 'd2-3-ligne6' }), /\(ligne 6\)/)
    })

    it('le même {await}, déplacé en ligne 10 : le message suit exactement le déplacement', () => {
      const pad = Array.from({ length: 8 }, (_, i) => `<!-- pad${i} -->`)
      const src = ['{for it in $items}', ...pad, '<li>{await $p}{success v}{v}{error err}{err.message}{end}</li>', '{end}', ''].join('\n')
      assert.throws(() => compile(src, { moduleName: 'd2-3-ligne10' }), /\(ligne 10\)/)
    })

    // AVANT ce correctif : nearestLine() remontait au PREMIER DESCENDANT muni de `.line` — ici
    // {success v} (ligne 4 : le run de texte 100% blanc entre {await} et {success} pointe la
    // ligne de ce qu'il PRÉCÈDE, cf. parseText), jamais le mot-clé {await}
    // lui-même (ligne 3). Avant correctif : message « (ligne 4) ». Non
    // reproduit ici tel quel (reviendrait à revert le correctif dans ce fichier même).
    it('{await} sur SA PROPRE ligne (3), {success}/{v} sur des lignes ULTÉRIEURES (5) : le message cite le mot-clé, pas le 1er descendant', () => {
      const src = [
        '{for it in $items}', '<li>', '{await $p}', '{success v}', '{v}', '{error err}', '{err.message}', '{end}', '</li>', '{end}', '',
      ].join('\n')
      assert.throws(() => compile(src, { moduleName: 'd2-3-await-own-line' }), /\(ligne 3\)/)
    })

    // Corrigé dans sections.ts. Avant ce correctif, la ligne citée
    // par le générateur était relative au TEMPLATE tel que compile() le reçoit — via transpile(),
    // CE template avait déjà perdu les 4 lignes du <script> (sections.ts retirait le bloc par
    // PLAGE D'OFFSETS, sans rien à sa place) : {await}, réellement en ligne 6 du .mjs entier,
    // tombait en ligne 2 du template extrait (assertion verrouillée à l'époque sur `/\(ligne 2\)/`
    // pour ne pas régresser EN SILENCE, cf. historique git de cette ligne). Le correctif remplace
    // chaque bloc retiré par un commentaire HTML inerte de MÊME hauteur (sections.ts, aucun nœud
    // produit par le parseur pour un commentaire) : la ligne citée redevient celle du .mjs réel.
    it('transpile() : fixture historique (un <script> de 4 lignes devant le template) — ligne relative au .mjs RÉEL (sections.ts)', async () => {
      const src = [
        '<script>', '  $items = [1,2,3]', '  $p = Promise.resolve(1)', '</script>',
        '{for it in $items}',
        '<li>{await $p}{success v}{v}{error err}{err.message}{end}</li>',
        '{end}', '',
      ].join('\n')
      await assert.rejects(
        () => transpile(src, { moduleName: 'd2-3-transpile-script-offset' }),
        (e: any) => { assert.match(e.message, /\(ligne 6\)/); return true },
      )
    })
  })
})
