// mjs_runes.coffee
// ==========================================================
// RÉACTIVITÉ UNIVERSELLE (Runes hors-composant)
// ==========================================================
// Clé-sentinelle de STRUCTURE d'un store. Lire les *clés* d'un store (énumération :
// `Object.keys`, `Object.values`, `for…in`, un `{for … in @store}`) ne passe PAS par
// le trap `get` clé-à-clé → sans ceci, aucun abonnement n'était posé sur « l'ensemble
// des clés », donc ajouter/retirer une entrée ne re-rendait jamais la vue (stream /
// présence / rooms morts). L'énumération s'abonne à cette sentinelle (trap `ownKeys`),
// et toute mutation (set/delete) la notifie en plus de la clé touchée.
µ._mjs_STRUCT = µ._mjs_STRUCT || Symbol('mjs:struct');

// Méthodes MUTATRICES des collections natives (Array/Map/Set/Date) — set
// module-level (1 alloc), aligné sur `MJS_STORE_MUTATORS` de mjs_store.ts. Voir
// `_wrap` : appelées via le proxy d'une collection de store, elles notifient les
// abonnés (avant, `_wrap` rendait ces collections BRUTES → `$$todos
// .push()` / `$$m.set()` / `$$s.add()` mutaient en SILENCE, sans re-render).
const MJS_STATE_MUTATORS = new Set(['set', 'add', 'delete', 'clear', 'setTime', 'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds', 'push', 'pop', 'splice', 'shift', 'unshift', 'sort', 'reverse', 'fill', 'copyWithin']);

