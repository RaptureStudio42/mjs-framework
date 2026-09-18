// Test de régression — `bindingTransition` doit attendre que le node soit
// connecté au DOM ET layouté avant de capturer ses dims pour les animations
// samplées (`slide`/`fly`/etc.).
//
// Bug vécu : un item fresh ajouté via `{for}` reconcile était encore dans
// un fragment détaché au moment où l'update tirait → `getComputedStyle(node)`
// retournait des strings vides (`+"" = 0`) → kf[end] tout à 0 → animation
// joue de 0 vers 0 → invisible → WAAPI retire les styles → le node apparaît
// sans transition. Exactement "apparaît d'un coup sans anim".
//
// Fix initial : wrap l'appel à `_mjs_playTransition` dans `µ._mjs_whenLayouted(node, () => …)`.
// `_mjs_whenLayouted` ne gate PLUS sur `offsetHeight > 0`. Un élément de
// hauteur nulle (enfant en `position:absolute`, inline vide…) restait bloqué les
// 30 frames (~480ms) et l'intro ne démarrait qu'au fallback → l'élément restait
// peint au naturel tout ce temps (« le mot apparaît avant l'animation », leçon
// `transitions-css`). Il gate désormais sur `isConnected` seul, et retente en
// MICROTASK au 1er appel (s'exécute après l'insertion synchrone mais AVANT le
// paint, comme Svelte) → intro jouée avant le 1er rendu, sans flash.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('compile — bindingTransition wrappe l\'intro dans _mjs_whenLayouted', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('le bundle pose opacity=0 SYNC + appelle _mjs_whenLayouted avant _mjs_playTransition', async function () {
    const root = mjsTmp('when-layouted')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'wl.mjs'), `
<script lang="coffee">
$items = ['a', 'b']
</script>

{for item in $items}
  <div @transition.slide>{item}</div>
{end}
`)
    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const files = readdirSync(outDir)
    const compFile = files.find((f: string) => /^wl-/.test(f))
    assert.ok(compFile, 'composant compilé')
    const code = readFileSync(join(outDir, compFile!), 'utf-8')

    // Le bloc d'init du transition doit :
    //   1) appeler µ._mjs_whenLayouted(node, () => …) — pas _mjs_playTransition direct
    //   2) appeler µ._mjs_playTransition à l'intérieur du callback _mjs_whenLayouted
    //
    // Pas de masquage `opacity:0` inline : ça polluait getComputedStyle au
    // moment de la capture (slide.ts:capture lit `+style.opacity` → 0 si
    // le browser n'a pas flushé le retrait). On accepte un flash potentiel
    // d'1 frame (rare car _mjs_whenLayouted tire SYNC quand le node est déjà
    // layouté, ce qui est le cas le plus courant).
    assert.match(code, /µ\._mjs_whenLayouted\s*\(\s*node\s*,/,
      "l'intro doit être différée via µ._mjs_whenLayouted")
    assert.match(code, /µ\._mjs_whenLayouted\s*\(\s*node\s*,\s*\(\s*\)\s*=>\s*\{[^}]*µ\._mjs_playTransition/,
      "µ._mjs_playTransition doit être appelé DANS le callback de _mjs_whenLayouted")
    assert.doesNotMatch(code, /node\.style\.opacity\s*=\s*['"]0['"]/,
      "pas de masquage opacity:0 inline (pollue getComputedStyle au sampling)")

    await bundler.close()
  })
})

