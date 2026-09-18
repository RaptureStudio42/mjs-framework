// mjs_store_globals — µ.store : LE store global réactif unique de l'appli,
// accessible partout SANS import. Héberge aussi µ.online/µ.visible/µ.ready
// (état d'environnement réactif, plus bas dans ce fichier). Nom historique
// du fichier : mjs_vault.ts — renommé, le sigil « vault » (`&$`) est mort
// depuis longtemps et ce fichier n'a plus rien d'un vault (cf. RETIRÉ plus bas).
//
// Le sigil `$$x` (cf. lexer + generator) se transforme en `µ.store.x`. Un
// composant qui lit `$$x` dans son template/script reçoit du compilateur la
// liste STATIQUE de ses clés store (`_mjs_storeKeys`, cf. mjs_element.ts) et
// s'abonne PAR CLÉ (`µ._mjs_storeSubscribe`) : il ne se re-rend QUE quand une clé
// qu'il lit vraiment change — dispatch fin, plus de re-render universel.
//
//   $$session.token = "abc"          # écrit, partout
//   $$game.score += 10
//   <p>Score : {$$game.score}</p>    # lu, réactif (abonnement à `game` seul)
//
// STATISATION (remplace l'ancien Proxy `µ.state({})`) :
//   µ._mjs_storeRaw       — valeurs BRUTES, aucune notification (cible de µread/µwrite $$)
//   µ.store           — accesseurs énumérables PAR CLÉ (get déballe les computed, set → µ._storeSet)
//   µ._storeDeclare   — crée les accesseurs manquants (idempotent, appelé par chaque module compilé)
//   µ._storeSet/_mjs_storeDelete       — mutation top-level notifiante (clé + structure '*')
//   µ._mjs_storeDeepSet/_mjs_storeDeepCall/_mjs_storeDeepDelete — mutation profonde (notifie la clé racine seule)
//   µ._mjs_storeSubscribe/_mjs_storeUnsubscribe — abonnement composant par clés (posé au montage, mjs_element.ts)
//   µ._mjs_storeWatch     — abonné générique non-composant (callback), retourne un désabonneur

if (!µ._mjs_storeRaw) { µ._mjs_storeRaw = {}; }
if (!µ.store) { µ.store = {}; }

// Registres d'abonnement : Map<clé (ou '*' = structure), Set<abonné>>. Les
// composants s'abonnent via `_mjs_storeSubscribe` (clés nues connues du
// compilateur) ; `_mjs_storeWatch` sert aux abonnés non-composant (i18n & co).
if (!µ._mjs_storeSubs) { µ._mjs_storeSubs = new Map(); }
if (!µ._mjs_storeWatchers) { µ._mjs_storeWatchers = new Map(); }

// Notifie TOUS les abonnés d'UNE clé : composants (`_mjs_invalidate('$$'+clé)`) et
// watchers génériques (callback reçoit la valeur COURANTE, déballée comme
// `µ.store[clé]`, donc les computed y arrivent résolus).
µ._mjs_storeNotifyKey = function(key) {
  var subs = µ._mjs_storeSubs.get(key);
  if (subs) {
    for (var comp of subs) { comp._mjs_invalidate('$$' + key); }
  }
  var watchers = µ._mjs_storeWatchers.get(key);
  if (watchers && watchers.size > 0) {
    var v = µ.store[key];
    for (var fn of watchers) {
      try { fn(v); } catch (e) { µ.warn('[ModularJS] µ._mjs_storeWatch : callback en erreur.', e); }
    }
  }
};

// Notifie les abonnés STRUCTURE ('*') — énumération du store (`{for k in $$}`).
µ._mjs_storeNotifyStruct = function() {
  var subs = µ._mjs_storeSubs.get('*');
  if (subs) {
    for (var comp of subs) { comp._mjs_invalidate('$$*'); }
  }
};

