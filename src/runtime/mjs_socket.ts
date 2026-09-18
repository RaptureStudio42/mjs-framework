// mjs_socket — couche WebSocket réactive (protocole temps réel v1).
//
//   sock = µ.socket("wss://jeu/play", { auth: -> { token: $$session.token } })
//   sock.state / sock.latency / sock.connected / sock.lastError / sock.resumed   # réactifs
//   off = sock.on(type, (p) -> …) ; sock.send(type, p)
//   await sock.request(type, p, {timeout})
//   $$x = sock.stream(type) ; $$j = sock.presence(room?) ; zone = sock.room(name)
//   sock.on('welcome', (p) -> …) ; sock.resumed   # accueil serveur + reprise ('welcome' réservé)
//   sock.on('denied', (p) -> …)                   # auth refusée, fil fermé pour de bon ('denied' réservé)
//
// Singleton par URL (référence-compté). Connexion paresseuse. `open` n'est
// atteint qu'après le handshake µ:welcome. Trames de contrôle préfixe `µ:`.

// tempête de reconnexion — durée de connexion TENUE après un
// µ:welcome avant de juger la connexion « stable » et remettre le backoff à zéro (cf. _mjs_onWelcome/
// _mjs_teardown). Sans ce délai, un serveur qui accueille PUIS coupe aussitôt (surcharge, bug, attaque)
// faisait retomber `_mjs_attempt` à 0 à CHAQUE cycle — le backoff `[500,1000,2000,5000]` n'escaladait
// alors jamais, indéfiniment (pilonnage au palier le plus court).
var MJSOCKET_STABLE_MS = 2000;

µ._mjs_sockets = µ._mjs_sockets || {};

µ.socket = function(url, opts) {
  var existing = µ._mjs_sockets[url];
  if (existing && !existing._mjs_destroyed) { existing._mjs_refs++; return existing; }
  var s = new MjsSocket(url, opts || {});
  µ._mjs_sockets[url] = s;
  return s;
};

function MjsSocket(url, opts) {
  this.url = url;
  this.opts = opts;
  this._mjs_refs = 1;
  this._mjs_destroyed = false;
  // état réactif (un seul store interne, exposé via getters)
  // resumed : true si le dernier µ:welcome clôt une reprise de session réussie, false pour un accueil neuf — MàJ par _mjs_onWelcome à chaque welcome
  this._mjs_st = µ.state({ state: 'closed', latency: null, lastError: null, resumed: false });
  this._mjs_ws = null;
  this._mjs_wantOpen = false;       // true = on veut être connecté (≠ close volontaire)
  this._mjs_session = null;         // {id, key} du dernier µ:welcome (serveur MJS-WS avec reprise) — rejoué au prochain µ:hello, purgé sur µ:bye/µ:denied
  this._mjs_handlers = {};          // type -> [fn]
  this._mjs_subs = {};              // type -> true (liste resub envoyée au serveur)
  this._mjs_rooms = {};             // name -> true (re-join auto)
  // join-optimiste — FIFO des noms de salon dont le µ:join vient
  // d'être ENVOYÉ (readyState open, cf. _mjs_sendJoin), pas encore confirmé/refusé. Le protocole
  // n'a AUCUN champ room/code sur µ:error (vérifié dans rooms.ts/core.ts) :
  // impossible de savoir avec certitude à quel salon une erreur générique se rapporte. La FIFO
  // du serveur (core.ts, un message entrant traité en entier avant le suivant) garantit l'ORDRE —
  // le plus ancien salon en attente est la meilleure correspondance dispo, cf. _mjs_onGuardError.
  this._mjs_pendingRoomJoins = [];
  this._mjs_presence = {};          // room(key) -> store réactif
  this._mjs_streams = {};           // type -> { store, lastSeq }
  this._mjs_reqs = {};              // id -> { resolve, reject, timer }
  this._mjs_reqSeq = 0;
  this._mjs_queue = [];             // [{type, payload}] hors-ligne
  this._mjs_queueOverflowWarned = false;   // débordement de _mjs_queue déjà signalé — remis à false au prochain welcome (file vidée)
  this._mjs_pendingOpenReqs = [];   // [{id, type, payload}] request({waitForOpen:true}) en attente d'ouverture
  this._mjs_attempt = 0;
  this._mjs_stableTimer = null;     // minuteur MJSOCKET_STABLE_MS posé par _mjs_onWelcome, annulé par _mjs_teardown
  this._mjs_reconnectTimer = null;
  this._mjs_hbTimer = null;
  // était un slot UNIQUE (`_hbWatchdog`) :
  // vu ci-dessous (_mjs_startHeartbeat), plusieurs watchdogs sont légitimement EN
  // VOL simultanément dès que l'intervalle < 2×intervalle (la config par
  // défaut !) — un slot unique perdait la référence de l'ancien à chaque
  // nouveau ping, le laissant tourner en fantôme. Tableau de TOUS les
  // watchdogs en attente ; un pong reçu les invalide TOUS (la preuve de vie
  // la plus récente rend caduques toutes les échéances antérieures).
  this._mjs_hbWatchdogs = [];
  this._mjs_coalesce = {};          // type -> { payload, scheduled }
  this._mjs_cooldownAt = {};        // type -> timestamp dernier envoi
  this._mjs_debounce = {};          // type -> { payload, timer }
  this._mjs_warnedOpts = {};        // option -> true, un seul µ.warn par option invalide
}

MjsSocket.prototype._mjs_now = function() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
};

// --- propriétés réactives ---
Object.defineProperty(MjsSocket.prototype, 'state',     { get: function() { return this._mjs_st.state; } });
Object.defineProperty(MjsSocket.prototype, 'latency',   { get: function() { return this._mjs_st.latency; } });
Object.defineProperty(MjsSocket.prototype, 'connected', { get: function() { return this._mjs_st.state === 'open'; } });
Object.defineProperty(MjsSocket.prototype, 'lastError', { get: function() { return this._mjs_st.lastError; } });
Object.defineProperty(MjsSocket.prototype, 'resumed',   { get: function() { return this._mjs_st.resumed; } });

MjsSocket.prototype._mjs_setState = function(s) { this._mjs_st.state = s; };

// --- ouverture / handshake ---
MjsSocket.prototype.connect = function() {
  if (this._mjs_destroyed || this._mjs_ws || this.state === 'open') { return this; }
  this._mjs_wantOpen = true;
  this._mjs_open();
  return this;
};

MjsSocket.prototype._mjs_ensure = function() {
  // connexion paresseuse : au 1er on/send/request/stream.
  // pendant `reconnecting`, un
  // `_mjs_reconnectTimer` respecte DÉJÀ le backoff : ne pas le court-circuiter.
  // `connect()` (appel PUBLIC explicite) passe par `_mjs_open()` qui ANNULE ce timer
  // et rouvre IMMÉDIATEMENT — un émetteur continu (position coalescée ~20/s)
  // transformerait alors le backoff [500,1000,2000,5000] en ~20 tentatives/s
  // vers un serveur déjà en difficulté. On respecte la reconnexion programmée ;
  // les messages émis entre-temps alimentent `_mjs_queue` et repartent au welcome.
  if (!this._mjs_ws && this.state !== 'open' && !this._mjs_destroyed && !this._mjs_reconnectTimer) { this.connect(); }
};

