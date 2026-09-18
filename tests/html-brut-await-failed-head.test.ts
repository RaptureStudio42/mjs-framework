// `{{…}}` (HTML brut) rendu en TEXTE dans trois endroits où `{…}` marche : les branches d'un
// `{await}`, le repli d'un `<@failed>` et le contenu d'un `<@head>`.
//
// - `{await}` : le générateur écrivait `${expr}` pour `{…}` comme pour `{{…}}` (compile.ts,
//   contexte 'await') — la valeur finissait dans un nœud texte, balises affichées telles quelles.
// - `<@failed>`/`<@head>` : `buildHeadInjection` (transpiler/macros.ts) ne connaissait que `{expr}` —
//   dans `{{$h}}` il prenait le `{$h}` intérieur, l'échappait, et laissait les deux accolades
//   extérieures en texte autour.
//
// `{…}` doit rester échappé partout (garde XSS du repli et de la tête) : vérifié en regard. Dans
// une balise (valeur d'attribut, avec ou sans guillemets), `{{…}}` n'est PAS du HTML : il reste
// échappé et mis entre guillemets, sinon `content={{$x}}` laissait une valeur venue d'ailleurs
// ouvrir une balise ou ajouter un attribut `onerror`. La lecture « dans une balise » ne doit pas se
// laisser dérouter par une apostrophe d'un commentaire ou d'une valeur sans guillemets.
// Montage happy-dom, construction de développement : le correctif est dans le compilateur, le code
// minifié en hérite (happy-dom ne charge pas un découpage minifié, cf. bundler-mangle-noms-instance).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness } from '../src/testing/index.js'
import { mjsTmp } from './helpers/tmp.js'

const AWAIT_PENDING = [
  '<script>',
  '$h = \'<b class="gras">brut</b>\'',
  '$p = window.__hbPending',
  '</script>',
  '',
  '{await $p}',
  '<p class="pending">{{$h}}</p>',
  '{success v}',
  '<p class="done">fini</p>',
  '{end}',
].join('\n')

const AWAIT_SUCCESS = [
  '<script>',
  '$p = window.__hbSuccess',
  '</script>',
  '',
  '{await $p}',
  '<p class="pending">attente</p>',
  '{success v}',
  '<p class="done">{{v}}</p>',
  '<p class="done-txt">{v}</p>',
  '{if v}<p class="cond">{{v}}</p>{end}',
  '{end}',
].join('\n')

const AWAIT_ERROR = [
  '<script>',
  '$p = window.__hbError',
  '</script>',
  '',
  '{await $p}',
  '<p class="pending">attente</p>',
  '{success v}',
  '<p class="done">fini</p>',
  '{error err}',
  '<p class="fail">{{err.message}}</p>',
  '{end}',
].join('\n')

const FAILED = [
  '<script>',
  '$h = \'<b class="gras">brut</b>\'',
  'boom = -> throw new Error(\'<u class="souligne">raté</u>\')',
  '</script>',
  '',
  '<@failed err>',
  '  <span class="fb-apos" title=l\'erreur>x</span>',
  '  <div class="fb">{{$h}}</div>',
  '  <div class="fb-err">{{err.message}}</div>',
  '  <div class="fb-txt">{err.message}</div>',
  '  <div class="fb-attr" title={{err.message}}>a</div>',
  '  <div class="fb-quoted" title="z {{err.message}}">b</div>',
  '</@failed>',
  '<p class="ok">{boom()}</p>',
].join('\n')

const HEAD = [
  '<script>',
  '$h = \'<meta name="mjs-hb-brut" content="un">\'',
  '$t = \'<i>texte</i>\'',
  '$evil = \'x onload=alert(1) "><img class="evil" src=x>\'',
  '</script>',
  '',
  '<@head>',
  '  <!-- aujourd\'hui -->',
  '  {{$h}}',
  '  <meta name="mjs-hb-texte" content={$t}>',
  '  <meta name="mjs-hb-attr" content={{$evil}}>',
  '  <meta name="mjs-hb-quoted" content="z {{$evil}}">',
  '</@head>',
  '',
  '<button class="swap" @click={$h = \'<meta name="mjs-hb-brut" content="deux">\'}>swap</button>',
].join('\n')

function projetTemporaire(): string {
  const root   = mjsTmp('html-brut')
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'tst-hb-await-pending.mjs'), AWAIT_PENDING)
  writeFileSync(join(srcDir, 'tst-hb-await-success.mjs'), AWAIT_SUCCESS)
  writeFileSync(join(srcDir, 'tst-hb-await-error.mjs'), AWAIT_ERROR)
  writeFileSync(join(srcDir, 'tst-hb-failed.mjs'), FAILED)
  writeFileSync(join(srcDir, 'tst-hb-head.mjs'), HEAD)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js' }, null, 2))
  return root
}

// deux tours de minuteur : la promesse se règle, puis le rendu de la branche passe
async function settle(c: any): Promise<void> {
  await c.tick()
  await c.tick()
}

