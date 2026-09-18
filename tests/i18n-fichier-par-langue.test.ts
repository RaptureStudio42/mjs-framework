// i18n — UN FICHIER PAR LANGUE (`mjs_i18n-<langue>-<hash>.js`), manifeste allégé.
// Le manifeste ne garde que les RÉGLAGES (dev/default/placeholder/persist/detect/
// urlParam), la liste des langues sélectionnables (`langs`), le préfixe public des
// fragments de section (`prefix`) et l'URL du fichier de chaque langue (`files`) :
// dictionnaire racine et table des sections vivent dans le fichier de LEUR langue,
// téléchargé pour la seule langue affichée — le manifeste, lui, est servi sur CHAQUE
// page et ne bouge plus quand une traduction change.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

function mkProject(): { root: string; srcDir: string; outDir: string; manifestPath: string } {
  const root = mjsTmp('i18n-langfile')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir, manifestPath: join(root, 'bundle.js') }
}

// racine fr.yml + en.json, sections fr/panier.yml + en/panier.json (mêmes fixtures
// que tests/i18n-build.test.ts).
function seedI18nDict(srcDir: string): void {
  const i18nDir = join(srcDir, 'i18n')
  mkdirSync(join(i18nDir, 'fr'), { recursive: true })
  mkdirSync(join(i18nDir, 'en'), { recursive: true })
  writeFileSync(join(i18nDir, 'fr.yml'), 'bonjour: Bonjour\nau_revoir: Au revoir\n')
  writeFileSync(join(i18nDir, 'en.json'), JSON.stringify({ bonjour: 'Hello', au_revoir: 'Goodbye' }))
  writeFileSync(join(i18nDir, 'fr/panier.yml'), 'titre: Mon panier\nvide: Panier vide\n')
  writeFileSync(join(i18nDir, 'en/panier.json'), JSON.stringify({ titre: 'My cart', vide: 'Empty cart' }))
}

// Bloc `µ._i18nData = {...};` du manifeste éclaté (une seule ligne, cf. writeManifest).
function readI18nData(manifestPath: string): any {
  const content = readFileSync(manifestPath, 'utf-8')
  const m = content.match(/µ\._i18nData = (\{.*?\});/)
  return m ? JSON.parse(m[1]) : undefined
}

// Fichier de langue émis : module ES à export par défaut, corps JSON pur — lu sans
// moteur ESM (les tests tournent en Node, l'URL est publique, pas un chemin disque).
function readLangFile(outDir: string, url: string): any {
  const src = readFileSync(join(outDir, url.split('/').pop()!), 'utf-8')
  const m = src.match(/^export default ([\s\S]*);\n?$/)
  assert.ok(m, `forme inattendue du fichier de langue : ${src.slice(0, 120)}`)
  return JSON.parse(m![1])
}

