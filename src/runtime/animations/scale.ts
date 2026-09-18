// animations/scale.coffee — port direct de Svelte scale.
(function(opts = {}) {
  var ref, ref1, sd, setup, start, startOp;
  start = (ref = opts.start) != null ? ref : 0;
  startOp = (ref1 = opts.opacity) != null ? ref1 : 0;
  sd = 1 - start;
  setup = function(node) {
    var baseTransform, od, ref2, ref3, ref4, style, targetOpacity;
    style = window.getComputedStyle(node);
    targetOpacity = +style.opacity;
    baseTransform = style.transform === 'none' ? '' : style.transform;
    od = targetOpacity * (1 - startOp);
    return {
      delay: (ref2 = opts.delay) != null ? ref2 : 0,
      duration: (ref3 = opts.duration) != null ? ref3 : 400,
      easing: µ.easing.resolve(opts.easing),
      steps: (ref4 = opts.steps) != null ? ref4 : 60,
      css: function(t, u) {
        return {
          transform: `${baseTransform} scale(${1 - sd * (1 - t)})`.trim(),
          opacity: targetOpacity - od * (1 - t)
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
