// Un composant `@lightDom` re-rendu dans une branche
// {success}/{error} d'un {await} perd ses enfants `@lightDom` chargés à la
// demande (µ.Autoloader). Repro fidèle au rapport : parent {await} → enfant
// weather-content-like (@lightDom) → deux petits-enfants (@lightDom)
// auto-chargés.
//
// Cause racine PROUVÉE en vrai Chromium (sonde hors suite, avec le vrai
// Bundler + vrai serveur statique) — DEUX effets cumulés, tous deux
// spécifiques au chemin `document.createElement(tag)` PUIS
// `el.setAttribute('mjs-light', '')` en DEUX temps, utilisé par le code
// généré des branches `{success}`/`{error}` de `{await}` (compile.ts) :
//
//   1. Détection cassée — si le tag est DÉJÀ DÉFINI, `document.createElement`
//      construit l'instance SYNCHRONE, avant que `setAttribute('mjs-light',
//      '')` (posé juste après par le code généré) n'ait eu lieu :
//      `this.hasAttribute('mjs-light')` échoue dans le constructor
//      (mjs_element.ts), le composant se croit en mode ombre.
//   2. Crash silencieux — même (1) mis à part, le mode léger fait
//      `_mjs_mount` : `this.appendChild(...)` DIRECTEMENT DANS LE
//      CONSTRUCTEUR (pas de vrai Shadow DOM à viser). Le spec Custom
//      Elements INTERDIT à un élément d'avoir des enfants à la sortie de son
//      constructeur quand celui-ci est déclenché par `document.createElement`
//      avec le tag déjà défini (« synchronous custom elements flag ») :
//      Chromium lève `NotSupportedError` (« The result must not have
//      children »), qui remonte NON CAPTURÉE dans le composant PARENT
//      appelant — toute la reconstruction du bloc {await} avorte, l'enfant
//      et ses propres enfants @lightDom ne sont jamais insérés.
//
// Au 1er passage (round « préchauffage »load), le tag n'est PAS ENCORE
// DÉFINI : `document.createElement` ne construit rien tout de suite (élément
// générique inerte), l'upgrade réel n'a lieu qu'à la connexion — ni (1) ni
// (2) ne s'y appliquent (l'upgrade n'est jamais soumis à la contrainte
// « pas d'enfants », propre à `createElement`/`createElementNS`). D'où
// « au 1er rendu tout s'affiche » : le symptôme n'apparaît qu'au 2e passage.
//
// LIMITE D'ENVIRONNEMENT (documentée, pas contournée) — happy-dom (20.11.0,
// vérifié hors suite) ne lève JAMAIS `NotSupportedError` pour ce cas :
// un constructeur qui s'ajoute des enfants à lui-même via
// `document.createElement` sur un tag déjà défini y passe sans broncher.
// happy-dom a par ailleurs son PROPRE comportement de clonage non conforme
// (un `<template>.content` détaché y upgrade ses custom elements, jamais en
// vrai navigateur), qui masque la vraie cause sous un faux symptôme
// ressemblant. Aucun DOM simulé ne reproduit donc ce bug ; ce test monte le
// vrai Bundler dans un VRAI Chromium (Playwright), même patron que
// tests/browser-playwright.test.ts — opt-in (MJS_PLAYWRIGHT=1), skippé sans
// Chromium installé. Utilise le cache par défaut de Playwright
// (`~/.cache/ms-playwright`, résolu par `playwright.chromium.executablePath()`
// sans variable d'environnement) : un `PLAYWRIGHT_BROWSERS_PATH` pointé
// ailleurs (ex. un cache d'une AUTRE version de `playwright` que celle de
// `ModularJS/node_modules`) fait skipper ce test À TORT (chromium introuvable
// à l'endroit attendu par CETTE version) — ne pas le définir pour ces tests.
//
// Limite trouvée en vérification — la toute première version de ce correctif
// mémorisait le mode léger dans un Set PAR TAG (`µ._alwaysLightTags`). Or
// `@lightDom` est une directive d'INSTANCE (`docs/09-directives-dom.md` §
// « Monter sans Shadow DOM », `<@enfant @lightDom>` sur l'USAGE, jamais sur
// la définition du composant) : un parent avec deux enfants FRÈRES du MÊME
// tag, l'un `@lightDom` l'autre nu, voyait le second forcé en mode léger par
// contamination du Set — perte de son Shadow DOM, de son isolation CSS, de
// `:host`/`::slotted`. Retiré ; remplacé par un drapeau transitoire PAR
// INSTANCE (`µ._mjs_lightNext`), posé par le code généré juste avant CET appel
// `document.createElement` précis et effacé juste après (cf.
// src/generator/paths.ts) — jamais partagé entre deux usages du même tag.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler } from '../src/bundler/index.js'
import { StaticServer } from '../src/server/index.js'

