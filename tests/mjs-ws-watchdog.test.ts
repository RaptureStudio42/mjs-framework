// Tests du chien de garde systemd (src/mjs-ws/watchdog.ts) — étage 1 de la supervision. Le vrai
// `systemd-notify` n'est JAMAIS lancé ici : `armWatchdog` accepte un spawn injecté, exactement comme
// transport-uws accepte un faux module uWS. Ce que ces essais tiennent : le battement n'existe que
// quand systemd le réclame, il est périodique, il porte le bon message, et un premier battement qui
// échoue ARRÊTE le moteur au lieu de le laisser abattre en silence toutes les WatchdogSec secondes.
// La preuve que systemd accepte réellement ce battement est ailleurs — au banc, sur systemd
// 259 (poste) et 252 (serveur) : elle ne peut pas vivre dans une suite unitaire.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { armWatchdog } from '../src/mjs-ws/watchdog.js'
import { mjsWs, MemoryTransport } from '../src/mjs-ws/index.js'
import type { MjsWsLogLevel } from '../src/mjs-ws/core.js'
import { mjsTmp } from './helpers/tmp.js'

const tick = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

interface Appel { cmd: string, args: readonly string[] }

// faux `spawn` : retient chaque appel et rend un émetteur que l'essai pilote (exit/error à la main)
function faussSpawn(sortie?: (enfant: EventEmitter, n: number) => void) {
  const appels: Appel[] = []
  const spawn = ((cmd: string, args: readonly string[]) => {
    const enfant = new EventEmitter()
    appels.push({ cmd, args })
    if (sortie) queueMicrotask(() => sortie(enfant, appels.length))
    return enfant
  }) as unknown as Parameters<typeof armWatchdog>[1] extends { spawn?: infer S } ? S : never
  return { appels, spawn }
}

function faussLog() {
  const lignes: Array<{ niveau: MjsWsLogLevel, message: string }> = []
  return { lignes, log: (niveau: MjsWsLogLevel, message: string) => { lignes.push({ niveau, message }) } }
}

