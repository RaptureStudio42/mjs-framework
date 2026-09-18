// mjs_devinspect — l'inspecteur d'objets générique, dans la page (développement seulement).
//
// Ce qu'on verrouille ici : dépliage récursif, cas durs de types (cyclique, Map, Set, tableau,
// nœud DOM, fonction, null/undefined, chaîne longue, symbole), le plafond de 200 entrées,
// l'édition RÉELLE de l'objet source (y compris imbriqué, racine scalaire lecture seule),
// l'échappement HTML, µ.devObject sans héritage de pli entre deux appels, et les bascules du
// panneau (µ.devPanel bascule/true/false/sélecteur, Échap, bouton fermer, onglets État/Contexte).
//
// Pipeline RÉEL (Bundler → core compilé puis chargé dans happy-dom), jamais une copie recodée
// à la main de l'inspecteur : mjs_devinspect/mjs_devpanel sont embarqués dans le bundle CORE
// dès qu'on n'est pas en production (cf. tests/devpanel.test.ts).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { stripEsm } from '../src/server/renderToString.js'
import { assertAbsent } from './helpers/dom-assert.js'
import { mjsTmp } from './helpers/tmp.js'

const NEUTRE = [
  '<script>',
  '$x ?= 1',
  '</script>',
  '<p>{$x}</p>',
].join('\n')

async function compilerCore() {
  const root   = mjsTmp('devinspect')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'di-neutre.mjs'), NEUTRE)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const files = readdirSync(outDir)
  const core  = readFileSync(join(outDir, files.find(f => /^mjs_core-/.test(f))!), 'utf-8')
  await bundler.close()
  return core
}

