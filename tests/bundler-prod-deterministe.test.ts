// build PRODUCTION reproductible — le mangleCache esbuild (noms courts des propriétés
// `_mjs_*`) est un état PARTAGÉ entre toutes les minifications d'un même compile(). Si la
// minification de chaque composant tourne DANS le parallélisme de la phase de transpilation
// (ordre d'achèvement des workers, non déterministe), l'ordre dans lequel les propriétés
// `_mjs_*` de CHAQUE composant réservent leur nom court varie d'un build à l'autre — deux
// builds STRICTEMENT identiques en source peuvent produire des composants ET un cœur
// byte-DIFFÉRENTS. La fixture ci-dessous porte volontairement plusieurs composants avec des
// propriétés `_mjs_*` DISTINCTES (pas la même partout, contrairement à bundler-prod-e2e.test.ts
// qui n'en a qu'une seule — insuffisant pour révéler un ordre d'attribution qui varie) : une
// prop par composant, en nombre suffisant pour que le parallélisme (PARALLEL_LIMIT >= 2) ait
// une vraie chance de les faire terminer dans un ordre différent d'un run à l'autre.
//
// La transpilation (workers) reste parallèle ; seule la MINIFICATION doit être séquentielle,
// dans un ordre trié stable (par stem), pour que le mangleCache soit rempli de façon
// déterministe quel que soit l'ordre réel d'achèvement des promesses.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

// 6 composants, chacun avec SA PROPRE prop `_mjs_*` (jamais la même que ses voisins) — plus
// de propriétés en jeu = plus de chances qu'un ordre d'attribution différent produise un
// résultat observable. `comp-f` @import le module civet ; `comp-a` porte l'animation.
function writeFixture(srcDir: string): void {
  // comp-b/c/d/e : forme nue, une prop `_mjs_*` DIFFÉRENTE chacun.
  for (const n of ['b', 'c', 'd', 'e']) {
    const prop = `_mjs_probe_${n}`
    const lines = [
      '<script>',
      `$obj = { ${prop}: '${n}' }`,
      '</script>',
      `{if $obj.${prop}}`,
      `  <p class="${n}">{$obj.${prop}}</p>`,
      '{end}',
    ]
    writeFileSync(join(srcDir, `comp-${n}.mjs`), lines.join('\n'))
  }
  // une vraie animation (fade, existe dans runtime/animations/) sur un composant dédié.
  writeFileSync(join(srcDir, 'comp-a.mjs'), [
    '<script>',
    '$show = true',
    '$obj = { _mjs_probe_a: \'a\' }',
    '</script>',
    '{if $show}<p class="a" @transition.fade>{$obj._mjs_probe_a}</p>{end}',
  ].join('\n'))
  // module .civet @import-é par un composant — passe aussi par la minification différée.
  writeFileSync(join(srcDir, 'helper.civet'), 'export triple := (x) -> x * 3\n')
  writeFileSync(join(srcDir, 'comp-f.mjs'), [
    '@import triple \'helper.civet\'',
    '<script>',
    '$obj = { _mjs_probe_f: triple(2) }',
    '</script>',
    '{if $obj._mjs_probe_f}<p class="f">{$obj._mjs_probe_f}</p>{end}',
  ].join('\n'))
}

// hash de CHAQUE fichier .js/.css de outDir, par BASENAME SANS le hash md5 du nom (le stem
// seul) — pour comparer « le composant comp-a » d'un build à l'autre même si son propre hash
// de nom diffère (ce qu'on est justement en train de mesurer).
function sortedContents(outDir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(outDir)) {
    if (!/\.(js|css)$/.test(f)) continue
    const stem = f.replace(/-[a-f0-9]{8}(\.js|\.css)$/, '$1')
    out[stem] = readFileSync(join(outDir, f), 'utf-8')
  }
  return out
}

describe('bundler — build PRODUCTION reproductible (mangleCache, minification séquentielle triée)', function () {
  this.timeout(120000)
  const tmpRoots: string[] = []

  after(async () => {
    for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
    await terminateSharedWorkerPool()
  })

  async function buildFresh(prefix: string): Promise<{ outDir: string; stats: any }> {
    const root = mjsTmp(prefix)
    tmpRoots.push(root)
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFixture(srcDir)
    // AUCUN .mangle-cache.json préexistant : dossier de sortie neuf à chaque appel — un
    // carnet déjà là masquerait le bug (le mangle redeviendrait déterministe dès le 2e build,
    // par PERSISTANCE, pas par calcul stable).
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), forceMinify: true })
    const stats = await bundler.compile()
    await bundler.close()
    return { outDir, stats }
  }

  it('3 builds --prod frais du MÊME projet (aucun carnet préexistant) produisent des fichiers IDENTIQUES octet à octet (cœur ET composants ET module ET animations)', async function () {
    const results: Record<string, string>[] = []
    for (let i = 0; i < 3; i++) {
      const { outDir, stats } = await buildFresh(`prod-determ-${i}`)
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      results.push(sortedContents(outDir))
    }

    const stemsRef = Object.keys(results[0]).sort()
    assert.ok(stemsRef.length >= 4, `au moins 4 fichiers .js/.css attendus, reçu : ${stemsRef.join(', ')}`)

    for (let i = 1; i < results.length; i++) {
      const stemsHere = Object.keys(results[i]).sort()
      assert.deepEqual(stemsHere, stemsRef, `build #${i} : même JEU de stems attendu (mêmes fichiers logiques émis)`)
      for (const stem of stemsRef) {
        assert.equal(
          results[i][stem], results[0][stem],
          `build #${i} : contenu de '${stem}' diffère du build #0 — le mangleCache esbuild a mangle les propriétés _mjs_* dans un ORDRE différent (minification encore parallèle/non triée)`,
        )
      }
    }
  })
})
