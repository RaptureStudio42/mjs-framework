// `mjs-precache.json` : la liste des fichiers émis, avec leurs empreintes.
//
// Elle ne sert à rien au framework. Elle sert à l'auteur qui veut rendre son application
// installable : un service worker doit savoir quoi mettre en cache, et c'est le SEUL à
// ne pas pouvoir le deviner (les noms portent une empreinte qui change à chaque build).
// Nous, on la connaît. Le framework ne fournit AUCUN service worker pour autant : les
// stratégies de cache sont des choix d'application.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

function projet(prefix: string) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir, manifest: join(root, 'bundle.js') }
}

const lire = (outDir: string) => JSON.parse(readFileSync(join(outDir, 'mjs-precache.json'), 'utf-8'))

describe('bundler — mjs-precache.json', function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it('liste les URLs publiques de tout ce que le build a émis, et la version du build', async () => {
    const p = projet('precache')
    writeFileSync(join(p.srcDir, 'page.mjs'), '<p>bonjour</p>')
    writeFileSync(join(p.srcDir, 'autre.mjs'), '<p>autre</p>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const precache = lire(p.outDir)
    assert.match(precache.version, /^[a-f0-9]{8}$/, `la version doit être l'identifiant de build : ${precache.version}`)
    assert.equal(precache.version, bundler.lastBuildId, 'et c\'est exactement celui du manifeste')
    assert.ok(precache.assets.some((a: string) => /\/mjs_core-[a-f0-9]{8}\.js$/.test(a)), `le runtime doit y être :\n${precache.assets.join('\n')}`)
    assert.ok(precache.assets.some((a: string) => /\/page-[a-f0-9]{8}\.js$/.test(a)), 'les composants aussi')
    assert.ok(precache.assets.some((a: string) => /\/autre-[a-f0-9]{8}\.js$/.test(a)))
    assert.deepEqual(precache.assets, [...precache.assets].sort(), 'la liste doit être triée : un diff git ne doit pas bouger pour rien')

    await bundler.close()
  })

  it('un re-build sans changement ne réécrit pas le fichier', async () => {
    const p = projet('precache-stable')
    writeFileSync(join(p.srcDir, 'page.mjs'), '<p>bonjour</p>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    await bundler.compile()
    const avant = statSync(join(p.outDir, 'mjs-precache.json')).mtimeMs
    await new Promise(r => setTimeout(r, 20))
    await bundler.compile()
    assert.equal(statSync(join(p.outDir, 'mjs-precache.json')).mtimeMs, avant, 'même contenu = aucune réécriture')
    await bundler.close()
  })

  it("un build en ÉCHEC n'écrit pas de liste : mieux vaut pas de liste qu'une liste fausse", async () => {
    const p = projet('precache-echec')
    writeFileSync(join(p.srcDir, 'casse.mjs'), '<script>\n@import truc \'nexistepas.civet\'\n</script>\n<p>x</p>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'ce projet doit échouer')
    assert.equal(existsSync(join(p.outDir, 'mjs-precache.json')), false)
    await bundler.close()
  })
})
