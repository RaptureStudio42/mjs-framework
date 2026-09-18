// Test — dans une entry serveur `.server.mjs` (compileServerFile,
// src/cli/server-entry.ts), un `import … from` ES natif devient une ERREUR DE COMPILATION, comme
// partout ailleurs en MJS (règle lintNoRawImport, src/transpiler/index.ts) — seule la directive
// `@import nom 'cible'` importe. Même règle pour `export … from '…'` (ré-export) et
// `import('littéral')` (dynamique statique) ; `import(variable)` reste permis. L'entry `.civet`
// BRUTE (compileRawCivetFile, même fichier) n'est PAS concernée (Civet standard, sans pré-passe).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { compileServerFile, compileRawCivetFile } from '../src/cli/server-entry.js'
import { mjsTmp } from './helpers/tmp.js'

// dossiers temporaires créés par ce fichier — nettoyés une seule fois à la fin (jamais de
// fixture dans le dépôt)
const tmpDirs: string[] = []
function freshRoot(prefix: string): string {
  const root = mjsTmp(prefix)
  tmpDirs.push(root)
  mkdirSync(join(root, 'node_modules'))   //cache SOUS node_modules, jamais os.tmpdir() (serverCacheDir)
  return root
}
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

const MINIMAL = 'export default { setup(app) { return null } }\n'   //entry minimale valide (Civet)

describe("cli/server-entry — import ES natif interdit dans une entry serveur", function () {
  this.timeout(10000)

  it("cas 1 — import nommé (`import { x } from './x.js'`) seul → rejette, message cite l'entry, './x.js' et @import", async () => {
    const root = freshRoot('entry-raw-import-t1')
    writeFileSync(join(root, 'x.js'), 'export const x = 1\n')
    const entryPath = join(root, 'entry.server.mjs')
    writeFileSync(entryPath, `import { x } from './x.js'\n\n${MINIMAL}`)
    await assert.rejects(compileServerFile(entryPath, root), (err: any) => {
      assert.match(err.message, /entry\.server\.mjs/)
      assert.match(err.message, /\.\/x\.js/)
      assert.match(err.message, /@import/)
      return true
    })
  })

  it("cas 2 — import par défaut (`import fs from 'node:fs'`) → rejette", async () => {
    const root = freshRoot('entry-raw-import-t2')
    const entryPath = join(root, 'entry.server.mjs')
    writeFileSync(entryPath, `import fs from 'node:fs'\n\n${MINIMAL}`)
    await assert.rejects(compileServerFile(entryPath, root), (err: any) => {
      assert.match(err.message, /node:fs/)
      assert.match(err.message, /@import/)
      return true
    })
  })

  it("cas 3 — import à effet de bord seul (`import 'node:fs'`) → rejette", async () => {
    const root = freshRoot('entry-raw-import-t3')
    const entryPath = join(root, 'entry.server.mjs')
    writeFileSync(entryPath, `import 'node:fs'\n\n${MINIMAL}`)
    await assert.rejects(compileServerFile(entryPath, root), (err: any) => {
      assert.match(err.message, /node:fs/)
      assert.match(err.message, /@import/)
      return true
    })
  })

  it("cas 4 — import namespace (`import * as ns from 'node:fs'`) → rejette", async () => {
    const root = freshRoot('entry-raw-import-t4')
    const entryPath = join(root, 'entry.server.mjs')
    writeFileSync(entryPath, `import * as ns from 'node:fs'\n\n${MINIMAL}`)
    await assert.rejects(compileServerFile(entryPath, root), (err: any) => {
      assert.match(err.message, /node:fs/)
      assert.match(err.message, /@import/)
      return true
    })
  })

  it("cas 5 — deux lignes `@import` valides, AUCUN import natif → résout (compte exempté par leur nombre)", async () => {
    const root = freshRoot('entry-raw-import-t5')
    writeFileSync(join(root, 'a.civet'), 'export a := 1\n')
    writeFileSync(join(root, 'b.civet'), 'export b := 1\n')
    const entryPath = join(root, 'entry.server.mjs')
    writeFileSync(entryPath, `@import a './a.civet'\n@import b './b.civet'\n\n${MINIMAL}`)
    const url = await compileServerFile(entryPath, root)
    assert.match(url, /^file:\/\//)
  })

  it("cas 6 — `@import a` valide PUIS `import { y } from './y.js'` natif → rejette (le natif dépasse le compte exempté)", async () => {
    const root = freshRoot('entry-raw-import-t6')
    writeFileSync(join(root, 'a.civet'), 'export a := 1\n')
    const entryPath = join(root, 'entry.server.mjs')
    writeFileSync(entryPath, `@import a './a.civet'\n\nimport { y } from './y.js'\n\n${MINIMAL}`)
    await assert.rejects(compileServerFile(entryPath, root), (err: any) => {
      assert.match(err.message, /\.\/y\.js/)
      assert.match(err.message, /@import/)
      return true
    })
  })

  it("cas 7 — ré-export (`export { z } from './z.js'`) → rejette", async () => {
    const root = freshRoot('entry-raw-import-t7')
    const entryPath = join(root, 'entry.server.mjs')
    writeFileSync(entryPath, `export { z } from './z.js'\n\n${MINIMAL}`)
    await assert.rejects(compileServerFile(entryPath, root), (err: any) => {
      assert.match(err.message, /\.\/z\.js/)
      assert.match(err.message, /@import/)
      return true
    })
  })

  it("cas 8 — import dynamique d'un chemin LITTÉRAL (`import('./p.js')`) → rejette", async () => {
    const root = freshRoot('entry-raw-import-t8')
    const entryPath = join(root, 'entry.server.mjs')
    writeFileSync(entryPath, `load := -> import('./p.js')\n\n${MINIMAL}`)
    await assert.rejects(compileServerFile(entryPath, root), (err: any) => {
      assert.match(err.message, /entry\.server\.mjs/)
      assert.match(err.message, /@import/)
      return true
    })
  })

  it("cas 9 — import dynamique d'une VARIABLE (`import(u)`) → résout (invisible au graphe de toute façon)", async () => {
    const root = freshRoot('entry-raw-import-t9')
    const entryPath = join(root, 'entry.server.mjs')
    writeFileSync(entryPath, `load := (u) -> import(u)\n\n${MINIMAL}`)
    const url = await compileServerFile(entryPath, root)
    assert.match(url, /^file:\/\//)
  })

  it("cas 10 — `import x from 'y'` dans un COMMENTAIRE et dans une CHAÎNE → résout (AST du JS compilé, jamais une regex sur le source)", async () => {
    const root = freshRoot('entry-raw-import-t10')
    const entryPath = join(root, 'entry.server.mjs')
    writeFileSync(entryPath, `# import x from 'y'\nmsg := "import x from 'y'"\n\n${MINIMAL}`)
    const url = await compileServerFile(entryPath, root)
    assert.match(url, /^file:\/\//)
  })

  it("cas 11 — compileRawCivetFile sur un `.civet` avec `import { readFileSync } from 'node:fs'` → résout toujours (non concerné)", async () => {
    const root = freshRoot('entry-raw-import-t11')
    const entryPath = join(root, 'raw.civet')
    writeFileSync(entryPath, `import { readFileSync } from 'node:fs'\n\nexport default readFileSync\n`)
    const url = await compileRawCivetFile(entryPath, root)
    assert.match(url, /^file:\/\//)
  })
})
