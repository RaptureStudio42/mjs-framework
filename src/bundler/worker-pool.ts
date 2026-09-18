// bundler/worker-pool — pool de workers réutilisables pour `transpile()`.
//
// Pool de taille fixe (~cpus().length workers). Chaque worker reste alive
// pour toute la durée du Bundler — pas de spawn/teardown par fichier (le
// startup d'un worker coûte ~50-100ms, on amortit sur 100+ fichiers).
//
// API :
//   pool.submit(msg) → Promise<result>     // file vers worker libre, FIFO
//   pool.terminate() → Promise<void>       // clean shutdown
//
// Robustesse :
//   - Si un worker crash, ses tâches en cours sont reject avec l'erreur.
//   - Pas de re-spawn auto (le master peut re-créer un pool si besoin).
//
// Détection mode dev/prod : le worker script peut être .ts (dev via tsx)
// ou .js (prod compilé). `resolveWorkerScript` cherche les deux et passe
// le bon `execArgv` au Worker pour tsx en dev.

import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { t } from '../messages/index.js'

interface WorkerSpec {
  /** Path absolu vers le script du worker (.mjs bootstrap ou .js compilé). */
  workerPath: string
  /** Si non null, passé via `workerData` au worker (path du .ts à importer en dev). */
  workerData?: any
}

// délai maximal par tâche, une fois DISPATCHÉE à un worker (jamais compté
// pendant l'attente en queue, congestion normale sous forte charge — pas un signal de panne).
// Au-delà : tâche en échec, worker RETIRÉ du pool (jamais réutilisé — un worker qui a débordé une
// fois reste suspect). Constante nommée, overridable via `WorkerPoolOpts.timeoutMs` (tests).
const DEFAULT_SUBMIT_TIMEOUT_MS = 60_000

interface WorkerPoolOpts {
  /** Délai maximal (ms) par tâche dispatchée. Défaut DEFAULT_SUBMIT_TIMEOUT_MS. */
  timeoutMs?: number
}

interface PendingTask {
  msg: any
  resolve: (v: any) => void
  reject: (e: any) => void
}

interface InFlightTask {
  resolve: (v: any) => void
  reject: (e: any) => void
  worker: Worker
  /** minuteur du délai par tâche — CLEARÉ dès la réponse (handleResponse) ou l'échec (handleError) :
   *  jamais laissé courir après coup, sinon il finirait par juger un AUTRE worker/tâche que le sien. */
  timer: NodeJS.Timeout
}

export class WorkerPool {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private queue: PendingTask[] = []
  private nextId = 0
  private inFlight = new Map<number, InFlightTask>()
  private terminated = false
  private timeoutMs: number

  constructor(size: number, spec: WorkerSpec, opts: WorkerPoolOpts = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS
    for (let i = 0; i < size; i++) {
      const w = new Worker(spec.workerPath, {
        workerData: spec.workerData,
      })
      w.on('message', (response: any) => this.handleResponse(w, response))
      w.on('error', (err: Error) => this.handleError(w, err))
      // Un thread peut SORTIR sans émettre 'error' (process.exit, OOM) : sans
      // ce handler, ses tâches in-flight pendaient à jamais et le worker mort
      // restait éligible au dispatch.
      w.on('exit', (code: number) => {
        if (this.terminated) return
        // Un `exit` code 0 AVEC une tâche en vol (process.exit propre côté
        // worker, OOM silencieux…) laissait la promesse orpheline : on rejette
        // sa tâche + redispatch la queue via handleError, comme pour un crash.
        // Sinon (worker idle qui sort proprement), simple retrait.
        const hasInFlight = [...this.inFlight.values()].some(p => p.worker === w)
        if (code !== 0 || hasInFlight) {
          this.handleError(w, new Error(t('bundler.worker-pool.worker-sorti', { code })))
        } else {
          this.removeWorker(w)
        }
      })
      // Note : on NE PAS unref() — sinon Node peut exit avant que les workers
      // aient eu le temps de répondre (les pending promises n'empêchent pas
      // Node d'exit sur des workers unref'd). Le caller DOIT appeler
      // `pool.terminate()` (ou `bundler.close()`) explicitement.
      this.workers.push(w)
      this.idle.push(w)
    }
  }

