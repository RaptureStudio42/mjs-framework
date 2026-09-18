// animations/elastic_scale.coffee — scale avec easing elasticOut baked via µeasing.
// migré du WAAPI legacy `node.animate(…,
// {fill:'both'}).finished` (qui n'annulait JAMAIS l'Animation, ne posait pas
// `_mjs_transition_state` → accumulation d'Animations actives + toggles non
// arbitrés) vers le contrat factory `_isCfgFactory` comme fade/fly/scale : abort,
// continuité `t1 = prev.tValue()`, anti-flash et hygiène cancel hérités de
// `µ._mjs_runTransition`. `elasticOut` reste l'easing (samplé dans les keyframes).
(function(opts = {}) {
  var ref, ref1, ref2, ref3, setup, start;
  start = (ref = opts.start) != null ? ref : 0;
  setup = function(node) {
    return {
      delay: (ref1 = opts.delay) != null ? ref1 : 0,
      duration: (ref2 = opts.duration) != null ? ref2 : 1200,
      easing: µ.easing.elasticOut,
      steps: (ref3 = opts.steps) != null ? ref3 : 60,
      css: function(t, u) {
        return {
          transform: `scale(${start + (1 - start) * t})`,
          opacity: Math.min(Math.max(t * 2, 0), 1)
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
