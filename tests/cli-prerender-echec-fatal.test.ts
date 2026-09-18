// `mjs build` sortait en code 0 quand une page de `render.routes`
// échouait à se prérendre (échec de RENDU par page, rangé dans report.skipped, jamais remonté
// par cli.ts) : un `render.routes` qui pointe vers un composant introuvable (typo la plus banale)
// reproduisait EXACTEMENT un incident réel que le fix voisin (échec de
// COMPILATION globale) ne couvrait pas. Test via un VRAI SOUS-PROCESSUS (même motif que
// cli-build-prerender-overrides.test.ts : cli.ts exécute `run(process.argv)` inconditionnellement
// à son top-level, l'importer directement serait dangereux).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function fixtureProject(): string {
  const root = mjsTmp('cli-prerender-echec-fatal')
  mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
  writeFileSync(join(root, 'app', 'modularjs', 'home.mjs'), `<h1>Accueil</h1>`)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs',
    outputDir: 'public/modularjs',
    render: {
      default: 'prerender',
      routes: {
        '/':      { component: 'mjs-home' },        // existe : doit rester écrite
        '/oops':  { component: 'mjs-nexistepas' },   // n'existe pas : le rendu doit échouer
      },
    },
  }, null, 2))
  return root
}

describe("cli.ts — 'mjs build' : une page render.routes en échec de RENDU fait échouer le build", function () {
  this.timeout(40000)

  it('code de sortie ≠ 0, la page en échec est absente, la page saine reste écrite', () => {
    const projectRoot = fixtureProject()

    const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--root', projectRoot], {
      cwd: repoRoot, encoding: 'utf-8',
    })

    assert.notEqual(result.status, 0, `AVANT le fix : code 0 malgré une page DÉCLARÉE en échec de rendu.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(result.stdout + result.stderr, /oops/, 'le message doit nommer la route en échec')

    const pageEchec = join(projectRoot, 'public', 'mjs_pages', 'oops.html')
    assert.ok(!existsSync(pageEchec), 'la page en échec ne doit jamais être écrite/laissée sur disque')

    const pageSaine = join(projectRoot, 'public', 'mjs_pages', 'index.html')
    assert.ok(existsSync(pageSaine), 'une route SAINE à côté doit toujours être écrite, malgré l\'échec de sa voisine')
  })

  it('non-régression : sans route en échec, le build reste vert (code 0)', () => {
    const root = mjsTmp('cli-prerender-echec-fatal-ok')
    mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
    writeFileSync(join(root, 'app', 'modularjs', 'home.mjs'), `<h1>Accueil</h1>`)
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      sourceDir: 'app/modularjs',
      outputDir: 'public/modularjs',
      render: { default: 'prerender', routes: { '/': { component: 'mjs-home' } } },
    }, null, 2))

    const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--root', root], {
      cwd: repoRoot, encoding: 'utf-8',
    })
    assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
    assert.ok(existsSync(join(root, 'public', 'mjs_pages', 'index.html')))
  })
})
