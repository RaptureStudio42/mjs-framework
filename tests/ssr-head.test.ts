// ssr-head — <head> thématisé du shell SSR : anti-flash, cf. src/server/ssr-head.ts.
// Couvre le piège de synchronisation (FRAMEWORK_THEME_CSS doit rester l'exacte copie de
// mjs_init.ts), shell() (5e paramètre headExtra), buildSsrHead() (thème d'app + mjs_root, replis
// « absent » silencieux vs pannes qui rendent '' pour l'ensemble, log une seule fois par process),
// et une vérification bout en bout via un vrai serveur `mjs serve`.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { shell, startRenderServer } from '../src/server/render-server.js'
import { buildSsrHead, FRAMEWORK_THEME_CSS } from '../src/server/ssr-head.js'
import { StaticServer } from '../src/server/index.js'
import { createRenderHandler } from '../src/server/render-request.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

after(() => sweepRegistered())

describe('FRAMEWORK_THEME_CSS — piège de synchronisation avec mjs_theme.ts', () => {
  it('copie EXACTEMENT µ._mjs_themeSheet.replaceSync(`...`) de src/runtime/mjs_theme.ts', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_theme.ts'), 'utf-8')
    const m = src.match(/µ\._mjs_themeSheet\.replaceSync\(`([\s\S]*?)`\);/)
    assert.ok(m, 'mjs_theme.ts doit toujours contenir µ._mjs_themeSheet.replaceSync(`...`) — si ce match échoue, le fichier a bougé, pas seulement le CSS')
    assert.equal(FRAMEWORK_THEME_CSS, m![1], 'la copie serveur (ssr-head.ts) a divergé de la source runtime (mjs_init.ts) — remets les deux d\'accord')
  })
})

describe('shell() — 5e paramètre headExtra', () => {
  it('défaut \'\' : sortie BYTE-identique à un appel 3 arguments (non-régression)', () => {
    const avecExtraScript = shell('<mjs-home></mjs-home>', '/__mjs/bundle.js', 'fr', '')
    const sansHeadExtra = shell('<mjs-home></mjs-home>', '/__mjs/bundle.js', 'fr', '', '')
    assert.equal(sansHeadExtra, avecExtraScript)
  })

  it('headExtra non vide : inséré juste avant </head>, extraScript intact', () => {
    const html = shell('<mjs-home></mjs-home>', '/__mjs/bundle.js', 'fr', '<script>marqueur()</script>', '<style data-mjs-ssr-head>.x{color:red}</style>')
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1"><style data-mjs-ssr-head>\.x\{color:red\}<\/style><\/head>/)
    assert.match(html, /<script>marqueur\(\)<\/script><\/body>/, 'extraScript reste à sa place (fin de body), non affecté par headExtra')
  })
})

describe('buildSsrHead() sous `csp` — le `<link>` porte le préfixe PUBLIC du projet', () => {
  it('sans `urlPrefix` déclaré : le préfixe est DÉRIVÉ du dossier de sortie, comme le fait le bundler', () => {
    const root = mjsTmp('ssr-head-csp-prefixe')
    mkdirSync(join(root, 'public', 'modularjs'), { recursive: true })
    const html = buildSsrHead({ csp: true, outputDir: 'public/modularjs' } as any, root, null)
    assert.match(html, /^<link rel="stylesheet" href="\/modularjs\/mjs_ssr_head-[a-f0-9]{8}\.css">$/, `href attendu sous le préfixe public du projet, obtenu : ${html}`)
  })

  it('avec `urlPrefix` déclaré : c\'est lui qui gagne', () => {
    const root = mjsTmp('ssr-head-csp-prefixe-explicite')
    mkdirSync(join(root, 'dist'), { recursive: true })
    const html = buildSsrHead({ csp: true, outputDir: 'dist', urlPrefix: '/assets' } as any, root, null)
    assert.match(html, /^<link rel="stylesheet" href="\/assets\/mjs_ssr_head-[a-f0-9]{8}\.css">$/, `href attendu sous le préfixe déclaré, obtenu : ${html}`)
  })
})

