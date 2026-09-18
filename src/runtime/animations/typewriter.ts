// animations/typewriter.coffee — port direct de Svelte typewriter (mode tick).
//
// IMPORTANT : on renvoie `intro: setup` / `outro: setup` (le `setup` est marqué
// `_isCfgFactory`), EXACTEMENT comme fade/scale/fly. C'est ce qui fait router
// `_mjs_playTransition` vers `µ._mjs_runTransition`, donc vers `_runTickTransition` :
// abort + continuité `t1 = prev.tValue()`. Une interruption (décocher puis
// recocher en plein milieu) REPREND depuis le `t` courant au lieu de repartir
// de 0 caractère — comportement Svelte. L'ancienne version lançait une boucle
// rAF maison (progress remis à 0 à chaque appel, jamais d'abort, pas de
// `_mjs_transition_state`) → toute interruption retombait à 0 char.
(function(opts = {}) {
  var setup, speed;
  // Vélocité par défaut : 30 ms par caractère. Locale (jamais sur opts) pour ne
  // pas muter la config partagée entre nœuds / directions.
  speed = opts.speed != null ? opts.speed : 30;
  setup = function(node) {
    var child, duration, fullText, hasElement, i, ref, textNode, textNodes, totalChars;
    // Contrat de docs/10-transitions.md (exemple customTyper) —
    // AVANT : `node.textContent` aplatissait tout le sous-arbre, un markup imbriqué
    // (`<b>`) disparaissait au 1er tick sans un mot. Le built-in doit lever, comme
    // la doc l'enseigne pour un tick personnalisé, plutôt que de continuer sur une
    // structure qu'il ne sait pas restituer proprement.
    // ÉLARGI — la garde `childNodes.length===1` rejetait aussi les nœuds
    // texte D'INDENTATION (blancs) que le compilateur pose de part et d'autre d'une
    // interpolation seule sur sa ligne (doc 10-transitions.md:225-231, `<p>` multi-
    // lignes → 3 nœuds texte : blanc, texte réel, blanc) — un usage DOCUMENTÉ levait
    // à tort. Seul un ÉLÉMENT enfant (markup imbriqué, ex. `<b>`) reste un vrai refus ;
    // les nœuds texte de blancs sont tolérés et jamais touchés par `tick`.
    textNodes = [];
    hasElement = false;
    for (i = 0; i < node.childNodes.length; i++) {
      child = node.childNodes[i];
      if (child.nodeType === Node.ELEMENT_NODE) {
        hasElement = true;
      } else if (child.nodeType === Node.TEXT_NODE) {
        textNodes.push(child);
      }
    }
    if (hasElement || textNodes.length === 0) {
      throw new Error('@transition.typewriter exige un unique nœud texte');
    }
    // Parmi les nœuds texte, seul celui qui porte du contenu RÉEL est animé ; les
    // blancs d'indentation restent des nœuds à part, jamais touchés par `tick`.
    // Que des blancs (aucun contenu réel) : on retombe sur le 1er, comportement
    // sain par défaut plutôt qu'un crash.
    textNode = textNodes[0];
    for (i = 0; i < textNodes.length; i++) {
      if (textNodes[i].textContent.trim() !== '') {
        textNode = textNodes[i];
        break;
      }
    }
    // Sauvegarde immuable du texte d'origine : l'outro doit savoir quoi effacer
    // même après que l'intro a tronqué le nœud texte réel. Capturé une seule fois
    // (le cfg est lui-même mémoïsé par `_mjs_runTransition` via `_mjs_tick_cfgs`).
    if (node._mjs_text_cache == null) {
      node._mjs_text_cache = textNode.textContent.trim();
    }
    fullText = node._mjs_text_cache;
    totalChars = fullText.length;
    duration = (ref = opts.duration) != null ? ref : totalChars * speed;
    return {
      duration: duration,
      // `t` va de t1 (état courant) vers t2 (1 = intro, 0 = outro). On discrétise
      // en nombre de caractères visibles ; `_runTickTransition` gère le sens et
      // la continuité. `Math.round` plutôt que `floor` pour un dernier caractère
      // net en fin d'intro.
      tick: function(t, u) {
        var charsCount;
        // clamp [0, totalChars] : `_runTickTransition`
        // peut transmettre un t hors [0,1] une frame (rAF antérieur au start) ;
        // sans clamp, `slice(0, négatif)` coupe depuis la FIN et `> totalChars`
        // dépasse. Ceinture par-dessus le clamp de progress (mjs_easing).
        charsCount = Math.max(0, Math.min(totalChars, Math.round(totalChars * t)));
        // ÉLARGI — on tronque le nœud texte RÉEL lui-même (jamais
        // `node.textContent` en entier) : les blancs d'indentation voisins
        // restent intacts, seul le texte réel s'anime.
        return textNode.textContent = fullText.slice(0, charsCount);
      }
    };
  };
  setup._isCfgFactory = true;
  return {
    intro: setup,
    outro: setup
  };
});
