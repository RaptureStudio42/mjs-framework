// Tests de la commande `mjs serveur` — CLI déclarative MJS-Server (cf. src/cli/server.ts,
// docs/24-mjs-server.md §2). MÊME patron à trois niveaux que tests/mjs-ws-cli.test.ts : (a)
// validation de la section `serveur` de mjs.config.json (bundler/config.ts, MÊME patron strict que
// `ws`) ; (b) fonctions pures de cli/server.ts (résolution d'entry — dont la NON-collision avec
// `mjs ws` —, contrat, priorités port/host/heartbeat/limits/antiTriche) ; (c) boucle complète via
// runServeurCommand() contre un VRAI client µ.socket sur MemoryTransport, fixtures dans un dossier
// TEMPORAIRE (fs.mkdtemp — jamais dans le dépôt).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findConfig } from '../src/bundler/config.js'
import { resolveServeurEntryPath, readServeurEntryContract, buildServeurRunPlan, runServeurCommand } from '../src/cli/server.js'
import { resolveEntryPath } from '../src/cli/ws.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// dossiers temporaires créés par ce fichier — nettoyés une seule fois à la fin (jamais de fixture
// dans le dépôt, cf. feedback_scratch_cleanup_glob_precision)
const tmpDirs: string[] = []
function freshDir(prefix: string): string {
  const d = mjsTmp(prefix)
  tmpDirs.push(d)
  return d
}
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

// --- même technique que tests/mjs-ws-cli.test.ts : VRAI client µ.socket sur MemoryTransport ---
function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}
function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

function patchConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log   = (...a: any[]) => { lines.push(a.join(' ')) }
  console.warn  = (...a: any[]) => { lines.push(a.join(' ')) }
  console.error = (...a: any[]) => { lines.push(a.join(' ')) }
  return { lines, restore: () => { console.log = orig.log; console.warn = orig.warn; console.error = orig.error } }
}

// ============================================================================
// (a) mjs.config.json — section `serveur`
// ============================================================================

