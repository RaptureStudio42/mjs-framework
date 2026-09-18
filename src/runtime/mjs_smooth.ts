// mjs_smooth — lissage réseau (snapshot interpolation, façon netcode).
//
// µ.smooth(source, opts) prend un store de positions BRUTES (mises à jour par
// à-coups, ex. reçues toutes les ~100ms par µ.socket) et renvoie un store
// réactif FLUIDE : à chaque frame on affiche la position « il y a `retard` ms »
// en interpolant linéairement entre les deux échantillons horodatés qui
// l'encadrent. Le petit retard garantit qu'on a toujours un échantillon
// « futur » vers lequel glisser → mouvement continu malgré le réseau saccadé.
//
//   $$brut   = sock.stream 'positions'
//   $$fluide = µ.smooth $$brut, { retard: 100, owner: @ }
//   {for id, p in $$fluide}<mjs-entity {...p} />{end}
//
// NB : ≠ µ.interpolate (qui anime UNE valeur vers une cible sur une durée).
// Ici on rejoue un flux continu de positions multi-entités.
//
// `owner` (recommandé, ex. `this`/`@` du composant appelant) : auto-dispose
// à la destruction de CE composant (via `_mjs_onDestroy`). Sans lui, `$$fluide`
// tourne À VIE (boucle rAF perpétuelle — contrairement à µspring/µ.interpolate,
// ce flux ne se "stabilise" jamais tout seul) tant que `.dispose()` n'est pas
// appelé manuellement (ex. `µdestroy -> $$fluide.dispose()`).

// --- cœur pur (exposé pour les tests) ---

// Position interpolée dans un tampon trié `[{ t, pos }]` à l'instant `t`.
// PERF — `_smoothSampleAt` accepte un index de départ `fromIdx` :
// le temps cible étant MONOTONE croissant par entité (cf. `_mjs_step`), la recherche
// reprend au dernier index encadrant trouvé → O(1) amorti au lieu d'un balayage
// linéaire du tampon à CHAQUE frame ET par entité. Renvoie `{ pos, idx }` (idx =
// borne basse retenue, pour la reprise). `µ._mjs_smoothSample` (exposé + tests) reste
// un wrapper SANS état qui démarre à 0 → contrat inchangé pour les appelants.
var _smoothSampleAt = function(buf, t, fromIdx) {
  var i, a, b, span, r, lastSample;
  if (buf.length === 0) { return { pos: null, idx: 0 }; }
  if (t <= buf[0].t) { return { pos: buf[0].pos, idx: 0 }; }
  lastSample = buf[buf.length - 1];
  if (t >= lastSample.t) { return { pos: lastSample.pos, idx: buf.length - 1 }; }
  for (i = fromIdx > 0 ? fromIdx : 0; i < buf.length - 1; i++) {
    a = buf[i];
    b = buf[i + 1];
    if (t >= a.t && t <= b.t) {
      span = b.t - a.t;
      r = span > 0 ? (t - a.t) / span : 1;
      return { pos: µ._mjs_smoothLerp(a.pos, b.pos, r), idx: i };
    }
  }
  return { pos: lastSample.pos, idx: buf.length - 1 };
};

µ._mjs_smoothSample = function(buf, t) {
  return _smoothSampleAt(buf, t, 0).pos;
};

// Interpolation linéaire champ par champ ; les champs non-numériques prennent
// la valeur d'arrivée (ex. une couleur, un nom).
µ._mjs_smoothLerp = function(a, b, r) {
  var out = {}, k;
  for (k in b) {
    out[k] = (typeof a[k] === 'number' && typeof b[k] === 'number')
      ? a[k] + (b[k] - a[k]) * r
      : b[k];
  }
  return out;
};

// Égalité superficielle de deux positions (pour ne pas dupliquer un échantillon
// identique frame après frame).
// Object.is plutôt que !== : NaN !== NaN vaut TOUJOURS vrai en JS — un champ figé à NaN
// n'était donc JAMAIS reconnu « identique », repoussant un nouvel échantillon à chaque frame.
µ._mjs_smoothEq = function(a, b) {
  var k;
  if (a === b) { return true; }
  if (a == null || b == null) { return false; }
  for (k in b) { if (!Object.is(a[k], b[k])) { return false; } }
  for (k in a) { if (!(k in b)) { return false; } }
  return true;
};

// un échantillon réseau non fini (Infinity/-Infinity/NaN — ex. un `1e309` qui traverse
// JSON.parse sans lever) casse `_mjs_smoothLerp` (Infinity - Infinity = NaN, propagé tel quel dans le
// store affiché) : jamais retenu dans le tampon, averti UNE SEULE fois PAR FLUX (pas par échantillon
// perdu) — le drapeau `_smoothWarnedNonFinite` vit désormais dans µ.smooth (var de CLOSURE, pas de
// module).
function _smoothEstFini(pos) {
  var k;
  for (k in pos) { if (typeof pos[k] === 'number' && !isFinite(pos[k])) { return false; } }
  return true;
}

// --- enveloppe réactive ---

