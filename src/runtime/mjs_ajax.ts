var _request;

// Vrai si `url` vise l'origine de la page — une URL relative en fait toujours partie. Une URL
// illisible (protocole exotique, chaîne vide) est traitée comme ÉTRANGÈRE : en cas de doute, on
// ne divulgue pas le jeton. Un document en bac à sable (`about:srcdoc`, origine `'null'`) tombe
// dans ce même repli — pas de fuite, mais pas de jeton non plus. Hors navigateur (SSR, tests Node
// sans location) la question n'a pas de sens — on rend `true`, le rendu serveur n'expose aucun
// jeton de toute façon.
// la résolution de l'URL relative DOIT suivre EXACTEMENT la
// même règle que fetch() : contre `document.baseURI`, jamais contre `location.href`. Un
// `<base href>` vers un tiers (injecté ou légitime) faisait juger "même origine" une URL relative
// qui partait RÉELLEMENT ailleurs — le jeton CSRF fuyait vers ce tiers alors que cette fonction
// répondait `true`. `document.baseURI` retombe sur `location.href` en l'absence de `<base>`
// (comportement natif) — rien ne change pour l'immense majorité des pages, qui n'en posent pas.
function _mjajaxMemeOrigine(url) {
  var base;
  if (typeof location === 'undefined' || !location.origin) return true;
  base = (typeof document !== 'undefined' && document.baseURI) || location.href;
  try { return new URL(String(url), base).origin === location.origin; }
  catch (e) { return false; }
}

µ.ajax = {
  success: function(json) {
    return µ.log("[µ.ajax] Success", json);
  },
  error: function(err) {
    return µ.error(err.message || err);
  },
  always: function() {}
};