MjsSocket.prototype._mjs_open = function() {
  var self = this;
  // Un timer de reconnexion est peut-être en attente (on rouvre via connect() ou
  // le watchdog) : l'annuler, sinon il rappellerait _mjs_open → 2e connexion empilée.
  if (this._mjs_reconnectTimer) { clearTimeout(this._mjs_reconnectTimer); this._mjs_reconnectTimer = null; }
  // Garde anti-double-socket : une connexion vit déjà → on ne la double pas.
  if (this._mjs_ws) { return; }
  if (this.state !== 'reconnecting') { this._mjs_setState('connecting'); }
  var ws;
  try { ws = new WebSocket(this.url, this.opts.protocols); }
  catch (e) {
    // le CONSTRUCTEUR qui jette =
    // URL syntaxiquement invalide : erreur DÉTERMINISTE, jamais un aléa réseau.
    // L'ancien `_mjs_onClose({code:1006})` enclenchait le cycle de reconnexion
    // standard → boucle INFINIE (plafond 5 s) sur une opération qui ne peut
    // JAMAIS réussir. On abandonne (bug de dev, signalé) au lieu de réessayer.
    this._mjs_wantOpen = false;
    this._mjs_st.lastError = { code: 'badurl', message: String((e && e.message) || e) };
    µ.error('[µ.socket] URL invalide, connexion abandonnée : ' + this.url, e);
    this._mjs_setState('closed');
    return;
  }
  this._mjs_ws = ws;
  // µschema (mjs_schema.ts) — extension MINIME : ArrayBuffer plutôt que Blob
  // pour les trames binaires entrantes (accès synchrone aux octets, cf. µ._mjs_mjschemaOnBinary plus bas
  // dans _mjs_onMessage) — sans incidence sur le texte JSON existant (readyState/onmessage inchangés pour
  // toute trame string).
  ws.binaryType = 'arraybuffer';
  ws.onopen    = function()   { self._mjs_onOpen(); };
  ws.onmessage = function(ev) { self._mjs_onMessage(ev); };
  ws.onclose   = function(ev) { self._mjs_onClose(ev || {}); };
  ws.onerror   = function(ev) { self._mjs_st.lastError = { code: 'ws', message: 'erreur socket' }; };
};

MjsSocket.prototype._mjs_onOpen = function() {
  var self = this;
  var hello = function(auth) {
    var p = {
      auth: auth, protocol: 1,
      resub: Object.keys(self._mjs_subs),
      rooms: Object.keys(self._mjs_rooms)
    };
    // reprise de session (serveur MJS-WS opt-in) : {id, key} du dernier µ:welcome —
    // la clé prouve « même session », l'auth ci-dessus reste re-vérifiée par le serveur.
    // Jamais posé face à un serveur sans reprise (_mjs_session reste null) : clé ABSENTE du JSON.
    if (self._mjs_session) { p.session = self._mjs_session; }
    // µschema (mjs_schema.ts) — extension MINIME : hash du registre CLIENT
    // COURANT (même vide — cf. µ._mjs_mjschemaHelloHash, un hash ABSENT ferait taire le serveur pour de
    // bon, cf. mjs-ws/core.ts::pushSchemaIfMismatch) — permet au serveur de détecter un désaccord et
    // pousser µ:schema en retour.
    if (µ._mjs_mjschemaHelloHash) { p.schemaHash = µ._mjs_mjschemaHelloHash(); }
    self._mjs_rawSend({ t: 'µ:hello', p: p });
  };
  var a = this.opts.auth;
  if (typeof a === 'function') {
    var r;
    try { r = a(); } catch (e) { r = undefined; }
    if (r && typeof r.then === 'function') { r.then(hello, function() { hello(undefined); }); }
    else { hello(r); }
  } else { hello(a); }
  // on reste 'connecting' jusqu'au µ:welcome
};

MjsSocket.prototype._mjs_onWelcome = function(msg) {
  // reprise de session (MJS-WS, opt-in serveur) : le µ:welcome porte session {id, key}
  // — clé TOURNÉE à chaque welcome, on garde toujours la plus récente. Serveur sans reprise :
  // champ absent, _mjs_session reste null, le hello n'en parlera jamais. Rien d'autre ne change.
  if (msg.p && msg.p.session) { this._mjs_session = msg.p.session; }
  // sock.resumed (public, cf. constructeur) : reflète CE welcome — jamais true face à un
  // serveur sans reprise (`msg.p.resumed` absent → strictement !== true → false).
  this._mjs_st.resumed = (msg.p && msg.p.resumed) === true;
  // tempête de reconnexion — un serveur qui accueille PUIS coupe aussitôt ne doit jamais
  // faire retomber le backoff au palier minimal à CHAQUE cycle : `_mjs_attempt` n'est remis à zéro
  // qu'après MJSOCKET_STABLE_MS de connexion TENUE depuis CE welcome, jamais au welcome brut —
  // le minuteur est annulé par _mjs_teardown() si la connexion tombe avant (cf. son commentaire).
  if (this._mjs_stableTimer) { clearTimeout(this._mjs_stableTimer); }
  var __self = this;
  this._mjs_stableTimer = setTimeout(function() { __self._mjs_attempt = 0; __self._mjs_stableTimer = null; }, MJSOCKET_STABLE_MS);
  this._mjs_setState('open');
  this._mjs_st.lastError = null;
  this._mjs_startHeartbeat();
  // abonnements stream/presence/room
  // perdus en connexion PARESSEUSE : `stream()`/`presence()`/`room()`
  // envoient leur message dédié (`µ:sub-stream`/`µ:sub-presence`/`µ:join`)
  // IMMÉDIATEMENT via `_mjs_rawSend()`, qui échoue SILENCIEUSEMENT si le WebSocket
  // n'est pas encore 'open' (`readyState !== 1`) — le cas le PLUS courant :
  // le 1er appel à l'un de ces 3 crée le socket via `_mjs_ensure()`/`connect()`,
  // qui reste 'connecting' pendant tout le round-trip réseau + handshake
  // µ:hello/µ:welcome. Contrairement à `send()` (dont les envois ratés sont
  // mis en `_mjs_queue` et rejoués ici, juste en dessous), ces 3 messages
  // dédiés n'avaient AUCUN filet — silencieusement perdus, jamais rejoués.
  // Le `µ:hello` (envoyé dans `_mjs_onOpen`, avant ce welcome) transmet bien
  // `resub`/`rooms` en NOMS, mais ce sont des champs d'INTENTION générique
  // — les messages dédiés ci-dessous restent la voie EXPLICITE que le
  // serveur attend réellement (la MÊME que le tout premier abonnement),
  // donc la plus fiable pour re-livrer l'état après CHAQUE (re)connexion,
  // pas seulement la première.
  // un stream déjà entamé
  // (`lastSeq > 0`) qui se RE-abonne après une reconnexion envoyait le MÊME
  // `µ:sub-stream` qu'un tout premier abonnement — aucune indication au
  // serveur de « je suis déjà à la séquence N ». Les deltas survenus PENDANT
  // la déconnexion sont donc soit reperdus (si le serveur reprend le flux
  // "à partir de maintenant"), soit re-livrés en double (si le serveur
  // renvoie tout depuis le début) — comportement dépendant du serveur, dans
  // les deux cas incohérent avec le contrat déjà établi par `_mjs_onStreamDelta`
  // (détection de trou EN COURS DE FLUX, qui envoie déjà `µ:resync` avec
  // `from: lastSeq`, cf. plus bas). Fix : même message, même contrat, à la
  // reconnexion — un stream qui a déjà vu au moins un delta redemande
  // EXPLICITEMENT la suite depuis sa dernière séquence connue ; seul un
  // stream JAMAIS entamé (lastSeq encore à 0) garde le `µ:sub-stream` nu
  // (rien à resynchroniser). `resyncing = true` posé ici aussi : évite un
  // 2e `µ:resync` redondant si le tout premier delta post-reconnexion
  // ressemble par ailleurs à un trou (même garde anti-rafale que le chemin
  // existant).
  for (var __st in this._mjs_streams) {
    var __stObj = this._mjs_streams[__st];
    if (__stObj.lastSeq) {
      __stObj.resyncing = true;
      this._mjs_rawSend({ t: 'µ:resync', p: { stream: __st, from: __stObj.lastSeq } });
    } else {
      this._mjs_rawSend({ t: 'µ:sub-stream', p: { stream: __st } });
    }
  }
  for (var __pk in this._mjs_presence) { this._mjs_rawSend({ t: 'µ:sub-presence', p: { room: __pk || undefined } }); }
  // join-optimiste — _mjs_sendJoin (pas _mjs_rawSend direct) : chaque re-join
  // post-reconnexion peut LUI AUSSI être refusé par la garde (permissions changées entre-temps),
  // doit donc entrer dans la même FIFO d'attente que le tout premier join, cf. room()/_mjs_onGuardError.
  for (var __rm in this._mjs_rooms) { this._mjs_sendJoin(__rm); }
  // vider la file hors-ligne — `_mjs_queueOverflowWarned` repart à false : un débordement
  // futur (nouvelle connexion) redevient un épisode NEUF, à signaler à nouveau une seule fois.
  var q = this._mjs_queue; this._mjs_queue = []; this._mjs_queueOverflowWarned = false;
  for (var i = 0; i < q.length; i++) { this._mjs_rawSend({ t: q[i].type, p: q[i].payload }); }
  // envoie enfin pour de VRAI les
  // request({waitForOpen:true}) émises avant que la connexion ne soit prête
  // (cf. request()) : avant ce fix, rien ne les relayait ici, contrairement
  // à la file `_mjs_queue` de send() juste au-dessus — elles finissaient
  // TOUJOURS par expirer sur leur propre timeout, jamais transmises.
  var pend = this._mjs_pendingOpenReqs; this._mjs_pendingOpenReqs = [];
  for (var __pi = 0; __pi < pend.length; __pi++) {
    var __pr = pend[__pi];
    if (this._mjs_reqs[__pr.id]) { this._mjs_rawSend({ t: __pr.type, p: __pr.payload, id: __pr.id }); }
  }
  // 'welcome' = nom d'événement RÉSERVÉ côté client : `on('welcome', cb)` réutilise le MÊME
  // registre/`_mjs_dispatch` que n'importe quel autre type pub/sub (pas de canal parallèle) — un
  // message applicatif serveur littéralement nommé `welcome` déclencherait donc les MÊMES
  // handlers. Charge = copie SUPERFICIELLE de `msg.p` SANS `session` (plomberie interne de la
  // reprise, id+clé n'ont rien à faire dans les mains de l'appli) ; `resumed` (posé ci-dessus
  // sur `this._mjs_st.resumed`) passe tel quel, comme tout autre champ ajouté par `welcome()` serveur.
  // Dispatché EN DERNIER : l'appli ne doit voir qu'un socket déjà opérationnel (session posée,
  // état 'open', heartbeat démarré, re-abonnements + rejeu de file + rejeu waitForOpen faits
  // ci-dessus). `_mjs_dispatch` protège déjà chaque handler individuellement (try/catch) : un
  // handler qui throw ne casse jamais la suite.
  var __wp = {};
  if (msg.p) { for (var __wk in msg.p) { if (__wk !== 'session') { __wp[__wk] = msg.p[__wk]; } } }
  this._mjs_dispatch('welcome', { t: 'welcome', p: __wp });
};

