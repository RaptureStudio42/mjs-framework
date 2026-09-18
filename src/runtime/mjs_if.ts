// mjs_if — bloc `{if}` (branches conditionnelles). Patch de `µ.Element.prototype`,
// DÉTACHÉ de mjs_element.ts (même technique que mjs_on.ts/mjs_flip.ts : ajouté
// APRÈS la classe). `{if cond}...{elsif}...{else}...{end}` compile en
// `this._mjs_updIf(...)` à la racine, ou `this._mjs_updItemIf(...)` imbriqué dans `{for}`/
// `{await}` (src/generator/compile.ts) — les deux partagent `_mjs_tryReviveDying`
// (réutilise un nœud encore en outro plutôt que de le détruire) ; `_mjs_updIf`
// partage en plus `_mjs_resetNestedMemos` avec `_mjs_updKey` (mjs_key.ts) — invalide
// les mémos des blocs imbriqués qu'un bloc externe vient de recréer, sans quoi
// un `{if}`/`{key}` niché resterait vide à la réouverture du parent.
// `{key}` (mjs_key.ts) et `{await}` (mjs_await.ts) DÉPENDENT de ce fichier :
// `_mjs_updKey` appelle `_mjs_tryReviveDying`/`_mjs_resetNestedMemos`, `_mjs_updAwait` appelle
// `_mjs_updIf` — le bundler force donc mjs_if.ts dès que l'un des deux est embarqué
// (bundler/index.ts, wantsKey/wantsAwait forcent wantsIf).

