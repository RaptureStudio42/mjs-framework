// mjs_hotcss — rechargement CSS à chaud (µ._hotCss), développement seulement.
//
// N'EST PAS DANS LE BUNDLE DE PRODUCTION : même règle que mjs_debug/mjs_devinspect/mjs_devpanel
// (cf. bundler/index.ts, bundleRuntime()) — seul le snippet HMR de `mjs dev` (server/hmr.ts)
// l'appelle, jamais le reste du runtime. Vivait jusqu'ici en fin de mjs_element.ts (même section
// « DEV » que les trois autres), déplacé pour de bon dans son propre fichier détaché du cœur —
// zéro changement de comportement, seulement d'emplacement dans la concaténation (`hasProp`,
// déclaré au tout début de mjs_element.ts, reste PARTAGÉ dans le bundle concaténé : ce fichier
// est toujours inséré APRÈS mjs_element.ts par bundleRuntime()).
//
// Appelé par le snippet HMR de `mjs dev` (server/hmr.ts) sur un message
// 'css-update' : recompile où SEUL le CSS a changé (diff côté bundler). Le
// style est remplacé EN PLACE, sans reload — l'état de la page survit :
//   - composants : `sheet.replaceSync(css)` sur la CSSStyleSheet indexée par
//     tag (µ._mjs_componentStyleByTag, remplie à l'adoption) — la mutation touche
//     instantanément TOUTES les shadow roots vivantes qui l'ont adoptée ;
//   - cache par texte (µ._mjs_componentStyleCache) : l'ANCIENNE clé est CONSERVÉE
//     (les instances futures d'une classe déjà chargée portent encore l'ancien
//     littéral `_mjs_baseCss` — le hit par l'ancien texte doit retrouver LA
//     feuille mutée, pas en recréer une périmée) ; la NOUVELLE clé est ajoutée ;
//   - mode `mjs-light` : remplacement du textContent des <style data-mjs-css>
//     du head + réindexation du Set de dédup (µ._mjs_lightStyleInjected) ;
//   - feuilles partagées µ.CSS[name] et mjs_root (µ._mjs_rootStyleSheet, handle
//     posé par mjs_styles.js) : replaceSync pareil.
// Retourne `false` dès qu'UN remplacement n'est pas SÛR (classe jamais chargée
// — son entrée µ.paths pointe un fichier déjà supprimé —, feuille partagée
// entre tags qui divergent, replaceSync manquant/en échec…) : le snippet HMR
// retombe alors sur un location.reload() complet — au moindre doute, reload.
// Jamais sollicité en prod (seul le snippet HMR de `mjs dev` l'appelle).
µ._hotCss = function(payload) {
  var applied = true;
  if (!payload || typeof payload !== 'object') return applied;
  var byTag = µ._mjs_componentStyleByTag;
  var textCache = µ._mjs_componentStyleCache;
  var components = payload.components || {};
  var sharedSheets = payload.sheets || {};
  // clés normalisées en minuscules (tagName DOM = MAJUSCULES, payload = tags compilés)
  var wanted = {};
  for (var rawTag in components) {
    if (hasProp.call(components, rawTag)) wanted[rawTag.toLowerCase()] = components[rawTag];
  }
  for (var tag in wanted) {
    if (!hasProp.call(wanted, tag)) continue;
    var css = wanted[tag];
    if (typeof css !== 'string') { applied = false; continue; }
    // classe jamais chargée : le manifeste de la page (µ.paths, figé au boot)
    // pointe l'ANCIEN fichier hashé, déjà supprimé du disque — un futur import
    // lazy ferait 404 en silence. Doute → reload complet.
    if (typeof customElements !== 'undefined' && !customElements.get(tag)) { applied = false; continue; }
    // mode light : <style data-mjs-css="tag"> dans le head → textContent réécrit (:host → balise)
    // + maj du Set sur ce texte réécrit — c'est CE texte-là qui est réellement posé
    var lightCss = µ._lightHostCss(css, tag);
    var lightEls = document.querySelectorAll('style[data-mjs-css="' + tag + '"]');
    for (var li = 0; li < lightEls.length; li++) {
      var el = lightEls[li];
      if (µ._mjs_lightStyleInjected) {
        µ._mjs_lightStyleInjected.delete(el.textContent);
        µ._mjs_lightStyleInjected.add(lightCss);
      }
      el.textContent = lightCss;
    }
    // feuilles CONSTRUCTIBLES d'un léger sous CSP (document ou shadow de
    // l'ancêtre, µ._mjs_lightSheetsByTag) : aucun <style> ne les porte, la boucle ci-dessus ne les
    // voit jamais — sans cette table, le remplacement sautait en silence, HMR muet
    var lightSheetEntries = µ._mjs_lightSheetsByTag ? µ._mjs_lightSheetsByTag.get(tag) : null;
    if (lightSheetEntries) {
      for (var lsi = 0; lsi < lightSheetEntries.length; lsi++) {
        var lightEntry = lightSheetEntries[lsi];
        try {
          lightEntry.sheet.replaceSync(lightCss);
        } catch (errLight) {
          µ.warn('[ModularJS] _hotCss : replaceSync a échoué pour la feuille légère <' + tag + '> :', errLight);
          applied = false;
          continue;
        }
        if (µ._mjs_lightStyleInjected) {
          µ._mjs_lightStyleInjected.delete(lightEntry.text);
          µ._mjs_lightStyleInjected.add(lightCss);
        }
        lightEntry.text = lightCss;
      }
    }
    var sheet = byTag ? byTag.get(tag) : null;
    if (!sheet) continue; // aucune instance shadow n'a (encore) adopté — light seul, rien à muter
    // feuille PARTAGÉE entre tags (le cache par texte fait partager la même
    // CSSStyleSheet à deux composants au CSS identique) : mutation sûre
    // SEULEMENT si tous les tags qui la partagent reçoivent le MÊME nouveau
    // CSS dans ce payload — sinon on repeindrait l'autre composant. Doute → reload.
    var safe = true;
    byTag.forEach(function(other, otherTag) {
      if (other === sheet && wanted[otherTag] !== css) safe = false;
    });
    if (!safe) { applied = false; continue; }
    if (typeof sheet.replaceSync !== 'function') { applied = false; continue; }
    try {
      sheet.replaceSync(css);
    } catch (err) {
      µ.warn('[ModularJS] _hotCss : replaceSync a échoué pour <' + tag + '> :', err);
      applied = false;
      continue;
    }
    if (textCache) textCache.set(css, sheet); // nouvelle clé texte → feuille mutée (l'ancienne clé reste, cf. en-tête)
  }
  for (var name in sharedSheets) {
    if (!hasProp.call(sharedSheets, name)) continue;
    var target = µ.CSS ? µ.CSS[name] : null;
    if (!target || typeof target.replaceSync !== 'function') { applied = false; continue; }
    try {
      target.replaceSync(sharedSheets[name]);
    } catch (err2) {
      µ.warn('[ModularJS] _hotCss : replaceSync a échoué pour la feuille partagée « ' + name + ' » :', err2);
      applied = false;
    }
  }
  if (payload.root != null) {
    if (µ._mjs_rootStyleSheet && typeof µ._mjs_rootStyleSheet.replaceSync === 'function') {
      try {
        µ._mjs_rootStyleSheet.replaceSync(payload.root);
      } catch (err3) {
        µ.warn('[ModularJS] _hotCss : replaceSync a échoué pour mjs_root :', err3);
        applied = false;
      }
    } else {
      applied = false; // mjs_root jamais adopté par cette page (vieux mjs_styles sans handle) → reload
    }
  }
  return applied;
};
