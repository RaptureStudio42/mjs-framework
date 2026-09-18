// Suivi des dépendances (compilateur), le point le plus délicat :
// `getEffectVars` perd en silence toute forme Civet que son moteur regex ne
// connaît pas — appel implicite (`f $x`), tube `|>`, `unless` postfixé, 2e argument TABLEAU
// d'un `µt` sans parenthèses (deux pipelines
// désynchronisés, l'un regex pour les dépendances, l'autre vrai Civet pour le code émis).
// Deux points annexes : `$__proto__`/`$constructor` font planter l'analyseur
// EN SILENCE ; `autoDeclareFromTemplate` auto-déclare un `$xxx` mentionné
// dans un commentaire HTML.
//
// Perf — mesuré (200 expressions simples, 20 répétitions, `CompilerState` isolé,
// analyzer: null) : AVANT le repli ajouté ici (tokenize+cleanJs+replace seuls) ≈ 13 µs/appel ;
// APRÈS (`getEffectVars` complet, repli inclus) ≈ 23 µs/appel — le SURCOÛT (~10 µs/appel) est
// le self-check (`analyzeSnippetOrNull` sur le candidat déjà valide) qui décide s'il faut
// retenter ; la compilation Civet elle-même (coûteuse) ne tourne QUE sur échec confirmé,
// jamais sur le chemin déjà vert.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { transpile } from '../src/transpiler/index.js'
import { compile } from '../src/generator/index.js'
import { CompilerState } from '../src/generator/state.js'
import { Analyzer } from '../src/analyzer/index.js'
import { mjsTmp } from './helpers/tmp.js'
import { i18nBootLines } from './helpers/i18n-eval.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// montage — copie de tests/state-collection-reactivity.test.ts:16-40 (shadow CLOS via
// `el._shadow`, attendre 60-80 ms, n'assertionner QUE des chaînes/nombres/booléens).
async function mount(name: string, source: string) {
  const root   = mjsTmp(`revue1c-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { el }
}

// même moule + catalogue i18n RACINE (modèle tests/mu-t-bare-call-reactivity.test.ts) :
// nécessaire pour que `µt` résolve réellement une clé (sinon `µ._i18nData` absent, repli
// inerte, aucune preuve de réactivité possible).
async function mountI18n(name: string, source: string, frYml: string[]) {
  const root   = mjsTmp(`revue1c-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(join(srcDir, 'i18n'), { recursive: true })
  writeFileSync(join(srcDir, 'i18n', 'fr.yml'), frYml.join('\n'))
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const manifestPath = join(root, 'bundle.js')
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath, i18n: { default: 'fr' } })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const i18nDataStmt = i18nBootLines(manifestPath, outDir)
  assert.ok(i18nDataStmt, 'µ._i18nData doit être émis dans le manifeste')

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${i18nDataStmt}\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { el }
}

function clickBouton(el: any): void {
  const btn = el._shadow.querySelector('button')
  btn.dispatchEvent(new (el.ownerDocument.defaultView.Event)('click', { bubbles: true }))
}

