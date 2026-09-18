// Racine i18n perdue après une graine SSR (mjs_i18n.ts). Prouvé Chromium
// sur la page `/` (langue fr) : toutes les clés du dictionnaire RACINE
// (`µt('landing.demo_title')`) rendaient le placeholder `⟦landing.demo_title⟧`, alors que
// `µ._i18nData.root.fr` était bien présent — l'anglais, lui, marchait. Cause : le lecteur de
// graine SSR `#__mjs_i18n` (bloc `try` au CHARGEMENT du module) appelle
// `µ._mjs_i18nDictOf(lang)[section] = data` AVANT que le manifest ne pose `µ._i18nData` réel (spec
// ES modules : `import {µ} from core; µ._i18nData = {...}` — le core, mjs_i18n.ts compris,
// s'exécute intégralement AVANT cette ligne). À cet instant, `µ._i18nData` vaut encore
// `__i18nInertFallback` (`root: {}`) : `_mjs_i18nDictOf` crée alors un dict SANS racine et le met en
// cache pour toujours — la fusion racine n'a lieu qu'À LA CRÉATION du dict (cf. mjs_i18n.ts,
// `_mjs_i18nDictOf`, et le bloc `try` de lecture de la graine, ~l.195-224). Repro par primitives dans
// le MÊME ordre que le bundle (chargement du fichier SOURCE brut, calqué sur tests/i18n-runtime
// .test.ts) : `new Function` = le chargement du core, `µ._i18nData = data` juste après = le
// manifest, dans le MÊME tick synchrone (aucun await entre les deux, comme en production).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE = join(__dirname, '..', 'src', 'runtime', 'mjs_store_globals.ts')
const I18N = join(__dirname, '..', 'src', 'runtime', 'mjs_i18n.ts')
const storeSrc = readFileSync(STORE, 'utf-8')
const i18nSrc = readFileSync(I18N, 'utf-8')

// Stub document minimal (getElementById pour la graine `#__mjs_i18n` ; le reste est requis par
// mjs_store_globals.ts au chargement — même patron que tests/i18n-runtime.test.ts).
function stubDocument(elements: Record<string, { textContent: string }>) {
  return {
    readyState: 'complete',
    hidden: false,
    getElementById(id: string) { return Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null },
    addEventListener() {},
    removeEventListener() {},
  }
}

const __originalDocument = (globalThis as any).document

// Fabrique un `µ` en reproduisant l'ORDRE RÉEL du bundle : la graine SSR se lit PENDANT le
// chargement du core (`µ._i18nData` encore absent/inerte), `data` n'est posé qu'APRÈS — jamais
// avant, contrairement à `makeMu()` de tests/i18n-runtime.test.ts (qui couvre l'autre scénario,
// `µ._i18nData` déjà réel avant le chargement du module).
function makeMuSeedBeforeData(seedElements: Record<string, { textContent: string }>, data: any) {
  const µ: any = { log() {}, warn() {}, error() {}, state(o: any) { return o } }
  ;(globalThis as any).document = stubDocument(seedElements)
  new Function('µ', storeSrc)(µ)
  new Function('µ', i18nSrc)(µ) // µ._i18nData ABSENT ici → __i18nInertFallback : la graine se sème SANS racine
  const { root = {}, sections = {}, ...reglages } = data
  µ._i18nData = { prefix: '/i18n', langs: Object.keys(root).sort(), files: {}, ...reglages } // le manifest, juste après, MÊME tick synchrone — comme en production
  // puis le FICHIER DE LANGUE (dictionnaire racine + table des sections), qui arrive au
  // navigateur par import une fois la langue décidée : c'est LUI qui porte la racine
  // dont la graine, semée trop tôt, doit hériter.
  for (const lang of Object.keys(root)) { µ._i18nLang(lang, { root: root[lang], sections: sections[lang] ?? {} }) }
  return µ
}

describe('i18n — racine après une graine SSR posée AVANT µ._i18nData réel', function () {
  afterEach(function () {
    if (__originalDocument === undefined) { delete (globalThis as any).document } else { (globalThis as any).document = __originalDocument }
  })

  it('graine `#__mjs_i18n` lue avant les données réelles : la section semée reste servie ET les clés racine redeviennent résolues après boot', async function () {
    const µ = makeMuSeedBeforeData(
      { __mjs_i18n: { textContent: JSON.stringify({ lang: 'fr', sections: { fr: { sec: { p_1: 'Bonjour' } } } }) } },
      { dev: true, default: 'fr', placeholder: 'wait', root: { fr: { landing: { titre: 'Accueil' } } }, sections: {} },
    )
    await new Promise((r) => setTimeout(r, 0)) // laisse tourner __i18nBoot (queueMicrotask posé pendant le chargement du core, avant la pose de µ._i18nData ci-dessus)
    assert.equal(µ.t('sec.p_1'), 'Bonjour', 'la graine SSR reste servie (non-régression)')
    assert.equal(µ.t('landing.titre'), 'Accueil', "clé racine : ne doit plus rendre le placeholder ⟦landing.titre⟧")
  })
})
