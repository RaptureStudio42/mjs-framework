// mjs_rare_runes — runes PEU utilisées, regroupées dans un seul fichier détecté (µplay,
// µminmax, µinspect, µraw, µsnap, µimport) : chacune est minuscule, aucune ne dépend des
// autres, mais les séparer en 6 fichiers n'apporterait rien — le bundle les embarque TOUS
// dès qu'UNE SEULE est utilisée dans le projet (cf. bundler/index.ts, scanRuntimeFeatures,
// clé détectée 'rare_runes'). Rapatriées ici depuis mjs_runes.ts (µplay/µminmax/µraw/
// µinspect) et mjs_init.ts (µsnap/µ._mjs_import) — zéro changement de comportement.

µ.raw = function(target) {
  if (target !== null && typeof target === 'object') {
    // Marqueur dans µ._mjs_rawSet (cf. mjs_init.ts) — pas de prop string sur
    // l'objet user (mangle-safe + sans pollution `for...in`/`Object.keys`).
    µ._mjs_rawSet.add(target);
  }
  return target;
};

// dédup des avertissements « bornes inversées », par COUPLE
// (min,max) — pas par variable/instance : une même paire fautive ne spamme
// qu'une fois la console, même réutilisée sur plusieurs `$vars`/composants.
const MJS_MINMAX_WARNED = new Set();

µ.minmax = function(instance, key, min, max) {
  var clamped, currentVal;
  if (instance._mjs_limits == null) {
    instance._mjs_limits = {};
  }
  instance._mjs_limits[key] = {min, max};
  // `µminmax $v, 100, 0` (bornes inversées, faute de frappe
  // plausible sur l'ordre min/max) clampait tout au max en silence — le
  // clamp reste inchangé ci-dessous, seul l'avertissement est nouveau.
  if (min !== null && max !== null && min > max) {
    const _couple = min +'|'+ max;
    if (!MJS_MINMAX_WARNED.has(_couple)) {
      MJS_MINMAX_WARNED.add(_couple);
      µ.warn('[ModularJS] µminmax : bornes inversées (min '+ min +' > max '+ max +')');
    }
  }
  // V2 : la propriété `.$` (proxy V1) n'existe plus sur les instances —
  // `instance.$[key]` jetait TypeError au premier µminmax. L'état vit dans
  // `_state`, l'écriture clampée passe par `µ._set` (invalidation comprise).
  currentVal = instance._state ? instance._state[key] : void 0;
  if (currentVal && µ._mjs_interpolatorSet.has(currentVal)) {
    currentVal.min = min;
    currentVal.max = max;
    return currentVal.value = currentVal.target;
  } else if (typeof currentVal === 'number') {
    clamped = currentVal;
    if (min !== null) {
      clamped = Math.max(min, clamped);
    }
    if (max !== null) {
      clamped = Math.min(max, clamped);
    }
    if (clamped !== currentVal) {
      return µ._set(instance, key, clamped);
    }
  }
};

µ.play = function(node, animationClass) {
  return new Promise(function(resolve) {
    var cleanup;
    if (!(node && animationClass)) {
      return resolve();
    }
    cleanup = function(e) {
      if (e && e.target !== node) {
        return;
      }
      node.classList.remove(animationClass);
      node.removeEventListener('animationend', cleanup);
      node.removeEventListener('animationcancel', cleanup);
      return resolve();
    };
    node.classList.remove(animationClass);
    void node.offsetWidth;
    node.addEventListener('animationend', cleanup);
    node.addEventListener('animationcancel', cleanup);
    return node.classList.add(animationClass);
  });
};

µ.inspect = function(key) {
  var comp;
  comp = µ.activeComponent;
  if (!comp) {
    return µ.warn("[ModularJS] µ.inspect doit être appelé à l'initialisation.");
  }
  if (comp._mjs_inspections == null) {
    comp._mjs_inspections = new Set();
  }
  return comp._mjs_inspections.add(key);
};

// Fonction identité servant de marqueur pour la désactivation snapshot `=:` :
// le lexer transforme `$var =: expr` en `$var = µ.snap(expr)`,
// et l'AST analyzer reconnaît ce marqueur pour skipper la transformation
// en computed. Au runtime, `µ.snap` retourne simplement la valeur reçue.
// `=:` (et non `:=`) pour éviter la collision avec Civet où `:=` = const.
µ.snap = function(v) {
  return v;
};

// `µ._mjs_import(url)` : chargement PARESSEUX d'un module ES, cible compilée de
// la rune `µimport('chemin.js')` (sigils.ts, rewriteMuImport) — reçoit une
// URL déjà résolue/hachée par `µasset` (empreinte connue au build). Un
// import() nu est légal ICI (src/runtime/ échappe à lintNoRawImport,
// l'autoloader en a déjà un) — mais seul CE point d'entrée doit être atteint,
// jamais `µimport` lui-même (identifiant qui n'existe qu'au compile-time).
µ._mjs_import = function(url) {
  if (!url) throw new Error('µimport : chemin vide — asset non résolu au build');
  return import(url);
};