// `µ._storeDeclare(['session','game'])` : crée les accesseurs manquants sur
// `µ.store` — get déballe les computed (`_mjs_c`, parité mjs_runes.ts
// µ.state), set délègue à `µ._storeSet`. Idempotent : rejouer sur une clé
// déjà déclarée est un no-op (chaque module compilé appelle ceci au chargement).
//
// CORRECTIF — une clé déjà `hasOwnProperty`
// n'est pas FORCÉMENT un accesseur posé par cette fonction : `_mjs_storeDelete`
// fait `delete µ.store[key]`, et une écriture ultérieure directe (ancien code
// émis pour `$$x = v` top-level, avant le correctif path-tracker.ts du même
// jour) recréait alors une propriété PLATE (`value`, pas `get`/`set`) — plus
// aucune notification, et ce skip silencieux la laissait plate pour de bon.
// On distingue donc désormais : descriptor à `get` déjà présent → skip (déjà
// un accesseur, rien à faire) ; descriptor à `value` (plat) → CONVERSION :
// la valeur brute rejoint `µ._mjs_storeRaw`, la propriété est re-définie en
// accesseur. Idempotent (une clé déjà accesseur reste inchangée).
//
// `hidden` (2e argument, optionnel) — clé NON-ÉNUMÉRABLE : accesseur posé
// tel quel (get/set inchangés, réactivité intacte) mais absent de
// `{for k in $$}`/`Object.keys(µ.store)`/spread/`JSON.stringify(µ.store)`.
// Sert à `µlang` (mjs_i18n.ts) — la langue est une clé CACHÉE du store
// ('__mjsLang'), pas une clé applicative : l'espace `$$` énumérable reste
// 100% à l'app, cf. sigils.ts (MU_LANG_BODY) et docs/29-i18n.md.
µ._storeDeclare = function(keys, hidden) {
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    // clé de store __proto__/constructor/prototype :
    // ERREUR CLAIRE plutôt que le skip muet d'avant. Le point de collecte compile-time
    // (storeDeclareKeys, transpiler/index.ts) est un fichier distinct — cette garde RUNTIME, au chargement du module compilé,
    // reste le seul point encore atteignable pour signaler la faute à l'auteur (avant :
    // la clé était ignorée en silence, aucun accesseur créé, un `$$__proto__ = x` ensuite
    // ABSORBÉ sans effet par le setter hérité Object.prototype.__proto__ — rien
    // d'observable pour l'auteur du composant).
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      throw new Error(`[ModularJS] µ.store : clé « ${k} » refusée — elle appartient au prototype JavaScript, choisis un autre nom.`);
    }
    if (Object.prototype.hasOwnProperty.call(µ.store, k)) {
      var existingDesc = Object.getOwnPropertyDescriptor(µ.store, k);
      if (existingDesc && existingDesc.get) continue;
      // Propriété plate : sa valeur devient la valeur brute, l'accesseur la remplace.
      µ._mjs_storeRaw[k] = existingDesc ? existingDesc.value : µ.store[k];
      delete µ.store[k];
    }
    (function(key) {
      Object.defineProperty(µ.store, key, {
        enumerable: !hidden,
        configurable: true,
        get: function() {
          var v = µ._mjs_storeRaw[key];
          if (v != null && v._mjs_c) {
            if (v._mjs_evaluating) {
              µ.warn(`[ModularJS] µ.store : cycle de computed détecté sur « ${key} » — undefined retourné.`);
              return void 0;
            }
            v._mjs_evaluating = true;
            try { return v.f.call(µ.store); }
            finally { v._mjs_evaluating = false; }
          }
          return v;
        },
        set: function(value) { µ._storeSet(key, value); }
      });
    })(k);
  }
};

// `µ._storeSet(key, value)` : écriture top-level notifiante. Garde anti
// prototype-pollution (parité avec l'ancien trap `set` du Proxy) ; skip si
// valeur identique (idem trap Proxy, mjs_runes.ts:351) ; notifie la clé PUIS
// la structure — TOUJOURS, même sur simple mise à jour (parité :356-362 : un
// lecteur d'énumération peut dépendre de valeurs qui bougent, pas seulement
// de l'ajout/retrait de clés) — SAUF clé CACHÉE (`_storeDeclare(keys, true)`,
// cf. plus haut) : son accesseur est non-énumérable, elle n'appartient donc
// jamais à l'énumération que `$$*`/`{for k in $$}` surveille — la notifier
// serait un re-render sans aucun changement observable pour ces lecteurs.
µ._storeSet = function(key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    µ.warn(`[ModularJS] µ.store : clé refusée (« ${key} ») — mutation ignorée.`);
    return;
  }
  if (µ._mjs_storeRaw[key] === value) return;
  µ._mjs_storeRaw[key] = value;
  if (!Object.prototype.hasOwnProperty.call(µ.store, key)) { µ._storeDeclare([key]); }
  µ._mjs_storeNotifyKey(key);
  var desc = Object.getOwnPropertyDescriptor(µ.store, key);
  if (!desc || desc.enumerable) { µ._mjs_storeNotifyStruct(); }
};

