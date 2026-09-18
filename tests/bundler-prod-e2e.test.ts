// Couverture ajoutée — comble un trou de couverture, pas une
// régression : le mode production du bundler (minify esbuild + mangle des
// propriétés `_mjs_*` via un mangleCache partagé, persisté dans
// `<outputDir>/.mangle-cache.json`, déclenché par `forceMinify ||
// NODE_ENV==='production'`, cf. `isProd()` bundler/index.ts) était couvert par
// petits bouts :
//   - minify.test.ts                          : unitaire, minifyJs isolé
//   - bundler-minify-mangle-cache-race.test.ts : concurrence sur un mangleCache
//   - bundler-prod-definition-consistency.test.ts : définition canonique isProd()
//   - ssr-stripesm-minified-production.test.ts : rendu SSR correct en minifié
// Aucun test ne passait par le VRAI `compile()` de bout en bout en mode prod :
// sortie minifiée valide, carnet écrit sur disque, stabilité inter-builds
// (cache navigateur), cohérence inter-fichiers du mangle. C'est ce que couvre
// ce fichier, sur une fixture nominale à 2 composants (`comp-a.mjs`/
// `comp-b.mjs`) qui partagent en dur une prop `_mjs_probe` — ancre
// déterministe : esbuild mangle toute prop `/^_mjs_/` en accès pointé, où
// qu'elle soit dans le bundle.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { parse } from 'acorn'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

// fixture nominale : 2 composants, même prop `_mjs_probe` écrite en clair côté
// user-land, lue à la fois dans un `{if}` et dans le texte du template — les
// deux sites d'accès survivent au mangle (vérifié empiriquement).
const COMP_A = [
  '<script>',
  '$obj = { _mjs_probe: 1 }',
  '</script>',
  '{if $obj._mjs_probe}',
  '  <p class="a">{$obj._mjs_probe}</p>',
  '{end}',
  '<style>',
  '.a',
  '  color: red',
  '</style>',
].join('\n')

const COMP_B = [
  '<script>',
  '$obj = { _mjs_probe: 2 }',
  '</script>',
  '{if $obj._mjs_probe}',
  '  <p class="b">{$obj._mjs_probe}</p>',
  '{end}',
  '<style>',
  '.b',
  '  color: blue',
  '</style>',
].join('\n')

function writeNominalFixture(srcDir: string) {
  writeFileSync(join(srcDir, 'comp-a.mjs'), COMP_A)
  writeFileSync(join(srcDir, 'comp-b.mjs'), COMP_B)
}

// somme des tailles de CHAQUE `.js` de outputDir — jamais les `.js.map`
// (`endsWith('.js')` les exclut déjà, leur suffixe réel est `.map`) ni
// `.mangle-cache.json`, pour comparer prod/dev à contenu équivalent.
function sumJsSize(outDir: string): number {
  let total = 0
  for (const f of readdirSync(outDir)) {
    if (f.endsWith('.js')) total += statSync(join(outDir, f)).size
  }
  return total
}

