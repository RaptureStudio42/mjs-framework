// Test de régression : une animation
// référencée (typo `@transition.fadde` au lieu de `@transition.fade`, ou
// tout usage de `µ.anim.X` où X n'existe pas dans src/runtime/animations/)
// était sautée en SILENCE par `compileUsedAnimations` — le composant génère
// quand même du code appelant `µ.anim.fadde`, jamais défini → échec
// SILENCIEUX à l'exécution, le build ne signalant RIEN. En prime, le
// compteur `written` comptait cette anim fantôme comme "écrite" (basé sur
// `usedAnimations.size`, pas le nombre réellement émis).
//
// Fix : `compileUsedAnimations` retourne `{written, missing}` — le caller
// pousse un warning explicite par nom manquant et n'incrémente `written`
// que du compte RÉEL.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — animation inconnue (typo) : warning explicite + compteur written correct', function () {
  this.timeout(15000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("µ.anim.fadde (typo, n'existe pas) → warning explicite, written ne compte pas le fantôme", async function () {
    const root = mjsTmp('anim-typo')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // 'fade' existe réellement (src/runtime/animations/fade.ts), 'fadde' est
    // une typo qui n'existe PAS.
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<script lang="coffee">',
      '  a = µ.anim.fade',
      '  b = µ.anim.fadde',
      '</script>',
      '<p>{a}{b}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const warning = stats.warnings.find(w => w.includes('fadde'))
    assert.ok(warning,
      `AVANT le fix : une anim inconnue (typo) était sautée en silence, aucun warning. warnings:\n${stats.warnings.join('\n')}`)
    assert.match(warning!, /Animation inconnue/)
    await bundler.close()
  })

  it("aucune typo (toutes les anims utilisées existent) → aucun warning d'animation", async function () {
    const root = mjsTmp('anim-ok')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<script lang="coffee">',
      '  a = µ.anim.fade',
      '</script>',
      '<p>{a}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.equal(stats.warnings.filter(w => /Animation inconnue/.test(w)).length, 0,
      `aucun warning attendu. warnings:\n${stats.warnings.join('\n')}`)
    await bundler.close()
  })

  // finitions build (correctif B) — µanim.create/crossfade enregistrent
  // une anim DYNAMIQUEMENT (au chargement du script, avant le rendu qui
  // l'utilise) : aucun fichier `<runtimeDir>/animations/<nom>.ts` ne la décrit,
  // ce n'était pourtant PAS un « manquant ».

  it("µanim.create('spin', …) + @in.spin (anim DÉFINIE dynamiquement) → aucun warning « Animation inconnue »", async function () {
    const root = mjsTmp('anim-defined-create')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // 'spin' n'existe PAS dans src/runtime/animations/ — elle est enregistrée
    // par µanim.create() au chargement du <script>, avant que @in.spin ne s'en serve.
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<script>',
      '  $visible = true',
      "  µanim.create('spin', { duration: 1000 })",
      '</script>',
      '{if $visible}<div @in.spin={duration: 1000}>x</div>{end}',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const warning = stats.warnings.find(w => w.includes("'spin'"))
    assert.ok(!warning,
      `AVANT le fix : 'spin' (définie dynamiquement par µanim.create) était signalée comme manquante à tort. warnings:\n${stats.warnings.join('\n')}`)
    await bundler.close()
  })

  it("µanim.crossfade('todo', …) + @in.todoReceive/@out.todoSend (anims DÉFINIES dynamiquement) → aucun warning « Animation inconnue »", async function () {
    const root = mjsTmp('anim-defined-crossfade')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // 'todoSend'/'todoReceive' n'existent PAS dans src/runtime/animations/ —
    // µanim.crossfade('todo', …) les enregistre au chargement du <script>
    // (cf. runtime/animations/crossfade.ts : µ.anim[`${name}Send`]/[`${name}Receive`]).
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<script>',
      '  $items = [{id: 1}]',
      "  µanim.crossfade('todo', { duration: 600 })",
      '</script>',
      '{for todo in $items}',
      '  <div @in.todoReceive={key: todo.id} @out.todoSend={key: todo.id}>x</div>',
      '{end}',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const warnings = stats.warnings.filter(w => /Animation inconnue/.test(w))
    assert.equal(warnings.length, 0,
      `AVANT le fix : 'todoSend'/'todoReceive' (définies dynamiquement par µanim.crossfade) étaient signalées comme manquantes à tort. warnings:\n${stats.warnings.join('\n')}`)
    await bundler.close()
  })

  it('@in.zzznope (jamais définie, ni fichier runtime ni µanim.create/crossfade) → warning « Animation inconnue » TOUJOURS émis', async function () {
    const root = mjsTmp('anim-really-missing')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<script lang="coffee">',
      '  $visible = true',
      '</script>',
      '{if $visible}<div @in.zzznope>x</div>{end}',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    // Contrôle négatif du correctif B : une VRAIE anim manquante (jamais définie
    // par µanim.create/crossfade) ne doit PAS être avalée par `definedAnimations`.
    const warning = stats.warnings.find(w => w.includes('zzznope'))
    assert.ok(warning,
      `une VRAIE anim manquante doit toujours être signalée. warnings:\n${stats.warnings.join('\n')}`)
    assert.match(warning!, /Animation inconnue/)
    await bundler.close()
  })
})
