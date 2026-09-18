// Régression : mutation PROFONDE d'un store
// universel (`µ.state`/`$$`) totalement silencieuse.
//
//   $$game = µ.state({score: 0})
//   $$game.score += 10   // AVANT le fix : aucune notification, DOM figé
//
// Cause : le get trap de `µ.state` retournait le sous-objet BRUT (`target[key]`
// sans wrap récursif) — une fois qu'on tient une référence à `$$game`, muter
// `.score` dessus est une écriture sur un objet JS ordinaire, invisible à
// tout Proxy. C'est l'exemple MÊME documenté par mjs_store_globals.ts, mort depuis
// toujours. Fix : wrap récursif des sous-objets (cache WeakMap, `rootKey`
// bubblé à la clé de premier niveau) — même stratégie que `µ.Store._mjs_buildProxy`
// (mjs_store.ts), déjà éprouvée pour les singletons importés.
//
// Complète aussi le fil de discussion "pourquoi delete $var.prop pas
// réactif" : `_mjs_wrapDeep` (mjs_element.ts, filet pour un alias ÉCHAPPÉ de
// l'état LOCAL d'un composant) n'avait pas de trap `deleteProperty` — un
// `delete` exécuté depuis une fonction externe recevant l'alias ne
// notifiait jamais. `µ.Store` (singletons `µ$$`) avait le même trou.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