// Internal Engine (private)
_request = function(options) {
  var base, base1, fetchOptions, ref, ref1, memeOrigine, controller, timeoutId, failed, schemaRegistre, schemaErr, corpsSchema;
  if (options.success == null) {
    options.success = µ.ajax.success;
  }
  if (options.error == null) {
    options.error = µ.ajax.error;
  }
  if (options.always == null) {
    options.always = µ.ajax.always;
  }
  // µschema-HTTP (cf. section dédiée plus bas pour le contrat complet) —
  // options.schema = nom de schéma déclaré : validation + encodage du corps AVANT tout fetch(), pour
  // que le contrat "_request retourne toujours une promesse, jamais un throw synchrone" tienne aussi
  // ici. Toute erreur (module 'schema' absent, schéma inconnu) est ROUTÉE vers options.error EXACTEMENT
  // comme un échec réseau — AUCUN fetch() n'est tenté (fail fast). Absente (défaut), cette section est
  // un no-op total : le reste de _request reste BYTE-identique à avant l'ajout de µschema-HTTP.
  if (options.schema) {
    try {
      schemaRegistre = _mjajaxRegistre(options);
      if (options.data) {
        corpsSchema = _mjajaxEncoderCorps(schemaRegistre, options.schema, options.data);
      }
    } catch (e) {
      schemaErr = e;
    }
    if (schemaErr) {
      return Promise.resolve().then(function() {
        return options.error(schemaErr);
      }).finally(function() {
        return options.always();
      });
    }
  }
  fetchOptions = {
    method: options.method,
    headers: {
      // JSON préféré, HTML accepté : la navigation ujs récupère des PAGES via
      // µ.ajax.get — l'ancien `application/json` sec faisait répondre du JSON
      // (ou un 406) aux backends à content-negotiation (Rails respond_to).
      'Accept': 'application/json, text/html;q=0.9, */*;q=0.8',
      'X-Requested-With': 'XMLHttpRequest'
    }
  };
  if (options.headers) {
    for (var hk in options.headers) {
      fetchOptions.headers[hk] = options.headers[hk];
    }
  }
  if ((ref = options.method) !== 'GET' && ref !== 'HEAD') {
    // Token relu À CHAQUE requête (querySelector ≈ µs) : la mémoïsation
    // figeait un token périmé après rotation de session (login/logout SPA)
    // → 422 en série jusqu'au reload.
    µ.csrfToken = ((ref1 = document.querySelector('meta[name="csrf-token"]')) != null ? ref1.getAttribute('content') : void 0) || null;
    // le token ne part QUE vers l'origine de la page. Le chemin ujs
    // (clic, formulaire, préchargement) filtre déjà le cross-origin ; l'API directe µ.ajax.post({url:
    // 'https://tiers.example/…'}) ne passait par AUCUN filtre et offrait le jeton de session au tiers
    // (qui n'a qu'à l'autoriser dans son Access-Control-Allow-Headers pour le recevoir)
    memeOrigine = _mjajaxMemeOrigine(options.url);
    if (µ.csrfToken && memeOrigine) {
      if ((base = fetchOptions.headers)['X-CSRF-Token'] == null) {
        base['X-CSRF-Token'] = µ.csrfToken;
      }
    } else if (µ.csrfToken && !memeOrigine) {
      µ.warn("[µ.ajax] requête " + options.method + " vers une autre origine (" + options.url + ") : le jeton CSRF de la page n'est PAS envoyé — il n'a de sens que pour l'origine qui l'a émis.");
    }
  }
  // Exclusive serialization
  if (corpsSchema) {
    // µschema-HTTP — corps binaire déjà prêt (encodé plus haut) : [8 octets version][u8 idSchéma][charge]
    if ((base1 = fetchOptions.headers)['Content-Type'] == null) {
      base1['Content-Type'] = 'application/octet-stream';
    }
    fetchOptions.body = corpsSchema;
  } else if (options.data) {
    if (options.data instanceof FormData) {
      fetchOptions.body = options.data;
    } else if (options.data instanceof URLSearchParams) {
      // corps déjà urlencoded (µ._mjs_navDispatch, submit SANS fichier
      // joint) : fetch pose SEUL le Content-Type
      // 'application/x-www-form-urlencoded;charset=UTF-8' (le serveur
      // l'accepte via startsWith) — un JSON.stringify ici détruirait le
      // corps (piège identifié : une URLSearchParams stringifiée vaut '{}').
      fetchOptions.body = options.data;
    } else {
      if ((base1 = fetchOptions.headers)['Content-Type'] == null) {
        base1['Content-Type'] = 'application/json';
      }
      fetchOptions.body = JSON.stringify(options.data);
    }
  }
  // aucun timeout : un serveur qui ne
  // répond jamais (connexion pendue, proxy muet) laissait le fetch EN VOL À
  // VIE — `options.always()` (souvent un spinner/état de chargement) ne
  // retombait jamais, et une navigation ujs déjà PÉRIMÉE (`_mjs_navSeq`) gardait
  // sa requête réseau active pour rien. Opt-in (`options.timeout`, en ms) :
  // pas de comportement par défaut changé pour l'existant (long-polling
  // volontaire notamment), seuls les appelants qui le demandent explicitement
  // sont bornés.
  controller = null;
  timeoutId = null;
  if (options.signal) {
    // Abandon PILOTÉ PAR L'APPELANT (ex. navigation ujs qui abandonne un fetch
    // périmé, cf. mjs_ujs.ts `_mjs_navDispatch`/`_mjs_abortStaleNav`) : prioritaire sur
    // le timeout interne — un appelant qui fournit son propre signal gère
    // lui-même son cycle de vie (pas de double AbortController sur un fetch).
    fetchOptions.signal = options.signal;
  } else if (options.timeout) {
    controller = new AbortController();
    fetchOptions.signal = controller.signal;
    timeoutId = setTimeout(function() { controller.abort(); }, options.timeout);
  }
  failed = false;
  // Execution
  return fetch(options.url, fetchOptions).then(function(response) {
    var isJson, ref2, nav;
    if (timeoutId) { clearTimeout(timeoutId); }
    // en-têtes de navigation (version de build + contenant HTML + politique de
    // cache + demande de rechargement dur), lus une seule fois ici : propagés sur TOUS les retours
    // ci-dessous (204/JSON/texte) jusqu'à `options.success` en 4e argument positionnel, objet
    // `{ version, target, method, cache, reload }` (champ `null` si l'en-tête HTTP correspondant est
    // absent ou vide) — sert à mjs_ujs.ts (garde de version + contenant/mode + politique de cache +
    // rechargement dur côté réponses HTML, miroir des clés `version`/`target`/`method`/`cache`/`reload`
    // côté JSON).
    nav = {
      version: response.headers.get('X-MJS-Version') || null,
      target: response.headers.get('X-MJS-Target') || null,
      method: response.headers.get('X-MJS-Method') || null,
      cache: response.headers.get('X-MJS-Cache') || null,
      reload: response.headers.get('X-MJS-Reload') || null
    };
    // µschema-HTTP — réponse binaire attendue (déclaré par l'appelant via options.schema, JAMAIS
    // deviné depuis les en-têtes) : décodage dédié, court-circuite tout le branchement JSON/texte
    // ci-dessous — cf. section µschema-HTTP plus bas pour _mjajaxRepondreSchema.
    if (options.schema) {
      return _mjajaxRepondreSchema(response, schemaRegistre, options);
    }
    // `response.url` (2e argument passé
    // à `success`, en PLUS du body — rétrocompatible : les callbacks qui ne
    // lisent que le 1er argument sont inchangés) reflète la destination
    // FINALE après tout redirect serveur suivi NATIVEMENT par `fetch`. Sans
    // lui, aucun appelant (mjs_ujs.ts en particulier, PRG des formulaires) ne
    // pouvait détecter qu'une redirection a eu lieu côté serveur.
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return { body: null, url: response.url, nav: nav };
    }
    isJson = (ref2 = response.headers.get('content-type')) != null ? ref2.includes('application/json') : void 0;
    if (isJson) {
      return response.json().then(function(json) {
        // `json.error` ne vaut échec QUE sur réponse non-ok : un 200 légitime
        // `{error: [...]}` (payload métier, erreurs de validation listées)
        // partait dans options.error.
        if (!response.ok) {
          // on ATTACHE le contexte
          // (status/body/url) à l'erreur au lieu de le perdre : un callback error
          // (mjs_ujs submit) peut alors ré-afficher un 422 (form ré-rendu avec ses
          // erreurs de validation) au lieu d'un submit muet. (Object.assign : reste
          // du JS valide — ces fichiers runtime sont aussi évalués via `new Function`.)
          throw Object.assign(
            new Error((json != null ? json.message || json.error : void 0) || `HTTP Error ${response.status}`),
            { status: response.status, body: json, url: response.url, nav: nav }
          );
        }
        return { body: json, url: response.url, nav: nav };
      });
    } else {
      if (!response.ok) {
        // le CORPS était JETÉ (throw
        // sans le lire) : un 422 HTML (form ré-affiché avec ses erreurs, convention
        // Rails/Turbo utilisée par ce dépôt) devenait un submit muet. On lit le
        // texte et on l'attache à l'erreur (status/body/url) pour que l'appelant
        // puisse l'afficher.
        return response.text().then(function(text) {
          throw Object.assign(
            new Error(`HTTP Error ${response.status} (Non-JSON response)`),
            { status: response.status, body: text, url: response.url, nav: nav }
          );
        });
      }
      return response.text().then(function(text) {
        return { body: text, url: response.url, nav: nav };
      });
    }
  }).catch(function(err) {
    if (timeoutId) { clearTimeout(timeoutId); }
    failed = true;
    if (err && err.name === 'AbortError') {
      // Deux origines bien distinctes pour un même AbortError : NOTRE timeout
      // interne (branche ci-dessous) reste signalé (message explicite +
      // options.error — l'appelant doit savoir qu'une requête a expiré) ; un
      // `options.signal` FOURNI PAR L'APPELANT (ex. navigation ujs remplacée
      // par une plus récente) est un non-évènement VOULU — chemin SILENCIEUX :
      // ni erreur console (on n'appelle PAS options.error, qui vaudrait
      // µ.ajax.error par défaut — un console.error) ni callback appelant.
      if (options.signal) {
        return { body: null, url: options.url, aborted: true };
      }
      // Un abort() déclenché par NOTRE timeout produit une DOMException/Error
      // générique 'AbortError' — message cryptique côté appelant. Normalisée
      // en une erreur explicite qui nomme le délai dépassé.
      err = new Error(`Requête expirée après ${options.timeout}ms (timeout)`);
    }
    return options.error(err);
  }).then(function(result) {
    // `options.success` est désormais
    // appelé dans un MAILLON SÉPARÉ, APRÈS le `.catch()` ci-dessus (donc HORS
    // de sa portée) : avant, il était invoqué DANS le `.then()` couvert par
    // ce même `.catch()` — une exception LEVÉE PAR LE CALLBACK SUCCESS
    // lui-même (bug de rendu du développeur, sans aucun rapport réseau)
    // remontait et se faisait rediriger À TORT vers `options.error`,
    // maquillant un crash de rendu en "échec réseau". Ici, si `success`
    // jette, l'erreur se propage normalement (rejet de la promesse retournée
    // par `_request`) — plus de mauvais aiguillage.
    if (failed) { return result; }
    // 3e argument `result.schemaNom` — ADDITIF, PUREMENT µschema-HTTP (cf. section dédiée plus bas) :
    // `undefined` pour toute réponse JSON/texte classique, ignoré sans effet par tout callback existant
    // (2 arguments) — seul µ.ajax.binary le peuple (nom du schéma décodé, utile si l'endpoint peut
    // répondre par plusieurs schémas différents). 4e argument `result.nav` — ADDITIF pareil :
    // `{ version, target, method, cache }`, chaque champ `null` quand l'en-tête
    // HTTP correspondant est absent/vide (toujours un objet, jamais `null` lui-même) — ignoré sans effet
    // par tout callback existant à 2-3 paramètres, jamais consommé hors mjs_ujs.ts.
    return options.success(result.body, result.url, result.schemaNom, result.nav);
  }).finally(function() {
    return options.always();
  });
};

