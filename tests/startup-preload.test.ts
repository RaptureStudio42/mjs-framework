// démarrage d'une page prérendue — `render.startup: 'preload'` (défaut) : le fragment figé porte
// lui-même un `<link rel="modulepreload">` par unité de son ensemble de démarrage, sans attendre que
// le manifeste (téléchargé puis exécuté) découvre les balises de la page.
//
// L'ensemble de démarrage = les clés de `µ.paths` dont la balise `mjs-<clé>` est dans le HTML
// prérendu, FERMÉ par la table des dépendances directes (`µDeps`) : un enfant qu'un `{if}` faux n'a
// pas rendu est quand même préchargé (il s'affichera au premier clic), et le module `@import`-é par
// un composant de la page l'est aussi.
//
// Mini-projet 2 routes, moteur happy-dom (aucun navigateur à lancer), construction de
// développement sauf mention contraire. La transmission de la clé depuis mjs.config.json jusqu'au
// fragment est prouvée EN PLUS par un vrai sous-processus `mjs build` (cf. dernier bloc).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts, type RenderConfig } from '../src/bundler/config.js'
import { prerenderPages, type PrerenderReport } from '../src/server/prerender.js'
import { emitStartup, type StartupReport } from '../src/bundler/startup.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

interface Projet { root: string; srcDir: string; outDir: string }

// accueil : 2 enfants rendus (`mjs-card`, `mjs-badge`), 1 enfant dans un `{if}` faux (`mjs-later`,
// jamais rendu mais dépendance directe), 1 module `@import`-é ; à-propos : un seul enfant à elle
// (`mjs-aside`) ; `mjs-orphan` n'est cité par personne.
function fixture(prefix: string, render: RenderConfig): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'shared.module.civet'), 'export bump := (x) -> x + 1\n')
  writeFileSync(join(srcDir, 'card.mjs'), '<p class="card">carte</p>\n')
  writeFileSync(join(srcDir, 'badge.mjs'), '<b class="badge">neuf</b>\n')
  writeFileSync(join(srcDir, 'later.mjs'), '<p class="later">plus tard</p>\n')
  writeFileSync(join(srcDir, 'aside.mjs'), '<aside class="aside">côté</aside>\n')
  writeFileSync(join(srcDir, 'orphan.mjs'), '<p class="orphan">personne</p>\n')
  writeFileSync(join(srcDir, 'home.mjs'), [
    '@import bump \'shared.module.civet\'',
    '',
    '<script>',
    '$open ?= false',
    '</script>',
    '',
    '<h1 class="t">accueil {bump(1)}</h1>',
    '<mjs-card></mjs-card>',
    '<mjs-badge></mjs-badge>',
    '{if $open}<mjs-later></mjs-later>{end}'
  ].join('\n') + '\n')
  writeFileSync(join(srcDir, 'about.mjs'), '<h2 class="a">à propos</h2>\n<mjs-aside></mjs-aside>\n')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', render }, null, 2))
  return { root, srcDir, outDir }
}

// second jeu : une balise citée dans une VALEUR D'ATTRIBUT, dans un COMMENTAIRE ou dans la FEUILLE
// DE STYLE du composant n'est pas une balise de la page (les trois composants existent pourtant,
// `mjs-attribut`, `mjs-fantome` et `mjs-brut`), et
// `ui/ui-chip.mjs` publie DEUX clés de manifeste pour un seul fichier (`ui-chip` + l'alias `chip`).
function fixturePieges(prefix: string): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(join(srcDir, 'ui'), { recursive: true })
  writeFileSync(join(srcDir, 'card.mjs'), '<p class="card">carte</p>\n')
  writeFileSync(join(srcDir, 'attribut.mjs'), '<p class="attribut">cité dans un attribut</p>\n')
  writeFileSync(join(srcDir, 'fantome.mjs'), '<p class="fantome">cité dans un commentaire</p>\n')
  writeFileSync(join(srcDir, 'brut.mjs'), '<p class="brut">cité dans une feuille de style</p>\n')
  writeFileSync(join(srcDir, 'ui', 'ui-chip.mjs'), '<span class="chip">puce</span>\n')
  writeFileSync(join(srcDir, 'home.mjs'), [
    '<script>',
    'GABARIT := \'<mjs-attribut></mjs-attribut>\'',
    '</script>',
    '',
    '<style>',
    '  .t::after',
    '    content: \'<mjs-brut></mjs-brut>\'',
    '</style>',
    '',
    '<h1 class="t">accueil</h1>',
    '<mjs-card></mjs-card>',
    '<mjs-chip></mjs-chip>',
    '<mjs-ui-chip></mjs-ui-chip>',
    '<div data-gabarit={GABARIT}>x</div>',
    '<!-- <mjs-fantome></mjs-fantome> -->',
  ].join('\n') + '\n')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js',
    render: { default: 'prerender', engine: { prerender: 'happy-dom' }, routes: { '/': { component: 'mjs-home' } } },
  }, null, 2))
  return { root, srcDir, outDir }
}

