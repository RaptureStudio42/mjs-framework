// Les DEUX helpers d'opt-out par élément, exécutés depuis la SOURCE (pas depuis un mock).
//
// Pourquoi ce fichier existe. Les tests de clic/submit (ujs-confirm-method, ujs-confirm-config,
// ujs-click-samepage-duplicate-pushstate) n'extraient que le CORPS des handlers : `µ._mjs_navNoUjs` et
// `µ._mjs_navWarnNoUjsMethod` vivent hors de ce corps, ils y sont donc STUBBÉS. Conséquence : saboter
// la source de ces deux fonctions n'y fait rougir AUCUN test — la couverture porte sur le mock.
// Ici on extrait les deux déclarations RÉELLES de src/runtime/mjs_ujs.ts et on les exécute, ce qui
// verrouille pour de bon (a) la purge de l'ancien nom `mjs-no-ajax`, (b) l'avertissement une fois
// par élément sur la combinaison contradictoire `@noUJS` + `@method`.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function loadHelpers(warns: string[]) {
  const µ: any = { warn: (m: string) => warns.push(m) }
  const src = extractMarked(UJS_SRC, '_mjs_navNoUjs')
            + '\n' + extractMarked(UJS_SRC, '_mjs_navWarnNoUjsMethod')
  new Function('µ', src)(µ)
  return µ
}

// Élément minimal : juste ce que les deux helpers touchent (hasAttribute/getAttribute + le drapeau
// posé sur le nœud). Volontairement pas de happy-dom ici — on teste deux fonctions pures de DOM.
function fakeEl(attrs: Record<string, string>) {
  return {
    hasAttribute: (n: string) => Object.prototype.hasOwnProperty.call(attrs, n),
    getAttribute: (n: string) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
  } as any
}

describe('µ._mjs_navNoUjs (source réelle) — un seul nom reconnu depuis la purge', function () {
  it('mjs-no-ujs : opt-out RECONNU', function () {
    const µ = loadHelpers([])
    assert.equal(µ._mjs_navNoUjs(fakeEl({ 'mjs-no-ujs': '' })), true)
  })

  it("mjs-no-ajax (ancien nom PURGÉ) : plus reconnu du tout", function () {
    const µ = loadHelpers([])
    assert.equal(µ._mjs_navNoUjs(fakeEl({ 'mjs-no-ajax': '' })), false)
  })

  it('élément nu, null, ou objet sans hasAttribute : false sans jeter', function () {
    const µ = loadHelpers([])
    assert.equal(µ._mjs_navNoUjs(fakeEl({})), false)
    assert.equal(µ._mjs_navNoUjs(null), false)
    assert.equal(µ._mjs_navNoUjs({} as any), false)
  })
})

describe('µ._mjs_navWarnNoUjsMethod (source réelle) — @noUJS + @method averti une fois par élément', function () {
  it('mjs-method présent : un avertissement nommant le verbe et le GET', function () {
    const warns: string[] = []
    const µ = loadHelpers(warns)
    µ._mjs_navWarnNoUjsMethod(fakeEl({ 'mjs-no-ujs': '', 'mjs-method': 'delete' }))

    assert.equal(warns.length, 1)
    assert.match(warns[0], /@method="delete" ignoré/)
    assert.match(warns[0], /@noUJS/)
    assert.match(warns[0], /GET/)
  })

  it('appelé 3 fois sur le MÊME élément : un seul avertissement', function () {
    const warns: string[] = []
    const µ = loadHelpers(warns)
    const el = fakeEl({ 'mjs-no-ujs': '', 'mjs-method': 'put' })
    µ._mjs_navWarnNoUjsMethod(el)
    µ._mjs_navWarnNoUjsMethod(el)
    µ._mjs_navWarnNoUjsMethod(el)

    assert.equal(warns.length, 1)
  })

  it('deux éléments distincts : un avertissement CHACUN (drapeau porté par le nœud)', function () {
    const warns: string[] = []
    const µ = loadHelpers(warns)
    µ._mjs_navWarnNoUjsMethod(fakeEl({ 'mjs-no-ujs': '', 'mjs-method': 'delete' }))
    µ._mjs_navWarnNoUjsMethod(fakeEl({ 'mjs-no-ujs': '', 'mjs-method': 'patch' }))

    assert.equal(warns.length, 2)
    assert.match(warns[1], /@method="patch" ignoré/)
  })

  it('sans mjs-method, élément nul, ou sans getAttribute : silence total', function () {
    const warns: string[] = []
    const µ = loadHelpers(warns)
    µ._mjs_navWarnNoUjsMethod(fakeEl({ 'mjs-no-ujs': '' }))
    µ._mjs_navWarnNoUjsMethod(null)
    µ._mjs_navWarnNoUjsMethod({} as any)

    assert.equal(warns.length, 0)
  })
})
