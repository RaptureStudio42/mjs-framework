// mjs_effect — rune `µeffect` (µ.effect), effet réactif générique. DÉTACHÉ du cœur :
// embarqué si le projet écrit `µeffect`/`µ.effect` DIRECTEMENT, mais aussi si l'une des
// syntaxes qui s'appuient dessus EN SILENCE est présente (aucune ne laisse le mot « effect »
// dans le source du projet — le signal doit donc les couvrir explicitement, cf.
// bundler/index.ts, scanRuntimeFeatures) :
//   - `@persist` (transpiler/directives.ts) compile en `µ.effect => backend.setItem(...)` ;
//   - `µdebug $x` (transpiler/index.ts) compile en `µ.effect => µ.log(...); debugger` ;
//   - `<@head>` à contenu, les liaisons class/style de `<@body>`/`<@html>`, `<@element>`/
//     `<@module>`, et les liaisons two-way `scrollX`/`scrollY` de `<@window>` (transpiler/
//     macros.ts) émettent chacun leur propre `µeffect =>` autour de l'appel runtime.
// `_mjs_runEffectsV2` (mjs_element.ts, cœur) ne fait qu'ITÉRER `comp._mjs_effects` — un composant qui
// n'a jamais appelé `µ.effect` a un tableau vide/absent, elle ne dépend donc pas de ce fichier.
//
// Cache de RegExp par var name (var names sont stables dans le projet).
// Évite alloc + compilation regex × N vars × M effects par composant.
µ._mjs_effectVarRegexCache = µ._mjs_effectVarRegexCache || {};

// `precomputedVars` (2e paramètre,
// optionnel) est injecté par le compilateur (generator/effect-deps.ts) : liste
// des `$.xxx` lus dans `fn`, calculée en AST AVANT toute minification. Avant
// ce fix, la SEULE source était le scan runtime ci-dessous (`fn.toString()` +
// regex `$.<var>` littérale) — cassé dès que le code est minifié : esbuild
// renomme le PARAMÈTRE local `$` (`function($){}` → `function(n){}`, vérifié
// empiriquement) sans toucher aux noms de PROPRIÉTÉ, donc le texte minifié
// contient `n.count`, jamais `$.count` — la regex ne matchait plus RIEN.
// `staticVars` restait alors TOUJOURS vide en prod → chaque effect basculait
// sur le mode fail-open "pas de deps connues → fire à CHAQUE mutation" (cf.
// _mjs_runEffectsV2, mjs_element.ts) — silencieux, pas un crash, mais défait tout
// l'intérêt du dispatch V2 par var. Le scan `fn.toString()` reste le FALLBACK
// pour un `µ.effect` appelé hors pipeline compilateur (code runtime écrit à
// la main, sans 2e argument).
µ.effect = function(fn, precomputedVars) {
  var comp, fnStr, key, staticVars, rxCache;
  comp = µ.activeComponent;
  if (!comp) {
    return µ.warn("[ModularJS] µ.effect doit être appelé à l'initialisation.");
  }
  if (comp._mjs_effects == null) {
    comp._mjs_effects = [];
  }
  // V2 — dispatch direct sans bitmask : on collecte la LISTE des state vars
  // lues par l'effect (scan statique de la source de fn) au lieu d'un mask.
  // Le runtime (`_mjs_runEffectsV2`) filtre par intersection avec `_mjs_lastMutedVars`.
  // Plus de limite 31 vars : un array peut contenir des centaines de noms.
  if (precomputedVars != null) {
    staticVars = precomputedVars;
  } else {
    staticVars = [];
    fnStr = fn.toString();
    rxCache = µ._mjs_effectVarRegexCache;
    if (comp._mjs_var_bits) {
      for (key in comp._mjs_var_bits) {
        var rx = rxCache[key];
        if (!rx) {
          rx = rxCache[key] = new RegExp("(?:[^a-zA-Z0-9_$]|^)\\$\\." + key + "\\b");
        }
        if (rx.test(fnStr)) {
          staticVars.push(key);
        }
      }
    }
  }
  // `_mjs_varHasUserEffect`
  // (mjs_element.ts) MÉMOÏSE `_mjs_userEffectVars` au 1er `_set` post-mount et ne le
  // recalcule JAMAIS. Un `µ.effect` enregistré APRÈS (hook `µmount`, où
  // `µ.activeComponent` est posé par le batch ; ou effet créé depuis un autre
  // effet) n'entrait donc jamais dans l'index → l'ultra fast-path no-op de
  // `_mjs_invalidate` concluait « aucun effet ne lit k » et l'effet ne se déclenchait
  // JAMAIS. On invalide le cache à chaque push : il sera reconstruit (incluant le
  // nouvel effet) au prochain `_mjs_varHasUserEffect`.
  // 3ᵉ morsure — expansion computeds chaînés : un effet qui ne
  // lit qu'un dérivé (`$c` où c ← b ← a) ne se re-déclenchait JAMAIS quand une racine
  // mutait (_mjs_runEffectsV2 compare la clé muée aux staticVars LITTÉRALES). Le compilateur
  // émet `_mjs_computedDeps` (closure transitive — dérivés de dérivés déjà aplatis par
  // l'analyzer) ; on étend ICI, à l'enregistrement : zéro coût dans les chemins chauds.
  // Couvre les deux branches (precomputedVars ET scan fallback) ; copie avant ajout —
  // le literal precomputedVars du code compilé ne doit pas être muté en place.
  var cdeps = comp._mjs_computedDeps;
  if (cdeps && staticVars.length > 0) {
    var expanded = null;
    for (var si = 0; si < staticVars.length; si++) {
      var roots = cdeps[staticVars[si]];
      if (roots) {
        if (expanded == null) expanded = new Set(staticVars);
        for (var ri = 0; ri < roots.length; ri++) expanded.add(roots[ri]);
      }
    }
    if (expanded != null) staticVars = Array.from(expanded);
  }
  comp._mjs_userEffectVars = void 0;
  return comp._mjs_effects.push({
    staticVars,
    fn,
    cleanup: null
  });
};
