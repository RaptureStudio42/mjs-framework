// mjs_failed — frontière d'erreur `<@failed>` : rendu du repli, propagation vers l'ancêtre qui en
// porte un, limite de réessai, et reset(). `_mjs_catchError` (mjs_element.ts, cœur) délègue ici par
// `_mjs_runBoundary` quand la méthode existe. DÉTACHÉ du cœur : embarqué seulement si le code
// compilé d'une source pose un repli — balise `<@failed>` (`this._mjs_fallback = …`) ou rune nue
// `µfailed` (`_mjs_hook('failed', …)`, mjs_lifecycle.ts), cf. bundler/features.ts. Ce sont les deux
// SEULS écrivains de `_mjs_fallback` : sans eux aucun composant n'a de repli, `_mjs_catchError` n'a rien
// à rendre ni d'ancêtre à trouver et passe directement au panneau fatal.
//
// reset() : l'init (état) d'un composant tourne dans son CONSTRUCTEUR → pas ré-exécutable
// en place. Pour « réinitialiser » (façon svelte:boundary reset), on remplace
// l'élément crashé par une instance FRAÎCHE (même tag + mêmes attrs/props) qui
// se monte proprement avec un état neuf.
µ._mjs_resetComponent = function(comp) {
  var fresh = document.createElement(comp.tagName.toLowerCase());
  var attrs = comp.attributes, i, a;
  for (i = 0; i < attrs.length; i++) {
    a = attrs[i];
    if (a.name === 'mjs-loading' || a.name === 'mjs-error') continue;
    if (a.name === 'class') {
      var c = a.value.replace(/\bmjs-error\b/g, '').trim();
      if (c) fresh.setAttribute('class', c);
      continue;
    }
    fresh.setAttribute(a.name, a.value);
  }
  // Transfert du light-DOM (enfants slottés) : sans lui, un
  // `<my-card><p>…</p></my-card>` ressuscitait VIDE après un reset de
  // boundary. Les nœuds sont DÉPLACÉS (pas clonés) — listeners préservés.
  while (comp.firstChild) {
    fresh.appendChild(comp.firstChild);
  }
  comp.replaceWith(fresh);
};

// Patch de `µ.Element.prototype` (même technique que mjs_on.ts) : DOIT rester APRÈS mjs_element.ts
// dans la concaténation.
if (µ.Element) {
  // Remonte vers la boundary ancêtre la plus proche (composant ayant un
  // `_mjs_fallback`), en traversant les shadow roots via getRootNode().host.
  µ.Element.prototype._mjs_findBoundary = function() {
    var node = this, hops = 0;
    while (node && hops++ < 50) {
      node = node.parentNode || (node.getRootNode ? node.getRootNode().host : null);
      if (!node) break;
      if (typeof node._mjs_catchError === 'function' && typeof node._mjs_fallback === 'function') {
        return node;
      }
    }
    return null;
  };

  // `_mjs_runBoundary(err)` : suite de `_mjs_catchError` une fois le crash noté (log, `_mjs_has_crashed`,
  // classe `mjs-error`). Rend `true` quand le crash est pris en charge — remonté à l'ancêtre, ou
  // repli propre affiché — et `false` quand il faut le panneau fatal : ni repli ni ancêtre, ou
  // repli qui jette à son tour.
  µ.Element.prototype._mjs_runBoundary = function(err) {
    // Propagation : sans fallback propre, l'erreur REMONTE vers la boundary
    // ancêtre la plus proche (errors bubble, comme React/Svelte). Permet à un
    // parent (`<@failed>`) de contenir le crash d'un composant enfant.
    if (typeof this._mjs_fallback !== 'function') {
      var anc = this._mjs_findBoundary();
      if (anc) {
        this._shadow.innerHTML = "";
        anc._mjs_catchError(err);
        return true;
      }
      return false;
    }
    this._shadow.innerHTML = "";
    var self = this;
    // limite de réessai
    // (`<@failed retry="N">`, défaut 1, posée par le compilateur dans
    // `_mjs_failedRetry`/`_mjs_failedRetryMsg`, cf. transpiler/macros.ts).
    // Le compte de tentatives DÉJÀ consommées vit sur un ATTRIBUT DOM
    // (`mjs-retry-used`), PAS sur `this`/`_state` : `µ._mjs_resetComponent`
    // remplace `self` par une instance FRAÎCHE (nouveau constructeur, tout
    // l'état ré-initialisé à zéro) — un compteur posé sur l'instance ne
    // survivrait à AUCUN reset (il ne compterait plus rien, la boucle
    // resterait infinie). Les ATTRIBUTS, eux, sont EXPLICITEMENT recopiés
    // de l'ancien nœud vers le neuf par `_mjs_resetComponent` (boucle
    // `fresh.setAttribute(...)`, ci-dessus) : c'est le seul support qui
    // traverse le remplacement — la même astuce que `mjs-loading`/`mjs-error`
    // déjà portés par cette recopie.
    var retryLimit = typeof this._mjs_failedRetry === 'number' ? this._mjs_failedRetry : 1;
    var retryUsed = parseInt(self.getAttribute('mjs-retry-used'), 10) || 0;
    var reset;
    if (retryUsed < retryLimit) {
      reset = function() {
        self.setAttribute('mjs-retry-used', String(retryUsed + 1));
        return µ._mjs_resetComponent(self);
      };
    }
    else {
      // Limite atteinte : le fallback s'affiche quand même (avec l'erreur),
      // mais `reset` devient un no-op — plus aucune construction, donc plus
      // aucun crash qui rappellerait `_mjs_catchError` en boucle.
      µ.error(this._mjs_failedRetryMsg || ('[ModularJS] <@failed> : limite de réessai atteinte (' + retryLimit + ') — abandon.'));
      reset = function() {};
    }
    try {
      var out = this._mjs_fallback(err, reset);
      if (out instanceof Node) {
        // <@failed> compilé : le builder retourne un conteneur dont le DOM a
        // déjà ses events câblés (`@click=reset` = vrai listener). On en déverse
        // les enfants dans le shadow (les listeners suivent les nœuds).
        while (out.firstChild) {
          this._shadow.appendChild(out.firstChild);
        }
      }
      else {
        // back-compat : `@failed (err, reset) -> "html"` (fallback en string).
        // Là un `@click` n'est pas compilé → le bouton reset porte `mjs-reset`.
        this._shadow.innerHTML = String(out);
        var triggers = this._shadow.querySelectorAll('[mjs-reset]');
        for (var i = 0; i < triggers.length; i++) {
          triggers[i].addEventListener('click', reset);
        }
      }
      return true;
    } catch (__fbErr) {
      // le fallback `<@failed>`/`µfailed`
      // reçoit un `err` arbitraire et peut lui-même jeter : sans filet,
      // l'exception s'échappait de `_mjs_catchError` (souvent depuis un microtask
      // de rendu, shadow déjà vidé) → aucun message fatal affiché. On log et
      // on RETOMBE sur l'overlay `.mjs-fatal-error` de `_mjs_catchError`.
      µ.error('[ModularJS] fallback @failed en erreur :', __fbErr);
      this._shadow.innerHTML = "";
      return false;
    }
  };
}
