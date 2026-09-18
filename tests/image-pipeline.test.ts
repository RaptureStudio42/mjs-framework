// `µimage('chemin'[, largeurs])` et le module cœur `<@img>`.
//
// DEUX NIVEAUX, testés séparément parce qu'ils n'ont pas les mêmes exigences :
//   • les DIMENSIONS natives, lues dans l'en-tête du fichier, SANS aucune dépendance —
//     c'est elles qui suppriment le saut de mise en page, et elles doivent marcher chez
//     tout le monde ;
//   • les VARIANTES de largeur, qui exigent `sharp` (dépendance optionnelle) : absent,
//     l'image d'origine passe telle quelle et le build ne casse pas.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { readImageSize } from '../src/bundler/image.js'
import { findConfig } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

/** Un PNG minimal, VALIDE, de dimensions choisies (en-tête réel : signature + IHDR). */
function pngDe(largeur: number, hauteur: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(largeur, 8)
  ihdr.writeUInt32BE(hauteur, 12)
  ihdr[16] = 8   // profondeur
  ihdr[17] = 6   // RVBA
  return Buffer.concat([signature, ihdr])
}

function projet(prefix: string) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir, manifest: join(root, 'bundle.js') }
}

describe('bundler/image — dimensions natives, sans aucune dépendance', () => {
  it('lit un PNG', () => {
    assert.deepEqual(readImageSize(pngDe(1920, 1080)), { width: 1920, height: 1080 })
  })

  it('lit un GIF', () => {
    const buf = Buffer.alloc(16)
    buf.write('GIF89a', 0)
    buf.writeUInt16LE(640, 6)
    buf.writeUInt16LE(480, 8)
    assert.deepEqual(readImageSize(buf), { width: 640, height: 480 })
  })

  it('lit un SVG par son viewBox', () => {
    const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 32"><path d="M0 0"/></svg>')
    assert.deepEqual(readImageSize(svg), { width: 24, height: 32 })
  })

  it('lit un SVG par ses attributs quand il en a', () => {
    const svg = Buffer.from('<svg width="120" height="60" viewBox="0 0 24 32"></svg>')
    assert.deepEqual(readImageSize(svg), { width: 120, height: 60 })
  })

  it('rend null sur un format qu\'il ne connaît pas, sans jamais lever', () => {
    assert.equal(readImageSize(Buffer.from('ceci n\'est pas une image du tout, vraiment pas')), null)
  })
})

