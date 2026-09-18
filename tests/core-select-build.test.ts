// Test neuf — modules cœur select/option : câblage bundler RÉEL
// (coreModulesDir SANS override = catalogue réel src/core-modules/), patron
// calqué sur tests/bundler-tag-shortcut.test.ts et
// tests/mjs-modal-bundler-integration.test.ts:62-85. Prouve que <@select>
// et <@option> se résolvent bien vers le catalogue cœur LIVRÉ (transitivité,
// tag <mjs-*> PLAT), pas une simple sonde locale — plus l'override projet-sur-cœur
// et les deux erreurs de migration (<@mjs-select>, <mjs-core-select>).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

async function buildProject(files: Record<string, string>): Promise<{ root: string; outDir: string; stats: any }> {
  const root = mjsTmp('core-select-build')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(srcDir, rel), content)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js' }))
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  return { root, outDir, stats }
}

function messages(stats: any): string {
  return stats.errors.map((e: any) => e.message).join('\n')
}

function readComponent(outDir: string, name: string): string {
  const files = readdirSync(outDir)
  const f = files.find((f) => new RegExp(`^${name}-[a-f0-9]{8}\\.js$`).test(f))
  assert.ok(f, `${name}-*.js doit exister dans ${outDir} (trouvés : ${files.join(', ')})`)
  return readFileSync(join(outDir, f!), 'utf-8')
}

describe('core-select/core-option — résolution RÉELLE via <@select>/<@option> (catalogue src/core-modules/)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('<@select> seul (sans option) : build vert, manifeste porte select (clé PLATE), gabarit réécrit <mjs-select>', async () => {
    const { outDir, stats } = await buildProject({ 'hote.mjs': '<@select name="pays" placeholder="Choisir"></@select>' })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.ok(stats.manifest['select'], 'manifeste doit exposer select')
    assert.equal(stats.manifest['core-select'], undefined, 'l\'ancienne clé core-select ne doit plus jamais être écrite')
    const files = readdirSync(outDir)
    assert.ok(files.some((f) => /^select-[a-f0-9]{8}\.js$/.test(f)), `chunk select-*.js attendu parmi : ${files.join(', ')}`)
    assert.match(readComponent(outDir, 'hote'), /<mjs-select\b/)
  })

  it('<@select> avec <@option> slottés : les DEUX modules cœur au manifeste (transitivité par référence directe du gabarit hôte), gabarit réécrit <mjs-option>', async () => {
    const HOST = [
      '<@select name="pays">',
      '  <@option value="fr" icon="🇫🇷">France</@option>',
      '  <@option value="de" icon="🇩🇪">Allemagne</@option>',
      '</@select>',
    ].join('\n')
    const { outDir, stats } = await buildProject({ 'hote.mjs': HOST })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.ok(stats.manifest['select'], 'manifeste doit exposer select')
    assert.ok(stats.manifest['option'], 'manifeste doit exposer option')
    const files = readdirSync(outDir)
    assert.ok(files.some((f) => /^option-[a-f0-9]{8}\.js$/.test(f)), `chunk option-*.js attendu parmi : ${files.join(', ')}`)
    const out = readComponent(outDir, 'hote')
    assert.match(out, /<mjs-select\b/)
    assert.match(out, /<mjs-option\b/)
  })

  it('<@option> référencé seul (sans select autour) compile aussi (aucune dépendance option → select)', async () => {
    const { stats } = await buildProject({ 'hote.mjs': '<@option value="fr">France</@option>' })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.ok(stats.manifest['option'])
    assert.equal(stats.manifest['select'], undefined, 'select ne doit pas apparaître si rien ne le référence')
  })

  it('<@select value=!{$x}> compile sans erreur (liaison two-way sur module cœur, dispatch bindingComponent)', async () => {
    const HOST = [
      '<script>',
      '  $pays = null',
      '</script>',
      '<@select name="pays" value=!{$pays}></@select>',
    ].join('\n')
    const { outDir, stats } = await buildProject({ 'hote.mjs': HOST })
    assert.equal(stats.errors.length, 0, messages(stats))
    const out = readComponent(outDir, 'hote')
    assert.match(out, /_mjs_binds/, 'la liaison two-way doit passer par le mécanisme _mjs_binds (bindingComponent)')
    assert.match(out, /mjs-bind:value/, 'le retour enfant→parent doit écouter mjs-bind:value')
  })

  it('<@select> avec {for} réactif générant des <@option> : build vert (le panneau doit pouvoir suivre un {for})', async () => {
    const HOST = [
      '<script>',
      '  $pays = [{ code: "fr", nom: "France" }, { code: "de", nom: "Allemagne" }]',
      '</script>',
      '<@select name="pays">',
      '  {for p in $pays by code}',
      '    <@option value={p.code}>{p.nom}</@option>',
      '  {end}',
      '</@select>',
    ].join('\n')
    const { stats } = await buildProject({ 'hote.mjs': HOST })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.ok(stats.manifest['select'] && stats.manifest['option'])
  })

  it('typecheck implicite : les deux modules cœur eux-mêmes compilent sans erreur ni avertissement (0/0)', async () => {
    const { stats } = await buildProject({ 'hote.mjs': '<@select name="x"><@option value="a">A</@option></@select>' })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.equal(stats.warnings.length, 0, stats.warnings.join('\n'))
  })
})

describe('core-select — override projet-sur-cœur + erreurs de migration', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('override : un select.mjs DU PROJET fait taire le module cœur — <@select> résout vers LUI, pas vers le catalogue cœur', async () => {
    const { outDir, stats } = await buildProject({
      'hote.mjs': '<@select></@select>',
      'select.mjs': '<p class="projet-select">select DU PROJET</p>',
    })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.ok(stats.manifest['select'], 'manifeste doit exposer select (le fichier PROJET)')
    const files = readdirSync(outDir)
    const selectFiles = files.filter((f) => /^select-[a-f0-9]{8}\.js$/.test(f))
    assert.equal(selectFiles.length, 1, `un seul chunk select-*.js attendu (celui du projet) parmi : ${files.join(', ')}`)
    const selectOut = readFileSync(join(outDir, selectFiles[0]), 'utf-8')
    assert.match(selectOut, /select DU PROJET/, 'le contenu compilé doit être celui DU PROJET')
    assert.doesNotMatch(selectOut, /select-btn/, 'le module CŒUR (qui, lui, porte la classe select-btn) ne doit jamais être compilé')
    assert.match(readComponent(outDir, 'hote'), /<mjs-select><\/mjs-select>/)
  })

  it('<@mjs-select> (ANCIENNE notation retirée) → ERREUR DE MIGRATION, même si select.mjs existe réellement au catalogue cœur', async () => {
    const { stats } = await buildProject({ 'hote.mjs': '<@mjs-select name="pays"></@mjs-select>' })
    assert.ok(stats.errors.length > 0, 'le build doit échouer (notation retirée)')
    const msg = messages(stats)
    assert.match(msg, /« <@mjs-select> » est retirée/)
    assert.match(msg, /écris « <@select> »/)
  })

  it('<mjs-core-select> (ANCIEN littéral écrit à la main) → erreur « n\'existe plus », jamais résolu vers le cœur', async () => {
    const { stats } = await buildProject({ 'hote.mjs': '<mjs-core-select></mjs-core-select>' })
    assert.ok(stats.errors.length > 0)
    const msg = messages(stats)
    assert.match(msg, /n'existe plus/)
    assert.match(msg, /<@select>/)
  })
})
