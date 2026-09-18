// mjs_dynamic — <@element tag={…}> et <@module comp={…}> : balise/composant dynamiques
// (équivalents <svelte:element>/<svelte:component this={X}>). DÉTACHÉ du cœur : embarqué
// seulement si une source du projet écrit `<@element`/`<@module` (scan textuel, cf.
// bundler/index.ts) — le µeffect qui pilote la mise à jour dépend aussi de mjs_effect.ts,
// forcé par le même signal.
//
// Le transpiler rend un placeholder <div mjs-el="N"> avec les enfants, et émet
// un µeffect appelant µ._updDynEl(@, 'N', tag). On localise le nœud courant (par
// marqueur la 1ʳᵉ fois, puis via la map), et si le tag change on crée le nouvel
// élément, copie les attrs, DÉPLACE les enfants (préserve leur réactivité, leurs
// node-ids), remplace le nœud, et mémorise le nouveau. tag falsy → on masque
// (Svelte ne rend rien). Même logique que `_updElement` mais repérée par marqueur.
// SÉCURITÉ — le texte des enfants déplacés dans une de ces balises s'exécute (script) ou
// charge une ressource externe (iframe/object/embed/base/link/meta/style) : <@element $tag>/
// <@module $comp> choisis par l'ÉTAT ne peuvent pas y devenir SANS acceptation explicite (4e
// argument `accept`). `accept` ABSENT → seul ce pool de 8 balises refuse ; `accept` PRÉSENT →
// liste FERMÉE, pool ou pas — seuls les noms qu'il contient sont créés (cf. µ._updDynEl/
// µ._updModule ci-dessous).
µ._mjs_dynTagsRefuses = ['script', 'iframe', 'object', 'embed', 'base', 'link', 'meta', 'style'];

// µ._mjs_dynAcceptList — normalise le 4e argument `accept` de µ._updDynEl/µ._updModule :
// `accept` passé en CHAÎNE (`'iframe'`, `'iframe
// style'`) plantait les deux fonctions, `TypeError: accept.map is not a function`, l'appelant
// n'ayant jamais promis un tableau. Tolérance : absent (null/undefined) → liste vide, sans warn ;
// chaîne → découpée sur les blancs ; tableau → inchangé (`.map` comme avant) ; tout autre type
// (nombre, booléen, objet…) → liste vide + 1 warn (mieux qu'un plantage muet).
µ._mjs_dynAcceptList = function(accept) {
  if (accept == null) return [];
  if (typeof accept === 'string') return accept.trim().split(/\s+/).filter(Boolean).map(function(a) { return a.toLowerCase(); });
  if (Array.isArray(accept)) return accept.map(function(a) { return String(a).trim().toLowerCase(); });
  µ.warn('[ModularJS] <@element>/<@module> : accept attend une liste de noms (tableau ou chaîne séparée par des espaces)');
  return [];
};

// masque/démasque partagés entre µ._updDynEl et µ._updModule. Le
// marqueur `_mjs_mjsMasque` distingue NOTRE display:none (posé par la garde falsy) d'un display
// choisi par l'auteur : `removeProperty` ne part jamais sur un style qu'on n'a pas nous-même
// écrasé. `_mjs_mjsDisplayAvant` mémorise la valeur d'auteur AVANT l'écrasement (idempotent : un
// second masquage ne réécrit pas la mémoire) pour la restaurer telle quelle au démasquage —
// sans elle, un `style="display:flex"` masqué puis re-basculé perdait sa valeur pour de bon.
µ._mjs_dynMask = function(cur) {
  if (!cur.style) return;
  if (!cur._mjs_mjsMasque) cur._mjs_mjsDisplayAvant = cur.style.display;
  cur.style.display = 'none';
  cur._mjs_mjsMasque = true;
};
µ._mjs_dynUnmask = function(cur) {
  if (!cur.style || !cur._mjs_mjsMasque) return;
  if (cur._mjs_mjsDisplayAvant) cur.style.display = cur._mjs_mjsDisplayAvant;
  else cur.style.removeProperty('display');
  cur._mjs_mjsMasque = false;
  cur._mjs_mjsDisplayAvant = null;
};

