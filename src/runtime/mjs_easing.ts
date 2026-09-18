// mjs_easing.coffee

// Bibliothèque d'easings, équivalent à `svelte/easing`. Toutes les fonctions
// prennent un `t` ∈ [0..1] et retournent une valeur eased.
// Référence : Penner Equations + svelte/easing/index.js
var KF_REGISTRY, KF_ROOT_SHEETS, KF_SHEET, _hashStr, _log, _registryFor, _runSharedTransition, _txId, _txTag, ensureSheet, frameToCss;

µ.easing = {};

// linear
µ.easing.linear = function(t) {
  return t;
};

// back
µ.easing.backIn = function(t) {
  var s;
  s = 1.70158;
  return t * t * ((s + 1) * t - s);
};

µ.easing.backOut = function(t) {
  var s;
  s = 1.70158;
  t -= 1;
  return t * t * ((s + 1) * t + s) + 1;
};

µ.easing.backInOut = function(t) {
  var s;
  s = 1.70158 * 1.525;
  if ((t *= 2) < 1) {
    return 0.5 * (t * t * ((s + 1) * t - s));
  } else {
    t -= 2;
    return 0.5 * (t * t * ((s + 1) * t + s) + 2);
  }
};

// bounce
µ.easing.bounceOut = function(t) {
  var a, b, c, ca, cb, cc, t2;
  a = 4.0 / 11.0;
  b = 8.0 / 11.0;
  c = 9.0 / 10.0;
  ca = 4356.0 / 361.0;
  cb = 35442.0 / 1805.0;
  cc = 16061.0 / 1805.0;
  t2 = t * t;
  if (t < a) {
    return 7.5625 * t2;
  } else if (t < b) {
    return 9.075 * t2 - 9.9 * t + 3.4;
  } else if (t < c) {
    return ca * t2 - cb * t + cc;
  } else {
    return 10.8 * t2 - 20.52 * t + 10.72;
  }
};

µ.easing.bounceIn = function(t) {
  return 1 - µ.easing.bounceOut(1 - t);
};

µ.easing.bounceInOut = function(t) {
  if (t < 0.5) {
    return 0.5 * (1 - µ.easing.bounceOut(1 - t * 2));
  } else {
    return 0.5 * µ.easing.bounceOut(t * 2 - 1) + 0.5;
  }
};

// circ
µ.easing.circIn = function(t) {
  return 1 - Math.sqrt(1 - t * t);
};

µ.easing.circOut = function(t) {
  t -= 1;
  return Math.sqrt(1 - t * t);
};

µ.easing.circInOut = function(t) {
  if ((t *= 2) < 1) {
    return -0.5 * (Math.sqrt(1 - t * t) - 1);
  } else {
    t -= 2;
    return 0.5 * (Math.sqrt(1 - t * t) + 1);
  }
};

// cubic
µ.easing.cubicIn = function(t) {
  return t * t * t;
};

µ.easing.cubicOut = function(t) {
  var f;
  f = t - 1;
  return f * f * f + 1;
};

µ.easing.cubicInOut = function(t) {
  if (t < 0.5) {
    return 4 * t * t * t;
  } else {
    return 0.5 * Math.pow(2 * t - 2, 3) + 1;
  }
};

// elastic
µ.easing.elasticIn = function(t) {
  if (t === 0) {
    return 0;
  }
  if (t === 1) {
    return 1;
  }
  return -Math.pow(2, 10 * (t - 1)) * Math.sin(((t - 1) - 0.075) * (2 * Math.PI) / 0.3);
};

µ.easing.elasticOut = function(t) {
  return Math.sin(-13.0 * (t + 1.0) * Math.PI / 2) * Math.pow(2.0, -10.0 * t) + 1.0;
};

µ.easing.elasticInOut = function(t) {
  if (t === 0) {
    return 0;
  }
  if (t === 1) {
    return 1;
  }
  t *= 2;
  if (t < 1) {
    return -0.5 * Math.pow(2, 10 * (t - 1)) * Math.sin(((t - 1) - 0.1125) * (2 * Math.PI) / 0.45);
  } else {
    return 0.5 * Math.pow(2, -10 * (t - 1)) * Math.sin(((t - 1) - 0.1125) * (2 * Math.PI) / 0.45) + 1;
  }
};

// expo
µ.easing.expoIn = function(t) {
  if (t === 0) {
    return 0;
  } else {
    return Math.pow(2, 10 * (t - 1));
  }
};

µ.easing.expoOut = function(t) {
  if (t === 1) {
    return 1;
  } else {
    return 1 - Math.pow(2, -10 * t);
  }
};

µ.easing.expoInOut = function(t) {
  if (t === 0) {
    return 0;
  }
  if (t === 1) {
    return 1;
  }
  if ((t *= 2) < 1) {
    return 0.5 * Math.pow(2, 10 * (t - 1));
  } else {
    t -= 1;
    return 0.5 * (2 - Math.pow(2, -10 * t));
  }
};

// quad
µ.easing.quadIn = function(t) {
  return t * t;
};

µ.easing.quadOut = function(t) {
  return -t * (t - 2);
};

µ.easing.quadInOut = function(t) {
  if ((t *= 2) < 1) {
    return 0.5 * t * t;
  } else {
    t -= 1;
    return -0.5 * (t * (t - 2) - 1);
  }
};

// quart
µ.easing.quartIn = function(t) {
  return t * t * t * t;
};

µ.easing.quartOut = function(t) {
  var f;
  f = t - 1;
  return -(f * f * f * f - 1);
};

µ.easing.quartInOut = function(t) {
  if ((t *= 2) < 1) {
    return 0.5 * t * t * t * t;
  } else {
    t -= 2;
    return -0.5 * (t * t * t * t - 2);
  }
};

// quint
µ.easing.quintIn = function(t) {
  return t * t * t * t * t;
};

µ.easing.quintOut = function(t) {
  var f;
  f = t - 1;
  return f * f * f * f * f + 1;
};

µ.easing.quintInOut = function(t) {
  if ((t *= 2) < 1) {
    return 0.5 * t * t * t * t * t;
  } else {
    t -= 2;
    return 0.5 * (t * t * t * t * t + 2);
  }
};

// sine
µ.easing.sineIn = function(t) {
  return 1 - Math.cos(t * Math.PI / 2);
};

µ.easing.sineOut = function(t) {
  return Math.sin(t * Math.PI / 2);
};

µ.easing.sineInOut = function(t) {
  return 0.5 * (1 - Math.cos(Math.PI * t));
};

