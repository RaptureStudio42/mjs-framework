// compile — orchestrateur du compilateur HTML, port consolidé de :
//   compiler_html/{compile, walk, compile_tag, compile_if, compile_for,
//                  compile_await, compile_key, preprocessor}.rb
//
// V2 — dispatch direct sans bitmask :
//   - Les updates text/attr/binding sont émis SANS condition `if (dirty & ...)`
//     et enregistrés dans `state.effectsByVar` par varName via `registerEffect`.
//   - Les blocs structurels (`{if}`, `{for}`, `{await}`, `{key}`) restent
//     centralisés dans `ctx.updates` et seront placés par le transpiler dans
//     `_mjs_renderStruct` (exécuté à chaque mutation — coût marginal).

import { parse, Node } from '../parser/index.js'
import type { TagRef } from '../parser/index.js'
import { state, reset, getEffectVars, registerEffect } from './state.js'
import type { EventRoute } from './state.js'
import { cleanJsExpr } from './utils.js'
import { dispatchAttribute, SELECT_VALUE_DEFER_PREFIX, type AttrCtx } from './attributes/index.js'
import { generateCreateFnBody, SVG_NS, MATH_NS } from './paths.js'
import { t } from '../messages/index.js'

const VOID_TAGS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
                   'link', 'meta', 'param', 'source', 'track', 'wbr']

const MJS_BOOLEAN_PROPS = ['value', 'checked', 'disabled', 'open', 'readonly',
                            'required', 'selected', 'hidden', 'multiple',
                            'autofocus', 'muted', 'autoplay', 'loop', 'controls']

const SPECIAL_ATTR_PREFIXES = ['@transition', '@in', '@out', '@intro', '@outro',
                                '@attach', '@this', '@class', '@style', '@flip',
                                '@childtransition', '@html', '@text', '@group']

function isSpecialAttr(name: string | null | undefined): boolean {
  if (!name) return false
  return SPECIAL_ATTR_PREFIXES.some((p) => name.startsWith(p))
}

// Optim #5 — Helpers pour la closure des refs.
//
// `extractRefsForClosure(localUpdates)` :
//   - scanne `localUpdates` (string JS) pour trouver tous les `__nodes['xxx']`
//   - retourne la liste des `xxx` uniques + le code transformé où chaque
//     `__nodes['xxx']` est remplacé par `_nref_safe(xxx)`
//
// `safeRefVarName(id)` : convertit un id de ref (peut contenir `-`, `:`, etc.)
// en identifier JS valide pour variable locale.
function safeRefVarName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_$]/g, '_')
}