MjsSocket.prototype._mjs_onDenied = function(msg) {
  this._mjs_st.lastError = (msg.p) || { message: 'denied' };
  this._mjs_wantOpen = false;          // auth invalide → inutile de réessayer
  this._mjs_session = null;            // fin définitive — une session ne survit jamais à un refus
  // Annule un reconnect éventuellement programmé : on abandonne définitivement.
  if (this._mjs_reconnectTimer) { clearTimeout(this._mjs_reconnectTimer); this._mjs_reconnectTimer = null; }
  this._mjs_teardown(true);           // fin définitive → rejette AUSSI les waitForOpen en attente
  this._mjs_pendingOpenReqs = [];
  this._mjs_setState('closed');
  // 'denied' = 2e nom d'événement RÉSERVÉ côté client, exactement comme 'welcome' juste au-dessus
  // (même registre, même `_mjs_dispatch`, même réserve : un message applicatif serveur littéralement
  // nommé `denied` déclencherait les mêmes handlers).
  //
  // famille « garde muette » — sans lui, le refus était SANS VOIX : les trois
  // lignes du dessus ferment le fil DÉFINITIVEMENT (plus de `_mjs_wantOpen`, minuteur de reconnexion
  // annulé) et rien ne le disait à l'appli, alors que l'en-tête de `refresh()` lui confie justement
  // le soin de décider quand renouveler son jeton. Il ne lui restait que `state`, dont la lecture
  // ne s'abonne PAS depuis tous les chemins d'effet (`_mjs_runEffectsV2` est appelé sans
  // `µ.activeComponent` sur le chemin rapide de `_mjs_invalidate`, mjs_element.ts) : un rattrapage
  // bâti dessus pouvait ne jamais se déclencher, sans un mot. Un signal qui part toujours vaut
  // mieux qu'un état qu'on observe parfois.
  //
  // Dispatché EN DERNIER, pour la même raison que 'welcome' : le socket est déjà au repos quand le
  // handler tourne, donc un `sock.connect()` appelé depuis là rouvre pour de bon. `_mjs_dispatch`
  // protège chaque handler (try/catch) — un handler qui jette ne casse rien.
  this._mjs_dispatch('denied', { t: 'denied', p: this._mjs_st.lastError });
};

MjsSocket.prototype._mjs_onMessage = function(ev) {
  var msg;
  // µschema (mjs_schema.ts) — extension MINIME : une trame BINAIRE (jamais du
  // JSON valide, cf. binaryType posé dans _mjs_open) ne passe JAMAIS par JSON.parse — décodée par le hook
  // µ._mjs_mjschemaOnBinary si le module 'schema' est chargé, sinon ignorée (comportement historique :
  // avant µschema, une trame binaire n'était de toute façon jamais interprétée).
  if (ev.data && typeof ev.data !== 'string') {
    if (µ._mjs_mjschemaOnBinary) { µ._mjs_mjschemaOnBinary(this, ev.data); }
    return;
  }
  try { msg = (this.opts.parse || JSON.parse)(ev.data); } catch (e) { return; }
  // JSON.parse('null')/('42')/('"x"') renvoie une valeur non-objet → `msg.t`
  // lèverait (null.t) ou serait undefined : on jette proprement le message.
  if (!msg || typeof msg !== 'object') { return; }
  switch (msg.t) {
    case 'µ:welcome': return this._mjs_onWelcome(msg);
    case 'µ:denied':  return this._mjs_onDenied(msg);
    case 'µ:pong':
      // `msg.p.ts` absent/non-numérique
      // (trame malformée ou serveur qui echo autre chose que le `ts` reçu)
      // produisait un `NaN`/négatif propagé TEL QUEL dans `latency`, un champ
      // RÉACTIF exposé au développeur (`sock.latency`) — un "ping: NaNms"
      // affiché à l'écran. Le `_mjs_petWatchdog()` reste, lui, INCONDITIONNEL :
      // recevoir NE SERAIT-CE QU'un pong malformé prouve déjà que la
      // connexion est vivante (le but même du watchdog), indépendamment de
      // la qualité de son contenu.
      // typer `ts` À LA SOURCE :
      // `msg.p = null` faisait `now - null === now` (positif → assigné à vie),
      // et `ts: true` → `now - 1` — `sock.latency` (champ réactif exposé)
      // affichait alors le temps écoulé depuis le chargement de la page. On
      // n'accepte QU'un `ts` numérique. `_mjs_petWatchdog()` reste INCONDITIONNEL :
      // un pong même malformé prouve que la connexion est vivante.
      var __ts = msg.p && msg.p.ts;
      if (typeof __ts === 'number') {
        var __lat = this._mjs_now() - __ts;
        if (isFinite(__lat) && __lat >= 0) { this._mjs_st.latency = __lat; }
      }
      this._mjs_petWatchdog();
      return;
    case 'µ:ack':     return this._mjs_onAck(msg);
    case 'µ:error':   this._mjs_st.lastError = msg.p || { message: 'error' }; this._mjs_onGuardError(); return;
    case 'µ:presence':return this._mjs_onPresence(msg);
    case 'µ:left':    return this._mjs_onLeft(msg);
    // µschema (mjs_schema.ts) — extension MINIME : remplace le registre
    // CLIENT, cf. µ._mjs_mjschemaOnPush (absent si le module 'schema' n'est pas chargé → no-op, trame
    // ignorée comme n'importe quel autre type µ: inconnu l'aurait été avant l'ajout de µschema).
    case 'µ:schema':  if (µ._mjs_mjschemaOnPush) { µ._mjs_mjschemaOnPush(this, msg); } return;
    case 'µ:bye':     this._mjs_st.lastError = msg.p || null; this._mjs_wantOpen = false; this._mjs_session = null; if (this._mjs_reconnectTimer) { clearTimeout(this._mjs_reconnectTimer); this._mjs_reconnectTimer = null; } this._mjs_teardown(true); this._mjs_pendingOpenReqs = []; this._mjs_setState('closed'); return;
  }
  // delta de stream ? (ne tombe PAS aussi dans les handlers pub/sub)
  if (this._mjs_streams[msg.t]) { return this._mjs_onStreamDelta(msg.t, msg); }
  // pub/sub
  this._mjs_dispatch(msg.t, msg);
};

