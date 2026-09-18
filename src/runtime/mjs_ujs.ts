// mjs_ujs.coffee
// LRU borné (µ.LRUCache, défini dans mjs_init) : avant, une Map sans limite
// retenait UN ARBRE DOM COMPLET (composants + shadow + listeners) par page
// visitée, à vie. 10 pages = le confort SPA sans la dérive mémoire.
// >>> extrait-test pageCache-init
µ.pageCache = typeof µ.LRUCache === 'function' ? new µ.LRUCache(10) : new Map();
// <<< extrait-test pageCache-init

// Jeton de séquence anti-course : deux clics rapprochés lançaient deux fetchs
// concurrents, et le DERNIER ARRIVÉ (pas le dernier cliqué) gagnait le DOM —
// avec, avant, un pushState exécuté au retour réseau → URL et contenu
// désynchronisés. Le pushState part désormais AU CLIC (comme Turbo) et tout
// callback périmé est jeté.
µ._mjs_navSeq = 0;

// Abandon RÉEL (pas seulement ignoré) du fetch de navigation précédent :
// AVANT, `_mjs_navSeq` jetait la RÉPONSE périmée mais le TRANSFERT continuait
// (bande passante/serveur sollicités pour rien). Un AbortController PAR
// NAVIGATION, remplacé à CHAQUE nouvelle interception (clic/soumission/
// popstate refetch/lien mjs-method) — le préchargement (_mjs_preloadCache) n'est
// PAS concerné, lui seul. `_request` (mjs_ajax.ts) traite un abandon PILOTÉ
// PAR CE SIGNAL comme un chemin SILENCIEUX (ni erreur console, ni callback
// error) — voir son commentaire.
// >>> extrait-test _mjs_navController
µ._mjs_navController = null;
// <<< extrait-test _mjs_navController
// >>> extrait-test _mjs_abortStaleNav
µ._mjs_abortStaleNav = function() {
  if (µ._mjs_navController) {
    try { µ._mjs_navController.abort(); } catch (e) {}
  }
  µ._mjs_navController = typeof AbortController === 'function' ? new AbortController() : null;
  return µ._mjs_navController;
};
// <<< extrait-test _mjs_abortStaleNav

// Chemin (pathname+search) de la page actuellement AFFICHÉE. Nécessaire au
// popstate pour mettre en cache la page QUITTÉE (window.location a déjà
// changé quand l'événement tire).
µ._mjs_lastUjsPath = window.location.pathname + window.location.search;

// Sauvegarde/restauration du scroll par page (standard Turbo/SvelteKit) :
// le swap manuel du DOM échappe au scrollRestoration natif du navigateur.
// Map SANS BORNE : une session SPA
// longue durée qui visite de nombreuses URLs distinctes (back/forward,
// pagination) accumulait une entrée par page, POUR TOUJOURS — même dérive
// que pageCache/_mjs_preloadCache avant leur passage en LRU. Contrairement à
// pageCache, cette Map n'est PAS purgée en même temps que pageCache s'évince
// (une position de scroll reste utile même après éviction du DOM hiberné :
// le cache-MISS réseau du popstate restaure quand même le scroll une fois
// la page re-fetchée, cf. `_mjs_restoreScroll` plus bas) — borne INDÉPENDANTE,
// large (entrées minuscules : juste 2 nombres par page).
// >>> extrait-test _mjs_scrollPos
µ._mjs_scrollPos = typeof µ.LRUCache === 'function' ? new µ.LRUCache(50) : new Map();
// <<< extrait-test _mjs_scrollPos

// `history.scrollRestoration` n'était
// JAMAIS mis à 'manual' : le commentaire ci-dessus affirmait déjà que le
// natif du navigateur ne convient pas à un swap DOM manuel, mais sans cette
// ligne, il restait actif EN PARALLÈLE de `_mjs_saveScroll`/`_mjs_restoreScroll` —
// sur un retour arrière, le navigateur restaure D'ABORD sa propre position
// mémorisée, puis notre code écrase IMMÉDIATEMENT avec la sienne : un
// double-scroll/flash au lieu d'un seul mouvement net, surtout visible sur
// machine lente si un paint a le temps de se produire entre les deux.
if ('scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

// Éviction LRU du pageCache : l'arbre parqué avait été EXEMPTÉ de destruction
// (hibernation). Abandonné pour de bon, ses teardowns doivent tourner — sinon
// chaque timer posé en @mount fuyait à vie (précisément ce que le LRU borne).
// >>> extrait-test pageCache-onEvict
µ.pageCache.onEvict = function(_path, nodes) {
  var i;
  if (Array.isArray(nodes)) {
    for (i = 0; i < nodes.length; i++) { if (nodes[i] && nodes[i].nodeType === 1) { µ._mjs_destroyEvictedTree(nodes[i]); } }
  } else if (nodes && nodes.nodeType === 1) {
    // défense : une valeur élément seul (ancien format, ou appelant externe) reste tolérée.
    µ._mjs_destroyEvictedTree(nodes);
  }
};
// <<< extrait-test pageCache-onEvict
µ._mjs_saveScroll = function(path) {
  µ._mjs_scrollPos.set(path, [window.scrollX, window.scrollY]);
};
// >>> extrait-test _mjs_restoreScroll
µ._mjs_restoreScroll = function(path) {
  var p, x, y;
  p = µ._mjs_scrollPos.get(path);
  x = p ? p[0] : 0;
  y = p ? p[1] : 0;
  // appelé JUSTE APRÈS un `replaceWith`
  // (cache-hit) ou la fin d'un fetch réseau (cache-miss) : dans le cas
  // cache-miss surtout, les composants du nouvel arbre viennent de se
  // connecter et peuvent ne pas avoir terminé leur rendu initial (effets
  // réactifs, sous-composants) — la page n'a pas encore sa hauteur finale, et
  // `scrollTo(x, y)` se fait CLAMPER à la hauteur (trop petite) du moment,
  // au lieu de la position réellement mémorisée. Report d'une frame (même
  // idiome que `_mjs_scanEager` plus bas) : laisse le navigateur peindre le
  // contenu inséré avant de scroller.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(function() { window.scrollTo(x, y); });
  } else {
    window.scrollTo(x, y);
  }
};
// <<< extrait-test _mjs_restoreScroll

µ.realTarget = function(e) {
  if (typeof e.composedPath === 'function') {
    return e.composedPath()[0];
  } else {
    return e.target;
  }
};

// point d'accroche remplaçable de la confirmation @confirm (mjs-confirm) — une
// modale personnalisée réassigne µ.confirm(message, élément) directement : cette
// réassignation PRIME TOUJOURS (elle écrase la fonction par défaut ci-dessous),
// quelle que soit µ.config.confirm ; retour booléen synchrone OU promesse de
// booléen (thenable, cf. gates clic/submit plus bas). Le défaut, lui, ROUTE par
// µ.config.confirm (mjs_init.ts) : false (ou absent/null/undefined) → window.confirm
// natif, accepté d'office si absent (comportement historique conservé À L'IDENTIQUE) ;
// true → modale maison µ.modal.fire (mjs_modal.ts, module optionnel 'modal' — cf.
// bundler/index.ts CANONICAL) ; µ.modal absent du build (sélection `runtime` explicite
// sans 'modal') → repli natif défensif, jamais un crash. Toute AUTRE valeur (ancien
// branchement 'sweetalert2'/classe-objet custom, RETIRÉ — plus de porte de sortie vers
// un adaptateur externe) → repli natif, avec UN SEUL µ.warn par session (pas un par clic).
// >>> extrait-test confirm-default
var _confirmCfgWarned = false;
µ.confirm = function(message, el) {
  var v = µ.config && µ.config.confirm;
  // forme OBJET (mjs-confirm=text/ok/cancel, cf. transpiler @confirm=objet) : JSON STRICT posé
  // par le compilateur, reconnu ICI à son premier caractère (une accolade ouvrante). Parse SOUS TRY :
  // un texte brut qui commence banalement par une accolade (jamais produit par notre compilo, mais un
  // back qui poserait l'attribut À LA MAIN reste possible) retombe simplement sur le texte tel quel,
  // jamais un crash.
  // Une réassignation DIRECTE de µ.confirm par l'application (prime toujours, cf. bandeau ci-dessus)
  // reçoit TOUJOURS `message` BRUT (chaîne ou JSON non parsé) — ce parsing n'existe que dans cette
  // implémentation par défaut.
  var text = message, confirmButtonText, cancelButtonText;
  // code 123 = accolade ouvrante (jamais le caractère littéral ICI : ce fichier s'extrait par
  // comptage naïf d'accolades dans les tests, cf. tests/ujs-*.test.ts — un caractère isolé,
  // même en commentaire, fausserait le compte et ferait déborder l'extraction).
  if (typeof message === 'string' && message.charCodeAt(0) === 123) {
    try {
      var parsed = JSON.parse(message);
      if (parsed && typeof parsed === 'object') {
        text = parsed.text;
        if (parsed.ok) { confirmButtonText = parsed.ok; }
        if (parsed.cancel) { cancelButtonText = parsed.cancel; }
      }
    } catch (e) { /* texte brut : JSON invalide, `text` reste `message` tel quel */ }
  }
  if (v === true) {
    if (µ.modal && typeof µ.modal.fire === 'function') {
      var opts = { text: text, icon: 'question', showCancelButton: true };
      if (confirmButtonText) { opts.confirmButtonText = confirmButtonText; }
      if (cancelButtonText) { opts.cancelButtonText = cancelButtonText; }
      return µ.modal.fire(opts).then(function(r) { return !!r.isConfirmed; });
    }
    if (!_confirmCfgWarned) {
      _confirmCfgWarned = true;
      µ.warn('[ModularJS] µ.config.confirm = true mais µ.modal est absent (module \'modal\' non inclus dans `runtime`) — repli sur window.confirm.');
    }
    return typeof window.confirm === 'function' ? window.confirm(text) : true;
  }
  if (v != null && v !== false && !_confirmCfgWarned) {
    _confirmCfgWarned = true;
    µ.warn('[ModularJS] µ.config.confirm attend désormais true/false (l\'ancien \'sweetalert2\'/objet n\'existe plus) — repli sur window.confirm.');
  }
  return typeof window.confirm === 'function' ? window.confirm(text) : true;
};
// <<< extrait-test confirm-default

// chemin (pathname+search) de la
// destination FINALE après tout redirect serveur suivi NATIVEMENT par fetch
// (`finalUrl` = response.url). Repli sur `fallback` si absent ou cross-origin
// (on ne pilote pas une URL hors de notre origine). Partagé clic/popstate.
// >>> extrait-test _mjs_finalPathFor
µ._mjs_finalPathFor = function(finalUrl, fallback) {
  if (!finalUrl) { return fallback; }
  try {
    var u = new URL(finalUrl, window.location.href);
    if (u.origin !== window.location.origin) { return fallback; }
    return u.pathname + u.search;
  } catch (e) { return fallback; }
};
// <<< extrait-test _mjs_finalPathFor

// NAVIGATION COMPLÈTE de repli (clic cross-page) : l'URL a DÉJÀ été poussée au
// clic — si la destination EST l'URL courante et porte un hash, réassigner
// `location.href` ne recharge RIEN (navigation same-document : le navigateur
// vise juste l'ancre) → page inchangée en silence. Seul `reload()` force alors
// un vrai chargement ; sinon, navigation dure classique.
// >>> extrait-test _mjs_hardNav
µ._mjs_hardNav = function(destination) {
  var url, href;
  try { url = new URL(destination, window.location.href); href = url.href; } catch (e) { url = null; href = destination; }
  // même garde de protocole que µ._mjs_navApplyJson, posée ICI en défense en profondeur
  // (µ._mjs_hardNav a d'autres appelants, cf. le repli cross-page ci-dessus) : seul http(s) part vers
  // location.href — une destination `javascript:`/`data:`/`blob:`… EXÉCUTAIT le script au lieu de
  // naviguer (prouvé Chromium, régression).
  if (url && url.protocol !== 'http:' && url.protocol !== 'https:') {
    µ.warn('[µ.UJS] navigation dure refusée, protocole non http/https : '+ destination);
    return;
  }
  if (href === window.location.href) { return window.location.reload(); }
  return window.location.href = destination;
};
// <<< extrait-test _mjs_hardNav

// FOCUS APRÈS SWAP (accessibilité, cf. Turbo/SvelteKit) : un lecteur d'écran
// ne suit PAS un remplacement de contenu sans un focus explicite — sans lui,
// le focus reste sur l'ancien lien cliqué (détaché du DOM) ou nulle part.
// Traverse aussi les shadow roots (`_shadow`, même convention que
// `µ._mjs_destroyEvictedTree`, mjs_init.ts) : le contenu MJS vit en shadow,
// invisible à un `querySelector` natif depuis la lumière — d'où un walk dédié
// plutôt qu'un simple `root.querySelector(sel)`. Partagé clic/popstate/submit.
// >>> extrait-test _mjs_deepFind
µ._mjs_deepFind = function(node, selector, depth) {
  if (!node || depth > 50) { return null; }
  if (typeof node.matches === 'function' && node.matches(selector)) { return node; }
  var kids = node.children, i, found;
  if (kids) {
    for (i = 0; i < kids.length; i++) {
      found = µ._mjs_deepFind(kids[i], selector, depth + 1);
      if (found) { return found; }
    }
  }
  if (node._shadow && node._shadow !== node && node._shadow.children) {
    for (i = 0; i < node._shadow.children.length; i++) {
      found = µ._mjs_deepFind(node._shadow.children[i], selector, depth + 1);
      if (found) { return found; }
    }
  }
  return null;
};
// <<< extrait-test _mjs_deepFind
// Cascade (1er trouvé gagne) : [autofocus] du nouveau contenu > premier <h1>
// (pose tabindex="-1" s'il n'en a pas, pour le rendre focusable SANS entrer
// dans l'ordre de tabulation naturel) > le conteneur lui-même (idem). Jamais
// au chargement initial (pas de swap = pas d'appel — cf. call-sites, tous
// dans un callback de navigation ujs). `{preventScroll:true}` : la
// restauration de scroll (`_mjs_restoreScroll`, plus haut) gère déjà la position —
// un `focus()` natif re-scrollerait sinon l'élément dans la vue, parasite.
// >>> extrait-test _mjs_focusAfterSwap
µ._mjs_focusAfterSwap = function(root) {
  if (!root) { return; }
  var target = µ._mjs_deepFind(root, '[autofocus]', 0);
  if (!target) {
    target = µ._mjs_deepFind(root, 'h1', 0);
    if (target && typeof target.hasAttribute === 'function' && !target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
    }
  }
  if (!target) {
    target = root;
    if (typeof target.hasAttribute === 'function' && !target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
    }
  }
  if (target && typeof target.focus === 'function') {
    target.focus({ preventScroll: true });
  }
};
// <<< extrait-test _mjs_focusAfterSwap

// ──────────────────────────────────────────────────────────────────────────
// ZONE DE NAVIGATION — une navigation remplace le
// CONTENU d'un contenant. Le contenant = la clé `target` de la fiche JSON
// (sélecteur CSS) si elle est présente et résolue, sinon `<body>` — la
// cascade #app-root/mjs-child disparaît. `method` ('update' défaut/'append'/'replace',
// cf. µ._mjs_navMethodOf/µ._mjs_navInstallNodes plus bas) décide QUOI faire du contenant,
// cette fonction ne fait que le TROUVER. `target` introuvable (sélecteur
// invalide compris, cf. try/catch — un CSS cassé ne doit jamais faire jeter la
// navigation) retombe sur la DERNIÈRE zone suivie (`µ._mjs_navZone`, posée par
// µ._mjs_navTrackZone plus bas) si elle est encore connectée : un `method:
// 'replace'` a pu la faire céder sa place au module lui-même, qui reste alors
// la cible tant qu'il reste monté ; sinon `<body>` + avertissement (une fois
// par sélecteur distinct, diagnostic dev hors catalogue i18n, jamais montré à
// l'utilisateur final). `doc` (défaut `document`) : LE MÊME calcul s'applique
// côté RÉPONSE (document parsé par DOMParser, cf. call-sites plus bas) —
// l'avertissement, lui, ne compte QUE pour le document COURANT (celui
// réellement affiché), jamais pour une réponse parsée hors-document.
// >>> extrait-test helpers-navigation
// >>> extrait-test _mjs_navMountZone
µ._mjs_navMountZone = function(doc, target) {
  var el;
  doc = doc || document;
  if (!target) { return { zone: doc.body, mode: 'body', target: null }; }
  try { el = doc.querySelector(target); } catch (e) { el = null; }
  if (el) { return { zone: el, mode: 'target', target: target }; }
  if (doc === document && µ._mjs_navZone && µ._mjs_navZone.isConnected && µ._mjs_navZone !== doc.body) {
    return { zone: µ._mjs_navZone, mode: 'replaced', target: target };
  }
  if (doc === document && !Object.prototype.hasOwnProperty.call(µ._mjs_navTargetWarned, target)) {
    µ._mjs_navTargetWarned[target] = true;
    µ.warn("[µ.UJS] cible de navigation '" + target + "' introuvable dans la page — contenu de <body> remplacé.");
  }
  return { zone: doc.body, mode: 'body', target: null };
};
// <<< extrait-test _mjs_navMountZone
µ._mjs_navTargetWarned = {};         // sélecteurs `target` déjà signalés introuvables dans la PAGE (une fois chacun)
µ._mjs_navRespTargetWarned = {};     // sélecteurs `target` déjà signalés introuvables dans la RÉPONSE (une fois chacun)
µ._mjs_navMethodWarned = {};         // valeurs `method` déjà signalées inconnues (une fois chacune)
µ._mjs_navReplaceBodyWarned = false; // 'replace' dégradé sur <body> (une fois, toujours le même cas)

// ÉVÉNEMENTS DE CYCLE DE NAVIGATION — before-visit/visit/load (cf. leurs sites
// d'émission plus bas : handlers clic/popstate, µ._mjs_navDispatch, µ._mjs_navApplyJson, et le premier
// chargement en fin de fichier). Helper MUTUALISÉ, MÊME convention que l'événement before-cache (
// juste plus bas) : émis sur `document`, `bubbles: true`, charge utile dans `detail`, nom préfixé
// `mjs:`. Enveloppé (try/catch) : ni un écouteur qui jette, ni l'absence de `document.dispatchEvent`/
// `CustomEvent` (harnais de test minimal), ne doivent jamais empêcher une navigation — un environnement
// dégradé rend donc TOUJOURS `true`. `cancelable` : SEUL `before-visit` l'est — `false` renvoyé si et
// seulement si un écouteur a appelé `preventDefault()` sur CET événement-là.
µ._mjs_navEmit = function(name, detail, cancelable) {
  var ev;
  try {
    ev = new CustomEvent('mjs:' + name, { detail: detail, bubbles: true, cancelable: !!cancelable });
    document.dispatchEvent(ev);
    return !(cancelable && ev.defaultPrevented);
  } catch (e) {}
  return true;
};

// NORMALISATION detail.path/url DES 3 ÉVÉNEMENTS DE CYCLE —
// `response.url` (`finalUrl`, mjs_ajax.ts), `link.href` et le repli `window.location.href` d'un
// formulaire sans `action` sont TOUJOURS ABSOLUS par construction (Fetch API / DOM) : sans ce filtre,
// `detail.path`/`url` fuyaient l'origine (`http://mon-site.example/produits/42` au lieu de
// `/produits/42`) — l'exemple canonique de la doc (`analytics.page(e.detail.path)`) enregistrait alors
// une URL absolue. UN SEUL point de passage pour les 13 sites d'émission (2 before-visit/3 visit/8
// load, dont l'initial) : plus aucun site ne compose `path`/`url` à la main. Idempotent sur une entrée
// déjà relative. Hôte DIFFÉRENT → chaîne rendue TELLE QUELLE, jamais rabotée à l'aveugle (on ne
// prétend rien savoir d'une URL hors de notre hôte). Enveloppé (try/catch) : `window.location`/`URL`
// inexploitables (harnais de test minimal) ne doivent jamais faire tomber l'émission — repli sur la
// chaîne brute, comme µ._mjs_finalPathFor plus haut.
µ._mjs_navEmitPaths = function(u) {
  var abs;
  try {
    abs = new URL(u, window.location.href);
    // host (hôte+port), PAS origin (qui inclut le schéma) : un http→https sur le MÊME hôte
    // (upgrade HSTS/force_ssl, dev→prod) doit rester rabotable ; µ._mjs_finalPathFor, lui, PILOTE une
    // navigation réelle (pushState/assign) et reste strict sur le schéma — volontairement pas touché.
    if (abs.host !== window.location.host) { return { path: u, url: u }; } // autre hôte : on ne rabote rien
    return { path: abs.pathname + abs.search, url: abs.pathname + abs.search + abs.hash };
  } catch (e) {}
  return { path: u, url: u }; // harnais sans window.location exploitable : chaîne brute
};

// NORMALISATION PARTAGÉE — quatre valeurs de
// `method` : 'replace' et 'append' tels quels, 'none' tel quel (« ne bouge pas » — la page
// affichée reste affichée, cf. µ._mjs_navInstallNodes plus bas), tout le reste (absent/vide/'update'/
// inconnu) devient 'update' — l'ancien défaut implicite ('append', qui en réalité VIDAIT puis
// réinjectait) change donc de NOM sans changer de comportement ; le VRAI `append` (ajoute sans rien
// retirer) est désormais une valeur à part entière, cf. µ._mjs_navInstallNodes plus bas. Valeur inconnue →
// averti UNE FOIS par valeur DISTINCTE (jamais par appel), diagnostic dev hors catalogue i18n comme les
// autres µ.warn de ce fichier. Utilisée par le chemin JSON (µ._mjs_navApplyJson) ET le chemin HTML
// (X-MJS-Method, cf. les 3 sites de swap plus bas).
µ._mjs_navMethodOf = function(raw) {
  if (raw === 'replace') { return 'replace'; }
  if (raw === 'append') { return 'append'; }
  if (raw === 'none') { return 'none'; }
  if (raw == null || raw === '' || raw === 'update') { return 'update'; }
  if (!Object.prototype.hasOwnProperty.call(µ._mjs_navMethodWarned, raw)) {
    µ._mjs_navMethodWarned[raw] = true;
    µ.warn("[µ.UJS] method '" + raw + "' inconnu dans la fiche de navigation — 'update' appliqué.");
  }
  return 'update';
};

// POLITIQUE DE CACHE PAR PAGE — trois valeurs : 'cache-first' (défaut, la
// page hiberne normalement) · 'revalidate' (affichée depuis le cache puis vérifiée en fond, cf.
// µ._mjs_navRevalidate plus bas) · 'no-cache' (jamais archivée, cf. µ._mjs_navHibernate plus bas). MÊME
// PATRON que µ._mjs_navMethodOf juste au-dessus : valeur inconnue → 'cache-first' + averti UNE FOIS par
// valeur DISTINCTE. Trois canaux d'entrée (précédence en-tête > balise > défaut, cf. µ._mjs_navCacheOf) :
// chemin JSON (clé `cache` de la fiche, lue par µ._mjs_navApplyJson), chemin HTML (en-tête X-MJS-Cache,
// décodé dans mjs_ajax.ts à côté de target/method) et son repli balise (<meta name="mjs-cache">,
// cf. µ._mjs_navCacheOf). `null`/absent → 'cache-first' SANS avertissement (comme method/'update').
µ._mjs_navCacheWarned = {}; // valeurs `cache` déjà signalées inconnues (une fois chacune)
µ._mjs_navCachePolicyOf = function(raw) {
  if (raw === 'cache-first' || raw === 'revalidate' || raw === 'no-cache') { return raw; }
  if (raw == null || raw === '') { return 'cache-first'; }
  if (!Object.prototype.hasOwnProperty.call(µ._mjs_navCacheWarned, raw)) {
    µ._mjs_navCacheWarned[raw] = true;
    µ.warn("[µ.UJS] cache '" + raw + "' inconnu dans la fiche de navigation — 'cache-first' appliqué.");
  }
  return 'cache-first';
};

// RÉSOLUTION CHEMIN HTML — en-tête `headerVal` (nav.cache, déjà décodé par mjs_ajax.ts) PRIME
// sur la balise <meta name="mjs-cache"> lue DANS `doc`, le document PARSÉ DE LA RÉPONSE — JAMAIS
// `document.head` : cette balise est HORS du périmètre piloté par µ._mjs_navHeadKeyOf (cf. son
// bandeau plus bas) — une balise de PROTOCOLE, pas une métadonnée de page — `document.head` ne la
// voit donc JAMAIS changer au swap et refléterait encore la PREMIÈRE page chargée — y lire la balise
// serait un bogue silencieux. `doc.querySelector` gardé par `typeof` : un `doc` minimal (harnais de
// test, réponse sans <head> exploitable) reste toléré.
µ._mjs_navCacheOf = function(doc, headerVal) {
  var raw, meta;
  raw = headerVal;
  if (!raw && doc) {
    meta = typeof doc.querySelector === 'function' ? doc.querySelector('meta[name="mjs-cache"]') : null;
    raw = meta && typeof meta.getAttribute === 'function' ? meta.getAttribute('content') : null;
  }
  return µ._mjs_navCachePolicyOf(raw);
};

// RECHARGEMENT DUR (`X-MJS-Reload`/`reload`) — « j'ai traité, recharge tout » :
// vocabulaire manquant au protocole de navigation, repris d'un `AjaxController` Rails utilisé
// avant MJS (`ajax_complete: :reload`). MÊME PATRON que µ._mjs_navMethodOf/µ._mjs_navCachePolicyOf
// juste au-dessus : normalisation d'un côté (µ._mjs_navReloadAsked), exécution de l'autre
// (µ._mjs_navHardReload) — mais AUCUN vocabulaire fermé à défendre ici (contrairement à `method`/`cache`),
// donc AUCUN avertissement sur une valeur inattendue : un serveur qui pose `X-MJS-Reload: 1` n'a rien
// de mal formé à se faire signaler.
//
// µ._mjs_navReloadAsked(raw) — vrai si `raw === true` (booléen, chemin JSON) ou une chaîne NON VIDE dont
// la valeur rognée en minuscules n'est ni '0' ni 'false' ; tout le reste (null/undefined/''/'0'/
// 'false'/false/un nombre) vaut faux.
µ._mjs_navReloadAsked = function(raw) {
  var v;
  if (raw === true) { return true; }
  if (typeof raw !== 'string') { return false; }
  v = raw.trim().toLowerCase();
  if (v === '') { return false; }
  return v !== '0' && v !== 'false';
};

// µ._mjs_navHardReload(dest) — POURQUOI la distinction assign/reload : `window.location.assign` sur
// l'adresse COURANTE ne garantit RIEN — une URL identique à un fragment près (même pathname+search
// que celle déjà affichée, SEUL le hash change) est une navigation SAME-DOCUMENT PAR SPÉCIFICATION
// HTML (le navigateur vise juste l'ancre) : AUCUNE requête ne part, la page ne recharge jamais.
// `window.location.reload()`, lui, force TOUJOURS un aller-retour réseau.
// la comparaison portait sur `href` EN ENTIER (fragment
// compris) : prouvé dans un Chromium réel (Playwright), `assign()` vers une destination qui ne
// diffère de l'adresse affichée QUE par le fragment était un no-op silencieux — un back qui répond
// `X-MJS-Reload` en redirigeant vers `/checkout#confirmation` depuis `/checkout` n'obtenait donc
// JAMAIS le rechargement promis. Comparaison désormais sur la PARTIE DOCUMENT SEULE (origin+
// pathname+search, hash exclu) : partie document DIFFÉRENTE ⇒ `assign` (repart forcément au
// serveur, comme avant) ; partie document IDENTIQUE ET fragment DIFFÉRENT ⇒ le fragment demandé est
// posé D'ABORD (`window.location.hash = u.hash`, mise à jour SYNCHRONE de `window.location.href` —
// un `assign` ensuite serait de nouveau same-document, cf. ci-dessus), PUIS `reload()` force le
// vrai aller-retour ; tout identique ⇒ `reload()` seul, comme avant. Résolution en absolu (`new
// URL`) dans un try/catch : une entrée qui ne résout pas replie directement sur `reload()`, jamais un
// throw qui remonterait jusqu'à l'appelant. Gardé par `typeof window !== 'undefined' && window.location`
// (harnais de test minimal) : sinon ne fait rien, aucun crash.
µ._mjs_navHardReload = function(dest) {
  var u, sameDoc;
  if (typeof window === 'undefined' || !window.location) { return; }
  try {
    u = new URL(dest, window.location.href);
  } catch (e) {
    window.location.reload();
    return;
  }
  sameDoc = u.origin === window.location.origin && u.pathname === window.location.pathname && u.search === window.location.search;
  if (!sameDoc) {
    window.location.assign(u.href);
    return;
  }
  if (u.hash !== window.location.hash) { window.location.hash = u.hash; } // même document, fragment différent : posé AVANT le reload (sinon un assign resterait same-document)
  window.location.reload();
};

// OPT-OUT PAR ÉLÉMENT (`@noUJS` → mjs-no-ujs) : désactive l'interception UJS pour CET élément
// précis (lien ou formulaire) — la navigation native reprend la main. Nom UNIQUE :
// l'ancien `mjs-no-ajax` (jamais publié) a été purgé, deux noms pour une seule chose = dette.
// Placé dans ce bandeau (ZONE DE NAVIGATION) plutôt qu'à côté de µ._mjs_isPreloadableLink, son autre
// consommateur : les handlers clic/submit, PAS le préchargement, en dépendent en premier lieu.
// >>> extrait-test _mjs_navNoUjs
µ._mjs_navNoUjs = function(el) {
  return !!el && typeof el.hasAttribute === 'function' && el.hasAttribute('mjs-no-ujs');
};
// <<< extrait-test _mjs_navNoUjs

// `@noUJS` + `@method` sur le MÊME élément — combinaison contradictoire et SILENCIEUSE :
// l'opt-out rend la main au navigateur, qui ne sait suivre un lien qu'en GET ; le verbe est perdu
// sans trace. Averti UNE FOIS PAR ÉLÉMENT (drapeau porté par le nœud, pas par une clé globale :
// deux liens distincts méritent chacun leur avertissement), juste avant le retour de l'opt-out.
// >>> extrait-test _mjs_navWarnNoUjsMethod
µ._mjs_navWarnNoUjsMethod = function(el) {
  if (!el || el._mjs_mjsNoUjsMethodWarned || typeof el.getAttribute !== 'function' || !el.getAttribute('mjs-method')) { return; }
  el._mjs_mjsNoUjsMethodWarned = true;
  µ.warn('[µ.UJS] @method="' + el.getAttribute('mjs-method') + '" ignoré — @noUJS rend la navigation native, et le navigateur ne sait faire qu\'un GET sur un lien. Retire l\'un des deux.');
};
// <<< extrait-test _mjs_navWarnNoUjsMethod

