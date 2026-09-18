// attributes — port consolidé de la V1 Ruby, compiler_html/attributes/*.rb
//
// V2 — dispatch direct :
//   - Chaque binding émet UN code d'update sans condition `if (dirty & ...)`.
//   - Le code est aussi enregistré dans `state.effectsByVar` via `registerEffect`
//     pour chaque var dont il dépend (closure transitive via analyzer).
//   - Au root, le code va dans `ctx.updates` (utilisé pour le mount initial
//     via `_mjs_effectsAll`) + dans `effectsByVar[var]` pour chaque var.
//   - Dans une `{for}`, le code est dans la closure de l'updateFn de la loop
//     — la loop est elle-même structurelle (always-run) donc pas besoin
//     d'indexer dans effectsByVar.

import { state, getEffectVars, registerEffect } from '../state.js'
import { cleanJs, cleanJsExpr, parseMixedString } from '../utils.js'
import { transformReactiveWrites } from '../transform-reactive.js'
import { applyPathTracking } from '../path-tracker.js'
import type { Node, Attr } from '../../parser/index.js'
import { t } from '../../messages/index.js'
import { suggestKey } from '../../bundler/config.js'

export interface AttrCtx {
  compiler: typeof state
  node: Node
  attr: Attr
  attrName: string | null | undefined
  rawVal: string
  ctx: { type: string; updates: string[]; loops: any[] }
  id: string | null
  lid: string | null
  attrStr: string  // mutable via retour de la fonction
}

export interface AttrResult {
  id?: string | null
  attrStr?: string
}

/** Helper : enregistre un code d'update au root (effectsByVar + ctx.updates),
 * ou simplement dans ctx.updates pour les contextes for/await/etc. */
function pushUpdate(env: AttrCtx, code: string, vars: string[]): void {
  if (env.ctx.type === 'root') {
    registerEffect(code, vars)
  }
  env.ctx.updates.push(code)
}

/** sentinelle jumelle de `CONST_DECL_PREFIX` (compile.ts) :
 * marque une entrée de `ctx.updates` (émise par `bindingStandard`, ctx.type
 * ni 'root' ni 'for') qui doit courir APRÈS `branchUpdates`+`postUpdates` de
 * la branche englobante ({await}/{if}/{key} non-root) — même besoin que
 * `postUpdates` (paths.ts) pour un `<select value>`, mais pour du code émis
 * ICI, jamais vu par le parseur HTML de paths.ts. Consommée par
 * `splitDeferredUpdates` (compile.ts) aux 3 points d'assemblage non-root. */
export const SELECT_VALUE_DEFER_PREFIX = '/*@mjs-select-post*/'

/** Pose les index de loop en PROPS JS (`_mjs_idx_D`) via l'updateFn de
 * la ligne, SANS attribut DOM. Remplace l'attrPart `data-mjs-idx-D='${idx}'`
 * interpolé dans le template (qui forçait un setAttribute par row dans la
 * factory et empêchait le cloneNode pur). L'updateFn tourne à la création
 * (tplFn / pass 2) et à chaque réordonnancement — la prop est donc
 * toujours posée avant qu'un event utilisateur puisse être dispatché, et les
 * reconstructs la lisent en priorité (le fallback getAttribute reste pour
 * compat). Même convention d'index que compile.ts : la loop courante
 * expose `l.index`, les englobantes leur variable interne.
 * @returns true si la pose a été enregistrée (lid présent) — l'appelant peut
 * alors omettre l'attrPart ; false → conserver l'attrPart (sécurité). */
function pushIdxPropUpdates(env: AttrCtx): boolean {
  if (!env.lid || !env.ctx.loops || env.ctx.loops.length === 0) return false
  const currentDepth = env.ctx.loops[env.ctx.loops.length - 1].depth
  for (const l of env.ctx.loops) {
    const idxVar = l.depth === currentDepth ? l.index : l.internalIndex
    const idxUpd = `{ const n_idx = __nodes['${env.lid}']; if(n_idx && n_idx._mjs_idx_${l.depth} !== ${idxVar}) { n_idx._mjs_idx_${l.depth} = ${idxVar}; } }`
    if (!env.ctx.updates.includes(idxUpd)) env.ctx.updates.push(idxUpd)
  }
  return true
}

// ============================================================================
// Static : juste injection littérale dans la balise
// ============================================================================
function staticAttr(env: AttrCtx): AttrResult {
  return {
    // apostrophe → `&#39;` (décodée
    // au parse HTML, valeur restituée) : ce HTML part dans `µ._mjs_cloneTpl`/innerHTML,
    // `title='l'heure'` fermait sinon le quote après `l` (attributs parasites
    // `heure`/`du`/…). On n'échappe PAS `&` : les entités auteur (`&quot;`,
    // `&nbsp;`) doivent survivre.
    attrStr: env.attrStr + ` ${env.attrName}='${env.rawVal.replace(/'/g, '&#39;')}'`,
    id: env.id,
  }
}

// ============================================================================
// Boolean : `<input disabled>` ou `<details open>`
// ============================================================================
// attribut nu sur balise composant = true : `parseProp` lit 'true' ;
// `title=""` reste '' (chemin static) ; HTML servi par un back : écrire `disabled="true"`
const BARE_ATTR_KEEP_NATIVE = new Set(['popover', 'translate'])

function booleanAttr(env: AttrCtx): AttrResult {
  const attrName = env.attrName ?? ''
  const bare     = !(env.node.name ?? '').includes('-') || BARE_ATTR_KEEP_NATIVE.has(attrName) || attrName.startsWith('mjs-')
  return {
    attrStr: env.attrStr + (bare ? ` ${attrName}` : ` ${attrName}='true'`),
    id: env.id,
  }
}

// ============================================================================
// Spread : <mjs-info {...$pkg} />
// ============================================================================
function spread(env: AttrCtx): AttrResult {
  const expr = env.attr.expr ?? ''
  const vars = getEffectVars(expr)
  // Site EXPR (spread {...$expr}).
  const jsVar = cleanJsExpr(expr, env.compiler.externalVars, env.compiler.templateLang, env.compiler.moduleName)
  const id = env.id ?? `s${++state.counter}`

  const isWc = (env.node.name ?? '').includes('-')

  // enfant pas encore mis à niveau : `µ._mjs_pend` retient la clé HORS de l'instance (cf.
  // mjs_init.ts). Une clé venue de la donnée étalée — jamais écrite dans le code, donc jamais
  // réservée au raccourcissement — pouvait tomber sur le nom court d'une méthode du prototype
  // et la masquer sur l'élément : le composant crevait à sa mise à niveau
  const updateLogic = isWc
    ? "if (node._set) { node._set(k, v); } else { µ._mjs_pend(node, k, v); }"
    : "const a = k.replace(/_/g, '-'); µ._mjs_safeAttr(node, a, v);"

  // `for..in` (zéro alloc) au lieu de `Object.entries().forEach()`
  // (alloue un tableau d'entries + une closure à CHAQUE update — par mutation au
  // root, par row × réconciliation en {for}).
  if (env.ctx.type === 'root') {
    // `_mjs_spd` (préfixe réservé) et non `o` : sinon `<div {...o}>` (item de
    // boucle ou var nommé `o`) émettrait `const o = o` → ReferenceError TDZ au
    // mount.
    const code = `{ const _mjs_spd = ${jsVar}; if(_mjs_spd) { const node = this._mjs_nodes.${id}; if(node) for (const k in _mjs_spd) { const v = _mjs_spd[k]; ${updateLogic} } } }`
    pushUpdate(env, code, vars)
  } else if (env.ctx.type === 'for') {
    env.ctx.updates.push(`{ const _mjs_spd = ${jsVar}; if(_mjs_spd) { const node = __nodes['${env.lid}']; if(node) for (const k in _mjs_spd) { const v = _mjs_spd[k]; ${updateLogic} } } }`)
    // var externe partagée lue par la row (`{...$pkg}`) : sans
    // `structVars`, `_mjs_renderStruct` est sauté → spread figé à vie sur mutation.
    for (const v of vars) state.structVars.add(v)
  }

  return { id }
}

// ============================================================================
// Dynamic : attr={$expr}
// ============================================================================
function dynamic(env: AttrCtx): AttrResult {
  const vars = getEffectVars(env.attr.expr ?? '')
  // Site EXPR (valeur d'attribut attr={$expr}).
  const jsVar = cleanJsExpr(env.attr.expr ?? '', env.compiler.externalVars, env.compiler.templateLang, env.compiler.moduleName)
  const id = env.id ?? `a${++state.counter}`
  const isWc = (env.node.name ?? '').includes('-')
  const attrName = env.attrName ?? ''

  let attrStr = env.attrStr

  if (env.ctx.type === 'root') {
    let code: string
    if (isWc) {
      const updateLogic = `if (node._set) { node._set('${attrName}', ${jsVar}); } else { µ._mjs_pend(node, '${attrName}', ${jsVar}); }`
      code = `{ const node = this._mjs_nodes.${id}; if(node) { ${updateLogic} } }`
    } else {
      code = `this._mjs_updAttr('${id}', '${attrName}', ${jsVar});`
    }
    pushUpdate(env, code, vars)
    if (!isWc) attrStr += ` ${attrName}=''`
  } else if (env.ctx.type === 'for') {
    if (isWc) {
      const updateLogic = `if (node._set) { node._set('${attrName}', ${jsVar}); } else { µ._mjs_pend(node, '${attrName}', ${jsVar}); }`
      env.ctx.updates.push(`{ const n${env.lid} = __nodes['${env.lid}']; if(n${env.lid}) { let node = n${env.lid}; ${updateLogic} } }`)
    } else {
      // Filtered dispatch pour les attributs dynamiques génériques
      // tels que `data-active={item.id === $sel}` ou `aria-selected={...}`,
      // ainsi que les ternaires `data-X={cond ? 'a' : 'b'}`. Même schéma que
      // `@class{cond}` mais avec setAttribute / removeAttribute (ou la valeur).
      const lastLoop = env.ctx.loops && env.ctx.loops.length > 0
        ? env.ctx.loops[env.ctx.loops.length - 1]
        : null
      const filt = lastLoop
        ? detectFilteredValueExpr(env.attr.expr ?? '', lastLoop.item, env.compiler.externalVars ?? [])
        : null
      if (filt) {
        // même fix que bindingClass : `env.lid`
        // distingue 2 nœuds d'une même row partageant (var, attrName).
        const safeAttr = attrName.replace(/[^a-zA-Z0-9_$]/g, '_')
        const filterKey = `${filt.externVar}__attr_${safeAttr}__${env.lid}`
        // le mémo d'un filtrage par clé vit dans `_mjs_filt` (propriété POINTÉE, donc
        // raccourcie en prod) : la clé n'est plus qu'un texte d'index, jamais un nom
        const idxName = filterKey
        // Bool simple : true → setAttribute('name','true') ou removeAttribute si
        // sémantique standard "présent/absent" (data-X / aria-X préfèrent la
        // string explicite, donc on garde set 'true'/'false' pour le caller).
        // Ternaire (valeur) : SÉCURITÉ (XSS) — l'ancien
        // `setAttribute(String(value))` NU contournait `µ._mjs_safeAttr` : un
        // `href={item.id === $sel ? item.url : '#'}` avec `item.url =
        // "javascript:…"` passait tel quel. On route par `µ._mjs_updAttrNode` (comme
        // la branche dynamique NON filtrée, ~:221) → filtre javascript:/data:html
        // ET aligne la sémantique false/null → removeAttribute.
        const setMatchAttr = filt.isBoolean
          ? `node.setAttribute('${attrName}', 'true');`
          : `µ._mjs_updAttrNode(node, '${attrName}', ${filt.matchValue});`
        const setUnmatchAttr = filt.isBoolean
          ? `node.setAttribute('${attrName}', 'false');`
          : (filt.unmatchValue.trim() === "''" || filt.unmatchValue.trim() === '""'
              ? `node.removeAttribute('${attrName}');`
              : `µ._mjs_updAttrNode(node, '${attrName}', ${filt.unmatchValue});`)
        const condExpr = `${filt.itemAccess ? `${lastLoop!.item}.${filt.itemAccess}` : lastLoop!.item} === _mjsThis._state.${filt.externVar}`
        const filteredLogic = `if (!!(${condExpr})) { ${setMatchAttr} } else { ${setUnmatchAttr} }`
        const keyExpr = filt.itemAccess
          ? `${lastLoop!.item}.${filt.itemAccess}`
          : `${lastLoop!.item}`
        // Propriété de clé par fn (même schéma que @class filtré) :
        // (re)pose seulement si clé inédite ou détenue par une autre row.
        // Bonus : évite l'alloc d'une closure à CHAQUE updateFn (l'ancien set
        // inconditionnel reallouait sur tous les updates répétés).
        env.ctx.updates.push(
          `{ const n${env.lid} = __nodes['${env.lid}']; ` +
          `if(n${env.lid}) { let node = n${env.lid}; ${filteredLogic} ` +
          `const __k = ${keyExpr}; ` +
          `const __fe = ((_mjsThis._mjs_filt ??= {})['${idxName}'] ??= { idx: null, prev: void 0 }); ` +
          `const __idx = (__fe.idx ??= new Map()); ` +
          `const __fns = (__nodes._mjs_filterFns ??= {}); ` +
          `const __f0 = __fns['${idxName}']; ` +
          `if (__f0 === void 0 || __idx.get(__k) !== __f0) { ` +
          `const __f = (matches) => { let node = n${env.lid}; if (matches) { ${setMatchAttr} } else { ${setUnmatchAttr} } }; ` +
          `__idx.set(__k, __f); __fns['${idxName}'] = __f; } ` +
          `(_mjsThis._mjs_filtIdxKeys ??= new Set()).add('${idxName}'); ` +
          `(__nodes._mjs_filterKeys ??= {})['${idxName}'] = __k; ` +
          `} }`
        )
        const filtEffectCode =
          `{ ` +
          `const __fe = ((this._mjs_filt ??= {})['${filterKey}'] ??= { idx: null, prev: void 0 }); ` +
          `const prev = __fe.prev; ` +
          `const curr = this._state.${filt.externVar}; ` +
          `if (prev !== curr) { ` +
          `const idx = __fe.idx; ` +
          `if (idx) { ` +
          `if (prev !== void 0) { const f = idx.get(prev); if (f) f(false); } ` +
          `if (curr !== void 0) { const f = idx.get(curr); if (f) f(true); } ` +
          `} ` +
          `__fe.prev = curr; ` +
          `} }`
        // Expansion transitive : si `filt.externVar` est un computed, on doit
      // s'abonner aussi à ses deps statiques. Sinon, l'effect filtered ne
      // tire pas quand une dep du computed mute (ex : `currentStep` dérivé de
      // `currentStepIdx` — sans expansion, mutation de l'idx → computed dirty
      // mais filtered effect jamais réveillé). On passe par `getEffectVars`
      // qui fait l'expansion via `analyzer.resolveSnippetDeps`.
      const filtVars = getEffectVars(`$${filt.externVar}`)
      registerEffect(filtEffectCode, filtVars.length > 0 ? filtVars : [filt.externVar])
        attrStr += ` ${attrName}=''`
        return { id, attrStr }
      }
      // `disabled={item.locked}` avec
      // `locked=false` écrivait `disabled="false"` (setAttribute+String
      // inconditionnels) au lieu de RETIRER l'attribut (présence seule =
      // désactivé en HTML) ; `null`/`undefined` devenaient les chaînes
      // littérales `"null"`/`"undefined"`. `µ._mjs_updAttrNode` (voir
      // runtime/mjs_element.ts) reproduit EXACTEMENT la sémantique du root
      // (props booléennes dédiées, retrait sur false/null/undefined, filtre
      // XSS) — root et `{for}` partagent maintenant le même code.
      env.ctx.updates.push(`{ const n${env.lid} = __nodes['${env.lid}']; if(n${env.lid}) { µ._mjs_updAttrNode(n${env.lid}, '${attrName}', ${jsVar}); } }`)
    }
    // WC (`<mjs-x foo=!{$shared}>`) et attribut dynamique NON
    // filtré (`data-active={$mode}`) : var externe partagée → `structVars` sinon
    // `_mjs_renderStruct` sauté → DOM figé à vie sur mutation. Les chemins FILTRÉS
    // (au-dessus) ont leur effect dédié → ils sont déjà `return`és et exclus.
    for (const v of vars) state.structVars.add(v)
    if (!isWc) attrStr += ` ${attrName}=''`
  } else {
    if (isWc) {
      // même chemin que la branche `for` ci-dessus :
      // sans ça, une prop dynamique de composant (`<mjs-card item={d}>`) en
      // branche `{await}` ne posait RIEN — `item` disparaissait en silence.
      const updateLogic = `if (node._set) { node._set('${attrName}', ${jsVar}); } else { µ._mjs_pend(node, '${attrName}', ${jsVar}); }`
      env.ctx.updates.push(`{ const node = __nodes['${id}']; if(node) { ${updateLogic} } }`)
    } else {
      attrStr += ` ${attrName}='\${${jsVar}}'`
    }
  }

  return { id, attrStr }
}

