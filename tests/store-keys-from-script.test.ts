// storeKeysSet — les `$$x` LUS dans le <script> doivent ouvrir la subscription
// store. Avant ce correctif, `storeKeysSet` (transpiler/
// index.ts) ne scannait QUE `effectsByVar`/`structVars` (déps du GABARIT,
// issues de compileHtml) : un `µeffect -> $$x...` isolé dans le <script>,
// jamais mentionné par le template, n'émettait AUCUNE ligne `_mjs_storeKeys` —
// `_mjs_storeSubscribe` (mjs_element.ts) n'était jamais posé, `_mjs_storeNotifyKey` ne
// trouvait personne, l'effet ne repartait JAMAIS sur écriture de la clé. Panne
// muette totale. Le fix ajoute un scan dédié (collectStoreReads,
// analyzer/index.ts), lecture-seule (une écriture pure ne sur-abonne pas).
//
// Harnais copié de tests/lint-max-state-vars.test.ts (transpile() direct,
// inspection de la sortie compilée — pas besoin de Bundler/happy-dom, aucune
// exécution runtime n'est en jeu ici, seulement ce que le compilateur ÉMET).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('storeKeysSet — lectures $$x du <script> (µeffect, méthode…) câblées à la subscription', function () {
  this.timeout(30000)

  it('µeffect -> $$rt.traces, gabarit SANS mention de $$rt → storeKeys contient "rt" (AVANT le fix : absent)', async () => {
    const src = `<script lang="coffee">\nµeffect -> console.log($$rt.traces)\n</script>\n<p>salut</p>`
    const { output } = await transpile(src, { moduleName: 'storekeysa' })
    assert.match(output, /_mjs_storeKeys/, 'la ligne _mjs_storeKeys doit être émise')
    assert.match(output, /_mjs_storeKeys\s*=\s*\[[^\]]*"rt"/, 'storeKeys doit contenir "rt"')
  })

  it('lecture via une méthode (@lit = -> $$panier.total, µeffect -> @lit()) → "panier" présent', async () => {
    const src = `<script lang="coffee">\n@lit = -> $$panier.total\nµeffect -> @lit()\n</script>\n<p>salut</p>`
    const { output } = await transpile(src, { moduleName: 'storekeysb' })
    assert.match(output, /_mjs_storeKeys\s*=\s*\[[^\]]*"panier"/)
  })

  it('ÉCRITURE seule (@vide = -> $$panier = null) : aucune ligne _mjs_storeKeys (pas de sur-abonnement)', async () => {
    // NB — `$$panier = null` compile en `µ._storeSet("panier", null)` (path-tracker.ts,
    // écriture top-level réécrite en CALL, jamais en `µ.store.panier = …`) : le
    // littéral "panier" apparaît donc légitimement comme ARGUMENT de _storeSet,
    // sans rapport avec storeKeys — on vérifie spécifiquement l'ABSENCE de la
    // ligne _mjs_storeKeys elle-même (storeKeysSet doit rester vide), pas juste
    // l'absence du mot "panier" dans la sortie entière.
    const src = `<script lang="coffee">\n@vide = -> $$panier = null\n</script>\n<p>salut</p>`
    const { output } = await transpile(src, { moduleName: 'storekeysc' })
    assert.doesNotMatch(output, /_mjs_storeKeys/)
  })

  it('lecture ET écriture de la même clé → présente', async () => {
    const src = `<script lang="coffee">\n@lit = -> $$panier.total\n@vide = -> $$panier = null\nµeffect -> @lit()\n</script>\n<p>salut</p>`
    const { output } = await transpile(src, { moduleName: 'storekeysd' })
    assert.match(output, /_mjs_storeKeys\s*=\s*\[[^\]]*"panier"/)
  })

  it('µ.store référencé nu (Object.keys(µ.store)) → "*" présent', async () => {
    const src = `<script lang="coffee">\nµeffect -> console.log(Object.keys(µ.store).length)\n</script>\n<p>salut</p>`
    const { output } = await transpile(src, { moduleName: 'storekeyse' })
    assert.match(output, /_mjs_storeKeys\s*=\s*\[[^\]]*"\*"/)
  })

  it('non-régression : composant qui ne touche pas au store → aucune ligne _mjs_storeKeys', async () => {
    const src = `<script lang="coffee">\n$compteur = 0\n</script>\n<p>{$compteur}</p>`
    const { output } = await transpile(src, { moduleName: 'storekeysf' })
    assert.doesNotMatch(output, /_mjs_storeKeys/)
  })
})
