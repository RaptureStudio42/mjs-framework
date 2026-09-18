// Tests CSS / Sass compilation.

import assert from 'node:assert/strict'
import { compileCss } from '../src/transpiler/css.js'
import { transpile } from '../src/transpiler/index.js'

describe('compileCss', () => {
  it('CSS passthrough avec compaction whitespace', () => {
    const out = compileCss('p   {  color:  red;  }', 'css')
    assert.equal(out, 'p { color: red; }')
  })

  it('accent dans la feuille : aucune marque d\'ordre d\'octets, la 1re règle survit', () => {
    // sass pose U+FEFF en tête dès qu'un caractère non-ASCII apparaît ; le navigateur lit
    // alors la marque comme un sélecteur et JETTE la première règle (ici :host, cf. <@color>)
    const src = `:host { --taille: 16px; }\n.libelle::after { content: 'déjà →'; }`
    const out = compileCss(src, 'scss')
    assert.equal(out.includes('\uFEFF'), false, 'le CSS produit ne doit contenir aucun U+FEFF')
    assert.equal(out.indexOf(':host'), 0, 'la première règle doit rester en tête, intacte')
    assert.match(out, /--taille:\s*16px/)
  })

  it('SCSS imbriqué compile en CSS plat', () => {
    const src = `.outer { .inner { color: blue; } }`
    const out = compileCss(src, 'scss')
    assert.match(out, /\.outer \.inner/)
    assert.match(out, /color:\s*blue/)
  })

  it('Sass indenté compile en CSS', () => {
    const src = `.box\n  color: red\n  &:hover\n    color: blue`
    const out = compileCss(src, 'sass')
    assert.match(out, /\.box/)
    assert.match(out, /\.box:hover/)
  })

  it('blank source → vide', () => {
    assert.equal(compileCss('', 'css'), '')
    assert.equal(compileCss('   \n\t  ', 'sass'), '')
  })

  // Régression — motif
  // récurrent (« erreur avalée → build vert ») : AVANT ce
  // fix, une erreur SASS/SCSS était catchée ICI et transformée en simple
  // `console.error` + CSS VIDE retourné — le composant compilait avec
  // SUCCÈS (aucune entrée dans stats.errors) mais rendait SANS AUCUN STYLE
  // en prod, découvert seulement en regardant la page. `compileCss` ne
  // catch plus : l'erreur SASS remonte telle quelle (les call sites ont
  // déjà l'infra pour la capturer proprement dans stats.errors).
  it('Sass invalide → throw (AVANT le fix : string vide + erreur avalée, build vert)', () => {
    assert.throws(() => compileCss('this is not valid {', 'scss'),
      "AVANT le fix : une erreur de syntaxe SASS/SCSS était catchée et transformée en CSS vide + console.error — le composant compilait SANS AUCUNE erreur reportée mais rendait sans style, silencieusement")
  })
})

// régression — compileCssBlock (lang css, sans le paquet sass) compactait les blancs
// avec /\s+/g SUR TOUTE LA SOURCE, y compris À L'INTÉRIEUR des chaînes : content: "a   b" devenait
// "a b", [data-tag="hello   world"] ne matchait plus jamais l'élément. sass/scss délèguent au
// paquet sass et ne sont pas concernés.
describe('compactCss — les chaînes du CSS pur sont intactes', () => {
  it('content avec espaces multiples : la chaîne survit à la compaction', () => {
    const out = compileCss('p::before {  content:  "a   b";  }', 'css')
    assert.equal(out, 'p::before { content: "a   b"; }')
  })

  it('sélecteur d\'attribut avec espaces multiples : le sélecteur reste matchable', () => {
    const out = compileCss('[data-tag="hello   world"]   { color: red; }', 'css')
    assert.equal(out, '[data-tag="hello   world"] { color: red; }')
  })

  it('guillemets simples : la chaîne reste intacte', () => {
    const out = compileCss("p { content: 'x  y'; }", 'css')
    assert.equal(out, "p { content: 'x  y'; }")
  })

  it('guillemet échappé dans la chaîne : les espaces après survivent', () => {
    const out = compileCss('p { content: "a\\"  b"; }', 'css')
    assert.equal(out, 'p { content: "a\\"  b"; }')
  })

  it('chaîne jamais refermée : ne lève pas, la sortie garde le fragment', () => {
    let out = ''
    assert.doesNotThrow(() => { out = compileCss('p { content: "abc', 'css') })
    assert.ok(out.includes('"abc'))
  })

  it('témoin sass : non concerné, la chaîne reste intacte', () => {
    const out = compileCss('p\n  content: "a   b"', 'sass')
    assert.ok(out.includes('"a   b"'))
  })

  it('commentaire avec apostrophe : la compaction fonctionne après le commentaire', () => {
    const out = compileCss("/* it's */ p   {  color:  red;  }", 'css')
    assert.equal(out, "/* it's */ p { color: red; }")
  })

  it('commentaire avec apostrophe suivi d\'une chaîne : la chaîne garde sa protection', () => {
    const out = compileCss("/* it's */ p { content: 'a   b'; }", 'css')
    assert.equal(out, "/* it's */ p { content: 'a   b'; }")
  })

  it('commentaire avec guillemet double et accolade : reste inerte, la compaction continue après', () => {
    const out = compileCss('/* "x" } */ p   {  }', 'css')
    assert.equal(out, '/* "x" } */ p { }')
  })

  it('commentaire jamais refermé : ne lève pas, la sortie garde le fragment', () => {
    let out = ''
    assert.doesNotThrow(() => { out = compileCss('/* abc', 'css') })
    assert.ok(out.includes('/* abc'))
  })

  it('un /* dans une chaîne n\'ouvre pas de commentaire', () => {
    const out = compileCss('p { content: "/*";  color:  red; }', 'css')
    assert.equal(out, 'p { content: "/*"; color: red; }')
  })
})

describe('transpile() + Sass integration', () => {
  it('compile <style lang="scss"> et l\'inclut dans baseCss', async () => {
    const src = `<script lang="coffee">$x = 0</script>
<style lang="scss">
.outer { .inner { color: red; } }
</style>
<p>{$x}</p>`
    const { data, output } = await transpile(src, { moduleName: 'foo' })
    assert.match(data.baseCss, /\.outer \.inner/)
    assert.match(output, /\.outer \.inner/)
  })

  it('<style lang="css"> garde le CSS littéral compacté', async () => {
    const src = `<script lang="coffee">$x = 0</script>
<style lang="css">
  p { color: red; }
</style>
<p>{$x}</p>`
    const { data } = await transpile(src, { moduleName: 'foo' })
    assert.ok(data.baseCss.includes('color') && data.baseCss.includes('red'))
  })

  it('<style> sans lang= utilise Sass indenté (défaut V1)', async () => {
    const src = `<script lang="coffee">$x = 0</script>
<style>
.box
  color: red
</style>
<p>{$x}</p>`
    const { data } = await transpile(src, { moduleName: 'foo' })
    assert.match(data.baseCss, /\.box/)
    assert.match(data.baseCss, /color:\s*red/)
  })
})