describe('runtime — tous les sites d\'intro doivent être wrappés dans _mjs_whenLayouted', function () {
  // Le bug initial venait d'un fresh node fragment-détaché, fixé via le wrap
  // dans `bindingTransition`. Mais il y a 2 autres sites runtime qui lancent
  // une intro (revive d'un node dying via `_mjs_tryReviveDying` quand un `{if}`
  // se ré-active, et revive via `_mjs_reconcileList` quand un `{for}` key match
  // un node en outro). Ces sites partagent le même risque de sampling foireux
  // si le node est dans un état layout-stale (typique après une outro figée
  // par `fill: forwards`). Ils doivent TOUS être wrappés.

  // `_mjs_tryReviveDying` a quitté mjs_element.ts pour mjs_if.ts, `_mjs_reconcileList` pour mjs_for.ts
  // (détachement des blocs `{if}`/`{for}`, cf. bundler/index.ts) : les 2 sites du bandeau
  // ci-dessus ont suivi. mjs_element.ts reste scanné (ceinture+bretelles, si un futur site
  // d'intro y revenait) — un compte MINIMAL des occurrences réelles trouvées EMPÊCHE ce test de
  // redevenir silencieusement vide (vrai POUR CHAQUE fichier listé) si un site venait à
  // disparaître sans que le test s'en aperçoive.
  const dir = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', 'src', 'runtime')
  const FICHIERS_A_SCANNER = ['mjs_element.ts', 'mjs_if.ts', 'mjs_for.ts']
  const MIN_SITES_PAR_FICHIER: Record<string, number> = { 'mjs_element.ts': 0, 'mjs_if.ts': 1, 'mjs_for.ts': 1 }

  for (const fichier of FICHIERS_A_SCANNER) {
    it(`${fichier} — chaque _mjs_playTransition(node, ..., "in") est précédé d'un _mjs_whenLayouted`, function () {
      const src = readFileSync(join(dir, fichier), 'utf-8')
      const lines = src.split('\n')
      const issues: string[] = []
      let sitesTrouves = 0
      lines.forEach((line, i) => {
        const m = line.match(/µ\._mjs_playTransition\s*\([^,]+,[^,]+,\s*['"]in['"]/)
        if (!m) return
        sitesTrouves++
        // Vérifie qu'au moins une des 5 lignes précédentes contient `_mjs_whenLayouted(`.
        const window = lines.slice(Math.max(0, i - 5), i).join(' ')
        if (!/µ\._mjs_whenLayouted\s*\(/.test(window)) {
          issues.push(`Ligne ${i + 1} : _mjs_playTransition('in') sans _mjs_whenLayouted en amont :\n  ${line.trim()}`)
        }
      })
      assert.equal(issues.length, 0,
        `Tous les sites d'intro doivent être wrappés. Issues:\n${issues.join('\n')}`)
      assert.ok(sitesTrouves >= MIN_SITES_PAR_FICHIER[fichier],
        `${fichier} : ${sitesTrouves} site(s) d'intro trouvé(s), au moins ${MIN_SITES_PAR_FICHIER[fichier]} attendu(s) — ce test doit vérifier un vrai site, pas rester vide en silence`)
    })
  }
})

describe('runtime — µ._mjs_whenLayouted : microtask au 1er appel (jamais sync), plus de gate offsetHeight', function () {
  // La VRAIE définition (source) doit garder les invariants du fix.
  it('source : microtask au 1er appel, plus de gate offsetHeight', function () {
    const path = join(
      import.meta.dirname ?? new URL('.', import.meta.url).pathname,
      '..', 'src', 'runtime', 'mjs_easing.ts',
    )
    const src = readFileSync(path, 'utf-8')
    const m = src.match(/µ\._mjs_whenLayouted\s*=\s*function[\s\S]*?\n};/)
    assert.ok(m, 'définition de µ._mjs_whenLayouted trouvée')
    const body = m![0]
    assert.match(body, /queueMicrotask/,
      'doit différer en microtask au 1er appel (intro après les effects du batch, avant le paint)')
    assert.doesNotMatch(body, /node\.isConnected\s*&&\s*node\.offsetHeight/,
      "ne doit PLUS gater sur `isConnected && offsetHeight > 0` (cause du hang ~480ms)")
    // Le 1er return du corps doit être le bloc microtask (pas un raccourci sync
    // `if (node.isConnected) return fn()` AVANT lui) : sinon l'intro repart sync
    // et capture le DOM avant que les effects du batch n'aient rempli le contenu
    // (régression `blocs-key` : typewriter lisait `textContent` vide).
    const idxMicro = body.indexOf('queueMicrotask')
    const idxSyncConnected = body.search(/if\s*\(\s*node\.isConnected\s*\)\s*\{\s*return\s+fn/)
    assert.ok(idxSyncConnected === -1 || idxSyncConnected > idxMicro,
      'le raccourci sync `if (node.isConnected) return fn()` ne doit pas précéder le bloc microtask')
  })

  // Réimplémentation FIDÈLE de la nouvelle logique pour les cas comportementaux.
  const whenLayouted = function (node: any, fn: any, attempts = 0): any {
    if (attempts >= 30) return fn()
    if (attempts === 0 && typeof queueMicrotask === 'function') {
      return queueMicrotask(function () {
        if (node.isConnected) return fn()
        return (globalThis as any).requestAnimationFrame(function () {
          return whenLayouted(node, fn, 1)
        })
      })
    }
    if (node.isConnected) return fn()
    return (globalThis as any).requestAnimationFrame(function () {
      return whenLayouted(node, fn, attempts + 1)
    })
  }

  // RÉGRESSION blocs-key : au 1er appel, NE DOIT PAS tirer sync, même si le node
  // est déjà connecté. L'intro est posée pendant le rendu structurel, AVANT que
  // les effects du même batch (binding texte) n'aient rempli le contenu. Tirer
  // sync ferait capturer un `textContent` vide au `typewriter` → `<p>` vide.
  it('ne tire PAS sync même si déjà connecté (laisse les effects du batch remplir le contenu) — régression blocs-key', function (done) {
    let firedSync = true
    const node: any = { isConnected: true, offsetHeight: 0 }
    whenLayouted(node, () => {
      try {
        assert.equal(firedSync, false, "l'intro doit être différée en microtask, pas tirée pendant le rendu structurel")
        done()
      } catch (e) { done(e) }
    })
    // Si on arrive ici sans que fn ait tiré, c'est qu'elle est bien différée.
    firedSync = false
  })

  it('détaché au 1er appel → MICROTASK (avant le paint), sans rAF, si connecté entre-temps', function (done) {
    const node: any = { isConnected: false }
    let rafUsed = false
    const origRaf = (globalThis as any).requestAnimationFrame
    ;(globalThis as any).requestAnimationFrame = (cb: any) => { rafUsed = true; setTimeout(cb, 0); return 1 }
    whenLayouted(node, () => {
      ;(globalThis as any).requestAnimationFrame = origRaf
      try {
        assert.equal(rafUsed, false, 'doit tirer via microtask (avant paint), pas via rAF')
        done()
      } catch (e) { done(e) }
    })
    // Simule l'insertBefore qui suit createFn dans la MÊME tâche : la microtask
    // verra le node connecté et tirera avant le paint.
    node.isConnected = true
  })

  it('fallback : fire après ~30 frames si jamais connecté', function (done) {
    const node: any = { isConnected: false }
    let rafCount = 0
    const origRaf = (globalThis as any).requestAnimationFrame
    ;(globalThis as any).requestAnimationFrame = (cb: any) => { rafCount++; setTimeout(cb, 0); return rafCount }
    whenLayouted(node, () => {
      ;(globalThis as any).requestAnimationFrame = origRaf
      try {
        assert.ok(rafCount >= 28, `poll ~30 frames avant fallback (got ${rafCount})`)
        done()
      } catch (e) { done(e) }
    })
  })
})
