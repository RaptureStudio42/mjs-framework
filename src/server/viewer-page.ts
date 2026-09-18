// viewer-page — compile À LA VOLÉE le composant MJS d'une visionneuse de dev (le framework se
// mange lui-même) et décide qui a le droit de la voir. Née pour `errors-viewer.mjs` (étage 3 du
// journal d'erreurs), généralisée pour servir aussi `theme-viewer.mjs` (atelier
// /__mjs/theme) — toute visionneuse future n'a qu'à fournir un `ViewerSpec`.
//
// Compilation : `transpile()` (src/transpiler/index.ts, la même fonction single-file que les
// sondes de tests appellent) produit un JS qui importe le cœur via le PLACEHOLDER
// `µ.asset('mjs_core.js')` (résolu normalement par le bundler, `resolveMagicAssets`) — ici, HORS
// bundler, on le remplace par le VRAI chemin du core que le manifeste de l'app sert déjà (extrait
// du manifeste par regex, même patron que `readBuildVersion`, render-server.ts — cascade de
// modules : bundle.js n'importe plus le cœur STATIQUEMENT, `const µCore = '<chemin>';` en tête de
// fichier reste le littéral que cette regex cherche, cf. writeManifest, bundler/index.ts) : le navigateur
// dédup l'import ES (même URL que celle déjà chargée par `/__mjs/bundle.js`), la visionneuse
// partage donc le MÊME `µ` (mêmes composants enregistrés, même config) que l'appli hôte — jamais
// un second cœur chargé en double. Cache MÉMOIRE PAR VISIONNEUSE (pas de fichier écrit,
// `Map<fileName, …>`) : recompilé seulement si le core de l'app change (nouveau build) — ouvrir
// l'atelier des variables de thème n'invalide jamais le cache du journal, et réciproquement.

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { transpile } from '../transpiler/index.js'
import { writeHashedAsset } from './ssr-head.js'
import { t } from '../messages/index.js'

// même patron que Bundler.locateRuntimeDir/locateCoreModulesDir (bundler/index.ts) : plusieurs
// emplacements possibles selon dev (tsx, ce fichier vit à sa vraie place) / prod bundlé (dist/
// cli.js, aplati par esbuild --bundle) / install npm (`src/` est publié à côté de `dist/`, cf.
// package.json "files"). Généralisée (ex-`locateErrorsViewerSource`) : prend le nom de
// fichier en paramètre, sert n'importe quelle visionneuse du dossier server/.
function locateViewerSource(fileName: string): string {
  const candidates = [
    fileURLToPath(new URL('./' + fileName, import.meta.url)),
    fileURLToPath(new URL('../src/server/' + fileName, import.meta.url)),
    fileURLToPath(new URL('../../src/server/' + fileName, import.meta.url)),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

const CORE_IMPORT_RE = /const µCore = '([^']+)';/

// (mode `csp`) — même littéral que `writeManifest()` (bundler/index.ts:4397, `this.csp ?
// 'µ._csp = true;' : ''`) : le manifeste porte déjà l'information, pas besoin de la faire
// voyager par un paramètre neuf (les 3 call-sites de `getViewerScript`/`viewerScriptElement`,
// `render-server.ts`, sont hors zone ici).
const CSP_FLAG_RE = /µ\._csp = true;/

// (mode `csp`) — marqueur interne (jamais un vrai chemin d'URL, `\0` ne peut pas y
// apparaître) : `getViewerScript` le préfixe à l'URL du fichier hashé quand `csp` est actif,
// `viewerScriptElement` le détecte pour émettre un `<script src>` au lieu d'inliner.

// échappe toute occurrence de `</script` (insensible à la casse) — le HTML tokenizer la reconnaît
// QUELLE QUE SOIT sa position (chaîne, commentaire…) : seule protection universelle, cf. le patron
// `'</' + 'script>'` de renderToString.ts pour le même risque côté littéral figé dans NOTRE propre
// source. Ici le contenu vient d'une COMPILATION (pas d'entrée utilisateur), risque résiduel très
// faible — défense en profondeur quand même.
function escapeScriptClose(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script')
}

// Identité d'une visionneuse : le nom de fichier localise le source .mjs (via
// locateViewerSource) ET sert de clé de cache ; moduleName décide le tag du composant compilé
// (`mjs-<moduleName>`, cf. transpile()). `journal-viewer` ≠ nom de fichier `errors-viewer.mjs`
// (héritage, jamais renommé depuis) — `theme-viewer` correspond, lui, à son propre fichier.
export interface ViewerSpec { fileName: string, moduleName: string }
export const JOURNAL_VIEWER: ViewerSpec = { fileName: 'errors-viewer.mjs', moduleName: 'journal-viewer' }
export const THEME_VIEWER: ViewerSpec = { fileName: 'theme-viewer.mjs', moduleName: 'theme-viewer' }