describe('buildSsrHead() — cas normaux (sections "absentes", jamais une panne)', () => {
  it('aucun manifeste, aucun mjs_root : seul le framework est inliné', () => {
    const root = mjsTmp('ssr-head-vide')
    const html = buildSsrHead({} as any, root, null)
    assert.equal(html, '<style data-mjs-ssr-head>' + FRAMEWORK_THEME_CSS + '</style>')
  })

  it('manifeste avec µ._themeCss seul (build antérieur à _themeCssByName) : repli sur µ._themeCss entier', () => {
    const root = mjsTmp('ssr-head-themecss')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ._themeCss = "TOUS-LES-THEMES"; if (typeof µ._themeAdopt === \'function\') { µ._themeAdopt(); }\n')
    const html = buildSsrHead({} as any, root, join(outDir, 'manifest.js'))
    assert.equal(html, '<style data-mjs-ssr-head>' + FRAMEWORK_THEME_CSS + '\nTOUS-LES-THEMES</style>')
  })

  it('µ._themeCssByName présent avec le thème par défaut : cette seule entrée est prise (pas µ._themeCss)', () => {
    const root = mjsTmp('ssr-head-byname')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'manifest.js'), 'µ._themeCssByName = {"light":"CSS-CLAIR","dark":"CSS-SOMBRE"};\nµ._themeCss = "TOUS-LES-THEMES";\n')
    const html = buildSsrHead({ defaultTheme: 'light' } as any, root, join(outDir, 'manifest.js'))
    assert.equal(html, '<style data-mjs-ssr-head>' + FRAMEWORK_THEME_CSS + '\nCSS-CLAIR</style>')
  })

  it('µ._themeCssByName présent MAIS sans le thème par défaut dedans : repli sur µ._themeCss entier', () => {
    const root = mjsTmp('ssr-head-byname-miss')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'manifest.js'), 'µ._themeCssByName = {"dark":"CSS-SOMBRE"};\nµ._themeCss = "TOUS-LES-THEMES";\n')
    const html = buildSsrHead({ defaultTheme: 'light' } as any, root, join(outDir, 'manifest.js'))
    assert.equal(html, '<style data-mjs-ssr-head>' + FRAMEWORK_THEME_CSS + '\nTOUS-LES-THEMES</style>')
  })

  it('defaultTheme absent de la config : repli implicite sur \'light\' (même défaut que le bundler)', () => {
    const root = mjsTmp('ssr-head-defaulttheme')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'manifest.js'), 'µ._themeCssByName = {"light":"CSS-CLAIR"};\n')
    const html = buildSsrHead({} as any, root, join(outDir, 'manifest.js'))
    assert.equal(html, '<style data-mjs-ssr-head>' + FRAMEWORK_THEME_CSS + '\nCSS-CLAIR</style>')
  })

  it('manifestPath pointant un fichier inexistant : section thème omise (pas encore de build, pas une panne)', () => {
    const root = mjsTmp('ssr-head-manifest-absent')
    const html = buildSsrHead({} as any, root, join(root, 'out', 'manifest.js'))
    assert.equal(html, '<style data-mjs-ssr-head>' + FRAMEWORK_THEME_CSS + '</style>')
  })

  it('mjs_root.css présent (stylesheetsDir défaut app/modularjs/styles) : compilé et ajouté', () => {
    const root = mjsTmp('ssr-head-root-css')
    const stylesDir = join(root, 'app', 'modularjs', 'styles')
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(join(stylesDir, 'mjs_root.css'), '.app  {  color : red  }')
    const html = buildSsrHead({} as any, root, null)
    assert.equal(html, '<style data-mjs-ssr-head>' + FRAMEWORK_THEME_CSS + '\n.app { color : red }</style>')
  })

  it('stylesheetsDir custom respecté (config.stylesheetsDir)', () => {
    const root = mjsTmp('ssr-head-root-custom')
    const stylesDir = join(root, 'styles-a-moi')
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(join(stylesDir, 'mjs_root.css'), '.custom{color:blue}')
    const html = buildSsrHead({ stylesheetsDir: 'styles-a-moi' } as any, root, null)
    assert.match(html, /\.custom\{color:blue\}/)
  })

  it('mjs_root absent : section omise, aucune erreur', () => {
    const root = mjsTmp('ssr-head-root-absent')
    const html = buildSsrHead({} as any, root, null)
    assert.equal(html, '<style data-mjs-ssr-head>' + FRAMEWORK_THEME_CSS + '</style>')
  })

  it('cache par mtimeMs : le contenu recompilé suit un fichier mjs_root modifié', () => {
    const root = mjsTmp('ssr-head-root-cache')
    const stylesDir = join(root, 'app', 'modularjs', 'styles')
    mkdirSync(stylesDir, { recursive: true })
    const path = join(stylesDir, 'mjs_root.css')
    writeFileSync(path, '.v1{color:red}')
    const html1 = buildSsrHead({} as any, root, null)
    assert.match(html1, /\.v1\{color:red\}/)
    // mtime doit changer réellement (résolution FS) : futureMs garantit un mtimeMs différent, même
    // sur un filesystem à faible résolution — écriture directe du timestamp, pas une boucle d'attente.
    writeFileSync(path, '.v2{color:blue}')
    const futur = new Date(Date.now() + 5000)
    utimesSync(path, futur, futur)
    const html2 = buildSsrHead({} as any, root, null)
    assert.match(html2, /\.v2\{color:blue\}/)
    assert.doesNotMatch(html2, /\.v1/)
  })
})