// `µ._mjs_storeDelete(key)` : supprime raw + accesseur, notifie clé + structure
// SEULEMENT si la clé existait (parité trap `deleteProperty` de µ.state, mjs_runes.ts).
µ._mjs_storeDelete = function(key) {
  var had = Object.prototype.hasOwnProperty.call(µ._mjs_storeRaw, key);
  delete µ._mjs_storeRaw[key];
  if (Object.prototype.hasOwnProperty.call(µ.store, key)) { delete µ.store[key]; }
  if (had) {
    µ._mjs_storeNotifyKey(key);
    µ._mjs_storeNotifyStruct();
  }
};

// `µ._mjs_storeDeepSet('game', ['score'], v)` : mutation profonde SANS Proxy —
// navigue `µ._mjs_storeRaw[rootKey]` (cible brute) et notifie SEULEMENT la clé
// racine (pas la structure : l'ajout profond ne touche pas les clés
// top-level du store, parité trap imbriqué mjs_runes.ts:282-288).
µ._mjs_storeDeepSet = function(rootKey, path, value) {
  if (!µ._mjs_guardPath([rootKey].concat(path))) return;
  var o = µ._mjs_storeRaw[rootKey];
  if (o == null) return;
  for (var i = 0; i < path.length - 1; i++) { o = o[path[i]]; }
  var last = path[path.length - 1];
  if (o[last] === value) return;
  o[last] = value;
  µ._mjs_storeNotifyKey(rootKey);
};

// `µ._mjs_storeDeepCall('list', ['items'], 'push', [x])` : appelle une méthode
// mutative sur un sous-objet du store et notifie la clé racine. Retourne la
// valeur de retour de la méthode (ex. `.push()` → nouvelle longueur).
µ._mjs_storeDeepCall = function(rootKey, path, methodName, args) {
  if (!µ._mjs_guardPath([rootKey].concat(path))) return void 0;
  var o = µ._mjs_storeRaw[rootKey];
  if (o == null) return void 0;
  for (var i = 0; i < path.length; i++) { o = o[path[i]]; }
  var result = o[methodName].apply(o, args);
  µ._mjs_storeNotifyKey(rootKey);
  return result;
};

// `µ._mjs_storeDeepDelete('obj', ['clé'])` : supprime une sous-propriété et
// notifie la clé racine (pas la structure — même logique que _mjs_storeDeepSet).
µ._mjs_storeDeepDelete = function(rootKey, path) {
  if (!µ._mjs_guardPath([rootKey].concat(path))) return;
  var o = µ._mjs_storeRaw[rootKey];
  if (o == null || path.length === 0) return;
  for (var i = 0; i < path.length - 1; i++) { o = o[path[i]]; }
  delete o[path[path.length - 1]];
  µ._mjs_storeNotifyKey(rootKey);
};

// `µ._mjs_storeSubscribe(comp, ['session','game'])` : abonne un composant à des
// clés NUES ('*' = structure). Posé au montage (mjs_element.ts, en miroir de
// `µ._mjs_registerUniversalDep`) si le compilateur a rempli `_mjs_storeKeys`.
µ._mjs_storeSubscribe = function(comp, keys) {
  if (!keys || keys.length === 0) return;
  if (!comp._mjs_storeSubKeys) { comp._mjs_storeSubKeys = new Set(); }
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var subs = µ._mjs_storeSubs.get(k);
    if (!subs) { subs = new Set(); µ._mjs_storeSubs.set(k, subs); }
    subs.add(comp);
    comp._mjs_storeSubKeys.add(k);
  }
};

// `µ._mjs_storeUnsubscribe(comp)` : retire le composant de TOUTES les clés
// auxquelles il était abonné. Posé au démontage (mjs_element.ts, en miroir de
// `µ._mjs_cleanupUniversalDeps`).
µ._mjs_storeUnsubscribe = function(comp) {
  if (!comp._mjs_storeSubKeys) return;
  comp._mjs_storeSubKeys.forEach(function(k) {
    var subs = µ._mjs_storeSubs.get(k);
    if (subs) {
      subs.delete(comp);
      if (subs.size === 0) { µ._mjs_storeSubs.delete(k); }
    }
  });
  comp._mjs_storeSubKeys.clear();
};

