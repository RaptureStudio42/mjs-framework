// mjs_alias — enregistrement de l'ALIAS COURT d'un composant (`doc/doc-carte.mjs` → `<mjs-carte>`).
// DÉTACHÉ de mjs_dom.ts : le transpileur émet `µ._al(` LITTÉRALEMENT, et seulement pour un
// composant qui porte un nom court — un projet dont chaque fichier vit à la racine n'en cite
// aucun et payait pourtant cette fonction (bundler/features.ts et resolveRuntimeFiles, clé
// `alias`). Personne d'autre ne l'appelle au runtime.
//
// Aide UNIQUE : le test était recopié dans chaque composant (189 o par fichier, 657 fois sur le
// site de doc) alors qu'il est le même partout.

// L'alias n'est enregistré que si le manifeste porte sa clé (le tag sans le préfixe `mjs-`, cf.
// mjs_autoloader.ts) : deux composants qui se disputent le même alias l'empoisonnent au build, la
// clé quitte le manifeste et la balise reste inerte. Sans manifeste (harnais, rendu serveur) : rien
// à consulter, on enregistre. Sous-classe anonyme — un constructeur ne peut être enregistré que
// sous une seule balise.
µ._al = function(tag, key, C) {
  if (!customElements.get(tag) && (!µ.paths || Object.prototype.hasOwnProperty.call(µ.paths, key))) customElements.define(tag, class extends C {});
};
