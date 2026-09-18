// Test de régression — convention `.page.mjs` pour les
// modules qui déclarent un bloc <routes>, la directive @routes ou une balise <@view>. Hors d'un
// tel fichier, ces trois formes sont un refus de compilation. Sur le modèle de
// tests/bundler-failed-component-honest-build.test.ts (Bundler réel + projet jetable).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { t } from '../src/messages/index.js'

function makeProject() {
  const root = mjsTmp('page-module')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { srcDir, outDir, manifest: join(root, 'bundle.js') }
}

// contenu du fichier hashé publié sous la clé `nom` du manifeste
function readCompiled(outDir: string, stats: { manifest: Record<string, string> }, nom: string): string {
  const filename = stats.manifest[nom]!.split('/').pop()!
  return readFileSync(join(outDir, filename), 'utf-8')
}

describe('convention .page.mjs — bloc <routes>, directive @routes, balise <@view>', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('accueil.page.mjs (bloc <routes> + <@view>) compile : tag mjs-accueil, clé manifeste accueil, aucun point dans le tag', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'accueil.page.mjs'), [
      '<routes target="outlet">',
      '  /   home',
      '</routes>',
      '',
      '<@view outlet>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(stats.manifest['accueil'], "clé de manifeste attendue : 'accueil' (marqueur .page retiré)")
    assert.equal(stats.manifest['accueil.page'], undefined, "aucune clé ne doit porter le marqueur .page")

    const js = readCompiled(outDir, stats, 'accueil')
    assert.ok(js.includes('µ._def("mjs-accueil"'), `tag mjs-accueil attendu, reçu :\n${js.slice(0, 300)}`)
    assert.ok(!js.includes('mjs-accueil.page'), 'aucun point ne doit survivre dans le tag')

    await bundler.close()
  })

  it('le même contenu dans accueil.mjs (sans marqueur) : build en échec, message citant le fichier et la forme (bloc <routes>)', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'accueil.mjs'), [
      '<routes target="outlet">',
      '  /   home',
      '</routes>',
      '',
      '<@view outlet>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'accueil.mjs doit échouer : bloc <routes> hors fichier .page.mjs')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /accueil\.mjs/, `le fichier fautif doit être nommé : ${msg}`)
    assert.ok(msg.includes(t('transpiler.page-forme-bloc-routes')), `la forme trouvée (bloc <routes>) doit être citée : ${msg}`)
    assert.ok(msg.includes('accueil.page.mjs'), `le remède (renommage) doit être cité : ${msg}`)

    await bundler.close()
  })

  it('composant ordinaire sans routage dans x.mjs : inchangé', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'x.mjs'), '<p>bonjour</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(stats.manifest['x'])
    const js = readCompiled(outDir, stats, 'x')
    assert.ok(js.includes('µ._def("mjs-x"'))

    await bundler.close()
  })

  it('.page.mjs SANS aucun routage : autorisé, aucun avertissement lié au marqueur', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'simple.page.mjs'), '<p>rien de spécial</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(stats.manifest['simple'])
    assert.ok(!stats.warnings.some(w => w.includes('.page.mjs')), `aucun avertissement attendu : ${stats.warnings.join('\n')}`)

    await bundler.close()
  })

  it('directive @routes seule (sans bloc ni vue) dans y.mjs : refus, forme citée = directive @routes', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'y.mjs'), [
      '<script>',
      '  @routes =',
      "    'outlet':",
      "      '/': 'home'",
      '</script>',
      '<p>ok</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'y.mjs doit échouer : directive @routes hors fichier .page.mjs')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /y\.mjs/)
    assert.ok(msg.includes(t('transpiler.page-forme-directive-routes')), `forme directive @routes attendue : ${msg}`)

    await bundler.close()
  })

  it('balise <@view> seule (sans bloc ni directive) dans z.mjs : refus, forme citée = balise <@view>', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'z.mjs'), '<@view outlet>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'z.mjs doit échouer : <@view> hors fichier .page.mjs')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /z\.mjs/)
    assert.ok(msg.includes(t('transpiler.page-forme-vue')), `forme <@view> attendue : ${msg}`)

    await bundler.close()
  })

  it('<@view> vivant dans un partial _main.mjs inclus par accueil.page.mjs : autorisé (hôte compte)', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, '_main.mjs'), '<@view outlet>')
    writeFileSync(join(srcDir, 'accueil.page.mjs'), '<@include main>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(stats.manifest['accueil'])

    await bundler.close()
  })

  it('le même partial _main.mjs inclus par accueil.mjs (non-page) : refus nommant l\'hôte', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, '_main.mjs'), '<@view outlet>')
    writeFileSync(join(srcDir, 'accueil.mjs'), '<@include main>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'accueil.mjs doit échouer : <@view> du partial compte pour son hôte')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /accueil\.mjs/, `l'hôte doit être nommé, jamais le partial : ${msg}`)
    assert.ok(!msg.includes('_main.mjs'), `le partial ne doit jamais être cité : ${msg}`)
    assert.ok(msg.includes(t('transpiler.page-forme-vue')))

    await bundler.close()
  })

  it('@routes et <routes> cités en exemple dans un <pre><code> (échappé ET mention brute) : aucune erreur', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'doc.mjs'), [
      '<p>Un composant déclare ses routes via <code>@routes</code>, un objet à deux niveaux.</p>',
      '<pre><code>&lt;routes target="outlet"&gt;',
      '  /   home',
      '&lt;/routes&gt;</code></pre>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `un exemple de doc ne doit jamais déclencher la garde : ${stats.errors.map(e => e.message).join('\n')}`)
    assert.ok(stats.manifest['doc'])

    await bundler.close()
  })

  // µurlChange n'est PAS une des trois formes visées par la règle
  // (bloc <routes> / directive @routes / balise <@view>) : un composant peut réagir aux
  // changements d'URL (fil d'Ariane, titre, analytics) sans être lui-même une page routée. La
  // garde reste donc SILENCIEUSE sur µurlChange seul.
  it('µurlChange seul (sans routes ni vue) dans w.mjs : autorisé, .page.mjs non exigé', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'w.mjs'), [
      '<script>',
      '  µurlChange (path, params) ->',
      '    console.log path',
      '</script>',
      '<p>ok</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(stats.manifest['w'])

    await bundler.close()
  })

  it('x.page.mjs et x.mjs côte à côte : collision de basename (même mécanisme que 2 composants homonymes)', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'x.mjs'), '<p>A</p>')
    writeFileSync(join(srcDir, 'x.page.mjs'), '<p>B</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, 'ni x.mjs ni x.page.mjs ne déclare de routage : pas d\'erreur de garde')
    assert.ok(stats.manifest['x'], "la clé 'x' doit exister (l'un des deux gagne)")
    const warningsJoined = stats.warnings.join('\n')
    assert.ok(warningsJoined.includes('<mjs-x>'), `collision de basename attendue (même mécanisme qu'un doublon .mjs) : ${warningsJoined}`)

    await bundler.close()
  })

  // DÉFAUT 1 — un fichier nommé JUSTE `.page.mjs`
  // (rien avant le marqueur) fait rendre `pageAwareBaseName` une chaîne VIDE : tag
  // `customElements.define("mjs-", …)` et clé de manifeste vide, sans un mot. Refusé désormais,
  // même famille de garde que `bundler.theme-nom-fichier` (bundler/themes.ts) pour `.theme.mjs` seul.
  it('.page.mjs seul (rien avant le marqueur) : refus, nom de page vide cité', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, '.page.mjs'), '<p>vide</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, '.page.mjs (nom vide une fois le marqueur retiré) doit échouer')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /\.page\.mjs/, `le fichier fautif doit être nommé : ${msg}`)
    assert.equal(stats.manifest[''], undefined, 'aucune clé de manifeste vide ne doit exister')

    await bundler.close()
  })

  // `x.PAGE.mjs` est bien
  // refusé (le marqueur est sensible à la casse, comme `.theme`), mais le remède proposait
  // « renomme-le en x.PAGE.page.mjs » : absurde, ça garde la casse fautive ET ajoute un second
  // marqueur. Le remède doit proposer le nom PROPRE : le marqueur `.page` résiduel (n'importe
  // quelle casse) retiré, puis `.page.mjs` canonique.
  it('x.PAGE.mjs (casse fausse du marqueur) : refus, remède propose x.page.mjs — jamais x.PAGE.page.mjs', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'x.PAGE.mjs'), '<@view outlet>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'x.PAGE.mjs doit échouer : marqueur sensible à la casse, comme .theme')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /x\.PAGE\.mjs/, `le fichier fautif doit être nommé : ${msg}`)
    assert.ok(msg.includes('x.page.mjs'), `le remède doit proposer le nom PROPRE (x.page.mjs) : ${msg}`)
    assert.ok(!msg.includes('x.PAGE.page.mjs'), `le remède ne doit plus proposer le nom absurde : ${msg}`)

    await bundler.close()
  })

  // marqueur en DOUBLE, `x.page.page.mjs` : aujourd'hui `pageAwareBaseName` ne
  // retire QUE le dernier `.page`, le tag garde un point (`mjs-x.page`). DÉCISION : refusé (comme
  // le nom vide du défaut 1), pas de retrait en boucle — cf. le commentaire de `pageAwareBaseName`
  // pour la justification (kebab-case obligatoire, docs/02-composant.md ; un point résiduel n'est
  // jamais un nom de fichier légitime, même contrainte que themeNameOf pour les thèmes).
  it('x.page.page.mjs (marqueur en double) : refus explicite plutôt qu\'un tag mjs-x.page', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'x.page.page.mjs'), '<p>ok</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'x.page.page.mjs doit échouer : marqueur en double')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /x\.page\.page\.mjs/, `le fichier fautif doit être nommé : ${msg}`)
    assert.ok(msg.includes('x.page.mjs'), `le remède doit proposer le nom canonique (x.page.mjs) : ${msg}`)
    assert.equal(stats.manifest['x.page'], undefined, 'aucune clé ne doit porter un point résiduel')

    await bundler.close()
  })
})
