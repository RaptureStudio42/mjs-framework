// bundler/image — les images : dimensions natives, et variantes de largeur.
//
// DEUX NIVEAUX, délibérément séparés :
//
//   1. LES DIMENSIONS, sans aucune dépendance. On lit l'en-tête du fichier et on en
//      sort la largeur et la hauteur natives. C'est ce qui permet d'écrire `width` et
//      `height` sur la balise, et donc de supprimer le SAUT DE MISE EN PAGE au
//      chargement — le gain le plus visible, et il marche pour tout le monde.
//   2. LES VARIANTES (plusieurs largeurs, formats modernes), qui exigent un vrai
//      encodeur d'images. `sharp` est une dépendance OPTIONNELLE : présent, on génère ;
//      absent, on prévient UNE fois et l'image d'origine passe telle quelle. Même
//      patron que le moteur de rendu `browser` avec Playwright — un poste qui ne peut
//      pas compiler un binaire natif n'a jamais un build cassé pour autant.

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// Spécifieur en VARIABLE, jamais en littéral : `sharp` n'est pas une dépendance du
// framework, un `import('sharp')` littéral ferait échouer NOTRE typecheck alors que le
// module est parfaitement résolvable chez qui l'installe.
const SHARP = 'sharp'

export interface ImageSize {
  width: number
  height: number
}

/** Un `ispe` d'ISOBMFF (avif/heic) : size(4) 'ispe'(4) version+flags(4) width(4) height(4). */
function ispeSize(buf: Buffer): ImageSize | null {
  const i = buf.indexOf('ispe', 0, 'ascii')
  if (i < 0 || i + 16 > buf.length) return null
  return { width: buf.readUInt32BE(i + 8), height: buf.readUInt32BE(i + 12) }
}

/** La balise OUVRANTE `<svg …>` (de `<svg` à son premier `>` HORS guillemets), ou `null` si elle
 *  n'est jamais refermée dans la fenêtre lue — jamais ce qui suit (les enfants). */
function svgOpeningTag(str: string): string | null {
  const debut = str.search(/<svg[\s>]/i)
  if (debut < 0) return null
  let i = debut + 4
  let guillemet: string | null = null
  while (i < str.length) {
    const c = str[i]
    if (guillemet) { if (c === guillemet) guillemet = null }
    else if (c === '"' || c === '\'') guillemet = c
    else if (c === '>') return str.slice(debut, i + 1)
    i++
  }
  return null
}

/** Dimensions natives d'une image, lues dans son en-tête. `null` si le format est inconnu. */
export function readImageSize(buf: Buffer): ImageSize | null {
  if (buf.length < 16) return null

  // PNG — signature 8 octets, puis IHDR : largeur et hauteur en tête
  // un PNG TRONQUÉ (assez long pour passer la garde `< 16` mais pas les 24
  // octets de l'IHDR) faisait lever `readUInt32BE(20)` (RangeError) : un fichier corrompu cassait
  // le build au lieu de rendre `null`. On vérifie aussi que l'IHDR est bien LÀ (offset 12-15).
  if (buf.readUInt32BE(0) === 0x89504e47) {
    if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  // GIF — 'GIF8', puis largeur/hauteur en petit-boutiste
  if (buf.toString('ascii', 0, 4) === 'GIF8') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }

  // WebP — conteneur RIFF, trois variantes de bloc
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const bloc = buf.toString('ascii', 12, 16)
    if (bloc === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    if (bloc === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (bloc === 'VP8X' && buf.length >= 30) return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
    return null
  }

  // AVIF / HEIC — ISOBMFF : la taille vit dans un bloc `ispe`
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return ispeSize(buf)

  // SVG — pas de pixels natifs : on prend `width`/`height`, sinon le `viewBox`
  const debut = buf.toString('utf-8', 0, Math.min(buf.length, 2048))
  if (/<svg[\s>]/i.test(debut)) {
    // `width`/`height`/`viewBox` étaient cherchés dans TOUT le préambule : un
    // enfant (`<rect width="10" height="10"/>`) pouvait fournir la taille à la place du `<svg>`
    // lui-même. On isole d'abord la balise OUVRANTE (jusqu'à son `>`, hors guillemets) et on ne
    // cherche plus que DEDANS.
    const balise = svgOpeningTag(debut) ?? ''
    const w = balise.match(/\bwidth\s*=\s*["']([\d.]+)/i)
    const h = balise.match(/\bheight\s*=\s*["']([\d.]+)/i)
    if (w && h) return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) }
    const vb = balise.match(/\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i)
    if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) }
    return null
  }

  // JPEG — on marche de marqueur en marqueur jusqu'à un « début de trame »
  // le bourrage `0xFF 0xFF…` (un ou plusieurs `0xFF` avant le VRAI marqueur) et
  // les marqueurs SANS champ de longueur (`0xD0`-`0xD9` RSTn/SOI/EOI, `0x01` TEM) faisaient lire
  // une « longueur » fantaisiste au mauvais offset : le balayage désynchronisait et ratait la
  // trame. On saute le bourrage, on avance de 2 (le `0xFF` + le marqueur) sur un marqueur nu, on
  // s'arrête proprement à l'EOI, et chaque lecture est bornée (jamais de RangeError).
  if (buf.readUInt16BE(0) === 0xffd8) {
    let i = 2
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      while (buf[i] === 0xff) i++            // bourrage — le marqueur est le premier octet non-FF
      if (i >= buf.length) return null        // bourrage jusqu'à la fin, plus rien à lire
      const marqueur = buf[i]
      i++                                      // i pointe maintenant juste APRÈS l'octet de marqueur
      if (marqueur === 0xd9) return null      // EOI — fin de flux, aucune trame trouvée
      if (marqueur === 0x01 || (marqueur >= 0xd0 && marqueur <= 0xd8)) continue   // TEM/RSTn/SOI : pas de longueur
      if (i + 1 >= buf.length) return null    // pas la place de lire la longueur du segment
      // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 : les trames qui portent la taille
      if (marqueur >= 0xc0 && marqueur <= 0xcf && marqueur !== 0xc4 && marqueur !== 0xc8 && marqueur !== 0xcc) {
        if (i + 7 > buf.length) return null   // segment tronqué avant la hauteur/largeur
        return { width: buf.readUInt16BE(i + 5), height: buf.readUInt16BE(i + 3) }
      }
      const longueur = buf.readUInt16BE(i)
      if (longueur < 2) return null           // longueur invalide (elle s'inclut elle-même)
      i += longueur
    }
  }

  return null
}