µ.smooth = function(source, opts) {
  opts = opts || {};
  var delay = (opts.retard != null) ? opts.retard
            : (opts.delay != null) ? opts.delay
            : 100;
  var maxSamples = opts.maxSamples || 30;
  var out = µ.state({});
  var buffers = {};   // id -> [{ t, pos }]
  var cursors = {};   // id -> dernier index encadrant (reprise O(1))
  var live = true;
  // avertissement échantillon non fini — PAR INSTANCE, comme
  // lastError/_mjs_queueOverflowWarned de mjs_socket.ts (this._xxx, classe) — ici en var de CLOSURE
  // (µ.smooth est une factory, pas une classe) : AVANT, `_smoothWarnedNonFinite` était une var de
  // MODULE partagée entre TOUS les flux lissés — un 2e flux distinct recevant un échantillon non
  // fini restait silencieux à vie une fois le 1er flux déjà averti.
  var _smoothWarnedNonFinite = false;

  var task = {
    _mjs_step: function(now) {
      var id, pos, buf, last, clone, k, target, res;
      if (!live) { return false; }
      // 1. échantillonner la source (positions brutes du réseau)
      for (id in source) {
        pos = source[id];
        if (pos == null || typeof pos !== 'object') { continue; }
        // échantillon corrompu (Infinity/NaN, ex. 1e309 côté réseau) : jamais retenu,
        // sinon _mjs_smoothLerp propage un NaN dans le store affiché — averti UNE fois, pas par trame
        if (!_smoothEstFini(pos)) {
          if (!_smoothWarnedNonFinite) { _smoothWarnedNonFinite = true; µ.warn('[µ.smooth] échantillon non fini (Infinity/NaN) ignoré pour \'' + id + '\''); }
          continue;
        }
        buf = buffers[id] || (buffers[id] = []);
        last = buf.length ? buf[buf.length - 1].pos : null;
        if (last === null || !µ._mjs_smoothEq(last, pos)) {
          clone = {};
          for (k in pos) { clone[k] = pos[k]; }
          buf.push({ t: now, pos: clone });
          // PERF — `shift()` retire la TÊTE : l'index mémorisé de
          // cette entité doit reculer d'un cran pour rester valide.
          if (buf.length > maxSamples) {
            buf.shift();
            if (cursors[id] > 0) { cursors[id]--; }
          }
        }
      }
      // 2. afficher « il y a `delay` ms » en interpolant + purger les disparus
      target = now - delay;
      for (id in buffers) {
        if (!(id in source) || source[id] == null) {
          delete buffers[id];
          delete out[id];
          delete cursors[id];
          continue;
        }
        // PERF — reprise au dernier index encadrant (target monotone
        // → O(1) amorti). Au repos, `_smoothSampleAt` renvoie la MÊME référence
        // (dernier échantillon) → le set trap de µ.state court-circuite (pas de
        // re-render superflu) — cf. « skip repos ».
        res = _smoothSampleAt(buffers[id], target, cursors[id] || 0);
        if (res.pos != null) { out[id] = res.pos; }
        cursors[id] = res.idx;
      }
      return true;
    }
  };
  µ.Ticker.add(task);

  var disposeFn = function() {
    live = false;
    if (µ.Ticker._mjs_tasks) { µ.Ticker._mjs_tasks.delete(task); }
  };

  // dispose() non énumérable → n'apparaît pas dans un {for id, p in $$fluide}.
  Object.defineProperty(out, 'dispose', {
    value: disposeFn,
    enumerable: false,
    configurable: true
  });

  // auto-dispose au destroy du
  // composant créateur. Contrairement à µspring/µ.interpolate qui s'arrêtent
  // NATURELLEMENT en se stabilisant (`_mjs_step` retourne `false` une fois la
  // cible atteinte, `µ.Ticker` retire alors la tâche de lui-même), `_mjs_step`
  // ICI retourne TOUJOURS `true` (flux continu par design — il n'y a pas de
  // notion de "stabilisé" pour un flux réseau live) : sans dispose explicite,
  // la tâche tourne À VIE (buffers non bornés dans le temps + boucle rAF
  // perpétuelle), même si le composant qui a créé `$$fluide` a disparu depuis
  // longtemps. `µ.smooth` ne peut pas deviner "qui m'appelle" (appel de
  // fonction nu, pas de `this` de l'appelant côté callee) — fournir
  // `opts.owner` (typiquement `this` du composant, dans son `<script>`) est le
  // point d'accroche minimal : on réutilise `_mjs_onDestroy` (mjs_element.ts),
  // l'API interne DÉJÀ prévue pour ça ("stores, routeur, animations, code
  // utilisateur… s'inscrivent sans s'écraser mutuellement", équivalent
  // `onCleanup` de Solid) — pas de nouveau mécanisme, juste un appelant de
  // plus. Rétrocompatible : sans `owner`, comportement inchangé (dispose()
  // manuel, ex. via `@destroy`).
  if (opts.owner && typeof opts.owner._mjs_onDestroy === 'function') {
    opts.owner._mjs_onDestroy(disposeFn);
  }

  return out;
};