// SUIVI DE ZONE — dernier nœud installé en mode 'replace', sur
// les DEUX chemins depuis que `target`/`method` voyagent aussi en en-têtes HTTP (chemin HTML) et plus
// seulement dans la fiche JSON. `mode` null → aucun suivi (contenant intact, jamais remplacé).
µ._mjs_navZone = null;
µ._mjs_navZoneMode = null;
// >>> extrait-test _mjs_navTrackZone
µ._mjs_navTrackZone = function(el, mode) { µ._mjs_navZone = el; µ._mjs_navZoneMode = mode; };
// <<< extrait-test _mjs_navTrackZone

// CONTENANT COURANT — celui que le dernier montage a REMPLI (posé par µ._mjs_zoneFill, seul
// point d'entrée de tous les remplissages : JSON, HTML, cache-hit, panneau 404). C'est LUI que
// le cache de pages hiberne et restaure. Sans cet état, un montage ciblé (`target`) aurait
// photographié les enfants de <body> — habillage compris — tout en ne remplaçant que le contenu
// de la cible : contenu restauré au mauvais endroit au Précédent, et drapeau d'hibernation posé
// sur des nœuds restés VIVANTS (composants exemptés de destruction à vie).
// `null` → <body> (aucun montage encore, ou contenant disparu du DOM) ; `false` → dernier
// montage en 'replace' (le contenant a cédé sa place : plus de contenant stable où reposer le
// contenu quitté, cette page ne participe donc pas au cache).
µ._mjs_navContainer = null;
// >>> extrait-test _mjs_navCacheZone
µ._mjs_navCacheZone = function() {
  if (µ._mjs_navContainer === false) { return null; }
  if (µ._mjs_navContainer && µ._mjs_navContainer.isConnected) { return µ._mjs_navContainer; }
  return document.body;
};
// <<< extrait-test _mjs_navCacheZone

// HIBERNATION EN COURS — page tout juste photographiée par la navigation EN VOL (posé aux 3
// sites qui appellent `µ.pageCache.set`, plus bas : popstate/clic/soumission) : `{ path, nodes }` tant
// qu'un `method: 'append'` peut encore avoir besoin de la dé-hiberner (cf. µ._mjs_navDropHibernation/
// µ._mjs_zoneAppend) ; `null` dès que l'hibernation a été consommée normalement (µ._mjs_zoneFill, un swap
// classique qui vide effectivement le contenant) ou qu'aucune navigation n'est en vol.
µ._mjs_navHibernated = null;

// POLITIQUE DE CACHE DE LA PAGE AFFICHÉE — décrit la page qu'on est en train de MONTRER, posée
// par le chemin qui l'installe (à côté de chaque µ._mjs_navTrackZone : les 3 branches de µ._mjs_navInstallNodes
// plus bas, et les 2 restaurations cache-hit synchrones dans les handlers popstate/clic) ; consultée
// par µ._mjs_navHibernate au moment de la QUITTER. `null` (aucune installation encore, ou µ._mjs_navInstallNodes
// jamais appelé avec un `cache` connu) équivaut à 'cache-first' — repli sûr, comportement historique.
µ._mjs_navCachePolicy = null;

// ──────────────────────────────────────────────────────────────────────────
// GESTION DU <HEAD> AU FIL DE LA NAVIGATION — un swap UJS échange le CONTENU
// du contenant (cf. bandeau ZONE DE NAVIGATION plus haut) mais laissait jusqu'ici le <head> intact :
// titre d'onglet et métadonnées figés sur la toute première page chargée. Périmètre PILOTÉ,
// VOLONTAIREMENT FERMÉ (µ._mjs_navHeadKeyOf juste en dessous en dresse la liste EXACTE) — SEULS le
// <title>, une poignée de <meta> (description/keywords/robots/author/og:*/twitter:*/article:*) et
// <link rel="canonical"> traversent une navigation. NI les styles NI les scripts : un
// <link rel="stylesheet"> retiré puis réinséré est RE-ÉVALUÉ par le navigateur (clignotement à
// CHAQUE navigation), un <script> réinséré REJOUE son code (écouteurs posés en double) — c'est très
// exactement là que Turbo a ses bogues les plus subtils, on ne rouvre pas ce dossier ici. Les styles
// des composants MJS ne sont PAS concernés par cette exclusion : ils vivent dans le SHADOW ROOT du
// composant, jamais dans <head>, ils arrivent et repartent AVEC lui — un swap de contenant les gère
// déjà tout seul, sans avoir besoin de ce bandeau.
// Réconciliation PAR CLÉ et SUR PLACE (jamais un vidage/réinsertion en bloc) : le nœud EXISTANT
// survit tant que la page qui arrive porte encore la même clé (seul son `content`/`href` est
// recopié), il n'est retiré QUE si la page qui arrive ne la déclare plus (sinon l'og:image d'une
// fiche produit traînerait jusque sur la page contact) — jamais de re-requête, jamais de flash,
// contrairement à ce qu'un retrait/réinsertion d'un <link rel="stylesheet"> provoquerait.
// Un <head> REÇU VIDE (fixture de test sans <head>, réponse dégradée) ne déclenche RIEN : vide veut
// dire « cette réponse ne porte aucune information de tête », jamais « efface tout ce qui existe ».
// Opt-out global : `µ.config.navHead = false` désactive tout ce bandeau, comportement identique à
// à l'origine (seul le contenant change, la tête n'est plus jamais touchée).
// ──────────────────────────────────────────────────────────────────────────

// PÉRIMÈTRE FERMÉ — rend la clé de réconciliation d'un élément de <head>, ou `null` s'il est HORS
// périmètre (auquel cas µ._mjs_navHeadReconcile ne le touche jamais, ni en retrait ni en recopie).
// Défensif comme le reste du fichier : un nœud sans `getAttribute`, ou qui n'est pas un ÉLÉMENT
// (`nodeType` 1), rend `null` sans discussion.
µ._mjs_navHeadKeyOf = function(el) {
  var name, prop, rel, tag;
  if (!el || typeof el.getAttribute !== 'function' || el.nodeType !== 1) { return null; }
  tag = el.tagName;
  if (tag === 'META') {
    // casse STRICTE et VOULUE (`Description`/`OG:IMAGE` non reconnus) : les conventions HTML et Open
    // Graph sont en minuscules — délibérément AUCUNE tolérance ici, contrairement à `rel` (LINK, ci-dessous).
    name = el.getAttribute('name');
    if (name === 'description' || name === 'keywords' || name === 'robots' || name === 'author') { return 'meta:name:' + name; }
    if (name && (name.indexOf('og:') === 0 || name.indexOf('twitter:') === 0)) { return 'meta:name:' + name; }
    prop = el.getAttribute('property');
    if (prop && (prop.indexOf('og:') === 0 || prop.indexOf('twitter:') === 0 || prop.indexOf('article:') === 0)) { return 'meta:prop:' + prop; }
    return null;
  }
  if (tag === 'LINK') {
    rel = (el.getAttribute('rel') || '').trim().toLowerCase();
    // `rel` est une LISTE DE TOKENS séparés par des espaces
    // (spécification HTML, ex. `rel="canonical alternate"`), jamais une égalité stricte : un
    // <link rel="canonical alternate"> n'était jamais reconnu depuis une page reçue, et s'il était déjà
    // dans la page courante il y restait planté à vie (jamais nettoyé par le retrait des clés absentes).
    if (rel.split(/\s+/).indexOf('canonical') !== -1) { return 'link:canonical'; }
    return null;
  }
  return null;
};

// Tous les attributs d'un élément de <head>, en paires [nom, valeur] — forme PLATE partagée par
// µ._mjs_navApplyHead (table construite depuis le document PARSÉ) et µ._mjs_navSnapshotHead (table construite
// depuis une PHOTO, cf. plus bas) : aucun des deux ne fait transiter un NamedNodeMap vivant plus loin
// que sa propre fonction.
µ._mjs_navHeadAttrs = function(el) {
  var out, list, i;
  out = [];
  list = el.attributes;
  if (!list) { return out; }
  for (i = 0; i < list.length; i++) { out.push([list[i].name, list[i].value]); }
  return out;
};
µ._mjs_navHeadAttrValue = function(attrs, name) {
  var i;
  for (i = 0; i < attrs.length; i++) { if (attrs[i][0] === name) { return attrs[i][1]; } }
  return null;
};

// CORPS FACTORISÉ (µ._mjs_navApplyHead ET µ._mjs_navRestoreHead l'appellent, jamais dupliqué) — `table` :
// clé (µ._mjs_navHeadKeyOf) → { tag, attrs, node? }. `node` (présent UNIQUEMENT côté µ._mjs_navApplyHead, un
// document parsé fournit de VRAIS éléments) permet `document.importNode` pour une clé toute neuve ;
// absent (µ._mjs_navRestoreHead, qui ne repart que d'une PHOTO figée, cf. µ._mjs_navSnapshotHead) → repli
// systématique sur `createElement` + recopie d'attributs, exactement le même repli qu'un harnais de
// test minimal sans `importNode`.
// Gardée (`document.head`/`.children` absents) : un `document` minimal (harnais de test) ne fait
// jamais tomber cette fonction — même défense que le reste de ce fichier.
µ._mjs_navHeadReconcile = function(table) {
  var existants, i, j, el, key, entry, traites, val, fresh, attrName;
  if (!document.head || !document.head.children) { return; }
  existants = Array.prototype.slice.call(document.head.children); // copie AVANT de muter (retraits en cours de boucle)
  traites = {};
  for (i = 0; i < existants.length; i++) {
    el = existants[i];
    key = µ._mjs_navHeadKeyOf(el);
    if (!key) { continue; } // hors périmètre : jamais touché (styles/scripts/viewport/csrf-token/mjs-cache…)
    if (Object.prototype.hasOwnProperty.call(table, key)) {
      entry = table[key];
      attrName = el.tagName === 'LINK' ? 'href' : 'content';
      val = µ._mjs_navHeadAttrValue(entry.attrs, attrName);
      if (val !== null) { el.setAttribute(attrName, val); } // nœud EXISTANT conservé, jamais retiré/recréé
      traites[key] = true;
    } else {
      // la page qui arrive ne déclare plus cette métadonnée : la garder ferait traîner celle de la
      // page quittée (l'og:image d'une fiche produit sur la page contact, par exemple).
      if (el.parentNode) { el.parentNode.removeChild(el); }
    }
  }
  for (key in table) {
    if (!Object.prototype.hasOwnProperty.call(table, key) || traites[key]) { continue; }
    entry = table[key];
    if (entry.node && typeof document.importNode === 'function') {
      fresh = document.importNode(entry.node, true);
    } else {
      fresh = document.createElement(entry.tag);
      for (j = 0; j < entry.attrs.length; j++) { fresh.setAttribute(entry.attrs[j][0], entry.attrs[j][1]); }
    }
    document.head.appendChild(fresh);
  }
};

// Applique le <head> du document PARSÉ `doc` (réponse HTML d'une navigation, cf. les 3 sites de swap
// et µ._mjs_navRevalidate plus bas) au `document` COURANT. Opt-out puis gardes AVANT tout, TITRE ensuite,
// MÉTADONNÉES en dernier (réconciliation PAR CLÉ, cf. µ._mjs_navHeadReconcile juste au-dessus).
µ._mjs_navApplyHead = function(doc) {
  if (µ.config && µ.config.navHead === false) { return; } // désactivation globale, cf. bandeau
  try {
    var t, table, kids, i, key, node;
    // Un <head> ABSENT ou VIDE (`doc.head.children.length === 0`, cf. bandeau) ne veut RIEN dire de
    // la page reçue — sortie immédiate, RIEN ne change (jamais interprété comme « efface tout »).
    if (!doc || !doc.head || !doc.head.children || doc.head.children.length === 0) { return; }
    t = doc.querySelector('title');
    // Titre absent ou blanc : ne JAMAIS effacer le titre affiché — on garde ce qui est déjà là.
    if (t && typeof t.textContent === 'string' && t.textContent.trim() !== '') {
      document.title = t.textContent.trim();
    }
    table = {};
    kids = doc.head.children;
    for (i = 0; i < kids.length; i++) {
      node = kids[i];
      key = µ._mjs_navHeadKeyOf(node);
      if (key) { table[key] = { tag: node.tagName, attrs: µ._mjs_navHeadAttrs(node), node: node }; } // dernier gagnant si doublon
    }
    µ._mjs_navHeadReconcile(table);
  } catch (e) {} // une réconciliation de tête ne doit JAMAIS faire tomber la navigation
};

// PHOTO du <head> COURANT — prise par µ._mjs_navHibernate PENDANT que la page à archiver est
// ENCORE affichée (donc le <head> photographié est bien LE SIEN), posée sur `nodes._mjs_mjsHead` (même
// patron que `nodes._mjs_mjsCachePolicy`, cf. µ._mjs_navHibernate plus bas). `attrs` : TOUS les attributs du
// nœud (pas seulement `content`/`href`) — µ._mjs_navRestoreHead en a besoin pour reconstruire un nœud
// NEUF si celui d'origine a disparu du <head> courant entre-temps (une autre page, restée affichée
// plus longtemps, a pu retirer cette clé). Gardée (`document.head` absent) : jamais de throw.
µ._mjs_navSnapshotHead = function() {
  var metas, kids, i, key, node, head;
  metas = [];
  head = document.head;
  kids = head && head.children;
  if (kids) {
    for (i = 0; i < kids.length; i++) {
      node = kids[i];
      key = µ._mjs_navHeadKeyOf(node);
      if (key) { metas.push({ key: key, tag: node.tagName, attrs: µ._mjs_navHeadAttrs(node) }); }
    }
  }
  return { title: document.title, metas: metas };
};

// RESTAURATION depuis une PHOTO — appelée aux 2 restaurations cache-hit SYNCHRONES (popstate/
// clic, cf. leurs call-sites plus bas) : sans elle, un Précédent vers une page en cache garderait le
// titre de la page qu'on quitte (le bogue à l'envers) — les composants restaurés sont RÉVEILLÉS
// (µawake) et non re-montés, leur <@head><title> ne re-tire JAMAIS. `snap` absent (page mise en cache
// avant ce mécanisme, ou hibernée en 'no-cache') → aucun changement.
µ._mjs_navRestoreHead = function(snap) {
  var table, i, m;
  if (!snap) { return; }
  table = {};
  for (i = 0; i < snap.metas.length; i++) {
    m = snap.metas[i];
    table[m.key] = { tag: m.tag, attrs: m.attrs };
  }
  µ._mjs_navHeadReconcile(table);
  // `typeof snap.title === 'string'` SEUL, `snap.title !==
  // ''` RETIRÉ : une PHOTO (µ._mjs_navSnapshotHead) est le portrait COMPLET d'une page qu'on a RÉELLEMENT
  // affichée — un titre vide y est une INFORMATION (« cette page n'avait pas de titre »), jamais une
  // absence d'information, donc jamais un motif pour laisser traîner le titre de la page qu'on quitte.
  // DIFFÉRENT de µ._mjs_navApplyHead (juste au-dessus) : celui-là lit une page qui ARRIVE (réponse HTTP en
  // cours de parse) — un <title> absent ou blanc y signifie « je ne dis RIEN du titre » (un serveur qui
  // ne pilote pas le titre d'onglet, un fragment de gabarit incomplet), jamais « efface celui affiché » —
  // raison pour laquelle µ._mjs_navApplyHead, LUI, garde son test `!== ''` (`t.textContent.trim() !== ''`).
  if (typeof snap.title === 'string') { document.title = snap.title; }
};

// HIBERNATION — la page quittée est PHOTOGRAPHIÉE (lecture de `childNodes`, cf. call-sites
// popstate/clic/_mjs_navDispatch plus bas), jamais retirée sur le champ : le retrait réel n'a lieu
// qu'au prochain µ._mjs_zoneFill (le swap), sinon le contenant resterait vide pendant tout un fetch
// réseau en vol (exactement comme `replaceWith` ne détachait l'ancien contenu QU'AU swap).
// Vide `zone` puis y insère `nodes` (tableau, dans l'ordre) — `replaceChildren` s'il existe
// (natif, happy-dom des tests l'implémente aussi), sinon boucle retrait+réinsertion (ES5,
// ce fichier reste du style CoffeeScript compilé : pas de spread).
// >>> extrait-test _mjs_zoneFill
µ._mjs_zoneFill = function(zone, nodes) {
  var i;
  µ._mjs_navContainer = zone; // contenant courant du cache de pages (cf. µ._mjs_navCacheZone plus haut)
  µ._mjs_navHibernated = null; // hibernation consommée normalement : ce fill VIDE le contenant
  if (typeof zone.replaceChildren === 'function') {
    zone.replaceChildren.apply(zone, nodes);
    return;
  }
  while (zone.firstChild) { zone.removeChild(zone.firstChild); }
  for (i = 0; i < nodes.length; i++) { zone.appendChild(nodes[i]); }
};
// <<< extrait-test _mjs_zoneFill

// AJOUTE `nodes` à la SUITE du contenu déjà présent dans `zone`, sans RIEN retirer (method
// 'append') — miroir de µ._mjs_zoneFill mais sans vidage préalable. µ._mjs_navDropHibernation AVANT tout
// ajout : le contenu que la navigation vient de photographier pour le cache de pages (cf. bandeau
// HIBERNATION plus bas) reste PHYSIQUEMENT ici (un append ne le retire jamais) — sans ce nettoyage,
// ses nœuds garderaient `_mjs_page_cached` à vie (fuite : composants exemptés de destruction pour
// toujours) et l'entrée `µ.pageCache` sous le chemin quitté pointerait des nœuds encore VIVANTS.
// >>> extrait-test _mjs_zoneAppend
µ._mjs_zoneAppend = function(zone, nodes) {
  var i;
  µ._mjs_navContainer = zone; // contenant courant du cache de pages (cf. µ._mjs_navCacheZone plus haut)
  µ._mjs_navDropHibernation();
  for (i = 0; i < nodes.length; i++) { zone.appendChild(nodes[i]); }
};
// <<< extrait-test _mjs_zoneAppend

// DÉ-HIBERNATION — consomme µ._mjs_navHibernated si un `append` en a hérité un (posé aux 3 sites
// `pageCache.set`, plus bas, jamais consommé par un µ._mjs_zoneFill normal) : remet `_mjs_page_cached` à
// `false` sur ses nœuds ÉLÉMENTS (ils restent vivants, un append ne les a jamais détachés) et retire
// l'entrée périmée de `µ.pageCache` — sinon un retour arrière vers le chemin quitté réinstallerait
// SEULEMENT ces nœuds-là, effaçant tout ce que l'append a ajouté depuis.
// >>> extrait-test _mjs_navDropHibernation
µ._mjs_navDropHibernation = function() {
  var h, i;
  if (!µ._mjs_navHibernated) { return; }
  h = µ._mjs_navHibernated;
  for (i = 0; i < h.nodes.length; i++) { if (h.nodes[i].nodeType === 1) { h.nodes[i]._mjs_page_cached = false; } }
  if (µ.pageCache && typeof µ.pageCache.delete === 'function') { µ.pageCache.delete(h.path); }
  µ._mjs_navHibernated = null;
};
// <<< extrait-test _mjs_navDropHibernation

// FACTORISATION — corps commun aux 3 sites d'hibernation (popstate/clic/soumission GET dans
// µ._mjs_navDispatch, plus bas), avant identiques et dupliqués trois fois : photographie `zone.childNodes`,
// flag `_mjs_page_cached` sur les nœuds ÉLÉMENTS, `µ._mjs_saveScroll`, `pageCache.set` + µ._mjs_navHibernated.
// Point de passage UNIQUE qui rend la politique de cache par page tenable à poser une seule fois.
//
// POLITIQUE (µ._mjs_navCachePolicy, la page qu'on QUITTE, cf. sa déclaration plus haut) :
// - 'no-cache' → AUCUNE entrée n'est créée (ni pageCache.set, ni flag, ni µ._mjs_navHibernated) : un retour
//   arrière refera une vraie requête. `_mjs_saveScroll`, LUI, tourne quand même : la
//   position de scroll est une Map INDÉPENDANTE du LRU pageCache (cf. tête de fichier, même raisonnement
//   déjà appliqué au cache-miss réseau) — refuser la mise en cache DOM (le poids mémoire d'un arbre
//   vivant) n'a aucune raison de sacrifier aussi le confort du retour au bon endroit après le re-fetch ;
//   alternative écartée : sauter aussi `_mjs_saveScroll`, qui aurait remis le scroll à zéro sur un simple
//   opt-out de cache, régression UX sans rapport avec l'intention de `no-cache`.
// - 'revalidate' → entre au cache NORMALEMENT (comme 'cache-first'), MAIS le tableau `nodes` porte en
//   plus une propriété `_mjs_mjsCachePolicy = 'revalidate'` — DIRECTEMENT sur le tableau (comme
//   `_mjs_page_cached` est posé directement sur chaque nœud), jamais une Map à part : bornée par
//   construction par le MÊME LRU que pageCache, zéro structure supplémentaire à garder en synchro à
//   l'éviction. Consommée par les restaurations cache-hit (_swapPopCache/_swapClickCache) pour décider
//   d'un rafraîchissement en fond (µ._mjs_navRevalidate).
// - 'cache-first' → rien ne change, comportement historique.
//
// ÉVÉNEMENT before-cache — émis juste avant de poser le flag et d'archiver : MJS hiberne un
// arbre VIVANT (une modale ouverte, un menu déplié, un tiroir sorti ressortent tels quels au retour
// arrière) — avant cet instant, l'application peut refermer ce qui doit l'être. Pas émis en 'no-cache'
// (rien n'est archivé, rien à nettoyer avant). Enveloppé (try/catch) : ni un écouteur qui jette, ni
// l'absence de `document.dispatchEvent` (harnais de test minimal), ne doivent empêcher `pageCache.set`
// — même défense que µ._mjs_navWarnScripts plus haut.
µ._mjs_navHibernate = function(zone, path) {
  var policy, nodes, i, headSnap;
  // scroll sauvegardé pour TOUTE page qui pourra être revisitée par l'historique, même sans
  // zone hibernable (method:'replace' -> µ._mjs_navCacheZone() rend null) : sorti de la garde `!zone`,
  // même schéma déjà appliqué à la sortie 'no-cache' juste en dessous.
  if (path != null && typeof µ._mjs_saveScroll === 'function') { µ._mjs_saveScroll(path); }
  if (!zone || path == null || !µ.pageCache || typeof µ.pageCache.set !== 'function') { return; }
  policy = µ._mjs_navCachePolicy || 'cache-first';
  if (policy === 'no-cache') { return; }
  nodes = Array.prototype.slice.call(zone.childNodes);
  try {
    document.dispatchEvent(new CustomEvent('mjs:before-cache', { detail: { path: path, zone: zone }, bubbles: true, cancelable: false }));
  } catch (e) {}
  for (i = 0; i < nodes.length; i++) { if (nodes[i].nodeType === 1) { nodes[i]._mjs_page_cached = true; } }
  if (policy === 'revalidate') { nodes._mjs_mjsCachePolicy = 'revalidate'; }
  // photo prise MAINTENANT, pendant que la page à archiver est ENCORE affichée (seule fenêtre où
  // `document.title`/`document.head` décrivent encore CETTE page, avant que la navigation ne les remplace).
  // posée INCONDITIONNELLEMENT, plus seulement « si elle dit
  // quelque chose » : cette condition était FAUSSE — une page SANS titre ni métadonnée pilotée n'était
  // alors JAMAIS photographiée, et au retour cache-hit vers elle, le titre ET les métadonnées de la page
  // quittée entre-temps restaient collés dessus (µ._mjs_navRestoreHead ne reçoit RIEN à restaurer sans photo,
  // cf. son commentaire). Prouvé par exécution.
  headSnap = µ._mjs_navSnapshotHead();
  nodes._mjs_mjsHead = headSnap;
  µ.pageCache.set(path, nodes);
  µ._mjs_navHibernated = { path: path, nodes: nodes };
};

// REVALIDATION EN FOND (policy 'revalidate') — appelée juste après une restauration cache-hit
// synchrone (_swapPopCache/_swapClickCache) dont l'entrée porte `_mjs_mjsCachePolicy === 'revalidate'` : le
// contenu déjà affiché n'attend PAS ce fetch (zéro régression de vitesse), une requête GET part en fond
// vérifier sa fraîcheur. `µ._mjs_ajaxRequest` appelé DIRECTEMENT (pas µ._mjs_navRequest, qui pose toujours
// X-MJS-Nav) : la comparaison porte sur du HTML (innerHTML du contenant, cf. plus bas) — poser
// X-MJS-Nav ferait répondre `mjs serve` en JSON (fiche protocole), incomparable à un tableau de nœuds
// DOM déjà installés (cf. commentaire de µ._mjs_ajaxRequest dans mjs_ajax.ts, second consommateur voulu).
// Jamais de pushState, jamais µ.nav.active (silencieux, ce n'est pas une navigation visible) : aucun des
// deux n'est posé ici. Annulation : `seq` capturé AVANT le départ, comme tout fetch ujs — une navigation
// plus récente (µ._mjs_navSeq bumpé ailleurs, clic/popstate/submit) invalide la réponse tardive, réutilise
// le jeton EXISTANT plutôt que d'en réinventer un (µ._mjs_navController/_mjs_abortStaleNav n'est PAS touché ici :
// il est partagé avec les navigations PRINCIPALES, l'abandonner depuis un simple rafraîchissement de fond
// couperait un fetch de navigation réel qui serait par ailleurs en vol).
// >>> extrait-test _mjs_navRevalidate
µ._mjs_navRevalidate = function(zone, path) {
  var seq;
  if (typeof µ._mjs_ajaxRequest !== 'function') { return; }
  seq = µ._mjs_navSeq;
  µ._mjs_ajaxRequest({
    method: 'GET',
    url: path,
    success: function(html, finalUrl, _schemaNom, nav) {
      var doc, parser, zoneInfo, newRoot, freshTarget, differs, newNodes, _fresh, _asked;
      if (seq !== µ._mjs_navSeq || !zone) { return; } // navigation plus récente : réponse jetée
      if (!html || typeof html !== 'string') { return; } // réponse JSON/vide : hors périmètre de cette comparaison HTML
      // REDIRECTION SUIVIE — `fetch` suit nativement un 302 : la réponse peut être une AUTRE page
      // (session expirée → /login). Sans cette garde, un rafraîchissement de FOND déversait le
      // contenu de cette autre page dans le contenant courant, sans toucher l'URL affichée :
      // l'utilisateur se croyait toujours sur la page demandée. Un refetch silencieux n'a pas à
      // décider d'une navigation — on abandonne, la prochaine navigation RÉELLE verra la redirection.
      if (finalUrl) {
        try {
          _fresh = new URL(finalUrl, window.location.href);
          _asked = new URL(path, window.location.href);
          if (_fresh.pathname + _fresh.search !== _asked.pathname + _asked.search) { return; }
        } catch (e) { return; }
      }
      // `nav.reload`/`nav.method` REÇUS ICI : DÉLIBÉRÉMENT jamais lus sur ce chemin, même esprit
      // que la garde de redirection juste au-dessus. Ce refetch est un rafraîchissement SILENCIEUX de
      // fond (contenu déjà affiché, l'utilisateur n'a RIEN demandé) : un `X-MJS-Reload` y emporterait la
      // page sous ses yeux sans le moindre geste de sa part. `nav.method` n'a de toute façon aucun effet
      // ici — cette fonction ne passe jamais par µ._mjs_navInstallNodes, elle compare puis appelle
      // µ._mjs_zoneFill directement.
      parser = new DOMParser();
      doc = parser.parseFromString(html, 'text/html');
      freshTarget = (nav && typeof nav.target === 'string' && nav.target) ? nav.target : null;
      zoneInfo = µ._mjs_navMountZone(doc, freshTarget);
      newRoot = zoneInfo.zone;
      if (!newRoot) { return; }
      // signature bon marché (PAS d'arbres DOM comparés) : X-MJS-Version PRIORITAIRE si présent des
      // deux côtés (build changé depuis le chargement de cette page ⇒ considéré différent sans même
      // comparer le HTML) ; à défaut, innerHTML du contenant reçu vs affiché.
      if (nav && nav.version && µ.version && nav.version !== µ.version) {
        differs = true;
      } else {
        differs = newRoot.innerHTML !== zone.innerHTML;
      }
      if (!differs) { return; } // identique : rien ne bouge, aucun clignotement
      newNodes = Array.prototype.slice.call(newRoot.childNodes);
      µ._mjs_navTransplantPermanents(zone, newNodes); // 3e site de vidage — sans ça, un rafraîchissement de FOND détruisait le permanent en silence
      µ._mjs_navApplyHead(doc); // APRÈS le test `differs` : un rafraîchissement de fond qui ne change rien ne touche pas non plus la tête
      µ._mjs_zoneFill(zone, newNodes);
      // L'entrée de cache de ce chemin pointe encore les nœuds qu'on vient de DÉTACHER : on la
      // retire plutôt que de la laisser mentir jusqu'au prochain départ. Le prochain retour arrière
      // redemandera la page au serveur — c'est exactement ce que `revalidate` promet.
      if (µ.pageCache && typeof µ.pageCache.delete === 'function') { µ.pageCache.delete(path); }
    },
    error: function() {} // échec réseau en fond : silencieux, le contenu déjà affiché reste tel quel
  });
};
// <<< extrait-test _mjs_navRevalidate

// 1er nœud ÉLÉMENT d'un tableau installé (texte/commentaire ignorés) — cible de
// µ._mjs_focusAfterSwap après un swap en tableau (cf. les 5 fonctions de swap plus bas).
// >>> extrait-test _mjs_navFirstEl
µ._mjs_navFirstEl = function(nodes) {
  var i;
  for (i = 0; i < nodes.length; i++) { if (nodes[i].nodeType === 1) { return nodes[i]; } }
  return null;
};
// <<< extrait-test _mjs_navFirstEl

