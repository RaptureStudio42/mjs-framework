// rune séparée de son symbole (`µ` puis `.setContext(…)` à la ligne suivante, `µ .emit`, `µ.` puis `toast` à la
// ligne suivante) : ni réécrite par le transpileur ni vue par la détection des modules du cœur, elle compilait
// puis plantait à l'exécution (`µ.setContext is not a function`) ; désormais refusée à la compilation, chaînes et
// commentaires exclus, sur le code de script seulement : <script>, <script module>, script des partiels, modules importés

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lintSplitRune, transpile } from '../src/transpiler/index.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('lintSplitRune — règle seule (chaînes et commentaires masqués)', () => {
  it('µ en fin de ligne puis .setContext à la ligne suivante → refus nommant symbole, rune, lieu, ligne et écriture attendue', () => {
    assert.throws(() => lintSplitRune("µ\n  .setContext('theme', 'sombre')", '<script>'), /« µ » séparé de sa rune « setContext »[\s\S]*\(<script>, ligne 1\)[\s\S]*µ\.setContext/)
  })

  it('ligne du µ comptée dans la section (méthode, 2e ligne)', () => {
    assert.throws(() => lintSplitRune("@go = ->\n  µ\n    .emit 'x'", '<script>'), /« emit »[\s\S]*ligne 2\)/)
  })

  it('toutes les runes, pas seulement les quatre réécrites : µ⏎.toast', () => {
    assert.throws(() => lintSplitRune("µ\n  .toast('coucou')", '<script>'), /« toast »/)
  })

  it('commentaire sur la ligne du µ, lignes vides avant le point → refus', () => {
    assert.throws(() => lintSplitRune("µ # thème\n\n  .on 'x', -> 1", '<script>'), /« on »/)
  })

  it('espace sur la même ligne : µ .setContext → refus', () => {
    assert.throws(() => lintSplitRune("µ .setContext('a', 1)", '<script>'), /« setContext »/)
  })

  it('point collé au µ, rune à la ligne suivante : µ.⏎toast → refus', () => {
    assert.throws(() => lintSplitRune("µ.\n  toast('coucou')", '<script>'), /« toast »/)
  })

  it('écritures d\'un seul tenant → aucune erreur', () => {
    assert.doesNotThrow(() => lintSplitRune("µ.setContext('a', 1)\n$t = µgetContext('a')\nµemit 'x'\nµ.state.x\n  .toFixed(2)", '<script>'))
  })

  it('µ dans une chaîne ou un commentaire → aucune erreur', () => {
    assert.doesNotThrow(() => lintSplitRune("$t = 'µ .setContext'\n# µ\n#  .setContext('a', 1)\n/* µ\n  .emit */\n$u = 1", '<script>'))
  })

  it('µ en fin d\'instruction, nombre décimal à la ligne suivante, propriété nommée µ → aucune erreur', () => {
    assert.doesNotThrow(() => lintSplitRune("x = µ\ny = .5\nw = obj.µ\n  .length", '<script>'))
  })

  it('alias mjs configuré : mjs⏎.setContext → refus nommant « mjs » ; sans alias, un nom mjs reste libre', () => {
    assert.throws(() => lintSplitRune("mjs\n  .setContext('theme', 'sombre')", '<script>', { sigil: 'mjs' }), /« mjs » séparé de sa rune « setContext »[\s\S]*mjs\.setContext/)
    assert.doesNotThrow(() => lintSplitRune("mjs\n  .setContext('theme', 'sombre')", '<script>'))
  })
})