async function isChromiumAvailable(): Promise<boolean> {
  try {
    const playwright = await import('playwright')
    return existsSync(playwright.chromium.executablePath())
  } catch {
    return false
  }
}

// `léger` pilote la présence de `@lightDom` sur les 3 tags imbriqués — seule
// différence entre le cas bogué et la variante témoin (mode ombre).
function sources(prefix: string, leger: boolean) {
  const lightDom = leger ? ' @lightDom' : ''
  const parent = [
    '<script>',
    '$p ?= null',
    '$n ?= 0',
    'go = -> $n = $n + 1; $p = Promise.resolve(\'v\'+ $n)',
    '</script>', '',
    '{await $p}', '{success r}',
    `<@${prefix}-child${lightDom} visible={true} val={r}>`,
    `</@${prefix}-child>`,
    '{error evt}', '<p class="err">{evt.message}</p>', '{end}',
    '<button class="go" @click={go()}>go</button>',
  ].join('\n')
  const child = [
    '<script>', '$visible ?= false', '$val ?= null', '</script>', '',
    '<div class="child-wrap" hidden={!$visible}>',
    `  <@${prefix}-grandchild-a${lightDom} val={$val}>`,
    `  </@${prefix}-grandchild-a>`,
    `  <@${prefix}-grandchild-b${lightDom} val={$val}>`,
    `  </@${prefix}-grandchild-b>`,
    '</div>',
  ].join('\n')
  const grandchildA = ['<script>', '$val ?= null', '</script>', '', '{if $val}', '<span class="ga">{$val}</span>', '{end}'].join('\n')
  const grandchildB = ['<script>', '$val ?= null', '</script>', '', '{if $val}', '<span class="gb">{$val}</span>', '{end}'].join('\n')
  return { parent, child, grandchildA, grandchildB }
}

