// STATISATION — le store global `µ.store` (`$$`) n'est PLUS un Proxy
// `µ.state` : accesseurs PAR CLÉ adossés à `µ._mjs_storeRaw`, dispatch fin PAR
// CLÉ (`µ._mjs_storeSubscribe`/`_mjs_storeNotifyKey`, mjs_store_globals.ts). Ce fichier
// verrouille bout-en-bout (composants COMPILÉS + montés, happy-dom) le contrat
// VOULU du nouveau runtime :
//   (a) dispatch fin — écrire une clé ne re-rend QUE ses lecteurs
//   (b) plusieurs lecteurs de la MÊME clé notifiés ensemble, désabonnement au démontage
//   (c) mutations profondes (deep set/call/delete) re-rendent les lecteurs de la racine
//   (d) µread $$x / µwrite $$x, v : pas de dépendance créée / pas de notification
//   (e) énumération '$$*' (`{for k,v in µ.store}`) re-rend à l'ajout/retrait de clé
//   (f) derived $X = $$y*2 (risque nº1, computed dirty-marking sur clé store)
//   (g) réhydratation SSR (#__mjs_store) déclenche les abonnés

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

// Compile PLUSIEURS composants dans le MÊME dossier source (un seul mjs_core
// partagé) puis les monte tous dans LA MÊME fenêtre (donc le MÊME µ.store —
// indispensable pour observer une écriture depuis un composant impacter,
// ou pas, les AUTRES).
async function mountMulti(sources: Record<string, string>) {
  const root = mjsTmp('dispatch')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, src] of Object.entries(sources)) {
    writeFileSync(join(srcDir, `${name}.mjs`), src)
  }
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  assert.ok(coreFile)
  let evalSrc = `${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n`
  for (const name of Object.keys(sources)) {
    const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
    assert.ok(compFile, `composant compilé introuvable pour ${name}`)
    evalSrc += stripEsm(readFileSync(join(outDir, compFile!), 'utf-8')) + '\n'
  }
  window.eval(evalSrc)

  const els: Record<string, any> = {}
  for (const name of Object.keys(sources)) {
    const tag = `mjs-${name}`
    document.body.insertAdjacentHTML('beforeend', `<${tag}></${tag}>`)
    els[name] = document.body.querySelector(tag)
  }
  await new Promise(r => setTimeout(r, 80))
  return { window, document, els }
}

// Instrumente `_mjs_invalidate` d'une instance : retourne la liste (mutée en
// place) des clés reçues, sans perturber le comportement réel (délègue à
// l'implémentation d'origine après enregistrement).
function trackInvalidate(el: any): string[] {
  const calls: string[] = []
  const orig = el._mjs_invalidate.bind(el)
  el._mjs_invalidate = function (k: string) { calls.push(k); return orig(k) }
  return calls
}