describe('lintSplitRune — le code lu comme le lit la réécriture', () => {
  it('littéral regex JS contenant µ, espace et point → aucune erreur', () => {
    assert.doesNotThrow(() => lintSplitRune('const re = /texte µ .bar ici/\nx = 1', '<script>', { lang: 'js' }))
    assert.doesNotThrow(() => lintSplitRune('re = /texte µ .bar ici/g\nx = 1', '<script>'))
  })

  it('heregex Coffee/Civet `///…///` → aucune erreur', () => {
    assert.doesNotThrow(() => lintSplitRune('re = ///\n  µ .foo texte libre\n///\nx = 1', '<script>'))
    assert.doesNotThrow(() => lintSplitRune('re = ///\n  µ .foo texte libre\n///\nx = 1', '<script>', { lang: 'coffee' }))
  })

  it('heredoc `"""…"""` et `\'\'\'…\'\'\'` → aucune erreur', () => {
    assert.doesNotThrow(() => lintSplitRune('t = """\n  il dit " µ\n    .setContext(1)\n"""\nx = 1', '<script>'))
    assert.doesNotThrow(() => lintSplitRune("t = '''\n  l'appel µ .foo\n'''\nx = 1", '<script>'))
  })

  it('bloc `###…###` → aucune erreur', () => {
    assert.doesNotThrow(() => lintSplitRune('###\n  µ\n    .emit x\n###\nx = 1', '<script>'))
  })

  it('champ privé JS `#x` avant le µ sur la même ligne : pas un commentaire → refus', () => {
    assert.throws(() => lintSplitRune('class C { m() { this.#x = 1; µ\n  .toast(1) } }', '<script>', { lang: 'js' }), /« toast »/)
  })

  it('en Coffee, `#` ouvre toujours un commentaire → aucune erreur', () => {
    assert.doesNotThrow(() => lintSplitRune('x = 1 #note µ .toast 1', '<script>', { lang: 'coffee' }))
  })

  it('interpolation de gabarit `${…}` sur plusieurs lignes : du code → refus', () => {
    assert.throws(() => lintSplitRune('s = `v ${µ\n  .toast(1)}`', '<script>'), /« toast »/)
  })

  it('interpolation `#{…}` d\'une chaîne à guillemets doubles Coffee/Civet : du code → refus ; guillemets simples : du texte', () => {
    assert.throws(() => lintSplitRune('s = "v #{µ\n  .toast(1)}"', '<script>'), /« toast »/)
    assert.doesNotThrow(() => lintSplitRune("s = 'v #{µ\n  .toast(1)}'", '<script>'))
  })

  it('chaîne qui contient une accolade dans une interpolation : la chaîne interne reste du texte', () => {
    assert.doesNotThrow(() => lintSplitRune('s = `a ${f("}", "µ .x")} b`\nx = 1', '<script>'))
  })
})

describe('transpile — rune séparée de son symbole = erreur de compilation', function () {
  this.timeout(30000)

  it('<script> Civet : µ⏎.setContext → rejet (compilait puis plantait au montage)', async () => {
    const src = "<script>\nµ\n  .setContext('theme', 'sombre')\n</script>\n<p>x</p>"
    await assert.rejects(transpile(src, { moduleName: 'split-civet' }), /« µ » séparé de sa rune « setContext »[\s\S]*<script>, ligne 2/)
  })

  it('<script lang="coffee"> : µ .emit → rejet', async () => {
    const src = "<script lang=\"coffee\">\n@go = -> µ .emit 'x'\n</script>\n<button @click={@go()}>go</button>"
    await assert.rejects(transpile(src, { moduleName: 'split-coffee' }), /« emit »/)
  })

  it('<script module> : µ⏎.toast → rejet situé dans le module', async () => {
    const src = "<script module>\nsalut = ->\n  µ\n    .toast('coucou')\n</script>\n<script>\n$n = 0\n</script>\n<p>{$n}</p>"
    await assert.rejects(transpile(src, { moduleName: 'split-module' }), /« toast »[\s\S]*<script module>, ligne 3/)
  })

  it('alias mjs : mjs⏎.setContext → rejet', async () => {
    const src = "<script>\nmjs\n  .setContext('theme', 'sombre')\n</script>\n<p>x</p>"
    await assert.rejects(transpile(src, { moduleName: 'split-mjs', sigil: 'mjs' }), /« mjs » séparé de sa rune « setContext »/)
  })

  it('script d\'un partiel <@include> : rejet nommant le partiel', async () => {
    const dir = mjsTmp('split-rune-partiel')
    writeFileSync(join(dir, '_entete.mjs'), "<script>\n$t = 1\nµ\n  .setContext('theme', 'sombre')\n</script>\n<p>entête</p>")
    const src = '<script>\n$n = 0\n</script>\n<@include entete>\n<p>{$n}</p>'
    await assert.rejects(transpile(src, { moduleName: 'split-hote', baseDir: dir }), /« setContext »[\s\S]*_entete\.mjs <script>, ligne 3/)
  })

  it('partiel sans lang= dans un projet Coffee par défaut : lu en Coffee comme le script hôte qui le reçoit (`#note µ .toast` = commentaire)', async () => {
    const dir = mjsTmp('split-rune-partiel-coffee')
    writeFileSync(join(dir, '_pied.mjs'), '<script>\n$t = 1 #note µ .toast 1\n</script>\n<p>pied</p>')
    writeFileSync(join(dir, '_pied-module.mjs'), '<script module>\nx = 1 #note µ .toast 1\n</script>\n<p>pied</p>')
    const src = '<script>\n$n = 0\n</script>\n<@include pied>\n<@include pied-module>\n<p>{$n}</p>'
    await assert.doesNotReject(transpile(src, { moduleName: 'split-hote-coffee', baseDir: dir, defaultScriptLang: 'coffee' } as any))
  })

  it('numéro = ligne du fichier .mjs, même quand le <script> ne commence pas à la ligne 1', async () => {
    const src = "<p>avant</p>\n\n<script>\n$n = 0\nµ\n  .emit 'x'\n</script>"
    await assert.rejects(transpile(src, { moduleName: 'split-ligne' }), /« emit »[\s\S]*<script>, ligne 5/)
  })

  it('non-régression : rune d\'un seul tenant, chaîne ou commentaire qui la cite → compile', async () => {
    const src = "<script>\nµ.setContext('theme', 'sombre')\n# µ\n#   .setContext(…) : écriture refusée\n$aide = 'µ .emit'\n</script>\n<p>{$aide}</p>"
    await assert.doesNotReject(transpile(src, { moduleName: 'split-ok' }))
  })
})

