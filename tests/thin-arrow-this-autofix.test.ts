// Test de non-régression — correctif AUTOMATIQUE du `this` perdu dans une
// flèche fine (`->`) top-level NUE (this-rebinding.ts). Remplace la garde
// detect-et-erreur envisagée puis abandonnée : le compilateur répare
// silencieusement au lieu de faire échouer la compilation (cf.
// docs/18-pieges.md §9/§11, retirées — le piège n'existe plus).
//
// Même méthode « vrai Bundler + happy-dom » que double-at-component-ref.test.ts
// et rctx-cache.test.ts (compilation réelle, montage, clics réels — la seule
// preuve qui vaille pour un bug de `this` au runtime, une assertion sur la
// FORME du JS généré ne suffit pas).
//
// Un seul composant, §§theme partagé, 6 boutons couvrant chaque scénario
// d'auto-correction du `this` :
//   .via-call    → save appelé DANS une expression de gabarit ({save()})
//   .via-alias   → save appelé via un ALIAS (f = save; {f()})
//   .via-nested  → save appelé depuis une flèche fine IMBRIQUÉE dans une autre
//   .via-bare    → référence NUE (@click=save, sans parenthèses) — déjà sûr
//                  AVANT ce correctif (le moteur d'event rappelle avec le composant
//                  comme receveur, mjs_element.ts) — DOIT rester sûr après
//   .via-method  → vraie méthode d'instance (@nom = -> ...) — this dynamique
//                  intact, AUCUNE réécriture ne doit s'y produire
//   .via-thick   → flèche épaisse (=>) — intouchée, capture déjà correcte

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

# appelé DANS une expression de gabarit ({saveViaCall()}) — CASSAIT avant ce correctif
saveViaCall = -> §§theme.valeur = 'via-call'

# appelé via un ALIAS — CASSAIT avant ce correctif
saveOriginal = -> §§theme.valeur = 'via-alias'
aliasSave = saveOriginal

# appelé depuis une flèche fine IMBRIQUÉE — CASSAIT avant ce correctif
outerNested = ->
  innerNested = -> §§theme.valeur = 'via-nested'
  innerNested()

# référence NUE dans le gabarit (sans parenthèses) — déjà sûr avant ce correctif
saveBareRef = -> §§theme.valeur = 'via-bare'

# vraie méthode d'instance — this dynamique, jamais concerné par le bug
@saveMethod = -> §§theme.valeur = 'via-method'

# flèche épaisse — capture correcte à la définition, jamais concernée
saveThick = => §§theme.valeur = 'via-thick'
</script>

