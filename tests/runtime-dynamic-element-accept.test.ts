// 4 correctifs runtime. Volet
// RUNTIME complet ; le volet compilateur (attribut `accept` sur <@element>/<@module> côté
// macros.ts + docs) suit séparément.
//   mjs_runes.ts µ._updDynEl/µ._updModule : le pool de balises refusées SANS acceptation
//            explicite s'ÉLARGIT (`script` seul → `µ._mjs_dynTagsRefuses`, 8 balises : script, iframe,
//            object, embed, base, link, meta, style). Nouveau 4e argument `accept` (tableau de
//            noms, insensible à la casse) : lève l'interdit balise par balise, `script` compris.
//            Signatures existantes à 3 arguments inchangées.
//   mjs_easing.ts µ.easing.resolve : une chaîne d'easing INCONNUE ('bounceOut', faute de
//            frappe) retombait sur cubicOut en silence. Repli cubicOut INCHANGÉ ; nouveauté :
//            avertissement en mode µ.debug SEULEMENT (pas d'acceptation des noms µ.easing.* en
//            chaîne — décision explicite).
//   mjs_easing.ts _runSharedTransition (l.536) / _mjs_runTransition (l.823) :
//            `Math.max(1, NaN) === NaN` — steps NaN/'abc' (non fini/non numérique) traversait le
//            plancher SANS être clampé → boucle jamais exécutée → keyframes VIDES. Correctif :
//            absent → 60 (défaut) ; fini < 1 (0, négatif) → 1 (plancher) ; non fini/non numérique
//            → 60 (une chaîne farfelue n'est pas un pas très petit).
//   mjs_element.ts _mjs_wrapDeep, trap `setPrototypeOf` : message copié à tort du store
//            (mjs_store.ts) — corrigé en « état » (c'est l'état RÉACTIF d'un COMPOSANT, pas le
//            store global).
//
// Harnais calqué sur tests/runtime-dynamic-tag-script-refused.test.ts (mjs_runes.ts brut + happy-dom,
// `_shadow` factice = simple <div> conteneur) et tests/runtime-easing-vt-guards.test.ts (
// mjs_easing.ts brut + happy-dom, capture des keyframes via mock `node.animate`/
// `µ.anim._mjs_acquireKeyframes` ; sandbox `µ.Element` pour `_mjs_wrapDeep`). Aucune résolution de
// module (comme en production, bundler/index.ts::bundleRuntime concatène ces fichiers bruts).
// Piège connu : Mocha × happy-dom fige la suite sans message si un NŒUD DOM est
// passé à assert.equal/deepEqual — on n'assertionne ici que booléens/nombres/chaînes.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))
// _updDynEl/_updModule vivent désormais dans mjs_dynamic.ts (DÉTACHÉ de mjs_runes.ts, cf.
// bundler/index.ts scanRuntimeFeatures) — concaténé juste après, même esprit que bundleRuntime().
const runesSrc   = readFileSync(join(__dirname, '../src/runtime/mjs_runes.ts'), 'utf8')
const dynamicSrc = readFileSync(join(__dirname, '../src/runtime/mjs_dynamic.ts'), 'utf8')
const easingSrc  = readFileSync(join(__dirname, '../src/runtime/mjs_easing.ts'), 'utf8')
const elemSrc    = readFileSync(join(__dirname, '../src/runtime/mjs_element.ts'), 'utf8')
const initSrc    = readFileSync(join(__dirname, '../src/runtime/mjs_init.ts'), 'utf8')

// Beaucoup de `it()` dans ce fichier (pool × accept, matrice de steps) instancient chacun leur
// propre `Window` happy-dom — sans fermeture, la mémoire s'accumule sur tout le fichier jusqu'à
// épuiser le tas (OOM constaté à l'exécution). Convention déjà en usage ailleurs
// (tests/core-field.test.ts, tests/core-toggles.test.ts) : `window.close?.()`, ici centralisé
// dans un seul `afterEach` plutôt que répété dans chaque test.
const __windows: any[] = []
afterEach(() => { __windows.splice(0).forEach((w) => { try { w.close?.() } catch (_e) { /* ignore */ } }) })

// ============================================================================
// mjs_dynamic.ts µ._updDynEl / µ._updModule : pool de balises refusées + `accept`
// ============================================================================

function makeRunes(): { µ: any; document: any; warnCalls: any[][] } {
  const window: any = new Window({ url: 'http://localhost/' })
  __windows.push(window)
  const document: any = window.document
  const warnCalls: any[][] = []
  const µ: any = { log() {}, error() {}, warn(...args: any[]) { warnCalls.push(args) } }
  new Function('µ', 'document', runesSrc)(µ, document)
  new Function('µ', 'document', dynamicSrc)(µ, document)
  return { µ, document, warnCalls }
}

// `_shadow` factice : un simple conteneur connecté au document (pas un vrai ShadowRoot de
// composant) — `_updDynEl`/`_updModule` n'utilisent que `querySelector`/`replaceWith`.
function makeShadow(document: any, html: string): any {
  const shadow = document.createElement('div')
  shadow.innerHTML = html
  document.body.appendChild(shadow)
  return shadow
}

const POOL = ['script', 'iframe', 'object', 'embed', 'base', 'link', 'meta', 'style']

