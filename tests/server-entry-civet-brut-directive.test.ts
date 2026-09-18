// Test — une entry `.civet` BRUTE (compileRawCivetFile, src/cli/server-entry.ts)
// n'a AUCUNE directive MJS (§13.3 docs/23-mjs-ws.md) — Civet compile pourtant `@import a './a.civet'`
// en `this.import(a("./a.civet"))` (appel de méthode ordinaire), une erreur qui ne se voit qu'au
// runtime, sans rapport avec la vraie cause. Refusé explicitement avant toute compilation. Modèle :
// tests/server-entry-raw-import.test.ts.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { compileRawCivetFile } from '../src/cli/server-entry.js'
import { mjsTmp } from './helpers/tmp.js'

const tmpDirs: string[] = []
function freshRoot(prefix: string): string {
  const root = mjsTmp(prefix)
  tmpDirs.push(root)
  mkdirSync(join(root, 'node_modules'))   //cache SOUS node_modules, jamais os.tmpdir() (serverCacheDir)
  return root
}
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

describe("cli/server-entry — entry '.civet' brute : directive MJS refusée", function () {
  this.timeout(10000)

  it("@import en colonne 0 → rejette, message cite l'entry et @import", async () => {
    const root = freshRoot('civet-brut-t1')
    const entryPath = join(root, 'raw.civet')
    writeFileSync(entryPath, `@import x './x.civet'\n\nexport default 1\n`)
    await assert.rejects(compileRawCivetFile(entryPath, root), (err: any) => {
      assert.match(err.message, /raw\.civet/)
      assert.match(err.message, /@import/)
      return true
    })
  })

  it("import { readFileSync } from 'node:fs' (natif, pas une directive MJS) → résout", async () => {
    const root = freshRoot('civet-brut-t2')
    const entryPath = join(root, 'raw.civet')
    writeFileSync(entryPath, `import { readFileSync } from 'node:fs'\n\nexport default readFileSync\n`)
    const url = await compileRawCivetFile(entryPath, root)
    assert.match(url, /^file:\/\//)
  })

  it("« # @import x '...' » dans un commentaire → résout, jamais lu comme une vraie directive", async () => {
    const root = freshRoot('civet-brut-t3')
    const entryPath = join(root, 'raw.civet')
    writeFileSync(entryPath, `# @import x './x.civet'\nexport default 1\n`)
    const url = await compileRawCivetFile(entryPath, root)
    assert.match(url, /^file:\/\//)
  })

  it('@css/@routes en colonne 0 → rejettent aussi (même famille de directives)', async () => {
    const root = freshRoot('civet-brut-t4')
    const entryCss = join(root, 'raw-css.civet')
    writeFileSync(entryCss, `@css nom\n\nexport default 1\n`)
    await assert.rejects(compileRawCivetFile(entryCss, root), /@css/)

    const entryRoutes = join(root, 'raw-routes.civet')
    writeFileSync(entryRoutes, `@routes\n\nexport default 1\n`)
    await assert.rejects(compileRawCivetFile(entryRoutes, root), /@routes/)
  })

  // un BOM UTF-8 (U+FEFF) en tête de fichier fait
  // rater la garde ci-dessus (regex ancrée `^[ \t]*@…`, le FEFF n'est ni un espace ni un `@`) :
  // la directive filait jusqu'au compilateur Civet, qui échouait avec un ParseError illisible,
  // sans jamais citer `@import` ni l'entry.
  it("BOM UTF-8 (U+FEFF) en tête + @import en colonne 0 → rejette quand même, jamais un ParseError Civet", async () => {
    const root = freshRoot('civet-brut-bom')
    const entryPath = join(root, 'raw.civet')
    writeFileSync(entryPath, `\uFEFF@import x './x.civet'\n\nexport default 1\n`)
    await assert.rejects(compileRawCivetFile(entryPath, root), (err: any) => {
      assert.match(err.message, /raw\.civet/)
      assert.match(err.message, /@import/)
      assert.doesNotMatch(err.message, /Failed to parse/)
      return true
    })
  })
})
