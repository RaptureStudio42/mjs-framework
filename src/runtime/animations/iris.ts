// animations/iris.coffee — rond qui s'ouvre au centre, jumeau « sur un élément » du rideau de page iris (mjs_vt_presets.ts)
(function(opts = {}) {
  var pct, setup;
  pct = function(v) {
    return Math.round(v * 1000) / 1000;
  };
  setup = function(node) {
    var ref, ref1, ref2, ref3;
    return {
      delay: (ref = opts.delay) != null ? ref : 0,
      duration: (ref1 = opts.duration) != null ? ref1 : 380,
      easing: µ.easing.resolve((ref2 = opts.easing) != null ? ref2 : 'ease-out'),
      steps: (ref3 = opts.steps) != null ? ref3 : 60,
      css: function(t, u) {
        // 72% > 70,71% (distance du coin en unités circle()) : à t=1 la boîte entière est visible
        return {
          clipPath: `circle(${pct(t * 72)}% at 50% 50%)`
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
