// Régression — la persistance pouvait TUER le process. Deux mécanismes
// distincts couverts ici (cf. commentaires de tête persist.ts/persist-file.ts pour le détail) :
//   1. `_suivre` (dupliqué dans persist-file/sql/redis/bridge.ts) faisait `p.finally(cb)` SANS
//      `.catch()` — une promesse suivie qui rejette devient une promesse ORPHELINE rejetée (le
//      retour de `.finally()` n'est ni stocké ni catché) → unhandledRejection → Node 20 tue le
//      process. Fix : `.catch(err => onLog('warn', …))` AVANT le `.finally()` dans les 4 adaptateurs.
//   2. persist-file.ts `_ecrireAtomique` faisait `await this._pret` (mkdir initial) HORS du try —
//      un mkdir raté (dossier inaccessible, chemin sous un fichier…) rejetait `_ecrireAtomique` À
//      SEC, sans même passer par le `catch` prévu pour writeFile/rename. Fix : `_pret` DANS le try.
// MÊME patron `process.on('unhandledRejection', …)` + `off()` en `finally` que
// tests/mjs-ws-core.test.ts (test 13, « onLog qui throw »).
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsServer, resolvePersistOption, createPersistEngine, FilePersistAdapter } from '../src/mjs-server/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsServerApp, MjsServerOptions } from '../src/mjs-server/index.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

/** MÊME patron que tests/mjs-ws-core.test.ts (test 13) — pose un filet AVANT le geste risqué,
 *  le retire toujours (finally), assert à la fin plutôt que dans le handler (un throw DANS un
 *  listener 'unhandledRejection' deviendrait lui-même une uncaughtException synchrone). */