// `µ._mjs_storeWatch('lang', fn)` : abonné générique NON-composant — `fn(newValue)`
// à chaque mutation de `lang` (top-level ou profonde). Retourne un désabonneur.
// Sert au module i18n (`µ._mjs_storeWatch('__mjsLang', fn)`, mjs_i18n.ts) — clé
// CACHÉE (cf. `_storeDeclare(keys, hidden)` plus haut), lue via la rune
// `µlang` côté app.
µ._mjs_storeWatch = function(key, fn) {
  var set = µ._mjs_storeWatchers.get(key);
  if (!set) { set = new Set(); µ._mjs_storeWatchers.set(key, set); }
  set.add(fn);
  return function() {
    var s = µ._mjs_storeWatchers.get(key);
    if (s) {
      s.delete(fn);
      if (s.size === 0) { µ._mjs_storeWatchers.delete(key); }
    }
  };
};

// SSR — réhydratation du store global (`$$` / µ.store). Si le serveur a sérialisé
// l'état global dans une balise script JSON d'id "__mjs_store" (cf. renderToString),
// on le fusionne dans µ.store AU BOOT, avant que les composants ne montent, via
// `µ._storeSet` (garde anti prototype-pollution incluse, plus besoin de la
// dupliquer ici). No-op si la balise est absente ou le JSON invalide.
try {
  if (typeof document !== 'undefined' && document.getElementById) {
    var __mjsStoreEl = document.getElementById('__mjs_store');
    if (__mjsStoreEl && __mjsStoreEl.textContent) {
      var __mjsStore = JSON.parse(__mjsStoreEl.textContent);
      if (__mjsStore && typeof __mjsStore === 'object') {
        for (var __sk in __mjsStore) {
          if (Object.prototype.hasOwnProperty.call(__mjsStore, __sk)) {
            // `__mjsLang` — clé CACHÉE (cf. `_storeDeclare(keys, hidden)`
            // ci-dessus) : la PRÉ-déclarer non-énumérable AVANT `_storeSet`,
            // sinon celui-ci l'auto-déclare ÉNUMÉRABLE faute d'accesseur
            // existant (ligne 132 plus haut) — et `_storeDeclare` skip
            // ensuite silencieusement toute clé déjà accesseur (elle
            // resterait visible pour de bon). Exécuté AVANT que mjs_i18n.ts
            // (chargé après ce module) ne pose son propre watcher : aucun
            // abonné à ce moment, donc aucune bascule déclenchée ici.
            if (__sk === '__mjsLang' && !Object.prototype.hasOwnProperty.call(µ.store, __sk)) {
              µ._storeDeclare(['__mjsLang'], true);
            }
            µ._storeSet(__sk, __mjsStore[__sk]);
          }
        }
      }
    }
  }
} catch (__se) {
  // réhydratation best-effort : ne jamais casser le boot
}

