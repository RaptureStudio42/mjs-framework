// assertSafeSvg() (3 motifs : `<script`,
// `on[a-z]+=`, `javascript:`) laisse passer — entité HTML décimale/hexadécimale dans un href
// (`&#106;avascript:`, `&#x6A;avascript:`), l'injection SMIL (`<set attributeName="onclick"
// to="…">`, `<animate attributeName="onmouseover" …>`), et `<foreignObject><iframe src="…">`.
//
// Correctif : normalise AVANT de tester (décodage entités numériques/nommées usuelles, puis
// TAB/LF/CR retirés dans une copie DÉDIÉE aux tests javascript:/data: — comme l'analyseur d'URL
// d'un navigateur), refuse en plus `data:text/html` (href/xlink:href/src), `<foreignObject>`,
// `<iframe>/<embed>/<object>`, et un `attributeName` visant `on…`/`href`/`xlink:href` sur
// `<set>/<animate>/<animateTransform>/<animateMotion>`. Les animations SMIL sur `d`/`opacity`/
// `transform`… restent permises. Le faux positif `<script>` en commentaire XML reste accepté
// (comme aujourd'hui, cf. tests/bundler-svg-script-refuse.test.ts).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  return { srcDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

async function tryAsset(prefix: string, svg: string) {
  const { srcDir, outDir, manifest } = makeProject(prefix)
  writeFileSync(join(srcDir, 'icone.svg'), svg)
  writeFileSync(join(srcDir, 'app.mjs'), `<div>{µasset('icone.svg')}</div>`)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
  const stats = await bundler.compile()
  const copie = readdirSync(outDir).some(f => /^icone-/.test(f))
  await bundler.close()
  return { stats, copie }
}

