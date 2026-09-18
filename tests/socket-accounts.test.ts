// Tests du CLIENT réactif sock.account (mjs_accounts.ts) contre un VRAI serveur MJS-WS + accountsPackage
// (MemoryTransport) — même patron que tests/socket-chat.test.ts (`new Function('µ', src)(stub)`,
// store réactif MINIMAL Proxy set + Set d'abonnés PAR CLÉ pour PROUVER qu'une mutation déclenche un
// abonné réactif). Le PROTOCOLE serveur (creer/connecter/deconnecter/force-brute/persistance) est
// déjà couvert exhaustivement par tests/mjs-ws-accounts.test.ts — ici, uniquement le comportement du
// CLIENT : store, creer()/connecter()/deconnecter(), token en localStorage (clé par défaut ET
// configurable), reprise au boot (token valide → élève dès le premier accès à sock.account, token
// mort → purgé), garde SSR/happy-dom (localStorage absent), erreur exposée normalisée en chaîne.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, accountsPackage, accountsAuth } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const __dirname   = dirname(fileURLToPath(import.meta.url))
const socketSrc   = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')
const comptesSrc  = readFileSync(join(__dirname, '../src/runtime/mjs_accounts.ts'), 'utf8')
// CONCATÉNÉS dans UN seul new Function — même patron que socket-chat.test.ts (mjs_accounts.ts
// référence `MjsSocket` en identifiant NU, ordre canonique du bundler : socket PUIS comptes).
const clientSrc = socketSrc + '\n' + comptesSrc

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// store réactif MINIMAL (Proxy set + Set d'abonnés PAR CLÉ) — MÊME stub que socket-chat.test.ts :
// prouve qu'une mutation (réassignation top-level, cf. mjs_accounts.ts::_accountApply) déclenche
// un VRAI abonné réactif, pas seulement une relecture après coup.
const __compteStoreSubs = new WeakMap<object, Map<string, Set<() => void>>>()
function reactiveState(init: any): any {
  const target: any = { ...init }
  const subs = new Map<string, Set<() => void>>()
  const proxy = new Proxy(target, {
    set(obj, key, value) {
      obj[key as string] = value
      const s = subs.get(key as string)
      if (s) s.forEach(fn => fn())
      return true
    },
    deleteProperty(obj, key) { delete obj[key as string]; return true },
  })
  __compteStoreSubs.set(proxy, subs)
  return proxy
}
function watchKey(store: any, key: string, fn: () => void): void {
  const subs = __compteStoreSubs.get(store)
  if (!subs) return
  let s = subs.get(key)
  if (!s) { s = new Set(); subs.set(key, s) }
  s.add(fn)
}

function makeMu(): any {
  const µ: any = { state: reactiveState, error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

// fausse localStorage — Map en mémoire, MÊME contrat que le Storage du navigateur pour
// getItem/setItem/removeItem (suffisant pour ce module, cf. mjs_accounts.ts)
function makeLocalStorage(): any {
  const map = new Map<string, string>()
  return {
    getItem(k: string) { return map.has(k) ? (map.get(k) as string) : null },
    setItem(k: string, v: string) { map.set(k, String(v)) },
    removeItem(k: string) { map.delete(k) },
  }
}

const SECRET      = 'secret-test-socket-comptes'
const SECRET_LONG = 'motdepasse123'

async function startApp(wsOpts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, auth: accountsAuth(SECRET), onLog: () => {}, ...wsOpts })
  app.use(accountsPackage({ secret: SECRET, onLog: () => {} }))
  await app.listen()
  return { transport, app }
}

// crée un compte via un socket BRUT jetable (pas sock.account) — utilitaire de préparation pour les
// tests de connecter()/reprise au boot, qui ont besoin d'un compte PRÉEXISTANT.
async function creerCompteAuPrealable(transport: MemoryTransport, name: string, secret: string): Promise<string> {
  const s = makeClient(transport).socket('memory://prealable-' + name, { auth: () => undefined, reconnect: { enabled: false } })
  s.connect(); await tick()
  const res = await s.request('account:create', { name, secret })
  s.destroy(); await tick()
  return res.token
}

