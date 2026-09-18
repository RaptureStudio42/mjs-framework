// mjs_router.coffee
µ.Router = {
  // Cache de vues PAR INSTANCE (WeakMap composant → Map clé → élément) :
  // l'ancienne Map globale keyée par TAG faisait que deux instances
  // simultanées du même composant se VOLAIENT l'élément caché (appendChild
  // = déplacement), et retenait les éléments à vie. La WeakMap libère le
  // cache à la mort du composant hôte.
  cache: new WeakMap(),
  _mjs_awareComponents: new Set(),
  // Compteur de génération anti-ré-entrance de `navigate()` (cf. son propre
  // commentaire) — bumpé à CHAQUE appel, pas seulement les racines.
  _mjs_navGen: 0,
  // PERF — mémo du tri des motifs de
  // route PAR OBJET `routeMap` (les motifs sont STATIQUES après compilation).
  // WeakMap : un `comp.routes` remplacé (nouvel objet) régénère naturellement
  // l'entrée ; aucune rétention au-delà de la vie du composant.
  _mjs_routeSortCache: new WeakMap(),
  // sous `µ._csp` : feuille constructible unique, adoptée une seule fois sur
  // `document` (le CSS du panneau est statique, pas besoin d'un <style> par appel).
  _mjs_routeErrorSheetAdopted: false,
  register: function(comp) {
    µ.log(`🚦 [Router] Enregistrement de : <${comp.tagName.toLowerCase()}>`);
    // Parité <routes>/@routes — `validateRoutePath` (transpiler/sections.ts)
    // refuse un `*` catch-all qui n'est pas en dernière position, mais SEULEMENT pour le bloc
    // <routes> : la table `@routes` calculée en script n'est jamais validée, et `_matchSegs`
    // absorbe tout le reste du chemin dès le `*` quelle que soit sa position — les segments
    // après lui ne sont plus jamais lus, en silence. Vérifié ICI, au runtime, à l'enregistrement
    // (la table est déjà résolue) — même voie que le nom de variant de style inconnu
    // (mjs_element.ts::_mjs_applyLayout) : `_mjs_catchError` remonte à la boundary `<@failed>` la plus
    // proche ou affiche le panneau fatal ; `mjs-light` (pas de shadow) : log seul.
    var wildcardErr = this._mjs_findMidRouteWildcard(comp);
    if (wildcardErr) {
      if (comp._mjs_isLight || typeof comp._mjs_catchError !== 'function') { µ.error(wildcardErr.message); }
      else if (!comp._mjs_has_crashed) { comp._mjs_catchError(wildcardErr); }
      return;
    }
    this._mjs_awareComponents.add(comp);
    return this.initComponent(comp);
  },
  unregister: function(comp) {
    return this._mjs_awareComponents.delete(comp);
  },
  // cherche un `*` catch-all qui N'EST PAS le dernier segment dans les routes du composant
  // retourne une Error prête à afficher, ou `null` si tout va bien.
  _mjs_findMidRouteWildcard: function(comp) {
    var targetId, routeMap, path, segs, i;
    if (!comp.routes) { return null; }
    for (targetId in comp.routes) {
      routeMap = comp.routes[targetId];
      for (path in routeMap) {
        segs = path.split('/').filter(Boolean);
        for (i = 0; i < segs.length; i++) {
          if (segs[i] === '*' && i !== segs.length - 1) {
            return new Error(`[Router] <${comp.tagName.toLowerCase()}> : route '${path}' invalide — le '*' catch-all doit être en DERNIÈRE position (segment '${segs[i + 1]}' et la suite ne seraient jamais atteints).`);
          }
        }
      }
    }
    return null;
  },
  initComponent: function(comp) {
    var matchPath, gen;
    // Nettoie un éventuel slash final de l'URL de départ (`#/about/` tapé à la
    // main ou lien codé en dur) dès le premier composant routé qui monte.
    this._mjs_canonicalizeUrl();
    // On se base sur l'URL complète du navigateur pour extraire le hash
    matchPath = this._mjs_getMatchPath(window.location.href);
    µ.log(`🚦 [Router] Init <${comp.tagName.toLowerCase()}> avec le Hash Path : '${matchPath}'`);
    // garde de RÉ-ENTRANCE au
    // MONTAGE, jumelle de celle de `navigate()` : si le `@urlChange` de CE
    // composant redirige (`to('/login')`, garde d'auth canonique), le `navigate`
    // imbriqué traite DÉJÀ tous les `_mjs_awareComponents` (dont celui-ci, inscrit
    // par `register` juste avant cet appel) avec le VRAI chemin final. Sans
    // garde, `initComponent` reprend ensuite avec son `matchPath` PÉRIMÉ :
    // `_mjs_updateUrlStore` ferait retomber `µ.url.path` sur l'ancienne route et
    // `_injectViews` ré-injecterait la vue interdite PAR-DESSUS celle posée par
    // le redirect (la page que la garde voulait précisément interdire).
    gen = this._mjs_navGen;
    if (typeof comp._mjs_hooks?.urlChange === "function") {
      comp._mjs_hooks.urlChange.call(comp, matchPath, this._mjs_extractParams(comp, matchPath));
    }
    if (gen !== this._mjs_navGen) { return; }
    // Un composant routé vient de monter : rafraîchit `µ.url` (ses params de
    // route deviennent disponibles maintenant que ses @routes sont enregistrées).
    this._mjs_updateUrlStore(matchPath);
    // Contrôle « aucune route » DIFFÉRÉ (cf. `_mjs_scheduleNoMatchCheck`) : les
    // composants routés montent l'un après l'autre au démarrage, l'état n'est
    // complet qu'à la frame suivante.
    this._mjs_scheduleNoMatchCheck(matchPath);
    return this._mjs_injectViewsForComponent(comp, matchPath);
  },
  // Sucre de navigation programmatique : `µ.Router.to '/success'`.
  // Le routeur MJS travaille TOUJOURS sur la partie hash de l'URL → l'API
  // publique ne demande QUE la route (`/success`), jamais le `#` (qui est
  // implicite puisqu'on parle du routeur MJS). On le préfixe ici avant de
  // déléguer à `navigate` (qui reste l'implémentation bas-niveau, aussi
  // appelée par mjs_ujs avec des URLs complètes lors des back/forward).
  to: function(route, pushHistory = true) {
    var dest, replace = false;
    // DURCISSEMENT — mode `replace` : une
    // garde `@urlChange` qui redirige (`to('/login')`) empilait `/login` APRÈS
    // `/admin` → chaque « Précédent » repassait par `/admin`, re-déclenchait la
    // garde, re-poussait `/login` : piège sans issue. `to(route, {replace:true})`
    // remplace l'entrée courante au lieu d'en ajouter une. Rétrocompat :
    // `to(route)` (push), `to(route, false)` (ni push ni replace).
    if (pushHistory && typeof pushHistory === 'object') {
      replace = !!pushHistory.replace;
      pushHistory = pushHistory.push !== false;
    }
    if (typeof route !== 'string' || route.length === 0) {
      dest = '#/';
    } else if (route.charAt(0) === '#') {
      dest = route;                 // déjà un hash complet
    } else if (route.charAt(0) === '/') {
      dest = '#' + route;           // '/success' -> '#/success'
    } else {
      dest = '#/' + route;          // 'success'  -> '#/success'
    }
    return this.navigate(dest, pushHistory, replace);
  },
  // Reflète l'URL courante dans l'objet réactif dédié `µ.url` (namespace
  // FRAMEWORK, PAS le store applicatif `$$`/µ.store — on ne pollue pas l'espace
  // de noms du dev). Lisible partout sans import : `µ.url.path`, `µ.url.params.id`,
  // `µ.url.query.tri`, `µ.url.hash`, `µ.url.href`. `µ.url` est un `µ.state` à part
  // entière → lire un champ pendant le rendu enregistre le composant comme
  // dépendant (universal deps), et l'écriture par champ ici le re-rend. Appelé
  // par `navigate`, `initComponent` et au boot.
  _mjs_updateUrlStore: function(matchPath) {
    var comp, hashRaw, loc, params, path, qi, qs, query, ref, usp;
    if (typeof window === 'undefined' || typeof µ.state !== 'function') { return; }
    if (!µ.url) { µ.url = µ.state({}); }
    loc = window.location;
    path = matchPath != null ? matchPath : this._mjs_getMatchPath(loc.href);
    // Query : `_mjs_getMatchPath` a déjà strippé le `?…` du path → on la relit sur le
    // hash BRUT (`#/x?a=1` → `a=1`), avec repli sur `loc.search` (`/?a=1#/x`).
    query = {};
    hashRaw = loc.hash || '';
    qi = hashRaw.indexOf('?');
    qs = qi !== -1 ? hashRaw.slice(qi + 1) : loc.search.slice(1);
    try {
      if (qs) {
        usp = new URLSearchParams(qs);
        usp.forEach(function(v, k) { query[k] = v; });
      }
    } catch (e) {}
    // Params de route : union de toutes les vues routées qui matchent l'URL.
    params = {};
    try {
      ref = this._mjs_awareComponents;
      for (comp of ref) {
        this._mjs_mergeParams(params, this._mjs_extractParams(comp, path));
      }
    } catch (e2) {}
    // `µ.url.path` exposait le
    // chemin ENCODÉ (`/caf%C3%A9`) alors que le matching interne décode déjà
    // (`:param` et littéraux) : un `µ.url.path === '/café'` applicatif échouait
    // en silence. Décodage SEGMENT PAR SEGMENT (le `path` ENCODÉ, lui, reste
    // celui passé à `_mjs_extractParams` plus haut → pas de double-décodage dans le
    // matching). Tolérant : un `%` mal formé ressort brut.
    var pathDecoded = path;
    try {
      pathDecoded = path.split('/').map(function(s) {
        try { return decodeURIComponent(s); } catch (e) { return s; }
      }).join('/');
    } catch (e3) {}
    // Écriture PAR CHAMP : chaque clé notifie ses propres lecteurs. `href`/`path`/
    // `hash` (chaînes) sont court-circuités par `µ.state` si identiques.
    µ.url.href = loc.href;
    µ.url.path = pathDecoded;
    // PERF — `params`/`query` sont des
    // objets NEUFS à chaque nav : réassigner notifiait TOUS leurs lecteurs
    // (`&id`, layouts) à CHAQUE navigation, même quand rien n'avait changé (hash
    // pure d'une autre zone, rafales de montage au boot). Comparaison
    // superficielle avant écriture : mêmes clés + valeurs `===` ⇒ on garde
    // l'objet en place (identité inchangée, aucun lecteur réveillé).
    if (!this._mjs_shallowEq(µ.url.params, params)) { µ.url.params = params; }
    if (!this._mjs_shallowEq(µ.url.query, query)) { µ.url.query = query; }
    µ.url.hash = loc.hash;
  },
  // Égalité superficielle (mêmes clés, mêmes valeurs `===`) — cf. 07-23. Évite
  // `JSON.stringify` (coût + ordre des clés) : une simple boucle for.
  _mjs_shallowEq: function(a, b) {
    if (a === b) { return true; }
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') { return false; }
    var ka = Object.keys(a), kb = Object.keys(b), i, k;
    if (ka.length !== kb.length) { return false; }
    for (i = 0; i < ka.length; i++) { k = ka[i]; if (a[k] !== b[k]) { return false; } }
    return true;
  },
  _mjs_getMatchPath: function(destination) {
    var hashIdx, hashPart, matchPath;
    // On extrait UNIQUEMENT ce qui se trouve après le PREMIER `#` —
    // `split('#')[1]` tronquait au 2e `#` (`'/p#/a#b'` → '/a' au lieu de '/a#b').
    hashIdx = destination.indexOf('#');
    hashPart = hashIdx === -1 ? null : destination.slice(hashIdx + 1);
    // Si aucun hash n'est présent, le composant est considéré à sa racine '/'
    matchPath = hashPart ? hashPart : '/';
    // Retire la query collée au hash (`#/settings?tab=x` → `/settings`) : sinon
    // `_mjs_matchRoute` compare `settings?tab=x` et une route statique ne matche plus.
    // (La query est lue à part par `_mjs_updateUrlStore`, sur `loc.hash`/`loc.search`.)
    matchPath = matchPath.split('?')[0];
    if (!matchPath.startsWith('/')) {
      matchPath = '/' + matchPath;
    }
    if (matchPath.length > 1) {
      matchPath = matchPath.replace(/\/$/, '');
    }
    return matchPath;
  },
  // Canonicalise la PARTIE ROUTE d'un hash en retirant le(s) '/' final(s)
  // superflu(s) : `#/about/` → `#/about`, `#/a/?tri=x` → `#/a?tri=x`. La racine
  // `#/` est préservée et la query après `?` est conservée. Idempotent (une
  // string déjà canonique ressort telle quelle) → aucune boucle de redirection.
  // NB : `_mjs_getMatchPath` normalisait DÉJÀ le slash pour le MATCH (pas de 404),
  // mais laissait l'URL VISIBLE sale ; cette fonction nettoie la barre d'adresse.
  _mjs_canonHash: function(hash) {
    var body, pathPart, qi, queryPart;
    if (!hash || hash.charAt(0) !== '#') { return hash; }
    body = hash.slice(1);
    qi = body.indexOf('?');
    pathPart = qi === -1 ? body : body.slice(0, qi);
    queryPart = qi === -1 ? '' : body.slice(qi);
    if (pathPart.length > 1 && pathPart.charAt(pathPart.length - 1) === '/') {
      pathPart = pathPart.replace(/\/+$/, '');
      if (pathPart === '') { pathPart = '/'; }
    }
    return '#' + pathPart + queryPart;
  },
  // Réécrit l'URL COURANTE vers sa forme canonique (slash final retiré) SANS
  // créer d'entrée d'historique (`replaceState`) : la redirection est invisible
  // pour le bouton Précédent. `replaceState` n'émet PAS `hashchange` → pas de
  // ré-entrée. Ne touche qu'aux hash de ROUTE (`#/…`) : une ancre `#section`
  // garde son slash. Appelée au boot (initComponent) et sur hashchange.
  _mjs_canonicalizeUrl: function() {
    var canon, hash, loc;
    if (typeof window === 'undefined' || !window.history) { return; }
    loc = window.location;
    hash = loc.hash || '';
    if (hash.slice(0, 2) !== '#/') { return; }
    canon = this._mjs_canonHash(hash);
    if (canon === hash) { return; }
    try {
      window.history.replaceState(window.history.state, '', loc.pathname + loc.search + canon);
    } catch (e) {
      µ.warn(`[Router] canonicalisation du slash refusée pour '${hash}' :`, e);
    }
  },
  // Matche un chemin courant contre un motif de route pouvant contenir des
  // segments paramétrés `:param`. Match EXACT : tous les segments de la route ET
  // tous ceux de l'URL doivent être consommés — un segment d'URL en trop fait
  // ÉCHOUER la route (cf. `_matchSegs`). Un sous-arbre se déclare explicitement
  // avec `*` (`/admin/*`). Retourne {ok, params}.
  _mjs_matchRoute: function(matchPath, routePath) {
    var rp, mp;
    rp = routePath.split('/').filter(Boolean);
    mp = matchPath.split('/').filter(Boolean);
    if (rp.length === 0) {
      return { ok: mp.length === 0, params: {} };
    }
    return this._matchSegs(rp, 0, mp, 0, {});
  },
  // Correspondance récursive AVEC RETOUR ARRIÈRE (backtracking).
  //
  // nécessaire dès qu'un segment
  // optionnel `(:x)` façon Rails n'est PAS en toute fin de route
  // (`/a/(:x)/b`) : l'ancienne boucle linéaire, position par position,
  // associait le segment optionnel au premier segment d'URL venu SANS
  // jamais revenir sur ce choix si la suite échouait ensuite — `/a/(:x)/b`
  // contre `/a/b` consommait `b` comme valeur de `:x`, puis échouait sur le
  // littéral `b` manquant en fin de route, alors que `/a/b` DOIT matcher
  // (x = undefined, exactement comme un `:x` optionnel EN FIN de route).
  // Stratégie : à chaque segment optionnel, essaie d'abord PRÉSENT (glouton,
  // comme avant — couvre l'immense majorité des cas dès le 1er essai), puis
  // ABSENT si la suite échoue.
  _matchSegs: function(rp, ri, mp, mi, params) {
    var seg, opt, name, all, withVal, rTry, mSeg;
    if (ri >= rp.length) {
      // MATCH EXACT — la route est épuisée : elle ne
      // matche QUE si l'URL l'est aussi. Un segment d'URL en trop signifie que
      // l'adresse ne désigne PAS cette route ; l'absorber silencieusement
      // (comportement d'avant) masquait les fautes de frappe et rendait `&all`
      // inatteignable dans une table `{'/a': X, '/a/*': Y}` — `/a`, préfixe,
      // captait `/a/b` avant que `/a/*` ne soit essayé. Un sous-arbre (layout
      // imbriqué) se déclare désormais EXPLICITEMENT avec `*` : `'/admin/*'`.
      // Le retour `false` alimente aussi le retour arrière des segments
      // optionnels plus haut dans la pile (branche « absent »).
      return { ok: mi >= mp.length, params: params };
    }
    seg = rp[ri];
    // Segment OPTIONNEL façon Rails : `(:id)` (ou `(segment)`). Les parenthèses
    // le rendent facultatif → `/posts/(:id)` matche `/posts` ET `/posts/42`, sans
    // écrire deux routes. Absent → le param vaut `undefined`.
    opt = seg.charCodeAt(0) === 40 && seg.charCodeAt(seg.length - 1) === 41; // '(' … ')'
    if (opt) { seg = seg.slice(1, -1); }
    if (seg === '*') { // catch-all → capture tout le reste du path : `all` (&all) et `rest` (&rest)
      all = Object.assign({}, params);
      // segments décodés un à un
      // (comme `:param`) : `/files/a%2Fb` → `['a/b']`, cohérent avec la doc
      // « la valeur capturée est décodée ». Tolérant au `%` mal formé.
      // le joker pose DEUX clés : `all` le
      // TABLEAU des segments décodés (itérer, compter), `rest` ce même tableau
      // rejoint par `/` (reconstruire une URL — exactement ce que rendait `all`
      // avant cette décision). Un seul point de vérité : le tableau, `rest` en
      // découle.
      all.all = mp.slice(mi).map(function(s) {
        try { return decodeURIComponent(s); } catch (e) { return s; }
      });
      all.rest = all.all.join('/');
      return { ok: true, params: all };
    }
    if (opt) {
      if (mi < mp.length) {
        withVal = Object.assign({}, params);
        if (seg.charCodeAt(0) === 58) { // ':' → segment paramétré → capture
          name = seg.slice(1);
          try { withVal[name] = decodeURIComponent(mp[mi]); } catch (e) { withVal[name] = mp[mi]; }
          rTry = this._matchSegs(rp, ri + 1, mp, mi + 1, withVal);
          if (rTry.ok) { return rTry; }
        } else {
          // Littéral optionnel : décoder le segment URL avant comparaison
          // (parité avec le littéral NON optionnel) → `/(café)` matche
          // `/caf%C3%A9`.
          var litDec;
          try { litDec = decodeURIComponent(mp[mi]); } catch (e) { litDec = mp[mi]; }
          if (seg === litDec) {
            rTry = this._matchSegs(rp, ri + 1, mp, mi + 1, params);
            if (rTry.ok) { return rTry; }
          }
        }
      }
      // ABSENT : le param nommé (s'il y en a un) vaut explicitement undefined.
      withVal = Object.assign({}, params);
      if (seg.charCodeAt(0) === 58) { withVal[seg.slice(1)] = void 0; }
      return this._matchSegs(rp, ri + 1, mp, mi, withVal);
    }
    if (mi >= mp.length) {
      // Plus de segments dans l'URL alors que CE segment n'est pas optionnel.
      return { ok: false, params: params };
    }
    if (seg.charCodeAt(0) === 58) { // ':' → segment paramétré → capture
      name = seg.slice(1);
      withVal = Object.assign({}, params);
      try { withVal[name] = decodeURIComponent(mp[mi]); } catch (e) { withVal[name] = mp[mi]; }
      return this._matchSegs(rp, ri + 1, mp, mi + 1, withVal);
    }
    // un segment LITTÉRAL de route (ex.
    // `/café`) était comparé tel quel à `mp[mi]`, qui peut être ENCODÉ si
    // l'URL a été construite/tapée avec des caractères non-ASCII
    // (`/caf%C3%A9`) — le littéral (déjà décodé, écrit en clair dans le
    // code source) ne matchait alors jamais l'URL réelle, contrairement aux
    // segments `:param` déjà décodés depuis le tout premier commit de cette
    // fonction. Décodage tolérant (try/catch) : un `%` mal formé dans l'URL
    // ne doit pas faire planter le routeur, juste comparer la valeur brute
    // (échoue proprement au pire, comme avant ce fix).
    try { mSeg = decodeURIComponent(mp[mi]); } catch (e) { mSeg = mp[mi]; }
    if (seg !== mSeg) { return { ok: false, params: {} }; }
    return this._matchSegs(rp, ri + 1, mp, mi + 1, params);
  },
  // PERF — motifs triés par SPÉCIFICITÉ,
  // mémoïsés par `routeMap` : avant, chaque navigation refaisait
  // `Object.keys(map).sort(...)` (le comparateur re-splittant chaque motif via
  // `_mjs_staticSegs`) 3× par composant — O(R log R) splits × 3 × K composants au
  // boot. Ici : calculé UNE fois par table de routes.
  _mjs_sortedPaths: function(routeMap) {
    var cached = this._mjs_routeSortCache.get(routeMap);
    if (cached) { return cached; }
    var paths = Object.keys(routeMap).sort(function(a, b) {
      return µ.Router._mjs_staticSegs(b) - µ.Router._mjs_staticSegs(a) || µ.Router._mjs_wildSegs(a) - µ.Router._mjs_wildSegs(b) || b.length - a.length;
    });
    this._mjs_routeSortCache.set(routeMap, paths);
    return paths;
  },
  // Mesure de SPÉCIFICITÉ d'un motif : nombre de segments LITTÉRAUX (ni `:param`,
  // ni `*`, ni optionnel `(…)`). Sert au tri des routes — plus de littéraux = plus
  // spécifique (`/posts/new` l'emporte sur `/posts/(:id)`).
  _mjs_staticSegs: function(p) {
    return p.split('/').filter(function(s) {
      return s && s.charAt(0) !== ':' && s.charAt(0) !== '(' && s !== '*';
    }).length;
  },
  // Départage wildcard : à spécificité statique ÉGALE, un motif
  // SANS catch-all passe AVANT un motif qui en contient. Sans ça, la racine `/`
  // (0 littéral, longueur 1) perdait le tie-break de LONGUEUR face à `/*`
  // (0 littéral, longueur 2) : le catch-all matchant tout, la route racine était
  // INATTEIGNABLE dès qu'un `/*` existait dans la même table (`'/'` →
  // not-found systématique, vu sur app cliente). Compter les `*` et trier croissant
  // rétablit `/` avant `/*` sans toucher aux autres égalités (0 partout → même
  // ordre qu'avant). NB : depuis le passage au match EXACT, une table
  // `{'/a': X, '/a/*': Y}` ne se dispute plus `/a/b` — `/a` n'y matche plus du
  // tout, `/a/*` prend seul. Ce tri ne départage donc que les URLs réellement
  // ambiguës (ici `/a` nu, que les DEUX motifs matchent : `/a` gagne).
  _mjs_wildSegs: function(p) {
    return p.split('/').filter(function(s) { return s === '*'; }).length;
  },
  // fusion tolérante aux `undefined` :
  // `µ.url.params` est une UNION à plat des params de TOUTES les vues
  // routées de la page (cf. commentaire de `_mjs_updateUrlStore`) — deux
  // composants indépendants peuvent légitimement nommer un param pareil
  // (`:id` est un nom courant). Avec `Object.assign` brut, un composant B
  // dont le `:id` est OPTIONNEL et ABSENT sur l'URL courante écrivait
  // `id: undefined`, qui ÉCRASAIT la vraie valeur déjà posée par un
  // composant A pour qui `:id` EST présent — l'ordre d'itération de
  // `_mjs_awareComponents`/`comp.routes` (non garanti) décidait silencieusement
  // laquelle des deux valeurs survivait. Une valeur DÉFINIE ne doit jamais
  // être effacée par une absence venue d'ailleurs.
  _mjs_mergeParams: function(target, source) {
    var k;
    for (k in source) {
      if (source[k] === void 0 && target[k] !== void 0) { continue; }
      target[k] = source[k];
    }
    return target;
  },
  // Agrège les params de TOUTES les routes du composant qui matchent l'URL
  // courante (au plus une route par vue), pour les passer à `@urlChange`.
  _mjs_extractParams: function(comp, matchPath) {
    var m, params, paths, pi, routeMap, routePath, targetId;
    params = {};
    if (!comp.routes) {
      return params;
    }
    for (targetId in comp.routes) {
      routeMap = comp.routes[targetId];
      paths = this._mjs_sortedPaths(routeMap);
      for (pi = 0; pi < paths.length; pi++) {
        routePath = paths[pi];
        m = this._mjs_matchRoute(matchPath, routePath);
        if (m.ok) {
          this._mjs_mergeParams(params, m.params);
          break;
        }
      }
    }
    return params;
  },
  navigate: function(destination, pushHistory = true, replaceHistory = false) {
    var comp, matchPath, ref, results, gen;
    // garde de RÉ-ENTRANCE : un `@urlChange`
    // qui redirige (garde d'authentification typique : "si pas connecté →
    // navigate('/login')") ré-entre dans CETTE MÊME fonction PENDANT que la
    // boucle plus bas (sur `_mjs_awareComponents`) est encore en cours. L'appel
    // imbriqué tourne à son terme (pushState, met à jour TOUS les composants
    // avec le VRAI chemin final) puis rend la main à la boucle EXTÉRIEURE, qui
    // continuait alors d'itérer ses composants restants avec son `matchPath`
    // à elle — PÉRIMÉ, plus le chemin courant réel — leur injectant la
    // MAUVAISE vue. `gen` détecte qu'une navigation plus récente a pris le
    // dessus et abandonne : les composants restants ont de toute façon déjà
    // été traités par l'appel imbriqué (sa boucle couvre TOUT `_mjs_awareComponents`).
    gen = ++this._mjs_navGen;
    matchPath = this._mjs_getMatchPath(destination);
    // Mémorise le dernier chemin routé : le listener `hashchange` (mjs_ujs)
    // s'en sert pour ne PAS re-router quand un back/forward a déjà navigué
    // (popstate émet aussi hashchange sur une route hash).
    this._mjs_lastNavPath = matchPath;
    // la query est mémorisée À PART :
    // sans elle, le garde-fou hashchange (mjs_ujs.ts, `matchPath ===
    // _mjs_lastNavPath`) ne compare QUE le chemin — un changement de query SEUL
    // (même route, ex. `#/liste?tri=nom` → `#/liste?tri=prix` posé
    // programmatiquement) laisse `matchPath` inchangé → le garde-fou sautait
    // `navigate()` en entier, donc `_mjs_updateUrlStore` n'était JAMAIS rappelé
    // → `µ.url.query` restait figé sur l'ANCIENNE query à vie, malgré une
    // barre d'adresse déjà à jour.
    var _hi2 = destination.indexOf('#');
    var _hashPart2 = _hi2 !== -1 ? destination.slice(_hi2 + 1) : '';
    var _qi2 = _hashPart2.indexOf('?');
    this._mjs_lastNavQuery = _qi2 !== -1 ? _hashPart2.slice(_qi2 + 1) : '';
    µ.log(`🚦 [Router] Navigation locale vers : '${matchPath}'`);
    if (pushHistory || replaceHistory) {
      // Canonicalise le slash final AVANT de (r)emplacer (`to('/about/')` ou
      // `<a href="#/about/">` → l'historique n'enregistre que `#/about`). On ne
      // touche qu'à la partie hash de la destination (une URL peut être complète
      // lors d'un back/forward relayé par mjs_ujs).
      var _dest = destination, _hi = destination.indexOf('#');
      if (_hi !== -1) {
        _dest = destination.slice(0, _hi) + this._mjs_canonHash(destination.slice(_hi));
      }
      try {
        // DURCISSEMENT — un redirect de garde passe `replaceHistory` :
        // il remplace l'entrée courante au lieu d'en empiler une (sinon le
        // bouton Précédent reste piégé sur la route redirigée).
        if (replaceHistory) {
          window.history.replaceState({}, '', _dest);
        } else {
          window.history.pushState({}, '', _dest);
        }
      } catch (e) {
        // SecurityError sur URL cross-origin passée à l'API publique.
        µ.warn(`[Router] (r)emplacement d'historique refusé pour '${_dest}' :`, e);
      }
    }
    // `_mjs_updateUrlStore` APRÈS le
    // (r)emplacement d'historique : il relit `loc.hash`/`loc.href`/`loc.search`
    // pour `query`/`hash`/`href`. Appelé AVANT le pushState (comme avant ce fix),
    // il lisait l'ANCIENNE URL → sur un `to('/liste?tri=prix')` programmatique,
    // `µ.url.query` restait figé sur l'ancienne query À VIE (pushState n'émet
    // jamais `hashchange` pour rafraîchir ensuite). Les appelants
    // `pushHistory=false` (popstate/hashchange/clic) ont déjà une `location` à
    // jour → aucun changement pour eux.
    this._mjs_updateUrlStore(matchPath);
    // Convention MJS : `e.data` (pas `e.detail`). CustomEvent natif ne
    // connaît que `detail` au constructor → on définit `data` manuellement
    // après la construction (idem `_mjs_emit`).
    const _routeEv = new CustomEvent('mjs-route-changed');
    Object.defineProperty(_routeEv, 'data', { value: matchPath, enumerable: true });
    window.dispatchEvent(_routeEv);
    ref = this._mjs_awareComponents;
    results = [];
    var _mjsInject = () => {
      for (comp of ref) {
        if (gen !== this._mjs_navGen) {
          // Une navigation plus RÉCENTE a pris le dessus pendant cette boucle
          // (redirect dans un @urlChange déjà traité) — elle a déjà mis à jour
          // TOUS les composants avec le VRAI chemin final ; continuer ici
          // écraserait ce travail avec notre `matchPath` périmé.
          break;
        }
        if (typeof comp._mjs_hooks?.urlChange === "function") {
          comp._mjs_hooks.urlChange.call(comp, matchPath, this._mjs_extractParams(comp, matchPath));
        }
        results.push(this._mjs_injectViewsForComponent(comp, matchPath));
      }
      // Après la salve : l'URL a-t-elle trouvé preneur quelque part ? (cf.
      // `_mjs_scheduleNoMatchCheck` — retire aussi un panneau d'erreur précédent.)
      this._mjs_scheduleNoMatchCheck(matchPath);
    };
    // @viewTransition : cascade DÉPART vs ARRIVÉE, la plus grosse priorité gagne (égalité →
    // le départ gagne), cf. `_mjs_vtResolveNavigation`/`_mjs_vtWinner`. Garde d'environnement
    // (_mjs_vtEnabled) ET résolution — deux conditions SÉPARÉES (cf. leurs commentaires respectifs).
    var vtWinner = this._mjs_vtEnabled() ? this._mjs_vtResolveNavigation(matchPath) : null;
    if (vtWinner && vtWinner.value) {
      // RIDEAUX « à travers le noir » (vrai DOM, µ._mjs_vtCurtainRun) : pris en
      // charge AVANT l'API View Transitions — pas de pseudo, pas de lévitation
      // (sous le noir, un morph serait invisible)
      if (typeof µ._mjs_vtCurtainRun === 'function' && typeof vtWinner.value === 'string' && µ._mjs_vtCurtainRun(vtWinner.value, _mjsInject)) {
        µ.log(`🎬 [Router] Permutation de vues sous RIDEAU (${vtWinner.value}, priorité ${vtWinner.priority})`);
        return results;
      }
      if (typeof µ._mjs_vtApplyPreset === 'function') { µ._mjs_vtApplyPreset(vtWinner.value); }
      µ.log(`🎬 [Router] Permutation de vues sous View Transition (${typeof vtWinner.value === 'string' ? vtWinner.value : 'natif'}, priorité ${vtWinner.priority})`);
      // couche de lévitation (éléments nommés en shadow) : cf. son bloc dans mjs_vt_presets.ts
      var _vtHoist = (typeof µ._mjs_vtHoistStart === 'function') ? µ._mjs_vtHoistStart() : null;
      // pose html[data-mjs-vt] (docs/17-router.md:420) : un CSS de PROJET peut cibler
      // le nom de préréglage pendant la transition ; 'on' pour une résolution booléenne (fondu natif) ;
      // garde sur µ._mjs_vtParse (comme µ._mjs_vtApplyPreset juste au-dessus) : runtime tree-shaké sans
      // 'vt_presets' malgré un nom de préréglage résolu → repli 'on', jamais un crash. Garde sur
      // document.documentElement lui-même : de nombreux tests (vt-presets-ujs.test.ts et consorts)
      // stubbent `document` par un objet minimal { startViewTransition }, sans documentElement.
      // JETON DE SÉQUENCE, partagé avec mjs_ujs.ts (même
      // compteur µ._mjs_vtAttrSeq, même attribut html[data-mjs-vt]) : deux transitions chevauchées — le
      // retrait à `finished` d'une transition PÉRIMÉE ne doit RETIRER l'attribut QUE si aucune pose
      // plus récente n'a eu lieu depuis (sinon il efface celui de la transition ACTIVE, prouvé
      // Chromium).
      var _mjs_vtAttrSeq = (µ._mjs_vtAttrSeq = (µ._mjs_vtAttrSeq || 0) + 1);
      if (document.documentElement) { document.documentElement.dataset.mjsVt = (typeof vtWinner.value === 'string' && typeof µ._mjs_vtParse === 'function') ? µ._mjs_vtParse(vtWinner.value).base : 'on'; }
      var _vtTrans;
      try {
        _vtTrans = document.startViewTransition(_vtHoist ? () => { _mjsInject(); return µ._mjs_vtHoistSwapSettled(_vtHoist); } : _mjsInject);
      } catch (e) {
        // startViewTransition peut lever (état invalide) : l'attribut ne reste pas collé
        if (document.documentElement) { delete document.documentElement.dataset.mjsVt; }
        throw e;
      }
      // retrait à finished, y compris en échec, SEULEMENT si le compteur n'a pas bougé.
      var _vtClearAttr = function() { if (µ._mjs_vtAttrSeq === _mjs_vtAttrSeq && document.documentElement) { delete document.documentElement.dataset.mjsVt; } };
      if (_vtTrans && _vtTrans.finished) { _vtTrans.finished.then(_vtClearAttr, _vtClearAttr); }
      // une transition SAUTÉE (navigations enchaînées avant la fin) rejette
      // `ready`, que personne ne consomme ici → « Unhandled Promise Rejection »
      // en console pour un déroulé pourtant normal ; on l'absorbe
      if (_vtTrans && _vtTrans.ready && typeof _vtTrans.ready.catch === 'function') { _vtTrans.ready.catch(() => {}); }
      // nettoyage à FINISHED, jamais ready : le pseudo new(nom) est une image
      // VIVANTE du fantôme — retiré à ready, la moitié ENTRANTE du morph
      // disparaissait pendant toute l'animation (cf. _mjs_vtHoistEnd)
      if (_vtHoist && _vtTrans && _vtTrans.finished) { var _vtDone = () => µ._mjs_vtHoistEnd(_vtHoist); _vtTrans.finished.then(_vtDone, _vtDone); }
      // même absorption pour `finished` sans lévitation (le then ci-dessus couvre l'autre cas)
      if (!_vtHoist && _vtTrans && _vtTrans.finished && typeof _vtTrans.finished.catch === 'function') { _vtTrans.finished.catch(() => {}); }
    }
    else {
      _mjsInject();
    }
    return results;
  },
  // ──────────────────────────────────────────────────────────────────────────
  // TRANSITIONS DE PAGE (@viewTransition) — la permutation des <@view> peut être enveloppée dans
  // l'API View Transitions du navigateur. Cascade à 3 niveaux, le plus précis gagne : attribut
  // data-mjs-vt de la balise <@view> (posé par le compilateur), puis directive racine
  // @viewTransition du composant routeur (_mjs_viewTransition), puis défaut global µ.viewTransition
  // (clé viewTransition de mjs.config.json émise dans le manifeste — modifiable au runtime).
  //
  // Retour : `false` (désactivé), `true` (fondu natif du navigateur), ou une CHAÎNE = nom de
  // préréglage de la bibliothèque (mjs_vt_presets.ts, cf. µ._mjs_vtApplyPreset) — implique activé.
  // Chaque niveau peut poser 'on'/'off' (bool) OU un nom ('zoom', 'cube={ dir: left }'…) tel quel.
  // `'none'` ≡ `'off'` à tous les niveaux — même mot que la valeur « désactivé » de la clé de config.
  _mjs_vtResolve: function(comp, viewNode) {
    var attr = viewNode && viewNode.getAttribute ? viewNode.getAttribute('data-mjs-vt') : null;
    if (attr === 'on') { return true; }
    if (attr === 'off' || attr === 'none') { return false; }
    if (attr) { return attr; }
    var mod = comp ? comp._mjs_viewTransition : null;
    if (mod === 'on') { return true; }
    if (mod === 'off' || mod === 'none') { return false; }
    if (mod) { return mod; }
    var cfg = µ.viewTransition;
    return (cfg && cfg !== 'none') ? cfg : false;
  },
  // Garde D'ENVIRONNEMENT pure (API du navigateur présente + accessibilité) — SANS
  // rapport avec la résolution de cascade (_mjs_vtResolve/_vtResolveActive, juste en
  // dessous). PARTAGÉE : mjs_ujs.ts l'appelle telle quelle (`µ.Router._mjs_vtEnabled()`)
  // pour ses propres transitions de PAGE (swap de #app-root, cascade lien/config
  // distincte de celle-ci) — mjs_router.ts est chargé AVANT mjs_ujs.ts (ordre
  // CANONICAL, bundler/index.ts), donc atteignable sans dupliquer cette garde.
  _mjs_vtEnabled: function() {
    if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') { return false; }
    // accessibilité : « réduire les animations » ⇒ permutation directe, jamais de transition
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { return false; }
    return true;
  },
  // Parcourt les vues routées des composants ENREGISTRÉS et retourne la première
  // résolution ACTIVE trouvée (true, ou un nom de préréglage) — false si aucune.
  // Spécifique au routeur (a besoin de _mjs_awareComponents/leurs <@view>) : contrairement
  // à _mjs_vtEnabled (gate pure), CETTE boucle n'a pas d'équivalent côté UJS (une
  // transition de PAGE n'a pas de "vue routée", cf. _mjs_vtResolvePage dans mjs_ujs.ts).
  _vtResolveActive: function() {
    var comp, node, ref, targetId, resolved;
    ref = this._mjs_awareComponents;
    for (comp of ref) {
      if (!comp.routes) { continue; }
      for (targetId in comp.routes) {
        node = (comp._shadow && comp._shadow.querySelector(`metamjs-view#${targetId}`)) || (comp.querySelector && comp.querySelector(`metamjs-view#${targetId}`));
        resolved = this._mjs_vtResolve(comp, node);
        if (resolved) { return resolved; }
      }
    }
    return false;
  },
  // ──────────────────────────────────────────────────────────────────────────
  // PRIORITÉ DÉPART/ARRIVÉE (@viewTransition <nom> [priorité]) — un 2ᵉ argument
  // numérique façon z-index (défaut 1) départage deux pages qui demandent chacune
  // un nom DIFFÉRENT lors d'une même navigation. Règle : la plus grosse priorité
  // gagne (qu'elle soit posée sur la page de DÉPART ou celle d'ARRIVÉE) ; à
  // égalité (le cas le plus courant : 1 partout par défaut), c'est TOUJOURS la
  // page de DÉPART qui gagne. Résolution en {value, priority} plutôt qu'une
  // simple valeur — DISTINCTE de `_mjs_vtResolve` (gardé tel quel, testé, utilisé
  // par `_vtResolveActive` ci-dessus) : celle-ci ne sait pas dire « rien de
  // configuré » (false) d'un « off » explicite (les deux valent `false`) — ici
  // les deux cas doivent se comporter différemment (rien configuré ⇒ ce côté
  // NE PARTICIPE PAS au départage, cf. `_mjs_vtSideResolve`/`_mjs_vtWinner`).
  //
  // Cascade (du plus au moins spécifique) : attribut `data-mjs-vt`/`-p` de la
  // balise `<@view>` > directive racine `@viewTransition` du composant ROUTEUR >
  // défaut global `µ.viewTransition` (priorité toujours 1, cf. bundler/config.ts).
  // Renvoie `null` si RIEN n'est configuré à aucun niveau (ne participe pas).
  _mjs_vtResolveWithPriority: function(comp, viewNode) {
    var attr, attrP, mod, modP, cfg, cfgP;
    attr = viewNode && viewNode.getAttribute ? viewNode.getAttribute('data-mjs-vt') : null;
    if (attr) {
      attrP = viewNode.getAttribute('data-mjs-vt-p');
      return { value: attr === 'on' ? true : (attr === 'off' || attr === 'none') ? false : attr, priority: attrP ? parseInt(attrP, 10) : 1 };
    }
    mod = comp ? comp._mjs_viewTransition : null;
    if (mod) {
      modP = comp._mjs_viewTransitionPriority;
      return { value: mod === 'on' ? true : (mod === 'off' || mod === 'none') ? false : mod, priority: modP || 1 };
    }
    cfg = µ.viewTransition;
    if (cfg && cfg !== 'none') {
      // La config globale n'a pas de canal de priorité SÉPARÉ (contrairement
      // à attr/mod, où le compilateur extrait TOUJOURS `priority:` vers data-mjs-vt-p/
      // _mjs_viewTransitionPriority) : secours en relisant la chaîne elle-même
      // (`cube={ priority: 2 }`) via µ._mjs_vtParse, si le module est chargé.
      cfgP = (typeof µ._mjs_vtParse === 'function') ? µ._mjs_vtParse(cfg).priority : null;
      return { value: cfg, priority: cfgP || 1 };
    }
    return null;
  },
  // Résout la préférence @viewTransition d'un côté (départ OU arrivée) d'une
  // navigation. `leaf` = la PAGE routée elle-même — soit une INSTANCE déjà
  // montée (`viewNode.firstElementChild`, côté départ), soit la CLASSE d'un
  // module pas encore monté (`customElements.get(nom)`, côté arrivée : seuls
  // ses champs STATIQUES `_mjs_vt`/`_mjs_vtp` sont lisibles avant montage,
  // cf. template.ts). Sa PROPRE directive @viewTransition (si elle en pose une)
  // est le niveau le PLUS spécifique — au-dessus même de l'attribut <@view> et
  // de la directive du composant ROUTEUR, qui ne servent que de repli commun
  // aux DEUX côtés (cf. `_mjs_vtResolveWithPriority`).
  _mjs_vtSideResolve: function(leaf, comp, viewNode) {
    var v, p;
    if (leaf) {
      v = leaf._mjs_viewTransition !== undefined ? leaf._mjs_viewTransition : leaf._mjs_vt;
      if (v) {
        p = (leaf._mjs_viewTransitionPriority !== undefined ? leaf._mjs_viewTransitionPriority : leaf._mjs_vtp) || 1;
        return { value: v === 'on' ? true : (v === 'off' || v === 'none') ? false : v, priority: p };
      }
    }
    return this._mjs_vtResolveWithPriority(comp, viewNode);
  },
  // Départage deux résolutions {value, priority}|null. `null` = ce côté n'a
  // rien à dire, l'autre gagne d'office. La plus grosse priorité gagne ; à
  // égalité (le cas par défaut, 1 partout) c'est TOUJOURS `fromSide` (départ)
  // qui gagne — exactement la règle demandée : « peu importe, c'est toujours
  // la page d'où on part qui gagne », sauf si `toSide` (arrivée) porte une
  // priorité STRICTEMENT plus grande.
  _mjs_vtWinner: function(fromSide, toSide) {
    if (!fromSide && !toSide) { return null; }
    if (!fromSide) { return toSide; }
    if (!toSide) { return fromSide; }
    return toSide.priority > fromSide.priority ? toSide : fromSide;
  },
  // Point d'entrée appelé par `navigate()` : pour CHAQUE <@view> qui va CHANGER
  // lors de cette navigation, calcule le gagnant départ/arrivée (`_mjs_vtWinner`),
  // puis retient le gagnant de plus grosse priorité TOUS OUTLETS confondus —
  // l'API View Transitions est UNIQUE par document, une seule transition active
  // à la fois même si plusieurs <@view> changent dans la même navigation. Une
  // vue dont le module résolu est DÉJÀ celui affiché (même dérivation de tag
  // que `_mjs_injectView`, juste en dessous) ne participe PAS au vote — même si
  // elle porte elle-même une directive @viewTransition active : sinon deux
  // composants routés sur une même page se disputent une transition pour une
  // vue qui ne bouge pas (prouvé Chromium : un clic dans
  // l'un change le hash, l'autre se résout sur `/*` vers son module déjà
  // affiché, et faisait quand même voter — cf. docs/17-router.md § Bon à savoir).
  _mjs_vtResolveNavigation: function(matchPath) {
    var comp, targetId, ref, best, routeMap, paths, pi, routePath, m, matchedModule, viewNode, fromLeaf, toLeaf, fromSide, toSide, winner;
    ref = this._mjs_awareComponents;
    best = null;
    for (comp of ref) {
      if (!comp.routes) { continue; }
      for (targetId in comp.routes) {
        routeMap = comp.routes[targetId];
        viewNode = (comp._shadow && comp._shadow.querySelector(`metamjs-view#${targetId}`)) || (comp.querySelector && comp.querySelector(`metamjs-view#${targetId}`));
        matchedModule = null;
        paths = this._mjs_sortedPaths(routeMap);
        for (pi = 0; pi < paths.length; pi++) {
          routePath = paths[pi];
          m = this._mjs_matchRoute(matchPath, routePath);
          if (m.ok) { matchedModule = routeMap[routePath]; break; }
        }
        fromLeaf = viewNode ? viewNode.firstElementChild : null;
        // même dérivation de tag que l'injection (`mjs-${moduleName}`, cf.
        // _mjs_injectView) — le registre custom elements ne connaît QUE le tag
        // préfixé, jamais le nom de module nu des @routes
        if (matchedModule && fromLeaf && fromLeaf.tagName.toLowerCase() === `mjs-${matchedModule}`.toLowerCase()) { continue; } // vue déjà sur ce module : ne vote pas
        toLeaf = (matchedModule && typeof customElements !== 'undefined') ? customElements.get(`mjs-${matchedModule}`.toLowerCase()) : null;
        fromSide = this._mjs_vtSideResolve(fromLeaf, comp, viewNode);
        toSide = this._mjs_vtSideResolve(toLeaf, comp, viewNode);
        winner = this._mjs_vtWinner(fromSide, toSide);
        if (winner && (!best || winner.priority > best.priority)) { best = winner; }
      }
    }
    return best;
  },
  // Résout une DESTINATION (`#/produit/42`) vers la liste des noms de composants
  // qui SERAIENT injectés — SANS rien injecter. Même logique de match/spécificité
  // que `_mjs_injectViewsForComponent`, mais en lecture seule. Sert au PRÉCHARGEMENT
  // (précharger le module d'un lien routé au survol / à l'apparition).
  _mjs_resolveModules: function(destination) {
    var comp, matchPath, paths, pi, ref, routeMap, routeMapAll, targetId, _m;
    var modules = new Set();
    matchPath = this._mjs_getMatchPath(destination);
    ref = this._mjs_awareComponents;
    for (comp of ref) {
      if (!comp.routes) { continue; }
      routeMapAll = comp.routes;
      for (targetId in routeMapAll) {
        routeMap = routeMapAll[targetId];
        paths = this._mjs_sortedPaths(routeMap);
        for (pi = 0; pi < paths.length; pi++) {
          _m = this._mjs_matchRoute(matchPath, paths[pi]);
          if (_m.ok) { modules.add(routeMap[paths[pi]]); break; }
        }
      }
    }
    return Array.from(modules);
  },
  _mjs_injectViewsForComponent: function(comp, matchPath) {
    var injections, matchedModule, paths, pi, ref, routeMap, routePath, targetId;
    if (!comp.routes) {
      µ.log(`   ↳ ⚠️ [Router] Aucun objet @routes trouvé dans <${comp.tagName.toLowerCase()}>`);
      return;
    }
    µ.log(`   ↳ 🔍 [Router] Analyse des @routes pour <${comp.tagName.toLowerCase()}>...`);
    injections = 0;
    ref = comp.routes;
    for (targetId in ref) {
      routeMap = ref[targetId];
      matchedModule = null;
      // Tri par SPÉCIFICITÉ : d'abord le plus de segments LITTÉRAUX, puis à
      // égalité la chaîne la plus longue. Sinon `/posts/:id` (plus long) masquait
      // `/posts/new` (littéral, pourtant le plus spécifique) ; et avant, l'ordre
      // d'insertion gagnait (`/a` déclaré avant `/a/b` captait `/a/b`, glouton).
      paths = this._mjs_sortedPaths(routeMap);
      for (pi = 0; pi < paths.length; pi++) {
        routePath = paths[pi];
        var _m = this._mjs_matchRoute(matchPath, routePath);
        if (_m.ok) {
          matchedModule = routeMap[routePath];
          break;
        }
      }
      if (matchedModule) {
        µ.log(`      🎯 Match ! [${routePath}] -> Module [${matchedModule}] injecté dans <@view ${targetId}>`);
        this._mjs_injectView(comp, targetId, matchedModule, matchPath);
        injections++;
      } else {
        // Aucune route ne matche cette vue : on la VIDE — avant, l'ancien
        // module restait affiché sous une URL qui ne lui correspondait plus.
        this._mjs_clearView(comp, targetId);
      }
    }
    if (injections === 0) {
      return µ.log(`      🚫 Aucun composant à injecter pour le path '${matchPath}'.`);
    }
  },
  // ──────────────────────────────────────────────────────────────────────────
  // AUCUNE ROUTE POUR L'URL COURANTE — « vraie » 404.
  // Une adresse que PLUS AUCUNE route de PLUS AUCUN composant routé ne matche
  // n'est pas un état normal : avant, toutes les <@view> se vidaient et l'écran
  // restait blanc, sans un mot. On le dit maintenant, en console ET à l'écran.
  //
  // PÉRIMÈTRE VOLONTAIREMENT GLOBAL (pas par zone) : une page à plusieurs
  // <@view> aux tables INDÉPENDANTES a parfaitement le droit de n'en remplir
  // qu'une (barre latérale routée sur les seules pages qui la méritent) — le
  // vidage d'UNE zone reste donc silencieux, comme avant. Seul le cas « rien
  // nulle part » est une erreur.
  //
  // ÉCHAPPATOIRE : déclarer une route de repli (`'/*': 'not-found-page'`) rend
  // ce cas structurellement inatteignable — c'est la façon recommandée de
  // servir sa propre 404. Sinon, `µ.config.routeNotFound` :
  //   'error' (défaut) console + panneau à l'écran · 'warn' console seule ·
  //   'silent' comportement d'avant (trace de debug seulement).
  // ──────────────────────────────────────────────────────────────────────────
  // µ._runtimeLabels porte désormais TOUTES les langues : le choix de la
  // langue AFFICHÉE se fait via µ._mjs_label (mjs_init.ts), jamais figé au build.
  _mjs_routerLabel: function(key) {
    var fallback = { notFound: 'Page introuvable', noRoute: 'Aucune route ne correspond à cette adresse.', declared: 'Routes déclarées' };
    var v = typeof µ._mjs_label === 'function' ? µ._mjs_label('router', key) : undefined;
    return v || fallback[key];
  },
  // Toutes les routes déclarées, tous composants et toutes zones confondus —
  // sert au message d'erreur (et seulement à lui : jamais au matching).
  _mjs_declaredRoutes: function() {
    var comp, targetId, out = [];
    for (comp of this._mjs_awareComponents) {
      if (!comp.routes) { continue; }
      for (targetId in comp.routes) {
        for (var p in comp.routes[targetId]) { if (out.indexOf(p) === -1) { out.push(p); } }
      }
    }
    return out.sort();
  },
  _mjs_anyRouteMatches: function(matchPath) {
    var comp, targetId, paths, pi, routeMap, any = false;
    for (comp of this._mjs_awareComponents) {
      if (!comp.routes) { continue; }
      for (targetId in comp.routes) {
        routeMap = comp.routes[targetId];
        paths = this._mjs_sortedPaths(routeMap);
        if (paths.length > 0) { any = true; }
        for (pi = 0; pi < paths.length; pi++) {
          if (this._mjs_matchRoute(matchPath, paths[pi]).ok) { return true; }
        }
      }
    }
    // Aucune table non vide = application sans routage déclaré (composant routé
    // monté avant que ses @routes ne soient peuplées, ou table vide assumée) :
    // rien à reprocher, on ne crie pas.
    return any ? false : true;
  },
  // Première <@view> trouvée (ordre d'enregistrement) : c'est là que le contenu
  // de la page serait allé, donc là que le message doit s'afficher.
  _mjs_firstViewNode: function() {
    var comp, targetId, node;
    for (comp of this._mjs_awareComponents) {
      if (!comp.routes) { continue; }
      for (targetId in comp.routes) {
        node = (comp._shadow && comp._shadow.querySelector(`metamjs-view#${targetId}`)) || (comp.querySelector && comp.querySelector(`metamjs-view#${targetId}`));
        if (node) { return node; }
      }
    }
    return null;
  },
  _mjs_clearNoMatch: function() {
    var comp, targetId, node, old;
    for (comp of this._mjs_awareComponents) {
      if (!comp.routes) { continue; }
      for (targetId in comp.routes) {
        node = (comp._shadow && comp._shadow.querySelector(`metamjs-view#${targetId}`)) || (comp.querySelector && comp.querySelector(`metamjs-view#${targetId}`));
        old = node && node.querySelector ? node.querySelector('[data-mjs-route-error]') : null;
        if (old) { node.innerHTML = ''; }
      }
    }
  },
  // Panneau visible. Lisible par un utilisateur final d'abord (titre + adresse) ;
  // le détail développeur (liste des routes déclarées) n'apparaît que sous
  // `µ.debug`. Styles portés par un <style> voisin (jamais d'attribut style) :
  // le panneau vit dans le shadow du composant routeur, la CSS de l'application
  // ne l'atteint pas — il doit donc s'habiller seul.
  _mjs_showNoMatch: function(matchPath) {
    var node = this._mjs_firstViewNode();
    if (!node || typeof document === 'undefined') { return; }
    if (node.querySelector && node.querySelector('[data-mjs-route-error]')) { return; }
    var box = document.createElement('div');
    box.setAttribute('data-mjs-route-error', '');
    box.className = 'mjs-route-error';
    var h = document.createElement('strong');
    h.textContent = this._mjs_routerLabel('notFound');
    var p = document.createElement('p');
    p.textContent = this._mjs_routerLabel('noRoute');
    var code = document.createElement('code');
    code.textContent = matchPath;
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(code);
    if (µ.debug) {
      var list = document.createElement('p');
      list.className = 'mjs-route-error-list';
      list.textContent = this._mjs_routerLabel('declared') + ' : ' + this._mjs_declaredRoutes().join('  ·  ');
      box.appendChild(list);
    }
    node.innerHTML = '';
    node.appendChild(box);
    if (µ._csp) {
      if (!this._mjs_routeErrorSheetAdopted) {
        var errorSheet = new CSSStyleSheet();
        errorSheet.replaceSync(µ._mjs_routeErrorCss);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, errorSheet];
        this._mjs_routeErrorSheetAdopted = true;
      }
    } else {
      var style = document.createElement('style');
      style.textContent = µ._mjs_routeErrorCss;
      // <style> à CÔTÉ du panneau, pas dedans : sinon la feuille se retrouve dans
      // le `textContent` du message (copier-coller pollué). Les deux partent
      // ensemble — `_mjs_clearView` comme `_mjs_injectView` vident la zone entière.
      node.appendChild(style);
    }
  },
  // Contrôle DIFFÉRÉ d'une frame : au démarrage, les composants routés
  // s'enregistrent un par un — le premier `initComponent` verrait un état
  // partiel (« rien ne matche » alors que le composant qui matche n'a pas
  // encore monté). Un seul contrôle par salve, sur le DERNIER chemin demandé.
  _mjs_scheduleNoMatchCheck: function(matchPath) {
    if (µ._isServer || typeof document === 'undefined') { return; }
    var self = this;
    this._mjs_noMatchPath = matchPath;
    if (this._mjs_noMatchPending) { return; }
    this._mjs_noMatchPending = true;
    var run = function() {
      self._mjs_noMatchPending = false;
      self._mjs_checkNoMatch(self._mjs_noMatchPath);
    };
    if (typeof requestAnimationFrame === 'function') { requestAnimationFrame(run); }
    else { setTimeout(run, 0); }
  },
  _mjs_checkNoMatch: function(matchPath) {
    if (this._mjs_anyRouteMatches(matchPath)) { return this._mjs_clearNoMatch(); }
    var mode = (µ.config && µ.config.routeNotFound) || 'error';
    if (mode === 'silent') { return µ.log(`   ↳ 🚫 [Router] Aucune route pour '${matchPath}'.`); }
    var msg = `[Router] Aucune route ne correspond à '${matchPath}'. Routes déclarées : ${this._mjs_declaredRoutes().join(', ') || '(aucune)'} — déclarez une route de repli ('/*') pour servir votre propre page 404.`;
    if (mode === 'warn') { return µ.warn(msg); }
    µ.error(msg);
    return this._mjs_showNoMatch(matchPath);
  },
  _mjs_clearView: function(comp, targetId) {
    var targetNode = comp._shadow.querySelector(`metamjs-view#${targetId}`) || comp.querySelector(`metamjs-view#${targetId}`);
    if (targetNode && targetNode.firstElementChild) {
      // Hibernation : l'élément reste dans le cache de vues et sera ré-inséré.
      // Sans ce flag, la destruction différée tirait (@destroy exécuté) puis
      // le cache ressuscitait un composant DÉTRUIT — onMount étant one-shot,
      // ses timers/abonnements n'étaient jamais relancés.
      this._mjs_hibernateView(comp, targetNode.firstElementChild);
      µ.log(`      🚫 [Router] Aucune route pour <@view ${targetId}> — vue vidée.`);
      targetNode.innerHTML = '';
    }
  },
  // ne poser le flag
  // d'hibernation (exemption de destruction différée) QUE si l'élément est
  // ENCORE le titulaire de sa clé d'`instCache`. Évincé du LRU pendant qu'il
  // était affiché (une AUTRE vue du même composant a fait défiler >10 modules),
  // il n'est plus réinsérable : le flag le rendrait ORPHELIN (jamais réinséré
  // car cache-miss ⇒ élément neuf, jamais détruit car le flag l'exempte →
  // timers/abonnements de `@mount` fuyant à vie — exactement ce que le LRU
  // devait borner). Sans clé de route (élément hors instCache), comportement
  // historique.
  _mjs_hibernateView: function(comp, el) {
    if (!el) { return; }
    var instCache = this.cache.get(comp);
    if (el._mjs_route_key && instCache && instCache.get(el._mjs_route_key) !== el) {
      return; // évincé du cache : laisse la destruction différée normale opérer
    }
    el._mjs_page_cached = true;
  },
  _mjs_injectView: function(comp, targetId, moduleName, matchPath) {
    var cacheKey, currentElement, el, expectedTagName, instCache, newComponent, targetNode;
    targetNode = comp._shadow.querySelector(`metamjs-view#${targetId}`) || comp.querySelector(`metamjs-view#${targetId}`);
    if (!targetNode) {
      µ.error(`      ❌ [Router] CRASH : <@view ${targetId}> introuvable dans le DOM !`);
      return;
    }
    instCache = this.cache.get(comp);
    if (!instCache) {
      // `new Map()` SANS BORNE :
      // une session SPA longue durée qui affiche, l'un après l'autre dans le
      // MÊME <@view>, de nombreux composants routés DISTINCTS (navigation
      // libre, pas juste "10 pages" comme pageCache — ici CHAQUE combinaison
      // (targetId, moduleName) déjà vue) accumule un ARBRE DOM COMPLET
      // hiberné par entrée, POUR TOUJOURS — même dérive mémoire que
      // pageCache/_mjs_scrollPos/_mjs_preloadCache avant leur passage en LRU (cf.
      // mjs_ujs.ts). `µ._mjs_destroyEvictedTree` (mjs_init.ts) mentionne DÉJÀ
      // explicitement "vues du routeur" dans son propre commentaire comme
      // consommateur visé — jamais câblé jusqu'ici. Fix : même bornage que
      // pageCache (10, portée comparable : un arbre DOM+composants complet
      // par entrée), même hook onEvict (relance les teardowns différés par
      // l'hibernation, sinon chaque timer posé en @mount d'une vue évincée
      // fuyait à vie).
      instCache = typeof µ.LRUCache === 'function' ? new µ.LRUCache(10) : new Map();
      if (typeof µ._mjs_destroyEvictedTree === 'function') {
        instCache.onEvict = function(_key, el) { µ._mjs_destroyEvictedTree(el); };
      }
      this.cache.set(comp, instCache);
    }
    cacheKey = `${targetId}-${moduleName}`;
    expectedTagName = `mjs-${moduleName}`.toLowerCase();
    currentElement = targetNode.firstElementChild;
    if (currentElement && currentElement.tagName.toLowerCase() === expectedTagName) {
      // Même composant déjà affiché (`/posts/42` → `/posts/77`, même
      // <mjs-post-page>) : rien à re-poser. Les params vivent dans `µ.url.params`
      // (mis à jour par _mjs_updateUrlStore) → le composant se re-rend via sa
      // dépendance à `µ.url`. Plus d'injection d'attribut = zéro collision avec
      // un attribut natif `id`/`class`.
      return;
    }
    newComponent = instCache.has(cacheKey) ? (µ.log(`      ⚡ [Router] Restauration depuis le cache : <${expectedTagName}>`), instCache.get(cacheKey)) : (µ.log(`      🏗️ [Router] Création DOM : <${expectedTagName}>`), el = document.createElement(expectedTagName), el._mjs_route_key = cacheKey, instCache.set(cacheKey, el), el);
    // L'élément remplacé part en hibernation (il reste dans instCache) ;
    // celui qui revient en sort. Hibernation gardée — pas d'orphelin si
    // l'élément a été évincé du LRU pendant qu'il était affiché.
    if (currentElement) {
      this._mjs_hibernateView(comp, currentElement);
    }
    newComponent._mjs_page_cached = false;
    targetNode.innerHTML = '';
    return targetNode.appendChild(newComponent);
  },
  // (_applyRouteParams RETIRÉ : les params de route ne sont plus injectés en
  //  ATTRIBUTS DOM — fini la collision `:id` ↔ attribut natif `id`/`class`. On
  //  les lit via le sigil `&id` (≡ `µ.url.params.id`), maintenu par
  //  _mjs_updateUrlStore ; l'ancien `$id`-par-attribut n'existe plus.)
};

// Boot : snapshot initial de `µ.url` dès le chargement du runtime. `µ.state`
// (défini dans mjs_runes, concaténé AVANT mjs_router) est déjà là ; les params
// restent vides tant qu'aucune vue routée n'a monté, puis complétés par
// `initComponent`.
if (typeof window !== 'undefined' && typeof µ.state === 'function') {
  µ.Router._mjs_canonicalizeUrl();
  µ.Router._mjs_updateUrlStore();
}