describe('buildSsrHead() — pannes réelles (JSON invalide) : chaîne vide POUR L\'ENSEMBLE, log une seule fois', () => {
  it('2 manifestes cassés successifs : \'\' à chaque fois, mais un SEUL console.error pour le process', () => {
    const root1 = mjsTmp('ssr-head-panne-a')
    const out1 = join(root1, 'out')
    mkdirSync(out1, { recursive: true })
    // JSON invalide (quotes simples) : _themeCssByName parse échoue → défaillance, pas un « absent ».
    writeFileSync(join(out1, 'manifest.js'), "µ._themeCssByName = {'light':'x'};\n")

    const root2 = mjsTmp('ssr-head-panne-b')
    const out2 = join(root2, 'out')
    mkdirSync(out2, { recursive: true })
    // chaîne JSON non terminée : _themeCss (repli) parse échoue aussi.
    writeFileSync(join(out2, 'manifest.js'), 'µ._themeCss = "non-terminee')

    const originalError = console.error
    const calls: any[][] = []
    console.error = (...args: any[]) => { calls.push(args) }
    try {
      const html1 = buildSsrHead({} as any, root1, join(out1, 'manifest.js'))
      const html2 = buildSsrHead({} as any, root2, join(out2, 'manifest.js'))
      assert.equal(html1, '', 'panne JSON → chaîne vide pour L\'ENSEMBLE (même le framework, qui pourtant a réussi seul, est écarté)')
      assert.equal(html2, '', 'même verdict pour la 2e panne, de nature différente')
      assert.equal(calls.length, 1, 'une seule fois pour la durée du process, jamais une par requête/appel : ' + JSON.stringify(calls))
    } finally {
      console.error = originalError
    }
  })
})

