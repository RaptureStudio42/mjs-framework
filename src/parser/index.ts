// parser HTML — port consolidé de la V1 Ruby, parser_html.rb
// + sous-modules (parser_html/{dom,attributes,flow,parser_utils}.rb, node.rb)
//
// Port à l'identique. Output AST identique à V1.

import { t } from '../messages/index.js'
import { RESERVED_SYMBOL_NAMES } from '../generator/reserved-symbols.js'
import { ouvreUneRegex } from '../sigils.js'

export type NodeType = 'root' | 'tag' | 'text' | 'expr' | 'if' | 'for' | 'await' | 'key' | 'const'

export type AttrType = 'static' | 'dynamic' | 'boolean' | 'spread'

export interface Attr {
  type: AttrType
  name?: string
  val?: string
  expr?: string
}

// référence à un composant repérée pendant le parsing (raccourci `@x`,
// ou balise littérale `mjs-x`/`mjs-core-x` écrite à la main dans le gabarit).
// Collectée par `resolveTagName` ci-dessous, consommée par la post-passe de
// validation du bundler (bundler/index.ts, APRÈS le manifeste complet) —
// jamais résolue ICI, le parseur ne connaît pas les autres fichiers.
// Notation UNIQUE `<@x>` (résolution projet PUIS cœur, bundler/index.ts) :
// `raccourci-coeur` disparaît, remplacé par `raccourci-mjs-retire` — l'ancienne
// forme `<@mjs-x>` est désormais une ERREUR DE MIGRATION (pas une résolution).
export type TagRefKind = 'raccourci-dev' | 'raccourci-mjs-retire' | 'litteral-dev' | 'litteral-coeur'

export interface TagRef {
  name: string
  kind: TagRefKind
  // variants — valeur LITTÉRALE d'un `layout="…"`/`template="…"` posé sur CETTE
  // balise précise (posée par parseDom, après resolveTagName ET parseAttrs). Absent si
  // l'attribut est absent, dynamique (`layout={expr}`, non vérifiable au build) ou booléen.
  layoutLiteral?: string
}

export interface Branch {
  type?: 'pending' | 'success' | 'error'
  arg?: string
  expr?: string | null
  children: Node[]
}

export class Node {
  type: NodeType
  name: string | null = null
  children: Node[] = []
  attrs: Attr[] = []
  expr: string | null = null
  item: string | null = null
  index: string | null = null
  iterable: string | null = null
  key: string | null = null
  content: string | null = null
  branches: Branch[] = []
  _is_raw?: boolean
  line?: number  // ligne d'origine (tag/text/expr) — lue par hoistFillBlocks pour ses messages

  constructor(type: NodeType) {
    this.type = type
  }
}

// directive bloc de slot (`<@fill nom>…</@fill>`) : toute occurrence du mot passe par CETTE
// constante. Cf. hoistFillBlocks plus bas.
export const FILL_DIRECTIVE = 'fill'
const FILL_TAG_NAME = `@${FILL_DIRECTIVE}`

const VOID_TAGS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
                   'link', 'meta', 'param', 'source', 'track', 'wbr']

const RESERVED_TEMPLATE_NAMES = [
  'node', 'el', 'e', 'dirty', 'this', 'arguments',
  '__nodes', '__idx',
  // identifiants émis par le tplFn d'un {for} : un item/index ainsi nommé
  // collisionnerait avec le code généré (redéclaration / clash de paramètre).
  //
  // `__arr` retiré (0 émission nulle part dans src/, hors
  // sa propre entrée ici — vérifié via `rg -a`, résistant aux fichiers
  // signalés binaires par un `grep` classique). `__built`/`_item`, EUX,
  // restent bien réservés : ils avaient été signalés à tort comme fantômes
  // — une recherche grep standard les MANQUE dans generator/compile.ts, qui
  // contient des octets NUL littéraux (marqueurs `maskDocBlocks` ailleurs
  // dans le fichier) faisant classer tout le fichier comme binaire. Ils sont
  // en réalité activement émis (generator/compile.ts, runtime/mjs_element.ts)
  // — les retirer aurait RÉOUVERT une collision silencieuse.
  'updateFn', '__built', 'refs', 'fragment', '_mjsThis', '_item', '_f',
  // temps internes du chemin des BINDINGS FILTRÉS
  // (attributes/index.ts:198/1456/1615 : `const __k = ${keyExpr}`, `__fns`, `__f0`,
  // `__f`). Un item {for} ainsi nommé produisait `const __k = __k.id` → TDZ
  // silencieux (liste vidée, erreur avalée par _mjs_reconcileList). Réservés comme
  // __idx/__nodes/__built (même famille de temporaires internes).
  '__k', '__fns', '__f0', '__f'
  // NB — `v`/`startNode`/`endNode`/`cfn` (tueurs confirmés) ne sont PAS ajoutés ici : le fix
  // choisi est de renommer les temporaires internes en `_mjs_*`
  // (generator/compile.ts : compileIf/compileKey), pas d'interdire ces noms
  // au dev — ils sont désormais des choix d'item PARFAITEMENT valides.
  // Vérifié runtime : tests/reserved-names-collision.test.ts.
]

// ============================================================================
// StringScanner — port minimal du StringScanner Ruby
// ============================================================================
// PERF — `scan`/`check` recompilaient `new RegExp('^(?:'+src+')')`
// à CHAQUE appel (~182 k constructions pour parser 100 Ko : `new RegExp(string)`
// n'est PAS mise en cache par V8). On mémoïse l'ancrée par `source\0flags` :
// ~20 motifs constants + quelques dizaines de fermetures dynamiques de tag.
const ANCHOR_CACHE = new Map<string, RegExp>()
function anchored(re: RegExp): RegExp {
  const key = re.source + '\0' + re.flags
  let a = ANCHOR_CACHE.get(key)
  if (a === undefined) {
    let src = re.source
    if (src.startsWith('^')) src = src.slice(1)
    a = new RegExp('^(?:' + src + ')', re.flags.replace('g', ''))
    ANCHOR_CACHE.set(key, a)
  }
  return a
}

export class Scanner {
  str: string
  pos: number
  last: RegExpExecArray | null
  // cache paresseux des offsets de saut de ligne, UN par instance : `str`
  // ne change jamais après construction (cf. `lineAt` plus bas, seul lecteur).
  _lineOffsets: number[] | null = null

  constructor(str: string) {
    this.str = str
    this.pos = 0
    this.last = null
  }

  eos(): boolean { return this.pos >= this.str.length }
  rest(): string { return this.str.slice(this.pos) }
  peek(n: number): string { return this.str.slice(this.pos, this.pos + n) }

  getch(): string | undefined {
    const c = this.str[this.pos]
    if (c !== undefined) this.pos += 1
    return c
  }

  scan(re: RegExp): string | null {
    const m = anchored(re).exec(this.rest())
    if (!m) return null
    this.last = m
    this.pos += m[0].length
    return m[0]
  }

  check(re: RegExp): boolean {
    return anchored(re).test(this.rest())
  }

  group(n: number): string | undefined {
    return this.last?.[n]
  }
}

