// mjs_store.coffee
// Mutators set static module-level (1 alloc au lieu de N par store).
const MJS_STORE_MUTATORS = new Set(['set', 'add', 'delete', 'clear', 'setTime', 'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds', 'push', 'pop', 'splice', 'shift', 'unshift', 'sort', 'reverse']);

µ.Store = class Store {
  constructor(initialState) {
    // Marqueur "raw" dans µ._mjs_rawSet (cf. mjs_init.ts) — pas de prop string
    // sur l'instance (mangle-safe + sans pollution énumération).
    µ._mjs_rawSet.add(this);
    // `|| {}` : `new µ.Store(null)` crashait sur Object.keys(null).
    this._state = initialState || {};
    this._mjs_subscribers = new Map();
    Object.keys(this._state).forEach((key) => {
      return this._mjs_subscribers.set(key, new Set());
    });
    this._mjs_proxyCache = new WeakMap();
    this.data = this._mjs_buildProxy(this._state, null);
  }

  _mjs_buildProxy(target, rootKey) {
    var isBuiltIn, mutators, proxy;
    // reconnaissance des enveloppes : `target` peut être l'enveloppe
    // d'un composant/rune (cf. µ._mjs_RAW) — déballage AVANT tout, même principe
    // que _mjs_wrapDeep (mjs_element.ts) : le carnet (_mjs_proxyCache) reste stable
    // peu importe le pair qui nous transmet la valeur.
    target = µ._mjs_toRaw(target);
    if (target instanceof Promise || (target != null && µ._mjs_rawSet.has(target))) {
      return target;
    }
    if (this._mjs_proxyCache.has(target)) {
      return this._mjs_proxyCache.get(target);
    }
    isBuiltIn = target instanceof Map || target instanceof Set || target instanceof Date || Array.isArray(target);
    mutators = MJS_STORE_MUTATORS;
    proxy = new Proxy(target, {
      get: (obj, prop, receiver) => {
        var component, originalMethod, val;
        // fast-path symbole EN TÊTE (cf. mjs_runes.ts) : accès à la
        // cible BRUTE pour µ._mjs_toRaw — sans lui, un composant qui reçoit une
        // valeur issue du store ne la reconnaît jamais comme une enveloppe
        // MJS et la ré-enveloppe (Proxy-de-Proxy, identité neuve).
        if (prop === µ._mjs_RAW) return obj;
        if (rootKey === null && typeof prop === 'string' && µ._mjs_safeKey(prop)) {
          component = µ.activeComponent;
          if (component) {
            // abonner MÊME une clé
            // PAS ENCORE écrite (données async) : avant, le get n'abonnait que si
            // `_mjs_subscribers.has(prop)`, donc lire `store.data.x` avant la 1ʳᵉ
            // écriture ne posait AUCUN abonnement et la 1ʳᵉ écriture notifiait un
            // Set neuf VIDE → jamais de re-render. On crée l'entrée à la lecture.
            var _subs = this._mjs_subscribers.get(prop);
            if (!_subs) {
              _subs = new Set();
              this._mjs_subscribers.set(prop, _subs);
            }
            // N'inscrire l'unsubscribe QUE si le composant n'était pas déjà
            // abonné : avant, une closure FRAÎCHE s'accumulait dans
            // `_mjs_store_unsubs` à CHAQUE lecture de la clé (le Set ne déduplique
            // pas des fonctions distinctes) → croissance mémoire par render.
            if (!_subs.has(component)) {
              _subs.add(component);
              if (component._mjs_store_unsubs == null) {
                component._mjs_store_unsubs = new Set();
              }
              component._mjs_store_unsubs.add(() => {
                return _subs.delete(component);
              });
            }
          }
          // V2 — plus de bitmask. Les stores universels notifient déjà
          // leurs subscribers via `_mjs_subscribers.set/has/forEach`. Le
          // tracking runtime via `_activeEffectMask`/`_activeEffectComponent`
          // (retirés de mjs_init.ts,
          // c'étaient des reliques V1 toujours `null`) était redondant. Les
          // effets restent fired par leur subscription dans `_mjs_subscribers`
          // au-dessus. (storeKey + _mjs_var_bits checks aussi supprimés — V2
          // dispatch direct.)
        }
        val = Reflect.get(obj, prop, receiver);
        // AVANT : `!isBuiltIn` bloquait le wrap récursif dès que le CONTENEUR (obj) était lui-même
        // une collection native — `store.data.list[0]` rendait donc l'objet BRUT (aucun proxy
        // interposé), et `store.data.list[0].n = 99` mutait en silence (zéro trap, zéro
        // notification). Même défaut déjà trouvé et corrigé côté µ.state (mjs_runes.ts, `_wrap` :
        // « un ÉLÉMENT objet d'une collection restait BRUT ») mais jamais porté ici — trouvé en
        // revue le 23/09/2026, prouvé par exécution. Le wrap doit s'appliquer à la VALEUR lue,
        // sans condition sur le conteneur qui la porte (isBuiltIn ne sert plus qu'à choisir le
        // traitement des MÉTHODES juste en dessous).
        if (typeof val === 'object' && val !== null) {
          return this._mjs_buildProxy(val, rootKey || prop);
        }
        if (typeof val === 'function') {
          if (isBuiltIn) {
            originalMethod = val.bind(obj);
            if (mutators.has(prop)) {
              return (...args) => {
                var result;
                result = originalMethod(...args);
                // époque de mutation du brut (cf. mjs_element.ts).
                µ._mjs_bumpEpoch(obj);
                this._mjs_notify(rootKey || prop);
                return result;
              };
            }
            // `Map.get(k)` rend la valeur INTERNE brute par un appel natif, HORS du trap `get`
            // ci-dessus (l'accès indexé `arr[i]`, lui, PASSE par ce trap et bénéficie déjà du
            // wrap ci-dessus) : un élément objet stocké dans un Map en ressortait donc TOUJOURS
            // brut, même après le fix de la lecture indexée. Même défaut que list[0] avant fix,
            // prouvé par exécution le 23/09/2026.
            if (prop === 'get' && obj instanceof Map) {
              return (...args) => {
                var r = originalMethod(...args);
                return (typeof r === 'object' && r !== null) ? this._mjs_buildProxy(r, rootKey) : r;
              };
            }
            return originalMethod;
          }
          return val.bind(receiver);
        }
        return val;
      },
      set: (obj, prop, value, receiver) => {
        var success, isNew;
        // parité avec µ._storeSet (mjs_store_globals.ts) : une
        // clé __proto__/constructor/prototype venue d'un `{...$data}` réseau ne doit pas remplacer
        // le PROTOTYPE de l'état.
        if (typeof prop === 'string' && !µ._mjs_safeKey(prop)) { µ.warn('[ModularJS] µ.Store : clé refusée (« ' + prop + ' ») — mutation ignorée.'); return true; }
        if (Reflect.get(obj, prop, receiver) === value) {
          return true;
        }
        // Clé racine AJOUTÉE (nouvelle own-prop) → l'énumération change de forme.
        isNew = rootKey === null && typeof prop === 'string' && !Object.prototype.hasOwnProperty.call(obj, prop);
        success = Reflect.set(obj, prop, value, receiver);
        if (success && !µ._mjs_rawSet.has(obj)) {
          // Clé AJOUTÉE après construction : registre créé à la volée — avant,
          // `store.data.nouvelle = x` n'était JAMAIS réactive (pas de
          // subscribers → lecture non trackée, _mjs_notify muet), sans warning.
          if (rootKey === null && typeof prop === 'string' && !this._mjs_subscribers.has(prop)) {
            this._mjs_subscribers.set(prop, new Set());
          }
          // époque de mutation du brut (cf. mjs_element.ts).
          µ._mjs_bumpEpoch(obj);
          this._mjs_notify(rootKey || prop);
          // énumération RACINE :
          // un lecteur de `{for k in store.data}` / `Object.keys` dépend de la
          // STRUCTURE (ownKeys) sans lire la clé précise. On le réveille à l'AJOUT
          // d'une clé (pas sur simple update d'une clé existante).
          if (isNew) {
            this._mjs_notify(µ._mjs_STRUCT);
          }
        }
        return success;
      },
      // `deleteProperty`/`ownKeys` manquaient :
      // `delete store.data.x` supprimait la clé (Reflect par défaut) sans
      // JAMAIS notifier, et `{for k in store.data}` n'était pas tracké comme
      // dépendant de l'ÉNUMÉRATION (ajout/retrait de clé invisible) —
      // incohérent avec `µ.state` qui a ces deux traps (mjs_runes.ts,
      // `µ._mjs_STRUCT`). Même stratégie ici, adaptée au modèle `_mjs_subscribers`.
      deleteProperty: (obj, prop) => {
        var had, success;
        // symétrique du trap `set` ci-dessus.
        if (typeof prop === 'string' && !µ._mjs_safeKey(prop)) { µ.warn('[ModularJS] µ.Store : clé refusée (« ' + prop + ' ») — mutation ignorée.'); return true; }
        had = Object.prototype.hasOwnProperty.call(obj, prop);
        success = Reflect.deleteProperty(obj, prop);
        if (success && had && !µ._mjs_rawSet.has(obj)) {
          if (rootKey === null && typeof prop === 'string' && !this._mjs_subscribers.has(prop)) {
            this._mjs_subscribers.set(prop, new Set());
          }
          // époque de mutation du brut (cf. mjs_element.ts).
          µ._mjs_bumpEpoch(obj);
          this._mjs_notify(rootKey || prop);
          // Retrait d'une clé racine → réveiller les lecteurs d'énumération.
          if (rootKey === null) {
            this._mjs_notify(µ._mjs_STRUCT);
          }
        }
        return success;
      },
      ownKeys: (obj) => {
        // Énumération d'un sous-objet NICHÉ = dépendance sur la clé racine.
        var component = µ.activeComponent;
        if (rootKey === null) {
          // énumération RACINE
          // (`{for k in store.data}` / `Object.keys(store.data)`) : sans abonnement
          // ici, ajouter/retirer une clé racine ne re-rendait pas. On abonne via la
          // clé-sentinelle structurelle `µ._mjs_STRUCT` (partagée avec µ.state), notifiée
          // par le set (clé neuve) et le delete racine ci-dessus.
          if (component) {
            var _subsS = this._mjs_subscribers.get(µ._mjs_STRUCT);
            if (!_subsS) {
              _subsS = new Set();
              this._mjs_subscribers.set(µ._mjs_STRUCT, _subsS);
            }
            if (!_subsS.has(component)) {
              _subsS.add(component);
              if (component._mjs_store_unsubs == null) component._mjs_store_unsubs = new Set();
              component._mjs_store_unsubs.add(() => _subsS.delete(component));
            }
          }
          return Reflect.ownKeys(obj);
        }
        if (component && this._mjs_subscribers.has(rootKey)) {
          var _subsEnum = this._mjs_subscribers.get(rootKey);
          if (!_subsEnum.has(component)) {
            _subsEnum.add(component);
            if (component._mjs_store_unsubs == null) component._mjs_store_unsubs = new Set();
            component._mjs_store_unsubs.add(() => _subsEnum.delete(component));
          }
        }
        return Reflect.ownKeys(obj);
      },
      // `Object.defineProperty(store.data, '__proto__', …)`
      // contournait le trap `set` ci-dessus (chemin d'écriture DIFFÉRENT du Proxy) : même garde,
      // même message.
      defineProperty: (obj, prop, desc) => {
        if (typeof prop === 'string' && !µ._mjs_safeKey(prop)) { µ.warn('[ModularJS] µ.Store : clé refusée (« ' + prop + ' ») — mutation ignorée.'); return false; }
        return Reflect.defineProperty(obj, prop, desc);
      },
      // `Object.setPrototypeOf(store.data, evil)` changeait
      // le PROTOTYPE en un seul appel, hors de portée du trap `set` (pas une écriture de clé).
      setPrototypeOf: (obj, proto) => {
        µ.warn('[ModularJS] store : changement de prototype refusé');
        return false;
      }
    });
    this._mjs_proxyCache.set(target, proxy);
    return proxy;
  }

  _mjs_notify(rootKey) {
    if (!(rootKey && this._mjs_subscribers.has(rootKey))) {
      return;
    }
    if (this._mjs_pendingNotifs == null) {
      this._mjs_pendingNotifs = new Set();
    }
    this._mjs_pendingNotifs.add(rootKey);
    // Event Debouncing (Coalescence)
    if (!this._mjs_is_notifying) {
      this._mjs_is_notifying = true;
      return queueMicrotask(() => {
        var i, key, len, pending, results;
        this._mjs_is_notifying = false;
        pending = Array.from(this._mjs_pendingNotifs);
        this._mjs_pendingNotifs.clear();
        results = [];
        for (i = 0, len = pending.length; i < len; i++) {
          key = pending[i];
          // Les effets lecteurs d'un store universel (`µ.store.<key>` / `$$key`)
          // ne sont PAS indexés dans `_mjs_effectsByVar['$$'+key]` (le générateur n'y
          // range que les `$` locaux/derived) → `_mjs_invalidate('$$'+key)` tombait
          // dans le fast-path no-op et ne re-rendait JAMAIS l'abonné. `'_awaits_'`
          // force le full render (struct + `_mjs_effectsAll`, où vivent ces effets),
          // ciblé aux seuls composants abonnés à la clé mutée. État global =
          // mutations rares → le re-render complet (borné à 1 composant) est
          // acceptable.
          results.push(this._mjs_subscribers.get(key).forEach((comp) => {
            return typeof comp._mjs_invalidate === "function" ? comp._mjs_invalidate('_awaits_') : void 0;
          }));
        }
        return results;
      });
    }
  }

};