// AVERTISSEMENT <SCRIPT> DANS LE CONTENU ÉCHANGÉ — un <script> inséré par un swap (innerHTML/
// appendChild, jamais document.write) ne s'exécute JAMAIS : règle du DOM, pas un choix de MJS. `nodes`
// : tableau de nœuds AVANT le swap (cf. les 3 sites HTML plus bas, appelés sur `newNodes`). N'appelle
// et ne relance JAMAIS (enveloppe try/catch globale, même défense que le sélecteur de
// µ._mjs_navMountZone : un contenu échangé exotique ne doit jamais faire jeter la navigation).
µ._mjs_navScriptWarned = {}; // signatures de <script> déjà signalées (une fois chacune)
// types RÉELLEMENT exécutables par le navigateur (casse insensible) — absent/vide vaut
// 'text/javascript' implicite (spec HTML). Tout AUTRE type ('application/json', 'importmap',
// 'text/template'…) porte des DONNÉES, jamais du code : ignoré, il ne bruite jamais l'avertissement.
µ._mjs_navExecScriptTypes = { '': 1, 'text/javascript': 1, 'application/javascript': 1, 'text/ecmascript': 1, 'application/ecmascript': 1, 'module': 1 };
µ._mjs_navWarnScripts = function(nodes) {
  try {
    var scripts = [], loadedSrcs = [], i, j, n, kids, sig, type, srcEls;
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      if (!n || n.nodeType !== 1) { continue; }
      if (n.tagName === 'SCRIPT') { scripts.push(n); }
      if (typeof n.querySelectorAll === 'function') {
        kids = n.querySelectorAll('script');
        for (j = 0; j < kids.length; j++) { scripts.push(kids[j]); }
      }
    }
    if (!scripts.length) { return; }
    // scripts déjà chargés dans la page COURANTE (le bundle de l'app relayé par le gabarit
    // apparaîtrait sinon à CHAQUE navigation) : comparés par URL RÉSOLUE (`el.src`), pas l'attribut brut.
    srcEls = document.querySelectorAll('script[src]');
    for (i = 0; i < srcEls.length; i++) { loadedSrcs.push(srcEls[i].src); }
    for (i = 0; i < scripts.length; i++) {
      type = ((typeof scripts[i].getAttribute === 'function' && scripts[i].getAttribute('type')) || '').toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(µ._mjs_navExecScriptTypes, type)) { continue; }
      if (scripts[i].src) {
        if (loadedSrcs.indexOf(scripts[i].src) !== -1) { continue; }
        sig = scripts[i].src;
      } else {
        sig = (scripts[i].textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      }
      if (Object.prototype.hasOwnProperty.call(µ._mjs_navScriptWarned, sig)) { continue; }
      µ._mjs_navScriptWarned[sig] = true;
      µ.warn('[µ.UJS] <script> détecté dans le contenu échangé : le navigateur ne ré-exécute JAMAIS un <script> injecté (règle du DOM) — ce code ne tournera pas. Déplace-le dans un composant MJS (µmount), ou pose @noUJS sur les liens qui mènent à cette page. Script : ' + sig);
    }
  } catch (e) {}
};

// ÉLÉMENTS PERMANENTS `mjs-permanent` — un nœud qui porte cet attribut ET un `id` traverse
// une navigation SANS être recréé (lecteur audio qui joue, chat ouvert, panneau et son défilement) :
// avant toute installation (µ._mjs_navInstallNodes plus bas, modes 'update'/'replace' — 'append' ne
// retire rien, rien à transplanter), le nœud est APPARIÉ PAR ID entre l'arbre affiché (`zone`) et
// l'arbre qui arrive (`nodes`) ; le nœud VIVANT est TRANSPLANTÉ (déplacé, jamais cloné/recréé) à la
// place de son homologue ENTRANT. SYNCHRONE, dans le MÊME tick que l'installation qui suit (aucun
// `await`/microtask entre les deux) : mjs_element.ts ressuscite un composant reconnecté avant que sa
// destruction différée (microtask de disconnectedCallback) n'ait eu l'occasion de tourner — un
// aller-retour détaché→rattaché étalé sur deux ticks le ferait passer par une destruction complète.
//
// `_mjs_navFindById`/`_mjs_navFindByIdIn` : comparaison MANUELLE de `.id`, jamais un sélecteur CSS interpolé
// (`'#'+id`) — un `id` peut porter des caractères qui casseraient un tel sélecteur (espace, `:`…), un
// simple parcours d'arbre n'a besoin d'aucun échappement.
// >>> extrait-test _mjs_navFindByIdIn
µ._mjs_navFindByIdIn = function(node, id) {
  var kids, i, found;
  if (!node || node.nodeType !== 1) { return null; }
  if (node.id === id) { return node; }
  kids = node.children;
  if (!kids) { return null; }
  for (i = 0; i < kids.length; i++) {
    found = µ._mjs_navFindByIdIn(kids[i], id);
    if (found) { return found; }
  }
  return null;
};
// <<< extrait-test _mjs_navFindByIdIn
// >>> extrait-test _mjs_navFindById
µ._mjs_navFindById = function(nodes, id) {
  var i, found;
  for (i = 0; i < nodes.length; i++) {
    found = µ._mjs_navFindByIdIn(nodes[i], id);
    if (found) { return found; }
  }
  return null;
};
// <<< extrait-test _mjs_navFindById
// AVERTI UNE FOIS PAR ÉLÉMENT (drapeau porté par le nœud, même patron que µ._mjs_navWarnNoUjsMethod plus
// haut) : sans `id`, aucun appariement possible entre deux navigations — le nœud n'est simplement
// jamais transplanté, détruit normalement avec le reste de la page quittée.
// >>> extrait-test _mjs_navWarnPermanentNoId
µ._mjs_navWarnPermanentNoId = function(el) {
  if (!el || el._mjs_mjsPermanentNoIdWarned) { return; }
  el._mjs_mjsPermanentNoIdWarned = true;
  µ.warn('[µ.UJS] [mjs-permanent] sans id ignoré — un appariement entre deux navigations exige un id stable sur cet élément.');
};
// <<< extrait-test _mjs_navWarnPermanentNoId
// AVERTI UNE FOIS PAR ID (clé globale, pas un drapeau de nœud : c'est l'ID qui est en cause, pas
// l'élément) — deux nœuds VIVANTS partageant le même `id` : le HTML l'interdit déjà, mais rien ne
// l'empêchait ici et le second évinçait silencieusement le premier du document.
µ._mjs_navPermanentDupWarned = {};
µ._mjs_navWarnPermanentDupId = function(id) {
  if (Object.prototype.hasOwnProperty.call(µ._mjs_navPermanentDupWarned, id)) { return; }
  µ._mjs_navPermanentDupWarned[id] = true;
  µ.warn("[µ.UJS] [mjs-permanent] id '" + id + "' porté par PLUSIEURS éléments — un seul peut traverser la navigation, les autres partent avec la page quittée. Un id doit être unique dans le document.");
};
// >>> extrait-test _mjs_navTransplantPermanents
µ._mjs_navTransplantPermanents = function(zone, nodes) {
  var permanents, found, i, j, vivant, id, entrant, transplantes;
  if (!zone || !nodes || !nodes.length) { return; }
  permanents = [];
  // `zone` elle-même peut porter l'attribut (pas seulement ses descendants). Ordre du DOCUMENT
  // (querySelectorAll) : un ANCÊTRE permanent est donc toujours traité avant ses descendants
  // permanents — la garde `entrant === vivant` juste dessous en dépend.
  if (typeof zone.matches === 'function' && zone.matches('[mjs-permanent]')) { permanents.push(zone); }
  if (typeof zone.querySelectorAll === 'function') {
    found = zone.querySelectorAll('[mjs-permanent]');
    for (i = 0; i < found.length; i++) { permanents.push(found[i]); }
  }
  transplantes = []; // nœuds vivants DÉJÀ posés dans l'arbre entrant (détection des id dupliqués)
  for (i = 0; i < permanents.length; i++) {
    vivant = permanents[i];
    id = vivant.id;
    if (!id) { µ._mjs_navWarnPermanentNoId(vivant); continue; }
    entrant = µ._mjs_navFindById(nodes, id);
    if (!entrant) { continue; } // la page qui arrive ne le réclame pas : comportement normal, rien à transplanter
    // PERMANENT IMBRIQUÉ DANS UN PERMANENT — l'ancêtre a déjà été transplanté, ce nœud est donc DÉJÀ
    // dans l'arbre entrant : il s'y retrouve lui-même comme homologue. Sans cette garde,
    // `vivant.replaceWith(vivant)` le RETIRE du document sans jamais le réinsérer (perte silencieuse).
    if (entrant === vivant) { continue; }
    // ID DUPLIQUÉ entre deux nœuds vivants — l'homologue trouvé est un permanent qu'on vient de poser :
    // sans cette garde, ce second nœud évinçait le premier, déjà transplanté, du document.
    if (transplantes.indexOf(entrant) !== -1) { µ._mjs_navWarnPermanentDupId(id); continue; }
    entrant.replaceWith(vivant); // no-op DOM silencieux si `entrant` est une racine sans parent (cf. boucle sous)
    for (j = 0; j < nodes.length; j++) { if (nodes[j] === entrant) { nodes[j] = vivant; } } // racine du tableau : l'entrée elle-même
    transplantes.push(vivant);
  }
};
// <<< extrait-test _mjs_navTransplantPermanents

// BARRE DE PROGRESSION RETARDÉE — OPT-IN via `µ.config.navProgress` (mjs_init.ts) : absent ou
// `false` = zéro ligne exécutée, zéro élément inséré, repli identique au comportement sans cette fonctionnalité.
// `true` = seuil 500ms ; un NOMBRE = ce seuil en ms. Une navigation plus rapide que le seuil (cache,
// réseau local) n'affiche RIEN — un clignotement de quelques dizaines de ms est pire que son absence.
// Élément stylable en CSS SEUL (classe `mjs-nav-progress`, jamais de style posé depuis ce fichier) :
// l'apparence appartient à l'application (exemple docs/21-navigation.md).
// Timer + élément GLOBAUX, pas un par navigation (même régime que `µ.nav.active`, un booléen partagé,
// pas un compteur) : deux navigations qui s'enchaînent (la 2e abandonne la 1re, cf. `_mjs_abortStaleNav`
// en tête de fichier) ne doivent jamais empiler deux timers ni deux éléments — `_mjs_navProgressStart` ne
// fait rien si l'un des deux existe déjà.
µ._mjs_navProgressTimer = null;
µ._mjs_navProgressEl = null;
µ._mjs_navProgressStart = function() {
  var cfg, delay;
  cfg = µ.config && µ.config.navProgress;
  if (!cfg) { return; }
  if (µ._mjs_navProgressTimer || µ._mjs_navProgressEl) { return; } // déjà armé ou déjà affiché : rien à empiler
  delay = typeof cfg === 'number' ? cfg : 500;
  µ._mjs_navProgressTimer = setTimeout(function() {
    µ._mjs_navProgressTimer = null;
    µ._mjs_navProgressEl = document.createElement('div');
    µ._mjs_navProgressEl.className = 'mjs-nav-progress';
    µ._mjs_navProgressEl.setAttribute('role', 'progressbar');
    µ._mjs_navProgressEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(µ._mjs_navProgressEl);
  }, delay);
};
// Appelée à CHAQUE fin de navigation (succès, échec, abandon, repli natif — partout où
// `µ.nav.active` repasse à `false`) : annule le timer s'il n'a pas encore sonné, retire l'élément
// s'il a eu le temps d'apparaître. Idempotente (aucun des deux n'existe forcément).
µ._mjs_navProgressStop = function() {
  if (µ._mjs_navProgressTimer) { clearTimeout(µ._mjs_navProgressTimer); µ._mjs_navProgressTimer = null; }
  if (µ._mjs_navProgressEl) {
    if (µ._mjs_navProgressEl.parentNode) { µ._mjs_navProgressEl.parentNode.removeChild(µ._mjs_navProgressEl); }
    µ._mjs_navProgressEl = null;
  }
};

// Installe un TABLEAU de nœuds (contenu HTML échangé, cf. les 3 sites de swap plus bas) dans le
// contenant résolu par µ._mjs_navMountZone. Quatre valeurs de `method` :
// - 'none' → RIEN n'est installé (« ne bouge pas » — cf. bandeau juste avant le corps ci-dessous).
// - 'replace' ET zone ≠ <body> ET détachable (parentNode) → le contenant CÈDE SA PLACE (replaceWith,
//   suivi par µ._mjs_navTrackZone sur le 1er nœud ÉLÉMENT : la navigation suivante retrouve ce module tant
//   qu'il reste monté) ; visant <body> (JAMAIS remplacé lui-même) → averti une fois, dégradé en 'update'.
// - 'append' → le contenant SURVIT, `nodes` s'ajoute à la SUITE de ce qui est déjà là (µ._mjs_zoneAppend,
//   rien n'est retiré), suivi neutralisé.
// - sinon ('update', défaut — toute valeur déjà normalisée en amont par µ._mjs_navMethodOf) → le contenant
//   SURVIT, vidé puis réinjecté (µ._mjs_zoneFill), suivi neutralisé.
// RENVOIE le contenant EFFECTIF après installation :
// `zoneInfo.zone` se DÉTACHE en 'replace' réel (isConnected===false après le replaceWith) — un appelant
// qui capturait `zoneInfo.zone` AVANT cet appel (tous les sites d'émission de `mjs:load`, plus bas)
// obtenait donc un nœud MORT pour `detail.zone`. 'append'/'update'/'replace' dégradé <body> → la zone
// elle-même (inchangée, jamais détachée sur ces 3 chemins). 'none' → `null` (cf. corps ci-dessous).
// >>> extrait-test _mjs_navInstallNodes
µ._mjs_navInstallNodes = function(zoneInfo, nodes, method, cache) {
  var _parent;
  // 'none' : rien à installer, la page AFFICHÉE reste affichée telle quelle. Les trois états de
  // zone (µ._mjs_navContainer/µ._mjs_navTrackZone/µ._mjs_navCachePolicy) décrivent CETTE page toujours montée —
  // aucun des trois ne bouge ici. Seule l'hibernation posée AVANT que la réponse n'arrive (par le site
  // appelant, cf. µ._mjs_navHibernate) est annulée : sans ce nettoyage, les nœuds encore affichés
  // resteraient marqués hibernés (composants exemptés de destruction à vie, entrée µ.pageCache pointant
  // des nœuds pourtant vivants) — même remède que µ._mjs_zoneAppend juste plus bas, même raison.
  if (method === 'none') {
    µ._mjs_navDropHibernation();
    return null;
  }
  if (method === 'replace' && zoneInfo.zone !== document.body && zoneInfo.zone.parentNode) {
    _parent = zoneInfo.zone.parentNode; // capturé AVANT le replaceWith : zoneInfo.zone se détache juste après
    µ._mjs_navTransplantPermanents(zoneInfo.zone, nodes); // AVANT que le contenant ne cède sa place
    zoneInfo.zone.replaceWith.apply(zoneInfo.zone, nodes);
    µ._mjs_navContainer = false; // plus de contenant stable : cette page ne se cache pas
    µ._mjs_navTrackZone(µ._mjs_navFirstEl(nodes), 'replaced'); // le 1er ÉLÉMENT, pas nodes[0] (peut être du texte)
    µ._mjs_navCachePolicy = cache || 'cache-first'; // la page qui vient de s'installer, à côté du suivi de zone
    return _parent;
  }
  if (method === 'replace' && zoneInfo.zone === document.body && !µ._mjs_navReplaceBodyWarned) {
    µ._mjs_navReplaceBodyWarned = true;
    µ.warn("[µ.UJS] method 'replace' sans target : <body> n'est jamais remplacé — contenu remplacé à la place.");
  }
  if (method === 'append') {
    µ._mjs_zoneAppend(zoneInfo.zone, nodes);
    µ._mjs_navTrackZone(null, null);
    µ._mjs_navCachePolicy = cache || 'cache-first';
    return zoneInfo.zone;
  }
  µ._mjs_navTransplantPermanents(zoneInfo.zone, nodes); // AVANT le vidage (µ._mjs_zoneFill emporterait le permanent avec le reste)
  µ._mjs_zoneFill(zoneInfo.zone, nodes);
  µ._mjs_navTrackZone(null, null);
  µ._mjs_navCachePolicy = cache || 'cache-first';
  return zoneInfo.zone;
};
// <<< extrait-test _mjs_navInstallNodes

// Enveloppe mince de µ._mjs_navInstallNodes pour le cas UN SEUL nœud (composant JSON, panneau 404) —
// appelants inchangés (µ._mjs_navApplyJson, µ._mjs_navShowNotFound), délègue avec `[el]`. RENVOIE la
// valeur de µ._mjs_navInstallNodes telle quelle — propage le contenant effectif à qui en a besoin.
// >>> extrait-test _mjs_navInstallInZone
µ._mjs_navInstallInZone = function(zoneInfo, el, method, cache) {
  return µ._mjs_navInstallNodes(zoneInfo, [el], method, cache);
};
// <<< extrait-test _mjs_navInstallInZone

// RÉSOLUTION CROISÉE DU CONTENANT (chemin HTML UNIQUEMENT) — le chemin HTML a DEUX documents :
// la page affichée et la réponse parsée. Le contenant doit exister des DEUX côtés. Absent de la
// RÉPONSE (gabarit différent : page de connexion, page legacy, erreur…), remplir le contenant courant
// avec le <body> ENTIER de la réponse imbriquerait tout son habillage (en-tête, pied) DANS la cible —
// page visiblement cassée, et en SILENCE (µ._mjs_navMountZone n'avertit que pour le document COURANT,
// jamais pour une réponse parsée). On dégrade alors les
// DEUX côtés sur <body> — la page qui ARRIVE porte son propre habillage, le résultat reste juste —
// avec un avertissement une fois par sélecteur distinct. Le cas inverse (présent côté réponse, absent
// côté page) reste géré par µ._mjs_navMountZone lui-même (repli <body> + son propre avertissement).
µ._mjs_navResolveZones = function(doc, target) {
  var newInfo = µ._mjs_navMountZone(doc, target);
  if (target && newInfo.mode !== 'target') {
    if (!Object.prototype.hasOwnProperty.call(µ._mjs_navRespTargetWarned, target)) {
      µ._mjs_navRespTargetWarned[target] = true;
      µ.warn("[µ.UJS] cible de navigation '" + target + "' introuvable dans la page reçue — contenu de <body> remplacé (des deux côtés).");
    }
    target = null;
    newInfo = µ._mjs_navMountZone(doc, null);
  }
  return { newZone: newInfo.zone, liveInfo: µ._mjs_navMountZone(document, target) };
};

// Panneau « Page introuvable » du protocole JSON (404 PATHNAME, cf.
// docs/21-navigation.md) — même classe/mêmes libellés que celui du routeur
// hash (_mjs_showNoMatch, mjs_router.ts) mais ciblé sur le CONTENANT DE NAVIGATION
// (cf. bandeau ci-dessus) plutôt que sur la 1ʳᵉ `<@view>` : une navigation JSON 404
// n'a par nature AUCUNE vue routée montée (aucune route pathname ne
// correspond) — rien à quoi raccrocher `_mjs_showNoMatch` tel quel (choix
// signalé). Respecte `µ.config.routeNotFound` comme le routeur. `target`/
// `method` (optionnels, repli `null`/'update' — les appelants existants sans
// ces arguments continuent de marcher) : mêmes clés de fiche que le cas
// nominal (µ._mjs_navApplyJson), un 404 porte lui aussi un contenant/mode. `cache` (idem repli
// `undefined` → 'cache-first' via µ._mjs_navInstallInZone) : un panneau 404 s'installe comme une page
// ordinaire, sa politique de cache suit la même fiche.
// RENVOIE le contenant EFFECTIF après installation — valeur de µ._mjs_navInstallInZone propagée
// telle quelle : µ._mjs_navApplyJson (branche 404) s'en sert pour detail.zone, capturer le contenant
// AVANT cet appel (comme précédemment) redonnait un nœud DÉTACHÉ en method:'replace' (cf.
// µ._mjs_navInstallNodes). Modes 'silent'/'warn' : sortie AVANT toute installation — RENVOIE désormais
// `false` plutôt que le contenant : `µ._mjs_navApplyJson` (branche 404)
// s'en sert pour GARDER `opts.onSwapped()`, qui ne doit JAMAIS tourner sans installation réelle
// (poison symétrique à `method:'none'`, cf. son bandeau — un 404 silencieux avançait quand même
// `µ._mjs_lastUjsPath`). Mode 'error' : valeur TOUJOURS truthy (le contenant réel, INCHANGÉ) — detail.zone
// ne bouge pas.
µ._mjs_navShowNotFound = function(matchPath, target, method, cache) {
  var mode, msg, rt, label, zoneInfo, box, h, p, code, style;
  mode = (µ.config && µ.config.routeNotFound) || 'error';
  if (mode === 'silent') { µ.log("[µ.UJS] Aucune page ne correspond à '" + matchPath + "'."); return false; }
  msg = "[µ.UJS] Aucune page ne correspond à '" + matchPath + "'.";
  if (mode === 'warn') { µ.warn(msg); return false; }
  µ.error(msg);
  rt = µ.Router;
  // µ._mjs_label (mjs_init.ts) choisit la langue AFFICHÉE, avant le routeur
  // (fallback si `Router` absent de ce build) puis le repli littéral fr codé en dur.
  label = function(k) {
    var v;
    if (typeof µ._mjs_label === 'function') {
      v = µ._mjs_label('router', k);
      if (v) { return v; }
    }
    if (rt && typeof rt._mjs_routerLabel === 'function') { return rt._mjs_routerLabel(k); }
    return { notFound: 'Page introuvable', noRoute: 'Aucune route ne correspond à cette adresse.' }[k];
  };
  zoneInfo = µ._mjs_navMountZone(document, target);
  box = document.createElement('div');
  box.setAttribute('data-mjs-route-error', '');
  box.className = 'mjs-route-error';
  h = document.createElement('strong'); h.textContent = label('notFound');
  p = document.createElement('p'); p.textContent = label('noRoute');
  code = document.createElement('code'); code.textContent = matchPath;
  box.appendChild(h); box.appendChild(p); box.appendChild(code);
  if (µ._csp) {
    // sous `µ._csp` : feuille constructible unique, adoptée une seule fois sur `document`
    // (le CSS du panneau est statique, pas besoin d'un <style> par appel).
    if (!µ._mjs_ujsRouteErrorSheetAdopted) {
      var errorSheet = new CSSStyleSheet();
      errorSheet.replaceSync(µ._mjs_routeErrorCss);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, errorSheet];
      µ._mjs_ujsRouteErrorSheetAdopted = true;
    }
  } else {
    style = document.createElement('style');
    style.textContent = µ._mjs_routeErrorCss;
    // style FRÈRE du texte dans `box` (jamais dans le textContent) — rendu identique, mais `box`
    // s'installe seul (plus de fragment) : la zone reste traçable à la navigation suivante.
    box.appendChild(style);
  }
  return µ._mjs_navInstallInZone(zoneInfo, box, method, cache);
};

// veilleur central flash/error : au moment où un sac de props SERVEUR entre au magasin
// (nominal/none/422/1er chargement, cf. leurs sites d'appel), CONSOMME `props.flash`/`props.error`
// (delete AVANT que le sac n'entre au magasin — `props.errors`, PLURIEL, erreurs PAR CHAMP, n'est
// JAMAIS touché) et les affiche selon la politique effective. Sans aucune des deux clés : inerte,
// zéro coût notable (2 hasOwnProperty). Politique : attribut `mjs-flash` de l'ÉLÉMENT D'ORIGINE
// d'abord ('popup'/'console'/'silent', autre valeur → µ.warn une fois + repli politique globale) ;
// sinon µ.config.flash (mjs_init.ts) : 'popup' (défaut) | 'console' | fonction `(type, message) => …`
// (type ∈ 'flash'|'error') | false (veilleur COUPÉ — clés NON consommées, µres les porte intactes).
var _navFlashAttrWarned = false;
var _navFlashModalWarned = false;
µ._mjs_navFlashPolicy = function(originEl) {
  var attr, cfg;
  attr = (originEl && typeof originEl.getAttribute === 'function' && originEl.hasAttribute('mjs-flash')) ? originEl.getAttribute('mjs-flash') : null;
  if (attr === 'popup' || attr === 'console' || attr === 'silent') { return attr; }
  if (attr && !_navFlashAttrWarned) {
    _navFlashAttrWarned = true;
    µ.warn('[µ.UJS] mjs-flash="'+ attr +'" : valeur non reconnue (popup/console/silent attendus) — politique globale utilisée.');
  }
  cfg = µ.config && µ.config.flash;
  if (cfg === false) { return false; }
  if (typeof cfg === 'function') { return cfg; }
  if (cfg === 'console') { return 'console'; }
  return 'popup'; // défaut, y compris clé absente
};
// affichage brut par le canal résolu — réutilisé tel quel par l'échec transport (µ._mjs_navDispatch/fail,
// plus bas : aucun sac à consommer là-bas, juste un message synthétique) : séparé de µ._mjs_navFlash
// justement pour ce partage.
µ._mjs_navFlashShow = function(type, message, policy) {
  if (policy === false || policy === 'silent') { return; }
  if (typeof policy === 'function') { policy(type, message); return; }
  if (policy === 'console') {
    if (type === 'error') { console.error(message); } else { console.info(message); }
    return;
  }
  // 'popup' — même détection de module absent que µ.confirm plus haut.
  if (µ.modal && typeof µ.modal.fire === 'function') {
    if (type === 'error') { µ.modal.error(message); } else { µ.modal.notify(message, { type: 'success' }); }
    return;
  }
  if (!_navFlashModalWarned) {
    _navFlashModalWarned = true;
    µ.warn('[µ.UJS] flash/error à afficher mais µ.modal est absent (module \'modal\' non inclus dans `runtime`) — repli console/alert.');
  }
  // `typeof window.alert === 'function'` — défensif, MÊME garde que µ.confirm plus haut
  // (`typeof window.confirm === 'function'`) : environnement sans alert (SSR, sandbox de test) →
  // silencieux plutôt qu'un crash pour un simple message de repli.
  if (type === 'error') { if (typeof window.alert === 'function') { window.alert(message); } } else { console.info(message); }
};
µ._mjs_navFlash = function(props, originEl) {
  var policy, hasFlash, hasError, f, e;
  if (!props) { return; }
  hasFlash = Object.prototype.hasOwnProperty.call(props, 'flash');
  hasError = Object.prototype.hasOwnProperty.call(props, 'error');
  if (!hasFlash && !hasError) { return; } // inerte
  policy = µ._mjs_navFlashPolicy(originEl);
  if (policy === false) { return; } // veilleur coupé : clés NON consommées, µres intact
  if (hasFlash) { f = props.flash; delete props.flash; µ._mjs_navFlashShow('flash', f, policy); }
  if (hasError) { e = props.error; delete props.error; µ._mjs_navFlashShow('error', e, policy); }
};

// @callback (mjs-callback) : sur SUCCÈS de navigation SEULEMENT (fiche nominale appliquée ET
// method:'none' — jamais 422, jamais échec transport, jamais popstate, cf. leurs sites d'appel) —
// remonte depuis l'élément PORTEUR de l'attribut (l'élément d'origine lui-même, ou son plus proche
// ancêtre via `closest`) vers le premier nœud (lui compris) qui définit une méthode de CE nom, et
// l'appelle avec le vocabulaire des événements de cycle. `originEl` doit être encore MONTÉ
// (isConnected) : un clic dont le conteneur vient d'être remplacé par le swap n'a plus personne à
// notifier (nœud mort). Boucle ≤50 sauts, traverse les shadow roots via getRootNode().host — même
// esprit que µ.Element::_mjs_findBoundary (mjs_failed.ts).
µ._mjs_navCallbackClimb = function(startEl, nom) {
  var node = startEl, hops = 0;
  while (node && hops++ < 50) {
    if (typeof node[nom] === 'function') { return node; }
    node = node.parentNode || (node.getRootNode ? node.getRootNode().host : null);
  }
  return null;
};
µ._mjs_navRunCallback = function(originEl, detail) {
  var callbackEl, nom, target;
  if (!originEl || !originEl.isConnected || typeof originEl.closest !== 'function') { return; }
  callbackEl = (typeof originEl.hasAttribute === 'function' && originEl.hasAttribute('mjs-callback')) ? originEl : originEl.closest('[mjs-callback]');
  if (!callbackEl) { return; }
  nom = callbackEl.getAttribute('mjs-callback');
  if (!nom) { return; }
  target = µ._mjs_navCallbackClimb(callbackEl, nom);
  if (!target) {
    µ.warn('[µ.UJS] @callback="'+ nom +'" : aucune méthode « '+ nom +' » trouvée sur '+ callbackEl.tagName.toLowerCase() +' ni ses ancêtres — rappel ignoré.');
    return;
  }
  // un rappel qui LÈVE traversait la fonction : le swap DOM avait déjà eu lieu, mais
  // `µ.Router.navigate()` et l'événement `mjs:load` (point d'accroche recommandé pour
  // l'analytique) ne partaient JAMAIS. Même convention que `mjs_socket.ts::_mjs_dispatch` — chaque
  // rappel d'application est isolé, l'échec est DIT, jamais avalé en silence.
  try { target[nom](detail); } catch (e) { µ.error('[µ.UJS] @callback="'+ nom +'"', e); }
};

