// cascade de modules à 3 niveaux et plus — la table des dépendances DIRECTES écrite
// à la construction (µDeps) + le préchargement posé par bundle.js AVANT d'importer le
// cœur : le navigateur télécharge en parallèle ce que l'Autoloader aurait sinon
// découvert un par un, à la file (mesuré sur l'appli météo du banc : 8 niveaux).
//
// Projet minimal : A utilise B, B utilise C ET importe un module M ; D n'est jamais
// placé dans la page (compilé — le bundler compile tout `sourceDir` — mais jamais
// référencé). `urlPrefix` pointe l'outputDir ABSOLU du disque : les chemins écrits au
// manifeste sont alors des chemins de FICHIER réels, `import()` dynamique les résout
// donc VRAIMENT dans happy-dom (son `eval()` délègue à l'`import()` natif de Node,
// qui sait résoudre un chemin absolu — vérifié : un chemin `/assets/...` classique,
// lui, ne résout nulle part hors navigateur réel).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { getViewerScript, JOURNAL_VIEWER } from '../src/server/viewer-page.js'
import { stripEsm } from '../src/server/renderToString.js'
import { mjsTmp } from './helpers/tmp.js'

function makeProject(): { srcDir: string; outDir: string; manifestPath: string } {
  const root = mjsTmp('cascade-preload')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'a.mjs'), '<@b></@b>\n')
  writeFileSync(join(srcDir, 'b.mjs'), [
    "@import M 'm.module.civet'",
    '<script>val = M</script>',
    '<@c></@c>',
  ].join('\n'))
  writeFileSync(join(srcDir, 'c.mjs'), '<p>c</p>\n')
  writeFileSync(join(srcDir, 'd.mjs'), '<p>jamais placé dans la page</p>\n')
  writeFileSync(join(srcDir, 'm.module.civet'), 'export M = 1\n')
  return { srcDir, outDir, manifestPath: join(root, 'bundle.js') }
}

async function buildProject(): Promise<{ outDir: string; manifestPath: string; bundler: Bundler }> {
  const { srcDir, outDir, manifestPath } = makeProject()
  // urlPrefix = outDir ABSOLU (astuce de test — cf. bandeau de tête) : par défaut
  // (dérivé de outputDir) les chemins seraient `/out/…`, jamais résolubles ici.
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath, urlPrefix: outDir })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
  return { outDir, manifestPath, bundler }
}

/** Extrait un `const µNOM = {...};` du manifeste (µPaths/µDeps — cf. writeManifest). */
function extractConst(manifestSrc: string, name: string): any {
  const marker = `const ${name} = `
  const line = manifestSrc.split('\n').find(l => l.startsWith(marker))
  assert.ok(line, `manifeste sans ligne ${marker}`)
  return JSON.parse(line!.slice(marker.length).replace(/;$/, ''))
}