describe('<@element>/<@module> : pool de balises refusées élargi (mjs_runes.ts)', () => {
  describe('µ._updDynEl (<@element $tag>)', () => {
    POOL.forEach((tagName) => {
      it(`'${tagName}' sans accept : aucun élément créé, 1 warn citant la balise`, () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<div mjs-el="0">bonjour</div>')
        const comp: any = { _shadow: shadow }
        µ._updDynEl(comp, '0', tagName)
        assert.equal(!!shadow.querySelector(tagName), false, `aucune balise <${tagName}> ne doit apparaître`)
        assert.equal(warnCalls.length, 1, 'la garde doit avertir une fois')
        assert.match(String(warnCalls[0][0]), new RegExp(tagName), 'le message doit citer la balise refusée')
      })

      it(`'${tagName}' avec accept: ['${tagName}'] : élément créé, aucun warn`, () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<div mjs-el="0">bonjour</div>')
        const comp: any = { _shadow: shadow }
        µ._updDynEl(comp, '0', tagName, [tagName])
        assert.equal(!!shadow.querySelector(tagName), true, `la balise <${tagName}> doit avoir été créée`)
        assert.equal(warnCalls.length, 0, 'aucun avertissement quand la balise est explicitement acceptée')
      })
    })

    it("accept: ['iframe'] n'autorise PAS 'object'", () => {
      const { µ, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0">bonjour</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', 'object', ['iframe'])
      assert.equal(!!shadow.querySelector('object'), false)
      assert.equal(warnCalls.length, 1)
    })

    it("casse/espaces (' IFRAME ') : refusée pareil, sans accept", () => {
      const { µ, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0">bonjour</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', ' IFRAME ')
      assert.equal(!!shadow.querySelector('iframe'), false)
      assert.equal(warnCalls.length, 1)
    })

    it("accept insensible à la casse côté valeurs (accept: ['IFRAME'] accepte 'iframe')", () => {
      const { µ, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0">bonjour</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', 'iframe', ['IFRAME'])
      assert.equal(!!shadow.querySelector('iframe'), true)
      assert.equal(warnCalls.length, 0)
    })

    it("'script' avec accept: ['script'] : créée quand même (accept lève même sur script)", () => {
      const { µ, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0">bonjour</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', 'script', ['script'])
      assert.equal(!!shadow.querySelector('script'), true)
      assert.equal(warnCalls.length, 0)
    })

    describe('accept tolérant — chaîne/tableau/type invalide (accept.map is not a function)', () => {
      it("accept: 'iframe' (chaîne simple, pas un tableau) : iframe acceptée, aucun warn", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<div mjs-el="0">bonjour</div>')
        const comp: any = { _shadow: shadow }
        µ._updDynEl(comp, '0', 'iframe', 'iframe')
        assert.equal(!!shadow.querySelector('iframe'), true, 'la chaîne seule doit être découpée en liste')
        assert.equal(warnCalls.length, 0)
      })

      it("accept: 'iframe style' (chaîne à deux noms séparés par un espace) : les deux acceptées", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadowA = makeShadow(document, '<div mjs-el="0">a</div>')
        const compA: any = { _shadow: shadowA }
        µ._updDynEl(compA, '0', 'iframe', 'iframe style')
        assert.equal(!!shadowA.querySelector('iframe'), true, "'iframe' doit être accepté")
        const shadowB = makeShadow(document, '<div mjs-el="1">b</div>')
        const compB: any = { _shadow: shadowB }
        µ._updDynEl(compB, '1', 'style', 'iframe style')
        assert.equal(!!shadowB.querySelector('style'), true, "'style' doit aussi être accepté")
        assert.equal(warnCalls.length, 0)
      })

      it("accept: 'IFRAME' (chaîne en majuscules) : acceptée, insensible à la casse", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<div mjs-el="0">bonjour</div>')
        const comp: any = { _shadow: shadow }
        µ._updDynEl(comp, '0', 'iframe', 'IFRAME')
        assert.equal(!!shadow.querySelector('iframe'), true)
        assert.equal(warnCalls.length, 0)
      })
      ;[42, true, {}].forEach((bad) => {
        it(`accept: ${JSON.stringify(bad)} (type invalide, ni chaîne ni tableau) : refusée, 1 warn « accept attend »`, () => {
          const { µ, document, warnCalls } = makeRunes()
          const shadow = makeShadow(document, '<div mjs-el="0">bonjour</div>')
          const comp: any = { _shadow: shadow }
          µ._updDynEl(comp, '0', 'iframe', bad as any)
          assert.equal(!!shadow.querySelector('iframe'), false, 'accept de type invalide ne doit accepter aucune balise')
          const acceptWarns = warnCalls.filter((w) => /accept attend/.test(String(w[0])))
          assert.equal(acceptWarns.length, 1, 'un warn doit citer «accept attend» exactement une fois')
        })
      })

      it("accept: ['iframe'] (tableau) : comportement inchangé (non-régression)", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<div mjs-el="0">bonjour</div>')
        const comp: any = { _shadow: shadow }
        µ._updDynEl(comp, '0', 'iframe', ['iframe'])
        assert.equal(!!shadow.querySelector('iframe'), true)
        assert.equal(warnCalls.length, 0)
      })
    })

    it("non-régression : 'div'/'span'/'section' créées sans warn", () => {
      const { µ, document, warnCalls } = makeRunes()
      const ordinaires = ['div', 'span', 'section']
      ordinaires.forEach((tagName, i) => {
        const shadow = makeShadow(document, `<div mjs-el="${i}">x</div>`)
        const comp: any = { _shadow: shadow }
        µ._updDynEl(comp, String(i), tagName)
        assert.equal(!!shadow.querySelector(tagName), true, `<${tagName}> doit avoir été créée`)
      })
      assert.equal(warnCalls.length, 0)
    })

    it("re-rendu 'div' → 'iframe' (sans accept) : refusé, aussi au 2e appel", () => {
      const { µ, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0">x</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', 'iframe')
      µ._updDynEl(comp, '0', 'iframe')
      assert.equal(!!shadow.querySelector('iframe'), false)
      assert.equal(warnCalls.length, 2, 'les 2 appels doivent chacun avertir')
    })

    describe('accept PRÉSENT devient une liste FERMÉE', () => {
      it("accept: ['iframe'] + tag 'div' : placeholder intact, 1 warn « hors de la liste » citant accept=\"iframe\"", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<span mjs-el="0">bonjour</span>')
        const comp: any = { _shadow: shadow }
        µ._updDynEl(comp, '0', 'div', ['iframe'])
        assert.equal(!!shadow.querySelector('div'), false, 'aucun <div> ne doit avoir été créé')
        assert.equal(!!shadow.querySelector('span[mjs-el="0"]'), true, 'le placeholder doit rester en place')
        assert.equal(warnCalls.length, 1)
        assert.match(String(warnCalls[0][0]), /hors de la liste/)
        assert.match(String(warnCalls[0][0]), /accept="iframe"/)
      })

      it("accept: ['iframe', 'div'] + tag 'div' : créé, aucun warn", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<span mjs-el="0">bonjour</span>')
        const comp: any = { _shadow: shadow }
        µ._updDynEl(comp, '0', 'div', ['iframe', 'div'])
        assert.equal(!!shadow.querySelector('div'), true, 'div listé dans accept : doit être créé')
        assert.equal(warnCalls.length, 0)
      })

      it("accept: 'p' (chaîne) + tag 'iframe' : refusé, warn « hors de la liste » (pas le message pool)", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<div mjs-el="0">bonjour</div>')
        const comp: any = { _shadow: shadow }
        µ._updDynEl(comp, '0', 'iframe', 'p')
        assert.equal(!!shadow.querySelector('iframe'), false)
        assert.equal(warnCalls.length, 1)
        assert.match(String(warnCalls[0][0]), /hors de la liste/)
        assert.doesNotMatch(String(warnCalls[0][0]), /ne peut pas devenir/, 'ce doit être le message « hors liste », pas le message pool')
      })

      it("sans accept + tag 'div' : créé (non-régression)", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<span mjs-el="0">bonjour</span>')
        const comp: any = { _shadow: shadow }
        µ._updDynEl(comp, '0', 'div')
        assert.equal(!!shadow.querySelector('div'), true)
        assert.equal(warnCalls.length, 0)
      })

      it("accept: 42 (type invalide) + tag 'div' : créé quand même, exactement 1 warn « accept attend »", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<span mjs-el="0">bonjour</span>')
        const comp: any = { _shadow: shadow }
        µ._updDynEl(comp, '0', 'div', 42 as any)
        assert.equal(!!shadow.querySelector('div'), true, 'accept de type invalide = absent, la règle du pool seule s\'applique')
        assert.equal(warnCalls.length, 1)
        assert.match(String(warnCalls[0][0]), /accept attend/)
      })

      it("accept: [] (liste normalisée vide) + tag 'div' : refusé, warn « hors de la liste »", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<span mjs-el="0">bonjour</span>')
        const comp: any = { _shadow: shadow }
        µ._updDynEl(comp, '0', 'div', [])
        assert.equal(!!shadow.querySelector('div'), false, 'liste vide présente : la liste fait foi seule, rien ne passe')
        assert.equal(warnCalls.length, 1)
        assert.match(String(warnCalls[0][0]), /hors de la liste/)
      })
    })
  })

  describe('µ._updModule (<@module $comp>)', () => {
    POOL.forEach((tagName) => {
      it(`Comp = '${tagName}' sans accept : aucun composant créé, 1 warn citant la balise`, () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
        const comp: any = { _shadow: shadow }
        µ._updModule(comp, '0', tagName)
        assert.equal(!!shadow.querySelector(tagName), false)
        assert.equal(warnCalls.length, 1)
        assert.match(String(warnCalls[0][0]), new RegExp(tagName))
      })

      it(`Comp = '${tagName}' avec accept: ['${tagName}'] : composant monté, aucun warn`, () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
        const comp: any = { _shadow: shadow }
        µ._updModule(comp, '0', tagName, [tagName])
        assert.equal(!!shadow.querySelector(tagName), true)
        assert.equal(warnCalls.length, 0)
      })
    })

    it("accept: ['iframe'] n'autorise PAS 'object'", () => {
      const { µ, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
      const comp: any = { _shadow: shadow }
      µ._updModule(comp, '0', 'object', ['iframe'])
      assert.equal(!!shadow.querySelector('object'), false)
      assert.equal(warnCalls.length, 1)
    })

    it("casse/espaces (' IFRAME ') : refusée pareil, sans accept", () => {
      const { µ, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
      const comp: any = { _shadow: shadow }
      µ._updModule(comp, '0', ' IFRAME ')
      assert.equal(!!shadow.querySelector('iframe'), false)
      assert.equal(warnCalls.length, 1)
    })

    it("accept insensible à la casse côté valeurs (accept: ['IFRAME'] accepte 'iframe')", () => {
      const { µ, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
      const comp: any = { _shadow: shadow }
      µ._updModule(comp, '0', 'iframe', ['IFRAME'])
      assert.equal(!!shadow.querySelector('iframe'), true)
      assert.equal(warnCalls.length, 0)
    })

    it("Comp = 'script' avec accept: ['script'] : monté quand même", () => {
      const { µ, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
      const comp: any = { _shadow: shadow }
      µ._updModule(comp, '0', 'script', ['script'])
      assert.equal(!!shadow.querySelector('script'), true)
      assert.equal(warnCalls.length, 0)
    })

    describe('accept tolérant — chaîne/tableau/type invalide (accept.map is not a function)', () => {
      it("accept: 'iframe' (chaîne simple, pas un tableau) : composant monté, aucun warn", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
        const comp: any = { _shadow: shadow }
        µ._updModule(comp, '0', 'iframe', 'iframe')
        assert.equal(!!shadow.querySelector('iframe'), true, 'la chaîne seule doit être découpée en liste')
        assert.equal(warnCalls.length, 0)
      })

      it("accept: 'iframe style' (chaîne à deux noms séparés par un espace) : les deux acceptées", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadowA = makeShadow(document, '<div mjs-mod="0">a</div>')
        const compA: any = { _shadow: shadowA }
        µ._updModule(compA, '0', 'iframe', 'iframe style')
        assert.equal(!!shadowA.querySelector('iframe'), true, "'iframe' doit être accepté")
        const shadowB = makeShadow(document, '<div mjs-mod="1">b</div>')
        const compB: any = { _shadow: shadowB }
        µ._updModule(compB, '1', 'style', 'iframe style')
        assert.equal(!!shadowB.querySelector('style'), true, "'style' doit aussi être accepté")
        assert.equal(warnCalls.length, 0)
      })

      it("accept: 'IFRAME' (chaîne en majuscules) : acceptée, insensible à la casse", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
        const comp: any = { _shadow: shadow }
        µ._updModule(comp, '0', 'iframe', 'IFRAME')
        assert.equal(!!shadow.querySelector('iframe'), true)
        assert.equal(warnCalls.length, 0)
      })
      ;[42, true, {}].forEach((bad) => {
        it(`accept: ${JSON.stringify(bad)} (type invalide, ni chaîne ni tableau) : refusée, 1 warn « accept attend »`, () => {
          const { µ, document, warnCalls } = makeRunes()
          const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
          const comp: any = { _shadow: shadow }
          µ._updModule(comp, '0', 'iframe', bad as any)
          assert.equal(!!shadow.querySelector('iframe'), false, 'accept de type invalide ne doit accepter aucune balise')
          const acceptWarns = warnCalls.filter((w) => /accept attend/.test(String(w[0])))
          assert.equal(acceptWarns.length, 1, 'un warn doit citer «accept attend» exactement une fois')
        })
      })

      it("accept: ['iframe'] (tableau) : comportement inchangé (non-régression)", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
        const comp: any = { _shadow: shadow }
        µ._updModule(comp, '0', 'iframe', ['iframe'])
        assert.equal(!!shadow.querySelector('iframe'), true)
        assert.equal(warnCalls.length, 0)
      })
    })

    it("non-régression : nom de tag ordinaire ('x-widget') monte bien le composant, sans warn", () => {
      const { µ, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
      const comp: any = { _shadow: shadow }
      µ._updModule(comp, '0', 'x-widget')
      assert.equal(!!shadow.querySelector('x-widget'), true)
      assert.equal(warnCalls.length, 0)
    })

    describe('accept PRÉSENT devient une liste FERMÉE', () => {
      it("accept: ['iframe'] + Comp 'div' : placeholder intact, 1 warn « hors de la liste » citant accept=\"iframe\"", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<span mjs-mod="0">bonjour</span>')
        const comp: any = { _shadow: shadow }
        µ._updModule(comp, '0', 'div', ['iframe'])
        assert.equal(!!shadow.querySelector('div'), false, 'aucun <div> ne doit avoir été créé')
        assert.equal(!!shadow.querySelector('span[mjs-mod="0"]'), true, 'le placeholder doit rester en place')
        assert.equal(warnCalls.length, 1)
        assert.match(String(warnCalls[0][0]), /hors de la liste/)
        assert.match(String(warnCalls[0][0]), /accept="iframe"/)
      })

      it("accept: ['iframe', 'div'] + Comp 'div' : monté, aucun warn", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<span mjs-mod="0">bonjour</span>')
        const comp: any = { _shadow: shadow }
        µ._updModule(comp, '0', 'div', ['iframe', 'div'])
        assert.equal(!!shadow.querySelector('div'), true, 'div listé dans accept : doit être monté')
        assert.equal(warnCalls.length, 0)
      })

      it("accept: 'p' (chaîne) + Comp 'iframe' : refusé, warn « hors de la liste » (pas le message pool)", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
        const comp: any = { _shadow: shadow }
        µ._updModule(comp, '0', 'iframe', 'p')
        assert.equal(!!shadow.querySelector('iframe'), false)
        assert.equal(warnCalls.length, 1)
        assert.match(String(warnCalls[0][0]), /hors de la liste/)
        assert.doesNotMatch(String(warnCalls[0][0]), /ne peut pas devenir/, 'ce doit être le message « hors liste », pas le message pool')
      })

      it("sans accept + Comp 'div' : monté (non-régression)", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<span mjs-mod="0">bonjour</span>')
        const comp: any = { _shadow: shadow }
        µ._updModule(comp, '0', 'div')
        assert.equal(!!shadow.querySelector('div'), true)
        assert.equal(warnCalls.length, 0)
      })

      it("accept: 42 (type invalide) + Comp 'div' : monté quand même, exactement 1 warn « accept attend »", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<span mjs-mod="0">bonjour</span>')
        const comp: any = { _shadow: shadow }
        µ._updModule(comp, '0', 'div', 42 as any)
        assert.equal(!!shadow.querySelector('div'), true, 'accept de type invalide = absent, la règle du pool seule s\'applique')
        assert.equal(warnCalls.length, 1)
        assert.match(String(warnCalls[0][0]), /accept attend/)
      })

      it("accept: [] (liste normalisée vide) + Comp 'div' : refusé, warn « hors de la liste »", () => {
        const { µ, document, warnCalls } = makeRunes()
        const shadow = makeShadow(document, '<span mjs-mod="0">bonjour</span>')
        const comp: any = { _shadow: shadow }
        µ._updModule(comp, '0', 'div', [])
        assert.equal(!!shadow.querySelector('div'), false, 'liste vide présente : la liste fait foi seule, rien ne passe')
        assert.equal(warnCalls.length, 1)
        assert.match(String(warnCalls[0][0]), /hors de la liste/)
      })
    })
  })
})

