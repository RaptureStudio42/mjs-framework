// mjs_body — <@body>/<@html> : liaisons class/style globales (µ._glCl / µ._glSt).
// Le transpiler émet, pour chaque liaison class/style posée sur <@body>/<@html>,
// un appel µ._glCl (classe) ou µ._glSt (style/custom property) sur l'élément
// PARTAGÉ (document.body / document.documentElement). Plusieurs composants
// peuvent poser des liaisons sur ce MÊME élément global : on ne doit jamais
// s'écraser mutuellement (cf. docs/15-elements-speciaux.md). DÉTACHÉ du cœur :
// embarqué seulement si une source du projet écrit `<@body`/`<@html` (scan textuel, cf.
// bundler/index.ts) — les liaisons dynamiques passent par un µeffect, forcé par le même signal.

// µ._glCl — bascule REFCOMPTÉE d'une classe sur un élément global partagé.
// Sémantique : deux composants posant la MÊME classe → elle reste tant qu'UN
// des deux la veut encore ; des classes DIFFÉRENTES s'ADDITIONNENT (rien n'est
// jamais perdu). Idempotent : rejouer la MÊME contribution (µeffect qui se
// redéclenche, hook awake rejoué) est un no-op immédiat — nécessaire pour
// absorber les répétitions sans fausser le compteur partagé.
µ._glCl = function(component, el, cls, on) {
  var contrib, cur, counts, n, want;
  want = !!on;
  contrib = component._mjs_mjsGlCl || (component._mjs_mjsGlCl = new Map());
  cur = contrib.get(el);
  if (!cur) { cur = new Map(); contrib.set(el, cur); }
  if (cur.get(cls) === want) return; // déjà dans cet état pour CE composant : no-op
  cur.set(cls, want);
  counts = el._mjs_mjsGlClCnt || (el._mjs_mjsGlClCnt = new Map());
  n = counts.get(cls) || 0;
  n = want ? n + 1 : Math.max(0, n - 1);
  counts.set(cls, n);
  if (n > 0) el.classList.add(cls); else el.classList.remove(cls);
};

// µ._glSt — style/custom property sur un élément global. PAS de refcount ici
// (à la différence de _glCl) : dernier-écrivain-gagnant par propriété — deux
// composants qui pilotent la MÊME propriété se disputent la dernière valeur
// écrite, exactement comme deux µeffects qui écriraient la même variable.
// `value == null` (le teardown passe `null`) → on retire la propriété.
µ._glSt = function(component, el, prop, value) {
  if (value == null) el.style.removeProperty(prop); else el.style.setProperty(prop, String(value));
};
