// `pathPrefix`/
// `urlPrefix` avec un slash final (`'/app/'`) cassait tout matching d'asset sur `mjs dev`
// (server/index.ts : `url.startsWith(pathPrefix + '/')` devient `startsWith('/app//')`, plus
// aucune URL réelle ne matche) et toute URL d'asset ÉMISE par le Bundler (`${urlPrefix}/${fichier}`
// → `'/app//fichier'`) — `bundler/config.ts` ne vérifiait le type (chaîne) de `urlPrefix`, jamais
// sa forme. Normalisé dans `validateConfig` (slashs finaux retirés, slash initial EXIGÉ, mutation
// en place — tout consommateur en aval reçoit la forme propre) ET défensivement au constructeur de
// `StaticServer` (voie directe, hors config fichier). `render-server.ts` (`mjs serve`) n'a PAS eu
// besoin d'un correctif propre : son matching (`pathname.startsWith(urlPrefix)`, sans `+ '/'`
// additionnel) tolère déjà un slash final — vérifié ci-dessous en non-régression (control).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { StaticServer } from '../src/server/index.js'
import { startRenderServer } from '../src/server/render-server.js'
import { findConfig, normalizeUrlPrefix } from '../src/bundler/config.js'

describe('normalisation de pathPrefix/urlPrefix', () => {
  it('normalizeUrlPrefix : slashs finaux retirés, racine pure → chaîne vide', () => {
    assert.equal(normalizeUrlPrefix('/app/'), '/app')
    assert.equal(normalizeUrlPrefix('/app//'), '/app')
    assert.equal(normalizeUrlPrefix('/app'), '/app')
    assert.equal(normalizeUrlPrefix('/'), '')
    assert.equal(normalizeUrlPrefix(''), '')
  })

  it('StaticServer construit DIRECTEMENT avec pathPrefix "/app/" (piège) : /app/bundle.js → 200', async () => {
    const rootDir = mjsTmp('pathprefix-dev')
    writeFileSync(join(rootDir, 'bundle.js'), 'contenu-asset')
    const server = new StaticServer({ rootDir, port: 0, host: '127.0.0.1', pathPrefix: '/app/' })
    await server.start()
    try {
      const port = (server.server!.address() as any).port
      const res = await fetch(`http://127.0.0.1:${port}/app/bundle.js`)
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'contenu-asset')
    } finally {
      await server.stop()
    }
  })

  it('findConfig() : urlPrefix "app" (sans slash initial) → refusé, message catalogué', () => {
    const root = mjsTmp('pathprefix-noslash')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', urlPrefix: 'app' }))
    assert.throws(() => findConfig(root), /urlPrefix/)
  })

  it('findConfig() : urlPrefix "/app/" → normalisé en place ("/app", slash final retiré)', () => {
    const root = mjsTmp('pathprefix-mutate')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', urlPrefix: '/app/' }))
    const found = findConfig(root)
    assert.equal(found?.config.urlPrefix, '/app')
  })

  it('mjs serve (startRenderServer), urlPrefix "/app/" HORS validation (config à la main) : /app/bundle.js → 200 (control, déjà tolérant)', async () => {
    const root   = mjsTmp('pathprefix-serve')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'bundle.js'), 'contenu-asset')
    const config: any = { sourceDir: 'src', outputDir: 'out', urlPrefix: '/app/' }
    const running = await startRenderServer(config, root, { port: 0, host: '127.0.0.1' })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/app/bundle.js`)
      assert.equal(res.status, 200)
    } finally {
      await running.close()
    }
  })
})
