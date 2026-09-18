// mjs_i18n — µt / µ.i18n : i18n v1 SANS Proxy. Dictionnaires en objets nus,
// fusion root+fragments PAR LANGUE, registre section→composants, notification
// MANUELLE (`comp._mjs_invalidate('_awaits_')`) — pas de Proxy, pas de dispatch
// fin par clé (simplicité assumée pour cette v1). Module OPTIONNEL (`runtime:
// 'i18n'` dans mjs.config.json), CHARGÉ APRÈS mjs_store_globals.ts (ordre
// canonique géré par le bundler) : langue courante = clé store INTERNE
// CACHÉE `__mjsLang` (non-énumérable, `_storeDeclare(keys, hidden)`), lue/
// écrite en app via la rune dédiée `µlang` (µ.store.__mjsLang, sigils.ts) —
// PAS `$$lang` : la langue est de la CONFIG framework, l'espace `$$`
// applicatif n'a plus de clé réservée (cf. docs/29-i18n.md).
//
// BASCULE (swap atomique SANS placeholder intermédiaire) — une fois le
// site affiché dans une langue, une bascule GARDE l'ancienne langue affichée
// jusqu'à l'arrivée COMPLÈTE de la cible (racine embarquée + toutes les
// sections montées), puis bascule d'un coup (UNE seule vague d'invalidation).
// Jamais d'interface mi-fr mi-en, jamais de placeholder pour un composant
// déjà affiché. Cf. `__i18nEffectiveLang`/le watcher `__mjsLang` plus bas.
//
// Contrat build (posé par le bundler, considéré figé ici) :
//   µ._i18nData = { dev, default, placeholder, persist, detect, urlParam, prefix, langs: [...], files: {lang: url} }
// Les DICTIONNAIRES ne sont plus dans le manifeste (servi sur chaque page) : un
// fichier PAR LANGUE (`files[langue]`, module à export par défaut) porte
// `{ root: {…}, sections: {section: nom compact} }`, importé une fois la langue
// DÉCIDÉE puis remis ici par `µ._i18nLang(langue, données)` — même point d'entrée
// pour le rendu serveur, qui sème toutes ses langues sans rien importer.
// L'URL d'un fragment de section se reconstitue `prefix/<langue>/<nom>.json`
// (`__i18nSectionUrl`, formule unique).
// Contrat compilateur : `_mjsThis._mjs_i18n = [section|null, overrideMode|null]`
// sur les composants concernés, `µt('clé')` → `µ.t('section.clé', vars?, mode?)`.
//
// 3 modes de rendu pendant le chargement d'un fragment de section :
//   'auto' (défaut) — '' en prod, '⟦clé⟧' en dev (µ._i18nData.dev)
//   'key'           — '⟦clé⟧' TOUJOURS
//   'wait'          — le PREMIER rendu du composant ATTEND le fragment
//                     (µ.i18n._mjs_i18nMount retourne alors la promesse, que
//                     `µ.i18n._mjs_connect` attend en gelant le composant)
//
// µ._i18nData ABSENT (build sans i18n, test isolé) : on retombe sur un objet
// par défaut inerte (root/sections vides) — MÊME code de résolution, aucune
// branche dupliquée : toute clé rend simplement son placeholder, jamais de
// crash.
// BUG D'INTÉGRATION — objet de fallback GARDÉ EN RÉFÉRENCE (`__i18nInertFallback`) :
// sert à détecter, PLUS TARD (cf. `__i18nBoot` en bas de fichier), si `µ._i18nData`
// a fini par être REMPLACÉ par le manifest (comparaison `!==`, pas juste `!!`
// truthy — un simple flag figé au chargement du module ne suffit pas, cf. plus bas).
var __i18nInertFallback = { dev: false, default: null, placeholder: 'auto', prefix: '', langs: [], files: {} };
var __i18nReal = !!µ._i18nData;
if (!µ._i18nData) {
  µ._i18nData = __i18nInertFallback;
}

// Langues RÉELLEMENT chargées : `{langue: {root: {…}, sections: {section: nom}}}`.
// Peuplé par `µ._i18nLang` — soit depuis le fichier de langue importé par
// `__i18nLoadLang` (navigateur), soit semé en bloc par le rendu serveur avant le
// démarrage. Une langue absente d'ici n'a simplement aucun texte : toute clé
// retombe sur le placeholder ou sur la langue par défaut, jamais d'exception.
if (!µ._i18nLangs) { µ._i18nLangs = {}; }

// Point d'entrée des données d'une langue (fichier de langue, rendu serveur).
// Rejouable : un second appel remplace la table (HMR, test qui ré-évalue).
µ._i18nLang = function(lang, data) {
  if (!lang) { return; }
  µ._i18nLangs[lang] = { root: (data && data.root) || {}, sections: (data && data.sections) || {} };
  __i18nMergeRootIntoExistingDicts();  // dict déjà créé (graine ssr, langue rechargée) : backfill
};

function __i18nRootOf(lang) {
  var e = lang && µ._i18nLangs[lang];
  return e ? e.root : null;
}
function __i18nSectionsOf(lang) {
  var e = lang && µ._i18nLangs[lang];
  return e ? e.sections : null;
}
// URL d'un fragment de section — SEUL endroit qui connaisse la formule (miroir de
// `scanI18n`, bundler/index.ts) : la table ne porte que le nom compact du fragment
// (hash en prod, nom clair en dév), le préfixe est publié une fois au manifeste.
function __i18nSectionUrl(lang, nom) {
  return µ._i18nData.prefix + '/' + lang + '/' + nom + '.json';
}
// Langue SÉLECTIONNABLE ? (`?lang=`, localStorage, navigateur) — `langs` remplace ici
// l'ancien test sur `root` : les dictionnaires ne sont plus là pour répondre.
function __i18nKnownLang(code) {
  var langs = µ._i18nData.langs;
  return !!code && !!langs && langs.indexOf(code) !== -1;
}

// DÉPART DE PAGE — un fetch en vol est annulé par le NAVIGATEUR quand la page
// s'en va (rechargement, lien sortant) : la promesse rejette avec un TypeError
// générique (« Failed to fetch »), rigoureusement indistinguable d'une vraie
// panne réseau. Ce drapeau porte la distinction que l'erreur ne porte pas —
// même parti pris que mjs_ajax.ts, où un abandon VOULU est un chemin
// SILENCIEUX (`options.signal`, l.220). Tant qu'on est SUR la page, un échec
// reste crié : seul le départ fait taire.
var __i18nLeaving = false;
if (!µ._isServer && typeof addEventListener === 'function') {
  addEventListener('pagehide', function() { __i18nLeaving = true; });
}

