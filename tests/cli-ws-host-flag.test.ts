// câblage du flag --host de `mjs ws` côté
// src/cli.ts (parseArgs, PARTAGÉ dev/serve/ws/serveur). WsCommandArgs.host,
// buildRunPlan(..., cliHost) et runWsCommand lisant args.host étaient déjà posés (src/cli/ws.ts, cf. la note en tête
// de tests/cli-ws-host-port.test.ts) — mais le flag CLI lui-même restait hors périmètre.
// Deux volets :
//  - le flag traverse jusqu'au VRAI serveur : process enfant, port éphémère réel, bannière +
//    connexion ws://127.0.0.1:<port> réelle (un import direct de src/cli.ts est impossible :
//    run(process.argv.slice(2)) s'exécute INCONDITIONNELLEMENT à son top-level, cf. la note de
//    tests/mjs-ws-cli.test.ts) ;
//  - `--host` sans valeur derrière → message catalogué cli.flag-valeur-manquante (process court,
//    --help juste après, MÊME patron que tests/cli-unknown-flag-warning.test.ts).

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot  = join(__dirname, '..')

after(() => sweepRegistered())

function randomPort(): number { return 59000 + Math.floor(Math.random() * 1500) }

// lance `mjs ws` en VRAI process enfant, UN SEUL process (`--import tsx`, jamais `npx tsx` qui
// respawn plusieurs niveaux et complique un arrêt propre — même règle que
// tests/journal-sigterm.test.ts) ; résout dès la ligne 'Ctrl-C pour arrêter', imprimée par
// printBanner APRÈS app.listen() (cf. src/cli/ws.ts) — le serveur est donc déjà lié au port.
function lancerMjsWs(args: string[]): Promise<{ lignes: string[]; stop: () => Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const enfant = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'ws', ...args], { cwd: repoRoot })
    const lignes: string[] = []
    let pret = false
    const securite = setTimeout(() => { enfant.kill('SIGKILL'); reject(new Error(`démarrage jamais confirmé. lignes:\n${lignes.join('\n')}`)) }, 8000)
    const surSortie = (buf: Buffer) => {
      for (const ligne of buf.toString('utf-8').split('\n')) if (ligne) lignes.push(ligne)
      if (!pret && lignes.some(l => l.includes('Ctrl-C pour arrêter'))) {
        pret = true
        clearTimeout(securite)
        resolvePromise({
          lignes,
          stop: () => new Promise<void>((res) => {
            enfant.once('exit', () => res())
            enfant.kill('SIGTERM')
            setTimeout(() => enfant.kill('SIGKILL'), 4000)
          }),
        })
      }
    }
    enfant.stdout.on('data', surSortie)
    enfant.stderr.on('data', surSortie)
    enfant.on('error', (e) => { clearTimeout(securite); reject(e) })
    enfant.on('exit', (code) => {
      if (pret) return   // arrêt volontaire via stop(), déjà résolu
      clearTimeout(securite)
      reject(new Error(`mjs ws terminé prématurément (code ${code}). lignes:\n${lignes.join('\n')}`))
    })
  })
}

describe('cli.ts — flag --host de `mjs ws`', function () {
  this.timeout(15000)

  it("--host 127.0.0.1 --port <éphémère> → bannière affiche l'hôte ET une connexion ws://127.0.0.1:<port> réussit", async () => {
    const root = mjsTmp('cli-ws-host-flag')
    writeFileSync(join(root, 'ws.mjs'), `export default {\n  setup(app) {\n    app.serve('ping', () => 'pong')\n  },\n}\n`)
    const port = randomPort()
    const { lignes, stop } = await lancerMjsWs(['--root', root, '--entry', 'ws.mjs', '--host', '127.0.0.1', '--port', String(port)])
    try {
      // ligne de bannière PRÉCISE (pas juste « une ligne qui contient 127.0.0.1 » — un argument
      // mal reconnu produit aussi un warning qui cite la valeur telle quelle, faux positif prouvé
      // à la main : sans le câblage, --host finit « argument non reconnu » ET contient la chaîne)
      assert.ok(lignes.some(l => l.includes('écoute sur le port') && l.includes('127.0.0.1')), `bannière sans l'hôte --host. lignes:\n${lignes.join('\n')}`)
      assert.ok(!lignes.some(l => l.includes('ignoré')), `--host/127.0.0.1 ne doivent déclencher aucun warning. lignes:\n${lignes.join('\n')}`)
      const etat = await new Promise<string>((res) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
        const minuteur = setTimeout(() => { ws.terminate(); res('TIMEOUT') }, 3000)
        ws.once('open', () => { clearTimeout(minuteur); ws.close(); res('CONNECTE') })
        ws.once('error', () => { clearTimeout(minuteur); res('ERREUR') })
      })
      assert.equal(etat, 'CONNECTE', `--host 127.0.0.1 doit rester joignable en loopback. lignes:\n${lignes.join('\n')}`)
    } finally {
      await stop()
    }
  })
})

describe('cli.ts — parseArgs : --host sans valeur', function () {
  this.timeout(10000)

  it("--host en dernière position utile (rien d'autre qu'un flag derrière) → message catalogué cli.flag-valeur-manquante, pas de crash", () => {
    const { stderr, status } = spawnSync('npx', ['tsx', 'src/cli.ts', 'ws', '--host', '--help'], { cwd: repoRoot, encoding: 'utf-8' })
    assert.equal(status, 0, `stderr:\n${stderr}`)
    assert.match(stderr, /--host ignoré : valeur manquante\./, `message flag-valeur-manquante absent. stderr:\n${stderr}`)
  })
})
