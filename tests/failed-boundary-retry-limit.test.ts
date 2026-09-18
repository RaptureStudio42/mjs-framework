// `<@failed reset>` pouvait boucler à l'infini.
// Cause : `reset()` (µ._mjs_resetComponent, mjs_failed.ts, appelé depuis
// `_mjs_catchError`, mjs_element.ts) remonte une instance FRAÎCHE du même
// composant. Aucun compteur, aucun délai, aucune limite : sur une erreur
// déterministe, construction → erreur → reset → construction tournait sans fin.
//
// Fix : un seul réessai par défaut, `<@failed retry="N">` change la limite.
// Le compte de tentatives DÉJÀ consommées vit sur un ATTRIBUT DOM
// (`mjs-retry-used`) — PAS sur l'instance (`this`/`_state`) : `_mjs_resetComponent`
// remplace le nœud crashé par une instance FRAÎCHE (nouveau constructeur, tout
// l'état ré-initialisé) — un compteur posé sur l'instance serait remis à zéro à
// CHAQUE tentative et ne compterait plus rien. Les ATTRIBUTS, eux, sont
// EXPLICITEMENT recopiés de l'ancien nœud vers le neuf par `_mjs_resetComponent`
// (boucle `fresh.setAttribute(...)`) — seul support qui traverse le remplacement.
//
// Chaque test compte les MONTAGES RÉELS (compteur `window.__mount`, incrémenté
// dans le <script> à CHAQUE construction) — pas seulement l'attribut posé.

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

// Composant qui crashe à CHAQUE montage (déterministe) — `boom()` est appelé
// dans l'interpolation `<p class="ok">`, jamais évaluée si `failOnMount` est
// faux, ce qui permet aussi le scénario TRANSITOIRE (test dédié plus bas).
function flakySource(retryAttr: string, deterministic: boolean): string {
  const retry = retryAttr ? ` retry="${retryAttr}"` : ''
  const cond = deterministic ? 'true' : 'window.__mount == 1'
  return [
    '<script>',
    'window.__mount = (window.__mount or 0) + 1',
    `boom = -> if ${cond} then throw new Error('boom ' + window.__mount) else 'ok'`,
    '</script>',
    `<@failed err reset${retry}>`,
    '  <p class="boom">Oups {err.message}</p>',
    '  <button class="btn" @click=reset>Reset</button>',
    '</@failed>',
    '<p class="ok">{boom()}</p>',
  ].join('\n')
}

async function mount(name: string, source: string) {
  const root   = mjsTmp(`failretry-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  assert.ok(coreFile && compFile, 'core et composant doivent être compilés')
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;`)
  // Capture des messages `µ.error` — la console de happy-dom est ISOLÉE du
  // process Node (vérifié empiriquement) : sans ce
  // relais, aucun `console.error` évalué via `window.eval` n'est observable.
  window.eval(`window.__errors = []; µ.error = function() { window.__errors.push(Array.prototype.slice.call(arguments).join(' ')); };`)
  window.eval(stripEsm(readFileSync(join(outDir, compFile!), 'utf-8')))
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  await new Promise(r => setTimeout(r, 80))
  return { window, document }
}

// Clique le bouton reset du fallback actuellement affiché, attend le
// re-montage. Retourne l'élément (potentiellement REMPLACÉ, cf. _mjs_resetComponent).
async function clickReset(window: any, document: any, tag: string) {
  const el: any = document.querySelector(tag)
  const btn = el._shadow.querySelector('button.btn')
  assert.ok(btn, 'le bouton reset doit être présent dans le fallback')
  btn.click()
  await new Promise(r => setTimeout(r, 80))
  return document.querySelector(tag)
}

