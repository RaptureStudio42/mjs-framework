// mjs_devpanel — le panneau d'inspection dans la page (développement seulement).
//
// Ce qu'on verrouille ici : (1) il n'est PAS dans un bundle de production, (2) il l'est
// en développement, (3) il ouvre, montre l'arbre réel des composants montés, l'état, les
// dérivés AVEC leurs dépendances (le graphe compile-time, notre avantage), et (4) écrire
// une valeur dans le panneau change vraiment l'état du composant.
//
// Pipeline RÉEL (Bundler → core + composants compilés puis montés dans happy-dom, patron
// de tests/mjs-layout-runtime.test.ts) : jamais une copie recodée à la main du panneau.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { stripEsm } from '../src/server/renderToString.js'
import { assertAbsent } from './helpers/dom-assert.js'
import { mjsTmp } from './helpers/tmp.js'

const ENFANT = [
  '<script>',
  '$price ?= 2',
  '$quantity ?= 3',
  'computeTotal = -> $price * $quantity',
  'µderived $total = computeTotal(), $price, $quantity',
  '</script>',
  '<p class="t">{$total}</p>',
].join('\n')

// un composant de PAGE qui porte un champ : son `<input>` vit dans SON shadow root, pas dans
// celui du panneau — c'est ce voisinage-là qui faisait lever `activeElement` (cf. le test plus bas)
const SAISIE = [
  '<input class="s" aria-label="nom" value=!{$nom}>',
].join('\n')

const PARENT = [
  '<div class="p">',
  '  <mjs-dp-enfant></mjs-dp-enfant>',
  '</div>',
].join('\n')

async function compiler(prod: boolean) {
  const root   = mjsTmp('devpanel')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'dp-enfant.mjs'), ENFANT)
  writeFileSync(join(srcDir, 'dp-parent.mjs'), PARENT)
  writeFileSync(join(srcDir, 'dp-saisie.mjs'), SAISIE)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), ...(prod ? { env: 'prod' as const } : {}) })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const files = readdirSync(outDir)
  const core  = readFileSync(join(outDir, files.find(f => /^mjs_core-/.test(f))!), 'utf-8')
  await bundler.close()
  return { root, outDir, files, core }
}

/** Charge core + les deux composants dans une fenêtre happy-dom fraîche. */
function charger(outDir: string, files: string[]) {
  const window: any = new Window({ url: 'http://localhost/' })
  const lire = (f: string) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))
  window.eval(`${lire(files.find(f => /^mjs_core-/.test(f))!)}\nglobalThis.µ = µ;`)
  for (const nom of ['dp-enfant', 'dp-parent', 'dp-saisie']) {
    window.eval(lire(files.find(f => new RegExp(`^${nom}-[a-f0-9]{8}\\.js$`).test(f))!))
  }
  return window
}

