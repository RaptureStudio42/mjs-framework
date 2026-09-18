// WorkerPool.submit() n'avait AUCUN timeout : un worker qui reçoit une tâche
// et n'y répond JAMAIS (boucle infinie côté tokenizer/parser, deadlock interne) laissait la
// promesse pendre À JAMAIS — ni résolue, ni rejetée. Un `mjs build` qui tombe sur un seul fichier
// de ce genre restait accroché indéfiniment, sans code de sortie, sans message.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { WorkerPool } from '../src/bundler/worker-pool.js'

// worker JOUET — reçoit un message et entre dans une boucle infinie SANS jamais postMessage()
// de réponse (simule un backtracking catastrophique côté transpiler sur une entrée pathologique).
function writeBadWorker(dir: string): string {
  const path = join(dir, 'bad-worker.mjs')
  writeFileSync(path, `
import { parentPort } from 'node:worker_threads'
parentPort.on('message', () => { while (true) { /* busy loop volontaire */ } })
`)
  return path
}

// worker JOUET SAIN — répond immédiatement, MÊME protocole que le vrai worker.ts
// ({ id, ok, result }, cf. WorkerPool.handleResponse).
function writeGoodWorker(dir: string): string {
  const path = join(dir, 'good-worker.mjs')
  writeFileSync(path, `
import { parentPort } from 'node:worker_threads'
parentPort.on('message', (msg) => { parentPort.postMessage({ id: msg.id, ok: true, result: 'pong' }) })
`)
  return path
}

describe('WorkerPool — délai maximal par tâche', function () {
  this.timeout(15000)

  it('worker qui ne répond JAMAIS : submit() est REJETÉ après le délai (raccourci ici), le worker est retiré du pool', async () => {
    const dir = mjsTmp('worker-pool-timeout')
    const badWorker = writeBadWorker(dir)
    const pool = new WorkerPool(1, { workerPath: badWorker }, { timeoutMs: 300 })
    try {
      await assert.rejects(
        pool.submit({ type: 'transpile', moduleName: 'mjs-coince' }),
        /mjs-coince/,
        'AVANT le fix : submit() ne rejette JAMAIS — la promesse pend indéfiniment sur un worker mort/bloqué',
      )
      // le worker fautif ne doit plus jamais être dispatché : isDead() (aucun worker vivant) —
      // taille de pool 1, un seul worker, mort après son timeout.
      assert.ok(pool.isDead(), 'le worker qui a débordé doit être RETIRÉ du pool, jamais laissé éligible au prochain dispatch')
    } finally {
      await pool.terminate()
    }
  })

  it('non-régression : un worker SAIN répond normalement, timeoutMs personnalisé', async () => {
    const dir = mjsTmp('worker-pool-timeout-ok')
    const goodWorker = writeGoodWorker(dir)
    const pool = new WorkerPool(1, { workerPath: goodWorker }, { timeoutMs: 2000 })
    try {
      const res = await pool.submit<string>({ type: 'ping' })
      assert.equal(res, 'pong')
    } finally {
      await pool.terminate()
    }
  })

  it('non-régression : sans timeoutMs explicite (défaut), un worker qui répond vite reste inchangé', async () => {
    const dir = mjsTmp('worker-pool-timeout-defaut')
    const goodWorker = writeGoodWorker(dir)
    const pool = new WorkerPool(1, { workerPath: goodWorker })
    try {
      const res = await pool.submit<string>({ type: 'ping' })
      assert.equal(res, 'pong')
    } finally {
      await pool.terminate()
    }
  })
})
