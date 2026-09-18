// Test de non-régression — le correctif auto du `this` perdu (this-rebinding.ts)
// doit couvrir AUSSI les handlers d'événements inline (`@click={…}`), pas
// seulement le `<script>` du composant. Écart trouvé par vérification :
// `rebindDetachedThis` était câblée sur `jsInitBase` (le
// <script>) mais JAMAIS sur `inlinesJs` (les handlers, assemblés séparément
// dans transpiler/index.ts) — même bug, même classe de symptôme, chemin non
// couvert.
//
// Même méthode « vrai Bundler + happy-dom » que thin-arrow-this-autofix.test.ts
// (compilation réelle, montage, clics réels — la seule preuve qui vaille pour
// un bug de `this` au runtime ; une assertion sur la FORME du JS généré ne
// suffit pas).
//
// Nuance de forme propre aux handlers inline : la flèche fine Coffee/Civet
// (`->`) écrite DANS un `@click={…}` n'atteint jamais ce chemin — `cleanJs`
// (generator/utils.ts) la normalise en `=>` avant compilation, et une flèche
// épaisse capture déjà le bon `this`. Le motif à risque y prend donc la forme
// d'une FunctionExpression EXPLICITE (`function(){…}`), exactement celle du
// premier test unitaire de this-rebinding.test.ts, dans ses deux écritures
// naturelles : assignée à un nom nu puis appelée détachée, et callback anonyme
// passé en argument (`forEach(function(n){…})`).
//
// Un seul composant, §§theme partagé, 4 boutons :
//   .fn-bare   → function(){} assignée à un nom NU puis appelée détachée (§§)
//   .fn-at     → idem, lisant `@champ` (this.x issu du raccourci @)
//   .cb-anon   → callback anonyme function(){} passé à forEach (this détaché)
//   .method    → vraie méthode d'instance appelée `@saveMethod()` — témoin,
//                this dynamique correct, doit rester intact
//
// AJOUT — le versant SUR-RÉÉCRITURE, non couvert jusqu'ici :
// la forme émise est `(this ?? _mjsThis)`, PAS `_mjsThis` en dur (durcissement
// hérité de la vérification précédente sur jsInitBase). Trois témoins de plus vérifient
// à L'EXÉCUTION, sur le chemin INLINE, qu'un `this` posé EXPLICITEMENT par
// l'appelant survit (sinon la régression serait silencieusement réintroduite
// sur les handlers) :
//   .call-x     → `h.call({nom})`            → doit lire l'objet de l'appelant
//   .bind-x     → `g.bind({nom})()`          → idem
//   .thisarg    → `[7].map(f, {nom})`        → idem (thisArg d'une méthode native)
//                 ⚠ le `this` explicite ne sert QU'À LIRE l'objet de l'appelant :
//                 un `§§`/`@` À L'INTÉRIEUR d'une fonction dont l'appelant a posé
//                 un `this` résout contre CET objet (donc casse) — contrepartie
//                 assumée du choix `(this ?? _mjsThis)`, pas un défaut de ce correctif.
//   .obj-meth   → `{ dis: function(){ return this.nom } }` → méthode d'objet
//                 littéral : `this` JAMAIS réécrit (garde Property)

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { transpile } from '../src/transpiler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script>
§§theme = valeur: 'init'
@champ = 'via-fn-at'

# vraie méthode d'instance — témoin, jamais concernée par le bug
@saveMethod = -> §§theme.valeur = 'via-method'
</script>

