// Régression — fil d'Ariane du tuto : le maillon du MILIEU se vidait
// et ne se remplissait plus jamais, dès qu'on changeait de chapitre (12 cas sur
// 23 navigations mesurées au navigateur).
//
// Cause : un `{key}` de niveau RACINE laisse les interpolations de son contenu
// en effets par-variable ORDINAIRES (`_mjs_effectsByVar`), au lieu de les jouer
// aussi dans la passe structurelle juste après `_mjs_updKey` — ce que `{if}` fait
// depuis toujours (`branchExecBlock`, compile.ts). Le scénario qui tue :
//   1. trois `$` écrits à la suite dans le même tick ; la 1re écriture déclenche
//      `_mjs_renderStruct`, qui voit un état INTERMÉDIAIRE (nouveau chapitre, ancien
//      index de section) — la clé vaut `undefined`, le bloc est reconstruit ;
//   2. les 2e et 3e écritures trouvent le garde `_mjs_struct_dispatched_in_tick`
//      posé : elles reportent la passe structurelle en microtask, mais leurs
//      effets d'interpolation, eux, tournent TOUT DE SUITE (et remplissent le
//      bloc de l'étape 1) ;
//   3. la passe reportée reconstruit le bloc une SECONDE fois, avec la bonne
//      clé — et plus aucune variable ne mute derrière : les nœuds neufs restent
//      vides À VIE.
// Le bloc `{key}` VOISIN, dont la clé n'a pas rebougé entre les deux passes,
// n'est pas reconstruit et garde son contenu : d'où « un seul maillon vide ».

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// deux chapitres de PROFONDEUR différente : passer de l'un à l'autre en gardant
// l'ancien index de section produit l'état intermédiaire impossible (undefined)
const HOTE = [
  '<script>',
  '  chapitres = [',
  "    { id: 'a', sections: ['a1', 'a2', 'a3', 'a4', 'a5'] }",
  "    { id: 'b', sections: ['b1', 'b2'] }",
  '  ]',
  '',
  '  $chapIdx = 0',
  '  $secIdx  = 4',
  '',
  '  $chapitre = chapitres[$chapIdx]',
  '  $section  = $chapitre?.sections[$secIdx]',
  '',
  '  @aller = (c, s)->',
  '    $chapIdx = c',
  '    $secIdx  = s',
  '</script>',
  '',
  '<div class="fil">',
  '  {key $chapitre?.id}',
  '    <span class="chap">{$chapitre?.id ?? \'\'}</span>',
  '  {end}',
  '  <span class="sep">/</span>',
  '  {key $section}',
  '    <span class="sec"><b class="puce">{$secIdx}</b><i class="txt">{$section ?? \'\'}</i></span>',
  '  {end}',
  '</div>',
  '',
  '<button class="autre-chapitre" @click={@aller(1, 0)}>autre chapitre</button>',
  '<button class="autre-section" @click={@aller(0, 1)}>autre section</button>',
].join('\n')

async function monter(): Promise<{ window: any; hote: any }> {
  const root = mjsTmp('key-freres')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'hote.mjs'), HOTE)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const files = readdirSync(outDir)
  const pick = (re: RegExp) => {
    const f = files.find((f) => re.test(f))
    assert.ok(f, `chunk attendu ${re} parmi ${files.join(', ')}`)
    return f!
  }
  const code = [pick(/^mjs_core-/), pick(/^hote-/)].map((f) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))).join('\n')

  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(code + '\nglobalThis.µ = µ;')
  window.document.body.innerHTML = '<mjs-hote></mjs-hote>'
  await new Promise((r) => setTimeout(r, 80))
  return { window, hote: window.document.body.querySelector('mjs-hote') }
}

const lire = (hote: any) => {
  const r = hote._shadow
  const q = (s: string) => { const e = r.querySelector(s); return e ? e.textContent : null }
  return { chap: q('.chap'), puce: q('.puce'), txt: q('.txt') }
}

describe('{key} racine — deux blocs frères re-clés dans le même tick', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('au montage : les deux maillons sont remplis', async () => {
    const { window, hote } = await monter()
    assert.deepEqual(lire(hote), { chap: 'a', puce: '4', txt: 'a5' })
    window.close?.()
  })

  it('changement de SECTION seule (un seul bloc re-clé) : maillon rempli', async () => {
    const { window, hote } = await monter()
    hote._shadow.querySelector('.autre-section').click()
    await new Promise((r) => setTimeout(r, 60))
    assert.deepEqual(lire(hote), { chap: 'a', puce: '1', txt: 'a2' })
    window.close?.()
  })

  it('changement de CHAPITRE (les DEUX blocs re-clés) : le 2e maillon reste rempli', async () => {
    const { window, hote } = await monter()
    hote._shadow.querySelector('.autre-chapitre').click()
    await new Promise((r) => setTimeout(r, 60))
    assert.deepEqual(lire(hote), { chap: 'b', puce: '0', txt: 'b1' })
    window.close?.()
  })

  it('après un aller-retour de chapitre, rien ne reste vide', async () => {
    const { window, hote } = await monter()
    hote._shadow.querySelector('.autre-chapitre').click()
    await new Promise((r) => setTimeout(r, 60))
    hote._shadow.querySelector('.autre-section').click()
    await new Promise((r) => setTimeout(r, 60))
    assert.deepEqual(lire(hote), { chap: 'a', puce: '1', txt: 'a2' })
    window.close?.()
  })
})
