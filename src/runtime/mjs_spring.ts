// mjs_spring.coffee
// Ressort physique. Supporte les valeurs SCALAIRES (un nombre) ET les valeurs
// composites (objet `{x, y}` ou tableau `[a, b]` de nombres, récursivement) —
// comme la classe `Spring` de Svelte 5 : un seul ressort pilote plusieurs axes
// avec une stiffness/damping partagée. Le step interpole chaque composante
// numérique indépendamment.
var MjsPhysicsSpring;

// Helpers (locaux → mangle-safe, pas sur `µ`).
function _mjsIsNum(v) {
  return typeof v === 'number';
}

function _mjsZeroLike(v) {
  if (_mjsIsNum(v)) {
    return 0;
  }
  if (Array.isArray(v)) {
    return v.map(_mjsZeroLike);
  }
  if (v && typeof v === 'object') {
    var o = {}, k;
    for (k in v) {
      o[k] = _mjsZeroLike(v[k]);
    }
    return o;
  }
  return 0;
}

// Avance une valeur (récursive) d'un pas de ressort. Retourne {value, velocity}
// de la même forme. `ctx.settled` passe à false dès qu'une composante bouge
// encore (façon `tick_spring` de Svelte).
// UNION courant∪cible — AVANT : bornée sur
// les clés/index de `cur` SEULEMENT, une clé SEULEMENT dans `tgt` n'animait
// jamais (pop à la dernière frame) et une clé ABSENTE de `tgt` produisait un
// NaN qui figeait tout le ressort. Chaque clé/index suit désormais SA PROPRE
// règle, indépendante des autres : absente de la cible → garde sa valeur
// courante (figée, ne bloque pas les autres axes) ; absente de current →
// apparaît directement à la valeur cible (sans animer CET axe).
function _mjsSpringStep(cur, tgt, vel, stiffness, damping, precision, ctx) {
  var delta, force, next, i, k, vals, vels, r, len, curHas, tgtHas, allKeys;
  if (_mjsIsNum(cur)) {
    delta = tgt - cur;
    force = (delta * stiffness) - (vel * damping);
    vel = vel + force;
    next = cur + vel;
    if (Math.abs(vel) < precision && Math.abs(tgt - next) < precision) {
      return { value: tgt, velocity: 0 };
    }
    ctx.settled = false;
    return { value: next, velocity: vel };
  }
  if (Array.isArray(cur)) {
    vals = []; vels = [];
    len = Math.max(cur.length, Array.isArray(tgt) ? tgt.length : 0);
    for (i = 0; i < len; i++) {
      curHas = i < cur.length;
      tgtHas = Array.isArray(tgt) && i < tgt.length;
      if (curHas && !tgtHas) {
        vals.push(cur[i]); vels.push(0); // index absent de la cible : figé
      } else if (!curHas && tgtHas) {
        vals.push(tgt[i]); vels.push(0); // index absent de current : apparaît direct
      } else {
        r = _mjsSpringStep(cur[i], tgt[i], vel[i], stiffness, damping, precision, ctx);
        vals.push(r.value); vels.push(r.velocity);
      }
    }
    return { value: vals, velocity: vels };
  }
  if (cur && typeof cur === 'object') {
    vals = {}; vels = {};
    allKeys = new Set(Object.keys(cur));
    if (tgt && typeof tgt === 'object') {
      for (k in tgt) { allKeys.add(k); }
    }
    for (k of allKeys) {
      curHas = Object.prototype.hasOwnProperty.call(cur, k);
      tgtHas = tgt && Object.prototype.hasOwnProperty.call(tgt, k);
      if (curHas && !tgtHas) {
        vals[k] = cur[k]; vels[k] = 0; // clé absente de la cible : figée
      } else if (!curHas && tgtHas) {
        vals[k] = tgt[k]; vels[k] = 0; // clé absente de current : apparaît direct
      } else {
        r = _mjsSpringStep(cur[k], tgt[k], vel[k], stiffness, damping, precision, ctx);
        vals[k] = r.value; vels[k] = r.velocity;
      }
    }
    return { value: vals, velocity: vels };
  }
  // Composante non numérique (string…) : on saute directement à la cible.
  return { value: tgt, velocity: 0 };
}

// Forme (clés d'objet, longueur de tableau) différente entre current et une
// nouvelle cible composite ? Sert UNIQUEMENT au warn — posé UNE fois au `set`
// (jamais dans `_mjsSpringStep`, rappelée à chaque frame).
function _mjsShapeDiffers(cur, tgt) {
  var curIsArr = Array.isArray(cur), tgtIsArr = Array.isArray(tgt), curKeys, k;
  if (curIsArr || tgtIsArr) {
    return !curIsArr || !tgtIsArr || cur.length !== tgt.length;
  }
  if (cur && tgt && typeof cur === 'object' && typeof tgt === 'object') {
    curKeys = Object.keys(cur);
    if (curKeys.length !== Object.keys(tgt).length) { return true; }
    for (k of curKeys) {
      if (!Object.prototype.hasOwnProperty.call(tgt, k)) { return true; }
    }
    return false;
  }
  return false;
}

