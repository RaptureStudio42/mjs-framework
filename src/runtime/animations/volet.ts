// animations/volet.coffee — jumeau élément du préréglage de page volet (le contenu glisse dans sa propre boîte, transform + clip-path calés sur l'emplacement d'origine)
(function(opts = {}) {
  var dir, pct, ref, ref1, setup, valid;
  valid = ['left', 'right', 'up', 'down'];
  dir = (ref = opts.dir) != null ? ref : (ref1 = opts.direction) != null ? ref1 : 'down';
  if(valid.indexOf(dir) === -1) {
    µ.warn(`[ModularJS] @transition.volet : direction invalide '${dir}' — repli 'down'.`);
    dir = 'down';
  }
  pct = function(v) {
    return Math.round(v * 1000) / 1000;
  };
  setup = function(node) {
    var baseTransform, ref2, ref3, ref4, ref5, style;
    style = window.getComputedStyle(node);
    baseTransform = style.transform === 'none' ? '' : style.transform;
    return {
      delay: (ref2 = opts.delay) != null ? ref2 : 0,
      duration: (ref3 = opts.duration) != null ? ref3 : 380,
      easing: µ.easing.resolve((ref4 = opts.easing) != null ? ref4 : 'ease-out'),
      steps: (ref5 = opts.steps) != null ? ref5 : 60,
      css: function(t, u) {
        var map, p;
        p = pct(u * 100);
        map = {
          down: { transform: `${baseTransform} translateY(${-p}%)`.trim(), clipPath: `inset(${p}% 0 0 0)` },
          up: { transform: `${baseTransform} translateY(${p}%)`.trim(), clipPath: `inset(0 0 ${p}% 0)` },
          left: { transform: `${baseTransform} translateX(${p}%)`.trim(), clipPath: `inset(0 ${p}% 0 0)` },
          right: { transform: `${baseTransform} translateX(${-p}%)`.trim(), clipPath: `inset(0 0 0 ${p}%)` }
        };
        return map[dir];
      }
    };
  };
  setup._isCfgFactory = true;
  return {
    intro: setup,
    outro: setup
  };
});
