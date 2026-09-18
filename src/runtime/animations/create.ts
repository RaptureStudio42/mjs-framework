// animations/create.coffee

// Point d'entrée unique pour enregistrer une animation personnalisée.
// Tree-shakable : inclus dans le bundle uniquement si `µanim.create` est
// référencé dans le code utilisateur.

// Trois styles cohabitent :

// 1) Symétrique avec `css` (callback à la Svelte, retourne un objet keyframe)
//      µanim.create 'spin',
//        duration: 1000
//        easing: µeasing.elasticOut
//        css: (t, u) ->
//          transform: "scale(#{t})"
//          opacity: t

// 2) Tick (callback per-frame, l'utilisateur mute node lui-même)
//      µanim.create 'typewriter', (node, opts) ->
//        text = node.textContent
//        duration: text.length * 100
//        tick: (t) ->
//          i = Math.trunc(text.length * t)
//          node.textContent = text.slice(0, i)

// 3) Asymétrique avec `intro` / `outro` séparés (contrôle total)
//      µanim.create 'flip',
//        intro: (node, opts) -> node.animate([...], opts).finished
//        outro: (node, opts) -> node.animate([...], opts).finished

// Le 2ème argument peut être un objet (config statique) OU une fonction
// `(node, opts) -> cfg` (setup par-nœud, comme Svelte).
//
// Pour les modes `tick` et `css`, on délègue à `µ._mjs_runTransition` qui gère
// le cache cfg per-node (évite re-capture stale du DOM en revival), l'abort
// de la rAF/WAAPI loop précédente, et la continuité from current `t` —
// exactement comme Svelte. Pour le mode asymétrique explicite (intro/outro
// fonctions directes), on reste en legacy : le user gère son lifecycle
// via WAAPI direct (`node.animate(...).finished`).
(function(name, config) {
  var factory;
  if (typeof name !== 'string') {
    config = name;
    name = null;
  }
  factory = function(opts = {}) {
    var setup;
    // setup(node) : retourne la cfg pour ce node. Marqué `_isCfgFactory` →
    // `_mjs_playTransition` route via `_mjs_runTransition` qui s'occupe du cache,
    // de l'abort, et de la continuité.
    setup = function(node) {
      if (typeof config === 'function') {
        return config(node, opts);
      } else {
        return config;
      }
    };
    setup._isCfgFactory = true;
    return {
      intro: function(node) {
        var cfg, mergedOpts;
        // PERF — mémoïse le MODE (asym vs managed) sur `setup` pour
        // éviter un `setup(node)` de DÉTECTION jeté à CHAQUE lancement : en mode
        // managed, `µ._mjs_runTransition` rappelle `setup(node)` en interne (capture
        // fraîche voulue en css), donc le setup de détection était doublé.
        // Le mode ne dépend pas du node pour un `config` donné → détecté une fois.
        if (setup._mode === 'managed') {
          return µ._mjs_runTransition(node, setup, 'in');
        }
        cfg = setup(node);
        // Mode asymétrique explicite : path legacy direct, sans cache/abort
        // (le user gère son propre lifecycle via WAAPI direct).
        if (cfg && !cfg.tick && !cfg.css && cfg.intro) {
          setup._mode = 'asym';
          mergedOpts = Object.assign({}, opts, {
            duration: cfg.duration,
            easing: cfg.easing
          });
          return cfg.intro(node, mergedOpts);
        }
        // Mode tick / css → _mjs_runTransition (cache + abort + continuité)
        setup._mode = 'managed';
        return µ._mjs_runTransition(node, setup, 'in');
      },
      outro: function(node) {
        var cfg, mergedOpts;
        if (setup._mode === 'managed') {
          return µ._mjs_runTransition(node, setup, 'out');
        }
        cfg = setup(node);
        if (cfg && !cfg.tick && !cfg.css && cfg.outro) {
          setup._mode = 'asym';
          mergedOpts = Object.assign({}, opts, {
            duration: cfg.duration,
            easing: cfg.easing
          });
          return cfg.outro(node, mergedOpts);
        }
        setup._mode = 'managed';
        return µ._mjs_runTransition(node, setup, 'out');
      }
    };
  };
  if (name) {
    // `µ.anim[name] =
    // factory` écrasait INCONDITIONNELLEMENT toute entrée EXISTANTE — qu'elle
    // soit une animation BUILT-IN du framework (fade/fly/scale/slide/…) ou
    // une AUTRE `µanim.create` déjà enregistrée sous ce nom — sans le moindre
    // signal. Un projet avec deux `µanim.create('fade', …)` distincts (ex.
    // deux fichiers/tutoriels qui réutilisent le même nom par coïncidence),
    // ou un nom qui collisionne accidentellement avec un built-in, voit l'un
    // des deux SILENCIEUSEMENT ignoré (le dernier chargé gagne, l'ordre de
    // chargement dépendant de détails de bundling) — un bug de "mauvaise
    // animation qui joue" quasi impossible à tracer sans ce warning.
    if (µ.anim[name] !== undefined) {
      µ.warn(`[µanim.create] '${name}' remplace une animation déjà enregistrée sous ce nom (built-in du framework, ou un autre µanim.create appelé avant) — la précédente est perdue.`);
    }
    µ.anim[name] = factory;
  }
  return factory;
});
