// Tests du sigil ASCII configurable (fallback clavier non-AZERTY) : `mjs.X` → `µ.X`.

import assert from 'node:assert/strict'
import { normalizeSigilAlias, transpile } from '../src/transpiler/index.js'

describe('normalizeSigilAlias', () => {
  const n = (s: string) => normalizeSigilAlias(s, 'mjs')

  it('réécrit la forme pointée mjs.X → µ.X', () => {
    assert.equal(n('mjs.effect -> 1'), 'µ.effect -> 1')
    assert.equal(n('mjs.inspect $count'), 'µ.inspect $count')
    assert.equal(n("mjs.asset('logo.png')"), "µ.asset('logo.png')")
  })

  it('réécrit les sigils mjs$X → µ$X et mjs$$X → µ$$X (store)', () => {
    assert.equal(n('mjs$count = 0'), 'µ$count = 0')
    assert.equal(n('mjs$$count'), 'µ$$count')
  })

  it('NE TOUCHE PAS les mots qui commencent par mjs/mu (collés à une lettre)', () => {
    assert.equal(n('mjsonp(x)'), 'mjsonp(x)')
    assert.equal(n('const mjsConfig = 1'), 'const mjsConfig = 1')
    assert.equal(n('music = mutable + museum'), 'music = mutable + museum')
    assert.equal(n('formjs.thing'), 'formjs.thing')   // frontière de mot : pas dans un identifiant
  })

  it("no-op si sigil = 'µ' ou absent", () => {
    assert.equal(normalizeSigilAlias('mjs.effect', 'µ'), 'mjs.effect')
    assert.equal(normalizeSigilAlias('mjs.effect', undefined), 'mjs.effect')
  })
})

describe('transpile avec { sigil: "mjs" }', () => {
  it('compile mjs.inspect comme µinspect (extraction du nom)', async () => {
    const src = `<script lang="coffee">\n  $count = 0\n  mjs.inspect $count\n</script>\n<p>{$count}</p>`
    const out = (await transpile(src, { moduleName: 'x', sigil: 'mjs' })).output
    // µ.inspect('count') doit apparaître dans le JS généré (sucre appliqué).
    assert.match(out, /inspect\(\s*['"]count['"]\s*\)/)
  })

  it('défaut (sigil µ) : mjs.inspect N\'EST PAS réécrit', async () => {
    const src = `<script lang="coffee">\n  $count = 0\n  mjs.inspect $count\n</script>\n<p>{$count}</p>`
    const out = (await transpile(src, { moduleName: 'x' })).output
    assert.doesNotMatch(out, /µ\.inspect\(['"]count['"]\)/)
  })

  // l'alias ASCII du sigil DOIT être résolu AVANT le lint singleton et
  // extractDirectives (sinon `@import mjs$$X` n'est jamais reconnu comme un
  // import de singleton, sa forme canonique `µ$$X` n'existant pas encore à ce
  // stade de la pipeline).
  it('`@import mjs$$counter` (sigil ASCII) fonctionne comme `@import µ$$counter`', async () => {
    const src = `@import mjs$$counter 'p'\n<button @click={mjs$$counter.count++}>{mjs$$counter.count}</button>`
    const { output } = await transpile(src, { moduleName: 'x2', sigil: 'mjs' })
    assert.match(output, /import \{ \$counter \} from/, 'import généré identique à la forme µ$$')
    assert.match(output, /\$counter\.count\+\+/)
  })
})
