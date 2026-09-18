// Régression historique : un module .civet/.coffee qui référence `µ` embarque en dur
// `import { µ } from '<coreHashedPath>'` (autoImportMu()). En watch mode, un rebuild du
// runtime (nouveau `mjs_core-<hash>.js`, ANCIEN supprimé) laissait un module .civet/.coffee
// dont le SOURCE n'a pas changé faire un cache hit et continuer à référencer l'ANCIEN core,
// disparu du disque : 404 au chargement, jusqu'à toucher le fichier manuellement pour forcer
// une invalidation.
//
// fixture ADAPTÉE (assertion de fond INCHANGÉE : « un module inchangé dont le SEUL
// cœur a bougé doit réémettre avec le NOUVEAU chemin, jamais garder l'ancien ») : le hash de
// cache n'est PLUS salé avec coreHashedPath — la sortie
// compilée en mémoire n'embarque plus qu'un REPÈRE, identique d'un tour à l'autre tant que le
// SOURCE ne change pas. La garantie « jamais de 404 après un rebuild du cœur » est désormais
// portée par `CacheEntry.embeds` (comparé en PHASE C de compile(), cf. emitPendingUnits()) :
// un cache-hit CANDIDAT dont les embeds ne correspondent plus aux chemins ACTUELS (cœur ou
// feuille split changés) est recompilé au chemin froid avant d'être réémis. Prouvé ici par
// DEUX compile() complets sur la MÊME instance (plus d'appel direct `compileScriptModule()`
// mi-compile : il ne rend plus qu'un repère provisoire hors du pipeline d'émission).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — cache des modules .civet/.coffee résiste à un rebuild du cœur (embeds)', function () {
  this.timeout(30000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("un rebuild du core (déclenché par un AUTRE fichier) invalide le cache d'un .coffee non modifié : réémis avec le NOUVEAU chemin", async function () {
    const root = mjsTmp('script-core-salt')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    const coffeePath = join(srcDir, 'helper.coffee')
    // Référence µ pour déclencher autoImportMu() (sinon rien n'embarque le cœur et ce test
    // ne prouverait rien).
    writeFileSync(coffeePath, "export greet = -> µ.log 'hi'\n")
    // runtime: [] — isole la détection de 'for' (sinon mjs_flip.ts, sélectionné par défaut,
    // force déjà 'for' au 1er tour et le cœur ne changerait jamais entre les deux builds).
    writeFileSync(join(srcDir, 'trigger.mjs'), '<p>x</p>\n')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), runtime: [] })

    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map((e: any) => e.message).join('\n'))
    const core1 = readdirSync(outDir).find((f) => /^mjs_core-/.test(f))!
    const helper1 = readdirSync(outDir).find((f) => /^helper-/.test(f))!
    const helper1Content = readFileSync(join(outDir, helper1), 'utf-8')
    assert.ok(helper1Content.includes(core1.replace(/\.js$/, '')), 'helper.coffee doit référencer le cœur du 1er tour')

    // SEUL 'trigger.mjs' change (gagne un {for}) → le cœur change (mjs_for.ts entre dans le
    // bundle) — helper.coffee, lui, ne change PAS de source.
    writeFileSync(join(srcDir, 'trigger.mjs'), ['<script lang="coffee">', '@xs = [1]', '</script>', '{for x in @xs}<p>{x}</p>{end}'].join('\n'))
    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map((e: any) => e.message).join('\n'))

    const core2 = readdirSync(outDir).find((f) => /^mjs_core-/.test(f))!
    assert.notEqual(core1, core2, 'le cœur doit changer de hash (mjs_for.ts en plus)')
    assert.equal(existsSync(join(outDir, core1)), false, "l'ancien cœur doit avoir été nettoyé")

    const helper2 = readdirSync(outDir).find((f) => /^helper-/.test(f))!
    const helper2Content = readFileSync(join(outDir, helper2), 'utf-8')
    assert.ok(helper2Content.includes(core2.replace(/\.js$/, '')),
      "avec l'ancien mécanisme (sel) comme avec le nouveau (embeds) : helper.coffee (source inchangé) doit réémettre avec le NOUVEAU chemin du cœur, jamais garder l'ancien (404)")
    assert.equal(helper2Content.includes(core1.replace(/\.js$/, '')), false, "la sortie ne doit plus référencer l'ancien core après le rebuild")
  })

  it('le SOURCE change (cœur stable) : invalidation normale, comportement inchangé', async function () {
    const root = mjsTmp('script-core-salt-2')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    const coffeePath = join(srcDir, 'helper.coffee')
    writeFileSync(coffeePath, "export greet = -> 'v1'\n")

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map((e: any) => e.message).join('\n'))
    const path1 = readdirSync(outDir).find((f) => /^helper-/.test(f))!

    writeFileSync(coffeePath, "export greet = -> 'v2-changed'\n")
    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map((e: any) => e.message).join('\n'))
    const path2 = readdirSync(outDir).find((f) => /^helper-/.test(f))!

    assert.notEqual(path1, path2, 'un changement de SOURCE doit toujours produire un nouveau hash (comportement de base inchangé)')
  })
})
