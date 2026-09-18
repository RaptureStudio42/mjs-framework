// mjs_vt_presets.coffee

// BIBLIOTHÈQUE DE PRÉRÉGLAGES @viewTransition — dictionnaire nom → CSS (ou fabrique
// directionnelle) + RIDEAUX « à travers le noir » (vrai DOM). Cascade
// (config/@viewTransition/@pageTransition) : cf. mjs_router.ts (_mjs_vtResolveNavigation) et
// mjs_ujs.ts (_mjs_vtResolvePage) — CE fichier ne résout rien, il fournit le CSS,
// l'injecteur, l'analyse nom:direction et le moteur de rideau, consommés par les DEUX.
//
// DEUX FAMILLES, deux moteurs :
// - Préréglages PSEUDOS (fade, slide, zoom…, cube, turn) : feuille ciblant
//   ::view-transition-old/new(root), animée par l'API View Transitions. Les
//   transforms/opacity/filter s'y peignent fiablement.
// - RIDEAUX (iris, swipe, bars, blocks) : mesuré en conditions réelles,
//   mask-* et clip-path se CALCULENT mais ne se PEIGNENT PAS toujours sur les
//   pseudos (contenus composités) — alors on ne les utilise plus : un VRAI
//   calque #mjs-vt-curtain au-dessus du body COUVRE l'écran (phase 1), la
//   permutation se fait SOUS le noir, puis le calque RÉVÈLE (phase 2). Même
//   philosophie que les overlays d'une implémentation interne antérieure : du DOM ordinaire,
//   masques/cascades/délais 100 % fiables. Grammaire « écran de combat ».
//
// DIRECTION : uniquement via la clé d'option `direction`/`dir` (µ._mjs_vtParse) —
// le suffixe `nom:direction` et les anciens alias suffixés (slide-left,
// cube-up, turn-right…) sont RETIRÉS. `nom` seul = direction par défaut
// (µ._mjs_vtDirDefaults).

µ._mjs_vtDirs = ['left', 'right', 'up', 'down'];
µ._mjs_vtDirDefaults = { slide: 'left', volet: 'down', reveal: 'up', flip: 'left', cube: 'left', turn: 'left', swipe: 'right', bars: 'down' };
µ._mjs_vtDirectionalBases = ['slide', 'volet', 'reveal', 'flip', 'cube', 'turn', 'swipe', 'bars'];
µ._mjs_vtOptionKeys = ['direction', 'duration', 'priority'];
µ._mjs_vtOptionShort = { direction: 'dir', duration: 'dur', priority: 'p' };
µ._mjs_vtOptionKeyAliases = { direction: 'direction', dir: 'direction', duration: 'duration', dur: 'duration', priority: 'priority', p: 'priority' };

