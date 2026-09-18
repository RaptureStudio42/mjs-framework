// cli/server-entry — chargeur d'entry PARTAGÉ pour `mjs ws`/`mjs serveur` (cli/ws.ts,
// cli/server.ts) et `mjs serve` (server/serve-entry.ts). Une entry `.server.mjs` est un
// VRAI fichier MJS — compilée (MÊME dialecte Civet que le <script> des composants,
// applyCivetDialectSugar, src/transpiler/index.ts, SOURCE UNIQUE) vers un fichier réel sur
// disque, plus une URL `data:` (limite historique — imports relatifs/paquets nus impossibles
// sans dossier de référence, cf. l'ancienne doc docs/23-mjs-ws.md §13.2). Une entry `.civet`
// BRUTE reste un fichier ordinaire (AUCUNE pré-passe, AUCUN `@import`) — MÊME mécanique de
// fichier réel + cache-busting, juste sans dialecte ni grammaire.
//
// Cache — `serverCacheDir()` : `<root>/node_modules/.cache/mjs/server/` si `<root>/node_modules`
// existe (permet à Node de résoudre un paquet npm NU depuis ce dossier, en remontant l'arbre —
// l'algorithme de résolution de Node cherche un `node_modules` à CHAQUE niveau ancêtre, et ce
// dossier de cache vit justement SOUS un `node_modules` existant) ; sinon repli `os.tmpdir()`,
// MÊME précédent que `findCacheDir` (bundler/worker-pool.ts). Un `package.json`
// `{"type":"module"}` y est déposé une fois : sans lui, Node ≥ 22 lit un `.js` sans extension
// `.mjs` comme CommonJS (piège vérifié, cf. tests/module-civet-imports.test.ts).
//
// Grammaire `@import` — SEULE directive qui a un sens hors DOM dans
// un fichier serveur : `@i18n`/`@routes`/`@display`/`@css`/`@lang`… → erreur explicite
// (`cli.entry-directive-interdite`). MÊME regex que transpiler/directives.ts:239 (charset +
// garde-fou virgule, MÊME clé catalogue `transpiler.import-virgule-interdite`) — cible
// `https?://` laissée telle quelle ; cible avec préfixe `./`/`../`/`/`/`file:`, OU sans préfixe
// mais qui EXISTE réellement à côté de l'entry ou sous --root (forme composant
// `utils/helpers.civet`), résolue et compilée récursivement si `.civet`/`.mjs` (« c'est du MJS »),
// importée telle quelle si `.js`/`.cjs`/`.json` ; sinon spécificateur NU laissé à Node (`node:fs`,
// un paquet npm AVEC ou SANS sous-chemin/`@scope` — `mjs-framework/ws`, `@scope/pkg/sub` — si
// `<root>/node_modules` existe, cf. cache ci-dessus). Un `/` dans le spécificateur ne
// suffit plus à le prendre pour un chemin (cf. `looksLikePath` ci-dessous) — seule une cible SANS
// préfixe qui finit par `.civet`/`.mjs` ET n'existe nulle part est encore une erreur forcée (« cible
// introuvable » plutôt qu'un repli silencieux, forcément un fichier voulu). Un `import … from`
// NATIF (hors `@import`) est une ERREUR de compilation, clés cli.entry-*,
// import(variable) permis — `lintNoRawImport` (transpiler/index.ts), MÊME garde que <script>/
// <script module>, avec ses clés catalogue propres (entry serveur) substituées via son 5e paramètre.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve, extname, relative, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { t } from '../messages/index.js'
import type { CompileResult } from '../languages/index.js'

// traces d'erreur sur les lignes SOURCE (Civet), pas sur le JS généré dans le cache — une
// exception levée depuis un `setup()`/`serve()` d'entry pointe alors le `.server.mjs`/`.civet` de
// l'appli, jamais le fichier haché sous `node_modules/.cache/mjs/server/`
process.setSourceMapsEnabled(true)

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

let importCounter = 0

// --- dossier de cache ---------------------------------------------------------

