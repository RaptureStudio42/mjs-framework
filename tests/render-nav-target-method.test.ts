// mjs serve — protocole nav : target/method (config.render) dans la fiche JSON. Une
// navigation remplace le CONTENU d'un contenant ; `target` = sélecteur CSS du contenant (sinon
// <body>), `method` prend 3 valeurs : `update` (contenant vidé puis reçoit, il survit,
// défaut, ex-`append`) · `replace` (le contenu prend la place du contenant, qui disparaît) ·
// `append` (VRAI sens : ajouté à la SUITE, rien retiré). Émis SEULEMENT si configurés (fiche
// minimale sinon), branche nav ET branche 422 (formulaire), cf. render-server.ts.
// X-MJS-Version est posé aussi sur la branche HTML (jusqu'ici réservé au JSON). La branche
// HTML porte aussi X-MJS-Target/X-MJS-Method quand target/method sont configurés. `cache`
// (politique de cache de page, µ.pageCache côté client) suit EXACTEMENT le même patron — en-tête
// X-MJS-Cache sur la branche HTML, clé `cache` dans la fiche JSON, posés SEULEMENT si configurés.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'
import { startRenderServer, shell } from '../src/server/render-server.js'
import { buildSsrHead } from '../src/server/ssr-head.js'

after(() => sweepRegistered())

// action SEULE (pas de props) : `props`/`actions` retombent sur {} si absents (serve-entry.ts),
// suffisant pour déclencher la branche 422 sur '/p/:id'.
const FIXTURE = `export default {
  actions: {
    '/p/:id': (params, body, req) ->
      if body.name is 'bad'
        { errors: { name: 'invalide' } }
      else
        { redirect: "/p/#{params.id}" }
  }
}
`

function setup(renderExtra: Record<string, unknown> = {}) {
  const root = mjsTmp('nav-target-method')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ.version = "abcd1234";\n')
  writeFileSync(join(root, 'serve.server.mjs'), FIXTURE)
  const config = {
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
    render: {
      routes: {
        '/':      { component: 'mjs-home', mode: 'csr' as const },
        '/p/:id': { component: 'mjs-page', mode: 'csr' as const },
      },
      ...renderExtra,
    },
  }
  return { root, config }
}

describe('render-server — fiche JSON target/method', () => {
  it('1. render SANS target/method configurés : les deux clés sont ABSENTES de la fiche (branche nav)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`, { headers: { 'X-MJS-Nav': '1' } })
      const json = await res.json()
      assert.deepEqual(json, { module: 'mjs-home', props: {}, url: '/', title: null, version: 'abcd1234' })
      assert.ok(!('target' in json), 'target doit être ABSENTE (pas juste undefined)')
      assert.ok(!('method' in json), 'method doit être ABSENTE (pas juste undefined)')
    } finally { await running.close() }
  })

  it("2. render.target='main'/render.method='replace' : la fiche porte exactement ces valeurs (branche nav)", async function () {
    this.timeout(15000)
    const { root, config } = setup({ target: 'main', method: 'replace' })
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`, { headers: { 'X-MJS-Nav': '1' } })
      const json = await res.json()
      assert.equal(json.target, 'main')
      assert.equal(json.method, 'replace')
      assert.deepEqual(Object.keys(json), ['module', 'props', 'url', 'title', 'version', 'target', 'method'], 'target/method en dernier, après version')
    } finally { await running.close() }
  })

  it('3. même config target/method : la branche 422 (formulaire invalide) les porte aussi', async function () {
    this.timeout(15000)
    const { root, config } = setup({ target: 'main', method: 'replace' })
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/p/42`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${running.port}` },
        body: 'name=bad',
      })
      assert.equal(res.status, 422)
      const json = await res.json()
      assert.equal(json.target, 'main')
      assert.equal(json.method, 'replace')
    } finally { await running.close() }
  })

  // Avant ce correctif, X-MJS-Version n'était posé que sur les 2 branches JSON : un client qui
  // navigue en mode HTML ne pouvait jamais détecter un nouveau build.
  it('4. réponse HTML normale : en-tête X-MJS-Version présent (version du manifeste), corps octet-identique', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`)
      const html = await res.text()
      assert.equal(res.headers.get('x-mjs-version'), 'abcd1234')
      // le <head> porte désormais le thème inliné (buildSsrHead, même config/manifeste
      // que le serveur) : ce test reste sur le CORPS (seul son invariant d'origine), pas sur le head.
      const headExtra = buildSsrHead(config as any, root, join(root, 'out', 'manifest.js'))
      assert.equal(html, shell('<mjs-home></mjs-home>', '/__mjs/bundle.js', 'fr', '', headExtra), 'seul l\'en-tête change, jamais le corps')
    } finally { await running.close() }
  })

  // La page qui ARRIVE en HTML doit elle aussi pouvoir porter la consigne target/method.
  it("5. render.target='main'/render.method='append' : la réponse HTML porte X-MJS-Target et X-MJS-Method", async function () {
    this.timeout(15000)
    const { root, config } = setup({ target: 'main', method: 'append' })
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`)
      assert.equal(res.headers.get('x-mjs-target'), 'main')
      assert.equal(res.headers.get('x-mjs-method'), 'append')
    } finally { await running.close() }
  })

  it('6. render SANS target/method configurés : la réponse HTML ne porte ni X-MJS-Target ni X-MJS-Method', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`)
      assert.equal(res.headers.get('x-mjs-target'), null, 'target absent de la config → en-tête absent')
      assert.equal(res.headers.get('x-mjs-method'), null, 'method absent de la config → en-tête absent')
    } finally { await running.close() }
  })

  it("7. render.method='append' (nouvelle valeur) : la fiche JSON la porte telle quelle, bout en bout", async function () {
    this.timeout(15000)
    const { root, config } = setup({ target: 'main', method: 'append' })
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`, { headers: { 'X-MJS-Nav': '1' } })
      const json = await res.json()
      assert.equal(json.target, 'main')
      assert.equal(json.method, 'append')
    } finally { await running.close() }
  })

  // Politique de cache par page (µ.pageCache côté client) : même consigne que target/method,
  // posée SEULEMENT si configurée (navExtras), sur la branche HTML (en-tête X-MJS-Cache) ET la fiche JSON.
  it("8. render.cache='revalidate' : la réponse HTML porte X-MJS-Cache", async function () {
    this.timeout(15000)
    const { root, config } = setup({ cache: 'revalidate' })
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`)
      assert.equal(res.headers.get('x-mjs-cache'), 'revalidate')
    } finally { await running.close() }
  })

  it('9. render SANS cache configuré : la réponse HTML ne porte PAS X-MJS-Cache', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`)
      assert.equal(res.headers.get('x-mjs-cache'), null, 'cache absent de la config → en-tête absent')
    } finally { await running.close() }
  })

  it("10. render.cache='no-cache' : la fiche JSON la porte telle quelle (comme target/method)", async function () {
    this.timeout(15000)
    const { root, config } = setup({ cache: 'no-cache' })
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`, { headers: { 'X-MJS-Nav': '1' } })
      const json = await res.json()
      assert.equal(json.cache, 'no-cache')
      assert.ok(!('target' in json), 'target reste ABSENT (non configuré ici)')
    } finally { await running.close() }
  })
})