  /** true si le pool n'a plus AUCUN worker vivant (tous crashés/sortis).
   *  Le caller (ensureWorkerPool) doit alors recréer un pool frais. */
  isDead(): boolean {
    return this.workers.length === 0
  }

  /** Soumet un message au prochain worker libre. Retourne le résultat. */
  submit<T = any>(msg: any): Promise<T> {
    if (this.terminated) {
      return Promise.reject(new Error(t('bundler.worker-pool.deja-termine')))
    }
    // Aucun worker vivant : la tâche partirait en queue sans jamais être
    // dispatchée (personne pour la traiter) → hang. On rejette tout de suite ;
    // c'est à ensureWorkerPool de recréer un pool avant le prochain submit.
    if (this.workers.length === 0) {
      return Promise.reject(new Error(t('bundler.worker-pool.aucun-worker-vivant')))
    }
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      const fullMsg = { ...msg, id }
      const w = this.idle.pop()
      if (w) {
        this.dispatch(id, w, fullMsg, resolve, reject)
      } else {
        this.queue.push({ msg: fullMsg, resolve, reject })
      }
    })
  }

  // dispatch — poste `msg` à `w` et arme le délai par tâche : au-delà de `timeoutMs`
  // sans réponse, MÊME traitement qu'un crash (`handleError`, reject + retrait du worker +
  // redispatch/orphelins) + `worker.terminate()` forcé (le thread est planté pour de bon, jamais
  // laissé tourner en tâche de fond). Un seul point de dispatch pour les 3 appelants (submit(),
  // handleResponse(), redispatchQueue()) : le minuteur ne peut pas être oublié sur l'un d'eux.
  private dispatch(id: number, w: Worker, msg: any, resolve: (v: any) => void, reject: (e: any) => void): void {
    const timer = setTimeout(() => {
      const nomTache = String(msg?.moduleName ?? msg?.type ?? '?')
      this.handleError(w, new Error(t('bundler.worker-pool.tache-timeout', { fichier: nomTache, ms: this.timeoutMs })))
      void w.terminate().catch(() => {})
    }, this.timeoutMs)
    this.inFlight.set(id, { resolve, reject, worker: w, timer })
    w.postMessage(msg)
  }

  private handleResponse(w: Worker, response: any): void {
    const pending = this.inFlight.get(response.id)
    if (!pending) return  // réponse orpheline, on l'ignore
    clearTimeout(pending.timer)
    this.inFlight.delete(response.id)

    if (response.ok) {
      pending.resolve(response.result)
    } else {
      const err = new Error(response.error ?? t('bundler.worker-pool.erreur-inconnue'))
      if (response.stack) (err as any).stack = response.stack
      pending.reject(err)
    }

    // Worker libre : dispatch la prochaine tâche en queue ou retour en idle.
    const next = this.queue.shift()
    if (next) {
      const newId = (next.msg as any).id
      this.dispatch(newId, w, next.msg, next.resolve, next.reject)
    } else {
      this.idle.push(w)
    }
  }

  private handleError(w: Worker, err: Error): void {
    // Reject toutes les tâches en flight sur ce worker.
    for (const [id, p] of this.inFlight) {
      if (p.worker === w) {
        clearTimeout(p.timer)
        p.reject(err)
        this.inFlight.delete(id)
      }
    }
    // Avant : le worker crashé restait dans `workers`/`idle` (postMessage dans
    // le vide → promesses pendantes à jamais) et la queue n'était jamais
    // redistribuée (si tous mouraient, compile() pendait sans message).
    this.removeWorker(w)
    if (this.workers.length === 0) {
      const orphans = this.queue
      this.queue = []
      for (const p of orphans) {
        p.reject(new Error(t('bundler.worker-pool.plus-aucun-worker', { message: err.message })))
      }
    } else {
      this.redispatchQueue()
    }
  }

  private removeWorker(w: Worker): void {
    const wi = this.workers.indexOf(w)
    if (wi !== -1) this.workers.splice(wi, 1)
    const ii = this.idle.indexOf(w)
    if (ii !== -1) this.idle.splice(ii, 1)
  }

  private redispatchQueue(): void {
    let w = this.idle.pop()
    while (w && this.queue.length > 0) {
      const next = this.queue.shift()!
      const id = (next.msg as any).id
      this.dispatch(id, w, next.msg, next.resolve, next.reject)
      w = this.idle.pop()
    }
    if (w) this.idle.push(w)
  }

  async terminate(): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    // Reject les tâches en attente
    for (const p of this.queue) {
      p.reject(new Error(t('bundler.worker-pool.terminate-queue')))
    }
    this.queue = []
    // Reject AUSSI les in-flight : `worker.terminate()` n'émet pas 'error' —
    // un compile() concurrent restait suspendu pour toujours.
    for (const [, p] of this.inFlight) {
      clearTimeout(p.timer)
      p.reject(new Error(t('bundler.worker-pool.terminate-inflight')))
    }
    this.inFlight.clear()
    await Promise.all(this.workers.map(w => w.terminate()))
    this.workers = []
    this.idle = []
  }
}