// µtheme (forme courte, sucre compilateur : µtheme → µ.store.__mjsTheme,
// generator/sigils.ts — HORS PÉRIMÈTRE ici, ce fichier ne pose que le runtime) —
// thème clair/sombre du framework, clé CACHÉE `__mjsTheme` du store $$ (même
// mécanique que `__mjsLang` ci-dessus : `_storeDeclare(keys, true)` non-
// énumérable, lue/écrite via l'accesseur `µ.store.__mjsTheme`).
//
// Boot : `document.documentElement.dataset.mjsTheme` déjà 'light'/'dark' (posé
// par la page elle-même, ex. script anti-FOUC du <head>) = source de vérité,
// ADOPTÉE telle quelle, AUCUN suivi OS. Sinon : devine via `matchMedia('(prefers-
// color-scheme: dark)')` (absent/throw → 'light'), écrit l'attribut, et SUIT les
// changements OS (listener `change` du MediaQueryList) tant qu'aucune écriture
// applicative EXTERNE n'a eu lieu — la 1ʳᵉ coupe le suivi pour de bon. SSR/happy-
// dom : tout est gardé (`typeof document`/`matchMedia`), défaut 'light', jamais
// de throw.
//
// VALIDATION + COUPURE DU SUIVI — posées en enrobant `µ._storeSet` lui-même, PAS
// un setter d'accesseur : le compilateur (path-tracker.ts, écriture top-level
// `$$x = v`) réécrit `µtheme = v` en APPEL DIRECT `µ._storeSet('__mjsTheme', v)`,
// court-circuitant tout setter posé sur `µ.store.__mjsTheme` — `_storeSet` est le
// SEUL point de passage commun à TOUTES les écritures (compilées, boot, listener
// OS, et `µ.store.__mjsTheme = v` externe/non compilé via l'accesseur générique de
// `_storeDeclare`, qui délègue déjà à `_storeSet`). L'enrobage ci-dessous capture
// la fonction d'origine, ne se mêle QUE de la clé `__mjsTheme`, délègue tout le
// reste tel quel (signature/`this`/retour préservés). Écritures INTERNES (boot,
// listener OS) posent le drapeau `__mjsThemeInternalWrite` autour de leur appel —
// elles ne coupent jamais leur propre suivi (le drapeau ne dispense pas de la
// validation : une valeur interne invalide resterait un bug runtime, avortée
// pareil). La coupure précède TOUJOURS la délégation : le store court-circuite
// silencieusement une réécriture de la valeur déjà courante (`_mjs_storeRaw[key] ===
// value`), un watcher posé APRÈS coup ne verrait donc jamais passer l'événement
// dans ce cas (ex. `dark` réécrit `dark`).
//
// L'attribut `data-mjs-theme` EST le canal CSS (cf. µ._mjs_themeSheet, mjs_init.ts) :
// toute mise à jour de la clé (boot, OS, écriture app) le répercute via
// `_mjs_storeWatch` — miroir bidirectionnel simple, posé UNE fois pour toutes les
// sources d'écriture plutôt que dupliqué à chaque call-site.
µ._mjs_themeApply = function(value) {
  if (typeof document !== 'undefined' && document.documentElement) { document.documentElement.dataset.mjsTheme = value; }
};
if (µ._mjs_storeRaw && µ._mjs_storeRaw.__mjsTheme === undefined) {
  if (typeof µ._storeDeclare === 'function') { µ._storeDeclare(['__mjsTheme'], true); }
  if (typeof µ._mjs_storeWatch === 'function') { µ._mjs_storeWatch('__mjsTheme', µ._mjs_themeApply); }

  // enrobage `_storeSet` — seul point de vérité (cf. bloc de commentaire ci-dessus).
  // thèmes déclarés par l'app : `µ._themes`, tableau de noms écrit par le build dans le
  // manifeste. Absent/pas un tableau = comportement historique, seuls light/dark passent.
  var __mjsThemeIsKnown = function(value) {
    if (value === 'light' || value === 'dark') { return true; }
    return Array.isArray(µ._themes) && µ._themes.indexOf(value) !== -1;
  };
  var __mjsThemeOsUnwatch     = null;
  var __mjsThemeInternalWrite = false;
  var __mjsThemeOrigStoreSet  = µ._storeSet;
  µ._storeSet = function(key, value) {
    if (key !== '__mjsTheme') { return __mjsThemeOrigStoreSet.apply(this, arguments); }
    if (!__mjsThemeIsKnown(value)) {
      var __mjsThemeConnus = ['light', 'dark'].concat(Array.isArray(µ._themes) ? µ._themes : []);
      µ.warn(`[ModularJS] µtheme : « ${value} » n'est pas un thème déclaré — ignorée. Thèmes connus : ${__mjsThemeConnus.join(', ')}.`);
      return;
    }
    if (!__mjsThemeInternalWrite && __mjsThemeOsUnwatch) { __mjsThemeOsUnwatch(); __mjsThemeOsUnwatch = null; }
    return __mjsThemeOrigStoreSet.apply(this, arguments);
  };

  var __mjsThemeAttr = (typeof document !== 'undefined' && document.documentElement) ? document.documentElement.dataset.mjsTheme : undefined;
  var __mjsThemeFromAttr = __mjsThemeIsKnown(__mjsThemeAttr);
  var __mjsThemeInitial = __mjsThemeFromAttr ? __mjsThemeAttr : 'light';
  if (!__mjsThemeFromAttr) {
    try {
      if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) { __mjsThemeInitial = 'dark'; }
    } catch (__te) { /* matchMedia absent/throw : repli clair */ }
  }
  __mjsThemeInternalWrite = true;
  if (typeof µ._storeSet === 'function') { µ._storeSet('__mjsTheme', __mjsThemeInitial); }
  else { µ._mjs_storeRaw.__mjsTheme = __mjsThemeInitial; µ._mjs_themeApply(__mjsThemeInitial); }
  __mjsThemeInternalWrite = false;

  // suivi OS — seulement si l'attribut n'était PAS déjà posé par la page ; coupé
  // pour de bon à la 1re écriture applicative EXTERNE (enrobage `_storeSet` ci-dessus).
  if (!__mjsThemeFromAttr) {
    try {
      if (typeof matchMedia === 'function') {
        var __mjsThemeMql = matchMedia('(prefers-color-scheme: dark)');
        if (__mjsThemeMql && typeof __mjsThemeMql.addEventListener === 'function') {
          var __mjsThemeOsListener = function(e) {
            __mjsThemeInternalWrite = true;
            µ._storeSet('__mjsTheme', e.matches ? 'dark' : 'light');
            __mjsThemeInternalWrite = false;
          };
          __mjsThemeMql.addEventListener('change', __mjsThemeOsListener);
          __mjsThemeOsUnwatch = function() { __mjsThemeMql.removeEventListener('change', __mjsThemeOsListener); };
        }
      }
    } catch (__me) { /* matchMedia change listener indisponible : pas de suivi OS */ }
  }
}

