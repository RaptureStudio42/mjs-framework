// mjs-ws-bench — harnais de bench du serveur MJS-WS : orchestrateur qui spawn un serveur enfant
// RÉEL (mjs-ws-bench-server.ts, transport 'ws', socket loopback) par scénario, y branche des
// clients `ws` bruts (PAS µ.socket — chronométrage/latence maison, cf. classe BenchClient) et
// mesure connexions, écho (RTT), débit entrant, fan-out de salon et sa saturation. Jamais de
// verdict pass/fail ici — un banc purement DESCRIPTIF, cf. docs/23-mjs-ws.md pour le protocole µ:
// sous-jacent. Usage : `npx tsx bench/mjs-ws-bench.ts [--quick] [--only s1..s5] [--json <path>]
// [--payload <octets>] [--room <n>] [--dur <s>]` (ou `npm run bench:ws --`).

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Interface as ReadlineInterface } from 'node:readline'
import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import WebSocket from 'ws'
import type { MjsWsLimits, MjsWsStatsSnapshot } from '../src/mjs-ws/index.js'

interface BenchArgs {
  quick: boolean
  only: string | null
  jsonPath: string | null
  payload: number | null
  n: number
  c2: number
  r: number
  c3: number
  f: number
  room: number
  e: number
  dur: number
}

interface LigneResultat {
  libelle: string
  valeur: string
  unite: string
}

interface ScenarioResult {
  nom: string
  titre: string
  lignes: LigneResultat[]
  donnees: Record<string, number>
}

interface ServerConfig {
  port: number
  limits?: Partial<MjsWsLimits>
  heartbeat?: number
}

interface ServerHandle {
  child: ChildProcess
  rl: ReadlineInterface
  port: number
}

interface StatsPayload {
  stats: MjsWsStatsSnapshot
  rss: number
  erreursLog: number
}

// ============================================================================================
// CONSTANTES
// ============================================================================================

const WAVE_SIZE        = 50        // taille des vagues de connexion (S1 + connectFresh)
const WARMUP_MS        = 1000      // échauffement avant chaque fenêtre mesurée
const JOIN_SETTLE_MS   = 200       // laisse µ:join (async) se poser avant d'émettre (S4/S5)
const GRACE_TAIL_MS    = 300       // laisse les derniers acks/livraisons arriver après la fenêtre
const READY_TIMEOUT_MS = 15000     // délai max pour voir READY sur stdout du serveur enfant
const STATS_TIMEOUT_MS = 5000      // délai max pour une réponse STATS
const STOP_GRACE_MS    = 3000      // délai avant SIGKILL si STOP ne suffit pas
const TICK_MS          = 50        // cadence du régulateur d'envoi (setInterval)
const LIMITE_ENORME    = 1e9       // rate/burst/maxConnectionsPerIp/kickAfter — désactive les gardes de débit
const S5_MAX_BUFFERED  = 32 * 1024 * 1024
const S5_TAUX_CIBLE    = 2000      // msg/s cible de l'émetteur en saturation

const BASE_LIMITS: Partial<MjsWsLimits> = { rate: LIMITE_ENORME, burst: LIMITE_ENORME, maxConnectionsPerIp: LIMITE_ENORME, kickAfter: LIMITE_ENORME }
const S5_LIMITS:   Partial<MjsWsLimits> = { ...BASE_LIMITS, maxBuffered: S5_MAX_BUFFERED }

// le bench ne doit jamais planter en vol — comptée et loggée, jamais fatale
let erreursNonGerees = 0
process.on('unhandledRejection', (raison) => { erreursNonGerees++; console.error('[bench] unhandledRejection', raison) })

// ============================================================================================
// PETITS UTILITAIRES
// ============================================================================================

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

function randomPort(): number { return 20000 + Math.floor(Math.random() * 9000) }

function urlFor(port: number): string { return 'ws://127.0.0.1:'+port+'/' }

function fmt(n: number): string { return Number.isFinite(n) ? n.toFixed(2) : '—' }

// tri croissant + index Math.min(len-1, floor(q*len))
function percentiles(valeurs: number[]): { p50: number; p95: number; p99: number } {
  if (valeurs.length === 0) return { p50: NaN, p95: NaN, p99: NaN }
  const triees = valeurs.slice().sort((a, b) => a - b)
  const len    = triees.length
  const au     = (q: number) => triees[Math.min(len - 1, Math.floor(q * len))]
  return { p50: au(0.50), p95: au(0.95), p99: au(0.99) }
}