// Syntaxe OBJET `@viewTransition.<nom>={ direction, duration, priority }`
// (calquée sur `@transition.fly={ y: 200, duration: 2000 }`, mini-grammaire
// TEXTE, PAS du JS évalué ; clés LONGUES ou COURTES — direction/dir,
// duration/dur, priority/p —, mixables librement). Analyse une valeur de
// préréglage COMPLÈTE : name-only, ou `nom={ clé: valeur, … }` — retourne
// { base, dir, durationMs, priority } (durationMs/priority `null` si
// absents). TOUJOURS TOLÉRANT (jamais de throw, cf. µ._mjs_vtApplyPreset/
// µ._mjs_vtCurtainRun appelés en aval d'une navigation déjà en cours) : chaîne
// malformée ⇒ µ.warn + repli name-only (tronqué au premier '=') ; suffixe
// `:direction` sur le NOM (RETIRÉ de la grammaire, rejeté à la compilation
// aux QUATRE positions désormais — avant, deux d'entre
// elles l'avalaient en silence, la promesse de ce commentaire était donc
// fausse ; ce repli ne joue qu'au runtime dynamique, `µ.viewTransition = …`
// en JS pur, jamais relu par le compilateur) ⇒
// µ.warn + repli sur la partie AVANT le `:` (la direction demandée après le
// `:` n'est JAMAIS honorée) ; direction invalide, clé d'option inconnue ou en
// double (forme courte ET longue), duration/priority mal formées ⇒ µ.warn +
// option ignorée (jamais un crash).
µ._mjs_vtParse = function(name) {
  var m, base, dir, durationMs, priority, namePart, optsRaw, pairs, i, pair, pm, rawKey, key, val, dm, num, seen, colonIdx;
  if (typeof name !== 'string') { return { base: name, dir: null, durationMs: null, priority: null }; }
  dir = null; durationMs = null; priority = null;
  m = name.match(/^([^=]+?)(?:=\s*\{([^}]*)\}\s*)?$/);
  if (m) {
    namePart = m[1].trim();
    optsRaw = m[2];
  }
  else {
    namePart = name.split('=')[0].trim();
    optsRaw = undefined;
    µ.warn(`[ModularJS] @viewTransition : valeur malformée '${name}' — repli sur '${namePart}'.`);
  }
  colonIdx = namePart.indexOf(':');
  if (colonIdx !== -1) {
    µ.warn(`[ModularJS] @viewTransition : la direction ne s'écrit plus dans le nom ('${namePart}') — repli sur '${namePart.slice(0, colonIdx)}', pose 'dir'/'direction' en option.`);
    namePart = namePart.slice(0, colonIdx);
  }
  m = namePart.match(/^([a-z][a-z0-9-]*)$/);
  if (!m) { return { base: name, dir: null, durationMs: null, priority: null }; }
  base = m[1];
  if (optsRaw != null && optsRaw.trim() !== '') {
    pairs = optsRaw.split(',');
    seen = {};
    for (i = 0; i < pairs.length; i++) {
      pair = pairs[i].trim();
      if (!pair) { continue; } // virgule finale tolérée
      pm = pair.match(/^([a-zA-Z]+)\s*:\s*(.+)$/);
      if (!pm) { µ.warn(`[ModularJS] @viewTransition : option malformée '${pair}' dans '${name}' — ignorée.`); continue; }
      rawKey = pm[1];
      key = µ._mjs_vtOptionKeyAliases[rawKey];
      if (!key) {
        µ.warn(`[ModularJS] @viewTransition : clé inconnue '${rawKey}' dans '${name}' — ignorée (clés valides : ${µ._mjs_vtOptionKeys.map(function(k) { return k + '/' + µ._mjs_vtOptionShort[k]; }).join(', ')}).`);
        continue;
      }
      if (seen[key]) { µ.warn(`[ModularJS] @viewTransition : clé '${key}' en double dans '${name}' ('${key}'/'${µ._mjs_vtOptionShort[key]}' désignent la même option) — 2e occurrence ignorée.`); continue; }
      seen[key] = true;
      val = pm[2].trim();
      if ((val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') || (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")) { val = val.slice(1, -1).trim(); }
      if (key === 'direction') {
        if (µ._mjs_vtDirs.indexOf(val) === -1) { µ.warn(`[ModularJS] @viewTransition : direction invalide '${val}' dans '${name}' — ignorée.`); continue; }
        dir = val;
      }
      else if (key === 'duration') {
        // Nombre NU uniquement, toujours des ms (cohérence setTimeout) :
        // 'ms'/'s' suffixés N'EXISTENT PLUS (RETRAIT).
        dm = val.match(/^(\d+)$/);
        if (!dm) { µ.warn(`[ModularJS] @viewTransition : duration invalide '${val}' dans '${name}' — un nombre nu en millisecondes (comme setTimeout), ex. dur: 600 — ignorée.`); continue; }
        num = parseInt(dm[1], 10);
        if (!(num > 0)) { µ.warn(`[ModularJS] @viewTransition : duration invalide '${val}' dans '${name}' — un nombre nu en millisecondes (comme setTimeout), ex. dur: 600 — ignorée.`); continue; }
        durationMs = num;
      }
      else if (key === 'priority') {
        if (!/^\d+$/.test(val)) { µ.warn(`[ModularJS] @viewTransition : priority invalide '${val}' dans '${name}' — ignorée.`); continue; }
        priority = parseInt(val, 10);
      }
    }
  }
  return { base: base, dir: dir, durationMs: durationMs, priority: priority };
};

// Durées PAR DÉFAUT (ms) de chaque base — lues dans les préréglages ci-dessous
// (pseudos : durée d'animation de la base ; rideaux : coverMs+revealMs de la
// spec, cycle complet). Référence de l'ÉCHELLE proportionnelle de `duration:`
// — facteur = durationMs demandé / défaut de la base — cf. µ._mjs_vtScaleCss,
// µ._mjs_vtApplyPreset, µ._mjs_vtCurtainRun.
µ._mjs_vtDefaultMs = {
  fade: 500, zoom: 450, 'zoom-out': 450, slide: 260, volet: 380, reveal: 380,
  flip: 550, cube: 600, turn: 600,
  iris: 720, swipe: 620, bars: 1260, blocks: 1220,
};

// Multiplie CHAQUE jeton temporel (durées ET délais de cascade, unité `ms` ou
// `s`) d'un bloc CSS par `factor`, unité d'origine préservée. `factor` absent/1
// → identité (no-op), jamais de ré-écriture inutile.
µ._mjs_vtScaleCss = function(css, factor) {
  if (!factor || factor === 1) { return css; }
  return css.replace(/(\d*\.?\d+)(ms|s)\b/g, function(_m, num, unit) {
    var v = Math.round(parseFloat(num) * factor * 100) / 100;
    return v + unit;
  });
};

// ──────────────────────────────────────────────────────────────────────────
// PRÉRÉGLAGES PSEUDOS — chaînes fixes ou fabriques (dir) → CSS. Keyframes
// préfixées mjs-vt-* (namespace) ; les fabriques gardent des NOMS de keyframes
// stables par base (une seule feuille active à la fois). perspective toujours
// sur ::view-transition-image-pair(root) (parent DIRECT de old/new — sur -group
// elle n'atteindrait jamais les faces) ; mix-blend-mode:normal partout où des
// couches opaques s'empilent (le plus-lighter du spec délave la surimpression).
µ._vtPresets = {
  // Fondu croisé — assez long pour se VOIR (.5s ; à .2s on le ratait).
  fade: `
::view-transition-old(root),::view-transition-new(root){animation-duration:.5s;animation-timing-function:ease;animation-fill-mode:both}
::view-transition-old(root){animation-name:mjs-vt-fade-out}
::view-transition-new(root){animation-name:mjs-vt-fade-in}
@keyframes mjs-vt-fade-out{to{opacity:0}}
@keyframes mjs-vt-fade-in{from{opacity:0}}
`,
  // Zoom avant FRANC (calibre d'une implémentation interne antérieure) : la nouvelle surgit de 55 %, l'ancienne
  // éclate vers l'avant en s'effaçant.
  zoom: `
::view-transition-old(root),::view-transition-new(root){animation-duration:.45s;animation-timing-function:cubic-bezier(.2,.7,.3,1);animation-fill-mode:both;mix-blend-mode:normal}
::view-transition-old(root){animation-name:mjs-vt-zoom-out}
::view-transition-new(root){animation-name:mjs-vt-zoom-in}
@keyframes mjs-vt-zoom-out{to{transform:scale(1.3);opacity:0}}
@keyframes mjs-vt-zoom-in{from{transform:scale(.55);opacity:0}to{transform:scale(1);opacity:1}}
`,
  // Miroir de zoom : la nouvelle retombe de 145 %, l'ancienne s'enfonce.
  'zoom-out': `
::view-transition-old(root),::view-transition-new(root){animation-duration:.45s;animation-timing-function:cubic-bezier(.2,.7,.3,1);animation-fill-mode:both;mix-blend-mode:normal}
::view-transition-old(root){animation-name:mjs-vt-zoomout-out}
::view-transition-new(root){animation-name:mjs-vt-zoomout-in}
@keyframes mjs-vt-zoomout-out{to{transform:scale(.6);opacity:0}}
@keyframes mjs-vt-zoomout-in{from{transform:scale(1.45);opacity:0}to{transform:scale(1);opacity:1}}
`,
  // Glissement : l'ancienne sort vers `dir`, la nouvelle entre du côté opposé.
  slide: function(dir) {
    var t = { left: ['X', '-100%', '100%'], right: ['X', '100%', '-100%'], up: ['Y', '-100%', '100%'], down: ['Y', '100%', '-100%'] }[dir];
    return `
::view-transition-old(root),::view-transition-new(root){animation-duration:.26s;animation-timing-function:ease;animation-fill-mode:both}
::view-transition-old(root){animation-name:mjs-vt-slide-out}
::view-transition-new(root){animation-name:mjs-vt-slide-in}
@keyframes mjs-vt-slide-out{to{transform:translate${t[0]}(${t[1]})}}
@keyframes mjs-vt-slide-in{from{transform:translate${t[0]}(${t[2]})}}
`;
  },
  // Volet : la nouvelle recouvre en arrivant DEPUIS le côté opposé à `dir`
  // (volet:down = un store qui DESCEND), l'ancienne immobile dessous.
  volet: function(dir) {
    var from = { down: 'translateY(-100%)', up: 'translateY(100%)', left: 'translateX(100%)', right: 'translateX(-100%)' }[dir];
    return `
::view-transition-old(root),::view-transition-new(root){mix-blend-mode:normal}
::view-transition-old(root){animation:none}
::view-transition-new(root){animation:mjs-vt-volet-in .38s ease-out both}
@keyframes mjs-vt-volet-in{from{transform:${from}}to{transform:translate(0,0)}}
`;
  },
  // Reveal : l'ancienne sort vers `dir` (au-dessus, z-index:1) ; la nouvelle
  // attend DESSOUS en retrait (échelle + ombre) et remonte à sa place.
  reveal: function(dir) {
    var to = { up: 'translateY(-100%)', down: 'translateY(100%)', left: 'translateX(-100%)', right: 'translateX(100%)' }[dir];
    return `
::view-transition-old(root),::view-transition-new(root){mix-blend-mode:normal}
::view-transition-new(root){animation:mjs-vt-reveal-under .38s ease-in both}
::view-transition-old(root){animation:mjs-vt-reveal-out .38s ease-in both;z-index:1}
@keyframes mjs-vt-reveal-out{to{transform:${to}}}
@keyframes mjs-vt-reveal-under{from{transform:scale(.92);filter:brightness(.5)}to{transform:scale(1);filter:brightness(1)}}
`;
  },
  // VRAI retournement en place (carte) : l'ancienne pivote jusqu'à la tranche
  // (1re moitié), la nouvelle enchaîne de la tranche à plat (2de) — passation
  // exacte à mi-course par backface-visibility. `dir` = sens de rotation.
  flip: function(dir) {
    var t = { left: ['rotateY(-90deg)', 'rotateY(90deg)'], right: ['rotateY(90deg)', 'rotateY(-90deg)'], up: ['rotateX(90deg)', 'rotateX(-90deg)'], down: ['rotateX(-90deg)', 'rotateX(90deg)'] }[dir];
    return `
::view-transition-image-pair(root){perspective:1200px}
::view-transition-old(root),::view-transition-new(root){animation-duration:.55s;animation-timing-function:ease-in-out;animation-fill-mode:both;backface-visibility:hidden;mix-blend-mode:normal;transform-origin:center}
::view-transition-old(root){animation-name:mjs-vt-flip-out}
::view-transition-new(root){animation-name:mjs-vt-flip-in}
@keyframes mjs-vt-flip-out{0%{transform:rotateY(0) rotateX(0)}50%,100%{transform:${t[0]}}}
@keyframes mjs-vt-flip-in{0%,50%{transform:${t[1]}}100%{transform:rotateY(0) rotateX(0)}}
`;
  },
  // Rotation façon cube — maths EXACTES adaptées d'une implémentation interne antérieure : les
  // 2 faces tournent RIGIDEMENT autour du MÊME axe enfoncé à z=-moitié (50vw
  // horizontal, 50vh vertical) ; assombrissement ≡ overlays d'ombrage de flux.
  cube: function(dir) {
    var t = {
      left:  ['-50vw', 'rotateY(-90deg)', 'rotateY(90deg)'],
      right: ['-50vw', 'rotateY(90deg)', 'rotateY(-90deg)'],
      up:    ['-50vh', 'rotateX(90deg)', 'rotateX(-90deg)'],
      down:  ['-50vh', 'rotateX(-90deg)', 'rotateX(90deg)'],
    }[dir];
    return `
::view-transition-image-pair(root){perspective:1600px}
::view-transition-old(root),::view-transition-new(root){animation-duration:.6s;animation-timing-function:cubic-bezier(.45,.05,.55,.95);animation-fill-mode:both;backface-visibility:hidden;mix-blend-mode:normal;transform-origin:50% 50% ${t[0]}}
::view-transition-old(root){animation-name:mjs-vt-cube-out}
::view-transition-new(root){animation-name:mjs-vt-cube-in}
@keyframes mjs-vt-cube-out{from{transform:rotateY(0) rotateX(0);filter:brightness(1)}to{transform:${t[1]};filter:brightness(.35)}}
@keyframes mjs-vt-cube-in{from{transform:${t[2]};filter:brightness(.35)}to{transform:rotateY(0) rotateX(0);filter:brightness(1)}}
`;
  },
  // Pli de page (adaptation d'une implémentation interne antérieure) : l'ancienne
  // pivote sur le bord `dir` au-delà de 90° (backface la fait disparaître passé
  // le profil, comme le tab de flux à -179°), la nouvelle remonte de l'ombre
  // (≡ overlay noir de flux). z-index:1 : la page qui tourne reste AU-DESSUS.
  turn: function(dir) {
    var t = {
      left:  ['left center', 'rotateY(-160deg)'],
      right: ['right center', 'rotateY(160deg)'],
      up:    ['top center', 'rotateX(160deg)'],
      down:  ['bottom center', 'rotateX(-160deg)'],
    }[dir];
    return `
::view-transition-image-pair(root){perspective:1300px}
::view-transition-old(root),::view-transition-new(root){animation-duration:.6s;animation-fill-mode:both;mix-blend-mode:normal}
::view-transition-old(root){animation-name:mjs-vt-turn-out;animation-timing-function:ease-in;transform-origin:${t[0]};backface-visibility:hidden;z-index:1}
::view-transition-new(root){animation-name:mjs-vt-turn-shade;animation-timing-function:linear}
@keyframes mjs-vt-turn-out{from{transform:rotateY(0) rotateX(0)}to{transform:${t[1]}}}
@keyframes mjs-vt-turn-shade{from{filter:brightness(.4)}to{filter:brightness(1)}}
`;
  },
};

// ──────────────────────────────────────────────────────────────────────────
// RIDEAUX « À TRAVERS LE NOIR » (#mjs-vt-curtain) — vrai DOM, deux phases :
// COUVRIR (l'écran finit noir) → permutation SOUS le noir → RÉVÉLER. Chaque
// spec fournit coverMs/revealMs, un html(dir) (les bandes/tuiles, délais par
// --i inline) et un css(dir) (keyframes .cover/.reveal). Le mouvement CONTINUE
// dans le même sens à la révélation (crédibilité du geste, façon flux).
µ._mjs_vtCurtains = {
  // Iris : famille FUSIONNÉE (iris-in devient l'unique `iris`, iris-out
  // retiré — un seul sens jugé utile) — le noir naît au CENTRE et engloutit
  // l'écran (rond NET : masque peint sur un VRAI div), COUVRE, la page permute
  // SOUS le noir, puis le noir s'ouvre en trou central grandissant. Rayon
  // animé par @property --mjs-vtc-r (percentage ENREGISTRÉE) plutôt que
  // mask-size : l'ancien mask-size 1%→320% en no-repeat laissait tout ce qui
  // déborde de la boîte du masque SANS masque (alpha 0) — au 1er instant du
  // révéler la boîte repartait de 1 %, le voile noir disparaissait quelques
  // trames (CLIGNOTEMENT) avant que le trou ne grandisse. Ici le masque
  // couvre TOUJOURS tout le voile : fin de fermeture (r:110%) ≡ début
  // d'ouverture (r:0%) → trames identiques au raccord. Overshoot 110% (pas
  // 100% pile) = marge EN PLUS sur la course du setTimeout(coverMs). Plumeau
  // 0.3% (calc(r + 0.3%)) = anti-crénelage du bord, comme l'ancien 49.7/50%.
  iris: {
    coverMs: 340, revealMs: 380,
    html: function() { return '<i class="mjs-vtc-veil"></i>'; },
    css: function() {
      return `
@property --mjs-vtc-r{syntax:'<percentage>';inherits:false;initial-value:0%}
#mjs-vt-curtain .mjs-vtc-veil{position:absolute;inset:0;background:#000;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat}
#mjs-vt-curtain.mjs-vtc-cover .mjs-vtc-veil{-webkit-mask-image:radial-gradient(circle,#000 var(--mjs-vtc-r),transparent calc(var(--mjs-vtc-r) + 0.3%));mask-image:radial-gradient(circle,#000 var(--mjs-vtc-r),transparent calc(var(--mjs-vtc-r) + 0.3%));animation:mjs-vtc-iris-close .34s ease-in both}
#mjs-vt-curtain.mjs-vtc-reveal .mjs-vtc-veil{-webkit-mask-image:radial-gradient(circle,transparent var(--mjs-vtc-r),#000 calc(var(--mjs-vtc-r) + 0.3%));mask-image:radial-gradient(circle,transparent var(--mjs-vtc-r),#000 calc(var(--mjs-vtc-r) + 0.3%));animation:mjs-vtc-iris-open .38s ease-out both}
@keyframes mjs-vtc-iris-close{from{--mjs-vtc-r:0%}to{--mjs-vtc-r:110%}}
@keyframes mjs-vtc-iris-open{from{--mjs-vtc-r:0%}to{--mjs-vtc-r:110%}}
`;
    },
  },
  // Balayage — l'esprit EXACT d'une implémentation interne antérieure : un front DOUX
  // (dégradé) traverse l'écran, couvre, puis CONTINUE dans le même sens et
  // découvre. `dir` = sens de course du front.
  swipe: function(dir) {
    var g = {
      right: ['to right', 'translateX(-100%)', 'translateX(100%)'],
      left:  ['to left',  'translateX(100%)', 'translateX(-100%)'],
      down:  ['to bottom', 'translateY(-100%)', 'translateY(100%)'],
      up:    ['to top',    'translateY(100%)', 'translateY(-100%)'],
    }[dir];
    return {
      coverMs: 300, revealMs: 320,
      html: function() { return '<i class="mjs-vtc-veil"></i>'; },
      css: function() {
        return `
#mjs-vt-curtain .mjs-vtc-veil{position:absolute;top:-30%;left:-30%;width:160%;height:160%;background:linear-gradient(${g[0]},transparent 0%,#000 22%,#000 100%)}
#mjs-vt-curtain.mjs-vtc-cover .mjs-vtc-veil{animation:mjs-vtc-swipe-cover .3s ease-in both}
#mjs-vt-curtain.mjs-vtc-reveal .mjs-vtc-veil{animation:mjs-vtc-swipe-reveal .32s ease-out both}
@keyframes mjs-vtc-swipe-cover{from{transform:${g[1]}}to{transform:translate(0,0)}}
@keyframes mjs-vtc-swipe-reveal{from{transform:translate(0,0)}to{transform:${g[2]}}}
`;
      },
    };
  },
  // Bandes en cascade (l'esprit bars/bars3d d'une implémentation interne antérieure) : 8 bandes tombent
  // l'une après l'autre (délais --i), couvrent, puis CONTINUENT leur chute et
  // découvrent. `dir` = sens de chute (left/right = bandes horizontales).
  bars: function(dir) {
    var vertical = dir === 'down' || dir === 'up';
    var from = { down: 'translateY(-102%)', up: 'translateY(102%)', left: 'translateX(102%)', right: 'translateX(-102%)' }[dir];
    var to = { down: 'translateY(102%)', up: 'translateY(-102%)', left: 'translateX(-102%)', right: 'translateX(102%)' }[dir];
    var i, cells = '';
    for (i = 0; i < 8; i++) { cells += `<i class="mjs-vtc-bar" style="--i:${i}"></i>`; }
    return {
      coverMs: 620, revealMs: 640,
      html: function() { return cells; },
      css: function() {
        return `
#mjs-vt-curtain{display:flex;flex-direction:${vertical ? 'row' : 'column'}}
#mjs-vt-curtain .mjs-vtc-bar{flex:1;background:#000;box-shadow:0 0 0 1px #000}
#mjs-vt-curtain.mjs-vtc-cover .mjs-vtc-bar{animation:mjs-vtc-bar-cover .26s ease-in both;animation-delay:calc(var(--i)*45ms)}
#mjs-vt-curtain.mjs-vtc-reveal .mjs-vtc-bar{animation:mjs-vtc-bar-reveal .26s ease-in both;animation-delay:calc(var(--i)*45ms)}
@keyframes mjs-vtc-bar-cover{from{transform:${from}}to{transform:translate(0,0)}}
@keyframes mjs-vtc-bar-reveal{from{transform:translate(0,0)}to{transform:${to}}}
`;
      },
    };
  },
  // Damier qui s'effondre (l'esprit blocks/tiles3d d'une implémentation interne antérieure) : une grille de
  // tuiles noires surgit en vague diagonale (scale+rotation), couvre, puis
  // s'effondre dans le même ordre pour découvrir la nouvelle page.
  blocks: {
    coverMs: 600, revealMs: 620,
    html: function() {
      var x, y, cells = '';
      for (y = 0; y < 4; y++) { for (x = 0; x < 6; x++) { cells += `<i class="mjs-vtc-block" style="--i:${x + y}"></i>`; } }
      return cells;
    },
    css: function() {
      return `
#mjs-vt-curtain{display:grid;grid-template-columns:repeat(6,1fr);grid-template-rows:repeat(4,1fr)}
#mjs-vt-curtain .mjs-vtc-block{background:#000;box-shadow:0 0 0 1px #000}
#mjs-vt-curtain.mjs-vtc-cover .mjs-vtc-block{animation:mjs-vtc-block-cover .24s ease-out both;animation-delay:calc(var(--i)*40ms)}
#mjs-vt-curtain.mjs-vtc-reveal .mjs-vtc-block{animation:mjs-vtc-block-reveal .24s ease-in both;animation-delay:calc(var(--i)*40ms)}
@keyframes mjs-vtc-block-cover{from{transform:scale(0) rotate(-90deg)}to{transform:scale(1.02) rotate(0)}}
@keyframes mjs-vtc-block-reveal{from{transform:scale(1.02) rotate(0)}to{transform:scale(0) rotate(90deg)}}
`;
    },
  },
};

// Jeton de génération anti-chevauchement : un rideau relancé pendant qu'un
// autre joue INVALIDE toutes les continuations du précédent (mêmes raisons que
// la couche de lévitation — jamais deux calques, jamais un nettoyage périmé).
µ._mjs_vtCurtainSeq = 0;
// sous `µ._csp` : feuille constructible unique adoptée sur `document`, remplace le
// `<style id="mjs-vt-curtain-css">` — `replaceSync` tient lieu de `textContent =`.
µ._mjs_vtCurtainCspSheet = null;
// idem pour le `<style id="mjs-vt-presets">` (préréglages pseudos)
µ._mjs_vtPresetCspSheet = null;

// Joue `value` (base:dir) en RIDEAU si sa base en est un : couvre → swap sous le
// noir (double rAF : les styles statiques du composant injecté atterrissent un
// battement après l'appendChild) → révèle → démonte. Renvoie true si pris en
// charge, false sinon (l'appelant retombe alors sur l'API View Transitions).
// Filets par setTimeout (jamais animationend : N bandes = N événements).
µ._mjs_vtCurtainRun = function(value, swap) {
  var p, spec, seq, layer, sheet, prev, factor, css, coverMs, revealMs;
  if (µ._isServer || typeof document === 'undefined') { return false; }
  p = µ._mjs_vtParse(value);
  spec = µ._mjs_vtCurtains[p.base];
  if (!spec) { return false; }
  if (typeof spec === 'function') { spec = spec(p.dir || µ._mjs_vtDirDefaults[p.base] || 'down'); }
  // duration: met à l'échelle le CSS ET les minuteries JS (coverMs/revealMs)
  // par le MÊME facteur — sinon le CSS animerait à une vitesse mais le swap DOM
  // interviendrait au mauvais moment (désynchronisation cover/reveal).
  factor = (p.durationMs && µ._mjs_vtDefaultMs[p.base]) ? (p.durationMs / µ._mjs_vtDefaultMs[p.base]) : 1;
  css = µ._mjs_vtScaleCss(spec.css(), factor);
  coverMs = Math.round(spec.coverMs * factor);
  revealMs = Math.round(spec.revealMs * factor);
  seq = ++µ._mjs_vtCurtainSeq;
  prev = document.getElementById('mjs-vt-curtain');
  if (prev) { prev.remove(); }
  if (µ._csp) {
    if (!µ._mjs_vtCurtainCspSheet) {
      µ._mjs_vtCurtainCspSheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, µ._mjs_vtCurtainCspSheet];
    }
    µ._mjs_vtCurtainCspSheet.replaceSync(css);
    sheet = µ._mjs_vtCurtainCspSheet;
  } else {
    prev = document.getElementById('mjs-vt-curtain-css');
    if (prev) { prev.remove(); }
    sheet = document.createElement('style');
    sheet.id = 'mjs-vt-curtain-css';
    sheet.textContent = css;
    document.head.appendChild(sheet);
  }
  layer = document.createElement('div');
  layer.id = 'mjs-vt-curtain';
  layer.className = 'mjs-vtc-cover';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  layer.innerHTML = spec.html();
  document.body.appendChild(layer);
  setTimeout(function() {
    if (seq !== µ._mjs_vtCurtainSeq) { return; }
    // swap() tournait SANS garde sous le rideau noir : une
    // permutation qui lève abandonnait le reste de ce callback (double rAF + révélation + retrait)
    // → #mjs-vt-curtain restait à vie, écran noir permanent. La révélation continue quand même.
    try { swap(); } catch (e) { µ.error('[ModularJS] @viewTransition : la permutation sous rideau a levé —', e); }
    requestAnimationFrame(function() { requestAnimationFrame(function() {
      if (seq !== µ._mjs_vtCurtainSeq) { return; }
      layer.className = 'mjs-vtc-reveal';
      setTimeout(function() {
        if (seq !== µ._mjs_vtCurtainSeq) { return; }
        layer.remove();
        if (!µ._csp) { sheet.remove(); }
      }, revealMs + 80);
    }); });
  }, coverMs);
  return true;
};

