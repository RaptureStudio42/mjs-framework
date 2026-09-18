// Régression : les styles d'épinglage
// posés par `µ._mjs_fixPosition` (position:absolute + largeur/hauteur/position
// FIGÉES — utilisé par `{for}`+`@flip` pour garder un node "dyingTail" visible
// à sa place pendant que les vivants reflowent) n'étaient JAMAIS nettoyés si
// ce node est FINALEMENT ressuscité (clé qui réapparaît PENDANT son outro,
// cf. `_mjs_reconcileList` branche "DYING, reviving", mjs_element.ts ~2850) au
// lieu d'être réellement détruit. Le node rejouait correctement son intro
// mais restait visuellement bloqué en `position:absolute`, hors du flux
// normal, avec une largeur/hauteur figées à son état de sortie — un
// `position:absolute` orphelin ne se corrige jamais tout seul.
//
// Fix : `µ._mjs_unfixPosition` (mjs_easing.ts) retire exactement ce que
// `_mjs_fixPosition` a posé (`removeProperty`, pas de restauration d'une valeur
// "avant" — `_mjs_fixPosition` ne lit que le COMPUTED style, jamais l'inline),
// appelé au point de revival `{for}` (et, ceinture+bretelles, dans
// `_mjs_tryReviveDying` pour {if}/{key}/{await}).
//
// 2 volets : (1) `_mjs_fixPosition`/`_mjs_unfixPosition` sont bien des inverses exacts
// (unitaire) ; (2) le point de revival RÉEL (`_mjs_reconcileList`, via un
// composant compilé + monté) appelle bien `_mjs_unfixPosition` sur le node
// ressuscité.

