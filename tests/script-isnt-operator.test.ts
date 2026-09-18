// Test de régression — l'opérateur CoffeeScript `isnt` dans un `<script>`.
//
// Bug vécu (tuto audio-player, handler onPlay) : `if audio isnt current` se
// compilait en `if (audio(isnt(current)))` → `ReferenceError: isnt is not
// defined` au clic. Cause : le `<script>` est compilé par Civet, qui ne
// connaît PAS `isnt` (il le parse comme l'appel `isnt(...)`).
//
// Fix : `applyMjsSugarToScript` convertit `isnt` → `is not` (que Civet
// transforme en `!==`) — sur le CODE uniquement (pas les strings/commentaires),
// et seulement pour les cibles non-Coffee (Coffee gère `isnt` nativement).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'
import { applyMjsSugarToScript } from '../src/transpiler/index.js'

describe('transpiler — opérateur `isnt` (Civet)', () => {
  it('`a isnt b` dans un <script> → `!==` (pas d\'appel `isnt(...)`)', async () => {
    const r = await transpile(
      `<script>\n  onPlay = (e) ->\n    audio = e.currentTarget\n    if audio isnt current\n      current = audio\n</script>\n<button @click={onPlay}>x</button>`,
      { moduleName: 'apx' }
    )
    assert.match(r.output, /audio !== current/, 'isnt doit devenir !==')
    assert.doesNotMatch(r.output, /isnt\s*\(/, 'aucun appel `isnt(...)` ne doit subsister')
  })

  it('applyMjsSugarToScript : `x isnt y` → `x is not y` (civet)', () => {
    const out = applyMjsSugarToScript('z = x isnt y', 'civet')
    assert.match(out, /x is not y/)
    assert.doesNotMatch(out, /\bisnt\b/)
  })

  it('string-safety : `isnt` dans une chaîne n\'est PAS converti', () => {
    const out = applyMjsSugarToScript(`msg = "ceci isnt converti"`, 'civet')
    assert.match(out, /isnt converti/, 'le `isnt` littéral dans la string reste intact')
  })

  it('Coffee : `isnt` est laissé intact (natif → !==)', () => {
    const out = applyMjsSugarToScript('z = x isnt y', 'coffee')
    assert.match(out, /\bisnt\b/, 'en Coffee, `isnt` reste (géré nativement)')
    assert.doesNotMatch(out, /is not/, 'ne PAS produire `is not` en Coffee (y signifierait `=== !`)')
  })

  // ── Var du `<script module>` réassignée dans le `<script>` composant ──
  // Bug vécu (audio-player) : `<script module> current = null` + un handler du
  // `<script>` qui fait `current = x` → auto-déclaration locale `let current`
  // → shadow block-scopé → TDZ « Cannot access 'current' before initialization ».
  // Fix : les vars top-level du module sont seedées dans le scope racine de
  // l'auto-déclaration du script composant (param `predeclared`).
  it('var module réassignée dans le script composant n\'est PAS re-déclarée (pas de TDZ)', async () => {
    const r = await transpile(
      `<script module>\n  current = null\n</script>\n<script>\n  onPlay = (e) ->\n    if e isnt current\n      current?.foo()\n      current = e\n</script>\n<button @click={onPlay}>x</button>`,
      { moduleName: 'mv' }
    )
    // `current` doit être déclaré UNE fois au module-scope, jamais re-`let` dans onPlay.
    assert.doesNotMatch(r.output, /onPlay[\s\S]{0,160}let current/,
      'onPlay ne doit pas re-déclarer `let current` (sinon TDZ sur `current?.foo()`)')
    assert.match(r.output, /e !== current/, 'isnt converti dans le contexte module aussi')
  })

  it('applyMjsSugarToScript : `predeclared` empêche la promotion en `.=`', () => {
    const out = applyMjsSugarToScript('current = audio', 'civet', ['current'])
    assert.doesNotMatch(out, /current\s*\.=/, 'var prédéclarée ne doit pas devenir `.=`')
    assert.match(out, /current\s*=\s*audio/, 'reste une réassignation simple')
  })

  // ── Destructuring `{ a, b } = expr` doit être DÉCLARÉ ──
  // Bug vécu (seek slider) : `{ left, width } = div.getBoundingClientRect()`
  // se compilait en réassignation `({left,width} = …)` à des vars non déclarées
  // → `left is not defined`. Fix : Pass 4 auto-déclare le destructuring (`.=`).
  it('`{ left, width } = expr` → déclaration (let), pas réassignation', async () => {
    const r = await transpile(
      `<script>\n  seek = (div) ->\n    { left, width } = div.getBoundingClientRect()\n    left + width\n</script>\n<div @click={seek}>x</div>`,
      { moduleName: 'dz' }
    )
    assert.match(r.output, /(let|const)\s*\{\s*left\s*,\s*width\s*\}/,
      'le destructuring doit être déclaré (let/const), sinon ReferenceError')
  })

  it('applyMjsSugarToScript : `{ a, b } = x` → `.=` (déclaration)', () => {
    const out = applyMjsSugarToScript('{ a, b } = obj', 'civet')
    assert.match(out, /\{ a, b \}\s*\.=/, 'destructuring promu en `.=`')
  })
})
