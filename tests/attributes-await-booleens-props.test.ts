// `emitAttrSet` (src/generator/paths.ts,
// l. 1041-1068) route une valeur INTERPOLÉE en branche `{await}` (et tout contexte qui
// passe par ce chemin, ni root ni `{for}`) par `µ._mjs_safeAttr` SEUL : le filtre XSS est
// bien là, mais la sémantique PROPS BOOLÉENNES/`value`/`aria-*` de `µ._mjs_updAttrNode`
// (mjs_element.ts, déjà utilisée par root via `_mjs_updAttr` et par `{for}` via `dynamic()`)
// est ABSENTE — `disabled={d.v}`/`checked={d.v}` reste PRÉSENT pour toute valeur fausse
// (stringifiée `"false"` = attribut présent = toujours désactivé/coché quand même) et
// `value={d.txt}` sur un `<textarea>` ne pose RIEN (un `<textarea>` n'a pas d'attribut HTML
// `value` — il lui faut la PROPRIÉTÉ `.value`). Correctif : router par `µ._mjs_updAttrNode`,
// avec la valeur BRUTE (pas sa version stringifiée) quand l'attribut est une interpolation
// nue — `_mjs_updAttrNode` appelle `_mjs_safeAttr` en interne, le filtre XSS est conservé.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// compile un ou plusieurs .mjs (bundler complet) et monte `<rootTag>` dans une fenêtre
// happy-dom fraîche — calque de tests/attributes-await-et-routes.test.ts (mountFiles)
async function mountFiles(files: Record<string, string>, rootTag: string): Promise<{ window: any; document: any; el: any }> {
  const root   = mjsTmp('await-bool-props')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, src] of Object.entries(files)) writeFileSync(join(srcDir, name), src)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any   = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const outFiles = readdirSync(outDir)
  const coreFile = outFiles.find((f: string) => /^mjs_core-/.test(f))!
  const jsFiles  = outFiles.filter((f: string) => f.endsWith('.js') && f !== coreFile && f !== 'bundle.js')
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))
  const compCode = jsFiles.map((f: string) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))).join('\n')
  window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
  document.body.insertAdjacentHTML('beforeend', `<${rootTag}></${rootTag}>`)
  const el = document.body.querySelector(rootTag)
  return { window, document, el }
}

// monte `{await $p}{success d}<bodyHtml>{end}` avec `$p = Promise.resolve(<promiseObj>)`
async function mountAwaitSuccess(fileBase: string, bodyHtml: string, promiseObj: string): Promise<{ window: any; document: any; el: any }> {
  const src = [
    '<script>',
    `$p = Promise.resolve(${promiseObj})`,
    '</script>',
    `{await $p}{success d}${bodyHtml}{end}`,
  ].join('\n')
  return mountFiles({ [`${fileBase}.mjs`]: src }, `mjs-${fileBase}`)
}