describe('bundler — build PRODUCTION de bout en bout (minify + mangle + carnet .mangle-cache.json)', function () {
  this.timeout(90000)
  const tmpRoots: string[] = []
  let originalNodeEnv: string | undefined
  // peuplé par le 1er test (taille totale du build dev de référence), relu par le 6e —
  // couplage volontaire (même critère de taille que le 1er test, vs son
  // build dev), mocha exécute ce fichier en séquentiel (pas de --parallel
  // dans `npm test`) donc le 1er test tourne toujours avant le 6e.
  let devTotalBytes: number | undefined

  before(() => { originalNodeEnv = process.env.NODE_ENV })

  after(async () => {
    for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
    await terminateSharedWorkerPool()
  })

  function makeRoot(prefix: string): string {
    const root = mjsTmp(prefix)
    tmpRoots.push(root)
    return root
  }

  async function compileIn(srcDir: string, outDir: string, manifestPath: string, opts: { forceMinify?: boolean } = {}) {
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath, ...opts })
    const stats   = await bundler.compile()
    return { bundler, stats }
  }

  async function buildNominal(prefix: string, opts: { forceMinify?: boolean } = {}) {
    const root   = makeRoot(prefix)
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeNominalFixture(srcDir)
    const manifestPath       = join(root, 'bundle.js')
    const { bundler, stats } = await compileIn(srcDir, outDir, manifestPath, opts)
    return { root, srcDir, outDir, manifestPath, bundler, stats }
  }

  it('build prod nominal : stats.errors vide, ≥2 .js émis et syntaxiquement valides ESM, sortie réellement minifiée (< 80% du dev), carnet écrit', async function () {
    const prod = await buildNominal('prod-e2e-t1-prod', { forceMinify: true })
    assert.equal(prod.stats.errors.length, 0, prod.stats.errors.map((e) => e.message).join('\n'))

    const jsFilesProd = readdirSync(prod.outDir).filter((f) => f.endsWith('.js'))
    assert.ok(jsFilesProd.length >= 2, `au moins 2 .js attendus dans outputDir, reçu : ${jsFilesProd.join(', ')}`)

    for (const f of jsFilesProd) {
      const code = readFileSync(join(prod.outDir, f), 'utf-8')
      assert.doesNotThrow(() => parse(code, { ecmaVersion: 'latest', sourceType: 'module' }), `${f} doit rester un module ESM syntaxiquement valide après minification`)
    }

    // build dev (même fixture, sans force-minify) — garde-fou : neutralise un
    // NODE_ENV=production ambiant le temps de CE build, sinon la comparaison
    // de taille prod/dev perd tout son sens (les deux seraient minifiés).
    const ambientNodeEnv = process.env.NODE_ENV
    if (ambientNodeEnv === 'production') delete process.env.NODE_ENV
    const dev = await buildNominal('prod-e2e-t1-dev')
    if (ambientNodeEnv === 'production') process.env.NODE_ENV = ambientNodeEnv
    assert.equal(dev.stats.errors.length, 0, dev.stats.errors.map((e) => e.message).join('\n'))

    const prodBytes = sumJsSize(prod.outDir)
    devTotalBytes   = sumJsSize(dev.outDir)
    assert.ok(
      prodBytes < 0.8 * devTotalBytes,
      `sortie prod (${prodBytes} o) doit peser moins de 80% de la sortie dev (${devTotalBytes} o) — preuve d'une minification réelle`,
    )

    const cachePath = join(prod.outDir, '.mangle-cache.json')
    assert.ok(existsSync(cachePath), 'le carnet .mangle-cache.json doit exister dans outputDir en build prod')
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'))
    assert.ok(cache && typeof cache === 'object' && !Array.isArray(cache), 'le carnet doit être un objet JSON valide')
    assert.ok(Object.keys(cache).length >= 1, 'le carnet doit contenir au moins une clé manglée')

    await prod.bundler.close()
    await dev.bundler.close()
  })

  it('le carnet rend le build STABLE : une 2e instance Bundler (mêmes dossiers, sources inchangées) reproduit exactement les mêmes fichiers hashés et le même carnet', async function () {
    const build1 = await buildNominal('prod-e2e-t2', { forceMinify: true })
    assert.equal(build1.stats.errors.length, 0, build1.stats.errors.map((e) => e.message).join('\n'))
    await build1.bundler.close()

    const filesBefore = readdirSync(build1.outDir).sort()
    const cacheBefore = JSON.parse(readFileSync(join(build1.outDir, '.mangle-cache.json'), 'utf-8'))

    const { bundler: bundler2, stats: stats2 } = await compileIn(build1.srcDir, build1.outDir, build1.manifestPath, { forceMinify: true })
    assert.equal(stats2.errors.length, 0, stats2.errors.map((e) => e.message).join('\n'))
    await bundler2.close()

    const filesAfter = readdirSync(build1.outDir).sort()
    const cacheAfter = JSON.parse(readFileSync(join(build1.outDir, '.mangle-cache.json'), 'utf-8'))

    assert.deepEqual(
      filesAfter, filesBefore,
      'le 2e build (nouvelle instance, sources inchangées) doit émettre EXACTEMENT les mêmes noms de fichiers hashés — sinon le cache navigateur est invalidé gratuitement',
    )
    assert.deepEqual(cacheAfter, cacheBefore, 'le carnet doit être identique entre les deux builds (mangle stable grâce à la persistance)')
  })

  it('cohérence inter-fichiers du mangle : comp-a et comp-b reçoivent le MÊME nom court pour _mjs_probe, en accès pointé, et plus jamais la chaîne _mjs_probe', async function () {
    const prod = await buildNominal('prod-e2e-t3', { forceMinify: true })
    assert.equal(prod.stats.errors.length, 0, prod.stats.errors.map((e) => e.message).join('\n'))
    await prod.bundler.close()

    const cache     = JSON.parse(readFileSync(join(prod.outDir, '.mangle-cache.json'), 'utf-8'))
    const shortName = cache._mjs_probe
    assert.ok(typeof shortName === 'string' && shortName.length > 0, `le carnet doit mapper _mjs_probe vers un nom court, reçu : ${JSON.stringify(cache)}`)

    const files     = readdirSync(prod.outDir)
    const compAFile = files.find((f) => /^comp-a-[a-f0-9]{8}\.js$/.test(f))
    const compBFile = files.find((f) => /^comp-b-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(compAFile, 'comp-a-<hash>.js doit avoir été émis')
    assert.ok(compBFile, 'comp-b-<hash>.js doit avoir été émis')

    const codeA    = readFileSync(join(prod.outDir, compAFile as string), 'utf-8')
    const codeB    = readFileSync(join(prod.outDir, compBFile as string), 'utf-8')
    const dottedRe = new RegExp(`\\.${shortName}\\b`)

    assert.match(codeA, dottedRe, `comp-a.js doit accéder à la prop manglée en notation pointée .${shortName}`)
    assert.match(codeB, dottedRe, `comp-b.js doit accéder à la prop manglée en notation pointée .${shortName}`)
    assert.doesNotMatch(codeA, /_mjs_probe/, 'comp-a.js ne doit plus jamais contenir la chaîne _mjs_probe après mangle')
    assert.doesNotMatch(codeB, /_mjs_probe/, 'comp-b.js ne doit plus jamais contenir la chaîne _mjs_probe après mangle')
  })

  it('rien ne passe silencieusement en prod : le motif V0.1.1 (réparé à la racine par closeRhs) build VERT avec un ESM valide même en force-minify, et un composant VRAIMENT cassé échoue toujours', async function () {
    // motif V0.1.1 (RHS entièrement parenthésé d'un deep-set de store
    // singleton) : AVANT le fix racine `closeRhs()` (path-tracker.ts),
    // le generator fuyait une parenthèse orpheline et ce build prod MENTAIT
    // (vert avec un ESM invalide) — l'ancienne version de ce test attendait donc
    // des erreurs. Le fix livré, le jumeau bundler-esm-check.test.ts a été
    // inversé (build vert exigé) ; ce test suit : build VERT + chunk émis
    // parsable en ESM, y compris en force-minify.
    const rootA   = makeRoot('prod-e2e-t4a')
    const srcDirA = join(rootA, 'src')
    mkdirSync(srcDirA, { recursive: true })
    writeFileSync(join(srcDirA, 'comp.mjs'), [
      '<script>',
      '$$boot = {wallet: {coins: 0}}',
      '$$boot.wallet.coins = (($$boot.wallet.coins or 0) + 1)',
      '</script>',
      '<p>{$$boot.wallet.coins}</p>',
    ].join('\n'))
    const runA = await compileIn(srcDirA, join(rootA, 'out'), join(rootA, 'bundle.js'), { forceMinify: true })
    await runA.bundler.close()
    assert.equal(runA.stats.errors.length, 0, 'motif V0.1.1 : build VERT attendu (fix racine closeRhs livré) — ' + runA.stats.errors.map((e) => e.message).join('\n'))
    const filesA    = readdirSync(join(rootA, 'out'))
    const compFileA = filesA.find((f) => /^comp-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(compFileA, 'comp-<hash>.js doit avoir été émis')
    const codeA = readFileSync(join(rootA, 'out', compFileA as string), 'utf-8')
    assert.doesNotThrow(() => parse(codeA, { ecmaVersion: 'latest', sourceType: 'module' }), 'sortie minifiée invalide (parenthèse orpheline ?)')

    // L'intention historique de ce test (« jamais silencieux ») reste
    // couverte avec un composant VRAIMENT cassé (parenthèse jamais fermée).
    // Le seul motif connu qui TRAVERSAIT le transpiler en émettant un ESM
    // invalide était précisément V0.1.1 (réparé) — un cassé franc échoue donc
    // plus tôt (transpiler), et `stats.errors` ne doit JAMAIS rester vide.
    const rootB   = makeRoot('prod-e2e-t4b')
    const srcDirB = join(rootB, 'src')
    mkdirSync(srcDirB, { recursive: true })
    writeFileSync(join(srcDirB, 'comp.mjs'), [
      '<script>',
      'x := ((1',
      '</script>',
      '<p>{x}</p>',
    ].join('\n'))
    const runB = await compileIn(srcDirB, join(rootB, 'out'), join(rootB, 'bundle.js'), { forceMinify: true })
    await runB.bundler.close()
    assert.ok(runB.stats.errors.length > 0, 'un composant cassé ne doit JAMAIS produire un build vert (stats.errors vide), même en prod')
  })

  it('carnet .mangle-cache.json corrompu sur disque : la construction du Bundler ne throw pas, compile() réussit, et le carnet réécrit est du JSON valide', async function () {
    const root   = makeRoot('prod-e2e-t5')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, '.mangle-cache.json'), '{invalid')
    writeNominalFixture(srcDir)

    let bundler: Bundler | undefined
    let constructionError: Error | undefined
    try {
      bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), forceMinify: true })
    } catch (e: any) {
      constructionError = e
    }
    assert.equal(constructionError, undefined, `la construction ne doit JAMAIS throw sur un carnet corrompu — reçu : ${constructionError?.message}`)
    assert.ok(bundler, 'le Bundler doit être construit malgré le carnet corrompu')

    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e) => e.message).join('\n'))
    await bundler.close()

    const rewritten = readFileSync(join(outDir, '.mangle-cache.json'), 'utf-8')
    assert.doesNotThrow(() => JSON.parse(rewritten), "le carnet réécrit après un compile réussi doit être du JSON valide, même parti d'un carnet corrompu")
  })

  it("NODE_ENV=production SEUL ne minifie plus rien : c'est la commande qui dit l'environnement", async function () {
    assert.ok(typeof devTotalBytes === 'number', 'le 1er test doit avoir tourné avant celui-ci et peuplé la taille de référence dev (couplage volontaire, cf. en-tête du describe)')

    process.env.NODE_ENV = 'production'
    try {
      const root   = makeRoot('prod-e2e-t6')
      const srcDir = join(root, 'src')
      mkdirSync(srcDir, { recursive: true })
      writeNominalFixture(srcDir)

      const { bundler, stats } = await compileIn(srcDir, join(root, 'out'), join(root, 'bundle.js'))
      assert.equal(stats.errors.length, 0, stats.errors.map((e) => e.message).join('\n'))
      await bundler.close()

      const size = sumJsSize(join(root, 'out'))
      assert.ok(
        size > 0.8 * (devTotalBytes as number),
        `AVANT ce correctif, un NODE_ENV=production qui traînait dans le shell minifiait tout seul : la sortie (${size} o) doit maintenant rester du même ordre que le dev de référence (${devTotalBytes} o)`,
      )
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalNodeEnv
    }
  })
})