// Injecte (ou remplace) la feuille UNIQUE des préréglages PSEUDOS dans
// document.head. PARESSEUX : appelé juste avant `startViewTransition` (cf.
// mjs_router.ts/mjs_ujs.ts) — jamais au boot, jamais côté serveur. `true`
// (résolution « on » : fondu natif), nom de RIDEAU (géré par _mjs_vtCurtainRun, pas
// de feuille pseudo) et nom INCONNU (µ.warn) VIDENT tous la feuille existante —
// sans cette purge, le CSS du DERNIER préréglage rejouait (feuille périmée).
µ._mjs_vtApplyPreset = function(name) {
  var css, sheet, p, entry, factor, setCss;
  if (µ._isServer || typeof document === 'undefined') { return; }
  if (µ._csp) {
    if (!µ._mjs_vtPresetCspSheet) {
      µ._mjs_vtPresetCspSheet = new CSSStyleSheet();
      µ._mjs_vtPresetCspSheet.replaceSync('');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, µ._mjs_vtPresetCspSheet];
    }
    sheet = µ._mjs_vtPresetCspSheet;
    setCss = function(c) { sheet.replaceSync(c || ''); };
  } else {
    sheet = document.getElementById('mjs-vt-presets');
    setCss = function(c) { sheet.textContent = c || ''; };
  }
  if (name === true) { if (sheet) { setCss(''); } return; }
  p = µ._mjs_vtParse(name);
  entry = µ._vtPresets[p.base];
  if (!entry) {
    if (!µ._mjs_vtCurtains[p.base]) {
      µ.warn(`[ModularJS] @viewTransition : préréglage inconnu '${name}' — valeurs valides : ${Object.keys(µ._vtPresets).join(', ')}, ${Object.keys(µ._mjs_vtCurtains).join(', ')} (pour orienter une base directionnelle : l'option { dir: left }, le suffixe ':left' a été retiré en v6).`);
    }
    if (sheet) { setCss(''); }
    return;
  }
  css = typeof entry === 'function' ? entry(p.dir || µ._mjs_vtDirDefaults[p.base] || 'left') : entry;
  // duration: met le CSS généré à l'échelle proportionnellement à la durée
  // par défaut de la base (facteur appliqué à CHAQUE jeton temporel, cf. µ._mjs_vtScaleCss).
  if (p.durationMs && µ._mjs_vtDefaultMs[p.base]) {
    factor = p.durationMs / µ._mjs_vtDefaultMs[p.base];
    css = µ._mjs_vtScaleCss(css, factor);
  }
  if (!µ._csp && !sheet) {
    sheet = document.createElement('style');
    sheet.id = 'mjs-vt-presets';
    document.head.appendChild(sheet);
  }
  setCss(css);
};

