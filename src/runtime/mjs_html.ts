// mjs_html — interpolation brute `{{expr}}` : `_mjs_updHtml(id, val)` remplace le contenu du nœud
// porteur par le HTML de la valeur. Patch de `µ.Element.prototype._mjs_updHtml`, DÉTACHÉ de
// mjs_element.ts (même technique que mjs_on.ts : ajouté APRÈS la classe, DOIT rester après
// mjs_element.ts dans la concaténation). DÉTECTÉ sur le code compilé (bundler/features.ts, clé
// `html`) : le générateur émet l'appel littéral `this._mjs_updHtml('tN', …)` pour chaque `{{…}}` du
// composant hors {for}/{await} — racine, {if}/{else}, {key}, contenu de <@slot>, contenu passé à
// un enfant, partiel <@include>. Dans un {for}, la ligne écrit `innerHTML` elle-même ; dans un
// {await}, le code de la branche construit le nœud lui-même. Un composant qui n'émet aucun appel
// n'a donc jamais besoin de la méthode, elle peut manquer sans risque.
if (µ.Element) {
  µ.Element.prototype._mjs_updHtml = function(id, val) {
    // Skip String() si déjà string + skip Array.from alloc.
    // Snapshot childNodes via firstChild/nextSibling pour éviter live-list mutations
    // pendant l'iteration.
    const node = this._mjs_nodes[id];
    if (!node || node._mjs_pooled) return;
    const strVal = typeof val === 'string' ? val : String(val);
    if (node._mjs_h === strVal) return;
    // Snapshot children avant destroy (destroy mute la live list).
    let __c = node.firstChild;
    const __children = [];
    while (__c) { __children.push(__c); __c = __c.nextSibling; }
    for (let __ci = 0, __cln = __children.length; __ci < __cln; __ci++) {
      this._mjs_destroyNodeAndChildren(__children[__ci]);
    }
    node.innerHTML = strVal;
    node._mjs_h = strVal;
  };
}
