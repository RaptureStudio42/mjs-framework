// Test de non-régression — symbole `@@` (référence sûre au composant dans une lambda)
// ET son automatisation (this-rebinding.ts).
//
// Piège débusqué par une application Rails hôte : un helper top-level
// `->` qui lit/écrit une propriété du composant via `@x` (→ `this.x`) plantait s'il était appelé
// NU (sans receveur) depuis un autre handler. `->` compile en `function` classique, dont le
// `this` dépend du SITE D'APPEL, pas du site de définition — un appel nu (`incrementer()`,
// sans `objet.` devant) laissait `this` à `undefined` (module strict) → `this.x` explosait.
//
// `@@x` compile en `_mjsThis.x` (lexer/index.ts §3.4 + generator/utils.ts applySymbolRegex,
// 2 passes) : `_mjsThis` est un `const` capturé UNE FOIS par composant (transpiler/template.ts,
// méthode `init()`), donc accessible par FERMETURE depuis n'importe quel helper défini dans
// le `<script>` — insensible au site d'appel, contrairement à `this`. `@@` reste ce mécanisme
// EXPLICITE, documenté, toujours valide — rien n'y change.
//
// DEPUIS src/generator/this-rebinding.ts : le compilateur détecte lui-même, en AST
// post-Civet, qu'une flèche fine top-level NUE (pas une vraie méthode `@nom = -> ...`, pas une
// `=>`) touche un `this.` à risque — et réécrit AUTOMATIQUEMENT en `_mjsThis.`, sans que le dev
// ait besoin de taper `@@`. Le helper « casse » ci-dessous (`@` simple) NE PLANTE donc PLUS : il
// est corrigé exactement comme s'il avait été écrit en `@@` dès le départ. Le test qui
// s'appelait « contre-témoin : … plante » atteste désormais l'INVERSE — plus aucun crash, sur
// AUCUN des deux helpers (cf. thin-arrow-this-autofix.test.ts pour la couverture complète du
// nouveau mécanisme : alias, imbrication, méthode réelle, flèche épaisse).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

// deux helpers jumeaux : un « sûr par @@ » (mécanisme explicite), un « autrefois piégé,
// désormais auto-corrigé » (@ simple) — tous deux appelés NUS (sans receveur) depuis le
// handler @click, exactement le cas débusqué par l'application Rails hôte. Les DEUX doivent maintenant
// fonctionner sans crash (this-rebinding.ts traite le second cas automatiquement).
const COMPONENT = `
<script>
@compteurSur = 0
@compteurCasse = 0

# @x (this.x) dans un helper -> appelé nu — AVANT ce correctif : this dynamique perdu au site
# d'appel, crash. DEPUIS ce correctif : this-rebinding.ts détecte le helper -> top-level nu et
# réécrit this. en _mjsThis. tout seul (cf. test compile-time plus bas) — même sûreté que @@.
incrementerCasse = ->
  @compteurCasse = @compteurCasse + 1

# sûr par construction : @@x (_mjsThis.x, capturé par fermeture) → insensible au site d'appel
incrementerSur = ->
  @@compteurSur = @@compteurSur + 1
</script>

<button class="sur" @click={incrementerSur()}>sûr</button>
<button class="casse" @click={incrementerCasse()}>casse</button>
`

async function compileComponent(): Promise<string> {
  const root = mjsTmp('atat')
  const srcDir = join(root, 'src'), outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'atat.mjs'), COMPONENT)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const compFile = readdirSync(outDir).find((f: string) => f.startsWith('atat-'))!
  return readFileSync(join(outDir, compFile), 'utf-8')
}

describe('symbole @@ — référence sûre au composant dans une lambda', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('compile-time — @@x → _mjsThis.x (mécanisme explicite) ; @x simple DANS un helper -> top-level nu → AUSSI _mjsThis.x (auto-fix this-rebinding.ts)', async function () {
    const out = await compileComponent()
    assert.match(out, /_mjsThis\.compteurSur\s*=/, '@@compteurSur (mécanisme explicite, inchangé) doit compiler en _mjsThis.compteurSur')
    assert.match(out, /\(this \?\? _mjsThis\)\.compteurCasse\s*=/, '@compteurCasse (raccourci @ simple, dans un helper -> top-level nu) doit AUSSI compiler en (this ?? _mjsThis).compteurCasse depuis ce correctif — plus besoin de @@ pour ce cas, et un this explicite (call/bind) reste respecté')
  })

  it('runtime — clic sur le bouton "sûr" : incrémente sans crash (helper -> appelé nu, via @@)', async function () {
    const root = mjsTmp('atat-e2e')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'atat.mjs'), COMPONENT)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^atat-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const errors: any[] = []
    win.addEventListener('error', (e: any) => errors.push(e.error ?? e.message))
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)

    document.body.innerHTML = '<mjs-atat></mjs-atat>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))
    assert.equal(errors.length, 0, `pas d'erreur au montage : ${errors.map(String).join(' | ')}`)
    assert.equal(el.compteurSur, 0, 'valeur initiale')

    // clic sur le bouton SÛR (@@) → incrementerSur() appelé nu → _mjsThis capturé par
    // fermeture → pas de crash, la bonne valeur.
    el._shadow.querySelector('.sur').dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 30))
    assert.equal(errors.length, 0, `@@ ne doit JAMAIS planter (appel nu) : ${errors.map(String).join(' | ')}`)
    assert.equal(el.compteurSur, 1, '@@compteurSur incrémenté malgré l\'appel nu du helper')

    // un 2e clic pour écarter un faux positif (effet de bord d'initialisation).
    el._shadow.querySelector('.sur').dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 30))
    assert.equal(el.compteurSur, 2, '@@compteurSur re-incrémenté au 2e clic')

    win.close?.()
  })

  it('runtime — ex-contre-témoin : clic sur "casse" (helper -> avec @ simple, appelé nu) NE PLANTE PLUS (auto-fix this-rebinding.ts)', async function () {
    const root = mjsTmp('atat-ct')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'atat.mjs'), COMPONENT)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^atat-/.test(f))

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const errors: any[] = []
    win.addEventListener('error', (e: any) => errors.push(e.error ?? e.message))
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)

    document.body.innerHTML = '<mjs-atat></mjs-atat>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))
    assert.equal(errors.length, 0, 'pas d\'erreur au montage')

    // clic sur le bouton CASSE (@ simple) → incrementerCasse() appelé nu → AVANT ce correctif,
    // this === undefined (function classique compilée depuis `->`, this dépend du site
    // d'appel) → this.compteurCasse explosait. DEPUIS this-rebinding.ts, le compilateur a
    // déjà réécrit ce this. en _mjsThis. dans le JS compilé (cf. test compile-time ci-dessus)
    // — _mjsThis est capturé par fermeture, insensible au site d'appel : plus aucun crash,
    // exactement comme le helper « sûr » (@@) déjà vérifié plus haut.
    el._shadow.querySelector('.casse').dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 30))

    assert.equal(errors.length, 0, `le helper @ simple, appelé nu, ne doit PLUS planter (auto-fix this-rebinding.ts) : ${errors.map(String).join(' | ')}`)
    assert.equal(el.compteurCasse, 1, 'la mutation a bien abouti — compteurCasse incrémenté malgré l\'appel nu, comme compteurSur')

    win.close?.()
  })
})
