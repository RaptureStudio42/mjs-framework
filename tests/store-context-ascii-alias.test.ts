// Alias ASCII (clavier sans `§`) :
//  - STORE : `$$X` / `µ$$X` (on double le `$` de la variable réactive). UNIQUE
//    sigil store — l'ancien `µ§` a été RETIRÉ (n'est plus reconnu).
//  - CONTEXTE / PARTAGÉ : `__context.X` → `§X`, `__shared.X` → `§§X`, opt-in
//    (`contextAlias: true`), `§`/`§§` restant canoniques.

import assert from 'node:assert/strict'
import { normalizeContextAlias, applyMjsSugarToScript, lintSingletonConsume, transpile } from '../src/transpiler/index.js'
import { tokenize } from '../src/lexer/index.js'

describe('store ASCII : $$X / µ$$X (double $, unique sigil store)', () => {
  it('lecture nue `$$count` → `µ.store.count` (STORE GLOBAL réactif)', () => {
    assert.equal(tokenize('$$count'), 'µ.store.count')
  })
  it('sur un singleton importé (externalVar) → ERREUR (se consomme en µ$$count)', () => {
    assert.throws(() => tokenize('$$count', { externalVars: ['$count'] }), /µ\$\$count/)
  })
  it('déclaration `export µ$$count = …` route vers la décl. universelle (µ.state + export $count)', () => {
    const out = applyMjsSugarToScript('export µ$$count = { value: 0 }')
    assert.match(out, /export \$count = µ_state\.count/)
    assert.match(out, /µ_state\.count \?= µ\.state\(/)
    assert.doesNotMatch(out, /µ\$\$/)
  })
  it('usage `µ$$count.value` → `$count.value` (nom déclaré `export µ$$count` dans la même source)', () => {
    // applyMjsSugarToScript recrée sa PROPRE garantie « nom connu »
    // (chemin module autonome, pas de pré-passe 0-bis de transpile()) : un
    // `µ$$count` sans `export µ$$count` correspondant DANS la même source
    // lève désormais `singleton-sans-import` (cf. test dédié plus bas).
    const out = applyMjsSugarToScript('export µ$$count = { value: 0 }\nµ$$count.value++')
    assert.match(out, /\$count\.value\+\+/)
    assert.doesNotMatch(out, /µ\$\$count/)
  })
  it('`µ$$count` SANS déclaration `export µ$$count` dans la même source → erreur singleton-sans-import', () => {
    assert.throws(() => applyMjsSugarToScript('µ$$count.value++'), /« µ\$\$count » utilisé sans/)
  })
  it('RÉGRESSION : `µ§` n\'est PLUS reconnu (retiré) → laissé tel quel', () => {
    assert.equal(applyMjsSugarToScript('µ§count.value++'), 'µ§count.value++')
    assert.match(applyMjsSugarToScript('export µ§count = { value: 0 }'), /µ§count/)
  })
})

describe('normalizeContextAlias (__context / __shared, opt-in)', () => {
  const n = (s: string) => normalizeContextAlias(s, true)

  it('`__context.X` → `§X` (get)', () => {
    assert.equal(n('__context.theme'), '§theme')
  })
  it('`__context.X = v` → `§X = v` (set)', () => {
    assert.equal(n("__context.theme = 'dark'"), "§theme = 'dark'")
  })
  it('`__shared.X` → `§§X`', () => {
    assert.equal(n('__shared.user'), '§§user')
  })
  it('bout-en-bout : `__context.theme` → getContext, `__shared.user` → contexte réactif', () => {
    assert.equal(tokenize(n('__context.theme')), "this._mjs_getContext('theme')")
    assert.equal(tokenize(n('__shared.user')), "this._mjs_getRCtx('user')")
  })
  it('NE touche pas un identifiant qui contient __context (frontière de mot)', () => {
    assert.equal(n('my__context.x'), 'my__context.x')
  })
  it('OFF par défaut (enabled absent/false) → inchangé', () => {
    assert.equal(normalizeContextAlias('__context.theme'), '__context.theme')
    assert.equal(normalizeContextAlias('__shared.user', false), '__shared.user')
  })

  // `normalizeContextAlias` DOIT être résolu AVANT le lint singleton et
  // extractDirectives : `@import __shared.count` devient `@import §§count`,
  // qui claque en erreur de migration — VOULU, l'alias ASCII du singleton
  // importé est `mjs$$`, `__shared` reste réservé au contexte.
  it('`@import __shared.count` (contextAlias: true) → erreur de migration (ancienne forme §§), jamais un import silencieux', async () => {
    const src = `@import __shared.count 'p'\n<p>{$count}</p>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'x3', contextAlias: true }),
      /« @import §§count ».*@import µ\$\$count/s
    )
  })
})

describe('lint singleton — @import µ$$X se consomme UNIQUEMENT en µ$$X (source du dev)', () => {
  it('lecture en $X (nu) → throw', () => {
    assert.throws(() => lintSingletonConsume(`@import µ$$count 'p'\n<p>{$count.value}</p>`), /µ\$\$count/)
  })
  it('lecture en $$X → throw', () => {
    assert.throws(() => lintSingletonConsume(`@import µ$$count 'p'\n<p>{$$count.value}</p>`), /µ\$\$count/)
  })
  it('lecture en §§X → throw (piège de migration nº1)', () => {
    assert.throws(() => lintSingletonConsume(`@import µ$$count 'p'\n<p>{§§count.value}</p>`), /µ\$\$count/)
  })
  it('lecture en µ$$X → OK', () => {
    assert.doesNotThrow(() => lintSingletonConsume(`@import µ$$count 'p'\n<p>{µ$$count.value}</p>`))
  })
  it('import brut `@import $counter` (pas µ$$) → pas de lint', () => {
    assert.doesNotThrow(() => lintSingletonConsume(`@import $counter 'p'\n<p>{$counter.count}</p>`))
  })
  it('la ligne @import elle-même n\'est pas flaggée', () => {
    assert.doesNotThrow(() => lintSingletonConsume(`@import µ$$count 'p'\n<p>{µ$$count}</p>`))
  })
  it('sigil affiché dans <pre>/<code> (doc) ignoré', () => {
    assert.doesNotThrow(() => lintSingletonConsume(`@import µ$$count 'p'\n<pre><code>{$count.value}</code></pre>`))
  })
  it('ne confond pas un préfixe (`$count` importé n\'affecte pas `$counter`)', () => {
    assert.doesNotThrow(() => lintSingletonConsume(`@import µ$$count 'p'\n<p>{µ$$count} {$counter}</p>`))
  })
})

// le masquage AVANT ce fix
// ne couvrait que le HTML (<pre>/<code>/<!-- -->) : un commentaire de SCRIPT
// (# Coffee, // Civet/JS, /* */, ### ### Coffee) ou une CHAÎNE littérale qui
// mentionne juste "$X" en exemple/doc/message d'erreur faisait échouer la
// compilation d'un projet par ailleurs correct — un faux positif.
describe('lint singleton — commentaires et chaînes de script ne déclenchent PAS de faux positif', () => {
  it('commentaire Coffee (#) qui mentionne $count : ignoré', () => {
    assert.doesNotThrow(() => lintSingletonConsume(
      `@import µ$$count 'p'\n<script lang="coffee">\n# ancien : $count, nouveau : µ$$count\nx = µ$$count.value\n</script>`
    ), "AVANT le fix : le commentaire seul faisait throw, alors qu'aucun VRAI usage n'existe")
  })

  it('commentaire bloc Coffee (###...###) multi-lignes qui mentionne $count : ignoré EN ENTIER', () => {
    assert.doesNotThrow(() => lintSingletonConsume(
      `@import µ$$count 'p'\n<script lang="coffee">\n###\nmigration : $count -> µ$$count\nvoir aussi $$count\n###\nx = µ$$count.value\n</script>`
    ), "AVANT le fix (et avec un simple '#…' générique mal ordonné) : le bloc multi-lignes n'était pas consommé en entier")
  })

  it('commentaire // (Civet/JS) qui mentionne $count : ignoré', () => {
    assert.doesNotThrow(() => lintSingletonConsume(
      `@import µ$$count 'p'\n<script lang="civet">\n// $count est deprecated, utiliser µ$$count\nx := µ$$count.value\n</script>`
    ))
  })

  it('commentaire bloc /* */ qui mentionne $count : ignoré', () => {
    assert.doesNotThrow(() => lintSingletonConsume(
      `@import µ$$count 'p'\n<script lang="civet">\n/* $count est deprecated */\nx := µ$$count.value\n</script>`
    ))
  })

  it("chaîne littérale (message d'erreur/log) qui mentionne $count : ignorée", () => {
    assert.doesNotThrow(() => lintSingletonConsume(
      `@import µ$$count 'p'\n<script lang="coffee">\nconsole.log("utilisez µ$$count, pas $count")\nx = µ$$count.value\n</script>`
    ))
  })

  it('chaîne template literal (backticks) qui mentionne $count : ignorée', () => {
    assert.doesNotThrow(() => lintSingletonConsume(
      "@import µ$$count 'p'\n<script lang=\"civet\">\nmsg := `interpole ${1+1} mais mentionne $count en texte`\nx := µ$$count.value\n</script>"
    ))
  })

  it('un VRAI abus qui SUIT un commentaire inoffensif est TOUJOURS détecté (le masquage ne cache pas le vrai code)', () => {
    assert.throws(() => lintSingletonConsume(
      `@import µ$$count 'p'\n<script lang="coffee">\n# ceci documente µ$$count correctement\nx = $count.value\n</script>`
    ), /µ\$\$count/)
  })

  it('un VRAI abus DANS le code, sur la même ligne juste après un commentaire, est TOUJOURS détecté', () => {
    assert.throws(() => lintSingletonConsume(
      `@import µ$$count 'p'\n<script lang="coffee">\ny = 1 # noop\nx = $count.value\n</script>`
    ), /µ\$\$count/)
  })
})

