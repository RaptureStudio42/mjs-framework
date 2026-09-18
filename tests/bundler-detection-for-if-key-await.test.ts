// mjs_for.ts / mjs_if.ts / mjs_key.ts / mjs_await.ts — les 4 blocs structurels du gabarit
// (`{for}`/`{if}`/`{key}`/`{await}`), RATTACHÉS D'OFFICE au cœur jusqu'ici (mjs_element.ts en
// portait le moteur), ne doivent être embarqués QUE si le projet en écrit — même règle que
// mjs_title.ts/mjs_failed.ts, mais deux fois plus de prudence : ce sont les briques les plus
// élémentaires de la syntaxe, un faux négatif casserait tout.
//
// `{key}` et `{await}` FORCENT `if` (`_mjs_updKey`/`_mjs_updAwait` appellent des méthodes de
// mjs_if.ts) : mjs_if.ts suit toujours l'un des deux. `{for}` est EN PLUS forcé dès que
// `flip` est du bundle (`mjs_flip.ts` capture `_mjs_reconcileList` à son propre chargement) — TOUS
// les tests d'isolement ci-dessous passent donc `runtime: []` (jamais le défaut, qui
// sélectionne `flip` comme tout optionnel classique et forcerait `mjs_for.ts` en silence,
// même patron que `bundler-detection-ticker.test.ts` face à spring/smooth).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_FOR   = 'µ.Element.prototype._mjs_reconcileList = function'
const MARK_IF    = 'µ.Element.prototype._mjs_updIf = function'
const MARK_KEY   = 'µ.Element.prototype._mjs_updKey = function'
const MARK_AWAIT = 'µ.Element.prototype._mjs_updAwait = function'
// `_mjs_updList` : la variante d'un `{for}` dont les ANCRES ne sont pas celles du composant —
// `{for}` dans un autre `{for}`, ou dans une branche `{await}` (mjs_for_nested.ts). Un `{for}` de
// racine, dans un `{if}` ou dans un `{key}` compile en `_mjs_updFor`, qui n'y touche jamais
const MARK_NESTED = 'µ.Element.prototype._mjs_updList = function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-for-if-key-await')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(srcDir, name), content)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', ...cfgExtra,
  }))
  const found = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts = resolveBundlerOpts(found!.config, found!.configDir)
  const bundler = new Bundler(opts as any)
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  return { outDir }
}

function coreContent(outDir: string): string {
  const files = readdirSync(outDir)
  const coreFile = files.find((f) => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, coreFile!), 'utf-8')
}

