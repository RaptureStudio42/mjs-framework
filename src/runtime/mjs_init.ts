// mjs_init.coffee
var MetaViewStub, µ;

µ = {};

// `µ.attach = {}` : namespace
// orphelin, jamais lu ni écrit nulle part ailleurs (`@attach` le template
// directive est un mécanisme totalement distinct, `bindingAttach` dans
// generator/attributes/index.ts, qui n'y touche pas). Retiré.

if (µ._mjs_styleCache == null) {
  µ._mjs_styleCache = {};
}

if (µ._mjs_baseStyleCache == null) {
  µ._mjs_baseStyleCache = new Map();
}

// Registre global pour les Singletons CSS partagés (@css)
if (µ.CSS == null) {
  µ.CSS = {};
}

// Mode `css: 'lazy'` (`µ._mjs_fetchLazyCss`) vit désormais dans
// src/runtime/mjs_lazy_css.ts — détecté PAR CONFIG (`css: 'lazy'`), jamais par
// scan (cf. bundler/index.ts, resolveRuntimeFiles).

// Shield FOUC : DEUX règles partagées entre le document et chaque
// Shadow DOM (via _mjs_applyLayout, cf. mjs_element.ts).
//   1. `:not(:defined)` couvre les modules imbriqués lazy-loadés (async
//      import) tant qu'ils ne sont pas encore enregistrés. La règle doit
//      être DANS chaque shadow car `:not(:defined)` du document ne traverse
//      pas les frontières Shadow DOM. `:not([mjs-ssr])` en épargne les
//      éléments que le RENDU SERVEUR a déjà peints (attribut posé par
//      server/renderToString.ts et server/render-browser.ts sur chaque
//      élément `mjs-*` rendu) : leur balisage est là, visible, et il reste
//      à l'écran jusqu'au premier rendu client, qui le remplace.
//   2. `[mjs-loading]` couvre le gap entre customElements.define et la fin
//      du premier render (posé par connectedCallback, retiré en microtask) —
//      un élément prérendu compris, dont le contenu est alors remplacé.
// Même instance CSSStyleSheet adoptée partout → coût mémoire constant.
µ._mjs_shield = new CSSStyleSheet();

µ._mjs_shield.replaceSync(':not(:defined):not([mjs-ssr]),[mjs-loading]{display:none!important}');

document.adoptedStyleSheets = [...document.adoptedStyleSheets, µ._mjs_shield];

// Feuille système : classes utilitaires utilisées par le runtime (overlays
// d'erreur, fallback). Pas de style inline — tout passe par des classes pour
// que les apps puissent les overrider via leur propre CSS.
µ._mjs_systemSheet = new CSSStyleSheet();

µ._mjs_systemSheet.replaceSync(`.mjs-fatal-error{color:var(--mjs-error-fg, red);font-weight:bold;padding:10px;border:2px solid var(--mjs-error-border, red)}
.mjs-error{color:var(--mjs-error-fg, red)}`);

document.adoptedStyleSheets = [...document.adoptedStyleSheets, µ._mjs_systemSheet];

// Thème clair/sombre embarqué (`µ._mjs_themeSheet`/`µ._mjs_themeAppSheet`/`µ._themeAdopt`, 8 variables
// --mjs-surface/fg/fg-muted/border/hover/selected/accent/shadow + thèmes d'application
// `*.theme.mjs`) vit dans src/runtime/mjs_theme.ts, DÉTECTÉ — plus rattaché d'office au cœur.

// `µ._mjs_routeErrorCss` (panneau « route introuvable ») vit désormais dans
// src/runtime/mjs_page_cache.ts, avec le reste du cache de pages routeur/UJS.

// Stub : `metamjs-view` est un tag interne émis par le compilateur pour
// matérialiser la directive <@view>. Il contient un tiret → il est traité
// comme custom element par le DOM, donc piégé en permanence par le shield
// `:not(:defined)` s'il n'est pas enregistré. On le déclare en no-op.
MetaViewStub = class MetaViewStub extends HTMLElement {};

if (!customElements.get('metamjs-view')) {
  customElements.define('metamjs-view', MetaViewStub);
}

// SSR — flag d'activation de l'hydratation par adoption. Le serveur l'a posé soit via une
// balise script inline (window.__mjs_ssrHydrate = true) AVANT le bundle, soit — sous `csp:
// true`, un script inline étant bloqué par `script-src` — via l'attribut `data-mjs-ssr-hydrate`
// du nœud racine. Lu ici, au boot, avant tout montage de composant.
// NB : pas de balise script littérale dans ce commentaire — le runtime peut être
// chargé via un script inline, qu'une telle séquence couperait.
try {
  if (typeof globalThis !== 'undefined' && globalThis.__mjs_ssrHydrate) {
    // La valeur est le MODE d'hydratation ('a' | 'b' | 'c'), conservé tel quel
    // pour que _mjs_hydrate dispatche vers la bonne approche.
    µ._mjs_ssrHydrate = globalThis.__mjs_ssrHydrate;
  } else if (typeof document !== 'undefined') {
    const hydrateEl = document.querySelector('[data-mjs-ssr-hydrate]');
    if (hydrateEl) {
      µ._mjs_ssrHydrate = hydrateEl.getAttribute('data-mjs-ssr-hydrate');
    }
  }
} catch (__e2) {
  // no-op
}