describe('emitAttrSet aligné sur µ._mjs_updAttrNode (props booléennes/value/aria en branche {await})', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  describe('disabled={d.v} suit la sémantique props booléennes (retrait si falsy)', () => {
    const falsy: Array<[string, string]> = [['false', 'false'], ['null', 'null'], ['undefined', 'undefined'], ['0', '0'], ['chaine vide', "''"]]
    falsy.forEach(([label, expr], i) => {
      it(`d.v = ${label} -> attribut ABSENT et .disabled === false`, async () => {
        const { el } = await mountAwaitSuccess(`t1f${i}`, '<input type="checkbox" class="chk" disabled={d.v}>', `{ v: ${expr} }`)
        await new Promise((r) => setTimeout(r, 150))
        const input = el._shadow.querySelector('.chk')
        assert.equal(input.hasAttribute('disabled'), false, `AVANT le fix : l'attribut disabled reste posé pour d.v = ${label}`)
        assert.equal(input.disabled, false, `AVANT le fix : .disabled reste true pour d.v = ${label}`)
      })
    })
    const truthy: Array<[string, string]> = [['true', 'true'], ['1', '1'], ["'x'", "'x'"]]
    truthy.forEach(([label, expr], i) => {
      it(`d.v = ${label} -> .disabled === true`, async () => {
        const { el } = await mountAwaitSuccess(`t1t${i}`, '<input type="checkbox" class="chk" disabled={d.v}>', `{ v: ${expr} }`)
        await new Promise((r) => setTimeout(r, 150))
        const input = el._shadow.querySelector('.chk')
        assert.equal(input.disabled, true)
      })
    })
  })

  describe('checked={d.v} suit la sémantique props booléennes', () => {
    const falsy: Array<[string, string]> = [['false', 'false'], ['null', 'null'], ['undefined', 'undefined'], ['0', '0'], ['chaine vide', "''"]]
    falsy.forEach(([label, expr], i) => {
      it(`d.v = ${label} -> .checked === false`, async () => {
        const { el } = await mountAwaitSuccess(`t2f${i}`, '<input type="checkbox" class="chk" checked={d.v}>', `{ v: ${expr} }`)
        await new Promise((r) => setTimeout(r, 150))
        const input = el._shadow.querySelector('.chk')
        assert.equal(input.checked, false, `AVANT le fix : .checked reste true pour d.v = ${label}`)
      })
    })
    const truthy: Array<[string, string]> = [['true', 'true'], ['1', '1'], ["'x'", "'x'"]]
    truthy.forEach(([label, expr], i) => {
      it(`d.v = ${label} -> .checked === true`, async () => {
        const { el } = await mountAwaitSuccess(`t2t${i}`, '<input type="checkbox" class="chk" checked={d.v}>', `{ v: ${expr} }`)
        await new Promise((r) => setTimeout(r, 150))
        const input = el._shadow.querySelector('.chk')
        assert.equal(input.checked, true)
      })
    })
  })

  describe('value={d.txt} pose la PROPRIÉTÉ .value (textarea sans attribut value en HTML)', () => {
    it('<textarea value={d.txt}> -> .value === d.txt', async () => {
      const { el } = await mountAwaitSuccess('t3ta', '<textarea class="ta" value={d.txt}></textarea>', "{ txt: 'Bonjour' }")
      await new Promise((r) => setTimeout(r, 150))
      const ta = el._shadow.querySelector('.ta')
      assert.equal(ta.value, 'Bonjour', 'AVANT le fix : .value reste vide (setAttribute value sur un textarea est inerte)')
    })
    it('<input value={d.txt}> -> .value === d.txt', async () => {
      const { el } = await mountAwaitSuccess('t3in', '<input class="in" value={d.txt}>', "{ txt: 'Bonjour' }")
      await new Promise((r) => setTimeout(r, 150))
      const input = el._shadow.querySelector('.in')
      assert.equal(input.value, 'Bonjour')
    })
  })

  describe('parité root/{await} : outerHTML identique pour le même fragment', () => {
    const cases: Array<[string, string]> = [['false', 'false'], ['true', 'true'], ['null', 'null'], ["'a'", "'a'"]]
    cases.forEach(([label, expr], i) => {
      it(`X = ${label} -> <input type="checkbox" disabled={X} data-k={X}> identique en root et en {await}`, async () => {
        const rootSrc = [
          '<script>',
          `$v = ${expr}`,
          '</script>',
          '<input type="checkbox" disabled={$v} data-k={$v}>',
        ].join('\n')
        const { el: rootEl } = await mountFiles({ [`t4root${i}.mjs`]: rootSrc }, `mjs-t4root${i}`)
        await new Promise((r) => setTimeout(r, 150))
        const rootInput = rootEl._shadow.querySelector('input')

        const { el: awaitEl } = await mountAwaitSuccess(`t4await${i}`, '<input type="checkbox" disabled={d.v} data-k={d.v}>', `{ v: ${expr} }`)
        await new Promise((r) => setTimeout(r, 150))
        const awaitInput = awaitEl._shadow.querySelector('input')

        assert.equal(awaitInput.outerHTML, rootInput.outerHTML, `AVANT le fix : {await} et root divergent pour X = ${label}`)
      })
    })
  })

  describe('href={d.url} dangereux reste filtré en branche {await} (non-régression)', () => {
    it("d.url = 'javascript:alert(1)' -> getAttribute('href') n'est jamais ce schéma", async () => {
      const { el } = await mountAwaitSuccess('t5', '<a class="lien" href={d.url}>x</a>', "{ url: 'javascript:alert(1)' }")
      await new Promise((r) => setTimeout(r, 150))
      const a = el._shadow.querySelector('.lien')
      assert.notEqual(a.getAttribute('href'), 'javascript:alert(1)')
    })
  })

  describe('valeur mêlée texte + interpolation', () => {
    it("class=\"a {d.c}\" -> className === 'a X'", async () => {
      const { el } = await mountAwaitSuccess('t6', '<div class="a {d.c}">x</div>', "{ c: 'X' }")
      await new Promise((r) => setTimeout(r, 150))
      const div = el._shadow.querySelector('div')
      assert.equal(div.className, 'a X')
    })
  })

  describe('aria-hidden={d.v} avec d.v = false garde la sémantique _mjs_updAttrNode (chaîne "false", pas de retrait)', () => {
    it("d.v = false -> getAttribute('aria-hidden') === 'false'", async () => {
      const { el } = await mountAwaitSuccess('t7', '<div class="ah" aria-hidden={d.v}>x</div>', '{ v: false }')
      await new Promise((r) => setTimeout(r, 150))
      const div = el._shadow.querySelector('.ah')
      assert.equal(div.getAttribute('aria-hidden'), 'false')
    })
  })
})