/**
 * Localise (ou compile) le script worker.
 *
 * - En prod (dist) : `worker.js` est déjà compilé par `build:self`, on l'utilise direct.
 * - En dev (src .ts) : Node Workers ne supportent pas le chargement de `.ts`
 *   (l'option `--import tsx/esm` n'est pas appliquée aux threads workers).
 *   On compile donc `worker.ts` → `.mjs` via esbuild en mémoire, écrit dans
 *   un fichier cache de `os.tmpdir()`, et passe ce path au Worker.
 *   La compile coûte ~50-200ms one-time par session de bundler.
 */
export async function resolveWorkerScript(): Promise<WorkerSpec> {
  const thisFile = fileURLToPath(import.meta.url)
  const thisDir = dirname(thisFile)

  // En prod : .js compilé existe à côté de worker-pool.js
  const jsPath = join(thisDir, 'worker.js')
  if (existsSync(jsPath)) {
    return { workerPath: jsPath }
  }

  // En dev : compile worker.ts à la volée
  const tsPath = join(thisDir, 'worker.ts')
  if (!existsSync(tsPath)) {
    throw new Error(t('bundler.worker-pool.worker-ts-introuvable', { chemin: tsPath }))
  }
  const compiledPath = await compileWorkerInMemory(tsPath)
  return { workerPath: compiledPath }
}

// Cache du worker compilé pour éviter de re-compiler à chaque appel à
// `resolveWorkerScript`. La compile dure ~50-200ms et le résultat est
// déterministe pour un même worker.ts.
let _cachedWorkerJsPath: string | null = null

