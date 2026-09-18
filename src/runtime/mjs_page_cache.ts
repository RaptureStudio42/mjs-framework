// mjs_page_cache — cache de pages/vues hibernées (routeur + UJS) et libellés du runtime
// (router/ujs/modal) : DÉTACHÉ du cœur (mjs_init.ts en portait ces symboles), DÉTECTÉ PAR
// CONFIG SEULE (jamais par scan) — signal = module `router` OU `ujs` OU `modal` sélectionné.
//
// `µ.LRUCache`/`µ._mjs_isPageCached`/`µ._mjs_destroyEvictedTree`/`µ._mjs_routeErrorCss` ne servent QU'à
// router+ujs : `µ.pageCache`/`µ._mjs_scrollPos`/`µ._mjs_preloadCache` (mjs_ujs.ts) et `instCache`
// (mjs_router.ts) sont des `µ.LRUCache`, `pageCache.onEvict` (mjs_ujs.ts) appelle
// `µ._mjs_destroyEvictedTree` SANS garde `typeof` — 'ujs' seul (sans 'router') l'exige donc déjà. Le
// panneau d'erreur de route (`_mjs_routeErrorCss`) est partagé par les DEUX consommateurs (aucun des
// deux n'a de repli si l'autre est absent, cf. l'historique : « mjs_ujs.ts peut tourner SANS
// mjs_router.ts, une source unique posée sur le seul module garanti présent »).
//
// `µ._mjs_label`/`µ._mjs_labelLang` sont EN PLUS lus par `mjs_modal.ts` (`_mjs_label('modal'|'toast', …)`,
// guardé `typeof µ._mjs_label === 'function'` — sans ce fichier, 'modal' SEUL continuerait de
// fonctionner mais perdrait la traduction projet des libellés toast/modale, repli sur le texte
// fixe) : 'modal' rejoint donc router/ujs comme signal, plutôt qu'un fichier séparé pour 2
// fonctions qui partagent déjà la même doctrine (faux positif accepté sur LRUCache si SEUL
// 'modal' est sélectionné — jamais l'inverse).

// Feuille du panneau « route introuvable » — partagée entre mjs_router.ts (_mjs_showNoMatch,
// routeur hash/<@view>) et mjs_ujs.ts (_mjs_navShowNotFound, navigation JSON) : mêmes classes
// `mjs-route-error*`, injectées par un `<style>` FRÈRE du panneau (jamais adoptedStyleSheets,
// jamais de shadow — cf. leurs call-sites).
µ._mjs_routeErrorCss = '.mjs-route-error{margin:2rem auto;max-width:34rem;padding:1.25rem 1.5rem;border:1px solid var(--mjs-route-error-border, #d9534f);border-radius:var(--mjs-route-error-radius, 8px);background:var(--mjs-route-error-bg, rgba(217,83,79,.08));color:var(--mjs-route-error-fg, #d9534f);font:15px/1.6 system-ui,sans-serif;text-align:center}.mjs-route-error strong{display:block;font-size:1.25rem;margin-bottom:.4rem}.mjs-route-error p{margin:0 0 .6rem}.mjs-route-error code{font:13px/1.5 ui-monospace,monospace;opacity:.85;word-break:break-all}.mjs-route-error-list{margin-top:.8rem;font-size:12px;opacity:.75}';

// Vrai si le nœud vit dans un sous-arbre PARQUÉ par le pageCache d'ujs
// (hibernation : il sera réinséré tel quel — ne pas invoquer onDestroy).
µ._mjs_isPageCached = function(node) {
  var n = node, guard = 0;
  while (n && guard++ < 200) {
    if (n._mjs_page_cached) return true;
    n = n.parentNode || n.host || null;
  }
  return false;
};

