// MOTIF DE DESTRUCTURATION À INDEX CALCULÉ.
//
// Pass 4 d'`applyMjsSugarToScript` (auto-déclaration scope-aware) reconnaissait un motif de
// destructuration via une regex `[^={}[\]]*` qui refusait le moindre crochet INTERNE : `[arr[0],
// tmp] = …`, `[$$liste[k], tmp] = …`, `[[a, b], c] = …`, `{a: {b}} = o` ne matchaient PAS DU TOUT →
// `tmp`/`a`/`b`/`c` n'étaient jamais déclarés → `ReferenceError` au premier clic, alors que le build
// restait VERT (mesuré : zéro erreur de compilation, panne muette à l'exécution seulement). Remède :
// `scanPatternHead` (parcours équilibré) reconnaît le motif quel que soit son imbrication ;
// `rewriteIndexTargets` distingue un accès INDEXÉ (`racine[index]`, réécrit en `racine.__`, cible
// MEMBRE jamais déclarée) d'un motif IMBRIQUÉ (`[[a, b], c]`, laissé en place). Même occasion : un
// motif MIXTE déclaré/neuf (`[x, tmp] = [tmp, x]` avec `x` connu et `tmp` neuf) laissait `tmp` non
// déclaré — même remède, au nom près plutôt qu'au motif entier.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { transpile } from '../src/transpiler/index.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// Compile UN composant et le monte dans une fenêtre happy-dom — même mécanique que mount() de
// store-pattern-write.test.ts (repris tel quel).
async function mount(name: string, source: string) {
  const root   = mjsTmp('pattern-index-calcule')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))!
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))}`)

  document.body.insertAdjacentHTML('beforeend', `<mjs-${name}></mjs-${name}>`)
  const el = document.body.querySelector(`mjs-${name}`)
  await new Promise(r => setTimeout(r, 80))
  return { window, el }
}

describe('Pass 4 — destructuration à INDEX CALCULÉ (arr[k], $$liste[k], @items[i]), jamais oubliée', function () {
  it('un échange sur un tableau top-level via index littéral ([arr[0], tmp]) dans une fonction résout', async function () {
    const { output } = await transpile('<script>\n  arr = [1, 2]\n  swap = ->\n    [arr[0], tmp] = [tmp, arr[0]]\n</script>\n<button @click={swap()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let tmp = undefined/, 'tmp est hissé en tête de fonction')
    assert.doesNotMatch(output, /let \[arr/, 'jamais de déclaration sur un motif portant un accès indexé')
    assert.equal((output.match(/let arr\b/g) || []).length, 1, 'arr déclaré UNE seule fois (le top-level), jamais re-déclaré par le motif indexé')
  })

  it('un échange sur un store à index calculé ([$$liste[k], tmp]) dans une fonction résout, tmp hissé, k jamais déclaré, réécrit en _mjs_storeDeepSet', async function () {
    const { output } = await transpile('<script>\n  $$liste = [1, 2]\n  k = 0\n  swap = ->\n    [$$liste[k], tmp] = [tmp, $$liste[k]]\n</script>\n<button @click={swap()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let tmp = undefined/, 'tmp hissé')
    assert.doesNotMatch(output, /let \[/, 'jamais de déclaration sur ce motif (cible membre à index calculé)')
    assert.equal((output.match(/let k\b/g) || []).length, 1, 'k déclaré UNE seule fois (le top-level), jamais par l\'index')
    assert.match(output, /_mjs_storeDeepSet\("liste"/, 'la cible store à index calculé est réécrite par path-tracker.ts')
  })

  it('la même écriture posée DIRECTEMENT dans un handler ([$$liste[k], tmp] = …) ne déclare rien à tort', async function () {
    const { output } = await transpile('<script>\n  $$liste = [1, 2]\n  k = 0\n</script>\n<button @click={[$$liste[k], tmp] = [tmp, $$liste[k]]}>x</button>\n', { moduleName: 'card' })
    assert.doesNotMatch(output, /let \[µ\.store/, 'AVANT : `let [µ.store.liste…` — JS invalide, écouteur cassé au premier clic, muet au build')
    assert.doesNotMatch(output, /let \[/, 'aucune déclaration sur le motif entier')
    assert.match(output, /let tmp/, 'tmp présent (hissé) quelque part')
  })

  it('un échange sur un état ($items[i]) dans une fonction résout, tmp hissé', async function () {
    const { output } = await transpile('<script>\n  $items = [1, 2]\n  i = 0\n  swap = ->\n    [$items[i], tmp] = [tmp, $items[i]]\n</script>\n<button @click={swap()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let tmp/, 'tmp hissé')
    assert.doesNotMatch(output, /let \[/, 'aucune déclaration sur le motif')
  })

  it('un échange sur this (@items[i]) dans une fonction résout, tmp hissé', async function () {
    const { output } = await transpile('<script>\n  @items = [1, 2]\n  i = 0\n  swap = ->\n    [@items[i], tmp] = [tmp, @items[i]]\n</script>\n<button @click={swap()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let tmp/, 'tmp hissé')
    assert.doesNotMatch(output, /let \[/, 'aucune déclaration sur le motif')
  })

  it('le nom lu DANS un index n\'est jamais déclaré (une lecture, jamais une cible)', async function () {
    const { output } = await transpile('<script>\n  arr = [1, 2]\n  swap = ->\n    [arr[k], tmp] = [tmp, arr[k]]\n</script>\n<button @click={swap()}>x</button>\n', { moduleName: 'card' })
    assert.doesNotMatch(output, /let k\b/, 'k (jamais déclaré dans le source, volontaire) ne doit JAMAIS être déclaré par la Pass 4')
  })

  it('un motif imbriqué ([[a, b], c]) top-level reste déclaré normalement', async function () {
    const { output } = await transpile('<script>\n  [[a, b], c] = [[1, 2], 3]\n</script>\n<button>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let \[\[a, b\], c\] = \[\[1, 2\], 3\]/, 'motif imbriqué SANS index — non-régression du parcours équilibré')
  })

  it('un motif objet imbriqué ({a: {b}} = o) top-level reste déclaré normalement', async function () {
    const { output } = await transpile('<script>\n  o = { a: { b: 1 } }\n  {a: {b}} = o\n</script>\n<button>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let \{a: \{b\}\} = o/, 'motif objet imbriqué SANS index — non-régression')
  })

  it('un motif MIXTE déclaré/neuf ([x, tmp] = [tmp, x]) dans une fonction hisse le SEUL nom neuf', async function () {
    const { output } = await transpile('<script>\n  x = 1\n  f = ->\n    [x, tmp] = [tmp, x]\n</script>\n<button @click={f()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let tmp = undefined/, 'tmp (neuf) est hissé')
    assert.doesNotMatch(output, /let \[x/, 'x (déjà connu) ne doit jamais être re-déclaré par ce motif')
    assert.equal((output.match(/let x\b/g) || []).length, 1, 'x déclaré UNE seule fois (le top-level)')
  })

  it('non-régression — [x, y] = [1, 2] top-level (noms ordinaires) reste déclaré', async function () {
    const { output } = await transpile('<script>\n  [x, y] = [1, 2]\n  console.log(x, y)\n</script>\n<button>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let \[x, y\] = \[1, 2\]/)
  })

  it('non-régression — un swap ([x, y] = [y, x]) sur deux noms déjà déclarés reste nu', async function () {
    const { output } = await transpile('<script>\n  x = 1\n  y = 2\n  [x, y] = [y, x]\n  console.log(x, y)\n</script>\n<button>x</button>\n', { moduleName: 'card' })
    assert.match(output, /\[x, y\] = \[y, x\]/)
    assert.doesNotMatch(output, /let \[x, y\] = \[y, x\]/, 'x et y sont déjà déclarés — jamais de re-déclaration')
  })

  it('non-régression — une valeur par défaut dans le motif ([a = 1, b] = […]) reste hors périmètre', async function () {
    const { output } = await transpile('<script>\n  a = 0\n  b = 0\n  f = ->\n    [a = 1, b] = [0, 2]\n</script>\n<button @click={f()}>x</button>\n', { moduleName: 'card' })
    assert.doesNotMatch(output, /let \[a = 1/, 'exclusion volontaire, même périmètre minimal qu\'avant ce correctif')
  })
})

// Quatre régressions provoquées par le motif à index calculé sur ce
// MÊME motif de destructuration à crochets internes : (1) un commentaire bloc `###…###` (converti
// en `/* … */` par la Pass 1) n'était jamais suivi par `inertLines` → une affectation À L'INTÉRIEUR
// du commentaire était hissée comme du code réel ; (2) `...arr[0]` (rest sur une cible MEMBRE) :
// les trois points collés devant `arr` défaisaient le lookbehind de `dottedRe`/`memberRe`
// (`(?<![\w$§@.])` voit le dernier `.` de `...` comme si `arr` était déjà pointé) → motif promu en
// entier `.=`, Civet refuse (`let [first, ...arr[0]] = a` invalide) ; (3) une racine APPEL
// (`globalGetPair()[0]`) n'était ni membre ni pointée → extraite comme nom neuf, déclarée ou
// promue à tort ; (4) les PARAMÈTRES d'une fonction (`(tmp) ->`) n'étaient jamais enregistrés dans
// le scope qu'elle ouvre — trou préexistant, juste rendu visible par ce motif (`Identifier 'tmp'
// has already been declared`).
describe('Pass 4 — angles morts du motif à index calculé : commentaire bloc, rest sur membre, racine appel, paramètres', function () {
  it('commentaire bloc ###…### autour du motif : aucun hissage depuis le commentaire', async function () {
    const { output } = await transpile('<script>\n  ###\n  [arr[0], tmp] = x\n  ###\n  arr = [1, 2]\n</script>\n<button>x</button>\n', { moduleName: 'card' })
    assert.doesNotMatch(output, /\blet tmp\b/, 'tmp, entièrement dans le commentaire, ne doit jamais être hissé')
  })

  it('une affectation simple DANS un commentaire bloc n\'est ni hissée ni promue en `.=`', async function () {
    const { output } = await transpile('<script>\n  ###\n  x = 1\n  ###\n  y = 2\n</script>\n<button>x</button>\n', { moduleName: 'card' })
    assert.doesNotMatch(output, /\blet x\b/, 'x, entièrement dans le commentaire, ne doit jamais être déclaré')
    assert.match(output, /\blet y\b/, 'y, hors commentaire, reste déclaré normalement')
  })

  it('variante commentaire LIGNE (// […]) : idem, aucun hissage', async function () {
    const { output } = await transpile('<script>\n  // [arr[0], tmp] = x\n  arr = [1, 2]\n</script>\n<button>x</button>\n', { moduleName: 'card' })
    assert.doesNotMatch(output, /\blet tmp\b/, 'tmp, en commentaire ligne, ne doit jamais être déclaré')
  })

  it('non-régression : le motif RÉEL après un commentaire bloc reste traité (noms distincts, aucune interférence de scope)', async function () {
    const { output } = await transpile('<script>\n  ###\n  [arr[0], tmp] = x\n  ###\n  arr2 = [1, 2]\n  f = ->\n    [arr2[0], tmp2] = [tmp2, arr2[0]]\n</script>\n<button @click={f()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let tmp2 = undefined/, 'tmp2, motif réel hors commentaire, reste hissé normalement')
    assert.doesNotMatch(output, /\blet tmp\b/, 'tmp (uniquement dans le commentaire) n\'apparaît jamais')
  })

  it('rest sur un membre indexé ([first, ...arr[0]] = a) dans une fonction : first hissé seul, jamais de déclaration sur le motif entier', async function () {
    const { output } = await transpile('<script>\n  arr = [[1, 2], [3]]\n  a = [9, 8, 7]\n  f = ->\n    [first, ...arr[0]] = a\n</script>\n<button @click={f()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let first = undefined/, 'first hissé en tête de fonction')
    assert.doesNotMatch(output, /let \[/, 'jamais de déclaration sur le motif entier (arr[0] est une cible membre, pas une variable)')
  })

  it('[a, ...rest] = x dans une branche if (indent > corps) : rest hissé', async function () {
    const { output } = await transpile('<script>\n  x = [1, 2]\n  f = ->\n    if true\n      [a, ...rest] = x\n</script>\n<button @click={f()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let rest = undefined/, 'rest hissé en tête de fonction (branche if plus profonde que le corps)')
  })

  it('racine = appel de fonction ([globalGetPair()[0], t] = [1, 2]) : t hissé seul, globalGetPair jamais déclaré', async function () {
    const { output } = await transpile('<script>\n  f = ->\n    [globalGetPair()[0], t] = [1, 2]\n</script>\n<button @click={f()}>x</button>\n', { moduleName: 'card' })
    assert.doesNotMatch(output, /let globalGetPair\b/, 'globalGetPair est un appel, jamais une variable à déclarer')
    assert.match(output, /let t = undefined/, 't hissé en tête de fonction')
  })

  it('racine = appel, fonction connue au top-level ([f()[0], t] = [1, 2]) : idem, f jamais re-déclaré', async function () {
    const { output } = await transpile('<script>\n  f = -> [1, 2]\n  g = ->\n    [f()[0], t] = [1, 2]\n</script>\n<button @click={g()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let t = undefined/, 't hissé en tête de fonction')
    assert.equal((output.match(/let f\b/g) || []).length, 1, 'f déclaré UNE seule fois (le top-level), jamais re-déclaré par le motif')
  })

  it('paramètre de fonction ((tmp) ->) dans un motif de déstructuration : tmp n\'est jamais re-déclaré', async function () {
    const { output } = await transpile('<script>\n  arr = [1, 2]\n  f = (tmp) ->\n    [arr[0], tmp] = [3, 4]\n</script>\n<button @click={f(0)}>x</button>\n', { moduleName: 'card' })
    assert.doesNotMatch(output, /let tmp\b/, 'tmp est un paramètre de f, jamais une variable à déclarer/hisser dans son corps')
  })

  it('paramètre de fonction réassigné ((tmp) -> puis tmp = 5) : trou préexistant HEAD fermé, aucune re-déclaration', async function () {
    const { output } = await transpile('<script>\n  f = (tmp) ->\n    tmp = 5\n</script>\n<button @click={f(0)}>x</button>\n', { moduleName: 'card' })
    assert.doesNotMatch(output, /let tmp\b/, 'tmp est un paramètre de f — une réassignation nue reste nue, jamais promue en .=')
  })

  it('liste de paramètres complète (a, b = 1, {c, d}, ...rest) : tous les noms enregistrés, jamais re-déclarés', async function () {
    const { output } = await transpile('<script>\n  g = (a, b = 1, {c, d}, ...rest) ->\n    a = 1\n    c = 2\n    rest = []\n</script>\n<button @click={g(1, 2, {c: 3, d: 4}, 5, 6)}>x</button>\n', { moduleName: 'card' })
    assert.doesNotMatch(output, /let a\b/, 'a est un paramètre')
    assert.doesNotMatch(output, /let c\b/, 'c, issu du paramètre destructuré {c, d}, est déjà connu')
    assert.doesNotMatch(output, /let rest\b/, 'rest, paramètre rest, est déjà connu')
  })

  it('(@x) -> n\'enregistre PAS x comme paramètre (c\'est une propriété this, @x)', async function () {
    const { output } = await transpile('<script>\n  h = (@x) ->\n    x = 1\n</script>\n<button @click={h()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let x\b/, 'x, absent des paramètres réels (@x est une propriété), reste une variable neuve normalement déclarée')
  })

  it('non-régression : une fonction SANS paramètres ( -> ) continue de hisser normalement ses variables neuves', async function () {
    const { output } = await transpile('<script>\n  k = ->\n    y = 1\n</script>\n<button @click={k()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let y\b/, 'y reste déclaré normalement, aucun paramètre à interférer')
  })
})

// Les helpers PARAMÈTRES
// (`outermostParenSpans`/`splitTopLevelCommas`/`firstTopLevelEquals`/`extractParamNames`, plus
// `balancedSpan` qui leur trouve le groupe `(…)`) sautaient les chaînes mais IGNORAIENT les
// littéraux regex : une virgule/un `=`/une parenthèse ÉCHAPPÉE DANS un défaut `/…/` cassait le
// découpage (faux paramètre enregistré, panne MUETTE) ou faussait `depth` (panne
// BRUYANTE, « already been declared » — cf. cousin balancedSpan ci-dessous). Remède :
// même heuristique partagée `ouvreUneRegex`/`scanRegexLiteral` (src/sigils.ts) que
// `transformCodeOnly` plus haut, posée sur les trois scanners.
describe('Pass 4 — angles morts : littéraux regex dans les paramètres', function () {
  it('défaut regex avec virgules (re = /a,b,c/) : la virgule DANS le littéral n\'est pas un séparateur de paramètres, b reste hissé', async function () {
    const { output } = await transpile('<script>\n  f = (re = /a,b,c/) ->\n    b = 1\n    console.log(b)\n</script>\n<button @click={f()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let b = 1/, 'b, variable neuve du corps, reste déclarée — pas confondue avec un faux paramètre issu de la regex')
    assert.doesNotMatch(output, /let re\b/, 're est le seul VRAI paramètre')
  })

  it('défaut regex avec classe et virgule (re = /[,]/g) suivi d\'un vrai paramètre (c) : c reste un paramètre, d reste hissé', async function () {
    const { output } = await transpile('<script>\n  f = (re = /[,]/g, c) ->\n    c = 2\n    d = 3\n</script>\n<button @click={f(1, 2)}>x</button>\n', { moduleName: 'card' })
    assert.doesNotMatch(output, /let c\b/, 'c est un vrai paramètre de f')
    assert.match(output, /let d = 3/, 'd, variable neuve du corps, reste hissée')
  })

  it('non-régression : division dans les défauts (x = y / 2, z = w / 3), jamais confondue avec une regex — x et z restent des paramètres', async function () {
    const { output } = await transpile('<script>\n  f = (x = y / 2, z = w / 3) ->\n    q = 1\n    z = 4\n    x = 5\n</script>\n<button @click={f()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let q = 1/, 'q, variable neuve du corps, reste hissée')
    assert.doesNotMatch(output, /let z\b/, 'z est un vrai paramètre de f (défaut division, pas regex)')
    assert.doesNotMatch(output, /let x\b/, 'x est un vrai paramètre de f (défaut division, pas regex)')
  })

  it('chaîne contenant `/` et virgule + regex contenant un guillemet, virgule finale tolérée (s = \'a/b,c\', r = /\'/,) : s et r restent des paramètres, t reste hissé', async function () {
    const { output } = await transpile("<script>\n  f = (s = 'a/b,c', r = /'/,) ->\n    t = 1\n</script>\n<button @click={f()}>x</button>\n", { moduleName: 'card' })
    assert.doesNotMatch(output, /let s\b/, 's est un vrai paramètre (défaut chaîne)')
    assert.doesNotMatch(output, /let r\b/, 'r est un vrai paramètre (défaut regex contenant un guillemet)')
    assert.match(output, /let t = 1/, 't, variable neuve du corps, reste hissée')
  })

  it('cousin balancedSpan : parenthèse ÉCHAPPÉE dans un défaut regex (re = /\\(/) ne fausse plus le comptage, re reste un paramètre, z reste hissé', async function () {
    const { output } = await transpile('<script>\n  f = (re = /\\(/) ->\n    re = 1\n    z = 2\n</script>\n<button @click={f()}>x</button>\n', { moduleName: 'card' })
    assert.doesNotMatch(output, /let re\b/, 're est un vrai paramètre (défaut regex avec parenthèse échappée) — plus de « already been declared »')
    assert.match(output, /let z = 2/, 'z, variable neuve du corps, reste hissée')
  })

  it('non-régression scanPatternHead : division dans un index de motif ([arr[a / 2], t] = [1, 2]) reste une division, t seul hissé', async function () {
    const { output } = await transpile('<script>\n  arr = [1, 2, 3]\n  a = 2\n  f = ->\n    [arr[a / 2], t] = [1, 2]\n</script>\n<button @click={f()}>x</button>\n', { moduleName: 'card' })
    assert.match(output, /let t = undefined/, 't hissé en tête de fonction')
    assert.equal((output.match(/let arr\b/g) || []).length, 1, 'arr déclaré UNE seule fois (le top-level), jamais re-déclaré par le motif indexé')
    assert.equal((output.match(/let a\b/g) || []).length, 1, 'a (index de lecture) déclaré UNE seule fois (le top-level), jamais re-déclaré')
  })
})

describe('Pass 4 — index calculé, exécution bout-en-bout (composant compilé, happy-dom)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('[arr[0], tmp] = [5, arr[0]] : tmp reçoit bien l\'ANCIENNE valeur d\'arr[0]', async () => {
    const { el } = await mount('idxarr', [
      '<script>',
      'arr = [1, 2]',
      '$x = 0',
      'swap = ->',
      '  [arr[0], tmp] = [5, arr[0]]',
      '  $x = tmp',
      '</script>',
      '<button class="go" @click={swap()}>{$x}</button>',
    ].join('\n'))
    const txt = () => el._shadow.textContent.trim()
    assert.equal(txt(), '0', 'avant clic')

    el._shadow.querySelector('.go').click()
    await new Promise(r => setTimeout(r, 80))
    assert.equal(txt(), '1', 'après clic : tmp a reçu l\'ancien arr[0] (1)')
  })

  it('[$$liste[k], tmp] = [9, $$liste[k]] : store et tmp corrects après l\'échange', async () => {
    const { el } = await mount('idxstore', [
      '<script>',
      '$$liste = [1, 2]',
      'k = 0',
      '$x = 0',
      'swap = ->',
      '  [$$liste[k], tmp] = [9, $$liste[k]]',
      '  $x = tmp',
      '</script>',
      '<button class="go" @click={swap()}>{$$liste[0]}-{$x}</button>',
    ].join('\n'))
    const txt = () => el._shadow.textContent.trim()
    assert.equal(txt(), '1-0', 'avant clic')

    el._shadow.querySelector('.go').click()
    await new Promise(r => setTimeout(r, 80))
    assert.equal(txt(), '9-1', 'après clic : $$liste[0] vaut 9, tmp a reçu l\'ancien $$liste[0] (1)')
  })
})

describe('Pass 4 — angles morts du motif à index calculé, exécution bout-en-bout', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('[first, ...arr[0]] = a exécuté : first reçoit le premier élément de a, $x affiche 0 puis 1', async () => {
    const { el } = await mount('idxrest', [
      '<script>',
      'arr = [0]',
      'a = [1, 2, 3]',
      '$x = 0',
      'f = ->',
      '  [first, ...arr[0]] = a',
      '  $x = first',
      '</script>',
      '<button class="go" @click={f()}>{$x}</button>',
    ].join('\n'))
    const txt = () => el._shadow.textContent.trim()
    assert.equal(txt(), '0', 'avant clic')

    el._shadow.querySelector('.go').click()
    await new Promise(r => setTimeout(r, 80))
    assert.equal(txt(), '1', 'après clic : first a reçu le premier élément de a (1)')
  })

  it('f = (tmp) -> [arr[0], tmp] = [3, 4] exécuté : tmp (paramètre) reçoit 4, $x affiche 0 puis 4', async () => {
    const { el } = await mount('idxparam', [
      '<script>',
      'arr = [1, 2]',
      '$x = 0',
      'f = (tmp) ->',
      '  [arr[0], tmp] = [3, 4]',
      '  $x = tmp',
      '</script>',
      '<button class="go" @click={f(0)}>{$x}</button>',
    ].join('\n'))
    const txt = () => el._shadow.textContent.trim()
    assert.equal(txt(), '0', 'avant clic')

    el._shadow.querySelector('.go').click()
    await new Promise(r => setTimeout(r, 80))
    assert.equal(txt(), '4', 'après clic : tmp (paramètre) a reçu 4')
  })
})
