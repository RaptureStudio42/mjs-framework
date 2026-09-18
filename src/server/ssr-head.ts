// ssr-head — <head> thématisé du shell SSR : `shell()` (render-server.ts) n'écrivait
// que charset+viewport — les variables --mjs-* du thème n'arrivaient qu'avec le manifeste JS, donc
// une page rendue au serveur était peinte une 1re fois SANS ses couleurs puis repeinte à l'arrivée
// du script : exactement le flash que le SSR est censé supprimer.
//
// buildSsrHead() construit le contenu d'un unique <style data-mjs-ssr-head>, concaténant dans
// l'ordre : (a) les variables de thème clair/sombre du FRAMEWORK (copie littérale, cf. FRAMEWORK_THEME_CSS
// ci-dessous), (b) le thème d'APPLICATION par défaut (lu dans le manifeste), (c) mjs_root (feuille
// globale de l'app, stylesheetsDir). Une section « absente » (pas encore de build, pas de
// mjs_root…) est simplement OMISE — seule une vraie PANNE (manifeste corrompu, SASS cassé, JSON
// invalide) fait tomber le résultat ENTIER à '' (cf. buildSsrHead : jamais d'exception qui
// remonterait jusqu'au 500, une page sans thème inliné reste une page qui marche).
//
// LIMITE CONNUE (non résolue ici, volontairement) — le serveur ne sait pas quel thème l'utilisateur
// a choisi côté client (µtheme persisté, cf. mjs_store_globals.ts) : il inline TOUJOURS le thème
// PAR DÉFAUT de la configuration. Un utilisateur qui a basculé peut donc encore voir un flash au
// tout premier paint SSR — seulement lui, seulement le temps de ce paint.