function renderBase(extra: Record<string, unknown> = {}, home: Record<string, unknown> = {}, about: Record<string, unknown> = {}): RenderConfig {
  return {
    default: 'prerender',
    engine: { prerender: 'happy-dom' },
    routes: { '/': { component: 'mjs-home', ...home }, '/about': { component: 'mjs-about', ...about } },
    ...extra,
  } as RenderConfig
}

// construit (Bundler), prérend, puis émet l'en-tête de démarrage — même ordre que `mjs build`
async function construire(p: Projet, env: 'dev' | 'prod' = 'dev'): Promise<{ bundler: Bundler; report: PrerenderReport; startup: StartupReport }> {
  const found = findConfig(p.root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const bundler = new Bundler({ ...resolveBundlerOpts(found!.config, found!.configDir), env } as any)
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const report  = await prerenderPages(found!.config, found!.configDir, () => {}, { env })
  const startup = await emitStartup(bundler, found!.config.render, report, { prod: env === 'prod' })
  await bundler.close()
  return { bundler, report, startup }
}

// hrefs des `<link rel="modulepreload">` du fragment, dans l'ordre du fichier
function liens(fichier: string): string[] {
  return [...readFileSync(fichier, 'utf-8').matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1])
}

function fragment(report: PrerenderReport, url: string): string {
  const page = report.generated.find(g => g.url === url)
  assert.ok(page, `la page ${url} doit être générée`)
  return page!.file
}