// ============================================================================
// Interpolation : attr="prefix-{$expr}-suffix"
// ============================================================================
function interpolation(env: AttrCtx): AttrResult {
  const val = env.attr.val ?? ''
  const expressions: string[] = []
  val.replace(/\{([^}]+)\}/g, (_m, e) => { expressions.push(e); return '' })

  const varSet = new Set<string>()
  for (const e of expressions) {
    for (const v of getEffectVars(e)) varSet.add(v)
  }
  const vars = Array.from(varSet)

  // Site EXPR (interpolation attr="pre-{$e}-post").
  const jsVal = val.replace(/\{([^}]+)\}/g, (_m, e) => `\${${cleanJsExpr(e, env.compiler.externalVars, env.compiler.templateLang, env.compiler.moduleName)}}`)
  const jsTemplateStr = `\`${jsVal}\``

  const id = env.id ?? `a${++state.counter}`
  const attrName = env.attrName ?? ''
  let attrStr = env.attrStr

  if (env.ctx.type === 'root') {
    const code = `this._mjs_updAttr('${id}', '${attrName}', ${jsTemplateStr});`
    pushUpdate(env, code, vars)
    attrStr += ` ${attrName}=''`
  } else if (env.ctx.type === 'for') {
    // SÉCURITÉ (XSS) — `href="{item.url}"` (interpolation QUOTÉE
    // dans un {for}, données d'item souvent distantes) émettait un `setAttribute`
    // BRUT contournant `µ._mjs_safeAttr` : `item.url = "javascript:…"` passait tel quel
    // (incohérent avec `href={item.url}` NON quoté, déjà filtré). On route par
    // `µ._mjs_updAttrNode` (comme root via `_mjs_updAttr`) → filtre javascript:/data:html.
    // La valeur vient d'un template literal (toujours string) → jamais false/null,
    // donc pas de removeAttribute intempestif ; `_mjs_safeAttr` re-diffe en interne.
    env.ctx.updates.push(`{ const n${env.lid} = __nodes['${env.lid}']; if(n${env.lid}) { µ._mjs_updAttrNode(n${env.lid}, '${attrName}', ${jsTemplateStr}); } }`)
    // var externe interpolée dans la row (`title="v : {$prefix}"`) :
    // sans `structVars`, `_mjs_renderStruct` sauté → attribut figé à vie sur mutation.
    for (const v of vars) state.structVars.add(v)
    attrStr += ` ${attrName}=''`
  } else {
    // chemin CLONE/innerHTML (ctx ni root ni for) : le navigateur
    // DÉCODE les entités. On échappe l'apostrophe du TEXTE STATIQUE (qui fermerait
    // le quote) SANS toucher aux `${expr}` (JS injecté, dont les string literals
    // contiennent des apostrophes légitimes qu'un escape global corromprait).
    let jsValClone = ''
    let last = 0
    // Site EXPR (interpolation, chemin clone/innerHTML).
    val.replace(/\{([^}]+)\}/g, (m: string, e: string, off: number) => {
      jsValClone += val.slice(last, off).replace(/'/g, '&#39;') + `\${${cleanJsExpr(e, env.compiler.externalVars, env.compiler.templateLang, env.compiler.moduleName)}}`
      last = off + m.length
      return ''
    })
    jsValClone += val.slice(last).replace(/'/g, '&#39;')
    attrStr += ` ${attrName}='${jsValClone}'`
  }

  return { id, attrStr }
}

// ============================================================================
// Bindings complexes (à porter)
// ============================================================================

import { dedent } from '../state.js'

// ============================================================================
// ENREGISTREMENT DES ROUTES D'ÉVÉNEMENTS — point de passage UNIQUE
// ============================================================================
// BOGUE HISTORIQUE. Les quatre familles qui
// posent une route (directive `@événement`, liaison standard, liaison média,
// liaison de contenu) faisaient toutes `state.events[evt][id] = idx` — une
// ÉCRITURE. Or le couple (événement, nœud) est le MÊME pour une liaison
// `value=!{$x}` et une directive `@input={…}` posées sur le même élément :
// la seconde écrasait la première EN SILENCE, et le perdant dépendait de
// l'ordre des attributs dans le gabarit (`<input value=!{$x} @input={f()}>` →
// liaison morte ; directives écrites d'abord → handler de l'app mort). Même
// piège entre deux liaisons qui partagent un événement (`volume=!{}` et
// `muted=!{}` écoutent tous deux `volumechange`).
//
// Ici on EMPILE au lieu d'écraser : à la 2ᵉ route du couple, la valeur est
// promue en LISTE et le runtime (`_mjs_bindEvents`) les exécute TOUTES. Ordre
// garanti : liaisons d'abord, directives ensuite — la directive voit donc la
// variable déjà à jour. Le cas sans collision garde la forme courte (`idx`),
// donc aucune inflation du bundle sur la route ordinaire.
function registerEventRoute(evt: string, id: string, idx: number, flags: number, kind: 'binding' | 'directive'): void {
  state.events ??= {}
  state.events[evt] ??= {}
  const map  = state.events[evt]
  const prev = map[id]
  const key  = `${evt} ${id}`

  if(prev === undefined) {
    map[id] = flags === 0 ? idx : [idx, flags]
    if(kind === 'binding') state.eventBindCount[key] = 1
    return
  }

  let list: [number, number][]
  if(typeof prev === 'number')    list = [[prev, 0]]
  else if(Array.isArray(prev[0])) list = prev as [number, number][]
  else                            list = [prev as [number, number]]

  if(kind === 'binding') {
    const at = state.eventBindCount[key] ?? 0
    list.splice(at, 0, [idx, flags])          // les liaisons restent groupées en tête
    state.eventBindCount[key] = at + 1
  }
  else list.push([idx, flags])

  map[id] = list
}

// ============================================================================
// EventListener — port de attributes/event_listener.rb
// @click, @input, @change, @keydown, etc.
// Modificateurs : .prevent / .stop / .self / .once / .propagate
// Sucre d'émission sur le geste : @click.emit.NOM (charge utile via ={expr})
// ============================================================================
/** Suffixes `.mot` reconnus après le nom de l'événement. `emit` n'y est PAS :
 * ce n'est pas un modificateur de dispatch mais l'ouverture du sucre
 * d'émission, qui consomme le segment SUIVANT (le nom émis) — cette liste ne
 * sert qu'à la garde anti-faute-de-frappe juste en dessous. */
const EVENT_MODIFIERS = ['prevent', 'stop', 'self', 'once', 'propagate']

/** Nom émissible : identifiant, tirets et deux-points admis (`row-selected`,
 * `mjs:done`) ; JAMAIS de point (c'est le séparateur de segments) ni
 * d'apostrophe (le nom est injecté dans une chaîne simple-quote). */
const EMIT_NAME_RE = /^[A-Za-z_][\w:-]*$/

function eventListener(env: AttrCtx): AttrResult {
  const id = env.id ?? `e${++state.counter}`
  const attrName = env.attrName ?? ''
  const parts = attrName.slice(1).split('.')
  const evt = parts.shift()!

  // `@click.emit.NOM` — « au geste, émets ». Le
  // handler ne fait QUE `µemit 'NOM', <charge>` ; la charge utile vient de
  // `={expr}` (absente → `null` côté runtime). `emit.NOM` CLÔT le nom
  // d'attribut : les modificateurs de dispatch se posent AVANT
  // (`@click.stop.emit.save`), pour que le nom émis se lise toujours en
  // dernier. En aval, RIEN de spécifique : le corps synthétisé emprunte le
  // chemin commun des handlers inline (reconstruction `{for}`, cleanJs, puis
  // sucre `µemit` → `_mjsThis._mjs_emit` dans applyMjsSugarToScript).
  let emitName: string | null = null
  const emitAt = parts.indexOf('emit')
  if (emitAt >= 0) {
    emitName = parts[emitAt + 1] ?? ''
    if (emitAt !== parts.length - 2 || !EMIT_NAME_RE.test(emitName)) {
      throw new Error(t('generator.event-emit-forme', { attrName, evt }))
    }
    parts.splice(emitAt, 2)
  }

  // GARDE MODIFICATEUR INCONNU — la liste des
  // suffixes était consultée par INCLUSION (`parts.includes('stop')`) : un
  // `@click.stopp`, `@click.prevnet`, `@click.emit` compilait en VERT et ne
  // faisait rien, sans un mot. Même famille qu'un `@emit.` mal formé, qui lève
  // déjà : on refuse à la compilation, avec la suggestion quand la faute est à
  // distance ≤2 d'un modificateur réel.
  for (const mod of parts) {
    if (EVENT_MODIFIERS.includes(mod)) continue
    const suggestion = suggestKey(mod, [...EVENT_MODIFIERS, 'emit'])
    const hint = suggestion && suggestion !== mod ? t('generator.hint-modificateur-suggestion', { suggestion }) : ''
    throw new Error(t('generator.event-modificateur-inconnu', { attrName, mod, hint }))
  }

  let modCoffee = ''
  if (parts.includes('prevent')) modCoffee += '  e.preventDefault()\n'
  // `.stop` : stopPropagation() suffit en MJS (un seul handler par nœud/event
  // + un seul routeur → pas de listeners voisins à couper, donc pas besoin de
  // stopImmediatePropagation). Il pose `e.cancelBubble` que le routeur lit
  // pour arrêter sa remontée.
  if (parts.includes('stop'))    modCoffee += '  e.stopPropagation()\n'
  if (parts.includes('self'))    modCoffee += '  return if e.target != el\n'

  let rawContent: string
  if (emitName !== null) {
    // La valeur d'attribut est la CHARGE UTILE — une expression, comme partout
    // ailleurs dans le framework ; le nom, lui, est porté par l'attribut.
    const payload = env.attr.expr != null
      ? env.attr.expr.toString().trim()
      : (env.attr.val != null && env.attr.val !== '')
        ? env.attr.val.toString().replace(/^\{/, '').replace(/\}$/, '').trim()
        : ''
    rawContent = payload ? `µemit '${emitName}', ${payload}` : `µemit '${emitName}'`
  } else if (env.attr.expr != null) {
    rawContent = env.attr.expr.toString().trim()
  } else if (env.attr.val != null && env.attr.val !== '') {
    rawContent = env.attr.val.toString().replace(/^\{/, '').replace(/\}$/, '').trim()
  } else {
    // forme ABRÉGÉE refusée sur un nom d'événement
    // À DEUX-POINTS (`<div @mjs:done>`) : elle synthétise ici un appel à la
    // méthode HOMONYME (`mjs:done(e, el)`), que Civet compile SANS BRONCHER en
    // bare-hash (`{mjs: done(e, el)}`) — un objet jeté à la poubelle, un appel
    // vers une fonction globale `done` qui n'existe pas, et pas la moindre
    // erreur. Même famille que le piège Civet des accolades : ça ne plante pas,
    // ça ment. La forme explicite `@mjs:done={…}`, elle, a toujours été
    // correcte sur ce chemin (table d'événements `{"mjs:done": …}` intacte) —
    // c'est le chemin des macros globales qui la ratait, cf. macros.ts.
    if (evt.includes(':')) throw new Error(t('generator.event-deux-points-abrege', { evt }))
    rawContent = `${evt}(e, el)`
  }

  const cleanedJs = cleanJs(rawContent, env.compiler.externalVars)
  const idx = state.inlines.length

  let reconstructCoffee = ''
  if (env.ctx.loops && env.ctx.loops.length > 0) {
    for (const l of env.ctx.loops) {
      const d = l.depth
      const item = l.item
      const idxVar = l.index
      const iterable = l.iterable
      // Optim #8 — Lit la prop JS `_mjs_idx_N` (posée par compile.ts) au lieu
      // de `getAttribute('data-mjs-idx-N')`. Évite la traversée du DOM attrs.
      // Fallback `?` au cas où la prop n'est pas encore posée (cloneNode initial).
      // Harmonisation Civet — seul point de divergence Coffee/Civet du
      // squelette : l'existentiel binaire Coffee `a ? b` (sans `:`) n'existe
      // pas en Civet (« Failed to parse ») ; Civet exprime le même repli
      // via `??`, que CoffeeScript ne connaît PAS (« unexpected ? »).
      reconstructCoffee += `  __idx_${d} = el._mjs_idx_${d} ${state.templateLang === 'js' ? '?' : '??'} el.getAttribute('data-mjs-idx-${d}')\n`
      reconstructCoffee += `  __arr_${d} = if Array.isArray(${iterable}) then ${iterable} else Object.values(${iterable})\n`
      reconstructCoffee += `  __idx_${d} = +__idx_${d} if Array.isArray(${iterable})\n`
      reconstructCoffee += `  ${item} = __arr_${d}[__idx_${d}]\n`
      reconstructCoffee += `  ${idxVar} = __idx_${d}\n`
    }
  }

  const userCode = dedent(cleanedJs).split('\n').map(l => `  ${l}`).join('\n')
  state.inlines.push(`(e, el) =>\n${modCoffee}${reconstructCoffee}${userCode}`)

  // Auto-passive : pour touchstart/touchmove/wheel, le listener délégué est
  // enregistré `passive` par défaut (scroll fluide). On note ici si un handler
  // de ce type appelle preventDefault (modifier `.prevent` OU appel direct
  // dans le corps) — auquel cas le runtime bascule ce type en non-passif.
  if (PASSIVE_EVENTS.has(evt) &&
      (parts.includes('prevent') || /\bpreventDefault\b/.test(rawContent))) {
    state.eventsWithPrevent.add(evt)
  }

  // Mode délégation : UN seul listener au niveau du composant, routage par
  // remontée `parentNode` (cf. runtime `_mjs_bindEvents`). Par défaut le routeur
  // s'arrête au premier NŒUD porteur (le plus proche).
  //
  // Valeur de route : cf. `registerEventRoute` ci-dessus — `idx` pour un
  // handler simple, `[idx, flags]` avec modificateur de routage (bit 0
  // `.propagate`, bit 1 `.once`), liste si le couple porte déjà une liaison.
  // Aucun listener natif séparé : un seul listener, ça marche aussi pour les
  // events non-bubbling.
  let flags = 0
  if (parts.includes('propagate')) flags |= 1
  if (parts.includes('once'))      flags |= 2
  registerEventRoute(evt, id, idx, flags, 'directive')

  return { id }
}

/** Événements pour lesquels le listener délégué peut être `passive` (scroll
 * fluide). Voir `eventsWithPrevent` dans CompilerState. */
const PASSIVE_EVENTS = new Set(['touchstart', 'touchmove', 'wheel'])

// ============================================================================
// BindingStandard — port de attributes/binding_standard.rb
// Two-way binding via !{$var} : value=!{$x}, checked=!{$ok}, foo=!{$bar}
// Cast suffixes : .number, .int, .float, .string, .bool
// ============================================================================
// Cast de type porté par le NOM de l'attribut (`value.number=!{$n}`) — mêmes
// suffixes sur une balise native et sur un composant, et surtout même SENS
// d'application : uniquement à la remontée (DOM ou enfant → modèle). Le sens
// descendant ne convertit jamais, la valeur vient du modèle et est déjà typée.
const CAST_RE = /\.(number|int|float|string|bool|boolean)$/

function splitCast(attr: string): { base: string; cast?: string } {
  const m = attr.match(CAST_RE)
  return m ? { base: attr.slice(0, -m[0].length), cast: m[1] } : { base: attr }
}

// grammaire du corps des inlines = celle du template (Civet, repli Coffee) :
// `is`/`or` sont valides dans les deux
function castExprFor(cast: string | undefined, raw: string): string {
  switch (cast) {
    case 'number': return `Number(${raw})`
    case 'int':    return `parseInt(${raw}, 10)`
    case 'float':  return `parseFloat(${raw})`
    case 'string': return `String(${raw})`
    case 'bool': case 'boolean':
      return `(${raw} is true or ${raw} is 'true' or ${raw} is '1' or ${raw} is 1)`
    default: return raw
  }
}

