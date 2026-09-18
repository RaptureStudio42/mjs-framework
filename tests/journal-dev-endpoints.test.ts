// journal-dev-endpoints — les 4 routes du journal d'erreurs 3 étages côté `mjs dev`
// (StaticServer, server/index.ts) — jusqu'ici câblées SEULEMENT dans `mjs serve` (render-server.ts,
// cf. tests/journal-endpoints.test.ts). Calque tests/theme-endpoints.test.ts (même famille : POST/
// GET/GET.json/DELETE + gating client/viewer) pour le côté StaticServer + tests/render-request-xss-
// escaping.test.ts pour la technique d'erreur SSR RÉELLE (composant introuvable, déclenche à coup
// sûr le catch de render-request.ts).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { StaticServer } from '../src/server/index.js'
import { createRenderHandler, type RenderHandler } from '../src/server/render-request.js'
import { createJournal, type RecordServerFn } from '../src/server/journal.js'
import { readBuildVersion } from '../src/server/build-version.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

after(() => sweepRegistered())
after(async () => { await terminateSharedWorkerPool() })

// config PARTAGÉE (même forme que journal-endpoints.test.ts/theme-endpoints.test.ts) : sourceDir/
// outputDir minimaux + manifest RÉALISTE (ligne `const µCore = `, nécessaire à la visionneuse).
function setup() {
  const root   = mjsTmp('journal-dev-ep')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
  const config: any = {
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
    render: { routes: { '/': { component: 'mjs-home', mode: 'csr' as const } } },
  }
  return { root, outDir, config }
}

// démarre un StaticServer avec le magasin du journal câblé EXACTEMENT comme cli.ts (case 'dev') :
// createJournal + recordServer PRÉ-GATÉ passés à createRenderHandler, magasin passé tel
// quel à StaticServer. `withRender: false` simule un mjs.config.json SANS bloc `render` — seul le
// `renderHandle` disparaît alors : `manifestPath` reste passé, comme le fait cli.ts
// (le bundler écrit le manifeste dans TOUS les cas). Le `version` du recordServer suit lui aussi
// cli.ts à la lettre — sans ça, le tag de version des entrées serveur serait testé sur un câblage
// qui n'existe nulle part en vrai.
async function startDev(config: any, root: string, withRender = true) {
  const journalCfg    = config.journal
  const manifestPath  = join(root, 'out', 'manifest.js')
  const journalStore  = createJournal({ dir: join(root, 'log'), maxEntries: journalCfg?.maxEntries, maxBytes: journalCfg?.maxBytes })
  const recordServer: RecordServerFn = journalCfg?.server !== false ? (input) => journalStore.record('server', { ...input, version: readBuildVersion(manifestPath) }) : () => {}
  const serverOpts: any = { rootDir: join(root, 'out'), port: 0, host: '127.0.0.1', journal: journalStore, config, configDir: root, manifestPath }
  let handler: RenderHandler | null = null
  if (withRender) {
    handler = await createRenderHandler(config, root, recordServer)
    serverOpts.renderHandle = handler.handle
  }
  const server = new StaticServer(serverOpts)
  await server.start()
  const port = (server.server!.address() as any).port
  return {
    port, journalStore,
    close: async () => { await server.stop(); if (handler) await handler.close() },
  }
}

