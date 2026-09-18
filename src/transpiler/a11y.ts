// transpiler/a11y — lint d'accessibilité au build (lint.a11y,
// ACTIVÉ PAR DÉFAUT — cf. le point de consommation dans transpiler/index.ts,
// juste après le lint maxStateVars, même famille : simple AVERTISSEMENT
// console, jamais bloquant, jamais une erreur de build).
//
// RÈGLE ZÉRO — avant toute analyse, les zones <pre>…</pre> et <code>…</code>
// (exemples de code montrés dans une doc) sont neutralisées : même motif que
// STYLE_INERT_RE (transpiler/sections.ts) — remplacées par des espaces de même
// longueur, `\n` préservés, pour que les numéros de ligne restent justes. Sans
// ça, un site de documentation qui MONTRE du HTML dans ses exemples reçoit des
// dizaines d'alertes fausses — exactement ce qui fait désactiver un contrôle le
// jour de sa livraison.

import { t } from '../messages/index.js'

// tags non-interactifs qui ne doivent jamais porter un handler @click sans role/tabindex
const NON_INTERACTIVE_TAGS = ['div', 'span', 'li', 'td', 'p', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'figure']

// types d'<input> jamais affichés comme un champ visible — aucune étiquette à exiger
const INPUT_TYPES_SANS_ETIQUETTE = ['hidden', 'submit', 'button', 'reset', 'image']

// neutralise un bloc (espaces même longueur, `\n` gardés) — les numéros de ligne
// restent justes quel que soit le masque appliqué
function maskBlocks(html: string, re: RegExp): string {
  return html.replace(re, m => m.replace(/[^\n]/g, ' '))
}

const PRE_RE  = /<pre\b[^>]*\/>|<pre\b[^>]*>[\s\S]*?<\/pre>/gi
const CODE_RE = /<code\b[^>]*\/>|<code\b[^>]*>[\s\S]*?<\/code>/gi

// RÈGLE ZÉRO — masque de RECHERCHE DE BALISES : `<pre>` ET `<code>` neutralisés.
// Un site de documentation MONTRE du HTML dans ses exemples : sans ça, il reçoit
// des dizaines d'alertes fausses, exactement ce qui fait désactiver un contrôle
// le jour de sa livraison.
function maskExamples(html: string): string {
  return maskBlocks(maskBlocks(html, PRE_RE), CODE_RE)
}

// masque de CALCUL DU NOM ACCESSIBLE : `<pre>` seul. Mesuré sur le site de doc —
// 90 des 117 alertes du premier jet venaient d'ici : `<a href="…"><code>&lt;@tag&gt;</code></a>`
// est l'idiome le plus fréquent de ces pages, et masquer le `<code>` faisait passer
// un lien parfaitement nommé pour un lien vide. Le texte d'un `<code>` EST le texte
// visible du lien : il compte pour son nom, il ne compte pas comme balise à inspecter
function maskExamplesForName(html: string): string {
  return maskBlocks(html, PRE_RE)
}

