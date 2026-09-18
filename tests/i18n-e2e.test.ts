// i18n v1 — BOUT-EN-BOUT RÉEL, intégration de quatre briques développées en
// parallèle (compilateur, runtime, build, fix store). Patron
// Bundler + happy-dom de tests/store-static-dispatch.test.ts : composants
// COMPILÉS puis MONTÉS, un vrai dossier `i18n/` en fixture temporaire, `fetch`
// STUBÉ pour servir les fragments RÉELLEMENT émis par le build (pas de
// simulacre du contrat runtime — la chaîne compilateur→build→runtime tourne
// pour de vrai).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { renderToString, createSSRRenderer, stripEsm, fileToId, ssrScopeFile, topoSortFiles } from '../src/server/renderToString.js'
import { mjsTmp } from './helpers/tmp.js'

// RÉUTILISE la machinerie SSR de renderToString.ts (`stripEsm`/`fileToId`/
// `ssrScopeFile`/`topoSortFiles`, exportées pour l'occasion) plutôt qu'un
// duplicata maison façon tests/store-static-dispatch.test.ts (patron jamais
// exercé en build MINIFIÉ, cf. cas h) : `ssrScopeFile` isole CHAQUE fichier
// compilé dans sa PROPRE IIFE (portée réelle, comme le vrai ESM) — sans ça,
// concaténer À PLAT plusieurs fichiers indépendamment minifiés fait
// collisionner leurs alias locaux courts (`const r = …` dans le core ET dans
// un composant, `SyntaxError: Identifier 'r' has already been declared`) ;
// `stripEsm` gère déjà, éprouvé en prod, le piège d'échappement esbuild du
// symbole `µ` dans les spécificateurs import/export (séquence littérale
// `µ`, PAS le glyphe, cf. son commentaire).

// Peuple `srcDir/i18n/` : racine fr/en (clés `titre`, `nav.fermer`) + section
// `panier` fr/en (clés `resume`, `items` pluriel) — mêmes fixtures pour tous
// les scénarios dev (a-g), un dossier PAR test pour l'isolation du cache.
function seedI18nDict(srcDir: string): void {
  const i18nDir = join(srcDir, 'i18n')
  mkdirSync(join(i18nDir, 'fr'), { recursive: true })
  mkdirSync(join(i18nDir, 'en'), { recursive: true })
  writeFileSync(join(i18nDir, 'fr.yml'), `titre: Bienvenue\nnav:\n  fermer: Fermer\n`)
  writeFileSync(join(i18nDir, 'en.json'), JSON.stringify({ titre: 'Welcome', nav: { fermer: 'Close' } }))
  writeFileSync(join(i18nDir, 'fr/panier.yml'), [
    'resume: Résumé du panier',
    'items:',
    '  one: "%{n} article"',
    '  other: "%{n} articles"',
  ].join('\n'))
  writeFileSync(join(i18nDir, 'en/panier.json'), JSON.stringify({
    resume: 'Cart summary',
    items: { one: '%{n} item', other: '%{n} items' },
  }))
}

// Extrait `µ._i18nData = {...}` du manifest écrit par writeManifest() (même
// helper que tests/i18n-build.test.ts) — RÉGLAGES seuls depuis que les dictionnaires
// sont partis dans un fichier par langue (`files`).
function readI18nData(manifestPath: string): any {
  const content = readFileSync(manifestPath, 'utf-8')
  const m = content.match(/µ\._i18nData = (\{.*?\});/)
  return m ? JSON.parse(m[1]) : undefined
}

// Contenu d'un fichier de langue émis (module à export par défaut, corps JSON pur).
function readLangFile(outDir: string, url: string): any {
  const src = readFileSync(join(outDir, url.split('/').pop()!), 'utf-8')
  return JSON.parse(src.replace(/^export default /, '').replace(/;\s*$/, ''))
}

// Crochet d'import des fichiers de langue (`µ._i18nImport`) : sert le fichier
// RÉELLEMENT émis par le build depuis `outDir`, comme le ferait le réseau — le
// démarrage i18n reste donc ASYNCHRONE ici, exactement comme au navigateur.
// `langues` : relevé des langues demandées (une seule doit l'être pour une page).
function makeLangImportStub(outDir: string) {
  const langues: string[] = []
  const fn = async (url: string) => {
    langues.push(String(url).split('/').pop()!.replace(/^mjs_i18n-/, '').replace(/-[a-f0-9]{8}\.js$/, ''))
    return { default: readLangFile(outDir, url) }
  }
  return { fn, langues }
}

// Stub `fetch` qui sert RÉELLEMENT les fragments émis par le build : résout
// l'URL (`.../i18n/<lang>/<nom>.json`) vers le fichier physique dans
// `outDir/i18n/<lang>/<nom>.json` — aucune donnée en dur, la vraie sortie du
// bundler transite jusqu'au runtime. `calls`/`urls` : compteurs d'assertion.
function makeFetchStub(outDir: string) {
  const calls: { count: number; urls: string[] } = { count: 0, urls: [] }
  const fn = async (url: string) => {
    calls.count++
    calls.urls.push(url)
    const m = url.match(/\/i18n\/([^/]+)\/([^/]+\.json)$/)
    if (!m) return { ok: false, status: 404 }
    const filePath = join(outDir, 'i18n', m[1], m[2])
    if (!existsSync(filePath)) return { ok: false, status: 404 }
    const json = JSON.parse(readFileSync(filePath, 'utf-8'))
    return { ok: true, status: 200, json: async () => json }
  }
  return { fn, calls }
}