MjsSocket.prototype._mjs_onClose = function(ev) {
  this._mjs_teardown();
  if (ev && ev._err) { this._mjs_st.lastError = { code: 'ws', message: String(ev._err && ev._err.message || ev._err) }; }
  // session exclusive par identité (serveur MJS-WS opt-in, mjs-ws/core.ts, DEUX modes) — codes
  // 4003 ('replace' : CE client a été REMPLACÉ par une connexion neuve de la MÊME identité) et
  // 4004 ('refuse' : CE hello a été REFUSÉ, une session vivante de la MÊME identité existait déjà)
  // sont TOUS DEUX TERMINAUX même si la trame applicative (`µ:bye`/`µ:denied`) s'est perdue en
  // route (leurs handlers respectifs l'auraient déjà fait, cf. _mjs_onDenied plus haut / le cas
  // 'µ:bye' de _mjs_onMessage) — SANS ce filet, `_mjs_wantOpen` resterait vrai et la ligne du dessous
  // reconnecterait aussitôt : le serveur re-refuserait/re-remplacerait de la même façon →
  // ping-pong infini entre les deux onglets. `lastError` : préserve la charge de la trame
  // applicative si déjà reçue, sinon repli DISTINCT par code (replaced/refused).
  if (ev && (ev.code === 4003 || ev.code === 4004)) {
    this._mjs_wantOpen = false;
    this._mjs_session = null;
    if (!this._mjs_st.lastError) { this._mjs_st.lastError = { code: ev.code === 4003 ? 'replaced' : 'refused' }; }
  }
  if (this._mjs_wantOpen && !this._mjs_destroyed) { this._mjs_scheduleReconnect(); }
  else { this._mjs_setState('closed'); }
};

MjsSocket.prototype._mjs_teardown = function(final) {
  // une connexion qui tombe AVANT d'être jugée stable ne doit jamais réinitialiser le
  // backoff en douce — annule le minuteur de stabilité posé par _mjs_onWelcome, sur TOUTE fin de vie
  // de la connexion (reconnexion, fermeture volontaire, denied, µ:bye — seul choke point commun).
  if (this._mjs_stableTimer) { clearTimeout(this._mjs_stableTimer); this._mjs_stableTimer = null; }
  if (this._mjs_ws) {
    this._mjs_ws.onopen = this._mjs_ws.onmessage = this._mjs_ws.onclose = this._mjs_ws.onerror = null;
    try { this._mjs_ws.close(); } catch (e) {}
    this._mjs_ws = null;
  }
  this._mjs_stopHeartbeat();
  // join-optimiste — la FIFO d'attente ne survit PAS à cette
  // connexion : un µ:join en vol dessus ne recevra plus jamais SA réponse (onmessage coupé
  // juste au-dessus). Sans ce reset, une entrée PÉRIMÉE traînerait devant la FIFO et se ferait
  // pop par erreur par le premier µ:error de la PROCHAINE connexion — _mjs_onWelcome réarme une
  // entrée fraîche pour chaque salon encore dans _mjs_rooms via _mjs_sendJoin, cf. plus haut.
  this._mjs_pendingRoomJoins = [];
  // teardown incomplet : les request()
  // en attente d'un `µ:ack` sur ce socket ne seront JAMAIS ack'ées (le serveur
  // ne reverra jamais leur id, et une reconnexion = nouvelle poignée de main
  // sans mémoire des ids précédents) → on les rejette ici, plus vite et plus
  // exactement que leur timeout individuel.
  // EXCEPTION : une requête
  // `waitForOpen` encore dans `_mjs_pendingOpenReqs` n'a JAMAIS été transmise sur
  // ce socket (inscrite dans `_mjs_reqs` dès `request()`, mais en attente
  // d'ouverture). Un simple échec de TENTATIVE (`_mjs_onClose`, `final` absent) ne
  // doit PAS la rejeter : son timeout individuel reste l'arbitre et `_mjs_onWelcome`
  // la renverra après reconnexion (le fix `waitForOpen` redevenait sinon
  // inopérant dès qu'UNE tentative échouait). Seule une fin de vie DÉFINITIVE
  // (`final` : close/destroy/denied/bye) rejette TOUT.
  var spared = {};
  if (!final && this._mjs_pendingOpenReqs) {
    for (var __pi = 0; __pi < this._mjs_pendingOpenReqs.length; __pi++) { spared[this._mjs_pendingOpenReqs[__pi].id] = true; }
  }
  var reqs = this._mjs_reqs;
  this._mjs_reqs = {};
  for (var __id in reqs) {
    if (spared[__id]) { this._mjs_reqs[__id] = reqs[__id]; continue; } // épargnée : ré-inscrite pour _mjs_onWelcome
    var __r = reqs[__id];
    if (__r.timer) { clearTimeout(__r.timer); }
    try { __r.reject({ code: 'closed', message: 'connexion fermée avant réponse du serveur' }); } catch (e) {}
  }
};

MjsSocket.prototype._mjs_scheduleReconnect = function() {
  var rc = this.opts.reconnect || {};
  if (rc.enabled === false) { this._mjs_setState('closed'); return; }
  var max = (rc.retries != null) ? rc.retries : Infinity;
  if (this._mjs_attempt >= max) { this._mjs_setState('closed'); return; }
  var backoff = rc.backoff || [500, 1000, 2000, 5000];
  var base = backoff[Math.min(this._mjs_attempt, backoff.length - 1)];
  var jitter = (rc.jitter != null) ? rc.jitter : 0.3;
  var delay = base * (1 + (Math.random() * 2 - 1) * jitter);
  if (delay < 0) { delay = 0; }
  this._mjs_attempt++;
  this._mjs_setState('reconnecting');
  var self = this;
  this._mjs_reconnectTimer = setTimeout(function() { self._mjs_open(); }, delay);
};

// --- envoi bas niveau ---
MjsSocket.prototype._mjs_rawSend = function(obj) {
  if (this._mjs_ws && this._mjs_ws.readyState === 1) {
    try {
      // µschema (mjs_schema.ts) — extension MINIME : un frame ADMISSIBLE
      // (type schématisé, pas de coupe-circuit binary:false, jamais un id/seq, jamais une trame µ:
      // de contrôle, cf. µ._mjs_mjschemaEncode) part en BINAIRE ; sinon comportement HISTORIQUE inchangé
      // (JSON) — même choke point unique que sendRaw côté serveur (mjs-ws/core.ts).
      var __bin = µ._mjs_mjschemaEncode ? µ._mjs_mjschemaEncode(this, obj) : null;
      this._mjs_ws.send(__bin || (this.opts.serialize || JSON.stringify)(obj));
      return true;
    }
    catch (e) { return false; }
  }
  return false;
};

// --- pub/sub ---
// `opts.owner` : dé-abonnement automatique à la destruction du owner —
// MÊME mécanisme que `µ.smooth` (mjs_smooth.ts), un appelant de plus de `_mjs_onDestroy`
// (mjs_element.ts), pas de nouveau canal. Sans owner, comportement inchangé.
MjsSocket.prototype.on = function(type, handler, opts) {
  this._mjs_ensure();
  (this._mjs_handlers[type] || (this._mjs_handlers[type] = [])).push(handler);
  this._mjs_subs[type] = true;
  var self = this;
  var unsub = function() { self.off(type, handler); };
  if (opts && opts.owner && typeof opts.owner._mjs_onDestroy === 'function') { opts.owner._mjs_onDestroy(unsub); }
  return unsub;
};

