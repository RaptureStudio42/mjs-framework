// Test de régression — jumeau de ssr-runtime-order-deterministic.test.ts :
// `renderToString.ts` construisait `restIds` (fichiers non-runtime, ceux qui NE
// commencent PAS par `mjs_`) directement depuis `scoped` (lui-même dérivé de
// `jsFiles = readdirSync(outputDir)`), SANS tri par nom de fichier, avant de les
// passer à `topoSortFiles` (algorithme de Kahn) — qui préserve l'ordre d'ENTRÉE
// pour les nœuds SANS dépendance entre eux. Comme `readdirSync` NE GARANTIT PAS
// son ordre (POSIX), l'ordre de sortie SSR pouvait donc varier d'une machine ou
// d'un système de fichiers à l'autre pour les fichiers sans relation de
// dépendance — alors que `runtimeIds`, lui, avait déjà reçu ce tri.
//
// Note méthode : même contrainte que le test jumeau — `restIds` est un tableau
// interne à `createSSRRenderer` (non exporté), impossible d'injecter un ordre
// de `readdirSync` spécifique de façon portable. Vérifié STRUCTURELLEMENT (le
// `.sort()` est bien appliqué au bon endroit, entre le `.filter()` et le
// `.map()`) plutôt que comportementalement.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('SSR renderToString — ordre des fichiers non-runtime déterministe (pas readdirSync brut)', function () {
  it('restIds est trié (par nom de fichier) avant le passage à topoSortFiles', function () {
    const src = readFileSync(join(__dirname, '../src/server/renderToString.ts'), 'utf-8')
    const m = src.match(/const restIds = scoped\.filter\([^)]*\)([\s\S]{0,60})\.map\(s => s\.id\)/)
    assert.ok(m, "la ligne de construction de `restIds` doit exister sous cette forme reconnaissable")
    assert.match(m![1], /\.sort\(/,
      "AVANT le fix : restIds gardait l'ordre brut de readdirSync (non garanti par POSIX, peut varier " +
      "entre systèmes de fichiers/machines) — le `.sort(...)` doit être appliqué ENTRE le .filter() et le .map()")
  })
})
