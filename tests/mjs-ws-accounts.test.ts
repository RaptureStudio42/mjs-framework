// Tests du paquet COMPTES & IDENTITÉS (src/mjs-ws/accounts.ts) —
// MÊME technique que tests/mjs-ws-chat.test.ts/tests/mjs-ws-token-expiry.test.ts (vrai client
// µ.socket, MemoryTransport, app.use(accountsPackage(...))) : le client ici reste le socket BRUT
// (s.on/s.send/s.request/s.refresh) — PAS mjs_accounts.ts (couvert par tests/socket-accounts.test.ts).
//
// Couvre : création (succès, pseudo pris/invalide, secret court), connexion (succès, refus
// IDENTIQUE pseudo inexistant vs mauvais secret, casse-insensible), élévation par sock.refresh
// (identité visible ensuite, y compris dans un AUTRE paquet — chatPackage), reconnexion à froid
// avec le token directement au hello, expiration, déconnexion (ferme la connexion authentifiée,
// no-op si anonyme), anti-force-brute (bout-en-bout + FailureBucket unitaire, isolation/déblocage),
// persistance duck-typée (mémoire + fichier réel), rôles (opts.roles + hasRole), secret manquant
// à la construction, avertissement adaptateur mémoire au boot, hash/sel jamais sur le fil.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mjsWs, accountsPackage, accountsAuth, hasRole, MemoryAccountsPersistAdapter, FileAccountsPersistAdapter, FailureBucket, chatPackage,
} from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { signToken } from '../src/mjs-ws/token.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsWsAccountsOptions, MjsWsAccountRecord } from '../src/mjs-ws/accounts.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

const SECRET = 'secret-test-comptes'

async function startApp(
  comptesOpts: Partial<MjsWsAccountsOptions> = {}, wsOpts: MjsWsOptions = {}, avecChat = false,
): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, auth: accountsAuth(SECRET), onLog: () => {}, ...wsOpts })
  app.use(accountsPackage({ secret: SECRET, ...comptesOpts } as MjsWsAccountsOptions))
  if (avecChat) app.use(chatPackage())
  await app.listen()
  return { transport, app }
}

// connexion ANONYME — MÊME esprit que « on se connecte anonyme, puis on élève » (cf. accounts.ts
// tête de fichier) : hello.auth === undefined → accountsAuth laisse passer (identité anonyme).
function connectAnonyme(transport: MemoryTransport, url: string): any {
  const s = makeClient(transport).socket(url, { auth: () => undefined, reconnect: { enabled: false } })
  s.connect()
  return s
}

// connexion FRAÎCHE directement avec un token compte au hello (pas de create/login/refresh ici)
function connectAvecJeton(transport: MemoryTransport, url: string, token: string): any {
  const s = makeClient(transport).socket(url, { auth: () => token, reconnect: { enabled: false } })
  s.connect()
  return s
}

const SECRET_LONG = 'motdepasse123'