MjsSocket.prototype.off = function(type, handler) {
  var hs = this._mjs_handlers[type];
  if (!hs) { return; }
  if (handler) {
    var i = hs.indexOf(handler);
    if (i >= 0) { hs.splice(i, 1); }
  } else { hs.length = 0; }
  if (hs.length === 0) { delete this._mjs_handlers[type]; delete this._mjs_subs[type]; }
};

MjsSocket.prototype._mjs_dispatch = function(type, msg) {
  var hs = this._mjs_handlers[type];
  if (!hs) { return; }
  var copy = hs.slice();
  for (var i = 0; i < copy.length; i++) {
    try { copy[i](msg.p, msg); } catch (e) { µ.error('[µ.socket] handler', e); }
  }
};

// --- envoi applicatif (+ anti-spam) ---
// normalise `debounce`/`coalesce` : `true`→défaut du socket ; nombre ou
// chaîne numérique non vide (`'300'`, `' 45 '`)→clampée ≥0 (négatif ramené à 0, aucun
// TimeoutNegativeWarning) ; `false`/`null`/absent→null (option absente, silence total) ;
// toute autre valeur (`'abc'`, objet)→null + UN SEUL `µ.warn` par socket et par option
// (clé `this._mjs_warnedOpts`) — avant ce correctif une chaîne perdait l'anti-rebond EN
// SILENCE (retombait tout droit sur _mjs_sendNow), même travers falsy que l'ancien `debounce: 0`
MjsSocket.prototype._mjs_normWait = function(value, defaultMs, name) {
  if (value === true) { return defaultMs; }
  if (value === false || value == null) { return null; }
  var n = value;
  if (typeof n === 'string') { n = n.trim(); n = (n === '') ? NaN : Number(n); }
  if (typeof n === 'number' && !isNaN(n)) { return (n < 0) ? 0 : n; }
  if (!this._mjs_warnedOpts[name]) {
    this._mjs_warnedOpts[name] = true;
    µ.warn('[µ.socket] option ' + name + ' ignorée : valeur invalide ' + JSON.stringify(value));
  }
  return null;
};

MjsSocket.prototype.send = function(type, payload, opts) {
  this._mjs_ensure();
  // même normalisation que debounce/coalesce (_mjs_normWait) — AVANT ce correctif, une valeur
  // non numérique ('abc') comparait (now-last) < NaN, TOUJOURS faux : le cooldown se désactivait
  // en silence. `_mjs_normWait` clampe ≥0 et avertit UNE fois sur une valeur vraiment invalide.
  var cd = this._mjs_normWait(opts && opts.cooldown, 0, 'cooldown');
  if (cd != null && cd > 0) {
    var last = this._mjs_cooldownAt[type];
    var now = this._mjs_now();
    // 1er envoi (last indéfini) → toujours autorisé ; sinon au plus 1/cooldown ms
    if (last != null && (now - last) < cd) { return false; }   // trop tôt → on jette
    this._mjs_cooldownAt[type] = now;
  }
  // ordre inchangé cooldown → debounce → coalesce ; _mjs_normWait rend toujours soit null
  // (option absente ou invalide) soit un nombre déjà clampé ≥0
  var db = this._mjs_normWait(opts && opts.debounce, this.opts.debounceMs || 200, 'debounce');
  if (db != null) { return this._mjs_debounceSend(type, payload, db); }   // attend le silence, coalesce ignoré si présent
  var co = this._mjs_normWait(opts && opts.coalesce, this.opts.coalesceMs || 50, 'coalesce');
  if (co != null) { return this._mjs_coalesceSend(type, payload, co); }   // garde la dernière, coalesce:0 = tour de boucle suivant
  return this._mjs_sendNow(type, payload);
};

// sucre — envoi scopé à UN SALON SANS le rejoindre (aucun `µ:join`), contrairement à
// room(name).send() qui joint d'abord (cf. room() plus bas) : utile pour un envoi ponctuel où
// l'abonnement au salon ne sert à rien. Simple préfixe, délègue à send() (mêmes opts cooldown/coalesce).
MjsSocket.prototype.sendTo = function(room, type, payload, opts) {
  return this.send(room + '/' + type, payload, opts);
};

// paramètre `room` mort retiré : aucun
// des 2 appelants (send(), _mjs_coalesceSend()) ne le passait jamais — le
// scoping par salon se fait par PRÉFIXE de type (`room(name)` renvoie un
// proxy dont `send` délègue à `self.send(name + '/' + type, ...)`), pas par
// un champ `room` sur le message. Code mort depuis une itération de design
// antérieure, jamais atteint.
MjsSocket.prototype._mjs_sendNow = function(type, payload) {
  var obj = { t: type, p: payload };
  if (this.state === 'open') { return this._mjs_rawSend(obj); }
  if (this.opts.queueOffline !== false) {
    this._mjs_queue.push({ type: type, payload: payload });
    var maxQ = this.opts.maxQueue || 1000;
    if (this._mjs_queue.length > maxQ) {
      this._mjs_queue.shift();
      // débordement continu → averti UNE SEULE fois (pas par message perdu), lastError
      // réactif renseigné ; remis à zéro au prochain welcome (file vidée, cf. _mjs_onWelcome) — le
      // contrat FIFO borné ne change pas, seul le SIGNAL de la perte apparaît désormais.
      if (!this._mjs_queueOverflowWarned) {
        this._mjs_queueOverflowWarned = true;
        this._mjs_st.lastError = { code: 'queue-overflow', message: 'file hors-ligne pleine (maxQueue=' + maxQ + ') — message le plus ancien perdu' };
        µ.warn('[µ.socket] file hors-ligne pleine (maxQueue=' + maxQ + ') — message le plus ancien perdu');
      }
    }
  }
  return false;
};

MjsSocket.prototype._mjs_coalesceSend = function(type, payload, interval) {
  // intervalle en MILLISECONDES, homogène avec cooldown (l'ancienne unité Hz est morte) ;
  // `true` retombe sur le défaut opts.coalesceMs (50 ms ≈ 20 trames/s)
  var ms   = (typeof interval === 'number') ? interval : (this.opts.coalesceMs || 50);
  var slot = this._mjs_coalesce[type] || (this._mjs_coalesce[type] = { payload: null, scheduled: false, timer: null });
  slot.payload = payload;
  if (!slot.scheduled) {
    slot.scheduled = true;
    var self = this;
    var maxBuf = this.opts.maxBuffered || 65536;
    // id du timer CONSERVÉ (`slot.timer`)
    // pour l'annuler depuis destroy() (sinon _mjs_sendNow() sur socket mort → _mjs_queue
    // orpheline + `self` maintenu vivant par la closure).
    // DURCISSEMENT — contre-pression : sur
    // lien saturé, `bufferedAmount` du navigateur enfle sans limite. Pour des
    // données « dernière position » on préfère SAUTER des trames (le slot garde
    // déjà la dernière valeur, la sémantique coalesce s'y prête) : à l'échéance,
    // si le buffer déborde encore, on retente plus tard SANS envoyer.
    // NB (« leading edge ») : DIFFÉRÉ / PERF-À-BENCHER — un envoi immédiat
    // de la 1ʳᵉ trame dépendait d'un delta de wall-clock (`_mjs_now()`) entre deux
    // `send()` synchrones, non déterministe sous les harnais de timers factices
    // (une pause GC > intervalle faisait repartir la tête). À réintroduire avec
    // une horloge injectable.
    var tick = function() {
      if (self._mjs_ws && self._mjs_ws.bufferedAmount > maxBuf) { slot.timer = setTimeout(tick, ms); return; }
      slot.scheduled = false;
      slot.timer = null;
      self._mjs_sendNow(type, slot.payload);
    };
    slot.timer = setTimeout(tick, ms);
  }
  return true;
};

