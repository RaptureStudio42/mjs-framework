  // mjs_element.coffee
var MJS_BOOLEAN_PROPS, MJS_NATIVE_ATTRS, MJS_SET_MUTATORS, MJS_MAP_MUTATORS, MJS_DATE_MUTATORS,
  hasProp = {}.hasOwnProperty;

// Static sets module-level : évite N × `new Set([…])` par appel à
// `_mjs_wrapDeep`. Les Sets sont identiques pour TOUS les Proxy Set/Map/Date,
// pas besoin d'une instance par target.
MJS_SET_MUTATORS = new Set(['add', 'delete', 'clear']);
MJS_MAP_MUTATORS = new Set(['set', 'delete', 'clear']);
// Toutes les méthodes mutatrices de Date (setTime, setDate, setHours…).
// Les méthodes UTC sont incluses car elles mutent aussi l'instance.
MJS_DATE_MUTATORS = new Set([
  'setTime',
  'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds',
  'setUTCFullYear', 'setUTCMonth', 'setUTCDate', 'setUTCHours', 'setUTCMinutes', 'setUTCSeconds', 'setUTCMilliseconds',
  'setYear', // legacy mais toujours présente
]);

// Attributs HTML natifs / d'accessibilité à NE PAS exposer comme props
// réactives du composant — ils restent attachés au custom element pour le
// browser/screen-reader, et ne polluent pas $.X côté script.
MJS_NATIVE_ATTRS = new Set(['class', 'id', 'style', 'src', 'href', 'alt', 'title', 'type', 'value', 'placeholder', 'disabled', 'checked', 'name', 'for', 'tabindex', 'role', 'lang', 'dir', 'hidden', 'draggable', 'contenteditable', 'spellcheck', 'translate', 'inert', 'slot', 'is', 'part', 'exportparts']);

MJS_BOOLEAN_PROPS = new Set(['value', 'checked', 'disabled', 'open', 'readonly', 'required', 'selected', 'hidden', 'multiple', 'autofocus', 'muted', 'autoplay', 'loop', 'controls']);

// factorise la logique de `_mjs_updAttr` (props
// booléennes, `null`/`false`/`undefined` → removeAttribute, filtre XSS
// `µ._mjs_safeAttr`) pour un NODE donné directement, sans passer par la lookup
// `this._mjs_nodes[id]`. Avant ce helper, le générateur émettait dans un `{for}`
// un `setAttribute(String(v))` NU (voir attributes/index.ts, chemins
// dynamic/filtered) : `disabled={item.locked}` avec `locked=false` écrivait
// `disabled="false"` (= toujours désactivé, présence d'attribut) au lieu de
// retirer l'attribut ; `null`/`undefined` devenaient les chaînes littérales
// `"null"`/`"undefined"` ; et aucun filtre XSS n'était appliqué (contrairement
// au root, qui passait déjà par `_mjs_updAttr` → `µ._mjs_safeAttr`). `_mjs_updAttr`
// délègue désormais ICI (zéro duplication) : root et `{for}` partagent
// maintenant EXACTEMENT la même sémantique.
µ._mjs_updAttrNode = function(node, attrName, val) {
  if (!node) return;
  if (MJS_BOOLEAN_PROPS.has(attrName)) {
    if (attrName === 'value') {
      // `<select multiple value={tableau}>` en liaison SIMPLE
      // (pas two-way) : `.value = arr` ne fait RIEN (le setter DOM natif attend
      // un scalaire) → `.selectedOptions` reste vide, en silence. Sémantique
      // multi-sélection déjà câblée côté `bindingStandard` (two-way,
      // attributes/index.ts) mais jamais ici — même trou, chemin différent.
      if (node.tagName === 'SELECT' && node.multiple && Array.isArray(val)) {
        const arr = val.map(String);
        Array.from(node.options).forEach((o) => { o.selected = arr.includes(String(o.value)); });
        return;
      }
      if (node.value !== val) node.value = val;
      return;
    }
    // `hasIdl` capturé AVANT l'assignation qui suit (une propriété expando
    // fausserait le test après coup). Sur une balise SANS IDL native pour cet attribut (ex
    // `<div disabled={…}>`), `node[attrName] = boolVal` ne crée qu'une expando : aucune
    // réflexion DOM vers l'attribut de contenu, qui reste posé pour toujours. On simule
    // alors la réflexion EXPLICITEMENT, mais UNIQUEMENT en l'absence d'IDL — les balises
    // natives (button/input, ou `hidden` porté par HTMLElement) gardent leur réflexion
    // native intacte, y compris le cas FANTOME SSR checked/selected juste en dessous (qui
    // doit rester silencieux côté client, cf. son propre commentaire).
    const hasIdl = attrName in Object.getPrototypeOf(node);
    const boolVal = !!val;
    if (node[attrName] !== boolVal) node[attrName] = boolVal;
    if (!hasIdl) {
      if (boolVal) node.setAttribute(attrName, '');
      else         node.removeAttribute(attrName);
    }
    // FANTOME SSR — `checked`/`selected` sont les deux attributs que
    // la spec DOM soumet au « dirty flag » : ecrire la propriete IDL ne touche PAS
    // l'attribut de contenu. Au rendu serveur, le generateur a pose un temoin
    // `checked=''` dans le HTML statique et personne ne le retire : une case
    // rendue COCHEE alors que l'etat dit decochee. On miroite donc l'attribut,
    // mais UNIQUEMENT au serveur (`µ._isServer`) — cote client, l'attribut de
    // contenu porte la valeur PAR DEFAUT du formulaire (reset), on n'y touche pas
    if (µ._isServer && (attrName === 'checked' || attrName === 'selected')) {
      if (boolVal) node.setAttribute(attrName, '');
      else         node.removeAttribute(attrName);
    }
    return;
  }
  if (val === false && attrName.startsWith('aria-')) {
    // aria-* à false = chaîne 'false' (existe pour le lecteur d'écran), pas un retrait
    µ._mjs_safeAttr(node, attrName, 'false');
  } else if (val === false || val === null || val === void 0) {
    node.removeAttribute(attrName);
  } else {
    const strVal = typeof val === 'string' ? val : String(val);
    µ._mjs_safeAttr(node, attrName, strVal);
  }
};

// compteur global de topologie pour le cache de résolution §§ (_mjs_getRCtx) —
// toute connexion/déconnexion/écriture de contexte invalide les caches d'ancêtre
µ._mjs_rctxEpoch = 0;

// MODE LÉGER — `:host` réécrit en nom de balise. Un composant
// `mjs-light` n'a pas de vrai host (HTMLElement, pas de Shadow DOM) : sa feuille est adoptée par
// le DOCUMENT ou par le shadow réel de l'ancêtre le plus proche — dans les deux cas `:host` n'y
// désigne RIEN (matche tout au niveau document, rien au niveau d'un shadow qui n'est pas le sien),
// et `:host-context()` n'a jamais de sens hors shadow. D'où le composant resté `display: inline`
// malgré le préfixe `:host{display:X}` que le compilateur pose devant CHAQUE baseCss (V1,
// transpiler/index.ts § injectTemplate) : la règle ne matchait jamais rien. Passe caractère par
// caractère (jamais de regex globale : parenthèses potentiellement imbriquées, `:host(:not(.a))`)
// — `::slotted(...)` ne commence jamais par `:host`, jamais touché (aucun sens en mode léger,
// pas de shadow où slotter) ; une custom property `--host-x` n'a pas de `:` devant, jamais
// confondue. Cache par BALISE + texte : une réécriture par composant, jamais par instance.
µ._lightHostCss = function(css, tag) {
  var cacheKey, ch, close, consumedAny, contexts, findParenEnd, i, j, len, open, out, quote, suffix;
  if (!css) return css;
  if (µ._mjs_lightHostCssCache == null) {
    µ._mjs_lightHostCssCache = new Map();
  }
  cacheKey = tag+String.fromCharCode(1)+css; // séparateur jamais présent dans du CSS
  if (µ._mjs_lightHostCssCache.has(cacheKey)) {
    return µ._mjs_lightHostCssCache.get(cacheKey);
  }
  // parenthèse FERMANTE appariée à celle d'indice `open` (`:host(:not(.a))` → la bonne, pas la 1re)
  findParenEnd = function(start) {
    var depth, j;
    depth = 0;
    for (j = start; j < css.length; j++) {
      if (css[j] === '(') depth++;
      else if (css[j] === ')') {
        depth--;
        if (depth === 0) return j;
      }
    }
    return -1;
  };
  out = '';
  i = 0;
  len = css.length;
  while (i < len) {
    // guillemets : contenu recopié tel quel, jamais de :host à réécrire dedans (`content: ":host"`)
    if (css[i] === '"' || css[i] === '\'') {
      quote = css[i];
      j = i + 1;
      while (j < len) {
        if (css[j] === '\\') { j += 2; continue; }
        if (css[j] === quote) { j++; break; }
        j++;
      }
      out += css.slice(i, j);
      i = j;
      continue;
    }
    // suite de pseudo-classes hôte CONSÉCUTIVES (`:host-context(.a):host(.b)`, sans espace ni
    // combinateur entre elles) : UN seul composé — contextes en préfixes ancêtres (dans l'ordre),
    // UN nom de balise, suffixes accolés (dans l'ordre) — jamais un tag par token de la suite
    contexts = [];
    suffix = '';
    consumedAny = false;
    j = i;
    while (true) {
      if (css.startsWith(':host-context(', j)) {
        open = j + 13; // indice du '('
        close = findParenEnd(open);
        if (close === -1) break;
        contexts.push(css.slice(open + 1, close));
        j = close + 1;
        consumedAny = true;
        continue;
      }
      if (css.startsWith(':host(', j)) {
        open = j + 5; // indice du '('
        close = findParenEnd(open);
        if (close === -1) break;
        suffix += css.slice(open + 1, close);
        j = close + 1;
        consumedAny = true;
        continue;
      }
      if (css.startsWith(':host', j)) {
        ch = css[j + 5];
        if (ch == null || !/[\w-]/.test(ch)) {
          j += 5;
          consumedAny = true;
          continue;
        }
      }
      break;
    }
    if (consumedAny) {
      out += (contexts.length ? contexts.join(' ')+' ' : '')+tag+suffix;
      i = j;
    } else {
      out += css[i];
      i++;
    }
  }
  µ._mjs_lightHostCssCache.set(cacheKey, out);
  return out;
};

// RENDU SERVEUR — ce qu'un lecteur EXTÉRIEUR au bundle doit savoir d'un composant monté : sa
// feuille scopée (à inliner dans le `<template shadowrootmode>`), son mode light, ses nœuds de
// binding, l'état de ses `{await}` et son rendu en attente. Les propriétés `_mjs_*` portent un nom
// RACCOURCI en production (mangleProps) : seul du code compilé AVEC le bundle peut les nommer. Ce
// nom-ci n'est jamais raccourci — c'est par lui que le rendu serveur (server/renderToString.ts,
// server/render-browser.ts) lit ces valeurs.
µ._ssrInfo = function(el) {
  return {
    baseCss: el._mjs_baseCss,
    isLight: el._mjs_isLight === true,
    nodes: el._mjs_nodes,
    awaitStates: el._mjs_awaitStates,
    renderScheduled: el._mjs_render_scheduled === true
  };
};