/** Fenêtre happy-dom fraîche avec le CORE (donc mjs_devinspect + mjs_devpanel) chargé. */
function fenetreAvecCore(core: string) {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${stripEsm(core)}\nglobalThis.µ = µ;`)
  return window
}

describe('mjs_devinspect — l\'inspecteur d\'objets', function () {
  this.timeout(60000)

  let core: string

  before(async () => { core = await compilerCore() })
  after(async () => { await terminateSharedWorkerPool() })

  function hote(window: any) {
    const div = window.document.createElement('div')
    window.document.body.appendChild(div)
    return div
  }

  it('dépliage récursif : l\'enfant n\'apparaît qu\'une fois déplié', function () {
    const window = fenetreAvecCore(core)
    const div = hote(window)
    const valeur = { a: { b: { texte: 'profond' } } }
    window.µ._mjs_diRender(div, valeur, { ns: 'depli' })

    // 'texte' est une chaîne ÉDITABLE : rendue en `<input value="…">`, jamais dans `textContent`
    // (un `<input>` n'a pas de nœud texte fils) — vérifier le champ, pas le texte de la div
    assert.equal(div.querySelectorAll('input.di-valeur[data-di-key="texte"]').length, 0, 'l\'enfant ne doit pas apparaître avant dépliage')

    // déplie 'a', puis 'a.b'
    div.querySelectorAll('.di-chevron')[0].dispatchEvent(new window.Event('click', { bubbles: true }))
    div.querySelectorAll('.di-chevron')[1].dispatchEvent(new window.Event('click', { bubbles: true }))
    const champTexte = div.querySelector('input.di-valeur[data-di-key="texte"]') as any
    assert.ok(champTexte, `l'enfant doit apparaître une fois déplié :\n${div.innerHTML}`)
    assert.equal(champTexte.value, 'profond')
  })

  it('référence CYCLIQUE : ne boucle pas à l\'infini, affichée « référence circulaire »', function () {
    const window = fenetreAvecCore(core)
    const div = hote(window)
    const a: any = { nom: 'boucle' }
    a.self = a
    window.µ._mjs_diRender(div, a, { ns: 'cyclique' })
    div.querySelectorAll('.di-chevron').forEach((b: any) => b.dispatchEvent(new window.Event('click', { bubbles: true })))
    const texte = div.textContent
    assert.match(texte, /référence circulaire/, `une référence cyclique doit s'arrêter, jamais boucler :\n${texte}`)
  })

  it('Map, Set, tableau, nœud DOM, fonction, null/undefined, chaîne longue, symbole', function () {
    const window = fenetreAvecCore(core)
    const div = hote(window)
    const noeud = window.document.createElement('span')
    // `_mjs_diKind` distingue Map/Set par `instanceof` : construits avec le `Map`/`Set` GLOBAL de
    // Node, ils tomberaient dans le générique `object` une fois passés dans le realm happy-dom
    // (deux constructeurs Map distincts). Toujours construire avec ceux de LA FENÊTRE testée
    const valeur = {
      unePlan: new window.Map([['clef', 1]]),
      unSet: new window.Set([1, 2, 3]),
      unTableau: [1, 2, 3],
      unNoeud: noeud,
      uneFonction: function nommee() {},
      unNull: null,
      unIndefini: undefined,
      uneLongueChaine: 'x'.repeat(200),
      unSymbole: Symbol('mon-symbole'),
    }
    window.µ._mjs_diRender(div, valeur, { ns: 'types-durs' })
    const texte = div.textContent

    assert.match(texte, /Map\(1\)/, texte)
    assert.match(texte, /Set\(3\)/, texte)
    assert.match(texte, /Array\(3\)/, texte)
    assert.match(texte, /<span>/, texte)
    assert.match(texte, /ƒ nommee/, texte)
    // `\bnull\b` piégeait sur la concaténation SANS séparateur des `<span>` voisins : la clé
    // `unNull` et le type `null` se touchent en texte brut → "unNullnull", jamais de frontière de
    // mot avant "null". Query le `.di-type` de la ligne concernée, sans ambiguïté de concaténation
    const ligneNull = Array.from(div.querySelectorAll('.di-ligne')).find((l: any) => l.querySelector('.di-cle')?.textContent === 'unNull') as any
    assert.ok(ligneNull, `la ligne 'unNull' doit exister :\n${div.innerHTML}`)
    assert.equal(ligneNull.querySelector('.di-type').textContent, 'null')
    assert.match(texte, /undefined/, texte)
    assert.match(texte, /Symbol\(mon-symbole\)/, texte)

    // chaîne longue = ÉDITABLE : rendue en `<input value="…">`, jamais tronquée (l'édition doit
    // porter sur la valeur EXACTE, pas un aperçu ellipsé) — vérifier le champ, pas `textContent`
    const champLongueChaine = div.querySelector('input.di-valeur[data-di-key="uneLongueChaine"]') as any
    assert.ok(champLongueChaine, `la chaîne longue doit rester éditable :\n${div.innerHTML}`)
    assert.equal(champLongueChaine.value, valeur.uneLongueChaine, 'la valeur éditable ne doit JAMAIS être tronquée')
  })

  it('plafond de 200 entrées : au-delà, l\'affichage est tronqué et le dit', function () {
    const window = fenetreAvecCore(core)
    const div = hote(window)
    const gros: any[] = []
    for (let i = 0; i < 250; i++) gros.push(i)
    window.µ._mjs_diRender(div, gros, { ns: 'plafond' })
    const texte = div.textContent
    assert.match(texte, /… et 50 de plus \(affichage plafonné à 200\)/, `le dépassement doit être annoncé :\n${texte}`)
    assert.equal(div.querySelectorAll('.di-ligne').length, 200, 'exactement 200 lignes rendues, jamais 250')
  })

  it('ÉDITION : modifier une valeur dans l\'inspecteur touche l\'objet RÉEL, y compris imbriqué', function () {
    const window = fenetreAvecCore(core)
    const div = hote(window)
    const objet: any = { nom: 'Alice', profil: { age: 30 } }
    window.µ._mjs_diRender(div, objet, { ns: 'edition' })

    // niveau racine
    const champNom = div.querySelector('input.di-valeur[data-di-key="nom"]')
    assert.ok(champNom, 'le champ nom doit exister')
    champNom.value = 'Bob'
    champNom.dispatchEvent(new window.Event('change', { bubbles: true }))
    assert.equal(objet.nom, 'Bob', 'l\'objet SOURCE doit porter la nouvelle valeur, pas juste l\'affichage')

    // niveau imbriqué : déplie 'profil' puis édite 'age'
    div.querySelector('.di-chevron').dispatchEvent(new window.Event('click', { bubbles: true }))
    const champAge = div.querySelector('input.di-valeur[data-di-key="age"]')
    assert.ok(champAge, 'le champ age imbriqué doit exister une fois déplié')
    champAge.value = '31'
    champAge.dispatchEvent(new window.Event('change', { bubbles: true }))
    assert.equal(objet.profil.age, 31, 'la mutation imbriquée doit atteindre l\'objet réel, pas un clone')

    // SABOTAGE documenté : `_diPoser` changé pour écrire sur une COPIE plutôt
    // que sur `conteneur[cle]` fait ROUGIR cette assertion (vérifié, puis remis à l'identique) —
    // preuve que le test surveille bien l'objet source, pas l'affichage
  })

  it('racine SCALAIRE reste en lecture seule', function () {
    const window = fenetreAvecCore(core)
    const div = hote(window)
    window.µ._mjs_diRender(div, 42, { ns: 'scalaire' })
    assert.equal(div.querySelectorAll('input.di-valeur').length, 0, 'une racine scalaire ne doit proposer aucun champ d\'édition')
    assert.match(div.textContent, /42/, div.textContent)
  })

  it('ÉCHAPPEMENT : une valeur contenant du markup ressort en TEXTE, jamais en éléments', function () {
    const window = fenetreAvecCore(core)
    const div = hote(window)
    const valeur = { piege: '<script>alert(1)</script>', autre: '<img onerror=alert(2) src=x>' }
    window.µ._mjs_diRender(div, valeur, { ns: 'echappement' })

    assert.equal(div.querySelectorAll('script').length, 0, 'aucun <script> réel ne doit être inséré')
    assert.equal(div.querySelectorAll('img').length, 0, 'aucun <img> réel ne doit être inséré')
    // le markup rentre dans l'attribut `value` d'un `<input>` : `<`/`>` n'ont PAS besoin d'être
    // échappés dans un attribut HTML (seuls `&` et `"` le sont) — le sérialiseur happy-dom les
    // laisse donc tels quels en relisant `innerHTML`, ce n'est pas une faille : la preuve de
    // sécurité tient déjà dans les deux assertions ci-dessus (aucun élément réel créé) plus
    // l'intégrité de la valeur, vérifiée ici sur le CHAMP, jamais interprétée comme du HTML
    const champPiege = div.querySelector('input.di-valeur[data-di-key="piege"]') as any
    assert.ok(champPiege, 'le champ piégé doit exister')
    assert.equal(champPiege.value, valeur.piege, `la valeur doit être préservée intacte, jamais interprétée :\n${div.innerHTML}`)

    // SABOTAGE documenté : remplacer `µ._esc(_mjs_diApercu(...))` par la valeur
    // brute dans `rendreLigne` fait ROUGIR cette assertion (vérifié, puis remis à l'identique) —
    // preuve que le test détecte vraiment une régression d'échappement, pas un faux vert
  })

  it('µ.devObject deux fois de suite : aucun héritage du pli du premier appel', function () {
    const window = fenetreAvecCore(core)
    // `texteProfond` est une chaîne ÉDITABLE : rendue en `<input value="…">`, jamais dans
    // `textContent` — vérifier le champ, pas le texte du panneau
    window.µ.devObject({ a: { texteProfond: 'PREMIER_PROFOND' } })
    const racine1 = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    racine1.querySelector('.di-chevron').dispatchEvent(new window.Event('click', { bubbles: true }))
    const champ1 = racine1.querySelector('input.di-valeur[data-di-key="texteProfond"]') as any
    assert.ok(champ1, `le premier objet doit être déplié :\n${racine1.innerHTML}`)
    assert.equal(champ1.value, 'PREMIER_PROFOND')

    window.µ.devObject({ a: { texteProfond: 'SECOND_PROFOND' } })
    const racine2 = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    assert.equal(racine2.querySelectorAll('input.di-valeur[data-di-key="texteProfond"]').length, 0, `le second appel ne doit PAS hériter du pli du premier :\n${racine2.innerHTML}`)
    window.µ.devPanel(false)
  })
})