// Dictionnaires fusionnés PAR LANGUE : `root[lang]` (embarqué au build) +
// fragments de section montés sous leur clé (`d.panier = {…}`), au fil des
// résolutions de `_ensure`. Objets nus, mutés en place, zéro Proxy.
if (!µ._i18nDict) { µ._i18nDict = {}; }
µ._mjs_i18nDictOf = function(lang) {
  var d = µ._i18nDict[lang];
  if (!d) {
    d = {};
    var r = __i18nRootOf(lang);
    if (r) {
      for (var k in r) { if (Object.prototype.hasOwnProperty.call(r, k)) d[k] = r[k]; }
    }
    µ._i18nDict[lang] = d;
  }
  return d;
};

// BUG D'INTÉGRATION (prouvé Chromium sur la page `/` fr) — backfill racine :
// un dict déjà créé par la graine SSR (`#__mjs_i18n`, lue plus bas AU CHARGEMENT du module,
// donc AVANT que le manifest ne pose `µ._i18nData` réel — même ordre que le bug ci-dessus)
// ne reçoit JAMAIS sa racine : `_mjs_i18nDictOf` ne la fusionne qu'À LA CRÉATION du dict, et à cet
// instant `µ._i18nData.root[lang]` est encore `{}` (`__i18nInertFallback`). Rejoué au boot
// (cf. `__i18nBoot`), une fois `µ._i18nData.root` réel — sans écraser une clé DÉJÀ semée
// (`hasOwnProperty` sur `d`, jamais sur `r`) ; idempotent, un second appel ne fusionne plus rien.
function __i18nMergeRootIntoExistingDicts() {
  for (var lang in µ._i18nDict) {
    if (!Object.prototype.hasOwnProperty.call(µ._i18nDict, lang)) continue;
    var d = µ._i18nDict[lang];
    var r = __i18nRootOf(lang);
    if (!r) continue;
    for (var k in r) { if (Object.prototype.hasOwnProperty.call(r, k) && !Object.prototype.hasOwnProperty.call(d, k)) d[k] = r[k]; }
  }
}

// Résolution d'un chemin `a.b.c` dans le dict de LA langue donnée.
// `undefined` si un segment intermédiaire manque (jamais de throw).
function __i18nResolve(lang, cle) {
  var node = µ._mjs_i18nDictOf(lang);
  var parts = cle.split('.');
  for (var i = 0; i < parts.length && node != null; i++) { node = node[parts[i]]; }
  return node;
}

// Mode EFFECTIF d'un module : son override `@i18nPlaceholder`, sinon la clé
// `placeholder` du config, sinon 'auto'. UNE seule définition — le rendu du
// placeholder ET le différé du 1er rendu doivent lire la même chose : tant que
// `_mjs_mountReal` ne consultait que l'override, un config à `"placeholder": "wait"`
// ne différait RIEN (mesuré : flash de ⟦tuto.chap_…⟧ pendant
// ~60 ms), alors que la doc annonce l'inverse.
function __i18nMode(modeOverride) {
  return modeOverride || µ._i18nData.placeholder || 'auto';
}

// Placeholder selon le mode EFFECTIF : 'key' → toujours visible, 'auto'/'wait'
// → visible en dev SEULEMENT (µ._i18nData.dev), silencieux en prod.
function __i18nPlaceholder(cle, modeOverride) {
  if (__i18nMode(modeOverride) === 'key') return '⟦' + cle + '⟧';
  return µ._i18nData.dev ? '⟦' + cle + '⟧' : '';
}

// Langue ACTUELLEMENT AFFICHÉE — distincte de `µ._mjs_storeRaw.__mjsLang`
// pendant une bascule en vol : mise à jour SEULEMENT au swap atomique (jamais
// à la mutation brute de la clé store, cf. le watcher plus bas). Posée au
// boot (`__i18nBoot`).
var __i18nDisplayedLang;

// `µ.i18n._ensure` en vol suite à une bascule NON encore résolue : tant que
// `true`, toute résolution (µ.t/__i18nResolve) reste sur `µ._mjs_i18nPrevLang`
// (l'ancienne langue affichée) — jamais un mélange, jamais un placeholder
// pour un composant déjà rendu. `_i18nSwapGen` : jeton de génération
// incrémenté à CHAQUE bascule (fr→en→fr rapide : seule la dernière gagne, cf.
// le watcher plus bas).
µ._mjs_i18nSwapPending = false;
µ._mjs_i18nPrevLang = null;
var __i18nSwapGen = 0;

// Langue EFFECTIVE pour toute résolution (`µ.t`) : la précédente pendant une
// bascule en vol, sinon celle réellement affichée.
function __i18nEffectiveLang() {
  return µ._mjs_i18nSwapPending ? µ._mjs_i18nPrevLang : __i18nDisplayedLang;
}
// exposée pour µ._mjs_label, mjs_init.ts
µ._mjs_i18nEffectiveLang = __i18nEffectiveLang;

// dictionnaire du PROJET pour les libellés du RUNTIME (mjs_init.ts, µ._mjs_label) :
// clés racine réservées `mjs.<groupe>.<clé>` (`mjs.toast.success`, `mjs.modal.cancel`…), lues AVANT
// la table fr/en de src/runtime-labels.ts — un projet en allemand/espagnol, ou qui veut juste changer
// un mot, les surcharge sans toucher runtime-labels.ts. Langue DEMANDÉE (`µ._mjs_storeRaw.__mjsLang`) EN
// PREMIER — PAS la langue effective (en retard tant qu'un swap est en vol) : un clic « EN » doit
// changer le libellé dans le MÊME TICK, avant même que ce module n'ait fini d'assurer les fragments
// de la langue cible. AUCUN repli inter-langue sur une clé absente
// (contrairement à `µ.t`) : une langue demandée sans surcharge pour CETTE clé précise rend `undefined`
// tel quel — c'est `µ._mjs_label` qui prend alors le relais sur la table du framework (prouvé
// tests/runtime-labels-surcharge-projet.test.ts : une bascule vers l'anglais SANS override anglais ne
// doit surtout pas hériter de l'override français du projet). Jamais de placeholder, jamais de warn,
// jamais de throw — y compris quand `µ._i18nData` est le repli inerte ou quand `µ._mjs_storeRaw` n'existe
// pas (module vault absent du build).
µ._mjs_i18nLookup = function(cle) {
  var lang = (µ._mjs_storeRaw && µ._mjs_storeRaw.__mjsLang) || __i18nEffectiveLang() || µ._i18nData.default;
  if (!lang) { return undefined; }
  var node = __i18nResolve(lang, cle);
  return typeof node === 'string' ? node : undefined;
};