// deux trous restants dans le
// même chemin (attributs interpolés en branche `{await}`, `emitAttrSet` src/
// generator/paths.ts) :
//   TROU 1 — la détection « interpolation nue » ne reconnaît QUE `${ident.membres}`
//   (regex `/^\$\{([\w$.]+)\}$/`) : une expression composée (`!d.v`, `d.list[0]`,
//   `d.a && d.b`) part par le chemin CHAÎNE (stringifiée) — `'false'` reste une
//   chaîne non vide, donc VRAIE pour une prop booléenne. Corrigé en reconnaissant
//   comme nue toute valeur = UNE SEULE fenêtre `${...}` couvrant sa longueur
//   entière (comptage d'accolades conscient des chaînes '/"/`).
//   TROU 2 — `<select value={d.v}>` : la propriété `.value` était posée juste après
//   `createElement('select')`, AVANT l'ajout des `<option>` — le navigateur n'a
//   alors aucune option à sélectionner et retombe sur la 1re. Corrigé en différant
//   la pose de `value` (statique ou interpolée) après les enfants du `<select>`.
describe('emitAttrSet : interpolation composée nue + <select value> différé (branche {await})', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  describe('disabled={!d.v} (négation) suit la valeur, jamais la chaîne stringifiée', () => {
    it('d.v = true (donc !d.v = false) -> .disabled === false, hasAttribute === false', async () => {
      const { el } = await mountAwaitSuccess('t8f', '<input type="checkbox" class="chk" disabled={!d.v}>', '{ v: true }')
      await new Promise((r) => setTimeout(r, 150))
      const input = el._shadow.querySelector('.chk')
      assert.equal(input.disabled, false, `AVANT le fix : .disabled reste true (chaîne "false" stringifiée)`)
      assert.equal(input.hasAttribute('disabled'), false, `AVANT le fix : l'attribut reste posé`)
    })
    it('d.v = false (donc !d.v = true) -> .disabled === true', async () => {
      const { el } = await mountAwaitSuccess('t8t', '<input type="checkbox" class="chk" disabled={!d.v}>', '{ v: false }')
      await new Promise((r) => setTimeout(r, 150))
      const input = el._shadow.querySelector('.chk')
      assert.equal(input.disabled, true)
    })
  })

  describe('expressions composées (accès indexé, &&) suivent la valeur réelle', () => {
    it('disabled={d.list[0]} avec d.list = [false] -> .disabled === false', async () => {
      const { el } = await mountAwaitSuccess('t9idx', '<input type="checkbox" class="chk" disabled={d.list[0]}>', '{ list: [false] }')
      await new Promise((r) => setTimeout(r, 150))
      const input = el._shadow.querySelector('.chk')
      assert.equal(input.disabled, false, `AVANT le fix : .disabled reste true (chaîne "false" stringifiée)`)
    })
    const combos: Array<[boolean, boolean, boolean]> = [[true, true, true], [true, false, false], [false, true, false]]
    combos.forEach(([a, b, attendu]) => {
      it(`checked={d.a && d.b} avec a=${a}, b=${b} -> .checked === ${attendu}`, async () => {
        const { el } = await mountAwaitSuccess(`t9and${a}${b}`, '<input type="checkbox" class="chk" checked={d.a && d.b}>', `{ a: ${a}, b: ${b} }`)
        await new Promise((r) => setTimeout(r, 150))
        const input = el._shadow.querySelector('.chk')
        assert.equal(input.checked, attendu)
      })
    })
  })

  describe('expression avec chaînes internes : la fenêtre ${...} est repérée jusqu\'à SA fermeture, pas au 1er guillemet', () => {
    it("title={d.a + ' ' + d.b} -> getAttribute('title') exact malgré les guillemets internes", async () => {
      const { el } = await mountAwaitSuccess('t10concat', '<input class="tt" title={d.a + \' \' + d.b}>', "{ a: 'foo', b: 'bar' }")
      await new Promise((r) => setTimeout(r, 150))
      const input = el._shadow.querySelector('.tt')
      assert.equal(input.getAttribute('title'), 'foo bar')
    })
    it('title={"x}y"} -> getAttribute(\'title\') === \'x}y\' (le } interne à la chaîne ne ferme pas la fenêtre trop tôt)', async () => {
      const { el } = await mountAwaitSuccess('t10brace', '<input class="tt" title={"x}y"}>', '{ a: 1 }')
      await new Promise((r) => setTimeout(r, 150))
      const input = el._shadow.querySelector('.tt')
      assert.equal(input.getAttribute('title'), 'x}y')
    })
  })

  describe('{if} imbriqué dans {await} (awaitCtx) : même sémantique que disabled={!d.v} direct', () => {
    it('d = { ok: true, v: true } -> .disabled === false', async () => {
      const { el } = await mountAwaitSuccess('t11f', '{if d.ok}<input type="checkbox" class="chk" disabled={!d.v}>{end}', '{ ok: true, v: true }')
      await new Promise((r) => setTimeout(r, 150))
      const input = el._shadow.querySelector('.chk')
      assert.equal(input.disabled, false, `AVANT le fix : .disabled reste true (chaîne "false" stringifiée)`)
    })
    it('d = { ok: true, v: false } -> .disabled === true', async () => {
      const { el } = await mountAwaitSuccess('t11t', '{if d.ok}<input type="checkbox" class="chk" disabled={!d.v}>{end}', '{ ok: true, v: false }')
      await new Promise((r) => setTimeout(r, 150))
      const input = el._shadow.querySelector('.chk')
      assert.equal(input.disabled, true)
    })
  })

  describe('<select value={...}> : la pose de .value est différée après les <option>', () => {
    const optionsHtml = '<option value="a">A</option><option value="b">B</option>'
    it(`{await} <select value={d.v}> avec d.v = 'b' -> .value === 'b'`, async () => {
      const { el } = await mountAwaitSuccess('t12await', `<select class="sel" value={d.v}>${optionsHtml}</select>`, "{ v: 'b' }")
      await new Promise((r) => setTimeout(r, 150))
      const sel = el._shadow.querySelector('.sel')
      assert.equal(sel.value, 'b', `AVANT le fix : retombe sur la 1re option (value posé avant les <option>)`)
    })
    it('root <select value={$v}> avec $v = \'b\' -> .value === \'b\' (référence, non-régression)', async () => {
      const rootSrc = ['<script>', "$v = 'b'", '</script>', `<select class="sel" value={$v}>${optionsHtml}</select>`].join('\n')
      const { el } = await mountFiles({ 't12root.mjs': rootSrc }, 'mjs-t12root')
      await new Promise((r) => setTimeout(r, 150))
      const sel = el._shadow.querySelector('.sel')
      assert.equal(sel.value, 'b')
    })
    it('{await} <select value="b"> statique -> .value === \'b\' (même cause que l\'interpolé)', async () => {
      // un `<p>{d.z}</p>` voisin FORCE le mode impératif sur toute la branche
      // (hasInterpolations regarde le HTML entier de la branche, pas élément
      // par élément) — un `<select>` seul, 100% statique, part par le mode
      // clone : un AUTRE chemin, hors périmètre de ce trou (browser ne
      // traite jamais `value=` sur un `<select>` comme un attribut spécial).
      const { el } = await mountAwaitSuccess('t12static', `<p>{d.z}</p><select class="sel" value="b">${optionsHtml}</select>`, '{ z: 1 }')
      await new Promise((r) => setTimeout(r, 150))
      const sel = el._shadow.querySelector('.sel')
      assert.equal(sel.value, 'b')
    })
  })

  describe('parité root/{await} sur disabled={!X}', () => {
    const cases: Array<[string, string]> = [['true', 'true'], ['false', 'false']]
    cases.forEach(([label, expr]) => {
      it(`X = ${label} -> <input disabled={!X}> identique en root et en {await}`, async () => {
        const rootSrc = ['<script>', `$v = ${expr}`, '</script>', '<input type="checkbox" disabled={!$v}>'].join('\n')
        const { el: rootEl } = await mountFiles({ [`t13root${label}.mjs`]: rootSrc }, `mjs-t13root${label}`)
        await new Promise((r) => setTimeout(r, 150))
        const rootInput = rootEl._shadow.querySelector('input')

        const { el: awaitEl } = await mountAwaitSuccess(`t13await${label}`, '<input type="checkbox" disabled={!d.v}>', `{ v: ${expr} }`)
        await new Promise((r) => setTimeout(r, 150))
        const awaitInput = awaitEl._shadow.querySelector('input')

        assert.equal(awaitInput.outerHTML, rootInput.outerHTML, `AVANT le fix : {await} et root divergent pour X = ${label}`)
      })
    })
  })

  describe('sécurité : href={d.base + d.path} composé reste filtré par _mjs_safeAttr', () => {
    it("d.base = 'javascript:', d.path = 'alert(1)' -> attribut href absent", async () => {
      const { el } = await mountAwaitSuccess('t14', '<a class="lien" href={d.base + d.path}>x</a>', "{ base: 'javascript:', path: 'alert(1)' }")
      await new Promise((r) => setTimeout(r, 150))
      const a = el._shadow.querySelector('.lien')
      assert.equal(a.hasAttribute('href'), false, `getAttribute renvoie ${a.getAttribute('href')}`)
    })
  })
})

