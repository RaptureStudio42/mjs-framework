// transpiler/macro-tag — `findMacroTagEnd`
// déplacée ICI depuis macros.ts. Raison d'être de ce module à part : sections.ts
// a besoin de la même fonction pour son propre masquage <@head>/<@failed>, mais
// macros.ts IMPORTE déjà sections.ts (`extractSections`) — un import retour de
// sections.ts vers macros.ts créerait un cycle. Fonction PURE, aucune dépendance
// sur le reste du transpileur (ni messages, ni sections, ni macros).

// findMacroTagEnd — localise le `>` qui ferme RÉELLEMENT une
// balise de macro `<@nom …>`, à partir de `from` (index juste après `<@nom`).
// AVANT : chaque site ci-dessous utilisait une regex `[^>]*`/`[^>]+?` qui
// s'arrêtait au PREMIER `>` textuel — y compris niché dans un `{…}`
// (comparaison `a > b`, `if…then…else`, flèche `->`/`=>`) : panne MUETTE, le
// handler tronqué et un résidu texte (`100}/>`) qui fuit dans le HTML rendu.
// Règle : profondeur `{`/`}` suivie en permanence ; chaînes `"…"`/`'…'`
// reconnues UNIQUEMENT hors accolade (profondeur 0, attribut littéral au
// top-level de la balise) — DANS une accolade, seule la profondeur `{`/`}`
// compte, jamais les guillemets (cas limite : `{a = '}'}`, le `}` du littéral
// `'}'` referme prématurément l'accolade extérieure — mais le `'` isolé qui
// suit ne trouvant PAS de guillemet partenaire plus loin (cf. règle
// ci-dessous), il n'est PAS traité comme une ouverture, et le `}` réel qui le
// suit referme correctement : `>` final retrouvé quand même, cf. test dédié).
// GUILLEMET (hors accolade) JAMAIS REFERMÉ plus loin dans `html` : PAS traité
// comme une ouverture — même tolérance que l'ancien scan `[^>]*` (aveugle aux
// guillemets), exigée par un test existant (macros globales — modificateur
// toujours vu même si un attribut littéral plus tôt sur la balise oublie son
// guillemet fermant).
// Profondeur > 0 et une `{` d'attribut JAMAIS refermée : sans borne, le scan
// continuait jusqu'au premier `}` suivi d'un `>` n'importe où PLUS LOIN dans le document,
// avalant tout le HTML intermédiaire (balises entières comprises) comme « attrs » de la macro,
// réinjecté ensuite comme corps de handler Civet — panne muette, aucune erreur. `looksLikeOpenTag`
// signale qu'une AUTRE balise s'ouvre plus loin (donc que la `{` courante ne se refermera
// jamais) : un `<` en DÉBUT DE LIGNE (espaces/tabs seuls depuis le dernier `\n`), suivi d'une
// lettre, `/`, `@` ou `!` — jamais un `<` de comparaison en plein milieu d'une expression
// (`if a < b`), qui n'est précédé que de code sur sa ligne, pas d'un retour à la ligne.
function looksLikeOpenTag(html: string, i: number): boolean {
  if (!/[a-zA-Z/@!]/.test(html[i + 1] ?? '')) return false
  let j = i - 1
  while (j >= 0 && (html[j] === ' ' || html[j] === '\t')) j--
  return j >= 0 && html[j] === '\n'
}

// Régression (sur du Civet VALIDE) — le
// scan à profondeur > 0 ne suivait AUCUN contexte de chaîne : un heredoc Civet `'''…'''` (ou
// `"""…"""`, ou un gabarit `` ` ``) niché dans un attribut (`@click={ html := '''<b>gras</b>''' }`)
// contient un `<tag>` en tête de ligne qui déclenchait `looksLikeOpenTag` (faux « balise jamais
// refermée »), et une accolade LITTÉRALE dans une chaîne (`{ s := "}" }`) pouvait décrémenter la
// profondeur en plein milieu d'un guillemet non fermé. Suit désormais le guillemet ACTIF pendant
// tout le temps qu'il reste ouvert (échappement `\` compris) : ni `looksLikeOpenTag` ni le
// comptage `{`/`}` ne s'appliquent DANS une chaîne — seule la recherche de son propre délimiteur
// de fermeture avance le scan. Le repli « guillemet jamais refermé » de la profondeur 0
// (ci-dessous, INCHANGÉ) reste hors de ce mécanisme : il vit AVANT toute ouverture d'accolade,
// jamais en profondeur.
function stringDelimAt(html: string, i: number): string | null {
  const three = html.slice(i, i + 3)
  if (three === "'''" || three === '"""') return three
  const c = html[i]
  return c === '\'' || c === '"' || c === '`' ? c : null
}

export function findMacroTagEnd(html: string, from: number): number {
  let depth = 0
  let i = from
  let strDelim: string | null = null   // guillemet ACTIF en profondeur > 0, ou null hors chaîne
  while (i < html.length) {
    const c = html[i]
    if (strDelim !== null) {
      if (c === '\\') { i += 2; continue }
      if (html.slice(i, i + strDelim.length) === strDelim) { i += strDelim.length; strDelim = null; continue }
      i++
      continue
    }
    if (depth === 0 && (c === '"' || c === '\'')) {
      // guillemet JAMAIS refermé plus loin → PAS traité comme une ouverture (même
      // tolérance que l'ancien scan `[^>]*`, aveugle aux guillemets) : la garde
      // « macro globale — modificateur » (plus bas, parseListeners) a un test dédié
      // qui exige que ce cas ne rende pas le scan aveugle au reste de la balise —
      // on avance d'un cran et on continue à chercher le `>` réel normalement.
      const closeIdx = html.indexOf(c, i + 1)
      if (closeIdx === -1) { i++; continue }
      i = closeIdx + 1
      continue
    }
    if (depth > 0) {
      const delim = stringDelimAt(html, i)
      if (delim !== null) { strDelim = delim; i += delim.length; continue }
    }
    // balise ouverte détectée EN PROFONDEUR (accolade d'attribut jamais refermée) : signal de
    // fin de scan, l'appelant lève déjà `macro-balise-non-fermee` sur un -1.
    if (depth > 0 && c === '<' && looksLikeOpenTag(html, i)) return -1
    if (c === '{') { depth++; i++; continue }
    if (c === '}') { depth = Math.max(0, depth - 1); i++; continue }
    if (c === '>' && depth === 0) return i
    i++
  }
  return -1
}
