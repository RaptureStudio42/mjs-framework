// mjs_lifecycle — crochets de cycle de vie en RUNES (µmount/µawake/µsleep/µdestroy/µurlChange,
// ET µfailed SOUS SA FORME RUNE NUE — cf. plus bas, distinct de la balise `<@failed>` —,
// compilés vers `this._mjs_hook(name, fn)`) et l'API interne de teardown qu'ils partagent
// (`_mjs_onDestroy`/`_mjs_onSleep`/`_mjs_onAwake`/`_mjs_runDestroyCallbacks`). Patch de `µ.Element.prototype`,
// DÉTACHÉ de mjs_element.ts (même technique que mjs_on.ts/mjs_context.ts).
//
// Détection à DEUX signaux, jamais un seul :
//   - DIRECT (scanRuntimeFeatures) — les 6 runes ci-dessus, ET les balises globales `<@window>`/
//     `<@document>`/`<@body>`/`<@html>`/`<@head>` : transpiler/macros.ts attache leurs écouteurs,
//     classes et nœuds injectés par `@_mjs_hook 'awake'`/`'sleep'` (forme Civet du code ÉMIS, le
//     source du projet n'écrit aucune rune). Sans l'un ni l'autre, rien n'appelle `_mjs_hook`, et les call-sites de `_mjs_hooks?.xxx`/`_mjs_pendingMount`/
//     `_mjs_awake_cbs`/`_mjs_sleep_cbs`/`_mjs_destroy_cbs` restants dans mjs_element.ts
//     (connectedCallback/disconnectedCallback, CŒUR, ne peuvent pas bouger — ils tournent pour
//     CHAQUE composant) sont TOUS déjà en chaînage optionnel ou en test de vérité — jamais un
//     appel direct non gardé. ATTENTION `µfailed` : la balise `<@failed>` compile DIRECTEMENT
//     `@_mjs_fallback = ...` (mjs_failed.ts, JAMAIS via `_mjs_hook`) — mais la RUNE NUE
//     `µfailed (err, reset) -> ...`, SANS AUCUNE balise `<@failed>`, compile elle bien vers
//     `this._mjs_hook('failed', ...)` (vérifié empiriquement au compilateur) : le scan doit donc
//     couvrir `µfailed` en PLUS des 5 autres, indépendamment de la détection `<@failed>`
//     (mjs_failed.ts reste un fichier séparé, à son propre signal).
//   - FORCÉ par les appelants de l'API de destruction. `every` : `µ.every` (mjs_every.ts) appelle
//     `comp._mjs_onDestroy(stop)` et, si `pause: true`, `comp._mjs_onSleep(...)`/`comp._mjs_onAwake(...)` —
//     SANS AUCUNE garde `typeof` — et pose directement `comp._mjs_pendingMount = true` (même hors
//     tout `µmount ->` déclaré), ce qui déclenche plus tard l'appel core à `this._mjs_fireMount()` :
//     sans ce fichier, le premier `µevery(...)` planterait. `interpolate` (`_mjs_attachInvalidator` :
//     le composant qui reçoit l'interpolateur en devient propriétaire), `smooth` et `socket`
//     (option `owner`) et le cache de pages (`µ._mjs_destroyEvictedTree` → `_mjs_runDestroyCallbacks`)
//     gardent leurs appels derrière `typeof` : pas de crash, mais sans ce fichier plus rien n'est
//     défait à la destruction (tâche Ticker immortelle, abonnement jamais retiré, propriétaire
//     retenu jusqu'à la prochaine notification) — forcés eux aussi. `vault` : aucun appel.
if (µ.Element) {
  // Forme canonique : les RUNES µ, compilées vers `this._mjs_hook(name, fn)` :
  //   µmount   ->                  1× après le 1er rendu — retourner une fn =
  //                                nettoyage, rejoué UNE fois à µdestroy (jamais
  //                                à µsleep, cf. wrapping ci-dessous)
  //   µawake   ->                  à chaque (re)connexion DOM
  //   µsleep   ->                  à chaque déconnexion DOM
  //   µdestroy ->                  au teardown définitif
  //   µurlChange (path, params) -> changement de route (router-aware)
  //   µfailed (err, reset) ->      forme RUNE NUE de l'error boundary (slot
  //                                `_mjs_fallback`, distincte de `<@failed>` — voir
  //                                l'en-tête de fichier)
  // UN point d'entrée + la map `_mjs_hooks` : aucun nom public squatté sur
  // l'instance — mount/awake/sleep/destroy/urlChange/failed redeviennent des
  // noms de méthodes LIBRES pour l'utilisateur (l'ancienne forme `@mount ->`
  // est retirée, bloquée à la compilation par le lexer).
  µ.Element.prototype._mjs_hook = function(name, fn) {
    if (name === 'failed') return this._mjs_fallback = fn;
    if (name === 'mount') {
      // Sucre nettoyage-par-retour (symétrique µeffect/@attach) : `self` fermé
      // ICI (au moment de l'enregistrement, this = l'instance) plutôt que de
      // compter sur le `.call(this)` des 2 call-sites — le cleanup capturé
      // passe par `_mjs_onDestroy` (ci-dessous), donc UNE fois à
      // µdestroy, jamais à µsleep ; `_mjs_destroy_cbs` appelle ses callbacks
      // NUS (sans `.call`), d'où le `res.call(self)` explicite.
      const self = this;
      const wrapped = function() {
        const res = fn.call(self);
        if (typeof res === 'function') {
          self._mjs_onDestroy(function() {
            return res.call(self);
          });
        }
        return res;
      };
      return (this._mjs_hooks || (this._mjs_hooks = {}))[name] = wrapped;
    }
    return (this._mjs_hooks || (this._mjs_hooks = {}))[name] = fn;
  };

  // Tir du montage — point d'entrée UNIQUE des 2 call-sites de `_mjs_invalidate` (mjs_element.ts) :
  // le hook `µmount` de l'utilisateur, PUIS la file `_mjs_mount_cbs` posée au
  // setup par les runes qui ont besoin du montage (µevery). Une FILE et pas une
  // case de `_mjs_hooks` : la map n'a qu'un slot par nom, un 2e poseur y
  // écraserait le 1er sans un mot (piège connu des deux `µmount ->`).
  µ.Element.prototype._mjs_fireMount = function() {
    // SSR : les hooks de cycle de vie CLIENT ne jouent pas côté serveur — et
    // `_mjs_mounted` reste faux, sinon une rune posée après coup démarrerait
    // un timer DANS le rendu serveur.
    if (µ._isServer) return;
    this._mjs_mounted = true;
    // le 1er rendu est TERMINÉ ici : ce qu'un callback de montage écrit part en
    // rendu SUIVANT et doit donc animer normalement. Sans cette ligne, le
    // fast-path SYNCHRONE de `_mjs_invalidate` repatchait le DOM avec le drapeau
    // encore levé et `!_mjs_initial_render` (garde d'intro, generator) sautait
    // les transitions d'entrée — mesuré sur la leçon `blocs-key` : le 1er
    // message s'affichait d'un bloc, sans son typewriter, le 2e l'avait
    this._mjs_initial_render = false;
    if (typeof this._mjs_hooks?.mount === 'function') this._mjs_hooks.mount.call(this);
    const cbs = this._mjs_mount_cbs;
    if (cbs) {
      this._mjs_mount_cbs = null;
      for (let i = 0, n = cbs.length; i < n; i++) cbs[i].call(this);
    }
  };

  // API interne unifiée de teardown DÉFINITIF : stores, routeur, animations,
  // code utilisateur… s'inscrivent sans s'écraser mutuellement (contrairement
  // à `µdestroy` qui ne pose qu'UN hook). Équivalent du onCleanup de Solid.
  // Les callbacks sont invoqués par la destruction différée (cf.
  // disconnectedCallback, mjs_element.ts), avec le hook destroy.
  µ.Element.prototype._mjs_onDestroy = function(fn) {
    (this._mjs_destroy_cbs || (this._mjs_destroy_cbs = [])).push(fn);
    return fn;
  };

  // Mêmes files, pour la SUSPENSION : appelées à chaque déconnexion/reconnexion
  // du DOM (hibernation du pageCache comprise), jamais vidées — une rune qui
  // suspend doit pouvoir reprendre autant de fois que le composant revient.
  µ.Element.prototype._mjs_onSleep = function(fn) {
    (this._mjs_sleep_cbs || (this._mjs_sleep_cbs = [])).push(fn);
    return fn;
  };

  µ.Element.prototype._mjs_onAwake = function(fn) {
    (this._mjs_awake_cbs || (this._mjs_awake_cbs = [])).push(fn);
    return fn;
  };

  // Exécution effective du teardown définitif. Appelée par la destruction
  // différée (disconnectedCallback, mjs_element.ts), ET par µ._mjs_destroyEvictedTree
  // (mjs_page_cache.ts, éviction du pageCache LRU : la destruction avait été
  // sautée pour cause d'hibernation — sans ce rattrapage, les timers/abonnements
  // des pages évincées fuyaient à vie — appel déjà gardé `typeof` là-bas).
  µ.Element.prototype._mjs_runDestroyCallbacks = function() {
    // Annule toute transition encore EN VOL sur le composant et ses nœuds
    // réactifs : un `_runTickTransition` tourne en boucle rAF, un
    // `node.animate()` reste figé (fill:forwards) — sans abort, ils continuent
    // sur un arbre détruit (gaspillage rAF, styles fantômes). `abort()`
    // (mjs_easing) coupe le rAF / cancel l'anim et nulle `_mjs_transition_state`.
    // NB : appelé depuis la destruction DIFFÉRÉE (node réellement parti) et
    // depuis l'éviction du pageCache → jamais sur un simple déplacement DOM.
    try { this._mjs_transition_state?.abort?.(); } catch (e) { /* défensif */ }
    if (this._mjs_nodes) {
      for (const k in this._mjs_nodes) {
        const n = this._mjs_nodes[k];
        if (n && n._mjs_transition_state) {
          try { n._mjs_transition_state.abort(); } catch (e) { /* défensif */ }
        }
      }
    }
    if (this._mjs_destroy_cbs) {
      const cbs = this._mjs_destroy_cbs;
      this._mjs_destroy_cbs = null;
      for (let i = 0; i < cbs.length; i++) {
        try { cbs[i](); } catch (e) { µ.warn('[ModularJS] _mjs_onDestroy : callback en erreur :', e); }
      }
    }
    if (typeof this._mjs_hooks?.destroy === 'function') {
      const fn = this._mjs_hooks.destroy;
      this._mjs_hooks.destroy = null;
      try { fn.call(this); } catch (e) { µ.warn('[ModularJS] hook destroy en erreur :', e); }
    }
  };
}
