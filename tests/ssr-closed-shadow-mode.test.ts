// Test de régression — `renderToString.ts`
// (SSR) accepte `shadowMode:'closed'` et émet `<template shadowrootmode="closed">`.
// Le navigateur attache ce Shadow DOM `closed` NATIVEMENT au parsing — mais un
// shadow `closed` n'expose JAMAIS son contenu via `el.shadowRoot` (null par
// spec, même celui posé par le parseur lui-même). La reprise en main cliente
// (mjs_element.ts, constructor : `else if (this.shadowRoot)`) ne peut donc PAS
// détecter ce shadow préexistant, et retombe sur `this.attachShadow({mode:
// 'closed'})` — qui ÉCHOUE ("already hosts a shadow tree") puisqu'un shadow
// existe déjà. AVANT le fix, cette DOMException native remontait telle quelle
// hors du constructor : par la spec Custom Elements, ceci marque l'élément
// "failed to upgrade" À VIE (composant mort), sans AUCUN indice reliant le
// crash à sa cause réelle (l'option `shadowMode:'closed'`, à plusieurs
// fichiers de distance, côté SERVEUR).
//
// Fix (2 volets) :
//  1. Client (mjs_element.ts) : `attachShadow` est maintenant enveloppé dans un
//     try/catch — un échec y est reconverti en erreur EXPLICITE, actionnable.
//  2. Serveur (renderToString.ts) : `shadowMode:'closed'` déclenche un warning
//     PROACTIF dans le résultat de rendu, AVANT même que le client ne crashe.
//
// Note méthode : reproduire fidèlement "un Shadow DOM closed déjà attaché par
// LE PARSEUR avant upgrade" est infaisable simplement sous happy-dom (qui ne
// parse pas le Declarative Shadow DOM) ET une tentative de
// upgrade rétroactif (document.createElement non défini → attachShadow manuel →
// customElements.define → customElements.upgrade) s'est avérée peu fiable en
// happy-dom (vérifié empiriquement : l'upgrade rétroactif ne se produit pas).
// On teste donc directement le comportement du constructor face à un
// `attachShadow` qui échoue (monkey-patch ciblé, le SEUL point d'incertitude
// réel du fix), et séparément le warning serveur (déterministe, API publique).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { renderToString } from '../src/server/renderToString.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('shadowMode:\'closed\' — échec clair (client) + avertissement proactif (serveur)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it("serveur : shadowMode:'closed' ajoute un warning explicite (absent en mode 'open', le défaut)", async function () {
    const root = mjsTmp('shadowmode-warn')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'page.mjs'), '<p class="x">contenu</p>')

    const closedRes = await renderToString({ sourceDir: srcDir, tag: 'mjs-page', shadowMode: 'closed' })
    assert.ok(
      closedRes.warnings.some(w => /shadowMode:'closed'/.test(w) && /mjs-page/.test(w)),
      `un warning nommant le composant et l'option doit être présent. warnings: ${JSON.stringify(closedRes.warnings)}`,
    )

    const openRes = await renderToString({ sourceDir: srcDir, tag: 'mjs-page' })
    assert.ok(
      !openRes.warnings.some(w => /shadowMode/.test(w)),
      "mode 'open' (défaut) : AUCUN warning shadowMode ne doit apparaître (pas de régression sur le cas nominal)",
    )
  })

  it("client : un attachShadow qui échoue (shadow déjà attaché — simulé) devient une erreur EXPLICITE MJS, pas la DOMException native brute", async function () {
    const root = mjsTmp('shadowmode-client')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'stub.mjs'), '<p>stub</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
    const stubFile = files.find((f: string) => /^stub-/.test(f))!
    const stripEsm = (s: string): string => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    try {
      window.eval(stripEsm(readFileSync(join(outDir, coreFile), 'utf-8')))
      window.eval('globalThis.µ = µ;')
      window.eval(stripEsm(readFileSync(join(outDir, stubFile), 'utf-8')))

      // Monkey-patch CIBLÉ : simule "un Shadow DOM existe déjà" (la seule
      // raison réelle pour laquelle ce `attachShadow` précis peut échouer,
      // cf. commentaire du fix) sans avoir à reproduire le parsing DSD complet.
      const caught = window.eval(`
        (() => {
          const StubClass = customElements.get('mjs-stub');
          const orig = HTMLElement.prototype.attachShadow;
          HTMLElement.prototype.attachShadow = function() {
            throw new DOMException("Failed to execute 'attachShadow' on 'Element': Shadow root cannot be created on a host which already hosts a shadow tree.", "NotSupportedError");
          };
          try {
            new StubClass();
            return { threw: false };
          } catch (e) {
            return { threw: true, message: e.message };
          } finally {
            HTMLElement.prototype.attachShadow = orig;
          }
        })()
      `)

      assert.equal(caught.threw, true, 'un attachShadow qui échoue doit TOUJOURS faire échouer la construction (pas de silence)')
      assert.match(caught.message, /shadowMode:'closed'/,
        "AVANT le fix : la DOMException NATIVE (\"Failed to execute 'attachShadow'...\") remontait telle quelle — aucun indice reliant le crash à shadowMode:'closed'")
      assert.doesNotMatch(caught.message, /Failed to execute 'attachShadow'/,
        'le message natif cryptique ne doit plus fuiter tel quel (remplacé par le message MJS actionnable)')
    } finally {
      try { window.close?.() } catch { /* ignore */ }
      await bundler.close()
    }
  })
})