// `µ._activeEffectComponent`/
// `µ._activeEffectMask` : reliques V1 (bitmask). Jamais réassignés nulle part
// (seul lu 1 fois, mjs_store.ts, dans une var LOCALE elle-même jamais
// utilisée ensuite) — toujours `null` à vie. Le mécanisme courant est
// `µ.activeComponent` (juste en dessous) + le dispatch direct `_mjs_effectsByVar`
// (V2, sans bitmask). Retirés avec leur site de lecture mort (mjs_store.ts).
// ----------------------------------------------------------------------------
// `µ.activeComponent` — composant en cours d'initialisation/render.
//
// Les runes (`µ.state()`, `µ.store()`, `µ.derived()`...) s'enregistrent sur ce
// composant à la création. Le pattern est partagé par Svelte (`current_component`),
// Vue (`currentInstance`), React (`currentDispatcher`), Solid (`Owner`) — c'est
// LE pattern standard JS pour ce besoin (JS étant single-threaded, c'est safe).
//
// Implémentation en **stack** plutôt que variable flat : si un init imbrique
// un autre init (lazy import, async effect, effets en cascade), `push` empile
// le composant courant et `pop` restaure l'ancien. Une variable flat perdrait
// le contexte parent au premier `= null` du finally d'un sous-init.
//
// Exposé en lecture via `µ.activeComponent` (getter) — les anciens lecteurs
// continuent à fonctionner sans modification.
// ----------------------------------------------------------------------------
µ._mjs_initStack = [];

µ._mjs_pushComponent = function(c) {
  µ._mjs_initStack.push(c);
};

µ._mjs_popComponent = function() {
  return µ._mjs_initStack.pop();
};

Object.defineProperty(µ, 'activeComponent', {
  get: function() {
    return µ._mjs_initStack.length > 0 ? µ._mjs_initStack[µ._mjs_initStack.length - 1] : null;
  },
  set: function(c) {
    // Compat backward : un setter `µ.activeComponent = X` continue à marcher.
    // `= null` est interprété comme pop, `= obj` comme push.
    if (c === null || c === void 0) {
      µ._mjs_initStack.pop();
    } else {
      µ._mjs_initStack.push(c);
    }
  },
  configurable: true,
});

// ----------------------------------------------------------------------------
// Tag sets — remplacent les anciens `Object.defineProperty(obj, '_mjs_X', ...)`.
// Pourquoi : un `defineProperty(obj, 'string', ...)` définit une prop par
// STRING littérale qui ne participe pas au mangle de propriétés esbuild. En
// prod, les lecteurs dotted `obj._mjs_X` sont manglés vers `obj.a` mais la
// prop reste sous le nom `_mjs_X` → la prop déclarée et la prop lue divergent
// → tag perdu, fonctionnalité cassée.
//
// Solution : WeakSet global. La présence dans le set est l'équivalent d'un
// flag booléen, sans pollution `enumerable: true` sur l'objet et sans
// dépendance au mangle. WeakSet ne retient pas les objets contre le GC.
//
//   µ._mjs_rawSet.add(obj)         → équivaut à obj._mjs_raw = true
//   µ._mjs_rawSet.has(obj)         → équivaut à obj._mjs_raw
//
//   µ._mjs_interpolatorSet.add(this)  → équivaut à this._mjs_is_interpolator = true
//   µ._mjs_interpolatorSet.has(obj)   → équivaut à obj._mjs_is_interpolator
// ----------------------------------------------------------------------------
µ._mjs_rawSet = new WeakSet();

µ._mjs_interpolatorSet = new WeakSet();

// ----------------------------------------------------------------------------
// Logging helpers — `µ.log()`/`µ.warn()`/`µ.error()` remplacent les `console.*`
// dans le runtime, gouvernés par un NIVEAU EFFECTIF, du plus bavard au plus
// muet : 'log' (tout) > 'warn' (avertissements + erreurs) > 'error' (erreurs
// seules) > 'silent' (rien).
//
// Le niveau vient de `µ._logLevel` (chaîne posée par le build, clé `logLevel`
// de mjs.config.json — cf. bundler/config.ts) ; absent, repli 'log' (jamais un
// silence par accident). Défauts du build : dev 'log', prod 'warn'.
//
// `µ.debug = true`, posé à la main dans la console, FORCE 'log' quel que soit
// ce réglage — l'échappatoire de mise au point survit au niveau configuré, EN
// DÉVELOPPEMENT. En build de production, la LECTURE ci-dessous compile en
// `µ.debug` (défini à `false` par le minifieur, cf. bundler/minify.ts) : le
// branchement disparaît à la compilation, l'échappatoire console n'existe
// plus dans ce bundle-là (µ.debug reste assignable, mais plus lu nulle part).
//
// Aux niveaux de PROD stricts ('error'/'silent'), le minifieur retire aussi
// les appels `console.*` correspondants DU BUNDLE (cf. bundler/minify.ts,
// `pure` dépendant du niveau) — cette vérification de niveau reste utile en
// dev/non-minifié, où rien n'est retiré à la compilation.
// ----------------------------------------------------------------------------
µ.debug = false;

