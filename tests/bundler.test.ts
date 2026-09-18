// Tests bundler — compile un projet jouet sur disque (tmpdir).

import assert from 'node:assert/strict'
import { writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { fileURLToPath } from 'node:url'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(): { srcDir: string; outDir: string; manifest: string } {
  const root = mjsTmp('bundler')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { srcDir, outDir, manifest: join(root, 'bundle.js') }
}

describe('Bundler.compile()', () => {
  after(async () => {
    // Le pool worker_threads est partagé process-wide. Sans cette
    // terminaison explicite, les threads idle bloquent l'exit Node.
    await terminateSharedWorkerPool()
  })

  it('compile un .mjs minimal en .js hashé', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()

    writeFileSync(join(srcDir, 'foo.mjs'), `
<script lang="coffee">
  $count = 0
</script>

<p>{$count}</p>
`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0)
    assert.ok(stats.manifest.foo.startsWith(`${bundler.urlPrefix}/foo-`))
    assert.match(stats.manifest.foo, /\/foo-[a-f0-9]{8}\.js$/)

    // Le fichier hashé existe
    const files = readdirSync(outDir)
    const fooFile = files.find(f => /^foo-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(fooFile, 'foo-<hash>.js should exist')

    // Le contenu reflète la compilation
    const content = readFileSync(join(outDir, fooFile!), 'utf-8')
    assert.match(content, /class MjsFoo/)
  })

  it('skip les partials _xxx.mjs', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, '_partial.mjs'), `<script lang="coffee">$x = 0</script>\n<p/>`)
    writeFileSync(join(srcDir, 'main.mjs'), `<script lang="coffee">$y = 0</script>\n<p>{$y}</p>`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.manifest.main, 'main devrait être dans le manifest')
    assert.equal(stats.manifest._partial, undefined, '_partial ne devrait pas')
  })

  it('produit un manifest entrypoint avec µ.paths', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'a.mjs'), `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0)
    assert.ok(existsSync(manifest))
    const text = readFileSync(manifest, 'utf-8')
    assert.match(text, /const µPaths = \{.*"a"/)
    assert.match(text, new RegExp(`const µCore = '${bundler.urlPrefix}/mjs_core-`))
  })

  it('cleanup les anciennes versions du même base', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'foo.mjs'), `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    await bundler.compile()
    // depuis l'introduction des cartes de source, le dev écrit AUSSI `foo-<hash>.js.map` :
    // on ne compte que les chunks, et on vérifie plus bas que la carte suit le ménage.
    const before = readdirSync(outDir).filter(f => /^foo-.*\.js$/.test(f))
    assert.equal(before.length, 1)

    // Modifie pour forcer un nouveau hash
    writeFileSync(join(srcDir, 'foo.mjs'), `<script lang="coffee">$x = 99</script>\n<p>{$x}</p>`)
    bundler.cache.clear() // sinon le mtime check skip
    await bundler.compile()

    const after = readdirSync(outDir).filter(f => /^foo-.*\.js$/.test(f))
    assert.equal(after.length, 1, 'L\'ancienne version doit être supprimée')
    assert.notEqual(after[0], before[0], 'Le nouveau hash doit différer')
    const maps = readdirSync(outDir).filter(f => /^foo-.*\.js\.map$/.test(f))
    assert.deepEqual(maps, [`${after[0]}.map`], 'la carte de l\'ancienne version doit partir avec elle')
  })

  it('compile le runtime concaténé en mjs_core-<hash>.js', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'a.mjs'), `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    await bundler.compile()
    const files = readdirSync(outDir)
    assert.ok(
      files.some(f => /^mjs_core-[a-f0-9]{8}\.js$/.test(f)),
      'mjs_core-<hash>.js doit exister'
    )
  })

  it('skip les animations non utilisées (anim discovery)', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    // Composant SANS aucune transition → pas de mjs_anims
    writeFileSync(join(srcDir, 'plain.mjs'), `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    await bundler.compile()
    const files = readdirSync(outDir)
    assert.ok(
      !files.some(f => /^mjs_anims-/.test(f)),
      'pas de mjs_anims si aucune anim utilisée'
    )
  })

  it('compile les stylesheets partagés en µ.CSS[name]', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    const stylesDir = join(srcDir, '..', 'styles')
    fs.mkdirSync(stylesDir, { recursive: true })
    fs.writeFileSync(join(stylesDir, 'reset.scss'), `* { margin: 0; }`)
    fs.writeFileSync(join(stylesDir, 'typo.css'), `body { font-family: sans-serif; }`)

    fs.writeFileSync(join(srcDir, 'main.mjs'),
      `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: manifest,
      stylesheetsDir: stylesDir,
    })
    await bundler.compile()

    const files = fs.readdirSync(outDir)
    const stylesFile = files.find((f: string) => /^mjs_styles-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(stylesFile, 'mjs_styles-<hash>.js doit exister')

    const content = fs.readFileSync(join(outDir, stylesFile!), 'utf-8')
    assert.match(content, /µ\.CSS\[['"]reset['"]\]/)
    assert.match(content, /µ\.CSS\[['"]typo['"]\]/)
    assert.match(content, /CSSStyleSheet/)

    const entry = fs.readFileSync(manifest, 'utf-8')
    // styles/animations partent en `Promise.all([import(...), ...])` (cf. writeManifest,
    // bundler/index.ts) — recherche de l'appel `import(...)` seul, sans `await` devant.
    assert.match(entry, new RegExp(`import\\("${bundler.urlPrefix}/mjs_styles-`))
  })

  // Régression : `readdirSync` NE GARANTIT
  // AUCUN ORDRE (dépend du filesystem/OS) — `bundleSharedStyles` traitait les
  // fichiers dans CET ordre arbitraire, sans tri. Conséquences : (1) l'ordre
  // de CASCADE CSS entre stylesheets partagés dépend de la machine — deux
  // règles conflictuelles de même spécificité dans 2 fichiers peuvent
  // "gagner" différemment pour un SOURCE IDENTIQUE ; (2) le hash de
  // `mjs_styles-<hash>.js` devient non déterministe d'un build à l'autre
  // (casse les builds reproductibles). Fix : `.sort()` ajouté (même
  // correctif déjà en place pour `compileUsedAnimations`, qui trie
  // explicitement — cf. son propre commentaire — mimé ici).
  //
  // Test structurel (pas empirique) : l'ordre RÉEL de `readdirSync` dépend du
  // filesystem — vérifié sur cette machine, il se trouve DÉJÀ alphabétique
  // même sans tri (ext4 avec peu d'entrées), donc un test par création de
  // fichiers dans un ordre non-alphabétique ne reproduirait PAS le bug de
  // façon fiable ici (et serait fragile/flaky en CI sur un filesystem
  // différent). On vérifie directement que le tri est bien en place dans le
  // source, immédiatement après le readdirSync+filter concerné.
  it("bundleSharedStyles trie les fichiers (déterminisme cascade CSS + hash de build)", function () {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const src = fs.readFileSync(join(here, '..', 'src', 'bundler', 'index.ts'), 'utf-8')
    const m = src.match(/const files = readdirSync\(this\.stylesheetsDir\)[\s\S]{0,150}/)
    assert.ok(m, 'lecture des fichiers de stylesheetsDir introuvable (structure du bundler a changé ?)')
    assert.match(
      m![0], /\.sort\(\)/,
      "AVANT le fix : aucun .sort() après le filter — l'ordre de readdirSync (non garanti par le filesystem) pilotait directement la cascade CSS et le hash de mjs_styles-<hash>.js",
    )
  })

  it('mjs_root.scss adopté globalement (pas dans µ.CSS)', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    const stylesDir = join(srcDir, '..', 'styles')
    fs.mkdirSync(stylesDir, { recursive: true })
    fs.writeFileSync(join(stylesDir, 'mjs_root.scss'), `:root { --primary: blue; }`)

    fs.writeFileSync(join(srcDir, 'main.mjs'),
      `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: manifest,
      stylesheetsDir: stylesDir,
    })
    await bundler.compile()

    const files = fs.readdirSync(outDir)
    const stylesFile = files.find((f: string) => /^mjs_styles-/.test(f))!
    const content = fs.readFileSync(join(outDir, stylesFile), 'utf-8')
    assert.match(content, /document\.adoptedStyleSheets/)
    assert.doesNotMatch(content, /µ\.CSS\[['"]mjs_root['"]\]/)
  })

  it('skip si stylesheetsDir absent', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    fs.writeFileSync(join(srcDir, 'main.mjs'),
      `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: manifest,
      stylesheetsDir: '/nonexistent/dir',
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0)
    const files = fs.readdirSync(outDir)
    assert.ok(!files.some((f: string) => /^mjs_styles-/.test(f)))
  })

  // la carte du compilateur est désormais chaînée à travers les
  // 4 passes de réécriture PUIS repositionnée dans le squelette de classe
  // (transpiler/source-map-chain.ts) : une carte est écrite sur le disque en dev, sans
  // esbuild. La FIDÉLITÉ ligne à ligne est prouvée à part, dans tests/source-map.test.ts.
  it('source maps émises en dev (défaut `sourceMap: dev`)', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    fs.writeFileSync(join(srcDir, 'foo.mjs'), `<script>\n  $x = 0\n</script>\n<p>{$x}</p>`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0)

    const files = fs.readdirSync(outDir)
    const js = files.find((f: string) => /^foo-.*\.js$/.test(f))
    assert.ok(js, `chunk du composant attendu parmi ${files.join(', ')}`)
    assert.ok(files.includes(`${js}.map`), 'la carte doit être écrite à côté du chunk')
    const content = fs.readFileSync(join(outDir, js!), 'utf-8')
    assert.match(content, /\/\/# sourceMappingURL=foo-.*\.js\.map/, 'le chunk doit désigner sa carte')
    const map = JSON.parse(fs.readFileSync(join(outDir, `${js}.map`), 'utf-8'))
    assert.deepEqual(map.sources, ['foo.mjs'], 'la carte doit pointer le .mjs, jamais un état intermédiaire')
    assert.ok(map.sourcesContent?.[0]?.includes('$x = 0'), 'le source du .mjs doit être embarqué (il n\'est jamais servi)')
  })

  it('pas de source maps en prod avec le défaut (la carte publierait le source)', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    fs.writeFileSync(join(srcDir, 'foo.mjs'),
      `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, forceMinify: true })
    await bundler.compile()

    const files = fs.readdirSync(outDir)
    assert.ok(!files.some(f => /\.js\.map$/.test(f)), 'aucun .map ne doit être émis en prod sous le défaut')
    const fooJs = files.find(f => /^foo-[a-f0-9]{8}\.js$/.test(f))
    const content = fs.readFileSync(join(outDir, fooJs!), 'utf-8')
    assert.doesNotMatch(content, /sourceMappingURL/, 'pas de sourceMappingURL en prod sous le défaut')
  })

  it('`sourceMap: prod` rétablit l\'ancien comportement (carte en prod, aucune en dev)', async function () {
    this.timeout(20000)
    for (const [forceMinify, attendu] of [[true, true], [false, false]] as [boolean, boolean][]) {
      const { srcDir, outDir, manifest } = makeProject()
      fs.writeFileSync(join(srcDir, 'foo.mjs'),
        `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`)
      const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, forceMinify, sourceMap: 'prod' })
      await bundler.compile()
      const aCarte = fs.readdirSync(outDir).some(f => /\.js\.map$/.test(f))
      assert.equal(aCarte, attendu, `sourceMap:'prod' + forceMinify:${forceMinify} → carte attendue ${attendu}`)
    }
  })

  it('`sourceMap: never` n\'émet aucune carte, même en prod', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    fs.writeFileSync(join(srcDir, 'foo.mjs'),
      `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, forceMinify: true, sourceMap: 'never' })
    await bundler.compile()
    assert.ok(!fs.readdirSync(outDir).some(f => /\.js\.map$/.test(f)), 'aucune carte sous never')
  })

  it('`sourceMap: always` émet la carte en prod (comme en dev depuis le chaînage, cf. plus haut)', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    fs.writeFileSync(join(srcDir, 'foo.mjs'),
      `<script lang="coffee">$x = 0</script>\n<p>{$x}</p>`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, forceMinify: true, sourceMap: 'always' })
    await bundler.compile()
    assert.ok(fs.readdirSync(outDir).some(f => /\.js\.map$/.test(f)), 'carte attendue sous always en prod')
  })

  it('compile mjs_anims-<hash>.js avec uniquement les anims utilisées', async function () {
    this.timeout(15000)
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'fancy.mjs'), `
<script lang="coffee">$show = true</script>
{if $show}<div @transition.fade>x</div>{end}
`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    await bundler.compile()
    const files = readdirSync(outDir)
    const animFile = files.find(f => /^mjs_anims-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(animFile, 'mjs_anims-<hash>.js doit exister')

    const content = readFileSync(join(outDir, animFile!), 'utf-8')
    assert.match(content, /\.fade/)
    assert.doesNotMatch(content, /\.fly/, 'anims non utilisées doivent être absentes')

    // L'entrypoint doit l'importer — `Promise.all([import(...), ...])`, cf. plus haut.
    const entry = readFileSync(manifest, 'utf-8')
    assert.match(entry, new RegExp(`import\\("${bundler.urlPrefix}/mjs_anims-`))
  })
})