// --- µschema-HTTP — AJAX BINAIRE opt-in, µ.ajax.binary(url, options) ----
//
// Étend µ.ajax pour parler µschema (src/schema/core.ts) sur HTTP au lieu de JSON — OPT-IN PAR APPEL
// (options.schema = nom de schéma), jamais un défaut global : sans lui, µ.ajax.get/post/put/patch/
// delete restent BYTE-identiques à avant cette section (JSON classique — le back reste un monde
// ouvert, cf. docs/23-mjs-ws.md §3.2). Forme choisie — µ.ajax.binary(url, options) plutôt qu'un
// paramètre de plus sur les 5 fonctions positionnelles ci-dessous : get/delete ont DÉJÀ 6 paramètres
// positionnels, post/put/patch en ont 7 — un 7e/8e y aurait été la forme la PLUS invasive possible,
// deux arités différentes selon le verbe. `url` en 1er paramètre reste cohérent avec les 5 fonctions
// existantes ; TOUT le reste (method/data/schema/codec/schemaUrl/success/error/always/timeout/signal)
// voyage dans un objet options UNIQUE (même forme que les options internes de _request) — zéro risque
// de collision avec un site d'appel existant, aucune signature publique existante n'a bougé.
//
// Contrat fil — [8 octets version ASCII][u8 idSchéma][charge µschema] : les 8 premiers octets sont
// le hash FNV-1a du registre (hashRegistre(), TOUJOURS 8 caractères hex, cf. src/schema/core.ts)
// écrits TELS QUELS en ASCII (1 octet par caractère hex, jamais parsé en entier) — lisible dans un
// dump hexa, trivial à relire dans n'importe quel langage (`String#unpack1('a8')` en Ruby, cf.
// docs/23-mjs-ws.md §3.2) sans le moindre calcul bit à bit. Le reste de la trame est EXACTEMENT ce que
// produisent encode()/decode() de src/schema/core.ts ([u8 idSchéma][charge]) — la version est un
// préfixe ADDITIONNEL, jamais une réécriture du format existant.
//
// Mise à jour à chaud (demande produit : « pour l'AJAX aussi, la version dans les premiers octets »)
// — la RÉPONSE porte la version du registre SERVEUR ; si elle diffère de hashRegistre(registre
// CLIENT), _mjajaxDecoderAvecRafraichissement lance en ARRIÈRE-PLAN un GET sur l'endpoint schéma
// (options.schemaUrl, défaut : même URL + `schema=1` en paramètre), recharge le registre via
// mjschemaChargerDefinitions (MÊME JSON que la trame µ:schema côté WS, cf. mjs_schema.ts /
// serialiserDefinitions), PUIS re-décode la charge DÉJÀ REÇUE avec le registre frais — la requête
// d'origine n'échoue pas, elle ATTEND la mise à jour (un seul aller-retour de rafraîchissement, jamais
// de boucle : un second désaccord après rafraîchissement est une vraie erreur, routée vers
// options.error comme le reste).
//
// Dépendance DURE au module runtime 'schema' (mjs_schema.ts) — µschema-HTTP a besoin de SON codec
// (mjschemaEncode/mjschemaDecode/mjschemaHashRegistre/mjschemaChargerDefinitions, fonctions de haut
// niveau déclarées par mjs_schema.ts, PORT FIDÈLE de src/schema/core.ts, cf. sa tête de fichier) —
// JAMAIS reporté une 3e fois ici (un 3e port serait un 3e endroit à garder en accord byte pour byte
// avec core.ts, cf. le même choix déjà documenté en tête de mjs_schema.ts). 'schema' absent du bundle
// (`runtime` dans mjs.config.json) → ces fonctions n'existent tout simplement pas : détecté via
// `typeof` (jamais un accès direct, qui lèverait un ReferenceError cru) et transformé en erreur
// claire, routée vers options.error. PAS d'avertissement bundler symétrique de 'schema'/'socket' :
// 'ajax' est un module DE BASE largement sélectionné sans jamais appeler .binary() — contrairement à
// mjs_game.ts/mjs_schema.ts qui PATCHENT un prototype AU CHARGEMENT, cette dépendance ne se manifeste
// QUE si l'appli appelle réellement µ.ajax.binary({schema: ...}), et échoue alors proprement (jamais
// un module partout inerte en silence) — un avertissement bundler systématique serait pur bruit.
//
// Registre — options.codec (optionnel) pointe un registre tout fait (ex. construit via
// src/schema/core.ts, structurellement compatible — cf. tests) ; sans lui, le singleton client du
// module 'schema' (µ._mjs_mjschemaRegistre, rempli par µ.schema(...)) fait foi. LIMITE HONNÊTE : un
// rafraîchissement à chaud réassigne µ._mjs_mjschemaRegistre EN PLACE (bénéficie à TOUT appel suivant qui
// utilise le défaut) mais ne peut PAS réassigner une variable que TU tiens via options.codec (une
// fonction ne réassigne jamais la variable de son appelant) — seule LA REQUÊTE EN COURS profite du
// registre frais dans ce cas ; pour un registre partagé qui se met à jour tout seul, laisse le défaut.
//
// Erreurs HTTP (!response.ok) — TOUJOURS lues comme texte/JSON conventionnel, jamais tentées en
// µschema (cf. _mjajaxLireErreurNonOk) : une erreur Rails standard (validation, 500) n'a aucune raison
// d'être schématisée, même sur un point d'accès chaud. `options.data` doit être un objet applicatif
// PLAIN (pas un FormData — sans objet, µschema encoderait des champs vides plutôt que planter, MÊME
// tolérance que mjschemaEncode/numOr0, cf. core.ts).

