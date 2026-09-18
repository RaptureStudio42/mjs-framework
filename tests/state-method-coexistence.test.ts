// un composant peut désormais déclarer un état `$face` ET une méthode `@face`
// du même nom (le compilateur ne refuse plus, cf. state-method-name-clash.test.ts). Ce fichier
// vérifie le runtime EN VRAI : composant compilé et monté (Bundler + happy-dom, même harnais que
// if-optional-chain-mount.test.ts), pas un sandbox `new Function(...)`.
//
// Mécanique : le constructeur généré pose `this.face = function…` SUR L'INSTANCE (fermeture sur
// les variables internes) — une own-property, exactement comme le ferait un parent qui poserait
// `el.face = valeur` avant que la classe n'existe (autoloader paresseux). Le salvage pré-upgrade de
// connectedCallback (mjs_element.ts) doit donc épargner LA FONCTION (cf. `_mjs_state_methods`) sans
// jamais casser le salvage normal des vraies props posées par un parent — homonymes ou non, du
// moment que leur valeur n'est PAS une fonction.

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

/** Compile UN composant (fichier `${fileBase}.mjs`) et le monte dans une fenêtre happy-dom
 * fraîche. `innerHtml` permet de poser des attributs dès le montage initial (point 5 — prop
 * posée par un parent). Retourne `{ win, document, el }`. */
async function compileAndMount(fileBase: string, source: string, tagName: string, innerHtml?: string) {
  const root = mjsTmp(`coex-${fileBase}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${fileBase}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const win: any = new Window({ url: 'http://localhost/' })
  const document: any = win.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${fileBase}-`).test(f))
  assert.ok(coreFile && compFile, 'core + composant compilés')
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
  const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
  win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

  document.body.innerHTML = innerHtml ?? `<${tagName}></${tagName}>`
  const el: any = document.body.firstElementChild
  await new Promise((r) => setTimeout(r, 80))
  return { win, document, el }
}

// composant partagé — `$face` (état) ET `@face` (méthode) du même nom, `$hits` pour observer
// l'exécution réelle de la méthode, `$libre` = état SANS méthode homonyme (anti-régression C).
const COMPONENT = `<script>
$face = 'valeur-de-face'
$hits = 0
$libre = 'intact'
@face = ->
  $hits += 1
</script>
<p class="etat">{$face}</p>
<p class="hits">{$hits}</p>
<p class="libre">{$libre}</p>
<button class="btn" @click={@face()}>cliquer</button>
`

describe('coexistence état / méthode homonymes — composant réel monté', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  describe('A — montage nu (points 1 à 4, même instance, assertions cumulatives)', () => {
    let el: any

    before(async () => {
      ({ el } = await compileAndMount('coexmount', COMPONENT, 'mjs-coexmount'))
    })

    it('point 1 — la méthode vit sur l\'instance, l\'état vaut sa valeur déclarée (pas la fonction)', () => {
      assert.equal(typeof el.face, 'function', 'this.face doit être la méthode compilée')
      assert.equal(el._state.face, 'valeur-de-face', 'l\'état ne doit JAMAIS avoir reçu la fonction')
    })

    it('point 2 — {$face} rend la VALEUR, jamais le code source de la fonction', () => {
      const texte = el._shadow.querySelector('.etat').textContent
      assert.equal(texte, 'valeur-de-face')
      assert.doesNotMatch(texte, /function/, 'le template ne doit jamais afficher le code source')
    })

    it('point 3 — @click={@face()} exécute réellement la méthode (aucune exception avalée)', async () => {
      assert.equal(el._shadow.querySelector('.hits').textContent, '0', 'avant clic')
      el._shadow.querySelector('.btn').dispatchEvent(new el.ownerDocument.defaultView.Event('click', { bubbles: true, composed: true }))
      await new Promise((r) => setTimeout(r, 60))
      // si @face() avait échoué silencieusement (this.face undefined avant le fix), $hits
      // resterait à 0 — la mutation observée ICI est la preuve directe que la méthode a tourné.
      assert.equal(el._shadow.querySelector('.hits').textContent, '1')
    })

    it('point 4 — écriture non réactive de l\'état (_state direct, sans passer par _set) épargne la méthode', () => {
      el._state.face = 'mutee-directement'
      assert.equal(el._state.face, 'mutee-directement')
      assert.equal(typeof el.face, 'function', 'la méthode reste intacte après mutation de _state')
    })
  })

  describe('B — attribut posé par un parent (point 5)', () => {
    it('face="depuis-parent" en attribut → état = la chaîne, méthode intacte', async () => {
      const { el } = await compileAndMount(
        'coexattr', COMPONENT, 'mjs-coexattr',
        '<mjs-coexattr face="depuis-parent"></mjs-coexattr>'
      )
      assert.equal(el._state.face, 'depuis-parent', 'syncProps() (attribut → état) inchangé')
      assert.equal(typeof el.face, 'function', 'l\'attribut ne touche jamais this.face (méthode)')
    })
  })

  describe('C — anti-régression du salvage (points 6 et 7, même instance, dans l\'ordre)', () => {
    let el: any
    let win: any

    before(async () => {
      ({ win, el } = await compileAndMount('coexsalvage', COMPONENT, 'mjs-coexsalvage'))
    })

    // reconnecte l'élément (remove + réinsertion) pour forcer un NOUVEAU connectedCallback —
    // même mécanisme que le salvage pré-upgrade (hasOwnProperty vu au moment de la connexion),
    // sans dépendre du support (absent en happy-dom v20, vérifié) de l'upgrade natif tardif.
    async function reconnecter() {
      el.remove()
      win.document.body.appendChild(el)
      await new Promise((r) => setTimeout(r, 60))
    }

    it('point 6 — prop NON homonyme posée sur l\'instance → toujours versée dans l\'état puis retirée', async () => {
      el.libre = 'depose-par-parent'
      await reconnecter()
      assert.equal(el._state.libre, 'depose-par-parent', 'salvage normal toujours actif')
      assert.equal(Object.prototype.hasOwnProperty.call(el, 'libre'), false, 'own-property retirée après salvage')
    })

    it('point 7 — prop HOMONYME mais de valeur NON fonction → toujours sauvée (seule une fonction est épargnée)', async () => {
      el.face = 'chaine-brute-non-fonction'
      await reconnecter()
      assert.equal(el._state.face, 'chaine-brute-non-fonction', 'valeur non-fonction : salvage normal, pas d\'exception au fix')
      assert.equal(typeof el.face, 'undefined', 'la valeur non-fonction a bien été retirée de l\'instance (comme n\'importe quelle prop)')
      assert.equal(Object.prototype.hasOwnProperty.call(el, 'face'), false)
    })
  })
})