var MJS_LOG_LEVEL_RANK = { log: 3, warn: 2, error: 1, silent: 0 };

var mjsLogLevel = function() {
  if (µ.debug) return 'log';
  return µ._logLevel || 'log';
};

µ.log = function(...args) {
  if (MJS_LOG_LEVEL_RANK[mjsLogLevel()] >= MJS_LOG_LEVEL_RANK.log) console.log(...args);
};

µ.warn = function(...args) {
  if (MJS_LOG_LEVEL_RANK[mjsLogLevel()] >= MJS_LOG_LEVEL_RANK.warn) console.warn(...args);
};

µ.error = function(...args) {
  if (MJS_LOG_LEVEL_RANK[mjsLogLevel()] >= MJS_LOG_LEVEL_RANK.error) console.error(...args);
};

// Écriture d'attribut DÉFENSIVE pour les valeurs/clés DYNAMIQUES (binding
// `attr={…}`, spread `{...obj}` dont les clés/valeurs peuvent venir d'un objet
// non fiable réseau/API). Modèle ALLOW-LIST (l'ancienne denylist laissait passer
// `srcdoc` et `data:image/svg+xml`) :
//   - gestionnaires inline `on*` → refus (exécution JS) ;
//   - `srcdoc` (HTML inline d'iframe) → refus EN BLOC : sink HTML, pas une URL —
//     une valeur non fiable y exécute du script (cf. @html pour un opt-in
//     explicite et audité) ;
//   - attributs de type URL → seuls http(s)/mailto/tel passent (+ URL relative,
//     sans schéma). `javascript:`/`vbscript:`/`file:`… refusés PARTOUT ;
//     `data:`/`blob:` refusés sur les contextes EXÉCUTABLES/navigables
//     (iframe|frame|embed[src], object[data], a|area|base[href], action,
//     formaction, ping, codebase) mais TOLÉRÉS sur les contextes MÉDIA
//     (img/vidéo/audio/source/poster/background) où ils sont sûrs et idiomatiques
//     (aperçu base64, object-URL de fichier — un SVG chargé en <img> ne script pas).
// Symétrique du filtre `on*` de syncProps (sens entrant).
µ._mjs_URL_ATTRS = { href: 1, src: 1, 'xlink:href': 1, action: 1, formaction: 1, poster: 1, ping: 1, background: 1 };

// Schémas explicitement AUTORISÉS sur un attribut URL (allow-list). Tout autre
// schéma EXPLICITE (data:/blob:/javascript:/vbscript:/file:…) est filtré ; une URL
// SANS schéma (relative, `/x`, `#x`, `?x`, `//host`) ne matche pas → passe.
// Schémas TOUJOURS dangereux sur un attribut URL (exécution JS ou accès local) →
// refus partout. Denylist ciblée plutôt qu'allow-list étroite : une allow-list
// {http,https,mailto,tel} cassait silencieusement sms:/ftp:/geo:/webcal:/deep-links
// légitimes sans gain sécurité. srcdoc et data:/blob: en contexte
// exécutable restent filtrés séparément ci-dessous.
µ._mjs_DANGER_SCHEMES = { javascript: 1, vbscript: 1, file: 1 };

// Regex hoistées au module (évite recompilation par appel — chemin chaud des
// attributs dynamiques). `_mjs_ctrlCharRe` (flag `g`) sert à `replace` (reset de
// lastIndex garanti) ; `_mjs_schemeRe` (sans `g`) sert à `exec`, toujours depuis 0.
µ._mjs_ctrlCharRe = /[\x00-\x20]+/g;
µ._mjs_schemeRe = /^([a-z][a-z0-9+.\-]*):/;

// Contextes où un schéma data:/blob: devient EXÉCUTABLE ou navigable (le contenu
// est interprété comme document → scripts actifs, ou navigation top-level) — à
// distinguer des contextes MÉDIA (data:/blob: y sont inertes).
µ._mjs_isExecUrlAttr = function(nl, tn) {
  if (nl === 'action' || nl === 'formaction' || nl === 'ping' || nl === 'codebase') { return true; }
  // xlink:href (SVG <a>/<use>/<image>) : navigable/chargeable → traiter comme href.
  if (nl === 'xlink:href') { return true; }
  if (nl === 'src') { return tn === 'IFRAME' || tn === 'FRAME' || tn === 'EMBED' || tn === 'SCRIPT'; }
  if (nl === 'data') { return tn === 'OBJECT'; }
  if (nl === 'href') { return tn === 'A' || tn === 'AREA' || tn === 'BASE' || tn === 'SCRIPT'; }
  return false;
};

