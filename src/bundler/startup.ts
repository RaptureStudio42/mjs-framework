// startup — ce que le HTML FIGÉ d'une page prérendue dit au navigateur de charger, AVANT que le
// manifeste (`bundle_modular.js`) n'ait été téléchargé puis exécuté.
//
// Le manifeste est le seul à savoir quels composants une page affiche : ils ne partent donc qu'après
// lui (son bloc `modulepreload`, cf. writeManifest()). Le fragment prérendu, lui, le sait dès sa
// CONSTRUCTION — c'est tout l'objet de ce module : réécrire le fragment pour qu'il porte lui-même ce
// que sa page démarre. Clé de configuration `render.startup` (cf. `RenderStartupMode`),
// surchargeable par route, qui ne concerne QUE les routes prérendues.
//
// ENSEMBLE DE DÉMARRAGE d'une page = les clés de `µ.paths` dont la balise `mjs-<clé>` est dans le
// HTML rendu (`PrerenderReport.generated[].tags`), FERMÉ par la table des dépendances directes
// (`µDeps`/`manifestDeps`, même marche que `µWalkDeps` du manifeste) : un enfant qu'un `{if}` faux
// n'a pas rendu est quand même dans l'ensemble (il s'affichera au premier clic sans aller-retour),
// et les modules `@import`-és par ces composants aussi. Les alias de balise sont des clés du
// manifeste comme les autres.
//
// FICHIER DE PAGE (`'bundle'`, construction de PRODUCTION seulement) : les COMPOSANTS de l'ensemble
// sont assemblés en un `mjs_page-<slug>-<empreinte>.js` (préfixe `mjs_` obligatoire, hors d'atteinte
// d'un nom de composant). Restent EXTERNES le cœur, les feuilles, les animations, les fichiers de
// langue, le manifeste externe — et les MODULES : un module doit rester une instance unique, un
// store singleton dupliqué dans le fichier de page casserait l'état partagé. Les fichiers séparés
// existent toujours : une autre page les charge seuls, le rendu serveur les lit un par un.
//
// En DÉVELOPPEMENT, `'bundle'` se comporte comme `'preload'` (une ligne d'information au journal) :
// le rechargement à chaud et le cache des noms courts ne sont pas mêlés à un second assemblage.

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { build as esbuildBuild } from 'esbuild'
import type { Bundler } from './index.js'
import type { RenderConfig, RenderStartupMode } from './config.js'
import type { PrerenderReport } from '../server/prerender.js'
import { pickStartup, startupSlug } from '../server/render-routes.js'
import { t } from '../messages/index.js'

/** Nombre de composants en dessous duquel un fichier de page n'a rien à factoriser. */
const MIN_UNITS_PER_PAGE = 2

export interface StartupPage {
  /** URL de la route prérendue. */
  url: string
  /** Fragment réécrit (chemin absolu). */
  file: string
  /** Mode RÉSOLU, dégradation de développement comprise. */
  mode: RenderStartupMode
  /** Ensemble de démarrage (composants ET modules), trié. */
  names: string[]
  /** Hrefs posés en tête du fragment, dans l'ordre. */
  hrefs: string[]
  /** Chemin web du fichier de page, quand la page en a un. */
  pageFile?: string
}

export interface StartupReport {
  pages: StartupPage[]
  /** Fragments RÉELLEMENT réécrits (une réécriture sans changement est sautée). */
  written: number
  /** Chemins web des fichiers de page émis, triés. */
  pageFiles: string[]
}

export interface StartupOpts {
  /** Construction de production (`mjs build --prod`) : seule à assembler un fichier de page. */
  prod: boolean
  log?: (msg: string) => void
}

const byCodePoint = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

/** Clé RÉELLE du manifeste par nom en minuscules — mêmes règles de résolution que
 *  buildManifestDeps() (les balises du HTML sont minuscules, une clé peut ne pas l'être). */
function manifestKeysByLower(bundler: Bundler): Map<string, string> {
  const table = new Map<string, string>()
  for (const key of Object.keys(bundler.manifest)) {
    if (key === '__animations' || key === '__styles' || key === '__external') continue
    table.set(key.toLowerCase(), key)
  }
  return table
}

/** Une clé du manifeste est-elle un COMPOSANT (`.mjs`) ? Sinon c'est un module autonome
 *  (`.civet`/`.coffee`/`.ts`), qui reste externe au fichier de page. Le registre
 *  `manifestSources` est rempli à CHAQUE compile, cache-hit compris. */
function isComponent(bundler: Bundler, name: string): boolean {
  return bundler.manifestSources.get(name)?.endsWith('.mjs') ?? false
}

