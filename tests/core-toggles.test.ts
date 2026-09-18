// Modules cœur `checkbox`/`radio`/`switch` (<@checkbox>, <@radio>, <@switch>,
// tags réels <mjs-checkbox>/<mjs-radio>/<mjs-switch>) : natif RÉEL dans le shadow
// (focus/clavier/sémantique gratuits), habillage par-dessus, participation formulaire par un
// <input type=hidden> maintenu dans le LIGHT DOM de l'hôte (stratégie primaire — sonde attachInternals
// négative : happy-dom 20.9.0 n'implémente pas `attachInternals`). Radio : coordination
// de groupe MANUELLE par name (décoche les autres <mjs-radio> du même name). Patron build+happy-dom
// calqué sur tests/mjs-modal-bundler-integration.test.ts:62-85.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { assertAbsent } from './helpers/dom-assert.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function buildAndMount(hostSource: string, cores: string[]): Promise<{ window: any; document: any; hote: any; form: any }> {
  const root = mjsTmp('core-toggles')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'hote.mjs'), hostSource)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const files = readdirSync(outDir)
  const pick = (re: RegExp) => {
    const f = files.find((f) => re.test(f))
    assert.ok(f, `chunk attendu ${re} parmi ${files.join(', ')}`)
    return f!
  }
  const chunkFiles = [pick(/^mjs_core-/), ...cores.map((c) => pick(new RegExp(`^${c}-`))), pick(/^hote-/)]
  const code = chunkFiles.map((f) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))).join('\n')

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  window.eval(`${code}\nglobalThis.µ = µ;`)
  document.body.innerHTML = '<mjs-hote></mjs-hote>'
  await new Promise((r) => setTimeout(r, 80))
  const hote = document.body.querySelector('mjs-hote')
  const form = hote._shadow.querySelector('form')
  return { window, document, hote, form }
}

function fireChange(window: any, nativeInput: any, checked: boolean): void {
  nativeInput.checked = checked
  nativeInput.dispatchEvent(new window.Event('change', { bubbles: true }))
}

describe('mjs-checkbox — construction', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('build vert, tag <mjs-checkbox> réécrit dans le gabarit hôte', async () => {
    const root = mjsTmp('checkbox-build')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hote.mjs'), '<@checkbox name="a">Accepte</@checkbox>')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    assert.ok(stats.manifest['checkbox'])
    const files = readdirSync(outDir)
    const hote = files.find((f) => /^hote-/.test(f))!
    assert.match(readFileSync(join(outDir, hote), 'utf-8'), /<mjs-checkbox\b/)
  })
})