function bindingStandard(env: AttrCtx): AttrResult {
  const m = env.rawVal.match(/^!\{(.+)\}$/)
  if (!m) throw new Error(`[binding_standard] expected !{...} pattern, got "${env.rawVal}"`)
  const varExpr = m[1]
  const jsVar = cleanJs(varExpr, env.compiler.externalVars)

  const vars = getEffectVars(varExpr)

  const id = env.id ?? `b${++state.counter}`
  // `env.attrName` peut
  // arriver ICI encore préfixé `@` (`<details @open=!{$x}>` : la règle
  // générale « !{…} → binding_standard », plus haut dans le dispatch, route
  // ICI n'importe quel attribut two-way bien formé SANS jamais retirer un
  // éventuel `@` — le `@` n'est JAMAIS une partie réelle d'un nom d'attribut
  // HTML, seulement la convention MJS. Sans ce retrait, le code généré
  // ciblait littéralement l'attribut `"@open"` (`node.setAttribute('@open',
  // …)`) au lieu du VRAI attribut `"open"` — le `<details>` ne s'ouvrait/
  // fermait JAMAIS réellement en fonction de la variable liée.
  const rawAttr = (env.attrName ?? '').replace(/^@/, '')
  const { base: baseAttr, cast } = splitCast(rawAttr)

  let updateLogic: string
  if (baseAttr === 'value') {
    updateLogic = `if (node.type === 'select-multiple') { ` +
      `const arr = Array.isArray(${jsVar}) ? ${jsVar}.map(String) : []; ` +
      `Array.from(node.options).forEach(o => o.selected = arr.includes(o.value)); ` +
      `} else if (node.value !== ${jsVar}) { node.value = ${jsVar}; }`
  } else if (baseAttr === 'checked') {
    updateLogic = `if (node.checked !== !!${jsVar}) { node.checked = !!${jsVar}; }`
  } else if (MJS_BOOLEAN_PROPS.includes(baseAttr)) {
    // même piège
    // que le défaut historique « booléens jamais retirés » (cf.
    // `_mjs_updAttrNode`) : `setAttribute('open', false)` écrit la CHAÎNE
    // "false", que le navigateur traite comme PRÉSENTE = toujours ouvert.
    // Seule la PROPRIÉTÉ DOM native (`node.open = false`) retire vraiment
    // l'attribut. `checked`/`value` avaient déjà leur cas dédié ci-dessus ;
    // généralisé ici à TOUS les autres booléens connus (`open`, `disabled`,
    // `selected`, `hidden`, `multiple`, `required`, `readonly`, etc.).
    // la réflexion IDL native (`node.open = false` →
    // attribut retiré tout seul) n'existe QUE sur les tags qui portent
    // nativement cette propriété (`<details>` pour `open`, `<button>`/
    // `<input>` pour `disabled`…) : sur un `<div>`/composant custom,
    // l'assignation crée une simple propriété expando, l'attribut reste posé.
    // `hasIdl` se capture AVANT l'assignation (qui créerait sinon elle-même
    // la propriété expando et fausserait le test) ; retrait/pose explicites
    // en secours, sans effet sur un tag qui a déjà la réflexion native. Testé
    // sur le PROTOTYPE (`Object.getPrototypeOf(node)`), pas sur `node` lui-même :
    // cet `updateLogic` retourne à CHAQUE effet (mount ET chaque mutation) — sur
    // l'instance, la toute 1ère assignation crée déjà l'expando, `baseAttr in node`
    // vaudrait alors TOUJOURS vrai dès le 2e passage, sur `<div>` comme sur
    // `<button>` (faux négatif qui bloque définitivement le `setAttribute` de
    // secours). Le prototype (`HTMLButtonElement.prototype`/`HTMLDivElement.prototype`)
    // ne reçoit jamais d'expando d'instance : le test reste stable dans le temps.
    updateLogic = `const hasIdl = '${baseAttr}' in Object.getPrototypeOf(node); if (node.${baseAttr} !== !!${jsVar}) { node.${baseAttr} = !!${jsVar}; } if (!(${jsVar})) { node.removeAttribute('${baseAttr}'); } else if (!hasIdl) { node.setAttribute('${baseAttr}', ''); }`
  } else {
    updateLogic = `if (node.getAttribute('${baseAttr}') !== String(${jsVar})) node.setAttribute('${baseAttr}', ${jsVar});`
  }

  if (env.ctx.type === 'root') {
    const code = `{ const node = this._mjs_nodes.${id}; if(node) { ${updateLogic} } }`
    pushUpdate(env, code, vars)
  } else if (env.ctx.type === 'for') {
    env.ctx.updates.push(`{ const n${env.lid} = __nodes['${env.lid}']; if(n${env.lid}) { let node = n${env.lid}; ${updateLogic} } }`)
    // #5 — un two-way binding dans un {for} vit dans la closure de l'updateFn
    // de ligne, qui ne re-tourne QUE si la loop se reconcilie. Sans ça, muter
    // une var EXTERNE du binding (ex. `@group=!{$choix}` partagé par les
    // lignes, idiome Svelte 6-5) ne met jamais à jour le widget (sens
    // modèle→DOM perdu). On marque ces vars comme structurelles → leur mutation
    // rejoue _mjs_updFor (reconcile), qui ré-applique l'updateFn. `vars` ne
    // contient que les state vars EXTERNES (la variable d'itération n'en est
    // pas une, ni les `item.field`) → select1k (filtered @class) préservé.
    for (const v of vars) state.structVars.add(v)
  } else {
    // ctx.type ni 'root' ni 'for' (branche {await} ; un
    // {if}/{key} imbriqué DEDANS hérite ce ctx.type, transparent pour lui) :
    // seule l'écoute DOM→modèle était câblée plus bas,
    // la lecture modèle→DOM n'était JAMAIS émise — `<input value=!{$v}>` y
    // restait vide, `<select value=!{$v}>` figé sur la 1re option. Même trou
    // que le cas dynamic()/`$var` nu, remède en 2 volets :
    //  (a) pose INITIALE dans `__nodes` — ce code tourne DANS la createFn de
    //      la branche, AVANT que `_mjs_updIf` (mjs_element.ts) ne fusionne les
    //      refs dans `this._mjs_nodes` (encore vide à cet instant).
    //  (b) réactivité ULTÉRIEURE — `_mjs_updAwait` est idempotent (skip si
    //      promesse ET statut inchangés) : `_mjs_renderStruct` ne rejoue donc
    //      JAMAIS le contenu d'une branche déjà réglée. Sans ce volet, `$v`
    //      muté après coup (hors nouveau règlement de la promesse) resterait
    //      sans effet. Même mécanisme que root (`registerEffect` +
    //      `this._mjs_nodes`) — sûr : (a) a toujours fini de tourner avant que
    //      quiconque puisse muter `$v`.
    const initCode = `{ const node = __nodes['${id}']; if(node) { ${updateLogic} } }`
    // <select> : la pose doit attendre les <option> d'un {for} imbriqué —
    // même besoin que `postUpdates` (paths.ts), mais pour du code émis
    // ICI, jamais vu par son parseur HTML. Sentinelle consommée par
    // `splitDeferredUpdates` (compile.ts) : réordonnée après
    // `branchUpdates`+`postUpdates`, jamais dupliquée.
    const isSelectValue = baseAttr === 'value' && (env.node.name ?? '').toLowerCase() === 'select'
    env.ctx.updates.push(isSelectValue ? SELECT_VALUE_DEFER_PREFIX + initCode : initCode)
    const reactiveCode = `{ const node = this._mjs_nodes.${id}; if(node) { ${updateLogic} } }`
    registerEffect(reactiveCode, vars)
  }

  // `open`
  // (`<details>`) ne déclenche NI 'input' NI 'change' quand l'utilisateur
  // clique sur `<summary>` pour ouvrir/fermer — l'événement natif s'appelle
  // 'toggle'. Sans ce cas, le sens DOM→modèle du two-way (`@open=!{$x}`)
  // n'écoutait tout simplement JAMAIS le bon événement — un clic utilisateur
  // ouvrait bien le `<details>` (natif, indépendant de MJS) mais `$x` ne se
  // mettait jamais à jour en retour (moitié du two-way silencieusement morte).
  const evtType = baseAttr === 'checked' ? 'change' : baseAttr === 'open' ? 'toggle' : 'input'

  const castExpr = (raw: string): string => castExprFor(cast, raw)

  let valExtractor: string
  if (baseAttr === 'value') {
    const autoNum = cast ? 'false' : "['number', 'range'].includes(el.type)"
    valExtractor = `if el.type == 'select-multiple' then Array.from(el.selectedOptions).map((o) => o.value) else (if ${autoNum} then Number(el.value) else ${castExpr('el.value')})`
  } else if (baseAttr === 'checked') {
    valExtractor = 'el.checked'
  } else if (MJS_BOOLEAN_PROPS.includes(baseAttr)) {
    // même
    // raisonnement que `checked` : `el.getAttribute('open')` renvoie `''`
    // (chaîne, PAS un booléen) quand présent — `$x` se serait retrouvé à `''`
    // au lieu de `true` après un toggle, une valeur "vraie" mais TYPÉE
    // différemment de ce que le modèle attend (incohérence silencieuse).
    // La PROPRIÉTÉ DOM (`el.open`) renvoie un booléen natif propre.
    valExtractor = `el.${baseAttr}`
  } else {
    valExtractor = castExpr(`el.getAttribute('${baseAttr}')`)
  }

  let reconstructCoffee = ''
  let attrStr = env.attrStr
  if (env.ctx.loops && env.ctx.loops.length > 0) {
    // props posées par l'updateFn (toutes les loops, plus seulement la
    // première) ; l'attrPart interpolé n'est conservé que sans lid (jamais en
    // pratique pour un binding two-way).
    const propPosed = pushIdxPropUpdates(env)
    for (let i = 0; i < env.ctx.loops.length; i++) {
      const l = env.ctx.loops[i]
      const d = l.depth
      if (!propPosed) {
        const attrPart = ` data-mjs-idx-${d}='\${${l.index}}'`
        if (!attrStr.includes(attrPart)) attrStr += attrPart
      }

      // Optim #8 — Lit la prop JS si présente, sinon fallback getAttribute.
      // Harmonisation Civet — seul point de divergence Coffee/Civet du
      // squelette : l'existentiel binaire Coffee `a ? b` (sans `:`) n'existe
      // pas en Civet (« Failed to parse ») ; Civet exprime le même repli
      // via `??`, que CoffeeScript ne connaît PAS (« unexpected ? »).
      reconstructCoffee += `  __idx_${d} = el._mjs_idx_${d} ${state.templateLang === 'js' ? '?' : '??'} el.getAttribute('data-mjs-idx-${d}')\n`
      reconstructCoffee += `  __arr_${d} = if Array.isArray(${l.iterable}) then ${l.iterable} else Object.values(${l.iterable})\n`
      reconstructCoffee += `  ${l.item} = __arr_${d}[__idx_${d}]\n`
      reconstructCoffee += `  ${l.index} = __idx_${d}\n`
    }
  }

  const idx = state.inlines.length
  let inlineBody = `  return if el and el != e.target\n`
  inlineBody += reconstructCoffee
  inlineBody += `  ${jsVar} = ${valExtractor}\n`
  state.inlines.push(`(e, el) =>\n${inlineBody}`)

  registerEventRoute(evtType, id, idx, 0, 'binding')

  attrStr += ` ${baseAttr}=''`
  return { id, attrStr }
}
// ============================================================================
// BindingDimensions — port de attributes/binding_dimensions.rb
// clientWidth/Height etc. avec ResizeObserver
// ============================================================================
function bindingDimensions(env: AttrCtx): AttrResult {
  const attrName = env.attrName ?? ''
  const m = env.rawVal.match(/^!\{(.+)\}$/)
  if (!m) return { id: env.id }
  const varExpr = m[1]
  const jsVar = cleanJs(varExpr, env.compiler.externalVars)
  const id = env.id ?? `d${++state.counter}`

  let attrStr = env.attrStr
  let reconstructJs = ''
  if (env.ctx.loops && env.ctx.loops.length > 0) {
    const propPosed = pushIdxPropUpdates(env)
    for (const l of env.ctx.loops) {
      const d = l.depth
      if (!propPosed) {
        const attrPart = ` data-mjs-idx-${d}='\${${l.index}}'`
        if (!attrStr.includes(attrPart)) attrStr += attrPart
      }
      // Optim #8 — Read direct via prop JS, fallback getAttribute.
      reconstructJs += `const __idx_${d} = t._mjs_idx_${d} != null ? t._mjs_idx_${d} : t.getAttribute('data-mjs-idx-${d}'); `
      reconstructJs += `const __arr_${d} = Array.isArray(${l.iterable}) ? ${l.iterable} : Object.values(${l.iterable}); `
      reconstructJs += `let ${l.item} = __arr_${d}[__idx_${d}]; `
      reconstructJs += `let ${l.index} = __idx_${d}; `
    }
  }

  // Plus de Proxy → une assignation brute `$.x = v` met à jour _state
  // mais NE réinvalide PAS (les effets texte ne se relancent pas). L'écriture
  // state→ doit passer par `µ._set(ref, 'x', v)` qui appelle `_mjs_invalidate('x')`.
  // Cas `for` : PAS de `item.field` (l'item est déjà un Proxy vivant posé par
  // `_mjs_wrapDeep` — une assignation brute dessus notifie tout seul, comportement
  // inchangé, aucune régression). MAIS un `$.simpleVar` TOP-LEVEL/PARTAGÉ lié
  // depuis un `{for}` (ex. `{for item in $items}<div clientWidth=!{$sharedWidth}>`,
  // un widget partagé entre toutes les lignes) restait INERTE — **vérifié
  // empiriquement** (`_state.sharedWidth` mutait bien à 222, mais AUCUN texte
  // interpolé `{$sharedWidth}` ne se re-rendait) : `_state` est un objet
  // ORDINAIRE (pas de Proxy racine), l'assignation brute la mute sans
  // jamais passer par `_mjs_invalidate`. Fix : `_mjsThis` (capturé par closure
  // depuis `init()`, cf. template.ts — RÉFÉRENCE STABLE au composant, déjà
  // utilisée ailleurs dans ce fichier en contexte `for`, ex. lignes ~167/180 —
  // sans dépendre du `this` de la closure ResizeObserver) route vers `µ._set`
  // dès que la cible est un `$.simpleVar`, peu importe root ou for.
  const simpleVar = /^\$\.([A-Za-z_$][\w$]*)$/.exec(jsVar)
  const buildSetup = (thisRef: string | null): string => {
    const writeBack = thisRef && simpleVar
      ? `µ._set(${thisRef}, '${simpleVar[1]}', t.${attrName});`
      : `${jsVar} = t.${attrName};`
    return `node._mjs_ro_${attrName} ??= false; ` +
      `if (!node._mjs_ro_${attrName}) { ` +
      `node._mjs_ro_${attrName} = true; ` +
      `const ro = new ResizeObserver((entries) => { ` +
      `for (let entry of entries) { ` +
      `const t = entry.target; ` +
      `${reconstructJs}` +
      `if (${jsVar} !== t.${attrName}) { ${writeBack} } ` +
      `} ` +
      `}); ` +
      `ro.observe(node); ` +
      `const t = node; ${reconstructJs} ` +
      `if (${jsVar} !== t.${attrName}) { ${writeBack} } ` +
      `}`
  }

  if (env.ctx.type === 'root') {
    // Setup-only : pas de var dépendance, mais doit s'exécuter au mount.
    // On l'enregistre sans vars → seul `_mjs_effectsAll` au mount initial le tire.
    pushUpdate(env, `{ const node = this._mjs_nodes.${id}; if (node) { ${buildSetup('this')} } }`, [])
  } else if (env.ctx.type === 'for') {
    env.ctx.updates.push(`{ const node = __nodes['${env.lid}']; if (node) { ${buildSetup(simpleVar ? '_mjsThis' : null)} } }`)
  }
  return { id, attrStr }
}

// ============================================================================
// BindingMedia — port de attributes/binding_media.rb
// currentTime, duration, paused, volume, muted, playbackRate
// ============================================================================
function bindingMedia(env: AttrCtx): AttrResult {
  const attrName = env.attrName ?? ''
  const m = env.rawVal.match(/^!\{(.+)\}$/)
  if (!m) return { id: env.id }
  const varExpr = m[1]
  const jsVar = cleanJs(varExpr, env.compiler.externalVars)

  const vars = getEffectVars(varExpr)

  const id = env.id ?? `m${++state.counter}`

  const mapping: Record<string, [string, string[]]> = {
    currentTime:  ['currentTime',  ['timeupdate']],
    duration:     ['duration',     ['durationchange']],
    paused:       ['paused',       ['play', 'pause']],
    volume:       ['volume',       ['volumechange']],
    muted:        ['muted',        ['volumechange']],
    playbackRate: ['playbackRate', ['ratechange']],
  }
  const [prop, evts] = mapping[attrName] ?? ['', []]

  let updateLogic: string
  if (prop === 'currentTime') {
    updateLogic = `if (Math.abs(node.currentTime - ${jsVar}) > 0.05) node.currentTime = ${jsVar};`
  } else if (prop === 'paused') {
    updateLogic = `if (node.paused !== !!${jsVar}) { ` +
      `if (${jsVar}) { node.pause(); } ` +
      `else { const p = node.play(); if(p && p.catch) p.catch(() => {}); } }`
  } else {
    updateLogic = `if (node.${prop} !== ${jsVar}) node.${prop} = ${jsVar};`
  }

  if (prop !== 'duration') {
    if (env.ctx.type === 'root') {
      const code = `{ const node = this._mjs_nodes.${id}; if(node) { ${updateLogic} } }`
      pushUpdate(env, code, vars)
    } else if (env.ctx.type === 'for') {
      env.ctx.updates.push(`{ const n${env.lid} = __nodes['${env.lid}']; if(n${env.lid}) { let node = n${env.lid}; ${updateLogic} } }`)
      // média two-way lié à une var externe en row
      // (`paused=!{$playing}`) : sans `structVars`, figé à vie sur mutation.
      for (const v of vars) state.structVars.add(v)
    }
  }

  let attrStr = env.attrStr
  let reconstructCoffee = ''
  if (env.ctx.loops && env.ctx.loops.length > 0) {
    const propPosed = pushIdxPropUpdates(env)
    for (const l of env.ctx.loops) {
      const d = l.depth
      if (!propPosed) {
        const attrPart = ` data-mjs-idx-${d}='\${${l.index}}'`
        if (!attrStr.includes(attrPart)) attrStr += attrPart
      }
      // Optim #8 — Read direct prop JS, fallback getAttribute.
      // Harmonisation Civet — seul point de divergence Coffee/Civet du
      // squelette : l'existentiel binaire Coffee `a ? b` (sans `:`) n'existe
      // pas en Civet (« Failed to parse ») ; Civet exprime le même repli
      // via `??`, que CoffeeScript ne connaît PAS (« unexpected ? »).
      reconstructCoffee += `  __idx_${d} = el._mjs_idx_${d} ${state.templateLang === 'js' ? '?' : '??'} el.getAttribute('data-mjs-idx-${d}')\n`
      reconstructCoffee += `  __arr_${d} = if Array.isArray(${l.iterable}) then ${l.iterable} else Object.values(${l.iterable})\n`
      reconstructCoffee += `  ${l.item} = __arr_${d}[__idx_${d}]\n`
      reconstructCoffee += `  ${l.index} = __idx_${d}\n`
    }
  }

  const idx = state.inlines.length
  let inlineBody = `  return if el and el != e.target\n`
  inlineBody += reconstructCoffee
  inlineBody += `  ${jsVar} = el.${prop}\n`
  state.inlines.push(`(e, el) =>\n${inlineBody}`)

  for (const evt of evts) registerEventRoute(evt, id, idx, 0, 'binding')

  return { id, attrStr }
}

