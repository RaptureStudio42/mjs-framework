// Test de régression — les méthodes mutatrices de `Date` (`setTime`,
// `setHours`, `setDate`…) déclenchent `_mjs_notifyMutation` quand l'instance
// est assignée à `$X`. Cas vécu (tuto built-ins-reactifs) : une horloge
// qui mute `$date.setTime(Date.now())` toutes les secondes ne re-rendait
// pas parce que `Date` était traitée comme `isDateLike` mais sans
// `mutators` dans `_mjs_wrapDeep` (mutators = null pour Date).
//
// Fix : `MJS_DATE_MUTATORS` couvre `setTime` + toutes les `setX` (UTC
// inclus). Routé via le même chemin que `MJS_SET_MUTATORS` / `MJS_MAP_MUTATORS`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

const COMPONENT = `
<script>
$date = new Date(2026, 0, 1, 12, 0, 0);
</script>

<p class="h">{$date.getHours()}</p>
<p class="m">{$date.getMinutes()}</p>
<p class="s">{$date.getSeconds()}</p>
`

describe('runtime — méthodes mutatrices de Date déclenchent _mjs_notifyMutation', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('setTime, setHours, setDate re-rendent les bindings qui lisent l\'instance', async function () {
    const root = mjsTmp('date')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'dt.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^dt-/.test(f))
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)

    document.body.innerHTML = '<mjs-dt></mjs-dt>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const h = () => el._shadow.querySelector('.h').textContent
    const m = () => el._shadow.querySelector('.m').textContent
    const s = () => el._shadow.querySelector('.s').textContent

    assert.equal(h(), '12', 'heures initiales = 12')
    assert.equal(m(), '0', 'minutes initiales = 0')
    assert.equal(s(), '0', 'secondes initiales = 0')

    // setTime — point d'entrée principal de l'horloge du tuto.
    el._state.date.setTime(new Date(2026, 0, 1, 14, 30, 45).getTime())
    await new Promise(r => setTimeout(r, 30))
    assert.equal(h(), '14', 'après setTime, heures = 14')
    assert.equal(m(), '30', 'après setTime, minutes = 30')
    assert.equal(s(), '45', 'après setTime, secondes = 45')

    // setHours
    el._state.date.setHours(9)
    await new Promise(r => setTimeout(r, 30))
    assert.equal(h(), '9', 'après setHours(9), heures = 9')

    // setMinutes
    el._state.date.setMinutes(15)
    await new Promise(r => setTimeout(r, 30))
    assert.equal(m(), '15', 'après setMinutes(15), minutes = 15')

    // setSeconds
    el._state.date.setSeconds(7)
    await new Promise(r => setTimeout(r, 30))
    assert.equal(s(), '7', 'après setSeconds(7), secondes = 7')

    win.close?.()
  })
})
