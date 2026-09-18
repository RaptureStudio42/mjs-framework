// Contrôle d'empreinte des traductions — `i18n.source` opt-in. Le dictionnaire de la
// langue source fait foi ; une traduction dont le sceau `__source` ne correspond plus à
// l'empreinte de sa source n'est ni émise ni servie (cf. docs/29-i18n.md § Contrôle d'empreinte).
//
// Couvre : sceau juste (émis, `__source` retiré) · sceau périmé (absent du manifeste + warning) ·
// sceau absent (idem) · source introuvable (idem) · empreinte stable YAML/JSON · empreinte
// inchangée après réordonnancement des clés · `i18n.source` absent = comportement inchangé.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

function mkProject(): { root: string; srcDir: string; outDir: string } {
  const root = mjsTmp('i18n-empreinte')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir }
}

// même mécanique que `Bundler.fingerprintI18n` (canonicalisation clés triées + md5 12 hex) —
// recalculée ICI de façon indépendante, pour ne jamais valider le code sous test avec lui-même.
function canonical(v: any): any {
  if (Array.isArray(v)) return v.map(canonical)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, any> = {}
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k])
    return out
  }
  return v
}
function fingerprint(data: any): string {
  return createHash('md5').update(JSON.stringify(canonical(data))).digest('hex').slice(0, 12)
}

