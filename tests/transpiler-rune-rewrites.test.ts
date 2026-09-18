// Régressions sur le transpileur.
// Un `it` par défaut corrigé. Unitaires (applyMjsSugar /
// lintNoRawImport) rapides ; e2e (transpile réel) sous timeout large.

import assert from 'node:assert/strict'
import { transpile, applyMjsSugarToScript, lintNoRawImport } from '../src/transpiler/index.js'

describe('runes µ$ / store µ$$ compilables en Civet', () => {
  it('applyMjsSugar insère la DÉCLARATION lang-aware de µ_state', () => {
    // Civet (défaut) → `.=` (let), pas d'assignation NUE (rejetée par le lint).
    const civet = applyMjsSugarToScript('µ$count = 0', 'civet')
    assert.match(civet, /^µ_state \.= µ\.state\(\{\}\)/m)
    assert.doesNotMatch(civet, /^µ_state = µ\.state/m)
    // Coffee garde la forme nue (auto-déclaration native).
    assert.match(applyMjsSugarToScript('µ$count = 0', 'coffee'), /^µ_state = µ\.state\(\{\}\)/m)
    // js/ts → `let` explicite.
    assert.match(applyMjsSugarToScript('µ$count = 0', 'js'), /^let µ_state = µ\.state/m)
    assert.match(applyMjsSugarToScript('µ$count = 0', 'ts'), /^let µ_state = µ\.state/m)
  })

  it('garde d\'idempotence : ne double PAS une déclaration `.=` déjà présente', () => {
    const twice = applyMjsSugarToScript('µ$a = 1\nµ$b = 2', 'civet')
    assert.equal((twice.match(/µ_state \.= µ\.state\(\{\}\)/g) ?? []).length, 1)
  })

  it('e2e : transpile(<script module> export µ$$x = 0) en Civet COMPILE (ex-blocage)', async function () {
    this.timeout(8000)
    const src = ['<script module>', 'export µ$$x = 0', '</script>', '<p>{$x}</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-rune-c6', defaultScriptLang: 'civet' })
    assert.match(output, /let µ_state = µ\.state\(\{\}\)/)
    assert.match(output, /µ_state\.x \?\?= µ\.state\(0\)/)
    assert.match(output, /export var \$x = µ_state\.x/)
  })

  it('e2e : <script> composant Civet utilisant `µ$count` compile sans throw', async function () {
    this.timeout(8000)
    const src = ['<script>', 'µ$count = 0', 'inc = -> µ$count++', '</script>', '<button @click={inc()}>{µ$count}</button>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-rune-c6b', defaultScriptLang: 'civet' })
    assert.match(output, /µ_state/)
  })
})

describe('réécritures µ hors chaînes/commentaires', () => {
  it('un `µs` / `µ.on` DANS une chaîne n\'est PAS réécrit', () => {
    const out = applyMjsSugarToScript(`$msg = 'durée 12 µs, appelle µ.on'`, 'civet')
    assert.match(out, /'durée 12 µs, appelle µ\.on'/)
  })

  it('un `µ$x` DANS une chaîne n\'est PAS transformé en µ_state.x', () => {
    const out = applyMjsSugarToScript(`$s = "voir µ$x"`, 'civet')
    assert.match(out, /"voir µ\$x"/)
  })

  it('hors chaîne, le sucre s\'applique toujours (µlog→µ.log, µemit→routage)', () => {
    assert.match(applyMjsSugarToScript(`x = µlog('hi')`, 'civet'), /µ\.log\('hi'\)/)
    assert.match(applyMjsSugarToScript(`µemit 'evt'`, 'civet'), /_mjsThis\._mjs_emit/)
  })
})