µ._mjs_safeAttr = function(node, name, value) {
  var nl = ('' + name).toLowerCase();
  // 1. Gestionnaire d'événement inline → refus INCONDITIONNEL de tout `on[a-z]…`.
  //    On NE teste PLUS `nl in HTMLElement.prototype` : les WindowEventHandlers
  //    (onbeforeunload/onmessage/onpopstate/onhashchange/onstorage/onunload…) n'y
  //    figurent pas mais restent des handlers actifs sur <body>/<frameset>.
  if (nl.length > 2 && nl.charCodeAt(0) === 111 && nl.charCodeAt(1) === 110) {
    var c3 = nl.charCodeAt(2);
    if (c3 >= 97 && c3 <= 122) { return; }
  }
  // 2. `srcdoc` = HTML inline d'iframe → refus EN BLOC (sink HTML, pas une URL).
  if (nl === 'srcdoc') {
    return;
  }
  // 3. Attribut de type URL → allow-list de schémas. `data`/`codebase` ne sont
  //    des URL que sur <object>/<applet>.
  var tn = ('' + (node.tagName || '')).toUpperCase();
  var isUrlAttr = µ._mjs_URL_ATTRS[nl] === 1;
  if (!isUrlAttr) {
    if (nl === 'data') { isUrlAttr = (tn === 'OBJECT'); }
    else if (nl === 'codebase') { isUrlAttr = (tn === 'OBJECT' || tn === 'APPLET'); }
  }
  if (isUrlAttr) {
    var clean = ('' + value).replace(µ._mjs_ctrlCharRe, '').toLowerCase();
    var m = µ._mjs_schemeRe.exec(clean);
    if (m) {
      var sc = m[1];
      // javascript:/vbscript:/file: → refus partout
      if (µ._mjs_DANGER_SCHEMES[sc] === 1) { return; }
      // data:/blob: → refus seulement sur contexte exécutable/navigable (inertes en média)
      if ((sc === 'data' || sc === 'blob') && µ._mjs_isExecUrlAttr(nl, tn)) { return; }
      // tout autre schéma (http/https/mailto/tel/sms/ftp/geo/webcal/deep-links…) : autorisé
    }
  }
  if (node.getAttribute(name) !== ('' + value)) { node.setAttribute(name, value); }
};

// `µ._mjs_isPageCached`/`µ._mjs_destroyEvictedTree` vivent désormais dans
// src/runtime/mjs_page_cache.ts, avec le reste du cache de pages routeur/UJS.