// {n, pad} — pad dimensionné pour approcher octetsCible une fois sérialisé (overhead JSON ~17 o)
function makePayload(octetsCible: number): () => { n: number; pad: string } {
  const pad = 'x'.repeat(Math.max(0, octetsCible - 17))
  let n = 0
  return () => ({ n: n++, pad })
}

function totalKicks(garde: MjsWsStatsSnapshot['garde']): number {
  return garde.kicksDebit + garde.kicksSilence + garde.kicksEngorgement + garde.kicksChargeUtile
}

// ============================================================================================
// CLIENT DE BENCH — ws brut (PAS µ.socket) : hello/welcome, fire, request→ack chronométré,
// abonnement générique aux messages entrants (fan-out S4/S5)
// ============================================================================================

class BenchClient {
  ws!: WebSocket
  rtts: number[] = []   // ms — rempli par request() à chaque µ:ack reçu
  erreurs = 0
  onMessage: ((msg: any) => void) | null = null

  private reqId   = 0
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; t0: bigint }>()

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })
    this.ws.on('message', (data) => this._onMessage(data))
    await this._hello()
  }

  private _hello(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMsg = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString())
        if (msg.t === 'µ:welcome') { this.ws.off('message', onMsg); resolve() }
        else if (msg.t === 'µ:denied') { this.ws.off('message', onMsg); reject(new Error('µ:denied — '+JSON.stringify(msg.p))) }
      }
      this.ws.on('message', onMsg)
      this.ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, resub: [], rooms: [] } }))
    })
  }

  private _onMessage(data: WebSocket.RawData): void {
    let msg: any
    try { msg = JSON.parse(data.toString()) }
    catch { this.erreurs++; return }
    if (msg.t === 'µ:ack' && msg.id != null) {
      const pendant = this.pending.get(msg.id)
      if (!pendant) return
      this.pending.delete(msg.id)
      const rttMs = Number(process.hrtime.bigint() - pendant.t0) / 1e6
      if (msg.e) { this.erreurs++; pendant.reject(msg.p) }
      else { this.rtts.push(rttMs); pendant.resolve(msg.p) }
      return
    }
    if (this.onMessage) this.onMessage(msg)
  }

  fire(type: string, p?: unknown): void {
    this.ws.send(JSON.stringify({ t: type, p }))
  }

  request(type: string, p?: unknown): Promise<any> {
    const id = 'b'+(++this.reqId)
    const t0 = process.hrtime.bigint()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, t0 })
      this.ws.send(JSON.stringify({ t: type, p, id }))
    })
  }

  join(room: string): void {
    this.ws.send(JSON.stringify({ t: 'µ:join', p: { room } }))
  }

  // efface les métriques du warmup avant la fenêtre mesurée — les promesses request() encore en
  // vol restent valides (juste exclues des rtts dès leur ack, cf. call sites .catch()-és)
  resetMetrics(): void {
    this.rtts    = []
    this.erreurs = 0
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) { resolve(); return }
      for (const [, pendant] of this.pending) pendant.reject(new Error('connexion fermée'))
      this.pending.clear()
      this.ws.once('close', () => resolve())
      this.ws.close()
    })
  }
}

async function connectFresh(port: number, effectif: number): Promise<BenchClient[]> {
  const clients: BenchClient[] = []
  for (let i = 0; i < effectif; i += WAVE_SIZE) {
    const vague     = Math.min(WAVE_SIZE, effectif - i)
    const promesses: Promise<void>[] = []
    for (let j = 0; j < vague; j++) {
      const c = new BenchClient()
      clients.push(c)
      promesses.push(c.connect(urlFor(port)))
    }
    await Promise.all(promesses)
  }
  return clients
}

// ============================================================================================
// CADENCEMENT D'ENVOI — un setInterval à 50 ms, k messages/tick + accumulateur fractionnaire
// (cible non multiple de 20/s absorbée sans dérive)
// ============================================================================================

