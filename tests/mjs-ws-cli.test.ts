// Tests de la commande `mjs ws` — MJS-WS (cf. docs/23-mjs-ws.md
// §7 + src/cli/ws.ts). Trois niveaux : (a) validation de la section `ws` de
// mjs.config.json (bundler/config.ts, MÊME patron strict que `runtime`/`lint`) ;
// (b) fonctions pures de cli/ws.ts (résolution d'entry, contrat, priorités
// port/host/heartbeat/limits) — testables sans toucher le disque ni un
// transport ; (c) boucle complète via runWsCommand() contre un VRAI client
// µ.socket sur MemoryTransport (même technique que mjs-ws-core.test.ts),
// fixtures dans un dossier TEMPORAIRE (fs.mkdtemp — jamais dans le dépôt).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { findConfig } from '../src/bundler/config.js'
import { resolveEntryPath, readEntryContract, buildRunPlan, runWsCommand } from '../src/cli/ws.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot  = join(__dirname, '..')
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// dossiers temporaires créés par ce fichier — nettoyés une seule fois à la fin
// (jamais de fixture dans le dépôt, cf. feedback_scratch_cleanup_glob_precision)
const tmpDirs: string[] = []
function freshDir(prefix: string): string {
  const d = mjsTmp(prefix)
  tmpDirs.push(d)
  return d
}
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

// --- même technique que tests/mjs-ws-core.test.ts : VRAI client µ.socket sur MemoryTransport ---
function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}
function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

// client BRUT (protocole à la main) — utilisé pour les tests de rechargement :
// évite toute ambiguïté avec le reconnect automatique du VRAI client (µ:bye
// interdit la reconnexion cliente, cf. core.ts — pas ce qu'on veut observer ici)
async function rawRequestClient(transport: MemoryTransport, url: string) {
  const ws: any = transport.connect({ url })
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>()
  ws.onmessage = (ev: any) => {
    const msg = JSON.parse(ev.data)
    if (msg.t === 'µ:ack' && pending.has(msg.id)) {
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.e) p.reject(msg.p); else p.resolve(msg.p)
    }
  }
  await tick()
  ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, resub: [], rooms: [] } }))
  await tick()
  let seq = 0
  return {
    ws,
    request(type: string, p: any = {}): Promise<any> {
      const id = 'r' + (++seq)
      return new Promise((resolvePromise, reject) => {
        pending.set(id, { resolve: resolvePromise, reject })
        ws.send(JSON.stringify({ t: type, p, id }))
      })
    },
  }
}

// capture console.log/warn/error — même principe que cli-init-scaffold-hints.test.ts,
// version qui reste active pendant un `await` (rechargement asynchrone)
function patchConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log   = (...a: any[]) => { lines.push(a.join(' ')) }
  console.warn  = (...a: any[]) => { lines.push(a.join(' ')) }
  console.error = (...a: any[]) => { lines.push(a.join(' ')) }
  return { lines, restore: () => { console.log = orig.log; console.warn = orig.warn; console.error = orig.error } }
}

// ============================================================================
// (a) mjs.config.json — section `ws`
// ============================================================================

describe('mjs.config.json — section `ws` (validation stricte, patron `runtime`)', () => {
  function writeConfig(config: Record<string, unknown>): string {
    const root = freshDir('cfg-ws')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(config))
    return root
  }

  it('accepte une section ws complète valide', () => {
    const root = writeConfig({ ws: { entry: 'server/ws.js', port: 4001, host: '0.0.0.0', heartbeat: 20000, limits: { rate: 10, burst: 20, kickAfter: 5, maxPayload: 1000, maxBuffered: 2000 } } })
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.ws?.entry, 'server/ws.js')
    assert.equal(found!.config.ws?.port, 4001)
    assert.equal(found!.config.ws?.limits?.rate, 10)
  })

  it("throw sur ws.X inconnu, avec suggestion orthographique ('entrry' → 'entry')", () => {
    const root = writeConfig({ ws: { entrry: 'ws.js' } })
    assert.throws(() => findConfig(root), /ws\.entrry : clé inconnue.*tu voulais dire 'entry'/)
  })

  it('throw sur ws non-objet', () => {
    const root = writeConfig({ ws: 'ws.js' })
    assert.throws(() => findConfig(root), /'ws' doit être un objet/)
  })

  it('throw sur ws.port hors bornes TCP', () => {
    const root = writeConfig({ ws: { port: 99999 } })
    assert.throws(() => findConfig(root), /ws\.port doit être un entier entre 1 et 65535/)
  })

  it('throw sur ws.port type faux (string)', () => {
    const root = writeConfig({ ws: { port: '4000' } })
    assert.throws(() => findConfig(root), /ws\.port doit être un entier entre 1 et 65535/)
  })

  it('throw sur ws.host non-string', () => {
    const root = writeConfig({ ws: { host: 1234 } })
    assert.throws(() => findConfig(root), /ws\.host doit être une chaîne/)
  })

  it('throw sur ws.entry non-string', () => {
    const root = writeConfig({ ws: { entry: 42 } })
    assert.throws(() => findConfig(root), /ws\.entry doit être une chaîne/)
  })

  it('throw sur ws.heartbeat <= 0', () => {
    const root = writeConfig({ ws: { heartbeat: 0 } })
    assert.throws(() => findConfig(root), /ws\.heartbeat doit être un entier > 0/)
  })

  // sessionExclusive — 2 modes : booléen true/false OU chaîne 'replace'/'refuse'
  // ('true' ≡ 'replace' résolu au runtime, cf. mjs-ws/index.ts::resolveSessionExclusiveOption)
  it("ws.sessionExclusive : accepte true/false/'replace'/'refuse', throw sur valeur invalide", () => {
    assert.equal(findConfig(writeConfig({ ws: { sessionExclusive: true } }))!.config.ws?.sessionExclusive, true)
    assert.equal(findConfig(writeConfig({ ws: { sessionExclusive: false } }))!.config.ws?.sessionExclusive, false)
    assert.equal(findConfig(writeConfig({ ws: { sessionExclusive: 'replace' } }))!.config.ws?.sessionExclusive, 'replace')
    assert.equal(findConfig(writeConfig({ ws: { sessionExclusive: 'refuse' } }))!.config.ws?.sessionExclusive, 'refuse')
    const root = writeConfig({ ws: { sessionExclusive: 'oui' } })
    assert.throws(() => findConfig(root), /ws\.sessionExclusive invalide : "oui"[\s\S]*Valeurs valides : true, false, replace, refuse/)
  })

  it('throw sur ws.limits non-objet', () => {
    const root = writeConfig({ ws: { limits: 5 } })
    assert.throws(() => findConfig(root), /ws\.limits doit être un objet/)
  })

  it("throw sur ws.limits.X inconnu, avec suggestion orthographique ('ratee' → 'rate')", () => {
    const root = writeConfig({ ws: { limits: { ratee: 5 } } })
    assert.throws(() => findConfig(root), /ws\.limits\.ratee : clé inconnue.*tu voulais dire 'rate'/)
  })

  it('throw sur ws.limits.rate <= 0 (0 refusé, entiers > 0 uniquement)', () => {
    const root = writeConfig({ ws: { limits: { rate: 0 } } })
    assert.throws(() => findConfig(root), /ws\.limits\.rate doit être un entier > 0/)
  })

  it('throw sur ws.limits.maxPayload non entier (flottant)', () => {
    const root = writeConfig({ ws: { limits: { maxPayload: 100.5 } } })
    assert.throws(() => findConfig(root), /ws\.limits\.maxPayload doit être un entier > 0/)
  })

  // Régression MAJEUR potentielle : `ws` DOIT être déclaré dans KNOWN_KEYS
  // top-level, sinon toute section `ws` ferait échouer la validation racine
  // AVANT même d'atteindre validateWsConfig.
  it("le top-level accepte 'ws' (n'était pas dans KNOWN_KEYS auparavant)", () => {
    const root = writeConfig({ sourceDir: 'src', ws: { port: 4000 } })
    assert.doesNotThrow(() => findConfig(root))
  })
})