// ----------------------------------------------------------------------------
// Configuration runtime — surchargable par l'utilisateur via `µ.config.X = ...`
// avant le mount des composants, ou par injection du bundler à terme.
// ----------------------------------------------------------------------------
µ.config = {
  // Taille max du cache LRU des templates HTML parsés. Quand un {if}/{for} se
  // re-ouvre, on évite de re-parser la string HTML via ce cache. Default 1000 —
  // ~quelques MB en mémoire, suffit pour 99% des apps. Pour apps massives avec
  // beaucoup de templates dynamiques (interpolation × N items), monter à 2000+.
  // Référence : Svelte précompile tout, Vue cache par-composant illimité,
  // Lit n'a pas de cap. MJS borne car interpolation produit des strings uniques.
  templateCacheSize: 1000,

  // Branchement de la modale @confirm (mjs_ujs.ts, µ.confirm) : true (défaut) = modale maison
  // µ.modal.fire (mjs_modal.ts) ; false = window.confirm natif. SEULES valeurs supportées :
  // true/false — l'ancien branchement 'sweetalert2' (window.Swal)/classe-objet custom est
  // RETIRÉ (plus de porte de sortie vers un adaptateur externe). µ.confirm réassigné
  // directement par l'application reste le chemin pour du 100% custom, et prime toujours
  // sur cette clé. NB : la CLÉ ABSENTE (µ.config forgé à la main, runtime sans mjs_init)
  // reste traitée en natif par mjs_ujs.ts — ce défaut-ci est celui du µ.config livré.
  confirm: true,

  // Couche sonore (opt-in) des modales et notifications (µ.modal.fire/success/error/info/warn/
  // notify, __modalSound côté mjs_modal.ts) : false (défaut) = silence total ; true = signatures
  // WebAudio embarquées (notes synthétiques courtes, une par type success/error/warning/info/
  // notify — AudioContext créé PARESSEUSEMENT au premier son, puis réutilisé) ; objet
  // `{success:'/x.mp3', ...}` = fichier PAR TYPE (`new Audio(url).play()`), type absent de
  // l'objet → repli sur la signature embarquée. Un `sound` passé à UN APPEL précis
  // (`fire({sound:...})`/`notify(msg,{sound:...})`) prime toujours sur cette clé globale. Toute
  // erreur du chemin son (politique autoplay du navigateur, AudioContext absent) reste MUETTE —
  // jamais une erreur, jamais un warning pour un simple son qui ne joue pas.
  modalSound: false,

  // Plafond des toasts AFFICHÉS simultanément (µ.modal.notify, mjs_modal.ts) — façon « succès
  // Steam » : au-delà, les nouveaux toasts ATTENDENT EN FILE (FIFO) et s'affichent quand une
  // place se libère, ZÉRO éviction (un toast déjà affiché n'est jamais chassé). Défaut 5 ;
  // `false`/`0`/`Infinity` = pas de plafond NUMÉRIQUE — la place réellement disponible à l'écran
  // borne quand même la pile (mjs_modal.ts) : le surplus attend en file. Relu à CHAQUE
  // affichage — un changement à chaud s'applique au prochain toast à afficher, jamais rétroactif
  // sur ceux déjà affichés ou déjà en file.
  notifyMax: 5,

  // Position du conteneur de toasts (µ.modal.notify, mjs_modal.ts) — 8 préréglages ('top-right'
  // défaut, 'top-left', 'bottom-right', 'bottom-left', et leurs variantes 'quarter-*' ancrées à
  // 25% du bord haut/bas plutôt que collées au coin) OU un objet de longueurs CSS parmi
  // `{top, right, bottom, left}` pour un placement libre (posé en custom properties, jamais de
  // style en dur). Valeur inconnue → µ.warn + repli 'top-right'. Comme `notifyMax`, RELUE à
  // CHAQUE affichage réel : un changement à chaud déplace le conteneur COURANT (donc les toasts
  // déjà affichés avec) et s'applique aux suivants.
  notifyPosition: 'top-right',

  // Sens du FLUX des toasts (µ.modal.notify, mjs_modal.ts) — l'ordre d'empilement, à ne pas
  // confondre avec le sens de CROISSANCE de la pile, dicté lui par l'ancrage : 'up' = le nouveau
  // toast arrive AU-DESSUS des précédents, 'down' = en dessous, 'auto' (défaut) = ce que dit le
  // préréglage de position (les ancrages bas empilent vers le haut, les autres vers le bas). Sert
  // surtout au placement libre `{top, bottom, …}`, qui n'a pas de préréglage pour le décider.
  // Comme notifyMax et notifyPosition : relu à CHAQUE affichage réel, valeur inconnue → warn + 'auto'.
  notifyFlow: 'auto',

  // Durée de vie par défaut d'un toast en ms (µ.modal.notify, mjs_modal.ts) — `opts.duration` d'un
  // appel précis prime toujours sur cette clé globale ; `0` reste permanent (aucun retrait auto,
  // aucune barre de vie), quelle que soit la source (config ou appel).
  notifyDuration: 4000,

  // Politique du veilleur flash/error (µ._mjs_navFlash, mjs_ujs.ts) sur les sacs de props serveur qui
  // entrent au magasin depuis la navigation (nominal/none/422/1er chargement) : 'popup' (défaut) =
  // µ.modal.notify/µ.modal.error (mjs_modal.ts — repli alert/console si le module 'modal' est absent
  // du build) ; 'console' = console.info/console.error ; fonction `(type, message) => …` (type
  // 'flash'|'error') = affichage 100% custom ; false = veilleur COUPÉ (props.flash/props.error NON
  // consommés, µ.res les porte tels quels). Un attribut `mjs-flash` sur l'élément d'origine (lien/
  // formulaire) prime toujours sur cette clé globale.
  flash: 'popup',

  // Que faire quand AUCUNE route d'AUCUN composant routé ne matche l'URL (cf.
  // mjs_router.ts, `_mjs_checkNoMatch`) : 'error' (défaut) = message console + panneau
  // « Page introuvable » à l'écran ; 'warn' = console seule, vues vides ;
  // 'silent' = trace de debug seulement. Déclarer une route de repli
  // (`'/*': 'not-found-page'`) rend le cas inatteignable — c'est la voie
  // recommandée pour servir sa propre page 404.
  routeNotFound: 'error',

  // Directive @title (bulle d'infobulle universelle sur n'importe quelle balise, cf.
  // mjs_title.ts) : délai d'apparition en ms (annulé si la souris/le focus quitte avant),
  // côté préféré 'top'/'bottom' (bascule automatique si la place manque), durée de transition
  // en ms (posée en variable CSS --mjs-title-dur sur la bulle) et type de transition ('fade' =
  // opacité seule, 'slide' = opacité + léger décalage). `@title="texte"` seul suffit déjà (ces
  // 4 réglages ont leurs propres défauts) — cette clé ne fait qu'ajuster le comportement
  // GLOBAL ; `@title={ delay: …, side: … }` sur un élément précis (mjs-title-conf) prime
  // toujours sur elle. Couleurs/rayon/ombre/décalage restent CSS pur (variables
  // --mjs-title-{bg,fg,radius,pad,shadow,offset}, cf. µ._mjs_titleSheet) — pas de clé JS pour
  // ceux-là, la personnalisation visuelle passe par le SASS du composant.
  title: { delay: 400, side: 'top', dur: 150, transition: 'fade' },

  // Étage CLIENT du journal d'erreurs 3 étages (mjs_journal.ts, module optionnel
  // 'journal') : `false` (défaut) = module INERTE — aucun écouteur posé, rien n'est jamais
  // envoyé, même si le module est bundlé (`runtime: [...,'journal']`/'all'). `true` : écoute
  // error + unhandledrejection + un enrobage de µ.error (le console.error d'origine
  // reste appelé EN PLUS), déduplique par signature, plafonne à 20 envois par session, poste
  // sur `POST /__mjs/errors` (sendBeacon, repli fetch keepalive) — encore FAUT-IL que le
  // serveur accepte ces envois (`journal.client` de mjs.config.json, défaut false lui aussi :
  // les DEUX portes, client ET serveur, doivent être ouvertes). Toute erreur DANS ce veilleur
  // reste muette (jamais de crash en cascade pour un outil de diagnostic).
  journal: false
};

// `µ._mjs_label`/`µ._mjs_labelLang` (libellés du runtime, router/ujs/modal) vivent
// désormais dans src/runtime/mjs_page_cache.ts.