// (µ.vault RETIRÉ : le « vault » a fusionné dans µ.store ; le sigil `&$` n'existe
//  plus — voir lexer/generator qui émettent une erreur explicite sur `&$`.)

// µ.nav (forme courte : µnav) — état de navigation UJS RÉACTIF, POSÉ par
// mjs_ujs.ts (clic/soumission/popstate refetch/lien mjs-method) : `active`
// bascule à `true` au DÉBUT d'une navigation interceptée (avec `href` la
// destination), retombe à `false`/`null` à la FIN (swap réussi, échec, repli
// natif). Contrairement à µ.server : ICI la valeur CHANGE en cours de vie
// (plusieurs fois par session) — d'où un vrai `µ.state` (comme µ.store, pas le
// couple getter+µ._mjs_env de online/visible/ready ci-dessous) : `{if µnav.active}`
// lu en template s'enregistre comme dépendant universel et se re-rend au
// changement — chaque app affiche ainsi sa PROPRE barre/spinner, en MJS pur.
if (!µ.nav) { µ.nav = µ.state({ active: false, href: null }); }

// µ.res (forme courte : µres) — sac de props RENVOYÉES PAR LE SERVEUR pour la
// page courante (protocole de navigation JSON, cf. mjs_ujs.ts,
// µ._mjs_navApplyJson/µ._mjs_resSet, docs/21-navigation.md « Le protocole serveur »).
// RÉACTIF comme µ.nav juste au-dessus (même primitive µ.state — même filet de
// dépendance universelle que µ.url, mjs_router.ts) : un `{µres.x}` lu en
// template s'abonne et suit chaque navigation. Initialisé VIDE dès le boot —
// AVANT tout montage de composant, donc AVANT toute lecture possible de
// `µres.x` — pour qu'un premier rendu qui la lit avant toute réponse JSON
// obtienne `undefined` proprement, jamais un crash (« cannot read of
// undefined ») : ce fichier est concaténé JUSTE APRÈS mjs_runes.ts (ordre
// CANONICAL, bundler/index.ts resolveRuntimeFiles) où `µ.state` est défini —
// point d'amorçage sûr, symétrique de µ.nav ci-dessus (même garde, même
// fichier). SSR : `µ.state({})` y est inerte (aucune navigation ne s'y
// produit), renderToString n'est pas perturbé.
if (!µ.res) { µ.res = µ.state({}); }

