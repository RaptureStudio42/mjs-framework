// animations/crossfade.coffee

// Port direct de Svelte crossfade. La pair d'animations couplées s'enregistre
// dans µ.anim.* sous la forme :
//   µ.anim.crossfade('todos')
//   →  µ.anim.todosSend     (à utiliser sur @out)
//      µ.anim.todosReceive  (à utiliser sur @in)

// Différence avec Svelte (qui utilise destructuring `[send, receive] = ...`) :
// notre architecture par-nom rend les deux sides accessibles globalement.

// Aligné 1:1 sur Svelte pour la transformation : translate dx,dy + scale dw,dh
// (matrix), opacity, et capture du transform de base + opacity naturelle.

// Usage côté composant :
//   µ.anim.crossfade('todos', duration: 600)
//   <label @in.todosReceive={key: item.id} @out.todosSend={key: item.id}>...
(function(name, defaults = {}) {
  var buildAnim, defaultDuration, makeTransition, sampleAndRun, toReceive, toSend;
  toReceive = new Map();
  toSend = new Map();
  defaultDuration = function(d) {
    return Math.sqrt(d) * 30;
  };
  buildAnim = function(fromNode, node, params, isIntro) {
    var baseTransform, d, delay, dh, duration, dw, dx, dy, easing, finalDuration, from, i, keyframes, p, ref, ref1, ref2, ref3, ref4, ref5, steps, style, sx, sy, t, targetOpacity, to, u;
    delay = (ref = (ref1 = params.delay) != null ? ref1 : defaults.delay) != null ? ref : 0;
    duration = (ref2 = (ref3 = params.duration) != null ? ref3 : defaults.duration) != null ? ref2 : defaultDuration;
    easing = µ.easing.resolve((ref4 = (ref5 = params.easing) != null ? ref5 : defaults.easing) != null ? ref4 : µ.easing.cubicOut);
    from = fromNode.getBoundingClientRect();
    to = node.getBoundingClientRect();
    dx = from.left - to.left;
    dy = from.top - to.top;
    dw = from.width / Math.max(to.width, 1);
    dh = from.height / Math.max(to.height, 1);
    d = Math.sqrt(dx * dx + dy * dy);
    finalDuration = typeof duration === 'function' ? duration(d) : duration;
    style = window.getComputedStyle(node);
    baseTransform = style.transform === 'none' ? '' : style.transform;
    targetOpacity = +style.opacity;
    steps = 60;
    keyframes = (function() {
      var j, ref6, results;
      results = [];
      for (i = j = 0, ref6 = steps; (0 <= ref6 ? j <= ref6 : j >= ref6); i = 0 <= ref6 ? ++j : --j) {
        p = i / steps;
        // Intro (receive) : t = easing(p) → opacity 0→1, translate counterpart→self.
        // Outro (send)    : t = 1 - easing(p) → opacity 1→0, translate self→counterpart.
        // On flippe la VALEUR (1-easing), pas le TEMPS (easing(1-p)) : ainsi les deux
        // côtés partagent le même easing dans le temps → positions superposées à
        // chaque frame ET somme des opacités = 1 (vrai crossfade, un seul élément
        // visible). `easing(1-p)` ou `direction:reverse` désynchronisent (easing
        // asymétrique) et on voit DEUX copies animées.
        t = isIntro ? easing(p) : 1 - easing(p);
        u = 1 - t;
        sx = t + (1 - t) * dw;
        sy = t + (1 - t) * dh;
        results.push({
          opacity: t * targetOpacity,
          transformOrigin: 'top left',
          transform: `${baseTransform} translate(${u * dx}px, ${u * dy}px) scale(${sx}, ${sy})`.trim(),
          offset: p
        });
      }
      return results;
    })();
    return new Promise(function(resolve) {
      var anim;
      anim = node.animate(keyframes, {
        duration: finalDuration,
        delay,
        fill: 'forwards'
      });
      // cancel() après finished (même hygiène que µ._mjs_runTransition) : le
      // `fill: forwards` gardait l'Animation ACTIVE indéfiniment — styles
      // figés par le fill + objets Animation accumulés dans la timeline à
      // chaque re-déclenchement sur un nœud réutilisé (liste keyed).
      return anim.finished.then(function() {
        try { anim.cancel(); } catch (_e) {}
        return resolve();
      }, function() {
        try { anim.cancel(); } catch (_e) {}
        return resolve();
      });
    });
  };
  makeTransition = function(items, counterparts, isIntro) {
    return function(params = {}) {
      var handler, key, out, sideKey;
      key = params.key;
      sideKey = isIntro ? 'intro' : 'outro';
      handler = function(node) {
        items.set(key, node);
        // Appariement send↔receive : on attend 2 rAF, PAS un seul microtask.
        // La liste SOURCE (qui perd l'item → @out/send) et la liste CIBLE (qui
        // le gagne → @in/receive) sont deux blocs {for} distincts qui se rendent
        // dans des ticks réactifs SÉPARÉS. Avec un seul `Promise.resolve().then`,
        // le premier côté enregistré voyait `counterparts` encore vide et tombait
        // sur le fallback (rétrécissement sur place) ; les deux côtés tombaient
        // alors en fallback et l'item ne « volait » jamais d'une liste à l'autre.
        // Deux rAF garantissent que les DEUX blocs ont fini de se rendre (tous les
        // effets réactifs microtask sont vidés) avant l'appariement.
        return new Promise(function(resolve, reject) {
          var __defer = function(cb) { return requestAnimationFrame(function() { return requestAnimationFrame(cb); }); };
          return __defer(function() {
            var cfg, other;
            if (counterparts.has(key)) {
              other = counterparts.get(key);
              counterparts.delete(key);
              return buildAnim(other, node, params, isIntro).then(resolve, reject);
            } else {
              items.delete(key);
              if (defaults.fallback) {
                cfg = defaults.fallback(node, params, isIntro);
                if (cfg != null ? cfg.css : void 0) {
                  // fallback en mode css(t,u) : sample
                  return sampleAndRun(node, cfg, isIntro).then(resolve, reject);
                } else {
                  return resolve();
                }
              } else {
                return resolve();
              }
            }
          });
        });
      };
      out = {};
      out[sideKey] = handler;
      return out;
    };
  };
  sampleAndRun = function(node, cfg, isIntro) {
    var duration, easing, frame, i, keyframes, p, ref, ref1, steps, t;
    duration = (ref = cfg.duration) != null ? ref : 400;
    easing = µ.easing.resolve(cfg.easing);
    steps = 60;
    keyframes = (function() {
      var j, ref1, results;
      results = [];
      for (i = j = 0, ref1 = steps; (0 <= ref1 ? j <= ref1 : j >= ref1); i = 0 <= ref1 ? ++j : --j) {
        p = i / steps;
        t = isIntro ? easing(p) : easing(1 - p);
        frame = cfg.css(t, 1 - t);
        frame.offset = p;
        results.push(frame);
      }
      return results;
    })();
    var anim = node.animate(keyframes, {
      duration,
      delay: (ref1 = cfg.delay) != null ? ref1 : 0,
      fill: 'forwards'
    });
    // Même hygiène que buildAnim : libérer le fill une fois l'animation finie.
    // contrairement à `buildAnim`
    // au-dessus (`.then(onFulfilled, onRejected)`), cette Promise n'avait
    // QU'UN callback de succès : si `anim.finished` REJETTE (animation
    // annulée — un node retiré du DOM, ou une autre transition qui la
    // supplante), la rejection se PROPAGE sans être rattrapée jusqu'à
    // l'appelant (ligne ~117 : `sampleAndRun(...).then(resolve, reject)` →
    // `reject` de la Promise du handler `@in`/`@out`). Si ce handler est
    // dans le tableau `transitions` d'un groupe d'outro
    // (`_mjs_destroyNodeAndChildren`, `await Promise.all(transitions)`), UNE
    // SEULE transition annulée fait REJETER TOUT LE GROUPE → le reste de la
    // séquence destroy (marquage `_mjs_dead`, callbacks `outroend`,
    // `node.remove()`) n'est JAMAIS exécuté → node(s) zombie bloqué(s) en
    // `_mjs_dying` À VIE, jamais retirés du DOM. Fix : même contrat que
    // `buildAnim`/`µ._mjs_runTransition` (mode css) — une annulation RÉSOUT
    // gracieusement (pas de re-throw), après avoir quand même libéré le fill.
    return anim.finished.then(function(r) {
      try { anim.cancel(); } catch (_e) {}
      return r;
    }, function() {
      try { anim.cancel(); } catch (_e) {}
    });
  };
  µ.anim[`${name}Send`] = makeTransition(toSend, toReceive, false);
  µ.anim[`${name}Receive`] = makeTransition(toReceive, toSend, true);
});
