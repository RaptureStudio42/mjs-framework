// scanCompiledFeatures() (src/bundler/features.ts) — remplace le balayage textuel
// scanRuntimeFeatures() : chaque clé est désormais lue dans le CODE COMPILÉ (sortie NON
// minifiée de transpile()), jamais dans le texte source. Une fixture par clé, compilée
// directement via transpile() (pas de Bundler complet ici — la preuve boîte-noire sur le
// vrai mjs_core-*.js émis vit dans tests/bundler-core-after-components.test.ts).
//
// Chaque marqueur a été PROUVÉ empiriquement (sonde transpile() directe) avant d'écrire
// features.ts, pas déduit du seul texte du générateur — un cas a corrigé la conception :
// la balise `<@failed>` compile en `this._mjs_fallback = (err, reset) => {`, jamais
// `_mjs_hook('failed'` (réservé à la rune nue `µfailed (err, reset)->`).

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { transpile } from '../src/transpiler/index.js'
import { scanCompiledFeatures, SCAN_KEYS } from '../src/bundler/features.js'
import { mjsTmp } from './helpers/tmp.js'

async function scanOf(src: string, moduleName: string, baseDir?: string): Promise<Set<string>> {
  const { output, data } = await transpile(src, { moduleName, baseDir })
  return scanCompiledFeatures(output, data)
}

// état commun des fixtures d'interpolation brute `{{…}}`
const RAW_STATE = "<script>\n$h = '<b>x</b>'\n$ok = true\n$k = 1\n$items = [1, 2]\n$p = Promise.resolve('<i>r</i>')\n</script>\n"

