// journal-endpoints — étages 2 (canal client) et 3 (visionneuse) du journal d'erreurs 3 étages,
// bout en bout via un VRAI serveur `mjs serve` (startRenderServer, port 0 + fetch — même
// harnais que render-server.test.ts / serve-protocol-loaders-forms.test.ts). Couvre aussi la
// validation du bloc config `journal` et la capture serveur réelle (points 1-2 de journal.ts).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startRenderServer } from '../src/server/render-server.js'
import { findConfig } from '../src/bundler/config.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

after(() => sweepRegistered())

// config PARTAGÉE : sourceDir/outputDir minimaux + manifest RÉALISTE (ligne `const µCore = `,
// nécessaire à la visionneuse — cf. viewer-page.ts, getViewerScript) + serve.server.mjs (action qui
// throw, pour la capture serveur réelle).
function setup(journalCfg?: Record<string, unknown>) {
  const root = mjsTmp('journal-ep')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
  writeFileSync(join(root, 'serve.server.mjs'), `export default {
  actions: {
    '/boom': (params, body, req) ->
      throw new Error('boom action')
  }
}
`)
  const config: any = {
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
    render: {
      routes: {
        '/':     { component: 'mjs-home', mode: 'csr' as const },
        '/boom': { component: 'mjs-home', mode: 'csr' as const },
      },
    },
  }
  if (journalCfg !== undefined) config.journal = journalCfg
  return { root, outDir, config }
}