// ----------------------------------------------------------------------------
// V2 rewrite : helpers compile-time pour la suppression du Proxy.
// Le générateur transforme `$.x = y` en `µ._set(this, 'x', y)`. Cette fonction
// délègue à `el._set` qui contient la logique d'assignation + invalidation.
// Idem pour `µ._mjs_setComputed` (computed wrappers détectés par l'analyzer AST).
// ----------------------------------------------------------------------------
µ._set = function(el, k, v) {
  return el._set(k, v);
};

// ----------------------------------------------------------------------------
// Props posées par un parent sur un enfant PAS ENCORE mis à niveau : retenues
// HORS de l'instance, dans un registre indexé par l'élément.
// Un enfant pas encore défini n'a ni `_set` ni `_mjs_var_bits`, et ses noms courts
// de production sont inconnus du parent : une clé venue d'une donnée
// d'exécution (JSON reçu, étalement `{...$data}`) qui tombe sur le nom court
// d'une méthode du prototype la MASQUE sur l'instance — « this.o is not a
// function » à la mise à niveau, composant vide. Le registre garde la valeur
// jusqu'au montage (cf. connectedCallback, mjs_element.ts), qui la verse dans
// l'état par `_set` — le chemin exact d'un enfant déjà défini.
// WeakMap : un enfant dont la balise n'est jamais définie part avec ses
// entrées, sans rien retenir.
// ----------------------------------------------------------------------------
µ._mjs_pending = new WeakMap();

// Clés déjà refusées par un élément tiers (élément → clés), pour ne pas répéter le même
// avertissement à chaque re-rendu du parent.
µ._mjs_ro = new WeakMap();

µ._mjs_pend = function(el, k, v) {
  // `__proto__`/`constructor`/`prototype` : refusées AVANT tout, élément tiers compris — ces
  // noms-là ne s'écrivent sur aucun élément (cohérence avec µ._mjs_guardPath, CWE-1321).
  if (!µ._mjs_safeKey(k)) return;
  // élément TIERS : il porte SES noms, jamais ceux du framework — la prop reste une propriété
  // propre (une bibliothèque tierce la lit à sa mise à niveau), comportement d'avant le registre.
  // Un composant DU PROJET va au registre : le manifeste (`µ.paths`, clé = nom sans le préfixe
  // `mjs-`) le reconnaît, qu'il soit déjà défini ou non — une ligne de `{for}` est peuplée avant
  // son insertion, donc avant la mise à niveau, même quand la balise est définie depuis
  // longtemps. Une balise `mjs-` absente du manifeste est un web component tiers (cas documenté,
  // docs/15). Clé CHERCHÉE EN PROPRE : `µ.paths` est un objet ordinaire, `µ.paths['constructor']`
  // répondait l'héritage d'Object — `<mjs-constructor>` passait pour un composant du projet.
  // Sans manifeste (harnais, rendu serveur), repli : le préfixe, sauf balise déjà
  // définie — un composant du projet, lui, n'arrive jamais ici une fois défini ET mis à niveau.
  var n = el.localName || (el.tagName || '').toLowerCase();
  var duProjet = n.slice(0, 4) === 'mjs-' && (µ.paths ? Object.prototype.hasOwnProperty.call(µ.paths, n.slice(4)) : !customElements.get(n));
  if (!duProjet) {
    // propriété en LECTURE SEULE sur l'élément tiers (une page peut figer `value` par
    // Object.defineProperty) : l'écriture LÈVE en mode strict, et l'exception partirait du rendu
    // du PARENT — frontière d'erreur, hôte vidé. On prévient une fois par élément et par clé,
    // la valeur posée par la page reste.
    try {
      el[k] = v;
    }
    catch (e) {
      var vues = µ._mjs_ro.get(el);
      if (!vues) {
        vues = Object.create(null);
        µ._mjs_ro.set(el, vues);
      }
      if (!vues[k]) {
        vues[k] = true;
        µ.warn(`[ModularJS] <${n}> : propriété « ${k} » en lecture seule, valeur ignorée.`);
      }
    }
    return;
  }
  // propriété propre du même nom : la page (ou un parent d'hier) l'a posée AVANT cette
  // écriture-ci. Le montage verse le registre PUIS les propriétés propres — sans ce retrait,
  // une valeur périmée gagnerait sur la plus récente. Retirée ici, une propriété propre
  // présente à la mise à niveau est forcément postérieure : l'ordre redevient chronologique.
  // Une propriété NATIVE (`id`, `title`, `dir`) vit sur le prototype, jamais sur l'élément :
  // rien à retirer, elle passe par le registre comme les autres.
  // Retrait SEULEMENT si le descripteur l'autorise : `delete` d'une propriété propre non
  // configurable LÈVE en mode strict (une page peut la figer par Object.defineProperty), et
  // l'exception partirait du rendu du PARENT — frontière d'erreur, parent vidé, enfant jamais
  // monté. Figée, elle reste et gagne à la mise à niveau, comme toute propriété propre.
  var d = Object.getOwnPropertyDescriptor(el, k);
  if (d && d.configurable) { delete el[k]; }
  var m = µ._mjs_pending.get(el);
  if (!m) {
    m = Object.create(null);
    µ._mjs_pending.set(el, m);
  }
  m[k] = v;
};