// ============================================================================
// BindingContent — port de attributes/binding_contenteditable.rb
// @html=!{$x} → innerHTML, @text=!{$x} → textContent
// ============================================================================
function bindingContent(env: AttrCtx): AttrResult {
  const id = env.id ?? `c${++state.counter}`
  const m = env.rawVal.match(/^!\{(.+)\}$/)
  if (!m) return { id }
  const varName = m[1]
  const jsVar = cleanJs(varName, env.compiler.externalVars)
  const prop = env.attrName === '@html' ? 'innerHTML' : 'textContent'

  // SEUL binding two-way sans `reconstructCoffee` :
  // dans un `{for item in $notes}<div contenteditable @text=!{item.txt}>`,
  // l'inline émis était `item.txt = el.textContent` — mais l'inline est un
  // handler NU `(e, el) => {...}`, sans AUCUN accès à `item` dans son propre
  // scope (TypeError « item is not defined », ou pire : écrase un `item`
  // top-level homonyme du script si un tel nom existe). Fix : même
  // reconstruction que `bindingStandard`/`bindingGroup` (ré-hydrate
  // `item`/`index` depuis `data-mjs-idx-N` avant d'écrire).
  let attrStr = env.attrStr
  let reconstructCoffee = ''
  if (env.ctx.loops && env.ctx.loops.length > 0) {
    const propPosed = pushIdxPropUpdates(env)
    for (const l of env.ctx.loops) {
      const d = l.depth
      if (!propPosed) {
        const attrPart = ` data-mjs-idx-${d}='\${${l.index}}'`
        if (!attrStr.includes(attrPart)) attrStr += attrPart
      }
      // Harmonisation Civet — seul point de divergence Coffee/Civet du
      // squelette : l'existentiel binaire Coffee `a ? b` (sans `:`) n'existe
      // pas en Civet (« Failed to parse ») ; Civet exprime le même repli
      // via `??`, que CoffeeScript ne connaît PAS (« unexpected ? »).
      reconstructCoffee += `  __idx_${d} = el._mjs_idx_${d} ${state.templateLang === 'js' ? '?' : '??'} el.getAttribute('data-mjs-idx-${d}')\n`
      reconstructCoffee += `  __arr_${d} = if Array.isArray(${l.iterable}) then ${l.iterable} else Object.values(${l.iterable})\n`
      reconstructCoffee += `  ${l.item} = __arr_${d}[__idx_${d}]\n`
      reconstructCoffee += `  ${l.index} = __idx_${d}\n`
    }
  }

  const idx = state.inlines.length
  let inlineBody = `  return if el and el != e.target\n`
  inlineBody += reconstructCoffee
  inlineBody += `  ${varName} = el.${prop}\n`
  state.inlines.push(`(e, el) =>\n${inlineBody}`)

  registerEventRoute('input', id, idx, 0, 'binding')

  const vars = getEffectVars(varName)
  const needsAlias = varName.includes('@@') || varName.includes('$store') ||
                     varName.includes('$$') || varName.includes('$__')
  const ptr = needsAlias ? '_mjsThis' : 'this'

  if (env.ctx.type === 'root') {
    const code = `{ ` +
      `const node = ${ptr}._mjs_nodes['${id}']; ` +
      `if (node && node.${prop} !== String(${jsVar})) node.${prop} = String(${jsVar}); ` +
      `}`
    pushUpdate(env, code, vars)
  } else if (env.ctx.type === 'for') {
    env.ctx.updates.push(`{ ` +
      `const node = __nodes['${env.lid}']; ` +
      `if (node && node.${prop} !== String(${jsVar})) node.${prop} = String(${jsVar}); ` +
      `}`)
    for (const v of vars) state.structVars.add(v)
  } else {
    // ctx.type ni 'root' ni 'for' (branche
    // {await} ; un {if}/{key} imbriqué DEDANS hérite ce ctx.type, transparent
    // pour lui) : `env.lid` n'existe QUE si `ctx.loops.length > 0` (compile.ts
    // ~l.292-295) — utilisé tel quel ici, le code généré contenait
    // `__nodes['null']` littéral, jamais le bon nœud (`textContent`/`innerHTML`
    // vide au montage). Même remède que bindingStandard : (a) pose INITIALE
    // via `__nodes[id]` (le `mjs-id` du nœud, posé par `compileTag`
    // indépendamment de `{for}`) — tourne dans la createFn de la branche, AVANT
    // que `_mjs_updIf` (mjs_element.ts) ne fusionne les refs dans `this._mjs_nodes`.
    // (b) réactivité ULTÉRIEURE via `registerEffect` + `this._mjs_nodes[id]` (même
    // `ptr` que la pose root ci-dessus, pour les var `@@`/`$store`/`$$`/`$__`)
    // — `_mjs_updAwait` étant idempotent, `$t`/`$h` muté après coup resterait sans
    // effet sans ce volet.
    const initCode = `{ ` +
      `const node = __nodes['${id}']; ` +
      `if (node && node.${prop} !== String(${jsVar})) node.${prop} = String(${jsVar}); ` +
      `}`
    env.ctx.updates.push(initCode)
    const reactiveCode = `{ ` +
      `const node = ${ptr}._mjs_nodes['${id}']; ` +
      `if (node && node.${prop} !== String(${jsVar})) node.${prop} = String(${jsVar}); ` +
      `}`
    registerEffect(reactiveCode, vars)
  }
  return { id, attrStr }
}

