// Tests du paquet CHAT (src/mjs-ws/chat.ts) — MÊME technique que
// tests/mjs-ws-room-history.test.ts/mjs-ws-packages.test.ts (vrai client µ.socket, MemoryTransport,
// app.use(chatPackage(...))). Le client ici reste le socket BRUT (s.on/s.send) — PAS mjs_chat.ts
// (couvert par tests/socket-chat.test.ts) : ces tests prouvent le PROTOCOLE serveur seul.
//
// Couvre : rediffusion enrichie (id/ts/pseudo TOUJOURS résolus serveur, jamais le client),
// historique au join (défaut 100 + configurable + désactivé, anneau), maxLength, débit par
// identité+salon (partagé multi-onglets, isolé par salon, isolé par identité), forme du texte
// (vide/non-string), onMessage (transforme/rejette), modération (suppression → retrait, muet à
// durée + refus non-modérateur), frappe (aux autres seulement, throttlée, JAMAIS dans
// l'historique), isolation multi-salons, préfixe personnalisé, canJoin, chat:me.
//
// `s.room(prefixe + salon)` est appelé AVANT tout chat:send/frappe/supprimer/muet dans chaque
// test — chatPackage exige l'adhésion au salon MJS-WS bas niveau (µ:join, cf. chat.ts::isAllowed)
// AVANT toute action chat, exactement comme le fait sock.chat() en coulisses (mjs_chat.ts).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, chatPackage } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsWsChatOptions } from '../src/mjs-ws/chat.js'
import type { MjsPackage } from '../src/mjs-ws/packages.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// même stub minimal que tests/mjs-ws-packages.test.ts — µ.state non réactif (simple copie) : ces
// tests portent sur le PROTOCOLE serveur, pas sur la réactivité MJS (cf. tests/socket-chat.test.ts).
function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

// identité = hello.auth TEL QUEL (même patron que mjs-ws-packages.test.ts::startMjsServerApp) ;
// onLog silencieux par défaut — la plupart des rejets chat-* testés ici sont INTENTIONNELS (même
// motif que mjs-ws-core.test.ts test 3, « le throw de 'boom' est INTENTIONNEL — pas de bruit »).
async function startApp(chatOpts: MjsWsChatOptions = {}, wsOpts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp; pkg: MjsPackage }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, onLog: () => {}, ...wsOpts })
  const pkg = chatPackage(chatOpts)
  app.use(pkg)
  await app.listen()
  return { transport, app, pkg }
}

function connect(transport: MemoryTransport, url: string, identity: unknown): any {
  const s = makeClient(transport).socket(url, { auth: () => identity, reconnect: { enabled: false } })
  s.connect()
  return s
}

// rejoint le salon MJS-WS bas niveau (µ:join) — préalable à toute action chat, cf. tête de fichier
function joinRoom(s: any, room: string, prefix = 'chat:'): void {
  s.room(prefix + room)
}

// mémoire bornée — fait franchir le seuil de balayage GLOBAL du paquet
// (SWEEP_EVERY_N_ACTIONS = 50, chat.ts) : connecte un client-BRUIT dédié dans un salon dédié
// et y enchaîne 80 chat:typing (jamais débitée/journalisée — juste compter comme « une action chat »,
// cf. opportunisticSweep), marge volontaire au-delà du seuil réel. N'y touche PAS au salon/à
// l'identité sous test — le balayage déclenché est GLOBAL (toutes les Maps du paquet), pas scopé
// au salon 'bruit-balayage' lui-même.
async function triggerGlobalSweep(transport: MemoryTransport): Promise<void> {
  const s = connect(transport, 'memory://bruit-balayage', { id: 'bruit' })
  joinRoom(s, 'bruit-balayage')
  await tick()
  for (let i = 0; i < 80; i++) s.send('chat:typing', { room: 'bruit-balayage' })
  await tick()
  s.destroy()
  await tick()
}

