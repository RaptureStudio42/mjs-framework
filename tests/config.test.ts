// Tests config loader

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

// modèle du pattern mjsTmp : après ce fichier, seuls les
// FUTURS tests migrent, les 128 autres restent couverts par le balai global
// tests/helpers/tmp-sweep.ts
after(() => sweepRegistered())

describe('findConfig', () => {
  it('trouve mjs.config.json dans le répertoire courant', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      sourceDir: 'src/components',
      defaultScriptLang: 'civet',
    }))
    const found = findConfig(root)
    assert.ok(found, 'devrait trouver le config')
    assert.equal(found!.config.sourceDir, 'src/components')
    assert.equal(found!.configDir, root)
  })

  it('remonte vers le parent jusqu\'à trouver le config', () => {
    const root = mjsTmp('cfg')
    const sub = join(root, 'app', 'sub', 'deep')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ minify: true }))

    const found = findConfig(sub)
    assert.ok(found, 'devrait remonter et trouver')
    assert.equal(found!.configDir, root)
    assert.equal(found!.config.minify, true)
  })

  it('retourne null si introuvable', () => {
    // /tmp ne contient pas de mjs.config.json
    const found = findConfig('/tmp')
    assert.equal(found, null)
  })

  it('throw sur JSON invalide', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), `{ invalid json }`)
    // message désormais catalogué fr/en (cf. tests/config-json-parse-error.test.ts) : « parse error » (anglais brut) devient « erreur de syntaxe JSON ».
    assert.throws(() => findConfig(root), /erreur de syntaxe JSON/)
  })

  it('throw sur clé inconnue (typo détecté)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      sourceDirectory: 'src',  // typo: devrait être sourceDir
    }))
    assert.throws(() => findConfig(root), /clé inconnue 'sourceDirectory'/)
  })

  it('throw sur defaultScriptLang invalide', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      defaultScriptLang: 'rust',
    }))
    assert.throws(() => findConfig(root), /defaultScriptLang invalide/)
  })

  it('throw sur dev.X inconnu', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      dev: { foo: 1 },
    }))
    assert.throws(() => findConfig(root), /dev\.foo : clé inconnue/)
  })

  // Régression : `minify`/`dev.port`/`dev.host`
  // n'étaient jamais validés sur leur TYPE (seule la présence de clé comptait) —
  // `"minify": "true"` (string) passait la validation puis `resolveBundlerOpts`
  // (`config.minify === true`) l'évaluait silencieusement à `false`, l'inverse
  // exact de l'intention ; `dev.port: "abc"` se propageait jusqu'à
  // `StaticServer.listen()`, échec tardif et confus plutôt qu'une erreur de
  // config claire et immédiate.
  it("throw sur minify:\"true\" (string, AVANT le fix : passait la validation puis s'évaluait à false)", () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ minify: 'true' }))
    assert.throws(() => findConfig(root), /minify doit être un booléen/)
  })

  it('minify: true/false (booléen réel) reste accepté (pas de régression)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ minify: false }))
    assert.doesNotThrow(() => findConfig(root))
  })

  it('throw sur dev.port:"abc" (string non numérique, AVANT le fix : passait la validation)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ dev: { port: 'abc' } }))
    assert.throws(() => findConfig(root), /dev\.port doit être un nombre/)
  })

  it('throw sur dev.host non-string (ex. un nombre)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ dev: { host: 1234 } }))
    assert.throws(() => findConfig(root), /dev\.host doit être une chaîne/)
  })

  it('dev.port/dev.host valides restent acceptés (pas de régression)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ dev: { port: 4000, host: '0.0.0.0' } }))
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.dev?.port, 4000)
  })

  // Régression : la validation stricte
  // laissait passer des types faux sur la moitié des clés.
  it('throw sur dev non-objet (ex. "3939", AVANT le fix : ignoré EN SILENCE)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ dev: '3939' }))
    assert.throws(() => findConfig(root), /'dev' doit être un objet/)
  })

  it('throw sur dev.port hors plage TCP (99999, AVANT le fix : accepté)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ dev: { port: 99999 } }))
    assert.throws(() => findConfig(root), /dev\.port doit être un entier entre 1 et 65535/)
  })

  it('throw sur dev.port non entier (3939.5, AVANT le fix : accepté)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ dev: { port: 3939.5 } }))
    assert.throws(() => findConfig(root), /dev\.port doit être un entier entre 1 et 65535/)
  })

  it('throw sur contextAlias non-booléen ("false" string, TRUTHY — inverse de l\'intention)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ contextAlias: 'false' }))
    assert.throws(() => findConfig(root), /contextAlias doit être un booléen/)
  })

  it('throw sur urlPrefix non-string (42, AVANT le fix : accepté)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ urlPrefix: 42 }))
    assert.throws(() => findConfig(root), /urlPrefix doit être une chaîne/)
  })

  it('throw sur sourceDir non-string (42, AVANT le fix : erreur Node brute plus tard dans resolve())', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 42 }))
    assert.throws(() => findConfig(root), /sourceDir doit être une chaîne/)
  })

  it('throw sur sigil chaîne vide (falsy — contournait le check avant le fix)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sigil: '' }))
    assert.throws(() => findConfig(root), /sigil invalide/)
  })

  it('contextAlias: true (booléen réel) reste accepté (pas de régression)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ contextAlias: true }))
    assert.doesNotThrow(() => findConfig(root))
  })

  // `prune` gouverne la purge des orphelins d'outputDir
  // après un `mjs build` sans erreur (Bundler.pruneOrphans). Même motif que contextAlias
  // ci-dessus : un "false" STRING est TRUTHY, l'inverse exact de l'intention.
  it('throw sur prune non-booléen ("false" string, TRUTHY — inverse de l\'intention)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ prune: 'false' }))
    assert.throws(() => findConfig(root), /prune doit être un booléen/)
  })

  it('prune: false (booléen réel) accepté', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ prune: false }))
    const found = findConfig(root)
    assert.ok(found, 'devrait trouver le config')
    assert.equal(found!.config.prune, false)
  })

  // Régression : `urlPrefix` est un champ
  // DOCUMENTÉ de MjsConfig (JSDoc), mais absent de KNOWN_KEYS — tout
  // mjs.config.json le renseignant faisait planter le build entier avec
  // « clé inconnue 'urlPrefix' ».
  it("accepte 'urlPrefix' (documenté dans MjsConfig, AVANT le fix : rejeté comme clé inconnue)", () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      urlPrefix: '/static/modularjs',
    }))
    const found = findConfig(root)
    assert.ok(found, "AVANT le fix : findConfig() jetait 'clé inconnue urlPrefix'")
    assert.equal(found!.config.urlPrefix, '/static/modularjs')
  })

  it("accepte 'runtimeDir' (déjà dans KNOWN_KEYS avant ce fix, vérifie la non-régression)", () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      runtimeDir: 'vendor/modularjs-runtime',
    }))
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.runtimeDir, 'vendor/modularjs-runtime')
  })

  it('accepte un bloc render valide', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      sourceDir: 'src',
      render: {
        default: 'prerender',
        header: 'X-MJS-Render',
        routes: {
          '/':            { component: 'mjs-landing' },
          '/blog':        { component: 'mjs-blog', mode: 'ssr:markers' },
          '/produit/:id': { component: 'mjs-produit', mode: 'ssr' },
        },
      },
    }))
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.render!.default, 'prerender')
    assert.equal(found!.config.render!.routes!['/blog'].mode, 'ssr:markers')
  })

  // `render.outDir` est le dossier que le prérendu ÉCRIT et dont il RETIRE ses fragments périmés :
  // il doit rester dans le projet. Un `..` (ou un chemin absolu ailleurs) porterait ces deux gestes
  // hors de l'arbre que le développeur a sous les yeux.
  it('accepte render.outDir dans le projet, racine comprise', () => {
    for (const outDir of ['public/pages', '.', './mjs_pages', 'a/../b']) {
      const root = mjsTmp('cfg')
      writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
        render: { outDir, routes: { '/': { component: 'mjs-x' } } },
      }))
      const found = findConfig(root)
      assert.ok(found, `render.outDir '${outDir}' doit être accepté`)
      assert.equal(found!.config.render!.outDir, outDir)
    }
  })

  it('throw sur render.outDir hors du projet (`..`, chemin absolu ailleurs)', () => {
    for (const outDir of ['..', '../pages', 'public/../../ailleurs', '/tmp/ailleurs']) {
      const root = mjsTmp('cfg')
      writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
        render: { outDir, routes: { '/': { component: 'mjs-x' } } },
      }))
      assert.throws(() => findConfig(root), /render\.outDir doit rester dans le dossier du projet/, `render.outDir '${outDir}' doit être refusé`)
    }
  })

  it('throw sur render.X inconnu', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      render: { defualt: 'csr' },  // typo
    }))
    assert.throws(() => findConfig(root), /render\.defualt : clé inconnue/)
  })

  it('throw sur render.default invalide', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      render: { default: 'magique' },
    }))
    assert.throws(() => findConfig(root), /render\.default invalide/)
  })

  it('throw si une route render n\'a pas de component', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      render: { routes: { '/': { mode: 'prerender' } } },
    }))
    assert.throws(() => findConfig(root), /component.*est requis/)
  })

  it('throw sur mode de route invalide', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      render: { routes: { '/': { component: 'mjs-x', mode: 'turbo' } } },
    }))
    assert.throws(() => findConfig(root), /mode invalide/)
  })

  // render.target (sélecteur CSS du contenant) + render.method (3 valeurs :
  // update/replace/append). Portée GLOBALE seulement : ni RenderRoute ni KNOWN_ROUTE_KEYS ne bougent.
  it('accepte render.target + render.method valides', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      render: { target: 'main', method: 'replace' },
    }))
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.render!.target, 'main')
    assert.equal(found!.config.render!.method, 'replace')
  })

  // method prend TROIS valeurs (update défaut/ex-append, replace, append VRAI sens).
  it("accepte les 3 valeurs de render.method ('update'/'append'/'replace')", () => {
    for (const method of ['update', 'append', 'replace'] as const) {
      const root = mjsTmp('cfg')
      writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ render: { method } }))
      const found = findConfig(root)
      assert.equal(found!.config.render!.method, method, `method '${method}' doit être accepté tel quel`)
    }
  })

  it('throw sur render.target chaîne vide', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      render: { target: '' },
    }))
    assert.throws(() => findConfig(root), /render\.target doit être une chaîne non vide/)
  })

  it("throw sur render.method invalide ('prepend', hors update/replace/append), message listant les 3 valides", () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      render: { method: 'prepend' },
    }))
    assert.throws(() => findConfig(root), /render\.method invalide[\s\S]*Valeurs valides : update, replace, append/)
  })

  it('throw sur render.cible (clé inconnue, non-régression KNOWN_RENDER_KEYS)', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      render: { cible: 'main' },
    }))
    assert.throws(() => findConfig(root), /render\.cible : clé inconnue/)
  })

  it('accepte serveur.antiCheat.codePerIp : [n entier ≥ 1, fenêtreMs > 0]', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      serveur: { antiCheat: { codePerIp: [5, 30000] } },
    }))
    const found = findConfig(root)
    assert.ok(found, 'devrait trouver et VALIDER le config')
    assert.deepEqual((found!.config.serveur as any).antiCheat.codePerIp, [5, 30000])
  })

  it('throw sur serveur.antiCheat.codePerIp malformé', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      serveur: { antiCheat: { codePerIp: [0, 30000] } },
    }))
    assert.throws(() => findConfig(root), /codePerIp/)
  })
})