describe('bout en bout — page HTML servie par `mjs serve` porte le <style data-mjs-ssr-head>', () => {
  it('page normale (pas /__mjs/theme, pas /__mjs/errors) : <head> contient le framework + le thème d\'app + mjs_root', async function () {
    this.timeout(15000)
    const root = mjsTmp('ssr-head-e2e')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    const stylesDir = join(root, 'app', 'modularjs', 'styles')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    writeFileSync(join(stylesDir, 'mjs_root.css'), '.app{color:green}')
    writeFileSync(join(outDir, 'manifest.js'), 'µ._themeCssByName = {"light":"CSS-APP-CLAIR"};\nµ.paths = {};\nµ.version = "abcd1234";\n')
    const config = {
      sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
      render: { routes: { '/': { component: 'mjs-home', mode: 'csr' as const } } },
    }
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`)
      const html = await res.text()
      assert.equal(res.status, 200)
      assert.match(html, /<style data-mjs-ssr-head>/)
      assert.match(html, /--mjs-surface:#fff/, 'variables de thème clair/sombre du framework présentes')
      assert.match(html, /CSS-APP-CLAIR/, 'thème d\'application par défaut présent')
      assert.match(html, /\.app\{color:green\}/, 'mjs_root présent')
      // la <style> vit dans le <head>, avant </head> — jamais dans le <body>
      assert.ok(html.indexOf('<style data-mjs-ssr-head>') < html.indexOf('</head>'))
    } finally {
      await running.close()
    }
  })

  it('les visionneuses (/__mjs/theme, /__mjs/errors) ne portent PAS de <style data-mjs-ssr-head> (hors périmètre : seule la page rendue est ciblée)', async function () {
    this.timeout(15000)
    const root = mjsTmp('ssr-head-viewers')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
    const config = {
      sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
      render: { routes: { '/': { component: 'mjs-home', mode: 'csr' as const } } },
    }
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const theme = await (await fetch(`http://127.0.0.1:${running.port}/__mjs/theme`)).text()
      const errors = await (await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`)).text()
      assert.doesNotMatch(theme, /data-mjs-ssr-head/)
      assert.doesNotMatch(errors, /data-mjs-ssr-head/)
    } finally {
      await running.close()
    }
  })
})

// une variable de thème est une DONNÉE : sans échappement, une
// valeur `"</style><script>...</script>"` (CSS parfaitement valide, une simple chaîne) rompt le
// tokenizer HTML dès qu'elle est inliné dans le <style> de buildSsrHead(). Reproduction :
// thème `$$evil: "</style><script>alert(document.domain)</script>"` → CSS compilé contenant cette
// même chaîne, quelle que soit la source (thème d'app, mjs_root).
describe('buildSsrHead() — échappement anti-injection HTML', () => {
  it('charge exacte du cas (`</style><script>alert(document.domain)</script>`) : un seul </style> dans tout le head, aucun </script> en clair, la valeur reste du CSS utilisable', () => {
    const root = mjsTmp('ssr-head-injection-charge')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    const cssHostile = ':root{--mjs-evil:"</style><script>alert(document.domain)</script>"}'
    writeFileSync(join(outDir, 'manifest.js'), 'µ._themeCssByName = ' + JSON.stringify({ light: cssHostile }) + ';\n')
    const html = buildSsrHead({ defaultTheme: 'light' } as any, root, join(outDir, 'manifest.js'))
    const styleCloseCount  = (html.match(/<\/style/gi) || []).length
    const scriptCloseCount = (html.match(/<\/script/gi) || []).length
    assert.equal(styleCloseCount, 1, 'une seule fermeture </style dans tout le head (le wrapper légitime) : ' + html)
    assert.equal(scriptCloseCount, 0, 'aucune fermeture </script en clair (buildSsrHead ne produit jamais de <script>) : ' + html)
    const firstStyleClose = html.indexOf('</style>')
    assert.ok(html.indexOf('<script>alert(document.domain)') < firstStyleClose, 'le <script> injecté reste À L\'INTÉRIEUR de l\'unique <style> légitime, donc jamais exécuté par le navigateur')
    assert.ok(html.includes(':root{--mjs-evil:"<\\/style><script>alert(document.domain)<\\/script>"}'), 'la valeur reste intacte (seule la barre oblique de fermeture est échappée), donc toujours utilisable côté CSS : ' + html)
  })

  it('même charge avec `</STYLE`/`</SCRIPT` en MAJUSCULES : neutralisée aussi (le tokenizer HTML est insensible à la casse), casse d\'origine préservée', () => {
    const root = mjsTmp('ssr-head-injection-majuscule')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    const cssHostile = ':root{--mjs-evil:"</STYLE><script>alert(1)</SCRIPT>"}'
    writeFileSync(join(outDir, 'manifest.js'), 'µ._themeCssByName = ' + JSON.stringify({ light: cssHostile }) + ';\n')
    const html = buildSsrHead({ defaultTheme: 'light' } as any, root, join(outDir, 'manifest.js'))
    const styleCloseCount  = (html.match(/<\/style/gi) || []).length
    const scriptCloseCount = (html.match(/<\/script/gi) || []).length
    assert.equal(styleCloseCount, 1, 'une seule fermeture </style, quelle que soit la casse d\'origine de la charge : ' + html)
    assert.equal(scriptCloseCount, 0, 'aucune fermeture </SCRIPT en clair : ' + html)
    assert.ok(html.includes('<\\/STYLE>'), 'la casse MAJUSCULE d\'origine est préservée, seule la barre oblique est échappée : ' + html)
    assert.ok(html.includes('<\\/SCRIPT>'), 'idem pour </SCRIPT : ' + html)
  })

  it('commentaire HTML `<!--`/`-->` dans une valeur de thème : neutralisé, la valeur reste présente', () => {
    const root = mjsTmp('ssr-head-injection-commentaire')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    const cssHostile = ':root{--mjs-evil:"<!--pas un commentaire--><b>texte</b>"}'
    writeFileSync(join(outDir, 'manifest.js'), 'µ._themeCssByName = ' + JSON.stringify({ light: cssHostile }) + ';\n')
    const html = buildSsrHead({ defaultTheme: 'light' } as any, root, join(outDir, 'manifest.js'))
    assert.doesNotMatch(html, /<!--/, 'aucune ouverture de commentaire NON échappée : ' + html)
    assert.doesNotMatch(html, /-->/, 'aucune fermeture de commentaire NON échappée : ' + html)
    assert.ok(html.includes('pas un commentaire'), 'la valeur reste présente, seulement neutralisée : ' + html)
  })

  it('mjs_root.css (pas seulement le thème d\'application) : la même charge y est neutralisée aussi', () => {
    const root = mjsTmp('ssr-head-injection-mjsroot')
    const stylesDir = join(root, 'app', 'modularjs', 'styles')
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(join(stylesDir, 'mjs_root.css'), '.app{content:"</style><script>alert(2)</script>"}')
    const html = buildSsrHead({} as any, root, null)
    const styleCloseCount  = (html.match(/<\/style/gi) || []).length
    const scriptCloseCount = (html.match(/<\/script/gi) || []).length
    assert.equal(styleCloseCount, 1, 'une seule fermeture </style, même charge portée par mjs_root plutôt que le thème d\'app : ' + html)
    assert.equal(scriptCloseCount, 0, 'aucune fermeture </script en clair : ' + html)
    assert.ok(html.includes('alert(2)'), 'la valeur reste présente, seulement neutralisée : ' + html)
  })

  it('bout en bout — mjs serve : la page HTML SERVIE ne contient qu\'un seul </style>, aucune fermeture </script en trop issue du thème (reproduction exacte du rapport)', async function () {
    this.timeout(15000)
    const root = mjsTmp('ssr-head-injection-e2e')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    const cssHostile = ':root{--mjs-evil:"</style><script>alert(document.domain)</script>"}'
    writeFileSync(join(outDir, 'manifest.js'), 'µ._themeCssByName = ' + JSON.stringify({ light: cssHostile }) + ';\nµ.paths = {};\nµ.version = "abcd1234";\n')
    const config = {
      sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
      render: { routes: { '/': { component: 'mjs-home', mode: 'csr' as const } } },
    }
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`)
      const html = await res.text()
      assert.equal(res.status, 200)
      const styleCloseCount  = (html.match(/<\/style/gi) || []).length
      const scriptCloseCount = (html.match(/<\/script/gi) || []).length
      assert.equal(styleCloseCount, 1, 'un seul </style> dans toute la page servie : ' + html)
      assert.equal(scriptCloseCount, 1, 'une seule fermeture </script> dans toute la page servie (celle du bundle, jamais celle injectée par le thème) : ' + html)
      const firstStyleClose = html.indexOf('</style>')
      assert.ok(html.indexOf('<script>alert(document.domain)') < firstStyleClose, 'le texte injecté reste À L\'INTÉRIEUR de l\'unique <style> légitime, jamais un <script> réellement exécuté par le navigateur')
    } finally {
      await running.close()
    }
  })
})

