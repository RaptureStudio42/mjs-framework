// cli — entrypoint exécutable. Branché par bin/mjs.

import { join, resolve, relative, dirname, extname, basename } from 'node:path'
import { existsSync, readdirSync, readFileSync, statSync, realpathSync, accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { Bundler, type CompileStats } from './bundler/index.js'
import { StaticServer } from './server/index.js'
import { findConfig, resolveBundlerOpts } from './bundler/config.js'
import { runInit } from './cli/init.js'
import { runWsCommand } from './cli/ws.js'
import { runServeurCommand } from './cli/server.js'
import { acquireDevLock } from './cli/dev-lock.js'
import { prerenderPages } from './server/prerender.js'
import { emitStartup } from './bundler/startup.js'
import { prerenderOnDevRecompile } from './cli/dev-prerender.js'
import { startRenderServer } from './server/render-server.js'
import { createRenderHandler } from './server/render-request.js'
import { createJournal, type RecordServerFn } from './server/journal.js'
import { createServeEntry } from './server/serve-entry.js'
import { readBuildVersion } from './server/build-version.js'
import { t } from './messages/index.js'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// hasComponents — y a-t-il au moins un `.mjs` sous `dir` ? Sert à la seule garde du build :
// aucun composant veut dire qu'il n'y a RIEN à construire, et un build qui n'a rien construit
// ne doit pas écrire un manifeste vide par-dessus celui d'un site en place.
// MÊME PARCOURS que `Bundler.findFiles` (bundler/index.ts) — `statSync` et non le `Dirent`,
// donc les liens symboliques sont SUIVIS, et `realpathSync` ferme les cycles : avec un
// `isDirectory()` de Dirent, un dossier de composants atteint par un lien était compté zéro,
// et la garde refusait un projet parfaitement valide que le bundler, lui, aurait construit
// (trouvé en testant).
function hasComponents(dir: string): boolean {
  const pile        = [dir]
  const dossiersVus = new Set<string>()
  while (pile.length > 0) {
    const courant = pile.pop()!
    let reel: string
    try { reel = realpathSync(courant) } catch { continue }   // lien cassé — cette branche seulement
    if (dossiersVus.has(reel)) continue
    dossiersVus.add(reel)
    for (const nom of readdirSync(courant)) {
      if (nom.startsWith('.') || nom === 'node_modules') continue
      const chemin = join(courant, nom)
      let st
      try { st = statSync(chemin) } catch { continue }
      if (st.isDirectory()) pile.push(chemin)
      // MÊME EXCLUSION que le bundler (`!basename(f, '.mjs').startsWith('_')`) : un partial
      // `_entete.mjs` n'est PAS un composant, seulement du contenu à inclure. Les compter faisait
      // passer la garde à un dossier qui n'en contient que — et rendait exactement le sinistre
      // qu'elle existe pour empêcher : « ✅ 2 fichiers écrits », code 0, `µ.paths = {}`.
      else if (nom.endsWith('.mjs') && !nom.startsWith('_') && st.size > 0) return true
    }
  }
  return false
}

// readI18nLanguages — langues RÉELLEMENT présentes sous `i18nDir`, UN dictionnaire
// VIDE reste PRÉSENT dans la liste mais sous un libellé distinct « <langue> (vide) » : un
// fichier racine `<langue>.{yml,yaml,json}` OU un sous-dossier `<langue>/` (sections), MÊME
// convention que scanI18n (bundler/index.ts) — AUPARAVANT, seule la PRÉSENCE comptait : un `fr.yml`
// VIDE (0 octet, ou `{}`) avec `i18n.default: 'fr'` comptait `fr` « trouvée » (sous son vrai nom),
// taisant l'avertissement juste après (`langues.includes(i18n.default)` vrai). Retirer purement
// l'entrée aurait cassé le garde-fou JUMEAU du même appelant (cli.ts, GARDE i18n.default) qui reste
// SILENCIEUX quand `langues.length === 0` (« aucun dictionnaire encore écrit ») : un dossier i18n/
// qui ne contient QUE ce fichier vide se serait alors retrouvé, à tort, dans ce cas-là. Le suffixe
// garde `langues.length` correct (le dossier N'EST PAS vide) tout en faisant échouer
// `langues.includes(default)` pour la langue vide (jamais égale à son propre libellé suffixé) —
// et se lit tel quel dans le message d'avertissement (`langues présentes : fr (vide)`). Un
// sous-dossier de sections garde son ancien comportement (présence seule, hors périmètre).
function readI18nLanguages(i18nDir: string): string[] {
  const langs = new Set<string>()
  for (const entry of readdirSync(i18nDir)) {
    let st
    try { st = statSync(join(i18nDir, entry)) } catch { continue }
    if (st.isFile()) {
      const ext = extname(entry)
      if (ext !== '.yml' && ext !== '.yaml' && ext !== '.json') continue
      const lang = basename(entry, ext)
      langs.add(isEmptyI18nDict(join(i18nDir, entry), ext) ? `${lang} (vide)` : lang)
    } else if (st.isDirectory()) {
      langs.add(entry)
    }
  }
  return Array.from(langs)
}

// isEmptyI18nDict — mêmes formats que le bundler (YAML via le paquet
// OPTIONNEL `yaml`, JSON via JSON.parse, cf. parseI18nFile/scanI18n, bundler/index.ts). Lecture ou
// parse en échec : reste PERMISSIF (pas « vide », donc pas de faux avertissement) — cette garde
// n'est qu'un avertissement, le VRAI échec de parsing remonte, lui, au build réel avec son détail.
function isEmptyI18nDict(path: string, ext: string): boolean {
  let raw: string
  try { raw = readFileSync(path, 'utf-8') } catch { return false }
  if (raw.trim() === '') return true
  try {
    const parsed = ext === '.json' ? JSON.parse(raw) : createRequire(import.meta.url)('yaml').parse(raw)
    return parsed === null || parsed === undefined || (typeof parsed === 'object' && Object.keys(parsed).length === 0)
  } catch {
    return false
  }
}

// FS_ERROR_CODES — codes d'erreur Node dont le SENS est connu et vaut la peine d'être nommé au
// dev (ENOTDIR/EISDIR ajoutés) : au-delà de ceux-ci, une erreur vraiment
// inattendue garde sa trace complète (console.error('❌', e), comportement historique) — jamais
// moins d'information. ENOTDIR/EISDIR : défense en profondeur pour un `--output`/`--manifest` qui
// échapperait encore à `checkWritablePath` ci-dessous (ex. devient un fichier/dossier ENTRE la
// vérification et l'écriture réelle, TOCTOU) — le cas COURANT (`--output` = fichier existant) est
// désormais intercepté AVANT toute compilation, cf. `checkWritablePath`.
const FS_ERROR_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'ENOSPC', 'ENOTDIR', 'EISDIR'])

