// mjs_game — client réactif du protocole µgame:* de MJS-Server (src/mjs-server/), posé PAR-DESSUS
// µ.socket (patch externe de MjsSocket.prototype, même patron que mjs_flip.ts sur
// µ.Element.prototype) — mjs_socket.ts DOIT être chargé AVANT ce fichier (ordre canonique du
// bundler, cf. src/bundler/index.ts resolveRuntimeFiles) ; sans lui, ce module reste inerte
// (garde `typeof MjsSocket !== 'undefined'`, jamais un crash).
//
//   partie = sock.game('morpion')                    # file publique
//   partie = sock.game('morpion', { code: true })     # crée une partie privée (code généré)
//   partie = sock.game('morpion', { code: 'ABCDE' })  # rejoint ce code (inconnu → statut 'error')
//   regard = sock.game('morpion', { code: 'ABCDE', spectateur: true })  # REGARDE ce code, lecture
//                                                      seule (aucun siège, cf. partie.state.spectateur
//                                                      côté serveur — vue via def.spectatorView)
//
//   {if partie.state.statut === 'waiting'}en file, position {partie.state.attente}{/if}
//   {if partie.state.statut === 'playing'}{partie.state.grille[0]}…{/if}   # vue APLATIE, réactif
//   await partie.move('jouer', { i: 4 })     # Promise — résout au `resultat` de l'ack, ou rejette
//   off = partie.on('end', (p) -> …)         # 'event'|'state'|'seat'|'start'|'end'|'left'|'error'
//   partie.leave()                           # µgame:leave (best-effort) + statut 'left' immédiat
//
// sock.game(type, opts) renvoie la POIGNÉE IMMÉDIATEMENT (jamais une Promise nue — même choix que
// stream()/presence() : l'appli affiche l'attente réactivement dès le 1er tick, sans rien attendre).
//
// `.state` — STORE RÉACTIF µ (même fabrique que stream()/presence(), cf. mjs_socket.ts) — forme
// APLATIE : les clés de la VUE SERVEUR (celle que renvoie `def.view` côté jeu, spécifique à
// chaque jeu) sont fusionnées TELLES QUELLES à la racine du store, à côté des méta-clés RÉSERVÉES
// ci-dessous. Un jeu dont la vue utiliserait l'un de ces noms se ferait écraser (même compromis
// assumé que le 'reset' de _mjs_applyDelta en face) — à connaître avant de nommer ses champs de vue :
//   partieId  — id de partie (string), null tant que jamais assis
//   siege     — numéro de siège (number), null tant que jamais assis
//   phase     — partie.phase côté serveur (string|null)
//   tour      — à qui le tour, identité stable (string|null)
//   seq       — dernier numéro de séquence appliqué (number|null)
//   code      — code de partie privée si `def.code`, sinon null
//   attente   — position dans la file publique (number) tant que non assis, sinon null
//   statut    — 'waiting' (file, ou refus/coupure en cours de récupération) | 'playing' | 'finished' |
//               'left' | 'error'
//   sieges    — dernier roster µgame:seat, tableau [{siege,connecte}|null], null avant le 1er
//   resultat  — resultat de µgame:end, null avant la fin
//   erreur    — message du dernier refus SERVEUR (string), posé avec statut 'error'
//   spectateur — true si cette poignée REGARDE en lecture seule (opts.spectateur:true, aucun siège
//               — `.move()` sera TOUJOURS rejeté serveur, cf. mjs-server/game.ts), false sinon
//
// Spectateur (anti-triche, mjs-server/game.ts) — `sock.game(type, {code, spectateur:
// true})` rejoint EN LECTURE SEULE une partie EXISTANTE adressée PAR CODE (jamais la file
// publique, ambiguë entre plusieurs parties du même type) : même poignée/store que d'habitude
// (siege reste `null`), `.move()` renvoie une Promise TOUJOURS rejetée (« spectateur : lecture
// seule », refus SERVEUR classique — aucun garde-fou client dédié, MÊME mécanisme que « hors
// tour »). `.leave()` fonctionne SANS changement (µgame:leave, géré côté serveur pour les deux
// cas). Reconnexion : un spectateur n'est PAS resynchronisé (aucune identité de siège à
// retrouver, cf. mjs-server/game.ts) — après une coupure, il redevient simple spectateur du
// dernier état connu tant qu'il ne rappelle pas sock.game() lui-même.
//
// `.move(nom, p)` → Promise résolue par le `resultat` de l'ack µgame:move ; rejetée avec le motif
// de refus tel que sock.request() le donne (chaîne = refus SERVEUR — coup interdit, hors tour… ;
// objet {code,message} = refus TRANSPORT, cf. sock.request). Rejette aussi {code:'not-seated'} si
// appelée avant tout siège connu (statut encore 'waiting', ou déjà 'left'/'error'/'finished').
//
// `.on(évt, fn)` → désabonnement retourné (comme sock.on). `fn` reçoit le PAYLOAD BRUT de la trame
// µgame:* sous-jacente (mêmes clés que le protocole, cf. tête de src/mjs-server/index.ts) :
// 'state'→{partie,vue|delta,phase,tour,seq} (delta : jeu def.deltas:true, cf. plus bas), 'seat'→
// {partie,places,sieges}, 'event'→{partie,type,p},
// 'start'→forme complète de play (émis aussi bien pour le siège dont l'ack complète la partie que
// pour ceux qui reçoivent la poussée serveur — un seul handler à écrire), 'end'→{partie,resultat},
// 'left'→{partie,siege}. 'error'→{message} est un AJOUT au-delà des 6 trames serveur : seul moyen
// d'observer un refus de play/resync côté appli, puisque sock.game() ne renvoie pas de Promise.
//
// `.leave()` — OPTIMISTE : statut 'left' + retrait des registres locaux IMMÉDIAT (synchrone),
// µgame:leave envoyé en best-effort ensuite (résultat ignoré, l'état local reflète déjà le départ).
// Pas de `.retry()` : rappeler sock.game(type, opts) suffit — chaque appel crée une poignée NEUVE
// et indépendante (aucun singleton par type, contrairement à stream()/presence()).
//
// Dédup : un µgame:state dont seq ≤ dernier vu est IGNORÉ (retransmission, désordre).
//
// Deltas (def.deltas:true côté jeu, cf. mjs-server/game.ts) — le serveur peut envoyer µgame:state
// SOUS FORME DELTA : { partie, delta: [{p:'chemin.a.2.b', v} | {p, x:1}], phase, tour, seq } au lieu
// de { vue }. Chaque op s'applique sur la dernière vue connue (chemin À POINTS, v = pose/remplace,
// x:1 = supprime la clé finale, cf. _applyDeltaOps) — TRANSPARENT pour l'appli, `.state` converge
// IDENTIQUEMENT qu'un jeu envoie des vues complètes ou des deltas (cf. tests/socket-game.test.ts).
// Les vues complètes (compat v1) continuent de marcher INCHANGÉES ; le dédup par seq ci-dessus vaut
// pour les deux formes.
//
// Reprise à la reconnexion — au µ:welcome (même détection que le re-abonnement stream/presence de
// mjs_socket.ts::_mjs_onWelcome, cf. son commentaire) : chaque partie 'playing' relance µgame:resync
// (siège retrouvé par identité STABLE, cf. peerIdOf côté serveur — sans opts.auth stable côté
// MJS-WS, resync échoue TOUJOURS, même limite documentée dans mjs-server/game.ts) ; chaque partie
// encore 'waiting' (file, jamais assise) REJOUE µgame:play depuis zéro — la file d'attente ne
// survit PAS à une déconnexion côté serveur (matchmaking.ts::onClientDisconnect vide queues/
// queuedType), rejouer est la seule option honnête. Un refus SERVEUR (chaîne, jamais un objet
// {code,message} de transport) sur l'un ou l'autre chemin est TERMINAL — jamais re-tenté en boucle
// silencieuse (statut 'error' + événement 'error').
//
// Multi-parties simultanées : registre interne par id de partie (_mjs_games) + file locale des
// poignées pas encore assises (_mjs_gamesPending, FIFO). Un µgame:start dont l'id de partie est DÉJÀ
// connu (partie par CODE, déjà assise à 1 place, poussée quand la 2e arrive) met à jour DIRECTEMENT
// cette entrée ; sinon (complétion de FILE publique — le protocole ne transmet AUCUN type sur
// µgame:start, cf. tête de src/mjs-server/index.ts) la poignée la plus ANCIENNE de _mjs_gamesPending est
// la meilleure correspondance disponible — même limite assumée que le join-optimiste de room()
// (mjs_socket.ts::_mjs_pendingRoomJoins/_mjs_onGuardError) : ordre garanti par la FIFO du serveur (un seul
// message traité à la fois), jamais une certitude absolue si un même socket met EN FILE plusieurs
// types de jeu à la fois.

