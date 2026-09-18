// effect-deps — précalcule au COMPILE-TIME les dépendances réactives d'un
// `µ.effect(callback)` (sucre source : `µeffect -> ...`), au lieu de les
// déduire au RUNTIME par un scan texte de `callback.toString()`.
//
// `µ.effect` (mjs_runes.ts) calculait
// SES dépendances en scannant `fn.toString()` avec une regex littérale
// `$.<var>` (une par clé connue de `comp._mjs_var_bits`). Cassé dès que le code
// est minifié : esbuild (bundler/minify.ts, `minify:true` → `minifyIdentifiers`
// inclus) renomme le PARAMÈTRE local `$` (`function($){...}` → `function(n){...}`,
// vérifié empiriquement sur le VRAI pipeline prod, NODE_ENV=production) SANS
// toucher aux noms de PROPRIÉTÉ (`mangleProps` est restreint à `/^_mjs_/`,
// cf. minify.ts) — le texte minifié contient `n.count`, plus jamais `$.count` :
// la regex ne matche PLUS RIEN. Conséquence : `staticVars` reste TOUJOURS vide
// en prod → CHAQUE `µeffect` bascule sur le mode fail-open "pas de deps
// connues → fire à CHAQUE mutation, peu importe la var" (mjs_element.ts
// `_mjs_runEffectsV2`) — défait tout l'intérêt du dispatch V2 par var, et un
// effect à side-effects (requête réseau, log, animation...) se déclenche
// bien plus souvent en prod qu'en dev, silencieusement (pas un crash — une
// dégradation de perf/comportement difficile à soupçonner).
//
// Fix : détecter ICI, en AST, chaque `µ.effect(callback)` émis par le
// compilateur et lister les `$.xxx` lus (même famille de technique que
// path-tracker.ts pour les mutations) — puis émettre cette liste comme 2e
// argument LITTÉRAL (des STRINGS, jamais renommées par un minifieur, seul
// `_mjs_*` est manglé) : `µ.effect(callback, ["count","label"])`.
// `mjs_runes.ts` utilise ce précalcul quand il est fourni, et ne retombe sur
// le scan `fn.toString()` que si absent (rétrocompat : `µ.effect` appelé hors
// pipeline compilateur, ex. code runtime écrit à la main).
//
// Portée : les `$.xxx` en LECTURE comptent, en DOT notation ou en BRACKET
// notation à clé littérale (`$['xxx']`). Une clé dynamique (`$[expr]`) ne peut
// pas être résolue statiquement — ignorée. Un alias (`box = $.box; box.width`)
// ou une mutation déjà réécrite par path-tracker.ts (`_mjs_deepSet`/`_mjs_deepCall`)
// ne sont pas vus non plus.
//
// FONCTIONS PLATES — une lecture $.x cachée dans une
// fonction plate du même script (`helper = function() { return $.b + 1 }`
// appelée depuis l'effect) restait invisible à l'ancien scan (portée limitée
// au premier niveau du callback + methodReads). Sans danger tant que la liste
// de deps restait VIDE (le filet runtime « aucune dep connue → fire à chaque
// mutation » prenait le relais) — mais dès qu'UNE lecture directe cohabitait
// avec l'appel caché, la liste devenait NON VIDE, le filet se désactivait, et
// la mutation cachée ne redéclenchait plus jamais l'effet : `$b` changeait,
// rien ne rejouait. `$` étant une liaison LOCALE du module compilé, une
// lecture `$.x` ne peut apparaître que dans CE module — les fonctions
// top-level du script (déclaration, affectation de variable, affectation nue
// après un `let` séparé) sont donc résolues PAR LEUR NOM et suivies
// TRANSITIVEMENT (position appel `helper()` ET position valeur
// `list.forEach(helper)`, garde de cycle). Une fonction imbriquée dans une
// AUTRE fonction top-level (donc absente de `ast.body`) reste hors de portée,
// tout comme un alias.
//
// un effet qui APPELLE une méthode
// du composant (`µeffect -> $.total = @fmt()`, compilé `this.fmt()`) devait
// hériter des lectures DE CETTE méthode : sans ça, `{@fmt()}` change dans le
// template mais l'effet qui appelait un équivalent ne se re-déclenchait pas.
// `methodReads` (2e argument, cf. analyzer/index.ts — Analyzer.methodReads,
// déjà point-fixé : une méthode qui en appelle une autre hérite de SES
// lectures) est consulté à chaque `this.<nom>()`/`_mjsThis.<nom>()` rencontré
// DANS le callback. Noms d'état/computed SIMPLES : toujours inclus (le
// runtime étend les computeds via comp._mjs_computedDeps à l'enregistrement, cf.
// mjs_runes.ts ~162-172). Lectures PRÉFIXÉES '$$' (store) : EXCLUES ICI —
// vérifié (mjs_element.ts _mjs_runEffectsV2/_mjs_invalidate) que la comparaison
// staticVars↔mutedVars fonctionnerait bien pour un '$$x' littéral, MAIS la
// souscription qui déclenche `_mjs_invalidate('$$x')` en premier lieu
// (`_mjs_storeKeys`, storeKeysLine — transpiler/index.ts) ne scanne QUE les
// deps template (effectsByVar/structVars) : un `$$x` lu SEULEMENT via une
// méthode appelée ici ne fait jamais souscrire ce composant à la clé, la
// mutation n'atteindrait donc jamais cet effet — inclure la dep serait un
// mort-né silencieux plutôt qu'un vrai câblage.

