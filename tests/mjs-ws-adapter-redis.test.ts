// Tests UNITAIRES du mini-client Redis RESP (adapter-redis.ts) — SANS Redis vivant : encodage
// des commandes, parseur incrémental (RespParser, trames coupées en plein milieu, tableaux
// imbriqués des push SUBSCRIBE/message), parsing d'URL redis://, plan de reconnexion (pur,
// sans timer ni socket). cf. tests/mjs-ws-adapter.test.ts pour la boucle complète (MemoryAdapter,
// vrais clients µ.socket) et le smoke réel contre un VRAI Redis (rapporté à part, non committé).
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
import {
  encodeCommand, RespParser, RespError, parseRedisUrl, RECONNECT_BACKOFF_MS, backoffDelayMs, RedisAdapter,
} from '../src/mjs-ws/adapter-redis.js'

describe('mjs-ws/adapter-redis — encodage RESP des commandes', () => {
  it('une commande simple → *N bulk strings', () => {
    assert.equal(encodeCommand(['PING']), '*1\r\n$4\r\nPING\r\n')
  })

  it('plusieurs arguments → un bloc $len par argument', () => {
    assert.equal(encodeCommand(['SET', 'foo', 'bar']), '*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n')
  })

  it('arguments numériques → convertis en chaîne', () => {
    assert.equal(encodeCommand(['SELECT', 2]), '*2\r\n$6\r\nSELECT\r\n$1\r\n2\r\n')
  })

  it('longueur en OCTETS, pas en caractères (UTF-8 multi-octets)', () => {
    // 'é' = 2 octets en UTF-8 — une longueur en caractères (1) romprait le protocole
    assert.equal(encodeCommand(['SET', 'é', 'x']), '*3\r\n$3\r\nSET\r\n$2\r\né\r\n$1\r\nx\r\n')
  })

  it('tableau vide → *0', () => {
    assert.equal(encodeCommand([]), '*0\r\n')
  })
})

