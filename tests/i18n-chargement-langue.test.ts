// i18n runtime — DÉMARRAGE AVEC CHARGEMENT DU FICHIER DE LANGUE.
//
// Les dictionnaires ne sont plus dans le manifeste : la langue est d'abord DÉCIDÉE
// (`langs`, `?lang=`, localStorage, navigateur, défaut), puis son fichier
// (`files[langue]`, émis par le bundler) est importé, et seulement ENSUITE le
// démarrage habituel a lieu. Les composants montés pendant cette attente passent par
// la file existante (`_mjs_i18nPendingMounts`) : mode 'wait' → premier rendu après
// l'arrivée, 'auto'/'key' → placeholder puis réinvalidation.
//
// Le fichier de la langue par DÉFAUT est chargé en même temps quand la langue affichée
// n'est pas elle : c'est lui qui porte les replis de clé et de section (une traduction
// incomplète doit continuer de retomber sur le défaut, comme avant).
//
// Même patron que tests/i18n-runtime.test.ts : sources runtime chargées telles quelles
// (`new Function('µ', src)(µ)`), `µ._i18nImport` (crochet du chargement de langue) stubé
// pour servir des fichiers en mémoire — aucun ESM réel ici.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const storeSrc = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_store_globals.ts'), 'utf-8')
const i18nSrc = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_i18n.ts'), 'utf-8')

const __originalFetch = (globalThis as any).fetch
const __originalLocation = (globalThis as any).location
const __originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

// Manifeste ALLÉGÉ tel que le bundler l'émet (aucun dictionnaire ici).
function baseData(overrides: any = {}) {
  return {
    dev: false,
    default: 'fr',
    placeholder: 'auto',
    persist: false,
    detect: false,
    urlParam: false,
    prefix: '/assets/mjs/i18n',
    langs: ['en', 'fr'],
    files: { en: '/assets/mjs/mjs_i18n-en-11111111.js', fr: '/assets/mjs/mjs_i18n-fr-22222222.js' },
    ...overrides,
  }
}

// Fichiers de langue servis par le crochet d'import (contenu = export par défaut).
const FICHIERS: Record<string, any> = {
  fr: { root: { bonjour: 'Bonjour', seulement_fr: 'Que du français' }, sections: { panier: 'panier-fr' } },
  en: { root: { bonjour: 'Hello' }, sections: { panier: 'panier-en' } },
}

function fakeComp(section: string | null, override: string | null = null) {
  const invalidations: string[] = []
  return {
    _mjs_i18n: [section, override],
    _mjs_invalidate(k: string) { invalidations.push(k) },
    _invalidations: invalidations,
  }
}

/** `µ` frais (store + i18n) avec le crochet d'import stubé — `charges` relève l'ordre
 *  RÉEL des langues demandées, `absents` liste les langues dont le fichier échoue (404). */
function makeMu(data: any, opts: { fichiers?: Record<string, any>; absents?: string[] } = {}) {
  const fichiers = opts.fichiers ?? FICHIERS
  const absents = opts.absents ?? []
  const µ: any = { log() {}, warn() {}, error() {}, state(o: any) { return o } }
  const erreurs: string[] = []
  µ.error = (m: string) => { erreurs.push(String(m)) }
  new Function('µ', storeSrc)(µ)
  µ._i18nData = data
  const charges: string[] = []
  µ._i18nImport = function (url: string) {
    const lang = Object.keys(data.files).find((l: string) => data.files[l] === url)
    charges.push(String(lang))
    if (!lang || absents.indexOf(lang) !== -1 || !fichiers[lang]) { return Promise.reject(new Error('HTTP 404 sur ' + url)) }
    return Promise.resolve({ default: fichiers[lang] })
  }
  new Function('µ', i18nSrc)(µ)
  return { µ, charges, erreurs }
}

const tick = () => new Promise(r => setTimeout(r, 0))