// Pluriel CLDR — cache par langue, repli binaire si absent.
var __i18nPluralRulesCache = {};
function __i18nPluralRulesFor(lang) {
  if (Object.prototype.hasOwnProperty.call(__i18nPluralRulesCache, lang)) { return __i18nPluralRulesCache[lang]; }
  var r = null;
  if (typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function') {
    try { r = new Intl.PluralRules(lang); } catch (e) { r = null; }
  }
  __i18nPluralRulesCache[lang] = r;
  return r;
}

// `µ.t('panier.clé', {n: 3}, 'wait')` — clés DÉJÀ préfixées/résolues par le
// compilateur. Pluriel CLDR (`Intl.PluralRules`) : un nœud
// objet {one, other, …} se départage par `vars.n` selon les catégories
// COMPLÈTES de la langue (`one`/`few`/`many`/`other`, pas SEULEMENT `one` si
// `n === 1`), `other` si `n` absent/non numérique. Repli de langue — clé
// absente dans la langue courante mais présente dans le défaut
// (`µ._i18nData.default`) : la chaîne ET la catégorie de pluriel viennent
// alors de cette langue de RÉSOLUTION (`resolvedLang`), jamais de la langue
// demandée si elles diffèrent. Interpolation `%{var}` (y compris `%{n}`)
// depuis `vars`. Toute résolution qui n'aboutit pas à une chaîne (objet sans
// one/other, undefined) rend le placeholder. Lecture de la langue EFFECTIVE
// (`__i18nEffectiveLang`, jamais la brute pendant une bascule en vol) —
// la réactivité passe par le registre (`_mjs_invalidate`), pas par un abonnement
// store de l'appelant.
// clé `zero` explicite prioritaire à n=0 si présente dans le dictionnaire
µ.t = function(cle, vars, modeOverride) {
  var lang = __i18nEffectiveLang();
  var node = __i18nResolve(lang, cle);
  var resolvedLang = lang;
  var fellBack = false;
  if (node == null && µ._i18nData.default && lang !== µ._i18nData.default) {
    node = __i18nResolve(µ._i18nData.default, cle);
    fellBack = node != null;
    if (fellBack) { resolvedLang = µ._i18nData.default; }
  }
  if (node != null && typeof node === 'object' && !Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, 'other')) {
    var n = vars ? vars.n : undefined;
    var cat = 'other';
    if (typeof n === 'number') {
      var rules = __i18nPluralRulesFor(resolvedLang);
      cat = rules ? rules.select(n) : (n === 1 ? 'one' : 'other');
      if (n === 0 && Object.prototype.hasOwnProperty.call(node, 'zero')) { cat = 'zero'; } // clé zero explicite façon Rails — prioritaire sur la catégorie CLDR à n=0
      if (!Object.prototype.hasOwnProperty.call(node, cat)) { cat = 'other'; }
    }
    node = node[cat];
  }
  if (typeof node !== 'string') { return __i18nPlaceholder(cle, modeOverride); }
  if (fellBack && µ._i18nData.dev) {
    var __k = lang + '|' + cle;
    if (!__i18nFallbackWarned.has(__k)) { __i18nFallbackWarned.add(__k); µ.warn('[ModularJS] i18n : clé « ' + cle + ' » absente en « ' + lang + ' », repli sur « ' + µ._i18nData.default + ' »'); }
  }
  if (vars) {
    node = node.replace(/%\{(\w+)\}/g, function(m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m;
    });
  }
  return node;
};

// Registre section→composants (`Map<section, Set<comp>>`), composants i18n
// SANS distinction de section (notifiés en bloc à chaque bascule de langue —
// leurs clés racine changent immédiatement), et cache-singleton des fragments
// en vol/résolus (`Map<'lang/section', {promise, data}>`) — une SEULE requête
// par (langue, section) même si N modules la demandent.
if (!µ._mjs_i18nSectionComps) { µ._mjs_i18nSectionComps = new Map(); }
if (!µ._mjs_i18nComps) { µ._mjs_i18nComps = new Set(); }
if (!µ._i18nCache) { µ._i18nCache = new Map(); }
// file d'attente des composants montés AVANT que
// `__i18nBoot()` n'ait tourné (cf. `_mjs_i18nMount`/`__i18nBoot` plus bas).
if (!µ._mjs_i18nPendingMounts) { µ._mjs_i18nPendingMounts = new Set(); }

// graine ssr : sème dans la page les sections i18n consultées au rendu (balise `#__mjs_i18n`, même canal que `#__mjs_store`, cf mjs_store_globals.ts)
// relue ici au boot, avant tout montage (aucun composant abonné) : reproduit le chemin de succès du fetch de `_ensure` plus bas (cache + dict), sans notifier
// amorce best-effort : une graine absente ou malformée n'interrompt jamais le boot ; l'élément n'est jamais retiré du dom (inerte une fois lu)
// CORRECTIF — `sections` est désormais indexée PAR LANGUE puis par section
// (`{lang:{section:…}}`) : une section servie en REPLI (langue par défaut, traduction manquante
// dans la langue affichée) sort sous la clé de SA propre langue, pas sous `__i18nSeed.lang` (la
// langue affichée) — sans ce double niveau, `_ensure(defLang, section)` (repli, cf. plus bas) ne
// retrouvait jamais son entrée dans la graine et refetchait ce que le serveur avait déjà résolu.
try {
  if (typeof document !== 'undefined' && document.getElementById) {
    var __i18nSeedEl = document.getElementById('__mjs_i18n');
    if (__i18nSeedEl) {
      var __i18nSeed = JSON.parse(__i18nSeedEl.textContent);
      if (__i18nSeed && typeof __i18nSeed.lang === 'string' && __i18nSeed.sections && typeof __i18nSeed.sections === 'object') {
        for (var __i18nSeedLang in __i18nSeed.sections) {
          if (!Object.prototype.hasOwnProperty.call(__i18nSeed.sections, __i18nSeedLang)) continue;
          var __i18nSeedLangSections = __i18nSeed.sections[__i18nSeedLang];
          if (!__i18nSeedLangSections || typeof __i18nSeedLangSections !== 'object') continue;
          for (var __i18nSeedSection in __i18nSeedLangSections) {
            if (Object.prototype.hasOwnProperty.call(__i18nSeedLangSections, __i18nSeedSection)) {
              var __i18nSeedData = __i18nSeedLangSections[__i18nSeedSection];
              µ._i18nCache.set(__i18nSeedLang + '/' + __i18nSeedSection, { promise: Promise.resolve(__i18nSeedData), data: __i18nSeedData });
              µ._mjs_i18nDictOf(__i18nSeedLang)[__i18nSeedSection] = __i18nSeedData;
            }
          }
        }
      }
    }
  }
} catch (e) { /* graine best-effort */ }

