import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VAULT = join(__dirname, '..', 'src', 'runtime', 'mjs_store_globals.ts')

// µ.online / µ.visible / µ.ready : état d'environnement réactif, exposé à plat
// sous µ.* (pas de µ.app), adossé au µ.state caché µ._mjs_env, lecture seule.
describe('runtime — µ.online / µ.visible / µ.ready', function () {
  const vault = readFileSync(VAULT, 'utf-8')

  it('adosse les 3 champs à un µ.state caché µ._mjs_env', function () {
    assert.match(vault, /µ\._mjs_env = µ\.state\(\{[\s\S]*online:[\s\S]*visible:[\s\S]*ready:/, 'µ._mjs_env = µ.state({online, visible, ready})')
  })

  it('expose des getters À PLAT sur µ (lecture seule, pas de setter)', function () {
    assert.match(vault, /Object\.defineProperty\(µ, name, \{ configurable: true, get:/, 'getter défini sur µ')
    assert.match(vault, /__mjsEnvGetter\('online'\); __mjsEnvGetter\('visible'\); __mjsEnvGetter\('ready'\)/, 'les 3 exposés à plat')
    assert.doesNotMatch(vault, /µ\.app\./, 'PAS de µ.app.*')
  })

  it('câble les évènements navigateur', function () {
    assert.match(vault, /addEventListener\('online',[\s\S]*µ\._mjs_env\.online = true/, 'online')
    assert.match(vault, /addEventListener\('offline',[\s\S]*µ\._mjs_env\.online = false/, 'offline')
    assert.match(vault, /addEventListener\('visibilitychange'/, 'visibilitychange')
    assert.match(vault, /addEventListener\('load', function\(\) \{ µ\._mjs_env\.ready = true/, 'ready sur load')
  })

  it('idempotent (garde !µ._mjs_env) + garde SSR', function () {
    assert.match(vault, /typeof window !== 'undefined' && µ\.state && !µ\._mjs_env/, 'garde window+state+idempotence')
  })
})