describe('bundler — vecteurs SVG additionnels refusés', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('(B) entité HTML DÉCIMALE dans un href : &#106;avascript:alert(1) → refusé, rien copié', async function () {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="&#106;avascript:alert(1)"><rect width="5" height="5"/></a></svg>'
    const { stats, copie } = await tryAsset('svg-entite-decimale', svg)
    assert.ok(stats.errors.length > 0, 'AVANT le fix : le \'j\' encodé en décimal passait les 3 motifs intacts')
    assert.match(stats.errors.map(e => e.message).join('\n'), /icone\.svg/)
    assert.ok(!copie, 'rien ne doit être copié dans outputDir')
  })

  it('entité HTML HEXADÉCIMALE dans un href : &#x6A;avascript:alert(1) → refusé', async function () {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="&#x6A;avascript:alert(1)"><rect width="5" height="5"/></a></svg>'
    const { stats, copie } = await tryAsset('svg-entite-hex', svg)
    assert.ok(stats.errors.length > 0, "AVANT le fix : le 'j' encodé en hexadécimal passait les 3 motifs intacts")
    assert.ok(!copie)
  })

  it("(C) SMIL <set attributeName=\"onclick\" to=\"…\"> : refusé, aucun <script>/on*=/javascript: littéral", async function () {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"><set attributeName="onclick" to="alert(document.domain)" begin="0s"/></rect></svg>'
    const { stats, copie } = await tryAsset('svg-smil-set-onclick', svg)
    assert.ok(stats.errors.length > 0, 'AVANT le fix : injection SMIL <set> jamais détectée')
    assert.match(stats.errors.map(e => e.message).join('\n'), /attributeName/)
    assert.ok(!copie)
  })

  it("SMIL <animate attributeName=\"onmouseover\" …> : refusé", async function () {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"><animate attributeName="onmouseover" to="alert(1)" begin="0s" dur="1s"/></rect></svg>'
    const { stats, copie } = await tryAsset('svg-smil-animate-onmouseover', svg)
    assert.ok(stats.errors.length > 0, 'AVANT le fix : injection SMIL <animate> jamais détectée')
    assert.ok(!copie)
  })

  it('SMIL <set attributeName="href" to="javascript:…"> et attributeName="xlink:href" : refusés', async function () {
    const r1 = await tryAsset('svg-smil-href', '<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="alert(1)" begin="0s"/><rect width="5" height="5"/></a></svg>')
    assert.ok(r1.stats.errors.length > 0, 'attributeName="href" doit être refusé')
    const r2 = await tryAsset('svg-smil-xlink-href', '<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="xlink:href" to="alert(1)" begin="0s"/><rect width="5" height="5"/></a></svg>')
    assert.ok(r2.stats.errors.length > 0, 'attributeName="xlink:href" doit être refusé')
  })

  it('(D) <foreignObject><iframe src="https://…"> : refusé', async function () {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><foreignObject width="100" height="100"><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://attacker.example/payload.html" width="100" height="100"></iframe></foreignObject></svg>'
    const { stats, copie } = await tryAsset('svg-foreignobject-iframe', svg)
    assert.ok(stats.errors.length > 0, 'AVANT le fix : foreignObject/iframe jamais détectés')
    assert.ok(!copie)
  })

  it('<embed>/<object> nus (hors foreignObject) : refusés', async function () {
    const r1 = await tryAsset('svg-embed-nu', '<svg xmlns="http://www.w3.org/2000/svg"><embed src="https://attacker.example/x"/></svg>')
    assert.ok(r1.stats.errors.length > 0, '<embed> doit être refusé')
    const r2 = await tryAsset('svg-object-nu', '<svg xmlns="http://www.w3.org/2000/svg"><object data="https://attacker.example/x"></object></svg>')
    assert.ok(r2.stats.errors.length > 0, '<object> doit être refusé')
  })

  it("(G) data:text/html dans un href : refusé — data:image/png (icône légitime) reste ACCEPTÉ", async function () {
    const mauvais = await tryAsset('svg-data-text-html', '<svg xmlns="http://www.w3.org/2000/svg"><a href="data:text/html,<script>alert(1)</script>"><rect width="5" height="5"/></a></svg>')
    assert.ok(mauvais.stats.errors.length > 0, 'data:text/html doit être refusé')
    const bon = await tryAsset('svg-data-image-png', '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgo="/></svg>')
    assert.equal(bon.stats.errors.length, 0, `data:image/png (icône encodée, légitime) ne doit jamais être refusé : ${bon.stats.errors.map(e => e.message).join('\n')}`)
  })

  it('(H) java\\tscript: (tabulation dans le schéma, comme un analyseur d\'URL de navigateur) : refusé', async function () {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="java\tscript:alert(1)"><rect width="5" height="5"/></a></svg>'
    const { stats, copie } = await tryAsset('svg-tab-scheme', svg)
    assert.ok(stats.errors.length > 0, "AVANT le fix : une tabulation dans 'javascript:' évadait le motif littéral")
    assert.ok(!copie)
  })

  it('(I) icône SMIL LÉGITIME (<animate attributeName="opacity">, <animateTransform attributeName="transform">) : ACCEPTÉE', async function () {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" opacity="0"><animate attributeName="opacity" from="0" to="1" dur="1s"/><animateTransform attributeName="transform" type="rotate" from="0 5 5" to="360 5 5" dur="2s" repeatCount="indefinite"/></rect></svg>'
    const { stats, copie } = await tryAsset('svg-smil-legitime', svg)
    assert.equal(stats.errors.length, 0, `une icône animée légitime (opacity/transform) ne doit jamais être refusée : ${stats.errors.map(e => e.message).join('\n')}`)
    assert.ok(copie, 'icone-<hash>.svg doit être écrit normalement')
  })

  it("(F) <script> DANS UN COMMENTAIRE XML : jugé COMME AUJOURD'HUI (faux positif accepté, inchangé)", async function () {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><!-- <script>alert(1)</script> --><rect width="5" height="5"/></svg>'
    const { stats, copie } = await tryAsset('svg-script-commentaire', svg)
    assert.ok(stats.errors.length > 0, 'comportement inchangé : le faux positif reste bloqué')
    assert.ok(!copie)
  })

  it('un SVG propre (icône réelle, sans aucun motif) continue à être copié normalement', async function () {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="lemon"/></svg>'
    const { stats, copie } = await tryAsset('svg-propre-e13', svg)
    assert.equal(stats.errors.length, 0, `un SVG propre ne doit jamais échouer : ${stats.errors.map(e => e.message).join('\n')}`)
    assert.ok(copie)
  })
})