// ============================================================================
// mjs_runes.ts µ._updDynEl/µ._updModule : display:none hérité au swap.
// Un nœud masqué par une valeur falsy (`cur.style.display =
// 'none'`) puis basculé vers un AUTRE tag héritait du masque (la boucle copie l'attribut
// `style` de l'ancien nœud sur le nouveau) → élément créé mais invisible, en silence.
// ============================================================================

describe('<@element>/<@module> : display:none hérité au swap (mjs_runes.ts)', () => {
  describe('µ._updDynEl', () => {
    it("masqué (null) puis basculé vers 'p' : <p> créé sans display:none", () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0">x</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', null)
      µ._updDynEl(comp, '0', 'p')
      assert.equal(!!shadow.querySelector('p'), true, '<p> doit avoir été créé')
      const p = shadow.querySelector('p')
      assert.doesNotMatch(p.getAttribute('style') || '', /display:\s*none/, 'le <p> ne doit pas hériter du masque')
    })

    it("masqué (null) puis basculé vers 'iframe' (accept: ['iframe']) : <iframe> créé sans display:none", () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0">x</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', null)
      µ._updDynEl(comp, '0', 'iframe', ['iframe'])
      assert.equal(!!shadow.querySelector('iframe'), true, '<iframe> doit avoir été créé')
      const iframe = shadow.querySelector('iframe')
      assert.doesNotMatch(iframe.getAttribute('style') || '', /display:\s*none/, "l'<iframe> ne doit pas hériter du masque")
    })

    it('un style="color: red" statique survit à la bascule', () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0" style="color: red">x</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', null)
      µ._updDynEl(comp, '0', 'p')
      const p = shadow.querySelector('p')
      assert.equal(!!p, true)
      assert.match(p.getAttribute('style') || '', /color:\s*red/, 'le style statique de l\'auteur doit survivre')
      assert.doesNotMatch(p.getAttribute('style') || '', /display:\s*none/)
    })
  })

  describe('µ._updModule', () => {
    it("masqué (null) puis basculé vers un tag de composant : monté sans display:none", () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0">x</div>')
      const comp: any = { _shadow: shadow }
      µ._updModule(comp, '0', null)
      µ._updModule(comp, '0', 'x-widget')
      assert.equal(!!shadow.querySelector('x-widget'), true, 'le composant doit avoir été monté')
      const w = shadow.querySelector('x-widget')
      assert.doesNotMatch(w.getAttribute('style') || '', /display:\s*none/, 'ne doit pas hériter du masque')
    })

    it('un style="color: red" statique survit à la bascule (composant)', () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0" style="color: red">x</div>')
      const comp: any = { _shadow: shadow }
      µ._updModule(comp, '0', null)
      µ._updModule(comp, '0', 'x-widget')
      const w = shadow.querySelector('x-widget')
      assert.equal(!!w, true)
      assert.match(w.getAttribute('style') || '', /color:\s*red/)
      assert.doesNotMatch(w.getAttribute('style') || '', /display:\s*none/)
    })
  })
})