// checkWritablePath — `--output`/`--manifest` acceptent n'importe quel
// chemin (usage légitime, cf. cli-build-prerender-overrides.test.ts — un déploiement peut
// rediriger la sortie hors du projet) ; mais un EACCES en écriture tombait tout en bas du
// fichier, stack Node BRUTE, seule exception du catalogue. Remonte au plus proche ANCÊTRE
// EXISTANT de `target` (le reste sera créé par mkdirSync récursif) et vérifie qu'il est
// accessible en écriture — message catalogue nommé AVANT de lancer la moindre compilation.
// `mustBeDir` : `--output` DOIT être un dossier ou ne pas
// exister (mkdirSync le crée) — un `--output` pointant vers un FICHIER existant passait
// `accessSync` (le fichier EST accessible en écriture) et n'échouait que plus tard, en pleine
// compilation (`ENOTDIR` au premier `readdirSync` dedans), stack Node brute. `--manifest`, lui,
// DÉSIGNE normalement un fichier — active `mustBeFile` : la
// contrainte SYMÉTRIQUE, un dossier déjà présent à cet emplacement n'échouait, lui, qu'en PLEINE
// compilation (`EISDIR` au premier `readFileSync`/`writeFileSync` du manifeste), stack Node brute,
// une partie de `outputDir` déjà écrite au moment du plantage.
function checkWritablePath(target: string, cle: string, mustBeDir = false, mustBeFile = false): void {
  const resolved = resolve(target)
  if (mustBeDir && existsSync(resolved) && !statSync(resolved).isDirectory()) {
    console.error(t('cli.output-doit-etre-dossier', { cle, chemin: resolved }))
    process.exit(1)
  }
  if (mustBeFile && existsSync(resolved) && statSync(resolved).isDirectory()) {
    console.error(t('cli.manifest-doit-etre-fichier', { cle, chemin: resolved }))
    process.exit(1)
  }
  let ancestor = resolved
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) break   // racine du système atteinte, jamais de boucle infinie
    ancestor = parent
  }
  try {
    accessSync(ancestor, constants.W_OK)
  } catch (e: any) {
    console.error(t('cli.chemin-non-inscriptible', { cle, chemin: target, ancetre: ancestor, erreur: e?.message || e }))
    process.exit(1)
  }
}

function printBuildReport(stats: CompileStats): void {
  // Un build avec des erreurs affichait QUAND MÊME la ligne ✅ juste
  // en dessous (rien ne distinguait « succès » de « succès partiel, N cassés
  // repêchés » au premier coup d'œil) : la ligne d'échec passe maintenant
  // AVANT, toujours visible même si stats.sizes est vide.
  if (stats.errors.length > 0) console.log(t('cli.build-rapport-echecs', { nb: stats.errors.length }))
  console.log(t('cli.build-rapport', { nb: stats.written, ms: stats.durationMs }))
  if (stats.sizes.length === 0) return

  // Top 10 par taille (le bundle, le runtime, les composants les plus gros)
  console.log(``)
  const top = stats.sizes.slice(0, 10)
  const maxName = Math.max(...top.map(s => s.name.length))
  for (const s of top) {
    console.log(`   ${s.name.padEnd(maxName)}  ${fmtBytes(s.bytes).padStart(8)}`)
  }
  if (stats.sizes.length > 10) {
    const rest = stats.sizes.slice(10)
    const restBytes = rest.reduce((a, b) => a + b.bytes, 0)
    const label = t('cli.plus-n-autres', { nb: rest.length })
    console.log(`   ${label.padEnd(maxName)}  ${fmtBytes(restBytes).padStart(8)}`)
  }
  const total = stats.sizes.reduce((a, b) => a + b.bytes, 0)
  console.log(`   ${'─'.repeat(maxName + 10)}`)
  console.log(`   ${'TOTAL'.padEnd(maxName)}  ${fmtBytes(total).padStart(8)}`)
}

const USAGE = t('cli.usage')