describe('bundler — writeManifest() : cascade de modules, table des dépendances directes (µDeps)', function () {
  this.timeout(30000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('µDeps porte A→[B], B→[C, m.module] ; rien pour C ; D absent de TOUTE la table (jamais référencé)', async function () {
    const { manifestPath } = await buildProject()
    const manifestSrc = readFileSync(manifestPath, 'utf-8')
    const deps = extractConst(manifestSrc, 'µDeps')

    assert.deepEqual(deps.a, ['b'], `A doit dépendre de B seul :\n${JSON.stringify(deps)}`)
    assert.deepEqual(deps.b, ['c', 'm.module'], `B doit dépendre de C et du module M :\n${JSON.stringify(deps)}`)
    assert.equal(deps.c, undefined, 'C (feuille, sans dépendance) ne doit porter aucune entrée')
    assert.equal(deps.d, undefined, 'D (jamais référencé) ne doit porter aucune entrée')
    for (const [name, list] of Object.entries(deps)) {
      assert.ok(!(list as string[]).includes('d'), `D ne doit apparaître dans AUCUNE liste de dépendances (trouvé sous ${name})`)
    }
  })

  it('µPaths reste la table complète (A, B, C, D, M cœur y compris) — µDeps ne filtre QUE le préchargement', async function () {
    const { manifestPath } = await buildProject()
    const manifestSrc = readFileSync(manifestPath, 'utf-8')
    const paths = extractConst(manifestSrc, 'µPaths')
    for (const nom of ['a', 'b', 'c', 'd', 'm.module']) {
      assert.ok(paths[nom], `µPaths doit connaître « ${nom} » (le manifeste liste TOUT ce qui est compilé, préchargé ou non) :\n${JSON.stringify(Object.keys(paths))}`)
    }
  })

  it('deux constructions du même code → manifeste identique à l\'octet (µPaths ET µDeps)', async function () {
    const { manifestPath, bundler } = await buildProject()
    const first = readFileSync(manifestPath, 'utf-8')
    await bundler.compile()
    const second = readFileSync(manifestPath, 'utf-8')
    assert.equal(second, first, 'même code, deux compiles → le manifeste doit être identique octet pour octet')
    await bundler.close()
  })

  it('bundle.js n\'importe plus le cœur STATIQUEMENT (plus de ligne `import { µ } from`), le chemin du cœur reste un littéral de chaîne (regex du layout Rails)', async function () {
    const { manifestPath } = await buildProject()
    const manifestSrc = readFileSync(manifestPath, 'utf-8')
    assert.doesNotMatch(manifestSrc, /^import \{ µ \} from/m, 'plus aucun import statique du cœur en tête de manifeste')
    assert.match(manifestSrc, /const µCore = '([^']+)';/, 'le chemin du cœur doit rester un littéral de chaîne, quotté')
  })

  it("exécuté dans happy-dom sur une page contenant <mjs-a> : pose des modulepreload pour le cœur, A, B, C, M — PAS pour D", async function () {
    const { manifestPath } = await buildProject()
    const manifestSrc = readFileSync(manifestPath, 'utf-8')
    const paths = extractConst(manifestSrc, 'µPaths')

    const window: any = new Window({ url: 'http://localhost/' })
    const document = window.document
    document.body.innerHTML = '<mjs-a></mjs-a>'
    window.eval(manifestSrc)

    // synchrone : le bloc de préchargement tourne AVANT tout import() (aucune
    // résolution réseau nécessaire pour cette assertion).
    const hrefs = Array.from(document.head.querySelectorAll('link[rel="modulepreload"]'))
      .map((l: any) => l.getAttribute('href'))
    // valeurs COMPACTES dans la table (préfixe factorisé une fois, cf. writeManifest) :
    // l'href posé, lui, est toujours entier.
    const prefixe = extractConst(manifestSrc, 'µPathsPrefix')
    for (const nom of ['a', 'b', 'c', 'm.module']) {
      assert.ok(hrefs.includes(prefixe + paths[nom]), `modulepreload manquant pour « ${nom} » (${prefixe + paths[nom]}) :\n${hrefs.join('\n')}`)
    }
    const coreMatch = manifestSrc.match(/const µCore = '([^']+)';/)
    assert.ok(coreMatch, 'µCore introuvable')
    assert.ok(hrefs.includes(coreMatch![1]), `modulepreload manquant pour le cœur (${coreMatch![1]}) :\n${hrefs.join('\n')}`)
    assert.equal(hrefs.includes(prefixe + paths.d), false, `D n'est jamais placé dans la page : AUCUN modulepreload pour lui (${prefixe + paths.d}) :\n${hrefs.join('\n')}`)
  })

  // Le VRAI cœur (pas un mock) exécute le CORPS RÉEL du manifeste (extrait du fichier
  // écrit par writeManifest, pas réécrit à la main) — même patron que
  // tests/mjs-modal-bundler-integration.test.ts (stripEsm + `globalThis.µ = µ;`,
  // core+manifest RÉELLEMENT compilés). `Autoloader.load` est intercepté (jamais un VRAI
  // `import()` de fichier compilé : happy-dom délègue les imports dynamiques à Node, qui
  // les exécute HORS du contexte window happy-dom — `document`/`CSSStyleSheet` n'y
  // existent plus, cf. tests/mjs-modal-bundler-integration.test.ts qui n'en a jamais eu
  // besoin non plus) : on prouve que µ.Autoloader.observe(document.body), posé par
  // bundle.js, voit bien <mjs-a> et RÉCLAME son chargement — le reste de la cascade
  // (Autoloader charge B en enfant de A, puis C) est un comportement du framework
  // INCHANGÉ, déjà couvert par tests/autoloader-*.test.ts.
  it("exécuté dans happy-dom avec le VRAI cœur : µ.paths est posé et l'Autoloader réclame <mjs-a> (jamais <mjs-d>)", async function () {
    const { outDir, manifestPath } = await buildProject()
    const manifestSrc = readFileSync(manifestPath, 'utf-8')
    const coreFile = readdirSync(outDir).find(f => /^mjs_core-/.test(f))
    assert.ok(coreFile, 'mjs_core-*.js doit exister dans outDir')
    const core = readFileSync(join(outDir, coreFile!), 'utf-8')

    const bodyStart = manifestSrc.indexOf('const µReady = ')
    assert.ok(bodyStart >= 0, 'ligne `const µReady = ` introuvable (forme inattendue de writeManifest)')
    const bodyMatch = manifestSrc.match(/const µReady = import\(µCore\)\.then\(async \(\{ µ \}\) => \{\n([\s\S]*)\n\}\);\nif \(typeof window/)
    assert.ok(bodyMatch, 'corps du manifeste introuvable (forme inattendue de writeManifest)')

    const window: any = new Window({ url: 'http://localhost/' })
    const document = window.document
    document.body.innerHTML = '<mjs-a></mjs-a>'
    const loadCalls: string[] = []
    window.__loadCalls = loadCalls
    // UN SEUL eval() : les `const` de tête (µCore/µPaths/µDeps) d'un appel `window.eval()`
    // ne survivent PAS à un appel SÉPARÉ (vérifié empiriquement — contrairement à une
    // affectation `globalThis.x = …`, une vraie propriété) — tout doit donc rester dans
    // LE MÊME script pour que le corps, plus bas, voie encore µPaths.
    //   1. µCore/µPaths/µDeps + le bloc de préchargement RÉEL (avant `const µReady`, tel
    //      qu'écrit par writeManifest — inchangé).
    //   2. le VRAI cœur (stripEsm retire son export statique — même garantie que
    //      tests/mjs-modal-bundler-integration.test.ts), `µ` posé en global.
    //   3. Autoloader.load intercepté AVANT d'exécuter le corps (cf. bandeau ci-dessus).
    //   4. le corps RÉEL du manifeste (µ.paths = …; …; µ.Autoloader.observe(document.body)) —
    //      projet minimal SANS styles/animations/manifeste externe (aucun `await import(...)`
    //      dans ce corps précis, cf. writeManifest) : jamais enveloppé dans un
    //      `(async () => {…})()` fire-and-forget qui aurait avalé une éventuelle erreur.
    window.eval([
      manifestSrc.slice(0, bodyStart),
      stripEsm(core),
      'globalThis.µ = µ;',
      'µ.Autoloader.load = (tag) => { globalThis.__loadCalls.push(tag); return Promise.resolve(); };',
      bodyMatch![1],
    ].join('\n'))

    assert.ok(window.µ.paths && window.µ.paths.a, 'µ.paths doit être posé (table complète, A y compris)')
    // observe() passe node.tagName BRUT (MAJUSCULE, cf. DOM) à load(), qui minuscule EN SON SEIN
    // (mjs_autoloader.ts) — mon espion, lui, ne fait QUE journaliser, d'où l'assertion en MAJUSCULE.
    assert.deepEqual(loadCalls, ['MJS-A'], `l'Autoloader doit réclamer <mjs-a> (présent dans le document) et RIEN d'autre — jamais <mjs-d> :\n${loadCalls.join(', ')}`)
  })

  it('les consommateurs du manifeste (viewer-page.ts) fonctionnent sur la nouvelle forme : getViewerScript retrouve le cœur', async function () {
    const { manifestPath } = await buildProject()
    const js = await getViewerScript(manifestPath, JOURNAL_VIEWER)
    assert.ok(js.length > 0, 'getViewerScript doit produire du JS')
    assert.ok(js.includes('mjs-journal-viewer') || js.includes('._def('), 'le JS compilé doit définir le composant de la visionneuse')
  })
})