if (µ.Element) {
  // Tente de réutiliser des nœuds en outro plutôt que de les détruire :
  // on REVERSE l'animation en cours (Web Animations API). Avantage vs
  // cancel+create : continuité parfaite peu importe l'easing (linéaire ou
  // non), pas de snap au baseline, l'easing s'inverse naturellement.
  //
  // **Nesting OK** : si pendant le re-intro l'utilisateur déclenche un nouvel
  // outro (re-mute), `µ._mjs_runTransition` détecte `prev._mjs_transition_state`,
  // appelle `prev.abort()` puis démarre la nouvelle anim depuis la position
  // courante (t1). Pas de superposition d'animations. Le `.then()` du re-intro
  // checke `node._mjs_dying || _mjs_dead` avant de fire `_mjs_cb_introend` →
  // pas de callback parasite si re-outro arrivé entre-temps.
  µ.Element.prototype._mjs_tryReviveDying = function(startNode, endNode, createFnOrNull) {
    var dyingNodes, err, j, len, n, newRoots, node, peek;
    // Accepte une createFn (au lieu d'une string HTML). Si null ou
    // si pas de dying, abort.
    if (!createFnOrNull || typeof createFnOrNull !== 'function') {
      return false;
    }
    // collectait SEULEMENT les nœuds `_mjs_dying`,
    // en ignorant silencieusement tout nœud VIVANT présent entre les ancres.
    // Scénario : {if}/{else} avec outro — branche A part en outro (dying,
    // reste dans le DOM), branche B insérée (vivante). Re-toggle PENDANT
    // l'outro de A : l'ancien code revivait A (dyingNodes=[A] matche) et
    // retournait `true` — le caller `return`ait aussitôt SANS JAMAIS détruire
    // B → A ET B affichées ensemble jusqu'au tick suivant. Fix : la présence
    // d'UN SEUL nœud vivant dans la plage abandonne le revive (retourne
    // `false`), pour que le caller retombe sur le chemin normal
    // destroy-puis-create qui, lui, détruit TOUT le contenu de la plage.
    dyingNodes = [];
    n = startNode.nextSibling;
    while (n && n !== endNode) {
      if (n._mjs_dying) {
        dyingNodes.push(n);
      } else {
        return false;
      }
      n = n.nextSibling;
    }
    if (dyingNodes.length === 0) {
      return false;
    }
    // On appelle createFn pour comparer la structure. Si match, on jette le
    // fragment et on revive ; sinon, on retourne false (caller re-créera).
    peek = createFnOrNull();
    newRoots = Array.from(peek.fragment.children);
    if (dyingNodes.length !== newRoots.length) {
      return false;
    }
    if (!dyingNodes.every(function(dn, i) {
      return dn.tagName === newRoots[i].tagName;
    })) {
      return false;
    }
    for (j = 0, len = dyingNodes.length; j < len; j++) {
      node = dyingNodes[j];
      node._mjs_dying = false;
      node._mjs_dead = false;
      // Ceinture+bretelles — même nettoyage que la
      // revival {for} ci-dessus, au cas où un futur appelant de
      // `µ._mjs_fixPosition` viserait aussi un bloc {if}/{key}/{await} (cf. le
      // commentaire "cas hors-liste" dans sa définition, mjs_easing.ts).
      // No-op aujourd'hui (aucun appelant actuel ne le fait), mais évite un
      // piège identique si ça change.
      if (typeof µ._mjs_unfixPosition === 'function') {
        µ._mjs_unfixPosition(node);
      }
      // l'accroche d'appariement (_mjs_updKey/_mjs_updIf, lue par les sorties
      // reveal/flip/cube/turn) survivait à la résurrection : un node ressuscité restait
      // « apparié » à un fragment neuf qui n'existe plus
      node._mjs_pairedWith = void 0;
      try {
        if (typeof node._mjs_cb_introstart === "function") {
          node._mjs_cb_introstart();
        }
      } catch (error1) {
        null;
      }
      if (node._mjs_intro) {
        try {
          (function(node) {
            return µ._mjs_whenLayouted(node, function() {
              return µ._mjs_playTransition(node, node._mjs_intro, 'in').then(function() {
                if (node._mjs_dying || node._mjs_dead) {
                  return;
                }
                try {
                  return typeof node._mjs_cb_introend === "function" ? node._mjs_cb_introend() : void 0;
                } catch (error1) {
                  return null;
                }
              }).catch(function(err) {
                return µ.warn("[ModularJS] Re-intro failed:", err);
              });
            });
          })(node);
        } catch (error1) {
          err = error1;
          µ.error("[ModularJS] Échec re-intro:", err);
        }
      }
    }
    return true;
  };

  // _mjs_updIf prend une createFn qui retourne {fragment, refs}.
  // Plus de parse HTML, plus de cache template, plus de walk paths.
  µ.Element.prototype._mjs_updIf = function(id, createFn) {
    var built, childMode, destroyCount, dyingCount, e, firstNew, n, outroNodes, ref, ref1, s, t;
    s = this._mjs_nodes['s-' + id];
    e = this._mjs_nodes['e-' + id];
    if (!(s && e)) {
      return;
    }
    if (µ.debug) {
      µ.log(`[mjs-tx] _mjs_updIf ${id} createFn=${!!createFn} childMode=${(ref = s.parentNode) != null ? typeof ref.getAttribute === "function" ? ref.getAttribute('mjs-childtransition') : void 0 : void 0}`);
    }
    if (this._mjs_tryReviveDying(s, e, createFn)) {
      return;
    }
    childMode = s.parentNode && s.parentNode.getAttribute
      ? s.parentNode.getAttribute('mjs-childtransition')
      : null;
    n = s.nextSibling;
    dyingCount = 0;
    destroyCount = 0;
    outroNodes = []; // accroche d'appariement, lue par les sorties de reveal/flip/cube/turn
    while (n && n !== e) {
      t = n;
      n = n.nextSibling;
      if (t._mjs_dying) {
        dyingCount++;
      } else {
        destroyCount++;
        this._mjs_destroyNodeAndChildren(t, childMode === 'all' || childMode === 'out' || childMode === 'transition');
        if (t._mjs_dying && t._mjs_outro) outroNodes.push(t);
      }
    }
    if (µ.debug) {
      µ.log(`[mjs-tx] _mjs_updIf ${id} dying_left=${dyingCount} destroyed=${destroyCount}`);
    }
    if (!createFn) {
      return;
    }
    built = createFn();
    // Merge les refs dans this._mjs_nodes pour que les bindings enfants puissent
    // les retrouver. Enregistre aussi les éléments dans _nodeIds (event routing).
    if (built.refs) {
      var refs = built.refs;
      const __refKeys = Object.keys(refs);
      for (let __ri = 0, __rln = __refKeys.length; __ri < __rln; __ri++) {
        const __rid = __refKeys[__ri];
        this._mjs_nodes[__rid] = refs[__rid];
      }
      this._mjs_registerRefs(refs);
    }
    // (b) — invalide les mémos des blocs imbriqués recréés (asymétrie corrigée
    // avec _mjs_updKey) : sinon un {if} niché dans ce {if} rouvert resterait VIDE.
    this._mjs_resetNestedMemos(built);
    // accroche d'appariement : le fragment se vide à l'insertion,
    // firstNew se lit AVANT ; chaque ancien en sortie pointe vers le neuf, lu par
    // les sorties de reveal/flip/cube/turn (µ._mjs_fixPosition, setupOut).
    firstNew = built.fragment.firstElementChild;
    if (firstNew) {
      for (let __oi = 0, __oln = outroNodes.length; __oi < __oln; __oi++) {
        outroNodes[__oi]._mjs_pairedWith = firstNew;
      }
    }
    return s.parentNode.insertBefore(built.fragment, e);
  };

  // _mjs_updItemIf : variante de _mjs_updIf pour {if}/{key} imbriqués dans {for}.
  // Au lieu d'écrire dans this._mjs_nodes (global), on écrit dans __nodes (local item).
  // createFn() retourne {fragment, refs} ; on merge refs dans __nodes.
  µ.Element.prototype._mjs_updItemIf = function(startNode, endNode, createFn, __nodes) {
    var built, childMode, n, ref, t;
    if (!(startNode && endNode)) {
      return;
    }
    if (this._mjs_tryReviveDying(startNode, endNode, createFn)) {
      return;
    }
    // Simplify Coffee ternaire chain. parentNode existe (asserted plus haut).
    childMode = startNode.parentNode && startNode.parentNode.getAttribute
      ? startNode.parentNode.getAttribute('mjs-childtransition')
      : null;
    n = startNode.nextSibling;
    while (n && n !== endNode) {
      t = n;
      n = n.nextSibling;
      if (!t._mjs_dying) {
        this._mjs_destroyNodeAndChildren(t, childMode === 'all' || childMode === 'out' || childMode === 'transition');
      }
    }
    if (!createFn) {
      return;
    }
    built = createFn();
    if (built.refs) {
      var refs = built.refs;
      if (__nodes) {
        const __refKeys = Object.keys(refs);
        for (let __ri = 0, __rln = __refKeys.length; __ri < __rln; __ri++) {
          const __rid = __refKeys[__ri];
          __nodes[__rid] = refs[__rid];
        }
      }
      this._mjs_registerRefs(refs);
    }
    return startNode.parentNode.insertBefore(built.fragment, endNode);
  };

  // Invalide les mémos `_mjs_old[<id>]` / `_mjs_key_cache` des blocs structurels IMBRIQUÉS
  // (refs `s-<id>`) qu'un bloc externe vient de RECRÉER (nouveaux anchors). Sans
  // ça, le wrapper `if(c !== this._mjs_old[<id>]){ _mjs_updIf(...) }` court-circuiterait et
  // la branche interne resterait VIDE (cas : un {if}/{key} contenant un {if}, dont
  // le parent rouvre). Appelé par _mjs_updKey ET _mjs_updIf après le merge des refs.
  µ.Element.prototype._mjs_resetNestedMemos = function(built) {
    if (!built || !built.refs) return;
    // mémo des branches dans un OBJET (`_mjs_old`) : la clé y est le seul texte
    // reconstruit, le nom de propriété reste pointé — donc raccourcissable en prod
    const __old = this._mjs_old;
    for (const __rk in built.refs) {
      if (__rk.charCodeAt(0) === 115 && __rk.charCodeAt(1) === 45) { // 's-'
        const __bid = __rk.slice(2);
        if (__old && __old[__bid] !== undefined) __old[__bid] = undefined;
        if (this._mjs_key_cache && this._mjs_key_cache.hasOwnProperty(__bid)) {
          delete this._mjs_key_cache[__bid];
        }
      }
    }
  };
}
