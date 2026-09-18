// animations/turn.coffee — jumeau élément du préréglage de page turn (pli qui pivote au-delà de 90° sur le bord, la nouvelle remonte de l'ombre)
(function(opts = {}) {
  var dir, exitTable, pct, ref, ref1, setupIn, setupOut, valid;
  valid = ['left', 'right', 'up', 'down'];
  dir = (ref = opts.dir) != null ? ref : (ref1 = opts.direction) != null ? ref1 : 'left';
  if(valid.indexOf(dir) === -1) {
    µ.warn(`[ModularJS] @transition.turn : direction invalide '${dir}' — repli 'left'.`);
    dir = 'left';
  }
  pct = function(v) {
    return Math.round(v * 1000) / 1000 || 0;
  };
  exitTable = {
    left: { axis: 'Y', sign: -1, origin: 'left center' },
    right: { axis: 'Y', sign: 1, origin: 'right center' },
    up: { axis: 'X', sign: 1, origin: 'top center' },
    down: { axis: 'X', sign: -1, origin: 'bottom center' }
  };
  setupIn = function(node) {
    var ref2, ref3, ref4, ref5;
    return {
      delay: (ref2 = opts.delay) != null ? ref2 : 0,
      duration: (ref3 = opts.duration) != null ? ref3 : 600,
      easing: µ.easing.resolve((ref4 = opts.easing) != null ? ref4 : 'linear'),
      steps: (ref5 = opts.steps) != null ? ref5 : 60,
      css: function(t, u) {
        return {
          filter: `brightness(${pct(0.4 + 0.6 * t)})`
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
      duration: (ref7 = opts.duration) != null ? ref7 : 600,
      easing: µ.easing.resolve((ref8 = opts.easing) != null ? ref8 : 'ease-in'),
      steps: (ref9 = opts.steps) != null ? ref9 : 60,
      css: function(t, u) {
        return {
          transform: `${baseTransform} perspective(1300px) rotate${d.axis}(${pct(d.sign * 160 * u)}deg)`.trim(),
          transformOrigin: d.origin,
          backfaceVisibility: 'hidden',
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
