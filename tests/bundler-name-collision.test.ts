// Test de régression — détection des collisions de basenames dans le bundler.
//
// Bug observé : deux `.mjs` au même basename (ex. `tuto-canvas.mjs` dupliqué
// dans deux dossiers) → ils se disputent la même clé `µ.paths[baseName]` du
// manifest. Le dernier écrit gagne, l'autre composant ne s'upgrade JAMAIS
// silencieusement (tag inconnu, `<mjs-tuto-canvas>` reste une balise inerte).
//
// Le bundler doit émettre un warning explicite mentionnant les deux chemins
// en collision, pour qu'on ne perde plus des heures à diagnostiquer.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — collision de basename', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('deux .mjs avec le même basename → warning explicite avec les deux chemins', async function () {
    const root = mjsTmp('collision')
    const srcDir = join(root, 'src')
    const sub1 = join(srcDir, 'first')
    const sub2 = join(srcDir, 'second')
    mkdirSync(sub1, { recursive: true })
    mkdirSync(sub2, { recursive: true })

    // Même basename `canvas.mjs` dans deux dossiers → collision.
    writeFileSync(join(sub1, 'canvas.mjs'), '<div>canvas A</div>')
    writeFileSync(join(sub2, 'canvas.mjs'), '<div>canvas B</div>')
    writeFileSync(join(srcDir, 'app.mjs'), '<mjs-canvas />')

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: join(root, 'out'),
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, 'la compilation ne plante pas (warning seulement)')
    // message généralisé pour couvrir
    // AUSSI les collisions de shortName (pas seulement basename, cf.
    // bundler-shortname-collision.test.ts) : la clé n'est plus suffixée
    // `.mjs` en dur (un shortName n'est pas un nom de fichier réel).
    const collisionWarning = stats.warnings.find(w => w.includes("'canvas'"))
    assert.ok(collisionWarning, `un warning de collision doit être émis. warnings:\n${stats.warnings.join('\n')}`)
    assert.match(collisionWarning!, /Collision de basename/, 'message identifie la collision')
    assert.ok(collisionWarning!.includes(sub1) && collisionWarning!.includes(sub2),
      `le warning doit citer les deux chemins en conflit. got: ${collisionWarning}`)
    assert.match(collisionWarning!, /<mjs-canvas>/, "le warning doit nommer le tag affecté")

    await bundler.close()
  })

  it('deux .civet avec le même basename → warning explicite (collision de module)', async function () {
    const root = mjsTmp('collision-civet')
    const srcDir = join(root, 'src')
    const sub1 = join(srcDir, 'a')
    const sub2 = join(srcDir, 'b')
    mkdirSync(sub1, { recursive: true })
    mkdirSync(sub2, { recursive: true })

    // Cas vécu en production : `attachments.module.civet` présent dans
    // deux tutos. Les deux compiles concurrents partagent le mangleCache
    // mutable → produisent des hashes différents → écrasement disque →
    // le .mjs qui @import-e via la manifest référence un fichier
    // supprimé → import 404 silencieux au runtime.
    writeFileSync(join(sub1, 'helper.module.civet'), 'export hi = -> "A"')
    writeFileSync(join(sub2, 'helper.module.civet'), 'export hi = -> "B"')

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: join(root, 'out'),
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0)
    const w = stats.warnings.find(x => x.includes("'helper.module.civet'"))
    assert.ok(w, `warning de collision .civet attendu. got: ${stats.warnings.join('\n')}`)
    assert.ok(w!.includes(sub1) && w!.includes(sub2), 'doit citer les deux chemins')

    await bundler.close()
  })

  it('basenames uniques → aucun warning de collision', async function () {
    const root = mjsTmp('no-collision')
    const srcDir = join(root, 'src')
    mkdirSync(join(srcDir, 'a'), { recursive: true })
    mkdirSync(join(srcDir, 'b'), { recursive: true })

    writeFileSync(join(srcDir, 'a', 'foo.mjs'), '<div>foo</div>')
    writeFileSync(join(srcDir, 'b', 'bar.mjs'), '<div>bar</div>')

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: join(root, 'out'),
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()

    const collisionWarnings = stats.warnings.filter(w => /Collision de basename/.test(w))
    assert.equal(collisionWarnings.length, 0,
      `aucune collision attendue. warnings:\n${stats.warnings.join('\n')}`)

    await bundler.close()
  })

  // Régression : la détection de collision
  // ci-dessus ne portait QUE sur `baseName` — la clé `shortName` (préfixe de
  // dossier ancêtre strippé, cf. shortModuleName) était écrite dans le
  // manifest SANS AUCUNE vérification. Cas réel :
  // `doc/doc-intro.mjs` publie le shortName `intro` (préfixe `doc-`
  // strippé) — un `intro.mjs` authentique ailleurs (basename `intro`) se
  // dispute la MÊME clé de manifest, en silence total.
  //
  // finitions build — contrat REVU (correctif A) : un alias court
  // (shortName) ne s'impose plus JAMAIS sur un VRAI composant (basename).
  // `foo/intro.mjs` (basename `intro`) reprend silencieusement la clé
  // `intro` que `doc/doc-intro.mjs` n'occupait qu'en ALIAS — plus de warning
  // (ce n'est plus une collision dangereuse : `doc-intro.mjs` reste
  // pleinement joignable via son propre tag qualifié `<mjs-doc-intro>`).
  it("shortName strippé (doc-X → X) qui collisionne avec un basename authentique → le basename gagne SANS warning", async function () {
    const root = mjsTmp('shortname-collision')
    const srcDir = join(root, 'src')
    const docDir = join(srcDir, 'doc')
    const fooDir = join(srcDir, 'foo')
    mkdirSync(docDir, { recursive: true })
    mkdirSync(fooDir, { recursive: true })

    // doc/doc-intro.mjs → shortName 'intro' (préfixe 'doc-' du dossier ancêtre strippé)
    writeFileSync(join(docDir, 'doc-intro.mjs'), '<div>doc intro</div>')
    // foo/intro.mjs → basename ET shortName 'intro' (pas de préfixe à stripper)
    writeFileSync(join(fooDir, 'intro.mjs'), '<div>vrai intro</div>')

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: join(root, 'out'),
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, 'la compilation ne plante pas')
    const collisionWarning = stats.warnings.find(w => w.includes("'intro'"))
    assert.ok(!collisionWarning,
      `un alias court cédé à un VRAI basename ne doit PLUS produire de warning. warnings:\n${stats.warnings.join('\n')}`)
    // 'intro' doit résoudre vers le VRAI composant (foo/intro.mjs), pas vers
    // l'alias court publié un temps par doc-intro.mjs.
    assert.ok(
      bundler.manifest['intro']!.includes('/intro-') && !bundler.manifest['intro']!.includes('/doc-intro-'),
      `'intro' doit résoudre vers foo/intro.mjs (basename). manifest['intro'] = ${bundler.manifest['intro']}`,
    )
    // doc-intro.mjs reste pleinement joignable via son propre tag qualifié.
    assert.ok(
      bundler.manifest['doc-intro']!.includes('/doc-intro-'),
      `doc-intro.mjs doit rester joignable via <mjs-doc-intro>. manifest['doc-intro'] = ${bundler.manifest['doc-intro']}`,
    )

    await bundler.close()
  })

  // finitions build (correctif A) — cas réel : `doc/doc-search.mjs`
  // et `tuto/tuto-search.mjs` publient TOUS LES DEUX le shortName `search`
  // (préfixe de dossier ancêtre strippé) — ni l'un ni l'autre n'est un
  // basename `search`. AMBIGU par construction : aucun des deux ne doit
  // gagner l'alias court en silence (contrairement à shortName vs basename
  // réel ci-dessus, où le basename tranche). Les tags QUALIFIÉS restent seuls
  // fiables — c'est ce que ce test vérifie, sans warning bloquant.
  it('2 shortNames en collision (2 basenames distincts, ex. doc-search/tuto-search) → aucun warning, clé courte non publiée, les 2 basenames restent joignables', async function () {
    const root = mjsTmp('shortname-vs-shortname')
    const srcDir = join(root, 'src')
    const docDir = join(srcDir, 'doc')
    const tutoDir = join(srcDir, 'tuto')
    mkdirSync(docDir, { recursive: true })
    mkdirSync(tutoDir, { recursive: true })

    writeFileSync(join(docDir, 'doc-search.mjs'), '<div>doc search</div>')
    writeFileSync(join(tutoDir, 'tuto-search.mjs'), '<div>tuto search</div>')

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: join(root, 'out'),
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, 'la compilation ne plante pas')
    const collisionWarnings = stats.warnings.filter(w => /Collision/.test(w))
    assert.equal(collisionWarnings.length, 0,
      `un alias court ambigu (2 shortNames) est sûr par construction → pas de warning. warnings:\n${stats.warnings.join('\n')}`)
    // les 2 vrais composants restent joignables par leur tag qualifié…
    assert.ok(bundler.manifest['doc-search'], 'doc-search doit rester dans le manifest (tag <mjs-doc-search>)')
    assert.ok(bundler.manifest['tuto-search'], 'tuto-search doit rester dans le manifest (tag <mjs-tuto-search>)')
    // … mais la clé courte AMBIGUË n'est publiée pour AUCUN des deux (empoisonnée).
    assert.equal(bundler.manifest['search'], undefined,
      `clé courte ambiguë → ne doit être publiée pour AUCUN des deux. manifest['search'] = ${bundler.manifest['search']}`)

    await bundler.close()
  })
})