// ──────────────────────────────────────────────────────────────────────────
// COUCHE DE LÉVITATION (#mjs-vt-hoist) — Chrome IGNORE tout view-transition-name
// posé DANS un shadow tree (ouvert ou fermé) pour une transition document : seul
// le DOM lumière crée son ::view-transition-group(nom). Or TOUT vit en shadow en
// MJS. Parade (même esprit que les overlays d'une implémentation interne antérieure) : au moment de
// CHAQUE capture (départ puis arrivée), les éléments nommés sont doublés par un
// FANTÔME visuellement identique dans une couche fixe au-dessus du body (DOM
// lumière → capturé), l'original étant masqué (visibility:hidden) pour ne pas
// laisser ses pixels dans le cliché racine (sinon image double pendant le morph).
// Cycle de vie des fantômes : posés juste avant startViewTransition (même tâche
// synchrone, aucun rendu entre les deux), rebâtis dans le callback de mise à
// jour (côté arrivée), détruits à `finished` — JAMAIS à `ready` : côté ANCIEN le
// navigateur fige un instantané, mais le pseudo ::view-transition-new(nom) est
// une image VIVANTE de l'élément — retirer le fantôme dès `ready` amputait la
// moitié ENTRANTE du morph pendant toute l'animation. Pendant celle-ci, la
// couche reste invisible (l'overlay ::view-transition peint au-dessus de tout le
// document, top layer) : seuls ses pixels relayés par new(nom) apparaissent.

