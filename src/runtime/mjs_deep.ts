// mjs_deep — mutations PROFONDES d'un état : `µ._mjs_deepSet` (`$o.x = v`), `µ._mjs_deepCall`
// (`$liste.push(v)`), `µ._mjs_deepDelete` (`delete $o.x`) et `µ._mjs_makeDeepProxy` (enveloppe rendue
// au point de FUITE d'un chemin, et rune `µproxy`). DÉTACHÉES de mjs_init.ts : le suiveur de
// chemins (generator/path-tracker.ts) et le transpileur émettent ces quatre appels LITTÉRALEMENT,
// et eux seuls les appellent — un projet qui ne mute jamais en profondeur ne les a jamais
// appelées (bundler/features.ts, clé `deep`).
//
// Les briques qu'elles partagent avec le reste du cœur — `µ._mjs_guardPath`, `µ._mjs_toRaw`, `µ._mjs_rawSet`,
// `µ._mjs_snap`, `el._set`/`el._mjs_notifyMutation`, `el._mjs_wrapDeep` — restent où elles sont : le filet
// `_mjs_wrapDeep` (mjs_element.ts) couvre les mutations qui échappent au suivi statique, avec ou sans
// ce fichier.

// `µ._mjs_deepSet(el, ['box', 'width'], 200)` : assigne sans Proxy, navigue
// le chemin et notifie la mutation à la clé top-level. Le compilateur
// génère cet appel pour tous les `$.X.Y... = Z` dont l'alias est trackable.
µ._mjs_deepSet = function(el, path, value) {
  var i, o, topKey, isRaw;
  if (!µ._mjs_guardPath(path)) return;
  topKey = path[0];
  if (path.length === 1) {
    el._set(topKey, value);
    return;
  }
  // Naviguer sur la cible BRUTE : muter via le Proxy re-déclencherait le set
  // trap → double notification (avec la notif explicite ci-dessous).
  o = el._state[topKey];
  o = µ._mjs_toRaw(o);
  // racine marquée µ.raw : mêmes sémantiques que `_mjs_wrapDeep`
  // (mjs_element.ts) — la mutation s'écrit, mais ne notifie JAMAIS.
  isRaw = µ._mjs_rawSet.has(o);
  i = 1;
  while (i < path.length - 1) {
    o = o[path[i]];
    i++;
  }
  var __last = path[path.length - 1];
  // Déballe la VALEUR écrite (pas seulement `o`, le conteneur navigué ci-dessus) : un pair peut
  // renvoyer un objet doublement enveloppé (écho de liaison) — même logique que `_set`.
  value = µ._mjs_toRaw(value);
  if (isRaw) {
    o[__last] = value;
    return;
  }
  // Garde d'égalité : `$obj.x = mêmeValeur` ne doit pas forcer un re-render.
  if (o[__last] === value) return;
  // Snapshot pour µ.inspect (seulement si activé pour cette top-key).
  var __ins = el._mjs_inspections;
  var __snap = (__ins && __ins.has(topKey)) ? µ._mjs_snap(el._state[topKey]) : void 0;
  o[__last] = value;
  return el._mjs_notifyMutation(topKey, __snap);
};

// `µ._mjs_deepCall(el, ['list'], 'push', [item])` : appelle une méthode mutative
// sur un sous-objet et notifie la mutation à la clé top-level.
µ._mjs_deepCall = function(el, path, methodName, args) {
  var i, o, result, topKey, isRaw;
  if (!µ._mjs_guardPath(path)) return void 0;
  topKey = path[0];
  // Naviguer + appeler sur la cible BRUTE : appeler la méthode mutative via le
  // Proxy re-déclencherait le set trap (index + length) → notifs multiples, en
  // plus de la notif explicite ci-dessous.
  o = el._state[topKey];
  o = µ._mjs_toRaw(o);
  // racine marquée µ.raw : mêmes sémantiques que `_mjs_wrapDeep`
  // (mjs_element.ts) — la méthode s'appelle, mais ne notifie JAMAIS.
  isRaw = µ._mjs_rawSet.has(o);
  i = 1;
  while (i < path.length) {
    o = o[path[i]];
    i++;
  }
  // Déballe aussi chaque ARGUMENT (ex. `arr.push($objEnveloppé)`) — pas seulement `o` ci-dessus.
  args = args.map(function(a) { return µ._mjs_toRaw(a); });
  if (isRaw) {
    return o[methodName].apply(o, args);
  }
  // Snapshot pour µ.inspect (seulement si activé pour cette top-key).
  var __ins = el._mjs_inspections;
  var __snap = (__ins && __ins.has(topKey)) ? µ._mjs_snap(el._state[topKey]) : void 0;
  result = o[methodName].apply(o, args);
  el._mjs_notifyMutation(topKey, __snap);
  return result;
};

// `µ._mjs_deepDelete(el, ['obj', 'clé'])` : supprime une sous-propriété
// (`delete $.obj.clé`) et notifie la mutation à la clé top-level. Calqué sur
// µ._mjs_deepSet — navigue la cible BRUTE (µ._mjs_RAW) pour ne pas repasser par le Proxy
// (qui re-notifierait). Émis par le visiteur UnaryExpression du path-tracker
// (cf. generator/path-tracker.ts) : `delete $.x.y` → `µ._mjs_deepDelete(_mjsThis, […])`.
// Le trap `deleteProperty` de `_mjs_wrapDeep` couvre en plus les delete ÉCHAPPÉS
// (via alias/param non tracé statiquement), en miroir du trap `set`.
µ._mjs_deepDelete = function(el, path) {
  var i, o, topKey, isRaw;
  if (!µ._mjs_guardPath(path)) return;
  topKey = path[0];
  if (path.length === 1) {
    // `delete $.x` : on retire la clé racine de l'état puis on notifie.
    delete el._state[topKey];
    return el._mjs_notifyMutation(topKey);
  }
  o = el._state[topKey];
  o = µ._mjs_toRaw(o);
  // racine marquée µ.raw : mêmes sémantiques que `_mjs_wrapDeep`
  // (mjs_element.ts) — la suppression s'écrit, mais ne notifie JAMAIS.
  isRaw = µ._mjs_rawSet.has(o);
  for (i = 1; i < path.length - 1; i++) { o = o[path[i]]; }
  if (isRaw) {
    delete o[path[path.length - 1]];
    return;
  }
  delete o[path[path.length - 1]];
  return el._mjs_notifyMutation(topKey);
};

// `µ._mjs_makeDeepProxy(el, path)` : alias public pour _mjs_wrapDeep, utilisé
// au point d'escape détecté par le compilateur (function call externe,
// storage non-tracké, etc.).
µ._mjs_makeDeepProxy = function(el, path) {
  var i, o, topKey;
  if (!µ._mjs_guardPath(path)) return void 0;
  topKey = path[0];
  o = el._state[topKey];
  i = 1;
  while (i < path.length) {
    o = o[path[i]];
    i++;
  }
  return el._mjs_wrapDeep(o, topKey);
};
