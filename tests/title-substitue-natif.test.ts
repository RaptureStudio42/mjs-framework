// runtime : substitution title natif ↔ bulle MJS (mjs_title.ts). Afficher
// à la fois la bulle MJS et l'infobulle native n'a pas de sens — la bulle MJS SE SUBSTITUE au
// `title` natif de l'élément qu'elle décore : retiré (mémorisé sur le nœud) tant que `mjs-title`
// reste posé, restitué à l'identique (chaîne vide comprise) dès que `mjs-title` disparaît. Même
// harnais que tests/runtime-title.test.ts (Bundler réel → mjs_core-*.js, happy-dom, vrais
// événements DOM). Popover NON patché ici (comme le premier bloc du fichier voisin) : repli body
// exercé pour le premier describe (light DOM) — suffisant, aucun composant n'y est monté.
//
// Nom accessible (cf. mjs_title.ts __titleNeedsAccessibleName) : un `title` natif peut être
// le SEUL nom accessible d'un élément sans texte visible ni aria-label/aria-labelledby déjà posé
// (icône seule, etc.) — sa disparition le rendrait anonyme pour les technologies d'assistance. Un
// `aria-label` de secours reprenant la valeur native est alors posé le temps de la substitution,
// jamais si l'auteur en a déjà un (aria-label ou aria-labelledby).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { assertAbsent } from './helpers/dom-assert.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// buildCore minimal — même patron que tests/runtime-title.test.ts (dupliqué à dessein, cf. ce
// fichier voisin : aucun helper partagé pour ça dans tests/helpers/).
async function buildCore(extraComponent?: { name: string; src: string }) {
  const root = mjsTmp('title-native')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'placeholder.mjs'), `<script>\n$x = 0\n</script>\n<div>ph</div>`)
  if (extraComponent) writeFileSync(join(srcDir, `${extraComponent.name}.mjs`), extraComponent.src)
  // mjs_title n'est plus dans le cœur d'office : demandé explicitement, ces tests exercent le module sans source qui pose @title
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), runtime: ['title'] })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'mjs_core-*.js introuvable')
  const compFile = extraComponent ? files.find((f: string) => new RegExp(`^${extraComponent.name}-`).test(f)) : undefined
  return {
    coreCode: stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')),
    compCode: compFile ? stripEsm(readFileSync(join(outDir, compFile), 'utf-8')) : null,
  }
}

