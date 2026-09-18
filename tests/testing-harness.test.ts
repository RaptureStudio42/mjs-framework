// testing/index — le harnais de test des APPLICATIONS, testé avec un vrai projet.
//
// Ce fichier est l'exemple canonique en même temps que sa garde : il scaffolde un petit
// projet dans un dossier temporaire, le compile par le VRAI Bundler, et vérifie que
// chaque verbe du harnais fait ce que la doc promet. Si ce fichier passe, l'exemple du
// chapitre de doc passe aussi.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness } from '../src/testing/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COUNTER = [
  '<script>',
  '$start ?= 0',
  '$count = $start',
  '$double = $count * 2',
  '</script>',
  '',
  '<div class="counter">',
  '  <span class="value">{$count}</span>',
  '  <span class="double">{$double}</span>',
  '  <button class="plus" @click={$count++}>+</button>',
  '</div>',
].join('\n')

const GREETER = [
  '<script>',
  '$name ?= "monde"',
  '$greeting = "Bonjour, " + $name + " !"',
  '</script>',
  '',
  '<p class="hello">{$greeting}</p>',
  '<input class="champ" value=!{$name}>',
].join('\n')

const PARENT = [
  '<div class="parent">',
  '  <mjs-tst-counter start="7"></mjs-tst-counter>',
  '</div>',
].join('\n')

/** Scaffolde un projet minimal dans un dossier temporaire et rend sa racine. */
function projetTemporaire(): string {
  const root   = mjsTmp('testing')
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'tst-counter.mjs'), COUNTER)
  writeFileSync(join(srcDir, 'tst-greeter.mjs'), GREETER)
  writeFileSync(join(srcDir, 'tst-parent.mjs'), PARENT)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js' }, null, 2))
  return root
}

describe('testing/createHarness — le harnais de test des applications', function () {
  this.timeout(60000)

  let root: string
  let app: any

  before(async () => {
    root = projetTemporaire()
    app  = await createHarness({ root })
  })

  after(async () => {
    if (app) await app.destroy()
  })

  it('trouve les composants du projet compilé', () => {
    assert.deepEqual(app.components.sort(), ['tst-counter', 'tst-greeter', 'tst-parent'])
  })

  it('monte un composant et lit ce qu\'il affiche', async () => {
    const c = await app.mount('tst-counter')
    assert.equal(c.text('.value'), '0')
    assert.equal(c.text('.double'), '0')
    c.destroy()
  })

  it('les props passées au montage arrivent dans le composant', async () => {
    const c = await app.mount('tst-counter', { start: 3 })
    assert.equal(c.text('.value'), '3')
    assert.equal(c.text('.double'), '6')
    assert.equal(c.state.count, 3)
    c.destroy()
  })

  it('click() agit et attend le rendu', async () => {
    const c = await app.mount('tst-counter', { start: 3 })
    await c.click('.plus')
    assert.equal(c.text('.value'), '4')
    assert.equal(c.text('.double'), '8')
    assert.equal(c.state.count, 4)
    await c.click('.plus')
    assert.equal(c.text('.value'), '5')
    c.destroy()
  })

  it('type() remplit un champ et la liaison remonte', async () => {
    const c = await app.mount('tst-greeter')
    assert.equal(c.text('.hello'), 'Bonjour, monde !')
    await c.type('.champ', 'Ada')
    assert.equal(c.state.name, 'Ada')
    assert.equal(c.text('.hello'), 'Bonjour, Ada !')
    c.destroy()
  })

  it('set() change une prop depuis le parent', async () => {
    const c = await app.mount('tst-greeter')
    await c.set({ name: 'Ada' })
    assert.equal(c.text('.hello'), 'Bonjour, Ada !')
    c.destroy()
  })

  it('find/findAll/html donnent accès au rendu', async () => {
    const c = await app.mount('tst-counter', { start: 1 })
    assert.equal(c.find('.value').textContent, '1')
    assert.equal(c.findAll('span').length, 2)
    assert.match(c.html(), /class="counter"/)
    assert.equal(c.find('.inexistant'), null)
    c.destroy()
  })

  it('un composant imbriqué se monte tout seul : le harnais charge tout le projet', async () => {
    const p = await app.mount('tst-parent')
    const enfant = p.find('mjs-tst-counter')
    assert.ok(enfant, `le composant enfant doit être dans le rendu :\n${p.html()}`)
    await new Promise(r => setTimeout(r, 0))
    assert.equal(enfant._shadow.querySelector('.value').textContent, '7', 'et il doit avoir reçu sa prop')
    p.destroy()
  })

  it('un nom inconnu donne un message qui liste les noms connus', async () => {
    await assert.rejects(() => app.mount('nexiste-pas'), /nexiste-pas[\s\S]*tst-counter/)
  })

  it('un sélecteur qui ne correspond à rien le dit, avec le composant visé', async () => {
    const c = await app.mount('tst-counter')
    await assert.rejects(() => c.click('.nulle-part'), /\.nulle-part[\s\S]*mjs-tst-counter/)
    c.destroy()
  })

  it("l'option only ne charge que les composants nommés", async () => {
    const restreint = await createHarness({ root, only: ['tst-greeter'] })
    assert.deepEqual(restreint.components, ['tst-greeter'])
    await assert.rejects(() => restreint.mount('tst-counter'), /tst-counter/)
    await restreint.destroy()
  })
})