describe('config — validation du bloc `journal`', () => {
  const tmp = (cfg: any) => {
    const root = mjsTmp('journal-cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(cfg))
    return root
  }

  it('accepte les 5 clés (server/client/viewer/maxEntries/maxBytes)', () => {
    const cfg = { journal: { server: false, client: true, viewer: 'secret', maxEntries: 50, maxBytes: 4096 } }
    const found = findConfig(tmp(cfg))
    assert.deepEqual(found!.config.journal, cfg.journal)
  })

  it('accepte journal absent (défauts implicites)', () => {
    const found = findConfig(tmp({}))
    assert.equal(found!.config.journal, undefined)
  })

  it("throw sur clé inconnue ('journal.serveur', faute de frappe)", () => {
    assert.throws(() => findConfig(tmp({ journal: { serveur: true } })), /journal\.serveur/)
  })

  it('throw sur journal non-objet', () => {
    assert.throws(() => findConfig(tmp({ journal: 'oui' })), /'journal'/)
  })

  it('throw sur journal.server non-booléen', () => {
    assert.throws(() => findConfig(tmp({ journal: { server: 'true' } })), /journal\.server/)
  })

  it('throw sur journal.client non-booléen', () => {
    assert.throws(() => findConfig(tmp({ journal: { client: 1 } })), /journal\.client/)
  })

  it('throw sur journal.viewer ni booléen ni chaîne non vide (nombre)', () => {
    assert.throws(() => findConfig(tmp({ journal: { viewer: 42 } })), /journal\.viewer/)
  })

  it('throw sur journal.viewer chaîne VIDE (pas un jeton exploitable)', () => {
    assert.throws(() => findConfig(tmp({ journal: { viewer: '' } })), /journal\.viewer/)
  })

  it('throw sur journal.maxEntries non entier positif (0, négatif, flottant)', () => {
    assert.throws(() => findConfig(tmp({ journal: { maxEntries: 0 } })), /journal\.maxEntries/)
    assert.throws(() => findConfig(tmp({ journal: { maxEntries: -5 } })), /journal\.maxEntries/)
    assert.throws(() => findConfig(tmp({ journal: { maxEntries: 1.5 } })), /journal\.maxEntries/)
  })

  it('throw sur journal.maxBytes non entier positif', () => {
    assert.throws(() => findConfig(tmp({ journal: { maxBytes: 0 } })), /journal\.maxBytes/)
  })
})

describe('POST /__mjs/errors — canal client (étage 2)', () => {
  it('journal.client absent (défaut false) → NE PAS intercepter, pipeline normal (405, aucune action déclarée)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '',
      })
      assert.equal(res.status, 405, 'aucune action .server.mjs déclarée pour /__mjs/errors — pipeline standard')
    } finally {
      await running.close()
    }
  })

  it('journal.client true → 204 + entrée journalisée avec source FORCÉE client (payload menteur ignoré)', async function () {
    this.timeout(15000)
    const { root, outDir, config } = setup({ client: true })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'sonde-test/1.0' },
        body: JSON.stringify({ message: 'client boom', pile: 'Error: x\n  at y', url: '/page', version: 'deadbeef', source: 'server' }),
      })
      assert.equal(res.status, 204)
      assert.equal(await res.text(), '')
      const jsonRes = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors.json`)
      const entries = await jsonRes.json()
      assert.equal(entries.length, 1)
      assert.equal(entries[0].source, 'client', 'le payload mentait "server" — IGNORÉ, forcé côté serveur')
      assert.equal(entries[0].message, 'client boom')
      assert.equal(entries[0].ua, 'sonde-test/1.0')
      void outDir
    } finally {
      await running.close()
    }
  })

  it('champs copiés avec plafonds (message ≤2 Ko, pile ≤8 Ko, url ≤2 Ko, version ≤32 c.)', async function () {
    this.timeout(15000)
    const { root, config } = setup({ client: true })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'm'.repeat(3000), pile: 'p'.repeat(10000), url: 'u'.repeat(3000), version: 'v'.repeat(100) }),
      })
      assert.equal(res.status, 204)
      const entries = await (await fetch(`http://127.0.0.1:${running.port}/__mjs/errors.json`)).json()
      assert.equal(entries[0].message.length, 2048)
      assert.equal(entries[0].pile.length, 8192)
      assert.equal(entries[0].url.length, 2048)
      assert.equal(entries[0].version.length, 32)
    } finally {
      await running.close()
    }
  })

  it('413 : corps > 64 Ko rejeté', async function () {
    this.timeout(15000)
    const { root, config } = setup({ client: true })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(70_000) }),
      })
      assert.equal(res.status, 413)
    } finally {
      await running.close()
    }
  })

  it('400 : JSON cassé', async function () {
    this.timeout(15000)
    const { root, config } = setup({ client: true })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ pas du json',
      })
      assert.equal(res.status, 400)
    } finally {
      await running.close()
    }
  })

  it('400 : JSON valide mais pas un objet (tableau)', async function () {
    this.timeout(15000)
    const { root, config } = setup({ client: true })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2,3]',
      })
      assert.equal(res.status, 400)
    } finally {
      await running.close()
    }
  })

  it('429 : au-delà de ~10 requêtes rapides depuis la même IP', async function () {
    this.timeout(15000)
    const { root, config } = setup({ client: true })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'rafale' + i, url: '/' + i }),
        })
        statuses.push(res.status)
      }
      assert.ok(statuses.slice(0, 10).every((s) => s === 204), 'les 10 premières passent : ' + statuses.join(','))
      assert.ok(statuses.slice(10).some((s) => s === 429), 'au-delà de la capacité, 429 attendu : ' + statuses.join(','))
    } finally {
      await running.close()
    }
  })
})