<p id="val">{§§theme.valeur}</p>
<button class="fn-bare" @click={save = function() { §§theme.valeur = 'via-fn-bare' }; save()}>bare</button>
<button class="fn-at" @click={setAt = function() { §§theme.valeur = @champ }; setAt()}>at</button>
<button class="cb-anon" @click={[1].forEach(function(n) { §§theme.valeur = 'via-cb-anon' })}>cb</button>
<button class="method" @click={@saveMethod()}>method</button>
<button class="call-x" @click={h = function() { return this.nom }; §§theme.valeur = h.call({ nom: 'appelant' })}>call</button>
<button class="bind-x" @click={g = function() { return this.nom }; §§theme.valeur = g.bind({ nom: 'lie' })()}>bind</button>
<button class="thisarg" @click={f = function(n) { return this.nom + ':' + n }; §§theme.valeur = [7].map(f, { nom: 'thisArg' })[0]}>thisarg</button>
<button class="obj-meth" @click={o = { nom: 'objet-litteral', dis: function() { return this.nom } }; §§theme.valeur = o.dis()}>obj</button>
`

async function compileComponent(): Promise<string> {
  const root = mjsTmp('inlinethis')
  const srcDir = join(root, 'src'), outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'inlinethisfix.mjs'), COMPONENT)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const compFile = readdirSync(outDir).find((f: string) => f.startsWith('inlinethisfix-'))!
  const coreFile = readdirSync(outDir).find((f: string) => /^mjs_core-/.test(f))!
  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  return `${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))}`
}

describe('correctif auto this→_mjsThis DANS les handlers inline @click={…}', function () {
  this.timeout(40000)

  describe('preuve par exécution réelle (compile + montage + clics happy-dom)', function () {
    let window: any = null
    let el: any = null
    const errors: any[] = []

    function val(): string {
      return el._shadow.querySelector('#val').textContent
    }
    // Le dispatch d'event happy-dom relaie l'exception du listener SANS la
    // relancer ici (elle part en 'error' sur la fenêtre) — on la capture aussi
    // localement pour pouvoir l'attribuer au clic exact qui l'a levée.
    function click(selector: string): any {
      const btn = el._shadow.querySelector(selector)
      try {
        btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 }))
      } catch (err) {
        return err
      }
      return null
    }

    before(async function () {
      const code = await compileComponent()
      window = new Window({ url: 'http://localhost/' })
      window.addEventListener('error', (e: any) => errors.push(e.error ?? e.message))
      const document: any = window.document
      window.eval(code)
      assert.ok(window.customElements.get('mjs-inlinethisfix'), 'composant enregistré')
      document.body.innerHTML = '<mjs-inlinethisfix id="c"></mjs-inlinethisfix>'
      el = document.getElementById('c')
      await new Promise((r) => setTimeout(r, 50))
      assert.ok(el._shadow, 'composant monté')
    })

    after(async () => {
      window?.close?.()
      await terminateSharedWorkerPool()
    })

    it('valeur initiale affichée', () => {
      assert.equal(val(), 'init')
    })

    it('(a) function(){} assignée à un nom NU puis appelée détachée dans @click : ne plante plus, valeur correcte', async () => {
      const err = click('.fn-bare')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(err, null, `aucune exception attendue au clic : ${err}`)
      assert.equal(val(), 'via-fn-bare')
    })

    it('(b) idem lisant `@champ` (this.x du raccourci @) : ne plante plus, valeur correcte', async () => {
      const err = click('.fn-at')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(err, null, `aucune exception attendue au clic : ${err}`)
      assert.equal(val(), 'via-fn-at')
    })

    it('(c) callback anonyme function(){} passé en argument (forEach) : ne plante plus, valeur correcte', async () => {
      const err = click('.cb-anon')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(err, null, `aucune exception attendue au clic : ${err}`)
      assert.equal(val(), 'via-cb-anon')
    })

    it('(d) vraie méthode d\'instance appelée depuis @click : this dynamique intact, rien de cassé', async () => {
      const err = click('.method')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(err, null, `aucune exception attendue au clic : ${err}`)
      assert.equal(val(), 'via-method')
    })

    // --- versant SUR-RÉÉCRITURE ---
    it('(e) `h.call({nom})` dans un handler inline : le this EXPLICITE de l\'appelant survit (jamais écrasé par _mjsThis)', async () => {
      const err = click('.call-x')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(err, null, `aucune exception attendue au clic : ${err}`)
      assert.equal(val(), 'appelant', "`(this ?? _mjsThis)` doit respecter un this posé par .call — `_mjsThis` en dur donnerait `undefined` (le composant n'a pas de .nom)")
    })

    it('(f) `g.bind({nom})()` dans un handler inline : idem, le this lié survit', async () => {
      const err = click('.bind-x')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(err, null, `aucune exception attendue au clic : ${err}`)
      assert.equal(val(), 'lie')
    })

    it('(g) `[7].map(f, {nom})` (thisArg natif) dans un handler inline : idem', async () => {
      const err = click('.thisarg')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(err, null, `aucune exception attendue au clic : ${err}`)
      assert.equal(val(), 'thisArg:7')
    })

    it('(h) méthode d\'objet littéral DANS un handler inline : this JAMAIS réécrit (garde Property)', async () => {
      const err = click('.obj-meth')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(err, null, `aucune exception attendue au clic : ${err}`)
      assert.equal(val(), 'objet-litteral')
    })

    it('aucune erreur JS ne fut levée sur TOUTE la séquence de clics', () => {
      assert.equal(errors.length, 0, `aucune exception attendue : ${errors.map(String).join(' | ')}`)
    })
  })

  describe('preuve par la FORME du JS généré (complément — la charge de la preuve reste l\'exécution ci-dessus)', function () {
    this.timeout(30000)
    let inlines = ''

    before(async () => {
      const res = await transpile(COMPONENT, { moduleName: 'inlinethisshape' })
      inlines = res.output.match(/this\._mjs_inline\s*=\s*\[[\s\S]*?\n\s*\];?/)?.[0] ?? ''
      assert.notEqual(inlines, '', 'tableau _mjs_inline introuvable dans le JS généré')
    })

    it('function(){} à nom nu dans un handler inline : this réécrit en (this ?? _mjsThis)', () => {
      assert.match(inlines, /let save = function\(\) \{ return \(this \?\? _mjsThis\)\._mjs_getRCtx/)
      assert.match(inlines, /let setAt = function\(\) \{ return \(this \?\? _mjsThis\)\._mjs_getRCtx\('theme'\)\.valeur = \(this \?\? _mjsThis\)\.champ \}/)
    })

    it('callback anonyme function(){} dans un handler inline : this réécrit aussi', () => {
      assert.match(inlines, /forEach\(function\(n\) \{ return \(this \?\? _mjsThis\)\._mjs_getRCtx/)
    })

    it('le wrapper `(e, el) =>` du handler et son appel de méthode : this INCHANGÉ (flèche épaisse, capture déjà correcte)', () => {
      assert.match(inlines, /\(e, el\) => \{\s*return this\.saveMethod\(\)/)
    })
  })
})