/** `<root>/node_modules/.cache/mjs/server/` si possible (résolution npm normale depuis là), sinon
 *  repli `os.tmpdir()` (MÊME précédent que `findCacheDir`, bundler/worker-pool.ts). Pose (une
 *  fois) le `package.json` `{"type":"module"}` qui fait lire les `.js` du dossier comme de l'ESM. */
export function serverCacheDir(root: string): string {
  const nm  = join(root, 'node_modules')
  const dir = existsSync(nm) ? join(nm, '.cache', 'mjs', 'server') : join(tmpdir(), `mjs-server-cache-${process.getuid?.() ?? 'nouid'}`)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const pkg = join(dir, 'package.json')
  if (!existsSync(pkg)) writeFileSync(pkg, '{"type":"module"}\n')
  return dir
}

// écriture atomique — MÊME précédent que compileWorkerInMemory (bundler/worker-pool.ts) : temp
// UNIQUE (pid + horodatage) puis renameSync, jamais de fichier tronqué visible par un import
// concurrent (2 process qui rechargent la même entry en même temps).
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* best-effort */ }
    if (!existsSync(file)) throw err
  }
}

// dépose le JS compilé (+ sa carte de source si fournie) dans le cache, sous un nom haché sur le
// chemin ABSOLU de la source (pas de collision entre projets) — rend une URL `file://` cache-bustée
// (`?v=n`, compteur PARTAGÉ par ce module : chaque appel garantit une URL neuve, même contenu
// byte-identique, cf. le même besoin que `importCompiledJs` côté data: URL).
function writeCacheFile(sourceAbsPath: string, root: string, code: string, map: string | undefined): string {
  const cacheDir = serverCacheDir(root)
  const hash     = createHash('md5').update(sourceAbsPath).digest('hex')
  const outFile  = join(cacheDir, `${hash}.js`)
  let finalCode  = code
  if (map) {
    writeAtomic(`${outFile}.map`, map)
    finalCode = `${code}\n//# sourceMappingURL=${basename(outFile)}.map\n`
  }
  writeAtomic(outFile, finalCode)
  return `${pathToFileURL(outFile).href}?v=${++importCounter}`
}

// --- markup de composant (garde-fou .server.mjs/.mjs) -------------------------

