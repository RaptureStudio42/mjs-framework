// transpiler/style-vars — la passe `$$` des contextes de STYLE (blocs <style> et <theme>).
//
// Un seul espace de nommage, un seul préfixe : `$$brand` devient TOUJOURS
// `var(--<varPrefix>-brand)`, quel que soit le module qui l'écrit (« je veux pas de
// préfixage par rapport au nom du module ; comme pour
// l'esprit du CSS, si un thème crée une variable elle est visible dans tous les
// enfants, et overridable par chacun »). Aucun renommage par composant, aucune
// variable « privée » : ce qui est déclaré cascade, point.
//
// La passe tourne AVANT dart-sass, et c'est OBLIGATOIRE : `$$brand` est une syntaxe
// invalide en SASS (`$` y introduit une variable, `$$` ne parse pas). Elle est aussi
// distincte des deux moteurs de sucre JS (lexer + cleanJs, cf. src/sigils.ts) : dans
// un `<script>`, `$$x` reste le store universel — même écriture, deux mondes, aucun
// code partagé possible (l'un produit du JS, l'autre du CSS).
//
// Le scanner saute les chaînes et les commentaires plutôt que d'appliquer un `replace`
// global : `content: "$$brand"` doit rester littéral. Le `//` n'ouvre un commentaire
// que s'il est en tête de ligne ou précédé d'un blanc — sinon `url(http://…)` serait
// avalé jusqu'au bout de la ligne.
//
// SYNTAXE UNIFIÉE — `$$brand` se LIT et se DÉCLARE avec la
// même écriture, dans TOUS les contextes de style : `color: $$brand` lit, `$$brand: #f472b6`
// en tête de ligne déclare. Avant, surcharger depuis un `<style>` obligeait à écrire le
// préfixe à la main (`--mjs-brand: #f472b6`) : deux écritures pour une seule notion, et le
// préfixe à retenir. Le sens reste celui du CSS — déclarer dans un sélecteur pose la variable
// sur ce qui matche, et ça cascade vers le bas.

// identifiant de variable de thème : tirets INTERNES admis (`$$brand-l20`), jamais en tête ni en fin
const VAR_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*/

// ligne qui DÉCLARE une custom property (`--x:` ou `$$x:`). dart-sass ne parse pas la valeur
// d'une custom property — elle passe telle quelle, `//` compris : le commentaire de fin de ligne
// y survit, la valeur devient invalide, et le `var()` qui la lit retombe MUETTEMENT à sa valeur
// initiale. Sur ces lignes-là c'est donc à nous de retirer le commentaire (défaut)
const CUSTOM_PROP_LINE_RE = /^\s*(?:--[\w-]+|\$\$[A-Za-z_][\w-]*)\s*:/

export interface StyleVarDecl {
  name:  string
  line:  number
  doc:   string   // commentaire qui précède la déclaration (documente la variable)
  value: string   // valeur ÉMISE (après la passe `$$`, commentaire de fin de ligne déjà retiré)
}

export interface StyleVarsResult {
  code:     string
  declared: StyleVarDecl[]
  read:     string[]
  rootDecl: StyleVarDecl[]   // déclarations à la RACINE (colonne 0, hors accolade) : légales en <theme>, fautives en <style>
  sassRead:     string[]   // variables SASS ordinaires LUES (`$x`) — sert à adosser `$x` à `$$x` (cf. transpiler/index)
  sassDeclared: string[]   // variables SASS ordinaires DÉCLARÉES ici (`$x:` en tête de ligne) : elles gardent la main
}

/** Une variable de thème déclarée par un bloc `<theme>`, telle qu'elle part au registre du build. */
export interface ThemeVar {
  name:    string
  variant: string   // '' = le bloc de base du composant, sinon le nom de la variante
  line:    number
  doc:     string
}

export interface StyleVarsOpts {
  prefix?: string   // varPrefix de la config, `mjs` par défaut
}