describe('scanCompiledFeatures() — un marqueur COMPILÉ par clé, jamais un motif source', function () {
  this.timeout(30000)

  it('{for x in xs} : "for" présent', async () => {
    const used = await scanOf('<script lang="coffee">\n@xs = [1,2,3]\n</script>\n{for x in @xs}<p>{x}</p>{end}\n', 'f1')
    assert.ok(used.has('for'))
  })

  it('{if} racine : "if" présent', async () => {
    const used = await scanOf('<script lang="coffee">\n@ok = true\n</script>\n{if @ok}<p>y</p>{end}\n', 'f2')
    assert.ok(used.has('if'))
  })

  it('{if} imbriqué dans {for} SANS aucun {if} racine : "if" quand même présent (compile en _mjs_updItemIf, pas _mjs_updIf)', async () => {
    const used = await scanOf('<script lang="coffee">\n@xs = [1,2,3]\n</script>\n{for x in @xs}{if x > 1}<p>{x}</p>{end}{end}\n', 'f3')
    assert.ok(used.has('if'), '{if} niché doit être vu même sans marqueur _mjs_updIf littéral')
  })

  it('{key} racine : "key" présent', async () => {
    const used = await scanOf('<script lang="coffee">\n@k = 1\n</script>\n{key @k}<p>y</p>{end}\n', 'f4')
    assert.ok(used.has('key'))
  })

  it('{await} : "await" présent', async () => {
    const used = await scanOf('<script>$p = Promise.resolve(1)</script>\n{await $p}chargement{success v}{v}{end}\n', 'f5')
    assert.ok(used.has('await'))
  })

  it('@transition.fade sur un {if} : "destroy_hooks" présent', async () => {
    const used = await scanOf('<script lang="coffee">\n@ok = true\n</script>\n<p @transition.fade @if=!{@ok}>y</p>\n', 'f6')
    assert.ok(used.has('destroy_hooks'))
  })

  it('composant sans transition/attach/flip : "destroy_hooks" ABSENT', async () => {
    const used = await scanOf('<p>y</p>\n', 'f7')
    assert.equal(used.has('destroy_hooks'), false)
  })

  it('§foo (getContext) : "context" présent', async () => {
    const used = await scanOf('<script lang="coffee">\n@x = §foo\n</script>\n<p>{@x}</p>\n', 'f8')
    assert.ok(used.has('context'))
  })

  it('§foo = 1 (setContext) : "context" présent', async () => {
    const used = await scanOf('<script lang="coffee">\n§foo = 1\n</script>\n<p>y</p>\n', 'f9')
    assert.ok(used.has('context'))
  })

  it('§§theme en LECTURE seule dans le template (contexte RÉACTIF) : "context" présent — marqueur DISTINCT (_mjs_getRCtx, pas _mjs_getContext)', async () => {
    const used = await scanOf('<p>{§§theme}</p>\n', 'f9b')
    assert.ok(used.has('context'), '§§ (réactif) compile en _mjs_getRCtx(, raté par le premier jet du marqueur qui ne cherchait que _mjs_getContext(')
  })

  it('§§theme = x en ÉCRITURE (contexte RÉACTIF) : "context" présent (_mjs_setRCtx)', async () => {
    const used = await scanOf('<script>\n§§theme = \'sombre\'\n</script>\n<p>x</p>\n', 'f9c')
    assert.ok(used.has('context'))
  })

  it('µmount -> : "lifecycle" présent', async () => {
    const used = await scanOf('<script lang="coffee">\nµmount ->\n  1\n</script>\n<p>y</p>\n', 'f10')
    assert.ok(used.has('lifecycle'))
  })

  it('<@head> : "lifecycle" et "head" présents, "effect" forcé (co-émis par la macro)', async () => {
    const used = await scanOf('<@head><meta name="x" content="1"></@head>\n<p>y</p>\n', 'f11')
    assert.ok(used.has('head'))
    assert.ok(used.has('effect'))
  })

  it('<@body @class{@actif}="vif"/> : "body" et "effect" présents', async () => {
    const used = await scanOf(['<script lang="coffee">', '@actif = true', '</script>', '<@body @class{@actif}="vif"/>', '<p>x</p>'].join('\n'), 'f12')
    assert.ok(used.has('body'))
    assert.ok(used.has('effect'))
  })

  it('<@element $tag> : "dynamic" et "effect" présents', async () => {
    const used = await scanOf(['<script lang="coffee">', '@tag = \'div\'', '</script>', '<@element $tag>x</@element>'].join('\n'), 'f13')
    assert.ok(used.has('dynamic'))
    assert.ok(used.has('effect'))
  })

  it('µemit(...) : "emit" présent', async () => {
    const used = await scanOf('<script lang="coffee">\n@go = ->\n  µemit(\'x\', 1)\n</script>\n<p>y</p>\n', 'f14')
    assert.ok(used.has('emit'))
  })

  it('@click.emit.x : "emit" présent', async () => {
    const used = await scanOf('<p @click.emit.x>y</p>\n', 'f15')
    assert.ok(used.has('emit'))
  })

  it('µon \'evt\', sel, fn : "on" présent', async () => {
    const used = await scanOf('<script lang="coffee">\nµon \'evt\', \'p\', ->\n  1\n</script>\n<p>y</p>\n', 'f16')
    assert.ok(used.has('on'))
  })

  it('@title="x" : "title" présent', async () => {
    const used = await scanOf('<p @title="x">y</p>\n', 'f17')
    assert.ok(used.has('title'))
  })

  it('µplay/µminmax/µinspect/µraw/µsnap : "rare_runes" présent (5 formes)', async () => {
    const formes = [
      '<script lang="coffee">\n@go = ->\n  µplay($el, \'x\')\n</script>\n<p>y</p>\n',
      '<script lang="coffee">\n@go = ->\n  µminmax(1, 0, 10)\n</script>\n<p>y</p>\n',
      '<script lang="coffee">\nµinspect(\'x\')\n</script>\n<p>y</p>\n',
      '<script lang="coffee">\n@go = ->\n  µraw($el)\n</script>\n<p>y</p>\n',
      '<script lang="coffee">\n$x =: 1 + 1\n</script>\n<p>{$x}</p>\n',
    ]
    for (const src of formes) {
      const used = await scanOf(src, 'f18')
      assert.ok(used.has('rare_runes'), src)
    }
  })

  it('new µStore({...}) : "store" présent', async () => {
    const used = await scanOf('<script lang="coffee">\n@box = new µStore({a: 1})\n</script>\n<p>{@box.data.a}</p>\n', 'f19')
    assert.ok(used.has('store'))
  })

  it('µinterpolate(0, 400) : "interpolate" présent', async () => {
    const used = await scanOf('<script lang="coffee">\n$p = µinterpolate(0, 400)\n</script>\n<p>{$p}</p>\n', 'f20')
    assert.ok(used.has('interpolate'))
  })

  it('new µTicker() : "ticker" présent', async () => {
    const used = await scanOf('<script lang="coffee">\n@t = new µTicker()\n</script>\n<p>y</p>\n', 'f21')
    assert.ok(used.has('ticker'))
  })

  it('µevery 1000, -> : "every" présent, "effect" ABSENT (aucun émetteur indirect)', async () => {
    const used = await scanOf('<script lang="coffee">\n@x = 1\nµevery 1000, -> @x++\n</script>\n<p>{$x}</p>\n', 'f22')
    assert.ok(used.has('every'))
    assert.equal(used.has('effect'), false)
  })

  it('une CHAÎNE littérale \'µ.Store\' dans le script (jamais un usage réel) : "store" ABSENT — faux positif texte corrigé', async () => {
    const used = await scanOf('<script lang="coffee">\n@doc = \'µ.Store\'\n</script>\n<p>{@doc}</p>\n', 'f23b')
    assert.equal(used.has('store'), false, 'une chaîne qui MENTIONNE µ.Store ne doit plus embarquer mjs_store.ts')
  })

  it('un commentaire HTML <!-- {for x in xs} --> (jamais un vrai bloc) : "for" ABSENT — faux positif texte corrigé', async () => {
    const used = await scanOf('<!-- {for x in xs} -->\n<p>y</p>\n', 'f23c')
    assert.equal(used.has('for'), false, 'un commentaire qui MENTIONNE {for} ne doit plus embarquer mjs_for.ts')
  })

  it('<@failed err reset>...</@failed> (balise) : "failed" présent', async () => {
    const used = await scanOf(['<p>{1/0}</p>', '<@failed err reset>', '<p>Erreur : {err.message}</p>', '</@failed>'].join('\n'), 'f23')
    assert.ok(used.has('failed'))
  })

  it('µfailed (err, reset)-> (rune nue) : "failed" présent', async () => {
    const used = await scanOf('<script lang="coffee">\nµfailed (err, reset) ->\n  1\n</script>\n<p>y</p>\n', 'f24')
    assert.ok(used.has('failed'))
  })

  it('<style name="x"> (variant déclaré) : "layout_variant" présent (data.layoutCss non vide)', async () => {
    const used = await scanOf(['<style name="banner">', '  :host', '    display: flex', '</style>', '<div>x</div>'].join('\n'), 'f25')
    assert.ok(used.has('layout_variant'))
  })

  it('layout="x" en dur, SANS aucune déclaration <style name> : "layout_variant" quand même présent (texte survit dans le HTML compilé)', async () => {
    const used = await scanOf('<p layout="bandeau">x</p>\n', 'f26')
    assert.ok(used.has('layout_variant'))
  })

  it('@persist $x (jamais le mot « effect » dans le source) : "effect" présent', async () => {
    const used = await scanOf(['<script>$x = 1</script>', '@persist $x', '<p>{$x}</p>'].join('\n'), 'f27')
    assert.ok(used.has('effect'))
  })

  it('composant qui ne pose RIEN : Set vide (aucun faux positif de base)', async () => {
    const used = await scanOf('<p>x</p>\n', 'f28')
    assert.equal(used.size, 0)
  })

  it('var(--mjs-fg) écrit en dur dans un <style> : "theme" présent', async () => {
    const used = await scanOf(['<style>', ':host', '  color: var(--mjs-fg)', '</style>', '<p>x</p>'].join('\n'), 'f30')
    assert.ok(used.has('theme'))
  })

  it('$$surface lu dans un <style> : "theme" présent ($$ se réécrit en var(--mjs-surface) AVANT la compilation JS)', async () => {
    const used = await scanOf(['<style>', ':host', '  background: $$surface', '</style>', '<p>x</p>'].join('\n'), 'f31')
    assert.ok(used.has('theme'))
  })

  it("µtheme = 'dark' (rune, forme documentée <button @click={...}>) : \"theme\" présent (__mjsTheme)", async () => {
    const used = await scanOf('<button @click={µtheme = \'dark\'}>x</button>\n', 'f32')
    assert.ok(used.has('theme'))
  })

  it('$$brand (nom hors des 8 variables canoniques du framework) : "theme" ABSENT — thème de PROJET, pas le thème clair/sombre embarqué', async () => {
    const used = await scanOf(['<style>', ':host', '  color: $$brand', '</style>', '<p>x</p>'].join('\n'), 'f33')
    assert.equal(used.has('theme'), false)
  })

  it('module de script SANS data (2e argument omis) : ne lève jamais, layout_variant lu sur le texte seul', async () => {
    const { output } = await transpile('<script lang="coffee">\n@go = ->\n  µplay($el, \'x\')\n</script>\n<p>y</p>\n', { moduleName: 'f29' })
    const used = scanCompiledFeatures(output)
    assert.ok(used.has('rare_runes'))
  })

  it('SCAN_KEYS liste exactement les 21 clés historiques + "theme" + "html" + "slots" + "deep"/"textpool"/"esc"/"for_nested"/"alias"', () => {
    const attendues = ['title', 'store', 'interpolate', 'ticker', 'head', 'body', 'dynamic', 'failed', 'rare_runes', 'on', 'effect', 'every', 'for', 'if', 'key', 'await', 'emit', 'context', 'lifecycle', 'layout_variant', 'destroy_hooks', 'theme', 'html', 'slots', 'deep', 'textpool', 'esc', 'for_nested', 'alias']
    assert.deepEqual([...SCAN_KEYS].sort(), [...attendues].sort())
  })

  it('composant porteur d\'un alias court : "alias" présent', async () => {
    const { output, data } = await transpile('<script>$x=1</script><p>{$x}</p>', { moduleName: 'doc-carte', aliasTag: 'mjs-carte' })
    assert.ok(scanCompiledFeatures(output, data).has('alias'))
  })

  it('composant SANS alias court : "alias" absent — aucun appel émis', async () => {
    const used = await scanOf('<script>$x=1</script><p>{$x}</p>', 'carte')
    assert.equal(used.has('alias'), false)
  })

  it('<@slot> (défaut, nommé, indexé dans {for}) : "slots" présent', async () => {
    const formes = [
      '<div><@slot/></div>\n',
      '<header><@slot titre/></header>\n',
      '<script>\n$items = [1, 2]\n</script>\n<div>{for i, t in $items}<@slot {i}/>{end}</div>\n'
    ]
    for (const src of formes) {
      const used = await scanOf(src, 'f38')
      assert.ok(used.has('slots'), src)
    }
  })

  it('<@slot> apporté par un partiel <@include> : "slots" présent', async () => {
    const dir = mjsTmp('scan-slots-include')
    writeFileSync(join(dir, '_fente.mjs'), '<div><@slot/></div>\n')
    const used = await scanOf('<@include fente>\n', 'f39', dir)
    assert.ok(used.has('slots'))
  })

  it('sans <@slot> (un <slot> natif écrit à la main compris) : "slots" absent', async () => {
    for (const src of ['<p>x</p>\n', '<div><slot></slot></div>\n']) {
      const used = await scanOf(src, 'f40')
      assert.equal(used.has('slots'), false, src)
    }
  })

  // interpolation brute `{{…}}` : la méthode `_mjs_updHtml` n'est appelée QUE par le code émis au
  // niveau du composant (effet `this._mjs_updHtml('tN', …)`) — racine, {if}/{else}, {key}, contenu
  // de <@slot>, contenu passé à un enfant, partiel <@include>. Dans un {for}, la ligne écrit
  // `innerHTML` elle-même ; dans un {await}, la branche construit son nœud elle-même : aucune
  // des deux formes n'a besoin de la méthode.
  it('{{…}} à la racine, dans {if}/{else}, {key}, <@slot>, le contenu d\'un enfant : "html" présent', async () => {
    const formes = [
      RAW_STATE + '<p>{{$h}}</p>\n',
      RAW_STATE + '{if $ok}<p>{{$h}}</p>{end}\n',
      RAW_STATE + '{if not $ok}<p>n</p>{else}<p>{{$h}}</p>{end}\n',
      RAW_STATE + '{key $k}<p>{{$h}}</p>{end}\n',
      RAW_STATE + '<div><@slot>{{$h}}</@slot></div>\n',
      RAW_STATE + '<@carte>{{$h}}</@carte>\n'
    ]
    for (const src of formes) {
      const used = await scanOf(src, 'f34')
      assert.ok(used.has('html'), src)
    }
  })

  it('{{…}} apporté par un partiel <@include> : "html" présent', async () => {
    const dir = mjsTmp('scan-html-include')
    writeFileSync(join(dir, '_bloc.mjs'), '<div>{{$h}}</div>\n')
    const used = await scanOf(RAW_STATE + '<@include bloc>\n', 'f35', dir)
    assert.ok(used.has('html'))
  })

  it('{{…}} SEULEMENT dans {for} ou {await} (écriture en ligne, nœud construit par la branche) : "html" absent — aucun appel émis', async () => {
    const formes = [
      RAW_STATE + '{for it in $items}<p>{{$h}}</p>{end}\n',
      RAW_STATE + '{for it in $items}{if $ok}<p>{{it}}</p>{end}{end}\n',
      RAW_STATE + '{await $p}<p>{{$h}}</p>{success v}<p>{{v}}</p>{error err}<p>{{err.message}}</p>{end}\n'
    ]
    for (const src of formes) {
      const { output } = await transpile(src, { moduleName: 'f36' })
      assert.equal(/\._mjs_updHtml\(/.test(output), false, src)
      assert.equal(scanCompiledFeatures(output).has('html'), false, src)
    }
  })

  it('composant sans {{…}} : "html" absent', async () => {
    const used = await scanOf(RAW_STATE + '<p>{$h}</p>\n', 'f37')
    assert.equal(used.has('html'), false)
  })

})
