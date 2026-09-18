// Régression — `minify` ne dit PLUS l'environnement du build.
//
// AVANT : `isProd()` valait `forceMinify || NODE_ENV==='production'`, et la clé publique
// `minify: true` de mjs.config.json alimentait `forceMinify`. Conséquence jamais annoncée :
// un projet qui posait `"minify": true` juste pour alléger son bundle LOCAL construisait en
// réalité un build de PRODUCTION — sans `window.µ`, sans carte de source, et surtout sans
// aucun module d'inspection : `Ctrl+Shift+Espace` n'ouvrait rien, et rien ne le disait.
// Constaté en local : le panneau d'inspection n'existait pas dans le bundle.
//
// APRÈS : deux axes séparés — `env` ('dev'|'prod', défaut 'dev') décide de l'environnement ;
// `minify` ('auto'|true|false, défaut 'auto' = suit `env`) ne décide que de la minification.
//
// `env` n'est plus ni une clé de mjs.config.json ni une lecture de NODE_ENV :
// l'environnement vient de la COMMANDE (`mjs build` = dev, `mjs build --prod` = prod), et
// c'est ce qu'elle pose ici. Une variable d'ambiance ne change plus ce que produit un build.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

/** Un build complet ; rend le core concaténé et le manifeste. */
async function bâtir(etiquette: string, opts: Record<string, unknown>) {
  const root   = mjsTmp(`env-${etiquette}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'env-hello.mjs'), '<script>\n$n ?= 1\n</script>\n<p>{$n}</p>')
  const bundler  = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), ...opts })
  const stats    = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const fichiers = readdirSync(outDir)
  const core     = readFileSync(join(outDir, fichiers.find(f => /^mjs_core-/.test(f))!), 'utf-8')
  const manifeste = readFileSync(join(root, 'bundle.js'), 'utf-8')
  await bundler.close()
  return { core, manifeste }
}

// les bandeaux `// === mjs_xxx.ts ===` de la concaténation ne survivent pas à esbuild
const estMinifie = (core: string) => !/\/\/ === mjs_element\.ts ===/.test(core)
// `µ` lui-même est un `var` de haut niveau : esbuild le renomme en minifiant. On cherche donc
// la PROPRIÉTÉ (jamais manglée : seuls les `_mjs_*` passent par le mangleCache), pas `µ.devPanel`.
const aLePanneau = (core: string) => /\.devPanel\s*=\s*function/.test(core)

describe('bundler — `env` dit dev ou prod, `minify` ne dit que la minification', function () {
  this.timeout(60000)

  let nodeEnvInitial: string | undefined
  before(() => { nodeEnvInitial = process.env.NODE_ENV })
  afterEach(() => {
    if (nodeEnvInitial === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnvInitial
  })
  after(async () => { await terminateSharedWorkerPool() })

  it("minify:true SANS NODE_ENV → build de DÉV minifié : le panneau d'inspection est là (AVANT le fix : absent, en silence)", async () => {
    delete process.env.NODE_ENV
    const { core, manifeste } = await bâtir('minify-seul', { minify: true })
    assert.ok(aLePanneau(core), "AVANT le fix : `minify: true` valait « build de prod » et retirait mjs_devpanel du bundle sans le moindre message")
    assert.ok(estMinifie(core), '`minify: true` doit continuer à minifier — c\'est tout ce qu\'il demande')
    assert.match(manifeste, /window\.µ\s*=\s*µ/, 'build de dév : µ reste joignable depuis la console')
  })

  it("env:'prod' SANS NODE_ENV → build de PROD : pas de panneau, sortie minifiée par défaut", async () => {
    delete process.env.NODE_ENV
    const { core, manifeste } = await bâtir('env-prod', { env: 'prod' })
    assert.ok(!aLePanneau(core), 'un build de prod ne doit embarquer aucun outil de développement')
    assert.ok(estMinifie(core), "`minify` vaut 'auto' par défaut : en prod, on minifie")
    assert.doesNotMatch(manifeste, /window\.µ\s*=\s*µ/, 'build de prod : window.µ non exposé')
  })

  it("env:'dev' AVEC NODE_ENV=production → dév, non minifié, panneau présent : l'ambiance ne décide pas", async () => {
    process.env.NODE_ENV = 'production'
    const { core } = await bâtir('env-dev-vs-nodeenv', { env: 'dev' })
    assert.ok(aLePanneau(core), "`env: 'dev'` doit primer sur un NODE_ENV qui traîne dans le shell")
    assert.ok(!estMinifie(core), 'AVANT le fix : minifyJs ne regardait que NODE_ENV, la sortie repassait minifiée malgré la config')
  })

  it("env:'prod' + minify:false → prod NON minifié : les deux axes sont bien indépendants", async () => {
    delete process.env.NODE_ENV
    const { core, manifeste } = await bâtir('prod-sans-minify', { env: 'prod', minify: false })
    assert.ok(!aLePanneau(core), 'prod reste prod : aucun outil de développement')
    assert.ok(!estMinifie(core), '`minify: false` doit être un veto, même en prod')
    assert.doesNotMatch(manifeste, /window\.µ\s*=\s*µ/)
  })

  it("rien de demandé + NODE_ENV=production → DÉV quand même : le build ne suit plus l'ambiance", async () => {
    process.env.NODE_ENV = 'production'
    const { core, manifeste } = await bâtir('nodeenv-seul', {})
    assert.ok(aLePanneau(core),
      "AVANT le fix : un NODE_ENV=production qui traînait dans le shell suffisait à retirer le panneau d'un `mjs build` local — c'est la commande qui dit l'environnement, pas l'ambiance")
    assert.ok(!estMinifie(core), 'même motif : NODE_ENV seul ne doit plus rien minifier')
    assert.match(manifeste, /window\.µ\s*=\s*µ/, 'build de dév : µ reste joignable depuis la console')
  })

  it("i18n.hash: true → fragments hachés MÊME en développement (défaut 'auto' = prod seulement)", async () => {
    delete process.env.NODE_ENV
    const root   = mjsTmp('env-i18n-hash')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(join(srcDir, 'i18n', 'fr'), { recursive: true })
    writeFileSync(join(srcDir, 'env-hello.mjs'), "@i18n 'salut'\n\n<p>{µt('bonjour')}</p>")
    writeFileSync(join(srcDir, 'i18n', 'fr', 'salut.yml'), 'bonjour: "Bonjour"\n')

    const hache = async (hash: unknown) => {
      const b = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr', ...(hash === undefined ? {} : { hash }) } as any })
      const st = await b.compile()
      assert.equal(st.errors.length, 0, st.errors.map((e: any) => e.message).join('\n'))
      const noms = readdirSync(join(outDir, 'i18n', 'fr'))
      await b.close()
      return noms
    }

    assert.ok((await hache(undefined)).includes('salut.json'), "défaut 'auto' en dév : noms clairs")
    assert.ok((await hache(true)).some(n => /^[a-f0-9]{32}\.json$/.test(n)), 'hash: true doit hacher même en dév')
  })

  it('rien de demandé, aucun NODE_ENV → dév (le défaut)', async () => {
    delete process.env.NODE_ENV
    const { core } = await bâtir('defaut', {})
    assert.ok(aLePanneau(core))
    assert.ok(!estMinifie(core))
  })
})
