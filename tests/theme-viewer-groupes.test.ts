// theme-viewer — la page est rangée PAR SOURCE (fichier · module · thème), pas par variable.
//
// Ce qui motive ce filet : tant que l'atelier listait une ligne par NOM, une variable déclarée
// deux fois (thème clair et thème sombre du même fichier) n'avait qu'une pastille, et
// l'enregistrement choisissait tout seul « la première déclaration non framework ». L'aperçu,
// lui, repeignait les deux. On voyait donc du rouge partout et une seule ligne changeait sur le
// disque — sans jamais dire laquelle.
//
// Ce que la suite tient :
//   1. une source = un groupe (les deux variantes d'un même fichier comptent pour deux) ;
//   2. une variable déclarée deux fois apparaît dans les DEUX groupes ;
//   3. la couleur choisie dans un groupe s'écrit dans LA ligne de ce groupe, jamais une autre.

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness } from '../src/testing/index.js'
import { mjsTmp } from './helpers/tmp.js'

const ICI    = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(ICI, '..', 'src', 'server', 'theme-viewer.mjs')

// `accent` est déclaré DEUX fois dans le même fichier de thème (clair ligne 4, sombre ligne 12) :
// c'est le cas qui piégeait l'atelier. `fond` n'est déclaré qu'une fois, par un module.
const REGISTRE = {
  accent: {
    declarations: [
      { value: '#3b82f6', declaredBy: 'app_theme', kind: 'theme', variant: '',     file: 'src/app.theme.mjs', line: 4,  doc: '' },
      { value: '#60a5fa', declaredBy: 'app_theme', kind: 'theme', variant: 'dark', file: 'src/app.theme.mjs', line: 12, doc: '' },
    ],
    readBy: ['carte'],
  },
  fond: {
    declarations: [
      { value: '#ffffff', declaredBy: 'carte', kind: 'module', variant: '', file: 'src/carte.mjs', line: 7, doc: '' },
    ],
    readBy: [],
  },
}

function projetTemporaire(): string {
  const root   = mjsTmp('theme-viewer-groupes')
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  copyFileSync(SOURCE, join(srcDir, 'tst-thgr-atelier.mjs'))
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js' }, null, 2))
  return root
}

describe('theme-viewer.mjs — l\'atelier est rangé par source, et l\'écriture suit la ligne affichée', function () {
  this.timeout(60000)

  let app: any
  let c: any
  let fetchOrigine: any
  const ecritures: any[] = []
  const apercus: any[]   = []

  const jsonOk = (v: any) => ({ json: async () => v })

  const faussaire = async (url: string, init?: any) => {
    if (url === '/__mjs/theme.json') return jsonOk(REGISTRE)
    if (url === '/__mjs/theme/edit') {
      if (init?.method === 'POST') apercus.push(JSON.parse(init.body))
      return jsonOk({ live: true, clients: 1 })
    }
    if (url === '/__mjs/theme/write') {
      const corps = JSON.parse(init.body)
      ecritures.push(corps)
      return jsonOk({ written: true, file: corps.file, line: corps.line })
    }
    throw new Error('URL inattendue : ' + url)
  }

  before(async () => {
    app = await createHarness({ root: projetTemporaire() })
    fetchOrigine = (globalThis as any).fetch
    ;(globalThis as any).fetch = faussaire
    app.window.fetch = faussaire
    c = await app.mount('tst-thgr-atelier')
    await c.tick()
    await c.tick()
  })

  after(async () => {
    ;(globalThis as any).fetch = fetchOrigine
    if (c) c.destroy()
    if (app) await app.destroy()
  })

  it('une source = un groupe — les deux variantes d\'un même fichier comptent pour deux', () => {
    const sources = c.findAll('.tete .source').map((n: any) => n.textContent)
    assert.deepEqual(sources, ['app_theme', 'app_theme', 'carte'],
      'les thèmes passent avant les modules, et la variante sombre a son propre groupe')
    assert.deepEqual(c.findAll('.tete .variante').map((n: any) => n.textContent), ['variante dark'])
  })

  it('une variable déclarée deux fois apparaît dans les DEUX groupes, avec sa valeur et sa ligne', () => {
    const groupes = c.findAll('.groupe')
    assert.equal(groupes.length, 3)
    const clair  = groupes[0].querySelectorAll('.variable')
    const sombre = groupes[1].querySelectorAll('.variable')
    assert.equal(clair.length, 1)
    assert.equal(sombre.length, 1)
    assert.equal(clair[0].querySelector('.nom').textContent, 'accent')
    assert.equal(sombre[0].querySelector('.nom').textContent, 'accent')
    assert.equal(clair[0].querySelector('.valeur').textContent, '#3b82f6')
    assert.equal(sombre[0].querySelector('.valeur').textContent, '#60a5fa')
    assert.equal(clair[0].querySelector('.emplacement').textContent, 'ligne 4')
    assert.equal(sombre[0].querySelector('.emplacement').textContent, 'ligne 12')
  })

  it('la couleur choisie dans le groupe sombre s\'écrit ligne 12 — pas ligne 4', async () => {
    // `checked=!{$write}` écoute « change » (generator/attributes) et lit `el.checked` : un clic
    // nu ne suffit pas sous happy-dom, on pose l'état PUIS on émet l'événement que le binding attend.
    c.find('.bascule input').checked = true
    await c.fire('.bascule input', 'change')
    assert.ok(c.find('.precision.ecrit'), 'l\'interrupteur « Enregistrer dans le source » doit être allumé')
    await c.type('.groupes section:nth-child(2) input.pastille', '#ff0000')
    assert.equal(ecritures.length, 1, 'un seul enregistrement, celui de la ligne touchée')
    assert.equal(ecritures[0].name, 'accent')
    assert.equal(ecritures[0].file, 'src/app.theme.mjs')
    assert.equal(ecritures[0].line, 12, 'la ligne écrite est celle du groupe affiché, pas la première déclaration du fichier')
    assert.equal(ecritures[0].value, '#ff0000')
    assert.deepEqual(apercus.at(-1), { vars: { accent: '#ff0000' } }, 'l\'aperçu reste global par nom — c\'est ce que le groupe annonce')
  })

  it('« Rétablir » vide bien les surcharges — `for … of` sur un objet ne les parcourait pas', async () => {
    // Avant : `for name of $edits` compilait en `for…of` sur un OBJET (TypeError au clic), le
    // bouton ne rétablissait rien. Le filet tient le comportement, pas la forme du code.
    await c.type('.groupes section:nth-child(3) input.pastille', '#00ff00')
    assert.match(c.find('.retablir-tout').textContent, /2 couleurs/)
    await c.click('.retablir-tout')
    assert.equal(c.find('.retablir-tout'), null, 'plus aucune surcharge : le bouton disparaît')
    assert.equal(c.findAll('.groupes section')[1].querySelector('.valeur').textContent, '#60a5fa',
      'la ligne est revenue à la valeur de son source')
  })
})
