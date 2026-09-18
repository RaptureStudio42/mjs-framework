// i18n v1 runtime (mjs_i18n.ts) — SANS Proxy, dictionnaires nus, registre
// section→composants, cache-singleton des fragments. Chargement du fichier
// SOURCE brut (pattern `new Function('µ', src)(µ)`, cf. router-prefix-match
// .test.ts) : `src/runtime/**/*.ts` est HORS tsconfig (JS pur transpilé à la
// main, pas de TypeScript réel dedans) — on l'exécute tel quel, comme le
// bundler le ferait en assemblant les modules runtime dans l'ordre canonique
// (mjs_store_globals.ts PUIS mjs_i18n.ts).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE = join(__dirname, '..', 'src', 'runtime', 'mjs_store_globals.ts')
const I18N = join(__dirname, '..', 'src', 'runtime', 'mjs_i18n.ts')
const storeSrc = readFileSync(STORE, 'utf-8')
const i18nSrc = readFileSync(I18N, 'utf-8')

// Fabrique un `µ` frais (store + i18n) — `state()` stubbé en identité (µ.nav/
// µ._mjs_env n'ont pas besoin d'une vraie réactivité pour ces tests). `data` =
// scénario complet (réglages + `root`/`sections` de chaque langue), découpé par
// `semerLangues` comme le build le fait : réglages dans `µ._i18nData` (manifeste),
// dictionnaires dans les fichiers de langue — semés ici AVANT le chargement du
// module, ce qui reproduit une page dont les fichiers sont déjà là (démarrage
// synchrone). Le chargement RÉSEAU de ces fichiers a sa propre suite
// (tests/i18n-chargement-langue.test.ts). `undefined` = build SANS i18n (inerte).
function makeMu(data?: any) {
  const µ: any = { log() {}, warn() {}, error() {}, state(o: any) { return o } }
  new Function('µ', storeSrc)(µ)
  if (data !== undefined) { semerLangues(µ, data) }
  new Function('µ', i18nSrc)(µ)
  return µ
}

// Découpe un scénario en manifeste ALLÉGÉ + registre des langues : `sections` passe
// de l'URL entière (`/i18n/fr/panier.json`) au seul nom du fragment, l'URL étant
// reconstituée par le runtime à partir de `prefix`.
function semerLangues(µ: any, data: any): void {
  const { root = {}, sections = {}, ...reglages } = data
  const langues: Record<string, any> = {}
  for (const lang of new Set([...Object.keys(root), ...Object.keys(sections)])) {
    const table: Record<string, string> = {}
    for (const [section, url] of Object.entries(sections[lang] ?? {})) {
      const m = String(url).match(/\/([^/]+)\.json$/)
      table[section] = m ? m[1] : String(url)
    }
    langues[lang] = { root: root[lang] ?? {}, sections: table }
  }
  µ._i18nLangs = langues
  µ._i18nData = { prefix: '/i18n', langs: Object.keys(root).sort(), files: {}, ...reglages }
}

// Simule une page SSR : le store est PRÉ-hydraté (`__mjsLang`) par
// mjs_store_globals.ts AVANT le chargement de mjs_i18n.ts (déclaration CACHÉE +
// `_storeSet`, comme la vraie réhydratation `<script id="__mjs_store">`, qui
// vaut TOUJOURS la langue par défaut sur une page prérendue statique).
function makeMuHydrated(hydratedLang: string, data: any) {
  const µ: any = { log() {}, warn() {}, error() {}, state(o: any) { return o } }
  new Function('µ', storeSrc)(µ)
  µ._storeDeclare(['__mjsLang'], true)
  µ._storeSet('__mjsLang', hydratedLang)
  semerLangues(µ, data)
  new Function('µ', i18nSrc)(µ)
  return µ
}

function baseData(overrides: any = {}) {
  return {
    dev: false,
    default: 'fr',
    placeholder: 'auto',
    root: {
      fr: { bonjour: 'Bonjour', salut: { one: '%{n} salut', other: '%{n} saluts' }, imbrique: { profond: 'Valeur %{x}' } },
      en: { bonjour: 'Hello', salut: { one: '%{n} hi', other: '%{n} his' } },
    },
    sections: {
      fr: { panier: '/i18n/fr/panier.json' },
      en: { panier: '/i18n/en/panier.json' },
    },
    ...overrides,
  }
}

// Composant factice minimal : seul `_mjs_invalidate` est observé par les tests.
function fakeComp(section: string | null, override: string | null = null) {
  const invalidations: string[] = []
  return {
    _mjs_i18n: [section, override],
    _mjs_invalidate(k: string) { invalidations.push(k) },
    _invalidations: invalidations,
  }
}

// BUG D'INTÉGRATION — plusieurs `it` ci-dessous posent `globalThis.fetch`
// SANS jamais le restaurer : en mode `npm test` (un seul process Mocha pour
// TOUS les fichiers), le stub fuitait vers les suites lancées ENSUITE
// (tests/server.test.ts, tests/server-render-routes.test.ts…) — leur vrai
// `fetch(url)` recevait alors `{ok, json()}` sans `.text()` → `res.text is
// not a function` en cascade. `afterEach` restaure l'original à chaque test.
const __originalFetch = (globalThis as any).fetch

// Stubs localStorage/navigator (persist/detect) — À POSER
// AVANT `makeMu()` (le boot lit `µ._i18nData.persist`/`.detect` de façon
// SYNCHRONE, cf. `__i18nDetectInitialLang`). Même patron de fuite que
// `__originalFetch` ci-dessus (process Mocha unique) : restaurés par
// `afterEach` (delete si absents à l'origine — Node n'a ni `localStorage` ni
// `navigator` par défaut).
// PORTABILITÉ Node ≥ 21 : `navigator` y est un ACCESSEUR sans setter (l'affectation
// jette et tue le chargement du fichier, donc toute la suite) — on mémorise son
// DESCRIPTEUR et on écrit par `defineProperty`. Identique sur Node 20 et 24
const __originalLocalStorage = (globalThis as any).localStorage
const __originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const __originalLocation     = (globalThis as any).location
const __originalHistory      = (globalThis as any).history
const __originalDocument     = (globalThis as any).document

function stubLocalStorage(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial }
  const setItemCalls: Array<[string, string]> = []
  ;(globalThis as any).localStorage = {
    getItem(k: string) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null },
    setItem(k: string, v: string) { setItemCalls.push([k, v]); store[k] = v },
  }
  return { store, setItemCalls }
}

function stubThrowingLocalStorage() {
  (globalThis as any).localStorage = {
    getItem() { throw new Error('SecurityError : accès localStorage refusé (sandbox)') },
    setItem() { throw new Error('QuotaExceededError') },
  }
}

function stubNavigator(language: string, languages?: string[]) {
  Object.defineProperty(globalThis, 'navigator', { value: { language, languages: languages ?? [language] }, writable: true, configurable: true })
}