/** Nom de fichier d'une variante : `hero-960-<empreinte>.webp`. */
export function variantName(baseName: string, largeur: number, format: string, empreinte: string): string {
  return `${baseName}-${largeur}-${empreinte}.${format}`
}

let sharpCache: Promise<any | null> | null = null

/**
 * Résout `sharp`, ou `null` s'il n'est pas installé. Trois essais, du plus proche du
 * PROJET au plus proche du framework : c'est l'auteur de l'application qui installe
 * cette dépendance optionnelle, elle vit donc d'abord dans SON `node_modules`.
 * Ne lève JAMAIS : une absence réelle se traduit par `null`.
 */
export async function resolveSharp(): Promise<any | null> {
  if (!sharpCache) {
    sharpCache = (async () => {
      try { return createRequire(join(process.cwd(), 'index.js'))(SHARP) } catch { /* pas dans le projet */ }
      try { return (await import(SHARP)).default } catch { /* pas résolvable depuis ici */ }
      try { return createRequire(import.meta.url)(SHARP) } catch { return null }
    })()
  }
  return sharpCache
}

export interface VariantRequest {
  bytes: Buffer
  baseName: string
  /** Largeurs voulues, déjà bornées à la largeur native (jamais d'agrandissement). */
  widths: number[]
  formats: string[]
  quality: number
}

export interface GeneratedVariant {
  filename: string
  bytes: Buffer
  width: number
  format: string
}

/**
 * Génère les variantes avec `sharp`, s'il est installé. Rend `null` quand il ne l'est
 * pas — c'est au caller de prévenir UNE fois et de laisser passer l'image d'origine :
 * un build ne casse jamais parce qu'un poste n'a pas pu compiler un binaire natif.
 */
export async function generateVariants(req: VariantRequest): Promise<GeneratedVariant[] | null> {
  const sharp = await resolveSharp()
  if (!sharp) return null
  const sorties: GeneratedVariant[] = []
  const vues = new Set<string>()
  for (const largeur of req.widths) {
    for (const format of req.formats) {
      const pipeline = sharp(req.bytes).resize({ width: largeur, withoutEnlargement: true })
      const sortie: any = await (format === 'avif' ? pipeline.avif({ quality: req.quality })
                               : format === 'webp' ? pipeline.webp({ quality: req.quality })
                               : format === 'png'  ? pipeline.png()
                               : pipeline.jpeg({ quality: req.quality })).toBuffer({ resolveWithObject: true })
      const bytes: Buffer = sortie.data
      // LARGEUR RÉELLE, jamais la largeur DEMANDÉE — `withoutEnlargement` PLAFONNE au
      // natif : une largeur demandée au-dessus rend un fichier plus petit que promis. On indexait
      // pourtant la demande, et le `srcset` annonçait des largeurs jamais produites — le
      // navigateur choisit alors sur une information fausse. Le cas arrive dès que
      // `readImageSize` ne reconnaît pas le format : faute de largeur native connue, le filtre de
      // l'appelant (`w <= taille.width`) laisse TOUT passer.
      const reelle    = typeof sortie?.info?.width === 'number' ? sortie.info.width : largeur
      const empreinte = createHash('md5').update(bytes).digest('hex').slice(0, 8)
      const filename  = variantName(req.baseName, reelle, format, empreinte)
      // deux largeurs demandées plafonnées à la MÊME largeur réelle rendent le même fichier :
      // une seule entrée de `srcset`, jamais un doublon qui annonce deux fois la même image
      if (vues.has(filename)) continue
      vues.add(filename)
      sorties.push({ filename, bytes, width: reelle, format })
    }
  }
  return sorties
}
