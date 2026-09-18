// mjs_lobby — client réactif du paquet LOBBY (src/mjs-ws/lobby.ts), posé PAR-DESSUS µ.socket (patch
// externe de MjsSocket.prototype, MÊME patron que mjs_chat.ts/mjs_accounts.ts) — mjs_socket.ts DOIT
// être chargé AVANT ce fichier (ordre canonique du bundler, cf. src/bundler/index.ts
// resolveRuntimeFiles) ; sans lui, ce module reste inerte (garde `typeof MjsSocket !== 'undefined'`,
// jamais un crash).
//
//   hall = sock.lobby()                        # store réactif plat, hall par défaut ('hall')
//   vip  = sock.lobby('vip')                   # hall nommé — n'importe quel nom rejoint/crée le sien
//                                               # (lobbyPackage n'a pas de liste fermée de halls)
//
//   {for p in hall.members}{p.name} — {p.status}{/for}
//   hall.status('busy', 'en partie')
//   hall.invite(unAutrePresentId, 'viens jouer')
//   {for inv in hall.invitations}
//     {inv.from.name} : {inv.note}
//     <button @click={hall.reply(inv, true)}>accepter</button>
//   {/for}
//   hall.advertise({ title: 'Partie rapide', seats: 4 })
//   {for a in hall.listings}<button @click={hall.join(a)}>{a.title}</button>{/for}
//
// `.members` — liste riche {id, name, status, text, since}, tenue par les deltas serveur
// (`lobby:member` upsert, `lobby:left` retire) — état COMPLET reçu à `lobby:enter` (1er accès à
// `sock.lobby(hall)`), deltas ENSUITE. `.me` — {id, name} résolus CÔTÉ SERVEUR (même requête),
// `null` tant que la réponse n'est pas encore revenue.
// `.invitations` — REÇUES, en attente de réponse (`.reply(inv, accepted)`) ; `.listings` — tables
// ouvertes connues (les miennes comprises). TTL LOCAL sur les deux (« purgés sans trame
// serveur ») : chaque entrée programme sa PROPRE expiration (`setTimeout` sur `expiresAt - Date.now()`,
// jamais négatif) — disparaît de son tableau à l'échéance MÊME SI le serveur ne renvoie plus rien
// (horloge locale) ; un `lobby:withdrawn` explicite (retrait/remplacement d'annonce) annule ce minuteur
// et retire tout de suite (MÊME idiome de minuteur local que mjs_chat.ts::_mjs_typers).
// `.applicants`/`.replies` — AJOUTS au-delà de l'énoncé littéral du store (`{members,
// me, status, invitations, invite, reply, listings, advertise, withdraw, join, block,
// close}`) : sans eux, `lobby:applicant` (« untel veut rejoindre MA table ») et `lobby:replied``
// (« untel a répondu à MON invitation ») resteraient invisibles depuis `sock.lobby()` — MÊME
// justification que `.remove`/`.mute` ajoutés par mjs_chat.ts. Tableaux qui s'accumulent (aucune
// notion de « lu » en v1) — l'appli peut les vider elle-même (`hall.applicants = []`) si besoin.
// `.status()`/`.invite()`/`.reply()`/`.advertise()`/`.withdraw()`/`.join()`/`.block()` —
// FIRE-AND-FORGET (aucun ack, aucune Promise) : un refus serveur arrive en `µ:error {message:
// 'lobby-*'}`, exposé via `sock.lastError` — MÊME mécanique que chat (cf. mjs-ws/lobby.ts tête de
// fichier pour la liste des codes).
// `.close()` — quitte le hall (`µ:leave`) et purge le store local (minuteurs compris).
//
// Plusieurs halls, plusieurs poignées — chaque `sock.lobby(hall)` reste INDÉPENDANTE (aucun
// singleton, MÊME choix que sock.chat()/sock.game()) : présence/invitations/annonces dupliquées en
// mémoire par poignée, mais l'adhésion `sock.room()` sous-jacente EST partagée par nom de hall —
// fermer UNE poignée quitte le hall pour de bon, même si une AUTRE poignée du même nom reste ouverte
// (limite déjà assumée par sock.room() lui-même, cf. mjs_chat.ts).
//
// Reconnexion — AUCUNE logique dédiée, MÊME choix que mjs_chat.ts : `sock.room()` rejoint le hall à
// nouveau automatiquement, mais `lobby:enter` n'est PAS re-demandé (`.me`/`.members` figés depuis
// le 1er accès) — sans incidence en usage normal (identité stable pendant la session, cf. mjs-ws/
// comptes.ts « une élévation change l'id ⇒ reconnexion complète », hors zone de ce module).

