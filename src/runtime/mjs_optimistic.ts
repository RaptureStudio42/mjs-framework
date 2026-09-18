// mjs_optimistic — UI optimiste GÉNÉRIQUE (« DX »), façon Meteor : applique une mutation
// LOCALEMENT tout de suite sur un store réactif EXISTANT, lance une requête (typiquement
// sock.request), et ROLLBACK au snapshot si elle échoue. Généralisation DÉLIBÉRÉE du patron « base +
// file + rejeu » de mjs_predict.ts (TON PATRON, cf. sa tête de fichier) à N'IMPORTE QUEL store et
// N'IMPORTE QUELLE requête — contrairement à µ.predict (qui fabrique SA PROPRE store miroir, dérivée
// d'un `partie.state` distinct jamais touché), µ.optimistic mute DIRECTEMENT le store que l'appelant
// lui donne (celui déjà affiché) : pas de mirror séparé, pas de couture jeu. Module autonome (patron
// 'schema'/'interp'/'predict' : AUCUNE dépendance dure à MjsSocket — `via` accepte n'importe quelle
// fonction -> Promise, sock.request() n'est que l'usage TYPIQUE, cf. avertissement bundler dans
// src/bundler/index.ts::resolveRuntimeFiles).
//
//   $compteur = µ.state({ n: 0 })
//   µ.optimistic($compteur, {
//     appliquer: (etat) -> etat.n += 1               # brouillon (clone) — jamais le store en direct
//     via:       -> sock.request('incrementer', {})  # cf. § SNAPSHOT plus bas
//   })
//   {$compteur.n}   # bouge IMMÉDIATEMENT, avant tout aller-retour serveur
//
// SNAPSHOT — le store ENTIER (toutes les clés énumérables), PAS seulement les clés que `appliquer`
// est censé toucher : ni `appliquer` ni `puis` n'ont de liste `champs` déclarée (contrairement à
// µ.predict/µ.interp) — impossible de savoir À L'AVANCE ce qu'ils vont muter, et `appliquer` peut
// aussi bien renvoyer un `nouvelEtat` COMPLET que muter son brouillon en place. Coût assumé : un clone
// profond de tout le store à chaque rejeu (cf. plus bas) — négligeable pour une store de taille UI
// normale (compteur, formulaire, fil de messages court) ; dédie plutôt une PETITE store à ce que
// µ.optimistic pilote si elle risque de grossir beaucoup.
//
// `appliquer(etat)` reçoit un BROUILLON (clone profond, jamais le store réactif en direct — même
// esprit que mjs_predict.ts::appliquer(fragment,…)) : soit il MUTE `etat` en place et ne renvoie rien
// (`etat.n += 1`), soit il RENVOIE un `nouvelEtat` complet qui REMPLACE le brouillon. Le résultat est
// publié sur le VRAI store en une passe (réassignation clé par clé, clés absentes supprimées — même
// idiome que mjs_socket.ts::_mjs_applyDelta cas 'reset' — sautée si la valeur n'a pas changé, cf.
// mjs_predict.ts::_mjpredictEq) : la réactivité se déclenche SYNCHRONE, avant tout retour réseau,
// exactement comme µ.predict.
//
// EMPILAGE (plusieurs µ.optimistic EN VOL sur LE MÊME store) — stratégie « snapshot chaîné + rejeu
// séquentiel », patron mjs_predict généralisé : une file d'ENTRÉES (une par appel, ordre de création)
// est rejouée PAR-DESSUS une base commune (`base`, clone profond) à chaque changement. Un ÉCHEC retire
// son entrée de la file (n'importe quelle position) — aucune perte pour ses sœurs encore en vol,
// rejouées PAR-DESSUS `base` INCHANGÉE. Un SUCCÈS ne fait avancer `base` que si son entrée est EN TÊTE
// de file (compaction de préfixe CONTIGU, ordre de création) : une entrée confirmée mais bloquée par
// une sœur PLUS ANCIENNE encore en vol reste REJOUÉE (jamais perdue, jamais dupliquée) jusqu'à ce que
// cette sœur se résolve à son tour et libère le préfixe — gère aussi bien deux succès empilés qu'un
// échec pendant qu'une sœur plus récente est encore en vol, quel que soit l'ordre de résolution.
//
// PIÈGE (documenté, assumé — même esprit que le PIÈGE de mjs_predict.ts) : tant qu'AU MOINS une entrée
// est en vol sur une store, µ.optimistic en redevient la SEULE source de vérité à chaque rejeu — une
// mutation extérieure posée sur CETTE MÊME store pendant la fenêtre (autre code applicatif, un autre
// flux réseau qui écrirait dessus) sera ÉCRASÉE au rejeu suivant (succès/échec d'une entrée quelconque,
// même sur une AUTRE clé). Mitigation : dédier une store à ce que µ.optimistic pilote, ou n'empiler
// qu'un seul optimiste à la fois par store si d'autres écritures concurrentes existent.
//
// Cousin spécialisé : µ.predict (mjs_predict.ts, jeux sock.game()) — MÊME patron (snapshot + rejeu),
// spécialisé intentions/serveur-autoritaire-par-tick plutôt que requête/réponse générique.