// Zombie silencieux — averti UNE SEULE fois si `µ._i18nData`
// n'est jamais posé pour de vrai (contrat manifest cassé) : `__i18nBoot` ne
// booterait alors JAMAIS, la file `_mjs_i18nPendingMounts` resterait pleine à vie
// sans aucun diagnostic. Vérifié en microtâche DIFFÉRÉE (après le rattrapage
// de `__i18nBoot`, cf. son propre `queueMicrotask` en fin de fichier — enfilé
// AVANT celui-ci, FIFO garanti).
var __i18nZombieWarned = false;
var __i18nZombieCheckScheduled = false;
function __i18nCheckZombie() {
  if (__i18nZombieWarned || µ._mjs_i18nBooted) return;
  // `µ._mjs_i18nBooted` seul ne suffit plus : le démarrage attend désormais le FICHIER de
  // la langue (un aller-retour réseau), et cette vérification tombe, elle, dès la
  // microtâche suivante — elle criait donc au contrat cassé dans le cas NORMAL. Seule
  // l'absence du manifeste lui-même (ce que le message dit) reste un zombie.
  if (µ._i18nData !== __i18nInertFallback) return;
  if (!µ._mjs_i18nPendingMounts || µ._mjs_i18nPendingMounts.size === 0) return;
  __i18nZombieWarned = true;
  µ.warn('[ModularJS] i18n : µ._i18nData jamais reçu, composants i18n en placeholder');
}

// Repli clé manquante (cf. µ.t) — dédup par couple (langue, clé).
var __i18nFallbackWarned = new Set();

