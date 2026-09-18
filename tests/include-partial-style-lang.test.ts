// Fusion consciente du lang de style dans
// <@include>. AVANT : le `lang=` du <style> d'un partiel était totalement
// ignoré à la fusion — son texte brut était concaténé au style.raw de l'hôte
// (macros.ts processIncludes) puis compilé UNE SEULE FOIS avec le SEUL
// style.lang du PARENT (transpiler/index.ts:2366, point d'appel inchangé).
// Un partiel `<style lang="css">` (accolades) fusionné dans un hôte
// SASS indenté (le défaut du projet) faisait échouer TOUT le build
// (« Expected newline »), pas juste perdre le style du partiel. Choix retenu :
// compiler chaque bloc de style avec SON PROPRE lang, puis concaténer
// le CSS résultant — jamais concaténer des SOURCES hétérogènes avant compile.
//
// Harnais Bundler réel (tmpdir), calqué sur bundler-css-only-diff.test.ts /
// bundler-css-theme-missing.test.ts : compile un projet jouet, lit le CSS émis
// directement dans le fichier de sortie (`this._mjs_baseCss = \`…\`;`, gabarit
// littéral cf. transpiler/template.ts:52 — jamais retouché par une passe
// ultérieure, donc lisible tel quel par regex).
//
// Marqueurs `z-index: <n>` (pas des noms de couleur) dans les fixtures : le
// compresseur Sass réécrit certains noms de couleur en hex plus court (ex.
// magenta → #f0f), ce qui aurait cassé une assertion textuelle naïve — un
// entier traverse la compilation intact, quel que soit le lang.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