// ============================================================================
// BindingGroup — port de attributes/binding_group.rb
// @group=!{$choice} pour radios/checkboxes, avec cast suffix optionnel
// ============================================================================
function bindingGroup(env: AttrCtx): AttrResult {
  const m = env.rawVal.match(/^!\{(.+)\}$/)
  if (!m) return { id: env.id }
  const varExpr = m[1]
  const jsVar = cleanJs(varExpr, env.compiler.externalVars)

  const vars = getEffectVars(varExpr)

  const rawAttr = env.attrName ?? ''
  const cast = rawAttr.match(/\.(number|int|float|string|bool|boolean)$/)?.[1]

  const pureVarName = varExpr.replace(/^\$/, '').replace(/[^a-zA-Z0-9_]/g, '-')
  const id = env.id ?? `g${++state.counter}`

  const updateLogic = `if (node.type === 'radio') { ` +
    `node.checked = (node.value === String(${jsVar})); ` +
    `} else if (node.type === 'checkbox') { ` +
    `node.checked = (Array.isArray(${jsVar}) && ${jsVar}.map(String).includes(node.value)); ` +
    `}`

  if (env.ctx.type === 'root') {
    const code = `{ const node = this._mjs_nodes.${id}; if(node) { ${updateLogic} } }`
    pushUpdate(env, code, vars)
  } else if (env.ctx.type === 'for') {
    // le `name='mjs-grp-...'` posé plus bas
    // (attrStr) est STATIQUE : dérivé du seul TEXTE de l'expression
    // (`pureVarName`), donc IDENTIQUE sur toutes les rows du template partagé
    // (cloné par instance). Deux `<input type="radio" @group=!{row.rep}>`
    // dans deux rows différentes recevaient le MÊME `name` → l'exclusivité
    // radio NATIVE jouait ENTRE rows (cocher la question 2 décochait
    // visuellement la question 1).
    //
    // MAIS ce suffixe INCONDITIONNEL cassait l'idiome
    // canonique `{for opt in $menu}<input type="radio" @group=!{$choice}>` (une
    // option par row, UN groupe partagé) : `name` différent par row → navigation
    // flèches morte (groupes de 1), Tab s'arrête sur chaque radio, soumission par
    // `name` cassée. On ne suffixe donc QUE si l'expression liée DÉPEND de la
    // boucle (item/index libre dans `varExpr` → groupes distincts VOULUS) ; une
    // var externe partagée garde le `name` statique. En imbriqué : TOUS les index
    // concaténés (sinon collisions entre itérations du parent, l'ancien code ne
    // prenait que le DERNIER).
    const loopsGrp = env.ctx.loops ?? []
    const dependsOnLoop = loopsGrp.some((l) => {
      const names = [l.item, l.index].filter(Boolean) as string[]
      return names.some((nm) => new RegExp(`(?<![\\w.$])${nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(varExpr))
    })
    const uniqueSuffix = dependsOnLoop ? loopsGrp.map((l) => `-\${${l.index}}`).join('') : ''
    const updateLogicFor = uniqueSuffix
      ? `node.name = \`mjs-grp-${pureVarName}${uniqueSuffix}\`; ${updateLogic}`
      : updateLogic
    env.ctx.updates.push(`{ const n${env.lid} = __nodes['${env.lid}']; if(n${env.lid}) { let node = n${env.lid}; ${updateLogicFor} } }`)
    // #5 — cf. bindingStandard : un @group two-way dans un {for} (radios /
    // checkboxes partageant une var, idiome Svelte 6-5/6-6) doit re-rendre le
    // widget quand la var mute. On marque ses vars externes comme structurelles.
    for (const v of vars) state.structVars.add(v)
  } else {
    // ctx.type ni 'root' ni 'for' (branche
    // {await} ; un {if}/{key} imbriqué DEDANS hérite ce ctx.type, transparent
    // pour lui) : AUCUNE branche n'existait ici — le sens modèle→DOM était
    // totalement absent (`node.checked = …` jamais émis, `ra.checked=false`
    // malgré `$choix='b'`), radio ET checkbox groupée (tableau). Même remède
    // que bindingStandard (cf. bindingContent, juste au-dessus) :
    // (a) pose INITIALE via `__nodes[id]` dans la createFn de la branche,
    // AVANT que `_mjs_updIf` (mjs_element.ts) ne fusionne les refs dans
    // `this._mjs_nodes`. (b) réactivité ULTÉRIEURE via `registerEffect` +
    // `this._mjs_nodes[id]` (`_mjs_updAwait` idempotent, ne rejoue jamais son contenu
    // tout seul). Pas de suffixe `name` dynamique ici (réservé au `{for}`,
    // ci-dessus) : une branche {await} ne clone pas de rows.
    const initCode = `{ const node = __nodes['${id}']; if(node) { ${updateLogic} } }`
    env.ctx.updates.push(initCode)
    const reactiveCode = `{ const node = this._mjs_nodes.${id}; if(node) { ${updateLogic} } }`
    registerEffect(reactiveCode, vars)
  }

  let attrStr = env.attrStr
  let reconstructCoffee = ''
  if (env.ctx.loops && env.ctx.loops.length > 0) {
    const propPosed = pushIdxPropUpdates(env)
    for (const l of env.ctx.loops) {
      const d = l.depth
      if (!propPosed) {
        const attrPart = ` data-mjs-idx-${d}='\${${l.index}}'`
        if (!attrStr.includes(attrPart)) attrStr += attrPart
      }
      // Optim #8 — Read direct prop JS, fallback getAttribute.
      // Harmonisation Civet — seul point de divergence Coffee/Civet du
      // squelette : l'existentiel binaire Coffee `a ? b` (sans `:`) n'existe
      // pas en Civet (« Failed to parse ») ; Civet exprime le même repli
      // via `??`, que CoffeeScript ne connaît PAS (« unexpected ? »).
      reconstructCoffee += `  __idx_${d} = el._mjs_idx_${d} ${state.templateLang === 'js' ? '?' : '??'} el.getAttribute('data-mjs-idx-${d}')\n`
      reconstructCoffee += `  __arr_${d} = if Array.isArray(${l.iterable}) then ${l.iterable} else Object.values(${l.iterable})\n`
      reconstructCoffee += `  ${l.item} = __arr_${d}[__idx_${d}]\n`
      reconstructCoffee += `  ${l.index} = __idx_${d}\n`
    }
  }

  const idx = state.inlines.length
  let inlineBody = `  return if el and el != e.target\n`
  inlineBody += reconstructCoffee
  inlineBody += `  v = el.value\n`
  switch (cast) {
    case 'number': inlineBody += `  v = Number(v)\n`; break
    case 'int':    inlineBody += `  v = parseInt(v, 10)\n`; break
    case 'float':  inlineBody += `  v = parseFloat(v)\n`; break
    case 'string': inlineBody += `  v = String(v)\n`; break
    case 'bool':
    case 'boolean': inlineBody += `  v = (v is true or v is 'true' or v is '1' or v is 1)\n`; break
  }
  inlineBody += `  if el.type == 'radio'\n`
  inlineBody += `    ${jsVar} = v\n`
  inlineBody += `  else if el.type == 'checkbox'\n`
  inlineBody += `    arr = if Array.isArray(${jsVar}) then [...${jsVar}] else []\n`
  inlineBody += `    if el.checked\n`
  inlineBody += `      arr.push(v) if not arr.includes(v)\n`
  inlineBody += `    else\n`
  inlineBody += `      arr = arr.filter((i) => String(i) != String(v))\n`
  inlineBody += `    ${jsVar} = arr\n`

  state.inlines.push(`(e, el) =>\n${inlineBody}`)

  registerEventRoute('change', id, idx, 0, 'binding')

  attrStr += ` name='mjs-grp-${pureVarName}'`
  return { id, attrStr }
}

// ============================================================================
// BindingThis — port de attributes/binding_this.rb
// @this=!{$ref} ou @this={$ref} → assigne le DOM node à la variable
// ============================================================================
function bindingThis(env: AttrCtx): AttrResult {
  const m = env.rawVal.match(/^!?\{(.+)\}$/)
  if (!m) return { id: env.id }
  const varExpr = m[1]
  // Point d'attention (perf) — une référence DOM `@this` devrait être une variable
  // SANS `$` : dans MJS `$` = RÉACTIF. Donc `@this=!{$ref}` rend la ref réactive et
  // chaque écriture de sous-propriété (`$ref.style.x = v`) passe par `µ._mjs_deepSet`
  // (notify + invalidate) au lieu d'une écriture brute directe. Sur un hot-path
  // (HUD, jeu, boucle), le surcoût est massif. On AVERTIT à la compilation et on
  // pointe la doc — la solution est juste d'enlever le `$` (`@this=!{ref}`).
  const _refSugar = varExpr.trim().match(/^\$\.?([A-Za-z_$][\w$]*)$/)
  if (_refSugar) {
    const _plain = _refSugar[1]
    console.warn(t('generator.this-ref-reactive', { varExpr: varExpr.trim(), plain: _plain }))
  }
  const jsVar = cleanJs(varExpr, env.compiler.externalVars)
  const id = env.id ?? `t${++state.counter}`

  // Auto-déclaration : `@this=!{canvas}` avec une variable NUE (sans `$`, donc
  // non réactive). Le binding émet `canvas = node` et le script lit `canvas`,
  // mais rien ne DÉCLARE `canvas` → ReferenceError en module strict. On collecte
  // l'identifiant nu top-level pour que le transpiler hisse un `let canvas` en
  // tête de `init` (dédupliqué si le script le déclare déjà). On exclut le `for`
  // (scope par-itération distinct) et les chemins (`obj.x`, `$x`).
  if (env.ctx.type === 'root' && /^[A-Za-z_][\w$]*$/.test(varExpr.trim())) {
    state.refVars.add(varExpr.trim())
  }

  // `@this=!` installe un teardown `_mjs_ref_td` → destroy walker requis.
  state.hasDestroyHooks = true
  const updateLogicRaw = `
    if (${jsVar} !== node) {
      ${jsVar} = node;
      if (!node._mjs_ref_td) {
        node._mjs_ref_td = () => { if (${jsVar} === node) ${jsVar} = null; };
        this._mjs_attachments = this._mjs_attachments || new Set();
        this._mjs_attachments.add(node._mjs_ref_td);
      }
    }
  `
  const cleanLogic = dedent(updateLogicRaw).replace(/\n/g, ' ')

  if (env.ctx.type === 'root') {
    // Setup-only : pas de var dépendance, exécuté au mount initial.
    pushUpdate(env, `{ const node = this._mjs_nodes.${id}; if (node) { ${cleanLogic} } }`, [])
  } else if (env.ctx.type === 'for') {
    env.ctx.updates.push(`{ const n${env.lid} = __nodes['${env.lid}']; if (n${env.lid}) { let node = n${env.lid}; ${cleanLogic} } }`)
  }
  return { id }
}

// ============================================================================
// BindingComponent — port de attributes/binding_component.rb
// <mjs-foo bar=!{$x}> two-way binding via mjs-bind:bar event
// ============================================================================
function bindingComponent(env: AttrCtx): AttrResult {
  // le cast était ignoré EN SILENCE ici : `attrName` gardait son suffixe,
  // la prop posée sur l'enfant s'appelait littéralement « value.number » (qu'il
  // ne connaît pas) et l'event écouté « mjs-bind:value.number » n'était jamais
  // émis (l'enfant émet sur le nom de sa clé d'état) — liaison morte des DEUX
  // côtés. On dépouille le nom, et on convertit à la remontée seulement.
  const { base: attrName, cast } = splitCast(env.attrName ?? '')
  const m = env.rawVal.match(/^!\{(.+)\}$/)
  if (!m) return { id: env.id }
  const varExpr = m[1]
  const jsVar = cleanJs(varExpr, env.compiler.externalVars)

  const vars = getEffectVars(varExpr)

  const id = env.id ?? `c${++state.counter}`

  let attrStr = env.attrStr
  let reconstructCoffee = ''
  if (env.ctx.loops && env.ctx.loops.length > 0) {
    const propPosed = pushIdxPropUpdates(env)
    for (const l of env.ctx.loops) {
      const d = l.depth
      if (!propPosed) {
        const attrPart = ` data-mjs-idx-${d}='\${${l.index}}'`
        if (!attrStr.includes(attrPart)) attrStr += attrPart
      }
      // Optim #8 — Read direct prop JS, fallback getAttribute.
      // Harmonisation Civet — seul point de divergence Coffee/Civet du
      // squelette : l'existentiel binaire Coffee `a ? b` (sans `:`) n'existe
      // pas en Civet (« Failed to parse ») ; Civet exprime le même repli
      // via `??`, que CoffeeScript ne connaît PAS (« unexpected ? »).
      reconstructCoffee += `  __idx_${d} = el._mjs_idx_${d} ${state.templateLang === 'js' ? '?' : '??'} el.getAttribute('data-mjs-idx-${d}')\n`
      reconstructCoffee += `  __arr_${d} = if Array.isArray(${l.iterable}) then ${l.iterable} else Object.values(${l.iterable})\n`
      reconstructCoffee += `  ${l.item} = __arr_${d}[__idx_${d}]\n`
      reconstructCoffee += `  ${l.index} = __idx_${d}\n`
    }
  }

  const updateLogic = `(node._mjs_binds ??= new Set()).add('${attrName}'); ` +
    `if (node._set) { ` +
    `  if (node._state && node._state['${attrName}'] !== ${jsVar}) node._set('${attrName}', ${jsVar}); ` +
    // `_set` pose la valeur en JS PUR (aucune trace HTML) : côté client
    // sans effet (le composant vit déjà en mémoire), mais côté SERVEUR
    // (`µ._isServer`) la valeur ne serait alors JAMAIS sérialisée dans le HTML
    // prérendu, donc jamais rejouée à l'hydratation (composant enfant reconstruit
    // à froid, prop two-way perdue, cf. mjs-color qui exige `value`).
    `  if (µ._isServer) { const __ssrVal = typeof ${jsVar} === 'object' ? JSON.stringify(${jsVar}) : String(${jsVar}); if (node.getAttribute('${attrName}') !== __ssrVal) node.setAttribute('${attrName}', __ssrVal); } ` +
    `} else { ` +
    `  const val = typeof ${jsVar} === 'object' ? JSON.stringify(${jsVar}) : String(${jsVar}); ` +
    `  if (node.getAttribute('${attrName}') !== val) node.setAttribute('${attrName}', val); ` +
    `}`

  if (env.ctx.type === 'root') {
    const code = `{ const node = this._mjs_nodes.${id}; if(node) { ${updateLogic} } }`
    pushUpdate(env, code, vars)
    // rejoué SYNCHRONEMENT dans `init()` (state.initialPropBinds,
    // cf. sa déclaration) : même code, idempotent (garde `!==` déjà dedans).
    state.initialPropBinds.push(code)
  } else if (env.ctx.type === 'for') {
    env.ctx.updates.push(`const n${env.lid} = __nodes['${env.lid}']; if(n${env.lid}) { let node = n${env.lid}; ${updateLogic} }`)
    // prop de composant liée à une var externe en row
    // (`<mjs-x foo={$shared}>`) : sans `structVars`, figée à vie sur mutation.
    for (const v of vars) state.structVars.add(v)
  }

  const idx = state.inlines.length
  let inlineBody = `  return if el and el != e.target\n`
  inlineBody += reconstructCoffee
  // Convention MJS : l'event `mjs-bind:X` porte la valeur dans `e.data`
  // (cf. `_mjs_notifyMutation` runtime, `_bindEv.data = ...`). PAS `e.detail`.
  if (cast) {
    inlineBody += `  __mjsCast = ${castExprFor(cast, 'e.data')}\n`
    inlineBody += `  ${jsVar} = __mjsCast if ${jsVar} != __mjsCast\n`
  } else {
    inlineBody += `  ${jsVar} = e.data if ${jsVar} != e.data\n`
  }
  state.inlines.push(`(e, el) =>\n${inlineBody}`)

  registerEventRoute(`mjs-bind:${attrName}`, id, idx, 0, 'binding')

  return { id, attrStr }
}

// ============================================================================
// BindingTransition — port de attributes/binding_transition.rb
// @transition.X / @in.X / @out.X / @introstart / @introend / @outrostart / @outroend
// La fonction est appelée pour chaque attr lié, mais ne doit produire le code
// qu'une seule fois par node (cf. transitionsProcessed Set).
// ============================================================================
function bindingTransition(env: AttrCtx): AttrResult {
  const id = env.id ?? `t${++state.counter}`
  const trackingKey = `${id}::${env.lid ?? ''}`
  if (state.transitionsProcessed.has(trackingKey)) {
    return { id }
  }
  state.transitionsProcessed.add(trackingKey)

  const attrs = env.node.attrs ?? []
  const tAttr   = attrs.find((a: any) => (a.name ?? '').startsWith('@transition.'))
  const inAttr  = attrs.find((a: any) => (a.name ?? '').startsWith('@in.'))
  const outAttr = attrs.find((a: any) => (a.name ?? '').startsWith('@out.'))
  if (!tAttr && !inAttr && !outAttr) return { id }

  const modifiers: string[] = []
  for (const a of [tAttr, inAttr, outAttr]) {
    if (!a) continue
    const parts = (a.name ?? '').split('.')
    modifiers.push(...parts.slice(2))
  }
  const isGlobal = modifiers.includes('global')
  const isShared = modifiers.includes('shared')

  // `@transition/@in/@out` installent `_mjs_intro/_mjs_outro/_mjs_global`.
  state.hasDestroyHooks = true
  const cbs: Record<string, any> = {
    introstart: attrs.find((a: any) => a.name === '@introstart'),
    introend:   attrs.find((a: any) => a.name === '@introend'),
    outrostart: attrs.find((a: any) => a.name === '@outrostart'),
    outroend:   attrs.find((a: any) => a.name === '@outroend'),
  }

  const getVal = (a: any): string => {
    let val = a.expr ?? a.val ?? ''
    val = val.toString().trim()
    if (val.startsWith('{') && val.endsWith('}')) val = val.slice(1, -1)
    if (val.includes('Generated by CoffeeScript')) {
      val = val.split('\n').filter((l: string) => !l.includes('Generated by CoffeeScript')).join(' ')
    }
    val = val.trim()
    if (val.endsWith(';')) val = val.slice(0, -1)
    return val.trim()
  }

  // Les callbacks contiennent du code utilisateur (`$.x = ...`) — il faut le
  // faire passer par le même pipeline que le script init pour que les
  // assignations déclenchent `µ._set(_mjsThis, …)` et l'invalidation qui va
  // avec. Sans ça, `$.status = 'intro started'` écrit sur `_state` mais
  // n'invalide rien → le binding `{$status}` ne re-render pas.
  const cbAssignments = Object.entries(cbs)
    .filter(([_, a]) => a)
    .map(([key, a]) => {
      // Pas de bare-ref ici : les handlers inline sont compilés PENDANT le walk du
      // template, donc `effectsByVar` est encore partiel → on ne peut pas prouver
      // qu'une ref n'est pas bindée. On laisse `µ._mjs_deepSet` (réactif, correct) ;
      // le hot-path (refresh dans le script principal) est optimisé en ligne 966.
      const body = applyPathTracking(transformReactiveWrites(cleanJs(getVal(a), env.compiler.externalVars)))
      return `node._mjs_cb_${key} = () => { ${body}; };`
    })
    .join(' ')

  const formatAnim = (a: any): string => {
    if (!a) return 'null'
    const parts = (a.name ?? '').split('.')
    const animName = parts[1]
    const argsRaw = getVal(a)
    if (animName) state.usedAnimations.add(animName)
    let args: string
    if (!argsRaw || argsRaw === '') {
      args = '{}'
    } else {
      const cleaned = cleanJs(argsRaw, env.compiler.externalVars).trim()
      args = cleaned.startsWith('{') ? cleaned : `{${cleaned}}`
    }
    return `µ?.anim?.${animName}(${args})`
  }

  let setupCode = ''
  if (tAttr) {
    setupCode = `
      const _raw_t = ${formatAnim(tAttr)};
      const t_cfg = typeof _raw_t === 'function' ? _raw_t() : _raw_t;
      if (t_cfg) {
        if (t_cfg.intro) node._mjs_intro = t_cfg.intro;
        if (t_cfg.outro) node._mjs_outro = t_cfg.outro;
      }
    `
  } else {
    if (inAttr) {
      setupCode += `
        const _raw_in = ${formatAnim(inAttr)};
        const in_cfg = typeof _raw_in === 'function' ? _raw_in() : _raw_in;
        if (in_cfg && in_cfg.intro) node._mjs_intro = in_cfg.intro;
      `
    }
    if (outAttr) {
      setupCode += `
        const _raw_out = ${formatAnim(outAttr)};
        const out_cfg = typeof _raw_out === 'function' ? _raw_out() : _raw_out;
        if (out_cfg && out_cfg.outro) node._mjs_outro = out_cfg.outro;
      `
    }
  }

  const nodeLookup = env.ctx.type !== 'root' && env.lid
    ? `__nodes['${env.lid}']`
    : `this._mjs_nodes.${id}`

  const initialCheck = isGlobal ? 'true' : '!_mjsThis._mjs_initial_render'
  const globalLine   = isGlobal ? 'node._mjs_global = true;' : ''
  const sharedLine   = isShared ? `node._mjs_anim_mode = 'shared';` : ''

  // Pipeline intro : on doit attendre que le node soit dans le DOM ET ait un
  // layout calculé avant de capturer ses dims pour les animations samplées
  // (`slide`/`fly`/`scale`/...). Sans ça, `getComputedStyle` renvoie des
  // strings vides et `offsetHeight = 0` → kf[end] tout à zéro → animation
  // invisible. Cas vécu : item fresh ajouté via `{for}` reconcile, encore
  // dans un fragment détaché au moment où l'update tire.
  //
  // Anti-flash : on applique kf[0] de l'anim SYNC sur le node via WAAPI
  // (`animate([kf[0]], { fill: 'forwards', duration: 0 })`) AVANT le rAF de
  // _mjs_whenLayouted. Comme ça le node reste à l'état initial (opacity:0,
  // height:0, ...) jusqu'à ce que _mjs_playTransition démarre la vraie anim qui
  // overrideras les styles. Cette anim "zero-duration" est cancellée juste
  // avant la vraie pour ne pas interférer avec la capture (getComputedStyle
  // ignore les styles posés par WAAPI une fois cancellée).
  //
  // NOTE: pas de commentaires `//` dans le template ci-dessous — le code est
  // aplati par `.replace(/\s+/g, ' ')` et un `//` mangerait tout le `catch`.
  const jsCode = `
    {
      const node = ${nodeLookup};
      if (node && !node._mjs_transition_init) {
        node._mjs_transition_init = true;
        ${globalLine}
        ${sharedLine}
        ${setupCode}
        ${cbAssignments}
        if (node._mjs_intro && (${initialCheck})) {
          try {
            node._mjs_cb_introstart?.();
            µ._mjs_whenLayouted(node, () => {
              µ._mjs_playTransition(node, node._mjs_intro, 'in')
                .then(() => node._mjs_cb_introend?.())
                .catch(e => console.warn(${JSON.stringify(t('generator.erreur-intro'))}, e));
            });
          } catch(e) { console.error(${JSON.stringify(t('generator.echec-intro'))}, e); }
        }
      }
    }
  `.trim().replace(/\s+/g, ' ')

  env.ctx.updates.push(jsCode)
  return { id }
}

// ============================================================================
// BindingClass — port de attributes/binding_class.rb
// @class{$cond}="cssClass" → toggle CSS class selon condition
//
// **Filtered Dispatch** :
//   Quand `cond` est de la forme `$X CMP item.Y` (ou symétrique) où `$X` est
//   une state var externe à la loop courante et `item.Y` est une propriété
//   du loopItem, on génère un index inverse `_mjs_filt[<X>].idx: Map<item.Y, fn>`.
//   À l'invalidation de `$X`, le runtime lookup directement les 1-2 fns
//   concernées (old/new) au lieu de re-render N rows. Gain massif sur le
//   bench officiel `select1k` (1000 → 2 effects).
// ============================================================================

// Tente de matcher le pattern `$X === item.Y` ou `item.Y === $X`.
// Retourne { externVar, itemAccess } si match, sinon null.
// CMP supportés : ===, ==, !==, !=, <, <=, >, >=.
export function detectFilteredPattern(
  conditionExpr: string,
  loopItem: string,
  externalVars: string[]
): { externVar: string; itemAccess: string; op: string; rev: boolean } | null {
  if (!loopItem) return null
  // Normalise les idiomes Coffee/Civet (`is` → `===`, `isnt` → `!==`,
  // `$x` → `$.x`, `and`/`or`/`not` → `&&`/`||`/`!`) avant de chercher l'op.
  // Sans ça, `@class{$selected is item}` n'est jamais reconnu comme filtered
  // → fallback non-filtered → l'effect global n'est pas registered →
  // le binding ne re-tire jamais sur mutation de `$selected`.
  const trimmed = cleanJs(conditionExpr, externalVars).trim()
  // IMPORTANT : seulement les ops d'ÉGALITÉ (`===` / `==`) sont éligibles au
  // filtered dispatch — l'index inverse `Map<value, fn>` lookup une clé exacte.
  //   - `!==` / `!=` : la condition est vraie pour 999/1000 rows → 999 doivent
  //     être touchés, pas seulement 2. Non éligible.
  //   - `<` / `<=` / `>` / `>=` : couvre une PLAGE de valeurs → indexation par
  //     valeur unique inopérante. Non éligible.
  // On reste donc strict sur `===` et `==`.
  const opPatterns = ['===', '==']
  // Rejet précoce des expressions composées (&&, ||, ?, ternaire, etc.) :
  // si on splite sur `===`, le right peut contenir `$selected && $other`,
  // ce qui passerait l'extractExternVar à null → on retournerait null.
  // Mais autant rejeter en amont pour clarté + perf.
  // Tokens qui indiquent une expression complexe non-éligible :
  //   - `&&`, `||` : compose logique
  //   - `?`, `:` (en dehors d'un objet/array literal) : ternaire
  //   - `!` au début : négation (ex: `!(row.x === $y)`)
  //   - `(` : parens (souvent appel ou groupe) → ambigu, on bypass
  // On accepte uniquement : `<bareSide> OP <bareSide>` ou variants espace.
  if (/[&|?]/.test(trimmed)) return null
  if (/\bnot\b|\band\b|\bor\b/.test(trimmed)) return null  // Coffee logical kw
  if (trimmed.startsWith('!') || trimmed.startsWith('(')) return null
  for (const op of opPatterns) {
    const idx = trimmed.indexOf(op)
    if (idx < 0) continue
    const left = trimmed.slice(0, idx).trim()
    const right = trimmed.slice(idx + op.length).trim()
    if (!left || !right) continue
    // Pas d'op résiduel dans les deux côtés (anti-pattern composé).
    if (/[<>=!]/.test(left) || /[<>=!]/.test(right)) continue
    // Test : `$X` ou `$.X` vs `item.Y`. La var externe peut être `$selected`
    // (forme source) ou `$.selected` (forme post-tokenize).
    const matchExternVar = (s: string): string | null => {
      // `$selected` direct (state var locale)
      let m = s.match(/^\$([a-zA-Z_$][\w$]*)$/)
      if (m) {
        // Skip si c'est une externalVar déclarée
        if (externalVars.includes(`$${m[1]}`)) return null
        return m[1]
      }
      // `$.selected` (forme tokenisée)
      m = s.match(/^\$\.([a-zA-Z_$][\w$]*)$/)
      if (m) return m[1]
      return null
    }
    const matchItemAccess = (s: string): string | null => {
      // `item.field` : clé = primitive `item.field`
      const re = new RegExp(`^${loopItem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.([a-zA-Z_$][\\w$]*)$`)
      const m = s.match(re)
      if (m) return m[1]
      // `item` seul : clé = la référence d'item lui-même (Map stocke des refs).
      // Cas rare mais réaliste : `<a @class{$activeTab === tab}=…>` où `tab` est
      // un objet/string complet. Le sigil "" indique "pas de field" → l'index
      // utilise `${loopItem}` direct comme clé.
      if (s === loopItem) return ''
      return null
    }
    // Cas 1 : extern OP item
    const extL = matchExternVar(left)
    const itemR = matchItemAccess(right)
    if (extL && itemR !== null) {
      return { externVar: extL, itemAccess: itemR, op, rev: false }
    }
    // Cas 2 : item OP extern
    const itemL = matchItemAccess(left)
    const extR = matchExternVar(right)
    if (itemL !== null && extR) {
      return { externVar: extR, itemAccess: itemL, op, rev: true }
    }
  }
  return null
}

// Détecte les expressions filtered-éligibles pour les bindings
// @style.X / @data-X / @aria-X / etc. Deux formes acceptées :
//
//   1) Bool direct : `item.id === $selected`
//      → matchValue / unmatchValue = 'true' / 'false' (utilisable comme bool
//        pour setAttribute, mais aussi mappable à des strings côté caller).
//
//   2) Ternaire : `item.id === $selected ? 'red' : 'black'`
//      → matchValue / unmatchValue = `'red'` / `'black'` (expressions JS brutes).
//
// Le caller décide ensuite comment appliquer ces valeurs (style.X, attr, etc.).
// `null` sinon (fallback : générer le binding normal).
export function detectFilteredValueExpr(
  expr: string,
  loopItem: string,
  externalVars: string[]
): {
  externVar: string
  itemAccess: string
  matchValue: string
  unmatchValue: string
  isBoolean: boolean
} | null {
  if (!expr) return null
  // Idem `detectFilteredPattern` : normalise les idiomes Coffee/Civet pour
  // que `is`/`isnt`/`and`/`or`/`not` ne bloquent pas la détection filtered.
  const trimmed = cleanJs(expr, externalVars).trim()

  // Cas ternaire : on splitte sur le `?` top-level. Attention aux `?` imbriqués
  // (ex : `a ? b : c ? d : e`). On rejette tout ternaire chained pour rester
  // simple — `a ? b : c` strict, sinon fallback.
  // Détecter le `?` top-level : on ne supporte pas les parens/sous-expressions
  // complexes. La cond doit être un pattern filtered détecté.
  const qIdx = trimmed.indexOf('?')
  if (qIdx > 0) {
    const before = trimmed.slice(0, qIdx)
    const after = trimmed.slice(qIdx + 1)
    // Le `:` top-level dans `after` sépare trueVal et falseVal.
    // On ignore les `:` dans des strings (heuristique simple : compte les quotes).
    let depth = 0
    let inStr: string | null = null
    let colonIdx = -1
    for (let i = 0; i < after.length; i++) {
      const c = after[i]
      if (inStr) {
        if (c === inStr && after[i - 1] !== '\\') inStr = null
        continue
      }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') depth--
      else if (c === ':' && depth === 0) { colonIdx = i; break }
      else if (c === '?' && depth === 0) {
        // Ternaire chained → skip (trop complexe pour filtered).
        return null
      }
    }
    if (colonIdx < 0) return null
    const trueVal = after.slice(0, colonIdx).trim()
    const falseVal = after.slice(colonIdx + 1).trim()
    if (!trueVal || !falseVal) return null
    // La cond doit matcher un filtered pattern.
    const filt = detectFilteredPattern(before, loopItem, externalVars)
    if (!filt) return null
    return {
      externVar: filt.externVar,
      itemAccess: filt.itemAccess,
      matchValue: trueVal,
      unmatchValue: falseVal,
      isBoolean: false,
    }
  }

  // Pas de ternaire : essayer un bool direct (l'expression EST le pattern).
  const filt = detectFilteredPattern(trimmed, loopItem, externalVars)
  if (filt) {
    return {
      externVar: filt.externVar,
      itemAccess: filt.itemAccess,
      matchValue: 'true',
      unmatchValue: 'false',
      isBoolean: true,
    }
  }
  return null
}

function bindingClass(env: AttrCtx): AttrResult {
  // `(.+)` gourmand (le nom d'attribut se termine au
  // DERNIER `}`), pas `[^}]+` qui tronquait la condition au 1er `}` :
  // `@class{$a && f({x:1})}` était coupé à `$a && f({x:1`. Aligné sur
  // bindingStyle{cond} et @flip{cond}.
  const m = (env.attrName ?? '').match(/@class\{(.+)\}/)
  if (!m) return { id: env.id }
  const conditionExpr = m[1]
  const className = env.rawVal
  // Site EXPR (condition @class{cond}, même nature qu'un {if}).
  const jsVar = cleanJsExpr(conditionExpr, env.compiler.externalVars, env.compiler.templateLang, env.compiler.moduleName)

  const vars = getEffectVars(conditionExpr)
  const id = env.id ?? `c${++state.counter}`
  // Toggle GARDÉ : ne touche le DOM que si la condition a CHANGÉ pour ce nœud.
  // L'updateFn d'un {for} est ré-exécutée sur TOUTES les lignes à chaque
  // réconciliation → l'ancien `toggle()` inconditionnel faisait 1000 appels
  // DOM no-op par update (profiler : poste de style-recalc sur create/update).
  // L'état est porté par le nœud (`_mjs_cl_<classe>`), partagé entre l'updateFn
  // et la closure du filtered-dispatch — cohérent car les deux écrivent la
  // même classe sur le même nœud.
  const safeCls = className.replace(/[^a-zA-Z0-9_$]/g, '_')
  const guardProp = `node._mjs_cl_${safeCls}`
  // `@class{cond}="foo bar"` (multi-classes) : un token
  // avec espace fait jeter `classList.toggle` (InvalidCharacterError). On émet un
  // toggle par classe (tokens connus au compile). La garde reste sur `safeCls`
  // (valeur combinée) — cohérente entre updateFn et effet filtré.
  const clsTokens = className.trim().split(/\s+/).filter(Boolean)
  const clsToggle = (nodeVar: string, boolExpr: string): string =>
    clsTokens.map((c) => `${nodeVar}.classList.toggle('${c}', ${boolExpr});`).join(' ')
  const updateLogic = `{ const _mjs_tv = !!(${jsVar}); if (${guardProp} !== _mjs_tv) { ${clsToggle('node', '_mjs_tv')} ${guardProp} = _mjs_tv; } }`

  if (env.ctx.type === 'root') {
    const code = `{ const node = this._mjs_nodes.${id}; if(node) { ${updateLogic} } }`
    pushUpdate(env, code, vars)
  } else if (env.ctx.type === 'for') {
    // Tentative de détection du pattern filtered (gain massif sur select1k).
    // On regarde le scope LOCAL : loopItem = dernier item de la chaîne ctx.loops.
    const lastLoop = env.ctx.loops && env.ctx.loops.length > 0
      ? env.ctx.loops[env.ctx.loops.length - 1]
      : null
    const filt = lastLoop
      ? detectFilteredPattern(conditionExpr, lastLoop.item, env.compiler.externalVars ?? [])
      : null

    if (filt) {
      // Code complet (DOM toggle) toujours posé pour data updates (l'updateFn
      // est appelée à chaque mutation de `data`, donc on garde la correction
      // au mount + à chaque insertion). En plus, on enregistre dans l'index
      // inverse pour que `_mjs_invalidate(externVar)` route en O(1) sur 2 rows.
      //
      // L'effect dans `_mjs_effectsByVar.<externVar>` est ajouté plus bas, hors
      // du contexte loop, et utilise un lookup direct via `_mjs_filt[<X>].idx`.
      // ATTENTION : si la même var pilote plusieurs classes ou loops, on doit
      // dispatcher tous les filtres ; ici on enregistre par (externVar, classe).
      // Normalise le className : les `-`, `:`, espaces et autres chars sont remplacés
      // par `_`. La clé n'est plus un nom de propriété (elle indexe `_mjs_filt`), mais
      // la normalisation reste : elle garde des clés lisibles et comparables.
      // `filterKey` (donc le nom de la Map
      // `_mjs_filt[<filterKey>].idx` PARTAGÉE à l'échelle du COMPOSANT) ne dépendait
      // QUE de (var externe, nom de classe) — PAS du nœud. Deux éléments
      // DIFFÉRENTS d'une même row utilisant le même couple (ex. 2 `<td>`
      // voisins avec `@class{item.id === $sel}="hot"`) partageaient donc la
      // MÊME Map, clée par l'item de la row : `__idx.set(__k, n${lid})` du
      // second nœud écrasait l'entrée du premier → seul le DERNIER nœud
      // enregistré réagissait au changement de sélection. `env.lid` (id
      // unique par OCCURRENCE dans le template, déjà utilisé partout dans ce
      // bloc pour `n${env.lid}`) distingue maintenant chaque occurrence.
      const safeClassName = className.replace(/[^a-zA-Z0-9_$]/g, '_')
      const filterKey = `${filt.externVar}__${safeClassName}__${env.lid}`
      // `itemAccess === ''` signale pattern `item` direct (sans `.field`),
      // donc la clé est l'item lui-même (référence/primitive). Map supporte
      // les refs comme clé.
      const keyExpr = filt.itemAccess
        ? `${lastLoop!.item}.${filt.itemAccess}`
        : `${lastLoop!.item}`
      // Anti-leak : on tracke (a) le nom de l'index dans
      // `_mjs_filtIdxKeys` (Set côté instance) pour énumérer les Maps actives au
      // destroy, et (b) la filterKey dans `__nodes._mjs_filterKeys` (par row) pour
      // savoir quelle entrée purger. Le runtime _mjs_reconcileList lit ces deux
      // infos au moment du `cache.delete(oldKey)`.
      // le mémo d'un filtrage par clé vit dans `_mjs_filt` (propriété POINTÉE, donc
      // raccourcie en prod) : la clé n'est plus qu'un texte d'index, jamais un nom
      const idxName = filterKey
      // Optim #1 — On évite de re-créer la closure à chaque updateFn appel.
      // La closure dépend uniquement de `n${env.lid}` (stable par row) et
      // `updateLogic` (statique), donc on ne la pose qu'une fois par (row,
      // key). Si __k change pour un item donné (rare : mutation d'id), on
      // re-créera proprement à ce moment-là.
      // Perf création : on stocke le NŒUD lui-même dans l'index, PAS une
      // closure. Sur le pattern @class filtré (toggle binaire d'UNE classe), la
      // closure `() => toggle` était allouée par ligne (10 000 sur create10k →
      // gros poste GC au profil). Le nœud est sa propre identité : l'effet
      // filtré (plus bas) fait le toggle directement, et la purge runtime
      // compare `idx.get(k) === <nœud>` exactement comme avant (le nœud joue le
      // rôle de l'ancienne fn dans _mjs_filterFns).
      //
      // Propriété de clé : on (re)pose si la clé est inédite OU
      // détenue par une AUTRE row (vol de clé create-avant-destroy). La purge ne
      // delete que si l'entrée est encore la nôtre. Update répété → skip.
      env.ctx.updates.push(
        `{ const n${env.lid} = __nodes['${env.lid}']; ` +
        `if(n${env.lid}) { let node = n${env.lid}; ${updateLogic} ` +
        `const __k = ${keyExpr}; ` +
        `const __fe = ((_mjsThis._mjs_filt ??= {})['${idxName}'] ??= { idx: null, prev: void 0 }); ` +
        `const __idx = (__fe.idx ??= new Map()); ` +
        `const __fns = (__nodes._mjs_filterFns ??= {}); ` +
        `if (__fns['${idxName}'] === void 0 || __idx.get(__k) !== n${env.lid}) { ` +
        `__idx.set(__k, n${env.lid}); __fns['${idxName}'] = n${env.lid}; } ` +
        `(_mjsThis._mjs_filtIdxKeys ??= new Set()).add('${idxName}'); ` +
        `(__nodes._mjs_filterKeys ??= {})['${idxName}'] = __k; ` +
        `} }`
      )

      // Enregistrer un effect "filtered" pour la var externe au root.
      // Cet effect lookup les fns dans l'index par old/new value, sans
      // toucher au reste du DOM ni à `_mjs_renderStruct`.
      // On stocke `_mjs_filt[<X>__<class>].prev` pour connaître l'ancienne valeur.
      // L'index stocke le NŒUD → on toggle directement (plus d'appel de
      // closure). Pour le pattern d'égalité `${filt.externVar} === item`, la
      // ligne `prev` (ancienne valeur) ne matche plus → retire la classe ; la
      // ligne `curr` (nouvelle valeur) matche → ajoute la classe. On tient à
      // jour la garde `_mjs_cl_${safeCls}` pour rester cohérent avec l'updateFn
      // (qui re-tourne sur data update et lit cette garde).
      const filtEffectCode =
        `{ ` +
        `const __fe = ((this._mjs_filt ??= {})['${filterKey}'] ??= { idx: null, prev: void 0 }); ` +
        `const prev = __fe.prev; ` +
        `const curr = this._state.${filt.externVar}; ` +
        `if (prev !== curr) { ` +
        `const idx = __fe.idx; ` +
        `if (idx) { ` +
        `if (prev !== void 0) { const nd = idx.get(prev); if (nd) { ${clsToggle('nd', 'false')} nd._mjs_cl_${safeCls} = false; } } ` +
        `if (curr !== void 0) { const nd = idx.get(curr); if (nd) { ${clsToggle('nd', 'true')} nd._mjs_cl_${safeCls} = true; } } ` +
        `} ` +
        `__fe.prev = curr; ` +
        `} }`
      // Expansion transitive : si `filt.externVar` est un computed, on doit
      // s'abonner aussi à ses deps statiques. Sinon, l'effect filtered ne
      // tire pas quand une dep du computed mute (ex : `currentStep` dérivé de
      // `currentStepIdx` — sans expansion, mutation de l'idx → computed dirty
      // mais filtered effect jamais réveillé). On passe par `getEffectVars`
      // qui fait l'expansion via `analyzer.resolveSnippetDeps`.
      const filtVars = getEffectVars(`$${filt.externVar}`)
      registerEffect(filtEffectCode, filtVars.length > 0 ? filtVars : [filt.externVar])
      return { id }
    }

    env.ctx.updates.push(`{ const n${env.lid} = __nodes['${env.lid}']; if(n${env.lid}) { let node = n${env.lid}; ${updateLogic} } }`)
    // condition NON filtrable lisant une var externe
    // (`@class{$cond}="on"`) : sans `structVars`, `_mjs_renderStruct` sauté → classe
    // figée à vie. Le chemin filtré (au-dessus) a son effect dédié → déjà `return`é.
    for (const v of vars) state.structVars.add(v)
  }
  return { id }
}

// ============================================================================
// BindingStyle — port de attributes/binding_style.rb
// @style.color="{$theme}" ou @style.bg{$active}="red"
// ============================================================================
function bindingStyle(env: AttrCtx): AttrResult {
  const isConditional = (env.attrName ?? '').includes('{')

  let cssProp: string
  let conditionExpr: string
  let rawVal: string
  let jsCond: string

  if (isConditional) {
    const m = (env.attrName ?? '').match(/@style\.([a-zA-Z0-9\-]+)\{(.+)\}/)
    if (!m) return { id: env.id }
    cssProp = m[1]
    conditionExpr = m[2]
    rawVal = env.rawVal.toString()
    // Site EXPR (condition @style.X{cond}, même nature qu'un {if}).
    jsCond = cleanJsExpr(conditionExpr, env.compiler.externalVars, env.compiler.templateLang, env.compiler.moduleName)
  } else {
    cssProp = (env.attrName ?? '').replace(/^@style\./, '')
    conditionExpr = env.attr.type === 'dynamic' ? (env.attr.expr ?? '') : env.rawVal
    rawVal = env.attr.type === 'dynamic' ? `{${env.attr.expr}}` : env.rawVal
    jsCond = 'true'
  }

  const varSet = new Set<string>()
  if (isConditional) {
    for (const v of getEffectVars(conditionExpr)) varSet.add(v)
  }

  let jsVal: string
  // expression PLEINE (`rawVal` vaut EXACTEMENT `{expr}`,
  // rien avant/après) : gardée à part en JS BRUT, non encore coercée en chaîne. Un
  // mélange texte+expression (`"pre-{$e}-post"`) n'entre PAS dans ce cas — `fullExprRaw`
  // reste `null`, `jsVal` (gabarit) reste le seul chemin, inchangé.
  let fullExprRaw: string | null = null
  if (rawVal.includes('{')) {
    // deps via `getEffectVars(rawVal)` (blocs équilibrés
    // + tentative expression entière), PAS la regex naïve `/\{([^}]+)\}/` qui
    // tronquait au 1er `}` : `@style.width="{f({k: $w})}px"` perdait `$w` de ses
    // deps → style figé au mount, jamais réactif. Le CODE généré (tpl ci-dessous)
    // reste correct par arithmétique d'accolades (`{X}` → `${X}` préserve la
    // structure globale) — seule l'extraction des deps était fautive.
    for (const v of getEffectVars(rawVal)) varSet.add(v)
    const fullMatch = rawVal.match(/^\{([\s\S]+)\}$/)
    if (fullMatch) fullExprRaw = cleanJsExpr(fullMatch[1], env.compiler.externalVars, env.compiler.templateLang, env.compiler.moduleName)
    // Site EXPR (interpolation @style.X="pre-{$e}-post").
    const tpl = rawVal.replace(/\{([^}]+)\}/g, (_m, e) => `\${${cleanJsExpr(e, env.compiler.externalVars, env.compiler.templateLang, env.compiler.moduleName)}}`)
    jsVal = `\`${tpl}\``
  } else {
    // `JSON.stringify` (gère quotes ET backslashes),
    // PAS `'${rawVal}'` : `@style.grid-template-areas="'hd' 'main'"` produisait
    // `const _mjs_v = ''hd' 'main'';` (littéral JS invalide → SyntaxError au parse
    // du module → TOUTE la réactivité du composant morte).
    jsVal = JSON.stringify(rawVal)
  }

  const vars = Array.from(varSet)
  const id = env.id ?? `s${++state.counter}`

  // `_mjs_node`/`_mjs_v` (pas `node`/`v` nus) : `jsVal`/`jsCond` embarquent une
  // expression UTILISATEUR (ex. `@style.color={node}` où `node` est une
  // variable de SCRIPT top-level, PAS un item de {for} — donc invisible à
  // `RESERVED_TEMPLATE_NAMES`/`rejectReservedName`, qui ne garde que les noms
  // d'item/index/const/success/error). Avec l'ancien nom `node` : la lecture
  // de la variable user retombait sur CE `const node` (l'élément DOM lui-même)
  // → `${node}` interpolait `[object HTMLElement]` (valeur CSS invalide,
  // silencieusement rejetée par le navigateur → `style.color` restait vide).
  // Bug confirmé empiriquement (tests/reserved-names-collision.test.ts).
  // branche expression pleine seulement
  // (`fullExprRaw`) : `_mjs_v` reste la valeur BRUTE (pas de gabarit) tant que
  // null/undefined/'' n'ont pas été écartés — un gabarit \`${null}\` coercerait
  // AVANT le test, en la CHAÎNE "null" (non vide, le test passait à côté). Une
  // fois la valeur confirmée posable, un suffixe `!important` (casse/espaces
  // libres) est détaché de la chaîne et posé en 3e argument de `setProperty` —
  // à 2 arguments, la CSSOM rejette la valeur ENTIÈRE, en silence.
  const styleSetter = (rawExpr: string): string =>
    `const _mjs_v = (${rawExpr}); ` +
    `if (_mjs_v == null || _mjs_v === '') { _mjs_node.style.removeProperty('${cssProp}'); } else { ` +
    `const _mjs_s = String(_mjs_v); const _mjs_t = _mjs_s.trimEnd(); ` +
    `if (_mjs_t.toLowerCase().endsWith('!important')) { _mjs_node.style.setProperty('${cssProp}', _mjs_t.slice(0, _mjs_t.length - '!important'.length).trim(), 'important'); } ` +
    `else { _mjs_node.style.setProperty('${cssProp}', _mjs_s); } }`
  // la forme CONDITIONNELLE `@style.prop{cond}="valeur"` (syntaxe standard, cf.
  // docs/09-directives-dom.md:126, docs/17-router.md:384) court-circuitait les deux branches ci-dessus : elle
  // posait `${jsVal}` en 2e argument brut de `setProperty`, un gabarit déjà coercé en
  // chaîne (null/undefined → "null"/"undefined") et jamais passé par la détection
  // `!important`. Même `styleSetter` que la branche pleine, sur `fullExprRaw` quand la
  // valeur est une expression PLEINE (`{expr}`, test null/vide sur la valeur BRUTE avant
  // coercion) sinon sur `jsVal` (texte/mélange, déjà calculé ci-dessus) — condition
  // fausse : `removeProperty`, inchangé.
  const updateLogic = isConditional
    ? `if (!!(${jsCond})) { ${styleSetter(fullExprRaw !== null ? fullExprRaw : jsVal)} } else { _mjs_node.style.removeProperty('${cssProp}'); }`
    : fullExprRaw !== null
      ? styleSetter(fullExprRaw)
      : `const _mjs_v = ${jsVal}; if (_mjs_v == null || _mjs_v === '') { _mjs_node.style.removeProperty('${cssProp}'); } else { _mjs_node.style.setProperty('${cssProp}', _mjs_v); }`

  if (env.ctx.type === 'root') {
    const code = `{ const _mjs_node = this._mjs_nodes.${id}; if(_mjs_node) { ${updateLogic} } }`
    pushUpdate(env, code, vars)
  } else if (env.ctx.type === 'for') {
    // Filtered dispatch pour `@style.X={cond ? a : b}` ou
    // `@style.X={item.id === $selected ? 'red' : ''}`. On reconnaît le
    // ternaire dont la cond est un pattern `item.X === $extern`. Au mute
    // de $extern, on lookup les 2 fns (old/new) au lieu de re-render N rows.
    // Limité au cas non-conditional `={...}` (pas `@style.X{cond}=...`),
    // pour rester simple — le cas `{cond}` n'est pas pris en charge.
    if (!isConditional && env.attr.type === 'dynamic') {
      const lastLoop = env.ctx.loops && env.ctx.loops.length > 0
        ? env.ctx.loops[env.ctx.loops.length - 1]
        : null
      const filt = lastLoop
        ? detectFilteredValueExpr(env.attr.expr ?? '', lastLoop.item, env.compiler.externalVars ?? [])
        : null
      if (filt) {
        // même fix que bindingClass : `env.lid`
        // distingue 2 nœuds d'une même row partageant (var, propriété CSS).
        const safeProp = cssProp.replace(/[^a-zA-Z0-9_$]/g, '_')
        const filterKey = `${filt.externVar}__style_${safeProp}__${env.lid}`
        // le mémo d'un filtrage par clé vit dans `_mjs_filt` (propriété POINTÉE, donc
        // raccourcie en prod) : la clé n'est plus qu'un texte d'index, jamais un nom
        const idxName = filterKey
        // matchValue/unmatchValue sont des expressions JS brutes (ex : `'red'`,
        // `row.label`, `true`, ...) — passées telles quelles au generator.
        // Le caller a déjà passé cleanJs si nécessaire ; ici l'expression
        // ternaire est dans `env.attr.expr` brut, donc on extrait sans
        // re-clean (les vars utilisateur déjà sigilées sont conservées).
        const setMatch = `node.style.setProperty('${cssProp}', String(${filt.matchValue}));`
        const setUnmatch = filt.unmatchValue.trim() === "''" || filt.unmatchValue.trim() === '""'
          ? `node.style.removeProperty('${cssProp}');`
          : `node.style.setProperty('${cssProp}', String(${filt.unmatchValue}));`
        const filteredLogic = `if (!!(${filt.itemAccess ? `${lastLoop!.item}.${filt.itemAccess}` : lastLoop!.item} === _mjsThis._state.${filt.externVar})) { ${setMatch} } else { ${setUnmatch} }`
        const keyExpr = filt.itemAccess
          ? `${lastLoop!.item}.${filt.itemAccess}`
          : `${lastLoop!.item}`
        // Optim #1 — Pareil que pour @class : closure stable, on évite la
        // re-allocation à chaque updateFn.
        env.ctx.updates.push(
          `{ const n${env.lid} = __nodes['${env.lid}']; ` +
          `if(n${env.lid}) { let node = n${env.lid}; ${filteredLogic} ` +
          `const __k = ${keyExpr}; ` +
          `const __fe = ((_mjsThis._mjs_filt ??= {})['${idxName}'] ??= { idx: null, prev: void 0 }); ` +
          `const __idx = (__fe.idx ??= new Map()); ` +
          `if (!__idx.has(__k)) __idx.set(__k, (matches) => { let node = n${env.lid}; if (matches) { ${setMatch} } else { ${setUnmatch} } }); ` +
          `(_mjsThis._mjs_filtIdxKeys ??= new Set()).add('${idxName}'); ` +
          `(__nodes._mjs_filterKeys ??= {})['${idxName}'] = __k; ` +
          `} }`
        )
        // Effect "filtered" au root : passe true/false à la fn enregistrée.
        // Différence vs @class : on a besoin de signaler match/unmatch
        // explicitement (la fn ne peut pas se "toggler" toute seule).
        const filtEffectCode =
          `{ ` +
          `const __fe = ((this._mjs_filt ??= {})['${filterKey}'] ??= { idx: null, prev: void 0 }); ` +
          `const prev = __fe.prev; ` +
          `const curr = this._state.${filt.externVar}; ` +
          `if (prev !== curr) { ` +
          `const idx = __fe.idx; ` +
          `if (idx) { ` +
          `if (prev !== void 0) { const f = idx.get(prev); if (f) f(false); } ` +
          `if (curr !== void 0) { const f = idx.get(curr); if (f) f(true); } ` +
          `} ` +
          `__fe.prev = curr; ` +
          `} }`
        // Expansion transitive : si `filt.externVar` est un computed, on doit
      // s'abonner aussi à ses deps statiques. Sinon, l'effect filtered ne
      // tire pas quand une dep du computed mute (ex : `currentStep` dérivé de
      // `currentStepIdx` — sans expansion, mutation de l'idx → computed dirty
      // mais filtered effect jamais réveillé). On passe par `getEffectVars`
      // qui fait l'expansion via `analyzer.resolveSnippetDeps`.
      const filtVars = getEffectVars(`$${filt.externVar}`)
      registerEffect(filtEffectCode, filtVars.length > 0 ? filtVars : [filt.externVar])
        return { id }
      }
    }
    // `_mjs_node` (pas `node`) : doit matcher le nom utilisé par `updateLogic`
    // ci-dessus (même risque de collision qu'au root — voir son commentaire).
    env.ctx.updates.push(`{ const n${env.lid} = __nodes['${env.lid}']; if(n${env.lid}) { let _mjs_node = n${env.lid}; ${updateLogic} } }`)
    // `@style.color={$theme}` (non filtré) lisant une var externe :
    // sans `structVars`, `_mjs_renderStruct` sauté → style figé à vie sur mutation.
    // Le chemin filtré (ternaire) a son effect dédié → déjà `return`é plus haut.
    for (const v of vars) state.structVars.add(v)
  }
  return { id }
}

// ============================================================================
// BindingFlip — @flip{$cond}="200ms"
// ============================================================================
function bindingFlip(env: AttrCtx): AttrResult {
  const m = (env.attrName ?? '').match(/^@flip\{(.+)\}$/)
  if (!m) return { id: env.id }
  const condition = m[1]

  let duration = env.rawVal.toString()
  if (duration === '->' || duration === '' || duration === 'true') duration = '200'

  // Site EXPR (condition @flip{cond}, même nature qu'un {if}).
  const jsCond = cleanJsExpr(condition, env.compiler.externalVars, env.compiler.templateLang, env.compiler.moduleName)

  const vars = getEffectVars(condition)

  const id = env.id ?? `f${++state.counter}`
  state.hasFlip = true
  // `@flip` peut interagir avec le système de transitions.
  state.hasDestroyHooks = true

  const updateLogic = `if (${jsCond}) { if (node.getAttribute('mjs-flip') !== '${duration}') node.setAttribute('mjs-flip', '${duration}'); } else { if (node.hasAttribute('mjs-flip')) node.removeAttribute('mjs-flip'); }`

  if (env.ctx.type === 'root') {
    const code = `{ const node = this._mjs_nodes.${id}; if(node) { ${updateLogic} } }`
    pushUpdate(env, code, vars)
  } else if (env.ctx.type === 'for') {
    env.ctx.updates.push(`{ const n${env.lid} = __nodes['${env.lid}']; if(n${env.lid}) { let node = n${env.lid}; ${updateLogic} } }`)
    // `@flip{$cond}` lisant une var externe : sans `structVars`,
    // `_mjs_renderStruct` sauté → l'attribut mjs-flip figé à vie sur mutation.
    for (const v of vars) state.structVars.add(v)
  }
  return { id }
}

// ============================================================================
// BindingAttach — @attach={tooltip($msg)} ou @attach={(node) -> setup}
// Mode détecté via AST : DIRECT vs FACTORY (cf. ast_daemon analyze_attach_mode)
// ============================================================================
function bindingAttach(env: AttrCtx): AttrResult {
  const rawExpr = env.attr.expr ?? env.attr.val
  if (!rawExpr) return { id: env.id }

  const jsFunc = cleanJs(rawExpr, env.compiler.externalVars)

  const vars = getEffectVars(rawExpr)
  const id = env.id ?? `a${++state.counter}`
  // `@attach` installe un teardown `_mjs_td` → destroy walker requis.
  state.hasDestroyHooks = true

  const isDirect = /\b_node\b/.test(jsFunc)
  const mode = isDirect ? 'direct' : 'factory'

  const evalBlock = mode === 'factory'
    ? `const _setup = ${jsFunc}; const td = (typeof _setup === 'function') ? _setup(_node) : null;`
    : `const td = ${jsFunc};`

  const attachLogic = `/* Purge précédente si params mutent */ if (_node._mjs_td) { _node._mjs_td(); if (this._mjs_attachments) this._mjs_attachments.delete(_node._mjs_td); _node._mjs_td = null; } /* Execution (mode ${mode}) */ ${evalBlock} if (typeof td === 'function') { _node._mjs_td = td; this._mjs_attachments = this._mjs_attachments || new Set(); this._mjs_attachments.add(td); }`

  if (env.ctx.type === 'root') {
    const code = `{ const _node = this._mjs_nodes.${id}; if(_node) { ${attachLogic} } }`
    // Deux registres :
    //   1. ctx.updates → _mjs_renderStruct (via le marqueur `_mjs_td` dans
    //      classifyUpdates) → re-tire quand un bloc struct parent re-rend
    //      le nœud ({if}/{key}/{for}). Aussi exécuté au mount via fullRender.
    //   2. Si l'expression lit des vars réactives ($x), on enregistre aussi
    //      l'attach dans effectsByVar → re-tire quand la var change
    //      (ex. `@attach={tooltip($content)}` doit re-poser le tooltip à
    //      chaque mutation de $content). Sans ça, l'attach reste figé sur
    //      la valeur initiale.
    // Double invocation au mount possible — idempotente grâce à la garde
    // `if (_node._mjs_td) { purge; }` dans attachLogic.
    env.ctx.updates.push(code)
    if (vars.length > 0) registerEffect(code, vars)
  } else if (env.ctx.type === 'for') {
    env.ctx.updates.push(`{ const _node_${env.lid} = __nodes['${env.lid}']; if(_node_${env.lid}) { let _node = _node_${env.lid}; ${attachLogic} } }`)
    // `@attach={tooltip($m)}` en row lisant une var externe : sans
    // `structVars`, `_mjs_renderStruct` sauté → l'attach reste figé sur $m initial.
    for (const v of vars) state.structVars.add(v)
  }
  return { id }
}

// ============================================================================
// @emit.EVENT_NAME={expr} (réactif) / @emit.once.EVENT_NAME={expr} (mount only)
// `this._mjs_emit(eventName, data)` existe déjà côté runtime (mjs_element.ts,
// INCHANGÉ ici) — on ne fait qu'évaluer `expr` et le rappeler à chaque
// changement de dépendance réactive (forme réactive standard, comme n'importe
// quel `={expr}` du framework) ou UNE seule fois au montage (`.once`).
// ============================================================================
function bindingEmit(env: AttrCtx): AttrResult {
  const attrName = env.attrName ?? ''
  const segs = attrName.slice('@emit.'.length).split('.')
  let isOnce: boolean
  let eventName: string
  if (segs.length === 1) {
    isOnce = false
    eventName = segs[0]
  } else if (segs.length === 2 && segs[0] === 'once') {
    isOnce = true
    eventName = segs[1]
  } else {
    throw new Error(t('generator.emit-forme-non-reconnue', { attrName }))
  }
  if (!eventName) throw new Error(t('generator.emit-forme-non-reconnue', { attrName }))

  const rawExpr = env.attr.expr ?? env.attr.val
  if (!rawExpr) return { id: env.id }

  // Site EXPR (valeur d'attribut @emit.x={expr}) — même helper que dynamic().
  const jsVal = cleanJsExpr(rawExpr, env.compiler.externalVars, env.compiler.templateLang, env.compiler.moduleName)

  // `.once` : `vars: []` route le code dans le bucket mount-only (jamais
  // indexé dans effectsByVar) — même patron que le Setup-only de
  // bindingDimensions (~ligne 624). Zéro mécanisme d'abonnement/désabonnement
  // à écrire : la forme réactive et `.once` partagent EXACTEMENT le même
  // branchement ci-dessous, seul `vars` diffère.
  const vars = isOnce ? [] : getEffectVars(rawExpr)
  const code = `this._mjs_emit('${eventName}', ${jsVal});`

  if (env.ctx.type === 'root') {
    // `pushUpdate` (PAS le garde `if (vars.length > 0)` de bindingAttach) :
    // ce garde ne fonctionne LÀ-BAS que parce que le code de @attach contient
    // le marqueur `_mjs_td`, que `classifyUpdates` (transpiler/index.ts)
    // range dans `struct` — donc rejoué au mount via `_mjs_renderStruct` MÊME
    // sans passer par `registerEffect`. Le code de @emit ne porte AUCUN
    // marqueur struct : sans appel INCONDITIONNEL à `registerEffect`, un
    // `vars` vide (cas `.once`, ou une forme réactive à expression pure sans
    // dépendance) ne serait JAMAIS exécuté, pas même au mount — vérifié en
    // traçant classifyUpdates/mountOnlyEffects/_mjs_eff (transpiler/index.ts).
    // `pushUpdate` est le patron RÉEL majoritaire de ce fichier (cf. `dynamic()`
    // juste au-dessus) : registerEffect INCONDITIONNEL pour root, vars=[] →
    // bucket mount-only (CompilerState.registerEffect).
    pushUpdate(env, code, vars)
  } else if (env.ctx.type === 'for') {
    env.ctx.updates.push(code)
    for (const v of vars) state.structVars.add(v)
  }
  return { id: env.id }
}

// ============================================================================
// Dispatcher principal — port de compile_tag.rb (la grosse switchcase
// d'attributs). Ordre des conditions = identique V1.
// ============================================================================
const MJS_BOOLEAN_PROPS = ['value', 'checked', 'disabled', 'open', 'readonly',
                            'required', 'selected', 'hidden', 'multiple',
                            'autofocus', 'muted', 'autoplay', 'loop', 'controls']

const MEDIA_ATTRS = ['currentTime', 'duration', 'paused', 'volume', 'muted', 'playbackRate']
const DIM_ATTRS = ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight']

/** Découpe le corps d'un `@flip={…}` en couples `clé → valeur BRUTE`, en respectant
 * profondeur ET chaînes : `easing: 'cubic-bezier(0.25, 1, 0.5, 1)'` porte des virgules
 * qui ne séparent rien, et `duration: fn(a, b)` non plus. Le premier `:` de niveau 0
 * sépare la clé de la valeur ; la valeur est rendue VERBATIM (expression comprise).
 *
 * Dans une chaîne, un `\` CONSOMME le caractère suivant, quel qu'il soit. Le coup d'œil
 * en arrière d'avant (`part[i - 1] !== '\'`) ne distinguait pas `\'` (apostrophe échappée,
 * la chaîne continue) de `\\'` (antislash littéral PUIS fin de chaîne) : sur le second, la
 * chaîne ne se refermait jamais et avalait tous les champs suivants — build en échec. */
function splitFlipEntries(body: string): Array<[string, string]> {
  const inner = body.trim().replace(/^\{/, '').replace(/\}$/, '')
  const entries: Array<[string, string]> = []
  const pushEntry = (part: string): void => {
    let d = 0
    let q = ''
    for (let i = 0; i < part.length; i++) {
      const ch = part[i]
      if (q) { if (ch === '\\') { i++; continue }; if (ch === q) q = ''; continue }
      if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue }
      if (ch === '(' || ch === '[' || ch === '{') d++
      else if (ch === ')' || ch === ']' || ch === '}') d--
      else if (ch === ':' && d === 0) { entries.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]); return }
    }
  }
  let depth = 0
  let quote = ''
  let cur   = ''
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote) { cur += ch; if (ch === '\\') { if (i + 1 < inner.length) cur += inner[++i]; continue }; if (ch === quote) quote = ''; continue }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) { pushEntry(cur); cur = '' }
    else cur += ch
  }
  pushEntry(cur)
  return entries
}