MjsSocket.prototype._mjs_debounceSend = function(type, payload, wait) {
  // silence de `ms` sur ce type avant émission — contrairement à coalesce (cadence fixe même
  // sous activité continue), ici rien ne part tant que les envois s'enchaînent plus vite que
  // `ms` : chaque nouvel envoi remplace la charge en attente ET remet la minuterie à zéro ;
  // seule la DERNIÈRE charge part, à la première pause de silence — cas du champ de recherche
  // ou du curseur qu'on relâche. `true` retombe sur le défaut opts.debounceMs (200 ms). Même
  // contre-pression que coalesce : bufferedAmount > maxBuf → réessai après `ms`, sans reset
  // de charge.
  var ms   = (typeof wait === 'number') ? wait : (this.opts.debounceMs || 200);
  var slot = this._mjs_debounce[type] || (this._mjs_debounce[type] = { payload: null, timer: null });
  slot.payload = payload;
  if (slot.timer) { clearTimeout(slot.timer); }   // chaque envoi remet le silence à zéro
  var self = this;
  var maxBuf = this.opts.maxBuffered || 65536;
  var tick = function() {
    if (self._mjs_ws && self._mjs_ws.bufferedAmount > maxBuf) { slot.timer = setTimeout(tick, ms); return; }
    slot.timer = null;
    self._mjs_sendNow(type, slot.payload);
  };
  slot.timer = setTimeout(tick, ms);
  return true;
};

// --- heartbeat (placeholder enrichi en 2b) ---
MjsSocket.prototype._mjs_startHeartbeat = function() {
  var ms = (this.opts.heartbeat != null) ? this.opts.heartbeat : 15000;
  if (!ms) { return; }
  var self = this;
  this._mjs_stopHeartbeat();
  this._mjs_hbTimer = setInterval(function() {
    self._mjs_rawSend({ t: 'µ:ping', p: { ts: self._mjs_now() } });
    // AVANT : slot UNIQUE `_hbWatchdog`
    // réassigné à CHAQUE tick, écrasant la RÉFÉRENCE JS sans `clearTimeout`
    // du précédent — le timer natif du cycle d'AVANT continuait de courir en
    // fantôme (orphelin) jusqu'à son propre terme. Comme l'intervalle par
    // défaut (`ms`) est plus COURT que le délai du watchdog (`ms*2`), un
    // 2ᵉ (voire 3ᵉ) ping part TOUJOURS avant l'échéance du 1ᵉʳ watchdog — un
    // `µ:pong` reçu entre-temps n'annulait que le watchdog COURANT
    // (`_mjs_petWatchdog`), jamais le(s) fantôme(s) plus ancien(s) : ils finissaient
    // par fermer une connexion PARFAITEMENT SAINE à leur échéance, malgré un
    // pong reçu depuis. Fix : TOUS les watchdogs en vol sont trackés (tableau,
    // pas un slot) ; `_mjs_petWatchdog` (tout pong) les efface TOUS d'un coup — la
    // preuve de vie la plus récente rend caduques toutes les échéances
    // antérieures, pas seulement la plus proche. (Un simple "clear l'ancien
    // avant de poser le nouveau", essayé puis abandonné : ça désactive
    // ENTIÈREMENT la détection de connexion morte dès que l'intervalle < délai
    // du watchdog, soit la config par défaut — le watchdog n'a alors JAMAIS le
    // temps d'atteindre son échéance avant d'être supplanté par le suivant.)
    var wd = setTimeout(function() {
      // pas de pong → connexion morte → on relance
      if (self._mjs_ws) { self._mjs_onClose({ code: 4000 }); }
    }, ms * 2);
    self._mjs_hbWatchdogs.push(wd);
  }, ms);
};
MjsSocket.prototype._mjs_stopHeartbeat = function() {
  if (this._mjs_hbTimer) { clearInterval(this._mjs_hbTimer); this._mjs_hbTimer = null; }
  this._mjs_clearWatchdogs();
};
// Efface TOUS les watchdogs actuellement en vol (pas seulement le dernier) —
// cf. commentaire dans _mjs_startHeartbeat.
MjsSocket.prototype._mjs_clearWatchdogs = function() {
  var wds = this._mjs_hbWatchdogs;
  if (wds) { for (var i = 0; i < wds.length; i++) { clearTimeout(wds[i]); } }
  this._mjs_hbWatchdogs = [];
};
MjsSocket.prototype._mjs_petWatchdog = function() {
  this._mjs_clearWatchdogs();
};

// --- placeholders remplis dans les sous-briques suivantes ---
MjsSocket.prototype._mjs_onAck = function(msg) {
  var r = this._mjs_reqs[msg.id];
  if (!r) { return; }
  delete this._mjs_reqs[msg.id];
  if (r.timer) { clearTimeout(r.timer); }
  if (msg.e) { r.reject(msg.p); } else { r.resolve(msg.p); }
};

MjsSocket.prototype.request = function(type, payload, opts) {
  this._mjs_ensure();
  opts = opts || {};
  var self = this;
  var id = ++this._mjs_reqSeq;
  return new Promise(function(resolve, reject) {
    if (self.state !== 'open' && !opts.waitForOpen) {
      reject({ code: 'offline', message: 'socket non connecté' });
      return;
    }
    var timeoutMs = (opts.timeout != null) ? opts.timeout : (self.opts.timeout || 5000);
    var pending = { id: id, type: type, payload: payload };
    var timer = setTimeout(function() {
      delete self._mjs_reqs[id];
      // purge le rendez-vous
      // _mjs_pendingOpenReqs : sans ça, un `_mjs_onWelcome` ULTÉRIEUR (reconnexion
      // après ce timeout) renverrait quand même la requête, alors que
      // l'appelant a déjà reçu le rejet et abandonné.
      var pi = self._mjs_pendingOpenReqs.indexOf(pending);
      if (pi !== -1) { self._mjs_pendingOpenReqs.splice(pi, 1); }
      reject({ code: 'timeout', message: 'request timeout' });
    }, timeoutMs);
    self._mjs_reqs[id] = { resolve: resolve, reject: reject, timer: timer };
    if (self.state === 'open') {
      self._mjs_rawSend({ t: type, p: payload, id: id });
    } else {
      // `waitForOpen: true` hors-ligne :
      // AVANT, `_mjs_rawSend()` partait ICI inconditionnellement — silencieusement
      // jeté par `_mjs_rawSend` (readyState !== 1, cf. plus haut), sans AUCUN filet
      // de rattrapage à l'ouverture. La requête n'était donc JAMAIS
      // réellement transmise : seul le timeout ci-dessus finissait par
      // rejeter, TOUJOURS, même si la connexion s'ouvrait 100ms plus tard —
      // l'option ne changeait rien d'observable pour l'appelant à part
      // retarder un échec devenu inévitable. On diffère maintenant l'envoi
      // RÉEL jusqu'à `_mjs_onWelcome` (même relais que la file `_mjs_queue` de
      // send() juste au-dessus dans ce fichier) ; le timeout reste le filet
      // de sécurité si la connexion n'aboutit jamais.
      self._mjs_pendingOpenReqs.push(pending);
    }
  });
};

// --- rafraîchissement du jeton EN VOL (cf. mjs-ws/core.ts µ:refresh) ---
// Accepte le MÊME contrat que l'option `auth` du constructeur (valeur directe, fonction sync,
// ou fonction async) — PAS de re-tentative automatique ni de timer : c'est à l'appli de décider
// QUAND rafraîchir (ex. un peu avant l'échéance connue du jeton courant). `refresh` n'est PAS
// un nom d'événement réservé côté on() (contrairement à 'welcome') — seule cette méthode existe.
MjsSocket.prototype.refresh = function(a) {
  this._mjs_ensure();
  var self = this;
  return new Promise(function(resolve, reject) {
    var send = function(authValue) { self.request('µ:refresh', { auth: authValue }).then(resolve, reject); };
    if (typeof a === 'function') {
      var r;
      try { r = a(); } catch (e) { reject(e); return; }
      if (r && typeof r.then === 'function') { r.then(send, reject); }
      else { send(r); }
    } else { send(a); }
  });
};