function startPacedSender(envoi: () => void, tauxParSec: number): () => void {
  const parTick = tauxParSec * (TICK_MS / 1000)
  let acc       = 0
  const timer   = setInterval(() => {
    acc += parTick
    const k = Math.floor(acc)
    acc -= k
    for (let i = 0; i < k; i++) envoi()
  }, TICK_MS)
  return () => clearInterval(timer)
}

async function runPacedWindow(clients: BenchClient[], envoi: (c: BenchClient) => void, tauxParSec: number, dureeMs: number): Promise<void> {
  const arrets = clients.map((c) => startPacedSender(() => envoi(c), tauxParSec))
  await delay(dureeMs)
  arrets.forEach((arret) => arret())
}

// ============================================================================================
// SERVEUR ENFANT — spawn avec replis successifs, protocole stdin (STATS/STOP), arrêt garanti
// ============================================================================================

const SERVER_SCRIPT  = fileURLToPath(new URL('./mjs-ws-bench-server.ts', import.meta.url))
const MODULARJS_ROOT = dirname(dirname(SERVER_SCRIPT))

interface SpawnAttempt { cmd: string; args: string[] }

function buildAttempts(jsonConfig: string): SpawnAttempt[] {
  return [
    { cmd: process.execPath, args: ['--import', 'tsx', SERVER_SCRIPT, jsonConfig] },
    { cmd: process.execPath, args: ['--import', 'tsx/esm', SERVER_SCRIPT, jsonConfig] },
    { cmd: 'npx', args: ['tsx', SERVER_SCRIPT, jsonConfig] },
  ]
}

function attendReady(child: ChildProcess, rl: ReadlineInterface, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t       = setTimeout(() => { nettoie(); reject(new Error("timeout : le serveur enfant n'a jamais imprimé READY sous "+timeoutMs+' ms')) }, timeoutMs)
    const onLine  = (line: string) => { if (line.startsWith('READY ')) { nettoie(); resolve() } }
    const onExit  = (code: number | null) => { nettoie(); reject(new Error('le serveur enfant a quitté avant READY (code '+code+')')) }
    const onError = (err: Error) => { nettoie(); reject(err) }
    function nettoie(): void {
      clearTimeout(t)
      rl.off('line', onLine)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    rl.on('line', onLine)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

async function spawnServer(config: ServerConfig): Promise<ServerHandle> {
  const jsonConfig = JSON.stringify(config)
  const deadline   = Date.now() + READY_TIMEOUT_MS
  let dernierErr: unknown = null

  for (const tentative of buildAttempts(jsonConfig)) {
    const restant = deadline - Date.now()
    if (restant <= 0) break
    const child = spawn(tentative.cmd, tentative.args, { cwd: MODULARJS_ROOT, stdio: ['pipe', 'pipe', 'inherit'] })
    const rl    = createInterface({ input: child.stdout! })
    try {
      await attendReady(child, rl, restant)
      return { child, rl, port: config.port }
    } catch (err) {
      dernierErr = err
      rl.close()
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
    }
  }
  throw new Error('impossible de démarrer le serveur enfant du bench (toutes les stratégies de spawn ont échoué) — dernière erreur : '+String(dernierErr))
}

function statsRequest(handle: ServerHandle): Promise<StatsPayload> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { handle.rl.off('line', onLine); reject(new Error('timeout en attendant STATS du serveur enfant')) }, STATS_TIMEOUT_MS)
    const onLine = (line: string) => {
      if (!line.startsWith('STATS ')) return
      clearTimeout(t)
      handle.rl.off('line', onLine)
      resolve(JSON.parse(line.slice('STATS '.length)))
    }
    handle.rl.on('line', onLine)
    handle.child.stdin!.write('STATS\n')
  })
}

async function stopServer(handle: ServerHandle): Promise<void> {
  try {
    if (handle.child.exitCode == null && handle.child.signalCode == null) {
      try { handle.child.stdin!.write('STOP\n') }
      catch { /* pipe déjà fermé — la mort forcée ci-dessous suffit */ }
      await Promise.race([
        new Promise<void>((resolve) => handle.child.once('exit', () => resolve())),
        delay(STOP_GRACE_MS),
      ])
    }
  } finally {
    if (handle.child.exitCode == null && handle.child.signalCode == null) handle.child.kill('SIGKILL')
    handle.rl.close()
  }
}

