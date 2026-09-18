// build-version — lecture de la version du build (ligne `µ.version` du manifeste), PARTAGÉE par
// tous ceux qui taguent une entrée de journal ou une fiche de navigation : `mjs serve`
// (render-server.ts, son propriétaire historique) et `mjs dev` des DEUX côtés
// (cli.ts pour la capture du moteur de rendu, server/index.ts pour celle du serveur statique).
// EXTRAITE ici plutôt que simplement exportée depuis render-server.ts : server/index.ts n'a alors
// pas à importer tout le graphe de `mjs serve` (render-request, serve-entry, renderToString…) pour
// une seule regex. Le cache reste UNIQUE (module-level) : un manifeste donné n'est relu qu'une
// fois par mtime, quel que soit le nombre d'appelants.

import { readFileSync, existsSync, statSync } from 'node:fs'

// cache par manifestPath (mtimeMs) : relecture seulement si le build a changé.
const versionCache = new Map<string, { mtimeMs: number, version: string | null }>()

/** Lit la ligne `µ.version` du manifeste, cache par mtime ; null si fichier/ligne absente. */
export function readBuildVersion(manifestPath: string | null): string | null {
  if (!manifestPath || !existsSync(manifestPath)) return null
  const mtimeMs = statSync(manifestPath).mtimeMs
  const cached  = versionCache.get(manifestPath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.version
  const src = readFileSync(manifestPath, 'utf-8')
  // espaces autour de `=` et guillemets simples/doubles tolérés : un manifeste en mode `js:
  // 'bundle'` passe par esbuild.build(), qui retire les espaces superflus en minifiant
  // (`µ.version="…"`) — la forme non minifiée (manifeste éclaté, ou bundle en dev) garde
  // `µ.version = "…"`, avec espaces. Les deux sont lues par ce premier regex.
  const m = src.match(/µ\.version\s*=\s*["']([0-9a-f]{8})["']/)
  // repli — mode `js: 'bundle'` MINIFIÉ : esbuild renomme aussi `µ` lui-même en un nom
  // court quelconque (`n.version="…"`, cf. bundler/index.ts, runBundleEsbuild()) ; le
  // sigil littéral `µ.version` ne survit alors nulle part dans le texte. Le bundler y pose
  // en repli un `footer` STABLE (jamais renommé/minifié, ajouté après coup) : `//# mjsVersion=…`.
  const fallback = m ? null : src.match(/\/\/#\s*mjsVersion=([0-9a-f]{8})/)
  const version = m ? m[1] : (fallback ? fallback[1] : null)
  versionCache.set(manifestPath, { mtimeMs, version })
  return version
}
