// Test de régression — `renderToString.ts` concatène les fichiers runtime compilés (`mjs_*.js`,
// ex. mjs_easing/mjs_element/mjs_store…) dans le contexte d'éval SSR AVANT le
// reste (composants/modules), qui lui EST trié (`topoSortFiles`). L'ordre des
// runtimeIds venait directement de `readdirSync(outputDir)`, dont POSIX NE
// GARANTIT PAS l'ordre — il peut varier entre systèmes de fichiers/machines/CI,
// rendant le bundle SSR non-déterministe (deux compilations du MÊME projet
// pourraient concaténer les fichiers runtime dans un ordre différent).
//
// Recherche (grep ciblé) : aucune dépendance RÉELLE au CHARGEMENT entre
// fichiers runtime trouvée à date — chacun construit puis étend SON PROPRE
// namespace `µ.xxx` sans référencer celui d'un AUTRE fichier runtime au
// top-level. Le risque reste donc théorique, mais un ordre de build qui varie selon la machine est en
// soi une source de non-reproductibilité évitable pour un outil de build —
// fix appliqué par hygiène/robustesse, pas parce qu'un crash a été observé.
//
// Note méthode : le tri porte sur un tableau interne à `createSSRRenderer`
// (non exporté) construit à partir de `readdirSync` sur les VRAIS fichiers
// runtime du framework (toujours le même ensemble fixe, noms hachés par
// contenu — un test ne peut ni injecter d'autres fichiers runtime, ni forcer
// `readdirSync` à renvoyer un ordre spécifique de façon portable). Vérifié
// STRUCTURELLEMENT (le `.sort()` est bien appliqué au bon endroit) plutôt que
// comportementalement — décision de portée délibérée, comme documenté pour
// d'autres cas similaires cette session (ex. TOCTOU du lock CLI).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('SSR renderToString — ordre de chargement des fichiers runtime déterministe (pas readdirSync brut)', function () {
  it('runtimeIds est trié (par nom de fichier) avant concaténation dans componentCode', function () {
    const src = readFileSync(join(__dirname, '../src/server/renderToString.ts'), 'utf-8')
    const m = src.match(/const runtimeIds = scoped\.filter\([^)]*\)([\s\S]{0,60})\.map\(s => s\.id\)/)
    assert.ok(m, "la ligne de construction de `runtimeIds` doit exister sous cette forme reconnaissable")
    assert.match(m![1], /\.sort\(/,
      "AVANT le fix : runtimeIds gardait l'ordre brut de readdirSync (non garanti par POSIX, peut varier " +
      "entre systèmes de fichiers/machines) — le `.sort(...)` doit être appliqué ENTRE le .filter() et le .map()")
  })
})
