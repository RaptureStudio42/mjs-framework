// theme-edit-live — aperçu de thème EN DIRECT (atelier /__mjs/theme, chantier 21/09).
// L'atelier POSTe une couleur sur /__mjs/theme/edit, le serveur la diffuse aux pages ouvertes
// par le canal HMR ('theme-vars'), et RIEN n'est écrit sur le disque. Trois contrats couverts :
//   - le préfixe `varPrefix` est appliqué PAR LE SERVEUR (seul à le connaître sans le deviner) ;
//   - le crible de valeurs est une liste BLANCHE de formes de couleur — une valeur qui pourrait
//     refermer la déclaration CSS, ou déclencher une requête réseau, est refusée ET NOMMÉE dans
//     la réponse (un refus muet ressemblerait à une couleur sans effet) ;
//   - même garde de production que l'atelier lui-même : 404, jamais 403.

import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { StaticServer } from '../src/server/index.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

after(() => sweepRegistered())

function devServer(rootDir: string, opts: Record<string, unknown> = {}) {
  return new StaticServer({ rootDir, port: 0, host: '127.0.0.1', hmr: true, ...opts })
}

const portDe = (s: StaticServer) => (s.server!.address() as any).port

/** Ouvre un client HMR et rend une promesse du PREMIER message 'theme-vars' reçu
 *  (les 'connected' du handshake sont sautés). */
function ecouteThemeVars(port: number): Promise<{ pret: Promise<unknown>, recu: Promise<any>, ws: WebSocket }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/__mjs_hmr`)
  const pret = new Promise((ok) => ws.on('open', ok))
  const recu = new Promise<any>((ok) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      if (msg.type === 'theme-vars') ok(msg)
    })
  })
  return Promise.resolve({ pret, recu, ws })
}

describe('POST /__mjs/theme/edit — aperçu de thème en direct', () => {
  it('diffuse la couleur aux pages ouvertes, PRÉFIXÉE par le serveur', async function () {
    this.timeout(15000)
    const server = devServer(mjsTmp('theme-edit-diffuse'))
    await server.start()
    const port = portDe(server)
    const { pret, recu, ws } = await ecouteThemeVars(port)
    try {
      await pret
      const res = await fetch(`http://127.0.0.1:${port}/__mjs/theme/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars: { accent: '#ff0000' } }),
      })
      assert.equal(res.status, 200)
      const corps = await res.json() as any
      assert.equal(corps.applied, 1)
      assert.deepEqual(corps.rejected, [])
      assert.equal(corps.clients, 1, 'la page ouverte est comptée')

      const msg = await recu
      // varPrefix par défaut = 'mjs' (cf. bundler/config.ts) — le nom NU part de l'atelier,
      // le nom PRÉFIXÉ arrive à la page.
      assert.deepEqual(msg.themeVars, { '--mjs-accent': '#ff0000' })
    } finally {
      ws.close()
      await server.stop()
    }
  })

  it('un url() NICHÉ dans une fonction admise est refusé, pas seulement en tête (trouvé 23/09)', async function () {
    this.timeout(15000)
    // même trou que /write (cf. theme-write.test.ts) : un url() en tête était déjà refusé, mais
    // niché dans var()/color-mix() la classe de caractères du crible le laissait passer — ici,
    // ça diffuse la requête réseau à TOUTES les pages de dev ouvertes plutôt que de l'écrire au
    // disque, mais le déclenchement réseau est le même.
    const server = devServer(mjsTmp('theme-edit-url-niche'))
    await server.start()
    const port = portDe(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/__mjs/theme/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars: {
          a: 'var(--x,url(//exemple.test/a))',
          b: 'color-mix(in srgb, url(//exemple.test/a) 50%, red)',
        } }),
      })
      const corps = await res.json() as any
      assert.equal(corps.applied, 0)
      assert.deepEqual(corps.rejected.sort(), ['a', 'b'])
    } finally {
      await server.stop()
    }
  })

  it('applique le varPrefix de la config, pas un « mjs » codé en dur', async function () {
    this.timeout(15000)
    const server = devServer(mjsTmp('theme-edit-prefixe'), { config: { varPrefix: 'acme' } })
    await server.start()
    const port = portDe(server)
    const { pret, recu, ws } = await ecouteThemeVars(port)
    try {
      await pret
      await fetch(`http://127.0.0.1:${port}/__mjs/theme/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars: { brand: '#0f0' } }),
      })
      const msg = await recu
      assert.deepEqual(msg.themeVars, { '--acme-brand': '#0f0' })
    } finally {
      ws.close()
      await server.stop()
    }
  })

  it('refuse ce qui n\'est pas une couleur, le NOMME, et ne diffuse rien', async function () {
    this.timeout(15000)
    const server = devServer(mjsTmp('theme-edit-crible'))
    await server.start()
    const port = portDe(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/__mjs/theme/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars: {
          injection: 'red;} body{display:none}',   // sortirait de la déclaration
          reseau:    'url(//exemple.test/x)',      // pas une couleur : requête réseau
          'a b':     '#fff',                       // nom hors VAR_ID_RE
          trop:      'a'.repeat(65),               // au-delà du plafond
          bonne:     '#abcdef',                    // la seule légitime
        } }),
      })
      const corps = await res.json() as any
      assert.equal(corps.applied, 1, 'une seule entrée retenue')
      assert.deepEqual(corps.rejected.sort(), ['a b', 'injection', 'reseau', 'trop'])
    } finally {
      await server.stop()
    }
  })

  it('une valeur vide RETIRE la surcharge — c\'est une valeur légale, pas un refus', async function () {
    this.timeout(15000)
    const server = devServer(mjsTmp('theme-edit-retrait'))
    await server.start()
    const port = portDe(server)
    const { pret, recu, ws } = await ecouteThemeVars(port)
    try {
      await pret
      const res = await fetch(`http://127.0.0.1:${port}/__mjs/theme/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars: { accent: '' } }),
      })
      assert.deepEqual((await res.json() as any).rejected, [])
      assert.deepEqual((await recu).themeVars, { '--mjs-accent': '' })
    } finally {
      ws.close()
      await server.stop()
    }
  })

  it('GET rend l\'état du direct : canal ouvert et nombre de pages à l\'écoute', async function () {
    this.timeout(15000)
    const server = devServer(mjsTmp('theme-edit-etat'))
    await server.start()
    const port = portDe(server)
    try {
      const vide = await (await fetch(`http://127.0.0.1:${port}/__mjs/theme/edit`)).json() as any
      assert.equal(vide.live, true)
      assert.equal(vide.clients, 0, 'aucune page ouverte')
      assert.equal(vide.varPrefix, 'mjs')

      const { pret, ws } = await ecouteThemeVars(port)
      await pret
      const avec = await (await fetch(`http://127.0.0.1:${port}/__mjs/theme/edit`)).json() as any
      assert.equal(avec.clients, 1)
      ws.close()
    } finally {
      await server.stop()
    }
  })

  it('404 en production — outil de développement uniquement, jamais 403', async function () {
    this.timeout(15000)
    const server = devServer(mjsTmp('theme-edit-prod'), { env: 'prod' })
    await server.start()
    const port = portDe(server)
    try {
      const get = await fetch(`http://127.0.0.1:${port}/__mjs/theme/edit`)
      assert.equal(get.status, 404)
      const post = await fetch(`http://127.0.0.1:${port}/__mjs/theme/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars: { accent: '#fff' } }),
      })
      assert.equal(post.status, 404)
    } finally {
      await server.stop()
    }
  })
})