// Collecte les éléments porteurs d'un view-transition-name INLINE (la seule
// forme que produit le raccourci compilé @viewTransition="nom" → @style.view-
// transition-name), à travers les shadows IMBRIQUÉS via la propriété _shadow
// posée par le framework sur chaque instance. Renvoie [{el, name}].
µ._mjs_vtCollectNamed = function(root, out) {
  var el, sh, list, n;
  out = out || [];
  root = root || (typeof document !== 'undefined' ? document.body : null);
  if (!root || typeof root.querySelectorAll !== 'function') { return out; }
  list = root.querySelectorAll('[style*="view-transition-name"]');
  for (el of list) {
    n = el.style ? el.style.viewTransitionName : '';
    if (n && n !== 'none') { out.push({ el: el, name: n }); }
  }
  for (el of root.querySelectorAll('*')) {
    sh = el._shadow;
    if (sh) { µ._mjs_vtCollectNamed(sh, out); }
  }
  return out;
};

// Réplique visuelle d'un élément pour la couche de lévitation : clone profond +
// styles CALCULÉS recopiés en inline paire à paire (les règles du <style> shadow
// du composant ne s'appliquent plus dans le body), positionné en fixe sur le
// rectangle exact de l'original. Fidèle pour du contenu concret (images, blocs,
// texte) ; un SOUS-COMPOSANT imbriqué dans l'élément nommé n'est PAS répliqué
// (son shadow fermé ne se clone pas) — limite documentée (docs/17-router.md).
µ._mjs_vtGhost = function(el, rect) {
  var g = el.cloneNode(true);
  var copy = function(src, dst) {
    var cs, i, p, a, b;
    cs = getComputedStyle(src);
    for (i = 0; i < cs.length; i++) { p = cs[i]; dst.style.setProperty(p, cs.getPropertyValue(p), cs.getPropertyPriority(p)); }
    a = src.children;
    b = dst.children;
    for (i = 0; i < a.length && i < b.length; i++) { copy(a[i], b[i]); }
  };
  copy(el, g);
  g.style.position = 'fixed';
  g.style.top = rect.top + 'px';
  g.style.left = rect.left + 'px';
  g.style.width = rect.width + 'px';
  g.style.height = rect.height + 'px';
  g.style.margin = '0';
  g.style.visibility = 'visible';
  return g;
};

