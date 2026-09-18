// Test neuf — module cœur `color` (<@color>, tag réel <mjs-color>) : pastille de
// couleur en lecture seule par défaut (variable CSS --mjs-color-value, zéro style de
// présentation inline — règle nº1), édition opt-in (<input type="color"> natif + résolution
// hex via élément jetable + getComputedStyle, repli silencieux si la résolution échoue),
// événement `change` émis via µemit. Patron calqué sur tests/core-field.test.ts (bundler réel,
// happy-dom, chunks du core + du module + de l'hôte).
// ⚠ happy-dom ne NORMALISE PAS getComputedStyle().backgroundColor en rgb() pour un hex/mot-clé
// (contrairement à un vrai navigateur) : les tests qui exercent resolveHex passent donc une
// valeur déjà en syntaxe rgb(...) en entrée — happy-dom la restitue telle quelle, ce qui suffit
// à vérifier la conversion rgb→hex sans dépendre d'une normalisation que la lib de test ne fait
// pas. En vrai navigateur, un hex ou un mot-clé se résout tout aussi bien (normalisation standard).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { assertAbsent } from './helpers/dom-assert.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function buildAndMount(hostSource: string): Promise<{ window: any; document: any; hote: any }> {
  const root = mjsTmp('color')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'hote.mjs'), hostSource)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const files = readdirSync(outDir)
  const pick = (re: RegExp) => {
    const f = files.find((f) => re.test(f))
    assert.ok(f, `chunk attendu ${re} parmi ${files.join(', ')}`)
    return f!
  }
  const code = [pick(/^mjs_core-/), pick(/^color-/), pick(/^hote-/)]
    .map((f) => stripEsm(readFileSync(join(outDir, f), 'utf-8')))
    .join('\n')

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  window.eval(`
    ${code}
    globalThis.µ = µ;
    globalThis.__errCalls = [];
    globalThis.__changeCalls = [];
    µ.error = function(...a) { globalThis.__errCalls.push(a); };
  `)
  document.body.innerHTML = '<mjs-hote></mjs-hote>'
  await new Promise((r) => setTimeout(r, 80))
  const hote = document.body.querySelector('mjs-hote')
  return { window, document, hote }
}

describe('mjs-color — compilation, résolution de la balise', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('build vert, tag <mjs-color> réécrit dans le gabarit hôte', async () => {
    const root = mjsTmp('color-build')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hote.mjs'), '<@color value="#f472b6">')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    assert.ok(stats.manifest['color'], 'manifeste doit exposer color')
    const files = readdirSync(outDir)
    const hote = files.find((f) => /^hote-/.test(f))!
    assert.match(readFileSync(join(outDir, hote), 'utf-8'), /<mjs-color\b/)
  })
})

describe('mjs-color — lecture seule (règle nº1 : variable CSS, zéro style de présentation inline)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('la pastille porte --mjs-color-value et aucune propriété background en style inline', async () => {
    const { hote } = await buildAndMount('<@color value="#f472b6">')
    const colorEl = hote._shadow.querySelector('mjs-color')
    const swatch = colorEl._shadow.querySelector('.swatch')
    assert.ok(swatch, 'la pastille doit être rendue')
    assert.equal(swatch.style.getPropertyValue('--mjs-color-value'), '#f472b6')
    const styleAttr = swatch.getAttribute('style') || ''
    assert.doesNotMatch(styleAttr, /(^|;)\s*background/, 'aucune propriété background ne doit être écrite en style inline — seule la variable CSS')
  })

  it('le code écrit accompagne la pastille en mode non-compact', async () => {
    const { hote } = await buildAndMount('<@color value="#f472b6">')
    const colorEl = hote._shadow.querySelector('mjs-color')
    const code = colorEl._shadow.querySelector('.code')
    assert.ok(code)
    assert.equal(code.textContent, '#f472b6')
  })
})

describe('mjs-color — sans editable : aucun input rendu', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('aucun <input> dans le shadow du module', async () => {
    const { hote } = await buildAndMount('<@color value="#f472b6">')
    const colorEl = hote._shadow.querySelector('mjs-color')
    assertAbsent(colorEl._shadow.querySelector('input'))
  })
})

describe('mjs-color — editable : input natif + étiquette accessible', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('un input type="color" est rendu, porte un aria-label, valeur = hex résolu', async () => {
    const { hote } = await buildAndMount('<@color value="rgb(59, 130, 246)" editable>')
    const colorEl = hote._shadow.querySelector('mjs-color')
    const input = colorEl._shadow.querySelector('input')
    assert.ok(input, 'un input doit être rendu en editable')
    assert.equal(input.getAttribute('type'), 'color')
    assert.ok(input.getAttribute('aria-label'), 'aria-label doit être présent')
    assert.equal(input.value, '#3b82f6')
  })
})

