// mjs_chat — client réactif du paquet CHAT (src/mjs-ws/chat.ts), posé PAR-DESSUS µ.socket (patch
// externe de MjsSocket.prototype, MÊME patron que mjs_game.ts) — mjs_socket.ts DOIT être chargé
// AVANT ce fichier (ordre canonique du bundler, cf. src/bundler/index.ts resolveRuntimeFiles) ;
// sans lui, ce module reste inerte (garde `typeof MjsSocket !== 'undefined'`, jamais un crash).
//
//   salon = sock.chat('general')                      # store réactif plat, join immédiat (chat:general)
//   salon = sock.chat('general', { prefix: 'salon:' }) # préfixe personnalisé — DOIT correspondre à
//                                                       # chatPackage(opts).prefix côté serveur
//
//   {for m in salon.messages}{m.from.name} : {m.text}{/for}
//   <input @input={salon.typing()} @keydown.enter={salon.send($texte); $texte = ''}>
//   {if salon.typingUsers.length}{salon.typingUsers.join(', ')} écrit…{/if}
//   salon.close()                                     # µ:leave + purge locale
//
// `.me` — {id, name} résolus CÔTÉ SERVEUR (requête chat:me, cf. mjs-ws/chat.ts) — `null` tant
// que la réponse n'est pas encore revenue (1er tick réactif après le join).
// `.messages` — ordonnés par `ts` SERVEUR, dédupliqués par `id` (rejeu d'historique au join ET à
// la reconnexion, cf. mjs-ws/rooms.ts::replayHistory) ; un retrait (modération) filtre le message
// visé, qu'il ait déjà été affiché ou qu'il arrive APRÈS coup (id retenu en tombstone LOCAL, cf.
// docs/26-chat.md « Modération ») — `room().history()` n'offre AUCUNE primitive de suppression
// RÉTROACTIVE d'une entrée du journal (cf. mjs-ws/chat.ts tête de fichier) : un rejoueur tardif peut
// donc recevoir un message déjà retiré, JAMAIS l'inverse (un retrait est toujours diffusé/journalisé
// APRÈS son message, donc jamais évincé du journal avant lui) — le filtrage ci-dessous absorbe les
// DEUX ordres d'arrivée possibles.
// `.typingUsers` — pseudos en train d'écrire ; EXPIRATION locale (cf. MJS_CHAT_TYPING_TTL_MS
// ci-dessous) faute de signal serveur explicite de « fin de frappe » (throttle serveur ~3s, cf.
// mjs-ws/chat.ts) — CHOIX délibéré, absent de l'énoncé littéral du store : sans lui un pseudo
// resterait « en train d'écrire » indéfiniment dès la moindre pause.
// `.send(text)`/`.typing()` — FIRE-AND-FORGET (aucun ack, aucune Promise) : un refus serveur
// arrive en `µ:error {message: 'chat-length'|'chat-rate'|'chat-denied'|'chat-muted'}`, exposé
// via `sock.lastError` — MÊME mécanique que le reste de MJS-WS (cf. mjs_socket.ts), PAS un rejet
// de promesse dédié comme `partie.move()` de mjs_game.ts (le protocole chat n'a pas d'ack ici).
// `.remove(id)`/`.mute(identityId, durationMs)` — AJOUTS au-delà de l'énoncé
// littéral du store (`{ messages, send, typing, typingUsers, me, close }`) : sans eux, la
// section « Modération v1 » resterait inatteignable depuis sock.chat() — rejetés
// serveur ('chat-denied') si l'identité appelante n'est pas `moderators` (chatPackage(opts)).
//
// Reconnexion — AUCUNE logique dédiée ici : `sock.room()` (mjs_socket.ts::_mjs_onWelcome) rejoint à
// nouveau automatiquement, le salon MJS-WS rejoue son historique à CHAQUE `µ:join` (donc aussi
// après reconnexion) — la dédup par id absorbe les doublons.
//
// Plusieurs poignées, même salon — chaque `sock.chat(name)` reste INDÉPENDANTE (aucun singleton,
// MÊME choix que sock.game(), cf. mjs_game.ts tête de fichier) : messages/typingUsers dupliqués en
// mémoire, mais l'adhésion `sock.room()` sous-jacente EST partagée (`_mjs_rooms[name]`, mjs_socket.ts) —
// fermer UNE poignée (`close()`) quitte le salon pour de bon (µ:leave), même si une AUTRE poignée
// du même nom reste ouverte sur ce socket — même limite déjà assumée par sock.room() lui-même.

