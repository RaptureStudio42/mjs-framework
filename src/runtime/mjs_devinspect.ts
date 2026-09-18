// mjs_devinspect — l'inspecteur d'objets, générique, dans la page, en développement.
//
// N'EST PAS DANS LE BUNDLE DE PRODUCTION : même règle que mjs_debug/mjs_devpanel (cf.
// bundler/index.ts). Chargé JUSTE AVANT mjs_devpanel, qui s'en sert pour ses onglets État et
// Contexte (une valeur composée y devient cliquable et se déplie ICI, avec le même moteur) et
// pour `µ.devObject()`. Ce fichier ne connaît RIEN du panneau ni de la modale : donné un hôte
// DOM et une valeur, il affiche, déplie, et édite — n'importe où on le monte.
//
// Ce qu'il fait : une arborescence dépliable de N'IMPORTE QUELLE valeur JS — objet, tableau,
// Map, Set, classe utilisateur, nœud DOM… — avec édition RÉELLE des scalaires en place. Sur un
// objet réactif MJS, une mutation imbriquée suffit à re-rendre toute seule (filet `_mjs_wrapDeep`,
// mjs_element.ts) : on écrit donc TOUJOURS par affectation directe sur la RÉFÉRENCE vivante
// (jamais un clone), sauf le cas racine `_state` d'un composant, réglé par `onWriteRoot`
// (mjs_devpanel.ts y route vers `el._set`, seul chemin qui déclenche computeds/limits/etc).
//
// État de dépliage — choix retenu : mémorisé PAR NAMESPACE (`_diOuverts`, un Set de chemins par
// `ns`) et RÉTABLI à chaque redessin, plutôt que de suspendre le rafraîchissement automatique du
// panneau (700 ms). Suspendre aurait figé l'affichage — donc menti — pendant qu'on inspecte
// justement CE qui bouge ; mémoriser garde les données fraîches ET l'arbre ouvert où on l'a
// laissé. Portée du test : `tests/devpanel.test.ts`.

var _diOuverts = new Map();

// le Set des chemins ouverts pour un namespace donné (une valeur/onglet/composant) — créé au
// premier accès, survit à tous les redessins tant que le namespace n'est pas explicitement remis
// à zéro (µ._mjs_diReset, utilisé par µ.devObject pour ne jamais hériter du pli d'un appel précédent)
function _diSetOuverts(ns) {
  var s = _diOuverts.get(ns);
  if (!s) { s = new Set(); _diOuverts.set(ns, s); }
  return s;
}

µ._mjs_diReset = function(ns) { _diOuverts.delete(ns); };

// plafond d'affichage par NIVEAU (pas au total) — au-delà, une ligne dit combien restent plutôt
// que de geler l'onglet sur un tableau ou un objet énorme
var _DI_MAX = 200;