// État de lévitation COURANT — la couche est MONO-VOL par construction : un
// seul state vivant à la fois. Tout _mjs_vtHoistStart désarme d'abord SYNCHRONEMENT
// le précédent (restauration + couche retirée), et chaque continuation
// asynchrone d'un state (Settled, End sur finished) se re-vérifie contre CE
// pointeur : un state périmé est un no-op TOTAL. Sans ça, deux transitions
// enchaînées laissaient coexister deux couches → deux fantômes du même nom →
// « duplicate view-transition-name » → transition sautée par le navigateur.
µ._mjs_vtHoistState = null;

// Pose la couche + les fantômes du côté DÉPART — à appeler juste avant
// document.startViewTransition, dans la MÊME tâche. Fantômes d'abord, masquage
// des originaux APRÈS (un échec de clonage laisse alors la page intacte :
// µ.warn + repli sans lévitation, la transition racine joue quand même).
// Renvoie l'état pour _mjs_vtHoistSwapSettled/_mjs_vtHoistEnd, ou null si rien à lever.
µ._mjs_vtHoistStart = function() {
  var named, layer, item, prev, state;
  if (µ._isServer || typeof document === 'undefined') { return null; }
  if (µ._mjs_vtHoistState) { µ._mjs_vtHoistEnd(µ._mjs_vtHoistState); }
  named = µ._mjs_vtCollectNamed();
  if (!named.length) { return null; }
  // ceinture : purge toute couche orpheline restée dans le body (boucle — il
  // peut y en avoir plusieurs si un code externe en a semé)
  while ((prev = document.getElementById('mjs-vt-hoist'))) { prev.remove(); }
  layer = document.createElement('div');
  layer.id = 'mjs-vt-hoist';
  layer.style.cssText = 'position:fixed;inset:0;margin:0;padding:0;border:0;pointer-events:none;z-index:2147483647';
  try {
    for (item of named) {
      item.ghost = µ._mjs_vtGhost(item.el, item.el.getBoundingClientRect());
      item.ghost.style.viewTransitionName = item.name;
      layer.appendChild(item.ghost);
    }
  }
  catch (e) {
    µ.warn(`[ModularJS] couche de lévitation VT abandonnée : ${e.message}`);
    return null;
  }
  document.body.appendChild(layer);
  state = { layer: layer, hidden: named };
  // jeton de propriétaire : une transition N-1 sautée (finished rejeté) ne doit
  // ni ré-afficher un original que la transition N vient de re-masquer (sinon
  // DOUBLE nom à la capture old → transition sautée par le navigateur), ni
  // empoisonner la visibilité d'origine ('hidden' relu comme état initial)
  for (item of named) {
    if (item.el._mjs_vtPrev === undefined) { item.el._mjs_vtPrev = item.el.style.visibility; }
    item.el.style.visibility = 'hidden';
    item.el._mjs_vtOwner = state;
  }
  µ._mjs_vtHoistState = state;
  return state;
};

