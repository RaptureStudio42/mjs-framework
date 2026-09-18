// mjs-ws-bench-server — processus ENFANT du harnais de bench (mjs-ws-bench.ts, l'orchestrateur) :
// boote un vrai serveur MJS-WS (transport 'ws', socket réel) piloté par sa config reçue en
// argv[2] (JSON), puis répond aux commandes de l'orchestrateur sur stdin ligne à ligne (STATS/
// STOP). Jamais lancé directement par un humain — cf. mjs-ws-bench.ts pour le spawn + les
// scénarios de charge. Handlers applicatifs 'bench:*' : écho (S2), débit entrant (S3), relais de
// salon (S4/S5) — cf. docs/23-mjs-ws.md pour le protocole µ: sous-jacent.

import { createInterface } from 'node:readline'
import { mjsWs } from '../src/mjs-ws/index.js'
import type { MjsWsLimits, MjsWsLogLevel } from '../src/mjs-ws/index.js'

interface BenchServerConfig {
  port: number
  limits?: Partial<MjsWsLimits>
  heartbeat?: number
}

const config: BenchServerConfig = JSON.parse(process.argv[2])

// compteur d'erreurs de log — remonté à l'orchestrateur via STATS (cf. handleLine plus bas)
let erreursLog = 0

// silencieux SAUF les erreurs, qu'on compte ET affiche (stderr hérité par l'orchestrateur, cf.
// spawnServer côté mjs-ws-bench.ts)
function logSiErreur(level: MjsWsLogLevel, message: string, meta?: unknown): void {
  if (level !== 'error') return
  erreursLog++
  console.error('[bench-server]', message, meta ?? '')
}

const app = mjsWs({
  transport: 'ws',
  port:      config.port,
  host:      '127.0.0.1',
  heartbeat: config.heartbeat,
  limits:    config.limits,
  // salon ouvert à tout join préfixé 'bench' (aucune garde métier — pur banc de charge)
  rooms:     { join: (room) => room.startsWith('bench') },
  onLog:     logSiErreur,
})

// écho — renvoie le payload reçu tel quel (S2, mesure de RTT)
app.serve('bench:echo', (p) => p)

// fire-and-forget — no-op, seul le débit entrant côté stats serveur nous intéresse (S3)
app.on('bench:fire', () => {})

// relais de salon — un émetteur fire('bench:say', p) fait rediffuser p à tout 'bench:salle' (S4/S5)
app.on('bench:say', (p) => { app.room('bench:salle').send('bench:msg', p) })

async function main(): Promise<void> {
  await app.listen()
  console.log('READY '+config.port)

  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => { void handleLine(line.trim()) })
}

async function handleLine(cmd: string): Promise<void> {
  if (cmd === 'STATS') console.log('STATS '+JSON.stringify({ stats: app.stats(), rss: process.memoryUsage().rss, erreursLog }))
  else if (cmd === 'STOP') { await app.stop(); process.exit(0) }
}

main().catch((err) => { console.error('[bench-server] erreur au boot', err); process.exit(1) })
