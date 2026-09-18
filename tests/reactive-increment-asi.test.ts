// Régression MAJEURE — `$x++` posé AILLEURS
// qu'en dernière ligne d'un bloc plantait à l'exécution :
//   TypeError: µ._set(...) is not a function
//
// `transformReactiveWrites` réécrivait TOUTE incrémentation d'état en une forme
// fidèle qui commence par une parenthèse (`((_v => …)($.x))`). Civet n'émet pas
// de point-virgule en fin d'instruction : la parenthèse ouvrante de la ligne
// suivante était donc lue comme un APPEL du résultat de la ligne précédente —
//   µ._set(_mjsThis, 'edite', null)((_v => …)($.compteur))
// L'insertion automatique de point-virgule (ASI) ne s'applique pas dans ce cas.
// Le JS émis restait syntaxiquement VALIDE : build, `[bundler/esm-check]`,
// tests et SSR passaient tous — la panne n'arrivait qu'au clic de l'utilisateur.
// Et seulement « une fois sur deux » : en DERNIÈRE ligne d'un bloc, Civet
// préfixe l'expression d'un `return` qui coupe la continuation.
//
// Correctif : en position STATEMENT (valeur de retour ignorée par définition),
// on émet la forme directe `µ._set(_mjsThis, 'x', $.x + 1)` — qui commence par
// `µ` et n'alimente plus l'ASI. La forme fidèle n'est gardée que là où la
// valeur est réellement consommée (return, argument, condition…), positions où
// le nœud n'ouvre jamais une instruction.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import * as acorn from 'acorn'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { transformReactiveWrites } from '../src/generator/transform-reactive.js'

// Le JS entrant est celui que Civet produit : SANS point-virgule.
const METHODE = (corps: string) => `_mjsThis.ouvrir = function() {\n${corps}\n}`

describe('$x++ — pas d\'instruction ouverte par une parenthèse (ASI)', () => {

  it('en STATEMENT après une autre ligne : forme directe, aucune parenthèse ouvrante', () => {
    const out = transformReactiveWrites(METHODE(
      `  µ._set(_mjsThis, 'edite', null)\n  $.compteur++\n  µ._set(_mjsThis, 'ouvert', true)`,
    ))
    const lignes = out.split('\n').map(l => l.trim()).filter(Boolean)
    assert.ok(lignes.every(l => !l.startsWith('(')), 'aucune ligne n\'ouvre sur `(` :\n' + out)
    assert.match(out, /µ\._set\(_mjsThis, 'compteur', \$\.compteur \+ 1\)/)
  })

  it('`--` et la forme préfixe suivent la même règle', () => {
    const dec = transformReactiveWrites(METHODE(`  µ._set(_mjsThis, 'a', 1)\n  $.compteur--`))
    const pre = transformReactiveWrites(METHODE(`  µ._set(_mjsThis, 'a', 1)\n  ++$.compteur`))
    assert.match(dec, /µ\._set\(_mjsThis, 'compteur', \$\.compteur - 1\)/)
    assert.match(pre, /µ\._set\(_mjsThis, 'compteur', \$\.compteur \+ 1\)/)
    for (const out of [dec, pre]) {
      assert.ok(out.split('\n').every(l => !l.trim().startsWith('(')), out)
    }
  })

  it('valeur CONSOMMÉE — la forme fidèle est conservée (post-fixe rend l\'ancienne valeur)', () => {
    // `return $.x++` (dernière ligne d'une méthode), argument d'appel, condition :
    // le nœud n'ouvre jamais une instruction, la sémantique prime.
    assert.match(transformReactiveWrites(METHODE(`  return $.compteur++`)),
      /return \(\(_v => \(µ\._set\(_mjsThis, 'compteur', _v \+ 1\), _v\)\)\(\$\.compteur\)\)/)
    assert.match(transformReactiveWrites(`notify($.compteur++)`),
      /notify\(\(\(_v => /)
    assert.match(transformReactiveWrites(`const y = ++$.compteur`),
      /const y = \(µ\._set\(_mjsThis, 'compteur', \$\.compteur \+ 1\), \$\.compteur\)/)
  })

  it('le JS émis s\'EXÉCUTE — c\'est ce que ni le build ni acorn ne voyaient', () => {
    const out = transformReactiveWrites(METHODE(
      `  µ._set(_mjsThis, 'edite', null)\n  $.compteur++\n  $.n--\n  µ._set(_mjsThis, 'ouvert', true)`,
    ))
    // Syntaxiquement valide : c'était DÉJÀ le cas avant le correctif — d'où
    // le silence du garde-fou `[bundler/esm-check]`.
    acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' })

    // Ce qui suit, en revanche, jetait « µ._set(...) is not a function ».
    const etat: any = { compteur: 0, n: 5, edite: 'x', ouvert: false }
    const mu = { _set: (_t: any, k: string, v: any) => { etat[k] = v; return true } }
    const cible: any = {}
    new Function('µ', '_mjsThis', '$', out)(mu, cible, etat)
    cible.ouvrir()
    assert.deepEqual(etat, { compteur: 1, n: 4, edite: null, ouvert: true })
  })
})

// ── Bout en bout : un vrai composant, un vrai clic ─────────────────────────
const COMPONENT = `
<script>
$compteur = 0
$ouvert = false
@ouvrir = ->
  $edite = null
  $compteur++
  $ouvert = true
</script>
<button class="go" @click={@ouvrir()}>ouvrir</button>
<b class="out">{$compteur}</b>
<b class="etat">{$ouvert}</b>
`

describe('$x++ — bout en bout, au clic (happy-dom)', function () {
  this.timeout(40000)

  let win: any = null
  let el: any  = null

  before(async function () {
    const root   = mjsTmp('inc')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'inctest.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    win = new Window({ url: 'http://localhost/' })
    const files    = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^inctest-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n`
           + `${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)

    win.document.body.innerHTML = '<mjs-inctest></mjs-inctest>'
    el = win.document.body.firstElementChild
    await new Promise(r => setTimeout(r, 40))
    assert.ok(el._shadow, 'shadow root monté')
  })

  after(async () => {
    win?.close?.()
    await terminateSharedWorkerPool()
  })

  it('un clic incrémente vraiment, et les lignes SUIVANTES s\'exécutent', async () => {
    const erreurs: string[] = []
    win.addEventListener('error', (e: any) => erreurs.push(String(e.message ?? e)))

    el._shadow.querySelector('.go').click()
    await new Promise(r => setTimeout(r, 40))

    assert.deepEqual(erreurs, [], 'aucune erreur JS au clic')
    assert.equal(el._shadow.querySelector('.out').textContent, '1', '$compteur incrémenté')
    assert.equal(el._shadow.querySelector('.etat').textContent, 'true', 'la ligne APRÈS le ++ a tourné')

    el._shadow.querySelector('.go').click()
    await new Promise(r => setTimeout(r, 40))
    assert.equal(el._shadow.querySelector('.out').textContent, '2')
  })
})