// courbe de Bézier cubique CSS — cubic-bezier(x1, y1, x2, y2) : x résolu par dichotomie (24
// pas), y évalué au paramètre trouvé. P0 = (0,0) et P3 = (1,1) fixes (contrat CSS).
µ.easing.bezier = function(x1, y1, x2, y2) {
  var bez;
  bez = function(a, b, s) {
    return 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
  };
  return function(t) {
    var hi, i, lo, mid;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    lo = 0;
    hi = 1;
    for (i = 0; i < 24; i++) {
      mid = (lo + hi) / 2;
      if (bez(x1, x2, mid) < t) lo = mid;
      else hi = mid;
    }
    return bez(y1, y2, (lo + hi) / 2);
  };
};

// Resolveur tolérant : accepte une fonction OU une string CSS courante et
// retourne toujours une fonction (t) -> t', utilisable pour sampler des
// keyframes. Permet aux animations alignées Svelte (slide, fly, scale, blur)
// d'accepter `easing: 'ease-out'` sans crash.
µ.easing.resolve = function(e) {
  var m, x1, x2, y1, y2;
  if (!e) {
    return µ.easing.cubicOut;
  }
  if (typeof e === 'function') {
    return e;
  }
  if (typeof e === 'string') {
    m = e.match(/^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/);
    if (m) {
      x1 = +m[1];
      y1 = +m[2];
      x2 = +m[3];
      y2 = +m[4];
      if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2) && x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1) {
        return µ.easing.bezier(x1, y1, x2, y2);
      }
    }
  }
  switch (e) {
    case 'linear':
      return µ.easing.linear;
    case 'ease':
      return µ.easing.cubicInOut;
    case 'ease-in':
      return µ.easing.cubicIn;
    case 'ease-out':
      return µ.easing.cubicOut;
    case 'ease-in-out':
      return µ.easing.cubicInOut;
    default:
      // repli cubicOut INCHANGÉ (pas d'acceptation des
      // noms µ.easing.* en chaîne, décision explicite) ; seule nouveauté : un avertissement en
      // mode debug, pour qu'une faute de frappe ('bounceOut', 'easeInBounce') ne reste plus muette.
      if (µ.debug) µ.warn('[mjs-tx] easing inconnu « ' + e + ' » — repli cubicOut (attendu : linear, ease, ease-in, ease-out, ease-in-out, cubic-bezier(x1,y1,x2,y2), ou une fonction)');
      return µ.easing.cubicOut;
  }
};

// ============================================================================
// Helpers d'animation — cache JS + mode @keyframes partagé
// ============================================================================

// `µ.anim` est créé par compile_discovered_animations dans le bundler. On
// l'initialise ici si pas encore défini pour pouvoir attacher les helpers.
if (µ.anim == null) {
  µ.anim = {};
}

// (µ.anim._mjs_cached / KF_CACHE supprimés : code mort — défini sans
// aucun appelant dans tout src/. Si l'idée revient, la brancher dans
// `_mjs_runTransition` avec la signature de `_runSharedTransition` en modèle.)

// --- Mode `.shared` : @keyframes injecté dans le document ---
// Quand un node a la directive `@transition.NAME.shared`, le runtime utilise
// un @keyframes CSS partagé (1 définition pour N nodes) au lieu de WAAPI.
// Utile pour les jeux/animations à haute volumétrie où le même effet joue
// simultanément sur >50 instances. Avec ref counting → GC quand plus d'usage.
KF_SHEET = null;

KF_REGISTRY = new WeakMap(); // racine → Map(name → { css, refs, textNode }) — un registre par racine, le document garde le sien

// racines non-document (shadow roots) : une feuille par racine, jamais partagée entre elles —
// WeakMap pour laisser le GC reprendre la main quand la racine meurt (composant détruit)
KF_ROOT_SHEETS = new WeakMap();

// trouve (ou crée) le Map de registre d'UNE racine — document compris
_registryFor = function(root) {
  var map;
  map = KF_REGISTRY.get(root);
  if (!map) {
    map = new Map();
    KF_REGISTRY.set(root, map);
  }
  return map;
};

// POURQUOI une racine — les noms de `@keyframes` sont À PORTÉE D'ARBRE
// (tree-scoped) : un nœud dans un shadow root ne voit PAS un `@keyframes` injecté dans le
// document. Mesuré Chromium : `.shared` restait muet dans tout composant en ombre (le mode par
// défaut de ModularJS) — `node.style.animation` posé sans effet, `animationend` jamais reçu, la
// promesse jamais résolue. La feuille vit donc désormais LÀ OÙ VIT LE NŒUD.
// Sans argument ou avec `document` : comportement BYTE-IDENTIQUE à avant (cache KF_SHEET).
ensureSheet = function(root) {
  var el, sheet;
  if (!(root && root.host)) {
    root = document;
  }
  if (root === document) {
    if (KF_SHEET) {
      return KF_SHEET;
    }
    if (µ._csp) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync('');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      KF_SHEET = sheet;
      return sheet;
    }
    el = document.createElement('style');
    el.id = '_mjs_anim_keyframes';
    document.head.appendChild(el);
    KF_SHEET = el;
    return el;
  }
  sheet = KF_ROOT_SHEETS.get(root);
  if (sheet) {
    return sheet;
  }
  if (µ._csp) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync('');
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    KF_ROOT_SHEETS.set(root, sheet);
    return sheet;
  }
  el = document.createElement('style');
  el.setAttribute('data-mjs-anim-keyframes', ''); // pas d'id : un id doit rester unique par arbre
  root.appendChild(el);
  KF_ROOT_SHEETS.set(root, el);
  return el;
};

// Convertit un object keyframe (camelCase) vers une string CSS (kebab-case).
// `offset` est exclu — il devient le pourcentage `XX%` du @keyframes.
frameToCss = function(f) {
  var cssProp, parts, prop, val;
  parts = [];
  for (prop in f) {
    val = f[prop];
    if (prop === 'offset') {
      continue;
    }
    cssProp = prop.replace(/[A-Z]/g, function(m) {
      return `-${m.toLowerCase()}`;
    });
    parts.push(`${cssProp}: ${val}`);
  }
  return parts.join('; ');
};