describe('mjs-color — lecture seule accepte une syntaxe CSS non hexadécimale', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('oklch(...) est acceptée telle quelle, affichée dans le code écrit', async () => {
    const { hote } = await buildAndMount('<@color value="oklch(62% .19 245)">')
    const colorEl = hote._shadow.querySelector('mjs-color')
    const swatch = colorEl._shadow.querySelector('.swatch')
    const code = colorEl._shadow.querySelector('.code')
    assert.equal(swatch.style.getPropertyValue('--mjs-color-value'), 'oklch(62% .19 245)')
    assert.equal(code.textContent, 'oklch(62% .19 245)')
  })
})

describe('mjs-color — repli silencieux si la résolution hexadécimale échoue', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('couleur non résolvable par le navigateur en editable → aucun input, pastille en lecture seule', async () => {
    const { hote, window } = await buildAndMount('<@color value="ceci-nest-pas-une-couleur" editable>')
    const colorEl = hote._shadow.querySelector('mjs-color')
    assertAbsent(colorEl._shadow.querySelector('input'), 'pas de sélecteur menteur')
    assert.ok(colorEl._shadow.querySelector('.swatch'), 'repli sur la pastille en lecture seule')
    assert.equal(window.eval('globalThis.__errCalls.length'), 0, 'repli SILENCIEUX : aucun µ.error')
  })
})

describe('mjs-color — editable : émission de l\'événement change', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('changement de couleur sur l\'input natif → change émis avec la nouvelle valeur', async () => {
    const HOST = '<@color value="rgb(59, 130, 246)" editable @change={globalThis.__changeCalls.push(e.data)}>'
    const { hote, window } = await buildAndMount(HOST)
    const colorEl = hote._shadow.querySelector('mjs-color')
    const input = colorEl._shadow.querySelector('input')
    input.value = '#ff0000'
    input.dispatchEvent(new window.Event('change', { bubbles: true, composed: true }))
    await new Promise((r) => setTimeout(r, 30))
    const calls = window.eval('globalThis.__changeCalls')
    assert.equal(calls.length, 1, 'change doit être émis exactement une fois')
    assert.equal(calls[0], '#ff0000', 'la charge utile (e.data) doit porter la nouvelle valeur')
  })
})

describe('mjs-color — accessibilité de la pastille par branche (réactivité de la dérivation prouvée par bascule)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  function click(el: any, window: any) {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }))
  }

  it('non-compact : pastille retirée de l\'arbre a11y (aria-hidden=true, pas de role/title/aria-label — undefined n\'écrit PAS "undefined") ; bascule compact (clic, sans remontage) : role=img, title/aria-label=valeur, plus caché, code écrit retiré', async () => {
    const HOST = [
      '<script>',
      '  $c = false',
      '</script>',
      '<@color value="#f472b6" compact={$c}>',
      '<button @click={$c = not $c}>toggle</button>',
    ].join('\n')
    const { hote, window } = await buildAndMount(HOST)
    const colorEl = hote._shadow.querySelector('mjs-color')

    const swatchBefore = colorEl._shadow.querySelector('.swatch')
    assert.equal(swatchBefore.getAttribute('aria-hidden'), 'true', 'non-compact : la pastille doit être retirée de l\'arbre a11y (le code écrit fait foi)')
    assert.equal(swatchBefore.getAttribute('role'), null, 'non-compact : pas de role')
    assert.equal(swatchBefore.getAttribute('title'), null, 'non-compact : pas de title (undefined ne doit pas écrire la chaîne "undefined")')
    assert.equal(swatchBefore.getAttribute('aria-label'), null, 'non-compact : pas de aria-label')
    assert.ok(colorEl._shadow.querySelector('.code'), 'non-compact : le code écrit est présent')

    // bascule $c (compact) par un vrai clic — prouve que $swatchLabel/$swatchRole/$swatchHidden
    // sont bien réévalués (dérivation automatique réactive), pas figés au premier rendu
    click(hote._shadow.querySelector('button'), window)
    await new Promise((r) => setTimeout(r, 30))

    const swatchAfter = colorEl._shadow.querySelector('.swatch')
    assert.notEqual(swatchAfter.getAttribute('aria-hidden'), 'true', 'compact : la pastille ne doit plus être cachée, seule porteuse de l\'info')
    assert.equal(swatchAfter.getAttribute('role'), 'img', 'compact : role=img pour exposer la pastille comme élément graphique nommé')
    assert.equal(swatchAfter.getAttribute('title'), '#f472b6')
    assert.equal(swatchAfter.getAttribute('aria-label'), '#f472b6')
    assertAbsent(colorEl._shadow.querySelector('.code'), 'compact : pas de code écrit')
  })
})

