// transform-reactive — supprime le Proxy `µ.state` en compile-time.
//
// Avant (V1, Proxy) :
//   $.count = $.count + 1     // get/set interceptés par Proxy → invalidate
//
// Après (V2, direct) :
//   µ._set(_mjsThis, 'count', $.count + 1)
//
// Reads restent directes (`$.x` lit `this._state.x` qui est un objet ordinaire).
// Seules les assignations passent par `µ._set` qui fait le `_mjs_invalidate(bit)`.
// Gain : 3-6× sur les renders bind-heavy car plus de trap handler par accès.
//
// Cas spéciaux :
//   - `$.derived = { _mjs_c: true, f: () => ... }` (computed) → on remplace par
//     `µ._mjs_setComputed(_mjsThis, 'derived', () => ...)` car le runtime doit détecter
//     les wrappers _mjs_c différemment sans Proxy.
//   - `$.x op= y` (compound) → expansé en `µ._set(_mjsThis, 'x', $.x op y)`.

import * as acorn from 'acorn'
import * as walk from 'acorn-walk'
import MagicString from 'magic-string'
import { passResult, type PassResult } from './pass-map.js'

const COMPOUND_OPS = new Set([
  '+=', '-=', '*=', '/=', '%=', '**=',
  '&=', '|=', '^=', '<<=', '>>=', '>>>=',
  '&&=', '||=', '??=',
])

export function transformReactiveWrites(js: string): string {
  return transformReactiveWritesMapped(js).code
}