// ============================================================================
// mjs_runes.ts µ._updDynEl/µ._updModule : tag/Comp non trimmé.
// `norm` (utilisé pour l'acceptation) est trimmé mais
// document.createElement(String(tag)) et la comparaison de tagName ne l'étaient pas :
// ' div ' passe l'acceptation, ne matche jamais cur.tagName (recréation à chaque appel) et
// lève InvalidCharacterError sur un vrai navigateur (happy-dom laisse passer en silence).
// ============================================================================

describe('<@element>/<@module> : tag/Comp non trimmé (mjs_runes.ts)', () => {
  it("µ._updDynEl(' p ') : <p> créé ; second appel identique : aucun nouveau nœud (même référence)", () => {
    const { µ, document } = makeRunes()
    const shadow = makeShadow(document, '<div mjs-el="0">x</div>')
    const comp: any = { _shadow: shadow }
    µ._updDynEl(comp, '0', ' p ')
    assert.equal(!!shadow.querySelector('p'), true, '<p> doit avoir été créé')
    const p1 = shadow.querySelector('p')
    µ._updDynEl(comp, '0', ' p ')
    const p2 = shadow.querySelector('p')
    assert.equal(p1 === p2, true, 'même référence : aucune recréation au 2e appel')
    assert.equal(shadow.querySelectorAll('p').length, 1, 'un seul <p>, jamais recréé')
  })

  it("µ._updDynEl(' iframe ') + accept: ['iframe'] : <iframe> créé", () => {
    const { µ, document } = makeRunes()
    const shadow = makeShadow(document, '<div mjs-el="0">x</div>')
    const comp: any = { _shadow: shadow }
    µ._updDynEl(comp, '0', ' iframe ', ['iframe'])
    assert.equal(!!shadow.querySelector('iframe'), true, '<iframe> doit avoir été créé')
  })

  it("µ._updModule(' x-widget ') : composant créé ; second appel identique : aucun nouveau nœud (même référence)", () => {
    const { µ, document } = makeRunes()
    const shadow = makeShadow(document, '<div mjs-mod="0">x</div>')
    const comp: any = { _shadow: shadow }
    µ._updModule(comp, '0', ' x-widget ')
    assert.equal(!!shadow.querySelector('x-widget'), true, 'le composant doit avoir été monté')
    const w1 = shadow.querySelector('x-widget')
    µ._updModule(comp, '0', ' x-widget ')
    const w2 = shadow.querySelector('x-widget')
    assert.equal(w1 === w2, true, 'même référence : aucune recréation au 2e appel')
  })
})