function makeProject(prefix: string) {
  const root = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

// lit `this._mjs_baseCss = \`…\`;` (gabarit littéral, transpiler/template.ts)
// dans le fichier émis pour `filePrefix` (basename du .mjs source, ex. 'host'
// pour host.mjs → host-HASH.js dans outDir — même convention que le test
// Bundler existant de tests/macros.test.ts, `/^shell-/`).
function readBaseCss(outDir: string, filePrefix: string): string {
  const files = readdirSync(outDir)
  const file = files.find(f => new RegExp(`^${filePrefix}-`).test(f))
  assert.ok(file, `fichier émis introuvable pour préfixe "${filePrefix}" (outDir : ${files.join(', ')})`)
  const content = readFileSync(join(outDir, file!), 'utf8')
  const m = content.match(/_mjs_baseCss = `([\s\S]*?)`;/)
  assert.ok(m, `_mjs_baseCss introuvable dans ${file}`)
  return m![1]
}

describe('<@include> — fusion consciente du lang de style', function () {
  this.timeout(30000)

  after(async () => { await terminateSharedWorkerPool() })

  it('hôte SASS indenté (défaut) + partiel lang="css" (accolades) → build OK, les deux jeux de règles présents (AVANT : erreur de build)', async () => {
    const p = makeProject('incl-lang-css-in-sass')
    writeFileSync(join(p.srcDir, 'host.mjs'), [
      '<script lang="coffee">$x = 0</script>',
      '<style>',
      '.host',
      '  z-index: 1001',
      '</style>',
      '<div><@include frag></div>'
    ].join('\n'))
    writeFileSync(join(p.srcDir, '_frag.mjs'), [
      '<style lang="css">',
      '.frag { z-index: 1002; }',
      '</style>',
      '<span>FRAG</span>'
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0,
      `AVANT le fix : « Expected newline » (accolades CSS parsées comme SASS indenté). Erreurs : ${stats.errors.map(e => e.message).join(' ; ')}`)

    const css = readBaseCss(p.outDir, 'host')
    assert.match(css, /\.host\{[^}]*z-index:1001/, `règle .host absente ou altérée : ${css}`)
    assert.match(css, /\.frag\s*\{[^}]*z-index:\s*1002/, `règle .frag (partiel css) absente : ${css}`)
    await bundler.close()
  })

  it('inverse : hôte lang="css" + partiel SASS indenté (défaut) → build OK, les deux présents', async () => {
    const p = makeProject('incl-lang-sass-in-css')
    writeFileSync(join(p.srcDir, 'host2.mjs'), [
      '<script lang="coffee">$x = 0</script>',
      '<style lang="css">',
      '.host2 { z-index: 2001; }',
      '</style>',
      '<div><@include frag2></div>'
    ].join('\n'))
    writeFileSync(join(p.srcDir, '_frag2.mjs'), [
      '<style>',
      '.frag2',
      '  z-index: 2002',
      '</style>',
      '<span>FRAG2</span>'
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join(' ; '))

    const css = readBaseCss(p.outDir, 'host2')
    assert.match(css, /\.host2\s*\{[^}]*z-index:\s*2001/, `règle .host2 (hôte css) absente : ${css}`)
    assert.match(css, /\.frag2\{[^}]*z-index:2002/, `règle .frag2 (partiel sass) absente : ${css}`)
    await bundler.close()
  })

  it('même lang des deux côtés → CSS émis IDENTIQUE à l\'équivalent recopié à la main (non-régression à l\'octet, cas ultra-majoritaire)', async () => {
    const p = makeProject('incl-lang-same')
    // A : hôte + <@include>, même lang (défaut SASS indenté) des deux côtés.
    writeFileSync(join(p.srcDir, 'hosta.mjs'), [
      '<script lang="coffee">$x = 0</script>',
      '<style>',
      '.hosta',
      '  z-index: 3001',
      '</style>',
      '<div><@include fraga></div>'
    ].join('\n'))
    writeFileSync(join(p.srcDir, '_fraga.mjs'), [
      '<style>',
      '.fraga',
      '  z-index: 3002',
      '</style>',
      '<span>FRAGA</span>'
    ].join('\n'))
    // B : mêmes règles, recopiées À LA MAIN dans l'hôte, zéro <@include>.
    writeFileSync(join(p.srcDir, 'hostb.mjs'), [
      '<script lang="coffee">$x = 0</script>',
      '<style>',
      '.hosta',
      '  z-index: 3001',
      '.fraga',
      '  z-index: 3002',
      '</style>',
      '<div><span>FRAGA</span></div>'
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join(' ; '))

    const cssA = readBaseCss(p.outDir, 'hosta')
    const cssB = readBaseCss(p.outDir, 'hostb')
    assert.equal(cssA, cssB,
      'même lang des deux côtés : la sortie CSS doit rester identique à l\'octet près (chemin de déballage pur, aucune recompilation scindée)')
    await bundler.close()
  })

  it('partiel SANS <style> du tout → inchangé (rien à baliser, chemin déjà existant intact)', async () => {
    const p = makeProject('incl-no-style')
    writeFileSync(join(p.srcDir, 'host4.mjs'), [
      '<script lang="coffee">$x = 0</script>',
      '<style>',
      '.host4',
      '  z-index: 4001',
      '</style>',
      '<div><@include frag4></div>'
    ].join('\n'))
    writeFileSync(join(p.srcDir, '_frag4.mjs'), '<span>FRAG4</span>')

    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join(' ; '))

    const css = readBaseCss(p.outDir, 'host4')
    assert.match(css, /\.host4\{[^}]*z-index:4001/, `règle .host4 absente ou altérée : ${css}`)
    await bundler.close()
  })

  it('deux partiels de langs différents inclus dans le même hôte → les trois jeux de règles présents', async () => {
    const p = makeProject('incl-lang-triple')
    writeFileSync(join(p.srcDir, 'host5.mjs'), [
      '<script lang="coffee">$x = 0</script>',
      '<style lang="scss">',
      '.host5 { z-index: 5001; }',
      '</style>',
      '<div><@include fraga5></div>',
      '<div><@include fragb5></div>'
    ].join('\n'))
    writeFileSync(join(p.srcDir, '_fraga5.mjs'), [
      '<style lang="css">',
      '.fraga5 { z-index: 5002; }',
      '</style>',
      '<span>A5</span>'
    ].join('\n'))
    writeFileSync(join(p.srcDir, '_fragb5.mjs'), [
      '<style>',
      '.fragb5',
      '  z-index: 5003',
      '</style>',
      '<span>B5</span>'
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join(' ; '))

    const css = readBaseCss(p.outDir, 'host5')
    assert.match(css, /\.host5\{[^}]*z-index:5001/, `règle .host5 (hôte scss) absente : ${css}`)
    assert.match(css, /\.fraga5\s*\{[^}]*z-index:\s*5002/, `règle .fraga5 (partiel css) absente : ${css}`)
    assert.match(css, /\.fragb5\{[^}]*z-index:5003/, `règle .fragb5 (partiel sass) absente : ${css}`)
    // ordre source préservé : hôte, puis partiels dans l'ordre d'inclusion.
    assert.ok(css.indexOf('.host5') < css.indexOf('.fraga5'), 'ordre source non préservé (host5 avant fraga5)')
    assert.ok(css.indexOf('.fraga5') < css.indexOf('.fragb5'), 'ordre source non préservé (fraga5 avant fragb5)')
    await bundler.close()
  })
})

// Faille THÉORIQUE du sentinel : un fichier source
// contenant DÉJÀ un octet NUL réel + un mot-clé du sentinel (MJSENDSTYLE /
// MJSSTYLE:) trompe STYLE_BLOCK_RE (transpiler/css.ts), qui scanne le texte
// fusionné SANS savoir qu'un `\x00` est niché dans un commentaire — même lang
// → fuite silencieuse du marqueur dans le CSS livré ; langs différents →
// faux découpage (bloc fantôme compilé avec le mauvais lang, voire texte brut
// non parsé qui fuit tel quel). Choix retenu : neutraliser à l'entrée — un
// NUL pré-existant est retiré AVANT la pose de nos marqueurs, côté partial
// (macros.ts processIncludes) ET côté hôte (transpiler/index.ts, avant
// l'append de includeAcc.css) — par construction, les seuls `\x00` du texte
// fusionné sont donc les nôtres. Jamais un caractère utile en CSS/SASS (la
// tokenisation CSS remplace U+0000 par U+FFFD) : le strip est sémantiquement
// sans perte.
describe('<@include> — garde anti-NUL pré-existant (faille théorique du sentinel)', function () {
  this.timeout(30000)

  after(async () => { await terminateSharedWorkerPool() })

  it('partiel avec NUL+mots-clés hostiles dans le style, même lang que l\'hôte → build vert, zéro fuite (chemin déballage pur)', async () => {
    const p = makeProject('incl-nul-guard-partial-sameLang')
    writeFileSync(join(p.srcDir, 'host6.mjs'), [
      '<script lang="coffee">$x = 0</script>',
      '<style>',
      '.host6',
      '  z-index: 6001',
      '</style>',
      '<div><@include frag6></div>'
    ].join('\n'))
    // payload : vrais octets NUL (String.fromCharCode(0) via '\x00' du source
    // de test) + mots-clés du sentinel, nichés dans un commentaire `//`
    // (silencieux, TOUJOURS retiré par Sass quel que soit le style de sortie)
    // — même lang que l'hôte (sass indenté, le défaut projet des deux côtés).
    writeFileSync(join(p.srcDir, '_frag6.mjs'), [
      '<style>',
      '.frag6',
      '  z-index: 6002',
      '  // piège : ' + '\x00MJSENDSTYLE\x00\x00MJSSTYLE:css\x00' + ' fin piège',
      '.frag6b',
      '  z-index: 6003',
      '</style>',
      '<span>FRAG6</span>'
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join(' ; '))

    const css = readBaseCss(p.outDir, 'host6')
    assert.ok(!css.includes('\x00'), `NUL hostile survivant dans le CSS livré : ${JSON.stringify(css)}`)
    assert.ok(!css.includes('MJSENDSTYLE') && !css.includes('MJSSTYLE'), `sentinel hostile fuité en clair : ${css}`)
    assert.match(css, /\.host6\{[^}]*z-index:6001/, `règle .host6 absente ou altérée : ${css}`)
    assert.match(css, /\.frag6\{[^}]*z-index:6002/, `règle .frag6 absente ou tronquée (preuve de mauvais découpage) : ${css}`)
    assert.match(css, /\.frag6b\{[^}]*z-index:6003/, `règle .frag6b absente (bloc suivant perdu si le piège a mal découpé) : ${css}`)
    await bundler.close()
  })

  it('même piège, langs DIVERGENTS (hôte sass indenté, partiel lang="css") → build vert, les deux CSS présents, zéro octet NUL', async () => {
    const p = makeProject('incl-nul-guard-partial-diffLang')
    writeFileSync(join(p.srcDir, 'host7.mjs'), [
      '<script lang="coffee">$x = 0</script>',
      '<style>',
      '.host7',
      '  z-index: 7001',
      '</style>',
      '<div><@include frag7></div>'
    ].join('\n'))
    // lang="css" : passthrough (pas de parseur Sass) → un commentaire /* */
    // n'est PAS retiré à la compilation (à la différence du `//` Sass
    // ci-dessus) ; le texte résiduel (post-strip, sans NUL) peut donc
    // légitimement survivre — seuls l'octet NUL et le découpage sont sous
    // garantie ici, pas le texte du commentaire.
    writeFileSync(join(p.srcDir, '_frag7.mjs'), [
      '<style lang="css">',
      '.frag7 { z-index: 7002; /* piège : ' + '\x00MJSENDSTYLE\x00\x00MJSSTYLE:sass\x00' + ' */ }',
      '</style>',
      '<span>FRAG7</span>'
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join(' ; '))

    const css = readBaseCss(p.outDir, 'host7')
    assert.ok(!css.includes('\x00'), `NUL hostile survivant dans le CSS livré : ${JSON.stringify(css)}`)
    assert.match(css, /\.host7\{[^}]*z-index:7001/, `règle .host7 absente ou altérée : ${css}`)
    assert.match(css, /\.frag7\s*\{[^}]*z-index:\s*7002/, `règle .frag7 absente ou tronquée (preuve de mauvais découpage) : ${css}`)
    await bundler.close()
  })

  it('hôte dont le <style> contient le piège + partiel normal inclus → zéro fuite, aucun faux bloc (preuve du strip côté hôte, transpiler/index.ts:1961)', async () => {
    const p = makeProject('incl-nul-guard-host')
    writeFileSync(join(p.srcDir, 'host8.mjs'), [
      '<script lang="coffee">$x = 0</script>',
      '<style>',
      '.host8',
      '  z-index: 8001',
      '  // ' + '\x00MJSSTYLE:css\x00piège\x00MJSENDSTYLE\x00',
      '</style>',
      '<div><@include frag8></div>'
    ].join('\n'))
    writeFileSync(join(p.srcDir, '_frag8.mjs'), [
      '<style>',
      '.frag8',
      '  z-index: 8002',
      '</style>',
      '<span>FRAG8</span>'
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join(' ; '))

    const css = readBaseCss(p.outDir, 'host8')
    assert.ok(!css.includes('\x00'), `NUL hostile survivant dans le CSS livré : ${JSON.stringify(css)}`)
    assert.ok(!css.includes('piège') && !css.includes('MJSENDSTYLE') && !css.includes('MJSSTYLE'),
      `sentinel hostile de l'hôte fuité en clair (strip transpiler/index.ts:1961 inopérant) : ${css}`)
    assert.match(css, /\.host8\{[^}]*z-index:8001/, `règle .host8 absente ou altérée : ${css}`)
    assert.match(css, /\.frag8\{[^}]*z-index:8002/, `règle .frag8 absente (faux bloc créé par le piège hôte) : ${css}`)
    await bundler.close()
  })
})
