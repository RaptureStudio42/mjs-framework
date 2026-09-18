// Mémoïsation du hachage des dépendances (Bundler.depDigest) — le gain de lectures ne doit
// JAMAIS coûter une décision de fraîcheur. Cas piège reproduit ici : un partial réécrit avec
// la MÊME taille et la MÊME date de modification à la nanoseconde près (rsync --times,
// restauration d'archive, date reposée à la main). L'ancien code relisait le fichier à chaque
// vérification, donc voyait le changement ; la mémoïsation doit rester aussi sûre.

import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('Bundler — fraîcheur des dépendances mémoïsées', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it('un partial réécrit à taille ET date identiques est quand même vu comme changé', async function () {
    this.timeout(20000)
    const root   = mjsTmp('depdigest')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    const partial = join(srcDir, '_bloc.mjs')
    writeFileSync(partial, '<p>AAAA</p>\n')
    writeFileSync(join(srcDir, 'page.mjs'), '<script lang="coffee">\n  $n = 1\n</script>\n\n<div>{$n}<@include bloc></div>\n')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    await bundler.compile()
    const before = readdirSync(outDir).filter(f => /^page-.*\.js$/.test(f))
    assert.equal(before.length, 1, 'un seul chunk page au premier build')

    // réécriture de MÊME longueur, puis date remise à l'identique — `touch -d @s.ns` et pas
    // `utimesSync`, dont l'argument flottant perd la nanoseconde (mesuré : 30 ns d'écart, le
    // piège ne se refermait pas et le test devenait un faux témoin)
    const st = statSync(partial, { bigint: true })
    writeFileSync(partial, '<p>BBBB</p>\n')
    const stamp = `@${st.mtimeNs / 1000000000n}.${String(st.mtimeNs % 1000000000n).padStart(9, '0')}`
    execFileSync('touch', ['-d', stamp, partial])
    const after = statSync(partial, { bigint: true })
    assert.equal(after.size, st.size, 'la taille doit être identique pour que le piège tienne')
    assert.equal(after.mtimeNs, st.mtimeNs, 'la date doit être identique à la nanoseconde — sinon le test ne prouve rien')

    await bundler.compile()
    const chunks = readdirSync(outDir).filter(f => /^page-.*\.js$/.test(f))
    assert.equal(chunks.length, 1, 'l\'ancienne version doit avoir été nettoyée')
    assert.notEqual(chunks[0], before[0], 'le hash doit changer — sinon un contenu périmé est resservi')
  })
})
