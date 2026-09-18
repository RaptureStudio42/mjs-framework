// garde du HARNAIS, pas du produit : sans systemd utilisateur (CI, conteneur, bac à sable), script/test-enclos.sh
// lançait mocha SANS plafond mémoire, et une assertion qui inspecte un nœud happy-dom (14 Go en deux secondes)
// n'y était arrêtée par rien ; garde de repli : l'arbre de processus de mocha est relevé toutes les 0,5 s et tué
// au-delà de MJS_TEST_MEM, avec le même verdict que l'enclos. Chaque cas lance le vrai script sur une suite témoin,
// dans un TMPDIR à lui ; les bombes s'arrêtent seules après 30 s, garde cassée ou non. Là où l'enclos cgroup existe,
// c'est lui qui arrête la bombe : les assertions valent pour les deux chemins, sauf le plafond illisible

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const script   = join(repoRoot, 'script', 'test-enclos.sh')

// suite témoin passée au vrai script, TMPDIR isolé, aucune config implicite (jamais la suite entière)
function runScript(tmp: string, source: string, mem: string) {
  const specPath = join(tmp, 'spec', 'temoin.spec.mjs')
  mkdirSync(dirname(specPath), { recursive: true })
  mkdirSync(join(tmp, 'tmp'), { recursive: true })
  writeFileSync(specPath, source)
  const t0 = Date.now()
  const r  = spawnSync('bash', [script, '--no-config', '--no-package', specPath], { cwd: repoRoot, env: { ...process.env, MJS_TEST_MEM: mem, MJS_TEST_MAXSEC: '0', TMPDIR: join(tmp, 'tmp') }, encoding: 'utf-8', timeout: 120000 })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), ms: Date.now() - t0 }
}

// vivant = présent et pas zombie : un enfant tué avec son parent est rattaché au pid 1, qui ne le ramasse qu'un
// instant plus tard — `kill(pid, 0)` le verrait encore
const alive = (pid: number): boolean => {
  try { return !/^\d+ \(.*\) [ZX]/s.test(readFileSync(`/proc/${pid}/stat`, 'utf-8')) }
  catch (e: any) { if(e.code === 'ENOENT') return false; throw e }
}

const enclosAvailable = (): boolean => spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--', '/bin/true'], { stdio: 'ignore' }).status === 0

const SLEEP = 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))'

