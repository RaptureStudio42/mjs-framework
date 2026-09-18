import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// `_mjs_reconcileList` a quitté mjs_element.ts pour mjs_for.ts (détachement du bloc `{for}`,
// embarqué seulement si le projet en écrit, cf. bundler/index.ts) : le test structural suit.
const SRC = join(__dirname, '..', 'src', 'runtime', 'mjs_for.ts')

// Régression — outro dans un {for} : DEUX régimes selon `@flip`.
//
// • SANS `@flip` : le nœud mourant RESTE DANS LE FLUX à sa place (façon Svelte)
//   → il tient son créneau jusqu'à la fin de l'outro, puis est retiré → la liste
//   ne se referme qu'à ce moment. L'ancien code l'évacuait + l'épinglait en
//   `position: absolute` → les voisins comblaient le trou IMMÉDIATEMENT → super-
//   position (leçon transitions-differees 14-1, sans flip).
//
// • AVEC `@flip` : on GARDE l'évacuation + épinglage, car le FLIP a besoin que
//   les vivants reflowent PENDANT le reconcile (il mesure avant/après pour animer
//   le glissement). En flux, delta nul → pas de glissement (leçon animations 14-2).
//
// Le comportement réel (créneau tenu / glissement) exige rAF + layout → vérifié
// au navigateur (Playwright). Ici on verrouille les invariants au niveau source.
describe('régression — {for} : outro en flux (sans flip) vs évacué (avec flip)', function () {
  const src = readFileSync(SRC, 'utf-8')

  it('le régime est conditionné par `@flip` (__hasFlip = this.constructor._mjs_hasFlip)', function () {
    assert.match(src, /__hasFlip\s*=\s*this\.constructor\._mjs_hasFlip/, 'gate @flip absent')
  })

  it('AVEC flip : l\'épinglage absolute des dying est CONSERVÉ (sinon le FLIP ne glisse pas)', function () {
    assert.match(src, /if\s*\(__hasFlip\)/, 'la branche flip doit exister')
    assert.match(src, /µ\._mjs_fixPosition\(/, 'le pin absolute reste nécessaire au FLIP')
  })

  it('SANS flip : la réinsertion des vivants SAUTE les dying inline (skip _mjs_dying)', function () {
    assert.match(src, /while\s*\(__nsLiving\s*&&\s*__nsLiving\._mjs_dying\)/, 'le check nextSibling doit sauter les dying')
  })

  it('SANS flip : lastNode retombe sur endNode (dying laissés inline, pas en tail)', function () {
    assert.match(src, /lastNode\s*=\s*\(__hasFlip\s*&&\s*dyingTail\.length\s*>\s*0\)\s*\?\s*dyingTail\[0\]\s*:\s*endNode/, 'ancrage lastNode conditionnel au flip attendu')
  })
})