function _mjajaxRegistre(options) {
  var registre = options.codec || µ._mjs_mjschemaRegistre, noms;
  if (typeof mjschemaEncode !== 'function' || typeof mjschemaDecode !== 'function' || typeof mjschemaHashRegistre !== 'function' || typeof mjschemaChargerDefinitions !== 'function') {
    throw new Error("[µ.ajax.binary] option 'schema' utilisée sans le module runtime 'schema' chargé — µschema-HTTP a besoin de son codec (µ.schema/µ.list/µ.bits, cf. docs/23-mjs-ws.md §3.2). Ajoute 'schema' à la sélection runtime (mjs.config.json), ou passe un registre tout fait via options.codec.");
  }
  if (!registre) {
    throw new Error("[µ.ajax.binary] aucun registre disponible — déclare au moins un schéma via µ.schema(...) avant d'appeler µ.ajax.binary(url, { schema: '" + options.schema + "' }), ou passe options.codec.");
  }
  if (!registre.parNom || !registre.parNom.has(options.schema)) {
    noms = registre.parNom ? Array.from(registre.parNom.keys()).join(', ') : '';
    throw new Error("[µ.ajax.binary] schéma inconnu '" + options.schema + "' — schémas déclarés dans ce registre : " + (noms || '(aucun)'));
  }
  return registre;
}