const ENFANT = [
  '<script>',
  // `$couleur = §theme` (assignation top-level d'UNE expression) serait auto-dérivé (cf. règle
  // `$X = expr($Y)`) et finirait dans l'onglet Dérivés, pas État — on veut ici une variable
  // d'état PROPRE, initialisée depuis le contexte au montage, pas un calcul suivi
  '$couleur ?= \'\'',
  'µmount -> $couleur = §theme',
  '</script>',
  '<p class="c">{$couleur}</p>',
].join('\n')

const PARENT = [
  '<script>',
  "§theme = 'sombre'",
  '</script>',
  '<div>',
  '  <mjs-dpb-enfant></mjs-dpb-enfant>',
  '</div>',
].join('\n')

async function compilerArbre() {
  const root   = mjsTmp('devinspect-panel')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'dpb-enfant.mjs'), ENFANT)
  writeFileSync(join(srcDir, 'dpb-parent.mjs'), PARENT)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const files = readdirSync(outDir)
  const core  = readFileSync(join(outDir, files.find(f => /^mjs_core-/.test(f))!), 'utf-8')
  const enfant  = readFileSync(join(outDir, files.find(f => /^dpb-enfant-[a-f0-9]{8}\.js$/.test(f))!), 'utf-8')
  const parent  = readFileSync(join(outDir, files.find(f => /^dpb-parent-[a-f0-9]{8}\.js$/.test(f))!), 'utf-8')
  await bundler.close()
  return { core, enfant, parent }
}

