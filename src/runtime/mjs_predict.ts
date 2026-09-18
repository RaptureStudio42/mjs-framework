// mjs_predict — prédiction du mouvement propre + réconciliation (« netcode »), posée
// PAR-DESSUS sock.game() (src/mjs-server/, cf. mjs_game.ts). Module autonome (patron 'schema' : AUCUNE
// dépendance dure à MjsSocket, jamais de patch prototype — sans 'game' côté bundler, `partie`
// n'existerait simplement jamais, cf. avertissement bundler dans src/bundler/index.ts). AUCUNE
// dépendance à mjs_interp.ts non plus (fichiers concaténés indépendamment, cf. sa tête de fichier) —
// juste le MÊME patron de store miroir en sortie.
//
//   partie = sock.game('monjeu')
//   $moi   = µ.predict(partie, {
//     champs: ['moi'],
//     appliquer: function(fragment, nom, p) {   # DOIT être la MÊME logique que def.intents côté
//       if (nom === 'bouger') { fragment.moi.x += p.dx; fragment.moi.y += p.dy; }   # serveur —
//     }                                          # mettez-la dans un fichier PARTAGÉ (import commun
//   });                                          # client/serveur).
//   partie.move('bouger', { dx: 1, dy: 0 })   # inchangé pour l'appelant — µ.predict ENVELOPPE .move
//   {$moi.moi.x}   # bouge IMMÉDIATEMENT, sans attendre l'aller-retour serveur
//   $moi.stop()    # dé-enveloppe partie.move (restaure l'original) + coupe les abonnements
//
// Numérotation (_n) — CHAQUE appel à `partie.move()` une fois enveloppé reçoit un `_n` croissant
// (compteur LOCAL à cette poignée de prédiction), glissé DANS le payload envoyé au serveur (`p._n`,
// seul emplacement qui survive jusqu'à `game._onMove` côté serveur — matchmaking.ts ne
// transmet QUE `p.coup`/`p.p`, cf. mjs-server/game.ts::_extractN) : nécessite que `p` soit un objet
// (ou absent) — la couture est un no-op silencieux sur un `p` scalaire (limite v1 documentée). Le
// serveur retire `_n` avant `def.intents[coup]` et le reflète dans `_ack` (méta de trame µgame:state,
// JAMAIS dans la vue du jeu, cf. mjs-server/game.ts::_buildFrame) — ABSENT si le coup n'est pas
// une INTENTION (def.intents, mode tick) : un move CLASSIQUE (def.moves) s'applique immédiatement
// côté serveur, jamais mis en file, jamais acquitté par `_n` — cf. PIÈGE ci-dessous.
//
// Réconciliation — à chaque 'start'/'state' (mjs_game.ts::_dispatchGame) : (1) l'état SERVEUR des
// champs déclarés est re-capturé (`partie.state` déjà à jour à ce point, cf. _syncGameStore) ; (2)
// si la trame porte un `_ack` numérique, la file des non-confirmées est purgée des entrées `_n <=
// _ack` ; (3) le fragment prédit repart de zéro depuis CET état serveur et REJOUE `appliquer` sur
// CHAQUE entrée restante, dans l'ordre d'émission — une correction serveur DIVERGENTE (clamp, refus)
// n'est donc jamais « moyennée » : le fragment SNAPPE à la vérité serveur puis rejoue par-dessus.
//
// PIÈGE (documenté, pas résolu — hors scope v1) : un coup enveloppé qui N'EST PAS une intention
// (def.moves classique) ne reçoit JAMAIS d'`_ack` → son entrée ne serait normalement JAMAIS purgée
// (rejouée indéfiniment, DOUBLE-COMPTAGE puisque le move classique s'est déjà appliqué côté serveur
// AVANT même le prochain 'state'). Filet v1 : tant qu'AUCUNE trame de cette partie n'a jamais porté
// `_ack` (`st.ackVu` reste false), la réconciliation vide la file EN ENTIER à chaque 'state' plutôt
// que de rejouer — correct pour un jeu 100% moves classiques (un move classique s'applique de façon
// synchrone et ordonnée : toute trame reçue APRÈS son envoi reflète déjà son effet), mais un jeu qui
// MÉLANGE intentions et moves classiques sur la MÊME poignée prédite reste hors-scope v1 (dès qu'un
// `_ack` est vu une 1re fois, `st.ackVu` bascule à true POUR TOUJOURS — le filet ne se réarme pas).