describe('runtime (Chromium réel) — @lightDom re-rendu dans {await} : remontage des enfants auto-chargés', function () {
  let chromiumReady = false
  const optIn = process.env.MJS_PLAYWRIGHT === '1'

  before(async function () {
    this.timeout(5000)
    if (!optIn) return
    chromiumReady = await isChromiumAvailable()
    if (!chromiumReady) {
      console.log('  ℹ️  Chromium non installé, test Playwright skippé. ' +
                  'Activer : `npx playwright install chromium`')
    }
  })

  // monte le projet dans une vraie page Chromium, clique deux fois (le 2e
  // clic est LE test : {success} détruit l'ancien enfant et en reconstruit
  // un neuf, tags déjà tous définis — exactement la condition du rapport à
  // son 2e passage), retourne le contenu du DOM RÉEL après chaque clic.
  async function scenario(prefix: string, leger: boolean) {
    const root = mjsTmp('lightdom-remontage-'+ prefix)
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    const { parent, child, grandchildA, grandchildB } = sources(prefix, leger)
    writeFileSync(join(srcDir, prefix +'-parent.mjs'), parent)
    writeFileSync(join(srcDir, prefix +'-child.mjs'), child)
    writeFileSync(join(srcDir, prefix +'-grandchild-a.mjs'), grandchildA)
    writeFileSync(join(srcDir, prefix +'-grandchild-b.mjs'), grandchildB)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(outDir, 'bundle.js'), forceMinify: false })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    writeFileSync(join(outDir, 'index.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<mjs-${prefix}-parent></mjs-${prefix}-parent>
<script type="module" src="bundle.js"></script>
</body></html>`)

    const port = 41000 + Math.floor(Math.random() * 2000)
    const server = new StaticServer({ rootDir: outDir, port, host: '127.0.0.1', pathPrefix: bundler.urlPrefix })
    await server.start()

    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    try {
      await page.goto(`http://127.0.0.1:${port}${bundler.urlPrefix}/index.html`)
      await page.waitForSelector(`mjs-${prefix}-parent`, { timeout: 5000 })

      const click = async () => {
        await page.evaluate((pfx) => {
          const p: any = document.querySelector(`mjs-${pfx}-parent`)
          p._shadow.querySelector('.go').click()
        }, prefix)
        await page.waitForTimeout(200)
      }
      // mode léger : recherche STRICTE depuis le light DOM de `child` — le
      // symptôme réel est l'invisibilité EXTERNE (querySelector, DevTools) ;
      // percer un shadow ici masquerait une bascule accidentelle en Shadow
      // DOM. Mode ombre : `child` a un VRAI Shadow Root (fermé, voulu à
      // chaque niveau) — un querySelector direct ne le traverse jamais, il
      // faut percer chaque frontière pour juste vérifier que le rendu est
      // correct.
      const lire = () => page.evaluate(({ pfx, leg }) => {
        const deepQuery = (root: any, sel: string): any => {
          const direct = root.querySelector(sel)
          if (direct) return direct
          for (const el of Array.from(root.querySelectorAll('*')) as any[]) {
            if (el._shadow && el._shadow !== el) {
              const found = deepQuery(el._shadow, sel)
              if (found) return found
            }
          }
          return null
        }
        const p: any = document.querySelector(`mjs-${pfx}-parent`)
        const child: any = p._shadow.querySelector(`mjs-${pfx}-child`)
        const find = (sel: string) => {
          if (!child) return null
          return leg ? child.querySelector(sel) : deepQuery(child._shadow, sel)
        }
        return {
          childPresent: !!child,
          ga: find('.ga')?.textContent ?? null,
          gb: find('.gb')?.textContent ?? null,
        }
      }, { pfx: prefix, leg: leger })

      // PRÉCHAUFFAGE — tag pas encore défini : upgrade différé, pas concerné
      // par (1)/(2) ci-dessus (cf. commentaire de tête). Pas d'assertion de
      // fond ici, seul le clic compte pour amener l'appli dans l'état
      // « tags déjà connus » avant le vrai test.
      await click()
      const round1 = await lire()
      assert.ok(round1.childPresent, 'préchauffage — le composant enfant doit apparaître dès la résolution de la promesse')

      // VRAI TEST — nouvelle promesse, tags déjà définis : condition exacte
      // du rapport à son 2e passage.
      await click()
      const round2 = await lire()
      return round2
    } finally {
      await browser.close()
      await server.stop()
      await bundler.close()
    }
  }

  it('mode @lightDom — BUG : les petits-enfants disparaissent au 2e passage (tags déjà définis)', async function () {
    if (!optIn || !chromiumReady) { this.skip(); return }
    this.timeout(30000)
    const round2 = await scenario('t466l', true)
    // Symptôme rapporté (15/09/2026, réécriture de l'appli météo du banc) :
    // au 2e rendu, les petits-enfants @lightDom restent absents du DOM.
    assert.ok(round2.childPresent, 'le composant enfant doit être RECRÉÉ')
    assert.equal(round2.ga, 'v2', 'petit-enfant A absent ou périmé : bogue reproduit')
    assert.equal(round2.gb, 'v2', 'petit-enfant B absent ou périmé : bogue reproduit')
  })

  it('mode ombre (sans @lightDom) — variante témoin : NON atteinte (this.appendChild vise le Shadow Root, jamais l\'élément)', async function () {
    if (!optIn || !chromiumReady) { this.skip(); return }
    this.timeout(30000)
    const round2 = await scenario('t466s', false)
    assert.ok(round2.childPresent, 'le composant enfant doit être RECRÉÉ')
    assert.equal(round2.ga, 'v2')
    assert.equal(round2.gb, 'v2')
  })

  // `@lightDom` est une directive d'INSTANCE : deux frères du
  // MÊME tag, l'un léger l'autre ombre, ne doivent JAMAIS se contaminer (cf.
  // commentaire de tête). Reproduit avec un composant `leaf` minimal,
  // instancié deux fois dans la MÊME branche {success}, tags déjà définis
  // (round 2) — exactement la condition qui casse un Set par tag.
  it('deux frères du même tag, un seul léger — pas de contamination par tag', async function () {
    if (!optIn || !chromiumReady) { this.skip(); return }
    this.timeout(30000)

    const prefix = 't466two'
    const root = mjsTmp('lightdom-remontage-'+ prefix)
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    const parent = [
      '<script>', '$p ?= null', '$n ?= 0',
      'go = -> $n = $n + 1; $p = Promise.resolve(\'v\'+ $n)',
      '</script>', '',
      '{await $p}', '{success r}',
      `<@${prefix}-leaf @lightDom val={r}>`,
      `</@${prefix}-leaf>`,
      `<@${prefix}-leaf val={r}>`,
      `</@${prefix}-leaf>`,
      '{error evt}', '<p class="err">{evt.message}</p>', '{end}',
      '<button class="go" @click={go()}>go</button>',
    ].join('\n')
    const leaf = ['<script>', '$val ?= null', '</script>', '', '{if $val}', '<span class="v">{$val}</span>', '{end}'].join('\n')
    writeFileSync(join(srcDir, prefix +'-parent.mjs'), parent)
    writeFileSync(join(srcDir, prefix +'-leaf.mjs'), leaf)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(outDir, 'bundle.js'), forceMinify: false })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    writeFileSync(join(outDir, 'index.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<mjs-${prefix}-parent></mjs-${prefix}-parent>
<script type="module" src="bundle.js"></script>
</body></html>`)

    const port = 41000 + Math.floor(Math.random() * 2000)
    const server = new StaticServer({ rootDir: outDir, port, host: '127.0.0.1', pathPrefix: bundler.urlPrefix })
    await server.start()
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    try {
      await page.goto(`http://127.0.0.1:${port}${bundler.urlPrefix}/index.html`)
      await page.waitForSelector(`mjs-${prefix}-parent`, { timeout: 5000 })

      const click = async () => {
        await page.evaluate((pfx) => {
          const p: any = document.querySelector(`mjs-${pfx}-parent`)
          p._shadow.querySelector('.go').click()
        }, prefix)
        await page.waitForTimeout(200)
      }
      const lire = () => page.evaluate((pfx) => {
        const p: any = document.querySelector(`mjs-${pfx}-parent`)
        const leaves: any[] = Array.from(p._shadow.querySelectorAll(`mjs-${pfx}-leaf`))
        return leaves.map((el) => ({
          isLight: !!el._mjs_isLight,
          textStrict: el.querySelector('.v')?.textContent ?? null,
        }))
      }, prefix)

      // préchauffage (tag pas encore défini au 1er clic, cf. commentaire de tête)
      await click()
      // vrai test : round 2, tags déjà définis pour les DEUX instances
      await click()
      const [first, second] = await lire()
      assert.ok(first, 'le 1er frère (@lightDom) doit être présent')
      assert.ok(second, 'le 2e frère (nu, ombre) doit être présent')
      assert.equal(first.isLight, true, '1er frère : doit être en mode léger (déclaré @lightDom)')
      assert.equal(first.textStrict, 'v2', '1er frère : contenu visible depuis le light DOM (léger)')
      assert.equal(second.isLight, false, '2e frère : NE DOIT PAS être forcé en mode léger par contamination du 1er')
      assert.equal(second.textStrict, null, '2e frère : en Shadow DOM fermé, son contenu est invisible via un querySelector direct (comportement normal, pas un bogue)')
    } finally {
      await browser.close()
      await server.stop()
      await bundler.close()
    }
  })
})
