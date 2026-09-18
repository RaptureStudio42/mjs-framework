// L'ENVIRONNEMENT DU BUILD VIENT DE LA COMMANDE — et de rien d'autre.
//
// `mjs build` construit en développement, `mjs build --prod` en production. Ni clé de config, ni
// variable d'ambiance : les deux ont mordu, à trois jours d'intervalle.
//   • `minify: true` valait « build de prod » — panneau d'inspection retiré du bundle local
//     sans le moindre message.
//   • `"env": "prod"`, posé au mjs.config.json pour dire ce que produit le DÉPLOIEMENT, est
//     parti sur le serveur ET est resté sur la machine du dev : `mjs dev` lisait la même clé et
//     sortait un core minifié de 144 lignes, sans `devPanel` — la même panne, revenue.
//   • `NODE_ENV=production` qui traîne dans un shell suffisait à changer ce que produit un build.
//
// Tests via de VRAIS SOUS-PROCESSUS (cli.ts exécute `run(process.argv)` à son top-level :
// l'importer lancerait une vraie CLI). `--root` fait `process.chdir` AVANT `findConfig()` : le
// mjs.config.json lu est bien celui du projet jetable.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Projet jetable : un composant, et le mjs.config.json demandé (aucun si `config` est absent). */
function projet(etiquette: string, config?: Record<string, unknown>): string {
  const root = mjsTmp(etiquette)
  mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
  writeFileSync(join(root, 'app', 'modularjs', 'hello.mjs'), '<p>hi</p>\n')
  if (config) writeFileSync(join(root, 'mjs.config.json'), `${JSON.stringify(config, null, 2)}\n`)
  return root
}

/** Le mjs_core-*.js écrit par le build (dossier de sortie par défaut). */
function lireCore(root: string): string {
  const outDir  = join(root, 'public', 'modularjs')
  const fichier = readdirSync(outDir).find(f => /^mjs_core-/.test(f))
  assert.ok(fichier, `aucun mjs_core-*.js dans ${outDir}`)
  return readFileSync(join(outDir, fichier!), 'utf-8')
}

// `µ` est un `var` de haut niveau, renommé par esbuild en minifiant : on cherche la PROPRIÉTÉ,
// jamais manglée (même sonde que bundler-env-dev-prod.test.ts).
const aLePanneau = (core: string) => /\.devPanel\s*=\s*function/.test(core)
// les bandeaux `// === mjs_xxx.ts ===` de la concaténation ne survivent pas à esbuild
const estMinifie = (core: string) => !/\/\/ === mjs_element\.ts ===/.test(core)

