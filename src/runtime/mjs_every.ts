// mjs_every — rune `µevery` (µ.every), timer de composant. DÉTACHÉ du cœur : embarqué
// seulement si le projet écrit `µevery`/`µ.every` (scan textuel, cf. bundler/index.ts) — à la
// différence de `µeffect`, aucune macro/directive du compilateur ne l'émet elle-même.
//
// µevery delai, [options], fn — TIMER de composant : tire une PREMIÈRE fois au
// montage, puis toutes les `delai` ms, et se nettoie tout seul au démontage.
// Branché sur le MONTAGE et pas sur le setup, pour deux raisons :
//   • SSR — les hooks client ne jouent pas au serveur (µ._isServer) ; un timer posé
//     au setup, lui, tournerait DANS le rendu serveur ;
//   • le 1er tir arrive APRÈS le 1er rendu, donc un `{#key}` qui change à ce tir
//     fait jouer la transition d'entrée normalement (sans `.global`).
// Le callback n'est PAS un effet : il ne lit aucune dépendance, ne s'abonne à rien.
// Ses écritures `$x` restent RÉACTIVES (l'écran suit) — c'est le tir qui est
// périodique, pas la réactivité.
// File `_mjs_mount_cbs` (mjs_element.ts) et jamais `_mjs_hooks.mount` : la map des
// hooks n'a qu'UNE case par nom — s'y poser écraserait en silence le `µmount ->` de
// l'utilisateur (piège connu des deux µmount). Idem `_mjs_onSleep`/`_mjs_onAwake` pour
// `pause: true`.
//
// HASH D'OPTIONS — facultatif, ENTRE le délai et la fonction (`µevery 3000, pause: true, ->`) :
//   immediate: false   pas de tir au montage : 1er tir après le délai
//   times: n           n tirs puis arrêt automatique (0 = ne tire jamais)
//   while: -> cond     évalué AVANT chaque tir ; faux ⇒ arrêt, sans tirer
//   pause: true        suspend à la déconnexion du DOM, reprend à la reconnexion
//   onStop: ->         appelé UNE seule fois à l'arrêt, quelle qu'en soit la cause
// Toute autre clé est un AVERTISSEMENT (faute de frappe muette), et une valeur du
// mauvais type retombe sur le défaut de sa clé : le timer tourne quand même.
µ.every = function(delay, opts, fn) {
  var comp = µ.activeComponent;
  // signature souple : le hash est au MILIEU, donc absent ⇒ `opts` porte la fonction
  if (typeof opts === 'function' && fn == null) { fn = opts; opts = null; }
  if (!comp) {
    return µ.warn("[ModularJS] µevery doit être appelé à l'initialisation.");
  }
  if (typeof fn !== 'function' || typeof delay !== 'number' || !(delay >= 0)) {
    return µ.warn("[ModularJS] µevery s'écrit « µevery 2500, -> » : un délai en millisecondes, puis la fonction à répéter.");
  }
  if (opts != null && (typeof opts !== 'object' || Array.isArray(opts))) {
    µ.warn("[ModularJS] µevery : le 2e argument est un hash d'options (« µevery 3000, pause: true, -> ») — reçu :", opts);
    opts = null;
  }
  var CLES = ['immediate', 'times', 'while', 'pause', 'onStop'];
  var lire = function(cle, type, defaut) {
    if (opts == null || opts[cle] == null) return defaut;
    if (typeof opts[cle] !== type) {
      µ.warn('[ModularJS] µevery : option « ' + cle + ' » attendue de type ' + type + ', reçu : ', opts[cle], '— option ignorée.');
      return defaut;
    }
    return opts[cle];
  };
  if (opts != null) {
    for (var cle in opts) {
      if (!Object.prototype.hasOwnProperty.call(opts, cle)) continue;   // jamais les clés HÉRITÉES : un objet fabriqué sur un prototype porteur ferait un faux « option inconnue »
      if (CLES.indexOf(cle) < 0) µ.warn('[ModularJS] µevery : option inconnue « ' + cle + ' ». Options reconnues : ' + CLES.join(', ') + '.');
    }
  }
  var immediate = lire('immediate', 'boolean', true);
  var pause     = lire('pause', 'boolean', false);
  var whileFn   = lire('while', 'function', null);
  var onStop    = lire('onStop', 'function', null);
  var limite    = lire('times', 'number', null);
  if (limite != null && !(limite >= 0)) {
    µ.warn('[ModularJS] µevery : option « times » attendue ≥ 0, reçu :', limite, '— option ignorée.');
    limite = null;
  }
  var id      = null;
  var arrete  = false;
  var enPause = false;
  var tirs    = 0;
  // une exception dans le code utilisateur tuerait l'intervalle en silence : on la
  // route vers la frontière d'erreur du composant, comme le fait _mjs_runEffectsV2 —
  // sauf sur un composant déjà mort ou crashé, où la frontière n'a plus de sens
  var routeErreur = function(err) {
    if (typeof comp._mjs_catchError === 'function' && !comp._mjs_has_crashed && !comp._mjs_dead) comp._mjs_catchError(err);
    else µ.warn('[ModularJS] µevery :', err);
  };
  // Un corps ASYNC (`µevery 3000, -> $x = await sonder()`) rend une promesse : le
  // try/catch qui l'entoure est SYNCHRONE et ne voit rien de ce qui rejette APRÈS
  // le premier `await`. Sans ce raccord, l'échec ne partait vers aucune frontière
  // d'erreur, `_mjs_has_crashed` restait faux, le timer rejouait indéfiniment — et
  // chaque rejet devenait un unhandledRejection (fatal sous Node). Trouvé sur
  // l'exemple vedette de la doc lui-même.
  var suivreSiPromesse = function(res) {
    if (res && typeof res.then === 'function') res.then(null, routeErreur);
    return res;
  };
  var stop = function() {
    if (arrete) return;                                         // `arreter()` puis démontage : onStop ne part qu'UNE fois
    arrete = true;
    if (id != null) { clearInterval(id); id = null; }
    if (onStop) {
      try { suivreSiPromesse(onStop.call(comp)); }
      catch (err) { routeErreur(err); }
    }
  };
  var tick = function() {
    // composant CRASHÉ (frontière d'erreur) : on coupe pour de bon. Sans ça, un tick
    // qui échoue rejoue son erreur à chaque période (39 fois en 200 ms, mesuré) et un µevery sain continue de travailler pour un
    // composant mort — alors que tout le reste du runtime s'arrête sur `_mjs_has_crashed`.
    if (comp._mjs_has_crashed) return stop();
    if (whileFn) {
      var suite;
      try { suite = whileFn.call(comp); }
      catch (err) { routeErreur(err); return stop(); }          // condition qui jette = condition qu'on ne sait pas lire : on arrête
      // une condition ASYNC rend une promesse, TOUJOURS vraie : la boucle ne
      // s'arrêterait jamais, en silence. On le dit et on arrête.
      if (suite && typeof suite.then === 'function') {
        suite.then(null, function() {});
        µ.warn("[ModularJS] µevery : l'option « while » doit rendre un booléen SYNCHRONE — une fonction async rend une promesse, toujours vraie, et la répétition ne s'arrêterait jamais. Arrêt.");
        return stop();
      }
      if (!suite) return stop();
    }
    try { suivreSiPromesse(fn.call(comp)); }
    catch (err) { routeErreur(err); }
    tirs++;                                                     // un tir raté reste un tir : sinon `times: 3` sur une fonction qui jette boucle sans fin
    if (limite != null && tirs >= limite) stop();
  };
  var demarre = function() {
    if (arrete || comp._mjs_dead) return;                       // détruit entre le setup et le montage : rien à démarrer
    if (limite != null && tirs >= limite) return stop();        // `times: 0`
    if (immediate) tick();
    if (arrete) return;                                         // le 1er tir a pu tout arrêter (`times: 1`, `while` faux) : pas d'intervalle à poser
    id = setInterval(tick, delay);
  };
  // teardown DÉFINITIF (jamais à µsleep) : _mjs_onDestroy est une LISTE, aucun risque
  // d'écrasement entre deux µevery du même composant
  comp._mjs_onDestroy(stop);
  if (pause) {
    // suspension à la déconnexion du DOM — c'est ce qui manquait à l'hibernation du
    // pageCache (page parquée, timer qui continuait de tourner hors écran)
    comp._mjs_onSleep(function() {
      if (arrete || id == null) return;
      clearInterval(id); id = null; enPause = true;
    });
    comp._mjs_onAwake(function() {
      if (arrete || !enPause) return;
      enPause = false;
      id = setInterval(tick, delay);                            // on REPREND : pas de tir de reprise, et la fraction de période déjà écoulée est perdue
    });
  }
  if (comp._mjs_mounted) {
    demarre();                                                  // déjà monté (µevery posé depuis un µmount) : la file ne sera plus vidée
  } else {
    (comp._mjs_mount_cbs || (comp._mjs_mount_cbs = [])).push(demarre);
    comp._mjs_pendingMount = true;                              // jamais remis à false ailleurs qu'au tir du montage
  }
  return stop;                                                  // main d'arrêt : `arreter = µevery 1000, ->` puis `arreter()`
};
