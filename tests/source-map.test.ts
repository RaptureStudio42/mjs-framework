// cartes de source jusqu'au `.mjs` : la carte produite par le compilateur
// (Civet/Coffee) doit, une fois décalée de l'offset de ligne du `<script>`, retomber sur la
// VRAIE ligne du fichier .mjs quand on la DÉCODE (pas juste « la carte existe »).

import assert from 'node:assert/strict'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { civetAdapter } from '../src/languages/civet.js'
import { coffeeAdapter } from '../src/languages/coffee.js'
import { extractSections } from '../src/transpiler/sections.js'
import { transpile, shiftSourceMapLines } from '../src/transpiler/index.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'

// lineColOf — ligne/colonne 0-based (convention source-map) du 1er `needle` dans `text`
function lineColOf(text: string, needle: string): { line: number, column: number } {
  const idx = text.indexOf(needle)
  assert.ok(idx >= 0, `"${needle}" introuvable`)
  const before = text.slice(0, idx)
  const nlCount = (before.match(/\n/g) || []).length
  const lastNl = before.lastIndexOf('\n')
  return { line: nlCount + 1, column: lastNl === -1 ? idx : idx - lastNl - 1 }
}

describe('transpiler/source-map', () => {
  it('civet — la carte, décalée par shiftSourceMapLines, retombe sur la ligne .mjs attendue', async () => {
    const mjs = [
      '<p>avant</p>',
      '<script>',
      '  a = 1',
      '  b = 2',
      '  boom = a + b',
      '</script>',
    ].join('\n')
    const sections = extractSections(mjs)
    assert.equal(sections.script.lang, 'civet')
    const { code, map } = await civetAdapter.compileToJs(sections.script.raw, { fileName: 'fixture.civet' })
    assert.ok(map, 'civet ne remonte aucune carte')
    const shifted = shiftSourceMapLines(map!, sections.script.startLine - 1)
    const genPos = lineColOf(code, 'boom')
    const expected = lineColOf(mjs, 'boom = a + b')
    const tracer = new TraceMap(JSON.parse(shifted))
    const pos = originalPositionFor(tracer, { line: genPos.line, column: genPos.column })
    assert.equal(pos.line, expected.line, `la carte décalée pointe sur la ligne ${pos.line}, attendu ${expected.line} (celle de .mjs)`)
  })

  it('coffee — la carte, décalée par shiftSourceMapLines, retombe sur la ligne .mjs attendue', async () => {
    const mjs = [
      '<p>avant</p>',
      '<script lang="coffee">',
      'a = 1',
      'b = 2',
      'boom = a + b',
      '</script>',
    ].join('\n')
    const sections = extractSections(mjs)
    assert.equal(sections.script.lang, 'coffee')
    const { code, map } = await coffeeAdapter.compileToJs(sections.script.raw, { fileName: 'fixture.coffee' })
    assert.ok(map, 'coffee ne remonte aucune carte')
    const shifted = shiftSourceMapLines(map!, sections.script.startLine - 1)
    const genPos = lineColOf(code, 'boom = a + b')
    const expected = lineColOf(mjs, 'boom = a + b')
    const tracer = new TraceMap(JSON.parse(shifted))
    const pos = originalPositionFor(tracer, { line: genPos.line, column: genPos.column })
    assert.equal(pos.line, expected.line, `la carte décalée pointe sur la ligne ${pos.line}, attendu ${expected.line} (celle de .mjs)`)
  })

  it('sections.ts — startLine correspond bien au début RÉEL du contenu du bloc <script>', () => {
    const src = [
      '<p>avant</p>',
      '<script>',
      '  a = 1',
      '</script>',
    ].join('\n')
    const sections = extractSections(src)
    // `<script>` ligne 2, rien après sur cette ligne → le contenu (dedent conservant les
    // lignes) démarre virtuellement à la ligne 2 (sa ligne 1 est la fin, vide, de la balise).
    assert.equal(sections.script.startLine, 2)
  })

  it('transpile() — TranspileData.scriptSourceMap est bien remonté et décalé', async () => {
    const src = [
      '<script>',
      '  a = 1',
      '  b = 2',
      '  boom = a + b',
      '</script>',
      '<p>{boom}</p>',
    ].join('\n')
    const { data } = await transpile(src, { moduleName: 'somme-civet' })
    assert.ok(data.scriptSourceMap, 'aucune carte remontée par transpile() pour le <script> civet')
    const tracer = new TraceMap(JSON.parse(data.scriptSourceMap!))
    const genPos = lineColOf('\na = 1\nb = 2\nboom = a + b\n', 'boom')
    const pos = originalPositionFor(tracer, { line: genPos.line, column: genPos.column })
    assert.equal(pos.line, 4, `attendu ligne 4 (boom = a + b), obtenu ${pos.line}`)
  })

  // SABOTAGE OBLIGATOIRE — un offset décalé de 1 par rapport au vrai (celui que
  // sections.ts calcule) doit faire ROUGIR la vérification : preuve que le test ci-dessus
  // décode vraiment la carte au lieu de se contenter de sa présence.
  it('sabotage — un offset décalé de 1 casse la correspondance de ligne (le test doit rougir)', async () => {
    const mjs = [
      '<p>avant</p>',
      '<script>',
      '  a = 1',
      '  b = 2',
      '  boom = a + b',
      '</script>',
    ].join('\n')
    const sections = extractSections(mjs)
    const { code, map } = await civetAdapter.compileToJs(sections.script.raw, { fileName: 'fixture.civet' })
    assert.ok(map)
    const wrongOffset = sections.script.startLine - 1 + 1  // offset volontairement FAUX
    const shifted = shiftSourceMapLines(map!, wrongOffset)
    const genPos = lineColOf(code, 'boom')
    const expected = lineColOf(mjs, 'boom = a + b')
    const tracer = new TraceMap(JSON.parse(shifted))
    const pos = originalPositionFor(tracer, { line: genPos.line, column: genPos.column })
    assert.notEqual(pos.line, expected.line, 'un offset faux ne devrait PAS retomber sur la bonne ligne — sabotage inopérant')
  })
})