describe('i18n — contrôle d\'empreinte (i18n.source)', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  it('sceau juste → dictionnaire racine émis, __source absent des données', () => {
    const { srcDir, outDir } = mkProject()
    const i18nDir = join(srcDir, 'i18n')
    mkdirSync(i18nDir, { recursive: true })
    const frData = { bonjour: 'Bonjour', au_revoir: 'Au revoir' }
    writeFileSync(join(i18nDir, 'fr.yml'), `bonjour: Bonjour\nau_revoir: Au revoir\n`)
    const seal = fingerprint(frData)
    writeFileSync(join(i18nDir, 'en.json'), JSON.stringify({ __source: seal, bonjour: 'Hello', au_revoir: 'Goodbye' }))
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, i18n: { default: 'fr', source: 'fr' } })
    const { warnings } = bundler.scanI18n()
    assert.equal(warnings.length, 0, warnings.join('\n'))
    const data = bundler.i18nManifestData!
    assert.deepEqual(data.root.en, { bonjour: 'Hello', au_revoir: 'Goodbye' })
    assert.equal(Object.prototype.hasOwnProperty.call(data.root.en, '__source'), false)
  })

  it('sceau périmé → dictionnaire absent du manifeste + avertissement', () => {
    const { srcDir, outDir } = mkProject()
    const i18nDir = join(srcDir, 'i18n')
    mkdirSync(i18nDir, { recursive: true })
    writeFileSync(join(i18nDir, 'fr.yml'), `bonjour: Bonjour\n`)
    writeFileSync(join(i18nDir, 'en.json'), JSON.stringify({ __source: 'deadbeefcafe', bonjour: 'Hello' }))
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, i18n: { default: 'fr', source: 'fr' } })
    const { warnings } = bundler.scanI18n()
    assert.equal(Object.prototype.hasOwnProperty.call(bundler.i18nManifestData!.root, 'en'), false)
    assert.ok(warnings.some(w => /en\.json.*périmé/.test(w)), warnings.join('\n'))
  })

  it('sceau absent → dictionnaire absent du manifeste + avertissement', () => {
    const { srcDir, outDir } = mkProject()
    const i18nDir = join(srcDir, 'i18n')
    mkdirSync(i18nDir, { recursive: true })
    writeFileSync(join(i18nDir, 'fr.yml'), `bonjour: Bonjour\n`)
    writeFileSync(join(i18nDir, 'en.json'), JSON.stringify({ bonjour: 'Hello' }))
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, i18n: { default: 'fr', source: 'fr' } })
    const { warnings } = bundler.scanI18n()
    assert.equal(Object.prototype.hasOwnProperty.call(bundler.i18nManifestData!.root, 'en'), false)
    assert.ok(warnings.some(w => /en\.json.*absent/.test(w)), warnings.join('\n'))
  })

  it('source introuvable (fragment de section sans pendant source) → rejeté + avertissement', () => {
    const { srcDir, outDir } = mkProject()
    const i18nDir = join(srcDir, 'i18n')
    mkdirSync(join(i18nDir, 'fr'), { recursive: true })
    mkdirSync(join(i18nDir, 'en'), { recursive: true })
    writeFileSync(join(i18nDir, 'fr.yml'), `bonjour: Bonjour\n`)
    // section 'panier' EXISTE en anglais mais PAS en français (source)
    writeFileSync(join(i18nDir, 'en/panier.json'), JSON.stringify({ __source: 'whatever000000', titre: 'Cart' }))
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, i18n: { default: 'fr', source: 'fr' } })
    const { warnings } = bundler.scanI18n()
    const data = bundler.i18nManifestData!
    assert.equal(data.sections.en?.panier, undefined)
    assert.ok(warnings.some(w => /panier.*aucune source/.test(w)), warnings.join('\n'))
  })

  it('empreinte STABLE entre une source YAML et la même source en JSON', () => {
    const { srcDir: srcDirYaml, outDir: outDirYaml } = mkProject()
    mkdirSync(join(srcDirYaml, 'i18n'), { recursive: true })
    writeFileSync(join(srcDirYaml, 'i18n/fr.yml'), `bonjour: Bonjour\nau_revoir: Au revoir\n`)
    const bundlerYaml = new Bundler({ sourceDir: srcDirYaml, outputDir: outDirYaml, i18n: { default: 'fr', source: 'fr' } })
    bundlerYaml.scanI18n()
    const fpYaml = (bundlerYaml as any).fingerprintI18n(bundlerYaml.i18nManifestData!.root.fr)

    const { srcDir: srcDirJson, outDir: outDirJson } = mkProject()
    mkdirSync(join(srcDirJson, 'i18n'), { recursive: true })
    writeFileSync(join(srcDirJson, 'i18n/fr.json'), JSON.stringify({ bonjour: 'Bonjour', au_revoir: 'Au revoir' }))
    const bundlerJson = new Bundler({ sourceDir: srcDirJson, outputDir: outDirJson, i18n: { default: 'fr', source: 'fr' } })
    bundlerJson.scanI18n()
    const fpJson = (bundlerJson as any).fingerprintI18n(bundlerJson.i18nManifestData!.root.fr)

    assert.equal(fpYaml, fpJson)
  })

  it('empreinte INCHANGÉE après réordonnancement des clés', () => {
    const dataA = { bonjour: 'Bonjour', au_revoir: 'Au revoir', nav: { fermer: 'Fermer', ouvrir: 'Ouvrir' } }
    const dataB = { nav: { ouvrir: 'Ouvrir', fermer: 'Fermer' }, au_revoir: 'Au revoir', bonjour: 'Bonjour' }
    assert.equal(fingerprint(dataA), fingerprint(dataB))
  })

  it('i18n.source absent de la config → comportement d\'aujourd\'hui strictement inchangé', () => {
    const { srcDir, outDir } = mkProject()
    const i18nDir = join(srcDir, 'i18n')
    mkdirSync(i18nDir, { recursive: true })
    writeFileSync(join(i18nDir, 'fr.yml'), `bonjour: Bonjour\n`)
    // un __source traîne dans le fichier (aucune raison de le voir traité — pas de contrôle actif)
    writeFileSync(join(i18nDir, 'en.json'), JSON.stringify({ __source: 'peu-importe', bonjour: 'Hello' }))
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, i18n: { default: 'fr' } })
    const { warnings } = bundler.scanI18n()
    assert.equal(warnings.length, 0, warnings.join('\n'))
    const data = bundler.i18nManifestData!
    assert.deepEqual(data.root.en, { __source: 'peu-importe', bonjour: 'Hello' })
  })
})