// ============================================================================
// Convention Shadow DOM & GC
// ============================================================================
// Chaque composant MJS attache un Shadow DOM en mode `closed` :
//   - **Pourquoi closed** : empêche l'accès externe via `el.shadowRoot` (qui
//     retourne `null` sur closed). Force l'API publique du composant (props,
//     events) au lieu de scraping DOM-interne fragile. C'est le contrat MJS :
//     l'extérieur ne voit QUE l'API exposée, jamais le DOM interne.
//   - **Référence cachée** dans `this._shadow` : le composant lui-même garde
//     une référence privée pour pouvoir muter son arbre. Pas exposé.
//
// **GC (garbage collection)** :
//   - Quand un composant est retiré du DOM (`remove()`, `innerHTML = ""`,
//     etc.), `disconnectedCallback()` est appelé. Le composant doit alors :
//     1. Désinscrire tous ses listeners globaux (window, document, stores).
//     2. Annuler les RAF/timers en cours.
//     3. Vider `_mjs_inspections`, `_mjs_effects`, `_mjs_inline`, `_mjs_binds`.
//   - Une fois ces désincriptions faites, plus aucune référence externe
//     ne pointe vers le composant → le browser le GC, et avec lui :
//       a. son Shadow DOM (children, listeners internes, adoptedStyleSheets
//          locales restent rattachées à la sheet partagée mais sans ref).
//       b. son `_state`, `_mjs_nodes`, etc.
//   - **Important** : ne PAS faire de référence circulaire externe (ex.
//     stocker `el` dans un global sans WeakRef) sinon fuite mémoire. Les
//     subscriptions du Store passent par `_mjs_store_unsubs` (cf. mjs_store.ts)
//     qui sont vidées dans disconnectedCallback.
// ============================================================================
µ.Element = class Element extends HTMLElement {
  constructor() {
    super();
    // Mode `mjs-light` (opt-in instance) : si l'élément porte l'attribut
    // `mjs-light`, le composant n'utilise PAS de Shadow DOM. À la place,
    // `this._shadow` pointe sur le composant lui-même (light DOM).
    // Trade-offs :
    //   + héritage CSS global (Bootstrap, Tailwind, etc. marchent direct)
    //   + querySelector externe trouve les enfants (DevTools, tests E2E)
    //   + délégation événementielle fonctionne pareil (events bubble)
    //   − pas d'isolation : risques de collisions de styles/sélecteurs
    //   − pas de <slot> ni shadow-only API
    //   − adoptedStyleSheets indisponible → fallback <style> inline
    //
    // Détection robuste : on accepte l'attribut `mjs-light` OU une propriété
    // statique `mjsLight = true` sur la classe (fallback pour environnements
    // où l'attribut n'est pas posé avant constructor — happy-dom, etc.) OU un
    // drapeau transitoire PAR INSTANCE (`document.createElement(tag)`
    // sur un tag déjà défini — branches `{success}`/`{error}` d'un `{await}`,
    // seul chemin qui pose encore `mjs-light` en deux temps, createElement
    // PUIS setAttribute — construit l'instance SYNCHRONE, avant ce
    // `setAttribute` : `hasAttribute` échoue ici. `µ._mjs_lightNext` est posé par
    // le code généré JUSTE avant CET appel précis et effacé juste après (cf.
    // src/generator/paths.ts) : jamais un Set par tag (essayé puis RETIRÉ —
    // régression prouvée : `@lightDom` est une directive d'USAGE, pas de
    // définition du composant, deux instances du même tag peuvent différer,
    // un Set partagé par tag aurait contaminé l'une par l'autre). Pour un tag
    // pas encore défini, `createElement` ne construit rien tout de suite —
    // l'upgrade réel n'a lieu qu'à la connexion, `hasAttribute` y suffit déjà,
    // ce drapeau n'y intervient jamais (jamais posé assez tôt pour ce cas).
    var _isLight = false;
    try {
      if (this.hasAttribute && this.hasAttribute('mjs-light')) _isLight = true;
      else if (this.getAttributeNames && this.getAttributeNames().indexOf('mjs-light') >= 0) _isLight = true;
      else if (this.constructor && this.constructor.mjsLight === true) _isLight = true;
      else if (µ._mjs_lightNext && this.tagName && µ._mjs_lightNext === this.tagName.toLowerCase()) {
        _isLight = true;
        µ._mjs_lightNext = null;
      }
    } catch (e) { /* ignore */ }
    if (_isLight) {
      this._shadow = this;
      this._mjs_isLight = true;
      // SSR (render-then-replace) en mode light : le serveur a peint le contenu EN ENFANTS DIRECTS
      // (pas de <template shadowrootmode> ici — un léger n'a pas de shadow), et l'attribut `mjs-ssr`
      // de la balise le dit. Cette « photo » se remplace comme celle d'un shadow déclaratif : la vue
      // interactive appendue juste après, dans le constructor généré, prend sa place. Sans ce
      // retrait, les deux coexisteraient — page en double, la photo INERTE devant. La balise n'a
      // d'enfants à ce stade que si le PARSEUR les a posés (upgrade différé par le module du
      // bundle) : une instance créée au client, elle, arrive vide et sans cet attribut.
      if (this.hasAttribute && this.hasAttribute('mjs-ssr')) { this.replaceChildren(); }
    } else if (this.shadowRoot) {
      // SSR (render-then-replace) : le serveur a envoyé un Shadow DOM
      // déclaratif (`<template shadowrootmode="open">`), déjà attaché AVANT
      // l'upgrade du custom element. On le RÉUTILISE au lieu d'appeler
      // attachShadow (qui lèverait "already hosts a shadow tree"), et on vide
      // son contenu (la « photo » serveur). La vraie vue interactive du client,
      // appendue juste après dans le constructor généré, prend sa place : c'est
      // le swap. `_mjs_ssrAdopt` sert d'amorce à la future config `ssrMode`.
      this._shadow = this.shadowRoot;
      this._mjs_ssrAdopt = true;
      this._mjs_isLight = false;
      // Pont UJS (retargeting shadow fermé, cf. µ._mjs_ujsShadowAttach dans
      // mjs_ujs.ts) : posé dès que `this._shadow` est un VRAI shadow root
      // (jamais pour le repli `mjs-light` ci-dessus). Garde `typeof` : le
      // module 'ujs' peut être absent d'un runtime tree-shaké.
      if (typeof µ._mjs_ujsShadowAttach === 'function') { µ._mjs_ujsShadowAttach(this._shadow); }
      if (typeof µ._mjs_titleAttach === 'function') { µ._mjs_titleAttach(this._shadow); } // @title, même raisonnement (mjs_title.ts)
      // En mode hydratation, on GARDE le DOM serveur (il sera adopté par
      // _mjs_mount → _mjs_hydrate). En render-then-replace (défaut), on vide la
      // « photo » serveur ici pour laisser place à la vue reconstruite.
      if (!µ._mjs_ssrHydrate) {
        this._shadow.replaceChildren();
      }
    } else {
      try {
        this._shadow = this.attachShadow({
          mode: 'closed'
        });
      } catch (e) {
        // si on arrive ICI et que
        // `attachShadow` échoue avec "already hosts a shadow tree", c'est
        // qu'un Shadow DOM a déjà été attaché EN AMONT — nécessairement par
        // le PARSEUR HTML via Declarative Shadow DOM (`<template
        // shadowrootmode="closed">`, ex. SSR avec `shadowMode:'closed'` dans
        // les options de rendu). La branche `this.shadowRoot` ci-dessus n'a
        // rien vu : `.shadowRoot` renvoie TOUJOURS `null` pour un shadow
        // `closed`, PAR SPEC, même celui posé par le parseur lui-même — rien
        // n'expose ce shadow existant à personne d'autre que le code qui l'a
        // créé. Impossible de l'adopter ni de le vider pour y monter la vraie
        // vue interactive. AVANT ce fix, la DOMException NATIVE ("Failed to
        // execute 'attachShadow'...") remontait TELLE QUELLE hors du
        // constructor : par la spec Custom Elements, un constructor qui jette
        // une erreur non rattrapée marque l'élément "failed to upgrade" À
        // VIE — composant mort, sans AUCUN indice reliant le crash à sa
        // cause réelle (l'option `shadowMode:'closed'` côté SSR, à plusieurs
        // fichiers de distance). Fix : convertir en erreur EXPLICITE,
        // actionnable — la seule vraie solution reste `shadowMode:'open'`
        // (défaut), seul mode que ce moteur d'hydratation sait adopter (cf.
        // avertissement jumeau côté serveur, renderToString.ts).
        throw new Error(
          '[mjs] <' + this.tagName.toLowerCase() + "> : un Shadow DOM 'closed' préexiste " +
          "(SSR avec shadowMode:'closed' ?) — MJS ne peut pas l'adopter ni le reconstruire " +
          "(contenu inaccessible en mode closed). Utilisez shadowMode:'open' (défaut) dans " +
          'les options de rendu SSR.'
        );
      }
      this._mjs_isLight = false;
      // Pont UJS — même appel que la branche SSR reuse ci-dessus (cf. son
      // commentaire) : ici pour le cas nominal (attachShadow neuf).
      if (typeof µ._mjs_ujsShadowAttach === 'function') { µ._mjs_ujsShadowAttach(this._shadow); }
      if (typeof µ._mjs_titleAttach === 'function') { µ._mjs_titleAttach(this._shadow); } // @title, même raisonnement (mjs_title.ts)
    }
    this._mjs_nodes = {};
    // routing événementiel : l'id est désormais porté par une PROP
    // `_mjs_ids` sur le nœud lui-même (cf. _mjs_registerRefs / _mjs_bindEvents), au
    // lieu d'une WeakMap par instance. Plus rien à initialiser ici.
    this._state = {};
    // Lazy-init des structures rarement utilisées.
    // Économise N × (alloc Set + alloc array) par composant (avant : 4 allocs).
    // Sur 1000 rows = 4000 allocs économisées. Les lecteurs utilisent `?.size`
    // ou check `if (this._mjs_inspections)` → safe.
    // _mjs_binds : utilisé dans _mjs_notifyMutation pour `mjs-bind:X` events
    // _mjs_inspections : utilisé pour µ.inspect (rare en prod)
    // _mjs_effects : utilisé par µ.effect() (peut être vide pour beaucoup de comp)
    // _mjs_inline : populé par init via template (jamais vide en pratique)
    this._mjs_render_scheduled = false;
    this._mjs_inline = [];
    this._mjs_is_mounted = false;
    this._mjs_mjsInitialized = false;
    // Bug-fix : flag indépendant de `_mjs_lastMutedVars` pour signaler au
    // microtask consumer qu'au moins une var muée pilote `_mjs_renderStruct`.
    // Mis à `true` dans `_mjs_invalidate` si `_mjs_renderStructVars[k] === 1`,
    // remis à `false` dans le microtask. Garantit que `_mjs_renderStruct` est
    // appelé même quand l'optim a sauté l'alloc de `_mjs_lastMutedVars`
    // (i.e. composant sans `µ.effect()` user, mutation externe via
    // `µ._set` d'une var pilotant un `{for}` / `{if}` / etc.).
    this._mjs_pending_struct_dirty = false;
    // Optim #3 — Guard de dedup pour _mjs_renderStruct dans le fast-path sync.
    // Évite que N mutations consécutives sur des vars structurelles re-rendent
    // N fois la struct dans le même tick. Reset par un microtask scheduling
    // au 1er fire dans un tick donné.
    this._mjs_struct_dispatched_in_tick = false;
  }

  // ==========================================
  // CŒUR RÉACTIF V2 (sans Proxy)
  // ==========================================
  // Rewrite V2 : `$.x = y` est transformé en compile-time en
  // `µ._set(this, 'x', y)`. Les lectures `$.x` sont directes sur `_state`.
  // Plus de Proxy, plus de _mjs_buildProxy/_makeProxy. Gain attendu : 3-6×
  // sur les renders bind-heavy (plus de trap handler par accès).

  // Pour les valeurs calculées (computed), `_mjs_setComputed` installe un getter
  // sur _state qui déballe la fonction à la lecture.

    // _set : assignation primitive depuis le code utilisateur transformé
  _set(k, v) {
    // SÉCURITÉ — proto-pollution : un `{...$data}`
    // (spread) où `$data` vient d'un JSON réseau peut porter une clé PROPRE
    // `__proto__`/`constructor`/`prototype` (JSON.parse crée une own-prop
    // énumérable). Le codegen spread appelle `node._set(k, v)` par entrée →
    // sans garde, le setter natif `__proto__` de `_state` change son
    // [[Prototype]] et un `{$role}` lu via proto pollué renvoie la valeur
    // injectée. On aligne `_set` sur le reste du runtime (µ._mjs_deepSet/_mjs_guardPath,
    // socket _mjs_safeKey, vault) qui filtrent déjà ces clés.
    if (!µ._mjs_safeKey(k)) return true;
    // Hot path bench: 1000× setLabel('string'). Factorise typeof v
    // pour éviter 3 typeof checks séparés. La majorité des sets sont primitive→primitive.
    const old = this._state[k];
    const tv = typeof v;
    if (old === v && (tv !== 'object' || v === null)) {
      // 1. Sortie ultra-rapide si la primitive n'a pas changé
      return true;
    }
    // Variant posé en PROP (`layout={expr}`) et non en attribut : `syncProps`
    // ne surveille que les ATTRIBUTS — sans ce relais, la bascule changeait l'état
    // sans jamais rejouer la feuille du variant.
    // `_mjs_var_bits` tranche l'homonymie : un composant qui déclare LUI-MÊME `$layout`
    // s'en sert comme d'un état ordinaire (`'list'`/`'grid'`, rien à voir avec le style)
    // et garde la main — sinon le seul fait de nommer sa variable `layout` faisait
    // crasher son montage dès qu'un `<style name="…">` existait ailleurs dans le fichier
    if ((k === 'layout' || k === 'template') && this._shadow && !(this._mjs_var_bits && hasProp.call(this._mjs_var_bits, k))) {
      this._mjs_layoutName = v || '';   // mémorisé pour la reconnexion : aucun attribut ne le porte
      this._mjs_applyLayout(v || 'default');
    }
    // Thème nommé posé en PROP (`theme={expr}`) : pendant exact du relais ci-dessus, mais l'inverse
    // en mécanique — le CSS du thème est DÉJÀ dans le composant, c'est son sélecteur qui exige
    // l'attribut (`:where(:host([theme='gold']), mjs-x[theme='gold'])`). Sans ce reflet, la prop
    // posait un état et RIEN d'autre : aucune erreur, aucun style, panne muette.
    // Même garde `_mjs_var_bits` : un composant qui déclare son propre `$theme` métier garde la main
    if (k === 'theme' && this._shadow && !(this._mjs_var_bits && hasProp.call(this._mjs_var_bits, k))) {
      if (v) this.setAttribute('theme', v);
      else   this.removeAttribute('theme');
    }
    // `old` primitif était boxé par `old._mjs_c` puis
    // `µ._mjs_interpolatorSet.has(old)` sur le chemin des composants riches
    // (computeds/binds désarment le fast-path #B) : on gate ces accès « objet »
    // par un test de type unique (aucun primitif n'est un wrapper computed ni un
    // interpolateur) — évite le boxing sur le hot path des sets primitifs.
    const oldObj = old !== null && typeof old === 'object';
    // Optim #B — Fast-path "pure data var" : aucun computed / binds / inspections,
    // valeur primitive simple, pas de limits, pas d'effect/struct sur k, pas
    // d'effects user → on bypass _mjs_notifyMutation (skip computed dirty-marking et
    // dispatch mjs-bind) et on appelle directement _mjs_invalidate(k).
    //
    // _mjs_invalidate fera lui-même son fast-path interne (effects vides + struct
    // vide → return rapide, sans alloc microtask pour les vars pures).
    //
    // NB: on appelle quand même _mjs_invalidate(k) pour respecter le contrat API
    // (tests runtime override _mjs_invalidate pour les assertions).
    if (
      (tv === 'string' || tv === 'number' || tv === 'boolean') &&
      !this._mjs_computeds &&
      (!this._mjs_effects || this._mjs_effects.length === 0) &&
      !this._mjs_binds &&
      !this._mjs_inspections &&
      (this._mjs_limits == null || this._mjs_limits[k] == null) &&
      !(oldObj && old._mjs_c) &&
      !(oldObj && µ._mjs_interpolatorSet.has(old))
    ) {
      this._state[k] = v;
      this._mjs_invalidate(k);
      return true;
    }
    // 2. Protection des Computed : ré-écrire un computed avec une primitive
    // ne le casse pas — on garde juste le wrapper et notifie les listeners.
    if (oldObj && old._mjs_c && tv !== 'function' && !(v != null && v._mjs_c)) {
      this._mjs_notifyMutation(k, old);
      return true;
    }
    var parsed = v;
    var max, min, ref, ref1;
    // 2-ter. Assigner une valeur (nombre OU objet/tableau) à une var qui tient
    // un interpolateur (spring/tweened) règle sa CIBLE — on ne remplace PAS la
    // var (sauf si on assigne un autre interpolateur = ré-init). Permet les
    // ressorts composites : `$coords = { x, y }` → `spring.value = { x, y }`.
    if (oldObj && µ._mjs_interpolatorSet.has(old)
        && !(v != null && µ._mjs_interpolatorSet.has(v))
        && (tv === 'number' || (tv === 'object' && v !== null))) {
      old.value = v;
      return true;
    }
    // 3. Interception des nombres (Interpolators & Limites)
    if (tv === 'number') {
      if (oldObj && µ._mjs_interpolatorSet.has(old)) {
        old.value = parsed;
        return true;
      }
      if ((ref = this._mjs_limits) != null ? ref[k] : void 0) {
        ({min, max} = this._mjs_limits[k]);
        if (min !== null) {
          parsed = Math.max(min, parsed);
        }
        if (max !== null) {
          parsed = Math.min(max, parsed);
        }
      }
    } else if (parsed != null && µ._mjs_interpolatorSet.has(parsed)) {
      // `this` = owner (clé de la Map _mjs_invalidators — voir mjs_spring.ts/
      // mjs_interpolate.ts) : un ré-attach par ce MÊME composant remplace son
      // entrée (pas d'accumulation à chaque re-render) ; un AUTRE composant
      // partageant le même interpolateur garde la SIENNE.
      parsed._mjs_attachInvalidator(this, () => {
        return this._mjs_notifyMutation(k, old);
      });
      if ((ref1 = this._mjs_limits) != null ? ref1[k] : void 0) {
        parsed.min = this._mjs_limits[k].min;
        parsed.max = this._mjs_limits[k].max;
      }
    }
    if (old === parsed && (tv !== 'object' || parsed === null)) {
      // 4. Sortie finale si la valeur clampée/calculée est identique
      return true;
    }
    // 5. Wrap des objets dans un Proxy invalidant la clé top-level sur toute
    // mutation profonde. `$.box.width = X` doit re-render même si on n'a pas
    // appelé `µ._set(this, 'box', ...)` directement. Le compile-time gain
    // reste sur les primitives ; les objets payent le coût Proxy V1 (~marginal).
    if (tv === 'object' && parsed !== null && !µ._mjs_interpolatorSet.has(parsed) && !parsed._mjs_c && !(parsed instanceof Promise) && !µ._mjs_rawSet.has(parsed)) {
      // reconnaissance des enveloppes (mort de la boucle two-way
      // inter-composants). `parsed` peut arriver ENVELOPPÉ par
      // un AUTRE composant/rune/store (écho d'une liaison `!{}`, ou valeur
      // partagée assignée telle quelle) : on déballe jusqu'au brut AVANT de
      // comparer/wrapper, sinon chaque frontière empile un Proxy-de-Proxy —
      // identité neuve à chaque aller-retour, carnet (_mjs_proxyCache) jamais
      // stable, ping-pong infini.
      parsed = µ._mjs_toRaw(parsed);
      var oldRaw = µ._mjs_toRaw(old);
      if (oldRaw === parsed) {
        // Même brut des DEUX côtés : soit un ÉCHO pur (le pair nous renvoie
        // ce qu'on vient nous-même de lui envoyer, l'époque de mutation n'a
        // pas bougé depuis notre dernier passage sur cette clé — silence,
        // c'est ÇA qui tue la boucle), soit une mutation RÉELLE survenue
        // entre-temps ailleurs sur ce même brut (l'époque a bougé) qu'il
        // faut répercuter LOCALEMENT (DOM/binds) sans réécrire `_state[k]` —
        // le Proxy local déjà en place lit de toute façon le brut partagé.
        var ep = µ._mjs_epochs.get(parsed) || 0;
        if (((this._mjs_bindEpochs != null && this._mjs_bindEpochs[k]) || 0) === ep) {
          return true;
        }
        (this._mjs_bindEpochs || (this._mjs_bindEpochs = {}))[k] = ep;
        this._mjs_notifyMutation(k, old);
        return true;
      }
      var __raw = parsed;
      parsed = this._mjs_wrapDeep(parsed, k);
      (this._mjs_bindEpochs || (this._mjs_bindEpochs = {}))[k] = µ._mjs_epochs.get(__raw) || 0;
    }
    this._state[k] = parsed;
    this._mjs_notifyMutation(k, old);
    return true;
  }

  // Wrap récursif optimisé : intercepte les sets et notifie la clé
  // top-level. Cache via WeakMap pour éviter de re-wrapper le même objet à
  // chaque get.
  //
  // Set/Map/Date/RegExp ont des internal slots ([[SetData]] etc.) que le
  // Proxy ne préserve pas. On doit binder les méthodes natives sur le
  // target original pour éviter "Method called on incompatible receiver".
  // Les méthodes mutatives (add/delete/clear/set) sont en plus wrappées pour
  // notifier la mutation à la clé top-level.
  //
  // Optimisations vs version naïve :
  //   - **Précalcul** des bools `isWrapped`, `mutators` UNE fois par Proxy
  //     (pas à chaque get).
  //   - **methodCache local** : `val.bind(obj)` calculé 1 seule fois par
  //     prop accédée. Évite alloc d'une nouvelle Function à chaque accès en
  //     hot path (ex : .push/.length appelés en boucle).
  //   - **Fast-path Symbol** : Symbols sont rares, traités en premier sans
  //     dispatch.
  //   - `mutators` est un Set (O(1) `.has`) au lieu d'array `.includes` O(n).
  _mjs_wrapDeep(target, rootKey) {
    // reconnaissance des enveloppes : `target` peut être l'enveloppe
    // d'un AUTRE composant/rune/store (cf. µ._mjs_RAW) — on retrouve le brut
    // AVANT tout, pour que le carnet (_mjs_proxyCache, indexé par target) reste
    // stable peu importe le pair qui nous l'a transmis (jamais de Proxy-de-
    // Proxy à la frontière). Un Proxy MJS n'est jamais une Promise/Node.
    target = µ._mjs_toRaw(target);
    if (target instanceof Promise || µ._mjs_rawSet.has(target) || target instanceof Node) {
      return target;
    }
    // Objets natifs "exotiques" (CanvasRenderingContext2D, CSSStyleDeclaration,
    // DOMRect, TypedArray, AudioContext…) : leurs méthodes font un brand-check
    // sur `this` (internal slots) et rejettent un Proxy — "X called on an object
    // that does not implement interface …". On les renvoie BRUTS : ce sont des
    // handles opaques, l'utilisateur ne mute pas leurs props en attendant de la
    // réactivité. Cas vécu : `$context = $canvas.getContext('2d')` puis
    // `$context.beginPath()`.
    //
    // Détection (cf. Vue `reactive`) : un objet plain ET une instance de classe
    // utilisateur rapportent tous deux `[object Object]` ; un objet natif
    // rapporte son tag spécifique. On wrappe donc UNIQUEMENT : plain/instance
    // user (`[object Object]`), Array, et Map/Set/Date/RegExp (traités plus bas).
    if (
      !Array.isArray(target) &&
      !(target instanceof Map) && !(target instanceof Set) &&
      !(target instanceof Date) && !(target instanceof RegExp) &&
      Object.prototype.toString.call(target) !== '[object Object]'
    ) {
      return target;
    }
    if (this._mjs_proxyCache == null) {
      this._mjs_proxyCache = new WeakMap();
    }
    // Skip double-lookup (has + get = 2 WeakMap traversals).
    // (d) — cache par (target, rootKey) : un même objet partagé entre DEUX vars
    // d'état (`$a = obj ; $b = obj`) doit avoir un Proxy par rootKey, sinon le 2e
    // hérite du rootKey du 1er (WeakMap figée sur target) et `$b.x=…` notifie `a`.
    let __byRoot = this._mjs_proxyCache.get(target);
    if (__byRoot !== void 0) {
      const __cached = __byRoot.get(rootKey);
      if (__cached !== void 0) return __cached;
    }

    // Précalcul une seule fois par création de Proxy.
    const isMap = target instanceof Map;
    const isSet = target instanceof Set;
    const isDate = target instanceof Date;
    const isDateLike = isDate || target instanceof RegExp;
    const isWrapped = isMap || isSet || isDateLike;
    // Réutilise les Sets static module-level (1 alloc total au lieu de N).
    const mutators = isSet ? MJS_SET_MUTATORS
                   : isMap ? MJS_MAP_MUTATORS
                   : isDate ? MJS_DATE_MUTATORS
                   : null;
    // Cache local au Proxy : méthodes liées (bind/closure) calculées 1 fois.
    const methodCache = new Map();
    const el = this;

    // Forward declaration : on bind les méthodes "plain" sur LE PROXY (pas
    // sur l'objet brut) pour que les mutations `this.x = y` à l'intérieur
    // des méthodes routent via le `set` handler du proxy et déclenchent
    // `_mjs_notifyMutation`. Cas vécu : classe `Box { embiggen(n) { @width += n }`
    // appelée via `$box.embiggen(10)` — sans ce bind sur proxy, `this = box`
    // (raw) et `@width = ...` mute en silence sans re-render.
    let proxy;
    const handler = {
      get: function(obj, prop, _receiver) {
        // Fast-path Symbol (Symbol.iterator, Symbol.toPrimitive, etc.)
        if (typeof prop === 'symbol') {
          // (a) — accès à la cible BRUTE (utilisé par µ._mjs_deepSet/µ._mjs_deepCall pour
          // muter sans re-déclencher le set trap → évite la double invalidation).
          if (prop === µ._mjs_RAW) return obj;
          const val = obj[prop];
          if (typeof val !== 'function') return val;
          // (c) — for-of / spread / déstructuration : le Symbol.iterator d'un
          // Array plain doit yield des éléments PROXIFIÉS (réactifs), comme
          // `.forEach` — sinon `for (t of $arr) t.x = …` ne re-rend pas.
          if (!isWrapped && prop === Symbol.iterator) return val.bind(proxy);
          return val.bind(obj);
        }

        const val = obj[prop];

        // Set/Map/Date/RegExp : leurs internal slots ne survivent pas au Proxy.
        // On bind sur target ; les méthodes mutatives notifient la mutation.
        if (isWrapped) {
          if (typeof val !== 'function') return val;
          const cached = methodCache.get(prop);
          if (cached !== undefined) return cached;
          const bound = (mutators && mutators.has(prop))
            ? function(...args) {
                // Snapshot avant mutation UNIQUEMENT si µ.inspect actif sur cette
                // var — sinon coût prohibitif sur arrays/maps fréquemment mutés.
                const __ins = el._mjs_inspections;
                const __snap = (__ins && __ins.has(rootKey))
                  ? (Array.isArray(obj) ? obj.slice() : (obj instanceof Map ? new Map(obj) : (obj instanceof Set ? new Set(obj) : {...obj})))
                  : void 0;
                const result = val.apply(obj, args);
                // cf. commentaire jumeau du set-trap plus bas : le
                // mutateur natif (add/delete/clear/set…) EST le côté mutant.
                (el._mjs_bindEpochs || (el._mjs_bindEpochs = {}))[rootKey] = µ._mjs_bumpEpoch(obj);
                el._mjs_notifyMutation(rootKey, __snap);
                return result;
              }
            : val.bind(obj);
          methodCache.set(prop, bound);
          return bound;
        }

        // Plain object/array : fast path.
        // `obj[prop]` au lieu de Reflect.get pour que les getters soient
        // invoqués avec `this = obj` (crucial pour champs privés `#x`).
        if (typeof val === 'function') {
          const cached = methodCache.get(prop);
          if (cached !== undefined) return cached;
          // Bind sur le PROXY (pas obj) → mutations `this.x = y` dans la
          // méthode passent par le proxy set handler → re-render correct.
          const bound = val.bind(proxy);
          methodCache.set(prop, bound);
          return bound;
        }
        if (val !== null && typeof val === 'object' && !µ._mjs_rawSet.has(val)) {
          return el._mjs_wrapDeep(val, rootKey);
        }
        return val;
      },
      set: function(obj, prop, value, _receiver) {
        // SÉCURITÉ — defense-in-depth : ce Proxy est le
        // filet d'un alias ÉCHAPPÉ (`externalMerge($obj, untrusted)`) ; une clé
        // `__proto__`/`constructor`/`prototype` d'une source non fiable ne doit
        // pas polluer le prototype. Les Symbols passent (µ._mjs_safeKey ne bloque que
        // les 3 chaînes dangereuses).
        if (!µ._mjs_safeKey(prop)) return true;
        // déballe une valeur ENTRANTE déjà enveloppée (par CE composant
        // ou un autre) : `$a.nested = $b` (où `$b` est déjà un Proxy réactif) ne
        // doit pas empiler Proxy-de-Proxy — même idiome que les set-traps runes
        // (mjs_runes.ts).
        value = µ._mjs_toRaw(value);
        // Snapshot pour µ.inspect (seulement si activé pour cette var).
        const __insSet = el._mjs_inspections;
        const __snapSet = (__insSet && __insSet.has(rootKey))
          ? (Array.isArray(obj) ? obj.slice() : (obj instanceof Map ? new Map(obj) : (obj instanceof Set ? new Set(obj) : {...obj})))
          : void 0;
        if (isWrapped) {
          obj[prop] = value;
          if (!µ._mjs_rawSet.has(obj)) {
            (el._mjs_bindEpochs || (el._mjs_bindEpochs = {}))[rootKey] = µ._mjs_bumpEpoch(obj);
            el._mjs_notifyMutation(rootKey, __snapSet);
          }
          return true;
        }
        if (obj[prop] === value) {
          return true;
        }
        // Invalide le cache de méthode si la prop est réécrite avec une
        // fonction différente (rare mais possible).
        if (methodCache.has(prop)) methodCache.delete(prop);
        obj[prop] = value;
        if (!µ._mjs_rawSet.has(obj)) {
          // le CÔTÉ MUTANT enregistre SA PROPRE époque tout de suite :
          // sans ça, l'écho qui revient de la frontière two-way ne se
          // distinguerait pas d'une mutation externe, et se re-notifierait
          // lui-même (cf. `_set`, comparaison oldRaw/parsed + époque).
          (el._mjs_bindEpochs || (el._mjs_bindEpochs = {}))[rootKey] = µ._mjs_bumpEpoch(obj);
          el._mjs_notifyMutation(rootKey, __snapSet);
        }
        return true;
      },
      // `deleteProperty` manquait : ce Proxy est le
      // FILET pour un alias ÉCHAPPÉ (`$obj` passé à une fonction externe qui
      // fait `delete alias.k`) — le path-tracking compile-time (path-tracker.ts,
      // visiteur UnaryExpression) ne voit QUE les `delete` écrits en clair dans
      // le script du composant, pas ceux exécutés depuis un code appelé. Sans ce
      // trap, `delete` sur l'alias supprimait bien la clé (Reflect par défaut)
      // mais ne notifiait JAMAIS `rootKey` → DOM figé. Symétrique du `set`
      // ci-dessus.
      deleteProperty: function(obj, prop) {
        // SÉCURITÉ — symétrique du set trap.
        if (!µ._mjs_safeKey(prop)) return true;
        const __insDel = el._mjs_inspections;
        const __snapDel = (__insDel && __insDel.has(rootKey))
          ? (Array.isArray(obj) ? obj.slice() : (obj instanceof Map ? new Map(obj) : (obj instanceof Set ? new Set(obj) : {...obj})))
          : void 0;
        const had = prop in obj;
        if (methodCache.has(prop)) methodCache.delete(prop);
        delete obj[prop];
        if (had && !µ._mjs_rawSet.has(obj)) {
          (el._mjs_bindEpochs || (el._mjs_bindEpochs = {}))[rootKey] = µ._mjs_bumpEpoch(obj);
          el._mjs_notifyMutation(rootKey, __snapDel);
        }
        return true;
      },
      // SÉCURITÉ — `Object.defineProperty(proxy, '__proto__', …)`
      // contournait le `set`/`deleteProperty` ci-dessus (chemin d'écriture DIFFÉRENT du Proxy) :
      // même garde, même silence (filet d'un alias ÉCHAPPÉ, cf. commentaire du `set` plus haut).
      defineProperty: function(obj, prop, desc) {
        if (!µ._mjs_safeKey(prop)) return false;
        return Reflect.defineProperty(obj, prop, desc);
      },
      // SÉCURITÉ — `Object.setPrototypeOf(proxy, evil)` changeait le
      // PROTOTYPE en un seul appel, hors de portée du trap `set` (pas une écriture de clé).
      setPrototypeOf: function(obj, proto) {
        // message copié à tort du store (mjs_store.ts) :
        // ici c'est l'ÉTAT RÉACTIF d'un COMPOSANT (_mjs_wrapDeep), pas le store global.
        µ.warn('[ModularJS] état : changement de prototype refusé');
        return false;
      }
    };
    proxy = new Proxy(target, handler);
    if (__byRoot === void 0) {
      __byRoot = new Map();
      this._mjs_proxyCache.set(target, __byRoot);
    }
    __byRoot.set(rootKey, proxy);
    return proxy;
  }

  // _mjs_setComputed : enregistre une fonction calculée et installe un getter sur _state.
  //
  // **Memoization (parité Svelte 5)** :
  // Le getter cache le résultat dans `v._mjs_cached` et le sert tant que `v._mjs_dirty`
  // est false. Quand une dep change → `_mjs_notifyMutation` met `_mjs_dirty = true` pour
  // tous les computeds dont le `_mjs_var_bits` matche. Une lecture suivante réévalue
  // une fois et re-cache. Évite la ré-évaluation O(n) sur lectures multiples
  // dans le même frame.
  //
  // Détection de cycle conservée via `_mjs_evaluating`. Réassignation primitive
  // `$.x = 5` route via le setter qui convertit en value writable.
  _mjs_setComputed(k, fn) {
    var descriptor, el;
    if (this._mjs_computeds == null) {
      this._mjs_computeds = {};
      this._mjs_computedKeys = [];
    }
    if (!(k in this._mjs_computeds)) {
      this._mjs_computedKeys.push(k);
    }
    this._mjs_computeds[k] = {
      f: fn,
      _mjs_evaluating: false,
      _mjs_c: true,
      _mjs_cached: void 0,
      _mjs_dirty: true
    };
    // Installer le getter (idempotent)
    descriptor = Object.getOwnPropertyDescriptor(this._state, k);
    if (!(descriptor != null ? descriptor.get : void 0)) {
      el = this;
      Object.defineProperty(this._state, k, {
        configurable: true,
        enumerable: true,
        get: function() {
          var v;
          // V2 — plus de bitmask tracking. La closure des deps est connue
          // au compile-time via analyzer.computedDeps (déjà exposée via
          // l'analyzer). Pour les stores universels / effets qui lisent
          // un computed, ils s'abonnent à `comp._mjs_effectsByVar[<computedName>]`
          // s'il y a effectivement un dispatcher pour cette var.
          v = el._mjs_computeds[k];
          if (!v) {
            return void 0;
          }
          if (v._mjs_evaluating) {
            µ.warn(`[ModularJS] Cycle réactif détecté sur '${k}' — retourne undefined`);
            return void 0;
          }
          // Cache hit : retourne la valeur mémorisée sans ré-évaluer.
          if (!v._mjs_dirty) {
            return v._mjs_cached;
          }
          v._mjs_evaluating = true;
          try {
            v._mjs_cached = v.f.call(el._state);
            v._mjs_dirty = false;
            return v._mjs_cached;
          } finally {
            v._mjs_evaluating = false;
          }
        },
        set: function(newVal) {
          // Réassignation primitive : convertir le getter en value writable.
          delete el._mjs_computeds[k];
          if (el._mjs_computedKeys) {
            const __idx = el._mjs_computedKeys.indexOf(k);
            if (__idx !== -1) el._mjs_computedKeys.splice(__idx, 1);
          }
          Object.defineProperty(el._state, k, {
            configurable: true,
            writable: true,
            enumerable: true,
            value: newVal
          });
          return el._mjs_notifyMutation(k, void 0);
        }
      });
    }
    this._mjs_notifyMutation(k, void 0);
    return true;
  }

  // Les HOOKS DE CYCLE DE VIE en runes (µmount/µawake/µsleep/µdestroy/µurlChange/µfailed nu,
  // `_mjs_hook`/`_mjs_fireMount`) et l'API interne de teardown qu'ils partagent
  // (`_mjs_onDestroy`/`_mjs_onSleep`/`_mjs_onAwake`) vivent désormais dans
  // src/runtime/mjs_lifecycle.ts — patch de `µ.Element.prototype` posé APRÈS
  // cette classe, même technique que mjs_on.ts.

  // HUB CENTRAL DES MUTATIONS
  _mjs_notifyMutation(k, oldValue) {
    // Cache local des slots rarement utilisés. Le pattern Coffee
    // `((ref = X) != null ? ref.size : void 0)` génère 2 var décl + chained
    // ternary. V8 ne hoist pas ces locaux entre appels. Cache direct simplifié.
    // 99% des composants n'ont ni `_mjs_inspections` ni `_mjs_binds` → skip total.
    const __ins = this._mjs_inspections;
    if (__ins && __ins.size > 0 && __ins.has(k)) {
      // NB: utiliser `console.log` (pas `µ.log`) — µ.inspect est explicitement
      // demandé par l'utilisateur, doit s'afficher peu importe `µ.debug`.
      console.group(`🔍 [MJS Inspect] ${k}`);
      if (oldValue !== void 0) {
        console.log("%cFrom :", "color: #888", µ._mjs_snap(oldValue));
      }
      // `µ._mjs_snap` déproxifie : si la valeur a été wrappée en Proxy (cas
      // d'escape compile-time), on affiche un objet/array nu lisible et non
      // un `Proxy { <target>: … }` opaque dans la console.
      console.log("%cTo   :", "color: #2ecc71; font-weight: bold", µ._mjs_snap(this._state[k]));
      console.groupEnd();
    }
    // V2 — invalidation memo computed : marquer dirty TOUS les computeds.
    // Sans bitmask, on ne peut plus filtrer "qui dépend de k" en O(1) côté
    // runtime — mais marker tous les computeds dirty est sûr (chaque getter
    // re-vérifie via `_mjs_evaluating`/cache). Le coût supplémentaire est ~0 :
    // un computed reste dirty=true tant qu'on ne le lit pas.
    // Cache des keys de computeds : `for...in` recrée un iterateur
    // hidden-class à chaque appel. On stocke un array `_mjs_computedKeys` mis à
    // jour à chaque `_mjs_setComputed`. Pour un composant sans computed (cas
    // bench), le test `this._mjs_computeds` court-circuite directement.
    const __cs = this._mjs_computeds;
    if (__cs) {
      const __cks = this._mjs_computedKeys;
      if (__cks) {
        for (let __ci = 0, __cln = __cks.length; __ci < __cln; __ci++) {
          // Garde null (aligne sur le jumeau `_awaits_`) : une
          // désynchro `_mjs_computedKeys`/`_mjs_computeds` (delete direct futur d'un
          // computed) ferait un TypeError dans le hub des mutations.
          const __c = __cs[__cks[__ci]];
          if (__c) __c._mjs_dirty = true;
        }
      } else {
        for (const ck in __cs) {
          __cs[ck]._mjs_dirty = true;
        }
      }
    }
    this._mjs_invalidate(k);
    // Ne créer le CustomEvent (alloc + dispatch) qu'une fois la condition
    // validée. Avant, l'allocation se faisait quand même.
    // Cache local + simplify du Set#has check.
    const __binds = this._mjs_binds;
    if (__binds && __binds.size > 0 && __binds.has(k)) {
      // Convention MJS : `e.data` (pas `e.detail`). Voir _mjs_emit.
      // Direct assignation au lieu de defineProperty (économise ~50ns alloc).
      // CustomEvent ne réserve pas la prop `data`, assignation libre OK.
      const _bindEv = new CustomEvent(`mjs-bind:${k}`, {
        bubbles: true,
        composed: false
      });
      _bindEv.data = this._state[k];
      return this.dispatchEvent(_bindEv);
    }
  }

  // ==========================================
  // CYCLE DE VIE ET API PRIVÉE DE L'INSTANCE
  // ==========================================

  // `_mjs_setContext`/`_mjs_getContext` (§) et `_mjs_setRCtx`/`_mjs_getRCtx`/
  // `_mjs_rctxRemember` (§§) vivent désormais dans src/runtime/mjs_context.ts —
  // patch de `µ.Element.prototype` posé APRÈS cette classe, même technique que
  // mjs_on.ts.

  // `_mjs_on` (rune `µon`) vit désormais dans src/runtime/mjs_on.ts — patch de
  // `µ.Element.prototype` posé APRÈS cette classe, même technique que mjs_flip.ts.

  // `_mjs_emit` (rune `µemit`, directive `@emit.NOM`) vit désormais dans
  // src/runtime/mjs_emit.ts — patch de `µ.Element.prototype` posé APRÈS cette
  // classe, même technique que mjs_on.ts.

  connectedCallback() {
    var key, parseProp, ref, schema, syncProps;
    // Reprise du fragment différé par `_mjs_mount` en mode léger (cf. son
    // commentaire) : `connectedCallback` n'a pas la contrainte
    // « pas d'enfants » du constructeur, l'insertion peut se faire ici sans
    // risque, quel que soit l'ordre réel construction/upgrade.
    if (this._mjs_pendingLightFragment) {
      this.appendChild(this._mjs_pendingLightFragment);
      this._mjs_pendingLightFragment = null;
    }
    if (!this._mjs_mjsInitialized) {
      // Anti-FOUC : pose [mjs-loading] AVANT tout travail de montage. La règle
      // globale [mjs-loading]{display:none!important} (cf. build_fouc_shield)
      // prend le relais du :not(:defined) qui vient de s'éteindre à l'upgrade.
      // Retiré en fin du premier render ci-dessous.
      this.setAttribute('mjs-loading', '');
    }
    this._mjs_is_mounted = true;
    // topologie changée (connexion) : invalide tous les caches de résolution §§
    µ._mjs_rctxEpoch++;
    // `disconnectedCallback` pose
    // `_mjs_dead = true` inconditionnellement (fiabilise le nettoyage
    // paresseux). Or un simple DÉPLACEMENT DOM (réordonnancement d'un {for},
    // `appendChild` ailleurs, restauration pageCache) déclenche
    // disconnect+connect dans le MÊME tick, SANS destruction : sans reset ici,
    // le composant vivant reste marqué mort → `_mjs_notifyInvalidators`
    // (µspring/µinterpolate) purge ses liaisons (ressorts figés), un reconcile
    // le traite DEAD (recréation fraîche, perte d'état), les `introend` sautent.
    // On le ressuscite en tête de (re)connexion (+ `_mjs_dying` par symétrie).
    this._mjs_dead = false;
    this._mjs_dying = false;
    schema = this.constructor.props || {};
    parseProp = (key, v) => {
      var typeStr, val;
      typeStr = schema[key];
      if (typeStr === Number) {
        val = Number(v);
        if (isNaN(val)) {
          return 0;
        } else {
          return val;
        }
      }
      if (typeStr === Boolean) {
        return v !== 'false' && v !== null;
      }
      if (typeStr === Object || typeStr === Array) {
        try {
          return JSON.parse(v);
        } catch (error1) {
          return null;
        }
      }
      if (typeStr === String) {
        return String(v);
      }
      if (v === 'true') {
        return true;
      }
      if (v === 'false') {
        return false;
      }
      if (v === 'null') {
        return null;
      }
      if (v === 'undefined') {
        return void 0;
      }
      // Props objet (SSR / passage de données) : une valeur d'attribut qui EST
      // un JSON objet/array est auto-ré-hydratée (ex. <mjs-x item='{"a":1}'>).
      // Fallback string si le JSON est invalide → aucun impact sur les attributs
      // string classiques (qui ne commencent pas par { ou [, ou ne sont pas du
      // JSON valide).
      if (typeof v === 'string' && v.length > 1) {
        const _c0 = v.charCodeAt(0);
        if (_c0 === 123 || _c0 === 91) { // '{' ou '['
          try {
            return JSON.parse(v);
          } catch (_e) {
            // garder la valeur brute
          }
        }
      }
      return v;
    };
    syncProps = () => {
      var attr, j, key, len, parsed, ref, results;
      ref = this.attributes;
      results = [];
      for (j = 0, len = ref.length; j < len; j++) {
        attr = ref[j];
        const _nameL = attr.name.toLowerCase();
        key = attr.name.replace(/-([a-z])/g, function(g) {
          return g[1].toUpperCase();
        });
        // Skip : préfixes MJS internes, attributs natifs HTML, et conventions
        // ARIA/data-* (gérés par le browser, jamais exposés comme props).
        // EXCEPTION : si l'attribut natif (`title`, `src`, `name`, …) correspond
        // à une prop DÉCLARÉE du composant (`_mjs_var_bits`), c'est une vraie prop
        // — le browser pose aussi l'attribut natif mais le composant veut la
        // valeur dans `_state` (cas `<mjs-audio-player title="…">`).
        const _isDeclaredProp = this._mjs_var_bits != null
          && Object.prototype.hasOwnProperty.call(this._mjs_var_bits, key);
        if (attr.name.startsWith('mjs-')
            || (MJS_NATIVE_ATTRS.has(_nameL) && !_isDeclaredProp)
            || _nameL.startsWith('aria-')
            || _nameL.startsWith('data-')
            // Anti-`onclick` ciblé : seulement les VRAIS handlers DOM (présents
            // sur le prototype). L'ancien `startsWith('on')` avalait aussi des
            // props légitimes : `online`, `onboarding-step`, `onyx-color`…
            || (_nameL.startsWith('on') && (_nameL in HTMLElement.prototype))) {
          continue;
        }
        parsed = parseProp(key, attr.value);
        if (this._state[key] !== parsed) {
          this._set(key, parsed);
          if (key === 'template' || key === 'layout') {
            results.push(this._mjs_applyLayout(attr.value));
          } else {
            results.push(void 0);
          }
        } else {
          results.push(void 0);
        }
      }
      return results;
    };
    // `_mjs_layoutName` (dernier variant RÉELLEMENT appliqué) avant les attributs : un
    // variant posé en prop par le parent (`layout={expr}`) doit survivre à une
    // reconnexion. On ne lit surtout pas `_state` — un composant peut avoir un `$layout`
    // à lui, sans rapport avec le style (cf. le garde de `_set`)
    this._mjs_applyLayout(this._mjs_layoutName || this.getAttribute('layout') || this.getAttribute('template') || 'default');
    syncProps();
    // Props posées par un parent AVANT la mise à niveau : elles n'ont jamais touché
    // l'élément, un registre hors instance les tenait (`µ._mjs_pend`, cf. mjs_init.ts).
    // CHAQUE clé passe par `_set`, dans l'ordre où elle est arrivée : le chemin exact d'un
    // enfant déjà défini quand son parent pose ses props (`node._set(k, v)`, sans filtre).
    // L'état n'est pas l'instance — une clé venue d'une donnée d'exécution (étalement
    // `{...$data}`) y dort sans masquer la méthode du prototype qui porte le même nom court
    // en production, et une prop au nom d'attribut natif (`id`, `title`) arrive comme
    // ailleurs. Vient AVANT la reprise des propriétés propres ci-dessous : ces dernières
    // sont forcément postérieures (`µ._mjs_pend` retire celle qu'il double).
    const __pend = µ._mjs_pending.get(this);
    if (__pend) {
      µ._mjs_pending.delete(this);
      for (const __pk in __pend) {
        this._set(__pk, __pend[__pk]);
      }
    }
    if (this._mjs_var_bits) {
      // Object.keys + for-let-i au lieu de for...in (V8 spécialise mieux).
      const __vbk = Object.keys(this._mjs_var_bits);
      // clés homonymes état/méthode (`_mjs_state_methods`, cf transpiler) :
      // les méthodes du composant vivent SUR L'INSTANCE (fermetures sur les
      // variables internes) ; une clé qui nomme aussi une méthode ne doit pas
      // voir sa FONCTION versée dans l'état — une valeur non-fonction posée
      // par un parent avant l'upgrade, elle, reste sauvée normalement
      const __smn = this._mjs_state_methods;
      for (let __vi = 0, __vln = __vbk.length; __vi < __vln; __vi++) {
        const __k = __vbk[__vi];
        if (this.hasOwnProperty(__k)) {
          if (__smn && __smn[__k] && typeof this[__k] === 'function') { continue; }
          this._set(__k, this[__k]);
          // propriété figée par la page (`Object.defineProperty` sans `configurable`) : on la
          // laisse, un `delete` lèverait et couperait la fin du montage
          const __d = Object.getOwnPropertyDescriptor(this, __k);
          if (__d && __d.configurable) { delete this[__k]; }
        }
      }
    }
    this._mjs_invalidate('_awaits_');
    // Anti-FOUC : _mjs_invalidate schédule le premier render en microtask. La
    // microtask suivante (enchaînée ici) s'exécute APRÈS ce render, on peut
    // donc retirer [mjs-loading] → le composant apparaît déjà rendu.
    //
    // Sauf si `_mjs_applyLayout` (appelé juste au-dessus, SANS await) est
    // parti chercher une feuille partagée en différé : il a alors posé sa promesse
    // sur `_mjs_cssPending` AVANT de rendre la main, et on retient [mjs-loading]
    // jusqu'à ce qu'elle soit adoptée. Sans ça le composant s'afficherait nu le
    // temps d'un aller-retour réseau — exactement le clignotement que le mode
    // paresseux doit éviter. Hors 'lazy', `_mjs_cssPending` est toujours absent et
    // le chemin ci-dessous est celui de toujours, à l'identique.
    const _cssPending = this._mjs_cssPending;
    if (_cssPending) {
      _cssPending.then(() => {
        if (this._mjs_is_mounted) {
          this.removeAttribute('mjs-loading');
        }
      });
    } else {
      queueMicrotask(() => {
        if (this._mjs_is_mounted) {
          return this.removeAttribute('mjs-loading');
        }
      });
    }
    if (this._mjs_propObserver == null) {
      this._mjs_propObserver = new MutationObserver(function() {
        return syncProps();
      });
    }
    this._mjs_propObserver.observe(this, {
      attributes: true
    });
    if (!this._mjs_mjsInitialized) {
      this._mjs_mjsInitialized = true;
      // µmount différé après le 1er render (cf. mjs_element_int.coffee).
      // Permet aux bindings @this=!{ref} d'être appliqués avant l'appel.
      // Skip ce flag si pas de hook mount déclaré (gain micro mais évite
      // de checker `_mjs_pendingMount` dans chaque _mjs_invalidate fast-path).
      if (typeof this._mjs_hooks?.mount === 'function') {
        this._mjs_pendingMount = true;
      }
    }
    // SSR : les hooks de cycle de vie CLIENT (µawake/µmount) ne s'exécutent
    // PAS côté serveur (µ._isServer posé par renderToString dans happy-dom) ;
    // ils joueront à l'hydratation dans le navigateur, comme onMount de Svelte.
    if (typeof this._mjs_hooks?.awake === "function" && !µ._isServer) {
      this._mjs_hooks.awake.call(this);
    }
    // file `_mjs_awake_cbs` — même motif que `_mjs_mount_cbs` : la map des hooks
    // n'a qu'UNE case par nom, une rune qui s'y poserait écraserait le `µawake ->`
    // de l'utilisateur. Contrairement à la file de montage, celle-ci n'est PAS
    // vidée : elle rejoue à chaque reconnexion (µevery `pause: true`)
    if (this._mjs_awake_cbs && !µ._isServer) {
      const __ac = this._mjs_awake_cbs;
      for (let i = 0, n = __ac.length; i < n; i++) __ac[i].call(this);
    }
    // Store global statisé (`$$`) — abonnement PAR CLÉ (mjs_store_globals.ts),
    // en miroir de µ._mjs_registerUniversalDep pour les contextes. `_mjs_storeKeys`
    // est posé par le compilateur (liste statique des clés `$$x` lues par CE
    // composant, '*' = énumération de structure). Reposé à CHAQUE (re)connexion
    // (même cycle que le reste de connectedCallback, AVANT le `return` router-
    // aware ci-dessous) : survit à awake/sleep, symétrique de
    // µ._mjs_storeUnsubscribe en disconnectedCallback.
    // garde `typeof` : `vault`/mjs_store_globals.ts est un module OPTIONNEL — un
    // composant peut lire `$$x` (donc porter `_mjs_storeKeys`) alors que le projet a
    // omis 'vault' de son `runtime` explicite ; sans la garde, TypeError à CHAQUE connexion.
    if (this._mjs_storeKeys && this._mjs_storeKeys.length > 0 && typeof µ._mjs_storeSubscribe === 'function') {
      µ._mjs_storeSubscribe(this, this._mjs_storeKeys);
    }
    // i18n (mjs_i18n.ts, module OPTIONNEL — `µ.i18n` peut être absent si le
    // runtime bundlé n'inclut pas 'i18n') : `_mjs_i18n` posé par le
    // compilateur = [section|null, overrideMode|null]. `µ.i18n._mjs_connect` enregistre le
    // composant et, en mode 'wait' avec fragment pas encore arrivé, gèle le PREMIER rendu
    // (déjà planifié juste au-dessus par `_mjs_invalidate('_awaits_')`) jusqu'à son arrivée —
    // cf. la garde `_mjs_i18n_hold` dans `_mjs_invalidate`.
    if (this._mjs_i18n && µ.i18n) µ.i18n._mjs_connect(this);
    if (this._mjs_is_router_aware) {
      return (ref = µ.Router) != null ? typeof ref.register === "function" ? ref.register(this) : void 0 : void 0;
    }
  }

  disconnectedCallback() {
    var e, err, j, len, ref, ref1, ref2, ref3, ref4, td, unsub;
    this._mjs_is_mounted = false;
    // topologie changée (déconnexion) : invalide + purge (ne pas retenir des
    // références d'ancêtres morts)
    µ._mjs_rctxEpoch++;
    this._mjs_rctx_cache = null;
    // `_mjs_dead` n'était posé QUE par le walk
    // interne `_mjs_destroyNodeAndChildren` (retrait via un bloc {if}/{for} du
    // PARENT) — un composant déconnecté par un autre chemin (ex. `el.remove()`
    // direct depuis du code utilisateur) ne l'avait jamais. Le poser ICI,
    // inconditionnellement, fiabilise tout nettoyage paresseux basé sur ce
    // flag (ex. `_mjs_notifyInvalidators` de µspring/µ.interpolate, mjs_spring.ts/
    // mjs_interpolate.ts) quel que soit le chemin de déconnexion.
    this._mjs_dead = true;
    if ((ref = this._mjs_propObserver) != null) {
      ref.disconnect();
    }
    if (this._mjs_is_router_aware) {
      if ((ref1 = µ.Router) != null) {
        if (typeof ref1.unregister === "function") {
          ref1.unregister(this);
        }
      }
    }
    if (this._mjs_attachments) {
      ref2 = this._mjs_attachments;
      for (td of ref2) {
        try { td(); } catch (e) { µ.warn('[ModularJS] @attach/@this teardown en erreur :', e); }
      }
      this._mjs_attachments.clear();
      // les td ci-dessus s'exécutent UNE fois,
      // mais chaque nœud garde son marqueur `_mjs_td`/`_mjs_ref_td` (le Set ne
      // contient que des fonctions, pas les nœuds). Au reconnect (déplacement
      // DOM), le full re-render passe par `attachLogic` qui, voyant le marqueur
      // truthy, RAPPELLE le teardown déjà exécuté (2e fois, sans setup
      // intercalé) → casse un teardown non idempotent (unsubscribe compté,
      // observer.disconnect, socket.close). On NULLE donc les marqueurs (td déjà
      // lancés) en balayant le shadow — uniquement quand des attachments
      // existent, donc coût nul pour les composants sans @attach/@this.
      if (this._shadow && this._shadow.querySelectorAll) {
        const __ann = this._shadow.querySelectorAll('*');
        for (let __ai = 0, __aln = __ann.length; __ai < __aln; __ai++) {
          const __ael = __ann[__ai];
          if (__ael._mjs_td) __ael._mjs_td = null;
          if (__ael._mjs_ref_td) __ael._mjs_ref_td = null;
        }
      }
      if (this._mjs_td) this._mjs_td = null;
      if (this._mjs_ref_td) this._mjs_ref_td = null;
    }
    if (this._mjs_store_unsubs) {
      ref3 = this._mjs_store_unsubs;
      for (unsub of ref3) {
        unsub();
      }
      this._mjs_store_unsubs.clear();
    }
    if (this._mjs_effects) {
      ref4 = this._mjs_effects;
      for (j = 0, len = ref4.length; j < len; j++) {
        e = ref4[j];
        try {
          if (typeof e.cleanup === "function") {
            e.cleanup();
            // Null APRÈS exécution : au reconnect, `_mjs_runEffectsV2` rappelle
            // `e.cleanup()` avant de re-fire l'effet → le teardown tournait
            // DEUX fois (faux pour une désinscription comptée).
            e.cleanup = null;
          }
        } catch (error1) {
          err = error1;
          µ.warn("Cleanup error on unmount:", err);
        }
      }
    }
    // Nettoyage des abonnements universels (µ.state — contextes §§). Garde
    // défensive (même patron que le nettoyage i18n juste en dessous) :
    // `mjs_runes.ts` reste aujourd'hui du cœur, jamais retiré — un composant
    // ne doit pourtant jamais planter à la déconnexion si un cœur futur s'en
    // passait.
    if (typeof µ._mjs_cleanupUniversalDeps === "function") { µ._mjs_cleanupUniversalDeps(this); }
    // Nettoyage des abonnements au store global statisé (`$$`, mjs_store_globals.ts,
    // module OPTIONNEL — appelé pour TOUT composant, même sans `$$`, garde requise) : sans la
    // garde, un projet dont `runtime` explicite omet 'vault' plantait à CHAQUE déconnexion.
    if (typeof µ._mjs_storeUnsubscribe === "function") { µ._mjs_storeUnsubscribe(this); }
    // Nettoyage du registre i18n (mjs_i18n.ts, module OPTIONNEL).
    if (µ.i18n && this._mjs_i18n) { µ.i18n._mjs_unmount(this); }
    if (typeof this._mjs_hooks?.sleep === "function") {
      this._mjs_hooks.sleep.call(this);
    }
    // file `_mjs_sleep_cbs` — symétrique de `_mjs_awake_cbs`, jamais vidée, et
    // gardée côté SERVEUR comme elle : ce que suspend une rune n'existe qu'au
    // navigateur (le hook `µsleep` juste au-dessus n'a pas cette garde, par
    // héritage — on ne la reprend pas ici)
    if (this._mjs_sleep_cbs && !µ._isServer) {
      const __sc = this._mjs_sleep_cbs;
      for (let i = 0, n = __sc.length; i < n; i++) __sc[i].call(this);
    }
    // ---- Destruction DIFFÉRÉE — fix critique : `onDestroy` (où vivent le
    // hook utilisateur `@destroy` et les callbacks `_mjs_onDestroy`) n'était
    // JAMAIS invoqué par le runtime. Un déplacement DOM synchrone
    // (réordonnancement de liste, appendChild ailleurs) déclenche
    // disconnect+connect dans le même tick → on ne détruit qu'au microtask
    // suivant, si TOUJOURS déconnecté. Les sous-arbres parqués par le
    // pageCache d'ujs (hibernation, réinsérés tels quels) sont exemptés.
    if ((typeof this._mjs_hooks?.destroy === 'function' || this._mjs_destroy_cbs) && !this._mjs_destroy_scheduled) {
      this._mjs_destroy_scheduled = true;
      const __self = this;
      queueMicrotask(() => {
        __self._mjs_destroy_scheduled = false;
        if (__self.isConnected) return;
        // garde défensive (même patron que µ._mjs_cleanupUniversalDeps ci-dessus) :
        // `_mjs_isPageCached` vit dans mjs_init.ts, cœur strict jamais retiré aujourd'hui — rien à
        // rattraper en pratique, mais un composant ne doit jamais planter à sa destruction
        // différée si un cœur futur s'en passait.
        if (typeof µ._mjs_isPageCached === "function" && µ._mjs_isPageCached(__self)) return;
        __self._mjs_runDestroyCallbacks();
      });
    }
  }

  // `_mjs_runDestroyCallbacks` (exécution effective du teardown définitif, appelée
  // par la destruction différée ci-dessus ET par µ._mjs_destroyEvictedTree —
  // mjs_page_cache.ts, appel déjà gardé `typeof` là-bas) vit désormais dans
  // src/runtime/mjs_lifecycle.ts, avec le reste des crochets de cycle de vie.

  // ==========================================
  // ROUTAGE DES ÉVÉNEMENTS
  // ==========================================
  // V2 — routing événementiel sans attributs DOM.
  //
  // Avant : chaque élément avec un handler portait `mjs-id="..."`, et le
  // routeur faisait `e.target.closest('[mjs-id]')` + `getAttribute('mjs-id')`.
  //
  // Maintenant : `this._nodeIds` (WeakMap<Node, id>) est rempli par
  // `_metamorphose` lors du mount. Le routing walk `parentNode` manuellement
  // jusqu'à trouver un node connu dans la WeakMap. Sortie quand on remonte
  // au shadow root.
  _mjs_bindEvents(routes, passive) {
    // Skip IIFE: les arrow fns capturent déjà `evt`/`map` via closure
    // locale du let. Économise N allocs IIFE par composant + 1 frame de stack.
    // Skip `for...in` au profit de Object.keys (V8 spécialise mieux).
    const root = this._shadow;
    const events = Object.keys(routes);
    // Auto-passive : les types listés (touch/wheel sans preventDefault) sont
    // enregistrés `passive` → le navigateur scrolle sans attendre le handler.
    const passiveSet = passive ? new Set(passive) : null;
    for (let __ei = 0, __eln = events.length; __ei < __eln; __ei++) {
      const evt = events[__ei];
      const map = routes[evt];
      const opts = (passiveSet && passiveSet.has(evt))
        ? { capture: true, passive: true }
        : true;
      root.addEventListener(evt, (e) => {
        let t = e.target;
        const __inline = this._mjs_inline;
        while (t && t !== root) {
          // l'id de routing est porté par le nœud (`_mjs_ids`), pas une
          // WeakMap : lecture de prop directe pendant la remontée parentNode.
          const ids = t._mjs_ids;
          if (ids) {
            // Fix collision IDs : un node peut porter plusieurs ids (event +
            // binding loop). On essaie chaque id ; le 1er qui matche `map`
            // gagne (l'ordre d'insertion privilégie l'id d'event en pratique).
            for (let i = 0, len = ids.length; i < len; i++) {
              const slot = map[ids[i]];
              if (slot !== void 0) {
                // Route : `idx` (nombre) = handler simple ; `[idx, flags]` =
                // handler + bitmask (bit 0 `.propagate` — le routeur poursuit
                // sa remontée ; bit 1 `.once`) ; `[[idx, flags], …]` =
                // PLUSIEURS handlers sur le même couple (événement, nœud).
                //
                // Le 3ᵉ cas est le correctif : une liaison
                // two-way et une directive `@événement` qui reposent sur le
                // même événement du même élément (`<input value=!{$x}
                // @input={…}>`) partagent un id de routage — l'une écrasait
                // l'autre EN SILENCE côté compilateur. Elles s'exécutent
                // maintenant TOUTES, dans l'ordre émis : liaisons d'abord,
                // pour que la directive lise la variable déjà à jour.
                const list = (typeof slot === 'number' || typeof slot[0] === 'number') ? null : slot;
                const nh = list ? list.length : 1;
                let ran = false, propagate = false;
                for (let k = 0; k < nh; k++) {
                  const one = list ? list[k] : slot;
                  let fnIdx, once = false;
                  if (typeof one === 'number') {
                    fnIdx = one;
                  } else {
                    fnIdx = one[0];
                    const fl = one[1] | 0;
                    if ((fl & 1) !== 0) propagate = true;
                    once = (fl & 2) !== 0;
                  }
                  const fnWrapper = __inline[fnIdx];
                  if (typeof fnWrapper !== 'function') continue;
                  // `.once` PAR NŒUD (sémantique `{ once: true }` native) :
                  // l'ancien `delete map[id]` supprimait la route par id
                  // COMPILE-TIME, partagé par toutes les rows d'un {for} → le
                  // premier clic sur n'importe quelle row désarmait toutes les
                  // autres (et les futures). WeakMap<nœud, Set<clé>> : le nœud
                  // mort libère son entrée. Clé par handler quand le couple en
                  // porte plusieurs — un `.once` ne désarme pas son voisin.
                  if (once) {
                    const onceKey = list ? ids[i] + '#' + k : ids[i];
                    if (!this._mjs_once_fired) this._mjs_once_fired = new WeakMap();
                    let __fired = this._mjs_once_fired.get(t);
                    if (__fired && __fired.has(onceKey)) continue;
                    if (!__fired) { __fired = new Set(); this._mjs_once_fired.set(t, __fired); }
                    __fired.add(onceKey);
                  }
                  // Expose l'élément matché via `e.currentTarget` (sémantique
                  // DOM standard / parité Svelte-React) — sinon `e.currentTarget`
                  // = le shadow root (le listener délégué est posé dessus) →
                  // `e.currentTarget.getBoundingClientRect()` échoue. Le 2e arg
                  // `t` reste aussi disponible. Cas vécu : seek slider audio-player.
                  try { Object.defineProperty(e, 'currentTarget', { value: t, configurable: true }); } catch (_err) { /* event read-only */ }
                  const result = fnWrapper.call(this, e, t);
                  if (typeof result === 'function') {
                    result.call(this, e, t);
                  }
                  // Restaure le getter natif de currentTarget — même obligation
                  // que dans _mjs_on : l'event POURSUIT sa propagation et un
                  // listener tiers en aval lisait notre valeur figée.
                  try { delete e.currentTarget; } catch (_e2) { /* read-only */ }
                  ran = true;
                }
                // Aucun handler exécutable sous cet id → on tente l'id suivant.
                if (!ran) continue;
                // `.stop` (e.stopPropagation) pose `cancelBubble` → on coupe
                // la remontée du routeur, y compris après un `.propagate`.
                // Vérifié APRÈS la liste : `stopPropagation` n'a jamais coupé
                // les autres listeners du MÊME nœud (c'est le rôle de
                // `stopImmediatePropagation`), on reste sur la sémantique DOM.
                if (e.cancelBubble) return;
                // Handler normal : le nœud le plus proche gagne → on s'arrête.
                if (!propagate) return;
                // `.propagate` : on sort des ids de CE nœud et on laisse le
                // `while` remonter vers l'ancêtre suivant.
                break;
              }
            }
          }
          t = t.parentNode;
          // Si parentNode traverse une frontière ShadowRoot, on s'arrête.
          if (t && t.nodeType === 11) break;
        }
      }, opts);
    }
  }

  // ==========================================
  // GESTION OPTIMISÉE DES STYLES
  // ==========================================
  // Renommée `_applyTemplate` → `_mjs_applyLayout` : ce mécanisme n'a jamais posé
  // de gabarit, il charge une feuille de style — un variant de FORME
  // (grille, ordre, masquage), jamais de couleurs (variables `$$` d'un `<theme>`).
  async _mjs_applyLayout(name = 'default') {
    var cssAttr, j, l, len, len1, len2, m, node, ref, ref1, sheet, sheetName, sheets;
    sheets = [];
    // un fetch de variant lent ne doit pas écraser une bascule demandée APRÈS lui
    const _seq = (this._mjs_layoutSeq = (this._mjs_layoutSeq || 0) + 1);
    if (µ._mjs_shield) {
      // Shield FOUC : la même instance µ._mjs_shield est adoptée dans chaque
      // Shadow DOM pour que ses règles (`:not(:defined)` + `[mjs-loading]`)
      // atteignent les modules imbriqués — les règles du document ne
      // traversent pas les frontières Shadow DOM.
      sheets.push(µ._mjs_shield);
    }
    if (µ.CSS['mjs_reset']) {
      sheets.push(µ.CSS['mjs_reset']);
    }
    // THÈMES DE DOCUMENT dans un shadow (mesuré au navigateur) — une feuille du
    // DOCUMENT ne franchit pas la frontière shadow : seules les valeurs HÉRITÉES la traversent.
    // Sans les deux lignes ci-dessous, un `<div theme="sombre">` écrit DANS un composant ne
    // matchait AUCUNE règle — et comme une appli MJS n'est faite que de composants, « poser un
    // thème sur une section » ne marchait en pratique que dans le HTML de la page. Les deux
    // feuilles sont des instances PARTAGÉES (jamais recopiées) : le coût est une entrée de plus
    // dans adoptedStyleSheets. Elles passent AVANT le style du composant, qui garde le dernier
    // mot chez lui ; sur l'hôte lui-même rien ne change, la règle du document continue de primer
    // sur une règle de shadow (critère d'encapsulation, mesuré au navigateur).
    if (µ._mjs_themeSheet) {
      sheets.push(µ._mjs_themeSheet);
    }
    if (µ._mjs_themeAppSheet) {
      sheets.push(µ._mjs_themeAppSheet);
    }
    // Héritage CSS depuis <@view css="..."> : on remonte l'arbre en franchissant
    // les frontières Shadow DOM (via root.host), et on accumule toutes les feuilles
    // de chaque <metamjs-view css="..."> ancêtre. Ça permet qu'un composant imbriqué
    // (enfant d'un composant injecté dans la view) hérite aussi du thème de la view.
    var inheritedNames = [];
    node = this.parentNode;
    while (node) {
      if (node.nodeType === 11) { // DocumentFragment / ShadowRoot → on saute à l'hôte
        node = node.host;
        continue;
      }
      if (node.tagName === 'METAMJS-VIEW') {
        cssAttr = node.getAttribute('css');
        if (cssAttr) {
          ref = cssAttr.split(/\s+/);
          for (j = 0, len = ref.length; j < len; j++) {
            sheetName = ref[j];
            if (sheetName) {
              inheritedNames.push(sheetName);
            }
          }
        }
      }
      node = node.parentNode;
    }
    // Mode `css: 'lazy'` : les feuilles partagées ne sont pas dans le
    // bundle, ce sont des `.css` hachés dont l'URL vit au manifeste. `µ._mjs_lazyCssWait`
    // (mjs_lazy_css.ts, joint seulement dans ce mode) rend la promesse des feuilles encore
    // absentes, ou `null` : on les attend AVANT d'adopter quoi que ce soit, pour que la
    // cascade reste celle de toujours (feuilles héritées, puis déclarées, puis le style du
    // composant, qui garde le dernier mot). Le composant est caché pendant ce temps par
    // `[mjs-loading]`, posé au connectedCallback et retenu par `_mjs_cssPending` : il
    // apparaît habillé, jamais nu. Hors 'lazy', la fonction n'existe pas : le bloc coûte un
    // test et rien d'autre, sans le moindre `await`.
    var __lw = µ._mjs_lazyCssWait && µ._mjs_lazyCssWait(this, inheritedNames);
    if (__lw) {
      this._mjs_cssPending = __lw;
      await __lw;
      this._mjs_cssPending = null;
      // même garde de fraîcheur que le variant plus bas : une bascule demandée
      // PENDANT le chargement doit gagner
      if (_seq !== this._mjs_layoutSeq) { return; }
    }
    for (l = 0, len1 = inheritedNames.length; l < len1; l++) {
      sheetName = inheritedNames[l];
      // Les feuilles extérieures sont poussées en premier pour que les styles locaux
      // du composant puissent les surcharger.
      if (µ.CSS[sheetName]) {
        sheets.push(µ.CSS[sheetName]);
      } else if (!(µ._cssLazy && µ._cssLazy[sheetName])) {
        // une feuille CONNUE du mode paresseux n'est pas orpheline : elle est
        // simplement différée (et absente au rendu serveur, par construction) —
        // c'est `µ._mjs_fetchLazyCss` qui parle quand son fichier manque vraiment
        µ.warn(`[ModularJS] Orphelin CSS hérité : La feuille '${sheetName}' est absente du registre.`);
      }
    }
    if (this._mjs_sharedCss) {
      ref1 = this._mjs_sharedCss;
      for (m = 0, len2 = ref1.length; m < len2; m++) {
        sheetName = ref1[m];
        if (µ.CSS[sheetName]) {
          sheets.push(µ.CSS[sheetName]);
        } else if (!(µ._cssLazy && µ._cssLazy[sheetName])) {
          // cf. le jumeau ci-dessus : différée n'est pas orpheline
          µ.warn(`[ModularJS] Orphelin CSS local : La feuille '${sheetName}' est introuvable.`);
        }
      }
    }
    if (this._mjs_baseCss && this._mjs_baseCss.trim() !== "") {
      if (µ._mjs_componentStyleCache == null) {
        µ._mjs_componentStyleCache = new Map();
      }
      if (!µ._mjs_componentStyleCache.has(this._mjs_baseCss)) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(this._mjs_baseCss);
        µ._mjs_componentStyleCache.set(this._mjs_baseCss, sheet);
      }
      sheets.push(µ._mjs_componentStyleCache.get(this._mjs_baseCss));
      // Index PAR TAG de la feuille adoptée (rechargement CSS à chaud en dev,
      // cf. µ._hotCss dans mjs_hotcss.ts) — s'AJOUTE au cache par texte
      // ci-dessus sans le modifier (zéro régression prod, byte-safe).
      if (µ._mjs_componentStyleByTag == null) {
        µ._mjs_componentStyleByTag = new Map();
      }
      µ._mjs_componentStyleByTag.set(this.tagName.toLowerCase(), µ._mjs_componentStyleCache.get(this._mjs_baseCss));
    }
    // Mode `mjs-light` : HTMLElement n'a pas `adoptedStyleSheets`. On émet le
    // CSS du composant comme un <style> inline injecté dans le head global
    // (avec déduplication via cache). Le CSS hérité (Bootstrap, vars CSS,
    // thèmes) marche déjà via cascade naturelle, on n'a qu'à injecter le
    // baseCss du composant lui-même.
    if (this._mjs_isLight) {
      // Garde-fou — un light IMBRIQUÉ vit DANS le vrai shadow d'un ancêtre :
      // document.head ne franchit JAMAIS cette frontière (encapsulation Shadow DOM), la feuille
      // doit rejoindre CE shadow-là. Même idiome que le reste du fichier (`getRootNode().host`)
      // pour détecter le shadow hôte ; racine (hors de tout shadow réel, `.host` absent) : repli
      // document.head INCHANGÉ (bloc jumeau plus bas, condition étendue mais corps byte-identique).
      var lightRoot = this.getRootNode ? this.getRootNode() : null;
      if (this._mjs_baseCss && this._mjs_baseCss.trim() !== "" && lightRoot && lightRoot.host) {
        // ATTENTION — un light n'a JAMAIS de piste d'adoption SSR (docs/19-ssr.md : « hydrateScript
        // reste vide pour ce mode, quel que soit ssrMode ») : il RECONSTRUIT systématiquement son
        // contenu à la connexion, y compris quand c'est l'HÔTE (ancêtre à shadow réel) qui vide puis
        // reconstruit LE SIEN (mesuré : `replaceChildren` + `adoptedStyleSheets = sheets` de l'hôte
        // ÉCRASENT tout ce qu'une instance PRÉCÉDENTE de ce même tag avait posé). Un marqueur qui ne
        // fait que « j'ai déjà pose » resterait vrai après cet écrasement et bloquerait la repose de
        // l'instance qui SURVIT — la garde vérifie donc la présence RÉELLE, à chaque connexion.
        var nestedTag = this.tagName.toLowerCase();
        // `:host` réécrit en `nestedTag` AVANT adoption/injection : le document (ou le
        // shadow de l'ancêtre) n'a pas de host réel, `:host` n'y matcherait rien
        var nestedCss = µ._lightHostCss(this._mjs_baseCss, nestedTag);
        if (µ._csp) {
          if (lightRoot._mjs_mjsLightSheets == null) {
            lightRoot._mjs_mjsLightSheets = new Map();
          }
          var knownSheet = lightRoot._mjs_mjsLightSheets.get(nestedTag);
          if (!knownSheet || lightRoot.adoptedStyleSheets.indexOf(knownSheet) === -1) {
            var nestedLightSheet = new CSSStyleSheet();
            nestedLightSheet.replaceSync(nestedCss);
            lightRoot.adoptedStyleSheets = [...lightRoot.adoptedStyleSheets, nestedLightSheet];
            lightRoot._mjs_mjsLightSheets.set(nestedTag, nestedLightSheet);
            // seule table qui retient cette feuille CSP pour µ._hotCss : pas de
            // <style data-mjs-css> sous CSP, et µ._mjs_componentStyleByTag (chemin ombre) ne la voit pas
            if (µ._mjs_lightSheetsByTag == null) {
              µ._mjs_lightSheetsByTag = new Map();
            }
            if (!µ._mjs_lightSheetsByTag.has(nestedTag)) {
              µ._mjs_lightSheetsByTag.set(nestedTag, []);
            }
            µ._mjs_lightSheetsByTag.get(nestedTag).push({ sheet: nestedLightSheet, text: nestedCss });
          }
        } else if (!lightRoot.querySelector('style[data-mjs-light="' + nestedTag + '"]')) {
          var nestedLightStyleEl = document.createElement('style');
          nestedLightStyleEl.setAttribute('data-mjs-light', nestedTag);
          nestedLightStyleEl.setAttribute('data-mjs-css', nestedTag);
          nestedLightStyleEl.textContent = nestedCss;
          lightRoot.appendChild(nestedLightStyleEl);
        }
      }
      if (this._mjs_baseCss && this._mjs_baseCss.trim() !== "" && !(lightRoot && lightRoot.host)) {
        if (µ._mjs_lightStyleInjected == null) {
          µ._mjs_lightStyleInjected = new Set();
        }
        // idem : réécrit AVANT le test de déduplication (donc SUR le texte réécrit) —
        // deux composants au CSS source identique mais balises différentes ont un texte réécrit
        // différent (leur nom y est imprimé) et donnent chacun leur PROPRE feuille, à raison
        var docCss = µ._lightHostCss(this._mjs_baseCss, this.tagName.toLowerCase());
        if (!µ._mjs_lightStyleInjected.has(docCss)) {
          if (µ._csp) {
            var lightStyleSheet = new CSSStyleSheet();
            lightStyleSheet.replaceSync(docCss);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, lightStyleSheet];
            // idem imbriqué ci-dessus : seule table qui retient cette feuille pour µ._hotCss
            if (µ._mjs_lightSheetsByTag == null) {
              µ._mjs_lightSheetsByTag = new Map();
            }
            if (!µ._mjs_lightSheetsByTag.has(this.tagName.toLowerCase())) {
              µ._mjs_lightSheetsByTag.set(this.tagName.toLowerCase(), []);
            }
            µ._mjs_lightSheetsByTag.get(this.tagName.toLowerCase()).push({ sheet: lightStyleSheet, text: docCss });
          } else {
            var lightStyleEl = document.createElement('style');
            lightStyleEl.setAttribute('data-mjs-light', this.tagName.toLowerCase());
            // marqueur pour le rechargement CSS à chaud en dev (µ._hotCss :
            // remplacement du textContent par tag) — distinct de data-mjs-light
            // (inchangé) pour ne rien casser chez qui le cible déjà
            lightStyleEl.setAttribute('data-mjs-css', this.tagName.toLowerCase());
            lightStyleEl.textContent = docCss;
            document.head.appendChild(lightStyleEl);
          }
          µ._mjs_lightStyleInjected.add(docCss);
        }
      }
    } else {
      this._shadow.adoptedStyleSheets = sheets;
    }
    if (name === 'default') {
      return;
    }
    // Variant NOMMÉ demandé : la queue (empreinte, requête réseau, mode light,
    // adoption finale) vit désormais dans src/runtime/mjs_layout_variant.ts — patch de
    // `µ.Element.prototype` DÉTECTÉ au build (`<style name="…">`, cf. son en-tête). `sheets`/`_seq`
    // transmis tels quels : comportement BYTE-IDENTIQUE à l'ancien corps unique.
    if (typeof this._mjs_applyLayoutVariant === 'function') {
      return this._mjs_applyLayoutVariant(name, sheets, _seq);
    }
    // Filet défensif (atteint seulement si aucun variant n'est déclaré ni déposé, cf. l'en-tête
    // du fichier ci-dessus) : on garde silencieusement les feuilles déjà adoptées au-dessus,
    // même repli que les autres gardes défensives de cette classe (ex. _mjs_isPageCached).
  }

  // Point de montage unique du contenu initial (appelé par le constructor
  // généré). Centralise la bascule entre « créer + appendre » (défaut /
  // historique) et l'ADOPTION des nœuds rendus par le serveur (hydratation SSR).
  // `factory()` retourne {fragment, refs}.
  _mjs_mount(factory) {
    // Hydratation SSR : si le mode est activé (µ._mjs_ssrHydrate) ET qu'un DSD
    // serveur est présent (_mjs_ssrAdopt), on tente d'adopter les nœuds
    // existants au lieu de les recréer. Tout échec retombe silencieusement sur
    // la création normale → jamais de page cassée.
    if (this._mjs_ssrAdopt && µ._mjs_ssrHydrate) {
      if (typeof this._mjs_hydrate === 'function') {
        try {
          if (this._mjs_hydrate(factory)) {
            return;
          }
        } catch (_e) {
          // fallback : création normale ci-dessous
        }
      }
      // Les trois approches d'adoption vivent dans mjs_hydrate.ts, joint selon le bloc
      // `render` du projet (cf. son en-tête) : la PAGE peut demander l'hydratation à un cœur
      // qui ne les embarque pas (serveur qui rend par l'API, mode posé par en-tête HTTP). Rien
      // n'est cassé — la vue est reconstruite juste en dessous, à l'identique — mais le gain
      // attendu n'a pas lieu : on le dit UNE fois, pas une par composant.
      else if (!µ._mjs_hydrateWarned) {
        µ._mjs_hydrateWarned = true;
        µ.warn("[ModularJS] hydratation demandée par la page mais absente du cœur : mode ssr:markers/positional/diff dans render, ou runtime: ['hydrate'].");
      }
      // Hydratation échouée / non applicable / absente : on jette la « photo » serveur
      // (non vidée en mode hydratation, cf. constructor) avant de reconstruire,
      // sinon la vue neuve s'ajouterait en doublon.
      if (this._shadow && this._shadow.replaceChildren) {
        this._shadow.replaceChildren();
      }
    }
    const built = factory();
    this._mjs_nodes = built.refs;
    this._mjs_registerRefs(built.refs);
    if (this._mjs_isLight) {
      // Spec Custom Elements : `document.createElement(tag)` avec le tag DÉJÀ
      // DÉFINI exige que le constructeur ne pose ni enfant ni attribut sur
      // l'élément lui-même (sinon NotSupportedError, « The result must not
      // have children », levée par le navigateur À LA SORTIE du constructeur
      // — silencieuse pour l'appelant, elle avorte toute la construction du
      // parent). En mode léger (`_shadow === this`), `appendChild` ICI viole
      // cette règle dès que ce composant est construit avec un tag déjà
      // connu (un enfant `@lightDom` recréé une fois son module
      // chargé). Un vrai Shadow DOM n'est jamais concerné : il vise le
      // Shadow Root, jamais l'élément lui-même. On diffère l'insertion à
      // `connectedCallback`, qui n'a pas cette contrainte (elle ne s'applique
      // qu'au retour du constructeur, jamais après).
      this._mjs_pendingLightFragment = built.fragment;
    } else {
      this._shadow.appendChild(built.fragment);
    }
  }

  // _mjs_registerRefs : enregistre les refs (sortie de __create_X) dans
  // _nodeIds pour le routing événementiel. Les text nodes (placeholders) ne
  // sont pas indexés ; seuls les Elements le sont (events ne bubble pas
  // depuis un text node).
  //
  // V1 utilisait _metamorphose qui walk un DOM cloné. Ce walk est
  // supprimé : les refs sont déjà des pointeurs JS directs.
  _mjs_registerRefs(refs) {
    if (!refs) return;
    // Object.keys + for est ~1.5-2× plus rapide que `for...in` sur V8
    // (pas d'enumeration prototype chain, pas de hidden-class iterator).
    // Sur create 1k items × ~6 refs par item, économie cumulée.
    const __keys = Object.keys(refs);
    const __klen = __keys.length;
    // Optim #7 — Skip les ids sans event listener. La classe expose
    // `_mjs_evt_ids` (Set<string>) au compile-time, calculée à partir de
    // `state.events`. Si absente (modules sans event), on enregistre tout
    // (compat). Si présente, on ne tag que les ids présents.
    const __evtIds = this.constructor._mjs_evt_ids;
    for (let __i = 0; __i < __klen; __i++) {
      const id = __keys[__i];
      if (__evtIds && !__evtIds.has(id)) continue;
      const n = refs[id];
      if (!n || n.nodeType !== 1 /* ELEMENT_NODE */) continue;
      // l'id de routing est posé en PROP sur le nœud (`_mjs_ids`), pas
      // dans une WeakMap par instance. Fix collision IDs préservé : un même
      // node peut porter plusieurs ids (@click + mjs-l-id dans un {for}).
      const existing = n._mjs_ids;
      if (existing) {
        if (!existing.includes(id)) existing.push(id);
      } else {
        n._mjs_ids = [id];
      }
    }
  }

  // `_mjs_injectSlots` (slots indexés `<@slot {i}/>`) : mjs_slots.ts, joint seulement si le code
  // compilé l'appelle (constructeur d'un composant qui écrit `<@slot`).

  // ==========================================
  // _mjs_invalidate — dispatch direct V2 par varName.
  // ==========================================
  // Au lieu d'un `render(dirty)` monolithique qui balaye `if (dirty & MASK)`
  // pour tous les effects, on lit `_mjs_effectsByVar[k]` et n'exécute QUE les
  // effects abonnés à la var muée.
  //
  // Mount initial (`_mjs_invalidate('_awaits_')`) → fire tous les `_mjs_effectsAll`
  // + `_mjs_renderStruct`.
  //
  // Async fire (promise resolved dans un `{await}`) → idem, full render via
  // `_awaits_` car on ne sait pas quel effect est concerné.
  //
  // Coalescence : pending Set + microtask. Plusieurs mutations dans le même
  // frame fusionnent leurs effects ; le render struct ne tourne qu'une fois.
  // index par-donnée des µ.effect user (l'équivalent des « reactions »
  // de Svelte : `mark_reactions` retourne tout de suite si rien ne lit la donnée).
  // Avant : `_mjs_invalidate` désarmait son ultra-fast-path dès qu'un composant avait
  // UN µeffect → chemin lent (alloc Set + scan) pour TOUTES ses vars. Ici on calcule
  // UNE fois l'union des `staticVars` de tous les effects : une mutation d'une var
  // qu'AUCUN effect ne lit peut court-circuiter, même si d'autres vars ont des effects.
  // SÛRETÉ (comportement préservé) : si un effect a des `staticVars` VIDES (il « fire
  // toujours » — store universel/computed non vu au scan, cf. _mjs_runEffectsV2 ~1771), on
  // DÉSACTIVE l'opti pour ce composant (sentinelle `null` → toujours vrai).
  _mjs_varHasUserEffect(k) {
    const eff = this._mjs_effects;
    if (!eff || eff.length === 0) return false;
    let idx = this._mjs_userEffectVars;
    if (idx === undefined) {
      idx = new Set();
      for (let i = 0; i < eff.length; i++) {
        const sv = eff[i].staticVars;
        if (!sv || sv.length === 0) { idx = null; break; }
        for (let j = 0; j < sv.length; j++) idx.add(sv[j]);
      }
      this._mjs_userEffectVars = idx;
    }
    return idx === null ? true : idx.has(k);
  }

  _mjs_invalidate(k) {
    if (this._mjs_has_crashed) return;
    // #7 — `_awaits_` = notification externe (store universel, await, mount) :
    // une source lue par un computed (contexte, store partagé) a pu changer
    // sans que ce computed soit abonné par varName. On invalide leur cache pour
    // forcer la ré-évaluation au prochain accès — sinon un derived sur store /
    // contexte sert une valeur périmée. Coût négligeable : `_awaits_` est rare,
    // et au mount les computeds sont déjà `_mjs_dirty`.
    //
    // STATISATION — même trou pour les clés store (`$$clé`/`$$*`) : le
    // store statisé (mjs_store_globals.ts) appelle `comp._mjs_invalidate('$$'+key)`
    // DIRECTEMENT (pas de passage par `_mjs_notifyMutation`, réservé aux mutations
    // LOCALES), donc le marquage dirty des computeds ci-dessous ne se
    // déclenchait jamais pour un `$X = $$y*2` — le getter `_state.X` servait la
    // valeur `_mjs_cached` périmée indéfiniment après une écriture `$$y = …`.
    if ((k === '_awaits_' || (k.charCodeAt(0) === 36 && k.charCodeAt(1) === 36)) && this._mjs_computedKeys) {
      const __ck = this._mjs_computedKeys, __cs = this._mjs_computeds;
      for (let __ci = 0, __cn = __ck.length; __ci < __cn; __ci++) {
        const __c = __cs[__ck[__ci]];
        if (__c) __c._mjs_dirty = true;
      }
    }
    // GEL i18n en mode 'wait' — tant que le fragment n'est pas là, on ne peint
    // RIEN : le rendu COMPLET déclenché à la levée du gel rattrape tout ce qui a
    // été muté entre-temps. Posé dans `connectedCallback`, levé à la résolution
    // (qui aboutit TOUJOURS, échec réseau compris).
    if (this._mjs_i18n_hold) { this._mjs_pending_full = true; return; }
    // Optim #B-bis — Ultra fast-path no-op : si la var muée n'a strictement
    // RIEN à fire (pas d'effects ciblés, pas de struct, pas d'effects user, pas
    // d'_awaits_), on évite alloc Set + queueMicrotask + le bloc batch entier.
    // Sans ça, chaque µ._set(this, 'pureDataVar', x) schedule un microtask qui
    // ne fait rien — overhead massif sur run1k (1000 rows × invalidate).
    if (
      k !== '_awaits_' &&
      !this._mjs_render_scheduled &&
      this._mjs_is_mounted &&
      !this._mjs_varHasUserEffect(k) &&
      (!this._mjs_effectsByVar || !this._mjs_effectsByVar[k]) &&
      (!this._mjs_renderStructVars || this._mjs_renderStructVars[k] !== 1)
    ) {
      return;
    }
    // Fast path sync direct étendu.
    //
    // Au lieu de `length === 1` uniquement, on autorise N effects ciblés.
    // Le coût d'un loop court (<=4 fns) est inférieur au coût d'un queueMicrotask
    // + Set allocation + iteration. Gain mesuré sur update10thRow.
    //
    // Conditions strictes pour rester safe :
    //   - k !== '_awaits_' (full render reste async)
    //   - !this._mjs_render_scheduled (pas de batch en cours)
    //   - !µ._mjs_inEffect (pas dans une exécution d'effect — évite cascade sync)
    //   - this._mjs_is_mounted (le mount initial reste async)
    //   - _mjs_effectsByVar[k] existe et n'est pas vide
    //   - µ.effect user présent : routé vers une microtask coalescée (cf.
    //     ligne ~1876) — pas d'exécution sync ici, N écritures même
    //     tick = UN seul run sur l'état final
    //
    // Skip µ.activeComponent setter/getter Proxy : ces updates ciblés
    // sont des _mjs_updText/_mjs_updAttr simples qui ne touchent pas aux stores
    // universels. Pas besoin de tracker l'activeComponent.
    if (
      k !== '_awaits_' &&
      !this._mjs_render_scheduled &&
      !µ._mjs_inEffect &&
      this._mjs_is_mounted &&
      this._mjs_effectsByVar
    ) {
      const __list = this._mjs_effectsByVar[k];
      const __hasUserEffects = this._mjs_effects && this._mjs_effects.length > 0;
      // Fast-path ultra-court : si pas d'effects user, pas de _mjs_renderStruct
      // non plus à fire (rare mais possible), on inline le minimum.
      if (__list && __list.length > 0) {
        µ._mjs_inEffect = true;
        try {
          // ORDRE CRITIQUE : struct AVANT effects. Mêmes raisons que dans la
          // microtask normale (cf. ligne 1143+). Si la var muée pilote un bloc
          // struct ({if}/{for}/{key}/{await}), celui-ci doit re-render
          // d'abord : il peut détruire l'ancien node et créer un fresh node
          // (avec une NOUVELLE ref dans this._mjs_nodes.X). Si on tirait les
          // effects D'ABORD, ils muteraient l'ANCIEN node (jeté après) et le
          // FRESH node créé par struct resterait vide. Cas vécu : tuto
          // `blocs-key` où `_mjs_updText('t3', ...)` doit muter le NEW t3 créé
          // par `_mjs_updKey`, pas l'ancien.
          // Skip _mjs_renderStruct si la var muée ne pilote AUCUN bloc
          // structurel (compile-time info dans _mjs_renderStructVars). Gain massif
          // sur select1k : `$selected` ne pilote pas l'iterable du `{for}`,
          // donc inutile de re-balayer _mjs_updFor + _mjs_reconcileList × 1000 rows.
          const __rsv = this._mjs_renderStructVars;
          // `_awaits_` est la clé spéciale émise par `_mjs_updAwait` quand une
          // promesse `{await}` résout (success/error) : `_mjs_renderStruct` DOIT
          // tourner pour rendre la nouvelle branche, même si `_awaits_` n'est
          // pas dans `_mjs_renderStructVars` (qui ne liste que les vars user).
          const __needsStruct = k === '_awaits_' || (__rsv != null && __rsv[k] === 1);
          // Optim #3 — Guard de dedup : si déjà dispatché dans ce tick,
          // skip le re-render struct (le 1er fire a déjà tout reconcilé).
          // Reset du flag programmé via queueMicrotask au 1er fire.
          if (__needsStruct && this._mjs_renderStruct) {
            if (!this._mjs_struct_dispatched_in_tick) {
              this._mjs_struct_dispatched_in_tick = true;
              const __self = this;
              queueMicrotask(() => { __self._mjs_struct_dispatched_in_tick = false; });
              try { this._mjs_safeRenderStruct(); } catch (err) {
                this._mjs_catchError(err);
                return;
              }
            } else if (!this._mjs_pending_struct_dirty) {
              // 2e mutation de la même var struct DANS LE MÊME TICK sync
              // (`$items.push(a); $items.push(b)`) : le garde a déjà rendu
              // l'état d'après la 1re — sans ce rattrapage, le DOM restait
              // figé dessus. On replanifie en microtask (_mjs_renderStruct est
              // idempotent : au pire un passage redondant).
              this._mjs_pending_struct_dirty = true;
              const __self = this;
              queueMicrotask(() => {
                if (!__self._mjs_pending_struct_dirty) return;
                __self._mjs_pending_struct_dirty = false;
                if (__self._mjs_has_crashed || !__self._mjs_is_mounted) return;
                try { __self._mjs_safeRenderStruct(); } catch (err) { __self._mjs_catchError(err); }
              });
            }
          }
          // Inline le loop d'effects (court typiquement 1-3).
          // Skip `typeof === 'function'` (10-15ns) → truthy check direct.
          // `_mjs_renderStruct` est soit une function (assignée par template), soit undef.
          // Idem `_mjs_catchError` (méthode prototype, toujours présente).
          for (let __i = 0, __ln = __list.length; __i < __ln; __i++) {
            try { __list[__i].call(this); } catch (err) {
              this._mjs_catchError(err);
              return;
            }
          }
          // µ.effect utilisateurs : intersection staticVars avec {k}.
          // skip l'alloc Set + le scan `_mjs_runEffectsV2` si AUCUN effect
          // ne lit `k` (même si le composant a des effects sur d'AUTRES vars).
          // coalescence des µeffect user : le fast-path ne les
          // exécute plus en sync à CHAQUE écriture (N écritures même tick = N runs
          // sur états intermédiaires) ; on accumule les vars muées et on exécute
          // UNE passe en microtask, sur l'état final — aligné sur l'intention
          // documentée en tête de fast-path et sur la sémantique du chemin batch.
          if (__hasUserEffects && this._mjs_varHasUserEffect(k)) {
            let __ue = this._mjs_ue_pending;
            if (__ue) {
              __ue.add(k);
            }
            else {
              __ue = this._mjs_ue_pending = new Set();
              __ue.add(k);
              queueMicrotask(() => {
                const __vars = this._mjs_ue_pending;
                this._mjs_ue_pending = null;
                if (!__vars || this._mjs_has_crashed || !this._mjs_is_mounted) return;
                // un batch complet est déjà planifié : il exécutera _mjs_runEffectsV2
                // lui-même — on fusionne nos vars dans son set et on s'efface
                if (this._mjs_render_scheduled) {
                  if (this._mjs_lastMutedVars) { for (const __v of __vars) this._mjs_lastMutedVars.add(__v); }
                  else this._mjs_lastMutedVars = __vars;
                  return;
                }
                const __prevMuted = this._mjs_lastMutedVars;
                this._mjs_lastMutedVars = __vars;
                µ._mjs_inEffect = true;
                try {
                  this._mjs_runEffectsV2(undefined, false);
                } finally {
                  µ._mjs_inEffect = false;
                  // un batch imbriqué (écriture faite PAR un effet pendant la passe)
                  // a pu installer un Set NEUF de vars muées : ne jamais l'écraser —
                  // on restaure l'ancien seulement si rien de neuf n'a été posé,
                  // sinon on fusionne l'ancien dedans
                  const __cur = this._mjs_lastMutedVars;
                  if (__cur == null || __cur === __vars) this._mjs_lastMutedVars = __prevMuted;
                  else if (__prevMuted) { for (const __v of __prevMuted) __cur.add(__v); }
                }
              });
            }
          }
          if (this._mjs_pendingMount) {
            this._mjs_pendingMount = false;
            // SSR : hooks client — pas d'exécution côté serveur (cf. µ._isServer).
            this._mjs_fireMount();
          }
        } finally {
          µ._mjs_inEffect = false;
        }
        return;
      }
    }
    if (!this._mjs_render_scheduled) {
      // Pas de réutilisation Set : on alloue une Set neuve à chaque batch
      // car le pending est lu par le microtask consumer (avant le clear).
      // Le coût de `new Set()` est ~10ns, négligeable vs le travail du batch.
      this._mjs_pending = new Set();
      this._mjs_pending_full = false;
      // Skip alloc _mjs_lastMutedVars si pas d'effects user (_mjs_runEffectsV2
      // lit ce set, mais retourne tôt si this._mjs_effects est vide). Économise
      // 1 alloc Set par batch. Sur update10thRow × 16, gain mesurable.
      if (this._mjs_effects && this._mjs_effects.length > 0) {
        this._mjs_lastMutedVars = new Set();
      } else {
        this._mjs_lastMutedVars = null;
      }
      this._mjs_render_scheduled = true;
      queueMicrotask(() => {
        this._mjs_render_scheduled = false;
        if (this._mjs_has_crashed) return;
        // GEL i18n 'wait' — un batch PROGRAMMÉ AVANT la pose du gel arriverait
        // ici quand même : vider `_mjs_pending_full`/`_mjs_pending` dans
        // `connectedCallback` ne suffisait pas, `_mjs_pending_struct_dirty` (posé
        // par les écritures d'état du setup) relançait tout de même le rendu
        // structurel ET les effets — d'où le flash de placeholders mesuré
        // malgré l'annulation. On sort ici : la levée du gel invalide en
        // `_awaits_` et reprogramme un rendu COMPLET.
        if (this._mjs_i18n_hold) { this._mjs_pending_full = true; return; }
        // Garde anti-boucle réactive. Une boucle d'effets (un effet qui
        // mute sa propre dépendance) s'exprime ici en chaîne INFINIE de
        // microtasks : le navigateur ne reprend jamais la main → onglet gelé
        // sans même un avertissement. On compte les flushs par RAFALE de
        // microtasks ; le compteur est remis à zéro par une macrotask
        // (setTimeout 0), qui ne s'exécute QUE si la chaîne s'arrête. Seuil
        // volontairement large (10 000, façon Solid) : aucune cascade légitime
        // ne l'atteint, seule une boucle le peut. Au-delà : un avertissement
        // explicite (une fois par rafale) et CE flush est abandonné — la
        // chaîne se brise, la page reste vivante pour le débogage.
        const __g = µ._mjs_mtFlush = (µ._mjs_mtFlush || { n: 0, warned: false });
        if (++__g.n === 1) {
          setTimeout(() => { __g.n = 0; __g.warned = false; }, 0);
        }
        if (__g.n > 10000) {
          if (!__g.warned) {
            __g.warned = true;
            µ.warn(`[ModularJS] Boucle réactive détectée sur <${this.tagName ? this.tagName.toLowerCase() : '?'}> : plus de 10 000 rendus dans la même rafale de microtasks. Un effet mute probablement sa propre dépendance ($x = $x + … dans un µeffect ?). Rendu abandonné pour garder la page vivante.`);
          }
          return;
        }
        // `_mjs_pending_full` ne donne plus de passe-droit : un composant monté
        // puis retiré DANS LE MÊME TICK exécutait tout son mount (effects,
        // _mjs_renderStruct, onMount) sur un arbre détaché. Au remount,
        // connectedCallback ré-invalide de toute façon.
        if (!this._mjs_is_mounted) return;
        const pending = this._mjs_pending;
        const fullRender = this._mjs_pending_full;
        this._mjs_pending = null;
        this._mjs_pending_full = false;
        µ.activeComponent = this;
        try {
          // ORDRE : struct AVANT effects.
          // Les blocs `{if}` / `{for}` / `{key}` / `{await}` doivent rendre
          // LEUR contenu (et merger leurs refs dans `this._mjs_nodes`) AVANT que
          // les effects ne tournent — sinon un `@attach` / interpolation /
          // binding posé sur un nœud créé par un bloc struct lit `_mjs_nodes.X`
          // = undefined au mount et no-op silencieux.
          //
          // Blocs structurels rejoués SI :
          //   - mount initial (fullRender), OU
          //   - au moins une des vars muées pilote la struct (compile-time
          //     check via _mjs_renderStructVars).
          // Gain massif sur select1k : `selected` ne pilote pas
          // l'iterable `data` → skip total de _mjs_updFor + _mjs_reconcileList.
          //
          // Bug-fix : `_mjs_lastMutedVars` peut être null si pas d'effects user
          // (optim = skip alloc Set). On utilise le flag
          // `_mjs_pending_struct_dirty` posé directement par `_mjs_invalidate` quand
          // une var muée matche `_mjs_renderStructVars`. Indépendant de la
          // présence d'effects user.
          let __runStruct = fullRender || this._mjs_pending_struct_dirty === true;
          this._mjs_pending_struct_dirty = false;
          if (__runStruct && this._mjs_renderStruct) {
            try { this._mjs_safeRenderStruct(); } catch (err) {
              this._mjs_catchError(err);
              return;
            }
          }
          if (fullRender) {
            // Mount initial ou async fire : exécute TOUS les effects.
            // Skip `typeof === 'function'` checks (méthode prototype garantie).
            // for-let-i au lieu de for-of (V8 spécialise mieux sur Array).
            const __ea = this._mjs_effectsAll;
            if (__ea) {
              for (let __i = 0, __ln = __ea.length; __i < __ln; __i++) {
                try { __ea[__i].call(this); } catch (err) {
                  this._mjs_catchError(err);
                  return;
                }
              }
            }
          } else if (pending) {
            // Dispatch ciblé : seuls les effects abonnés aux vars muées.
            // NB : pending est un Set → for-of OK, pas d'indexAccess.
            for (const fn of pending) {
              try { fn.call(this); } catch (err) {
                this._mjs_catchError(err);
                return;
              }
            }
          }
          // µ.effect — exécution des effets utilisateur.
          // Mode V2 : on les fire tous au mount initial, et sinon on filtre
          // par intersection de leur staticMask avec les vars muées.
          // _mjs_runEffectsV2 est sur prototype, toujours présent. Pas besoin
          // de typeof === 'function' check. Évite N typeof par batch.
          // Le early-return interne gère le cas pas d'effects.
          // µ._mjs_inEffect posé ici AUSSI (miroir du site _mjs_ue_pending plus haut) :
          // sans lui, une écriture nested faite par un effet de CE chemin reprenait le
          // fast-path sync (lecteur unique : garde d'entrée _mjs_invalidate) et patchait le
          // DOM 1 microtâche trop tôt — l'invariant « cascade nested toujours différée »
          // ne tenait que d'un côté ; pas de fusion _mjs_lastMutedVars nécessaire ici (rien
          // ne le relit après l'appel sur ce chemin)
          µ._mjs_inEffect = true;
          try {
            this._mjs_runEffectsV2(pending, fullRender);
          } finally {
            µ._mjs_inEffect = false;
          }
          // µmount fire APRÈS le 1er render.
          if (this._mjs_pendingMount) {
            this._mjs_pendingMount = false;
            // SSR : hooks client — pas d'exécution côté serveur (cf. µ._isServer).
            this._mjs_fireMount();
          }
        } finally {
          µ.activeComponent = null;
          this._mjs_initial_render = false;
        }
      });
    }
    if (k === '_awaits_') {
      this._mjs_pending_full = true;
    } else {
      // for-let-i au lieu de for-of (évite alloc iterator + symbol lookup).
      const __ebv = this._mjs_effectsByVar;
      if (__ebv) {
        const list = __ebv[k];
        if (list) {
          const __pset = this._mjs_pending;
          for (let __i = 0, __ln = list.length; __i < __ln; __i++) {
            __pset.add(list[__i]);
          }
        }
      }
      if (this._mjs_lastMutedVars) this._mjs_lastMutedVars.add(k);
      // Bug-fix : track séparément si une var muée pilote `_mjs_renderStruct`.
      // Indépendant de la présence d'effects user (qui était la condition
      // pour allouer `_mjs_lastMutedVars`). Sans ce flag, un composant sans effect
      // user mais avec `{for}` / `{if}` ne re-renderait pas la struct au
      // `µ._set(el, 'rowsVar', ...)` externe.
      if (this._mjs_pending_struct_dirty === false) {
        const __rsv = this._mjs_renderStructVars;
        if (__rsv != null && __rsv[k] === 1) {
          this._mjs_pending_struct_dirty = true;
        }
      }
    }
  }

  // ==========================================
  // _mjs_runEffectsV2 — exécution des µ.effect() utilisateur.
  // ==========================================
  // Garde la sémantique V1 (staticMask scanné côté script + tracking runtime
  // via Proxy stores) mais ne dépend plus du bitmask global :
  //   - Au mount (fullRender) → fire tous les effects.
  //   - Sinon → fire les effects dont `staticVars` intersecte les vars muées.
  // `staticVars` est calculé par µ.effect côté runtime (cf. mjs_runes.ts).
  _mjs_runEffectsV2(pendingFns, fullRender) {
    const __effs = this._mjs_effects;
    if (!__effs || __effs.length === 0 || this._mjs_has_crashed) return;
    // Récupère les vars muées : on stocke depuis _mjs_invalidate
    // Skip alloc Set() inutile (mutedVars peut rester null si pas de
    // vars muées, on test directement via mutedVars && mutedVars.has(v)).
    // Skip aussi la re-alloc en sortie : sera ré-alloué par _mjs_invalidate au
    // prochain batch ou laissé null.
    const mutedVars = this._mjs_lastMutedVars;
    this._mjs_lastMutedVars = null;
    // for-let-i au lieu de for-of (V8 spécialise mieux sur Array).
    for (let __ei = 0, __eln = __effs.length; __ei < __eln; __ei++) {
      const e = __effs[__ei];
      let shouldFire = fullRender;
      const __sv = e.staticVars;
      if (!shouldFire && __sv && __sv.length > 0 && mutedVars) {
        for (let __vi = 0, __vln = __sv.length; __vi < __vln; __vi++) {
          if (mutedVars.has(__sv[__vi])) { shouldFire = true; break; }
        }
      }
      // Effects sans staticVars (univ. stores, computed, etc.) : fire toujours
      // (compromis runtime — sera tracké via subscribers au prochain refactor).
      if (!shouldFire && (!__sv || __sv.length === 0)) {
        shouldFire = true;
      }
      if (!shouldFire) continue;
      try {
        if (typeof e.cleanup === 'function') e.cleanup();
      } catch (err) { µ.warn('Cleanup error:', err); }
      try {
        const res = e.fn();
        e.cleanup = typeof res === 'function' ? res : null;
      } catch (err) {
        if (typeof this._mjs_catchError === 'function') this._mjs_catchError(err);
      }
    }
  }

  // purge des états indexés par bloc
  // ({for} imbriqués + {await}) dont l'ancre vit dans le sous-arbre `node`.
  // Appelé UNIQUEMENT aux points de mort DÉFINITIVE de `_mjs_destroyNodeAndChildren`
  // (jamais quand le nœud est seulement `_mjs_dying` : il peut être ressuscité
  // par `_mjs_tryReviveDying`/le revival `hasDying` de `_mjs_reconcileList`).
  // `node` est le plus souvent un élément, mais peut aussi être
  // l'ancre TEXTE d'un {await}/{for} imbriqué (`s-<id>`/`e-<id>`, frère du
  // contenu) : les deux fonctions appelées ci-dessous ne font que des
  // comparaisons/`.contains()` (hérité de `Node`, jamais de `querySelectorAll`),
  // sûres sur un nœud texte comme sur un élément.
  _mjs_mjsPurgeSubtreeState(node) {
    if (this._mjs_list_anchor != null) this._mjs_mjsPurgeNestedListCaches(node);
    if (this._mjs_awaitMap != null) this._mjs_mjsPurgeAwaitMaps(node);
  }

  async _mjs_destroyNodeAndChildren(node, waitOut = false) {
    // la purge des caches de {for}
    // imbriqués (+ Maps {await}) NE doit PLUS se faire ICI, en TÊTE : un nœud
    // seulement marqué `_mjs_dying` (outro en cours) peut être RESSUSCITÉ
    // (`_mjs_tryReviveDying`, revival `hasDying` de `_mjs_reconcileList`). Purger dès la
    // tête vidait le cache d'un {for} imbriqué dont les rows étaient toujours
    // dans le DOM → au revive, le `_mjs_updList` suivant repartait d'un cache vide
    // et DUPLIQUAIT les rows. On purge donc UNIQUEMENT aux points de mort
    // DÉFINITIVE ci-dessous (via `_mjs_mjsPurgeSubtreeState`), où le nœud ne peut
    // plus revivre. Les chemins SANS outro purgent au même tick qu'avant (les
    // 3 fast-paths retirent le nœud immédiatement).
    if (node.nodeType !== 1) {
      // CORRECTIF — l'ancre TEXTE d'un {await} (`s-<id>`/
      // `e-<id>`, FRÈRE du contenu, jamais descendant) sortait ici SANS jamais passer
      // par `_mjs_mjsPurgeSubtreeState` : `_mjs_awaitMap`/`_mjs_awaitLastRender` restaient peuplés
      // à la fermeture de la branche {if}/{key} englobante, et `_mjs_updAwait` retrouvait au
      // ré-affichage la MÊME promesse + le MÊME dernier statut rendu → le contenu du
      // {await} ne réapparaissait jamais. Un nœud texte n'a jamais `_mjs_outro`/
      // `_mjs_dying` : sa mort est toujours DÉFINITIVE, la purge est donc sans risque
      // (cf. commentaire ci-dessus sur les points de mort définitive).
      this._mjs_mjsPurgeSubtreeState(node);
      return node.remove();
    }
    if (node._mjs_dying) {
      return;
    }
    // Fast path "no destroy hooks" : si le composant entier n'a JAMAIS
    // déclaré de `@transition/@in/@out/@attach/@this=!/@flip` au compile-time
    // (flag posé via `static _mjs_noDestroyHooks = true`), aucun descendant
    // ne peut avoir `_mjs_outro` / `_mjs_td` / `_mjs_ref_td` / `_mjs_global`.
    // On peut bypass complet le walk DFS + le pipeline transitions.
    // Gain massif sur replace1k / clear1k (1000 destroy × walk évité).
    if (!waitOut && this.constructor._mjs_noDestroyHooks === true) {
      node._mjs_dead = true;
      // Mort définitive (no-destroy-hooks ⇒ pas d'outro ⇒ pas de revive).
      this._mjs_mjsPurgeSubtreeState(node);
      // Pool : récupère les text nodes feuilles avant remove pour
      // réutilisation. Seul le cas no-destroy-hooks est safe ici (pas de
      // listeners, pas de transitions). Le pool vit dans mjs_textpool.ts, joint quand le
      // générateur émet `µ._mjs_getTextNode(` (cf. son en-tête) : sans lui, personne n'y puise,
      // le remplir ne ferait que retenir des nœuds morts.
      if (µ._mjs_recycleTextLeaves) { µ._mjs_recycleTextLeaves(node); }
      node.remove();
      return;
    }
    // Au-delà de ce point, le composant PEUT porter des hooks de destruction
    // (transitions/@attach/@this=!/@flip) — la suite (marquage `_mjs_dying`, 2e
    // fast-path dynamique, orchestration des teardowns/outros) vit désormais dans
    // src/runtime/mjs_destroy_hooks.ts, DÉTACHÉ du cœur. Ce point n'est atteignable
    // QUE si le compilateur a détecté `hasDestroyHooks` pour AU MOINS un composant
    // du projet — sinon `_mjs_noDestroyHooks` vaudrait `true` PARTOUT et le
    // fast-path ci-dessus aurait déjà retourné : le fichier est donc TOUJOURS
    // présent ici pour un projet réel (cf. son en-tête). Filet défensif quand même
    // (mêmes gestes que le fast-path ci-dessus) si un bug de détection manquait
    // malgré tout un émetteur.
    if (typeof this._mjs_destroyWithHooks === 'function') {
      return this._mjs_destroyWithHooks(node, waitOut);
    }
    node._mjs_dead = true;
    this._mjs_mjsPurgeSubtreeState(node);
    if (µ._mjs_recycleTextLeaves) { µ._mjs_recycleTextLeaves(node); }   // cf. le chemin rapide ci-dessus
    node.remove();
  }

  _mjs_updAttr(id, attrName, val) {
    // Inspiré Solid `setAttribute` : skip hasAttribute (qui read attr map)
    // avant removeAttribute, et skip String() si déjà string.
    // V8 spécialise mieux getAttribute===setAttribute branch que has+set.
    // Logique déléguée à `µ._mjs_updAttrNode` (voir sa définition en tête de
    // fichier) — root et `{for}` partagent désormais EXACTEMENT le même code.
    µ._mjs_updAttrNode(this._mjs_nodes[id], attrName, val);
  }

  // `_mjs_updHtml` (interpolation brute `{{…}}`) : mjs_html.ts, joint seulement si le code compilé
  // l'appelle.

  _mjs_updText(id, val) {
    // Inspiré Solid `insertExpression` : skip String() si déjà string,
    // assigne direct via node.data (équivalent nodeValue mais plus rapide en V8
    // car node.data est un slot Text-specific, pas une property Node générique).
    // V8 spécialise mieux le get/set sur Text.data que sur Node.nodeValue.
    // `_mjs_pooled` : nœud recyclé (pool global) — écrire dessus corromprait
    // le rendu auquel il a été réattribué.
    const node = this._mjs_nodes[id];
    if (!node || node._mjs_pooled) return;
    // Coerce uniquement si non-string. Number → toString natif. null/undefined → ''.
    // Évite `String(val)` qui allocate même si val est déjà la string courante.
    const t = typeof val;
    const s = t === 'string' ? val
            : (val == null ? '' : (t === 'number' ? '' + val : String(val)));
    if (node.data !== s) {
      node.data = s;
    }
  }

  // Garde de réentrance pour `_mjs_renderStruct`. Si une var structurelle mute
  // PENDANT le rendu (ex. l'interpolation d'un item de `{for}` qui écrit un
  // `$`, ce qui déclenche `_mjs_invalidate` → un nouvel appel structurel), l'appel
  // imbriqué NE relance PAS `_mjs_renderStruct` (sinon la liste se reconstruit en
  // double) : il pose `_mjs_renderStructDirty`, et la boucle ci-dessous rejoue une
  // passe de plus avec l'état final. Aucun update perdu, aucun double rendu.
  // Coût : O(1) autour d'une opération déjà lourde — n'affecte aucun hot path
  // par-item (`_mjs_reconcileList`, `_mjs_updText`… intacts).
  _mjs_safeRenderStruct() {
    if (this._mjs_inRenderStruct) {
      this._mjs_renderStructDirty = true;
      return;
    }
    this._mjs_inRenderStruct = true;
    try {
      let __guard = 0;
      do {
        this._mjs_renderStructDirty = false;
        this._mjs_renderStruct();
      } while (this._mjs_renderStructDirty && ++__guard < 20);
      if (this._mjs_renderStructDirty) {
        // Sortie de boucle PAR LE GARDE : un cycle réactif réel re-mute une
        // var structurelle à chaque passe. Avant : abandon silencieux, DOM
        // potentiellement incohérent et bug user indétectable.
        µ.warn(`[ModularJS] <${this.tagName?.toLowerCase()}> : boucle de mutations structurelles détectée (20 passes) — re-render abandonné. Une var pilotant un {for}/{if} est probablement re-mutée par le rendu lui-même.`);
      }
    } finally {
      this._mjs_inRenderStruct = false;
    }
  }

  // (`_updElement` supprimé : orphelin — la version vivante de
  // `<@element>` est `µ._updDynEl` (mjs_runes, marqueur `mjs-el`) ; aucun
  // émetteur dans le générateur, et il ne ré-enregistrait pas `_nodeIds`.)

  _mjs_catchError(err) {
    var ref;
    µ.error(`Crash intercepted in ${(ref = this.tagName) != null ? ref.toLowerCase() : void 0}:`, err);
    this._mjs_has_crashed = true;
    this.classList.add('mjs-error');
    this._mjs_render_scheduled = false;
    // Frontière `<@failed>` — repli propre, propagation vers l'ancêtre qui en porte un, limite de
    // réessai — dans mjs_failed.ts, joint seulement si une source compilée pose un repli (balise
    // `<@failed>` ou rune nue `µfailed`, les deux SEULS écrivains de `_mjs_fallback`). Absente,
    // aucun composant n'a de repli : rien à rendre, aucun ancêtre à trouver, l'overlay fatal
    // ci-dessous suffit. Rend `true` quand le crash est pris en charge (repli affiché ou remonté).
    if (this._mjs_runBoundary && this._mjs_runBoundary(err)) return;
    this._shadow.innerHTML = "";
    // Pas de fallback OU fallback en erreur → overlay fatal. textContent (pas
    // innerHTML) : err.message reflète souvent l'entrée utilisateur (JSON.parse,
    // validations…) — un message contenant `<img onerror=…>` s'exécutait au
    // crash (XSS).
    // Garde-fou — compteur STRUCTUREL (jamais un test de sous-chaîne sur le HTML
    // sérialisé, faux positif sur une PROSE qui cite la classe) : lu tel quel par renderToString.ts
    // (fenêtre happy-dom) et par render-browser.ts (page.evaluate), un crash SANS frontière <@failed>
    // absorbante et un seul.
    µ._fatalErrors = (µ._fatalErrors || 0) + 1;
    var __fatal = document.createElement('div');
    __fatal.className = 'mjs-fatal-error';
    __fatal.textContent = `Fatal Error: ${err.message}`;
    this._shadow.appendChild(__fatal);
  }

  // V2 — `_runEffects` legacy retiré (utilisait bitmask + `_getEmptyMask`).
  // Remplacé par `_mjs_runEffectsV2` au-dessus, qui filtre par intersection de
  // varNames avec les vars muées.

};
