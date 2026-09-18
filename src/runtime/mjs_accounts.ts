// mjs_comptes — client réactif du paquet COMPTES & IDENTITÉS (src/mjs-ws/accounts.ts), posé
// PAR-DESSUS µ.socket (patch externe de MjsSocket.prototype, MÊME patron que mjs_chat.ts/mjs_game.ts)
// — mjs_socket.ts DOIT être chargé AVANT ce fichier (ordre canonique du bundler, cf. src/bundler/
// index.ts resolveRuntimeFiles) ; sans lui, ce module reste inerte (garde `typeof MjsSocket !==
// 'undefined'`, jamais un crash).
//
//   compte = sock.account   # store réactif plat, SINGLETON par socket — PROPRIÉTÉ (pas un appel,
//                          # contrairement à sock.chat(nom)/sock.game() : une seule identité de
//                          # compte par connexion, rien à nommer)
//
//   await compte.creer('zora', 'motdepasse123')       # crée + connecte (élève la session en cours)
//   await compte.connecter('zora', 'motdepasse123')   # connecte un compte existant
//   await compte.deconnecter()                        # ferme la session compte, purge le jeton local
//
//   {if compte.connecte}Bonjour {compte.pseudo}{end}
//   {if compte.erreur}<p class="erreur">{compte.erreur}</p>{end}
//
// `.connecte`/`.pseudo`/`.roles` — décodés du PAYLOAD du jeton (base64url, JAMAIS vérifié côté
// client : la garantie vient du SERVEUR, qui a déjà validé le jeton — via le hello de la
// RECONNEXION contrôlée, cf. _compteElever ci-dessous — avant que ce store ne se mette à jour) —
// lecture SEULE, jamais une source de vérité pour une décision de SÉCURITÉ côté client (un rôle
// affiché peut être en retard d'un aller-retour réseau, jamais plus — la vérité reste
// `client.identity` côté serveur).
// `.erreur` — dernier refus serveur ('account-name-taken'|'account-name-invalid'|'compte-secret-
// court'|'account-denied'|'account-throttled'), ou un refus d'ÉLÉVATION (jeton expiré/invalide → la
// RECONNEXION est alors refusée par le serveur, `µ:denied`, cf. _compteElever). Posée par
// creer()/connecter() (rejet de leur Promise) ET par la reprise automatique au boot — jamais par
// deconnecter() (dont l'éventuel rejet réseau n'a aucun rapport avec une identité refusée).
// `.jeton` — le jeton COURANT en lecture (intégration back maison, ex. l'attacher soi-même à un
// appel `fetch()` applicatif) — `null` tant qu'aucune élévation n'a réussi.
//
// ÉLÉVATION — PAR RECONNEXION, PAS par sock.refresh() — `sock.refresh()` (µ:refresh,
// mjs-ws/core.ts::handleRefresh) réutilise
// `opts.auth` mais REFUSE tout changement d'`identity.id` (« une session ne change jamais
// d'identité en vol », invariant STRICT de core.ts) : passer d'anonyme
// (`identity` sans `id`) à un compte (`id` généré) EST un changement d'id — TOUJOURS `refresh-
// denied`, quel que soit le jeton. Un hello FRAIS (nouvelle connexion), en revanche, n'a AUCUNE
// identité antérieure à comparer : `_compteElever` ci-dessous pose `sock.opts.auth` pour qu'il
// renvoie le jeton, puis force une RECONNEXION contrôlée (`close()` + `connect()`, MÊME socket,
// MÊME salons/abonnements réabonnés automatiquement par le welcome suivant, cf. mjs_socket.ts) —
// c'est CE hello, tout neuf, qui devient authentifié. Après élévation, `opts.auth` reste posé sur
// ce jeton : une reconnexion FUTURE (coupure réseau) le réutilise automatiquement, SANS repasser
// par ce module — `deconnecter()` restaure l'`auth` d'ORIGINE (cf. plus bas), pour qu'une
// reconnexion après déconnexion explicite ne ressuscite pas le compte.
//
// Persistance locale du jeton — `localStorage`, clé configurable via `µ.socket(url, { account: { key:
// '...' } })` (défaut 'mjs-token'), accès TOUJOURS gardé `typeof localStorage !== 'undefined'`
// (SSR/happy-dom : peut être absent, MÊME garde que mjs_router.ts/mjs_store_globals.ts pour
// window/document). Au premier accès à `sock.account` (avant même `sock.connect()`, cf. la
// propriété tout en bas), un jeton stocké déclenche IMMÉDIATEMENT `_compteElever` : « reconnexion
// connectée d'office », sans repasser par connecter(). Un jeton mort (expiré/invalide/révoqué)
// purge le jeton local — évite de retenter indéfiniment un jeton mort à chaque accès futur. Purgé
// aussi par deconnecter() (succès ET échec réseau — l'intention de déconnexion locale prime).

