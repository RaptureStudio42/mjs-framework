// bundler/core-contract — le CONTRAT entre le générateur et le cœur : toute méthode interne
// qu'une unité compilée APPELLE doit exister dans le `mjs_core.js` que ce build produit.
//
// POURQUOI (septembre 2026, neuf vues d'une application mortes en production pendant deux jours).
// Le cœur n'embarque un module que si `scanCompiledFeatures` (features.ts) reconnaît son marqueur dans
// les unités compilées. Une refonte a renommé 539 propriétés internes `_x` → `_mjs_x` ; entre deux
// versions, le générateur émettait encore `._updList(` quand la regex cherchait déjà
// `._mjs_updList(`. Le scan n'a rien trouvé, `mjs_for_nested.ts` est sorti du cœur, et neuf
// composants qui l'appelaient sont partis en ligne sur `this._updList is not a function`. Zéro
// erreur au build : le build était VERT.
//
// C'est la garde muette du socle §7 appliquée au build — un prédicat de détection qui échoue rend
// « personne n'en a besoin », indiscernable de « rien à embarquer ». `scanCompiledFeatures` ne peut
// pas se surveiller elle-même : ce module regarde la SORTIE, pas les intentions, et refuse de
// finir un build dont le cœur ne tient pas ses promesses.
//
// Deux fonctions, deux textes NON MINIFIÉS (le minifieur raccourcit les `_mjs_*`/`_upd*` via
// mangleCache — les symboles y deviennent invisibles des deux côtés) :
//   collectCoreCalls(js)                → ce que CETTE unité réclame au cœur
//   missingCoreSymbols(coreJs, appels)  → ce que le cœur produit ne rend pas

import { CORE_HELPER_NAMES, blankNonCode } from './minify.js'

// le périmètre surveillé, et RIEN d'autre — deux familles, toutes deux réservées au framework :
//   - le préfixe `_mjs_` : réservé au générateur (cf. assertNoStringIndexedMjsAccess, minify.ts,
//     qui mangle exactement `/^_mjs_/`), jamais écrit par une application ;
//   - les seize helpers courts de CORE_HELPER_NAMES (`µ._p(`, `µ._set(`, `µ._esc(`…), réservés au
//     même titre puisque le mangling se les réserve déjà.
// Une méthode d'application (`this.recharger()`, `@_monHelper`) n'entre dans aucune des deux :
// aucun build sain ne peut être bloqué par un nom que l'utilisateur a choisi.
const SHORT_HELPERS = new Set<string>(CORE_HELPER_NAMES)

// un APPEL, jamais une simple mention : le nom doit être suivi d'une parenthèse ouvrante. C'est ce
// qui écarte les propriétés que l'unité se pose à ELLE-MÊME (`this._mjs_fallback = (err, reset) =>`,
// `static _mjs_noDestroyHooks = false`) — elles ne sont pas des promesses du cœur, et le cœur n'a
// pas à les porter.
const APPEL = /\.(_mjs_[A-Za-z0-9_$]*|_[A-Za-z][A-Za-z0-9_$]*)\s*\(/g

/**
 * Les symboles du contrat qu'une unité compilée appelle. Sur le code NON MINIFIÉ, commentaires et
 * chaînes blanchis (`blankNonCode`) : le bandeau d'un composant qui CITE `_mjs_updList` en prose ne
 * réclame rien, et le prendre pour un appel ferait échouer un build sain.
 */
export function collectCoreCalls(js: string): Set<string> {
  const code  = blankNonCode(js)
  const noms  = new Set<string>()
  let m: RegExpExecArray | null
  APPEL.lastIndex = 0
  while ((m = APPEL.exec(code)) !== null) {
    const nom = m[1]
    if (nom.startsWith('_mjs_') || SHORT_HELPERS.has(nom)) noms.add(nom)
  }
  return noms
}

/**
 * Ceux de ces appels dont le cœur produit ne porte AUCUNE trace de code — triés, pour un message
 * stable d'un build à l'autre.
 *
 * Le test est volontairement le plus LARGE possible : le nom présent n'importe où hors commentaire
 * et hors chaîne suffit. Pas de motif de « définition » (`µ.Element.prototype.X = function`,
 * méthode de classe, propriété d'objet…) : il faudrait le tenir à jour à chaque refonte du runtime,
 * et une garde qui se trompe en refusant coûte plus cher que le bug qu'elle attrape. Un nom absent
 * de TOUT le texte du cœur, lui, est absent sans discussion — c'était exactement le cas de
 * `_updList`, qui ne survivait que dans deux commentaires.
 */
export function missingCoreSymbols(coreJs: string, appels: Iterable<string>): string[] {
  const code      = blankNonCode(coreJs)
  const manquants = [] as string[]
  for (const nom of appels) {
    // `(?![\w$])` seul en queue : un nom du contrat est toujours précédé d'un `.` ou d'un début de
    // déclaration, jamais collé à un identifiant plus long par la GAUCHE (`_p` ne doit pas se
    // reconnaître dans `x._pause`, mais `_mjs_upd` ne doit pas non plus se reconnaître dans
    // `_mjs_updFor`) — la borne de gauche est donc posée elle aussi.
    if (!new RegExp(`(?<![\\w$])${nom}(?![\\w$])`).test(code)) manquants.push(nom)
  }
  return manquants.sort()
}