function _mjajaxEncoderCorps(registre, nom, objet) {
  var hash = mjschemaHashRegistre(registre), charge = mjschemaEncode(registre, nom, objet), out = new Uint8Array(8 + charge.byteLength), i;
  for (i = 0; i < 8; i++) { out[i] = hash.charCodeAt(i); }
  out.set(charge, 8);
  return out;
}

function _mjajaxLireVersion(bytes) {
  var v = '', i;
  for (i = 0; i < 8; i++) { v += String.fromCharCode(bytes[i]); }
  return v;
}

// GET en arrière-plan de l'endpoint schéma — PAS de passage par _request (pas de CSRF/timeout ici,
// simplification volontaire signalée en tête de section : un GET simple suffit à ce rôle interne).
// Réponse JSON attendue = EXACTEMENT la forme serialiserDefinitions() (src/schema/core.ts) :
// { hash, schemas: [...] } — la MÊME que la trame µ:schema côté WS (cf. mjs_schema.ts,
// mjschemaChargerDefinitions).
function _mjajaxRafraichirSchema(options) {
  var url = options.schemaUrl || (options.url + (options.url.indexOf('?') === -1 ? '?' : '&') + 'schema=1');
  return fetch(url, { headers: { 'Accept': 'application/json' } }).then(function(r) {
    if (!r.ok) { throw new Error('[µ.ajax.binary] rafraîchissement du schéma en échec (' + url + ') : HTTP ' + r.status); }
    return r.json();
  }).then(function(json) {
    var registreFrais = mjschemaChargerDefinitions(json);
    if (!options.codec) { µ._mjs_mjschemaRegistre = registreFrais; }
    return registreFrais;
  });
}

