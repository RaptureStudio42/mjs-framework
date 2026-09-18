// Test de régression — `<@slot X/>` compile en `<slot name="X">` (sans
// préfixe interne `mjs-slot-`). Avant le fix : le shadow déclarait
// `<slot name="mjs-slot-title">` mais l'utilisateur écrit `<h2 slot="title">`
// → mismatch → contenu invisible. Le runtime `_mjs_injectSlots` ajoutait
// `slot="mjs-slot-N"` aux enfants sans attribut → ils ratent aussi le
// `<slot>` par défaut du shadow.
//
// Fix : alignement sur l'idiome natif Web Components.
//   - `<@slot X/>` → `<slot name="X">` (sans préfixe).
//   - `_mjs_injectSlots` devient no-op : le browser route nativement les nœuds
//     sans `slot=` vers le `<slot>` par défaut.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transpile } from '../src/transpiler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('compile — `<@slot X/>` → `<slot name="X">` (sans préfixe `mjs-slot-`)', function () {
  this.timeout(20000)

  it('slot nommé littéral : `<@slot title/>` → `name="title"`', async function () {
    const r = await transpile(`<article><header><@slot title/></header></article>`, { moduleName: 'card' })
    assert.match(r.output, /<slot name=['"]title['"]/, "slot nommé 'title' attendu (sans préfixe)")
    assert.doesNotMatch(r.output, /mjs-slot-title/, "préfixe `mjs-slot-` ne doit plus apparaître")
  })

  it('slot par défaut : `<@slot/>` → `<slot>` sans attribut name', async function () {
    const r = await transpile(`<article><div><@slot/></div></article>`, { moduleName: 'card2' })
    assert.match(r.output, /<slot><\/slot>|<slot ?\/>/, "slot par défaut (sans name) attendu")
  })

  it('slot dynamique `<@slot {i}/>` dans `{for}` → nom évalué (pas littéral)', async function () {
    const r = await transpile(`<div>{for i, t in $items}<@slot {i}/>{end}</div>`, { moduleName: 'card3' })
    assert.doesNotMatch(r.output, /mjs-slot-/, 'préfixe `mjs-slot-` ne doit plus apparaître')
    // Les accolades → expression évaluée : le nom du slot ne doit PAS être la
    // chaîne littérale "i" (sinon tous les tours auraient le même nom).
    assert.doesNotMatch(r.output, /name=['"]i['"]/, "`<@slot {i}>` ne doit pas produire le nom littéral \"i\"")
  })

  it('`<@slot i/>` SANS accolades → nom littéral "i", même dans un `{for}` avec var `i`', async function () {
    const r = await transpile(`<div>{for i, t in $items}<@slot i/>{end}</div>`, { moduleName: 'card4' })
    // Nouveau contrat : un identifiant nu est TOUJOURS littéral. Le scope de
    // boucle n'influe plus. Permet d'avoir un slot littéral nommé "i".
    assert.match(r.output, /<slot name=['"]i['"]/, "`<@slot i>` doit produire le nom LITTÉRAL \"i\" (plus de magie de scope)")
  })
})

// `_mjs_injectSlots` (mjs_slots.ts) n'a de travail QUE si le composant écrit `<@slot` : le générateur
// n'émet l'appel (et le drapeau `_mjs_has_dynamic_slots = true`) que dans ce cas — c'est ce même
// appel littéral que la détection du cœur cherche dans le code compilé.
describe('compile — `_mjs_injectSlots` émis seulement quand le composant écrit `<@slot`', function () {
  this.timeout(20000)

  it('sans `<@slot` (y compris un `<slot>` natif écrit à la main) : ni appel, ni drapeau', async function () {
    for (const src of ['<p>x</p>', '<div><slot></slot></div>']) {
      const r = await transpile(src, { moduleName: 'noslot' })
      assert.doesNotMatch(r.output, /_mjs_injectSlots/, src)
      assert.doesNotMatch(r.output, /_mjs_has_dynamic_slots/, src)
    }
  })

  it('avec `<@slot` (défaut, nommé, indexé dans un {for}, apporté par un partiel <@include>) : drapeau vrai puis appel', async function () {
    const dir = mjsTmp('slot-include')
    writeFileSync(join(dir, '_fente.mjs'), '<div><@slot/></div>\n')
    const formes = [
      '<div><@slot/></div>',
      '<header><@slot titre/></header>',
      '<script>\n$items = [1, 2]\n</script>\n<div>{for i, t in $items}<@slot {i}/>{end}</div>',
      '<@include fente>'
    ]
    for (const src of formes) {
      const r = await transpile(src, { moduleName: 'withslot', baseDir: dir })
      assert.match(r.output, /this\._mjs_has_dynamic_slots = true;\n\s*this\._mjs_injectSlots\(\);/, src)
    }
  })
})

describe('runtime — _mjs_injectSlots est no-op (laisse le browser router nativement)', function () {
  it('_mjs_injectSlots distingue les 2 régimes : default slot vs slots indexés', function () {
    const src = readFileSync(join(here, '..', 'src', 'runtime', 'mjs_slots.ts'), 'utf-8')
    // Localise le body de la méthode `_mjs_injectSlots` (patch de µ.Element.prototype).
    const match = src.match(/_mjs_injectSlots = function\(\)\s*\{([\s\S]*?)\n {2}\};/)
    assert.ok(match, "méthode _mjs_injectSlots trouvée")
    // Strip comments pour ne vérifier que le code exécutable.
    const codeOnly = match![1]
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    // 1. Plus aucun préfixe `mjs-slot-` injecté côté light.
    assert.doesNotMatch(codeOnly, /mjs-slot-/,
      "le code exécutable ne doit plus contenir le préfixe `mjs-slot-`")
    // 2. Détection du `<slot>` par défaut : si présent, on ne touche pas
    //    aux enfants (sinon les nœuds sans `slot=` ratent le slot default).
    assert.match(codeOnly, /querySelector\(['"]slot:not\(\[name\]\)['"]\)/,
      "doit détecter la présence d'un `<slot>` par défaut dans le shadow")
    // 3. L'auto-index reste pour le cas `<@slot i/>` dans un `{for}`
    //    (slots `<slot name="0">`, `<slot name="1">`…).
    assert.match(codeOnly, /setAttribute\(['"]slot['"]\s*,\s*String\(\s*childIndex\s*\)\s*\)/,
      "doit poser `slot=\"N\"` (String(childIndex)) côté light quand pas de slot default")
  })
})