µ._updDynEl = function(component, key, tag, accept) {
  component._mjs_dynEls || (component._mjs_dynEls = {});
  var cur = component._mjs_dynEls[key];
  // Un bloc {if}/{key}/{await} refermé puis rouvert RECRÉE le placeholder :
  // le cache pointerait l'ancien nœud détaché (replaceWith = no-op silencieux,
  // ou pire early-return sur tagName identique) → on invalide et on re-query.
  if (cur && !cur.isConnected) {
    delete component._mjs_dynEls[key];
    cur = null;
  }
  if (!cur) {
    cur = component._shadow.querySelector('[mjs-el="' + key + '"]');
    if (!cur) return;
    component._mjs_dynEls[key] = cur;
  }
  // tag falsy → masquer (garde AUSSI la valeur ÉPURÉE : ' ' seul passait la garde
  // brute puis levait sur document.createElement('') — bruyant, capté par le µeffect englobant
  // seulement). UNE SEULE valeur trimmée pour la garde, la comparaison, la
  // création ET le message.
  var tagStr = (tag == null || tag === false) ? '' : String(tag).trim();
  if (tagStr === '') {
    µ._mjs_dynMask(cur);
    return;
  }
  var newTagName = tagStr.toUpperCase();
  // même tag qu'au placeholder : démasque seulement si NOUS avions masqué (sinon
  // un display d'auteur au premier rendu était détruit avant même d'avoir servi).
  if (cur.tagName === newTagName) {
    µ._mjs_dynUnmask(cur);
    return;
  }
  // SÉCURITÉ — accept ABSENT : pool `µ._mjs_dynTagsRefuses` seul refuse (8 balises). accept
  // PRÉSENT (chaîne ou tableau, casse insensible) : liste FERMÉE, seuls les noms qu'elle contient
  // sont créés — pool ou pas ; une liste normalisée vide n'autorise donc plus rien.
  var norm = tagStr.toLowerCase();
  var hasAccept  = typeof accept === 'string' || Array.isArray(accept);
  var acceptNorm = µ._mjs_dynAcceptList(accept);
  var refusePool = !hasAccept && µ._mjs_dynTagsRefuses.indexOf(norm) !== -1;
  var refuseList = hasAccept && acceptNorm.indexOf(norm) === -1;
  if (refusePool) {
    return µ.warn('[ModularJS] <@element>/<@module> : balise « ' + norm + ' » refusée — un élément dynamique ne peut pas devenir ' + norm + ' ; pour l\'autoriser explicitement : accept="' + norm + '".');
  }
  if (refuseList) {
    return µ.warn('[ModularJS] <@element>/<@module> : balise « ' + norm + ' » refusée — hors de la liste accept="' + acceptNorm.join(' ') + '" ; quand accept est présent, seuls les noms qu\'il liste sont créés.');
  }
  // retire NOTRE masque avant de copier les attributs vers le nouveau nœud :
  // sinon un nœud masqué puis basculé vers un autre tag hérite du display:none (la boucle copie
  // l'attribut `style` de l'ancien nœud). `_mjs_dynUnmask` ne touche RIEN si on n'a
  // jamais masqué (un display d'auteur au tout premier rendu survit donc, intact).
  µ._mjs_dynUnmask(cur);
  var nn = document.createElement(tagStr), i, a = cur.attributes;
  for (i = 0; i < a.length; i++) {
    if (a[i].name !== 'mjs-el') nn.setAttribute(a[i].name, a[i].value);
  }
  // `style` fait déjà partie de `cur.attributes`
  // (reflété par le DOM), donc recopié par la boucle ci-dessus ; cette ligne le rend EXPLICITE
  // plutôt que déductif, filet de sécurité pour l'état posé par un effet @style.* juste avant
  // le remplacement. `cur.style` est TOUJOURS truthy (tout
  // nœud DOM porte un CSSStyleDeclaration) : la garde ne protégeait rien, un nœud SANS aucun style
  // héritait d'un `style=""` parasite (`cssText = ''` crée l'attribut). On ne recopie désormais que
  // si l'ancien nœud portait réellement du style.
  if (cur.style && cur.style.cssText) nn.style.cssText = cur.style.cssText;
  while (cur.firstChild) nn.appendChild(cur.firstChild);
  // recopie l'id de routage événementiel : posé par
  // _mjs_registerRefs en PROP `_mjs_ids` sur le nœud (jamais un attribut DOM, donc jamais recopié par
  // la boucle d'attributs ci-dessus), lu par _mjs_bindEvents pendant la remontée de délégation. Sans
  // cette ligne, un `@click={…}` posé DIRECTEMENT sur <@element>/<@module> cessait de répondre dès
  // le 1er remplacement de nœud (distinct de la resync `_mjs_nodes`
  // ci-dessous : deux mécanismes de liaison différents, deux résyncs différentes).
  if (cur._mjs_ids) nn._mjs_ids = cur._mjs_ids;
  // `_mjs_once_fired` (mjs_element.ts) est une
  // WeakMap<nœud, Set<clé>> : le nouveau nœud est une clé neuve, un `.once` déjà déclenché
  // repartait donc à chaque remplacement. On transfère l'entrée existante vers le nouveau nœud.
  var onceMap = component._mjs_once_fired; if (onceMap && onceMap.has(cur)) onceMap.set(nn, onceMap.get(cur));
  cur.replaceWith(nn);
  component._mjs_dynEls[key] = nn;
  // resynchronise toute référence du composant qui pointait sur l'ancien nœud : une
  // liaison réactive (@style.*, attribut) posée sur ce <@element> compile vers `this._mjs_nodes.sN`,
  // figée sur le placeholder sans cette passe — les effets suivants écriraient pour toujours sur
  // un nœud détaché, en silence (liaison orpheline après replaceWith).
  if (component._mjs_nodes) {
    for (var k in component._mjs_nodes) { if (component._mjs_nodes[k] === cur) component._mjs_nodes[k] = nn; }
  }
};

