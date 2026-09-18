// mjs_devpanel — le panneau d'inspection, dans la page, en développement.
//
// N'EST PAS DANS LE BUNDLE DE PRODUCTION : le bundler n'ajoute ce fichier (et mjs_devinspect,
// juste avant lui) qu'aux builds non-prod, exactement comme mjs_debug (cf. bundler/index.ts,
// insertion juste avant mjs_flip). Zéro poids et zéro test de garde en prod : le code n'y est
// simplement pas.
//
// Ce qu'il montre, et que personne d'autre ne peut montrer : la réactivité de MJS est
// résolue À LA COMPILATION, donc le graphe des dépendances est connu. Chaque composant
// embarque déjà `_mjs_computedDeps` (`{ total: ['price','quantity'] }`) et `_mjs_effectsByVar`.
// Le panneau répond donc à la seule question qui compte quand un écran reste figé :
// « de quoi ce dérivé dépend-il, et cette variable-là en fait-elle partie ? »
//
// Ancré en bas de la fenêtre par défaut (`_dpGeo.mode === 'bas'`), page visible en permanence
// derrière, sans écran assombri par-dessus. Déplaçable (poignée = la `.barre`) et redimensionnable (`.grip-h`
// en bas, `.grip-c` en flottant) ; la géométrie vit dans `_dpGeo`, persistée en `localStorage`
// (`_dpGeoRelire`/`_dpGeoEcrire`), et se ré-applique à chaque `_dpRender()` (`_dpGeoAppliquer`).
// `Échap` referme, le focus entre à l'ouverture et revient d'où il venait à la fermeture
// (`role="dialog"`, sans `aria-modal` : ce n'est plus une modale). Le
// volet de droite est en onglets (État/Dérivés/Liaisons/Contexte/Attributs et props/Style et
// thème) ; l'onglet État réutilise mjs_devinspect (µ._mjs_diRender) directement sur `_state` — une
// valeur composée s'y déplie EN PLACE avec le même moteur, c'est la « combinaison des deux
// outils » demandée. Seul cas spécial : écrire une clé de PREMIER NIVEAU de `_state` doit passer
// par `el._set` (computeds/limites/etc en dépendent) — mjs_devinspect l'ignore, on le lui donne
// via `onWriteRoot`. Plus profond dans un objet d'état, l'affectation directe suffit déjà :
// la réactivité MJS est profonde par défaut (filet `_mjs_wrapDeep`, mjs_element.ts).
//
// Ouverture : Ctrl+Shift+Espace (aucun navigateur ne le prend), ou `µ.devPanel()` depuis la
// console — bascule sans argument, ouvre/ferme sans ambiguïté avec un booléen, sélectionne un
// composant par SÉLECTEUR CSS avec une chaîne (cherche aussi dans les Shadow DOM imbriqués,
// cf. `_dpResoudre`, puisque `µ.instances` est déjà plat). `µ.devObject(valeur, nom?)` ouvre
// directement sur l'inspecteur générique. Raccourci changeable par `µ.config.devPanelKey`
// (`e.code` d'une touche).

var _dpHost = null, _dpRoot = null, _dpTimer = null, _dpSelected = null, _dpHighlight = null;
var _dpOnglet = 'etat', _dpObjet = null, _dpFocusPrecedent = null;
var _dpArbreReplies = new Set();   // uids de composants REPLIÉS dans l'arbre — vide = tout déplié (comportement historique)
var _dpSignaturePrec = '';   // quel volet a été rendu au tour d'avant — cf. la préservation du défilement dans `_dpRender`

// géométrie du panneau — PERSISTE entre deux `_dpRender()` (qui réécrit tout l'innerHTML
// toutes les 700 ms) : le style est ré-appliqué à chaque rendu depuis cet objet
var _dpGeo = { mode: 'bas', h: 320, x: 40, y: 40, w: 720 };
var _dpGlissement = null;   // pointeur en cours de déplacement/redimensionnement, sinon null
var _dpGeoRelue  = false;   // la relecture du stockage est PARESSEUSE — cf. _dpGeoRelire

// registre des rendus — mjs_debug enveloppe déjà `_mjs_runEffectsV2` pour la télémétrie
// visuelle ; on compte ici, sur le même point de passage, sans le doubler
if (µ.Element && !µ.Element.prototype._mjs_dpCounted) {
  µ.Element.prototype._mjs_dpCounted = true;
  var _dpOriginalRun = µ.Element.prototype._mjs_runEffectsV2;
  µ.Element.prototype._mjs_runEffectsV2 = function(d, full) {
    this._mjs_renderCount = (this._mjs_renderCount || 0) + 1;
    return _dpOriginalRun.call(this, d, full);
  };
}

/** Nom court d'une instance : `mjs-my-counter` → `my-counter`. */
function _dpName(el) {
  return el.tagName.toLowerCase().replace(/^mjs-/, '');
}

// identifiant STABLE par instance — namespace des chemins dépliés dans mjs_devinspect, et clé
// de repli/dépli de l'arbre. Un WeakMap plutôt qu'une propriété posée sur l'élément : zéro
// risque de collision avec une clé `_state`/`_mjs_var_bits` du composant lui-même
var _dpUidMap = new WeakMap(), _dpUidSuivant = 1;
function _dpUid(el) {
  var id = _dpUidMap.get(el);
  if (!id) { id = _dpUidSuivant++; _dpUidMap.set(el, id); }
  return id;
}

/** L'instance MJS la plus proche AU-DESSUS de `el`, frontières d'ombre franchies. */
function _dpParent(el) {
  var node = el.parentNode;
  while (node) {
    if (node.nodeType === 11) { node = node.host; continue; }
    if (node instanceof µ.Element) return node;
    node = node.parentNode;
  }
  return null;
}