function _mjajaxDecoderAvecRafraichissement(registre, bytes, options) {
  var version, hashLocal, charge;
  if (bytes.byteLength < 8) {
    return Promise.reject(new Error('[µ.ajax.binary] réponse trop courte pour porter une version de schéma (8 octets attendus, ' + bytes.byteLength + ' reçus)'));
  }
  version = _mjajaxLireVersion(bytes);
  charge = bytes.subarray(8);
  hashLocal = mjschemaHashRegistre(registre);
  if (version === hashLocal) {
    try { return Promise.resolve(mjschemaDecode(registre, charge)); }
    catch (e) { return Promise.reject(e); }
  }
  // désaccord de version — mise à jour à chaud (cf. tête de section) : la requête d'origine n'échoue
  // pas, elle ATTEND le rafraîchissement puis re-décode la MÊME charge déjà reçue.
  µ.warn('[µ.ajax.binary] version de schéma différente (client ' + hashLocal + ', serveur ' + version + ') — rafraîchissement en arrière-plan');
  return _mjajaxRafraichirSchema(options).then(function(registreFrais) {
    return mjschemaDecode(registreFrais, charge);
  });
}

function _mjajaxLireErreurNonOk(bytes, response) {
  var texte = new TextDecoder('utf-8').decode(bytes), corps = texte;
  try { corps = JSON.parse(texte); } catch (e) {}
  throw Object.assign(
    new Error((corps && corps.message) || ('HTTP Error ' + response.status)),
    { status: response.status, body: corps, url: response.url }
  );
}

function _mjajaxRepondreSchema(response, registre, options) {
  // MÊME convention que le chemin JSON (204 = pas de contenu, cf. plus bas) : rien à décoder.
  if (response.status === 204) { return Promise.resolve({ body: null, url: response.url }); }
  return response.arrayBuffer().then(function(buf) {
    var bytes = new Uint8Array(buf);
    if (!response.ok) { return _mjajaxLireErreurNonOk(bytes, response); }
    return _mjajaxDecoderAvecRafraichissement(registre, bytes, options).then(function(decoded) {
      return { body: decoded.objet, url: response.url, schemaNom: decoded.nom };
    });
  });
}

