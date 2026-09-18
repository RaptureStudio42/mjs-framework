// dev-env-wiring — `mjs dev` (cli.ts)
// NE TRANSMETTAIT PAS `envBuild` à `new StaticServer({...})` ni à `createRenderHandler(...)`, alors
// que `ServerOpts.env`/le 4e paramètre de `createRenderHandler` existent déjà (cf.
// tests/serve-prod-guard.test.ts) :
// un `mjs dev --prod` sans NODE_ENV=production exporté séparément laissait `/__mjs/theme.json` ET
// `/__mjs/errors.json` ouverts, malgré la garde déjà posée côté StaticServer/isProdEnv.
//
// Process enfant réel (cli.ts exécute `run(process.argv)` à son top-level), sur le modèle de
// tests/cli-env-commande.test.ts (lancerDev) — adapté pour garder le process VIVANT après le
// premier build (celui-ci n'attend que ce signal pour couper) afin de pouvoir y faire une requête
// HTTP : `server.start()` précède `bundler.watch()` dans cli.ts, le serveur écoute donc déjà quand
// le rapport de build sort.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const PREMIER_BUILD = /✅ \d+ fichiers en \d+ms/

interface DevProc { stdout: string; kill(): Promise<void> }

/** `mjs dev` sur un projet jetable, laissé VIVANT après le premier build — l'appelant fetch puis
 *  coupe via kill(). Groupe détaché (mêmes raisons que lancerDev de cli-env-commande.test.ts). */
function lancerDevVivant(root: string, port: number, flags: string[] = []): Promise<DevProc> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', 'src/cli.ts', 'dev', '--root', root, '--port', String(port), ...flags], { cwd: repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const tuerGroupe = (signal: NodeJS.Signals) => { try { process.kill(-proc.pid!, signal) } catch { /* groupe déjà parti */ } }
    let stdout = ''
    let stderr = ''
    let settled = false
    const abandon = setTimeout(() => {
      if (settled) return
      settled = true
      tuerGroupe('SIGKILL')
      reject(new Error(`'mjs dev' n'a jamais fini son premier build.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`))
    }, 60000)
    proc.stdout!.on('data', (d) => {
      stdout += String(d)
      if (!settled && PREMIER_BUILD.test(stdout)) {
        settled = true
        clearTimeout(abandon)
        resolve({
          stdout,
          kill: () => new Promise((done) => {
            proc.once('close', () => done())
            tuerGroupe('SIGINT')
            setTimeout(() => tuerGroupe('SIGKILL'), 5000) // SIGINT ignoré : on force
          }),
        })
      }
    })
    proc.stderr!.on('data', (d) => { stderr += String(d) })
    proc.on('error', (e) => { if (!settled) { settled = true; clearTimeout(abandon); reject(e) } })
  })
}

/** Projet jetable AVEC mjs.config.json (`{}` suffit) : `found` doit être non-null pour que cli.ts
 *  crée le magasin du journal — sinon /__mjs/errors.json n'est jamais routée, prod ou pas (cf.
 *  server/index.ts `this.journal &&`), ce qui rendrait ce test aveugle à la régression visée. */
function projet(etiquette: string): string {
  const root = mjsTmp(etiquette)
  mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
  writeFileSync(join(root, 'app', 'modularjs', 'hello.mjs'), '<p>hi</p>\n')
  writeFileSync(join(root, 'mjs.config.json'), '{}\n')
  return root
}

describe('cli.ts `mjs dev` — env transmis à StaticServer/createRenderHandler', function () {
  this.timeout(90000)

  it('`mjs dev --prod` → 404 sur /__mjs/theme.json et /__mjs/errors.json', async () => {
    const root = projet('dev-e8-prod')
    const port = 39481
    const dev  = await lancerDevVivant(root, port, ['--prod'])
    try {
      const theme  = await fetch(`http://127.0.0.1:${port}/__mjs/theme.json`)
      const errors = await fetch(`http://127.0.0.1:${port}/__mjs/errors.json`)
      assert.equal(theme.status, 404, dev.stdout)
      assert.equal(errors.status, 404, dev.stdout)
    } finally {
      await dev.kill()
    }
  })

  it('`mjs dev` SANS --prod → 200 sur /__mjs/theme.json et /__mjs/errors.json (comportement dev inchangé)', async () => {
    const root = projet('dev-e8-nu')
    const port = 39482
    const dev  = await lancerDevVivant(root, port)
    try {
      const theme  = await fetch(`http://127.0.0.1:${port}/__mjs/theme.json`)
      const errors = await fetch(`http://127.0.0.1:${port}/__mjs/errors.json`)
      assert.equal(theme.status, 200, dev.stdout)
      assert.equal(errors.status, 200, dev.stdout)
    } finally {
      await dev.kill()
    }
  })
})
