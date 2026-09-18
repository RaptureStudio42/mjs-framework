// Test du sigil $$ (store global) : un composant qui utilise $$x dans le script
// ET le template doit compiler $$x → µ.store.x. Vérifie le pipeline complet
// (lexer pour le template, générateur pour le script). Le sigil &$ (vault) a été
// RETIRÉ → il doit désormais lever une erreur de compilation.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script lang="coffee">
incr = ->
  $$game.score += 1
  $$session.user = 'Bob'
</script>

<button @click={incr}>+1</button>
<p class="out">{$$game.score} / {$$session.user}</p>
`

describe('sigil $$ → µ.store (store global réactif)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('compile $$x en µ.store.x dans le script ET le template', async () => {
    const root = mjsTmp('store-sigil')
    const srcDir = join(root, 'src'); const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'storetest.mjs'), COMPONENT)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const compFile = readdirSync(outDir).find((f: string) => /^storetest-/.test(f))!
    const out = readFileSync(join(outDir, compFile), 'utf8')
    // le sigil a bien été transformé (script + template)
    assert.ok(out.includes('µ.store.game'), 'µ.store.game attendu dans la sortie')
    assert.ok(out.includes('µ.store.session'), 'µ.store.session attendu dans la sortie')
    // plus aucun résidu de l'ancien vault
    assert.ok(!/&\$/.test(out), 'aucun &$ résiduel')
    assert.ok(!/µ\.vault/.test(out), 'aucun µ.vault résiduel')
  })
})
