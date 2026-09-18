// `.mjs-outputs.json` présent, JSON VALIDE mais
// `{"extensions":[]}` — `Array.isArray([])` est vrai ET `[].every(...)` est vacuement vrai : le
// try de pruneOrphans() réussit, `knownExt` reste VIDE, chaque fichier échoue le test d'extension
// connue (`continue`), removed:[] est rendu SANS jamais poser `skipped` — même silhouette qu'un
// run sain « rien à purger ». Un zombie survit indéfiniment, indiscernable d'un build propre.
// cli.ts (case 'build') ne déstructurait que { removed, failed } : `skipped` n'était JAMAIS
// affiché, même pour un registre illisible/vide ou un cache-hit (garde muette côté CLI aussi).
// Cas jumeau : tests/bundler-prune-extension-etrangere.test.ts (registre illisible).
//
// Correctif : `{"extensions":[]}` traité comme illisible (`skipped: 'registry-empty'`), purge
// sautée, fichier conservé ; cli.ts affiche un message catalogué (fr/en) par raison intéressante
// (registre illisible, registre vide, cache).
//
// NOTE (2e test) — un vrai `mjs build --prune` DEUX FOIS de suite ne
// peut PAS reproduire 'registry-empty' (ni 'registry-unreadable', ni 'cache') : compile() réécrit
// INCONDITIONNELLEMENT un registre SAIN via writeOutputsRegistry() (base .js/.css/.map TOUJOURS
// re-semée, cf. son commentaire), et cette étape tourne AVANT pruneOrphans() DANS LE MÊME appel —
// toute corruption posée entre deux `mjs build` est donc auto-guérie avant que pruneOrphans() ne
// la voie (vérifié par reproduction directe : un 2e build réel sur un registre vidé à la main
// PURGE normalement, `skipped` ne se pose jamais). `mjs dev` n'appelle pruneOrphans() nulle part
// (grep : le seul site est cli.ts case 'build', juste après compile()). Le test CLI ci-dessous
// vérifie donc la brique atteignable pour de vrai — le catalogue fr/en — et documente ce comportement
// plutôt que de simuler un scénario que le code réel rend impossible.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { t, setMessagesLang } from '../src/messages/index.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function build(root: string) {
  const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--root', root], {
    cwd: repoRoot, encoding: 'utf-8', timeout: 120000,
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const comp = (lettre: string) => ['<script>', '  $x = 1', '</script>', `<p>{$x} ${lettre}</p>`].join('\n')

function makeProject(prefix: string) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

describe('bundler — pruneOrphans() muet sur un registre {extensions:[]}', function () {
  this.timeout(30000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("registre .mjs-outputs.json PRÉSENT avec extensions:[] (JSON valide) : pruneOrphans() ne purge RIEN et le DIT — zéro cache-hit pour isoler le cas", async function () {
    const { root, srcDir, outDir, manifest } = makeProject('prune-registre-vide')
    writeFileSync(join(srcDir, 'a.mjs'), comp('a'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.equal((bundler as any).cacheHitsThisCompile, 0, 'setup : 1er build, aucun cache-hit possible — isole le cas registre-vide de la garde skipped:cache')

    // vide le registre APRÈS ce seul compile() (JSON toujours valide : un tableau vide)
    const registryPath = join(dirname(manifest), '.mjs-outputs.json')
    writeFileSync(registryPath, JSON.stringify({ extensions: [] }))

    const zombie = 'zombie-01234567.js'
    writeFileSync(join(outDir, zombie), 'export {}\n')

    const { removed, failed, skipped } = bundler.pruneOrphans()
    assert.notEqual(skipped, undefined,
      "AVANT le fix : skipped restait undefined avec extensions:[] — IDENTIQUE à un run sain 'rien à purger', aucun signal du problème")
    assert.deepEqual(removed, [])
    assert.deepEqual(failed, [])
    assert.ok(existsSync(join(outDir, zombie)),
      'AVANT le fix : le zombie survivait déjà (accidentellement, faute de connaître une seule extension) — mais SANS signal explicite')

    await bundler.close()
  })

  it("message CLI catalogué (fr/en) pour chaque raison de purge sautée intéressante (registre illisible, registre vide, cache)", function () {
    assert.match(t('cli.build-purge-registre-illisible', { dossier: 'out' }), /registre/i,
      "le message fr doit nommer le registre — AVANT le fix cette clé n'existait pas, skipped n'était jamais affiché")
    assert.match(t('cli.build-purge-registre-vide', { dossier: 'out' }), /registre/i)
    assert.match(t('cli.build-purge-cache', { dossier: 'out' }), /cache/i)

    setMessagesLang('en')
    try {
      assert.match(t('cli.build-purge-registre-illisible', { dossier: 'out' }), /registry/i)
      assert.match(t('cli.build-purge-registre-vide', { dossier: 'out' }), /registry/i)
      assert.match(t('cli.build-purge-cache', { dossier: 'out' }), /cache/i)
    } finally {
      setMessagesLang('fr') // restaure — LANG est un état global partagé entre fichiers de test
    }
  })

  it("cli.ts (case 'build') consulte bien `skipped` (déstructuration + dispatch), pas seulement { removed, failed }", function () {
    const src = readFileSync(join(repoRoot, 'src', 'cli.ts'), 'utf-8')
    assert.match(src, /const \{ removed, failed, skipped \} = bundler\.pruneOrphans\(\)/,
      "AVANT le fix : seuls { removed, failed } étaient déstructurés — `skipped` (registre illisible, cache) n'atteignait jamais l'affichage")
    assert.match(src, /cli\.build-purge-registre-illisible/)
    assert.match(src, /cli\.build-purge-registre-vide/)
    assert.match(src, /cli\.build-purge-cache/)
  })

  it("mjs build réel (registre sain) : la purge normale continue de fonctionner sans le moindre message de raison sautée (non-régression)", function () {
    // préfixe SANS "registre"/"cache" — sinon le chemin lui-même (imprimé dans "📋 mjs.config.json : …")
    // ferait matcher le test contre son PROPRE nom de dossier temporaire, faux positif sans rapport
    const root   = mjsTmp('prune-purge-normale-cli')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js' }))
    writeFileSync(join(srcDir, 'a.mjs'), '<p>a</p>\n')
    writeFileSync(join(srcDir, 'b.mjs'), '<p>b</p>\n')

    const build1 = build(root)
    assert.equal(build1.code, 0, build1.stderr)

    unlinkSync(join(srcDir, 'b.mjs'))
    const build2 = build(root)
    assert.equal(build2.code, 0, build2.stderr)
    assert.match(build2.stdout, /🧹/, 'la purge normale (orphelin réel b) doit toujours fonctionner')
    assert.doesNotMatch(build2.stdout, /registre|cache/i, 'un registre sain ne doit déclencher aucun message de raison sautée')
  })
})