// Compile les composants factices d'un projet i18n dans un dossier temp isolé,
// évalue le core + les composants dans une Window happy-dom FRAÎCHE, stub le
// fetch AVANT tout montage. Ne monte RIEN — chaque test insère/retire ses
// balises et contrôle son propre timing (nécessaire pour le mode 'wait').
// `onEval` : callback SYNCHRONE invoqué juste après
// `window.eval(...)` — AVANT tout `await`/microtask de retour de cette
// fonction. Sert à reproduire le montage SYNCHRONE dans le MÊME tick que
// l'eval (customElements upgrade pendant l'insertion), sans le microtask de
// rattrapage `queueMicrotask(__i18nBoot)` qui aurait déjà tourné si on
// attendait un `await setupProject(...)` avant d'insérer.
async function setupProject(sources: Record<string, string>, opts: { i18n?: any; forceMinify?: boolean; onEval?: (ctx: { window: any; document: any }) => void } = {}) {
  const root = mjsTmp('i18n-e2e')
  const srcDir = join(root, 'app')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  seedI18nDict(srcDir)
  for (const [name, src] of Object.entries(sources)) {
    writeFileSync(join(srcDir, `${name}.mjs`), src)
  }
  const bundler = new Bundler({
    sourceDir: srcDir,
    outputDir: outDir,
    manifestPath: join(root, 'bundle.js'),
    i18n: opts.i18n ?? { default: 'fr' },
    forceMinify: opts.forceMinify,
  })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const { fn: fetchFn, calls } = makeFetchStub(outDir)
  window.fetch = fetchFn

  const files = readdirSync(outDir).filter((f: string) => f.endsWith('.js'))
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  assert.ok(coreFile)
  // Ordre RÉEL de production : le manifest (bundle.js) importe le cœur (le
  // CORE — donc mjs_i18n.ts, concaténé dedans — s'exécute intégralement en
  // premier) PUIS pose `µ._i18nData` (parmi les autres globales manifest,
  // `µ.paths`/`µ.preload`) — reproduire CET ordre est indispensable : c'est
  // lui qui exerçait le bug d'intégration (`__i18nReal` figé AVANT que la
  // vraie donnée n'arrive, cf. src/runtime/mjs_i18n.ts).
  // cascade de modules — bundle.js n'importe plus le cœur STATIQUEMENT : son corps
  // (µ._i18nData compris) vit dans un `.then(async ({ µ }) => {…})` gardé par un VRAI
  // `import(µCore)` dynamique (cf. writeManifest, bundler/index.ts), que `stripEsm` laisse
  // volontairement intact (pas un import STATIQUE) — cet `import()` ne résoudrait JAMAIS ici
  // (chemin web, aucun serveur/fichier réel à cette URL) : préfixe et corps extraits
  // séparément, évalués tels quels, dans le MÊME ordre relatif qu'avant.
  const rawManifest = readFileSync(join(root, 'bundle.js'), 'utf-8')
  const bodyStart = rawManifest.indexOf('const µReady = ')
  const bodyMatch = rawManifest.match(/const µReady = import\(µCore\)\.then\(async \(\{ µ \}\) => \{\n([\s\S]*)\n\}\);\nif \(typeof window/)
  assert.ok(bodyMatch, `corps du manifeste introuvable (forme inattendue de writeManifest) :\n${rawManifest}`)
  const manifestSrc = [
    stripEsm(rawManifest.slice(0, bodyStart)),
    bodyMatch![1],
  ].join('\n').replace(/window\.µ\s*=\s*µ;?/, '') // window global pas dispo en `eval` de script classique ici, µ reste une var locale
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))

  // Composants : chacun dans sa PROPRE IIFE via `ssrScopeFile` (portée réelle
  // façon ESM) — indispensable en build MINIFIÉ (cas h/e) où plusieurs
  // fichiers indépendamment minifiés peuvent réutiliser les MÊMES alias
  // locaux courts (`const r = …`) ; une concaténation à plat collisionne.
  const otherFiles = files.filter((f: string) => f !== coreFile)
  const idByFile = new Map(otherFiles.map((f: string) => [f, fileToId(f)]))
  const resolve = (url: string): string | null => idByFile.get(url.split('/').pop() || '') ?? null
  const scoped = otherFiles.map((f: string) => {
    const id = idByFile.get(f)!
    const { code, deps } = ssrScopeFile(readFileSync(join(outDir, f), 'utf-8'), id, resolve)
    return { f, id, code, deps }
  })
  const depsById = new Map(scoped.map((s: any) => [s.id, s.deps]))
  const idToFile = new Map(scoped.map((s: any) => [s.id, s.f]))
  const codeById = new Map(scoped.map((s: any) => [s.id, s.code]))
  const sortedIds = topoSortFiles(scoped.map((s: any) => s.id), depsById, idToFile)
  const componentCode = sortedIds.map((id: string) => codeById.get(id)!).join('\n')

  // fichiers de langue : le runtime les importe lui-même une fois la langue décidée
  // (`µ._i18nImport`, crochet posé JUSTE APRÈS le cœur, avant que le corps du manifeste
  // ne déclenche le démarrage) — aucun résolveur ESM ici, le crochet lit `outDir`.
  const { fn: importFn, langues } = makeLangImportStub(outDir)
  ;(window as any).__mjsI18nImport = importFn
  window.eval(`${coreCode}\nµ._i18nImport = globalThis.__mjsI18nImport;\n${manifestSrc}\nglobalThis.µ = µ;\n${componentCode}`)
  if (opts.onEval) { opts.onEval({ window, document }) }

  const insert = (name: string): any => {
    const tag = `mjs-${name}`
    document.body.insertAdjacentHTML('beforeend', `<${tag}></${tag}>`)
    return document.body.querySelector(tag)
  }

  return { window, document, insert, calls, langues, outDir, root, bundler, readManifest: () => readI18nData(join(root, 'bundle.js')) }
}