// ============================================================================================
// SCÉNARIOS — chacun spawn SON serveur (limites dédiées), connexions fraîches, warmup ~1 s,
// fenêtre mesurée, fermeture propre de toutes les sockets avant le suivant
// ============================================================================================

async function scenarioS1(args: BenchArgs): Promise<ScenarioResult> {
  const handle = await spawnServer({ port: randomPort(), limits: BASE_LIMITS })
  try {
    const n = args.n
    const clients: BenchClient[] = []
    const t0 = performance.now()
    for (let i = 0; i < n; i += WAVE_SIZE) {
      const vague     = Math.min(WAVE_SIZE, n - i)
      const promesses: Promise<void>[] = []
      for (let j = 0; j < vague; j++) {
        const c = new BenchClient()
        clients.push(c)
        promesses.push(c.connect(urlFor(handle.port)))
      }
      await Promise.all(promesses)
    }
    const dureeS     = (performance.now() - t0) / 1000
    const debitConnS = n / dureeS
    const apres      = await statsRequest(handle)

    const lignes: LigneResultat[] = [
      { libelle: 'connexions ouvertes',   valeur: String(n),                                   unite: '' },
      { libelle: 'durée totale',          valeur: fmt(dureeS),                                 unite: 's' },
      { libelle: 'débit de connexion',    valeur: fmt(debitConnS),                             unite: 'conn/s' },
      { libelle: 'accueillies (serveur)', valeur: String(apres.stats.connexions.accueillies),  unite: '' },
      { libelle: 'RSS serveur après',     valeur: fmt(apres.rss / 1024 / 1024),                unite: 'Mio' },
    ]

    await Promise.all(clients.map((c) => c.close()))
    return { nom: 's1', titre: 'S1 — connexions', lignes, donnees: { n, dureeS, debitConnS, welcomedTotal: apres.stats.connexions.accueillies, rssMio: apres.rss / 1024 / 1024 } }
  } finally {
    await stopServer(handle)
  }
}

async function scenarioS2(args: BenchArgs): Promise<ScenarioResult> {
  const handle = await spawnServer({ port: randomPort(), limits: BASE_LIMITS })
  try {
    const c = args.c2, r = args.r, d = args.dur
    const octets  = args.payload ?? 200
    const payload = makePayload(octets)
    const clients = await connectFresh(handle.port, c)
    const envoi   = (client: BenchClient) => { void client.request('bench:echo', payload()).catch(() => {}) }

    await runPacedWindow(clients, envoi, r, WARMUP_MS)
    clients.forEach((cl) => cl.resetMetrics())

    await runPacedWindow(clients, envoi, r, d * 1000)
    await delay(GRACE_TAIL_MS)

    const rtts       = clients.flatMap((cl) => cl.rtts)
    const erreurs    = clients.reduce((s, cl) => s + cl.erreurs, 0)
    const pct        = percentiles(rtts)
    const acksParSec = rtts.length / d

    const lignes: LigneResultat[] = [
      { libelle: 'clients',        valeur: String(c),       unite: '' },
      { libelle: 'débit cible',    valeur: String(c * r),   unite: 'req/s' },
      { libelle: 'acks effectifs', valeur: fmt(acksParSec), unite: '/s' },
      { libelle: 'RTT p50',        valeur: fmt(pct.p50),    unite: 'ms' },
      { libelle: 'RTT p95',        valeur: fmt(pct.p95),    unite: 'ms' },
      { libelle: 'RTT p99',        valeur: fmt(pct.p99),    unite: 'ms' },
      { libelle: 'erreurs',        valeur: String(erreurs), unite: '' },
    ]

    await Promise.all(clients.map((cl) => cl.close()))
    return { nom: 's2', titre: 'S2 — écho RTT', lignes, donnees: { c, r, d, octets, acksParSec, p50: pct.p50, p95: pct.p95, p99: pct.p99, erreurs } }
  } finally {
    await stopServer(handle)
  }
}