// --- 2c : stream réactif (deltas + numéros de séquence + resync) ---
MjsSocket.prototype.stream = function(type, opts) {
  this._mjs_ensure();
  opts = opts || {};
  var ex = this._mjs_streams[type];
  if (ex) { return ex.store; }
  var store = µ.state({});
  this._mjs_streams[type] = { store: store, lastSeq: 0, resyncing: false };
  this._mjs_subs['stream:' + type] = true;
  this._mjs_rawSend({ t: 'µ:sub-stream', p: { stream: type } });
  return store;
};

MjsSocket.prototype._mjs_onStreamDelta = function(type, msg) {
  var st = this._mjs_streams[type];
  if (!st) { return; }
  var p = msg.p || {};
  var seq = msg.seq;
  // un `reset` est
  // un remplacement d'état COMPLET : ni doublon, ni trou. Il est accepté quelle
  // que soit la seq (serveur REDÉMARRÉ, compteur reparti de zéro, ex. seq=1
  // alors que le client était à 500) — Y COMPRIS SANS seq (`seq: undefined`,
  // snapshot non numéroté). AVANT, ce dernier cas sautait tout le bloc gardé
  // `if (seq != null)` : les valeurs étaient bien appliquées, mais `lastSeq`
  // restait HAUT → TOUS les deltas suivants (seq 1,2,3…) retombaient ensuite
  // dans la garde anti-doublon → flux figé à vie (le symptôme même que le fix
  // du reset numéroté corrigeait). On remet le compteur (à `seq` s'il existe,
  // sinon 0) puis on applique.
  if (p.op === 'reset') {
    st.resyncing = false;
    st.lastSeq = (seq != null) ? seq : 0;
    this._mjs_applyDelta(st.store, p);
    return;
  }
  if (seq != null) {
    // Delta périmé/dupliqué (retransmission, arrivée hors-ordre) : seq déjà vu →
    // on l'ignore. Sinon on le ré-appliquait ET on faisait RECULER lastSeq.
    if (st.lastSeq && seq <= st.lastSeq) { return; }
    // Détection de trou : on a sauté des numéros → on redemande depuis le dernier
    // vu. Flag anti-rafale : tant que le trou n'est pas comblé, ne PAS ré-émettre
    // un resync à chaque delta en avance (le serveur peut en pousser plusieurs).
    if (st.lastSeq && seq > st.lastSeq + 1) {
      if (!st.resyncing) {
        st.resyncing = true;
        this._mjs_rawSend({ t: 'µ:resync', p: { stream: type, from: st.lastSeq } });
      }
      return;
    }
    // Séquence contiguë : le trou éventuel est comblé.
    st.resyncing = false;
    st.lastSeq = seq;
  }
  this._mjs_applyDelta(st.store, p);
};

// Garde anti-pollution locale (indépendante de mjs_init : le socket peut être
// chargé/testé isolément). Bloque __proto__/constructor/prototype sur une clé
// issue d'un message réseau non fiable.
function _mjs_safeKey(k) {
  return k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
}
MjsSocket.prototype._mjs_applyDelta = function(store, p) {
  var k, cur, merged, a, b;
  switch (p.op) {
    case 'reset':
      for (k in store) { delete store[k]; }
      var vals = p.values || {};
      for (k in vals) { if (_mjs_safeKey(k)) store[k] = vals[k]; }
      break;
    case 'add':
      if (_mjs_safeKey(p.key)) store[p.key] = p.value;
      break;
    case 'update':
      cur = store[p.key] || {};
      merged = {};
      for (a in cur) { merged[a] = cur[a]; }
      var patch = p.patch || {};
      for (b in patch) { if (_mjs_safeKey(b)) merged[b] = patch[b]; }
      if (_mjs_safeKey(p.key)) store[p.key] = merged;
      break;
    case 'remove':
      delete store[p.key];
      break;
  }
};

// --- 2d : presence + rooms + kick serveur ---
MjsSocket.prototype.presence = function(room) {
  this._mjs_ensure();
  var key = room || '';
  var ex = this._mjs_presence[key];
  if (ex) { return ex; }
  var store = µ.state({});
  this._mjs_presence[key] = store;
  this._mjs_subs['presence:' + key] = true;
  this._mjs_rawSend({ t: 'µ:sub-presence', p: { room: room } });
  return store;
};

MjsSocket.prototype._mjs_onPresence = function(msg) {
  var p = msg.p || {};
  var store = this._mjs_presence[p.room || ''];
  if (!store) { return; }
  var id, peers;
  switch (p.op) {
    case 'reset':
      for (id in store) { delete store[id]; }
      peers = p.peers || {};
      for (id in peers) { if (_mjs_safeKey(id)) store[id] = peers[id]; }
      break;
    case 'join':  if (_mjs_safeKey(p.id)) store[p.id] = p.meta; break;
    case 'leave': delete store[p.id]; break;
  }
};

// purge COMPLÈTE d'un
// salon, appelée par leave() (client) ET _mjs_onLeft (kick serveur). Le proxy
// room() est un pur namespace de préfixe SANS état propre : handlers, streams,
// présence et callback onLeft vivent tous sur le SOCKET PARTAGÉ. L'ancien
// leave() ne retirait QUE les handlers `name/…` — streams (`_mjs_streams['name/type']`
// + `_mjs_subs`), présence (`_mjs_presence[name]` + `_mjs_subs`) et `_mjs_onLeftCb[name]`
// restaient référencés à vie ET RÉ-ABONNÉS à chaque reconnexion (_mjs_onWelcome)
// pour un salon pourtant quitté. On purge tout ici.
MjsSocket.prototype._mjs_purgeRoom = function(name) {
  var prefix = name + '/', __k;
  // handlers + subs pub/sub namespacés (réutilise off() : sa propre logique de nettoyage)
  for (__k in this._mjs_handlers) { if (__k.indexOf(prefix) === 0) { this.off(__k); } }
  // streams du salon : _mjs_streams['name/type'] + _mjs_subs['stream:name/type']
  for (__k in this._mjs_streams) {
    if (__k.indexOf(prefix) === 0) { delete this._mjs_streams[__k]; delete this._mjs_subs['stream:' + __k]; }
  }
  // présence du salon : _mjs_presence[name] + _mjs_subs['presence:name']
  if (this._mjs_presence[name]) { delete this._mjs_presence[name]; delete this._mjs_subs['presence:' + name]; }
  // callback onLeft du salon
  if (this._mjs_onLeftCb) { delete this._mjs_onLeftCb[name]; }
};

// join-optimiste — envoie µ:join et n'empile dans la FIFO d'attente
// QUE si la trame est RÉELLEMENT partie (readyState open, cf. _mjs_rawSend) : un appel avant ouverture
// (le cas le plus courant, cf. room() plus bas) est un no-op réseau — rien n'empile alors, seul
// le VRAI envoi post-welcome (_mjs_onWelcome) le fera. Sans cette garde, une entrée FANTÔME (jamais
// transmise, donc jamais susceptible de provoquer une VRAIE réponse serveur) désynchroniserait
// la FIFO d'un cran et ferait pop la MAUVAISE entrée à la première erreur venue.
MjsSocket.prototype._mjs_sendJoin = function(name) {
  var sent = this._mjs_rawSend({ t: 'µ:join', p: { room: name } });
  if (sent) {
    this._mjs_pendingRoomJoins.push(name);
    if (this._mjs_pendingRoomJoins.length > 64) { this._mjs_pendingRoomJoins.shift(); }   // borne défensive — jamais atteinte en usage normal
  }
};

