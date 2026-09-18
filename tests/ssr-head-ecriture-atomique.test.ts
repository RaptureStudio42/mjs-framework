// `writeHashedAsset` (server/ssr-head.ts) écrivait DIRECTEMENT sur le chemin final, gardée par un
// simple `if (!existsSync(target))`. N'importe quelle interruption en cours d'écriture (disque
// plein, processus tué) laissait un CSS TRONQUÉ que le passage suivant trouvait « déjà là » et ne
// réparait JAMAIS — servi mutilé pour toujours. Et ce chemin est atteint sur une REQUÊTE SSR vive
// (mode `csp: true`), pas seulement au build. Le bundler a `writeFileAtomic` exactement pour ça.
//
// Remède : écriture à côté puis `rename` (atomique sur le même volume), et la TAILLE comme sonde
// de complétude — le nom porte le hash du contenu attendu, une taille qui ne colle pas dénonce un
// reliquat tronqué.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { mjsTmp } from './helpers/tmp.js'
import { writeHashedAsset } from '../src/server/ssr-head.js'

describe('writeHashedAsset — écriture atomique, jamais de fichier tronqué durable', () => {
  const CSS = '.a{color:red}\n'.repeat(400)
  const nomAttendu = (base: string, ext: string, contenu: string) =>
    `${base}-${createHash('md5').update(contenu).digest('hex').slice(0, 8)}${ext}`

  function dossier(prefix: string): string {
    const d = join(mjsTmp(prefix), 'out')
    mkdirSync(d, { recursive: true })
    return d
  }

  it('écrit le fichier COMPLET et ne laisse aucun temporaire derrière', () => {
    const out = dossier('atomique-neuf')
    const url = writeHashedAsset(out, '/x', 'mjs_ssr', '.css', CSS)
    const nom = nomAttendu('mjs_ssr', '.css', CSS)
    assert.equal(url, `/x/${nom}`)
    assert.equal(readFileSync(join(out, nom), 'utf-8'), CSS)
    assert.deepEqual(readdirSync(out).filter(f => f.includes('.tmp-')), [], 'aucun temporaire ne doit rester')
  })

  it('un reliquat TRONQUÉ au chemin final est réparé, plus servi indéfiniment', () => {
    const out = dossier('atomique-tronque')
    const nom = nomAttendu('mjs_ssr', '.css', CSS)
    // le sinistre : une écriture interrompue a laissé la moitié du CSS sous le nom FINAL
    writeFileSync(join(out, nom), CSS.slice(0, 120))
    writeHashedAsset(out, '/x', 'mjs_ssr', '.css', CSS)
    assert.equal(readFileSync(join(out, nom), 'utf-8'), CSS, 'AVANT : le fichier tronqué restait tel quel, pour toujours')
  })

  it('un fichier déjà COMPLET n\'est pas réécrit (même mtime)', async () => {
    const out = dossier('atomique-idempotent')
    const nom = nomAttendu('mjs_ssr', '.css', CSS)
    writeHashedAsset(out, '/x', 'mjs_ssr', '.css', CSS)
    const avant = statSync(join(out, nom)).mtimeMs
    await new Promise(r => setTimeout(r, 20))
    writeHashedAsset(out, '/x', 'mjs_ssr', '.css', CSS)
    assert.equal(statSync(join(out, nom)).mtimeMs, avant, 'un contenu déjà en place ne doit pas être ré-écrit')
  })

  it('contenu non-ASCII : la sonde de taille compte les OCTETS, pas les caractères', () => {
    const out = dossier('atomique-utf8')
    const css = '.a::after{content:"éàü — ✓"}\n'
    const nom = nomAttendu('mjs_ssr', '.css', css)
    writeHashedAsset(out, '/x', 'mjs_ssr', '.css', css)
    const taille = statSync(join(out, nom)).size
    assert.equal(taille, Buffer.byteLength(css, 'utf-8'))
    // 2e appel : doit être reconnu COMPLET (sinon la sonde ré-écrirait à chaque requête SSR)
    const avant = statSync(join(out, nom)).mtimeMs
    writeHashedAsset(out, '/x', 'mjs_ssr', '.css', css)
    assert.equal(statSync(join(out, nom)).mtimeMs, avant)
  })
})