function _mjsDeepFinite(v) {
  if (_mjsIsNum(v)) {
    return Number.isFinite(v);
  }
  if (Array.isArray(v)) {
    return v.every(_mjsDeepFinite);
  }
  if (v && typeof v === 'object') {
    var k;
    for (k in v) {
      if (!_mjsDeepFinite(v[k])) {
        return false;
      }
    }
    return true;
  }
  return true;
}

// --- Bornes de STABILITÉ du schéma d'Euler (sans dt) ---
// La récurrence `vel += k*(tgt-cur) - c*vel ; next = cur + vel` DIVERGE
// (→ Infinity/NaN → boucle rAF infinie) dès que `stiffness >= 4 - 2*damping`
// (critère de Jury de la matrice d'état 2×2). Au damping défaut 0.8, la borne
// tombe à 2.4 : un `stiffness` ≥ 2.4 explose. On clampe donc stiffness JUSTE
// sous cette borne, et damping dans [0, 1].
function _mjsClampDamping(c) {
  if (!_mjsIsNum(c) || !Number.isFinite(c)) {
    return 0.8;
  }
  // `damping=0` était accepté (borne basse à 0).
  // Or le déterminant de la matrice d'état de la récurrence est `1-c` : à
  // c=0, il vaut 1 → l'schéma d'Euler semi-implicite ne PERD jamais d'énergie
  // → oscillation ENTRETENUE indéfiniment (jamais `|vel| < precision` ET
  // `|tgt-next| < precision` simultanément) → `_mjs_step` retourne toujours
  // `true` → tâche µ.Ticker/rAF IMMORTELLE, même après destroy du composant.
  // Plancher epsilon (au lieu de 0 strict) pour garantir une dissipation
  // minimale et donc un settle garanti en temps fini.
  return Math.max(0.01, Math.min(c, 1));
}

function _mjsClampStiffness(k, c) {
  var maxStable = 4 - 2 * c - 0.01; // marge de sécurité sous la borne
  if (!_mjsIsNum(k) || !Number.isFinite(k)) {
    return Math.min(0.15, maxStable);
  }
  return Math.max(0.001, Math.min(k, maxStable));
}

// plancher de PRÉCISION. La condition de settle
// (`|vel| < precision` ET `|tgt-next| < precision`) devient INATTEIGNABLE si
// `precision <= 0` (ou NaN/Infinity) → `_mjs_step` ne retourne jamais false → tâche
// µ.Ticker/rAF IMMORTELLE, même après destroy (exacte même classe de bug que
// damping=0, cf. `_mjsClampDamping`). `precision` étant une propriété PUBLIQUE
// (un slider mal câblé, un `spring.precision = 0`), on la borne à un epsilon.
function _mjsClampPrecision(p) {
  if (!_mjsIsNum(p) || !Number.isFinite(p) || p <= 0) {
    return 0.01;
  }
  return p;
}