// Acquiert (ou ré-acquiert) un @keyframes nommé. `builder` est appelé
// uniquement si la définition n'existe pas encore. Le ref counter protège
// contre la suppression prématurée si plusieurs animations partagent le nom.
// `root` = racine où vit le nœud animé (document par défaut) — registre ET feuille sont PAR
// RACINE, cf. `ensureSheet`.
µ.anim._mjs_acquireKeyframes = function(name, builder, root) {
  var cssBody, entry, frames, registry, rule, sheet;
  root = root != null ? root : document;
  registry = _registryFor(root);
  entry = registry.get(name);
  if (entry) {
    entry.refs++;
    return name;
  }
  frames = builder(); // tableau de keyframes JS avec offset
  cssBody = frames.map(function(f) {
    return `${(f.offset * 100).toFixed(2)}% { ${frameToCss(f)} }`;
  }).join(' ');
  rule = `@keyframes ${name} { ${cssBody} }`;
  sheet = ensureSheet(root);
  if (µ._csp) {
    sheet.insertRule(rule, sheet.cssRules.length);
  } else {
    sheet.appendChild(document.createTextNode(rule));
  }
  registry.set(name, {
    css: rule,
    refs: 1,
    textNode: µ._csp ? null : sheet.lastChild
  });
  return name;
};

µ.anim._mjs_releaseKeyframes = function(name, root) {
  var entry, i, ref1, registry, rule, sheet;
  root = root != null ? root : document;
  registry = _registryFor(root);
  entry = registry.get(name);
  if (!entry) {
    return;
  }
  entry.refs--;
  if (entry.refs <= 0) {
    if (µ._csp) {
      sheet = root === document ? KF_SHEET : KF_ROOT_SHEETS.get(root);
      for (i = 0; i < sheet.cssRules.length; i++) {
        rule = sheet.cssRules[i];
        if (rule.name === name) {
          sheet.deleteRule(i);
          break;
        }
      }
    } else if ((ref1 = entry.textNode) != null) {
      if (typeof ref1.remove === "function") {
        ref1.remove();
      }
    }
    return registry.delete(name);
  }
};

// --- Moteur de transition unifié (port Svelte) ---

// Reproduit le pattern Svelte `animate()` : pour chaque transition (intro ou
// outro), on calcule t1 = position courante (depuis l'animation en cours, ou
// 0/1 par défaut), t2 = cible (1 pour intro, 0 pour outro), delta = t2 - t1.
// Les keyframes sont rebuilt from t1 vers t2 avec l'easing dans le bon sens —
// pas de `Animation.reverse()` qui inverse l'easing visuellement.

// Toggle pendant une transition : abort current + relance avec t1 = current_t.
// Continuité visuelle parfaite, easing toujours correct.

// Usage :
//   cfg = animFn(node)  # { delay, duration, easing, css(t, u) }
//   µ._mjs_runTransition(node, cfg, 'in')    # ou 'out'
//   → Promise qui resolve quand l'anim termine (ou est aborted).
_hashStr = function(str) {
  var h, i, j, ref1;
  h = 0;
  for (i = j = 0, ref1 = str.length; (0 <= ref1 ? j < ref1 : j > ref1); i = 0 <= ref1 ? ++j : --j) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
};

// _runTickTransition : version tick-mode avec abort + continuité, équivalent
// à ce que `µ._mjs_runTransition` fait pour le mode css (avec keyframes/WAAPI).
// La cfg est cachée per-node par `_mjs_runTransition` AVANT d'arriver ici, donc
// le `cfg.tick` callback voit toujours la même closure (état initial capturé
// au tout premier appel). Le `t` interpolé va de `t1` (current visible state)
// vers `t2` (target : 1 pour intro, 0 pour outro), avec abort propre si une
// nouvelle transition arrive en cours de route.
var _runTickTransition = function(node, cfg, t1, t2, direction) {
  var baseDuration, delay, delta, duration, easing, ref, state;
  delta = t2 - t1;
  if (Math.abs(delta) < 0.0001) {
    return Promise.resolve();
  }
  baseDuration = (ref = cfg.duration) != null ? ref : 400;
  duration = Math.abs(delta) * baseDuration;
  // `cfg.delay` est désormais honoré en mode tick (le
  // mode css et `.shared` le respectaient déjà, la doc l'annonce). Clampé ≥ 0.
  delay = (ref = cfg.delay) != null ? ref : 0;
  if (delay < 0) {
    delay = 0;
  }
  easing = µ.easing.resolve(cfg.easing);
  state = {
    direction: direction,
    t1: t1,
    delta: delta,
    easing: easing,
    aborted: false,
    rafId: null,
    progress: 0,
    inDelay: delay > 0
  };
  state.tValue = function() {
    // Pendant le delay, figé à t1 (comme `inDelay` du mode css) : une interruption
    // pendant le delay doit reprendre depuis t1, pas depuis un t déjà avancé.
    if (this.inDelay) {
      return this.t1;
    }
    return this.t1 + this.delta * this.easing(this.progress);
  };
  state.abort = function() {
    this.aborted = true;
    if (this.rafId != null) {
      try {
        cancelAnimationFrame(this.rafId);
      } catch (error) {
        if (µ.debug) µ.warn('[mjs-tx]', error);
      }
    }
    this.rafId = null;
    if (node._mjs_transition_state === this) {
      node._mjs_transition_state = null;
    }
    // `cancelAnimationFrame` empêche `step` de
    // jamais retourner (la frame planifiée ne va plus firer) → le SEUL
    // `resolve` de cette Promise vivait DANS `step` (branche `state.aborted`),
    // jamais atteinte → tout code faisant `await` sur cette transition (ex.
    // `_mjs_destroyNodeAndChildren` → `await Promise.all(transitions)`) restait
    // bloqué À VIE dès qu'un abort survient ENTRE deux frames — exactement le
    // cas d'usage de l'abort (interrompre une transition EN COURS). Fix :
    // `resolve` est capturé dans `state._mjs_resolve` dès l'exécuteur de la
    // Promise ci-dessous ; on l'appelle ici avec la même valeur que la
    // complétion normale (`direction`, cf. `step`). Idempotent par nature
    // (une Promise ne resout qu'une fois) si `abort()` était déjà appelé.
    if (typeof this._mjs_resolve === 'function') {
      const __r = this._mjs_resolve;
      this._mjs_resolve = null;
      return __r(direction);
    }
  };
  // ERREUR UTILISATEUR dans cfg.tick() — avant : avalée
  // en silence hors µ.debug (garde muette), la transition re-tentait le tick à
  // CHAQUE frame jusqu'à épuisement de la durée. Désormais : signalée TOUJOURS
  // (µ.warn inconditionnel), et la transition se ferme AU PREMIER échec plutôt
  // que de re-tenter — symétrique au mode css (cf. µ._mjs_runTransition, la boucle
  // de keyframes juste en dessous dans ce fichier). Le node reste dans son état
  // visible naturel (le mode tick ne pose jamais de style masquant lui-même).
  state.tickFailed = function(error) {
    µ.warn(`[mjs-tx] cfg.tick() a levé (transition ${direction} #${_txId(node)}) — transition close proprement :`, error);
    if (node._mjs_transition_state === this) {
      node._mjs_transition_state = null;
    }
    if (typeof this._mjs_resolve === 'function') {
      const __r = this._mjs_resolve;
      this._mjs_resolve = null;
      return __r(direction);
    }
  };
  node._mjs_transition_state = state;
  return new Promise(function(resolve) {
    var start, step;
    state._mjs_resolve = resolve;
    start = performance.now();
    step = function(now) {
      var elapsed, t;
      if (state.aborted) {
        return resolve(direction);
      }
      elapsed = now - start - delay;
      // tant que le delay n'est pas écoulé : figé à t1
      // et re-planifie sans faire avancer progress (équivalent `inDelay` du css).
      if (elapsed < 0) {
        try {
          cfg.tick(state.t1, 1 - state.t1);
        } catch (error) {
          return state.tickFailed(error);
        }
        return state.rafId = requestAnimationFrame(step);
      }
      state.inDelay = false;
      // progress clampé aux 2 bornes : un timestamp rAF
      // antérieur au start donnait un progress négatif (t hors [t1,t2] — ex.
      // typewriter coupant depuis la FIN) ; `duration=0` (texte vide) donnait
      // `0/0 = NaN` → `NaN < 1` faux → résolution SANS jamais émettre t2 (état
      // final non appliqué). `Math.max(duration, 1e-6)` garantit un tick unique à
      // t2 exact quand duration=0.
      state.progress = Math.min(Math.max(elapsed, 0) / Math.max(duration, 1e-6), 1);
      t = state.t1 + state.delta * state.easing(state.progress);
      try {
        cfg.tick(t, 1 - t);
      } catch (error) {
        return state.tickFailed(error);
      }
      if (state.progress < 1) {
        return state.rafId = requestAnimationFrame(step);
      } else {
        if (node._mjs_transition_state === state) {
          node._mjs_transition_state = null;
        }
        return resolve(direction);
      }
    };
    return state.rafId = requestAnimationFrame(step);
  });
};

