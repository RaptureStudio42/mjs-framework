// i18n — un composant peut porter le nom d'une langue sans disparaître.
//
// Le fichier de langue s'écrivait `i18n-<langue>-<hash>.js` : un composant `i18n-fr.mjs`
// partageait alors la MÊME unité de sortie (même base, même extension), et la purge des
// anciennes empreintes d'une unité (cleanupOldHashes) supprimait le composant compilé —
// 0 erreur, 0 avertissement, manifeste pointant dans le vide, composant jamais monté.
// Les sorties du framework portent le préfixe `mjs_` (`mjs_core`, `mjs_styles`, `mjs_anims`),
// hors d'atteinte d'un nom de composant : minuscules, chiffres et tirets seulement, jamais
// de souligné (cf. le refus nommé exercé plus bas).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHarness } from '../src/testing/index.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPOSANT = [
  '<script>',
  '$drapeau ?= "FR"',
  '</script>',
  '',
  '<p class="drapeau">{$drapeau}</p>',
].join('\n')

/** Projet minimal : un composant nommé comme une langue + dictionnaires fr/en. */
function projetTemporaire(prefix: string, nomComposant: string): string {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(join(srcDir, 'i18n'), { recursive: true })
  writeFileSync(join(srcDir, `${nomComposant}.mjs`), COMPOSANT)
  writeFileSync(join(srcDir, 'i18n/fr.yml'), 'bonjour: Bonjour\n')
  writeFileSync(join(srcDir, 'i18n/en.json'), JSON.stringify({ bonjour: 'Hello' }))
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', i18n: { default: 'fr' } }, null, 2))
  return root
}

/** Table des chemins du manifeste (valeurs compactes : préfixe factorisé, cf. µ.pathsPrefix). */
function cheminsDuManifeste(manifestPath: string): Record<string, string> {
  const m = readFileSync(manifestPath, 'utf-8').match(/const µPaths = (\{.*?\});/)
  assert.ok(m, 'µPaths introuvable dans le manifeste')
  return JSON.parse(m![1])
}

/** URLs des fichiers de langue publiées par le manifeste (`µ._i18nData.files`). */
function fichiersDeLangue(manifestPath: string): Record<string, string> {
  const m = readFileSync(manifestPath, 'utf-8').match(/µ\._i18nData = (\{.*?\});/)
  assert.ok(m, 'µ._i18nData introuvable dans le manifeste')
  return JSON.parse(m![1]).files ?? {}
}

describe('i18n — collision de nom entre un composant et le fichier d\'une langue', function () {
  this.timeout(60000)

  let root: string
  let app: any

  before(async () => {
    root = projetTemporaire('i18n-collision', 'i18n-fr')
    app  = await createHarness({ root })
  })

  after(async () => {
    if (app) await app.destroy()
    await terminateSharedWorkerPool()
  })

  it('le composant `i18n-fr.mjs` survit à la construction : fichier compilé présent, manifeste juste', () => {
    const chemins  = cheminsDuManifeste(join(root, 'out/bundle.js'))
    const publie   = chemins['i18n-fr']
    assert.ok(publie, `le manifeste doit publier le composant : ${Object.keys(chemins).join(', ')}`)
    const surDisque = join(root, 'out', basename(publie))
    assert.equal(existsSync(surDisque), true, `le fichier compilé du composant doit rester sur disque : ${basename(publie)}`)
  })

  it('la page le monte et affiche son contenu', async () => {
    const c = await app.mount('i18n-fr')
    assert.equal(c.text('.drapeau'), 'FR')
    c.destroy()
  })

  it('les fichiers de langue sont émis à côté, chacun sur son propre nom', () => {
    const fichiers = fichiersDeLangue(join(root, 'out/bundle.js'))
    assert.deepEqual(Object.keys(fichiers).sort(), ['en', 'fr'])
    for (const [lang, url] of Object.entries(fichiers)) {
      assert.equal(existsSync(join(root, 'out', basename(url))), true, `fichier de langue ${lang} absent du dossier de sortie : ${url}`)
    }
    const chemins = cheminsDuManifeste(join(root, 'out/bundle.js'))
    assert.notEqual(basename(fichiers.fr), basename(chemins['i18n-fr']), 'le fichier de langue et le composant ne doivent jamais être le même fichier')
  })

  it('un composant ne peut PAS porter le nom d\'une sortie du framework (`mjs_i18n-fr.mjs` refusé)', async () => {
    const racine  = projetTemporaire('i18n-collision-mjs', 'mjs_i18n-fr')
    const bundler = new Bundler({ sourceDir: join(racine, 'src'), outputDir: join(racine, 'out'), manifestPath: join(racine, 'out/bundle.js'), i18n: { default: 'fr' } })
    try {
      const stats = await bundler.compile()
      const msg = stats.errors.map(e => e.message).join('\n')
      assert.ok(stats.errors.length > 0, 'un souligné dans un nom de composant doit être refusé au build')
      assert.match(msg, /mjs_i18n-fr\.mjs/, `l'erreur doit nommer le fichier fautif : ${msg}`)
      assert.equal(stats.manifest['mjs_i18n-fr'], undefined, 'aucune clé de manifeste pour un nom refusé')
    } finally {
      await bundler.close()
    }
  })
})
