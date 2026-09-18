// bundler/features — signaux « briques du cœur utilisées », lus dans le CODE COMPILÉ d'une
// unité (composant .mjs, module .civet/.coffee, manifeste externe), jamais dans le texte
// source. Remplace scanRuntimeFeatures() (balayage textuel de sourceDir, supprimé) : le
// compilateur GÉNÈRE ces symboles de façon stable (appel littéral, attribut posé, champ de
// données) — les chercher directement dans sa sortie ne peut plus rater une forme compilée
// ni s'arrêter à un commentaire/une chaîne qui MENTIONNE le symbole sans l'utiliser (faux
// positif du scan texte, cf. tests/bundler-core-after-components.test.ts).
//
// Chaque regex ci-dessous a été prouvée par une fixture compilée via transpile() (jamais
// déduite du seul texte du générateur) — cf. tests/bundler-features-scan.test.ts, une fixture
// par clé. Un correctif notable trouvé ainsi : la balise `<@failed>` ne compile PAS en
// `_mjs_hook('failed', …)` (réservé à la rune nue `µfailed (err, reset)->`) mais en
// `this._mjs_fallback = (err, reset) => {…}` — scanné en plus du premier.
//
// Appliquée à la sortie NON MINIFIÉE (le minifieur esbuild mangle les propriétés `_mjs_*`/
// `_upd*` via mangleCache, les signaux y deviennent invisibles) — cf. les appelants
// (bundler/index.ts, chemin froid de _compileMjsInner/_compileScriptModuleInner).

/** sous-ensemble de TranspileDataLike utilisé ici — layoutCss seul (déclaration de variant de
 * mise en page, `<style name="…">`) : `used === undefined` pour un module de script autonome
 * (aucun TranspileData, jamais de <style name>), le scan retombe alors sur le texte compilé. */
export type FeatureScanData = {
  layoutCss?: Record<string, string>
}

// Les 21 clés historiques de scanRuntimeFeatures() (bundler/index.ts, SCAN_KEYS) + `theme`
// (thème clair/sombre embarqué détaché en mjs_theme.ts) + `html` (interpolation brute `{{…}}`,
// mjs_html.ts) + `slots` (slots indexés, mjs_slots.ts) + `deep`/`textpool`/`esc` (trois familles
// de fonctions détachées de mjs_init.ts) + `alias` (enregistrement de l'alias court d'un
// composant, mjs_alias.ts) — même vocabulaire, même consommateur
// (resolveRuntimeFiles/wantsByFile) : aucun renommage.
export const SCAN_KEYS = [
  'title', 'store', 'interpolate', 'ticker', 'head', 'body', 'dynamic', 'failed', 'rare_runes',
  'on', 'effect', 'every', 'for', 'if', 'key', 'await', 'emit', 'context', 'lifecycle',
  'layout_variant', 'destroy_hooks', 'theme', 'html', 'slots', 'deep', 'textpool', 'esc', 'for_nested', 'alias',
] as const

