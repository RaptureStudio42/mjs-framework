// `_mjs_tryReviveDying` collectait
// SEULEMENT les nœuds `_mjs_dying` entre les ancres, en ignorant SILENCIEUSEMENT
// tout nœud VIVANT présent dans la même plage.
//
// Scénario réel : `{if}/{else}` avec outro sur les deux branches. `$show`
// true→false : branche A part en outro (reste dans le DOM, `_mjs_dying=true`),
// branche B est insérée (vivante). Re-toggle false→true PENDANT l'outro de A :
// l'ancien code comparait dyingNodes=[A] à la structure de la branche A
// recréée → MATCH → revive A et retourne `true` → le caller (`_mjs_updIf`/
// `_mjs_updItemIf`) retourne AUSSITÔT sans jamais détruire B → A ET B affichées
// ensemble jusqu'au tick suivant.
//
// Fix : la présence d'UN SEUL nœud vivant dans la plage fait échouer le
// revive (retourne `false`), forçant le caller à retomber sur le chemin
// normal destroy-puis-create qui détruit tout le contenu de la plage.
//
// Test : appel direct de `_mjs_tryReviveDying` (ne référence pas `this` en
// interne — vérifié par lecture du code) sur une structure DOM construite à
// la main, plus fiable qu'orchestrer une vraie transition asynchrone avec
// timing racy.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('_mjs_tryReviveDying — n\'agit plus si un nœud VIVANT partage la plage avec un dying', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('retourne false (et ne touche à rien) si un nœud vivant est présent entre les ancres', async () => {
    // Bundle un composant MINIMAL juste pour charger µ.Element (mjs_core).
    const root = mjsTmp('revive')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'stub.mjs'), '<p>stub</p>')

    // `runtime: ['if']` : le stub n'écrit aucun `{if}` lui-même (le scan ne détecterait donc
    // pas mjs_if.ts, où vit `_mjs_tryReviveDying` depuis son détachement de mjs_element.ts).
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), runtime: ['if'] })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0)

    const window: any = new Window({ url: 'http://localhost/' })
    const _document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    assert.ok(coreFile)
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    window.eval(stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')))
    window.eval('globalThis.µ = µ;')

    const result = window.eval(`
      (() => {
        const parent = document.createElement('div');
        const startAnchor = document.createComment('s');
        const endAnchor = document.createComment('e');
        const dyingNode = document.createElement('p');
        dyingNode._mjs_dying = true;
        dyingNode.textContent = 'A (dying)';
        const liveNode = document.createElement('p');
        liveNode.textContent = 'B (live)';
        // Ordre réaliste : dying PUIS live (A outro en cours, B déjà inséré).
        parent.appendChild(startAnchor);
        parent.appendChild(dyingNode);
        parent.appendChild(liveNode);
        parent.appendChild(endAnchor);

        let createFnCalls = 0;
        const createFn = () => {
          createFnCalls++;
          const frag = document.createDocumentFragment();
          const p = document.createElement('p');
          frag.appendChild(p);
          return { fragment: frag, refs: {} };
        };

        const revived = µ.Element.prototype._mjs_tryReviveDying.call({}, startAnchor, endAnchor, createFn);

        return JSON.stringify({
          revived,
          liveNodeStillInDom: liveNode.parentNode === parent,
          liveNodeStillDying: !!liveNode._mjs_dying,
          dyingNodeStillDying: !!dyingNode._mjs_dying,
        });
      })()
    `)
    const parsed = JSON.parse(result)

    assert.equal(parsed.revived, false, "AVANT le fix : revenait `true` (revive de A) malgré la présence du nœud vivant B")
    assert.equal(parsed.liveNodeStillInDom, true, 'B ne doit pas avoir été touché/retiré par _mjs_tryReviveDying lui-même')
    assert.equal(parsed.dyingNodeStillDying, true, "A ne doit PAS avoir été revivé (sinon _mjs_dying passerait à false) — le caller doit re-détruire normalement")
  })

  it('cas nominal (que des nœuds dying, pas de vivant) : le revive fonctionne toujours', async () => {
    const root = mjsTmp('revive-nominal')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'stub2.mjs'), '<p>stub</p>')
    // `runtime: ['if']` : même raison que le 1er test de ce fichier ci-dessus.
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), runtime: ['if'] })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0)

    const window: any = new Window({ url: 'http://localhost/' })
    const _document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    window.eval(stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')))
    window.eval('globalThis.µ = µ;')

    const result = window.eval(`
      (() => {
        const parent = document.createElement('div');
        const startAnchor = document.createComment('s');
        const endAnchor = document.createComment('e');
        const dyingNode = document.createElement('p');
        dyingNode._mjs_dying = true;
        parent.appendChild(startAnchor);
        parent.appendChild(dyingNode);
        parent.appendChild(endAnchor);

        const createFn = () => {
          const frag = document.createDocumentFragment();
          const p = document.createElement('p');
          frag.appendChild(p);
          return { fragment: frag, refs: {} };
        };

        const revived = µ.Element.prototype._mjs_tryReviveDying.call({}, startAnchor, endAnchor, createFn);
        return JSON.stringify({ revived, dyingNodeNowLive: dyingNode._mjs_dying === false });
      })()
    `)
    const parsed = JSON.parse(result)
    assert.equal(parsed.revived, true, 'sans nœud vivant, le revive doit toujours fonctionner (pas de régression)')
    assert.equal(parsed.dyingNodeNowLive, true)
  })
})
