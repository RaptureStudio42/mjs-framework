import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts')

// Params de route : PLUS d'injection en attributs DOM. L'ancien mécanisme
// (`_applyRouteParams` → `el.setAttribute` → `$id`) collisionnait avec les
// attributs natifs (`id`/`class`…). Il est RETIRÉ : les params se lisent
// désormais via le sigil `&id` (≡ `µ.url.params.id`), maintenu par le routeur.
describe('routeur — params via µ.url.params (plus d\'injection d\'attribut)', function () {
  const src = readFileSync(SRC, 'utf-8')

  it('_applyRouteParams a été RETIRÉ', function () {
    assert.doesNotMatch(src, /_applyRouteParams:\s*function/, 'la méthode ne doit plus exister')
    assert.doesNotMatch(src, /this\._applyRouteParams\(/, 'plus aucun appel')
  })

  it('le routeur ne pose plus les params en attributs', function () {
    // Aucun setAttribute de params de route ; la seule écriture d'attribut
    // restante côté routeur ne concerne pas les params (il n'y en a plus).
    assert.doesNotMatch(src, /setAttribute\(k,\s*params\[k\]\)/, 'plus de setAttribute(param)')
    assert.doesNotMatch(src, /_mjs_routeParamKeys/, 'plus de suivi des clés de params posées')
  })

  it('_mjs_injectView n\'accepte plus d\'argument params', function () {
    assert.match(src, /_mjs_injectView:\s*function\(comp,\s*targetId,\s*moduleName,\s*matchPath\)/, 'signature sans params')
  })

  it('les params restent extraits et exposés via µ.url.params', function () {
    // _mjs_extractParams (agrégation) + _mjs_updateUrlStore (écriture sur µ.url.params)
    assert.match(src, /_mjs_extractParams:\s*function/, '_mjs_extractParams conservé (agrégation des params)')
    assert.match(src, /µ\.url\.params = params/, 'params exposés sur µ.url.params')
  })

  it('le joker * capture le reste du chemin dans params.all (tableau, &all) ET params.rest (chaîne, &rest)', function () {
    // Backtracking (cf. router-optional-mid-segment) :
    // _mjs_matchRoute délègue désormais à _matchSegs (récursif, index mi/ri) —
    // la capture reste `params.all`, juste construite dans une copie (`all`)
    // plutôt qu'une mutation directe de `params`. Couverture d'exécution
    // équivalente : router-prefix-match.test.ts, "catch-all * continue de
    // capturer tout le reste". Chaque segment est désormais décodé
    // (comme `:param`) avant le join. DÉCISION — le joker pose
    // DEUX clés : `all` = tableau des segments décodés, `rest` = ce même
    // tableau rejoint par `/` (un seul point de vérité, `rest` en découle).
    assert.match(src, /all\.all = mp\.slice\(mi\)\.map\(function\(s\)[\s\S]*?decodeURIComponent\(s\)[\s\S]*?\)\s*;/, 'capture nommée all, tableau de segments décodés')
    assert.match(src, /all\.rest = all\.all\.join\('\/'\)/, 'rest dérive du tableau all par join')
  })
})
