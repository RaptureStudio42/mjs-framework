// this-rebinding — corrige AUTOMATIQUEMENT le `this` perdu d'une flèche fine
// (`->`) top-level NUE, sans rien demander au dev (cf. docs/18-pieges.md §9/§11,
// retirées — le compilateur absorbe désormais la classe de bug entière).
//
// Rappel du piège (déjà réparé À LA MAIN par `@@x`, ce fichier généralise) :
// `nom = -> corps` compile en simple `function(){}` assignée à une variable —
// PAS une méthode d'instance. Son `this` dépend du SITE D'APPEL, pas du site de
// définition : appelée nue (`{nom()}` dans un gabarit, un alias `f = nom; f()`,
// une `->` imbriquée…), `this` vaut `undefined` (module strict) → tout accès
// `this.x` (raccourci `@x`) ou `this._mjs_getRCtx(...)`/`_mjs_setRCtx(...)` (§§)
// explose — TypeError avalée par le dispatch d'event DOM standard, RIEN ne
// remonte à l'app (symptôme sournois : clic qui ne fait rien, aucune erreur
// visible côté utilisateur).
//
// `_mjsThis` (transpiler/template.ts, `init()` : `const _mjsThis = this`) est
// capturé UNE fois par instance, INCONDITIONNELLEMENT (pas seulement si `@@`
// est utilisé quelque part) — accessible par FERMETURE depuis n'importe quelle
// fonction du <script>, quel que soit son niveau d'imbrication, insensible au
// site d'appel. `@@x` l'exploite déjà explicitement (lexer/index.ts, `_mjsThis.x`).
// Cette passe généralise : au lieu de demander au dev de taper `@@`/`=>`, on
// DÉTECTE en AST (post-Civet — `->`/`=>` sont déjà résolus en
// FunctionExpression/ArrowFunctionExpression réels, la distinction thin/thick
// est directement lisible dans le type de nœud, sans re-parser Civet) et on
// réécrit `this` → `_mjsThis` PARTOUT où le `this` en question ne peut PAS être
// garanti correct.
//
// Algorithme — pour chaque `ThisExpression`, on remonte les ancêtres en
// SAUTANT les ArrowFunctionExpression (transparentes : elles ne re-bindent
// jamais `this`, capturent déjà celui de leur portée d'enclosure) jusqu'à :
//   - la racine (aucune FunctionExpression croisée) → top-level du <script>,
//     `this` = composant via `(function($){...}).call(this,$)`
//     (transpiler/template.ts) → SÛR, inchangé ;
//   - une FunctionExpression/FunctionDeclaration dont le parent est une
//     MÉTHODE réelle (MethodDefinition — classe — ou Property — valeur d'un
//     littéral objet, raccourci `{foo(){}}` ou explicite `{foo: function(){}}`,
//     même sémantique this) → SÛR, inchangé (son `this` est correctement lié
//     par la sémantique JS normale `objet.methode()`, quel que soit CET objet —
//     un `this.x` dans une classe/objet utilisateur imbriqué dans le <script>
//     ne doit PAS être forcé vers le composant) ;
//   - une FunctionExpression assignée `cible.nom = function(){...}` — n'IMPORTE
//     quelle cible MemberExpression, pas seulement `this.nom = -> ...` (forme
//     compilée de `@nom = -> ...`) : `o.draw = -> ...` (méthode posée sur un
//     objet natif/utilisateur QUELCONQUE, ex. brand-check `this isnt o`, cf.
//     tests/proxy-native-object-not-wrapped.test.ts) a EXACTEMENT la même
//     garantie — appelée `cible.nom()`, `this` est toujours `cible`, quelle que
//     soit cette cible. RESTREINDRE à `this.nom = ...` cassait ce cas réel (this
//     réécrit en _mjsThis À L'INTÉRIEUR de `draw`, brand-check `this isnt o`
//     alors TOUJOURS vrai → throw) → SÛR, inchangé ;
//   - toute AUTRE FunctionExpression (assignée à un NOM NU sans objet — le
//     motif exact du bug —, callback anonyme passé en argument, imbriquée…)
//     → PAS sûr, ce `this` précis est réécrit en `(this ?? _mjsThis)` — PAS
//     `_mjsThis` en dur : un rebinding
//     EXPLICITE de l'appelant (`helper.call(x)`, `helper.bind(x)()`,
//     `arr.forEach(helper, x)`) pose un `this` réel, non-`undefined` — `??` le
//     respecte. Seul un appel VRAIMENT nu (module ES strict → `this===undefined`)
//     retombe sur `_mjsThis`, exactement le cas visé.
//
// Portée délibérément GÉNÉRALE (tout ThisExpression, pas seulement les sites
// d'appel `_mjs_getRCtx`/`_mjs_setRCtx`/`_mjs_getContext` issus de §/§§, ni le
// `this.x` issu du raccourci `@x`) : couvre par construction toute forme
// actuelle OU future de sucre qui émettrait un jour un accès `this.` dans une
// flèche fine top-level, sans liste à maintenir au cas par cas.
//
// Sans conséquence sur les callbacks déjà invoqués par le runtime via
// `.call(this, …)` (µeffect, hooks µmount/µawake/µsleep/µdestroy/µurlChange,
// handlers inline `@click={…}`, cf. mjs_element.ts _mjs_hook/_mjs_invalidate/le
// dispatch d'event) : `_mjsThis` et `this` y désignent alors le MÊME objet —
// réécrire est un no-op comportemental, jamais une régression. `<script
// module>` n'atteint jamais cette passe (pas de `this`/`_mjsThis` en scope
// module — moduleJs ne passe jamais par transformReactiveWrites/
// applyPathTracking/annotateEffectDeps/cette passe, cf. transpiler/index.ts).
//
// Zéro effet sur l'analyzer (analyzer/index.ts) : sa détection de dépendances
// (computed/effect) est déjà bornée aux assignations top-level (`insideFunction`
// → return anticipé) — cette passe ne touche JAMAIS un `this.` à ce niveau,
// seulement l'intérieur de fonctions, hors de portée de l'analyzer par
// construction.

