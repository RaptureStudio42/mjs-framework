// animations/swipe.coffee — front dégradé qui balaie l'élément et le révèle derrière lui, jumeau « sur un élément » du rideau de page swipe (mjs_vt_presets.ts)
(function(opts = {}) {
  var css, dir, g, pct, posFor, setup, table;
  pct = function(v) {
    return Math.round(v * 1000) / 1000;
  };
  table = {
    right: { image: 'linear-gradient(to right, #000 0%, #000 59.33%, transparent 66.66%, transparent 100%)', size: '300% 100%' },
    left:  { image: 'linear-gradient(to left, #000 0%, #000 59.33%, transparent 66.66%, transparent 100%)', size: '300% 100%' },
    down:  { image: 'linear-gradient(to bottom, #000 0%, #000 59.33%, transparent 66.66%, transparent 100%)', size: '100% 300%' },
    up:    { image: 'linear-gradient(to top, #000 0%, #000 59.33%, transparent 66.66%, transparent 100%)', size: '100% 300%' }
  };
  dir = opts.dir != null ? opts.dir : (opts.direction != null ? opts.direction : 'right');
  if (table[dir] == null) {
    µ.warn("[ModularJS] @transition.swipe : direction invalide '"+ dir +"' — repli 'right'.");
    dir = 'right';
  }
  g = table[dir];
  posFor = {
    right: function(t, u) { return `${pct(u * 100)}% 0%`; },
    left:  function(t, u) { return `${pct(t * 100)}% 0%`; },
    down:  function(t, u) { return `0% ${pct(u * 100)}%`; },
    up:    function(t, u) { return `0% ${pct(t * 100)}%`; }
  }[dir];
  // à u=1 (caché) la boîte ne voit que le tiers transparent, à u=0 (visible) que du noir, entre
  // les deux la rampe traverse la boîte dans le sens de dir — masque constant, seule la position bouge
  css = function(t, u) {
    return {
      maskImage: g.image,
      maskSize: g.size,
      maskRepeat: 'no-repeat',
      maskPosition: posFor(t, u)
    };
  };
  setup = function(node) {
    var ref, ref1, ref2, ref3;
    return {
      delay: (ref = opts.delay) != null ? ref : 0,
      duration: (ref1 = opts.duration) != null ? ref1 : 320,
      easing: µ.easing.resolve((ref2 = opts.easing) != null ? ref2 : 'ease-out'),
      steps: (ref3 = opts.steps) != null ? ref3 : 60,
      css
    };
  };
  setup._isCfgFactory = true;
  return {
    intro: setup,
    outro: setup
  };
});
