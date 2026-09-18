// Régression : `elastic_fly` / `elastic_scale`
// étaient les DEUX seuls built-ins encore en WAAPI legacy
// (`node.animate(…, { fill: 'both' }).finished`) — sans `cancel()` ni
// `_mjs_transition_state` → accumulation d'Animations actives dans la timeline
// du nœud (getAnimations() croît sans borne) + toggles non arbitrés (deux
// animations concurrentes superposées, aucune continuité). Migrés au contrat
// factory `_isCfgFactory` comme fade/fly/scale : abort, continuité `t1 =
// prev.tValue()`, anti-flash et hygiène cancel hérités de `µ._mjs_runTransition`.
//
// Test PUR (pas de WAAPI, absent sous happy-dom) : on charge chaque fichier via
// `new Function` (même branchement que le bundler `µ.anim.<nom> = <src>`), on
// invoque la factory et on inspecte la cfg produite + on verrouille l'absence
// du pattern legacy.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

;(globalThis as any).µ = (globalThis as any).µ || {}
const µ: any = (globalThis as any).µ
µ.debug = µ.debug ?? false
µ.warn = µ.warn || (() => {})
µ.log = µ.log || (() => {})
µ.error = µ.error || (() => {})
µ.Ticker = µ.Ticker || { add() {} }
µ._mjs_interpolatorSet = µ._mjs_interpolatorSet || new WeakSet()
await import('../src/runtime/mjs_easing.js') // µ.easing.elasticOut réel

function loadAnim(file: string): (opts?: any) => any {
  const src = readFileSync(join(__dirname, '..', 'src', 'runtime', 'animations', file), 'utf-8').trim().replace(/;\s*$/, '')
  return new Function('µ', `return (${src})`)(µ)
}

describe('elastic_fly / elastic_scale — migrés au contrat factory _isCfgFactory', function () {
  it('elastic_fly : intro/outro = même setup marqué _isCfgFactory (route via _mjs_runTransition, plus de legacy)', function () {
    const anim = loadAnim('elastic_fly.ts')({})
    assert.equal(typeof anim.intro, 'function')
    assert.equal(anim.intro, anim.outro, 'intro et outro pointent le MÊME setup')
    assert.equal((anim.intro as any)._isCfgFactory, true, 'setup marqué _isCfgFactory (routage _mjs_runTransition)')
  })

  it('elastic_fly : setup(node) renvoie une cfg CSS (css(t,u) + easing elasticOut) — ni intro/outro/tick', function () {
    const cfg = loadAnim('elastic_fly.ts')({ y: 40, duration: 800 }).intro({})
    assert.equal(typeof cfg.css, 'function')
    assert.equal(cfg.intro, undefined, 'pas de mode asymétrique (sinon path legacy)')
    assert.equal(cfg.tick, undefined, 'pas de mode tick')
    assert.equal(cfg.easing, µ.easing.elasticOut, 'easing elasticOut baked dans la cfg')
    assert.equal(cfg.duration, 800)
    // u = 1 - t. t=0 : invisible, décalé de y ; t=1 : opaque, en place.
    assert.deepEqual(cfg.css(0, 1), { transform: 'translateY(40px)', opacity: 0 })
    assert.deepEqual(cfg.css(1, 0), { transform: 'translateY(0px)', opacity: 1 })
  })

  it('elastic_scale : migré aussi (factory _isCfgFactory, css scale + opacity clampée à l\'overshoot elastic)', function () {
    const anim = loadAnim('elastic_scale.ts')({ start: 0.2, duration: 900 })
    assert.equal(anim.intro, anim.outro)
    assert.equal((anim.intro as any)._isCfgFactory, true)
    const cfg = anim.intro({})
    assert.equal(cfg.easing, µ.easing.elasticOut)
    assert.equal(cfg.duration, 900)
    assert.equal(cfg.intro, undefined)
    assert.equal(cfg.tick, undefined)
    // start=0.2 : t=0 → scale 0.2 opacity 0 ; t=1 → scale 1 opacity 1.
    assert.deepEqual(cfg.css(0, 1), { transform: 'scale(0.2)', opacity: 0 })
    assert.deepEqual(cfg.css(1, 0), { transform: 'scale(1)', opacity: 1 })
    // overshoot d'easing (t > 1) : opacité (t*2) clampée à 1.
    assert.equal(cfg.css(1.1, -0.1).opacity, 1)
  })

  it('plus aucune machine WAAPI legacy (buildKeyframes) dans les deux fichiers (verrou anti-régression)', function () {
    // `buildKeyframes` = marqueur unique de l'ancienne implémentation legacy
    // (les deux fichiers en avaient une) ; absent du code factory ET des
    // commentaires de migration (qui, eux, citent `{fill:'both'}` — d'où le
    // choix de ne PAS matcher `fill:both`, présent en prose).
    for (const f of ['elastic_fly.ts', 'elastic_scale.ts']) {
      const src = readFileSync(join(__dirname, '..', 'src', 'runtime', 'animations', f), 'utf-8')
      assert.doesNotMatch(src, /buildKeyframes/, `${f} : plus de machine keyframes legacy`)
      assert.match(src, /_isCfgFactory\s*=\s*true/, `${f} : setup marqué _isCfgFactory`)
      assert.match(src, /css:\s*function/, `${f} : cfg en mode css(t, u)`)
    }
  })
})