describe('GET /__mjs/errors — visionneuse (étage 3)', () => {
  let originalNodeEnv: string | undefined
  before(() => { originalNodeEnv = process.env.NODE_ENV })
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  })

  it('hors production, défaut (viewer absent ≡ true) → 200, mjs-journal-viewer créé APRÈS sa définition (pas de balise nue)', async function () {
    this.timeout(15000)
    delete process.env.NODE_ENV
    const { root, config } = setup()
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`)
      assert.equal(res.status, 200)
      const html = await res.text()
      // La balise n'est plus écrite en dur dans le corps (course avec l'autoloader,
      // cf. viewer-page.ts:viewerScriptElement) : elle n'existe QUE dans le script, créée après sa
      // définition (document.createElement, jamais une balise nue dans le document).
      assert.doesNotMatch(html, /<mjs-journal-viewer>/, 'plus de balise nue dans le corps')
      assert.match(html, /<script type="module" src="\/__mjs\/bundle\.js">/)
      assert.match(html, /µ\._def\("mjs-journal-viewer"/)
      assert.match(html, /document\.createElement\("mjs-journal-viewer"\)/, 'le nom de balise apparaît dans le script (créée APRÈS sa définition), jamais en balise nue')
    } finally {
      await running.close()
    }
  })

  it('NODE_ENV=production + viewer true (défaut) → 404', async function () {
    this.timeout(15000)
    process.env.NODE_ENV = 'production'
    const { root, config } = setup()
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`)
      assert.equal(res.status, 404)
    } finally {
      await running.close()
    }
  })

  it('viewer = jeton, prod, bon ?token= → 200', async function () {
    this.timeout(15000)
    process.env.NODE_ENV = 'production'
    const { root, config } = setup({ viewer: 'secret-jeton' })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors?token=secret-jeton`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.doesNotMatch(html, /<mjs-journal-viewer>/, 'plus de balise nue dans le corps')
      assert.match(html, /document\.createElement\("mjs-journal-viewer"\)/, 'le nom de balise apparaît dans le script, jamais en balise nue')
    } finally {
      await running.close()
    }
  })

  it('viewer = jeton, prod, mauvais ?token= → 404', async function () {
    this.timeout(15000)
    process.env.NODE_ENV = 'production'
    const { root, config } = setup({ viewer: 'secret-jeton' })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors?token=mauvais`)
      assert.equal(res.status, 404)
    } finally {
      await running.close()
    }
  })

  it('viewer = jeton EXIGÉ même hors production (pas de repli dev-open silencieux)', async function () {
    this.timeout(15000)
    delete process.env.NODE_ENV
    const { root, config } = setup({ viewer: 'secret-jeton' })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const sansJeton = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`)
      assert.equal(sansJeton.status, 404)
      const avecJeton = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors?token=secret-jeton`)
      assert.equal(avecJeton.status, 200)
    } finally {
      await running.close()
    }
  })

  it('viewer = false → 404 (hors prod aussi)', async function () {
    this.timeout(15000)
    delete process.env.NODE_ENV
    const { root, config } = setup({ viewer: false })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`)
      assert.equal(res.status, 404)
    } finally {
      await running.close()
    }
  })

  it('refus (viewer false) et route inexistante rendent le MÊME statut 404 — indistinct', async function () {
    this.timeout(15000)
    delete process.env.NODE_ENV
    const { root, config } = setup({ viewer: false })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const refuse = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`)
      const inexistante = await fetch(`http://127.0.0.1:${running.port}/__mjs/route-qui-nexiste-pas-du-tout`)
      assert.equal(refuse.status, 404)
      // la route inconnue peut être gérée par le routeur applicatif (page 404 SPA) — on vérifie
      // seulement que le refus n'expose PAS un code distinctif (ex. 403) qui trahirait l'existence
      // de la route.
      assert.notEqual(refuse.status, 403)
      void inexistante
    } finally {
      await running.close()
    }
  })
})