describe('bundler — module .civet importé : rune séparée de son symbole refusée', function () {
  this.timeout(60000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('alias mjs configuré : un module importé écrit `mjs.log(…)` compile en `µ.log(…)`, et `mjs` puis `.toast` à la ligne suivante est refusé', async () => {
    const root   = mjsTmp('split-rune-module-alias')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'aide.module.civet'), "export saluer = ->\n  mjs.log('coucou')\n")
    writeFileSync(join(srcDir, 'app.mjs'), "@import saluer 'aide.module.civet'\n<script>\nval = 1\n</script>\n<p>{val}</p>")
    const ok = await new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), sigil: 'mjs' } as any).compile()
    assert.equal(ok.errors.length, 0, ok.errors.map((e: any) => e.message).join('\n'))
    const aide = readdirSync(outDir).find((f) => /^aide\.module-.*\.js$/.test(f))
    assert.ok(aide, `module absent de la sortie : ${readdirSync(outDir).join(', ')}`)
    const code = readFileSync(join(outDir, aide!), 'utf-8')
    assert.match(code, /µ\.log\(/)
    assert.doesNotMatch(code, /mjs\.log/)

    writeFileSync(join(srcDir, 'aide.module.civet'), "export saluer = ->\n  mjs\n    .toast('coucou')\n")
    const ko = await new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), sigil: 'mjs' } as any).compile()
    const messages = ko.errors.map((e: any) => String(e.message)).join('\n')
    assert.match(messages, /« mjs » séparé de sa rune « toast »[\s\S]*aide\.module\.civet, ligne 2/, `erreurs reçues : ${messages || '(aucune)'}`)
  })

  it('µ⏎.toast dans helper.module.civet → erreur de construction nommant le fichier et la ligne', async () => {
    const root   = mjsTmp('split-rune-module')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'helper.module.civet'), "export saluer = ->\n  µ\n    .toast('coucou')\n")
    writeFileSync(join(srcDir, 'app.mjs'), "@import saluer 'helper.module.civet'\n<script>\nval = 1\n</script>\n<p>{val}</p>")
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    const messages = stats.errors.map((e: any) => String(e.message)).join('\n')
    assert.match(messages, /« toast »[\s\S]*helper\.module\.civet, ligne 2/, `erreurs reçues : ${messages || '(aucune)'}`)
  })
})