/** Arbre des instances vivantes : [{el, enfants:[…]}], racines d'abord. */
function _dpTree() {
  var vivantes = [];
  µ.instances.forEach(function(el) { if (el.isConnected) vivantes.push(el); });
  var noeuds = new Map();
  vivantes.forEach(function(el) { noeuds.set(el, { el: el, enfants: [] }); });
  var racines = [];
  vivantes.forEach(function(el) {
    var parent = _dpParent(el);
    if (parent && noeuds.has(parent)) noeuds.get(parent).enfants.push(noeuds.get(el));
    else racines.push(noeuds.get(el));
  });
  return racines;
}

/** Vrai si `selecteur` matche un ANCÊTRE de `el` (frontières d'ombre franchies). */
function _dpAncetreMatch(el, selecteur) {
  var node = el.parentNode;
  while (node) {
    if (node.nodeType === 11) { node = node.host; continue; }
    if (node.nodeType === 1 && node.matches && node.matches(selecteur)) return true;
    node = node.parentNode;
  }
  return false;
}

/**
 * L'instance que `selecteur` désigne, en descendant `µ.instances` — déjà PLAT (il contient
 * toute instance connectée, quelle que soit sa profondeur d'imbrication en Shadow DOM, cf.
 * mjs_debug.ts) : un `document.querySelector` seul ne verrait pas un composant niché derrière
 * une frontière d'ombre fermée, cette liste si. Retient la PREMIÈRE instance qui `matches()`
 * elle-même, ou dont un ANCÊTRE matche (un sélecteur peut désigner une section qui enveloppe
 * le composant sans être lui, ex. `.panier` autour d'un `<mjs-cart-item>`). Ordre de parcours =
 * ordre d'insertion dans `µ.instances`, donc globalement l'ordre de CONNEXION des composants —
 * documenté ici pour qui s'attendrait à un ordre visuel strict (pas garanti à travers plusieurs
 * arbres de Shadow DOM indépendants). Sélecteur invalide : aucune correspondance, jamais un crash.
 */
function _dpResoudre(selecteur) {
  var candidats = Array.from(µ.instances);
  for (var i = 0; i < candidats.length; i++) {
    var el = candidats[i];
    if (!el.isConnected) continue;
    try {
      if ((el.matches && el.matches(selecteur)) || _dpAncetreMatch(el, selecteur)) return el;
    } catch (e) { return null; }
  }
  return null;
}

/** Valeur lisible et courte, pour une ligne de tableau (délègue à l'inspecteur générique). */
function _dpApercu(v) {
  return µ._mjs_diApercu(v);
}

// `_mjs_computedKeys` est un TABLEAU de noms (cf. `_mjs_setComputed`, mjs_element.ts), pas une
// table — s'y tromper listerait les indices `0`, `1`… à la place des dérivés
/** Les clés d'état PROPRES au composant, sans les dérivés ni la plomberie. */
function _dpEtatKeys(el) {
  var etat = el._state || {};
  var derives = new Set(el._mjs_computedKeys || []);
  return Object.keys(etat).filter(function(k) { return !derives.has(k) && k.charAt(0) !== '_'; }).sort();
}

function _dpDeriveKeys(el) {
  return (el._mjs_computedKeys || []).slice().sort();
}

/** Surligne l'élément dans la page, sans toucher à son style à lui. */
function _dpSurligner(el) {
  if (!_dpHighlight) {
    _dpHighlight = document.createElement('div');
    _dpHighlight.setAttribute('data-mjs-devpanel-highlight', '');
    _dpHighlight.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #6ea8fe;background:rgba(110,168,254,.15);border-radius:3px;transition:all .08s';
    document.body.appendChild(_dpHighlight);
  }
  if (!el) { _dpHighlight.style.display = 'none'; return; }
  var r = el.getBoundingClientRect();
  _dpHighlight.style.display = 'block';
  _dpHighlight.style.left   = r.left + 'px';
  _dpHighlight.style.top    = r.top + 'px';
  _dpHighlight.style.width  = r.width + 'px';
  _dpHighlight.style.height = r.height + 'px';
}

// Relit `_dpGeo` depuis `localStorage` — stockage absent, refusé ou valeur corrompue : on garde
// les valeurs par défaut, jamais de plantage.
//
// DEUX précautions, chacune payée par une vraie panne :
//   1. PARESSEUSE — appelée à l'OUVERTURE du panneau, jamais au chargement du module. Le module
//      est concaténé dans le core de tout bundle de développement : une exception ici tuait le
//      RESTE du core (`µ.instances` jamais posé, `µ.devPanel` jamais défini), que le développeur
//      ouvre le panneau ou non.
//   2. `typeof localStorage` EST DANS le try — sur un document d'origine opaque (`about:blank`,
//      `page.setContent()` d'un Playwright, iframe sandboxée sans `allow-same-origin`), le simple
//      `typeof` lève un `SecurityError`. La garde `typeof … === 'undefined'` posée DEVANT le try
//      (motif repris de mjs_i18n/mjs_accounts, où l'accès est paresseux et opt-in) ne protège donc
//      rien ici : c'est elle qui jetait.
function _dpGeoRelire() {
  if (_dpGeoRelue) return;
  _dpGeoRelue = true;
  try {
    if (typeof localStorage === 'undefined') { _dpGeoBorner(); return; }
    var brut = localStorage.getItem('mjs-devpanel-geo');
    if (!brut) { _dpGeoBorner(); return; }
    var lu = JSON.parse(brut);
    if (!lu || typeof lu !== 'object') { _dpGeoBorner(); return; }
    if (lu.mode === 'bas' || lu.mode === 'flottant') _dpGeo.mode = lu.mode;
    if (typeof lu.h === 'number') _dpGeo.h = lu.h;
    if (typeof lu.w === 'number') _dpGeo.w = lu.w;
    if (typeof lu.x === 'number') _dpGeo.x = lu.x;
    if (typeof lu.y === 'number') _dpGeo.y = lu.y;
  } catch (e) { /* stockage désactivé ou valeur corrompue : on garde les valeurs par défaut */ }
  _dpGeoBorner();
}

