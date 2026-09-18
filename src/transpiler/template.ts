// transpiler/template — squelette du module compilé final.
// Port de la V1 Ruby, transpiler/template.rb.
//
// V2 — dispatch direct sans bitmask :
//   - Plus de `render(dirty)` monolithique avec scan d'`if (dirty & MASK)`.
//   - À la place, on émet :
//       this._mjs_effectsByVar = { var1: [fn1, fn2], var2: [fn3], ... }
//       this._mjs_effectsAll   = [fn1, fn2, fn3, ...]   (pour le mount initial)
//       this._mjs_renderStruct = () => { ... blocs structurels ... }
//   - `_mjs_invalidate(k)` (cf. mjs_element.ts) lit `_mjs_effectsByVar[k]` et exécute
//     SEULEMENT les effects abonnés à la var muée. Coût O(effects abonnés)
//     au lieu de O(effects total).
//
// Compile-time DOM impératif pur (style Solid) :
//   - Plus de `template.innerHTML` + `cloneNode(true)` + walk paths.
//   - À la place, `__create_X()` appelle `document.createElement` direct
//     et retourne `{ fragment, refs }` où `refs` = pointeurs JS aux nodes
//     dynamiques (text placeholders + éléments annotés).
//   - Mount = `const {fragment, refs} = __create_X(); this._mjs_nodes = refs;`
//
// La DERNIÈRE ligne enregistre la balise par l'aide du cœur (`µ._def`, runtime mjs_dom.ts, toujours
// joint) : le test d'existence, l'enregistrement et le message de collision sont les mêmes pour
// tous les composants — recopiés ici, ils se payaient par FICHIER (le message seul, 106 signes,
// deux fois). Ce que le squelette porte encore : la balise et la classe. `µ` est le nom sous lequel
// le module importe le cœur (cf. la ligne `import { µ }` posée par injectTemplate) — le symbole
// configuré (`sigil: 'mjs'`) est réécrit en `µ` bien avant.

export const jsTemplate = `
const _dir_[[CLASS]] = new URL('.', import.meta.url).href;
[[STORE_DECLARE_LINE]]

// Fonction de construction du DOM, retourne {fragment, refs}.
// fragment = DocumentFragment prêt à appendChild
// refs = { id: node } pointeurs directs aux text nodes / éléments dynamiques.
function __create_[[CLASS]]() {
  [[CREATE_FN_BODY]]
}

class [[CLASS]] extends µ.Element {
  static _mjs_noDestroyHooks = [[NO_DESTROY_HOOKS]];
  static _mjs_hasFlip = [[HAS_FLIP]];
  // Miroirs STATIQUES de @viewTransition (accessibles sur la CLASSE, sans
  // instanciation) — nécessaires pour résoudre la préférence d'une page pas
  // encore montée (côté ARRIVÉE d'une navigation, cf. mjs_router.ts,
  // _mjs_vtResolveNavigation/_mjs_vtSideResolve : customElements.get(nom) ne
  // renvoie que le CONSTRUCTEUR, jamais une instance).
  static _mjs_vt = [[VIEWTRANSITION]];
  static _mjs_vtp = [[VIEWTRANSITION_PRIORITY]];
  // Optim #7 — Set des ids qui ont AU MOINS un event listener attaché.
  // Calculé au compile-time à partir de \`state.events\`. \`_mjs_registerRefs\`
  // skip tous les autres ids → réduit la WeakMap \`_nodeIds\` (event routing).
  static _mjs_evt_ids = [[EVT_IDS]];

  constructor() {
    super();

    this._mjs_var_bits = [[VAR_BITS]];[[STATE_METHOD_CLASH_LINE]]
    this._mjs_computedDeps = [[COMPUTED_DEPS]];
    this._mjs_baseCss = \`[[BASE_CSS]]\`;
    this._mjs_dir = _dir_[[CLASS]];
    this._mjs_modName = "[[MOD_NAME]]";
    this._mjs_preload = [[PRELOAD]];
    this._mjs_viewTransition = [[VIEWTRANSITION]];
    this._mjs_viewTransitionPriority = [[VIEWTRANSITION_PRIORITY]];

    this._mjs_mount(() => __create_[[CLASS]]());

    µ?.Autoloader?.observe?.(this._shadow);[[DYNAMIC_SLOTS_LINE]]

    // Préchargement « eager » : scanne le shadow pour les liens à précharger dès
    // l'apparition (no-op si l'eager n'est pas actif — cf. µ._mjs_maybeScanEager).
    µ?._mjs_maybeScanEager?.(this);

    // pas de Proxy : _state est un objet ordinaire ; les writes
    // passent par µ._set qui appelle _mjs_invalidate(varName) après update.
    this._state ??= {};
    const $ = this._state;
    [[EVENTS]]

    this.init($);
  }

  init($) {
    const _mjsThis = this;
    _mjsThis._mjs_initial_render = true;

    (function($) {
      [[JS_INIT]]

      // V2 — dispatch direct par varName.
      // _mjs_effectsByVar : map { varName: [fn, fn, ...] }
      // _mjs_effectsAll   : liste de tous les effects (pour le mount initial)
      // _mjs_renderStruct : blocs structurels (if/for/await/key), exécutés à chaque tick
      _mjsThis._mjs_effectsByVar = [[EFFECTS_BY_VAR]];
      _mjsThis._mjs_effectsAll   = [[EFFECTS_ALL]];
      // Liaisons two-way vers un composant ENFANT (\`<@x value=!{$y}>\`) :
      // posées ICI, SYNCHRONEMENT, avant que ce constructeur ne rende la main —
      // donc avant TOUT connectedCallback, quel que soit l'ordre réel (parent
      // avant enfant ou l'inverse, non garanti par le moteur/DOM natif) dans
      // lequel ils se déclenchent une fois le sous-arbre inséré. Sans ça, un
      // enfant qui exige sa prop au montage (garde \`µmount\`) peut se monter
      // AVANT que l'effect jumeau (\`_mjs_effectsAll\`, exécuté plus tard au premier
      // rendu réel) n'ait eu la main. Idempotent : même code que l'effect,
      // mêmes gardes \`!==\`.
      [[INITIAL_PROP_BINDS]]
      // Statisation $$ — clés du store universel lues par CE composant
      // (+ '*' si dépendance structurelle) : le runtime s'y abonne au montage
      // et appelle _mjs_invalidate('$$'+clé) à chaque écriture externe.
      [[STORE_KEYS_LINE]]
      // i18n — [section @i18n|null, mode @i18nPlaceholder|null] : le runtime
      // enregistre ce composant sous sa section et diffère le premier rendu en
      // mode 'wait'. Émis seulement si le module a @i18n OU utilise la rune µt.
      [[I18N_LINE]]
      // dict des vars qui pilotent _mjs_renderStruct. Si null,
      // pas de struct (skip systematique). Runtime _mjs_invalidate ne re-run
      // _mjs_renderStruct que si la var muee est dans ce dict.
      _mjsThis._mjs_renderStructVars = [[STRUCT_VARS]];
      _mjsThis._mjs_renderStruct = () => {
        µ.activeComponent = _mjsThis;
        try {
          [[UPDATES_STRUCTURE]]
          [[UPDATES_TRANSITIONS]]
        } finally {
          µ.activeComponent = null;
        }
      };
    }).call(this, $);
  }
}
µ._def("[[TAG_NAME]]", [[CLASS]]);
`.trim()
