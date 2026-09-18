// Lint « trop de variables d'état » (lint.maxStateVars) —
// au-delà de N `$x` distinctes dans UN composant (défaut 40, 0 = désactivé),
// transpile() émet un AVERTISSEMENT console (jamais bloquant) qui oriente vers
// le découpage en sous-composants/écrans. Étalonnage réel : modules sains
// 5-20 vars, monolithe pathologique vu à 182. Configurable par le bloc
// `"lint": { "maxStateVars": N }` de mjs.config.json (validation stricte).

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { transpile } from '../src/transpiler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

// composant généré : n variables d'état distinctes `$v1 = 1` … `$vN = N`
function sourceWithVars(n: number): string {
  const decls = Array.from({ length: n }, (_, i) => `$v${i + 1} = ${i + 1}`).join('\n')
  return `<script>\n${decls}\n</script>\n<p>{$v1}</p>`
}

// espionne console.warn le temps d'un transpile (motif analyzer.test.ts)
async function warnsTooMany(src: string, opts: Record<string, unknown> = {}): Promise<string | null> {
  const orig = console.warn
  let caught: string | null = null
  console.warn = (...a: unknown[]) => { const s = String(a[0]); if (s.includes('variables d\'état')) caught = s }
  try { await transpile(src, { moduleName: 'stress-vars', ...opts }) } finally { console.warn = orig }
  return caught
}

describe('lint maxStateVars — avertissement « trop de variables d\'état »', function () {
  this.timeout(30000)

  it('41 vars, seuil défaut 40 → warn orientant (nom, compte, seuil, réglage)', async () => {
    const msg = await warnsTooMany(sourceWithVars(41))
    assert.ok(msg, 'un avertissement devait être émis')
    assert.match(msg as unknown as string, /41 variables d'état/)
    assert.match(msg as unknown as string, /seuil 40/)
    assert.match(msg as unknown as string, /lint\.maxStateVars/)
    assert.match(msg as unknown as string, /stress-vars/)
  })

  it('40 vars pile (= seuil) → silence', async () => {
    assert.equal(await warnsTooMany(sourceWithVars(40)), null)
  })

  it('seuil 10 passé en option → warn à 11, silence à 10', async () => {
    assert.ok(await warnsTooMany(sourceWithVars(11), { maxStateVars: 10 }))
    assert.equal(await warnsTooMany(sourceWithVars(10), { maxStateVars: 10 }), null)
  })

  it('0 = désactivé → jamais de warn, même à 100 vars', async () => {
    assert.equal(await warnsTooMany(sourceWithVars(100), { maxStateVars: 0 }), null)
  })
})

describe('mjs.config.json — validation stricte du bloc lint', () => {
  it('accepte { lint: { maxStateVars: 40 } } et resolveBundlerOpts le transmet', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ lint: { maxStateVars: 40 } }))
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.lint!.maxStateVars, 40)
    const opts = resolveBundlerOpts(found!.config, root)
    assert.equal(opts.maxStateVars, 40)
  })

  it('throw sur clé inconnue dans lint, avec la liste des clés admises', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ lint: { maxStateVarz: 40 } }))
    assert.throws(() => findConfig(root), /lint\.maxStateVarz : clé inconnue[\s\S]*Clés valides : maxStateVars/)
  })

  it('throw sur lint non-objet', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ lint: 40 }))
    assert.throws(() => findConfig(root), /'lint' doit être un objet/)
  })

  it('throw sur maxStateVars non entier, négatif ou non numérique', () => {
    for (const bad of [40.5, -1, '40']) {
      const root = mjsTmp('cfg')
      writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ lint: { maxStateVars: bad } }))
      assert.throws(() => findConfig(root), /lint\.maxStateVars doit être un entier/)
    }
  })

  it('maxStateVars: 0 (désactivation) reste accepté par la validation', () => {
    const root = mjsTmp('cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ lint: { maxStateVars: 0 } }))
    assert.doesNotThrow(() => findConfig(root))
  })
})