// `µ._mjs_navApplyJson(json, finalUrl, opts)` — applique une réponse JSON du
// protocole de navigation (docs/21-navigation.md « Le protocole serveur »).
// `opts.push` (bool, défaut false) : pousser l'historique vers la destination
// finale — FAUX pour un popstate (l'historique a déjà bougé) ou un lien
// same-URL déjà poussé au clic (correction éventuelle laissée au call-site,
// comme pour le chemin HTML existant) ; VRAI pour un PRG (submit qui
// redirige) ou un form GET dont l'URL n'a pas encore été posée par ce chemin.
µ._mjs_navApplyJson = function(json, finalUrl, opts) {
  var dest, target, method, cache, title, bare, known, el, zone, swap, via, evPaths, installedZone, originEl, destOrigin, destProtocol, destUrl, liveOrigin;
  dest = finalUrl || json.url;
  opts = opts || {};
  // origine RÉELLE de `dest`, calculée UNE FOIS (sert aux 2 sites `pushState` plus bas) :
  // jamais un `µ._mjs_finalPathFor` externe ici — cette fonction vit dans le bloc 'helpers-navigation',
  // extrait SEUL par de nombreux tests existants (sans le bloc séparé `_mjs_finalPathFor`). `liveOrigin`
  // absent (harnais de test minimal, sans `window.location.origin`) → jamais de comparaison hasardeuse,
  // repli sur le comportement historique : seul un VRAI navigateur (où `window.location.origin`
  // existe TOUJOURS) peut faire jouer la garde.
  // résolu contre `document.baseURI` (repli
  // `window.location.href` si absent), EXACTEMENT comme µ._mjajaxMemeOrigine (mjs_ajax.ts) :
  // `history.pushState` natif résout aussi contre baseURI, jamais location.href — un `<base href>`
  // tiers faisait juger "même origine" une URL relative qui partait RÉELLEMENT ailleurs (SecurityError
  // natif malgré ce garde-fou, prouvé Chromium). `destProtocol` calculé ICI pour le même usage aux 2
  // sites plus bas : une destination hors origine et non http(s) (javascript:/data:/blob:…) ne doit
  // JAMAIS atteindre µ._mjs_hardNav, qui exécuterait le script au lieu de naviguer (prouvé Chromium).
  liveOrigin = window.location && window.location.origin;
  if (liveOrigin) {
    try {
      destUrl = new URL(dest, (typeof document !== 'undefined' && document.baseURI) || window.location.href);
      destOrigin = destUrl.origin;
      destProtocol = destUrl.protocol;
    } catch (eDestOrigin) { destOrigin = liveOrigin; destProtocol = null; }
  }
  // `via` transmis par l'appelant (popstate/clic réseau/_mjs_navDispatch, cf. leurs 3 call-sites) ;
  // défaut 'link' (repli raisonnable pour cette fonction, pensée pour la navigation liée).
  via = opts.via || 'link';
  // `originEl` (veilleur flash/error + @callback) : l'élément ayant déclenché CETTE
  // navigation (lien mjs-method/formulaire soumis via µ._mjs_navDispatch, OU lien ordinaire cliqué —
  // cf. leurs bandeaux respectifs, `opts.el`) — absent SEULEMENT au popstate (repli `null`,
  // politique globale, cf. son site d'appel).
  originEl = opts.el || null;
  // `dest` (finalUrl ou json.url) PEUT être ABSOLUE (`finalUrl` = `response.url`, TOUJOURS
  // absolue par construction du Fetch API — prouvé sur le chemin popstate, cf. µ._mjs_navEmitPaths) :
  // path/url de detail calculés SANS l'origine — `dest` lui-même reste INTACT (pushState/
  // window.location.assign/création de l'élément en dépendent tel quel, origine comprise).
  evPaths = µ._mjs_navEmitPaths(dest);
  // clés `target`/`method` de la fiche : le CONTENANT (sélecteur CSS, absent = <body>) et
  // ce qu'on en fait ('update' défaut = contenu vidé puis réinjecté, contenant intact ; 'append' =
  // contenu existant CONSERVÉ, module ajouté à la suite ; 'replace' = le contenant cède sa place au
  // module). Normalisation PARTAGÉE avec le chemin HTML : µ._mjs_navMethodOf (valeur inconnue → 'update' +
  // averti une fois par valeur distincte). `cache` : même patron, µ._mjs_navCachePolicyOf — SEUL
  // canal pour le chemin JSON (pas de balise <meta>, propre au HTML, cf. µ._mjs_navCacheOf).
  target = (typeof json.target === 'string' && json.target) ? json.target : null;
  method = µ._mjs_navMethodOf(json.method);
  cache = µ._mjs_navCachePolicyOf(json.cache);
  // `title` (jusqu'ici lu par AUCUN chemin) : la fiche peut imposer le titre d'onglet, un
  // back applicatif qui parle ce protocole sans composant `<@head><title>` en a désormais le moyen.
  // Absent/vide → `null`, aucun contact avec `document.title` (repli sûr, comportement historique).
  title = (typeof json.title === 'string' && json.title) ? json.title : null;
  // `reload` : un ordre EXPLICITE du serveur passe avant une version DÉDUITE — placé AVANT la
  // garde de version juste en dessous, donc avant toute installation, tout pushState, toute émission
  // mjs:load.
  if (µ._mjs_navReloadAsked(json.reload)) {
    µ._mjs_navHardReload(dest);
    return;
  }
  // version : le bundle a changé depuis le chargement de CETTE page — monter
  // un composant/des props neufs avec l'ancien JS est un terrain miné (formes
  // de compilation potentiellement incompatibles) ; rechargement complet,
  // plus sûr que d'improviser une compatibilité inter-versions.
  if (json.version && µ.version && json.version !== µ.version) {
    window.location.assign(dest);
    return;
  }
  // `method:'none'` : « ne bouge pas », traité AVANT la résolution de `json.module` (un back qui
  // répond `none` peut légitimement envoyer `module: null` — ce n'est PAS un 404, ne pars donc pas dans
  // la branche panneau « Page introuvable » juste en dessous). Seules les props sont appliquées, en
  // FUSION (µ._mjs_resMerge, mjs_store_globals.ts — jamais µ._mjs_resSet, qui remplacerait tout le sac : ici
  // aucune nouvelle page n'arrive, la page affichée et ses props survivent). Ni création d'élément, ni
  // µ._mjs_navInstallInZone, ni µ._mjs_focusAfterSwap, ni µ._mjs_vtWrapSwap, ni pushState (même si `opts.push` est
  // vrai), ni µ.Router.navigate, ni mjs:load : l'adresse affichée ne change pas, rien n'a été monté.
  // µ._mjs_navDropHibernation() APPELÉ ICI EXPLICITEMENT : ce chemin ne passe
  // JAMAIS par µ._mjs_navInstallNodes (dont le propre court-circuit 'none' droppe déjà l'hibernation, cf.
  // son bandeau — inatteignable depuis ICI) — pourtant `µ._mjs_navHibernate` a pu tourner AVANT ce point,
  // pour CETTE MÊME navigation, sur les 2 sites qui appellent `_mjs_navApplyJson` avec une réponse JSON
  // (clic/popstate, systématiquement ; `µ._mjs_navDispatch` sur son seul chemin GET, cf. son bandeau) —
  // sans cet appel, une navigation qui hiberne au clic/popstate PUIS reçoit `method:'none'` en JSON
  // laisserait les nœuds affichés marqués hibernés à vie (composants exemptés de destruction, entrée
  // µ.pageCache pointant des nœuds pourtant vivants). Idempotent, sans effet si rien n'est en vol.
  if (method === 'none') {
    µ._mjs_navDropHibernation();
    // consomme props.flash/props.error AVANT que le sac n'entre au magasin (µ._mjs_navFlash
    // mute `json.props` en place, cf. son bandeau) ; module ujs tree-shaké → garde d'existence.
    if (typeof µ._mjs_navFlash === 'function') { µ._mjs_navFlash(json.props || {}, originEl); }
    if (typeof µ._mjs_resMerge === 'function') { µ._mjs_resMerge(json.props || {}); }
    // @callback : APRÈS l'installation du sac (état déjà à jour quand le rappel tourne).
    // `status` : ce chemin n'existe que sur une réponse JSON EXPLOITÉE (jamais atteint si le fetch a
    // échoué, cf. mjs_ajax.ts) — 200 par construction, code EXACT non propagé jusqu'ici (hors zone).
    if (typeof µ._mjs_navRunCallback === 'function') { µ._mjs_navRunCallback(originEl, { path: evPaths.path, url: evPaths.url, status: 200, via: via }); }
    return;
  }
  if (json.module === null) {
    // 404 PÉRIMÉ : garde EN
    // TÊTE de branche, même raisonnement que le bandeau `swap` nominal plus bas — une navigation
    // plus RÉCENTE a pu démarrer PENDANT que cette réponse était en vol et gagner le DOM ; ce chemin ne
    // connaît AUCUNE transition différée (pas de µ._mjs_vtWrapSwap sur la branche 404, toujours synchrone),
    // donc les 3 sites d'appel normaux (popstate/clic/_mjs_navDispatch) ont TOUJOURS déjà écarté un
    // `opts.seq` périmé avant d'atteindre cette fonction (leur propre garde synchrone, cf. leurs 3
    // bandeaux) — cette garde vise un appelant DIRECT (défense en profondeur). Rien n'est installé, rien
    // n'est poussé, aucun événement émis : `µ._mjs_navDropHibernation()` volontairement PAS appelée
    // (l'hibernation courante appartient à la navigation gagnante, pas à celle-ci — même remarque que le
    // bandeau `swap` plus bas).
    if (opts.seq != null && opts.seq !== µ._mjs_navSeq) { return; }
    // 404 côté serveur (aucune page ne matche ce pathname) — même sémantique
    // que le 404 du routeur hash (µ.config.routeNotFound).
    // `dest` HORS ORIGINE (redirection suivie par fetch vers un autre host, ou `json.url`
    // absolu mal formé côté back) : jamais de pushState (SecurityError natif non catché, même risque
    // que µ._mjs_finalPathFor, cf. son bandeau) — navigation dure à la place.
    if (opts.push) {
      // protocole testé EN PREMIER, avant le
      // test d'origine : un `blob:` de MÊME origine (`URL.origin` vaut l'origine qui l'a créé, par
      // spec) passait tout droit la branche « même origine » vers `window.history.pushState`, qui
      // REJETTE pourtant un blob: (même « même origine ») avec SecurityError natif non catché
      // (confirmé sur Chromium réel) — l'ancien contrôle ne vivait QUE dans la branche
      // « origine différente » juste en dessous, jamais atteinte dans ce cas.
      if (liveOrigin && destProtocol !== 'http:' && destProtocol !== 'https:') { µ.warn('[µ.UJS] navigation abandonnée, url hors origine et protocole non http/https : '+ dest); return; }
      if (liveOrigin && destOrigin !== liveOrigin) {
        return µ._mjs_hardNav(dest);
      }
      window.history.pushState({}, '', dest);
    }
    if (µ.Router && typeof µ.Router._mjs_updateUrlStore === 'function') { µ.Router._mjs_updateUrlStore(); }
    // un panneau « Page introuvable » a droit à son titre, SYNCHRONE, comme le cas nominal.
    if (title) { document.title = title; }
    // contenant EFFECTIF retourné par µ._mjs_navShowNotFound (celui capturé AVANT l'installation,
    // via µ._mjs_navMountZone, se détache en method:'replace', cf. µ._mjs_navInstallNodes) — capturé ici pour
    // detail.zone plus bas. FALSY (`false`) en modes 'silent'/'warn' (cf. bandeau de
    // µ._mjs_navShowNotFound) : rien n'a été installé, sert de garde juste en dessous.
    installedZone = µ._mjs_navShowNotFound(dest, target, method, cache);
    // RÉGRESSION corrigée : `opts.onSwapped` (posée par les 3 appelants,
    // cf. leurs bandeaux) tournait ICI même en modes 'silent'/'warn', où `µ._mjs_navShowNotFound` n'installe
    // RIEN (sort AVANT toute installation) — `onSwapped` y écrit pourtant `µ._mjs_lastUjsPath` vers la
    // destination 404 et défile (window.scrollTo/µ._mjs_restoreScroll) : incohérence DOM/chemin, poison
    // symétrique à l'ancien `method:'none'` (cf. son bandeau plus haut). `installedZone` (truthy
    // SEULEMENT si un panneau a RÉELLEMENT été installé, mode 'error' — falsy sinon) sert désormais de
    // garde ; l'ancienne comparaison `opts.seq` ici est devenue REDONDANTE (la garde ajoutée en TÊTE de
    // cette branche a déjà écarté tout `opts.seq` périmé avant ce point) et retirée.
    if (typeof opts.onSwapped === 'function' && installedZone) { opts.onSwapped(); }
    // mjs:load : un panneau 404 est une installation réussie (le contenant a bien reçu quelque
    // chose) — seuls les cas version/module inconnus (ci-dessus/ci-dessous) partent en rechargement dur.
    // ÉMIS DANS TOUS LES CAS, installation réelle ('error') ou pas ('silent'/'warn') :
    // signal TERMINAL de la navigation (une appli qui affiche un indicateur de chargement au départ doit
    // le voir se terminer, cf. µ.nav.active/barre de progression) — délibérément PAS gardé par
    // `installedZone`, à la différence de `opts.onSwapped` juste au-dessus.
    µ._mjs_navEmit('load', { path: evPaths.path, url: evPaths.url, via: via, zone: installedZone, initial: false }, false);
    return;
  }
  // json.module non-chaîne (réponse serveur malformée, nombre/objet) faisait
  // lever .replace() DANS le rappel de succès (exception avalée par le pipeline fetch, page laissée
  // telle quelle sous une URL déjà poussée). Même issue que le module inconnu juste en dessous :
  // rechargement complet, jamais un throw.
  if (typeof json.module !== 'string' || !json.module) {
    window.location.assign(dest);
    return;
  }
  bare = json.module.replace('mjs-', '');
  known = (µ.paths && Object.prototype.hasOwnProperty.call(µ.paths, bare)) ||
    (typeof customElements !== 'undefined' && !!customElements.get(json.module));
  if (!known) {
    // bundle périmé côté client (manifeste ignorant de ce module, et pas déjà
    // défini) : rechargement complet plutôt qu'un montage impossible.
    window.location.assign(dest);
    return;
  }
  // cas nominal — el/zone calculés AVANT l'enveloppe (pushState idem) ; swap (resSet + montage +
  // focus) enveloppé dans la transition de page (mjs-vt), MIROIR des chemins HTML (cf.
  // click/popstate/submit) : avant, ce chemin montait SANS JAMAIS passer par µ._mjs_vtWrapSwap —
  // une transition configurée était perdue dès que le serveur parlait le protocole JSON.
  // opts.onSwapped (optionnel, threadée par les 3 sites d'appel clic/
  // popstate/_mjs_navDispatch) : un scroll posé par l'appelant JUSTE APRÈS le retour (SYNCHRONE) de
  // cette fonction arrivait AVANT la permutation réelle quand µ._mjs_vtWrapSwap DIFFÈRE `swap` (rappel
  // async de document.startViewTransition) — la page QUITTÉE était ramenée en haut avant le swap.
  // onSwapped, si fournie, est appelée ICI-MÊME, DANS swap(), après l'installation et le focus,
  // avant µ._mjs_navRunCallback — toujours dans le MÊME tick que le swap réel, différé ou pas. Branches
  // method:'none' (plus haut) et module:null/404 (plus haut) : rien n'est permuté, onSwapped n'y
  // est JAMAIS appelée (aucun swap à y attacher).
  el = document.createElement(json.module);
  zone = µ._mjs_navMountZone(document, target);
  // même garde que la branche 404 ci-dessus : `dest` hors origine → navigation dure, jamais
  // un pushState qui lève un SecurityError non catché (cf. bandeau plus haut).
  if (opts.push) {
    // même garde de protocole, testée EN PREMIER, que la branche 404 ci-dessus
    // (code dupliqué, même régression blob: même origine, confirmé sur Chromium réel).
    if (liveOrigin && destProtocol !== 'http:' && destProtocol !== 'https:') { µ.warn('[µ.UJS] navigation abandonnée, url hors origine et protocole non http/https : '+ dest); return; }
    if (liveOrigin && destOrigin !== liveOrigin) {
      return µ._mjs_hardNav(dest);
    }
    window.history.pushState({}, '', dest);
  }
  // µ._mjs_vtWrapSwap peut DIFFÉRER `swap` (rappel de
  // document.startViewTransition, asynchrone) : la queue ci-dessous (navigate + mjs:load), avant
  // posée juste APRÈS l'appel à µ._mjs_vtWrapSwap, s'exécutait alors AVANT l'installation réelle —
  // `mjs:load` partait avec `zone: undefined` (`installedZone` pas encore affecté à ce moment) et le
  // routeur se resynchronisait sur l'ANCIEN DOM. `_apresSwap` se rappelle désormais en DERNIÈRE ligne
  // de `swap`, après @callback (même ordre relatif qu'avant : callback puis navigate puis load) :
  // sans transition de vue (`_mjs_vtWrapSwap` appelle `swap()` SYNCHRONEMENT), l'ordre observable reste
  // IDENTIQUE à aujourd'hui.
  var _apresSwap = function() {
    // MIROIR de la queue du swap HTML existant (cf. click/popstate, plus bas) : resynchronise
    // µ.url/<@view>. document.title : la fiche pose le titre si elle en porte un (SYNCHRONE,
    // ci-dessus, avant même cette ligne) ; le <@head><title> d'un composant qui arrive tire ensuite
    // dans sa microtâche et garde toujours le dernier mot ; le silence du serveur (title:null) ne
    // change rien au titre déjà affiché. L'autoloader charge le module seul à l'insertion
    // (MutationObserver mjs_autoloader.ts, observe(document.body) en subtree — rien à appeler ici).
    if (µ.Router && typeof µ.Router.navigate === 'function') { µ.Router.navigate(dest, false); }
    // mjs:load : APRÈS installation ET resynchronisation du routeur. zone: le
    // contenant EFFECTIF retourné par µ._mjs_navInstallInZone (zone.zone est détaché en method:'replace').
    µ._mjs_navEmit('load', { path: evPaths.path, url: evPaths.url, via: via, zone: installedZone, initial: false }, false);
  };
  swap = function() {
    // swap PÉRIMÉ sous transition de vue : `µ._mjs_vtWrapSwap`
    // peut DIFFÉRER `swap` (rappel de document.startViewTransition, asynchrone) ; une navigation plus
    // récente a pu démarrer PENDANT ce délai (`µ._mjs_navSeq` déjà rebumpé) — sans cette garde, le swap
    // périmé installait son propre DOM PAR-DESSUS celui de la navigation gagnante, et sa queue
    // (`_apresSwap` : navigate + mjs:load) partait APRÈS celle de la navigation gagnante (ordre
    // inversé, aggravation du défaut ci-dessus). `opts.seq` posé par les 3 appelants (popstate/
    // clic/_mjs_navDispatch, cf. leurs 3 sites d'appel) ; absent → jamais périmé, comportement identique
    // à avant. Hibernation (µ._mjs_navHibernated/µ.pageCache) : la navigation la PLUS RÉCENTE hiberne à
    // SON tour la page encore affichée (celle-ci n'a pas encore changé, le swap périmé n'a jamais
    // tourné) SOUS LA MÊME CLÉ — son hibernation REMPLACE celle du swap périmé et sera consommée
    // normalement par SON propre swap (µ._mjs_zoneFill) ; le swap périmé, lui, n'a plus rien à consommer
    // en sortant ici — µ._mjs_navDropHibernation() viserait l'hibernation COURANTE (celle de la
    // navigation gagnante) et la détruirait à tort : PAS appelée ici.
    if (opts.seq != null && opts.seq !== µ._mjs_navSeq) { return; }
    // consomme props.flash/props.error AVANT que le sac n'entre au magasin (delete en
    // place sur `json.props`, cf. µ._mjs_navFlash) ; module ujs tree-shaké → garde d'existence.
    if (typeof µ._mjs_navFlash === 'function') { µ._mjs_navFlash(json.props || {}, originEl); }
    if (typeof µ._mjs_resSet === 'function') { µ._mjs_resSet(json.props || {}); }
    // titre posé ICI, SYNCHRONE, AVANT l'installation (même ordre que le chemin HTML,
    // µ._mjs_navApplyHead) : le composant qui arrive peut porter son propre <@head><title>, qui tire
    // ensuite dans SA microtâche (µ.effect, cf. µ._setHead/mjs_runes.ts) et gagne TOUJOURS — aucune
    // priorité codée en dur, seul l'ordre naturel décide.
    if (title) { document.title = title; }
    // valeur RETOURNÉE : le contenant EFFECTIF après installation (zone.zone se détache en
    // method:'replace', cf. µ._mjs_navInstallNodes) — capturée ici pour detail.zone plus bas.
    installedZone = µ._mjs_navInstallInZone(zone, el, method, cache);
    if (typeof µ._mjs_focusAfterSwap === 'function') { µ._mjs_focusAfterSwap(el); }
    // cf. bandeau ci-dessus : APRÈS le focus, AVANT @callback.
    if (typeof opts.onSwapped === 'function') { opts.onSwapped(); }
    // @callback : APRÈS l'installation de la page (état déjà à jour quand le rappel
    // tourne). `status` : 200 par construction (même remarque que la branche 'none' plus haut).
    if (typeof µ._mjs_navRunCallback === 'function') { µ._mjs_navRunCallback(originEl, { path: evPaths.path, url: evPaths.url, status: 200, via: via }); }
    // DERNIÈRE ligne de `swap` : cf. bandeau `_apresSwap` ci-dessus.
    _apresSwap();
  };
  if (typeof µ._mjs_vtWrapSwap === 'function') { µ._mjs_vtWrapSwap(opts.vtLink || null, swap); } else { swap(); }
};

// Canal interne UJS — même moteur que µ.ajax.* (µ._mjs_ajaxRequest, alias de
// `_request` exposé par mjs_ajax.ts) mais pose TOUJOURS l'en-tête
// `X-MJS-Nav: 1` (négociation du protocole de navigation, cf. render-server.ts
// et docs/21-navigation.md) — canal INTERNE, jamais exposé publiquement : un
// µ.ajax.get/post/... appelé par l'application ne porte JAMAIS cet en-tête,
// seuls `_mjs_ajaxGet`/`_mjs_navDispatch` (ce fichier) l'utilisent. Signature calquée
// sur `_request` (method/url/data/success/error/always/timeout/signal) plutôt
// que sur un verbe précis de µ.ajax — un seul point d'entrée pour
// GET/DELETE/POST/PUT/PATCH.
µ._mjs_navRequest = function(method, url, data, success, error, always, timeout, signal) {
  if (typeof µ._mjs_ajaxRequest !== 'function') {
    // module runtime 'ajax' absent de la sélection (mjs.config.json `runtime`) :
    // aucune requête ne peut partir — averti une fois, jamais un throw muet.
    µ.error("[µ.UJS] navigation ujs : module runtime 'ajax' absent (µ._mjs_ajaxRequest introuvable).");
    return;
  }
  return µ._mjs_ajaxRequest({
    method: method,
    url: url,
    data: data,
    headers: { 'X-MJS-Nav': '1' },
    success: success,
    error: error,
    always: always,
    timeout: timeout,
    signal: signal
  });
};
// <<< extrait-test helpers-navigation

// ──────────────────────────────────────────────────────────────────────────
// TRANSITIONS DE PAGE (mjs-vt) — swap du contenant de navigation enveloppé dans l'API View
// Transitions du navigateur, même esprit que @viewTransition (routeur, mjs_router.ts)
// mais au niveau PAGE : cascade attribut du lien déclencheur (`mjs-vt`, converti
// depuis `@pageTransition` par preprocessHtml) > config globale `µ.viewTransition`. Pas de <a>
// pour popstate/submit (pas de clic) → config seule pour ces 2 chemins (`link` vaut
// `null`). Résolution INDÉPENDANTE de celle du routeur (_mjs_vtResolve, niveau <@view>) —
// une transition de page n'a pas de « vue routée ».
// >>> extrait-test _mjs_vtResolvePage
µ._mjs_vtResolvePage = function(link) {
  var attr = link && typeof link.getAttribute === 'function' ? link.getAttribute('mjs-vt') : null;
  if (attr === 'on') { return true; }
  if (attr === 'off' || attr === 'none') { return false; }
  if (attr) { return attr; }
  var cfg = µ.viewTransition;
  return (cfg && cfg !== 'none') ? cfg : false;
};
// <<< extrait-test _mjs_vtResolvePage

// Enveloppe `swap` (fonction SYNCHRONE : replaceWith + restauration de scroll +
// focus, TOUT ce qui existe déjà à chaque point d'appel, ORDRE INTERNE inchangé)
// dans `document.startViewTransition` si la garde d'environnement ET la résolution
// sont actives ; sinon exécute `swap` directement — chemin historique inchangé.
// Résolution en CHAÎNE (préréglage) → µ._mjs_vtApplyPreset AVANT de démarrer la
// transition (mjs_vt_presets.ts, chargé avant mjs_router/mjs_ujs — ordre CANONICAL,
// bundler/index.ts). `µ.Router._mjs_vtEnabled` : garde D'ENVIRONNEMENT PARTAGÉE avec le
// routeur (cf. son commentaire dans mjs_router.ts) — ni dupliquée ni redéfinie ici ;
// absente (runtime tree-shaké sans 'router') ⇒ repli silencieux sur `swap()` direct.
// >>> extrait-test _mjs_vtWrapSwap
µ._mjs_vtWrapSwap = function(link, swap) {
  var rt = µ.Router;
  if (!rt || typeof rt._mjs_vtEnabled !== 'function' || !rt._mjs_vtEnabled()) { return swap(); }
  var resolved = µ._mjs_vtResolvePage(link);
  if (!resolved) { return swap(); }
  // rideaux « à travers le noir » : mêmes règles que le routeur
  if (typeof µ._mjs_vtCurtainRun === 'function' && typeof resolved === 'string' && µ._mjs_vtCurtainRun(resolved, swap)) { return; }
  if (typeof µ._mjs_vtApplyPreset === 'function') { µ._mjs_vtApplyPreset(resolved); }
  // couche de lévitation : mêmes hooks que le routeur (cf. mjs_vt_presets.ts)
  var hoist = (typeof µ._mjs_vtHoistStart === 'function') ? µ._mjs_vtHoistStart() : null;
  // pose html[data-mjs-vt] (docs/17-router.md:420), même garde µ._mjs_vtParse que
  // mjs_router.ts : runtime tree-shaké sans 'vt_presets' malgré un préréglage résolu → repli 'on'.
  // Garde sur document.documentElement lui-même : de nombreux tests existants (vt-presets-ujs.test.ts
  // et consorts) stubbent `document` par un objet minimal { startViewTransition }, sans documentElement.
  // JETON DE SÉQUENCE, partagé avec mjs_router.ts (même
  // compteur µ._mjs_vtAttrSeq, même attribut html[data-mjs-vt]) : deux transitions chevauchées (celle-ci
  // démarre pendant qu'une PRÉCÉDENTE tourne encore) — le retrait à `finished` de la précédente ne
  // doit RETIRER l'attribut QUE si aucune pose plus récente n'a eu lieu depuis ; sinon il efface
  // celui de la transition ACTIVE (prouvé Chromium).
  var vtAttrSeq = (µ._mjs_vtAttrSeq = (µ._mjs_vtAttrSeq || 0) + 1);
  if (document.documentElement) { document.documentElement.dataset.mjsVt = (typeof resolved === 'string' && typeof µ._mjs_vtParse === 'function') ? µ._mjs_vtParse(resolved).base : 'on'; }
  var t;
  try {
    t = document.startViewTransition(hoist ? function() { swap(); return µ._mjs_vtHoistSwapSettled(hoist); } : swap);
  } catch (e) {
    // startViewTransition peut lever (état invalide) : l'attribut ne reste pas collé
    if (document.documentElement) { delete document.documentElement.dataset.mjsVt; }
    throw e;
  }
  // retrait à finished, y compris en échec (transition annulée/rejetée), SEULEMENT si
  // le compteur n'a pas bougé depuis la pose (aucune transition plus récente encore active).
  var clearVtAttr = function() { if (µ._mjs_vtAttrSeq === vtAttrSeq && document.documentElement) { delete document.documentElement.dataset.mjsVt; } };
  if (t && t.finished) { t.finished.then(clearVtAttr, clearVtAttr); }
  // transition sautée (enchaînement rapide) → `ready`/`finished` rejettent sans
  // consommateur : on absorbe (cf. le même garde dans mjs_router.ts)
  if (t && t.ready && typeof t.ready.catch === 'function') { t.ready.catch(function() {}); }
  // nettoyage à FINISHED, jamais ready (image VIVANTE côté new, cf. _mjs_vtHoistEnd)
  if (hoist && t && t.finished) { var done = function() { µ._mjs_vtHoistEnd(hoist); }; t.finished.then(done, done); }
  if (!hoist && t && t.finished && typeof t.finished.catch === 'function') { t.finished.catch(function() {}); }
  return t;
};
// <<< extrait-test _mjs_vtWrapSwap