// ============================================================================
// (b) cli/ws.ts — fonctions pures
// ============================================================================

describe('cli/ws — resolveEntryPath (--entry > ws.entry > ws.server.mjs > server/ws.server.mjs > ws.js > server/ws.js)', () => {
  it('--entry prioritaire même si la config ET les défauts existent', () => {
    const root = freshDir('ws-entry-prio')
    writeFileSync(join(root, 'ws.js'), '// défaut\n')
    writeFileSync(join(root, 'custom.js'), '// custom\n')
    const p = resolveEntryPath(root, 'custom.js', 'ws.js')
    assert.equal(p, join(root, 'custom.js'))
  })

  it("--entry pointant vers un fichier absent → erreur immédiate (PAS de repli sur les défauts existants)", () => {
    const root = freshDir('ws-entry-missing')
    writeFileSync(join(root, 'ws.js'), '// défaut, ne doit PAS être choisi\n')
    assert.throws(() => resolveEntryPath(root, 'nope.js', undefined), /--entry 'nope\.js'.*introuvable/s)
  })

  it("ws.entry (config) prioritaire sur les défauts quand --entry absent", () => {
    const root = freshDir('ws-entry-config')
    writeFileSync(join(root, 'ws.js'), '// défaut\n')
    mkdirSync(join(root, 'custom'), { recursive: true })
    writeFileSync(join(root, 'custom', 'srv.js'), '// config\n')
    const p = resolveEntryPath(root, undefined, 'custom/srv.js')
    assert.equal(p, join(root, 'custom', 'srv.js'))
  })

  it("défaut 'ws.js' choisi quand rien d'autre n'est spécifié", () => {
    const root = freshDir('ws-entry-default1')
    writeFileSync(join(root, 'ws.js'), '// défaut\n')
    const p = resolveEntryPath(root, undefined, undefined)
    assert.equal(p, join(root, 'ws.js'))
  })

  it("défaut 'server/ws.js' choisi quand 'ws.js' est absent", () => {
    const root = freshDir('ws-entry-default2')
    mkdirSync(join(root, 'server'), { recursive: true })
    writeFileSync(join(root, 'server', 'ws.js'), '// défaut serveur\n')
    const p = resolveEntryPath(root, undefined, undefined)
    assert.equal(p, join(root, 'server', 'ws.js'))
  })

  it("introuvable (aucun candidat) → erreur claire qui IMPRIME un squelette minimal au dialecte des composants", () => {
    const root = freshDir('ws-entry-none')
    assert.throws(() => resolveEntryPath(root, undefined, undefined), (err: any) => {
      assert.match(err.message, /aucun fichier d'entry trouvé/)
      assert.match(err.message, /ws\.server\.mjs, server\/ws\.server\.mjs, ws\.js, ws\.civet, server\/ws\.js, server\/ws\.civet/)
      assert.match(err.message, /ws\.server\.mjs/, "le message doit recommander 'ws.server.mjs'")
      assert.match(err.message, /pong = -> 'pong'/, 'le squelette doit montrer une assignation nue')
      assert.match(err.message, /export default/)
      assert.match(err.message, /setup: \(app\) ->/)
      return true
    })
  })
})

describe('cli/ws — readEntryContract (contrat de l\'entry)', () => {
  it("throw si le default export est absent", () => {
    assert.throws(() => readEntryContract({}, '/fake/ws.js', () => {}), /doit faire 'export default \{ \.\.\. \}'.*aucun export par défaut/s)
  })

  it("throw si le default export n'est pas un objet (ex. une fonction)", () => {
    assert.throws(() => readEntryContract({ default: () => {} }, '/fake/ws.js', () => {}), /doit faire 'export default \{ \.\.\. \}'/)
  })

  it("throw si le default export est un tableau", () => {
    assert.throws(() => readEntryContract({ default: [] }, '/fake/ws.js', () => {}), /un tableau/)
  })

  it("throw si 'setup' n'est pas une fonction", () => {
    assert.throws(() => readEntryContract({ default: { setup: 42 } }, '/fake/ws.js', () => {}), /'setup' doit être une fonction/)
  })

  it('extrait les options + setup normalement (cas nominal)', () => {
    const setupFn = () => {}
    const warns: string[] = []
    const { options, setup } = readEntryContract({ default: { heartbeat: 5000, setup: setupFn } }, '/fake/ws.js', m => warns.push(m))
    assert.equal(options.heartbeat, 5000)
    assert.equal(setup, setupFn)
    assert.deepEqual(warns, [])
  })

  it("chacune des 3 clés réservées (port/host/onLog) déclenche EXACTEMENT le warn attendu et est retirée des options", () => {
    for (const key of ['port', 'host', 'onLog']) {
      const warns: string[] = []
      const { options } = readEntryContract({ default: { [key]: 'peu-importe' } }, '/fake/ws.js', m => warns.push(m))
      assert.deepEqual(warns, [`entry.${key} ignorée : gérée par le CLI/la config`])
      assert.ok(!(key in options), `${key} ne doit PAS survivre dans les options transmises à mjsWs()`)
    }
  })

  it("'transport' n'est PLUS réservée (façade transport ouverte) : aucun warn, la valeur (une instance) traverse telle quelle", () => {
    const warns: string[] = []
    const fakeTransportInstance = { onConnection() {}, start: async () => {}, stop: async () => {} }
    const { options } = readEntryContract({ default: { transport: fakeTransportInstance } }, '/fake/ws.js', m => warns.push(m))
    assert.deepEqual(warns, [])
    assert.equal(options.transport, fakeTransportInstance)
  })
})

describe('cli/ws — buildRunPlan (priorités port/host/heartbeat/limits)', () => {
  const noWarn = () => { throw new Error('aucun warn attendu ici') }

  it("verifyOrigin : défini dans l'entry (prédicat) ET dans mjs.config.json (tableau) → l'entry prime EN BLOC + warn explicite", () => {
    const warns: string[] = []
    const predicat = () => true
    const plan = buildRunPlan({ options: { verifyOrigin: predicat } }, { verifyOrigin: ['https://exemple.com'] }, undefined, m => warns.push(m))
    assert.equal(plan.options.verifyOrigin, predicat)
    assert.ok(warns.some(w => /verifyOrigin.*entry prime/.test(w)))
  })

  it('verifyOrigin : défini SEULEMENT dans mjs.config.json (ws.verifyOrigin) → le tableau traverse sans warn', () => {
    const plan = buildRunPlan({ options: {} }, { verifyOrigin: ['https://exemple.com'] }, undefined, noWarn)
    assert.deepEqual(plan.options.verifyOrigin, ['https://exemple.com'])
  })

  it("transport : défini dans l'entry (instance) ET dans mjs.config.json (chaîne) → l'entry prime + warn explicite", () => {
    const warns: string[] = []
    const fakeInstance = { onConnection() {}, start: async () => {}, stop: async () => {} }
    const plan = buildRunPlan({ options: { transport: fakeInstance } }, { transport: 'uws' }, undefined, m => warns.push(m))
    assert.equal(plan.options.transport, fakeInstance)
    assert.ok(warns.some(w => /transport.*entry prime/.test(w)))
  })

  it('transport : défini SEULEMENT dans mjs.config.json (ws.transport) → la chaîne traverse sans warn', () => {
    const plan = buildRunPlan({ options: {} }, { transport: 'uws' }, undefined, noWarn)
    assert.equal(plan.options.transport, 'uws')
  })

  it("transport : absent des deux → undefined (mjsWs() applique alors son propre défaut 'ws')", () => {
    const plan = buildRunPlan({ options: {} }, undefined, undefined, noWarn)
    assert.equal(plan.options.transport, undefined)
  })

  it('port : --port prioritaire sur ws.port et sur le défaut 4000', () => {
    const plan = buildRunPlan({ options: {} }, { port: 5000 }, 6000, noWarn)
    assert.equal(plan.port, 6000)
  })

  it('port : ws.port utilisé si --port absent', () => {
    const plan = buildRunPlan({ options: {} }, { port: 5000 }, undefined, noWarn)
    assert.equal(plan.port, 5000)
  })

  it('port : défaut 4000 si rien de spécifié', () => {
    const plan = buildRunPlan({ options: {} }, undefined, undefined, noWarn)
    assert.equal(plan.port, 4000)
  })

  it('host : pris de ws.host, défaut 127.0.0.1 si absent', () => {
    assert.equal(buildRunPlan({ options: {} }, { host: '0.0.0.0' }, undefined, noWarn).host, '0.0.0.0')
    assert.equal(buildRunPlan({ options: {} }, undefined, undefined, noWarn).host, '127.0.0.1')
  })

  it("heartbeat : défini SEULEMENT dans l'entry → utilisé sans warn", () => {
    const plan = buildRunPlan({ options: { heartbeat: 9999 } }, undefined, undefined, noWarn)
    assert.equal(plan.heartbeat, 9999)
  })

  it("heartbeat : défini SEULEMENT dans la config → utilisé sans warn", () => {
    const plan = buildRunPlan({ options: {} }, { heartbeat: 8888 }, undefined, noWarn)
    assert.equal(plan.heartbeat, 8888)
  })

  it("heartbeat : défini dans LES DEUX → l'entry prime + warn explicite", () => {
    const warns: string[] = []
    const plan = buildRunPlan({ options: { heartbeat: 111 } }, { heartbeat: 222 }, undefined, m => warns.push(m))
    assert.equal(plan.heartbeat, 111)
    assert.ok(warns.some(w => /heartbeat.*entry prime/.test(w)))
  })

  it('heartbeat : absent des deux → DEFAULT_HEARTBEAT (15000)', () => {
    const plan = buildRunPlan({ options: {} }, undefined, undefined, noWarn)
    assert.equal(plan.heartbeat, 15000)
  })

  it("limits : défini dans LES DEUX → l'entry prime EN BLOC (pas de fusion clé à clé) + warn", () => {
    const warns: string[] = []
    const plan = buildRunPlan({ options: { limits: { rate: 1 } } }, { limits: { rate: 2, burst: 2 } }, undefined, m => warns.push(m))
    assert.equal(plan.limits.rate, 1)
    assert.equal(plan.limits.burst, 80)   // DEFAULT_LIMITS.burst — PAS 2 (la config entière est écartée, pas fusionnée)
    assert.ok(warns.some(w => /limits.*entry prime/.test(w)))
  })

  it('limits : config seule → fusionnée avec DEFAULT_LIMITS (clés absentes complétées)', () => {
    const plan = buildRunPlan({ options: {} }, { limits: { rate: 7 } }, undefined, noWarn)
    assert.equal(plan.limits.rate, 7)
    assert.equal(plan.limits.burst, 80)
    assert.equal(plan.limits.maxPayload, 65536)
  })
})

// ============================================================================
// (c) runWsCommand — boucle complète (MemoryTransport injecté)
// ============================================================================

describe("cli/ws — runWsCommand : chargement d'entry (VRAI client µ.socket, MemoryTransport injecté)", function () {
  this.timeout(10000)

  it("setup(app) est appelé AVANT listen(), et un serve() déclaré dans setup() répond au vrai client", async () => {
    const root = freshDir('ws-load')
    writeFileSync(join(root, 'ws.mjs'), `export default {\n  setup(app) {\n    app.serve('ping', () => 'pong')\n  },\n}\n`)
    const transport = new MemoryTransport()
    const cap = patchConsole()
    const handle = await runWsCommand({ root, entry: 'ws.mjs' }, undefined, { transport, watch: false })
    cap.restore()
    try {
      assert.ok(cap.lines.some(l => l.includes('Ctrl-C pour arrêter')), 'la bannière doit être imprimée au démarrage')
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-load-1')
      s.connect(); await tick()
      assert.equal(s.state, 'open')
      const res = await s.request('ping', {})
      assert.equal(res, 'pong')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("clé réservée ('port') présente dans l'entry → warn explicite + ignorée, le serveur démarre quand même normalement", async () => {
    const root = freshDir('ws-reserved')
    writeFileSync(join(root, 'ws.mjs'), `export default {\n  port: 9999,\n  setup(app) {\n    app.serve('ping', () => 'pong')\n  },\n}\n`)
    const transport = new MemoryTransport()
    const cap = patchConsole()
    const handle = await runWsCommand({ root, entry: 'ws.mjs' }, undefined, { transport, watch: false })
    cap.restore()
    try {
      assert.ok(cap.lines.some(l => l.includes('entry.port ignorée : gérée par le CLI/la config')), `warn attendu absent. lignes:\n${cap.lines.join('\n')}`)
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-reserved-1')
      s.connect(); await tick()
      assert.equal(await s.request('ping', {}), 'pong')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("default export absent → runWsCommand rejette avec une erreur claire", async () => {
    const root = freshDir('ws-badexport')
    writeFileSync(join(root, 'ws.mjs'), `export const rien = true\n`)
    const transport = new MemoryTransport()
    await assert.rejects(
      runWsCommand({ root, entry: 'ws.mjs' }, undefined, { transport, watch: false }),
      /doit faire 'export default \{ \.\.\. \}'/,
    )
  })
})

describe('cli/ws — bannière : ligne jeton', function () {
  this.timeout(10000)

  it("ws.token configuré dans l'entry → ligne 'jeton : balayage Xs (marge Ys)' avec les valeurs EFFECTIVES", async () => {
    const root = freshDir('ws-banner-token')
    writeFileSync(join(root, 'ws.mjs'), `export default {\n  token: { sweep: 20000, slack: 8000 },\n  setup(app) {\n    app.serve('ping', () => 'pong')\n  },\n}\n`)
    const transport = new MemoryTransport()
    const cap = patchConsole()
    const handle = await runWsCommand({ root, entry: 'ws.mjs' }, undefined, { transport, watch: false })
    cap.restore()
    try {
      assert.ok(cap.lines.some(l => l.includes('jeton : balayage 20s (marge 8s)')), `ligne jeton absente ou valeurs fausses. lignes:\n${cap.lines.join('\n')}`)
    } finally {
      await handle.stop()
    }
  })

  it("ws.token ABSENT (ni entry ni config) → aucune ligne 'jeton :' dans la bannière", async () => {
    const root = freshDir('ws-banner-notoken')
    writeFileSync(join(root, 'ws.mjs'), `export default {\n  setup(app) {\n    app.serve('ping', () => 'pong')\n  },\n}\n`)
    const transport = new MemoryTransport()
    const cap = patchConsole()
    const handle = await runWsCommand({ root, entry: 'ws.mjs' }, undefined, { transport, watch: false })
    cap.restore()
    try {
      assert.ok(!cap.lines.some(l => l.includes('jeton :')), `ligne jeton inattendue. lignes:\n${cap.lines.join('\n')}`)
    } finally {
      await handle.stop()
    }
  })
})

describe('cli/ws — rechargement à chaud (fs.watch réel, fixture réécrite sur disque)', function () {
  this.timeout(10000)

  it('nouvelle version de la fixture → nouveau comportement actif (nouvelle connexion)', async () => {
    const root = freshDir('ws-reload-ok')
    const entryPath = join(root, 'ws.mjs')
    writeFileSync(entryPath, `export default {\n  setup(app) {\n    app.serve('version', () => 'v1')\n  },\n}\n`)
    const transport = new MemoryTransport()
    const boot = patchConsole()
    const handle = await runWsCommand({ root, entry: 'ws.mjs' }, undefined, { transport })   // watch par défaut (true)
    boot.restore()
    try {
      const c1 = await rawRequestClient(transport, 'memory://reload-ok-v1')
      assert.equal(await c1.request('version'), 'v1')

      const cap = patchConsole()
      writeFileSync(entryPath, `export default {\n  setup(app) {\n    app.serve('version', () => 'v2')\n  },\n}\n`)
      await tick(600)   // 150ms debounce + import/stop/listen, marge large
      cap.restore()
      assert.ok(cap.lines.some(l => l.includes('♻️') && l.includes('redémarré')), `log de rechargement absent. lignes:\n${cap.lines.join('\n')}`)

      const c2 = await rawRequestClient(transport, 'memory://reload-ok-v2')
      assert.equal(await c2.request('version'), 'v2', 'le nouveau serveur doit refléter la v2 de la fixture')
    } finally {
      await handle.stop()
    }
  })

  it('version cassée (syntaxe invalide) → import échoue, log une erreur, l\'ANCIEN serveur continue de répondre SANS coupure', async () => {
    const root = freshDir('ws-reload-broken')
    const entryPath = join(root, 'ws.mjs')
    writeFileSync(entryPath, `export default {\n  setup(app) {\n    app.serve('version', () => 'v1')\n  },\n}\n`)
    const transport = new MemoryTransport()
    const boot = patchConsole()
    const handle = await runWsCommand({ root, entry: 'ws.mjs' }, undefined, { transport })
    boot.restore()
    try {
      const c1 = await rawRequestClient(transport, 'memory://reload-broken-1')
      assert.equal(await c1.request('version'), 'v1')

      const cap = patchConsole()
      writeFileSync(entryPath, `export default {\n  setup(app) {\n`)   // syntaxe cassée intentionnelle
      await tick(600)
      cap.restore()
      assert.ok(cap.lines.some(l => /rechargement ignoré.*import de l'entry en échec/.test(l)), `erreur de rechargement absente. lignes:\n${cap.lines.join('\n')}`)
      assert.ok(cap.lines.some(l => l.includes("l'ancien serveur continue de tourner")))

      // la connexion PRÉ-EXISTANTE n'a jamais été coupée (aucun app.stop() n'a eu lieu)
      assert.equal(await c1.request('version'), 'v1', "l'ancien serveur doit répondre EXACTEMENT comme avant — zéro coupure")
    } finally {
      await handle.stop()
    }
  })

  it('rafale de changements PENDANT un import lent → un seul rechargement final, la bonne version gagne, la génération périmée est jetée', async () => {
    const root = freshDir('ws-reload-race')
    const entryPath = join(root, 'ws.mjs')
    writeFileSync(entryPath, `export default {\n  setup(app) {\n    app.serve('version', () => 'v1')\n  },\n}\n`)
    const transport = new MemoryTransport()
    const boot = patchConsole()
    const handle = await runWsCommand({ root, entry: 'ws.mjs' }, undefined, { transport })   // watch par défaut (true)
    boot.restore()
    try {
      const c1 = await rawRequestClient(transport, 'memory://reload-race-v1')
      assert.equal(await c1.request('version'), 'v1')

      const cap = patchConsole()
      // v2 : import délibérément LENT (top-level await 400ms, supporté par l'ESM natif de Node)
      // — laisse une fenêtre où son import est ENCORE EN VOL quand d'autres changements arrivent.
      writeFileSync(entryPath, `await new Promise(r => setTimeout(r, 400))\nexport default {\n  setup(app) {\n    app.serve('version', () => 'v2')\n  },\n}\n`)
      await tick(200)   // laisse le debounce (150ms) déclencher l'import de v2 — TOUJOURS en vol ensuite (400ms)
      // deux changements successifs PENDANT que l'import de v2 tourne encore (gap > 150ms entre
      // les deux pour forcer 2 déclenchements SÉPARÉS du debounce) — doivent coalescer en
      // EXACTEMENT un rechargement supplémentaire (pas deux), et v2 (périmée à sa résolution)
      // doit être jetée sans jamais redémarrer le serveur.
      writeFileSync(entryPath, `export default {\n  setup(app) {\n    app.serve('version', () => 'v3')\n  },\n}\n`)
      await tick(180)
      writeFileSync(entryPath, `export default {\n  setup(app) {\n    app.serve('version', () => 'v4')\n  },\n}\n`)
      await tick(1200)   // v2 (400ms, déjà en vol) + son import + le rechargement final (v4) : marge large
      cap.restore()

      const restarts = cap.lines.filter(l => l.includes('♻️') && l.includes('redémarré')).length
      assert.equal(restarts, 1, `un seul rechargement attendu (v2 périmée jetée), obtenu ${restarts}. lignes:\n${cap.lines.join('\n')}`)

      const c2 = await rawRequestClient(transport, 'memory://reload-race-v4')
      assert.equal(await c2.request('version'), 'v4', 'la DERNIÈRE version doit gagner — jamais la v2 périmée')
    } finally {
      await handle.stop()
    }
  })
})

// ============================================================================
// (d) entry en Civet — ws.civet compilé à la volée (façade transport ouverte)
// ============================================================================

describe('cli/ws — entry en Civet (ws.civet compilé à la volée via @danielx/civet)', function () {
  this.timeout(10000)

  // syntaxe Civet RÉELLE demandée : fonctions en `->`, hash SANS accolades
  const CIVET_PING = `export default
  setup: (app) ->
    app.serve 'ping', -> 'pong'
`

  it("fixture ws.civet (syntaxe Civet réelle) → résolution PAR DÉFAUT + chargement + setup(app) appelé + boucle complète (vrai client µ.socket)", async () => {
    const root = freshDir('ws-civet')
    writeFileSync(join(root, 'ws.civet'), CIVET_PING)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      assert.match(handle.entryPath, /ws\.civet$/, "ws.civet doit avoir été trouvé par la résolution PAR DÉFAUT (aucun --entry fourni)")
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-civet-1')
      s.connect(); await tick()
      assert.equal(s.state, 'open')
      assert.equal(await s.request('ping', {}), 'pong')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it('ws.js prime sur ws.civet quand les deux existent (même dossier)', async () => {
    const root = freshDir('ws-civet-vs-js')
    writeFileSync(join(root, 'ws.js'), `export default {\n  setup(app) {\n    app.serve('quel', () => 'js')\n  },\n}\n`)
    writeFileSync(join(root, 'ws.civet'), CIVET_PING.replace('pong', 'civet'))
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      assert.match(handle.entryPath, /ws\.js$/, 'ws.js doit avoir été choisi, pas ws.civet')
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-civet-vs-js-1')
      s.connect(); await tick()
      assert.equal(await s.request('quel', {}), 'js')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it('erreur de compilation Civet → message français clair avec le nom du fichier (runWsCommand rejette)', async () => {
    const root = freshDir('ws-civet-bad')
    const entryPath = join(root, 'ws.civet')
    writeFileSync(entryPath, `export default\n  setup: (app) ->\n    if\n`)   // syntaxe Civet cassée intentionnelle
    const transport = new MemoryTransport()
    await assert.rejects(
      runWsCommand({ root }, undefined, { transport, watch: false }),
      (err: any) => {
        assert.match(err.message, /erreur de compilation Civet/)
        assert.ok(err.message.includes(entryPath), 'le message doit citer le chemin du fichier fautif')
        return true
      },
    )
  })

  it("rechargement à chaud d'un .civet → nouveau comportement actif (nouvelle URL data: à chaque recompilation)", async () => {
    const root = freshDir('ws-civet-reload')
    const entryPath = join(root, 'ws.civet')
    writeFileSync(entryPath, `export default
  setup: (app) ->
    app.serve 'version', -> 'v1'
`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport })   // watch par défaut (true)
    try {
      const c1 = await rawRequestClient(transport, 'memory://civet-reload-v1')
      assert.equal(await c1.request('version'), 'v1')

      const cap = patchConsole()
      writeFileSync(entryPath, `export default
  setup: (app) ->
    app.serve 'version', -> 'v2'
`)
      await tick(600)   // 150ms debounce + compilation Civet + import/stop/listen, marge large
      cap.restore()
      assert.ok(cap.lines.some(l => l.includes('♻️') && l.includes('redémarré')), `log de rechargement absent. lignes:\n${cap.lines.join('\n')}`)

      const c2 = await rawRequestClient(transport, 'memory://civet-reload-v2')
      assert.equal(await c2.request('version'), 'v2', 'le nouveau serveur doit refléter la v2 RECOMPILÉE de la fixture')
    } finally {
      await handle.stop()
    }
  })
})

// ============================================================================
// (e) entry en `.server.mjs` — format RECOMMANDÉ, MÊME dialecte Civet que les
// composants (après l'application Rails hôte, cf. cli/server-entry.ts)
// ============================================================================

describe('cli/ws — entry en .server.mjs (dialecte Civet des composants, cli/server-entry.ts)', function () {
  this.timeout(10000)

  it("résolution PAR DÉFAUT : 'ws.server.mjs' trouvé (prime sur ws.js/ws.civet)", () => {
    const root = freshDir('ws-server-default')
    writeFileSync(join(root, 'ws.server.mjs'), `export default\n  setup: (app) ->\n    app.serve 'ping', -> 'pong'\n`)
    const p = resolveEntryPath(root, undefined, undefined)
    assert.equal(p, join(root, 'ws.server.mjs'))
  })

  it("résolution PAR DÉFAUT : 'server/ws.server.mjs' prime sur 'ws.js' À LA RACINE (2e de la liste)", () => {
    const root = freshDir('ws-server-default2')
    mkdirSync(join(root, 'server'), { recursive: true })
    writeFileSync(join(root, 'server', 'ws.server.mjs'), `export default\n  setup: (app) ->\n    app.serve 'ping', -> 'pong'\n`)
    writeFileSync(join(root, 'ws.js'), `export default {\n  setup(app) {\n    app.serve('quel', () => 'js')\n  },\n}\n`)
    const p = resolveEntryPath(root, undefined, undefined)
    assert.equal(p, join(root, 'server', 'ws.server.mjs'))
  })

  // fixture exerçant LES TROIS idiomes du dialecte composant : assignation nue
  // top-level ET imbriquée (avec fermeture PRÉSERVÉE — cf. Bug #6 regressions.test.ts),
  // interpolation "#{x}" vérifiée par la VALEUR reçue par le vrai client, et `->`.
  // Accolades du hash RACINE nécessaires ici (2 clés, `setup` à corps multi-lignes —
  // cf. docs/23-mjs-ws.md §12 : sans elles, le parseur Civet devient ambigu).
  const SERVER_MJS_DIALECT = `GREETING = 'bonjour'

export default {
  welcome: (client) -> { serverTime: Date.now() }

  setup: (app) ->
    counter = 0
    app.serve 'ping', ->
      counter = counter + 1
      "#{GREETING}-#{counter}"
}
`

  it("LES TROIS idiomes (assignation nue top-level+imbriquée, interpolation #{} par la valeur, ->) → boucle complète (welcome + serve, vrai client)", async () => {
    const root = freshDir('ws-server-dialect')
    writeFileSync(join(root, 'ws.server.mjs'), SERVER_MJS_DIALECT)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      assert.match(handle.entryPath, /ws\.server\.mjs$/)
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-dialect-1')
      s.connect(); await tick()
      assert.equal(s.state, 'open', 'le handshake (welcome compilé en -> ) doit réussir')
      // fermeture PARTAGÉE sur `counter` entre les appels : si l'auto-déclaration
      // re-« .= » `counter` DANS le callback, la fermeture casse (shadow local) et
      // chaque appel repartirait de 1 sans jamais incrémenter la vraie variable extérieure.
      assert.equal(await s.request('ping', {}), 'bonjour-1')
      assert.equal(await s.request('ping', {}), 'bonjour-2')
      assert.equal(await s.request('ping', {}), 'bonjour-3')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("piège `isnt` (partagé avec applyMjsSugarToScript) : `p.a isnt p.b` → !== , pas d'appel isnt(...) fantôme", async () => {
    const root = freshDir('ws-server-isnt')
    writeFileSync(join(root, 'ws.server.mjs'), `export default\n  setup: (app) ->\n    app.serve 'cmp', (p) -> p.a isnt p.b\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-isnt-1')
      s.connect(); await tick()
      assert.equal(await s.request('cmp', { a: 1, b: 2 }), true)
      assert.equal(await s.request('cmp', { a: 5, b: 5 }), false)
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it('ws.server.mjs GAGNE sur ws.js ET ws.civet quand les trois existent (même dossier)', async () => {
    const root = freshDir('ws-server-precedence')
    writeFileSync(join(root, 'ws.server.mjs'), `export default\n  setup: (app) ->\n    app.serve 'quel', -> 'server.mjs'\n`)
    writeFileSync(join(root, 'ws.js'), `export default {\n  setup(app) {\n    app.serve('quel', () => 'js')\n  },\n}\n`)
    writeFileSync(join(root, 'ws.civet'), `export default\n  setup: (app) ->\n    app.serve 'quel', -> 'civet'\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      assert.match(handle.entryPath, /ws\.server\.mjs$/, 'ws.server.mjs doit être choisi, pas ws.js ni ws.civet')
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-precedence-1')
      s.connect(); await tick()
      assert.equal(await s.request('quel', {}), 'server.mjs')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("--entry pointant explicitement un '*.server.mjs' HORS des défauts passe par le MÊME chemin (compilation dialecte)", async () => {
    const root = freshDir('ws-server-explicit-entry')
    writeFileSync(join(root, 'custom.server.mjs'), `X = 42\n\nexport default\n  setup: (app) ->\n    app.serve 'x', -> X\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root, entry: 'custom.server.mjs' }, undefined, { transport, watch: false })
    try {
      assert.match(handle.entryPath, /custom\.server\.mjs$/)
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-explicit-1')
      s.connect(); await tick()
      assert.equal(await s.request('x', {}), 42)
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it('markup de composant (<template>) dans un .server.mjs → erreur française claire (runWsCommand rejette)', async () => {
    const root = freshDir('ws-server-markup')
    const entryPath = join(root, 'ws.server.mjs')
    writeFileSync(entryPath, `<template>\n  <p>salut</p>\n</template>\n`)
    const transport = new MemoryTransport()
    await assert.rejects(
      runWsCommand({ root }, undefined, { transport, watch: false }),
      (err: any) => {
        assert.match(err.message, /markup de composant/)
        assert.match(err.message, /<template>/)
        assert.match(err.message, /pas un composant/)
        assert.ok(err.message.includes(entryPath), 'le message doit citer le chemin du fichier fautif')
        return true
      },
    )
  })

  it('balise HTML EN TÊTE (sans <template>) dans un .server.mjs → même garde-fou', async () => {
    const root = freshDir('ws-server-markup2')
    writeFileSync(join(root, 'ws.server.mjs'), `<div>\n  salut\n</div>\n`)
    const transport = new MemoryTransport()
    await assert.rejects(
      runWsCommand({ root }, undefined, { transport, watch: false }),
      /markup de composant.*<div>/,
    )
  })

  it("erreur de compilation dans un .server.mjs → message français clair avec le nom du fichier", async () => {
    const root = freshDir('ws-server-bad')
    const entryPath = join(root, 'ws.server.mjs')
    writeFileSync(entryPath, `export default\n  setup: (app) ->\n    if\n`)   // syntaxe cassée intentionnelle
    const transport = new MemoryTransport()
    await assert.rejects(
      runWsCommand({ root }, undefined, { transport, watch: false }),
      (err: any) => {
        assert.match(err.message, /erreur de compilation/)
        assert.ok(err.message.includes(entryPath), 'le message doit citer le chemin du fichier fautif')
        return true
      },
    )
  })

  it("rechargement à chaud d'un .server.mjs → nouveau comportement actif (recompilation dialecte à chaque changement)", async () => {
    const root = freshDir('ws-server-reload')
    const entryPath = join(root, 'ws.server.mjs')
    writeFileSync(entryPath, `V = 'v1'\n\nexport default\n  setup: (app) ->\n    app.serve 'version', -> V\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport })   // watch par défaut (true)
    try {
      const c1 = await rawRequestClient(transport, 'memory://server-reload-v1')
      assert.equal(await c1.request('version'), 'v1')

      const cap = patchConsole()
      writeFileSync(entryPath, `V = 'v2'\n\nexport default\n  setup: (app) ->\n    app.serve 'version', -> V\n`)
      await tick(600)   // 150ms debounce + compilation + import/stop/listen, marge large
      cap.restore()
      assert.ok(cap.lines.some(l => l.includes('♻️') && l.includes('redémarré')), `log de rechargement absent. lignes:\n${cap.lines.join('\n')}`)

      const c2 = await rawRequestClient(transport, 'memory://server-reload-v2')
      assert.equal(await c2.request('version'), 'v2', 'le nouveau serveur doit refléter la v2 RECOMPILÉE de la fixture')
    } finally {
      await handle.stop()
    }
  })
})

// ============================================================================
// (f) grammaire @import d'une entry .server.mjs — un VRAI fichier, plus de data: URL
// (cli/server-entry.ts) : seule @import a un sens hors DOM, cible relative/paquet npm/node:*
// ============================================================================

describe("cli/ws — grammaire @import d'une entry serveur (cli/server-entry.ts)", function () {
  this.timeout(10000)

  it("@import d'un fichier .civet relatif (dialecte appliqué, interpolation #{}) → utilisable dans setup(app)", async () => {
    const root = freshDir('ws-server-import-civet')
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'lib', 'greet.civet'), `export greet := (n) -> "salut #{n}"\n`)
    writeFileSync(join(root, 'ws.server.mjs'), `@import greet './lib/greet.civet'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', (p) -> greet(p.name)\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-import-civet-1')
      s.connect(); await tick()
      assert.equal(await s.request('ping', { name: 'Ada' }), 'salut Ada')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("@import d'un spécificateur node: natif → résolu par Node normalement, quel que soit le dossier de cache", async () => {
    const root = freshDir('ws-server-import-node')
    writeFileSync(join(root, 'ws.server.mjs'), `@import join 'node:path'\n\nexport default\n  setup: (app) ->\n    app.serve 'joindre', (p) -> join(p.a, p.b)\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-import-node-1')
      s.connect(); await tick()
      assert.equal(await s.request('joindre', { a: 'un', b: 'deux' }), join('un', 'deux'))
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("@import default d'un paquet npm NU → résolu depuis <root>/node_modules (cache posé SOUS node_modules/.cache)", async () => {
    const root = freshDir('ws-server-import-pkg')
    const pkgDir = join(root, 'node_modules', 'fake-pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-pkg', type: 'module', main: 'index.js' }))
    writeFileSync(join(pkgDir, 'index.js'), `export default () => 'pkg-ok'\n`)
    writeFileSync(join(root, 'ws.server.mjs'), `@import default hello 'fake-pkg'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', -> hello()\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-import-pkg-1')
      s.connect(); await tick()
      assert.equal(await s.request('ping', {}), 'pkg-ok')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("@import default d'un paquet npm NU AVEC SOUS-CHEMIN ('fake-pkg/sub', via `exports` du package.json) → résolu, jamais pris pour un chemin de projet absent", async () => {
    const root = freshDir('ws-server-import-pkg-sub')
    const pkgDir = join(root, 'node_modules', 'fake-pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-pkg', type: 'module', exports: { '.': './index.js', './sub': './sub.js' } }))
    writeFileSync(join(pkgDir, 'index.js'), `export default () => 'pkg-index'\n`)
    writeFileSync(join(pkgDir, 'sub.js'), `export default () => 'pkg-sub-ok'\n`)
    writeFileSync(join(root, 'ws.server.mjs'), `@import default hello 'fake-pkg/sub'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', -> hello()\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-import-pkg-sub-1')
      s.connect(); await tick()
      assert.equal(await s.request('ping', {}), 'pkg-sub-ok')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("@import default d'un paquet SCOPÉ NU ('@scope/pkg') → résolu, le '@' de tête n'est ni un préfixe de chemin ni une extension composant", async () => {
    const root = freshDir('ws-server-import-scope-pkg')
    const pkgDir = join(root, 'node_modules', '@scope', 'pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@scope/pkg', type: 'module', main: 'index.js' }))
    writeFileSync(join(pkgDir, 'index.js'), `export default () => 'scope-ok'\n`)
    writeFileSync(join(root, 'ws.server.mjs'), `@import default pkg '@scope/pkg'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', -> pkg()\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-import-scope-pkg-1')
      s.connect(); await tick()
      assert.equal(await s.request('ping', {}), 'scope-ok')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("@import d'un '.civet' SANS préfixe './' ('lib/greet.civet', forme composant, présent sous root) → compilé comme un fichier de projet", async () => {
    const root = freshDir('ws-server-import-civet-no-dotslash')
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'lib', 'greet.civet'), `export greet := (n) -> "salut #{n}"\n`)
    writeFileSync(join(root, 'ws.server.mjs'), `@import greet 'lib/greet.civet'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', (p) -> greet(p.name)\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-import-civet-no-dotslash-1')
      s.connect(); await tick()
      assert.equal(await s.request('ping', { name: 'Ada' }), 'salut Ada')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("cible @import SANS préfixe qui finit par '.civet' et n'existe nulle part ('nope/absent.civet') → erreur explicite, forcément un fichier voulu", async () => {
    const root = freshDir('ws-server-import-bare-civet-absent')
    writeFileSync(join(root, 'ws.server.mjs'), `@import x 'nope/absent.civet'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', -> 'pong'\n`)
    const transport = new MemoryTransport()
    await assert.rejects(
      runWsCommand({ root }, undefined, { transport, watch: false }),
      (err: any) => {
        assert.match(err.message, /nope\/absent\.civet/)
        assert.match(err.message, /introuvable/)
        return true
      },
    )
  })

  it("@import d'un '.js' natif à export NOMMÉ ET d'un '.json' (attribut `with { type: 'json' }` posé par le framework) → tous deux résolus (trou de couverture)", async () => {
    const root = freshDir('ws-server-import-js-json')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(root, 'util.js'), `export const util = (n) => 'util-'+ n\n`)
    writeFileSync(join(root, 'cfg.json'), JSON.stringify({ bonus: 'cfg-ok' }))
    writeFileSync(join(root, 'ws.server.mjs'), `@import util './util.js'\n@import default cfg './cfg.json'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', -> util(cfg.bonus)\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-import-js-json-1')
      s.connect(); await tick()
      assert.equal(await s.request('ping', {}), 'util-cfg-ok')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("bloc `###…###` façon JSDoc (`@param`/`@returns` en colonne 0) → jamais lu comme une directive, runWsCommand démarre et répond", async () => {
    const root = freshDir('ws-server-jsdoc-block-comment')
    writeFileSync(join(root, 'ws.server.mjs'), `###\nDocumentation façon JSDoc :\n@param name le nom\n@returns un message\n###\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', (p) -> 'salut ' + p.name\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-jsdoc-block-comment-1')
      s.connect(); await tick()
      assert.equal(await s.request('ping', { name: 'Ada' }), 'salut Ada')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it('chaîne `"""…"""` multi-lignes contenant `@foo` (texte, pas une directive) → runWsCommand démarre', async () => {
    const root = freshDir('ws-server-triple-quote-string')
    writeFileSync(join(root, 'ws.server.mjs'), `MSG = """\n@foo pas une directive, juste du texte dans une chaine\n"""\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', -> MSG\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-triple-quote-string-1')
      s.connect(); await tick()
      assert.match(await s.request('ping', {}), /@foo pas une directive/)
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("commentaire de ligne (`# @i18n 'x'`) en colonne 0 → jamais lu comme une directive, runWsCommand démarre", async () => {
    const root = freshDir('ws-server-hash-comment')
    writeFileSync(join(root, 'ws.server.mjs'), `# @i18n 'x'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', -> 'pong'\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-hash-comment-1')
      s.connect(); await tick()
      assert.equal(await s.request('ping', {}), 'pong')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("directive interdite (@i18n) en colonne 0 dans une entry .server.mjs → runWsCommand rejette (seule @import a un sens hors DOM)", async () => {
    const root = freshDir('ws-server-directive-interdite')
    writeFileSync(join(root, 'ws.server.mjs'), `@i18n 'x'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', -> 'pong'\n`)
    const transport = new MemoryTransport()
    await assert.rejects(
      runWsCommand({ root }, undefined, { transport, watch: false }),
      (err: any) => {
        assert.match(err.message, /@i18n/)
        assert.match(err.message, /n'a pas de sens dans une entry serveur/)
        return true
      },
    )
  })

  it("un faux `@import x 'y'` DANS un bloc `###` (commentaire) n'est ni appliqué ni signalé — seul le vrai @import posé après le bloc compte", async () => {
    const root = freshDir('ws-server-fake-import-in-comment')
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'lib', 'greet.civet'), `export greet := (n) -> "salut #{n}"\n`)
    writeFileSync(join(root, 'ws.server.mjs'), `###\nfaux commentaire avec @import x 'y' dedans, jamais un vrai import\n###\n@import greet './lib/greet.civet'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', (p) -> greet(p.name)\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-server-fake-import-in-comment-1')
      s.connect(); await tick()
      assert.equal(await s.request('ping', { name: 'Ada' }), 'salut Ada')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("cycle d'import (a.civet @import b.civet @import a.civet) → runWsCommand rejette avec un message explicite", async () => {
    const root = freshDir('ws-server-import-cycle')
    writeFileSync(join(root, 'ws.server.mjs'), `@import a './a.civet'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', -> 'pong'\n`)
    writeFileSync(join(root, 'a.civet'), `@import b './b.civet'\n\nexport a := 1\n`)
    writeFileSync(join(root, 'b.civet'), `@import a './a.civet'\n\nexport b := 2\n`)
    const transport = new MemoryTransport()
    await assert.rejects(
      runWsCommand({ root }, undefined, { transport, watch: false }),
      /cycle d'import/,
    )
  })

  it("cible @import absente ('./absent.civet') → erreur explicite (ni à côté de l'entry, ni sous --root)", async () => {
    const root = freshDir('ws-server-import-absent')
    writeFileSync(join(root, 'ws.server.mjs'), `@import x './absent.civet'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', -> 'pong'\n`)
    const transport = new MemoryTransport()
    await assert.rejects(
      runWsCommand({ root }, undefined, { transport, watch: false }),
      (err: any) => {
        assert.match(err.message, /absent\.civet/)
        assert.match(err.message, /introuvable/)
        return true
      },
    )
  })

  it("entry .civet BRUTE avec un import natif ('node:path') → toujours résolu (régression : fichier réel, plus de data: URL)", async () => {
    const root = freshDir('ws-civet-native-import')
    writeFileSync(join(root, 'ws.civet'), `import { join } from 'node:path'\n\nexport default\n  setup: (app) ->\n    app.serve 'joindre', (p) -> join(p.a, p.b)\n`)
    const transport = new MemoryTransport()
    const handle = await runWsCommand({ root }, undefined, { transport, watch: false })
    try {
      assert.match(handle.entryPath, /ws\.civet$/)
      const µ = makeClient(transport)
      const s = µ.socket('memory://ws-civet-native-import-1')
      s.connect(); await tick()
      assert.equal(await s.request('joindre', { a: 'un', b: 'deux' }), join('un', 'deux'))
      s.destroy()
    } finally {
      await handle.stop()
    }
  })
})

// ============================================================================
// cli.ts — parseArgs (sous-processus, même technique que cli-unknown-flag-warning.test.ts)
// ============================================================================

describe('cli.ts — parseArgs reconnaît la commande `ws` et le flag --entry', function () {
  this.timeout(30000)

  it("'ws' + '--entry' ne déclenchent AUCUN warning 'ignoré', et l'USAGE mentionne 'ws'", function () {
    const { stdout, stderr, status } = spawnSync('npx', ['tsx', 'src/cli.ts', 'ws', '--entry', 'foo.js', '--help'], { cwd: repoRoot, encoding: 'utf-8' })
    assert.equal(status, 0, `stderr:\n${stderr}`)
    assert.doesNotMatch(stderr, /ignoré/i, `aucun warning attendu pour 'ws'/--entry. stderr:\n${stderr}`)
    assert.match(stdout, /mjs ws/, "l'USAGE doit mentionner la commande 'ws'")
  })
})
