// Transpilation DANS LE PROCESSUS PRINCIPAL sous un seuil de fichiers.
//
// Démarrer un pool de threads coûte une demi-seconde par thread (rechargement du
// paquet worker, sass, civet) : sur un projet de quelques composants, le pool
// coûte plus cher que le travail qu'il abat. Sous le seuil, le bundler appelle
// donc `transpileFromMsg` directement — AUCUN thread n'est créé — et la sortie
// doit rester identique À L'OCTET à celle du chemin par threads.
//
// Le seuil est forçable par `inlineTranspileLimit` (option interne, réservée aux
// tests et aux mesures) : 0 = toujours le pool, très grand = toujours en direct.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool, isSharedWorkerPoolAlive } from '../src/bundler/index.js'

function comp(nom: string, couleur: string): string {
  return [
    '<script lang="coffee">',
    `$titre = "${nom}"`,
    '</script>',
    '<p class="t">{$titre}</p>',
    '<style>',
    '.t',
    `  color: ${couleur}`,
    '</style>',
  ].join('\n')
}

/** Projet jetable de `nb` composants nommés comp1…compN. */
function makeProject(prefix: string, nb: number) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  for (let i = 1; i <= nb; i++) writeFileSync(join(srcDir, `comp${i}.mjs`), comp(`comp${i}`, 'red'))
  return { root, srcDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

function makeBundler(p: ReturnType<typeof makeProject>, extra: Record<string, unknown> = {}): Bundler {
  return new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, ...extra })
}

/** Empreinte du dossier de sortie : nom de fichier → contenu, hors fichiers hashés du cœur. */
function snapshotOut(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(dir).sort()) {
    // le hash du nom porte le contenu ; on garde le contenu sous le nom LOGIQUE
    const logique = f.replace(/-[0-9a-f]{8,}(\.\w+)$/, '$1')
    out[logique] = readFileSync(join(dir, f), 'utf-8')
  }
  return out
}

describe('bundler — transpilation en direct sous le seuil de fichiers', function () {
  this.timeout(120000)

  beforeEach(async () => { await terminateSharedWorkerPool() })
  after(async () => { await terminateSharedWorkerPool() })

  it('petit projet (3 composants) : AUCUN thread de travail créé', async () => {
    const p = makeProject('inline-petit', 3)
    const stats = await makeBundler(p).compile()
    assert.equal(stats.errors.length, 0)
    assert.equal(isSharedWorkerPoolAlive(), false, 'un projet sous le seuil ne doit créer aucun thread')
  })

  it('projet au-dessus du seuil : le pool de threads est bien créé', async () => {
    const p = makeProject('inline-gros', 3)
    // seuil forcé à 0 = personne n'est « petit » → chemin par threads, comme un gros projet
    const stats = await makeBundler(p, { inlineTranspileLimit: 0 }).compile()
    assert.equal(stats.errors.length, 0)
    assert.equal(isSharedWorkerPoolAlive(), true, 'au-dessus du seuil, le pool doit être créé')
  })

  it('sortie IDENTIQUE À L\'OCTET entre le direct et les threads', async () => {
    const direct = makeProject('inline-direct', 3)
    await makeBundler(direct).compile()
    const viaPool = makeProject('inline-pool', 3)
    await makeBundler(viaPool, { inlineTranspileLimit: 0 }).compile()
    assert.deepEqual(snapshotOut(direct.outDir), snapshotOut(viaPool.outDir))
  })

  it('un composant en échec en direct : erreur NOMMÉE, les autres composants passent', async () => {
    const p = makeProject('inline-echec', 3)
    // `<@include>` d'un partial inexistant = macroError → erreur de fichier (jamais un build vert)
    writeFileSync(join(p.srcDir, 'comp2.mjs'), '<@include jamais-ecrit>\n<p>x</p>')
    const stats = await makeBundler(p).compile()
    assert.equal(stats.errors.length, 1, `une seule erreur attendue (reçu : ${stats.errors.map(e => e.message).join(' | ')})`)
    assert.ok(stats.errors[0].message.includes('comp2.mjs'), `l\'erreur doit nommer le fichier fautif (reçu : ${stats.errors[0].message})`)
    const noms = readdirSync(p.outDir).join(' ')
    assert.ok(noms.includes('comp1'), 'comp1 doit être écrit malgré l\'échec de comp2')
    assert.ok(noms.includes('comp3'), 'comp3 doit être écrit malgré l\'échec de comp2')
  })

  it('payload « css-only » du watch identique en direct et par threads (empreinte restHash)', async () => {
    const lots: Array<Record<string, string>> = []
    for (const limite of [999, 0]) {
      const p = makeProject(`inline-cssonly-${limite}`, 1)
      const b = makeBundler(p, { inlineTranspileLimit: limite })
      ;(b as any).cssOnlyTracking = true
      await b.compile()
      writeFileSync(join(p.srcDir, 'comp1.mjs'), comp('comp1', 'blue'))
      const stats = await b.compile()
      assert.ok(stats.cssOnly, `un changement 100 % CSS doit rester css-only (limite ${limite})`)
      lots.push(stats.cssOnly!.components)
    }
    assert.deepEqual(lots[0], lots[1])
  })
})