// ============================================================================
// mjs_runes.ts µ._updDynEl/µ._updModule : RÉGRESSION du correctif précédent (display:none hérité au swap).
// `cur.style.removeProperty('display')` partait INCONDITIONNELLEMENT (masqué ou
// pas), y compris sur le chemin « même tag » préexistant : un `<@element $tag
// style="display:flex">` perdait son display:flex dès le TOUT PREMIER rendu, masquage ou
// pas. Marqueur `_mjs_mjsMasque` (µ._mjs_dynMask/µ._mjs_dynUnmask) : `_mjs_dynUnmask` ne touche RIEN si on
// n'a jamais masqué nous-mêmes. Bonus au-delà du minimum demandé : `_mjs_mjsDisplayAvant`
// mémorise le display d'auteur AVANT l'écrasement et le RESTAURE au démasquage (pas
// seulement retiré) — un `style="…;display:flex"` masqué puis re-basculé retrouve son
// display:flex, pas seulement son absence de display:none.
// ============================================================================

describe('<@element>/<@module> : display d\'auteur écrasé par le masquage, même sans masquage (mjs_runes.ts)', () => {
  describe('µ._updDynEl', () => {
    it("(a) placeholder style=\"display:flex\" + tag 'p', JAMAIS masqué : <p> porte display:flex intact", () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0" style="display:flex">x</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', 'p')
      const p = shadow.querySelector('p')
      assert.equal(!!p, true, '<p> doit avoir été créé')
      assert.match(p.getAttribute('style') || '', /display:\s*flex/, 'display:flex de l\'auteur doit survivre au tout premier rendu (jamais masqué)')
    })

    it("(b) \$tag='div' (MÊME tag que le placeholder), JAMAIS masqué : display:flex conservé (chemin « même tag »)", () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0" style="display:flex">x</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', 'div')
      assert.match(shadow.firstElementChild.getAttribute('style') || '', /display:\s*flex/, 'le chemin « même tag » ne doit RIEN retirer si jamais masqué')
    })

    it('(c) style="color:red;display:flex" masqué (null) puis \'p\' : display:none retiré, color:red ET display:flex RESTAURÉS (mémorisation)', () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0" style="color:red;display:flex">x</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', null)
      assert.match(shadow.firstElementChild.getAttribute('style') || '', /display:\s*none/, 'masqué : display:none posé')
      µ._updDynEl(comp, '0', 'p')
      const p = shadow.querySelector('p')
      assert.equal(!!p, true)
      assert.match(p.getAttribute('style') || '', /color:\s*red/, 'color:red de l\'auteur survit')
      assert.doesNotMatch(p.getAttribute('style') || '', /display:\s*none/, 'display:none du masque retiré')
      assert.match(p.getAttribute('style') || '', /display:\s*flex/, 'MIEUX que le minimum acceptable : display:flex mémorisé (_mjs_mjsDisplayAvant) puis restauré, pas perdu')
    })

    it('(d) masqué (null, aucun display d\'auteur) puis MÊME tag (div) : redevient visible', () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0">x</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', null)
      assert.match(shadow.firstElementChild.getAttribute('style') || '', /display:\s*none/)
      µ._updDynEl(comp, '0', 'div')
      assert.doesNotMatch(shadow.firstElementChild.getAttribute('style') || '', /display:\s*none/, 'redevient visible par le chemin « même tag »')
    })
  })

  describe('µ._updModule', () => {
    it("(e-string) placeholder style=\"display:flex\" + comp 'x-widget', JAMAIS masqué : style intact", () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0" style="display:flex">x</div>')
      const comp: any = { _shadow: shadow }
      µ._updModule(comp, '0', 'x-widget')
      const w = shadow.querySelector('x-widget')
      assert.equal(!!w, true)
      assert.match(w.getAttribute('style') || '', /display:\s*flex/)
    })

    it("(e-string) MÊME comp que le placeholder ('div'), JAMAIS masqué : display:flex conservé (chemin « même tag »)", () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0" style="display:flex">x</div>')
      const comp: any = { _shadow: shadow }
      µ._updModule(comp, '0', 'div')
      assert.match(shadow.firstElementChild.getAttribute('style') || '', /display:\s*flex/)
    })

    it('(e-classe) placeholder style="display:flex" + classe, JAMAIS masqué : style intact', () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0" style="display:flex">x</div>')
      const comp: any = { _shadow: shadow }
      class Widget { constructor() { return document.createElement('x-widget') } }
      µ._updModule(comp, '0', Widget)
      const w = shadow.querySelector('x-widget')
      assert.equal(!!w, true)
      assert.match(w.getAttribute('style') || '', /display:\s*flex/)
    })

    it('(e-classe) style="color:red;display:flex" masqué puis MÊME classe (identité forcée) : visible, color ET display:flex restaurés', () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0" style="color:red;display:flex">x</div>')
      const comp: any = { _shadow: shadow }
      class Widget {}
      µ._updModule(comp, '0', null)
      const cur = shadow.firstElementChild
      assert.match(cur.getAttribute('style') || '', /display:\s*none/)
      cur.constructor = Widget    // force l'identité (chemin « même classe » : cur.constructor === Comp)
      µ._updModule(comp, '0', Widget)
      assert.match(cur.getAttribute('style') || '', /color:\s*red/)
      assert.match(cur.getAttribute('style') || '', /display:\s*flex/)
    })
  })
})