describe('mjs-ws/adapter-redis — RespParser (parseur incrémental)', () => {
  it('simple string (+)', () => {
    const p = new RespParser()
    assert.deepEqual(p.push(Buffer.from('+OK\r\n')), ['OK'])
  })

  it('erreur (-) → RespError, jamais confondue avec une valeur normale', () => {
    const p = new RespParser()
    const [v] = p.push(Buffer.from('-ERR mauvaise commande\r\n'))
    assert.ok(v instanceof RespError)
    assert.equal((v as RespError).message, 'ERR mauvaise commande')
  })

  it('entier (:)', () => {
    const p = new RespParser()
    assert.deepEqual(p.push(Buffer.from(':42\r\n')), [42])
  })

  it('bulk string ($) et bulk NULL ($-1)', () => {
    const p = new RespParser()
    assert.deepEqual(p.push(Buffer.from('$5\r\nhello\r\n')), ['hello'])
    assert.deepEqual(p.push(Buffer.from('$-1\r\n')), [null])
  })

  it('tableau (*) et tableau NULL (*-1)', () => {
    const p = new RespParser()
    assert.deepEqual(p.push(Buffer.from('*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n')), [['foo', 'bar']])
    assert.deepEqual(p.push(Buffer.from('*-1\r\n')), [null])
  })

  it('tableau imbriqué — push SUBSCRIBE/message', () => {
    const p = new RespParser()
    const frame = '*3\r\n$7\r\nmessage\r\n$4\r\nchan\r\n$14\r\n{"origin":"a"}\r\n'
    assert.deepEqual(p.push(Buffer.from(frame)), [['message', 'chan', '{"origin":"a"}']])
  })

  it('plusieurs valeurs COMPLÈTES dans un seul chunk → toutes extraites, dans l\'ordre', () => {
    const p = new RespParser()
    const chunk = '+OK\r\n:1\r\n$3\r\nfoo\r\n'
    assert.deepEqual(p.push(Buffer.from(chunk)), ['OK', 1, 'foo'])
  })

  it('trame COUPÉE en plein milieu de l\'en-tête ($5) → rien tant que la ligne n\'est pas complète', () => {
    const p = new RespParser()
    assert.deepEqual(p.push(Buffer.from('$5\r')), [])          // même le \r\n de l'en-tête manque
    assert.deepEqual(p.push(Buffer.from('\nhello\r\n')), ['hello'])
  })

  it('trame COUPÉE en plein milieu du CORPS bulk → rien tant que les octets manquent', () => {
    const p = new RespParser()
    assert.deepEqual(p.push(Buffer.from('$5\r\nhel')), [])     // 3 des 5 octets seulement
    assert.deepEqual(p.push(Buffer.from('lo\r\n')), ['hello'])
  })

  it('trame COUPÉE en plein milieu d\'un ÉLÉMENT d\'un tableau (push SUBSCRIBE en 2 morceaux)', () => {
    const p = new RespParser()
    assert.deepEqual(p.push(Buffer.from('*3\r\n$9\r\nsubscribe\r\n$4\r\nch')), [])   // tableau ET 2e élément incomplets
    assert.deepEqual(p.push(Buffer.from('an\r\n:1\r\n')), [['subscribe', 'chan', 1]])
  })

  it('reliquat conservé entre deux push() — jamais perdu ni dupliqué', () => {
    const p = new RespParser()
    assert.deepEqual(p.push(Buffer.from('+A\r\n+')), ['A'])
    assert.deepEqual(p.push(Buffer.from('B\r\n')), ['B'])
  })

  // longueur bulk/tableau non-numérique : AVANT le fix, `need`/`toString`/`subarray`
  // coercent tous NaN en 0 (vérifié empiriquement), `buf.length < need` valait TOUJOURS false
  // (NaN) → la valeur était renvoyée SANS jamais consommer le tampon → BOUCLE INFINIE dans
  // push() (event loop entièrement bloqué, tout le process gelé, pas juste l'adaptateur) dès
  // la première trame corrompue reçue du pair Redis (proxy non standard, RESP3 inattendu,
  // désync après une coupure). Chaque cas ci-dessous DOIT throw immédiatement (jamais un hang
  // — si le fix régresse, mocha timeout sur ces it() plutôt qu'un blocage silencieux du run).
  it('longueur bulk ($) non-numérique → throw immédiat, jamais un blocage', () => {
    const p = new RespParser()
    assert.throws(() => p.push(Buffer.from('$abc\r\nhello\r\n')), /longueur bulk RESP invalide/)
  })

  it('longueur de tableau (*) non-numérique → throw immédiat, jamais un blocage', () => {
    const p = new RespParser()
    assert.throws(() => p.push(Buffer.from('*abc\r\n')), /longueur de tableau RESP invalide/)
  })

  it('entier (:) non-numérique → throw immédiat (jamais un NaN silencieux)', () => {
    const p = new RespParser()
    assert.throws(() => p.push(Buffer.from(':abc\r\n')), /entier RESP invalide/)
  })

  it('longueur bulk négative autre que -1 (sentinelle null) → throw', () => {
    const p = new RespParser()
    assert.throws(() => p.push(Buffer.from('$-5\r\n')), /longueur bulk RESP invalide/)
  })

  it('entier (:) négatif légitime (ex. DECR) → toujours accepté, pas une régression du fix', () => {
    const p = new RespParser()
    assert.deepEqual(p.push(Buffer.from(':-3\r\n')), [-3])
  })
})