if (typeof MjsSocket !== 'undefined') {

  // --- store réactif : reconstruction COMPLÈTE depuis l'état canonique de la poignée -----------
  // (vue = snapshot PLEIN à chaque trame serveur, jamais un delta — cf. partie.vueDe() : une clé
  // absente de la vue COURANTE ne doit pas s'attarder, d'où le delete-tout puis re-remplissage,
  // même stratégie que le 'reset' de MjsSocket.prototype._mjs_applyDelta en face)
  function _syncGameStore(h) {
    var store = h.state, view = h._mjs_view, k;
    for (k in store) { delete store[k]; }
    if (view && typeof view === 'object') {
      for (k in view) { if (_mjs_safeKey(k)) { store[k] = view[k]; } }
    }
    store.gameId = h._mjs_gameId;
    store.seat    = h._mjs_seat;
    store.phase    = h._mjs_phase;
    store.turn     = h._mjs_turn;
    store.seq      = h._mjs_seq;
    store.code     = h._mjs_code;
    store.queue  = h._mjs_queue;
    store.status   = h._mjs_status;
    store.seats   = h._mjs_seats;
    store.result = h._mjs_result;
    store.error   = h._mjs_error;
    store.spectator = h._mjs_spectator;
  }

  // trame COMPLÈTE (partie/siege/vue/phase/tour/seq/code) — réponse à µgame:play (assis d'office),
  // µgame:start et µgame:resync : toujours le contrat le plus riche du protocole. `<=` (pas
  // seulement `<`) : réappliquer un seq déjà vu est un no-op inoffensif (mêmes valeurs), ignorer
  // évite juste une reconstruction de store superflue.
  function _applyFullFrame(h, frame) {
    if (frame.seq != null && h._mjs_seq != null && frame.seq <= h._mjs_seq) { return false; }
    h._mjs_gameId = frame.game;
    h._mjs_seat    = frame.seat;
    h._mjs_view      = frame.view;
    h._mjs_phase    = frame.phase;
    h._mjs_turn     = frame.turn;
    h._mjs_seq      = frame.seq;
    h._mjs_code     = frame.code;
    h._mjs_queue  = null;
    h._mjs_status   = 'playing';
    // anti-triche — `frame.spectateur` n'existe QUE sur l'ack de watch (serveur, cf.
    // mjs-server/matchmaking.ts::joinAsSpectator) ; absent (undefined) sur toute frame
    // joueur normale → `false`, jamais `undefined` (cohérent avec l'init du handle ci-dessous).
    h._mjs_spectator = frame.spectator === true;
    _syncGameStore(h);
    return true;
  }

  // applicateur de delta CÔTÉ CLIENT, MÊME algorithme que le mini-applicateur
  // préfigurant le client dans tests/mjs-server-action.test.ts (test k, appliquerDelta) : chemin `p` à
  // points ('entites.x.x'), `v` pose/remplace la valeur au bout du chemin, `x: 1` supprime la clé
  // finale. Clé numérique = index de tableau — fonctionne SANS distinction, la notation crochets JS
  // traite un index de tableau comme n'importe quelle autre clé (lecture/écriture/suppression). Les
  // segments INTERMÉDIAIRES d'un chemin existent TOUJOURS déjà côté serveur (deepDiff, cf.
  // mjs-server/game.ts, ne recurse QUE dans une clé présente des deux côtés — une clé neuve arrive
  // toujours en UN SEUL op `v` pour tout le sous-arbre, jamais reconstruite segment par segment) : le
  // `if (!(seg in noeud))` ci-dessous est un filet défensif, jamais le chemin normal. Garde `_mjs_safeKey`
  // (même politique que _syncGameStore ci-dessus et mjs_socket.ts::_mjs_applyDelta) : un segment de chemin réseau ne
  // devient jamais __proto__/constructor/prototype — op silencieusement IGNORÉE si c'est le cas.
  // DÉFENSE EN PROFONDEUR : une suppression (`x:1`) qui viserait quand même un index de
  // tableau (normalement plus jamais émis par deepDiff CÔTÉ SERVEUR au rétrécissement, cf.
  // mjs-server/game.ts::deepDiff) passe par `.splice` plutôt que `delete` — `delete` sur un
  // tableau laisse un TROU et ne corrige pas `.length` (un `undefined` en queue, silencieux).
  function _applyDeltaOps(view, delta) {
    var racine = view || {}, i, op, segments, last, noeud, j, seg;
    for (i = 0; i < delta.length; i++) {
      op = delta[i];
      segments = op.p.split('.');
      last = segments.pop();
      noeud = racine;
      for (j = 0; j < segments.length; j++) {
        seg = segments[j];
        if (!_mjs_safeKey(seg)) { noeud = null; break; }
        if (!(seg in noeud)) { noeud[seg] = {}; }
        noeud = noeud[seg];
      }
      if (!noeud || !_mjs_safeKey(last)) { continue; }
      if ('x' in op) { if (Array.isArray(noeud)) { noeud.splice(Number(last), 1); } else { delete noeud[last]; } } else { noeud[last] = op.v; }
    }
    return racine;
  }

  // trame µgame:state — `frame.vue` (vue COMPLÈTE, compat v1 inchangée) OU `frame.delta` (liste
  // d'ops chemin à points, cf. _applyDeltaOps juste au-dessus — jeu déclaré avec def.deltas:true,
  // cf. mjs-server/game.ts) — JAMAIS siege/code dans les deux cas, cf. _diffuserEtat côté serveur.
  // Dédup EXPLICITE valable pour LES DEUX formes : seq <= dernier vu est ignoré, ni store
  // ni événement. Un delta s'applique EN PLACE sur `h._vue` déjà reconstruit — jamais null ici, un
  // jeu def.deltas:true envoie TOUJOURS une vue complète en 1re diffusion/resync (cf. test h de
  // tests/mjs-server-action.test.ts), `_applyFullFrame` l'aura donc déjà posé avant le premier delta.
  function _applyStatePush(h, frame) {
    if (frame.seq != null && h._mjs_seq != null && frame.seq <= h._mjs_seq) { return false; }
    if (frame.delta) { h._mjs_view = _applyDeltaOps(h._mjs_view, frame.delta); }
    else { h._mjs_view = frame.view; }
    h._mjs_phase = frame.phase;
    h._mjs_turn  = frame.turn;
    h._mjs_seq   = frame.seq;
    _syncGameStore(h);
    return true;
  }

  function _gameOn(h, evt, fn) {
    (h._mjs_handlers[evt] || (h._mjs_handlers[evt] = [])).push(fn);
    return function() {
      var hs = h._mjs_handlers[evt], i;
      if (!hs) { return; }
      i = hs.indexOf(fn);
      if (i >= 0) { hs.splice(i, 1); }
    };
  }

  function _dispatchGame(h, evt, payload) {
    var hs = h._mjs_handlers[evt], copy, i;
    if (!hs) { return; }
    copy = hs.slice();
    for (i = 0; i < copy.length; i++) {
      try { copy[i](payload); } catch (e) { µ.error('[µ.socket] game handler', e); }
    }
  }

  // refus TERMINAL (chaîne serveur, jamais un {code,message} de transport — cf. _mjs_onPlayRejected/
  // _mjs_onResyncRejected) : jamais re-tenté en boucle, l'appli doit rappeler sock.game() elle-même.
  function _failGame(h, message) {
    h._mjs_status = 'error';
    h._mjs_error = message;
    _syncGameStore(h);
    _dispatchGame(h, 'error', { message: message });
  }

  // --- entrée publique ----------------------------------------------------------------------
  MjsSocket.prototype.game = function(type, opts) {
    this._mjs_ensure();
    this._mjs_ensureGameWiring();
    var self = this;
    var h = {
      state:     µ.state({}),
      _mjs_handlers: {},
      _mjs_gameId: null,
      _mjs_seat:    null,
      _mjs_view:      null,
      _mjs_phase:    null,
      _mjs_turn:     null,
      _mjs_seq:      null,
      _mjs_code:     null,
      _mjs_queue:  null,
      _mjs_status:   'waiting',
      _mjs_seats:   null,
      _mjs_result: null,
      _mjs_error:   null,
      _mjs_spectator: false,
      _mjs_type:     type,
      _mjs_playOpts: opts || {},
      move:  function(name, p) { return self._mjs_gameMove(h, name, p); },
      on:    function(evt, fn) { return _gameOn(h, evt, fn); },
      leave: function() { self._mjs_gameLeave(h); },
      // mode lockstep —µgame:hash, fire-and-forget (PAS d'ack, cf. mjs-server/
      // matchmaking.ts::handlerHash enregistré via app.on jamais app.serve) ; no-op tant que non
      // assise (rien à annoncer). Nom `_`-préfixé : pas un contrat pour l'appli hôte, seul µ.lockstep
      // (mjs_lockstep.ts) s'en sert.
      _hash: function(tick, hashValue) {
        if (h._mjs_gameId == null) { return; }
        self.send('µgame:hash', { game: h._mjs_gameId, tick: tick, h: hashValue });
      }
    };
    _syncGameStore(h);
    this._mjs_gamesPending.push(h);
    this._mjs_sendPlay(h);
    return h;
  };

  MjsSocket.prototype._mjs_ensureGameWiring = function() {
    var self = this;
    if (this._mjs_gameWired) { return; }
    this._mjs_gameWired = true;
    this._mjs_games = {};          // id de partie -> poignée, parties DÉJÀ assises
    this._mjs_gamesPending = [];   // poignées SANS id de partie, en file (FIFO) — cf. tête de fichier
    this.on('µgame:state',  function(p) { self._mjs_onGameStatePush(p); });
    this.on('µgame:start',  function(p) { self._mjs_onGameStartPush(p); });
    this.on('µgame:seat',   function(p) { self._mjs_onGameSeatPush(p); });
    this.on('µgame:event',  function(p) { self._mjs_onGameEventPush(p); });
    this.on('µgame:end',    function(p) { self._mjs_onGameEndPush(p); });
    this.on('µgame:left',   function(p) { self._mjs_onGameLeftPush(p); });
    // mode lockstep —1 groupe d'ordres PAR TICK, cf. mjs-server/lockstep.ts ; forward
    // BRUT, aucun dédup/état (contrairement à µgame:state) : µ.lockstep (mjs_lockstep.ts) gère lui-
    // même l'ordonnancement par numéro de tick (tampon, jamais de saut, cf. son commentaire de tête)
    this.on('µgame:orders', function(p) { self._mjs_onGameOrdersPush(p); });
    this.on('welcome',      function() { self._mjs_onGameWelcome(); });
  };

  // --- µgame:play (envoi initial ET rejeu après coupure, cf. _mjs_onGameWelcome) ------------------
  // `_mjs_playInFlight` : DISTINGUE « déjà envoyé, réponse pas encore revenue » de « à (re)jouer ».
  // Indispensable dès le TOUT PREMIER accueil : `_mjs_onWelcome` (mjs_socket.ts) vide déjà
  // `_mjs_pendingOpenReqs` (le 1er µgame:play, mis en attente par request({waitForOpen:true}) tant
  // que la connexion n'était pas ouverte) AVANT de déclencher 'welcome' — sans ce garde-fou,
  // `_mjs_onGameWelcome` retrouvait la poignée encore dans `_mjs_gamesPending` (sa toute 1re réponse pas
  // encore arrivée) et renvoyait un 2e µgame:play EN DOUBLE pour la MÊME intention, avant même
  // d'avoir vu la 1re réponse (un joueur SEUL se retrouvait apparié avec
  // son propre doublon, `def.places` atteint tout seul).
  MjsSocket.prototype._mjs_sendPlay = function(h) {
    var self = this;
    var payload = { type: h._mjs_type };
    if (h._mjs_playOpts.code !== undefined) { payload.code = h._mjs_playOpts.code; }
    if (h._mjs_playOpts.spectator) { payload.spectator = true; }
    h._mjs_playInFlight = true;
    this.request('µgame:play', payload, { waitForOpen: true }).then(
      function(frame) { h._mjs_playInFlight = false; self._mjs_onPlayResolved(h, frame); },
      function(err) { h._mjs_playInFlight = false; self._mjs_onPlayRejected(h, err); }
    );
  };

  // l'ack ({attente:n} ou assis) et une éventuelle poussée µgame:start (cf. _mjs_onGameStartPush) sont
  // DEUX flux indépendants sur le fil : rien ne garantit que cet ack revienne AVANT le µgame:start
  // qui complète la file (le start peut le devancer). `h._partieId != null` =
  // déjà assise par cette poussée : un ack {attente} ARRIVÉ EN RETARD ne doit JAMAIS faire régresser
  // le statut en arrière ('playing' → 'waiting').
  MjsSocket.prototype._mjs_onPlayResolved = function(h, frame) {
    if (h._mjs_status === 'left') { return; }
    if (h._mjs_gameId != null) { return; }
    if (frame && typeof frame.queue === 'number') {
      h._mjs_status = 'waiting';
      h._mjs_queue = frame.queue;
      _syncGameStore(h);
      return;
    }
    this._mjs_seatFresh(h, frame, 'start');
  };

  MjsSocket.prototype._mjs_onPlayRejected = function(h, err) {
    var i;
    if (h._mjs_status === 'left') { return; }
    if (h._mjs_gameId != null) { return; }   // déjà assise par une poussée µgame:start entre-temps — refus périmé
    if (err && typeof err === 'object' && err.code) { return; }   // transport — laisse la reconnexion retenter
    i = this._mjs_gamesPending.indexOf(h);
    if (i !== -1) { this._mjs_gamesPending.splice(i, 1); }
    _failGame(h, String(err));
  };

  // 1re assise d'une poignée (réponse directe de play OU complétion de file poussée à un AUTRE
  // siège, cf. _mjs_onGameStartPush) : sort de _mjs_gamesPending, entre dans _mjs_games, événement 'start'.
  MjsSocket.prototype._mjs_seatFresh = function(h, frame, evt) {
    var i = this._mjs_gamesPending.indexOf(h);
    if (i !== -1) { this._mjs_gamesPending.splice(i, 1); }
    _applyFullFrame(h, frame);
    if (_mjs_safeKey(frame.game)) { this._mjs_games[frame.game] = h; }
    _dispatchGame(h, evt, frame);
  };

  // --- poussées serveur (µgame:state/seat/event/end/left, µgame:start déjà assis) -------------
  MjsSocket.prototype._mjs_onGameStatePush = function(frame) {
    var h = this._mjs_games[frame.game];
    if (!h) { return; }
    if (!_applyStatePush(h, frame)) { return; }
    _dispatchGame(h, 'state', frame);
  };

  MjsSocket.prototype._mjs_onGameStartPush = function(frame) {
    var h = this._mjs_games[frame.game], next;
    if (h) {
      if (!_applyFullFrame(h, frame)) { return; }
      _dispatchGame(h, 'start', frame);
      return;
    }
    if (this._mjs_gamesPending.length === 0) { return; }   // poussée orpheline — rien à quoi rattacher
    next = this._mjs_gamesPending[0];
    this._mjs_seatFresh(next, frame, 'start');
  };

  MjsSocket.prototype._mjs_onGameSeatPush = function(frame) {
    var h = this._mjs_games[frame.game];
    if (!h) { return; }
    h._mjs_seats = frame.seats;
    _syncGameStore(h);
    _dispatchGame(h, 'seat', frame);
  };

  MjsSocket.prototype._mjs_onGameEventPush = function(frame) {
    var h = this._mjs_games[frame.game];
    if (!h) { return; }
    _dispatchGame(h, 'event', frame);
  };

  MjsSocket.prototype._mjs_onGameEndPush = function(frame) {
    var h = this._mjs_games[frame.game];
    if (!h) { return; }
    h._mjs_status = 'finished';
    h._mjs_result = frame.result;
    _syncGameStore(h);
    _dispatchGame(h, 'end', frame);
    delete this._mjs_games[frame.game];   // terminal : plus rien à resynchroniser après coupure
  };

  MjsSocket.prototype._mjs_onGameLeftPush = function(frame) {
    var h = this._mjs_games[frame.game];
    if (!h) { return; }
    _dispatchGame(h, 'left', frame);
  };

  // mode lockstep —forward BRUT (pas de dédup/reconstruction de store, contrairement
  // aux autres poussées ci-dessus) : {partie, tick, ordres} tel quel, cf. commentaire de _mjs_ensureGameWiring
  MjsSocket.prototype._mjs_onGameOrdersPush = function(frame) {
    var h = this._mjs_games[frame.game];
    if (!h) { return; }
    _dispatchGame(h, 'orders', frame);
  };

  // --- resync (reconnexion) --------------------------------------------------------------------
  MjsSocket.prototype._mjs_resyncGame = function(h) {
    var self = this;
    this.request('µgame:resync', { game: h._mjs_gameId }, { waitForOpen: true }).then(
      function(frame) { self._mjs_onResyncResolved(h, frame); },
      function(err) { self._mjs_onResyncRejected(h, err); }
    );
  };

  MjsSocket.prototype._mjs_onResyncResolved = function(h, frame) {
    if (h._mjs_status === 'left') { return; }
    if (!_applyFullFrame(h, frame)) { return; }
    if (_mjs_safeKey(frame.game)) { this._mjs_games[frame.game] = h; }
    _dispatchGame(h, 'state', frame);
  };

  MjsSocket.prototype._mjs_onResyncRejected = function(h, err) {
    if (h._mjs_status === 'left') { return; }
    if (err && typeof err === 'object' && err.code) { return; }   // transport — une future reconnexion retentera
    delete this._mjs_games[h._mjs_gameId];
    _failGame(h, String(err));
  };

  // au µ:welcome (reconnexion — mêmes détecteurs que le re-abonnement stream/presence de
  // mjs_socket.ts::_mjs_onWelcome) : parties DÉJÀ assises → resync ; parties encore en file → rejeu
  // de play (la file ne survit pas à la coupure côté serveur, cf. tête de fichier). `_mjs_playInFlight`
  // exclut une poignée dont le TOUT PREMIER play est encore en vol (cf. commentaire de _mjs_sendPlay) —
  // sinon CE MÊME welcome (celui qui vient de le laisser partir via _mjs_pendingOpenReqs) le rejouerait en double.
  MjsSocket.prototype._mjs_onGameWelcome = function() {
    var id, h, pending, i;
    for (id in this._mjs_games) {
      h = this._mjs_games[id];
      // anti-triche — un spectateur n'a AUCUN siège à retrouver (mjs-server/game.ts::
      // _resync rattache par IDENTITÉ, un spectateur n'y a jamais été indexé) : un resync tenté
      // pour lui échouerait TOUJOURS côté serveur (« vous n'êtes pas dans cette partie ») et le
      // ferait basculer en statut 'error' pour de mauvaises raisons — jamais tenté ici.
      if (h._mjs_status === 'playing' && !h._mjs_spectator) { this._mjs_resyncGame(h); }
    }
    pending = this._mjs_gamesPending.slice();
    for (i = 0; i < pending.length; i++) {
      if (!pending[i]._mjs_playInFlight) { this._mjs_sendPlay(pending[i]); }
    }
  };

  // --- move / leave --------------------------------------------------------------------------
  MjsSocket.prototype._mjs_gameMove = function(h, name, p) {
    var payload;
    if (!h._mjs_gameId) {
      return Promise.reject({ code: 'not-seated', message: "partie pas encore assise (statut '" + h._mjs_status + "')" });
    }
    payload = { game: h._mjs_gameId, move: name };
    if (p !== undefined) { payload.p = p; }
    return this.request('µgame:move', payload).then(function(ack) { return ack.result; });
  };

  MjsSocket.prototype._mjs_gameLeave = function(h) {
    var gameId, i;
    if (h._mjs_status === 'left') { return; }
    gameId = h._mjs_gameId;
    i = this._mjs_gamesPending.indexOf(h);
    if (i !== -1) { this._mjs_gamesPending.splice(i, 1); }
    if (gameId != null) { delete this._mjs_games[gameId]; }
    h._mjs_status = 'left';
    h._mjs_queue = null;
    _syncGameStore(h);
    if (gameId != null) {
      this.request('µgame:leave', { game: gameId }).then(function() {}, function() {});
    }
  };

}