<p id="val">{§§theme.valeur}</p>
<button class="via-call" @click={saveViaCall()}>call</button>
<button class="via-alias" @click={aliasSave()}>alias</button>
<button class="via-nested" @click={outerNested()}>nested</button>
<button class="via-bare" @click=saveBareRef>bare</button>
<button class="via-method" @click={@saveMethod()}>method</button>
<button class="via-thick" @click={saveThick()}>thick</button>
`

async function compileComponent(tag: string): Promise<string> {
  const root = mjsTmp(`thinarrow-${tag}`)
  const srcDir = join(root, 'src'), outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'thinarrowfix.mjs'), COMPONENT)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const compFile = readdirSync(outDir).find((f: string) => f.startsWith('thinarrowfix-'))!
  const coreFile = readdirSync(outDir).find((f: string) => /^mjs_core-/.test(f))!
  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  return `${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))}`
}

describe('correctif auto this→_mjsThis dans une flèche fine top-level nue (this-rebinding.ts)', function () {
  this.timeout(40000)

  describe('preuve par exécution réelle (compile + montage + clics happy-dom)', function () {
    let window: any = null
    let el: any = null
    const errors: any[] = []

    function val(): string {
      return el._shadow.querySelector('#val').textContent
    }
    function click(selector: string) {
      const btn = el._shadow.querySelector(selector)
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 }))
    }

    before(async function () {
      const code = await compileComponent('e2e')
      window = new Window({ url: 'http://localhost/' })
      window.addEventListener('error', (e: any) => errors.push(e.error ?? e.message))
      const document: any = window.document
      window.eval(code)
      assert.ok(window.customElements.get('mjs-thinarrowfix'), 'composant enregistré')
      document.body.innerHTML = '<mjs-thinarrowfix id="c"></mjs-thinarrowfix>'
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

    it('(a) appelé DANS une expression de gabarit ({save()}) : ne plante plus, valeur correcte', async () => {
      click('.via-call')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(val(), 'via-call')
    })

    it('(b) appelé via un ALIAS (f = save; {f()}) : ne plante plus, valeur correcte', async () => {
      click('.via-alias')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(val(), 'via-alias')
    })

    it('(c) appelé depuis une flèche fine IMBRIQUÉE dans une autre : ne plante plus, valeur correcte', async () => {
      click('.via-nested')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(val(), 'via-nested')
    })

    it('(d) référence NUE (@click=save, sans parenthèses) : reste sûre, valeur correcte', async () => {
      click('.via-bare')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(val(), 'via-bare')
    })

    it('(e) vraie méthode d\'instance (@nom = -> ...) : this dynamique intact, rien de cassé', async () => {
      click('.via-method')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(val(), 'via-method')
    })

    it('(f) flèche épaisse (=>) : intouchée, fonctionne comme avant', async () => {
      click('.via-thick')
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(val(), 'via-thick')
    })

    it('aucune erreur JS ne fut levée sur TOUTE la séquence de clics', () => {
      assert.equal(errors.length, 0, `aucune exception attendue : ${errors.map(String).join(' | ')}`)
    })
  })

  describe('preuve par la FORME du JS généré (complément — la charge de la preuve reste l\'exécution ci-dessus)', function () {
    this.timeout(30000)
    let output = ''

    before(async () => {
      const res = await transpile(COMPONENT, { moduleName: 'thinarrowshape' })
      output = res.output
    })

    it('flèche fine assignée à un nom nu : this réécrit en (this ?? _mjsThis)', () => {
      assert.match(output, /let saveViaCall = function\(\) \{ return \(this \?\? _mjsThis\)\._mjs_getRCtx/)
      assert.match(output, /let saveOriginal = function\(\) \{ return \(this \?\? _mjsThis\)\._mjs_getRCtx/)
      assert.match(output, /let saveBareRef = function\(\) \{ return \(this \?\? _mjsThis\)\._mjs_getRCtx/)
    })

    it('flèche fine imbriquée : this réécrit aussi dans le corps imbriqué', () => {
      assert.match(output, /let innerNested = function\(\) \{ return \(this \?\? _mjsThis\)\._mjs_getRCtx/)
    })

    it('vraie méthode d\'instance (this.saveMethod = function(){...}) : this INCHANGÉ, jamais _mjsThis', () => {
      assert.match(output, /this\.saveMethod = function\(\) \{ return this\._mjs_getRCtx\('theme'\)\.valeur = 'via-method' \}/)
    })

    it('flèche épaisse (saveThick) : this INCHANGÉ, jamais _mjsThis', () => {
      assert.match(output, /let saveThick = \(\) => this\._mjs_getRCtx\('theme'\)\.valeur = 'via-thick'/)
    })
  })
})

// Régression trouvée en testant : un `this` réécrit
// SANS condition en `_mjsThis` écrasait un rebinding EXPLICITE de l'appelant
// (`.call`/`.bind`/`thisArg`) — silencieux, aucune erreur, juste une valeur
// fausse. Durci en `(this ?? _mjsThis)` : seul un appel VRAIMENT nu (module ES
// strict → `this===undefined`) retombe sur `_mjsThis` ; un `this` explicitement
// posé par l'appelant (jamais `undefined`) est respecté tel quel.
const COMPONENT_CALL_BIND = `
<script>
externe = nom: 'AUTRE'

# flèche fine top-level nue touchant @nom (this.nom) — réécrite par this-rebinding.ts,
# mais SEULEMENT en repli : un this explicite posé par call/bind doit survivre.
helper = -> @nom

@runCall = ->
  $resultCall = helper.call(externe)

@runBind = ->
  $resultBind = helper.bind(externe)()

$resultCall = ''
$resultBind = ''
</script>

<p id="outCall">{$resultCall}</p>
<p id="outBind">{$resultBind}</p>
<button class="run-call" @click={@runCall()}>call</button>
<button class="run-bind" @click={@runBind()}>bind</button>
`

describe('durcissement (this ?? _mjsThis) — respecte un rebinding EXPLICITE (.call/.bind)', function () {
  this.timeout(40000)
  let window: any = null
  let el: any = null
  const errors: any[] = []

  function out(id: string): string {
    return el._shadow.querySelector(id).textContent
  }
  function click(selector: string) {
    const btn = el._shadow.querySelector(selector)
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 }))
  }

  before(async function () {
    const root = mjsTmp('thinarrow-callbind')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'callbindfix.mjs'), COMPONENT_CALL_BIND)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const compFile = readdirSync(outDir).find((f: string) => f.startsWith('callbindfix-'))!
    const coreFile = readdirSync(outDir).find((f: string) => /^mjs_core-/.test(f))!
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const code = `${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))}`
    window = new Window({ url: 'http://localhost/' })
    window.addEventListener('error', (e: any) => errors.push(e.error ?? e.message))
    const document: any = window.document
    window.eval(code)
    assert.ok(window.customElements.get('mjs-callbindfix'), 'composant enregistré')
    document.body.innerHTML = '<mjs-callbindfix id="c"></mjs-callbindfix>'
    el = document.getElementById('c')
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(el._shadow, 'composant monté')
  })

  after(async () => {
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  it('helper.call(externe) : lit externe.nom, PAS le composant — "AUTRE", pas vide', async () => {
    click('.run-call')
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(out('#outCall'), 'AUTRE')
  })

  it('helper.bind(externe)() : lit externe.nom, PAS le composant — "AUTRE", pas vide', async () => {
    click('.run-bind')
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(out('#outBind'), 'AUTRE')
  })

  it('aucune erreur JS levée', () => {
    assert.equal(errors.length, 0, `aucune exception attendue : ${errors.map(String).join(' | ')}`)
  })
})
