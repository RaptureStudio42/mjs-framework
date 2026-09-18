// Dossier de travail du rendu serveur (`mjs-render-*`, cf. server/render-compile-dir.ts) — il est
// créé sous `$TMPDIR` dès que le projet émet un FICHIER UNIQUE (`js: 'bundle'`), et il doit
// disparaître dans TOUS les cas :
//   · `mjs serve` interrompu (Ctrl-C) : sans arrêt propre, la fermeture du serveur de rendu — donc
//     celle du renderer, donc le retrait du dossier — n'était jamais atteinte, un dossier restant
//     par session ;
//   · création du renderer qui LÈVE après la compilation (cycle d'imports non ordonnable, happy-dom
//     absent) : ces sorties refermaient le bundler et laissaient le dossier derrière elles.
//
// Les deux chemins d'erreur sont sondés par SABOTAGE (même patron que csp-ssr.test.ts) : un cycle
// réel est structurellement impossible à construire (la compilation le refuse avant le rendu) et
// happy-dom est installé ici — seul un patch de la source au point EXACT de la garde les atteint.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const COMPOSANT = '<script lang="coffee">\n$titre = "Accueil"\n</script>\n<h1 class="t">{$titre}</h1>\n'

/** Projet fixture à fichier unique, avec une route rendue PAR REQUÊTE (le renderer est paresseux). */
function fixtureProject(prefix: string): string {
  const root = mjsTmp(prefix)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'app-home.mjs'), COMPOSANT)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src', outputDir: 'dist', manifestPath: 'dist/bundle.js', urlPrefix: '/dist', runtime: 'core', js: 'bundle',
    render: { default: 'ssr', engine: { request: 'happy-dom' }, routes: { '/': { component: 'mjs-app-home' } } },
  }, null, 2))
  return root
}

/** Un port libre, relâché juste avant d'être passé au sous-processus (`mjs dev` n'annonce que le
 *  port DEMANDÉ, jamais celui que le système lui a donné sur `--port 0`). */
async function portLibre(): Promise<number> {
  const sonde = createServer()
  await new Promise<void>(resolve => sonde.listen(0, '127.0.0.1', () => resolve()))
  const port = (sonde.address() as any).port
  await new Promise<void>(resolve => sonde.close(() => resolve()))
  return port
}

/** Dossiers de travail du rendu présents dans `dir`. */
function ateliers(dir: string): string[] {
  return readdirSync(dir).filter(f => f.startsWith('mjs-render-'))
}

/**
 * Charge une copie SABOTÉE de renderToString.ts (patch appliqué au point de garde), crée un
 * renderer sur un projet à fichier unique, et rend l'erreur levée. La copie vit dans `src/server/`
 * pour que ses imports relatifs résolvent, et part dans le `finally`.
 */
async function creerRendererSabote(root: string, patch: (src: string) => string): Promise<unknown> {
  const serverDir = new URL('../src/server/', import.meta.url)
  const original  = readFileSync(new URL('renderToString.ts', serverDir), 'utf-8')
  const patched   = patch(original)
  assert.notEqual(patched, original, 'le patch doit réellement modifier la source (sinon le sabotage est un no-op)')
  const nom  = `renderToString.__sabotage_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`
  const path = new URL(nom, serverDir)
  writeFileSync(path, patched)
  try {
    const mod: any = await import(path.href)
    const renderer = await mod.createSSRRenderer({ sourceDir: join(root, 'src'), outputDir: join(root, 'dist'), bundlerOpts: { js: 'bundle' } })
    await renderer.close()
    return null
  } catch (e) {
    return e
  } finally {
    unlinkSync(path)
  }
}