// ============================================================================
// mjs_runes.ts µ._updDynEl/µ._updModule : tag/Comp ÉPURÉ vide (blancs seuls).
// La garde falsy testait `tag === ''`/`Comp === ''` sur la valeur BRUTE : '   ' la traverse,
// tombe jusqu'à document.createElement('') plus loin, qui lève (capté par le µeffect
// englobant, mais bruyant). La garde teste maintenant la valeur ÉPURÉE.
// ============================================================================

describe('<@element>/<@module> : tag/Comp épuré vide, blancs seuls (mjs_runes.ts)', () => {
  it("µ._updDynEl(comp, '0', '   ') : masqué comme falsy, AUCUN nœud créé, AUCUNE exception", () => {
    const { µ, document, warnCalls } = makeRunes()
    const shadow = makeShadow(document, '<div mjs-el="0">x</div>')
    const comp: any = { _shadow: shadow }
    assert.doesNotThrow(() => µ._updDynEl(comp, '0', '   '))
    assert.match(shadow.firstElementChild.getAttribute('style') || '', /display:\s*none/, 'masqué comme une valeur falsy ordinaire')
    assert.equal(shadow.children.length, 1, 'toujours le placeholder, aucun nœud recréé')
    assert.equal(warnCalls.length, 0, 'aucun avertissement — ce n\'est pas un refus de balise, c\'est un masquage')
  })

  it("µ._updModule(comp, '0', '   ') : masqué comme falsy, AUCUN nœud créé, AUCUNE exception", () => {
    const { µ, document, warnCalls } = makeRunes()
    const shadow = makeShadow(document, '<div mjs-mod="0">x</div>')
    const comp: any = { _shadow: shadow }
    assert.doesNotThrow(() => µ._updModule(comp, '0', '   '))
    assert.match(shadow.firstElementChild.getAttribute('style') || '', /display:\s*none/)
    assert.equal(shadow.children.length, 1)
    assert.equal(warnCalls.length, 0)
  })
})

