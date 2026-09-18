// journal-sigterm — flush sur SIGTERM (src/server/journal.ts). `systemctl stop` envoie
// SIGTERM, qui termine Node SANS jamais atteindre le hook 'exit' (débounce 1s > vie du process
// enfant ci-dessous) — la fixture (tests/fixtures/journal-sigterm-child.mts, extension .mts EXPRÈS :
// `mocha --recursive tests/ --extension ts` la chargerait sinon et son auto-SIGTERM tuerait TOUTE
// la suite au chargement) reproduit le scénario
// dans un VRAI process enfant (jamais le process de test lui-même) : enregistre une entrée puis
// s'auto-tue par SIGTERM, garde-fou setInterval pour que SEUL le signal (jamais un drain naturel)
// termine ce process.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE   = join(__dirname, 'fixtures/journal-sigterm-child.mts')

after(() => sweepRegistered())

// `--import tsx` (jamais `npx tsx`, qui respawn à travers 3-4 niveaux de process et complique la
// remontée exacte du signal/code de sortie) : UN SEUL process node, celui qui s'auto-tue est
// directement celui que `spawn()` nous rend — aucune ambiguïté sur le signal observé.
function lancerFixture(dir: string, message: string): Promise<{ code: number | null, signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const enfant = spawn(process.execPath, ['--import', 'tsx', FIXTURE, dir, message], { cwd: join(__dirname, '..'), stdio: 'ignore' })
    const securite = setTimeout(() => enfant.kill('SIGKILL'), 8000)
    enfant.on('error', (e) => { clearTimeout(securite); reject(e) })
    enfant.on('exit', (code, signal) => { clearTimeout(securite); resolve({ code, signal }) })
  })
}

describe('journal — flush sur SIGTERM (src/server/journal.ts)', function () {
  this.timeout(10000)

  it('systemctl stop (SIGTERM) : le journal est vidé avant la terminaison réelle du process', async () => {
    const dir = mjsTmp('journal-sigterm')
    const message = 'entree-avant-sigterm-'+ Date.now()
    const { code, signal } = await lancerFixture(dir, message)
    assert.ok(signal === 'SIGTERM' || code === 143, `terminaison par SIGTERM attendue — code=${code} signal=${signal}`)
    const chemin = join(dir, 'mjs-errors-server.ndjson')
    assert.ok(existsSync(chemin), 'fichier NDJSON absent — l\'entrée serait perdue sans le hook SIGTERM (débounce 1s > vie du process)')
    const contenu = readFileSync(chemin, 'utf-8')
    assert.ok(contenu.includes(message), 'l\'entrée enregistrée avant le SIGTERM doit survivre dans le fichier')
  })
})