describe('resolveBundlerOpts', () => {
  it('résout les paths relativement à configDir', () => {
    const opts = resolveBundlerOpts(
      { sourceDir: 'src', outputDir: 'out', manifestPath: 'bundle.js' },
      '/project'
    )
    assert.equal(opts.sourceDir, '/project/src')
    assert.equal(opts.outputDir, '/project/out')
    assert.equal(opts.manifestPath, '/project/bundle.js')
  })

  // `minify` NE FAIT PLUS basculer le projet en prod : il ne dit que la
  // minification. C'est `env` qui porte l'environnement. Avant, un simple `"minify": true`
  // dans mjs.config.json retirait en silence le panneau d'inspection du bundle local.
  it('mappe minify: true → minify: true, sans rien dire de l\'environnement', () => {
    const opts = resolveBundlerOpts({ minify: true }, '/p')
    assert.equal(opts.minify, true)
    assert.ok(!('env' in opts), "l'environnement vient de la commande, jamais du fichier de config")
  })

  it("défaut : minify 'auto' quand la config ne dit rien", () => {
    const opts = resolveBundlerOpts({}, '/p')
    assert.equal(opts.minify, 'auto')
  })

  it('garde defaultScriptLang inchangé', () => {
    const opts = resolveBundlerOpts({ defaultScriptLang: 'ts' }, '/p')
    assert.equal(opts.defaultScriptLang, 'ts')
  })

  it('paths undefined si non spécifiés dans config', () => {
    const opts = resolveBundlerOpts({}, '/p')
    assert.equal(opts.sourceDir, undefined)
    assert.equal(opts.outputDir, undefined)
  })

  // Régression : `runtimeDir` passait la
  // validation (KNOWN_KEYS) SANS ERREUR mais `resolveBundlerOpts` ne le
  // renvoyait jamais — silencieusement inerte, le pire des deux mondes (le
  // build semble accepter l'option, mais elle n'a AUCUN effet).
  it("résout runtimeDir relativement à configDir (AVANT le fix : jamais renvoyé, silencieusement ignoré)", () => {
    const opts = resolveBundlerOpts({ runtimeDir: 'vendor/mjs-runtime' }, '/project')
    assert.equal(opts.runtimeDir, '/project/vendor/mjs-runtime')
  })

  it('urlPrefix est renvoyé tel quel (AVANT le fix : absent du retour, silencieusement ignoré)', () => {
    const opts = resolveBundlerOpts({ urlPrefix: '/static/mjs' }, '/project')
    assert.equal(opts.urlPrefix, '/static/mjs')
  })
})
