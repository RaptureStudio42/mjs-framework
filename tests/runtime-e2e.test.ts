// E2E runtime : compile un .mjs, charge le bundle dans happy-dom, vérifie
// que le custom element fonctionne (render, reactive update via µ._set).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('E2E runtime browser', () => {
  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('compose un Web Component fonctionnel et réagit aux updates', async function () {
    this.timeout(30000)

    // 1. Setup projet de test
    const root = mjsTmp('e2e-runtime')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    writeFileSync(join(srcDir, 'counter.mjs'), `
<script lang="coffee">
$count = 0
incr = => $count = $count + 1
</script>
<button @click={incr()}>Count: {$count}</button>
`)

    // 2. Build
    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `${stats.errors.map(e => e.message).join('\n')}`)

    // 3. Chargement dans happy-dom
    const window = new Window({ url: 'http://localhost/' })
    const document: any = window.document

    // Patch ESM imports : le bundle utilise des paths absolus que happy-dom
    // ne peut pas résoudre. On lit le contenu du runtime + composant et les
    // évalue dans le contexte de la window.
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const counterFile = files.find((f: string) => /^counter-/.test(f))
    assert.ok(coreFile && counterFile, 'core et counter doivent être compilés')

    // Strip ESM syntax pour eval — happy-dom n'a pas de loader module
    // (et pas de support import.meta en eval classique)
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const counterCode = stripEsm(readFileSync(join(outDir, counterFile!), 'utf-8'))

    // Eval dans le contexte window (HTMLElement, customElements, etc.
    // sont fournis par happy-dom)
    try {
      window.eval(`
        ${coreCode}
        // Re-binder µ globalement pour que le composant le voie
        globalThis.µ = µ;
        ${counterCode}
      `)
    } catch (e: any) {
      throw new Error(`Eval bundle dans happy-dom : ${e.message}`)
    }

    // 4. Crée l'instance et vérifie le rendu
    const tag = 'mjs-counter'
    assert.ok(window.customElements.get(tag), `${tag} doit être enregistré`)

    document.body.innerHTML = `<${tag}></${tag}>`
    const el: any = document.body.firstElementChild

    // Attendre microtask pour que le premier render ait lieu
    await new Promise(r => setTimeout(r, 50))

    const button = el._shadow?.querySelector('button')
    assert.ok(button, 'le shadow root doit contenir un button')
    assert.match(button.textContent ?? '', /Count: 0/, 'render initial à 0')

    // 5. Trigger reactive update via µ._set
    window.eval(`
      const els = document.querySelectorAll('${tag}');
      µ._set(els[0], 'count', 5);
    `)
    await new Promise(r => setTimeout(r, 50))
    assert.match(button.textContent ?? '', /Count: 5/, 'render mis à jour à 5')

    window.close?.()
  })

  it('mode mjs-light : composant sans Shadow DOM, enfants visibles depuis document', async function () {
    this.timeout(30000)

    const root = mjsTmp('e2e-light')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    writeFileSync(join(srcDir, 'plain.mjs'), `
<script lang="coffee">
$label = "Hello Light"
</script>
<p class="light-target">{$label}</p>
`)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `${stats.errors.map(e => e.message).join('\n')}`)

    const window = new Window({ url: 'http://localhost/' })
    const document: any = window.document

    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const lightFile = files.find((f: string) => /^plain-/.test(f))
    assert.ok(coreFile && lightFile, 'core et plain doivent être compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const lightCode = stripEsm(readFileSync(join(outDir, lightFile!), 'utf-8'))

    try {
      window.eval(`
        ${coreCode}
        globalThis.µ = µ;
        ${lightCode}
      `)
    } catch (e: any) {
      throw new Error(`Eval bundle dans happy-dom : ${e.message}`)
    }

    const tag = 'mjs-plain'
    // happy-dom ne respecte pas l'ordre spec HTML (attributs posés AVANT
    // constructor à l'upgrade). On contourne en patchant la classe avec
    // `static mjsLight = true` — fallback documenté du mode light.
    window.eval(`
      const Klass = customElements.get('${tag}');
      if (Klass) Klass.mjsLight = true;
    `)
    document.body.innerHTML = `<${tag}></${tag}>`
    const el: any = document.body.firstElementChild

    await new Promise(r => setTimeout(r, 50))

    // _mjs_isLight doit être true
    assert.equal(el._mjs_isLight, true, 'flag _mjs_isLight doit être positionné')

    // _shadow doit pointer sur le composant lui-même
    assert.equal(el._shadow, el, '_shadow doit pointer sur this en light mode')

    // En light mode : le <p> doit être trouvable directement depuis document
    // (pas dans un shadowRoot)
    const pLight = document.querySelector('.light-target')
    assert.ok(pLight, 'le <p class="light-target"> doit être visible depuis document.querySelector')
    assert.match(pLight.textContent ?? '', /Hello Light/, 'texte initial rendu')

    window.close?.()
  })

  it('collision IDs : node avec 2 bindings (event + binding) garde son event', async function () {
    this.timeout(30000)

    const root = mjsTmp('e2e-collision')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    // Composant : un bouton avec @click ET un binding réactif sur class
    // (les deux bindings ciblent le même node).
    writeFileSync(join(srcDir, 'multi.mjs'), `
<script lang="coffee">
$count = 0
$active = "active"
incr = => $count = $count + 1
</script>
<button @click={incr()} class={$active}>Hits: {$count}</button>
`)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `${stats.errors.map(e => e.message).join('\n')}`)

    const window = new Window({ url: 'http://localhost/' })
    const document: any = window.document

    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const multiFile = files.find((f: string) => /^multi-/.test(f))
    assert.ok(coreFile && multiFile, 'core et multi doivent être compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const multiCode = stripEsm(readFileSync(join(outDir, multiFile!), 'utf-8'))

    try {
      window.eval(`
        ${coreCode}
        globalThis.µ = µ;
        ${multiCode}
      `)
    } catch (e: any) {
      throw new Error(`Eval bundle dans happy-dom : ${e.message}`)
    }

    const tag = 'mjs-multi'
    document.body.innerHTML = `<${tag}></${tag}>`
    const el: any = document.body.firstElementChild

    await new Promise(r => setTimeout(r, 50))

    const button = el._shadow?.querySelector('button')
    assert.ok(button, 'le shadow root doit contenir un button')
    assert.match(button.textContent ?? '', /Hits: 0/, 'render initial')

    // Le node doit porter un tableau d'ids en prop `_mjs_ids` (fix
    // collision), au lieu d'une WeakMap.
    const ids = button._mjs_ids
    if (ids) {
      assert.ok(Array.isArray(ids), 'button._mjs_ids doit être un tableau')
    }

    // Click → incrémente le compteur (vérifie que le routing événementiel
    // n'est pas cassé par la double-annotation).
    button.click()
    await new Promise(r => setTimeout(r, 50))
    assert.match(button.textContent ?? '', /Hits: 1/, 'click doit incrémenter le compteur')

    window.close?.()
  })

  // ==========================================================================
  // Filtered Dispatch runtime sanity check
  //
  // Vérifie que :
  //   - Le pattern `row.id === $selected` génère bien un index `_mjs_filt[<clé>].idx`.
  //   - Au mute de `$selected`, SEULES 2 rows (ancienne + nouvelle) sont mises
  //     à jour, pas N. Validé en instrumentant `classList.toggle`.
  //   - `_mjs_renderStruct` est skipé (la var ne pilote pas l'iterable).
  // ==========================================================================
  it('filtered dispatch : mute de $selected ne touche que 2 rows sur 100', async function () {
    this.timeout(30000)

    const root = mjsTmp('e2e-filtered')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    writeFileSync(join(srcDir, 'sel100.mjs'), `
<script lang="coffee">
$rows = []
i = 0
while i < 100
  $rows.push({id: i, label: "row" + i})
  i++
$selected = -1
</script>
{for row in $rows}
  <div @class{row.id === $selected}="danger">{row.label}</div>
{end}
`)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `${stats.errors.map(e => e.message).join('\n')}`)

    const window = new Window({ url: 'http://localhost/' })
    const document: any = window.document

    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const selFile = files.find((f: string) => /^sel100-/.test(f))
    assert.ok(coreFile && selFile, 'core et sel100 doivent être compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const selCode = stripEsm(readFileSync(join(outDir, selFile!), 'utf-8'))

    window.eval(`${coreCode}\nglobalThis.µ = µ;\n${selCode}`)

    const tag = 'mjs-sel100'
    document.body.innerHTML = `<${tag}></${tag}>`
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 200))

    // 100 rows rendues, _filtIdx contient 100 entries.
    const divs = el._shadow?.querySelectorAll('div')
    assert.equal(divs?.length, 100, '100 rows attendues')
    // La clé exacte porte un suffixe `__<lid>` depuis un fix antérieur
    // (distingue 2 nœuds d'une même row partageant le même (var, classe)) —
    // on la retrouve par préfixe plutôt que de figer sa valeur exacte.
    const filtIdxKey = Object.keys(el._mjs_filt ?? {}).find((k) => k.startsWith('selected__danger'))
    assert.ok(filtIdxKey, 'une entrée _mjs_filt[selected__danger*] doit exister')
    assert.equal(
      el._mjs_filt[filtIdxKey!]?.idx?.size, 100,
      '_mjs_filt[selected__danger*].idx doit contenir 100 entrées (1 par row)',
    )

    // Instrumente _mjs_renderStruct pour vérifier qu'il NE tourne PAS à chaque set.
    let renderStructCalled = 0
    const origStruct = el._mjs_renderStruct.bind(el)
    el._mjs_renderStruct = function() { renderStructCalled++; return origStruct() }

    // Instrumente classList.toggle sur chaque div pour compter les touches.
    let togglesCalled = 0
    divs.forEach((d: any) => {
      const orig = d.classList.toggle.bind(d.classList)
      d.classList.toggle = (...args: any[]) => { togglesCalled++; return orig(...args) }
    })

    // 1er set : sélectionne row 50. Prev était -1 (absent du Map) → 1 toggle.
    window.eval(`
      const els = document.querySelectorAll('${tag}');
      µ._set(els[0], 'selected', 50);
    `)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(togglesCalled, 1, "1er set : seul row 50 doit être touché (prev=-1 n'existe pas)")
    assert.equal(divs[50].className, 'danger', 'row 50 doit avoir la classe danger')

    togglesCalled = 0

    // 2e set : sélectionne row 75. prev=50, curr=75 → 2 toggles.
    window.eval(`
      const els = document.querySelectorAll('${tag}');
      µ._set(els[0], 'selected', 75);
    `)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(togglesCalled, 2, '2e set : exactly 2 toggles (prev=50, curr=75)')
    assert.equal(divs[50].className, '', 'row 50 ne doit plus avoir danger')
    assert.equal(divs[75].className, 'danger', 'row 75 doit avoir danger')

    // _mjs_renderStruct ne doit JAMAIS être appelé sur ces sets (selected ne pilote
    // pas l'iterable $rows).
    assert.equal(
      renderStructCalled, 0,
      '_mjs_renderStruct ne doit PAS tourner sur un mute de selected (filtered dispatch)',
    )

    window.close?.()
  })

  // ==========================================================================
  // Anti-leak filtered dispatch
  //
  // Vérifie que quand on supprime des rows (destroy), les entries
  // correspondantes dans `_mjs_filt[<X>].idx` sont purgées. Sinon la Map garde des
  // closures qui capturent les nodes DOM détruits → fuite mémoire sur les
  // apps cycliques (feed-scroll-infini, benchs create/clear×N).
  // ==========================================================================
  it('filtered dispatch : purge les filtered indexes au destroy des rows', async function () {
    this.timeout(30000)

    const root = mjsTmp('e2e-leak')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    // NB : on initialise $rows avec 100 entries au mount (pour que le 1er
    // render-struct fire en mode fullRender). Le test couvre ensuite les
    // réductions (set rows = 50 / 0) et re-grossissements (set rows = 50).
    writeFileSync(join(srcDir, 'leak100.mjs'), `
<script lang="coffee">
$rows = []
i = 0
while i < 100
  $rows.push({id: i, label: "row" + i})
  i++
$selected = -1
</script>
{for row in $rows}
  <div @class{row.id === $selected}="danger">{row.label}</div>
{end}
`)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `${stats.errors.map(e => e.message).join('\n')}`)

    const window = new Window({ url: 'http://localhost/' })
    const document: any = window.document

    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const leakFile = files.find((f: string) => /^leak100-/.test(f))
    assert.ok(coreFile && leakFile, 'core et leak100 doivent être compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const leakCode = stripEsm(readFileSync(join(outDir, leakFile!), 'utf-8'))

    window.eval(`${coreCode}\nglobalThis.µ = µ;\n${leakCode}`)

    const tag = 'mjs-leak100'
    document.body.innerHTML = `<${tag}></${tag}>`
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 200))

    // Helper : génère un littéral JS array de N rows (inline dans l'eval).
    const rowsLit = (n: number) => {
      const items: string[] = []
      for (let i = 0; i < n; i++) items.push(`{id:${i},label:"row${i}"}`)
      return `[${items.join(',')}]`
    }

    // 0. État initial : mount avec 100 rows pré-remplies → 100 entrées.
    // La clé exacte porte un suffixe `__<lid>` depuis un fix antérieur
    // (distingue 2 nœuds d'une même row partageant le même (var, classe)) —
    // on la retrouve par préfixe plutôt que de figer sa valeur exacte.
    const filtIdxKey = Object.keys(el._mjs_filt ?? {}).find((k) => k.startsWith('selected__danger'))
    assert.ok(filtIdxKey, 'une entrée _mjs_filt[selected__danger*] doit exister')
    assert.equal(
      el._mjs_filt[filtIdxKey!]?.idx?.size, 100,
      'mount : 100 entrées attendues dans _mjs_filt[…].idx (rows pré-remplies)',
    )
    // _mjs_filtIdxKeys côté window (instance Set du context happy-dom : pas
    // `instanceof Set` côté node-test → on check l'interface .has à la place).
    assert.ok(el._mjs_filtIdxKeys && typeof el._mjs_filtIdxKeys.has === 'function',
      '_mjs_filtIdxKeys doit être un Set (interface .has)')
    assert.ok(el._mjs_filtIdxKeys.has(filtIdxKey!),
      `_mjs_filtIdxKeys doit contenir la clé ${filtIdxKey}`)

    // 2. Détruire la moitié (garder 50 premières rows). La Map doit
    // automatiquement perdre 50 entrées.
    // NB : on assigne directement puis force _mjs_renderStruct car le scheduler
    // microtask de happy-dom n'enchaîne pas avec setTimeout natif côté node.
    // L'objet du test est la purge filtered, pas le scheduler.
    window.eval(`
      const els = document.querySelectorAll('${tag}');
      els[0]._state.rows = ${rowsLit(50)};
      els[0]._mjs_renderStruct();
    `)
    await new Promise(r => setTimeout(r, 50))

    assert.equal(
      el._mjs_filt[filtIdxKey!]?.idx?.size, 50,
      'après set rows=50 : 50 entrées attendues (50 purgées au destroy)',
    )

    // 3. Tout vider : la Map doit être vide.
    window.eval(`
      const els = document.querySelectorAll('${tag}');
      els[0]._state.rows = [];
      els[0]._mjs_renderStruct();
    `)
    await new Promise(r => setTimeout(r, 50))

    assert.equal(
      el._mjs_filt[filtIdxKey!]?.idx?.size, 0,
      'après set rows=[] : 0 entrées attendues (full clear)',
    )

    // 4. Cycle create/clear×3 : la Map ne doit PAS accumuler des entries
    // mortes. Vérifie que la purge marche aussi en re-création (pool).
    for (let cycle = 0; cycle < 3; cycle++) {
      window.eval(`
        const els = document.querySelectorAll('${tag}');
        els[0]._state.rows = ${rowsLit(50)};
        els[0]._mjs_renderStruct();
      `)
      await new Promise(r => setTimeout(r, 30))
      assert.equal(
        el._mjs_filt[filtIdxKey!]?.idx?.size, 50,
        `cycle ${cycle} : 50 entrées attendues après refill (pas d'accumulation)`,
      )
      window.eval(`
        const els = document.querySelectorAll('${tag}');
        els[0]._state.rows = [];
        els[0]._mjs_renderStruct();
      `)
      await new Promise(r => setTimeout(r, 30))
      assert.equal(
        el._mjs_filt[filtIdxKey!]?.idx?.size, 0,
        `cycle ${cycle} : 0 entrées attendues après clear`,
      )
    }

    window.close?.()
  })

  // ==========================================================================
  // Filtered Dispatch étendu : @style.X={ternaire} dans {for}
  //
  // Vérifie qu'au mute de `$selected`, SEULS 2 styles changent (ancien et
  // nouveau row), pas 1000. Validé en instrumentant `style.setProperty`.
  // ==========================================================================
  it('filtered dispatch (@style.X) : mute extern ne touche que 2 styles sur 100', async function () {
    this.timeout(30000)

    const root = mjsTmp('e2e-fstyle')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    writeFileSync(join(srcDir, 'fstyle100.mjs'), `
<script lang="coffee">
$rows = []
i = 0
while i < 100
  $rows.push({id: i, label: "row" + i})
  i++
$selected = -1
</script>
{for row in $rows}
  <div @style.color={row.id === $selected ? 'red' : 'black'}>{row.label}</div>
{end}
`)
    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `${stats.errors.map(e => e.message).join('\n')}`)

    const window = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^fstyle100-/.test(f))
    assert.ok(coreFile && compFile, 'core et fstyle100 doivent être compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
    window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    const tag = 'mjs-fstyle100'
    document.body.innerHTML = `<${tag}></${tag}>`
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 200))

    const divs = el._shadow?.querySelectorAll('div')
    assert.equal(divs?.length, 100, '100 rows attendues')
    // Suffixe `__<lid>` depuis un fix antérieur — voir commentaire
    // similaire plus haut dans ce fichier.
    const filtIdxKeyStyle = Object.keys(el._mjs_filt ?? {}).find((k) => k.startsWith('selected__style_color'))
    assert.ok(filtIdxKeyStyle, 'une entrée _mjs_filt[selected__style_color*] doit exister')
    assert.equal(
      el._mjs_filt[filtIdxKeyStyle!]?.idx?.size, 100,
      '_mjs_filt[selected__style_color*].idx doit contenir 100 entrées',
    )

    // Instrumente setProperty sur chaque div.style pour compter les touches.
    let stylesSet = 0
    divs.forEach((d: any) => {
      const orig = d.style.setProperty.bind(d.style)
      d.style.setProperty = (...args: any[]) => { stylesSet++; return orig(...args) }
    })

    // 1er set : sélectionne row 50. Prev=-1 absent → 1 set.
    window.eval(`
      const els = document.querySelectorAll('${tag}');
      µ._set(els[0], 'selected', 50);
    `)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(stylesSet, 1, "1er set : 1 seul style modifié (prev=-1 absent)")

    stylesSet = 0
    // 2e set : sélectionne row 75. prev=50, curr=75 → 2 sets.
    window.eval(`
      const els = document.querySelectorAll('${tag}');
      µ._set(els[0], 'selected', 75);
    `)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(stylesSet, 2, '2e set : exactly 2 styles modifiés (prev=50, curr=75)')

    window.close?.()
  })

  // ==========================================================================
  // Filtered Dispatch étendu : data-X={bool} dans {for}
  //
  // Vérifie qu'au mute de `$selected`, SEULS 2 setAttribute sont appelés
  // (ancien et nouveau row), pas 1000.
  // ==========================================================================
  it('filtered dispatch (data-X) : mute extern ne touche que 2 attrs sur 100', async function () {
    this.timeout(30000)

    const root = mjsTmp('e2e-fattr')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    writeFileSync(join(srcDir, 'fattr100.mjs'), `
<script lang="coffee">
$rows = []
i = 0
while i < 100
  $rows.push({id: i, label: "row" + i})
  i++
$selected = -1
</script>
{for row in $rows}
  <div data-active={row.id === $selected}>{row.label}</div>
{end}
`)
    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `${stats.errors.map(e => e.message).join('\n')}`)

    const window = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^fattr100-/.test(f))
    assert.ok(coreFile && compFile, 'core et fattr100 doivent être compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
    window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    const tag = 'mjs-fattr100'
    document.body.innerHTML = `<${tag}></${tag}>`
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 200))

    const divs = el._shadow?.querySelectorAll('div')
    assert.equal(divs?.length, 100, '100 rows attendues')
    // Suffixe `__<lid>` depuis un fix antérieur — voir commentaire
    // similaire plus haut dans ce fichier.
    const filtIdxKeyAttr = Object.keys(el._mjs_filt ?? {}).find((k) => k.startsWith('selected__attr_data_active'))
    assert.ok(filtIdxKeyAttr, 'une entrée _mjs_filt[selected__attr_data_active*] doit exister')
    assert.equal(
      el._mjs_filt[filtIdxKeyAttr!]?.idx?.size, 100,
      '_mjs_filt[selected__attr_data_active*].idx doit contenir 100 entrées',
    )

    // Instrumente setAttribute sur chaque div pour compter.
    let attrsSet = 0
    divs.forEach((d: any) => {
      const orig = d.setAttribute.bind(d)
      d.setAttribute = (...args: any[]) => { attrsSet++; return orig(...args) }
    })

    // 1er set : sélectionne row 50. Prev=-1 absent → 1 setAttribute.
    window.eval(`
      const els = document.querySelectorAll('${tag}');
      µ._set(els[0], 'selected', 50);
    `)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(attrsSet, 1, '1er set : 1 seul attr modifié (prev=-1 absent)')
    assert.equal(divs[50].getAttribute('data-active'), 'true',
      'row 50 doit avoir data-active=true')

    attrsSet = 0
    window.eval(`
      const els = document.querySelectorAll('${tag}');
      µ._set(els[0], 'selected', 75);
    `)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(attrsSet, 2, '2e set : exactly 2 attrs modifiés (prev=50, curr=75)')
    assert.equal(divs[50].getAttribute('data-active'), 'false',
      'row 50 doit avoir data-active=false')
    assert.equal(divs[75].getAttribute('data-active'), 'true',
      'row 75 doit avoir data-active=true')

    window.close?.()
  })

  // ==========================================================================
  // Bug-fix — `_mjs_renderStruct` doit tourner sur mute externe d'une var
  // pilotant un `{for}` MÊME SI le composant n'a aucun `µ.effect()` user.
  //
  // Avant le fix : cette optimisation (skip alloc `_mjs_lastMutedVars` quand pas
  // d'effects user) faisait que le slow-path microtask voyait
  // `_mjs_lastMutedVars === null` → la boucle de check `_mjs_renderStructVars` ne
  // s'exécutait pas → `_mjs_renderStruct` jamais appelé → DOM jamais re-rendu.
  //
  // Reproduction : composant avec `{for row in $rows}` + AUCUN `µ.effect()`,
  // muter `$rows` externalement via `µ._set(el, 'rows', newArr)`.
  // ==========================================================================
  it('correctif : _mjs_renderStruct fire sans effects user au mute externe', async function () {
    this.timeout(30000)

    const root = mjsTmp('e2e-o58')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    // Volontairement aucun `µ.effect()` ni interpolation directe de
    // `$rows` hors du `{for}` → `_mjs_effectsByVar['rows']` sera vide,
    // forçant le slow-path microtask dans `_mjs_invalidate`. Seul
    // `_mjs_renderStructVars` contient `rows`.
    writeFileSync(join(srcDir, 'o58list.mjs'), `
<script lang="coffee">
$rows = [{id: 1, label: "A"}, {id: 2, label: "B"}]
</script>
{for row in $rows}
  <div class="row">{row.label}</div>
{end}
`)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `${stats.errors.map(e => e.message).join('\n')}`)

    const window = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^o58list-/.test(f))
    assert.ok(coreFile && compFile, 'core et o58list doivent être compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
    window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    const tag = 'mjs-o58list'
    document.body.innerHTML = `<${tag}></${tag}>`
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 100))

    // Sanity : 2 rows au mount
    let divs = el._shadow?.querySelectorAll('div.row')
    assert.equal(divs?.length, 2, '2 rows attendues au mount initial')
    assert.equal(divs[0].textContent.trim(), 'A')
    assert.equal(divs[1].textContent.trim(), 'B')

    // Sanity : aucun `µ.effect()` user → `_mjs_effects` vide / absent.
    // C'est ce qui déclenchait cette optimisation.
    const hasUserEffects = !!(el._mjs_effects && el._mjs_effects.length > 0)
    assert.equal(hasUserEffects, false,
      'le composant ne doit avoir AUCUN effect user (sinon le bug ne se reproduit pas)')

    // Sanity : `_mjs_renderStructVars` contient bien `rows`
    assert.equal(el._mjs_renderStructVars?.rows, 1,
      '_mjs_renderStructVars.rows doit être 1 (var pilote le {for})')

    // Mute externe : remplace $rows par 4 nouveaux items.
    // Avant le fix : `_mjs_renderStruct` jamais appelé → DOM toujours 2 rows.
    // Après le fix : DOM passe à 4 rows correctement.
    window.eval(`
      const els = document.querySelectorAll('${tag}');
      µ._set(els[0], 'rows', [
        {id: 10, label: "W"},
        {id: 20, label: "X"},
        {id: 30, label: "Y"},
        {id: 40, label: "Z"},
      ]);
    `)
    await new Promise(r => setTimeout(r, 100))

    divs = el._shadow?.querySelectorAll('div.row')
    assert.equal(divs?.length, 4,
      'après mute externe `µ._set(el, "rows", newArr)`, le DOM doit refléter 4 rows ' +
      '(avant le bug-fix il restait à 2)')
    assert.equal(divs[0].textContent.trim(), 'W')
    assert.equal(divs[1].textContent.trim(), 'X')
    assert.equal(divs[2].textContent.trim(), 'Y')
    assert.equal(divs[3].textContent.trim(), 'Z')

    window.close?.()
  })
})
