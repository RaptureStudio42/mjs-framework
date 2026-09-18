// paths-compact — chemins de nœuds compacts dans le code COMPILÉ.
//
// Les fonctions de construction retrouvaient leurs nœuds par des chaînes de propriétés
// (`_f.firstChild.nextSibling.nextSibling.firstChild…`) et matérialisaient leurs marqueurs par un
// bloc de quatre instructions. Sur une page réelle, ces deux motifs pèsent ~2 Ko de source livrée.
// Les helpers `µ._p` (i-ème enfant, chaîne d'index) et `µ._tm` (marqueur texte) disent la même
// chose en trois fois moins d'octets.
//
// RÈGLE DE POSE : jamais dans le gabarit de ligne d'un `{for}`. Ce corps-là tourne 1 000 fois sur
// une création de liste ; il garde ses chaînes de propriétés directes, sans appel de fonction.
// Racine du composant et branches `{if}`/`{await}`/`{key}` (construites une fois) prennent la
// forme compacte.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { transpile } from '../src/transpiler/index.js'
import { createHarness } from '../src/testing/index.js'
import { mjsTmp } from './helpers/tmp.js'

// composant à imbrication profonde : racine, branche `{if}` et gabarit de ligne `{for}`
// produisent chacun des chemins de plusieurs marches
const PROFOND = [
  '<script>',
  '$titre ?= "t"',
  '$ouvert ?= true',
  '$lignes ?= [{ id: 1, nom: "a" }]',
  '</script>',
  '',
  '<div class="a"><div class="b"><section><header><h1><span class="deep">{$titre}</span></h1></header>',
  '<article><p>x</p><p>y</p><p><em><b class="cible">{$titre}</b></em></p></article></section></div></div>',
  '{if $ouvert}<div class="w1"><div class="w2"><div class="w3"><span class="in">{$titre}</span></div></div></div>{else}<p class="off">non</p>{end}',
  '<table><tbody>{for l in $lignes}<tr><td class="c1"><a class="lnk">{l.nom}</a></td><td class="c2"><span><b>{l.id}</b></span></td></tr>{end}</tbody></table>',
].join('\n')

// corps de la fonction de construction qui clone le template commençant par `debutHtml`,
// de l'appel `µ._mjs_cloneTpl` jusqu'au `return` qui rend le fragment
function corpsDeConstruction(sortie: string, debutHtml: string): string {
  const debut = sortie.indexOf('µ._mjs_cloneTpl("' + debutHtml)
  assert.notEqual(debut, -1, 'template introuvable dans la sortie compilée : ' + debutHtml)
  const fin = sortie.indexOf('return { fragment: _f', debut)
  assert.notEqual(fin, -1, 'fin de fonction introuvable pour le template : ' + debutHtml)
  return sortie.slice(debut, fin)
}

describe('chemins de nœuds compacts dans le code compilé', () => {

  let sortie: string

  before(async () => {
    sortie = (await transpile(PROFOND, { moduleName: 'tst-compact-profond' })).output
  })

  it('la racine retrouve ses nœuds profonds par µ._p au lieu d\'une chaîne de propriétés', () => {
    const racine = corpsDeConstruction(sortie, "<div class='a'>")
    assert.ok(racine.includes('µ._p('), 'la racine devrait utiliser µ._p')
    assert.equal(racine.includes('.firstChild.nextSibling.nextSibling'), false,
      'plus aucune chaîne de trois marches ou plus à la racine')
  })

  it('la racine matérialise ses marqueurs par µ._tm au lieu d\'un bloc replaceChild', () => {
    const racine = corpsDeConstruction(sortie, "<div class='a'>")
    assert.ok(racine.includes('µ._tm('), 'les marqueurs de la racine devraient passer par µ._tm')
    assert.equal(racine.includes('replaceChild'), false, 'plus de replaceChild écrit en toutes lettres')
  })

  it('une branche {if} utilise µ._p', () => {
    const branche = corpsDeConstruction(sortie, "<div class='w1'>")
    assert.ok(branche.includes('µ._p('), 'la branche {if} devrait utiliser µ._p')
  })

  it('le gabarit de ligne d\'un {for} garde ses chaînes de propriétés directes', () => {
    const ligne = corpsDeConstruction(sortie, '<tr>')
    assert.equal(ligne.includes('µ._p('), false, 'aucun µ._p dans un gabarit de ligne')
    assert.equal(ligne.includes('µ._tm('), false, 'aucun µ._tm dans un gabarit de ligne')
    assert.ok(ligne.includes('.firstChild'), 'la ligne navigue toujours par firstChild/nextSibling')
  })
})