µ.i18n = {
  // `_mjs_i18nMount(comp)` : lit `comp._mjs_i18n = [section, override]`. Si le boot
  // (`__i18nBoot`, cf. plus bas) n'a PAS ENCORE tourné, la vraie langue
  // (`µlang`) n'est pas fiable — enregistrer/assurer maintenant fetcherait
  // avec `lang === undefined` (placeholder à vie, 0 fetch,
  // sans que la bascule ultérieure de langue ne rattrape jamais ce composant
  // puisque `_mjs_storeWatch` n'écoute que les CHANGEMENTS futurs). On se contente
  // donc de mettre le composant en FILE : `__i18nBoot()` rejoue `_mjs_mountReal`
  // pour chacun, une fois `µlang` posée pour de vrai. Mode 'wait' avant boot :
  // la promesse retournée est chaînée boot→ensure (résout toujours l'appelant,
  // `_mjs_connect` ci-dessous).
  _mjs_i18nMount: function(comp) {
    var info = comp._mjs_i18n;
    if (!info) return null;
    if (!µ._mjs_i18nBooted) {
      µ._mjs_i18nPendingMounts.add(comp);
      if (!__i18nZombieCheckScheduled) {
        __i18nZombieCheckScheduled = true;
        queueMicrotask(__i18nCheckZombie);
      }
      if (__i18nMode(info[1]) === 'wait') {
        if (!comp._mjs_i18nBootWaitPromise) {
          comp._mjs_i18nBootWaitPromise = new Promise(function(resolve) { comp._mjs_i18nBootWaitResolve = resolve; });
        }
        return comp._mjs_i18nBootWaitPromise;
      }
      return null;
    }
    return µ.i18n._mjs_mountReal(comp);
  },
  // `_mjs_connect(comp)` : appelé par connectedCallback (mjs_element.ts) à CHAQUE connexion d'un
  // composant i18n. `_mjs_i18nMount` enregistre le composant et retourne la promesse du fragment
  // SEULEMENT en mode 'wait' avec fragment pas encore arrivé — signal pour différer le PREMIER
  // rendu, déjà planifié par connectedCallback (`_mjs_invalidate('_awaits_')`) : on annule ce rendu
  // vide programmé (`_mjs_pending_full`/`_mjs_pending`), la résolution du fragment ré-invalidera pour de
  // vrai. Composant déconnecté avant résolution → aucun rendu.
  _mjs_connect: function(comp) {
    var wait = µ.i18n._mjs_i18nMount(comp);
    if (!wait) return;
    comp._mjs_pending_full = false;
    if (comp._mjs_pending) { comp._mjs_pending.clear(); }
    // GEL, et pas seulement annulation du rendu programmé : n'importe quelle
    // écriture d'état survenant avant l'arrivée du fragment repeindrait sinon
    // la page en placeholders (une coquille qui écrit son état quelques
    // millisecondes après son montage faisait clignoter ses clés ⟦…⟧). Cf. la
    // garde `_mjs_i18n_hold` dans `_mjs_invalidate` (mjs_element.ts).
    comp._mjs_i18n_hold = true;
    wait.then(function() {
      comp._mjs_i18n_hold = false;                          // levé AVANT toute sortie : un composant démonté entre-temps ne doit pas rester gelé à vie
      if (!comp._mjs_is_mounted || comp._mjs_dead) return;
      comp._mjs_invalidate('_awaits_');
    });
  },
  // `_mjs_mountReal(comp)` : VRAIE logique de montage (enregistre le composant,
  // déclenche `_ensure` si le fragment (langue courante, section) n'est pas
  // en cache). Retourne la PROMESSE du fragment SEULEMENT en mode 'wait' avec
  // fragment pas encore là (signal de différé pour mjs_element.ts) — `null`
  // sinon. Appelée directement une fois le boot passé, ou rejouée par
  // `__i18nBoot()` pour la file d'attente. La
  // promesse `pending` reçoit systématiquement un `.catch` muet (l'échec est
  // DÉJÀ loggé par `µ.error` dans `_ensure`, jamais d'unhandled rejection ici)
  // ; celle éventuellement RETOURNÉE (mode 'wait') RÉSOUT toujours, même sur
  // échec réseau — le composant se rend avec les placeholders plutôt que de
  // rester blanc à vie. Langue EFFECTIVE : un composant monté PENDANT
  // une bascule en vol rend dans l'ANCIENNE langue (comme tous les autres),
  // puis swap avec eux au swap atomique.
  _mjs_mountReal: function(comp) {
    var info = comp._mjs_i18n;
    var section = info[0], override = info[1];
    µ._mjs_i18nComps.add(comp);
    if (!section) return null;
    var set = µ._mjs_i18nSectionComps.get(section);
    if (!set) { set = new Set(); µ._mjs_i18nSectionComps.set(section, set); }
    set.add(comp);
    var lang = __i18nEffectiveLang();
    var entry = µ._i18nCache.get(lang + '/' + section);
    var pending = entry ? (entry.data == null ? entry.promise : null) : µ.i18n._ensure(lang, section);
    if (pending) { pending.catch(function() {}); }
    if (__i18nMode(override) === 'wait' && pending) {
      return pending.then(function(v) { return v; }, function() { return null; });
    }
    return null;
  },
  // `_mjs_unmount(comp)` : désenregistre partout (registre global + toutes les
  // sections — un composant n'est jamais que dans UNE section, le balayage
  // reste bon marché en v1) — y compris de la file d'attente pré-boot (cas du
  // démontage AVANT que `__i18nBoot()` n'ait rejoué son montage réel).
  _mjs_unmount: function(comp) {
    µ._mjs_i18nComps.delete(comp);
    µ._mjs_i18nSectionComps.forEach(function(set) { set.delete(comp); });
    µ._mjs_i18nPendingMounts.delete(comp);
  },
  // `_ensure(lang, section)` : cache-singleton — déjà résolu ou en vol →
  // MÊME promesse (dédoublonnage), sinon fetch → JSON → monte dans le dict
  // + notifie les composants de la section. SSR / pas de `fetch` global /
  // chemin inconnu : pas de requête (LIMITATION v1 assumée), promesse
  // résolue à `null` SANS mise en cache (un montage suivant côté client
  // retentera). Échec réseau : `µ.error`, entrée RETIRÉE du cache (un
  // prochain montage retente), les composants restent sur placeholder.
  //
  // Repli de section —
  // `sections[lang][section]` absent (langue partiellement traduite OU
  // fragment rejeté par le contrôle d'empreinte, cf. docs §8) : on sert le
  // fragment de `µ._i18nData.default` PLUTÔT que de laisser le composant en
  // placeholder à vie. Délégation vers `_ensure(default, section)` — MÊME
  // cache-singleton que si un composant demandait directement le défaut,
  // donc UN SEUL fetch réseau même si plusieurs langues/composants replient
  // sur la même section. `µ.t` fait déjà le même repli au niveau clé
  // (`µ._i18nData.default`) : une fois le fragment par défaut dans
  // `µ._mjs_i18nDictOf(default)`, `µ.t` le retrouve tout seul — ce qui manquait
  // ici, c'est juste de FETCHER ce fragment et de notifier les composants de
  // `lang` une fois arrivé (sinon 0 fetch, 0 notification, placeholder à vie).
  _ensure: function(lang, section) {
    var key = lang + '/' + section;
    var entry = µ._i18nCache.get(key);
    if (entry) { return entry.promise; }
    // table de CETTE langue (fichier de langue chargé au démarrage) : nom compact du
    // fragment, l'URL se reconstitue ici — un seul endroit, cf. __i18nSectionUrl.
    var sections = __i18nSectionsOf(lang);
    var nom = sections && sections[section];
    var path = nom ? __i18nSectionUrl(lang, nom) : null;
    if (!path) {
      var defLang = µ._i18nData.default;
      var defSections = (defLang && defLang !== lang) ? __i18nSectionsOf(defLang) : null;
      var defPath = defSections && defSections[section];
      if (defPath) {
        var fallbackPromise = µ.i18n._ensure(defLang, section).then(function(json) {
          if (!µ._mjs_i18nSwapPending && lang === __i18nEffectiveLang()) {
            var set = µ._mjs_i18nSectionComps.get(section);
            if (set) { set.forEach(function(c) { c._mjs_invalidate('_awaits_'); }); }
          }
          return json;
        });
        µ._i18nCache.set(key, { promise: fallbackPromise, data: null });
        fallbackPromise.then(function(json) {
          var e = µ._i18nCache.get(key);
          if (e) { e.data = json; }
        }, function() {
          µ._i18nCache.delete(key); // échec déjà loggé par le fetch de `defLang` — un montage suivant retentera
        });
        return fallbackPromise;
      }
    }
    if (!path || µ._isServer || typeof fetch !== 'function') {
      // couple effectif (lang, section) trouvé mais pas de fetch réel (SSR/pas de fetch) : marqué CONSULTÉ pour le prérendu (cf µ._i18nUsed, renderToString.ts/render-browser.ts)
      if (path) {
        µ._i18nUsed = µ._i18nUsed || {}; µ._i18nUsed[lang + '/' + section] = true;
        // lecture disque PARESSEUSE, SSR happy-dom — plus de préchargement de TOUTES
        // les sections avant montage (renderToString.ts) : `µ._i18nLoadSync` (crochet Node posé
        // AVANT l'eval sur CE couple SEULEMENT) lit le fragment sur disque de façon SYNCHRONE
        // (pas de fetch, rien à attendre) — même position en cache/dict que le fetch client
        // ci-dessous, `µ.t` le retrouve dès ce même tick.
        if (µ._isServer && typeof µ._i18nLoadSync === 'function' && !µ._i18nCache.get(key)) {
          var syncData = µ._i18nLoadSync(lang, section);
          if (syncData != null) {
            µ._mjs_i18nDictOf(lang)[section] = syncData;
            µ._i18nCache.set(key, { promise: Promise.resolve(syncData), data: syncData });
            return Promise.resolve(syncData);
          }
        }
      }
      return Promise.resolve(null);
    }
    var promise = fetch(path).then(function(res) {
      if (!res || !res.ok) { throw new Error('i18n : HTTP ' + (res && res.status) + ' sur ' + path); }
      return res.json();
    }).then(function(json) {
      µ._mjs_i18nDictOf(lang)[section] = json;
      var e = µ._i18nCache.get(key);
      if (e) { e.data = json; }
      // swap atomique — PENDANT une bascule en vol, ne PAS notifier ici
      // section par section : le watcher `__mjsLang` (cf. plus bas) invalide
      // TOUS les composants i18n en UNE SEULE vague, une fois TOUTES les
      // sections cibles arrivées (jamais de notification prématurée pendant
      // un swap — un composant monté hors swap, lui, continue d'être notifié
      // normalement, ICI, dès son fragment prêt).
      // GARDE DE PERTINENCE — un fragment peut
      // arriver ICI pour une langue qui n'est PLUS la langue effective : un
      // composant 'wait' monté en `lang` A, dont le fetch traîne, alors
      // qu'une bascule A→B COMPLÈTE entre-temps (elle, notifie déjà tous les
      // composants via la vague atomique ci-dessous) — ce fragment retardataire
      // peuple quand même le dictionnaire/cache (`µ._mjs_i18nDictOf`/`e.data`
      // ci-dessus, TOUJOURS utile pour un futur retour vers `lang`), mais ne
      // doit PLUS rien invalider : les composants affichent déjà `lang`
      // effective (B), une notification ici les ferait juste se re-rendre à
      // l'identique (ils lisent `__i18nEffectiveLang()`, PAS `lang` figé
      // dans cette closure). `!µ._mjs_i18nSwapPending` seul ne suffit plus : au
      // moment de CE `.then`, un swap peut avoir COMPLÈTEMENT abouti (donc
      // retombé à `false`) vers une AUTRE langue que `lang`.
      if (!µ._mjs_i18nSwapPending && lang === __i18nEffectiveLang()) {
        var set = µ._mjs_i18nSectionComps.get(section);
        if (set) { set.forEach(function(c) { c._mjs_invalidate('_awaits_'); }); }
      }
      return json;
    }).catch(function(err) {
      if (!__i18nLeaving) { µ.error('[ModularJS] i18n : échec de chargement de « ' + section + ' » (' + lang + ') — ' + (err && err.message ? err.message : err)); }
      µ._i18nCache.delete(key);
      throw err;
    });
    µ._i18nCache.set(key, { promise: promise, data: null });
    return promise;
  }
};