// >>> extrait-test popstate-listener
window.addEventListener('popstate', function(e) {
  var cachedNodes, currentRoot, destination, evPaths, fullDest, leavingPath, ref, seq, destHash;
  // ancre non-route (`#footnote`, sans
  // le `/` de route) : `popstate` tire AUSSI pour un retour PAR-DESSUS un
  // simple ancrage en page, empilé NATIVEMENT par le navigateur (le clic sur
  // `<a href="#footnote">` n'est JAMAIS passé par notre code — cf. le handler
  // de clic, qui l'exclut explicitement via `isHashRoute`). Sans le même
  // garde-fou ici, `_mjs_getMatchPath` prend TOUT ce qui suit `#` sans distinguer
  // route et ancre → route vers un chemin bidon (`/footnote`) qui ne matche
  // AUCUNE route déclarée → `_mjs_injectViewsForComponent` VIDE TOUTES les
  // `<@view>` (aucune route ne correspond). Une ancre non-route n'est PAS un
  // changement de page : le scroll natif du navigateur fait déjà le travail,
  // on ne touche à RIEN (mêmes vues, même contenu affiché).
  destHash = window.location.hash;
  destination = window.location.pathname + window.location.search;
  // ne court-circuiter QUE si la
  // PAGE ne change pas. Le fix 1ʳᵉ passe sortait dès que le hash de destination
  // était une ancre non-route (`#footnote`), en supposant qu'un pop d'ancre est
  // toujours un mouvement DANS la page. FAUX : un retour arrière INTER-PAGES peut
  // atterrir sur une URL portant une ancre (`/b#footnote` empilée nativement par
  // un clic `<a href="#footnote">` sur /b, puis nav ujs vers /c). Le retour
  // /c → /b#footnote sortait immédiatement : aucun swap, `_mjs_lastUjsPath`/`_mjs_navSeq`
  // intacts → contenu de /c sous l'URL /b#footnote, toute la chaîne pageCache
  // corrompue. On ne sort que si la page est identique (vrai ancrage en page).
  if (destHash && !destHash.startsWith('#/') && destination === µ._mjs_lastUjsPath) { return; }
  // Ancre non-route EXCLUE du chemin routé (sinon `_mjs_getMatchPath` prendrait
  // `footnote` pour une route et viderait les vues) ; une vraie route hash
  // (`#/…`) est conservée.
  fullDest = destination + (destHash.startsWith('#/') ? destHash : '');
  var _mzCur = µ._mjs_navMountZone(document, null);
  currentRoot = _mzCur.zone;
  leavingPath = µ._mjs_lastUjsPath;
  // Toute navigation historique INVALIDE les fetchs en vol : sans ce bump,
  // une réponse tardive (clic A→B puis Précédent avant la réponse) écrasait
  // la page restaurée avec le contenu de B alors que l'URL affichait A.
  µ._mjs_navSeq++;
  // Abandon réel du fetch de navigation précédent (cf. `_mjs_abortStaleNav`, plus
  // haut) : posé ICI, AVANT tout branchement cache-hit/cache-miss/hash — un
  // retour arrière doit tuer un fetch encore en vol quelle que soit l'issue
  // de CE popstate (`_navCtrl` n'est consommé que par la branche refetch,
  // plus bas, mais l'abandon lui-même est inconditionnel).
  var _navCtrl = typeof µ._mjs_abortStaleNav === 'function' ? µ._mjs_abortStaleNav() : null;
  // Navigation hash pure (même page) : le routeur interne suffit.
  if (leavingPath === destination) {
    if ((ref = µ.Router) == null) { return; }
    // slash final posé à la main : nettoie l'URL AVANT de router — sinon `_mjs_updateUrlStore`
    // mémorise la forme sale et le listener hashchange sautera son navigate (même matchPath)
    if (ref._mjs_canonicalizeUrl) { ref._mjs_canonicalizeUrl(); destHash = window.location.hash; fullDest = destination + (destHash.startsWith('#/') ? destHash : ''); }
    return ref.navigate(fullDest, false);
  }
  // le contenu du contenant est hiberné à chaque départ, contenant compris quand c'est
  // <body> (avant : <body> en était exclu du pageCache). La page QUITTÉE est cachée à son
  // tour : avant, seul le chemin « clic » alimentait le cache — un retour puis « suivant »
  // trouvait un cache vide → URL avancée mais contenu figé (bouton suivant cassé). Simple
  // PHOTOGRAPHIE (lecture de childNodes, aucun retrait) : le retrait RÉEL des nœuds n'a lieu qu'au
  // prochain µ._mjs_zoneFill sur cette zone (swap cache-hit ci-dessous ou callback réseau plus
  // bas) — exactement comme `replaceWith` ne détachait l'ancien contenu QU'AU swap, jamais
  // avant. Un retrait immédiat ici viderait le contenant pendant tout un fetch réseau en vol.
  var _cacheZone = µ._mjs_navCacheZone();
  // mjs:visit, non annulable (PAS de before-visit ici : l'URL a déjà bougé au popstate,
  // annuler serait un mensonge — même choix que Turbo). `cached` : cette navigation sera servie depuis
  // pageCache sans requête réseau. Émis APRÈS le court-circuit hash pur plus haut, qui n'émet rien.
  // µ._mjs_navEmitPaths : réutilisé pour `load` plus bas (rien ne réassigne destination/fullDest
  // entre ces émissions, cache-hit comme réseau).
  evPaths = µ._mjs_navEmitPaths(fullDest);
  µ._mjs_navEmit('visit', { path: evPaths.path, url: evPaths.url, via: 'popstate', cached: !!(_cacheZone && µ.pageCache && µ.pageCache.has(destination)) }, false);
  µ._mjs_navHibernate(_cacheZone, leavingPath);
  if (_cacheZone && µ.pageCache.has(destination)) {
    cachedNodes = µ.pageCache.get(destination);
    // `seq` (déclarée en tête de listener, cf. sa liste `var`)
    // n'est PAS ENCORE affectée ICI : seule la branche cache-MISS plus bas (hors de portée depuis le
    // `return` de cette branche cache-hit) la fixe — capture EXPLICITE de la valeur COURANTE, sans
    // quoi la garde de fraîcheur de `_swapPopCache` juste en dessous comparerait `undefined` à
    // `µ._mjs_navSeq` et se croirait TOUJOURS périmée (plus aucun cache-hit ne swapperait).
    seq = µ._mjs_navSeq;
    var _swapPopCache = function() {
      // swap PÉRIMÉ sous transition de vue : cf. bandeau de `swap` dans µ._mjs_navApplyJson.
      if (seq !== µ._mjs_navSeq) { return; }
      var _cni;
      µ._mjs_navRestoreHead(cachedNodes._mjs_mjsHead); // même ordre que le chemin réseau : tête d'abord, contenu ensuite
      µ._mjs_navTransplantPermanents(_cacheZone, cachedNodes); // ce site vide `_cacheZone` en court-circuitant µ._mjs_navInstallNodes
      µ._mjs_zoneFill(_cacheZone, cachedNodes);
      // Fin d'hibernation : sans ce reset, l'arbre restauré gardait le flag à
      // vie et ses composants échappaient À JAMAIS à la destruction différée.
      for (_cni = 0; _cni < cachedNodes.length; _cni++) { if (cachedNodes[_cni].nodeType === 1) { cachedNodes[_cni]._mjs_page_cached = false; } }
      µ._mjs_navTrackZone(null, null); // le contenant survit, plus rien à suivre
      µ._mjs_navCachePolicy = cachedNodes._mjs_mjsCachePolicy || 'cache-first'; // la politique de CETTE page revit avec elle
      µ._mjs_lastUjsPath = destination;
      µ._mjs_restoreScroll(destination);
      // Accessibilité : cache-hit = swap synchrone, focus quand même déplacé
      // (cf. `_mjs_focusAfterSwap` plus haut) — l'origine du contenu (cache ou
      // réseau) n'a pas à changer le comportement pour un lecteur d'écran.
      // APRÈS `_mjs_restoreScroll` (ordre voulu : `{preventScroll:true}` empêche déjà
      // tout scroll parasite du focus, mais la restauration de position reste
      // l'étape qui « termine » la navigation, le focus la clôt).
      if (typeof µ._mjs_focusAfterSwap === 'function') { µ._mjs_focusAfterSwap(µ._mjs_navFirstEl(cachedNodes)); }
      // 'revalidate' : le cache-hit reste immédiat (rien ci-dessus n'attend le réseau), une
      // vérification part en fond APRÈS l'affichage (jamais avant, zéro régression de vitesse).
      if (cachedNodes._mjs_mjsCachePolicy === 'revalidate') { µ._mjs_navRevalidate(_cacheZone, destination); }
      // DERNIÈRE ligne de `_swapPopCache` : cf. bandeau
      // `_finPopCache` ci-dessous.
      _finPopCache();
    };
    // µ._mjs_vtWrapSwap peut DIFFÉRER `_swapPopCache` (rappel de
    // document.startViewTransition, asynchrone) : la queue ci-dessous (navigate + mjs:load), avant
    // posée juste APRÈS l'appel à µ._mjs_vtWrapSwap, s'exécutait alors AVANT l'installation réelle —
    // `_cacheZone` était déjà correct (capturé plus haut, avant hibernation) mais le MOMENT était
    // faux : le routeur se resynchronisait sur l'ancien DOM, `mjs:load` partait trop tôt.
    // `_finPopCache` se rappelle désormais en DERNIÈRE ligne de `_swapPopCache` : sans transition de
    // vue (`_mjs_vtWrapSwap` appelle `_swapPopCache()` SYNCHRONEMENT), l'ordre observable reste IDENTIQUE
    // à aujourd'hui. Valeur de retour de `ref.navigate(...)` : n'est plus propagée jusqu'à
    // l'appelant (traverserait désormais une fermeture potentiellement asynchrone) — sans effet,
    // aucun appelant ne la consommait (retour d'un event listener `popstate`, ignoré par le
    // navigateur ; grep -a "_mjs_ujsOnClick(\|popstate" sur ce fichier : aucun site n'exploite ce retour).
    var _finPopCache = function() {
      if ((ref = µ.Router) != null) { ref.navigate(fullDest, false); }
      // mjs:load : APRÈS installation ET resynchronisation du routeur. zone: `_cacheZone`
      // (contenant réellement visé, capturé AVANT hibernation), pas µ._mjs_navCacheZone() (menteur en 'replace').
      µ._mjs_navEmit('load', { path: evPaths.path, url: evPaths.url, via: 'popstate', zone: _cacheZone, initial: false }, false);
    };
    // @viewTransition (mjs-vt) : pas de lien déclencheur au popstate → résolution config seule.
    if (typeof µ._mjs_vtWrapSwap === 'function') { µ._mjs_vtWrapSwap(null, _swapPopCache); } else { _swapPopCache(); }
    return;
  }
  // Cache miss (entrée jamais visitée dans cette session SPA, ou évincée du
  // LRU, ou dernier montage en 'replace') : on re-fetch la page comme un clic —
  // avant, seul le routeur hash tournait et le CONTENU restait celui d'une
  // autre URL. `µ._mjs_navRequest` (canal interne) pose l'en-tête
  // `X-MJS-Nav` — la réponse peut être JSON (protocole) ou HTML (repli).
  seq = µ._mjs_navSeq;
  if (currentRoot) {
    // µnav (état réactif public, mjs_store_globals.ts) : posé UNIQUEMENT ici
    // (refetch réseau, pas le cache-hit synchrone ci-dessus ni le hash pur
    // plus haut) — chaque app affiche ainsi sa barre/spinner SEULEMENT quand
    // une requête est réellement en vol.
    if (µ.nav) { µ.nav.active = true; µ.nav.href = fullDest; }
    µ._mjs_navProgressStart(); // armé indépendamment de µ.nav (opt-in propre, cf. sa déclaration)
    return µ._mjs_navRequest('GET', fullDest, void 0, function(html, finalUrl, _schemaNom, nav) {
      var doc, liveRoot, newRoot, parser, ref1, newNodes, _navTarget, _navMethod, _navCache, liveInfo, _zones, _installedZone;
      if (seq !== µ._mjs_navSeq) {
        return; // une navigation plus récente a gagné
      }
      if (µ.nav) { µ.nav.active = false; µ.nav.href = null; }
      µ._mjs_navProgressStop();
      if (html && typeof html === 'object') {
        // chemin JSON du protocole de navigation : l'historique a déjà
        // bougé (popstate), aucun push ici — même en cas de redirection
        // serveur suivie par fetch (`finalUrl` ≠ destination), l'URL affichée
        // reste celle de l'historique (comportement HTML miroir ci-dessous).
        // µ._mjs_restoreScroll(destination) passé en onSwapped (plus un appel
        // synchrone juste après, cf. bandeau du swap nominal dans µ._mjs_navApplyJson) : le commentaire
        // ci-dessous (« parité branche HTML : montage JSON synchrone ») était FAUX dans le cas général
        // — µ._mjs_vtWrapSwap peut DIFFÉRER le swap, exactement comme au clic — µ._mjs_restoreScroll doit donc
        // s'exécuter DANS le swap réel, qu'il soit synchrone ou différé.
        // `µ._mjs_lastUjsPath` DÉPLACÉ dans ce MÊME
        // onSwapped (même raisonnement que `_mjs_restoreScroll` ci-dessus) : posé SYNCHRONE ici, il
        // pouvait déjà pointer la destination alors que le swap réel (transition différée) n'avait
        // pas encore eu lieu — une 2e navigation démarrée dans ce délai hibernait le DOM ENCORE
        // AFFICHÉ sous la clé de CETTE destination (pageCache empoisonné).
        // Même ordre que le modèle `_swapPopNet`/
        // `_swapPopCache` (lastUjsPath, PUIS restoreScroll).
        µ._mjs_navApplyJson(html, finalUrl, { push: false, via: 'popstate', seq: seq, onSwapped: function() { µ._mjs_lastUjsPath = µ._mjs_finalPathFor(finalUrl, destination); µ._mjs_restoreScroll(destination); } });
        return;
      }
      // X-MJS-Reload : AVANT la garde de version, AVANT tout parse — un ordre explicite du
      // serveur passe avant une version déduite (même priorité que le chemin JSON).
      if (µ._mjs_navReloadAsked(nav && nav.reload)) {
        µ._mjs_navHardReload(finalUrl || destination);
        return;
      }
      // même garde de version que le chemin JSON (json.version), via l'en-tête HTTP
      // pour un serveur qui ne parle que HTML : bundle client changé depuis le chargement de
      // la page en cours ⇒ rechargement complet plutôt qu'un swap avec l'ancien JS. AVANT tout swap.
      if (nav && nav.version && µ.version && nav.version !== µ.version) {
        window.location.assign(finalUrl || destination);
        return;
      }
      // X-MJS-Method: none : le back répond « ne bouge pas » — corps ignoré (AVANT tout parse),
      // rien d'installé. µ._mjs_navDropHibernation annule l'hibernation posée un peu plus haut pour CETTE
      // navigation (les nœuds affichés restent affichés, pas hibernés pour rien).
      if (µ._mjs_navMethodOf(nav && nav.method) === 'none') {
        µ._mjs_navDropHibernation();
        return;
      }
      // target/method voyagent désormais aussi sur le chemin HTML (en-têtes X-MJS-Target/
      // X-MJS-Method, le serveur les pose) : même normalisation que le protocole JSON. `cache`
      // pareil (X-MJS-Cache), repli balise <meta name="mjs-cache"> lue dans `doc` une fois parsé (cf.
      // µ._mjs_navCacheOf) — calculé APRÈS le parse, juste en dessous.
      _navTarget = (nav && typeof nav.target === 'string' && nav.target) ? nav.target : null;
      _navMethod = µ._mjs_navMethodOf(nav && nav.method);
      parser = new DOMParser();
      doc = parser.parseFromString(html, 'text/html');
      _navCache = µ._mjs_navCacheOf(doc, nav && nav.cache);
      // Re-query (pas la closure) : les DEUX contenants (réponse et page) sont résolus ENSEMBLE AU
      // MOMENT DU SWAP (µ._mjs_navResolveZones : cible absente de la réponse → repli <body> des deux
      // côtés), jamais capturés plus tôt (`_mzCur`, avant le fetch asynchrone) — le contenant courant a
      // pu être remplacé entre-temps, remplir un nœud détaché était un no-op muet (même motif que le
      // handler de clic, corrigé ici — PRÉSERVÉ ici avec `target`).
      _zones = µ._mjs_navResolveZones(doc, _navTarget);
      newRoot = _zones.newZone;
      liveInfo = _zones.liveInfo;
      liveRoot = liveInfo.zone;
      if (newRoot && liveRoot) {
        newNodes = Array.prototype.slice.call(newRoot.childNodes);
        µ._mjs_navWarnScripts(newNodes);
        var _swapPopNet = function() {
          // swap PÉRIMÉ sous transition de vue : `seq` capturé
          // plus haut (avant le fetch réseau) ; cf. bandeau de `swap` dans µ._mjs_navApplyJson.
          if (seq !== µ._mjs_navSeq) { return; }
          // chemin HTML, target/method désormais suivis COMME le JSON (µ._mjs_navInstallNodes
          // gère replace/append/update + suivi de zone) — plus jamais figé sur <body>.
          // valeur RETOURNÉE : le contenant EFFECTIF après installation (liveInfo.zone se
          // détache en method:'replace', cf. µ._mjs_navInstallNodes) — capturée ici pour detail.zone plus bas.
          µ._mjs_navApplyHead(doc); // tête d'abord (synchrone) : un <@head><title> qui arrive tirera ensuite dans sa microtâche et gagnera
          _installedZone = µ._mjs_navInstallNodes(liveInfo, newNodes, _navMethod, _navCache);
          // on ne TOUCHE PAS l'URL
          // (elle vient de l'historique) mais si le serveur a redirigé (`finalUrl`
          // ≠ destination), le contenu affiché est celui de finalUrl : `_mjs_lastUjsPath`
          // doit le refléter, sinon le prochain départ archive ce contenu redirigé
          // sous la clé historique (pageCache empoisonné).
          µ._mjs_lastUjsPath = µ._mjs_finalPathFor(finalUrl, destination);
          µ._mjs_restoreScroll(destination);
          // Focus APRÈS la restauration de scroll (ordre voulu, cf. cache-hit plus haut).
          if (typeof µ._mjs_focusAfterSwap === 'function') { µ._mjs_focusAfterSwap(µ._mjs_navFirstEl(newNodes)); }
          // DERNIÈRE ligne de `_swapPopNet` : cf. bandeau
          // `_finPopNet` ci-dessous.
          _finPopNet();
        };
        // MÊME motif que `_swapPopCache` ci-dessus (µ._mjs_vtWrapSwap
        // peut DIFFÉRER `_swapPopNet`) : `_finPopNet` regroupe navigate + mjs:load et se rappelle en
        // DERNIÈRE ligne de `_swapPopNet` — sans transition de vue, ordre observable IDENTIQUE à
        // aujourd'hui. Valeur de retour de `ref1.navigate(...)` : plus propagée (cf. bandeau
        // `_finPopCache`, même raisonnement — aucun appelant ne consommait ce retour).
        var _finPopNet = function() {
          if ((ref1 = µ.Router) != null) { ref1.navigate(fullDest, false); }
          // mjs:load : APRÈS installation ET resynchronisation du routeur. zone:
          // `_installedZone` (contenant EFFECTIF retourné par µ._mjs_navInstallNodes), pas µ._mjs_navCacheZone()
          // (menteur en 'replace') ni liveInfo.zone (détaché en 'replace', cf. µ._mjs_navInstallNodes).
          // evPaths DÉLIBÉRÉMENT PAS recalculé depuis finalUrl ici : une redirection au popstate
          // laisse l'URL de l'historique affichée, `detail` doit rester cohérent avec ce que voit l'utilisateur.
          µ._mjs_navEmit('load', { path: evPaths.path, url: evPaths.url, via: 'popstate', zone: _installedZone, initial: false }, false);
        };
        // @viewTransition (mjs-vt) : pas de lien déclencheur au popstate → résolution config seule.
        if (typeof µ._mjs_vtWrapSwap === 'function') { µ._mjs_vtWrapSwap(null, _swapPopNet); } else { _swapPopNet(); }
        return;
      } else {
        return window.location.reload();
      }
    }, function() {
      // repli SEULEMENT si cette
      // navigation est encore la plus récente : un pop périmé (une nav plus
      // récente a déjà l'URL et le DOM) n'a aucune raison d'imposer un full reload.
      if (seq !== µ._mjs_navSeq) { return; }
      if (µ.nav) { µ.nav.active = false; µ.nav.href = null; }
      µ._mjs_navProgressStop();
      // Échec réseau au pop : sans repli, l'URL pointait une page jamais
      // affichée. Le reload laisse le navigateur trancher (cache HTTP, erreur).
      return window.location.reload();
    }, void 0, void 0, _navCtrl && _navCtrl.signal);
  }
  return (ref = µ.Router) != null ? ref.navigate(fullDest, false) : void 0;
});
// <<< extrait-test popstate-listener

// hashchange : un `location.hash = '#/…'` PROGRAMMATIQUE (ou une édition directe
// du fragment dans la barre d'adresse) n'émet ni clic ni popstate — sans ce
// listener, le routeur interne ne réagissait qu'aux clics de liens et au
// back/forward, et piloter l'URL par code ne routait pas.
//
// Trois garde-fous :
//   1. On ne route que les hash de ROUTE (`#/…`) : un ancre `#section` doit
//      garder son scroll natif et ne PAS vider les <@view> (même convention que
//      le handler de clic, `isHashRoute`).
//   2. Anti-double back/forward : un retour sur route hash émet popstate ET
//      hashchange ; popstate a déjà navigué (et posé `_mjs_lastNavPath`), donc si le
//      matchPath n'a pas bougé on saute. (Les clics passent par pushState qui
//      n'émet PAS hashchange → aucun conflit de ce côté.)
//   3. Même si l'ordre popstate/hashchange s'inversait, re-naviguer vers le même
//      matchPath est visuellement idempotent (injectView rafraîchit au lieu de
//      remonter) — le pire cas reste bénin.
// >>> extrait-test hashchange-listener
window.addEventListener('hashchange', function() {
  var hash, matchPath, ref, hashQuery, qi;
  hash = window.location.hash;
  if (hash && !hash.startsWith('#/')) {
    return;
  }
  if ((ref = µ.Router) == null) {
    return;
  }
  // Slash final tapé à la main / lien codé en dur (`#/about/`) : on nettoie
  // l'URL AVANT de router. `replaceState` (dans _mjs_canonicalizeUrl) ne réémet pas
  // hashchange → pas de ré-entrée ; `window.location.href` reflète déjà la forme
  // propre pour le `navigate` ci-dessous.
  if (ref._mjs_canonicalizeUrl) { ref._mjs_canonicalizeUrl(); }
  matchPath = ref._mjs_getMatchPath(window.location.href);
  // comparer SEULEMENT `matchPath`
  // (comme avant) confondait "même route" avec "rien n'a changé" : un
  // changement de QUERY seul (même route, ex. `#/liste?tri=nom` →
  // `#/liste?tri=prix`) laisse `matchPath` inchangé → `navigate()` (donc
  // `_mjs_updateUrlStore`) était sauté en entier → `µ.url.query` restait figé
  // sur l'ancienne query à vie. On compare maintenant AUSSI la query — le
  // garde-fou anti-double-fire (popstate a déjà navigué) ne saute que si
  // route ET query sont TOUTES LES DEUX identiques à la dernière navigation.
  hash = window.location.hash; // relu : _mjs_canonicalizeUrl a pu le modifier
  qi = hash.indexOf('?');
  hashQuery = qi !== -1 ? hash.slice(qi + 1) : '';
  if (matchPath === ref._mjs_lastNavPath && hashQuery === ref._mjs_lastNavQuery) {
    // même route mais hash nettoyé par `_mjs_canonicalizeUrl` (slash final) : resync `µ.url`
    if (µ.url != null && µ.url.hash !== window.location.hash) { ref._mjs_updateUrlStore(matchPath); }
    return;
  }
  return ref.navigate(window.location.href, false);
});
// <<< extrait-test hashchange-listener

// relance partagée @confirm (clic ET submit, cf. les deux gates plus bas) — une
// fois la promesse de µ.confirm résolue à true, rejoue l'action d'origine :
// neutralise mjs-confirm le temps du replay (les gates retraversés laissent
// alors passer), puis restaure — dépose/redépose SYNCHRONE, aucune fenêtre
// d'incohérence, pas de jeton à tenir. clickTarget (relance CLIC uniquement)
// GAGNE TOUJOURS sur form quand fourni — même si le porteur mjs-confirm est
// un <form> : on reclique la cible RÉELLEMENT cliquée d'origine (pas
// forcément confirmEl — icône, span…), pour préserver EXACTEMENT la
// sémantique du clic accepté synchrone (un clic inerte reste inerte, un
// bouton submit re-déclenche nativement sa soumission). La voie soumission
// directe (form/requestSubmit/submit) ne sert donc qu'au gate SUBMIT.
// `submitter` (4e paramètre, mémorisé côté gate
// SUBMIT depuis `e.submitter`) — quand `confirmEl` est un WRAPPER (mjs-confirm sur le <form> ou
// un ancêtre, pas sur le bouton), `confirmEl.form` n'existe pas et la voie soumission directe
// perdait le soumissionnaire réel (formaction/formtarget/formmethod du bouton). Repli :
// `clickTarget.closest(...)` si la relance CLIC n'a pas de `.click` exploitable.
// >>> extrait-test _mjs_ujsConfirmRefire
µ._mjs_ujsConfirmRefire = function(confirmEl, form, clickTarget, submitter) {
  var saved, target, realSubmitter, isSubmitBtn;
  saved = confirmEl.getAttribute('mjs-confirm');
  confirmEl.removeAttribute('mjs-confirm');
  try {
    if (clickTarget && typeof clickTarget.click === 'function') {
      clickTarget.click();
    }
    else {
      target = form || (confirmEl.tagName === 'FORM' ? confirmEl : null);
      if (target) {
        if (typeof target.requestSubmit === 'function') {
          // `confirmEl` PEUT être un ancêtre form-associated NON-bouton (<fieldset mjs-confirm>
          // englobant le bouton d'envoi) : `.form` existe mais requestSubmit(confirmEl) lève une
          // TypeError native AVANT tout dispatch — validé comme un VRAI bouton de soumission avant
          // de le passer, sinon repli sur submitter/realSubmitter/bare (comme non form-associated).
          isSubmitBtn = typeof confirmEl.matches === 'function' && confirmEl.matches('button, input[type="submit"], input[type="image"]');
          try {
            if (confirmEl !== target && confirmEl.form === target && isSubmitBtn) { target.requestSubmit(confirmEl); }
            else if (submitter) {
              // `submitter` transmis par l'appelant (e.submitter mémorisé, gate SUBMIT) : DÉJÀ
              // vérifié par le navigateur comme soumissionnaire de CE <form> — aucun re-test `.form`.
              target.requestSubmit(submitter);
            }
            else if (clickTarget && typeof clickTarget.closest === 'function' && (realSubmitter = clickTarget.closest('button, input[type="submit"], input[type="image"]')) && realSubmitter.form === target) {
              // repli : bouton retrouvé depuis la cible du clic d'origine (relance CLIC sans `.click`
              // exploitable) — `.form === target` vérifie qu'il appartient bien à CE formulaire.
              target.requestSubmit(realSubmitter);
            }
            else { target.requestSubmit(); } // sans soumissionnaire trouvé : comportement d'origine
          }
          catch (reqErr) {
            // repli ultime (cas non prévu) : jamais une exception qui fuit hors du `.then()`
            // appelant (promesse orpheline, formulaire jamais soumis en silence) — averti, pas avalé.
            µ.warn('[µ.UJS] @confirm : requestSubmit('+ (confirmEl.tagName || '?').toLowerCase() +') a échoué après acceptation, repli sur requestSubmit() nu — '+ reqErr);
            // GARDE MUETTE : le repli lui-même peut échouer
            // (2e échec) — jamais un `catch` vide, averti nommément plutôt qu'avalé en silence.
            try { target.requestSubmit(); } catch (e) { µ.warn('[µ.UJS] @confirm : relance de requestSubmit() nu a ÉGALEMENT échoué, formulaire non soumis — '+ e); }
          }
        }
        else if (typeof target.submit === 'function') { target.submit(); }
      }
      else if (typeof confirmEl.click === 'function') { confirmEl.click(); }
    }
  }
  finally {
    if (saved != null) { confirmEl.setAttribute('mjs-confirm', saved); }
  }
};
// <<< extrait-test _mjs_ujsConfirmRefire

