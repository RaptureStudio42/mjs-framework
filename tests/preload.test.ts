// Préchargement des liens (µ.preload) — config + compilation des directives.
// Le comportement runtime (survol/eager, résolution local/serveur) est délégué au
// navigateur ; on couvre ici la validation de config, la normalisation, et le fait
// que les 3 niveaux de contrôle compilent bien (config → manifeste, @preload module
// → _mjs_preload, @preload lien → data-mjs-preload).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { findConfig, normalizePreload } from '../src/bundler/config.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('preload — validation de config', () => {
  const mkConfig = (preload: string): string => {
    const root = mjsTmp('preload-cfg')
    writeFileSync(join(root, 'mjs.config.json'), `{ "preload": ${preload} }`)
    return root
  }

  it('accepte l\'objet { view, page } et le raccourci chaîne', () => {
    assert.ok(findConfig(mkConfig('{ "view": "on", "page": "hover" }')))
    assert.ok(findConfig(mkConfig('"hover"')))
    assert.ok(findConfig(mkConfig('"off"')))
  })

  it('rejette un mode invalide (objet ET chaîne)', () => {
    assert.throws(() => findConfig(mkConfig('{ "view": "sometimes" }')), /preload\.view invalide/)
    assert.throws(() => findConfig(mkConfig('"maybe"')), /preload invalide/)
  })

  // `eager` disparaît : refusé en config, le message générique
  // liste `on` parmi les valeurs valides — c'est le nom à écrire.
  it('rejette `eager` (objet ET chaîne) — le message liste `on` comme valeur valide', () => {
    assert.throws(() => findConfig(mkConfig('{ "view": "eager" }')), /preload\.view invalide[\s\S]*\bon\b/)
    assert.throws(() => findConfig(mkConfig('"eager"')), /preload invalide[\s\S]*\bon\b/)
  })

  it('rejette une sous-clé preload inconnue', () => {
    assert.throws(() => findConfig(mkConfig('{ "lokal": "hover" }')), /preload\.lokal : clé inconnue/)
  })

  // Anciens axes local/server renommés view/page : erreur de migration
  // CIBLÉE (message dédié), déclenchée par l'une OU l'autre ancienne clé.
  it('rejette les anciens axes `local`/`server` (renommés `view`/`page`) avec un message de migration dédié', () => {
    assert.throws(
      () => findConfig(mkConfig('{ "local": "eager" }')),
      /« local ».*« server ».*renommés.*« view ».*« page »/
    )
    assert.throws(
      () => findConfig(mkConfig('{ "server": "hover" }')),
      /« local ».*« server ».*renommés.*« view ».*« page »/
    )
  })

  it('normalizePreload applique les défauts (view:hover · page:off)', () => {
    assert.deepEqual(normalizePreload(undefined), { view: 'hover', page: 'off' })
    assert.deepEqual(normalizePreload('on'), { view: 'on', page: 'off' })
    assert.deepEqual(normalizePreload({ page: 'hover' }), { view: 'hover', page: 'hover' })
  })
})

describe('preload — compilation des 3 niveaux', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it('config → µ.preload ; @preload module → _mjs_preload ; @preload lien → data-mjs-preload', async function () {
    this.timeout(30000)
    const root = mjsTmp('preload-cc')
    const src = join(root, 'src'); mkdirSync(src)
    const out = join(root, 'out')
    // @preload racine (niveau 2) + @preload sur un <a> (niveau 3) + config (niveau 1)
    // + @method/@confirm (UJS) sur un lien. Le <code> affiche `@preload="off"`,
    // le <pre> affiche `@confirm="Continuer ?"` → aucun des deux ne DOIT être
    // converti (masquage).
    writeFileSync(
      join(src, 'link-demo.mjs'),
      `@preload hover\n\n<nav><a href="#/a">A</a><a href="#/b" @preload="on">B</a></nav>\n` +
      `<p><code>&lt;a @preload="off"&gt;</code></p>\n` +
      `<a href="/session" @method="delete" @confirm="Vraiment supprimer ?">Suppr</a>\n` +
      `<pre>&lt;a @confirm="Continuer ?"&gt;</pre>\n`,
    )
    const bundler = new Bundler({
      sourceDir: src, outputDir: out, manifestPath: join(out, 'bundle.js'),
      preload: { view: 'on' },
    })
    await bundler.compile()
    await bundler.close()

    const files = readdirSync(out)
    const comp = readFileSync(join(out, files.find(f => /^link-demo-/.test(f))!), 'utf-8')
    const manifest = readFileSync(join(out, 'bundle.js'), 'utf-8')
    assert.match(comp, /_mjs_preload = "hover"/, 'directive module → _mjs_preload')
    assert.match(comp, /data-mjs-preload=['"]on['"]/, 'attribut lien → data-mjs-preload')
    assert.match(comp, /&lt;a @preload/, 'le <code> d\'exemple garde @preload (pas de conversion)')
    assert.match(comp, /mjs-method=['"]delete['"]/, 'attribut @method → mjs-method')
    assert.match(comp, /mjs-confirm=['"]Vraiment supprimer \?['"]/, 'attribut @confirm → mjs-confirm')
    assert.match(comp, /&lt;a @confirm/, 'le <pre> d\'exemple garde @confirm (pas de conversion)')
    assert.match(manifest, /µ\.preload = \{"view":"on"/, 'config → µ.preload au manifeste')
  })
})