describe('mjs.config.json — section `serveur` (validation stricte, patron `ws`)', () => {
  function writeConfig(config: Record<string, unknown>): string {
    const root = freshDir('cfg-serveur')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(config))
    return root
  }

  it('accepte une section serveur complète valide', () => {
    const root = writeConfig({ serveur: { entry: 'server/serveur.js', port: 4101, host: '0.0.0.0', heartbeat: 20000, limits: { rate: 10, burst: 20 }, antiCheat: { movesPerIdentity: [40, 1000] } } })
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.serveur?.entry, 'server/serveur.js')
    assert.equal(found!.config.serveur?.port, 4101)
    assert.deepEqual(found!.config.serveur?.antiCheat?.movesPerIdentity, [40, 1000])
  })

  it("throw sur serveur.X inconnu, avec suggestion orthographique ('entrry' → 'entry')", () => {
    const root = writeConfig({ serveur: { entrry: 'serveur.js' } })
    assert.throws(() => findConfig(root), /serveur\.entrry : clé inconnue.*tu voulais dire 'entry'/)
  })

  it('throw sur serveur non-objet', () => {
    const root = writeConfig({ serveur: 'serveur.js' })
    assert.throws(() => findConfig(root), /'serveur' doit être un objet/)
  })

  it('throw sur serveur.port hors bornes TCP', () => {
    const root = writeConfig({ serveur: { port: 99999 } })
    assert.throws(() => findConfig(root), /serveur\.port doit être un entier entre 1 et 65535/)
  })

  it("le top-level accepte 'serveur' ET 'ws' EN MÊME TEMPS (les deux commandes coexistent)", () => {
    const root = writeConfig({ ws: { port: 4000 }, serveur: { port: 4001 } })
    assert.doesNotThrow(() => findConfig(root))
    const found = findConfig(root)!
    assert.equal(found.config.ws?.port, 4000)
    assert.equal(found.config.serveur?.port, 4001)
  })

  it('throw sur serveur.limits.X inconnu, avec suggestion orthographique', () => {
    const root = writeConfig({ serveur: { limits: { ratee: 5 } } })
    assert.throws(() => findConfig(root), /serveur\.limits\.ratee : clé inconnue.*tu voulais dire 'rate'/)
  })

  it("serveur.verifyOrigin : accepte un tableau non vide de chaînes non vides, throw sinon (allowlist, refus 1008)", () => {
    const root = writeConfig({ serveur: { verifyOrigin: ['https://exemple.com'] } })
    assert.equal(findConfig(root)!.config.serveur?.verifyOrigin?.[0], 'https://exemple.com')

    assert.throws(() => findConfig(writeConfig({ serveur: { verifyOrigin: [] } })), /serveur\.verifyOrigin doit être un tableau non vide/)
    assert.throws(() => findConfig(writeConfig({ serveur: { verifyOrigin: ['', 'https://ok.com'] } })), /serveur\.verifyOrigin doit être un tableau non vide/)
    assert.throws(() => findConfig(writeConfig({ serveur: { verifyOrigin: 'https://exemple.com' } })), /serveur\.verifyOrigin doit être un tableau non vide/)
  })

  it("serveur.antiTriche : movesPerIdentity accepte [n≥1, fenêtreMs>0] ou null, throw sur forme invalide", () => {
    assert.deepEqual(findConfig(writeConfig({ serveur: { antiCheat: { movesPerIdentity: [10, 500] } } }))!.config.serveur?.antiCheat?.movesPerIdentity, [10, 500])
    assert.equal(findConfig(writeConfig({ serveur: { antiCheat: { movesPerIdentity: null } } }))!.config.serveur?.antiCheat?.movesPerIdentity, null)

    assert.throws(() => findConfig(writeConfig({ serveur: { antiCheat: { movesPerIdentity: [0, 500] } } })), /movesPerIdentity doit être \[n entier ≥ 1, fenêtreMs entier > 0\] ou null/)
    assert.throws(() => findConfig(writeConfig({ serveur: { antiCheat: { movesPerIdentity: [10, 0] } } })), /movesPerIdentity doit être/)
    assert.throws(() => findConfig(writeConfig({ serveur: { antiCheat: { movesPerIdentity: 'oui' } } })), /movesPerIdentity doit être/)
  })

  it("throw sur serveur.antiTriche.X inconnu, avec suggestion orthographique", () => {
    const root = writeConfig({ serveur: { antiCheat: { movesPerIdentityy: [10, 500] } } })
    assert.throws(() => findConfig(root), /serveur\.antiCheat\.movesPerIdentityy : clé inconnue.*tu voulais dire 'movesPerIdentity'/)
  })

  it('serveur.antiTriche non-objet → throw', () => {
    const root = writeConfig({ serveur: { antiCheat: 'oui' } })
    assert.throws(() => findConfig(root), /'serveur\.antiCheat' doit être un objet/)
  })
})

// ============================================================================
// (b) cli/server.ts — fonctions pures
// ============================================================================