describe('démarrage des pages prérendues — préchargement', function () {
  this.timeout(120000)

  after(async () => { await terminateSharedWorkerPool() })

  it('le fragment porte un lien par unité de son ensemble de démarrage, fermeture µDeps comprise', async () => {
    const p = fixture('startup-preload', renderBase())
    const { report, startup } = await construire(p)
    const home = fragment(report, '/')
    const texte = readFileSync(home, 'utf-8')

    // les balises rendues sont bien relevées par le prérendu
    const tags = report.generated.find(g => g.url === '/')!.tags
    assert.deepEqual(tags, ['mjs-badge', 'mjs-card', 'mjs-home'], `balises relevées : ${tags.join(', ')}`)

    // l'ensemble : les 3 composants rendus + l'enfant du `{if}` faux + le module `@import`-é
    const noms = startup.pages.find(pg => pg.url === '/')!.names
    assert.deepEqual(noms, ['badge', 'card', 'home', 'later', 'shared.module'], `ensemble : ${noms.join(', ')}`)

    // un lien par unité, dans l'ordre des noms, et rien pour le composant que personne ne cite
    const hrefs = liens(home)
    assert.equal(hrefs.length, 5, `5 liens attendus, vus : ${hrefs.join(' ')}`)
    assert.equal(hrefs.some(h => /orphan/.test(h)), false, 'aucun lien vers un composant absent de la page')
    assert.equal(hrefs.some(h => /\baside/.test(h)), false, 'aucun lien vers un composant de l\'AUTRE page')
    for (const h of hrefs) assert.ok(existsSync(join(p.outDir, basename(h))), `${h} doit exister sur disque`)

    // en tête du fragment : le bandeau, puis l'en-tête de démarrage borné par ses lignes-repères
    // (elles délimitent ce que le prérendu retire avant de comparer son corps), avant le HTML
    const lignes = texte.split('\n')
    assert.match(lignes[0], /^<!-- mjs:prerender /, 'le bandeau, marque en tête, reste la première ligne')
    assert.equal(lignes[1], '<!-- mjs:demarrage -->', 'la ligne-repère ouvre l\'en-tête, juste sous le bandeau')
    assert.match(lignes[2], /^<link rel="modulepreload"/, 'les liens suivent la ligne-repère')
    assert.equal(lignes[2 + hrefs.length], '<!-- /mjs:demarrage -->', 'la ligne-repère ferme l\'en-tête après le dernier lien')
    assert.ok(texte.indexOf('<mjs-home') > texte.lastIndexOf('<link rel="modulepreload"'), 'les liens précèdent le HTML de la page')

    // aucune fiche de fichier de page en mode 'preload'
    assert.equal(texte.includes('__mjs_page'), false, 'aucune fiche __mjs_page hors du mode bundle')
    assert.deepEqual(startup.pageFiles, [], 'aucun fichier de page assemblé')
  })

  it('chaque page a SON ensemble : la seconde route ne précharge que ses propres unités', async () => {
    const p = fixture('startup-preload-2', renderBase())
    const { report } = await construire(p)
    const hrefs = liens(fragment(report, '/about'))
    const noms  = hrefs.map(h => basename(h).replace(/-[a-f0-9]{8}\.js$/, '')).sort()
    assert.deepEqual(noms, ['about', 'aside'], `unités de /about : ${noms.join(', ')}`)
  })

  it("startup: 'none' : aucun lien ajouté au fragment", async () => {
    const p = fixture('startup-none', renderBase({ startup: 'none' }))
    const { report, startup } = await construire(p)
    assert.deepEqual(liens(fragment(report, '/')), [])
    assert.deepEqual(liens(fragment(report, '/about')), [])
    assert.equal(startup.written, 0, 'aucun fragment réécrit')
  })

  it('une route surcharge le mode du bloc render', async () => {
    const p = fixture('startup-route', renderBase({ startup: 'none' }, {}, { startup: 'preload' }))
    const { report } = await construire(p)
    assert.deepEqual(liens(fragment(report, '/')), [], 'la page qui hérite de none n\'a aucun lien')
    assert.equal(liens(fragment(report, '/about')).length, 2, '/about surcharge en preload')
  })

  it('les mêmes liens en construction de production', async () => {
    const p = fixture('startup-preload-prod', renderBase())
    const { report } = await construire(p, 'prod')
    const hrefs = liens(fragment(report, '/'))
    assert.equal(hrefs.length, 5, `5 liens attendus, vus : ${hrefs.join(' ')}`)
    for (const h of hrefs) assert.ok(existsSync(join(p.outDir, basename(h))), `${h} doit exister sur disque`)
  })

  it('une balise citée dans une valeur d\'attribut, dans un commentaire ou dans une feuille de style n\'est pas une balise de la page', async () => {
    const p = fixturePieges('startup-tags-pieges')
    const { report, startup } = await construire(p)
    const page = report.generated.find(g => g.url === '/')!
    const tags = page.tags
    assert.equal(tags.includes('mjs-attribut'), false, `balises relevées : ${tags.join(', ')}`)
    assert.equal(tags.includes('mjs-fantome'), false, `balises relevées : ${tags.join(', ')}`)
    // le `<style>` du composant EST dans le fragment (feuille du shadow) : son contenu est du texte
    // brut, jamais du balisage — la citation du `content:` n'affiche aucun composant
    assert.match(readFileSync(page.file, 'utf-8'), /<mjs-brut><\/mjs-brut>/, 'la citation est bien dans le fragment, dans le <style>')
    assert.equal(tags.includes('mjs-brut'), false, `balises relevées : ${tags.join(', ')}`)
    const noms = startup.pages.find(pg => pg.url === '/')!.names
    assert.equal(noms.includes('attribut'), false, `ensemble de démarrage : ${noms.join(', ')}`)
    assert.equal(noms.includes('fantome'), false, `ensemble de démarrage : ${noms.join(', ')}`)
    assert.equal(noms.includes('brut'), false, `ensemble de démarrage : ${noms.join(', ')}`)
    const hrefs = liens(fragment(report, '/'))
    assert.equal(hrefs.some(h => /\/(attribut|fantome|brut)-[a-f0-9]{8}\.js$/.test(h)), false, `liens : ${hrefs.join(' ')}`)
  })

  it('deux noms de manifeste pour un seul fichier (alias de dossier) : un seul lien', async () => {
    const p = fixturePieges('startup-alias')
    const { report, startup } = await construire(p)
    const noms = startup.pages.find(pg => pg.url === '/')!.names
    assert.ok(noms.includes('chip') && noms.includes('ui-chip'), `les deux noms restent dans l'ensemble : ${noms.join(', ')}`)
    const hrefs = liens(fragment(report, '/'))
    assert.deepEqual(hrefs, [...new Set(hrefs)], `un lien par fichier, vus : ${hrefs.join(' ')}`)
  })

  it('un fragment dont le corps ne change pas n\'est pas retouché par la construction suivante', async () => {
    const p = fixture('startup-non-retouche', renderBase())
    const premier = await construire(p)
    const file  = fragment(premier.report, '/')
    const avant = statSync(file, { bigint: true }).mtimeNs
    const texte = readFileSync(file, 'utf-8')
    // toute réécriture porterait une date neuve : l'horloge doit avoir avancé entre les deux passes
    await new Promise(r => setTimeout(r, 50))
    const second = await construire(p)
    assert.equal(second.startup.written, 0, 'aucun en-tête à reposer')
    assert.equal(readFileSync(file, 'utf-8'), texte, 'fragment identique au bit près')
    assert.equal(statSync(file, { bigint: true }).mtimeNs, avant, 'le fragment n\'est pas réécrit du tout')
  })

  it('réécriture sautée quand le fragment porte déjà les bons liens', async () => {
    const p = fixture('startup-idempotent', renderBase())
    const found = findConfig(p.root)
    const bundler = new Bundler({ ...resolveBundlerOpts(found!.config, found!.configDir), env: 'dev' } as any)
    await bundler.compile()
    const report = await prerenderPages(found!.config, found!.configDir, () => {}, { env: 'dev' })
    const premier = await emitStartup(bundler, found!.config.render, report, { prod: false })
    assert.equal(premier.written, 2, 'les 2 fragments reçoivent leur en-tête')
    const second = await emitStartup(bundler, found!.config.render, report, { prod: false })
    await bundler.close()
    assert.equal(second.written, 0, 'rien à réécrire au second passage')
  })

  it("`mjs build` transmet render.startup de mjs.config.json jusqu'au fragment", () => {
    const p = fixture('startup-cli', renderBase())
    const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--root', p.root], { cwd: repoRoot, encoding: 'utf-8' })
    assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
    const hrefs = liens(join(p.root, 'mjs_pages', 'index.html'))
    assert.equal(hrefs.length, 5, `5 liens attendus, vus : ${hrefs.join(' ')}`)
  })
})