/** Écrit `_dpGeo` dans `localStorage` — silencieux si le stockage est indisponible. */
function _dpGeoEcrire() {
  // même raison qu'au § 2 de `_dpGeoRelire` : le `typeof` lui-même peut lever, il reste DANS le try
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('mjs-devpanel-geo', JSON.stringify(_dpGeo));
  } catch (e) { /* stockage indisponible ou refusé : tant pis */ }
}

/** Ramène `_dpGeo` dans des bornes valides, fenêtre courante comprise. */
function _dpGeoBorner() {
  _dpGeo.h = Math.min(Math.max(_dpGeo.h, 140), Math.max(140, window.innerHeight - 40));
  _dpGeo.w = Math.min(Math.max(_dpGeo.w, 320), Math.max(320, window.innerWidth - 40));
  _dpGeo.x = Math.min(Math.max(_dpGeo.x, 0), Math.max(0, window.innerWidth - 80));
  _dpGeo.y = Math.min(Math.max(_dpGeo.y, 0), Math.max(0, window.innerHeight - 80));
}

// espace RENDU à la page quand le panneau est ancré en bas. La console du navigateur, elle,
// rétrécit le viewport lui-même — aucun script de la page ne peut faire ça. On pose donc un
// padding bas sur l'élément qui défile : la course du défilement s'allonge d'autant, et le bas
// du document redevient atteignable au lieu de rester sous le panneau. Un `position:fixed` de
// la page reste couvert (rien ne peut l'en sortir depuis un script), c'est la seule limite.
var _dpPaddingPrec = null;   // padding bas INLINE d'avant nous, rendu tel quel à la fermeture

function _dpElementDefilant() {
  return document.scrollingElement || document.documentElement;
}

/**
 * Réserve `_dpGeo.h` en bas du document (mode ancré) — DEUX gestes, parce qu'une page peut se
 * mettre en page de deux façons :
 *  1. `padding-bottom` sur l'élément qui défile : allonge la course du défilement. Suffit à une
 *     page qui défile au document (le cas courant) — son bas redevient atteignable.
 *  2. `--mjs-devpanel-h` sur `<html>` (+ l'attribut `data-mjs-devpanel-dock`) : une page dont la
 *     hauteur est celle de la FENÊTRE (`height: 100vh`) ne défile pas, elle est simplement coupée
 *     par le panneau ; le `padding` ne peut rien pour elle. Elle écrit alors
 *     `height: calc(100vh - var(--mjs-devpanel-h, 0px))` et se rétrécit d'elle-même — le seul
 *     moyen depuis un script, le viewport réel n'étant réductible que par le navigateur lui-même.
 */
function _dpReserverEspace() {
  var el = _dpElementDefilant();
  if (el && el.style) {
    if (_dpPaddingPrec === null) _dpPaddingPrec = el.style.paddingBottom || '';
    el.style.paddingBottom = _dpGeo.h + 'px';
  }
  var racine = document.documentElement;
  if (racine && racine.style) {
    racine.style.setProperty('--mjs-devpanel-h', _dpGeo.h + 'px');
    racine.setAttribute('data-mjs-devpanel-dock', '');
  }
}

/** Rend la place à la page — mode flottant ou panneau fermé. Idempotent. */
function _dpLibererEspace() {
  var el = _dpElementDefilant();
  if (el && el.style && _dpPaddingPrec !== null) el.style.paddingBottom = _dpPaddingPrec;
  _dpPaddingPrec = null;
  var racine = document.documentElement;
  if (racine && racine.style) {
    racine.style.removeProperty('--mjs-devpanel-h');
    racine.removeAttribute('data-mjs-devpanel-dock');
  }
}

/** Applique `_dpGeo` en style inline sur le nœud `.panneau` — ré-appliqué à chaque rendu, cf. en-tête du fichier. */
function _dpGeoAppliquer(panneauEl) {
  if (_dpGeo.mode === 'flottant') { panneauEl.style.cssText = 'left:' + _dpGeo.x + 'px; top:' + _dpGeo.y + 'px; right:auto; bottom:auto; width:' + _dpGeo.w + 'px; height:' + _dpGeo.h + 'px; border-radius:10px;'; _dpLibererEspace(); }
  else { panneauEl.style.cssText = 'left:0; right:0; bottom:0; top:auto; width:auto; height:' + _dpGeo.h + 'px; border-radius:10px 10px 0 0; border-bottom:0;'; _dpReserverEspace(); }
}

/**
 * Vrai si le focus est DANS un champ de saisie du panneau. Le rendu périodique réécrit tout
 * l'`innerHTML` : sans cette garde, une valeur d'état qu'on tape perdait le focus et le texte
 * en cours toutes les 700 ms — le champ n'existait plus, le caret non plus.
 */
