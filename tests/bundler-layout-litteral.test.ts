// `layout="x"`/`template="x"` LITTÉRAL dont le nom n'est pas
// un variant <style name="…"> déclaré par le module ciblé : erreur de compilation
// (jumeau du mécanisme TagRef existant — cf. bundler-tag-shortcut.test.ts, dont ce
// fichier reprend le patron `buildProject`). `layout={expr}` dynamique reste hors périmètre
// (non vérifiable au build, message runtime déjà en place côté mjs_element.ts).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join, dirname } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

async function buildProject(files: Record<string, string>, extraOpts: any = {}): Promise<{ root: string; srcDir: string; outDir: string; stats: any }> {
  const root = mjsTmp('layoutlitteral')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const full = join(srcDir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), ...extraOpts })
  const stats = await bundler.compile()
  return { root, srcDir, outDir, stats }
}

function messages(stats: any): string {
  return stats.errors.map((e: any) => e.message).join('\n')
}

const CARD_WITH_BANNER = ['<style name="banner">', '  :host', '    display: flex', '</style>', '<div>x</div>'].join('\n')

describe('bundler — layout="x" littéral inconnu de sa cible → erreur de compilation', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('<mjs-card layout="tybo"> alors que card ne déclare que "banner" → build échoue, message cite tybo et banner', async () => {
    const { stats } = await buildProject({
      'hote.mjs': '<div><mjs-card layout="tybo"></mjs-card></div>',
      'card.mjs': CARD_WITH_BANNER,
    })
    assert.ok(stats.errors.length > 0, 'le build doit échouer')
    const msg = messages(stats)
    assert.match(msg, /tybo/)
    assert.match(msg, /banner/)
  })

  it('<mjs-card layout="banner"> — variant déclaré → build vert', async () => {
    const { stats } = await buildProject({
      'hote.mjs': '<div><mjs-card layout="banner"></mjs-card></div>',
      'card.mjs': CARD_WITH_BANNER,
    })
    assert.equal(stats.errors.length, 0, messages(stats))
  })

  it('template="tybo" (forme dépréciée, synonyme de layout=) → même croisement, même erreur', async () => {
    const { stats } = await buildProject({
      'hote.mjs': '<div><mjs-card template="tybo"></mjs-card></div>',
      'card.mjs': CARD_WITH_BANNER,
    })
    assert.ok(stats.errors.length > 0, 'le build doit échouer')
    const msg = messages(stats)
    assert.match(msg, /tybo/)
    assert.match(msg, /banner/)
  })

  it('layout={$x} dynamique — non vérifiable au build (accolade), build vert même si $x vaut "tybo" à l\'exécution', async () => {
    const { stats } = await buildProject({
      'hote.mjs': ['<script>', "$x = 'tybo'", '</script>', '<div><mjs-card layout={$x}></mjs-card></div>'].join('\n'),
      'card.mjs': CARD_WITH_BANNER,
    })
    assert.equal(stats.errors.length, 0, messages(stats))
  })

  it('composant SANS aucun variant + layout="quelquechose" → repli historique préservé, build vert', async () => {
    const { stats } = await buildProject({
      'hote.mjs': '<div><mjs-simple layout="quelquechose"></mjs-simple></div>',
      'simple.mjs': '<div>x</div>',
    })
    assert.equal(stats.errors.length, 0, messages(stats))
  })

  it('ordre indifférent : la page (aaa-) compile AVANT le composant (zzz-) qui la déclare — l\'erreur sort quand même', async () => {
    const { stats } = await buildProject({
      'aaa-hote.mjs': '<div><mjs-zzz-carte layout="tybo"></mjs-zzz-carte></div>',
      'zzz-carte.mjs': CARD_WITH_BANNER,
    })
    assert.ok(stats.errors.length > 0, 'le build doit échouer malgré l\'ordre alphabétique (page avant composant)')
    const msg = messages(stats)
    assert.match(msg, /tybo/)
    assert.match(msg, /banner/)
  })

  it('ordre indifférent (répli vert) : la page (aaa-) compile AVANT le composant (zzz-), nom connu → reste vert', async () => {
    const { stats } = await buildProject({
      'aaa-hote.mjs': '<div><mjs-zzz-carte layout="banner"></mjs-zzz-carte></div>',
      'zzz-carte.mjs': CARD_WITH_BANNER,
    })
    assert.equal(stats.errors.length, 0, messages(stats))
  })
})