interface Args {
  command: 'init' | 'build' | 'dev' | 'check' | 'serve' | 'ws' | 'serveur'
  root: string
  manifest?: string
  output?: string
  port?: number
  /** --host : hôte pour `mjs ws` et `mjs serveur` — cf. WsCommandArgs.host,
   *  cli/ws.ts et ServeurCommandArgs.host, cli/server.ts */
  host?: string
  entry?: string
  help?: boolean
  /** `--dev`/`--prod` : l'environnement du build. Absent ⇒ développement. */
  env?: 'dev' | 'prod'
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'build', root: process.cwd() }
  let i = 0
  // Récupère la valeur SUIVANT un flag en validant qu'elle existe et n'est pas
  // elle-même un flag. Sans ça, `--port` sans valeur → parseInt(undefined)=NaN
  // → listen(NaN) ; `--output --port 3000` mangeait `--port` comme valeur.
  const value = (flag: string): string | undefined => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('-')) {
      console.warn(t('cli.flag-valeur-manquante', { flag }))
      return undefined
    }
    i++ // consomme la valeur
    return v
  }
  while (i < argv.length) {
    const a = argv[i]
    if (a === 'init' || a === 'build' || a === 'dev' || a === 'check' || a === 'serve' || a === 'ws' || a === 'serveur') {
      args.command = a
    } else if (a === '--root') {
      const v = value('--root'); if (v !== undefined) args.root = v
    } else if (a === '--manifest') {
      const v = value('--manifest'); if (v !== undefined) args.manifest = v
    } else if (a === '--output') {
      const v = value('--output'); if (v !== undefined) args.output = v
    } else if (a === '--entry') {
      const v = value('--entry'); if (v !== undefined) args.entry = v
    } else if (a === '--port') {
      const v = value('--port')
      if (v !== undefined) {
        const p = parseInt(v, 10)
        if (Number.isFinite(p)) args.port = p
        else console.warn(t('cli.port-invalide', { valeur: v }))
      }
    } else if (a === '--host') {
      // hôte, pour `mjs ws` et `mjs serveur` — les autres commandes ignorent args.host
      const v = value('--host'); if (v !== undefined) args.host = v
    } else if (a === '--once') {
      args.command = 'build'
    } else if (a === '--dev') {
      args.env = 'dev'
    } else if (a === '--prod') {
      args.env = 'prod'
    } else if (a === '-h' || a === '--help') {
      args.help = true
    } else {
      // Tout argument non reconnu
      // (flag inconnu type `--minify`/`--otuput` typo, ou mot-clé de
      // commande mal orthographié) était silencieusement IGNORÉ, sans le
      // moindre warning : un flag tapé de travers n'a jamais d'effet, et
      // rien ne le signale — le dev le découvre bien plus tard en
      // constatant que l'option attendue n'a "pour une raison inconnue"
      // pas été appliquée.
      console.warn(
        a.startsWith('-')
          ? t('cli.flag-inconnu', { arg: a })
          : t('cli.argument-non-reconnu', { arg: a }),
      )
    }
    i++
  }
  return args
}