describe('POST /__mjs/errors (mjs dev) — étage 2, canal client', () => {
  it('journal.client absent → 404 (route interceptée avant le pipeline d\'actions, jamais un 405 de repli)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    try {
      const res = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x' }),
      })
      assert.equal(res.status, 404)
    } finally {
      await dev.close()
    }
  })

  it('journal.client: false (explicite) → 404 aussi', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    config.journal = { client: false }
    const dev = await startDev(config, root)
    try {
      const res = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x' }),
      })
      assert.equal(res.status, 404)
    } finally {
      await dev.close()
    }
  })

  it('journal.client: true → 204 + entrée journalisée, relisible par .json (source FORCÉE client)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    config.journal = { client: true }
    const dev = await startDev(config, root)
    try {
      const res = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'sonde-dev/1.0' },
        body: JSON.stringify({ message: 'client boom (dev)', pile: 'Error: x\n  at y', url: '/page', version: 'deadbeef', source: 'server' }),
      })
      assert.equal(res.status, 204)
      const entries = await (await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json`)).json()
      assert.equal(entries.length, 1)
      assert.equal(entries[0].source, 'client', 'le payload mentait "server" — IGNORÉ, forcé côté serveur')
      assert.equal(entries[0].message, 'client boom (dev)')
      assert.equal(entries[0].ua, 'sonde-dev/1.0')
    } finally {
      await dev.close()
    }
  })

  // TROU DE COUVERTURE fermé : les DEUX gardes de taille du POST
  // (plafond du corps, troncature des champs) tenaient en vrai mais aucun test ne tombait quand on
  // les retirait — leur pendant `mjs serve` est couvert par journal-endpoints.test.ts, pas le dev.
  it('corps au-delà de 65 536 octets : 413, connexion fermée, RIEN journalisé', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    config.journal = { client: true }
    const dev = await startDev(config, root)
    try {
      const res = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(70_000) }),
      })
      assert.equal(res.status, 413)
      assert.equal(dev.journalStore.list().length, 0, 'un corps refusé ne doit RIEN laisser dans le journal')
    } finally {
      await dev.close()
    }
  })

  // NUANCE constatée en éprouvant ce test : `message` et `pile` sont tronqués DEUX fois (ici et
  // dans journal.ts, MAX_MESSAGE_CHARS/MAX_PILE_CHARS, mêmes plafonds) — retirer la troncature
  // d'ici ne change donc rien pour eux. Ce sont `url`, `version` et `ua` qui portent la garde :
  // journal.ts ne les borne PAS. Sabotage vérifié sur ces trois-là ⇒ ce test devient rouge.
  it('champs surdimensionnés : tronqués aux plafonds AVANT stockage (message 2048, pile 8192, url 2048, version 32, ua 256)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    config.journal = { client: true }
    const dev = await startDev(config, root)
    try {
      const res = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'u'.repeat(400) },
        body: JSON.stringify({ message: 'm'.repeat(5000), pile: 'p'.repeat(20_000), url: '/' + 'u'.repeat(5000), version: 'v'.repeat(100) }),
      })
      assert.equal(res.status, 204)
      const e = dev.journalStore.list()[0] as any
      assert.equal(e.message.length, 2048, 'message tronqué à 2048')
      assert.equal(e.pile.length,    8192, 'pile tronquée à 8192')
      assert.equal(e.url.length,     2048, 'url tronquée à 2048')
      assert.equal(e.version.length,   32, 'version tronquée à 32')
      assert.equal(e.ua.length,       256, "user-agent tronqué à 256 — il vient de l'en-tête, pas du corps")
    } finally {
      await dev.close()
    }
  })

  it('429 : au-delà de ~10 requêtes rapides depuis la même IP (même seau que `mjs serve`)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    config.journal = { client: true }
    const dev = await startDev(config, root)
    try {
      const statuses: number[] = []
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'rafale' + i, url: '/' + i }),
        })
        statuses.push(res.status)
      }
      assert.ok(statuses.slice(0, 10).every((s) => s === 204), 'les 10 premières passent : ' + statuses.join(','))
      assert.ok(statuses.slice(10).some((s) => s === 429), 'au-delà de la capacité, 429 attendu : ' + statuses.join(','))
    } finally {
      await dev.close()
    }
  })
})

describe('GET /__mjs/errors(.json) (mjs dev) — étage 3, visionneuse', () => {
  it('.json : renvoie les entrées déjà journalisées', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    config.journal = { client: true }
    const dev = await startDev(config, root)
    try {
      await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'a', url: '/a' }) })
      const res = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
      const entries = await res.json()
      assert.equal(entries.length, 1)
      assert.equal(entries[0].message, 'a')
    } finally {
      await dev.close()
    }
  })

  it('page HTML : 200, script compilé de la visionneuse DU JOURNAL (assertion de contenu, pas seulement la balise)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    try {
      const res = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.doesNotMatch(html, /<mjs-journal-viewer>/, 'plus de balise nue dans le corps')
      assert.match(html, /µ\._def\("mjs-journal-viewer"/)
      assert.match(html, /document\.createElement\("mjs-journal-viewer"\)/, 'créée APRÈS sa définition, jamais en balise nue')
      // contenu RÉEL de errors-viewer.mjs, pas juste le nom de balise — piège déjà rencontré sur
      // l'atelier des thèmes : un ViewerSpec pointant vers le mauvais fichier source passe
      // inaperçu tant que seul le NOM du composant est vérifié.
      assert.match(html, /Journal d'erreurs/, 'le script compilé vient bien de errors-viewer.mjs, pas d\'une autre visionneuse')
      assert.doesNotMatch(html, /Variables de thème/, 'la route journal ne doit jamais servir le contenu de la visionneuse du thème')
    } finally {
      await dev.close()
    }
  })

  // RENVERSE l'ancienne assertion (« sans bloc `render` : 404 »). Le manifeste ne dépend pas
  // du bloc `render` : le bundler l'écrit toujours, la visionneuse n'a besoin que de lui.
  it("page HTML SANS bloc `render` (aucun renderHandle) : 200, la visionneuse n'a besoin que du manifeste", async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root, false)
    try {
      const page = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`)
      const json = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json`)
      assert.equal(page.status, 200, 'la page du journal ne dépend plus du bloc `render`')
      assert.match(await page.text(), /Journal d'erreurs/, 'et c\'est bien le contenu de errors-viewer.mjs, pas une coquille vide')
      assert.equal(json.status, 200, ".json ne dépend PAS du manifestPath — seule la page HTML en a besoin")
    } finally {
      await dev.close()
    }
  })

  // le shell de la page réclame ce script : sans lui, la visionneuse serait une page MORTE servie en
  // 200. Avant, la branche vivait dans serveRenderFallback, donc injoignable sans bloc `render`.
  it('/__mjs/bundle.js est servi SANS bloc `render` — sinon la page du journal serait morte', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root, false)
    try {
      const page = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`)
      assert.match(await page.text(), /<script type="module" src="\/__mjs\/bundle\.js">/, 'le shell pointe bien vers le bundle')
      const bundle = await fetch(`http://127.0.0.1:${dev.port}/__mjs/bundle.js`)
      assert.equal(bundle.status, 200)
      assert.equal(bundle.headers.get('content-type'), 'text/javascript')
      assert.match(await bundle.text(), /µ\.version = "abcd1234"/, 'c\'est bien le manifeste du projet qui est servi')
    } finally {
      await dev.close()
    }
  })

  // la porte ne teste plus la CONFIG (bloc `render`) mais le FICHIER : un projet dont le premier
  // build n'a pas fini garde son 404, jamais un 500 de compilation ni une page morte.
  it('manifeste PAS ENCORE écrit sur le disque : la page reste 404, et le .json continue de répondre', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    rmSync(join(root, 'out', 'manifest.js'))
    const dev = await startDev(config, root, false)
    try {
      const page   = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`)
      const json   = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json`)
      const bundle = await fetch(`http://127.0.0.1:${dev.port}/__mjs/bundle.js`)
      assert.equal(page.status, 404, 'porte fermée, jamais un 500')
      assert.equal(json.status, 200)
      assert.equal(bundle.status, 404)
    } finally {
      await dev.close()
    }
  })
})