describe('suivi des dépendances (compilateur)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  // ==========================================================================
  // Repli Civet du suivi de dépendances
  // ==========================================================================
  describe('repli Civet de getEffectVars (montage réel)', () => {
    it('appel Civet implicite `{fmt $x}` redevient réactif après un clic', async () => {
      const src = [
        '<script>', '$x = 1', 'fmt = (v) -> "v=" + v', '</script>',
        '<p class="out">{fmt $x}</p>',
        '<button @click={$x = 2}>go</button>',
      ].join('\n')
      const { el } = await mount('c1implicit', src)
      const out = () => el._shadow.querySelector('.out').textContent
      assert.equal(out(), 'v=1', 'rendu initial')
      clickBouton(el)
      await new Promise(r => setTimeout(r, 80))
      assert.equal(out(), 'v=2', 'AVANT le correctif : figé sur "v=1" (dépendance x perdue, effet classé mountOnly à tort)')
    })

    it('tube Civet `{$x |> double}` redevient réactif après un clic', async () => {
      const src = [
        '<script>', '$x = 1', 'double = (v) -> v * 2', '</script>',
        '<p class="out">{$x |> double}</p>',
        '<button @click={$x = 5}>go</button>',
      ].join('\n')
      const { el } = await mount('c1pipe', src)
      const out = () => el._shadow.querySelector('.out').textContent
      assert.equal(out(), '2', 'rendu initial')
      clickBouton(el)
      await new Promise(r => setTimeout(r, 80))
      assert.equal(out(), '10', 'AVANT le correctif : figé sur "2"')
    })

    it('`unless` postfixé `{"zero" unless $x}` redevient réactif après un clic', async () => {
      const src = [
        '<script>', '$x = 0', '</script>',
        '<p class="out">{"zero" unless $x}</p>',
        '<button @click={$x = 1}>go</button>',
      ].join('\n')
      const { el } = await mount('c1unless', src)
      const out = () => el._shadow.querySelector('.out').textContent.trim()
      assert.equal(out(), 'zero', 'rendu initial')
      clickBouton(el)
      await new Promise(r => setTimeout(r, 80))
      assert.equal(out(), '', 'AVANT le correctif : figé sur "zero"')
    })

    it("`{µt 'clé', [$x, 2]}` — 2e argument TABLEAU redevient réactif après un clic", async () => {
      // placeholders POSITIONNELS `%{0}`/`%{1}` : `µ.t` (mjs_i18n.ts) résout
      // `%{name}` via `Object.prototype.hasOwnProperty.call(vars, name)` — un
      // TABLEAU a des clés own '0'/'1', donc `%{0}`/`%{1}` fonctionnent tels
      // quels contre un 2e argument tableau (aucun runtime à modifier).
      const src = [
        '<script>', '$x = 1', '</script>',
        '<p class="out">{µt \'tableau\', [$x, 2]}</p>',
        '<button @click={$x = 5}>go</button>',
      ].join('\n')
      const { el } = await mountI18n('c1array', src, ["tableau: 'A=%{0} B=%{1}'"])
      const out = () => el._shadow.querySelector('.out').textContent
      assert.equal(out(), 'A=1 B=2', 'rendu initial')
      clickBouton(el)
      await new Promise(r => setTimeout(r, 80))
      assert.equal(out(), 'A=5 B=2', "AVANT le correctif : figé sur 'A=1 B=2' (aucune accolade dans l'expression → aucun repli textuel, branche finale non validée)")
    })
  })

  // ==========================================================================
  // Non-régression générique : pour chaque forme Civet
  // représentative, chaque `$xxx` textuellement présent doit être une clé de
  // `effectsByVar` (accès direct via `compile()`, même recette que
  // tests/effect-deps-coffee-operators.test.ts — pas de montage, plus rapide).
  // ==========================================================================
  describe('non-régression générique (formes Civet représentatives)', () => {
    const cases: { name: string; html: string; declare: string; expect: string[] }[] = [
      { name: 'chaînage optionnel `$x?.y`', html: '<p>{$x?.y}</p>', declare: '{$x}', expect: ['x'] },
      { name: 'index dynamique `$a[$b]`', html: '<p>{$a[$b]}</p>', declare: '{$a}{$b}', expect: ['a', 'b'] },
      { name: 'gabarit `` `${$x}` `` (backtick)', html: '<p>{`val: ${$x}`}</p>', declare: '{$x}', expect: ['x'] },
      { name: 'ternaire', html: "<p>{$x > 0 ? 'pos' : 'neg'}</p>", declare: '{$x}', expect: ['x'] },
      { name: 'déstructuration (`{a: localA} = $obj`)', html: '<p>{ ({a: localA} = $obj, localA + $x) }</p>', declare: '{$x}{$obj}', expect: ['obj', 'x'] },
      { name: '`$obj.method()`', html: '<p>{$x.toUpperCase()}</p>', declare: '{$x}', expect: ['x'] },
      { name: '`$list.length`', html: '<p>{$x.length}</p>', declare: '{$x}', expect: ['x'] },
      { name: '`$m.get(k)`', html: '<p>{$x.get(k)}</p>', declare: '{$x}', expect: ['x'] },
      { name: 'spread `{...$o}`', html: '<p>{JSON.stringify({...$x})}</p>', declare: '{$x}', expect: ['x'] },
      { name: '`??`', html: "<p>{$x ?? 'defaut'}</p>", declare: '{$x}', expect: ['x'] },
      { name: 'fonction fléchée `(v) -> v + $x`', html: "<p>{[1,2,3].map((v) -> v + $x).join(',')}</p>", declare: '{$x}', expect: ['x'] },
      { name: '`unless` (non-régression, doublon volontaire du montage réel)', html: '<p>{"ok" unless $x}</p>', declare: '{$x}', expect: ['x'] },
      { name: '`|>` (non-régression, doublon volontaire du montage réel)', html: '<p>{$x |> double}</p>', declare: '{$x}', expect: ['x'] },
      { name: 'appel implicite (non-régression, doublon volontaire du montage réel)', html: '<p>{fmt $x}</p>', declare: '{$x}', expect: ['x'] },
      { name: '`and`', html: '<p>{$a and $b}</p>', declare: '{$a}{$b}', expect: ['a', 'b'] },
      { name: '`or`', html: '<p>{$a or $b}</p>', declare: '{$a}{$b}', expect: ['a', 'b'] },
      { name: '`not`', html: '<p>{not $cond}</p>', declare: '{$cond}', expect: ['cond'] },
    ]

    for (const c of cases) {
      it(`${c.name} : ${JSON.stringify(c.expect)} présent dans effectsByVar`, () => {
        // `Analyzer` attend du JS DÉJÀ compilé (post-Civet), pas du Civet brut — script
        // vide + autoDeclareFromTemplate suffit : `k`/`localA`/`double`/`fmt` sont des
        // identifiants NUS, jamais des `$`, aucun besoin qu'ils existent réellement pour
        // que le suivi de dépendances (purement textuel/AST côté template) soit exercé.
        const a = new Analyzer('', [])
        a.autoDeclareFromTemplate(c.declare)
        const out = compile(c.html, { analyzer: a, moduleName: 'revue1c-generique' })
        const effectsByVar: Map<string, string[]> = out[4]
        for (const v of c.expect) {
          assert.ok(effectsByVar.has(v), `« ${v} » attendu dans effectsByVar — trouvé : ${JSON.stringify([...effectsByVar.keys()])}`)
        }
      })
    }
  })

  // ==========================================================================
  // Avertissement de build quand TOUTES les tentatives échouent
  // ==========================================================================
  describe('avertissement generator.deps-non-analysables', () => {
    it('expression volontairement incompilable contenant `$x` : avertit, ne lève rien, rend []', () => {
      const warnings: string[] = []
      const original = console.warn
      console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')) }
      let deps: string[]
      try {
        const cs = new CompilerState()
        cs.reset({ analyzer: null, externalVars: [], templateLang: 'civet', moduleName: 'probe-c1c' })
        cs.isPrePass = false
        deps = cs.getEffectVars('$x (')
      } finally {
        console.warn = original
      }
      assert.deepEqual(deps, [], 'ni la tentative JS nue ni le repli Civet ne peuvent parser « $x ( »')
      assert.equal(warnings.length, 1, `exactement 1 avertissement attendu, reçu : ${JSON.stringify(warnings)}`)
      assert.ok(warnings[0].includes('$x ('), 'le message doit citer l\'expression fautive')
      assert.ok(warnings[0].includes('probe-c1c'), 'le message doit citer le module (hint-dans-module)')
    })

    it("expression SANS `$` (constante pure) : aucun avertissement même si le parse échoue", () => {
      const warnings: string[] = []
      const original = console.warn
      console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')) }
      try {
        const cs = new CompilerState()
        cs.reset({ analyzer: null, externalVars: [], templateLang: 'civet' })
        cs.isPrePass = false
        cs.getEffectVars('1 +')
      } finally {
        console.warn = original
      }
      assert.deepEqual(warnings, [], 'aucun $xxx textuel → rien à suivre, pas d\'avertissement')
    })
  })

  // ==========================================================================
  // Nom d'état réservé refusé AVANT l'analyse
  // ==========================================================================
  describe("$__proto__/$constructor refusés avant l'analyse", () => {
    it('`$__proto__ = 5` → erreur claire citant `__proto__` (au lieu du TypeError muet)', async () => {
      const src = '<script>$__proto__ = 5</script><p>{$__proto__}</p>'
      await assert.rejects(
        () => transpile(src, { moduleName: 'probe-proto' }),
        (err: any) => {
          assert.ok(err.message.includes('__proto__'), `le message doit citer __proto__ — reçu : ${err.message}`)
          assert.ok(!err.message.includes('is not iterable'), 'AVANT le correctif : TypeError muet "sub is not iterable", aucune mention de __proto__')
          return true
        },
      )
    })

    it('`$constructor = 5` → erreur claire citant `constructor`', async () => {
      const src = '<script>$constructor = 5</script><p>{$constructor}</p>'
      await assert.rejects(
        // moduleName SANS le mot « constructor » dedans — sinon l'assertion `includes`
        // passerait par accident sur le nom du module, pas sur le message (piège prouvé :
        // 'probe-constructor'.includes('constructor') est vrai même SANS le correctif).
        () => transpile(src, { moduleName: 'sonde-c2' }),
        (err: any) => {
          assert.ok(err.message.includes('constructor'), `le message doit citer constructor — reçu : ${err.message}`)
          return true
        },
      )
    })

    it('témoin `$proto = 5` (nom proche, PAS réservé) : compile sans erreur', async () => {
      const src = '<script>$proto = 5</script><p>{$proto}</p>'
      const { output } = await transpile(src, { moduleName: 'probe-proto-ok' })
      assert.ok(output.length > 0, 'un nom proche mais distinct ne doit jamais être bloqué')
    })

    // ------------------------------------------------------------------------
    // Même famille de nom réservé,
    // mais côté MÉTHODE (`@x = ->`) plutôt qu'état (`$x`) : `methodReads['__proto__']`
    // (analyzer/index.ts, dict `{}` ordinaire) retombe sur Object.prototype (objet
    // TRUTHY, non itérable) → `TypeError: reads is not iterable`, sans jamais nommer
    // la cause.
    // ------------------------------------------------------------------------
    it('méthode `@__proto__ = () -> 1` → erreur claire citant `__proto__` (au lieu du TypeError muet "reads is not iterable")', async () => {
      const src = '<script>@__proto__ = () -> 1</script><p>{@__proto__()}</p>'
      await assert.rejects(
        () => transpile(src, { moduleName: 'probe-methode-proto' }),
        (err: any) => {
          assert.ok(err.message.includes('__proto__'), `le message doit citer __proto__ — reçu : ${err.message}`)
          assert.ok(!err.message.includes('is not iterable'), 'AVANT le correctif : TypeError muet "reads is not iterable", aucune mention de __proto__')
          return true
        },
      )
    })

    it('témoin `@proto = () -> 1` (nom de méthode proche, PAS réservé) : compile sans erreur', async () => {
      const src = '<script>@proto = () -> 1</script><p>{@proto()}</p>'
      const { output } = await transpile(src, { moduleName: 'probe-methode-proto-ok' })
      assert.ok(output.length > 0, 'un nom de méthode proche mais distinct ne doit jamais être bloqué')
    })
  })

  // ==========================================================================
  // Clé de store $$/µ$$ réservée
  // (__proto__/constructor/prototype) : le point de collecte compile-time
  // (storeDeclareKeys, transpiler/index.ts) est hors périmètre ici — seule la
  // garde RUNTIME de `µ._storeDeclare` (mjs_store_globals.ts) reste atteignable ;
  // avant le correctif, la clé était ignorée EN SILENCE (aucun accesseur créé,
  // aucune erreur) : `µ._storeDeclare(["__proto__"])`
  // compile sans erreur.
  // ==========================================================================
  describe('clé de store réservée refusée au chargement du module', () => {
    it('`$$__proto__ = 1` : le module compilé lève une erreur claire citant `__proto__` (au lieu du skip muet de `_storeDeclare`)', async () => {
      const src = [
        '<script>', '$$__proto__ = 1', '</script>',
        '<p>{$$__proto__}</p>',
      ].join('\n')
      await assert.rejects(
        () => mount('c23storeproto', src),
        (err: any) => {
          assert.ok(err.message.includes('__proto__'), `le message doit citer __proto__ — reçu : ${err.message}`)
          return true
        },
      )
    })

    it('témoin `$$proto = 1` (clé de store proche, PAS réservée) : montage sans erreur', async () => {
      const src = [
        '<script>', '$$proto = 1', '</script>',
        '<p class="out">{$$proto}</p>',
      ].join('\n')
      const { el } = await mount('c23storeproto-ok', src)
      const out = () => el._shadow.querySelector('.out').textContent.trim()
      assert.equal(out(), '1')
    })
  })

  // ==========================================================================
  // autoDeclareFromTemplate ignore les commentaires HTML
  // ==========================================================================
  describe('commentaires HTML retirés avant auto-déclaration', () => {
    it("un `$xxx` mentionné DANS un commentaire HTML n'est pas auto-déclaré", () => {
      const a = new Analyzer('')
      a.autoDeclareFromTemplate('<!-- $fantome --><p>texte</p>')
      assert.deepEqual(a.stateVars, [], 'AVANT le correctif : ["fantome"] — state var fantôme, jamais dans aucun effet')
    })

    it('un `$xxx` dans un binding réel (hors commentaire) reste auto-déclaré', () => {
      const a = new Analyzer('')
      a.autoDeclareFromTemplate('<p>{$vrai}</p>')
      assert.deepEqual(a.stateVars, ['vrai'])
    })

    it('mélange : le `$xxx` du commentaire est ignoré, celui du binding réel reste déclaré', () => {
      const a = new Analyzer('')
      a.autoDeclareFromTemplate('<!-- $fantome --><p>{$vrai}</p>')
      assert.deepEqual(a.stateVars, ['vrai'])
    })
  })
})

