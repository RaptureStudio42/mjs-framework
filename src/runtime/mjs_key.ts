// mjs_key — bloc `{key}` (remonte tout le contenu, structure comprise, quand la
// clé change). Patch de `µ.Element.prototype`, DÉTACHÉ de mjs_element.ts (même
// technique que mjs_on.ts/mjs_flip.ts). `{key expr}...{end}` À LA RACINE compile
// en `this._mjs_updKey(...)` (src/generator/compile.ts) — imbriqué dans `{for}`/
// `{await}`, c'est `_mjs_updItemIf` (mjs_if.ts) qui prend le relais, jamais cette
// méthode (seule la forme racine est idempotente via `_mjs_key_cache`). `_mjs_updKey`
// appelle `_mjs_tryReviveDying`/`_mjs_resetNestedMemos` (mjs_if.ts) : mjs_if.ts est
// donc TOUJOURS embarqué avec ce fichier (bundler/index.ts, wantsKey force
// wantsIf).

if (µ.Element) {
  // _mjs_updKey prend une createFn qui retourne {fragment, refs}.
  µ.Element.prototype._mjs_updKey = function(id, val, createFn) {
    var built, childMode, e, firstNew, n, outroNodes, ref, s, t;
    s = this._mjs_nodes['s-' + id];
    e = this._mjs_nodes['e-' + id];
    if (!(s && e)) {
      return false;
    }
    if (this._mjs_key_cache == null) {
      this._mjs_key_cache = {};
    }
    if (this._mjs_key_cache.hasOwnProperty(id) && this._mjs_key_cache[id] === val) {
      return false;
    }
    this._mjs_key_cache[id] = val;
    if (this._mjs_tryReviveDying(s, e, createFn)) {
      return true;
    }
    childMode = (ref = s.parentNode) != null ? typeof ref.getAttribute === "function" ? ref.getAttribute('mjs-childtransition') : void 0 : void 0;
    n = s.nextSibling;
    outroNodes = []; // accroche d'appariement, lue par les sorties de reveal/flip/cube/turn
    while (n && n !== e) {
      t = n;
      n = n.nextSibling;
      if (!t._mjs_dying) {
        this._mjs_destroyNodeAndChildren(t, childMode === 'all' || childMode === 'out' || childMode === 'transition');
        if (t._mjs_dying && t._mjs_outro) outroNodes.push(t);
      }
    }
    if (!createFn) {
      return true;
    }
    built = createFn();
    if (built.refs) {
      var refs = built.refs;
      const __refKeys = Object.keys(refs);
      for (let __ri = 0, __rln = __refKeys.length; __ri < __rln; __ri++) {
        const __rid = __refKeys[__ri];
        this._mjs_nodes[__rid] = refs[__rid];
      }
      this._mjs_registerRefs(refs);
    }
    // accroche d'appariement : le fragment se vide à l'insertion,
    // firstNew se lit AVANT ; chaque ancien en sortie pointe vers le neuf, lu par
    // les sorties de reveal/flip/cube/turn (µ._mjs_fixPosition, setupOut).
    firstNew = built.fragment.firstElementChild;
    if (firstNew) {
      for (let __oi = 0, __oln = outroNodes.length; __oi < __oln; __oi++) {
        outroNodes[__oi]._mjs_pairedWith = firstNew;
      }
    }
    s.parentNode.insertBefore(built.fragment, e);
    // #10 — la clé a changé : on vient de recréer une structure NEUVE et VIDE
    // (nouveaux anchors des {if}/{key} imbriqués). Mais leurs mémos de branche
    // `_mjs_old[<id>]` (et `_mjs_key_cache`) sont inchangés → le wrapper généré
    // `if(c !== this._mjs_old[<id>]){ _mjs_updIf(...) }` court-circuiterait et la branche
    // resterait VIDE (cas observé : {key} contenant un {if}). On invalide ces
    // mémos pour les blocs recréés (refs `s-<id>`) : l'appel _mjs_updIf/_mjs_updKey
    // suivant, DANS CE MÊME _mjs_renderStruct (le {if} interne vient juste après le
    // {key} dans la séquence), n'est alors plus court-circuité et re-remplit la
    // branche sur les nouveaux anchors. Pas de microtask / re-render global ici :
    // ça re-tirerait les effets à effet de bord (@attach) — cf. test
    // attach-in-struct. (Un texte à var STRICTEMENT constante sous un {key} reste
    // un edge case non repeuplé ; en pratique les vars changent avec la clé.)
    this._mjs_resetNestedMemos(built);
    return true; // 🔧 signale au render() que la clé a changé → force dirty=-1 pour enfants
  };
}