/** Liaison d'un attribut `mjs-flip*` sur une valeur CALCULÉE (`duration: 200 * $ralenti`).
 * Même code d'update que `dynamic()` — `_mjs_updAttr` au root (+ effets), `_mjs_updAttrNode` sur la
 * row en `{for}` (+ `structVars`, sinon une var externe à la boucle fige l'attribut à vie) —
 * mais sans toucher `attrStr` : le repli statique déjà écrit (`mjs-flip='200'`) reste, et
 * l'update le remplace dès le premier rendu. Le runtime relit les trois attributs à CHAQUE
 * animation (mjs_flip.ts) : rien d'autre à réveiller.
 *
 * `secours` — SANS lui, une expression qui vaut `undefined`/`null`/`false` fait RETIRER
 * l'attribut par `_mjs_updAttrNode` (sémantique normale des attributs). CRITIQUE sur la durée :
 * `hasAttribute('mjs-flip')` est la porte d'entrée de tout le mécanisme FLIP, le nœud
 * devient invisible du système et l'animation s'arrête, sans un mot. On coalesce donc vers
 * la valeur de repli, dans une variable temporaire pour n'évaluer l'expression QU'UNE fois.
 * `delay`/`easing` le portent aussi, par symétrie : le runtime a certes ses propres défauts
 * (`isNaN → 0`, `getAttribute(…) || 'cubic-bezier(…)'`), mais l'attribut posé dit ce qui
 * s'applique au lieu de le laisser deviner — un `mjs-flip-delay` absent et un `='0'` se
 * lisent pareil au runtime, pas dans l'inspecteur.
 *
 * Le secours arrive TOUJOURS déjà encodé en littéral JS (`JSON.stringify` chez l'appelant) :
 * il vient d'une valeur écrite par l'utilisateur, et une clé dupliquée (`delay: 007, delay: $x`
 * — `splitFlipEntries` ne déduplique pas) glissait sinon `007` NU en position d'expression →
 * « Octal literals are not allowed in strict mode », build du composant en échec. Le runtime
 * relit ces trois attributs au `parseInt` : une chaîne convient exactement comme un nombre. */
