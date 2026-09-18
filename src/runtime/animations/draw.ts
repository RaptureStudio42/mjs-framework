// animations/draw.coffee — port direct de Svelte draw (SVG paths).
(function(opts = {}) {
  var duration, setup, speed;
  speed = opts.speed;
  duration = opts.duration;
  setup = function(node) {
    var finalDuration, len, ref, ref1, ref2, ref3, style;
    // sur un non-SVG, `len` restait à 0 : no-op TOTAL et
    // silencieux, aucune erreur ni avertissement. Le no-op reste inoffensif
    // (aucun effet visuel de strokeDasharray/strokeDashoffset hors SVG) : on ne
    // le change pas, on arrête juste de le taire.
    if (typeof node.getTotalLength !== 'function') {
      µ.warn('@transition.draw ne s\'applique qu\'à un tracé SVG.');
    }
    len = (ref = typeof node.getTotalLength === "function" ? node.getTotalLength() : void 0) != null ? ref : 0;
    style = window.getComputedStyle(node);
    if (style.strokeLinecap !== 'butt') {
      len += parseInt(style.strokeWidth, 10) || 0;
    }
    finalDuration = duration != null ? typeof duration === 'function' ? duration(len) : duration : speed != null ? len / speed : 800;
    return {
      delay: (ref1 = opts.delay) != null ? ref1 : 0,
      duration: finalDuration,
      easing: µ.easing.resolve((ref2 = opts.easing) != null ? ref2 : µ.easing.cubicInOut),
      steps: (ref3 = opts.steps) != null ? ref3 : 60,
      css: function(t, u) {
        return {
          strokeDasharray: `${len}`,
          strokeDashoffset: `${u * len}`
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
