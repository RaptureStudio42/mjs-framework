// Régression : `µ.url.params` est une
// UNION à plat des params de TOUTES les vues routées de la page — deux
// composants indépendants peuvent légitimement nommer un param pareil (`:id`
// est un nom courant). Avec `Object.assign(params, m.params)` brut, un
// composant dont le `:id` est OPTIONNEL et ABSENT sur l'URL courante écrivait
// `id: undefined`, qui ÉCRASAIT la vraie valeur déjà posée par un AUTRE
// composant pour qui `:id` EST présent sur la même URL — l'ordre d'itération
// de `_mjs_awareComponents`/`comp.routes` (non garanti par le langage) décidait
// silencieusement laquelle des deux valeurs survivait.
//
// Fix : `_mjs_mergeParams(target, source)` remplace `Object.assign` aux deux
// sites d'agrégation (`_mjs_extractParams`, `_mjs_updateUrlStore`) — une valeur
// SOURCE undefined ne peut jamais écraser une valeur TARGET déjà définie.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER = join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts')
const routerSrc = readFileSync(ROUTER, 'utf-8')

describe('routeur — _mjs_mergeParams (fusion tolérante aux undefined)', function () {
  const µ: any = { log() {}, warn() {}, error() {} }
  new Function('µ', routerSrc)(µ)
  const merge = (target: any, source: any) => µ.Router._mjs_mergeParams(target, source)

  it("une valeur DÉFINIE dans target n'est PAS écrasée par undefined dans source", function () {
    const target = { id: '42' }
    merge(target, { id: undefined })
    assert.equal(target.id, '42', "AVANT le fix : Object.assign écrasait '42' par undefined")
  })

  it('une valeur DÉFINIE dans source écrase toujours target (comportement last-write-wins inchangé pour 2 valeurs réelles)', function () {
    const target = { id: '42' }
    merge(target, { id: '99' })
    assert.equal(target.id, '99')
  })

  it("source undefined sur une clé ABSENTE de target : la clé est posée à undefined (comportement inchangé)", function () {
    const target: any = {}
    merge(target, { id: undefined })
    assert.equal('id' in target, true)
    assert.equal(target.id, undefined)
  })

  it('fusionne les clés non conflictuelles normalement', function () {
    const target = { a: 1 }
    merge(target, { b: 2 })
    assert.deepEqual(target, { a: 1, b: 2 })
  })
})

describe('routeur — _mjs_extractParams : un id ABSENT sur une vue ne doit pas écraser un id PRÉSENT sur une autre', function () {
  const µ: any = { log() {}, warn() {}, error() {} }
  new Function('µ', routerSrc)(µ)

  // viewA : /users/:id → id TOUJOURS présent sur '/users/42'.
  // viewB : /users/:realId/(:id) → id ABSENT sur '/users/42' (pas de 3e segment),
  // mais réalId='42' capturé — la route matche bel et bien (prefix-ok), donc
  // les DEUX vues contribuent au même appel _mjs_extractParams.
  function makeComp(order: 'A-first' | 'B-first') {
    const routesAB = {
      viewA: { '/users/:id': 'UserModule' },
      viewB: { '/users/:realId/(:id)': 'NestedModule' },
    }
    const routesBA = {
      viewB: { '/users/:realId/(:id)': 'NestedModule' },
      viewA: { '/users/:id': 'UserModule' },
    }
    return { routes: order === 'A-first' ? routesAB : routesBA }
  }

  it("ordre A puis B : id reste '42' (pas écrasé par le undefined de viewB)", function () {
    const comp = makeComp('A-first')
    const params = µ.Router._mjs_extractParams(comp, '/users/42')
    assert.equal(params.id, '42', "AVANT le fix : le passage sur viewB (id optionnel absent) écrasait id='42' par undefined")
    assert.equal(params.realId, '42')
  })

  it("ordre B puis A (itération inverse) : id est TOUJOURS '42', peu importe l'ordre", function () {
    const comp = makeComp('B-first')
    const params = µ.Router._mjs_extractParams(comp, '/users/42')
    assert.equal(params.id, '42', 'le résultat ne doit PAS dépendre de l’ordre d’itération des vues')
    assert.equal(params.realId, '42')
  })
})
