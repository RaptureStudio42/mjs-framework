import { strict as assert } from 'node:assert'
import { tokenize } from '../src/lexer/index.ts'

// `µXxx` PascalCase (µ collé à une classe/objet du framework) → `µ.Xxx`.
// Symétrique du sucre des runes minuscules ; permet la forme courte
// `µRouter.to '/x'`. Ne doit toucher NI les runes minuscules (µeffect,
// µeasing…) NI la forme déjà pointée `µ.Router`.
describe('lexer — µXxx PascalCase → µ.Xxx', function () {
  it('insère le point devant une PascalCase', function () {
    assert.equal(tokenize("µRouter.to '/x'"), "µ.Router.to '/x'")
    assert.equal(tokenize('new µStore()'), 'new µ.Store()')
    assert.equal(tokenize('µElement.prototype'), 'µ.Element.prototype')
  })

  it('est idempotent sur la forme déjà pointée', function () {
    assert.equal(tokenize("µ.Router.to '/x'"), "µ.Router.to '/x'")
  })

  it('ne touche pas les runes minuscules', function () {
    assert.equal(tokenize('µeasing.linear'), 'µeasing.linear')
    assert.equal(tokenize('µeffect => 1'), 'µeffect => 1')
  })
})