// Stubs location/history (urlParam) — location.search lu au
// boot, location.href + history.replaceState écrits à la bascule. Même patron
// de fuite (process Mocha unique) : restaurés par `afterEach`.
function stubLocation(search: string) {
  (globalThis as any).location = { search, href: 'https://mjs.test/' + search, pathname: '/', hash: '' }
}
function stubHistory() {
  const calls: Array<[any, string, string]> = []
  ;(globalThis as any).history = {
    state: { k: 1 },
    replaceState(s: any, t: string, u: string) { calls.push([s, t, u]); (globalThis as any).location.href = 'https://mjs.test' + u },
  }
  return { calls }
}

// Stub document (graine __mjs_i18n) — lecteur de graine posé/retiré même
// patron que les autres globaux (afterEach). `elements` : id → `{ textContent }`.
function stubDocument(elements: Record<string, { textContent: string }>) {
  // faux document COMPLET : les globals du store écoutent aussi visibilitychange et lisent readyState
  (globalThis as any).document = {
    readyState: 'complete',
    hidden:     false,
    getElementById(id: string) { return Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null },
    addEventListener() {},
    removeEventListener() {},
  }
}

describe('i18n runtime (mjs_i18n.ts)', function () {
  afterEach(function () {
    (globalThis as any).fetch = __originalFetch
    if (__originalLocalStorage === undefined) { delete (globalThis as any).localStorage } else { (globalThis as any).localStorage = __originalLocalStorage }
    if (__originalNavigatorDesc === undefined) { delete (globalThis as any).navigator } else { Object.defineProperty(globalThis, 'navigator', __originalNavigatorDesc) }
    if (__originalLocation === undefined) { delete (globalThis as any).location } else { (globalThis as any).location = __originalLocation }
    if (__originalHistory === undefined) { delete (globalThis as any).history } else { (globalThis as any).history = __originalHistory }
    if (__originalDocument === undefined) { delete (globalThis as any).document } else { (globalThis as any).document = __originalDocument }
  })

  describe('µt : résolution chemin + interpolation + pluriel', function () {
    it('résout un chemin simple dans le dict de la langue courante', function () {
      const µ = makeMu(baseData())
      assert.equal(µ.t('bonjour'), 'Bonjour')
    })

    it('résout un chemin imbriqué (a.b.c) et interpole %{var}', function () {
      const µ = makeMu(baseData())
      assert.equal(µ.t('imbrique.profond', { x: 42 }), 'Valeur 42')
    })

    it('pluriel : n === 1 → one, sinon → other (interpolation %{n} incluse)', function () {
      const µ = makeMu(baseData())
      assert.equal(µ.t('salut', { n: 1 }), '1 salut')
      assert.equal(µ.t('salut', { n: 3 }), '3 saluts')
    })

    it('pluriel : n ABSENT → other (jamais one) — %{n} sans valeur reste littéral', function () {
      const µ = makeMu(baseData())
      assert.equal(µ.t('salut', {}), '%{n} saluts')
    })

    it("bascule de langue (swap atomique ASYNC) : la même clé résout dans le nouveau dict, APRÈS résolution du swap (pas immédiatement)", async function () {
      const µ = makeMu(baseData())
      µ._storeSet('__mjsLang', 'en')
      assert.equal(µ.t('bonjour'), 'Bonjour', "AVANT résolution du swap (aucune section montée : résolution quasi immédiate, mais TOUJOURS async — jamais synchrone) : ancienne langue")
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(µ.t('bonjour'), 'Hello', 'APRÈS résolution (racine embarquée, zéro fetch) : nouvelle langue')
    })
  })

  describe('repli sur la langue par défaut', function () {
    it('clé absente dans la langue courante, présente dans le défaut → texte du défaut, APRÈS résolution du swap', async function () {
      const µ = makeMu(baseData({
        root: {
          fr: { bonjour: 'Bonjour', seulementFr: 'Uniquement en français' },
          en: { bonjour: 'Hello' },
        },
      }))
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(µ.t('seulementFr'), 'Uniquement en français', 'repli sur fr (default) : clé absente en en')
    })

    it('clé absente PARTOUT (même dans le défaut) → placeholder inchangé (non-régression)', function () {
      const µ = makeMu(baseData({ dev: true }))
      assert.equal(µ.t('vraiment.inconnue'), '⟦vraiment.inconnue⟧')
    })

    it('repli abouti + dev=true → un SEUL warning dédupliqué pour le même couple (langue, clé)', async function () {
      const µ = makeMu(baseData({
        dev: true,
        root: { fr: { seulementFr: 'Uniquement en français' }, en: {} },
      }))
      const warnings: string[] = []
      µ.warn = function (msg: string) { warnings.push(msg) }
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(µ.t('seulementFr'), 'Uniquement en français')
      assert.equal(µ.t('seulementFr'), 'Uniquement en français')
      assert.equal(warnings.length, 1, 'un seul warning malgré 2 résolutions de la même clé')
    })

    it('repli + dev=false → AUCUN warning (silence prod)', async function () {
      const µ = makeMu(baseData({
        dev: false,
        root: { fr: { seulementFr: 'Uniquement en français' }, en: {} },
      }))
      const warnings: string[] = []
      µ.warn = function (msg: string) { warnings.push(msg) }
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(µ.t('seulementFr'), 'Uniquement en français')
      assert.equal(warnings.length, 0)
    })

    it("repli + pluriel : n:0 suit les règles CLDR de la langue de RÉSOLUTION (fr, le défaut), PAS celles de la langue demandée (en) — clé 'salut' absente en en, repli sur fr où n=0 → 'one' (singulier), alors qu'en anglais n=0 → 'other'", async function () {
      const µ = makeMu(baseData({
        root: {
          fr: { salut: { one: '%{n} salut', other: '%{n} saluts' } },
          en: { bonjour: 'Hello' },
        },
      }))
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(µ.t('salut', { n: 0 }), '0 salut', "catégorie CLDR fr (langue de résolution) pour n=0 = 'one' → singulier, PAS '0 saluts' que donnerait à tort la règle CLDR en ('other')")
    })
  })

  describe('pluriel CLDR', function () {
    it("n=0 en fr → catégorie 'one' (CLDR fr, verrouille le nouveau comportement — PAS 'other' comme avant)", function () {
      const µ = makeMu(baseData())
      assert.equal(µ.t('salut', { n: 0 }), '0 salut')
    })

    it('dict avec catégories few/many (langue synthétique pl) → catégorie CLDR correcte', function () {
      const µ = makeMu(baseData({
        default: 'pl',
        root: {
          pl: { item: { one: '%{n} przedmiot', few: '%{n} przedmioty', many: '%{n} przedmiotów', other: '%{n} przedmiotu' } },
        },
      }))
      assert.equal(µ.t('item', { n: 1 }), '1 przedmiot', "CLDR pl : 1 → 'one'")
      assert.equal(µ.t('item', { n: 2 }), '2 przedmioty', "CLDR pl : 2 → 'few'")
      assert.equal(µ.t('item', { n: 5 }), '5 przedmiotów', "CLDR pl : 5 → 'many'")
    })

    it("Intl.PluralRules absent → repli binaire n===1?'one':'other', SANS throw", function () {
      const originalPluralRules = Intl.PluralRules
      ;(Intl as any).PluralRules = undefined
      try {
        const µ = makeMu(baseData())
        assert.equal(µ.t('salut', { n: 1 }), '1 salut')
        assert.equal(µ.t('salut', { n: 0 }), '0 saluts', "repli binaire : n !== 1 → other (PAS 'one' CLDR)")
        assert.equal(µ.t('salut', { n: 3 }), '3 saluts')
      } finally {
        (Intl as any).PluralRules = originalPluralRules
      }
    })
  })

  describe('pluriel — clé zero explicite (façon Rails)', function () {
    it("n=0 + dico AVEC 'zero' (fr) → la clé zero l'emporte sur la catégorie CLDR", function () {
      const µ = makeMu(baseData({
        root: {
          fr: { articles: { zero: 'Aucun article', one: '%{n} article', other: '%{n} articles' } },
        },
      }))
      assert.equal(µ.t('articles', { n: 0 }), 'Aucun article')
    })

    it("n=0 + dico SANS 'zero' (fr) → comportement CLDR inchangé, catégorie 'one'", function () {
      const µ = makeMu(baseData({
        root: {
          fr: { articles: { one: '%{n} article', other: '%{n} articles' } },
        },
      }))
      assert.equal(µ.t('articles', { n: 0 }), '0 article', "CLDR fr : 0 → 'one', PAS de repli sur 'zero' (absente du dico)")
    })

    it("n=0 + dico AVEC 'zero' (en) → la clé zero l'emporte sur 'other' (CLDR en)", function () {
      const µ = makeMu(baseData({
        default: 'en',
        root: {
          en: { articles: { zero: 'No articles', one: '%{n} article', other: '%{n} articles' } },
        },
      }))
      assert.equal(µ.t('articles', { n: 0 }), 'No articles')
    })

    it("n=0 + dico SANS 'zero' (en) → comportement CLDR inchangé, catégorie 'other'", function () {
      const µ = makeMu(baseData({
        default: 'en',
        root: {
          en: { articles: { one: '%{n} article', other: '%{n} articles' } },
        },
      }))
      assert.equal(µ.t('articles', { n: 0 }), '0 articles', "CLDR en : 0 → 'other' (inchangé)")
    })

    it("n=1 + dico AVEC 'zero' → 'zero' ne joue qu'à n=0 exactement, catégorie 'one'", function () {
      const µ = makeMu(baseData({
        root: {
          fr: { articles: { zero: 'Aucun article', one: '%{n} article', other: '%{n} articles' } },
        },
      }))
      assert.equal(µ.t('articles', { n: 1 }), '1 article')
    })

    it("n=0.5 (fr) + dico AVEC 'zero' → 0.5 n'est pas 0, catégorie CLDR 'one' (décimaux fr)", function () {
      const µ = makeMu(baseData({
        root: {
          fr: { articles: { zero: 'Aucun article', one: '%{n} article', other: '%{n} articles' } },
        },
      }))
      assert.equal(µ.t('articles', { n: 0.5 }), '0.5 article')
    })
  })

  describe('modes de rendu (auto/key) pendant clé/fragment manquant', function () {
    it("mode 'auto' + dev=false → chaîne vide sur clé manquante", function () {
      const µ = makeMu(baseData({ dev: false }))
      assert.equal(µ.t('inconnue.cle'), '')
    })

    it("mode 'auto' + dev=true → '⟦clé⟧' sur clé manquante", function () {
      const µ = makeMu(baseData({ dev: true }))
      assert.equal(µ.t('inconnue.cle'), '⟦inconnue.cle⟧')
    })

    it("mode 'key' (override 3e argument) → '⟦clé⟧' MÊME en prod (dev=false)", function () {
      const µ = makeMu(baseData({ dev: false }))
      assert.equal(µ.t('inconnue.cle', undefined, 'key'), '⟦inconnue.cle⟧')
    })

    it('valeur non-chaîne après résolution (objet sans one/other) → placeholder', function () {
      const µ = makeMu(baseData({ dev: true, root: { fr: { objetBrut: { foo: 'bar' } } } }))
      assert.equal(µ.t('objetBrut'), '⟦objetBrut⟧')
    })
  })

  describe('µ._i18nData ABSENT : module inerte', function () {
    it('µ.t ne crashe jamais et rend le placeholder (mode auto = vide sans info dev)', function () {
      const µ = makeMu(undefined)
      assert.equal(µ.t('quoi.que.ce.soit'), '')
    })

    it("µ.t (mode 'key' explicite) reste '⟦clé⟧' même sans µ._i18nData", function () {
      const µ = makeMu(undefined)
      assert.equal(µ.t('x', undefined, 'key'), '⟦x⟧')
    })

    it('µ.i18n existe et ne crashe pas (mount/unmount no-op utile)', function () {
      const µ = makeMu(undefined)
      const comp = fakeComp('panier')
      assert.doesNotThrow(() => { µ.i18n._mjs_i18nMount(comp); µ.i18n._mjs_unmount(comp) })
    })
  })

  describe('_ensure : cache-singleton (dédoublonnage + cache chaud + échec)', function () {
    it('2 appels _ensure CONCURRENTS sur la même (langue, section) = 1 seul fetch', async function () {
      const µ = makeMu(baseData())
      let calls = 0
      ;(globalThis as any).fetch = async (_url: string) => {
        calls++
        return { ok: true, json: async () => ({ titre: 'Panier' }) }
      }
      const p1 = µ.i18n._ensure('fr', 'panier')
      const p2 = µ.i18n._ensure('fr', 'panier')
      assert.equal(p1, p2, 'même promesse retournée (dédoublonnage)')
      await p1
      assert.equal(calls, 1, 'un seul fetch malgré 2 appels concurrents')
    })

    it('cache CHAUD : un 2e _ensure APRÈS résolution ne re-fetch pas', async function () {
      const µ = makeMu(baseData())
      let calls = 0
      ;(globalThis as any).fetch = async () => { calls++; return { ok: true, json: async () => ({ titre: 'Panier' }) } }
      await µ.i18n._ensure('fr', 'panier')
      await µ.i18n._ensure('fr', 'panier')
      assert.equal(calls, 1)
    })

    it('échec fetch → entrée RETIRÉE du cache, un prochain montage retente', async function () {
      const µ = makeMu(baseData())
      let calls = 0
      ;(globalThis as any).fetch = async () => { calls++; return { ok: false, status: 404 } }
      await assert.rejects(() => µ.i18n._ensure('fr', 'panier'))
      // Nouvel appel : re-fetch (l'entrée précédente a été retirée du cache).
      await assert.rejects(() => µ.i18n._ensure('fr', 'panier'))
      assert.equal(calls, 2, 'échec retiré du cache → chaque appel suivant retente')
    })

    it('fragment résolu monte sous sa clé de section dans le dict de la langue', async function () {
      const µ = makeMu(baseData())
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ titre: 'Panier vide' }) })
      await µ.i18n._ensure('fr', 'panier')
      assert.equal(µ.t('panier.titre'), 'Panier vide')
    })
  })

  // Graine `#__mjs_i18n` (SSR → navigateur, cf. renderToString.ts/render-browser.ts) :
  // le boot relit la balise AVANT tout montage et peuple cache + dict, exactement comme le
  // chemin de succès du fetch de `_ensure` (mais sans notifier, personne n'est encore monté).
  describe('graine __mjs_i18n', function () {
    // CORRECTIF — `sections` est nichée PAR LANGUE puis par section
    // (`{lang:{section:…}}`), plus le plat `{section:…}` d'origine : cf. l'en-tête du bloc de
    // lecture dans mjs_i18n.ts.
    it('graine présente pour (lang, section) → _ensure se résout SANS fetch, µt lit la valeur semée', async function () {
      stubDocument({ __mjs_i18n: { textContent: JSON.stringify({ lang: 'fr', sections: { fr: { panier: { titre: 'Panier' } } } }) } })
      const µ = makeMu(baseData())
      let calls = 0
      ;(globalThis as any).fetch = async () => { calls++; return { ok: true, json: async () => ({ titre: 'ne doit jamais être fetché' }) } }
      const json = await µ.i18n._ensure('fr', 'panier')
      assert.equal(calls, 0, 'aucun fetch : la graine a déjà résolu le fragment')
      assert.deepEqual(json, { titre: 'Panier' })
      assert.equal(µ.t('panier.titre'), 'Panier')
    })

    // repro : la section n'existe qu'en langue par défaut (fr), la
    // graine sème sous SA propre langue (fr) alors que la page affichée est en `en` (`lang` racine
    // de la balise) — `_ensure('en', 'panier')` doit emprunter le MÊME repli que côté SSR
    // (renderToString.ts) et retrouver le fragment fr déjà semé, zéro fetch.
    it("graine sous la langue par DÉFAUT (repli, page affichée dans une AUTRE langue) → _ensure(lang affichée) résout SANS fetch, µt lit la valeur repliée", async function () {
      stubDocument({ __mjs_i18n: { textContent: JSON.stringify({ lang: 'en', sections: { fr: { panier: { titre: 'Panier' } } } }) } })
      const µ = makeMuHydrated('en', baseData({ sections: { fr: { panier: '/i18n/fr/panier.json' }, en: {} } }))
      let calls = 0
      ;(globalThis as any).fetch = async () => { calls++; return { ok: true, json: async () => ({ titre: 'ne doit jamais être fetché' }) } }
      const json = await µ.i18n._ensure('en', 'panier')
      assert.equal(calls, 0, "aucun fetch : le repli emprunte la promesse déjà résolue par la graine (langue par défaut fr)")
      assert.deepEqual(json, { titre: 'Panier' })
      assert.equal(µ.t('panier.titre'), 'Panier', "µt en langue affichée (en) rend la valeur repliée sur fr, seule langue traduite")
    })

    it('section absente de la graine (mais présente au manifest) → fetch normal (1 appel)', async function () {
      stubDocument({ __mjs_i18n: { textContent: JSON.stringify({ lang: 'fr', sections: { fr: { panier: { titre: 'Panier' } } } }) } })
      const µ = makeMu(baseData({ sections: { fr: { panier: '/i18n/fr/panier.json', autre: '/i18n/fr/autre.json' }, en: { panier: '/i18n/en/panier.json' } } }))
      let calls = 0
      ;(globalThis as any).fetch = async () => { calls++; return { ok: true, json: async () => ({ titre: 'Autre' }) } }
      await µ.i18n._ensure('fr', 'autre')
      assert.equal(calls, 1, 'section hors graine : le fetch normal reste déclenché')
    })

    it('graine malformée → ignorée SANS lever, le fetch marche encore (JSON invalide, puis sections sans lang)', async function () {
      // variante 1 — JSON invalide
      stubDocument({ __mjs_i18n: { textContent: '{' } })
      let µ1: any
      assert.doesNotThrow(() => { µ1 = makeMu(baseData()) }, 'JSON invalide : jamais fatal au chargement du module')
      let calls1 = 0
      ;(globalThis as any).fetch = async () => { calls1++; return { ok: true, json: async () => ({ titre: 'Panier' }) } }
      await µ1.i18n._ensure('fr', 'panier')
      assert.equal(calls1, 1, 'graine ignorée : fetch normal')

      // variante 2 — sections sans lang
      stubDocument({ __mjs_i18n: { textContent: JSON.stringify({ sections: {} }) } })
      let µ2: any
      assert.doesNotThrow(() => { µ2 = makeMu(baseData()) }, "sections sans lang : jamais fatal au chargement du module")
      let calls2 = 0
      ;(globalThis as any).fetch = async () => { calls2++; return { ok: true, json: async () => ({ titre: 'Panier' }) } }
      await µ2.i18n._ensure('fr', 'panier')
      assert.equal(calls2, 1, 'graine ignorée : fetch normal')
    })

    it('enregistrement SSR : µ._isServer = true → _ensure résout null et marque la section CONSULTÉE (µ._i18nUsed)', async function () {
      const µ = makeMu(baseData())
      µ._isServer = true
      const json = await µ.i18n._ensure('fr', 'panier')
      assert.equal(json, null)
      assert.equal(µ._i18nUsed['fr/panier'], true)
    })
  })

  // Repli de SECTION sur la langue par défaut (cas réel avec
  // `detect: true`, page dont seule la version fr existe : la page restait
  // définitivement vide en en). `sections.en` n'a PAS `panier` : `_ensure`
  // doit fetcher le fragment de `default` (fr) et NOTIFIER les composants en.
  describe('_ensure : repli de section sur la langue par défaut', function () {
    it('section absente en langue courante → fetch du fragment par défaut, servi ET affiché', async function () {
      const µ = makeMu(baseData({ sections: { fr: { panier: '/i18n/fr/panier.json' }, en: {} } }))
      const urls: string[] = []
      ;(globalThis as any).fetch = async (url: string) => { urls.push(url); return { ok: true, json: async () => ({ titre: 'Panier' }) } }
      const comp = fakeComp('panier')
      µ._storeSet('__mjsLang', 'en')
      µ.i18n._mjs_mountReal(comp)
      await µ.i18n._ensure('en', 'panier')
      assert.deepEqual(urls, ['/i18n/fr/panier.json'], 'un seul fetch, sur le chemin FRANÇAIS (default)')
      assert.equal(µ.t('panier.titre'), 'Panier', 'µt résout via le repli de clé existant, une fois le fragment fr en dict')
      assert.ok(comp._invalidations.includes('_awaits_'), 'le composant en a bien été notifié')
    })

    it('deuxième composant sur la même section → AUCUN fetch supplémentaire', async function () {
      const µ = makeMu(baseData({ sections: { fr: { panier: '/i18n/fr/panier.json' }, en: {} } }))
      let calls = 0
      ;(globalThis as any).fetch = async () => { calls++; return { ok: true, json: async () => ({ titre: 'Panier' }) } }
      await µ.i18n._ensure('en', 'panier')
      await µ.i18n._ensure('en', 'panier')
      await µ.i18n._ensure('fr', 'panier') // un composant fr sur la même section : même cache-singleton (default)
      assert.equal(calls, 1, 'toujours un seul fetch, le fragment default est déjà en cache')
    })

    it('section absente PARTOUT (courante ET default) → placeholder, aucun crash', async function () {
      const µ = makeMu(baseData({ sections: { fr: {}, en: {} } }))
      ;(globalThis as any).fetch = async () => { throw new Error('ne doit jamais être appelé') }
      const json = await µ.i18n._ensure('en', 'panier')
      assert.equal(json, null)
      assert.equal(µ.t('panier.titre', undefined, 'key'), '⟦panier.titre⟧')
    })

    it("mode 'wait' : le composant finit par s'afficher via le fragment de repli", async function () {
      const µ = makeMu(baseData({ sections: { fr: { panier: '/i18n/fr/panier.json' }, en: {} } }))
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ titre: 'Panier' }) })
      µ._storeSet('__mjsLang', 'en')
      const comp = fakeComp('panier', 'wait')
      const p = µ.i18n._mjs_mountReal(comp)
      assert.ok(p, 'promesse rendue en mode wait')
      const resolved = await p
      assert.notEqual(resolved, null, 'le composant se termine par le fragment de repli, pas par un échec muet')
    })

    it('bascule vers une langue partiellement traduite : aucun écran mixte (swap atomique quand même respecté)', async function () {
      const µ = makeMu(baseData({ sections: { fr: { panier: '/i18n/fr/panier.json' }, en: {} } }))
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ titre: 'Panier' }) })
      const comp = fakeComp('panier')
      µ.i18n._mjs_mountReal(comp) // monté en fr (racine embarquée, zéro fetch de section fr par défaut ici : pas monté avant bascule)
      comp._invalidations.length = 0
      µ._storeSet('__mjsLang', 'en') // bascule fr→en, en n'a pas panier → repli
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.ok(comp._invalidations.includes('_awaits_'), 'swap atomique déclenché une fois le repli résolu')
      assert.equal(µ._mjs_i18nSwapPending, false, 'le swap est bien retombé à false, pas resté bloqué en vol')
    })
  })

  describe('registre : montage/démontage + bascule de langue', function () {
    it("_mjs_i18nMount enregistre + déclenche _ensure (fragment absent) puis notifie ('_awaits_') à l'arrivée", async function () {
      const µ = makeMu(baseData())
      let resolveFetch: (v: any) => void
      const fetchPromise = new Promise((r) => { resolveFetch = r })
      ;(globalThis as any).fetch = async () => { await fetchPromise; return { ok: true, json: async () => ({ titre: 'Panier' }) } }

      const comp = fakeComp('panier')
      const p = µ.i18n._mjs_i18nMount(comp)
      assert.equal(p, null, 'pas de promesse retournée sans override wait')
      assert.equal(comp._invalidations.length, 0)
      resolveFetch!(null)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.deepEqual(comp._invalidations, ['_awaits_'], 'notifié à la résolution du fragment')
    })

    it("mode 'wait' : _mjs_i18nMount retourne la promesse du fragment quand il manque encore", async function () {
      const µ = makeMu(baseData())
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ titre: 'Panier' }) })
      const comp = fakeComp('panier', 'wait')
      const p = µ.i18n._mjs_i18nMount(comp)
      assert.ok(p && typeof p.then === 'function', "une promesse doit être retournée en mode 'wait'")
      await p
    })

    // Défaut : flash de ⟦tuto.chap_…⟧ pendant
    // ~60 ms — `placeholder: 'wait'` posé dans le CONFIG était honoré pour le rendu du
    // placeholder mais IGNORÉ pour le différé du 1er rendu : `_mjs_mountReal` ne consultait
    // que l'override par module. La doc (docs/29-i18n.md §6) annonce l'inverse.
    it("config `placeholder: 'wait'` SANS override par module : le 1er rendu attend quand même", async function () {
      const µ = makeMu(baseData({ placeholder: 'wait' }))
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ titre: 'Panier' }) })
      const comp = fakeComp('panier')                                     // aucun @i18nPlaceholder sur le module
      const p = µ.i18n._mjs_i18nMount(comp)
      assert.ok(p && typeof p.then === 'function', 'le mode du config doit suffire à différer')
      await p
    })

    // CONTRE-ÉPREUVE — sans `wait` au config, rien ne change : le 1er rendu part tout de suite.
    it("config `placeholder: 'auto'` SANS override : aucune promesse, le 1er rendu part tout de suite", async function () {
      const µ = makeMu(baseData({ placeholder: 'auto' }))
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ titre: 'Panier' }) })
      const comp = fakeComp('panier')
      assert.equal(µ.i18n._mjs_i18nMount(comp), null)
    })

    it("mode 'wait' : _mjs_i18nMount retourne null quand le fragment est DÉJÀ en cache", async function () {
      const µ = makeMu(baseData())
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ titre: 'Panier' }) })
      await µ.i18n._ensure('fr', 'panier')
      const comp = fakeComp('panier', 'wait')
      const p = µ.i18n._mjs_i18nMount(comp)
      assert.equal(p, null)
    })

    // `_mjs_connect(comp)` : ce que connectedCallback (mjs_element.ts) délègue au module à chaque
    // connexion — gel du premier rendu en mode 'wait' tant que le fragment manque, levé à son
    // arrivée. Composant factice étendu des champs de rendu que le gel touche ; chaque
    // invalidation note si le composant était encore gelé à cet instant.
    function connectComp(override: string | null) {
      const comp: any = { _mjs_i18n: ['panier', override], _mjs_is_mounted: true, _mjs_pending_full: true, _mjs_pending: new Set(['titre']), calls: [] as string[] }
      comp._mjs_invalidate = (k: string) => { comp.calls.push(k + (comp._mjs_i18n_hold ? ':gelé' : ':libre')) }
      return comp
    }

    it("_mjs_connect en mode 'wait', fragment absent : rendu programmé annulé et composant GELÉ, puis dégelé et rendu à l'arrivée", async function () {
      const µ = makeMu(baseData())
      let resolveFetch: (v: any) => void
      const fetchPromise = new Promise((r) => { resolveFetch = r })
      ;(globalThis as any).fetch = async () => { await fetchPromise; return { ok: true, json: async () => ({ titre: 'Panier' }) } }
      const comp = connectComp('wait')
      µ.i18n._mjs_connect(comp)
      assert.equal(comp._mjs_i18n_hold, true, 'gel posé tant que le fragment manque')
      assert.equal(comp._mjs_pending_full, false, 'le rendu vide déjà programmé est annulé')
      assert.equal(comp._mjs_pending.size, 0)
      assert.equal(comp.calls.length, 0)
      resolveFetch!(null)
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
      assert.equal(comp._mjs_i18n_hold, false, 'gel levé à l\'arrivée du fragment')
      assert.ok(comp.calls.includes('_awaits_:libre'), `un rendu complet demandé APRÈS le dégel : ${JSON.stringify(comp.calls)}`)
    })

    it("_mjs_connect en mode 'wait' : composant démonté avant l'arrivée du fragment → dégelé, mais aucun rendu", async function () {
      const µ = makeMu(baseData())
      let resolveFetch: (v: any) => void
      const fetchPromise = new Promise((r) => { resolveFetch = r })
      ;(globalThis as any).fetch = async () => { await fetchPromise; return { ok: true, json: async () => ({ titre: 'Panier' }) } }
      const comp = connectComp('wait')
      µ.i18n._mjs_connect(comp)
      comp._mjs_is_mounted = false
      µ.i18n._mjs_unmount(comp)
      resolveFetch!(null)
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
      assert.equal(comp._mjs_i18n_hold, false, 'jamais gelé à vie')
      assert.deepEqual(comp.calls, [])
    })

    it("_mjs_connect hors mode 'wait' : enregistré, jamais gelé, rendu programmé intact", async function () {
      const µ = makeMu(baseData())
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ titre: 'Panier' }) })
      const comp = connectComp(null)
      µ.i18n._mjs_connect(comp)
      assert.equal(comp._mjs_i18n_hold, undefined)
      assert.equal(comp._mjs_pending_full, true)
      assert.equal(comp._mjs_pending.size, 1)
      assert.equal(µ._mjs_i18nComps.has(comp), true, 'enregistré comme tout composant i18n')
    })

    it('_mjs_unmount désenregistre : plus notifié après démontage', async function () {
      const µ = makeMu(baseData())
      let resolveFetch: (v: any) => void
      const fetchPromise = new Promise((r) => { resolveFetch = r })
      ;(globalThis as any).fetch = async () => { await fetchPromise; return { ok: true, json: async () => ({ titre: 'Panier' }) } }
      const comp = fakeComp('panier')
      µ.i18n._mjs_i18nMount(comp)
      µ.i18n._mjs_unmount(comp)
      resolveFetch!(null)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.deepEqual(comp._invalidations, [], 'démonté avant résolution : aucune notification')
    })

    it("bascule de langue (swap atomique) : notifie TOUS les composants i18n enregistrés (clés racine) — APRÈS résolution complète, PAS immédiatement", async function () {
      const µ = makeMu(baseData())
      const compRacine = fakeComp(null)
      const compSection = fakeComp('panier')
      µ.i18n._mjs_i18nMount(compRacine)
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ titre: 'Panier' }) })
      µ.i18n._mjs_i18nMount(compSection)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      compRacine._invalidations.length = 0
      compSection._invalidations.length = 0

      µ._storeSet('__mjsLang', 'en')
      assert.equal(compRacine._invalidations.length, 0, 'AUCUNE invalidation immédiate (swap atomique, pas de placeholder intermédiaire)')
      assert.equal(compSection._invalidations.length, 0)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.ok(compRacine._invalidations.includes('_awaits_'))
      assert.ok(compSection._invalidations.includes('_awaits_'))
    })

    it('bascule de langue : re-fetch la section dans la NOUVELLE langue pour les composants montés', async function () {
      const µ = makeMu(baseData())
      const urls: string[] = []
      ;(globalThis as any).fetch = async (url: string) => { urls.push(url); return { ok: true, json: async () => ({ titre: url }) } }
      const comp = fakeComp('panier')
      µ.i18n._mjs_i18nMount(comp)
      await new Promise((r) => setTimeout(r, 0))
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.deepEqual(urls, ['/i18n/fr/panier.json', '/i18n/en/panier.json'])
    })
  })

  describe('bascule SANS placeholder intermédiaire (swap atomique)', function () {
    it("(a) aucun placeholder pendant le vol : texte ANCIEN affiché (racine ET section) jusqu'à résolution COMPLÈTE, puis texte CIBLE — swap ATOMIQUE des deux ensemble", async function () {
      const µ = makeMu(baseData())
      let resolveFetch: (v: any) => void
      let gate = new Promise((r) => { resolveFetch = r })
      ;(globalThis as any).fetch = async () => { await gate; return { ok: true, json: async () => ({ titre: 'Panier' }) } }
      const compRacine = fakeComp(null)
      const compSection = fakeComp('panier')
      µ.i18n._mjs_i18nMount(compRacine)
      µ.i18n._mjs_i18nMount(compSection)
      resolveFetch!(null)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      compRacine._invalidations.length = 0
      compSection._invalidations.length = 0

      gate = new Promise((r) => { resolveFetch = r })
      ;(globalThis as any).fetch = async () => { await gate; return { ok: true, json: async () => ({ titre: 'Cart' }) } }
      µ._storeSet('__mjsLang', 'en')
      // fetch EN vol : ancienne langue partout, aucune invalidation.
      assert.equal(µ.t('bonjour'), 'Bonjour', "racine : ancienne langue jusqu'à résolution complète")
      assert.equal(compRacine._invalidations.length, 0, 'aucune invalidation intermédiaire (pas de placeholder)')
      assert.equal(compSection._invalidations.length, 0)

      resolveFetch!(null)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(µ.t('bonjour'), 'Hello', 'racine bascule vers EN après résolution complète')
      assert.ok(compRacine._invalidations.includes('_awaits_'), 'swap atomique : racine invalidée')
      assert.ok(compSection._invalidations.includes('_awaits_'), 'swap atomique : section invalidée EN MÊME TEMPS')
    })

    it("(b) atomicité : 2 sections qui résolvent à des instants DIFFÉRENTS → aucun swap partiel (toutes deux invalidées EN MÊME TEMPS)", async function () {
      const µ = makeMu(baseData({
        sections: {
          fr: { panier: '/i18n/fr/panier.json', compte: '/i18n/fr/compte.json' },
          en: { panier: '/i18n/en/panier.json', compte: '/i18n/en/compte.json' },
        },
      }))
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ x: 1 }) })
      const compA = fakeComp('panier')
      const compB = fakeComp('compte')
      µ.i18n._mjs_i18nMount(compA)
      µ.i18n._mjs_i18nMount(compB)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      compA._invalidations.length = 0
      compB._invalidations.length = 0

      let resolveCompte: (v: any) => void
      const compteGate = new Promise((r) => { resolveCompte = r })
      ;(globalThis as any).fetch = async (url: string) => {
        if (url.indexOf('compte') !== -1) { await compteGate; return { ok: true, json: async () => ({ x: 2 }) } }
        return { ok: true, json: async () => ({ x: 2 }) }
      }
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      // 'panier' résolu, 'compte' encore en vol : AUCUNE invalidation (pas de swap partiel).
      assert.deepEqual(compA._invalidations, [])
      assert.deepEqual(compB._invalidations, [])

      resolveCompte!(null)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.ok(compA._invalidations.includes('_awaits_'))
      assert.ok(compB._invalidations.includes('_awaits_'))
    })

    it('(c) retour vers une langue déjà en cache : swap SANS aucun fetch', async function () {
      const µ = makeMu(baseData())
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ titre: 'Panier' }) })
      const comp = fakeComp('panier')
      µ.i18n._mjs_i18nMount(comp)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))

      let calls = 0
      ;(globalThis as any).fetch = async () => { calls++; return { ok: true, json: async () => ({ titre: 'X' }) } }
      comp._invalidations.length = 0
      µ._storeSet('__mjsLang', 'fr')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(calls, 0, 'AUCUN fetch : fr déjà entièrement en cache')
      assert.ok(comp._invalidations.includes('_awaits_'), 'swap immédiat malgré 0 fetch')
      assert.equal(µ.t('panier.titre'), 'Panier')
    })

    it("(d) échec fetch pendant la bascule → REVERT : langue affichée inchangée, µ._mjs_storeRaw.__mjsLang revenu à l'ancienne valeur", async function () {
      const µ = makeMu(baseData())
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ titre: 'Panier' }) })
      const comp = fakeComp('panier')
      µ.i18n._mjs_i18nMount(comp)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      comp._invalidations.length = 0

      ;(globalThis as any).fetch = async () => ({ ok: false, status: 404 })
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr', "REVERT : la clé store est revenue à l'ancienne langue")
      assert.equal(µ.t('panier.titre'), 'Panier', 'contenu affiché inchangé (jamais basculé vers en)')
    })

    it("(e) fr→en→fr rapide : seule la DERNIÈRE bascule gagne (générations) — la bascule périmée (en) ne s'affiche JAMAIS", async function () {
      const µ = makeMu(baseData())
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ titre: 'Panier' }) })
      const comp = fakeComp('panier')
      µ.i18n._mjs_i18nMount(comp)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))

      let resolveEn: (v: any) => void
      const enGate = new Promise((r) => { resolveEn = r })
      ;(globalThis as any).fetch = async () => { await enGate; return { ok: true, json: async () => ({ titre: 'Cart' }) } }
      µ._storeSet('__mjsLang', 'en') // génération 1, en vol (fetch gaté)
      µ._storeSet('__mjsLang', 'fr') // génération 2, retour vers fr (déjà en cache) — annule la 1
      resolveEn!(null) // la 1ère bascule (périmée) se résout APRÈS coup
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr')
      assert.equal(µ.t('panier.titre'), 'Panier', "jamais passé par en : la bascule périmée ne s'applique jamais")
    })

    it("(g) fragment TARDIF d'une langue périmée (bascule déjà COMPLÈTE entre-temps) : peuple le cache mais N'INVALIDE PLUS (garde de pertinence)", async function () {
      const µ = makeMu(baseData())
      const comp = fakeComp('panier', 'wait')

      let resolveFr: (v: any) => void
      const frGate = new Promise((r) => { resolveFr = r })
      ;(globalThis as any).fetch = (path: string) => {
        if (path.includes('/fr/')) { return frGate.then(() => ({ ok: true, json: async () => ({ resume: 'Résumé FR (lent)' }) })) }
        return Promise.resolve({ ok: true, json: async () => ({ resume: 'Summary EN' }) })
      }

      const waitPromise = µ.i18n._mjs_mountReal(comp) // mode 'wait', fetch fr EN VOL (jamais résolu tout de suite)
      µ._storeSet('__mjsLang', 'en') // bascule fr→en : fragment en RAPIDE, la bascule aboutit AVANT que fr ne résolve
      await new Promise((r) => setTimeout(r, 5))

      assert.equal(µ._mjs_i18nSwapPending, false, 'la bascule fr→en est déjà COMPLÈTE (fragment en résolu, atomique)')
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'en', 'langue affichée déjà "en"')
      const invalidationsBeforeLateFr = comp._invalidations.length

      resolveFr!(null) // le fragment fr, tardif, résout ENFIN — pour une langue qui n'est PLUS effective
      const waitResult = await waitPromise
      await new Promise((r) => setTimeout(r, 10))

      assert.deepEqual(waitResult, { resume: 'Résumé FR (lent)' }, "le composant 'wait' initial reçoit quand même son fragment (contrat _mjs_mountReal inchangé)")
      assert.equal(comp._invalidations.length, invalidationsBeforeLateFr, "AUCUNE invalidation supplémentaire déclenchée par le fragment fr tardif (garde de pertinence : lang !== langue effective)")
      assert.equal(µ.t('panier.resume'), 'Summary EN', "le composant continue d'afficher la langue EFFECTIVE (en), jamais fr")
      // le fragment tardif reste UTILE : peuplé dans le cache pour un futur retour vers fr, sans fetch supplémentaire.
      assert.deepEqual(µ._mjs_i18nDictOf('fr').panier, { resume: 'Résumé FR (lent)' }, 'le dict fr est quand même peuplé (cache toujours utile pour un futur retour)')
    })

    it('(f) premier chargement : placeholders/modes INCHANGÉS (non-régression, cf. suites ci-dessus « modes de rendu »)', function () {
      // Couvert par les describe 'modes de rendu (auto/key) pendant clé/fragment
      // manquant' et '_ensure : cache-singleton' plus haut, INCHANGÉS —
      // aucune bascule n'est en jeu au premier chargement (`µ._mjs_i18nSwapPending`
      // démarre à `false`, le watcher `__mjsLang` n'est enregistré qu'APRÈS la
      // pose du défaut, cf. mjs_i18n.ts `__i18nBoot`) : ce test n'est qu'un
      // marqueur documentaire, la couverture réelle est ailleurs dans ce fichier.
      const µ = makeMu(baseData({ dev: true }))
      assert.equal(µ.t('inconnue.cle'), '⟦inconnue.cle⟧')
    })
  })

  describe('init store : langue par défaut / SSR réhydratée', function () {
    it('µ._mjs_storeRaw.__mjsLang absent → posé au default de µ._i18nData (clé CACHÉE, non-énumérable)', function () {
      const µ = makeMu(baseData({ default: 'fr' }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr')
      assert.ok(!Object.prototype.hasOwnProperty.call(µ.store, '__mjsLang') || !Object.getOwnPropertyDescriptor(µ.store, '__mjsLang')!.enumerable, '__mjsLang absente de l\'énumération du store')
      assert.deepEqual(Object.keys(µ.store), [], "aucune clé applicative posée par le boot i18n — l'espace $$ reste 100% à l'app")
    })

    it('µ._mjs_storeRaw.__mjsLang DÉJÀ présent (SSR réhydratée) → respecté, pas écrasé', function () {
      const µ: any = { log() {}, warn() {}, error() {}, state(o: any) { return o } }
      new Function('µ', storeSrc)(µ)
      µ._mjs_storeRaw.__mjsLang = 'en'
      µ._i18nData = baseData({ default: 'fr' })
      new Function('µ', i18nSrc)(µ)
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'en', 'la valeur réhydratée avant le chargement du module i18n doit survivre')
    })
  })

  describe('persistance/détection de la langue initiale', function () {
    it('persist/detect ABSENTS de la config → comportement INCHANGÉ (défaut, non-régression)', function () {
      const µ = makeMu(baseData())
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr')
    })

    it('localStorage vide + detect off → langue par défaut', function () {
      stubLocalStorage()
      const µ = makeMu(baseData({ persist: true, detect: false }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr')
    })

    it('localStorage contient une langue valide + persist on → prioritaire (même avec detect on et navigator différent)', function () {
      stubLocalStorage({ __mjsLang: 'en' })
      stubNavigator('fr')
      const µ = makeMu(baseData({ persist: true, detect: true }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'en')
    })

    it('localStorage contient une langue INCONNUE (absente de root) → ignorée, repli sur le défaut', function () {
      stubLocalStorage({ __mjsLang: 'de' })
      const µ = makeMu(baseData({ persist: true, detect: false }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr')
    })

    it("navigator.language='en-US' + detect on, root a 'en' (pas 'en-US') → match par sous-tag", function () {
      stubNavigator('en-US')
      const µ = makeMu(baseData({ persist: false, detect: true }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'en')
    })

    it('bascule réussie + persist on → setItem appelé avec la nouvelle langue, APRÈS résolution du swap', async function () {
      const { setItemCalls } = stubLocalStorage()
      const µ = makeMu(baseData({ persist: true }))
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.deepEqual(setItemCalls, [['__mjsLang', 'en']])
    })

    it('persist OFF → setItem JAMAIS appelé, même après une bascule réussie', async function () {
      const { setItemCalls } = stubLocalStorage()
      const µ = makeMu(baseData({ persist: false }))
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.deepEqual(setItemCalls, [])
    })

    it('localStorage.getItem qui throw (sandbox/navigation privée) → boot ne crashe pas, repli sur le défaut', function () {
      stubThrowingLocalStorage()
      const µ = makeMu(baseData({ persist: true }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr')
    })

    it('localStorage.setItem qui throw (sandbox) → bascule ne crashe pas, langue quand même basculée', async function () {
      stubThrowingLocalStorage()
      const µ = makeMu(baseData({ persist: true }))
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'en', 'bascule quand même effective malgré le throw de setItem')
    })
  })

  describe('langue par URL ?lang= (urlParam)', function () {
    it('urlParam ON + ?lang=en valide → langue initiale = en, PRIORITAIRE sur persist (localStorage=fr)', function () {
      stubLocation('?lang=en')
      stubLocalStorage({ __mjsLang: 'fr' })
      const µ = makeMu(baseData({ urlParam: true, persist: true }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'en')
    })

    it('urlParam ON + ?lang=de INCONNUE (absente de root) → ignorée, repli sur le défaut', function () {
      stubLocation('?lang=de')
      const µ = makeMu(baseData({ urlParam: true }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr')
    })

    it('urlParam OFF + ?lang=en présent → IGNORÉ (opt-in strict, non-régression)', function () {
      stubLocation('?lang=en')
      const µ = makeMu(baseData({ urlParam: false }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr')
    })

    it('bascule vers une langue non-défaut + urlParam ON → replaceState pose ?lang=en', async function () {
      stubLocation('?lang=fr')
      const { calls } = stubHistory()
      const µ = makeMu(baseData({ urlParam: true }))
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(calls.length, 1)
      assert.equal(calls[0][2], '/?lang=en')
    })

    it('bascule vers la langue par DÉFAUT + urlParam ON → ?lang retiré (URL canonique propre)', async function () {
      stubLocation('?lang=en')
      const { calls } = stubHistory()
      const µ = makeMu(baseData({ urlParam: true, default: 'fr' }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'en', 'initialisée à en depuis l\'URL')
      µ._storeSet('__mjsLang', 'fr')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(calls[calls.length - 1][2], '/')
    })

    it('urlParam OFF → replaceState JAMAIS appelé, même après bascule', async function () {
      stubLocation('?lang=fr')
      const { calls } = stubHistory()
      const µ = makeMu(baseData({ urlParam: false }))
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.deepEqual(calls, [])
    })

    it('history.replaceState qui throw (sandbox) → bascule ne crashe pas, langue quand même basculée', async function () {
      stubLocation('?lang=fr')
      ;(globalThis as any).history = { state: null, replaceState() { throw new Error('SecurityError : history refusé') } }
      const µ = makeMu(baseData({ urlParam: true }))
      µ._storeSet('__mjsLang', 'en')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'en')
    })
  })

  // RÉGRESSION — sur une page SSR, l'hydratation
  // (`mjs_store_globals.ts`) pré-remplit `__mjsLang` AVANT le boot i18n, donc la
  // garde `=== undefined` du boot sautait et `?lang=` n'était JAMAIS relu : un
  // rechargement de `?lang=en` retombait en défaut. L'override SSR du boot doit
  // faire PRIMER l'URL sur la valeur hydratée. Ces cas simulent EXACTEMENT ça.
  describe('langue par URL — page SSR déjà hydratée (override du boot)', function () {
    it('SSR hydraté fr + urlParam ON + ?lang=en → l\'URL PRIME, bascule à en (le bug corrigé)', function () {
      stubLocation('?lang=en')
      const µ = makeMuHydrated('fr', baseData({ urlParam: true }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'en')
    })

    it('SSR hydraté fr + urlParam ON + PAS de ?lang= → valeur hydratée respectée (fr), aucun reset au défaut', function () {
      stubLocation('?x=1')
      const µ = makeMuHydrated('fr', baseData({ urlParam: true }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr')
    })

    it('SSR hydraté fr + urlParam OFF + ?lang=en présent → IGNORÉ (opt-in strict), reste fr', function () {
      stubLocation('?lang=en')
      const µ = makeMuHydrated('fr', baseData({ urlParam: false }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr')
    })

    it('SSR hydraté en + urlParam ON + ?lang=en (identique) → reste en, aucun changement parasite', function () {
      stubLocation('?lang=en')
      const µ = makeMuHydrated('en', baseData({ urlParam: true, default: 'fr' }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'en')
    })

    it('SSR hydraté fr + urlParam ON + ?lang=de INCONNUE → ignorée, reste fr (hydratation respectée)', function () {
      stubLocation('?lang=de')
      const µ = makeMuHydrated('fr', baseData({ urlParam: true }))
      assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr')
    })
  })
})