// Nommé (au lieu d'anonyme) : réutilisé tel quel comme listener du PONT SHADOW
// (µ._mjs_ujsShadowAttach, plus bas) — un composant en Shadow DOM fermé a besoin
// EXACTEMENT du même handler, posé directement sur son shadow root (cf. le
// commentaire de µ._mjs_ujsShadowAttach pour le pourquoi du retargeting).
// >>> extrait-test _mjs_ujsOnClick
µ._mjs_ujsOnClick = function(e) {
  var cachedNodes, currentPath, currentRoot, destPath, destination, evPaths, fullDest, isHashRoute, isSamePage, link, ref, ref3, ref4, seq, target;
  // preventDefault ANTÉRIEUR seulement (document ou DOM léger) — les handlers de composant courent après le pont shadow (capture, :2151)
  if (e.defaultPrevented) {
    return;
  }
  // Bouton gauche seul — extrait du garde combiné modificateurs (déplacé plus
  // bas, cf. commentaire) : un clic milieu/droit n'a rien à confirmer non plus.
  if (e.button !== 0) {
    return;
  }
  target = µ.realTarget(e);
  // CONFIRMATION AVANT ACTION (@confirm → mjs-confirm) : HISSÉE tout en tête,
  // AVANT même `link = target.closest('a')` — un bouton NU (sans <a>
  // englobant) doit lui aussi être confirmé (avant ce hissage, `!link`
  // sortait plus haut et un bouton sans lien n'atteignait jamais cette gate).
  // Remonte du nœud RÉELLEMENT cliqué (pas forcément `link` : une icône à
  // l'intérieur, un <button>, par ex.) au porteur `mjs-confirm` le plus
  // proche (lien, bouton, formulaire — `closest` ne distingue pas la balise,
  // seul l'attribut compte). Refus → STOP TOTAL : `preventDefault` (aucune
  // navigation, ni ajax ni native) + `stopImmediatePropagation` — bloque
  // AUSSI les listeners délégués du COMPOSANT lui-même posés sur le même
  // shadow root (cf. µ._mjs_ujsShadowAttach/mjs_element.ts : le pont écoute
  // AVANT _mjs_bindEvents, donc ce stop coupe la remontée avant le routeur
  // d'événements du composant).
  // Idempotence PAR ÉVÉNEMENT shadow OPEN (SSR
  // shadowMode:'open', reprise dans mjs_element.ts) : `µ.realTarget`
  // (composedPath()[0]) voit la VRAIE cible aussi bien depuis le pont (shadow
  // root, capture) que depuis CE listener document (bulle) — rien ne les
  // masque l'un de l'autre, contrairement au closed (retargeting natif). Le
  // MÊME objet Event traverse les deux, sans marqueur le gate tournait deux
  // fois : 2 popups pour 1 clic ACCEPTÉ (un refus, lui, était déjà protégé —
  // `stopImmediatePropagation` juste en dessous coupe la remontée avant le 2e
  // passage). `_mjs_mjsConfirmGated` posé au 1er passage : le 2e saute le gate
  // mais poursuit le reste du handler normalement (lien/canonicalisation
  // doivent quand même tourner au niveau document, comme avant ce fix).
  // le marqueur `_mjs_mjsConfirmGated` ne se pose plus
  // qu'APRÈS avoir trouvé un VRAI porteur `[mjs-confirm]` (déplacé DANS le `if` ci-dessous) : un
  // composant en shadow fermé qui en contient un AUTRE (lui aussi shadow fermé) fait tourner le
  // pont EXTERNE avant le pont INTERNE (capture) — depuis l'externe, `target` (composedPath()[0])
  // est TRONQUÉ par le navigateur à l'hôte du composant interne (nœuds d'un shadow fermé
  // invisibles depuis l'extérieur), `closest('[mjs-confirm]')` n'y trouve donc RIEN. Poser le
  // marqueur quand même (ancien code) fermait la garde AVANT que le pont interne — seul à voir le
  // vrai bouton — ait pu jouer µ.confirm : la suppression partait sans aucune popup. L'idempotence
  // shadow OUVERT ci-dessus reste garantie : le 1er passage qui TROUVE le porteur marque l'événement.
  if (!e._mjs_mjsConfirmGated) {
    var _confirmEl = typeof target.closest === 'function' ? target.closest('[mjs-confirm]') : null;
    if (_confirmEl && typeof _confirmEl.hasAttribute === 'function' && _confirmEl.hasAttribute('mjs-confirm')) {
      e._mjs_mjsConfirmGated = true;
      // pending : modale déjà ouverte pour CET élément, clics avalés sans re-appeler µ.confirm
      if (_confirmEl._mjs_mjsConfirmPending) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      var _res = typeof µ.confirm === 'function' ? µ.confirm(_confirmEl.getAttribute('mjs-confirm'), _confirmEl) : true;
      // thenable (modale asynchrone) : bloque l'événement d'origine, relance sur résolution vraie
      if (_res && typeof _res.then === 'function') {
        e.preventDefault();
        e.stopImmediatePropagation();
        _confirmEl._mjs_mjsConfirmPending = true;
        _res.then(function(ok) {
          _confirmEl._mjs_mjsConfirmPending = false;
          if (ok && _confirmEl.isConnected) { µ._mjs_ujsConfirmRefire(_confirmEl, null, target); }
        }, function() {
          _confirmEl._mjs_mjsConfirmPending = false;
        });
        return;
      }
      if (!_res) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
    }
  }
  // Modificateurs restants (bouton déjà filtré plus haut) — APRÈS la gate
  // @confirm : un clic-molette/ctrl-clic sur un lien confirmé doit quand même
  // déclencher la popup avant que le navigateur n'ouvre son propre onglet.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  link = target.closest('a');
  if (!link) {
    return;
  }
  if (µ._mjs_navNoUjs(link)) {
    µ._mjs_navWarnNoUjsMethod(link);
    return;
  }
  // `origin` (pas `host`) : un lien http: depuis une page https: partagerait
  // le host mais le fetch serait bloqué mixed-content → navigation avalée.
  if (link.origin !== window.location.origin) {
    return;
  }
  // Tout target nommé (_blank, iframe nommée…) doit suivre le comportement
  // natif — seul `_self` (ou rien) se fait intercepter.
  if (link.target && link.target !== '_self') {
    return;
  }
  if (link.hasAttribute('download')) {
    return;
  }
  if (link.protocol === 'javascript:' || link.protocol === 'mailto:') {
    return;
  }
  // LIEN À VERBE HTTP (@method → mjs-method) : toujours intercepté (mêmes
  // garde-fous que ci-dessus, déjà passés) — au lieu du GET natif, requête
  // mutante via le pipeline PARTAGÉ avec la soumission de formulaire
  // (`µ._mjs_navDispatch`, défini plus bas, juste après le handler de submit) :
  // `_method=<verbe>` en corps de formulaire + CSRF automatique (même chemin
  // qu'un submit, cf. mjs_ajax.ts — la réponse suit EXACTEMENT le même
  // traitement : redirection suivie + swap, 422 re-rendu, erreurs → repli).
  // Verbe inconnu → warning puis repli sur la navigation normale ci-dessous
  // (PAS de preventDefault dans ce cas : les branches same-page/cross-page
  // gèrent leur propre interception, comme si `mjs-method` était absent).
  var _methodAttr = typeof link.getAttribute === 'function' ? link.getAttribute('mjs-method') : null;
  if (_methodAttr) {
    var _verb = _methodAttr.toUpperCase();
    if (_verb === 'DELETE' || _verb === 'POST' || _verb === 'PUT' || _verb === 'PATCH') {
      e.preventDefault();
      // Garde anti-double-clic interne (capacité « désactivation pendant
      // soumission ») : une requête mjs-method est déjà en vol pour CE lien.
      if (link._mjs_mjsBusy) {
        return;
      }
      link.setAttribute('aria-disabled', 'true');
      link._mjs_mjsBusy = true;
      var _methodPayload = new FormData();
      _methodPayload.append('_method', _methodAttr.toLowerCase());
      return µ._mjs_navDispatch(link.href, _verb, _methodPayload, {
        via: 'method',
        el: link, // élément d'origine (veilleur flash/error + @callback), lu par closure dans done/fail
        restoreBusy: function() {
          link.removeAttribute('aria-disabled');
          link._mjs_mjsBusy = false;
        }
      });
    }
    µ.warn('[µ.UJS] mjs-method="'+ _methodAttr +'" : verbe HTTP non reconnu (delete/post/put/patch) — navigation normale.');
  }
  // pathname ET search : un lien `?page=2` depuis `?page=1` est une VRAIE
  // navigation — avant (pathname seul), l'URL était poussée mais aucun fetch
  // ne partait → pagination/filtres par query string inutilisables.
  isSamePage = link.pathname === window.location.pathname && link.search === window.location.search;
  if (isSamePage) {
    isHashRoute = link.hash.startsWith('#/');
    if (link.hash && !isHashRoute) {
      return;
    }
    e.preventDefault();
    destination = link.pathname + link.search + link.hash;
    // canonicalise le slash final
    // (`#/about/` → `#/about`) AVANT dédoublonnage ET pushState : `_mjs_canonHash`
    // n'était appliqué que dans la branche `pushHistory` de `navigate`, jamais
    // sur ce chemin same-page → un lien `#/about/` laissait l'URL sale (pushState
    // n'émet pas hashchange → `_mjs_canonicalizeUrl` ne repasse pas) et contournait
    // le dédoublonnage (`#/about` ≠ `#/about/` → nouvelle entrée pour la même page).
    var _rt = µ.Router;
    if (_rt && _rt._mjs_canonHash && link.hash) {
      destination = link.pathname + link.search + _rt._mjs_canonHash(link.hash);
    }
    // re-clic sur un lien qui pointe déjà
    // vers la page ET le hash ACTUELLEMENT affichés : pushState empilait quand
    // même une 2e entrée d'historique STRICTEMENT IDENTIQUE à la courante — un
    // seul retour arrière ne faisait alors RIEN de visible (on retombe sur le
    // même contenu déjà affiché), il en fallait DEUX pour vraiment quitter la
    // page. Rien à pousser ni à re-router quand la destination EST déjà celle
    // affichée (préventDefault reste nécessaire : on ne laisse pas le
    // navigateur gérer nativement un lien qu'on a décidé de prendre en charge).
    if (destination === window.location.pathname + window.location.search + window.location.hash) {
      return;
    }
    window.history.pushState({}, '', destination);
    return (ref = µ.Router) != null ? ref.navigate(destination, false) : void 0;
  } else {
    // la cascade #app-root/mjs-child a disparu : le chemin HTML n'a par nature
    // aucun `target` (pas de fiche), le contenant est donc TOUJOURS <body> côté réponse HTML —
    // il y a donc TOUJOURS quelque chose à échanger (le contenant du cache, lui, est celui du
    // dernier montage : µ._mjs_navCacheZone, plus bas).
    e.preventDefault();
    destination = link.href;
    // pageCache empoisonné : lire
    // `window.location` ICI (au lieu de `µ._mjs_lastUjsPath`) semble correct dans
    // le cas nominal (les deux coïncident), mais diverge lors d'un DOUBLE-CLIC
    // rapide, avant que le fetch du 1er clic ne résolve. Le `pushState`
    // (quelques lignes plus bas) est SYNCHRONE — il déplace `window.location`
    // vers la destination du 1er clic IMMÉDIATEMENT, alors que le DOM affiché
    // reste celui de la page de départ tant que le fetch n'a pas répondu (le
    // swap n'arrive que dans le callback ajax, plus bas). Un 2e clic pendant
    // cette fenêtre lisait `window.location` = destination du 1er clic (déjà
    // poussée) alors que `currentRoot` est ENCORE le DOM du point de départ →
    // `pageCache.set(destinationDu1erClic, rootDuPointDeDépart)` : le contenu
    // de la page de DÉPART se retrouvait caché sous la clé de la page
    // INTERMÉDIAIRE jamais réellement affichée — poison silencieux, révélé
    // seulement bien plus tard (retour en arrière vers cette URL). `_mjs_lastUjsPath`
    // est le signal FIABLE ici : il ne bouge QUE quand le contenu change
    // RÉELLEMENT (cf. commentaire plus bas), donc reflète toujours la page
    // VRAIMENT affichée, contrairement à `window.location` (mutable dès le
    // clic, avant tout swap DOM réel).
    currentPath = µ._mjs_lastUjsPath;
    destPath = link.pathname + link.search;
    fullDest = link.pathname + link.search + link.hash;
    // mjs:before-visit, ANNULABLE : AVANT tout effet de bord (pushState pas encore posé, _mjs_navSeq
    // pas encore bumpé, aucune hibernation) — un écouteur qui annule laisse la page EN PLACE
    // (e.preventDefault() déjà posé plus haut, cf. commentaire ci-dessus : exactement le garde-fou voulu).
    // µ._mjs_navEmitPaths : réutilisé pour `visit`/`load` plus bas (rien ne réassigne destPath/
    // fullDest entre ces émissions).
    evPaths = µ._mjs_navEmitPaths(fullDest);
    if (!µ._mjs_navEmit('before-visit', { path: evPaths.path, url: evPaths.url, via: 'link' }, true)) { return; }
    // pushState AU CLIC : l'URL reflète l'intention immédiatement et l'ordre
    // d'historique ne dépend plus de l'ordre d'arrivée des réponses réseau.
    window.history.pushState({}, '', fullDest);
    seq = ++µ._mjs_navSeq;
    // Abandon réel du fetch de navigation précédent (cf. `_mjs_abortStaleNav`,
    // haut de fichier) — inconditionnel, comme au popstate : un clic tue tout
    // fetch encore en vol, que CE clic résolve ensuite en cache-hit (rien à
    // fetcher) ou en cache-miss (`_navCtrl.signal` consommé plus bas).
    var _navCtrl = typeof µ._mjs_abortStaleNav === 'function' ? µ._mjs_abortStaleNav() : null;
    // le contenu du contenant est hiberné à chaque départ, contenant compris quand
    // c'est <body> (avant : <body> en était exclu du pageCache). Simple PHOTOGRAPHIE
    // (lecture de childNodes, aucun retrait) : le retrait RÉEL des nœuds n'a lieu qu'au prochain
    // µ._mjs_zoneFill sur cette zone (cf. commentaire du même motif au popstate).
    var _cacheZone = µ._mjs_navCacheZone();
    // mjs:visit, non annulable : `cached` dit si CETTE navigation sera servie depuis pageCache
    // sans aucune requête réseau (calculé avant hibernation, qui ne touche pas cette entrée).
    µ._mjs_navEmit('visit', { path: evPaths.path, url: evPaths.url, via: 'link', cached: !!(_cacheZone && µ.pageCache && µ.pageCache.has(destPath)) }, false);
    // hibernation, pas destruction : ce flag exempte les composants du sous-arbre parqué de
    // l'invocation différée d'onDestroy (mjs_element) — cf. µ._mjs_navHibernate
    µ._mjs_navHibernate(_cacheZone, currentPath);
    // NB : `µ._mjs_lastUjsPath` n'est mis à jour QUE quand le contenu change
    // réellement (branche cache ci-dessous, ou callback du fetch) — le poser
    // au clic faisait archiver, lors d'un popstate intermédiaire, le contenu
    // encore affiché de A sous la clé de B (pageCache empoisonné).
    if (_cacheZone && µ.pageCache.has(destPath)) {
      cachedNodes = µ.pageCache.get(destPath);
      var _swapClickCache = function() {
        // swap PÉRIMÉ sous transition de vue : `seq`
        // capturé plus haut (avant la résolution cache, synchrone) ; cf. bandeau de `swap`
        // dans µ._mjs_navApplyJson.
        if (seq !== µ._mjs_navSeq) { return; }
        var _cci;
        µ._mjs_navRestoreHead(cachedNodes._mjs_mjsHead); // même ordre que le chemin réseau : tête d'abord, contenu ensuite
        µ._mjs_navTransplantPermanents(_cacheZone, cachedNodes); // ce site vide `_cacheZone` en court-circuitant µ._mjs_navInstallNodes
        µ._mjs_zoneFill(_cacheZone, cachedNodes);
        for (_cci = 0; _cci < cachedNodes.length; _cci++) { if (cachedNodes[_cci].nodeType === 1) { cachedNodes[_cci]._mjs_page_cached = false; } }
        µ._mjs_navTrackZone(null, null); // le contenant survit, plus rien à suivre
        µ._mjs_navCachePolicy = cachedNodes._mjs_mjsCachePolicy || 'cache-first'; // la politique de CETTE page revit avec elle
        µ._mjs_lastUjsPath = destPath;
        µ._mjs_restoreScroll(destPath);
        // Accessibilité : cache-hit = swap synchrone, focus quand même déplacé —
        // APRÈS la restauration de scroll (ordre voulu, cf. commentaire de _mjs_focusAfterSwap).
        if (typeof µ._mjs_focusAfterSwap === 'function') { µ._mjs_focusAfterSwap(µ._mjs_navFirstEl(cachedNodes)); }
        // 'revalidate' : cache-hit immédiat (rien ci-dessus n'attend le réseau), vérification
        // en fond APRÈS l'affichage (jamais avant, zéro régression de vitesse).
        if (cachedNodes._mjs_mjsCachePolicy === 'revalidate') { µ._mjs_navRevalidate(_cacheZone, destPath); }
        // DERNIÈRE ligne de `_swapClickCache` : cf. bandeau
        // `_finClickCache` ci-dessous.
        _finClickCache();
      };
      // µ._mjs_vtWrapSwap peut DIFFÉRER `_swapClickCache` (rappel de
      // document.startViewTransition, asynchrone) : la queue ci-dessous (navigate + mjs:load), avant
      // posée juste APRÈS l'appel à µ._mjs_vtWrapSwap, s'exécutait alors AVANT l'installation réelle.
      // `_finClickCache` se rappelle désormais en DERNIÈRE ligne de `_swapClickCache` : sans
      // transition de vue (`_mjs_vtWrapSwap` appelle `_swapClickCache()` SYNCHRONEMENT), l'ordre
      // observable reste IDENTIQUE à aujourd'hui.
      var _finClickCache = function() {
        if ((ref3 = µ.Router) != null) {
          ref3.navigate(fullDest, false);
        }
        // mjs:load : UNE FOIS, APRÈS installation ET resynchronisation du routeur. zone:
        // `_cacheZone` (contenant réellement visé, capturé AVANT hibernation), pas µ._mjs_navCacheZone()
        // (menteur en 'replace').
        µ._mjs_navEmit('load', { path: evPaths.path, url: evPaths.url, via: 'link', zone: _cacheZone, initial: false }, false);
      };
      // @viewTransition (mjs-vt) : `link` = l'ancre cliquée → résolution attribut > config.
      if (typeof µ._mjs_vtWrapSwap === 'function') { µ._mjs_vtWrapSwap(link, _swapClickCache); } else { _swapClickCache(); }
      return;
    }
    // µnav (état réactif public) : posé UNIQUEMENT pour le fetch réseau
    // ci-dessous (pas le cache-hit synchrone au-dessus) — chaque app affiche
    // ainsi sa barre/spinner SEULEMENT quand une requête est réellement en vol.
    if (µ.nav) { µ.nav.active = true; µ.nav.href = destination; }
    µ._mjs_navProgressStart(); // armé indépendamment de µ.nav (opt-in propre, cf. sa déclaration)
    // `µ._mjs_ajaxGet` : sert d'abord le HTML PRÉCHARGÉ (survol/eager) s'il existe →
    // clic instantané ; sinon fetch réseau normal.
    return µ._mjs_ajaxGet(destination, function(html, finalUrl, _schemaNom, nav) {
      var doc, liveRoot, newRoot, parser, ref6, navDest, finalPath, newNodes, _navTarget, _navMethod, _navCache, liveInfo, _zones, _installedZone, loadPaths;
      if (seq !== µ._mjs_navSeq) {
        return; // une navigation plus récente a gagné — callback périmé jeté
      }
      if (µ.nav) { µ.nav.active = false; µ.nav.href = null; }
      µ._mjs_navProgressStop();
      // redirection serveur
      // suivie par fetch (`finalUrl` = response.url) : aligner l'URL affichée
      // ET `_mjs_lastUjsPath` sur la destination FINALE. Sans ça, un lien /admin
      // redirigé 302 vers /login affichait /login sous l'URL /admin, posait
      // `_mjs_lastUjsPath='/admin'` → au prochain départ, le DOM de /login était
      // archivé sous pageCache['/admin'] (obsolète resservi à chaque retour).
      // `replaceState` : on CORRIGE l'entrée du clic, pas une nouvelle entrée.
      // calculé UNIQUEMENT quand un montage/swap va effectivement avoir
      // lieu (JSON ou HTML+zone trouvée) : PAS avant, pour ne rien changer au
      // repli `_mjs_hardNav` (aucune zone exploitable) — comportement IDENTIQUE à
      // avant, dans ce cas précis (`_mjs_finalPathFor` n'y était déjà jamais
      // appelé).
      var _computeNavDest = function() {
        navDest = fullDest;
        finalPath = µ._mjs_finalPathFor(finalUrl, destPath);
        if (finalPath !== destPath) {
          try {
            var _fu = new URL(finalUrl, window.location.href);
            navDest = _fu.pathname + _fu.search + _fu.hash;
            window.history.replaceState({}, '', navDest);
          } catch (e) { navDest = fullDest; }
        }
      };
      if (html && typeof html === 'object') {
        // chemin JSON du protocole de navigation : l'historique est
        // déjà correct (pushState au clic + éventuelle correction replaceState
        // ci-dessus) — aucun push ici (opts.push=false). `vtLink: link` :
        // même résolution attribut > config que le swap HTML (cf. `_swapClickNet`).
        // `el: link` : élément d'origine (veilleur flash/error), sinon un lien
        // ORDINAIRE recevant du JSON ignorait sa politique mjs-flash par élément.
        _computeNavDest();
        // scrollTo(0,0) passé en onSwapped (plus un appel synchrone juste
        // après, cf. bandeau du swap nominal dans µ._mjs_navApplyJson) : µ._mjs_vtWrapSwap peut DIFFÉRER le
        // swap (transition de page async), l'ancien appel ici ramenait la page QUITTÉE en haut AVANT
        // la permutation — saut visible.
        // `µ._mjs_lastUjsPath = finalPath;` DÉPLACÉ dans
        // ce MÊME onSwapped (même raisonnement que scrollTo ci-dessus, cf. bandeau du site jumeau
        // popstate) : posé SYNCHRONE ici, il pouvait pointer la destination AVANT le swap réel
        // (différé) — une 2e navigation démarrée dans ce délai hibernait le DOM encore affiché sous
        // CETTE clé (pageCache empoisonné).
        µ._mjs_navApplyJson(html, navDest, { push: false, vtLink: link, via: 'link', el: link, seq: seq, onSwapped: function() { µ._mjs_lastUjsPath = finalPath; window.scrollTo(0, 0); } });
        return;
      }
      // X-MJS-Reload : AVANT la garde de version, AVANT tout parse — un ordre explicite du
      // serveur passe avant une version déduite (même priorité que le chemin JSON).
      if (µ._mjs_navReloadAsked(nav && nav.reload)) {
        µ._mjs_navHardReload(finalUrl || destination);
        return;
      }
      // même garde de version que le chemin JSON (json.version), via l'en-tête HTTP
      // pour un serveur qui ne parle que HTML : bundle client changé depuis le chargement de
      // la page en cours ⇒ rechargement complet plutôt qu'un swap avec l'ancien JS. AVANT tout swap.
      if (nav && nav.version && µ.version && nav.version !== µ.version) {
        window.location.assign(finalUrl || destination);
        return;
      }
      // X-MJS-Method: none : le back répond « ne bouge pas » — corps ignoré (AVANT tout parse),
      // rien d'installé. µ._mjs_navDropHibernation annule l'hibernation posée au clic pour CETTE navigation
      // (les nœuds affichés restent affichés, pas hibernés pour rien).
      if (µ._mjs_navMethodOf(nav && nav.method) === 'none') {
        µ._mjs_navDropHibernation();
        return;
      }
      // target/method voyagent désormais aussi sur le chemin HTML (en-têtes X-MJS-Target/
      // X-MJS-Method, le serveur les pose) : même normalisation que le protocole JSON. `cache`
      // pareil (X-MJS-Cache), repli balise <meta name="mjs-cache"> lue dans `doc` une fois parsé (cf.
      // µ._mjs_navCacheOf) — calculé APRÈS le parse, juste en dessous.
      _navTarget = (nav && typeof nav.target === 'string' && nav.target) ? nav.target : null;
      _navMethod = µ._mjs_navMethodOf(nav && nav.method);
      parser = new DOMParser();
      doc = parser.parseFromString(html, 'text/html');
      _navCache = µ._mjs_navCacheOf(doc, nav && nav.cache);
      // Re-query (pas la closure) : les DEUX contenants résolus ENSEMBLE au moment du swap
      // (µ._mjs_navResolveZones) — le contenant côté PAGE peut avoir été remplacé entre-temps,
      // remplir un nœud détaché était un no-op muet.
      _zones = µ._mjs_navResolveZones(doc, _navTarget);
      newRoot = _zones.newZone;
      liveInfo = _zones.liveInfo;
      liveRoot = liveInfo.zone;
      if (newRoot && liveRoot) {
        _computeNavDest();
        newNodes = Array.prototype.slice.call(newRoot.childNodes);
        µ._mjs_navWarnScripts(newNodes);
        var _swapClickNet = function() {
          // swap PÉRIMÉ sous transition de vue : `seq`
          // capturé plus haut (avant le fetch réseau) ; cf. bandeau de `swap` dans µ._mjs_navApplyJson.
          if (seq !== µ._mjs_navSeq) { return; }
          // chemin HTML, target/method désormais suivis COMME le JSON (µ._mjs_navInstallNodes
          // gère replace/append/update + suivi de zone) — plus jamais figé sur <body>.
          // valeur RETOURNÉE : le contenant EFFECTIF après installation (liveInfo.zone se
          // détache en method:'replace', cf. µ._mjs_navInstallNodes) — capturée ici pour detail.zone plus bas.
          µ._mjs_navApplyHead(doc); // tête d'abord (synchrone) : un <@head><title> qui arrive tirera ensuite dans sa microtâche et gagnera
          _installedZone = µ._mjs_navInstallNodes(liveInfo, newNodes, _navMethod, _navCache);
          µ._mjs_lastUjsPath = finalPath;
          window.scrollTo(0, 0);
          // Focus APRÈS le scroll (nouvelle page = toujours en haut, cf. ci-dessus).
          if (typeof µ._mjs_focusAfterSwap === 'function') { µ._mjs_focusAfterSwap(µ._mjs_navFirstEl(newNodes)); }
          // DERNIÈRE ligne de `_swapClickNet` : cf. bandeau
          // `_finClickNet` ci-dessous.
          _finClickNet();
        };
        // µ._mjs_vtWrapSwap peut DIFFÉRER `_swapClickNet` (rappel de
        // document.startViewTransition, asynchrone) : la queue ci-dessous (navigate + mjs:load), avant
        // posée juste APRÈS l'appel à µ._mjs_vtWrapSwap, s'exécutait alors AVANT l'installation
        // réelle. `_finClickNet` se rappelle désormais en DERNIÈRE ligne de `_swapClickNet` : sans
        // transition de vue (`_mjs_vtWrapSwap` appelle `_swapClickNet()` SYNCHRONEMENT), l'ordre
        // observable reste IDENTIQUE à aujourd'hui. Valeur de retour de `ref6.navigate(...)` : plus
        // propagée (cf. bandeau `_finPopCache`, même raisonnement — aucun appelant ne consommait le
        // retour de `_mjs_ujsOnClick`, listener de clic).
        var _finClickNet = function() {
          if ((ref6 = µ.Router) != null) { ref6.navigate(navDest, false); }
          // evPaths RECALCULÉ depuis `navDest` (corrigé par _computeNavDest en cas de redirection
          // serveur, APPELÉ juste au-dessus) : celui du départ (before-visit/visit, plus haut) décrit
          // l'intention, `load` doit reporter la destination RÉELLEMENT installée.
          loadPaths = µ._mjs_navEmitPaths(navDest);
          // mjs:load : APRÈS installation ET resynchronisation du routeur. zone: le
          // contenant EFFECTIF retourné par µ._mjs_navInstallNodes (liveInfo.zone est détaché en 'replace').
          µ._mjs_navEmit('load', { path: loadPaths.path, url: loadPaths.url, via: 'link', zone: _installedZone, initial: false }, false);
        };
        // @viewTransition (mjs-vt) : `link` = l'ancre cliquée → résolution attribut > config.
        if (typeof µ._mjs_vtWrapSwap === 'function') { µ._mjs_vtWrapSwap(link, _swapClickNet); } else { _swapClickNet(); }
        // Plus d'Autoloader.observe(newRoot) ici : l'observer de document.body
        // posé par le bootstrap voit déjà cette insertion — chaque navigation
        // empilait un MutationObserver subtree de plus, jamais déconnecté.
        return;
      } else {
        // Réponse sans zone exploitable (cas pathologique — la cascade ne
        // trouve normalement JAMAIS un doc sans <body>) : repli navigation
        // complète via _mjs_hardNav — l'URL du clic est déjà poussée, réassigner
        // la même url à hash ne rechargerait rien (cf. commentaire de _mjs_hardNav).
        return µ._mjs_hardNav(destination);
      }
    }, function() {
      // repli dur SEULEMENT si
      // cette navigation est la plus récente : un fetch périmé (clic A lent, clic
      // B rapide déjà affiché) qui échoue enfin ne doit PAS forcer window.location
      // vers A (dernière intention B perdue, SPA rechargée pour rien).
      if (seq !== µ._mjs_navSeq) { return; }
      if (µ.nav) { µ.nav.active = false; µ.nav.href = null; }
      µ._mjs_navProgressStop();
      // Échec réseau (4xx/5xx/timeout) : l'URL a déjà été poussée au clic —
      // sans repli, elle pointait une page jamais affichée, en silence
      // (_mjs_hardNav : même url déjà poussée → reload, pas de réassignation muette).
      return µ._mjs_hardNav(destination);
    }, _navCtrl && _navCtrl.signal);
  }
};
// <<< extrait-test _mjs_ujsOnClick
document.addEventListener('click', µ._mjs_ujsOnClick);

// Nommé (au lieu d'anonyme) — même raison que µ._mjs_ujsOnClick ci-dessus :
// réutilisé tel quel par le PONT SHADOW (µ._mjs_ujsShadowAttach, plus bas).
// >>> extrait-test _mjs_ujsOnSubmit
µ._mjs_ujsOnSubmit = function(e) {
  var form, method, payload, submitter, url;
  // Garde anti double-passage pont→document (shadow OPEN, aucun retargeting, cf. le commentaire de
  // µ._mjs_ujsOnClick sur cette même dette) : un refus/thenable @confirm pose `e.preventDefault()` DANS
  // la gate ci-dessous (pas ici, plus en amont comme avant) — cette garde-ci absorbe donc le 2ᵉ
  // passage pour CES deux cas. Le 3ᵉ cas (acceptation SYNCHRONE) ne pose PAS `preventDefault` dans la
  // gate : c'est le marqueur `e._mjs_mjsConfirmGated` (juste en dessous, comme le clic) qui protège celui-là.
  if (e.defaultPrevented) {
    return;
  }
  form = µ.realTarget(e).closest('form');
  if (!form) {
    return;
  }
  // CONFIRMATION AVANT ACTION (@confirm → mjs-confirm) — HISSÉE ici, AVANT le test d'opt-out
  // (défaut corrigé : un formulaire `@noUJS` + `@confirm` doit être confirmé, comme un lien
  // `@noUJS` + `@confirm` l'est déjà côté clic) : remonte du nœud RÉELLEMENT soumissionnaire (le
  // bouton cliqué, `e.submitter` ; repli sur le <form> lui-même pour un Enter/une soumission
  // programmatique) au porteur `mjs-confirm` le plus proche. Marqueur `e._mjs_mjsConfirmGated`, EN
  // MIROIR du clic — nécessaire : le `preventDefault()` inconditionnel qui absorbait
  // seul le double passage pont→document n'est plus en amont (une acceptation synchrone ne prévient
  // plus rien ici, cf. plus bas), donc le marqueur est ce qui empêche un 2ᵉ appel de µ.confirm.
  // EN MIROIR de la garde clic ci-dessus : le marqueur
  // ne se pose qu'APRÈS avoir trouvé un VRAI porteur `[mjs-confirm]`, sinon le pont EXTERNE d'un
  // formulaire imbriqué dans un composant lui-même imbriqué fermerait la garde à tort avant que
  // le pont INTERNE (seul à voir le vrai porteur) n'ait joué µ.confirm.
  if (!e._mjs_mjsConfirmGated) {
    var _confirmSrc = (e.submitter && typeof e.submitter.closest === 'function') ? e.submitter : form;
    var _confirmEl = typeof _confirmSrc.closest === 'function' ? _confirmSrc.closest('[mjs-confirm]') : null;
    // mémorisé ICI (avant tout `await`/thenable, cf.
    // µ._mjs_ujsConfirmRefire) — le vrai soumissionnaire de CETTE soumission, retransmis au replay.
    var _confirmSubmitter = e.submitter;
    if (_confirmEl && typeof _confirmEl.hasAttribute === 'function' && _confirmEl.hasAttribute('mjs-confirm')) {
      e._mjs_mjsConfirmGated = true;
      // pending : modale déjà ouverte pour CET élément, soumissions avalées sans re-appeler µ.confirm
      if (_confirmEl._mjs_mjsConfirmPending) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      var _res = typeof µ.confirm === 'function' ? µ.confirm(_confirmEl.getAttribute('mjs-confirm'), _confirmEl) : true;
      // thenable (modale asynchrone) : bloque la soumission d'origine, relance sur résolution vraie
      if (_res && typeof _res.then === 'function') {
        e.preventDefault();
        e.stopImmediatePropagation();
        _confirmEl._mjs_mjsConfirmPending = true;
        _res.then(function(ok) {
          _confirmEl._mjs_mjsConfirmPending = false;
          if (ok && _confirmEl.isConnected) { µ._mjs_ujsConfirmRefire(_confirmEl, form, null, _confirmSubmitter); }
        }, function() {
          _confirmEl._mjs_mjsConfirmPending = false;
        });
        return;
      }
      if (!_res) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // acceptation SYNCHRONE : on NE prévient PAS ici — la suite du handler décide (opt-out →
      // soumission native CONFIRMÉE ; sinon `e.preventDefault()` inconditionnel plus bas, à sa
      // place habituelle, comme si @confirm n'avait jamais existé).
    }
  }
  if (µ._mjs_navNoUjs(form)) {
    return;
  }
  // `submitter` remonté ICI (avant, plus bas, lu
  // seulement pour name/value) — un <button formaction/formtarget/formmethod> soumissionnaire a
  // la PRIORITÉ HTML sur les attributs du <form> lui-même ; repli sur ceux du <form> si le bouton
  // ne porte pas l'attribut, ou pour une soumission par la touche Entrée (e.submitter === null,
  // aucun bouton n'a déclenché l'envoi). Avant, target/action/method du FORMULAIRE
  // étaient lus inconditionnellement : un <button formaction="/autre"> partait vers l'action du
  // <form>, jamais la sienne.
  submitter = e.submitter;
  // form.target/form.action sont les PROPRIÉTÉS IDL de HTMLFormElement : un
  // <input name="target">/<input name="action"> dans le formulaire les MASQUE par l'ÉLÉMENT nommé
  // (règle HTML des propriétés nommées) — new URL(élément) lève un TypeError, et l'élément (truthy)
  // faisait sortir la fonction en silence. On lit les ATTRIBUTS, jamais les propriétés IDL ;
  // l'action relative se résout contre la page, une action inanalysable laisse faire le navigateur.
  // lecture par PRÉSENCE, jamais par troncature `||` —
  // `formaction=""`/`formmethod=""`/`formtarget=""` sont des valeurs HTML VALIDES (pas une absence) :
  // le `||` précédent les traitait comme absentes et retombait à tort sur le `<form>`. `hasAttribute`
  // (repli `getAttribute(...) !== null` pour un objet de test sans `hasAttribute`).
  var _attrPresent = function(el, name) {
    if (!el) { return false; }
    if (typeof el.hasAttribute === 'function') { return el.hasAttribute(name); }
    return typeof el.getAttribute === 'function' && el.getAttribute(name) !== null;
  };
  var _formTarget = _attrPresent(submitter, 'formtarget') ? submitter.getAttribute('formtarget') : form.getAttribute('target');
  if (_formTarget && _formTarget !== '_self') {
    return;
  }
  var _actionAttr;
  if (_attrPresent(submitter, 'formaction')) {
    // formaction="" : valeur vide d'un attribut URL présent = URL du document (sémantique HTML),
    // jamais l'action du <form> — on NE retombe PAS sur `form.getAttribute('action')` ici.
    // `.split('#')[0]` : `document.URL` porte le
    // FRAGMENT courant (ex. une ancre de section) — sans ce retrait, une soumission GET voyait sa
    // query construite plus bas (`_mjs_navDispatch`) atterrir SYNTAXIQUEMENT dans le fragment
    // (`.../search#results?q=hello`), perdue au fetch réel (`URL().search` vide). Un fragment n'a
    // jamais fait partie de la « URL du document » au sens formulaire de la spec HTML.
    _actionAttr = submitter.getAttribute('formaction') || document.URL.split('#')[0];
  }
  else {
    _actionAttr = form.getAttribute('action');
  }
  if (_actionAttr) {
    var _actionOrigin;
    try {
      _actionOrigin = new URL(_actionAttr, window.location.href).origin;
    } catch (e2) {
      return; // action inanalysable : soumission NATIVE, aucun preventDefault
    }
    if (_actionOrigin !== window.location.origin) {
      return;
    }
  }
  payload = new FormData(form);
  if (submitter && submitter.name) {
    payload.append(submitter.name, submitter.value);
  }
  // payload.get('_method') peut rendre un File (input file nommé "_method") :
  // ne retenir la valeur que si c'est une chaîne, jamais method.toUpperCase() sur un objet.
  // ordre : `_method` (champ, override explicite du verbe,
  // INCHANGÉ) > `formmethod` du bouton soumissionnaire > `method` du <form> > GET.
  var _m = payload.get('_method');
  var _methodFromAttr = false;
  if (typeof _m === 'string' && _m) {
    method = _m;
  }
  else if (_attrPresent(submitter, 'formmethod')) {
    // Valeur vide/invalide d'un attribut énuméré présent = son défaut GET (jamais le
    // <form>) ; 'dialog'/'post' explicites conservés (inchangé).
    var _fm = (submitter.getAttribute('formmethod') || '').toUpperCase();
    method = (_fm === 'POST' || _fm === 'DIALOG') ? _fm : 'GET';
    _methodFromAttr = true;
  }
  else {
    method = form.getAttribute('method') || 'GET';
    _methodFromAttr = true;
  }
  method = method.toUpperCase();
  // `method="dialog"` (HTML) ferme le <dialog> englobant SANS réseau, jamais intercepté par
  // l'UJS (spec HTML : cette méthode de formulaire n'envoie rien) — sinon `_mjs_navDispatch` refusait le
  // verbe (`Unsupported HTTP verb: DIALOG`) et bloquait la fermeture native sans repli. Résolu ICI,
  // AVANT `e.preventDefault()` (déplacé plus bas, pas avant comme le reste de cette fonction) : sortir
  // après l'aurait déjà empêché le navigateur de fermer la boîte.
  // le défaut natif ne vaut QUE si DIALOG vient d'un
  // ATTRIBUT HTML (`_methodFromAttr`, posé ci-dessus) : un `_method` de champ caché n'est PAS une
  // méthode HTML — laisser filer soumettrait le <form> avec SON vrai `method` réel (souvent post),
  // en silence, <dialog> jamais fermé. Refusé explicitement, comme précédemment pour ce cas précis.
  if (method === 'DIALOG') {
    if (!_methodFromAttr) {
      e.preventDefault();
      µ.error('[µ.UJS] _method=dialog n\'a pas de sens : dialog est un attribut method/formmethod, pas un verbe HTTP');
      return;
    }
    return;
  }
  e.preventDefault();
  // MÊME retrait de fragment que `document.URL`
  // ci-dessus, même raison (formulaire sans action ni formaction : repli sur l'URL de la page).
  url = _actionAttr || window.location.href.split('#')[0];
  // DÉSACTIVATION PENDANT SOUMISSION : boutons de soumission du formulaire
  // (`disabled`) + `aria-busy="true"` sur le <form> — restaurés dans TOUS les
  // chemins de sortie par `_mjs_navDispatch` (`opts.restoreBusy`, appelé
  // inconditionnellement au début de `done`/`fail` : succès+swap et 422
  // n'ont RIEN à restaurer, le <form> disabled est remplacé PAR le swap ;
  // échec réseau/repli restaure explicitement — idempotent/sans effet si
  // l'élément a déjà quitté le DOM). Opt-out : `mjs-no-disable` sur le <form>.
  var _submitButtons = [];
  var _busyForm = null;
  if (!(typeof form.hasAttribute === 'function' && form.hasAttribute('mjs-no-disable')) && typeof form.querySelectorAll === 'function') {
    var _btnList = form.querySelectorAll("button[type='submit'], button:not([type]), input[type='submit']");
    for (var _bi = 0; _bi < _btnList.length; _bi++) {
      _submitButtons.push(_btnList[_bi]);
      _btnList[_bi].disabled = true;
    }
    if (typeof form.setAttribute === 'function') { form.setAttribute('aria-busy', 'true'); }
    _busyForm = form;
  }
  // jeton anti-course
  // `µ._mjs_navSeq` PARTAGÉ avec le clic (clic ET submit se disputent le MÊME
  // "qui a gagné la course d'affichage") : géré désormais par `_mjs_navDispatch`
  // (chemin PARTAGÉ avec le lien mjs-method, cf. handler de clic plus haut).
  return µ._mjs_navDispatch(url, method, payload, {
    el: submitter || form, // élément d'origine (veilleur flash/error + @callback), lu par closure dans done/fail
    restoreBusy: function() {
      for (var _bj = 0; _bj < _submitButtons.length; _bj++) { _submitButtons[_bj].disabled = false; }
      if (_busyForm && typeof _busyForm.removeAttribute === 'function') { _busyForm.removeAttribute('aria-busy'); }
    }
  });
};
// <<< extrait-test _mjs_ujsOnSubmit
document.addEventListener('submit', µ._mjs_ujsOnSubmit);

