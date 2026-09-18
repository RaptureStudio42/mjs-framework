// mjs_interp — interpolation à tampon (« netcode »), posée PAR-DESSUS sock.game()
// (src/mjs-server/, cf. mjs_game.ts) — MÊME esprit que mjs_smooth.ts (snapshot interpolation) mais
// arrimée aux ÉVÉNEMENTS du protocole µgame:* ('start'/'state', cf. mjs_game.ts::_dispatchGame)
// plutôt qu'à un polling de store source : chaque arrivée est horodatée PRÉCISÉMENT à la réception,
// la période réseau est auto-mesurée (moyenne glissante des écarts d'arrivée) plutôt que fixée en
// dur. Module autonome (patron 'schema' : AUCUNE dépendance dure à MjsSocket/mjs_game.ts, jamais de
// patch prototype — sans 'game' côté bundler, `partie` n'existerait simplement jamais, cf.
// avertissement bundler dans src/bundler/index.ts::resolveRuntimeFiles).
//
//   partie  = sock.game('monjeu')
//   $vue    = µ.interp(partie, { champs: ['entites'], retard: 2 })   # store MIROIR réactif
//   {for id, e in $vue.entites}<mjs-entity {...e} />{/for}           # positions LISSÉES
//   …
//   $vue.stop()   # coupe la boucle de rendu + les abonnements — le vrai partie.state, LUI, continue
//
// `champs` — noms de clés de `partie.state` qui sont des DICTS {id → entité} (forme de `def.view`
// côté jeu, cf. mjs-server/game.ts) : SEULES ces clés apparaissent sur le store miroir renvoyé (les
// clés méta de partie.state — statut/phase/tour… — restent lues DIRECTEMENT sur `partie.state`, le
// jeu choisit ce qu'il branche sur le miroir). `retard` (périodes, défaut 2) : on
// affiche l'état à T − retard×période — la période est la moyenne glissante des N derniers écarts
// d'arrivée réseau (0 tant que 2 arrivées n'ont pas encore été vues → aucun retard, on montre le
// plus récent connu). Lerp linéaire de TOUTES les valeurs NUMÉRIQUES des sous-objets (par clé
// d'entité) ; non-numériques = copiées du plus récent des deux échantillons encadrants (mêmes règles
// que µ._mjs_smoothLerp, mjs_smooth.ts). v1 simplicité (cf. design) : positions/scalaires SEULEMENT, pas
// de slerp/angles — un jeu avec des angles gère sa propre voie courte côté vue.
//
// Trou réseau (aucune arrivée neuve pendant que la cible dépasse le dernier échantillon connu) :
// EXTRAPOLATION bornée à ~1 période (vélocité mesurée entre les 2 derniers échantillons, projetée
// au-delà) puis GEL (la cible reste sur le dernier échantillon, aucune vélocité inventée au-delà).
//
// Boucle de rendu : requestAnimationFrame si dispo, sinon setInterval(16ms) — repli nécessaire pour
// tourner en environnement de test Node (aucun DOM, cf. tests/socket-netcode.test.ts) SANS jamais
// crasher en prod (même esprit que le repli documenté par mjs_ujs.ts pour le scroll restauré).
// Aucune dépendance à µ.Ticker (mjs_runes.ts) : celui-ci appelle requestAnimationFrame SANS repli
// (cœur, pensé pour un contexte navigateur uniquement) — inadapté ici, où le repli EST le contrat.

// période/tampon — constantes locales (mangle-safe, jamais sur `µ`)
var MJINTERP_BUF_MAX    = 30;   // échantillons bruts conservés (≈ mjs_smooth.ts maxSamples)
var MJINTERP_PERIODE_ECH = 8;   // fenêtre de la moyenne glissante des écarts d'arrivée

