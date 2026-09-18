// mjs_head — <@head> : injection de contenu dans document.head (équivalent <svelte:head>).
// Le transpiler émet, pour chaque <@head>…</@head> à contenu, un µeffect qui
// appelle µ._setHead(component, htmlString). On RÉCONCILIE : si la structure de
// balises n'a pas changé (même tags, même ordre), on met à jour les attributs/
// le texte EN PLACE — un <link rel=stylesheet> garde alors son élément et ne
// fait qu'échanger son href (pas de retrait/ré-ajout brutal). Sinon on remplace.
// DÉTACHÉ du cœur : embarqué seulement si une source du projet écrit `<@head` (scan
// textuel, cf. bundler/index.ts) — le µeffect qui l'appelle DÉPEND aussi de mjs_effect.ts,
// forcé par le même signal (aucun appelant du cœur ne passe ici sans cette balise).
µ._mjs_syncHeadEl = function(target, src) {
  var sa = src.attributes, ta = target.attributes, i, a;
  for (i = 0; i < sa.length; i++) {
    a = sa[i];
    if (target.getAttribute(a.name) !== a.value) target.setAttribute(a.name, a.value);
  }
  for (i = ta.length - 1; i >= 0; i--) {
    if (!src.hasAttribute(ta[i].name)) target.removeAttribute(ta[i].name);
  }
  // Contenu texte (utile pour <title>, <style>).
  var onlyText = src.childNodes.length === 0 ||
    (src.childNodes.length === 1 && src.firstChild.nodeType === 3);
  if (onlyText && target.textContent !== src.textContent) target.textContent = src.textContent;
};

// <title> — CAS À PART, jamais un nœud ajouté au head. `document.head.appendChild(<title>)` ne
// change RIEN de visible : la spécification HTML dit que le titre du document est celui du PREMIER
// <title> de l'arbre, et toute page en a déjà un — un second est inerte. On écrit donc
// `document.title` (dont le setter vise justement ce premier <title>).
//
// Le titre d'AVANT est mémorisé à la première écriture du composant et rendu à sa mise en sommeil
// (µ._clearHead, hook sleep) : une page qu'on quitte ne doit pas emporter son titre sur la
// suivante. Dernier écrivain gagnant entre composants (même règle que µ._glSt).
//
// La restauration est CONDITIONNELLE — on ne rend l'ancien titre que si l'affiché est encore
// celui qu'on a écrit. Deux pages empilées (A puis B) se dépilent alors dans le bon ordre : B rend
// le titre de A, puis A rend celui du site. Un titre changé entre-temps par du code tiers
// (`document.title = …` à la main) n'est jamais écrasé par le démontage d'un composant.
// La mémoire du titre se teste en ACCÈS POINTÉ (`=== undefined`), jamais par `'_mjs_headTitle' in
// component` : esbuild raccourcit la propriété écrite juste à côté mais laisse la chaîne d'un `in`
// telle quelle — le test ne retrouverait alors jamais la propriété en production.
µ._mjs_setTitle = function(component, text) {
  if (component._mjs_headTitle === undefined) component._mjs_headTitle = document.title;
  component._mjs_headTitleSet = text;
  if (document.title !== text) document.title = text;
};

µ._mjs_restoreTitle = function(component) {
  if (component._mjs_headTitle === undefined) return;
  if (document.title === component._mjs_headTitleSet) document.title = component._mjs_headTitle;
  delete component._mjs_headTitle;
  delete component._mjs_headTitleSet;
};

µ._setHead = function(component, html) {
  var tpl = document.createElement('template');
  tpl.innerHTML = html;
  var fresh = [], title = null, kids = tpl.content.childNodes, i, k;
  for (i = 0; i < kids.length; i++) {
    k = kids[i];
    if (k.nodeType !== 1) continue;                                  // éléments seulement
    if (title === null && k.tagName === 'TITLE') { title = k.textContent; continue; }
    fresh.push(k);
  }
  if (title !== null) µ._mjs_setTitle(component, title); else µ._mjs_restoreTitle(component);
  var old = component._mjs_headNodes;
  if (old && old.length === fresh.length && fresh.length > 0) {
    var same = true;
    for (i = 0; i < old.length; i++) {
      if (old[i].tagName !== fresh[i].tagName) { same = false; break; }
    }
    if (same) {
      for (i = 0; i < old.length; i++) µ._mjs_syncHeadEl(old[i], fresh[i]);
      return;
    }
  }
  if (old) { for (i = 0; i < old.length; i++) old[i].remove(); }
  for (i = 0; i < fresh.length; i++) { document.head.appendChild(fresh[i]); }
  component._mjs_headNodes = fresh;
};

µ._clearHead = function(component) {
  var old = component._mjs_headNodes, i;
  if (old) {
    for (i = 0; i < old.length; i++) old[i].remove();
    component._mjs_headNodes = null;
  }
  µ._mjs_restoreTitle(component);
};
