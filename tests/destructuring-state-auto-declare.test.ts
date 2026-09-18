// L'ÉCHANGE DE DEUX ÉTATS CASSAIT LA PASSE D'AUTO-DÉCLARATION.
//
// Pass 4 d'`applyMjsSugarToScript` (auto-déclaration scope-aware, mimique le `var`-hoist de Coffee)
// extrayait les noms d'un motif de destructuration par une regex qui sautait le `$` sans le voir
// (`[a-zA-Z_]\w*`) : `[$a, $b] = [$b, $a]` (échange de deux états) était donc promu en déclaration
// `.=` — Civet compilait `let [$.a, $.b] = […]`, syntaxe INVALIDE (liaison sur un membre, pas sur un
// identifiant), rejetée par l'analyseur JS en aval sans le moindre indice utile
// (« [analyzer] parse error: Unexpected token »). Un motif MIXTE (une cible membre + un vrai nom
// local, ex. `[$a, tmp] = […]`) avait le même problème côté `tmp`. Côté handler (`@click={…}`), le
// bogue ne faisait PAS échouer le build : il posait un écouteur qui embarquait du JS invalide, cassé
// seulement au premier clic, dans le navigateur.
//
// Remède : une cible MEMBRE du motif (`$a` état, `$$a` store, `§a`/`§§a` contexte, `@a` this — sous
// forme collée OU déjà réécrite en pointillé `$.a`, cf. plus bas) n'est jamais une variable à
// déclarer ; une `clé:` d'un motif objet n'en est pas une non plus.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('Pass 4 — destructuration sur une cible MEMBRE ($/§/@), jamais déclarée à tort', function () {
  it('un échange de deux états ([$a, $b] = [$b, $a]) dans une fonction résout', async function () {
    const { output } = await transpile("<script>\n  $a = 1\n  $b = 2\n  swap = ->\n    [$a, $b] = [$b, $a]\n</script>\n<button @click={swap()}>{$a} {$b}</button>\n", { moduleName: 'card' })
    assert.doesNotMatch(output, /let \[\$\.a/, 'jamais de liaison `let` sur une cible membre — JS invalide')
    // transform-reactive.ts réécrit cette affectation en `_set` — les deux formes sont correctes
    // selon qu'il a atterri ou non au moment du test, seule la déclaration invalide est prohibée ci-dessus
    assert.match(output, /\[\$\.a, \$\.b\] = \[\$\.b, \$\.a\]|_mjsD0/, 'attend la forme nue $.a OU la réécriture _set (_mjsD0)')
  })

  it('un motif objet ({a: $a, b: $b} = o) dans une fonction résout', async function () {
    const { output } = await transpile("<script>\n  $a = 1\n  $b = 2\n  swap = ->\n    o = { a: 3, b: 4 }\n    {a: $a, b: $b} = o\n</script>\n<button @click={swap()}>{$a} {$b}</button>\n", { moduleName: 'card' })
    assert.doesNotMatch(output, /let \{a: \$\.a/, 'jamais de liaison `let` sur une clé du motif — JS invalide')
  })

  it('un motif MIXTE ([$a, tmp] = […]) dans une fonction résout, tmp hissé et déclaré, l\'affectation reste nue', async function () {
    const { output } = await transpile("<script>\n  $a = 1\n  swap = ->\n    [$a, tmp] = [3, 4]\n    console.log(tmp)\n</script>\n<button @click={swap()}>{$a}</button>\n", { moduleName: 'card' })
    assert.doesNotMatch(output, /let \[\$\.a/, 'jamais de liaison `let` sur la cible membre du motif mixte')
    assert.match(output, /let tmp = undefined/, 'tmp est hissé en tête de fonction (pendingHoists), pas déclaré sur la ligne de destructuration')
  })

  it('non-régression — [x, y] = [1, 2] top-level (noms ordinaires) reste déclaré', async function () {
    const { output } = await transpile("<script>\n  [x, y] = [1, 2]\n  console.log(x, y)\n</script>\n<button>x</button>\n", { moduleName: 'card' })
    assert.match(output, /let \[x, y\] = \[1, 2\]/, 'forme actuelle avant le correctif — DOIT être inchangée')
  })

  it('non-régression — un swap ([x, y] = [y, x]) sur deux noms déjà déclarés reste nu', async function () {
    const { output } = await transpile("<script>\n  x = 1\n  y = 2\n  [x, y] = [y, x]\n  console.log(x, y)\n</script>\n<button>x</button>\n", { moduleName: 'card' })
    assert.match(output, /\[x, y\] = \[y, x\]/)
    assert.doesNotMatch(output, /let \[x, y\] = \[y, x\]/, 'x et y sont déjà déclarés — jamais de re-déclaration')
  })

  it('un handler (@click={[$a, $b] = [$b, $a]}) résout', async function () {
    const { output } = await transpile("<script>\n  $a = 1\n  $b = 2\n</script>\n<button @click={[$a, $b] = [$b, $a]}>{$a} {$b}</button>\n", { moduleName: 'card' })
    assert.doesNotMatch(output, /let \[\$\.a/, 'AVANT : `let [$.a, $.b] = […]` posait un écouteur cassé, muet au build')
  })

  it('un échange au top-level du <script> (hors fonction) résout', async function () {
    const { output } = await transpile("<script>\n  $a = 1\n  $b = 2\n  [$a, $b] = [$b, $a]\n</script>\n<button>{$a} {$b}</button>\n", { moduleName: 'card' })
    assert.doesNotMatch(output, /let \[\$\.a/)
  })

  it('le chemin Coffee (<script lang="coffee">) reste inchangé, toujours résolu', async function () {
    const { output } = await transpile("<script lang=\"coffee\">\n  $a = 1\n  $b = 2\n  swap = ->\n    [$a, $b] = [$b, $a]\n</script>\n<button @click={swap()}>{$a} {$b}</button>\n", { moduleName: 'card' })
    assert.ok(output.length > 0, 'Pass 4 SKIP pour Coffee — la voie native gère déjà ce cas')
  })
})

// Un motif sur le STORE écrit DIRECTEMENT dans un handler ne compilait pas : `$$a` en
// handler ne réécrit pas en pointillé sigil (`$.a`) comme l'état, mais directement en `µ.store.a` — `µ` hors de portée
// de memberRe, `store`/`a` (précédés d'un `.`) passaient pour des noms nus et se faisaient promouvoir `.=` → Civet
// émettait `let [µ.store.a, µ.store.b] = […]`, JS invalide. Remède : tout chemin pointé (`µ.store.x`, `this.x`,
// `_mjsThis.x`, `obj.k`) est une cible MEMBRE, racine comprise, jamais une variable à déclarer.
describe('Pass 4 — destructuration sur un chemin pointé (µ.store.x / this.x / obj.k), jamais déclaré à tort', function () {
  it('un handler store DIRECT (@click={[$$a, $$b] = [$$b, $$a]}) résout, réécrit en µ._storeSet', async function () {
    const { output } = await transpile("<script>\n  $$a = 1\n  $$b = 2\n</script>\n<button @click={[$$a, $$b] = [$$b, $$a]}>{$$a} {$$b}</button>\n", { moduleName: 'card' })
    assert.doesNotMatch(output, /let \[µ\.store\.a/, 'AVANT : `let [µ.store.a, µ.store.b] = […]` — JS invalide, écouteur cassé au premier clic, muet au build')
    assert.match(output, /µ\._storeSet\("a", _mjsS0\)/, 'path-tracker réécrit la ligne nue en IIFE _storeSet')
  })

  it('un échange de store dans une fonction du <script> (swap = -> […]) résout, réécrit en µ._storeSet', async function () {
    const { output } = await transpile("<script>\n  $$a = 1\n  $$b = 2\n  swap = ->\n    [$$a, $$b] = [$$b, $$a]\n</script>\n<button @click={swap()}>{$$a} {$$b}</button>\n", { moduleName: 'card' })
    assert.doesNotMatch(output, /let \[µ\.store\.a/)
    assert.match(output, /µ\._storeSet\("a", _mjsS0\)/)
  })

  it('un motif MIXTE en handler ([$a, $$b] = [1, 2]) résout — $.a intact, $$b réécrit en µ._storeSet', async function () {
    const { output } = await transpile("<script>\n  $a = 1\n  $$b = 2\n</script>\n<button @click={[$a, $$b] = [1, 2]}>{$a} {$$b}</button>\n", { moduleName: 'card' })
    assert.doesNotMatch(output, /let \[\$\.a/, 'jamais de liaison `let` sur la cible membre $.a')
    assert.doesNotMatch(output, /let \[.*µ\.store\.b/, 'jamais de liaison `let` sur la cible membre µ.store.b')
    assert.doesNotMatch(output, /let store = undefined/, 'AVANT : `store` (fragment de µ.store.b) hissé à tort comme un nom')
    assert.doesNotMatch(output, /let b = undefined/, 'AVANT : `b` (segment pointé de µ.store.b) hissé à tort comme un nom')
    assert.match(output, /µ\._storeSet\("b", _mjsS0\)/, 'le côté store est réécrit en IIFE _storeSet')
    assert.match(output, /µ\._set\(_mjsThis, 'a', _mjsD0\)/, 'le côté état ($a) est réécrit en _set (transform-reactive.ts)')
  })

  it('[@a, @b] = [1, 2] (this) dans un handler résout, pas de `let [`', async function () {
    const { output } = await transpile("<script>\n  a = 1\n  b = 2\n</script>\n<button @click={[@a, @b] = [1, 2]}>{a} {b}</button>\n", { moduleName: 'card' })
    assert.doesNotMatch(output, /let \[this\.a/, 'this.a/this.b sont des cibles MEMBRE — jamais de let sur une propriété')
    assert.match(output, /this\.a/, 'la réécriture @a → this.a a bien eu lieu')
  })

  it('un chemin pointé ordinaire ([obj.k, tmp] = […]) dans une fonction résout, tmp hissé, obj.k jamais déclaré', async function () {
    const { output } = await transpile("<script>\n  obj = { k: 0 }\n  useIt = ->\n    [obj.k, tmp] = [1, 2]\n    console.log(tmp)\n</script>\n<button @click={useIt()}>{obj}</button>\n", { moduleName: 'card' })
    assert.doesNotMatch(output, /let \[obj\.k/, 'jamais de liaison `let` sur la cible MEMBRE obj.k')
    assert.match(output, /let tmp = undefined/, 'tmp est hissé en tête de fonction, pas déclaré sur la ligne de destructuration')
  })
})