// Path-tracking compile-time avec auto-Proxy fallback.

// Garde anti-pollution de prototype (CWE-1321) : les chemins peuvent contenir
// des segments DYNAMIQUES (`$.x[clé]` → valeur runtime, potentiellement issue
// d'une saisie utilisateur). Aucune clé d'état légitime ne s'appelle
// __proto__/constructor/prototype — on refuse, comme lodash.set post-CVE.
µ._mjs_guardPath = function(path) {
  var i, s;
  for (i = 0; i < path.length; i++) {
    s = path[i];
    if (s === '__proto__' || s === 'constructor' || s === 'prototype') {
      µ.warn(`[ModularJS] chemin d'état refusé (segment « ${s} ») — mutation ignorée.`);
      return false;
    }
  }
  return true;
};

// Variante légère (sans alloc ni warn) pour une clé UNIQUE issue d'une source
// non fiable (delta/presence WebSocket, réhydratation SSR d'un JSON de page).
// Bloque `__proto__`/`constructor`/`prototype` — cohérence avec µ._mjs_guardPath.
µ._mjs_safeKey = function(k) {
  return k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
};

// Clé Symbol d'accès à la cible BRUTE d'un Proxy réactif (cf. get trap de
// _mjs_wrapDeep). Permet à µ._mjs_deepSet/µ._mjs_deepCall de naviguer et muter SANS repasser
// par le set trap — qui notifierait une 2e fois, en plus de la notif explicite.
µ._mjs_RAW = Symbol('mjs_raw');

// RECONNAISSANCE DES ENVELOPPES (mort de la boucle two-way inter-
// composants). `µ._mjs_toRaw` déballe une chaîne de Proxy réactifs (le SIEN comme
// celui d'un AUTRE composant/rune/store — tous répondent à µ._mjs_RAW) jusqu'à la
// cible brute : un filet qui reçoit l'enveloppe d'un pair retrouve ainsi la
// MÊME cible que celle déjà connue de son propre carnet (_mjs_proxyCache indexé
// par target), au lieu d'empiler un Proxy-de-Proxy à chaque frontière — c'est
// cet empilement qui cassait l'identité et faisait repartir le ping-pong.
// Boucle (pas un seul niveau) : une chaîne héritée peut être imbriquée.
µ._mjs_toRaw = function(o) {
  while (o != null && typeof o === 'object' && o[µ._mjs_RAW]) o = o[µ._mjs_RAW];
  return o;
};

// Époque de mutation PAR OBJET BRUT (WeakMap globale, O(1), zéro comparaison
// de contenu). Sert à distinguer un ÉCHO pur (le pair renvoie l'objet qu'on
// vient nous-même de muter, rien de neuf à propager) d'une mutation RÉELLE
// survenue entre-temps côté pair (deux composants frères sur le même objet,
// chaîne A→B→C…) : le CÔTÉ MUTANT bump son époque et la mémorise localement
// (_mjs_bindEpochs) ; un `_set` qui reçoit le MÊME objet brut compare l'époque
// courante à celle mémorisée — égales ⇒ écho, on avale en silence.
µ._mjs_epochs = new WeakMap();
µ._mjs_bumpEpoch = function(raw) {
  const e = (µ._mjs_epochs.get(raw) || 0) + 1;
  µ._mjs_epochs.set(raw, e);
  return e;
};

// Helper snapshot shallow par type (Array/Map/Set/plain object) — clone juste
// le top-level container pour permettre l'affichage du `From` dans µ.inspect.
µ._mjs_snap = function(v) {
  if (v == null) return v;
  if (Array.isArray(v)) return v.slice();
  if (v instanceof Map) return new Map(v);
  if (v instanceof Set) return new Set(v);
  if (typeof v === 'object') return {...v};
  return v;
};

µ._mjs_setComputed = function(el, k, fn) {
  return el._mjs_setComputed(k, fn);
};

// ----------------------------------------------------------------------------
// computeLISIndices — Longest Increasing Subsequence (algo standard, O(n log n)).
//
// Utilisé par `_mjs_reconcileList` pour minimiser les `insertBefore` lors d'un
// reorder de liste keyed. Les items dont l'index est dans la LIS gardent leur
// position naturelle (zéro DOM op) ; les autres sont déplacés.
//
// Entrée : tableau d'index `oldPosArr[i]` = position dans l'ancien ordre, ou
// `-1` pour les nouveaux items. Les `-1` sont ignorés (toujours insérés).
//
// Sortie : Set des indices i dont oldPosArr[i] fait partie de la LIS.
//
// Référence : algorithme classique avec binary search dans tails. Utilisé par
// Svelte 3-5, Vue 3, React Fiber. ~50 LOC.
// ----------------------------------------------------------------------------
µ._mjs_lis = function(arr) {
  const n = arr.length;
  if (n === 0) return new Set();
  // tails[k] = index dans arr de l'item finissant la LIS de longueur (k+1)
  //            avec la plus petite valeur possible.
  const tails = [];
  // parents[i] = prédécesseur de arr[i] dans la LIS qui se termine à i.
  const parents = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (v === -1) continue;  // skip new items
    // Binary search : position où v s'insérerait dans `tails` (par valeur).
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    // Le predecessor est l'item finissant la LIS de longueur lo (= tails[lo-1])
    if (lo > 0) parents[i] = tails[lo - 1];
    tails[lo] = i;
  }
  // Reconstruction de la LIS depuis le dernier index trouvé.
  const result = new Set();
  if (tails.length === 0) return result;
  let curr = tails[tails.length - 1];
  while (curr !== -1) {
    result.add(curr);
    curr = parents[curr];
  }
  return result;
};