import * as acorn from 'acorn'
import * as walk from 'acorn-walk'
import MagicString from 'magic-string'
import { passResult, type PassResult } from './pass-map.js'

// `(this ?? _mjsThis)` OUVRE par une parenthèse. JavaScript n'insère pas de
// point-virgule devant `(` : si l'instruction commence par la réécriture, elle se
// COLLE à la ligne précédente et un appel fantôme apparaît — `build()(this ?? …)`
// → TypeError à l'exécution, build vert, aucun avertissement. Trois leçons du tuto
// en sont mortes (bindings-instances, ton-premier-jeu-en-ligne, netcode).
// Un `;` de tête referme le piège.
//
// Il n'est posé QUE si l'instruction vit dans une LISTE d'instructions : dans un
// `if (c) this.x = 1` sans accolades, le `;` deviendrait le corps du `if` et
// rendrait l'affectation INCONDITIONNELLE — le remède serait pire que le mal.
const STATEMENT_LIST_PARENTS = new Set(['BlockStatement', 'Program', 'SwitchCase', 'StaticBlock'])

function opensStatementInList(node: any, ancestors: any[]): boolean {
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const a = ancestors[i]
    if (a.start !== node.start) return false // `this` n'est plus le premier jeton
    if (a.type === 'ExpressionStatement') {
      const outer = ancestors[i - 1]
      return !!outer && STATEMENT_LIST_PARENTS.has(outer.type)
    }
  }
  return false
}

export function rebindDetachedThis(js: string): string {
  return rebindDetachedThisMapped(js).code
}

// Variante qui rend AUSSI la carte de source de cette passe — cf. pass-map.ts.
export function rebindDetachedThisMapped(js: string): PassResult {
  if (!js || !js.includes('this')) return { code: js }

  let ast: acorn.Node
  try {
    ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch {
    return { code: js } // si ça parse pas, on laisse passer (déjà une erreur en amont)
  }

  const ms = new MagicString(js)
  let changed = false

  walk.ancestor(ast, {
    ThisExpression(node: any, _state: any, ancestors: any[]) {
      // ancestors[ancestors.length - 1] === node (convention acorn-walk.ancestor,
      // cf. transform-reactive.ts/path-tracker.ts) : on remonte depuis le parent.
      for (let i = ancestors.length - 2; i >= 0; i--) {
        const a = ancestors[i]
        if (a.type === 'ArrowFunctionExpression') continue // transparente pour `this`
        if (a.type !== 'FunctionExpression' && a.type !== 'FunctionDeclaration') continue // pas une frontière `this`

        // Frontière `this` trouvée — SÛR seulement si méthode réelle (classe,
        // objet littéral, ou assignée `cible.nom = -> ...` sur N'IMPORTE quelle
        // cible) ; sinon réécrit. Property : n'importe QUELLE valeur-fonction
        // d'un littéral objet (raccourci `{foo(){}}` COMME `{foo: -> ...}`
        // explicite, Civet ne distingue pas les deux à l'émission) — `objet.foo()`
        // lie `this` à `objet` dans les DEUX écritures, à sémantique JS égale.
        const parent = ancestors[i - 1]
        const isClassOrObjectMethod =
          parent && (parent.type === 'MethodDefinition' || parent.type === 'Property') && parent.value === a
        const isMemberAssignedMethod =
          parent &&
          parent.type === 'AssignmentExpression' &&
          parent.operator === '=' &&
          parent.right === a &&
          parent.left.type === 'MemberExpression'
        if (!isClassOrObjectMethod && !isMemberAssignedMethod) {
          // `(this ?? _mjsThis)`, pas `_mjsThis` en dur — un rebinding EXPLICITE
          // (`helper.call(x)`, `helper.bind(x)()`, `arr.forEach(helper, x)`) pose un `this` réel et
          // défini à l'intérieur de la fonction ; l'écraser en `_mjsThis` sans
          // condition rendait ce `this` explicite invisible (silencieux — aucune
          // erreur, juste une valeur fausse). Le code compilé vit toujours en
          // module ES (strict) : un appel VRAIMENT nu donne `this === undefined`,
          // jamais l'objet global — `??` retombe alors sur `_mjsThis` (le bug
          // visé, réparé) tout en respectant un `this` explicitement posé par
          // l'appelant (jamais `undefined`, donc jamais écrasé).
          ms.overwrite(node.start, node.end, (opensStatementInList(node, ancestors) ? ';' : '') + '(this ?? _mjsThis)')
          changed = true
        }
        return
      }
      // aucune FunctionExpression croisée avant la racine → top-level, sûr.
    },
  })

  return passResult(ms, js, changed, 'this-rebinding')
}
