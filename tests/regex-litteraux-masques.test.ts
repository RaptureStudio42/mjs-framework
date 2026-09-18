// littéraux regex masqués aux deux moteurs de sucre : `x = /§/` (§ n'est qu'un CARACTÈRE de la regex) levait
// la garde « § nu » (transpiler.symbole-reserve-nu), et plus grave, un sucre pouvait RÉÉCRIRE
// l'INTÉRIEUR d'une regex (`re = /µTotal/` → `re = /µ.Total/`, corruption silencieuse).
//
// Le PARSER (src/parser/index.ts, Scanner.avaleRegex/extractBalanced) sait déjà reconnaître un
// littéral regex — le lexer (tokenize, scripts) et le générateur (cleanJs/cleanJsExpr,
// interpolations/handlers) l'ignoraient. Une seule heuristique pour tout le compilateur
// (ouvreUneRegex/scanRegexLiteral, sigils.ts), consommée par les trois moteurs.

import { strict as assert } from 'node:assert'
import { tokenize } from '../src/lexer/index.ts'
import { cleanJs } from '../src/generator/utils.ts'
import { transpile } from '../src/transpiler/index.js'

describe('littéraux regex — zone inerte pour les deux moteurs de sucre', function () {
  describe('lexer (tokenize) — <script>', function () {
    it('x = /§/ : § protégé, plus de garde « § nu »', () =>
      assert.equal(tokenize('x = /§/'), 'x = /§/'))

    it('re = /µread/ : µread protégé, plus de garde « forme de rune »', () =>
      assert.equal(tokenize('re = /µread/'), 're = /µread/'))

    it('re = /µTotal/ : µTotal INTACT, plus réécrit en µ.Total', () =>
      assert.equal(tokenize('re = /µTotal/'), 're = /µTotal/'))

    it('re = /§theme/ : intact', () =>
      assert.equal(tokenize('re = /§theme/'), 're = /§theme/'))

    it('re = /\\$total/ : intact', () =>
      assert.equal(tokenize('re = /\\$total/'), 're = /\\$total/'))

    it("re = /[$§µ]/ : classe de caractères intacte", () =>
      assert.equal(tokenize('re = /[$§µ]/'), 're = /[$§µ]/'))

    it('re = /§/gi : drapeaux préservés', () =>
      assert.equal(tokenize('re = /§/gi'), 're = /§/gi'))

    it('re = /a\\/§/ : slash échappé, ne referme pas prématurément', () =>
      assert.equal(tokenize('re = /a\\/§/'), 're = /a\\/§/'))

    it("s = /'/.test($t) ? 'a' : 'b' : regex portant un guillemet, code après sucré normalement", () =>
      assert.equal(tokenize("s = /'/.test($t) ? 'a' : 'b'"), "s = /'/.test($.t) ? 'a' : 'b'"))
  })

  describe('générateur (cleanJs) — interpolations/handlers', function () {
    it('x = /§/ : § protégé', () =>
      assert.equal(cleanJs('x = /§/'), 'x = /§/'))

    it('re = /µTotal/ : intact', () =>
      assert.equal(cleanJs('re = /µTotal/'), 're = /µTotal/'))

    it('re = /§theme/ : intact', () =>
      assert.equal(cleanJs('re = /§theme/'), 're = /§theme/'))

    it('re = /\\$total/ : intact', () =>
      assert.equal(cleanJs('re = /\\$total/'), 're = /\\$total/'))

    it('re = /[$§µ]/ : classe de caractères intacte', () =>
      assert.equal(cleanJs('re = /[$§µ]/'), 're = /[$§µ]/'))
  })

  describe('pipeline complet (transpile) — script, handler, interpolation, script module', function () {
    it('<script> x = /§/ : compile', async () => {
      const src = '<script>\n  x = /§/\n</script>\n<p>x</p>\n'
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    it('<script> re = /µread/ : compile', async () => {
      const src = '<script>\n  re = /µread/\n</script>\n<p>x</p>\n'
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    // Trou comblé : `applyMjsSugarToScript`
    // (src/transpiler/index.ts, transformCodeOnly) importe désormais
    // `ouvreUneRegex`/`scanRegexLiteral` (sigils.ts) et rend le littéral regex
    // inerte, même branche que generator/utils.ts::mapCodeSegments. `µTotal`
    // n'est plus réécrit `µ.Total`.
    it('<script> re = /µTotal/ : compile, µTotal INTACT dans le JS émis', async () => {
      const src = '<script>\n  re = /µTotal/\n</script>\n<p>x</p>\n'
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /\/µTotal\//)
    })

    it('<script module> re = /§theme/ : intact', async () => {
      const src = '<script module>\n  re = /§theme/\n</script>\n<script>\n  x = 1\n</script>\n<p>x</p>\n'
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
      assert.match(output, /\/§theme\//)
    })

    it("<script> s = /'/.test($t) ? 'a' : 'b' : $t sucré, regex intacte", async () => {
      const src = "<script>\n  $t = 'a'\n  s = /'/.test($t) ? 'a' : 'b'\n</script>\n<p>{s}</p>\n"
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /\/'\/\.test\(\$\.t\)/)
    })

    it('<script> x = $a / 2 / $b : deux divisions, $a/$b réécrits', async () => {
      const src = '<script>\n  $a = 4\n  $b = 2\n  x = $a / 2 / $b\n</script>\n<p>{x}</p>\n'
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /\$\.a \/ 2 \/ \$\.b/)
    })

    it('handler @click={m = /µTotal/.test($t)} : intact (moteur cleanJs, déjà vert : témoin)', async () => {
      const src = "<script>\n  $t = 'a'\n</script>\n<button @click={m = /µTotal/.test($t)}>x</button>\n"
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /\/µTotal\//)
    })

    it('handler @click={m = /§/.test($t)} : compile', async () => {
      const src = "<script>\n  $t = 'a'\n</script>\n<button @click={m = /§/.test($t)}>x</button>\n"
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    it("interpolation { /§/.test($t) ? 'oui' : 'non' } : compile", async () => {
      const src = "<script>\n  $t = 'a'\n</script>\n<p>{ /§/.test($t) ? 'oui' : 'non' }</p>\n"
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    it('<script module> x = /§/ : compile (§, pas µXxx — hors du trou applyMjsSugarToScript)', async () => {
      const src = '<script module>\n  x = /§/\n</script>\n<script>\n  y = 1\n</script>\n<p>x</p>\n'
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    // Même remède que le <script> juste au-dessus : <script
    // module> passe par le MÊME transformCodeOnly, désormais protégé aussi.
    it('<script module> re = /µTotal/ : compile, intact', async () => {
      const src = '<script module>\n  re = /µTotal/\n</script>\n<script>\n  x = 1\n</script>\n<p>x</p>\n'
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
      assert.match(output, /\/µTotal\//)
    })
  })

  describe('divisions — jamais prises pour des regex', function () {
    it('x = a / b / c : deux divisions, identifiants intacts', () =>
      assert.equal(tokenize('x = a / b / c'), 'x = a / b / c'))

    it('x = $a / 2 : $a réécrit $.a, division intacte', () =>
      assert.equal(tokenize('x = $a / 2'), 'x = $.a / 2'))

    it('x = (a) / b : parenthèse fermante → division', () =>
      assert.equal(tokenize('x = (a) / b'), 'x = (a) / b'))

    it('x = arr[0] / 2 : crochet fermant → division', () =>
      assert.equal(tokenize('x = arr[0] / 2'), 'x = arr[0] / 2'))

    it('x = 10 / $n / 3 : $n réécrit $.n, aucune garde ne lève', () =>
      assert.equal(tokenize('x = 10 / $n / 3'), 'x = 10 / $.n / 3'))

    // Cas AMBIGU (vrai en JS aussi, pas seulement dans ce compilateur) : `a` (identifiant) précède
    // le 1er `/`, l'heuristique tranche donc DIVISION — `§` retombe alors NU (non protégé par une
    // regex) et la garde « § nu » lève, exactement comme un `§` nu ailleurs. On ne juge pas ce
    // choix (ne tranche pas laquelle des deux lectures — division puis § nu, ou regex jamais
    // refermée — serait « la bonne ») : on CONSIGNE le comportement mesuré.
    it('x = a /§/ b : heuristique ambiguë — mesuré : 1er / lu comme DIVISION (a précède), § retombe nu, garde levée', () => {
      assert.throws(() => tokenize('x = a /§/ b'), /symbole du framework/)
    })
  })

  describe('aucune régression des gardes existantes', function () {
    it('x = § nu : toujours refusé (lexer)', () =>
      assert.throws(() => tokenize('x = §'), /symbole du framework/))

    it('x = § nu : toujours refusé (cleanJs)', () =>
      assert.throws(() => cleanJs('x = §'), /symbole du framework/))

    it('f = µread nu : toujours refusé (lexer)', () =>
      assert.throws(() => tokenize('f = µread'), /µread\/µwrite vise un symbole/))

    it('f = µread nu : toujours refusé (cleanJs)', () =>
      assert.throws(() => cleanJs('f = µread'), /µread\/µwrite vise un symbole/))

    it('const { µread } = obj : toujours refusé (lexer)', () =>
      assert.throws(() => tokenize('const { µread } = obj'), /µread\/µwrite vise un symbole/))
  })
})

describe('regex littérales — une balise fermante `</…` n\'est jamais une regex', function () {
  it('composant sur UNE ligne : `</script><p>…</p>` reste du HTML, l\'extraction des sections tient', async function () {
    const { output } = await transpile(`<script>$t = 'x'</script><p>{ /§/.test($t) ? 'a' : 'b' }</p>`, { moduleName: 'rx-close-tag' })
    assert.match(output, /\/§\/\.test\(\$\.t\)/, 'la regex est intacte et $t est sucré')
  })

  it('`</p><span>1/2</span>` sur une ligne : ni la balise ni la division ne sont prises pour une regex', async function () {
    const { output } = await transpile(`<script>$a = 4</script><p>{$a}</p><span>1/2</span>`, { moduleName: 'rx-close-tag-2' })
    assert.match(output, /1\/2/)
  })
})

describe('regex littérales — un symbole suivi d\'un mot-clé est un NOM, le `/` qui suit divise', function () {
  it('cleanJs : `@new / $total / 2` — $total reste sucré', function () {
    assert.match(cleanJs('pct = @new / $total / 2'), /\$\.total/)
  })

  it('cleanJs : `§in / $y / 3` et `&of / $z / 2` — $y et $z sucrés', function () {
    assert.match(cleanJs('a = §in / $y / 3'), /\$\.y/)
    assert.match(cleanJs('b = &of / $z / 2'), /\$\.z/)
  })

  it('bout en bout : interpolation `{ @new / $total / 2 }` — $.total dans le code émis', async function () {
    const { output } = await transpile(`<script>\n  $total = 200\n  @new = 4\n</script>\n<p>{ @new / $total / 2 }</p>\n`, { moduleName: 'rx-mot-cle' })
    assert.match(output, /\$\.total/)
    assert.doesNotMatch(output, /[^.$]\$total\b/)
  })
})
