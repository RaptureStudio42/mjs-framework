// Régression : `history.scrollRestoration`
// n'était jamais mis à 'manual'. Le commentaire voisin (`_mjs_scrollPos`)
// affirmait déjà que le natif du navigateur ne convient pas à un swap DOM
// manuel, mais sans cette ligne, il restait actif EN PARALLÈLE de
// `_mjs_saveScroll`/`_mjs_restoreScroll` : sur un retour arrière, le navigateur
// restaure D'ABORD sa propre position mémorisée, puis notre code écrase
// IMMÉDIATEMENT avec la sienne — un double-scroll/flash au lieu d'un seul
// mouvement net.
//
// Fix : `if ('scrollRestoration' in window.history) { window.history.scrollRestoration = 'manual'; }`
// posé au chargement du module, juste après la déclaration de `µ._mjs_scrollPos`.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractScrollRestorationInit(src: string): string {
  const m = src.match(/if \('scrollRestoration' in window\.history\) \{\s*window\.history\.scrollRestoration = 'manual';\s*\}/)
  assert.ok(m, "bloc scrollRestoration introuvable (structure de mjs_ujs.ts a changé ?)")
  return m[0]
}

describe("mjs_ujs — history.scrollRestoration = 'manual' au chargement", function () {
  it("le pose sur 'manual' quand le navigateur supporte la propriété", function () {
    const history: any = { scrollRestoration: 'auto' }
    const window: any = { history }
    new Function('window', extractScrollRestorationInit(UJS_SRC))(window)
    assert.equal(history.scrollRestoration, 'manual', "AVANT le fix : jamais posé, restait sur 'auto' (natif actif en parallèle de _mjs_saveScroll/_mjs_restoreScroll)")
  })

  it("ne plante pas si le navigateur ne supporte pas scrollRestoration (repli silencieux)", function () {
    const history: any = {} // pas de propriété scrollRestoration du tout
    const window: any = { history }
    assert.doesNotThrow(() => new Function('window', extractScrollRestorationInit(UJS_SRC))(window))
    assert.ok(!('scrollRestoration' in history), "ne doit pas créer la propriété si le navigateur ne la supporte pas")
  })
})