// Masquage doc au niveau transpile() : la passe µ$$ (0-bis) opère sur le source
// BRUT (template compris) — mais un tuto/doc qui MONTRE `µ$$X` dans <pre>/<code>
// ne doit PAS être réécrit en `$X`. (Régression : sans masquage, `µ$$session`
// affiché devenait `$session` dans la doc rendue.)
describe('transpile — µ$$ affiché dans <pre>/<code> non transformé', function () {
  this.timeout(30000)
  it('conserve `µ$$session` littéral dans un bloc <code> de doc', async () => {
    const src = `<div class="text"><p>Déclarez <code>export µ$$session = { user: null }</code> puis lisez <code>µ$$session.user</code>.</p></div>`
    const { output } = await transpile(src, { moduleName: 'docsingleton' })
    assert.match(output, /µ\$\$session/, 'le µ$$session affiché doit survivre littéralement')
    assert.doesNotMatch(output, /export \$session =/, 'le code affiché ne doit pas être compilé')
  })
  it('mais transforme encore un µ$$ FONCTIONNEL hors doc (binding live)', async () => {
    const src = `@import µ$$count 'p'\n<button @click={µ$$count.value++}>{µ$$count.value}</button>`
    const { output } = await transpile(src, { moduleName: 'funcsingleton' })
    assert.match(output, /\$count\.value/, 'le binding live µ$$count doit router vers $count')
    assert.doesNotMatch(output, /µ\$\$count/, 'aucun µ$$ fonctionnel ne doit subsister')
  })
})