describe('mjs-ws/adapter-redis — parseRedisUrl', () => {
  it('hôte seul → port 6379 par défaut, ni mot de passe ni base', () => {
    assert.deepEqual(parseRedisUrl('redis://localhost'), { host: 'localhost', port: 6379, password: undefined, db: undefined })
  })

  it('hôte + port + mot de passe + base', () => {
    assert.deepEqual(parseRedisUrl('redis://:mysecret@localhost:6380/2'), { host: 'localhost', port: 6380, password: 'mysecret', db: 2 })
  })

  it('mot de passe avec caractères spéciaux → décodé (%40 → @)', () => {
    const parsed = parseRedisUrl('redis://:p%40ss@host:6379')
    assert.equal(parsed.password, 'p@ss')
  })

  it('rediss:// (TLS) accepté au parsing (le câblage TLS lui-même est hors périmètre)', () => {
    assert.equal(parseRedisUrl('rediss://host').host, 'host')
  })

  it('schéma invalide → erreur claire', () => {
    assert.throws(() => parseRedisUrl('http://host'), /schéma/)
  })

  it("base non entière (path invalide) → erreur claire", () => {
    assert.throws(() => parseRedisUrl('redis://host/abc'), /entier/)
  })

  it('URL complètement invalide → erreur claire, jamais une exception Node brute', () => {
    assert.throws(() => parseRedisUrl('::::'), /\[mjs-ws\/adapter-redis\]/)
  })
})

describe('mjs-ws/adapter-redis — plan de reconnexion (pur, sans timer ni socket)', () => {
  it('séquence exacte 1/2/5/10 s', () => {
    assert.deepEqual(RECONNECT_BACKOFF_MS, [1000, 2000, 5000, 10000])
  })

  it('backoffDelayMs(n) suit la séquence puis PALIER au dernier palier au-delà', () => {
    assert.equal(backoffDelayMs(0), 1000)
    assert.equal(backoffDelayMs(1), 2000)
    assert.equal(backoffDelayMs(2), 5000)
    assert.equal(backoffDelayMs(3), 10000)
    assert.equal(backoffDelayMs(4), 10000)   // au-delà de la table — jamais un débordement, jamais un délai infini
    assert.equal(backoffDelayMs(99), 10000)
  })
})