// two-way `value=!{$x}` — le module ASSIGNE `$value` avant d'émettre (comme checkbox/switch/select) :
// sans cette assignation, aucun `mjs-bind:value` n'est dispatché et la liaison reste morte dans un sens
describe('mjs-color — editable : la liaison two-way value=!{$x} remonte au parent', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('choisir une couleur dans le sélecteur natif met à jour l\'état du parent', async () => {
    const HOST = [
      '<script>',
      // happy-dom ne normalise pas un hex en rgb() : on part d'une forme qu'il sait résoudre
      '  $brand = \'rgb(59, 130, 246)\'',
      '</script>',
      '<@color value=!{$brand} editable>',
      '<p class="echo">{$brand}</p>',
    ].join('\n')
    const { hote, window } = await buildAndMount(HOST)
    const colorEl = hote._shadow.querySelector('mjs-color')
    const input   = colorEl._shadow.querySelector('input')
    assert.equal(hote._shadow.querySelector('.echo').textContent, 'rgb(59, 130, 246)', 'état initial du parent')

    input.value = '#ff0000'
    input.dispatchEvent(new window.Event('change', { bubbles: true, composed: true }))
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(hote._shadow.querySelector('.echo').textContent, '#ff0000', 'le parent doit avoir suivi la nouvelle couleur')
  })
})

describe('mjs-color — placement de la pastille (defaut : apres le code ; attribut `before` : avant)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('sans `before`, la pastille ne porte pas la classe `before` (ordre visuel : code puis pastille)', async () => {
    const { hote } = await buildAndMount('<@color value="#f472b6">')
    const swatch = hote._shadow.querySelector('mjs-color')._shadow.querySelector('.swatch')
    assert.ok(swatch)
    assert.equal(swatch.classList.contains('before'), false, 'la classe `before` ne doit pas etre posee par defaut')
  })

  it('avec `before`, la pastille porte la classe `before` (ordre visuel : pastille puis code)', async () => {
    const { hote } = await buildAndMount('<@color value="#f472b6" before>')
    const swatch = hote._shadow.querySelector('mjs-color')._shadow.querySelector('.swatch')
    assert.ok(swatch)
    assert.equal(swatch.classList.contains('before'), true, 'la classe `before` doit etre posee sous l\'attribut before')
  })
})

// Regression — un commentaire `//` en FIN de ligne sur une custom property n'est PAS
// un commentaire pour SASS : il reste dans la valeur (`1em // hauteur du texte`), la valeur
// devient invalide, `width`/`height` retombent sur `auto` et la pastille disparait (2px de
// bordure). Le test lit le CSS reellement compile du chunk du module.
describe('mjs-color — dimension de la pastille (1em, valeur propre)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('--mjs-color-size vaut exactement 1em dans le CSS compile (aucun residu de commentaire)', async () => {
    const root   = mjsTmp('color-size')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hote.mjs'), '<@color value="#f472b6">')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const chunk = readdirSync(outDir).find((f) => /^color-/.test(f))!
    const code  = readFileSync(join(outDir, chunk), 'utf-8')
    const decl  = code.match(/--mjs-color-size:([^;"}]*)/)
    assert.ok(decl, '--mjs-color-size doit etre declaree dans le CSS du module')
    assert.equal(decl![1].trim(), '1em', 'la valeur doit etre nue : ni commentaire, ni texte parasite')

    // le selecteur natif doit remplir toute la case : sans neutralisation, Chrome ET Firefox
    // dessinent leur propre pave interne, plus petit que le carre de la version lecture seule
    assert.match(code, /appearance:\s*none/,      'l\'input color doit neutraliser le rendu natif (appearance)')
    assert.match(code, /::-webkit-color-swatch/,  'le pave interne WebKit doit etre debordure')
    assert.match(code, /::-moz-color-swatch/,     'le pave interne Firefox doit etre debordure')
    // Firefox applique sa propre police aux controles de formulaire : sans font:inherit, le 1em
    // de la case vaut 13.3px au lieu des 16px de la pastille en lecture seule (mesure Playwright)
    assert.match(code, /\.picker[^}]*font:\s*inherit/, 'l\'input color doit heriter la police, sinon 1em ne vaut pas la meme chose que sur la pastille')
    // etai : sans lui, `compact` (plus de code ecrit) reduit la hauteur de l'hote a celle de la
    // pastille, qui remonte alors de 3px par rapport a ses voisines non compactes (mesure Firefox)
    assert.match(code, /:host::before[^}]*height:\s*var\(--mjs-color-line\)/, 'l\'etai doit reserver la hauteur de ligne, meme en compact')
    assert.match(code, /\.code[^}]*line-height:\s*var\(--mjs-color-line\)/,  'le code ecrit doit utiliser LA MEME hauteur de ligne que l\'etai')
    // dart-sass prefixe le CSS d'un BOM des qu'il contient un caractere non ASCII, ce qui
    // invalide la PREMIERE regle (ici le bloc :host qui porte toutes les variables)
    assert.equal(code.includes('\uFEFF'), false, 'aucun BOM dans le CSS compile du module')
  })
})