// détecte du markup de composant (<template>, <style>, ou une balise HTML en tête de fichier)
// dans un fichier `.server.mjs`/`.mjs` — un fichier serveur n'est PAS un composant .mjs (pas de
// template/DOM), juste du Civet/JS (`export default { setup(app) { … } }`). Cherche une balise EN
// DÉBUT DE LIGNE (jamais dans un commentaire/une string qui en parlerait) ; retourne l'indice
// trouvé (pour le message d'erreur) ou `null` si le fichier est un script Civet ordinaire.
export function findComponentMarkupHint(source: string): string | null {
  const tag = source.match(/^[ \t]*<(template|style)\b/im)
  if (tag) return `<${tag[1].toLowerCase()}>`
  const withoutLeadingBlanks = source.replace(/^(?:[ \t]*(?:\/\/[^\n]*|#[^\n]*)?\n)*/, '')
  const head = withoutLeadingBlanks.match(/^[ \t]*<([a-zA-Z][\w-]*)/)
  return head ? `<${head[1]}>` : null
}

// --- grammaire @import ---------------------------------------------------------

// MÊME regex que transpiler/directives.ts:~257 (charset + garde-fou virgule + backreference
// de guillemet) — SOURCE dupliquée à dessein (pas d'import croisé cli/ ↔
// transpiler/directives.ts pour une seule regex), mais gardée IDENTIQUE : toute évolution de la
// grammaire @import doit toucher les deux endroits. `(['"])(.+?)\3` (backreference sur le 3e
// groupe capturant, après `default`/`rawVars`) exige le MÊME guillemet en fermeture — un chemin
// `'…'` contenant un `"` littéral n'est plus tronqué au premier `"` rencontré.
// DIVERGENCE VOLONTAIRE d'UN caractère avec
// directives.ts : la cible VIDE (`@import x ''`) y est devenue une erreur explicite dédiée
// (`.+?` → `.*?`, FUITE dans le HTML rendu côté client) — ICI, une cible vide ne matche déjà
// pas cette regex (`.+?` inchangée), la ligne reste dans `cleaned`, et `otherDirective` (plus
// bas) la rejette déjà via `cli.entry-directive-interdite` (prouvé par sonde, aucune fuite
// possible : un fichier serveur ne rend aucun HTML). Élargir ICI aussi ouvrirait un AUTRE trou
// (cible vide → `resolveImportTarget` résout le DOSSIER de l'entry lui-même) — non traité ici.
const IMPORT_RE = /^[ \t]*@import\s+(?:(default)\s+)?([a-zA-Z0-9_$,\s]+?)\s+(['"])(.+?)\3[ \t]*$/gm

// ressemble à un CHEMIN DE PROJET (donc une cible ABSENTE mérite une erreur, pas un repli
// silencieux vers Node) — SOIT un préfixe explicite (`./`, `../`, `/`, `file:`), SOIT (sans ce
// préfixe) une extension composant `.civet`/`.mjs` (forme `utils/helpers.civet`, forcément un
// fichier VOULU, jamais un sous-chemin de paquet npm). Un `/` seul ne suffit plus —
// `mjs-framework/ws`, `@scope/pkg/sub` ont un `/` mais NI préfixe NI extension composant, donc
// spécificateur NU laissé à Node (l'ancien test `spec.includes('/')` les prenait à tort pour une
// cible de projet, cf. docs/23-mjs-ws.md §13.2).
function looksLikePath(spec: string): boolean {
  return /^(?:\.\.?\/|\/|file:)/.test(spec) || /\.(civet|mjs)$/.test(spec)
}

interface ServerCompileCtx {
  /** pile des chemins ABSOLUS en cours de compilation — détection de cycle par DFS classique */
  visiting: string[]
}

function newCtx(): ServerCompileCtx {
  return { visiting: [] }
}

// résout UNE cible @import : URL http(s) telle quelle ; fichier du projet (préfixé `./`/`../`/`/`/
// `file:`, OU sans préfixe mais présent à côté de l'entry ou sous --root, forme composant) compilé
// récursivement si `.civet`/`.mjs` (« c'est du MJS »), importé tel quel si `.js`/`.cjs`/`.json`
// (attribut `with { type: 'json' }` ajouté par l'appelant, extractServerImports ci-dessous) ; sinon
// spécificateur NU laissé à Node (paquet npm AVEC ou SANS sous-chemin/`@scope`, `node:*`)
// — ERREUR si la cible ressemble à un chemin de projet (looksLikePath) sans exister nulle part
// (évite un `Cannot find module './x'` cryptique côté Node).
async function resolveImportTarget(targetPath: string, fromAbsPath: string, root: string, ctx: ServerCompileCtx): Promise<string> {
  if (/^https?:\/\//.test(targetPath)) return targetPath

  const nearEntry   = resolve(dirname(fromAbsPath), targetPath)
  const nearRoot    = resolve(root, targetPath)
  const projectFile = existsSync(nearEntry) ? nearEntry : (existsSync(nearRoot) ? nearRoot : null)

  if (projectFile === null) {
    if (looksLikePath(targetPath)) throw new Error(t('cli.entry-import-introuvable', { entryPath: fromAbsPath, cible: targetPath }))
    return targetPath   // spécificateur nu — résolution Node normale ('node:*', paquet npm sous root/node_modules)
  }

  const ext = extname(projectFile)
  if (ext === '.civet' || ext === '.mjs') return compileServerFile(projectFile, root, ctx)
  return `${pathToFileURL(projectFile).href}?v=${++importCounter}`
}

// --- masquage commentaires/chaînes ---------------------------------------------

// scanQuotedWithInterp — avance depuis l'ouverture d'une chaîne (`quote` = "'", '"', "'''" ou
// '"""') jusqu'à sa fermeture, en sautant tout `#{…}`/`${…}` imbriqué (interpolation Civet dans
// une chaîne, gabarit JS dans un `` ` ``) sans se faire piéger par un guillemet PORTÉ PAR
// l'expression elle-même (même souci que maskStaticHtmlText, transpiler/index.ts, sur `{…}`).
function scanQuotedWithInterp(src: string, start: number, quote: string, interp: string): number {
  const n    = src.length
  const qlen = quote.length
  let i      = start + qlen
  while (i < n) {
    if (src[i] === '\\') { i += 2; continue }
    if (src.slice(i, i + qlen) === quote) return i + qlen
    if (src.slice(i, i + interp.length) === interp) {
      i += interp.length
      let depth = 1
      while (i < n && depth > 0) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === "'" || src[i] === '"' || src[i] === '`') { i = skipNestedQuote(src, i); continue }
        if (src[i] === '{') depth++
        else if (src[i] === '}') depth--
        i++
      }
      continue
    }
    i++
  }
  return n
}

// skipNestedQuote — chaîne SIMPLE (sans interpolation récursive) pour une expression `#{…}`/
// `${…}` qui contiendrait elle-même un guillemet : une seule profondeur suffit ici, la détection
// de directive n'a besoin que de ne pas se faire abuser par une fermeture prématurée.
function skipNestedQuote(src: string, start: number): number {
  const quote = src[start]
  const n     = src.length
  let i       = start + 1
  while (i < n) {
    if (src[i] === '\\') { i += 2; continue }
    if (src[i] === quote) return i + 1
    i++
  }
  return n
}

// maskCommentsAndStrings (correctif faux positif) : rend une copie de `src` où chaque
// commentaire (`#…`, `###…###`, `//…`, `/*…*/` — le dialecte Civet accepte les deux familles) et
// chaque chaîne (`'…'`, `"…"` avec `#{…}` imbriqué, `'''…'''`/`"""…"""`, gabarit `` `…` `` avec
// `${…}` imbriqué) est REMPLACÉE PAR DES ESPACES DE MÊME LONGUEUR (les `\n` internes restent des
// `\n` : mêmes lignes, mêmes offsets que `src`) — un commentaire JSDoc (`### … @param x … ###`) ou
// une chaîne multi-lignes dont une ligne commence par `@foo` ne doit jamais ressembler à une
// directive. Sert UNIQUEMENT à la détection (regex `@import`/« autre directive ») : le texte réel
// transmis au compilateur reste toujours `src`/`cleaned`, jamais ce masque. Une ligne `@import`
// RÉELLE (colonne 0) traverse INTACTE (même garde que maskStaticHtmlText, transpiler/index.ts) :
// masquer sa cible entre guillemets casserait la capture de IMPORT_RE juste après.
function maskCommentsAndStrings(src: string): string {
  const n     = src.length
  let out     = ''
  const blank = (from: number, to: number): void => { for (let k = from; k < to; k++) out += src[k] === '\n' ? '\n' : ' ' }
  let i       = 0
  while (i < n) {
    if ((i === 0 || src[i - 1] === '\n') && /^[ \t]*@import\b/.test(src.slice(i, i + 20))) {
      const nl  = src.indexOf('\n', i)
      const end = nl === -1 ? n : nl + 1
      out += src.slice(i, end)
      i = end
      continue
    }
    const three = src.slice(i, i + 3)
    if (three === "'''" || three === '"""') { const stop = scanQuotedWithInterp(src, i, three, '#{'); blank(i, stop); i = stop; continue }
    if (three === '###') { const end = src.indexOf('###', i + 3); const stop = end === -1 ? n : end + 3; blank(i, stop); i = stop; continue }
    const two = src.slice(i, i + 2)
    if (two === '//') { const end = src.indexOf('\n', i); const stop = end === -1 ? n : end; blank(i, stop); i = stop; continue }
    if (two === '/*') { const end = src.indexOf('*/', i + 2); const stop = end === -1 ? n : end + 2; blank(i, stop); i = stop; continue }
    if (src[i] === '#') { const end = src.indexOf('\n', i); const stop = end === -1 ? n : end; blank(i, stop); i = stop; continue }
    if (src[i] === "'" || src[i] === '"') { const stop = scanQuotedWithInterp(src, i, src[i], '#{'); blank(i, stop); i = stop; continue }
    if (src[i] === '`') { const stop = scanQuotedWithInterp(src, i, '`', '${'); blank(i, stop); i = stop; continue }
    out += src[i]
    i++
  }
  return out
}

// retire les lignes @import du source (en partant de la FIN pour ne jamais décaler les indices
// des matches précédents), résout chaque cible, rend les clauses `import` natives à préfixer + le
// source nettoyé. Toute AUTRE directive en colonne 0 (hors @import) → erreur explicite : seule
// @import a un sens hors DOM (cf. commentaire de tête du fichier).
async function extractServerImports(src: string, absPath: string, root: string, ctx: ServerCompileCtx): Promise<{ cleaned: string, importClauses: string[] }> {
  const matches = [...maskCommentsAndStrings(src).matchAll(IMPORT_RE)]
  const importClauses: string[] = []
  let cleaned = src
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]
    const [full, isDefault, rawVars, , targetPath] = match
    if (rawVars.includes(',')) throw new Error(t('transpiler.import-virgule-interdite', { rawVars: rawVars.trim(), targetPath }))
    // (même garde que transpiler/directives.ts, même clé catalogue) — un guillemet,
    // un antislash, un retour à la ligne ou un NUL dans la cible s'insérerait tel quel dans la
    // clause `import … from '${fromSpecifier}'` générée plus bas.
    // (même garde que transpiler/directives.ts, MÊME liste refusée) — `#{…}`/`${…}`/un backtick
    // s'ajoutent : ICI la cible s'insère dans un SIMPLE
    // guillemet (Civet n'y interpole jamais), donc aucune exécution de code n'est possible par ce
    // biais, mais une cible `x#{1+1}y` compilait quand même SANS erreur en import mort
    // (spécificateur littéral jamais résolu par Node) — refusée avant, comme côté client.
    if (/['"\\\n\0`]|#\{|\$\{/.test(targetPath)) throw new Error(t('transpiler.import-cible-invalide', { cible: targetPath }))
    const cleanVars      = rawVars.split(/[ \t]+/).map((s: string) => s.trim()).filter((s: string) => s.length > 0)
    const fromSpecifier  = await resolveImportTarget(targetPath, absPath, root, ctx)
    // Node ≥ 20.10 exige l'attribut `with { type: 'json' }` sur un `import` statique
    // ciblant du `.json` (assertion d'import), sinon `ERR_IMPORT_ATTRIBUTE_MISSING` au chargement
    // — extension prise sur `targetPath` (la cible ÉCRITE), jamais sur `fromSpecifier` (une cible
    // `.civet`/`.mjs` compilée finit toujours en `.js`, jamais en `.json`)
    const attrs  = targetPath.endsWith('.json') ? ` with { type: 'json' }` : ''
    const clause = isDefault
      ? `import ${cleanVars[0]} from '${fromSpecifier}'${attrs}`
      : `import { ${cleanVars.join(', ')} } from '${fromSpecifier}'${attrs}`
    importClauses.unshift(clause)
    cleaned = cleaned.slice(0, match.index) + cleaned.slice(match.index + full.length)
  }
  const otherDirective = maskCommentsAndStrings(cleaned).match(/^[ \t]*(@[a-zA-Z][a-zA-Z0-9]*)\b/m)
  if (otherDirective) throw new Error(t('cli.entry-directive-interdite', { entryPath: absPath, directive: otherDirective[1] }))
  return { cleaned, importClauses }
}

// --- compilation --------------------------------------------------------------

// compile un fichier `.server.mjs`/`.mjs` — MÊME dialecte Civet que le <script> des composants
// (applyCivetDialectSugar, SOURCE UNIQUE) + grammaire @import ci-dessus. Appelée pour l'entry ET
// récursivement pour chaque dépendance `.civet`/`.mjs` qu'elle @import (AUCUNE transformation de
// symbole réactif $x/@x/§/µ-runes : un fichier serveur n'a ni réactivité ni DOM). Détection de
// cycle par la pile `ctx.visiting` (DFS classique) — `ctx` frais par défaut, PARTAGÉ explicitement
// entre l'appel racine et ses dépendances (cf. `resolveImportTarget` ci-dessus).
export async function compileServerFile(absPath: string, root: string, ctx: ServerCompileCtx = newCtx()): Promise<string> {
  if (ctx.visiting.includes(absPath)) {
    const chain = [...ctx.visiting, absPath].map(p => relative(root, p) || p).join(' → ')
    throw new Error(t('cli.entry-import-cycle', { entryPath: absPath, chaine: chain }))
  }
  ctx.visiting.push(absPath)
  try {
    const source = readFileSync(absPath, 'utf8')
    if (extname(absPath) === '.mjs') {
      const hint = findComponentMarkupHint(source)
      if (hint) throw new Error(t('cli.ws.entry-markup-composant', { entryPath: absPath, indice: hint }))
    }
    const { cleaned, importClauses } = await extractServerImports(source, absPath, root, ctx)
    const withImports                = importClauses.length > 0 ? `${importClauses.join('\n')}\n${cleaned}` : cleaned
    const { applyCivetDialectSugar, lintNoRawImport } = await import('../transpiler/index.js')
    const { getAdapter }                              = await import('../languages/index.js')
    let result: CompileResult
    try {
      result = await getAdapter('civet').compileToJs(applyCivetDialectSugar(withImports, 'civet'), { fileName: absPath })
    } catch (err) {
      throw new Error(t('cli.ws.erreur-compilation', { entryPath: absPath, erreur: errText(err) }))
    }
    lintNoRawImport(result.code, relative(root, absPath) || absPath, importClauses.length, undefined, { static: 'cli.entry-import-natif-interdit', dynamic: 'cli.entry-import-dynamique-interdit', reexport: 'cli.entry-reexport-interdit' })
    return writeCacheFile(absPath, root, result.code, result.map)
  } finally {
    ctx.visiting.pop()
  }
}

// compile un entry `.civet` BRUT (variante documentée, §13.3 docs/23-mjs-ws.md) — AUCUNE
// pré-passe (ni dialecte, ni @import) : un fichier ordinaire, cf. tête de
// fichier — juste le compilateur Civet nu, MÊME fichier réel + cache-busting que compileServerFile.
// une directive MJS reste toutefois REFUSÉE explicitement (cf. juste en
// dessous), plutôt que de compiler en silence vers un appel de méthode ordinaire.
export async function compileRawCivetFile(absPath: string, root: string): Promise<string> {
  // un BOM UTF-8 (U+FEFF) en tête de fichier
  // (PowerShell `Out-File`/Notepad sous Windows, MÊME cause que sections.ts:282) n'est ni un
  // espace ni un `@` : la garde `^[ \t]*@…` juste en dessous ne le voit pas, la directive file
  // jusqu'au compilateur Civet nu qui échoue avec un ParseError illisible, sans jamais citer
  // `@import` ni l'entry. Retiré ICI, choke point unique AVANT le test ET la compilation —
  // `readFileSync(...,'utf8')` ne le retire pas (Node standard).
  const source = readFileSync(absPath, 'utf8').replace(/^\uFEFF/, '')
  // une entry .civet BRUTE n'a AUCUNE directive MJS : Civet compile quand même
  // `@import a './a.civet'` en `this.import(a("./a.civet"))` (appel de méthode ordinaire, `@import`
  // lu comme décorateur+identifiant), erreur seulement au runtime et sans rapport avec la vraie
  // cause — refusé ICI, avant toute tentative de compilation. Masquage commentaires/chaînes d'abord
  // (même garde que extractServerImports plus haut) : un `# @import x '...'` affiché en exemple ne
  // doit jamais déclencher ce refus.
  const directiveMatch = maskCommentsAndStrings(source).match(/^[ \t]*@(import|css|routes|i18n|i18nPlaceholder|display|lang)\b/m)
  if (directiveMatch) throw new Error(t('cli.entry-civet-brut-directive', { entryPath: absPath, directive: `@${directiveMatch[1]}` }))
  const { getAdapter } = await import('../languages/index.js')
  let result: CompileResult
  try {
    result = await getAdapter('civet').compileToJs(source, { fileName: absPath })
  } catch (err) {
    throw new Error(t('cli.ws.erreur-compilation-civet', { entryPath: absPath, erreur: errText(err) }))
  }
  return writeCacheFile(absPath, root, result.code, result.map)
}