async function scenarioS3(args: BenchArgs): Promise<ScenarioResult> {
  const handle = await spawnServer({ port: randomPort(), limits: BASE_LIMITS })
  try {
    const c = args.c3, f = args.f, d = args.dur
    const octets  = args.payload ?? 200
    const payload = makePayload(octets)
    const clients = await connectFresh(handle.port, c)

    let envoyes = 0
    const envoiChauffe = (client: BenchClient) => { client.fire('bench:fire', payload()) }
    const envoiMesure  = (client: BenchClient) => { client.fire('bench:fire', payload()); envoyes++ }

    await runPacedWindow(clients, envoiChauffe, f, WARMUP_MS)

    const avant = await statsRequest(handle)
    await runPacedWindow(clients, envoiMesure, f, d * 1000)
    await delay(GRACE_TAIL_MS)
    const apres = await statsRequest(handle)

    const recusParSec   = (apres.stats.messages.recus - avant.stats.messages.recus) / d
    const envoyesParSec = envoyes / d
    const rejetesDelta  = apres.stats.messages.rejetes - avant.stats.messages.rejetes

    const lignes: LigneResultat[] = [
      { libelle: 'clients',               valeur: String(c),            unite: '' },
      { libelle: 'débit cible',            valeur: String(c * f),        unite: 'msg/s' },
      { libelle: 'envoyés (client)',       valeur: fmt(envoyesParSec),   unite: '/s' },
      { libelle: 'reçus (serveur, delta)', valeur: fmt(recusParSec),     unite: '/s' },
      { libelle: 'rejets serveur',         valeur: String(rejetesDelta), unite: '' },
    ]

    await Promise.all(clients.map((cl) => cl.close()))
    return { nom: 's3', titre: 'S3 — débit entrant', lignes, donnees: { c, f, d, octets, envoyesParSec, recusParSec, rejetesDelta } }
  } finally {
    await stopServer(handle)
  }
}

// fan-out partagé S4/S5 — M membres de 'bench:salle' + 1 émetteur fire('bench:say', …) relayé
// côté serveur en 'bench:msg' (cf. mjs-ws-bench-server.ts) ; latence aller-simple = même process
// (horloge commune), tsEnvoiMs embarqué dans le payload par l'émetteur
async function runFanout(nom: string, titre: string, args: BenchArgs, limits: Partial<MjsWsLimits>, tauxCible: number, octets: number, avecRss: boolean): Promise<ScenarioResult> {
  const handle = await spawnServer({ port: randomPort(), limits })
  try {
    const m       = args.room, d = args.dur
    const membres = await connectFresh(handle.port, m)
    membres.forEach((cl) => cl.join('bench:salle'))
    await delay(JOIN_SETTLE_MS)   // µ:join traité async côté serveur (opts.join awaited même synchrone)

    let livraisons = 0
    let latences: number[] = []
    membres.forEach((cl) => {
      cl.onMessage = (msg) => {
        if (msg.t !== 'bench:msg') return
        livraisons++
        latences.push(performance.now() - Number(msg.p?.tsEnvoiMs))
      }
    })

    const emetteur = new BenchClient()
    await emetteur.connect(urlFor(handle.port))
    const payload = makePayload(octets)
    const envoi   = () => emetteur.fire('bench:say', { ...payload(), tsEnvoiMs: performance.now() })

    await runPacedWindow([emetteur], envoi, tauxCible, WARMUP_MS)
    await delay(JOIN_SETTLE_MS)
    livraisons = 0
    latences   = []

    const avant = await statsRequest(handle)
    await runPacedWindow([emetteur], envoi, tauxCible, d * 1000)
    await delay(GRACE_TAIL_MS)
    const apres = await statsRequest(handle)

    const pct           = percentiles(latences)
    const livraisonsSec = livraisons / d
    const rejetesDelta  = apres.stats.messages.rejetes - avant.stats.messages.rejetes
    const kicksDelta    = totalKicks(apres.stats.garde) - totalKicks(avant.stats.garde)

    const lignes: LigneResultat[] = [
      { libelle: 'membres du salon',         valeur: String(m),             unite: '' },
      { libelle: 'débit émetteur cible',     valeur: String(tauxCible),     unite: 'msg/s' },
      { libelle: 'livraisons agrégées',      valeur: fmt(livraisonsSec),    unite: '/s' },
      { libelle: 'latence aller-simple p50', valeur: fmt(pct.p50),          unite: 'ms' },
      { libelle: 'latence aller-simple p95', valeur: fmt(pct.p95),          unite: 'ms' },
      { libelle: 'latence aller-simple p99', valeur: fmt(pct.p99),          unite: 'ms' },
      { libelle: 'rejets serveur',           valeur: String(rejetesDelta),  unite: '' },
      { libelle: 'kicks',                    valeur: String(kicksDelta),    unite: '' },
    ]
    if (avecRss) lignes.push({ libelle: 'RSS serveur', valeur: fmt(apres.rss / 1024 / 1024), unite: 'Mio' })

    await emetteur.close()
    await Promise.all(membres.map((cl) => cl.close()))
    return { nom, titre, lignes, donnees: { m, tauxCible, octets, livraisonsSec, p50: pct.p50, p95: pct.p95, p99: pct.p99, rejetesDelta, kicksDelta, rssMio: apres.rss / 1024 / 1024 } }
  } finally {
    await stopServer(handle)
  }
}