// ============================================================================
// mjs_easing.ts µ.easing.resolve : avertissement en mode debug sur chaîne inconnue
// ============================================================================

function makeEasing(): { µ: any; window: any; document: any; warnCalls: any[][] } {
  const window: any = new Window({ url: 'http://localhost/' })
  __windows.push(window)
  const document: any = window.document
  const warnCalls: any[][] = []
  const µ: any = { debug: false, log() {}, warn(...args: any[]) { warnCalls.push(args) }, error() {} }
  new Function('µ', 'document', easingSrc)(µ, document)
  return { µ, window, document, warnCalls }
}

describe('µ.easing.resolve : chaîne inconnue avertit en mode debug (repli cubicOut inchangé)', () => {
  it("'bounceOut' (faute de frappe) + µ.debug = true : 1 warn, repli cubicOut", () => {
    const { µ, warnCalls } = makeEasing()
    µ.debug = true
    const fn = µ.easing.resolve('bounceOut')
    assert.equal(fn, µ.easing.cubicOut)
    assert.equal(warnCalls.length, 1)
    assert.match(String(warnCalls[0][0]), /bounceOut/)
  })

  it("'bounceOut' + µ.debug = false : 0 warn, repli cubicOut quand même", () => {
    const { µ, warnCalls } = makeEasing()
    µ.debug = false
    const fn = µ.easing.resolve('bounceOut')
    assert.equal(fn, µ.easing.cubicOut)
    assert.equal(warnCalls.length, 0)
  })

  it("'ease-out' (chaîne CSS connue) + µ.debug = true : 0 warn, cubicOut rendu", () => {
    const { µ, warnCalls } = makeEasing()
    µ.debug = true
    const fn = µ.easing.resolve('ease-out')
    assert.equal(fn, µ.easing.cubicOut)
    assert.equal(warnCalls.length, 0)
  })

  it('une fonction : 0 warn, rendue telle quelle', () => {
    const { µ, warnCalls } = makeEasing()
    µ.debug = true
    const custom = (t: number) => t
    const fn = µ.easing.resolve(custom)
    assert.equal(fn, custom)
    assert.equal(warnCalls.length, 0)
  })
})

// ============================================================================
// mjs_easing.ts _runSharedTransition (l.536) / _mjs_runTransition (l.823) :
// Math.max(1, NaN) === NaN
// ============================================================================