describe('store statisé — dispatch fin par clé (bout-en-bout, composants compilés)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('(a) écrire $$a ne re-rend QUE le composant qui LIT $$a (pas celui qui lit $$b)', async () => {
    const { window, els } = await mountMulti({
      dispatcha: ['<script>', '$$a = 0', '</script>', '<p class="v">{$$a}</p>'].join('\n'),
      dispatchb: ['<script>', '$$b = 0', '</script>', '<p class="v">{$$b}</p>'].join('\n'),
    })
    const callsA = trackInvalidate(els.dispatcha)
    const callsB = trackInvalidate(els.dispatchb)

    window.µ.store.a = 99
    await new Promise(r => setTimeout(r, 60))

    assert.ok(callsA.includes('$$a'), 'le lecteur de $$a DOIT être invalidé')
    assert.equal(callsB.length, 0, 'le lecteur de $$b ne doit RECEVOIR AUCUNE invalidation (dispatch fin, pas de re-render universel)')
    assert.equal(els.dispatcha._shadow.querySelector('p.v').textContent.trim(), '99')
    assert.equal(els.dispatchb._shadow.querySelector('p.v').textContent.trim(), '0', 'inchangé')
  })

  it('(b) deux composants sur la MÊME clé sont TOUS DEUX notifiés ; désabonnement au démontage', async () => {
    const { window, document: _document, els } = await mountMulti({
      shareda: ['<script>', '$$shared = 0', '</script>', '<p class="v">{$$shared}</p>'].join('\n'),
      sharedb: ['<script>', '$$shared = 0', '</script>', '<p class="v">{$$shared}</p>'].join('\n'),
    })
    const callsA = trackInvalidate(els.shareda)
    const callsB = trackInvalidate(els.sharedb)

    window.µ.store.shared = 1
    await new Promise(r => setTimeout(r, 60))
    assert.ok(callsA.includes('$$shared'), 'A notifié')
    assert.ok(callsB.includes('$$shared'), 'B notifié')
    assert.equal(els.shareda._shadow.querySelector('p.v').textContent.trim(), '1')
    assert.equal(els.sharedb._shadow.querySelector('p.v').textContent.trim(), '1')

    // Démontage de B : plus AUCUNE invalidation ne doit lui parvenir ensuite.
    els.sharedb.remove()
    await new Promise(r => setTimeout(r, 30))
    callsB.length = 0
    window.µ.store.shared = 2
    await new Promise(r => setTimeout(r, 60))
    assert.equal(callsB.length, 0, 'composant démonté : plus abonné, _mjs_storeUnsubscribe a bien tourné')
    assert.equal(els.shareda._shadow.querySelector('p.v').textContent.trim(), '2', 'A toujours vivant, toujours notifié')
  })

  it('(c) mutations profondes (deep set/call/delete) re-rendent les lecteurs de la racine', async () => {
    const { window, els } = await mountMulti({
      deepreader: [
        '<script>',
        '$$obj = {a: 1}',
        '$$arr = []',
        '$$map = new Map()',
        '</script>',
        '<p class="obj">{$$obj.a}</p>',
        '<p class="arrlen">{$$arr.length}</p>',
        '<p class="mapsize">{$$map.size}</p>',
      ].join('\n'),
    })
    const el = els.deepreader
    const obj = () => el._shadow.querySelector('p.obj').textContent.trim()
    const arrlen = () => el._shadow.querySelector('p.arrlen').textContent.trim()
    const mapsize = () => el._shadow.querySelector('p.mapsize').textContent.trim()
    assert.equal(obj(), '1')
    assert.equal(arrlen(), '0')
    assert.equal(mapsize(), '0')

    window.µ._mjs_storeDeepSet('obj', ['a'], 42)
    await new Promise(r => setTimeout(r, 40))
    assert.equal(obj(), '42', '_mjs_storeDeepSet notifie la racine "obj"')

    window.µ._mjs_storeDeepCall('arr', [], 'push', [7])
    await new Promise(r => setTimeout(r, 40))
    assert.equal(arrlen(), '1', '_mjs_storeDeepCall (push) notifie la racine "arr"')

    window.µ._mjs_storeDeepCall('map', [], 'set', ['k', 1])
    await new Promise(r => setTimeout(r, 40))
    assert.equal(mapsize(), '1', '_mjs_storeDeepCall (Map.set) notifie la racine "map"')

    window.µ._mjs_storeDeepDelete('obj', ['a'])
    await new Promise(r => setTimeout(r, 40))
    assert.equal(obj(), '', '_mjs_storeDeepDelete notifie la racine "obj" (clé supprimée → undefined → vide)')
  })

  it('(d) µread $$x ne crée AUCUNE dépendance ; µwrite $$x, v écrit SANS notifier', async () => {
    const { window, els } = await mountMulti({
      readwrite: [
        '<script lang="coffee">',
        '$$val = 1',
        'bump = -> µwrite $$val, 999',
        '</script>',
        '<p class="v">{µread $$val}</p>',
        '<button @click={bump}>b</button>',
      ].join('\n'),
    })
    const el = els.readwrite
    const p = () => el._shadow.querySelector('p.v').textContent.trim()
    assert.equal(p(), '1', 'lecture initiale via µread')

    // _mjs_storeKeys ne doit PAS lister 'val' : µread ne passe pas par
    // l'accesseur µ.store (aucune dépendance posée, cf. RAW_ACCESS_STORE_OUT).
    assert.equal(el._mjs_storeKeys, undefined, 'µread seul : aucune subscription store posée')

    window.µ.store.val = 2
    await new Promise(r => setTimeout(r, 60))
    assert.equal(p(), '1', 'µread ne track PAS : le lecteur ne se re-rend jamais, texte figé sur sa valeur de mount')

    el._shadow.querySelector('button').click()
    await new Promise(r => setTimeout(r, 60))
    assert.equal(window.µ._mjs_storeRaw.val, 999, 'µwrite a bien écrit la valeur brute')
  })

  it('(e) {for k,v in µ.store} (\'$$*\') re-rend à l\'AJOUT/RETRAIT de clé', async () => {
    const { window, els } = await mountMulti({
      enumreader: [
        '<script>',
        '$$seed = 0',
        '</script>',
        '<p class="n">{Object.keys(µ.store).length}</p>',
      ].join('\n'),
    })
    const el = els.enumreader
    const n = () => Number(el._shadow.querySelector('p.n').textContent.trim())
    const before = n()

    // NB — une clé JAMAIS mentionnée textuellement par un module compilé n'a
    // PAS d'accesseur `µ.store.<clé>` pré-déclaré (`_storeDeclare`, scan
    // compile-time) : une assignation DIRECTE `µ.store.brandNewKey = 1` depuis
    // l'EXTÉRIEUR (ici le test, simulant un acteur externe type push serveur)
    // serait alors une simple propriété PLATE, jamais interceptée — c'est
    // justement le rôle de `µ._storeSet` (API publique documentée en tête de
    // mjs_store_globals.ts) : auto-déclare l'accesseur ET notifie. Une clé
    // écrite depuis DU CODE COMPILÉ (`$$brandNewKey = 1`) n'a pas ce problème
    // (le scan module-level `_storeDeclare` couvre toute mention textuelle).
    window.µ._storeSet('brandNewKey', 1)
    await new Promise(r => setTimeout(r, 60))
    assert.equal(n(), before + 1, "l'AJOUT d'une clé racine re-rend l'énumération")

    window.µ._mjs_storeDelete('brandNewKey')
    await new Promise(r => setTimeout(r, 60))
    assert.equal(n(), before, 'le RETRAIT re-rend aussi')
  })

  it('(f) derived $X = $$y*2 (risque nº1) : muter $$y re-évalue X et re-rend ses lecteurs, valeur FRAÎCHE', async () => {
    const { window, els } = await mountMulti({
      derivedreader: ['<script>', '$$dy = 3', '$X = $$dy * 2', '</script>', '<p class="x">{$X}</p>'].join('\n'),
    })
    const el = els.derivedreader
    const x = () => el._shadow.querySelector('p.x').textContent.trim()
    assert.equal(x(), '6', 'valeur initiale du derived')

    window.µ.store.dy = 10
    await new Promise(r => setTimeout(r, 60))
    assert.equal(x(), '20', "AVANT le fix : _mjs_dirty jamais remis à true sur invalidate('$$dy') → 6 périmé servi indéfiniment")
  })

  it('(h) delete externe puis réécriture COMPILÉE $$val = 55 : raw écrit, DOM mis à jour, notification reçue', async () => {
    const { window, els } = await mountMulti({
      rewriter: [
        '<script>', '$$val = 5', 'rewrite = -> $$val = 55', '</script>',
        '<p class="v">{$$val}</p>', '<button @click={rewrite}>b</button>',
      ].join('\n'),
    })
    const el = els.rewriter
    const txt = () => el._shadow.querySelector('p.v').textContent.trim()
    assert.equal(txt(), '5')

    // Simule un delete EXTERNE de la clé (reset admin, autre module…) : avant
    // le correctif, ceci supprimait l'ACCESSEUR (`delete µ.store[key]`).
    window.µ._mjs_storeDelete('val')
    assert.equal('val' in window.µ.store, false, 'accesseur bien retiré par _mjs_storeDelete')

    const calls = trackInvalidate(el)
    el._shadow.querySelector('button').click()
    await new Promise(r => setTimeout(r, 60))

    assert.equal(window.µ._mjs_storeRaw.val, 55, 'la valeur brute DOIT être écrite (pas de propriété plate silencieuse)')
    assert.ok(calls.includes('$$val'), 'la réécriture compilée DOIT notifier (µ._storeSet, plus l\'accesseur natif)')
    assert.equal(txt(), '55', 'le DOM DOIT refléter la nouvelle valeur')
  })

  it('(i) clé orpheline façon SSR (seed avant tout module qui la mentionne) : écriture ultérieure notifie', async () => {
    const root = mjsTmp('orphan')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'routea.mjs'), ['<script>', '$$onlyA = 1', '</script>', '<p>{$$onlyA}</p>'].join('\n'))
    writeFileSync(join(srcDir, 'routeb.mjs'), ['<script>', '</script>', '<p class="v">{$$orphanKey}</p>'].join('\n'))
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0)

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
    window.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n`)
    const aFile = files.find((f: string) => /^routea-/.test(f))!
    window.eval(stripEsm(readFileSync(join(outDir, aFile), 'utf-8')))

    // Seed façon SSR CORRIGÉ (renderToString.ts:776) : clé par clé via _storeSet,
    // AUCUN module chargé ne mentionne encore 'orphanKey'.
    window.eval(`(function(__s){ for (var __k in __s) { if (Object.prototype.hasOwnProperty.call(__s, __k)) { µ._storeSet(__k, __s[__k]); } } })(${JSON.stringify({ orphanKey: 42 })})`)
    assert.ok('orphanKey' in window.µ.store, 'µ._storeSet auto-déclare l\'accesseur au seed')

    // module « lazy » chargé PLUS TARD : le lit ET l'écrit
    const bFile = files.find((f: string) => /^routeb-/.test(f))!
    window.eval(stripEsm(readFileSync(join(outDir, bFile), 'utf-8')))
    document.body.insertAdjacentHTML('beforeend', '<mjs-routeb></mjs-routeb>')
    const el = document.body.querySelector('mjs-routeb')
    await new Promise(r => setTimeout(r, 100))
    const txt = () => el._shadow.querySelector('p.v').textContent.trim()
    assert.equal(txt(), '42', 'valeur seedée visible au montage du module lazy')

    window.µ.store.orphanKey = 99
    await new Promise(r => setTimeout(r, 100))
    assert.equal(txt(), '99', 'écriture ultérieure notifiée (accesseur toujours en place)')
    assert.equal(window.µ._mjs_storeRaw.orphanKey, 99)

    await terminateSharedWorkerPool()
  })

  it('(j) conversion propriété plate → accesseur par _storeDeclare (idempotent)', async () => {
    const { window, els } = await mountMulti({
      convreader: ['<script>', '</script>', '<p class="v">{$$flat}</p>'].join('\n'),
    })
    // Pose une propriété PLATE à la main (simule un Object.assign externe, ou
    // l'ANCIEN comportement avant correctif).
    Object.defineProperty(window.µ.store, 'flat', { value: 7, enumerable: true, configurable: true, writable: true })
    assert.equal(Object.getOwnPropertyDescriptor(window.µ.store, 'flat')?.get, undefined, 'bien plate avant conversion')

    window.µ._storeDeclare(['flat'])
    const desc = Object.getOwnPropertyDescriptor(window.µ.store, 'flat')
    assert.ok(desc?.get, 'accesseur posé après _storeDeclare')
    assert.equal(window.µ._mjs_storeRaw.flat, 7, 'la valeur plate a migré vers _mjs_storeRaw')
    assert.equal(window.µ.store.flat, 7, 'lecture inchangée après conversion')

    // Idempotence : rejouer ne casse rien.
    window.µ._storeDeclare(['flat'])
    assert.equal(window.µ.store.flat, 7)

    // Notification effective sur écriture APRÈS conversion.
    const calls = trackInvalidate(els.convreader)
    window.µ.store.flat = 8
    await new Promise(r => setTimeout(r, 40))
    assert.ok(calls.includes('$$flat'), 'écriture après conversion notifie bien')
  })

  it('(k) composés top-level $$x += / ||= / ++ notifient et court-circuitent correctement', async () => {
    const { window: _window, els } = await mountMulti({
      compound: [
        '<script>',
        '$$cnt = 0',
        '$$flag = false',
        'inc = -> $$cnt += 1',
        'bumpPre = -> ++$$cnt',
        'bumpPost = -> $$cnt++',
        'setFlag = -> $$flag ||= true',
        '</script>',
        '<p class="cnt">{$$cnt}</p>',
        '<p class="flag">{$$flag}</p>',
        '<button class="inc" @click={inc}>inc</button>',
        '<button class="pre" @click={bumpPre}>pre</button>',
        '<button class="post" @click={bumpPost}>post</button>',
        '<button class="fl" @click={setFlag}>fl</button>',
      ].join('\n'),
    })
    const el = els.compound
    const cnt = () => el._shadow.querySelector('p.cnt').textContent.trim()
    const flag = () => el._shadow.querySelector('p.flag').textContent.trim()
    assert.equal(cnt(), '0')

    el._shadow.querySelector('button.inc').click()
    await new Promise(r => setTimeout(r, 40))
    assert.equal(cnt(), '1', '+= notifie')

    el._shadow.querySelector('button.pre').click()
    await new Promise(r => setTimeout(r, 40))
    assert.equal(cnt(), '2', '++préfixe notifie')

    el._shadow.querySelector('button.post').click()
    await new Promise(r => setTimeout(r, 40))
    assert.equal(cnt(), '3', 'postfixe++ notifie')

    // ||= : flag=false → doit passer à true, notifier, puis un second clic
    // (flag déjà true) NE DOIT PAS re-notifier (court-circuit natif JS).
    const calls = trackInvalidate(el)
    el._shadow.querySelector('button.fl').click()
    await new Promise(r => setTimeout(r, 40))
    assert.equal(flag(), 'true', '||= a bien écrit true')
    assert.ok(calls.includes('$$flag'), '||= déclenchant notifie')

    calls.length = 0
    el._shadow.querySelector('button.fl').click()
    await new Promise(r => setTimeout(r, 40))
    assert.equal(calls.length, 0, '||= sur valeur déjà truthy : court-circuit natif, aucune notification parasite')
  })

  it('(g) réhydratation SSR : µ._storeSet depuis un JSON #__mjs_store simulé déclenche les abonnés', async () => {
    const { window, els } = await mountMulti({
      hydratreader: ['<script>', '$$hydrated = 0', '</script>', '<p class="v">{$$hydrated}</p>'].join('\n'),
    })
    const el = els.hydratreader
    const p = () => el._shadow.querySelector('p.v').textContent.trim()
    assert.equal(p(), '0')

    // Simule le contrat SSR (mjs_store_globals.ts, réhydratation) : un composant
    // externe (le back) sérialise l'état dans un JSON — ici on rejoue
    // directement la boucle `µ._storeSet` documentée pour chaque clé, sans
    // dépendre d'un vrai <script id="__mjs_store"> (déjà couvert par les
    // suites SSR renderToString dédiées, ce test cible SEULEMENT le contrat
    // runtime : la réhydratation DOIT notifier comme une écriture normale).
    const fakeServerState = { hydrated: 77 }
    for (const k in fakeServerState) window.µ._storeSet(k, (fakeServerState as any)[k])
    await new Promise(r => setTimeout(r, 60))
    assert.equal(p(), '77', 'la réhydratation notifie les abonnés déjà montés, comme toute écriture _storeSet')
  })
})