describe('mjs_for/if/key/await.ts — détachés du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS aucun des 4 blocs : les quatre ABSENTS', async function () {
    const { outDir } = await buildProject({ runtime: [] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_FOR), false)
    assert.equal(core.includes(MARK_IF), false)
    assert.equal(core.includes(MARK_KEY), false)
    assert.equal(core.includes(MARK_AWAIT), false)
  })

  it('{for x in [...]}{end} seul : mjs_for.ts présent, if/key/await ABSENTS', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>$items = [1, 2, 3]</script>', '<ul>', '{for x in $items}<li>{x}</li>{end}', '</ul>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_FOR), '{for} doit embarquer mjs_for.ts')
    assert.equal(core.includes(MARK_IF), false)
    assert.equal(core.includes(MARK_KEY), false)
    assert.equal(core.includes(MARK_AWAIT), false)
  })

  it('{for} à la RACINE seul : mjs_for_nested.ts ABSENT (la racine compile en _mjs_updFor)', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>$items = [1, 2, 3]</script>', '<ul>', '{for x in $items}<li>{x}</li>{end}', '</ul>'].join('\n'),
    })
    assert.equal(coreContent(outDir).includes(MARK_NESTED), false)
  })

  it('{for} DANS un {for} : mjs_for_nested.ts présent, avec mjs_for.ts', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>$groupes = [[1, 2]]</script>', '{for g in $groupes}<ul>{for x in g}<li>{x}</li>{end}</ul>{end}'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_NESTED), '{for} dans {for} doit embarquer mjs_for_nested.ts')
    assert.ok(core.includes(MARK_FOR), 'et la réconciliation de liste qu\'il appelle')
  })

  it("{for} dans une branche {await} : mjs_for_nested.ts présent", async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', '$p = Promise.resolve(1)', '$items = [1, 2]', '</script>', '{await $p}<i>a</i>{success v}<ul>{for x in $items}<li>{x}</li>{end}</ul>{end}'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_NESTED))
  })

  it('{for} dans un {if} ou un {key} : mjs_for_nested.ts ABSENT (ces deux blocs gardent _mjs_updFor)', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', '$v = true', '$items = [1, 2]', '</script>', '{if $v}<ul>{for x in $items}<li>{x}</li>{end}</ul>{end}'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_NESTED), false)
    assert.ok(core.includes(MARK_FOR), 'la liste reste réconciliée par mjs_for.ts')
  })

  it("runtime:['for_nested'] sans usage : présent, et mjs_for.ts avec lui (il appelle _mjs_reconcileList)", async function () {
    const { outDir } = await buildProject({ runtime: ['for_nested'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_NESTED))
    assert.ok(core.includes(MARK_FOR), 'mjs_for.ts doit suivre : _mjs_updList appelle _mjs_reconcileList')
  })

  it('{if cond}{end} seul : mjs_if.ts présent, for/key/await ABSENTS', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>$show = true</script>', '{if $show}<p>oui</p>{end}'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_IF), '{if} doit embarquer mjs_if.ts')
    assert.equal(core.includes(MARK_FOR), false)
    assert.equal(core.includes(MARK_KEY), false)
    assert.equal(core.includes(MARK_AWAIT), false)
  })

  it('{key expr}{end} À LA RACINE seul : mjs_key.ts présent, mjs_if.ts FORCÉ (partage _mjs_tryReviveDying), for/await ABSENTS', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>$k = 1</script>', '{key $k}<p>{$k}</p>{end}'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_KEY), '{key} doit embarquer mjs_key.ts')
    assert.ok(core.includes(MARK_IF), "{key} doit FORCER mjs_if.ts (_mjs_updKey appelle _mjs_tryReviveDying/_mjs_resetNestedMemos)")
    assert.equal(core.includes(MARK_FOR), false)
    assert.equal(core.includes(MARK_AWAIT), false)
  })

  it('{await promesse}{success}{end} seul : mjs_await.ts présent, mjs_if.ts FORCÉ (_mjs_updAwait délègue à _mjs_updIf), for/key ABSENTS', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>$p = Promise.resolve(1)</script>', '{await $p}chargement{success v}{v}{end}'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_AWAIT), '{await} doit embarquer mjs_await.ts')
    assert.ok(core.includes(MARK_IF), '{await} doit FORCER mjs_if.ts (_mjs_updAwait appelle _mjs_updIf)')
    assert.equal(core.includes(MARK_FOR), false)
    assert.equal(core.includes(MARK_KEY), false)
  })

  it('projet qui n\'écrit aucun bloc, mais utilise <@select> (module du cœur, {for}+{if} réels) : mjs_for.ts ET mjs_if.ts EMBARQUÉS', async function () {
    const { outDir } = await buildProject({ runtime: [] }, { 'hop.mjs': '<@select/>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_FOR), '<@select> écrit {for} : doit être détecté transitivement')
    assert.ok(core.includes(MARK_IF), '<@select> écrit {if} : doit être détecté transitivement')
    assert.equal(core.includes(MARK_KEY), false)
    assert.equal(core.includes(MARK_AWAIT), false)
  })

  it('bloc écrit SEULEMENT dans un partiel <@include> : joint (aucun signal dans le fichier hôte)', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<div>', '  <@include ligne>', '</div>'].join('\n'),
      '_ligne.mjs': '{if true}<li>x</li>{end}',
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_IF), 'le {if} du partiel _ligne.mjs doit être détecté même si hop.mjs ne cite jamais { if')
  })

  it("runtime:['for'] / ['if'] / ['key'] / ['await'] sans usage dans les sources : présents quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['for', 'if', 'key', 'await'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_FOR))
    assert.ok(core.includes(MARK_IF))
    assert.ok(core.includes(MARK_KEY))
    assert.ok(core.includes(MARK_AWAIT))
  })

  it("runtime:['flip'] SANS aucun {for} dans les sources : mjs_for.ts présent quand même (garde de sécurité — mjs_flip.ts capture _mjs_reconcileList à son chargement)", async function () {
    const { outDir } = await buildProject({ runtime: ['flip'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_FOR))
  })

  it("runtime: 'all' (API directe, faits inconnus) : cœur fonctionnellement identique à avant — les 4 blocs présents", function () {
    const b = new Bundler({ runtime: 'all', i18n: { default: 'fr' } })
    const { files } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_for.ts') && files.includes('mjs_if.ts') && files.includes('mjs_key.ts') && files.includes('mjs_await.ts'),
      "'all' sans argument 'used' (faits inconnus, API directe) doit garder les 4 — même doctrine que title/store/interpolate")
  })
})