// numéro de ligne (1-based) du caractère à `index` dans `text`
function lineAt(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

// échappe les métacaractères regex d'une valeur littérale (id d'attribut)
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// présence d'un attribut, sous TOUTE forme (nu, ="…", ={…}), avec ou sans `@` devant — jamais sa valeur
function hasAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)@?${name}(?=[\\s=/>]|$)`, 'i').test(attrs)
}

// valeur littérale name="…" (ou @name="…") — undefined si absente ou dynamique (={…})
function attrValue(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`(?:^|\\s)@?${name}=["']([^"']*)["']`, 'i'))
  return m ? m[1] : undefined
}

// présence d'un handler @click, avec ou sans modificateurs (@click.propagate…)
function hasClickHandler(attrs: string): boolean {
  return /@click(?:\.[a-z]+)*(?=[\s=/>]|$)/i.test(attrs)
}

// présence d'un handler clavier (@keydown/@keyup/@keypress), avec ou sans modificateurs — MÊME
// famille que hasClickHandler ci-dessus (cf. hasJustifyingRole).
function hasKeyboardHandler(attrs: string): boolean {
  return /@key(?:down|up|press)(?:\.[a-z]+)*(?=[\s=/>]|$)/i.test(attrs)
}

// role="presentation"/"none" retire EXPLICITEMENT la sémantique de
// l'élément (il ne le rend PAS interactif/focusable) : ces deux valeurs ne justifient jamais un
// handler @click sur un tag non interactif — un rôle dynamique (`role={…}`) ou toute AUTRE
// valeur littérale reste, lui, une justification valable (comportement inchangé).
// Pour éviter une régression déjà rencontrée — `presentation`/`none`
// SEUL reste non-justifiant, mais un écouteur clavier sur le MÊME élément rend l'élément
// opérable au clavier : motif ARIA standard de fond de modale (role="presentation" +
// @click.self + @keydown) —
// sans lui, une div qui EST déjà accessible au clavier recevait une fausse alerte.
const ROLES_NON_JUSTIFICATIFS = ['presentation', 'none']
function hasJustifyingRole(attrs: string): boolean {
  if (!hasAttr(attrs, 'role')) return false
  const role = attrValue(attrs, 'role')
  if (role === undefined || !ROLES_NON_JUSTIFICATIFS.includes(role.toLowerCase())) return true
  return hasKeyboardHandler(attrs)
}

// nom accessible porté par un attribut ARIA/title — aucune des trois = pas de repli
function hasAccessibleNameAttr(attrs: string): boolean {
  return hasAttr(attrs, 'aria-label') || hasAttr(attrs, 'aria-labelledby') || hasAttr(attrs, 'title')
}

// texte "visible" du contenu d'un bouton/lien : retire svg/i/img (purement graphiques), puis toute balise, puis les espaces
function accessibleText(inner: string): string {
  return inner
    .replace(/<svg\b[^>]*\/>|<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<i\b[^>]*\/>|<i\b[^>]*>[\s\S]*?<\/i>/gi, '')
    .replace(/<img\b[^>]*\/?>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, '')
}

/**
 * Contrôles d'accessibilité au build — fonction pure, testable seule. Rend la
 * liste des messages d'alerte (déjà traduits, via le catalogue) ; le transpiler
 * (transpiler/index.ts) fait un `console.warn` par message. Un rappel indiquant
 * comment couper le contrôle est ajouté en dernière position dès qu'il y a au
 * moins une alerte.
 */
export function checkA11y(html: string, moduleName: string): string[] {
  const masked    = maskExamples(html)
  const maskedNom = maskExamplesForName(html)
  const messages: string[] = []

  // 1. <img> sans alt sous AUCUNE forme (alt="" est VALIDE — image décorative).
  //    `<@img>`, le module cœur, est traité comme un `<img>` : c'est exactement son
  //    rôle, et il serait absurde qu'il échappe au contrôle que la balise native subit
  for (const m of masked.matchAll(/<(?:img|@img)\b([^>]*)>/gi)) {
    if (!hasAttr(m[1], 'alt')) messages.push(t('transpiler.a11y-img-alt-manquant', { moduleName, ligne: lineAt(masked, m.index!) }))
  }

  // 2. <iframe> sans title
  for (const m of masked.matchAll(/<iframe\b([^>]*)>/gi)) {
    if (!hasAttr(m[1], 'title')) messages.push(t('transpiler.a11y-iframe-title-manquant', { moduleName, ligne: lineAt(masked, m.index!) }))
  }

  // 3. tabindex positif (0 et -1 sont légitimes)
  for (const m of masked.matchAll(/@?tabindex=["'](-?\d+)["']/gi)) {
    if (Number(m[1]) > 0) messages.push(t('transpiler.a11y-tabindex-positif', { moduleName, ligne: lineAt(masked, m.index!), valeur: m[1] }))
  }

  // 4. @click sur un tag non interactif, sans role ni tabindex
  const nonInteractiveRe = new RegExp(`<(${NON_INTERACTIVE_TAGS.join('|')})\\b([^>]*)>`, 'gi')
  for (const m of masked.matchAll(nonInteractiveRe)) {
    const [, tag, attrs] = m
    if (hasClickHandler(attrs) && !hasJustifyingRole(attrs) && !hasAttr(attrs, 'tabindex')) {
      messages.push(t('transpiler.a11y-click-non-interactif', { moduleName, ligne: lineAt(masked, m.index!), tag }))
    }
  }

  // 5. <button> sans nom accessible (contenu vide une fois les éléments graphiques retirés)
  for (const m of maskedNom.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const [, attrs, inner] = m
    if (!hasAccessibleNameAttr(attrs) && accessibleText(inner) === '') {
      messages.push(t('transpiler.a11y-bouton-nom-manquant', { moduleName, ligne: lineAt(maskedNom, m.index!) }))
    }
  }

  // 6. <a> sans nom accessible — même règle que 5
  for (const m of maskedNom.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const [, attrs, inner] = m
    if (!hasAccessibleNameAttr(attrs) && accessibleText(inner) === '') {
      messages.push(t('transpiler.a11y-lien-nom-manquant', { moduleName, ligne: lineAt(maskedNom, m.index!) }))
    }
  }

  // 7. champ de saisie sans étiquette — input (hors types sans étiquette)/select/textarea
  const hasAnyLabel = /<label\b/i.test(masked)
  const checkField = (tag: string, attrs: string, index: number): void => {
    if (hasAccessibleNameAttr(attrs)) return
    const id = attrValue(attrs, 'id')
    if (id !== undefined) {
      // a. id littéral : il faut un <label for="id"> quelque part dans le gabarit
      const forRe = new RegExp(`<label\\b[^>]*\\bfor=["']${escapeRegExp(id)}["']`, 'i')
      if (!forRe.test(masked)) messages.push(t('transpiler.a11y-champ-etiquette-manquante', { moduleName, ligne: lineAt(masked, index), tag }))
    }
    else if (!hasAttr(attrs, 'id')) {
      // b. aucun id (même dynamique) : il faut au moins un <label> quelque part
      if (!hasAnyLabel) messages.push(t('transpiler.a11y-champ-etiquette-manquante', { moduleName, ligne: lineAt(masked, index), tag }))
    }
    // sinon (id dynamique ={…}) : on se tait, aucun des deux cas fiables ne s'applique
  }
  for (const m of masked.matchAll(/<input\b([^>]*)>/gi)) {
    const type = attrValue(m[1], 'type')
    if (type && INPUT_TYPES_SANS_ETIQUETTE.includes(type.toLowerCase())) continue
    checkField('input', m[1], m.index!)
  }
  for (const m of masked.matchAll(/<select\b([^>]*)>[\s\S]*?<\/select>/gi)) checkField('select', m[1], m.index!)
  for (const m of masked.matchAll(/<textarea\b([^>]*)>[\s\S]*?<\/textarea>/gi)) checkField('textarea', m[1], m.index!)

  if (messages.length > 0) messages.push(t('transpiler.a11y-rappel-desactivation', { moduleName }))

  return messages
}