if (typeof MjsSocket !== 'undefined') {

  var MJS_CHAT_TYPING_TTL_MS = 5000;   // > throttle serveur (~3s, mjs-ws/chat.ts) — évite le clignotement
  var MJS_CHAT_HISTORY_MAX   = 100;    // aligné sur DEFAULT_HISTORY (mjs-ws/chat.ts) — plus ancien évincé au-delà

  function _chatSyncTypingUsers(h) {
    var out = [], id;
    for (id in h._mjs_typers) { if (_mjs_safeKey(id)) { out.push(h._mjs_typers[id].name); } }
    h.state.typingUsers = out;
  }

  // borne mémoire — `.messages`/`._mjs_seenIds`/`._mjs_retired` grossissaient
  // SANS BORNE pour toute la session (contrairement à room().history(), serveur, borné). `id` entre
  // dans la fenêtre FIFO `h._mjs_order` au 1er contact (vu OU retiré) ; au-delà de MJS_CHAT_HISTORY_MAX
  // identifiants suivis, le plus ANCIEN tombe des TROIS registres à la fois.
  function _chatTrack(h, id) {
    h._mjs_order.push(id);
    if (h._mjs_order.length > MJS_CHAT_HISTORY_MAX) {
      var old = h._mjs_order.shift();
      delete h._mjs_seenIds[old];
      delete h._mjs_retired[old];
      h.state.messages = h.state.messages.filter(function(m) { return m.id !== old; });
    }
  }

  function _chatInsert(h, msg) {
    if (!msg || typeof msg.id !== 'string') { return; }
    if (h._mjs_seenIds[msg.id] || h._mjs_retired[msg.id]) { return; }
    h._mjs_seenIds[msg.id] = true;
    _chatTrack(h, msg.id);
    var next = h.state.messages.concat([msg]);
    next.sort(function(a, b) { return a.ts - b.ts; });
    h.state.messages = next;
  }

  function _chatRemoveApply(h, id) {
    if (typeof id !== 'string') { return; }
    if (!h._mjs_seenIds[id] && !h._mjs_retired[id]) { _chatTrack(h, id); }   // retrait d'un id jamais vu — suit quand même
    h._mjs_retired[id] = true;
    if (!h._mjs_seenIds[id]) { return; }   // jamais vu (ou pas encore arrivé) — rien à retirer visuellement
    h.state.messages = h.state.messages.filter(function(m) { return m.id !== id; });
  }

  function _chatOnMessage(h, frame) {
    if (!frame || frame.room !== h._mjs_room_name) { return; }
    _chatInsert(h, frame);
  }

  function _chatOnRemoved(h, frame) {
    if (!frame || frame.room !== h._mjs_room_name) { return; }
    _chatRemoveApply(h, frame.id);
  }

  function _chatOnTyping(h, frame) {
    if (!frame || frame.room !== h._mjs_room_name || !frame.from) { return; }
    var id = frame.from.id;
    if (!_mjs_safeKey(id)) { return; }
    var existing = h._mjs_typers[id];
    if (existing && existing.timer) { clearTimeout(existing.timer); }
    h._mjs_typers[id] = {
      name: frame.from.name,
      timer: setTimeout(function() { delete h._mjs_typers[id]; _chatSyncTypingUsers(h); }, MJS_CHAT_TYPING_TTL_MS)
    };
    _chatSyncTypingUsers(h);
  }

  // une trame chat:* est diffusée à TOUTES les poignées ouvertes sur ce socket (filtrage PAR
  // PAYLOAD, `frame.room` — chat:message/typing/removed restent des types GLOBAUX, cf. mjs-ws/
  // chat.ts, pas des types préfixés façon sock.room()).
  MjsSocket.prototype._mjs_chatDispatch = function(frame, apply) {
    var chats = this._mjs_chats, i;
    for (i = 0; i < chats.length; i++) { apply(chats[i], frame); }
  };

  MjsSocket.prototype._mjs_ensureChatWiring = function() {
    if (this._mjs_chatWired) { return; }
    this._mjs_chatWired = true;
    this._mjs_chats = [];   // toutes les poignées sock.chat() ouvertes sur ce socket
    var self = this;
    this.on('chat:message', function(p) { self._mjs_chatDispatch(p, _chatOnMessage); });
    this.on('chat:removed', function(p) { self._mjs_chatDispatch(p, _chatOnRemoved); });
    this.on('chat:typing',  function(p) { self._mjs_chatDispatch(p, _chatOnTyping); });
  };

  MjsSocket.prototype.chat = function(name, opts) {
    this._mjs_ensure();
    this._mjs_ensureChatWiring();
    var self = this;
    var prefix = (opts && opts.prefix) || 'chat:';
    var state = µ.state({ messages: [], typingUsers: [], me: null });
    var h = {
      state:      state,
      _mjs_room_name: name,
      _mjs_seenIds:   {},
      _mjs_retired:   {},
      _mjs_order:     [],
      _mjs_typers:    {},
      _mjs_room:      this.room(prefix + name)
    };
    this._mjs_chats.push(h);

    state.send   = function(text) { self.send('chat:send', { room: name, text: text }); };
    state.typing = function() { self.send('chat:typing', { room: name }); };
    state.remove = function(id) { self.send('chat:remove', { room: name, id: id }); };
    state.mute   = function(identityId, durationMs) { self.send('chat:mute', { room: name, identityId: identityId, durationMs: durationMs }); };
    state.close  = function() {
      var i = self._mjs_chats.indexOf(h), id;
      if (i !== -1) { self._mjs_chats.splice(i, 1); }
      for (id in h._mjs_typers) { if (h._mjs_typers[id].timer) { clearTimeout(h._mjs_typers[id].timer); } }
      h._mjs_room.leave();
    };

    // identité résolue SERVEUR — `waitForOpen` : sock.chat() est typiquement appelé avant même que
    // la connexion ne soit ouverte (montage de composant), une requête SANS ce réglage échouerait
    // systématiquement en 'offline' (cf. mjs_socket.ts::request) plutôt que d'attendre le welcome.
    this.request('chat:me', {}, { waitForOpen: true }).then(
      function(p) { state.me = { id: p.id, name: p.name }; },
      function() {}   // hors-ligne/refus — .me reste null, jamais de crash
    );

    return state;
  };

}
