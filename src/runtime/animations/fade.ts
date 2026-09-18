// animations/fade.coffee — port direct de Svelte fade.
(function(opts = {}) {
  var setup;
  setup = function(node) {
    var o, ref, ref1, ref2, ref3;
    o = +window.getComputedStyle(node).opacity;
    return {
      delay: (ref = opts.delay) != null ? ref : 0,
      duration: (ref1 = opts.duration) != null ? ref1 : 400,
      easing: µ.easing.resolve((ref2 = opts.easing) != null ? ref2 : µ.easing.linear),
      steps: (ref3 = opts.steps) != null ? ref3 : 60,
      css: function(t, u) {
        return {
          opacity: t * o
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
