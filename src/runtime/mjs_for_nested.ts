// mjs_for_nested — `{for}` dont les ancres ne sont pas celles du composant : une liste DANS une
// autre liste, ou dans une branche `{await}`. `_mjs_updList` est le jumeau de `_mjs_updFor` (mjs_for.ts)
// pour ces deux cas — il reçoit les nœuds d'ancrage et un identifiant de cache propre à
// l'instance de boucle, là où `_mjs_updFor` les retrouve dans `this._mjs_nodes`. Patch de
// `µ.Element.prototype`, DÉTACHÉ de mjs_for.ts, DOIT rester après mjs_element.ts (qui définit
// µ.Element) et va toujours AVEC mjs_for.ts, dont il appelle `_mjs_reconcileList`.
//
// DÉTECTÉ sur le code compilé (bundler/features.ts, clé `for_nested`) : le générateur émet
// `this._mjs_updList(` pour ces deux formes SEULEMENT (generator/compile.ts) — un `{for}` de racine,
// dans un `{if}` ou dans un `{key}` compile en `this._mjs_updFor(`.
if (µ.Element) {
  µ.Element.prototype._mjs_updList = function(cacheId, startNode, endNode, col, tplFn, keyFn, updateFn, keyAttr) {
    var childMode, parent;
    // cf. _mjs_updFor : falsy col ⇒ teardown, pas de fantômes.
    if (!(startNode && endNode)) {
      return;
    }
    parent = startNode.parentNode;
    if (parent && parent._mjs_ctMode === void 0) {
      parent._mjs_ctMode = (typeof parent.getAttribute === "function")
        ? (parent.getAttribute('mjs-childtransition') || null)
        : null;
    }
    childMode = parent ? parent._mjs_ctMode : null;
    return this._mjs_reconcileList(cacheId, startNode, endNode, childMode, col, tplFn, keyFn, updateFn, keyAttr);
  };
}