describe('mjs-checkbox — cocher/décocher, hidden, disabled', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  const HOST = [
    '<form>',
    '  <@checkbox name="terms" checked=!{$accepted}>J\'accepte les conditions</@checkbox>',
    '  <@checkbox name="premium" value="yes" checked=!{$premium}>Offre premium</@checkbox>',
    '  <@checkbox name="locked" checked=!{$locked} disabled={true}>Verrouillé</@checkbox>',
    '</form>',
  ].join('\n')

  it('clic → input natif coché + hidden posé (name/value par défaut "on") + FormData le reflète', async () => {
    const { window, form } = await buildAndMount(HOST, ['checkbox'])
    const cb = form.querySelectorAll('mjs-checkbox')[0]
    const native = cb._shadow.querySelector('input.native')
    assert.equal(native.checked, false, 'décoché au départ')
    fireChange(window, native, true)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(native.checked, true)
    const hidden = cb.querySelector('input[type=hidden]')
    assert.ok(hidden, 'hidden doit être posé')
    assert.equal(hidden.name, 'terms')
    assert.equal(hidden.value, 'on')
    const fd = new window.FormData(form)
    assert.equal(fd.get('terms'), 'on')
    window.close?.()
  })

  it('value personnalisée respectée sur le hidden', async () => {
    const { window, form } = await buildAndMount(HOST, ['checkbox'])
    const cb = form.querySelectorAll('mjs-checkbox')[1]
    const native = cb._shadow.querySelector('input.native')
    fireChange(window, native, true)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(cb.querySelector('input[type=hidden]').value, 'yes')
    window.close?.()
  })

  it('décoché de nouveau → hidden retiré, absent de FormData', async () => {
    const { window, form } = await buildAndMount(HOST, ['checkbox'])
    const cb = form.querySelectorAll('mjs-checkbox')[0]
    const native = cb._shadow.querySelector('input.native')
    fireChange(window, native, true)
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(cb.querySelector('input[type=hidden]'))
    fireChange(window, native, false)
    await new Promise((r) => setTimeout(r, 50))
    assertAbsent(cb.querySelector('input[type=hidden]'))
    const fd = new window.FormData(form)
    assert.equal(fd.get('terms'), null)
    window.close?.()
  })

  it('disabled : input natif désactivé, jamais de hidden même si forcé coché', async () => {
    const { window, form } = await buildAndMount(HOST, ['checkbox'])
    const cb = form.querySelectorAll('mjs-checkbox')[2]
    const native = cb._shadow.querySelector('input.native')
    assert.equal(native.disabled, true)
    fireChange(window, native, true)
    await new Promise((r) => setTimeout(r, 50))
    assertAbsent(cb.querySelector('input[type=hidden]'), 'un champ désactivé ne participe jamais au formulaire')
    window.close?.()
  })

  it('liaison two-way réelle : le clic met à jour la variable du PARENT ($accepted)', async () => {
    const HOST2 = [
      '<script>',
      '  $accepted = false',
      '</script>',
      '<form>',
      '  <@checkbox name="terms" checked=!{$accepted}>Accepte</@checkbox>',
      '</form>',
      '<p class="probe">{String($accepted)}</p>',
    ].join('\n')
    const { window, hote } = await buildAndMount(HOST2, ['checkbox'])
    const cb = hote._shadow.querySelector('mjs-checkbox')
    const native = cb._shadow.querySelector('input.native')
    assert.equal(hote._shadow.querySelector('.probe').textContent, 'false')
    fireChange(window, native, true)
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(hote._shadow.querySelector('.probe').textContent, 'true', 'la variable parent doit suivre le clic (mjs-bind:checked)')
    window.close?.()
  })

  it('liaison two-way réelle : un set externe (venant du parent, _set) répercute sur l\'input natif', async () => {
    const HOST2 = [
      '<script>',
      '  $accepted = false',
      '</script>',
      '<form>',
      '  <@checkbox name="terms" checked=!{$accepted}>Accepte</@checkbox>',
      '</form>',
      '<button type="button" class="flip" @click={$accepted = true}>flip</button>',
    ].join('\n')
    const { window, hote } = await buildAndMount(HOST2, ['checkbox'])
    const cb = hote._shadow.querySelector('mjs-checkbox')
    const native = cb._shadow.querySelector('input.native')
    assert.equal(native.checked, false)
    hote._shadow.querySelector('.flip').click()
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(native.checked, true, 'écrire $accepted côté parent doit cocher visuellement le natif')
    assert.ok(cb.querySelector('input[type=hidden]'), 'le hidden doit aussi apparaître')
    window.close?.()
  })
})

describe('mjs-radio — construction', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('build vert, tag <mjs-radio> réécrit dans le gabarit hôte', async () => {
    const root = mjsTmp('radio-build')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hote.mjs'), '<@radio name="size" value="s">S</@radio>')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    assert.ok(stats.manifest['radio'])
    const files = readdirSync(outDir)
    const hote = files.find((f) => /^hote-/.test(f))!
    assert.match(readFileSync(join(outDir, hote), 'utf-8'), /<mjs-radio\b/)
  })
})

