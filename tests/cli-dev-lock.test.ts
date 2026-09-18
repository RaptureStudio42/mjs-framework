// Test de régression : `acquireDevLock`
// (extrait de cli.ts vers cli/dev-lock.ts pour permettre ce test direct —
// cli.ts exécute `run(process.argv)` inconditionnellement à son top-level,
// l'importer déclencherait une vraie exécution CLI) avait 2 défauts liés :
//
//   1. TOCTOU : `existsSync` (check) puis `writeFileSync` (use) sont 2
//      syscalls séparés — 2 `mjs dev` lancés en même temps peuvent tous les
//      deux passer le check puis tous les deux écrire leur PID, le dernier
//      écrasant le premier.
//   2. `process.kill(pid, 0)` qui THROW ne signifie pas forcément "process
//      mort" : `EPERM` = VIVANT (autre utilisateur), traité à tort comme
//      "orphelin" — volerait le lock d'un process ACTIF.
//
// Fix : écriture EXCLUSIVE atomique (`flag:'wx'`) + EPERM distingué
// explicitement d'ESRCH/mort.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { acquireDevLock } from '../src/cli/dev-lock.js'

// `acquireDevLock` appelle `process.exit()` sur les chemins de conflit — on
// mocke pour intercepter SANS tuer le process de test (idiome standard pour
// tester du code CLI qui appelle process.exit).
class FakeProcessExit extends Error {
  constructor(public code: number) { super(`process.exit(${code})`) }
}

