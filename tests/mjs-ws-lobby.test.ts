// Tests du paquet LOBBY (src/mjs-ws/lobby.ts) — MÊME technique
// que tests/mjs-ws-chat.test.ts (vrai client µ.socket, MemoryTransport, app.use(lobbyPackage(...))).
// Le client ici reste le socket BRUT (s.on/s.send/s.request) — PAS mjs_lobby.ts (couvert par
// tests/socket-lobby.test.ts) : ces tests prouvent le PROTOCOLE serveur seul.
//
// Couvre : entrée + présence riche (état complet au join, delta aux autres), statut (validation,
// débit, diffusion), absent auto (horodatage simulé, retour à la prochaine action, désactivable,
// jamais pour un absent EXPLICITE), invitations (bout-en-bout multi-connexions, TTL, anti-spam 6/min,
// blocage silencieux, auto-invitation refusée, cible absente, anti-énumération), annonces (diffusion,
// remplacement, titre invalide, retrait propriétaire/modérateur/refusé/introuvable, TTL), rejoindre
// (notifie l'annonceur + renvoie l'annonce + crochet onRejoindre), départ (présence/annonces/
// invitations nettoyés au balayage), mémoire bornée (introspection _presence/_annonces/_invitations),
// 2 halls isolés.
//
// `s.room(prefixe + hall)` est appelé AVANT tout `lobby:enter` dans chaque test — lobbyPackage
// exige l'adhésion au hall MJS-WS bas niveau (µ:join, cf. lobby.ts::estMembre) AVANT toute action
// lobby, exactement comme le fait sock.lobby() en coulisses (mjs_lobby.ts).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, lobbyPackage } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsWsLobbyOptions } from '../src/mjs-ws/lobby.js'
import type { MjsPackage } from '../src/mjs-ws/packages.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// même stub minimal que tests/mjs-ws-packages.test.ts/mjs-ws-chat.test.ts — µ.state non réactif
// (simple copie) : ces tests portent sur le PROTOCOLE serveur, pas sur la réactivité MJS.
function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

// identité = hello.auth TEL QUEL (même patron que mjs-ws-chat.test.ts) ; onLog silencieux par défaut
// — la plupart des rejets lobby-* testés ici sont INTENTIONNELS.
async function startApp(lobbyOpts: MjsWsLobbyOptions = {}, wsOpts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp; pkg: MjsPackage }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, onLog: () => {}, ...wsOpts })
  const pkg = lobbyPackage({ onLog: () => {}, ...lobbyOpts })
  app.use(pkg)
  await app.listen()
  return { transport, app, pkg }
}

function connect(transport: MemoryTransport, url: string, identity: unknown): any {
  const s = makeClient(transport).socket(url, { auth: () => identity, reconnect: { enabled: false } })
  s.connect()
  return s
}

// rejoint le hall MJS-WS bas niveau (µ:join) — préalable à toute action lobby, cf. tête de fichier
function joinHall(s: any, hall = 'hall', prefixe = 'lobby:'): void {
  s.room(prefixe + hall)
}

// entre dans le hall (lobby:enter) — renvoie l'accusé {moi, presents}
async function entrer(s: any, hall?: string): Promise<any> {
  return s.request('lobby:enter', hall === undefined ? {} : { hall })
}

// mémoire bornée — fait franchir le seuil de balayage GLOBAL
// du paquet (BALAYAGE_TOUTES_LES_ACTIONS = 50, lobby.ts) : connecte un client-BRUIT dédié (jamais
// devenu membre d'aucun hall — 'lobby-denied' à chaque appel, mais le compteur incrémente AVANT
// cette garde, cf. lobby.ts) et y enchaîne 80 lobby:block, marge volontaire au-delà du seuil réel.
// Le balayage déclenché est GLOBAL (toutes les Maps du paquet), pas scopé au hall 'bruit' lui-même.
async function declencherBalayageGlobal(transport: MemoryTransport): Promise<void> {
  const s = connect(transport, 'memory://bruit-balayage-lobby', { id: 'bruit-lobby' })
  await tick()
  for (let i = 0; i < 80; i++) s.send('lobby:block', { hall: 'bruit', identityId: 'x' })
  await tick()
  s.destroy()
  await tick()
}

const zora = { id: '1', name: 'Zora' }
const theo = { id: '2', name: 'Theo' }
const nyx  = { id: '3', name: 'Nyx' }

