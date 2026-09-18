// Régression : le filtre XSS `µ._mjs_safeAttr`
// (bloque `javascript:`/`data:text/html` sur les attributs de navigation)
// n'était appliqué QU'au root (`this._mjs_updAttr` → `µ._mjs_safeAttr`) — les
// chemins `{for}` (dynamic/attribute générique) faisaient un `setAttribute`
// brut, sans filtre. Fermé par le même refactor que les bugs « attribut
// $var perdu »/« booléens cassés » (`µ._mjs_updAttrNode`, qui délègue à
// `µ._mjs_safeAttr` pour root ET {for}).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('µ._mjs_safeAttr appliqué en {for} (attribut dynamique générique)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it("href={item.url} avec une valeur javascript: dans un {for} : neutralisée", async () => {
    const src = [
      '<script lang="coffee">',
      '$rows = [{id:1, url: "javascript:alert(1)"}, {id:2, url: "https://ok.example/"}]',
      '</script>',
      '<ul>{for row in $rows}<li><a href={row.url}>x</a></li>{end}</ul>',
    ].join('\n')

    const root = mjsTmp('xssfor')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'xssfor.mjs'), src)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^xssfor-/.test(f))
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
    document.body.innerHTML = '<mjs-xssfor></mjs-xssfor>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const links = el._shadow.querySelectorAll('a')
    assert.equal(links.length, 2)
    // Le template statique pose un placeholder `href=''` (attrStr codegen) —
    // `µ._mjs_safeAttr` bloque l'ÉCRITURE dangereuse (skip silencieux) mais ne
    // retire pas cet attribut préexistant : l'assertion porte donc sur la
    // VALEUR (jamais la chaîne javascript:), pas sur l'absence de l'attribut.
    assert.notEqual(links[0].getAttribute('href'), 'javascript:alert(1)', "AVANT le fix : href=\"javascript:alert(1)\" écrit sans filtre")
    assert.equal(links[0].getAttribute('href'), '', "la valeur dangereuse doit être bloquée, le placeholder vide reste")
    assert.equal(links[1].getAttribute('href'), 'https://ok.example/', 'une URL légitime doit passer normalement')
  })
})