_runSharedTransition = function(node, cfg, direction) {
  var buildKf, easing, isIntro, ref1, sample, sig, steps;
  // Mode .shared : pas de t1/t2 logic (one-shot, optimisé pour anims qui
  // jouent jusqu'au bout). Génère un @keyframes CSS partagé via _mjs_runShared.
  isIntro = direction === 'in';
  // SÉCURITÉ —
  // Math.max(1, NaN) === NaN : steps NaN/'abc' (non fini/non numérique) traversait le plancher
  // SANS ÊTRE clampé → boucle jamais exécutée → keyframes VIDES. absent → 60 (défaut) ; fini < 1
  // (0, négatif) → 1 (plancher, jamais de division par 0) ; non fini/non numérique → 60 (une
  // chaîne farfelue n'est pas un pas très petit).
  steps = Number((ref1 = cfg.steps) != null ? ref1 : 60);
  if (!Number.isFinite(steps)) {
    steps = 60;
  } else if (steps < 1) {
    steps = (ref1 == null) ? 60 : 1;
  }
  easing = µ.easing.resolve(cfg.easing);
  buildKf = function() {
    var f, i, j, kf, p, ref2, t;
    kf = [];
    for (i = j = 0, ref2 = steps; (0 <= ref2 ? j <= ref2 : j >= ref2); i = 0 <= ref2 ? ++j : --j) {
      p = i / steps;
      t = isIntro ? easing(p) : easing(1 - p);
      f = cfg.css(t, 1 - t);
      f.offset = p;
      kf.push(f);
    }
    return kf;
  };
  // ERREUR UTILISATEUR dans cfg.css() (symétrique aux modes tick/css —
  // cf. µ._mjs_runTransition plus bas dans ce fichier) — AVANT : aucun try/catch ici,
  // une exception (sample ci-dessous OU buildKf, tous deux appelés SYNCHRONE-
  // MENT jusqu'à `_mjs_runShared`/`_mjs_acquireKeyframes`) sortait NON capturée et
  // cassait l'appelant. Rien n'a encore été appliqué au node à ce stade (ni
  // @keyframes injecté, ni `node.style.animation` posé) : il reste dans son
  // état visible naturel.
  try {
    // Signature : direction + sample du css à t=0.5 (capture les dimensions
    // spécifiques au node — deux nodes avec mêmes dims partageront le keyframes).
    sample = JSON.stringify(cfg.css(0.5, 0.5));
    // SÉCURITÉ — `easing.name` vaut TOUJOURS '' (fonctions posées par
    // propriété, `µ.easing.x = function…`, pas d'inférence de nom) : le repli `.toString().length`
    // collisionne dès que 2 easings ont la MÊME longueur de source (bounceIn/sineIn = 55 car.,
    // bounceInOut/circInOut = 155) — 2 transitions `.shared` partagent alors le même @keyframes, la
    // 2e rejoue l'easing de la 1re. `_hashStr` sur la source ENTIÈRE distingue les deux.
    sig = `${direction}-${cfg.duration}-${_hashStr(easing.toString())}-${steps}-${sample}`;
    return µ.anim._mjs_runShared(node, `_kf_${_hashStr(sig)}`, buildKf, {
      duration: cfg.duration,
      delay: cfg.delay,
      direction: direction
    });
  } catch (error) {
    µ.warn(`[mjs-tx] cfg.css() a levé (transition partagée ${direction} #${_txId(node)}) — transition close proprement :`, error);
    return Promise.resolve(direction);
  }
};

