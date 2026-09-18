// transpiler/ujs-form — lint « <form> sans action ni méthode, intercepté quand même
// par UJS » (lint.ujsForm : le contrat « UJS intercepte
// TOUT <form> » reste entier, mais avec un avertissement). Cf. le point de
// consommation dans transpiler/index.ts, juste après le lint a11y, même famille :
// simple AVERTISSEMENT console, jamais bloquant, jamais une erreur de build.
//
// FAIT ÉTABLI (src/runtime/mjs_ujs.ts ~2634, µ._mjs_ujsShadowAttach) : le pont shadow
// attache µ._mjs_ujsOnSubmit en phase CAPTURE, DANS le constructor du composant — donc
// AVANT le _mjs_bindEvents du composant (capture lui aussi). Un @submit.prevent ne
// protège donc PAS le formulaire, UJS a déjà dispatché : ce lint ne doit PAS
// exempter un formulaire à cause d'un .prevent.
//
// RÈGLE ZÉRO — même motif que transpiler/a11y.ts (et STYLE_INERT_RE, transpiler/
// sections.ts) : les zones <pre>…</pre> et <code>…</code> sont neutralisées avant
// analyse, `\n` préservés pour garder les numéros de ligne justes. Sans ça, le site
// de doc — qui MONTRE des <form> en exemple — reçoit des dizaines de fausses alertes.

import { t } from '../messages/index.js'

// neutralise un bloc (espaces même longueur, `\n` gardés) — les numéros de ligne
// restent justes quel que soit le masque appliqué
function maskBlocks(html: string, re: RegExp): string {
  return html.replace(re, m => m.replace(/[^\n]/g, ' '))
}

const PRE_RE  = /<pre\b[^>]*\/>|<pre\b[^>]*>[\s\S]*?<\/pre>/gi
const CODE_RE = /<code\b[^>]*\/>|<code\b[^>]*>[\s\S]*?<\/code>/gi

// RÈGLE ZÉRO — <pre> ET <code> neutralisés avant la recherche de balises <form>
function maskExamples(html: string): string {
  return maskBlocks(maskBlocks(html, PRE_RE), CODE_RE)
}

// numéro de ligne (1-based) du caractère à `index` dans `text`
function lineAt(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

// action="…" (littérale non vide) ou action={…} (dynamique) — action="" compte comme
// ABSENTE : c'est exactement le piège, le navigateur y remet l'URL courante
function hasAction(attrs: string): boolean {
  const m = attrs.match(/(?:^|\s)@?action=["']([^"']*)["']/i)
  if (m) return m[1] !== ''
  return /(?:^|\s)@?action(?=[\s=/>]|$)/i.test(attrs)
}

// verbe HTTP déclaré : @method (directive source, avant compilation) ou mjs-method
// (forme déjà compilée, si la doc montre directement le HTML de sortie). Le simple
// method="post" NATIF ne compte volontairement PAS ici : la trappe reste entière
// (l'action manque toujours) — seul le marqueur MJS vaut acquiescement délibéré
function hasMethodDirective(attrs: string): boolean {
  return /(?:^|\s)@method(?=[\s=/>]|$)/i.test(attrs) || /(?:^|\s)mjs-method(?=[\s=/>]|$)/i.test(attrs)
}

// opt-out explicite — tiret optionnel, comme le reconnaît le transpiler pour la
// directive elle-même (transpiler/index.ts, @no-?ujs). LA FORME COMPILÉE COMPTE
// AUTANT : ce lint tourne APRÈS la réécriture des directives d'attribut, le HTML
// analysé porte donc déjà `mjs-no-ujs` — sans elle, tout formulaire correctement
// opté dehors était signalé (prouvé au build du site : 3 faux positifs sur 3)
function hasNoUjs(attrs: string): boolean {
  return /(?:^|\s)(?:@no-?ujs|mjs-no-ujs)(?=[\s=/>]|$)/i.test(attrs)
}

/**
 * Lint « <form> sans action ni méthode » au build — fonction pure, testable seule.
 * Rend la liste des messages d'alerte (déjà traduits, via le catalogue) ; le
 * transpiler (transpiler/index.ts) fait un `console.warn` par message.
 */
export function checkUjsForm(html: string, file: string): string[] {
  const masked = maskExamples(html)
  const messages: string[] = []

  for (const m of masked.matchAll(/<form\b([^>]*)>/gi)) {
    const attrs = m[1]
    if (hasAction(attrs) || hasMethodDirective(attrs) || hasNoUjs(attrs)) continue
    messages.push(t('transpiler.lint.ujs-form', { file, ligne: lineAt(masked, m.index!) }))
  }

  return messages
}