function _dpSaisieEnCours() {
  // `activeElement` d'un shadow root peut LEVER hors navigateur (happy-dom remonte à travers
  // les shadow roots frères et finit par déréférencer undefined quand le focus est dans un
  // AUTRE shadow root que le nôtre). Une exception ici sort du callback de `setInterval`, qui
  // ANNULE l'intervalle : le panneau se figerait pour de bon, sans le moindre message. On
  // préfère donc conclure « personne ne saisit » — un rendu de trop, jamais un panneau mort.
  var actif;
  try { actif = _dpRoot && _dpRoot.activeElement } catch (e) { return false }
  if (!actif) return false;
  return actif.tagName === 'INPUT' || actif.tagName === 'TEXTAREA' || actif.tagName === 'SELECT' || actif.isContentEditable === true;
}

/** Battement du rafraîchissement périodique : passe son tour tant qu'on saisit (cf. `_dpSaisieEnCours`). */
function _dpTick() {
  if (_dpSaisieEnCours()) return;
  _dpRender();
}

/** Démarre un déplacement (`genre` 'deplacer') ou un redimensionnement ('redim-h'/'redim-c') au pointeur. */
function _dpGlisserDemarrer(e, genre) {
  var panneauEl = _dpRoot && _dpRoot.querySelector('.panneau');
  if (!panneauEl) return;
  if (genre === 'deplacer' && _dpGeo.mode === 'bas') {
    var rect = panneauEl.getBoundingClientRect();   // position/taille visibles à l'instant du bascule bas → flottant
    _dpGeo.mode = 'flottant'; _dpGeo.x = rect.left; _dpGeo.y = rect.top; _dpGeo.w = rect.width; _dpGeo.h = rect.height;
  }
  var cible = e.currentTarget;
  _dpGlissement = { genre: genre, cible: cible, pointerId: e.pointerId, depX: e.clientX, depY: e.clientY, geoDep: { x: _dpGeo.x, y: _dpGeo.y, w: _dpGeo.w, h: _dpGeo.h } };
  cible.setPointerCapture(e.pointerId);
  cible.addEventListener('pointermove', _dpGlisserBouger);
  cible.addEventListener('pointerup', _dpGlisserFinir);
  cible.addEventListener('pointercancel', _dpGlisserFinir);
  clearInterval(_dpTimer); _dpTimer = null;   // sinon l'innerHTML est réécrit sous le pointeur
}

/** Suit le pointeur : ajuste `_dpGeo` et réapplique juste le style, sans repasser par `_dpRender()`. */
function _dpGlisserBouger(e) {
  if (!_dpGlissement) return;
  var dx = e.clientX - _dpGlissement.depX, dy = e.clientY - _dpGlissement.depY;
  var depart = _dpGlissement.geoDep;
  if (_dpGlissement.genre === 'deplacer') { _dpGeo.x = depart.x + dx; _dpGeo.y = depart.y + dy; }
  else if (_dpGlissement.genre === 'redim-h') _dpGeo.h = depart.h - dy;
  else if (_dpGlissement.genre === 'redim-c') { _dpGeo.w = depart.w + dx; _dpGeo.h = depart.h + dy; }
  _dpGeoBorner();
  var panneauEl = _dpRoot && _dpRoot.querySelector('.panneau');
  if (panneauEl) _dpGeoAppliquer(panneauEl);
}

/** Relâche le pointeur, referme le glissement, sauvegarde la géométrie et relance le rendu périodique. */
function _dpGlisserFinir(e) {
  if (!_dpGlissement) return;
  var cible = _dpGlissement.cible;
  cible.removeEventListener('pointermove', _dpGlisserBouger);
  cible.removeEventListener('pointerup', _dpGlisserFinir);
  cible.removeEventListener('pointercancel', _dpGlisserFinir);
  if (cible.releasePointerCapture) { try { cible.releasePointerCapture(_dpGlissement.pointerId); } catch (err) { /* déjà relâché */ } }
  _dpGlissement = null;
  _dpGeoEcrire();
  _dpRender();
  _dpTimer = setInterval(_dpTick, 700);
}

var _DP_CSS = `
:host { all: initial; }
.panneau { position: fixed; display: grid; grid-template-rows: auto 1fr; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.5); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; z-index: 2147483647; overflow: hidden; }
.grip-h { position: absolute; top: 0; left: 0; right: 0; height: 6px; cursor: ns-resize; z-index: 1; }
.grip-c { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; z-index: 1; }
.barre { display: flex; align-items: center; gap: .75rem; padding: .5rem .75rem; border-bottom: 1px solid #30363d; background: #161b22; cursor: move; }
.titre { font-weight: 700; color: #6ea8fe; }
.compte { opacity: .6; }
.barre button { font: inherit; background: #21262d; color: inherit; border: 1px solid #30363d; border-radius: 6px; padding: .15rem .5rem; cursor: pointer; }
.barre button[aria-pressed="true"] { background: #1f6feb; border-color: #1f6feb; }
.barre .pousse { margin-left: auto; }
.corps { display: grid; grid-template-columns: minmax(220px, 30%) 1fr; overflow: hidden; }
.arbre { overflow: auto; border-right: 1px solid #30363d; padding: .35rem 0; }
.noeud { display: flex; align-items: center; }
.repli { font: inherit; background: none; border: 0; color: #8b949e; cursor: pointer; width: 1.3rem; flex: none; }
.ligne { display: flex; flex: 1; align-items: center; gap: .4rem; padding: .1rem .6rem .1rem 0; cursor: pointer; white-space: nowrap; width: 100%; text-align: left; background: none; border: 0; color: inherit; font: inherit; }
.ligne:hover { background: #161b22; }
.ligne[aria-selected="true"] { background: #1f6feb; }
.ligne .rendus { opacity: .55; font-size: .9em; }
.detail { display: flex; flex-direction: column; overflow: hidden; }
.di-entete { padding: .6rem .8rem .3rem; font-weight: 700; color: #6ea8fe; }
.onglets { display: flex; gap: .9rem; padding: 0 .8rem .4rem; border-bottom: 1px solid #30363d; flex-wrap: wrap; }
.onglet { font: inherit; background: transparent; color: #8b949e; border: 0; border-bottom: 2px solid transparent; padding: .3rem .1rem; cursor: pointer; }
.onglet[aria-selected="true"] { color: #e6edf3; border-bottom-color: #6ea8fe; }
.onglet-corps { flex: 1; overflow: auto; padding: .6rem .8rem; }
.onglet-corps h2 { margin: 0 0 .4rem; font-size: 12px; color: #6ea8fe; text-transform: uppercase; letter-spacing: .06em; }
.onglet-corps section { margin-bottom: .9rem; }
.lien-retour { font: inherit; background: none; border: 0; color: #6ea8fe; cursor: pointer; padding: .5rem .8rem 0; text-align: left; }
table { border-collapse: collapse; width: 100%; }
td { padding: .12rem .4rem .12rem 0; vertical-align: top; }
td.cle { color: #7ee787; white-space: nowrap; }
td.deps { color: #d2a8ff; white-space: nowrap; }
.di-css { white-space: pre-wrap; word-break: break-word; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: .5rem; max-height: 240px; overflow: auto; }
.vide { opacity: .5; }
.aide { padding: 2rem; text-align: center; opacity: .6; }
`;

