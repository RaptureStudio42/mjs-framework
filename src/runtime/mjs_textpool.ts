// mjs_textpool — pool global de nœuds texte vides : `µ._mjs_getTextNode` sert les placeholders du
// mode IMPÉRATIF du générateur, `µ._mjs_recycleTextLeaves` (appelée par `_mjs_destroyNodeAndChildren`,
// mjs_element.ts, sous garde) et `µ._mjs_releaseTextNode` les lui rendent. DÉTACHÉ de mjs_init.ts :
// le générateur émet `µ._mjs_getTextNode(` LITTÉRALEMENT, et lui seul (generator/paths.ts) — sans cet
// appel, personne ne puise dans le pool et le remplir ne servirait à rien (bundler/features.ts,
// clé `textpool`). Servir ET rendre partent donc ENSEMBLE : un pool qu'on remplit sans jamais y
// puiser ne fait que retenir des nœuds morts.
//
// `_mjs_pooled`, le drapeau anti-écriture périmée posé ici, reste testé par `_mjs_updText`/`_mjs_updHtml`
// du côté cœur : sans ce fichier il n'est jamais posé, et le test est simplement toujours faux.

// Pool global de text nodes vides (réutilisables).
//
// Sur `create 1k rows`, le mode imperative émet ~2 text nodes vides par row
// (placeholders pour `{$x}`). Au lieu de `document.createTextNode('')`, on
// pop un text node du pool. Au destroy, on push les text nodes feuilles
// dans le pool (jusqu'à `_mjs_textPoolMax = 1024`).
//
// Gain mesuré ~5-10ms sur create 1k.
µ._mjs_textPool = [];
µ._mjs_textPoolMax = 1024;

µ._mjs_getTextNode = function(txt) {
  var n;
  if (µ._mjs_textPool.length > 0) {
    n = µ._mjs_textPool.pop();
    n._mjs_pooled = false;
    if (txt !== '' && txt !== void 0) n.data = txt;
    return n;
  }
  return document.createTextNode(txt || '');
};

µ._mjs_releaseTextNode = function(n) {
  // On évite de stocker un node qui pourrait porter des références externes
  // (event listeners, mais text nodes n'en ont quasi jamais). Reset les data
  // pour ne pas tenir mémoire de l'ancienne string.
  if (µ._mjs_textPool.length < µ._mjs_textPoolMax) {
    n.data = '';
    // Marqueur anti-écriture périmée : un {if} refermé laisse ses ids dans
    // `_mjs_nodes` et ses effects abonnés — un `_mjs_updText` tardif écrivait sur un
    // nœud du pool potentiellement RÉATTRIBUÉ à un autre rendu (corruption
    // de texte inter-arbres). `_mjs_updText`/`_mjs_updHtml` testent ce flag.
    n._mjs_pooled = true;
    µ._mjs_textPool.push(n);
  }
};

// Walk DOM léger qui collecte les text nodes feuilles d'un sous-arbre
// pour les retourner au pool. Appelé depuis _mjs_destroyNodeAndChildren AVANT le
// node.remove() (sinon les childNodes sont déjà détachés).
//
// On limite la profondeur et le nombre pour éviter pathologie (template
// pathologique avec 10k text nodes). En pratique, un bench row a 2 text nodes.
µ._mjs_recycleTextLeaves = function(node) {
  if (µ._mjs_textPool.length >= µ._mjs_textPoolMax) return;
  // Optim #6 — Skip le walk DFS si pool > 75% plein. Gain marginal mais
  // évite un walk inutile sur clear de gros loops quand le pool est déjà
  // largement rempli (cas commun en bench : on clear puis on re-create).
  if (µ._mjs_textPool.length * 4 >= µ._mjs_textPoolMax * 3) return;
  // Approche : DFS sur les childNodes en collectant les text nodes (nodeType=3).
  // On stack la racine et descend itérativement.
  var stack = [node];
  var safety = 256; // garde-fou contre les arbres trop profonds.
  while (stack.length > 0 && safety-- > 0) {
    var cur = stack.pop();
    if (!cur || !cur.childNodes) continue;
    var children = cur.childNodes;
    for (var i = 0, len = children.length; i < len; i++) {
      var c = children[i];
      if (c.nodeType === 3 /* TEXT */) {
        if (µ._mjs_textPool.length < µ._mjs_textPoolMax) {
          c.data = '';
          // CRITIQUE :
          // sans ce flag, `_mjs_updText`/`_mjs_updHtml` (garde `if (node._mjs_pooled)
          // return`) restaient aveugles — un effect tardif du composant
          // d'origine (branche {if} refermée, mais `this._mjs_nodes`/effects pas
          // purgés, cf. plus bas) écrivait sur ce nœud pendant qu'il dormait
          // dans le pool, PUIS la réattribution par `µ._mjs_getTextNode` (qui
          // pose `_mjs_pooled = false`) livrait un texte pollué à un tout
          // AUTRE composant — corruption de texte inter-composants. Seul
          // `µ._mjs_releaseTextNode` (mort : aucun appelant dans tout src/)
          // posait ce flag ; ce chemin-ci (le SEUL réellement emprunté) ne le
          // posait pas.
          c._mjs_pooled = true;
          µ._mjs_textPool.push(c);
        }
      } else if (c.nodeType === 1 /* ELEMENT */ && c.childNodes.length > 0) {
        stack.push(c);
      }
    }
  }
};