// PONT SHADOW (retargeting) — un listener document-level ne voit JAMAIS la
// cible réelle d'un clic/submit survenu dans un Shadow DOM FERMÉ : la spec
// retargete `e.target` à la frontière du shadow, `document.addEventListener`
// ne reçoit que le HOST (le custom element), jamais le <a>/<button> interne —
// `closest()` depuis le host ne retrouve donc jamais l'élément réellement
// cliqué (symptôme prouvé : @confirm sur un bouton dans un composant →
// suppression SANS popup). Le pont attache les MÊMES handlers nommés
// ci-dessus DIRECTEMENT sur le shadow root : à ce niveau, `e.target` N'EST
// PAS retargeté (on est À L'INTÉRIEUR de la frontière), `closest()`
// fonctionne normalement. Appelé par mjs_element.ts (constructor) dès qu'un
// VRAI shadow root est établi (jamais pour le repli `mjs-light`, qui vit déjà
// en light DOM sous document — le pont y serait un doublon pur). Marqueur
// `_mjs_mjsUjsBound` sur le root : idempotent, un composant qui recrée/réadopte
// son shadow n'accumule pas 2 paires de listeners.
//
// CAPTURE, pas bulle (3ᵉ argument `true`) — DÉTERMINANT : `_mjs_bindEvents`
// (mjs_element.ts, délégation @click/@submit du composant) enregistre TOUJOURS
// ses propres listeners délégués en phase CAPTURE (`opts = true`, cf. son
// commentaire). Sur un ANCÊTRE du nœud réellement cliqué (le shadow root ici),
// la phase CAPTURE s'exécute TOUJOURS avant la phase BULLE, quel que soit
// l'ORDRE d'enregistrement — un pont posé en bulle (défaut) se serait donc
// exécuté APRÈS `_mjs_bindEvents`, bien trop tard pour qu'un refus @confirm
// (`stopImmediatePropagation`) empêche le handler du composant de tourner
// (constaté empiriquement : sans ce `true`, `remove()` s'exécutait quand même
// malgré un refus). En capture ET posé AVANT (constructor, cf. mjs_element.ts),
// le pont gagne la course dans la MÊME phase que `_mjs_bindEvents`.
µ._mjs_ujsShadowAttach = function(root) {
  if (!root || root._mjs_mjsUjsBound) {
    return;
  }
  root._mjs_mjsUjsBound = true;
  root.addEventListener('click', µ._mjs_ujsOnClick, true);
  root.addEventListener('submit', µ._mjs_ujsOnSubmit, true);
};

// Chemin PARTAGÉ soumission de formulaire / lien mjs-method : construit et
// dispatche la requête ajax (verbe GET/HEAD/DELETE/POST/PUT/PATCH), gère la
// réponse EXACTEMENT comme un submit (PRG, 422 re-rendu via `done`,
// invalidation cache, warn sur réponse non reconnue — commentaires
// historiques ci-dessous, inchangés). Posé ICI (une seule fois pour les DEUX
// appelants) : jeton anti-course `µ._mjs_navSeq`, abandon du fetch précédent
// (`_mjs_abortStaleNav`), état réactif `µ.nav`, focus post-swap. `opts.restoreBusy`
// (facultatif) : rappelé inconditionnellement au DÉBUT de `done`/`fail` — cf.
// commentaire du handler submit plus haut pour le raisonnement des 3 chemins
// de sortie (succès+swap/422/échec). `µ.nav`, LUI, ne doit PAS retomber si
// CETTE navigation est périmée (une plus récente en a déjà pris la charge) —
// d'où un reset séparé, gardé par `!stale`/`seq === µ._mjs_navSeq`.
// >>> extrait-test _mjs_navDispatch
µ._mjs_navDispatch = function(url, method, payload, opts) {
  var qs, getUrl, seq, navCtrl, navSignal, via, emitPath, emitUrl, evPaths;
  opts = opts || {};
  via = opts.via || 'form';
  // qs/getUrl calculés ICI (déplacés depuis la branche GET plus bas, retirés là-bas) : sur
  // un formulaire GET, `detail.url` de before-visit/visit doit porter la query, pas l'action nue.
  if (method === 'GET' || method === 'HEAD') {
    // `url` peut porter un FRAGMENT explicite (une
    // action `/x#anchor`, jamais retirée : seuls `document.URL`/`window.location.href`, ci-dessus
    // dans µ._mjs_ujsOnSubmit, le sont À LA SOURCE). Sans ce détachement, la query s'ajoutait APRÈS le
    // `#` — la query atterrissait SYNTAXIQUEMENT dans le fragment, invisible d'un fetch réel. Le
    // fragment (s'il en reste un) est ré-accroché APRÈS la query, jamais avant.
    var _urlHashIdx = url.indexOf('#');
    var _urlBase = _urlHashIdx >= 0 ? url.slice(0, _urlHashIdx) : url;
    var _urlHash = _urlHashIdx >= 0 ? url.slice(_urlHashIdx) : '';
    qs = new URLSearchParams(payload).toString();
    // spec HTML (form GET, « mutate action URL ») : la
    // query DU FORMULAIRE REMPLACE celle de l'action, jamais ne s'y AJOUTE (comportement natif d'un
    // `<form method="get">`, sans UJS) — avant, `sep` choisissait `&` dès que `_urlBase` portait
    // déjà un `?` (query ACCUMULÉE : `/x?existing=1&q=hello` au lieu de `/x?q=hello` ; `action="?"` →
    // `?&q=hello`, `&` orphelin). `qs` VIDE (formulaire sans champ) : `_urlBase` gardée TELLE QUELLE,
    // query existante comprise — la spec remplacerait par une query VIDE (`/x?`) mais rien ne dépend
    // d'un `?` nu, comportement historique conservé (pragmatique, signalé plutôt que corrigé).
    var _urlQIdx = _urlBase.indexOf('?');
    var _urlNoQuery = _urlQIdx >= 0 ? _urlBase.slice(0, _urlQIdx) : _urlBase;
    getUrl = (qs ? _urlNoQuery + '?' + qs : _urlBase) + _urlHash;
  }
  // µ._mjs_navEmitPaths : `url` peut être ABSOLUE (lien @method → link.href ; formulaire sans
  // action → repli window.location.href, tous deux TOUJOURS absolus) — `url`/`getUrl` eux-mêmes
  // restent intacts (le fetch réel plus bas s'en sert tel quel).
  evPaths = µ._mjs_navEmitPaths(getUrl || url);
  emitPath = evPaths.path;
  emitUrl = evPaths.url;
  // mjs:before-visit, ANNULABLE : tout en TÊTE, avant TOUT effet de bord (seq pas encore bumpé,
  // aucun abandon de fetch précédent, µ.nav pas encore posé, aucune hibernation). Annulé : `restoreBusy`
  // rappelé s'il existe (posé par l'appelant AVANT cet appel — sinon un lien @method resterait
  // aria-disabled à vie), puis sortie immédiate.
  if (!µ._mjs_navEmit('before-visit', { path: emitPath, url: emitUrl, via: via }, true)) {
    if (typeof opts.restoreBusy === 'function') { opts.restoreBusy(); }
    return;
  }
  seq = ++µ._mjs_navSeq;
  navCtrl = typeof µ._mjs_abortStaleNav === 'function' ? µ._mjs_abortStaleNav() : null;
  navSignal = navCtrl ? navCtrl.signal : void 0;
  if (µ.nav) { µ.nav.active = true; µ.nav.href = url; }
  µ._mjs_navProgressStart(); // armé indépendamment de µ.nav (opt-in propre, cf. sa déclaration)
  // mjs:visit, non annulable : ce chemin (soumission/@method) ne lit jamais le cache.
  µ._mjs_navEmit('visit', { path: emitPath, url: emitUrl, via: via, cached: false }, false);
  var _restoreBusy = function() {
    if (typeof opts.restoreBusy === 'function') { opts.restoreBusy(); }
  };
  // Funnel UNIQUE de tous les retours de _mjs_navDispatch (done non périmé, fail 422, fail générique,
  // verbe non supporté, plus bas) : y accrocher µ._mjs_navProgressStop ici couvre tous ces sites d'un coup.
  var _restoreNav = function() {
    if (µ.nav) { µ.nav.active = false; µ.nav.href = null; }
    µ._mjs_navProgressStop();
  };
  var done = function(html, finalUrl, _schemaNom, nav) {
    var liveRoot, doc, newRoot, parser, stale, absUrl, shouldPush, newNodes, _navTarget, _navMethod, _navCache, liveInfo, _zones, _swapped, _installedZone, loadPaths;
    stale = seq !== µ._mjs_navSeq;
    // posé à true SEULEMENT dans la branche HTML+zone (seule à installer réellement un
    // contenu ici — le JSON émet dans µ._mjs_navApplyJson, 422/échec/réponse non reconnue n'installent
    // rien) : n'émettre `load` qu'à la toute fin de cette fonction, si et seulement si c'est vrai.
    _swapped = false;
    _restoreBusy();
    if (stale) {
      // rien à afficher : une navigation plus récente a déjà gagné le DOM/l'URL.
    } else if (html && typeof html === 'object') {
      // chemin JSON du protocole de navigation (X-MJS-Nav, cf.
      // µ._mjs_navRequest). MIROIR du PRG HTML plus bas (méthode mutante +
      // `finalUrl` distinct de l'URL soumise ⇒ pushState) — auto-contenu
      // (`return` en fin de branche) : le PRG partagé de fin de fonction
      // (chemin HTML) ne doit pas repousser une 2e fois l'historique.
      try { absUrl = new URL(url, window.location.href).href; } catch (e) { absUrl = url; }
      shouldPush = (method !== 'GET' && method !== 'HEAD') && !!finalUrl && finalUrl !== absUrl;
      // _restoreNav() AVANT µ._mjs_navApplyJson (qui émet mjs:load) : sans ce déplacement, un
      // écouteur mjs:load lisait µ.nav.active===true ICI alors qu'il vaut déjà false sur les branches
      // clic/popstate pour ce même événement — incohérence d'état corrigée, reste de l'ordre inchangé
      // (purge des caches, PRG/_mjs_lastUjsPath toujours APRÈS, comme avant).
      _restoreNav();
      // `el: opts.el` : plomberie de l'élément d'origine (posé par les 2 call-sites de
      // µ._mjs_navDispatch, cf. son bandeau), lu ici par closure et retransmis pour que µ._mjs_navFlash/
      // µ._mjs_navRunCallback (dans µ._mjs_navApplyJson) le voient sur CE chemin (mjs-method/submit → JSON).
      // `µ._mjs_lastUjsPath` déplacé en `onSwapped`
      // (même raisonnement que les 2 sites jumeaux popstate/clic, cf. leurs bandeaux) : posé
      // SYNCHRONE juste après cet appel (avant), il pouvait pointer la destination alors que
      // le swap réel (transition différée par µ._mjs_vtWrapSwap, DANS µ._mjs_navApplyJson) n'avait pas
      // encore eu lieu — une 2e navigation démarrée dans ce délai hibernait le DOM encore affiché
      // sous CETTE clé (pageCache empoisonné).
      var _onJsonSwapped = function() {
        if (shouldPush) {
          try { var _ju = new URL(finalUrl, window.location.href); µ._mjs_lastUjsPath = _ju.pathname + _ju.search; } catch (e2) {}
        } else if ((method === 'GET' || method === 'HEAD') && getUrl) {
          try { var _gu = new URL(getUrl, window.location.href); µ._mjs_lastUjsPath = _gu.pathname + _gu.search; } catch (e3) {}
        }
      };
      µ._mjs_navApplyJson(html, finalUrl, { push: shouldPush, via: via, el: opts.el, seq: seq, onSwapped: _onJsonSwapped });
      if (method !== 'GET' && method !== 'HEAD') {
        µ.pageCache.clear();
        µ._mjs_preloadCache.clear();
        µ._mjs_preloaded.clear();
      }
      return;
    } else if (µ._mjs_navReloadAsked(nav && nav.reload)) {
      // X-MJS-Reload (chemin HTML/texte) : AVANT tout parse — la page s'en va, le corps de la
      // réponse est sans importance. Branche à part (pas nichée dans le test `html.includes('<html')`
      // plus bas) : un back qui répond `reload` peut légitimement renvoyer un corps qui n'est PAS une
      // page HTML complète (200 vide, JSON minimal).
      // RÈGLE UNIQUE, même ordre sur les 4 chemins (JSON/
      // HTML clic/popstate/submit) : reload EXPLICITE > version PÉRIMÉE > method:'none' > swap normal.
      // Un ordre demandé par le serveur prime sur tout, y compris une version déjà différente.
      _restoreNav();
      µ._mjs_navHardReload(finalUrl || url);
      return;
    } else if (nav && nav.version && µ.version && nav.version !== µ.version) {
      // HISSÉE hors de la branche `html.includes('<html')` :
      // nichée là, elle restait INATTEIGNABLE dès que `µ._mjs_navMethodOf(nav.method) === 'none'` répondait
      // avant elle sur CE chemin (soumission/@method) — même bundle périmé, un CLIC rechargeait (popstate
      // et clic testent la version AVANT 'none'), une SOUMISSION ne faisait RIEN. Même garde que le
      // chemin JSON (json.version) et que popstate/clic (ordre désormais IDENTIQUE sur les 4 chemins) :
      // bundle client changé depuis le chargement de cette page ⇒ rechargement complet plutôt qu'un swap
      // avec l'ancien JS. `finalUrl || url` : MÊME destination qu'avant ce déplacement, inchangée.
      window.location.assign(finalUrl || url);
      return;
    } else if (µ._mjs_navMethodOf(nav && nav.method) === 'none') {
      // X-MJS-Method: none (chemin HTML/texte) : le back répond « ne bouge pas » — corps ignoré
      // AVANT tout parse ET avant l'avertissement « réponse non reconnue » plus bas (un back peut
      // répondre un 200 vide sans être grondé). µ._mjs_navDropHibernation annule l'hibernation posée avant
      // la réponse pour CETTE navigation (les nœuds affichés restent affichés, pas hibernés pour rien).
      _restoreNav();
      µ._mjs_navDropHibernation();
      return;
    } else if (html && typeof html === 'string' && html.includes('<html')) {
      // target/method voyagent désormais aussi sur le chemin HTML (en-têtes X-MJS-Target/
      // X-MJS-Method, le serveur les pose) : même normalisation que le protocole JSON. `cache`
      // pareil (X-MJS-Cache), repli balise <meta name="mjs-cache"> lue dans `doc` une fois parsé (cf.
      // µ._mjs_navCacheOf) — calculé APRÈS le parse, juste en dessous.
      _navTarget = (nav && typeof nav.target === 'string' && nav.target) ? nav.target : null;
      _navMethod = µ._mjs_navMethodOf(nav && nav.method);
      parser = new DOMParser();
      doc = parser.parseFromString(html, 'text/html');
      _navCache = µ._mjs_navCacheOf(doc, nav && nav.cache);
      // Re-query (pas la closure) : les DEUX contenants résolus ENSEMBLE au moment du swap
      // (µ._mjs_navResolveZones) — le contenant côté PAGE peut avoir été remplacé entre-temps.
      _zones = µ._mjs_navResolveZones(doc, _navTarget);
      newRoot = _zones.newZone;
      liveInfo = _zones.liveInfo;
      liveRoot = liveInfo.zone;
      if (newRoot && liveRoot) {
        // (Pas d'Autoloader.observe : l'observer body du bootstrap suffit.)
        _swapped = true; // un swap va réellement avoir lieu : `load` s'émettra en fin de fonction
        newNodes = Array.prototype.slice.call(newRoot.childNodes);
        µ._mjs_navWarnScripts(newNodes);
        // MÊME motif que les 5 autres sites (µ._mjs_navApplyJson,
        // popstate cache/net, clic cache/net) : µ._mjs_vtWrapSwap peut DIFFÉRER `_swapSubmit` (rappel de
        // document.startViewTransition, asynchrone) — la queue qui suivait ICI MÊME (lastUjsPath
        // GET/HEAD, puis plus bas dans `done` : _restoreNav, purge, PRG pushState, mjs:load)
        // s'exécutait alors AVANT le swap réel. `_finSubmit` regroupe désormais _restoreNav/purge/
        // PRG/load (identiques à avant, cf. bandeaux plus bas, simplement déplacés ici) et se
        // rappelle en DERNIÈRE ligne de `_swapSubmit` : sans transition de vue (`_mjs_vtWrapSwap` appelle
        // `_swapSubmit()` SYNCHRONEMENT), l'ordre observable reste IDENTIQUE à aujourd'hui — avec
        // transition, la queue attend désormais le swap réel comme les 5 autres sites. `return` juste
        // après l'appel à µ._mjs_vtWrapSwap, plus bas : sans lui, la queue partagée (branches SANS swap,
        // cf. plus bas dans `done`) s'exécuterait une SECONDE fois pour cette branche.
        var _finSubmit = function() {
          if (!stale) { _restoreNav(); }
          // cache de page/préchargement JAMAIS
          // invalidé après une mutation : `µ.pageCache` (pages hibernées) et
          // `µ._mjs_preloadCache` (HTML préchargé au survol/eager) sont tous deux
          // figés au contenu lu AVANT la mutation. Exemple concret : DELETE d'un
          // post depuis sa page de détail, retour vers `/posts` — si `/posts` est
          // encore en cache (visitée juste avant), le post supprimé y restait
          // listé indéfiniment (contenu obsolète resservi depuis le cache, sans
          // aucun nouveau fetch). Aucune granularité possible ici (pas de tag de
          // dépendance page↔ressource dans ce framework) : on purge tout par
          // sécurité, au prix d'un simple re-fetch au prochain accès — même
          // politique que Turbo/Rails-UJS après un submit non-GET. `pageCache`
          // reste sûr à vider : `.clear()` (mjs_init.ts) passe désormais par
          // onEvict pour chaque entrée (sinon les arbres DOM hibernés qu'il
          // contient fuiraient leurs timers, cf. commentaire d'onEvict plus haut).
          if (method !== 'GET' && method !== 'HEAD') {
            µ.pageCache.clear();
            µ._mjs_preloadCache.clear();
            µ._mjs_preloaded.clear();
          }
          // PRG (Post/Redirect/Get) cassé :
          // `fetch` suit les redirections NATIVEMENT ; `finalUrl` (= `response.url`,
          // cf. mjs_ajax.ts) reflète la destination RÉELLE après tout redirect
          // serveur. Sans mise à jour de l'URL affichée, un submit POST/PUT/PATCH/
          // DELETE qui redirige laissait la barre d'adresse bloquée sur l'endpoint
          // de MUTATION d'origine (ex. `/posts` pour un POST qui crée et redirige
          // vers `/posts/42`) — un F5 RE-SOUMETTRAIT alors le formulaire (boîte
          // navigateur "confirmer la resoumission"), exactement ce que PRG existe
          // pour éviter. Exclut GET/HEAD : leur URL EST déjà la requête elle-même
          // (query comprise) — un autre sujet.
          // `!stale` (cf. plus haut) : une navigation plus récente a
          // déjà posé la BONNE URL — ne pas l'écraser avec celle, périmée, de CE submit.
          // `url` est la valeur BRUTE de
          // l'attribut action (souvent RELATIVE : `/posts`), `finalUrl` (response.url)
          // toujours ABSOLUE : `finalUrl !== url` était vrai à CHAQUE submit non-GET à
          // action relative même SANS redirection → pushState PARASITE vers l'endpoint
          // de mutation (barre sur la ressource supprimée après un DELETE, entrée
          // d'historique en trop, `_mjs_lastUjsPath` pollué). On normalise `url` en absolu
          // avant de comparer.
          var _absUrl;
          try { _absUrl = new URL(url, window.location.href).href; } catch (e) { _absUrl = url; }
          if (!stale && method !== 'GET' && method !== 'HEAD' && finalUrl && finalUrl !== _absUrl) {
            try {
              window.history.pushState({}, '', finalUrl);
              var _u = new URL(finalUrl, window.location.href);
              µ._mjs_lastUjsPath = _u.pathname + _u.search;
            } catch (e) {}
          }
          // mjs:load émis ICI, à la toute fin de `_finSubmit` (elle-même appelée en toute fin
          // de `_swapSubmit`, cf. bandeau ci-dessus) : APRÈS le bloc PRG ci-dessus (un POST/PUT/
          // PATCH/DELETE qui redirige ne pousse `finalUrl` qu'à cet instant) et APRÈS _restoreNav()
          // (plus haut) — µ.nav.active est retombé quand l'écouteur tourne, comme sur clic/popstate.
          // `_swapped` : garde posée par la SEULE branche qui installe un contenu sur ce chemin
          // (toujours vraie ici — conservée telle quelle, défensive, cf. bandeau ci-dessus).
          if (_swapped) {
            loadPaths = µ._mjs_navEmitPaths(finalUrl || getUrl || url);
            µ._mjs_navEmit('load', { path: loadPaths.path, url: loadPaths.url, via: via, zone: _installedZone, initial: false }, false);
          }
        };
        var _swapSubmit = function() {
          // swap PÉRIMÉ sous transition de vue : `seq`
          // capturé plus haut (avant le fetch réseau) ; cf. bandeau de `swap` dans µ._mjs_navApplyJson.
          // `stale` (calculée en tête de `done`) daterait d'AVANT ce délai différé — retest direct.
          if (seq !== µ._mjs_navSeq) { return; }
          // chemin HTML, target/method désormais suivis COMME le JSON (µ._mjs_navInstallNodes
          // gère replace/append/update + suivi de zone) — plus jamais figé sur <body>.
          // valeur RETOURNÉE : le contenant EFFECTIF après installation (liveInfo.zone se
          // détache en method:'replace', cf. µ._mjs_navInstallNodes) — capturée pour l'émission finale plus bas.
          µ._mjs_navApplyHead(doc); // tête d'abord (synchrone) : un <@head><title> qui arrive tirera ensuite dans sa microtâche et gagnera
          _installedZone = µ._mjs_navInstallNodes(liveInfo, newNodes, _navMethod, _navCache);
          if (typeof µ._mjs_focusAfterSwap === 'function') { µ._mjs_focusAfterSwap(µ._mjs_navFirstEl(newNodes)); }
          // navigation GET/HEAD
          // réellement effectuée : l'URL (poussée AU GESTE, cf. branche GET plus
          // bas) devient la page AFFICHÉE → `_mjs_lastUjsPath` DOIT la refléter, sinon
          // le prochain clic archive les résultats sous la clé de la page d'AVANT
          // le submit (pageCache empoisonné). `_mjs_lastUjsPath` ne bouge qu'au swap RÉEL.
          if ((method === 'GET' || method === 'HEAD') && getUrl) {
            try { var _gu = new URL(getUrl, window.location.href); µ._mjs_lastUjsPath = _gu.pathname + _gu.search; } catch (e) {}
          }
          // mjs:load DÉPLACÉ à la toute fin de `done` (après le bloc PRG, tout en bas) : ICI,
          // `emitPath`/`emitUrl` (calculés en tête de µ._mjs_navDispatch) seraient PÉRIMÉS sur un PRG — un
          // POST/PUT/PATCH/DELETE qui redirige ne pousse `finalUrl` qu'APRÈS ce point (cf. l'émission
          // finale, gardée par `_swapped`).
          // DERNIÈRE ligne de `_swapSubmit` : cf. bandeau
          // `_finSubmit` ci-dessus.
          _finSubmit();
        };
        // @viewTransition (mjs-vt) : pas de lien déclencheur pour un submit → résolution config seule.
        if (typeof µ._mjs_vtWrapSwap === 'function') { µ._mjs_vtWrapSwap(null, _swapSubmit); } else { _swapSubmit(); }
        return;
      } else {
        // HTML complet reçu mais aucun
        // <body> exploitable (page courante ou réponse serveur mal formée) :
        // sans ce warn, le submit "réussissait" en silence sans rien afficher
        // de nouveau — aucune trace pour comprendre pourquoi.
        µ.warn('[µ.UJS] Réponse HTML du submit reçue, mais aucun <body> exploitable (page courante ou réponse serveur) — aucun contenu mis à jour.');
      }
    } else if (html != null) {
      // réponse non-HTML (JSON, texte,
      // fragment sans <html) silencieusement ignorée : aucun swap, aucune
      // trace. Un submit qui semble n'avoir "rien fait" est un des pièges de
      // debug les plus frustrants — un warn coûte rien et pointe direct la
      // cause (serveur mal configuré pour ce endpoint, ou usage volontaire
      // d'un endpoint JSON qui devrait alors porter @noUJS).
      µ.warn('[µ.UJS] Réponse du submit non reconnue comme une page HTML complète (attendu : une chaîne contenant "<html") — aucun contenu mis à jour. Pour gérer vous-même une réponse non-HTML, pose @noUJS sur le <form>.');
    }
    if (!stale) { _restoreNav(); }
    // cache de page/préchargement JAMAIS
    // invalidé après une mutation : `µ.pageCache` (pages hibernées) et
    // `µ._mjs_preloadCache` (HTML préchargé au survol/eager) sont tous deux
    // figés au contenu lu AVANT la mutation. Exemple concret : DELETE d'un
    // post depuis sa page de détail, retour vers `/posts` — si `/posts` est
    // encore en cache (visitée juste avant), le post supprimé y restait
    // listé indéfiniment (contenu obsolète resservi depuis le cache, sans
    // aucun nouveau fetch). Aucune granularité possible ici (pas de tag de
    // dépendance page↔ressource dans ce framework) : on purge tout par
    // sécurité, au prix d'un simple re-fetch au prochain accès — même
    // politique que Turbo/Rails-UJS après un submit non-GET. `pageCache`
    // reste sûr à vider : `.clear()` (mjs_init.ts) passe désormais par
    // onEvict pour chaque entrée (sinon les arbres DOM hibernés qu'il
    // contient fuiraient leurs timers, cf. commentaire d'onEvict plus haut).
    if (method !== 'GET' && method !== 'HEAD') {
      µ.pageCache.clear();
      µ._mjs_preloadCache.clear();
      µ._mjs_preloaded.clear();
    }
    // PRG (Post/Redirect/Get) cassé :
    // `fetch` suit les redirections NATIVEMENT ; `finalUrl` (= `response.url`,
    // cf. mjs_ajax.ts) reflète la destination RÉELLE après tout redirect
    // serveur. Sans mise à jour de l'URL affichée, un submit POST/PUT/PATCH/
    // DELETE qui redirige laissait la barre d'adresse bloquée sur l'endpoint
    // de MUTATION d'origine (ex. `/posts` pour un POST qui crée et redirige
    // vers `/posts/42`) — un F5 RE-SOUMETTRAIT alors le formulaire (boîte
    // navigateur "confirmer la resoumission"), exactement ce que PRG existe
    // pour éviter. Exclut GET/HEAD : leur URL EST déjà la requête elle-même
    // (query comprise) — un autre sujet.
    // `!stale` (cf. plus haut) : une navigation plus récente a
    // déjà posé la BONNE URL — ne pas l'écraser avec celle, périmée, de CE submit.
    // `url` est la valeur BRUTE de
    // l'attribut action (souvent RELATIVE : `/posts`), `finalUrl` (response.url)
    // toujours ABSOLUE : `finalUrl !== url` était vrai à CHAQUE submit non-GET à
    // action relative même SANS redirection → pushState PARASITE vers l'endpoint
    // de mutation (barre sur la ressource supprimée après un DELETE, entrée
    // d'historique en trop, `_mjs_lastUjsPath` pollué). On normalise `url` en absolu
    // avant de comparer.
    var _absUrl;
    try { _absUrl = new URL(url, window.location.href).href; } catch (e) { _absUrl = url; }
    if (!stale && method !== 'GET' && method !== 'HEAD' && finalUrl && finalUrl !== _absUrl) {
      try {
        window.history.pushState({}, '', finalUrl);
        var _u = new URL(finalUrl, window.location.href);
        µ._mjs_lastUjsPath = _u.pathname + _u.search;
      } catch (e) {}
    }
    // mjs:load émis ICI, à la toute fin de `done` : APRÈS le bloc PRG ci-dessus (un POST/PUT/
    // PATCH/DELETE qui redirige ne pousse `finalUrl` qu'à cet instant) et APRÈS _restoreNav() (plus
    // haut, avant ce bloc) — µ.nav.active est retombé quand l'écouteur tourne, comme sur clic/popstate.
    // `_swapped` : garde posée par la SEULE branche qui installe un contenu sur ce chemin.
    if (_swapped) {
      loadPaths = µ._mjs_navEmitPaths(finalUrl || getUrl || url);
      µ._mjs_navEmit('load', { path: loadPaths.path, url: loadPaths.url, via: via, zone: _installedZone, initial: false }, false);
    }
  };
  // callback d'ERREUR du submit :
  // avant, aucun n'était passé → toute réponse non-2xx (dont le 422 de validation
  // qui renvoie le formulaire ré-affiché avec ses erreurs, convention Rails/Turbo)
  // était convertie en Error par mjs_ajax, son corps JETÉ, et le submit
  // "réussissait" en silence sans rien afficher. On ré-affiche le corps HTML d'un
  // 4xx via `done` (qui gère aussi l'invalidation de cache) ; sinon on invalide
  // par sécurité (la mutation a pu partir) et on trace.
  var fail = function(err) {
    var st;
    err = err || {};
    st = err.status;
    if (typeof err.body === 'string' && st >= 400 && st < 500 && err.body.indexOf('<html') !== -1) {
      // `err.nav` transmis comme sur le chemin de succès (mjs_ajax attache l'objet
      // `{version,target,method}` à l'erreur) : une page d'erreur HTML complète servie par un build
      // PLUS RÉCENT doit déclencher le rechargement, pas un swap avec l'ancien JS — target/method
      // profitent pareil d'un éventuel repli HTML porté par l'erreur (même chemin que le succès).
      return done(err.body, err.url, void 0, err.nav);
    }
    // 422 JSON (protocole de navigation, docs/21-navigation.md
    // « Formulaires ») : le corps suit la forme EXACTE du serveur ({module,
    // props, url, title:null, version}, `errors` ajouté DANS `props`) — on
    // pose SEULEMENT les props (le composant en place re-rend par
    // réactivité, `µres.errors` par ex.) : PAS de remontage, PAS d'historique
    // — contrairement au cas nominal de µ._mjs_navApplyJson, jamais appelé ici.
    //
    // FUSION (µ._mjs_resMerge), plus jamais µ._mjs_resSet.
    // Le critère du sac est « une NOUVELLE page arrive-t-elle ? » : oui →
    // remplacement intégral (les props de la page quittée s'en vont avec elle) ;
    // non → fusion. Un 422 est le cas « non » par excellence — la page affichée
    // ne bouge pas, seul le formulaire est refusé. En remplacement, un back qui
    // répond juste `props: { errors: … }` (ce que fait n'importe quel Rails
    // idiomatique : re-rendre le formulaire fautif, pas l'état complet de la
    // page) EFFAÇAIT tout le reste du sac — panier, compteurs, badges, pagination
    // en cours — sur une simple faute de saisie. `mjs serve` masquait le défaut
    // en renvoyant systématiquement le sac entier ; un back applicatif, non.
    // Même règle que `method:'none'` (µ._mjs_navApplyJson, plus haut) : les clés
    // tues survivent, EFFACER une clé demande de l'envoyer explicitement à
    // `null`. Garde `typeof` conservée à l'identique (µ._mjs_resMerge vit dans
    // mjs_store_globals.ts, module toujours présent mais lu défensivement ici).
    if (err.body && typeof err.body === 'object' && st === 422) {
      _restoreBusy();
      if (seq === µ._mjs_navSeq) { _restoreNav(); }
      if (method !== 'GET' && method !== 'HEAD') {
        if (µ.pageCache && µ.pageCache.clear) { µ.pageCache.clear(); }
        if (µ._mjs_preloadCache && µ._mjs_preloadCache.clear) { µ._mjs_preloadCache.clear(); }
        if (µ._mjs_preloaded && µ._mjs_preloaded.clear) { µ._mjs_preloaded.clear(); }
      }
      // veilleur flash/error : CONSOMME props.flash/props.error AVANT µ._mjs_resMerge (jamais
      // props.errors, pluriel — laissé intact pour le composant). `opts.el` lu par CLOSURE (posé par
      // les 2 call-sites de µ._mjs_navDispatch, cf. son bandeau) — jamais de callback ici (@callback = succès
      // seulement, un 422 est un refus).
      if (typeof µ._mjs_navFlash === 'function') { µ._mjs_navFlash(err.body.props || {}, opts.el); }
      if (typeof µ._mjs_resMerge === 'function') { µ._mjs_resMerge(err.body.props || {}); }
      return;
    }
    _restoreBusy();
    if (seq === µ._mjs_navSeq) { _restoreNav(); }
    if (method !== 'GET' && method !== 'HEAD') {
      if (µ.pageCache && µ.pageCache.clear) { µ.pageCache.clear(); }
      if (µ._mjs_preloadCache && µ._mjs_preloadCache.clear) { µ._mjs_preloadCache.clear(); }
      if (µ._mjs_preloaded && µ._mjs_preloaded.clear) { µ._mjs_preloaded.clear(); }
    }
    µ.warn('[µ.UJS] Submit en échec (statut ' + (st || '?') + ') — aucune page de repli HTML complète dans la réponse.');
    // échec TRANSPORT (ni 422, ni page d'erreur HTML complète, ni réponse reconnue) :
    // affichage utilisateur EN PLUS du warn console ci-dessus, par le même canal que le veilleur
    // (respecte @flash/mjs-flash et µ.config.flash — silent/console/false s'appliquent tel quel).
    // µ._mjs_label('ujs', 'sendFailed') choisit la langue AFFICHÉE, repli littéral
    // fr codé en dur si absent (µ._mjs_label indisponible ou clé manquante, vieux manifest).
    if (typeof µ._mjs_navFlashShow === 'function' && typeof µ._mjs_navFlashPolicy === 'function') {
      µ._mjs_navFlashShow('error', ((typeof µ._mjs_label === 'function' && µ._mjs_label('ujs', 'sendFailed')) || 'Échec de l\'envoi — le serveur n\'a pas répondu.') + (st ? ' (' + st + ')' : ''), µ._mjs_navFlashPolicy(opts.el));
    }
  };
  // FIX CRITIQUE : `µ.ajax.get`/`delete` ont la signature (url, success,
  // error, always) — SANS paramètre data. L'ancien appel uniforme
  // `ajaxFunction(url, payload, done)` passait le FormData en `success` :
  // un formulaire GET partait SANS ses champs et son callback atterrissait
  // en `error` → recherche/filtre/pagination par formulaire silencieusement
  // morts. On sérialise les champs en query string pour GET, et DELETE part
  // sans corps (REST : l'identifiant voyage dans l'URL).
  if (method === 'GET' || method === 'HEAD') {
    // qs/getUrl calculés en TÊTE de fonction désormais (before-visit/visit en ont besoin
    // avant même de savoir si cette navigation aura lieu) — cf. le bloc juste après `opts = opts || {}`.
    // un form GET est une VRAIE
    // navigation : on pousse l'URL AU GESTE (même politique « l'URL reflète
    // l'intention » que le clic) pour que la recherche/le filtre soit
    // bookmarkable (F5 conserve), partageable, et que le Précédent en sorte —
    // avant, la barre restait figée sur l'URL d'avant la recherche, et au prochain
    // clic le DOM des résultats s'archivait sous la clé de la page d'AVANT
    // (pageCache empoisonné). On hiberne la page quittée comme le clic (Précédent
    // post-recherche resservi sans re-fetch). `_mjs_lastUjsPath` ne bouge qu'au swap
    // RÉEL (cf. `done`).
    var _curMz = µ._mjs_navMountZone(document, null);
    var _curRoot = _curMz.zone;
    var _curPath = µ._mjs_lastUjsPath;
    try { window.history.pushState({}, '', getUrl); } catch (e) {}
    // le contenu du contenant est hiberné, contenant compris quand c'est <body>
    // (avant : <body> en était exclu du pageCache). Simple PHOTOGRAPHIE (lecture de
    // childNodes, aucun retrait) : le retrait RÉEL des nœuds n'a lieu qu'au prochain
    // µ._mjs_zoneFill (cf. commentaire du même motif au popstate).
    µ._mjs_navHibernate(µ._mjs_navCacheZone(), _curPath);
    // `fail` et pas `void 0` : sans callback d'échec, un GET de formulaire (recherche, filtre)
    // qui tombe en panne réseau ne repassait JAMAIS par `_restoreNav` — µ.nav.active restait à `true`
    // à vie, et depuis, la barre de progression restait à l'écran. `fail` garde déjà les verbes
    // non mutants hors de la purge de cache, il est sûr sur ce chemin.
    return µ._mjs_navRequest('GET', getUrl, void 0, done, fail, void 0, void 0, navSignal);
  }
  if (method === 'DELETE') {
    return µ._mjs_navRequest('DELETE', url, void 0, done, fail, void 0, void 0, navSignal);
  }
  // Verbes supportés à ce point (GET/HEAD/DELETE déjà traités ci-dessus) :
  // POST/PUT/PATCH seulement — µ._mjs_navRequest parle directement à _request
  // (pas de dispatch via µ.ajax[method], canal PUBLIC désormais court-circuité
  // par le canal interne) : la validation du verbe reste donc EXPLICITE ici.
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
    µ.error(`[µ.UJS] Unsupported HTTP verb: ${method}`);
    _restoreBusy();
    if (seq === µ._mjs_navSeq) { _restoreNav(); }
    return;
  }
  // le serveur mjs serve répond 415 à tout
  // multipart/form-data SANS fichier réellement joint (seul DELETE, sans
  // corps, traversait déjà) : un submit sans fichier repart donc en
  // application/x-www-form-urlencoded (déjà accepté par ce même serveur), et
  // garde son FormData multipart UNIQUEMENT si un vrai fichier est joint (le
  // serveur apprend le multipart dans une tâche sœur, hors périmètre
  // ici). « Fichier réellement joint » = valeur `instanceof File` avec un nom
  // ou un poids — un `<input type=file>` laissé vide vaut `File{name:'',
  // size:0}`, PAS un fichier joint. Garde `typeof File !== 'undefined'` :
  // harnais de tests sans constructeur File.
  var _hasRealFile = false;
  if (typeof payload.forEach === 'function' && typeof File !== 'undefined') {
    payload.forEach(function(v) {
      if (v instanceof File && (v.name !== '' || v.size > 0)) { _hasRealFile = true; }
    });
  }
  if (!_hasRealFile && typeof payload.forEach === 'function') {
    // aucun fichier joint : reconstruction en URLSearchParams (ordre
    // préservé), fichier VIDE omis — sinon il se sérialiserait en
    // "[object File]" au lieu de disparaître proprement.
    var _params = new URLSearchParams();
    payload.forEach(function(v, k) {
      if (typeof File !== 'undefined' && v instanceof File) { return; }
      _params.append(k, v);
    });
    payload = _params;
  }
  // (method, url, data, success, error, always, timeout, signal) — même canal
  // interne que GET/DELETE ci-dessus (µ._mjs_navRequest, pose X-MJS-Nav).
  return µ._mjs_navRequest(method, url, payload, done, fail, void 0, void 0, navSignal);
};
// <<< extrait-test _mjs_navDispatch