const STEPS_CASES: Array<{ steps: any; label: string; expectedLen: number }> = [
  { steps: NaN,       label: 'NaN',       expectedLen: 61 },
  { steps: 'abc',     label: "'abc'",     expectedLen: 61 },
  { steps: Infinity,  label: 'Infinity',  expectedLen: 61 },
  { steps: -3,        label: '-3',        expectedLen: 2 },
  { steps: 0,         label: '0',         expectedLen: 2 },
  { steps: undefined, label: 'undefined', expectedLen: 61 },
  { steps: '60',      label: "'60'",      expectedLen: 61 },
]

describe('steps non fini/non numérique : keyframes VIDES corrigées', () => {
  describe('mode css (_mjs_runTransition, l.823)', () => {
    STEPS_CASES.forEach(({ steps, label, expectedLen }) => {
      it(`steps: ${label} → ${expectedLen} keyframes, offsets 0 et 1 exacts`, async () => {
        const { µ, document } = makeEasing()
        const node: any = document.createElement('div')
        const calls: any[] = []
        // happy-dom n'implémente pas Element.prototype.animate (WAAPI) — mock minimal.
        node.animate = (kf: any) => { calls.push(kf); return { finished: Promise.resolve(), cancel() {}, effect: null } }
        const cfg: any = { css: (t: number) => ({ opacity: t }), steps, duration: 10 }
        await µ._mjs_runTransition(node, cfg, 'in')
        assert.ok(calls.length >= 2, "l'anim bidon anti-flash PUIS la vraie animation doivent avoir été posées")
        const real = calls[calls.length - 1]
        assert.equal(real.length, expectedLen, `attendu ${expectedLen} keyframes pour steps=${label}`)
        assert.equal(real[0].offset, 0, 'le 1er offset doit être exactement 0')
        assert.equal(real[real.length - 1].offset, 1, 'le dernier offset doit être exactement 1')
        assert.equal(real.some((f: any) => Number.isNaN(f.offset)), false, 'aucun offset NaN')
      })
    })
  })

  describe('mode shared (_runSharedTransition, l.536)', () => {
    STEPS_CASES.forEach(({ steps, label, expectedLen }) => {
      it(`steps: ${label} → ${expectedLen} keyframes, offsets 0 et 1 exacts`, () => {
        const { µ, document } = makeEasing()
        const node: any = document.createElement('div')
        node._mjs_anim_mode = 'shared'
        let built: any[] | null = null
        const original = µ.anim._mjs_acquireKeyframes
        µ.anim._mjs_acquireKeyframes = (_name: string, builder: any) => { built = builder(); return _name }
        const cfg: any = { css: (t: number) => ({ opacity: t }), steps, duration: 10 }
        µ._mjs_runTransition(node, cfg, 'in')
        µ.anim._mjs_acquireKeyframes = original
        assert.ok(built, 'le builder doit avoir été invoqué')
        const kf = built as any[]
        assert.equal(kf.length, expectedLen, `attendu ${expectedLen} keyframes pour steps=${label}`)
        assert.equal(kf[0].offset, 0, 'le 1er offset doit être exactement 0')
        assert.equal(kf[kf.length - 1].offset, 1, 'le dernier offset doit être exactement 1')
        assert.equal(kf.some((f: any) => Number.isNaN(f.offset)), false, 'aucun offset NaN')
      })
    })
  })
})

// ============================================================================
// mjs_element.ts _mjs_wrapDeep, trap setPrototypeOf : message corrigé (« état », pas « store »)
// ============================================================================

// Sandbox µ.Element calquée sur tests/runtime-easing-vt-guards.test.ts (charge mjs_init.ts +
// mjs_element.ts bruts dans un `new Function`, stubs DOM minimaux).
function makeElementSandbox(): { µ: any; MjsTest: any } {
  const sandbox = `
    class HTMLElement {
      constructor() {}
      attachShadow(opts) { return { adoptedStyleSheets: [], appendChild() {} }; }
      addEventListener() {} removeEventListener() {} dispatchEvent() {}
      getAttribute() { return null }; setAttribute() {}
    }
    class CustomEvent { constructor(name, init) { this.type = name; Object.assign(this, init || {}); } }
    class Node {}
    class CSSStyleSheet { replaceSync() {} }
    const customElements = { get: () => null, define: () => {} };
    const document = { adoptedStyleSheets: [] };
    ${initSrc.replace(/export\s*\{[^}]*\}/, '')}
    ${elemSrc}
    class MjsTest extends µ.Element {
      constructor() {
        super();
        this._mjs_var_bits = { box: 1 };
        this._invalidations = [];
      }
      _mjs_invalidate(k) { this._invalidations.push(k); }
    }
    return { µ, MjsTest };
  `
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(sandbox)()
}

describe("mjs_element.ts _mjs_wrapDeep, trap setPrototypeOf : message « état », pas « store »", () => {
  it("Object.setPrototypeOf sur l'état profond d'un composant : le warn cite « état »", () => {
    const { µ, MjsTest } = makeElementSandbox()
    const warnCalls: any[][] = []
    µ.warn = (...args: any[]) => { warnCalls.push(args) }
    const el: any = new MjsTest()
    el._set('box', { a: 1 })
    const proxy: any = el._state.box
    assert.throws(() => Object.setPrototypeOf(proxy, { polluted: 1 }), TypeError, 'Object.setPrototypeOf doit lever TypeError (trap renvoie false)')
    assert.equal(warnCalls.length, 1, 'la garde doit avertir une fois')
    assert.match(String(warnCalls[0][0]), /état/, 'le message doit citer « état »')
    assert.equal(String(warnCalls[0][0]).indexOf('store') === -1, true, 'AVANT le fix : le message parlait à tort de « store »')
  })
})