describe('i18n — bout-en-bout RÉEL (compilateur + build + runtime, happy-dom)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it("(a) @i18n 'panier' + µt('resume') : monté, DOM affiche la traduction FR (racine + fragment stubé)", async () => {
    const { insert, calls } = await setupProject({
      panierview: [
        "@i18n 'panier'",
        '<p class="resume">{µt(\'resume\')}</p>',
      ].join('\n'),
    })
    const el = insert('panierview')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p.resume').textContent.trim(), 'Résumé du panier')
    assert.ok(calls.count >= 1, 'le fragment panier/fr a bien été fetché')
  })

  it("(b) µt('/nav.fermer') absolu (chemin jamais préfixé, même sous @i18n) + µt racine SANS @i18n", async () => {
    const { insert, calls } = await setupProject({
      panierabs: [
        "@i18n 'panier'",
        '<p class="nav">{µt(\'/nav.fermer\')}</p>',
      ].join('\n'),
      rootview: [
        '<p class="titre">{µt(\'titre\')}</p>',
      ].join('\n'),
    })
    const elAbs = insert('panierabs')
    const elRoot = insert('rootview')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(elAbs._shadow.querySelector('p.nav').textContent.trim(), 'Fermer', 'chemin absolu résolu dans la racine, jamais préfixé (même sous @i18n)')
    assert.equal(elRoot._shadow.querySelector('p.titre').textContent.trim(), 'Bienvenue', 'clé racine sans @i18n')
    // `panierabs` déclare @i18n 'panier' (nécessaire pour prouver que le chemin
    // absolu l'IGNORE) : ce SEUL fait déclenche 1 fetch de section (µ.i18n._mjs_i18nMount
    // enregistre/assure la section dès qu'elle est déclarée, indépendamment des
    // clés effectivement utilisées) — `rootview`, SANS @i18n, n'en ajoute AUCUN.
    assert.equal(calls.count, 1, "1 fetch (section déclarée par panierabs) ; rootview (racine SANS @i18n) n'en ajoute aucun")
  })

  it("(c) bascule µlang = 'en' (swap atomique) : DOM re-rendu en anglais, fragment en fetché UNE fois, retour fr = 0 fetch (cache chaud)", async () => {
    const { window, insert, calls } = await setupProject({
      panierbascule: [
        "@i18n 'panier'",
        '<p class="resume">{µt(\'resume\')}</p>',
      ].join('\n'),
    })
    const el = insert('panierbascule')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p.resume').textContent.trim(), 'Résumé du panier')
    assert.equal(calls.count, 1, 'fr déjà fetché au montage')

    window.µ.store.__mjsLang = 'en'
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p.resume').textContent.trim(), 'Cart summary')
    assert.equal(calls.count, 2, 'en fetché UNE fois')

    window.µ.store.__mjsLang = 'fr'
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p.resume').textContent.trim(), 'Résumé du panier')
    assert.equal(calls.count, 2, 'retour fr : cache déjà chaud, AUCUN fetch supplémentaire')
  })

  it('(d) 2 composants même section montés en rafale = 1 SEUL fetch', async () => {
    const { insert, calls } = await setupProject({
      panierd1: ["@i18n 'panier'", '<p class="resume">{µt(\'resume\')}</p>'].join('\n'),
      panierd2: ["@i18n 'panier'", '<p class="resume2">{µt(\'resume\')}</p>'].join('\n'),
    })
    // Insertion des DEUX composants SANS attendre entre les deux (même tick) :
    // dédoublonnage attendu du cache-singleton (µ._i18nCache, mjs_i18n.ts).
    const el1 = insert('panierd1')
    const el2 = insert('panierd2')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el1._shadow.querySelector('p.resume').textContent.trim(), 'Résumé du panier')
    assert.equal(el2._shadow.querySelector('p.resume2').textContent.trim(), 'Résumé du panier')
    assert.equal(calls.count, 1, 'dédoublonnage du fetch : les deux composants partagent la MÊME requête en vol')
  })

  describe('(e) modes placeholder', () => {
    it("auto : dev → '⟦clé⟧' sur clé manquante, prod → chaîne vide", async () => {
      const { insert: insertDev } = await setupProject({
        automissing: ["@i18n 'panier'", '<p class="v">{µt(\'inconnue\')}</p>'].join('\n'),
      })
      const elDev = insertDev('automissing')
      await new Promise(r => setTimeout(r, 80))
      assert.equal(elDev._shadow.querySelector('p.v').textContent.trim(), '⟦panier.inconnue⟧', 'dev : placeholder visible')

      const { insert: insertProd } = await setupProject({
        automissing: ["@i18n 'panier'", '<p class="v">{µt(\'inconnue\')}</p>'].join('\n'),
      }, { forceMinify: true })
      const elProd = insertProd('automissing')
      await new Promise(r => setTimeout(r, 80))
      assert.equal(elProd._shadow.querySelector('p.v').textContent.trim(), '', 'prod : silencieux')
    })

    it("key : '⟦clé⟧' TOUJOURS (même en prod)", async () => {
      const { insert } = await setupProject({
        keymode: ["@i18n 'panier'", '@i18nPlaceholder key', '<p class="v">{µt(\'inconnue\')}</p>'].join('\n'),
      }, { forceMinify: true })
      const el = insert('keymode')
      await new Promise(r => setTimeout(r, 80))
      assert.equal(el._shadow.querySelector('p.v').textContent.trim(), '⟦panier.inconnue⟧')
    })

    it("wait EN RÉEL : rien de rendu avant la résolution, contenu complet après ; démontage avant résolution = pas de crash ni rendu fantôme", async () => {
      const { window, document: _document, insert, outDir } = await setupProject({
        waitview: ["@i18n 'panier'", '@i18nPlaceholder wait', '<p class="w">{µt(\'resume\')}</p>'].join('\n'),
      })
      // Fetch sous contrôle manuel (résolution différée) pour ce test précis —
      // remplace le stub auto-résolvant du helper.
      let resolveFetch: (v: any) => void = () => {}
      const fetchGate = new Promise((r) => { resolveFetch = r })
      let fetchCalls = 0
      window.fetch = async (url: string) => {
        fetchCalls++
        await fetchGate
        const m = url.match(/\/i18n\/([^/]+)\/([^/]+\.json)$/)!
        const json = JSON.parse(readFileSync(join(outDir, 'i18n', m[1], m[2]), 'utf-8'))
        return { ok: true, status: 200, json: async () => json }
      }

      const el = insert('waitview')
      await new Promise(r => setTimeout(r, 30))
      // Fragment pas encore résolu : le rendu initial a été ANNULÉ (mjs_element.ts
      // ~995-1004, _mjs_pending_full mis à false) — le <p> peut être présent (structure
      // statique) mais son binding {µt('resume')} n'a jamais tourné : contenu vide.
      const textBeforeResolve = el._shadow.querySelector('w') ? '' : (el._shadow.querySelector('p.w')?.textContent ?? '')
      assert.equal(textBeforeResolve.trim(), '', "aucun contenu rendu avant la résolution du fragment (mode wait)")

      resolveFetch!(null)
      await new Promise(r => setTimeout(r, 40))
      assert.equal(el._shadow.querySelector('p.w').textContent.trim(), 'Résumé du panier', 'contenu complet après résolution')
      assert.equal(fetchCalls, 1)

      // Démontage AVANT résolution (nouveau composant, nouveau fetch en attente).
      let resolveFetch2: (v: any) => void = () => {}
      const fetchGate2 = new Promise((r) => { resolveFetch2 = r })
      window.fetch = async (url: string) => {
        await fetchGate2
        const m = url.match(/\/i18n\/([^/]+)\/([^/]+\.json)$/)!
        const json = JSON.parse(readFileSync(join(outDir, 'i18n', m[1], m[2]), 'utf-8'))
        return { ok: true, status: 200, json: async () => json }
      }
      // Section DIFFÉRENTE de fait (cache déjà chaud sur 'panier' fr) : on retire
      // manuellement l'entrée de cache pour retrouver un fragment "pas encore là".
      window.µ._i18nCache.delete('fr/panier')
      const el2 = insert('waitview')
      await new Promise(r => setTimeout(r, 20))
      el2.remove()
      await new Promise(r => setTimeout(r, 10))
      resolveFetch2!(null)
      await new Promise(r => setTimeout(r, 40))
      // Aucun crash levé (assert implicite : le test irait en erreur sinon) — le
      // composant est démonté, `_mjs_is_mounted` false court-circuite le re-render
      // planifié par mjs_element.ts (~1001, `if (!this._mjs_is_mounted...) return`).
      assert.equal(el2._mjs_is_mounted, false, 'bien démonté, aucun rendu fantôme après résolution tardive')
    })

    // Défaut : flash de ⟦tuto.chap_…⟧ pendant
    // ~60 ms) : `placeholder: 'wait'` posé dans le CONFIG n'était honoré que pour le
    // rendu du placeholder, pas pour le différé — `_mjs_mountReal` ne lisait que l'override
    // par module. Et même avec le différé, ANNULER le rendu programmé ne suffisait pas :
    // le batch déjà en file relançait le rendu structurel et les effets sur
    // `_mjs_pending_struct_dirty`. D'où le GEL (`_mjs_i18n_hold`), levé à la résolution.
    it("wait par CONFIG (sans directive de module) : rien de rendu avant la résolution, même si l'état bouge entre-temps", async () => {
      const { window, insert, outDir } = await setupProject(
        { cfgwait: ["@i18n 'panier'", '<p class="w">{µt(\'resume\')}</p>', '<p class="n">{$n}</p>', '<script>', '  $n = 0', '</script>'].join('\n') },
        { i18n: { default: 'fr', placeholder: 'wait' } },
      )
      let resolveFetch: (v: any) => void = () => {}
      const fetchGate = new Promise((r) => { resolveFetch = r })
      window.fetch = async (url: string) => {
        await fetchGate
        const m = url.match(/\/i18n\/([^/]+)\/([^/]+\.json)$/)!
        return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(join(outDir, 'i18n', m[1], m[2]), 'utf-8')) }
      }

      const el = insert('cfgwait')
      await new Promise(r => setTimeout(r, 30))
      assert.equal((el._shadow.querySelector('p.w')?.textContent ?? '').trim(), '', 'aucun contenu avant résolution, sur le seul mode du config')

      // écriture d'état PENDANT l'attente : c'est elle qui repeignait la page en
      // placeholders avant le gel
      el._state.n = 7
      el._mjs_invalidate('n')
      await new Promise(r => setTimeout(r, 30))
      assert.equal((el._shadow.querySelector('p.w')?.textContent ?? '').trim(), '', 'une mutation pendant l\'attente ne repeint pas non plus')

      resolveFetch!(null)
      await new Promise(r => setTimeout(r, 40))
      assert.equal(el._shadow.querySelector('p.w').textContent.trim(), 'Résumé du panier', 'contenu traduit une fois le fragment là')
      assert.equal(el._shadow.querySelector('p.n').textContent.trim(), '7', 'et la mutation faite pendant le gel est rattrapée par le rendu complet')
    })

    // CONTRE-ÉPREUVE — sans `wait` au config, le comportement d'origine tient :
    // le rendu part tout de suite, placeholder compris.
    it("auto par CONFIG : le rendu part tout de suite, sans attendre le fragment", async () => {
      const { window, insert, outDir } = await setupProject(
        { autoview: ["@i18n 'panier'", '<p class="n">{$n}</p>', '<script>', '  $n = 3', '</script>'].join('\n') },
        { i18n: { default: 'fr', placeholder: 'auto' } },
      )
      let resolveFetch: (v: any) => void = () => {}
      const fetchGate = new Promise((r) => { resolveFetch = r })
      window.fetch = async (url: string) => {
        await fetchGate
        const m = url.match(/\/i18n\/([^/]+)\/([^/]+\.json)$/)!
        return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(join(outDir, 'i18n', m[1], m[2]), 'utf-8')) }
      }
      const el = insert('autoview')
      await new Promise(r => setTimeout(r, 30))
      assert.equal(el._shadow.querySelector('p.n').textContent.trim(), '3', 'rendu immédiat, fragment ou pas')
      resolveFetch!(null)
    })
  })

  it('(f) pluriel one/other via vars.n + interpolation %{var} dans le DOM', async () => {
    const { insert, window } = await setupProject({
      pluralview: [
        "@i18n 'panier'",
        '<script>',
        '$$n = 1',
        '</script>',
        '<p class="items">{µt(\'items\', {n: $$n})}</p>',
      ].join('\n'),
    })
    const el = insert('pluralview')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p.items').textContent.trim(), '1 article', 'n=1 → one, interpolé')

    window.µ.store.n = 3
    await new Promise(r => setTimeout(r, 60))
    assert.equal(el._shadow.querySelector('p.items').textContent.trim(), '3 articles', 'n=3 → other, interpolé')
  })

  it("(g) µ.t('clé', undefined, 'mode') — vars undefined en 2e position ne casse pas", async () => {
    const { insert } = await setupProject({
      undefvars: [
        "@i18n 'panier'",
        '@i18nPlaceholder key',
        '<p class="v">{µt(\'resume\')}</p>',
      ].join('\n'),
    })
    // Ce module compile en `µ.t('panier.resume', undefined, 'key')` (3e argument
    // littéral SANS vars, cf. tests/i18n-compile.test.ts) : vérifie que le
    // runtime ne crashe pas et rend bien la traduction (le mode 'key' ne
    // s'applique qu'aux clés MANQUANTES, cf. mjs_i18n.ts __i18nPlaceholder).
    const el = insert('undefvars')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p.v').textContent.trim(), 'Résumé du panier')
  })

  it('(h) chaîne build→runtime PROD : hash actif, manifest pointe les noms hachés, le runtime fetche le bon chemin', async () => {
    const { insert, calls, readManifest, outDir } = await setupProject({
      panierhash: ["@i18n 'panier'", '<p class="resume">{µt(\'resume\')}</p>'].join('\n'),
    }, { forceMinify: true })
    const data = readManifest()
    // la table des sections vit dans le fichier de langue ; l'URL se reconstitue
    // `prefix/<langue>/<nom>.json`, exactement comme le fait le runtime.
    const fr = readLangFile(outDir, data.files.fr)
    const hashedUrl = `${data.prefix}/fr/${fr.sections.panier}.json`
    assert.match(hashedUrl, /\/i18n\/fr\/[a-f0-9]{32}\.json$/, 'le fichier de langue pointe un nom haché')

    const el = insert('panierhash')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p.resume').textContent.trim(), 'Résumé du panier')
    assert.ok(calls.urls.some(u => u === hashedUrl), 'le runtime a bien fetché le chemin HACHÉ du manifest (pas un nom clair)')
    assert.equal(calls.count, 1)
  })
})