function _mjpredictDeepClone(v) {
  var out, k;
  if (Array.isArray(v)) { out = []; for (k = 0; k < v.length; k++) { out.push(_mjpredictDeepClone(v[k])); } return out; }
  if (v && typeof v === 'object') { out = {}; for (k in v) { out[k] = _mjpredictDeepClone(v[k]); } return out; }
  return v;
}

// égalité profonde GÉNÉRIQUE (récursive, forme quelconque — contrairement à mjs_interp.ts qui sait
// que ses champs sont des dicts d'entités, un fragment prédit peut être n'importe quelle forme
// déclarée par le jeu, ex. `moi: {x, y}` plat) — évite une écriture réactive superflue.
function _mjpredictEq(a, b) {
  var k;
  if (a === b) { return true; }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') { return a === b; }
  for (k in b) { if (!_mjpredictEq(a[k], b[k])) { return false; } }
  for (k in a) { if (!(k in b)) { return false; } }
  return true;
}

// clone (numéroté) DU payload envoyé au serveur — `p` intact dans la file locale (cf. tête de
// fichier : `appliquer` doit voir EXACTEMENT ce que def.intents verra, jamais pollué par `_n`).
function _mjpredictConNumero(p, n) {
  var out, k;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    out = {};
    for (k in p) { out[k] = p[k]; }
    out._n = n;
    return out;
  }
  return p;   // p scalaire/absent : `_n` ne peut pas se glisser « à côté », cf. tête de fichier
}

function _mjpredictServerSnapshot(st) {
  var out = {}, i, c;
  for (i = 0; i < st.fields.length; i++) { c = st.fields[i]; out[c] = _mjpredictDeepClone(st.game.state[c]); }
  return out;
}

// republie le fragment prédit sur le miroir — réassignation COMPLÈTE par champ (même stratégie que
// mjs_interp.ts::_mjinterpPublier, cf. son commentaire), sautée si inchangé.
function _mjpredictPublier(st) {
  var i, c;
  for (i = 0; i < st.fields.length; i++) {
    c = st.fields[i];
    if (!_mjpredictEq(st.mirror[c], st.fragment[c])) { st.mirror[c] = st.fragment[c]; }
  }
}

// recalcule le fragment ENTIER depuis l'état serveur connu + rejeu de TOUTE la file restante —
// SOURCE UNIQUE (appelée aussi bien après un `move()` local qu'après une réconciliation serveur) :
// aucune divergence possible entre les deux chemins, cf. tête de fichier.
function _mjpredictRejouer(st) {
  var fragment = _mjpredictDeepClone(st.server), i, e;
  for (i = 0; i < st.pending.length; i++) { e = st.pending[i]; st.apply(fragment, e.name, e.p); }
  st.fragment = fragment;
  _mjpredictPublier(st);
}

// --- entrée publique -----------------------------------------------------------------------------

µ.predict = function(game, opts) {
  opts = opts || {};
  var fields = opts.fields || [];
  var apply = typeof opts.apply === 'function' ? opts.apply : function() {};
  var moveOriginal = game.move;
  var st = { game: game, fields: fields, apply: apply, n: 0, ackSeen: false, pending: [], server: {}, fragment: {}, mirror: µ.state({}) };
  var i;
  for (i = 0; i < fields.length; i++) { st.mirror[fields[i]] = {}; }
  st.server = _mjpredictServerSnapshot(st);
  _mjpredictRejouer(st);

  game.move = function(name, p) {
    var n = ++st.n;
    st.pending.push({ name: name, p: p, n: n });
    _mjpredictRejouer(st);   // (b) application locale IMMÉDIATE, avant tout aller-retour réseau
    return moveOriginal.call(game, name, _mjpredictConNumero(p, n));
  };

  function onServer(frame) {
    st.server = _mjpredictServerSnapshot(st);
    if (frame && typeof frame._ack === 'number') {
      st.ackSeen = true;
      st.pending = st.pending.filter(function(e) { return e.n > frame._ack; });
    } else if (!st.ackSeen) {
      st.pending = [];   // filet v1 « jeu sans _n » — cf. PIÈGE en tête de fichier
    }
    _mjpredictRejouer(st);
  }
  var offState = game.on('state', onServer);
  var offStart = game.on('start', onServer);

  Object.defineProperty(st.mirror, 'stop', {
    value: function() { game.move = moveOriginal; offState(); offStart(); },
    enumerable: false,
    configurable: true
  });
  return st.mirror;
};
