// reserved-symbols — interdit à la compilation toute LIAISON (variable,
// paramètre, import, écriture nue) qui porterait le nom d'un symbole du framework : `$` (état du
// composant), `$$` (store), `µ` (runtime). Un `$`/`µ` masqué en paramètre (`paint = ($) ->
// $.style.color = 'red'`) fait écrire le path-tracker dans l'état du composant au lieu de
// l'élément voulu — zéro erreur, mutation perdue (path-tracker.ts ne soumet pas `$`/`µ` à son
// filtre `tainted`). Tourne TROIS fois par composant (transpiler/index.ts) : sur le JS émis du
// `<script>`, des handlers inline et du `<script module>` — toujours APRÈS la compilation langage
// (Civet/Coffee), jamais sur le source brut.

import * as acorn from 'acorn'
import * as walk from 'acorn-walk'
import { t } from '../messages/index.js'

// `§`/`§§` (contexte figé/réactif) : entrées INERTES ici — un `§`/`§§` NU ne survit jamais
// jusqu'à ce JS compilé (refusé plus tôt, sigils.ts bareSectionError) — mais cette liste est
// PARTAGÉE avec le parser côté template (rejectReservedName, parser/index.ts) et la doc :
// source UNIQUE, posées ici pour ne jamais diverger.
export const RESERVED_SYMBOL_NAMES = new Set(['$', '$$', 'µ', '§', '§§'])

// borne un extrait de ligne fautive à une longueur d'affichage raisonnable — même geste que
// clampRaw (transpiler/index.ts), dupliqué ici (pas d'export public à réutiliser sans circularité
// generator/ ↔ transpiler/)
function clampRaw(s: string): string {
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}

// collecte les IDENTIFIANTS liés par un motif de déstructuration — jamais un accès membre, une
// clé d'objet ni une chaîne, ceux-là ne passent jamais par ici : Identifier, ObjectPattern (valeur
// de chaque propriété, ou argument d'un ...reste), ArrayPattern, AssignmentPattern (valeur par
// défaut), RestElement — même schéma que path-tracker.ts/collectPatternNames.
function collectBindingNames(pattern: any, out: any[]): void {
  if (!pattern) return
  switch (pattern.type) {
    case 'Identifier': out.push(pattern); break
    case 'ObjectPattern':
      for (const p of pattern.properties ?? []) collectBindingNames(p.type === 'RestElement' ? p.argument : p.value, out)
      break
    case 'ArrayPattern': for (const el of pattern.elements ?? []) collectBindingNames(el, out); break
    case 'AssignmentPattern': collectBindingNames(pattern.left, out); break
    case 'RestElement': collectBindingNames(pattern.argument, out); break
  }
}

// lève sur le PREMIER symbole réservé lié par ce motif — extrait = la ligne du JS émis qui porte
// l'identifiant fautif (bornes de ligne par lastIndexOf/indexOf, trim, clampRaw)
function checkPattern(pattern: any, js: string, moduleName: string | undefined, section: string): void {
  const bindings: any[] = []
  collectBindingNames(pattern, bindings)
  for (const id of bindings) {
    if (!RESERVED_SYMBOL_NAMES.has(id.name)) continue
    const lineStart = js.lastIndexOf('\n', id.start) + 1
    const nextNl = js.indexOf('\n', id.start)
    const lineEnd = nextNl === -1 ? js.length : nextNl
    const extrait = clampRaw(js.slice(lineStart, lineEnd).trim())
    throw new Error(t('transpiler.symbole-reserve-declare', { moduleName: moduleName ?? '?', section, nom: id.name, extrait }))
  }
}

// lintReservedSymbolNames — refuse toute LIAISON portant le nom d'un symbole du framework, dans
// le JS déjà compilé (jamais sur le source Civet/Coffee brut). Échec de parse → return silencieux,
// une autre passe du pipeline le dira (même contrat que parseModuleAst, transpiler/index.ts).
export function lintReservedSymbolNames(js: string, moduleName: string | undefined, section: string): void {
  if (!js) return
  let ast: acorn.Node
  try {
    ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module' })
  }
  catch {
    return
  }

  walk.full(ast, (node: any) => {
    switch (node.type) {
      case 'VariableDeclarator':
        checkPattern(node.id, js, moduleName, section)
        break
      case 'FunctionDeclaration':
      case 'FunctionExpression':
        if (node.id) checkPattern(node.id, js, moduleName, section)
        for (const p of node.params ?? []) checkPattern(p, js, moduleName, section)
        break
      case 'ArrowFunctionExpression':
        for (const p of node.params ?? []) checkPattern(p, js, moduleName, section)
        break
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) checkPattern(node.id, js, moduleName, section)
        break
      case 'CatchClause':
        checkPattern(node.param, js, moduleName, section)
        break
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        checkPattern(node.local, js, moduleName, section)
        break
      case 'AssignmentExpression':
        checkPattern(node.left, js, moduleName, section)
        break
      case 'UpdateExpression':
        checkPattern(node.argument, js, moduleName, section)
        break
      case 'ForInStatement':
      case 'ForOfStatement':
        if (node.left?.type !== 'VariableDeclaration') checkPattern(node.left, js, moduleName, section)
        break
    }
  })
}
