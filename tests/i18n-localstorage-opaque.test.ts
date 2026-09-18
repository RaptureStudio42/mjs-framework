// tests/i18n-localstorage-opaque.test.ts :
// `typeof localStorage` évalué HORS du `try`, à 2 sites de mjs_i18n.ts (détection initiale
// synchrone au boot `:447`, persistance après bascule `:559`) — sur une origine opaque
// (sandbox iframe, file://, data:), `localStorage` est un ACCESSEUR sur `window` : `typeof x`
// invoque le getter pour résoudre la référence, il lève AUSSI, avant même d'atteindre le `try`
// censé protéger `.getItem()`/`.setItem()`. Règle retenue : « garde DANS le try, jamais
// au top-level d'un module runtime ».
//
// Chargement du fichier SOURCE brut, même patron que tests/i18n-runtime.test.ts
// (`new Function('µ', src)(µ)`, mjs_store_globals.ts PUIS mjs_i18n.ts, ordre canonique du
// bundler — `src/runtime/**/*.ts` est HORS tsconfig, JS pur transpilé à la main).
//
// Note méthode — happy-dom NE reproduit PAS ce cas : sondé avant d'écrire ce test
// (`Object.defineProperty(window, 'localStorage', {get(){throw…}})` puis `window.eval(...)`) —
// le contexte `vm` de Node AVALE l'exception du getter posé sur le sandbox et rend la propriété
// simplement absente (`ReferenceError: localStorage is not defined`), jamais le vrai
// `SecurityError` qu'un navigateur lève. D'où l'accesseur posé directement sur `globalThis`,
// exactement comme le fait déjà `i18n-runtime.test.ts` pour les stubs `getItem`/`setItem` qui
// lèvent (`stubThrowingLocalStorage`) — ici l'IDENTIFIANT lui-même lève, pas seulement ses méthodes.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const storeSrc = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_store_globals.ts'), 'utf-8')
const i18nSrc  = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_i18n.ts'), 'utf-8')

const __originalLocalStorageDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const __originalHistory          = (globalThis as any).history
const __originalLocation         = (globalThis as any).location

// localStorage ACCESSEUR qui lève, comme sur une origine opaque — `typeof x` invoque le getter
// pour résoudre la référence : il lève AUSSI, pas seulement un éventuel `.getItem()`.
function stubOpaqueLocalStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError : accès localStorage refusé (origine opaque)') },
  })
}

function restoreLocalStorage(): void {
  if(__originalLocalStorageDesc === undefined) { delete (globalThis as any).localStorage }
  else { Object.defineProperty(globalThis, 'localStorage', __originalLocalStorageDesc) }
}

function stubHistoryAndLocation(): Array<[any, string, string]> {
  const calls: Array<[any, string, string]> = []
  ;(globalThis as any).location = { search: '', href: 'https://mjs.test/', pathname: '/', hash: '' }
  ;(globalThis as any).history = {
    state: { k: 1 },
    replaceState(s: any, t: string, u: string) { calls.push([s, t, u]); (globalThis as any).location.href = 'https://mjs.test'+ u },
  }
  return calls
}

function baseData(overrides: any = {}) {
  return {
    dev: false,
    default: 'fr',
    placeholder: 'auto',
    root: { fr: { bonjour: 'Bonjour' }, en: { bonjour: 'Hello' } },
    sections: { fr: {}, en: {} },
    ...overrides,
  }
}

// fabrique un `µ` frais (store + i18n), `data` posé AVANT le chargement de mjs_i18n.ts —
// exécute donc `__i18nBoot()` (top-level, fin de fichier) SYNCHRONEMENT, ici même.
// `root`/`sections` sont semés langue par langue (registre `µ._i18nLangs`, alimenté au
// navigateur par le fichier de langue) : le manifeste, lui, ne porte que les réglages.
function makeMu(data: any) {
  const µ: any = { log() {}, warn() {}, error() {}, state(o: any) { return o } }
  new Function('µ', storeSrc)(µ)
  const { root = {}, sections = {}, ...reglages } = data
  µ._i18nLangs = Object.fromEntries(Object.keys(root).map(l => [l, { root: root[l], sections: sections[l] ?? {} }]))
  µ._i18nData = { prefix: '/i18n', langs: Object.keys(root).sort(), files: {}, ...reglages }
  new Function('µ', i18nSrc)(µ)
  return µ
}

describe('mjs_i18n — typeof localStorage DANS le try, origine opaque (accesseur qui lève)', function() {
  let unhandled: any[] = []
  function onUnhandled(err: any) { unhandled.push(err) }

  beforeEach(function() {
    unhandled = []
    process.on('unhandledRejection', onUnhandled)
  })

  afterEach(function() {
    process.off('unhandledRejection', onUnhandled)
    restoreLocalStorage()
    if(__originalHistory === undefined) { delete (globalThis as any).history } else { (globalThis as any).history = __originalHistory }
    if(__originalLocation === undefined) { delete (globalThis as any).location } else { (globalThis as any).location = __originalLocation }
  })

  it('boot synchrone (persist:true, localStorage accesseur qui lève) : le chargement du module ne crashe pas, langue = défaut', function() {
    stubOpaqueLocalStorage()
    let bootErr: any = null
    let µ: any = null
    try { µ = makeMu(baseData({ persist: true })) } catch(e) { bootErr = e }
    assert.equal(bootErr, null, `le chargement du module ne doit pas lever (obtenu : ${bootErr && bootErr.message})`)
    assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr', 'persist inactif (accès impossible) → repli sur le défaut')
  })

  it("persistance après bascule (persist:true + urlParam:true, localStorage accesseur qui lève) : la bascule va au bout, l'URL est mise à jour, aucune exception ne fuit", async function() {
    const calls = stubHistoryAndLocation()
    stubOpaqueLocalStorage()
    const µ = makeMu(baseData({ persist: true, urlParam: true }))
    µ._storeSet('__mjsLang', 'en')
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(µ._mjs_storeRaw.__mjsLang, 'en', 'bascule quand même effective')
    assert.equal(calls.length, 1, "AVANT le fix : `history.replaceState` n'est jamais atteint — le typeof localStorage non gardé fait planter le reste du .then() en unhandled rejection silencieuse, la mise à jour de l'URL n'a jamais lieu")
    assert.equal(unhandled.length, 0, 'aucune exception non rattrapée ne doit fuiter (unhandledRejection)')
  })
})