describe('dossier de travail du rendu — jamais laissé derrière', function () {
  this.timeout(120000)

  after(async () => { await terminateSharedWorkerPool() })

  it('`mjs serve` interrompu par SIGINT : aucun dossier de travail ne survit à la session', async () => {
    const root = fixtureProject('serve-atelier')
    const tmp  = mjsTmp('serve-tmp')
    // `tsx` lancé DIRECTEMENT (pas `npx tsx`) : le process qu'on signale doit être CELUI qui exécute
    // `mjs serve` — passé par `npx`, le signal s'arrêterait à lui, et son code de sortie serait le
    // sien, pas celui du serveur.
    const enfant = spawn(join(repoRoot, 'node_modules', '.bin', 'tsx'), ['src/cli.ts', 'serve', '--root', root, '--port', '0'], {
      cwd: repoRoot, env: { ...process.env, TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let sortie = ''
    enfant.stdout.on('data', (d: Buffer) => { sortie += d.toString() })
    enfant.stderr.on('data', (d: Buffer) => { sortie += d.toString() })
    const fini = new Promise<number | null>(resolve => enfant.on('exit', code => resolve(code)))
    try {
      // le serveur annonce son port réel (port 0 = choisi par le système)
      const debut = Date.now()
      let port = 0
      while (Date.now() - debut < 90000 && !port) {
        const m = /127\.0\.0\.1:(\d+)/.exec(sortie)
        if (m) port = Number(m[1])
        else await new Promise(r => setTimeout(r, 200))
      }
      assert.ok(port, `le serveur doit annoncer son port, obtenu :\n${sortie}`)
      // une requête sur la route rendue PAR REQUÊTE : c'est elle qui fait naître le renderer
      const rep = await fetch(`http://127.0.0.1:${port}/`)
      assert.equal(rep.status, 200, 'la page rendue doit répondre')
      assert.match(await rep.text(), /Accueil/, 'le rendu serveur doit avoir résolu le binding')
      assert.equal(ateliers(tmp).length, 1, 'le renderer a bien créé son dossier de travail')
      enfant.kill('SIGINT')
      assert.equal(await fini, 0, `l'arrêt par SIGINT doit sortir proprement, journal :\n${sortie}`)
      assert.deepEqual(ateliers(tmp), [], 'aucun dossier de travail ne doit survivre à l\'arrêt')
    } finally {
      if (enfant.exitCode === null) { enfant.kill('SIGKILL'); await fini }
    }
  })

  it('`mjs dev` interrompu par SIGINT : aucun dossier de travail ne survit à la session', async () => {
    const root = fixtureProject('dev-atelier')
    const tmp  = mjsTmp('dev-tmp')
    const port = await portLibre()
    const enfant = spawn(join(repoRoot, 'node_modules', '.bin', 'tsx'), ['src/cli.ts', 'dev', '--root', root, '--port', String(port)], {
      cwd: repoRoot, env: { ...process.env, TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let sortie = ''
    enfant.stdout.on('data', (d: Buffer) => { sortie += d.toString() })
    enfant.stderr.on('data', (d: Buffer) => { sortie += d.toString() })
    const fini = new Promise<number | null>(resolve => enfant.on('exit', code => resolve(code)))
    try {
      const debut = Date.now()
      while (Date.now() - debut < 90000 && !/Watching /.test(sortie)) await new Promise(r => setTimeout(r, 200))
      assert.match(sortie, /Watching /, `le serveur de développement doit être prêt, obtenu :\n${sortie}`)
      // même chemin que `mjs serve` : c'est la requête sur la route rendue qui fait naître le renderer
      const rep = await fetch(`http://127.0.0.1:${port}/`)
      assert.equal(rep.status, 200, 'la page rendue doit répondre')
      assert.match(await rep.text(), /Accueil/, 'le rendu serveur doit avoir résolu le binding')
      assert.equal(ateliers(tmp).length, 1, 'le renderer a bien créé son dossier de travail')
      enfant.kill('SIGINT')
      assert.equal(await fini, 0, `l'arrêt par SIGINT doit sortir proprement, journal :\n${sortie}`)
      assert.deepEqual(ateliers(tmp), [], 'aucun dossier de travail ne doit survivre à l\'arrêt')
    } finally {
      if (enfant.exitCode === null) { enfant.kill('SIGKILL'); await fini }
    }
  })

  it('SABOTAGE — le tri par dépendances lève (cycle) : le dossier de travail est quand même retiré', async () => {
    const root = fixtureProject('atelier-cycle')
    const tmp  = mjsTmp('cycle-tmp')
    process.env.TMPDIR = tmp
    try {
      const erreur = await creerRendererSabote(root, (src) => {
        const repere = 'sortedRestIds = topoSortFiles(restIds, depsById, idToFile)'
        if (!src.includes(repere)) throw new Error('point de tri par dépendances introuvable — sabotage à revoir')
        return src.replace(repere, 'sortedRestIds = ((): string[] => { throw new Error(\'cycle simulé\') })()')
      })
      assert.match(String(erreur), /cycle simulé/, 'la création du renderer doit bien lever ici')
      assert.deepEqual(ateliers(tmp), [], 'aucun dossier de travail ne doit survivre à cette sortie')
    } finally {
      delete process.env.TMPDIR
    }
  })

  it('SABOTAGE — happy-dom absent : le dossier de travail est quand même retiré', async () => {
    const root = fixtureProject('atelier-happydom')
    const tmp  = mjsTmp('happydom-tmp')
    process.env.TMPDIR = tmp
    try {
      const erreur = await creerRendererSabote(root, (src) => {
        const repere = 'HappyDOM = await import(\'happy-dom\')'
        if (!src.includes(repere)) throw new Error('point d\'import de happy-dom introuvable — sabotage à revoir')
        return src.replace(repere, 'HappyDOM = await import(\'happy-dom-absent-simule\')')
      })
      assert.ok(erreur, 'la création du renderer doit bien lever ici')
      assert.deepEqual(ateliers(tmp), [], 'aucun dossier de travail ne doit survivre à cette sortie')
    } finally {
      delete process.env.TMPDIR
    }
  })
})