async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(USAGE)
    process.exit(0)
  }

  if (args.root) process.chdir(args.root)

  // `mjs init` : scaffolding — n'a pas besoin de config.
  if (args.command === 'init') {
    runInit(process.cwd())
    return
  }

  // mjs.config.json : si présent, fournit les défauts ; les flags CLI override.
  const found = findConfig()
  const cfgOpts: ReturnType<typeof resolveBundlerOpts> = found
    ? resolveBundlerOpts(found.config, found.configDir)
    // Littéral de repli désynchronisé du
    // type réel de resolveBundlerOpts() : `contextAlias`/`preload`/`runtimeDir`/
    // `urlPrefix` manquaient (ajoutés à MjsConfig après ce littéral), faisant
    // échouer `tsc --noEmit` (erreur pré-existante, découverte en écrivant
    // ce commentaire — pas un crash runtime, mjs.config.json absent est un cas
    // fréquent en dev).
    // `css` (bundle / split / lazy) et `js` (split / bundle) ajoutées à
    // resolveBundlerOpts() (bundler/config.ts) : même piège structurel que le reste de ce
    // littéral (cf. commentaire ci-dessus).
    // `render` (bloc des pages, lu par le bundler pour le seul module d'hydratation) : idem.
    : { sourceDir: undefined, outputDir: undefined, manifestPath: undefined, manifestExternal: undefined, stylesheetsDir: undefined, runtimeDir: undefined, urlPrefix: undefined, defaultScriptLang: undefined, templateLang: undefined, sigil: undefined, contextAlias: undefined, varPrefix: undefined, defaultTheme: undefined, preload: undefined, viewTransition: undefined, logLevel: undefined, maxStateVars: undefined, a11y: undefined, ujsForm: undefined, image: undefined, minify: 'auto' as const, devPort: undefined, devHost: undefined, runtime: undefined, css: undefined, js: undefined, csp: undefined, sourceMap: undefined, i18n: undefined, render: undefined }
  if (found) {
    console.log(t('cli.config-trouve', { dossier: found.configDir }))
  }

  // GARDE ANTI-BOURDE — `mjs build` lancé DEPUIS LE MAUVAIS
  // DOSSIER (ou visant une racine sans sources) construisait un projet VIDE en annonçant
  // « ✅ 2 fichiers écrits », code de sortie 0 : le manifeste du site servi se retrouvait
  // remplacé par un `µ.paths = {}`, plus un seul composant connu, page blanche — et un
  // script de déploiement qui enchaîne sur `rsync` n'avait rien pour s'arrêter. C'est la
  // garde muette appliquée à un build : « je n'ai rien trouvé à construire » est
  // indiscernable de « tout va bien ». On refuse AVANT d'écrire quoi que ce soit, jamais
  // un avertissement. Deux cas, jamais confondus dans le message : plus rien du projet
  // sous la racine, ou un dossier source bel et bien là mais sans le moindre composant.
  if (args.command === 'build' || args.command === 'check' || args.command === 'dev') {
    const sourceDir = cfgOpts.sourceDir ?? resolve(process.cwd(), 'app/modularjs')
    // le dossier source n'est pas là — quelle que soit la présence d'un mjs.config.json.
    // La première écriture de cette garde ne couvrait QUE l'absence de config : une config
    // présente dont le `sourceDir` avait été renommé rejouait le sinistre à l'identique,
    // « ✅ 2 fichiers écrits », code 0, manifeste écrasé (même sinistre, vérifié en testant).
    if (!existsSync(sourceDir)) {
      console.error(t('cli.build-racine-vide', { commande: args.command, racine: process.cwd(), source: sourceDir, origine: t(cfgOpts.sourceDir ? 'cli.source-origine-config' : 'cli.source-origine-defaut') }))
      process.exit(1)
    }
    // `mjs dev` reste tolérant au dossier VIDE : on lance couramment le watcher avant
    // d'écrire son premier composant. `build` et `check`, eux, écrivent pour de bon.
    if (args.command !== 'dev' && !hasComponents(sourceDir)) {
      console.error(t('cli.build-aucun-composant', { commande: args.command, source: sourceDir }))
      process.exit(1)
    }
  }

  // GARDE i18n.default — `bundler/config.ts` vérifie que `i18n.default` est
  // une chaîne non vide, mais JAMAIS qu'elle désigne un dictionnaire RÉEL sous sourceDir/i18n/ :
  // un défaut sans fichier compile en silence, traductions absentes pour qui atterrit dessus.
  // Avertissement SEUL (pas une erreur) : un projet sans AUCUN dictionnaire encore écrit reste
  // silencieux — seul un dossier i18n/ PEUPLÉ dont `default` est absent des langues trouvées avertit.
  if (args.command === 'build' && found?.config.i18n?.default) {
    const sourceDir = cfgOpts.sourceDir ?? resolve(process.cwd(), 'app/modularjs')
    const i18nDir = join(sourceDir, 'i18n')
    if (existsSync(i18nDir)) {
      const langues = readI18nLanguages(i18nDir)
      if (langues.length > 0 && !langues.includes(found.config.i18n.default)) {
        console.warn(t('cli.i18n-default-sans-dictionnaire', { defaut: found.config.i18n.default, langues: langues.join(', ') }))
      }
    }
  }

  // ENVIRONNEMENT du build — la COMMANDE le dit, et rien d'autre : `mjs build` construit en
  // développement, `mjs build --prod` en production. Ni fichier de config, ni NODE_ENV : une
  // variable d'ambiance qui traîne dans un shell (ou un fichier versionné parti sur un serveur)
  // ne doit pas changer ce que produit un build sur la machine de qui le lance.
  const envBuild: 'dev' | 'prod' = args.env ?? 'dev'

  // Bandeau d'environnement — un build qui se trompe de mode ne se voit AUTREMENT nulle part
  // (le manifeste dit `dev:`, mais personne ne l'ouvre). Écrit tel quel dans le journal de
  // déploiement : un `mjs build` lancé sans `--prod` y annonce « DÉVELOPPEMENT ».
  if (args.command === 'build' || args.command === 'check' || args.command === 'dev' || args.command === 'serve') {
    const origine = args.env ? t('cli.env-origine-flag') : t('cli.env-origine-defaut')
    console.log(t(envBuild === 'prod' ? 'cli.env-prod' : 'cli.env-dev', { origine }))
  }

  const bundler = new Bundler({
    sourceDir:         cfgOpts.sourceDir,
    outputDir:         args.output ?? cfgOpts.outputDir,
    manifestPath:      args.manifest ?? cfgOpts.manifestPath,
    manifestExternal:  cfgOpts.manifestExternal,
    stylesheetsDir:    cfgOpts.stylesheetsDir,
    // Même bug que contextAlias
    // ci-dessous : runtimeDir/urlPrefix étaient résolus par
    // resolveBundlerOpts() mais jamais transmis ici.
    runtimeDir:        cfgOpts.runtimeDir,
    urlPrefix:         cfgOpts.urlPrefix,
    defaultScriptLang: cfgOpts.defaultScriptLang,
    // Grammaire interpolations/handlers — même
    // piège que contextAlias/maxStateVars ci-dessus si on oublie de la
    // transmettre ici : resolveBundlerOpts() la résout mais serait sinon MORTE.
    templateLang:      cfgOpts.templateLang,
    sigil:             cfgOpts.sigil,
    // contextAlias était validé par
    // resolveBundlerOpts() (mjs.config.json → cfgOpts.contextAlias) mais
    // jamais transmis ICI au Bundler — option totalement MORTE en CLI : un
    // projet qui configure `contextAlias: true` dans mjs.config.json pour
    // utiliser `mjs.X` au lieu de `µ.X` continuait à générer `__context`/
    // `__shared` avec l'alias par défaut, sans AUCUNE erreur (silencieux).
    contextAlias:      cfgOpts.contextAlias,
    preload:           cfgOpts.preload,
    viewTransition:    cfgOpts.viewTransition,
    // logLevel (mjs.config.json) : même piège que preload/viewTransition/contextAlias
    // ci-dessus si on oublie cette ligne — resolveBundlerOpts() la résout mais resterait
    // MORTE en CLI (µ._logLevel toujours au défaut, `pure` du minifieur jamais ajusté).
    logLevel:          cfgOpts.logLevel,
    // lint.maxStateVars (mjs.config.json) → seuil du warning « trop de vars
    // d'état » du transpiler — transmis ici, sinon option MORTE en CLI (même
    // piège que contextAlias/runtimeDir ci-dessus).
    maxStateVars:      cfgOpts.maxStateVars,
    // lint.a11y (mjs.config.json, défaut true) → même piège que maxStateVars
    // ci-dessus si non transmis ici : resolveBundlerOpts() la résout mais
    // resterait MORTE en CLI.
    a11y:              cfgOpts.a11y,
    // Un composant en échec ne garde son ANCIENNE sortie
    // référencée qu'en dev/serve, où le site doit rester utilisable le temps de corriger ; en
    // build, la version repêchée peut importer un cœur supprimé depuis (page morte, build vert)
    keepFailedComponents: args.command === 'dev' || args.command === 'serve',
    // Environnement du build : `--prod` ou rien (cf. Bundler.isProd). `minify` ne dit QUE la
    // minification — poser `"minify": true` ne fait pas basculer le projet en prod.
    env:               envBuild,
    minify:            cfgOpts.minify,
    // Tree-shake explicite du runtime (mjs.config.json → clé `runtime`) : même
    // piège que runtimeDir/contextAlias/maxStateVars ci-dessus — résolu par
    // resolveBundlerOpts() mais INERTE tant qu'il n'est pas transmis ici.
    runtime:           cfgOpts.runtime,
    // Stratégie de livraison des feuilles PARTAGÉES (mjs.config.json → clé `css`) : même
    // piège que runtime/contextAlias ci-dessus — validée par resolveBundlerOpts() mais
    // INERTE (le mode reste 'bundle' quoi qu'écrive le projet) tant qu'elle n'arrive pas ici.
    css:               cfgOpts.css,
    // Mode d'émission JS (mjs.config.json → clé `js`) : même piège que css/runtime
    // ci-dessus — validée par resolveBundlerOpts() mais INERTE (le mode resterait TOUJOURS
    // 'split' quoi qu'écrive le projet) tant qu'elle n'arrive pas ici.
    js:                cfgOpts.js,
    // `render` : lu par le bundler pour joindre le module d'hydratation selon les modes des
    // pages ; résolu par resolveBundlerOpts() mais mort sans cette ligne (même piège que `js`)
    render:            cfgOpts.render,
    // Mode strict CSP (mjs.config.json → clé `csp`) et émission des cartes de source
    // (clé `sourceMap`) : même piège que css/runtime/contextAlias ci-dessus — résolues
    // par resolveBundlerOpts() mais INERTES tant qu'elles n'arrivent pas ici.
    csp:               cfgOpts.csp,
    sourceMap:         cfgOpts.sourceMap,
    // image (mjs.config.json, défauts résolus au constructeur du Bundler) — même
    // piège que contextAlias/maxStateVars/css ci-dessus si on oublie la ligne
    image:             cfgOpts.image,
    // i18n façon Rails (mjs.config.json → clé `i18n`) : même piège que
    // runtime/contextAlias ci-dessus — résolu par resolveBundlerOpts() mais
    // INERTE (sourceDir/i18n/ jamais scanné) tant qu'il n'est pas transmis ici.
    i18n:              cfgOpts.i18n,
  })

  // GARDE ÉCRITURE — `--output`/`--manifest`/défauts config : chemin résolu et
  // vérifié (plus proche ancêtre EXISTANT accessible en écriture) AVANT toute compilation, pour
  // les 4 commandes qui écrivent réellement (cf. checkWritablePath ci-dessus pour le pourquoi).
  if (args.command === 'build' || args.command === 'check' || args.command === 'dev' || args.command === 'serve') {
    // `--output` ET `--manifest` sur le MÊME chemin résolu :
    // le manifeste écrase le dossier de sortie (ou l'inverse) en pleine compilation, laissant une
    // écriture PARTIELLE derrière une trace Node brute (EISDIR) — refusé AVANT toute compilation.
    if (resolve(bundler.outputDir) === resolve(bundler.manifestPath)) {
      console.error(t('cli.output-manifest-identiques', { chemin: resolve(bundler.outputDir) }))
      process.exit(1)
    }
    checkWritablePath(bundler.outputDir, 'outputDir', true)
    checkWritablePath(bundler.manifestPath, 'manifestPath', false, true)
  }

  switch (args.command) {
    case 'build': {
      const stats = await bundler.compile()
      printBuildReport(stats)
      for (const e of stats.errors) console.error('  ', e.message)
      if (stats.warnings.length > 0) {
        bundler.buildWarn(t('cli.avertissements-titre', { nb: stats.warnings.length }))
        for (const w of stats.warnings) bundler.buildWarn('   '+ w)
      }
      // Prérendu des pages déclarées (bloc `render`) — opt-in, seulement si la
      // compilation a réussi. Génère le HTML figé des routes `prerender` que le
      // back servira (le dev n'écrit aucun script de rendu).
      // UN PRÉRENDU QUI ÉCHOUE FAIT ÉCHOUER LE BUILD quand le projet a DÉCLARÉ des routes
      // à prérendre (`render.routes`) : avant, on se contentait d'un avertissement et `mjs build`
      // sortait en 0 — un déploiement enchaînait donc sur des pages MANQUANTES en croyant avoir
      // réussi (incident réel : trois sous-sites en 500). Sans `render.routes`,
      // rien n'est promis à personne : on garde l'avertissement seul.
      // Le `catch` ci-dessous ne couvrait QUE l'échec de
      // COMPILATION globale (prerenderPages() qui lève). Un échec de RENDU sur UNE SEULE page
      // (composant introuvable, exception…) est capturé PAR PAGE par prerenderPages elle-même
      // (report.skipped, `fatal: true`) SANS jamais lever — `prerenderFatal` restait `false`,
      // rejouant l'incident à l'identique sur une simple typo de composant. Couvert plus bas,
      // après la boucle qui affiche chaque page ignorée (`echecsRendu`).
      let prerenderFatal = false
      if (found?.config.render && stats.errors.length === 0) {
        try {
          console.log(t('cli.prerendu-debut'))
          // Garde-fou — `args.output`/
          // `args.manifest` (mêmes overrides que ceux appliqués au `bundler`
          // ci-dessus) DOIVENT être transmis ici : sans eux, `prerenderPages`
          // re-dérivait ses propres chemins depuis `mjs.config.json`,
          // ignorant un build redirigé — le prérendu recompilait puis
          // écrasait les fichiers du VRAI projet.
          // `env` transmis pour la MÊME raison que `outputDir`/`manifestPath` : ce prérendu
          // RECOMPILE dans le vrai dossier de sortie, par-dessus le build qu'on vient de faire.
          // Sans lui il retomberait sur son défaut (développement) et DÉFERAIT un `--prod` —
          // sortie non minifiée, manifeste `dev:true`, fragments i18n en clair.
          const report = await prerenderPages(found.config, found.configDir, m => console.log(m), {
            outputDir: args.output,
            manifestPath: args.manifest,
            env: envBuild,
          })
          if (report.generated.length) {
            console.log(t('cli.prerendu-resultat', { nb: report.generated.length, dossier: report.outDir }))
          }
          // Démarrage des pages prérendues (`render.startup`) : le fragment qui vient d'être écrit
          // reçoit ses propres liens de préchargement, et son fichier de page en production quand il
          // en demande un. APRÈS le prérendu (les fragments et le manifeste existent, le `bundler`
          // de ce build porte les chemins hachés), jamais avant.
          await emitStartup(bundler, found.config.render, report, { prod: envBuild === 'prod', log: m => console.log(m) })
          for (const s of report.skipped) console.log(t('cli.prerendu-page-ignoree', { url: s.url, raison: s.reason }))
          if (!report.generated.length && !report.skipped.length) {
            console.log(t('cli.prerendu-aucune-page'))
          }
          // Cf. commentaire au-dessus de `prerenderFatal` : un échec de RENDU par page
          // (jamais un skip VOULU comme route paramétrée/mode non buildable) fait échouer le build.
          const echecsRendu = report.skipped.filter(s => s.fatal)
          if (echecsRendu.length > 0) {
            prerenderFatal = true
            console.error(t('cli.prerendu-echec-fatal', { nb: echecsRendu.length }))
          }
        } catch (e: any) {
          console.warn(t('cli.prerendu-echec', { erreur: e?.message || e }))
          console.warn(t('cli.ssr-requiert-happy-dom'))
          prerenderFatal = Object.keys(found.config.render.routes ?? {}).length > 0
        }
      }
      // Purge des orphelins d'outputDir : DERNIER GESTE de la construction, seulement après un build
      // sans erreur (un build partiel garde tout, cf. recoverFailedComponentManifest) ET après le
      // prérendu et son en-tête de démarrage. Les fichiers de page (`mjs_page-…`) sont écrits par
      // `emitStartup`, donc APRÈS `compile()` : purger avant les aurait pris pour des orphelins (ils
      // n'appartiennent à aucune émission de compile()) et retirés au build suivant, juste avant que
      // le prérendu ne les réécrive — un dossier servi qui perd puis retrouve le fichier que ses
      // pages d'entrée démarrent. Prérendu qui échoue : rien n'est purgé (ce build ne sait plus ce
      // qu'il a émis) — les fichiers du précédent restent servis. Opt-out `"prune": false` dans
      // mjs.config.json. Jamais un sous-dossier (i18n/, mjs_pages/), jamais un nom stable — cf.
      // Bundler.pruneOrphans
      if (stats.errors.length === 0 && !prerenderFatal && found?.config.prune !== false) {
        const { removed, failed, skipped } = bundler.pruneOrphans()
        const dossierPurge = relative(process.cwd(), bundler.outputDir) || '.'
        if (removed.length > 0) {
          console.log(t('cli.build-purge', { nb: removed.length, dossier: dossierPurge }))
          const shown = removed.slice(0, 20)
          for (const f of shown) console.log(t('cli.build-purge-fichier', { fichier: f }))
          if (removed.length > shown.length) console.log(`   ${t('cli.plus-n-autres', { nb: removed.length - shown.length })}`)
        }
        for (const f of failed) bundler.buildWarn(t('cli.build-purge-echec', { fichier: f }))
        // Garde muette côté CLI : `skipped` n'était jamais
        // affiché, un registre illisible/vide ou un cache-hit sautait la purge SANS UN MOT (les
        // 4 autres raisons — errors/empty/no-core/no-dir — restent silencieuses, déjà couvertes
        // par ailleurs ou non actionnables par l'utilisateur).
        if (skipped === 'registry-unreadable') bundler.buildWarn(t('cli.build-purge-registre-illisible', { dossier: dossierPurge }))
        if (skipped === 'registry-empty') bundler.buildWarn(t('cli.build-purge-registre-vide', { dossier: dossierPurge }))
        if (skipped === 'cache') bundler.buildWarn(t('cli.build-purge-cache', { dossier: dossierPurge }))
      }
      // Termine le worker pool pour que Node puisse exit proprement.
      await bundler.close()
      process.exit(stats.errors.length > 0 || prerenderFatal ? 1 : 0)
    }
    case 'dev': {
      // Journal d'erreurs 3 étages, même magasin que `mjs serve` (cf. render-server.ts
      // pour le commentaire détaillé) : le MAGASIN est créé dès qu'un mjs.config.json existe (coût
      // nul tant qu'aucun fichier n'est lu/écrit, cf. journal.ts) — INDÉPENDANT du bloc `render`
      // (renderHandler ci-dessous, qui ne couvre que le rendu SSR/prérendu). `recordServer` est
      // PRÉ-GATÉ une seule fois ici (no-op si journal.server === false) : createRenderHandler n'a
      // pas à retester la config lui-même — même contrat que RecordServerFn (journal.ts). Sans
      // `found` (aucun mjs.config.json) : ni magasin ni recordServer, comportement HISTORIQUE
      // strictement inchangé.
      // `version` posée ici comme le fait `mjs serve` (render-server.ts, MÊME appel à
      // readBuildVersion, désormais partagée par server/build-version.ts) : une entrée de dev dit de
      // QUEL build elle vient. Cache par mtime ⇒ la valeur suit les recompiles du watcher.
      const journalCfg   = found?.config.journal
      const journalStore = found ? createJournal({ dir: join(found.configDir, 'log'), maxEntries: journalCfg?.maxEntries, maxBytes: journalCfg?.maxBytes }) : null
      const recordServer: RecordServerFn | undefined = journalStore
        ? (journalCfg?.server !== false ? (input) => journalStore.record('server', { ...input, version: readBuildVersion(bundler.manifestPath) }) : () => {})
        : undefined

      // render.routes en dev (feature) — bloc `render` optionnel : quand présent,
      // MÊME moteur que `mjs serve` (createRenderHandler), pour voir le rendu
      // SSR/prérendu FRAIS directement en dev, sans lancer `mjs serve` à part.
      // Créé ICI, AVANT `acquireDevLock()` (réordonné exprès — cf. juste en
      // dessous) : `createRenderHandler` ne compile RIEN et ne touche pas le
      // disque tant qu'aucune requête SSR/navigateur n'arrive (mémoïsation
      // paresseuse interne, cf. son commentaire) — sûr à construire même si le
      // lock est ensuite refusé (rien à nettoyer, le process sort de toute façon).
      // `envBuild` transmis (4e paramètre, déjà accepté par
      // createRenderHandler, cf. render-request.ts:120/isProd) : sans lui, le corps d'erreur SSR
      // d'un `mjs dev --prod` restait celui du dev (message brut) faute de NODE_ENV positionné.
      const renderHandler = found?.config.render
        ? await createRenderHandler(found.config, found.configDir, recordServer, envBuild)
        : null

      // Chargeur d'actions `.server.mjs` (cf. serve-entry.ts), MÊME appareillage que `mjs
      // serve` (render-server.ts) : entièrement optionnel (aucun `serve.server.mjs`/`render.entry`
      // trouvé ⇒ chargeur INACTIF en silence, `entry.actionFor` répond toujours null, StaticServer
      // retombe alors sur son 405 sec historique, cf. son commentaire). INDÉPENDANT du bloc `render`
      // (renderHandler ci-dessus) — un projet sans render.routes peut quand même déclarer des
      // actions. Absent `found` (aucun mjs.config.json) ⇒ pas d'entry du tout, comportement
      // HISTORIQUE inchangé.
      const serveEntry = found ? await createServeEntry(found.config, found.configDir, recordServer) : null

      // Lock APRÈS renderHandler/serveEntry (cf. ci-dessus) : nécessaire pour leur passer le
      // callback de fermeture DÈS l'enregistrement des listeners SIGINT/SIGTERM/
      // SIGHUP (cf. cli/dev-lock.ts — un handler ajouté APRÈS coup ne tournerait
      // jamais, `acquireDevLock` appelle `process.exit()` de façon synchrone).
      // Rappel ASYNCHRONE, et ATTENDU : `close()` du handler de rendu rend une promesse (il ferme le
      // renderer, donc son dossier de travail — cf. server/render-compile-dir.ts). Un rappel
      // synchrone la jetait, `dev-lock.ts` n'attendait rien et sortait aussitôt : un dossier de
      // travail restait derrière chaque session de développement.
      acquireDevLock(undefined, (renderHandler || serveEntry) ? async () => { await renderHandler?.close(); serveEntry?.close() } : undefined)

      // Priorité port : --port flag > mjs.config.json dev.port > défaut 3939
      const server = new StaticServer({
        rootDir: args.output ?? cfgOpts.outputDir ?? 'public/modularjs',
        pathPrefix: bundler.urlPrefix,
        port: args.port ?? cfgOpts.devPort ?? 3939,
        host: cfgOpts.devHost ?? '127.0.0.1',
        // Sans `env`, StaticServer retombait sur NODE_ENV seul
        // (isProdEnv, viewer-page.ts) : un `mjs dev --prod` sans NODE_ENV=production laissait
        // /__mjs/theme(.json) ET /__mjs/errors(.json) ouverts en « production ».
        env: envBuild,
        hmr: true,
        renderHandle: renderHandler?.handle,
        // Passé INCONDITIONNELLEMENT (avant : seulement avec un `renderHandler`). Le manifeste
        // est écrit par le bundler dans TOUS les cas ; le lier au bloc `render` fermait la page du
        // journal et l'atelier des thèmes aux projets qui n'en ont pas, alors que le cœur µ dont ces
        // deux visionneuses ont besoin était bel et bien sur le disque. Fichier pas encore écrit
        // (premier build en cours) ⇒ les routes concernées rendent 404, cf. server/index.ts.
        manifestPath: bundler.manifestPath,
        // Mêmes config/configDir que renderHandler ci-dessus, pour que
        // serveRenderFallback (server/index.ts) puisse thémer son <head> comme `mjs serve`.
        config: found?.config,
        configDir: found?.configDir,
        // Racine du PROJET (dossier de mjs.config.json, ou --root sans config trouvée — `process.cwd()`
        // reflète déjà --root, chdir plus haut) : `mjs dev` sert désormais la page du projet lui-même
        // (index.html, public/…) quand aucun bloc `render` n'est configuré, comme le ferait un serveur
        // de dev Vite/Angular (cf. ServerOpts.projectRoot, server/index.ts). `found.configDir` prime
        // quand il existe (peut être un ANCÊTRE de cwd, si mjs.config.json vit plus haut).
        projectRoot: found?.configDir ?? process.cwd(),
        defaultLang: found?.config.i18n?.default,
        // Magasin du journal (cf. ci-dessus) : absent (pas de mjs.config.json) ⇒ AUCUNE
        // route /__mjs/errors(.json) servie par StaticServer.
        journal: journalStore ?? undefined,
        // Chargeur d'actions (cf. ci-dessus) : absent ⇒ AUCUN verbe mutant traité, 405 sec
        // historique (cf. StaticServer.handle).
        entry: serveEntry ?? undefined,
        recordServer,
      })
      await server.start()

      // Le build initial se faisait ICI,
      // séquentiellement AVANT `bundler.watch()` : fenêtre où un fichier
      // modifié pendant ce build (potentiellement long) n'était vu par AUCUN
      // watcher, silencieusement perdu. `watch()` fait maintenant CE build
      // initial lui-même, en tout premier, via la MÊME file de compiles que
      // les recompiles déclenchées par le watcher (cf. son commentaire
      // détaillé) — un changement survenant pendant le build initial
      // déclenche désormais sa propre recompile juste après, au lieu d'être
      // ignoré. Le monkey-patch de `bundler.compile` doit rester posé AVANT
      // l'appel à `watch()` pour que SON build initial en bénéficie aussi.

      // Re-build à chaque changement avec notif HMR : reload sur succès,
      // overlay error sinon (récupéré via la sortie du dernier compile).
      // S'applique aussi au build initial (watch() l'invoque désormais lui-même).
      let lastErrors: Error[] = []
      const origCompile = bundler.compile.bind(bundler)
      bundler.compile = async () => {
        const stats = await origCompile()
        lastErrors = stats.errors
        return stats
      }

      await bundler.watch({
        onRecompile: (_changed, stats) => {
          if (lastErrors.length > 0) {
            const msg = lastErrors.map(e => e.message).join('\n\n')
            server.hmr?.notifyError(msg)
          } else {
            // Changement 100 % CSS (stats.cssOnly non nul, cf. bundler) :
            // hot-swap sans reload ni perte d'état (µ._hotCss côté page). Tout le
            // reste (JS/template touché, fichier ajouté/supprimé, moindre doute) →
            // reload complet, comportement historique. Une erreur SASS remonte via
            // stats.errors → branche notifyError ci-dessus (overlay), jamais css-only.
            if (stats?.cssOnly) {
              server.hmr?.notifyCssUpdate(stats.cssOnly)
              console.log(t('cli.css-seul-recharge'))
            } else {
              server.notifyReload()
            }
            // Cf.
            // cli/dev-prerender.ts pour le pourquoi. Fire-and-forget : ne
            // bloque pas le reload HMR du cas commun. Tourne AUSSI sur un
            // css-only (le HTML prérendu embarque le CSS des composants).
            void prerenderOnDevRecompile(found?.config, found?.configDir ?? '', {
              log: console.log,
              warn: console.warn,
              bundler,
            })
          }
        },
      })
      break
    }
    case 'serve': {
      // Serveur de rendu par requête. Exige un bloc `render`.
      if (!found?.config.render) {
        console.error(t('cli.serve-bloc-render-requis'))
        process.exit(1)
      }
      // Compile d'abord : les assets servis + le renderer ont besoin d'un build frais.
      const stats = await bundler.compile()
      printBuildReport(stats)
      for (const e of stats.errors) console.error('  ', e.message)
      if (stats.errors.length > 0) { await bundler.close(); process.exit(1) }
      const port = args.port ?? cfgOpts.devPort ?? 3000
      const host = cfgOpts.devHost ?? '127.0.0.1'
      const running = await startRenderServer(found.config, found.configDir, { port, host, env: envBuild })
      // ARRÊT PROPRE (Ctrl-C) — sans ces écouteurs, le process mourait sur le signal par défaut :
      // `running.close()` n'était jamais atteint, donc ni le renderer de rendu par requête ni son
      // dossier de travail (`mjs-render-*`, cf. server/render-compile-dir.ts) — un dossier laissé
      // derrière PAR SESSION. Même patron que `mjs ws`/`mjs serveur` : une seule passe (`arret`),
      // écouteurs retirés dès l'entrée, sortie au code adéquat une fois tout refermé.
      let arret = false
      const onSignal = (): void => {
        if (arret) return
        arret = true
        process.off('SIGINT', onSignal)
        process.off('SIGTERM', onSignal)
        void (async () => {
          let code = 0
          try {
            await running.close()
            await bundler.close()
          } catch (e: any) {
            console.error(t('cli.serve-arret-echec', { erreur: e?.message || e }))
            code = 1
          }
          // 0 quand tout s'est refermé, comme `mjs ws`/`mjs serveur` : un arrêt demandé qui aboutit
          // n'est pas un échec. Seule une fermeture EN ERREUR sort en 1.
          process.exit(code)
        })()
      }
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)
      console.log(t('cli.serve-demarre', { hote: host, port: running.port }))
      console.log(t('cli.serve-mode-info'))
      break
    }
    case 'ws': {
      // serveur temps réel (MJS-WS) — pas de compilation, `bundler` construit
      // ci-dessus n'est pas utilisé ici (cf. cli/ws.ts pour la logique complète :
      // résolution d'entry, contrat, rechargement à chaud, arrêt propre).
      await runWsCommand({ root: args.root, entry: args.entry, port: args.port, host: args.host }, found?.config)
      break
    }
    case 'serveur': {
      // serveur de jeu (MJS-Server, mjsServer() + app.game()) — pas de compilation, `bundler`
      // construit ci-dessus n'est pas utilisé ici (cf. cli/server.ts pour la logique complète :
      // résolution d'entry, contrat, rechargement à chaud, arrêt propre — MÊME patron que `mjs ws`).
      await runServeurCommand({ root: args.root, entry: args.entry, port: args.port, host: args.host }, found?.config)
      break
    }
    case 'check': {
      // Vérifie la config + liste les composants détectés.
      console.log(`Source dir   : ${bundler.sourceDir}`)
      console.log(`Output dir   : ${bundler.outputDir}`)
      console.log(`Manifest     : ${bundler.manifestPath}`)
      console.log(`Stylesheets  : ${bundler.stylesheetsDir}`)
      console.log(`Default lang : ${bundler.defaultScriptLang}`)
      console.log(``)

      if (!existsSync(bundler.sourceDir)) {
        console.error(t('cli.source-dir-introuvable', { dossier: bundler.sourceDir }))
        console.error(t('cli.lancez-mjs-init'))
        process.exit(1)
      }

      // Le commentaire prétendait une
      // "compilation à blanc" (dry-run) : FAUX, `bundler.compile()` est le
      // MÊME compile RÉEL que `mjs build` — il écrit tout autant les fichiers
      // hashés + le manifest dans outputDir/manifestPath. Un dev qui lance
      // `mjs check` en pensant faire une simple vérification READ-ONLY
      // écrase en réalité sa sortie compilée sans le savoir. Fix : commentaire
      // corrigé + avertissement explicite avant de compiler (aucun dry-run
      // implémenté — refactor disproportionné pour ce cas ; l'important est
      // que l'utilisateur ne soit plus surpris).
      console.log(t('cli.check-compile-reel', { dossier: bundler.outputDir }))
      const stats = await bundler.compile()
      const components = Object.keys(stats.manifest)
        .filter(k => !k.startsWith('__'))
      console.log(t('cli.composants-detectes', { nb: components.length }))
      for (const c of components.slice(0, 20)) console.log(`   - ${c}`)
      if (components.length > 20) console.log(t('cli.et-n-autres', { nb: components.length - 20 }))
      console.log(``)
      if (stats.errors.length > 0) {
        console.error(t('cli.erreurs-compilation', { nb: stats.errors.length }))
        for (const e of stats.errors) console.error('  ', e.message)
        await bundler.close()
        process.exit(1)
      }
      console.log(t('cli.tout-compile-ok', { nb: stats.written }))
      await bundler.close()
      process.exit(0)
    }
    default:
      console.error(t('cli.commande-inconnue', { commande: args.command }))
      console.error(USAGE)
      process.exit(2)
  }
}

run(process.argv.slice(2)).catch(e => {
  // Filet générique : `checkWritablePath` (ci-dessus) attrape le cas courant
  // AVANT de compiler, mais une erreur d'ÉCRITURE peut encore survenir en cours de build (droits
  // révoqués en vol, disque plein…) — code fs CONNU → message catalogue nommant le chemin, plutôt
  // que la stack Node brute (seule exception du fichier au catalogue). Le reste (erreur vraiment
  // inattendue) garde sa trace complète, jamais moins d'information qu'avant.
  if (e && typeof e.code === 'string' && FS_ERROR_CODES.has(e.code)) {
    console.error(t('cli.erreur-ecriture', { code: e.code, chemin: e.path ?? '?', erreur: e.message }))
  } else {
    console.error('❌', e)
  }
  process.exit(1)
})