// Restaure la visibilité d'un lot d'originaux, MAIS seulement ceux dont CE state
// est encore propriétaire — un state périmé (transition sautée par une plus
// récente) ne touche pas aux éléments repris par la suivante.
µ._mjs_vtHoistRestore = function(items, state) {
  var item;
  for (item of items) {
    if (item.el._mjs_vtOwner !== state) { continue; }
    item.el.style.visibility = item.el._mjs_vtPrev || '';
    delete item.el._mjs_vtPrev;
    delete item.el._mjs_vtOwner;
  }
};

// Pose les fantômes d'un lot d'éléments nommés dans la couche du state et masque
// les originaux (jeton de propriétaire, cf. _mjs_vtHoistStart). Cœur partagé entre
// _mjs_vtHoistSwap (synchrone) et _mjs_vtHoistSwapSettled (attente d'arrivée).
µ._mjs_vtHoistBuild = function(state, named) {
  var item;
  try {
    for (item of named) {
      item.ghost = µ._mjs_vtGhost(item.el, item.el.getBoundingClientRect());
      item.ghost.style.viewTransitionName = item.name;
      state.layer.appendChild(item.ghost);
    }
  }
  catch (e) {
    µ.warn(`[ModularJS] couche de lévitation VT (arrivée) abandonnée : ${e.message}`);
    state.layer.textContent = '';
    return;
  }
  for (item of named) {
    if (item.el._mjs_vtPrev === undefined) { item.el._mjs_vtPrev = item.el.style.visibility; }
    item.el.style.visibility = 'hidden';
    item.el._mjs_vtOwner = state;
  }
  state.hidden = named;
};

