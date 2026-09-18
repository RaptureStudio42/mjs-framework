// mjs_det — outils déterministes (« netcode »), PURS et testables SANS réseau : PRNG
// mulberry32 (µ.random) + trigonométrie approximée par POLYNÔME (µ.det.sin/cos/atan2). Module
// AUTONOME (patron 'schema', cf. mjs_interp.ts en tête de fichier) — AUCUNE dépendance (ni µ.socket,
// ni sock.game()) : utilisable seul, y compris SERVEUR (mulberry32 est isomorphe — cf.
// mjs-server/lockstep.ts::deterministicSeed, MÊME famille d'algorithme FNV/mulberry, réimplémentée là
// côté serveur en TypeScript ASI faute de pouvoir importer un fichier `var`/prototype non-module ici).
//
//   rng = µ.random(42)        // graine → générateur INDÉPENDANT (jamais un état global partagé)
//   rng.next()                 // float [0, 1)
//   rng.int(1, 6)               // entier BORNÉ INCLUSIF [1, 6] — ex. dé à 6 faces
//   µ.det.sin(x); µ.det.cos(x); µ.det.atan2(y, x)   // RADIANS, mêmes signatures que Math.*
//
// POURQUOI PAS Math.sin/cos/atan2 — l'ECMAScript ne garantit AUCUNE reproductibilité bit-à-bit de ces
// fonctions ENTRE moteurs/plateformes (implémentation transcendante non spécifiée au bit près, cf.
// spec du Math object) : deux clients lockstep sur des moteurs différents pourraient calculer des
// trajectoires légèrement différentes et DIVERGER (cf. µ.lockstep, mjs_lockstep.ts). µ.det.* n'utilise
// QUE +/-/×/÷/Math.imul/Math.floor/Math.abs — DÉJÀ déterministes IEEE 754 (résultat CORRECTEMENT
// ARRONDI, identique sur tout moteur conforme), donc le résultat final l'est aussi.
//
// PRÉCISION ANNONCÉE (mesurée, cf. tests/det-core.test.ts, balayage fin vs Math.sin/cos/atan2) :
//   - sin/cos (Bhaskara I, réduction de portée à [-π,π]) : erreur ABSOLUE max ≈ 0.00163 (0.163 % de
//     l'amplitude [-1,1]).
//   - atan2 (rationnelle, approximation courte de l'arctangente sur [-1,1] + repli par quadrant) :
//     erreur ABSOLUE max ≈ 0.0015 rad (≈ 0.086°), invariante d'échelle (testée à divers rayons).
//   Suffisant pour une direction/visée de jeu (viseur, orientation d'unité…), PAS pour un calcul
//   scientifique — un jeu qui a besoin de plus repasse par Math.* (au prix du déterminisme
//   cross-moteur) ou fournit sa propre table plus fine.
//
// LIMITE — réduction de portée par soustraction (x - TAU*floor(...)) : précision qui se dégrade pour
// un x ASTRONOMIQUEMENT grand (cancellation flottante classique de toute réduction de portée naïve) ;
// des angles de jeu (accumulés frame à frame, typiquement bornés) restent largement dans la zone saine.
//
// sqrt/+/−/×/÷ : DÉJÀ déterministes IEEE 754 — les garder NATIFS (Math.sqrt, opérateurs), aucune
// raison de les réapprocher ici (seules sin/cos/atan2 sont concernées).

var MJDET_TAU     = 6.283185307179586;
var MJDET_PI      = 3.141592653589793;
var MJDET_HALF_PI = 1.5707963267948966;
var MJDET_QUARTER_PI = 0.7853981633974483;

// --- mulberry32 (Tommy Ettinger, domaine public) — isomorphe, cf. tête de fichier -----------------
// `seed` normalisée en entier 32 bits non-signé (`>>> 0`) — accepte un nombre quelconque en entrée
// (flottant, négatif) sans throw, TRONQUÉ silencieusement comme tout usage habituel de `>>> 0`.
µ.random = function(seed) {
  var a = seed >>> 0;
  function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next: next,
    // entier BORNÉ INCLUSIF [min, max] — Math.floor (troncature), JAMAIS Math.round (biaiserait les
    // extrêmes, cf. piège classique du "dé à 6 faces" avec round au lieu de floor)
    int: function(min, max) { return min + Math.floor(next() * (max - min + 1)); }
  };
};

// --- trigonométrie approximée -----------------------------------------------------------------

// réduit x à [-π, π] — floor/× DÉTERMINISTES (cf. tête de fichier), cancellation flottante possible
// pour un |x| énorme (limite documentée, cf. tête de fichier)
function _mjdetReduce(x) {
  return x - MJDET_TAU * Math.floor((x + MJDET_PI) / MJDET_TAU);
}

// Bhaskara I (~628 apr. J.-C.) — x DÉJÀ réduit à [-π, π] ; symétrie impaire sur le signe
function _mjdetSinReduced(x) {
  var s = x < 0 ? -1 : 1;
  var ax = x < 0 ? -x : x;
  var num = 16 * ax * (MJDET_PI - ax);
  var den = 5 * MJDET_PI * MJDET_PI - 4 * ax * (MJDET_PI - ax);
  return s * num / den;
}

// arctangente courte sur [-1, 1] — forme rationnelle classique (max ≈0.00151 rad d'écart mesuré,
// cf. tête de fichier), combinée par quadrant dans µ.det.atan2 ci-dessous.
function _mjdetAtan(z) {
  var az = z < 0 ? -z : z;
  return MJDET_QUARTER_PI * z - z * (az - 1) * (0.2447 + 0.0663 * az);
}

µ.det = {
  sin: function(x) { return _mjdetSinReduced(_mjdetReduce(x)); },
  cos: function(x) { return _mjdetSinReduced(_mjdetReduce(x + MJDET_HALF_PI)); },
  // repli par quadrant AUTOUR de l'arctangente courte (|z| <= 1 dans les DEUX branches, cf. ax > ay) —
  // même charpente que l'algorithme atan2 « classique » enseigné (cf. Math.atan2 lui-même) ; (0,0)
  // → 0 par convention (indéfini mathématiquement, MÊME repli que Math.atan2(0,0))
  atan2: function(y, x) {
    var ax = x < 0 ? -x : x, ay = y < 0 ? -y : y, z;
    if (ax > ay) {
      z = y / x;
      if (x > 0) return _mjdetAtan(z);
      return y >= 0 ? _mjdetAtan(z) + MJDET_PI : _mjdetAtan(z) - MJDET_PI;
    }
    if (ay > 0 || ax > 0) {
      z = x / y;
      return y > 0 ? (-_mjdetAtan(z) + MJDET_HALF_PI) : (-_mjdetAtan(z) - MJDET_HALF_PI);
    }
    return 0;
  }
};
