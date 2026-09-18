// mjs_on — rune `µon` (délégation d'événement manuelle, hors template). Patch de
// `µ.Element.prototype._mjs_on`, DÉTACHÉ de mjs_element.ts (même technique que
// mjs_flip.ts/mjs_title.ts : ajouté APRÈS la classe, DOIT rester après mjs_element.ts
// dans la concaténation). `µon 'evt', selecteur, handler` compile en `@_mjs_on(...)`
// (transpiler/index.ts, `µ\.?\s*on\b` → `@_mjs_on`) — un composant qui n'écrit jamais
// `µon`/`µ.on` n'appelle donc jamais cette méthode, elle peut manquer sans risque.
if (µ.Element) {
  µ.Element.prototype._mjs_on = function(eventName, selectorOrHandler, handlerOrNone) {
    var handler, root, selector, wrapper;
    if (typeof selectorOrHandler === 'function') {
      handler = selectorOrHandler;
      selector = null;
    } else {
      selector = selectorOrHandler;
      handler = handlerOrNone;
    }
    wrapper = (e) => {
      var delegatedTarget, realTarget;
      if (!selector) {
        return handler.call(this, e);
      } else {
        realTarget = (typeof µ.realTarget === "function" ? µ.realTarget(e) : void 0) || (typeof e.composedPath === 'function' ? e.composedPath()[0] : e.target);
        delegatedTarget = realTarget.closest(selector);
        if (delegatedTarget) {
          // Expose l'élément matché via `e.currentTarget` (sémantique DOM
          // standard / parité Svelte-React) EN PLUS du 2e argument. Sans ça,
          // sur un event délégué (qui bubble), `e.currentTarget` = la racine de
          // délégation (shadow root) → `e.currentTarget.getBoundingClientRect()`
          // échoue. Cas vécu : seek slider de l'audio-player.
          try {
            Object.defineProperty(e, 'currentTarget', { value: delegatedTarget, configurable: true });
          } catch (_err) { /* event read-only strict : on se rabat sur le 2e arg */ }
          try {
            return handler.call(this, e, delegatedTarget);
          } finally {
            // Restaure le getter natif : l'event POURSUIT sa propagation et un
            // listener tiers (analytics, lib externe) lisait notre valeur figée.
            try { delete e.currentTarget; } catch (_e2) { /* read-only */ }
          }
        }
      }
    };
    root = this._shadow || this;
    return root.addEventListener(eventName, wrapper);
  };
}