describe('i18n — un fichier par langue, manifeste allégé', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('deux langues ⇒ deux fichiers `mjs_i18n-<langue>-<hash>.js`, manifeste sans `root` ni `sections`', async () => {
    const { srcDir, outDir, manifestPath } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath, i18n: { default: 'fr' } })
    try {
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

      const emis = readdirSync(outDir).filter(f => /^mjs_i18n-[a-z]+-[a-f0-9]{8}\.js$/.test(f)).sort()
      assert.deepEqual(emis.map(f => f.slice(0, 11)), ['mjs_i18n-en', 'mjs_i18n-fr'], `fichiers émis : ${emis.join(', ')}`)

      const data = readI18nData(manifestPath)
      assert.ok(data, 'µ._i18nData doit rester émis dans le manifeste')
      assert.equal(data.root, undefined, 'les dictionnaires racine ne sont plus dans le manifeste')
      assert.equal(data.sections, undefined, 'la table des sections n\'est plus dans le manifeste')
      assert.deepEqual(data.langs, ['en', 'fr'], 'langues sélectionnables, triées')
      assert.deepEqual(Object.keys(data.files).sort(), ['en', 'fr'])
      assert.match(data.files.fr, /\/mjs_i18n-fr-[a-f0-9]{8}\.js$/)
      assert.match(data.files.en, /\/mjs_i18n-en-[a-f0-9]{8}\.js$/)
      assert.equal(data.default, 'fr')
      assert.equal(data.dev, true)

      const manifeste = readFileSync(manifestPath, 'utf-8')
      assert.equal(manifeste.includes('Au revoir'), false, 'aucune traduction en clair dans le manifeste')
      assert.equal(manifeste.includes('Goodbye'), false, 'aucune traduction en clair dans le manifeste')
    } finally {
      await bundler.close()
    }
  })

  it('le fichier d\'une langue ne porte QUE sa langue : racine + table de sections compacte', async () => {
    const { srcDir, outDir, manifestPath } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath, i18n: { default: 'fr' } })
    try {
      await bundler.compile()
      const data = readI18nData(manifestPath)
      const fr = readLangFile(outDir, data.files.fr)
      const en = readLangFile(outDir, data.files.en)

      assert.deepEqual(fr.root, { bonjour: 'Bonjour', au_revoir: 'Au revoir' })
      assert.deepEqual(en.root, { bonjour: 'Hello', au_revoir: 'Goodbye' })
      // valeur COMPACTE : le seul nom du fragment, l'URL se reconstitue
      // `prefix + '/' + langue + '/' + valeur + '.json'` (dev : nom clair).
      assert.deepEqual(fr.sections, { panier: 'panier' })
      assert.deepEqual(en.sections, { panier: 'panier' })
      assert.match(data.prefix, /\/i18n$/)

      const url = data.prefix + '/fr/' + fr.sections.panier + '.json'
      assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'i18n', 'fr', 'panier.json'), 'utf-8')), { titre: 'Mon panier', vide: 'Panier vide' })
      assert.match(url, /\/i18n\/fr\/panier\.json$/)

      const srcFr = readFileSync(join(outDir, data.files.fr.split('/').pop()!), 'utf-8')
      assert.equal(srcFr.includes('Hello'), false, 'le fichier fr ne porte aucune traduction anglaise')
    } finally {
      await bundler.close()
    }
  })

  it('prod : nom de fragment haché, valeur compacte = le hash seul', async () => {
    const { srcDir, outDir, manifestPath } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath, i18n: { default: 'fr' }, forceMinify: true })
    try {
      await bundler.compile()
      const data = readI18nData(manifestPath)
      const fr = readLangFile(outDir, data.files.fr)
      assert.match(fr.sections.panier, /^[a-f0-9]{32}$/, `hash seul attendu, reçu : ${fr.sections.panier}`)
      assert.equal(data.dev, false)
    } finally {
      await bundler.close()
    }
  })

  it('trois constructions de suite : mêmes noms de fichiers de langue (hash du contenu)', async () => {
    const { srcDir, outDir, manifestPath } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath, i18n: { default: 'fr' }, forceMinify: true })
    try {
      const vus: string[] = []
      for (let i = 0; i < 3; i++) {
        await bundler.compile()
        const data = readI18nData(manifestPath)
        vus.push(data.files.fr + '|' + data.files.en)
      }
      assert.equal(vus[1], vus[0], 'même contenu ⇒ même hash ⇒ même nom (cache navigateur préservé)')
      assert.equal(vus[2], vus[0], 'déterminisme sur trois constructions')
    } finally {
      await bundler.close()
    }
  })

  it('une traduction modifiée ne change QUE le fichier de SA langue', async () => {
    const { srcDir, outDir, manifestPath } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath, i18n: { default: 'fr' }, forceMinify: true })
    try {
      await bundler.compile()
      const avant = readI18nData(manifestPath)
      writeFileSync(join(srcDir, 'i18n/fr.yml'), 'bonjour: Salut\nau_revoir: Au revoir\n')
      await bundler.compile()
      const apres = readI18nData(manifestPath)
      assert.notEqual(apres.files.fr, avant.files.fr, 'texte français modifié ⇒ nouveau fichier fr')
      assert.equal(apres.files.en, avant.files.en, 'fichier anglais inchangé')
    } finally {
      await bundler.close()
    }
  })

  it("js: 'bundle' : mêmes fichiers de langue à part, aucune traduction dans le fichier unique", async () => {
    const { srcDir, outDir, manifestPath } = mkProject()
    seedI18nDict(srcDir)
    writeFileSync(join(srcDir, 'app.mjs'), '<div>x</div>\n')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath, i18n: { default: 'fr' }, js: 'bundle' })
    try {
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const emis = readdirSync(outDir).filter(f => /^mjs_i18n-[a-z]+-[a-f0-9]{8}\.js$/.test(f)).sort()
      assert.deepEqual(emis.map(f => f.slice(0, 11)), ['mjs_i18n-en', 'mjs_i18n-fr'], `fichiers émis : ${emis.join(', ')}`)
      const manifeste = readFileSync(manifestPath, 'utf-8')
      assert.equal(manifeste.includes('Au revoir'), false, 'aucune traduction en clair dans le fichier unique')
      assert.equal(manifeste.includes('"langs"') || manifeste.includes('langs:'), true, 'la liste des langues reste dans le fichier unique')
    } finally {
      await bundler.close()
    }
  })
})