describe('runtime @title — substitution du title natif', function () {
  this.timeout(40000)

  let window: any = null
  let document: any = null

  before(async function () {
    const { coreCode } = await buildCore()
    window = new Window({ url: 'http://localhost/' })
    document = window.document
    window.eval(`${coreCode}\nglobalThis.µ = µ;\nµ.config.title.delay = 20;`)
  })

  after(async () => {
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  afterEach(() => {
    // ferme toute bulle laissée ouverte par le test précédent (même patron que le fichier voisin)
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

  it('title natif + mjs-title : au survol, title retiré du nœud et bulle affichée avec le texte de mjs-title', async () => {
    document.body.innerHTML = `<button id="n1" title="Astuce native" mjs-title="Astuce MJS">x</button>`
    const el = document.getElementById('n1')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(40)
    const bubble = document.querySelector('.mjs-title-visible')
    assert.ok(bubble, 'la bulle MJS doit être affichée')
    assert.equal(bubble.textContent, 'Astuce MJS')
    assert.equal(el.hasAttribute('title'), false, 'le title natif doit avoir été retiré')
  })

  it('retrait de mjs-title pendant que la bulle est affichée → title natif restauré à l\'identique', async () => {
    document.body.innerHTML = `<button id="n2" title="Valeur native" mjs-title="Astuce MJS">x</button>`
    const el = document.getElementById('n2')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(40)
    assert.equal(el.hasAttribute('title'), false, 'title retiré pendant la substitution')
    el.removeAttribute('mjs-title')
    await sleep(10)
    assertAbsent(document.querySelector('.mjs-title-visible'), 'la bulle doit se fermer')
    assert.equal(el.getAttribute('title'), 'Valeur native', 'title natif restauré à l\'identique')
  })

  it('élément SANS title natif → aucun attribut title inventé, avant et après le survol', async () => {
    document.body.innerHTML = `<button id="n3" mjs-title="Astuce MJS">x</button>`
    const el = document.getElementById('n3')
    assert.equal(el.hasAttribute('title'), false, 'aucun title au départ')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(40)
    assert.ok(document.querySelector('.mjs-title-visible'), 'la bulle doit être affichée')
    assert.equal(el.hasAttribute('title'), false, 'toujours aucun title après le survol : rien d\'inventé')
    el.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
    await sleep(10)
    assert.equal(el.hasAttribute('title'), false, 'toujours aucun title après la fermeture')
  })

  it('title="" natif (chaîne vide, cas volontaire) → restauré tel quel à la fermeture', async () => {
    document.body.innerHTML = `<button id="n4" title="" mjs-title="Astuce MJS">x</button>`
    const el = document.getElementById('n4')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(40)
    assert.equal(el.hasAttribute('title'), false, 'title="" retiré pendant la substitution')
    el.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
    await sleep(10)
    assert.equal(el.hasAttribute('title'), true, 'title doit être reposé (même vide)')
    assert.equal(el.getAttribute('title'), '', 'restauré exactement vide, pas retiré ni inventé')
  })

  it('deux éléments voisins, un seul décoré → l\'autre garde son title intact', async () => {
    document.body.innerHTML = `
      <button id="n5a" title="Natif A" mjs-title="Astuce MJS">a</button>
      <button id="n5b" title="Natif B">b</button>
    `
    const a = document.getElementById('n5a')
    const b = document.getElementById('n5b')
    a.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(40)
    assert.equal(a.hasAttribute('title'), false, 'le décoré perd son title pendant la substitution')
    assert.equal(b.getAttribute('title'), 'Natif B', 'le voisin non décoré garde son title intact')
  })

  it('l\'auteur change le title natif PENDANT que la bulle est affichée → réécrasé aussitôt, la DERNIÈRE valeur est restituée à la fermeture', async () => {
    document.body.innerHTML = `<button id="n6" title="Ancien" mjs-title="Astuce MJS">x</button>`
    const el = document.getElementById('n6')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(40)
    assert.equal(el.hasAttribute('title'), false, 'title retiré à l\'apparition de la bulle')
    el.setAttribute('title', 'Nouveau')
    await sleep(10) // laisse le MutationObserver traiter la mutation
    assert.equal(el.hasAttribute('title'), false, 'la bulle MJS reste seule maîtresse : réécrasé aussitôt')
    el.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
    await sleep(10)
    assert.equal(el.getAttribute('title'), 'Nouveau', 'restitution de la DERNIÈRE valeur donnée par l\'auteur, pas l\'originale')
  })

  it('aucun texte visible ni aria-label/aria-labelledby : title natif = seul nom accessible → aria-label de secours posé le temps de la substitution', async () => {
    document.body.innerHTML = `<button id="n7" title="Fermer" mjs-title="Astuce MJS"><svg></svg></button>`
    const el = document.getElementById('n7')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(40)
    assert.equal(el.getAttribute('aria-label'), 'Fermer', 'aria-label de secours = valeur native mise de côté')
    el.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
    await sleep(10)
    assert.equal(el.hasAttribute('aria-label'), false, 'aria-label de secours retiré à la restitution du title')
    assert.equal(el.getAttribute('title'), 'Fermer', 'title natif restitué')
  })

  it('aria-label DÉJÀ posé par l\'auteur → jamais écrasé, jamais retiré à la fermeture', async () => {
    document.body.innerHTML = `<button id="n8" title="Fermer" aria-label="Fermer la fenêtre" mjs-title="Astuce MJS"><svg></svg></button>`
    const el = document.getElementById('n8')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(40)
    assert.equal(el.getAttribute('aria-label'), 'Fermer la fenêtre', 'aria-label de l\'auteur intact pendant la substitution')
    el.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
    await sleep(10)
    assert.equal(el.getAttribute('aria-label'), 'Fermer la fenêtre', 'toujours intact après restitution du title')
  })

  it('aria-labelledby DÉJÀ posé par l\'auteur → aucun aria-label ajouté', async () => {
    document.body.innerHTML = `
      <span id="n10lbl">Fermer</span>
      <button id="n10" title="Fermer" aria-labelledby="n10lbl" mjs-title="Astuce MJS"><svg></svg></button>
    `
    const el = document.getElementById('n10')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(40)
    assert.equal(el.hasAttribute('aria-label'), false, 'aria-labelledby déjà présent : aucun aria-label de secours')
  })

  it('texte visible (bouton texte) : title natif accessoire → aucun aria-label ajouté', async () => {
    document.body.innerHTML = `<button id="n9" title="Astuce native" mjs-title="Astuce MJS">Enregistrer</button>`
    const el = document.getElementById('n9')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(40)
    assert.equal(el.hasAttribute('aria-label'), false, 'texte visible déjà nom accessible : rien à poser')
  })
})

describe('runtime @title — non-régression : les 3 formes affichent toujours la bulle', function () {
  this.timeout(40000)

  let window: any = null
  let document: any = null
  let el: any = null

  before(async function () {
    const COMPONENT = `
<script>
$msg = 'Expression réactive'
</script>
<button id="f1" @title="Chaîne statique">a</button>
<button id="f2" @title={$msg}>b</button>
<button id="f3" @title={ text: 'Objet options', side: 'bottom' }>c</button>
`
    const { coreCode, compCode } = await buildCore({ name: 'titleforms', src: COMPONENT })
    window = new Window({ url: 'http://localhost/' })
    document = window.document
    window.eval(`${coreCode}\nglobalThis.µ = µ;\nµ.config.title.delay = 20;\n${compCode}`)
    document.body.innerHTML = '<mjs-titleforms></mjs-titleforms>'
    el = document.body.firstElementChild
    await sleep(50)
  })

  after(async () => {
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  afterEach(() => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

  // NB mount : Popover peut être ON ou OFF selon que ce fichier tourne seul ou après une autre
  // suite ayant patché showPopover sur ce process (fuite constatée entre Window happy-dom
  // distinctes) — la bulle atterrit alors DANS le shadow plutôt que dans document.body. Ce bloc
  // ne teste QUE « la bulle affiche le bon texte », peu importe où — les deux emplacements sont
  // donc cherchés, sans trancher lequel des deux modes est actif ici.
  it('forme CHAÎNE (@title="texte") → bulle affichée avec ce texte', async () => {
    const btn = el._shadow.querySelector('#f1')
    btn.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, composed: true }))
    await sleep(40)
    const bubble = document.querySelector('.mjs-title-visible') || el._shadow.querySelector('.mjs-title-visible')
    assert.ok(bubble, 'bulle attendue (forme chaîne)')
    assert.equal(bubble.textContent, 'Chaîne statique')
    btn.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, composed: true }))
  })

  it('forme EXPRESSION (@title={$msg}) → bulle affichée avec la valeur courante', async () => {
    const btn = el._shadow.querySelector('#f2')
    btn.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, composed: true }))
    await sleep(40)
    const bubble = document.querySelector('.mjs-title-visible') || el._shadow.querySelector('.mjs-title-visible')
    assert.ok(bubble, 'bulle attendue (forme expression)')
    assert.equal(bubble.textContent, 'Expression réactive')
    btn.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, composed: true }))
  })

  it('forme OBJET ({ text: ... }) → bulle affichée avec le texte de l\'objet', async () => {
    const btn = el._shadow.querySelector('#f3')
    btn.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, composed: true }))
    await sleep(40)
    const bubble = document.querySelector('.mjs-title-visible') || el._shadow.querySelector('.mjs-title-visible')
    assert.ok(bubble, 'bulle attendue (forme objet)')
    assert.equal(bubble.textContent, 'Objet options')
    btn.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, composed: true }))
  })
})