// `§§clé` HORS singleton importé = contexte RÉACTIF de sous-arbre :
// déclaré sur un ancêtre (_mjs_setRCtx → proxy µ.state), lu en descendance
// (_mjs_getRCtx → remonte l'arbre + abonne le lecteur). Le fallback µ.shared est retiré.
// `§§` n'a PLUS AUCUNE résolution vers un singleton, importé ou pas :
// c'est désormais TOUJOURS ce contexte réactif de sous-arbre, y compris
// lorsqu'un singleton du MÊME nom est importé ailleurs dans le fichier.
describe('transpile — §§ contexte réactif de sous-arbre', function () {
  this.timeout(30000)
  it('déclaration §§ → _mjs_setRCtx, lecture §§ → _mjs_getRCtx (plus de µ.shared)', async () => {
    const src = `<script>\n  §§theme = { color: 'dark' }\n</script>\n<p>{§§theme.color}</p>`
    const { output } = await transpile(src, { moduleName: 'rctx1' })
    assert.match(output, /_mjs_setRCtx\('theme',/, 'déclaration §§ → setRCtx')
    assert.match(output, /_mjs_getRCtx\('theme'\)/, 'lecture §§ → getRCtx')
    assert.doesNotMatch(output, /µ\.shared/, 'le fallback µ.shared est retiré')
  })
  it('µ$$ importé via @import µ$$ reste un singleton (→ $X), pas un contexte', async () => {
    const src = `@import µ$$counter 'p'\n<button @click={µ$$counter.count++}>{µ$$counter.count}</button>`
    const { output } = await transpile(src, { moduleName: 'rctx2' })
    assert.match(output, /\$counter\.count/, 'singleton importé → $counter')
    assert.doesNotMatch(output, /_mjs_getRCtx/, 'un singleton n\'est pas un contexte réactif')
  })

  it('@import §§ (ancienne écriture) → erreur de migration explicite', async () => {
    const src = `@import §§counter 'p'\n<p>{µ$$counter.count}</p>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'rctx3' }),
      /« @import §§counter ».*@import µ\$\$counter/s
    )
  })
})