export function rewriteStyleVars(source: string, opts: StyleVarsOpts = {}): StyleVarsResult {
  const prefix = opts.prefix ?? 'mjs'
  const declared: StyleVarDecl[] = []
  const read:     string[]       = []
  const rootDecl: StyleVarDecl[] = []
  const sassRead:     string[]   = []
  const sassDeclared: string[]   = []

  let out       = ''
  let i         = 0
  let lineNo    = 1
  let lineStart = 0
  let lastDoc   = ''   // dernier commentaire vu, candidat à documenter la déclaration suivante
  let depth     = 0    // accolades ouvertes — le seul repère de racine que SCSS/CSS donne
  let lineHasCode = false
  // déclaration `$$x:` en cours : sa VALEUR se lit dans `out` (donc après la passe `$$` et après
  // le retrait du commentaire de fin de ligne), du caractère qui suit le `:` jusqu'au terminateur
  // `depth0`/`paren0` = le NIVEAU où la déclaration s'est ouverte. Une accolade ou une parenthèse
  // ouverte DANS la valeur — `#{…}`, un littéral `{a:1}`, un `rgba(` qui court sur deux lignes —
  // ne la termine donc pas : on ne referme qu'une fois revenu à son propre niveau. Sans ça la
  // valeur partait tronquée au premier `}` ou au premier saut de ligne venu, MUETTEMENT
  let pending: { decl: StyleVarDecl, from: number, depth0: number, paren0: number } | null = null
  let paren = 0

  // ferme la déclaration courante et lui donne sa valeur
  const closePending = () => {
    if (pending === null) return
    pending.decl.value = out.slice(pending.from).replace(/^[^:]*:/, '').trim()
    pending = null
  }
  // fermeture ORDINAIRE (`\n`, `;`) : seulement au niveau d'ouverture de la déclaration
  const closeIfLevel = () => { if (pending !== null && depth === pending.depth0 && paren === pending.paren0) closePending() }

  while (i < source.length) {
    const c = source[i]

    if (c === '\n') {
      closeIfLevel()
      out += c
      i++
      lineNo++
      lineStart = i
      if (lineHasCode) lastDoc = ''   // une ligne de code coupe le lien avec le commentaire
      lineHasCode = false
      continue
    }

    // chaîne — recopiée telle quelle, échappements compris
    if (c === '"' || c === '\'') {
      const quote = c
      out += c
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < source.length) { out += source[i] + source[i + 1]; i += 2; continue }
        if (source[i] === '\n') { lineNo++; lineStart = i + 1 }
        out += source[i]
        i++
      }
      if (i < source.length) { out += source[i]; i++ }
      lineHasCode = true
      continue
    }

    // commentaire de bloc
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      const chunk = source.slice(i, stop)
      out += chunk
      lineNo += (chunk.match(/\n/g) ?? []).length
      // le bloc peut enjamber des lignes : sans ce recalage, `lineStart` restait celui de la
      // ligne du `/*` et faisait passer la ligne d'APRÈS pour celle d'avant (numéro de ligne
      // faux au registre, et commentaire d'une autre ligne pris pour valeur de custom property)
      const dernierSaut = chunk.lastIndexOf('\n')
      if (dernierSaut !== -1) lineStart = i + dernierSaut + 1
      i = stop
      continue
    }

    // commentaire de ligne — jamais au milieu d'un mot, sinon `url(http://…)` y passe
    if (c === '/' && source[i + 1] === '/' && (i === lineStart || /\s/.test(source[i - 1]))) {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      const chunk = source.slice(i, stop)
      // valeur de custom property : dart-sass ne retirera PAS ce commentaire (cf. CUSTOM_PROP_LINE_RE).
      // Sauf si le `//` OUVRE la valeur (`--cdn: //cdn.tld/lib.js`, URL sans protocole) : là c'est
      // la valeur elle-même, et la manger laissait une déclaration VIDE
      const avantLigne = source.slice(lineStart, i)
      if (lineHasCode && !/:[ \t]*$/.test(avantLigne) && CUSTOM_PROP_LINE_RE.test(avantLigne)) {
        out = out.replace(/[ \t]+$/, '')   // le blanc qui le précédait partirait dans la valeur
        i = stop
        continue
      }
      out += chunk
      if (!lineHasCode) lastDoc = chunk.replace(/^\/+\s*/, '').trim()
      i = stop
      continue
    }

    // la variable de thème
    if (c === '$' && source[i + 1] === '$') {
      const m = VAR_ID_RE.exec(source.slice(i + 2))
      if (m) {
        const name = m[0].replace(/-+$/, '')
        if (name !== '') {
          const after     = i + 2 + name.length
          const avant     = source.slice(lineStart, i)
          let   j         = after
          while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++
          // seul critère : rien d'autre que du blanc avant sur la ligne, et un `:` juste après.
          // `::` exclu — `$$x::after` est un SÉLECTEUR, pas une déclaration ; sans ce garde il
          // sortait en `--mjs-x::after`, propriété custom sans valeur, muette à l'écran
          const estDecl   = avant.trim() === '' && source[j] === ':' && source[j + 1] !== ':'
          if (estDecl) {
            const decl = { name, line: lineNo, doc: lastDoc, value: '' }
            declared.push(decl)
            // RACINE = colonne 0 (SASS indenté : pas d'indentation donc pas de sélecteur au-dessus)
            // ET aucune accolade ouverte (SCSS/CSS : hors de tout bloc). La conjonction couvre les
            // deux dialectes sans avoir à leur demander lequel ils sont. Légal dans un <theme>, qui
            // se pose à plat et reçoit son sélecteur après coup ; faute dans un <style>, où l'appelant
            // en fait une erreur MJS plutôt que de laisser dart-sass dire « Expected identifier »
            if (avant === '' && depth === 0) rootDecl.push(decl)
            lastDoc = ''
            closePending()   // AVANT d'écrire le nom : sinon la valeur précédente encore ouverte l'avalait
            out += `--${prefix}-${name}`
            pending = { decl, from: out.length, depth0: depth, paren0: paren }
          } else {
            if (!read.includes(name)) read.push(name)
            out += `var(--${prefix}-${name})`
          }
          i = after
          lineHasCode = true
          continue
        }
      }
    }

    // la variable SASS ordinaire (un seul `$`) — recopiée telle quelle, seulement RECENSÉE.
    // Deux listes : ce qui est lu, ce qui est déclaré ici. L'appelant s'en sert pour adosser un
    // `$x` orphelin à la valeur du `$$x` du <theme> (cf. transpiler/index, préambule SASS) —
    // une variable déclarée sur place garde toujours la main, on ne la double jamais
    if (c === '$' && source[i + 1] !== '$') {
      const m = VAR_ID_RE.exec(source.slice(i + 1))
      if (m) {
        const name = m[0].replace(/-+$/, '')
        if (name !== '') {
          const after = i + 1 + name.length
          const avant = source.slice(lineStart, i)
          let   j     = after
          while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++
          const estDecl = avant.trim() === '' && source[j] === ':' && source[j + 1] !== ':'
          // RACINE seulement pour « déclaré » : un `$gap: 2px` posé sous un sélecteur est LOCAL à ce
          // sélecteur (portée SASS ordinaire) et ne doit pas priver le reste du bloc de l'adossage —
          // sinon un `$gap` local dans `.a` faisait échouer `.b { margin: $gap }`, qui n'a rien à voir
          if (estDecl) {
            if (avant === '' && depth === 0 && !sassDeclared.includes(name)) sassDeclared.push(name)
          } else if (!sassRead.includes(name)) {
            sassRead.push(name)
          }
          out += source.slice(i, after)
          i = after
          lineHasCode = true
          continue
        }
      }
    }

    if (c === '{') depth++
    else if (c === '}') {
      if (depth > 0) depth--
      // un `}` ne termine la déclaration que s'il referme un bloc ouvert AVANT elle
      if (pending !== null && depth < pending.depth0) closePending()
    }
    if (c === '(') paren++
    else if (c === ')' && paren > 0) paren--
    if (c === ';') closeIfLevel()
    if (!/\s/.test(c)) lineHasCode = true
    out += c
    i++
  }
  closePending()

  return { code: out, declared, read, rootDecl, sassRead, sassDeclared }
}

// ----------------------------------------------------------------------------
// wrapThemeBlock — enveloppe le corps d'un <theme> dans son sélecteur.
//
// Le bloc s'écrit à plat (une déclaration par ligne, sans sélecteur) : c'est ici
// qu'il en reçoit un. En SASS indenté, envelopper = réindenter de 2 ; en SCSS/CSS,
// = poser des accolades. Le sélecteur, lui, vient de l'appelant : `:where(:host, tag)`
// pour un module (double cible = shadow ET mode light), un sélecteur
// d'attribut pour un fichier de thème.
// ----------------------------------------------------------------------------
export function wrapThemeBlock(selector: string, body: string, lang: 'css' | 'sass' | 'scss'): string {
  if (body.trim() === '') return ''
  if (lang === 'sass') return `${selector}\n${body.split('\n').map(l => (l.trim() === '' ? l : `  ${l}`)).join('\n')}\n`
  return `${selector} {\n${body}\n}\n`
}