describe('template literal multi-ligne pas corrompu', () => {
  it('un `#` dans un backtick multi-ligne reste du texte (pas `//`)', () => {
    const out = applyMjsSugarToScript('tpl := `\n  # titre\n  couleur: #fff\n`', 'civet')
    assert.match(out, /# titre/)
    assert.match(out, /#fff/)
    assert.doesNotMatch(out, /\/\/ titre/)
  })
})

describe('destructuration [a,b]=[b,a] (swap)', () => {
  it('e2e : swap de deux vars déjà déclarées compile (pas de re-déclaration)', async function () {
    this.timeout(8000)
    const src = ['<script>', 'a .= 1', 'b .= 2', '[a, b] = [b, a]', 'µlog(a)', '</script>', '<p>ok</p>'].join('\n')
    await assert.doesNotReject(() => transpile(src, { moduleName: 'mjs-rune-swap', defaultScriptLang: 'civet' }))
  })
})

describe('`let x` puis `x = 5`', () => {
  it('e2e : une déclaration explicite `let` puis réassignation nue compile', async function () {
    this.timeout(8000)
    const src = ['<script>', 'let x = 1', 'x = 5', 'µlog(x)', '</script>', '<p>ok</p>'].join('\n')
    await assert.doesNotReject(() => transpile(src, { moduleName: 'mjs-rune-letx', defaultScriptLang: 'civet' }))
  })
})

describe('réassignation d\'une var de <script module>', () => {
  it('e2e : `current` déclarée dans <script module>, réassignée top-level dans <script>', async function () {
    this.timeout(8000)
    const src = ['<script module>', 'current := null', '</script>', '<script>', 'current = 42', '</script>', '<p>{current}</p>'].join('\n')
    await assert.doesNotReject(() => transpile(src, { moduleName: 'mjs-rune-mv', defaultScriptLang: 'civet' }))
  })
})

describe('`export … from` banni', () => {
  it('lintNoRawImport throw sur `export { x } from` (unitaire)', () => {
    assert.throws(() => lintNoRawImport(`export { x } from './l.js';`, '<script module>'), /ré-export ES interdit/)
  })
  it('lintNoRawImport throw sur `export * from`', () => {
    assert.throws(() => lintNoRawImport(`export * from './l.js';`, '<script module>'), /ré-export ES interdit/)
  })
  it('`export const x = 1` (sans `from`) reste autorisé (non-régression)', () => {
    assert.doesNotThrow(() => lintNoRawImport(`export const x = 1;`, '<script module>'))
  })
})

describe('<script src> dans <@head> ne vole pas le script', () => {
  it('e2e : le <script> du composant est PRÉSERVÉ malgré un <script src> dans <@head>', async function () {
    this.timeout(8000)
    const src = [
      '<@head><script src="https://sdk.example/a.js"></script></@head>',
      '<script>', '$a = 1', '</script>',
      '<p>{$a}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-rune-hs', defaultScriptLang: 'civet' })
    // La logique du composant ($a = 1) doit être compilée (µ._set ou $.a = 1).
    assert.match(output, /'a', 1|\.a = 1/)
  })
})

describe('<@failed> handler à accolades imbriquées', () => {
  it('e2e : `@click={reset({hard:true})}` → arrow, PAS un objet littéral inerte', async function () {
    this.timeout(8000)
    const src = ['<@failed err reset>', '<button @click={reset({hard:true})}>retry</button>', '</@failed>', '<p>ok</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-rune-fb', defaultScriptLang: 'civet' })
    assert.match(output, /addEventListener\('click',\s*\(event\)\s*=>/)
    assert.doesNotMatch(output, /addEventListener\('click',\s*\{\s*reset:/)
  })
})

describe('<@window @resize=onResize> (ref sans accolades)', () => {
  it('e2e : onResize est câblé (pas de handler fantôme `resize(e)`)', async function () {
    this.timeout(8000)
    const src = ['<script>', 'onResize = -> µlog(1)', '</script>', '<@window @resize=onResize />', '<p>ok</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-rune-wr', defaultScriptLang: 'civet' })
    assert.match(output, /onResize\(/)
    assert.match(output, /addEventListener\('resize'/)
  })
})

describe('@this=!{ref} + var groupé Coffee (ref non-première)', () => {
  it('e2e : `zcanvas` (2ᵉ du `var a, zcanvas;` Coffee) n\'est PAS re-déclaré `let`', async function () {
    this.timeout(8000)
    const src = ['<script lang="coffee">', 'a = 1', 'zcanvas = null', '</script>',
                 '<canvas @this=!{zcanvas}></canvas>', '<p>{a}</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-rune-z' })
    const jsInit = output.slice(output.indexOf('init($)'))
    assert.doesNotMatch(jsInit, /^\s*let zcanvas;/m, 'pas de `let zcanvas;` hoisté au-dessus du var groupé')
    assert.match(jsInit, /\bvar [^\n;]*\bzcanvas\b/, 'la déclaration groupée Coffee `var …, zcanvas;` est présente')
  })
})

describe('µdebug sur un chemin membre', () => {
  it('`µdebug $obj.a` compile en effet (pas `µ.debug($.obj.a)`)', () => {
    const out = applyMjsSugarToScript('µdebug $obj.a', 'civet')
    assert.match(out, /µ\.effect =>/)
    assert.match(out, /µ\.log\('\[µdebug\] obj\.a =', \$obj\.a\)/)
    assert.doesNotMatch(out, /µ\.debug\(/)
  })
})
