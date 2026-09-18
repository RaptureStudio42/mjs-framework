// mjs_hydrate — hydratation SSR par ADOPTION du DOM rendu par le serveur, dans ses trois
// approches : 'a' marqueurs, 'b' walk positionnel, 'c' diff léger. Patch de
// `µ.Element.prototype`, DÉTACHÉ de mjs_element.ts (même technique que mjs_html.ts : ajouté
// APRÈS la classe, DOIT rester après mjs_element.ts dans la concaténation).
//
// JOINT PAR CONFIGURATION (bundler/index.ts, `wantsHydrate`), jamais par scan de code : le bloc
// `render` déclare le mode de chaque page, et seuls `ssr:markers`/`ssr:positional`/`ssr:diff`
// hydratent. `csr` et `prerender` ne rendent rien à adopter ; `ssr`/`ssr:replace` (défaut) jette
// la photo serveur et reconstruit la vue — aucun des trois n'appelle ces méthodes. Un serveur qui
// rend par l'API sans bloc `render` demande le module par `runtime: ['hydrate']`.
//
// Le cœur garde l'amorce (constructeur : `µ._mjs_ssrHydrate` + `_mjs_ssrAdopt`, qui décident de
// CONSERVER la photo serveur) et l'aiguillage de `_mjs_mount`, gardé par l'existence de la
// méthode : sans ce fichier, une page qui demande quand même l'hydratation est avertie une fois,
// puis rendue par « rendre puis remplacer » — même vue, sans adoption.
if (µ.Element) {
  // Hydratation par adoption : dispatche vers l'approche choisie (µ._mjs_ssrHydrate).
  // 'a' = marqueurs, 'b' = walk positionnel, 'c' = diff. Défaut : 'a'.
  µ.Element.prototype._mjs_hydrate = function(factory) {
    var mode = µ._mjs_ssrHydrate;
    if (mode === 'b') {
      return this._mjs_hydrateB(factory);
    }
    if (mode === 'c') {
      return this._mjs_hydrateC(factory);
    }
    return this._mjs_hydrateA(factory);
  };

  // Approche A — marqueurs. Réutilise les nœuds du DSD serveur au lieu de les
  // recréer : walke le shadow, reconstruit `_mjs_nodes` depuis les marqueurs émis
  // par le serveur (attribut `mjs-h` sur les éléments, commentaire `mjs-h:<key>`
  // avant les text nodes), les retire, et rebranche les events via
  // _mjs_registerRefs. Retourne false si rien à adopter (→ fallback création).
  µ.Element.prototype._mjs_hydrateA = function(_factory) {
    var root = this._shadow;
    if (!root || !root.querySelectorAll) return false;
    var refs = {};
    var found = 0;
    // 1. Éléments porteurs de `mjs-h`.
    var els = root.querySelectorAll('[mjs-h]');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      var k = e.getAttribute('mjs-h');
      if (k) {
        refs[k] = e;
        e.removeAttribute('mjs-h');
        found++;
      }
    }
    // 2. Commentaires `mjs-h:<key>` → le text node qui suit immédiatement.
    var doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (doc && doc.createTreeWalker) {
      var walker = doc.createTreeWalker(root, 128 /* NodeFilter.SHOW_COMMENT */, null);
      var comments = [];
      var c;
      while ((c = walker.nextNode())) {
        if ((c.data || '').indexOf('mjs-h:') === 0) {
          comments.push(c);
        }
      }
      for (var j = 0; j < comments.length; j++) {
        var cm = comments[j];
        var key = (cm.data || '').slice(6);
        var tn = cm.nextSibling;
        if (key && tn) {
          refs[key] = tn;
          found++;
        }
        if (cm.parentNode) {
          cm.parentNode.removeChild(cm);
        }
      }
    }
    if (found === 0) {
      return false; // aucun marqueur → composant non hydratable, fallback création
    }
    this._mjs_nodes = refs;
    this._mjs_registerRefs(refs);
    this._mjs_hydrated = true;
    return true;
  };

  // Approche B — walk positionnel (SANS marqueurs). On crée le fragment client
  // (factory) pour CONNAÎTRE la structure + les refs, puis on aligne ce fragment
  // avec le DOM serveur position par position : chaque nœud réactif du fragment
  // est remplacé, dans `_mjs_nodes`, par le nœud serveur de même position. Le
  // fragment client est jeté (on garde le DOM serveur). Les text nodes fusionnés
  // par le parseur sont re-découpés via splitText. Fragile par nature (toute
  // divergence de structure désaligne) → fallback création en cas d'écart.
  µ.Element.prototype._mjs_hydrateB = function(factory) {
    var root = this._shadow;
    if (!root) return false;
    var built = factory();
    if (!built || !built.refs || !built.fragment) return false;
    // Map inverse : nœud du fragment → liste de clés de ref.
    var nodeToKeys = new Map();
    for (var key in built.refs) {
      if (!Object.prototype.hasOwnProperty.call(built.refs, key)) continue;
      var n = built.refs[key];
      if (!n) continue;
      var arr = nodeToKeys.get(n);
      if (arr) { arr.push(key); } else { nodeToKeys.set(n, [key]); }
    }
    var newRefs = {};
    var ok = this._mjs_walkAdopt(root, built.fragment, nodeToKeys, newRefs);
    if (!ok) return false; // désalignement → fallback création
    this._mjs_nodes = newRefs;
    this._mjs_registerRefs(newRefs);
    this._mjs_hydrated = true;
    return true;
  };

  // Walk parallèle serveur ↔ fragment client. Côté serveur on saute les balises
  // de style (absentes du fragment, le CSS étant en adoptedStyleSheets). Pour les
  // text nodes, on découpe le nœud serveur (splitText) à la longueur du nœud
  // fragment afin de réaligner après une fusion de texte par le parseur HTML.
  µ.Element.prototype._mjs_walkAdopt = function(serverParent, fragmentParent, nodeToKeys, newRefs) {
    var s = serverParent.firstChild;
    var f = fragmentParent.firstChild;
    while (f) {
      while (s && s.nodeType === 1 && s.tagName === 'STYLE') {
        s = s.nextSibling;
      }
      if (!s) return false; // plus de nœud serveur → désalignement
      if (f.nodeType !== s.nodeType) return false; // types divergents → désalignement
      if (f.nodeType === 3) {
        var fl = (f.data || '').length;
        if ((s.data || '').length > fl && typeof s.splitText === 'function') {
          s.splitText(fl);
        }
      }
      var keys = nodeToKeys.get(f);
      if (keys) {
        for (var i = 0; i < keys.length; i++) {
          newRefs[keys[i]] = s;
        }
      }
      if (f.firstChild) {
        if (!this._mjs_walkAdopt(s, f, nodeToKeys, newRefs)) return false;
      }
      f = f.nextSibling;
      s = s.nextSibling;
    }
    // Fragment épuisé → purge des nœuds serveur excédentaires (hors style).
    // Un placeholder `{$x}` vide côté fragment (rempli seulement au 1er
    // effect) splitText(0) sur le nœud serveur non-vide, laissant le reliquat
    // texte comme frère orphelin (ex. « 5 » de « compteur : 5 ») → sans cette
    // purge il reste affiché en double (« compteur : 55 »).
    while (s) {
      var sn = s.nextSibling;
      if (!(s.nodeType === 1 && s.tagName === 'STYLE')) {
        serverParent.removeChild(s);
      }
      s = sn;
    }
    return true;
  };

  // Approche C — diff léger. Comme B (réconcilie le fragment client avec le DOM
  // serveur), mais au lieu d'ÉCHOUER sur un écart, on le CORRIGE : on réutilise
  // les nœuds serveur compatibles et on patche le reste (texte, nœud
  // manquant/en trop, balise divergente). Plus robuste qu'un walk strict (tolère
  // un mismatch serveur/client), au prix d'un parcours comparatif.
  µ.Element.prototype._mjs_hydrateC = function(factory) {
    var root = this._shadow;
    if (!root) return false;
    var built = factory();
    if (!built || !built.refs || !built.fragment) return false;
    var nodeToKeys = new Map();
    for (var key in built.refs) {
      if (!Object.prototype.hasOwnProperty.call(built.refs, key)) continue;
      var n = built.refs[key];
      if (!n) continue;
      var arr = nodeToKeys.get(n);
      if (arr) { arr.push(key); } else { nodeToKeys.set(n, [key]); }
    }
    var newRefs = {};
    this._mjs_diffAdopt(root, built.fragment, nodeToKeys, newRefs);
    this._mjs_nodes = newRefs;
    this._mjs_registerRefs(newRefs);
    this._mjs_hydrated = true;
    return true;
  };

  // Réconcilie les enfants de `serverParent` (DOM rendu) avec ceux de
  // `fragmentParent` (vue client neuve), en réutilisant au maximum les nœuds
  // serveur. Saute les balises de style côté serveur.
  µ.Element.prototype._mjs_diffAdopt = function(serverParent, fragmentParent, nodeToKeys, newRefs) {
    var s = serverParent.firstChild;
    var f = fragmentParent.firstChild;
    while (f) {
      var fNext = f.nextSibling;
      while (s && s.nodeType === 1 && s.tagName === 'STYLE') {
        s = s.nextSibling;
      }
      var matched;
      if (s && f.nodeType === s.nodeType && (f.nodeType !== 1 || f.tagName === s.tagName)) {
        // Nœud serveur compatible → réutilisé. Pour un text node : re-découpe si
        // fusionné, puis corrige le contenu si divergent.
        matched = s;
        if (f.nodeType === 3) {
          var fl = (f.data || '').length;
          if ((s.data || '').length > fl && typeof s.splitText === 'function') {
            s.splitText(fl);
          }
          if (s.data !== f.data) {
            s.data = f.data;
          }
        }
        s = s.nextSibling;
      } else {
        // Pas de correspondance → on insère le nœud fragment ici (déplacé dans le
        // DOM serveur). Si s est null, insertBefore équivaut à un append.
        serverParent.insertBefore(f, s);
        matched = f;
      }
      var keys = nodeToKeys.get(f);
      if (keys) {
        for (var i = 0; i < keys.length; i++) { newRefs[keys[i]] = matched; }
      }
      if (f.firstChild && matched.nodeType === 1) {
        this._mjs_diffAdopt(matched, f, nodeToKeys, newRefs);
      }
      f = fNext;
    }
    // Nœuds serveur excédentaires (hors style) → suppression.
    while (s) {
      var sn = s.nextSibling;
      if (!(s.nodeType === 1 && s.tagName === 'STYLE')) {
        serverParent.removeChild(s);
      }
      s = sn;
    }
  };
}