/** (Re)dessine tout le panneau. */
function _dpRender() {
  if (!_dpRoot) return;
  // le rendu réécrit TOUT l'innerHTML : sans ces deux mesures, les deux volets sautaient en
  // haut toutes les 700 ms. L'arbre garde toujours sa position ; le volet de droite seulement
  // si c'est le même composant, le même onglet — sinon on veut bien repartir du début.
  var volet = _dpRoot.querySelector('.arbre'), corpsPrec = _dpRoot.querySelector('.onglet-corps');
  var defArbre = volet ? volet.scrollTop : 0, defCorps = corpsPrec ? corpsPrec.scrollTop : 0;
  var signature = _dpOnglet + '|' + (_dpSelected ? _dpUid(_dpSelected) : 0) + '|' + (_dpObjet ? 'obj' : '');
  var racines = _dpTree();
  var total = 0;
  µ.instances.forEach(function(el) { if (el.isConnected) total++; });

  var grip = _dpGeo.mode === 'bas' ? '<div class="grip-h" data-grip="h"></div>' : '<div class="grip-c" data-grip="c"></div>';
  var libelleAncrer = _dpGeo.mode === 'flottant' ? 'ancrer en bas' : 'détacher';
  var html = '<div class="panneau" role="dialog" aria-labelledby="dp-titre" tabindex="-1">' + grip + '<div class="barre"><span class="titre" id="dp-titre">ModularJS</span>' +
    '<span class="compte">' + total + ' composant' + (total > 1 ? 's' : '') + ' monté' + (total > 1 ? 's' : '') + '</span>' +
    '<button class="pousse" data-action="flash" aria-pressed="' + (µ.debugMode ? 'true' : 'false') + '">clignoter au rendu</button>' +
    '<button data-action="ancrer">' + libelleAncrer + '</button>' +
    '<button data-action="refresh">rafraîchir</button>' +
    '<button data-action="close">fermer</button>' +
    '</div><div class="corps"><div class="arbre"></div><div class="detail"></div></div></div>';
  _dpRoot.innerHTML = '<style>' + _DP_CSS + '</style>' + html;

  var arbre = _dpRoot.querySelector('.arbre');
  var lignes = [];
  (function marcher(noeuds, profondeur) {
    noeuds.sort(function(a, b) { return _dpName(a.el) < _dpName(b.el) ? -1 : 1; });
    noeuds.forEach(function(n) {
      lignes.push({ el: n.el, profondeur: profondeur, aEnfants: n.enfants.length > 0 });
      if (!_dpArbreReplies.has(_dpUid(n.el))) marcher(n.enfants, profondeur + 1);
    });
  })(racines, 0);

  lignes.forEach(function(l) {
    var uid = _dpUid(l.el);
    var noeud = document.createElement('div');
    noeud.className = 'noeud';
    noeud.style.paddingLeft = (l.profondeur * 0.9) + 'rem';
    noeud.innerHTML = (l.aEnfants
        ? '<button type="button" class="repli" data-uid="' + uid + '" aria-expanded="' + (_dpArbreReplies.has(uid) ? 'false' : 'true') + '">' + (_dpArbreReplies.has(uid) ? '▸' : '▾') + '</button>'
        : '<span class="repli" aria-hidden="true"></span>') +
      '<button type="button" class="ligne" aria-selected="' + (l.el === _dpSelected ? 'true' : 'false') + '"><span>' +
      µ._esc(_dpName(l.el)) + '</span><span class="rendus">·' + (l.el._mjs_renderCount || 0) + '</span></button>';
    var boutonRepli = noeud.querySelector('.repli[data-uid]');
    if (boutonRepli) {
      boutonRepli.addEventListener('click', function(e) {
        e.stopPropagation();
        if (_dpArbreReplies.has(uid)) _dpArbreReplies.delete(uid); else _dpArbreReplies.add(uid);
        _dpRender();
      });
    }
    var boutonLigne = noeud.querySelector('.ligne');
    boutonLigne.addEventListener('click', function() { _dpSelected = l.el; _dpObjet = null; _dpRender(); });
    boutonLigne.addEventListener('mouseenter', function() { _dpSurligner(l.el); });
    boutonLigne.addEventListener('mouseleave', function() { _dpSurligner(null); });
    arbre.appendChild(noeud);
  });

  _dpRenderDetail(_dpRoot.querySelector('.detail'));

  _dpRoot.querySelectorAll('.barre button').forEach(function(b) {
    b.addEventListener('click', function() {
      var action = b.getAttribute('data-action');
      if (action === 'close') µ.devPanel(false);
      else if (action === 'refresh') _dpRender();
      else if (action === 'flash') { µ.debugMode = !µ.debugMode; _dpRender(); }
      else if (action === 'ancrer') { _dpGeo.mode = _dpGeo.mode === 'flottant' ? 'bas' : 'flottant'; _dpGeoBorner(); _dpGeoEcrire(); _dpRender(); }
    });
  });

  var panneauEl = _dpRoot.querySelector('.panneau');
  _dpRoot.querySelector('.barre').addEventListener('pointerdown', function(e) {
    if (e.target.closest('button')) return;
    _dpGlisserDemarrer(e, 'deplacer');
  });
  var gripH = _dpRoot.querySelector('.grip-h');
  if (gripH) gripH.addEventListener('pointerdown', function(e) { _dpGlisserDemarrer(e, 'redim-h'); });
  var gripC = _dpRoot.querySelector('.grip-c');
  if (gripC) gripC.addEventListener('pointerdown', function(e) { _dpGlisserDemarrer(e, 'redim-c'); });
  _dpGeoAppliquer(panneauEl);

  var arbreNouveau = _dpRoot.querySelector('.arbre');
  if (arbreNouveau) arbreNouveau.scrollTop = defArbre;
  var corpsNouveau = _dpRoot.querySelector('.onglet-corps');
  if (corpsNouveau && signature === _dpSignaturePrec) corpsNouveau.scrollTop = defCorps;
  _dpSignaturePrec = signature;
}