// ============================================================================
// Helpers
// ============================================================================
// ouvreUneRegex — DÉPLACÉE dans sigils.ts : l'heuristique (regex après un
// signe/mot-clé/début, division après une valeur) est désormais PARTAGÉE avec le lexer
// (scanInertAt + règle 3.1a) et le générateur (mapCodeSegments), qui ignoraient jusque-là
// les littéraux regex (`/§/` levait la garde « § nu », `/µTotal/` sortait réécrit). Import
// en tête de fichier ; comportement inchangé ici.

// consomme un commentaire (`//` jusqu'au saut de ligne, `/* */` jusqu'au terminateur) — le `/`
// ouvrant est DÉJÀ consommé par l'appelant. `stopChar` = le délimiteur fermant de l'expression qui
// contient le commentaire : un commentaire de LIGNE s'y arrête aussi, sans le consommer.
function avaleCommentaire(scanner: Scanner, bloc: boolean, stopChar?: string): string {
  let res = ''
  while (!scanner.eos()) {
    // La forme NATURELLE d'un attribut tient sur UNE ligne : dans `{$x // texte}`, le
    // `}` est la fin de l'EXPRESSION, jamais du commentaire. Sans cet arrêt il partait dans le
    // commentaire, l'expression n'était jamais refermée, et la garde « non fermée » levait
    // sur du code qui compilait la veille. Le délimiteur n'est PAS consommé : l'appelant le relit
    // et décrémente son compteur d'équilibrage lui-même.
    if (!bloc && stopChar !== undefined && scanner.peek(1) === stopChar) break
    const c = scanner.getch()!
    res += c
    if (!bloc && c === '\n') break
    if (bloc && c === '*' && scanner.peek(1) === '/') { res += scanner.getch()!; break }
  }
  return res
}

// consomme une regex littérale et ses drapeaux — le `/` ouvrant est DÉJÀ consommé. Une classe
// `[…]` protège le `/` (`/[/'"]/`), un `\` échappe le caractère suivant, et les accolades d'un
// quantificateur (`/a{2,3}/`) ne comptent donc plus dans l'équilibrage.
// Sœur de `scanRegexLiteral` (sigils.ts, MÊME heuristique de fond) : coexistent plutôt que
// fusionnées — celle-ci avance un `Scanner` à position mutable, l'autre rend un index sur
// une chaîne brute (lexer/générateur, qui n'ont pas de Scanner).
function avaleRegex(scanner: Scanner): string {
  let res = ''
  let classe = false
  while (!scanner.eos()) {
    const c = scanner.getch()!
    res += c
    if (c === '\\') { const suivant = scanner.getch(); if (suivant !== undefined) res += suivant; continue }
    if (c === '[') { classe = true; continue }
    if (c === ']') { classe = false; continue }
    if (c === '/' && !classe) break
  }
  const drapeaux = scanner.scan(/[a-z]*/)                 // gimsuyvd
  return res + (drapeaux ?? '')
}

export function extractBalanced(scanner: Scanner, closeChar: string): string {
  const openChar  = closeChar === '}' ? '{' : '('
  const startPos  = scanner.pos                             // position de l'OUVERTURE (convertie en ligne SEULEMENT si on lève)
  let balance = 1
  let res = ''
  let inString = false
  let stringChar: string | null = null
  // L'échappement `\` SAUTE le caractère suivant (au lieu du test
  // rétrospectif `res[-1] !== '\\'`, faux dès qu'un `\\` LITTÉRAL précède la
  // quote : `'c:\\'` était jugé non fermé → tout le HTML suivant avalé).
  let skipNext = false

  while (!scanner.eos()) {
    const ch = scanner.getch()
    if (ch === undefined) break

    if (inString) {
      // échappement d'ABORD : un `\$` juste avant `${` reste un `$` littéral, pas une interpolation
      if (skipNext) { skipNext = false; res += ch; continue }
      if (ch === '\\') { skipNext = true; res += ch; continue }
      // un backtick est une CHAÎNE OPAQUE pour ce scanner : sans ce garde-fou, le
      // premier AUTRE backtick croisé (même niché dans une chaîne `'…'` À L'INTÉRIEUR d'un `${…}`,
      // ex. `` `a${ 'x`y' }b` ``) refermait la chaîne au mauvais endroit → fausse « chaîne non
      // fermée ». Remède : `${` ouvre une récursion sur CE MÊME scanner (chaîne/regex/commentaire
      // dans l'interpolation gérés pareil qu'au premier niveau), `}` la referme.
      if (stringChar === '`' && ch === '$' && scanner.peek(1) === '{') {
        scanner.getch()                                        // consomme le `{`
        const corps = extractBalanced(scanner, '}')
        res += '${' + corps + '}'
        continue
      }
      res += ch
      if (ch === stringChar) { inString = false; stringChar = null }
      continue
    }

    // hors chaîne : un `/` peut ouvrir un commentaire ou une regex — sans ça, un guillemet dedans
    // (`/['"]/g`, `/* isn't */`) ouvrait une chaîne FANTÔME qui ne se refermait jamais et avalait
    // tout le document (panne muette avant la garde, faux refus après elle)
    if (ch === '/') {
      const suivant = scanner.peek(1)
      if (suivant === '/' || suivant === '*') { res += ch + avaleCommentaire(scanner, suivant === '*', closeChar); continue }
      if (ouvreUneRegex(res)) { res += ch + avaleRegex(scanner); continue }
    }

    if (ch === '"' || ch === "'" || ch === '`') { inString = true; stringChar = ch; res += ch; continue }
    if (ch === openChar) balance += 1
    else if (ch === closeChar) { balance -= 1; if (balance === 0) break }
    res += ch
  }

  // Sortie par FIN DE FICHIER = délimiteur jamais refermé. Sans cette garde l'expression
  // avalait tout le HTML suivant et le composant compilait « AVEC SUCCÈS » sur un template VIDE :
  // le nœud entier disparaissait sans un mot (mesuré sur `@flip={…'ab\}`, `@style.color={'ab\}`,
  // `title={'ab\}`, `@class{'ab\}` — 0 erreur, `_mjs_cloneTpl("")`). Une compilation verte qui rend
  // du vide est le pire signal possible : on lève, en situant l'OUVERTURE.
  if (inString) throw new Error(t('parser.chaine-non-fermee', { ligne: lineAt(scanner, startPos), quote: stringChar ?? '', extrait: apercuExpr(res) }))
  if (balance !== 0) throw new Error(t('parser.delimiteur-non-ferme', { ligne: lineAt(scanner, startPos), ouvrant: openChar, fermant: closeChar, extrait: apercuExpr(res) }))

  return res
}

// aperçu du texte avalé pour le message d'erreur : une ligne, borné
function apercuExpr(res: string): string {
  const plat = res.replace(/\s+/g, ' ').trim()
  return plat.length > 60 ? `${plat.slice(0, 60)}…` : plat
}

// `str.slice(0, pos).match(/\n/g)` était O(n) par appel, appelé pour
// CHAQUE nœud : quadratique sur un HTML volumineux. Remède : les offsets de `\n` sont indexés UNE
// fois par `Scanner` (paresseux, au premier appel), puis une recherche dichotomique donne le
// numéro de ligne — même résultat que l'ancienne formule (`\r\n` inclus : seul le `\n` compte
// dans les deux, le `\r` n'a jamais eu d'effet).
function lineOffsets(scanner: Scanner): number[] {
  if (scanner._lineOffsets === null) {
    const offsets: number[] = []
    const str = scanner.str
    for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) === 10) offsets.push(i)
    scanner._lineOffsets = offsets
  }
  return scanner._lineOffsets
}