function flipBinding(env: AttrCtx, attrName: string, expr: string, id: string, secours?: string): void {
  const vars  = getEffectVars(expr)
  const jsVar = cleanJsExpr(expr, env.compiler.externalVars, env.compiler.templateLang, env.compiler.moduleName)
  const tmp   = `_mjsFlipVal_${id}`
  const val   = secours != null ? `(${tmp} == null || ${tmp} === false) ? ${secours} : ${tmp}` : tmp
  if (env.ctx.type === 'for') {
    env.ctx.updates.push(`{ const n${env.lid} = __nodes['${env.lid}']; if(n${env.lid}) { const ${tmp} = ${jsVar}; µ._mjs_updAttrNode(n${env.lid}, '${attrName}', ${val}); } }`)
    for (const v of vars) state.structVars.add(v)
  }
  else pushUpdate(env, `{ const ${tmp} = ${jsVar}; this._mjs_updAttr('${id}', '${attrName}', ${val}); }`, vars)
}

export function dispatchAttribute(env: AttrCtx): AttrResult {
  // Spread
  if (env.attr.type === 'spread') return spread(env)

  if (!env.attrName) return { id: env.id }

  const attrName = env.attrName
  const rawVal = env.rawVal

  // #DX — Liaison two-way MAL FORMÉE. `rawVal` commence par `!` (intention de
  // binding `=!{…}`) mais n'est pas un `!{…}` bien formé. Avant, ça retombait
  // SILENCIEUSEMENT en attribut dynamique → un attribut cassé (ex. la chaîne
  // littérale "!.number5"), sans le moindre avertissement. On échoue désormais
  // à la compilation avec un message actionnable.
  if (rawVal.startsWith('!') && !/^!\{(.+)\}$/.test(rawVal)) {
    const castMatch = rawVal.match(/^!\.(number|int|float|string|bool|boolean)\b/)
    const hint = castMatch
      ? t('generator.hint-cast-suffixe-nom', { attrName, cast: castMatch[1] })
      : t('generator.hint-syntaxe-two-way', { attrName })
    throw new Error(t('generator.liaison-two-way-malformee', { attrName, rawVal, hint }))
  }

  // @group avec !{…}
  if (/^@group(\.[a-z]+)?$/.test(attrName) && /^!\{(.+)\}$/.test(rawVal)) {
    return bindingGroup(env)
  }

  // @html / @text avec !{…}
  if ((attrName === '@html' || attrName === '@text') && /^!\{(.+)\}$/.test(rawVal)) {
    return bindingContent(env)
  }

  // Media attrs
  if (MEDIA_ATTRS.includes(attrName) && /^!\{(.+)\}$/.test(rawVal)) {
    return bindingMedia(env)
  }

  // Dimension attrs
  if (DIM_ATTRS.includes(attrName) && /^!\{(.+)\}$/.test(rawVal)) {
    return bindingDimensions(env)
  }

  // @this
  if (attrName === '@this' && /^!?\{(.+)\}$/.test(rawVal)) {
    return bindingThis(env)
  }

  // mjs-foo with !{...} → binding_component
  if ((env.node.name ?? '').startsWith('mjs-') && /^!\{(.+)\}$/.test(rawVal)) {
    return bindingComponent(env)
  }

  // !{…} → binding_standard (général)
  if (/^!\{(.+)\}$/.test(rawVal)) {
    return bindingStandard(env)
  }

  // CSS custom property : --xxx
  if (attrName.startsWith('--')) {
    env.attrName = `@style.${attrName}`
    return bindingStyle(env)
  }

  // @style.x
  if (attrName.startsWith('@style.')) return bindingStyle(env)

  // @class{cond}
  if (attrName.startsWith('@class{')) return bindingClass(env)

  // @flip{cond}
  if (attrName.startsWith('@flip{')) return bindingFlip(env)

  // @flip simple — `@flip`, `@flip=300`, ou `@flip={duration: 300, delay: 600, easing: '...'}`.
  if (attrName === '@flip') {
    let duration = '200'
    let delay = ''
    let easing = ''
    // `@flip={…}` : la valeur bracée est un attribut DYNAMIQUE → son contenu
    // (équilibré par le lexer, virgules ET espaces inclus) est dans
    // `env.attr.expr`, tandis que `env.rawVal` est VIDE. Sans ce repli, toute
    // forme objet `@flip={duration: 1200}` retombait silencieusement sur 200
    // (et `{a, b}` multi-champ était tronqué). La forme simple `@flip=1200`
    // passe par `rawVal` et n'est pas concernée.
    const flipVal = (env.attr.type === 'dynamic' && env.attr.expr != null)
      ? `{${env.attr.expr}}`
      : rawVal
    // Champs CALCULÉS (`duration: 200 * $ralenti`) : non figeables au build, ils partent en
    // LIAISON plus bas. L'ancienne lecture par regex (`duration\s*:\s*(\d+)`) ne voyait que
    // le littéral — `2500 * $ralenti` était silencieusement réduit à `2500` : build vert,
    // console muette, animation qui ne suit pas.
    let durationExpr: string | null = null
    let delayExpr:    string | null = null
    let easingExpr:   string | null = null
    if (flipVal && flipVal.trim().startsWith('{')) {
      // Forme objet : on extrait duration/delay/easing (le runtime ne lit que
      // `mjs-flip` en parseInt ; delay/easing passent par des attrs dédiés).
      for (const [key, val] of splitFlipEntries(flipVal)) {
        if (!val) continue
        if (key === 'duration')   { if (/^\d+$/.test(val)) duration = val; else durationExpr = val }
        else if (key === 'delay') { if (/^\d+$/.test(val)) delay    = val; else delayExpr    = val }
        else if (key === 'easing') {
          const lit = val.match(/^(['"])([^'"]*)\1$/)
          if (lit) easing = lit[2]
          else easingExpr = val
        }
      }
    } else if (flipVal !== '->' && flipVal !== '' && flipVal !== 'true') {
      duration = flipVal
    }
    let attrStr = env.attrStr + ` mjs-flip='${duration}'`
    if (delay) attrStr += ` mjs-flip-delay='${delay}'`
    if (easing) attrStr += ` mjs-flip-easing='${easing}'`
    state.hasFlip = true
    state.hasDestroyHooks = true
    if (env.ctx.loops.length > 0) {
      const last = env.ctx.loops[env.ctx.loops.length - 1]
      const loopItem = last.item
      const loopIdx  = last.index
      if (!attrStr.includes('mjs-key')) {
        attrStr += ` mjs-key='\${${loopItem}.id !== undefined ? ${loopItem}.id : ${loopIdx}}'`
      }
    }
    // Les champs calculés se posent PAR-DESSUS le repli statique, à chaque rendu ; l'id doit
    // remonter à l'appelant pour que `this._mjs_nodes[id]` existe au root. Les trois portent une
    // valeur de SECOURS (cf. `flipBinding`) : vitale sur `mjs-flip`, qui rend le nœud visible
    // du mécanisme FLIP et ne doit JAMAIS être retiré ; par symétrie sur delay/easing.
    if (durationExpr || delayExpr || easingExpr) {
      const flipId = env.id ?? `a${++state.counter}`
      if (durationExpr) flipBinding(env, 'mjs-flip', durationExpr, flipId, JSON.stringify(duration))
      if (delayExpr)    flipBinding(env, 'mjs-flip-delay', delayExpr, flipId, JSON.stringify(delay || '0'))
      if (easingExpr)   flipBinding(env, 'mjs-flip-easing', easingExpr, flipId, JSON.stringify(easing || 'cubic-bezier(0.25, 1, 0.5, 1)'))
      return { attrStr, id: flipId }
    }
    return { attrStr, id: env.id }
  }

  // @attach
  if (attrName === '@attach') return bindingAttach(env)

  // @childtransition
  if (attrName === '@childtransition') {
    // apostrophe → `&#39;` (chemin clone/innerHTML, décodée au parse).
    return { attrStr: env.attrStr + ` mjs-childtransition='${rawVal.replace(/'/g, '&#39;')}'`, id: env.id }
  }

  // @lightDom — directive instance qui rend le Shadow DOM inopérant.
  // Usage : `<mjs-foo @lightDom />` au lieu du défaut Shadow DOM closed.
  // Compile-time → émet un attribut HTML `mjs-light` lu par le constructor
  // du custom element au moment de l'upgrade.
  // Pour les rares cas où l'isolation Shadow DOM n'est pas désirée (apps
  // qui veulent Tailwind/Bootstrap global, tables géantes perf-critical,
  // intégration native avec libs tierces qui font `document.querySelector`).
  if (attrName === '@lightDom') {
    return { attrStr: env.attrStr + ` mjs-light`, id: env.id }
  }

  // @transition.X / @in.X / @out.X / @introstart / @introend / @outrostart / @outroend
  if (/^@(?:transition|in|out)\.\w+(?:\.(?:global|shared))*$|^@(?:introstart|introend|outrostart|outroend)$/.test(attrName)) {
    return bindingTransition(env)
  }

  // @emit.EVENT_NAME={expr} / @emit.once.EVENT_NAME={expr} — DOIT précéder le
  // fallback générique `@xxx → eventListener()` plus bas : sans ça, un
  // `@emit.xxx=` quelconque tomberait silencieusement dans un mauvais binding
  // (piège préexistant du fallback, cf. commentaire sur MJS_BOOLEAN_PROPS
  // juste en dessous).
  if (attrName.startsWith('@emit.')) return bindingEmit(env)

  // `@booleanProp`
  // (`@open`/`@checked`/`@disabled`/etc., ex. `<details @open>`) forçait
  // INCONDITIONNELLEMENT vers `bindingStandard` — qui n'accepte QUE la forme
  // two-way bien formée `!{…}`. Or par construction, une valeur `!{…}` bien
  // formée est DÉJÀ interceptée PLUS HAUT (ligne ~1669, la règle générale
  // « !{…} → binding_standard », valable pour N'IMPORTE QUEL attribut,
  // préfixé @ ou non) — on n'atteint donc CE bloc QUE pour les 2 AUTRES
  // formes, que `bindingStandard` rejette TOUJOURS avec une erreur cryptique
  // (« expected !{...} pattern, got "true" ») :
  //   - `@open` nu (`type: 'boolean'`, aucune expression à lier) — statique.
  //   - `@open={expr}` (`type: 'dynamic'`) — dynamique UNIDIRECTIONNEL, un cas
  //     d'usage courant (`<details @open={isExpanded}>`) qui n'a pas besoin
  //     d'écrire en retour vers `isExpanded`.
  // Fix : router chaque forme vers le handler qui la comprend RÉELLEMENT —
  // `dynamic()` (même chemin que `open={isExpanded}` SANS @, délègue à
  // `_mjs_updAttrNode`, qui gère déjà correctement le retrait des booléens sur
  // false/null/undefined) pour le cas dynamique, `booleanAttr()` (statique,
  // équivalent à `open` sans @) pour le cas nu — au lieu de laisser
  // `bindingStandard` échouer sur les DEUX.
  if (attrName.startsWith('@')) {
    const attrPure = attrName.slice(1)
    if (MJS_BOOLEAN_PROPS.includes(attrPure)) {
      env.attrName = attrPure
      if (env.attr.type === 'dynamic') return dynamic(env)
      return booleanAttr(env)
    }
    // repli — tout `@xxx` inconnu est un écouteur d'événement, un nom d'événement est libre,
    // le compilateur ne le compare à RIEN (casse comprise) ; les
    // directives des balises de section sont contrôlées dans transpiler/sections.ts et directives.ts
    return eventListener(env)
  }

  // raw_val avec $xxx et pas mjs-* → interpolation type "if dirty"
  if (/(?<![\w.])\$[a-zA-Z_]/.test(rawVal) && !attrName.startsWith('mjs-')) {
    const vars = getEffectVars(rawVal)
    const needsAlias = rawVal.includes('@@') || rawVal.includes('$store') ||
                       rawVal.includes('$$') || rawVal.includes('$__')
    const ptr = needsAlias ? '_mjsThis' : 'this'
    const jsEval = parseMixedString(rawVal, env.compiler.externalVars, env.compiler.templateLang, env.compiler.moduleName)
    // cette branche n'avait qu'un chemin ROOT
    // (`this._mjs_updAttr`, qui lit `this._mjs_nodes[id]`) : dans un `{for}`, les refs
    // de row vivent dans `__nodes` (PAS `this._mjs_nodes`) → `this._mjs_nodes[id]`
    // est TOUJOURS `undefined` → no-op SILENCIEUX sur TOUTES les rows. Un
    // attribut interpolé contenant un `$var` (ex. `title="prix : {$prefix}"`)
    // disparaissait donc purement et simplement en boucle.
    //
    // Fix : `µ._mjs_updAttrNode(node, name, val)` factorise EXACTEMENT la logique
    // de `this._mjs_updAttr` (props booléennes, `null`/`false`→removeAttribute,
    // filtre XSS `µ._mjs_safeAttr`) mais prend le NODE directement au lieu de le
    // chercher dans `this._mjs_nodes[id]` — utilisable aussi bien au root
    // (`this._mjs_nodes.${id}`) qu'en `{for}` (`__nodes['${lid}']`). `_mjs_updAttr`
    // lui-même est refactoré pour DÉLÉGUER à ce helper (zéro duplication,
    // root et for utilisent désormais UNE SEULE logique — ferme au passage
    // le défaut jumeau « booléens/null cassés en {for} »).
    if (env.ctx.type === 'for') {
      env.ctx.updates.push(
        `{ const n${env.lid} = __nodes['${env.lid}']; if(n${env.lid}) { µ._mjs_updAttrNode(n${env.lid}, '${attrName}', ${jsEval}); } }`
      )
      // le fix CRITIQUE rend l'attribut `$var` interpolé
      // VISIBLE au mount, mais sans `structVars` il reste NON réactif (var externe
      // mutée hors row → `_mjs_renderStruct` sauté). `vars` est déjà calculé plus haut.
      for (const v of vars) state.structVars.add(v)
      return { id: env.id, attrStr: env.attrStr + ` ${attrName}=''` }
    }
    if (env.ctx.type !== 'root') {
      // contexte {await} (ni root ni for) : ce code s'exécute
      // DANS la createFn de la branche, AVANT que `_mjs_updIf` (mjs_element.ts) ne
      // fusionne les refs dans `this._mjs_nodes` — `this._mjs_nodes[id]` est encore vide
      // à cet instant précis. Même remède : viser les refs LOCALES
      // `__nodes` de la branche, déjà peuplées à ce point du corps généré.
      const id = env.id ?? `e${++state.counter}`
      env.ctx.updates.push(`{ const node = __nodes['${id}']; if(node) µ._mjs_updAttrNode(node, '${attrName}', ${jsEval}); }`)
      return { id }
    }
    const id = env.id ?? `e${++state.counter}`
    const code = `${ptr}._mjs_updAttr('${id}', '${attrName}', ${jsEval});`
    pushUpdate(env, code, vars)
    return { id }
  }

  // Type spécifique
  if (env.attr.type === 'dynamic') return dynamic(env)
  if (env.attr.type === 'boolean') return booleanAttr(env)

  // Mixed string with {...}
  if ((env.attr.val ?? '').includes('{') || rawVal.includes('{')) {
    return interpolation(env)
  }

  return staticAttr(env)
}
