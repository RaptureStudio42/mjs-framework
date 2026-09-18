// `<@img src="hero.jpg">` : un `src` littéral
// résolu au build par la MÊME mécanique que `µimage('hero.jpg')` (cf. transpiler/img-tag.ts,
// bundler/index.ts preResolveAssets). Mêmes fixtures que image-pipeline.test.ts : PNG minimal
// valide (en-tête réel : signature + IHDR), projet jetable via mjsTmp.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
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

/** relit le `page-<hash>.js` fraîchement écrit par le dernier compile() du projet */
function compileDe(p: ReturnType<typeof projet>): string {
  const fichier = readdirSync(p.outDir).find(f => /^page-/.test(f))!
  return readFileSync(join(p.outDir, fichier), 'utf-8')
}

describe('<@img src="…"> — résolution au build', function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it('src littéral résolu — src haché, width/height natifs, widths absent, alt intact', async () => {
    const p = projet('imgtag-basique')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<@img src="hero.png" alt="x"></@img>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const compile = compileDe(p)
    assert.match(compile, /hero-[a-f0-9]{8}\.png/, `le src doit être haché :\n${compile.slice(0, 400)}`)
    assert.match(compile, /width=.1600./, `largeur native attendue :\n${compile.slice(0, 400)}`)
    assert.match(compile, /height=.900./, `hauteur native attendue :\n${compile.slice(0, 400)}`)
    assert.ok(!/widths=/.test(compile), `l'attribut widths ne doit jamais survivre :\n${compile.slice(0, 400)}`)
    assert.match(compile, /alt=.x./, `alt de l'auteur doit rester intact :\n${compile.slice(0, 400)}`)
    await bundler.close()
  })

  it('sizes/width posés par l\'auteur sont conservés verbatim, jamais dupliqués', async () => {
    const p = projet('imgtag-verbatim')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<@img src="hero.png" sizes="50vw" width="10" alt="x"></@img>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const compile = compileDe(p)
    assert.match(compile, /sizes=.50vw./, `sizes de l'auteur doit survivre :\n${compile.slice(0, 400)}`)
    assert.match(compile, /width=.10./, `width de l'auteur doit survivre :\n${compile.slice(0, 400)}`)
    assert.equal((compile.match(/sizes=/g) ?? []).length, 1, `sizes ne doit jamais être dupliqué :\n${compile.slice(0, 400)}`)
    assert.equal((compile.match(/width=/g) ?? []).length, 1, `width ne doit jamais être dupliqué :\n${compile.slice(0, 400)}`)
    await bundler.close()
  })

  it('widths="320, 640" retiré ; srcset selon la présence de sharp (les deux branches assertées)', async function () {
    const { resolveSharp } = await import('../src/bundler/image.js')
    const sharp = await resolveSharp()
    const p = projet('imgtag-widths')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<@img src="hero.png" widths="320, 640" alt="x"></@img>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const compile = compileDe(p)
    assert.ok(!/widths=/.test(compile), `l'attribut widths ne doit pas survivre :\n${compile.slice(0, 400)}`)
    if (sharp) {
      assert.match(compile, /320w/, `srcset doit porter 320w quand sharp est installé :\n${compile.slice(0, 400)}`)
    } else {
      assert.ok(!/srcset=/.test(compile), `sans sharp, srcset reste vide donc absent de la balise :\n${compile.slice(0, 400)}`)
    }
    await bundler.close()
  })

  it('src={$photo.src} dynamique reste byte-identique (aucune résolution tentée)', async () => {
    const p = projet('imgtag-dynamique')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<script>\n$photo = µimage(\'hero.png\')\n</script>\n\n<@img src={$photo.src} alt="x"></@img>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const compile = compileDe(p)
    assert.match(compile, /_mjs_cloneTpl\("<mjs-img alt='x'><\/mjs-img>"\)/,
      `la balise dynamique doit rester inchangée, aucun attribut statique ajouté :\n${compile.slice(0, 600)}`)
    await bundler.close()
  })

  it('src absolu, URL et data: passent tels quels (byte-identiques)', async () => {
    const p = projet('imgtag-passthrough')
    writeFileSync(join(p.srcDir, 'page.mjs'), [
      '<@img src="/images/x.png" alt="a"></@img>',
      '<@img src="https://a/b.png" alt="b"></@img>',
      '<@img src="data:image/png;base64,AA==" alt="c"></@img>',
    ].join('\n'))
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const compile = compileDe(p)
    assert.match(compile, /<mjs-img src='\/images\/x\.png' alt='a'><\/mjs-img>/, compile.slice(0, 600))
    assert.match(compile, /<mjs-img src='https:\/\/a\/b\.png' alt='b'><\/mjs-img>/, compile.slice(0, 600))
    assert.match(compile, /<mjs-img src='data:image\/png;base64,AA==' alt='c'><\/mjs-img>/, compile.slice(0, 600))
    await bundler.close()
  })

  it('fichier relatif absent fait échouer le build — message avec le chemin et <@img>', async () => {
    const p = projet('imgtag-absent')
    writeFileSync(join(p.srcDir, 'page.mjs'), '<@img src="nexistepas.png" alt="x"></@img>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'un fichier absent doit faire échouer le build')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /nexistepas\.png/)
    assert.match(msg, /<@img/)
    await bundler.close()
  })

  it('la même balise dans <pre><code> (fichier absent) — aucune résolution tentée, build OK', async () => {
    const p = projet('imgtag-precode')
    writeFileSync(join(p.srcDir, 'page.mjs'), '<pre><code><@img src="nexistepas.png" alt="x"></@img></code></pre>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0,
      `un exemple affiché dans <pre>/<code> ne doit jamais être résolu :\n${stats.errors.map(e => e.message).join('\n')}`)
    await bundler.close()
  })

  it('balise vivant SEULEMENT dans un partial <@include> est résolue', async () => {
    const p = projet('imgtag-partial')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, '_header.mjs'), '<@img src="hero.png" alt="logo"></@img>')
    writeFileSync(join(p.srcDir, 'page.mjs'), '<div><@include header></div>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const compile = compileDe(p)
    assert.match(compile, /hero-[a-f0-9]{8}\.png/, `le <@img> du partial doit être résolu :\n${compile.slice(0, 400)}`)
    await bundler.close()
  })

  it('apostrophe dans alt + attribut dynamique + auto-fermeture — fin de balise correcte, src résolu', async () => {
    const p = projet('imgtag-selfclose')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<script>\n$x = \'ok\'\n</script>\n\n<@img src="hero.png" alt="l\'été" title={$x} />')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const compile = compileDe(p)
    assert.match(compile, /hero-[a-f0-9]{8}\.png/,
      `src doit être résolu malgré l'apostrophe et l'attribut dynamique :\n${compile.slice(0, 600)}`)
    await bundler.close()
  })

  it('widths="abc" est rejeté avec le message dédié', async () => {
    const p = projet('imgtag-widths-invalide')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<@img src="hero.png" widths="abc" alt="x"></@img>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'des largeurs invalides doivent faire échouer le build')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /widths/)
    assert.match(msg, /abc/)
    await bundler.close()
  })

  it('non-régression — µimage(...) et <@img src={…}> compilent comme avant', async () => {
    const p = projet('imgtag-non-regression')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'),
      '<script>\n$photo = µimage(\'hero.png\')\n</script>\n\n<@img src={$photo.src} srcset={$photo.srcset} width={$photo.width} height={$photo.height} alt="Une photo"></@img>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(Object.keys(stats.manifest).includes('img'), `le module cœur doit être au manifeste :\n${Object.keys(stats.manifest).join(', ')}`)
    const compile = compileDe(p)
    assert.ok(!/µimage/.test(compile), `l'appel µimage doit avoir disparu du code compilé :\n${compile.slice(0, 400)}`)
    await bundler.close()
  })

  it('<@IMG> (casse mêlée) est résolu comme <@img>, nom de balise préservé', async () => {
    const p = projet('imgtag-casse')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<@IMG src="hero.png" alt="x"></@IMG>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const compile = compileDe(p)
    assert.match(compile, /hero-[a-f0-9]{8}\.png/, `un <@IMG> en majuscules doit être résolu comme <@img> :\n${compile.slice(0, 400)}`)
    assert.match(compile, /width=.1600./, `largeur native attendue :\n${compile.slice(0, 400)}`)
    await bundler.close()
  })

  it('<@IMG> avec un fichier absent fait échouer le build (pas d\'angle mort de casse)', async () => {
    const p = projet('imgtag-casse-absent')
    writeFileSync(join(p.srcDir, 'page.mjs'), '<@IMG src="jamais-la.png" alt="x"></@IMG>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'un fichier absent doit faire échouer le build, quelle que soit la casse de la balise')
    assert.match(stats.errors.map(e => e.message).join('\n'), /jamais-la\.png/)
    await bundler.close()
  })

  it('src écrit deux fois est refusé au build (jamais deux src dans la sortie)', async () => {
    const p = projet('imgtag-src-double')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<@img src="hero.png" src="hero.png" alt="x"></@img>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'un attribut src dupliqué doit faire échouer le build')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /src/)
    assert.match(msg, /deux fois|dupliqu/)
    await bundler.close()
  })

  it('widths={expr} dynamique est refusé (jamais retiré en silence)', async () => {
    const p = projet('imgtag-widths-dyn')
    writeFileSync(join(p.srcDir, 'hero.png'), pngDe(1600, 900))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<script>\n$w = \'320 640\'\n</script>\n\n<@img src="hero.png" widths={$w} alt="x"></@img>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'des largeurs dynamiques doivent faire échouer le build, jamais disparaître en silence')
    assert.match(stats.errors.map(e => e.message).join('\n'), /widths/)
    await bundler.close()
  })

  it('src qui sort de sourceDir est refusé en nommant la balise et le chemin', async () => {
    const p = projet('imgtag-hors-source')
    mkdirSync(join(p.root, 'hors'), { recursive: true })
    writeFileSync(join(p.root, 'hors', 'x.png'), pngDe(800, 600))
    writeFileSync(join(p.srcDir, 'page.mjs'), '<@img src="../hors/x.png" alt="x"></@img>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'un chemin hors sourceDir doit faire échouer le build')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /<@img/, `le message doit nommer la balise :\n${msg}`)
    assert.match(msg, /\.\.\/hors\/x\.png/, `le message doit nommer le chemin :\n${msg}`)
    await bundler.close()
  })
})
