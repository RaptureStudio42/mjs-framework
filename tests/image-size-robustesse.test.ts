// `readImageSize` : robustesse sur fichiers corrompus ou atypiques. Trois
// tampons FORGÉS, chacun prouvé rouge avant correctif (cf. CHANGELOG) : (a) un PNG tronqué faisait
// lever une RangeError (fichier corrompu = build cassé, au lieu d'un `null`) ; (b) un JPEG avec
// bourrage `0xFF 0xFF…` et un marqueur SANS longueur (RSTn) désynchronisait le balayage et ratait
// la trame SOF0 ; (c) un `<svg>` sans `width`/`height` propres se voyait attribuer ceux d'un
// enfant (`<rect>`) au lieu de son `viewBox`.

import assert from 'node:assert/strict'
import { readImageSize } from '../src/bundler/image.js'

describe('bundler/image — readImageSize : robustesse', () => {
  describe('(a) PNG tronqué', () => {
    it('20 octets (signature + IHDR + largeur, PAS de hauteur) : rend null, ne lève jamais', () => {
      const buf = Buffer.alloc(20)
      buf.writeUInt32BE(0x89504e47, 0)
      buf.write('IHDR', 12)
      buf.writeUInt32BE(1920, 16)
      assert.equal(readImageSize(buf), null)
    })

    it('24 octets, mais IHDR absent de l\'offset 12-15 : rend null (signature seule ne suffit pas)', () => {
      const buf = Buffer.alloc(24)
      buf.writeUInt32BE(0x89504e47, 0)
      buf.write('XXXX', 12)
      buf.writeUInt32BE(1920, 16)
      buf.writeUInt32BE(1080, 20)
      assert.equal(readImageSize(buf), null)
    })

    it('PNG complet (signature + IHDR + largeur/hauteur) reste lu normalement', () => {
      const buf = Buffer.alloc(24)
      buf.writeUInt32BE(0x89504e47, 0)
      buf.write('IHDR', 12)
      buf.writeUInt32BE(1920, 16)
      buf.writeUInt32BE(1080, 20)
      assert.deepEqual(readImageSize(buf), { width: 1920, height: 1080 })
    })
  })

  describe('(b) JPEG — bourrage et marqueurs sans longueur', () => {
    // SOI, bourrage `FF FF`, RST0 (sans longueur), puis SOF0 200×100
    function jpegAvecBourrageEtRst(): Buffer {
      return Buffer.from([
        0xff, 0xd8,             // SOI
        0xff, 0xff,             // bourrage : FF de trop avant le marqueur suivant
        0xff, 0xd0,             // RST0 — marqueur SANS longueur
        0xff, 0xc0,             // SOF0
        0x00, 0x0b,             // longueur du segment (11, s'inclut elle-même)
        0x08,                   // précision
        0x00, 0x64,             // hauteur = 100
        0x00, 0xc8,             // largeur = 200
        0x01,                   // 1 composante
        0x01, 0x11, 0x00,       // id, échantillonnage, table de quantification
      ])
    }

    it('bourrage + RST0 avant le SOF0 : la trame est quand même trouvée', () => {
      assert.deepEqual(readImageSize(jpegAvecBourrageEtRst()), { width: 200, height: 100 })
    })

    it('EOI rencontré AVANT un SOF0 qui suit (fabriqué exprès derrière) : rend null, ne va jamais le lire', () => {
      // le SOF0 après l'EOI est un LEURRE : une implémentation qui ne s'arrête pas proprement à
      // l'EOI continuerait le balayage et le trouverait à tort (200×100 au lieu de null)
      const buf = Buffer.from([
        0xff, 0xd8,             // SOI
        0xff, 0xd9,             // EOI — la lecture doit s'arrêter ICI
        0xff, 0xc0,             // SOF0 (leurre, jamais atteint si l'EOI est respecté)
        0x00, 0x0b,
        0x08,
        0x00, 0x64,             // hauteur = 100
        0x00, 0xc8,             // largeur = 200
        0x01,
        0x01, 0x11, 0x00,
      ])
      assert.equal(readImageSize(buf), null)
    })

    it('longueur de segment annoncée très supérieure au tampon réel : rend null, ne lève jamais', () => {
      const buf = Buffer.from([
        0xff, 0xd8,                                                  // SOI
        0xff, 0xe0,                                                  // APP0
        0x00, 0xf0,                                                  // longueur annoncée = 240, jamais atteignable
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  // reste du tampon (16 octets au total)
      ])
      assert.equal(readImageSize(buf), null)
    })

    it('SOF0 tronqué PILE à la frontière hauteur/largeur (segment précédent consommé, plus rien après la longueur) : rend null', () => {
      const buf = Buffer.from([
        0xff, 0xd8,                                           // SOI
        0xff, 0xe0, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  // APP0, longueur 9 (2+7), consommé en entier
        0xff, 0xc0,                                           // SOF0
        0x00, 0x0b,                                           // longueur du segment (11) — tampon COUPÉ juste après
      ])
      assert.equal(readImageSize(buf), null)
    })

    it('JPEG SOF0 « propre » (sans bourrage ni RST) reste lu normalement', () => {
      const buf = Buffer.from([
        0xff, 0xd8,
        0xff, 0xc0,
        0x00, 0x0b,
        0x08,
        0x00, 0x32,             // hauteur = 50
        0x00, 0x28,             // largeur = 40
        0x01,
        0x01, 0x11, 0x00,
        0x00,                    // bourrage final : seulement pour dépasser les 16 octets requis
      ])
      assert.deepEqual(readImageSize(buf), { width: 40, height: 50 })
    })
  })

  describe('(c) SVG — width/height cherchés dans la balise <svg> SEULEMENT', () => {
    it('un enfant <rect width/height> ne masque plus le viewBox du <svg>', () => {
      const svg = Buffer.from('<svg viewBox="0 0 100 50"><rect width="10" height="10"/></svg>')
      assert.deepEqual(readImageSize(svg), { width: 100, height: 50 })
    })

    it('width/height PORTÉS PAR <svg> restent prioritaires sur son propre viewBox', () => {
      const svg = Buffer.from('<svg width="120" height="60" viewBox="0 0 24 32"></svg>')
      assert.deepEqual(readImageSize(svg), { width: 120, height: 60 })
    })

    it('viewBox seul (aucun enfant) reste lu comme avant', () => {
      const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 32"><path d="M0 0"/></svg>')
      assert.deepEqual(readImageSize(svg), { width: 24, height: 32 })
    })
  })
})