import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('µ._mjs_fixPosition / µ._mjs_unfixPosition — épinglage et nettoyage au revival', function () {
  describe('unitaire — les 2 fonctions sont des inverses exacts', function () {
    const win: any = new Window({ url: 'http://localhost/' })
    const g: any   = globalThis
    // posés au début des tests, jamais au chargement du fichier : un fichier chargé dans le même
    // process mocha (csp-runtime.test.ts, afterEach) retire `window`/`document` du global entre-temps,
    // et `_mjs_fixPosition` lit `window.getComputedStyle` à l'appel
    let prevWindow: any, prevDocument: any
    before(() => {
      prevWindow   = g.window
      prevDocument = g.document
      g.window     = win
      g.document   = win.document
    })
    after(() => {
      if(prevWindow === undefined) delete g.window
      else g.window = prevWindow
      if(prevDocument === undefined) delete g.document
      else g.document = prevDocument
    })

    it('_mjs_fixPosition pose position/margin/width/height/left/top + le flag _mjs_posFixed', async function () {
      const µ: any = (globalThis as any).µ ?? ((globalThis as any).µ = {})
      µ.debug = µ.debug ?? false
      await import('../src/runtime/mjs_easing.js')

      const el: any = win.document.createElement('div')
      win.document.body.appendChild(el)
      assert.equal(el._mjs_posFixed, undefined, 'pas encore épinglé')

      µ._mjs_fixPosition(el, { left: 10, top: 20 })

      assert.equal(el.style.position, 'absolute')
      assert.equal(el.style.margin, '0px', 'margin normalisé par happy-dom, mais posé')
      assert.ok(el.style.left.endsWith('px'))
      assert.ok(el.style.top.endsWith('px'))
      assert.equal(el._mjs_posFixed, true, 'flag posé — permet à _mjs_unfixPosition de savoir que CE code a épinglé le node')
    })

    it("_mjs_unfixPosition retire EXACTEMENT ce que _mjs_fixPosition a posé, et réarme le flag", async function () {
      const µ: any = (globalThis as any).µ
      const el: any = win.document.createElement('div')
      win.document.body.appendChild(el)
      µ._mjs_fixPosition(el, { left: 5, top: 5 })
      assert.equal(el._mjs_posFixed, true)

      µ._mjs_unfixPosition(el)

      assert.equal(el.style.position, '', "AVANT le fix : un node ressuscité restait bloqué en position:absolute à vie")
      assert.equal(el.style.margin, '')
      assert.equal(el.style.width, '')
      assert.equal(el.style.height, '')
      assert.equal(el.style.left, '')
      assert.equal(el.style.top, '')
      assert.equal(el._mjs_posFixed, false, 'le flag redevient false — un 2e appel est un no-op sûr')
    })

    it('_mjs_unfixPosition sur un node JAMAIS épinglé ne fait rien (no-op sûr)', async function () {
      const µ: any = (globalThis as any).µ
      const el: any = win.document.createElement('div')
      el.style.position = 'relative' // posé par l'appli, PAS par _mjs_fixPosition
      assert.doesNotThrow(() => µ._mjs_unfixPosition(el))
      assert.equal(el.style.position, 'relative', "un style posé par ailleurs (pas par _mjs_fixPosition) ne doit PAS être touché")
    })
  })

  describe('intégration — le point de revival {for} de _mjs_reconcileList appelle bien _mjs_unfixPosition', function () {
    this.timeout(40000)
    after(async () => { await terminateSharedWorkerPool() })

    // Même stratégie que tests/try-revive-dying-live-sibling.test.ts : bundle
    // un composant MINIMAL juste pour charger µ.Element (mjs_core), puis
    // construit une structure DOM + un cache `_list_*` À LA MAIN pour placer
    // `_mjs_reconcileList` (via `_mjs_updList`) EXACTEMENT dans le scénario "clé encore
    // dying qui réapparaît" — plus fiable qu'orchestrer une vraie transition
    // asynchrone avec timing racy, et évite toute dépendance à la syntaxe
    // exacte d'une directive `@out` custom (@out.NOM référence `µ.anim.NOM`,
    // un registre global — hors sujet ici).
    it("une row dont l'entrée cache est encore _mjs_dying, ré-ajoutée avec la MÊME clé, voit son épinglage @flip nettoyé", async () => {
      const root = mjsTmp('fixpos')
      const srcDir = join(root, 'src')
      const outDir = join(root, 'out')
      mkdirSync(srcDir, { recursive: true })
      writeFileSync(join(srcDir, 'stub.mjs'), '<p>stub</p>')

      // `runtime: [...]` explicite : le stub `<p>stub</p>` n'utilise ni `{for}` ni aucun
      // module optionnel classique — sans forçage, le scan ne détecte ni 'for' ni
      // 'for_nested' (µ.Element.prototype._mjs_updList, mjs_for_nested.ts, jumeau de `_mjs_updFor`
      // pour les boucles imbriquées, appelle `_mjs_reconcileList` de mjs_for.ts) ; et un
      // `runtime` EXPLICITE bascule aussi `easing` (mjs_easing.ts, µ._mjs_fixPosition/
      // _mjs_unfixPosition) hors de la sélection implicite par défaut (`allOptional()`,
      // rétrocompat `runtime` absent) — le lister ici aussi, pas de scan possible pour un
      // module optionnel classique.
      const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), runtime: ['easing', 'for', 'for_nested'] })
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
          document.body.appendChild(parent);
          const startNode = document.createComment('s');
          const endNode = document.createComment('e');
          const dyingNode = document.createElement('div');
          dyingNode._mjs_dying = true;
          dyingNode.textContent = 'b (dying)';
          parent.appendChild(startNode);
          parent.appendChild(dyingNode);
          parent.appendChild(endNode);

          // Simule un épinglage @flip RÉEL (µ._mjs_fixPosition, pas une pose
          // manuelle de styles) — seule la CAUSE (un vrai @flip mesurant un
          // vrai layout) est hors de portée sous happy-dom, pas l'EFFET.
          µ._mjs_fixPosition(dyingNode, { left: 1, top: 1, width: 10, height: 10 });
          const posFixedBefore = dyingNode._mjs_posFixed;
          const positionBefore = dyingNode.style.position;

          // État _list_* AVANT reconcile : la row 'b' existait, elle est
          // encore dying (comme si son outro tournait toujours).
          // Object.create(µ.Element.prototype) (pas un objet nu) : _mjs_updList
          // appelle this._mjs_reconcileList en interne, une méthode du prototype.
          const fakeThis = Object.assign(Object.create(µ.Element.prototype), {
            _mjs_id_gen: 0,
            _mjs_list_cache:  { for1: new Map([['b', { nodes: [dyingNode], __nodes: {} }]]) },
            _mjs_list_order:  { for1: ['b'] },
            _mjs_list_anchor: { for1: startNode },
          });

          const tplFn = () => {
            const frag = document.createDocumentFragment();
            const p = document.createElement('p');
            frag.appendChild(p);
            return { fragment: frag, refs: {}, updateFn: () => {} };
          };
          const updateFn = () => {};
          const keyFn = (item) => item.id;

          // Même clé 'b' réapparaît dans la NOUVELLE collection → doit
          // matcher l'entry cache existante (entry && hasDying) → revive,
          // PAS une recréation via tplFn.
          µ.Element.prototype._mjs_updList.call(
            fakeThis, 'for1', startNode, endNode, [{ id: 'b' }], tplFn, keyFn, updateFn, null,
          );

          return JSON.stringify({
            posFixedBefore,
            positionBefore,
            dyingAfter: !!dyingNode._mjs_dying,
            posFixedAfter: dyingNode._mjs_posFixed,
            positionAfter: dyingNode.style.position,
          });
        })()
      `)
      const parsed = JSON.parse(result)

      assert.equal(parsed.posFixedBefore, true, "épinglage @flip posé (comme le ferait un vrai @flip)")
      assert.equal(parsed.positionBefore, 'absolute')
      assert.equal(parsed.dyingAfter, false, 'la row a bien été ressuscitée (plus _mjs_dying)')
      assert.equal(
        parsed.positionAfter, '',
        "AVANT le fix : le node ressuscité restait bloqué en position:absolute (épinglage @flip jamais nettoyé)",
      )
      assert.equal(parsed.posFixedAfter, false, 'le flag _mjs_posFixed est réarmé par _mjs_unfixPosition')
    })
  })
})