// Variante qui rend AUSSI la carte de source de cette passe — cf. pass-map.ts.
export function transformReactiveWritesMapped(js: string): PassResult {
  if (!js || !js.includes('$.')) return { code: js }

  let ast: acorn.Node
  try {
    ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch {
    return { code: js } // si ça parse pas, on laisse passer (on aura déjà eu une erreur en amont)
  }

  const ms = new MagicString(js)
  let changed = false

  // `ancestor` (et non `simple`) : on a besoin du PARENT pour distinguer une
  // assignation STATEMENT (`$.x = v`, valeur ignorée) d'une assignation en
  // position EXPRESSION (`$a = $b = v`, `notify($x = 5)`).
  // Même parcours post-ordre que `simple` (les transformations imbriquées
  // survivent), avec en plus la pile `ancestors` (dernier élément = node courant).
  walk.ancestor(ast, {
    AssignmentExpression(node: any, _st: any, ancestors: any[]) {
      // une AssignmentExpression dont `left` est un
      // motif (ArrayPattern/ObjectPattern) échappait à la garde MemberExpression
      // ci-dessous : `[$.a, $.b] = [$.b, $.a]` (échange, forme Civet `[$a, $b]
      // = [$b, $a]`) écrivait l'état À NU dans `_state` — aucun `_set`, aucune
      // invalidation, le DOM ne bougeait jamais, zéro erreur. On traite ce cas
      // À PART (édits de BORDURE autour du motif, qui reste en place) avant la
      // garde ci-dessous, qui ne sait matcher qu'une cible MemberExpression seule.
      //
      // Limite CONNUE : une valeur par défaut qui lit un état écrit plus tôt
      // dans le MÊME motif (`[$.a, $.b = $.a] = [1]`) lit l'état AVANT les
      // `_set` (les défauts s'évaluent pendant la déstructuration, les `_set`
      // après). Un `for ([$.a] of xs)` (ForOfStatement, pas une
      // AssignmentExpression) reste hors de portée de ce visiteur.
      if (node.operator === '=' && (node.left.type === 'ArrayPattern' || node.left.type === 'ObjectPattern')) {
        const targets: any[] = []
        collectStateTargets(node.left, targets)
        if (targets.length === 0) return // motif de variables ordinaires, intouché

        for (let i = 0; i < targets.length; i++) ms.overwrite(targets[i].start, targets[i].end, `_mjsD${i}`)

        const parent    = ancestors[ancestors.length - 2]
        const statement = !!parent && parent.type === 'ExpressionStatement'
        const decls     = targets.map((_t: any, i: number) => `_mjsD${i}`).join(', ')
        const sets      = targets.map((t: any, i: number) => `µ._set(_mjsThis, '${t.property.name}', _mjsD${i})`).join('; ')

        // ASI (même raisonnement que UpdateExpression, plus bas) — la forme commence par `(` : en position
        // STATEMENT, `void` coupe l'ASI (mot-clé, pas une parenthèse) et
        // reste valide comme corps d'un `if` sans accolades. Les parenthèses
        // autour du motif dans le corps sont obligatoires : `{a: _mjsD0} =
        // _mjsR` nu en tête d'instruction serait lu comme un BLOC.
        ms.prependLeft(node.start, `${statement ? 'void ' : ''}((_mjsR) => { let ${decls}; (`)
        ms.overwrite(node.left.end, node.right.start, ` = _mjsR); ${sets}${statement ? '' : '; return _mjsR'} })(`)
        closeResidualParens(ms, node, ')')

        changed = true
        return
      }

      if (
        node.left.type !== 'MemberExpression' ||
        node.left.object.type !== 'Identifier' ||
        node.left.object.name !== '$' ||
        node.left.property.type !== 'Identifier'
      ) return

      const varName = node.left.property.name
      const op = node.operator

      // NB : toutes les branches font des édits de BORDURE (préfixe/suffixe) —
      // le chunk RHS reste EN PLACE dans MagicString, donc les transformations
      // déjà appliquées à l'intérieur (walk post-ordre : `$.y++`, `$.obj.k = v`
      // imbriqués…) survivent. Avant, un overwrite GLOBAL du nœud recopiait le
      // source ORIGINAL du RHS : le `$.y++` interne repartait brut → écriture
      // directe de `_state.y` SANS invalidation (DOM jamais mis à jour).

      // --- Computed : RHS = { _mjs_c: true, f: () => ... } ---
      if (op === '=' && isComputedWrapper(node.right)) {
        // On garde le chunk de la fonction en place et on remplace seulement
        // l'enveloppe (`$.x = { _mjs_c…, f:` … `}`).
        const fnNode = (node.right as any).properties.find(
          (p: any) => p.key && p.key.name === 'f'
        )
        if (fnNode) {
          ms.overwrite(node.start, fnNode.value.start, `µ._mjs_setComputed(_mjsThis, '${varName}', `)
          ms.overwrite(fnNode.value.end, node.end, ')')
          changed = true
          return
        }
      }

      // --- Assignation simple `$.x = expr` ---
      if (op === '=') {
        const parent = ancestors[ancestors.length - 2]
        // `µ._set` retourne TOUJOURS
        // `true` : correct en STATEMENT (valeur ignorée), faux quand la valeur de
        // l'assignation est CONSOMMÉE par une expression englobante (`$a = $b = v`
        // → loading=true ; `notify($x = 5)` → notify(true) ; `while (($l =
        // next()) != null)` → boucle infinie). Dans ces cas : IIFE fidèle (même
        // schéma que `++`/`--`) qui RETOURNE la valeur assignée.
        //
        // ALLOWLIST volontairement étroite (pas « tout sauf ExpressionStatement ») :
        //   • un `return $.x = v` (auto-return Coffee, TRÈS courant dans les
        //     handlers) doit rester la forme directe — le routeur d'événements
        //     APPELLE la valeur de retour si c'est une fonction (mjs_element.ts
        //     ~1128) : envelopper ferait renvoyer la VALEUR ASSIGNÉE, donc
        //     appellerait par erreur un handler affecté via `$h = makeHandler()` ;
        //   • idem corps concis d'arrow, for-init/update… : valeur non réellement
        //     réutilisée en aval → forme directe (comportement livré préservé).
        // On n'enveloppe donc QUE les parents où la valeur alimente une AUTRE
        // expression — ce qui couvre exactement les 3 cas.
        const VALUE_CONSUMING = parent && (
          parent.type === 'AssignmentExpression' ||   // $a = ($b = v)
          parent.type === 'CallExpression'       ||   // notify($x = 5)
          parent.type === 'NewExpression'        ||   // new F($x = 5)
          parent.type === 'BinaryExpression'     ||   // ($l = next()) != null
          parent.type === 'LogicalExpression'    ||   // a && ($x = v)
          parent.type === 'ConditionalExpression'     // c ? ($x = v) : w
        )
        if (VALUE_CONSUMING) {
          ms.overwrite(node.start, node.right.start, `((_v) => (µ._set(_mjsThis, '${varName}', _v), _v))(`)
          closeResidualParens(ms, node, ')')
        } else {
          ms.overwrite(node.start, node.right.start, `µ._set(_mjsThis, '${varName}', `)
          closeResidualParens(ms, node, ')')
        }
        changed = true
        return
      }

      // --- Compound `$.x op= expr` → `µ._set(_mjsThis, 'x', $.x op (expr))` ---
      if (COMPOUND_OPS.has(op)) {
        const baseOp = op.slice(0, -1) // '+=' → '+'
        ms.overwrite(node.start, node.right.start, `µ._set(_mjsThis, '${varName}', $.${varName} ${baseOp} (`)
        closeResidualParens(ms, node, '))')
        changed = true
      }
    },

    UpdateExpression(node: any, _st: any, ancestors: any[]) {
      // `$.x++` / `++$.x` → `µ._set(_mjsThis, 'x', $.x + 1)` (et retourne post-/pre-)
      if (
        node.argument.type !== 'MemberExpression' ||
        node.argument.object.type !== 'Identifier' ||
        node.argument.object.name !== '$' ||
        node.argument.property.type !== 'Identifier'
      ) return

      const varName = node.argument.property.name
      const op = node.operator === '++' ? '+' : '-'
      const parent = ancestors[ancestors.length - 2]

      // ASI. Les deux formes fidèles commencent par `(`,
      // et Civet n'émet pas de point-virgule en fin d'instruction : posée en
      // STATEMENT après une autre ligne, la parenthèse ouvrante était lue comme
      // un APPEL de la ligne précédente —
      //   µ._set(_mjsThis, 'edite', null)((_v => …)($.compteur))
      // → « µ._set(...) is not a function », à l'exécution seulement (le JS émis
      // est syntaxiquement valide : ni le build, ni les tests, ni le SSR ne le
      // voyaient). Le piège ne se manifestait qu'« une fois sur deux » : en
      // DERNIÈRE ligne d'un bloc, Civet préfixe d'un `return` qui coupe la
      // continuation. En position STATEMENT la valeur de retour est ignorée par
      // définition — on émet donc la forme DIRECTE, qui commence par `µ` (plus
      // d'aliment pour l'ASI) et n'alloue plus de fermeture au passage.
      if (parent && parent.type === 'ExpressionStatement') {
        ms.overwrite(node.start, node.end, `µ._set(_mjsThis, '${varName}', $.${varName} ${op} 1)`)
        changed = true
        return
      }

      // Valeur CONSOMMÉE (return, argument d'appel, condition…) : forme fidèle.
      // Pre-fix `++$.x` rend la nouvelle valeur, post-fix `$.x++` l'ancienne.
      // Aucun risque d'ASI ici : le nœud n'ouvre jamais une instruction.
      const replacement = node.prefix
        ? `(µ._set(_mjsThis, '${varName}', $.${varName} ${op} 1), $.${varName})`
        : `((_v => (µ._set(_mjsThis, '${varName}', _v ${op} 1), _v))($.${varName}))`
      ms.overwrite(node.start, node.end, replacement)
      changed = true
    },
  })

  return passResult(ms, js, changed, 'transform-reactive')
}

// ----------------------------------------------------------------------------
// Détecte les ObjectExpression de la forme `{ _mjs_c: true, f: ... }`
// ----------------------------------------------------------------------------
function isComputedWrapper(node: any): boolean {
  if (!node || node.type !== 'ObjectExpression') return false
  const props = node.properties ?? []
  const hasMarker = props.some((p: any) =>
    p.type === 'Property' &&
    p.key && (p.key.name === '_mjs_c' || p.key.value === '_mjs_c') &&
    p.value && p.value.type === 'Literal' && p.value.value === true
  )
  const hasF = props.some((p: any) =>
    p.type === 'Property' && p.key && p.key.name === 'f'
  )
  return hasMarker && hasF
}

// ----------------------------------------------------------------------------
// collecte les cibles `$.x` d'un motif de destructuration (ArrayPattern /
// ObjectPattern), RÉCURSIF — jamais le RHS d'un AssignmentPattern (une valeur
// par défaut est une LECTURE, pas une cible d'écriture)
// ----------------------------------------------------------------------------
function collectStateTargets(pattern: any, out: any[]): void {
  if (!pattern) return // trou d'ArrayPattern ([a, , b]) ou branche absente

  switch (pattern.type) {
    case 'ArrayPattern':
      for (const el of pattern.elements) collectStateTargets(el, out)
      return

    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        collectStateTargets(prop.type === 'RestElement' ? prop.argument : prop.value, out)
      }
      return

    case 'AssignmentPattern': // `$.x = defaut` : cible = left, JAMAIS right (une lecture)
      collectStateTargets(pattern.left, out)
      return

    case 'RestElement':
      collectStateTargets(pattern.argument, out)
      return

    case 'MemberExpression':
      if (
        !pattern.computed &&
        pattern.object.type === 'Identifier' &&
        pattern.object.name === '$' &&
        pattern.property.type === 'Identifier'
      ) out.push(pattern)
      return
  }
}

// ----------------------------------------------------------------------------
// ferme un RHS potentiellement parenthésé dans le source
// acorn ne matérialise pas les parens en nœud AST : node.right reste borné à
// l'expression réelle, jamais aux parenthèses qui l'entourent — le résidu de
// `)` entre node.right.end et node.end (s'il existe) est écrasé plutôt que
// laissé survivre à côté de la fermeture ajoutée (overwrite d'une plage vide
// lève dans MagicString, d'où le repli appendLeft quand il n'y a pas de résidu)
// ----------------------------------------------------------------------------
function closeResidualParens(ms: MagicString, node: any, closer: string): void {
  if (node.right.end < node.end) ms.overwrite(node.right.end, node.end, closer)
  else ms.appendLeft(node.end, closer)
}
