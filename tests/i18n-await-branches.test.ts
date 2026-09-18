// Préfixage i18n compile-time (applyI18nPrefixing, transpiler/index.ts) manquant
// dans les branches d'un {await} : constaté dans Chromium
// (`showcase-await`), un `{µt('p_1')}` posé dans la branche pending d'un `{await}` s'affichait
// « ⟦p_1⟧ » (clé NON préfixée par la section @i18n) alors que le même `{µt('p_1')}` hors du
// bloc marchait. Cause RÉELLE (différente de l'hypothèse de départ « canal manquant ») : le
// masque partagé `MASK_STRINGS_AND_COMMENTS_RE`, utilisé par `applyI18nPrefixing` pour ignorer
// un `µ.t(` simplement MENTIONNÉ dans une chaîne, avale un gabarit (backtick) ENTIER, `${…}`
// compris — un texte STATIQUE de branche {await} compile en
// `document.createTextNode(\`${µ.t('p_1')}\`)` (jamais en `_mjs_updText(...)`, cf. {if}/{for}/{key})
// et ce `µ.t(` niché dans l'interpolation disparaissait donc du masque, jamais trouvé, jamais
// réécrit. Calqué sur tests/i18n-compile.test.ts (même manière de transpiler et d'inspecter le
// code produit).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.ts'

describe("i18n — préfixage compile-time dans les branches d'un {await}", function () {
  this.timeout(8000)

  it("@i18n 'sec' : µt('p_1'/'p_2'/'p_3') préfixés dans pending/success/error, plus aucune clé nue", async () => {
    const src = [
      "@i18n 'sec'",
      '<script>',
      '$p = Promise.resolve(1)',
      '</script>',
      '{await $p}',
      "<p>{µt('p_1')}</p>",
      '{success v}',
      "<p>{µt('p_2')}</p>",
      '{error err}',
      "<p>{µt('p_3')}</p>",
      '{end}',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-await-branches' })
    assert.match(output, /µ\.t\('sec\.p_1'/, 'branche pending préfixée')
    assert.match(output, /µ\.t\('sec\.p_2'/, 'branche success préfixée')
    assert.match(output, /µ\.t\('sec\.p_3'/, 'branche error préfixée')
    assert.doesNotMatch(output, /µ\.t\('p_1'/, 'plus aucune clé nue (pending)')
    assert.doesNotMatch(output, /µ\.t\('p_2'/, 'plus aucune clé nue (success)')
    assert.doesNotMatch(output, /µ\.t\('p_3'/, 'plus aucune clé nue (error)')
  })

  it("non-régression — {if}/{for}/{key} restent préfixés (canal _mjs_updText/effects, jamais touché par ce bogue)", async () => {
    const srcIf = [
      "@i18n 'sec'",
      '<script>',
      '$flag = true',
      '</script>',
      '{if $flag}',
      "<p>{µt('p_1')}</p>",
      '{end}',
    ].join('\n')
    const { output: outIf } = await transpile(srcIf, { moduleName: 'mjs-i18n-if-branch' })
    assert.match(outIf, /µ\.t\('sec\.p_1'/)

    const srcFor = [
      "@i18n 'sec'",
      '<script>',
      '$items = [1, 2]',
      '</script>',
      '{for item in $items}',
      "<p>{µt('p_1')}</p>",
      '{end}',
    ].join('\n')
    const { output: outFor } = await transpile(srcFor, { moduleName: 'mjs-i18n-for-branch' })
    assert.match(outFor, /µ\.t\('sec\.p_1'/)

    const srcKey = [
      "@i18n 'sec'",
      '<script>',
      '$k = 1',
      '</script>',
      '{key $k}',
      "<p>{µt('p_1')}</p>",
      '{end}',
    ].join('\n')
    const { output: outKey } = await transpile(srcKey, { moduleName: 'mjs-i18n-key-branch' })
    assert.match(outKey, /µ\.t\('sec\.p_1'/)
  })

  it("non-régression — un `${…}` interpolé dans une chaîne de <script> reste préfixé (même famille de bogue, hors {await})", async () => {
    const src = [
      "@i18n 'sec'",
      '<script lang="civet">',
      'x := "hello #{µt(\'p_1\')}"',
      '</script>',
      '<p>{x}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-script-template-interp' })
    assert.match(output, /µ\.t\('sec\.p_1'/)
  })
})
