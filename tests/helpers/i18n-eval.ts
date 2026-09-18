// Amorçage i18n d'un build RÉEL dans un harnais happy-dom.
//
// Le manifeste ne porte plus que les RÉGLAGES (`µ._i18nData`) : dictionnaire racine et
// table des sections vivent dans un fichier PAR LANGUE (`files[langue]`), que le runtime
// importe une fois la langue décidée. Un `window.eval()` de script classique n'a pas de
// résolveur ESM — on sème donc ces fichiers directement, par le point d'entrée du runtime
// (`µ._i18nLang`), ce qui place le harnais dans l'état d'une page dont les fichiers sont
// déjà arrivés : démarrage synchrone, comme avant.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Lignes JS à évaluer APRÈS le cœur : réglages du manifeste + données de chaque langue.
 *  Chaîne vide si le build n'a pas d'i18n. */
export function i18nBootLines(manifestPath: string, outDir: string): string {
  const manifeste = readFileSync(manifestPath, 'utf-8')
  const m = manifeste.match(/µ\._i18nData = (\{.*?\});/)
  if (!m) return ''
  const data = JSON.parse(m[1])
  const lignes = [`µ._i18nData = ${m[1]};`]
  for (const [lang, url] of Object.entries<string>(data.files ?? {})) {
    const src = readFileSync(join(outDir, url.split('/').pop()!), 'utf-8')
    lignes.push(`µ._i18nLang(${JSON.stringify(lang)}, ${src.replace(/^export default /, '').replace(/;\s*$/, '')});`)
  }
  lignes.push(`if (typeof µ._i18nRecheck === 'function') { µ._i18nRecheck(); }`)
  return lignes.join('\n')
}
