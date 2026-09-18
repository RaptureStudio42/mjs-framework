// `splitFlipEntries` — scanner de chaînes : un antislash DOUBLÉ collé au guillemet fermant
// (`easing: 'a\\'`) empêchait la chaîne de se refermer. Le test `part[i - 1] !== '\\'` regarde
// UN caractère en arrière : il ne distingue pas `\'` (apostrophe échappée, la chaîne continue)
// de `\\'` (antislash littéral PUIS fin de chaîne). Conséquence : tout ce qui suit dans le
// `@flip={…}` était avalé par une chaîne qui ne se fermait jamais — les champs suivants
// disparaissaient, et la compilation finissait en erreur.
//
// Remède : dans une chaîne, un `\` consomme le caractère suivant quel qu'il soit — la règle
// d'échappement réelle, au lieu d'un coup d'œil en arrière.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('@flip — découpage des champs : échappement dans les chaînes', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  async function compileComp(html: string): Promise<{ errors: string[]; code: string | null }> {
    const root   = mjsTmp('flipesc')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), html)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    let code: string | null = null
    if (stats.errors.length === 0) {
      const compFile = readdirSync(outDir).find(f => /^comp-/.test(f))!
      code = readFileSync(join(outDir, compFile), 'utf-8')
    }
    await bundler.close()
    return { errors: stats.errors.map(e => e.message), code }
  }

  function liste(flipAttr: string): string {
    return ['<script lang="coffee">', '  $todos   = [{ id: 1 }, { id: 2 }]', '  $ralenti = 1', '</script>', '<ul>', '  {for todo in $todos by id}', `    <li ${flipAttr}>{todo.id}</li>`, '  {end}', '</ul>'].join('\n')
  }

  it("antislash DOUBLÉ en fin de chaîne : la chaîne se referme, les champs suivants survivent", async () => {
    const r = await compileComp(liste("@flip={easing: 'a\\\\', duration: 300}"))
    assert.deepEqual(r.errors, [], 'la chaîne doit se refermer sur son guillemet, pas avaler la suite')
    assert.match(r.code!, /setAttribute\("mjs-flip", "300"\)/, 'le champ APRÈS la chaîne piégée reste lu')
  })

  it("apostrophe ÉCHAPPÉE : la chaîne continue, la virgule interne ne sépare rien", async () => {
    const r = await compileComp(liste("@flip={easing: 'a\\', b', duration: 300}"))
    assert.deepEqual(r.errors, [])
    assert.match(r.code!, /setAttribute\("mjs-flip", "300"\)/)
  })
})