function lineAt(scanner: Scanner, pos: number): number {
  const offsets = lineOffsets(scanner)
  // recherche du premier offset >= pos (borne inférieure) : sa position dans le
  // tableau EST le nombre de sauts de ligne strictement avant `pos`
  let lo = 0
  let hi = offsets.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (offsets[mid] < pos) lo = mid + 1
    else hi = mid
  }
  return lo + 1
}

function currentLine(scanner: Scanner): number {
  return lineAt(scanner, scanner.pos)
}

// familles de temporaires SUFFIXÉS réellement émis par le générateur
// (`__arr_0`/`__idx_1` du {for}, `_nref_*`/`_c_*` de compile.ts, tout `_mjs_*`) :
// la liste `RESERVED_TEMPLATE_NAMES` ne protège que des noms EXACTS, un item de
// boucle `__arr_0` collisionnerait sans que rien ne l'attrape.
const RESERVED_PREFIX_RE = /^(?:__arr_|__idx_|_nref_|_mjs_|_c_)/

function rejectReservedName(kind: string, name: string | null | undefined, line: number): void {
  const clean = (name ?? '').toString().trim()
  if (clean === '') return
  // une liaison de TEMPLATE ($, $$, µ : item/index de {for}, nom de {const},
  // arg de {success}/{error}) colle avec les symboles du framework, même famille que la garde du
  // JS déjà compilé (generator/reserved-symbols.ts) — liste PARTAGÉE, jamais redite ici
  if (RESERVED_SYMBOL_NAMES.has(clean)) throw new Error(t('parser.symbole-reserve-template', { ligne: line, nom: clean, kind }))
  if (!RESERVED_TEMPLATE_NAMES.includes(clean) && !RESERVED_PREFIX_RE.test(clean)) return
  const altMap: Record<string, string> = {
    'node': 'n', 'el': 'item', 'e': 'evt', 'dirty': 'flag', 'this': 'self'
  }
  const alt = altMap[clean] ?? `${clean}_`
  throw new Error(t('parser.nom-reserve', { ligne: line, bloc: kind, nom: clean, alt, listeNoms: RESERVED_TEMPLATE_NAMES.join(', ') }))
}

function raiseUnclosedBlock(kind: string, expr: string, line: number): never {
  let hint = ''
  switch (kind) {
    case 'if':
      hint = t('parser.astuce-if-ternaire')
      break
    case 'for':
      hint = t('parser.astuce-for-end')
      break
    case 'await':
      hint = t('parser.astuce-await-end')
      break
    case 'key':
      hint = t('parser.astuce-key-end')
      break
  }
  throw new Error(t('parser.bloc-non-ferme', { kind, expr, ligne: line, astuce: hint }))
}

// ============================================================================
// Attributes parser
// ============================================================================
// Attributs HTML5 réellement booléens (présence = true, valeur ignorée) — cf. WHATWG "Boolean
// attributes". Utilisé UNIQUEMENT pour un attribut NU (pas de `=`) : réécrit en
// {type:'dynamic', expr:'true'} (même chemin de génération que `disabled={expr}`) au lieu de
// {type:'boolean'} (marqueur inerte). Liste NEUVE, à ne pas confondre avec MJS_BOOLEAN_PROPS
// (generator/attributes/index.ts, generator/compile.ts) : cette dernière décide
// property-vs-attribute pour LE CODEGEN d'un attribut déjà dynamique/two-way — un problème
// différent, ne pas y toucher, ne pas essayer de les fusionner.
const MJS_NATIVE_BOOLEAN_ATTRS = new Set([
  'allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls',
  'default', 'defer', 'disabled', 'formnovalidate', 'hidden', 'inert',
  'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate',
  'open', 'playsinline', 'readonly', 'required', 'reversed', 'selected',
])

