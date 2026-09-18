// Régressions du générateur :
//   - apostrophe dans un attribut STATIQUE (`title="l'heure"`) →
//     détruite au parse du template cloné (attribut coupé + attrs parasites).
//   - `@style.<prop>="…'…"` (quotes CSS) → littéral JS invalide dans
//     `_mjs_eff` → SyntaxError du module → TOUTE la réactivité du composant morte.
//   - `{if}` au ROOT avec un `const c` nu → TDZ dès qu'une var de SCRIPT
//     s'appelle `c` (crash dur à chaque `_mjs_renderStruct`).
//   - var externe lue par un binding (hors texte/two-way) d'une row →
//     `structVars` manquant → DOM figé à vie sur mutation.
//
// Vérification RUNTIME (happy-dom) : les 2e et 3e points ci-dessus sont des morts « silencieuses »
// (module cassé / crash au render), qu'un simple `transpile()` ne détecterait pas.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

async function mount(name: string, source: string): Promise<{ window: any; el: any }> {
  const root   = mjsTmp(`cc-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any   = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  const errors: any[] = []
  window.addEventListener('error', (e: any) => errors.push(e.error ?? e.message))
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  if (errors.length > 0) throw new Error(`Erreur(s) runtime au montage de mjs-${name} : ${errors.map(String).join(' | ')}`)
  return { window, el }
}

describe('générateur — correctifs codegen critiques', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it("apostrophe dans un attribut statique `title=\"l'heure\"` : attribut INTACT, pas d'attrs parasites", async () => {
    const src = [
      '<script lang="coffee">',
      '$x = 1',
      '</script>',
      "<div class=\"box\" title=\"l'heure du thé\" data-info=\"c'est d'accord\">apos</div>",
    ].join('\n')
    const { el } = await mount('ccapos', src)
    const div = el._shadow.querySelector('.box')
    assert.ok(div, 'le <div> doit exister')
    assert.equal(div.getAttribute('title'), "l'heure du thé", "AVANT le fix : title=\"l\" + attributs parasites heure/du/thé")
    assert.equal(div.getAttribute('data-info'), "c'est d'accord")
    // Aucun attribut parasite issu du texte coupé.
    assert.equal(div.hasAttribute('heure'), false, "pas d'attribut booléen parasite « heure »")
    assert.equal(div.hasAttribute('accord'), false, "pas d'attribut booléen parasite « accord »")
  })

  it('`@style.grid-template-areas` avec quotes CSS : le composant reste VIVANT (réactivité intacte)', async () => {
    const src = [
      '<script lang="coffee">',
      '$n = 0',
      'inc = -> $n++',
      '</script>',
      '<div @style.grid-template-areas="\'hd\' \'main\'" style="display:grid">',
      '<button @click={inc()}>+</button>',
      '<span class="cnt">{$n}</span>',
      '</div>',
    ].join('\n')
    const { window, el } = await mount('ccstyle', src)
    // Réactivité : un module cassé (SyntaxError, AVANT le fix) n'aurait jamais
    // câblé le handler → le compteur resterait à 0.
    const cnt = el._shadow.querySelector('.cnt')
    assert.equal(cnt.textContent.trim(), '0')
    el._shadow.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 40))
    assert.equal(cnt.textContent.trim(), '1', 'AVANT le fix : littéral JS invalide → module mort → compteur figé à 0')
    // La valeur CSS multi-quotes a bien été posée.
    const box = el._shadow.querySelector('div')
    assert.match(box.style.getPropertyValue('grid-template-areas'), /hd/, 'la valeur grid-template-areas doit être appliquée')
  })

  it('`{if}` au ROOT avec une var de SCRIPT nommée `c` : pas de crash TDZ', async () => {
    const src = [
      '<script lang="coffee">',
      'c = 42',
      '</script>',
      '<div>{if c > 3}<p class="yes">grand</p>{end}</div>',
    ].join('\n')
    const { el } = await mount('ccifc', src)
    const yes = el._shadow.querySelector('.yes')
    assert.ok(yes, "AVANT le fix : `const c = (c > 3) ? …` → TDZ auto-référence → crash à chaque _mjs_renderStruct")
    assert.equal(yes.textContent.trim(), 'grand')
  })

  it('`@style.color={$theme}` dans un {for} : réactif sur mutation de la var externe', async () => {
    const src = [
      '<script lang="coffee">',
      "$theme = 'red'",
      '$rows = [{id:1},{id:2},{id:3}]',
      "setBlue = -> $theme = 'blue'",
      '</script>',
      '<button @click={setBlue()}>go</button>',
      '<ul>{for row in $rows}<li class="cell" @style.color={$theme}>{row.id}</li>{end}</ul>',
    ].join('\n')
    const { window, el } = await mount('ccstylefor', src)
    let cells = [...el._shadow.querySelectorAll('.cell')]
    assert.equal(cells.length, 3)
    assert.ok(cells.every((c: any) => c.style.color === 'red'), 'couleur initiale = red sur toutes les rows')
    el._shadow.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 60))
    cells = [...el._shadow.querySelectorAll('.cell')]
    assert.ok(cells.every((c: any) => c.style.color === 'blue'), 'AVANT le fix : structVars manquant → couleur figée à red sur mutation de $theme')
  })
})
