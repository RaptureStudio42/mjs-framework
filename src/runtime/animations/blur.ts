// animations/blur.coffee — port direct de Svelte blur.
(function(opts = {}) {
  var aUnit, aVal, amount, ref, ref1, setup, splitUnit, startOp;
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
  amount = (ref = opts.amount) != null ? ref : 5;
  startOp = (ref1 = opts.opacity) != null ? ref1 : 0;
  [aVal, aUnit] = splitUnit(amount);
  setup = function(node) {
    var baseFilter, ref2, ref3, ref4, ref5, style, targetOpacity;
    style = window.getComputedStyle(node);
    targetOpacity = +style.opacity;
    baseFilter = style.filter === 'none' ? '' : style.filter;
    return {
      delay: (ref2 = opts.delay) != null ? ref2 : 0,
      duration: (ref3 = opts.duration) != null ? ref3 : 400,
      easing: µ.easing.resolve((ref4 = opts.easing) != null ? ref4 : µ.easing.cubicInOut),
      steps: (ref5 = opts.steps) != null ? ref5 : 60,
      css: function(t, u) {
        return {
          opacity: (targetOpacity - startOp) * t + startOp,
          filter: `${baseFilter} blur(${u * aVal}${aUnit})`.trim()
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
