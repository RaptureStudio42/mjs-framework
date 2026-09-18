// Tests du transpiler — cycle complet .mjs → JS

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'
import {
  extractDirectives,
  buildPersistCode,
} from '../src/transpiler/directives.js'
import { extractSections } from '../src/transpiler/sections.js'

describe('transpiler/directives', () => {
  // @css/@display RELOGÉS : attributs de <style>, cf. describe
  // dédié « transpiler/sections — attributs @css/@display/@viewTransition de <style> ».

  it('extrait @persist multi-vars vers localStorage', () => {
    const r = extractDirectives(`@persist $a $b\n<p/>`)
    assert.deepEqual(r.persistLocalVars.map(e => e.var), ['$a', '$b'])
  })

  it('extrait @persist session: vars vers sessionStorage', () => {
    const r = extractDirectives(`@persist session: $a $b\n<p/>`)
    assert.deepEqual(r.persistSessionVars.map(e => e.var), ['$a', '$b'])
    assert.deepEqual(r.persistLocalVars, [])
  })

  it('extrait @persist avec by: suffix', () => {
    const r = extractDirectives(`@persist $page by: location.pathname\n<p/>`)
    assert.equal(r.persistLocalVars[0].var, '$page')
    assert.equal(r.persistLocalVars[0].suffix, 'location.pathname')
  })

  // extractDirectives seul reste vrai : la garde @import $X (dollar simple) vit AU-DESSUS, dans transpile() (lintImportDollarName, avant extractDirectives).
  it('extrait @import named et populate externalReactives', () => {
    const r = extractDirectives(`@import $count helper 'shared/store'\n<p/>`)
    assert.ok(r.externalReactives.has('$count'))
    assert.equal(r.pendingAutoImports.length, 1)
    assert.match(r.pendingAutoImports[0], /import \{ \$count, helper \}/)
  })

  // une virgule résiduelle entre deux noms (ancienne
  // écriture) est désormais rejetée EXPLICITEMENT (avant : silencieusement
  // absorbée dans un split par virgule). Le dernier token de la ligne reste
  // TOUJOURS le chemin (déjà isolé par sa propre capture quotée).
  it('@import avec virgule résiduelle entre les noms → erreur explicite orientant vers l\'espace', () => {
    assert.throws(
      () => extractDirectives(`@import $count, helper 'shared/store'\n<p/>`),
      /virgule interdite entre les noms.*sépare-les par un espace \(@import nomA nomB 'shared\/store'\)/s,
    )
  })

  it('@import 3 noms espacés + chemin en dernière position : chemin correctement isolé', () => {
    const r = extractDirectives(`@import a b c 'shared/store'\n<p/>`)
    assert.equal(r.pendingAutoImports.length, 1)
    assert.match(r.pendingAutoImports[0], /import \{ a, b, c \} from "µasset\('shared\/store'\)"/)
  })

  it('@import URL passe en passthrough sans µasset()', () => {
    const r = extractDirectives(`@import name 'https://cdn/lib.js'\n<p/>`)
    assert.match(r.pendingAutoImports[0], /'https:\/\/cdn\/lib\.js'/)
    assert.doesNotMatch(r.pendingAutoImports[0], /µasset/)
  })

  it('@import default lib produit `import lib from`', () => {
    const r = extractDirectives(`@import default tippy 'tippy.js'\n<p/>`)
    assert.match(r.pendingAutoImports[0], /import tippy from/)
  })
})

describe('buildPersistCode', () => {
  it('produit du Coffee avec key statique', () => {
    const code = buildPersistCode('foo', [{ var: '$x', suffix: null }], [])
    assert.match(code, /'mjs-foo:x'/)
    assert.match(code, /localStorage\.getItem/)
    assert.match(code, /µ\.effect/)
  })

  it('produit du Coffee avec key dynamique (suffix)', () => {
    const code = buildPersistCode('foo', [{ var: '$x', suffix: 'route' }], [])
    assert.match(code, /"mjs-foo:x:" \+ \(route\)/)
  })

  it('utilise sessionStorage pour vars session', () => {
    const code = buildPersistCode('foo', [], [{ var: '$x', suffix: null }])
    assert.match(code, /sessionStorage\.getItem/)
    assert.doesNotMatch(code, /localStorage/)
  })
})