// Correction de 5 angles morts (repros race2/unhandled2/boot_late) transformés
// en tests permanents.
describe('i18n — montage synchrone avant boot + échec réseau sans unhandled rejection', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  it("(nº1) montage SYNCHRONE dans le MÊME tick que l'eval core+manifest (SANS await intermédiaire) : fetch part quand même, texte traduit", async () => {
    let el: any
    let textJustAfterInsert: string
    await setupProject({
      racesync: ["@i18n 'panier'", '<p class="r">{µt(\'resume\')}</p>'].join('\n'),
    }, {
      onEval: ({ document }) => {
        // AUCUN await entre window.eval() et cette insertion : reproduit
        // l'upgrade customElements SYNCHRONE pendant l'eval du core (markup
        // statique/SSR hydraté) — `_mjs_i18nMount` (mjs_element.ts) tourne AVANT le
        // `queueMicrotask(__i18nBoot)` de mjs_i18n.ts.
        document.body.insertAdjacentHTML('beforeend', '<mjs-racesync></mjs-racesync>')
        el = document.body.querySelector('mjs-racesync')
        textJustAfterInsert = el._shadow.querySelector('p.r')?.textContent?.trim() ?? ''
      },
    })
    // Juste après l'insertion synchrone : le fragment n'a pas encore pu être
    // fetché (aucune microtask n'a encore tourné) — placeholder/vide attendu,
    // PAS un crash ni un blocage définitif (avant fix : 0 fetch, à VIE).
    assert.equal(textJustAfterInsert, '', 'rien de traduit encore au tick synchrone (attendu, pas un bug)')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p.r').textContent.trim(), 'Résumé du panier', 'le fragment a bien fini par être fetché ET rendu (sans ce fix, il restait vide à VIE)')
  })

  it("(nº1, variante déjà couverte) montage APRÈS un await (artefact) : continue de fonctionner", async () => {
    const { insert } = await setupProject({
      raceawait: ["@i18n 'panier'", '<p class="r">{µt(\'resume\')}</p>'].join('\n'),
    })
    const el = insert('raceawait')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelector('p.r').textContent.trim(), 'Résumé du panier')
  })

  it("(nº2) fetch 404 en mode auto : PAS d'unhandled rejection, placeholder rendu, retentative au montage suivant", async () => {
    const unhandled: any[] = []
    const onUnhandled = (err: any) => { unhandled.push(err) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const { window, document, insert } = await setupProject({
        fail404: ["@i18n 'panier'", '<p class="r">{µt(\'resume\')}</p>'].join('\n'),
      })
      let attempts = 0
      window.fetch = async () => { attempts++; return { ok: false, status: 404 } }
      const el = insert('fail404')
      await new Promise(r => setTimeout(r, 80))
      assert.equal(el._shadow.querySelector('p.r').textContent.trim(), '⟦panier.resume⟧', 'placeholder rendu (dev par défaut), pas un crash')
      assert.equal(attempts, 1)

      // Retentative au montage SUIVANT (entrée retirée du cache sur échec, cf.
      // mjs_i18n.ts _ensure) — fetch réparé entre-temps.
      window.fetch = async (_url: string) => { attempts++; return { ok: true, status: 200, json: async () => ({ resume: 'Résumé du panier' }) } }
      el.remove()
      document.body.insertAdjacentHTML('beforeend', '<mjs-fail404></mjs-fail404>')
      const el2 = document.body.querySelector('mjs-fail404')
      await new Promise(r => setTimeout(r, 80))
      assert.equal(el2._shadow.querySelector('p.r').textContent.trim(), 'Résumé du panier', 'retentative réussie au remontage')
      assert.equal(attempts, 2, 'entrée retirée du cache sur échec → un 2e fetch a bien eu lieu au remontage')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    assert.deepEqual(unhandled, [], 'AUCUNE unhandled rejection malgré le 404')
  })

  it("(nº2) mode 'wait' + fetch en échec : le composant SE REND avec les placeholders (jamais bloqué blanc à vie)", async () => {
    const unhandled: any[] = []
    const onUnhandled = (err: any) => { unhandled.push(err) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const { window, insert } = await setupProject({
        waitfail: ["@i18n 'panier'", '@i18nPlaceholder wait', '<p class="w">{µt(\'resume\')}</p>'].join('\n'),
      })
      window.fetch = async () => ({ ok: false, status: 404 })
      const el = insert('waitfail')
      await new Promise(r => setTimeout(r, 80))
      // Sans le fix : la promesse retournée à mjs_element.ts rejetait, le
      // `.then` de différé (mjs_element.ts ~1000) ne se déclenchait JAMAIS,
      // le composant restait sans son 2e rendu — blanc à vie. Avec le fix :
      // la promesse RÉSOUT (à null) sur échec, le composant se re-rend avec
      // le placeholder.
      assert.equal(el._shadow.querySelector('p.w')?.textContent?.trim(), '⟦panier.resume⟧', 'rendu avec placeholder après échec, pas bloqué blanc')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    assert.deepEqual(unhandled, [], "AUCUNE unhandled rejection en mode 'wait' malgré le 404")
  })
})