// µ._buildTemplate et µ._mjs_tplCache SUPPRIMÉS.
// Le compile-time produit désormais des fonctions __create_X() impératives
// qui construisent le DOM directement via document.createElement, sans passer
// par un template HTML ni par un cloneNode. Le cache de template parsé n'a
// plus de raison d'être (la fn est déjà compilée par V8 après le 1er call).

// `µ.LRUCache` vit désormais dans src/runtime/mjs_page_cache.ts (marqueurs
// `extrait-test LRUCache` déplacés avec elle).

// DocumentFragment réutilisable (pool singleton).
//
// `_mjs_reconcileList` accumule des moves dans un DocumentFragment puis fait UN
// seul `insertBefore(frag, anchor)`. Le browser vide automatiquement le
// fragment après cette insertion (move semantics), donc on peut le réutiliser
// indéfiniment sans le recréer. Gain ~1-3ms cumulé sur reorders fréquents
// (évite alloc + pression GC).
//
// Lazy-initialisé dans le premier _mjs_reconcileList qui en a besoin.
µ._mjs_reusableFragment = null;

// Flag global de détection de cascade.
//
// `_mjs_invalidate` peut prendre un fast-path sync direct si une seule var est
// muée. Ce flag empêche les cascades infinies : si un effect mute une autre
// var pendant son exécution, le 2e `_mjs_invalidate` détecte `_mjs_inEffect === true`
// et bascule en microtask (comportement V1).
µ._mjs_inEffect = false;

// Helper template+cloneNode pour les `__create_X()` sans interpolations.
//
// Stratégie : parse le HTML UNE SEULE FOIS via `<template>.innerHTML` (singleton
// par string), puis renvoie un clone du `template.content` à chaque appel. Le
// fragment cloné est typiquement 3-5× plus rapide à produire qu'une série de
// N `createElement + appendChild` impératifs.
//
// Cache : Map<HtmlString, HTMLTemplateElement> — la clé est l'HTML littéral.
// Très peu de strings distinctes en pratique (1 par template constant),
// pas besoin de LRU.
// Tags SVG-only : hors d'un `<svg>`, le parseur HTML les crée dans le namespace
// HTML (éléments inconnus, invisibles). Un corps de `{for}` (ou tout sous-template)
// fait d'éléments SVG arrive ici SANS son `<svg>` ancêtre → on doit reparser dans
// un `<svg>` temporaire pour récupérer le bon namespace. Liste volontairement
// limitée aux tags NON ambigus (pas `a`/`title`/`script`/`style`, communs aux 2).
µ._mjs_svgTagRe = /^\s*<(?:circle|ellipse|line|path|polygon|polyline|rect|g|text|tspan|textPath|use|defs|symbol|marker|linearGradient|radialGradient|stop|clipPath|mask|pattern|image|foreignObject|filter|fe[A-Z][a-zA-Z]*|view|switch)\b/;

µ._mjs_cloneTpl = function(html) {
  if (µ._mjs_tplCache == null) {
    µ._mjs_tplCache = new Map();
  }
  var tpl = µ._mjs_tplCache.get(html);
  if (!tpl) {
    tpl = document.createElement('template');
    if (µ._mjs_svgTagRe.test(html)) {
      // Parse dans un <svg> jetable pour namespacer les enfants, puis transplante
      // les nœuds SVG (namespace préservé par appendChild) dans le content du
      // template cache. cloneNode(true) conservera le namespace à chaque clone.
      var wrap = document.createElement('template');
      wrap.innerHTML = '<svg>' + html + '</svg>';
      var svg = wrap.content.firstChild;
      while (svg && svg.firstChild) { tpl.content.appendChild(svg.firstChild); }
    } else {
      tpl.innerHTML = html;
    }
    µ._mjs_tplCache.set(html, tpl);
  }
  return tpl.content.cloneNode(true);
};

// ----------------------------------------------------------------------------
// Alias ASCII `mu` — portabilité claviers non-français.
//
// Le caractère `µ` (U+00B5) demande AltGr+M sur clavier français, mais est
// quasi-introuvable sur QWERTY (US/UK/IT/ES/DE-natif). `mu` est le nom
// canonique de cette lettre grecque, deux frappes ASCII pures, sans
// collision avec les conventions internes (`_mjs_X` interne ne ressemble
// pas à `mu`).
//
// Usage utilisateur : `mu.state({...})`, `mu.effect(() => ...)`, `mu.emit('event')`.
// **Limite** : le sucre compile-time `µX → µ.X` (runes `µ$count`, `µemit`,
// etc.) NE marche QUE pour `µ`. L'alias `mu` n'autorise que l'accès dotted.
// ----------------------------------------------------------------------------
const mu = µ;

export {
  µ,
  mu
};