// deux trous PRÉ-EXISTANTS, hors du chemin déjà corrigé plus haut
// (emitAttrSet/deferredValueSink) :
//   TROU 1 — le scanner de fin de balise ouvrante (`generateCreateFnBodyImperative`,
//   src/generator/paths.ts) repère le `>` de fermeture avec un `inQuote` NAÏF (bascule
//   sur `"`/`'`, aucune notion de fenêtre `${...}`). Un attribut interpolé dont le
//   texte SOURCE de l'expression contient une apostrophe (`title={"l'été"}`,
//   `title={'a\'b'}`) — enveloppé en quotes simples par `attributes/index.ts`
//   (branche `dynamic()` "ni root ni for", cf. `{await}`/`{if}`/`{key}` imbriqués)
//   — referme le guillemet HTML trop tôt : l'élément ET tout ce qui le suit dans
//   la branche disparaissent du rendu, SANS erreur de compilation. `{for}` (ctx.type
//   'for') n'est PAS concerné par ce mécanisme précis : `dynamic()`/`interpolation()`
//   n'y embarquent JAMAIS de fenêtre `${...}` brute dans le HTML (toujours
//   `attr=''` + code séparé posé via `__nodes`) — le cas `{for}` au root le vérifie en non-régression.
//   TROU 2 — `<select value={d.v}>` dont les `<option>` viennent d'un `{for}` À
//   L'INTÉRIEUR, en branche `{await}`/`{if}`/`{key}` : la ligne différée du
//   `value` (posée par `popStackFrame`) reste DANS le corps de la createFn
//   — donc exécutée AVANT que `branchUpdates` (le `_mjs_updList` du `{for}`) ne peuple
//   les `<option>` réelles. `.value` retombe sur la 1re option, au montage ET à
//   chaque reconstruction de branche (root : autre mécanisme, non concerné).
describe('scanner de balise conscient de ${...} (TROU 1) + <select value> posé après {for} (TROU 2)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  describe('{await} : title={"l\'été"} (apostrophe dans une chaîne littérale) ne fait plus disparaître l\'élément ni ses frères', () => {
    it('le <div> ET le <p> frère sont rendus, title exact', async () => {
      const { el } = await mountAwaitSuccess('t15', '<div class="row" title={"l\'été"}>x</div><p class="suite">suite</p>', '1')
      await new Promise((r) => setTimeout(r, 150))
      const row = el._shadow.querySelector('.row')
      const suite = el._shadow.querySelector('.suite')
      assert.ok(row, `AVANT le fix : le <div> disparaît (scanner de fin de balise désynchronisé par l'apostrophe)`)
      assert.equal(row.getAttribute('title'), "l'été")
      assert.ok(suite, `AVANT le fix : tout ce qui suit dans la branche disparaît aussi`)
    })
  })

  describe('{await} : title avec apostrophe littérale, {if} imbriqué dans {await}', () => {
    it('le <div> ET le <p> frère sont rendus, title exact', async () => {
      const { el } = await mountAwaitSuccess('t16', '{if d.ok}<div class="row" title={"l\'été"}>x</div><p class="suite">suite</p>{end}', '{ ok: true }')
      await new Promise((r) => setTimeout(r, 150))
      const row = el._shadow.querySelector('.row')
      const suite = el._shadow.querySelector('.suite')
      assert.ok(row, `AVANT le fix : le <div> disparaît`)
      assert.equal(row.getAttribute('title'), "l'été")
      assert.ok(suite, `AVANT le fix : le frère disparaît aussi`)
    })
  })

  describe('{await} : title avec apostrophe littérale, {key} imbriqué dans {await}', () => {
    it('le <div> ET le <p> frère sont rendus, title exact', async () => {
      const { el } = await mountAwaitSuccess('t17', '{key d.k}<div class="row" title={"l\'été"}>x</div><p class="suite">suite</p>{end}', '{ k: 1 }')
      await new Promise((r) => setTimeout(r, 150))
      const row = el._shadow.querySelector('.row')
      const suite = el._shadow.querySelector('.suite')
      assert.ok(row, `AVANT le fix : le <div> disparaît`)
      assert.equal(row.getAttribute('title'), "l'été")
      assert.ok(suite, `AVANT le fix : le frère disparaît aussi`)
    })
  })

  describe('{for} au root : title={"l\'été"} (non-régression — ctx.type \'for\' ne subit PAS ce mécanisme)', () => {
    it('la ligne rendue et son frère APRÈS la boucle sont tous deux présents, title exact', async () => {
      // AVANT le fix, déjà vert : `dynamic()` en ctx.type 'for' n'embarque
      // jamais `${...}` brut dans le HTML (toujours `attr=''` + `__nodes[...]`
      // posé à part) — ce scanner n'est donc jamais atteint AVEC une apostrophe
      // par ce chemin. Gardé ici en
      // non-régression du correctif partagé (le scanner reste le MÊME code).
      const rootSrc = ['<script>', "$rows = [{ text: 'x' }]", '</script>', `{for item in $rows}<div class="row" title={"l'été"}>{item.text}</div><p class="apres">apres</p>{end}`].join('\n')
      const { el } = await mountFiles({ 't18.mjs': rootSrc }, 'mjs-t18')
      await new Promise((r) => setTimeout(r, 150))
      const row = el._shadow.querySelector('.row')
      const apres = el._shadow.querySelector('.apres')
      assert.ok(row)
      assert.equal(row.getAttribute('title'), "l'été")
      assert.ok(apres)
    })
  })

  describe('{await} : title={\'a\\\'b\'} (apostrophe ÉCHAPPÉE dans la chaîne littérale)', () => {
    it('le <div> ET le <p> frère sont rendus, title === "a\'b"', async () => {
      const { el } = await mountAwaitSuccess('t19', "<div class=\"row\" title={'a\\'b'}>x</div><p class=\"suite\">suite</p>", '1')
      await new Promise((r) => setTimeout(r, 150))
      const row = el._shadow.querySelector('.row')
      const suite = el._shadow.querySelector('.suite')
      assert.ok(row, `AVANT le fix : le <div> disparaît`)
      assert.equal(row.getAttribute('title'), "a'b")
      assert.ok(suite, `AVANT le fix : le frère disparaît aussi`)
    })
  })

  describe('{await} : title apostrophe suivi d\'un frère portant SES PROPRES attributs', () => {
    it('le frère et ses attributs (class/data-x/data-y) survivent intacts', async () => {
      const { el } = await mountAwaitSuccess('t20', '<div class="row" title={"l\'été"}>x</div><p class="suite" data-x="1" data-y=\'2\'>suite</p>', '1')
      await new Promise((r) => setTimeout(r, 150))
      const row = el._shadow.querySelector('.row')
      const suite = el._shadow.querySelector('.suite')
      assert.ok(row, `AVANT le fix : le <div> disparaît`)
      assert.equal(row.getAttribute('title'), "l'été")
      assert.ok(suite, `AVANT le fix : le frère disparaît aussi`)
      assert.equal(suite.getAttribute('data-x'), '1')
      assert.equal(suite.getAttribute('data-y'), '2')
    })
  })

  // helper — {await} avec un bouton de RELOAD (réassigne $p vers une 2e
  // promesse) : seul moyen d'observer un changement de d.opts/d.v, `d` étant une
  // liaison de template locale à la branche (pas une var `$` traquée).
  async function mountAwaitReload(fileBase: string, bodyHtml: string, promiseObj1: string, promiseObj2: string): Promise<{ window: any; document: any; el: any }> {
    const src = [
      '<script>',
      `$p = Promise.resolve(${promiseObj1})`,
      '</script>',
      `{await $p}{success d}${bodyHtml}{end}`,
      `<button class="reload" @click={$p = Promise.resolve(${promiseObj2})}>reload</button>`,
    ].join('\n')
    return mountFiles({ [`${fileBase}.mjs`]: src }, `mjs-${fileBase}`)
  }

  describe('{await} : <select value={d.v}> dont les <option> viennent d\'un {for} — .value correct au montage ET après reconstruction', () => {
    it("d.v = 'b' -> .value === 'b' au montage, puis d.v = 'c' -> .value === 'c' après reload", async () => {
      const { el } = await mountAwaitReload(
        't21',
        '<select class="sel" value={d.v}>{for o in d.opts}<option value={o}>{o}</option>{end}</select>',
        "{ v: 'b', opts: ['a','b','c'] }",
        "{ v: 'c', opts: ['x','y','c'] }",
      )
      await new Promise((r) => setTimeout(r, 150))
      let sel = el._shadow.querySelector('.sel')
      assert.equal(sel.value, 'b', `AVANT le fix : retombe sur la 1re option (value posé avant les <option>)`)
      el._shadow.querySelector('.reload').click()
      await new Promise((r) => setTimeout(r, 150))
      sel = el._shadow.querySelector('.sel')
      assert.equal(sel.value, 'c', `AVANT le fix : retombe sur la 1re option après reconstruction aussi`)
    })
  })

  describe('{await} : <select> alimenté par {for}, {if} imbriqué dans {await}', () => {
    it("d.v = 'b' -> .value === 'b' au montage, puis d.v = 'c' -> .value === 'c' après reload", async () => {
      const { el } = await mountAwaitReload(
        't22',
        '{if d.ok}<select class="sel" value={d.v}>{for o in d.opts}<option value={o}>{o}</option>{end}</select>{end}',
        "{ ok: true, v: 'b', opts: ['a','b','c'] }",
        "{ ok: true, v: 'c', opts: ['x','y','c'] }",
      )
      await new Promise((r) => setTimeout(r, 150))
      let sel = el._shadow.querySelector('.sel')
      assert.equal(sel.value, 'b', `AVANT le fix : retombe sur la 1re option`)
      el._shadow.querySelector('.reload').click()
      await new Promise((r) => setTimeout(r, 150))
      sel = el._shadow.querySelector('.sel')
      assert.equal(sel.value, 'c', `AVANT le fix : retombe sur la 1re option après reconstruction aussi`)
    })
  })

  describe('{await} : <select> alimenté par {for}, {key} imbriqué dans {await} + non-régression root <select>+{for}', () => {
    it("d.v = 'b' -> .value === 'b' au montage, puis d.v = 'c' -> .value === 'c' après reload", async () => {
      const { el } = await mountAwaitReload(
        't23',
        '{key d.k}<select class="sel" value={d.v}>{for o in d.opts}<option value={o}>{o}</option>{end}</select>{end}',
        "{ k: 1, v: 'b', opts: ['a','b','c'] }",
        "{ k: 2, v: 'c', opts: ['x','y','c'] }",
      )
      await new Promise((r) => setTimeout(r, 150))
      let sel = el._shadow.querySelector('.sel')
      assert.equal(sel.value, 'b', `AVANT le fix : retombe sur la 1re option`)
      el._shadow.querySelector('.reload').click()
      await new Promise((r) => setTimeout(r, 150))
      sel = el._shadow.querySelector('.sel')
      assert.equal(sel.value, 'c', `AVANT le fix : retombe sur la 1re option après reconstruction aussi`)
    })

    it('root <select value={$v}>{for}...{end}</select> reste correct (non-régression)', async () => {
      const rootSrc = ['<script>', "$v = 'b'", "$opts = ['a','b','c']", '</script>', `<select class="sel" value={$v}>{for o in $opts}<option value={o}>{o}</option>{end}</select>`].join('\n')
      const { el } = await mountFiles({ 't23root.mjs': rootSrc }, 'mjs-t23root')
      await new Promise((r) => setTimeout(r, 150))
      const sel = el._shadow.querySelector('.sel')
      assert.equal(sel.value, 'b')
    })
  })
})