function fenetreAvecArbre(bundle: { core: string, enfant: string, parent: string }) {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${stripEsm(bundle.core)}\nglobalThis.µ = µ;`)
  window.eval(stripEsm(bundle.enfant))
  window.eval(stripEsm(bundle.parent))
  return window
}

describe('mjs_devpanel — bascules et onglets (via l\'inspecteur)', function () {
  this.timeout(60000)

  let bundle: { core: string, enfant: string, parent: string }

  before(async () => { bundle = await compilerArbre() })
  after(async () => { await terminateSharedWorkerPool() })

  it('devPanel() bascule, (true) ouvre, (false) ferme', async function () {
    const window = fenetreAvecArbre(bundle)
    window.document.body.innerHTML = '<mjs-dpb-parent></mjs-dpb-parent>'
    await new Promise(r => setTimeout(r, 60))

    assert.equal(window.µ.devPanel(true), true, '(true) doit ouvrir')
    assert.ok(window.document.querySelector('[data-mjs-devpanel]'), 'le panneau doit être monté')
    assert.equal(window.µ.devPanel(true), true, '(true) sur un panneau déjà ouvert reste ouvert')

    assert.equal(window.µ.devPanel(false), false, '(false) doit fermer')
    assertAbsent(window.document.querySelector('[data-mjs-devpanel]'), 'le panneau doit être retiré')
    assert.equal(window.µ.devPanel(false), false, '(false) sur un panneau déjà fermé reste fermé')

    assert.equal(window.µ.devPanel(), true, 'sans argument, bascule vers ouvert')
    assert.equal(window.µ.devPanel(), false, 'sans argument, bascule vers fermé')
  })

  it('devPanel(sélecteur css) ouvre et sélectionne l\'instance visée', async function () {
    const window = fenetreAvecArbre(bundle)
    window.document.body.innerHTML = '<mjs-dpb-parent></mjs-dpb-parent>'
    await new Promise(r => setTimeout(r, 60))

    assert.equal(window.µ.devPanel('mjs-dpb-enfant'), true, 'un sélecteur doit ouvrir le panneau')
    const racine = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    assert.equal(racine.querySelector('.ligne[aria-selected="true"]').textContent, 'dpb-enfant·1', `l'instance visée par le sélecteur doit être surlignée sélectionnée :\n${racine.textContent}`)
    window.µ.devPanel(false)
  })

  it('Échap ferme le panneau', async function () {
    const window = fenetreAvecArbre(bundle)
    window.document.body.innerHTML = '<mjs-dpb-parent></mjs-dpb-parent>'
    await new Promise(r => setTimeout(r, 60))

    window.µ.devPanel(true)
    assert.ok(window.document.querySelector('[data-mjs-devpanel]'), 'ouvert avant Échap')
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
    assertAbsent(window.document.querySelector('[data-mjs-devpanel]'), 'Échap doit fermer le panneau')
  })

  it('aucun voile : la page reste visible et cliquable derrière le panneau', async function () {
    const window = fenetreAvecArbre(bundle)
    window.document.body.innerHTML = '<mjs-dpb-parent></mjs-dpb-parent>'
    await new Promise(r => setTimeout(r, 60))

    window.µ.devPanel(true)
    const racine = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    assertAbsent(racine.querySelector('.voile'), 'le panneau n\'est plus une modale : aucun voile ne doit couvrir la page')
    const panneau = racine.querySelector('.panneau')
    assert.ok(panneau, 'le panneau lui-même doit exister')
    assert.notEqual(panneau.getAttribute('aria-modal'), 'true', 'plus de aria-modal : la page derrière reste atteignable')
  })

  it('le bouton « fermer » ferme le panneau', async function () {
    const window = fenetreAvecArbre(bundle)
    window.document.body.innerHTML = '<mjs-dpb-parent></mjs-dpb-parent>'
    await new Promise(r => setTimeout(r, 60))

    window.µ.devPanel(true)
    const racine = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    racine.querySelector('[data-action="close"]').dispatchEvent(new window.Event('click', { bubbles: true }))
    assertAbsent(window.document.querySelector('[data-mjs-devpanel]'), 'le bouton fermer doit fermer le panneau')
  })

  it('l\'onglet État affiche l\'état de l\'instance sélectionnée', async function () {
    const window = fenetreAvecArbre(bundle)
    window.document.body.innerHTML = '<mjs-dpb-parent></mjs-dpb-parent>'
    await new Promise(r => setTimeout(r, 60))

    window.µ.devPanel(true)
    const racine = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    const lignes = Array.from(racine.querySelectorAll('.ligne')) as any[]
    const ligneEnfant = lignes.find(l => l.textContent.includes('dpb-enfant'))
    ligneEnfant.dispatchEvent(new window.Event('click', { bubbles: true }))

    const etatTexte = racine.querySelector('.onglet-corps').textContent
    // 'couleur' est une chaîne : ÉDITABLE, donc rendue en `<input value="…">`, jamais dans
    // `textContent` — la CLÉ, elle, apparaît bien en texte (`.di-cle`) ; la VALEUR se lit sur le champ
    assert.match(etatTexte, /couleur/, `l'onglet État doit montrer les variables de l'instance sélectionnée :\n${etatTexte}`)
    const champCouleur = racine.querySelector('input.di-valeur[data-di-key="couleur"]') as any
    assert.ok(champCouleur, `la variable d'état doit être éditable :\n${racine.querySelector('.onglet-corps').innerHTML}`)
    assert.equal(champCouleur.value, 'sombre', 'la valeur d\'état (reçue du contexte du parent) doit être celle de l\'instance')
    window.µ.devPanel(false)
  })

  it('l\'onglet Contexte affiche les valeurs posées par l\'instance sélectionnée', async function () {
    const window = fenetreAvecArbre(bundle)
    window.document.body.innerHTML = '<mjs-dpb-parent></mjs-dpb-parent>'
    await new Promise(r => setTimeout(r, 60))

    // le parent pose `§theme` — c'est SUR LUI que la Map `_mjs_contexts` existe, jamais sur
    // l'enfant qui ne fait que le lire (cf. `_mjs_getContext`, mjs_element.ts : remonte
    // l'arborescence, n'écrit jamais dans le consommateur)
    window.µ.devPanel(true)
    const racine = window.document.querySelector('[data-mjs-devpanel]').shadowRoot
    const lignes = Array.from(racine.querySelectorAll('.ligne')) as any[]
    lignes[0].dispatchEvent(new window.Event('click', { bubbles: true }))
    racine.querySelector('.onglet[data-onglet="contexte"]').dispatchEvent(new window.Event('click', { bubbles: true }))
    const corps = racine.querySelector('.onglet-corps')
    const contexteTexte = corps.textContent
    assert.match(contexteTexte, /theme/, `l'onglet Contexte doit montrer la clé posée :\n${contexteTexte}`)
    // la clé 'theme' est une chaîne, ÉDITABLE (l'inspecteur générique la rend en `<input>`) :
    // sa VALEUR ne rentre jamais dans `textContent` — se lit sur le champ, pas le texte du panneau
    // (le label affiché est `JSON.stringify(cle)`, donc `"theme"` guillemets compris)
    const champTheme = Array.from(corps.querySelectorAll('input.di-valeur')).find((el: any) => el.getAttribute('data-di-key') === '"theme"') as any
    assert.ok(champTheme, `la clé de contexte doit être éditable :\n${corps.innerHTML}`)
    assert.equal(champTheme.value, 'sombre', 'et sa valeur')
    window.µ.devPanel(false)
  })
})
