// mjs_dom — navigation DOM et enregistrement du code COMPILÉ. Trois helpers cités par le code
// qu'émet le générateur, jamais par une application.
//
// Motif : les OCTETS du code livré. Une fonction de construction retrouvait ses nœuds par des
// chaînes de propriétés (`_f.firstChild.nextSibling.nextSibling.firstChild.firstChild`) et
// matérialisait chacun de ses marqueurs par quatre instructions — sur une page réelle, ces deux
// motifs pèsent ~2 Ko de source. `µ._p(_f,2,0,0)` dit la même chose en trois fois moins de signes.
//
// RÈGLE DE POSE : jamais dans le gabarit de ligne d'un `{for}`. Ce corps-là est exécuté une fois
// PAR LIGNE (1 000 fois sur une création de liste) et garde ses chaînes de propriétés directes,
// sans appel de fonction. Racine du composant et branches `{if}`/`{await}`/`{key}`, construites
// une seule fois, prennent la forme compacte.
//
// Fichier de CŒUR, toujours joint : n'importe quel composant compilé peut citer ces trois noms.
// L'alias COURT d'un composant, lui, vit dans mjs_alias.ts — seuls les projets qui en écrivent un
// l'appellent, et le module ne les suit qu'à l'usage.

// i-ème enfant, de proche en proche. `µ._p(n,2,0)` ≡ `n.childNodes[2].firstChild` :
// `childNodes[i]` est le i-ème enfant, soit `firstChild` suivi de i `nextSibling`.
µ._p = function(n) {
  var i;
  for (i = 1; i < arguments.length; i++) {
    n = n.childNodes[arguments[i]];
  }
  return n;
};

// marqueur texte : le template porte un commentaire à cet endroit, le composant a besoin d'un
// nœud texte vide qu'il pourra remplir. Remplacement en place (même position dans le parent),
// nœud texte rendu à l'appelant qui le range dans ses refs.
µ._tm = function(c) {
  var t = document.createTextNode('');
  c.parentNode.replaceChild(t, c);
  return t;
};

// enregistrement de la balise d'un composant. Aide UNIQUE : le test d'existence, l'enregistrement
// ET le message français de collision (106 signes, écrit DEUX fois — branche `µ.warn`, branche
// `console.warn`) étaient recopiés dans CHAQUE fichier compilé alors qu'ils sont les mêmes partout.
// Deux bundles qui définissent la même balise : le premier chargé gagne, le second est signalé et
// ignoré — jamais une exception, qui emporterait tout le module.
µ._def = function(tag, C) {
  if (!customElements.get(tag)) customElements.define(tag, C);
  else (µ.warn || console.warn)('[ModularJS] '+ tag +' déjà défini par un autre bundle : cette définition est ignorée');
};