describe('sock.account — client réactif du paquet COMPTES (mjs_accounts.ts, vrai serveur MJS-WS + accountsPackage)', () => {
  beforeEach(() => { delete (globalThis as any).localStorage })

  it('a. état initial — store anonyme, les 3 méthodes présentes', async () => {
    const { transport, app } = await startApp()
    const s = makeClient(transport).socket('memory://sa1', { auth: () => undefined, reconnect: { enabled: false } })
    const account = s.account
    assert.equal(account.loggedIn, false)
    assert.equal(account.name, null)
    assert.deepEqual(account.roles, [])
    assert.equal(account.error, null)
    assert.equal(account.token, null)
    assert.equal(typeof account.create, 'function')
    assert.equal(typeof account.login, 'function')
    assert.equal(typeof account.logout, 'function')
    s.destroy(); await app.stop()
  })

  it('b. create() — succès : loggedIn/name/roles/token posés, réactivité PROUVÉE, persisté en localStorage', async () => {
    ;(globalThis as any).localStorage = makeLocalStorage()
    const { transport, app } = await startApp()
    const s = makeClient(transport).socket('memory://sb1', { auth: () => undefined, reconnect: { enabled: false } })
    const account = s.account
    await tick()
    let fired = false
    watchKey(account, 'loggedIn', () => { fired = true })
    await account.create('zora', SECRET_LONG)
    assert.equal(account.loggedIn, true)
    assert.equal(account.name, 'zora')
    assert.deepEqual(account.roles, [])
    assert.equal(typeof account.token, 'string')
    assert.ok(fired, "la mutation de 'loggedIn' doit avoir déclenché un abonné réactif")
    assert.equal((globalThis as any).localStorage.getItem('mjs-token'), account.token, 'token persisté (clé par défaut)')
    s.destroy(); await app.stop()
  })

  it('c. login() — succès sur un account PRÉEXISTANT', async () => {
    const { transport, app } = await startApp()
    await creerCompteAuPrealable(transport, 'theo', SECRET_LONG)
    const s = makeClient(transport).socket('memory://sc1', { auth: () => undefined, reconnect: { enabled: false } })
    const account = s.account
    await tick()
    await account.login('theo', SECRET_LONG)
    assert.equal(account.loggedIn, true)
    assert.equal(account.name, 'theo')
    s.destroy(); await app.stop()
  })

  it("d. create() échoue (name pris) — error exposée EN CHAÎNE, loggedIn reste false", async () => {
    const { transport, app } = await startApp()
    await creerCompteAuPrealable(transport, 'zora', SECRET_LONG)
    const s = makeClient(transport).socket('memory://sd1', { auth: () => undefined, reconnect: { enabled: false } })
    const account = s.account
    await tick()
    await assert.rejects(account.create('zora', 'autresecret1'), (e: any) => e === 'account-name-taken')
    assert.equal(account.error, 'account-name-taken')
    assert.equal(account.loggedIn, false)
    s.destroy(); await app.stop()
  })

  it('e. logout() — purge le store ET le token local', async () => {
    ;(globalThis as any).localStorage = makeLocalStorage()
    const { transport, app } = await startApp()
    const s = makeClient(transport).socket('memory://se1', { auth: () => undefined, reconnect: { enabled: false } })
    const account = s.account
    await tick()
    await account.create('zora', SECRET_LONG)
    assert.equal(account.loggedIn, true)
    await account.logout()
    assert.equal(account.loggedIn, false)
    assert.equal(account.name, null)
    assert.deepEqual(account.roles, [])
    assert.equal(account.token, null)
    assert.equal((globalThis as any).localStorage.getItem('mjs-token'), null, 'token purgé du localStorage')
    s.destroy(); await app.stop()
  })

  it('f. clé localStorage configurable — µ.socket(url, { account: { key } })', async () => {
    ;(globalThis as any).localStorage = makeLocalStorage()
    const { transport, app } = await startApp()
    const s = makeClient(transport).socket('memory://sf1', { auth: () => undefined, reconnect: { enabled: false }, account: { key: 'ma-key-perso' } } as any)
    const account = s.account
    await tick()
    await account.create('zora', SECRET_LONG)
    assert.equal((globalThis as any).localStorage.getItem('ma-key-perso'), account.token)
    assert.equal((globalThis as any).localStorage.getItem('mjs-token'), null, "la clé par défaut n'est PAS utilisée")
    s.destroy(); await app.stop()
  })

  it("g. absence de localStorage (SSR/happy-dom) — aucun crash, le store fonctionne SANS persistance", async () => {
    const { transport, app } = await startApp()
    const s = makeClient(transport).socket('memory://sg1', { auth: () => undefined, reconnect: { enabled: false } })
    let account: any
    assert.doesNotThrow(() => { account = s.account })
    await tick()
    await account.create('zora', SECRET_LONG)
    assert.equal(account.loggedIn, true, 'le store fonctionne quand même, juste sans persistance locale')
    s.destroy(); await app.stop()
  })

  it("h. reprise au boot — un token PRÉEXISTANT en localStorage élève DÈS le premier accès à sock.account (avant login())", async () => {
    const { transport, app } = await startApp()
    const token = await creerCompteAuPrealable(transport, 'zora', SECRET_LONG)
    const storage = makeLocalStorage()
    storage.setItem('mjs-token', token)
    ;(globalThis as any).localStorage = storage

    const s = makeClient(transport).socket('memory://sh1', { auth: () => undefined, reconnect: { enabled: false } })
    const account = s.account   // AVANT tout appel explicite à connecter()
    await tick()
    assert.equal(account.loggedIn, true, "reconnexion connectée d'office — sans jamais appeler login()")
    assert.equal(account.name, 'zora')
    assert.equal(account.token, token)
    s.destroy(); await app.stop()
  })

  it('i. reprise au boot — un token invalide stocké est PURGÉ (jamais de boucle sur un token mort)', async () => {
    const storage = makeLocalStorage()
    storage.setItem('mjs-token', 'ceci-nest-pas-un-token-valide')
    ;(globalThis as any).localStorage = storage
    const { transport, app } = await startApp()
    const s = makeClient(transport).socket('memory://si1', { auth: () => undefined, reconnect: { enabled: false } })
    const account = s.account
    await tick(120)   // laisse la sonde de refus (25 ms, cf. mjs_accounts.ts::_accountElevate) opérer
    assert.equal(account.loggedIn, false)
    assert.equal(typeof account.error, 'string', '.error normalisée en CHAÎNE (jamais un objet brut)')
    assert.equal(storage.getItem('mjs-token'), null, 'token mort purgé — pas de nouvelle tentative au prochain accès')
    s.destroy(); await app.stop()
  })

  it('j. sans token stocké — sock.account loggedIn NORMALEMENT (comme sock.chat()/sock.room()), SANS élévation', async () => {
    const { transport, app } = await startApp()
    const s = makeClient(transport).socket('memory://sj1', { auth: () => undefined, reconnect: { enabled: false } })
    const account = s.account   // premier accès — connexion paresseuse normale, cf. mjs_socket.ts::_mjs_ensure
    await tick()
    assert.equal(s.state, 'open', 'connexion normale déclenchée par le premier accès, comme sock.chat()/sock.room()')
    assert.equal(account.loggedIn, false, 'mais AUCUNE élévation — reste anonyme, aucun token stocké')
    s.destroy(); await app.stop()
  })
})
