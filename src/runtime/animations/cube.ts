// animations/cube.coffee — jumeau élément du préréglage de page cube (les deux faces tournent rigidement autour du même axe enfoncé à mi-épaisseur, assombrissement synchronisé)
(function(opts = {}) {
  var dir, dirTable, pct, ref, ref1, setupIn, setupOut, valid;
  valid = ['left', 'right', 'up', 'down'];
  dir = (ref = opts.dir) != null ? ref : (ref1 = opts.direction) != null ? ref1 : 'left';
  if(valid.indexOf(dir) === -1) {
    µ.warn(`[ModularJS] @transition.cube : direction invalide '${dir}' — repli 'left'.`);
    dir = 'left';
  }
  pct = function(v) {
    return Math.round(v * 1000) / 1000 || 0;
  };
  dirTable = {
    left: { axis: 'Y', sign: 1 },
    right: { axis: 'Y', sign: -1 },
    up: { axis: 'X', sign: -1 },
    down: { axis: 'X', sign: 1 }
  };
  setupIn = function(node) {
    var baseTransform, d, origin, ref2, ref3, ref4, ref5, style, w;
    style = window.getComputedStyle(node);
    baseTransform = style.transform === 'none' ? '' : style.transform;
    d = dirTable[dir];
    w = d.axis === 'Y' ? node.offsetWidth : node.offsetHeight;
    origin = `50% 50% -${w / 2}px`;
    return {
      delay: (ref2 = opts.delay) != null ? ref2 : 0,
      duration: (ref3 = opts.duration) != null ? ref3 : 600,
      easing: µ.easing.resolve((ref4 = opts.easing) != null ? ref4 : 'cubic-bezier(.45,.05,.55,.95)'),
      steps: (ref5 = opts.steps) != null ? ref5 : 60,
      css: function(t, u) {
        return {
          transform: `${baseTransform} perspective(1600px) rotate${d.axis}(${pct(d.sign * 90 * (1 - t))}deg)`.trim(),
          filter: `brightness(${pct(0.35 + 0.65 * t)})`,
          backfaceVisibility: 'hidden',
          transformOrigin: origin
        };
      }
    };
  };
  setupOut = function(node) {
    var baseTransform, d, origin, ref6, ref7, ref8, ref9, style, w;
    style = window.getComputedStyle(node);
    baseTransform = style.transform === 'none' ? '' : style.transform;
    d = dirTable[dir];
    w = d.axis === 'Y' ? node.offsetWidth : node.offsetHeight;
    origin = `50% 50% -${w / 2}px`;
    queueMicrotask(function() {
      if (node._mjs_pairedWith && node.isConnected && typeof µ._mjs_fixPosition === 'function') {
        µ._mjs_fixPosition(node);
      }
    });
    return {
      delay: (ref6 = opts.delay) != null ? ref6 : 0,
      duration: (ref7 = opts.duration) != null ? ref7 : 600,
      easing: µ.easing.resolve((ref8 = opts.easing) != null ? ref8 : 'cubic-bezier(.45,.05,.55,.95)'),
      steps: (ref9 = opts.steps) != null ? ref9 : 60,
      css: function(t, u) {
        return {
          transform: `${baseTransform} perspective(1600px) rotate${d.axis}(${pct(-d.sign * 90 * u)}deg)`.trim(),
          filter: `brightness(${pct(1 - 0.65 * u)})`,
          backfaceVisibility: 'hidden',
          transformOrigin: origin
        };
      }
    };
  };
  setupIn._isCfgFactory = true;
  setupOut._isCfgFactory = true;
  return {
    intro: setupIn,
    outro: setupOut
  };
});