/** Ensemble de démarrage : les balises du HTML résolues en clés de manifeste, fermées par
 *  `manifestDeps`. Une dépendance que le manifeste ne publie pas (alias empoisonné, cible en
 *  échec) n'est jamais suivie — même prudence que µWalkDeps côté navigateur. */
function startupSet(bundler: Bundler, tags: string[], keys: Map<string, string>): string[] {
  const vus = new Set<string>()
  const walk = (name: string): void => {
    if (vus.has(name)) return
    vus.add(name)
    for (const dep of bundler.manifestDeps[name] ?? []) {
      if (bundler.manifest[dep]) walk(dep)
    }
  }
  for (const tag of tags) {
    const real = keys.get(tag.slice(4))
    if (real && bundler.manifest[real]) walk(real)
  }
  return [...vus].sort(byCodePoint)
}

/**
 * Ordre d'import des composants dans le fichier de page : ENFANTS AVANT PARENTS (post-ordre DFS sur
 * `manifestDeps`, départ trié). Un parent se définit après ses enfants — l'upgrade d'un élément déjà
 * présent dans la page (prérendu) trouve alors ses enfants déjà définis. Même règle que
 * `bundleUnitOrder()` du mode `js: 'bundle'`, restreinte ici à l'ensemble de la page.
 */
function childrenFirst(bundler: Bundler, names: string[]): string[] {
  const dans  = new Set(names)
  const ordre: string[] = []
  const fait  = new Set<string>()
  const encours = new Set<string>()
  const visit = (name: string): void => {
    if (fait.has(name) || encours.has(name)) return   // déjà placé, ou cycle : jamais revisité
    encours.add(name)
    for (const dep of [...(bundler.manifestDeps[name] ?? [])].sort(byCodePoint)) {
      if (dans.has(dep)) visit(dep)
    }
    encours.delete(name)
    fait.add(name)
    ordre.push(name)
  }
  for (const name of [...names].sort(byCodePoint)) visit(name)
  return ordre
}

/** `<link rel="modulepreload">` d'un href. */
function lien(href: string): string {
  return `<link rel="modulepreload" href="${href}">`
}

/**
 * Assemble les COMPOSANTS `files` (basenames dans `outputDir`) en un seul module ES.
 *
 * Tout ce qu'un composant importe et qui n'est pas de l'ensemble reste EXTERNE, chemin INCHANGÉ
 * (cœur, feuilles partagées, animations, fichiers de langue, manifeste externe, modules) : ce sont
 * des chemins web absolus (`<urlPrefix>/<base>-<empreinte>.js`, cf. placeholderPath()) qu'esbuild
 * chercherait sinon sur le disque. Le fichier de page vit dans le MÊME dossier que les composants
 * qu'il assemble : leur `new URL('.', import.meta.url)` (dossier du module, lu par le runtime pour
 * les satellites CSS) continue de désigner le bon dossier.
 *
 * NI `mangleProps` NI `mangleCache` : les fichiers séparés sont déjà raccourcis, l'assemblage ne
 * renomme rien — un second mangle sur un code déjà mangé n'aurait aucun cache commun avec le
 * premier.
 */
async function bundlePage(bundler: Bundler, files: string[]): Promise<{ code: string; map?: string }> {
  const inline = new Set(files)
  const entree = files.map(f => `import './${f}';`).join('\n')
  const plugin = {
    name: 'mjs-page-externals',
    setup: (b: any) => {
      b.onResolve({ filter: /.*/ }, (args: any) => {
        if (args.kind === 'entry-point') return null
        const base = basename(args.path)
        if (inline.has(base)) return { path: join(bundler.outputDir, base), namespace: 'file' }
        return { path: args.path, external: true }
      })
    },
  }
  const result = await esbuildBuild({
    stdin: { contents: entree, resolveDir: bundler.outputDir, sourcefile: 'mjs_page.js', loader: 'js' },
    absWorkingDir: bundler.outputDir,
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    // même raison que le manifeste assemblé (cf. runBundleEsbuild) : sans `charset`, esbuild
    // échapperait tout non-ASCII en `\uXXXX`, le sigil `µ` compris.
    charset: 'utf8',
    minify: bundler.shouldMinify(),
    treeShaking: true,
    keepNames: false,
    legalComments: 'none',
    sourcemap: bundler.shouldEmitSourceMap() ? 'external' : false,
    logLevel: 'silent',
    plugins: [plugin],
  })
  const js  = result.outputFiles!.find(f => f.path.endsWith('.js')) ?? result.outputFiles![0]
  const map = result.outputFiles!.find(f => f.path.endsWith('.map'))
  return { code: js.text, map: map?.text }
}

