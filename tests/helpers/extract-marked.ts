// harnais UJS : fini le comptage d'accolades pour extraire une fonction/un bloc depuis les
// sources runtime (mjs_ujs.ts, mjs_store_globals.ts…) — une accolade littérale dans une chaîne ou un
// commentaire À L'INTÉRIEUR de la zone comptée faussait le compte en silence (SyntaxError cryptique au
// `new Function`). Remplacé par des marqueurs EXPLICITES posés dans la source, en commentaires PURS
// (zéro effet de comportement, esbuild les retire du bundle) :
//   // >>> extrait-test <nom>   seule sur sa ligne, juste AVANT la déclaration/le bloc visé
//   // <<< extrait-test <nom>   seule sur sa ligne, juste APRÈS sa fermeture (`};` ou dernière ligne)
// `extractMarked` cherche la paire par NOM (jamais par dénombrement) : la frontière EST le marqueur,
// insensible au contenu qu'il encadre. Le marqueur fermant est toujours posé APRÈS le terminateur réel
// de la source (`;`/`}`) — la tranche retournée le porte donc déjà, jamais besoin d'en rajouter un à la
// main. `extractMarkedBody` isole le CORPS `{ … }` d'une déclaration déjà délimitée par les marqueurs —
// sûr même si ce corps contient lui-même des accolades, puisqu'on ne compte toujours rien : la 1re
// accolade ouvrante et la dernière fermante de la tranche (déjà exacte) suffisent.

import { strict as assert } from 'node:assert'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function extractMarked(src: string, name: string): string {
  const safe = escapeRegExp(name)
  const openRe = new RegExp(`^[ \\t]*//[ \\t]*>>>[ \\t]*extrait-test[ \\t]+${safe}[ \\t]*$`, 'm')
  const openMatch = openRe.exec(src)
  assert.ok(openMatch, `marqueur ouvrant manquant : "// >>> extrait-test ${name}" introuvable (source déplacée ou renommée ?)`)
  const bodyStart = openMatch!.index + openMatch![0].length
  const rest = src.slice(bodyStart)
  const closeRe = new RegExp(`^[ \\t]*//[ \\t]*<<<[ \\t]*extrait-test[ \\t]+${safe}[ \\t]*$`, 'm')
  const closeMatch = closeRe.exec(rest)
  assert.ok(closeMatch, `marqueur fermant manquant : "// <<< extrait-test ${name}" introuvable (source déplacée ou renommée ?)`)
  return rest.slice(0, closeMatch!.index).trim()
}

export function extractMarkedBody(src: string, name: string): string {
  const full = extractMarked(src, name)
  const open = full.indexOf('{')
  const close = full.lastIndexOf('}')
  assert.ok(open !== -1 && close > open, `corps '{ … }' introuvable dans la tranche marquée "${name}"`)
  return full.slice(open + 1, close)
}