// Defer une fonction jusqu'à ce que le node soit attaché au DOM ET ait un
// layout calculé (`offsetHeight > 0`). Sans ça, `getComputedStyle(node)`
// retourne des strings vides (`+"" = 0`) et `offsetHeight = 0` → la capture
// des dims pour `slide`/`fly`/etc. donne tout à 0 → l'animation joue de 0
// vers 0, invisible. Cas typique : node fresh ajouté par un `{for}`, encore
// dans un fragment détaché au moment où `bindingTransition` tire l'intro.
// On poll via rAF, max 30 frames (~500ms), puis fallback (fire quand même
// pour ne pas bloquer si le node reste sans layout — display:none par ex.).
//
// NB : la condition `attempts >= 30` est un fallback, mais on n'appelle fn
// JAMAIS sur un node `!isConnected` (pas d'intro à jouer sur un détaché).
µ._mjs_whenLayouted = function(node, fn, attempts = 0) {
  if (attempts >= 30) {
    // Fallback : jamais « layouté » en 30 frames. On ne tire `fn` QUE si le node
    // a fini par se connecter — le contrat interdit d'appeler `fn` sur un node
    // détaché (pas d'intro à jouer sur un détaché) ; sinon abandon silencieux.
    // Forme ternaire volontaire (et non un raccourci sync en toutes lettres) pour
    // ne pas déclencher le garde-fou anti-raccourci du test when-layouted.
    return node.isConnected ? fn() : void 0;
  }
  // 1er appel : on diffère TOUJOURS en MICROTASK (même si le node est déjà
  // connecté). Deux raisons cumulées :
  //  1. Le node peut être créé dans un fragment détaché (cas {if}/{key} : insert
  //     juste APRÈS dans la même tâche) → la microtask voit l'insertion faite.
  //  2. SURTOUT : l'intro est posée pendant le rendu structurel ({if}/{key}…)
  //     AVANT que les effects du même batch (binding texte, etc.) n'aient rempli
  //     le contenu du nœud. Une microtask s'exécute APRÈS ce batch synchrone —
  //     donc le contenu est en place — mais AVANT le paint → l'intro capture le
  //     bon DOM. Indispensable pour `typewriter` (qui lit `node.textContent` au
  //     démarrage) : firer sync sur `isConnected` capturait le texte AVANT son
  //     binding → `<p>` vide à jamais (leçon `blocs-key`).
  // On NE gate plus jamais sur `offsetHeight > 0` (un nœud de hauteur nulle
  // restait bloqué 30 frames ~480ms → l'intro ne démarrait qu'au fallback).
  if (attempts === 0 && typeof queueMicrotask === 'function') {
    return queueMicrotask(function() {
      if (node.isConnected) {
        return fn();
      }
      return requestAnimationFrame(function() {
        return µ._mjs_whenLayouted(node, fn, 1);
      });
    });
  }
  // Appels suivants (pas de microtask dispo, ou poll rAF en cours) : dès que
  // connecté, `getComputedStyle` est fiable (sampling slide/fly OK).
  if (node.isConnected) {
    return fn();
  }
  return requestAnimationFrame(function() {
    return µ._mjs_whenLayouted(node, fn, attempts + 1);
  });
};

// Wrapper universel pour démarrer une transition.

// `ref` peut être :
//  - une fonction `setup(node)` marquée `_isCfgFactory` (anims migrées
//    slide/fade/fly/scale/blur/draw) → on délègue à `_mjs_runTransition` qui
//    call setup(node) APRÈS abort de la prev anim, pour capture sur node
//    libéré (dims naturelles, pas figées par `fill: forwards`).
//  - une fonction legacy (crossfade, µanim.create custom) qui démarre son
//    animation et retourne une Promise → on l'appelle directement.
//  - une cfg pré-faite `{ delay, duration, easing, css }` → comme factory.
// Épingle un élément à sa position visuelle courante (position:absolute +
// translate correctif) AVANT qu'un reflow ne le déplace. Indispensable pour le
// crossfade : `_mjs_reconcileList` déplace les éléments sortants en bas de liste
// (dying tail), et un crossfade qui lit la position APRÈS partirait du mauvais
// endroit. Port du `fix_position` de Svelte. Appelé au marquage `_mjs_dying`.
// `targetRect` (optionnel) = position visuelle d'origine capturée AVANT le
// reflow. Indispensable car `_mjs_reconcileList` déplace l'élément sortant en bas
// de liste : on le passe en absolute APRÈS ce move, puis on applique un translate
// pour le ramener à sa position d'origine. Sans `targetRect`, on épingle là où
// il est (cas hors-liste : {if}/{key}) — mais PAS sur son rectangle rendu
// (`getBoundingClientRect`, faux dès qu'un transform est posé : perspective +
// origine en profondeur de cube, ou tout transform de base) : sur sa boîte de
// MISE EN PAGE (`offsetLeft`/`offsetTop`, insensible au transform), déjà
// relative au bord de remplissage de l'offsetParent.
µ._mjs_fixPosition = function(node, targetRect) {
  var a, h, op, opr, st, w;
  if (!node || node.nodeType !== 1 || !node.style) {
    return;
  }
  st = window.getComputedStyle(node);
  if (st.position === 'absolute' || st.position === 'fixed') {
    return;
  }
  w = st.width;
  h = st.height;
  a = targetRect || node.getBoundingClientRect();
  // Épinglage via top/left (PAS transform) : le crossfade anime le transform,
  // donc un translate d'épinglage serait écrasé. top/left + margin:0 sont
  // orthogonaux au transform animé → l'élément reste à sa place pendant l'anim.
  node.style.position = 'absolute';
  node.style.margin = '0';
  node.style.width = w;
  node.style.height = h;
  op = node.offsetParent;
  if (!targetRect && op) {
    // sans rect (cas {if}/{key}) : boîte de mise en page, offsetLeft/offsetTop déjà relatifs
    // au bord de remplissage de l'offsetParent — pas de clientLeft/clientTop à soustraire
    node.style.left = node.offsetLeft + 'px';
    node.style.top = node.offsetTop + 'px';
  } else {
    opr = op ? op.getBoundingClientRect() : { left: 0, top: 0 };
    node.style.left = (a.left - opr.left - (op ? op.clientLeft : 0)) + 'px';
    node.style.top = (a.top - opr.top - (op ? op.clientTop : 0)) + 'px';
  }
  // flag posé pour que `µ._mjs_unfixPosition` sache
  // qu'IL a épinglé ce node (et pas un `position:absolute` du stylesheet de
  // l'appli, exclu par la garde ci-dessus) — cf. `_mjs_unfixPosition`.
  node._mjs_posFixed = true;
};

