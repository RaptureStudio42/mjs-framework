// mjs_lockstep — lockstep déterministe CÔTÉ CLIENT (« netcode »), posé PAR-DESSUS
// sock.game() (src/mjs-server/, mode def.mode:'lockstep' — cf. mjs-server/lockstep.ts pour le contrat
// serveur complet). Module 'schema' (AUCUNE dépendance dure à MjsSocket, cf. mjs_interp.ts en tête de
// fichier pour le patron) — mais INERTE (µ.lockstep jamais défini) sans µ.random (module 'det', cf.
// mjs_det.ts) : garde `typeof µ.random === 'function'` ci-dessous, jamais un crash au chargement.
//
//   partie = sock.game('rts', { code: true })     # def.mode:'lockstep' côté serveur
//   $etat  = µ.lockstep(partie, {
//     etat0:     function() { return { unites: {} }; },
//     appliquer: function(etat, ordre) { ... },    # ordre = {joueur, coup, p} — MÊME forme que
//                                                   # l'ordre en file côté serveur, cf. lockstep.ts
//     chaque: 60                                    # hash FNV toutes les 60 ticks — défaut 60
//   });
//   partie.move('bouger', { dx: 1, dy: 0 })   # émet l'ORDRE — INCHANGÉ (µ.lockstep n'enveloppe PAS
//                                              # .move, contrairement à µ.predict : tous les clients,
//                                              # ÉMETTEUR compris, attendent le retour µgame:orders)
//   {$etat.unites[...]}    # store réactif — le jeu rend dessus
//   $etat.rng.next()       # RNG PARTAGÉ (mulberry32, graine du serveur, cf. mjs_det.ts µ.random) —
//                          # closure sur `$etat` DANS `appliquer` (assigné avant tout événement
//                          # réseau, cf. boucle événementielle JS — jamais `null` à l'usage réel)
//   $etat.stop()
//
// ORDONNANCEMENT — µgame:orders arrive TICK PAR TICK (cf. mjs-server/lockstep.ts _diffuserOrdresTick) :
// tamponné par numéro de tick, appliqué en SÉQUENCE STRICTE (jamais un saut, cf. _mjlockstepDrainer)
// — un tick en avance sur `prochainTick` est mis en réserve jusqu'à ce que les précédents comblent le
// trou (réordre théorique seulement, WebSocket livre en ordre sur UNE connexion continue).
//
// RÉINITIALISATION — 'start' (1re assise) ET 'state' (résync après reconnexion, cf. mjs_game.ts
// _mjs_onResyncResolved) portent TOUS DEUX `{seed, journal}` (cf. mjs-server/game.ts::_infoMode) : MÊME
// traitement pour les deux (_mjlockstepReinit) — repart de `etat0()`, REJOUE le journal COMPLET reçu
// (déjà connu ou manqué pendant la coupure), puis reprend le direct au tick suivant.
//
// JOURNAL TRONQUÉ — `def.lockstepJournal.maxTicks` CÔTÉ SERVEUR (mjs-server/lockstep.ts)
// borne le journal en anneau : un client trop longtemps déconnecté (raté plus de `maxTicks` ticks) reçoit
// au resync un journal qui NE COMMENCE PLUS au tick 1 — jusqu'ici rejoué SILENCIEUSEMENT depuis `etat0()`
// comme s'il était complet, état local FAUX sans le savoir avant le prochain quorum de hash (tardif, cf.
// DIVERGENCE ci-dessous). `_mjlockstepAnomalieJournal` détecte désormais CETTE anomalie (tête tronquée
// OU trou de continuité, filet défensif) AVANT le rejeu : log (µ.error) + un événement CLIENT-LOCAL
// équivalent à une divergence (`partie.on('event', fn)`, MÊME canal que la vraie divergence serveur
// ci-dessous, raison dédiée `'journal-truncated'`) — le replay continue ENSUITE inchangé, on signale, on
// ne bloque pas (cf. _mjlockstepDispatchEvent, _mjlockstepReinit).
//
// DIVERGENCE — toutes les `chaque` ticks, hash FNV-1a de `JSON.stringify(etat)` envoyé en
// µgame:hash (cf. partie._hash, mjs_game.ts) ; MÊME algorithme que deterministicSeed côté serveur
// (mjs-server/lockstep.ts), usage différent (état, pas id). Piège connu : l'ordre d'insertion des clés
// d'un objet JS influence JSON.stringify — si `appliquer` construit ses objets dans un ordre
// DÉPENDANT DES DONNÉES qui diffère entre clients, le hash pourrait diverger sans vraie divergence de
// jeu ; garder une construction d'objet stable (même code, même ordre partout) évite le piège.

