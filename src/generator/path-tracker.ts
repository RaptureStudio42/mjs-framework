// path-tracker — suit les alias de `$.X` dans le scope et
// transforme les mutations profondes en `µ._mjs_deepSet(_mjsThis, path, val)`
// au lieu de passer par un Proxy runtime.
//
// Statisation $$ — même suivi pour les chemins profonds du store universel
// (`$$obj.a.b` → `µ.store.obj.a.b`, racine reconnue par `isStoreRootMember`) :
// `µ._mjs_storeDeepSet(rootKey, path, val)` / `µ._mjs_storeDeepCall(rootKey, path,
// method, args)` / `µ._mjs_storeDeepDelete(rootKey, path)`. Le TOP-LEVEL store
// (`$$x = v`/`$$x += v`/`$$x++`) passe AUSSI par une réécriture
// (`µ._storeSet(key, val)`) — l'accesseur natif `µ.store.x` seul ne
// suffit plus : `_mjs_storeDelete` peut le remplacer par une propriété PLATE
// (voir mjs_store_globals.ts), auquel cas une écriture directe ne notifie
// plus rien. Seul le TOP-LEVEL 'local' (`$.x = v`) reste sans réécriture ici
// (transformReactiveWrites + filet Proxy `_mjs_wrapDeep` s'en chargent déjà).
//
// Pour les escapes (function call, push, throw, yield, alias non trackable),
// le compilateur injecte automatiquement un wrap `µ._mjs_makeDeepProxy(_mjsThis, path)`
// pour que la réactivité reste préservée à travers la frontière non trackée.
//
// Innovation algorithmique : zéro Proxy sur ~95% du code, Proxy ciblé sur les
// 5% restants. Vue/Svelte font Proxy partout (lent), Solid abandonne la
// rétrocompat (DX dégradée).
//
// la détection de `µproxy $.X` (escape hatch
// manuel → wrap inconditionnel) ne vit PAS ici mais dans transpiler/index.ts
// (~873-886), en AMONT de cette passe. Commentaire corrigé pour ne pas égarer
// le lecteur (l'ancienne formulation « Détecte aussi µproxy » laissait croire
// que le sucre était traité dans ce fichier).
//
// SÛRETÉ : le suivi est volontairement CONSERVATEUR. Un nom
// est « taint » (jamais traité comme alias) s'il est : paramètre d'une
// fonction/arrow/catch, cible d'une réassignation nue (`t = {}`) ou par
// motif (`[t] = […]`, `({t} = o)`), binding de for-of/for-in, ou déclaré
// plus d'une fois. Avant, `function f(box){box.x=1}` avec un alias externe
// `box` émettait `µ._mjs_deepSet(_mjsThis, ['box','x'], 1)` → corruption du
// state ET l'objet visé jamais muté. Perdre le tracking d'un alias
// réassigné (rare, motif compris) est préférable à corrompre l'état.

import * as acorn from 'acorn'
import * as walk from 'acorn-walk'
import MagicString from 'magic-string'
import { passResult, type PassResult } from './pass-map.js'

/** Segment dynamique (`$.x[k]` → valeur runtime de `k`). Marqueur OBJET :
 *  l'ancien préfixe string `__dyn:` était forgeable par une clé littérale
 *  `$.x["__dyn:alert(1)"]` → code émis brut dans le path. */
type DynSegment = { dyn: string }
type Path = (string | number | DynSegment)[]

/** Statisation $$ — `origin` distingue une racine `$.x` ('local', state du
 * composant, `_mjsThis`) d'une racine `µ.store.x` ('store', global) : les
 * DEUX empruntent le MÊME suivi de chemin (getPath/aliasMap), seule la
 * fonction runtime émise diffère (`µ._mjs_deepSet`/`_mjs_deepCall`/`_mjs_deepDelete` vs
 * `µ._mjs_storeDeepSet`/`_mjs_storeDeepCall`/`_mjs_storeDeepDelete`, ce dernier trio
 * séparant en plus `path[0]` = clé racine du store des segments suivants). */
type PathOrigin = 'local' | 'store'

