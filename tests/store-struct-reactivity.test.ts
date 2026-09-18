// Test de régression — un store `µ.state` ITÉRÉ (`{for … in @store}` /
// `Object.keys(@store)`) doit re-rendre quand ses CLÉS changent (ajout,
// retrait) ET quand une valeur est remplacée.
//
// Cas vécu (tuto /stream) : `@ennemis = @sock.stream 'ennemis'` (un µ.state)
// affiché via `{for id, en in @ennemis}`. Le faux serveur poussait bien les
// deltas (store[k] = …) mais la vue restait morte : le Proxy µ.state ne
// trackait que les lectures PAR CLÉ, et l'énumération (Object.keys / for…in)
// ne passait par AUCUN trap `get` → 0 abonnement sur l'ensemble des clés.
// De plus le store est VIDE à l'init → aucune clé à lire → aucun abonné.
//
// Fix (mjs_runes.ts) : clé-sentinelle `µ._mjs_STRUCT`, trap `ownKeys` qui l'abonne
// à l'énumération, et `set`/`deleteProperty` qui la notifient.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script>
@items = µ.state({})
</script>

<p class="count">{Object.keys(@items).length}</p>
<ul>
  {for k, it in @items}
    <li class="row">{it.v}</li>
  {end}
</ul>
`

describe('runtime — store µ.state itéré : réactivité structurelle', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('ajout/retrait/remplacement de clés re-rend le compteur ET le {for}', async function () {
    const root = mjsTmp('store')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'st.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^st-/.test(f))
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)

    document.body.innerHTML = '<mjs-st></mjs-st>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const count = () => el._shadow.querySelector('.count').textContent
    const rows = () => el._shadow.querySelectorAll('.row').length

    assert.equal(count(), '0', 'compteur initial = 0')
    assert.equal(rows(), 0, '0 ligne initiale')

    // Ajout de 3 clés (≡ delta reset du stream)
    el.items.a = { v: 10 }
    el.items.b = { v: 20 }
    el.items.c = { v: 30 }
    await new Promise(r => setTimeout(r, 40))
    assert.equal(count(), '3', 'après ajout de a,b,c → compteur = 3')
    assert.equal(rows(), 3, 'après ajout → 3 lignes')

    // Remplacement d'une valeur existante (≡ delta update de position)
    el.items.a = { v: 99 }
    await new Promise(r => setTimeout(r, 40))
    const texts = [...el._shadow.querySelectorAll('.row')].map((n: any) => n.textContent).sort()
    assert.ok(texts.includes('99'), 'après remplacement, la nouvelle valeur 99 est rendue')

    // Retrait d'une clé (≡ delta remove)
    delete el.items.b
    await new Promise(r => setTimeout(r, 40))
    assert.equal(count(), '2', 'après delete b → compteur = 2')
    assert.equal(rows(), 2, 'après delete → 2 lignes')

    win.close?.()
  })
})