// boucle rAF (repli setInterval 16ms si indisponible) — LOCALE à ce fichier (chaque module runtime
// optionnel reste concaténé SEUL, cf. mjs_schema.ts tête de fichier : zéro import/export, jamais de
// dépendance à un AUTRE mjs_*.ts optionnel qui pourrait être absent de la sélection bundler).
// Renvoie directement la fonction `stop`.
function _mjinterpLoop(step) {
  var raf = typeof requestAnimationFrame === 'function', vivant = true, id;
  function frame() { if (!vivant) { return; } step(); if (raf) { id = requestAnimationFrame(frame); } }
  if (raf) { id = requestAnimationFrame(frame); } else { id = setInterval(step, 16); }
  return function() {
    vivant = false;
    if (raf) { if (typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(id); } }
    else { clearInterval(id); }
  };
}

// clone superficiel d'une entité (1 niveau — cf. tête de fichier, "sous-objets" = scalaires plats)
function _mjinterpCloneEnt(ent) {
  var clone = {}, k;
  for (k in ent) { clone[k] = ent[k]; }
  return clone;
}

// capture l'état COURANT des champs déclarés — clone CHAQUE entité (jamais un alias vers
// partie.state : une mutation ultérieure en place — mode delta — corromprait sinon RÉTROACTIVEMENT
// les échantillons déjà tamponnés, cf. même piège documenté par mjs_smooth.ts).
function _mjinterpSnap(game, fields) {
  var out = {}, i, c, dict, id, ent;
  for (i = 0; i < fields.length; i++) {
    c = fields[i];
    dict = game.state[c];
    out[c] = {};
    if (!dict || typeof dict !== 'object') { continue; }
    for (id in dict) {
      ent = dict[id];
      out[c][id] = (ent && typeof ent === 'object') ? _mjinterpCloneEnt(ent) : ent;
    }
  }
  return out;
}

// lerp d'une entité — numériques interpolés (r peut dépasser 1 : extrapolation, cf.
// _mjinterpExtrapoler), non-numériques = valeur de `b` (le plus récent des deux échantillons).
function _mjinterpLerpEnt(a, b, r) {
  var out = {}, k;
  for (k in b) { out[k] = (typeof a[k] === 'number' && typeof b[k] === 'number') ? a[k] + (b[k] - a[k]) * r : b[k]; }
  return out;
}

// lerp d'une trame entière (tous les champs déclarés) — une entité absente de `a` (apparue depuis)
// est copiée telle quelle depuis `b` (aucun partenaire à interpoler) ; une entité absente de `b`
// (disparue depuis) n'apparaît PLUS dans le résultat — `b` est la vérité la plus récente des deux.
function _mjinterpLerpFrame(a, b, r, fields) {
  var out = {}, i, c, dictA, dictB, res, id;
  for (i = 0; i < fields.length; i++) {
    c = fields[i];
    dictA = a[c] || {}; dictB = b[c] || {};
    res = {};
    for (id in dictB) {
      res[id] = (dictA[id] && typeof dictA[id] === 'object' && typeof dictB[id] === 'object')
        ? _mjinterpLerpEnt(dictA[id], dictB[id], r)
        : dictB[id];
    }
    out[c] = res;
  }
  return out;
}

// trou d'arrivée (cible au-delà du dernier échantillon connu) — extrapole via la vélocité mesurée
// entre les 2 DERNIERS échantillons, borné à ~1 période (`gap <= periode`) ; au-delà (ou vélocité
// inconnue : buffer trop court/période pas encore mesurée), GEL sur le dernier échantillon (r=1,
// aucune extrapolation) — jamais de projection sans fin.
function _mjinterpExtrapoler(buf, target, periode, fields) {
  var n = buf.length, last = buf[n - 1], before, gap, dt, r;
  gap = target - last.t;
  if (n < 2 || periode <= 0 || gap > periode) { return last.val; }
  before = buf[n - 2];
  dt = last.t - before.t;
  r = dt > 0 ? 1 + gap / dt : 1;
  return _mjinterpLerpFrame(before.val, last.val, r, fields);
}

// égalité profonde MINIMALE (entité par entité, dict par dict) — évite une écriture réactive quand
// rien n'a visiblement changé (ex. figé pendant le gel post-trou) ; même esprit que µ._mjs_smoothEq.
function _mjinterpEqEnt(a, b) {
  var k;
  if (a === b) { return true; }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') { return a === b; }
  for (k in b) { if (a[k] !== b[k]) { return false; } }
  for (k in a) { if (!(k in b)) { return false; } }
  return true;
}

