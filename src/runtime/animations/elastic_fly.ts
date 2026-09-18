// animations/elastic_fly.coffee — fly avec easing elasticOut baked via µeasing.
// migré du WAAPI legacy `node.animate(…,
// {fill:'both'}).finished` (qui n'annulait JAMAIS l'Animation, ne posait pas
// `_mjs_transition_state` → accumulation d'Animations actives + toggles non
// arbitrés) vers le contrat factory `_isCfgFactory` comme fade/fly/scale : abort,
// continuité `t1 = prev.tValue()`, anti-flash et hygiène cancel hérités de
// `µ._mjs_runTransition`. `elasticOut` reste l'easing (samplé dans les keyframes).
(function(opts = {}) {
  var ref, ref1, ref2, ref3, setup, y;
  y = (ref = opts.y) != null ? ref : 50;
  setup = function(node) {
    return {
      delay: (ref1 = opts.delay) != null ? ref1 : 0,
      duration: (ref2 = opts.duration) != null ? ref2 : 1000,
      easing: µ.easing.elasticOut,
      steps: (ref3 = opts.steps) != null ? ref3 : 60,
      css: function(t, u) {
        return {
          transform: `translateY(${u * y}px)`,
          opacity: Math.min(Math.max(t, 0), 1)
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
