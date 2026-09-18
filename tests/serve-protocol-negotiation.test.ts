// mjs serve — négociation de protocole de navigation : l'en-tête de requête
// X-MJS-Nav (présent et non vide) fait basculer la réponse de PAGE en JSON de
// protocole { module, props, url, title, version } au lieu du shell HTML — les
// branches bundle/assets restent prioritaires et inchangées (cf. render-server.ts).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { startRenderServer } from '../src/server/render-server.js'

// config PARTAGÉE par les cas : 2 routes CSR (aucun moteur SSR sollicité) + un
// manifest écrit à la main (µ.version connue) + un asset réel pour le cas 5.
function setup(withVersion: boolean = true) {
  const root = mjsTmp('serve-nav')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'a.css'), '.a{color:blue}')
  const manifestLines = withVersion ? 'µ.paths = {};\nµ.version = "abcd1234";\n' : 'µ.paths = {};\n'
  writeFileSync(join(outDir, 'manifest.js'), manifestLines)
  const config = {
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
    render: {
      routes: {
        '/': { component: 'mjs-home', mode: 'csr' as const },
        '/p/:id': { component: 'mjs-page', mode: 'csr' as const },
      },
    },
  }
  return { root, config }
}

describe('render-server — négociation de protocole (X-MJS-Nav)', () => {
  it('1. GET / avec X-MJS-Nav : JSON {module,props,url,title,version} + en-têtes', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`, { headers: { 'X-MJS-Nav': '1' } })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
      assert.equal(res.headers.get('x-mjs-version'), 'abcd1234')
      assert.equal(res.headers.get('vary'), 'X-MJS-Nav')
      assert.deepEqual(await res.json(), { module: 'mjs-home', props: {}, url: '/', title: null, version: 'abcd1234' })
    } finally {
      await running.close()
    }
  })

  it('2. GET /p/42?tri=asc avec X-MJS-Nav : module mjs-page, url avec sa query', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/p/42?tri=asc`, { headers: { 'X-MJS-Nav': '1' } })
      const json = await res.json()
      assert.equal(json.module, 'mjs-page')
      assert.equal(json.url, '/p/42?tri=asc')
    } finally {
      await running.close()
    }
  })

  it('3. GET / SANS X-MJS-Nav : HTML classique, Vary présent quand même', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`)
      const html = await res.text()
      assert.match(res.headers.get('content-type') || '', /text\/html/)
      assert.match(html, /<mjs-home><\/mjs-home>/)
      assert.equal(res.headers.get('vary'), 'X-MJS-Nav')
    } finally {
      await running.close()
    }
  })

  it('4. GET /inconnu avec X-MJS-Nav : 404 JSON module null, version présente', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/inconnu`, { headers: { 'X-MJS-Nav': '1' } })
      assert.equal(res.status, 404)
      assert.deepEqual(await res.json(), { module: null, props: {}, url: '/inconnu', title: null, version: 'abcd1234' })
    } finally {
      await running.close()
    }
  })

  it('5. un asset compilé demandé AVEC X-MJS-Nav : servi tel quel (la branche assets prime)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/a.css`, { headers: { 'X-MJS-Nav': '1' } })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'text/css')
      assert.equal(await res.text(), '.a{color:blue}')
    } finally {
      await running.close()
    }
  })

  it('6. manifest SANS ligne µ.version : version null, pas d\'en-tête X-MJS-Version', async function () {
    this.timeout(15000)
    const { root, config } = setup(false)
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`, { headers: { 'X-MJS-Nav': '1' } })
      assert.equal(res.headers.get('x-mjs-version'), null)
      const json = await res.json()
      assert.equal(json.version, null)
    } finally {
      await running.close()
    }
  })

  // le champ `url` du protocole renvoyait `req.url` BRUT (pas la normalisation
  // anti-« //p/42 » de `reqUrl`, cf. commentaire de tête du serveur) : un client recevrait une
  // URL protocole-relative telle quelle.
  it('7. GET //p/42 (slashs de tête) avec X-MJS-Nav : champ url du JSON NORMALISÉ, pas req.url brut', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}//p/42`, { headers: { 'X-MJS-Nav': '1' } })
      const json = await res.json()
      assert.equal(json.url, '/p/42', "AVANT le fix : json.url valait '//p/42' (req.url brut, lu comme protocole-relatif par un client)")
    } finally {
      await running.close()
    }
  })

  // `decodeURIComponent(url.pathname)` jette (URIError) sur un pourcentage malformé :
  // sans filet dédié, seul le catch global l'attrapait → 500 pour une requête simplement mal formée.
  it('8. GET /%zz (pourcentage malformé) : 400 Bad Request, pas un 500', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/%zz`, { headers: { 'X-MJS-Nav': '1' } })
      assert.equal(res.status, 400)
    } finally {
      await running.close()
    }
  })
})