/** Étiquette de type courte, sans jamais remonter sur la chaîne de prototypes. */
function _mjs_diKind(v) {
  if (v === null) return 'null';
  var t = typeof v;
  if (t === 'undefined' || t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol' || t === 'function') return t;
  if (v instanceof Node) return 'node';   // couvre aussi une instance µ.Element (HTMLElement < Node)
  if (v instanceof Date) return 'date';
  if (v instanceof RegExp) return 'regexp';
  if (v instanceof Error) return 'error';
  if (v instanceof Promise) return 'promise';
  if (v instanceof Map) return 'map';
  if (v instanceof Set) return 'set';
  if (ArrayBuffer.isView(v)) return 'typedarray';
  if (Array.isArray(v)) return 'array';
  return 'object';
}
µ._mjs_diKind = _mjs_diKind;

/** Conteneurs qui se déplient ; tout le reste est une feuille (aperçu seul, jamais un déballage infini). */
function _diExpandable(kind) {
  return kind === 'object' || kind === 'array' || kind === 'map' || kind === 'set' || kind === 'typedarray';
}

/** Les seuls types qu'on modifie sur place — exactement la liste demandée : chaîne, nombre, booléen, null. */
function _diEditable(kind) {
  return kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'null';
}

/** Valeur lisible et courte pour une ligne. */
function _mjs_diApercu(v, kind) {
  kind = kind || _mjs_diKind(v);
  switch (kind) {
    case 'null': return 'null';
    case 'undefined': return 'undefined';
    case 'string': return JSON.stringify(v.length > 120 ? v.slice(0, 117) + '…' : v);
    case 'bigint': return String(v) + 'n';
    case 'number': case 'boolean': return String(v);
    case 'symbol': return String(v);
    case 'function': return 'ƒ ' + (v.name || '(anonyme)') + '()';
    case 'node': return '<' + (v.tagName ? v.tagName.toLowerCase() : 'nœud') + '>';
    case 'date': { try { return v.toISOString(); } catch (e) { return 'Date invalide'; } }
    case 'regexp': return v.toString();
    case 'error': return (v.name || 'Error') + ': ' + (v.message || '');
    case 'promise': return 'Promise';
    case 'map': return 'Map(' + v.size + ')';
    case 'set': return 'Set(' + v.size + ')';
    case 'typedarray': return (v.constructor ? v.constructor.name : 'TypedArray') + '(' + v.length + ')';
    case 'array': return 'Array(' + v.length + ')';
    default: return 'Objet' + (v && v.constructor && v.constructor.name && v.constructor.name !== 'Object' ? ' ' + v.constructor.name : '');
  }
}
µ._mjs_diApercu = _mjs_diApercu;

// entrées PROPRES seulement (jamais le prototype) : Object.keys + clés symboliques énumérables.
// un accesseur qui explose est capturé (okGet false) et affiché comme un échec, pas relancé
function _diEntreesObjet(v) {
  var cles = [], syms = [];
  try {
    cles = Object.keys(v);
    syms = Object.getOwnPropertySymbols(v).filter(function(s) {
      var d = Object.getOwnPropertyDescriptor(v, s);
      return d && d.enumerable;
    });
  } catch (e) { /* ownKeys/getOwnPropertySymbols en échec (proxy exotique) : liste vide, pas de crash */ }
  var toutes = cles.concat(syms), out = [];
  for (var i = 0; i < toutes.length; i++) {
    var c = toutes[i], val, ok = true, err;
    try { val = v[c]; } catch (e) { ok = false; err = (e && e.message) || String(e); }
    out.push({
      cle: c,
      cheminSeg: typeof c === 'symbol' ? '@sym' + i : String(c),
      label: typeof c === 'symbol' ? '[' + String(c) + ']' : String(c),
      valeur: val, okGet: ok, errMsg: err
    });
  }
  return out;
}

/** Les entrées d'un conteneur, plafonnées à `_DI_MAX`, avec le compte de ce qui reste. */
function _diEntries(conteneur, kind) {
  var out = [], restants = 0;
  if (kind === 'map') {
    var i = 0;
    conteneur.forEach(function(val, cle) {
      if (out.length < _DI_MAX) out.push({ cle: cle, cheminSeg: '#' + i, label: _mjs_diApercu(cle, _mjs_diKind(cle)), valeur: val, okGet: true });
      else restants++;
      i++;
    });
    return { entries: out, restants: restants };
  }
  if (kind === 'set') {
    var j = 0;
    conteneur.forEach(function(val) {
      if (out.length < _DI_MAX) out.push({ cle: j, cheminSeg: '#' + j, label: String(j), valeur: val, okGet: true });
      else restants++;
      j++;
    });
    return { entries: out, restants: restants };
  }
  if (kind === 'array' || kind === 'typedarray') {
    var len = conteneur.length || 0;
    for (var k = 0; k < len; k++) {
      if (out.length < _DI_MAX) out.push({ cle: k, cheminSeg: String(k), label: String(k), valeur: conteneur[k], okGet: true });
      else restants++;
    }
    return { entries: out, restants: restants };
  }
  var brut = _diEntreesObjet(conteneur);
  for (var m = 0; m < brut.length; m++) {
    if (out.length < _DI_MAX) out.push(brut[m]); else restants++;
  }
  return { entries: out, restants: restants };
}

/** Écrit `valeur` à la clé `cle` d'un conteneur — Map/Set/objet-tableau ont chacun leur geste natif. */
function _diPoser(conteneur, kind, cle, valeur) {
  if (kind === 'map') { conteneur.set(cle, valeur); return; }
  if (kind === 'set') return;   // pas de notion de clé sur un Set : édition en place non proposée
  conteneur[cle] = valeur;      // objet, tableau, tableau typé — affectation directe sur la RÉFÉRENCE vivante
}

var _DI_CSS = `
.di-titre { font-weight: 700; color: #6ea8fe; margin-bottom: .4rem; }
.di-arbre { display: flex; flex-direction: column; }
.di-ligne { display: flex; align-items: center; gap: .35rem; padding: .08rem 0; white-space: nowrap; }
.di-chevron { font: inherit; background: none; border: 0; color: #8b949e; cursor: pointer; width: 1.1em; padding: 0; }
.di-pousse { display: inline-block; width: 1.1em; flex: none; }
.di-cle { color: #7ee787; }
.di-type { color: #8b949e; font-size: .85em; }
.di-apercu { color: #e6edf3; overflow: hidden; text-overflow: ellipsis; }
.di-circulaire { color: #f0883e; }
.di-echec { color: #f85149; }
.di-reste { opacity: .6; padding-left: 1.5rem; font-style: italic; }
.di-valeur { font: inherit; background: #161b22; color: inherit; border: 1px solid #30363d; border-radius: 4px; padding: 0 .3rem; max-width: 220px; }
.di-check { width: 1em; height: 1em; }
.di-vide { opacity: .5; }
`;

/**
 * Monte l'inspecteur dans `hote` (n'importe quel élément DOM) sur `valeur`. `options` :
 * `titre` (bandeau facultatif) · `ns` (namespace du pli, par défaut 'racine') ·
 * `onWriteRoot(cle, v)` (intercepte l'écriture d'une clé de PREMIER NIVEAU ; retourne `true` si
 * elle a géré l'écriture — sinon repli sur l'affectation directe) · `filtrerRacine(cle)` /
 * `triRacine(a, b)` (ne s'appliquent qu'au premier niveau — un objet niché montre tout, brut) ·
 * `videTexte` (message quand il n'y a rien à montrer).
 */
µ._mjs_diRender = function(hote, valeur, options) {
  options = options || {};
  var ns = options.ns || 'racine';
  var titre = options.titre;
  var onWriteRoot = options.onWriteRoot;
  var filtrerRacine = options.filtrerRacine;
  var triRacine = options.triRacine;
  var videTexte = options.videTexte || 'aucune valeur';
  var ouverts = _diSetOuverts(ns);
  var regs;   // reconstruit à CHAQUE redessin — les fermetures d'un ancien passage ne doivent pas survivre

  function chemin(cheminParentSegs, seg) {
    return ns + JSON.stringify(cheminParentSegs.concat([seg]));
  }

  function rendreEntrees(conteneur, kind, cheminParentSegs, ancetres, profondeur, filtre, tri) {
    var res = _diEntries(conteneur, kind);
    var liste = res.entries;
    if (profondeur === 0 && filtre) liste = liste.filter(function(e) { return filtre(e.cle); });
    if (profondeur === 0 && tri) liste = liste.slice().sort(function(a, b) { return tri(a.cle, b.cle); });
    var html = liste.map(function(e) { return rendreLigne(e, conteneur, kind, cheminParentSegs, ancetres, profondeur); }).join('');
    if (res.restants > 0) html += '<div class="di-reste">… et ' + res.restants + ' de plus (affichage plafonné à ' + _DI_MAX + ')</div>';
    return html;
  }

  function rendreLigne(e, conteneurParent, kindParent, cheminParentSegs, ancetres, profondeur) {
    var indent = 'style="padding-left:' + (0.5 + profondeur * 1.1) + 'rem"';
    if (!e.okGet) {
      return '<div class="di-ligne" ' + indent + '><span class="di-pousse"></span><span class="di-cle">' + µ._esc(e.label) +
        '</span><span class="di-type">accesseur</span><span class="di-apercu di-echec">⚠ échec : ' + µ._esc(e.errMsg) + '</span></div>';
    }
    var chem = chemin(cheminParentSegs, e.cheminSeg);
    var vkind = _mjs_diKind(e.valeur);
    var estObjet = e.valeur !== null && typeof e.valeur === 'object';
    var circulaire = _diExpandable(vkind) && estObjet && ancetres.indexOf(e.valeur) !== -1;
    var expansible = _diExpandable(vkind) && !circulaire;
    var ouvert = expansible && ouverts.has(chem);
    var chevron;
    if (expansible) {
      var idxC = regs.push({ type: 'toggle', chemin: chem }) - 1;
      chevron = '<button type="button" class="di-chevron" data-di-idx="' + idxC + '" aria-expanded="' + (ouvert ? 'true' : 'false') + '">' + (ouvert ? '▾' : '▸') + '</button>';
    } else {
      chevron = '<span class="di-pousse" aria-hidden="true"></span>';
    }
    var apercu;
    var editable = !expansible && kindParent !== 'set' && _diEditable(vkind);
    if (circulaire) {
      apercu = '<span class="di-apercu di-circulaire">↺ référence circulaire</span>';
    } else if (editable && vkind === 'boolean') {
      var idxB = regs.push({ type: 'checkbox', conteneur: conteneurParent, kind: kindParent, cle: e.cle, estRacine: profondeur === 0 }) - 1;
      apercu = '<input type="checkbox" class="di-check" data-di-idx="' + idxB + '"' + (e.valeur ? ' checked' : '') + '>';
    } else if (editable) {
      var idxI = regs.push({ type: 'input', conteneur: conteneurParent, kind: kindParent, cle: e.cle, valType: vkind, estRacine: profondeur === 0 }) - 1;
      var val = e.valeur === null ? '' : String(e.valeur);
      apercu = '<input type="text" class="di-valeur" data-di-idx="' + idxI + '" data-di-key="' + µ._esc(e.label) + '" value="' + µ._esc(val) + '">';
    } else {
      apercu = '<span class="di-apercu">' + µ._esc(_mjs_diApercu(e.valeur, vkind)) + '</span>';
    }
    var ligne = '<div class="di-ligne" ' + indent + '>' + chevron + '<span class="di-cle">' + µ._esc(e.label) +
      '</span><span class="di-type">' + vkind + '</span>' + apercu + '</div>';
    if (ouvert) {
      var segs = cheminParentSegs.concat([e.cheminSeg]);
      ligne += '<div class="di-enfants">' + rendreEntrees(e.valeur, vkind, segs, ancetres.concat([e.valeur]), profondeur + 1, null, null) + '</div>';
    }
    return ligne;
  }

  function cabler() {
    hote.querySelectorAll('[data-di-idx]').forEach(function(el) {
      var reg = regs[+el.getAttribute('data-di-idx')];
      if (!reg) return;
      if (reg.type === 'toggle') {
        el.addEventListener('click', function() {
          if (ouverts.has(reg.chemin)) ouverts.delete(reg.chemin); else ouverts.add(reg.chemin);
          dessiner();
        });
        return;
      }
      el.addEventListener('change', function() {
        var v;
        if (reg.type === 'checkbox') v = el.checked;
        else if (reg.valType === 'number') v = Number(el.value);
        else if (reg.valType === 'null') v = el.value === '' ? null : el.value;
        else v = el.value;
        if (reg.estRacine && typeof onWriteRoot === 'function' && onWriteRoot(reg.cle, v)) { dessiner(); return; }
        _diPoser(reg.conteneur, reg.kind, reg.cle, v);
        dessiner();
      });
    });
  }

  function dessiner() {
    regs = [];
    var kind = _mjs_diKind(valeur);
    var corps;
    if (!_diExpandable(kind)) {
      // racine scalaire (ex. µ.devObject(42)) : rien à quoi rattacher une écriture, lecture seule
      corps = '<div class="di-arbre"><div class="di-ligne"><span class="di-pousse"></span><span class="di-type">' + kind +
        '</span><span class="di-apercu">' + µ._esc(_mjs_diApercu(valeur, kind)) + '</span></div></div>';
    } else {
      var html = rendreEntrees(valeur, kind, [], [valeur], 0, filtrerRacine, triRacine);
      corps = '<div class="di-arbre">' + (html || '<p class="di-vide">' + µ._esc(videTexte) + '</p>') + '</div>';
    }
    hote.innerHTML = '<style>' + _DI_CSS + '</style>' + (titre ? '<div class="di-titre">' + µ._esc(titre) + '</div>' : '') + corps;
    cabler();
  }

  dessiner();
};

if (µ.debug) console.log("🔬 [ModularJS] inspecteur d'objets armé — µ.devObject(valeur), ou depuis le panneau (Ctrl+Shift+Espace)");