if (typeof MjsSocket !== 'undefined') {

  var MJS_ACCOUNT_DEFAULT_KEY = 'mjs-token';
  var MJS_ACCOUNT_ELEVATION_TIMEOUT_MS = 5000;   // filet de DERNIER recours — cf. _compteElever
  var MJS_ACCOUNT_ELEVATION_PROBE_MS   = 25;     // détection RAPIDE d'un refus — cf. _compteElever

  // décodage base64url → JSON du PAYLOAD (segment du milieu), SANS vérification (aucun secret côté
  // client, cf. tête de fichier) — jamais un throw, `null` sur tout format inattendu (MÊME esprit
  // défensif que mjs-ws/token.ts::verifyToken côté serveur, qui ne throw jamais non plus).
  function _accountDecodeToken(token) {
    if (typeof token !== 'string') { return null; }
    var parts = token.split('.');
    if (parts.length !== 3) { return null; }
    if (typeof atob !== 'function') { return null; }   // environnement sans atob (Node ancien hors navigateur) — jamais un crash
    try {
      var s = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4 !== 0) { s += '='; }
      return JSON.parse(atob(s));
    } catch (e) { return null; }
  }

  function _accountStorage() {
    // `typeof localStorage` DANS le try : sur une origine opaque,
    // l'identifiant lui-même est un ACCESSEUR qui lève (SecurityError), pas seulement ses
    // méthodes — même motif que mjs_i18n.ts (__i18nDetectInitialLang / persistance bascule).
    try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; }
  }

  function _accountRead(key) {
    var s = _accountStorage();
    if (!s) { return null; }
    try { return s.getItem(key); } catch (e) { return null; }   // quota/mode privé — jamais un crash
  }

  function _accountWrite(key, token) {
    var s = _accountStorage();
    if (!s) { return; }
    try { s.setItem(key, token); } catch (e) {}
  }

  function _accountErase(key) {
    var s = _accountStorage();
    if (!s) { return; }
    try { s.removeItem(key); } catch (e) {}
  }

  // applique un jeton FRAÎCHEMENT élevé (hello déjà accepté, cf. _compteElever) — store + stockage
  // local, en un seul point pour ne jamais désynchroniser les deux.
  function _accountApply(h, token) {
    var payload = _accountDecodeToken(token);
    h._mjs_jeton = token;
    h.state.loggedIn = true;
    h.state.name   = (payload && payload.name) || null;
    h.state.roles    = (payload && payload.roles) || [];
    h.state.token    = token;
    h.state.error   = null;
    _accountWrite(h._mjs_cle, token);
  }

  // normalise une raison de rejet en CHAÎNE affichable — les refus serveur (account:create/connecter)
  // rejettent déjà une chaîne nue ('account-name-taken'…, cf. mjs-ws/accounts.ts), mais un ÉCHEC
  // D'ÉLÉVATION (_compteElever, filet timeout) rejette `sock.lastError`, un OBJET `{code,message}`
  // comme partout ailleurs dans mjs_socket.ts — sans cette normalisation, `.erreur` afficherait
  // « [object Object] » dans ce second cas (cf. tête de fichier, `{if compte.erreur}{compte.erreur}`).
  function _accountErrorText(err) {
    if (typeof err === 'string') { return err; }
    if (err && typeof err === 'object' && typeof err.message === 'string') { return err.message; }
    return String(err);
  }

  // redescend en invité — store + purge du stockage local (cf. tête de fichier « à la
  // déconnexion ») + restaure l'auth D'ORIGINE (cf. tête de fichier « Élévation », sans quoi une
  // reconnexion future ressusciterait le compte via la closure encore vivante du jeton révoqué).
  function _accountForget(h) {
    h._mjs_jeton = null;
    h.state.loggedIn = false;
    h.state.name   = null;
    h.state.roles    = [];
    h.state.token    = null;
    _accountErase(h._mjs_cle);
    h._mjs_sock.opts.auth = h._mjs_originalAuth;
  }

  // Élève la connexion via une RECONNEXION CONTRÔLÉE (cf. tête de fichier « ÉLÉVATION » pour le
  // POURQUOI — sock.refresh() est structurellement incapable de changer identity.id). Pose
  // `opts.auth` sur le jeton, ferme la connexion courante SI besoin (`close()` est un no-op sûr sur
  // un socket jamais encore connecté — `_mjs_ws` est déjà `null`), puis `connect()` : le welcome SUIVANT
  // porte la nouvelle identité (mjs_socket.ts réabonne salons/flux automatiquement, cf. hello()).
  // Résolue au PROCHAIN 'welcome'. ÉCHEC (jeton expiré/invalide → µ:denied, cf. mjs-ws/core.ts::
  // sendDeniedAndClose) : AUCUN événement client dédié n'existe pour µ:denied (mjs_socket.ts::
  // _mjs_onDenied ne fait que fermer + poser `lastError`, cf. son commentaire de tête) — une sonde
  // COURTE (25 ms) détecte la fermeture au lieu d'attendre le filet timeout (dernier recours,
  // réseau réellement muet) : sans elle, un refus mettrait `MJS_COMPTE_ELEVATION_TIMEOUT_MS`
  // (5 s) à se signaler alors qu'un aller-retour réseau réel est quasi instantané, MÊME classe de
  // latence qu'un welcome.
  function _accountElevate(h, token) {
    var self = h._mjs_sock;
    self.opts.auth = function() { return token; };
    return new Promise(function(resolve, reject) {
      var reglee = false;
      var minuteur, sondeur;
      function fini() {
        clearTimeout(minuteur);
        clearInterval(sondeur);
        self.off('welcome', surWelcome);
      }
      function surWelcome() {
        if (reglee) { return; }
        reglee = true;
        fini();
        _accountApply(h, token);
        resolve();
      }
      self.on('welcome', surWelcome);
      sondeur = setInterval(function() {
        if (reglee || self.state !== 'closed') { return; }
        reglee = true;
        fini();
        reject(self.lastError || { code: 'account-elevation-echec', message: 'connexion refusée' });
      }, MJS_ACCOUNT_ELEVATION_PROBE_MS);
      minuteur = setTimeout(function() {
        if (reglee) { return; }
        reglee = true;
        fini();
        reject(self.lastError || { code: 'account-elevation-echec', message: 'aucune réponse du serveur' });
      }, MJS_ACCOUNT_ELEVATION_TIMEOUT_MS);
      self.close();     // no-op sûr si jamais connecté (cf. mjs_socket.ts::close, _mjs_ws déjà null)
      self.connect();
    });
  }

  MjsSocket.prototype._mjs_ensureAccountWiring = function() {
    if (this._mjs_compteWired) { return; }
    this._mjs_compteWired = true;
    var self = this;
    var conf = this.opts.account;
    var key  = (conf && conf.key) || MJS_ACCOUNT_DEFAULT_KEY;
    var state = µ.state({ loggedIn: false, name: null, roles: [], error: null, token: null });
    // opts.auth D'ORIGINE — capturé UNE FOIS, AVANT toute élévation (cf. _compteOublier) : ce
    // module « emprunte » opts.auth pendant qu'une identité de compte est active, le lui rend à la
    // déconnexion — jamais une appropriation permanente d'un réglage qui appartient à l'appli.
    var h = { state: state, _mjs_sock: self, _mjs_cle: key, _mjs_jeton: null, _mjs_originalAuth: this.opts.auth };
    this._mjs_compte = h;

    // creer()/connecter() peuvent échouer à DEUX endroits distincts — la requête account:create/
    // account:login elle-même (rejette TOUJOURS une chaîne, ex. 'account-name-taken', cf.
    // mjs-ws/accounts.ts) OU la reconnexion d'élévation qui suit (_compteElever, cf. son filet
    // timeout : rejette `sock.lastError`, un OBJET `{code,message}` comme partout ailleurs dans
    // mjs_socket.ts) — un SEUL `.catch` capture les deux, `.erreur` reste TOUJOURS une chaîne
    // affichable telle quelle (`{if compte.erreur}{compte.erreur}{end}`, cf. tête de fichier).
    state.create = function(name, secret) {
      return self.request('account:create', { name: name, secret: secret }, { waitForOpen: true })
        .then(function(res) { return _accountElevate(h, res.token); })
        .catch(function(err) { state.error = _accountErrorText(err); throw err; });
    };

    state.login = function(name, secret) {
      return self.request('account:login', { name: name, secret: secret }, { waitForOpen: true })
        .then(function(res) { return _accountElevate(h, res.token); })
        .catch(function(err) { state.error = _accountErrorText(err); throw err; });
    };

    state.logout = function() {
      var p = self.request('account:logout', {}, { waitForOpen: true });
      // l'intention de déconnexion LOCALE prime — purge le jeton (et restaure l'auth d'origine)
      // que l'ack réussisse ou que la requête échoue (panne réseau) : jamais un jeton qui traîne
      // après un deconnecter() appelé, cf. tête de fichier.
      p.then(function() { _accountForget(h); }, function() { _accountForget(h); });
      return p;
    };

    // reprise au boot — jeton stocké → élévation IMMÉDIATE (avant même un premier connect() de
    // l'appli, cf. tête de fichier « reconnexion connectée d'office ») : un jeton ABSENT ne
    // déclenche RIEN (zéro coût, MÊME opt-in strict que le reste de MJS-WS). Un jeton mort
    // (expiré/révoqué) est purgé — évite de retenter indéfiniment un jeton mort au prochain accès.
    var stocke = _accountRead(key);
    if (stocke) {
      _accountElevate(h, stocke).then(
        function() {},
        function(err) { _accountForget(h); state.error = _accountErrorText(err); }
      );
    }
  };

  // propriété, PAS une méthode (cf. tête de fichier) — une seule identité de compte par socket,
  // rien à nommer contrairement à sock.chat(nom)/sock.game(). `_ensureCompteWiring` AVANT
  // `_mjs_ensure()` : un jeton stocké doit pouvoir poser `opts.auth` et déclencher SA PROPRE
  // connexion (cf. _compteElever) avant que `_mjs_ensure()` n'en lance une AUTRE, anonyme, pour rien.
  Object.defineProperty(MjsSocket.prototype, 'account', {
    configurable: true,
    get: function() {
      this._mjs_ensureAccountWiring();
      this._mjs_ensure();
      return this._mjs_compte.state;
    },
  });

}
