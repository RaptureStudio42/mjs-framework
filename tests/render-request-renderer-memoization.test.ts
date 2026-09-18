// Test de régression : `getRenderer()`
// faisait `if (!renderer) { renderer = await createSSRRenderer(...) }` —
// `renderer` n'est assigné qu'APRÈS l'`await`. 2 requêtes SSR concurrentes À
// FROID (avant la 1ʳᵉ résolution) voient TOUTES LES DEUX `renderer === null`
// et lancent CHACUNE leur propre `createSSRRenderer` (compile tout le projet
// + dossier temp + bundler, opération coûteuse) ; la 2e assignation écrase
// la 1ʳᵉ, dont les ressources ne sont jamais `close()`-ées → fuite worker
// pool + dossier temp.
//
// Fix : mémoïse la PROMESSE (pas la valeur résolue), même patron que
// `ensureWorkerPool` (bundler/index.ts, critique déjà corrigé).
//
// Test : monkey-patch `Bundler.prototype.compile` (compile() est l'opération
// coûteuse au cœur de `createSSRRenderer`) pour compter les appels ET
// ralentir artificiellement — 2 `handle()` concurrents (2 routes SSR
// distinctes, toutes deux déclenchant `getRenderer()` à froid) doivent
// résulter en UN SEUL compile(), pas deux. Monkey-patch restauré dans
// `finally` (mutation de PROTOTYPE globale et partagée par tout le process
// Mocha — ne JAMAIS la laisser fuiter vers les autres fichiers de test).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { createRenderHandler } from '../src/server/render-request.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('render-request — getRenderer() : mémoïsation de la promesse (pas de double compile)', function () {
  this.timeout(30000)

  after(async () => { await terminateSharedWorkerPool() })

  it('2 requêtes SSR concurrentes À FROID ne déclenchent qu\'UN SEUL compile() (pas de double compile/fuite)', async function () {
    const root = mjsTmp('req-memo')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<p>ok</p>')

    const config = {
      sourceDir: 'src',
      outputDir: 'public/out',
      render: {
        default: 'prerender' as const,
        routes: {
          '/a': { component: 'mjs-home', mode: 'ssr' as const },
          '/b': { component: 'mjs-home', mode: 'ssr' as const },
        },
      },
    }

    let compileCallCount = 0
    const originalCompile = Bundler.prototype.compile
    Bundler.prototype.compile = async function (this: Bundler, ...args: any[]) {
      compileCallCount++
      // Ralentit artificiellement pour élargir la fenêtre de course de façon
      // fiable (sans dépendre du timing réel d'un compile sur ce projet
      // minuscule, qui pourrait résoudre trop vite pour exposer la race).
      await new Promise(r => setTimeout(r, 200))
      return (originalCompile as any).apply(this, args)
    }

    try {
      const h = await createRenderHandler(config, root)
      // Deux routes SSR DISTINCTES, toutes deux déclenchant getRenderer() à
      // froid, lancées EN MÊME TEMPS (Promise.all, pas de await séquentiel).
      const [resA, resB] = await Promise.all([h.handle('/a'), h.handle('/b')])
      assert.equal(resA.kind, 'ssr', resA.body)
      assert.equal(resB.kind, 'ssr', resB.body)
      assert.equal(compileCallCount, 1,
        `AVANT le fix : chaque requête concurrente à froid déclenchait SON PROPRE createSSRRenderer → SON PROPRE compile() → fuite du renderer perdant (jamais close()). compileCallCount=${compileCallCount}`)
      await h.close()
    } finally {
      Bundler.prototype.compile = originalCompile
    }
  })
})