describe('{{…}} dans {await}, <@failed> et <@head>', function () {
  this.timeout(60000)

  let app: any

  before(async () => {
    app = await createHarness({ root: projetTemporaire() })
  })

  after(async () => {
    if (app) await app.destroy()
  })

  it('{await} branche d\'attente : {{…}} pose des balises', async () => {
    app.window.__hbPending = new Promise(() => {})
    const c = await app.mount('tst-hb-await-pending')
    await settle(c)
    assert.equal(c.find('.pending b.gras') !== null, true, `rendu : ${c.html()}`)
    assert.equal(c.text('.pending'), 'brut')
    c.destroy()
  })

  it('{await} branche de succès : {{v}} pose des balises, {v} reste du texte, {{v}} sous un {if} aussi', async () => {
    app.window.__hbSuccess = Promise.resolve('<i class="penche">résolu</i>')
    const c = await app.mount('tst-hb-await-success')
    await settle(c)
    assert.equal(c.find('.done i.penche') !== null, true, `rendu : ${c.html()}`)
    assert.equal(c.text('.done'), 'résolu')
    assert.equal(c.find('.done-txt i') === null, true, `{v} doit rester échappé : ${c.html()}`)
    assert.equal(c.text('.done-txt'), '<i class="penche">résolu</i>')
    assert.equal(c.find('.cond i.penche') !== null, true, `rendu : ${c.html()}`)
    c.destroy()
  })

  it('{await} branche d\'erreur : {{err.message}} pose des balises', async () => {
    const rejet = Promise.reject(new Error('<u class="souligne">raté</u>'))
    rejet.catch(() => {})
    app.window.__hbError = rejet
    const c = await app.mount('tst-hb-await-error')
    await settle(c)
    assert.equal(c.find('.fail u.souligne') !== null, true, `rendu : ${c.html()}`)
    assert.equal(c.text('.fail'), 'raté')
    c.destroy()
  })

  it('<@failed> : {{…}} pose des balises, {…} reste échappé', async () => {
    const c = await app.mount('tst-hb-failed')
    await settle(c)
    assert.equal(c.find('.fb b.gras') !== null, true, `rendu : ${c.html()}`)
    assert.equal(c.text('.fb'), 'brut')
    assert.equal(c.find('.fb-err u.souligne') !== null, true, `rendu : ${c.html()}`)
    assert.equal(c.text('.fb-err'), 'raté')
    assert.equal(c.find('.fb-txt u') === null, true, `{err.message} doit rester échappé : ${c.html()}`)
    assert.equal(c.text('.fb-txt'), '<u class="souligne">raté</u>')
    const attr   = c.find('.fb-attr')
    const quoted = c.find('.fb-quoted')
    assert.equal(attr.getAttribute('title'), '<u class="souligne">raté</u>', `rendu : ${c.html()}`)
    assert.equal(attr.getAttributeNames().join(','), 'class,title', `rendu : ${c.html()}`)
    assert.equal(quoted.getAttribute('title'), 'z <u class="souligne">raté</u>', `rendu : ${c.html()}`)
    assert.equal(c.findAll('.fb-attr u, .fb-quoted u').length, 0)
    c.destroy()
  })

  it('<@head> : {{…}} injecte des balises (et suit l\'état), {…} reste échappé', async () => {
    const c    = await app.mount('tst-hb-head')
    await settle(c)
    const head = app.document.head
    const brut = head.querySelector('meta[name="mjs-hb-brut"]')
    assert.equal(brut !== null, true, `tête : ${head.innerHTML}`)
    assert.equal(brut.getAttribute('content'), 'un')
    assert.equal(head.innerHTML.includes('{'), false, `aucune accolade laissée en texte : ${head.innerHTML}`)
    assert.equal(head.querySelector('meta[name="mjs-hb-texte"]').getAttribute('content'), '<i>texte</i>')
    const evil   = 'x onload=alert(1) "><img class="evil" src=x>'
    const attr   = head.querySelector('meta[name="mjs-hb-attr"]')
    const quoted = head.querySelector('meta[name="mjs-hb-quoted"]')
    assert.equal(attr !== null && quoted !== null, true, `tête : ${head.innerHTML}`)
    assert.equal(attr.getAttribute('content'), evil, `tête : ${head.innerHTML}`)
    assert.equal(attr.getAttributeNames().join(','), 'name,content', `tête : ${head.innerHTML}`)
    assert.equal(quoted.getAttribute('content'), `z ${evil}`, `tête : ${head.innerHTML}`)
    assert.equal(app.document.querySelectorAll('img.evil').length, 0, `tête : ${head.innerHTML}`)
    await c.click('.swap')
    await settle(c)
    const apres = head.querySelectorAll('meta[name="mjs-hb-brut"]')
    assert.equal(apres.length, 1, `tête : ${head.innerHTML}`)
    assert.equal(apres[0].getAttribute('content'), 'deux')
    c.destroy()
  })
})
