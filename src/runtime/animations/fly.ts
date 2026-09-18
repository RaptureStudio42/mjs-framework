// animations/fly.coffee — port direct de Svelte fly.
(function(opts = {}) {
  var ref, ref1, ref2, setup, splitUnit, startOp, xUnit, xVal, yUnit, yVal;
  splitUnit = function(v) {
    var m;
    if (typeof v === 'number') {
      return [v, 'px'];
    } else {
      m = String(v).match(/^([\d.\-]+)(.*)$/);
      if (m) {
        return [parseFloat(m[1]), m[2] || 'px'];
      } else {
        return [parseFloat(v) || 0, 'px'];
      }
    }
  };
  startOp = (ref = opts.opacity) != null ? ref : 0;
  [xVal, xUnit] = splitUnit((ref1 = opts.x) != null ? ref1 : 0);
  [yVal, yUnit] = splitUnit((ref2 = opts.y) != null ? ref2 : 0);
  setup = function(node) {
    var baseTransform, ref3, ref4, ref5, style, targetOpacity;
    style = window.getComputedStyle(node);
    targetOpacity = +style.opacity;
    baseTransform = style.transform === 'none' ? '' : style.transform;
    return {
      delay: (ref3 = opts.delay) != null ? ref3 : 0,
      duration: (ref4 = opts.duration) != null ? ref4 : 400,
      easing: µ.easing.resolve(opts.easing),
      steps: (ref5 = opts.steps) != null ? ref5 : 60,
      css: function(t, u) {
        return {
          transform: `${baseTransform} translate(${u * xVal}${xUnit}, ${u * yVal}${yUnit})`.trim(),
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