// Retire l'épinglage posé par `_mjs_fixPosition`, pour un node qui n'est FINALEMENT
// pas détruit (revival — `{for}` : key qui réapparaît pendant l'outro, cf.
// mjs_element.ts `_mjs_reconcileList` branche "DYING, reviving" ; `_mjs_tryReviveDying`
// pour {if}/{key}/{await}). SANS ce nettoyage, un
// node `@flip`+crossfade ressuscité restait bloqué en `position:absolute` avec
// une largeur/hauteur/position FIGÉES à son état de sortie — visuellement
// détaché du flux normal, même si son intro rejoue correctement par ailleurs.
// `removeProperty` (pas de valeur "avant" sauvegardée : `_mjs_fixPosition` ne lit
// que le COMPUTED style, jamais l'inline) → retombe sur le stylesheet, ou sur
// le prochain binding dynamique (`@style.*`) qui de toute façon se ré-applique
// dès le tout prochain `updateFn` de la row.
µ._mjs_unfixPosition = function(node) {
  if (!node || !node._mjs_posFixed || !node.style) {
    return;
  }
  node.style.removeProperty('position');
  node.style.removeProperty('margin');
  node.style.removeProperty('width');
  node.style.removeProperty('height');
  node.style.removeProperty('left');
  node.style.removeProperty('top');
  node._mjs_posFixed = false;
};

µ._mjs_playTransition = function(node, ref, direction) {
  var result;
  if (!ref) {
    _log(`playTransition ${direction} #${_txId(node)} → NO REF (skip)`);
    return Promise.resolve();
  }
  _log(`playTransition ${direction} #${_txId(node)} type=${typeof ref} isCfgFactory=${!!(ref != null ? ref._isCfgFactory : void 0)}`);
  // Anim migrée (factory pattern) : delegate. _mjs_runTransition fera abort
  // puis capture, dans le bon ordre.
  if (typeof ref === 'function' && ref._isCfgFactory) {
    return µ._mjs_runTransition(node, ref, direction);
  }
  // Legacy : la function démarre l'anim quand on la call. Result = Promise.
  if (typeof ref === 'function') {
    try {
      result = ref(node);
    } catch (error) {
      if (µ.debug) µ.warn('[mjs-tx] legacy transition threw', error);
      return Promise.resolve();
    }
    if (result instanceof Promise) {
      return result;
    }
    if (result != null ? result.css : void 0) {
      // Cas inattendu où legacy retourne quand même un cfg.
      return µ._mjs_runTransition(node, result, direction);
    }
    return Promise.resolve();
  }
  if (ref != null ? ref.css : void 0) {
    // Cfg pré-fait (cas rare, mais on supporte).
    return µ._mjs_runTransition(node, ref, direction);
  }
  return Promise.resolve();
};

// `µ.debug` est défini dans mjs_init (helpers µ.log/warn/error). Activer via
// `µ.debug = true` dans la console pour tracer le cycle de vie des
// transitions (intro/outro, abort, revive, rebuild from current t).

_txTag = 0;

_txId = function(node) {
  if (node._mjs_tx_id == null) {
    node._mjs_tx_id = ++_txTag;
  }
  return node._mjs_tx_id;
};

_log = function(...args) {
  if (µ.debug) {
    return µ.log("[mjs-tx]", ...args);
  }
};

