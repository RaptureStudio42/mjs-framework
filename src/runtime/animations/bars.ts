// animations/bars.coffee — rideau de bandes qui tombent en cascade (clip-path), jumeau élément du rideau de page bars (mjs_vt_presets.ts)
(function(opts = {}) {
  var LENGTH, STAGGER, clamp01, count, dirRaw, direction, pct, polygon, pt, setup, total;
  STAGGER = 45;
  LENGTH = 260;
  pct = function(v) {
    return Math.round(v * 100) / 100;
  };
  clamp01 = function(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
  polygon = function(points) {
    return 'polygon(' + points.join(', ') + ')';
  };
  // point formaté clé (2 décimales, %)
  pt = function(x, y) {
    return pct(x) + '% ' + pct(y) + '%';
  };
  dirRaw = opts.dir != null ? opts.dir : opts.direction;
  if (dirRaw == null) {
    direction = 'down';
  } else if (dirRaw === 'left' || dirRaw === 'right' || dirRaw === 'up' || dirRaw === 'down') {
    direction = dirRaw;
  } else {
    µ.warn("[ModularJS] @transition.bars : direction invalide '"+ dirRaw +"' — repli 'down'.");
    direction = 'down';
  }
  count = opts.count != null ? Math.max(1, Math.round(opts.count)) : 8;
  total = (count - 1) * STAGGER + LENGTH;
  setup = function(node) {
    var delay, duration, easing, ref, ref1, ref2, ref3, steps;
    delay = (ref = opts.delay) != null ? ref : 0;
    duration = (ref1 = opts.duration) != null ? ref1 : 640;
    easing = (ref2 = opts.easing) != null ? ref2 : 'linear';
    steps = (ref3 = opts.steps) != null ? ref3 : 60;
    return {
      delay: delay,
      duration: duration,
      easing: µ.easing.resolve(easing),
      steps: steps,
      // cascade calculée ICI (pas par l'easing du cfg) : chute bande par bande, sommets en nombre constant
      css: function(t, u) {
        var e, i, points, pos, posNext;
        points = [];
        if (direction === 'up') {
          points.push(pt(0, 100));
          points.push(pt(100, 100));
          for (i = count - 1; i >= 0; i--) {
            e = µ.easing.cubicIn(clamp01((t * total - i * STAGGER) / LENGTH)) * 100;
            pos = i * 100 / count;
            posNext = (i + 1) * 100 / count;
            points.push(pt(posNext, 100 - e));
            points.push(pt(pos, 100 - e));
          }
        } else if (direction === 'right') {
          points.push(pt(0, 0));
          points.push(pt(0, 100));
          for (i = count - 1; i >= 0; i--) {
            e = µ.easing.cubicIn(clamp01((t * total - i * STAGGER) / LENGTH)) * 100;
            pos = i * 100 / count;
            posNext = (i + 1) * 100 / count;
            points.push(pt(e, posNext));
            points.push(pt(e, pos));
          }
        } else if (direction === 'left') {
          points.push(pt(100, 0));
          points.push(pt(100, 100));
          for (i = count - 1; i >= 0; i--) {
            e = µ.easing.cubicIn(clamp01((t * total - i * STAGGER) / LENGTH)) * 100;
            pos = i * 100 / count;
            posNext = (i + 1) * 100 / count;
            points.push(pt(100 - e, posNext));
            points.push(pt(100 - e, pos));
          }
        } else {
          points.push(pt(0, 0));
          points.push(pt(100, 0));
          for (i = count - 1; i >= 0; i--) {
            e = µ.easing.cubicIn(clamp01((t * total - i * STAGGER) / LENGTH)) * 100;
            pos = i * 100 / count;
            posNext = (i + 1) * 100 / count;
            points.push(pt(posNext, e));
            points.push(pt(pos, e));
          }
        }
        return {
          clipPath: polygon(points)
        };
      }
    };
  };
  setup._isCfgFactory = true;
  return {
    intro: setup,
    outro: setup
  };
});