// CRITIQUE — mutation
// PROFONDE d'un store universel totalement silencieuse : `$$game.score += 10`
// (l'exemple même documenté par mjs_store_globals.ts) lisait `µ.store.game` (le get
// trap racine retournait le sous-objet BRUT, sans wrap récursif), puis mutait
// `.score` sur cet objet ordinaire — AUCUN trap ne voit passer cette écriture,
// donc AUCUNE notification. `µ.Store._mjs_buildProxy` (mjs_store.ts) résout déjà
// ce problème pour les singletons importés (`µ$$x`) en wrappant récursivement
// chaque sous-objet lu, avec un cache d'identité (WeakMap) et un `rootKey`
// qui bubble TOUJOURS la notification vers la clé de PREMIER NIVEAU — même
// stratégie portée ici, sur les primitives `µ._mjs_registerUniversalDep` /
// `µ._mjs_notifyUniversalChange` / `µ._mjs_STRUCT` déjà existantes (pas de nouveau
// mécanisme : la clé mutée profondément notifie comme si c'était la clé
// racine elle-même qui avait changé — cohérent avec µ.Store).
µ.state = function(initialData = {}) {
  var _internal, proxy;
  _internal = typeof initialData === 'object' ? {...initialData} : {
    value: initialData
  };
  const _mjs_proxyCache = new WeakMap();
  // `_wrap` : construit (ou retrouve en cache) le proxy réactif d'un
  // sous-objet. `rootKey` = la clé de PREMIER NIVEAU sous laquelle ce
  // sous-objet a été atteint (null au niveau racine ; hérité tel quel à
  // chaque descente, jamais réécrit — comme `rootKey || prop` de µ.Store).
  const _wrap = (target, rootKey) => {
    if (target === null || typeof target !== 'object') return target;
    // reconnaissance d'enveloppe à l'ENTRÉE, symétrique de _mjs_wrapDeep
    // (mjs_element.ts) et _mjs_buildProxy (mjs_store.ts) : une valeur déjà proxifiée
    // par un autre filet est déballée jusqu'au brut AVANT cache/re-wrap — sans
    // ça, µ.state({list: $items}) posait un Proxy-de-Proxy transitoire.
    target = µ._mjs_toRaw(target);
    // Respecter `µ.raw(obj)` : jamais de proxy ni de notification sur une
    // cible marquée brute — restaure le contrat de µ.raw, aligné sur µ.Store.
    if (µ._mjs_rawSet.has(target)) return target;
    // Promise en vol : jamais proxifiée (le wrap casserait le brand-check `.then`).
    if (target instanceof Promise) return target;
    if (_mjs_proxyCache.has(target)) return _mjs_proxyCache.get(target);
    // Collections natives (Array/Map/Set/Date) : proxy à mutateurs NOTIFIANTS.
    // Avant, `_wrap` les rendait BRUTES → `$$todos.push(x)` /
    // `$$m.set(k,v)` / `$$s.add(x)` mutaient SANS notifier (l'op la plus naturelle
    // du store, muette). Stratégie de `µ.Store._mjs_buildProxy` : on intercepte les
    // méthodes mutatrices pour notifier `rootKey` (+ `µ._mjs_STRUCT` pour les lecteurs
    // d'énumération) ; méthodes non-mutatrices et éléments liés à la cible BRUTE
    // (brand-check Map/Set/Date + identité des éléments préservés).
    // garde proto-pollution PARTAGÉE par `coll`
    // (Array/Map/Set/Date, juste en dessous) et `nested` (objets plats, juste après) : les
    // DEUX proxies de `_wrap` acceptaient `__proto__`/`constructor`/`prototype` en écriture/
    // suppression sans la moindre garde ni avertissement (seul `coll` avait été corrigé,
    // `nested` gardant la MÊME lacune). Même famille de clés que
    // `µ._mjs_guardPath` (mjs_init.ts), `_mjs_wrapDeep` (mjs_element.ts) et `µ.Store` (mjs_store.ts),
    // qui filtrent déjà cette famille. Rend `true` = « clé refusée » (le `set`/`deleteProperty`
    // appelant retourne alors `true` sans jamais notifier — mutation ignorée en silence, pas
    // d'exception levée côté appelant).
    const _guardKey = (key) => {
      if (typeof key !== 'string' || µ._mjs_safeKey(key)) return false;
      µ.warn('[ModularJS] µ.state : clé refusée (« '+ key +' ») — mutation ignorée.');
      return true;
    };
    if (target instanceof Map || target instanceof Set ||
        target instanceof Date || Array.isArray(target)) {
      const coll = new Proxy(target, {
        get: (obj, key) => {
          if (key === µ._mjs_RAW) return obj;
          if (µ._mjs_initStack.length > 0) { µ._mjs_registerUniversalDep(_internal, rootKey); }
          const v = obj[key];
          if (typeof v === 'function') {
            const bound = v.bind(obj);
            if (MJS_STATE_MUTATORS.has(key)) {
              return (...args) => {
                const r = bound(...args);
                // époque de mutation du brut (cf. mjs_element.ts, `_set`/
                // `_mjs_wrapDeep`) : un composant qui a reçu ce tableau/cette
                // collection en liaison two-way doit pouvoir distinguer un écho
                // pur d'une mutation réelle survenue ICI, côté rune.
                µ._mjs_bumpEpoch(obj);
                µ._mjs_notifyUniversalChange(_internal, rootKey);
                µ._mjs_notifyUniversalChange(_internal, µ._mjs_STRUCT);
                return r;
              };
            }
            return bound;
          }
          // un ÉLÉMENT objet d'une collection (`st.list[0]`)
          // restait BRUT (contrairement à `nested` juste en dessous, qui rappelle
          // `_wrap` sur chaque valeur lue) : `st.list[0].x = 999` mutait en silence,
          // aucun proxy interposé. Même enveloppe que `nested`, même `rootKey` — le
          // cache d'identité de `_wrap` (`_mjs_proxyCache`) garantit `st.list[0] ===
          // st.list[0]` ; `_wrap` rend déjà les non-objets tels quels (no-op).
          return _wrap(v, rootKey);
        },
        // écriture DIRECTE (`arr.length=0`, `arr[i]=x`, `map.x=y`) : le
        // trap `get` ci-dessus ne voit passer QUE les méthodes de MJS_STATE_MUTATORS,
        // une affectation nue mutait le brut en silence (aucune notification). Même
        // schéma que le proxy `nested` juste en dessous (rootKey systématique,
        // `µ._mjs_STRUCT` sur ajout de clé/index).
        set: (obj, key, value) => {
          // proto-pollution (CWE-1321) : `arr['__proto__']=…`/
          // `arr['constructor']=…` passaient SANS garde (contrairement à `_mjs_guardPath`/
          // `_mjs_wrapDeep`/`µ.Store`, qui filtrent déjà cette même famille de clés) —
          // remplaçait le PROTOTYPE de l'INSTANCE. Même garde que `nested` juste en dessous —
          // factorisée dans `_guardKey`.
          if (_guardKey(key)) return true;
          value = µ._mjs_toRaw(value);
          if (obj[key] === value) return true;
          const isNew = !(key in obj);
          // `Object.freeze(st.arr)` puis écriture : retourner
          // `true` inconditionnellement ici violait l'invariant Proxy (le moteur exige
          // que le trap `set` rapporte le résultat RÉEL sur une prop non-configurable/
          // non-writable du target) → TypeError « trap returned truish… » non liée à un
          // vrai refus. `Reflect.set` porte ce résultat, et seule une écriture RÉUSSIE
          // notifie.
          const success = Reflect.set(obj, key, value);
          if (success) {
            µ._mjs_bumpEpoch(obj);
            µ._mjs_notifyUniversalChange(_internal, rootKey);
            if (isNew) µ._mjs_notifyUniversalChange(_internal, µ._mjs_STRUCT);
          }
          return success;
        },
        // `delete arr[i]` : même trou que `set` ci-dessus.
        deleteProperty: (obj, key) => {
          // même garde proto-pollution que le `set` ci-dessus (`_guardKey`).
          if (_guardKey(key)) return true;
          const had = key in obj;
          // même invariant Proxy que le `set` ci-dessus
          // (`delete arr.length` sur un Array natif refuse : non-configurable) —
          // résultat RÉEL de `Reflect.deleteProperty`, pas `true` en dur.
          const success = Reflect.deleteProperty(obj, key);
          if (success && had) {
            µ._mjs_bumpEpoch(obj);
            µ._mjs_notifyUniversalChange(_internal, rootKey);
            µ._mjs_notifyUniversalChange(_internal, µ._mjs_STRUCT);
          }
          return success;
        }
      });
      _mjs_proxyCache.set(target, coll);
      return coll;
    }
    const nested = new Proxy(target, {
      get: (obj, key) => {
        if (key === µ._mjs_RAW) return obj;
        if (µ._mjs_initStack.length > 0) {
          µ._mjs_registerUniversalDep(_internal, rootKey);
        }
        const val = obj[key];
        if ((val != null) && val._mjs_c) {
          if (val._mjs_evaluating) {
            µ.warn(`[ModularJS] µ.state : cycle de computed détecté sur « ${String(key)} » — undefined retourné.`);
            return void 0;
          }
          val._mjs_evaluating = true;
          try {
            return val.f.call(nested);
          } finally {
            val._mjs_evaluating = false;
          }
        }
        return _wrap(val, rootKey);
      },
      set: (obj, key, value) => {
        // même garde proto-pollution que `coll` ci-dessus (`_guardKey`) :
        // `st.obj['__proto__']=…`/`st.obj['constructor']=…` passaient SANS garde ni avertissement,
        // remplaçant le PROTOTYPE de l'objet BRUT.
        if (_guardKey(key)) return true;
        // Déballer un éventuel proxy stocké : `store.b = store.a` ne doit
        // pas empiler proxy-sur-proxy (notifs/abonnements dupliqués en profondeur).
        value = µ._mjs_toRaw(value);
        if (obj[key] === value) return true;
        // ne notifier µ._mjs_STRUCT (itérations `{for k in $$obj}`) que sur AJOUT
        // de clé : une simple mutation de valeur ne change pas la structure. Aligne
        // µ.state sur µ.Store → plus de re-rendu structurel superflu.
        const isNew = !(key in obj);
        // `Object.freeze(st.obj)` puis écriture : `true` en dur violait
        // l'invariant Proxy sur une propriété non-configurable/non-writable (même bogue que sur
        // `coll`, symétrique). `Reflect.set` porte le résultat RÉEL, seule une écriture RÉUSSIE notifie.
        const success = Reflect.set(obj, key, value);
        if (success) {
          // époque de mutation du brut `obj` (cf. mjs_element.ts).
          µ._mjs_bumpEpoch(obj);
          µ._mjs_notifyUniversalChange(_internal, rootKey);
          if (isNew) µ._mjs_notifyUniversalChange(_internal, µ._mjs_STRUCT);
        }
        return success;
      },
      deleteProperty: (obj, key) => {
        // même garde proto-pollution que `set` ci-dessus (`_guardKey`).
        if (_guardKey(key)) return true;
        const had = key in obj;
        // même invariant Proxy que `set` ci-dessus : résultat RÉEL de
        // `Reflect.deleteProperty`, pas `true` en dur.
        const success = Reflect.deleteProperty(obj, key);
        if (success && had) {
          µ._mjs_bumpEpoch(obj);
          µ._mjs_notifyUniversalChange(_internal, rootKey);
          µ._mjs_notifyUniversalChange(_internal, µ._mjs_STRUCT);
        }
        return success;
      },
      ownKeys: (obj) => {
        if (µ._mjs_initStack.length > 0) { µ._mjs_registerUniversalDep(_internal, rootKey); }
        return Reflect.ownKeys(obj);
      }
    });
    _mjs_proxyCache.set(target, nested);
    return nested;
  };
  proxy = new Proxy(_internal, {
    get: function(target, key) {
      // Accès à la cible BRUTE — utilisé par l'unwrap du set trap pour
      // ne pas empiler proxy-sur-proxy lors d'une réaffectation entre clés.
      if (key === µ._mjs_RAW) return target;
      // Fast path : skip activeComponent lecture (getter sur stack)
      // si on est hors init. La majorité des reads se font après init.
      // µ._mjs_initStack.length === 0 est O(1), pas de stack traversal.
      // 1. Tracking universel : si un composant lit ce store, on l'enregistre
      // comme dépendant pour déclencher son re-render à la moindre mutation.
      if (µ._mjs_initStack.length > 0) {
        µ._mjs_registerUniversalDep(target, key);
      }
      const val = target[key];
      // 2. Déballage automatique des computed (`_mjs_c`) — même logique que
      // `_mjs_buildProxy` côté composant. C'est ce qui rend possible les
      // auto-derived dans les modules externes (`$.x = $.y * 2` posé par
      // l'analyzer AST).
      if ((val != null) && val._mjs_c) {
        // Garde de cycle (même pattern que `_mjs_setComputed`) : deux computed
        // qui se lisent mutuellement partaient en récursion infinie
        // (RangeError brut, sans indice sur la clé fautive).
        if (val._mjs_evaluating) {
          µ.warn(`[ModularJS] µ.state : cycle de computed détecté sur « ${String(key)} » — undefined retourné.`);
          return void 0;
        }
        val._mjs_evaluating = true;
        try {
          return val.f.call(proxy);
        } finally {
          val._mjs_evaluating = false;
        }
      }
      // Réactivité profonde (fix ci-dessus) : un sous-objet est retourné
      // enveloppé, avec `rootKey = key` (clé de premier niveau) — toute
      // mutation, à quelque profondeur que ce soit sous cette clé, notifie
      // comme si `key` elle-même avait changé.
      return _wrap(val, key);
    },
    set: function(target, key, value) {
      // Déballer un proxy µ.state stocké : `store.b = store.a` doit ranger
      // la cible BRUTE, pas le proxy (sinon re-wrap en chaîne à chaque relecture).
      value = µ._mjs_toRaw(value);
      if (target[key] === value) {
        return true;
      }
      var isNew = !(key in target);
      target[key] = value;
      // époque de mutation du brut (cf. mjs_element.ts, `_set`/`_mjs_wrapDeep`).
      µ._mjs_bumpEpoch(target);
      µ._mjs_notifyUniversalChange(target, key);
      // Un lecteur peut dépendre de la *structure* (énumération via `{for … in @store}`)
      // sans lire cette clé précise. On le réveille aussi : à `isNew` (ajout/reset) ET
      // sur mise à jour de valeur (positions d'un stream qui bougent). No-op s'il n'y a
      // aucun abonné structure — les stores lus par clé fixe (ex. `@sock.state`) ne
      // sont jamais énumérés, donc jamais impactés.
      µ._mjs_notifyUniversalChange(target, µ._mjs_STRUCT);
      return true;
    },
    deleteProperty: function(target, key) {
      // Sans ce trap, `delete monStore.x` retirait bien la clé mais ne notifiait
      // AUCUN lecteur → pas de re-render. On notifie comme le set trap (uniquement
      // si la clé existait, pour ne pas réveiller les composants sur un no-op).
      var had = key in target;
      delete target[key];
      if (had) {
        µ._mjs_bumpEpoch(target);
        µ._mjs_notifyUniversalChange(target, key);
        µ._mjs_notifyUniversalChange(target, µ._mjs_STRUCT);
      }
      return true;
    },
    ownKeys: function(target) {
      // Énumération = dépendance sur l'ENSEMBLE des clés (cf. µ._mjs_STRUCT ci-dessus).
      if (µ._mjs_initStack.length > 0) { µ._mjs_registerUniversalDep(target, µ._mjs_STRUCT); }
      return Reflect.ownKeys(target);
    }
  });
  return proxy;
};

