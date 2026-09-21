// server/theme-write — écrire une couleur DANS LE FICHIER QUI LA DÉCLARE (atelier
// /__mjs/theme, chantier 21/09). L'aperçu en direct (canal HMR `theme-vars`, cf. index.ts) ne
// touche jamais le disque ; ici l'interrupteur « enregistrer » est allumé, et la valeur doit
// atterrir sur la LIGNE qui la déclare — `$$accent: #ff0000` d'un bloc <theme>, ou la custom
// property brute `--mjs-accent: #ff0000` d'un <style> (les deux formes sortent identiques une
// fois compilées, cf. bundler scanDeclaredVars, mais s'écrivent différemment dans le source).
//
// GARDE MUETTE INTERDITE (socle § 7). Le registre `.mjs-theme-vars.json` est un artefact de
// BUILD : entre le build et le clic, le fichier a pu bouger, la ligne se décaler, la
// déclaration disparaître — et une ligne écrite au jugé écrase du code au hasard, en silence.
// La ligne annoncée est donc VÉRIFIÉE avant d'être touchée ; si elle ne porte pas la
// déclaration attendue, on retombe sur un balayage du fichier entier qui n'accepte qu'un
// résultat UNIQUE. Zéro candidat, ou deux : on refuse, et on DIT lequel des deux — un refus
// muet ressemblerait trait pour trait à une écriture réussie sans effet.
//
// Rien n'est reconstruit : la ligne réécrite recolle l'indentation, le nom, le séparateur et
// la QUEUE (point-virgule, commentaire de fin) tels qu'ils étaient, octet pour octet. Seule la
// tranche de la valeur change.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Une déclaration repérée dans le source, découpée en tranches recollables telles quelles. */
export interface ThemeDecl {
  /** numéro de ligne 1-based, comme le registre du build et comme un éditeur les comptent */
  line:  number
  /** tout ce qui précède la valeur : indentation + nom + séparateur `:` */
  head:  string
  /** la valeur SEULE (`#3b82f6`, `var(--mjs-accent, #888)`) */
  value: string
  /** ce qui suit : point-virgule éventuel, commentaire de fin de ligne, espaces */
  tail:  string
}

/** Issue d'une réécriture. FORME PLATE, jamais une union discriminée : le projet compile en
 *  `strict: false` (tsconfig.json), et sans `strictNullChecks` TypeScript ne réduit PAS une
 *  union sur son discriminant — `if (!issue.ok)` laisserait `issue.reason` inconnu du typeur. */
export interface ThemeWriteOutcome {
  ok:     boolean
  /** motif du refus, '' quand `ok` */
  reason: '' | 'introuvable' | 'ambigu' | 'inchange'
  /** lignes candidates trouvées — vide, une seule, ou toutes celles qui rendent le cas ambigu */
  lines:  number[]
  /** ligne effectivement réécrite (0 en cas de refus) */
  line:   number
  /** valeur trouvée sur place, puis valeur posée */
  before: string
  after:  string
  /** source réécrit en entier, prêt à être enregistré ('' en cas de refus) */
  source: string
}

// fin de la VALEUR dans ce qui suit le `:` — trois bornes, la première qui tombe gagne :
//   - un commentaire de fin de ligne (`//` en tête ou précédé d'un blanc, ou `/*`) ;
//   - un `;` hors parenthèses, qui referme la déclaration (`--a: red; --b: blue` sur une ligne) ;
//   - la fin de la tranche, espaces de droite retirés.
// le `//` exige un blanc devant : sinon `url(http://…)` serait coupé en deux (même règle que
// transpiler/style-vars, qui a déjà payé ce piège)
function finDeValeur(rest: string): number {
  let paren = 0
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if (c === '(') paren++
    else if (c === ')' && paren > 0) paren--
    else if (c === ';' && paren === 0) return trimFin(rest, i)
    else if (c === '/' && rest[i + 1] === '*') return trimFin(rest, i)
    else if (c === '/' && rest[i + 1] === '/' && (i === 0 || /\s/.test(rest[i - 1]))) return trimFin(rest, i)
  }
  return trimFin(rest, rest.length)
}

/** longueur de `rest[0..fin[` une fois les blancs de droite retirés */
function trimFin(rest: string, fin: number): number {
  let n = fin
  while (n > 0 && /[ \t]/.test(rest[n - 1])) n--
  return n
}

/** Toutes les lignes de `source` qui DÉCLARENT `name`, sous l'une ou l'autre de ses deux
 *  écritures. `color: $$accent` est une LECTURE et n'en est jamais une : le nom doit ouvrir la
 *  ligne (indentation exceptée) et être suivi du `:`. */
export function findThemeDecls(source: string, name: string, prefix: string): ThemeDecl[] {
  const re    = new RegExp('^([ \\t]*)(\\$\\$' + escapeRegex(name) + '|--' + escapeRegex(prefix) + '-' + escapeRegex(name) + ')([ \\t]*:[ \\t]*)(.*)$')
  const hits: ThemeDecl[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i])
    if (!m) continue
    const rest = m[4]
    const fin  = finDeValeur(rest)
    // valeur vide = la vraie valeur est ailleurs (ligne suivante, bloc imbriqué) : pas de
    // tranche à remplacer ici, la ligne n'est pas candidate
    if (fin === 0) continue
    hits.push({ line: i + 1, head: m[1] + m[2] + m[3], value: rest.slice(0, fin), tail: rest.slice(fin) })
  }
  return hits
}

/** Réécrit la valeur de `name` dans `source`. `hintLine` (1-based, 0 = inconnue) vient du
 *  registre du build : elle DÉSAMBIGUÏSE (un thème clair et un thème sombre déclarent le même
 *  nom deux fois) mais ne fait jamais autorité — elle n'est retenue que si la ligne porte
 *  réellement la déclaration. Sinon : une seule candidate dans tout le fichier, ou refus. */
export function rewriteThemeValue(source: string, name: string, prefix: string, value: string, hintLine = 0): ThemeWriteOutcome {
  const refus = (reason: ThemeWriteOutcome['reason'], lines: number[]): ThemeWriteOutcome => ({ ok: false, reason, lines, line: 0, before: '', after: '', source: '' })
  const hits  = findThemeDecls(source, name, prefix)
  if (hits.length === 0) return refus('introuvable', [])

  let cible = hintLine > 0 ? hits.find(h => h.line === hintLine) : undefined
  if (!cible) {
    if (hits.length > 1) return refus('ambigu', hits.map(h => h.line))
    cible = hits[0]
  }
  if (cible.value === value) return refus('inchange', [cible.line])

  const lines = source.split('\n')
  lines[cible.line - 1] = cible.head + value + cible.tail
  return { ok: true, reason: '', lines: [cible.line], line: cible.line, before: cible.value, after: value, source: lines.join('\n') }
}