describe('i18n runtime — chargement du fichier de langue au démarrage', function () {
  afterEach(function () {
    (globalThis as any).fetch = __originalFetch
    if (__originalLocation === undefined) { delete (globalThis as any).location } else { (globalThis as any).location = __originalLocation }
    if (__originalNavigatorDesc === undefined) { delete (globalThis as any).navigator } else { Object.defineProperty(globalThis, 'navigator', __originalNavigatorDesc) }
  })

  it('le démarrage attend le fichier de la langue décidée (rien de résolu avant)', async function () {
    const { µ, charges } = makeMu(baseData())
    assert.equal(µ._mjs_i18nBooted, undefined, 'aucun démarrage tant que le fichier n\'est pas là')
    assert.deepEqual(charges, ['fr'], 'seule la langue décidée est demandée (elle est aussi le défaut)')
    await tick()
    assert.equal(µ._mjs_i18nBooted, true, 'démarrage une fois le fichier arrivé')
    assert.equal(µ.t('bonjour'), 'Bonjour')
  })

  it('une seule langue téléchargée quand la langue affichée EST le défaut', async function () {
    const { µ, charges } = makeMu(baseData({ langs: ['de', 'en', 'fr'], files: { de: '/de.js', en: '/en.js', fr: '/fr.js' } }), {
      fichiers: { ...FICHIERS, de: { root: { bonjour: 'Hallo' }, sections: {} } },
    })
    await tick()
    assert.deepEqual(charges, ['fr'], 'ni « de » ni « en » ne doivent être téléchargés')
    assert.equal(µ.t('bonjour'), 'Bonjour')
  })

  it("placeholder 'wait' : le premier rendu attend l'arrivée du fichier, puis rend le vrai texte", async function () {
    const { µ } = makeMu(baseData({ placeholder: 'wait' }))
    const comp: any = fakeComp(null)
    const attente = µ.i18n._mjs_i18nMount(comp)
    assert.equal(typeof attente.then, 'function', 'mode wait avant démarrage : une promesse d\'attente est rendue')
    assert.equal(µ.t('bonjour'), '', 'avant l\'arrivée : placeholder (prod = vide)')
    await attente
    assert.equal(µ.t('bonjour'), 'Bonjour', 'après l\'arrivée : texte réel')
  })

  it("placeholder 'auto' : rendu avec le placeholder, puis réinvalidation à l'arrivée", async function () {
    const { µ } = makeMu(baseData({ placeholder: 'auto' }))
    const comp: any = fakeComp(null)
    assert.equal(µ.i18n._mjs_i18nMount(comp), null, 'mode auto : aucun rendu différé')
    assert.deepEqual(comp._invalidations, [], 'rien tant que le fichier n\'est pas là')
    await tick()
    assert.deepEqual(comp._invalidations, ['_awaits_'], 'le composant rendu en placeholder est réinvalidé à l\'arrivée')
    assert.equal(µ.t('bonjour'), 'Bonjour')
  })

  it('?lang=en : langue validée par `langs`, fichier anglais ET fichier par défaut chargés', async function () {
    ;(globalThis as any).location = { search: '?lang=en', href: 'https://mjs.test/?lang=en', pathname: '/', hash: '' }
    const { µ, charges } = makeMu(baseData({ urlParam: true }))
    await tick()
    assert.deepEqual(charges.sort(), ['en', 'fr'], 'langue affichée + défaut (porteur des replis)')
    assert.equal(µ._mjs_storeRaw.__mjsLang, 'en')
    assert.equal(µ.t('bonjour'), 'Hello')
    assert.equal(µ.t('seulement_fr'), 'Que du français', 'repli de clé sur le défaut : son fichier est là')
  })

  it('?lang=xx inconnue de `langs` : ignorée, défaut affiché', async function () {
    ;(globalThis as any).location = { search: '?lang=xx', href: 'https://mjs.test/?lang=xx', pathname: '/', hash: '' }
    const { µ, charges } = makeMu(baseData({ urlParam: true }))
    await tick()
    assert.deepEqual(charges, ['fr'])
    assert.equal(µ._mjs_storeRaw.__mjsLang, 'fr')
  })

  it('bascule à chaud fr → en : le fichier anglais est chargé à la demande, puis la bascule aboutit', async function () {
    const { µ, charges } = makeMu(baseData())
    await tick()
    assert.deepEqual(charges, ['fr'])
    µ._storeSet('__mjsLang', 'en')
    assert.equal(µ.t('bonjour'), 'Bonjour', 'pendant la bascule : ancienne langue affichée (jamais de placeholder)')
    await tick()
    await tick()
    assert.deepEqual(charges, ['fr', 'en'], 'le fichier anglais n\'est demandé qu\'au moment de la bascule')
    assert.equal(µ.t('bonjour'), 'Hello', 'bascule aboutie')
  })

  it('fichier de langue en 404 : avertissement, démarrage quand même, textes du défaut', async function () {
    ;(globalThis as any).location = { search: '?lang=en', href: 'https://mjs.test/?lang=en', pathname: '/', hash: '' }
    const { µ, erreurs } = makeMu(baseData({ urlParam: true }), { absents: ['en'] })
    await tick()
    await tick()
    assert.equal(µ._mjs_i18nBooted, true, 'un fichier manquant ne doit jamais geler le démarrage')
    assert.equal(erreurs.some(m => m.includes('en')), true, `l'échec doit être crié : ${erreurs.join(' | ')}`)
    assert.equal(µ.t('bonjour'), 'Bonjour', 'repli sur la langue par défaut, dont le fichier est là')
  })

  it('les DEUX fichiers en 404 : démarrage quand même, tout en placeholder', async function () {
    const { µ } = makeMu(baseData(), { absents: ['fr', 'en'] })
    await tick()
    await tick()
    assert.equal(µ._mjs_i18nBooted, true)
    assert.equal(µ.t('bonjour'), '', 'aucune donnée : placeholder, jamais un plantage')
  })

  it('URL de fragment de section reconstituée à partir du préfixe et du nom compact', async function () {
    const vues: string[] = []
    ;(globalThis as any).fetch = async (url: string) => {
      vues.push(url)
      return { ok: true, status: 200, json: async () => ({ resume: 'Résumé' }) }
    }
    const { µ } = makeMu(baseData())
    await tick()
    await µ.i18n._ensure('fr', 'panier')
    assert.deepEqual(vues, ['/assets/mjs/i18n/fr/panier-fr.json'], 'préfixe + langue + nom compact + .json')
    assert.equal(µ.t('panier.resume'), 'Résumé')
  })

  it('rendu serveur : langues semées par `µ._i18nLang`, aucun import déclenché', async function () {
    const { µ, charges } = makeMu(baseData(), { absents: ['fr', 'en'] })
    // le harnais a déjà tenté un chargement (données absentes) — on repart d'un µ neuf
    const µ2: any = { log() {}, warn() {}, error() {}, state(o: any) { return o } }
    new Function('µ', storeSrc)(µ2)
    µ2._i18nData = baseData()
    µ2._i18nLangs = { fr: FICHIERS.fr }
    µ2._i18nImport = () => { throw new Error('aucun import ne doit avoir lieu au rendu serveur') }
    new Function('µ', i18nSrc)(µ2)
    assert.equal(µ2._mjs_i18nBooted, true, 'démarrage SYNCHRONE quand la langue est déjà semée')
    assert.equal(µ2.t('bonjour'), 'Bonjour')
    assert.equal(charges.length > 0, true, `témoin du harnais : ${charges.join(',')}`)
    assert.equal(µ._mjs_i18nBooted === true || µ._mjs_i18nBooted === undefined, true)
  })
})