// Canal interne (protocole de navigation) — `_request` EST déjà l'engrenage
// complet (headers/CSRF/timeout/signal/schema), seulement jamais exposé : les 5
// wrappers publics ci-dessous imposent chacun leur propre arité fixe, sans place
// pour un `headers` supplémentaire. `µ._mjs_ajaxRequest` l'expose TEL QUEL (alias
// direct, aucune enveloppe) — DEUX consommateurs voulus : `µ._mjs_navRequest`
// (mjs_ujs.ts), qui pose l'en-tête `X-MJS-Nav` sur les requêtes de navigation
// ujs ; et `µ._mjs_navRevalidate` (mjs_ujs.ts), qui l'appelle SANS cet
// en-tête à dessein — sa comparaison porte sur du HTML (innerHTML d'un
// contenant), poser `X-MJS-Nav` ferait répondre `mjs serve` en JSON (fiche
// protocole), incomparable à un tableau de nœuds DOM déjà installés. Un appel
// applicatif direct à µ.ajax.get/post/... reste byte-identique, jamais concerné.
µ._mjs_ajaxRequest = _request;

// Public Interface
// `timeout` (ms, optionnel, dernier
// paramètre) : `_request` sait déjà borner une requête via AbortController,
// mais aucune des 5 fonctions publiques ci-dessous ne transmettait l'option
// — inatteignable depuis l'extérieur du fichier. Rétrocompatible : omis,
// `timeout` vaut `undefined` → comportement exactement inchangé.
// `signal` (AbortSignal, optionnel, dernier paramètre) — abandon réel des
// requêtes de navigation ujs (cf. mjs_ujs.ts `_mjs_abortStaleNav`/`_mjs_navDispatch`) :
// prioritaire sur `timeout` (cf. `_request`). Rétrocompatible pareil : omis,
// `undefined` → comportement inchangé.
µ.ajax.get = function(url, success, error, always, timeout, signal) {
  return _request({
    method: 'GET',
    url: url,
    success: success,
    error: error,
    always: always,
    timeout: timeout,
    signal: signal
  });
};

µ.ajax.delete = function(url, success, error, always, timeout, signal) {
  return _request({
    method: 'DELETE',
    url: url,
    success: success,
    error: error,
    always: always,
    timeout: timeout,
    signal: signal
  });
};

µ.ajax.post = function(url, data, success, error, always, timeout, signal) {
  return _request({
    method: 'POST',
    url: url,
    data: data,
    success: success,
    error: error,
    always: always,
    timeout: timeout,
    signal: signal
  });
};

µ.ajax.put = function(url, data, success, error, always, timeout, signal) {
  return _request({
    method: 'PUT',
    url: url,
    data: data,
    success: success,
    error: error,
    always: always,
    timeout: timeout,
    signal: signal
  });
};

µ.ajax.patch = function(url, data, success, error, always, timeout, signal) {
  return _request({
    method: 'PATCH',
    url: url,
    data: data,
    success: success,
    error: error,
    always: always,
    timeout: timeout,
    signal: signal
  });
};

// µ.ajax.binary(url, options) — µschema-HTTP, cf. section dédiée plus haut pour le contrat complet
// (version en tête, mise à jour à chaud, dépendance au module 'schema'). `options.method` déduit si
// omis (GET sans options.data, POST avec) ; sinon explicite, comme _request l'attend déjà. `options`
// accepte tout ce que _request comprend déjà (data/success/error/always/timeout/signal) PLUS schema
// (nom, obligatoire pour activer le binaire) / codec (registre optionnel) / schemaUrl (endpoint de
// rafraîchissement optionnel).
µ.ajax.binary = function(url, options) {
  options = options || {};
  options.url = url;
  if (options.method == null) {
    options.method = options.data ? 'POST' : 'GET';
  }
  return _request(options);
};