describe('MJS-WS — paquet LOBBY (lobby.ts)', () => {

  describe('entrée + présence riche — état complet au join, delta aux autres', () => {
    it("1. 1er arrivant — moi résolu serveur, presents SELF-INCLUSIF (seule façon d'observer SON PROPRE statut/texte/depuis, .me n'a que id/pseudo)", async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://l1', zora)
      joinHall(s); await tick()
      const res = await entrer(s)
      assert.deepEqual(res.me, { id: '1', name: 'Zora' })
      assert.equal(res.members.length, 1, 'le seul présent est moi-même')
      assert.equal(res.members[0].id, '1')
      assert.equal(res.members[0].status, 'free')
      s.destroy(); await app.stop()
    })

    it("2. 2e arrivant voit le 1er ET soi-même dans presents ; le 1er reçoit un delta lobby:member (sauf soi)", async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l2z', zora)
      joinHall(sZ); await tick()
      await entrer(sZ)
      const deltasZ: any[] = []
      sZ.on('lobby:member', (p: any) => deltasZ.push(p))

      const sT = connect(transport, 'memory://l2t', theo)
      joinHall(sT); await tick()
      const resT = await entrer(sT)

      assert.equal(resT.members.length, 2, 'Theo voit Zora ET lui-même à son entrée')
      const zoraVueParTheo = resT.members.find((p: any) => p.id === '1')
      assert.ok(zoraVueParTheo)
      assert.equal(zoraVueParTheo.status, 'free')
      assert.equal(typeof zoraVueParTheo.since, 'number')

      assert.equal(deltasZ.length, 1, 'Zora reçoit UN delta pour l\'arrivée de Theo')
      assert.equal(deltasZ[0].id, '2')
      assert.equal(deltasZ[0].name, 'Theo')
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it("3. pseudo — repli sur identity.name, puis sur l'id si ni pseudo ni nom", async () => {
      const { transport, app } = await startApp()
      const sA = connect(transport, 'memory://l3a', { id: '5', name: 'Aliénor' })
      joinHall(sA); await tick()
      const resA = await entrer(sA)
      assert.equal(resA.me.name, 'Aliénor')

      const sB = connect(transport, 'memory://l3b', { id: '7' })
      joinHall(sB); await tick()
      const resB = await entrer(sB)
      assert.equal(resB.me.name, '7')
      sA.destroy(); sB.destroy(); await app.stop()
    })

    it("4. lobby:enter refuse ('lobby-denied') sans adhésion préalable au hall MJS-WS", async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://l4', zora)
      await tick()   // PAS de joinHall() ici
      await assert.rejects(entrer(s), (e: any) => e === 'lobby-denied')
      s.destroy(); await app.stop()
    })
  })

  describe('statut riche — validation, débit, diffusion', () => {
    it('5. statut + texte valides → diffusé à TOUS (soi-même inclus)', async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l5z', zora)
      const sT = connect(transport, 'memory://l5t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const deltasZ: any[] = []; const deltasT: any[] = []
      sZ.on('lobby:member', (p: any) => deltasZ.push(p))
      sT.on('lobby:member', (p: any) => deltasT.push(p))

      sZ.send('lobby:status', { status: 'busy', text: 'en partie' })
      await tick()

      for (const deltas of [deltasZ, deltasT]) {
        const d = deltas.find((p: any) => p.id === '1')
        assert.ok(d, 'chaque membre reçoit le delta, y compris l\'émetteur')
        assert.equal(d.status, 'busy')
        assert.equal(d.text, 'en partie')
      }
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('6. texte — trim, vide après trim devient null', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://l6', zora)
      joinHall(s); await tick()
      await entrer(s)
      const deltas: any[] = []
      s.on('lobby:member', (p: any) => deltas.push(p))
      s.send('lobby:status', { status: 'free', text: '   ' })
      await tick()
      assert.equal(deltas[0].text, null)
      s.destroy(); await app.stop()
    })

    it('7. texte trop long (> 60 par défaut) → lobby-text-invalid, rien diffusé', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://l7', zora)
      joinHall(s); await tick()
      await entrer(s)
      const deltas: any[] = []
      s.on('lobby:member', (p: any) => deltas.push(p))
      s.send('lobby:status', { status: 'free', text: 'x'.repeat(61) })
      await tick()
      assert.deepEqual(deltas, [])
      assert.equal(s.lastError.message, 'lobby-text-invalid')
      s.destroy(); await app.stop()
    })

    it("8. statut hors énumération → lobby-status-invalid", async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://l8', zora)
      joinHall(s); await tick()
      await entrer(s)
      s.send('lobby:status', { status: 'en-vacances' })
      await tick()
      assert.equal(s.lastError.message, 'lobby-status-invalid')
      s.destroy(); await app.stop()
    })

    it('9. débit — 1 changement / 5s par identité, le 2e immédiat est rejeté lobby-rate', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://l9', zora)
      joinHall(s); await tick()
      await entrer(s)
      const deltas: any[] = []
      s.on('lobby:member', (p: any) => deltas.push(p))
      s.send('lobby:status', { status: 'busy' })
      await tick()
      s.send('lobby:status', { status: 'free' })
      await tick()
      assert.equal(deltas.length, 1, 'seul le 1er changement est passé')
      assert.equal(deltas[0].status, 'busy')
      assert.equal(s.lastError.message, 'lobby-rate')
      s.destroy(); await app.stop()
    })

    it("10. lobby:status refuse ('lobby-denied') sans lobby:enter préalable", async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://l10', zora)
      joinHall(s); await tick()   // membre du hall MJS-WS, mais JAMAIS entré (lobby:enter)
      s.send('lobby:status', { status: 'busy' })
      await tick()
      assert.equal(s.lastError.message, 'lobby-denied')
      s.destroy(); await app.stop()
    })
  })

  describe('absent auto — horodatage simulé, retour à la prochaine action, désactivable', () => {
    it('11. bascule absent après le seuil (lastActivity reculée), delta diffusé aux autres', async () => {
      const { transport, app, pkg } = await startApp({ awayAfterMs: 100000 })
      const sZ = connect(transport, 'memory://l11z', zora)
      const sT = connect(transport, 'memory://l11t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const deltasT: any[] = []
      sT.on('lobby:member', (p: any) => deltasT.push(p))

      // horodatage SIMULÉ — recule l'activité de Zora sans attendre réellement 100000ms+
      ;(pkg as any)._presence.get('lobby:hall').get(zora.id).lastActivity = Date.now() - 100001
      await declencherBalayageGlobal(transport)

      const d = deltasT.find((p: any) => p.id === '1')
      assert.ok(d, 'Theo doit recevoir un delta pour Zora')
      assert.equal(d.status, 'away')
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('12. retour AUTOMATIQUE au statut précédent à la prochaine action réussie', async () => {
      const { transport, app, pkg } = await startApp({ awayAfterMs: 100000 })
      const sZ = connect(transport, 'memory://l12z', zora)
      const sT = connect(transport, 'memory://l12t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      sZ.send('lobby:status', { status: 'busy' })
      await tick()

      ;(pkg as any)._presence.get('lobby:hall').get(zora.id).lastActivity = Date.now() - 100001
      await declencherBalayageGlobal(transport)

      const deltasT: any[] = []
      sT.on('lobby:member', (p: any) => deltasT.push(p))
      // action quelconque (PAS lobby:status) — prouve que le retour n'est pas spécifique à statut()
      sZ.send('lobby:block', { identityId: 'personne' })
      await tick()

      const d = deltasT.find((p: any) => p.id === '1')
      assert.ok(d, 'un retour d\'absence diffuse un delta MÊME depuis un handler qui ne diffuse rien par défaut')
      assert.equal(d.status, 'busy', "revient à SON statut d'avant l'absence, pas à 'free'")
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('13. désactivable (awayAfterMs: null) — jamais basculé, même très en retard', async () => {
      const { transport, app, pkg } = await startApp({ awayAfterMs: null })
      const s = connect(transport, 'memory://l13', zora)
      joinHall(s); await tick()
      await entrer(s)
      ;(pkg as any)._presence.get('lobby:hall').get(zora.id).lastActivity = Date.now() - 10_000_000
      await declencherBalayageGlobal(transport)
      const entry = (pkg as any)._presence.get('lobby:hall').get(zora.id)
      assert.equal(entry.status, 'free', 'jamais marqué absent — mécanisme désactivé')
      s.destroy(); await app.stop()
    })

    it("14. absent EXPLICITE (status('away')) ne revient JAMAIS tout seul", async () => {
      const { transport, app, pkg } = await startApp({ awayAfterMs: 100000 })
      const s = connect(transport, 'memory://l14', zora)
      joinHall(s); await tick()
      await entrer(s)
      s.send('lobby:status', { status: 'away', text: 'parti manger' })
      await tick()
      // balayage (même longtemps après) ne doit RIEN changer — ce n'est pas un absent-auto
      await declencherBalayageGlobal(transport)
      const entry = (pkg as any)._presence.get('lobby:hall').get(zora.id)
      assert.equal(entry.status, 'away')
      assert.equal(entry.text, 'parti manger', 'le balayage ne touche pas un absent EXPLICITE')
      s.destroy(); await app.stop()
    })
  })

  describe('invitations — bout-en-bout, anti-spam, blocage, auto-invitation, absence, anti-énumération', () => {
    it('15. bout-en-bout — TOUTES les connexions de l\'invité (2 onglets) reçoivent lobby:invitation', async () => {
      const { transport, app } = await startApp()
      const sZ  = connect(transport, 'memory://l15z', zora)
      const sT1 = connect(transport, 'memory://l15t1', theo)
      const sT2 = connect(transport, 'memory://l15t2', theo)   // 2e onglet, MÊME identité
      joinHall(sZ); joinHall(sT1); joinHall(sT2); await tick()
      await entrer(sZ); await entrer(sT1); await entrer(sT2)
      const recuT1: any[] = []; const recuT2: any[] = []
      sT1.on('lobby:invitation', (p: any) => recuT1.push(p))
      sT2.on('lobby:invitation', (p: any) => recuT2.push(p))

      sZ.send('lobby:invite', { identityId: theo.id, note: 'viens jouer' })
      await tick()

      assert.equal(recuT1.length, 1); assert.equal(recuT2.length, 1)
      assert.equal(recuT1[0].from.id, '1'); assert.equal(recuT1[0].from.name, 'Zora')
      assert.equal(recuT1[0].note, 'viens jouer')
      assert.equal(typeof recuT1[0].expiresAt, 'number')
      assert.deepEqual(recuT1[0], recuT2[0], 'les DEUX connexions reçoivent la MÊME invitation')
      sZ.destroy(); sT1.destroy(); sT2.destroy(); await app.stop()
    })

    it('16. repondre (accepte) → le demandeur reçoit lobby:replied {accepted:true}', async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l16z', zora)
      const sT = connect(transport, 'memory://l16t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const recuInvT: any[] = []; const recuRepZ: any[] = []
      sT.on('lobby:invitation', (p: any) => recuInvT.push(p))
      sZ.on('lobby:replied', (p: any) => recuRepZ.push(p))

      sZ.send('lobby:invite', { identityId: theo.id })
      await tick()
      sT.send('lobby:reply', { id: recuInvT[0].id, accepted: true })
      await tick()

      assert.equal(recuRepZ.length, 1)
      assert.equal(recuRepZ[0].id, recuInvT[0].id)
      assert.deepEqual(recuRepZ[0].from, { id: '2', name: 'Theo' })
      assert.equal(recuRepZ[0].accepted, true)
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('17. repondre (refuse) → lobby:replied {accepted:false}', async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l17z', zora)
      const sT = connect(transport, 'memory://l17t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const recuInvT: any[] = []; const recuRepZ: any[] = []
      sT.on('lobby:invitation', (p: any) => recuInvT.push(p))
      sZ.on('lobby:replied', (p: any) => recuRepZ.push(p))
      sZ.send('lobby:invite', { identityId: theo.id })
      await tick()
      sT.send('lobby:reply', { id: recuInvT[0].id, accepted: false })
      await tick()
      assert.equal(recuRepZ[0].accepted, false)
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('18. TTL — invitation expirée (balayage) → répondre ensuite = lobby-invitation-unknown', async () => {
      const { transport, app } = await startApp({ invitationTtlMs: 10 })
      const sZ = connect(transport, 'memory://l18z', zora)
      const sT = connect(transport, 'memory://l18t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const recuInvT: any[] = []
      sT.on('lobby:invitation', (p: any) => recuInvT.push(p))
      sZ.send('lobby:invite', { identityId: theo.id })
      await tick(20)   // > TTL (10ms)
      await declencherBalayageGlobal(transport)

      sT.send('lobby:reply', { id: recuInvT[0].id, accepted: true })
      await tick()
      assert.equal(sT.lastError.message, 'lobby-invitation-unknown')
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('19. anti-spam — débit 6/min par identité, le 7e envoi immédiat est rejeté lobby-rate', async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l19z', zora)
      const sT = connect(transport, 'memory://l19t', theo)
      const sN = connect(transport, 'memory://l19n', nyx)
      joinHall(sZ); joinHall(sT); joinHall(sN); await tick()
      await entrer(sZ); await entrer(sT); await entrer(sN)
      const recuInvT: any[] = []
      sT.on('lobby:invitation', (p: any) => recuInvT.push(p))
      for (let i = 0; i < 6; i++) sZ.send('lobby:invite', { identityId: theo.id })
      await tick()
      assert.equal(recuInvT.length, 6, 'les 6 premières passent (burst)')
      sZ.send('lobby:invite', { identityId: nyx.id })   // 7e — MÊME seau (par IDENTITÉ ÉMETTRICE, pas par cible)
      await tick()
      assert.equal(sZ.lastError.message, 'lobby-rate')
      sZ.destroy(); sT.destroy(); sN.destroy(); await app.stop()
    })

    it("20. bloquer — la cible ne reçoit RIEN, AUCUNE erreur visible côté émetteur (silencieux)", async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l20z', zora)
      const sT = connect(transport, 'memory://l20t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      sT.send('lobby:block', { identityId: zora.id })
      await tick()
      const recuInvT: any[] = []
      sT.on('lobby:invitation', (p: any) => recuInvT.push(p))
      sZ.send('lobby:invite', { identityId: theo.id, note: 'coucou' })
      await tick()
      assert.deepEqual(recuInvT, [], 'Theo (bloqueur) ne reçoit rien')
      assert.equal(sZ.lastError, null, "Zora (bloquée à son insu) ne voit AUCUNE erreur — indistinguable d'un envoi normal")
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('21. auto-invitation refusée (lobby-self-invite)', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://l21', zora)
      joinHall(s); await tick()
      await entrer(s)
      s.send('lobby:invite', { identityId: zora.id })
      await tick()
      assert.equal(s.lastError.message, 'lobby-self-invite')
      s.destroy(); await app.stop()
    })

    it('22. cible absente du hall → lobby-away (jamais rencontrée, ou repartie)', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://l22', zora)
      joinHall(s); await tick()
      await entrer(s)
      s.send('lobby:invite', { identityId: 'fantome' })
      await tick()
      assert.equal(s.lastError.message, 'lobby-away')
      s.destroy(); await app.stop()
    })

    it("23. repondre à une invitation qui n'est PAS la mienne → lobby-invitation-unknown (anti-énumération)", async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l23z', zora)
      const sT = connect(transport, 'memory://l23t', theo)
      const sN = connect(transport, 'memory://l23n', nyx)
      joinHall(sZ); joinHall(sT); joinHall(sN); await tick()
      await entrer(sZ); await entrer(sT); await entrer(sN)
      const recuInvT: any[] = []
      sT.on('lobby:invitation', (p: any) => recuInvT.push(p))
      sZ.send('lobby:invite', { identityId: theo.id })   // adressée à Theo
      await tick()
      sN.send('lobby:reply', { id: recuInvT[0].id, accepted: true })   // Nyx tente de répondre à la place de Theo
      await tick()
      assert.equal(sN.lastError.message, 'lobby-invitation-unknown', "MÊME message qu'un id totalement inconnu")
      sZ.destroy(); sT.destroy(); sN.destroy(); await app.stop()
    })
  })

  describe('annonces — diffusion, remplacement, retrait (propriétaire/modérateur/refusé/introuvable), TTL', () => {
    it('24. annoncer — diffusé à TOUTE la salle (soi-même inclus)', async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l24z', zora)
      const sT = connect(transport, 'memory://l24t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const recuZ: any[] = []; const recuT: any[] = []
      sZ.on('lobby:listing', (p: any) => recuZ.push(p))
      sT.on('lobby:listing', (p: any) => recuT.push(p))

      sZ.send('lobby:advertise', { title: 'Partie rapide', seats: 4, code: 'ABCD' })
      await tick()

      for (const recu of [recuZ, recuT]) {
        assert.equal(recu.length, 1)
        assert.equal(recu[0].title, 'Partie rapide')
        assert.equal(recu[0].seats, 4)
        assert.equal(recu[0].code, 'ABCD')
        assert.deepEqual(recu[0].from, { id: '1', name: 'Zora' })
        assert.equal(typeof recu[0].expiresAt, 'number')
      }
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it("25. remplacement — 1 annonce active par identité, la nouvelle retire l'ancienne AVANT de diffuser la nouvelle", async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l25z', zora)
      const sT = connect(transport, 'memory://l25t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const evenements: any[] = []
      sT.on('lobby:listing', (p: any) => evenements.push({ type: 'listing', ...p }))
      sT.on('lobby:withdrawn', (p: any) => evenements.push({ type: 'retrait', ...p }))

      sZ.send('lobby:advertise', { title: 'Partie A' })
      await tick()
      const idA = evenements[0].id
      sZ.send('lobby:advertise', { title: 'Partie B' })
      await tick()

      assert.equal(evenements.length, 3, 'listing A, retrait A, listing B — dans cet ordre')
      assert.deepEqual(evenements.map(e => e.type), ['listing', 'retrait', 'listing'])
      assert.equal(evenements[1].id, idA, "le retrait vise bien l'annonce A")
      assert.equal(evenements[2].title, 'Partie B')
      assert.notEqual(evenements[2].id, idA, 'nouvelle listing = nouvel id')
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('26. titre invalide (vide/trop long/non-chaîne) → lobby-title-invalid, rien diffusé', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://l26', zora)
      joinHall(s); await tick()
      await entrer(s)
      const recu: any[] = []
      s.on('lobby:listing', (p: any) => recu.push(p))
      s.send('lobby:advertise', { title: '   ' })
      await tick()
      assert.equal(s.lastError.message, 'lobby-title-invalid')
      s.send('lobby:advertise', { title: 'x'.repeat(81) })
      await tick()
      assert.equal(s.lastError.message, 'lobby-title-invalid')
      s.send('lobby:advertise', { title: 42 })
      await tick()
      assert.equal(s.lastError.message, 'lobby-title-invalid')
      assert.deepEqual(recu, [])
      s.destroy(); await app.stop()
    })

    it("27. retirer — SA PROPRE annonce (id omis), retrait diffusé", async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l27z', zora)
      const sT = connect(transport, 'memory://l27t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const recuAnnT: any[] = []; const recuRetT: any[] = []
      sT.on('lobby:listing', (p: any) => recuAnnT.push(p))
      sT.on('lobby:withdrawn', (p: any) => recuRetT.push(p))
      sZ.send('lobby:advertise', { title: 'Partie' })
      await tick()
      sZ.send('lobby:withdraw', {})
      await tick()
      assert.equal(recuRetT.length, 1)
      assert.equal(recuRetT[0].id, recuAnnT[0].id)
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it("28. retirer — un modérateur retire l'annonce d'un AUTRE (id explicite)", async () => {
      const moderators = (identity: any) => identity?.id === zora.id
      const { transport, app } = await startApp({ moderators })
      const sZ = connect(transport, 'memory://l28z', zora)
      const sT = connect(transport, 'memory://l28t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const recuAnnZ: any[] = []; const recuRetZ: any[] = []
      sZ.on('lobby:listing', (p: any) => recuAnnZ.push(p))
      sZ.on('lobby:withdrawn', (p: any) => recuRetZ.push(p))
      sT.send('lobby:advertise', { title: 'Table de Theo' })
      await tick()
      sZ.send('lobby:withdraw', { id: recuAnnZ[0].id })   // Zora (modératrice) retire l'annonce de Theo
      await tick()
      assert.equal(recuRetZ.length, 1)
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it("29. retirer — refusé si ni propriétaire ni modérateur (lobby-denied), annonce intacte", async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l29z', zora)
      const sT = connect(transport, 'memory://l29t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const recuAnnT: any[] = []
      sT.on('lobby:listing', (p: any) => recuAnnT.push(p))
      sZ.send('lobby:advertise', { title: 'Table de Zora' })
      await tick()
      sT.send('lobby:withdraw', { id: recuAnnT[0].id })   // Theo n'est ni propriétaire ni modérateur
      await tick()
      assert.equal(sT.lastError.message, 'lobby-denied')
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it("30. retirer — annonce inconnue ou déjà retirée → lobby-listing-unknown", async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://l30', zora)
      joinHall(s); await tick()
      await entrer(s)
      s.send('lobby:withdraw', {})   // AUCUNE annonce active
      await tick()
      assert.equal(s.lastError.message, 'lobby-listing-unknown')
      s.send('lobby:withdraw', { id: 'jamais-vu' })
      await tick()
      assert.equal(s.lastError.message, 'lobby-listing-unknown')
      s.destroy(); await app.stop()
    })

    it('31. TTL — annonce expirée disparaît au balayage, retrait diffusé', async () => {
      const { transport, app } = await startApp({ listingTtlMs: 10 })
      const sZ = connect(transport, 'memory://l31z', zora)
      const sT = connect(transport, 'memory://l31t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const recuRetT: any[] = []
      sT.on('lobby:withdrawn', (p: any) => recuRetT.push(p))
      const recuAnnT: any[] = []
      sT.on('lobby:listing', (p: any) => recuAnnT.push(p))
      sZ.send('lobby:advertise', { title: 'Éphémère' })
      await tick(20)   // > TTL (10ms)
      await declencherBalayageGlobal(transport)
      assert.equal(recuRetT.length, 1)
      assert.equal(recuRetT[0].id, recuAnnT[0].id)
      sZ.destroy(); sT.destroy(); await app.stop()
    })
  })

  describe("rejoindre — notifie l'annonceur, renvoie l'annonce, crochet onRejoindre", () => {
    it("32. rejoindre — l'annonceur reçoit lobby:applicant, le demandeur reçoit l'annonce (lobby:listing direct)", async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l32z', zora)
      const sT = connect(transport, 'memory://l32t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const recuAnnZ: any[] = []; const recuCandidatZ: any[] = []; const recuAnnT: any[] = []
      sZ.on('lobby:listing', (p: any) => recuAnnZ.push(p))
      sZ.on('lobby:applicant', (p: any) => recuCandidatZ.push(p))
      sZ.send('lobby:advertise', { title: 'Table de Zora', seats: 4 })
      await tick()
      sT.on('lobby:listing', (p: any) => recuAnnT.push(p))

      sT.send('lobby:join', { id: recuAnnZ[0].id })
      await tick()

      assert.equal(recuCandidatZ.length, 1, "l'annonceur est notifié")
      assert.deepEqual(recuCandidatZ[0].from, { id: '2', name: 'Theo' })
      assert.equal(recuAnnT.length, 1, "l'annonce est renvoyée DIRECTEMENT au demandeur")
      assert.equal(recuAnnT[0].id, recuAnnZ[0].id)
      assert.equal(recuAnnT[0].title, 'Table de Zora')
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('33. onRejoindre(ctx) — appelé avec {annonce, client, identity} corrects', async () => {
      const appels: any[] = []
      const { transport, app } = await startApp({ onJoin: (ctx) => { appels.push(ctx) } })
      const sZ = connect(transport, 'memory://l33z', zora)
      const sT = connect(transport, 'memory://l33t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const recuAnnZ: any[] = []
      sZ.on('lobby:listing', (p: any) => recuAnnZ.push(p))
      sZ.send('lobby:advertise', { title: 'Table' })
      await tick()
      sT.send('lobby:join', { id: recuAnnZ[0].id })
      await tick()

      assert.equal(appels.length, 1)
      assert.equal(appels[0].listing.id, recuAnnZ[0].id)
      assert.equal(appels[0].listing.title, 'Table')
      assert.deepEqual(appels[0].identity, theo)
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('34. onRejoindre qui lève ne bloque NI la notification NI le renvoi de l\'listing', async () => {
      const { transport, app } = await startApp({ onJoin: () => { throw new Error('boom applicatif') } })
      const sZ = connect(transport, 'memory://l34z', zora)
      const sT = connect(transport, 'memory://l34t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const recuAnnZ: any[] = []; const recuCandidatZ: any[] = []; const recuAnnT: any[] = []
      sZ.on('lobby:listing', (p: any) => recuAnnZ.push(p))
      sZ.on('lobby:applicant', (p: any) => recuCandidatZ.push(p))
      sZ.send('lobby:advertise', { title: 'Table' })
      await tick()
      sT.on('lobby:listing', (p: any) => recuAnnT.push(p))
      sT.send('lobby:join', { id: recuAnnZ[0].id })
      await tick()
      assert.equal(recuCandidatZ.length, 1, 'notification envoyée malgré le crochet qui lève')
      assert.equal(recuAnnT.length, 1, 'listing renvoyée malgré le crochet qui lève')
      sZ.destroy(); sT.destroy(); await app.stop()
    })

    it('35. rejoindre — annonce inconnue → lobby-listing-unknown', async () => {
      const { transport, app } = await startApp()
      const s = connect(transport, 'memory://l35', zora)
      joinHall(s); await tick()
      await entrer(s)
      s.send('lobby:join', { id: 'jamais-vu' })
      await tick()
      assert.equal(s.lastError.message, 'lobby-listing-unknown')
      s.destroy(); await app.stop()
    })
  })

  describe('départ — dernière connexion quitte le hall (nettoyage au balayage)', () => {
    it("36. présence retirée (lobby:left diffusé) quand la DERNIÈRE connexion part", async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l36z', zora)
      const sT = connect(transport, 'memory://l36t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      const partisT: any[] = []
      sT.on('lobby:left', (p: any) => partisT.push(p))

      sZ.destroy(); await tick()   // Zora quitte pour de bon (dernière et unique connexion)
      await declencherBalayageGlobal(transport)

      assert.deepEqual(partisT, [{ hall: 'hall', id: '1' }])
      sT.destroy(); await app.stop()
    })

    it("37. annonces de l'identité retirées quand sa DERNIÈRE connexion quitte", async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l37z', zora)
      const sT = connect(transport, 'memory://l37t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      sZ.send('lobby:advertise', { title: 'Table de Zora' })
      await tick()
      const recuRetT: any[] = []
      sT.on('lobby:withdrawn', (p: any) => recuRetT.push(p))

      sZ.destroy(); await tick()
      await declencherBalayageGlobal(transport)

      assert.equal(recuRetT.length, 1, "l'annonce de Zora est retirée quand elle part")
      sT.destroy(); await app.stop()
    })

    it("38. 2 onglets — départ du 1er ne retire RIEN (identité toujours présente via le 2e)", async () => {
      const { transport, app } = await startApp()
      const sZ1 = connect(transport, 'memory://l38z1', zora)
      const sZ2 = connect(transport, 'memory://l38z2', zora)
      const sT  = connect(transport, 'memory://l38t', theo)
      joinHall(sZ1); joinHall(sZ2); joinHall(sT); await tick()
      await entrer(sZ1); await entrer(sZ2); await entrer(sT)
      const partisT: any[] = []
      sT.on('lobby:left', (p: any) => partisT.push(p))

      sZ1.destroy(); await tick()   // le 1er onglet ferme — Zora reste connectée via sZ2
      await declencherBalayageGlobal(transport)

      assert.deepEqual(partisT, [], 'Zora encore présente via son 2e onglet — aucun départ')
      sZ2.destroy(); sT.destroy(); await app.stop()
    })

    it('39. invitations pendantes purgées quand une des deux parties quitte définitivement', async () => {
      const { transport, app, pkg } = await startApp()
      const sZ = connect(transport, 'memory://l39z', zora)
      const sT = connect(transport, 'memory://l39t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      sZ.send('lobby:invite', { identityId: theo.id })
      await tick()
      assert.equal((pkg as any)._invitations.get('lobby:hall').size, 1, "l'invitation est bien enregistrée")

      sZ.destroy(); await tick()   // le demandeur part définitivement
      await declencherBalayageGlobal(transport)

      assert.equal((pkg as any)._invitations.get('lobby:hall'), undefined, "sous-Map du hall réclamée — plus aucune invitation en attente")
      sT.destroy(); await app.stop()
    })
  })

  describe('mémoire bornée — Maps purgées au balayage', () => {
    it('40. hall totalement vidé → _presence/_listings/_invitations perdent la clé du hall', async () => {
      const { transport, app, pkg } = await startApp()
      const sZ = connect(transport, 'memory://l40z', zora)
      const sT = connect(transport, 'memory://l40t', theo)
      joinHall(sZ); joinHall(sT); await tick()
      await entrer(sZ); await entrer(sT)
      sZ.send('lobby:advertise', { title: 'Table' })
      await tick()
      sT.send('lobby:invite', { identityId: zora.id })
      await tick()
      assert.ok((pkg as any)._presence.get('lobby:hall'))
      assert.ok((pkg as any)._listings.get('lobby:hall'))
      assert.ok((pkg as any)._invitations.get('lobby:hall'))

      sZ.destroy(); sT.destroy(); await tick()   // le hall se vide ENTIÈREMENT
      await declencherBalayageGlobal(transport)

      assert.equal((pkg as any)._presence.get('lobby:hall'), undefined)
      assert.equal((pkg as any)._listings.get('lobby:hall'), undefined)
      assert.equal((pkg as any)._invitations.get('lobby:hall'), undefined)
      await app.stop()
    })
  })

  describe('multi-halls isolés', () => {
    it("41. 2 halls isolés — présence/annonces d'un hall n'affectent pas l'autre", async () => {
      const { transport, app } = await startApp()
      const sZ = connect(transport, 'memory://l41z', zora)   // hall 'hall' (défaut)
      const sT = connect(transport, 'memory://l41t', theo)   // hall 'vip'
      joinHall(sZ, 'hall'); joinHall(sT, 'vip'); await tick()
      const resZ = await entrer(sZ, 'hall')
      const resT = await entrer(sT, 'vip')
      assert.deepEqual(resZ.members.map((p: any) => p.id), ['1'], "Zora ne voit qu'elle-même dans 'hall' (Theo est dans 'vip')")
      assert.deepEqual(resT.members.map((p: any) => p.id), ['2'], "Theo ne voit qu'elle-même dans 'vip'")

      const recuAnnT: any[] = []
      sT.on('lobby:listing', (p: any) => recuAnnT.push(p))
      sZ.send('lobby:advertise', { hall: 'hall', title: 'Table du hall par défaut' })
      await tick()
      assert.deepEqual(recuAnnT, [], "l'annonce du hall 'hall' ne fuite pas vers 'vip'")

      assert.equal(app.room('lobby:hall').size, 1)
      assert.equal(app.room('lobby:vip').size, 1)
      sZ.destroy(); sT.destroy(); await app.stop()
    })
  })
})