if (typeof MjsSocket !== 'undefined') {

  var MJS_LOBBY_DEFAULT_HALL = 'hall';

  function _lobbyUpsertMember(h, p) {
    if (!p || typeof p.id !== 'string') { return; }
    var arr = h.state.members, i, out = [], replaced = false;
    var entry = { id: p.id, name: p.name, status: p.status, text: p.text, since: p.since };
    for (i = 0; i < arr.length; i++) {
      if (arr[i].id === p.id) { out.push(entry); replaced = true; }
      else { out.push(arr[i]); }
    }
    if (!replaced) { out.push(entry); }
    h.state.members = out;
  }

  function _lobbyRemoveMember(h, id) {
    if (typeof id !== 'string') { return; }
    h.state.members = h.state.members.filter(function(x) { return x.id !== id; });
  }

  function _lobbyOnMember(h, frame) {
    if (!frame || frame.hall !== h._mjs_hall) { return; }
    _lobbyUpsertMember(h, frame);
  }

  function _lobbyOnLeft(h, frame) {
    if (!frame || frame.hall !== h._mjs_hall) { return; }
    _lobbyRemoveMember(h, frame.id);
  }

  // minuteur d'expiration LOCAL — MÊME idiome que mjs_chat.ts::_mjs_typers (setTimeout, jamais
  // négatif) ; `registre` = h._mjs_inviteTimers OU h._annonceTimers, `withdraw(id)` ôte l'entrée du store.
  // `_mjs_safeKey` (mjs_socket.ts, même fichier concaténé) — anti-pollution de prototype, id VENU DU
  // RÉSEAU utilisé comme clé d'objet brut (MÊME garde que mjs_chat.ts::_mjs_typers).
  function _lobbyArmExpiry(registry, id, expireAt, remove) {
    if (!_mjs_safeKey(id)) { return; }
    var existing = registry[id];
    if (existing) { clearTimeout(existing); }
    var delay = expireAt - Date.now();
    if (delay < 0) { delay = 0; }
    registry[id] = setTimeout(function() { delete registry[id]; remove(id); }, delay);
  }

  function _lobbyOnInvitation(h, frame) {
    if (!frame || frame.hall !== h._mjs_hall || typeof frame.id !== 'string') { return; }
    var next = h.state.invitations.filter(function(x) { return x.id !== frame.id; });
    next.push({ id: frame.id, from: frame.from, note: frame.note, expiresAt: frame.expiresAt });
    h.state.invitations = next;
    _lobbyArmExpiry(h._mjs_inviteTimers, frame.id, frame.expiresAt, function(id) {
      h.state.invitations = h.state.invitations.filter(function(x) { return x.id !== id; });
    });
  }

  function _lobbyOnReplied(h, frame) {
    if (!frame || frame.hall !== h._mjs_hall) { return; }
    h.state.replies = h.state.replies.concat([{ id: frame.id, from: frame.from, accepted: frame.accepted }]);
  }

  function _lobbyOnListing(h, frame) {
    if (!frame || frame.hall !== h._mjs_hall || typeof frame.id !== 'string') { return; }
    var next = h.state.listings.filter(function(x) { return x.id !== frame.id; });
    next.push({ id: frame.id, from: frame.from, title: frame.title, code: frame.code, seats: frame.seats, meta: frame.meta, expiresAt: frame.expiresAt });
    h.state.listings = next;
    _lobbyArmExpiry(h._mjs_listingTimers, frame.id, frame.expiresAt, function(id) {
      h.state.listings = h.state.listings.filter(function(x) { return x.id !== id; });
    });
  }

  function _lobbyOnWithdrawn(h, frame) {
    if (!frame || frame.hall !== h._mjs_hall || typeof frame.id !== 'string' || !_mjs_safeKey(frame.id)) { return; }
    var t = h._mjs_listingTimers[frame.id];
    if (t) { clearTimeout(t); delete h._mjs_listingTimers[frame.id]; }
    h.state.listings = h.state.listings.filter(function(x) { return x.id !== frame.id; });
  }

  function _lobbyOnApplicant(h, frame) {
    if (!frame || frame.hall !== h._mjs_hall) { return; }
    h.state.applicants = h.state.applicants.concat([{ id: frame.id, from: frame.from }]);
  }

  // une trame lobby:* est diffusée à TOUTES les poignées ouvertes sur ce socket (filtrage PAR
  // PAYLOAD, `frame.hall` — MÊME patron que mjs_chat.ts::_mjs_chatDispatch/`frame.salon`).
  MjsSocket.prototype._mjs_lobbyDispatch = function(frame, apply) {
    var lobbies = this._mjs_lobbies, i;
    for (i = 0; i < lobbies.length; i++) { apply(lobbies[i], frame); }
  };

  MjsSocket.prototype._mjs_ensureLobbyWiring = function() {
    if (this._mjs_lobbyWired) { return; }
    this._mjs_lobbyWired = true;
    this._mjs_lobbies = [];   // toutes les poignées sock.lobby() ouvertes sur ce socket
    var self = this;
    this.on('lobby:member',    function(p) { self._mjs_lobbyDispatch(p, _lobbyOnMember); });
    this.on('lobby:left',      function(p) { self._mjs_lobbyDispatch(p, _lobbyOnLeft); });
    this.on('lobby:invitation', function(p) { self._mjs_lobbyDispatch(p, _lobbyOnInvitation); });
    this.on('lobby:replied',    function(p) { self._mjs_lobbyDispatch(p, _lobbyOnReplied); });
    this.on('lobby:listing',    function(p) { self._mjs_lobbyDispatch(p, _lobbyOnListing); });
    this.on('lobby:withdrawn',    function(p) { self._mjs_lobbyDispatch(p, _lobbyOnWithdrawn); });
    this.on('lobby:applicant',   function(p) { self._mjs_lobbyDispatch(p, _lobbyOnApplicant); });
  };

  MjsSocket.prototype.lobby = function(hall) {
    this._mjs_ensure();
    this._mjs_ensureLobbyWiring();
    var self = this;
    var hallName = hall || MJS_LOBBY_DEFAULT_HALL;
    var state = µ.state({ members: [], me: null, invitations: [], applicants: [], listings: [], replies: [] });
    var h = {
      state: state,
      _mjs_hall: hallName,
      _mjs_inviteTimers: {},
      _mjs_listingTimers: {},
      _mjs_room: this.room('lobby:' + hallName)
    };
    this._mjs_lobbies.push(h);

    state.status    = function(statut, texte) { self.send('lobby:status', { hall: hallName, status: statut, text: texte }); };
    state.invite   = function(identityId, note) { self.send('lobby:invite', { hall: hallName, identityId: identityId, note: note }); };
    state.reply  = function(inv, accepte) {
      var id = (inv && typeof inv === 'object') ? inv.id : inv;
      self.send('lobby:reply', { hall: hallName, id: id, accepted: accepte });
    };
    state.advertise  = function(p) {
      p = p || {};
      self.send('lobby:advertise', { hall: hallName, title: p.title, code: p.code, seats: p.seats, meta: p.meta });
    };
    state.withdraw   = function(id) { self.send('lobby:withdraw', { hall: hallName, id: id }); };
    state.join = function(annonce) {
      var id = (annonce && typeof annonce === 'object') ? annonce.id : annonce;
      self.send('lobby:join', { hall: hallName, id: id });
    };
    state.block   = function(identityId) { self.send('lobby:block', { hall: hallName, identityId: identityId }); };
    state.close    = function() {
      var i = self._mjs_lobbies.indexOf(h), id;
      if (i !== -1) { self._mjs_lobbies.splice(i, 1); }
      for (id in h._mjs_inviteTimers)  { if (_mjs_safeKey(id) && h._mjs_inviteTimers[id])  { clearTimeout(h._mjs_inviteTimers[id]); } }
      for (id in h._mjs_listingTimers) { if (_mjs_safeKey(id) && h._mjs_listingTimers[id]) { clearTimeout(h._mjs_listingTimers[id]); } }
      h._mjs_room.leave();
    };

    // `waitForOpen` : sock.lobby() est typiquement appelé avant même que la connexion ne soit
    // ouverte (montage de composant) — MÊME raison que mjs_chat.ts::chat:me.
    this.request('lobby:enter', { hall: hallName }, { waitForOpen: true }).then(
      function(res) { state.me = res.me; state.members = res.members || []; },
      function() {}   // hors-ligne/refus — le store reste vide, jamais de crash
    );

    return state;
  };

}