// cache MÉMOIRE PAR VISIONNEUSE (clé `spec.fileName`) : ouvrir l'atelier /__mjs/theme n'invalide
// jamais le cache du journal, et réciproquement — sinon chaque aller-retour entre les deux
// visionneuses recompilait l'autre à chaque fois.
const cache = new Map<string, { corePath: string, csp: boolean, js: string }>()

const CSP_URL_MARKER = '\0mjs-viewer-src:'

/** Compile (ou sert depuis le cache mémoire) le JS d'une visionneuse `<mjs-{spec.moduleName}>`,
 *  prêt à inliner dans un `<script type="module">` — DOIT suivre un `<script type="module"
 *  src="/__mjs/bundle.js">` dans la page (même cœur µ, import ES dédupliqué par URL). Lève si le
 *  manifeste est absent/illisible ou si la compilation échoue — l'appelant répond 500 (l'app
 *  continue de tourner). */
export async function getViewerScript(manifestPath: string | null, spec: ViewerSpec): Promise<string> {
  if (!manifestPath || !existsSync(manifestPath)) {
    throw new Error(t('server.journal-viewer-manifest-absent'))
  }
  const manifestSrc = readFileSync(manifestPath, 'utf-8')
  const m = manifestSrc.match(CORE_IMPORT_RE)
  // mode `js: 'bundle'` : pas de ligne `const µCore = '…';` — le cœur n'est plus une unité
  // séparée (cf. bundler/index.ts, emitSingleFile()/buildBundleEntry()), tout est fusionné dans
  // le manifeste lui-même, qui RÉEXPORTE µ (`export { µ };`, dernière ligne de son entrée) :
  // importer le manifeste à SA PROPRE URL publique fait le même office. Cette URL est TOUJOURS
  // `/__mjs/bundle.js` (route fixe servant `manifestPath` tel quel, cf. render-server.ts) —
  // précondition déjà documentée en tête de ce fichier (la visionneuse suit TOUJOURS un
  // `<script type="module" src="/__mjs/bundle.js">`), vraie quel que soit le mode. Un manifeste
  // qui n'a NI la ligne `const µCore` NI un export (illisible/corrompu) garde l'erreur d'origine.
  const corePath = m ? m[1] : (/\bexport\s*\{/.test(manifestSrc) ? '/__mjs/bundle.js' : null)
  if (!corePath) {
    throw new Error(t('server.journal-viewer-core-introuvable'))
  }
  const csp = CSP_FLAG_RE.test(manifestSrc)
  const cached = cache.get(spec.fileName)
  if (cached && cached.corePath === corePath && cached.csp === csp) return cached.js
  const source = readFileSync(locateViewerSource(spec.fileName), 'utf-8')
  const { output } = await transpile(source, { moduleName: spec.moduleName })
  const withCore = output.replace("µ.asset('mjs_core.js')", JSON.stringify(corePath))
  let js = escapeScriptClose(withCore)
  if (csp) {
    // (mode `csp`) — `<script type="module">` en ligne BLOQUÉ par `script-src` sans
    // 'unsafe-inline' (vérifié en navigateur). Sort en fichier servi : même trailer
    // (appendChild) que `viewerScriptElement` posait jusqu'ici EN LIGNE, désormais dans CE
    // fichier (un `<script src>` seul ne peut pas être suivi d'une instruction inline). `outputDir`/
    // `urlPrefix` re-DÉRIVÉS ici (pas de paramètre neuf, cf. CSP_FLAG_RE) : `outputDir` =
    // dossier du manifeste (convention `join(outputDir, 'bundle.js')`, cf. createSSRRenderer/
    // createBrowserRenderer) ; `urlPrefix` = dossier de `corePath` (même convention que
    // `Bundler.writeHashed`, le core vit à la racine d'`outputDir`).
    const outputDir = dirname(manifestPath)
    const urlPrefix = corePath.replace(/\/[^/]*$/, '')
    const tag = 'mjs-' + spec.moduleName
    const full = js + '\ndocument.body.appendChild(document.createElement(' + JSON.stringify(tag) + '));'
    const url = writeHashedAsset(outputDir, urlPrefix, 'mjs_viewer_' + spec.moduleName, '.js', full)
    js = CSP_URL_MARKER + url
  }
  cache.set(spec.fileName, { corePath, csp, js })
  return js
}

// Script complet d'une visionneuse : le JS compilé SUIVI d'une ligne qui crée et
// insère l'élément <mjs-{moduleName}>. POURQUOI la balise n'est plus écrite en dur dans le HTML du
// shell (cf. ses 3 call-sites) : l'autoloader (mjs_autoloader.ts, chargé en premier par le bundle)
// voit tout tag présent dans le DOM au 1er passage et le rejette s'il n'est pas dans µ.paths
// (normal : une visionneuse est compilée à la volée, jamais dans le manifeste) → erreur console à
// l'ouverture, page qui marche quand même (une course, pas une panne) mais laide pour un outil dont
// le métier est justement de lire une console. En insérant l'élément APRÈS sa définition (le
// `customElements.define` déjà présent dans `js`), `µ.Autoloader.load` le voit déjà défini et sort
// immédiatement (mjs_autoloader.ts:70) — plus aucune course. Nom de balise dérivé du ViewerSpec,
// écrit via JSON.stringify (jamais concaténé nu : mêmes garanties que le reste du fichier).
export function viewerScriptElement(js: string, spec: ViewerSpec): string {
  // (mode `csp`) — `js` porte le MARQUEUR (`CSP_URL_MARKER`) posé par `getViewerScript`
  // quand le manifeste porte `µ._csp = true;` : le trailer (appendChild) est alors DÉJÀ dans le
  // fichier servi (cf. son commentaire), un `<script src>` seul suffit, zéro script en ligne.
  if (js.startsWith(CSP_URL_MARKER)) {
    return '<script type="module" src="' + js.slice(CSP_URL_MARKER.length) + '"></script>\n'
  }
  const tag = 'mjs-' + spec.moduleName
  return '<script type="module">' + js + '\ndocument.body.appendChild(document.createElement(' + JSON.stringify(tag) + '));</script>\n'
}

// comparaison à temps constant — longueur d'abord (timingSafeEqual lève sinon), même patron que
// mjs-ws/token.ts:safeEqualB64 (transposé ici, pas importé : sous-système différent).
function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** Décision « production » PARTAGÉE : le drapeau CLI/config (`env`, MÊME
 *  paramètre que `render-request.ts` reçoit déjà, cf. son `isProd`) prime, `NODE_ENV=production`
 *  reste accepté comme second signal (systemd/pm2 qui l'exportent sans jamais passer par --prod).
 *  Auparavant, les 3 gardes concernées (ici + l'atelier `/__mjs/theme`, server/index.ts et
 *  render-server.ts) ne regardaient QUE NODE_ENV : un `--prod` sans NODE_ENV positionné les
 *  laissait ouvertes en production réelle. Exportée : réutilisée par `isViewerAllowed`/
 *  `warnIfJournalViewerOpenInProd` ci-dessous ET par la garde `/__mjs/theme` de server/index.ts —
 *  une seule décision, jamais 2 logiques à la main qui divergent. */
export function isProdEnv(env?: 'dev' | 'prod'): boolean {
  return env === 'prod' || process.env.NODE_ENV === 'production'
}

/** Règle d'accès des 3 routes lecture/purge (GET page, GET .json, DELETE) — cf. le JSDoc de
 *  `JournalConfig.viewer` : `true`/absent = hors production seulement ; chaîne = jeton `?token=`
 *  EXIGÉ dans toute circonstance (dev compris — poser un jeton verrouille partout, sans exception
 *  discrète) ; `false` = jamais. Le refus (quelle qu'en soit la raison) est TOUJOURS un 404, jamais
 *  un 403 — indistinct d'une route qui n'existe pas. */
export function isViewerAllowed(viewerCfg: boolean | string | undefined, url: URL, env?: 'dev' | 'prod'): boolean {
  if (viewerCfg === false) return false
  if (typeof viewerCfg === 'string' && viewerCfg.length > 0) {
    return safeEqualStr(url.searchParams.get('token') ?? '', viewerCfg)
  }
  return !isProdEnv(env)
}

/** Avertissement AU DÉMARRAGE (une fois, pas par requête) quand une config met explicitement
 *  `journal.viewer: true` ET tourne en production — le défaut (absent/undefined) reste silencieux,
 *  c'est le cas normal du dev (cf. isViewerAllowed juste au-dessus). N'empêche rien, ne change
 *  aucun comportement : la page continue d'être servie exactement pareil. Appelée depuis les 2
 *  points d'entrée joignables (`mjs dev` → server/index.ts, `mjs serve` → render-server.ts). */
export function warnIfJournalViewerOpenInProd(viewerCfg: boolean | string | undefined, env?: 'dev' | 'prod'): void {
  if (viewerCfg === true && isProdEnv(env)) {
    console.error(t('server.index-journal-viewer-en-prod'))
  }
}
