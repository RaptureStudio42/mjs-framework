// animations/flip.coffee — jumeau élément du préréglage de page flip (retournement en place, passation exacte à mi-course par backface-visibility)
(function(opts = {}) {
  var dir, dirTable, pct, ref, ref1, setupIn, setupOut, valid;
  valid = ['left', 'right', 'up', 'down'];
  dir = (ref = opts.dir) != null ? ref : (ref1 = opts.direction) != null ? ref1 : 'left';
  if(valid.indexOf(dir) === -1) {
    µ.warn(`[ModularJS] @transition.flip : direction invalide '${dir}' — repli 'left'.`);
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
    var baseTransform, d, ref2, ref3, ref4, ref5, style;
    style = window.getComputedStyle(node);
    baseTransform = style.transform === 'none' ? '' : style.transform;
    d = dirTable[dir];
    return {
      delay: (ref2 = opts.delay) != null ? ref2 : 0,
      duration: (ref3 = opts.duration) != null ? ref3 : 550,
      easing: µ.easing.resolve((ref4 = opts.easing) != null ? ref4 : 'ease-in-out'),
      steps: (ref5 = opts.steps) != null ? ref5 : 60,
      css: function(t, u) {
        var angle;
        angle = t < 0.5 ? d.sign * 90 : d.sign * 180 * (1 - t);
        return {
          transform: `${baseTransform} perspective(1200px) rotate${d.axis}(${pct(angle)}deg)`.trim(),
          backfaceVisibility: 'hidden',
          transformOrigin: '50% 50%'
        };
      }
    };
  };
  setupOut = function(node) {
    var baseTransform, d, ref6, ref7, ref8, ref9, style;
    style = window.getComputedStyle(node);
    baseTransform = style.transform === 'none' ? '' : style.transform;
    d = dirTable[dir];
    queueMicrotask(function() {
      if (node._mjs_pairedWith && node.isConnected && typeof µ._mjs_fixPosition === 'function') {
        µ._mjs_fixPosition(node);
      }
    });
    return {
      delay: (ref6 = opts.delay) != null ? ref6 : 0,
      duration: (ref7 = opts.duration) != null ? ref7 : 550,
      easing: µ.easing.resolve((ref8 = opts.easing) != null ? ref8 : 'ease-in-out'),
      steps: (ref9 = opts.steps) != null ? ref9 : 60,
      css: function(t, u) {
        var angle;
        angle = u < 0.5 ? -d.sign * 180 * u : -d.sign * 90;
        return {
          transform: `${baseTransform} perspective(1200px) rotate${d.axis}(${pct(angle)}deg)`.trim(),
          backfaceVisibility: 'hidden',
          transformOrigin: '50% 50%'
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
