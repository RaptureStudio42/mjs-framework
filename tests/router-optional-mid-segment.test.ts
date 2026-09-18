// Régression : un segment optionnel
// `(:x)` façon Rails placé au MILIEU d'une route (`/a/(:x)/b`, pas en toute
// fin) ne matchait JAMAIS correctement quand le paramètre était absent.
// L'ancienne boucle linéaire (position par position, SANS retour arrière)
// associait le segment optionnel au premier segment d'URL venu, sans jamais
// revenir sur ce choix si la suite échouait ensuite : `/a/(:x)/b` contre
// `/a/b` consommait `b` comme valeur de `:x`, puis échouait sur le littéral
// `b` manquant en fin de route — alors que `/a/b` DOIT matcher (x=undefined),
// exactement comme le ferait un `:x` optionnel EN FIN de route.
//
// Fix : `_mjs_matchRoute` délègue maintenant à `_matchSegs`, une fonction
// récursive AVEC backtracking — à chaque segment optionnel, elle essaie
// d'abord PRÉSENT (glouton), puis ABSENT si la suite échoue.
//
// Ce fichier couvre aussi un 2e correctif du même volet, dans la même
// fonction : un segment LITTÉRAL de route (`/café`) n'était jamais décodé
// avant comparaison, contrairement aux segments `:param` — une URL réelle
// contenant un littéral encodé (`/caf%C3%A9`) ne matchait jamais.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER = join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts')
const routerSrc = readFileSync(ROUTER, 'utf-8')

describe('routeur — segment optionnel MÉDIAN (backtracking)', function () {
  const µ: any = { log() {}, warn() {}, error() {} }
  new Function('µ', routerSrc)(µ)
  const match = (url: string, route: string): any => µ.Router._mjs_matchRoute(url, route)

  it("/a/(:x)/b contre /a/b : matche, x=undefined (AVANT le fix : rejeté, 'b' consommé comme valeur de x)", function () {
    const r = match('/a/b', '/a/(:x)/b')
    assert.equal(r.ok, true, "AVANT le fix : la boucle sans retour arrière consommait 'b' comme x, puis échouait sur le littéral final manquant")
    assert.equal(r.params.x, undefined)
  })

  it('/a/(:x)/b contre /a/5/b : matche, x=5 (le cas glouton/présent continue de fonctionner)', function () {
    const r = match('/a/5/b', '/a/(:x)/b')
    assert.equal(r.ok, true)
    assert.equal(r.params.x, '5')
  })

  it('/a/(:x)/b contre /a/b/c : rejette — le backtracking ne rattrape pas un segment en trop (match EXACT)', function () {
    // MATCH EXACT : les DEUX branches du retour arrière sont essayées
    // (x='b' puis littéral 'b' manquant ; x absent puis 'c' non consommé) et
    // aucune ne consomme `/c` — la route ne matche donc pas. Le retour arrière
    // reste bien actif : c'est lui qui a permis d'essayer les deux, cf. le test
    // `/a/b` juste au-dessus (qui, lui, matche).
    const r = match('/a/b/c', '/a/(:x)/b')
    assert.equal(r.ok, false, 'un segment d\'URL non consommé fait échouer la route — un sous-arbre se déclare avec `*`')
  })

  it('/a/(:x)/b/* contre /a/b/c : la MÊME route rendue explicitement préfixe matche (x=undefined, rest=c, all=[c])', function () {
    const r = match('/a/b/c', '/a/(:x)/b/*')
    assert.equal(r.ok, true, 'le catch-all explicite reste la façon de router un sous-arbre')
    assert.equal(r.params.x, undefined)
    assert.equal(r.params.rest, 'c')
    assert.deepEqual(r.params.all, ['c'])
  })

  it('/a/(:x)/b contre /a (pas assez de segments, même avec x absent) : rejette proprement', function () {
    const r = match('/a', '/a/(:x)/b')
    assert.equal(r.ok, false, "le littéral final 'b' reste obligatoire même quand x est absent")
  })

  it('deux segments optionnels médians consécutifs : /a/(:x)/(:y)/b contre /a/b (les deux absents)', function () {
    const r = match('/a/b', '/a/(:x)/(:y)/b')
    assert.equal(r.ok, true)
    assert.equal(r.params.x, undefined)
    assert.equal(r.params.y, undefined)
  })

  it('deux segments optionnels médians : /a/(:x)/(:y)/b contre /a/1/2/b (les deux présents)', function () {
    const r = match('/a/1/2/b', '/a/(:x)/(:y)/b')
    assert.equal(r.ok, true)
    assert.equal(r.params.x, '1')
    assert.equal(r.params.y, '2')
  })
})

describe('routeur — segment LITTÉRAL décodé avant comparaison', function () {
  const µ: any = { log() {}, warn() {}, error() {} }
  new Function('µ', routerSrc)(µ)
  const match = (url: string, route: string): any => µ.Router._mjs_matchRoute(url, route)

  it("/café (littéral, route écrite en clair) contre l'URL encodée /caf%C3%A9 : matche", function () {
    const r = match('/caf%C3%A9', '/café')
    assert.equal(r.ok, true, "AVANT le fix : le littéral décodé de la route n'était jamais comparé à l'URL décodée")
  })

  it("un littéral qui diverge VRAIMENT (même décodé) continue de rejeter", function () {
    const r = match('/caf%C3%A9', '/cafe')
    assert.equal(r.ok, false, "'café' (accent) et 'cafe' (sans accent) restent des littéraux différents")
  })

  it('un % mal formé dans un segment littéral ne fait pas planter le routeur (échoue proprement)', function () {
    assert.doesNotThrow(() => {
      const r = match('/%', '/a')
      assert.equal(r.ok, false)
    })
  })

  it('un % mal formé dans un segment paramétré ne fait pas planter le routeur (valeur brute en repli)', function () {
    const r = match('/%', '/:id')
    assert.equal(r.ok, true)
    assert.equal(r.params.id, '%', 'décodage impossible → valeur brute conservée (comportement déjà existant pour :param)')
  })
})