import * as acorn from 'acorn'
import * as walk from 'acorn-walk'
import MagicString from 'magic-string'
import { passResult, type PassResult } from './pass-map.js'

function extractComputedStaticKey(node: any): string | null {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  return null
}

/**
 * Doit s'appliquer APRÈS applyPathTracking (les mutations $.x profondes sont
 * déjà réécrites en _mjs_deepSet/_mjs_deepCall — hors de portée ici, cf. en-tête) et
 * APRÈS transformReactiveWrites (idem pour les écritures top-level $.x = y).
 * `methodReads` (optionnel) : cf. commentaire en tête de fichier.
 */
export function annotateEffectDeps(js: string, methodReads?: Record<string, string[]>): string {
  return annotateEffectDepsMapped(js, methodReads).code
}

// Variante qui rend AUSSI la carte de source de cette passe — cf. pass-map.ts.
export function annotateEffectDepsMapped(js: string, methodReads?: Record<string, string[]>): PassResult {
  if (!js || !js.includes('µ.effect(')) return { code: js }

  let ast: acorn.Node
  try {
    ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch {
    return { code: js }
  }

  const ms = new MagicString(js)
  let changed = false

  // Fonctions plates TOP-LEVEL du module (cf. en-tête) — 3 formes :
  // déclaration, affectation de variable, affectation nue après un `let` séparé
  // (forme émise pour `nom = -> ...` par le générateur Civet/Coffee).
  const fnByName = new Map<string, any>()
  for (const stmt of (ast as any).body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id?.name) {
      fnByName.set(stmt.id.name, stmt)
      continue
    }
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        if (decl.id?.type === 'Identifier' && decl.init &&
            (decl.init.type === 'FunctionExpression' || decl.init.type === 'ArrowFunctionExpression')) {
          fnByName.set(decl.id.name, decl.init)
        }
      }
      continue
    }
    if (stmt.type === 'ExpressionStatement' && stmt.expression?.type === 'AssignmentExpression' &&
        stmt.expression.operator === '=' && stmt.expression.left?.type === 'Identifier' &&
        (stmt.expression.right?.type === 'FunctionExpression' || stmt.expression.right?.type === 'ArrowFunctionExpression')) {
      fnByName.set(stmt.expression.left.name, stmt.expression.right)
    }
  }

  // Parcourt `fn` et ajoute à `deps` les `$.xxx` lus — DIRECTEMENT, via une
  // méthode `this.m()`/`_mjsThis.m()` (methodReads) ou via un APPEL à une
  // fonction plate du module (fnByName, TRANSITIF — `seen` coupe les cycles).
  function collectReads(fn: any, deps: Set<string>, seen: Set<string>): void {
    walk.ancestor(fn, {
      MemberExpression(n: any) {
        if (n.object?.type !== 'Identifier' || n.object.name !== '$') return
        const key = n.computed ? extractComputedStaticKey(n.property) : (n.property?.name ?? null)
        if (key) deps.add(key)
      },
      // `this.fmt()`/`_mjsThis.fmt()` : méthode connue → ses lectures
      // (déjà point-fixées, '@' résolus) s'ajoutent aux deps de CET effet.
      // '$$' exclues, cf. commentaire en tête de fichier.
      CallExpression(n: any) {
        if (!methodReads) return
        const cc = n.callee
        if (cc?.type === 'MemberExpression' && !cc.computed &&
            (cc.object?.type === 'ThisExpression' || (cc.object?.type === 'Identifier' && cc.object.name === '_mjsThis')) &&
            cc.property?.type === 'Identifier') {
          const sub = methodReads[cc.property.name]
          if (sub) for (const r of sub) { if (!r.startsWith('$$')) deps.add(r) }
        }
      },
      // fonction plate du module référencée — position appel (`helper()`) OU
      // position valeur (`list.forEach(helper)`) : héritage transitif de SES
      // lectures (en-tête).
      Identifier(n: any) {
        if (!fnByName.has(n.name) || seen.has(n.name)) return
        seen.add(n.name)
        collectReads(fnByName.get(n.name), deps, seen)
      },
    })
  }

  walk.simple(ast, {
    CallExpression(node: any) {
      const callee = node.callee
      if (!callee || callee.type !== 'MemberExpression' || callee.computed) return
      if (callee.object?.type !== 'Identifier' || callee.object.name !== 'µ') return
      if (callee.property?.name !== 'effect') return

      // Déjà 2 args (re-passe, ou forme inattendue) : ne rien injecter de plus.
      const args = node.arguments ?? []
      if (args.length !== 1) return
      const cb = args[0]
      if (cb.type !== 'FunctionExpression' && cb.type !== 'ArrowFunctionExpression') return

      const deps = new Set<string>()
      collectReads(cb, deps, new Set<string>())

      const depsLit = `[${[...deps].map(d => JSON.stringify(d)).join(', ')}]`
      ms.appendLeft(cb.end, `, ${depsLit}`)
      changed = true
    },
  })

  return passResult(ms, js, changed, 'effect-deps')
}
