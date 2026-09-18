// mjs_lazy_css — mode `css: 'lazy'` : une feuille partagée n'est pas dans le bundle, c'est un
// vrai `.css` haché dont l'URL est publiée au manifeste (`µ._cssLazy`, nom → URL). DÉTACHÉ du
// cœur, DÉTECTÉ PAR CONFIG (jamais par scan) : le bundler n'écrit `µ._cssLazy` au manifeste QUE
// si `css: 'lazy'` (bundler/index.ts, `resolveRuntimeFiles`), et ce fichier suit toujours ce
// mode. `_mjs_applyLayout` (mjs_element.ts) ne connaît que `µ._mjs_lazyCssWait`, sous garde d'existence :
// hors mode 'lazy', ni la fonction ni la table n'existent, rien n'est attendu ni demandé — ce
// fichier peut donc manquer sans risque pour tout le reste.
//
// `µ._mjs_fetchLazyCss(nom)` va chercher la feuille une fois et la pose dans `µ.CSS[nom]` — à partir
// de là, tous les chemins existants la trouvent sans rien savoir du mode. Cache PAR URL et
// PENDANT LE VOL : dix composants qui montent ensemble en déclarant la même feuille ne
// déclenchent qu'UNE requête.
if (µ._mjs_lazyCssCache == null) {
  µ._mjs_lazyCssCache = {};
}

// le cache par URL ne retient QUE le TEXTE, jamais la feuille d'un nom précis : deux
// noms peuvent légitimement pointer la même URL, et une promesse partagée qui poserait
// `µ.CSS[nom]` par fermeture ne servirait QUE le premier appelant — le second héritait
// d'un registre vide, sans un mot.
// Chaque appelant pose donc SA clé ; la feuille elle-même reste partagée, indexée par
// texte, comme le fait déjà `_mjs_styleVariantSheetCache` pour les variants.
µ._mjs_fetchLazyCss = function(name) {
  if (µ.CSS[name]) {
    return Promise.resolve(µ.CSS[name]);
  }
  var url = µ._cssLazy ? µ._cssLazy[name] : null;
  if (!url) {
    return Promise.resolve(null);
  }
  if (!µ._mjs_lazyCssCache[url]) {
    µ._mjs_lazyCssCache[url] = fetch(url).then(function(r) {
      return r.ok ? r.text() : '';
    }).catch(function() {
      return '';
    });
  }
  return µ._mjs_lazyCssCache[url].then(function(css) {
    if (!css) {
      // vide, 404 ou réseau coupé : on RETIRE l'entrée (un montage ultérieur doit
      // pouvoir retenter) et on avertit UNE seule fois par URL. Jamais d'exception
      // qui remonterait dans le montage du composant
      delete µ._mjs_lazyCssCache[url];
      if (µ._mjs_lazyCssMissing == null) {
        µ._mjs_lazyCssMissing = new Set();
      }
      if (!µ._mjs_lazyCssMissing.has(url)) {
        µ._mjs_lazyCssMissing.add(url);
        µ.warn(`[ModularJS] Feuille partagée '${name}' introuvable (${url}) — le composant s'affichera sans elle.`);
      }
      return null;
    }
    if (µ._mjs_lazyCssSheets == null) {
      µ._mjs_lazyCssSheets = new Map();
    }
    if (!µ._mjs_lazyCssSheets.has(css)) {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      µ._mjs_lazyCssSheets.set(css, sheet);
    }
    if (!µ.CSS[name]) {
      µ.CSS[name] = µ._mjs_lazyCssSheets.get(css);
    }
    return µ.CSS[name];
  });
};

// `µ._mjs_lazyCssWait(el, inheritedNames)` : appelé par `_mjs_applyLayout` (mjs_element.ts) AVANT toute
// adoption. Rend la promesse des feuilles — héritées d'un `<@view css="…">` ancêtre, puis
// déclarées par le composant (`@css`) — absentes du registre et connues de la table paresseuse,
// ou `null` s'il n'y a rien à attendre : `_mjs_applyLayout` n'ajoute alors aucun `await`.
// Garde SERVEUR — `µ.server` (axe PUBLIC) et pas `µ._isServer` : le moteur `browser`
// pose délibérément le premier et PAS le second (il monte pour de vrai, cf. l'en-tête
// de server/render-browser.ts). Or c'est le pire cas : un vrai Chromium irait chercher
// la feuille, retiendrait `[mjs-loading]` pendant l'aller-retour, et le HTML prérendu
// risquerait d'être capturé avec des composants encore masqués — une page prérendue
// invisible jusqu'à l'hydratation. La première peinture serveur est donc sans les
// feuilles partagées, comme elle l'est déjà sans le reste du CSS (seul le thème est
// inliné) — l'hydratation les pose côté client. `_isServer` en ceinture, pour le
// moteur happy-dom, où personne ne répondrait de toute façon à une requête.
µ._mjs_lazyCssWait = function(el, inheritedNames) {
  if (!µ._cssLazy || µ.server || µ._isServer) return null;
  var names = inheritedNames.concat(el._mjs_sharedCss || []);
  var wait  = [];
  for (var i = 0; i < names.length; i++) {
    if (!µ.CSS[names[i]] && µ._cssLazy[names[i]]) {
      wait.push(µ._mjs_fetchLazyCss(names[i]));
    }
  }
  return wait.length > 0 ? Promise.all(wait) : null;
};