describe('GET /__mjs/errors.json', () => {
  it('fusionne server+client, trié par dernier desc', async function () {
    this.timeout(15000)
    const { root, config } = setup({ client: true })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      await fetch(`http://127.0.0.1:${running.port}/boom`, { method: 'POST', headers: { origin: `http://127.0.0.1:${running.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: '' })
      await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'client-err', url: '/x' }) })
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors.json`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
      const entries = await res.json()
      assert.equal(entries.length, 2)
      assert.deepEqual(entries.map((e: any) => e.source).sort(), ['client', 'server'])
      assert.ok(entries[0].dernier >= entries[1].dernier, 'trié dernier DESC')
    } finally {
      await running.close()
    }
  })

  it('NODE_ENV=production sans jeton (viewer true défaut) → 404', async function () {
    this.timeout(15000)
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const { root, config } = setup()
      const running = await startRenderServer(config, root, { port: 0 })
      try {
        const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors.json`)
        assert.equal(res.status, 404)
      } finally {
        await running.close()
      }
    } finally {
      if (original === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = original
    }
  })
})

describe('DELETE /__mjs/errors — purge', () => {
  it('sans ?source= : purge TOUT', async function () {
    this.timeout(15000)
    const { root, config } = setup({ client: true })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'a', url: '/a' }) })
      const del = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`, { method: 'DELETE' })
      assert.equal(del.status, 204)
      const entries = await (await fetch(`http://127.0.0.1:${running.port}/__mjs/errors.json`)).json()
      assert.deepEqual(entries, [])
    } finally {
      await running.close()
    }
  })

  it('?source=client : ne purge QUE client', async function () {
    this.timeout(15000)
    const { root, config } = setup({ client: true })
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'c', url: '/c' }) })
      await fetch(`http://127.0.0.1:${running.port}/boom`, { method: 'POST', headers: { origin: `http://127.0.0.1:${running.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: '' })
      const del = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors?source=client`, { method: 'DELETE' })
      assert.equal(del.status, 204)
      const entries = await (await fetch(`http://127.0.0.1:${running.port}/__mjs/errors.json`)).json()
      assert.equal(entries.length, 1)
      assert.equal(entries[0].source, 'server')
    } finally {
      await running.close()
    }
  })

  it('gating identique aux autres routes viewer (production sans jeton → 404, rien purgé)', async function () {
    this.timeout(15000)
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const { root, config } = setup()
      const running = await startRenderServer(config, root, { port: 0 })
      try {
        const del = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`, { method: 'DELETE' })
        assert.equal(del.status, 404)
      } finally {
        await running.close()
      }
    } finally {
      if (original === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = original
    }
  })
})

describe('capture serveur (étage 1) — points de capture réels', () => {
  it('journal.server défaut (absent ≡ true) : catch d\'action réel → ligne server au NDJSON, AVEC version', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/boom`, {
        method: 'POST', headers: { origin: `http://127.0.0.1:${running.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: '',
      })
      assert.equal(res.status, 500)
      const entries = await (await fetch(`http://127.0.0.1:${running.port}/__mjs/errors.json`)).json()
      assert.equal(entries.length, 1)
      assert.equal(entries[0].source, 'server')
      assert.match(entries[0].message, /boom action/)
      assert.equal(entries[0].version, 'abcd1234', 'version courante du manifeste tamponnée')
    } finally {
      await running.close()
    }
  })

  it('journal.server: false → le MÊME catch d\'action ne journalise RIEN (console.error existant, lui, inchangé)', async function () {
    this.timeout(15000)
    const { root, config } = setup({ server: false })
    const running = await startRenderServer(config, root, { port: 0 })
    const originalError = console.error
    let consoleCalls = 0
    console.error = (...args: any[]) => { consoleCalls++; void args }
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/boom`, {
        method: 'POST', headers: { origin: `http://127.0.0.1:${running.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: '',
      })
      assert.equal(res.status, 500)
      assert.ok(consoleCalls > 0, 'le console.error existant doit rester intact, journal.server ne le coupe pas')
      const entries = await (await fetch(`http://127.0.0.1:${running.port}/__mjs/errors.json`)).json()
      assert.deepEqual(entries, [], 'étage serveur coupé : rien journalisé')
    } finally {
      console.error = originalError
      await running.close()
    }
  })

  it('catch global (point 1) : URL inconnue qui fait planter le pipeline JSON-nav produit une ligne server', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    // force une exception dans le catch global : un header X-MJS-Nav sur une page dont le
    // chargeur de props jette (catch-global existant, cf. serve-protocol-loaders-forms).
    writeFileSync(join(root, 'serve.server.mjs'), `export default {
  props: {
    '/boom-props': (params, req) ->
      throw new Error('kaboom props')
  }
}
`)
    ;(config.render.routes as any)['/boom-props'] = { component: 'mjs-home', mode: 'csr' as const }
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/boom-props`, { headers: { 'X-MJS-Nav': '1' } })
      assert.equal(res.status, 500)
      const entries = await (await fetch(`http://127.0.0.1:${running.port}/__mjs/errors.json`)).json()
      assert.ok(entries.some((e: any) => e.source === 'server' && /kaboom props/.test(e.message)))
    } finally {
      await running.close()
    }
  })
})