const zora = { id: '1', name: 'Zora' }
const theo = { id: '2', name: 'Theo' }

describe('MJS-WS — paquet CHAT (chat.ts)', () => {

  describe('rediffusion enrichie — le serveur ne fait confiance à rien du client', () => {
    it('1. envoyer → rediffusion { salon, id court, texte, from:{id,pseudo}, ts } au(x) membre(s)', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://c1', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); await tick()
      const avant = Date.now()
      s.send('chat:send', { room: 'general', text: 'salut' })
      await tick()
      assert.equal(received.length, 1)
      const m = received[0]
      assert.equal(m.room, 'general')
      assert.equal(typeof m.id, 'string')
      assert.ok(m.id.length > 0 && m.id.length <= 20, 'id COURT')
      assert.equal(m.text, 'salut')
      assert.deepEqual(m.from, { id: '1', name: 'Zora' })
      assert.ok(typeof m.ts === 'number' && m.ts >= avant, 'ts SERVEUR, proche de maintenant')
      s.destroy(); await app.stop()
    })

    it('2. ts/pseudo/id du client sont IGNORÉS — resolus depuis client.identity uniquement', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://c2', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); await tick()
      s.send('chat:send', { room: 'general', text: 'salut', ts: 1, id: 'usurpe', from: { id: '999', name: 'Faux' } })
      await tick()
      assert.equal(received[0].from.id, '1')
      assert.equal(received[0].from.name, 'Zora')
      assert.notEqual(received[0].id, 'usurpe')
      assert.notEqual(received[0].ts, 1)
      s.destroy(); await app.stop()
    })

    it('3. pseudo — repli sur identity.name si pas de pseudo', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://c3', { id: '5', name: 'Aliénor' })
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); await tick()
      s.send('chat:send', { room: 'general', text: 'yo' })
      await tick()
      assert.equal(received[0].from.name, 'Aliénor')
      s.destroy(); await app.stop()
    })

    it('4. pseudo — repli sur id si ni pseudo ni nom', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://c4', { id: '7' })
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); await tick()
      s.send('chat:send', { room: 'general', text: 'yo' })
      await tick()
      assert.equal(received[0].from.name, '7')
      s.destroy(); await app.stop()
    })

    it("5. chat:me — renvoie l'identité résolue serveur, indépendamment de tout salon", async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://c5', zora)
      await tick()
      const moi = await s.request('chat:me', {})
      assert.deepEqual(moi, { id: '1', name: 'Zora' })
      s.destroy(); await app.stop()
    })
  })

  describe('historique au join — room().history() en épine dorsale', () => {
    it("6. défaut 100 — un nouvel arrivant reçoit les messages dans l'ordre", async () => {
      const { transport, app } = await startApp()
      const sA = connect(transport, 'memory://c6a', zora)
      joinRoom(sA, 'general'); await tick()
      for (let i = 1; i <= 5; i++) { sA.send('chat:send', { room: 'general', text: 'm' + i }); await tick() }
      const sB = connect(transport, 'memory://c6b', theo)
      const recuB: any[] = []
      sB.on('chat:message', (p: any) => recuB.push(p))
      joinRoom(sB, 'general'); await tick()
      assert.deepEqual(recuB.map((m: any) => m.text), ['m1', 'm2', 'm3', 'm4', 'm5'])
      sA.destroy(); sB.destroy(); await app.stop()
    })

    it('7. configurable + anneau — historique(2) : seuls les 2 derniers survivent', async () => {
      const { transport, app } = await startApp({ history: 2, rateLimit: { rate: 100, burst: 100 } })
      const sA = connect(transport, 'memory://c7a', zora)
      joinRoom(sA, 'general'); await tick()
      for (let i = 1; i <= 4; i++) { sA.send('chat:send', { room: 'general', text: 'm' + i }); await tick() }
      const sB = connect(transport, 'memory://c7b', theo)
      const recuB: any[] = []
      sB.on('chat:message', (p: any) => recuB.push(p))
      joinRoom(sB, 'general'); await tick()
      assert.deepEqual(recuB.map((m: any) => m.text), ['m3', 'm4'])
      sA.destroy(); sB.destroy(); await app.stop()
    })

    it('8. history: 0 — désactivé, un nouvel arrivant ne reçoit rien du passé', async () => {
      const { transport, app } = await startApp({ history: 0 })
      const sA = connect(transport, 'memory://c8a', zora)
      joinRoom(sA, 'general'); await tick()
      sA.send('chat:send', { room: 'general', text: 'm1' }); await tick()
      const sB = connect(transport, 'memory://c8b', theo)
      const recuB: any[] = []
      sB.on('chat:message', (p: any) => recuB.push(p))
      joinRoom(sB, 'general'); await tick()
      assert.deepEqual(recuB, [])
      sA.send('chat:send', { room: 'general', text: 'm2' }); await tick()
      assert.deepEqual(recuB.map((m: any) => m.text), ['m2'], 'le live continue, seul le rattrapage est coupé')
      sA.destroy(); sB.destroy(); await app.stop()
    })
  })

  describe('validation du texte — chat-length', () => {
    it('9. maxLength par défaut (2000) — au-delà, rejet chat-length, rien de rediffusé', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://c9', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); await tick()
      s.send('chat:send', { room: 'general', text: 'x'.repeat(2001) })
      await tick()
      assert.deepEqual(received, [])
      assert.equal(s.lastError.message, 'chat-length')
      s.destroy(); await app.stop()
    })

    it('10. maxLength configurable — limite personnalisée respectée', async () => {
      const { transport, app } = await startApp({ maxLength: 5 })
      const s = connect(transport, 'memory://c10', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); await tick()
      s.send('chat:send', { room: 'general', text: 'abcdef' })
      await tick()
      assert.deepEqual(received, [])
      assert.equal(s.lastError.message, 'chat-length')
      s._mjs_st.lastError = null
      s.send('chat:send', { room: 'general', text: 'abcde' })
      await tick()
      assert.equal(received.length, 1, '5 caractères passent (limite incluse)')
      s.destroy(); await app.stop()
    })

    it('11. texte vide (ou blanc) après trim — rejet chat-length', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://c11', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); await tick()
      s.send('chat:send', { room: 'general', text: '   ' })
      await tick()
      assert.deepEqual(received, [])
      assert.equal(s.lastError.message, 'chat-length')
      s.destroy(); await app.stop()
    })

    it('12. texte non-string — rejet chat-length, jamais un crash serveur', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://c12', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); await tick()
      s.send('chat:send', { room: 'general', text: 42 })
      await tick()
      assert.deepEqual(received, [])
      assert.equal(s.lastError.message, 'chat-length')
      // le serveur survit — un message VALIDE juste après passe normalement
      s.send('chat:send', { room: 'general', text: 'ça va' })
      await tick()
      assert.equal(received.length, 1)
      s.destroy(); await app.stop()
    })
  })

  describe('débit — seau à jetons PAR IDENTITÉ ET PAR SALON', () => {
    it('13. rafale 5 permise (défaut), le 6e message immédiat est rejeté chat-rate', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://c13', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); await tick()
      for (let i = 1; i <= 5; i++) s.send('chat:send', { room: 'general', text: 'm' + i })
      await tick()
      assert.equal(received.length, 5, 'les 5 premiers passent (burst)')
      s.send('chat:send', { room: 'general', text: 'm6' })
      await tick()
      assert.equal(received.length, 5, 'le 6e est rejeté')
      assert.equal(s.lastError.message, 'chat-rate')
      s.destroy(); await app.stop()
    })

    it('14. débit PARTAGÉ entre 2 connexions de la MÊME identité (2 onglets)', async () => {
      const { transport, app } = await startApp()
      const sA = connect(transport, 'memory://c14a', zora)
      const sB = connect(transport, 'memory://c14b', zora)   // même identité, 2e onglet
      const recuB: any[] = []
      sB.on('chat:message', (p: any) => recuB.push(p))
      joinRoom(sA, 'general'); joinRoom(sB, 'general'); await tick()
      for (let i = 1; i <= 5; i++) sA.send('chat:send', { room: 'general', text: 'a' + i })   // épuise le seau depuis A
      await tick()
      sB.send('chat:send', { room: 'general', text: 'depuis-b' })   // MÊME identité → seau déjà vide
      await tick()
      assert.equal(recuB.filter((m: any) => m.text === 'depuis-b').length, 0, 'B partage le quota de A (même identité)')
      assert.equal(sB.lastError.message, 'chat-rate')
      sA.destroy(); sB.destroy(); await app.stop()
    })

    it('15. débit ISOLÉ par salon — un salon épuisé n\'affecte pas un autre salon du même client', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://c15', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); joinRoom(s, 'random'); await tick()
      for (let i = 1; i <= 5; i++) s.send('chat:send', { room: 'general', text: 'g' + i })
      s.send('chat:send', { room: 'general', text: 'g6' })   // rejeté — general épuisé
      s.send('chat:send', { room: 'random', text: 'r1' })    // random — quota INTACT
      await tick()
      assert.equal(received.filter((m: any) => m.room === 'general').length, 5)
      assert.equal(received.filter((m: any) => m.room === 'random').length, 1, 'random a son PROPRE seau')
      s.destroy(); await app.stop()
    })

    it('16. débit ISOLÉ par identité — une identité épuisée n\'affecte pas une autre', async () => {
      const { transport, app } = await startApp()
      const sA = connect(transport, 'memory://c16a', zora)
      const sB = connect(transport, 'memory://c16b', theo)
      const recuB: any[] = []
      sB.on('chat:message', (p: any) => recuB.push(p))
      joinRoom(sA, 'general'); joinRoom(sB, 'general'); await tick()
      for (let i = 1; i <= 6; i++) sA.send('chat:send', { room: 'general', text: 'a' + i })   // A épuise SON seau
      sB.send('chat:send', { room: 'general', text: 'depuis-theo' })
      await tick()
      assert.equal(recuB.filter((m: any) => m.text === 'depuis-theo').length, 1, 'Theo a son PROPRE seau, intact')
      sA.destroy(); sB.destroy(); await app.stop()
    })
  })

  describe('onMessage — transforme ou rejette juste avant diffusion', () => {
    it('17. transforme — le texte diffusé est celui retourné par le hook', async () => {
      const { transport, app } = await startApp({ onMessage: (ctx) => ({ text: ctx.text.toUpperCase() }) })
      const s = connect(transport, 'memory://c17', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); await tick()
      s.send('chat:send', { room: 'general', text: 'salut' })
      await tick()
      assert.equal(received[0].text, 'SALUT')
      s.destroy(); await app.stop()
    })

    it("18. rejette (retour false) — µ:error 'chat-denied', rien de diffusé", async () => {
      const { transport, app } = await startApp({ onMessage: (ctx) => ctx.text.includes('vilain') ? false : undefined })
      const s = connect(transport, 'memory://c18', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); await tick()
      s.send('chat:send', { room: 'general', text: 'mot vilain' })
      await tick()
      assert.deepEqual(received, [])
      assert.equal(s.lastError.message, 'chat-denied')
      s.destroy(); await app.stop()
    })

    it("19. rejette (throw) — µ:error 'chat-denied' aussi, jamais l'erreur interne exposée", async () => {
      const { transport, app } = await startApp({ onMessage: () => { throw new Error('boom interne') } })
      const s = connect(transport, 'memory://c19', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); await tick()
      s.send('chat:send', { room: 'general', text: 'salut' })
      await tick()
      assert.deepEqual(received, [])
      assert.equal(s.lastError.message, 'chat-denied')
      s.destroy(); await app.stop()
    })
  })

  describe('modération — réservée à opts.moderators', () => {
    const moderators = (identity: any) => identity?.id === zora.id

    it("20. suppression — un modérateur retire un message, chat:removed diffusé", async () => {
      const { transport, app } = await startApp({ moderators })
      const s = connect(transport, 'memory://c20', zora)
      const messages: any[] = []; const removals: any[] = []
      s.on('chat:message', (p: any) => messages.push(p))
      s.on('chat:removed', (p: any) => removals.push(p))
      joinRoom(s, 'general'); await tick()
      s.send('chat:send', { room: 'general', text: 'à retirer' })
      await tick()
      const id = messages[0].id
      s.send('chat:remove', { room: 'general', id })
      await tick()
      assert.deepEqual(removals, [{ room: 'general', id }])
      s.destroy(); await app.stop()
    })

    it('21. suppression refusée si non-modérateur — chat-denied, aucun retrait diffusé', async () => {
      const { transport, app } = await startApp({ moderators })
      const sZ = connect(transport, 'memory://c21z', zora)
      const sT = connect(transport, 'memory://c21t', theo)
      const messages: any[] = []; const removals: any[] = []
      sZ.on('chat:message', (p: any) => messages.push(p))
      sT.on('chat:removed', (p: any) => removals.push(p))
      joinRoom(sZ, 'general'); joinRoom(sT, 'general'); await tick()
      sZ.send('chat:send', { room: 'general', text: 'reste' })
      await tick()
      const id = messages[0].id
      sT.send('chat:remove', { room: 'general', id })   // Theo n'est PAS modérateur
      await tick()
      assert.deepEqual(removals, [])
      assert.equal(sT.lastError.message, 'chat-denied')
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it("22. muet — messages rejetés 'chat-muted' pendant la durée", async () => {
      const { transport, app } = await startApp({ moderators })
      const sZ = connect(transport, 'memory://c22z', zora)
      const sT = connect(transport, 'memory://c22t', theo)
      const recuT: any[] = []
      sT.on('chat:message', (p: any) => recuT.push(p))
      joinRoom(sZ, 'general'); joinRoom(sT, 'general'); await tick()
      sZ.send('chat:mute', { room: 'general', identityId: theo.id, durationMs: 5000 })
      await tick()
      sT.send('chat:send', { room: 'general', text: 'je proteste' })
      await tick()
      assert.deepEqual(recuT, [])
      assert.equal(sT.lastError.message, 'chat-muted')
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('23. muet refusé si non-modérateur — la cible reste libre de parler', async () => {
      const { transport, app } = await startApp({ moderators })
      const sZ = connect(transport, 'memory://c23z', zora)
      const sT = connect(transport, 'memory://c23t', theo)
      const recuZ: any[] = []
      sZ.on('chat:message', (p: any) => recuZ.push(p))
      joinRoom(sZ, 'general'); joinRoom(sT, 'general'); await tick()
      sT.send('chat:mute', { room: 'general', identityId: zora.id, durationMs: 5000 })   // Theo n'est PAS modérateur
      await tick()
      assert.equal(sT.lastError.message, 'chat-denied')
      sZ.send('chat:send', { room: 'general', text: 'toujours libre' })
      await tick()
      assert.equal(recuZ.length, 1, 'Zora jamais mutée — la tentative de Theo a échoué')
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('24. muet — expire après la durée, les messages repassent ensuite', async () => {
      const { transport, app } = await startApp({ moderators })
      const sZ = connect(transport, 'memory://c24z', zora)
      const sT = connect(transport, 'memory://c24t', theo)
      const recuT: any[] = []
      sT.on('chat:message', (p: any) => recuT.push(p))
      joinRoom(sZ, 'general'); joinRoom(sT, 'general'); await tick()
      sZ.send('chat:mute', { room: 'general', identityId: theo.id, durationMs: 40 })
      await tick()
      sT.send('chat:send', { room: 'general', text: 'trop tôt' })
      await tick()
      assert.equal(sT.lastError.message, 'chat-muted')
      await tick(60)   // la grâce est écoulée
      sT.send('chat:send', { room: 'general', text: 'plus tard' })
      await tick()
      assert.deepEqual(recuT.map((m: any) => m.text), ['plus tard'])
      sZ.destroy(); sT.destroy(); await app.stop()
    })
  })

  describe('frappe — éphémère, throttlée, jamais dans l\'historique', () => {
    it("25. diffusée aux AUTRES membres, jamais à l'émetteur", async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://c25z', zora)
      const sT = connect(transport, 'memory://c25t', theo)
      const typingZ: any[] = []; const typingT: any[] = []
      sZ.on('chat:typing', (p: any) => typingZ.push(p))
      sT.on('chat:typing', (p: any) => typingT.push(p))
      joinRoom(sZ, 'general'); joinRoom(sT, 'general'); await tick()
      sZ.send('chat:typing', { room: 'general' })
      await tick()
      assert.deepEqual(typingT, [{ room: 'general', from: { id: '1', name: 'Zora' } }])
      assert.deepEqual(typingZ, [], "l'émetteur ne reçoit jamais sa PROPRE frappe")
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('26. throttlée ~3s par identité — 2 appels rapprochés ne redéclenchent qu\'UNE diffusion', async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://c26z', zora)
      const sT = connect(transport, 'memory://c26t', theo)
      const typingT: any[] = []
      sT.on('chat:typing', (p: any) => typingT.push(p))
      joinRoom(sZ, 'general'); joinRoom(sT, 'general'); await tick()
      sZ.send('chat:typing', { room: 'general' })
      sZ.send('chat:typing', { room: 'general' })
      await tick()
      assert.equal(typingT.length, 1, 'la 2e frappe immédiate est absorbée par le throttle')
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it("27. JAMAIS journalisée — un arrivant après coup ne reçoit aucune frappe passée", async () => {
      const { transport, app } = await startApp({ history: 5 })
      const sZ = connect(transport, 'memory://c27z', zora)
      joinRoom(sZ, 'general'); await tick()
      sZ.send('chat:send', { room: 'general', text: 'm1' })   // arme l'historique
      await tick()
      sZ.send('chat:typing', { room: 'general' })
      await tick()
      const sT = connect(transport, 'memory://c27t', theo)
      const messagesT: any[] = []; const typingT: any[] = []
      sT.on('chat:message', (p: any) => messagesT.push(p))
      sT.on('chat:typing', (p: any) => typingT.push(p))
      joinRoom(sT, 'general'); await tick()
      assert.deepEqual(messagesT.map((m: any) => m.text), ['m1'], "l'historique du MESSAGE, lui, est bien rejoué")
      assert.deepEqual(typingT, [], 'AUCUNE frappe rejouée — jamais journalisée')
      sZ.destroy(); sT.destroy(); await app.stop()
    })
  })

  describe('salons multiples, préfixe personnalisé, canJoin', () => {
    it('28. deux salons isolés — un message dans "general" ne fuite pas vers "random"', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://c28', zora)
      const general: any[] = []; const random: any[] = []
      s.on('chat:message', (p: any) => (p.room === 'general' ? general : random).push(p))
      joinRoom(s, 'general'); joinRoom(s, 'random'); await tick()
      s.send('chat:send', { room: 'general', text: 'g' })
      await tick()
      assert.equal(general.length, 1)
      assert.equal(random.length, 0)
      s.destroy(); await app.stop()
    })

    it("29. préfixe personnalisé — app.room('room:'+x), jamais 'chat:'+x", async () => {
      const { transport, app } = await startApp({ prefix: 'room:' })
      const s = connect(transport, 'memory://c29', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general', 'room:')
      await tick()
      s.send('chat:send', { room: 'general', text: 'yo' })
      await tick()
      assert.equal(received.length, 1)
      assert.equal(app.room('room:general').size, 1)
      assert.equal(app.room('chat:general').size, 0, "le préfixe par défaut n'est PAS utilisé")
      s.destroy(); await app.stop()
    })

    it('30. canJoin — filet supplémentaire réévalué à chaque action, indépendant de rooms.join', async () => {
      const { transport, app } = await startApp({ canJoin: (room) => !room.endsWith('vip') })
      const s = connect(transport, 'memory://c30', zora)
      const received: any[] = []
      s.on('chat:message', (p: any) => received.push(p))
      joinRoom(s, 'general'); joinRoom(s, 'vip'); await tick()
      s.send('chat:send', { room: 'general', text: 'ok' })
      await tick()
      assert.equal(received.length, 1, "'general' autorisé")
      s.send('chat:send', { room: 'vip', text: 'refuse' })
      await tick()
      assert.equal(received.length, 1, "'vip' toujours refusé — rien de plus diffusé")
      assert.equal(s.lastError.message, 'chat-denied')
      s.destroy(); await app.stop()
    })

    it('31. salon malformé (absent/non-string) — ignoré silencieusement, jamais un crash', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://c31', zora)
      await tick()
      assert.doesNotThrow(() => s.send('chat:send', { text: 'sans salon' }))
      assert.doesNotThrow(() => s.send('chat:send', { room: 42, text: 'salon nombre' }))
      await tick()
      s.destroy(); await app.stop()
    })
  })

  describe('mémoire bornée — purge opportuniste des seaux/muets', () => {
    it('32. salon vidé → seaux de débit purgés — rafale complète neuve dispo après re-join', async () => {
      const { transport, app, pkg } = await startApp({ rateLimit: { rate: 1, burst: 3 } })
      const sA = connect(transport, 'memory://c32a', zora)
      joinRoom(sA, 'general'); await tick()
      for (let i = 1; i <= 3; i++) sA.send('chat:send', { room: 'general', text: 'a' + i })
      await tick()
      sA.send('chat:send', { room: 'general', text: 'trop' })
      await tick()
      assert.equal(sA.lastError.message, 'chat-rate', 'seau épuisé AVANT le vidage')
      sA.destroy(); await tick()
      assert.equal(app.room('chat:general').size, 0, 'salon bien vidé (0 membre)')

      await triggerGlobalSweep(transport)   // franchit le seuil — balayage GLOBAL déclenché
      assert.equal((pkg as any)._buckets.has('chat:general'), false, 'le seau de "general" a été purgé par le balayage')

      const sB = connect(transport, 'memory://c32b', zora)   // MÊME identité que sA — revient dans le salon vidé
      const recuB: any[] = []
      sB.on('chat:message', (p: any) => recuB.push(p))
      joinRoom(sB, 'general'); await tick()
      for (let i = 1; i <= 3; i++) sB.send('chat:send', { room: 'general', text: 'b' + i })
      await tick()
      assert.equal(recuB.length, 3, 'rafale COMPLÈTE neuve dispo — le seau est reparti de zéro, jamais resté épuisé')
      sB.destroy(); await app.stop()
    })

    it('33. muet actif survit au vidage du salon ET au balayage — pas démuté parce que le salon est vide', async () => {
      const moderators = (identity: any) => identity?.id === zora.id
      const { transport, app } = await startApp({ moderators })
      const sZ = connect(transport, 'memory://c33z', zora)
      const sT = connect(transport, 'memory://c33t', theo)
      joinRoom(sZ, 'general'); joinRoom(sT, 'general'); await tick()
      sZ.send('chat:mute', { room: 'general', identityId: theo.id, durationMs: 5 * 60 * 1000 })   // 5 min, largement au-delà du test
      await tick()
      sZ.destroy(); sT.destroy(); await tick()   // le salon se vide ENTIÈREMENT (modérateur + muté partis)
      assert.equal(app.room('chat:general').size, 0, 'salon bien vidé (0 membre)')

      await triggerGlobalSweep(transport)   // le balayage tourne PENDANT que le salon est vide

      const sT2 = connect(transport, 'memory://c33t2', theo)   // Theo revient dans le MÊME salon
      const recuT2: any[] = []
      sT2.on('chat:message', (p: any) => recuT2.push(p))
      joinRoom(sT2, 'general'); await tick()
      sT2.send('chat:send', { room: 'general', text: 'je reviens' })
      await tick()
      assert.deepEqual(recuT2, [])
      assert.equal(sT2.lastError.message, 'chat-muted', "toujours muet — ni le vidage ni le balayage n'ont levé l'échéance")
      sT2.destroy(); await app.stop()
    })

    it('34. muet EXPIRÉ disparaît après le balayage périodique — même sans jamais être re-consulté', async () => {
      const moderators = (identity: any) => identity?.id === zora.id
      const { transport, app, pkg } = await startApp({ moderators })
      const sZ = connect(transport, 'memory://c34z', zora)
      const sT = connect(transport, 'memory://c34t', theo)
      joinRoom(sZ, 'general'); joinRoom(sT, 'general'); await tick()
      sZ.send('chat:mute', { room: 'general', identityId: theo.id, durationMs: 30 })
      await tick()
      assert.equal((pkg as any)._mutedUntil.get('chat:general')?.has(theo.id), true, "l'échéance est bien enregistrée")
      await tick(60)   // la grâce est écoulée — mais PERSONNE ne consulte estMuet(theo) entre-temps (Theo n'envoie rien)

      await triggerGlobalSweep(transport)   // seul mécanisme qui PEUT balayer cette entrée ici (jamais lazy)

      // entrée expirée balayée PROACTIVEMENT — le sous-registre du salon redevenu vide est lui-même
      // repris (purgerMuetsExpires), pas seulement l'entrée de Theo : `.get(...)` renvoie `undefined`
      assert.equal((pkg as any)._mutedUntil.get('chat:general'), undefined, 'entrée expirée balayée PROACTIVEMENT')
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('35. throttle de frappe purgé au vidage — une frappe re-passe AUSSITÔT après re-join, sous-map réclamée', async () => {
      const { transport, app, pkg } = await startApp()
      const sZ = connect(transport, 'memory://c35z', zora)
      const sT = connect(transport, 'memory://c35t', theo)
      const typingT: any[] = []
      sT.on('chat:typing', (p: any) => typingT.push(p))
      joinRoom(sZ, 'general'); joinRoom(sT, 'general'); await tick()
      sZ.send('chat:typing', { room: 'general' })
      await tick()
      assert.equal(typingT.length, 1, 'première frappe diffusée — le throttle (~3s) est désormais armé pour Zora')
      sZ.destroy(); sT.destroy(); await tick()   // le salon se vide ENTIÈREMENT
      assert.equal(app.room('chat:general').size, 0, 'salon bien vidé (0 membre)')

      await triggerGlobalSweep(transport)   // franchit le seuil — balayage GLOBAL déclenché
      assert.equal((pkg as any)._lastTypingAt.has('chat:general'), false, 'sous-map du salon vidé RÉCLAMÉE par le balayage')

      const sZ2 = connect(transport, 'memory://c35z2', zora)   // MÊME identité — sans purge, son throttle aurait encore ~2s à courir
      const sT2 = connect(transport, 'memory://c35t2', theo)
      const frappesT2: any[] = []
      sT2.on('chat:typing', (p: any) => frappesT2.push(p))
      joinRoom(sZ2, 'general'); joinRoom(sT2, 'general'); await tick()
      sZ2.send('chat:typing', { room: 'general' })
      await tick()
      assert.equal(frappesT2.length, 1, 're-passe AUSSITÔT le throttle — le timestamp n\'a pas survécu au vidage')
      sZ2.destroy(); sT2.destroy(); await app.stop()
    })
  })
})
