// animations/slide.coffee — port direct de Svelte 5 `slide`.

// Nouveau contract aligné Svelte : retourne un *config* avec css(t, u) au
// lieu d'une Promise. Le runtime (`µ._mjs_runTransition`) gère le sampling des
// keyframes, l'abort des animations en cours et le rebuild from current `t`
// pour les transitions interrompues — exactement le pattern Svelte
// (counterpart?.t() puis t1 + delta * easing(i/n)).
(function(opts = {}) {
  var axis, cap, capture, cssFor, ref, ref1, setup, steps;
  axis = (ref = opts.axis) != null ? ref : 'y';
  steps = (ref1 = opts.steps) != null ? ref1 : 60;
  cap = function(s) {
    return s[0].toUpperCase() + s.slice(1);
  };
  capture = function(node) {
    var _force, cs, primary, primaryValue, secondary, style;
    // Force un sync layout AVANT de lire — le browser peut différer la
    // mesure du content text au prochain frame, donnant 'auto'/0 sinon.
    // Lire `offsetHeight` est l'idiome standard pour forcer ce reflow.
    _force = axis === 'y' ? node.offsetHeight : node.offsetWidth;
    style = window.getComputedStyle(node);
    primary = axis === 'y' ? 'height' : 'width';
    secondary = axis === 'y' ? ['top', 'bottom'] : ['left', 'right'];
    cs = secondary.map(cap);
    primaryValue = parseFloat(style[primary]);
    if (!isFinite(primaryValue)) {
      primaryValue = axis === 'y' ? node.offsetHeight : node.offsetWidth;
    }
    return {
      opacity: +style.opacity,
      primary,
      primary_value: primaryValue,
      cs,
      padding_start: parseFloat(style[`padding${cs[0]}`]) || 0,
      padding_end: parseFloat(style[`padding${cs[1]}`]) || 0,
      margin_start: parseFloat(style[`margin${cs[0]}`]) || 0,
      margin_end: parseFloat(style[`margin${cs[1]}`]) || 0,
      border_start: parseFloat(style[`border${cs[0]}Width`]) || 0,
      border_end: parseFloat(style[`border${cs[1]}Width`]) || 0
    };
  };
  cssFor = function(s, t) {
    var f;
    f = {
      overflow: 'hidden',
      opacity: Math.min(t * 20, 1) * s.opacity
    };
    f[s.primary] = `${t * s.primary_value}px`;
    f[`padding${s.cs[0]}`] = `${t * s.padding_start}px`;
    f[`padding${s.cs[1]}`] = `${t * s.padding_end}px`;
    f[`margin${s.cs[0]}`] = `${t * s.margin_start}px`;
    f[`margin${s.cs[1]}`] = `${t * s.margin_end}px`;
    f[`border${s.cs[0]}Width`] = `${t * s.border_start}px`;
    f[`border${s.cs[1]}Width`] = `${t * s.border_end}px`;
    f[`min${cap(s.primary)}`] = '0px';
    return f;
  };
  setup = function(node) {
    var ref2, ref3, s;
    s = capture(node);
    return {
      delay: (ref2 = opts.delay) != null ? ref2 : 0,
      duration: (ref3 = opts.duration) != null ? ref3 : 400,
      easing: µ.easing.resolve(opts.easing),
      steps,
      css: function(t, u) {
        return cssFor(s, t);
      }
    };
  };
  // Marker : `setup` retourne un descripteur (pas une Promise/fonction
  // legacy). Le binding_transition l'appelle UNE FOIS au mount du node
  // pour capturer les dims naturelles, puis stocke le cfg. Sans ça, on
  // capturait les dims animées (h figée par fill: forwards) et chaque
  // play recapturait des valeurs de plus en plus dégradées.
  setup._isCfgFactory = true;
  return {
    intro: setup,
    outro: setup
  };
});