// join-optimiste — µ:error générique (SANS champ room, cf. tête de
// fichier) reçu pendant qu'au moins un salon est en attente : on retire le PLUS ANCIEN (FIFO) de
// _mjs_rooms, plus jamais re-tenté automatiquement au welcome suivant. Dégât collatéral ASSUMÉ : une
// erreur SANS RAPPORT (débit, type inconnu…) survenant pendant l'attente peut à tort faire sortir
// ce salon de _mjs_rooms — mineur et RÉCUPÉRABLE, l'appli peut rappeler sock.room(name) (cf. tête de
// fichier) ; JAMAIS les autres salons, ni presence/stream (aucun appel à _mjs_purgeRoom ici).
MjsSocket.prototype._mjs_onGuardError = function() {
  if (this._mjs_pendingRoomJoins.length === 0) { return; }
  var name = this._mjs_pendingRoomJoins.shift();
  if (this._mjs_rooms[name]) { delete this._mjs_rooms[name]; }
};

// join-optimiste — retire TOUTES les entrées d'attente pour `name`
// (leave() explicite avant réponse serveur, cf. room().leave() plus bas) : garde la FIFO propre,
// jamais d'entrée obsolète qui ferait pop la mauvaise correspondance pour un salon SANS RAPPORT.
MjsSocket.prototype._mjs_forgetPendingJoin = function(name) {
  var kept = [], i;
  for (i = 0; i < this._mjs_pendingRoomJoins.length; i++) { if (this._mjs_pendingRoomJoins[i] !== name) { kept.push(this._mjs_pendingRoomJoins[i]); } }
  this._mjs_pendingRoomJoins = kept;
};

MjsSocket.prototype.room = function(name) {
  this._mjs_ensure();
  // join en double : room(name) appelé
  // 2 FOIS pour LE MÊME nom (2 composants distincts qui rejoignent le même
  // salon, ou un composant qui re-render et rappelle room() sans garder sa
  // référence) renvoyait TOUJOURS un `µ:join` au serveur, même déjà membre —
  // gaspillage réseau au mieux, double comptage côté serveur (présence,
  // membres) au pire, selon l'implémentation. `_mjs_rooms[name]` sert DÉJÀ de
  // registre d'appartenance (relu par _mjs_onWelcome pour le re-join auto après
  // reconnexion) : on s'en sert aussi comme garde ici. Le proxy retourné
  // reste un NOUVEL objet à chaque appel (comportement inchangé) — il est
  // sans état propre, tout vit sur `self`, donc en renvoyer un nouveau ou le
  // même est strictement équivalent pour l'appelant.
  if (!this._mjs_rooms[name]) {
    this._mjs_rooms[name] = true;
    this._mjs_sendJoin(name);   // join-optimiste — cf. _mjs_sendJoin/_mjs_onGuardError plus bas
  }
  var self = this;
  var prefix = name + '/';
  return {
    on:       function(type, h) { return self.on(prefix + type, h); },
    send:     function(type, p, opts) { return self.send(prefix + type, p, opts); },
    request:  function(type, p, opts) { return self.request(prefix + type, p, opts); },
    stream:   function(type, opts) { return self.stream(prefix + type, opts); },
    presence: function() { return self.presence(name); },
    onLeft:   function(fn) { (self._mjs_onLeftCb || (self._mjs_onLeftCb = {}))[name] = fn; },
    // Garde symétrique à celle du join ci-dessus : un leave() déjà effectif
    // (2e appel, ex. double cleanup @destroy) ne renvoie pas un 2e `µ:leave`.
    leave:    function() {
      if (self._mjs_rooms[name]) {
        delete self._mjs_rooms[name];
        self._mjs_rawSend({ t: 'µ:leave', p: { room: name } });
        // purge
        // COMPLÈTE du salon (handlers, streams, présence, onLeft), pas seulement
        // les handlers : sinon fuite mémoire (closures/stores retenus à vie sur
        // le socket partagé) ET ré-abonnement du salon QUITTÉ à chaque
        // reconnexion (_mjs_onWelcome ré-émet µ:sub-stream/µ:sub-presence). Cf.
        // _mjs_purgeRoom (partagé avec le kick serveur _mjs_onLeft).
        self._mjs_purgeRoom(name);
        // join-optimiste — un leave() explicite avant toute réponse serveur rend
        // l'éventuelle entrée FIFO de CE salon obsolète (la garde n'a plus rien à confirmer/refuser
        // pour un salon déjà quitté côté client) : la laisser traîner ferait pop la MAUVAISE
        // entrée si une erreur sans rapport arrive ensuite pour un AUTRE salon en attente.
        self._mjs_forgetPendingJoin(name);
      }
    }
  };
};

MjsSocket.prototype._mjs_onLeft = function(msg) {
  var p = msg.p || {};
  delete this._mjs_rooms[p.room];
  var cb = this._mjs_onLeftCb && this._mjs_onLeftCb[p.room];
  if (cb) { try { cb(p.reason); } catch (e) {} }
  // kick serveur symétrique au
  // leave() client : purge streams/présence/handlers du salon (APRÈS le
  // callback, qui peut vouloir lire l'état une dernière fois). Sans ça, mêmes
  // fuites qu'au leave() non purgé + ré-abonnement au prochain welcome.
  if (p.room != null) { this._mjs_purgeRoom(p.room); }
};

// --- cycle de vie ---
// fermeture volontaire = rien ne doit repartir : purge les envois `debounce`/`coalesce`
// encore EN VOL (send() avec anti-rebond/regroupement) — appelée par close() ET destroy(),
// jamais par _mjs_teardown() (coupure réseau involontaire : la file hors-ligne reste le
// comportement voulu, cf. _mjs_teardown plus haut)
MjsSocket.prototype._mjs_cancelPending = function() {
  var coal = this._mjs_coalesce;
  for (var __ct in coal) { if (coal[__ct].timer) { clearTimeout(coal[__ct].timer); } }
  this._mjs_coalesce = {};
  var deb = this._mjs_debounce;
  for (var __dt in deb) { if (deb[__dt].timer) { clearTimeout(deb[__dt].timer); } }
  this._mjs_debounce = {};
};

MjsSocket.prototype.close = function(code, reason) {
  this._mjs_wantOpen = false;
  if (this._mjs_reconnectTimer) { clearTimeout(this._mjs_reconnectTimer); this._mjs_reconnectTimer = null; }
  this._mjs_teardown(true);           // fermeture volontaire = fin définitive → rejette les waitForOpen
  this._mjs_cancelPending();          // idem — un debounce/coalesce en vol ne doit pas ressusciter dans _mjs_queue après coup
  this._mjs_pendingOpenReqs = [];
  this._mjs_setState('closed');
};

MjsSocket.prototype.destroy = function() {
  // Ref-count : µ.socket(url) partagé incrémente _mjs_refs à chaque détenteur. On ne
  // démonte réellement qu'au DERNIER destroy() ; les autres ne font que relâcher.
  if (this._mjs_refs && --this._mjs_refs > 0) { return; }
  this.close();
  this._mjs_destroyed = true;
  if (µ._mjs_sockets[this.url] === this) { delete µ._mjs_sockets[this.url]; }
  // teardown incomplet : destroy() est
  // la fin de vie DÉFINITIVE (connect() refusera désormais tout, cf. sa garde
  // `if (this._mjs_destroyed) return`) — mais 2 restes pouvaient survivre au-delà :
  //   - un timer _mjs_coalesceSend EN VOL rappellerait _mjs_sendNow() plus tard sur
  //     ce socket mort, qui repousserait silencieusement dans _mjs_queue un
  //     message que plus AUCUN _mjs_onWelcome ne rejouera jamais (le timer
  //     maintenant `this` vivant en mémoire via sa closure jusqu'à son terme).
  //   - _mjs_queue elle-même : des messages hors-ligne en attente d'un reconnect
  //     qui, après destroy(), n'arrivera jamais — ils restaient en mémoire
  //     sans aucune chance d'être un jour rejoués.
  // La purge debounce/coalesce est extraite dans _mjs_cancelPending(), partagée avec
  // close() ci-dessus (déjà appelée une 1re fois via this.close()) — 2e appel idempotent,
  // gardé explicite pour que destroy() reste sûr même si close() cesse un jour de la faire
  this._mjs_cancelPending();
  this._mjs_queue = [];
};