describe('DELETE /__mjs/errors (mjs dev) — purge', () => {
  it('sans ?source= : purge TOUT', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    config.journal = { client: true }
    const dev = await startDev(config, root)
    try {
      await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'a', url: '/a' }) })
      const del = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`, { method: 'DELETE' })
      assert.equal(del.status, 204)
      const entries = await (await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json`)).json()
      assert.deepEqual(entries, [])
    } finally {
      await dev.close()
    }
  })

  it('?source=client : ne purge QUE client', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    config.journal = { client: true }
    const dev = await startDev(config, root)
    try {
      dev.journalStore.record('server', { message: 'srv', url: '/srv' })
      await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'cli', url: '/cli' }) })
      const del = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors?source=client`, { method: 'DELETE' })
      assert.equal(del.status, 204)
      const entries = await (await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json`)).json()
      assert.equal(entries.length, 1)
      assert.equal(entries[0].source, 'server')
    } finally {
      await dev.close()
    }
  })
})

describe('garde `journal.viewer` (mjs dev) — mêmes 3 routes que `mjs serve`', () => {
  it('viewer: false → 404 sur GET page, GET .json et DELETE', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    config.journal = { viewer: false }
    const dev = await startDev(config, root)
    try {
      const page = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`)
      const json = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json`)
      const del  = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors`, { method: 'DELETE' })
      assert.equal(page.status, 404)
      assert.equal(json.status, 404)
      assert.equal(del.status, 404)
    } finally {
      await dev.close()
    }
  })

  it('viewer = jeton : 404 sans ?token=, 200 avec le bon jeton, 404 avec un mauvais jeton', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    config.journal = { viewer: 'secret-dev' }
    const dev = await startDev(config, root)
    try {
      const sansJeton    = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json`)
      const bonJeton     = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json?token=secret-dev`)
      const mauvaisJeton = await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json?token=mauvais`)
      assert.equal(sansJeton.status, 404)
      assert.equal(bonJeton.status, 200)
      assert.equal(mauvaisJeton.status, 404)
    } finally {
      await dev.close()
    }
  })
})

