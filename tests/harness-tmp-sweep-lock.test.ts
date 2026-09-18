// garde du HARNAIS, pas du produit : le verrou du balai global (tests/helpers/tmp-sweep.ts) doit
// reconnaître un run concurrent VIVANT, où qu'il tourne. Un sandbox donne à chaque commande son propre
// espace de PID : vu d'ici, le mocha d'une suite lancée ailleurs porte un pid qui n'existe pas
// (`kill(pid, 0)` rend ESRCH), ou le même numéro que le nôtre. Son verrou passait alors pour orphelin,
// partait, et le balayage large de fin de suite emportait les dossiers temporaires EN COURS D'USAGE de
// l'autre run — un test au hasard y virait au rouge sur un ENOENT. Chaque cas lance un vrai mocha
// enfant chargé du balai, dans un TMPDIR à lui : rien d'ici ne touche au /tmp des runs voisins.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'

const repoRoot  = join(dirname(fileURLToPath(import.meta.url)), '..')
const INVISIBLE = 2147483646  //au-delà de tout pid_max : kill(pid, 0) rend ESRCH, comme le pid d'un autre espace

// suite témoin du mocha enfant : un run voisin pose son dossier PENDANT la suite ; `homonym` pose en
// plus le verrou d'un run d'un autre espace de PID qui porte le même numéro que l'enfant
function spec(homonym = false): string {
  return [
    "import { mkdtempSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "import { tmpdir } from 'node:os'",
    "describe('run témoin', function () {",
    "  it('un run voisin pose son dossier pendant cette suite', function () {",
    homonym ? "    writeFileSync(join(tmpdir(), 'mjs-sweep-'+ process.pid +'.lock'), String(process.pid))" : '',
    "    mkdtempSync(join(tmpdir(), 'mjs-victime-'))",
    '  })',
    '})',
  ].join('\n')
}

// suite témoin du battement : le verrou de l'enfant doit être réécrit, et reposé s'il disparaît
const BEAT_SPEC = [
  "import { readdirSync, statSync, rmSync } from 'node:fs'",
  "import { join } from 'node:path'",
  "import { tmpdir } from 'node:os'",
  'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
  "describe('run témoin', function () {",
  "  it('son verrou bat', async function () {",
  "    const name = readdirSync(tmpdir()).find((n) => /^mjs-sweep-.*\\.lock$/.test(n))",
  "    if(!name) throw new Error('aucun verrou posé')",
  '    const full = join(tmpdir(), name)',
  '    const t0   = statSync(full).mtimeMs',
  '    await sleep(400)',
  "    if(!(statSync(full).mtimeMs > t0)) throw new Error('verrou jamais réécrit')",
  '    rmSync(full)',
  '    await sleep(400)',
  "    if(!readdirSync(tmpdir()).includes(name)) throw new Error('verrou retiré jamais reposé')",
  '  })',
  '})',
].join('\n')

// mocha enfant chargé du balai, TMPDIR isolé, aucune config implicite (jamais la suite entière)
function runChild(tmp: string, source: string, env: Record<string, string> = {}) {
  const specPath = join(tmp, 'spec', 'temoin.spec.mjs')
  mkdirSync(dirname(specPath), { recursive: true })
  writeFileSync(specPath, source)
  const r = spawnSync(process.execPath, [join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js'), '--no-config', '--no-package', '--require', 'tsx/esm', '--require', join(repoRoot, 'tests', 'helpers', 'tmp-sweep.ts'), '--exit', specPath], { cwd: repoRoot, env: { ...process.env, ...env, TMPDIR: tmp }, encoding: 'utf-8', timeout: 60000 })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

const victims = (tmp: string): number => readdirSync(tmp).filter((n) => n.startsWith('mjs-victime-')).length

describe('harnais — le verrou du balai reconnaît un run voisin vivant, où qu\'il tourne', function () {
  this.timeout(120000)

  it('verrou FRAIS d\'un pid invisible d\'ici (autre espace de PID) : gardé, et le dossier apparu pendant la suite survit', function () {
    const tmp  = mjsTmp('balai-verrou-invisible')
    const lock = join(tmp, `mjs-sweep-${INVISIBLE}.lock`)
    writeFileSync(lock, String(INVISIBLE))
    const r = runChild(tmp, spec())
    assert.equal(r.code, 0, r.out)
    assert.equal(existsSync(lock), true, 'le verrou du run voisin ne doit pas passer pour un orphelin')
    assert.equal(victims(tmp), 1, 'le dossier du run voisin ne doit pas être balayé sous lui')
  })

  it('verrou au MÊME numéro de pid que le nôtre, posé par un run d\'un autre espace : gardé, et le dossier survit', function () {
    const tmp = mjsTmp('balai-verrou-homonyme')
    const r   = runChild(tmp, spec(true))
    assert.equal(r.code, 0, r.out)
    assert.equal(readdirSync(tmp).filter((n) => /^mjs-sweep-\d+\.lock$/.test(n)).length, 1, 'le verrou homonyme du run voisin ne doit pas partir avec le nôtre')
    assert.equal(victims(tmp), 1, 'le dossier du run voisin ne doit pas être balayé sous lui')
  })

  it('le battement réécrit le verrou pendant la suite : sa date avance, et un verrou retiré par un autre run se repose', function () {
    const tmp = mjsTmp('balai-verrou-battement')
    const r   = runChild(tmp, BEAT_SPEC, { MJS_TEST_LOCK_BEAT_MS: '100' })
    assert.equal(r.code, 0, r.out)
  })

  it('verrou MUET depuis 1 h d\'un pid mort : orphelin retiré, et le balayage large reprend (non-régression)', function () {
    const tmp  = mjsTmp('balai-verrou-orphelin')
    const lock = join(tmp, `mjs-sweep-${INVISIBLE}.lock`)
    const old  = new Date(Date.now() - 3600000)
    writeFileSync(lock, String(INVISIBLE))
    utimesSync(lock, old, old)
    const r = runChild(tmp, spec())
    assert.equal(r.code, 0, r.out)
    assert.equal(existsSync(lock), false, 'un verrou muet d\'un pid mort est un orphelin')
    assert.equal(victims(tmp), 0, 'sans run voisin vivant, le filet balaie ce qui est apparu pendant la suite')
  })
})