interface AliasEntry {
  /** Path par lequel cet alias pointe vers le state. ['box', 'width'] etc.
   * Pour origin='store', path[0] EST la clé racine du store (ex. `$$box` →
   * ['box'], `$$box.width` → ['box', 'width']). */
  path: Path
  origin: PathOrigin
}

// STATISATION — opérateurs composés (`+=` etc.) sur un chemin profond du
// store (`$$obj.a += v`, depth >= 2). BUG D'INTÉGRATION trouvé à la
// vérification : contrairement au state LOCAL (le filet Proxy `_mjs_wrapDeep`
// intercepte la mutation en place même sans réécriture compile-time ici, cf.
// runtime mjs_element.ts), le store statisé n'a AUCUN filet — `µ.store.obj`
// renvoie l'objet BRUT (`µ._mjs_storeRaw`), donc `µ.store.obj.a += 1` généré tel
// quel mutait en silence, zéro notification (prouvé : DOM figé alors que la
// valeur brute progressait). On expand donc CETTE origine en lecture+set
// explicite ; 'local' reste skip (le filet existant suffit, pas de régression
// à introduire dans un mécanisme qui marche déjà).
const COMPOUND_OPS = new Set([
  '+=', '-=', '*=', '/=', '%=', '**=',
  '&=', '|=', '^=', '<<=', '>>=', '>>>=',
  '&&=', '||=', '??=',
])

// Méthodes mutatives connues par type d'objet — nécessaires pour propager
// l'invalidation au runtime quand on appelle .push(), .splice(), etc.
const MUTATIVE_METHODS: Record<string, Set<string>> = {
  Array: new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']),
  Map: new Set(['set', 'delete', 'clear']),
  Set: new Set(['add', 'delete', 'clear']),
}

// Toutes les méthodes mutatives confondues (pour détection conservatrice)
const ALL_MUTATIVE = new Set([
  ...MUTATIVE_METHODS.Array,
  ...MUTATIVE_METHODS.Map,
  ...MUTATIVE_METHODS.Set,
])

// Méthodes qui retournent un NOUVEAU tableau/objet distinct de la source.
// Important : `const arr = $.data.slice()` ne doit PAS créer d'alias sur
// `$.data`, sinon `arr[0] = 5` muterait le state au lieu de la copie locale.
// Idem pour Object.assign({}, $.foo) etc. — mais on traite ici uniquement
// les MemberExpression du style `<alias>.method()`.
const NON_ALIAS_METHODS = new Set([
  // Array immutables (clones / vues nouvelles)
  'slice', 'concat', 'filter', 'map', 'flat', 'flatMap',
  'toReversed', 'toSorted', 'toSpliced', 'with',
  'entries', 'keys', 'values', 'from', 'of',
  // Array → primitives (jamais des alias)
  'join', 'indexOf', 'lastIndexOf', 'includes', 'find', 'findIndex',
  'findLast', 'findLastIndex', 'some', 'every', 'reduce', 'reduceRight', 'at',
  // String (cas rare où $.s.split(...) etc. — pareil)
  'split', 'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll',
  'toLowerCase', 'toUpperCase', 'substring', 'substr', 'padStart', 'padEnd', 'repeat',
  // Object/JSON
  'stringify', 'parse',
])


/**
 * Transforme le code JS pour utiliser le path-tracking et insérer des wraps
 * Proxy automatiquement aux points d'escape détectés.
 *
 * Doit être appelé APRÈS transformReactiveWrites (qui gère les `$.x = y`
 * top-level) pour ne traiter que les mutations profondes.
 */
export function applyPathTracking(js: string): string {
  return applyPathTrackingMapped(js).code
}