// un pair Redis (ou un proxy/désync) qui envoie une trame RESP corrompue ne doit JAMAIS
// figer ni faire planter tout le process MJS-WS (pas seulement l'adaptateur) : cf. les tests
// RespParser ci-dessus pour la preuve au niveau du parseur pur ; ici, la preuve de bout en bout
// (vrai socket TCP) que RedisConnection._onData rattrape l'exception et se reconnecte proprement.
describe('mjs-ws/adapter-redis — RedisConnection : flux RESP corrompu (robustesse)', function () {
  this.timeout(8000)

  it('longueur RESP invalide reçue du pair → connexion fermée pour reconnexion, JAMAIS un crash ni un blocage du process', async () => {
    const server: Server = createServer((socket: Socket) => {
      socket.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8')
        if (s.indexOf('PING') !== -1) { socket.write('+PONG\r\n'); return }
        if (s.indexOf('SUBSCRIBE') !== -1) {
          // confirmation SUBSCRIBE normale, puis un octet RESP corrompu juste derrière — simule
          // un désync protocole (proxy Redis non standard, RESP3 inattendu…) : AVANT le fix,
          // ceci gelait tout le process (boucle infinie dans RespParser.push, cf. plus haut)
          socket.write('*3\r\n$9\r\nsubscribe\r\n$4\r\ntest\r\n:1\r\n')
          socket.write('$abc\r\nxxxxx\r\n')
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as any).port

    const logs: Array<{ level: string; message: string }> = []
    const adapter = new RedisAdapter({
      url:   `redis://127.0.0.1:${port}`,
      onLog: (level, message) => { logs.push({ level, message }) },
    })

    await adapter.start()
    adapter.subscribe('test', () => {})

    // le seul fait que ce await résolve (au lieu du timeout mocha à 8 s) prouve déjà l'absence
    // de blocage — vérifié EN PLUS que la connexion s'est bien reconnectée PROPREMENT (error
    // loggé), pas juste « plus rien ne se passe silencieusement »
    await new Promise(resolve => setTimeout(resolve, 1000))

    const corruption = logs.find(l => l.message.indexOf('flux RESP corrompu') !== -1)
    assert.ok(corruption, `attendu un log de flux RESP corrompu — reçu : ${JSON.stringify(logs)}`)
    assert.equal(corruption!.level, 'error')

    await adapter.stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})

// RedisAdapter expose désormais ignoresOrigin/reconnexions en LOCAL (getters, cf.
// adapter-redis.ts) : MÊMES familles que MjsWsStatsAdaptateur (stats.ts), pas encore branchées
// sur le registre app-wide (ça touche core.ts/index.ts, hors du périmètre ici) — testé
// ici en isolation, sans vrai Redis, même patron « faux serveur node:net » que la description
// précédente.
describe('mjs-ws/adapter-redis — RedisAdapter : compteurs LOCAUX ignoresOrigin / reconnexions', function () {
  this.timeout(8000)

  it("message reçu avec origin === processId (écho pub/sub) → ignoré, PAS livré au handler, ignoresOrigin incrémenté (un message d'origine étrangère traverse normalement)", async () => {
    let subSocket: Socket | null = null
    const server: Server = createServer((socket: Socket) => {
      socket.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8')
        if (s.indexOf('PING') !== -1) socket.write('+PONG\r\n')
        if (s.indexOf('SUBSCRIBE') !== -1) { subSocket = socket; socket.write(encodeCommand(['subscribe', 'test', 1])) }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as any).port

    const adapter = new RedisAdapter({ url: `redis://127.0.0.1:${port}`, onLog: () => {} })
    await adapter.start()
    const received: unknown[] = []
    adapter.subscribe('test', (msg) => received.push(msg))
    await new Promise(resolve => setTimeout(resolve, 200))   // laisse la confirmation SUBSCRIBE arriver
    assert.ok(subSocket, 'la connexion abonné doit avoir envoyé SUBSCRIBE')
    assert.equal(adapter.ignoresOrigin, 0, 'zéro avant tout push reçu')

    // 1er push : origin = SOI-MÊME (écho pub/sub, cf. RedisAdapter.publish) → doit être ignoré
    subSocket!.write(encodeCommand(['message', 'test', JSON.stringify({ origin: adapter.processId, payload: 'echo' })]))
    // 2e push : origin ÉTRANGER → doit être livré normalement, PAS compté
    subSocket!.write(encodeCommand(['message', 'test', JSON.stringify({ origin: 'autre-process', payload: 'ok' })]))
    await new Promise(resolve => setTimeout(resolve, 200))

    assert.deepEqual(received, ['ok'], "seul le message d'origine ÉTRANGÈRE doit atteindre le handler")
    assert.equal(adapter.ignoresOrigin, 1, "le message d'écho (origin = soi-même) doit avoir été compté UNE fois")

    await adapter.stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it("reconnexion RÉUSSIE du mini-client RESP après coupure → reconnexions incrémenté (JAMAIS à la connexion initiale)", async () => {
    let cmdSocket: Socket | null = null
    const server: Server = createServer((socket: Socket) => {
      socket.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').indexOf('PING') !== -1) { cmdSocket = socket; socket.write('+PONG\r\n') }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as any).port

    const adapter = new RedisAdapter({ url: `redis://127.0.0.1:${port}`, onLog: () => {} })
    await adapter.start()
    assert.ok(cmdSocket, 'la connexion "command" doit avoir envoyé PING (start() l\'attend)')
    assert.equal(adapter.reconnexions, 0, 'zéro reconnexion juste après la connexion initiale')

    cmdSocket!.destroy()   // coupure CÔTÉ SERVEUR de la connexion 'command' — force une reconnexion à backoff
    await new Promise(resolve => setTimeout(resolve, 1500))   // > backoffDelayMs(0) = 1000ms (RECONNECT_BACKOFF_MS[0]), marge large

    assert.equal(adapter.reconnexions, 1, 'la reconnexion réussie doit avoir été comptée UNE fois')

    await adapter.stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})