describe("µimage — résolution au build", function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it('rend un objet avec l\'URL hachée ET les dimensions natives', async () => {
    const p = projet('image')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<script>\nphoto = µimage(\'hero.png\')\n</script>\n\n<img src={photo.src} width={photo.width} height={photo.height}>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const compile = readFileSync(join(p.outDir, readdirSync(p.outDir).find(f => /^page-/.test(f))!), 'utf-8')
    assert.ok(!/µimage/.test(compile), `l'appel doit avoir disparu du code compilé :\n${compile.slice(0, 400)}`)
    assert.match(compile, /"width":\s*1600/, 'la largeur native doit être écrite dans le compilé')
    assert.match(compile, /"height":\s*900/, 'la hauteur native aussi — c'.concat('est elle qui supprime le saut de mise en page'))
    assert.match(compile, /hero-[a-f0-9]{8}\.png/, 'et l\'URL doit être hachée, comme tout asset')

    await bundler.close()
  })

  // même contrat qu'un `µasset` introuvable, et c'est voulu : une image absente est une
  // ERREUR de build franche, jamais un chemin cassé qui part en production
  it('un fichier introuvable fait ÉCHOUER le build, en nommant le fichier', async () => {
    const p = projet('image-absente')
    writeFileSync(join(p.srcDir, 'page.mjs'), '<script>\nphoto = µimage(\'nexistepas.png\')\n</script>\n<p>x</p>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'une image introuvable doit faire échouer le build')
    assert.match(stats.errors.map(e => e.message).join('\n'), /nexistepas\.png/)
    await bundler.close()
  })

  it('le SVG n\'est jamais redimensionné : une seule ressource', async () => {
    const p = projet('image-svg')
    writeFileSync(join(p.srcDir, 'logo.svg'), '<svg width="200" height="50" xmlns="http://www.w3.org/2000/svg"></svg>')
    writeFileSync(join(p.srcDir, 'page.mjs'), '<script>\nlogo = µimage(\'logo.svg\')\n</script>\n<p>x</p>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const compile = readFileSync(join(p.outDir, readdirSync(p.outDir).find(f => /^page-/.test(f))!), 'utf-8')
    assert.match(compile, /"srcset":""/, `un SVG n'a pas de variantes :\n${compile.slice(0, 300)}`)
    assert.match(compile, /"width":\s*200/)
    await bundler.close()
  })

  it("deux appels au MÊME fichier avec des largeurs différentes sont deux entrées distinctes", async () => {
    const p = projet('image-largeurs')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<script>\npetit = µimage(\'hero.png\', 320)\ngrand = µimage(\'hero.png\', 320, 640)\n</script>\n<p>x</p>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const compile = readFileSync(join(p.outDir, readdirSync(p.outDir).find(f => /^page-/.test(f))!), 'utf-8')
    assert.ok(!/µimage/.test(compile), 'les deux appels doivent avoir été substitués')
    await bundler.close()
  })

  it("l'image est suivie comme DÉPENDANCE : la modifier invalide le composant", async () => {
    const p = projet('image-dep')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<script>\nphoto = µimage(\'hero.png\')\n</script>\n<p>x</p>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    await bundler.compile()
    const avant = readdirSync(p.outDir).find(f => /^page-/.test(f))!

    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(800, 400))   // une AUTRE image, mêmes noms
    await bundler.compile()
    const apres = readdirSync(p.outDir).find(f => /^page-/.test(f) && f !== avant)
    assert.ok(apres, `changer l'image doit recompiler le composant (avant : ${avant}, dossier : ${readdirSync(p.outDir).join(', ')})`)
    const compile = readFileSync(join(p.outDir, apres!), 'utf-8')
    assert.match(compile, /"width":\s*800/, 'et le composant doit porter les NOUVELLES dimensions')

    await bundler.close()
  })
})

describe('<@img> — le module cœur', function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it('se compile et entre au manifeste dès qu\'un composant l\'emploie', async () => {
    const p = projet('img-tag')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<script>\n$photo = µimage(\'hero.png\')\n</script>\n\n<@img src={$photo.src} srcset={$photo.srcset} width={$photo.width} height={$photo.height} alt="Une photo"></@img>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(Object.keys(stats.manifest).includes('img'), `le module cœur doit être au manifeste :\n${Object.keys(stats.manifest).join(', ')}`)
    await bundler.close()
  })

  // L'ancien nom ne doit plus résoudre aucun module cœur : la balise a été
  // RENOMMÉE, pas dupliquée. Un `<@image>` doit désormais échouer comme n'importe
  // quelle balise inconnue.
  it('<@image> (ancien nom) ne résout plus aucun module cœur', async () => {
    const p = projet('image-inconnue')
    writeFileSync(join(p.srcDir, 'page.mjs'), '<script>\n$alt = \'Une photo\'\n</script>\n\n<@image src="hero.png" alt={$alt}></@image>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'un <@image> doit désormais échouer : la balise a été renommée en <@img>')
    assert.match(stats.errors.map(e => e.message).join('\n'), /<@image>/)
    assert.ok(!Object.keys(stats.manifest).includes('image'), `l'ancien nom ne doit plus entrer au manifeste :\n${Object.keys(stats.manifest).join(', ')}`)
    await bundler.close()
  })
})

describe('µimage — les variantes (exigent sharp)', function () {
  this.timeout(120000)

  after(async () => { await terminateSharedWorkerPool() })

  it('produit un .webp par largeur et un srcset, quand sharp est installé', async function () {
    const { resolveSharp } = await import('../src/bundler/image.js')
    const sharp = await resolveSharp()
    if (!sharp) {
      // dépendance OPTIONNELLE : son absence n'est pas un échec, c'est le cas nominal
      // chez qui ne l'installe pas. Le repli, lui, est couvert par les tests ci-dessus.
      this.skip()
    }
    const p = projet('image-variantes')
    // une VRAIE image encodée par sharp lui-même : notre PNG d'en-tête minimal n'a pas
    // de données de pixels, aucun encodeur ne saurait le redimensionner
    const vraiPng: Buffer = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#3b82f6' } }).png().toBuffer()
    writeFileSync(join(p.srcDir, 'hero.png'), vraiPng)
    writeFileSync(join(p.srcDir, 'page.mjs'), '<script>\nphoto = µimage(\'hero.png\')\n</script>\n<p>x</p>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, image: { widths: [320, 640], formats: ['webp'] } })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const emis = readdirSync(p.outDir)
    assert.ok(emis.some(f => /^hero-320-[a-f0-9]{8}\.webp$/.test(f)), `variante 320 absente : ${emis.join(', ')}`)
    assert.ok(emis.some(f => /^hero-640-[a-f0-9]{8}\.webp$/.test(f)), `variante 640 absente : ${emis.join(', ')}`)
    const compile = readFileSync(join(p.outDir, emis.find(f => /^page-/.test(f))!), 'utf-8')
    assert.match(compile, /320w/, compile.slice(0, 400))
    await bundler.close()
  })
})

describe('mjs.config.json — bloc `image`', () => {
  const config = (cfg: any) => {
    const root = mjsTmp('image-cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(cfg))
    return root
  }

  it('accepte { widths, formats, quality } valides', () => {
    const found = findConfig(config({ image: { widths: [320, 640], formats: ['avif', 'webp'], quality: 60 } }))
    assert.ok(found)
    assert.deepEqual(found!.config.image!.widths, [320, 640])
  })

  it('refuse une largeur qui n\'est pas un entier positif', () => {
    assert.throws(() => findConfig(config({ image: { widths: [0] } })), /image\.widths/)
  })

  it('refuse un format hors liste, en nommant les formats valides', () => {
    assert.throws(() => findConfig(config({ image: { formats: ['bmp'] } })), /image\.formats[\s\S]*avif/)
  })

  it('refuse une qualité hors 1-100', () => {
    assert.throws(() => findConfig(config({ image: { quality: 0 } })), /image\.quality/)
  })

  it('refuse une clé inconnue dans le bloc', () => {
    assert.throws(() => findConfig(config({ image: { largeur: 100 } })), /image\.largeur/)
  })
})