describe('harnais — test-enclos.sh arrête un run qui crève MJS_TEST_MEM, enclos cgroup ou non', function () {
  this.timeout(180000)

  it('bombe dans mocha (1,6 Go en 2 s, puis 30 s d\'attente) : run tué bien avant la fin, verdict de l\'enclos', function () {
    const tmp = mjsTmp('enclos-garde-bombe')
    const r   = runScript(tmp, [
      SLEEP,
      "describe('run témoin', function () {",
      "  it('bombe', async function () {",
      '    this.timeout(0)',
      '    const keep = []',
      '    for(let i = 0; i < 100; i++) { keep.push(Buffer.alloc(16 * 1024 * 1024, 1)); await sleep(20) }',
      '    await sleep(30000)',
      '  })',
      '})',
    ].join('\n'), '600M')
    assert.ok(r.code !== null && r.code >= 128, `code ${r.code}, attendu ≥ 128 :\n${r.out}`)
    assert.match(r.out, /💥 run tué[\s\S]*plafond 600M crevé/)
    assert.ok(r.ms < 25000, `run arrêté en ${r.ms} ms : la bombe a tenu jusqu'au bout`)
  })

  it('mémoire prise par un processus ENFANT de mocha : l\'arbre entier compte, et l\'enfant meurt avec le run', function () {
    const tmp = mjsTmp('enclos-garde-enfant')
    const r   = runScript(tmp, [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "import { tmpdir } from 'node:os'",
      SLEEP,
      "describe('run témoin', function () {",
      "  it('enfant gourmand', async function () {",
      '    this.timeout(0)',
      "    const code  = 'const k = []; for(let i = 0; i < 75; i++) k.push(Buffer.alloc(16 * 1024 * 1024, 1)); setTimeout(() => {}, 30000)'",
      "    const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' })",
      "    writeFileSync(join(tmpdir(), 'enfant.pid'), String(child.pid))",
      '    await sleep(32000)',
      '  })',
      '})',
    ].join('\n'), '600M')
    const pid = Number(readFileSync(join(tmp, 'tmp', 'enfant.pid'), 'utf-8'))
    assert.ok(r.code !== null && r.code >= 128, `code ${r.code}, attendu ≥ 128 :\n${r.out}`)
    assert.ok(r.ms < 25000, `run arrêté en ${r.ms} ms : l'enfant n'a pas été compté`)
    assert.equal(alive(pid), false, `l'enfant ${pid} a survécu au run`)
  })

  it('script tué seul (pas son groupe) pendant le run : la garde continue de surveiller mocha, la bombe meurt quand même', async function () {
    const tmp      = mjsTmp('enclos-garde-script-tue')
    const specPath = join(tmp, 'spec', 'temoin.spec.mjs')
    const pidFile  = join(tmp, 'tmp', 'mocha.pid')
    mkdirSync(dirname(specPath), { recursive: true })
    mkdirSync(join(tmp, 'tmp'), { recursive: true })
    writeFileSync(specPath, [
      "import { writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "import { tmpdir } from 'node:os'",
      SLEEP,
      "describe('run témoin', function () {",
      "  it('bombe différée', async function () {",
      '    this.timeout(0)',
      "    writeFileSync(join(tmpdir(), 'mocha.pid'), String(process.pid))",
      '    await sleep(2500)',
      '    const keep = []',
      '    for(let i = 0; i < 100; i++) { keep.push(Buffer.alloc(16 * 1024 * 1024, 1)); await sleep(20) }',
      '    await sleep(30000)',
      '  })',
      '})',
    ].join('\n'))
    const child = spawn('bash', [script, '--no-config', '--no-package', specPath], { cwd: repoRoot, env: { ...process.env, MJS_TEST_MEM: '600M', MJS_TEST_MAXSEC: '0', TMPDIR: join(tmp, 'tmp') }, stdio: 'ignore' })
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    for(let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(100)
    assert.ok(existsSync(pidFile), 'mocha n\'a jamais démarré')
    const mocha = Number(readFileSync(pidFile, 'utf-8'))
    process.kill(child.pid!, 'SIGKILL')
    const t0 = Date.now()
    while(alive(mocha) && Date.now() - t0 < 20000) await sleep(200)
    const vivant = alive(mocha)
    if(vivant) process.kill(mocha, 'SIGKILL')
    assert.equal(vivant, false, 'mocha a survécu 20 s à la mort du script : plus rien ne le surveillait')
  })

  it('numéro de mocha repris par un autre processus (date de départ différente, même d\'un top d\'horloge) : le relevé ne compte plus rien, donc rien à tuer', function () {
    const text = readFileSync(script, 'utf-8')
    const fns  = ['STARTED_AWK=', 'started_at() {', 'tree_rss() {'].map((head) => text.match(new RegExp('^' + head.replace(/[()]/g, '\\$&') + '[\\s\\S]*?^\\}\'?$', 'm')))
    assert.ok(fns.every(Boolean), 'STARTED_AWK, started_at ou tree_rss introuvable dans script/test-enclos.sh')
    const probe = [
      ...fns.map((m) => m![0]),
      'start="$(started_at $$)"',
      'echo "même départ : $(tree_rss $$ "$start" | wc -l)"',
      'echo "autre départ : $(tree_rss $$ "$(( start + 1 ))" | wc -l)"',
    ].join('\n')
    const r = spawnSync('bash', ['-c', probe], { encoding: 'utf-8' })
    assert.match(r.stdout, /même départ : [1-9]/, r.stdout + r.stderr)
    assert.match(r.stdout, /autre départ : 0/, r.stdout + r.stderr)
  })

  it('run sage (50 Mo tenus 2 s) : rien n\'est arrêté, code 0', function () {
    const tmp = mjsTmp('enclos-garde-sage')
    const r   = runScript(tmp, [
      SLEEP,
      "describe('run témoin', function () {",
      "  it('sage', async function () {",
      '    this.timeout(10000)',
      '    const keep = Buffer.alloc(50 * 1024 * 1024, 1)',
      '    await sleep(2000)',
      '    if(keep.length === 0) throw new Error("tampon vide")',
      '  })',
      '})',
    ].join('\n'), '600M')
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /💥/)
  })

  it('sans enclos, plafond illisible : garde impossible annoncée, run lancé quand même', function () {
    if(enclosAvailable()) this.skip()
    const tmp = mjsTmp('enclos-garde-illisible')
    const r   = runScript(tmp, "describe('run témoin', function () { it('rien', function () {}) })", 'quatre-gigas')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /garde mémoire de repli impossible[\s\S]*quatre-gigas/)
  })
})