async function sansUnhandledRejection(faire: () => Promise<void>): Promise<void> {
  let capté: unknown = null
  const onUnhandled = (reason: unknown) => { capté = reason }
  process.on('unhandledRejection', onUnhandled)
  try {
    await faire()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  assert.equal(capté, null, `un rejet de promesse non géré a fuité : ${capté}`)
}

// --- 1-2 : le moteur (persist.ts creerPersistEngine) directement — MÊME patron « partie fake +
// _onMutate appelé à la main » que le test 11 existant (mjs-server-persist.test.ts, snapshotEvery) ---

describe('MJS-Server — persistance : erreurs NON FATALES, JAMAIS de crash process', () => {
  it("1. save() d'un adaptateur cassé (rejette) → warn loggé, AUCUN unhandledRejection, le moteur continue de fonctionner ensuite", async () => {
    const warns: string[] = []
    let appels = 0
    const casse = {
      load: async () => [],
      save: (_id: string, _données: any) => { appels++; return Promise.reject(new Error('save cassé (fixture test)')) },
      remove: (_id: string) => {},
    }

    await sansUnhandledRejection(async () => {
      const resolved = resolvePersistOption({ adapter: casse, debounce: 10 })!
      const engine   = createPersistEngine(resolved, (level, message) => { if (level === 'warn') warns.push(message) })!
      const partieFake: any = { id: 'pf1', serialize: () => ({ id: 'pf1', n: 1 }), _onMutate: null }
      engine.armGame(partieFake)

      partieFake._onMutate(partieFake)   // → programmerSauvegarde → debounce 10ms → executerSauvegarde → save() rejette
      await tick(50)
      assert.equal(appels, 1, 'sanity : save() cassé doit avoir été appelé une fois')
      assert.ok(warns.some(m => /persist\.save.*échoué/.test(m)), `un warn doit signaler le save() cassé, reçu : ${JSON.stringify(warns)}`)

      // (c) le moteur continue de fonctionner — une mutation SUIVANTE redéclenche encore un save()
      partieFake._onMutate(partieFake)
      await tick(50)
      assert.equal(appels, 2, "une mutation suivante doit encore déclencher un save() — le moteur ne s'est pas arrêté")

      await engine.stop()
    })
  })

  it("2. remove() d'un adaptateur cassé (rejette, cf. oublierPartie) → warn loggé, AUCUN unhandledRejection", async () => {
    const warns: string[] = []
    const casse = {
      load: async () => [],
      save: (_id: string, _données: any) => {},
      remove: (_id: string) => Promise.reject(new Error('remove cassé (fixture test)')),
    }

    await sansUnhandledRejection(async () => {
      const resolved = resolvePersistOption({ adapter: casse, debounce: 10 })!
      const engine   = createPersistEngine(resolved, (level, message) => { if (level === 'warn') warns.push(message) })!
      const partieFake: any = { id: 'pf2', serialize: () => ({ id: 'pf2' }), _onMutate: null }
      engine.armGame(partieFake)

      engine.forgetGame('pf2')
      await tick(30)
      assert.ok(warns.some(m => /persist\.remove.*échoué/.test(m)), `un warn doit signaler le remove() cassé, reçu : ${JSON.stringify(warns)}`)

      await engine.stop()
    })
  })

  // --- 3 : FilePersistAdapter directement — chemin dont le mkdir est structurellement impossible
  // (un composant du chemin est un FICHIER, pas un dossier) → ENOTDIR, quel que soit l'utilisateur
  // (contrairement à un test par permissions, robuste même en root) ---

  it("3. FilePersistAdapter — mkdir impossible (chemin sous un FICHIER existant) → save() warn au lieu de rejeter à sec, AUCUN crash, plusieurs saves consécutifs restent sans danger", async () => {
    const dir      = mjsTmp('persist-file-badpath')
    const bloqueur = join(dir, 'fichier-bloquant')
    writeFileSync(bloqueur, 'je bloque le mkdir')
    const cheminImpossible = join(bloqueur, 'saves')   // mkdir(cheminImpossible, {recursive:true}) → ENOTDIR (le parent est un FICHIER)

    const warns: string[] = []
    await sansUnhandledRejection(async () => {
      const adapter = new FilePersistAdapter({ dir: cheminImpossible, onLog: (level, message) => { if (level === 'warn') warns.push(message) } })

      adapter.save('p1', { id: 'p1' } as any)   // _ecrireAtomique : _pret DANS le try désormais (fix) → warn, jamais un rejet à sec
      await tick(30)
      adapter.save('p2', { id: 'p2' } as any)   // le mkdir n'est jamais réessayé (limite connue, cf. commentaire de tête) — DOIT quand même warn proprement, pas throw
      await tick(30)

      await adapter.flush()   // flush() ne doit lui non plus jamais rejeter

      assert.equal(warns.length, 2, `2 warns attendus (save p1 + save p2), reçu : ${JSON.stringify(warns)}`)
      assert.ok(warns.every(m => /persist-file : save/.test(m)), `les 2 warns doivent signaler un save() échoué, reçu : ${JSON.stringify(warns)}`)
    })
  })

  // --- 4 : bout-en-bout — vraie app MJS-Server + vrai client µ.socket (MemoryTransport) branchée dès
  // le BOOT sur un FilePersistAdapter dont le dossier est structurellement impossible à créer : le
  // serveur doit quand même écouter, accepter des joueurs, jouer des coups, et s'arrêter proprement ---

  function makeMu(): any {
    const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
    new Function('µ', clientSrc)(µ)
    return µ
  }
  function makeClient(transport: MemoryTransport): any {
    ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
    return makeMu()
  }
  function connecter(transport: MemoryTransport, id: string): any {
    const µ = makeClient(transport)
    return µ.socket('memory://' + id, { auth: () => ({ id }), reconnect: { enabled: false } })
  }
  function creerApp(opts: MjsServerOptions = {}): { transport: MemoryTransport; app: MjsServerApp } {
    const transport = new MemoryTransport()
    const app = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, ...opts })
    return { transport, app }
  }
  function declarerJeu(app: MjsServerApp): void {
    app.game('duel', {
      seats: 1,
      code: false,
      seatTtl: 500,
      emptyTtl: 500,
      state: () => ({ n: 0 }),
      moves: { inc: (game: any) => { game.state.n++; game.next() } },
      phases: { jeu: ['inc'] },
    })
  }

  it("4. bout-en-bout : app.listen() + parties jouées + app.stop() avec un FilePersistAdapter TOTALEMENT cassé dès le boot — le serveur fonctionne quand même, zéro crash", async function () {
    this.timeout(8000)
    const dir      = mjsTmp('persist-file-badpath-e2e')
    const bloqueur = join(dir, 'fichier-bloquant')
    writeFileSync(bloqueur, 'je bloque le mkdir')
    const cheminImpossible = join(bloqueur, 'saves')

    const warns: string[] = []
    const captureWarn = (level: string, message: string) => { if (level === 'warn') warns.push(message) }
    await sansUnhandledRejection(async () => {
      // onLog câblé DEUX FOIS : côté adaptateur (warns propres à persist-file, ex. « save(…) a
      // échoué ») ET côté façade (warns génériques de creerPersistEngine, ex. « persist.load() a
      // échoué ») — chacun a son propre défaut (console) tant qu'on ne le fournit pas explicitement.
      const adapter = new FilePersistAdapter({ dir: cheminImpossible, onLog: captureWarn })
      const { transport, app } = creerApp({
        persist: { adapter, debounce: 10 },
        onLog: captureWarn,
      })
      declarerJeu(app)

      await app.listen()   // chargerAuBoot() → load() rejeté (mkdir jamais créé) → warn, PAS de blocage/throw
      const sA = connecter(transport, 'a'); sA.connect(); await tick()
      const repA = await sA.request('µgame:play', { type: 'duel' })
      await sA.request('µgame:move', { game: repA.game, move: 'inc' })   // débounce → save() → mkdir raté → warn
      await tick(50)

      // le gameplay n'a JAMAIS été bloqué par la persistance cassée (save() est fire-and-forget)
      const resync = await sA.request('µgame:resync', { game: repA.game })
      assert.equal(resync.view.n, 1, "l'état de la partie est correct en mémoire malgré la persistance cassée")

      assert.ok(warns.some(m => /persist-file/.test(m)), `au moins un warn persist-file attendu, reçu : ${JSON.stringify(warns)}`)

      await app.stop()   // rafale finale + flush() — ne doit pas non plus lever/rejeter
      await tick(10)
    })
  })
})