function _mjoptDeepClone(v) {
  var out, k;
  if (Array.isArray(v)) { out = []; for (k = 0; k < v.length; k++) { out.push(_mjoptDeepClone(v[k])); } return out; }
  if (v && typeof v === 'object') { out = {}; for (k in v) { out[k] = _mjoptDeepClone(v[k]); } return out; }
  return v;
}

// égalité profonde GÉNÉRIQUE — MÊME rôle que mjs_predict.ts::_mjpredictEq (forme quelconque, pas de
// `champs` déclarés ici non plus) : évite une écriture réactive superflue à la publication.
function _mjoptEq(a, b) {
  var k;
  if (a === b) { return true; }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') { return a === b; }
  for (k in b) { if (!_mjoptEq(a[k], b[k])) { return false; } }
  for (k in a) { if (!(k in b)) { return false; } }
  return true;
}

function _mjoptSnapshot(store) {
  var out = {}, k;
  for (k in store) { out[k] = _mjoptDeepClone(store[k]); }
  return out;
}

// appelle `appliquer` sur un brouillon existant — void (rien/undefined/le brouillon lui-même) =
// mutation en place conservée, sinon le `nouvelEtat` renvoyé REMPLACE le brouillon (cf. tête de
// fichier « appliquer(etat) »).
function _mjoptRun(state, apply) {
  var out = apply(state);
  return (out && typeof out === 'object') ? out : state;
}

// réassigne le VRAI store (réactif) pour qu'il reflète `etat` — clé par clé, clés absentes
// supprimées, sautée si inchangée (cf. tête de fichier).
function _mjoptPublier(store, state) {
  var k;
  for (k in store) { if (!(k in state)) { delete store[k]; } }
  for (k in state) { if (!_mjoptEq(store[k], state[k])) { store[k] = state[k]; } }
}

// file par store (WeakMap : jamais de fuite si la store elle-même est jetée) — { base, entries, seq }.
var _mjoptQueues = new WeakMap();
function _mjoptQueueFor(store) {
  var qs = _mjoptQueues.get(store);
  if (!qs) { qs = { base: _mjoptSnapshot(store), entries: [], seq: 0 }; _mjoptQueues.set(store, qs); }
  return qs;
}

// SOURCE UNIQUE (appelée après CHAQUE ajout/succès/échec) — recalcule `etat` ENTIER depuis `base` +
// rejeu de TOUTE la file restante, puis publie. Compaction de préfixe AVANT rejeu (cf. tête de fichier
// § EMPILAGE) : fait avancer `base` pour chaque entrée 'ok' EN TÊTE de file (ordre de création),
// s'arrête à la première encore 'pending' — une entrée 'ok' bloquée reste dans la file, rejouée
// ci-dessous comme les autres, jamais perdue ni dupliquée.
function _mjoptRejouer(store, qs) {
  while (qs.entries.length && qs.entries[0].status === 'ok') {
    qs.base = _mjoptRun(_mjoptDeepClone(qs.base), qs.entries.shift().apply);
  }
  var state = _mjoptDeepClone(qs.base), i;
  for (i = 0; i < qs.entries.length; i++) { state = _mjoptRun(state, qs.entries[i].apply); }
  _mjoptPublier(store, state);
}

// résolution d'une entrée — SUCCÈS : marquée 'ok' (jamais retirée directement, cf. compaction de
// préfixe ci-dessus — une sœur plus ANCIENNE encore en vol doit pouvoir continuer à la rejouer).
// ÉCHEC : retirée IMMÉDIATEMENT, n'importe où dans la file (un échec ne bloque jamais ses sœurs).
function _mjoptSettle(store, qs, entry, ok) {
  var idx = qs.entries.indexOf(entry);
  if (idx === -1) { return; }   // sécurité (déjà réglée)
  if (ok) { entry.status = 'ok'; } else { qs.entries.splice(idx, 1); }
  _mjoptRejouer(store, qs);
}

// --- entrée publique -----------------------------------------------------------------------------

µ.optimistic = function(store, opts) {
  opts = opts || {};
  if (!store || typeof store !== 'object') {
    µ.warn('[µ.optimistic] store invalide (objet attendu, ex. µ.state({...}))');
    return Promise.resolve({ ok: false, error: { code: 'invalid-store', message: 'store invalide' } });
  }
  var apply = typeof opts.apply === 'function' ? opts.apply : function() {};
  var via = typeof opts.via === 'function' ? opts.via : function() { return Promise.resolve(); };
  var qs = _mjoptQueueFor(store);
  var entry = { id: ++qs.seq, apply: apply, status: 'pending' };
  qs.entries.push(entry);
  _mjoptRejouer(store, qs);   // application locale IMMÉDIATE, avant tout aller-retour réseau

  var p;
  try { p = via(); } catch (e) { p = Promise.reject(e); }
  if (!p || typeof p.then !== 'function') { p = Promise.resolve(p); }

  return p.then(
    function(response) {
      if (typeof opts.after === 'function') {
        var before = entry.apply;
        entry.apply = function(state) { return opts.after(_mjoptRun(state, before), response); };
      }
      _mjoptSettle(store, qs, entry, true);
      return { ok: true, response: response };
    },
    function(error) {
      _mjoptSettle(store, qs, entry, false);
      return { ok: false, error: error };
    }
  );
};