// `baseRefIds` : ids présents dans le template de BASE de l'item (créés
// inconditionnellement). Les refs ABSENTES de cette liste vivent dans un
// corps conditionnel (`{if}`/`{key}`/`{await}` imbriqué) créé à la volée par
// `_mjs_updItemIf` — leur `_nref_` serait capturé `undefined` en tête du tplFn.
// On les laisse donc en lookup live `__nodes['X']` (résolu APRÈS que
// `_mjs_updItemIf` les a mergées dans `__nodes`).
function extractRefsForClosure(code: string, baseRefIds?: string[]): { refIds: string[]; transformedBody: string } {
  const found = new Set<string>()
  const baseSet = baseRefIds ? new Set(baseRefIds) : null
  // Regex : capture les `__nodes['xxx']` où xxx ne contient ni `'` ni `${`
  // (i.e. seulement des refs littérales déjà résolues, pas d'interpolation).
  //
  // Cas {for} imbriqué : le `localUpdates` du for parent contient le `tplFn`
  // du for enfant, lequel a DÉJÀ une ligne `const _nref_X = __nodes['X'];`
  // (extraction faite lors de la compilation du for enfant). Si on re-transforme
  // ce `__nodes['X']`, on produit `const _nref_X = _nref_X;` (auto-référence
  // → ReferenceError "before initialization"). On masque donc d'abord ces
  // lignes d'extraction déjà générées avant le scan, puis on les restaure.
  const guarded: string[] = []
  const work = code.replace(
    /const\s+_nref_[a-zA-Z0-9_$]+\s*=\s*__nodes\['[^'\$\{]+'\];/g,
    (m) => {
      guarded.push(m)
      return `\x00NREF${guarded.length - 1}\x00`
    }
  )
  const re = /__nodes\['([^'\$\{]+)'\]/g
  let transformedBody = work.replace(re, (_m, id) => {
    // Ref conditionnelle (hors template de base) → garder le lookup live
    // `__nodes['X']`, ne PAS la pré-extraire en `_nref_X` (= undefined).
    if (baseSet && !baseSet.has(id)) {
      return _m
    }
    found.add(id)
    return `_nref_${safeRefVarName(id)}`
  })
  // Restaure les lignes d'extraction masquées (intactes).
  transformedBody = transformedBody.replace(
    /\x00NREF(\d+)\x00/g,
    (_m, i) => guarded[+i]
  )
  // Optim #5b — élimine les `const nXXX = _nref_XXX; if(nXXX) { ... }` redondants.
  // Vu que `_nref_XXX` est garantie non-null (extraite dans le tplFn juste après
  // la création du fragment), le test `if(nXXX)` n'est plus nécessaire.
  //
  // Pattern source : `const nLID = _nref_LID; if(nLID) { BODY }` (ou `if (nLID)`)
  // → on garde la déclaration `nLID = _nref_LID` mais on retire le `if(nLID)`.
  //
  // Important : la regex doit matcher les accolades imbriquées. On utilise un
  // matching plus tolérant : on cherche `if (?nVAR ?) {` puis on garde le `{`
  // ouvrant et on laisse le `}` final tel quel — le `if` disparaît seulement,
  // le bloc reste.
  transformedBody = transformedBody.replace(
    /(const\s+(n[a-zA-Z0-9_$]+)\s*=\s*_nref_[a-zA-Z0-9_$]+;\s*)if\s*\(\s*\2\s*\)\s*\{/g,
    '$1{'
  )
  return { refIds: Array.from(found), transformedBody }
}

// Préfixe-sentinelle d'une déclaration `{const}`. Une entrée de `ctx.updates`
// qui commence par ce marqueur est une déclaration `const NOM = EXPR;` à
// émettre TELLE QUELLE (sans wrapper `{ … }`) et HISSÉE en tête du corps de
// rendu — afin que `NOM` soit visible des updates frères qui le consomment.
// Choix d'un préfixe en commentaire JS : inerte si jamais émis par erreur.
const CONST_DECL_PREFIX = '/*@mjs-const*/'

// sépare les entrées `ctx.updates` d'une branche non-root
// ({if}/{await}/{key}) portant la sentinelle `SELECT_VALUE_DEFER_PREFIX`
// (`bindingStandard`, attributes/index.ts — two-way `<select value=!{...}>`)
// des entrées ordinaires. Les sentinelles reviennent SANS préfixe dans
// `deferred`, à fusionner par l'appelant APRÈS `postUpdates` (paths.ts) — même
// besoin de "courir après les <option> d'un {for} imbriqué", même
// mécanique de report, juste une source différente (paths.ts ne voit jamais
// ce code, émis à côté du HTML qu'il parse).
function splitDeferredUpdates(updates: string[]): { updates: string[]; deferred: string[] } {
  const kept: string[] = []
  const deferred: string[] = []
  for (const u of updates) {
    if (u.startsWith(SELECT_VALUE_DEFER_PREFIX)) deferred.push(u.slice(SELECT_VALUE_DEFER_PREFIX.length))
    else kept.push(u)
  }
  return { updates: kept, deferred }
}

interface Ctx {
  type: 'root' | 'for' | 'await' | string
  updates: string[]
  loops: LoopInfo[]
  /** namespace SVG/MathML ambiant, posé par
   * `compileTag` en entrant dans `<svg>`/`<math>`, hérité par tout le
   * sous-arbre (relais nécessaire à `compileAwait` : le contenu d'une branche
   * `{await}` est compilé en fragment SÉPARÉ, sans jamais voir la balise
   * `<svg>` englobante — cf. son commentaire). */
  svgNs?: string | null
}

interface LoopInfo {
  item: string
  index: string
  internalIndex: string
  iterable: string
  depth: number
  /** Nom de l'attribut-clé de la loop (`by X` → 'X'), ou null si non keyée.
   * Sert au cacheId STABLE des loops imbriquées (#1). */
  key: string | null
}

// ============================================================================
// preprocess
// ============================================================================
export function preprocess(htmlRaw: string): string {
  // 1. <@view name [css="..."] [data-mjs-vt="..."] [data-mjs-vt-p="..."]> → <metamjs-view id="name" css="..." data-mjs-vt="..." data-mjs-vt-p="..."></metamjs-view>
  let result = htmlRaw.replace(
    /<@view\s+([\w-]+)((?:\s+(?:css|data-mjs-vt|data-mjs-vt-p)=["'][^"']*["'])*)\s*\/?>/gi,
    (_m, id, attrs) => `<metamjs-view id="${id}"${attrs}></metamjs-view>`
  )

  // 2. {variable} → variable="{variable}" + Web Components auto-fermés
  //
  // la regex de raccourci
  // (`(?<=\s)\{name\}(?=\s|\/|$)`) ne se souciait pas de savoir si `{name}`
  // apparaît DANS une valeur d'attribut DÉJÀ quotée (ex.
  // `class="foo {isActive} bar"`, une interpolation espacée au milieu d'une
  // valeur littérale) — n'importe quel `{name}` entouré d'espaces, où qu'il
  // soit dans la chaîne d'attributs, matchait et se faisait développer EN
  // PLEIN MILIEU de la valeur quotée : guillemet refermé prématurément
  // (`class='foo isActive='`) suivi de texte orphelin hors de toute paire
  // attribut=valeur (` bar>`) — attribut détruit, ET l'interpolation
  // elle-même perdue (aucune liaison réactive émise pour `isActive`). Fix :
  // une SEULE regex avec les valeurs quotées ("..."/'...') comme ALTERNATIVES
  // PRIORITAIRES — à chaque position, le moteur regex matche et CONSOMME
  // D'ABORD une valeur quotée ENTIÈRE si elle commence ici (elle passe donc
  // inchangée, `name` reste `undefined` dans le callback), sautant purement
  // et simplement par-dessus tout `{name}` qu'elle contient ; seul un
  // `{name}` RÉELLEMENT hors de toute valeur quotée atteint l'alternative de
  // raccourci.
  result = result.replace(/<([a-zA-Z0-9_-]+)([^>]*)>/g, (_match, tagName, rawAttrs) => {
    let attrs = rawAttrs.replace(
      /"[^"]*"|'[^']*'|(?<=\s)\{(\$?)([a-zA-Z_][a-zA-Z0-9_]*)\}(?=\s|\/|$)/g,
      (m: string, dollar: string | undefined, name: string | undefined) =>
        name === undefined ? m : `${name}="{${dollar}${name}}"`
    )

    if (tagName.startsWith('mjs-') && /\/$/.test(attrs)) {
      attrs = attrs.replace(/\/$/, '')
      return `<${tagName}${attrs}></${tagName}>`
    }
    return `<${tagName}${attrs}>`
  })

  return result
}

// ============================================================================
// walk : dispatch sur le type de node
// ============================================================================
export function walk(node: Node, ctx: Ctx): string {
  switch (node.type) {
    case 'root':
      return node.children.map((c) => walk(c, ctx)).join('')

    case 'text':
      // Pas de pré-escape ici : le texte va dans surgicalHtml qui passe
      // ensuite par escapeTpl (transpiler/index.ts) — qui escape `\\`, `\``
      // et `\${` correctement pour le template literal d'output.
      return node.content ?? ''

    case 'expr': {
      const isRaw = node._is_raw === true || (node.expr ?? '').startsWith('{')
      const cleanExpr = (node.expr ?? '').toString().trim()

      state.counter += 1
      const lid = `t${state.counter}`
      const vars = getEffectVars(cleanExpr)
      // Site EXPR (interpolation texte {…}).
      const jsVar = cleanJsExpr(cleanExpr, state.externalVars, state.templateLang, state.moduleName)

      const updMethod = isRaw ? '_mjs_updHtml' : '_mjs_updText'

      if (ctx.type === 'await') {
        // `{{…}}` : un nœud texte afficherait les balises → conteneur posé par la branche, rempli
        // à sa construction (même instantané que `{…}`)
        if (isRaw) {
          ctx.updates.push(`{ const n${lid} = __nodes['${lid}']; if(n${lid}) n${lid}.innerHTML = String(${jsVar}); }`)
          return `<span mjs-l-id='${lid}'></span>`
        }
        return `\${${jsVar}}`
      }

      if (ctx.loops.length > 0) {
        // une var
        // EXTÉRIEURE au `{for}` (ni l'item ni l'index de la loop — getEffectVars
        // ne renvoie que des VRAIS `$.xxx`, jamais des noms de boucle nus)
        // interpolée en TEXTE dans le corps d'un `{for}` ne déclenchait JAMAIS
        // de re-render sur sa mutation : `vars` (calculé plus haut) n'était
        // utilisé NULLE PART ici — ni `registerEffect` (le code vit dans la
        // closure `updateFn` DU FOR, inaccessible depuis un effect top-level :
        // `__nodes`/`n${lid}` n'existent que dans CE scope précis, un appel
        // depuis `_mjs_effectsAll` lancerait un `ReferenceError`), ni
        // `state.structVars` (qui pilote `_mjs_renderStructVars` — le SEUL
        // déclencheur qui fait re-tourner `_mjs_renderStruct` → `_mjs_updFor` →
        // réapplique cette interpolation). Seule l'ITÉRABLE du `{for}` lui-même
        // (`compileFor`, cf. plus bas) y était ajoutée : `{for item in $items}
        // <p>{item}:{$sharedWidth}</p>{end}` — `$sharedWidth` MUTÉ depuis un
        // bouton hors-loop restait inerte À VIE dans le texte de la row (vérifié
        // empiriquement : `_state.sharedWidth` change bien, le texte jamais).
        // Fix : même traitement que le two-way binding en `{for}`
        // (`bindingStandard`, attributes/index.ts, commentaire "#5") — chaque
        // dep externe rejoint `structVars`. Sans effet pour `{item}`/`{index}`
        // (vars vide, rien à ajouter) — aucune régression sur le chemin normal.
        for (const v of vars) state.structVars.add(v)
        if (isRaw) {
          // Factorise `String(${jsVar})` en variable locale (1 call au lieu de 2).
          ctx.updates.push(`{ const n${lid} = __nodes['${lid}']; if(n${lid}) { const _mjs_ts = String(${jsVar}); if (n${lid}._mjs_h !== _mjs_ts) { n${lid}.innerHTML = _mjs_ts; n${lid}._mjs_h = _mjs_ts; } } }`)
          return `<span mjs-l-id='${lid}'></span>`
        }
        // text loop : assigne via node.data direct (équivalent nodeValue,
        // V8 spécialise mieux Text.data) + skip String() si déjà string.
        ctx.updates.push(`{ const n${lid} = __nodes['${lid}']; if(n${lid}) { const _mjs_tv = ${jsVar}; const _mjs_ts = typeof _mjs_tv === 'string' ? _mjs_tv : (_mjs_tv == null ? '' : String(_mjs_tv)); if (n${lid}.data !== _mjs_ts) n${lid}.data = _mjs_ts; } }`)
        return `<script type='mjs/marker' mjs-l-t='${lid}'></script>`
      }

      // V2 — Update sans condition, enregistré dans effectsByVar par chaque var.
      const code = `this.${updMethod}('${lid}', ${jsVar});`
      registerEffect(code, vars)
      ctx.updates.push(code)
      return isRaw
        ? `<span mjs-id='${lid}'></span>`
        : `<script type='mjs/marker' mjs-t='${lid}'></script>`
    }

    case 'tag':   return compileTag(node, ctx)
    case 'if':    return compileIf(node, ctx)
    case 'for':   return compileFor(node, ctx)
    case 'await': return compileAwait(node, ctx)
    case 'key':   return compileKey(node, ctx)
    case 'const': return compileConst(node, ctx)

    default:
      return ''
  }
}

// ============================================================================
// compileTag — port partiel. Le dispatch d'attributs (event_listener,
// binding_*, etc.) est en stub et reste à porter.
// ============================================================================
export function compileTag(node: Node, ctx: Ctx): string {
  if (node.name === '@slot') state.hasDynamicSlots = true

  let id: string | null = null
  let lid: string | null = null
  let attrStr = ''

  if (ctx.loops.length > 0) {
    state.counter += 1
    lid = `l${state.counter}`
  }

  const selfStart = ctx.updates.length

  const hasEvent = node.attrs.some((a) => {
    const n = a.name
    if (n && n.startsWith('@')) {
      const isSpecial = isSpecialAttr(n)
      const isBoolean = MJS_BOOLEAN_PROPS.includes(n.slice(1))
      return !isSpecial && !isBoolean
    }
    return false
  })

  if (hasEvent && ctx.loops.length > 0) {
    const currentDepth = ctx.loops[ctx.loops.length - 1].depth
    for (const l of ctx.loops) {
      const idxVar = l.depth === currentDepth ? l.index : l.internalIndex
      // Ne PAS poser l'attribut data-mjs-idx-X dans le HTML du template.
      // L'updateFn (appelée immédiatement après create + à chaque mutation)
      // le pose via setAttribute. Cela rend le HTML statique → permet
      // cloneNode au lieu de createElement × N.
      //
      // Avant : `<a data-mjs-idx-0='${index}'>` → interpolation runtime
      //   → empêche cloneNode → tombe en mode imperative.
      // Après : `<a>` + setAttribute via updateFn → HTML statique
      //   → cloneNode possible si pas d'AUTRES interpolations dans le sous-arbre.
      if (lid) {
        // Optim #8 — Pose la valeur en propriété JS directe (`_mjs_idx_N`)
        // pour permettre aux event handlers d'éviter `getAttribute` (slower).
        // Plus de setAttribute miroir : les reconstructs lisent la prop
        // en priorité (posée ici par la MÊME updateFn), l'attribut n'était
        // jamais relu. Économise 1 setAttribute × rows × loops au create et
        // à chaque réordonnancement.
        const idxUpd = `{ const n_idx = __nodes['${lid}']; if(n_idx && n_idx._mjs_idx_${l.depth} !== ${idxVar}) { n_idx._mjs_idx_${l.depth} = ${idxVar}; } }`
        if (!ctx.updates.includes(idxUpd)) ctx.updates.push(idxUpd)
      }
    }
  }

  // Dispatch attributs via attributes/index.ts
  for (const attr of node.attrs) {
    let rawVal = (attr.val ?? '').toString()
    const attrName = attr.name

    // @open booléen vide vs @click event vide
    if (attrName?.startsWith('@') && (rawVal === '' || rawVal === 'true')) {
      const isSpecial = isSpecialAttr(attrName)
      const isBoolean = MJS_BOOLEAN_PROPS.includes(attrName.slice(1))
      if (!isSpecial && !isBoolean) rawVal = '->'
      else if (isBoolean && rawVal === '') rawVal = 'true'
    }

    const env: AttrCtx = {
      compiler: state, node, attr, attrName, rawVal, ctx, id, lid, attrStr,
    }

    try {
      const result = dispatchAttribute(env)
      if (result.id !== undefined) id = result.id
      if (result.attrStr !== undefined) attrStr = result.attrStr
    } catch (err: any) {
      // Certains bindings stub. On ignore silencieusement
      // pour ne pas planter le compile sur des attrs non encore portés.
      if (!err.message?.includes('not yet implemented')) throw err
      // Fallback : émet l'attr en static littéral pour ne rien casser visuellement.
      // échappe l'apostrophe (`&#39;`, décodée au parse HTML) : `title="l'x"`
      // aurait sinon fermé le quote et généré des attributs parasites (chemin clone).
      if (attrName && !attrName.startsWith('@')) {
        attrStr += ` ${attrName}='${rawVal.replace(/'/g, '&#39;')}'`
      }
    }
  }

  if (id) attrStr += ` mjs-id='${id}'`
  if (lid) attrStr += ` mjs-l-id='${lid}'`

  // entrer dans <svg>/<math> pose le namespace
  // ambiant, hérité par tout le sous-arbre (cf. Ctx.svgNs) ; ailleurs, le
  // namespace ambiant du PARENT se transmet tel quel (une fois DANS un <svg>,
  // tout le sous-arbre y reste — sauf sous <foreignObject>, qui rouvre du HTML : svgNs remis à null).
  const tagNameLower = (node.name ?? '').toLowerCase()
  const childCtx = tagNameLower === 'svg' ? { ...ctx, svgNs: SVG_NS }
    : tagNameLower === 'math' ? { ...ctx, svgNs: MATH_NS }
    : tagNameLower === 'foreignobject' ? { ...ctx, svgNs: null }
    : ctx

  const selfEnd = ctx.updates.length
  const inner = node.children.map((c) => walk(c, childCtx)).join('')

  if (selfEnd > selfStart) {
    const selfSlice = ctx.updates.splice(selfStart, selfEnd - selfStart)
    ctx.updates.push(...selfSlice)
  }

  if (VOID_TAGS.includes((node.name ?? '').toLowerCase())) {
    return `<${node.name}${attrStr}>`
  }
  return `<${node.name}${attrStr}>${inner}</${node.name}>`
}

// ============================================================================
// compileIf — émis SANS condition, classé "struct" → exécuté à chaque tick
// par `_mjs_renderStruct`. La var de la condition est consommée par l'expr `c`
// mais inutile de l'enregistrer ailleurs : `_mjs_renderStruct` est always-run.
// ============================================================================
export function compileIf(node: Node, ctx: Ctx): string {
  state.counter += 1
  const id = `if${state.counter}`

  // Collecter les vars qui pilotent les conditions du `{if}`.
  for (const branch of node.branches) {
    if (branch.expr) {
      for (const v of getEffectVars(branch.expr)) state.structVars.add(v)
    }
  }

  if (ctx.type !== 'root') {
    // Parenthèses obligatoires : une condition elle-même ternaire
    // (`{if $mode ? 1 : 0}`) se regrouperait sinon avec la chaîne générée
    // (`a ? b : c ? 0 : -1`) → branche inversée.
    // Site EXPR (condition {if}/{elsif}).
    const evalParts = node.branches.map((b, i) =>
      b.expr ? `(${cleanJsExpr(b.expr, state.externalVars, state.templateLang, state.moduleName)}) ? ${i} : ` : `${i}`
    )
    let evalLogic = evalParts.join('')
    const last = node.branches[node.branches.length - 1]
    if (last.expr != null) evalLogic += '-1'

    const allBranchUpdates: string[][] = []
    // `postUpdates` (générées par `generateCreateFnBody`, ex.
    // `value` d'un `<select>` dont les `<option>` viennent d'un `{for}`
    // imbriqué) DOIVENT s'exécuter APRÈS `branchUpdates` : posées trop tôt (avant
    // que le `{for}` ne peuple les options réelles), la valeur retombe sur la
    // 1re option. `__nodes` est déjà en scope ici (mergé par `_mjs_updItemIf`).
    const allPostUpdates: string[][] = []
    const htmlLogicParts: string[] = []
    // Chaque branche a sa propre createFn(item, index) → {fragment, refs}.
    // Le runtime appelle la createFn de la branche choisie et merge refs dans __nodes.
    for (let i = 0; i < node.branches.length; i++) {
      const branch = node.branches[i]
      const preSize = ctx.updates.length
      const innerHtmlRaw = branch.children.map((c) => walk(c, ctx)).join('')
      const branchUpdatesRaw = ctx.updates.splice(preSize, ctx.updates.length - preSize)
      // cf. commentaire jumeau plus haut (`splitDeferredUpdates`) :
      // un two-way `<select value=!{...}>` de CETTE branche doit attendre les
      // <option> d'un {for} imbriqué, comme `postUpdates` (paths.ts) juste en dessous.
      const { updates: branchUpdates, deferred } = splitDeferredUpdates(branchUpdatesRaw)
      allBranchUpdates.push(branchUpdates)

      // `compactPaths` — accès aux nœuds écrits `µ._p(_f,2,0)`, marqueurs `µ._tm(…)` : des octets
      // en moins dans le code livré, au prix d'un appel de fonction à la construction. Vrai tant
      // qu'on n'est PAS dans une boucle : sous un `{for}`, cette createFn est construite une fois
      // par LIGNE et garde ses chaînes de propriétés directes. Même critère aux autres blocs.
      const createBody = generateCreateFnBody(innerHtmlRaw, { splitSelectPostUpdates: true, compactPaths: ctx.loops.length === 0 })
      allPostUpdates.push([...(createBody.postUpdates ?? []), ...deferred])
      // La fonction prend les vars de boucle parent (item, index, etc.) en closure.
      // On émet directement le body inline pour bénéficier de l'inlining V8.
      htmlLogicParts.push(`if (_c_${id} === ${i}) { _mjs_cfn = () => { ${createBody.body} }; }`)
    }
    const htmlLogic = htmlLogicParts.join(' else ')

    const branchExecParts: string[] = []
    for (let i = 0; i < allBranchUpdates.length; i++) {
      const branchUpdates = allBranchUpdates[i]
      const postUpdates = allPostUpdates[i]
      if (branchUpdates.length === 0 && postUpdates.length === 0) continue
      const wrapped = branchUpdates.map((u) => `{ ${u} }`).join(' ') + (postUpdates.length > 0 ? ' ' + postUpdates.map((u) => `{ ${u} }`).join(' ') : '')
      branchExecParts.push(`if (_c_${id} === ${i}) { ${wrapped} }`)
    }
    const branchExec = branchExecParts.join(' else ')
    const branchExecBlock = branchExec === '' ? '' : `if (_c_${id} >= 0) { ${branchExec} }`

    // `_c_${id}` (pas `c`) : ce code s'exécute dans le scope des vars de boucle
    // — un item nommé `c` provoquait `const c = c.open ? …` → TDZ au runtime.
    //
    // Même précaution pour `_mjs_ifStart`/`_mjs_ifEnd`/`_mjs_cfn` (avant :
    // `startNode`/`endNode`/`cfn` nus) : un item de boucle nommé `startNode`
    // (mot anglais plausible pour un item DOM/arbre) faisait lire `startNode`
    // dans `evalLogic` (ex. `{if startNode.active}`) — embarqué dans CE MÊME
    // scope — au lieu de désigner l'item utilisateur, la lecture retombait
    // silencieusement sur l'ancre interne (corruption sans erreur). Régression
    // verrouillée par tests/reserved-names-collision.test.ts.
    const ifUpdate = `{ const _mjs_ifStart = __nodes['s-${id}']; const _mjs_ifEnd = __nodes['e-${id}']; if (_mjs_ifStart && _mjs_ifEnd) { const _c_${id} = ${evalLogic}; if (_c_${id} !== _mjs_ifStart._mjs_old_branch) { let _mjs_cfn = null; ${htmlLogic} this._mjs_updItemIf(_mjs_ifStart, _mjs_ifEnd, _mjs_cfn, __nodes); _mjs_ifStart._mjs_old_branch = _c_${id}; } ${branchExecBlock} } }`
    ctx.updates.push(ifUpdate)
    return `<script type='mjs/marker' mjs-l-t='s-${id}'></script><script type='mjs/marker' mjs-l-t='e-${id}'></script>`
  }

  // Site EXPR (condition {if}/{elsif}, racine).
  const evalParts = node.branches.map((b, i) =>
    b.expr ? `(${cleanJsExpr(b.expr, state.externalVars, state.templateLang, state.moduleName)}) ? ${i} : ` : `${i}`
  )
  let evalLogic = evalParts.join('')
  const last = node.branches[node.branches.length - 1]
  if (last.expr != null) evalLogic += '-1'

  const preSize = ctx.updates.length

  // Pour chaque branche, on capture (splice) les updates d'interpolation/binding
  // générées par le walk de SON contenu. Ces updates (`_mjs_updText`/`_mjs_updAttr`…)
  // restent enregistrées dans `effectsByVar` (réactivité ultérieure : un clic
  // qui mute la var re-fire l'update, car `_mjs_updIf` aura mergé les refs de la
  // branche dans `this._mjs_nodes`).
  //
  // L'état INITIAL doit aussi être appliqué dès que `_mjs_updIf` vient de créer la
  // branche (mount, ou re-création après un changement de branche) — sans quoi
  // les `_mjs_updText('tN', …)` ne trouvent pas leur node et ne font rien. On
  // inline donc ces updates dans le `ifUpdate` (classé "struct" → exécuté par
  // `_mjs_renderStruct`), juste APRÈS `_mjs_updIf` : à ce moment les refs de la
  // branche active ont été mergées dans `this._mjs_nodes`. Même mécanique que le
  // cas `{if}` imbriqué dans `{for}` (`branchExecBlock`) et que `compileAwait`.
  //
  // BUG : ce même contenu de branche est
  // AUSSI walk()é normalement ci-dessous, ce qui déclenche `registerEffect`
  // (interpolations texte, bindings d'attribut…) : la copie qui en résulte
  // finissait NUE dans `_mjs_effectsAll` (mount) et `_mjs_effectsByVar` (dispatch
  // ciblé sur mutation), sans la garde `_c_${id} === i` que porte
  // `branchExecBlock` plus bas — `{if x?.y} … {x.y.z} … {end}` évaluait
  // `x.y.z` au montage même quand `x?.y` est faux, malgré le `?.` de la
  // condition. Fix : `effectGuardStack` (state.ts) fait porter la MÊME garde
  // de branche aux deux copies — `registerEffect` les enveloppe désormais
  // toutes deux d'un `if (this._mjs_old?.${id} === i) { … }` tant qu'on walk cette
  // branche. `this._mjs_old.${id}` est déjà à jour à l'exécution de ces copies :
  // `_mjs_renderStruct` tourne TOUJOURS avant les effects (mount et update, cf.
  // invalidate-struct-before-effects.test.ts).
  const allBranchUpdates: string[][] = []
  // cf. commentaire jumeau dans la branche non-root ci-dessus :
  // `postUpdates` doivent s'exécuter APRÈS `branchUpdates`, jamais dans le corps
  // de la createFn (trop tôt pour un `{for}` imbriqué qui peuple des <option>).
  const allPostUpdates: string[][] = []
  const htmlParts = node.branches.map((b, i) => {
    const branchPre = ctx.updates.length
    state.effectGuardStack.push(`this._mjs_old?.${id} === ${i}`)
    let innerHtmlRaw: string
    try {
      innerHtmlRaw = b.children.map((c) => walk(c, ctx)).join('')
    } finally {
      // try/finally : une branche fautive (walk qui lève) ne doit pas laisser
      // la pile de gardes désynchronisée pour les branches/if suivants.
      state.effectGuardStack.pop()
    }
    const branchUpdates = ctx.updates.splice(branchPre, ctx.updates.length - branchPre)
    allBranchUpdates.push(branchUpdates)
    // `compactPaths` : cf. la branche non-root ci-dessus — forme compacte hors boucle seulement.
    const createBody = generateCreateFnBody(innerHtmlRaw, { splitSelectPostUpdates: true, compactPaths: ctx.loops.length === 0 })
    allPostUpdates.push(createBody.postUpdates ?? [])
    return `if (_c_${id} === ${i}) { _mjs_cfn = () => { ${createBody.body} }; }`
  })
  const htmlLogic = htmlParts.join(' else ')

  // Exécution de l'état initial des interpolations/bindings de la branche
  // active. `c >= 0` exclut la pseudo-branche `-1` (aucun `{else}` et toutes
  // les conditions fausses → rien de rendu).
  const branchExecParts: string[] = []
  for (let i = 0; i < allBranchUpdates.length; i++) {
    const branchUpdates = allBranchUpdates[i]
    const postUpdates = allPostUpdates[i]
    if (branchUpdates.length === 0 && postUpdates.length === 0) continue
    const wrapped = branchUpdates.map((u) => `{ ${u} }`).join(' ') + (postUpdates.length > 0 ? ' ' + postUpdates.map((u) => `{ ${u} }`).join(' ') : '')
    branchExecParts.push(`if (_c_${id} === ${i}) { ${wrapped} }`)
  }
  const branchExec = branchExecParts.join(' else ')
  const branchExecBlock = branchExec === '' ? '' : ` if (_c_${id} >= 0) { ${branchExec} }`

  // V2 — pas de `if (dirty & ...)` : exécuté à chaque tick via _mjs_renderStruct.
  // On passe une createFn (au lieu de html+paths) à _mjs_updIf.
  // `_c_${id}` (avant : `c` nu). Les
  // updates root s'exécutent DANS la closure `init`, où TOUTES les vars top-level
  // du script sont visibles : un `c = 42` (compteur/caractère, nom banal) au
  // <script> + `{if c > 3}` générait `const c = (c > 3) ? …` → auto-référence en
  // TDZ, crash dur à chaque _mjs_renderStruct. `_mjs_cfn` (pas `cfn`) même précaution.
  const ifUpdate = `{ const _mjs_o = (this._mjs_old ??= {}); const _c_${id} = ${evalLogic}; if(_c_${id} !== _mjs_o.${id}){ let _mjs_cfn = null; ${htmlLogic} this._mjs_updIf('${id}', _mjs_cfn); _mjs_o.${id} = _c_${id}; }${branchExecBlock} }`

  ctx.updates.splice(preSize, 0, ifUpdate)

  return `<script type='mjs/marker' mjs-t='s-${id}'></script><script type='mjs/marker' mjs-t='e-${id}'></script>`
}

// ============================================================================
// compileFor — classé "struct", exécuté à chaque tick par `_mjs_renderStruct`.
// L'idempotence de `_mjs_updFor` (clés stables + LIS) garantit qu'aucun travail
// inutile n'est fait sur les ticks où la collection est inchangée.
// ============================================================================
export function compileFor(node: Node, ctx: Ctx): string {
  state.counter += 1
  const id = `for${state.counter}`

  // Collecter les vars qui pilotent l'iterable. Si la mutation
  // d'une autre var arrive, `_mjs_renderStruct` peut être skip (gain select1k).
  for (const v of getEffectVars(node.iterable)) {
    state.structVars.add(v)
  }

  // Site EXPR (itérable {for X in ITERABLE}).
  const jsIterable = cleanJsExpr(node.iterable, state.externalVars, state.templateLang, state.moduleName)
  const indexVar = node.index ?? 'index'
  const internalIndex = `_mjs_idx_${ctx.loops.length}`

  const loopInfo: LoopInfo = {
    item: node.item ?? '',
    index: indexVar,
    internalIndex,
    iterable: jsIterable,
    depth: ctx.loops.length,
    key: node.key ?? null,
  }
  // noms que CE `{for}` introduit dans le corps des handlers de son sous-arbre :
  // le squelette de reconstruction les réassigne en tête de handler, ils doivent
  // donc y rester LOCAUX même si le `<script>` porte un homonyme (cf. state.templateLocals)
  if (loopInfo.item) state.templateLocals.add(loopInfo.item)
  state.templateLocals.add(indexVar)
  const newLoops = ctx.loops.concat([loopInfo])

  const keyExpr = node.key ? `${node.item}.${node.key}` : 'null'
  // Si la clef est un attribut statique (`item.X`), on passe le NOM de
  // l'attribut (`'X'`) au runtime au lieu de générer une fonction
  // `(item) => item.X`. Le runtime fait `item[keyAttr]` direct, évitant
  // l'overhead d'un appel de fonction par iteration. Sur 1000 items, gain
  // ~3-5ms.
  const keyAttrLit = node.key ? `'${node.key}'` : 'null'

  const loopCtx: Ctx = { type: 'for', loops: newLoops, updates: [] }
  const bodyRaw = node.children.map((c) => walk(c, loopCtx)).join('')
  // Les déclarations `{const}` (marquées CONST_DECL_PREFIX) sont émises TELLES
  // QUELLES et HISSÉES en tête — sans wrapper `{ … }`, sinon `NOM` serait
  // scopé à son bloc et invisible des updates frères qui le lisent. L'ordre
  // RELATIF des const est préservé (un `{const}` peut dépendre d'un précédent).
  const constDecls = loopCtx.updates.filter((u) => u.startsWith(CONST_DECL_PREFIX))
  const regularUpdates = loopCtx.updates.filter((u) => !u.startsWith(CONST_DECL_PREFIX))
  const constPrefix = constDecls.length > 0 ? constDecls.join(' ') + ' ' : ''
  let localUpdates = constPrefix + regularUpdates.map((u) => `{ ${u} }`).join(' ')

  // Génère directement une createFn(item, index) → {fragment, refs}.
  // Plus de cloneNode, plus de walk paths, plus de cache HTML.
  // Élagage des refs mortes : on ne fait naviguer/exposer par la factory
  // que les refs réellement consommées — celles citées par `__nodes['X']` dans
  // les updates de la loop (updateFn, lookups live, tplFn des for imbriqués)
  // et celles portant un event listener. Les markers extraits « au cas où »
  // par le walk disparaissent (6 des 13 refs d'un row de bench).
  const keepRefs = new Set<string>()
  {
    const reUses = /__nodes\['([^'\$\{]+)'\]/g
    let mU: RegExpExecArray | null
    while ((mU = reUses.exec(localUpdates)) !== null) keepRefs.add(mU[1])
    if (state.events) {
      for (const evtType of Object.keys(state.events)) {
        const idMap = state.events[evtType]
        if (idMap) for (const eid of Object.keys(idMap)) keepRefs.add(eid)
      }
    }
  }
  // Gabarit de LIGNE : jamais `compactPaths` (défaut faux). Ce corps est exécuté une fois par
  // ligne — 1 000 fois sur une création de liste : il garde ses chaînes de propriétés directes,
  // sans appel de fonction, et son code reste celui d'avant, à l'octet.
  const createBody = generateCreateFnBody(bodyRaw, { keepRefs, splitSelectPostUpdates: true })
  // `postUpdates` (ex. `value` d'un `<select>` dont les
  // `<option>` viennent d'un `{for}` imbriqué) doivent courir APRÈS les updates
  // de CETTE row (mêmes `__nodes`) : rejouées ici, dans le MÊME `localUpdates`
  // qu'`extractRefsForClosure` transforme juste après (mode clone : toujours vide,
  // `keepRefs` ci-dessus reste calculé sur le `localUpdates` D'AVANT cet ajout).
  if (createBody.postUpdates && createBody.postUpdates.length > 0) {
    localUpdates += ' ' + createBody.postUpdates.map((u) => `{ ${u} }`).join(' ')
  }

  // Optim #5 — Refs en closure (style Solid) : extrait les refs utilisées dans
  // `localUpdates` en variables locales DANS le tplFn, puis crée un updateFn
  // local qui ferme sur ces variables. Évite le dict-lookup `__nodes['lid']` à
  // chaque appel d'update (mesure attendue : ~30-50ms sur create1k/replace1k).
  const { refIds: usedRefIds, transformedBody: localUpdatesClosure } =
    extractRefsForClosure(localUpdates, createBody.refIds)

  // Optim #5c — _mjs_registerRefs sélectif compile-time.
  // Collecte les ids du {for} qui ont AU MOINS un event listener (via state.events).
  // Si aucun → on skip `_mjs_registerRefs` entièrement.
  // Sinon → on génère un register inline pour les N ids concernés (au lieu
  // d'itérer Object.keys + Set.has() par row).
  const evtIdsInFor: string[] = []
  if (state.events) {
    for (const evtType of Object.keys(state.events)) {
      const idMap = state.events[evtType]
      if (!idMap) continue
      for (const eid of Object.keys(idMap)) {
        if (createBody.refIds.includes(eid) && !evtIdsInFor.includes(eid)) {
          evtIdsInFor.push(eid)
        }
      }
    }
  }
  // Refs à pré-extraire : union(usedRefIds, evtIdsInFor) pour que les events
  // aient leur _nref_ disponible avant le register.
  const refsToExtract = Array.from(new Set([...usedRefIds, ...evtIdsInFor]))
  const refExtractLines = refsToExtract.map(
    (rid) => `const _nref_${safeRefVarName(rid)} = __nodes['${rid}'];`
  ).join(' ')

  let registerRefsCode: string
  if (evtIdsInFor.length === 0) {
    // Aucun event dans le {for} → skip _mjs_registerRefs entièrement.
    registerRefsCode = ''
  } else {
    // Génère un register inlined pour les N ids concernés.
    // routing événementiel par PROP sur le nœud (`_mjs_ids`) au lieu d'une
    // WeakMap par instance (comme Solid/Svelte) : ~40 % plus rapide au profil,
    // pas d'alloc/maintenance de WeakMap, lookup au clic plus direct.
    const inlineRegister = evtIdsInFor.map((eid) => {
      const refExpr = `_nref_${safeRefVarName(eid)}`
      return `{ const __n = ${refExpr}; if (__n && __n.nodeType === 1) { const __ex = __n._mjs_ids; if (__ex) { if (!__ex.includes('${eid}')) __ex.push('${eid}'); } else { __n._mjs_ids = ['${eid}']; } } }`
    }).join(' ')
    registerRefsCode = `{ ${inlineRegister} }`
  }

  // Perf, modèle Solid/Svelte : fusionner la pose d'état INITIALE dans la
  // factory. Au create, _mjs_reconcileList rappelait l'updateFn juste après
  // l'insertion uniquement pour poser data/classe/idx — on l'appelle ici, dans
  // le tplFn, et on signale `_mjs_init: 1` → _mjs_reconcileList saute ce passage pour
  // les entries FRAÎCHES (les tours suivants repassent par updateFn, _mjs_init=0).
  // RESTRICTION : composants SANS binding sensible à l'insertion
  // (@transition/@attach/… — flag hasDestroyHooks) ; sinon comportement
  // historique (pose en pass 2 après insertion).
  const __fuseInit = !state.hasDestroyHooks
  const tplFn = `(${node.item || '_item'}, ${indexVar}) => {
    const __built = (() => { ${createBody.body} })();
    const __nodes = __built.refs;
    __nodes._mjs_reg = true;
    ${refExtractLines}
    ${registerRefsCode}
    const updateFn = (${node.item || '_item'}, ${indexVar}) => { const ${internalIndex} = ${indexVar}; ${localUpdatesClosure} };
    ${__fuseInit ? `updateFn(${node.item || '_item'}, ${indexVar});` : ''}
    return { fragment: __built.fragment, refs: __nodes, updateFn${__fuseInit ? ', _mjs_init: 1' : ''} };
  }`

  // Fallback (compat) — pour les autres callers (non _mjs_reconcileList) qui
  // appellent updateFn(__nodes, item, index) à l'ancienne. Inutile en pratique
  // pour _mjs_reconcileList, mais conserve la signature pour _mjs_updFor/_mjs_updList.
  const updateFn = `(__nodes, ${node.item}, ${indexVar}) => { const ${internalIndex} = ${indexVar}; ${localUpdates} }`

  if (ctx.type === 'root') {
    ctx.updates.push(`{ const _mjsThis = this; this._mjs_updFor('${id}', ${jsIterable}, ${tplFn}, (${node.item}, ${indexVar}) => ${keyExpr}, ${updateFn}, ${keyAttrLit}); }`)
    return `<script type='mjs/marker' mjs-t='s-${id}'></script><script type='mjs/marker' mjs-t='e-${id}'></script>`
  }

  // Branche `{await}` sans loop parent : le {for} pose ses markers
  // `s-forN`/`e-forN` directement dans le fragment de la branche. Les updates
  // sont inlinées par `compileAwait` dans la createFn de branche et exécutées
  // en mode `__nodes` local (le fragment vient juste d'être construit, pas
  // encore dans `this._mjs_nodes`). On utilise `_mjs_updList` avec un cacheId statique
  // (pas de parent loop → pas de discriminant d'instance nécessaire).
  if (ctx.type === 'await' && ctx.loops.length === 0) {
    // `_mjs_forStart`/`_mjs_forEnd`
    // (avant : `startNode`/`endNode` nus) : mêmes tueurs que `_mjs_ifStart`. Ici
    // les vars TOP-LEVEL du script sont en scope (branche {await} sans loop) — un
    // `startNode = {...}` du <script> + `{for x in startNode.items}` lisait l'ANCRE
    // DOM au lieu de l'objet. Cf. reserved-names-collision.test.ts ({await}+{for}).
    ctx.updates.push(`{ const _mjsThis = this; const _mjs_forStart = __nodes['s-${id}']; const _mjs_forEnd = __nodes['e-${id}']; if(_mjs_forStart && _mjs_forEnd) { this._mjs_updList('${id}', _mjs_forStart, _mjs_forEnd, ${jsIterable}, ${tplFn}, (${node.item}, ${indexVar}) => ${keyExpr}, ${updateFn}, ${keyAttrLit}); } }`)
    return `<script type='mjs/marker' mjs-l-t='s-${id}'></script><script type='mjs/marker' mjs-l-t='e-${id}'></script>`
  }

  state.counter += 1
  const wrapperLid = `l${state.counter}`
  const parent    = ctx.loops[ctx.loops.length - 1]
  const parentIdx = parent.index   // l'item du parent, lui, est lu par `discriminant()` plus bas — il n'entre plus seul dans le cacheId

  // le pool (_mjs_reconcileList,
  // __canPool ⇐ _mjs_noDestroyHooks) réutilise le sous-arbre DOM d'une row
  // détruite EN L'ÉTAT pour une row future, sans jamais vider le contenu
  // qu'un `{for}` imbriqué y avait rendu : le nouveau `uniqueCacheId` (dérivé
  // du discriminant du NOUVEL item, forcément différent) est traité comme un
  // cache FRAIS (vide) alors que le DOM entre ses marqueurs contient encore
  // les <li> de l'ANCIEN occupant → ils s'AJOUTENT aux nouveaux au lieu
  // d'être remplacés (repro empirique confirmée avant ce fix : row réutilisée
  // affichant les enfants de l'ancien ET du nouvel item mélangés). Le pool
  // suppose que seuls des attributs/texte changent (updateFn suffit) — faux
  // dès qu'un {for} imbriqué produit un nombre variable d'enfants indexés par
  // un cache séparé. Désactiver le pool POUR TOUT LE COMPOSANT dès qu'un {for}
  // imbriqué existe quelque part est plus sûr qu'un vidage chirurgical du
  // sous-arbre au moment du pop (il faudrait aussi tracer l'ancre de FIN, pas
  // seulement le début, et gérer une imbrication à N niveaux).
  state.hasDestroyHooks = true

  // #1 — Le cacheId de la loop imbriquée DOIT être stable à la réassignation du
  // parent. Avant : basé sur `parentItem._mjsId` (identité d'OBJET) → réassigner
  // le tableau parent (mêmes clés, nouveaux objets) générait un nouveau _mjsId →
  // nouveau cacheId → le cache interne n'était pas retrouvé → l'ancien contenu
  // restait DANS le DOM + le nouveau s'ajoutait (duplication "NEW x X").
  // Si le parent est keyé (`by X`), on indexe sur SA CLÉ (stable) ; sinon on
  // garde le fallback historique (_mjsId d'objet, ou l'index si primitif).
  // Occurrence sœur d'un correctif précédent — l'assign direct
  // `_mjsId ??= …` dupliquait ici le motif fautif (énumérable, crash sur objet
  // gelé) ; `this._mjs_mjsTag(...)` est désormais la SEULE source de vérité
  // (mjs_element.ts), partagée avec `_mjs_reconcileList`.
  //
  // #2 — Le cacheId doit aussi être unique PAR BRANCHE, à toute profondeur.
  // Avant : seul le parent DIRECT entrait
  // dans le discriminant. À TROIS niveaux, le grand-parent n'y était donc nulle
  // part : deux branches sœurs du grand-parent donnaient le MÊME cacheId à leur
  // boucle interne (le pire cas : un parent non keyé sur des CHAÎNES, qui
  // retombe sur l'index — 0, 1, 2… identiques d'une branche à l'autre). Les
  // branches se partageaient les mêmes cases de cache : au rafraîchissement,
  // `_mjs_reconcileList` retrouvait les clefs de la DERNIÈRE branche rendue,
  // déplaçait SES nœuds entre les ancres de la PREMIÈRE, et ceux que celle-ci
  // avait créés restaient en place, inconnus du cache → contenu affiché EN
  // DOUBLE, sans une ligne d'erreur (constaté en production, chaque valeur
  // rendue deux fois). Le discriminant compose donc
  // maintenant TOUTE la chaîne des ancêtres, séparateur `\x1f` (jamais dans une
  // clef réelle). Les ancêtres au-dessus du parent direct sont indexés par leur
  // `internalIndex` (`_mjs_idx_N`) et non par leur `index` : à ce niveau
  // d'imbrication, deux boucles qui n'ont pas nommé leur index s'appellent
  // toutes deux `index` et la plus proche masque l'autre.
  // Le cas courant à DEUX niveaux émet exactement le même code qu'avant.
  const discriminant = (loop: LoopInfo, idx: string) => loop.key
    ? `(${loop.item} != null && typeof ${loop.item} === 'object' ? ${loop.item}.${loop.key} : ${idx})`
    : `(typeof ${loop.item} === 'object' && ${loop.item} !== null ? this._mjs_mjsTag(${loop.item}) : ${idx})`

  const ancestors = ctx.loops.slice(0, -1).map(loop => `${discriminant(loop, loop.internalIndex)} + '\\x1f' + `).join('')
  const uniqueCacheId = `'${id}_' + ${ancestors}${discriminant(parent, parentIdx)}`

  // `_mjs_forStart`/`_mjs_forEnd`
  // (avant : `startNode`/`endNode` nus) : dans un {for} imbriqué, l'item/index de
  // la boucle PARENTE est en scope. Un item parent nommé `startNode` était shadowé
  // par l'ancre interne → itérable/clé/keyFn lisaient le MARQUEUR DOM (corruption
  // silencieuse). Cf. reserved-names-collision.test.ts ({for}+{for}).
  ctx.updates.push(`{ const _mjsThis = this; const _mjs_forStart = __nodes['s-${wrapperLid}']; const _mjs_forEnd = __nodes['e-${wrapperLid}']; if(_mjs_forStart && _mjs_forEnd) { this._mjs_updList(${uniqueCacheId}, _mjs_forStart, _mjs_forEnd, ${jsIterable}, ${tplFn}, (${node.item}, ${indexVar}) => ${keyExpr}, ${updateFn}, ${keyAttrLit}); } }`)

  // Wrapper start/end markers : ces 2 placeholders matchent les ids
  // `s-${wrapperLid}` et `e-${wrapperLid}` dans le __paths du contexte parent
  // (loop, if, ou key). On émet `<!--$-->` × 2 ; l'attribution `s-`/`e-` se
  // fait dans le HTML brut via les pseudo-markers que extractPaths reconnaîtra.
  return `<script type='mjs/marker' mjs-l-t='s-${wrapperLid}'></script><script type='mjs/marker' mjs-l-t='e-${wrapperLid}'></script>`
}

// ============================================================================
// compileAwait — classé "struct" (block structurel always-run).
// `_mjs_updAwait` est idempotent : skip si la promise est inchangée.
// ============================================================================
export function compileAwait(node: Node, ctx: Ctx): string {
  state.counter += 1
  const id = `await${state.counter}`

  // Collecter les vars de l'expression promise.
  if (node.expr) {
    for (const v of getEffectVars(node.expr)) state.structVars.add(v)
  }

  let tplPending = 'null'
  let tplSuccess = 'null'
  let tplError = 'null'

  const awaitCtx: Ctx = { ...ctx, type: 'await' }

  // noms introduits par les branches (`{then data}`, `{catch err}`) : ils vivent dans la
  // fonction de branche, JAMAIS dans le corps d'un handler inline — un homonyme du
  // `<script>` doit donc y rester local (cf. state.templateLocals)
  for (const branch of node.branches) if (branch.arg) state.templateLocals.add(branch.arg)

  for (const branch of node.branches) {
    // Les branches `{await}` peuvent contenir des blocs structurels ({for},
    // {if}, {key}) qui poussent des updates dans `ctx.updates` référençant des
    // markers locaux (`s-forN`/`e-forN` via `__nodes`). On capture ces updates
    // générées par le walk de CETTE branche et on les inline dans sa createFn,
    // exécutées juste après la construction du fragment (où le param `success`
    // est en scope et `__nodes` pointe les refs locales fraîches).
    const preBranch = ctx.updates.length
    const bodyRaw = branch.children.map((c) => walk(c, awaitCtx)).join('')
    const branchUpdatesRaw = ctx.updates.splice(
      preBranch,
      ctx.updates.length - preBranch
    )
    // cf. commentaire jumeau dans la branche non-root de
    // compileIf : un two-way `<select value=!{...}>` de CETTE branche doit
    // attendre les <option> d'un {for} imbriqué, comme `postUpdates` juste en dessous.
    const { updates: branchUpdates, deferred } = splitDeferredUpdates(branchUpdatesRaw)
    // Chaque branche émet une createFn qui produit {fragment, refs}.
    // Si la branche a des updates structurelles, on force le mode impératif :
    // le body se termine par `return { fragment: _f, refs: <obj> };`. On
    // transforme ce return final pour nommer l'objet `refs` (variable locale),
    // exécuter les updates de branche en mode `__nodes` local, puis retourner.
    // le fragment de CETTE branche ne voit jamais le `<svg>`/`<math>`
    // englobant (compilé séparément, cf. commentaire de Ctx.svgNs) : relayé
    // explicitement, sinon `document.createElement` reste posé en mode
    // impératif pour un `<circle>`/`<text>` réellement dans du SVG.
    const createBody = generateCreateFnBody(bodyRaw, {
      forceImperative: branchUpdatesRaw.length > 0,
      splitSelectPostUpdates: true,
      foreignNsRoot: ctx.svgNs ?? null,
      // cf. compileIf — forme compacte hors boucle seulement (sans effet en mode impératif,
      // qui n'a aucun chemin de nœud à écrire : il crée les éléments un par un).
      compactPaths: ctx.loops.length === 0,
    })
    // `postUpdates` (ex. `value` d'un `<select>` dont les
    // `<option>` viennent d'un `{for}` imbriqué) doivent courir APRÈS
    // `branchUpdates`, dans le MÊME bloc `__nodes` — jamais dans `head` (posées
    // là, trop tôt, avant que `branchUpdates` ne peuple les options réelles).
    const postUpdates = [...(createBody.postUpdates ?? []), ...deferred]
    let fnBody: string
    if (branchUpdates.length > 0 || postUpdates.length > 0) {
      const RET = 'return { fragment: _f, refs: '
      const retIdx = createBody.body.lastIndexOf(RET)
      if (retIdx === -1) {
        // Garde-fou : forme de return inattendue → fallback sans updates
        // (le {for} ne serait pas réactif, mais pas de crash de compilation).
        fnBody = createBody.body
      } else {
        const head = createBody.body.slice(0, retIdx)
        // Tout ce qui suit `RET` jusqu'au `};` final est l'objet refs.
        const refsObjAndEnd = createBody.body.slice(retIdx + RET.length)
        const endIdx = refsObjAndEnd.lastIndexOf('};')
        const refsObj = refsObjAndEnd.slice(0, endIdx).trim()
        const tail = [...branchUpdates, ...postUpdates].join(' ')
        fnBody =
          `${head} const refs = ${refsObj}; ` +
          `{ const __nodes = refs; ${tail} } ` +
          `return { fragment: _f, refs };`
      }
    } else {
      fnBody = createBody.body
    }
    switch (branch.type) {
      case 'pending':
        tplPending = `() => { ${fnBody} }`
        break
      case 'success':
        tplSuccess = `(${branch.arg ?? 'data'}) => { ${fnBody} }`
        break
      case 'error':
        tplError = `(${branch.arg ?? 'err'}) => { ${fnBody} }`
        break
    }
  }

  if (ctx.type === 'for') {
    // un {await} imbriqué dans un {for} compilait en un placeholder
    // `<span class='mjs-error'>…</span>` VISIBLE des utilisateurs finaux en
    // production, sans la moindre erreur de compilation. Comme
    // `{const}` hors `{for}` (compileConst, même fichier) : on REFUSE plutôt
    // que dégrader. L'asymétrie {if}/{for} est VOULUE : un {await} imbriqué
    // dans un {if} à la racine (ctx.type reste 'root') continue de fonctionner.
    // `nearestLine()` (retirée) cherchait la
    // ligne du PREMIER DESCENDANT muni de `.line` : un `{await}` sur sa propre
    // ligne, suivi d'un `{success}` sur une ligne ULTÉRIEURE, citait la ligne du
    // `{success}` (ou de tout texte intercalaire), jamais celle du mot-clé
    // `{await}` lui-même. Le parseur pose désormais `.line` DIRECTEMENT sur le
    // nœud `await` (parser/index.ts, parseFlow) — même geste que tag/expr.
    throw new Error(t('generator.await-imbrique-interdit', { ligne: node.line ?? '?' }))
  }

  if (ctx.type !== 'root') {
    // plus de BACKTICKS littéraux : ils faisaient
    // partie du texte injecté (re-échappé par escapeTpl) → le VISITEUR voyait
    // « `<span…>` » au lieu du message. Fallback rendu proprement (dégradation
    // gracieuse conservée ; un {await} imbriqué dans un AUTRE {await} reste non
    // supporté — pas de throw pour ne pas casser une dégradation existante).
    return `<span class='mjs-error'>[${t('generator.await-imbrique-non-supporte')}]</span>`
  }

  // Site EXPR (promesse {await EXPR}).
  const jsAwaitExpr = cleanJsExpr(node.expr, state.externalVars, state.templateLang, state.moduleName)
  ctx.updates.push(`this._mjs_updAwait('${id}', ${jsAwaitExpr}, ${tplPending}, ${tplSuccess}, ${tplError});`)
  return `<script type='mjs/marker' mjs-t='s-${id}'></script><script type='mjs/marker' mjs-t='e-${id}'></script>`
}

// ============================================================================
// compileKey — classé "struct" (block structurel always-run, idempotent
// via cache `_mjs_key_cache`).
// ============================================================================
export function compileKey(node: Node, ctx: Ctx): string {
  state.counter += 1
  const id = `k${state.counter}`
  const rawExpr = node.expr ?? ''

  // Collecter les vars de l'expression-clé.
  for (const v of getEffectVars(rawExpr.toString())) state.structVars.add(v)

  // Site EXPR (expression {key EXPR}).
  const cleanExpr = cleanJsExpr(rawExpr.toString(), state.externalVars, state.templateLang, state.moduleName)

  if (ctx.type !== 'root') {
    const preSize = ctx.updates.length
    const innerHtmlRaw = node.children.map((c) => walk(c, ctx)).join('')
    const branchUpdatesRaw = ctx.updates.splice(preSize, ctx.updates.length - preSize)
    // cf. commentaire jumeau dans la branche non-root de
    // compileIf : un two-way `<select value=!{...}>` de CETTE branche doit
    // attendre les <option> d'un {for} imbriqué, comme `postUpdates` juste en dessous.
    const { updates: branchUpdates, deferred } = splitDeferredUpdates(branchUpdatesRaw)

    // createFn(item, index) → {fragment, refs}.
    // `compactPaths` : cf. compileIf — forme compacte hors boucle seulement.
    const createBody = generateCreateFnBody(innerHtmlRaw, { splitSelectPostUpdates: true, compactPaths: ctx.loops.length === 0 })
    // `postUpdates` (ex. `value` d'un `<select>` peuplé par un
    // `{for}` imbriqué) rejouées APRÈS `branchUpdates`, même `__nodes` (mergé
    // par `_mjs_updItemIf` juste avant, comme pour `compileIf` non-root).
    const postUpdates = [...(createBody.postUpdates ?? []), ...deferred]
    const wrappedChildren = [...branchUpdates, ...postUpdates].map((u) => `{ ${u} }`).join(' ')

    // `_mjs_keyStart`/`_mjs_keyEnd`/`_mjs_keyVal` (avant : `startNode`/`endNode`/`v`
    // nus) : `cleanExpr` est le texte de `{key EXPR}` tel qu'écrit par l'utilisateur
    // (ex. `{for v in $rows}{key v.id}` → cleanExpr = "v.id"), embarqué dans CE
    // MÊME scope. Avec l'ancien nom `v` : `const v = v.id` — auto-référence en
    // TDZ, CRASH immédiat (« Cannot access 'v' before initialization ») dès que
    // l'item de boucle s'appelait `v`. Avec `startNode`/`endNode` comme nom
    // d'item (mot anglais plausible) : lecture SILENCIEUSE de l'ancre interne au
    // lieu de l'item (corruption sans erreur). Régression verrouillée par
    // tests/reserved-names-collision.test.ts.
    const keyUpdate = `{ const _mjs_keyStart = __nodes['s-${id}']; const _mjs_keyEnd = __nodes['e-${id}']; if (_mjs_keyStart && _mjs_keyEnd) { const _mjs_keyVal = ${cleanExpr}; if (_mjs_keyVal !== _mjs_keyStart._mjs_old_key) { _mjs_keyStart._mjs_old_key = _mjs_keyVal; this._mjs_updItemIf(_mjs_keyStart, _mjs_keyEnd, () => { ${createBody.body} }, __nodes); } ${wrappedChildren} } }`
    ctx.updates.push(keyUpdate)

    return `<script type='mjs/marker' mjs-l-t='s-${id}'></script><script type='mjs/marker' mjs-l-t='e-${id}'></script>`
  }

  const preSize = ctx.updates.length
  const innerHtmlRaw = node.children.map((c) => walk(c, ctx)).join('')
  // Idem au root : createFn() → {fragment, refs}.
  // `compactPaths` : cf. compileIf — forme compacte hors boucle seulement.
  const createBody = generateCreateFnBody(innerHtmlRaw, { splitSelectPostUpdates: true, compactPaths: ctx.loops.length === 0 })

  // Régression (fil d'Ariane du tuto) — MÊME mécanique que
  // `branchExecBlock` de `compileIf` ci-dessus, et que la branche non-root
  // juste au-dessus : les updates du CONTENU sont retirées de `ctx.updates`
  // et rejouées EN LIGNE, juste après `_mjs_updKey`. Sans ça, elles ne vivaient
  // qu'en effets par-variable — et un bloc reconstruit par une passe
  // structurelle REPORTÉE (garde `_mjs_struct_dispatched_in_tick` : la 2e écriture
  // du même tick reporte la passe en microtask, mais ses effets, eux, tournent
  // tout de suite) restait vide À VIE, plus aucune variable ne mutant derrière.
  // Les copies enregistrées par `registerEffect` pendant le walk, elles, sont
  // intactes : la réactivité ultérieure passe toujours par `_mjs_effectsByVar`.
  const childUpdates = ctx.updates.splice(preSize, ctx.updates.length - preSize)
  // cf. commentaire jumeau dans la branche non-root ci-dessus :
  // `postUpdates` rejouées APRÈS `childUpdates`, même `__nodes` (mergé par
  // `_mjs_updKey` juste avant).
  const postUpdates = createBody.postUpdates ?? []
  const wrappedChildren = [...childUpdates, ...postUpdates].map((u) => `{ ${u} }`).join(' ')

  // V2 — pas de condition. `_mjs_updKey` est idempotent via `_mjs_key_cache`.
  const keyUpdate = `this._mjs_updKey('${id}', ${cleanExpr}, () => { ${createBody.body} });${wrappedChildren ? ' ' + wrappedChildren : ''}`
  ctx.updates.splice(preSize, 0, keyUpdate)

  return `<script type='mjs/marker' mjs-t='s-${id}'></script><script type='mjs/marker' mjs-t='e-${id}'></script>`
}

// ============================================================================
// compileConst — `{const NOM = EXPR}` (≡ `{@const}` Svelte).
//
// Émet AUCUN nœud DOM (chaîne vide). Pousse à la place une « update » marquée
// `CONST_DECL_PREFIX` qui sera reconnue par `compileFor` : la déclaration est
// HISSÉE en tête du corps `updateFn` (avant les updates frères), SANS wrapper
// `{ … }` afin que `NOM` reste visible des interpolations qui le consomment
// (`{NOM}` plus loin dans le même `{for}`).
//
// Réactivité : les `$x` de l'EXPR sont ajoutés à `structVars`. Comme un `{for}`
// est structurel (re-joué par `_mjs_renderStruct` → `_mjs_reconcileList` rappelle
// `updateFn` par item), muter un `$x` de l'EXPR re-calcule `NOM` et re-applique
// les interpolations qui en dépendent. Sans loop parent, l'effet ne serait pas
// recalculé hors mount (voir restriction ci-dessous).
// ============================================================================
export function compileConst(node: Node, ctx: Ctx): string {
  const name = (node.name ?? '').toString().trim()
  // même raison que pour `{for}` et `{await}` : le `{const}` est hissé en tête du CORPS DE
  // BOUCLE du template, jamais dans un handler inline — un homonyme du `<script>` doit y
  // rester local, sous peine d'écrire dans la variable du script en croyant toucher celle-ci
  if (name) state.templateLocals.add(name)
  const rawExpr = (node.expr ?? '').toString()
  // Site EXPR (expression {const NOM = EXPR}).
  const jsExpr = cleanJsExpr(rawExpr, state.externalVars, state.templateLang, state.moduleName)

  // Les vars de l'EXPR pilotent un recalcul → structurel (re-joue le `{for}`).
  for (const v of getEffectVars(rawExpr)) state.structVars.add(v)

  if (ctx.loops.length > 0 || ctx.type === 'await') {
    // Dans un `{for}` (ou une branche `{await}` : corps construit puis updates
    // inlinées en mode `__nodes` local) → déclaration hissée en tête de corps.
    ctx.updates.push(`${CONST_DECL_PREFIX}const ${name} = ${jsExpr};`)
    return ''
  }

  // LIMITATION V1 (volontaire) — `{const}` au NIVEAU RACINE (hors `{for}` /
  // `{await}`) n'est PAS supporté. Au root, chaque update est un statement
  // INDÉPENDANT (enregistré dans `_mjs_effectsByVar` / `mountOnly`, sans scope
  // partagé) : un `const NOM` déclaré dans un effect serait invisible de
  // l'effect frère qui lit `{NOM}` → ReferenceError silencieuse. On rejette
  // explicitement avec une alternative idiomatique plutôt que d'émettre du
  // code cassé.
  throw new Error(t('generator.const-hors-for', { nom: name, expr: rawExpr }))
}

// ============================================================================
// compile : entrypoint
// ============================================================================
export interface CompileOpts {
  analyzer?: any
  externalVars?: string[]
  /** Grammaire des handlers inline émis (`@click={…}`) — 'civet' (défaut) ou
   * 'js' (repli historique Coffee). Cf. CompilerState.templateLang. */
  templateLang?: 'civet' | 'js'
  /** Best-effort, cf. ResetOpts.moduleName (state.ts) — enrichit les erreurs. */
  moduleName?: string
}

export type CompileResult = [
  surgicalHtml: string,
  updates: string[],
  events: Record<string, Record<string, EventRoute>>,
  inlines: string[],
  effectsByVar: Map<string, string[]>,
  /** Vars qui pilotent les blocs structurels. Émise comme tableau
   * dans le template ; runtime skip `_mjs_renderStruct` si la var muée n'est
   * pas dedans. Si vide → `_mjs_renderStruct` toujours skipé (sauf mount). */
  structVars: Set<string>,
  mountOnlyEffects: string[],
  /** Types d'événements à enregistrer en listener `passive` (touch/wheel sans
   * preventDefault) — scroll fluide sans bloquer le thread principal. */
  passiveEvents: string[],
  /** références `<@nom>`/`<mjs-nom>`/`<mjs-core-nom>` (notation
   * unique, `<@mjs-nom>` est une erreur de migration) collectées par le
   * parseur (resolveTagName) ; résolues APRÈS le manifeste complet par le
   * bundler (post-passe, jamais ici — un seul fichier ne connaît pas les
   * autres). */
  tagRefs: TagRef[],
  /** Noms que le template introduit lui-même — variable et index de chaque `{for}`,
   * nom d'un `{const}`, argument d'un `{then}`/`{catch}` — cf. CompilerState.templateLocals. */
  templateLocals: Set<string>,
  /** liaisons two-way vers un composant enfant, root uniquement :
   * même code que leur effect jumeau (dans `updates`/`effectsByVar`), mais
   * rejoué SYNCHRONEMENT dans `init()`, avant tout connectedCallback (cf.
   * state.initialPropBinds). */
  initialPropBinds: string[],
  /** Dépendances DIRECTES de balises (noms SANS préfixe `mjs-`, triés par point
   * de code) — cf. collectDirectComponentDeps ci-dessus. Alimente la table de
   * préchargement du manifeste (writeManifest, bundler/index.ts) ; ne résout
   * PAS les noms contre le manifeste (un nom qui ne compile jamais reste ici,
   * filtré côté bundler, seul point qui connaît tous les composants). */
  componentDeps: string[],
]

// avertissement compile-time (jamais bloquant) : `#{…}` (interpolation
// Civet, réservée au <script>) collée dans un attribut STATIQUE ne s'exécute
// pas, la valeur reste littérale à l'écran — piège fréquent et jusqu'ici
// silencieux. Ciblé sur `type === 'static'` uniquement : jamais les nœuds
// texte (une page de doc y montre légitimement du code Civet), jamais les
// valeurs déjà dynamiques `{…}` (type 'dynamic', aucun risque de confusion).
// Parcours dédié — PAS le `walk()` de codegen (appelé 2× en pre-pass/real-pass,
// un hook là-dedans doublerait l'avertissement) : un seul passage sur l'AST
// brut, juste après le parse.
function warnCivetInterpolationInAttrs(node: Node, moduleName: string | undefined): void {
  for (const attr of node.attrs) {
    if (attr.type === 'static' && attr.val && attr.val.includes('#{')) {
      const valeur = attr.val.length > 60 ? attr.val.slice(0, 60) +'…' : attr.val
      console.warn(t('generator.interpolation-civet-attribut', { module: moduleName ?? '', attr: attr.name ?? '', valeur }))
    }
  }
  for (const child of node.children) warnCivetInterpolationInAttrs(child, moduleName)
  for (const branch of node.branches) {
    for (const child of branch.children) warnCivetInterpolationInAttrs(child, moduleName)
  }
}

// collectDirectComponentDeps — parcourt l'AST déjà parsé (post raccourcis <@nom>,
// post <@include>, post macros <@element>/<@module> — ast est celui RÉELLEMENT
// compilé) et liste les noms de composants référencés LITTÉRALEMENT (balises
// mjs-x, `x` sans le préfixe) — hors <pre>/<code> (exemples de code affichés
// comme texte, jamais de vraies dépendances). Les commentaires HTML n'entrent
// jamais dans l'AST (parseComment, parser/index.ts) : rien à exclure ici pour
// eux. `<@element>`/`<@module>` restent des noms réservés (AT_RESERVED_NAMES) —
// resolveTagName ne pousse jamais `mjs-element`/`mjs-module`, donc leur cible
// dynamique n'apparaît jamais dans cette liste. `mjs-core-x` (balise littérale
// interdite, cf. resolveTagShortcuts) exclue aussi : jamais une dépendance valide.
// Consommée par le bundler pour la table de préchargement (writeManifest) —
// jamais pour la RÉSOLUTION elle-même (resolveTagShortcuts reste seul juge de
// ce qui compile).
function collectDirectComponentDeps(node: Node, insideRawBlock: boolean, out: Set<string>): void {
  const nameLower = node.type === 'tag' ? (node.name ?? '').toLowerCase() : ''
  if (node.type === 'tag' && !insideRawBlock && nameLower.startsWith('mjs-') && !nameLower.startsWith('mjs-core-')) {
    out.add((node.name as string).slice('mjs-'.length))
  }
  const childInsideRawBlock = insideRawBlock || nameLower === 'pre' || nameLower === 'code'
  for (const child of node.children) collectDirectComponentDeps(child, childInsideRawBlock, out)
  for (const branch of node.branches) {
    for (const child of branch.children) collectDirectComponentDeps(child, childInsideRawBlock, out)
  }
}

// avertissement compile-time (jamais bloquant) :
// `µemit 'nom', e` dans un handler INLINE (`@click={…}`) relaie l'ÉVÉNEMENT DOM
// reçu tel quel plutôt que sa charge (`e.data`) — le parent lit `e.data` sur le
// CustomEvent émis et trouve `undefined`, aucune erreur nulle part. Ciblé aux
// handlers INLINE seulement : le générateur SYNTHÉTISE lui-même leur signature
// `(e, el) => {…}` (state.inlines.push, attributes/index.ts) — le nom `e` du
// 1er paramètre y est donc FIABLE À 100 %, contrairement à une méthode
// `<script>` nommée par le dev (nom de paramètre libre, hors périmètre).
//
// Scan textuel DÉDIÉ sur `state.inlines` (assemblé une seule fois pour le real
// pass — reset juste avant, cf. le commentaire sur le reset d'inlines plus haut) : PAS le
// walk() de codegen (double pre-pass/real-pass, un hook là-dedans doublerait
// l'avertissement), même famille de garde que warnCivetInterpolationInAttrs.
const RAW_EMIT_RE = /µ\.?\s*emit\s*\(?\s*([^,()\n]*),\s*e\s*(?=[),\n;]|$)/g

function warnRawEventEmit(inlines: string[], moduleName: string | undefined): void {
  for (const body of inlines) {
    RAW_EMIT_RE.lastIndex = 0
    const m = RAW_EMIT_RE.exec(body)
    if (!m) continue
    const nomEvenement = m[1].trim().replace(/^['"]|['"]$/g, '')
    console.warn(t('generator.emit-evenement-brut', { module: moduleName ?? '', nomEvenement }))
  }
}

export function compile(htmlRaw: string, opts: CompileOpts = {}): CompileResult {
  reset({
    analyzer: opts.analyzer,
    externalVars: opts.externalVars ?? [],
    templateLang: opts.templateLang,
    moduleName: opts.moduleName,
  })

  const preprocessed = preprocess(htmlRaw)
  const tagRefs: TagRef[] = []
  const ast = parse(preprocessed, tagRefs)
  warnCivetInterpolationInAttrs(ast, opts.moduleName)

  // dépendances directes de balises — comparaison par point de code (jamais
  // localeCompare, cf. writeManifest) pour que deux builds du même code
  // produisent le même tableau.
  const componentDepsSet = new Set<string>()
  collectDirectComponentDeps(ast, false, componentDepsSet)
  const componentDeps = Array.from(componentDepsSet).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)

  // Pre-pass : collecte les snippets pour batchCalculateVars
  state.isPrePass = true
  state.snippetRegistry = []
  walk(ast, { type: 'root', updates: [], loops: [] })

  if (state.analyzer && state.snippetRegistry.length > 0) {
    state.analyzer.batchCalculateVars?.(state.snippetRegistry)
  }

  state.isPrePass = false
  state.counter = 0
  // Le pre-pass a populé `transitionsProcessed` avec les IDs générés à ce
  // moment. Comme `counter` est reset, les mêmes IDs vont être régénérés
  // par le real pass — sans ce reset, bindingTransition voit l'ID dans le
  // Set et skip le setup (=> pas de `node._mjs_intro` => fade ne joue pas).
  state.transitionsProcessed = new Set()
  // Reset également effectsByVar : la pre-pass aurait pu y pousser des entrées
  // qu'on ne doit pas garder pour le real pass.
  state.effectsByVar = new Map()
  // Reset des structVars pour le real pass.
  state.structVars = new Set()
  // idem : la pre-pass a déjà walké les `{for}`, le real pass les revisite
  state.templateLocals = new Set()
  // Reset mountOnlyEffects : pendant le pre-pass, `getEffectVars` retourne
  // toujours `[]` (uniquement pour peupler `snippetRegistry`), donc tous les
  // effects sont à tort classés `mountOnly`. Sans ce reset, ils tireraient
  // 2× au mount initial (1× via mountOnly, 1× via fullRender + dispatch).
  state.mountOnlyEffects = []
  state.mountOnlyEffectsSet = new Set()  // miroir de dédup
  // même motif : la pre-pass a pu pousser des liaisons two-way vers
  // un enfant, à ne pas garder pour le real pass (sinon doublon en sortie).
  state.initialPropBinds = []

  // `inlines`/`events`/`eventsWithPrevent`
  // N'étaient PAS reset au basculement real pass : la pre-pass (walk complet) avait
  // déjà poussé chaque handler → tous émis EN DOUBLE (entrées mortes en tête de
  // `_mjs_inline`, ×2 code inline dans le bundle, ×2 compilation Coffee, ×2 closures
  // par instance à chaque init). Le real pass régénère tout avec des ids
  // déterministes (counter reset) ; `keepRefs`/`evtIdsInFor` lisent `state.events`
  // APRÈS le walk du corps → l'ordre est sûr.
  state.inlines = []
  state.events = {}
  state.eventBindCount = {}
  state.eventsWithPrevent = new Set()

  const ctx: Ctx = { type: 'root', updates: [], loops: [] }
  const surgicalHtml = walk(ast, ctx)

  // dédupe des updates
  const seen = new Set<string>()
  const uniqueUpdates: string[] = []
  for (const u of ctx.updates) {
    if (!seen.has(u)) {
      seen.add(u)
      uniqueUpdates.push(u)
    }
  }

  // Auto-passive : touchstart/touchmove/wheel présents et SANS preventDefault
  // → listener délégué enregistré `passive` (scroll fluide). Dès qu'un handler
  // de ce type fait preventDefault, le type est exclu (reste non-passif).
  const passiveEvents = ['touchstart', 'touchmove', 'wheel'].filter(
    e => state.events[e] && !state.eventsWithPrevent.has(e),
  )

  // avertissement « relais événement brut » (µemit 'x', e), après
  // le real pass, sur les inlines FINALES (cf. warnRawEventEmit plus haut).
  warnRawEventEmit(state.inlines, opts.moduleName)

  return [surgicalHtml, uniqueUpdates, state.events, state.inlines, state.effectsByVar, state.structVars, state.mountOnlyEffects, passiveEvents, tagRefs, state.templateLocals, state.initialPropBinds, componentDeps]
}
