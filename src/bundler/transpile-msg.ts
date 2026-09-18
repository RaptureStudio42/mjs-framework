// bundler/transpile-msg — le message de transpilation et son EXÉCUTION, en un seul endroit.
//
// Le même travail se fait sur deux chemins : dans un worker_threads (worker.ts, gros projets)
// ou directement dans le processus principal (petits projets — démarrer un pool coûte plus
// cher que le travail lui-même). La projection du TranspileData et l'empreinte `restHash`
// sont subtiles (le rechargement CSS à chaud en dépend) : une seule définition ici, les deux
// chemins l'appellent.

import { createHash } from 'node:crypto'
import { transpile } from '../transpiler/index.js'

export interface TranspileMsg {
  type: 'transpile'
  id: number
  content: string
  moduleName: string
  /** déduit par le master du VRAI nom de fichier (isPageFile, bundler/index.ts) :
   *  seul passe-plat, cf. TranspileOpts.isPageModule côté transpile(). */
  isPageModule?: boolean
  defaultScriptLang?: 'civet' | 'coffee' | 'ts' | 'js'
  templateLang?: 'civet' | 'js'
  sigil?: 'µ' | 'mjs'
  contextAlias?: boolean
  varPrefix?: string
  maxStateVars?: number
  /** Lint d'accessibilité (`lint.a11y`) — SANS cette transmission, `false` explicite
   *  resterait mort sur le chemin le plus courant : `mjs build` d'un projet
   *  multi-fichiers passe par ce pool de workers */
  a11y?: boolean
  baseDir?: string
  sourceDir?: string
  aliasTag?: string
  dirInject?: string
  /**
   * Dict `{ logicalPath → webPath }` des `µasset('...')` pré-résolus par le
   * master avant l'envoi au worker. Le worker n'a pas accès au disque pour
   * résoudre les assets — il lit dans ce dict.
   */
  preResolvedAssets: Record<string, string>
  /** jumeau du dict ci-dessus pour `µimage('x'[, largeurs])` : le TEXTE EXACT
   *  de l'appel → l'objet JSON résolu côté master (il faut le disque pour lire les
   *  dimensions natives et produire les variantes). */
  preResolvedImages?: Record<string, string>
}

/** Résultat renvoyé au master : sortie compilée + projection minimale du TranspileData. */
export interface TranspileMsgResult {
  output: string
  sourceMap?: string
  data: Record<string, any>
}

/** Exécute UN message de transpilation. Identique des deux côtés (worker ou processus
 *  principal) : c'est la seule définition de la projection et de `restHash`. */
export async function transpileFromMsg(msg: TranspileMsg): Promise<TranspileMsgResult> {
  const preResolved = msg.preResolvedAssets ?? {}
  const result = await transpile(msg.content, {
    moduleName: msg.moduleName,
    isPageModule: msg.isPageModule,
    defaultScriptLang: msg.defaultScriptLang,
    templateLang: msg.templateLang,
    sigil: msg.sigil,
    contextAlias: msg.contextAlias,
    varPrefix: msg.varPrefix,
    maxStateVars: msg.maxStateVars,
    a11y: msg.a11y,
    baseDir: msg.baseDir,
    sourceDir: msg.sourceDir,
    aliasTag: msg.aliasTag,
    dirInject: msg.dirInject,
    preResolvedImages: msg.preResolvedImages,
    // resolveAsset : lit dans le dict pré-rempli. Pour les `µasset(expr)`
    // dynamiques non pré-résolus, retourne MISSING_MJS_ASSET — le master
    // fera `resolveMagicAssets` en post-process pour les rattraper.
    resolveAsset: async (logicalPath: string) => {
      return preResolved[logicalPath] ?? `/MISSING_MJS_ASSET:${logicalPath}`
    },
  })
  // worker_threads sérialise via structuredClone : strings, arrays, plain
  // objects, Set, Map, Date, RegExp passent. Pas de classes ni fonctions.
  //
  // PERF — on NE renvoyait PAS que l'utile :
  // `result.data` est le TranspileData COMPLET (surgicalHtml, createFnBody,
  // effets… potentiellement gros) structuredClone'é en entier à chaque
  // fichier, alors que le master ne lit QUE quelques champs (cf.
  // TranspileDataLike). On projette ces champs → clone minimal.
  //
  // rechargement CSS à chaud — le diff « css-only » du master a
  // besoin de savoir si TOUT hors-baseCss est identique au compile précédent,
  // SANS ré-expédier les gros champs : on les résume ici en une EMPREINTE
  // (`restHash`, SHA-256 du TranspileData privé de baseCss — ordre de clés
  // déterministe, l'objet est un littéral construit par transpile()). Seuls
  // transitent en plus les petits champs utiles au payload css-only :
  // tagName/aliasTag (clés), baseCss + moduleDisplay (CSS scopé).
  const { baseCss: _bc, ...restData } = result.data
  const restHash = createHash('sha256').update(JSON.stringify(restData)).digest('hex').slice(0, 16)
  return {
    output: result.output,
    // carte de source du composant (chaîne complète .mjs → fichier
    // produit, cf. transpiler/source-map-chain.ts). Chaîne JSON, donc clonable
    // telle quelle par structuredClone ; absente si le langage n'en produit pas.
    sourceMap: result.sourceMap,
    data: {
      usedAnimations:  result.data.usedAnimations,
      sharedCssNames:  result.data.sharedCssNames,
      includedPartials: result.data.includedPartials,
      macroErrors:     result.data.macroErrors,
      sectionWarnings: result.data.sectionWarnings,
      tagRefs:         result.data.tagRefs,
      componentDeps:   result.data.componentDeps,
      tagName:         result.data.tagName,
      aliasTag:        result.data.aliasTag,
      baseCss:         result.data.baseCss,
      moduleDisplay:   result.data.moduleDisplay,
      layoutCss:       result.data.layoutCss,
      themeVars:       result.data.themeVars,
      varsRead:        result.data.varsRead,
      themeVariants:   result.data.themeVariants,
      restHash,
    },
  }
}