describe('cli/server — resolveServeurEntryPath (--entry > serveur.entry > serveur.server.mjs > … > server/serveur.civet)', () => {
  it('--entry prioritaire même si la config ET les défauts existent', () => {
    const root = freshDir('server-entry-prio')
    writeFileSync(join(root, 'serveur.js'), '// défaut\n')
    writeFileSync(join(root, 'custom.js'), '// custom\n')
    const p = resolveServeurEntryPath(root, 'custom.js', 'serveur.js')
    assert.equal(p, join(root, 'custom.js'))
  })

  it("--entry pointant vers un fichier absent → erreur immédiate (PAS de repli sur les défauts existants)", () => {
    const root = freshDir('server-entry-missing')
    writeFileSync(join(root, 'serveur.js'), '// défaut, ne doit PAS être choisi\n')
    assert.throws(() => resolveServeurEntryPath(root, 'nope.js', undefined), /--entry 'nope\.js'.*introuvable/s)
  })

  it("serveur.entry (config) prioritaire sur les défauts quand --entry absent", () => {
    const root = freshDir('server-entry-config')
    writeFileSync(join(root, 'serveur.js'), '// défaut\n')
    mkdirSync(join(root, 'custom'), { recursive: true })
    writeFileSync(join(root, 'custom', 'srv.js'), '// config\n')
    const p = resolveServeurEntryPath(root, undefined, 'custom/srv.js')
    assert.equal(p, join(root, 'custom', 'srv.js'))
  })

  it("défaut 'serveur.js' choisi quand rien d'autre n'est spécifié", () => {
    const root = freshDir('server-entry-default1')
    writeFileSync(join(root, 'serveur.js'), '// défaut\n')
    const p = resolveServeurEntryPath(root, undefined, undefined)
    assert.equal(p, join(root, 'serveur.js'))
  })

  it("défaut 'server/serveur.js' choisi quand 'serveur.js' est absent", () => {
    const root = freshDir('server-entry-default2')
    mkdirSync(join(root, 'server'), { recursive: true })
    writeFileSync(join(root, 'server', 'serveur.js'), '// défaut serveur\n')
    const p = resolveServeurEntryPath(root, undefined, undefined)
    assert.equal(p, join(root, 'server', 'serveur.js'))
  })

  it("'serveur.server.mjs' (format RECOMMANDÉ) prime sur 'serveur.js'/'serveur.civet'", () => {
    const root = freshDir('server-entry-servermjs')
    writeFileSync(join(root, 'serveur.server.mjs'), `export default\n  setup: (app) ->\n    app.game 'x', { places: 1, state: (p) -> ({}), moves: {} }\n`)
    writeFileSync(join(root, 'serveur.js'), `export default {\n  setup(app) {},\n}\n`)
    const p = resolveServeurEntryPath(root, undefined, undefined)
    assert.equal(p, join(root, 'serveur.server.mjs'))
  })

  it("introuvable (aucun candidat) → erreur claire qui IMPRIME un squelette minimal mentionnant mjsServer/app.game", () => {
    const root = freshDir('server-entry-none')
    assert.throws(() => resolveServeurEntryPath(root, undefined, undefined), (err: any) => {
      assert.match(err.message, /aucun fichier d'entry trouvé/)
      assert.match(err.message, /serveur\.server\.mjs, server\/serveur\.server\.mjs, serveur\.js, serveur\.civet, server\/serveur\.js, server\/serveur\.civet/)
      assert.match(err.message, /mjsServer/, 'le message doit expliquer que le CLI construit l\'app mjsServer')
      assert.match(err.message, /app\.game/, 'le squelette doit montrer app.game(...)')
      assert.match(err.message, /export default/)
      assert.doesNotMatch(err.message, /^import |\bfrom '/m, 'le squelette ne doit contenir AUCUN import (entry chargée par data: URL — un import npm y planterait)')
      return true
    })
  })

  it("AUCUNE collision avec les défauts de `mjs ws` : un projet avec ws.server.mjs ET serveur.server.mjs résout chacun le sien", () => {
    const root = freshDir('server-vs-ws-no-collision')
    writeFileSync(join(root, 'ws.server.mjs'), `export default\n  setup: (app) ->\n    app.serve 'ping', -> 'pong-ws'\n`)
    writeFileSync(join(root, 'serveur.server.mjs'), `export default\n  setup: (app) ->\n    app.game 'x', { places: 1, state: (p) -> ({}), moves: {} }\n`)
    const wsPath      = resolveEntryPath(root, undefined, undefined)
    const serveurPath = resolveServeurEntryPath(root, undefined, undefined)
    assert.equal(wsPath, join(root, 'ws.server.mjs'))
    assert.equal(serveurPath, join(root, 'serveur.server.mjs'))
    assert.notEqual(wsPath, serveurPath)
  })
})

describe("cli/server — readServeurEntryContract (contrat de l'entry)", () => {
  it("throw si le default export est absent", () => {
    assert.throws(() => readServeurEntryContract({}, '/fake/serveur.js', () => {}), /doit faire 'export default \{ \.\.\. \}'.*aucun export par défaut/s)
  })

  it("throw si 'setup' n'est pas une fonction", () => {
    assert.throws(() => readServeurEntryContract({ default: { setup: 42 } }, '/fake/serveur.js', () => {}), /'setup' doit être une fonction/)
  })

  it('extrait les options + setup normalement (cas nominal)', () => {
    const setupFn = () => {}
    const warns: string[] = []
    const { options, setup } = readServeurEntryContract({ default: { heartbeat: 5000, setup: setupFn } }, '/fake/serveur.js', m => warns.push(m))
    assert.equal(options.heartbeat, 5000)
    assert.equal(setup, setupFn)
    assert.deepEqual(warns, [])
  })

  it("chacune des 3 clés réservées (port/host/onLog) déclenche EXACTEMENT le warn attendu et est retirée des options", () => {
    for (const key of ['port', 'host', 'onLog']) {
      const warns: string[] = []
      const { options } = readServeurEntryContract({ default: { [key]: 'peu-importe' } }, '/fake/serveur.js', m => warns.push(m))
      assert.deepEqual(warns, [`entry.${key} ignorée : gérée par le CLI/la config`])
      assert.ok(!(key in options), `${key} ne doit PAS survivre dans les options transmises à mjsServer()`)
    }
  })

  it("'antiTriche'/'persist' traversent SANS warn (options légitimes de mjsServer(), pas réservées)", () => {
    const warns: string[] = []
    const { options } = readServeurEntryContract({ default: { antiCheat: { movesPerIdentity: [5, 1000] }, persist: { load: () => {}, save: () => {}, remove: () => {} } } }, '/fake/serveur.js', m => warns.push(m))
    assert.deepEqual(warns, [])
    assert.deepEqual((options as any).antiCheat, { movesPerIdentity: [5, 1000] })
  })
})

describe('cli/server — buildServeurRunPlan (priorités port/host/heartbeat/limits/antiTriche)', () => {
  const noWarn = () => { throw new Error('aucun warn attendu ici') }

  it('port : --port prioritaire sur serveur.port et sur le défaut 4001', () => {
    const plan = buildServeurRunPlan({ options: {} }, { port: 5000 }, 6000, noWarn)
    assert.equal(plan.port, 6000)
  })

  it('port : serveur.port utilisé si --port absent', () => {
    const plan = buildServeurRunPlan({ options: {} }, { port: 5000 }, undefined, noWarn)
    assert.equal(plan.port, 5000)
  })

  it('port : défaut 4001 (DISTINCT du 4000 de `mjs ws`) si rien de spécifié', () => {
    const plan = buildServeurRunPlan({ options: {} }, undefined, undefined, noWarn)
    assert.equal(plan.port, 4001)
  })

  it("heartbeat : défini dans LES DEUX → l'entry prime + warn explicite", () => {
    const warns: string[] = []
    const plan = buildServeurRunPlan({ options: { heartbeat: 111 } }, { heartbeat: 222 }, undefined, m => warns.push(m))
    assert.equal(plan.heartbeat, 111)
    assert.ok(warns.some(w => /heartbeat.*entry prime/.test(w)))
  })

  it('heartbeat : absent des deux → DEFAULT_HEARTBEAT (15000)', () => {
    const plan = buildServeurRunPlan({ options: {} }, undefined, undefined, noWarn)
    assert.equal(plan.heartbeat, 15000)
  })

  it("limits : défini dans LES DEUX → l'entry prime EN BLOC (pas de fusion clé à clé) + warn", () => {
    const warns: string[] = []
    const plan = buildServeurRunPlan({ options: { limits: { rate: 1 } } }, { limits: { rate: 2, burst: 2 } }, undefined, m => warns.push(m))
    assert.equal(plan.limits.rate, 1)
    assert.equal(plan.limits.burst, 80)   // DEFAULT_LIMITS.burst — PAS 2
    assert.ok(warns.some(w => /limits.*entry prime/.test(w)))
  })

  it("antiTriche : défini SEULEMENT dans la config → utilisé sans warn", () => {
    const plan = buildServeurRunPlan({ options: {} }, { antiCheat: { movesPerIdentity: [20, 1000] } }, undefined, noWarn)
    assert.deepEqual((plan.options as any).antiCheat, { movesPerIdentity: [20, 1000] })
  })

  it("antiTriche : défini dans LES DEUX → l'entry prime EN BLOC + warn explicite", () => {
    const warns: string[] = []
    const plan = buildServeurRunPlan({ options: { antiCheat: { movesPerIdentity: [5, 500] } } }, { antiCheat: { movesPerIdentity: [99, 99] } }, undefined, m => warns.push(m))
    assert.deepEqual((plan.options as any).antiCheat, { movesPerIdentity: [5, 500] })
    assert.ok(warns.some(w => /antiCheat.*entry prime/.test(w)))
  })

  it('antiTriche : absent des deux → undefined (aucun quota, comportement mjsServer() par défaut)', () => {
    const plan = buildServeurRunPlan({ options: {} }, undefined, undefined, noWarn)
    assert.equal((plan.options as any).antiCheat, undefined)
  })
})

// ============================================================================
// (c) runServeurCommand — boucle complète (MemoryTransport injecté, VRAI client µ.socket)
// ============================================================================

describe("cli/server — runServeurCommand : chargement d'entry (VRAI client µ.socket, MemoryTransport injecté)", function () {
  this.timeout(10000)

  // app.game('morpion', …) déclaré dans setup(app) — capacité SPÉCIFIQUE à MJS-Server : une app
  // construite par mjsWs() n'a jamais `.game` ni `stats().game`. Le test ci-dessous s'assure que
  // c'est bien mjsServer() (pas mjsWs()) qui construit l'app derrière `mjs serveur`.
  const MORPION_ENTRY = `export default {
  setup(app) {
    app.game('morpion', {
      seats: 2,
      state: (game) => ({ grille: Array(9).fill(null) }),
      moves: {
        jouer: (game, player, p) => {
          game.state.grille[p.i] = player.id
          game.next()
        },
      },
    })
  },
}
`

  it("setup(app) est appelé AVANT listen(), app.game(...) déclaré sans throw → preuve que mjsServer() a construit l'app (app.stats().game existe, absent d'une app mjsWs())", async () => {
    const root = freshDir('server-load')
    writeFileSync(join(root, 'serveur.mjs'), MORPION_ENTRY)
    const transport = new MemoryTransport()
    const cap = patchConsole()
    const handle = await runServeurCommand({ root, entry: 'serveur.mjs' }, undefined, { transport, watch: false })
    cap.restore()
    try {
      assert.ok(cap.lines.some(l => l.includes('Ctrl-C pour arrêter')), 'la bannière doit être imprimée au démarrage')
      assert.equal(typeof handle.app.game, 'function', 'app.game DOIT exister — capacité EXCLUSIVE à mjsServer()')
      const stats = handle.app.stats() as any
      assert.deepEqual(stats.game, { suspectMoves: 0, rejectedMoves: 0 }, "app.stats().game DOIT exister — absent d'une app mjsWs() nue")

      const µ = makeClient(transport)
      const s = µ.socket('memory://serveur-load-1')
      s.connect(); await tick()
      assert.equal(s.state, 'open')
      const res = await s.request('µgame:play', { type: 'morpion' })
      assert.ok(res && typeof res === 'object', 'µgame:play doit répondre — la plomberie interne MJS-Server doit être active')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("clé réservée ('port') présente dans l'entry → warn explicite + ignorée, le serveur démarre quand même normalement", async () => {
    const root = freshDir('server-reserved')
    writeFileSync(join(root, 'serveur.mjs'), `export default {\n  port: 9999,\n  setup(app) {\n    app.serve('ping', () => 'pong')\n  },\n}\n`)
    const transport = new MemoryTransport()
    const cap = patchConsole()
    const handle = await runServeurCommand({ root, entry: 'serveur.mjs' }, undefined, { transport, watch: false })
    cap.restore()
    try {
      assert.ok(cap.lines.some(l => l.includes('entry.port ignorée : gérée par le CLI/la config')), `warn attendu absent. lignes:\n${cap.lines.join('\n')}`)
      const µ = makeClient(transport)
      const s = µ.socket('memory://serveur-reserved-1')
      s.connect(); await tick()
      assert.equal(await s.request('ping', {}), 'pong')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it("default export absent → runServeurCommand rejette avec une erreur claire", async () => {
    const root = freshDir('server-badexport')
    writeFileSync(join(root, 'serveur.mjs'), `export const rien = true\n`)
    const transport = new MemoryTransport()
    await assert.rejects(
      runServeurCommand({ root, entry: 'serveur.mjs' }, undefined, { transport, watch: false }),
      /doit faire 'export default \{ \.\.\. \}'/,
    )
  })

  it("mjs.config.json serveur.antiTriche.movesPerIdentity appliqué au boot → ligne bannière anti-triche", async () => {
    const root = freshDir('server-antitriche-banner')
    writeFileSync(join(root, 'serveur.mjs'), MORPION_ENTRY)
    const transport = new MemoryTransport()
    const cap = patchConsole()
    const handle = await runServeurCommand({ root, entry: 'serveur.mjs' }, { serveur: { antiCheat: { movesPerIdentity: [40, 1000] } } } as any, { transport, watch: false })
    cap.restore()
    try {
      assert.ok(cap.lines.some(l => l.includes('anti-triche : quota 40 coups/identité par 1s')), `ligne anti-triche absente. lignes:\n${cap.lines.join('\n')}`)
    } finally {
      await handle.stop()
    }
  })
})

// ============================================================================
// (d) entry en `.server.mjs` — MÊME dialecte Civet que `mjs ws` (réutilise cli/server-entry.ts)
// ============================================================================

describe('cli/server — entry en .server.mjs (dialecte Civet des composants, RÉUTILISE cli/server-entry.ts)', function () {
  this.timeout(10000)

  it("fixture serveur.server.mjs (syntaxe Civet réelle) → résolution PAR DÉFAUT + chargement + setup(app) appelé + boucle complète (vrai client µ.socket)", async () => {
    const root = freshDir('server-server-dialect')
    writeFileSync(join(root, 'serveur.server.mjs'), `GREETING = 'bonjour'\n\nexport default\n  setup: (app) ->\n    app.serve 'ping', -> "#{GREETING}"\n`)
    const transport = new MemoryTransport()
    const handle = await runServeurCommand({ root }, undefined, { transport, watch: false })
    try {
      assert.match(handle.entryPath, /serveur\.server\.mjs$/, "serveur.server.mjs doit avoir été trouvé par la résolution PAR DÉFAUT")
      const µ = makeClient(transport)
      const s = µ.socket('memory://serveur-server-dialect-1')
      s.connect(); await tick()
      assert.equal(s.state, 'open')
      assert.equal(await s.request('ping', {}), 'bonjour', 'interpolation Civet "#{}" doit avoir été traduite (dialecte composant)')
      s.destroy()
    } finally {
      await handle.stop()
    }
  })

  it('markup de composant (<template>) dans un serveur.server.mjs → erreur française claire (runServeurCommand rejette, MÊME garde que `mjs ws`)', async () => {
    const root = freshDir('server-markup')
    const entryPath = join(root, 'serveur.server.mjs')
    writeFileSync(entryPath, `<template>\n  <p>salut</p>\n</template>\n`)
    const transport = new MemoryTransport()
    await assert.rejects(
      runServeurCommand({ root }, undefined, { transport, watch: false }),
      (err: any) => {
        assert.match(err.message, /markup de composant/)
        assert.match(err.message, /<template>/)
        return true
      },
    )
  })
})

// ============================================================================
// (d bis) grammaire @import d'une entry serveur — MIROIR minimal de mjs-ws-cli.test.ts
// (cli/server-entry.ts, module PARTAGÉ avec `mjs ws`)
// ============================================================================

describe("cli/server — grammaire @import d'une entry serveur (cli/server-entry.ts)", function () {
  this.timeout(10000)

  it("@import d'un fichier .civet relatif (dialecte appliqué) → utilisable dans app.game (setup)", async () => {
    const root = freshDir('server-import-civet')
    writeFileSync(join(root, 'rules.civet'), `export ligne := (grille, id) -> grille.every (c) -> c is id\n`)
    writeFileSync(join(root, 'serveur.server.mjs'), `@import ligne './rules.civet'\n\nexport default\n  setup: (app) ->\n    app.game 'morpion',\n      seats: 2\n      state: (partie) -> { grille: Array(9).fill(null), gagne: ligne([null, null, null], 'x') }\n      moves:\n        jouer: (partie, joueur, p) ->\n          partie.state.grille[p.i] = joueur.id\n          partie.next()\n`)
    const transport = new MemoryTransport()
    const handle = await runServeurCommand({ root }, undefined, { transport, watch: false })
    try {
      assert.match(handle.entryPath, /serveur\.server\.mjs$/)
      const µ = makeClient(transport)
      const s = µ.socket('memory://server-import-civet-1')
      s.connect(); await tick()
      const res = await s.request('µgame:play', { type: 'morpion' })
      assert.ok(res && typeof res === 'object', "µgame:play doit répondre — la fonction @import-ée n'a pas cassé state()")
      s.destroy()
    } finally {
      await handle.stop()
    }
  })
})

// ============================================================================
// (e) rechargement à chaud
// ============================================================================

describe('cli/server — rechargement à chaud (fs.watch réel, fixture réécrite sur disque)', function () {
  this.timeout(10000)

  it('nouvelle version de la fixture → nouveau comportement actif (nouvelle connexion)', async () => {
    const root = freshDir('server-reload-ok')
    const entryPath = join(root, 'serveur.mjs')
    writeFileSync(entryPath, `export default {\n  setup(app) {\n    app.serve('version', () => 'v1')\n  },\n}\n`)
    const transport = new MemoryTransport()
    const boot = patchConsole()
    const handle = await runServeurCommand({ root, entry: 'serveur.mjs' }, undefined, { transport })   // watch par défaut (true)
    boot.restore()
    try {
      const µ1 = makeClient(transport)
      const s1 = µ1.socket('memory://serveur-reload-ok-v1')
      s1.connect(); await tick()
      assert.equal(await s1.request('version', {}), 'v1')

      const cap = patchConsole()
      writeFileSync(entryPath, `export default {\n  setup(app) {\n    app.serve('version', () => 'v2')\n  },\n}\n`)
      await tick(600)   // 150ms debounce + import/stop/listen, marge large
      cap.restore()
      assert.ok(cap.lines.some(l => l.includes('♻️') && l.includes('redémarré')), `log de rechargement absent. lignes:\n${cap.lines.join('\n')}`)

      const µ2 = makeClient(transport)
      const s2 = µ2.socket('memory://serveur-reload-ok-v2')
      s2.connect(); await tick()
      assert.equal(await s2.request('version', {}), 'v2', 'le nouveau serveur doit refléter la v2 de la fixture')
      s1.destroy(); s2.destroy()
    } finally {
      await handle.stop()
    }
  })
})
