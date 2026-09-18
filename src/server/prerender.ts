// prerender — génère au BUILD le HTML des PAGES déclarées en mode 'prerender'.
//
// Réutilise le SSR programmatique (createSSRRenderer) : UN renderer compile le
// sourceDir une seule fois, puis rend chaque page (fenêtre happy-dom neuve par
// page → stores isolés). Écrit un fragment Declarative Shadow DOM (+ sharedScript)
// que le back sert pour l'URL correspondante ; le bundle client hydrate par-dessus
// (render-then-replace). Le dev ne déclare QUE la config — aucun script de rendu.
//
// Ne traite QUE les routes CONCRÈTES en mode 'prerender' (isBuildPrerenderable) :
// les routes paramétrées et les modes ssr/csr relèvent du serveur ou du
// client — ils sont SIGNALÉS dans le rapport (jamais de silence).

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, rmdirSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveBundlerOpts, type MjsConfig, type RenderEngine } from '../bundler/config.js'
import { stripStartupHeader } from '../bundler/startup.js'
import { createSSRRenderer, type SSRRenderer } from './renderToString.js'
import { resolvePage, isBuildPrerenderable } from './render-routes.js'
import { resolveEngine, createBrowserRenderer, type BrowserRenderer } from './render-browser.js'
import { t } from '../messages/index.js'

export interface PrerenderReport {
  /** Dossier où les pages ont été écrites. */
  outDir: string
  /** `tags` — balises `mjs-*` DISTINCTES du HTML rendu, triées (celles des
   *  `<template shadowrootmode>` comprises : simple relevé sur le HTML sérialisé). C'est ce que la
   *  page AFFICHE, seul le fragment le sait dès sa construction : `bundler/startup.ts` en dérive
   *  l'ensemble de démarrage préchargé par le fragment lui-même. */
  generated: { url: string; file: string; component: string; bytes: number; tags: string[] }[]
  // `fatal` — DISTINGUE un échec de RENDU (page DÉCLARÉE, composant
  // introuvable/exception, jamais promis à personne au client) d'un skip ATTENDU (route paramétrée,
  // mode non buildable) : seul le premier doit faire échouer `mjs build` (cf. cli.ts). Absent/false
  // pour les deux skips attendus (comportement historique, jamais de faux positif sur eux).
  skipped: { url: string; reason: string; fatal?: boolean }[]
}

/**
 * Garde-fou — overrides `--output`/
 * `--manifest` du CLI (cf. cli.ts, `mjs build`), à transmettre EXPLICITEMENT
 * à `prerenderPages` : sans ça, cette passe re-dérivait `outputDir`/
 * `manifestPath` DIRECTEMENT depuis `mjs.config.json`, ignorant un build
 * redirigé — le prérendu recompilait puis ÉCRASAIT les fichiers du VRAI
 * projet même quand la sortie du build principal avait été explicitement
 * déplacée ailleurs. Chemins relatifs à `configDir`
 * (même convention que `config.outputDir`/`config.manifestPath`).
 */
export interface PrerenderOverrides {
  outputDir?: string
  manifestPath?: string
  /** Environnement du build appelant (`mjs build --prod`) — le prérendu recompile dans le
   *  VRAI dossier de sortie : sans lui, il repasserait ce build en développement. */
  env?: 'dev' | 'prod'
}

/** URL de page → chemin de fichier relatif : '/' → 'index.html',
 *  '/blog' → 'blog.html', '/a/b' → 'a/b.html'. */
export function urlToFile(url: string): string {
  const clean = url.replace(/^\/+/, '').replace(/\/+$/, '')
  return clean === '' ? 'index.html' : clean + '.html'
}

/**
 * MARQUE de la ligne-bandeau d'un fragment : un fichier dont la PREMIÈRE LIGNE la porte est un
 * fragment que le prérendu a écrit — et lui seul est à nous (cf. la purge en fin de passe). Fixe et
 * hors catalogue : la phrase du bandeau, elle, suit la langue du build, une purge ne peut pas en
 * dépendre.
 */
export const PRERENDER_MARK = '<!-- mjs:prerender'

/** Ligne-bandeau d'un fragment : la marque, puis la phrase du catalogue (URL, langue). */
export function prerenderBanner(url: string, lang?: string): string {
  return `${PRERENDER_MARK} — ${t('server.prerender-banner', { url, lang })} -->`
}

