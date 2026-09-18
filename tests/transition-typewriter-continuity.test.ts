import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..', 'src', 'runtime', 'animations', 'typewriter.ts')

// Régression — leçon tuto `transitions-js` (9-5) : décocher puis recocher en
// pleine transition doit REPRENDRE depuis le caractère courant, pas repartir de
// 0. Ça n'est vrai que si le built-in typewriter route via `_mjs_runTransition`
// (mode tick avec continuité `t1 = prev.tValue()` + abort). L'ancienne version
// lançait une boucle rAF maison (`runTick`, `startTime`, progress remis à 0,
// aucun `_mjs_transition_state`) → toute interruption retombait à 0 char.
describe('régression — typewriter : continuité à l\'interruption (mode cfg-factory)', function () {
  const src = readFileSync(SRC, 'utf-8')

  it('expose un setup marqué _isCfgFactory (→ route via _mjs_runTransition)', function () {
    assert.match(src, /_isCfgFactory\s*=\s*true/, 'le setup doit être marqué _isCfgFactory')
  })

  it('renvoie intro: setup / outro: setup (même factory, pas de boucle directe)', function () {
    assert.match(src, /intro:\s*setup/, 'intro doit pointer le setup factory')
    assert.match(src, /outro:\s*setup/, 'outro doit pointer le setup factory')
  })

  it('le setup renvoie une cfg en mode tick (t → caractères visibles)', function () {
    assert.match(src, /tick:\s*function/, 'la cfg doit exposer un callback tick')
    assert.match(src, /slice\(0,\s*charsCount\)/, 'tick doit tronquer le texte selon t')
  })

  it('plus aucune boucle rAF maison legacy (runTick / startTime / requestAnimationFrame)', function () {
    assert.doesNotMatch(src, /runTick\s*=\s*function/, 'plus de runTick maison')
    assert.doesNotMatch(src, /startTime/, 'plus de gestion startTime maison')
    assert.doesNotMatch(src, /requestAnimationFrame\(/, 'la boucle est déléguée à _runTickTransition')
  })
})
