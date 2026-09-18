// bundler/themes — les fichiers `*.theme.mjs`, thèmes du DOCUMENT.
//
// Un fichier de thème n'est pas un composant : il ne produit aucun custom element,
// seulement un paquet de custom properties posé sur un sélecteur d'attribut. Son nom
// vient du fichier (`sombre.theme.mjs` → thème `sombre`), jamais d'un attribut.
//
// Le sélecteur émis n'exige PAS `:root` — c'est tout ce qui sépare « un interrupteur
// pour la page entière » de « des thèmes imbriqués à volonté » : n'importe quel élément
// portant l'attribut devient une racine de thème, et l'héritage des custom properties
// traverse les frontières shadow (mesuré Firefox + Chromium). Deux attributs sont visés :
// `data-mjs-theme`, posé sur `<html>` par la rune µtheme, et `theme`, ce que l'auteur
// d'une page écrit à la main sur une section.
//
// Un thème n'émet QUE ce qu'il déclare : le reste continue de descendre depuis au-dessus
// (c'est l'esprit CSS, des calques qui se superposent). Un thème « or » de trois lignes
// est donc un calque d'accent posable sur n'importe quel fond, sans rien déclarer d'autre.

import { basename } from 'node:path'

import { extractSections } from '../transpiler/sections.js'
import { compileCss } from '../transpiler/css.js'
import { rewriteStyleVars, wrapThemeBlock, type ThemeVar } from '../transpiler/style-vars.js'
import { t } from '../messages/index.js'

export interface CompiledTheme {
  name:     string
  css:      string
  vars:     ThemeVar[]
  read:     string[]
}

export interface ThemeCompileOpts {
  varPrefix?:    string
  defaultTheme?: string
}

/** `app/modularjs/themes/sombre.theme.mjs` → `sombre` */
export function themeNameOf(filePath: string): string {
  return basename(filePath, '.mjs').replace(/\.theme$/, '')
}

export function isThemeFile(filePath: string): boolean {
  return basename(filePath, '.mjs').endsWith('.theme')
}

const THEME_FILE_NAME_RE = /^[a-z][a-z0-9-]*$/

export function compileThemeFile(source: string, filePath: string, opts: ThemeCompileOpts = {}): CompiledTheme {
  const varPrefix    = opts.varPrefix ?? 'mjs'
  const defaultTheme = opts.defaultTheme ?? 'light'
  const name         = themeNameOf(filePath)
  if (!THEME_FILE_NAME_RE.test(name)) throw new Error(t('bundler.theme-nom-fichier', { nom: name, fichier: basename(filePath) }))

  const sections = extractSections(source)
  if (sections.themes.length === 0)      throw new Error(t('bundler.theme-fichier-sans-bloc', { fichier: basename(filePath) }))
  // fichiers de thème — « le fichier ne contient QUE des blocs <theme> (+ commentaires) » : un
  // commentaire HTML (et le blanc autour) hors du bloc est toléré, le reste (balise, texte nu)
  // continue d'échouer avec le même message
  const htmlUtile = sections.html.replace(/<!--[\s\S]*?-->/g, '').trim()
  if (htmlUtile !== '')                  throw new Error(t('bundler.theme-fichier-impur', { fichier: basename(filePath), quoi: 'du HTML' }))
  if (sections.script.raw.trim() !== '') throw new Error(t('bundler.theme-fichier-impur', { fichier: basename(filePath), quoi: 'un <script>' }))
  if (sections.style.raw.trim() !== '')  throw new Error(t('bundler.theme-fichier-impur', { fichier: basename(filePath), quoi: 'un <style>' }))

  const bloc = sections.themes[0]
  if (sections.themes.length > 1) throw new Error(t('bundler.theme-fichier-multi', { fichier: basename(filePath) }))
  if (bloc.name !== '')           throw new Error(t('bundler.theme-fichier-name', { fichier: basename(filePath), nom: bloc.name }))

  // le thème par défaut vaut AUSSI sans attribut : c'est lui que voit une page nue
  const cibles = [`:where([data-mjs-theme='${name}'])`, `:where([theme='${name}'])`]
  if (name === defaultTheme) cibles.unshift(':where(:root)')

  const rw  = rewriteStyleVars(bloc.raw, { prefix: varPrefix })
  const css = compileCss(wrapThemeBlock(cibles.join(','), rw.code, bloc.lang), bloc.lang)

  return { name, css, vars: rw.declared.map(d => ({ name: d.name, variant: '', line: d.line, doc: d.doc })), read: rw.read }
}

/** Rend le CSS agrégé de TOUS les thèmes de document, dans un ordre stable. */
export function assembleThemes(themes: CompiledTheme[], defaultTheme = 'light'): string {
  // ORDRE — le thème par défaut D'ABORD, le reste alphabétique (ordre stable : un CSS
  // reproductible évite un rebuild fantôme à chaque compilation).
  // La position du défaut, elle, N'EST PAS cosmétique : lui seul émet aussi sur `:where(:root)`,
  // donc sa règle matche <html> même quand un AUTRE thème y est posé. Tous ces sélecteurs sont
  // en `:where()`, spécificité nulle : à égalité, c'est l'ORDRE DU TEXTE qui tranche. Émis en
  // dernier (l'alphabétique mettait `light` après `dark`), le défaut reprenait la main sur la
  // racine et `µtheme = 'dark'` ne repeignait plus la page — mesuré au navigateur, corrigé ici.
  // Comparaison par POINT DE CODE, jamais `localeCompare` : celui-ci dépend de la locale
  // de la machine — deux builds du même code sur deux postes rendraient un CSS différemment
  // ordonné, exactement ce que `writeManifest` interdit explicitement pour la même raison.
  const parCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const parDefaut = themes.filter(th => th.name === defaultTheme)
  const autres    = themes.filter(th => th.name !== defaultTheme).sort((a, b) => parCodePoint(a.name, b.name))
  return [...parDefaut, ...autres].map(th => th.css).join('')
}