// ============================================================================
// <@module $comp> — composant dynamique (équivalent <svelte:component this={X}>)
// ============================================================================
// Calqué sur µ._updDynEl, mais le 3ᵉ argument désigne un COMPOSANT, pas un tag :
//   - une CHAÎNE = nom de tag d'un custom element MJS défini (cas idiomatique :
//     les composants se référencent par leur tag kebab) → document.createElement ;
//   - une CLASSE/constructeur → `new Comp()` en best-effort (try/catch : un
//     composant MJS est enregistré via un wrapper anonyme, donc `new` direct peut
//     lever « Illegal constructor » — d'où le filet).
// On copie les attrs (= props), DÉPLACE les enfants (light DOM → slots), remplace
// le nœud, et re-monte si le composant change. Falsy → on masque (rien rendu).
µ._updModule = function(component, key, Comp, accept) {
  component._mjs_mods || (component._mjs_mods = {});
  var cur = component._mjs_mods[key];
  if (cur && !cur.isConnected) {
    delete component._mjs_mods[key];
    cur = null;
  }
  if (!cur) {
    cur = component._shadow.querySelector('[mjs-mod="' + key + '"]');
    if (!cur) return;
    component._mjs_mods[key] = cur;
  }
  if (Comp == null || Comp === false || Comp === '') {
    µ._mjs_dynMask(cur);
    return;
  }
  var nn = null;
  if (typeof Comp === 'string') {
    // cf. commentaire jumeau sur µ._updDynEl ci-dessus : une SEULE valeur trimmée
    // pour la comparaison, la création ET le message.
    var compStr = Comp.trim();
    // épurée VIDE (espaces seuls) : même garde que la forme falsy brute, sinon
    // document.createElement('') lève plus loin.
    if (compStr === '') {
      µ._mjs_dynMask(cur);
      return;
    }
    // Déjà monté sur ce tag ? → ne pas recréer (préserve l'état du composant).
    if (cur.tagName === compStr.toUpperCase()) {
      µ._mjs_dynUnmask(cur);
      return;
    }
    // SÉCURITÉ — même garde que µ._updDynEl : accept ABSENT → pool `µ._mjs_dynTagsRefuses` seul
    // refuse ; accept PRÉSENT → liste FERMÉE, seuls les noms qu'elle contient sont créés, pool ou
    // pas.
    var norm = compStr.toLowerCase();
    var hasAccept  = typeof accept === 'string' || Array.isArray(accept);
    var acceptNorm = µ._mjs_dynAcceptList(accept);
    var refusePool = !hasAccept && µ._mjs_dynTagsRefuses.indexOf(norm) !== -1;
    var refuseList = hasAccept && acceptNorm.indexOf(norm) === -1;
    if (refusePool) {
      return µ.warn('[ModularJS] <@element>/<@module> : balise « ' + norm + ' » refusée — un élément dynamique ne peut pas devenir ' + norm + ' ; pour l\'autoriser explicitement : accept="' + norm + '".');
    }
    if (refuseList) {
      return µ.warn('[ModularJS] <@element>/<@module> : balise « ' + norm + ' » refusée — hors de la liste accept="' + acceptNorm.join(' ') + '" ; quand accept est présent, seuls les noms qu\'il liste sont créés.');
    }
    nn = document.createElement(compStr);
  } else if (typeof Comp === 'function') {
    // Déjà cette classe ? → ne pas recréer.
    if (cur.constructor === Comp) {
      µ._mjs_dynUnmask(cur);
      return;
    }
    try { nn = new Comp(); }
    catch (e) {
      return µ.warn('[ModularJS] <@module> : impossible d\'instancier le composant. ' +
        'Passe le NOM de tag (chaîne kebab du custom element) plutôt que la classe.');
    }
  } else {
    return;
  }
  // cf. commentaire jumeau sur µ._updDynEl ci-dessus : retire NOTRE masque avant
  // de copier les attributs, qu'il s'agisse d'un tag ou d'une classe. Seulement si
  // NOUS avions masqué.
  µ._mjs_dynUnmask(cur);
  var i, a = cur.attributes;
  for (i = 0; i < a.length; i++) {
    if (a[i].name !== 'mjs-mod') nn.setAttribute(a[i].name, a[i].value);
  }
  // cf. commentaire jumeau sur µ._updDynEl ci-dessus : filet explicite pour `style`.
  // cf. commentaire jumeau sur µ._updDynEl ci-dessus : garde `cssText` non vide (régression,
  // `style=""` parasite).
  if (cur.style && cur.style.cssText) nn.style.cssText = cur.style.cssText;
  while (cur.firstChild) nn.appendChild(cur.firstChild);
  // cf. commentaire jumeau sur µ._updDynEl ci-dessus : recopie l'id de routage
  // événementiel `_mjs_ids`.
  if (cur._mjs_ids) nn._mjs_ids = cur._mjs_ids;
  // cf. commentaire jumeau sur µ._updDynEl ci-dessus : transfère l'entrée `.once` déjà
  // déclenchée vers le nouveau nœud.
  var onceMap = component._mjs_once_fired; if (onceMap && onceMap.has(cur)) onceMap.set(nn, onceMap.get(cur));
  cur.replaceWith(nn);
  component._mjs_mods[key] = nn;
  // cf. commentaire jumeau sur µ._updDynEl ci-dessus : resynchronise `component._mjs_nodes`
  // vers le nouveau nœud.
  if (component._mjs_nodes) {
    for (var k in component._mjs_nodes) { if (component._mjs_nodes[k] === cur) component._mjs_nodes[k] = nn; }
  }
};