// LIGNES-REPÈRES de l'en-tête de démarrage : elles bornent, juste sous la ligne-bandeau, la zone
// que CE module possède dans un fragment — tout le reste est le CORPS, écrit par le prérendu.
// Définies ici, lues aux deux endroits : `stripStartupHeader()` ci-dessous sert à `emitStartup`
// (rester idempotente : deux passes n'empilent pas l'en-tête, un fragment qui portait celui d'un
// mode précédent le perd) ET au prérendu, qui compare le corps qu'il vient de rendre au corps déjà
// sur disque pour ne pas réécrire un fragment inchangé (cf. server/prerender.ts).
export const STARTUP_HEADER_OPEN  = '<!-- mjs:demarrage -->'
export const STARTUP_HEADER_CLOSE = '<!-- /mjs:demarrage -->'

/**
 * Retire d'un fragment son en-tête de démarrage : la zone bornée par les deux lignes-repères, juste
 * après la ligne-bandeau. Position EXIGÉE (jamais un repère cherché n'importe où dans la page : une
 * page de doc pourrait en citer un) ; en-tête absent, ou ouvert sans être fermé : contenu rendu tel
 * quel, jamais de découpe au hasard.
 */
export function stripStartupHeader(contenu: string): string {
  const coupe = contenu.indexOf('\n')
  if (coupe < 0) return contenu
  const debut = coupe + 1
  if (!contenu.startsWith(`${STARTUP_HEADER_OPEN}\n`, debut)) return contenu
  const fin = contenu.indexOf(`${STARTUP_HEADER_CLOSE}\n`, debut)
  if (fin < 0) return contenu
  return contenu.slice(0, debut) + contenu.slice(fin + STARTUP_HEADER_CLOSE.length + 1)
}

/**
 * Réécrit le fragment : bandeau (première ligne, inchangée) + en-tête de démarrage borné par ses
 * lignes-repères + corps tel quel. En-tête VIDE (mode `'none'`) : le fragment perd le sien, sans
 * rien d'autre à la place. Écriture SAUTÉE si le contenu est identique (jamais de `touch` inutile,
 * comme writeManifest()).
 */
function rewriteFragment(file: string, entete: string[]): boolean {
  const actuel  = readFileSync(file, 'utf-8')
  const nu      = stripStartupHeader(actuel)
  const coupe   = nu.indexOf('\n')
  const bandeau = coupe < 0 ? nu : nu.slice(0, coupe + 1)
  const corps   = coupe < 0 ? '' : nu.slice(coupe + 1)
  const lignes  = entete.length > 0 ? [STARTUP_HEADER_OPEN, ...entete, STARTUP_HEADER_CLOSE] : []
  const nouveau = bandeau + lignes.map(l => `${l}\n`).join('') + corps
  if (nouveau === actuel) return false
  writeFileSync(file, nouveau, 'utf-8')
  return true
}

/**
 * Émet l'en-tête de démarrage de chaque page prérendue, et son fichier de page quand elle en
 * demande un. Appelée APRÈS `prerenderPages` (qui vient d'écrire les fragments) et après le
 * `compile()` du `bundler` passé — c'est de SON manifeste que viennent les chemins hachés.
 */