// Variante qui rend AUSSI la carte de source de cette passe — cf. pass-map.ts.
export function applyPathTrackingMapped(js: string): PassResult {
  // Statisation $$ — `µ.store.` déclenche aussi le tracking (`$$obj.a.b`
  // compile déjà en `µ.store.obj.a.b` à ce stade, cf. lexer/generator/utils).
  if (!js || (!js.includes('$.') && !js.includes('µ.store.'))) return { code: js }

  let ast: acorn.Node
  try {
    ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch {
    return { code: js }
  }

  const ms = new MagicString(js)
  let changed = false

  // ── Passe 1 : noms « taint » (jamais aliasables — voir l'en-tête). ────────
  const tainted = new Set<string>()
  const declaredOnce = new Set<string>()
  const collectPatternNames = (pat: any) => {
    if (!pat) return
    switch (pat.type) {
      case 'Identifier': tainted.add(pat.name); break
      case 'ObjectPattern': for (const p of pat.properties ?? []) collectPatternNames(p.value ?? p.argument); break
      case 'ArrayPattern': for (const el of pat.elements ?? []) collectPatternNames(el); break
      case 'AssignmentPattern': collectPatternNames(pat.left); break
      case 'RestElement': collectPatternNames(pat.argument); break
    }
  }
  walk.full(ast, (node: any) => {
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        for (const p of node.params ?? []) collectPatternNames(p)
        break
      case 'CatchClause':
        collectPatternNames(node.param)
        break
      case 'ForOfStatement':
      case 'ForInStatement': {
        const left = node.left
        if (left?.type === 'VariableDeclaration') {
          for (const d of left.declarations ?? []) collectPatternNames(d.id)
        } else {
          collectPatternNames(left)
        }
        break
      }
      case 'AssignmentExpression':
        // réassignation nue (`t = {}`) OU par motif (`[t] = […]`, `({t} = o)`) : l'alias ne pointe plus le state —
        // collectPatternNames ignore un membre (`[$.a] = …`), seuls les identifiants liés sont taintés
        if (node.left?.type === 'Identifier') tainted.add(node.left.name)
        else collectPatternNames(node.left)
        break
      case 'UpdateExpression':
        if (node.argument?.type === 'Identifier') tainted.add(node.argument.name)
        break
      case 'VariableDeclarator':
        if (node.id?.type === 'Identifier') {
          // Déclaré 2× (scopes différents) : ambigu → taint.
          if (declaredOnce.has(node.id.name)) tainted.add(node.id.name)
          else declaredOnce.add(node.id.name)
        } else {
          // Déstructuration : les noms liés ne sont pas des alias suivables —
          // et `const {items} = $.data` suivi de `items.push(x)` muterait le
          // state SANS notification si on les laissait passer pour des vars
          // libres. On les taint (le Proxy _mjs_wrapDeep reste le filet).
          collectPatternNames(node.id)
        }
        break
    }
  })

  // ── Passe 2 : aliasing + réécritures. ──────────────────────────────────────
  // Map var name → AliasEntry (les noms taintés n'y entrent jamais).
  const aliasMap = new Map<string, AliasEntry>()

  // `µ.store.x` (racine store global, statisation $$) — même schéma que `$.x`.
  function isStoreRootMember(node: any): boolean {
    return !!node && node.type === 'MemberExpression' && !node.computed &&
      node.object?.type === 'Identifier' && node.object.name === 'µ' &&
      node.property?.type === 'Identifier' && node.property.name === 'store'
  }

  // Helper : analyse un node `expr` et retourne son path s'il est trackable.
  function getPath(expr: any): AliasEntry | null {
    if (!expr) return null
    // `$.x` → ['x'] (origin='local')
    if (expr.type === 'MemberExpression') {
      const tail = expr.computed ? null : expr.property?.name
      const tailComputed = expr.computed ? extractComputedKey(expr.property) : null
      const head = expr.object
      if (head?.type === 'Identifier' && head.name === '$') {
        if (tail) return { path: [tail], origin: 'local' }
        if (tailComputed !== null) return { path: [tailComputed], origin: 'local' }
        return null
      }
      // `µ.store.x` → ['x'] (origin='store'). Clé racine DYNAMIQUE
      // (`µ.store[expr]`) non trackée (conservateur, même limite que `$[cle]`).
      if (isStoreRootMember(head)) {
        if (tail) return { path: [tail], origin: 'store' }
        return null
      }
      // Récursif : `$.x.y`, `µ.store.x.y`, `$.x[i]`, etc.
      const headPath = getPath(head)
      if (headPath) {
        if (tail) return { path: [...headPath.path, tail], origin: headPath.origin }
        if (tailComputed !== null) return { path: [...headPath.path, tailComputed], origin: headPath.origin }
      }
    }
    // Identifier référençant un alias connu (et non shadowé/réassigné)
    if (expr.type === 'Identifier' && !tainted.has(expr.name)) {
      const e = aliasMap.get(expr.name)
      if (e) return { path: [...e.path], origin: e.origin }
    }
    return null
  }

  function extractComputedKey(node: any): string | number | DynSegment | null {
    if (!node) return null
    if (node.type === 'Literal') return node.value as string | number
    // Identifier dynamique : on garde le nom de var, le code généré
    // utilisera la valeur runtime via interpolation
    if (node.type === 'Identifier') return { dyn: node.name }
    return null
  }

  // Sérialise un Path en code JS : `['box', 'width']` ou `['list', i]` (dyn)
  function pathToJsLiteral(path: Path): string {
    const parts = path.map(p => {
      if (typeof p === 'number') return String(p)
      if (typeof p === 'object' && p !== null) return p.dyn
      return JSON.stringify(p)
    })
    return `[${parts.join(', ')}]`
  }

  // Statisation $$ — motif de déstructuration :
  // collecte récursive des cibles MemberExpression du STORE (`getPath(...)` →
  // origin 'store') dans un ArrayPattern/ObjectPattern, JAMAIS le RHS d'un
  // AssignmentPattern (une valeur par défaut est une LECTURE, pas une cible
  // d'écriture). Miroir de `collectStateTargets` (transform-reactive.ts), en
  // plus général : celle-ci ne sait matcher QUE `$.x` (depth 1, comparaison de
  // nom en dur) ; ici on délègue à `getPath` (déjà capable de la profondeur
  // ET des deux origines) et on RETIENT seulement 'store' — les cibles
  // 'local' ($.x profondeur 1, déjà réécrites par transformReactiveWrites qui
  // tourne AVANT ; $.o.k profondeur ≥ 2, couvert par le filet Proxy
  // _mjs_wrapDeep) sont laissées telles quelles, elles n'ont besoin de rien ici.
  function collectStoreTargets(pattern: any, out: { node: any, path: Path }[]): void {
    if (!pattern) return // trou d'ArrayPattern ([a, , b]) ou branche absente

    switch (pattern.type) {
      case 'ArrayPattern':
        for (const el of pattern.elements) collectStoreTargets(el, out)
        return

      case 'ObjectPattern':
        for (const prop of pattern.properties) {
          collectStoreTargets(prop.type === 'RestElement' ? prop.argument : prop.value, out)
        }
        return

      case 'AssignmentPattern': // `µ.store.x = defaut` : cible = left, JAMAIS right (une lecture)
        collectStoreTargets(pattern.left, out)
        return

      case 'RestElement':
        collectStoreTargets(pattern.argument, out)
        return

      case 'MemberExpression': {
        const tp = getPath(pattern)
        if (tp && tp.origin === 'store') out.push({ node: pattern, path: tp.path })
        return
      }
    }
  }

  // Vérifie si `init` est un appel à une méthode non-alias sur un alias/state.
  // Ex: `$.data.slice()`, `arr.map(...)`, `$.list.filter(...)`. Dans ces cas,
  // le résultat est une COPIE indépendante : ne pas le marquer comme alias.
  function isNonAliasCall(init: any): boolean {
    if (!init || init.type !== 'CallExpression') return false
    const callee = init.callee
    if (!callee || callee.type !== 'MemberExpression') return false
    if (callee.computed) return false
    const methodName = callee.property?.name
    if (!methodName) return false
    return NON_ALIAS_METHODS.has(methodName)
  }

  // BUG V0.1.1 — ferme l'appel émis en
  // tenant compte d'éventuelles parenthèses redondantes autour du RHS ENTIER
  // (`$$x = ((...) + 1)`) : acorn ne les inclut PAS dans `node.right` (son
  // .start/.end collent au contenu réel, parens invisibles) mais les CONSOMME
  // quand même dans `node.end` (dernier token avalé par l'AssignmentExpression) —
  // l'écart [right.end, node.end) contient alors la ou les parenthèses
  // fermantes du wrapping, jamais réécrites. Un simple `appendLeft(node.end,
  // ')')` les laissait intactes en sortie ET EN RAJOUTAIT une par-dessus :
  // `µ._mjs_storeDeepSet(…, (…) + 1))` — parenthèse orpheline, ESM invalide.
  // On écrase cet écart plutôt que de l'ignorer : absorbe n'importe quelle
  // profondeur de parenthésage redondant en une seule fermeture correcte ;
  // écart vide (cas normal, sans parenthèse superflue) → comportement
  // inchangé (appendLeft, MagicString refuse un overwrite de plage nulle).
  function closeRhs(rightEnd: number, assignEnd: number, closer: string) {
    if (assignEnd > rightEnd) ms.overwrite(rightEnd, assignEnd, closer)
    else ms.appendLeft(assignEnd, closer)
  }

  walk.ancestor(ast, {
    // Track les déclarations `let/const/var X = $.path` ou `X = aliasY`
    VariableDeclarator(node: any) {
      if (node.id?.type !== 'Identifier' || !node.init) return
      if (tainted.has(node.id.name)) return
      // Fix faux alias : `const arr = $.data.slice()` doit créer une copie
      // locale et NON un alias sur $.data — sinon `arr[0] = 5` muterait
      // le state au lieu de la copie.
      if (isNonAliasCall(node.init)) return
      const tp = getPath(node.init)
      // un path avec un
      // segment DYNAMIQUE (`{dyn:'i'}`, ex. `it = $.list[i]`) ne doit JAMAIS
      // être aliasé : `pathToJsLiteral` réinjecte l'IDENTIFIANT NU `i` dans le
      // code généré, réévalué au moment de CHAQUE usage futur de l'alias — pas
      // au moment de la capture. `it = $.list[i]; i++; it.x = 1` mutait alors
      // `list[i_APRÈS incrément]` au lieu de l'élément réellement capturé —
      // corruption silencieuse du MAUVAIS élément. Sans alias tracké, `it`
      // reste la valeur BRUTE de `$.list[i]` — déjà un Proxy vivant posé par
      // `_mjs_wrapDeep` (mjs_element.ts, get trap récursif) dont l'IDENTITÉ est
      // figée à la lecture ; `it.x = 1` mute alors ce Proxy directement (bon
      // élément, notification correcte) — le filet Proxy documenté en tête de
      // fichier. Un chemin direct non aliasé (`$.list[i].x = 1`, sans variable
      // intermédiaire) N'A PAS ce problème : `i` y est déjà lu au bon endroit
      // (même statement, aucun décalage temporel) — seul le PASSAGE PAR ALIAS
      // introduit le décalage, donc seul l'aliasing est désactivé ici.
      if (tp && !tp.path.some(p => typeof p === 'object' && p !== null)) {
        aliasMap.set(node.id.name, tp)
      }
    },

    // Mutation directe sur alias : `obj.x = y` → `µ._mjs_deepSet(_mjsThis, [...alias, 'x'], y)`
    // Statisation $$ : racine store → `µ._mjs_storeDeepSet(rootKey, [...tail], y)`.
    AssignmentExpression(node: any, _st: any, ancestors: any[]) {
      const isCompound = COMPOUND_OPS.has(node.operator)
      if (node.operator !== '=' && !isCompound) return
      const target = node.left

      // Statisation $$ — motif de déstructuration (ArrayPattern/ObjectPattern)
      // CIBLANT LE STORE : `[$$a, $$b]
      // = [$$b, $$a]` (compilé `[µ.store.a, µ.store.b] = [µ.store.b,
      // µ.store.a]`) échappait à la garde MemberExpression ci-dessous — la
      // mutation passait par l'accesseur natif À NU, aucun `µ._storeSet`,
      // aucune notification si l'accesseur avait disparu. Panne réelle :
      // `delete $$a` PUIS, dans le MÊME handler, `[$$a, $$b] =
      // [$$b, $$a]` — l'accesseur de `a` vient d'être supprimé par le delete
      // qui précède, la lecture RHS `µ.store.a` rend `undefined` (propriété
      // absente), ce `undefined` s'écrit dans `b` (notifié via l'accesseur
      // natif de `b`, encore vivant : `b` perd sa valeur en silence) et `a`
      // redevient une propriété PLATE, écrite hors accesseur — plus jamais
      // notifiée (le trou visé par le CORRECTIF ci-dessus revient par
      // cette porte). Même patron que le motif LOCAL de transform-reactive.ts
      // (collectStateTargets, IIFE `_mjsD*`/`_mjsR`) — nommage `_mjsS*`/`_mjsSR`
      // DIFFÉRENT ici pour ne jamais collisionner sur un motif MIXTE (`[$.a,
      // $$b] = …`, réécrit par les DEUX passes, l'une dans l'autre :
      // transformReactiveWrites tourne AVANT, applyPathTracking réécrit ensuite
      // l'IIFE qu'elle a laissée). Les cibles 'local' du motif ($.x, déjà
      // réécrites par transformReactiveWrites ; $.o.k profond, couvert par le
      // filet Proxy _mjs_wrapDeep) sont laissées telles quelles — seul le store,
      // sans AUCUN filet, a besoin de cette réécriture.
      if (node.operator === '=' && (target.type === 'ArrayPattern' || target.type === 'ObjectPattern')) {
        const storeTargets: { node: any, path: Path }[] = []
        collectStoreTargets(target, storeTargets)
        if (storeTargets.length === 0) return // motif sans cible store, intouché (local géré ailleurs)

        for (let i = 0; i < storeTargets.length; i++) ms.overwrite(storeTargets[i].node.start, storeTargets[i].node.end, `_mjsS${i}`)

        const parent    = ancestors[ancestors.length - 2]
        const statement = !!parent && parent.type === 'ExpressionStatement'
        const decls     = storeTargets.map((_t, i) => `_mjsS${i}`).join(', ')
        const sets      = storeTargets.map((t, i) => t.path.length === 1
          ? `µ._storeSet(${JSON.stringify(t.path[0])}, _mjsS${i})`
          : `µ._mjs_storeDeepSet(${JSON.stringify(t.path[0])}, ${pathToJsLiteral(t.path.slice(1))}, _mjsS${i})`
        ).join('; ')

        // ASI (même garde que le motif LOCAL, transform-reactive.ts) — la
        // forme commence par `(` : en position STATEMENT, `void` coupe l'ASI
        // (mot-clé, pas une parenthèse). Les parenthèses autour du motif dans
        // le corps sont obligatoires : `{a: _mjsS0} = _mjsSR` nu en tête
        // d'instruction serait lu comme un BLOC.
        ms.prependLeft(node.start, `${statement ? 'void ' : ''}((_mjsSR) => { let ${decls}; (`)
        ms.overwrite(target.end, node.right.start, ` = _mjsSR); ${sets}${statement ? '' : '; return _mjsSR'} })(`)
        closeRhs(node.right.end, node.end, ')')

        changed = true
        return
      }

      if (target.type !== 'MemberExpression') return

      const tp = getPath(target)
      if (!tp) return
      // Le top-level $.x = y reste géré par transformReactiveWrites (le filet
      // Proxy `_mjs_wrapDeep` suffit côté 'local', AUCUNE réécriture ici). Le
      // top-level `$$x = y` (origin 'store', profondeur 1) était laissé à
      // l'accesseur natif `µ.store.x` (set trap) — CORRECTIF : cet accesseur
      // DISPARAÎT si `_mjs_storeDelete` a supprimé
      // la clé (`delete µ.store[key]`), une réassignation ultérieure recrée
      // alors une propriété PLATE (plus aucune notification, `_storeDeclare`
      // skip silencieusement toute clé déjà `hasOwnProperty`). On route donc
      // AUSSI le top-level store par l'API notifiante explicite (`µ._storeSet`),
      // jamais par l'accesseur — ceinture et bretelles avec la conversion
      // plat→accesseur posée dans `_storeDeclare` (mjs_store_globals.ts).
      if (tp.origin === 'local' && tp.path.length < 2) return

      // Compound (`+=` etc.) : seule l'origine 'store' est traitée ici (cf.
      // commentaire COMPOUND_OPS plus haut) — 'local' reste skip,
      // `transformReactiveWrites`/le filet Proxy `_mjs_wrapDeep` suffisent déjà
      // pour ce cas (« gérés ailleurs »). Court-circuit `||=`/`&&=`/`??=` :
      // `baseOp` EST le vrai opérateur JS (`||`/`&&`/`??`), le rhs n'est donc
      // évalué QUE si le court-circuit le permet (sémantique native préservée) ;
      // `_storeSet`/`_mjs_storeDeepSet` sautent en plus l'écriture+notification si
      // la valeur calculée est identique à l'existante (cas où le court-circuit
      // renvoie la valeur de gauche inchangée).
      if (isCompound) {
        if (tp.origin !== 'store') return
        const baseOp = node.operator.slice(0, -1)
        const rootKey = tp.path[0]
        const origLeftText = js.slice(target.start, target.end)
        if (tp.path.length === 1) {
          ms.overwrite(node.start, node.right.start,
            `µ._storeSet(${JSON.stringify(rootKey)}, ${origLeftText} ${baseOp} (`)
        } else {
          const subPathLit = pathToJsLiteral(tp.path.slice(1))
          ms.overwrite(node.start, node.right.start,
            `µ._mjs_storeDeepSet(${JSON.stringify(rootKey)}, ${subPathLit}, ${origLeftText} ${baseOp} (`)
        }
        closeRhs(node.right.end, node.end, '))')
        changed = true
        return
      }

      // Édits de BORDURE : le chunk RHS reste en place dans MagicString, donc
      // les transformations déjà appliquées à l'intérieur (post-ordre :
      // `$.y++`, assignations imbriquées) survivent — un overwrite global
      // recopiait le source ORIGINAL du RHS et les perdait.
      if (tp.origin === 'local') {
        const pathLit = pathToJsLiteral(tp.path)
        ms.overwrite(node.start, node.right.start, `µ._mjs_deepSet(_mjsThis, ${pathLit}, `)
      } else if (tp.path.length === 1) {
        ms.overwrite(node.start, node.right.start, `µ._storeSet(${JSON.stringify(tp.path[0])}, `)
      } else {
        const rootKey = tp.path[0]
        const subPathLit = pathToJsLiteral(tp.path.slice(1))
        ms.overwrite(node.start, node.right.start, `µ._mjs_storeDeepSet(${JSON.stringify(rootKey)}, ${subPathLit}, `)
      }
      closeRhs(node.right.end, node.end, ')')
      changed = true
    },

    // STATISATION — `$$obj.a++`/`--` (depth >= 2, origine 'store'
    // uniquement, même raison que ci-dessus : aucun filet Proxy sur le store).
    // CORRECTIF : le top-level `$$x++`/`--$$x`
    // (depth === 1) était laissé à l'accesseur natif (même trou que
    // AssignmentExpression ci-dessus) : traité ici aussi, via `µ._storeSet`
    // (pas `_mjs_storeDeepSet`, dont la navigation par chemin ne supporte pas un
    // path vide). Fidélité pré/post-fixe : même schéma IIFE que transform-reactive.ts.
    UpdateExpression(node: any) {
      const target = node.argument
      if (!target || target.type !== 'MemberExpression') return
      const tp = getPath(target)
      if (!tp || tp.origin !== 'store') return

      const rootKey = tp.path[0]
      const opSign = node.operator === '++' ? '+' : '-'
      const origText = js.slice(target.start, target.end)
      const setCall = tp.path.length === 1
        ? (v: string) => `µ._storeSet(${JSON.stringify(rootKey)}, ${v} ${opSign} 1)`
        : (v: string) => `µ._mjs_storeDeepSet(${JSON.stringify(rootKey)}, ${pathToJsLiteral(tp.path.slice(1))}, ${v} ${opSign} 1)`
      const replacement = node.prefix
        ? `(${setCall(origText)}, ${origText})`
        : `((_v) => (${setCall('_v')}, _v))(${origText})`
      ms.overwrite(node.start, node.end, replacement)
      changed = true
    },

    // Méthodes mutatives sur alias : `arr.push(x)` → `µ._mjs_deepCall(_mjsThis, path, 'push', [x])`
    // Statisation $$ : racine store → `µ._mjs_storeDeepCall(rootKey, [...tail], method, args)`
    // (`$$arr.push(x)` à la racine même : rootKey='arr', tail=[]).
    // Escape auto-detection retirée : trop de faux positifs sur
    // CallExpression (Object.keys, Math.min, console.log, etc.). Le runtime
    // Proxy `_mjs_wrapDeep` reste le filet de sécurité pour les cas non trackés.
    CallExpression(node: any) {
      const callee = node.callee
      if (callee?.type !== 'MemberExpression') return
      const methodName = callee.property?.name
      if (!methodName || !ALL_MUTATIVE.has(methodName)) return
      // LIMITE CONNUE — la réécriture ne teste
      // QUE le NOM de méthode (`ALL_MUTATIVE`), jamais le TYPE : `$.form.set(k,v)`
      // / `$.o.add(y)` / `$.o.clear()` sur un OBJET MÉTIER à méthode homonyme (pas
      // un vrai Map/Set) partent aussi en `µ._mjs_deepCall`. Choix CONSERVATEUR assumé :
      // prouver la collection-ité exigerait l'info de type de l'analyzer (indispo
      // ici, coûteux) ; le runtime `µ._mjs_deepCall` + le filet Proxy `_mjs_wrapDeep`
      // absorbent le cas. Documenté plutôt que restreint (restreindre ferait perdre
      // la notification compilée sur de vrais Map/Set aliasés).

      const tp = getPath(callee.object)
      if (!tp) return

      // `head` = tête d'appel déjà fermée par sa 1ʳᵉ virgule (`prefix(path, `
      // pour 'local' ; `prefix(rootKey, path, ` pour 'store').
      const head = tp.origin === 'local'
        ? `µ._mjs_deepCall(_mjsThis, ${pathToJsLiteral(tp.path)}, `
        : `µ._mjs_storeDeepCall(${JSON.stringify(tp.path[0])}, ${pathToJsLiteral(tp.path.slice(1))}, `

      const args = node.arguments ?? []
      if (args.length === 0) {
        ms.overwrite(node.start, node.end, `${head}'${methodName}', [])`)
      } else {
        // Bordures uniquement (cf. AssignmentExpression) : les arguments
        // restent en place, leurs édits imbriqués survivent.
        ms.overwrite(node.start, args[0].start, `${head}'${methodName}', [`)
        ms.overwrite(args[args.length - 1].end, node.end, '])')
      }
      changed = true
    },

    // Suppression de clé sur état/alias : `delete $.obj.clé` (ou `delete alias.x`)
    // → `µ._mjs_deepDelete(_mjsThis, [...path])`. Sans ça, `delete` mutait bien la
    // cible mais ne NOTIFIAIT jamais → aucun re-render (le trap `deleteProperty`
    // du Proxy `µ.state` ne couvre que les STORES, pas les `$.` d'un composant).
    // On émet dès la profondeur 1 : le top-level `delete $.x` n'est PAS vu par
    // transformReactiveWrites (qui ne traite que les AssignmentExpression), donc
    // c'est bien ici qu'on le câble. Les clés computées non littérales
    // (`delete $.o[expr]`) donnent un path nul → laissées brutes (conservateur).
    //
    // Statisation $$ : `delete $$x` (profondeur racine, 1 segment) →
    // `µ._mjs_storeDelete('x')` (fonction TOP-LEVEL dédiée, contrat runtime) ;
    // `delete $$obj.a.b` (profondeur >= 2) → `µ._mjs_storeDeepDelete('obj', ['a','b'])`.
    UnaryExpression(node: any) {
      if (node.operator !== 'delete') return
      const target = node.argument
      if (!target || target.type !== 'MemberExpression') return
      const tp = getPath(target)
      if (!tp || tp.path.length < 1) return
      if (tp.origin === 'local') {
        ms.overwrite(node.start, node.end,
          `µ._mjs_deepDelete(_mjsThis, ${pathToJsLiteral(tp.path)})`)
      } else if (tp.path.length === 1) {
        ms.overwrite(node.start, node.end, `µ._mjs_storeDelete(${JSON.stringify(tp.path[0])})`)
      } else {
        ms.overwrite(node.start, node.end,
          `µ._mjs_storeDeepDelete(${JSON.stringify(tp.path[0])}, ${pathToJsLiteral(tp.path.slice(1))})`)
      }
      changed = true
    },
  })

  return passResult(ms, js, changed, 'path-tracker')
}