µ._mjs_runTransition = function(node, cfgOrFactory, direction) {
  var baseDuration, cfg, delay, delta, duration, easing, f, i, j, keyframes, p, prev, ref1, ref2, ref3, ref4, state, steps, t, t1, t2;
  if (!cfgOrFactory) {
    return Promise.resolve();
  }
  prev = node._mjs_transition_state;
  t2 = direction === 'in' ? 1 : 0;
  // ORDRE CRITIQUE :
  // 1. Lire `t1` depuis prev AVANT abort (sinon prev.tValue → t1 par défaut).
  // 2. Abort : `prev.anim.cancel()` libère le `fill: 'forwards'` → le node
  //    redevient à son state inline (h=auto, dims naturelles).
  // 3. Capture (cfgOrFactory(node)) APRÈS abort → lit les dims naturelles.
  // Sans cet ordre, on capture des dims animées (figées par fill du prev).
  if (prev) {
    t1 = prev.tValue();
    prev.abort();
  } else {
    t1 = direction === 'in' ? 0 : 1;
  }
  // Cache cfg per-node (clé : factory) pour les anims **stateful** (tick mode).
  // En tick mode, le user capture une fois `node.textContent` (ou autre état
  // DOM) au setup. Si on rappelait le factory à chaque direction, on
  // recapturerait l'état partiel laissé par la direction précédente — bug.
  // Pour css mode, on laisse passer (recapture frais = comportement voulu :
  // animer FROM le style courant, qui peut avoir été modifié par drag/etc.).
  if (typeof cfgOrFactory === 'function') {
    if (node._mjs_tick_cfgs == null) {
      node._mjs_tick_cfgs = new Map();
    }
    if (node._mjs_tick_cfgs.has(cfgOrFactory)) {
      cfg = node._mjs_tick_cfgs.get(cfgOrFactory);
    } else {
      try {
        cfg = cfgOrFactory(node);
      } catch (error) {
        // setup() a levé (ex. garde typewriter sur markup imbriqué) :
        // même traitement symétrique que tick()/css() ci-dessous — signalé
        // TOUJOURS, transition close proprement (rien n'a encore été appliqué
        // au node à ce stade, il reste dans son état visible naturel).
        µ.warn(`[mjs-tx] setup() a levé (transition ${direction} #${_txId(node)}) — transition close proprement :`, error);
        return Promise.resolve(direction);
      }
      if (cfg != null && typeof cfg.tick === 'function') {
        node._mjs_tick_cfgs.set(cfgOrFactory, cfg);
      }
    }
  } else {
    cfg = cfgOrFactory;
  }
  if (cfg == null) {
    return Promise.resolve();
  }
  // === Tick mode : cfg.tick(t, u) appelée par-frame, l'utilisateur mute le DOM ===
  if (typeof cfg.tick === 'function') {
    return _runTickTransition(node, cfg, t1, t2, direction);
  }
  if (cfg.css == null) {
    return Promise.resolve();
  }
  // Branche shared : opt-in via `.shared` modifier. Pas de revival exact —
  // voir doc-architecture §3.15 (compromis assumé : optimisé one-shot).
  if (node._mjs_anim_mode === 'shared') {
    return _runSharedTransition(node, cfg, direction);
  }
  delta = t2 - t1;
  _log(`runTransition ${direction}`, `node=#${_txId(node)}`, `prev=${!!prev}`, `t1=${t1.toFixed(3)}`, `t2=${t2}`, `delta=${delta.toFixed(3)}`);
  if (Math.abs(delta) < 0.0001) {
    // Déjà à la cible : rien à faire.
    _log("  → SKIP (already at target)");
    return Promise.resolve();
  }
  baseDuration = (ref1 = cfg.duration) != null ? ref1 : 400;
  duration = Math.abs(delta) * baseDuration;
  delay = (ref2 = cfg.delay) != null ? ref2 : 0;
  // `delay` négatif : l'anim bidon anti-flash
  // ci-dessous fait `node.animate(…, { duration: delay })`, et WAAPI JETTE si
  // `duration < 0`. Un delay négatif n'a de sens ni pour l'anti-flash ni pour
  // la vraie anim → clamp à 0.
  if (delay < 0) {
    delay = 0;
  }
  easing = µ.easing.resolve(cfg.easing);
  // SÉCURITÉ —
  // Math.max(1, NaN) === NaN : même résidu que _runSharedTransition plus haut dans ce fichier.
  // absent → 60 (défaut) ; fini < 1 (0, négatif) → 1 (plancher) ; non fini/non numérique → 60
  // (repli, pas un pas très petit).
  steps = Number((ref3 = cfg.steps) != null ? ref3 : 60);
  if (!Number.isFinite(steps)) {
    steps = 60;
  } else if (steps < 1) {
    steps = (ref3 == null) ? 60 : 1;
  }
  // Frame de DÉPART (t1) seul, sans offset : sert à l'animation "bidon"
  // anti-flash ci-dessous. ERREUR UTILISATEUR dans cfg.css() (symétrique
  // au mode tick ci-dessus dans ce fichier) — avant : AUCUN try/catch, sortait
  // non capturée et cassait l'appelant. Désormais : capturée, signalée TOUJOURS
  // par µ.warn, transition close proprement — `node.animate()` n'a pas encore
  // été appelé à ce stade (ni bidon ni vraie anim), donc aucun `fill:forwards`
  // ne fige jamais le node à mi-keyframe (ex. opacity:0) : il reste dans son
  // état visible naturel.
  var startFrame;
  keyframes = [];
  try {
    startFrame = cfg.css(t1, 1 - t1);
    for (i = j = 0, ref4 = steps; (0 <= ref4 ? j <= ref4 : j >= ref4); i = 0 <= ref4 ? ++j : --j) {
      p = i / steps;
      t = t1 + delta * easing(p);
      f = cfg.css(t, 1 - t);
      f.offset = p;
      keyframes.push(f);
    }
  } catch (error) {
    µ.warn(`[mjs-tx] cfg.css() a levé (transition ${direction} #${_txId(node)}) — transition close proprement :`, error);
    return Promise.resolve(direction);
  }
  _log(`  duration=${duration}`, "kf[0]=", keyframes[0], "kf[end]=", keyframes[steps]);
  state = {
    direction: direction,
    t1: t1,
    delta: delta,
    easing: easing,
    aborted: false,
    anim: null,
    // Tant qu'on est dans la phase "bidon" (delay), on est figé à t1 : la
    // progression de l'anim bidon ne doit PAS être interprétée comme du t réel
    // (sinon une interruption pendant le delay repartirait d'un mauvais t).
    inDelay: true
  };
  state.tValue = function() {
    var progress, ref5, ref6, timing;
    if (this.aborted || !this.anim || this.inDelay) {
      return this.t1;
    }
    timing = (ref5 = this.anim.effect) != null ? typeof ref5.getComputedTiming === "function" ? ref5.getComputedTiming() : void 0 : void 0;
    progress = timing != null ? (ref6 = timing.progress) != null ? ref6 : 1 : 1;
    return this.t1 + this.delta * this.easing(progress);
  };
  state.abort = function() {
    var ref5;
    this.aborted = true;
    try {
      if ((ref5 = this.anim) != null) {
        ref5.cancel();
      }
    } catch (error) {
      if (µ.debug) µ.warn('[mjs-tx] abort', error);
    }
    this.anim = null;
    if (node._mjs_transition_state === this) {
      return node._mjs_transition_state = null;
    }
  };
  node._mjs_transition_state = state;
  // === Anti-flash (mécanisme Svelte, cf. sveltejs/svelte#14732) ===
  // On NE lance PAS directement la vraie animation : sans ça, WAAPI laisse le
  // navigateur peindre l'élément dans son état NATUREL une frame avant que
  // l'anim ne prenne la main → flash (texte blanc avant le spin). À la place,
  // on crée d'abord une animation "bidon" de la durée du `delay` (même 0) dont
  // les keyframes ne contiennent QUE le frame de départ `startFrame`, avec
  // `fill:'forwards'`. Comme elle finit aussitôt et fige son dernier frame,
  // l'élément est épinglé à t1 DÈS sa création, donc AVANT le 1er paint. On
  // bascule sur la vraie animation à son `finished`. Aucun style inline, aucun
  // masque opacity → ne pollue pas le sampling slide/fly.
  state.anim = node.animate([startFrame, startFrame], {
    duration: delay,
    fill: 'forwards'
  });
  return new Promise(function(resolve) {
    var startMain;
    startMain = function() {
      if (state.aborted) {
        return resolve(direction);
      }
      // Libère la bidon (son fill:forwards) et lance la vraie animation.
      try {
        state.anim.cancel();
      } catch (error) {
        if (µ.debug) µ.warn('[mjs-tx] dummy cancel', error);
      }
      state.inDelay = false;
      state.anim = node.animate(keyframes, {
        duration,
        fill: 'forwards'
      });
      return state.anim.finished.then(function() {
        if (state.aborted) {
          return;
        }
        _log(`  ✓ finished ${direction} on #${_txId(node)}`);
        node._mjs_transition_state = null;
        if (direction === 'out') {
          // flash-zombie : cancel() ICI libère le
          // `fill:'forwards'` DÈS QUE CE nœud individuel finit — mais un outro
          // de GROUPE (`_mjs_destroyNodeAndChildren`, mjs_element.ts, plusieurs
          // `elements` avec chacun leur propre transition, `Promise.all` les
          // attend TOUTES) ne retire le nœud du DOM qu'une fois le GROUPE ENTIER
          // résolu. Si CE nœud a une durée plus courte qu'un sibling/enfant, son
          // fill se libère AVANT que le groupe soit retiré → il "rebondit"
          // visuellement à son état naturel (ex. height auto au lieu de 0)
          // pendant que le reste du groupe est encore visible/en cours d'outro —
          // un flash bien réel, proportionnel à l'écart de durée entre membres.
          // Fix : on DIFFÈRE le cancel (fill toujours épinglé) via un hook que
          // `_mjs_destroyNodeAndChildren` appelle pour CHAQUE membre du groupe
          // JUSTE APRÈS que `Promise.all(transitions)` se soit résolu (plus
          // aucun sibling en vol à ce moment, donc plus aucun risque de
          // flash) — que le nœud soit ensuite réellement détruit OU ressuscité
          // (`_mjs_tryReviveDying`), le hook est appelé dans les 2 cas pour ne
          // jamais laisser un fill orphelin. Une transition 'in' (jamais en
          // groupe de destruction) continue de libérer immédiatement.
          node._mjs_pendingFillRelease = function() {
            try {
              state.anim.cancel();
            } catch (error) {
              if (µ.debug) µ.warn('[mjs-tx]', error);
            }
            node._mjs_pendingFillRelease = null;
          };
          return resolve(direction);
        }
        try {
          state.anim.cancel();
        } catch (error) {
          if (µ.debug) µ.warn('[mjs-tx]', error);
        }
        return resolve(direction);
      }).catch(function() {
        _log(`  ✗ aborted ${direction} on #${_txId(node)}`);
        return resolve(direction);
      });
    };
    // `finished` de la bidon → on enchaîne sur la vraie anim. Si la bidon est
    // annulée (abort pendant le delay), `finished` rejette → on résout.
    return state.anim.finished.then(startMain).catch(function() {
      _log(`  ✗ aborted (delay) ${direction} on #${_txId(node)}`);
      return resolve(direction);
    });
  });
};

