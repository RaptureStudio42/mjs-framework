// Test de régression : `mjs build` purge les orphelins
// d'outputDir après un build sans erreur (Bundler.pruneOrphans), bout en bout via le CLI réel.
// Sous-processus réels, même motif que cli-build-garde-racine.test.ts : cli.ts appelle
// `run(process.argv)` à son top-level, l'importer lancerait une vraie CLI.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function build(root: string) {
  const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--root', root], {
    cwd: repoRoot, encoding: 'utf-8', timeout: 120000,
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('cli.ts — `mjs build` purge les orphelins d\'outputDir', function () {
  this.timeout(120000)

  it('un composant supprimé laisse un orphelin retiré au build SUIVANT et listé sur stdout ; "prune": false le laisse en place', () => {
    const root = mjsTmp('cli-purge')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js' }))
    writeFileSync(join(root, 'src', 'a.mjs'), '<p>a</p>\n')
    writeFileSync(join(root, 'src', 'b.mjs'), '<p>b</p>\n')

    const build1 = build(root)
    assert.equal(build1.code, 0, build1.stderr)
    assert.doesNotMatch(build1.stdout, /🧹/, 'un 1er build (rien à purger) ne doit rien annoncer')

    const avant = readdirSync(join(root, 'out'))
    const bJs = avant.find(f => /^b-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(bJs, `attendu un b-<hash>.js après le 1er build, trouvé : ${avant.join(', ')}`)

    // renommage : b disparaît — le sinistre mesuré en production
    unlinkSync(join(root, 'src', 'b.mjs'))

    const build2 = build(root)
    assert.equal(build2.code, 0, build2.stderr)
    assert.match(build2.stdout, /🧹 /, 'le 2e build doit annoncer la purge')
    assert.match(build2.stdout, /b-/, 'le 2e build doit nommer le fichier b orphelin')

    const apres = readdirSync(join(root, 'out'))
    assert.ok(!apres.includes(bJs!), 'le b-*.js orphelin doit avoir disparu')
    assert.ok(apres.some(f => /^a-[a-f0-9]{8}\.js$/.test(f)), 'a doit survivre')
    assert.ok(apres.includes('bundle.js'), 'le manifeste doit survivre')

    // "prune": false désactive la purge
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', prune: false }))
    writeFileSync(join(root, 'out', 'zombie-0123abcd.js'), 'export {}\n')

    const build3 = build(root)
    assert.equal(build3.code, 0, build3.stderr)
    assert.doesNotMatch(build3.stdout, /🧹/, '"prune": false doit désactiver la purge')
    assert.ok(existsSync(join(root, 'out', 'zombie-0123abcd.js')), 'le zombie doit survivre avec "prune": false')
  })

  it('manifestPath collisionnant avec la famille hachée (`out/app-a1b2c3d4.js`) : le manifeste survit, aucune ligne 🧹', () => {
    const root = mjsTmp('cli-purge-manifest-collision')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/app-a1b2c3d4.js' }))
    writeFileSync(join(root, 'src', 'a.mjs'), '<p>a</p>\n')

    const build1 = build(root)
    assert.equal(build1.code, 0, build1.stderr)
    assert.doesNotMatch(build1.stdout, /🧹/, "le manifeste ne doit JAMAIS être annoncé comme orphelin, même s'il matche la famille hachée")
    assert.ok(existsSync(join(root, 'out', 'app-a1b2c3d4.js')), "le manifeste doit survivre au build qui vient de l'écrire")
  })
})