// `µ._mjs_resSet(props)` — remplace le sac `µ.res` par un NOUVEAU jeu de props :
// écriture PAR CLÉ (même canal de notification que `µ.url`, mjs_router.ts
// `_mjs_updateUrlStore` — chaque clé posée notifie SES propres lecteurs) ; les clés
// de l'ANCIEN sac absentes du NOUVEAU sont supprimées (une page qui ne renvoie
// plus une prop ne doit pas la laisser traîner pour la page suivante). Snapshot
// des clés existantes AVANT toute écriture (`Object.keys`, pas un `for…in` en
// direct sur le Proxy) : on évite d'itérer une énumération qu'on est soi-même
// en train de modifier. Lazy-garde : un appel avant boot complet re-déclare
// `µ.res` au besoin plutôt que de planter. Garde anti prototype-pollution
// (miroir exact de `µ._storeSet` plus haut) : `JSON.parse` crée `__proto__`
// comme propriété PROPRE de `props` — sans ce garde, `µ.res[k] = props[k]`
// traverserait le filet de sécurité et écraserait le prototype de `µ.res`.
µ._mjs_resSet = function(props) {
  var i, k, oldKeys;
  if (!µ.res) { µ.res = µ.state({}); }
  props = props || {};
  oldKeys = Object.keys(µ.res);
  for (i = 0; i < oldKeys.length; i++) {
    k = oldKeys[i];
    if (!Object.prototype.hasOwnProperty.call(props, k)) { delete µ.res[k]; }
  }
  for (k in props) {
    if (!Object.prototype.hasOwnProperty.call(props, k)) { continue; }
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      µ.warn(`[ModularJS] µ.res : clé refusée (« ${k} ») — mutation ignorée.`);
      continue;
    }
    µ.res[k] = props[k];
  }
};

// `µ._mjs_resMerge(props)` — FUSION plutôt que remplacement (method:'none' du protocole de
// navigation — « j'ai traité, ne bouge pas », cf. mjs_ujs.ts µ._mjs_navApplyJson) : µres décrit les props
// de la page AFFICHÉE ; une NOUVELLE page remplace le sac ENTIER (µ._mjs_resSet, juste au-dessus — les
// props de la page précédente s'en vont AVEC elle, c'est juste) ; une réponse qui ne change PAS de
// page ne corrige QUE les clés qu'elle envoie — les autres SURVIVENT. Sans cette distinction, un back
// qui répond `props: { favorites_count: 3 }` sur un simple clic de cœur effacerait tout le reste du
// sac (erreurs de validation affichées, pagination en cours…) — la fonctionnalité serait inutilisable.
// Pour EFFACER une valeur sur CE chemin, le back doit l'envoyer EXPLICITEMENT à `null` — l'OMETTRE ne
// l'efface JAMAIS (contrairement à µ._mjs_resSet, qui supprime toute clé absente du nouveau sac). Même
// garde d'amorçage et même garde anti prototype-pollution que µ._mjs_resSet juste au-dessus (dupliquées,
// pas factorisées : deux fonctions courtes, chacune complète seule à se lire).
// >>> extrait-test _mjs_resMerge
µ._mjs_resMerge = function(props) {
  var k;
  if (!µ.res) { µ.res = µ.state({}); }
  props = props || {};
  for (k in props) {
    if (!Object.prototype.hasOwnProperty.call(props, k)) { continue; }
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      µ.warn(`[ModularJS] µ.res : clé refusée (« ${k} ») — mutation ignorée.`);
      continue;
    }
    µ.res[k] = props[k];
  }
};
// <<< extrait-test _mjs_resMerge

// µres PLEIN dès le 1er chargement HTML : si le serveur a sérialisé les props du
// chargeur .server.mjs dans une balise script JSON d'id "__mjs_res" (cf. render-server.ts,
// resScript), on les verse dans µ.res AU BOOT, avant que le moindre composant ne monte — via
// `µ._mjs_resSet` juste au-dessus (garde anti prototype-pollution incluse, pas besoin de la dupliquer
// ici). Même motif que la réhydratation du store plus haut : no-op si la balise est absente ou le
// JSON invalide (best-effort, ne casse jamais le boot), un seul `µ.warn` en cas de JSON illisible.
// Le chemin JSON de la navigation (µ._mjs_navApplyJson, mjs_ujs.ts) reprend la main ensuite — cette
// lecture n'a lieu qu'UNE fois, au chargement de ce module.
// >>> extrait-test boot-res
try {
  if (typeof document !== 'undefined' && document.getElementById) {
    var __mjsResEl = document.getElementById('__mjs_res');
    if (__mjsResEl && __mjsResEl.textContent) {
      var __mjsRes = JSON.parse(__mjsResEl.textContent);
      // veilleur flash/error dès le 1er chargement (pas d'élément d'origine ici, cf.
      // mjs_ujs.ts µ._mjs_navFlash) — garde d'existence : mjs_ujs.ts (module 'ujs') peut être tree-shaké.
      if (__mjsRes && typeof __mjsRes === 'object' && typeof µ._mjs_navFlash === 'function') { µ._mjs_navFlash(__mjsRes, null); }
      if (__mjsRes && typeof __mjsRes === 'object') { µ._mjs_resSet(__mjsRes); }
    }
  }
} catch (__re) {
  µ.warn('[ModularJS] µres : balise __mjs_res illisible au boot, ignorée.', __re);
}
// <<< extrait-test boot-res