// seul render-server.ts (mjs serve) passait le 5e paramètre de
// shell() ; server/index.ts (StaticServer, serveRenderFallback, le chemin `mjs dev` quand `render`
// est configuré) l'omettait encore : les pages rendues au serveur en DÉVELOPPEMENT gardaient donc
// entier le flash que ce paramètre est censé supprimer.
describe('StaticServer (mjs dev) — <head> thématisé transmis à serveRenderFallback', () => {
  it('config/configDir fournis au StaticServer : la page render.routes servie EN DEV porte <style data-mjs-ssr-head>, comme mjs serve', async function () {
    this.timeout(15000)
    const root = mjsTmp('ssr-head-dev-defaut2')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { routes: { '/': { component: 'mjs-home', mode: 'csr' as const } } },
    }
    const handler = await createRenderHandler(config as any, root)
    const port = 31000 + Math.floor(Math.random() * 4000)
    const server = new StaticServer({
      rootDir: join(root, 'public', 'out'), port, host: '127.0.0.1',
      renderHandle: handler.handle, manifestPath: join(root, 'public', 'out', 'bundle.js'),
      config: config as any, configDir: root,
    })
    await server.start()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      const html = await res.text()
      assert.equal(res.status, 200)
      assert.match(html, /<style data-mjs-ssr-head>/, 'la page render.routes servie par mjs dev doit porter le head thématisé, comme mjs serve')
      assert.match(html, /--mjs-surface:#fff/, 'variables de thème clair/sombre du framework présentes (même buildSsrHead que mjs serve)')
    } finally {
      await server.stop()
      await handler.close()
    }
  })

  it('config/configDir ABSENTS du StaticServer (ancien appel, non-régression) : headExtra vide, comportement historique intact, jamais un 500', async function () {
    this.timeout(15000)
    const root = mjsTmp('ssr-head-dev-defaut2-absent')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { routes: { '/': { component: 'mjs-home', mode: 'csr' as const } } },
    }
    const handler = await createRenderHandler(config as any, root)
    const port = 31000 + Math.floor(Math.random() * 4000)
    const server = new StaticServer({
      rootDir: join(root, 'public', 'out'), port, host: '127.0.0.1',
      renderHandle: handler.handle, manifestPath: join(root, 'public', 'out', 'bundle.js'),
      // config/configDir volontairement absents — reproduit l'appel D'AVANT ce changement
    })
    await server.start()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      const html = await res.text()
      assert.equal(res.status, 200)
      assert.doesNotMatch(html, /data-mjs-ssr-head/, 'sans config/configDir, aucun head thématisé — mais la page reste servie normalement')
    } finally {
      await server.stop()
      await handler.close()
    }
  })
})