import { readFileSync, existsSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { MjsConfig } from '../bundler/config.js'
import { compileCss } from '../transpiler/css.js'
import { deriveUrlPrefix } from '../bundler/index.js'
import { t } from '../messages/index.js'

// (mode `csp`) — émission d'un asset CONTENU-ADRESSÉ hors cycle du bundler : mini version de
// `Bundler.writeHashed` (bundler/index.ts, hors zone ici), MÊME convention de nommage
// (`<base>-<md5 8 hex>.<ext>`, servi statiquement depuis `outputDir`) — sans le nettoyage des
// anciennes versions (pas de cycle de compile ici pour le déclencher) : un fichier orphelin reste
// inoffensif, le hash dérive du contenu, jamais réécrit avec un contenu différent sous le même
// nom. Exportée : réutilisée telle quelle par `renderToString.ts`/`render-browser.ts`/
// `viewer-page.ts` (même famille de besoin, mêmes garanties).
// Le nom de base doit rester dans la famille que la purge des orphelins épargne
// (`SERVER_WRITTEN_RE`, bundler/index.ts — `mjs_ssr_style…`, `mjs_ssr_head…`, `mjs_viewer_…`) :
// ces fichiers ne sortent d'aucun `compile()`, un `mjs build` les retirerait sinon aussitôt
// écrits. Jamais un nom que le bundler émet lui-même (`mjs_style_…` est le sien) : la purge ne
// pourrait plus distinguer les deux, et ses propres unités deviendraient impurgeables.
export function writeHashedAsset(outputDir: string, urlPrefix: string, baseName: string, ext: string, content: string): string {
  const hash     = createHash('md5').update(content).digest('hex').slice(0, 8)
  const filename = `${baseName}-${hash}${ext}`
  const target   = join(outputDir, filename)
  const attendu  = Buffer.byteLength(content, 'utf-8')
  // ÉCRITURE ATOMIQUE — `writeFileSync` DIRECTEMENT sur le chemin final, doublé d'un
  // `if (!existsSync)`, laissait un fichier TRONQUÉ derrière n'importe quelle interruption
  // (disque plein, processus tué en plein rendu) : le `existsSync` du coup d'après le trouvait
  // « déjà là » et ne le réparait JAMAIS. Ce chemin-ci est atteint sur une REQUÊTE SSR vive, pas
  // seulement au build — le CSS mutilé était servi pour toujours. Même remède que
  // `Bundler.writeFileAtomic` : on écrit à côté, puis `rename` (atomique sur le même volume).
  // La taille sert de sonde de complétude : le nom porte le hash du contenu ATTENDU, donc une
  // taille qui ne colle pas dénonce à coup sûr un reliquat tronqué — réécrit, cette fois pour de
  // bon. Un `stat` remplace le `existsSync` : même coût, une information de plus.
  let complet = false
  try { complet = statSync(target).size === attendu } catch { complet = false }
  if (!complet) {
    const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
    writeFileSync(tmp, content, 'utf-8')
    try { renameSync(tmp, target) } catch (e) { try { unlinkSync(tmp) } catch {} ; throw e }
  }
  return `${urlPrefix}/${filename}`
}

// COPIE LITTÉRALE de src/runtime/mjs_theme.ts (µ._mjs_themeSheet.replaceSync(`...`)) — le serveur
// ne peut pas importer ce fichier (CSSStyleSheet/customElements n'existent pas côté Node), donc ce
// CSS vit EN DOUBLE ici. Les deux DOIVENT rester d'accord : tests/ssr-head.test.ts relit
// mjs_theme.ts, en extrait la chaîne, et la compare à celle-ci — toute divergence future (l'une
// éditée sans l'autre) fait tomber ce test au rouge. Guillemets doubles : évite d'échapper les
// apostrophes des sélecteurs d'attribut (`[data-mjs-theme='light']`), déjà présentes telles quelles.
export const FRAMEWORK_THEME_CSS = ":where(:root),:where([data-mjs-theme='light']),:where([theme='light']){--mjs-surface:#fff;--mjs-fg:#222;--mjs-fg-muted:#666;--mjs-border:#d0d0d0;--mjs-hover:#f2f2f2;--mjs-selected:#e6f0ff;--mjs-accent:#3b82f6;--mjs-shadow:rgba(0,0,0,.18)}\n:where([data-mjs-theme='dark']),:where([theme='dark']){--mjs-surface:#232936;--mjs-fg:#e8eaed;--mjs-fg-muted:#9aa3af;--mjs-border:#3a4150;--mjs-hover:#2c3442;--mjs-selected:#2c3e5d;--mjs-accent:#3b82f6;--mjs-shadow:rgba(0,0,0,.55)}"

// extrait un littéral JSON (objet `{...}` ou chaîne `"..."`) qui suit `marker` dans `src` — PAS une
// regex gloutonne/paresseuse : les valeurs sont du CSS, plein d'accolades et de guillemets, qui
// casseraient un simple `match`. Balayage caractère par caractère avec suivi de profondeur/état de
// chaîne (échappements compris) — ROBUSTE même si du code suit sur la MÊME ligne après le littéral
// (cas réel de `µ._themeCss = "…"; if (…) { … }`, cf. bundler/index.ts writeManifest()).
function extractJsonAfter(src: string, marker: string): unknown {
  const at = src.indexOf(marker)
  if (at === -1) return undefined
  let i = at + marker.length
  while (i < src.length && /\s/.test(src[i])) i++
  const start = i
  if (src[i] === '{') {
    let depth = 0, inStr = false, esc = false
    for (; i < src.length; i++) {
      const c = src[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
      } else {
        if (c === '"') inStr = true
        else if (c === '{') depth++
        else if (c === '}') { depth--; if (depth === 0) { i++; break } }
      }
    }
    return JSON.parse(src.slice(start, i))
  }
  if (src[i] === '"') {
    let esc = false
    for (i++; i < src.length; i++) {
      const c = src[i]
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') { i++; break }
    }
    return JSON.parse(src.slice(start, i))
  }
  return undefined
}

// caches par mtimeMs (même patron que readBuildVersion, render-server.ts:69-78) : relecture/
// recompilation SEULEMENT si le fichier source a changé.
const themeCssCache = new Map<string, { mtimeMs: number, css: string }>()
const rootCssCache  = new Map<string, { mtimeMs: number, css: string }>()

// une seule fois pour la durée du process, pas par requête — repli volontairement
// simple : si la panne change de nature après ce 1er signalement, elle ne sera pas re-journalisée
// avant un redémarrage du serveur.
let headExtraErrorLogged = false
function logHeadExtraFailureOnce(e: any): void {
  if (headExtraErrorLogged) return
  headExtraErrorLogged = true
  console.error(t('server.ssr-head-echec', { erreur: e && e.message ? e.message : String(e) }))
}

// thème d'app ACTIF = celui par défaut de la configuration (cf. limite connue en tête de fichier).
// `µ._themeCssByName` (absent des manifestes plus anciens) donne l'entrée d'un SEUL
// thème ; à défaut (clé absente, ou thème par défaut non présent dedans), repli sur `µ._themeCss`
// entier — tous les thèmes concaténés, mais celui par défaut y porte déjà `:root` (assembleThemes,
// bundler/themes.ts), donc aucune fuite visuelle : les autres restent gatés par leur sélecteur
// d'attribut. Manifeste absent/introuvable = section normalement omise, jamais une panne.
function readAppThemeCss(manifestPath: string | null, defaultThemeName: string): string {
  if (!manifestPath || !existsSync(manifestPath)) return ''
  const mtimeMs = statSync(manifestPath).mtimeMs
  const cached = themeCssCache.get(manifestPath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.css
  const src = readFileSync(manifestPath, 'utf-8')
  const byName = extractJsonAfter(src, 'µ._themeCssByName = ') as Record<string, string> | undefined
  let css = ''
  if (byName && typeof byName[defaultThemeName] === 'string') {
    css = byName[defaultThemeName]
  } else {
    const whole = extractJsonAfter(src, 'µ._themeCss = ')
    if (typeof whole === 'string') css = whole
  }
  themeCssCache.set(manifestPath, { mtimeMs, css })
  return css
}

// mjs_root.{sass,scss,css} (stylesheetsDir) — feuille globale de l'app, MÊME convention de nom que
// bundleSharedStyles (bundler/index.ts) : basename 'mjs_root', 1re extension trouvée dans cet ordre
// gagne (un projet réel n'en a qu'un seul). Fichier absent = section normalement omise, jamais une
// panne ; une erreur de compilation SASS, elle, remonte au call-site (compileCss ne l'avale plus,
// cf. son propre commentaire).
function readMjsRootCss(stylesheetsDir: string): string {
  for (const ext of ['sass', 'scss', 'css'] as const) {
    const path = join(stylesheetsDir, `mjs_root.${ext}`)
    if (!existsSync(path)) continue
    const mtimeMs = statSync(path).mtimeMs
    const cached = rootCssCache.get(path)
    if (cached && cached.mtimeMs === mtimeMs) return cached.css
    const css = compileCss(readFileSync(path, 'utf-8'), ext)
    rootCssCache.set(path, { mtimeMs, css })
    return css
  }
  return ''
}

// GRAVE — une variable de thème (`$$x`, cf. bundler/themes.ts) est une DONNÉE que
// l'auteur du site peut vouloir rendre configurable : sans échappement, une valeur comme
// `"</style><script>alert(1)</script>"` est du CSS PARFAITEMENT valide (une simple chaîne) qui
// sort telle quelle dans le <style> ci-dessous et ROMPT le tokenizer HTML. Même défense que
// `escapeScriptClose` (viewer-page.ts), transposée ici (pas importée : ce fichier ne doit rien
// devoir à viewer-page.ts). Le tokenizer HTML reconnaît `</style`/`</script` (insensible à la
// casse) et les bornes de commentaire `<!--`/`-->` QUELLE QUE SOIT LEUR POSITION, y compris au
// milieu d'une chaîne CSS — un antislash devant le caractère qui suit casse cette reconnaissance
// SANS changer le CSS : `\/`, `\!`, `\>` valent respectivement `/`, `!`, `>` à l'intérieur d'une
// chaîne CSS (échappement d'un caractère quelconque), la valeur reste donc intacte et utilisable.
// Hors d'une chaîne, ces séquences n'étaient de toute façon jamais du CSS valide.
function escapeHtmlSensitiveSequences(css: string): string {
  return css
    .replace(/<\/(style|script)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--')
    .replace(/-->/g, '--\\>')
}

/** Contenu du `<head>` thématisé SSR : `<style data-mjs-ssr-head>` (framework + thème d'app +
 *  mjs_root), ou '' si rien à inliner. NE JETTE JAMAIS : toute panne (manifeste corrompu, SASS
 *  cassé, JSON invalide) est rattrapée et rend '' pour l'ENSEMBLE — une page sans thème inliné
 *  reste une page qui marche, une exception ici serait un 500 pour un simple problème de couleurs.
 *  Le CSS inliné est échappé (`escapeHtmlSensitiveSequences`) contre toute rupture du `<style>` par
 *  une valeur de variable de thème hostile. `configDir` : racine de résolution de
 *  `config.stylesheetsDir`, même convention que outputDir/manifestPath (cf. startRenderServer,
 *  render-server.ts). */
export function buildSsrHead(config: MjsConfig, configDir: string, manifestPath: string | null): string {
  try {
    const stylesheetsDir = resolve(configDir, config.stylesheetsDir || 'app/modularjs/styles')
    const parts = [
      FRAMEWORK_THEME_CSS,
      readAppThemeCss(manifestPath, config.defaultTheme || 'light'),
      readMjsRootCss(stylesheetsDir),
    ].filter(css => css !== '')
    // (mode `csp`) — un `<style>` en ligne est BLOQUÉ par `style-src` sans 'unsafe-inline'
    // (vérifié en navigateur) : le même CSS sort en fichier hashé, référencé par un
    // `<link>` — BLOQUANT au rendu, donc toujours anti-flash (contrairement à un chargement async
    // classique). `csp: false` (défaut) : chemin INCHANGÉ, `<style>` en ligne comme avant.
    if (config.csp === true) {
      const outputDir  = resolve(configDir, config.outputDir || 'dist')
      // Préfixe PUBLIC : celui que le projet déclare, sinon celui que le bundler DÉRIVE de son
      // dossier de sortie (même convention, même fonction). Un préfixe vide composait
      // `/mjs_ssr_head-….css` — 404 derrière un back qui sert `public/`, donc une page sans thème
      // alors que le fichier existait bel et bien, une ligne plus bas dans l'arborescence.
      const prefixe    = config.urlPrefix ?? deriveUrlPrefix(outputDir)
      const url        = writeHashedAsset(outputDir, prefixe, 'mjs_ssr_head', '.css', parts.join('\n'))
      return `<link rel="stylesheet" href="${url}">`
    }
    return '<style data-mjs-ssr-head>' + escapeHtmlSensitiveSequences(parts.join('\n')) + '</style>'
  } catch (e: any) {
    logHeadExtraFailureOnce(e)
    return ''
  }
}