// µ.server (forme courte : µserver) — drapeau PUBLIC indiquant le contexte
// d'exécution : true côté SSR, false côté client. Posé par LES DEUX moteurs de
// rendu serveur (renderToString.ts pour happy-dom, render-browser.ts pour le
// navigateur réel) via une SIMPLE assignation `µ.server = true;`, injectée dans
// le script évalué/importé AVANT ce fichier (donc avant la ligne ci-dessous) —
// miroir PUBLIC de l'interne `µ._isServer`, qu'il ne remplace pas (gardes
// runtime existantes inchangées) : les DEUX peuvent diverger (le moteur
// navigateur pose `µ.server = true` mais PAS `µ._isServer`, cf. son en-tête de
// fichier — @mount y tourne pour de vrai, volontairement, alors que la passe
// reste bien un rendu SERVEUR du point de vue de l'app).
//   {if not µserver}…{end}   -- code strictement CLIENT (DOM, localStorage…)
//
// PAS de forme réactive (contrairement à µ.online/µ.visible/µ.ready ci-dessous) :
// l'environnement d'exécution ne CHANGE JAMAIS en cours de vie d'une instance —
// un composant ne bascule pas serveur→client à chaud, il est RE-MONTÉ côté
// client après hydratation (render-then-replace & co) — inutile d'adosser un
// µ.state/getter pour un signal qui ne déclenche jamais de re-render : simple
// propriété, moins cher, tout aussi lisible en template (`{if µserver}`, pure
// substitution textuelle µserver→µ.server, cf. sigils.ts — n'exige AUCUN
// mécanisme réactif pour fonctionner). Lecture seule PAR CONVENTION (comme
// µ._isServer, qu'il miroite) : un getter-only aurait empêché SILENCIEUSEMENT
// (mode non strict de l'éval SSR, cf. renderToString.ts) l'assignation posée
// par les deux moteurs — non enforcé techniquement, à dessein.
if (µ.server === undefined) { µ.server = false; }

// µ.online / µ.visible / µ.ready — état d'environnement RÉACTIF, exposé À PLAT
// sous le namespace framework (pas de `µ.app` fourre-tout, pas de pollution du
// store `$$` du dev). Ils sont adossés à un µ.state caché `µ._mjs_env` : lire
// `µ.online` passe par un getter qui lit `µ._mjs_env.online` (proxy) → dep universel
// enregistré au rendu → re-render au changement. Lecture SEULE côté dev (getters
// sans setter) ; seul le runtime écrit `µ._mjs_env`.
//   µ.online   — le navigateur a du réseau (events online/offline)
//   µ.visible  — l'onglet est au premier plan (visibilitychange)
//   µ.ready    — l'app a fini de charger (window load / readyState complete)
if (typeof window !== 'undefined' && µ.state && !µ._mjs_env) {
  µ._mjs_env = µ.state({
    online:  (typeof navigator !== 'undefined' && 'onLine' in navigator) ? navigator.onLine : true,
    visible: (typeof document !== 'undefined' && 'hidden' in document) ? !document.hidden : true,
    ready:   (typeof document !== 'undefined' && document.readyState === 'complete')
  });
  var __mjsEnvGetter = function(name) {
    // configurable : re-déclaration sans crash (HMR/tests qui ré-évaluent).
    Object.defineProperty(µ, name, { configurable: true, get: function() { return µ._mjs_env[name]; } });
  };
  __mjsEnvGetter('online'); __mjsEnvGetter('visible'); __mjsEnvGetter('ready');
  window.addEventListener('online',  function() { µ._mjs_env.online = true; });
  window.addEventListener('offline', function() { µ._mjs_env.online = false; });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function() { µ._mjs_env.visible = !document.hidden; });
  }
  if (!µ._mjs_env.ready) {
    window.addEventListener('load', function() { µ._mjs_env.ready = true; }, { once: true });
  }
}