describe('mjs-radio — coordination de groupe, hidden, disabled', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  const HOST = [
    '<script>',
    '  $size = null',
    '</script>',
    '<form>',
    '  <@radio name="size" value="s" group=!{$size}>S</@radio>',
    '  <@radio name="size" value="m" group=!{$size}>M</@radio>',
    '  <@radio name="size" value="l" group=!{$size}>L</@radio>',
    '  <@radio name="size" value="xl" group=!{$size} disabled={true}>XL</@radio>',
    '</form>',
  ].join('\n')

  it('cocher un radio décoche les 3 autres du même name (propriété native + hidden)', async () => {
    const { window, form } = await buildAndMount(HOST, ['radio'])
    const radios = Array.from(form.querySelectorAll('mjs-radio')) as any[]
    const natives = radios.map((r) => r._shadow.querySelector('input.native'))

    fireChange(window, natives[0], true)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(natives[0].checked, true)
    assert.ok(radios[0].querySelector('input[type=hidden]'))

    fireChange(window, natives[1], true)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(natives[0].checked, false, 'le 1er doit être décoché')
    assert.equal(natives[1].checked, true)
    assertAbsent(radios[0].querySelector('input[type=hidden]'), 'hidden du 1er retiré')
    assert.ok(radios[1].querySelector('input[type=hidden]'), 'hidden du 2e posé')
    window.close?.()
  })

  it('coordination MANUELLE seule (SANS liaison group=!{}) : cocher l\'un décoche quand même les autres par name', async () => {
    const HOST2 = [
      '<form>',
      '  <@radio name="plan" value="free">Gratuit</@radio>',
      '  <@radio name="plan" value="pro">Pro</@radio>',
      '</form>',
    ].join('\n')
    const { window, form } = await buildAndMount(HOST2, ['radio'])
    const radios = Array.from(form.querySelectorAll('mjs-radio')) as any[]
    const natives = radios.map((r) => r._shadow.querySelector('input.native'))
    fireChange(window, natives[0], true)
    await new Promise((r) => setTimeout(r, 60))
    fireChange(window, natives[1], true)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(natives[0].checked, false, 'sans group=!{}, la coordination par name doit décocher seule le 1er')
    assert.equal(natives[1].checked, true)
    const fd = new window.FormData(form)
    assert.deepEqual(fd.getAll('plan'), ['pro'])
    window.close?.()
  })

  it('un seul hidden posté à la fois (FormData ne porte qu\'une seule valeur "size")', async () => {
    const { window, form } = await buildAndMount(HOST, ['radio'])
    const radios = Array.from(form.querySelectorAll('mjs-radio')) as any[]
    const natives = radios.map((r) => r._shadow.querySelector('input.native'))
    fireChange(window, natives[0], true)
    await new Promise((r) => setTimeout(r, 60))
    fireChange(window, natives[2], true)
    await new Promise((r) => setTimeout(r, 60))
    fireChange(window, natives[1], true)
    await new Promise((r) => setTimeout(r, 60))
    const fd = new window.FormData(form)
    assert.deepEqual(fd.getAll('size'), ['m'])
    window.close?.()
  })

  it('group (two-way) reflète la valeur sélectionnée côté parent', async () => {
    const HOST2 = [
      '<script>',
      '  $size = null',
      '</script>',
      '<form>',
      '  <@radio name="size" value="s" group=!{$size}>S</@radio>',
      '  <@radio name="size" value="m" group=!{$size}>M</@radio>',
      '</form>',
      '<p class="probe">{String($size)}</p>',
    ].join('\n')
    const { window, hote } = await buildAndMount(HOST2, ['radio'])
    const radios = Array.from(hote._shadow.querySelectorAll('mjs-radio')) as any[]
    assert.equal(hote._shadow.querySelector('.probe').textContent, 'null')
    fireChange(window, radios[1]._shadow.querySelector('input.native'), true)
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(hote._shadow.querySelector('.probe').textContent, 'm')
    window.close?.()
  })

  it('disabled : jamais coché ni posté, même en tentant de forcer le natif', async () => {
    const { window, form } = await buildAndMount(HOST, ['radio'])
    const radios = Array.from(form.querySelectorAll('mjs-radio')) as any[]
    const nativeXl = radios[3]._shadow.querySelector('input.native')
    assert.equal(nativeXl.disabled, true)
    fireChange(window, nativeXl, true)
    await new Promise((r) => setTimeout(r, 60))
    assertAbsent(radios[3].querySelector('input[type=hidden]'))
    window.close?.()
  })
})

describe('mjs-switch', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  const HOST = [
    '<form>',
    '  <@switch name="alerts" checked=!{$alerts}>Recevoir les alertes</@switch>',
    '  <@switch name="locked" checked=!{$locked} disabled={true}>Verrouillé</@switch>',
    '</form>',
  ].join('\n')

  it('build vert, tag <mjs-switch> réécrit dans le gabarit hôte', async () => {
    const root = mjsTmp('switch-build')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hote.mjs'), '<@switch name="a">Alertes</@switch>')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    assert.ok(stats.manifest['switch'])
  })

  it('role="switch" présent sur l\'input natif', async () => {
    const { hote } = await buildAndMount(HOST, ['switch'])
    const sw = hote._shadow.querySelector('mjs-switch')
    assert.equal(sw._shadow.querySelector('input.native').getAttribute('role'), 'switch')
  })

  it('bascule ON → hidden posé (name/value "on" par défaut) ; bascule OFF → hidden retiré', async () => {
    const { window, form } = await buildAndMount(HOST, ['switch'])
    const sw = form.querySelectorAll('mjs-switch')[0]
    const native = sw._shadow.querySelector('input.native')
    fireChange(window, native, true)
    await new Promise((r) => setTimeout(r, 50))
    const hidden = sw.querySelector('input[type=hidden]')
    assert.ok(hidden)
    assert.equal(hidden.name, 'alerts')
    assert.equal(hidden.value, 'on')
    fireChange(window, native, false)
    await new Promise((r) => setTimeout(r, 50))
    assertAbsent(sw.querySelector('input[type=hidden]'))
    window.close?.()
  })

  it('disabled : jamais de hidden même forcé', async () => {
    const { window, form } = await buildAndMount(HOST, ['switch'])
    const sw = form.querySelectorAll('mjs-switch')[1]
    const native = sw._shadow.querySelector('input.native')
    assert.equal(native.disabled, true)
    fireChange(window, native, true)
    await new Promise((r) => setTimeout(r, 50))
    assertAbsent(sw.querySelector('input[type=hidden]'))
    window.close?.()
  })
})