// Joue une animation en mode @keyframes (injecte la règle, set
// `node.style.animation`, écoute `animationend` pour résoudre + GC).
// mode `.shared` sans abort : contrairement
// aux modes tick/css, cette fonction NE posait JAMAIS `node._mjs_transition_state`
// → `µ._mjs_runTransition` (qui fait `prev.abort()` dès qu'une 2e transition démarre
// sur un node qui en a déjà une en cours, ex. toggle rapide) ne pouvait JAMAIS
// trouver ni interrompre une transition `.shared` en vol. Conséquence concrète :
// 2 transitions `.shared` qui se chevauchent se battent sur `node.style.animation`
// — pire, le `onEnd` (animationcancel) du PREMIER appel reste actif et, en
// réassignant `node.style.animation`, écrase la valeur que le 2ᵉ appel vient de
// poser (le `prev` capturé par le 1er est le state D'AVANT LUI, pas celui du 2ᵉ).
// Fix : `state.abort()` retire les listeners + release les keyframes + resolve
// AVANT que le caller n'écrive la nouvelle valeur (même ordre que les 2 autres
// modes) → l'event `animationcancel` du natif ne trouve plus de listener à
// stomper. `tValue()` fournit une estimation par écoulement de temps (pas de
// WAAPI ici, juste `animation` CSS shorthand) — assez pour un revival cohérent
// si la transition suivante est en mode tick/css (le mode `.shared` lui-même ne
// s'en sert pas, cf. `_runSharedTransition`, "pas de t1/t2 logic").
µ.anim._mjs_runShared = function(node, name, builder, opts) {
  var delay, duration, easing, fill, prev, ref1, ref2, ref3, ref4, isIntro, root, start, state;
  // racine du nœud : un shadow root voit son PROPRE @keyframes, jamais celui du document
  root = typeof node.getRootNode === 'function' ? node.getRootNode() : document;
  if (!(root && root.host)) {
    root = document;
  }
  µ.anim._mjs_acquireKeyframes(name, builder, root);
  duration = (ref1 = opts.duration) != null ? ref1 : 400;
  delay = (ref2 = opts.delay) != null ? ref2 : 0;
  easing = (ref3 = opts.cssEasing) != null ? ref3 : 'linear'; // easing est déjà baked dans les frames
  fill = (ref4 = opts.fill) != null ? ref4 : 'forwards';
  isIntro = opts.direction === 'in';
  prev = node.style.animation;
  node.style.animation = `${name} ${duration}ms ${easing} ${delay}ms ${fill}`;
  start = performance.now();
  state = {
    aborted: false,
    direction: opts.direction
  };
  state.tValue = function() {
    var elapsed, p;
    elapsed = performance.now() - start - delay;
    p = Math.min(Math.max(elapsed / Math.max(duration, 1e-6), 0), 1);
    return isIntro ? p : 1 - p;
  };
  node._mjs_transition_state = state;
  return new Promise(function(resolve) {
    var onEnd, settled, settle;
    settled = false;
    settle = function() {
      if (settled) return;
      settled = true;
      node.removeEventListener('animationend', onEnd);
      node.removeEventListener('animationcancel', onEnd);
      µ.anim._mjs_releaseKeyframes(name, root);
      if (node._mjs_transition_state === state) {
        node._mjs_transition_state = null;
      }
      return resolve();
    };
    onEnd = function(e) {
      // filtre `e.target`/`e.animationName` :
      // `animationend`/`animationcancel` BUBBLENT. Sans garde, (1) l'anim CSS
      // d'un DESCENDANT qui se termine résout à tort la transition `.shared` du
      // PARENT (et restaure `prev` → anim coupée net, groupe d'outro faussé) ;
      // (2) en vrai navigateur, remplacer `style.animation` (toggle rapide) émet
      // un `animationcancel` pour l'ANCIENNE anim — reçu par le `onEnd` de la
      // NOUVELLE transition (listeners attachés synchrone), qui settlerait aussitôt
      // et réécrirait un `prev` périmé → la 2ᵉ transition tuée ~1 frame après son
      // départ. On ne réagit donc qu'à un event dont la cible EST `node` ET dont
      // l'`animationName` (quand présent) EST le keyframe de CETTE transition
      // (`name`, en closure). Les events synthétiques sans `animationName` (tests,
      // moteurs sans AnimationEvent) passent la garde. Précédent : `µ.play`
      // (mjs_runes.ts) filtre déjà `if (e && e.target !== node) return`.
      if (e && (e.target !== node || (e.animationName && e.animationName !== name))) {
        return;
      }
      node.style.animation = prev;
      return settle();
    };
    state.abort = function() {
      this.aborted = true;
      // PAS de `node.style.animation = prev` ici : le caller (nouvelle
      // transition) va écrire SA propre valeur juste après ce retour — le
      // faire ici serait immédiatement écrasé, sans risque, mais inutile.
      // Le point CRITIQUE est de retirer les listeners MAINTENANT, avant cet
      // écrasement, pour que le futur `animationcancel` natif ne trouve plus
      // `onEnd` (qui écrirait `prev` — LA VALEUR D'AVANT CE state À LUI —
      // par-dessus la nouvelle transition, après coup).
      return settle();
    };
    node.addEventListener('animationend', onEnd);
    return node.addEventListener('animationcancel', onEnd);
  });
};
