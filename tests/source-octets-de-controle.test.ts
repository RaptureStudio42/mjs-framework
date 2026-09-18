// AUCUN OCTET DE CONTRÔLE BRUT DANS UNE SOURCE — le garde-fou d'une morsure vécue.
//
// L'HISTOIRE. `src/transpiler/index.ts` (3 191 lignes, le plus gros fichier du transpileur) portait
// un octet NUL, posé exprès comme séparateur dans une clé interne (`${insertAt}\0${name}`). Les
// outils de recherche en texte ont une règle : un fichier qui porte un octet de contrôle n'est pas
// du texte, on ne le lit pas. Le fichier était donc SAUTÉ à chaque `grep -r` — et « rien trouvé »
// rend exactement la même réponse que « je n'ai pas regardé » : le vide. Conclusion : « ces quatre
// messages d'erreur sont morts, définis mais jamais appelés ». Ils étaient
// parfaitement câblés, dans le fichier que la recherche ne lisait pas.
//
// Une garde qui échoue rend « rien », et
// « rien » ressemble à « tout va bien ». Le remède n'est pas de mieux chercher, c'est de ne plus
// jamais poser l'octet : `'\0'` en échappement dit la MÊME chaîne à l'exécution et laisse le
// fichier lisible. Idem pour un test XSS qui doit citer un NUL (`safe-attr-allowlist-schemes`).
//
// PORTÉE. Tout le dépôt sauf le généré et le versionné-binaire (cf. IGNORE/BINAIRES). On accepte
// TAB, LF et CR, rien d'autre en dessous de 0x20, plus DEL (0x7F). Liste NOIRE d'extensions et pas
// blanche : un `.civet` ou un `.sass` ajouté demain entre dans le balayage tout seul.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RACINE    = join(__dirname, '..')

// généré, vendu, ou cache : rien de tout ça n'est une source qu'on relit
const IGNORE   = new Set([ 'node_modules', 'dist', '.git', '.sass-cache', 'coverage', 'public', 'app' ])
// binaires LÉGITIMES — ils portent des octets de contrôle par nature, et personne ne les grep
const BINAIRES = new Set([ '.wasm', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.pdf', '.zip', '.gz', '.tgz', '.br', '.node' ])

interface Trouvaille { fichier: string, octet: number, ligne: number, colonne: number }

/** Le premier octet de contrôle du fichier, avec sa ligne — `null` quand il est propre. */
function premierOctetDeControle(chemin: string): Omit<Trouvaille, 'fichier'> | null {
  const buf = readFileSync(chemin)
  let ligne = 1, colonne = 1
  for (let i = 0; i < buf.length; i++) {
    const o = buf[i]
    if (o === 10) { ligne++; colonne = 1; continue }
    if (o === 9 || o === 13) { colonne++; continue }
    if (o < 32 || o === 127) return { octet: o, ligne, colonne }
    colonne++
  }
  return null
}

function balayer(racine: string): Trouvaille[] {
  const trouvailles: Trouvaille[] = []
  const descendre = (dossier: string): void => {
    for (const e of readdirSync(dossier, { withFileTypes: true })) {
      if (IGNORE.has(e.name)) continue
      const chemin = join(dossier, e.name)
      if (e.isDirectory()) { descendre(chemin); continue }
      if (!e.isFile() || BINAIRES.has(extname(e.name).toLowerCase())) continue
      const trouve = premierOctetDeControle(chemin)
      if (trouve) trouvailles.push({ fichier: relative(racine, chemin), ...trouve })
    }
  }
  descendre(racine)
  return trouvailles
}

const hexa = (o: number) => '0x'+ o.toString(16).padStart(2, '0')

describe('sources — aucun octet de contrôle brut', () => {

  // GARDE MUETTE : un prédicat qui ne regarde rien rend « aucun résultat », c'est-à-dire
  // exactement ce que rend un dépôt propre. On le prouve donc sur DEUX témoins — un piégé, un
  // sain — AVANT de tirer la moindre conclusion du balayage réel. Sans ce préalable, le test
  // ci-dessous passerait au vert même s'il ne lisait pas un seul fichier.
  it('le prédicat REGARDE — prouvé sur un témoin piégé et un témoin sain', () => {
    const bac = mjsTmp('octets-controle')
    writeFileSync(join(bac, 'temoin-nul.ts'),    Buffer.from('const a = 1\nconst b = "x\0y"\n', 'binary'))
    writeFileSync(join(bac, 'temoin-esc.ts'),    'const a = 1\nconst b = "x\\0y"\n')          //le MÊME texte, échappé
    writeFileSync(join(bac, 'temoin-sain.ts'),   'const a = 1\nconst b = "xy"\n')
    writeFileSync(join(bac, 'temoin-tab.ts'),    'const a = 1\n\tconst b = 2\r\n')            //TAB/CR/LF : du texte, pas du contrôle
    writeFileSync(join(bac, 'temoin-accents.ts'), 'const é = "à—ç ✓ 💎"\n')                   //UTF-8 multi-octets : jamais < 0x20

    const vus = balayer(bac)
    assert.deepEqual(vus.map(v => v.fichier), [ 'temoin-nul.ts' ], 'le prédicat doit voir le piégé, et LUI SEUL')
    assert.equal(vus[0].octet, 0)
    assert.equal(vus[0].ligne, 2, 'la ligne signalée doit être celle de l\'octet, pas la première du fichier')
  })

  it('aucun fichier source du dépôt ne porte un octet de contrôle brut', () => {
    const fautifs = balayer(RACINE)
    const details = fautifs.map(f => `  ${f.fichier}:${f.ligne}:${f.colonne} — octet ${hexa(f.octet)}`).join('\n')
    assert.equal(fautifs.length, 0, `octet de contrôle brut dans une source : le fichier devient INVISIBLE à toute recherche en texte (grep le classe binaire et le saute).\n${details}\nRemède : écrire l'octet en ÉCHAPPEMENT ('\\0', '\\x1b') — même chaîne à l'exécution, fichier lisible.`)
  })
})
