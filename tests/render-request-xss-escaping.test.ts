// Test de régression : le commentaire
// d'erreur servi par `handle()` interpolait `pathname` (contrôlé par
// l'appelant de la requête HTTP — vient de l'URL) et `e.message` SANS AUCUN
// échappement, dans un `<!-- ... -->` renvoyé tel quel dans la réponse HTTP.
// Un pathname contenant `-->` referme le commentaire PRÉMATURÉMENT — tout ce
// qui suit devient du markup RÉEL, EXÉCUTABLE (XSS réfléchie) :
// `/foo--><script>...</script><!--` suffit.
//
// Fix : `escapeHtml()` (&, <, >) appliqué à pathname ET e.message.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { createRenderHandler } from '../src/server/render-request.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('render-request — commentaire d\'erreur : pathname/message échappés (XSS réfléchie)', function () {
  after(async () => { await terminateSharedWorkerPool() })

  function project() {
    const root = mjsTmp('req-xss')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<p>ok</p>')
    return root
  }

  // Route SSR pointant vers un composant INEXISTANT : renderToString() throw
  // à coup sûr (tag introuvable dans le bundle compilé), déclenchant le
  // chemin `kind: 'error'` sans dépendre d'un comportement de rendu fragile.
  const config = {
    sourceDir: 'src',
    outputDir: 'public/out',
    render: {
      default: 'prerender' as const,
      routes: {
        // Wildcard : SEUL `*` (segment nu) est reconnu par matchPattern —
        // capture n'importe quel chemin, quel que soit son nombre de
        // segments (le payload malveillant en contient plusieurs).
        '/*': { component: 'mjs-nexistepas', mode: 'ssr' as const },
      },
    },
  }

  it("un pathname contenant '-->' + <script> ne referme PAS le commentaire (pas de markup injecté)", async function () {
    this.timeout(30000)
    const h = await createRenderHandler(config, project())
    const malicious = "/foo--><script>alert(document.cookie)</script><!--"
    const res = await h.handle(malicious)

    assert.equal(res.kind, 'error')
    assert.doesNotMatch(res.body, /--><script>/,
      "AVANT le fix : le pathname interpolé SANS échappement refermait le commentaire HTML avec '-->', rendant le <script> injecté RÉELLEMENT EXÉCUTABLE dans la page servie")
    assert.match(res.body, /--&gt;&lt;script&gt;/,
      `'-->' et '<script>' doivent apparaître ÉCHAPPÉS dans le corps. body: ${res.body}`)
    await h.close()
  })

  it('un pathname normal (sans caractères spéciaux) continue de produire un message lisible (pas de régression)', async function () {
    this.timeout(30000)
    const h = await createRenderHandler(config, project())
    const res = await h.handle('/normal-page')
    assert.equal(res.kind, 'error')
    assert.match(res.body, /\/normal-page/)
    await h.close()
  })

  // `createRenderHandler` reçoit `env` (mjs serve --prod le transmet,
  // cf. render-server.ts) mais le corps d'erreur ne testait QUE `process.env.NODE_ENV ===
  // 'production'`, ignorant `env` : un `--prod` sans NODE_ENV positionné divulguait le message
  // brut (chemins temp/bundle, structure interne) au client.
  it("env: 'prod' masque le message brut, MÊME sans NODE_ENV positionné", async function () {
    this.timeout(30000)
    const savedNodeEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV
    try {
      const h = await createRenderHandler(config, project(), undefined, 'prod')
      const res = await h.handle('/prod-page')
      assert.equal(res.kind, 'error')
      assert.match(res.body, /erreur interne/, `message générique attendu en prod. body: ${res.body}`)
      assert.doesNotMatch(res.body, /non enregistré/, `le message brut ne doit PAS fuiter en prod. body: ${res.body}`)
      await h.close()
    } finally {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = savedNodeEnv
    }
  })

  it("env: 'dev' conserve le message brut échappé (non-régression)", async function () {
    this.timeout(30000)
    const h = await createRenderHandler(config, project(), undefined, 'dev')
    const res = await h.handle('/dev-page')
    assert.equal(res.kind, 'error')
    assert.match(res.body, /non enregistré/, `message brut attendu en dev. body: ${res.body}`)
    await h.close()
  })
})