describe('mjs_devpanel — le panneau d\'inspection', function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it('ABSENT du bundle de production — zéro poids chez qui déploie', async () => {
    const { core } = await compiler(true)
    assert.ok(!/µ\.devPanel\s*=/.test(core), 'le panneau ne doit pas être dans un bundle de production')
  })

  // RÉGRESSION — le panneau relisait sa
  // géométrie dans `localStorage` AU CHARGEMENT DU MODULE, et sa garde `typeof localStorage ===
  // 'undefined'` était posée DEVANT le try/catch. Sur un document d'ORIGINE OPAQUE (`about:blank`,
  // `page.setContent()` d'un Playwright, iframe sandboxée sans `allow-same-origin`), le simple
  // `typeof` lève un `SecurityError` : l'exception tuait tout le reste du core concaténé APRÈS ce
  // module — `µ.instances` jamais posé, `µ.devPanel` jamais défini, dans TOUT bundle de dev, que le
  // développeur ouvre le panneau ou non. Mesuré : 7 tests sur 8 de ssr-adopt-browser/ssr-bench.
  it('un `localStorage` qui LÈVE au chargement ne casse pas le reste du core', async () => {
    const { outDir, files } = await compiler(false)
    const window: any = new Window({ url: 'http://localhost/' })
    // reproduit une origine opaque : le SEUL accès à la propriété jette, `typeof` compris
    window.eval(`Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error("SecurityError: Access is denied for this document."); } });`)
    const lire = (f: string) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))
    window.eval(`${lire(files.find(f => /^mjs_core-/.test(f))!)}\nglobalThis.µ = µ;`)
    assert.equal(typeof window.µ.devPanel, 'function', 'le core doit finir de s\'évaluer malgré le stockage inaccessible')
    assert.ok(window.µ.instances, 'µ.instances doit être posé — c\'est lui qui disparaissait')
  })

  it('présent en développement, et µ.devPanel() existe', async () => {
    const { outDir, files } = await compiler(false)
    const window = charger(outDir, files)
    assert.equal(typeof window.µ.devPanel, 'function', 'µ.devPanel doit être exposée en développement')
  })

  it('ouvert, il montre l\'arbre réel des composants montés', async () => {
    const { outDir, files } = await compiler(false)
    const window = charger(outDir, files)
    window.document.body.innerHTML = '<mjs-dp-parent></mjs-dp-parent>'
    await new Promise(r => setTimeout(r, 60))

    assert.equal(window.µ.devPanel(), true, 'devPanel() doit ouvrir')
    const hote = window.document.querySelector('[data-mjs-devpanel]')
    assert.ok(hote, 'le panneau doit être dans la page')
    const texte = hote.shadowRoot.textContent
    assert.match(texte, /dp-parent/, `l'arbre doit citer le parent :\n${texte}`)
    assert.match(texte, /dp-enfant/, `et l'enfant, trouvé en franchissant la frontière d'ombre :\n${texte}`)
    assert.match(texte, /2 composants montés/, texte)

    assert.equal(window.µ.devPanel(), false, 'un second appel referme')
    assertAbsent(window.document.querySelector('[data-mjs-devpanel]'), 'et retire le panneau de la page')
  })

  it('sélectionner un composant montre son état, ses dérivés ET leurs dépendances', async () => {
    const { outDir, files } = await compiler(false)
    const window = charger(outDir, files)
    window.document.body.innerHTML = '<mjs-dp-enfant></mjs-dp-enfant>'
    await new Promise(r => setTimeout(r, 60))
    const el: any = window.document.body.firstElementChild

    // le graphe de dépendances vient du COMPILATEUR, pas d'une observation au vol.
    // Comparaison par chaîne : le tableau vient de la fenêtre happy-dom, son prototype
    // n'est pas celui de Node — deepEqual s'en offusquerait pour rien
    assert.equal(Array.from((el._mjs_computedDeps || {}).total || []).sort().join(','), 'price,quantity', `_mjs_computedDeps doit porter le graphe :\n${JSON.stringify(el._mjs_computedDeps)}`)

    window.µ.devPanel(true)
    const racine = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    racine.querySelectorAll('.ligne')[0].dispatchEvent(new window.Event('click', { bubbles: true }))

    // onglet État (par défaut) — les $ propres au composant, rendus par l'inspecteur générique
    const etatTexte = racine.querySelector('.onglet-corps').textContent
    assert.match(etatTexte, /\$?price/, etatTexte)

    // onglet Dérivés — sa propre section, avec les dépendances venues du COMPILATEUR
    racine.querySelector('.onglet[data-onglet="derives"]').dispatchEvent(new window.Event('click', { bubbles: true }))
    const derivesTexte = racine.querySelector('.onglet-corps').textContent
    assert.match(derivesTexte, /\$total/, derivesTexte)
    assert.match(derivesTexte, /←\s*\$price,\s*\$quantity|←\s*\$quantity,\s*\$price/, `les dépendances du dérivé doivent être affichées :\n${derivesTexte}`)
    window.µ.devPanel(false)
  })

  // Le panneau ancré en bas se posait PAR-DESSUS le bas de la page : le dernier écran du
  // document devenait inatteignable, quel que soit le défilement. La console du navigateur, elle,
  // rétrécit le viewport — impossible depuis un script ; on rallonge donc la course du défilement
  // d'autant, en posant un padding bas sur l'élément qui défile.
  it('ancré en bas, il RÉSERVE sa hauteur à la page (et la rend en flottant et à la fermeture)', async () => {
    const { outDir, files } = await compiler(false)
    const window = charger(outDir, files)
    window.document.body.innerHTML = '<mjs-dp-enfant></mjs-dp-enfant>'
    await new Promise(r => setTimeout(r, 60))
    const defilant: any = window.document.scrollingElement || window.document.documentElement

    window.µ.devPanel(true)
    const racine = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    const hauteur = racine.querySelector('.panneau').style.height
    assert.equal(defilant.style.paddingBottom, hauteur, `la page doit gagner la hauteur du panneau (${hauteur})`)
    // une page en `height: 100vh` ne défile pas — le padding ne peut rien pour elle ; elle lit
    // cette variable et se rétrécit d'elle-même (le tuto du site le fait : 900 px → 580 px)
    assert.equal(window.document.documentElement.style.getPropertyValue('--mjs-devpanel-h'), hauteur, '--mjs-devpanel-h doit porter la hauteur du panneau')
    assert.equal(window.document.documentElement.hasAttribute('data-mjs-devpanel-dock'), true, 'et l\'attribut doit marquer le mode ancré')

    // détaché : le panneau ne masque plus le bas, la page n'a plus rien à compenser
    racine.querySelector('[data-action="ancrer"]').dispatchEvent(new window.Event('click', { bubbles: true }))
    assert.equal(defilant.style.paddingBottom, '', 'en flottant, la place doit être rendue')
    assert.equal(window.document.documentElement.hasAttribute('data-mjs-devpanel-dock'), false, 'et le marqueur doit disparaître avec elle')

    racine.querySelector('[data-action="ancrer"]').dispatchEvent(new window.Event('click', { bubbles: true }))
    assert.notEqual(defilant.style.paddingBottom, '', 're-ancré, la place doit être reprise')
    window.µ.devPanel(false)
    assert.equal(defilant.style.paddingBottom, '', 'fermé, la page doit retrouver son bas')
    assert.equal(window.document.documentElement.style.getPropertyValue('--mjs-devpanel-h'), '', 'et la variable doit être retirée')
  })

  // Le rendu périodique (700 ms) réécrit TOUT l'innerHTML du panneau : le champ qu'on était en
  // train de remplir disparaissait sous les doigts, focus et texte en cours avec lui.
  it('le rafraîchissement périodique passe son tour tant qu\'on saisit', async () => {
    const { outDir, files } = await compiler(false)
    const window = charger(outDir, files)
    window.document.body.innerHTML = '<mjs-dp-enfant></mjs-dp-enfant>'
    await new Promise(r => setTimeout(r, 60))

    window.µ.devPanel(true)
    const racine = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    racine.querySelectorAll('.ligne')[0].dispatchEvent(new window.Event('click', { bubbles: true }))
    const champ: any = racine.querySelector('input.di-valeur[data-di-key="quantity"]')
    assert.ok(champ, 'la quantité doit être éditable dans le panneau')

    champ.focus()
    champ.value = '12'   // frappe en cours, pas encore validée
    await new Promise(r => setTimeout(r, 900))   // > 700 ms : au moins un battement est passé

    assert.equal(champ.isConnected, true, 'le champ en cours de saisie ne doit pas être remplacé sous les doigts')
    assert.equal(champ.value, '12', 'ni perdre ce qui y est tapé')

    // hors saisie, le rafraîchissement reprend : le panneau doit rester vivant
    champ.blur()
    await new Promise(r => setTimeout(r, 900))
    assert.equal(champ.isConnected, false, 'une fois le champ quitté, le rendu périodique doit repartir')
    window.µ.devPanel(false)
  })

  it('le défilement de l\'arbre survit à un rafraîchissement', async () => {
    const { outDir, files } = await compiler(false)
    const window = charger(outDir, files)
    window.document.body.innerHTML = '<mjs-dp-parent></mjs-dp-parent>'
    await new Promise(r => setTimeout(r, 60))
    window.µ.devPanel(true)
    const racine = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    racine.querySelector('.arbre').scrollTop = 42
    await new Promise(r => setTimeout(r, 900))
    assert.equal(racine.querySelector('.arbre').scrollTop, 42, 'l\'arbre ne doit pas remonter en haut tout seul')
    window.µ.devPanel(false)
  })

  // RÉGRESSION — la garde de saisie
  // lisait `_dpRoot.activeElement` À NU. Quand le focus est dans un AUTRE shadow root que celui du
  // panneau, happy-dom remonte la chaîne des hôtes et déréférence `undefined` : l'exception sortait
  // du callback de `setInterval`, qui ANNULE l'intervalle — le panneau restait figé POUR TOUJOURS,
  // sans message. Les navigateurs, eux, rendent `null` sans lever ; la garde vaut pour le reste.
  it('un champ de la PAGE qui prend le focus ne fige pas le panneau', async () => {
    const { outDir, files } = await compiler(false)
    const window = charger(outDir, files)
    window.document.body.innerHTML = '<mjs-dp-saisie></mjs-dp-saisie>'
    await new Promise(r => setTimeout(r, 60))

    window.µ.devPanel(true)
    const racine = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    const hote: any = window.document.querySelector('mjs-dp-saisie')
    const champPage = (hote.shadowRoot || hote._shadow).querySelector('input.s')
    assert.ok(champPage, 'le composant de page doit bien porter un champ')

    champPage.focus()   // le focus part dans le shadow root du COMPOSANT, pas dans celui du panneau
    window.document.body.insertAdjacentHTML('beforeend', '<mjs-dp-enfant></mjs-dp-enfant>')
    await new Promise(r => setTimeout(r, 900))   // > 700 ms : le battement doit avoir vu le nouveau venu

    assert.match(racine.querySelector('.compte').textContent, /2 composants montés/, 'le panneau doit continuer à suivre la page')
    window.µ.devPanel(false)
  })

  it('écrire une valeur dans le panneau change vraiment l\'état du composant', async () => {
    const { outDir, files } = await compiler(false)
    const window = charger(outDir, files)
    window.document.body.innerHTML = '<mjs-dp-enfant></mjs-dp-enfant>'
    await new Promise(r => setTimeout(r, 60))
    const el: any = window.document.body.firstElementChild
    assert.equal(el._state.total, 6, 'départ : 2 × 3')

    window.µ.devPanel(true)
    const racine = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    racine.querySelectorAll('.ligne')[0].dispatchEvent(new window.Event('click', { bubbles: true }))
    const champ = racine.querySelector('input.di-valeur[data-di-key="quantity"]')
    assert.ok(champ, 'la quantité doit être éditable dans le panneau')
    champ.value = '10'
    champ.dispatchEvent(new window.Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 30))

    assert.equal(el._state.quantity, 10, 'la valeur écrite doit atteindre le composant')
    assert.equal(el._state.total, 20, 'et son dérivé doit se recalculer')
    window.µ.devPanel(false)
  })
})