function _mjinterpEqDict(a, b) {
  var k;
  if (a === b) { return true; }
  if (!a || !b) { return false; }
  for (k in b) { if (!_mjinterpEqEnt(a[k], b[k])) { return false; } }
  for (k in a) { if (!(k in b)) { return false; } }
  return true;
}

// nouvelle arrivée ('start'/'state', cf. mjs_game.ts::_dispatchGame) — horodate au moment de la
// RÉCEPTION (jamais un timestamp serveur, cf. tête de fichier), avance la moyenne glissante de
// période dès la 2e arrivée, purge le tampon au-delà de MJINTERP_BUF_MAX.
function _mjinterpArrival(st) {
  var now = Date.now(), snap = _mjinterpSnap(st.game, st.fields), last;
  if (st.buffer.length) {
    last = st.buffer[st.buffer.length - 1];
    st.deltas.push(now - last.t);
    if (st.deltas.length > MJINTERP_PERIODE_ECH) { st.deltas.shift(); }
  }
  st.buffer.push({ t: now, val: snap });
  if (st.buffer.length > MJINTERP_BUF_MAX) { st.buffer.shift(); }
}

// publie `val` sur le store miroir — réassignation COMPLÈTE par champ (jamais une mutation profonde
// en place) : même stratégie que _syncGameStore (mjs_game.ts), robuste à un `µ.state` aussi bien
// profondément réactif (proxy imbriqué, cf. mjs_runes.ts) qu'un stub plat de test — le trap de SET
// de PREMIER NIVEAU se déclenche à coup sûr dans les deux cas. Sautée si valeur INCHANGÉE (perf).
function _mjinterpPublier(st, val) {
  var i, c;
  for (i = 0; i < st.fields.length; i++) {
    c = st.fields[i];
    if (!_mjinterpEqDict(st.mirror[c], val[c])) { st.mirror[c] = val[c]; }
  }
}

// pas de rendu — calcule la cible T-retard×période, résout par bracket/extrapolation/gel, publie.
function _mjinterpRender(st) {
  var now = Date.now(), buf = st.buffer, n = buf.length, periode, target, i, a, b, r, val;
  if (n === 0) { return; }
  periode = st.deltas.length ? (st.deltas.reduce(function(acc, d) { return acc + d; }, 0) / st.deltas.length) : 0;
  target = now - st.delay * periode;
  if (n === 1 || target <= buf[0].t) {
    val = buf[0].val;
  } else if (target >= buf[n - 1].t) {
    val = _mjinterpExtrapoler(buf, target, periode, st.fields);
  } else {
    for (i = 0; i < n - 1; i++) { if (target >= buf[i].t && target <= buf[i + 1].t) { a = buf[i]; b = buf[i + 1]; break; } }
    r = (b.t - a.t) > 0 ? (target - a.t) / (b.t - a.t) : 1;
    val = _mjinterpLerpFrame(a.val, b.val, r, st.fields);
  }
  _mjinterpPublier(st, val);
}

// --- entrée publique -----------------------------------------------------------------------------

µ.interp = function(game, opts) {
  opts = opts || {};
  var fields = opts.fields || [];
  var delay = opts.delay != null ? opts.delay : 2;
  var st = { game: game, fields: fields, delay: delay, buffer: [], deltas: [], mirror: µ.state({}) };
  var i;
  for (i = 0; i < fields.length; i++) { st.mirror[fields[i]] = {}; }

  _mjinterpArrival(st);   // amorce le tampon avec l'état COURANT — pas d'attente du 1er événement réseau
  var offState = game.on('state', function() { _mjinterpArrival(st); });
  var offStart = game.on('start', function() { _mjinterpArrival(st); });
  var stopLoop = _mjinterpLoop(function() { _mjinterpRender(st); });

  Object.defineProperty(st.mirror, 'stop', {
    value: function() { stopLoop(); offState(); offStart(); },
    enumerable: false,
    configurable: true
  });
  return st.mirror;
};
