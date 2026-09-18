// LINT lintHandlerConstAssignment (transpiler/index.ts) NE VOYAIT QUE `=`.
//
// La garde qui refuse un handler réaffectant une CONSTANTE du `<script>` (`compteur := 0` en
// Civet, `const compteur` en JS) excluait PRÉCISÉMENT les opérateurs composés de sa regex
// (`(?<![!<>=+\-*/%&|^])=(?!=)`) : `compteur += 1` sur `compteur := 0` passait le build et
// plantait au premier clic (« Assignment to constant variable »), exactement l'échec que la
// garde prétend prévenir. Elle prenait aussi le `=` d'une flèche `=>` pour une affectation
// (`list.map(compteur => …)` refusé à tort).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('lintHandlerConstAssignment — opérateurs composés et incrément/décrément', function () {
  describe('REFUSÉS — une vraie affectation sur une constante du <script>', function () {
    it('compteur += 1', async function () {
      await assert.rejects(
        () => transpile("<script>\n  compteur := 0\n</script>\n<button @click={compteur += 1}>x</button>\n", { moduleName: 'card' }),
        /déclaré CONSTANT/,
      )
    })

    it('compteur ||= 1', async function () {
      await assert.rejects(
        () => transpile("<script>\n  compteur := 0\n</script>\n<button @click={compteur ||= 1}>x</button>\n", { moduleName: 'card' }),
        /déclaré CONSTANT/,
      )
    })

    it('compteur **= 2', async function () {
      await assert.rejects(
        () => transpile("<script>\n  compteur := 0\n</script>\n<button @click={compteur **= 2}>x</button>\n", { moduleName: 'card' }),
        /déclaré CONSTANT/,
      )
    })

    it('compteur++', async function () {
      await assert.rejects(
        () => transpile("<script>\n  compteur := 0\n</script>\n<button @click={compteur++}>x</button>\n", { moduleName: 'card' }),
        /déclaré CONSTANT/,
      )
    })

    it('--compteur', async function () {
      await assert.rejects(
        () => transpile("<script>\n  compteur := 0\n</script>\n<button @click={--compteur}>x</button>\n", { moduleName: 'card' }),
        /déclaré CONSTANT/,
      )
    })
  })

  describe('ACCEPTÉS — comparaison, flèche, propriété, nom distinct', function () {
    it('compteur == 1 (comparaison, dans une condition)', async function () {
      await transpile("<script>\n  compteur := 0\n</script>\n<button @click={if compteur == 1 then console.log('x')}>x</button>\n", { moduleName: 'card' })
    })

    it('compteur <= 1', async function () {
      await transpile("<script>\n  compteur := 0\n</script>\n<button @click={if compteur <= 1 then console.log('x')}>x</button>\n", { moduleName: 'card' })
    })

    it('x = compteur + 1 (compteur lu, pas réaffecté)', async function () {
      await transpile("<script>\n  compteur := 0\n</script>\n<button @click={x = compteur + 1}>x</button>\n", { moduleName: 'card' })
    })

    it('obj.compteur += 1 (propriété, pas la constante du <script>)', async function () {
      await transpile("<script>\n  compteur := 0\n</script>\n<button @click={obj = { compteur: 0 }; obj.compteur += 1}>x</button>\n", { moduleName: 'card' })
    })

    it('compteur2 += 1 (compteur2 déclaré `=`, pas une constante)', async function () {
      await transpile("<script>\n  compteur := 0\n  compteur2 = 0\n</script>\n<button @click={compteur2 += 1}>x</button>\n", { moduleName: 'card' })
    })

    it('list.map(compteur => compteur) — AVANT : le `=` de la flèche était pris pour une affectation', async function () {
      await transpile("<script>\n  compteur := 0\n</script>\n<button @click={list = [1, 2]; list.map(compteur => compteur)}>x</button>\n", { moduleName: 'card' })
    })
  })
})