function scenarioS4(args: BenchArgs): Promise<ScenarioResult> {
  return runFanout('s4', 'S4 — fan-out salon', args, BASE_LIMITS, args.e, args.payload ?? 500, false)
}

function scenarioS5(args: BenchArgs): Promise<ScenarioResult> {
  return runFanout('s5', 'S5 — saturation fan-out', args, S5_LIMITS, S5_TAUX_CIBLE, args.payload ?? 1024, true)
}

// ============================================================================================
// AFFICHAGE — tableau aligné par scénario + récapitulatif final
// ============================================================================================

function afficheTableau(res: ScenarioResult): void {
  console.log('')
  console.log(res.titre)
  console.log('-'.repeat(res.titre.length))
  const w1 = Math.max(...res.lignes.map((l) => l.libelle.length))
  const w2 = Math.max(...res.lignes.map((l) => l.valeur.length))
  for (const l of res.lignes) console.log(l.libelle.padEnd(w1)+'  '+l.valeur.padStart(w2)+(l.unite ? ' '+l.unite : ''))
}

function afficheRecap(resultats: ScenarioResult[]): void {
  console.log('')
  console.log('=== récapitulatif ===')
  for (const res of resultats) console.log(res.nom.toUpperCase()+' : '+res.lignes.map((l) => l.libelle+'='+l.valeur+l.unite).join(', '))
  console.log('')
  console.log('erreurs process non gérées : '+erreursNonGerees)
}

// ============================================================================================
// CLI — arguments, sélection des scénarios, export JSON
// ============================================================================================

function flagValue(argv: string[], nom: string): string | null {
  const i = argv.indexOf(nom)
  return i === -1 || i === argv.length - 1 ? null : argv[i + 1]
}

function numFlag(argv: string[], nom: string): number | null {
  const brut = flagValue(argv, nom)
  return brut == null ? null : Number(brut)
}

function parseArgs(argv: string[]): BenchArgs {
  const quick = argv.includes('--quick')
  const args: BenchArgs = {
    quick,
    only:     flagValue(argv, '--only'),
    jsonPath: flagValue(argv, '--json'),
    payload:  numFlag(argv, '--payload'),
    n:    quick ? 60 : 400,
    c2:   quick ? 10 : 50,
    r:    20,
    c3:   quick ? 20 : 100,
    f:    150,
    room: quick ? 30 : 150,
    e:    25,
    dur:  quick ? 3 : 8,
  }
  const room = numFlag(argv, '--room'); if (room != null) args.room = room
  const dur  = numFlag(argv, '--dur');  if (dur != null) args.dur = dur
  return args
}

const SCENARIOS: Array<[string, (a: BenchArgs) => Promise<ScenarioResult>]> = [
  ['s1', scenarioS1], ['s2', scenarioS2], ['s3', scenarioS3], ['s4', scenarioS4], ['s5', scenarioS5],
]

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  let selection = SCENARIOS
  if (args.only) {
    const nom    = args.only.toLowerCase()
    const trouve = SCENARIOS.find(([n]) => n === nom)
    if (!trouve) throw new Error("--only invalide : '"+args.only+"' — valeurs attendues s1..s5")
    selection = [trouve]
  }

  const resultats: ScenarioResult[] = []
  for (const [nom, fn] of selection) {
    console.log('')
    console.log('=== '+nom.toUpperCase()+' — en cours… ===')
    const res = await fn(args)
    resultats.push(res)
    afficheTableau(res)
  }

  afficheRecap(resultats)
  if (args.jsonPath) writeFileSync(args.jsonPath, JSON.stringify(resultats, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('[bench] échec :', err); process.exit(1) })