describe('MJS-WS — paquet COMPTES & IDENTITÉS (accounts.ts)', () => {

  describe('création — account:create', () => {
    it('1. succès — { ok, token } bien formé, payload décodable { id, pseudo, roles, iat, exp }', async () => {
      const { transport, app } = await startApp()
      const s = connectAnonyme(transport, 'memory://c1')
      await tick()
      const res = await s.request('account:create', { name: 'zora', secret: SECRET_LONG })
      assert.equal(res.ok, true)
      assert.equal(typeof res.token, 'string')
      const parts = res.token.split('.')
      assert.equal(parts.length, 3, 'token = header.payload.signature (JWT HS256, token.ts)')
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
      assert.equal(typeof payload.id, 'string')
      assert.ok(payload.id.length > 0)
      assert.equal(payload.name, 'zora')
      assert.deepEqual(payload.roles, [])
      assert.equal(typeof payload.iat, 'number')
      assert.equal(typeof payload.exp, 'number')
      assert.ok(payload.exp > payload.iat, 'expiration future (défaut 7 jours)')
      s.destroy(); await app.stop()
    })

    it('2. pseudo déjà pris (casse-insensible) → account-name-taken', async () => {
      const { transport, app } = await startApp()
      const s = connectAnonyme(transport, 'memory://c2')
      await tick()
      await s.request('account:create', { name: 'Zora', secret: SECRET_LONG })
      await assert.rejects(s.request('account:create', { name: 'zora', secret: 'autresecret1' }), (e: any) => e === 'account-name-taken')
      await assert.rejects(s.request('account:create', { name: 'ZORA', secret: 'autresecret1' }), (e: any) => e === 'account-name-taken')
      s.destroy(); await app.stop()
    })

    it('3. pseudo invalide (trop court/long, caractères interdits, espace, non-chaîne) → account-name-invalid', async () => {
      const { transport, app } = await startApp()
      const s = connectAnonyme(transport, 'memory://c3')
      await tick()
      await assert.rejects(s.request('account:create', { name: 'ab', secret: SECRET_LONG }), (e: any) => e === 'account-name-invalid')
      await assert.rejects(s.request('account:create', { name: 'a'.repeat(25), secret: SECRET_LONG }), (e: any) => e === 'account-name-invalid')
      await assert.rejects(s.request('account:create', { name: 'zora!', secret: SECRET_LONG }), (e: any) => e === 'account-name-invalid')
      await assert.rejects(s.request('account:create', { name: 'zora le fou', secret: SECRET_LONG }), (e: any) => e === 'account-name-invalid')
      await assert.rejects(s.request('account:create', { name: 42, secret: SECRET_LONG }), (e: any) => e === 'account-name-invalid')
      await assert.rejects(s.request('account:create', {}), (e: any) => e === 'account-name-invalid')
      // exactement 3 et 24 caractères — bornes INCLUSES
      const r3  = await s.request('account:create', { name: 'abc', secret: SECRET_LONG })
      assert.equal(r3.ok, true)
      const r24 = await s.request('account:create', { name: 'b'.repeat(24), secret: SECRET_LONG })
      assert.equal(r24.ok, true)
      s.destroy(); await app.stop()
    })

    it('4. secret trop court (< 8, non-chaîne, absent) → account-secret-short', async () => {
      const { transport, app } = await startApp()
      const s = connectAnonyme(transport, 'memory://c4')
      await tick()
      await assert.rejects(s.request('account:create', { name: 'theo1', secret: 'court1' }), (e: any) => e === 'account-secret-short')
      await assert.rejects(s.request('account:create', { name: 'theo2', secret: 42 }), (e: any) => e === 'account-secret-short')
      await assert.rejects(s.request('account:create', { name: 'theo3' }), (e: any) => e === 'account-secret-short')
      // exactement 8 caractères — borne INCLUSE
      const r = await s.request('account:create', { name: 'theo4', secret: '12345678' })
      assert.equal(r.ok, true)
      s.destroy(); await app.stop()
    })
  })

  describe('connexion — account:login', () => {
    it('5. succès avec pseudo/secret corrects', async () => {
      const { transport, app } = await startApp()
      const s = connectAnonyme(transport, 'memory://c5')
      await tick()
      await s.request('account:create', { name: 'zora', secret: SECRET_LONG })
      const res = await s.request('account:login', { name: 'zora', secret: SECRET_LONG })
      assert.equal(res.ok, true)
      assert.equal(typeof res.token, 'string')
      s.destroy(); await app.stop()
    })

    it('6. refus IDENTIQUE — pseudo inexistant vs mauvais secret (anti-énumération sur le message)', async () => {
      const { transport, app } = await startApp()
      const s = connectAnonyme(transport, 'memory://c6')
      await tick()
      await s.request('account:create', { name: 'zora', secret: SECRET_LONG })
      let e1: any, e2: any
      try { await s.request('account:login', { name: 'zora', secret: 'mauvaissecret' }) } catch (e) { e1 = e }
      try { await s.request('account:login', { name: 'inconnu999', secret: 'nimportequoi1' }) } catch (e) { e2 = e }
      assert.equal(e1, 'account-denied')
      assert.equal(e2, 'account-denied')
      assert.equal(e1, e2, 'MÊME message quel que soit le cas — aucune énumération de comptes possible')
      s.destroy(); await app.stop()
    })

    it('7. connexion casse-insensible (créé "Zora", connexion "zora"/"ZORA")', async () => {
      const { transport, app } = await startApp()
      const s = connectAnonyme(transport, 'memory://c7')
      await tick()
      await s.request('account:create', { name: 'Zora', secret: SECRET_LONG })
      const r1 = await s.request('account:login', { name: 'zora', secret: SECRET_LONG })
      assert.equal(r1.ok, true)
      const r2 = await s.request('account:login', { name: 'ZORA', secret: SECRET_LONG })
      assert.equal(r2.ok, true)
      s.destroy(); await app.stop()
    })
  })

  // reconnexion CONTRÔLÉE avec un token — MÊME technique que src/runtime/mjs_accounts.ts::_accountElevate
  // (sock.refresh() est structurellement INCAPABLE de ce changement d'identité,
  // cf. test 8 ci-dessous et la tête de fichier de accounts.ts « Élévation »).
  function eleverParReconnexion(s: any, token: string): Promise<void> {
    return new Promise((resolve) => {
      s.opts.auth = () => token
      s.on('welcome', function onWelcome() { s.off('welcome', onWelcome); resolve() })
      s.close(); s.connect()
    })
  }

  describe('élévation invité→compte — PAR RECONNEXION, pas par sock.refresh', () => {
    it("8. sock.refresh(token) est REFUSÉ (changement d'identityIdOf) — l'élévation passe par une reconnexion contrôlée", async () => {
      const { transport, app } = await startApp()
      const s = connectAnonyme(transport, 'memory://c8')
      await tick()
      assert.equal((Array.from(app.clients)[0] as any).identity, undefined, 'anonyme au départ')
      const { token } = await s.request('account:create', { name: 'zora', secret: SECRET_LONG })

      // µ:refresh NE PEUT PAS élever : « une session ne change jamais d'identité en vol » (core.ts,
      // invariant hors du périmètre ici) — anonyme (aucun id) → compte (id généré) EST un tel
      // changement. Documenté ici pour ne jamais régresser vers l'hypothèse initiale (fausse).
      await assert.rejects(s.refresh(token), (e: any) => e === 'refresh-denied')

      // l'élévation RÉELLE — reconnexion contrôlée (cf. eleverParReconnexion ci-dessus)
      await eleverParReconnexion(s, token)
      const identity = (Array.from(app.clients)[0] as any).identity
      assert.equal(identity.name, 'zora')
      assert.deepEqual(identity.roles, [])
      assert.equal(typeof identity.id, 'string')
      s.destroy(); await app.stop()
    })

    it('9. intégration — après élévation par reconnexion, le pseudo du compte est visible dans un AUTRE paquet (chatPackage)', async () => {
      const { transport, app } = await startApp({}, {}, true)
      const s = connectAnonyme(transport, 'memory://c9')
      await tick()
      const { token } = await s.request('account:create', { name: 'zora', secret: SECRET_LONG })
      await eleverParReconnexion(s, token)
      const moi = await s.request('chat:me', {})
      assert.equal(moi.name, 'zora', 'chat.ts résout le pseudo depuis identity.name — posé par le token compte')
      s.room('chat:general')
      await tick()
      const recu: any[] = []
      s.on('chat:message', (p: any) => recu.push(p))
      s.send('chat:send', { room: 'general', text: 'salut' })
      await tick()
      assert.equal(recu[0].from.name, 'zora')
      s.destroy(); await app.stop()
    })

    it('10. reconnexion à froid — un token compte utilisé DIRECTEMENT au hello (fresh connexion) élève dès le welcome', async () => {
      const { transport, app } = await startApp()
      const s1 = connectAnonyme(transport, 'memory://c10a')
      await tick()
      const { token } = await s1.request('account:create', { name: 'zora', secret: SECRET_LONG })
      s1.destroy()
      await tick()

      const s2 = connectAvecJeton(transport, 'memory://c10b', token)
      await tick()
      assert.equal(s2.state, 'open')
      const identity = (Array.from(app.clients)[0] as any).identity
      assert.equal(identity.name, 'zora', 'MÊME token, vérifié par le MÊME chemin que µ:refresh (accountsAuth → jwtAuth)')
      s2.destroy(); await app.stop()
    })

    it("11. expiration — un token compte expiré est refusé DÈS LE HELLO (µ:denied), jamais une élévation silencieuse", async () => {
      const { transport, app } = await startApp()
      const dejaExpire = signToken({ id: 'x1', name: 'zora', roles: [] as string[], exp: (Date.now() - 1000) / 1000 }, SECRET)
      const s = connectAvecJeton(transport, 'memory://c11', dejaExpire)
      await tick()
      assert.notEqual(s.state, 'open', 'token expiré → hello refusé (µ:denied), la connexion ne doit jamais rester ouverte')
      s.destroy(); await app.stop()
    })
  })

  describe('déconnexion — account:logout', () => {
    it("12. ferme la connexion authentifiée courante, APRÈS l'accusé de réception", async () => {
      const { transport, app } = await startApp()
      const s0 = connectAnonyme(transport, 'memory://c12a')
      await tick()
      const { token } = await s0.request('account:create', { name: 'zora', secret: SECRET_LONG })
      s0.destroy(); await tick()

      const s = connectAvecJeton(transport, 'memory://c12b', token)
      await tick()
      assert.equal(s.state, 'open')
      const res = await s.request('account:logout', {})
      assert.equal(res.ok, true, "l'accusé arrive — la fermeture est différée APRÈS lui")
      await tick()
      assert.notEqual(s.state, 'open', 'la connexion doit avoir été fermée par le serveur (identité révoquée)')
      s.destroy(); await app.stop()
    })

    it('13. no-op si déjà anonyme — aucune fermeture, { ok: true } quand même', async () => {
      const { transport, app } = await startApp()
      const s = connectAnonyme(transport, 'memory://c13')
      await tick()
      const res = await s.request('account:logout', {})
      assert.equal(res.ok, true)
      await tick()
      assert.equal(s.state, 'open', 'une connexion anonyme ne doit JAMAIS être fermée par deconnecter')
      s.destroy(); await app.stop()
    })
  })

  describe('anti-force-brute — seau d\'échecs par IP ET par pseudo (account:login uniquement)', () => {
    it('14. 5 échecs → account-denied, le 6e devient account-throttled (preuve LOGIQUE, pas chronométrique)', async () => {
      const { transport, app } = await startApp()
      const s = connectAnonyme(transport, 'memory://c14')
      await tick()
      const erreurs: any[] = []
      // 5 pseudos DIFFÉRENTS et INEXISTANTS — isole la dimension IP (chaque pseudo n'a, à lui seul,
      // qu'UN SEUL échec dans son propre seau, loin de son plafond ; seul le seau-IP, PARTAGÉ par
      // MemoryTransport en test — cf. tests/mjs-ws-accounts.test.ts note — accumule les 5).
      for (let i = 0; i < 5; i++) {
        try { await s.request('account:login', { name: 'inexistant' + i, secret: 'nimportequoi1' }) }
        catch (e) { erreurs.push(e) }
      }
      assert.deepEqual(erreurs, Array(5).fill('account-denied'), 'les 5 premiers échecs sont bien account-denied (hachage factice exécuté à chaque fois)')
      let sixieme: any
      try { await s.request('account:login', { name: 'encoreunautre', secret: 'nimportequoi1' }) }
      catch (e) { sixieme = e }
      // PREUVE LOGIQUE (pas un chronomètre) : 'account-throttled' ne peut être
      // atteint QUE par le branchement anti-force-brute — si le code laissait, par régression, le
      // seau se faire déborder SANS jamais reclasser la réponse, ce 6e essai retomberait sur
      // 'account-denied' comme les 5 premiers (les deux issues sont mutuellement exclusives dans
      // accountsPackage — cf. src/mjs-ws/accounts.ts, account:login).
      assert.equal(sixieme, 'account-throttled')
      s.destroy(); await app.stop()
    })
  })

  describe('FailureBucket (exportée) — isolation et fenêtre de blocage, testées DIRECTEMENT (MemoryTransport ne fournit jamais deux adresses IP distinctes en test)', () => {
    it('15. deux clés indépendantes — épuiser A ne bloque jamais B', () => {
      const seau = new FailureBucket(3, 60000)
      const now = 1000
      seau.recordFailure('a', now); seau.recordFailure('a', now); seau.recordFailure('a', now)
      assert.equal(seau.isBlocked('a', now), false, "3 échecs pour une capacité de 3 — le seau est à sec mais pas ENCORE verrouillé (cf. recordFailure)")
      seau.recordFailure('a', now)   // 4e échec — fait déborder le seau CETTE fois
      assert.equal(seau.isBlocked('a', now), true, '4e échec — verrouillé')
      assert.equal(seau.isBlocked('b', now), false, 'B intact — clé totalement indépendante de A')
    })

    it("16. recordFailure retourne false PRÉCISÉMENT quand IL vient de faire déborder le seau (reclassement)", () => {
      const seau = new FailureBucket(2, 60000)
      const now = 1000
      assert.equal(seau.recordFailure('a', now), true, '1er échec — dans le budget (2 restants → 1)')
      assert.equal(seau.recordFailure('a', now), true, '2e échec — dans le budget (1 restant → 0)')
      assert.equal(seau.recordFailure('a', now), false, '3e échec — CELUI-CI fait déborder, retourne false')
      assert.equal(seau.recordFailure('a', now), false, '4e échec — toujours bloqué (fenêtre active)')
    })

    it('17. déblocage après la fenêtre (now INJECTÉ, jamais un vrai chronomètre)', () => {
      const seau = new FailureBucket(2, 1000)
      const now = 5000
      seau.recordFailure('a', now); seau.recordFailure('a', now); seau.recordFailure('a', now)
      assert.equal(seau.isBlocked('a', now), true)
      assert.equal(seau.isBlocked('a', now + 999), true, 'encore dans la fenêtre (999 ms < 1000 ms)')
      assert.equal(seau.isBlocked('a', now + 1001), false, 'fenêtre expirée — débloqué')
    })
  })

  describe('persistance — contrat duck-typé (adaptateur mémoire + adaptateur fichier RÉEL)', () => {
    it('18. MemoryAccountsPersistAdapter — un compte créé survit à un "redémarrage" (même instance d\'adaptateur, nouveau paquet)', async () => {
      const adapter = new MemoryAccountsPersistAdapter()
      const { transport, app } = await startApp({ persist: adapter })
      const s = connectAnonyme(transport, 'memory://c18a')
      await tick()
      await s.request('account:create', { name: 'zora', secret: SECRET_LONG })
      s.destroy(); await app.stop()

      // « redémarrage » — un DEUXIÈME serveur, MÊME instance d'adaptateur (la mémoire d'un process
      // encore vivant survit, contrairement à un vrai restart — cf. test 19 pour le cas RÉEL disque)
      const transport2 = new MemoryTransport()
      const app2 = mjsWs({ transport: transport2, heartbeat: 0, auth: accountsAuth(SECRET), onLog: () => {} })
      app2.use(accountsPackage({ secret: SECRET, persist: adapter }))
      await app2.listen()
      const s2 = makeClient(transport2).socket('memory://c18b', { auth: () => undefined, reconnect: { enabled: false } })
      s2.connect(); await tick()
      const res = await s2.request('account:login', { name: 'zora', secret: SECRET_LONG })
      assert.equal(res.ok, true, 'le compte créé AVANT le redémarrage reste connectable')
      s2.destroy(); await app2.stop()
    })

    it("19. FileAccountsPersistAdapter réel — écrit sur disque, relu par une INSTANCE FRAÎCHE (vrai redémarrage)", async () => {
      const dir = mjsTmp('comptes-file')
      const { transport, app } = await startApp({ persist: new FileAccountsPersistAdapter({ dir, onLog: () => {} }) })
      const s = connectAnonyme(transport, 'memory://c19a')
      await tick()
      await s.request('account:create', { name: 'zora', secret: SECRET_LONG })
      await tick()   // laisse l'écriture atomique (tmp+rename) se terminer avant le "redémarrage"
      s.destroy(); await app.stop()

      // instance FRAÎCHE de l'adaptateur, MÊME dossier — prouve que c'est le DISQUE (pas la mémoire
      // du process précédent) qui porte la persistance, cf. mjs-server/persist-file.ts (technique
      // d'écriture atomique reprise à l'identique, cf. accounts.ts::FileAccountsPersistAdapter).
      const transport2 = new MemoryTransport()
      const app2 = mjsWs({ transport: transport2, heartbeat: 0, auth: accountsAuth(SECRET), onLog: () => {} })
      app2.use(accountsPackage({ secret: SECRET, persist: new FileAccountsPersistAdapter({ dir, onLog: () => {} }) }))
      await app2.listen()
      const s2 = makeClient(transport2).socket('memory://c19b', { auth: () => undefined, reconnect: { enabled: false } })
      s2.connect(); await tick()
      const res = await s2.request('account:login', { name: 'zora', secret: SECRET_LONG })
      assert.equal(res.ok, true, 'le compte survit à un VRAI redémarrage (relu depuis le fichier JSON)')
      s2.destroy(); await app2.stop()
    })
  })

  describe('rôles — opts.roles(compte) + hasRole(identity, role)', () => {
    it('20. opts.roles enrichit/recalcule les rôles portés par le token, à chaque émission', async () => {
      const { transport, app } = await startApp({
        roles: (compte: MjsWsAccountRecord) => compte.name === 'admin' ? ['admin', 'moderateur'] : ['membre'],
      })
      const s = connectAnonyme(transport, 'memory://c20')
      await tick()
      const resAdmin = await s.request('account:create', { name: 'admin', secret: SECRET_LONG })
      const payloadAdmin = JSON.parse(Buffer.from(resAdmin.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
      assert.deepEqual(payloadAdmin.roles, ['admin', 'moderateur'])

      const resAutre = await s.request('account:create', { name: 'quidam', secret: SECRET_LONG })
      const payloadAutre = JSON.parse(Buffer.from(resAutre.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
      assert.deepEqual(payloadAutre.roles, ['membre'])
      s.destroy(); await app.stop()
    })

    it('21. hasRole(identity, role) — vrai/faux selon le tableau roles, jamais un throw sur une forme inattendue', () => {
      assert.equal(hasRole({ roles: ['admin', 'membre'] }, 'admin'), true)
      assert.equal(hasRole({ roles: ['membre'] }, 'admin'), false)
      assert.equal(hasRole(undefined, 'admin'), false)
      assert.equal(hasRole(null, 'admin'), false)
      assert.equal(hasRole({}, 'admin'), false)
      assert.equal(hasRole('chaine', 'admin'), false)
      assert.equal(hasRole({ roles: 'pas-un-tableau' }, 'admin'), false)
    })
  })

  describe('construction — opts.secret requise', () => {
    it("22. accountsPackage sans secret (ou secret vide) → throw IMMÉDIAT, jamais un démarrage à moitié fait", () => {
      assert.throws(() => accountsPackage({} as any), /opts\.secret manquant/)
      assert.throws(() => accountsPackage({ secret: '' } as any), /opts\.secret manquant/)
    })
  })

  describe('adaptateur mémoire (défaut) — avertissement au boot', () => {
    it("23. aucun opts.persist fourni → onLog('warn', ...) appelé, mentionne mémoire ET redémarrage", () => {
      const warns: string[] = []
      accountsPackage({ secret: SECRET, onLog: (level, message) => { if (level === 'warn') warns.push(message) } })
      assert.equal(warns.length, 1)
      assert.match(warns[0], /mémoire/)
      assert.match(warns[0], /redémarrage/)
    })

    it('24. opts.persist fourni → AUCUN avertissement', () => {
      const warns: string[] = []
      accountsPackage({ secret: SECRET, persist: new MemoryAccountsPersistAdapter(), onLog: (level, message) => { if (level === 'warn') warns.push(message) } })
      assert.deepEqual(warns, [])
    })
  })

  describe('sécurité du fil — hash/sel ne quittent JAMAIS le serveur', () => {
    // espion de trames BRUTES — MÊME technique que tests/mjs-ws-token-expiry.test.ts::wireWebSocket
    function wireRawFrames(transport: MemoryTransport, url: string, bucket: string[]): void {
      ;(globalThis as any).WebSocket = function(u: string, protocols?: any) {
        const ws: any = transport.connect({ url: u, protocols })
        if (u === url) {
          let real: any = null
          Object.defineProperty(ws, 'onmessage', {
            get() { return real },
            set(fn: any) { real = fn && ((ev: any) => { bucket.push(String(ev.data)); fn(ev) }) },
          })
        }
        return ws
      }
    }

    it("25. account:create + account:login — aucun champ 'hash'/'sel' dans AUCUNE trame reçue", async () => {
      const { transport, app } = await startApp()
      const recu: string[] = []
      wireRawFrames(transport, 'memory://c25', recu)
      const s = makeMu().socket('memory://c25', { auth: () => undefined, reconnect: { enabled: false } })
      s.connect(); await tick()
      await s.request('account:create', { name: 'zora', secret: SECRET_LONG })
      await s.request('account:login', { name: 'zora', secret: SECRET_LONG })
      const tout = recu.join('\n')
      assert.ok(recu.length > 0, 'des trames ont bien été capturées')
      assert.ok(!/"hash"/i.test(tout), "aucun champ 'hash' dans aucune trame")
      assert.ok(!/"sel"/i.test(tout), "aucun champ 'sel' dans aucune trame")
      s.destroy(); await app.stop()
    })
  })

  describe('robustesse — payload malformé, jamais un crash serveur', () => {
    it('26. account:create avec payload vide/champs non-conformes → erreurs propres, le serveur survit', async () => {
      const { transport, app } = await startApp()
      const s = connectAnonyme(transport, 'memory://c26')
      await tick()
      await assert.rejects(s.request('account:create', {}))
      await assert.rejects(s.request('account:create', { name: null, secret: null }))
      await assert.rejects(s.request('account:create', { name: ['zora'], secret: SECRET_LONG }))
      // le serveur survit — une création VALIDE juste après passe normalement
      const res = await s.request('account:create', { name: 'zora', secret: SECRET_LONG })
      assert.equal(res.ok, true)
      s.destroy(); await app.stop()
    })

    it('27. account:login avec payload malformé → refus propre (jamais un crash serveur)', async () => {
      const { transport, app } = await startApp()
      const s = connectAnonyme(transport, 'memory://c27')
      await tick()
      let err: any
      try { await s.request('account:login', {}) } catch (e) { err = e }
      assert.ok(err === 'account-denied' || err === 'account-throttled', `attendu account-denied/account-throttled, reçu : ${err}`)
      // le serveur survit — une connexion VALIDE juste après (compte créé au préalable) passe normalement
      await s.request('account:create', { name: 'zora', secret: SECRET_LONG })
      const ok = await s.request('account:login', { name: 'zora', secret: SECRET_LONG })
      assert.equal(ok.ok, true)
      s.destroy(); await app.stop()
    })
  })

  // anti-DoS création : account:create
  // était accessible en hello ANONYME sans AUCUNE limite de débit, alors qu'il déclenche le MÊME
  // scrypt coûteux que account:login (DoS CPU + croissance mémoire/disque non bornée depuis une
  // seule IP). MÊME seau que account:login (FailureBucket, guard.ts::TokenBucket) mais INSTANCE
  // SÉPARÉE (opts.creationParIp, jamais partagée avec opts.forceBrute) — cf. src/mjs-ws/accounts.ts.
  describe('anti-DoS création — seau PAR IP sur account:create (opts.createPerIp)', () => {
    it('28. N créations rapides depuis la même IP → la (N+1)e est refusée avec account-throttled (MÊME code que bruteForce)', async () => {
      const { transport, app } = await startApp({ createPerIp: { capacity: 3, windowMs: 60000 } })
      const s = connectAnonyme(transport, 'memory://c28')
      await tick()
      // 3 créations valides — dans le budget (capacity 3)
      for (let i = 0; i < 3; i++) {
        const res = await s.request('account:create', { name: 'dos28-' + i, secret: SECRET_LONG })
        assert.equal(res.ok, true, `création ${i} — dans le budget`)
      }
      // la 4e (N+1e) — payload VALIDE (pseudo neuf, secret assez long) mais seau épuisé juste avant
      // le hachage scrypt → account-throttled (pas account-name-invalid ni account-name-taken)
      let err: any
      try { await s.request('account:create', { name: 'dos28-3', secret: SECRET_LONG }) } catch (e) { err = e }
      assert.equal(err, 'account-throttled', 'MÊME shape/code que le refus anti-force-brute de account:login')
      s.destroy(); await app.stop()
    })

    it("28bis. les refus bon marché (pseudo invalide/secret court/pseudo pris — AUCUN hachage) ne consomment PAS le seau — seule une tentative qui atteindrait le scrypt compte", async () => {
      const { transport, app } = await startApp({ createPerIp: { capacity: 2, windowMs: 60000 } })
      const s = connectAnonyme(transport, 'memory://c28bis')
      await tick()
      // 5 refus bon marché — largement AU-DELÀ de la capacité (2) — ne doivent JAMAIS déclencher account-throttled
      await assert.rejects(s.request('account:create', { name: 'ab', secret: SECRET_LONG }), (e: any) => e === 'account-name-invalid')
      await assert.rejects(s.request('account:create', { name: 'valide1', secret: 'court' }), (e: any) => e === 'account-secret-short')
      await assert.rejects(s.request('account:create', { name: 'valide2' }), (e: any) => e === 'account-secret-short')
      await s.request('account:create', { name: 'dejapris', secret: SECRET_LONG })
      await assert.rejects(s.request('account:create', { name: 'dejapris', secret: SECRET_LONG }), (e: any) => e === 'account-name-taken')
      // le budget (2) n'a été consommé QU'UNE fois (la création réussie ci-dessus) — encore 1 dispo
      const res = await s.request('account:create', { name: 'valide3', secret: SECRET_LONG })
      assert.equal(res.ok, true, 'le budget est INTACT malgré les refus bon marché précédents')
      s.destroy(); await app.stop()
    })

    it('29. créations sous le seuil → toutes OK, aucun refus prématuré', async () => {
      const { transport, app } = await startApp({ createPerIp: { capacity: 5, windowMs: 60000 } })
      const s = connectAnonyme(transport, 'memory://c29')
      await tick()
      for (let i = 0; i < 4; i++) {
        const res = await s.request('account:create', { name: 'sous-seuil' + i, secret: SECRET_LONG })
        assert.equal(res.ok, true, `création ${i}/4, sous la capacité (5) — jamais account-throttled`)
      }
      s.destroy(); await app.stop()
    })

    it("30. IP différente → compteur indépendant (isolation prouvée sur FailureBucket, MÊME classe/instanciation que createFailuresByIp — MemoryTransport ne fournit jamais deux adresses IP distinctes en test, cf. tests 15-17)", () => {
      const seau = new FailureBucket(3, 60000)
      const now = 1000
      seau.recordFailure('1.2.3.4', now); seau.recordFailure('1.2.3.4', now); seau.recordFailure('1.2.3.4', now)
      // 3 créations pour l'IP A — seau à sec mais pas ENCORE verrouillé (MÊME sémantique que test 15)
      assert.equal(seau.recordFailure('1.2.3.4', now), false, "4e tentative pour l'IP A — seau épuisé, refusée")
      // l'IP B — totalement indépendante, encore dans son budget plein
      assert.equal(seau.recordFailure('5.6.7.8', now), true, "IP B intacte — compteur INDÉPENDANT de l'IP A")
      assert.equal(seau.recordFailure('5.6.7.8', now), true)
      assert.equal(seau.recordFailure('5.6.7.8', now), true)
      assert.equal(seau.recordFailure('5.6.7.8', now), false, "IP B atteint SON PROPRE plafond (3), indépendamment de l'IP A")
    })

    it('31. non-régression — account:login et son seau (bruteForce) restent intacts, indépendants du seau de création', async () => {
      const { transport, app } = await startApp({ createPerIp: { capacity: 2, windowMs: 60000 }, bruteForce: { capacity: 5, windowMs: 60000 } })
      const s = connectAnonyme(transport, 'memory://c31')
      await tick()
      // épuise le seau de CRÉATION (capacity 2)
      await s.request('account:create', { name: 'nonreg1', secret: SECRET_LONG })
      await s.request('account:create', { name: 'nonreg2', secret: SECRET_LONG })
      let creerBloque: any
      try { await s.request('account:create', { name: 'nonreg3', secret: SECRET_LONG }) } catch (e) { creerBloque = e }
      assert.equal(creerBloque, 'account-throttled', 'le seau de création est bien épuisé')

      // account:login n'est PAS affecté — son propre seau (forceBrute, capacity 5) reste intact
      const res = await s.request('account:login', { name: 'nonreg1', secret: SECRET_LONG })
      assert.equal(res.ok, true, 'account:login fonctionne toujours normalement — seau INDÉPENDANT du seau de création')

      // et l'anti-force-brute de account:login fonctionne toujours (5 échecs distincts → account-denied, le 6e → account-throttled)
      const erreurs: any[] = []
      for (let i = 0; i < 5; i++) {
        try { await s.request('account:login', { name: 'inexistant-nonreg' + i, secret: 'nimportequoi1' }) }
        catch (e) { erreurs.push(e) }
      }
      assert.deepEqual(erreurs, Array(5).fill('account-denied'))
      let sixieme: any
      try { await s.request('account:login', { name: 'encoreunautre-nonreg', secret: 'nimportequoi1' }) }
      catch (e) { sixieme = e }
      assert.equal(sixieme, 'account-throttled', 'seau bruteForce toujours fonctionnel, INTACT malgré le seau de création épuisé')
      s.destroy(); await app.stop()
    })

    it('32. opts.maxAccounts — plafond total atteint → account-limit-reached, sous le plafond → OK', async () => {
      const { transport, app } = await startApp({ maxAccounts: 2, createPerIp: { capacity: 10, windowMs: 60000 } })
      const s = connectAnonyme(transport, 'memory://c32')
      await tick()
      const r1 = await s.request('account:create', { name: 'max1', secret: SECRET_LONG })
      assert.equal(r1.ok, true)
      const r2 = await s.request('account:create', { name: 'max2', secret: SECRET_LONG })
      assert.equal(r2.ok, true)
      await assert.rejects(s.request('account:create', { name: 'max3', secret: SECRET_LONG }), (e: any) => e === 'account-limit-reached')
      s.destroy(); await app.stop()
    })
  })
})
