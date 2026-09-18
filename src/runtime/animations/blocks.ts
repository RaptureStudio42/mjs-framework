// animations/blocks.coffee — damier de tuiles qui s'assemblent en vague diagonale (clip-path), jumeau élément du rideau de page blocks (mjs_vt_presets.ts)
(function(opts = {}) {
  var CORNERS, LENGTH, STAGGER, clamp01, cols, kmax, pct, polygon, pt, rows, setup, total;
  STAGGER = 40;
  LENGTH = 240;
  // ordre des 4 coins (sx, sy) autour du centre, avant rotation
  CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
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
  cols = opts.cols != null ? Math.max(1, Math.round(opts.cols)) : 6;
  rows = opts.rows != null ? Math.max(1, Math.round(opts.rows)) : 4;
  kmax = cols - 1 + rows - 1;
  total = kmax * STAGGER + LENGTH;
  setup = function(node) {
    var delay, duration, easing, h, rect, ref, ref1, ref2, ref3, steps, w;
    // mesure la boîte seulement pour garder les tuiles carrées durant la rotation
    rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
    w = rect && rect.width > 0 ? rect.width : 1;
    h = rect && rect.height > 0 ? rect.height : 1;
    delay = (ref = opts.delay) != null ? ref : 0;
    duration = (ref1 = opts.duration) != null ? ref1 : 620;
    easing = (ref2 = opts.easing) != null ? ref2 : 'linear';
    steps = (ref3 = opts.steps) != null ? ref3 : 60;
    return {
      delay: delay,
      duration: duration,
      easing: µ.easing.resolve(easing),
      steps: steps,
      // cascade calculée ICI : chaque tuile arrive tournée puis se pose droite, sommets en nombre constant
      css: function(t, u) {
        var cx, cy, dx, dy, e, firstCorners, hh, hw, i, k, m, n, p, points, rx, ry, s, sx, sy, theta, tileCorners, x, y;
        n = cols * rows;
        points = [];
        firstCorners = [];
        for (y = 0; y < rows; y++) {
          for (x = 0; x < cols; x++) {
            k = x + y;
            p = clamp01((t * total - k * STAGGER) / LENGTH);
            e = µ.easing.cubicOut(p);
            s = 1.02 * e;
            theta = -(Math.PI / 2) * (1 - e);
            cx = (x + 0.5) * 100 / cols;
            cy = (y + 0.5) * 100 / rows;
            hw = (w / cols / 2) * s;
            hh = (h / rows / 2) * s;
            tileCorners = [];
            for (i = 0; i < 4; i++) {
              sx = CORNERS[i][0];
              sy = CORNERS[i][1];
              dx = sx * hw;
              dy = sy * hh;
              rx = dx * Math.cos(theta) - dy * Math.sin(theta);
              ry = dx * Math.sin(theta) + dy * Math.cos(theta);
              tileCorners.push(pt(cx + rx / w * 100, cy + ry / h * 100));
            }
            for (i = 0; i < 4; i++) { points.push(tileCorners[i]); }
            points.push(tileCorners[0]);
            firstCorners.push(tileCorners[0]);
          }
        }
        // retour : repasse par les 1ers coins en sens inverse — chaque segment de liaison compte deux fois, aire nulle
        for (m = n - 2; m >= 1; m--) { points.push(firstCorners[m]); }
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