// Régression : `writeHashed()`/
// `resolveOneAsset()` écrivaient DIRECTEMENT sur le chemin FINAL
// (`writeFileSync(target, ...)`), non atomique — un crash à mi-écriture
// (OOM-kill, coupure) laisse un fichier TRONQUÉ sur disque. Le nom étant
// dérivé du hash du contenu SOURCE (jamais revérifié contre les octets
// réellement écrits), `existsSync(target)` renvoie ensuite `true` pour ce
// fichier corrompu à CHAQUE build suivant → jamais réparé, à vie.
//
// Fix : écriture dans un fichier temporaire PUIS `renameSync` — atomique au
// niveau filesystem, `target` n'est JAMAIS visible dans un état
// intermédiaire.
describe('Bundler — écriture atomique (writeFileAtomic)', function () {
  this.timeout(15000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('writeFileAtomic écrit le contenu complet et ne laisse AUCUN fichier .tmp-* derrière', async () => {
    const { srcDir, outDir, manifest } = makeProject()
    mkdirSync(outDir, { recursive: true })
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })

    const target = join(outDir, 'probe-deadbeef.js')
    ;(bundler as any).writeFileAtomic(target, 'const x = 42;')

    assert.equal(readFileSync(target, 'utf-8'), 'const x = 42;', 'le contenu complet doit être présent')
    const leftovers = readdirSync(outDir).filter((f: string) => f.includes('.tmp-'))
    assert.deepEqual(leftovers, [], "AVANT le fix : pas de fichier temporaire du tout (écriture directe) — après le fix, aucun ne doit non plus SURVIVRE (renameSync nettoie)")
  })

  it("un fichier DÉJÀ présent au chemin cible n'est jamais réécrit (même hash = même contenu présumé, comportement inchangé)", async () => {
    const { srcDir, outDir, manifest } = makeProject()
    mkdirSync(outDir, { recursive: true })
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })

    const target = join(outDir, 'probe2-deadbeef.js')
    writeFileSync(target, 'original')
    ;(bundler as any).writeFileAtomic(target, 'nouveau-contenu-different')

    assert.equal(readFileSync(target, 'utf-8'), 'original', 'un fichier déjà là ne doit pas être écrasé (fast-path content-addressed inchangé)')
  })

  it('writeHashed() route bien SES écritures via writeFileAtomic (pas de writeFileSync direct qui aurait survécu au refactor)', () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const src = readFileSync(join(here, '..', 'src', 'bundler', 'index.ts'), 'utf-8')
    const m = src.match(/writeHashed\(baseName: string, ext: string, content: string, map\?: string\): string \{[\s\S]*?\n  \}/)
    assert.ok(m, 'writeHashed() introuvable (structure du bundler a changé ?)')
    assert.doesNotMatch(
      m![0], /\bwriteFileSync\(/,
      "AVANT le fix : writeHashed() appelait writeFileSync DIRECTEMENT sur le chemin final (non atomique)",
    )
    assert.match(m![0], /this\.writeFileAtomic\(/, 'writeHashed() doit déléguer à writeFileAtomic')
  })

  it('resolveOneAsset() (copie binaire) route aussi via writeFileAtomic', () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const src = readFileSync(join(here, '..', 'src', 'bundler', 'index.ts'), 'utf-8')
    const m = src.match(/async resolveOneAsset\(logicalPath: string\): Promise<string> \{[\s\S]*?\n  \}/)
    assert.ok(m, 'resolveOneAsset() introuvable (structure du bundler a changé ?)')
    assert.match(m![0], /this\.writeFileAtomic\(/, "AVANT le fix : la copie d'asset binaire utilisait writeFileSync direct")
  })
})