// ============================================================================
// Interpolation Civet `"...#{X}..."`
// DANS une expression de template.
//
// Une hypothèse initiale attribuait la cause à compile.ts/generator/attributes
// (« la chaîne n'atteint même pas le repli Civet ») — inexact : l'instrumentation
// directe de `CompilerState.prototype.getEffectVars` prouve que la chaîne ATTEINT
// bien `getEffectVars`. La vraie cause, plus fine : le candidat « whole »
// `["val: #{$.x}"]` est un JS PARFAITEMENT VALIDE (un Literal accepte n'importe quel
// texte) → `acorn.parse` réussit → `analyzeSnippetOrNull` rend `[]` (pas `null`) → le
// repli Civet (qui ne se déclenche QUE sur `null`, un vrai échec de parse) n'est
// JAMAIS tenté. Côté émission, `cleanJsExpr` compile la chaîne via
// le VRAI Civet, qui ne comprend PAS `#{}` nativement (seul Coffee le fait) — le texte
// sort littéral, `$x` jamais suivi. Correctif : la même conversion `"...#{X}..."` →
// gabarit `` `...${X}...` `` que la Pass 3 du `<script>` (transpiler/index.ts), rejouée
// dans `cleanJsExpr` (generator/utils.ts) et dans `getEffectVars` (generator/state.ts).
// ============================================================================
describe('interpolation Civet "#{}" dans une expression de template', function () {
  this.timeout(40000)
  it('`{"val: #{$x}"}` affiche "val: 1" puis se remet à jour en "val: 2" après un clic', async () => {
    const src = [
      '<script>', '$x = 1', '</script>',
      '<p class="out">{"val: #{$x}"}</p>',
      '<button @click={$x = 2}>go</button>',
    ].join('\n')
    const { el } = await mount('c21interp', src)
    const out = () => el._shadow.querySelector('.out').textContent
    assert.equal(out(), 'val: 1', 'rendu initial')
    clickBouton(el)
    await new Promise(r => setTimeout(r, 80))
    assert.equal(out(), 'val: 2', 'AVANT le correctif : figé sur "val: 1" (texte littéral, jamais recompilé)')
  })

  const cases: { name: string; html: string; declare: string; expect: string[] }[] = [
    { name: 'deux interpolations dans la même chaîne', html: '<p>{"a #{$x} b #{$y}"}</p>', declare: '{$x}{$y}', expect: ['x', 'y'] },
    { name: 'interpolation seule (rien autour)', html: '<p>{"#{$x}"}</p>', declare: '{$x}', expect: ['x'] },
  ]
  for (const c of cases) {
    it(`${c.name} : ${JSON.stringify(c.expect)} présent dans effectsByVar`, () => {
      const a = new Analyzer('', [])
      a.autoDeclareFromTemplate(c.declare)
      const out = compile(c.html, { analyzer: a, moduleName: 'revue1c2-interp' })
      const effectsByVar: Map<string, string[]> = out[4]
      for (const v of c.expect) {
        assert.ok(effectsByVar.has(v), `« ${v} » attendu dans effectsByVar — trouvé : ${JSON.stringify([...effectsByVar.keys()])}`)
      }
    })
  }

  it("guillemets SIMPLES `{'pas #{$x} interpolé'}` : reste littéral (Coffee/Civet n'interpolent que les doubles)", () => {
    const a = new Analyzer('', [])
    a.autoDeclareFromTemplate('{$x}')
    const out = compile("<p>{'pas #{$x} interpolé'}</p>", { analyzer: a, moduleName: 'revue1c2-simplequote' })
    const effectsByVar: Map<string, string[]> = out[4]
    const updates: string[] = out[1]
    assert.equal(effectsByVar.has('x'), false, 'guillemets simples : jamais interpolé, donc jamais suivi')
    assert.ok(updates.some(u => u.includes("'pas #{$x} interpolé'")), `le texte doit rester LITTÉRAL — reçu : ${JSON.stringify(updates)}`)
  })

  it('une chaîne contenant `#` SANS accolade reste inchangée', () => {
    const a = new Analyzer('', [])
    a.autoDeclareFromTemplate('{$x}')
    const out = compile('<p>{"prix: 5# unités"}</p>', { analyzer: a, moduleName: 'revue1c2-hash-sans-accolade' })
    const updates: string[] = out[1]
    assert.ok(updates.some(u => u.includes('"prix: 5# unités"')), `le texte doit rester INCHANGÉ — reçu : ${JSON.stringify(updates)}`)
  })
})
