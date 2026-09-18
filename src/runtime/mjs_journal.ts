// mjs_journal — étage CLIENT du journal d'erreurs 3 étages (module runtime OPTIONNEL
// 'journal', cf. bundler/index.ts CANONICAL + config.ts OPTIONAL_RUNTIME_MODULES).
//
// Le GATE est LU À CHAQUE ÉVÉNEMENT (jamais une seule fois au chargement du module) : même bundlé,
// ce module n'arme rien tant que `µ.config.journal !== true` (mjs_init.ts, défaut false) — et
// inversement, une app qui bascule `µ.config.journal = true` APRÈS le chargement du cœur (cas
// normal : le cœur charge et s'exécute AVANT tout code applicatif) voit le veilleur s'activer sans
// rien recharger. Double porte VOULUE (cf. JournalConfig, bundler/config.ts) : le serveur doit
// AUSSI ouvrir `journal.client` — l'un sans l'autre ne fait jamais fuiter la moindre trame.
//
// Capture : écoute error (addEventListener, erreurs non interceptées) + unhandledrejection (promesses rejetées
// sans .catch) + enrobage de µ.error (le console.error D'ORIGINE reste TOUJOURS appelé — ce
// veilleur n'efface jamais les logs qu'un développeur attend). Dédoublonné par SIGNATURE (Set,
// jamais purgé avant un rechargement complet de page) : une erreur qui boucle à chaque frame
// n'envoie qu'UNE fois. Plafond dur 20 envois par session (une entrée déjà vue n'y compte pas).
// Transport : sendBeacon (survit à la fermeture d'onglet — c'est fait pour ça), repli fetch
// keepalive si absent OU si la mise en file échoue. TOUT ce fichier est sous garde try/catch
// MUETTE : un veilleur d'erreurs qui, lui-même, plante et casse l'appli qu'il surveille serait
// absurde.

(function() {
  var MAX_SENDS   = 20;
  var MAX_MESSAGE = 300;
  var MAX_PILE    = 7000;
  var MAX_URL     = 500;
  var sent = 0;
  var seen = new Set();

  var enabled = function() {
    return !!(µ.config && µ.config.journal === true);
  };

  var firstLine = function(s) {
    var i = s.indexOf('\n');
    return i === -1 ? s : s.slice(0, i);
  };

  var truncate = function(s, max) {
    return s.length > max ? s.slice(0, max) : s;
  };

  var buildPayload = function(message, pile) {
    return {
      message: truncate(String(message || ''), MAX_MESSAGE),
      pile: truncate(String(pile || ''), MAX_PILE),
      url: truncate(location.pathname + location.search, MAX_URL),
      version: µ.version || null
    };
  };

  // exposé (testabilité directe, même patron que µ._mjs_smoothSample — cf. tests/runtime-journal.test.ts)
  µ._mjs_journalSend = function(payload) {
    try {
      if (!enabled()) return;
      var sig = payload.message + '\n' + firstLine(payload.pile) + '\n' + payload.url;
      if (seen.has(sig)) return;
      if (sent >= MAX_SENDS) return;
      seen.add(sig);
      sent++;
      var json = JSON.stringify(payload);
      var queued = false;
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        try {
          queued = navigator.sendBeacon('/__mjs/errors', new Blob([json], { type: 'application/json' }));
        } catch (e) { queued = false; }
      }
      if (!queued) {
        fetch('/__mjs/errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true }).catch(function() {});
      }
    } catch (e) { /* veilleur muet — jamais de crash en cascade */ }
  };

  window.addEventListener('error', function(e) {
    try {
      if (!enabled()) return;
      var msg = (e && e.message) || 'Error';
      var stack = (e && e.error && e.error.stack) || msg;
      µ._mjs_journalSend(buildPayload(msg, stack));
    } catch (err) { /* muet */ }
  });

  window.addEventListener('unhandledrejection', function(e) {
    try {
      if (!enabled()) return;
      var reason = e && e.reason;
      var msg = (reason && reason.message) || String(reason);
      var stack = (reason && reason.stack) || msg;
      µ._mjs_journalSend(buildPayload(msg, stack));
    } catch (err) { /* muet */ }
  });

  // enrobage de µ.error — TOUJOURS posé (que le journal soit actif ou non) : le gate se joue à
  // l'INTÉRIEUR (enabled(), via µ._mjs_journalSend), jamais sur la présence du wrapper lui-même.
  var originalError = µ.error;
  µ.error = function() {
    try {
      if (enabled()) {
        var parts = [];
        var firstErr = null;
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          if (firstErr === null && a instanceof Error) firstErr = a;
          parts.push(typeof a === 'string' ? a : ((a && a.message) || String(a)));
        }
        var msg = parts.join(' ');
        µ._mjs_journalSend(buildPayload(msg, (firstErr && firstErr.stack) || msg));
      }
    } catch (err) { /* muet */ }
    return originalError.apply(this, arguments);
  };
})();
