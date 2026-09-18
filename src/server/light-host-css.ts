// SSR — port serveur de `µ._lightHostCss` (runtime/mjs_element.ts) : même algorithme, réécrit
// `:host`/`:host(X)`/`:host-context(X)` en nom de balise
// pour le <style> d'un sous-composant léger imbriqué (serializeShadowHost, renderToString.ts).
// `serializeShadowHost` réutilise `window.µ._lightHostCss` quand le runtime compilé est chargé
// dans la fenêtre happy-dom du rendu (cas réel de `createSSRRenderer`/`renderToString`) ; cette
// copie sert de repli sinon. Cache par balise + texte, comme côté client — une réécriture par
// composant, jamais par appel.

const lightHostCssCache = new Map<string, string>()
// séparateur clé de cache : jamais présent dans du CSS, String.fromCharCode plutôt qu'un octet de
// contrôle littéral dans la source (fragile aux diffs/éditeurs)
const CACHE_KEY_SEP = String.fromCharCode(1)

// position de la parenthèse FERMANTE appariée à celle d'indice `open` (parenthèses imbriquées
// possibles, `:host(:not(.a))` → la bonne, pas la première rencontrée)
function findParenEnd(css: string, open: number): number {
  let depth = 0
  for (let j = open; j < css.length; j++) {
    if (css[j] === '(') depth++
    else if (css[j] === ')') {
      depth--
      if (depth === 0) return j
    }
  }
  return -1
}

// réécrit :host/:host(X)/:host-context(X) → tag/tagX/X tag — ::slotted(...) jamais touché (ne
// commence jamais par :host) ; --host-x (custom property) jamais confondue, aucun ':' devant
export function lightHostCss(css: string, tag: string): string {
  if (!css) return css
  const cacheKey = tag+CACHE_KEY_SEP+css
  const cached   = lightHostCssCache.get(cacheKey)
  if (cached !== undefined) return cached

  let out = ''
  let i   = 0
  while (i < css.length) {
    // guillemets : contenu recopié tel quel, jamais de :host à réécrire dedans (`content: ":host"`)
    if (css[i] === '"' || css[i] === '\'') {
      const quote = css[i]
      let j = i + 1
      while (j < css.length) {
        if (css[j] === '\\') { j += 2; continue }
        if (css[j] === quote) { j++; break }
        j++
      }
      out += css.slice(i, j)
      i = j
      continue
    }
    // suite de pseudo-classes hôte CONSÉCUTIVES (`:host-context(.a):host(.b)`, sans espace ni
    // combinateur entre elles) : UN seul composé — contextes en préfixes ancêtres (dans l'ordre),
    // UN nom de balise, suffixes accolés (dans l'ordre) — jamais un tag par token de la suite
    const contexts: string[] = []
    let suffix      = ''
    let consumedAny = false
    let j = i
    while (true) {
      if (css.startsWith(':host-context(', j)) {
        const open  = j + 13 // indice du '('
        const close = findParenEnd(css, open)
        if (close === -1) break
        contexts.push(css.slice(open + 1, close))
        j = close + 1
        consumedAny = true
        continue
      }
      if (css.startsWith(':host(', j)) {
        const open  = j + 5 // indice du '('
        const close = findParenEnd(css, open)
        if (close === -1) break
        suffix += css.slice(open + 1, close)
        j = close + 1
        consumedAny = true
        continue
      }
      if (css.startsWith(':host', j)) {
        const ch = css[j + 5]
        if (ch === undefined || !/[\w-]/.test(ch)) {
          j += 5
          consumedAny = true
          continue
        }
      }
      break
    }
    if (consumedAny) {
      out += (contexts.length ? contexts.join(' ')+' ' : '')+tag+suffix
      i = j
    } else {
      out += css[i]
      i++
    }
  }
  lightHostCssCache.set(cacheKey, out)
  return out
}