async function compileWorkerInMemory(workerTsPath: string): Promise<string> {
  if (_cachedWorkerJsPath && existsSync(_cachedWorkerJsPath)) {
    return _cachedWorkerJsPath
  }
  // Cache dir : on doit écrire le worker.mjs DANS un dossier qui a accès au
  // node_modules du projet MJS (pour résoudre les `import 'acorn'`, etc. à
  // l'exécution). `os.tmpdir()` est hors node_modules tree → import échoue.
  // Solution : chercher le node_modules ancestor depuis worker-pool.ts, et
  // écrire dans `<that_node_modules>/.cache/mjs/`.
  const { dir: cacheDir, bundleDeps } = findCacheDir(workerTsPath)
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
  // Hash sur le path pour éviter conflit entre projets utilisant MJS
  const projectHash = createHash('sha256').update(workerTsPath).digest('hex').slice(0, 8)
  const outFile = join(cacheDir, `worker-${projectHash}.mjs`)
  // `packages: 'external'` était
  // codé en DUR ici, contredisant la propre doc de `findCacheDir` juste en
  // dessous : dans le cas de repli `os.tmpdir()` (aucun `node_modules`
  // ancêtre trouvé), le fichier compilé est écrit HORS de tout arbre
  // node_modules — ses `import 'acorn'`/`import 'esbuild'`/etc. externes
  // ne peuvent alors JAMAIS être résolus à l'exécution (aucun node_modules
  // accessible depuis ce dossier) → le worker CRASHE AU BOOT
  // ("Cannot find module 'acorn'"). Le commentaire de `findCacheDir`
  // promettait déjà d'embarquer les deps pour ce cas précis — jamais
  // implémenté. Fix : `findCacheDir` renvoie maintenant aussi `bundleDeps`,
  // utilisé ici pour choisir le bon mode.
  //
  // `packages: 'external'` (cas normal) : les deps npm (acorn, esbuild,
  // @danielx/civet, etc.) restent en `import` runtime → résolues à
  // l'exécution depuis node_modules du projet. Pas de gros bundle, juste le
  // code MJS compilé. Repli : `packages` OMIS (pas `'bundle'` — vérifié
  // empiriquement que cette valeur n'existe pas dans l'esbuild installé,
  // rejetée au runtime avec "Invalid value 'bundle'" ; la doc de
  // `findCacheDir` employait ce mot à tort) — laisser `packages` à
  // `undefined` restaure le comportement de bundling COMPLET déjà induit
  // par `bundle: true` : esbuild résout et EMBARQUE alors chaque dépendance
  // directement dans le fichier de sortie (résolution effectuée depuis
  // `workerTsPath`, qui a TOUJOURS accès au node_modules du framework,
  // peu importe où le fichier de SORTIE atterrit ensuite) — plus gros et
  // plus lent au démarrage, mais fonctionne peu importe où il est chargé.
  // DURCISSEMENT — `worker-<hash>.mjs`
  // est le MÊME fichier pour tous les projets d'une installation : 2 process
  // (2 projets, CI parallèle) écrivant DIRECTEMENT dessus pouvaient laisser un
  // fichier TRONQUÉ pendant que l'autre spawne des Workers dessus → worker
  // cassé au boot. Écriture ATOMIQUE : esbuild écrit dans un temp UNIQUE (pid),
  // puis renameSync (atomique sur le même volume) — jamais d'état intermédiaire
  // visible, et un Worker déjà en cours de chargement garde son inode.
  const tmpOut = join(cacheDir, `worker-${projectHash}.${process.pid}.${Date.now()}.tmp.mjs`)
  await build({
    entryPoints: [workerTsPath],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    packages: bundleDeps ? undefined : 'external',
    outfile: tmpOut,
    logLevel: 'silent',
  })
  try {
    renameSync(tmpOut, outFile)
  } catch (e) {
    try { unlinkSync(tmpOut) } catch {}
    // Un autre process a pu gagner la course et produire un outFile valide
    // (même contenu, par construction) — dans ce cas, non fatal.
    if (!existsSync(outFile)) throw e
  }
  _cachedWorkerJsPath = outFile
  return outFile
}

/**
 * Cherche un dossier `node_modules/.cache/mjs` à partir du path donné en
 * remontant vers la racine. Si trouvé : retourne ce path avec `bundleDeps:
 * false` (les deps npm restent résolues à l'exécution depuis ce
 * node_modules). Sinon : fallback sur `os.tmpdir()/mjs-worker-cache/` avec
 * `bundleDeps: true` (aucun node_modules accessible depuis ce dossier —
 * les deps DOIVENT être embarquées dans le bundle, cf. `compileWorkerInMemory`).
 */
function findCacheDir(fromPath: string): { dir: string; bundleDeps: boolean } {
  let dir = dirname(fromPath)
  while (dir !== dirname(dir)) {  // jusqu'à la racine
    const nm = join(dir, 'node_modules')
    if (existsSync(nm)) {
      return { dir: join(nm, '.cache', 'mjs'), bundleDeps: false }
    }
    dir = dirname(dir)
  }
  // DURCISSEMENT — isole par UID : un tmpdir
  // PARTAGÉ (typiquement `/tmp`) rendait `mjs-worker-cache` PRÉVISIBLE et commun
  // à tous les utilisateurs de la machine (pré-seed / hijack d'un worker par un
  // autre utilisateur sur une machine multi-utilisateurs). `process.getuid` est
  // absent sous Windows → repli `'nouid'`.
  return { dir: join(tmpdir(), `mjs-worker-cache-${process.getuid?.() ?? 'nouid'}`), bundleDeps: true }
}

// Exports réservés aux tests (mineur : vérifier le choix packages:'bundle'
// vs 'external' sans dépendre du cache module-level, partagé avec le VRAI
// pool utilisé par les autres tests du process Mocha).
export const _internal = { compileWorkerInMemory, findCacheDir, resetCompileCache: () => { _cachedWorkerJsPath = null } }