describe('capture serveur (étage 1, mjs dev)', () => {
  it('erreur de rendu SSR RÉELLE (composant introuvable) : journalisée (point de capture render-request.ts) et relisible par .json', async function () {
    this.timeout(30000)
    const root   = mjsTmp('journal-dev-ssr')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<p>ok</p>')
    writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
    const config: any = {
      sourceDir: 'src', outputDir: 'out',
      render: { routes: { '/boom-ssr': { component: 'mjs-nexistepas', mode: 'ssr' as const } } },
    }
    const dev = await startDev(config, root)
    try {
      const res = await fetch(`http://127.0.0.1:${dev.port}/boom-ssr`)
      assert.equal(res.status, 500, 'composant introuvable : renderToString() throw à coup sûr (même technique que render-request-xss-escaping.test.ts)')
      const entries = await (await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json`)).json()
      assert.equal(entries.length, 1)
      assert.equal(entries[0].source, 'server')
      assert.match(entries[0].url, /boom-ssr/)
    } finally {
      await dev.close()
    }
  })

  it('journal.server: false → la même erreur de rendu SSR ne journalise RIEN', async function () {
    this.timeout(30000)
    const root   = mjsTmp('journal-dev-ssr')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<p>ok</p>')
    writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
    const config: any = {
      sourceDir: 'src', outputDir: 'out', journal: { server: false },
      render: { routes: { '/boom-ssr': { component: 'mjs-nexistepas', mode: 'ssr' as const } } },
    }
    const dev = await startDev(config, root)
    try {
      const res = await fetch(`http://127.0.0.1:${dev.port}/boom-ssr`)
      assert.equal(res.status, 500)
      const entries = await (await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json`)).json()
      assert.deepEqual(entries, [], 'étage serveur coupé : rien journalisé')
    } finally {
      await dev.close()
    }
  })

  it('exception RÉELLE du renderHandle (pas un simple kind:error) : catch de serveRenderFallback, journalisée aussi', async function () {
    this.timeout(15000)
    const { root, outDir } = setup()
    const journalStore = createJournal({ dir: join(root, 'log') })
    const throwingHandle = async () => { throw new Error('crash reel du renderHandle') }
    const server = new StaticServer({
      rootDir: outDir, port: 0, host: '127.0.0.1',
      renderHandle: throwingHandle as any, manifestPath: join(outDir, 'manifest.js'),
      journal: journalStore,
    })
    await server.start()
    try {
      const port = (server.server!.address() as any).port
      const res = await fetch(`http://127.0.0.1:${port}/une-page-quelconque`)
      assert.equal(res.status, 500)
      const entries = await (await fetch(`http://127.0.0.1:${port}/__mjs/errors.json`)).json()
      assert.equal(entries.length, 1)
      assert.equal(entries[0].source, 'server')
      assert.match(entries[0].message, /crash reel du renderHandle/)
    } finally {
      await server.stop()
    }
  })

  it('exception RÉELLE du renderHandle + journal.server: false : le catch de serveRenderFallback ne journalise RIEN (même gating que recordServer)', async function () {
    this.timeout(15000)
    const { root, outDir } = setup()
    const journalStore = createJournal({ dir: join(root, 'log') })
    const throwingHandle = async () => { throw new Error('crash reel du renderHandle 2') }
    const server = new StaticServer({
      rootDir: outDir, port: 0, host: '127.0.0.1',
      renderHandle: throwingHandle as any, manifestPath: join(outDir, 'manifest.js'),
      journal: journalStore, config: { journal: { server: false } } as any,
    })
    await server.start()
    try {
      const port = (server.server!.address() as any).port
      const res = await fetch(`http://127.0.0.1:${port}/une-page-quelconque`)
      assert.equal(res.status, 500)
      const entries = await (await fetch(`http://127.0.0.1:${port}/__mjs/errors.json`)).json()
      assert.deepEqual(entries, [], 'journal.server: false doit aussi couper CE point de capture (recordServerError)')
    } finally {
      await server.stop()
    }
  })
})

// le tag `version` des entrées SERVEUR de `mjs dev`, jusqu'ici toujours null alors que
// `mjs serve` posait le hash du build. Les DEUX points de capture sont couverts, parce
// qu'ils sont câblés à des endroits différents : celui du moteur de rendu (cli.ts, via recordServer,
// reproduit à l'identique par startDev) et celui du serveur statique lui-même (recordServerError,
// server/index.ts). Sabotage vérifié sur chacun : retirer `version:` de son call-site rend rouge le
// test correspondant, et LUI SEUL.
describe('tag `version` des entrées serveur (mjs dev) — parité avec `mjs serve`', () => {
  it('point de capture du MOTEUR DE RENDU (recordServer, cli.ts) : entrée taguée du hash du manifeste', async function () {
    this.timeout(30000)
    const root   = mjsTmp('journal-dev-version-rendu')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<p>ok</p>')
    writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
    const config: any = {
      sourceDir: 'src', outputDir: 'out',
      render: { routes: { '/boom-ssr': { component: 'mjs-nexistepas', mode: 'ssr' as const } } },
    }
    const dev = await startDev(config, root)
    try {
      await fetch(`http://127.0.0.1:${dev.port}/boom-ssr`)
      const entries = await (await fetch(`http://127.0.0.1:${dev.port}/__mjs/errors.json`)).json()
      assert.equal(entries.length, 1)
      assert.equal(entries[0].version, 'abcd1234', 'le hash vient de la ligne µ.version du manifeste, pas d\'un défaut')
    } finally {
      await dev.close()
    }
  })

  it('point de capture du SERVEUR STATIQUE (recordServerError, server/index.ts) : même tag', async function () {
    this.timeout(15000)
    const { root, outDir } = setup()
    const journalStore = createJournal({ dir: join(root, 'log') })
    const throwingHandle = async () => { throw new Error('crash pour le tag de version') }
    const server = new StaticServer({
      rootDir: outDir, port: 0, host: '127.0.0.1',
      renderHandle: throwingHandle as any, manifestPath: join(outDir, 'manifest.js'),
      journal: journalStore,
    })
    await server.start()
    try {
      const port = (server.server!.address() as any).port
      await fetch(`http://127.0.0.1:${port}/une-page-quelconque`)
      const entries = await (await fetch(`http://127.0.0.1:${port}/__mjs/errors.json`)).json()
      assert.equal(entries.length, 1)
      assert.equal(entries[0].version, 'abcd1234')
    } finally {
      await server.stop()
    }
  })

  // dégradation IDENTIQUE à celle de `mjs serve` : pas de ligne µ.version ⇒ null, jamais une
  // exception ni une entrée perdue. L'erreur reste journalisée, c'est le tag seul qui manque.
  it('manifeste SANS ligne µ.version : entrée journalisée quand même, version null', async function () {
    this.timeout(15000)
    const { root, outDir } = setup()
    writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\n")
    const journalStore = createJournal({ dir: join(root, 'log') })
    const throwingHandle = async () => { throw new Error('crash sans version') }
    const server = new StaticServer({
      rootDir: outDir, port: 0, host: '127.0.0.1',
      renderHandle: throwingHandle as any, manifestPath: join(outDir, 'manifest.js'),
      journal: journalStore,
    })
    await server.start()
    try {
      const port = (server.server!.address() as any).port
      await fetch(`http://127.0.0.1:${port}/une-page-quelconque`)
      const entries = await (await fetch(`http://127.0.0.1:${port}/__mjs/errors.json`)).json()
      assert.equal(entries.length, 1, 'l\'erreur est journalisée malgré tout')
      assert.equal(entries[0].version, null)
    } finally {
      await server.stop()
    }
  })
})

describe('sans option `journal` (StaticServer) — comportement HISTORIQUE inchangé', () => {
  it('POST → 405 (porte GET/HEAD générale, jamais nos routes) ; GET .json → 404 générique (pathPrefix)', async function () {
    this.timeout(15000)
    const { outDir } = setup()
    const server = new StaticServer({ rootDir: outDir, port: 0, host: '127.0.0.1' })
    await server.start()
    try {
      const port = (server.server!.address() as any).port
      const post = await fetch(`http://127.0.0.1:${port}/__mjs/errors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const json = await fetch(`http://127.0.0.1:${port}/__mjs/errors.json`)
      assert.equal(post.status, 405, "sans `journal`, POST tombe sur la porte GET/HEAD générale — jamais nos routes")
      assert.equal(json.status, 404)
    } finally {
      await server.stop()
    }
  })
})