describe('i18n — SSR (renderToString) : clés racine ET section résolues serveur (préchargement disque), lang sérialisée', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it("clé racine ET clé de section résolues côté serveur (préchargement disque), #__mjs_store contient lang", async function () {
    this.timeout(30000)
    const root = mjsTmp('i18n-ssr')
    const srcDir = join(root, 'app')
    mkdirSync(srcDir, { recursive: true })
    seedI18nDict(srcDir)
    writeFileSync(join(srcDir, 'ssrview.mjs'), [
      "@i18n 'panier'",
      '<p class="titre">{µt(\'/titre\')}</p>',
      '<p class="resume">{µt(\'resume\')}</p>',
    ].join('\n'))

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-ssrview', i18n: { default: 'fr' } })

    assert.match(res.html, /Bienvenue/, 'clé RACINE (chemin absolu) résolue côté serveur — dictionnaire embarqué, pas de fetch requis')
    // Section 'panier' : SSR ne fetch JAMAIS (µ._isServer court-circuite _ensure,
    // cf. mjs_i18n.ts) — mais le fragment est désormais PRÉCHARGÉ DEPUIS LE DISQUE
    // (renderToString.ts, déjà écrit par scanI18n()/writeManifest() dans
    // outputDir/i18n/<langue>/) et injecté dans µ._i18nDict AVANT le montage : la
    // clé de section résout dès le premier rendu, plus de placeholder.
    assert.match(res.html, /Résumé du panier/, 'la clé de SECTION est résolue côté serveur (préchargement disque, plus de limitation v1)')
    // `__mjsLang` est une clé store
    // CACHÉE (accesseur non-énumérable, cf. mjs_store_globals.ts
    // _storeDeclare(keys, true)), donc absente de `JSON.stringify(µ.store)`
    // PAR CONSTRUCTION ; `serializeGlobal` (renderToString.ts) la rajoute
    // désormais EXPLICITEMENT dans l'objet sérialisé (accès direct par nom,
    // insensible à l'énumérabilité) — le canal #__mjs_store transporte donc
    // la langue SSR jusqu'au client, qui la re-déclare CACHÉE avant de la
    // réhydrater (mjs_store_globals.ts).
    assert.match(res.sharedScript ?? '', /"__mjsLang":"fr"/, '`__mjsLang` transite bien dans #__mjs_store (langue par défaut du rendu SSR)')

    await terminateSharedWorkerPool()
  })

  // La langue EFFECTIVE du préchargement suit le canal
  // d'ENTRÉE `options.store.__mjsLang`, PAS `i18n.default` : une page rendue
  // dans une langue non par défaut doit résoudre SES sections dans CETTE langue.
  it("clé de section résolue côté serveur pour une langue NON-default (options.store.__mjsLang), préchargement disque", async function () {
    this.timeout(30000)
    const root = mjsTmp('i18n-ssr-lang')
    const srcDir = join(root, 'app')
    mkdirSync(srcDir, { recursive: true })
    seedI18nDict(srcDir)
    writeFileSync(join(srcDir, 'ssrviewlang.mjs'), [
      "@i18n 'panier'",
      '<p class="resume">{µt(\'resume\')}</p>',
    ].join('\n'))

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-ssrviewlang', i18n: { default: 'fr' }, store: { __mjsLang: 'en' } })

    assert.match(res.html, /Cart summary/, 'clé de SECTION résolue côté serveur dans la langue EFFECTIVE (canal d\'entrée options.store.__mjsLang), pas i18n.default')
    assert.doesNotMatch(res.html, /Résumé du panier/, 'aucun mélange avec le contenu FR (i18n.default), langue effective = en')

    await terminateSharedWorkerPool()
  })

  // La section n'existe QU'EN langue par défaut (traduction pas
  // encore faite pour la langue effective) : le préchargement disque doit charger AUSSI
  // `i18n.default` pour que `µ.t` puisse répliquer dès le 1er rendu, exactement comme le ferait
  // le client après son fetch de repli (cf. mjs_i18n.ts, `_ensure` § Repli de section) — jamais
  // le placeholder au SSR. La graine doit semer cette section sous la clé de SA langue (fr), pas
  // sous la langue affichée (en).
  it('section absente de la langue effective mais présente en langue par défaut → texte de repli au SSR (jamais le placeholder), graine nichée sous la langue par défaut', async function () {
    this.timeout(30000)
    const root = mjsTmp('i18n-ssr-fallback-seed')
    const srcDir = join(root, 'app')
    mkdirSync(join(srcDir, 'i18n', 'fr'), { recursive: true })
    writeFileSync(join(srcDir, 'i18n', 'fr.yml'), 'titre: Bienvenue\n')
    writeFileSync(join(srcDir, 'i18n', 'en.json'), JSON.stringify({ titre: 'Welcome' }))
    writeFileSync(join(srcDir, 'i18n', 'fr', 'panier.yml'), 'resume: Résumé du panier\n')
    writeFileSync(join(srcDir, 'ssrfallbackseed.mjs'), [
      "@i18n 'panier'",
      '<p class="resume">{µt(\'resume\')}</p>',
    ].join('\n'))

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-ssrfallbackseed', i18n: { default: 'fr' }, store: { __mjsLang: 'en' } })

    assert.match(res.html, /Résumé du panier/, 'le texte de repli (langue par défaut fr) sort au 1er rendu serveur, section absente en en')
    assert.doesNotMatch(res.html, /⟦/, 'jamais le placeholder : le préchargement disque couvre aussi la langue par défaut')
    assert.match(res.sharedScript ?? '', /id="__mjs_i18n"/, 'la balise graine i18n est émise')
    assert.match(res.sharedScript ?? '', /"fr":\{"panier"/, 'la section repliée est semée sous la clé de SA langue (fr), pas sous la langue affichée (en)')

    await terminateSharedWorkerPool()
  })

  // Graine `#__mjs_i18n` : ne sème que les sections EFFECTIVEMENT
  // consultées au rendu (`µ._i18nUsed`), jamais tout le préchargement disque.
  it('balise `__mjs_i18n` : sème la section RENDUE, jamais une section jamais consultée', async function () {
    this.timeout(30000)
    const root = mjsTmp('i18n-ssr-seed')
    const srcDir = join(root, 'app')
    mkdirSync(srcDir, { recursive: true })
    seedI18nDict(srcDir)
    writeFileSync(join(srcDir, 'i18n', 'fr', 'inutile.yml'), 'cle: "jamais"\n')
    writeFileSync(join(srcDir, 'ssrseed.mjs'), [
      "@i18n 'panier'",
      '<p class="resume">{µt(\'resume\')}</p>',
    ].join('\n'))

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-ssrseed', i18n: { default: 'fr' } })

    assert.match(res.sharedScript ?? '', /id="__mjs_i18n"/, 'la balise graine i18n est émise')
    assert.match(res.sharedScript ?? '', /Résumé du panier/, 'la section RENDUE (panier, consultée par le composant) est semée')
    assert.doesNotMatch(res.sharedScript ?? '', /jamais/, "la section JAMAIS consultée (inutile) est absente de la graine, malgré le préchargement disque de µ._i18nDict")

    await terminateSharedWorkerPool()
  })

  // Miroir de tests/ssr-serialize-global-escaping.test.ts, appliqué à la
  // graine i18n (même helper `serializeGlobal`, même garde attendue).
  it("balise `__mjs_i18n` : une valeur de section contenant '<script>' ne laisse AUCUN '<' littéral (même échappement que __mjs_store)", async function () {
    this.timeout(30000)
    const root = mjsTmp('i18n-ssr-escape')
    const srcDir = join(root, 'app')
    mkdirSync(srcDir, { recursive: true })
    seedI18nDict(srcDir)
    const payload = '<!--evil--><script>alert(1)</script>'
    writeFileSync(join(srcDir, 'i18n', 'fr', 'panier.yml'), `resume: "${payload}"\nitems:\n  one: "%{n} article"\n  other: "%{n} articles"\n`)
    writeFileSync(join(srcDir, 'ssrescape.mjs'), [
      "@i18n 'panier'",
      '<p class="resume">{µt(\'resume\')}</p>',
    ].join('\n'))

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-ssrescape', i18n: { default: 'fr' } })

    const m = (res.sharedScript ?? '').match(/id="__mjs_i18n">([\s\S]*?)<\/script>/)
    assert.ok(m, `bloc __mjs_i18n introuvable. sharedScript:\n${res.sharedScript}`)
    const jsonInScript = m![1]
    assert.doesNotMatch(jsonInScript, /</, "aucun '<' littéral dans le JSON sérialisé (même garde que __mjs_store, cf ssr-serialize-global-escaping.test.ts)")

    const parsed = JSON.parse(jsonInScript)
    assert.equal(parsed.sections.fr.panier.resume, payload, "l'échappement \\u003c doit être réversible sans perte via JSON.parse (sections nichée par langue)")

    await terminateSharedWorkerPool()
  })

  // AVANT ce correctif, `loadLangDict` préchargeait sur
  // disque *toutes* les sections d'une langue à CHAQUE rendu (30 lectures/parsings pour un
  // composant qui n'en consomme qu'UNE). Le crochet `µ._i18nLoadSync` (renderToString.ts) ne lit
  // plus que la section RÉELLEMENT consultée, une fois par (langue, section) tant que le fichier
  // ne change pas — `renderer.i18nLoadCount` (SSRRenderer) compte les appels au crochet, cumulé
  // sur toute la durée de vie du renderer (PAS les lectures physiques : un couple déjà en cache
  // mémoire — chemin+mtime inchangés — ne retouche pas le disque mais reste un appel compté).
  it("i18nLoadCount (SSRRenderer) : 1 section consultée sur 30 → 1 lecture en fr, +1 (repli fr) en en, jamais 30", async function () {
    this.timeout(30000)
    const root = mjsTmp('i18n-ssr-lazy-count')
    const srcDir = join(root, 'app')
    mkdirSync(join(srcDir, 'i18n', 'fr'), { recursive: true })
    writeFileSync(join(srcDir, 'i18n', 'fr.yml'), 'titre: Bienvenue\n')
    writeFileSync(join(srcDir, 'i18n', 'en.json'), JSON.stringify({ titre: 'Welcome' }))
    // 30 sections fr, AUCUNE en — seule `sec0` sera consultée par le composant.
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(srcDir, 'i18n', 'fr', `sec${i}.yml`), `resume: "section ${i} fr"\n`)
    }
    writeFileSync(join(srcDir, 'costview.mjs'), [
      "@i18n 'sec0'",
      '<p class="resume">{µt(\'resume\')}</p>',
    ].join('\n'))

    const renderer = await createSSRRenderer({ sourceDir: srcDir, i18n: { default: 'fr' } })
    try {
      const resFr = await renderer.renderToString('mjs-costview', { store: { __mjsLang: 'fr' } })
      assert.match(resFr.html, /section 0 fr/, 'section fr résolue au 1er rendu (aucune régression de résolution)')
      assert.equal(renderer.i18nLoadCount, 1, 'un SEUL appel au crochet pour 1 section consultée en fr (jamais les 29 autres)')

      const resEn = await renderer.renderToString('mjs-costview', { store: { __mjsLang: 'en' } })
      assert.match(resEn.html, /section 0 fr/, 'section absente en en → texte de repli fr au 1er rendu (jamais le placeholder)')
      assert.equal(renderer.i18nLoadCount, 2, 'le rendu en ne coûte qu\'1 appel de PLUS (repli fr, même fichier déjà en cache mémoire chemin+mtime) — jamais 30 ni 60')
    } finally {
      await renderer.close()
    }
  })
})