var _DP_ONGLETS = [
  { id: 'etat', libelle: 'État' },
  { id: 'derives', libelle: 'Dérivés' },
  { id: 'liaisons', libelle: 'Liaisons' },
  { id: 'contexte', libelle: 'Contexte' },
  { id: 'props', libelle: 'Attributs et props' },
  { id: 'style', libelle: 'Style et thème' }
];

/**
 * Texte CSS actif sur le composant : les feuilles ADOPTÉES d'abord — c'est par là que passe
 * le framework par défaut (`_shadow.adoptedStyleSheets`, cf. `_mjs_applyLayout`/mjs_element.ts) —
 * un `<style>` réel seulement en repli (mode `mjs-light`, panneau « route introuvable » du
 * routeur : ni l'un ni l'autre n'a d'adoptedStyleSheets).
 */
function _dpStyleTexte(el) {
  var feuilles = (el._shadow && el._shadow.adoptedStyleSheets) || [];
  var morceaux = [];
  feuilles.forEach(function(feuille, i) {
    try {
      var texte = Array.from(feuille.cssRules || []).map(function(r) { return r.cssText; }).join('\n');
      if (texte) morceaux.push('/* feuille ' + (i + 1) + '/' + feuilles.length + ' */\n' + texte);
    } catch (e) { /* feuille illisible (rare) : ignorée sans planter */ }
  });
  if (morceaux.length) return morceaux.join('\n\n');
  var tag = el.tagName.toLowerCase();
  var styleEl = (el._shadow && el._shadow.querySelector && el._shadow.querySelector('style'))
    || document.head.querySelector('style[data-mjs-css="' + tag + '"]')
    || document.head.querySelector('style[data-mjs-light="' + tag + '"], style[data-mjs-light-layout="' + tag + '"]');
  return styleEl ? (styleEl.textContent || '') : '';
}

/**
 * Thème actif + variables en vigueur sur `el`. Les NOMS viennent du CSS déjà connu du runtime
 * (`µ._themeCss`/`µ._themeCssByName`, `--nom:` extrait par expression régulière), CHAQUE valeur
 * est ensuite résolue par `getComputedStyle` — la seule méthode qui marche partout : énumérer
 * les propriétés personnalisées directement depuis `getComputedStyle` est récent et absent de
 * Firefox.
 */
function _dpThemeInfo(el) {
  var actif = document.documentElement.getAttribute('data-mjs-theme') || document.documentElement.getAttribute('theme') || 'light';
  var connus = ['light', 'dark'].concat(Array.isArray(µ._themes) ? µ._themes : []);
  var source = (µ._themeCss || '') + '\n' + (µ._themeCssByName ? Object.keys(µ._themeCssByName).map(function(k) { return µ._themeCssByName[k]; }).join('\n') : '');
  var noms = new Set(), re = /--([a-zA-Z0-9_-]+)\s*:/g, m;
  while ((m = re.exec(source))) noms.add(m[1]);
  var vars = Array.from(noms).sort().map(function(nom) {
    var val = '';
    try { val = getComputedStyle(el).getPropertyValue('--' + nom).trim(); } catch (e) { val = ''; }
    return { nom: nom, val: val };
  });
  return { actif: actif, connus: connus, vars: vars };
}