describe('cli/dev-lock — acquireDevLock : TOCTOU (wx atomique) + EPERM ≠ orphelin', function () {
  let originalExit: typeof process.exit
  let originalKill: typeof process.kill

  beforeEach(() => {
    originalExit = process.exit
    originalKill = process.kill
  })
  afterEach(() => {
    process.exit = originalExit
    process.kill = originalKill
  })

  it('aucun lock existant : acquisition normale, fichier créé avec notre PID', () => {
    const lockPath = join(mjsTmp('devlock'), '.mjs-dev.lock')
    acquireDevLock(lockPath)
    assert.ok(existsSync(lockPath))
    // DURCISSEMENT : le lockfile stocke
    // désormais `pid:starttime` (anti-recyclage de PID) — on vérifie le pid.
    assert.equal(readFileSync(lockPath, 'utf-8').trim().split(':')[0], String(process.pid))
  })

  it("lock déjà présent avec un PID VIVANT (process.kill ne throw pas) → refuse, n'écrase PAS (TOCTOU fermé)", () => {
    const lockPath = join(mjsTmp('devlock'), '.mjs-dev.lock')
    const otherPid = process.pid + 1  // n'a pas besoin d'exister réellement, process.kill est mocké
    writeFileSync(lockPath, String(otherPid))

    process.kill = ((_pid: number, _sig?: any) => true) as any  // simule "vivant" (ne throw pas)
    let exitCode: number | undefined
    process.exit = ((code?: number) => { throw new FakeProcessExit(code ?? 0) }) as any

    assert.throws(() => acquireDevLock(lockPath), (e: any) => { exitCode = e.code; return e instanceof FakeProcessExit })
    assert.equal(exitCode, 1, "un lock d'un process VIVANT doit refuser (exit 1), jamais écraser silencieusement")
    assert.equal(readFileSync(lockPath, 'utf-8').trim(), String(otherPid),
      "AVANT le fix (TOCTOU) : le fichier pouvait être écrasé avec NOTRE pid même si l'autre process est vivant")
  })

  it("lock avec un PID mort (ESRCH) → traité comme orphelin, récupéré normalement", () => {
    const lockPath = join(mjsTmp('devlock'), '.mjs-dev.lock')
    writeFileSync(lockPath, String(process.pid + 1))

    process.kill = ((_pid: number, _sig?: any) => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    }) as any

    acquireDevLock(lockPath)  // ne doit PAS appeler process.exit
    assert.equal(readFileSync(lockPath, 'utf-8').trim().split(':')[0], String(process.pid),
      'le lock orphelin (process mort) doit être récupéré — notre PID doit maintenant y figurer')
  })

  it("lock avec un PID qui répond EPERM (vivant, autre utilisateur) → PAS traité comme orphelin, refuse", () => {
    const lockPath = join(mjsTmp('devlock'), '.mjs-dev.lock')
    const otherPid = process.pid + 1
    writeFileSync(lockPath, String(otherPid))

    process.kill = ((_pid: number, _sig?: any) => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    }) as any
    let exitCode: number | undefined
    process.exit = ((code?: number) => { throw new FakeProcessExit(code ?? 0) }) as any

    assert.throws(() => acquireDevLock(lockPath), (e: any) => { exitCode = e.code; return e instanceof FakeProcessExit })
    assert.equal(exitCode, 1,
      "AVANT le fix : EPERM était traité identiquement à ESRCH (catch générique) → le lock d'un process VIVANT (juste pas signalable) était volé")
    assert.equal(readFileSync(lockPath, 'utf-8').trim(), String(otherPid),
      "le lockfile de l'autre process (vivant) ne doit PAS être écrasé")
  })

  // Régression DURCISSEMENT : un lock dont le
  // PID est VIVANT mais a été RÉUTILISÉ (l'ancien mjs dev est mort, le noyau a
  // réattribué son PID à un autre process) était refusé À TORT (isAlive répond
  // vrai pour le squatteur). Le lock stocke désormais `pid:starttime` — un
  // starttime qui ne matche plus = PID recyclé = orphelin récupérable.
  it("lock d'un PID VIVANT mais RECYCLÉ (starttime différent) → récupéré, pas refusé (09-18b)", () => {
    // /proc requis (Linux). PID 1 (init) existe toujours, starttime lisible & stable.
    let initStart: string | null = null
    try {
      const s = readFileSync('/proc/1/stat', 'utf-8')
      initStart = s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null
    } catch { /* pas de /proc */ }
    if (initStart == null) return  // environnement sans /proc → test non pertinent

    const lockPath = join(mjsTmp('devlock'), '.mjs-dev.lock')
    // lock du PID 1 mais avec un starttime BIDON (≠ le vrai) → simule un PID réutilisé.
    writeFileSync(lockPath, `1:${initStart}999`)
    process.kill = ((_pid: number, _sig?: any) => true) as any  // PID 1 « vivant »
    process.exit = ((code?: number) => { throw new FakeProcessExit(code ?? 0) }) as any

    acquireDevLock(lockPath)  // ne doit PAS exit : starttime ≠ → orphelin recyclé → récupéré
    assert.equal(readFileSync(lockPath, 'utf-8').trim().split(':')[0], String(process.pid),
      'un PID recyclé (starttime différent du lock) doit être traité comme orphelin et le lock récupéré')
  })

  // Complément structurel pour le TOCTOU : reproduire la VRAIE race (2
  // process qui tentent l'écriture à la nanoseconde près) n'est pas
  // fiablement testable sans synchronisation artificielle — la garantie
  // d'atomicité de `O_EXCL` est un contrat POSIX établi, pas quelque chose
  // qu'on prouve par un test de timing (qui serait flaky par nature). Les
  // tests comportementaux ci-dessus couvrent déjà le résultat OBSERVABLE
  // (jamais d'écrasement silencieux) ; cette vérification ferme la boucle
  // en confirmant que le MÉCANISME (écriture exclusive, pas check-puis-write)
  // est bien en place.
  it("tryClaim utilise bien une écriture EXCLUSIVE (flag 'wx'), pas un check-puis-write racé", () => {
    const src = readFileSync(new URL('../src/cli/dev-lock.ts', import.meta.url), 'utf-8')
    assert.match(src, /writeFileSync\([\s\S]{0,80}\{\s*flag:\s*'wx'\s*\}/,
      "AVANT le fix : `existsSync(lockPath)` (check) suivi d'un `writeFileSync` SANS 'wx' (use) — 2 syscalls séparés, fenêtre de course entre les deux")
  })

  // feature render.routes en dev (cli.ts) — `onShutdown` ferme le RenderHandler
  // AVANT que le lock ne se libère et que le process ne quitte. `process.on` est
  // mocké (capture le listener au lieu de l'enregistrer pour de vrai sur LE
  // process de test) : on simule ainsi un SIGINT sans jamais toucher le vrai
  // process, ni laisser un listener réel accroché après le test.
  describe('onShutdown (feature render.routes en dev)', () => {
    let originalOn: typeof process.on

    beforeEach(() => { originalOn = process.on })
    afterEach(() => { process.on = originalOn })

    it('SIGINT : onShutdown tourne AVANT process.exit, et le lock est bien libéré ensuite', async () => {
      const lockPath = join(mjsTmp('devlock'), '.mjs-dev.lock')
      const captured: Record<string, (...a: any[]) => any> = {}
      process.on = ((event: string, listener: (...a: any[]) => any) => {
        if (event === 'SIGINT' || event === 'SIGTERM' || event === 'SIGHUP') captured[event] = listener
        return process
      }) as any
      process.exit = ((code?: number) => { throw new FakeProcessExit(code ?? 0) }) as any

      const order: string[] = []
      acquireDevLock(lockPath, async () => { order.push('onShutdown') })
      assert.ok(captured.SIGINT, 'un listener SIGINT doit avoir été enregistré')

      await assert.rejects(captured.SIGINT(), FakeProcessExit, 'process.exit(0) doit être atteint après onShutdown')
      order.push('exit')   // captured.SIGINT() n'a pu throw qu'APRÈS avoir attendu onShutdown (await interne)
      assert.deepEqual(order, ['onShutdown', 'exit'], 'onShutdown doit tourner AVANT process.exit')
      assert.equal(existsSync(lockPath), false, 'le lock doit être libéré (cleanup) après le shutdown')
    })

    it('SIGTERM/SIGHUP : le lock se libère MÊME si onShutdown throw (best-effort, jamais bloquant)', async () => {
      const lockPath = join(mjsTmp('devlock'), '.mjs-dev.lock')
      const captured: Record<string, (...a: any[]) => any> = {}
      process.on = ((event: string, listener: (...a: any[]) => any) => {
        if (event === 'SIGINT' || event === 'SIGTERM' || event === 'SIGHUP') captured[event] = listener
        return process
      }) as any
      process.exit = ((code?: number) => { throw new FakeProcessExit(code ?? 0) }) as any

      acquireDevLock(lockPath, async () => { throw new Error('close() du RenderHandler en échec') })
      await assert.rejects(captured.SIGTERM(), FakeProcessExit,
        'un onShutdown qui échoue ne doit JAMAIS empêcher process.exit — le lock est la seule responsabilité non négociable')
      assert.equal(existsSync(lockPath), false, 'le lock doit être libéré malgré l\'échec de onShutdown')
    })

    it('sans onShutdown fourni (défaut) : comportement HISTORIQUE inchangé — SIGINT libère juste le lock', async () => {
      const lockPath = join(mjsTmp('devlock'), '.mjs-dev.lock')
      const captured: Record<string, (...a: any[]) => any> = {}
      process.on = ((event: string, listener: (...a: any[]) => any) => {
        if (event === 'SIGINT') captured[event] = listener
        return process
      }) as any
      process.exit = ((code?: number) => { throw new FakeProcessExit(code ?? 0) }) as any

      acquireDevLock(lockPath)   // pas de 2e argument
      await assert.rejects(captured.SIGINT(), FakeProcessExit)
      assert.equal(existsSync(lockPath), false)
    })
  })
})