// ────────────────────────────────────────────────────────────────────────────────────────────
// Montage réel (happy-dom, harnais src/testing) : le code compact doit rendre le MÊME DOM que
// les chaînes de propriétés, et pointer les mêmes nœuds. Les markups attendus ci-dessous sont
// ceux que produisait l'écriture longue, relevés avant la bascule.
// ────────────────────────────────────────────────────────────────────────────────────────────

const PROFOND_MJS = [
  '<script>',
  '$titre ?= \'alpha\'',
  '$ouvert ?= true',
  '$lignes ?= [{ id: 1, nom: \'un\' }, { id: 2, nom: \'deux\' }]',
  '</script>',
  '',
  '<div class="a"><div class="b"><section><header><h1><span class="deep">{$titre}</span></h1></header>',
  '<article><p>x</p><p>y</p><p><em><b class="cible">{$titre}</b></em></p></article></section></div></div>',
  '{if $ouvert}<div class="w1"><div class="w2"><div class="w3"><span class="in">{$titre}</span></div></div></div>{else}<p class="off">non</p>{end}',
  '<table><tbody>{for l in $lignes}<tr><td class="c1"><a class="lnk">{l.nom}</a></td><td class="c2"><span><b>{l.id}</b></span></td></tr>{end}</tbody></table>',
  '<button class="maj" @click={$titre = \'beta\'}>maj</button>',
  '<button class="bascule" @click={$ouvert = !$ouvert}>bascule</button>',
  '',
].join('\n')

const ATTENTE_MJS = [
  '<script>',
  '$p ?= null',
  '</script>',
  '',
  '<div class="boite"><div class="inner">{await $p}<p class="pending">chargement</p>{success v}<p class="done">{v}</p>{error err}<p class="fail">{err.message}</p>{end}</div></div>',
  '<button class="go" @click={$p = Promise.resolve(\'ok\')}>go</button>',
  '',
].join('\n')

const TETE = '<div class="a"><div class="b"><section><header><h1><span class="deep">TITRE</span></h1></header><article><p>x</p><p>y</p><p><em><b class="cible">TITRE</b></em></p></article></section></div></div>'
const LISTE = '<table><tbody><tr><td class="c1"><a class="lnk">un</a></td><td class="c2"><span><b>1</b></span></td></tr><tr><td class="c1"><a class="lnk">deux</a></td><td class="c2"><span><b>2</b></span></td></tr></tbody></table>'
const BOUTONS = '<button class="maj">maj</button><button class="bascule">bascule</button>'
const OUVERT = '<div class="w1"><div class="w2"><div class="w3"><span class="in">TITRE</span></div></div></div>'

const markup = (titre: string, branche: string): string =>
  (TETE + branche + LISTE + BOUTONS).split('TITRE').join(titre)

describe('chemins de nœuds compacts — montage réel', function () {
  this.timeout(60000)

  let app: any

  before(async () => {
    const racine = mjsTmp('paths-compact')
    mkdirSync(join(racine, 'src'), { recursive: true })
    writeFileSync(join(racine, 'src', 'tst-compact-profond.mjs'), PROFOND_MJS)
    writeFileSync(join(racine, 'src', 'tst-compact-attente.mjs'), ATTENTE_MJS)
    writeFileSync(join(racine, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js' }, null, 2))
    app = await createHarness({ root: racine })
  })

  after(async () => {
    if (app) await app.destroy()
  })

  it('un texte interpolé profond se met à jour au bon nœud, et le DOM reste celui de l\'écriture longue', async () => {
    const c = await app.mount('tst-compact-profond')
    assert.equal(c.html(), markup('alpha', OUVERT))
    assert.equal(c.text('.deep'), 'alpha')
    assert.equal(c.text('.cible'), 'alpha')
    assert.equal(c.text('.in'), 'alpha')
    await c.click('.maj')
    assert.equal(c.html(), markup('beta', OUVERT), 'seuls les trois textes changent, la structure est intacte')
    c.destroy()
  })

  it('les marqueurs {if} de la racine basculent de branche', async () => {
    const c = await app.mount('tst-compact-profond')
    assert.equal(c.findAll('.w1').length, 1)
    assert.equal(c.findAll('.off').length, 0)
    await c.click('.bascule')
    assert.equal(c.html(), markup('alpha', '<p class="off">non</p>'))
    await c.click('.bascule')
    assert.equal(c.html(), markup('alpha', OUVERT), 'le retour à la 1re branche reconstruit le même DOM')
    c.destroy()
  })

  it('les marqueurs {await} de la racine laissent la promesse résoudre jusqu\'à {success}', async () => {
    const c = await app.mount('tst-compact-attente')
    assert.equal(c.html(), '<div class="boite"><div class="inner"></div></div><button class="go">go</button>')
    await c.click('.go')
    assert.equal(c.html(), '<div class="boite"><div class="inner"><p class="done">ok</p></div></div><button class="go">go</button>')
    c.destroy()
  })
})