describe('i18n — réhydratation SSR→client de la langue (__mjsLang, clé cachée)', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it("SSR rendu en langue NON par défaut du client ('en' serveur, 'fr' défaut client) → client réhydraté en 'en' sans bascule ni fetch, `__mjsLang` reste CACHÉE côté client", async function () {
    this.timeout(30000)
    const root = mjsTmp('i18n-hydrate')
    const srcDir = join(root, 'app')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    seedI18nDict(srcDir)
    writeFileSync(join(srcDir, 'hydrateview.mjs'), [
      '<p class="titre">{µt(\'/titre\')}</p>',
    ].join('\n'))

    // 1. SERVEUR — rendu en langue 'en' (i18n.default du RENDU, indépendant du
    // futur bundle client, cf. étape 2).
    const ssr = await renderToString({ sourceDir: srcDir, tag: 'mjs-hydrateview', i18n: { default: 'en' } })
    assert.match(ssr.html, /Welcome/, 'clé racine résolue côté serveur en "en"')
    assert.match(ssr.sharedScript ?? '', /"__mjsLang":"en"/, '__mjsLang="en" transite dans #__mjs_store émis par le serveur')

    // 2. CLIENT — MÊME source, bundle compilé avec un défaut DIFFÉRENT ('fr') :
    // sans réhydratation, le boot partirait sur 'fr'. Reproduit l'ordre RÉEL
    // (le canal #__mjs_store est déjà dans le DOM AVANT l'éval du core, comme
    // servi par le back — la réhydratation lit `document.getElementById` au
    // chargement synchrone de mjs_store_globals.ts).
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' } })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    let fetchCalls = 0
    window.fetch = async () => { fetchCalls++; return { ok: false, status: 404 } }

    const files = readdirSync(outDir).filter((f: string) => f.endsWith('.js'))
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    assert.ok(coreFile)
    // cascade de modules — cf. le bandeau détaillé plus haut dans ce fichier (buildProject) :
    // préfixe et corps du manifeste extraits séparément, jamais l'`import(µCore)` lui-même
    // (ne résoudrait jamais dans ce harnais synthétique).
    const rawManifest = readFileSync(join(root, 'bundle.js'), 'utf-8')
    const bodyStart = rawManifest.indexOf('const µReady = ')
    const bodyMatch = rawManifest.match(/const µReady = import\(µCore\)\.then\(async \(\{ µ \}\) => \{\n([\s\S]*)\n\}\);\nif \(typeof window/)
    assert.ok(bodyMatch, `corps du manifeste introuvable (forme inattendue de writeManifest) :\n${rawManifest}`)
    const manifestSrc = [
      stripEsm(rawManifest.slice(0, bodyStart)),
      bodyMatch![1],
    ].join('\n').replace(/window\.µ\s*=\s*µ;?/, '')
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const otherFiles = files.filter((f: string) => f !== coreFile)
    const idByFile = new Map(otherFiles.map((f: string) => [f, fileToId(f)]))
    const resolve = (url: string): string | null => idByFile.get(url.split('/').pop() || '') ?? null
    const scoped = otherFiles.map((f: string) => {
      const id = idByFile.get(f)!
      const { code, deps } = ssrScopeFile(readFileSync(join(outDir, f), 'utf-8'), id, resolve)
      return { f, id, code, deps }
    })
    const depsById = new Map(scoped.map((s: any) => [s.id, s.deps]))
    const idToFile = new Map(scoped.map((s: any) => [s.id, s.f]))
    const codeById = new Map(scoped.map((s: any) => [s.id, s.code]))
    const sortedIds = topoSortFiles(scoped.map((s: any) => s.id), depsById, idToFile)
    const componentCode = sortedIds.map((id: string) => codeById.get(id)!).join('\n')

    // Balise SSR insérée AVANT l'éval du core — ordre manifest→seed→boot réel.
    document.body.insertAdjacentHTML('afterbegin', ssr.sharedScript ?? '')
    // crochet des fichiers de langue (cf. makeLangImportStub) : c'est par lui, et non
    // plus par le manifeste, que le dictionnaire racine arrive au client.
    ;(window as any).__mjsI18nImport = makeLangImportStub(outDir).fn
    window.eval(`${coreCode}\nµ._i18nImport = globalThis.__mjsI18nImport;\n${manifestSrc}\nglobalThis.µ = µ;\n${componentCode}`)

    document.body.insertAdjacentHTML('beforeend', '<mjs-hydrateview></mjs-hydrateview>')
    const el = document.body.querySelector('mjs-hydrateview')
    await new Promise(r => setTimeout(r, 80))

    assert.equal(el._shadow.querySelector('p.titre').textContent.trim(), 'Welcome', 'client hydraté en "en" (langue SSR) — PAS le défaut client "fr"')
    assert.equal(window.µ.store.__mjsLang, 'en', 'langue effective client == langue du rendu SSR, sans bascule')
    assert.equal(fetchCalls, 0, 'zéro fetch au boot (racine embarquée, ce composant ne déclare aucune section)')
    assert.doesNotMatch(JSON.stringify(window.µ.store), /__mjsLang/, '`__mjsLang` reste une clé CACHÉE côté client (non-énumérable, absente de JSON.stringify(µ.store))')

    await terminateSharedWorkerPool()
  })
})