/** Ligne-bandeau des fragments écrits AVANT la marque (français et anglais, la seule forme qu'ils
 *  aient jamais eue) : un fragment d'un build antérieur reste reconnu, donc purgeable. */
const ANCIEN_BANDEAU = /^<!-- Page (?:prérendue par|pre-rendered by) MJS \(mjs build\) /

/** Tête lue d'un `.html` candidat (octets) : la ligne-bandeau y tient largement, et aucune page
 *  entière n'est chargée pour un test de première ligne. */
const TETE_OCTETS = 4096

/**
 * Le prérendu a-t-il écrit CE fichier ? Sa première ligne porte la marque du bandeau, ou l'ancien
 * bandeau d'un build antérieur. Tout autre `.html` — coquille de l'application, page posée à la
 * main, sortie d'un autre outil — n'est PAS à nous : la purge n'y touche jamais, quel que soit
 * `render.outDir` (il peut être partagé, ou être la racine du projet). Fichier illisible : pas à
 * nous non plus.
 */
function ecritParLePrerendu(file: string): boolean {
  let tete: string
  try {
    const fd = openSync(file, 'r')
    try {
      const tampon = Buffer.alloc(TETE_OCTETS)
      const lus    = readSync(fd, tampon, 0, TETE_OCTETS, 0)
      tete = tampon.toString('utf-8', 0, lus)
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
  const fin   = tete.indexOf('\n')
  const ligne = fin < 0 ? tete : tete.slice(0, fin)
  return ligne.startsWith(PRERENDER_MARK) || ANCIEN_BANDEAU.test(ligne)
}

/**
 * Éléments dont le contenu n'affiche AUCUN composant : les éléments à texte brut de HTML5 (`style`,
 * `script`, `textarea`, `title`, `xmp`, `iframe`, `noembed`, `noframes`, `plaintext`), dont le
 * contenu n'est pas du balisage et que la sérialisation n'échappe donc pas — une balise citée dans
 * le `content:` d'une feuille de style (`content: '<mjs-x></mjs-x>'`, qui part dans le `<style>` du
 * fragment) n'affiche rien ; plus `noscript`, dont le contenu ne compte que pour un navigateur SANS
 * script, c'est-à-dire jamais pour la page que MJS démarre.
 *
 * `<template>` n'en est PAS : un `<template shadowrootmode>` porte le vrai balisage du Declarative
 * Shadow DOM, ses balises comptent autant que celles du document (cf. collectTags pour le
 * `<template>` sans cet attribut, lui inerte).
 *
 * Une regex de fermeture par nom, construite une fois : `</style` ne ferme l'élément que suivi d'un
 * blanc, d'un `/` ou du `>` (`</styles>` n'est pas sa fin). Fermeture absente : plus rien n'est
 * relevé jusqu'à la fin du document. `plaintext` est traité comme les autres — un analyseur HTML5 ne
 * le fermerait jamais, une `</plaintext>` écrite à la main rouvre ici le relevé ; le rendu n'en écrit
 * pas, et relever une balise de trop ne coûte qu'un préchargement.
 */
const RAW_TEXT_ELEMENTS = new Map<string, RegExp>(
  ['style', 'script', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'noscript'].map(nom => [nom, new RegExp(`</${nom}[\\s/>]`, 'gi')]),
)

/** Attribut qui fait d'un `<template>` un Shadow DOM déclaratif : son contenu est alors le balisage
 *  d'une ombre, pas un gabarit inerte. Cherché sur la balise ouvrante SEULE. */
const DSD_ATTR = /\sshadowrootmode[\s/>=]/i

/** Bornes d'un `<template>` : ouvrantes et fermantes, pour en compter les imbrications. */
const TEMPLATE_BORNE = /<(\/?)template[\s/>]/gi

/** Index du `<` qui FERME le `<template>` ouvert avant `from` (imbrications comptées : un gabarit
 *  imbriqué ne ferme pas son parent) — fin du texte si la fermeture manque. */
function finDuTemplate(html: string, from: number): number {
  TEMPLATE_BORNE.lastIndex = from
  let profondeur = 1
  let borne: RegExpExecArray | null
  while ((borne = TEMPLATE_BORNE.exec(html))) {
    profondeur += borne[1] ? -1 : 1
    if (profondeur === 0) return borne.index
  }
  return html.length
}

/**
 * Balises `mjs-*` DISTINCTES du HTML rendu, triées. Relevé sur le texte SÉRIALISÉ (les
 * `<template shadowrootmode>` du Declarative Shadow DOM sont du texte comme le reste, leurs balises
 * comptent donc autant que celles du document) — par un petit TOKENISEUR, jamais par une simple
 * recherche de motif : hors d'une balise, `<mjs-nom` en ouvre une ; DANS une balise, les valeurs
 * entre guillemets sont sautées ; les commentaires le sont aussi. Une balise CITÉE dans une valeur
 * d'attribut (`data-gabarit="<mjs-x></mjs-x>"`, que la sérialisation HTML n'échappe pas) n'est donc
 * pas relevée — elle n'est rien de ce que la page affiche. Un `<mjs-x>` cité dans du TEXTE (exemple
 * de code d'une page de doc) y arrive échappé (`&lt;mjs-x`) et n'en est pas un non plus ; le
 * `sharedScript` (fiches JSON du store et de l'i18n) reste hors de ce relevé. Le contenu d'un
 * élément à TEXTE BRUT est sauté d'un bloc (cf. RAW_TEXT_ELEMENTS), celui d'un `<template>` SANS
 * `shadowrootmode` aussi : un gabarit n'affiche rien tant que personne ne le clone, et ce que le
 * clone affichera, c'est le HTML du composant qui le clone. Un `<template>` dont un ATTRIBUT porte
 * le mot `shadowrootmode` passe pour une ombre : une balise relevée de trop ne coûte qu'un
 * préchargement, une balise manquée coûterait un aller-retour à l'affichage.
 */
export function collectTags(html: string): string[] {
  const vus = new Set<string>()
  // `y` (sticky) : le nom doit commencer EXACTEMENT au crochet trouvé — et rien n'est recopié, là où
  // un `slice()` par balise coûterait une copie de la page entière à chacune
  const nomRe = /<([a-zA-Z][^\s/>]*)/y
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break
    if (html.startsWith('<!--', lt)) {
      const fin = html.indexOf('-->', lt + 4)
      i = fin < 0 ? html.length : fin + 3
      continue
    }
    nomRe.lastIndex = lt
    const nom = nomRe.exec(html)
    if (!nom) { i = lt + 1; continue }
    const balise = nom[1].toLowerCase()
    if (/^mjs-[a-z0-9-]+$/.test(balise)) vus.add(balise)
    // jusqu'au `>` de FERMETURE de cette balise, valeurs quotées sautées d'un bloc
    let j = lt + nom[0].length
    while (j < html.length && html[j] !== '>') {
      if (html[j] === '"' || html[j] === '\'') {
        const fin = html.indexOf(html[j], j + 1)
        j = fin < 0 ? html.length : fin + 1
        continue
      }
      j++
    }
    // contenu d'un élément à texte brut : sauté jusqu'à SA balise de fermeture (une balise auto-fermée
    // `<style/>` n'ouvre aucun contenu). Jamais fermé : plus rien n'est du balisage après lui.
    const autoFermee = html[j - 1] === '/'
    const brute = autoFermee ? undefined : RAW_TEXT_ELEMENTS.get(balise)
    if (brute) {
      brute.lastIndex = j + 1
      const fin = brute.exec(html)
      if (!fin) break
      i = fin.index
      continue
    }
    // gabarit INERTE (`<template>` sans `shadowrootmode`) : son contenu entier est sauté, sa
    // fermeture comptée par imbrication
    if (balise === 'template' && !autoFermee && !DSD_ATTR.test(html.slice(lt, j + 1))) {
      i = finDuTemplate(html, j + 1)
      continue
    }
    i = j + 1
  }
  return [...vus].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
}

/**
 * Prérend au build toutes les pages `prerender` concrètes du bloc `render`.
 * Sans bloc `render` (ou sans route prérendable), c'est un no-op silencieux.
 * `log` reçoit une ligne par page (générée ou ignorée) — jamais de troncature muette.
 */
export async function prerenderPages(
  config: MjsConfig,
  configDir: string,
  log: (msg: string) => void = () => {},
  overrides: PrerenderOverrides = {},
): Promise<PrerenderReport> {
  const render = config.render
  // Garde-fou — `overrides.outputDir` (donc
  // `--output` CLI) prime sur `config.outputDir` : cf. PrerenderOverrides pour
  // le pourquoi. `manifestPath` ci-dessous suit la MÊME priorité, transmis
  // plus bas aux deux renderers plutôt que re-dérivé indépendamment par
  // chacun (cf. leurs commentaires respectifs).
  const outputDir = overrides.outputDir
    ? resolve(configDir, overrides.outputDir)
    : resolve(configDir, config.outputDir || 'dist')
  const manifestPath = overrides.manifestPath
    ? resolve(configDir, overrides.manifestPath)
    : (config.manifestPath ? resolve(configDir, config.manifestPath) : join(outputDir, 'bundle.js'))
  const outDir = render?.outDir
    ? resolve(configDir, render.outDir)
    : join(dirname(outputDir), 'mjs_pages')
  const report: PrerenderReport = { outDir, generated: [], skipped: [] }
  // Sans bloc `render`, ce projet ne prérend rien et n'a jamais rien écrit dans `outDir` (valeur par
  // défaut, dossier de personne) : on n'y touche pas — la purge, elle, appartient aux configurations
  // qui déclarent un rendu.
  if (!render) return report
  // fichiers que CETTE configuration prérend (échec de rendu compris) : tout autre fragment du
  // dossier est sans route, cf. purgerFragments
  const attendus = new Set<string>()
  // PURGE — appelée à chaque sortie de cette fonction, et pas seulement après un rendu : une
  // configuration qui ne prérend plus RIEN (dernière route passée en `csr`/`ssr`, `routes` retiré)
  // laissait sinon ses fragments sur disque, servis tels quels, avec des liens de démarrage vers les
  // fichiers de page que le MÊME build vient de purger. Rien après un échec de rendu (cf. la garde).
  const purger = (): void => {
    if (report.skipped.some(s => s.fatal) || !existsSync(outDir)) return
    purgerFragments(outDir, attendus, log)
  }
  if (!render.routes) {
    purger()
    return report
  }

  // Sépare les pages prérendables (concrètes + mode prerender) du reste (signalé).
  // settleMs/engine simplement TRANSITÉS depuis resolvePage (défauts + résolution
  // du moteur appliqués plus bas, page par page — une route peut surcharger l'axe
  // 'prerender' indépendamment des autres).
  const pages: { url: string; component: string; settleMs?: number; engine?: RenderEngine; light?: boolean }[] = []
  for (const url of Object.keys(render.routes)) {
    const page = resolvePage(url, render)
    if (!page) continue
    if (isBuildPrerenderable(url, page.mode)) {
      pages.push({ url, component: page.component, settleMs: page.settleMs, engine: page.engine, light: page.light })
    } else if (page.mode === 'prerender') {
      report.skipped.push({ url, reason: t('server.prerender-route-parametree') })
    } else {
      report.skipped.push({ url, reason: t('server.prerender-mode-non-buildable', { mode: page.mode }) })
    }
  }
  if (pages.length === 0) {
    purger()
    return report
  }

  const sourceDir = resolve(configDir, config.sourceDir || '.')
  // La voie de
  // prérendu de `mjs build` (et `prerenderOnDevRecompile`) appelait
  // `createSSRRenderer` avec une LISTE BLANCHE d'options écrite à la main : toute
  // clé de config absente de cette liste était silencieusement perdue. Comme ce
  // renderer recompile DANS le vrai `outputDir` par-dessus le build principal, la
  // clé manquante ne se contentait pas d'être inerte — elle DÉFAISAIT le build
  // (`minify: true` perdu → sortie non minifiée, manifeste `dev:true`, fragments
  // i18n renommés en clair au lieu d'être hachés).
  // On transmet désormais les options RÉSOLUES, exactement comme la voie
  // navigateur (render-browser.ts) : le prérendu compile à l'identique du build.
  const bundlerOpts = resolveBundlerOpts(config, configDir)

  // Résout le moteur de CHAQUE page À L'AVANCE (priorité route > config > défaut,
  // simple logique + une sonde Playwright déjà mémoïsée — aucun coût de
  // lancement/compilation ici) : permet de savoir QUELS moteurs sont réellement
  // nécessaires pour toute la passe AVANT de compiler quoi que ce soit.
  const resolved: { url: string; component: string; settleMs?: number; engine: RenderEngine; light?: boolean }[] = []
  for (const p of pages) {
    resolved.push({ ...p, engine: await resolveEngine('prerender', config, { engine: p.engine }, { log }) })
  }
  const needsHappy = resolved.some(p => p.engine === 'happy-dom')
  const needsBrowser = resolved.some(p => p.engine === 'browser')

  // Un renderer par moteur RÉELLEMENT utilisé (jamais les deux si un seul suffit),
  // PARTAGÉ pour toute la passe (build entier, ou un dev-recompile) — un seul
  // compile/lancement par moteur, jamais par page. Créés ICI, HORS de tout
  // try/catch par page : une erreur de COMPILATION (projet entier, pas une page en
  // particulier) doit rester FATALE à toute la passe — la capturer par page la
  // réduirait à un simple `skipped` de la première page venue, silencieuse pour
  // toutes les suivantes du même moteur. Seul le RENDU (par page) est capturable.
  // outputDir réel → les URLs d'assets compilés correspondent à ce que sert le back.
  const happyRenderer: SSRRenderer | null = needsHappy
    ? await createSSRRenderer({ sourceDir, outputDir, manifestPath, bundlerOpts, env: overrides.env })
    : null
  const browserRenderer: BrowserRenderer | null = needsBrowser
    ? await createBrowserRenderer(config, { configDir, log, sourceDir, outputDir, manifestPath, env: overrides.env })
    : null

  // Prérendu multi-langue OPT-IN : `render.locales` avec ≥ 2 entrées déclenche
  // une passe par langue (store.__mjsLang), écrite dans un sous-dossier
  // `outDir/<langue>/`. Absent ou < 2 entrées : comportement mono-langue EXACT
  // (rétro-compat stricte, chemin plat, aucun sous-dossier).
  const locales = render.locales && render.locales.length >= 2 ? render.locales : null

  try {
    for (const { url, component, settleMs, engine, light } of resolved) {
      const targets: { lang?: string; file: string }[] = locales
        ? locales.map(lang => ({ lang, file: join(outDir, lang, urlToFile(url)) }))
        : [{ file: join(outDir, urlToFile(url)) }]
      for (const { lang, file } of targets) {
        attendus.add(file)
        const langTag = lang ? ` [${lang}]` : ''
        try {
          // `light` : racine montée SANS Shadow DOM (clé de route `light`, cf. bundler/config.ts) —
          // simple transit, le rendu décide seul de ce qu'il en fait.
          const renderOpts = lang ? { settleMs, light, store: { __mjsLang: lang } } : { settleMs, light }
          const { html, sharedScript, warnings } = engine === 'browser'
            ? await browserRenderer!.renderPage(component, renderOpts)
            : await happyRenderer!.renderToString(component, renderOpts)
          // Les warnings du rendu
          // (shadowMode:'closed', rendu non stabilisé, compilation…) étaient
          // ignorés (destructuration `{ html, sharedScript }`) : aucun signal au
          // build. On les remonte via le `log` du rapport (jamais de silence).
          for (const w of warnings) log(`   ⚠️  ${url}${langTag} : ${w}`)
          mkdirSync(dirname(file), { recursive: true })
          const banner = `${prerenderBanner(url, lang)}\n`
          const out = banner + (sharedScript ? sharedScript + '\n' : '') + html + '\n'
          // Écriture SAUTÉE quand le CORPS rendu est celui déjà sur disque : le fragment porte, en
          // plus, l'en-tête de démarrage de `bundler/startup.ts` (borné par ses lignes-repères),
          // qu'on retire avant de comparer. Sans cette garde, chaque passe réécrivait le fragment —
          // en-tête compris — et le watcher de `mjs dev` se redéclenchait sur un fichier dont
          // rien n'avait changé.
          if (!existsSync(file) || stripStartupHeader(readFileSync(file, 'utf-8')) !== out) {
            writeFileSync(file, out, 'utf-8')
          }
          report.generated.push({ url, file, component, bytes: out.length, tags: collectTags(html) })
          log(`   ✓ ${url}${langTag} → ${file}  (${component}, moteur ${engine})`)
        } catch (e: any) {
          report.skipped.push({ url, reason: t('server.prerender-echec-rendu', { component, langTag, err: e?.message || e }), fatal: true })
          log(`   ✗ ${url}${langTag} : ${e?.message || e}`)
          // Une page qui échoue à SE prérendre ne doit jamais laisser servir le
          // HTML PÉRIMÉ d'un build antérieur (toujours COMPLET, juste FAUX) : suppression explicite
          // plutôt qu'un repli implicite (un fichier absent est honnête, un fichier obsolète invisible
          // ne l'est pas). Rien à supprimer au tout premier build (fichier jamais écrit) : silencieux.
          try {
            if (existsSync(file)) {
              unlinkSync(file)
              log(`   🗑️  ${url}${langTag} : ${t('server.prerender-fichier-perime-supprime', { file })}`)
            }
          } catch (delErr: any) {
            log(`   ⚠️  ${url}${langTag} : ${t('server.prerender-echec-suppression', { file, err: delErr?.message || delErr })}`)
          }
        }
      }
    }
  } finally {
    if (happyRenderer) await happyRenderer.close()
    if (browserRenderer) await browserRenderer.close()
  }

  // FRAGMENTS SANS ROUTE : un fragment du dossier de sortie qui ne correspond à aucune page de CETTE
  // configuration (route retirée, passée en `csr`/`ssr`, URL renommée, langue retirée) est un fichier
  // COMPLET — le back le sert tel quel, avec le contenu ET les liens de démarrage d'un build
  // antérieur, sans que rien ne le signale. Retirés en fin de passe, une ligne de journal par fichier
  // (`mjs dev` recompile par la même fonction : même nettoyage).
  purger()
  return report
}

/** Dossiers jamais balayés, quel que soit `render.outDir` : le prérendu n'y écrit pas de fragment, et
 *  `outDir` peut être la racine du projet (y descendre coûterait tout `node_modules` par build). */
const HORS_BALAYAGE = new Set(['node_modules'])

/**
 * Balaie `dossier` et TOUS ses sous-dossiers, et retire les fragments que le prérendu a écrits
 * (première ligne = ligne-bandeau, cf. ecritParLePrerendu) et qu'aucune page de la configuration
 * n'attend. Récursif parce qu'un fragment vit dans un sous-dossier dès qu'une route est imbriquée
 * (`/a/b` → `a/b.html`) ou qu'une langue est déclarée — et parce qu'un dossier de langue retiré de la
 * configuration doit partir avec ses fragments.
 *
 * Tout le reste est intouchable : une autre extension, et surtout un `.html` SANS ligne-bandeau —
 * rien n'oblige `render.outDir` à être un dossier réservé au prérendu (dossier public partagé,
 * racine du projet), et un fichier écrit à la main n'appartient pas au build.
 *
 * Rend le nombre de fichiers retirés dans le sous-arbre et si le dossier est VIDE en sortie : son
 * appelant le retire alors, mais SEULEMENT s'il en a lui-même retiré quelque chose — un dossier déjà
 * vide à l'arrivée n'est pas de notre fait.
 */
function purgerFragments(dossier: string, attendus: Set<string>, log: (msg: string) => void): { retires: number; vide: boolean } {
  let retires = 0
  let restes  = 0
  for (const entree of readdirSync(dossier, { withFileTypes: true })) {
    const chemin = join(dossier, entree.name)
    if (entree.isDirectory()) {
      if (entree.name.startsWith('.') || HORS_BALAYAGE.has(entree.name)) { restes++; continue }
      const bilan = purgerFragments(chemin, attendus, log)
      retires += bilan.retires
      if (!bilan.vide || bilan.retires === 0) { restes++; continue }
      try {
        rmdirSync(chemin)
        log(`   🗑️  ${t('server.prerender-dossier-vide-retire', { dir: chemin })}`)
      } catch (e: any) {
        restes++
        log(`   ⚠️  ${t('server.prerender-echec-suppression', { file: chemin, err: e?.message || e })}`)
      }
      continue
    }
    if (!entree.isFile() || !entree.name.endsWith('.html') || attendus.has(chemin) || !ecritParLePrerendu(chemin)) { restes++; continue }
    try {
      unlinkSync(chemin)
      retires++
      log(`   🗑️  ${t('server.prerender-fragment-sans-route', { file: chemin })}`)
    } catch (e: any) {
      restes++
      log(`   ⚠️  ${t('server.prerender-echec-suppression', { file: chemin, err: e?.message || e })}`)
    }
  }
  return { retires, vide: restes === 0 }
}