describe('mjs-ws — chien de garde systemd (watchdog.ts)', () => {

  it('ne fait RIEN hors systemd : pas de WATCHDOG_USEC, pas de battement, et rend null', () => {
    const { appels, spawn } = faussSpawn()
    const { log } = faussLog()
    assert.equal(armWatchdog(log, { spawn, env: {} }), null)
    assert.equal(armWatchdog(log, { spawn, env: { WATCHDOG_USEC: '0' } }), null)
    assert.equal(armWatchdog(log, { spawn, env: { WATCHDOG_USEC: 'pas un nombre' } }), null)
    assert.equal(appels.length, 0, 'aucun process ne doit être lancé quand personne ne réclame de battement')
  })

  it('bat tout de suite quand systemd arme la fenêtre, et dit WATCHDOG=1 à systemd-notify', () => {
    const { appels, spawn } = faussSpawn()
    const { lignes, log } = faussLog()
    const h = armWatchdog(log, { spawn, env: { WATCHDOG_USEC: '30000000' } })
    assert.ok(h, 'un handle doit être rendu')
    assert.equal(appels.length, 1, 'le premier battement part SANS attendre une période')
    assert.equal(appels[0].cmd, 'systemd-notify')
    assert.deepEqual([...appels[0].args], ['WATCHDOG=1'])
    assert.match(lignes.at(-1)!.message, /15000 ms/, 'la période annoncée est la MOITIÉ de la fenêtre')
    h!.stop()
  })

  it('rebat périodiquement, et stop() coupe pour de bon', async function () {
    this.timeout(8000)
    const { appels, spawn } = faussSpawn((e) => e.emit('exit', 0))
    const { log } = faussLog()
    const h = armWatchdog(log, { spawn, env: { WATCHDOG_USEC: '2000000' } })   // fenêtre 2 s -> période plancher 1 s
    await tick(2300)
    const pendant = appels.length
    assert.ok(pendant >= 3, `au moins 3 battements en 2,3 s (obtenu ${pendant})`)
    h!.stop()
    await tick(1300)
    assert.equal(appels.length, pendant, 'plus un seul battement après stop()')
  })

  it('ne bat JAMAIS à la place de son père : WATCHDOG_PID désigne un autre process', () => {
    const { appels, spawn } = faussSpawn()
    const { log } = faussLog()
    assert.equal(armWatchdog(log, { spawn, env: { WATCHDOG_USEC: '30000000', WATCHDOG_PID: '4242' }, pid: 99 }), null)
    assert.equal(appels.length, 0)
    // le MÊME pid, lui, bat bien
    const h = armWatchdog(log, { spawn, env: { WATCHDOG_USEC: '30000000', WATCHDOG_PID: '99' }, pid: 99 })
    assert.ok(h)
    assert.equal(appels.length, 1)
    h!.stop()
  })

  it('ARRÊTE le moteur si systemd-notify est introuvable — plutôt que de le laisser abattre en silence', async () => {
    const { spawn } = faussSpawn((e, n) => { if (n === 1) e.emit('error', new Error('ENOENT')) })
    const { lignes, log } = faussLog()
    const codes: number[] = []
    armWatchdog(log, { spawn, env: { WATCHDOG_USEC: '30000000' }, quitter: c => codes.push(c) })
    await tick(10)
    assert.deepEqual(codes, [1], 'sortie en 1, une seule fois')
    assert.equal(lignes.at(-1)!.niveau, 'error')
    assert.match(lignes.at(-1)!.message, /introuvable/)
  })

  it('ARRÊTE le moteur si le premier battement est REFUSÉ, en nommant NotifyAccess=all', async () => {
    const { spawn } = faussSpawn((e, n) => { if (n === 1) e.emit('exit', 1) })
    const { lignes, log } = faussLog()
    const codes: number[] = []
    armWatchdog(log, { spawn, env: { WATCHDOG_USEC: '30000000' }, quitter: c => codes.push(c) })
    await tick(10)
    assert.deepEqual(codes, [1])
    assert.match(lignes.at(-1)!.message, /NotifyAccess=all/, "le message doit nommer la ligne d'unité qui manque")
  })

  it('un échec APRÈS le premier battement ne tue personne — le chien de garde tranchera tout seul', async function () {
    this.timeout(8000)
    const { spawn } = faussSpawn((e, n) => { e.emit('exit', n === 1 ? 0 : 1) })
    const { log } = faussLog()
    const codes: number[] = []
    const h = armWatchdog(log, { spawn, env: { WATCHDOG_USEC: '2000000' }, quitter: c => codes.push(c) })
    await tick(2300)
    h!.stop()
    assert.deepEqual(codes, [], 'un battement raté ponctuel ne prouve rien : on ne quitte pas')
  })

  // LE CÂBLAGE, ET PAS SEULEMENT LE MODULE. Sans cet essai, retirer la ligne `armWatchdog(log)` de
  // core.ts ne ferait tomber personne : le module resterait parfait et le moteur ne battrait plus.
  // Le vrai systemd-notify n'est pas plus lancé ici que plus haut — un FAUX du même nom est posé en
  // tête de PATH, et il rend 0 comme le vrai quand tout va bien.
  it('app.listen() arme le battement, app.stop() le coupe', async () => {
    const faux = mjsTmp('watchdog-path-')
    writeFileSync(join(faux, 'systemd-notify'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(faux, 'systemd-notify'), 0o755)
    const memoire = { PATH: process.env.PATH, usec: process.env.WATCHDOG_USEC, wpid: process.env.WATCHDOG_PID }
    process.env.PATH          = `${faux}:${process.env.PATH}`
    process.env.WATCHDOG_USEC = '30000000'
    process.env.WATCHDOG_PID  = String(process.pid)
    const lignes: string[] = []
    try {
      const app = mjsWs({ transport: new MemoryTransport(), onLog: (_n, m) => { lignes.push(m) } })
      await app.listen()
      assert.ok(lignes.some(l => /chien de garde systemd armé/.test(l)), `listen() doit armer le battement — journal : ${JSON.stringify(lignes)}`)
      await app.stop()
    } finally {
      process.env.PATH = memoire.PATH
      if (memoire.usec === undefined) delete process.env.WATCHDOG_USEC; else process.env.WATCHDOG_USEC = memoire.usec
      if (memoire.wpid === undefined) delete process.env.WATCHDOG_PID;  else process.env.WATCHDOG_PID  = memoire.wpid
    }
  })
})
