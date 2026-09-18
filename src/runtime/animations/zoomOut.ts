// animations/zoomOut.coffee — jumeau élément du préréglage de page zoom-out (retombe de 145 % en s'opacifiant)
(function(opts = {}) {
  var ref, ref1, setup, start, startOp;
  start = (ref = opts.start) != null ? ref : 1.45;
  startOp = (ref1 = opts.opacity) != null ? ref1 : 0;
  setup = function(node) {
    var baseTransform, ref2, ref3, ref4, ref5, style, targetOpacity;
    style = window.getComputedStyle(node);
    targetOpacity = +style.opacity;
    baseTransform = style.transform === 'none' ? '' : style.transform;
    return {
      delay: (ref2 = opts.delay) != null ? ref2 : 0,
      duration: (ref3 = opts.duration) != null ? ref3 : 450,
      easing: µ.easing.resolve((ref4 = opts.easing) != null ? ref4 : 'cubic-bezier(0.2, 0.7, 0.3, 1)'),
      steps: (ref5 = opts.steps) != null ? ref5 : 60,
      css: function(t, u) {
        return {
          transform: `${baseTransform} scale(${start + (1 - start) * t})`.trim(),
          opacity: targetOpacity - (targetOpacity - startOp) * u
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