MjsPhysicsSpring = (function() {
  class MjsPhysicsSpring {
    constructor(current, stiffness1 = 0.15, damping1 = 0.8, min1 = null, max1 = null) {
      this.current = current;
      // Clamp dès la construction : `µ.spring(v, 5, 0.8)` (au-dessus de la
      // borne stable 2.4) divergerait sinon, le constructeur court-circuitant
      // les setters. damping d'abord (il fixe la borne de stiffness).
      this._mjs_damping = _mjsClampDamping(damping1);
      this._mjs_stiffness = _mjsClampStiffness(stiffness1, this._mjs_damping);
      this.min = min1;
      this.max = max1;
      this.target = this.current;
      this.velocity = _mjsZeroLike(current);
      this.precision = 0.01;
      // `_invalidator` était un SLOT UNIQUE (pas
      // une collection) : (a) un ressort PARTAGÉ (singleton/module) affiché
      // par 2 composants voyait le 2ᵉ `_mjs_attachInvalidator` ÉCRASER le 1ᵉʳ →
      // seul le DERNIER composant monté se re-rendait ; (b) au destroy d'un
      // composant, rien ne détachait son invalidator → un ressort encore actif
      // continuait d'appeler `_mjs_notifyMutation` sur un composant MORT (retenu
      // en mémoire, cycles perdus). Fix : `Map<owner, fn>` — un ré-attach du
      // MÊME owner remplace proprement son entrée (pas d'accumulation), et
      // `_mjs_notifyInvalidators` purge PARESSEUSEMENT les owners `_mjs_dead` au
      // moment de la notification (auto-nettoyage, pas de hook de destroy à
      // câbler côté composant).
      this._mjs_invalidators = new Map();
      // Tag d'identification dans µ._mjs_interpolatorSet (cf. mjs_init.ts).
      µ._mjs_interpolatorSet.add(this);
    }

    _mjs_attachInvalidator(owner, fn) {
      this._mjs_invalidators.set(owner, fn);
      return fn;
    }

    _mjs_notifyInvalidators() {
      for (const [owner, fn] of this._mjs_invalidators) {
        if (owner != null && owner._mjs_dead) {
          this._mjs_invalidators.delete(owner);
          continue;
        }
        fn();
      }
    }

    _mjs_step() {
      var ctx, r;
      ctx = { settled: true };
      r = _mjsSpringStep(this.current, this.target, this.velocity, this._mjs_stiffness, this._mjs_damping, this.precision, ctx);
      // Garde anti-divergence (filet au-delà du clamp des setters/constructeur) :
      // si un axe a explosé en Infinity/NaN, on FIGE à la cible et on settle
      // (retour false → le Ticker éjecte la tâche) plutôt que de propager la
      // valeur non finie → boucle rAF infinie.
      if (!_mjsDeepFinite(r.value) || !_mjsDeepFinite(r.velocity)) {
        this.current = this.target;
        this.velocity = _mjsZeroLike(this.current);
        this._mjs_notifyInvalidators();
        return false;
      }
      this.current = r.value;
      this.velocity = r.velocity;
      // min/max : clamp scalaire uniquement (sans objet de min/max par axe).
      if (_mjsIsNum(this.current)) {
        if (this.min !== null && this.current < this.min) {
          this.current = this.min;
          this.velocity = 0;
        }
        if (this.max !== null && this.current > this.max) {
          this.current = this.max;
          this.velocity = 0;
        }
      }
      // sur la frame de settle : on notifie UNE seule fois
      // (avant : notifier la valeur quasi-cible, snap, RE-notifier → un
      // re-render superflu par settle et par abonné). `this.current` (assigné
      // juste au-dessus depuis `r.value`) EST déjà la valeur exacte : chaque
      // feuille numérique convergée renvoie `tgt` littéralement (cf.
      // _mjsSpringStep), donc re-snapper sur `this.target` ici est redondant —
      // et FAUX : `this.target` seul
      // ne porte plus les clés/index figés hors de sa propre forme (union
      // courant∪cible), un snap dessus les aurait fait disparaître au settle.
      if (ctx.settled) {
        this.velocity = _mjsZeroLike(this.current);
        this._mjs_notifyInvalidators();
        return false;
      }
      this._mjs_notifyInvalidators();
      return true;
    }

  };

  // `value` / `target` : règle la CIBLE (relance le ticker). Accepte un nombre
  // OU une valeur composite (objet/tableau).
  Object.defineProperty(MjsPhysicsSpring.prototype, 'value', {
    get: function() {
      return this.target;
    },
    set: function(newTarget) {
      // Garde NaN/Infinity (scalaire ou profond) : sans ça le ressort n'est
      // JAMAIS settled → boucle rAF infinie.
      if (!_mjsDeepFinite(newTarget)) {
        return;
      }
      if (_mjsIsNum(newTarget)) {
        if (this.min !== null) {
          newTarget = Math.max(this.min, newTarget);
        }
        if (this.max !== null) {
          newTarget = Math.min(this.max, newTarget);
        }
        if (!_mjsIsNum(this.current)) {
          // RÉGRESSION corrigée — cible SCALAIRE alors que current
          // était composite (objet/tableau) : dans `_mjsSpringStep`, TOUTE clé
          // de `cur` est "absente" d'une cible scalaire (pas de clé sur un
          // nombre) → chaque axe prenait la branche figée, `ctx.settled` ne
          // passait jamais à false, `_mjs_step` rendait `false` dès la 1re frame
          // (Ticker éjecte la tâche) sans que `current` bouge — bloqué à vie,
          // en silence. Bascule de TYPE : aucun appariement axe-à-axe n'a de
          // sens, on reforme current ET velocity en NOMBRE (même schéma que
          // la branche symétrique juste en dessous) et on laisse le ressort
          // converger normalement vers la cible scalaire.
          µ.warn('[µspring] la cible change de forme (objet/tableau → nombre) — le ressort redémarre à zéro sur la nouvelle forme.');
          this.current = 0;
          this.velocity = 0;
        } else if (this.target === newTarget) {
          return;
        }
      } else if (_mjsIsNum(this.current)) {
        // 1ʳᵉ cible composite alors que le ressort était scalaire : (re)forme
        // current ET velocity selon la nouvelle structure. AVANT : seule la
        // vélocité était reformée, current restait un nombre nu — `_mjsSpringStep`
        // le traitait dans sa branche numérique face à un `tgt` composite (coercion
        // JS en chaîne « [object Object]NaN » le temps d'une frame), et ne rejoignait
        // la cible qu'au hasard du filet « composante non numérique → saute à la
        // cible » à la frame SUIVANTE. Reformer current ICI anime proprement dès la
        // 1re frame, sans jamais passer par cette chaîne parasite.
        µ.warn('[µspring] la cible change de forme (nombre → objet/tableau) — le ressort redémarre à zéro sur la nouvelle forme.');
        this.current = _mjsZeroLike(newTarget);
        this.velocity = _mjsZeroLike(newTarget);
      } else if (Array.isArray(this.current) !== Array.isArray(newTarget)) {
        // RÉGRESSION corrigée — bascule de NATURE de conteneur (objet
        // plat <-> tableau), PAS juste une bascule de type scalaire<->composite
        // ci-dessus : `_mjsShapeDiffers` avertissait déjà (curIsArr !== tgtIsArr)
        // mais ne reformait ni current ni velocity. objet -> tableau : `_mjsSpringStep`
        // prend la branche OBJET (cur n'est pas un Array), fusionne les clés nommées
        // de cur et les index de tgt (for...in sur un tableau) dans UN SEUL objet
        // plat -> hybride non-Array. tableau -> objet : `_mjsSpringStep` prend la
        // branche ARRAY (cur EST un Array), Array.isArray(tgt) faux -> chaque index
        // reste figé pour toujours, les clés de la cible objet ne sont jamais lues —
        // ressort mort en silence. Même schéma que les bascules scalaire<->composite
        // plus haut : reforme current ET velocity dans la nature de la CIBLE.
        µ.warn('[µspring] la cible change de nature de conteneur (objet <-> tableau) — le ressort redémarre à zéro sur la nouvelle forme.');
        this.current = _mjsZeroLike(newTarget);
        this.velocity = _mjsZeroLike(newTarget);
      } else if (_mjsShapeDiffers(this.current, newTarget)) {
        // clés/longueur différentes entre current et la nouvelle cible : chaque
        // axe suit sa propre règle (cf. _mjsSpringStep) — signalé UNE fois ici,
        // jamais par frame dans _mjs_step().
        µ.warn('[µspring] la cible n\'a pas la même forme que la valeur courante (clés ou longueur différentes) — chaque axe est traité indépendamment : absent de la cible => figé à sa valeur courante, absent de current => apparaît sans animer.');
      }
      this.target = newTarget;
      return µ.Ticker.add(this);
    }
  });

  // stiffness / damping : RÉACTIFS — muter `spring.stiffness` (ex. via un
  // `bind` sur un slider) doit re-render les `{$spring.stiffness}` qui le lisent.
  // On notifie via l'invalidator attaché quand le ressort est posé dans une var.
  Object.defineProperty(MjsPhysicsSpring.prototype, 'stiffness', {
    get: function() {
      return this._mjs_stiffness;
    },
    set: function(v) {
      // Clamp sous la borne stable (dépend de damping) : sans ça un slider lié
      // à `spring.stiffness` poussé au-delà de 4-2·damping fait diverger le
      // ressort → jamais settled → boucle rAF infinie.
      this._mjs_stiffness = _mjsClampStiffness(v, this._mjs_damping);
      this._mjs_notifyInvalidators();
      return v;
    }
  });

  Object.defineProperty(MjsPhysicsSpring.prototype, 'damping', {
    get: function() {
      return this._mjs_damping;
    },
    set: function(v) {
      this._mjs_damping = _mjsClampDamping(v);
      // La borne stable de stiffness est `4-2·damping` : damping ayant bougé,
      // on re-clampe stiffness pour rester dans la zone stable.
      this._mjs_stiffness = _mjsClampStiffness(this._mjs_stiffness, this._mjs_damping);
      this._mjs_notifyInvalidators();
      return v;
    }
  });

  // precision : bornée à un plancher epsilon au set (cf. `_mjsClampPrecision`).
  // Une precision <= 0 rendrait le settle inatteignable → Ticker immortel. Le
  // constructeur (`this.precision = 0.01`) passe par ce setter → `_mjs_precision`.
  Object.defineProperty(MjsPhysicsSpring.prototype, 'precision', {
    get: function() {
      return this._mjs_precision;
    },
    set: function(v) {
      this._mjs_precision = _mjsClampPrecision(v);
      return v;
    }
  });

  return MjsPhysicsSpring;

}).call(this);

µ.spring = function(val, stiffness = 0.15, damping = 0.8, min = null, max = null) {
  return new MjsPhysicsSpring(val, stiffness, damping, min, max);
};