describe("i18n — canal d'ENTRÉE SSR (`options.store.__mjsLang`), clé toujours CACHÉE", () => {
  after(async () => { await terminateSharedWorkerPool() })

  it("renderToString({ store: { __mjsLang: 'en' } }) : langue rendue = en, clé ABSENTE de l'énumération DANS le composant serveur, transite quand même vers #__mjs_store, reste cachée côté client après réhydratation", async function () {
    this.timeout(30000)
    const root = mjsTmp('i18n-entry')
    const srcDir = join(root, 'app')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    seedI18nDict(srcDir)
    writeFileSync(join(srcDir, 'entryview.mjs'), [
      '<p class="titre">{µt(\'/titre\')}</p>',
      // sonde : lit l'énumération du store DEPUIS L'INTÉRIEUR du composant
      // rendu côté serveur — c'est exactement ce qu'un `{for k in $$}` ou un
      // `JSON.stringify($$)` applicatif verrait pendant le rendu SSR.
      '<p class="probe">{Object.keys(µ.store).join(\',\')}</p>',
    ].join('\n'))

    // Canal d'ENTRÉE : la langue arrive par `options.store`, PAS par
    // `i18n.default` (qui reste 'fr') — façon naturelle de rendre une page
    // dans une langue non par défaut.
    const ssr = await renderToString({ sourceDir: srcDir, tag: 'mjs-entryview', i18n: { default: 'fr' }, store: { __mjsLang: 'en' } })

    assert.match(ssr.html, /Welcome/, 'langue rendue = "en" (canal d\'entrée honoré, pas le défaut "fr")')
    const probeMatch = ssr.html.match(/class="probe">([^<]*)</)
    assert.ok(probeMatch, 'sonde présente dans le HTML rendu')
    assert.doesNotMatch(probeMatch![1], /__mjsLang/, "`__mjsLang` ABSENTE de Object.keys(µ.store) VU DEPUIS LE COMPOSANT SERVEUR (accesseur non-énumérable, pas une propriété plate)")
    assert.match(ssr.sharedScript ?? '', /"__mjsLang":"en"/, '`__mjsLang` transite quand même explicitement vers #__mjs_store (canal de SORTIE, insensible à l\'énumérabilité)')

    // CLIENT — même patron que le test de réhydratation SSR→client vu plus haut : bundle compilé avec un
    // défaut DIFFÉRENT ('fr'), réhydraté depuis le #__mjs_store émis ci-dessus.
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' } })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    window.fetch = async () => ({ ok: false, status: 404 })

    const files = readdirSync(outDir).filter((f: string) => f.endsWith('.js'))
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    assert.ok(coreFile)
    // cascade de modules — cf. le bandeau détaillé plus haut dans ce fichier (buildProject) :
    // préfixe et corps du manifeste extraits séparément, jamais l'`import(µCore)` lui-même
    // (ne résoudrait jamais dans ce harnais synthétique).
    const rawManifest = readFileSync(join(root, 'bundle.js'), 'utf-8')
    const bodyStart = rawManifest.indexOf('const µReady = ')
    const bodyMatch = rawManifest.match(/const µReady = import\(µCore\)\.then\(async \(\{ µ \}\) => \{\n([\s\S]*)\n\}\);\nif \(typeof window/)
    assert.ok(bodyMatch, `corps du manifeste introuvable (forme inattendue de writeManifest) :\n${rawManifest}`)
    const manifestSrc = [
      stripEsm(rawManifest.slice(0, bodyStart)),
      bodyMatch![1],
    ].join('\n').replace(/window\.µ\s*=\s*µ;?/, '')
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const otherFiles = files.filter((f: string) => f !== coreFile)
    const idByFile = new Map(otherFiles.map((f: string) => [f, fileToId(f)]))
    const resolve = (url: string): string | null => idByFile.get(url.split('/').pop() || '') ?? null
    const scoped = otherFiles.map((f: string) => {
      const id = idByFile.get(f)!
      const { code, deps } = ssrScopeFile(readFileSync(join(outDir, f), 'utf-8'), id, resolve)
      return { f, id, code, deps }
    })
    const depsById = new Map(scoped.map((s: any) => [s.id, s.deps]))
    const idToFile = new Map(scoped.map((s: any) => [s.id, s.f]))
    const codeById = new Map(scoped.map((s: any) => [s.id, s.code]))
    const sortedIds = topoSortFiles(scoped.map((s: any) => s.id), depsById, idToFile)
    const componentCode = sortedIds.map((id: string) => codeById.get(id)!).join('\n')

    document.body.insertAdjacentHTML('afterbegin', ssr.sharedScript ?? '')
    // crochet des fichiers de langue (cf. makeLangImportStub) : c'est par lui, et non
    // plus par le manifeste, que le dictionnaire racine arrive au client.
    ;(window as any).__mjsI18nImport = makeLangImportStub(outDir).fn
    window.eval(`${coreCode}\nµ._i18nImport = globalThis.__mjsI18nImport;\n${manifestSrc}\nglobalThis.µ = µ;\n${componentCode}`)

    document.body.insertAdjacentHTML('beforeend', '<mjs-entryview></mjs-entryview>')
    const el = document.body.querySelector('mjs-entryview')
    await new Promise(r => setTimeout(r, 80))

    assert.equal(el._shadow.querySelector('p.titre').textContent.trim(), 'Welcome', 'client hydraté en "en" (langue du canal d\'entrée serveur), PAS le défaut client "fr"')
    assert.equal(window.µ.store.__mjsLang, 'en', 'langue effective client == langue injectée côté serveur via options.store')
    assert.doesNotMatch(JSON.stringify(window.µ.store), /__mjsLang/, '`__mjsLang` reste une clé CACHÉE côté client APRÈS réhydratation (non-énumérable, absente de JSON.stringify(µ.store))')

    await terminateSharedWorkerPool()
  })
})