// ============================================================================
// la chaîne COMPLÈTE : `.mjs` → fichier écrit sur le disque.
// Les tests ci-dessus prouvent le premier maillon (compilateur de langage) ;
// ceux-ci prouvent qu'il survit aux 4 passes de réécriture, à l'assemblage dans
// le squelette de classe, et — en production — à esbuild.
// ============================================================================
describe('cartes de source — chaîne complète jusqu\'au fichier écrit', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  // Le composant témoin : une écriture réactive (réécrite par transformReactiveWrites),
  // une méthode, un appel — chacun sur SA ligne, pour qu'un décalage se voie.
  const SRC = [
    '<script>',
    '  $count = 0',
    '  @bump = ->',
    '    $count += 1',
    '    µ.log(\'temoin-bump\')',
    '</script>',
    '',
    '<div>',
    '  <span>{$count}</span>',
    '</div>',
  ].join('\n')

  async function compileTemoin(opts: Record<string, unknown>): Promise<{ js: string; map: any }> {
    const root   = mjsTmp('map3')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'temoin.mjs'), SRC)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), ...opts })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const files = readdirSync(outDir)
    const js = files.find((f: string) => /^temoin-.*\.js$/.test(f))
    assert.ok(js, `chunk attendu parmi ${files.join(', ')}`)
    assert.ok(files.includes(`${js}.map`), 'carte attendue à côté du chunk')
    return {
      js:  readFileSync(join(outDir, js!), 'utf-8'),
      map: JSON.parse(readFileSync(join(outDir, `${js}.map`), 'utf-8')),
    }
  }

  it('dev — chaque ligne du <script> retombe sur SA ligne du .mjs dans le fichier écrit', async () => {
    const { js, map } = await compileTemoin({})
    assert.deepEqual(map.sources, ['temoin.mjs'])
    const tracer = new TraceMap(map)
    // 3 repères, 3 lignes DIFFÉRENTES du .mjs : un décalage constant en tuerait au moins deux.
    for (const [needle, attendue] of [['temoin-bump', 5], ['$.count + (1)', 4], ['this.bump = function', 3]] as const) {
      const genPos = lineColOf(js, needle)
      const pos = originalPositionFor(tracer, { line: genPos.line, column: genPos.column })
      assert.equal(pos.source, 'temoin.mjs')
      assert.equal(pos.line, attendue, `« ${needle} » pointe la ligne ${pos.line} du .mjs, attendu ${attendue}`)
    }
  })

  it('dev — le source du .mjs est embarqué dans la carte (il n\'est jamais servi)', async () => {
    const { map } = await compileTemoin({})
    assert.ok(map.sourcesContent?.[0]?.includes('@bump = ->'), 'sourcesContent doit porter le .mjs entier')
  })

  it('prod (minifié) — la carte d\'esbuild est recomposée sur la nôtre, pas sur son entrée', async () => {
    const { js, map } = await compileTemoin({ forceMinify: true, sourceMap: 'always' })
    assert.deepEqual(map.sources, ['temoin.mjs'], 'sans recomposition, esbuild nommerait son propre fichier d\'entrée')
    const genPos = lineColOf(js, 'temoin-bump')
    const pos = originalPositionFor(new TraceMap(map), { line: genPos.line, column: genPos.column })
    assert.equal(pos.line, 5, `le code minifié pointe la ligne ${pos.line} du .mjs, attendu 5`)
  })
})

