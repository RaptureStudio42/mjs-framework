// mjs_destroy_hooks — chemin LENT de `_mjs_destroyNodeAndChildren` (mjs_element.ts, cœur) :
// orchestration des transitions de sortie (`@transition`/`@in`/`@out`), des teardowns
// (`@attach`/`@this=!`) et de la cascade `@flip`. Le chemin RAPIDE (aucun hook de destruction
// déclaré nulle part dans le projet, drapeau `static _mjs_noDestroyHooks = true` posé par le
// compilateur) reste dans mjs_element.ts — appelé pour CHAQUE destruction, il ne peut pas
// bouger. Patch de `µ.Element.prototype`, DÉTACHÉ du cœur (même technique que mjs_on.ts).
//
// Signal de détection : scan de `@this=!`/`@transition`/`@in`/`@out`/`@flip`/`@attach`
// (bundler/index.ts, scanRuntimeFeatures) — les 5 SEULS émetteurs de `hasDestroyHooks = true`
// au compilateur (generator/attributes/index.ts, vérifié un à un). Si AUCUN composant du projet
// (ni aucun module du framework qu'il utilise, transitivité déjà en place) n'en écrit aucun,
// `hasDestroyHooks` vaut `false` PARTOUT ⇒ `_mjs_noDestroyHooks === true` pour CHAQUE instance
// ⇒ le fast-path de mjs_element.ts retourne TOUJOURS avant d'atteindre ce fichier : il peut
// donc manquer sans risque. Si au moins un composant le détecte, CE fichier doit être présent —
// filet défensif quand même côté mjs_element.ts (mêmes gestes que son propre fast-path) au cas
// où un bug de détection manquerait un émetteur.
if (µ.Element) {
  µ.Element.prototype._mjs_destroyWithHooks = async function(node, waitOut) {
    var elements, timeoutId, transitions;
    node._mjs_dying = true;
    // Élément SORTANT avec un outro : on CAPTURE sa position visuelle MAINTENANT
    // (synchrone, avant que `_mjs_reconcileList` ne le déplace en dying-tail). On ne
    // l'épingle pas tout de suite (sinon, en absolute sans top/left, il suivrait
    // le déplacement DOM). L'épinglage se fait dans la dying-tail, APRÈS le move,
    // via cette rect (cf. _mjs_reconcileList → µ._mjs_fixPosition). Corrige le crossfade
    // qui partait du bas de liste au lieu de la vraie position du nœud.
    if (node._mjs_outro && node.getBoundingClientRect) {
      node._mjs_xfRect = node.getBoundingClientRect();
    }
    if (µ.debug) {
      µ.log(`[mjs-tx] _mjs_destroyNodeAndChildren tag=${node.tagName} waitOut=${waitOut} hasOutro=${!!node._mjs_outro}`);
    }
    transitions = [];
    // FAST PATH : le node n'a ni transitions/teardowns à orchestrer, ni descendants
    // taggés `.global`, ni cascade outro à attendre. C'est le cas par défaut sur
    // un destroy de masse (1000+ items dans le bench officiel) → on évite N
    // querySelectorAll coûteux et le pipeline transitions/teardowns.
    if (!waitOut && !node._mjs_outro && !node._mjs_td && !node._mjs_ref_td) {
      // Détection rapide des descendants concernés : si aucun n'est `.global`,
      // pas besoin de scanner finement. On utilise `querySelector` (early-exit)
      // au lieu de `querySelectorAll` (matérialise toutes les correspondances).
      if (!node.querySelector || !node._mjs_has_globals_cache) {
        if (node.querySelector) {
          // On parcourt rapidement les descendants pour détecter `._mjs_global`.
          // Optim : on regarde si N'IMPORTE QUEL descendant a un teardown ou
          // une outro/global. La grande majorité des items de bench n'ont rien.
          var __scan = node.firstElementChild;
          var __hasFx = false;
          while (__scan) {
            if (__scan._mjs_global || __scan._mjs_outro || __scan._mjs_td || __scan._mjs_ref_td) { __hasFx = true; break; }
            // descente DFS sur ce sous-arbre
            if (__scan.firstElementChild) {
              __scan = __scan.firstElementChild;
              continue;
            }
            while (__scan && !__scan.nextElementSibling && __scan !== node) {
              __scan = __scan.parentElement;
            }
            if (!__scan || __scan === node) break;
            __scan = __scan.nextElementSibling;
          }
          if (!__hasFx) {
            node._mjs_dead = true;
            // Mort définitive (pas d'outro/td, aucun descendant à effet
            // ⇒ retrait synchrone, pas de revive possible).
            this._mjs_mjsPurgeSubtreeState(node);
            node.remove();
            return;
          }
        } else {
          // Pas de descendants (text node, etc.) — déjà géré plus haut, mais
          // ceinture+bretelles.
          node._mjs_dead = true;
          this._mjs_mjsPurgeSubtreeState(node); // mort définitive
          node.remove();
          return;
        }
      }
    }
    // waitOut = cascade demandée par l'ancêtre (mjs-childtransition).
    // En plus : on inclut TOUJOURS les descendants `.global` — leur outro
    // doit jouer même quand un ancêtre disparaît, comme Svelte `|global`.
    // Skip Array.from + .filter (2 allocs) au profit d'une boucle simple.
    if (waitOut) {
      const __qsa = node.querySelectorAll('*');
      elements = new Array(__qsa.length + 1);
      elements[0] = node;
      for (let __qi = 0, __qln = __qsa.length; __qi < __qln; __qi++) {
        elements[__qi + 1] = __qsa[__qi];
      }
    } else {
      const __qsa = node.querySelectorAll('*');
      elements = [node];
      for (let __qi = 0, __qln = __qsa.length; __qi < __qln; __qi++) {
        const __el = __qsa[__qi];
        // ne retenait QUE `._mjs_global`, jamais
        // `._mjs_td`/`._mjs_ref_td` : un descendant `@attach`/`@this` (pas
        // `.global`) voyait son teardown JAMAIS appelé à la fermeture d'un
        // bloc ({if}/{for}, waitOut=false) — alors que le scan de détection
        // juste au-dessus (`__hasFx`) les repère déjà pour décider de NE PAS
        // prendre le fast-path. Effet réel : un `<canvas @attach={startLoop}>`
        // dans un `{if}` gardait son `setInterval` actif sur DOM détaché,
        // accumulant un teardown fantôme de plus à chaque réouverture/
        // fermeture du bloc (fuite + effet de bord actif indéfiniment).
        if (__el._mjs_global || __el._mjs_td || __el._mjs_ref_td) elements.push(__el);
      }
    }
    // for-let-i au lieu de forEach (évite alloc closure × 4 passes).
    const __ats = this._mjs_attachments;
    for (let __ei = 0, __eln = elements.length; __ei < __eln; __ei++) {
      const el = elements[__ei];
      if (el._mjs_td) {
        el._mjs_td();
        if (__ats) __ats.delete(el._mjs_td);
        el._mjs_td = null;
      }
      if (el._mjs_ref_td) {
        el._mjs_ref_td();
        if (__ats) __ats.delete(el._mjs_ref_td);
        el._mjs_ref_td = null;
      }
    }
    for (let __ei = 0, __eln = elements.length; __ei < __eln; __ei++) {
      const el = elements[__ei];
      if (el._mjs_outro) {
        try {
          if (typeof el._mjs_cb_outrostart === "function") {
            el._mjs_cb_outrostart();
          }
          // `µ._mjs_playTransition` gère les deux formats :
          //   - cfg statique { delay, duration, easing, css } (anims migrées
          //     Svelte-style, capturé une fois au mount)
          //   - function legacy retournant Promise (crossfade, custom)
          // Pour les cfg, il délègue à `_mjs_runTransition` qui rebuild les
          // keyframes from t_current si une animation est déjà en cours.
          if (typeof µ._mjs_playTransition === 'function') {
            transitions.push(µ._mjs_playTransition(el, el._mjs_outro, 'out'));
          }
        } catch (err) {
          µ.error("Synchronous transition error:", err);
        }
      }
    }
    if (transitions.length > 0) {
      timeoutId = setTimeout(function() {
        return µ.warn("⏱️ Warning: Transition exceeds 2000ms.");
      }, 2000);
      await Promise.all(transitions);
      clearTimeout(timeoutId);
    }
    // flash-zombie : `µ._mjs_runTransition` (mode css)
    // DIFFÈRE désormais le `anim.cancel()` (libération du `fill:'forwards'`)
    // d'un membre de CE groupe qui finit son outro individuel AVANT les autres
    // (cf. mjs_easing.ts, `_mjs_pendingFillRelease`), pour ne pas le voir
    // "rebondir" à son état naturel pendant que le reste du groupe est encore
    // visible. Ici, TOUT le groupe vient de se résoudre (`Promise.all` ci-
    // dessus) — plus aucun risque de flash — on consomme le hook pour chaque
    // membre, AVANT le check revive/destroy juste en dessous : que le node
    // soit ressuscité ou réellement détruit, son fill doit être libéré dans
    // les 2 cas (sinon un node ressuscité resterait visuellement figé dans
    // son dernier frame d'outro).
    for (let __ei = 0, __eln = elements.length; __ei < __eln; __ei++) {
      const __elFr = elements[__ei];
      if (typeof __elFr._mjs_pendingFillRelease === 'function') {
        __elFr._mjs_pendingFillRelease();
      }
    }
    // Si le nœud a été ressuscité (_mjs_tryReviveDying l'a clear), on n'a plus
    // rien à détruire. Les callbacks outroend NE doivent PAS firer dans ce cas.
    if (!node._mjs_dying) {
      return;
    }
    // Mort DÉFINITIVE confirmée (outro terminée, pas de revive) : c'est
    // ICI, et pas en tête, qu'on purge les états de sous-arbre ({for} imbriqués,
    // {await}) — le nœud ne peut plus revivre.
    this._mjs_mjsPurgeSubtreeState(node);
    for (let __ei = 0, __eln = elements.length; __ei < __eln; __ei++) {
      elements[__ei]._mjs_dead = true;
    }
    for (let __ei = 0, __eln = elements.length; __ei < __eln; __ei++) {
      const el = elements[__ei];
      try {
        if (typeof el._mjs_cb_outroend === "function") el._mjs_cb_outroend();
      } catch (error1) { /* ignore */ }
    }
    return node.remove();
  };
}