describe('<@failed retry> — limite de réessai', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('erreur déterministe, retry par défaut (1) : exactement 2 montages puis arrêt', async () => {
    const { window, document } = await mount('flakydef', flakySource('', true))
    assert.equal(window.__mount, 1, 'montage initial (crash)')
    let el = document.querySelector('mjs-flakydef')
    assert.match(el._shadow.querySelector('p.boom').textContent, /boom 1/)

    el = await clickReset(window, document, 'mjs-flakydef')
    assert.equal(window.__mount, 2, 'le réessai (1 autorisé) doit remonter le composant — UNE fois')
    assert.match(el._shadow.querySelector('p.boom').textContent, /boom 2/)
    assert.equal(el.getAttribute('mjs-retry-used'), '1', 'le compte de réessais consommés doit être transporté par attribut')

    el = await clickReset(window, document, 'mjs-flakydef')
    assert.equal(window.__mount, 2, "AVANT le fix : boucle infinie — la limite atteinte doit arrêter tout nouveau montage")
    assert.ok(
      window.__errors.some((m: string) => /limite de réessai atteinte/.test(m)),
      `un message de console explicite doit signaler l'abandon (reçus : ${JSON.stringify(window.__errors)})`
    )
  })

  it('retry="3" : exactement trois réessais (quatre montages), puis arrêt', async () => {
    const { window, document } = await mount('flaky3', flakySource('3', true))
    assert.equal(window.__mount, 1)
    let el = document.querySelector('mjs-flaky3')
    for (let i = 0; i < 3; i++) {
      el = await clickReset(window, document, 'mjs-flaky3')
      assert.equal(window.__mount, 2 + i, `réessai #${i + 1} doit remonter`)
    }
    el = await clickReset(window, document, 'mjs-flaky3')
    assert.equal(window.__mount, 4, 'les trois réessais consommés, un 4e clic ne doit RIEN remonter')
  })

  it('retry="0" : interdit tout réessai dès le premier crash', async () => {
    const { window, document } = await mount('flaky0', flakySource('0', true))
    assert.equal(window.__mount, 1)
    await clickReset(window, document, 'mjs-flaky0')
    assert.equal(window.__mount, 1, 'retry="0" : le clic ne doit produire AUCUN nouveau montage')
    assert.ok(window.__errors.some((m: string) => /limite de réessai atteinte/.test(m)), 'message de console dès le premier crash')
  })

  it('erreur TRANSITOIRE (ne se reproduit pas au second montage) : réparée par le réessai par défaut — cas qui justifie la fonction', async () => {
    const { window, document } = await mount('flakytrans', flakySource('', false))
    assert.equal(window.__mount, 1)
    let el = document.querySelector('mjs-flakytrans')
    assert.ok(el._shadow.querySelector('p.boom'), 'crash au premier montage')

    el = await clickReset(window, document, 'mjs-flakytrans')
    assert.equal(window.__mount, 2, 'le réessai doit remonter le composant')
    // jamais un nœud DOM en argument d'assert.equal (un happy-dom vivant fige la
    // suite si l'assertion échoue) — booléen seulement.
    assert.equal(el._shadow.querySelector('p.boom') == null, true, "AVANT tout bug : le contenu normal doit s'afficher, plus d'erreur")
    assert.equal(el._shadow.querySelector('p.ok').textContent.trim(), 'ok', 'rendu normal après réparation')
  })

  it('le compteur ne fuit pas entre deux instances distinctes du même composant', async () => {
    const { window, document } = await mount('flakytwo', flakySource('', true))
    document.body.insertAdjacentHTML('beforeend', '<mjs-flakytwo></mjs-flakytwo>')
    await new Promise(r => setTimeout(r, 80))
    const [elA, elB] = document.querySelectorAll('mjs-flakytwo')
    assert.ok(elA && elB, 'deux instances distinctes doivent être montées')

    // Épuise le réessai de la PREMIÈRE instance seulement.
    const btnA = elA._shadow.querySelector('button.btn')
    btnA.click()
    await new Promise(r => setTimeout(r, 80))
    const elAafter = document.querySelectorAll('mjs-flakytwo')[0]
    assert.equal(elAafter.getAttribute('mjs-retry-used'), '1', 'instance A a consommé son réessai')

    // L'instance B n'a JAMAIS été resetée : son compteur doit rester à zéro,
    // et elle doit ENCORE pouvoir se réessayer une fois (pas d'épuisement croisé).
    const elBstill = document.querySelectorAll('mjs-flakytwo')[1]
    assert.equal(elBstill.getAttribute('mjs-retry-used'), null, "l'instance B ne doit porter AUCUNE trace du réessai de l'instance A")
    const btnB = elBstill._shadow.querySelector('button.btn')
    assert.ok(btnB, 'B doit encore proposer un réessai (son propre compteur est à zéro)')
  })
})