/** `mjs build` sur un projet jetable — sous-processus complet, rendu quand il a terminé. */
function build(root: string, flags: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--root', root, ...flags], {
    cwd: repoRoot, encoding: 'utf-8', timeout: 120000, env: { ...process.env, ...env },
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe("cli.ts — l'environnement du build vient de la COMMANDE", function () {
  this.timeout(180000)

  it('`mjs build` nu → build de DÉVELOPPEMENT : non minifié, panneau embarqué', () => {
    const root = projet('build-nu')
    const { code, stdout } = build(root)
    assert.equal(code, 0, stdout)
    assert.match(stdout, /Build de DÉVELOPPEMENT/)
    assert.match(stdout, /défaut de `mjs build`/, "le bandeau doit dire d'où vient le mode")
    const core = lireCore(root)
    assert.ok(aLePanneau(core), 'un build de dév embarque le panneau (Ctrl+Shift+Espace)')
    assert.ok(!estMinifie(core), 'un build de dév ne se minifie pas')
  })

  it('`mjs build --prod` → build de PRODUCTION : minifié, aucun outil de développement', () => {
    const root = projet('build-prod')
    const { code, stdout } = build(root, ['--prod'])
    assert.equal(code, 0, stdout)
    assert.match(stdout, /Build de PRODUCTION/)
    assert.match(stdout, /imposé par --dev\/--prod/, 'le bandeau attribue le mode au drapeau')
    const core = lireCore(root)
    assert.ok(!aLePanneau(core), 'un build de prod ne doit embarquer aucun outil de développement')
    assert.ok(estMinifie(core), 'un build de prod est minifié')
  })

  it("`NODE_ENV=production` dans le shell ne change RIEN : `mjs build` nu reste du développement", () => {
    const root = projet('build-nodeenv')
    const { code, stdout } = build(root, [], { NODE_ENV: 'production' })
    assert.equal(code, 0, stdout)
    assert.match(stdout, /Build de DÉVELOPPEMENT/,
      "AVANT ce correctif : un NODE_ENV=production hérité d'un shell (ou d'un script de déploiement) suffisait à basculer un build en production, sans que la commande l'ait demandé")
    assert.ok(aLePanneau(lireCore(root)), "le panneau doit rester dans le bundle : c'est un build de dév")
  })

  it("un `\"env\"` resté au mjs.config.json fait ÉCHOUER le build, en disant où ce choix vit", () => {
    const root = projet('build-config-env', { env: 'prod' })
    const { code, stderr } = build(root)
    assert.notEqual(code, 0, "un fichier de config qui croit décider de l'environnement doit être refusé, pas ignoré en silence")
    assert.match(stderr, /la clé 'env' n'existe pas/)
    assert.match(stderr, /mjs build --prod/, "le message doit donner la forme qui marche, pas seulement constater l'erreur")
  })
})

// ---------------------------------------------------------------------------------------------
// `mjs dev` : la panne (un `mjs dev` qui construisait en production) est structurellement
// impossible depuis que la clé n'existe plus — ce test garde quand même la porte, le serveur de dev
// étant le seul chemin qui ne passe pas par le `case 'build'` ci-dessus.

// `mjs dev` démarre son serveur (et annonce le HMR) AVANT de lancer son build initial : c'est le
// rapport de build qu'il faut attendre, pas le HMR, sinon on coupe avant le moindre fichier écrit.
const PREMIER_BUILD = /✅ \d+ fichiers en \d+ms/

/** `mjs dev` sur un projet jetable, coupé dès que le premier build est écrit. */
function lancerDev(root: string, port: number, flags: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    // `detached` + `process.kill(-pid)` : sans ça on ne tue que le `npx`, et le node du serveur dev
    // survit — orphelin qui garde le port ET la sortie ouverte (mocha ne rend jamais la main).
    // `stdio` explicite pour la même raison : rien de ce qu'on lance ne tient notre propre stdout.
    const proc = spawn('npx', ['tsx', 'src/cli.ts', 'dev', '--root', root, '--port', String(port), ...flags], { cwd: repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const tuerGroupe = (signal: NodeJS.Signals) => { try { process.kill(-proc.pid!, signal) } catch { /* groupe déjà parti */ } }
    let stdout = ''
    let stderr = ''
    let coupe: NodeJS.Timeout | undefined
    const abandon = setTimeout(() => { tuerGroupe('SIGKILL') }, 60000) // le build n'est jamais venu
    proc.stdout!.on('data', (d) => {
      stdout += String(d)
      if (coupe === undefined && PREMIER_BUILD.test(stdout)) {
        tuerGroupe('SIGINT')
        coupe = setTimeout(() => tuerGroupe('SIGKILL'), 5000) // SIGINT ignoré : on force
      }
    })
    proc.stderr!.on('data', (d) => { stderr += String(d) })
    proc.on('error', reject)
    proc.on('close', () => {
      clearTimeout(abandon)
      if (coupe !== undefined) clearTimeout(coupe)
      if (PREMIER_BUILD.test(stdout)) resolve(stdout)
      else reject(new Error(`'mjs dev' n'a jamais fini son premier build.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`))
    })
  })
}

describe('cli.ts — `mjs dev` est du développement par définition', function () {
  this.timeout(90000)

  it('`mjs dev` nu → build de DÉVELOPPEMENT, panneau présent', async () => {
    const root   = projet('dev-nu')
    const stdout = await lancerDev(root, 39471)
    assert.match(stdout, /Build de DÉVELOPPEMENT/)
    assert.ok(aLePanneau(lireCore(root)), "AVANT ce correctif : mjs_devpanel était retiré du bundle, Ctrl+Shift+Espace n'ouvrait plus rien")
  })

  it('`mjs dev --prod` → le drapeau garde la main : build de PROD, aucun outil de développement', async () => {
    const root   = projet('dev-flag-prod')
    const stdout = await lancerDev(root, 39472, ['--prod'])
    assert.match(stdout, /Build de PRODUCTION/, '`--prod` sert à reproduire un bogue qui ne sort qu\'en build de production')
    assert.ok(!aLePanneau(lireCore(root)))
  })
})