// Rebâtit les fantômes pour le côté ARRIVÉE — à appeler DANS le callback de mise
// à jour de startViewTransition, APRÈS le swap DOM. Restaure D'ABORD la
// visibilité des originaux du départ — une page évincée vers le cache
// d'instances garderait sinon un visibility:hidden à vie à sa restauration.
µ._mjs_vtHoistSwap = function(state) {
  if (!state || µ._mjs_vtHoistState !== state) { return; }
  µ._mjs_vtHoistRestore(state.hidden, state);
  state.layer.textContent = '';
  state.hidden = [];
  µ._mjs_vtHoistBuild(state, µ._mjs_vtCollectNamed());
};

// Variante ASYNCHRONE de _mjs_vtHoistSwap, branchée par le routeur et l'UJS : les
// styles STATIQUES du composant fraîchement injecté (dont le view-transition-name
// inline posé par le raccourci @viewTransition="nom") atterrissent un BATTEMENT
// après l'appendChild — collecter trop tôt manquait les nommés d'arrivée (fantôme
// jamais créé côté new au premier montage, voire l'original du DÉPART re-fantômé
// à sa place → risque de nom en double à la capture). Le callback de
// startViewTransition peut rendre une promesse : la capture d'arrivée attend sa
// résolution, rendu SUSPENDU pendant ce temps (aucun flash). La restauration du
// départ reste SYNCHRONE (avant tout await) : même si la transition meurt
// pendant l'attente, aucune page du cache ne reste masquée. Borné à 3 battements
// (~2 ms) — au-delà, on fait avec ce qui est là.
µ._mjs_vtHoistSwapSettled = async function(state) {
  var named, tries;
  if (!state || µ._mjs_vtHoistState !== state) { return; }
  µ._mjs_vtHoistRestore(state.hidden, state);
  state.layer.textContent = '';
  state.hidden = [];
  named = µ._mjs_vtCollectNamed();
  for (tries = 0; tries < 3 && !named.length; tries++) {
    await new Promise(function(r) { setTimeout(r, 0); });
    // une transition plus récente a pu prendre la main PENDANT l'attente : ce
    // state est alors périmé — ne surtout pas re-fantômer par-dessus la sienne
    if (µ._mjs_vtHoistState !== state) { return; }
    named = µ._mjs_vtCollectNamed();
  }
  if (µ._mjs_vtHoistState !== state) { return; }
  µ._mjs_vtHoistBuild(state, named);
};

// Démonte la couche et rend leur visibilité aux originaux de l'arrivée — branché
// sur transition.FINISHED, résolue OU rejetée (une transition sautée nettoie
// pareil ; et jamais `ready`, cf. l'en-tête du bloc : new(nom) est une image
// vivante du fantôme). Le `then` tient dans la microtâche post-finished, avant
// tout repaint : aucun flash possible.
µ._mjs_vtHoistEnd = function(state) {
  if (!state || µ._mjs_vtHoistState !== state) { return; }
  µ._mjs_vtHoistRestore(state.hidden, state);
  state.layer.remove();
  µ._mjs_vtHoistState = null;
};
