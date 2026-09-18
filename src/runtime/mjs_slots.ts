// mjs_slots — slots indexés : `_mjs_injectSlots()` pose `slot="N"` sur chaque enfant sans attribut
// d'un composant qui projette ses enfants un par un (`{for i, t in $tabs} <@slot {i}/> {end}`).
// Patch de `µ.Element.prototype._mjs_injectSlots`, DÉTACHÉ de mjs_element.ts (même technique que
// mjs_on.ts : ajouté APRÈS la classe, DOIT rester après mjs_element.ts dans la concaténation).
// DÉTECTÉ sur le code compilé (bundler/features.ts, clé `slots`) : le constructeur compilé
// n'émet `this._mjs_has_dynamic_slots = true; this._mjs_injectSlots();` que si le composant écrit
// `<@slot` (transpiler/template.ts, `[[DYNAMIC_SLOTS_LINE]]`) — sans lui, la méthode ne faisait
// déjà rien (drapeau faux, retour immédiat), elle peut donc manquer sans risque.
if (µ.Element) {
  µ.Element.prototype._mjs_injectSlots = function() {
    if (!this._mjs_has_dynamic_slots) return;
    // Deux régimes :
    //   1. Shadow contient un `<slot>` par défaut (sans `name`) → on ne
    //      touche pas aux enfants : ceux sans `slot=` vont nativement au
    //      default slot (idiome Web Components standard).
    //   2. Shadow N'A PAS de slot par défaut mais déclare des slots indexés
    //      (`<slot name="0">`, `<slot name="1">`…) — typiquement un
    //      composant qui projette ses enfants un par un via un `{for}` :
    //      ```
    //      {for i, tab in $tabs} <@slot i></@slot> {end}
    //      ```
    //      → on assigne `slot="N"` à chaque enfant sans attribut pour les
    //      router vers le bon slot indexé.
    const hasDefaultSlot = !!this._shadow.querySelector('slot:not([name])');
    if (hasDefaultSlot) return;
    let childIndex = 0;
    for (const node of Array.from(this.children)) {
      if (!node.hasAttribute('slot')) {
        node.setAttribute('slot', String(childIndex));
        childIndex++;
      }
    }
  };
}