// Détection/persistance de la langue initiale — trois
// capacités INDÉPENDANTES, désactivées par défaut (`µ._i18nData.urlParam`/
// `.persist`/`.detect`). Priorité au boot : URL (`?lang=`) > localStorage
// (persist) > navigateur (detect) > `default`. `µ._isServer` vérifié EN
// PREMIER (SSR happy-dom peut exposer un faux `location`/`localStorage`/
// `navigator`) ; chaque accès en `try` (URL malformée, quota/sandbox/
// navigation privée : ignoré, jamais un crash de boot).
var __I18N_STORAGE_KEY = '__mjsLang';
// Langue portée par l'URL (`?lang=xx`) si `urlParam` actif ET la valeur connue —
// sinon `null`. Extrait à part car lu à DEUX endroits : la détection initiale
// (page cliente sans hydratation, `__mjsLang` absent) ET l'override du boot SSR
// (la valeur prérendue vaut TOUJOURS le défaut, l'URL doit primer — cf. __i18nBoot).
function __i18nUrlLang() {
  if (!µ._isServer && µ._i18nData.urlParam && typeof location !== 'undefined' && location.search) {
    try {
      var fromUrl = new URLSearchParams(location.search).get('lang');
      if (__i18nKnownLang(fromUrl)) { return fromUrl; }
    } catch (e) { /* URL malformée / API absente : ignoré */ }
  }
  return null;
}
function __i18nDetectInitialLang() {
  // URL `?lang=xx` — PRIORITAIRE : une langue portée par l'URL gagne sur un
  // choix mémorisé/deviné (un lien partagé `?lang=en` s'ouvre en anglais).
  var fromUrl = __i18nUrlLang();
  if (fromUrl) { return fromUrl; }
  if (!µ._isServer && µ._i18nData.persist) {
    // `typeof localStorage` DANS le try : sur une origine opaque
    // (sandbox/file:///data:), l'identifiant lui-même est un ACCESSEUR qui lève
    // (SecurityError), pas seulement `.getItem()` — le garder devant le try (comme
    // avant) laissait le boot i18n crasher tout entier, non rattrapé.
    try {
      if (typeof localStorage !== 'undefined') {
        var saved = localStorage.getItem(__I18N_STORAGE_KEY);
        if (__i18nKnownLang(saved)) { return saved; }
      }
    } catch (e) { /* quota/sandbox/navigation privée/typeof sur origine opaque : ignoré */ }
  }
  if (!µ._isServer && µ._i18nData.detect && typeof navigator !== 'undefined' && navigator.language) {
    var langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language];
    for (var i = 0; i < langs.length; i++) {
      var code = langs[i];
      if (__i18nKnownLang(code)) { return code; }
      var primary = code.split('-')[0];
      if (__i18nKnownLang(primary)) { return primary; }
    }
  }
  return µ._i18nData.default;
}

// Init store + bascule de langue — SEULEMENT si `µ._i18nData` a fini par être
// RÉEL (comparaison de référence contre `__i18nInertFallback`, pas un simple
// flag figé au chargement — cf. le correctif ci-dessous). Idempotent
// (`µ._mjs_i18nBooted`) : rejouer ce fichier (HMR/tests qui ré-évaluent la même
// instance `µ`) n'empile pas un 2e watcher.
//
// BUG D'INTÉGRATION — CORRIGÉ : l'ancien code gardait
// `__i18nReal` figé SYNCHRONE au chargement de CE fichier. Or en usage RÉEL,
// `mjs_i18n.ts` est concaténé dans `mjs_core-*.js`, et le manifest de build
// (`bundle.js`) fait `import { µ } from 'mjs_core-*.js'; µ._i18nData = {...};`
// — l'import ES s'exécute TOUJOURS intégralement AVANT la suite du fichier
// importeur (spec ES modules), donc ce module voit FORCÉMENT `µ._i18nData`
// absent/inerte à SON PROPRE chargement ; la vraie donnée n'arrive qu'une
// ligne plus tard, dans le manifest. Résultat AVANT correctif : `__i18nReal`
// restait `false` à VIE, `µlang` n'était jamais initialisée et la bascule de
// langue n'était jamais câblée, dans TOUT build réel (repro : tests/i18n-
// e2e.test.ts, cas a/c). `__i18nBoot` est rejouable : un essai SYNCHRONE tout
// de suite (couvre le cas où `µ._i18nData` était déjà réel AVANT le chargement
// de ce module — scénario des tests unitaires), puis un `queueMicrotask`
// de rattrapage — s'exécute après la fin du script synchrone courant (import
// + assignation manifest inclus), mais TOUJOURS avant le premier rendu d'un
// composant i18n (son `_mjs_invalidate('_awaits_')` initial est LUI-MÊME
// asynchrone, cf. mjs_element.ts) — SAUF un cas :
// un composant PRÉSENT AU PARSE (markup statique/SSR
// hydraté) subit l'upgrade `customElements` SYNCHRONE pendant l'eval du
// core, donc SON `_mjs_i18nMount` (mjs_element.ts) tourne AVANT même ce
// `queueMicrotask` de rattrapage — cf. `_mjs_i18nMount`/`_mjs_i18nPendingMounts` plus
// haut : ces composants sont mis en FILE plutôt que montés avec une langue
// bidon, et REJOUÉS ci-dessous une fois `µlang` posée pour de vrai.
//
// CASCADE DE MODULES — 2e correctif : le manifest n'importe plus le cœur
// STATIQUEMENT (`import()` dynamique dans un `.then()`, cf. writeManifest,
// bundler/index.ts) — `µ._i18nData = {...};` n'arrive donc plus dans le MÊME
// script SYNCHRONE que le chargement de ce fichier, mais sur un TOUR DE
// MICROTÂCHES ultérieur (celui de la promesse `import()`), APRÈS le seul
// `queueMicrotask(__i18nBoot)` de rattrapage ci-dessous (posé, lui, PENDANT
// l'évaluation synchrone du cœur — donc AVANT). Ce rattrapage tombait alors
// TOUJOURS trop tôt, `µ._mjs_i18nBooted` ne devenait plus jamais vrai (placeholder
// à vie, repro : rendu Chromium réel, tests/render-browser.test.ts, mode
// `@i18nPlaceholder wait`). Fix : `µ._i18nRecheck` (alias de `__i18nBoot`,
// posé plus bas) — le manifest l'appelle EXPLICITEMENT juste après avoir posé
// `µ._i18nData` (même patron que `µ._themeAdopt`, déjà ici pour `µ._themeCss`),
// au lieu de compter sur un timing de microtâche implicite qui ne tient plus.
// CHARGEMENT D'UNE LANGUE — `files[langue]` est un module à export par défaut
// (`{root, sections}`), importé UNE fois par langue (promesse mémoïsée, plusieurs
// demandes simultanées n'en font qu'un). Échec (404, bundle périmé, réseau) : crié
// UNE fois puis langue enregistrée VIDE — le démarrage ne doit jamais rester gelé,
// les clés retombent sur le défaut (µ.t) ou sur le placeholder. `µ._i18nImport`
// permet à un hôte sans ESM (harnais de test) de servir ces fichiers autrement ;
// sinon `import()` natif, comme l'Autoloader pour un composant.
var __i18nLangPromises = {};
function __i18nLangReady(lang) {
  return !!lang && !!µ._i18nLangs[lang];
}
function __i18nLoadLang(lang) {
  if (!lang) { return Promise.resolve(null); }
  if (__i18nLangReady(lang)) { return Promise.resolve(µ._i18nLangs[lang]); }
  if (__i18nLangPromises[lang]) { return __i18nLangPromises[lang]; }
  var url = µ._i18nData.files && µ._i18nData.files[lang];
  var p;
  if (!url) {
    µ._i18nLang(lang, null);
    p = Promise.resolve(µ._i18nLangs[lang]);
  } else {
    var charger = (typeof µ._i18nImport === 'function') ? µ._i18nImport(url) : import(url);
    p = Promise.resolve(charger).then(function(mod) {
      µ._i18nLang(lang, (mod && mod.default) || mod);
      return µ._i18nLangs[lang];
    }, function(err) {
      if (!__i18nLeaving) { µ.error('[ModularJS] i18n : échec de chargement de la langue « ' + lang + ' » (' + url + ') — ' + (err && err.message ? err.message : err)); }
      µ._i18nLang(lang, null); // langue vide : repli sur le défaut, jamais de gel
      return µ._i18nLangs[lang];
    });
  }
  __i18nLangPromises[lang] = p;
  return p;
}

