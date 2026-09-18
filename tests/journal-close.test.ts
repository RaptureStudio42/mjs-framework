// journal-close — close() solde les écritures en attente PUIS retire le journal du hook 'exit'
// (src/server/journal.ts). Le comportement corrigé n'est PAS un bogue
// du journal : une écriture encore débouncée au moment du hook 'exit' passe par writeAtomic, qui
// RECRÉE son dossier cible s'il a disparu — voulu en production (`systemctl stop` ne doit pas
// avaler les dernières erreurs), nuisible pour tout appelant à durée de vie courte, dont le
// ménage se fait ressusciter sous les pieds.
//
// GARDE MUETTE — les deux modes de la fixture sont lancés : `sans-close` prouve que le test SAIT
// détecter la résurrection (le dossier revient pour de vrai), `avec-close` prouve que close() la
// coupe. Un test qui n'aurait que le second cas passerait au vert même si close() ne faisait rien.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJournal } from '../src/server/journal.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE   = join(__dirname, 'fixtures/journal-close-child.mts')

after(() => sweepRegistered())

function lancerFixture(dir: string, mode: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const enfant   = spawn(process.execPath, ['--import', 'tsx', FIXTURE, dir, mode], { cwd: join(__dirname, '..'), stdio: 'ignore' })
    const securite = setTimeout(() => enfant.kill('SIGKILL'), 8000)
    enfant.on('error', (e) => { clearTimeout(securite); reject(e) })
    enfant.on('exit', (code) => { clearTimeout(securite); resolve(code) })
  })
}

describe('journal — close() (src/server/journal.ts)', function () {
  this.timeout(20000)

  it('CONTRE-PREUVE sans close() : le hook de sortie RECRÉE le dossier effacé juste avant', async () => {
    const dir = mjsTmp('journal-close-sans')
    assert.equal(await lancerFixture(dir, 'sans-close'), 0, 'la fixture doit se terminer normalement')
    assert.ok(existsSync(dir), 'sans close(), le dossier doit ressusciter — sinon ce test ne prouve rien du cas suivant')
    assert.ok(existsSync(join(dir, 'mjs-errors-server.ndjson')), 'et il ne contient que le journal réécrit à la sortie')
  })

  it('avec close() : le dossier effacé RESTE effacé — plus aucune écriture à la sortie du process', async () => {
    const dir = mjsTmp('journal-close-avec')
    assert.equal(await lancerFixture(dir, 'avec-close'), 0, 'la fixture doit se terminer normalement')
    assert.ok(!existsSync(dir), 'close() a soldé puis s\'est retiré du hook \'exit\' : rien ne recrée le dossier')
  })

  it('close() SOLDE avant de se retirer : le fichier NDJSON est écrit sans attendre le débounce', () => {
    const dir = mjsTmp('journal-close-solde')
    const journal = createJournal({ dir })
    journal.record('server', { message: 'ecrite-par-close', url: '/c' })
    const chemin = join(dir, 'mjs-errors-server.ndjson')
    assert.ok(!existsSync(chemin), 'avant close() l\'écriture est encore débouncée (~1 s)')
    journal.close()
    assert.ok(existsSync(chemin), 'close() écrit tout de suite')
    assert.ok(readFileSync(chemin, 'utf-8').includes('ecrite-par-close'))
  })

  it('close() est idempotent, et un record() POSTÉRIEUR écrit immédiatement (jamais une perte muette)', () => {
    const dir = mjsTmp('journal-close-apres')
    const journal = createJournal({ dir })
    journal.close()
    journal.close()
    journal.record('server', { message: 'apres-close', url: '/a' })
    const chemin = join(dir, 'mjs-errors-server.ndjson')
    assert.ok(existsSync(chemin), 'journal soldé : plus de hook derrière pour rattraper, donc écriture SYNCHRONE')
    assert.ok(readFileSync(chemin, 'utf-8').includes('apres-close'), 'l\'entrée postérieure au close() est bien sur disque')
    assert.equal(journal.list().length, 1)
  })
})