// Stockage des dépendances : WeakMap<TargetObject, { key: Set<Component> }>
µ._mjs_universalDeps = new WeakMap();

µ._mjs_registerUniversalDep = function(target, key) {
  // Skip activeComponent lookup ; check direct sur stack.
  // Évite le getter Proxy push/pop chain.
  const stack = µ._mjs_initStack;
  if (stack.length === 0) return;
  const comp = stack[stack.length - 1];
  // Réduction des allocations : ne re-set le WeakMap entry que si nouveau.
  let deps = µ._mjs_universalDeps.get(target);
  if (!deps) {
    deps = {};
    µ._mjs_universalDeps.set(target, deps);
  }
  if (deps[key] == null) {
    deps[key] = new Set();
  }
  deps[key].add(comp);
  if (comp._mjs_univ_targets == null) {
    comp._mjs_univ_targets = new Set();
  }
  return comp._mjs_univ_targets.add(target);
};

µ._mjs_notifyUniversalChange = function(target, key) {
  // Cache local + early-return + simplify (skip ternary chain Coffee).
  const deps = µ._mjs_universalDeps.get(target);
  if (!deps) return;
  const subs = deps[key];
  if (!subs || subs.size === 0) return;
  // Le signal abstrait '_awaits_' est indispensable.
  // commentaire périmé corrigé :
  // décrivait encore la traduction V1 en bitmask (-1/-1n), retirée depuis.
  // V2 — `_mjs_invalidate` prend directement le NOM de var (ou ce signal abstrait),
  // dispatch direct via `_mjs_effectsByVar`, aucune traduction bitmask nulle part.
  for (const comp of subs) {
    comp._mjs_invalidate('_awaits_');
  }
};

// Nettoyage des dépendances universelles (`µ.state()` partagés).
// Avant le fix : on retirait juste `component` des subscribers, mais on
// laissait les Set vides ET l'entry target dans la WeakMap → si un composant
// se ré-enregistrait, on créait des doublons. Maintenant on nettoie en
// cascade : Set vide → delete entry de deps ; deps {} → delete target de
// `µ._mjs_universalDeps`. La WeakMap se vide proprement.
µ._mjs_cleanupUniversalDeps = function(component) {
  if (!component._mjs_univ_targets) return;
  component._mjs_univ_targets.forEach((target) => {
    var deps, key, subscribers;
    deps = µ._mjs_universalDeps.get(target);
    if (!deps) return;
    for (key in deps) {
      subscribers = deps[key];
      subscribers.delete(component);
      if (subscribers.size === 0) {
        delete deps[key];
      }
    }
    if (Object.keys(deps).length === 0) {
      µ._mjs_universalDeps.delete(target);
    }
  });
};
