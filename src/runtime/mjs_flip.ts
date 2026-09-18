// mjs_flip.coffee
var originalReconcileList;

if (µ.Element) {
  originalReconcileList = µ.Element.prototype._mjs_reconcileList;
  // Alignement strict sur la nouvelle signature de réconciliation latérale
  µ.Element.prototype._mjs_reconcileList = function(cacheId, startNode, endNode, childMode, col, tplFn, keyFn, updateFn) {
    var flipNodes, rects, result;
    // Flag posé au compile-time (`static _mjs_hasFlip`, cf. template.ts) quand
    // le composant déclare `@flip`. Avant, le code lisait `this._has_flip` qui
    // n'était JAMAIS assigné → le wrapper FLIP ne s'activait jamais (`@flip`
    // inerte). On lit désormais le static réellement émis.
    if (!this.constructor._mjs_hasFlip) {
      return originalReconcileList.apply(this, arguments);
    }
    // Garde PAR LISTE (cacheId), PAS par composant. Un composant avec 2 listes
    // animées (ex. todo + done) doit pouvoir FLIP-er les DEUX dans le même tick.
    // Avant : un booléen unique `_is_flipping` → seule la 1ʳᵉ liste réconciliée
    // était animée, la 2ᵈ sautait → asymétrie coche/décoche (le trou se ferme en
    // glissant d'un côté, snap de l'autre, selon l'ordre de rendu des `{for}`).
    if (this._mjs_flipping_cids == null) {
      this._mjs_flipping_cids = new Set();
    }
    if (this._mjs_flipping_cids.has(cacheId)) {
      return originalReconcileList.apply(this, arguments);
    }
    this._mjs_flipping_cids.add(cacheId);
    flipNodes = [];
    if (this._mjs_list_cache && this._mjs_list_cache[cacheId]) {
      this._mjs_list_cache[cacheId].forEach(function(entry) {
        return entry.nodes.forEach(function(n) {
          if (n.nodeType === 1) {
            if (n.hasAttribute('mjs-flip')) {
              flipNodes.push(n);
            }
            return n.querySelectorAll('[mjs-flip]').forEach(function(child) {
              return flipNodes.push(child);
            });
          }
        });
      });
    }
    // 1. FIRST (Mesure)
    rects = new Map();
    flipNodes.forEach(function(n) {
      var identifier, key;
      key = n.getAttribute('mjs-key');
      identifier = key ? key : n;
      return rects.set(identifier, {
        rect: n.getBoundingClientRect(),
        parent: n.parentNode
      });
    });
    // 2. MUTATION (Application de la réconciliation)
    try {
      result = originalReconcileList.apply(this, arguments);
    } catch (err) {
      // Sans cette purge, une exception de réconciliation laissait le cacheId
      // dans le Set → la garde court-circuitait toutes les passes suivantes :
      // FLIP définitivement désactivé pour cette liste.
      this._mjs_flipping_cids.delete(cacheId);
      throw err;
    }
    // 3. MICRO-TICK & PLAY
    Promise.resolve().then(() => {
      var newFlipNodes;
      this._mjs_flipping_cids.delete(cacheId);
      newFlipNodes = [];
      if (this._mjs_list_cache && this._mjs_list_cache[cacheId]) {
        this._mjs_list_cache[cacheId].forEach(function(entry) {
          return entry.nodes.forEach(function(n) {
            if (n.nodeType === 1) {
              if (n.hasAttribute('mjs-flip')) {
                newFlipNodes.push(n);
              }
              return n.querySelectorAll('[mjs-flip]').forEach(function(child) {
                return newFlipNodes.push(child);
              });
            }
          });
        });
      }
      // Liste CIBLE vs SOURCE. Si cette liste a GAGNÉ un node ce tick (un
      // arrivant via @in : présent dans newFlipNodes mais SANS position
      // antérieure dans `rects`), c'est la colonne CIBLE → le trou d'accueil
      // doit s'ouvrir IMMÉDIATEMENT (delay=0) pour que l'élément en cours de
      // crossfade ait un emplacement où atterrir. Sinon (liste SOURCE qui PERD
      // un node), la fermeture du trou reste différée (`mjs-flip-delay`) le
      // temps que le crossfade se termine.
      var listGained = newFlipNodes.some(function(n) {
        var k = n.getAttribute('mjs-key');
        return !rects.get(k ? k : n);
      });
      // PERF — 3 PASSES pour ne forcer qu'UN SEUL reflow au lieu
      // d'un par nœud. Avant, par nœud : cancel (écriture) → getBoundingClientRect
      // (lecture sur layout sale → reflow) → animate (écriture), entrelacés → ~n
      // recalculs de layout sur n éléments réordonnés. On sépare : (1) cancel de
      // TOUS les mjs-flip en vol, (2) mesure de TOUS les newRect (un reflow), (3)
      // deltas + animate. Bonus correction : la mesure de nᵢ n'est plus polluée
      // par le transform encore actif d'un voisin nⱼ.
      //
      // le cancel des FLIP précédents
      // encore en vol reste AVANT toute mesure : `getBoundingClientRect()`
      // reflète le `transform` CSS actif, un ancien `mjs-flip` non annulé
      // contaminerait `newRect` de son décalage résiduel → `deltaX/deltaY` faux
      // → saut visuel au redémarrage de l'anim interrompue. La passe 1 le
      // garantit désormais pour TOUS les nœuds avant la moindre lecture.

      // PASSE 1 — annuler TOUS les mjs-flip encore en vol.
      newFlipNodes.forEach(function(n) {
        if (typeof n.getAnimations === "function") {
          n.getAnimations().forEach(function(a) {
            if (a.id === 'mjs-flip') {
              return a.cancel();
            }
          });
        }
      });
      // PASSE 2 — mesurer TOUS les newRect (un seul reflow pour l'ensemble).
      var measures = [];
      newFlipNodes.forEach(function(n) {
        var identifier, key, oldData;
        key = n.getAttribute('mjs-key');
        identifier = key ? key : n;
        oldData = rects.get(identifier);
        if (!oldData) {
          return;
        }
        if (oldData.parent !== n.parentNode) {
          return;
        }
        return measures.push({
          n: n,
          oldRect: oldData.rect,
          newRect: n.getBoundingClientRect()
        });
      });
      // PASSE 3 — deltas + animate (écritures groupées).
      return measures.forEach(function(m) {
        var deltaX, deltaY, duration, flipDelay, flipEasing, n, newRect, oldRect;
        n = m.n;
        oldRect = m.oldRect;
        newRect = m.newRect;
        deltaX = oldRect.left - newRect.left;
        deltaY = oldRect.top - newRect.top;
        if (deltaX !== 0 || deltaY !== 0) {
          duration = parseInt(n.getAttribute('mjs-flip'));
          if (isNaN(duration)) {
            duration = 200;
          }
          flipDelay = listGained ? 0 : parseInt(n.getAttribute('mjs-flip-delay'));
          if (isNaN(flipDelay)) {
            flipDelay = 0;
          }
          flipEasing = n.getAttribute('mjs-flip-easing') || 'cubic-bezier(0.25, 1, 0.5, 1)';
          return n.animate([
            {
              transform: `translate(${deltaX}px, ${deltaY}px)`
            },
            {
              transform: 'translate(0px, 0px)'
            }
          ], {
            duration: duration,
            delay: flipDelay,
            // `backwards` : pendant le délai, l'élément reste au 1er keyframe
            // (translate(delta) = son ANCIENNE position) au lieu de sauter à la
            // nouvelle. C'est ce qui rend la fermeture du trou SÉQUENTIELLE
            // (attend la fin du crossfade avant de glisser).
            fill: 'backwards',
            easing: flipEasing,
            id: 'mjs-flip'
          });
        }
      });
    });
    return result;
  };
}
