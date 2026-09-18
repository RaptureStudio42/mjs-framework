// Attributs/routes en branche {await} : quatre régressions distinctes.
//
// `bindingContent`/`bindingGroup` écrivaient `state.events.<evt>[id] = idx` en
// DIRECT au lieu de passer par `registerEventRoute` (point de passage unique qui
// EMPILE au lieu d'écraser) : `@group=!{$sel} @change={onChange()}` sur un même
// élément partage le couple (événement, nœud) — l'écriture directe qui s'exécute
// EN DERNIER remplace tout ce qui précède, liaison ou directive perdue selon
// l'ordre des attributs dans le gabarit.
//
// Un attribut dynamique (`href={d.url}`) en branche `{await}` (ni root ni
// `{for}`) traversait `generateCreateFnBody` en mode IMPÉRATIF sans jamais passer
// par `µ._mjs_safeAttr` (`emitAttrSet`, paths.ts) — le filtre XSS `javascript:`/
// `data:text/html` posé partout ailleurs (root via `_mjs_updAttr`, `{for}` via
// `_mjs_updAttrNode`) était absent sur CETTE branche.
//
// Une prop dynamique d'un COMPOSANT (`<mjs-card item={d}>`) en branche
// `{await}` n'émettait RIEN DU TOUT (seul le cas non-composant écrivait quelque
// chose) : la prop disparaissait en silence, sans même un attribut HTML fantôme.
//
// Vérification (pas nécessairement un bug) : un `$xxx` nu dans un attribut
// STATIQUE (`title="valeur : $nom"`, sans accolades) en branche `{await}` route
// vers `this._mjs_nodes[id]` au lieu des refs LOCALES `__nodes` de la branche — or le
// code s'exécute DANS la createFn, AVANT que `_mjs_updIf` ne fusionne les refs dans
// `this._mjs_nodes` (mjs_element.ts) : la fusion arrive trop tard.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { transpile } from '../src/transpiler/index.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// compile un ou plusieurs .mjs (bundler complet) et monte `<rootTag>` dans une fenêtre
// happy-dom fraîche — même mécanique que ssr-nested-await-settle.test.ts
async function mountFiles(files: Record<string, string>, rootTag: string): Promise<{ window: any; document: any; el: any }> {
  const root   = mjsTmp('await-routes')
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

describe('routes empilées, filtre XSS et prop composant en branche {await}', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  describe('bindingContent/bindingGroup court-circuitaient registerEventRoute', () => {
    describe('compilation — data.events.<evt>[id] doit être une LISTE de 2 routes, quel que soit l\'ordre des attributs', () => {
      it('checkbox : @group=!{$sel} PUIS @change={onChange()} — data.events.change[id] est une liste de 2', async () => {
        const src = [
          '<script>',
          '$sel = []',
          'onChange = -> null',
          '</script>',
          '<input type="checkbox" value="a" @group=!{$sel} @change={onChange()}>',
        ].join('\n')
        const { data } = await transpile(src, { moduleName: 'g1a1' })
        const ids = Object.keys(data.events.change ?? {})
        assert.equal(ids.length, 1, 'un seul id de routage partagé entre @group et @change')
        const route: any = data.events.change[ids[0]]
        assert.ok(Array.isArray(route) && Array.isArray(route[0]), `AVANT le fix : route perdue (trouvé ${JSON.stringify(route)}) — doit être une liste de 2 paires [idx,flags]`)
        assert.equal(route.length, 2)
      })

      it('checkbox : @change={onChange()} PUIS @group=!{$sel} (ordre INVERSÉ) — toujours une liste de 2', async () => {
        const src = [
          '<script>',
          '$sel = []',
          'onChange = -> null',
          '</script>',
          '<input type="checkbox" value="a" @change={onChange()} @group=!{$sel}>',
        ].join('\n')
        const { data } = await transpile(src, { moduleName: 'g1a2' })
        const ids = Object.keys(data.events.change ?? {})
        assert.equal(ids.length, 1, 'un seul id de routage partagé entre @change et @group')
        const route: any = data.events.change[ids[0]]
        assert.ok(Array.isArray(route) && Array.isArray(route[0]), `AVANT le fix : route perdue (trouvé ${JSON.stringify(route)}) — doit être une liste de 2 paires [idx,flags]`)
        assert.equal(route.length, 2)
      })

      it('contenteditable : @text=!{$txt} PUIS @input={onInput()} — data.events.input[id] est une liste de 2', async () => {
        const src = [
          '<script>',
          "$txt = ''",
          'onInput = -> null',
          '</script>',
          '<div contenteditable @text=!{$txt} @input={onInput()}>x</div>',
        ].join('\n')
        const { data } = await transpile(src, { moduleName: 'g1c1' })
        const ids = Object.keys(data.events.input ?? {})
        assert.equal(ids.length, 1, 'un seul id de routage partagé entre @text et @input')
        const route: any = data.events.input[ids[0]]
        assert.ok(Array.isArray(route) && Array.isArray(route[0]), `AVANT le fix : route perdue (trouvé ${JSON.stringify(route)}) — doit être une liste de 2 paires [idx,flags]`)
        assert.equal(route.length, 2)
      })

      it('contenteditable : @input={onInput()} PUIS @text=!{$txt} (ordre INVERSÉ) — toujours une liste de 2', async () => {
        const src = [
          '<script>',
          "$txt = ''",
          'onInput = -> null',
          '</script>',
          '<div contenteditable @input={onInput()} @text=!{$txt}>x</div>',
        ].join('\n')
        const { data } = await transpile(src, { moduleName: 'g1c2' })
        const ids = Object.keys(data.events.input ?? {})
        assert.equal(ids.length, 1, 'un seul id de routage partagé entre @input et @text')
        const route: any = data.events.input[ids[0]]
        assert.ok(Array.isArray(route) && Array.isArray(route[0]), `AVANT le fix : route perdue (trouvé ${JSON.stringify(route)}) — doit être une liste de 2 paires [idx,flags]`)
        assert.equal(route.length, 2)
      })
    })

    describe('exécution — happy-dom bout en bout : les DEUX effets (liaison + directive) doivent survivre', () => {
      it('checkbox @change={onChange()} @group=!{$sel} : cocher la case met à jour $sel ET appelle onChange', async () => {
        const src = [
          '<script lang="coffee">',
          '$sel = []',
          '$calls = 0',
          "$snapshot = ''",
          'onChange = ->',
          '  $calls += 1',
          "  $snapshot = $sel.join(',')",
          '</script>',
          '<input class="chk" type="checkbox" value="a" @change={onChange()} @group=!{$sel}>',
          '<span class="calls">{$calls}</span>',
          '<span class="snap">{$snapshot}</span>',
        ].join('\n')
        const { window, el } = await mountFiles({ 'chk.mjs': src }, 'mjs-chk')
        await new Promise((r) => setTimeout(r, 80))
        const chk = el._shadow.querySelector('.chk')
        chk.checked = true
        chk.dispatchEvent(new window.Event('change', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 80))
        assert.equal(el._shadow.querySelector('.calls').textContent, '1', 'AVANT le fix : onChange perdu (écrasé par le raw write de bindingGroup) — calls reste à 0')
        assert.equal(el._shadow.querySelector('.snap').textContent, 'a', 'la liaison @group doit déjà avoir mis $sel à jour quand onChange le lit (liaison AVANT directive)')
      })

      it('contenteditable @input={onInput()} @text=!{$txt} : éditer met à jour $txt ET appelle onInput', async () => {
        const src = [
          '<script lang="coffee">',
          "$txt = ''",
          '$calls = 0',
          'onInput = -> $calls += 1',
          '</script>',
          '<div class="ed" contenteditable @input={onInput()} @text=!{$txt}>x</div>',
          '<span class="calls">{$calls}</span>',
          '<span class="txt">{$txt}</span>',
        ].join('\n')
        const { window, el } = await mountFiles({ 'ed.mjs': src }, 'mjs-ed')
        await new Promise((r) => setTimeout(r, 80))
        const ed = el._shadow.querySelector('.ed')
        ed.textContent = 'hello'
        ed.dispatchEvent(new window.Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 80))
        assert.equal(el._shadow.querySelector('.txt').textContent, 'hello', 'la liaison @text doit rester fonctionnelle')
        assert.equal(el._shadow.querySelector('.calls').textContent, '1', 'AVANT le fix : onInput perdu (écrasé par le raw write de bindingContent) — calls reste à 0')
      })
    })
  })

  describe('{await} : attribut dynamique sans filtre XSS', () => {
    it('le JS émis passe par µ._mjs_safeAttr, jamais par une prop directe SANS filtre (PROP_ATTRS)', async () => {
      const src = [
        '<script>',
        '$p = Promise.resolve({ url: "https://ok.example/" })',
        '</script>',
        '{await $p}{success d}<a href={d.url}>lien</a>{end}',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'g2a' })
      // une interpolation NUE passe désormais par µ._mjs_updAttrNode (qui appelle µ._mjs_safeAttr en interne, cf. mjs_element.ts) — les deux formes valent filtre
      assert.match(output, /µ\._mjs_(?:safeAttr|updAttrNode)\(/, 'AVANT le fix : aucun filtre XSS sur un attribut dynamique en branche {await}')
      assert.doesNotMatch(output, /\.href\s*=\s*`/, 'AVANT le fix : `el.href = `...`` (PROP_ATTRS) posait la valeur SANS filtre')
    })

    it('happy-dom : href dangereux neutralisé (attribut absent), href sain posé normalement', async () => {
      const src = [
        '<script lang="coffee">',
        "$p = new Promise((resolve) -> resolve({ bad: 'javascript:alert(1)', good: 'https://ok.example/' }))",
        '</script>',
        '{await $p}{success d}<a class="bad" href={d.bad}>x</a><a class="good" href={d.good}>y</a>{end}',
      ].join('\n')
      const { el } = await mountFiles({ 'xssawait.mjs': src }, 'mjs-xssawait')
      await new Promise((r) => setTimeout(r, 150))
      const bad  = el._shadow.querySelector('a.bad')
      const good = el._shadow.querySelector('a.good')
      assert.equal(bad.getAttribute('href'), null, 'AVANT le fix : `javascript:alert(1)` posé tel quel (aucun filtre en branche {await})')
      assert.equal(good.getAttribute('href'), 'https://ok.example/', 'une URL légitime doit passer normalement')
    })

    it('non-régression : un attribut STATIQUE (class="x") dans la même branche compile toujours en .className', async () => {
      const src = [
        '<script>',
        '$p = Promise.resolve({ url: "https://ok.example/" })',
        '</script>',
        '{await $p}{success d}<a href={d.url} class="x">lien</a>{end}',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'g2c' })
      assert.match(output, /\.className = "x"/, 'un attribut statique doit garder le chemin propriété direct, byte-identique')
    })
  })

  describe('{await} : prop dynamique d\'un COMPOSANT perdue', () => {
    it('le JS émis contient l\'appel _set(\'item\', …) DANS la createFn de la branche success', async () => {
      const src = [
        '<script>',
        '$p = Promise.resolve({ id: 42 })',
        '</script>',
        '{await $p}{success d}<mjs-card item={d}></mjs-card>{end}',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'g3a' })
      const successIdx = output.indexOf('(d) => {')
      assert.notEqual(successIdx, -1, 'la branche success doit être générée')
      assert.match(output.slice(successIdx), /_set\('item'/, 'AVANT le fix : rien n\'était émis pour une prop de composant dynamique en branche {await} — `item` disparaissait en silence')
    })

    it('happy-dom : un <mjs-card> enfant reçoit bien la prop `item` après résolution', async () => {
      const card = [
        '<script lang="coffee">',
        '$item = { id: 0 }',
        '</script>',
        '<span class="val">{$item.id}</span>',
      ].join('\n')
      const parent = [
        '<script lang="coffee">',
        '$p = new Promise((resolve) -> setTimeout((-> resolve({ id: 42 })), 30))',
        '</script>',
        '{await $p}{success d}<mjs-card item={d}></mjs-card>{end}',
      ].join('\n')
      const { el } = await mountFiles({ 'card.mjs': card, 'parent.mjs': parent }, 'mjs-parent')
      await new Promise((r) => setTimeout(r, 300))
      const cardEl = el._shadow.querySelector('mjs-card')
      assert.ok(cardEl, 'le composant enfant doit être monté')
      assert.equal(cardEl._shadow.querySelector('.val').textContent, '42', 'AVANT le fix : `item` jamais posé sur l\'enfant en branche {await}')
    })
  })

  describe('vérification : $xxx nu dans un attribut STATIQUE en branche {await}', () => {
    it('{await p}{success d}<span title="valeur : $nom">x</span>{end} : le titre reflète $nom après résolution', async () => {
      const src = [
        '<script lang="coffee">',
        "$nom = 'Ada'",
        '$p = new Promise((resolve) -> resolve(1))',
        '</script>',
        '{await $p}{success d}<span class="who" title="valeur : $nom">x</span>{end}',
      ].join('\n')
      const { el } = await mountFiles({ 'g4span.mjs': src }, 'mjs-g4span')
      await new Promise((r) => setTimeout(r, 150))
      const span = el._shadow.querySelector('.who')
      assert.equal(span.getAttribute('title'), 'valeur : Ada', 'le titre statique portant un $var nu doit être posé après résolution de la branche {await}')
    })
  })
})