async function mount(name: string, source: string) {
  const root = mjsTmp(`deep-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  assert.ok(coreFile && compFile)

  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
  const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
  window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { window, document, el }
}

describe('µ.state — réactivité PROFONDE (mutation nichée)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it("`store.sub.prop = X` (assignation) re-rend un lecteur de `{store.sub.prop}`", async () => {
    const src = [
      '<script>',
      '@game = µ.state({score: 0})',
      '</script>',
      '<p class="score">{@game.score}</p>',
    ].join('\n')
    const { window, el } = await mount('deepassign', src)
    const p = el._shadow.querySelector('p.score')
    assert.equal(p.textContent.trim(), '0', 'valeur initiale')
    // `@game` compile en `this.game` (propriété d'instance directe), PAS
    // `this._state.game` — vérifié sur la sortie compilée réelle.
    window.eval(`document.querySelector('mjs-deepassign').game.score = 42;`)
    await new Promise(r => setTimeout(r, 80))
    assert.equal(p.textContent.trim(), '42', "l'assignation nichée doit re-rendre le lecteur (AVANT le fix : figé à 0)")
  })

  it("`store.sub.prop += X` (l'exemple EXACT documenté par mjs_store_globals.ts) re-rend", async () => {
    const src = [
      '<script>',
      '@game = µ.state({score: 0})',
      '</script>',
      '<p class="score">{@game.score}</p>',
    ].join('\n')
    const { window, el } = await mount('deepplusassign', src)
    window.eval(`
      const c = document.querySelector('mjs-deepplusassign');
      c.game.score += 10;
    `)
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p.score').textContent.trim(), '10')
  })

  it('deux lectures successives du MÊME sous-objet retournent des proxys `===` (identité stable, pas de proxy-de-proxy à chaque accès)', async () => {
    const src = ['<script>', '@game = µ.state({score: 0})', '</script>', '<p>{@game.score}</p>'].join('\n')
    const { window } = await mount('deepidentity', src)
    const same = window.eval(`
      const c = document.querySelector('mjs-deepidentity');
      const a = c.game;
      const b = c.game;
      (a === b) && (typeof a === 'object');
    `)
    assert.equal(same, true, 'le cache WeakMap doit retourner LE MÊME proxy (objet, pas undefined) pour le même sous-objet')
  })

  it('mutation profonde à 2 niveaux (`store.a.b.c = X`) re-rend aussi', async () => {
    const src = [
      '<script>',
      '@tree = µ.state({a: {b: {c: 1}}})',
      '</script>',
      '<p class="c">{@tree.a.b.c}</p>',
    ].join('\n')
    const { window, el } = await mount('deep2levels', src)
    window.eval(`document.querySelector('mjs-deep2levels').tree.a.b.c = 99;`)
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p.c').textContent.trim(), '99')
  })

  it('cas nominal (store à plat, déjà testé ailleurs) : pas de régression sur une simple clé top-level', async () => {
    const src = ['<script>', '@n = µ.state({x: 1})', '</script>', '<p>{@n.x}</p>'].join('\n')
    const { window, el } = await mount('deepflat', src)
    window.eval(`document.querySelector('mjs-deepflat').n.x = 5;`)
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p').textContent.trim(), '5')
  })
})

describe('_mjs_wrapDeep (état local) — trap deleteProperty', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it("`delete $obj.clé` (écrit en clair, déjà tracké compile-time) continue de re-rendre", async () => {
    const src = [
      '<script lang="coffee">',
      '$obj = {a: 1, b: 2}',
      '</script>',
      '<p class="keys">{Object.keys($obj).join(",")}</p>',
      '<button @click={delete $obj.a}>del</button>',
    ].join('\n')
    const { window: _window, el } = await mount('delcompiletime', src)
    assert.equal(el._shadow.querySelector('p.keys').textContent.trim(), 'a,b')
    el._shadow.querySelector('button').click()
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p.keys').textContent.trim(), 'b', 'delete en clair (path-tracker) doit toujours fonctionner')
  })

  it("`delete` via un ALIAS ÉCHAPPÉ (fonction externe) notifie désormais (trap deleteProperty du filet _mjs_wrapDeep)", async () => {
    const src = [
      '<script lang="coffee">',
      '$obj = {a: 1, b: 2}',
      'removeKey = (o, k) -> delete o[k]',
      '</script>',
      '<p class="keys">{Object.keys($obj).join(",")}</p>',
      '<button @click={removeKey($obj, "a")}>del</button>',
    ].join('\n')
    const { el } = await mount('delescaped', src)
    assert.equal(el._shadow.querySelector('p.keys').textContent.trim(), 'a,b')
    el._shadow.querySelector('button').click()
    await new Promise(r => setTimeout(r, 80))
    assert.equal(
      el._shadow.querySelector('p.keys').textContent.trim(),
      'b',
      "delete via alias échappé DOIT re-rendre (AVANT le fix : trap deleteProperty absent de _mjs_wrapDeep, DOM figé)"
    )
  })
})

describe('µ.Store (API manuelle `new µ.Store(...)`, sucre `µStore`) — trap deleteProperty', function () {
  // NB : les singletons `µ$$x` (import + consommation, sucre le plus courant)
  // compilent en réalité vers `µ.state(...)` (vérifié en inspectant la sortie
  // compilée d'un module singleton), donc déjà couverts par le describe ci-dessus.
  // `µ.Store` reste atteignable via l'API manuelle avancée `new µStore(...)`
  // (sucre lexer §3.8b, PascalCase → `µ.Store`) — c'est CE chemin que ce
  // test cible.
  //
  // Portée du fix, honnêtement bornée : `deleteProperty` notifie bien un
  // lecteur d'une clé LUE DIRECTEMENT (`@box.data.a`) — c'est ce que ce test
  // vérifie. L'ÉNUMÉRATION racine (`Object.keys(@box.data)`, `{for k in
  // @box.data}`) N'EST PAS couverte : `µ.Store` n'a pas de sentinelle
  // structurelle équivalente à `µ._mjs_STRUCT` (µ.state) — mon `ownKeys` ajouté
  // ne trace QUE l'énumération d'un sous-objet NICHÉ (rootKey non-null), pas
  // la racine. Ajouter cette sentinelle est un travail séparé,
  // volontairement pas fait ici pour rester dans la portée vérifiée.
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('delete sur une clé LUE DIRECTEMENT (`@box.data.a`) notifie le composant abonné', async () => {
    const src = [
      '<script lang="coffee">',
      '@box = new µStore({a: 1, b: 2})',
      '</script>',
      '<p class="a">{@box.data.a}</p>',
    ].join('\n')
    const { window, el } = await mount('storedel', src)
    assert.equal(el._shadow.querySelector('p.a').textContent.trim(), '1')
    window.eval(`delete document.querySelector('mjs-storedel').box.data.a;`)
    await new Promise(r => setTimeout(r, 120))
    assert.equal(
      el._shadow.querySelector('p.a').textContent.trim(),
      '',
      "delete sur une clé LUE DIRECTEMENT doit notifier (AVANT le fix : deleteProperty absent, valeur supprimée en silence, DOM figé sur '1')"
    )
  })
})