function parseAttrs(scanner: Scanner, node: Node): void {
  // filet générique anti-duplication : un NOM d'attribut vu deux fois sur
  // CETTE balise → erreur. Comparaison telle quelle (casse conservée, la casse est traitée
  // ailleurs) ; `@class{cond}`/`@style.prop{cond}` incluent la condition dans le nom (construit
  // plus bas), deux conditions différentes ne collisionnent donc jamais. Complète (ne remplace
  // pas) transpiler.directive-dupliquee (preprocessHtml, transpiler/index.ts) qui ne voit que
  // SES marqueurs `@…=` reconnus — celui-ci voit la liste d'attributs déjà parsée, quelle que
  // soit la forme d'origine (y compris un attribut déjà réécrit type mjs-confirm).
  const seenAttrNames = new Set<string>()
  const checkAttrDuplicate = (name: string): void => {
    if (seenAttrNames.has(name)) throw new Error(t('parser.attribut-duplique', { attribut: name, tag: node.name, ligne: currentLine(scanner) }))
    seenAttrNames.add(name)
  }

  while (true) {
    if (scanner.eos() || scanner.check(/\s*\/?>/)) break
    scanner.scan(/\s+/)

    if (scanner.scan(/\{(?:\.\.\.)/)) {
      const expr = extractBalanced(scanner, '}')
      node.attrs.push({ type: 'spread', expr: expr.trim() })
      continue
    }

    // Token `{expr}` nu (sans `...`, sans `name=` devant) — attribut dynamique
    // anonyme. Seul `<@slot {expr}>` le consomme (nom de slot évalué), et la
    // directive bloc de slot (FILL_TAG_NAME) — nom dynamique accepté ICI, rejeté
    // ensuite par hoistFillBlocks (nom LITTÉRAL exigé, message dédié).
    // Sur tout autre tag il était SILENCIEUSEMENT jeté (le générateur l'ignore) :
    // un `<div {$cls}>` (habitude Svelte, où `{cls}` ≡ `cls={cls}`) perdait son
    // attribut sans trace → erreur claire plutôt que perte muette.
    if (scanner.check(/\{/)) {
      scanner.scan(/\{/)
      const expr = extractBalanced(scanner, '}')
      if (node.name !== 'slot' && node.name !== FILL_TAG_NAME) {
        const line = currentLine(scanner)
        throw new Error(t('parser.attribut-nu-non-supporte', { expr: expr.trim(), ligne: line, tag: node.name }))
      }
      node.attrs.push({ type: 'dynamic', expr: expr.trim() })
      continue
    }

    if (scanner.scan(/@(class|style\.[a-zA-Z0-9\-]+)\{/)) {
      const prefix = scanner.group(1)!
      const expr = extractBalanced(scanner, '}')
      const name = `@${prefix}{${expr}}`
      checkAttrDuplicate(name)

      if (scanner.scan(/\s*=\s*/)) {
        if (scanner.scan(/"([^"]*)"/)) {
          node.attrs.push({ type: 'static', name, val: scanner.group(1) })
        } else if (scanner.scan(/'([^']*)'/)) {
          node.attrs.push({ type: 'static', name, val: scanner.group(1) })
        } else if (scanner.scan(/((?:[^\s>\/]|\/(?!>))+)/)) {
          // une valeur non quotée s'arrêtait à `>` mais avalait le `/`
          // d'un `/>` : `<img src=x/>` → val `"x/"`. On exclut le seul `/`
          // IMMÉDIATEMENT suivi de `>` (auto-fermeture) ; un `/` interne (URL
          // `http://…`) reste dans la valeur.
          node.attrs.push({ type: 'static', name, val: scanner.group(1) })
        }
      } else {
        node.attrs.push({ type: 'boolean', name })
      }
      continue
    }

    // `_` ajouté au charset des noms d'attribut : sans lui, le scan
    // s'arrêtait au `_`, `data-user_id="3"` devenait `data-user` + `id="3"`
    // (l'`id` NATIF de l'élément écrasé) ; l'underscore est valide en HTML et
    // imposé par la convention snake_case maison (`data-` compris).
    if (scanner.scan(/([a-zA-Z0-9:@\-\._]+)/)) {
      const name = scanner.group(1)!
      checkAttrDuplicate(name)
      if (scanner.scan(/\s*=\s*/)) {
        if (scanner.scan(/\{/)) {
          const val = extractBalanced(scanner, '}')
          node.attrs.push({ type: 'dynamic', name, expr: val })
        } else if (scanner.scan(/"([^"]*)"/)) {
          node.attrs.push({ type: 'static', name, val: scanner.group(1) })
        } else if (scanner.scan(/'([^']*)'/)) {
          node.attrs.push({ type: 'static', name, val: scanner.group(1) })
        } else if (scanner.scan(/((?:[^\s>\/]|\/(?!>))+)/)) {
          // une valeur non quotée s'arrêtait à `>` mais avalait le `/`
          // d'un `/>` : `<img src=x/>` → val `"x/"`. On exclut le seul `/`
          // IMMÉDIATEMENT suivi de `>` (auto-fermeture) ; un `/` interne (URL
          // `http://…`) reste dans la valeur.
          node.attrs.push({ type: 'static', name, val: scanner.group(1) })
        }
      } else if (!name.startsWith('@') && !(node.name ?? '').includes('-') && node.name !== 'slot' && node.name !== FILL_TAG_NAME && MJS_NATIVE_BOOLEAN_ATTRS.has(name)) {
        // Attribut HTML5 booléen nu (`<input disabled>`, `<ol reversed>`…) — pas de `@` (laisse
        // `<details @open>` intact, chemin existant), pas sur `<@slot>` NI `<@fill>`
        // (leur 1er attribut nu a déjà un sens réservé — nom de
        // slot ; `default` est à la fois booléen HTML5 valide et nom de slot plausible, cf.
        // `<@slot default>` ET `<@fill default>`). Réécrit en dynamique littéral `true` → même
        // chemin de génération que `disabled={expr}`.
        // Tag À TIRET EXCLU (composant MJS, `<@view>` → `metamjs-view`, web component tiers) :
        // le générateur y route tout attribut dynamique vers `node._set(nom, v)` / `node[nom]=v`
        // (dynamic(), generator/attributes/index.ts `isWc`) au lieu de l'écrire dans le
        // template — `<mjs-enfant hidden>` perdait alors son attribut et n'était PLUS caché.
        // Sur ces tags l'attribut nu reste donc `type:'boolean'`, écrit littéralement.
        node.attrs.push({ type: 'dynamic', name, expr: 'true' })
      } else {
        node.attrs.push({ type: 'boolean', name })
      }
      continue
    }

    scanner.getch()
  }
}

// ============================================================================
// Flow parser ({if} {for} {await} {key})
// ============================================================================
let currentBranchArg: string | null = null
let currentElsifExpr: string | null = null

type ChildrenParser = (container: Node[]) => string | undefined

function parseFlow(scanner: Scanner, container: Node[], parseChildren: ChildrenParser): boolean | string {
  if (scanner.scan(/\{await\s+/)) {
    const startLine = currentLine(scanner)
    const node = new Node('await')
    node.line = startLine  // même geste que tag/expr : posée sur LE NŒUD lui-même, plus de nearestLine côté générateur
    node.expr = extractBalanced(scanner, '}').trim()
    let currentBranch: Branch = { type: 'pending', children: [] }
    node.branches.push(currentBranch)
    let sawEnd = false
    while (!scanner.eos()) {
      const posBefore = scanner.pos
      const res = parseChildren(currentBranch.children)
      if (res === 'success') {
        currentBranch = { type: 'success', arg: currentBranchArg ?? undefined, children: [] }
        node.branches.push(currentBranch)
      } else if (res === 'error') {
        currentBranch = { type: 'error', arg: currentBranchArg ?? undefined, children: [] }
        node.branches.push(currentBranch)
      } else if (res === 'end') {
        sawEnd = true
        break
      }
      // garde-fou anti-boucle infinie : une fermante orpheline dans le
      // bloc (`{await …}</div>{end}`) fait remonter `'close_tag'` SANS consommer
      // → `scanner.pos` fige. Toute non-progression = bloc non fermé.
      if (scanner.pos === posBefore) break
    }
    if (!sawEnd) raiseUnclosedBlock('await', node.expr, startLine)
    container.push(node)
    return true
  }

  if (scanner.scan(/\{success\s+/)) {
    const line = currentLine(scanner)
    currentBranchArg = extractBalanced(scanner, '}').trim()
    rejectReservedName('success', currentBranchArg, line)
    return 'success'
  }

  if (scanner.scan(/\{error\s+/)) {
    const line = currentLine(scanner)
    currentBranchArg = extractBalanced(scanner, '}').trim()
    rejectReservedName('error', currentBranchArg, line)
    return 'error'
  }

  if (scanner.scan(/\{if\s+/)) {
    const startLine = currentLine(scanner)
    const node = new Node('if')
    node.line = startLine  // cf. commentaire jumeau sur {await} ci-dessus
    const firstExpr = extractBalanced(scanner, '}').trim()
    let currentBranch: Branch = { expr: firstExpr, children: [] }
    node.branches.push(currentBranch)
    let sawEnd = false
    while (!scanner.eos()) {
      const posBefore = scanner.pos
      const res = parseChildren(currentBranch.children)
      if (res === 'elsif') {
        currentBranch = { expr: currentElsifExpr, children: [] }
        node.branches.push(currentBranch)
      } else if (res === 'else') {
        currentBranch = { expr: null, children: [] }
        node.branches.push(currentBranch)
      } else if (res === 'end') {
        sawEnd = true
        break
      }
      // voir {await} : une fermante orpheline (`{if $x}</div>{end}`)
      // remontait `'close_tag'` sans avancer → boucle infinie 100 % CPU.
      if (scanner.pos === posBefore) break
    }
    if (!sawEnd) raiseUnclosedBlock('if', firstExpr, startLine)
    container.push(node)
    return true
  }

  if (scanner.scan(/\{elsif\s+/)) {
    currentElsifExpr = extractBalanced(scanner, '}').trim()
    return 'elsif'
  }

  if (scanner.scan(/\{else\}/)) return 'else'
  if (scanner.scan(/\{end\}/)) return 'end'

  // `{key}` aligné sur `{if}` : (a) l'expr passe par `extractBalanced`
  // (l'ancien `\{key\s+(.+?)\}` tronquait `{key f({a:1})}` au 1er `}`), (b) le
  // `{end}` est désormais EXIGÉ (un `{key}` non fermé absorbait la suite en
  // silence et volait le `{end}` d'un bloc parent), (c) même garde anti-boucle
  // contre une fermante orpheline dans le corps.
  if (scanner.scan(/\{key\s+/)) {
    const startLine = currentLine(scanner)
    const node = new Node('key')
    node.line = startLine  // cf. commentaire jumeau sur {await} plus haut
    node.expr = extractBalanced(scanner, '}').trim()
    let sawEnd = false
    while (!scanner.eos()) {
      const posBefore = scanner.pos
      const res = parseChildren(node.children)
      if (res === 'end') { sawEnd = true; break }
      if (scanner.pos === posBefore) break
    }
    if (!sawEnd) raiseUnclosedBlock('key', node.expr, startLine)
    container.push(node)
    return true
  }

  // `{const NOM = EXPR}` — déclaration de constante LOCALE (≡ `{@const}` Svelte).
  // Ne crée AUCUN nœud texte : juste une liaison réutilisable dans les
  // interpolations SUIVANTES du même bloc (cas principal : un `{for}`). On lit
  // le nom puis l'expression via extractBalanced (gère les `}` dans strings /
  // accolades imbriquées de l'EXPR, ex: `{const o = {a: 1}}`).
  if (scanner.scan(/\{const\s+/)) {
    const line = currentLine(scanner)
    // Le nom doit précéder le PREMIER `=` qui n'est ni `==`/`=>` etc.
    if (!scanner.scan(/([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=(?![=>])\s*/)) {
      throw new Error(t('parser.const-syntaxe-invalide', { ligne: line }))
    }
    const node = new Node('const')
    node.line = line  // cf. commentaire jumeau sur {await} plus haut
    node.name = scanner.group(1)!.trim()
    node.expr = extractBalanced(scanner, '}').trim()
    rejectReservedName('const', node.name, line)
    if (node.expr === '') {
      throw new Error(t('parser.const-expression-vide', { nom: node.name, ligne: line }))
    }
    container.push(node)
    return true
  }

  if (scanner.scan(/\{for\s+/)) {
    const startLine = currentLine(scanner)
    const expr = extractBalanced(scanner, '}').trim()
    // µ admis dans la classe de caractères (au même titre que $) : un item/index
    // ainsi nommé matche la syntaxe et passe par rejectReservedName ci-dessous, plutôt que de
    // tomber dans le message de syntaxe générique
    const m = expr.match(/^(?:([a-zA-Z0-9_$µ]+)\s*,\s*)?([a-zA-Z0-9_$µ]+)\s+in\s+(.+?)(?:\s+by\s+([a-zA-Z0-9_$µ]+))?$/)
    if (m) {
      const node = new Node('for')
      node.line = startLine  // cf. commentaire jumeau sur {await} plus haut
      // Si l'ITEM s'appelle `index` (sans index explicite), le compteur
      // implicite prend un nom interne — sinon le générateur émettrait
      // `(index, index) =>` : paramètres dupliqués = SyntaxError en module ES.
      node.index = m[1] ?? (m[2] === 'index' ? '_mjs_i' : 'index')
      node.item = m[2]
      node.iterable = m[3].trim()
      node.key = m[4] ?? null
      rejectReservedName('for', node.item, startLine)
      if (m[1]) rejectReservedName('for', node.index, startLine)
      // item et index homonymes : `{for x, x in …}` émettrait `(x, x) =>`
      // (clash de paramètres = SyntaxError). Rejet avec message clair.
      if (m[1] && node.item === node.index) {
        throw new Error(t('parser.for-item-index-homonyme', { item: node.item, index: node.index, ligne: startLine }))
      }
      let sawEnd = false
      while (!scanner.eos()) {
        const posBefore = scanner.pos
        const res = parseChildren(node.children)
        if (res === 'end') { sawEnd = true; break }
        // fermante orpheline dans le {for} : `'close_tag'` sans progrès.
        if (scanner.pos === posBefore) break
      }
      if (!sawEnd) raiseUnclosedBlock('for', expr, startLine)
      container.push(node)
    } else {
      // Avant ce throw, un `{for}` non reconnu était avalé SANS erreur : aucun
      // nœud poussé, et son `{end}` fermait le bloc PARENT → template mutilé
      // en silence. Cas typique : `{for x of arr}` (habitude JS).
      const hint = /\s+of\s+/.test(expr) ? t('parser.for-astuce-in-pas-of') : ''
      throw new Error(t('parser.for-syntaxe-invalide', { expr, ligne: startLine, astuceOf: hint }))
    }
    return true
  }

  return false
}

// ============================================================================
// DOM parser
// ============================================================================
// les 12 balises réservées (include/slot/head/body/html/document/
// window/element/module/failed/view/FILL_DIRECTIVE) sont normalement consommées
// EN AMONT (macros.ts, processIncludes, ou la regex `preprocess` de
// generator/compile.ts pour @view) avant que le HTML n'atteigne ce parseur. Si
// l'une d'elles l'atteint quand même (@view/@slot en usage direct courant, ou
// un cas non couvert par les regex macro), on la laisse INTACTE — comportement
// historique préservé, jamais réécrite en raccourci composant. La
// directive bloc de slot (FILL_DIRECTIVE) suit EXACTEMENT le même chemin :
// `</@…>` obligatoire (jamais la forme nue, ni `mjs-…`) — voir
// hoistFillBlocks plus bas, qui la déplie APRÈS coup.
// Exportée : réutilisée par bundler/index.ts (resolveTagShortcuts) — mêmes 12
// noms pour les gardes de post-passe (fichier projet nommé comme une réservée)
// et l'union de suggestion levenshtein, source unique.
export const AT_RESERVED_NAMES = ['include', 'slot', 'head', 'body', 'html', 'document',
                                   'window', 'element', 'module', 'failed', 'view', FILL_DIRECTIVE]

// resolveTagName — réécrit `<@nom>` en `<mjs-nom>` (raccourci-dev, résolu par
// le bundler EN PROJET PUIS EN CŒUR), en enregistrant
// chaque référence dans `tagRefs` (push, pas de retour — la post-passe du
// bundler résout APRÈS avoir vu tous les fichiers). `<@mjs-nom>` (ancienne
// notation dédiée au cœur, RETIRÉE) est une ERREUR DE MIGRATION — kind
// `raccourci-mjs-retire`, name = le nom SANS le préfixe `mjs-` ; l'émission
// (`mjs-<nom>`) n'a plus d'importance, le build échouera à la post-passe. Une
// balise littérale `mjs-nom`/`mjs-core-nom` (sans `@`, écrite à la main) est
// aussi enregistrée, SANS réécriture (déjà sous sa forme finale).
function resolveTagName(rawName: string, tagRefs?: TagRef[]): string {
  if (rawName === '@view') return 'metamjs-view'
  if (rawName === '@slot') return 'slot'

  if (rawName.startsWith('@')) {
    const bare = rawName.slice(1)
    if (AT_RESERVED_NAMES.includes(bare)) return rawName  // réservée échappée aux macros → intacte
    if (bare.startsWith('mjs-')) {
      const nom = bare.slice('mjs-'.length)
      tagRefs?.push({ name: nom, kind: 'raccourci-mjs-retire' })
      return `mjs-${nom}`
    }
    tagRefs?.push({ name: bare, kind: 'raccourci-dev' })
    return `mjs-${bare}`
  }

  const lower = rawName.toLowerCase()
  if (lower.startsWith('mjs-core-')) {
    tagRefs?.push({ name: rawName.slice('mjs-core-'.length), kind: 'litteral-coeur' })
  } else if (lower.startsWith('mjs-')) {
    tagRefs?.push({ name: rawName.slice('mjs-'.length), kind: 'litteral-dev' })
  }
  return rawName
}

// sonde SANS consommation : la balise raccourci ouverte va-t-elle un jour se
// refermer (comptage équilibré du même nom, profondeur initiale 1, ouvrantes <@x/<mjs-x
// vs fermantes </@x>/</mjs-x>) ? Position sauvegardée puis restaurée — rejoue le
// sous-ensemble tag-scanning de parseDom/parseAttrs sur le SCANNER RÉEL plutôt qu'un
// regex naïf sur une sous-chaîne : une valeur d'attribut piégeuse (`title="a > b"`) ne
// fausse pas le comptage, et une occurrence AUTOFERMANTE du même nom ne compte pas comme
// une ouverture en attente (net zéro). Limite assumée : une
// mention du nom dans un texte/commentaire quelconque (pas un vrai tag) peut fausser le
// comptage — pas un vrai parseur XML, jamais prétendu l'être ailleurs dans ce fichier.
function willClose(scanner: Scanner, resolvedName: string): boolean {
  const savedPos = scanner.pos
  let depth = 1
  let found = false
  while (!scanner.eos()) {
    const posBefore = scanner.pos
    if (scanner.scan(/<\/([a-zA-Z0-9\-@]+)\s*>/)) {
      if (resolveTagName(scanner.group(1)!) === resolvedName) {
        depth -= 1
        if (depth === 0) { found = true; break }
      }
    } else if (scanner.scan(/<(@[a-zA-Z0-9-]+|[a-zA-Z0-9-]+)/)) {
      const name2 = resolveTagName(scanner.group(1)!)
      const tmp = new Node('tag')
      tmp.name = name2
      parseAttrs(scanner, tmp)
      if (scanner.scan(/\s*\/>/)) {
        // auto-fermante : ouverture+fermeture dans le même token, net zéro
      } else if (VOID_TAGS.includes(name2.toLowerCase())) {
        scanner.scan(/\s*>/)
      } else if (scanner.scan(/\s*>/)) {
        if (name2 === resolvedName) depth += 1
      } else {
        break  // tag malformée : abandon prudent (void par défaut côté appelant)
      }
    } else if (!scanner.scan(/[^<]+/)) {
      scanner.getch()
    }
    if (scanner.pos === posBefore) break  // garde anti-boucle infinie
  }
  scanner.pos = savedPos
  return found
}

function parseDom(scanner: Scanner, container: Node[], parseChildren: ChildrenParser, tagRefs?: TagRef[]): boolean | string {
  // `\s*` avant `>` : le pré-check refusait tout blanc (`</div >`) alors
  // que la consommation en aval (ligne ~512) le tolère → progression nulle →
  // « ERREUR DE PARSING FATALE » cryptique. On aligne les deux.
  if (scanner.check(/<\/[a-zA-Z0-9\-@]+\s*>/)) return 'close_tag'

  if (scanner.scan(/\{\{/)) {
    const startLine = currentLine(scanner)
    const node = new Node('expr')
    const content = extractBalanced(scanner, '}')
    scanner.scan(/\}/)
    node.expr = content.trim()
    node._is_raw = true
    node.line = startLine
    container.push(node)
    return true
  }

  if (scanner.scan(/\{(?!\.\.\.)/)) {
    const startLine = currentLine(scanner)
    const node = new Node('expr')
    const content = extractBalanced(scanner, '}')
    node.expr = content.trim()
    // Piège classique (habitude JSX/Svelte) : `{else if cond}` ne matche NI
    // `{elsif ...}` NI `{else}` (tous deux stricts, cf. parseFlow ci-dessus) →
    // tombe ICI comme une expression quelconque, part côté Civet TEL QUEL et
    // explose sur une erreur cryptique (parle d'imports/exports), très loin
    // du vrai problème — composant entier tombé.
    // `\s+` laissait passer la variante SANS espace `{elseif
    // cond}` (habitude PHP/Vue tout aussi courante) : NI erreur dédiée NI
    // erreur Civet, le composant compilait EN SILENCE (sonde : 0 erreur), pire
    // que le cas déjà couvert — l'échec se serait déplacé au RUNTIME (appel
    // Civet implicite `elseif(cond)` vers une fonction inexistante). `\s*`
    // (zéro-ou-plus) couvre les deux graphies ; `\b` après `if` protège
    // toujours un identifiant légitime du type `{elseIfCount}` (bloc majuscule
    // ou soudé sans césure sur "if" isolé — cf. tests).
    if (/^else\s*if\b/.test(node.expr)) {
      throw new Error(t('parser.else-if-non-supporte', { expr: node.expr, ligne: startLine }))
    }
    node._is_raw = false
    node.line = startLine
    container.push(node)
    return true
  }

  if (scanner.scan(/<(@[a-zA-Z0-9-]+|[a-zA-Z0-9-]+)/)) {
    const node = new Node('tag')
    const rawName = scanner.group(1)!
    const tagLine = currentLine(scanner)
    node.line = tagLine

    // variants — longueur AVANT resolveTagName : si une référence vient d'être
    // empilée (balise composant, pas une réservée), on lui pose la valeur littérale de
    // layout=/template= une fois les attributs connus (pose APRÈS parseAttrs, ci-dessous).
    const tagRefsLenBefore = tagRefs?.length ?? 0
    node.name = resolveTagName(rawName, tagRefs)

    parseAttrs(scanner, node)

    if (tagRefs && tagRefs.length > tagRefsLenBefore) {
      const layoutAttr = node.attrs.find(a => a.type === 'static' && (a.name === 'layout' || a.name === 'template'))
      if (layoutAttr) tagRefs[tagRefs.length - 1].layoutLiteral = layoutAttr.val
    }

    if (rawName === '@view') {
      const first = node.attrs[0]
      if (first?.type === 'boolean') {
        const idName = first.name
        first.type = 'static'
        first.name = 'id'
        first.val = idName
      }
    }

    if (rawName === '@slot') {
      const first = node.attrs[0]
      if (first) {
        if (first.type === 'boolean') {
          // `<@slot title>` → `<slot name="title">`. Un identifiant nu est
          // TOUJOURS un nom de slot littéral — même s'il coïncide avec une
          // variable de boucle englobante. Le côté light DOM matche en écrivant
          // `slot="title"` sur l'enfant (idiome Web Components standard).
          const idName = first.name ?? ''
          first.type = 'static'
          first.name = 'name'
          first.val = idName
        } else if (first.type === 'dynamic') {
          // `<@slot {i}>` → `<slot name="{i}">`. Les accolades signalent une
          // expression évaluée (interpolation, cohérent avec `{$x}` partout en
          // MJS) → nom de slot dynamique. C'est le régime « slots indexés »
          // d'un `{for}` : `{for i, t in $tabs} <@slot {i}/> {end}`.
          const exprVal = first.expr ?? ''
          first.type = 'static'
          first.name = 'name'
          first.val = `{${exprVal}}`
        }
      }
    }

    // Note : metamjs-view n'est PAS void. Le preprocess émet
    // <metamjs-view ...></metamjs-view> (paire complète), donc le parser
    // doit lire le </metamjs-view> qui suit, sinon le closing tag est
    // interprété comme orphelin et termine prématurément le parent.
    const isVoid = VOID_TAGS.includes(node.name.toLowerCase())

    if (scanner.scan(/\s*\/>/)) {
      // généralisation de la règle <@include nom/>
      // (slash final interdit, macros.ts) à <@view> : une vue reçoit TOUJOURS
      // son contenu du routeur, une auto-fermeture n'a jamais été une forme
      // valide (contrairement à <@window>/<@document>/<@body>/<@html>, 100%
      // auto-fermées en usage réel, ou à <@slot/> — idiome légitime sans
      // contenu de repli — NI touchées ici : seul `@view` est concerné).
      if (rawName === '@view') {
        throw new Error(t('parser.view-auto-fermeture-interdite', { nom: node.attrs[0]?.val ?? '', ligne: tagLine }))
      }
      container.push(node)
    } else if (isVoid) {
      scanner.scan(/\s*>/)
      container.push(node)
    } else if (scanner.scan(/\s*>/)) {
      // forme NUE d'un raccourci `<@x>` (hors 12 réservées) SANS fermante
      // à venir (comptage équilibré, willClose ci-dessus) : VOID, comme
      // l'autofermant — aucun enfant avalé, les frères suivants restent au
      // niveau du PARENT (ni parseChildren, ni recherche d'un `</x>`).
      const isShortcutTag = rawName.startsWith('@') && !AT_RESERVED_NAMES.includes(rawName.slice(1))
      if (isShortcutTag && !willClose(scanner, node.name)) {
        container.push(node)
        return true
      }
      // MÊME carve-out que ci-dessus pour `<@slot …>`, exclu de
      // `isShortcutTag` puisque 'slot' est une réservée (AT_RESERVED_NAMES l.665) : nu et SANS
      // rien d'autre que du blanc jusqu'à EOF (jamais de `</@slot>`/`</slot>` à venir), c'est le
      // même idiome void que `<@slot/>` — documenté (docs/13-contexte.md, tuto-grille.mjs) et
      // cassé par le garde-fou balise-non-fermee, qui ne distinguait pas @slot des autres
      // réservées. `<@slot>` PORTEUR de repli (`<@slot>texte`) reste soumis à l'erreur juste en
      // dessous : le HTML impose une fermante pour délimiter où le repli s'arrête.
      if (rawName === '@slot' && scanner.check(/(?:\s|<!--[\s\S]*?-->)*$/) && !willClose(scanner, node.name)) {   // blanc OU commentaire (padding des sections retirées) jusqu'à EOF
        container.push(node)
        return true
      }
      const res = parseChildren(node.children)
      if (res === 'close_tag') {
        const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const escapedRaw = escapeRegex(rawName)
        const escapedNew = escapeRegex(node.name)
        scanner.scan(new RegExp(`<\\/(?:${escapedRaw}|${escapedNew})\\s*>`))
      } else {
        // `parseChildren` ne peut rendre que 'close_tag' ou `undefined`
        // (fin de boucle sur `scanner.eos()`, cf. sa propre implémentation dans `parse()`) : ce
        // `else` est donc TOUJOURS le cas EOF-sans-fermante. Avant ce garde-fou, `container.push`
        // suivait tel quel — la balise ouvrante partait avec TOUT LE RESTE DU DOCUMENT comme
        // descendants, sans un mot (même famille que parser.balise-fermante-orpheline, le cas
        // SYMÉTRIQUE : fermante sans ouvrante). Lève ICI, au niveau le plus PROFOND (cette balise
        // est la première dont le `parseChildren` local touche l'EOF) : la pile d'appel remonte
        // sans que les balises ouvrantes ENGLOBANTES n'aient la moindre chance de lever à leur
        // tour — le message cite donc naturellement la balise la plus profonde non fermée.
        throw new Error(t('parser.balise-non-fermee', { nom: node.name, ligne: tagLine }))
      }
      container.push(node)
    }
    return true
  }

  return false
}

// parseComment — commentaire HTML `<!-- … -->` : bloc INERTE, consommé SANS produire de
// nœud (ni texte ni expr). Sans ce garde-fou, `<!--` retombait sur
// parseText (un `<` non suivi d'un tag/fermante reste du texte, cf. TEXT_RUN_RE) : le
// contenu s'affichait dans le DOM, marqueurs compris, et une `{` dedans ouvrait une VRAIE
// expression compilée. Multi-lignes : rien à compter à la main, `currentLine`/`lineAt`
// lisent `scanner.pos` sur la source ENTIÈRE (offsets déjà indexés, cf. lineOffsets).
function parseComment(scanner: Scanner): boolean {
  if (!scanner.check(/<!--/)) return false
  const startLine = currentLine(scanner)
  if (scanner.scan(/<!--[\s\S]*?-->/)) return true
  throw new Error(t('parser.commentaire-non-ferme', { ligne: startLine }))
}

// le texte est la majorité du volume d'un template ; l'ancienne boucle
// le consommait caractère par caractère (un `getch()` + un `check()` — donc, avant
// le cache d'ancrage, une compilation de regex — PAR caractère). Un seul scan sticky
// équivalent supprime N allocations. Un `<` reste du texte SAUF s'il ouvre une
// balise (`<tag`, `</tag`, `<@…`) — négation EXACTE de l'ancien stop `<\/?[a-zA-Z@]`.
// `!--` AJOUTÉ à la négation : sans lui, un `<!--` précédé du moindre
// texte (donc jamais en toute première position, seul cas où `parseComment` l'attrapait
// AVANT que ce run ne démarre) se faisait avaler tel quel PAR CE RUN — `parseComment`
// n'avait alors plus jamais la main dessus, un `<!--` non refermé ne levait rien.
const TEXT_RUN_RE = /(?:[^{<]|<(?!\/?[a-zA-Z@]|!--))+/

function parseText(scanner: Scanner, container: Node[]): boolean {
  const startPos = scanner.pos
  const txt = scanner.scan(TEXT_RUN_RE)
  if (txt !== null && txt !== '') {
    const node = new Node('text')
    node.content = txt
    // le run avale le `\n` + l'indentation qui précèdent le texte VISIBLE : la
    // ligne du nœud est celle de son PREMIER caractère non blanc, pas celle d'AVANT ce blanc de
    // tête (sinon, en code indenté réel, un message d'erreur pointe la ligne PRÉCÉDENTE).
    const blanc = txt.match(/^\s*/)![0].length
    node.line = lineAt(scanner, startPos + blanc)
    container.push(node)
    return true
  }
  return false
}

// ============================================================================
// Fill blocks (bloc de slot) — passe après parse()
// ============================================================================
// sucre de COMPILATION, aucun changement du générateur ni du
// runtime : `<@fill nom>…</@fill>` (FILL_DIRECTIVE) se déplie en SES PROPRES ENFANTS, chacun
// porteur de `slot="nom"` (même attribut que l'idiome natif `slot="x"` posé à la main). Une fois
// cette passe tournée, le nœud `@fill` a disparu de l'arbre — tout le pipeline aval (generator,
// bundler) ne voit que des `tag` ordinaires.
//
// Choix : PASSE À PART (hoistFillBlocks), pas une branche de plus dans parseDom. parseDom gère
// déjà l'ouverture/fermeture/void d'un tag générique — la directive, réservée (AT_RESERVED_NAMES),
// suit CE chemin SANS la moindre modification (fermante `</@…>` obligatoire, comme @window/@head).
// Toute la sémantique propre au bloc (nom littéral, traversée des blocs {if}/{for}/{await}/{key},
// erreurs) reste isolée ICI, sur l'arbre déjà construit — testable seule, sans toucher au parseur
// de balises. Appelée une seule fois par `parse()`, juste avant qu'il rende son arbre : SEUL point
// de production qui construit cet arbre (generator/compile.ts, un seul appel à `parse()`).
export function hoistFillBlocks(root: Node): void {
  hoistChildren(root.children)
}

function hoistChildren(children: Node[]): void {
  for (let i = 0; i < children.length; i++) {
    const node = children[i]

    if (node.type === 'tag' && node.name === FILL_TAG_NAME) {
      const replacement = expandFillBlock(node)
      children.splice(i, 1, ...replacement)
      i -= 1  // reprend AU MÊME index : les enfants substitués prennent la place du nœud retiré
      continue
    }

    if (node.type === 'tag' || node.type === 'for' || node.type === 'key') {
      hoistChildren(node.children)
    } else if (node.type === 'if' || node.type === 'await') {
      for (const branch of node.branches) hoistChildren(branch.children)
    }
  }
}

// describeFillAttr — rend un attribut de `<@fill …>` TEL QU'ÉCRIT, pour le message d'erreur
// « un seul nom » (parser.fill-un-seul-nom) — jamais consommé ailleurs.
function describeFillAttr(a: Attr): string {
  if (a.type === 'static') return `${a.name}="${a.val}"`
  if (a.type === 'dynamic') return a.name ? `${a.name}={${a.expr}}` : `{${a.expr}}`
  if (a.type === 'spread') return `{...${a.expr}}`
  return a.name ?? ''
}

// expandFillBlock — valide le NOM (littéral, obligatoire, SEUL) puis déplie `fillNode` en ses
// propres enfants, chacun stampé `slot=`. Le nœud `@fill` lui-même ne survit jamais à cette
// fonction.
function expandFillBlock(fillNode: Node): Node[] {
  const ligne = fillNode.line ?? 0
  const first = fillNode.attrs[0]

  if (!first) {
    throw new Error(t('parser.fill-sans-nom', { directive: FILL_DIRECTIVE, ligne }))
  }
  // seul `attrs[0]` était lu : un nom en trop (`<@fill x y>`) ou un attribut de
  // plus (`<@fill x class="foo">`, `<@fill x {...$rest}>`) posait quand même `slot="x"` et
  // perdait le reste SANS UN MOT.
  if (fillNode.attrs.length > 1) {
    const extrait = fillNode.attrs.map(describeFillAttr).join(' ')
    throw new Error(t('parser.fill-un-seul-nom', { directive: FILL_DIRECTIVE, ligne, extrait }))
  }
  if (first.type === 'dynamic') {
    throw new Error(t('parser.fill-nom-dynamique', { directive: FILL_DIRECTIVE, expr: first.expr ?? '', ligne }))
  }
  if (first.type !== 'boolean') {
    throw new Error(t('parser.fill-sans-nom', { directive: FILL_DIRECTIVE, ligne }))
  }

  const nom = first.name ?? ''
  stampSlot(fillNode.children, nom)
  return fillNode.children
}

// stampSlot — pose `slot=nom` sur chaque `tag` de `children` (composant `<@x>` compris — déjà
// résolu en `tag` à ce stade du pipeline). TRAVERSE {if}/{for}/{await}/{key} pour atteindre leurs
// propres `tag` (chaque branche, chaque itération de boucle). Retire le texte blanc en silence ;
// refuse texte non blanc, `expr`, bloc imbriqué et tag déjà porteur de `slot=`.
function stampSlot(children: Node[], nom: string): void {
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    const ligne = node.line ?? 0

    if (node.type === 'text') {
      // un commentaire HTML `<!-- … -->` SEUL (rien d'autre autour) est du blanc au
      // même titre qu'un espace : retiré, jamais refusé « texte nu ».
      const sansCommentaires = (node.content ?? '').replace(/<!--[\s\S]*?-->/g, '')
      if (sansCommentaires.trim() === '') { children.splice(i, 1); i -= 1; continue }
      throw new Error(t('parser.fill-texte-nu', { directive: FILL_DIRECTIVE, nom, ligne }))
    }

    if (node.type === 'expr') {
      throw new Error(t('parser.fill-texte-nu', { directive: FILL_DIRECTIVE, nom, ligne }))
    }

    if (node.type === 'tag') {
      if (node.name === FILL_TAG_NAME) {
        throw new Error(t('parser.fill-imbrique', { directive: FILL_DIRECTIVE, nom, ligne }))
      }
      if (node.attrs.some(a => a.name === 'slot')) {
        throw new Error(t('parser.fill-slot-deja-pose', { directive: FILL_DIRECTIVE, nom, tag: node.name, ligne }))
      }
      node.attrs.push({ type: 'static', name: 'slot', val: nom })
      continue
    }

    if (node.type === 'for' || node.type === 'key') {
      stampSlot(node.children, nom)
    } else if (node.type === 'if' || node.type === 'await') {
      for (const branch of node.branches) stampSlot(branch.children, nom)
    }
    // 'const' — déclaration pure, aucun enfant à parcourir
  }
}

// ============================================================================
// Entrypoint
// ============================================================================
export function parse(html: string, tagRefs?: TagRef[]): Node {
  const scanner = new Scanner(html.trim())

  const parseChildren: ChildrenParser = (container: Node[]) => {
    while (!scanner.eos()) {
      const posBefore = scanner.pos
      const status = parseFlow(scanner, container, parseChildren) ||
                     parseComment(scanner) ||
                     parseDom(scanner, container, parseChildren, tagRefs) ||
                     parseText(scanner, container)
      if (typeof status === 'string') return status
      if (scanner.pos === posBefore) {
        const extrait = JSON.stringify(scanner.peek(80))
        throw new Error(t('parser.erreur-fatale', { extrait }))
      }
    }
    return undefined
  }

  const root = new Node('root')
  const res = parseChildren(root.children)
  // une fermante orpheline au NIVEAU RACINE faisait remonter
  // `'close_tag'` que `parse()` IGNORAIT : tout ce qui suivait la fermante
  // disparaissait du composant en silence (motif « build vert, markup perdu »).
  // La fermante n'est jamais consommée par un parent → `scanner` est encore
  // dessus. On nomme la balise (consommation locale) pour un message parlant.
  if (res === 'close_tag' && !scanner.eos()) {
    const line = currentLine(scanner)
    const m = scanner.rest().match(/^<\/([a-zA-Z0-9\-@]+)\s*>/)
    const name = m ? m[1] : '?'
    throw new Error(t('parser.balise-fermante-orpheline', { nom: name, ligne: line }))
  }
  hoistFillBlocks(root)
  return root
}