function _dpOngletStyle(el) {
  var info = _dpThemeInfo(el);
  var css = _dpStyleTexte(el);
  var varsHtml = info.vars.length
    ? '<table>' + info.vars.map(function(v) { return '<tr><td class="cle">--' + µ._esc(v.nom) + '</td><td>' + µ._esc(v.val || '(vide)') + '</td></tr>'; }).join('') + '</table>'
    : '<p class="vide">aucune variable de thème détectée</p>';
  return '<section><h2>Thème actif</h2><p>' + µ._esc(info.actif) + ' — connus : ' + µ._esc(info.connus.join(', ')) + '</p></section>' +
    '<section><h2>Variables de thème en vigueur</h2>' + varsHtml + '</section>' +
    '<section><h2>CSS actif (feuilles adoptées)</h2><pre class="di-css">' + (css ? µ._esc(css) : '<span class="vide">aucun CSS propre détecté</span>') + '</pre></section>';
}

function _dpOngletProps(el) {
  var declares = el._mjs_var_bits ? Object.keys(el._mjs_var_bits).sort() : [];
  var lignesDeclares = declares.map(function(k) {
    return '<tr><td class="cle">' + µ._esc(k) + '</td><td>' + µ._esc(_dpApercu(el._state ? el._state[k] : undefined)) + '</td></tr>';
  }).join('');
  var attrs = Array.from(el.attributes || []);
  var lignesAttrs = attrs.map(function(a) {
    return '<tr><td class="cle">' + µ._esc(a.name) + '</td><td>' + µ._esc(a.value) + '</td></tr>';
  }).join('');
  return '<section><h2>Props / variables déclarées</h2>' + (lignesDeclares ? '<table>' + lignesDeclares + '</table>' : '<p class="vide">aucune</p>') + '</section>' +
    '<section><h2>Attributs réels de l\'élément</h2>' + (lignesAttrs ? '<table>' + lignesAttrs + '</table>' : '<p class="vide">aucun</p>') + '</section>';
}

/** Le volet de droite : l'inspecteur d'objet (µ.devObject), ou l'instance sélectionnée en onglets. */
function _dpRenderDetail(hote) {
  if (_dpObjet) {
    hote.innerHTML = '<button type="button" class="lien-retour" data-action="objet-fermer">← fermer l\'inspecteur d\'objet</button><div class="onglet-corps"></div>';
    hote.querySelector('[data-action="objet-fermer"]').addEventListener('click', function() { _dpObjet = null; _dpRender(); });
    µ._mjs_diRender(hote.querySelector('.onglet-corps'), _dpObjet.valeur, { ns: _dpObjet.ns, titre: _dpObjet.titre });
    return;
  }
  var el = _dpSelected;
  if (!el || !el.isConnected) {
    hote.innerHTML = '<p class="aide">Choisis un composant à gauche.<br>Survole une ligne pour le situer dans la page.</p>';
    return;
  }
  var uid = _dpUid(el);
  hote.innerHTML =
    '<div class="di-entete">' + µ._esc(_dpName(el)) + ' · ' + (el._mjs_renderCount || 0) + ' rendu' + ((el._mjs_renderCount || 0) > 1 ? 's' : '') + '</div>' +
    '<div class="onglets" role="tablist">' + _DP_ONGLETS.map(function(o) {
      return '<button type="button" class="onglet" role="tab" aria-selected="' + (o.id === _dpOnglet ? 'true' : 'false') + '" data-onglet="' + o.id + '">' + o.libelle + '</button>';
    }).join('') + '</div><div class="onglet-corps"></div>';

  hote.querySelectorAll('.onglet').forEach(function(b) {
    b.addEventListener('click', function() { _dpOnglet = b.getAttribute('data-onglet'); _dpRender(); });
  });

  var corps = hote.querySelector('.onglet-corps');
  if (_dpOnglet === 'derives') {
    var deps = el._mjs_computedDeps || {};
    var lignes = _dpDeriveKeys(el).map(function(k) {
      var d = deps[k] && deps[k].length ? '← ' + deps[k].map(function(x) { return '$' + x; }).join(', ') : '';
      return '<tr><td class="cle">$' + µ._esc(k) + '</td><td>' + µ._esc(_dpApercu(el._state[k])) + '</td><td class="deps">' + µ._esc(d) + '</td></tr>';
    }).join('');
    corps.innerHTML = '<section><h2>Dérivés et leurs dépendances</h2>' + (lignes ? '<table>' + lignes + '</table>' : '<p class="vide">aucun dérivé</p>') + '</section>';
  } else if (_dpOnglet === 'liaisons') {
    var lignesL = el._mjs_effectsByVar ? Object.keys(el._mjs_effectsByVar).sort().map(function(k) {
      return '<tr><td class="cle">$' + µ._esc(k) + '</td><td>' + el._mjs_effectsByVar[k].length + ' liaison' + (el._mjs_effectsByVar[k].length > 1 ? 's' : '') + '</td></tr>';
    }).join('') : '';
    corps.innerHTML = '<section><h2>Ce que chaque variable met à jour</h2>' + (lignesL ? '<table>' + lignesL + '</table>' : '<p class="vide">aucune liaison</p>') + '</section>';
  } else if (_dpOnglet === 'contexte') {
    // Deux moitiés, parce que ce sont deux questions différentes : « qu'est-ce que CE composant
    // met à disposition de sa descendance » (sa propre Map `_mjs_contexts`) et « qu'est-ce qu'il
    // REÇOIT, et de qui » (remontée `parentNode || host || getRootNode().host`, exactement le
    // chemin de `_mjs_getContext`, cf. mjs_element.ts). Sans la seconde, l'onglet reste vide sur
    // toute feuille de l'arbre — c'est-à-dire précisément là où on se demande d'où vient `§x`.
    corps.innerHTML = '<section><h2>Posés ici</h2><div class="ctx-poses"></div></section>' +
      '<section><h2>Reçus d\'un ancêtre</h2><div class="ctx-recus"></div></section>';
    µ._mjs_diRender(corps.querySelector('.ctx-poses'), el._mjs_contexts || {}, { ns: 'ctx#' + uid, videTexte: 'aucun contexte posé par ce composant' });
    var recus = {}, vus = {}, courant = el.parentNode || el.host || (el.getRootNode && el.getRootNode().host);
    while (courant) {
      if (courant._mjs_contexts) courant._mjs_contexts.forEach(function(v, k) {
        // le PLUS PROCHE l'emporte, comme la résolution réelle : on ne réécrit jamais une clé déjà vue
        if (!vus[k]) { vus[k] = true; recus['§' + k + '  ← ' + _dpName(courant)] = v; }
      });
      courant = courant.parentNode || courant.host || (courant.getRootNode && courant.getRootNode().host);
    }
    µ._mjs_diRender(corps.querySelector('.ctx-recus'), recus, { ns: 'ctxr#' + uid, videTexte: 'aucun contexte reçu' });
  } else if (_dpOnglet === 'props') {
    corps.innerHTML = _dpOngletProps(el);
  } else if (_dpOnglet === 'style') {
    corps.innerHTML = _dpOngletStyle(el);
  } else {
    var permis = new Set(_dpEtatKeys(el));
    µ._mjs_diRender(corps, el._state || {}, {
      ns: 'etat#' + uid,
      filtrerRacine: function(k) { return permis.has(k); },
      triRacine: function(a, b) { return a < b ? -1 : a > b ? 1 : 0; },
      onWriteRoot: function(k, v) { el._set(k, v); return true; },
      videTexte: 'aucune variable d\'état'
    });
  }
}