// une regex par clé — `(?![\w$])`/`\b` où un nom pourrait être le préfixe d'un autre
// identifiant (mangleCache retire déjà les composants minifiés de la course, cf. bandeau).
const REGEX_TITLE         = /mjs-title/
const REGEX_STORE         = /µ\.Store(?![a-zA-Z0-9_])/
const REGEX_INTERPOLATE   = /µ\.interpolate(?![a-zA-Z0-9_])/
const REGEX_TICKER        = /µ\.Ticker(?![a-zA-Z0-9_])/
const REGEX_HEAD          = /µ\._setHead\(/
const REGEX_BODY          = /µ\._glCl\(|µ\._glSt\(/
const REGEX_DYNAMIC       = /µ\._updDynEl\(|µ\._updModule\(/
// balise <@failed> compilée (this._mjs_fallback = (err, reset) => {…}) OU rune nue
// (this._mjs_hook('failed', fn)) — deux émetteurs distincts, cf. bandeau de tête.
const REGEX_FAILED        = /_mjs_fallback\s*=|_mjs_hook\(\s*'failed'/
const REGEX_RARE_RUNES    = /µ\.play\(|µ\.minmax\(|µ\.inspect\(|µ\.raw\(|µ\.snap\(|µ\._mjs_import\(/
const REGEX_ON            = /_mjs_on\(/
const REGEX_EFFECT        = /µ\.effect\(/
const REGEX_EVERY         = /µ\.every\(/
// {if}/{key} imbriqués dans {for}/{await} compilent en _mjs_updItemIf( (mjs_if.ts), jamais
// _mjs_updIf(/_mjs_updKey( — un composant qui n'a QUE la forme nichée doit quand même lever 'if'
// (mjs_if.ts sert dans les deux cas ; un faux positif sur 'if' pour un {key} nu niché est
// sans conséquence, wantsKey force déjà wantsIf, cf. resolveRuntimeFiles).
const REGEX_FOR           = /this\._mjs_updFor\(/
const REGEX_IF            = /this\._mjs_updIf\(|this\._mjs_updItemIf\(/
const REGEX_KEY           = /this\._mjs_updKey\(/
const REGEX_AWAIT         = /this\._mjs_updAwait\(/
const REGEX_EMIT          = /_mjs_emit\(/
// `§` (figé) compile en _mjs_setContext(/_mjs_getContext( ; `§§` (RÉACTIF) compile en
// _mjs_setRCtx(/_mjs_getRCtx( (marqueur DISTINCT, trouvé empiriquement — la conception ne
// citait que les deux premiers, corrigé après un test rouge sur `{§§theme}` en LECTURE
// seule). `_mjs_rctxRemember(` complète la même famille (cf. config.ts, DETECTED_CORE_MODULES).
const REGEX_CONTEXT       = /_mjs_setContext\(|_mjs_getContext\(|_mjs_setRCtx\(|_mjs_getRCtx\(|_mjs_rctxRemember\(|__context\.|__shared\./
// n'importe quel hook de cycle de vie (mount/awake/sleep/destroy/urlChange/failed nu) —
// même regroupement que l'ancien REGEX_LIFECYCLE (alternance incluant 'failed').
const REGEX_LIFECYCLE     = /_mjs_hook\(/
// reliquat texte : la DEMANDE (`layout="x"`/`template="x"`) peut ne venir que d'une page que
// ce build ne compile jamais (vue serveur, HTML statique) — mais quand elle EST dans une
// source compilée, le HTML compilé la porte encore telle quelle (µ._mjs_cloneTpl("<p layout='x'>
// …")) : un scan sur la SORTIE suffit, plus besoin du texte SOURCE séparément.
const REGEX_LAYOUT_TEXT   = /layout=|template=/
// `static _mjs_noDestroyHooks = …;` est TOUJOURS émis (true ou false) par tout composant —
// seule la valeur `false` signale un vrai besoin (transpiler/template.ts).
const REGEX_DESTROY_HOOKS = /_mjs_noDestroyHooks = false/
// thème clair/sombre embarqué (mjs_theme.ts) — 8 variables canoniques du framework
// (surface/fg/fg-muted/border/hover/selected/accent/shadow), jamais un nom de thème PROJET
// (`$$brand` reste hors de cette liste). Deux formes compilées :
//   - lecture CSS directe `var(--mjs-x)`, ou sucre `$$x` — la passe `rewriteStyleVars`
//     (transpiler/index.ts) réécrit `$$x` en texte CSS littéral `var(--mjs-x)` AVANT la
//     compilation JS, le texte compilé porte donc déjà la forme `var(...)` : aucun signal
//     séparé nécessaire pour `$$`, `data.varsRead` n'est pas consultée ici ;
//   - rune `µtheme`, qui compile soit en lecture `µ.store.__mjsTheme` (sigils.ts,
//     MU_THEME_OUT) soit en écriture `µ._storeSet('__mjsTheme', v)` (generator/utils.ts) — la
//     2e forme loge `__mjsTheme` dans un littéral de chaîne, JAMAIS masqué ici (contrairement à
//     store/interpolate/ticker/every) pour ne pas produire de faux négatif sur `µtheme = v`.
const REGEX_THEME = /--mjs-(?:surface|fg|fg-muted|border|hover|selected|accent|shadow)\b|__mjsTheme\b/
// interpolation brute `{{…}}` (mjs_html.ts) : appel littéral `this._mjs_updHtml('tN', …)` émis par
// generator/compile.ts pour chaque `{{…}}` du composant — racine, {if}/{else}, {key}, contenu de
// <@slot>, contenu passé à un enfant, partiel <@include>. Dans un {for} la ligne écrit
// `innerHTML` elle-même, dans un {await} la branche construit son nœud : ni l'un ni l'autre
// n'appelle la méthode, aucun signal à chercher pour eux.
const REGEX_HTML = /\._mjs_updHtml\(/
// slots indexés (mjs_slots.ts) : `this._mjs_injectSlots();` n'est émis dans le constructeur compilé
// que si le composant écrit `<@slot` (partiel <@include> compris, inliné avant ce test —
// transpiler/index.ts, `hasDynamicSlots`) ; sans lui, la méthode n'avait rien à faire.
const REGEX_SLOTS = /\._mjs_injectSlots\(/
// mutations PROFONDES (mjs_deep.ts) : les quatre appels que le suiveur de chemins
// (generator/path-tracker.ts) émet LITTÉRALEMENT —
// `µ._mjs_deepSet(` pour `$o.x = v`, `µ._mjs_deepCall(` pour `$liste.push(v)`, `µ._mjs_deepDelete(` pour
// `delete $o.x`, `µ._mjs_makeDeepProxy(` au point de fuite d'un chemin. Le symbole est cherché
// SANS son objet (`µ`/`mjs` selon la config du projet), comme pour `_mjs_updHtml` plus haut.
const REGEX_DEEP = /\._mjs_deepSet\(|\._mjs_deepCall\(|\._mjs_deepDelete\(|\._mjs_makeDeepProxy\(/
// pool de nœuds texte (mjs_textpool.ts) : `µ._mjs_getTextNode('')` émis par le mode IMPÉRATIF du
// générateur (generator/paths.ts), seul consommateur du pool — le mode clone, lui, crée ses
// nœuds texte directement. Sans cet appel, rien ne puise dans le pool.
const REGEX_TEXTPOOL = /\._mjs_getTextNode\(/
// échappement HTML (mjs_esc.ts) : `µ._esc(` émis pour CHAQUE interpolation d'un `<@head>` ou du
// repli d'un `<@failed>` (transpiler/macros.ts, buildHeadInjection) — les deux partent en
// innerHTML. Un `<@head>` sans interpolation n'émet rien : il n'y a rien à échapper.
const REGEX_ESC = /\._esc\(/
// `{for}` dont les ancres ne sont pas celles du composant (mjs_for_nested.ts) : `this._mjs_updList(`
// émis par generator/compile.ts pour une liste DANS une autre liste, et pour une liste dans une
// branche `{await}`. Racine, `{if}` et `{key}` compilent en `this._mjs_updFor(` : rien à chercher.
const REGEX_FOR_NESTED = /\._mjs_updList\(/
// alias COURT d'un composant (mjs_alias.ts) : `µ._al(` émis par le squelette du module compilé
// (transpiler/index.ts) pour le SEUL composant qui porte un nom court — un projet dont chaque
// fichier vit à la racine n'en écrit aucun. Le symbole est cherché SANS son objet (`µ`/`mjs` selon
// la config du projet), comme pour `_mjs_updHtml` plus haut.
const REGEX_ALIAS = /\._al\(/

// maskStringLiterals — neutralise le CONTENU des littéraux de chaîne JS ('…'/"…"/`…`,
// guillemets délimiteurs gardés) ET des commentaires (`//…`/`/*…*/`) avant de tester store/
// interpolate/ticker/every : ce sont des noms « publics » du framework (documentés), qu'une
// chaîne ou un commentaire affiché peut mentionner SANS jamais les utiliser (`@doc =
// 'µ.Store'`, faux positif texte vérifié). Les COMMENTAIRES entrent dans le même masquage
// pour une raison purement technique : la sortie NON minifiée (celle qu'on scanne) est pleine
// de commentaires français à apostrophes (« l'apparition », « l'eager »…) — sans les
// neutraliser aussi, une apostrophe de commentaire déphase la parité de la regex de chaîne et
// fait rater une VRAIE chaîne plus loin (répété jusqu'à un faux résultat). Risque accepté :
// un `${µ.Store}` interpolé DANS un template literal serait masqué à tort (faux négatif
// théorique) — cas non produit par le générateur, absent des runtimes/composants réels.
// Jamais appliqué aux autres clés : soit leur marqueur est un appel interne préfixé `_mjs_`/
// `_upd`/`µ._` qu'aucun texte utilisateur n'écrit par hasard, soit (title/layout_variant) le
// HTML compilé lui-même EST une chaîne JS — le masquer les rendrait indétectables.
function maskStringLiterals(js: string): string {
  return js.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) => {
    if (m.startsWith('//') || m.startsWith('/*')) return ' '.repeat(m.length)
    return m[0] + ' '.repeat(m.length - 2) + m[0]
  })
}

// --------------------------------------------------------------------------
// scanCompiledFeatures(js, data?) : union des signaux détectés dans la sortie compilée
// NON MINIFIÉE d'une unité. `data` optionnel (module de script autonome : aucun
// TranspileData, aucun `<style name>` possible — la clé layout_variant retombe alors sur le
// seul texte compilé). Jamais de faux négatif toléré : les faux
// positifs (mention hors-usage) sont, eux, acceptés — sauf store/
// interpolate/ticker/every, dont le seul faux positif texte connu (mention en chaîne) est
// corrigé par maskStringLiterals ci-dessus.
// --------------------------------------------------------------------------
export function scanCompiledFeatures(js: string, data?: FeatureScanData): Set<string> {
  const used = new Set<string>()
  const masked = maskStringLiterals(js)
  if (REGEX_TITLE.test(js)) used.add('title')
  if (REGEX_STORE.test(masked)) used.add('store')
  if (REGEX_INTERPOLATE.test(masked)) used.add('interpolate')
  if (REGEX_TICKER.test(masked)) used.add('ticker')
  if (REGEX_HEAD.test(js)) used.add('head')
  if (REGEX_BODY.test(js)) used.add('body')
  if (REGEX_DYNAMIC.test(js)) used.add('dynamic')
  if (REGEX_FAILED.test(js)) used.add('failed')
  if (REGEX_RARE_RUNES.test(js)) used.add('rare_runes')
  if (REGEX_ON.test(js)) used.add('on')
  if (REGEX_EFFECT.test(js)) used.add('effect')
  if (REGEX_EVERY.test(masked)) used.add('every')
  if (REGEX_FOR.test(js)) used.add('for')
  if (REGEX_IF.test(js)) used.add('if')
  if (REGEX_KEY.test(js)) used.add('key')
  if (REGEX_AWAIT.test(js)) used.add('await')
  if (REGEX_EMIT.test(js)) used.add('emit')
  if (REGEX_CONTEXT.test(js)) used.add('context')
  if (REGEX_LIFECYCLE.test(js)) used.add('lifecycle')
  if ((data?.layoutCss && Object.keys(data.layoutCss).length > 0) || REGEX_LAYOUT_TEXT.test(js)) used.add('layout_variant')
  if (REGEX_DESTROY_HOOKS.test(js)) used.add('destroy_hooks')
  if (REGEX_THEME.test(js)) used.add('theme')
  if (REGEX_HTML.test(js)) used.add('html')
  if (REGEX_SLOTS.test(js)) used.add('slots')
  if (REGEX_DEEP.test(js)) used.add('deep')
  if (REGEX_TEXTPOOL.test(js)) used.add('textpool')
  if (REGEX_ESC.test(js)) used.add('esc')
  if (REGEX_FOR_NESTED.test(js)) used.add('for_nested')
  if (REGEX_ALIAS.test(js)) used.add('alias')
  return used
}
