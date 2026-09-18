// Test de régression — "reliques" : 3 propriétés globales mortes retirées de mjs_init.ts, chacune
// vérifiée AVANT retrait comme n'ayant AUCUN autre site de lecture/écriture
// dans tout src/ :
//
//   - µ.attach = {}            — namespace orphelin, jamais lu/écrit ailleurs
//     (le directive @attach du template, `bindingAttach`, est un mécanisme
//     totalement distinct qui n'y touche jamais).
//   - µ._activeEffectComponent — relique V1 (bitmask), initialisée à `null`
//     puis lue UNE fois dans mjs_store.ts, dans une variable locale
//     elle-même jamais utilisée ensuite (dead read d'un dead write).
//   - µ._activeEffectMask      — même famille, jamais réassignée nulle part.
//
// Le mécanisme VIVANT (`µ.activeComponent`, dispatch direct `_mjs_effectsByVar`
// V2) n'est pas affecté par ce retrait — ce test le confirme aussi
// explicitement (non-régression).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const initSrc = readFileSync(join(__dirname, '../src/runtime/mjs_init.ts'), 'utf-8')
// µ.snap a depuis été EXTRAIT de mjs_init.ts vers mjs_rare_runes.ts (DÉTACHÉ du cœur, cf.
// bundler/index.ts scanRuntimeFeatures) — n'est plus un « voisin » du tout, mais la dernière
// assertion ci-dessous continue de le charger EN PLUS pour vérifier qu'il fonctionne toujours
// après le retrait des 3 globals morts (le but originel de ce test).
const rareRunesSrc = readFileSync(join(__dirname, '../src/runtime/mjs_rare_runes.ts'), 'utf-8')

function loadMjsInit(): any {
  // Stubs minimaux (mêmes que runtime.test.ts) : mjs_init.ts référence
  // quelques globals navigateur (HTMLElement, CustomEvent, CSSStyleSheet,
  // customElements, document.adoptedStyleSheets) — sans rapport avec ce
  // test, juste nécessaires pour que le fichier s'exécute hors navigateur.
  const sandbox = `
    class HTMLElement {
      constructor() {}
      attachShadow(opts) { return { adoptedStyleSheets: [], appendChild() {} }; }
      addEventListener() {} removeEventListener() {} dispatchEvent() {}
      getAttribute() { return null }; setAttribute() {}
    }
    class CustomEvent { constructor(name, init) { this.type = name; Object.assign(this, init || {}); } }
    class CSSStyleSheet { replaceSync() {} }
    const customElements = { get: () => null, define: () => {} };
    const document = { adoptedStyleSheets: [] };
    ${initSrc.replace(/export\s*\{[^}]*\}/, '')}
    ${rareRunesSrc.replace(/^import[^;]*;?$/gm, '').replace(/export\s*\{[^}]*\}/, '')}
    return µ;
  `
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(sandbox)()
}

describe('mjs_init.ts — reliques V1 mortes retirées', () => {
  it("µ.attach n'est plus initialisé (namespace orphelin retiré)", () => {
    const µ = loadMjsInit()
    assert.equal(µ.attach, undefined,
      "AVANT le fix : µ.attach = {} était créé au boot sans jamais être lu/écrit ailleurs")
  })

  it("µ._activeEffectComponent n'est plus initialisé (relique V1 bitmask)", () => {
    const µ = loadMjsInit()
    assert.equal(µ._activeEffectComponent, undefined,
      "AVANT le fix : toujours `null` à vie, lu une fois dans une var locale jamais utilisée (mjs_store.ts)")
  })

  it("µ._activeEffectMask n'est plus initialisé (relique V1 bitmask)", () => {
    const µ = loadMjsInit()
    assert.equal(µ._activeEffectMask, undefined)
  })

  it('µ.activeComponent (mécanisme VIVANT V2) continue de fonctionner normalement (pas de régression)', () => {
    const µ = loadMjsInit()
    assert.equal(µ.activeComponent, null, 'initialisé à null, comme avant')
    µ.activeComponent = { fake: true }
    assert.deepEqual(µ.activeComponent, { fake: true })
  })

  it('µ.snap (marqueur snapshot, ex-voisin des globals retirés, depuis extrait dans mjs_rare_runes.ts) continue de fonctionner', () => {
    const µ = loadMjsInit()
    assert.equal(µ.snap(42), 42)
  })
})