function _dpOuvrir() {
  _dpFocusPrecedent = document.activeElement;
  _dpHost = document.createElement('div');
  _dpHost.setAttribute('data-mjs-devpanel', '');
  _dpRoot = _dpHost.attachShadow({ mode: 'open' });
  document.body.appendChild(_dpHost);
  _dpGeoRelire();   // relecture PARESSEUSE du stockage (jamais au chargement du module) — puis borne
  _dpGeoBorner();   // la fenêtre a pu changer de taille depuis la dernière lecture de `_dpGeo`
  _dpRender();
  var panneauEl = _dpRoot.querySelector('.panneau');
  if (panneauEl && panneauEl.focus) panneauEl.focus();
  document.addEventListener('keydown', _dpEchap);
  // rafraîchissement doux : le panneau doit refléter la page sans la ralentir
  _dpTimer = setInterval(_dpTick, 700);
}

function _dpFermer() {
  clearInterval(_dpTimer); _dpTimer = null;
  _dpLibererEspace();   // la page retrouve son bas AVANT que le panneau ne disparaisse
  _dpGlissement = null;   // Échap ou fermeture programmatique en plein glissement : plus de pointerup à attendre
  document.removeEventListener('keydown', _dpEchap);
  _dpSurligner(null);
  if (_dpHighlight) { _dpHighlight.remove(); _dpHighlight = null; }
  _dpHost.remove(); _dpHost = null; _dpRoot = null;
  _dpObjet = null;
  if (_dpFocusPrecedent && _dpFocusPrecedent.focus && document.contains(_dpFocusPrecedent)) _dpFocusPrecedent.focus();
  _dpFocusPrecedent = null;
}

function _dpEchap(e) {
  if (e.key === 'Escape' || e.code === 'Escape') { e.preventDefault(); µ.devPanel(false); }
}

/**
 * Ouvre, ferme ou bascule le panneau. `µ.devPanel()` bascule, `µ.devPanel(true)` ouvre,
 * `µ.devPanel(false)` ferme. `µ.devPanel(sélecteurCss)` ouvre (si besoin) et sélectionne le
 * premier composant que le sélecteur désigne, cf. `_dpResoudre` (descend `µ.instances`, déjà
 * plat vis-à-vis des frontières Shadow DOM). Absent des builds de production : le fichier n'y
 * est pas.
 */
µ.devPanel = function(arg) {
  if (typeof arg === 'string') {
    if (!_dpHost) _dpOuvrir();
    var cible = _dpResoudre(arg);
    if (cible) { _dpSelected = cible; _dpObjet = null; }
    _dpRender();
    return true;
  }
  var estOuvert = !!_dpHost;
  var vise = arg === undefined ? !estOuvert : !!arg;
  if (vise === estOuvert) return vise;
  if (!vise) { _dpFermer(); return false; }
  _dpOuvrir();
  return true;
};

/**
 * Ouvre la modale directement sur l'inspecteur d'objets générique (mjs_devinspect), sur
 * `valeur` — `µ.devObject($$panier)` depuis la console. `nom` facultatif devient le titre ;
 * sans lui, un libellé déduit du type (`Array(3)`, `Objet Panier`…). Absente des builds de
 * production, comme le reste du fichier.
 */
µ.devObject = function(valeur, nom) {
  if (!_dpHost) _dpOuvrir();
  µ._mjs_diReset('objet');   // jamais l'état de pli d'un appel précédent sur une AUTRE valeur
  _dpObjet = { valeur: valeur, ns: 'objet', titre: nom || µ._mjs_diApercu(valeur) };
  _dpRender();
  return true;
};

document.addEventListener('keydown', function(e) {
  var touche = (µ.config && µ.config.devPanelKey) || 'Space';
  if (e.ctrlKey && e.shiftKey && e.code === touche) {
    e.preventDefault();
    µ.devPanel();
  }
});

if (µ.debug) console.log("🔍 [ModularJS] panneau d'inspection armé — Ctrl+Shift+Espace, ou µ.devPanel()");
