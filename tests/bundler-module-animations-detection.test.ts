// Régression — un module .civet/.coffee AUTONOME (importé via `@import`) qui
// enregistre une animation par appel direct (`µanim.crossfade(...)`) n'était
// jamais scanné pour `µ.anim.X` : la détection AST (extractAnimationsFromAst)
// ne portait QUE sur la sortie compilée des composants .mjs
// (_compileMjsInner) — jamais sur celle des modules autonomes
// (_compileScriptModuleInner). Bug réel, trouvé par le balayage navigateur du
// tuto : leçons `animations` et `transitions-differees`
// (setupCrossfade() vit dans un .civet @import-é) plantaient en pageerror
// « µ.anim.crossfade is not a function » — crossfade.ts existe pourtant bien
// dans src/runtime/animations/, jamais émis dans mjs_anims faute d'avoir été
// détecté comme « utilisé ».
//
// Fix : _compileScriptModuleInner scanne désormais aussi sa sortie compilée
// via extractAnimationsFromAst (même mécanisme que les .mjs), fusionne dans
// `usedAnimations`, et réinjecte pareil au cache-hit (comportement miroir de
// _compileMjsInner).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — animation détectée dans un module .civet autonome (@import)', function () {
  this.timeout(15000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("µanim.crossfade('todo', …) dans un .civet @import-é → émis dans mjs_anims (usedAnimations alimenté depuis le module autonome)", async function () {
    const root = mjsTmp('anim-standalone')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    // Le SEUL usage de µ.anim du projet vit ICI, dans le module autonome — le
    // composant .mjs se contente d'appeler la fonction exportée, sans jamais
    // écrire `µ.anim` ni `@transition`/`@in`/`@out` lui-même. Isole précisément
    // le chemin corrigé (sinon l'AUTRE détection, déjà en place côté .mjs,
    // suffirait à faire passer le test même sans le fix).
    writeFileSync(join(srcDir, 'setup.civet'), [
      'export setupCrossfade = ->',
      "  µanim.crossfade 'todo', { duration: 600 }",
    ].join('\n'))
    writeFileSync(join(srcDir, 'comp.mjs'), [
      "@import setupCrossfade 'setup.civet'",
      '',
      '<script>',
      '  setupCrossfade()',
      '</script>',
      '<p>hi</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const files = readdirSync(outDir)
    const animFile = files.find(f => /^mjs_anims-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(animFile,
      "AVANT le fix : usedAnimations restait vide (le seul usage de µ.anim, dans le .civet, n'était jamais scanné) → compileUsedAnimations() n'émettait même pas de fichier mjs_anims.")

    const content = readFileSync(join(outDir, animFile!), 'utf-8')
    assert.match(content, /µ\.anim\.crossfade\s*=/,
      "AVANT le fix : 'crossfade' absent de usedAnimations → jamais émis dans mjs_anims → µ.anim.crossfade restait undefined à l'exécution ('µ.anim.crossfade is not a function').")
  })
})