if (typeof µ.random === 'function') {

// FNV-1a 32 bits — MÊME algorithme que mjs-server/lockstep.ts::deterministicSeed (cf. tête de fichier)
function _mjlockstepFnv(str) {
  var h = 0x811c9dc5, i;
  for (i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

function _mjlockstepAnnounceHash(st, tick) {
  st.game._hash(tick, _mjlockstepFnv(JSON.stringify(st.state)));
}

// applique CHAQUE ordre du tick (dans l'ordre du tableau — MÊME ordre pour tous, cf. tête de fichier),
// avance `prochainTick`, annonce le hash toutes les `chaque` ticks (0 = jamais)
function _mjlockstepReplayTick(st, tick, orders) {
  var i;
  for (i = 0; i < orders.length; i++) { st.apply(st.state, orders[i]); }
  st.nextTick = tick + 1;
  if (st.every > 0 && tick % st.every === 0) { _mjlockstepAnnounceHash(st, tick); }
}

// draine le tampon — applique tout tick CONSÉCUTIF déjà arrivé, jamais de saut (cf. tête de fichier)
function _mjlockstepDrain(st) {
  var group;
  while ((group = st.buffer[st.nextTick]) !== undefined) {
    delete st.buffer[st.nextTick];
    _mjlockstepReplayTick(st, group.tick, group.orders);
  }
}

// µgame:orders EN DIRECT — tick déjà couvert (résync/doublon) → ignoré ; sinon tamponné + drainage
function _mjlockstepOnOrders(st, frame) {
  if (typeof frame.tick !== 'number' || !frame.orders) { return; }
  if (frame.tick < st.nextTick) { return; }
  st.buffer[frame.tick] = frame;
  _mjlockstepDrain(st);
  _mjlockstepPublish(st);
}

// republie l'état sur le store réactif — réassignation PAR CLÉ RACINE (même stratégie que
// mjs_predict.ts::_mjpredictPublier) : `appliquer` mute `st.etat` EN PLACE, republier RECOPIE ses
// clés vers le store, où µ.state() observe chaque écriture (jamais un remplacement de RÉFÉRENCE de
// `st.etat` lui-même — le jeu garde la même identité d'objet d'un tick à l'autre).
function _mjlockstepPublish(st) {
  var k;
  for (k in st.state) { st.store[k] = st.state[k]; }
}

// continuité du journal reçu au resync (cf. tête de fichier « JOURNAL TRONQUÉ ») — deux
// anomalies possibles : (a) `journal[0].tick > 1` (tête tronquée, cf. lockstepJournal.maxTicks côté
// serveur) ; (b) trou entre deux entrées consécutives (tick n → tick n+2 — jamais produit par le vrai
// serveur, closeTick incrémente TOUJOURS de 1, cf. mjs-server/lockstep.ts — filet défensif). Journal
// VIDE = partie neuve, RAS (aucune anomalie, chemin nominal INCHANGÉ).
function _mjlockstepJournalAnomaly(journal) {
  var i;
  if (journal.length === 0) { return null; }
  if (journal[0].tick > 1) { return { tick: journal[0].tick, expected: 1 }; }
  for (i = 1; i < journal.length; i++) {
    if (journal[i].tick !== journal[i - 1].tick + 1) { return { tick: journal[i].tick, expected: journal[i - 1].tick + 1 }; }
  }
  return null;
}

// notifie l'appli EXACTEMENT comme une divergence SERVEUR (même canal `partie.on('event', fn)`, cf.
// mjs_game.ts::_dispatchGame) — CLIENT-LOCAL, jamais émis sur le réseau. Réimplémenté ICI (jamais un
// appel direct à _dispatchGame, PRIVÉE au scope de mjs_game.ts) via `partie._mjs_handlers`, la structure
// MÊME que `.on()` alimente et que _dispatchGame lit — aucun nouveau système d'événements.
function _mjlockstepDispatchEvent(st, type, p) {
  var hs = st.game._mjs_handlers && st.game._mjs_handlers['event'], copy, i;
  if (!hs) { return; }
  copy = hs.slice();
  for (i = 0; i < copy.length; i++) { try { copy[i]({ game: st.game._mjs_gameId, type: type, p: p }); } catch (e) { µ.error('[µ.lockstep] event handler', e); } }
}

// réinitialisation COMPLÈTE — 'start' (1re assise) ET 'state' (résync), cf. tête de fichier :
// `frame.seed` absent (typeof !== 'number') = partie PAS en mode lockstep côté serveur (def.mode
// oublié/mal réglé) — signalé (µ.error) puis INERTE, jamais un throw qui casserait l'appelant.
function _mjlockstepReset(st, frame) {
  var i, g, journal, anomaly;
  if (typeof frame.seed !== 'number') {
    µ.error("[µ.lockstep] partie '"+ (frame.game || '?') +"' n'est pas en mode lockstep côté serveur (def.mode) — µ.lockstep restera inerte");
    return;
  }
  st.seed = frame.seed;
  st.rng = µ.random(frame.seed);
  st.state = st.state0();
  st.buffer = {};
  st.nextTick = 1;
  journal = frame.journal || [];
  anomaly = _mjlockstepJournalAnomaly(journal);
  if (anomaly) {
    µ.error("[µ.lockstep] journal tronqué au resync (tick "+ anomaly.tick +" reçu, tick "+ anomaly.expected +" attendu) — resync déterministe impossible, état local potentiellement faux");
    _mjlockstepDispatchEvent(st, 'divergence', { tick: anomaly.tick, expected: anomaly.expected, reason: 'journal-truncated' });
  }
  for (i = 0; i < journal.length; i++) { g = journal[i]; _mjlockstepReplayTick(st, g.tick, g.orders); }
  _mjlockstepPublish(st);
}

// --- entrée publique -----------------------------------------------------------------------------

µ.lockstep = function(game, opts) {
  opts = opts || {};
  var state0     = typeof opts.state0 === 'function' ? opts.state0 : function() { return {}; };
  var apply = typeof opts.apply === 'function' ? opts.apply : function() {};
  var every    = opts.every != null ? opts.every : 60;
  var st = {
    game: game, state0: state0, apply: apply, every: every,
    state: state0(), seed: null, rng: null, buffer: {}, nextTick: 1, store: µ.state({})
  };

  _mjlockstepPublish(st);   // amorce le store avec l'état LOCAL initial — pas d'attente du réseau

  var offOrders = game.on('orders', function(frame) { _mjlockstepOnOrders(st, frame); });
  var offStart  = game.on('start',  function(frame) { _mjlockstepReset(st, frame); });
  var offState  = game.on('state',  function(frame) { _mjlockstepReset(st, frame); });

  Object.defineProperty(st.store, 'stop', {
    value: function() { offOrders(); offStart(); offState(); },
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(st.store, 'rng', {
    get: function() { return st.rng; },
    enumerable: false,
    configurable: true
  });
  return st.store;
};

}