describe('transpiler/sections — attributs @css/@display/@viewTransition de <style>', () => {
  it('extrait @css names (attribut de <style>) et les retire du contenu', () => {
    const r = extractSections(`<style @css="base typo"></style>\n<p>hello</p>`)
    assert.deepEqual(r.style.sharedCssNames, ['base', 'typo'])
    assert.match(r.html, /<p>hello<\/p>/)
  })

  it('extrait @display (attribut de <style>)', () => {
    const r = extractSections(`<style @display="flex"></style>\n<p>x</p>`)
    assert.equal(r.style.moduleDisplay, 'flex')
  })

  it('défaut @display = block quand absent', () => {
    const r = extractSections(`<p>x</p>`)
    assert.equal(r.style.moduleDisplay, 'block')
  })

  it('<style> ne portant QUE des attributs, corps vide : légal, aucun CSS', () => {
    const r = extractSections(`<style @css="base" @display="inline-block"></style>\n<p>x</p>`)
    assert.deepEqual(r.style.sharedCssNames, ['base'])
    assert.equal(r.style.moduleDisplay, 'inline-block')
    assert.equal(r.style.raw.trim(), '')
  })

  it('@viewTransition nu (attribut sans valeur) → sentinel "on"', () => {
    const r = extractSections(`<style @viewTransition></style>\n<p>x</p>`)
    assert.equal(r.style.moduleViewTransition, 'on')
  })

  it('@viewTransition.cube={ dir: left } (attribut pointé) → verbatim + priorité par défaut', () => {
    const r = extractSections(`<style @viewTransition.cube={ dir: left }></style>\n<p>x</p>`)
    assert.equal(r.style.moduleViewTransition, 'cube={ dir: left }')
    assert.equal(r.style.moduleViewTransitionPriority, 1)
  })

  it('@viewTransition.cube={ priority: 5 } (attribut pointé) → priorité extraite', () => {
    const r = extractSections(`<style @viewTransition.cube={ priority: 5 }></style>\n<p>x</p>`)
    assert.equal(r.style.moduleViewTransition, 'cube={ priority: 5 }')
    assert.equal(r.style.moduleViewTransitionPriority, 5)
  })

  it('@viewTransition="cube" (guillemets, ancienne forme relogée) → refusé', () => {
    assert.throws(() => extractSections(`<style @viewTransition="cube"></style>\n<p>x</p>`), /@viewTransition="…" avec guillemets n'existe plus/)
  })

  it('@vt.cube={…} (alias, attribut de <style>) → refusé, oriente vers @viewTransition', () => {
    assert.throws(() => extractSections(`<style @vt.cube={ dir: left }></style>\n<p>x</p>`), /@vt n'est pas un alias sur <style>.*@viewTransition/)
  })

  it('@css/@display/@viewTransition à la racine du fichier → erreur de compilation orientant vers <style>', () => {
    assert.throws(() => extractDirectives(`@css base\n<p/>`), /@css ne s'écrit plus à la racine.*<style @css="base">/s)
    assert.throws(() => extractDirectives(`@display flex\n<p/>`), /@display ne s'écrit plus à la racine.*<style @display="flex">/s)
    assert.throws(() => extractDirectives(`@viewTransition.cube\n<p/>`), /@viewTransition ne s'écrit plus à la racine.*<style @viewTransition.cube>/s)
    assert.throws(() => extractDirectives(`@viewTransition\n<p/>`), /@viewTransition ne s'écrit plus à la racine.*<style @viewTransition>/s)
    // l'alias `@vt` n'existe plus sur `<style>` : le remplacement propose le nom LONG
    assert.throws(() => extractDirectives(`@vt.cube\n<p/>`), /@vt ne s'écrit plus à la racine.*<style @viewTransition.cube>/s)
  })

  it('@css/@display/@viewTransition sur un <style name="…"> → erreur dédiée', () => {
    assert.throws(() => extractSections(`<style name="bandeau" @css="base"></style>\n<p/>`), /@css n'est valide que sur le <style> de base.*<style name="bandeau">/s)
    assert.throws(() => extractSections(`<style name="bandeau" @display="flex"></style>\n<p/>`), /@display n'est valide que sur le <style> de base/)
    assert.throws(() => extractSections(`<style name="bandeau" @viewTransition="cube"></style>\n<p/>`), /@viewTransition n'est valide que sur le <style> de base/)
  })
})

describe('transpiler — sucre µ', () => {
  it('µfoo → µ.foo dans le script', async () => {
    const src = `<script lang="coffee">
$x = 0
µemit('changed', $x)
</script>
<p>{$x}</p>`
    const { output } = await transpile(src, { moduleName: 'foo' })
    // µemit doit avoir été routé vers _mjsThis._mjs_emit
    assert.match(output, /_mjs_emit/)
  })

  it('µ.inspect($x) → µ.inspect("x")', async () => {
    const src = `<script lang="coffee">
$x = 0
µ.inspect($x)
</script>
<p>{$x}</p>`
    const { output } = await transpile(src, { moduleName: 'foo' })
    assert.match(output, /µ\.inspect\(['"]x['"]\)/)
    assert.doesNotMatch(output, /µ\.inspect\(\$\.x/)
  })

  it('µ.minmax($x, ...) → µ.minmax(_mjsThis, "x", ...)', async () => {
    const src = `<script lang="coffee">
$x = 0
µ.minmax($x, 0, 100)
</script>
<p>{$x}</p>`
    const { output } = await transpile(src, { moduleName: 'foo' })
    assert.match(output, /minmax\(_mjsThis,\s*['"]x['"]/)
  })
})

describe('transpiler/sections — lang explicite', () => {
  it('script lang="coffee" compile en Coffee', async () => {
    const src = `<script lang="coffee">
# Comment Coffee
$count = 0
$double = $count * 2
</script>
<p>{$count}</p>`
    const { output } = await transpile(src, { moduleName: 'foo' })
    assert.match(output, /class MjsFoo/)
  })

  it('script lang="ts" compile en TS', async () => {
    const src = `<script lang="ts">
const x: number = 0
$count = 0
</script>
<p>{$count}</p>`
    const { output } = await transpile(src, { moduleName: 'foo' })
    assert.match(output, /class MjsFoo/)
  })
})

describe('transpiler/sections', () => {
  it('extrait <script module> + <script> + <style> + html', () => {
    const src = `<script module>µ_state = µ.state({})</script>
<script>$count = 0</script>
<style>p { color: red }</style>
<p>{$count}</p>`
    const r = extractSections(src)
    assert.match(r.module.raw, /µ_state/)
    assert.match(r.script.raw, /\$count/)
    assert.match(r.style.raw, /color: red/)
    assert.match(r.html, /<p>\{\$count\}<\/p>/)
  })

  it('respecte lang="…" et fallback civet', () => {
    const r = extractSections(`<script lang="ts">$x: number = 0</script>`)
    assert.equal(r.script.lang, 'ts')
  })

  it('lang par défaut = civet (avec syntaxe JS distinctive)', () => {
    // Script avec `let`/`;` → fallback civet (défaut)
    const r = extractSections(`<script>let x = 0;</script>`)
    assert.equal(r.script.lang, 'civet')
  })

  it('skip <script module> dans la recherche du <script> standard', () => {
    const r = extractSections(`<script module>A</script>\n<script>B</script>`)
    assert.match(r.module.raw, /A/)
    assert.match(r.script.raw, /B/)
  })
})

describe('transpile() — pipeline complet', () => {
  it('produit un module minimal en CoffeeScript', async () => {
    const src = `<script lang="coffee">$count = 0</script>\n<p>{$count}</p>`
    const { output, data } = await transpile(src, { moduleName: 'foo' })
    assert.match(output, /class MjsFoo/)
    assert.match(output, /µ\._def\("mjs-foo"/)
    assert.match(output, /count/)
    assert.equal(data.tagName, 'mjs-foo')
  })

  it('classe les updates en struct/trans/content', async () => {
    const src = `<script lang="coffee">$x = true</script>
{if $x}<p>a</p>{end}`
    const { data } = await transpile(src, { moduleName: 'foo' })
    assert.ok(data.structUpdates.length > 0)
  })

  it('var_bits dict reflète les state vars (V2 : registre de présence)', async () => {
    const src = `<script lang="coffee">$a = 0\n$b = 0</script>\n<p>{$a} {$b}</p>`
    const { data } = await transpile(src, { moduleName: 'foo' })
    // V2 — plus un bitmask : chaque var a valeur 1 (présence pour rétro-compat
    // des stores universels qui font `_mjs_var_bits[k] !== undefined`).
    assert.match(data.varBitsStr, /"a": 1/)
    assert.match(data.varBitsStr, /"b": 1/)
  })

  it('@import populate l\'auto-import dans le module', async () => {
    // migré vers µ$$shared (@import $X, dollar simple, est refusé à la
    // compilation ; la pré-passe 0-bis aplatit µ$$shared en $shared, l'assertion reste identique).
    const src = `@import µ$$shared 'mod/shared'
<script lang="coffee" module>foo = 1</script>
<script lang="coffee">$x = 0</script>
<p>{$x}</p>`
    const { output } = await transpile(src, { moduleName: 'foo' })
    assert.match(output, /import\s*\{\s*\$shared\s*\}/)
  })

  it('@display modifie le :host display', async () => {
    const src = `<style @display="flex"></style>\n<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`
    const { output } = await transpile(src, { moduleName: 'foo' })
    assert.match(output, /:host\{display:flex\}/)
  })

  it('hasDynamicSlots détecte <@slot>', async () => {
    const src = `<script lang="coffee">$x = 0</script>\n<div><@slot 0></@slot></div>`
    const { data } = await transpile(src, { moduleName: 'foo' })
    assert.equal(data.hasDynamicSlots, true)
  })

  it('class name = Mjs + camelcase from module', async () => {
    const src = `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`
    const { data } = await transpile(src, { moduleName: 'my-cool-widget' })
    assert.equal(data.className, 'MjsMyCoolWidget')
    assert.equal(data.tagName, 'mjs-my-cool-widget')
  })
})

// ============================================================================
// Codegen impératif Svelte-like
//
// Le moteur MJS V2 NE génère PAS de string HTML à chaque update : le HTML
// "template" est parsé UNE fois (cloné via `<template>`), et les valeurs sont
// assignées impérativement aux text nodes / attributs via `_mjs_updText`,
// `nodeValue =`, `el.setAttribute(...)`, etc.
//
// Ces tests documentent et garantissent ce contrat de codegen.
// ============================================================================
describe('codegen impératif', () => {
  it('interpolation `{$x}` au root : placeholder commentaire + _mjs_updText (pas de regen string)', async () => {
    const src = `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`
    const { data, output } = await transpile(src, { moduleName: 'foo' })
    // `surgicalHtml` expose le HTML compilé À MARQUEURS
    // (`mjs-t='tN'`, remplacés par des Text nodes au mount). Le walk legacy
    // (placeholders `<!--$-->` + pathsStr), consommé nulle part en prod et
    // porteur d'une boucle infinie sur `a < b`, a été retiré.
    assert.match(data.surgicalHtml, /mjs-t='t\d+'/)
    // V2 — le code _mjs_updText vit désormais dans `_mjs_effectsByVar` (indexé par var)
    // et dans le tableau `_mjs_eff` (mount initial). On vérifie dans l'output.
    assert.match(output, /this\._mjs_updText\(['"]t\d+['"],\s*\$\.x\)/)
  })

  it('interpolation dans {for} : placeholder + nodeValue direct', async () => {
    const src = `<script lang="coffee">$list = [1,2,3]</script>\n{for $item in $list}<div>{$item}</div>{end}`
    const { output } = await transpile(src, { moduleName: 'foo' })
    // V2 — plus de marker `mjs-l-t`. Le body du for utilise
    // `<!--$-->` (placeholder commentaire) et des paths pour la résolution.
    assert.doesNotMatch(output, /mjs-l-t=|mjs\/marker/)
    // L'updateFn assigne via `node.data` (impératif, équivalent nodeValue,
    // Text.data slot natif spécialisé V8, plus rapide que nodeValue).
    assert.match(output, /const\s+n\w+\s*=\s*__nodes\[/)
    assert.match(output, /\.data\s*=/)
  })

  it('{if} : start/end placeholders + _mjs_updIf', async () => {
    const src = `<script lang="coffee">$show = true</script>\n{if $show}<p>x</p>{end}`
    const { data, output } = await transpile(src, { moduleName: 'foo' })
    // le `{if}` est borné par deux MARQUEURS start/end
    // (`mjs-t='s-ifN'` / `mjs-t='e-ifN'`) dans le HTML compilé exposé par
    // `surgicalHtml` (le walk legacy <!--$-->/pathsStr est retiré).
    assert.match(data.surgicalHtml, /mjs-t='s-if\d+'/)
    assert.match(data.surgicalHtml, /mjs-t='e-if\d+'/)
    // Call _mjs_updIf avec une string HTML (cond testée AVANT le call, pas dans la
    // string elle-même → la string est invariante, cacheable par _mjs_tplCache)
    assert.match(output, /this\._mjs_updIf\(['"]if\d+['"],/)
  })

  it('bind input `value=!{$x}` : event listener + µ._set direct', async () => {
    const src = `<script lang="coffee">$name = ''</script>\n<input value=!{$name}>`
    const { output } = await transpile(src, { moduleName: 'foo' })
    // Le bind émet un assignement direct via µ._set (impératif).
    assert.match(output, /µ\._set\([^)]*['"]name['"]/, `output:\n${output.slice(0, 500)}`)
    // Doit aussi binder node.value (writeback) ET enregistrer l'event listener 'input'.
    assert.match(output, /node\.value\s*=\s*\$\.name/, `output:\n${output.slice(0, 500)}`)
    assert.match(output, /_mjs_bindEvents\(\{"input":/, `output:\n${output.slice(0, 500)}`)
  })

  it('{for} : appelle _mjs_updFor avec keyFn + updateFn impératif', async () => {
    const src = `<script lang="coffee">$list = []</script>\n{for $item, idx in $list}<div>{$item}</div>{end}`
    const { output } = await transpile(src, { moduleName: 'foo' })
    // _mjs_updFor reçoit : id, iterable, tplFn, keyFn, updateFn
    assert.match(output, /this\._mjs_updFor\(['"]for\d+['"]/)
    // L'updateFn reçoit __nodes (les nodes du clone) et fait des assignations.
    // L'ordre dépend de la signature : (item, index) ou (index, item) selon source.
    assert.match(output, /\(__nodes,\s*\$?\w+,\s*\$?\w+\)\s*=>/)
  })
})

// ============================================================================
// {const NOM = EXPR} — déclaration de constante locale (≡ {@const} Svelte)
// ============================================================================
describe('{const} — déclaration locale dans {for}', () => {
  it('émet `const total = …` AVANT l\'update qui le lit, et UNE seule fois', async () => {
    const src = `<script lang="coffee">$arr = [{prix: 2, qte: 3}]</script>
<table>{for ligne in $arr}{const total = ligne.prix * ligne.qte}<td>{total}</td>{end}</table>`
    const { output } = await transpile(src, { moduleName: 'facture' })
    // La déclaration est présente (cleanJs n'altère pas `ligne.*` — var locale).
    assert.match(output, /const total = ligne\.prix \* ligne\.qte;/)
    // Le `{const}` est HISSÉ en tête de corps de rendu : la déclaration PRÉCÈDE
    // l'update qui consomme `total` (`_mjs_tv = total` — ex-`__v`, renommé).
    const declIdx = output.indexOf('const total =')
    const useIdx = output.indexOf('const _mjs_tv = total')
    assert.ok(declIdx >= 0 && useIdx >= 0, 'déclaration et usage présents')
    assert.ok(declIdx < useIdx, 'la déclaration précède son usage')
    // Le marqueur-sentinelle précède la déclaration (forme hoist, pas de
    // wrapper `{ … }` qui scoperait `total` hors de portée des frères).
    assert.match(output, /\/\*@mjs-const\*\/const total =/)
    // La déclaration n'est PAS enveloppée dans un bloc `{ … }` propre (qui
    // limiterait sa portée) : juste avant `const total`, on a soit le marqueur,
    // soit `; ` — jamais `{ ` seul ouvrant un bloc dédié.
    assert.doesNotMatch(output, /\{\s*\/\*@mjs-const\*\/const total =/)
    // Pas de nœud texte pour le {const} lui-même : seul `{total}` crée un marker.
    assert.doesNotMatch(output, /const total = .*createTextNode/)
    // (La non-redéclaration dans un même scope est prouvée à l'exécution par
    //  tests/const-in-for.test.ts : un `win.eval` du bundle planterait sinon.)
  })

  it('les $ de l\'EXPR passent par cleanJs ($tax → $.tax)', async () => {
    const src = `<script lang="coffee">$arr = [{prix: 2}]
$tax = 1.2</script>
<table>{for ligne in $arr}{const ttc = ligne.prix * $tax}<td>{ttc}</td>{end}</table>`
    const { output } = await transpile(src, { moduleName: 'ttc' })
    assert.match(output, /const ttc = ligne\.prix \* \$\.tax;/)
  })

  it('un $ de l\'EXPR pilote le recalcul (structVars → struct update)', async () => {
    const src = `<script lang="coffee">$arr = [{prix: 2}]
$tax = 1.2</script>
<table>{for ligne in $arr}{const ttc = ligne.prix * $tax}<td>{ttc}</td>{end}</table>`
    const { data } = await transpile(src, { moduleName: 'ttc2' })
    // L'EXPR dépend de $tax → le `{for}` redevient structurel sur mutation de tax.
    assert.ok(data.structUpdates.length > 0, 'au moins une struct update')
  })

  it('LIMITATION : {const} au niveau RACINE est rejeté avec un message clair', async () => {
    const src = `<script lang="coffee">$a = 5</script>
<div>{const dbl = $a * 2}<span>{dbl}</span></div>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'rootconst' }),
      /hors d'un \{for\} n'est pas supporté/,
    )
  })

  it('plusieurs {const} : ordre relatif préservé (l\'un peut lire l\'autre)', async () => {
    const src = `<script lang="coffee">$arr = [{prix: 2, qte: 3}]</script>
<table>{for ligne in $arr}{const sub = ligne.prix * ligne.qte}{const ttc = sub * 1.2}<td>{ttc}</td>{end}</table>`
    const { output } = await transpile(src, { moduleName: 'multi' })
    const subIdx = output.indexOf('const sub =')
    const ttcIdx = output.indexOf('const ttc =')
    assert.ok(subIdx >= 0 && ttcIdx >= 0, 'les deux const présents')
    assert.ok(subIdx < ttcIdx, 'sub déclaré avant ttc (qui le lit)')
  })
})

// ============================================================================
// Filtered Dispatch sur @class{cond}=…
// Pattern courant : `{for row in $rows} <tr @class{row.id === $selected}=…>`
// Au lieu d'invalider 1000 effects à chaque mute de $selected, on génère un
// index inverse Map<itemKey, fn> et un effect "filtered" qui ne tire QUE les
// 2 fns concernées (ancienne sélection + nouvelle). Gain massif sur select1k.
// ============================================================================
describe('Filtered Dispatch — @class{item.X === $extern}', () => {
  it("détecte le pattern row.id === $selected et émet l'entrée _mjs_filt[<extern>__<class>]", async () => {
    const src = `<script lang="coffee">$selected = -1
$rows = []
</script>
{for row in $rows}<div @class{row.id === $selected}="danger"></div>{end}`
    const { output } = await transpile(src, { moduleName: 'fd' })
    // L'index inverse doit être créé lazy par row, dans l'entrée
    // `_mjs_filt['selected__danger__<lid>']` (suffixe `__<lid>` — distingue 2 nœuds
    // d'une même row partageant le même (var, classe) ; voir
    // tests/filtered-dispatch-node-collision.test.ts pour la régression).
    assert.match(output, /\['selected__danger__\w+'\]\s*\?\?=\s*\{ idx: null, prev: void 0 \}/)
    assert.match(output, /__fe\.idx\s*\?\?=\s*new Map\(\)/)
    // l'index stocke le NŒUD (pas une closure) → zéro alloc par ligne.
    // La propriété de clé reste gardée via _mjs_filterFns.
    assert.doesNotMatch(output, /const __f = \(\)\s*=>/)
    assert.match(output, /__idx\.set\(__k,\s*n[a-zA-Z0-9_$]+\)/)
    assert.match(output, /_mjs_filterFns/)
    // Un effect filtered est enregistré pour la var externe `selected`.
    assert.match(output, /\(this\._mjs_filt \?\?= \{\}\)\['selected__danger__\w+'\]/)
    assert.match(output, /__fe\.prev = curr/)
    // l'effect toggle la classe DIRECTEMENT sur le nœud récupéré (prev →
    // retire, curr → ajoute), au lieu d'appeler une closure.
    assert.match(output, /idx\.get\(prev\)/)
    assert.match(output, /classList\.toggle\('danger', false\)/)
    assert.match(output, /classList\.toggle\('danger', true\)/)
    assert.match(output, /idx\.get\(curr\)/)
    // L'effect doit être abonné à `selected` dans _mjs_effectsByVar.
    assert.match(output, /"selected":\s*\[_mjs_eff/)
  })

  it('détecte le pattern inversé $selected === row.id', async () => {
    const src = `<script lang="coffee">$selected = -1
$rows = []
</script>
{for row in $rows}<div @class{$selected === row.id}="danger"></div>{end}`
    const { output } = await transpile(src, { moduleName: 'fd2' })
    // Pareil — l'index est sur `selected` (extern) avec key = `row.id` (item).
    assert.match(output, /\['selected__danger__\w+'\]\s*\?\?=\s*\{ idx: null, prev: void 0 \}/)
    assert.match(output, /"selected":\s*\[_mjs_eff/)
  })

  it("REJETTE l'op !== (un seul match exclu mais 999 affectés)", async () => {
    const src = `<script lang="coffee">$selected = -1
$rows = []
</script>
{for row in $rows}<div @class{row.id !== $selected}="ghost"></div>{end}`
    const { output } = await transpile(src, { moduleName: 'fd3' })
    // L'op !== couvre 999 rows → pas éligible filtered. Fallback : pas d'index.
    assert.doesNotMatch(output, /selected__ghost/)
  })

  it("REJETTE l'op < / > (plage de valeurs, indexation impossible)", async () => {
    const src = `<script lang="coffee">$threshold = 0
$rows = []
</script>
{for row in $rows}<div @class{row.id < $threshold}="below"></div>{end}`
    const { output } = await transpile(src, { moduleName: 'fd4' })
    assert.doesNotMatch(output, /threshold__below/)
  })

  it('REJETTE les expressions composées (&&, ||)', async () => {
    const src = `<script lang="coffee">$sel = -1
$flag = true
$rows = []
</script>
{for row in $rows}<div @class{row.id === $sel && $flag}="x"></div>{end}`
    const { output } = await transpile(src, { moduleName: 'fd5' })
    assert.doesNotMatch(output, /sel__x/)
  })

  it('REJETTE les negations (!(row.id === $sel))', async () => {
    const src = `<script lang="coffee">$sel = -1
$rows = []
</script>
{for row in $rows}<div @class{not (row.id === $sel)}="x"></div>{end}`
    const { output } = await transpile(src, { moduleName: 'fd6' })
    assert.doesNotMatch(output, /sel__x/)
  })

  it('NE pose PAS un index hors {for} (pattern au root level)', async () => {
    const src = `<script lang="coffee">$x = 0
$y = 0
</script>
<div @class{$x === $y}="active"></div>`
    const { output } = await transpile(src, { moduleName: 'fd7' })
    // Au root, pas de pattern filtered (pas de loopItem).
    assert.doesNotMatch(output, /_mjs_filt/)
  })

  it('détecte le pattern item-as-key (item entier, pas item.field)', async () => {
    // Pattern courant : `@class{$activeTab == tab}="is-active"`
    // où `tab` est l'item lui-même (string/objet entier). Map supporte les refs.
    const src = `<script lang="coffee">$activeTab = ""
$tabs = ["a", "b"]
</script>
{for tab in $tabs}<div @class{$activeTab === tab}="is-active"></div>{end}`
    const { output } = await transpile(src, { moduleName: 'fd8' })
    // Index inverse créé. Le className `is-active` est normalisé en `is_active` :
    // la clé du mémo reste lisible et comparable.
    assert.match(output, /\['activeTab__is_active__\w+'\]\s*\?\?=\s*\{ idx: null, prev: void 0 \}/)
    // La clé du Map est `tab` (sans .field). Le code généré doit utiliser
    // `const __k = tab;` (item direct), pas `tab.X`.
    assert.match(output, /const __k = tab;/)
  })
})

// ============================================================================
// Filtered Dispatch étendu : @style.X={ternaire} + data-X={bool}
//
// Étend Filtered Dispatch à 2 autres familles de bindings :
//   1) `@style.color={item.id === $sel ? 'red' : 'black'}` → filtered ternaire
//   2) `data-active={item.id === $sel}` → filtered bool (set/unset attr)
//
// Au mute de `$sel`, lookup direct des 2 fns concernées (old/new) au lieu
// de re-render N rows. Pareil gain massif que Filtered Dispatch (1000 → 2 effects).
// ============================================================================
describe('Filtered Dispatch étendu — @style.X / data-X', () => {
  it('détecte @style.color={item.id === $sel ? trueVal : falseVal} et émet _mjs_filt[*__style_*]', async () => {
    const src = `<script lang="coffee">$selected = -1
$rows = []
</script>
{for row in $rows}<div @style.color={row.id === $selected ? 'red' : 'black'}>{row.label}</div>{end}`
    const { output } = await transpile(src, { moduleName: 'fd_style1' })
    // L'index inverse doit être créé pour la prop `color`. Le filterKey est
    // `<extern>__style_<prop>` (avec `style_` en préfixe pour distinguer
    // des filtered @class).
    assert.match(output, /\['selected__style_color__\w+'\]\s*\?\?=\s*\{ idx: null, prev: void 0 \}/)
    // L'effet enregistré tire la fn enregistrée avec un booléen (match ou non).
    assert.match(output, /\.get\(prev\); if \(f\) f\(false\)/)
    assert.match(output, /\.get\(curr\); if \(f\) f\(true\)/)
    // Le set DOM appelle bien style.setProperty pour les 2 branches.
    assert.match(output, /style\.setProperty\('color', String\('red'\)\)/)
    assert.match(output, /style\.setProperty\('color', String\('black'\)\)/)
  })

  it("@style.color avec falseValue='' utilise removeProperty (sémantique correcte)", async () => {
    const src = `<script lang="coffee">$selected = -1
$rows = []
</script>
{for row in $rows}<div @style.color={row.id === $selected ? 'red' : ''}>{row.label}</div>{end}`
    const { output } = await transpile(src, { moduleName: 'fd_style2' })
    // Si la valeur fallback est '' → removeProperty (sinon setProperty('color', '')
    // est techniquement valide mais sémantiquement "vide", autant retirer).
    assert.match(output, /style\.setProperty\('color', String\('red'\)\)/)
    assert.match(output, /style\.removeProperty\('color'\)/)
  })

  it('détecte data-active={row.id === $sel} (bool simple) et émet _mjs_filt[*__attr_*]', async () => {
    const src = `<script lang="coffee">$selected = -1
$rows = []
</script>
{for row in $rows}<div data-active={row.id === $selected}>{row.label}</div>{end}`
    const { output } = await transpile(src, { moduleName: 'fd_attr1' })
    // Filterkey = `<extern>__attr_<name>` (avec `attr_` en préfixe).
    // Le `-` dans data-active est normalisé en `_` car les identifiers JS
    // ne supportent pas `-`.
    assert.match(output, /\['selected__attr_data_active__\w+'\]\s*\?\?=\s*\{ idx: null, prev: void 0 \}/)
    // setAttribute('data-active', 'true') / 'false' pour les 2 branches.
    assert.match(output, /setAttribute\('data-active', 'true'\)/)
    assert.match(output, /setAttribute\('data-active', 'false'\)/)
  })

  it('NE pose PAS de filtered dispatch hors {for}', async () => {
    const src = `<script lang="coffee">$x = 0
$y = 0
</script>
<div @style.color={$x === $y ? 'red' : 'black'}></div>`
    const { output } = await transpile(src, { moduleName: 'fd_style_root' })
    // Au root, pas de loopItem → pas de filtered.
    assert.doesNotMatch(output, /_mjs_filt/)
  })

  it("REJETTE les expressions composées (&&) dans @style.X={…}", async () => {
    const src = `<script lang="coffee">$sel = -1
$flag = true
$rows = []
</script>
{for row in $rows}<div @style.color={row.id === $sel && $flag ? 'red' : 'black'}>x</div>{end}`
    const { output } = await transpile(src, { moduleName: 'fd_style_compose' })
    assert.doesNotMatch(output, /sel__style_color/)
  })
})

// ============================================================================
// hint « spread dans une flèche fine » (bug Civet amont PROUVÉ hors MJS).
//
// `(x) -> { ...x, pinned: v }` (flèche FINE `->`, corps-objet 100% spread +
// une clé) émet côté Civet du JS invalide (`return ...x,({pinned: v})`) — le
// constructeur Analyzer (transpiler/index.ts) explose avec un message acorn
// brut, très en aval de la vraie cause. Même mécanique que le hint jumeau
// 'transpiler.hint-spread-else-civet' (motif `else {...x}`) : un hint est
// apposé SEULEMENT si le motif est présent dans script.raw, jamais de faux
// positif sur une autre cause de parse error ; les deux hints se cumulent.
// ============================================================================
describe('hint spread dans une flèche fine (-> { ...x, k: v })', () => {
  it("e2e : `@f = (x) -> { ...x, a: 1 }` (flèche fine, corps-objet spread + clé) → throw, message contient le hint AVEC les deux contournements", async function () {
    this.timeout(8000)
    const src = ['<script>', '@f = (x) -> { ...x, a: 1 }', '</script>', '<p>ok</p>'].join('\n')
    await assert.rejects(
      () => transpile(src, { moduleName: 'mjs-t95-thin-arrow', defaultScriptLang: 'civet' }),
      (e: any) => {
        assert.match(e.message, /flèche fine/, "AVANT le fix : erreur acorn brute, aucune piste vers la vraie cause")
        assert.match(e.message, /-> \(\{ \.\.\.x, k: v \}\)/, 'le hint doit montrer le contournement « parenthèses explicites »')
        assert.match(e.message, /=>/, 'le hint doit montrer le contournement « flèche grasse »')
        return true
      },
    )
  })

  it('contre-cas : même code avec une flèche grasse `=>` compile SANS erreur (non-régression)', async function () {
    this.timeout(8000)
    const src = ['<script>', '@f = (x) => { ...x, a: 1 }', '</script>', '<p>ok</p>'].join('\n')
    await assert.doesNotReject(() => transpile(src, { moduleName: 'mjs-t95-fat-arrow', defaultScriptLang: 'civet' }))
  })

  it("contre-cas : une erreur d'analyse SANS le motif flèche-fine (motif JUMEAU spread-else) n'affiche PAS ce hint (mais affiche le sien)", async function () {
    this.timeout(8000)
    const src = ['<script>', '$c = true', '$a = {p: 1}', '$b = {q: 2}', 'x = if $c then {...$a} else {...$b}', '</script>', '<p>ok</p>'].join('\n')
    await assert.rejects(
      () => transpile(src, { moduleName: 'mjs-t95-no-false-positive', defaultScriptLang: 'civet' }),
      (e: any) => {
        assert.doesNotMatch(e.message, /flèche fine/, "le motif flèche-fine n'est PAS dans cette source → pas de faux positif")
        assert.match(e.message, /if … then/, "le hint JUMEAU (spread-else), lui, doit toujours s'afficher — non-régression")
        return true
      },
    )
  })
})