// ════════════════════════════════════════════════════════════════════════════
// PRÉCHARGEMENT DES LIENS (µ.preload). Trois niveaux, priorité décroissante :
//   3. attribut `@preload` sur le <a>       → data-mjs-preload  (ce lien)
//   2. directive `@preload` racine de module → host._mjs_preload (tous ses liens)
//   1. config `µ.preload` { view, page }     (défaut global, émis au manifeste)
// Modes : off | hover | on (« eager » toléré en alias : dès l'apparition).
//   - Lien VUE (`#/…`)  → précharge le MODULE de la route (µ.Autoloader.load),
//     quasi gratuit ; cible résolue par µ.Router._mjs_resolveModules (sans injecter).
//   - Lien PAGE (autre page serveur) → fetch du HTML mis en cache → clic instantané.
// ════════════════════════════════════════════════════════════════════════════
µ._mjs_preloaded = new Set();      // clés déjà préchargées (anti-doublon)
// Map SANS BORNE : une session SPA
// longue durée qui survole/eager-précharge de nombreux liens distincts (menu
// de navigation, listing paginé avec IDs dynamiques) accumulait une entrée
// par URL préchargée, POUR TOUJOURS — même dérive mémoire non bornée que
// pageCache avant son passage en LRU (cf. commentaire ligne 5). Borne plus
// large que pageCache (30 vs 10) : ces entrées sont plus légères (texte HTML
// brut, pas un arbre DOM+composants+listeners) et souvent SPÉCULATIVES
// (survol sans clic derrière) — les évincer trop tôt perdrait le bénéfice
// pour un menu qui liste plus de 10 liens. Pas d'onEvict nécessaire (aucun
// teardown : juste du texte, contrairement aux arbres hibernés de pageCache).
// >>> extrait-test _mjs_preloadCache-init
µ._mjs_preloadCache = typeof µ.LRUCache === 'function' ? new µ.LRUCache(30) : new Map();
// <<< extrait-test _mjs_preloadCache-init

// `µ._mjs_preloaded` (Set anti-doublon)
// désynchronisé du LRU `_mjs_preloadCache` : après éviction d'une URL, sa clé RESTAIT
// dans le Set → un nouveau survol était ignoré (`has(key)`) alors que le cache
// était vide → l'URL n'était plus JAMAIS repréchargeable (dégradation silencieuse
// du préchargement au fil de la session). onEvict resynchronise (clé page =
// 'page:' + href, cf. `_mjs_preloadLink`). La Map de repli n'appelle jamais onEvict
// (non bornée) — sans effet, inoffensif.
µ._mjs_preloadCache.onEvict = function(url) { µ._mjs_preloaded.delete('page:' + url); };

// `on` est le nom CANONIQUE (`eager` disparaît de
// mjs.config.json, VALID_PRELOAD_MODES = off/hover/on) ; `eager` reste un alias
// TOLÉRÉ ici, jamais une erreur : un attribut déjà compilé (`data-mjs-preload`,
// le compilateur accepte encore les deux orthographes pour `@preload`) ou un
// `µ.preload` forgé à la main peut porter l'ancien mot, et cette fonction tourne
// à CHAQUE survol/scan — y lever casserait la navigation en silence pour un
// réglage qu'aucune étape de build n'a jamais signalé comme fautif.
// >>> extrait-test _mjs_normPreload
µ._mjs_normPreload = function(m) { return m === 'eager' ? 'on' : m; };
// <<< extrait-test _mjs_normPreload

// Fetch de page conscient du cache de préchargement : sert le HTML déjà préchargé
// s'il existe (clic instantané), sinon délègue à µ.ajax.get. Utilisé par la nav.
// `signal` (AbortController d'une navigation, cf. `_mjs_abortStaleNav`) : PAS
// concerné par la branche préchargée ci-dessous (déjà résolue, rien à
// abandonner) — uniquement transmis au fetch réseau de repli.
// >>> extrait-test _mjs_ajaxGet
µ._mjs_ajaxGet = function(url, cb, errCb, signal) {
  if (µ._mjs_preloadCache.has(url)) {
    // le HTML préchargé mémorise
    // AUSSI sa destination finale (`response.url`) : un lien redirigé au
    // préchargement (survol) doit pouvoir être réconcilié au clic exactement
    // comme un fetch direct. Rétrocompatible avec une entrée « chaîne brute ».
    // `nav` (en-têtes de navigation X-MJS-*) mémorisé
    // lui aussi par `_mjs_preloadLink` désormais, ressorti ici en 4e argument — comme le fetch réseau
    // direct plus bas (`_mjs_navRequest` → succès à 4 arguments, cf. `_request` dans mjs_ajax.ts).
    // Sans ça, une page préchargée ignorait `version`/`reload`/`target`/`method`/`cache` du
    // serveur : la garde « bundle périmé » ne jouait pas dessus. Entrée « chaîne brute » (ancienne,
    // ou posée à la main) : `nav` retombe à `void 0`, toléré tel quel par les appelants.
    var entry = µ._mjs_preloadCache.get(url);
    var html = (entry && typeof entry === 'object') ? entry.html : entry;
    var finalUrl = (entry && typeof entry === 'object') ? entry.url : void 0;
    var nav = (entry && typeof entry === 'object') ? entry.nav : void 0;
    return Promise.resolve().then(function() { return cb(html, finalUrl, void 0, nav); });
  }
  // canal interne (µ._mjs_navRequest, pose X-MJS-Nav) au lieu de µ.ajax.get
  // direct : cette fonction ne sert QU'à la navigation ujs (cf. son commentaire
  // d'en-tête), jamais à un appel applicatif.
  if (typeof µ._mjs_ajaxRequest === 'function') { return µ._mjs_navRequest('GET', url, void 0, cb, errCb, void 0, void 0, signal); }
  return typeof errCb === 'function' ? errCb() : void 0;
};
// <<< extrait-test _mjs_ajaxGet

// Candidat au préchargement ? (mêmes garde-fous que le handler de clic.)
// >>> extrait-test _mjs_isPreloadableLink
µ._mjs_isPreloadableLink = function(link) {
  return !!link && link.tagName === 'A' && !µ._mjs_navNoUjs(link)
    && link.origin === window.location.origin
    && (!link.target || link.target === '_self')
    && !link.hasAttribute('download')
    && link.protocol !== 'javascript:' && link.protocol !== 'mailto:'
    // @method="delete/post/put/patch" : jamais préchargeable (fetch GET gaspillé — et sur un
    // serveur pas strictement REST, potentiellement DÉCLENCHÉ — au survol d'une route de mutation ;
    // le clic réel passe par µ._mjs_navDispatch, jamais ce cache). "get" explicite reste préchargeable :
    // même verbe que le préchargement lui-même.
    && (!link.hasAttribute('mjs-method') || link.getAttribute('mjs-method').toUpperCase() === 'GET');
};
// <<< extrait-test _mjs_isPreloadableLink

// Mode effectif d'un lien pour son type : attribut (3) > module hôte (2) > config (1).
// asymétrie de vocabulaire :
// `_mjs_normPreload` ('on' ≡ 'eager') était appliqué aux niveaux 3 et 2 (attribut,
// directive module) mais PAS au niveau 1 (config `µ.preload`, ligne juste en
// dessous) — `mjs.config.json` REJETTE déjà 'on' à la validation (bundler/
// config.ts, VALID_PRELOAD_MODES), donc inatteignable par ce chemin normal ;
// mais `µ.preload` reste un objet JS ORDINAIRE, réassignable à la main par du
// code applicatif (`µ.preload = { view: 'on' }`, contournant le validateur
// du bundler) — un tel réglage restait 'on' TEL QUEL jusqu'ici, ne matchant
// alors NI 'off' NI 'hover' NI 'eager' dans `_mjs_preloadLink` → précisément
// « µ.preload forgé à la main avec 'on' » : totalement INERTE, silencieusement.
// Fix : même normalisation appliquée aux 3 niveaux, sans exception.
// les MOTS ont basculé : `on` est
// désormais le nom canonique dans `mjs.config.json` (VALID_PRELOAD_MODES =
// off/hover/on), `eager` l'alias TOLÉRÉ. Le même risque d'asymétrie existerait
// si `eager` forgé à la main dans `µ.preload` n'était normalisé qu'à certains
// niveaux — ce n'est pas le cas, `_mjs_normPreload` tourne aux 3 niveaux ici aussi.
// >>> extrait-test _mjs_effectivePreload
µ._mjs_effectivePreload = function(link, type) {
  const attr = link.getAttribute('data-mjs-preload');
  if (attr) { return µ._mjs_normPreload(attr); }
  const root = link.getRootNode ? link.getRootNode() : null;
  const host = root && root.host;
  if (host && host._mjs_preload) { return µ._mjs_normPreload(host._mjs_preload); }
  return µ._mjs_normPreload((µ.preload && µ.preload[type]) || 'off');
};
// <<< extrait-test _mjs_effectivePreload

// Précharge un lien si son mode effectif l'autorise pour ce déclencheur.
// >>> extrait-test _mjs_preloadLink
µ._mjs_preloadLink = function(link, trigger) {
  if (!µ._mjs_isPreloadableLink(link)) { return; }
  const isView = !!link.hash && link.hash.indexOf('#/') === 0
    && link.pathname === window.location.pathname && link.search === window.location.search;
  const type = isView ? 'view' : 'page';
  const mode = µ._mjs_effectivePreload(link, type);
  if (mode === 'off') { return; }
  // hover déclenche sur 'hover' ET 'on' ; le scan d'apparition, sur 'on' seul.
  // (`trigger` distingue QUI appelle — survol ou scan d'apparition — vocabulaire
  // interne séparé de `mode`, jamais exposé en config/directive : il ne bouge pas.)
  if (trigger === 'hover' && mode !== 'hover' && mode !== 'on') { return; }
  if (trigger === 'eager' && mode !== 'on') { return; }
  const key = type + ':' + (isView ? link.hash : link.href);
  if (µ._mjs_preloaded.has(key)) { return; }
  if (isView) {
    µ._mjs_preloaded.add(key);
    if (µ.Router && typeof µ.Router._mjs_resolveModules === 'function' && µ.Autoloader) {
      µ.Router._mjs_resolveModules(link.href).forEach(function(name) {
        µ.Autoloader.load('mjs-' + name);
      });
    }
  } else if (typeof µ._mjs_ajaxRequest === 'function') {
    // Canal INTERNE (µ._mjs_navRequest, pose X-MJS-Nav),
    // comme le fetch réseau direct de `_mjs_ajaxGet` — le HTML préchargé doit porter les MÊMES
    // en-têtes de navigation qu'un clic (parité) ; `nav` (version/reload/target/method/cache)
    // mémorisé avec l'entrée pour être ressorti au clic (cf. `_mjs_ajaxGet`). Avant, `µ.ajax.get`
    // (canal PUBLIC, sans `X-MJS-Nav`) laissait une page préchargée ignorer ces en-têtes — la garde
    // « bundle périmé » ne jouait pas dessus. Garde alignée sur celle de `µ._mjs_navRequest` (même
    // test) plutôt que sur `µ.ajax.get` ; `_mjs_preloaded.add` déplacé DANS cette branche (comme dans
    // la branche `isView` ci-dessus) : un module runtime 'ajax' absent ne doit pas bloquer
    // DÉFINITIVEMENT un essai futur (même raisonnement que le fix onEvict voisin).
    µ._mjs_preloaded.add(key);
    µ._mjs_navRequest('GET', link.href, void 0, function(html, finalUrl, _schemaNom, nav) {
      // On mémorise (html, url FINALE) : le clic pourra réconcilier une
      // redirection serveur même sur un lien servi depuis le cache de préchargement.
      µ._mjs_preloadCache.set(link.href, { html: html, url: finalUrl, nav: nav });
    }, function() {
      µ._mjs_preloaded.delete(key);   // échec réseau → autorise une nouvelle tentative
    });
  }
};
// <<< extrait-test _mjs_preloadLink

// Scanne un sous-arbre (document en light DOM, ou le shadow d'un composant) et
// précharge ses liens en mode 'eager'. mjs_element rappelle ça au montage (les
// liens MJS vivent en shadow, invisibles d'un querySelectorAll sur document).
// >>> extrait-test _mjs_scanEager
µ._mjs_scanEager = function(root) {
  if (!root || typeof root.querySelectorAll !== 'function') { return; }
  const links = root.querySelectorAll('a[href]');
  for (let i = 0; i < links.length; i++) { µ._mjs_preloadLink(links[i], 'eager'); }
};
// <<< extrait-test _mjs_scanEager

// Appelé au montage de CHAQUE composant (les liens MJS vivent en shadow, fermé
// côté client → invisibles d'un scan sur document). Gate bon marché : on ne scanne
// que si le mode 'on' (préchargement dès l'apparition) est réellement en jeu
// (directive du module ou config globale).
// >>> extrait-test _mjs_maybeScanEager
µ._mjs_maybeScanEager = function(host) {
  if (µ._isServer || !host || !host._shadow) { return; }
  const cfg = µ.preload || {};
  // Même normalisation 'eager'≡'on' que _mjs_effectivePreload (cf. son commentaire) —
  // cohérence si µ.preload ou host._mjs_preload portent encore l'ancien mot.
  // un lien `<a @preload="on">`
  // (priorité MAXIMALE, tuto 30-1 : « dès que le lien apparaît ») en shadow d'un
  // module hover/off n'était JAMAIS scanné à l'apparition (gate consultant
  // seulement module hôte + config) → repli au SURVOL seulement. On complète la
  // gate par un querySelector ciblé (un seul par montage, pas un scan complet).
  const eager = µ._mjs_normPreload(host._mjs_preload) === 'on'
    || µ._mjs_normPreload(cfg.view) === 'on' || µ._mjs_normPreload(cfg.page) === 'on'
    || (host._shadow.querySelector && host._shadow.querySelector('a[data-mjs-preload="on"], a[data-mjs-preload="eager"]'));
  if (!eager) { return; }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(function() { µ._mjs_scanEager(host._shadow); });
  } else {
    µ._mjs_scanEager(host._shadow);
  }
};
// <<< extrait-test _mjs_maybeScanEager

// Survol : un seul listener délégué. L'anti-doublon rend l'appel répété (à chaque
// entrée de souris) quasi gratuit.
document.addEventListener('pointerover', function(e) {
  const link = µ.realTarget(e).closest('a');
  if (link) { µ._mjs_preloadLink(link, 'hover'); }
});

// Balaye le document au boot (liens 'eager' en light DOM).
if (typeof requestAnimationFrame === 'function') {
  requestAnimationFrame(function() { µ._mjs_scanEager(document); });
} else {
  µ._mjs_scanEager(document);
}

// ──────────────────────────────────────────────────────────────────────────
// PREMIER CHARGEMENT — `mjs:load` pour la page déjà présente à l'arrivée sur le site (SSR ou
// navigation navigateur classique de la 1re page — jamais un clic/popstate/submit ne l'amène) :
// `via: 'initial'`, `initial: true` — seule émission de tout le cycle de vie à porter cette valeur.
// `document.readyState === 'loading'` (script posé en tête) → les composants ne sont pas encore montés
// (upgrade customElements synchrone pendant le parse) : on attend DOMContentLoaded. Sinon (script
// déféré/module, ou en fin de <body>) → un microtask suffit, JAMAIS synchrone à l'import (les
// composants déjà présents au parse sont encore en cours d'upgrade au moment où CE fichier s'exécute).
// Gardé : ce fichier peut être chargé dans un pool SSR (happy-dom, aucun vrai navigateur derrière
// `document`).
// >>> extrait-test _mjs_navEmitInitial
µ._mjs_navEmitInitial = function() {
  // µ._mjs_navEmitPaths : `window.location.href` est TOUJOURS absolue (même origine, par
  // construction — c'est la localisation courante) ; normalisée pour l'uniformité avec les 12 autres
  // sites d'émission (idempotent : la même origine, une fois rabotée, redonne le chemin attendu).
  var evPaths = µ._mjs_navEmitPaths(window.location.href);
  µ._mjs_navEmit('load', { path: evPaths.path, url: evPaths.url, via: 'initial', zone: µ._mjs_navMountZone(document, null).zone, initial: true }, false);
};
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', µ._mjs_navEmitInitial, { once: true });
  } else {
    Promise.resolve().then(µ._mjs_navEmitInitial);
  }
}
// <<< extrait-test _mjs_navEmitInitial
