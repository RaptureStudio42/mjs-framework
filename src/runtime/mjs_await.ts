// mjs_await — bloc `{await}` (promesse, branches `{success}`/`{error}`). Patch
// de `µ.Element.prototype`, DÉTACHÉ de mjs_element.ts (même technique que
// mjs_on.ts/mjs_flip.ts). `{await expr}...{end}` compile en `this._mjs_updAwait(...)`
// (src/generator/compile.ts), qui délègue le rendu de branche à `_mjs_updIf`
// (mjs_if.ts) — mjs_if.ts est donc TOUJOURS embarqué avec ce fichier
// (bundler/index.ts, wantsAwait force wantsIf). `_mjs_mjsPurgeAwaitMaps` purge les
// états `_mjs_awaitMap`/`_mjs_awaitStates`/`_mjs_awaitLastRender` d'un sous-arbre détruit
// pour de bon — jumeau de `_mjs_mjsPurgeNestedListCaches` (mjs_for.ts), appelé
// depuis `_mjs_mjsPurgeSubtreeState` (mjs_element.ts, cœur) SEULEMENT si
// `this._mjs_awaitMap != null` : sans ce fichier, `_mjs_awaitMap` ne se peuple jamais et
// cet appel reste naturellement hors d'atteinte, jamais un crash.

if (µ.Element) {
  // jumeau await de `_mjs_mjsPurgeNestedListCaches`.
  // `_mjs_awaitMap`/`_mjs_awaitStates`/`_mjs_awaitLastRender` (indexées par id de bloc
  // {await}) n'étaient purgées QUE lorsque `_mjs_updAwait` était rappelé avec une
  // promesse falsy. Un bloc {await} vivant dans une branche {if}/{key} qui se
  // ferme ne revoit jamais `_mjs_updAwait` → l'entrée (dont `state.data`, parfois
  // volumineux) survit jusqu'à la destruction du composant. On purge donc, à la
  // mort DÉFINITIVE du sous-arbre, toute entrée dont l'ancre `s-<id>` y vit.
  µ.Element.prototype._mjs_mjsPurgeAwaitMaps = function(root) {
    const m = this._mjs_awaitMap;
    if (m == null || m.size === 0) return;
    const nodes = this._mjs_nodes;
    if (nodes == null) return;
    let ids = null;
    for (const id of m.keys()) {
      const anchor = nodes['s-' + id];
      if (anchor && (anchor === root || (root.contains && root.contains(anchor)))) {
        (ids || (ids = [])).push(id);
      }
    }
    if (ids) {
      for (let i = 0, n = ids.length; i < n; i++) {
        const id = ids[i];
        m.delete(id);
        if (this._mjs_awaitStates) this._mjs_awaitStates.delete(id);
        if (this._mjs_awaitLastRender) this._mjs_awaitLastRender.delete(id);
      }
    }
  };

  // _mjs_updAwait : pendingFn/successFn/errorFn retournent {fragment, refs}.
  // Pour comparer le rendu précédent, on utilise une simple sentinelle de statut.
  µ.Element.prototype._mjs_updAwait = function(id, promise, pendingFn, successFn, errorFn) {
    var childMode, e, n, ref, s, state, t;
    s = this._mjs_nodes['s-' + id];
    e = this._mjs_nodes['e-' + id];
    if (!(s && e)) {
      return;
    }
    childMode = s.parentNode && s.parentNode.getAttribute
      ? s.parentNode.getAttribute('mjs-childtransition')
      : null;
    if (this._mjs_awaitMap == null) {
      this._mjs_awaitMap = new Map();
    }
    if (this._mjs_awaitStates == null) {
      this._mjs_awaitStates = new Map();
    }
    if (this._mjs_awaitLastRender == null) {
      this._mjs_awaitLastRender = new Map();
    }
    if (!promise) {
      if (this._mjs_awaitMap.has(id)) {
        this._mjs_awaitMap.delete(id);
        this._mjs_awaitStates.delete(id);
        this._mjs_awaitLastRender.delete(id);
        n = s.nextSibling;
        while (n && n !== e) {
          t = n;
          n = n.nextSibling;
          this._mjs_destroyNodeAndChildren(t, childMode === 'all' || childMode === 'out' || childMode === 'transition');
        }
      }
      return;
    }
    if (this._mjs_awaitMap.get(id) !== promise) {
      this._mjs_awaitMap.set(id, promise);
      state = {
        status: 'pending',
        data: null,
        error: null,
        unhandled: false
      };
      this._mjs_awaitStates.set(id, state);
      this._mjs_awaitLastRender.set(id, 'pending');
      this._mjs_updIf(id, pendingFn || null);
      return promise.then((data) => {
        if (this._mjs_awaitMap.get(id) !== promise) {
          return;
        }
        state.status = 'success';
        state.data = data;
        return this._mjs_invalidate('_awaits_');
      }, (error) => {
        if (this._mjs_awaitMap.get(id) !== promise) {
          return;
        }
        state.status = 'error';
        state.error = error;
        // rejet consommé par une branche {error} ? le SSR (renderToString.ts) n'avertit que si non
        state.unhandled = !errorFn;
        return this._mjs_invalidate('_awaits_');
      });
    } else {
      state = this._mjs_awaitStates.get(id);
      if (state) {
        var targetFn = null;
        var targetKey = state.status;
        if (state.status === 'pending' && pendingFn) {
          targetFn = pendingFn;
        } else if (state.status === 'success' && successFn) {
          // Réutilise la closure : capture data dans une fn 0-arg.
          var __data = state.data;
          targetFn = function() { return successFn(__data); };
          targetKey = 'success';
        } else if (state.status === 'error' && errorFn) {
          var __err = state.error;
          targetFn = function() { return errorFn(__err); };
          targetKey = 'error';
        }
        if (targetKey !== this._mjs_awaitLastRender.get(id)) {
          this._mjs_awaitLastRender.set(id, targetKey);
          return this._mjs_updIf(id, targetFn);
        }
      }
    }
  };
}
