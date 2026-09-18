// Régression — le FLASH d'intro des transitions CSS (mode `css(t,u)` via WAAPI)
// ne doit PLUS jamais revenir.
//
// Bug vécu (leçon tuto `transitions-css`) : en recochant la case, l'élément
// était peint dans son état NATUREL (texte blanc, scale 1) ~1 frame AVANT que
// l'animation `spin` ne démarre (depuis scale 0). Cause : la branche css de
// `µ._mjs_runTransition` faisait UN SEUL `node.animate(keyframes, {duration, delay,
// fill:'forwards'})` → WAAPI ne pose pas le frame de départ avant le 1er paint.
//
// Fix (mécanisme Svelte à l'identique, cf. sveltejs/svelte#14732) : on crée
// d'abord une animation "bidon" de la durée du `delay` (même 0), dont les
// keyframes ne contiennent QUE le frame de départ `startFrame`, avec
// `fill:'forwards'`. Elle finit aussitôt et fige son dernier frame → l'élément
// est épinglé à t1 DÈS sa création, donc AVANT le 1er paint. On bascule sur la
// vraie animation à son `finished`.
//
// Comme `transition-intro-when-layouted.test.ts`, on lit la source de
// `mjs_easing.ts` et on garantit la structure (l'exécuter exigerait un vrai
// navigateur — WAAPI n'existe pas sous happy-dom).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('régression — pas de flash d\'intro sur les transitions CSS (WAAPI)', function () {
  const path = join(
    import.meta.dirname ?? new URL('.', import.meta.url).pathname,
    '..', 'src', 'runtime', 'mjs_easing.ts',
  )
  const src = readFileSync(path, 'utf-8')

  it('calcule le frame de départ startFrame = cfg.css(t1, 1 - t1)', function () {
    assert.match(src, /startFrame\s*=\s*cfg\.css\(\s*t1\s*,\s*1\s*-\s*t1\s*\)/,
      'doit isoler le frame de départ pour l\'animation bidon')
  })

  it('crée l\'animation "bidon" fill:forwards (duration: delay) AVANT la vraie animation', function () {
    // node.animate([startFrame, startFrame], { duration: delay, fill: 'forwards' })
    assert.match(
      src,
      /node\.animate\(\s*\[\s*startFrame\s*,\s*startFrame\s*\]\s*,\s*\{[^}]*duration:\s*delay[^}]*fill:\s*['"]forwards['"]/,
      "doit créer l'anim bidon node.animate([startFrame, startFrame], {duration: delay, fill:'forwards'})",
    )
    const dummyIdx = src.search(/node\.animate\(\s*\[\s*startFrame\s*,\s*startFrame\s*\]/)
    const mainIdx = src.search(/node\.animate\(\s*keyframes\s*,/)
    assert.ok(dummyIdx >= 0, 'anim bidon présente')
    assert.ok(mainIdx >= 0, 'vraie animation (keyframes) présente')
    assert.ok(dummyIdx < mainIdx, "l'anim bidon doit PRÉCÉDER la vraie animation")
  })

  it('la vraie animation ne reçoit plus `delay` (porté par la bidon) — fin de l\'anti-pattern', function () {
    assert.doesNotMatch(
      src,
      /node\.animate\(\s*keyframes\s*,\s*\{[^}]*\bdelay\b/,
      "le `delay` ne doit plus être passé à la vraie animation (sinon le flash revient)",
    )
  })
})