// Langue VOULUE au démarrage : celle du store s'il est déjà hydraté (page prérendue),
// l'URL primant toujours (cf. plus bas) ; sinon la détection complète.
function __i18nWantedLang() {
  if (µ._mjs_storeRaw && µ._mjs_storeRaw.__mjsLang !== undefined) {
    return __i18nUrlLang() || µ._mjs_storeRaw.__mjsLang;
  }
  return __i18nDetectInitialLang();
}

var __i18nBootLoading = false;

function __i18nBoot() {
  if (µ._mjs_i18nBooted) return;
  if (µ._i18nData === __i18nInertFallback) return; // toujours pas de données réelles
  // Langue DÉCIDÉE d'abord, fichiers ENSUITE : la langue affichée et — quand elle
  // diffère — celle par DÉFAUT (porteuse des replis de clé et de section, cf. `µ.t` et
  // `_ensure`). Tant qu'ils ne sont pas là, on ne démarre pas : les composants déjà
  // montés attendent dans `_mjs_i18nPendingMounts` (cf. `_mjs_i18nMount`), rejoués plus bas.
  var lang = __i18nWantedLang();
  var defLang = µ._i18nData.default;
  if (!__i18nLangReady(lang) || (defLang && defLang !== lang && !__i18nLangReady(defLang))) {
    if (!__i18nBootLoading) {
      __i18nBootLoading = true;
      var attentes = [__i18nLoadLang(lang)];
      if (defLang && defLang !== lang) { attentes.push(__i18nLoadLang(defLang)); }
      Promise.all(attentes).then(function() { __i18nBootLoading = false; __i18nBoot(); });
    }
    return;
  }
  µ._mjs_i18nBooted = true;
  __i18nMergeRootIntoExistingDicts(); // racine réelle enfin disponible, backfill des dicts semés trop tôt
  // Clé store CACHÉE (non-énumérable, cf. mjs_store_globals.ts) — déclarée
  // AVANT toute écriture, sinon un `µ._storeSet` implicite la déclarerait
  // ÉNUMÉRABLE (auto-déclaration de `_storeSet` sur clé absente).
  if (µ._mjs_storeRaw && µ._mjs_storeRaw.__mjsLang === undefined) {
    if (typeof µ._storeDeclare === 'function') { µ._storeDeclare(['__mjsLang'], true); }
    if (typeof µ._storeSet === 'function') { µ._storeSet('__mjsLang', lang); }
    else { µ._mjs_storeRaw.__mjsLang = lang; }
  } else if (µ._mjs_storeRaw && µ._mjs_storeRaw.__mjsLang !== undefined) {
    // Page SSR (urlParam) — `mjs_store_globals.ts` a DÉJÀ
    // réhydraté `__mjsLang` depuis `<script id="__mjs_store">`, qui vaut
    // TOUJOURS la langue par défaut (la page prérendue est statique). Sans cet
    // override, la garde `=== undefined` ci-dessus saute et `?lang=` n'est
    // JAMAIS relu : un rechargement de `?lang=en` retomberait en défaut. L'URL
    // doit PRIMER sur la valeur figée du prérendu ; sans `?lang=` valide →
    // `null` → on respecte l'hydratation (aucun changement). Clé déjà déclarée
    // (par l'hydratation) → `_storeSet` se contente de mettre à jour la valeur.
    var __urlLang = __i18nUrlLang();
    if (__urlLang && __urlLang !== µ._mjs_storeRaw.__mjsLang) {
      if (typeof µ._storeSet === 'function') { µ._storeSet('__mjsLang', __urlLang); }
      else { µ._mjs_storeRaw.__mjsLang = __urlLang; }
    }
  }
  __i18nDisplayedLang = µ._mjs_storeRaw ? µ._mjs_storeRaw.__mjsLang : undefined;
  if (typeof µ._mjs_storeWatch === 'function') {
    // Bascule SANS placeholder (swap atomique) — l'ancienne langue reste
    // affichée (`__i18nEffectiveLang`) jusqu'à l'arrivée COMPLÈTE de la
    // cible (racine déjà embarquée, zéro fetch ; sections déjà en cache pour
    // la cible : zéro fetch non plus) puis UNE SEULE vague d'invalidation.
    // Jeton de génération (`__i18nSwapGen`) : une bascule fr→en→fr rapide ne
    // laisse gagner que la DERNIÈRE (les résolutions périmées se taisent à
    // leur retour, `myGen !== __i18nSwapGen`). Échec d'un fetch : REVERT
    // (`µ._storeSet` vers l'ancienne langue, redéclenche ce watcher — cette
    // langue est déjà entièrement en cache, le swap-retour est immédiat) —
    // l'affichage n'a jamais bougé.
    // Pas de garde « prevLang === newLang » ici : le jeton de génération SEUL
    // arbitre — nécessaire pour fr→en→fr rapide (le retour vers `prevLang`
    // pendant que fr→en est encore en vol DOIT annuler ce vol, pas être
    // ignoré comme un no-op, cf. cas (e) des tests). `µ._storeSet` a déjà
    // filtré en amont l'unique vrai no-op (nouvelle valeur === valeur BRUTE
    // actuelle, identique bascule en cours ou non).
    µ._mjs_storeWatch('__mjsLang', function(newLang) {
      var prevLang = µ._mjs_i18nSwapPending ? µ._mjs_i18nPrevLang : __i18nDisplayedLang;
      var myGen = ++__i18nSwapGen;
      µ._mjs_i18nSwapPending = true;
      µ._mjs_i18nPrevLang = prevLang;

      // Sections à assurer : relevées TOUT DE SUITE (liste figée à l'instant de la
      // bascule, comme avant) ; leur chargement, lui, attend le FICHIER de la langue
      // cible — sans sa table, `_ensure` ne saurait même pas quel fragment demander.
      // Langue déjà chargée (retour vers une langue déjà vue) : promesse immédiate,
      // aucun aller-retour réseau.
      var aAssurer = [];
      µ._mjs_i18nSectionComps.forEach(function(set, section) {
        if (set.size > 0) { aAssurer.push(section); }
      });
      var pret = __i18nLoadLang(newLang).then(function() {
        var toEnsure = [];
        for (var i = 0; i < aAssurer.length; i++) {
          var section = aAssurer[i];
          var entry = µ._i18nCache.get(newLang + '/' + section);
          if (!entry || entry.data == null) { toEnsure.push(µ.i18n._ensure(newLang, section)); }
        }
        return Promise.all(toEnsure);
      });

      pret.then(function() {
        if (myGen !== __i18nSwapGen) return; // bascule périmée, une plus récente a pris le relais
        µ._mjs_i18nSwapPending = false;
        µ._mjs_i18nPrevLang = null;
        __i18nDisplayedLang = newLang;
        µ._mjs_i18nComps.forEach(function(comp) { comp._mjs_invalidate('_awaits_'); }); // swap ATOMIQUE
        // Persistance — mémorise la langue CIBLE une fois le swap complet.
        // `typeof localStorage` DANS le try (même motif qu'en tête de fichier,
        // __i18nDetectInitialLang) : sans ça, une origine opaque faisait avorter le reste de
        // ce `.then()` (bloc `?lang=` ci-dessous jamais atteint) en unhandled rejection.
        if (!µ._isServer && µ._i18nData.persist) {
          try {
            if (typeof localStorage !== 'undefined') { localStorage.setItem(__I18N_STORAGE_KEY, newLang); }
          } catch (e) { /* quota/sandbox/typeof sur origine opaque : ignoré */ }
        }
        // URL `?lang=` (urlParam) — reflète la langue CIBLE ;
        // retirée si c'est la langue par défaut (URL canonique propre). Ne touche
        // jamais le DOM (`replaceState`) : compatible SSR render-then-replace.
        if (!µ._isServer && µ._i18nData.urlParam && typeof location !== 'undefined' && typeof history !== 'undefined' && history.replaceState) {
          try {
            var url = new URL(location.href);
            if (newLang === µ._i18nData.default) { url.searchParams.delete('lang'); }
            else { url.searchParams.set('lang', newLang); }
            history.replaceState(history.state, '', url.pathname + url.search + url.hash);
          } catch (e) { /* ignoré */ }
        }
      }, function() {
        if (myGen !== __i18nSwapGen) return; // idem : ne pas écraser une bascule plus récente
        µ._mjs_i18nSwapPending = false;
        µ._mjs_i18nPrevLang = null;
        µ._storeSet('__mjsLang', prevLang); // REVERT — déjà en cache, swap-retour immédiat
      });
    });
  }
  // Rejoue la VRAIE logique de montage pour chaque
  // composant mis en file AVANT ce boot (registre + `_ensure` + notification
  // à l'arrivée, cf. `_mjs_mountReal`). Un composant en mode 'wait' avait reçu une
  // promesse "d'attente de boot" (`_mjs_i18nBootWaitPromise`) : on la résout ICI
  // avec le résultat RÉEL de `_mjs_mountReal` (elle-même sûre).
  if (µ._mjs_i18nPendingMounts.size > 0) {
    var toMount = µ._mjs_i18nPendingMounts;
    µ._mjs_i18nPendingMounts = new Set();
    toMount.forEach(function(comp) {
      var p = µ.i18n._mjs_mountReal(comp);
      var resolve = comp._mjs_i18nBootWaitResolve;
      if (resolve) {
        comp._mjs_i18nBootWaitResolve = null;
        comp._mjs_i18nBootWaitPromise = null;
        if (p) { p.then(resolve, function() { resolve(null); }); } else { resolve(null); }
      } else {
        // 'auto'/'key' — ce composant s'est rendu EN PLACEHOLDER pendant l'attente du
        // fichier de langue (le démarrage n'est plus synchrone) : sans cette
        // réinvalidation, une clé RACINE resterait vide à vie (aucune section à
        // attendre, donc aucune notification à venir de `_ensure`).
        comp._mjs_invalidate('_awaits_');
      }
    });
  }
}
__i18nBoot();
if (!µ._mjs_i18nBooted) { queueMicrotask(__i18nBoot); }
// cascade de modules — cf. le bandeau détaillé au-dessus de `__i18nBoot` : le
// manifest (writeManifest, bundler/index.ts) appelle CE hook explicitement,
// juste après avoir posé `µ._i18nData`, pour un rattrapage qui ne dépend plus
// d'un timing de microtâche implicite. Idempotent (garde `µ._mjs_i18nBooted` en
// tête de `__i18nBoot`) — un appel de trop (double manifest exécuté, HMR) ne
// fait rien de plus qu'un `return` immédiat.
µ._i18nRecheck = __i18nBoot;