export async function emitStartup(
  bundler: Bundler,
  render: RenderConfig | undefined,
  report: PrerenderReport,
  opts: StartupOpts,
): Promise<StartupReport> {
  const log    = opts.log ?? (() => {})
  const sortie: StartupReport = { pages: [], written: 0, pageFiles: [] }
  if (!render || report.generated.length === 0) return sortie

  const toutes = report.generated.map(page => ({ page, mode: pickStartup(render, page.url) }))
  // `'none'` : le fragment ne reçoit rien — et PERD l'en-tête qu'un mode précédent lui avait posé
  // (le prérendu ne réécrit plus un corps inchangé, cf. server/prerender.ts : sans ce retrait, un
  // en-tête périmé survivrait à la bascule de mode).
  for (const { page } of toutes.filter(d => d.mode === 'none')) {
    if (rewriteFragment(page.file, [])) sortie.written++
  }
  // Projet à FICHIER UNIQUE (`js: 'bundle'`) : il n'y a rien à démarrer page par page — le fichier
  // que la coquille charge déjà porte le cœur ET tous les composants, et les clés de son manifeste
  // désignent des modules VIRTUELS (`mjs:unit/<stem>`, résolus en mémoire pendant la fusion),
  // qu'aucun navigateur ne sait aller chercher. Le fragment ne reçoit donc aucun en-tête, et perd
  // celui qu'un build antérieur (dans un autre mode d'émission) lui aurait posé.
  if (bundler.jsMode === 'bundle') {
    for (const { page } of toutes) { if (rewriteFragment(page.file, [])) sortie.written++ }
    log(t('bundler.startup.fichier-unique'))
    return sortie
  }
  const demandes = toutes.filter(d => d.mode !== 'none')
  if (demandes.length === 0) return sortie

  // `'bundle'` demandé hors production : dégradé en préchargement, jamais en silence.
  if (!opts.prod && demandes.some(d => d.mode === 'bundle')) log(t('bundler.startup.bundle-hors-production'))

  const keys = manifestKeysByLower(bundler)
  const { prefix, compact } = bundler.pathsCompaction()
  // forme des valeurs de `µ.paths` : basename seul quand le manifeste factorise son préfixe,
  // chemin entier sinon — la fiche `__mjs_page` doit poser EXACTEMENT la même (cf. Autoloader).
  const pathsForm = (href: string): string => compact ? href.slice(prefix.length) : href

  const plans = demandes.map(({ page, mode }) => {
    const names = startupSet(bundler, page.tags, keys)
    return {
      page,
      mode,
      names,
      // `slug` : dérivé de l'URL DE LA ROUTE (cf. startupSlug), jamais du nom du fragment — deux
      // routes de basename identique (`/` et `/a/index`) auraient sinon partagé un seul fichier de
      // page. Les langues d'une même route, elles, ont la même URL et partagent donc bien leur
      // fichier : l'ensemble assemblé est l'UNION de leurs composants, chaque fragment ne déclarant
      // que les siens dans sa fiche.
      slug: startupSlug(page.url),
      components: names.filter(n => isComponent(bundler, n)),
      modules: names.filter(n => !isComponent(bundler, n)),
    }
  })

  // un fichier de page par SLUG (jamais un par langue : deux fragments de même slug pointeraient
  // deux hachés du même nom de base, dont writeHashed() ne garderait que le dernier)
  const assembles = new Map<string, string>()
  if (opts.prod) {
    const parSlug = new Map<string, Set<string>>()
    for (const plan of plans) {
      if (plan.mode !== 'bundle' || plan.components.length < MIN_UNITS_PER_PAGE) continue
      const union = parSlug.get(plan.slug) ?? new Set<string>()
      for (const name of plan.components) union.add(name)
      parSlug.set(plan.slug, union)
    }
    for (const slug of [...parSlug.keys()].sort(byCodePoint)) {
      const noms  = [...parSlug.get(slug)!]
      const files = [...new Set(childrenFirst(bundler, noms).map(n => basename(bundler.manifest[n])))]
      let code: string
      let map: string | undefined
      try {
        ({ code, map } = await bundlePage(bundler, files))
      } catch (e: any) {
        throw new Error(t('bundler.startup.echec', { page: slug, raison: e?.message ?? String(e) }))
      }
      const href = bundler.writeHashed(`mjs_page-${slug}`, '.js', code, map)
      assembles.set(slug, href)
      sortie.pageFiles.push(href)
      log(t('bundler.startup.fichier-de-page', { page: slug, fichier: basename(href), nb: noms.length }))
    }
    sortie.pageFiles.sort(byCodePoint)
  }

  for (const plan of plans) {
    const pageFile = plan.mode === 'bundle' ? assembles.get(plan.slug) : undefined
    // `'bundle'` servi : le fichier de page + les modules de la fermeture (restés externes).
    // Sinon : une unité, un lien — composants ET modules. DÉDOUBLONNÉ par chemin : deux clés du
    // manifeste peuvent nommer le MÊME fichier (alias de dossier, cf. shortModuleName), un fichier
    // n'a besoin que d'un lien.
    const hrefs = [...new Set(pageFile
      ? [pageFile, ...plan.modules.map(n => bundler.manifest[n])]
      : plan.names.map(n => bundler.manifest[n]))]
    const entete = hrefs.map(lien)
    if (pageFile) {
      const fiche = { file: pathsForm(pageFile), names: plan.components }
      entete.push(`<script type="application/json" id="__mjs_page">${JSON.stringify(fiche)}</script>`)
    }
    if (rewriteFragment(plan.page.file, entete)) sortie.written++
    sortie.pages.push({ url: plan.page.url, file: plan.page.file, mode: plan.mode, names: plan.names, hrefs, ...(pageFile ? { pageFile } : {}) })
  }

  // anciens fichiers de page hachés : supprimés seulement maintenant, les fragments réécrits
  // nommant déjà les nouveaux (même discipline que writeManifest → flushPendingHashCleanup)
  bundler.flushPendingHashCleanup()
  // la liste des sorties du build (`mjs-precache.json`, écrite en fin de compile()) est ANTÉRIEURE
  // aux fichiers de page : republiée ici pour les y faire entrer — un service worker qui la lit
  // mettrait sinon en cache tout le site SAUF le fichier que ses pages d'entrée démarrent.
  if (sortie.pageFiles.length > 0) bundler.writePrecacheManifest()
  return sortie
}