// Détruit DÉFINITIVEMENT un arbre évincé d'un cache d'hibernation (pageCache
// LRU, vues du routeur) : ses composants avaient été exemptés de la
// destruction différée — on relance leurs teardowns maintenant que l'arbre
// est abandonné pour de bon. Traverse aussi les shadow roots (_shadow).
µ._mjs_destroyEvictedTree = function(root) {
  if (!root) return;
  root._mjs_page_cached = false;
  var walk = function(node, depth) {
    if (!node || depth > 50) return;
    if (!node.isConnected && typeof node._mjs_runDestroyCallbacks === 'function') {
      node._mjs_runDestroyCallbacks();
    }
    var kids = node.children, i;
    if (kids) {
      for (i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    }
    if (node._shadow && node._shadow.children) {
      for (i = 0; i < node._shadow.children.length; i++) walk(node._shadow.children[i], depth + 1);
    }
  };
  walk(root, 0);
};

// libellés du runtime (src/runtime-labels.ts) posés par le manifest en TOUTES langues
// (`µ._runtimeLabels = { fr: {…}, en: {…} }`) : la langue se choisit ICI, à l'affichage, jamais au build —
// un site basculé en anglais montrait des toasts « Succès »/« Erreur ».
// CORRECTIF d'ordre : la langue DEMANDÉE au store (`µlang`, µ._mjs_storeRaw.__mjsLang)
// prime désormais sur la langue EFFECTIVE du module i18n (µ._mjs_i18nEffectiveLang, mjs_i18n.ts) — un toast
// tiré dans le MÊME TICK qu'un clic « EN » sortait encore en français, `µ._mjs_i18nEffectiveLang()` restant
// sur l'ancienne langue tant que le swap asynchrone n'a pas fini d'assurer les fragments de la
// langue cible. Ordre complet : store (`__mjsLang`) → langue effective i18n
// → `<html lang>` → langue de repli du build (`µ._runtimeLabelsLang` = i18n.default du projet, sinon
// clé `lang` du CLI). Langue inconnue de la table (de, es…) → repli sur celle du build, puis en, puis
// fr. `µ._mjs_label` consulte D'ABORD le dictionnaire du PROJET (`µ._mjs_i18nLookup`, mjs_i18n.ts) sur la clé
// racine réservée `mjs.<groupe>.<clé>` (`mjs.toast.success`, `mjs.modal.cancel`…) — une chaîne trouvée
// là l'emporte sur cette table entière, cf. docs/29-i18n.md « Libellés du framework ».
µ._mjs_labelLang = function() {
  var l = (µ._mjs_storeRaw && µ._mjs_storeRaw.__mjsLang) || (typeof µ._mjs_i18nEffectiveLang === 'function' && µ._mjs_i18nEffectiveLang()) || (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || µ._runtimeLabelsLang || '';
  return String(l).toLowerCase().split('-')[0];
};
µ._mjs_label = function(group, key) {
  var fromProject = typeof µ._mjs_i18nLookup === 'function' ? µ._mjs_i18nLookup('mjs.' + group + '.' + key) : undefined;
  if (typeof fromProject === 'string') { return fromProject; }
  var all = µ._runtimeLabels;
  if (!all) { return undefined; }
  var tbl = all[µ._mjs_labelLang()] || all[µ._runtimeLabelsLang] || all.en || all.fr;
  return (tbl && tbl[group]) ? tbl[group][key] : undefined;
};

// >>> extrait-test LRUCache
µ.LRUCache = (function() {
  // Cache LRU (Least Recently Used) — protège les caches globaux d'une
  // croissance illimitée dans les SPA longue durée. API compatible avec Map
  // pour pouvoir remplacer `new Map()` sans modifier les call-sites.
  class LRUCache {
    constructor(maxSize = 200) {
      this.maxSize = maxSize;
      this._map = new Map();
    }

    get(key) {
      // Micro-optimisation : skip `has+get` (2 lookups) → utiliser `get` direct.
      // Pour les valeurs définies, distinguer "absent" via Map.get → undefined
      // est ambiguë : utilise undefined comme sentinelle (les caches MJS ne
      // stockent JAMAIS undefined comme valeur). Si l'API évolue, fallback
      // sur has(). Sur cache hot (read 1000× même template) gain ~1-2ms.
      var val = this._map.get(key);
      if (val === void 0) {
        return void 0;
      }
      // Réinsère pour le repousser en queue (most-recently-used)
      this._map.delete(key);
      this._map.set(key, val);
      return val;
    }

    has(key) {
      return this._map.has(key);
    }

    set(key, val) {
      var oldest, evicted;
      if (this._map.has(key)) {
        this._map.delete(key);
      }
      this._map.set(key, val);
      if (this._map.size > this.maxSize) {
        // Évince la clé la plus ancienne (en tête, ordre d'insertion)
        oldest = this._map.keys().next().value;
        evicted = this._map.get(oldest);
        this._map.delete(oldest);
        // Hook d'éviction : indispensable quand les valeurs exigent un
        // teardown (pageCache : arbres DOM hibernés dont la destruction a
        // été sautée — sans ce hook, leurs timers fuyaient à vie).
        if (typeof this.onEvict === 'function') {
          try { this.onEvict(oldest, evicted); } catch (e) { µ.warn('[LRUCache] onEvict en erreur :', e); }
        }
      }
      return this;
    }

    delete(key) {
      // bypassait onEvict : un appelant
      // qui invalide EXPLICITEMENT une entrée (ex. pageCache après une
      // mutation réseau) l'abandonne pour de bon, exactement comme une
      // éviction naturelle par dépassement de maxSize — sans ce hook, le
      // même teardown que set() déclenche à l'éviction (destruction d'un
      // arbre DOM hiberné, cf. pageCache.onEvict) était sauté ici, fuite
      // identique à celle que ce hook existe pour empêcher.
      var had, val;
      had = this._map.has(key);
      if (had) {
        val = this._map.get(key);
        this._map.delete(key);
        if (typeof this.onEvict === 'function') {
          try { this.onEvict(key, val); } catch (e) { µ.warn('[LRUCache] onEvict en erreur :', e); }
        }
      }
      return had;
    }

    clear() {
      // Délègue à delete() (pas this._map.clear() direct) : même raison que
      // ci-dessus — chaque entrée purgée doit passer par onEvict.
      var keys, i;
      keys = Array.from(this._map.keys());
      for (i = 0; i < keys.length; i++) {
        this.delete(keys[i]);
      }
    }

  };

  Object.defineProperty(LRUCache.prototype, 'size', {
    get: function() {
      return this._map.size;
    }
  });

  return LRUCache;

}).call(this);
// <<< extrait-test LRUCache
