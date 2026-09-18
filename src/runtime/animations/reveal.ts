// animations/reveal.coffee — jumeau élément du préréglage de page reveal (l'ancienne sort au-dessus en s'échappant, la nouvelle remonte depuis un retrait en ombre)
(function(opts = {}) {
  var dir, exitTable, pct, ref, ref1, setupIn, setupOut, valid;
  valid = ['left', 'right', 'up', 'down'];
  dir = (ref = opts.dir) != null ? ref : (ref1 = opts.direction) != null ? ref1 : 'up';
  if(valid.indexOf(dir) === -1) {
    µ.warn(`[ModularJS] @transition.reveal : direction invalide '${dir}' — repli 'up'.`);
    dir = 'up';
  }
  pct = function(v) {
    return Math.round(v * 1000) / 1000 || 0;
  };
  exitTable = {
    up: { axis: 'Y', sign: -1 },
    down: { axis: 'Y', sign: 1 },
    left: { axis: 'X', sign: -1 },
    right: { axis: 'X', sign: 1 }
  };
  setupIn = function(node) {
    var baseTransform, ref2, ref3, ref4, ref5, style;
    style = window.getComputedStyle(node);
    baseTransform = style.transform === 'none' ? '' : style.transform;
    return {
      delay: (ref2 = opts.delay) != null ? ref2 : 0,
      duration: (ref3 = opts.duration) != null ? ref3 : 380,
      easing: µ.easing.resolve((ref4 = opts.easing) != null ? ref4 : 'ease-in'),
      steps: (ref5 = opts.steps) != null ? ref5 : 60,
      css: function(t, u) {
        return {
          transform: `${baseTransform} scale(${pct(0.92 + 0.08 * t)})`.trim(),
          filter: `brightness(${pct(0.5 + 0.5 * t)})`
        };
      }
    };
  };
  setupOut = function(node) {
    var baseTransform, d, ref6, ref7, ref8, ref9, style;
    style = window.getComputedStyle(node);
    baseTransform = style.transform === 'none' ? '' : style.transform;
    d = exitTable[dir];
    queueMicrotask(function() {
      if (node._mjs_pairedWith && node.isConnected && typeof µ._mjs_fixPosition === 'function') {
        µ._mjs_fixPosition(node);
      }
    });
    return {
      delay: (ref6 = opts.delay) != null ? ref6 : 0,
      duration: (ref7 = opts.duration) != null ? ref7 : 380,
      easing: µ.easing.resolve((ref8 = opts.easing) != null ? ref8 : 'ease-in'),
      steps: (ref9 = opts.steps) != null ? ref9 : 60,
      css: function(t, u) {
        return {
          transform: `${baseTransform} translate${d.axis}(${pct(d.sign * 100 * u)}%)`.trim(),
          zIndex: 1
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
