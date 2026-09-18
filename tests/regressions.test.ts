// Tests anti-régression — bugs corrigés après une relecture visuelle des
// tutos/docs. Chaque test verrouille un fix spécifique pour
// éviter qu'il ne casse à nouveau lors de futures optimisations.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { transpile } from '../src/transpiler/index.js'
import { resolveBundlerOpts } from '../src/bundler/config.js'
import { ASSET_RE } from '../src/bundler/index.js'

describe('régressions — fix nuit V2.0', function () {
  // Timeout étendu : transpile() recharge des compilateurs lourds (Civet) au
  // premier appel d'une suite, ce qui peut dépasser 2s à froid.
  this.timeout(8000)

  // --------------------------------------------------------------------------
  // Bug #1 — `@persist` après <style>/<script>/HTML doit être extrait
  // --------------------------------------------------------------------------
  describe('@persist position', () => {
    it("extrait @persist même quand placé après <script>/HTML", async () => {
      // Pas de <style> pour éviter d'invoquer le compilateur sass
      // (qui peut interagir avec la config locale dans certains setups).
      const src = [
        '<script>$foo = ""</script>',
        '@persist session: $foo by: window.location.hash',
        '<div>{$foo}</div>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg1a' })
      // La directive ne doit pas fuiter dans l'output JS final
      assert.doesNotMatch(output, /^[ \t]*@persist/m, "@persist ne doit pas fuir dans l'output")
      // Le code de persistance doit être généré (sessionStorage)
      assert.match(output, /sessionStorage/, 'code persist (sessionStorage) doit être généré')
    })

    it("préserve @persist DANS <pre><code> (exemple de doc)", async () => {
      const src = [
        '<script>$x = 1</script>',
        '<pre><code>@persist session: $foo</code></pre>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg1b' })
      // Le @persist DANS le <code> est un exemple : il doit rester texte préservé.
      assert.match(output, /@persist session:/, '@persist dans <code> doit être préservé en texte')
      // Et aucun code persist ne doit être généré pour ce $foo (rien à persister).
      assert.doesNotMatch(output, /sessionStorage\.getItem\([^)]*foo[^)]*\)/, 'pas de code persist pour exemple doc')
    })
  })

  // --------------------------------------------------------------------------
  // Bug #2 — Interpolation d'une var locale non-réactive (`:=`)
  //          doit produire un effect "mount only" (exécuté une fois à l'init)
  // --------------------------------------------------------------------------
  describe('interpolation non-réactive (mount-only effect)', () => {
    it("interpolation `{name}` d'une const locale `:=` produit un effect mount-only", async () => {
      const src = [
        '<script>',
        '  name := "world"',
        '</script>',
        '<h1>Hello {name.toUpperCase()}!</h1>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg2', defaultScriptLang: 'civet' })
      // Le tableau _mjs_eff doit contenir au moins un effect (pas []).
      assert.doesNotMatch(output, /const _mjs_eff = \[\][\s;]/, '_mjs_eff ne doit pas être vide')
      // L'effect doit appeler _mjs_updText pour name.toUpperCase()
      assert.match(output, /_mjs_updText\(['"][^'"]+['"],\s*name\.toUpperCase\(\)/, '_mjs_updText pour name doit être généré')
      // _mjs_effectsByVar reste vide car aucune var réactive — l'effect est dans _mjs_effectsAll uniquement.
      assert.match(output, /_mjs_effectsByVar\s*=\s*\{\}/, '_mjs_effectsByVar doit être vide pour var non-réactive')
    })
  })

  // --------------------------------------------------------------------------
  // Bug #3 — `stylesheetsDir` du mjs.config.json doit être transmis au Bundler
  //          (sinon les .sass/.scss/.css partagés ne sont jamais bundlés)
  // --------------------------------------------------------------------------
  describe('resolveBundlerOpts — stylesheetsDir', () => {
    it("résout stylesheetsDir relativement au configDir", () => {
      const opts = resolveBundlerOpts(
        { stylesheetsDir: 'custom/styles' },
        '/project'
      )
      assert.equal(opts.stylesheetsDir, '/project/custom/styles', 'stylesheetsDir doit être résolu absolu')
    })

    it("stylesheetsDir undefined si non spécifié", () => {
      const opts = resolveBundlerOpts({}, '/project')
      assert.equal(opts.stylesheetsDir, undefined, 'stylesheetsDir doit être undefined si non spécifié')
    })
  })

  // --------------------------------------------------------------------------
  // Bug #5 — `@import` paths doivent être pré-résolus par le master AVANT
  //          d'être passés au worker. Sinon le worker écrit
  //          `/MISSING_MJS_ASSET:xxx` et le master ne rattrape PLUS car le
  //          pattern `µasset(...)` est déjà substitué.
  // --------------------------------------------------------------------------
  describe('@import — pré-résolution master', () => {
    it("`@import` génère un µasset(...) qui doit être résolu (pas MISSING)", async () => {
      // Test direct du transpiler : on lui passe un resolveAsset qui simule
      // un asset existant (résout vers une URL hashée).
      const src = [
        "@import helper 'shared/utils.module.civet'",
        '<script>$x = helper()</script>',
        '<div>{$x}</div>',
      ].join('\n')

      // Stub resolveAsset : substitue tout path en URL hashée fictive.
      const resolved: string[] = []
      const resolveAsset = async (p: string) => {
        resolved.push(p)
        return `/assets/modularJS_compiled/utils-DEADBEEF.js`
      }

      const { output } = await transpile(src, {
        moduleName: 'reg5',
        defaultScriptLang: 'civet',
        resolveAsset,
      })

      // Le path doit avoir été demandé à resolveAsset
      assert.ok(
        resolved.includes('shared/utils.module.civet'),
        `resolveAsset doit avoir été appelé avec 'shared/utils.module.civet' (appelés: ${JSON.stringify(resolved)})`
      )
      // L'output ne doit PAS contenir MISSING_MJS_ASSET pour ce path
      assert.doesNotMatch(
        output,
        /MISSING_MJS_ASSET:shared\/utils\.module\.civet/,
        "L'output ne doit pas contenir MISSING_MJS_ASSET (path résolu)"
      )
      // L'output doit contenir l'URL résolue
      assert.match(
        output,
        /utils-DEADBEEF\.js/,
        "L'output doit contenir l'URL résolue de l'asset"
      )
    })
  })

  // --------------------------------------------------------------------------
  // Bug #6 — Sugar `auto-declare` ne doit PAS promouvoir une réassignation
  //          de var déjà déclarée via `.=` dans un scope parent (bug
  //          `tuto#etat-brut`, mais expose un défaut systémique civet).
  // --------------------------------------------------------------------------
  describe('sugar — auto-declare scope-aware (bugs closure)', () => {
    it("`IDENT .= 50` au top-level + `IDENT = val` dans nested ne réintroduit PAS `.=`", async () => {
      // applyMjsSugarToScript est utilisée AVANT le compilateur Civet/Coffee.
      // Sans ce fix, le `previous = value` dans la closure était promu en
      // `previous .= value` → Civet émettait `let previous = value` (shadow
      // local) → ReferenceError au runtime quand la closure lit previous.
      const { applyMjsSugarToScript } = await import('../src/transpiler/index.js')
      const src = [
        'previous .= 50',
        'next .= ->',
        '  value := previous + 1',
        '  previous = value',
        '  value',
      ].join('\n')
      const out = applyMjsSugarToScript(src)
      // La ligne nested doit rester `previous = value` (pas `previous .= value`)
      assert.match(out, /^\s+previous = value/m, 'nested previous = value doit rester tel quel')
      assert.doesNotMatch(out, /^\s+previous \.= value/m, "ne doit PAS être promu en `.=` (shadow)")
    })

    it("`IDENT := value` au top-level enregistre IDENT comme déclaré (pas re-promu en nested)", async () => {
      const { applyMjsSugarToScript } = await import('../src/transpiler/index.js')
      const src = [
        'x := 10',
        'foo .= ->',
        '  x = 20',
        '  x',
      ].join('\n')
      const out = applyMjsSugarToScript(src)
      assert.match(out, /^\s+x = 20/m, 'nested x = 20 doit rester tel quel')
      assert.doesNotMatch(out, /^\s+x \.= 20/m, "ne doit PAS être promu en `.=`")
    })
  })

  // --------------------------------------------------------------------------
  // "Bonus mémoire" (transpiler:627) — `nom = => expr` (fat arrow) jamais
  // auto-déclaré, contrairement à `nom = -> expr` qui fonctionnait déjà.
  // --------------------------------------------------------------------------
  describe("sugar — auto-declare civet : `nom = => …` (fat arrow) au même titre que `nom = -> …`", () => {
    it("`nom = -> …` (baseline, déjà correct) : promu en `.=`", async () => {
      const { applyMjsSugarToScript } = await import('../src/transpiler/index.js')
      const out = applyMjsSugarToScript(`nom = -> console.log('hi')`, 'civet')
      assert.match(out, /^nom \.= -> console\.log/, 'doit être promu en déclaration .=')
    })

    it("`nom = => …` (le bug) : promu en `.=` lui aussi", async () => {
      const { applyMjsSugarToScript } = await import('../src/transpiler/index.js')
      const out = applyMjsSugarToScript(`nom = => console.log('hi')`, 'civet')
      assert.match(out, /^nom \.= => console\.log/,
        "AVANT le fix : `[^=]` après le `\\s+` excluait le premier caractère de `=>` — jamais promu, " +
        "restait une assignation NUE → ReferenceError au runtime (module ES toujours strict)")
    })

    it("bout-en-bout (transpile réel) : `nom = => …` produit une VRAIE déclaration dans le composant compilé", async () => {
      const src = `<script lang="civet">
nom = => console.log('hi')
</script>
<p>hi</p>
`
      const { output } = await transpile(src, { moduleName: 'fatarrowfix' })
      assert.match(output, /\blet nom = \(\) => console\.log\('hi'\)/,
        "AVANT le fix : `nom = () => console.log('hi')` SANS aucun let/var/const — ReferenceError garanti à l'exécution")
    })

    it("re-assignation d'un nom DÉJÀ déclaré (`:=`) avec un `=>` en RHS : pas de re-déclaration/shadow", async () => {
      const { applyMjsSugarToScript } = await import('../src/transpiler/index.js')
      const src = [
        'handler := 1',
        'wrapper .= ->',
        '  handler = => console.log(1)',
        '  handler',
      ].join('\n')
      const out = applyMjsSugarToScript(src, 'civet')
      assert.match(out, /^\s+handler = => console\.log\(1\)/m, 'reste une réassignation simple')
      assert.doesNotMatch(out, /^\s+handler \.= => console\.log\(1\)/m,
        'ne doit PAS être re-promu en .= (shadow local qui casserait la fermeture, même famille de bug que Bug #6 ci-dessus)')
    })

    it("Coffee (auto-déclare nativement) : cette passe est un no-op, `=>` fonctionne déjà sans `.=`", async () => {
      const { applyMjsSugarToScript } = await import('../src/transpiler/index.js')
      const out = applyMjsSugarToScript(`nom = => console.log('hi')`, 'coffee')
      assert.doesNotMatch(out, /\.=/, "Coffee ne doit JAMAIS voir de `.=` injecté (syntaxe civet uniquement)")
    })
  })

  describe('lintUndeclaredTopLevelAssignment — filet de sécurité', () => {
    it("assignation nue à un nom JAMAIS déclaré (civet) : erreur explicite, pas un ReferenceError runtime silencieux", async () => {
      const { lintUndeclaredTopLevelAssignment } = await import('../src/transpiler/index.js')
      assert.throws(
        () => lintUndeclaredTopLevelAssignment(`nom = function() { return 1; }`, 'civet'),
        /nom.*jamais déclaré.*nom := /s
      )
    })

    it('nom déclaré via let/const/var ailleurs dans le script : pas de faux positif', async () => {
      const { lintUndeclaredTopLevelAssignment } = await import('../src/transpiler/index.js')
      assert.doesNotThrow(() => lintUndeclaredTopLevelAssignment(`let nom;\nnom = function() { return 1; }`, 'civet'))
    })

    it('externalVars (import) : pas de faux positif', async () => {
      const { lintUndeclaredTopLevelAssignment } = await import('../src/transpiler/index.js')
      assert.doesNotThrow(() => lintUndeclaredTopLevelAssignment(`nom = 5;`, 'civet', ['$nom']))
    })

    it('Coffee : jamais appliqué (auto-déclare nativement, aucun risque)', async () => {
      const { lintUndeclaredTopLevelAssignment } = await import('../src/transpiler/index.js')
      assert.doesNotThrow(() => lintUndeclaredTopLevelAssignment(`nom = function() { return 1; };`, 'coffee'))
    })

    it('assignation à une PROPRIÉTÉ (obj.x = …), pas un Identifier nu : jamais concerné', async () => {
      const { lintUndeclaredTopLevelAssignment } = await import('../src/transpiler/index.js')
      assert.doesNotThrow(() => lintUndeclaredTopLevelAssignment(`obj.x = 5;`, 'civet'))
    })

    it('assignation NUE à l\'intérieur d\'une fonction (pas au top-level du programme) : hors de portée de ce lint', async () => {
      const { lintUndeclaredTopLevelAssignment } = await import('../src/transpiler/index.js')
      assert.doesNotThrow(() => lintUndeclaredTopLevelAssignment(`function f() { nom = 5; }`, 'civet'))
    })
  })

  // --------------------------------------------------------------------------
  // Bug #4 — Filtered dispatch : `_filtPrev = curr` doit être snapshotté
  //          MÊME quand `idx` est undefined au mount initial. Sinon le 2e
  //          dispatch pense que prev === curr et skip l'unmatch/match.
  // --------------------------------------------------------------------------
  describe('filtered effect — snapshot _filtPrev hors du if(idx)', () => {
    it("@class avec filtered effect : _filtPrev = curr posé MÊME sans idx", async () => {
      const src = [
        '<script>',
        '  $selected = "a"',
        '  $items = ["a", "b"]',
        '</script>',
        '<div>',
        '  {for x in $items}',
        '    <span @class{x === $selected}="active">{x}</span>',
        '  {end}',
        '</div>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg4', defaultScriptLang: 'civet' })

      // Pattern clé : l'entrée du mémo (`_mjs_filt[<clé>]`) doit se voir poser
      // `prev = curr` (sinon l'effect ne snapshot jamais et chaque mutation
      // rappelle f(curr)). La clé porte un suffixe `__<lid>` (distingue 2 nœuds
      // d'une même row partageant le même (var, classe)).
      assert.match(
        output,
        /_mjs_filt \?\?= \{\}\)\['[a-z_0-9]+_active__\w+'\]/,
        'l\'entrée _mjs_filt de la classe filtrée doit être posée'
      )
      assert.match(output, /__fe\.prev = curr/, 'le snapshot prev = curr doit être posé sur l\'entrée')

      // Pattern structurel attendu :
      //   if (prev !== curr) {
      //     const idx = __fe.idx;
      //     if (idx) { ... }                   // bloc imbriqué
      //     __fe.prev = curr;                  // AU MÊME niveau que if(idx)
      //   }
      // Critère : le `}` qui ferme `if (idx)` doit être suivi (avec espaces) de
      // `__fe.prev = curr` — donc la fermeture de if(idx) précède l'assignation,
      // et l'assignation est hors du if(idx).
      assert.match(
        output,
        /\}\s*__fe\.prev = curr/,
        "__fe.prev = curr DOIT suivre la fermeture de if(idx) (donc hors du if(idx))"
      )

      // Garde-fou supplémentaire : `if (prev !== curr) {` doit précéder le
      // `const idx = ` dans l'output (l'idx-lookup est dans le bloc prev/curr,
      // pas l'inverse comme avant le fix).
      const idxOfPrev = output.indexOf('if (prev !== curr)')
      const idxOfIdxLookup = output.indexOf('const idx = ', idxOfPrev)
      assert.ok(
        idxOfPrev >= 0 && idxOfIdxLookup > idxOfPrev,
        "`const idx = ` doit apparaître APRÈS `if (prev !== curr) {` (ordre inversé par le fix)"
      )
    })
  })

  // --------------------------------------------------------------------------
  // Bug #5 — strip whitespace : ne PAS manger l'espace solitaire entre
  // balises inline (`</span> <span>`). Strip seulement les whitespace contenant
  // un newline (= pretty-print indent), pas un espace seul intentionnel.
  // Cassait l'affichage de code coloré dans les tutos/docs.
  // --------------------------------------------------------------------------
  describe('whitespace strip', () => {
    it('préserve un espace solitaire entre 2 balises inline dans un <div>', async () => {
      const src = `<div class="indent1"><span class="keyword">-&gt;</span> <span class="variable">$count</span>++</div>`
      const { output } = await transpile(src, { moduleName: 'reg5a' })
      const tplMatch = output.match(/_mjs_cloneTpl\("([^"]+)"\)/)
      assert.ok(tplMatch, 'template trouvé dans _mjs_cloneTpl')
      const tpl = tplMatch![1]
      // L'espace entre </span> et <span class='variable'> doit être préservé.
      assert.match(
        tpl,
        /<\/span>\s+<span class='variable'>/,
        `espace solitaire entre balises inline mangé par le strip\nTemplate: ${tpl}`
      )
    })

    it('strip toujours les whitespace contenant un newline (pretty-print indent)', async () => {
      // Construit explicitement avec un newline+espaces entre les <span>
      const src = '<div>\n  <span>a</span>\n  <span>b</span>\n</div>'
      const { output } = await transpile(src, { moduleName: 'reg5b' })
      const tplMatch = output.match(/_mjs_cloneTpl\("([^"]+)"\)/)
      assert.ok(tplMatch, 'template trouvé dans _mjs_cloneTpl')
      const tpl = tplMatch![1]
      // Le whitespace avec \n doit être stripé → spans collés.
      assert.match(
        tpl,
        /<span>a<\/span><span>b<\/span>/,
        `whitespace pretty-print (\\n) doit toujours être stripé\nTemplate: ${tpl}`
      )
    })

    it("préserve l'espace `code> </code>` entre balises consécutives", async () => {
      // Cas typique des tuto-X-code : `<span class='punctuation'>&lt;</span><span class='tag'>script</span>`
      // suivi d'un espace puis d'un autre span.
      const src = `<div><span class="a">x</span> <span class="b">y</span></div>`
      const { output } = await transpile(src, { moduleName: 'reg5c' })
      const tplMatch = output.match(/_mjs_cloneTpl\("([^"]+)"\)/)
      assert.ok(tplMatch, 'template trouvé')
      assert.match(
        tplMatch![1],
        /<\/span> <span class='b'>/,
        'espace entre les 2 spans doit être préservé'
      )
    })
  })

  // --------------------------------------------------------------------------
  // Bug #6 — µ.inspect doit afficher From + To pour les mutations primitives
  // ET pour les mutations deep (push/splice/sort sur Array, get/set sur Object).
  //
  // Régressions corrigées :
  //   - `µ.log` gated par `µ.debug` → utiliser `console.log` direct dans _mjs_notifyMutation
  //   - Path-tracker compile-time génère `µ._mjs_deepCall(el, path, method, args)` sans
  //     oldValue → snapshot capturé dans _mjs_deepCall/_mjs_deepSet quand inspect actif.
  // --------------------------------------------------------------------------
  describe('µ.inspect From/To', () => {
    let sandbox: any

    before(() => {
      // Charge le runtime en sandbox (même pattern que runtime.test.ts). µ.inspect vit
      // désormais dans mjs_rare_runes.ts (DÉTACHÉ de mjs_runes.ts, cf. bundler/index.ts
      // scanRuntimeFeatures) — concaténé juste après, même esprit que bundleRuntime().
      const initJs = readFileSync(resolvePath('src/runtime/mjs_init.ts'), 'utf-8')
      // mjs_deep.ts : µ._mjs_deepSet/_mjs_deepCall/_mjs_deepDelete/_mjs_makeDeepProxy, détachées de
      // mjs_init.ts (module détaché du cœur, joint à l'usage) — les mutations deep testées ci-dessous les appellent.
      const deepJs = readFileSync(resolvePath('src/runtime/mjs_deep.ts'), 'utf-8')
      const elemJs = readFileSync(resolvePath('src/runtime/mjs_element.ts'), 'utf-8')
      const runesJs = readFileSync(resolvePath('src/runtime/mjs_runes.ts'), 'utf-8')
      const rareRunesJs = readFileSync(resolvePath('src/runtime/mjs_rare_runes.ts'), 'utf-8')
      const setup = `
        class HTMLElement {
          constructor() {}
          attachShadow(opts) { return { adoptedStyleSheets: [], appendChild() {} }; }
          addEventListener() {} removeEventListener() {} dispatchEvent() {}
          getAttribute() { return null }; setAttribute() {}
        }
        class CustomEvent { constructor(name, init) { this.type = name; Object.assign(this, init || {}); } }
        class CSSStyleSheet { replaceSync() {} }
        class Node { static ELEMENT_NODE = 1; static TEXT_NODE = 3; static COMMENT_NODE = 8; static DOCUMENT_FRAGMENT_NODE = 11; }
        const customElements = { get: () => null, define: () => {} };
        const document = { adoptedStyleSheets: [] };
        ${initJs.replace(/export\s*\{[^}]*\}/, '')}
        ${deepJs}
        ${elemJs}
        ${runesJs.replace(/^import[^;]*;?$/gm, '').replace(/export\s*\{[^}]*\}/, '')}
        ${rareRunesJs.replace(/^import[^;]*;?$/gm, '').replace(/export\s*\{[^}]*\}/, '')}
        class MjsInspectTest extends µ.Element {
          constructor() {
            super();
            this._mjs_var_bits = { count: 1, arr: 1, obj: 1 };
          }
        }
        return { µ, MjsInspectTest };
      `
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      sandbox = (new Function(setup))()
    })

    // Helper : remplace console.log/group/groupEnd pendant un appel, capture
    // les arguments transmis. Restaure à la fin.
    function captureConsole(fn: () => void) {
      const logs: any[][] = []
      const groups: string[] = []
      const origLog = console.log
      const origGroup = console.group
      const origGroupEnd = console.groupEnd
      console.log = (...args: any[]) => { logs.push(args) }
      console.group = (label: any) => { groups.push(String(label)) }
      console.groupEnd = () => {}
      try { fn() } finally {
        console.log = origLog
        console.group = origGroup
        console.groupEnd = origGroupEnd
      }
      return { logs, groups }
    }

    it('µ.inspect ajoute la clé dans _mjs_inspections', () => {
      const { µ, MjsInspectTest } = sandbox
      const el = new MjsInspectTest()
      µ.activeComponent = el
      µ.inspect('count')
      µ.activeComponent = null
      assert.ok(el._mjs_inspections instanceof Set, '_mjs_inspections doit être un Set')
      assert.ok(el._mjs_inspections.has('count'), "'count' doit être inscrit")
    })

    it('affiche le header "🔍 [MJS Inspect] <key>" sur mutation', () => {
      const { µ, MjsInspectTest } = sandbox
      const el = new MjsInspectTest()
      µ.activeComponent = el
      µ.inspect('count')
      µ.activeComponent = null
      µ._set(el, 'count', 1) // init (oldValue=undefined → From skip)
      const { groups } = captureConsole(() => µ._set(el, 'count', 2))
      assert.ok(
        groups.some(g => g.includes('🔍 [MJS Inspect] count')),
        `header MJS Inspect attendu, vu: ${JSON.stringify(groups)}`
      )
    })

    it('affiche From + To pour mutation primitive (µ._set)', () => {
      const { µ, MjsInspectTest } = sandbox
      const el = new MjsInspectTest()
      µ.activeComponent = el
      µ.inspect('count')
      µ.activeComponent = null
      µ._set(el, 'count', 5)  // init
      const { logs } = captureConsole(() => µ._set(el, 'count', 7))
      const allLogs = logs.flat().join(' ')
      assert.match(allLogs, /From/, `From attendu dans logs: ${JSON.stringify(logs)}`)
      assert.match(allLogs, /To/, 'To attendu')
      // Vérifie les valeurs : oldValue 5, newValue 7
      assert.ok(logs.some(args => args.includes(5)), `oldValue 5 attendue: ${JSON.stringify(logs)}`)
      assert.ok(logs.some(args => args.includes(7)), `newValue 7 attendue`)
    })

    it("n'affiche RIEN si µ.inspect n'a pas été appelé sur cette var", () => {
      const { µ, MjsInspectTest } = sandbox
      const el = new MjsInspectTest()
      // Pas d'µ.inspect → _mjs_inspections null/undefined
      µ._set(el, 'count', 5)
      const { groups, logs } = captureConsole(() => µ._set(el, 'count', 7))
      assert.equal(groups.length, 0, 'pas de header MJS Inspect')
      assert.equal(logs.length, 0, 'pas de log From/To')
    })

    it('affiche From + To pour mutation deep via µ._mjs_deepCall (Array.push)', () => {
      const { µ, MjsInspectTest } = sandbox
      const el = new MjsInspectTest()
      µ.activeComponent = el
      µ.inspect('arr')
      µ.activeComponent = null
      µ._set(el, 'arr', [1, 2, 3])
      // Simule `$arr.push(4)` compilé : `µ._mjs_deepCall(el, ['arr'], 'push', [4])`
      const { logs } = captureConsole(() => µ._mjs_deepCall(el, ['arr'], 'push', [4]))
      const allLogs = logs.flat().join(' ')
      assert.match(allLogs, /From/, `From attendu sur deepCall: ${JSON.stringify(logs)}`)
      assert.match(allLogs, /To/, 'To attendu sur deepCall')
      // Le From doit être l'ancien array (3 éléments), pas le nouveau (4)
      const fromArr = logs.find(args => Array.isArray(args[2]) && args[2].length === 3)?.[2]
      assert.deepEqual(fromArr, [1, 2, 3], `From snapshot attendu [1,2,3]: ${JSON.stringify(fromArr)}`)
    })

    it('affiche From + To pour mutation deep via µ._mjs_deepSet ($obj.x = val)', () => {
      const { µ, MjsInspectTest } = sandbox
      const el = new MjsInspectTest()
      µ.activeComponent = el
      µ.inspect('obj')
      µ.activeComponent = null
      µ._set(el, 'obj', { a: 1, b: 2 })
      // Simule `$obj.a = 10` compilé : `µ._mjs_deepSet(el, ['obj', 'a'], 10)`
      const { logs } = captureConsole(() => µ._mjs_deepSet(el, ['obj', 'a'], 10))
      const allLogs = logs.flat().join(' ')
      assert.match(allLogs, /From/, `From attendu sur deepSet: ${JSON.stringify(logs)}`)
      // From snapshot = ancien objet {a:1, b:2}
      const fromObj = logs.find(args => args[2] && typeof args[2] === 'object' && args[2].a === 1)?.[2]
      assert.deepEqual(fromObj, { a: 1, b: 2 }, `From snapshot attendu {a:1,b:2}: ${JSON.stringify(fromObj)}`)
    })

    it("pas de snapshot (coût zéro) si l'inspect n'est pas actif sur la top-key", () => {
      const { µ, MjsInspectTest } = sandbox
      const el = new MjsInspectTest()
      // Pas d'µ.inspect → _mjs_inspections undefined
      µ._set(el, 'arr', [1, 2, 3])
      // µ._mjs_snap NE DOIT PAS être appelé. On verifie indirectement : pas de log.
      const { logs } = captureConsole(() => µ._mjs_deepCall(el, ['arr'], 'push', [4]))
      assert.equal(logs.length, 0, 'pas de log car pas d\'inspect actif')
      // Mais la mutation a bien eu lieu — comparaison sur le BRUT : `_state.arr` est
      // un filet réactif (Proxy) et `assert.deepEqual` le refuse sous Node ≥ 22 (vert
      // sous Node 20, rouge sous 24 avec un diff VIDE), même règle que `is`/=== sur un
      // objet réactif profond
      assert.deepEqual(µ._mjs_toRaw(el._state.arr), [1, 2, 3, 4], 'array bien muté malgré skip inspect')
    })

    it('µ._mjs_snap clone shallow Array/Map/Set/Object', () => {
      const { µ } = sandbox
      const arr = [1, 2, 3]
      const arrSnap = µ._mjs_snap(arr)
      assert.notStrictEqual(arrSnap, arr, 'snap !== arr')
      assert.deepEqual(arrSnap, arr, 'mais même contenu')

      const map = new Map([['a', 1]])
      const mapSnap = µ._mjs_snap(map)
      assert.ok(mapSnap instanceof Map, 'Map → Map')
      assert.notStrictEqual(mapSnap, map, 'mapSnap !== map')
      assert.equal(mapSnap.get('a'), 1, 'contenu copié')

      const set = new Set([1, 2])
      const setSnap = µ._mjs_snap(set)
      assert.ok(setSnap instanceof Set, 'Set → Set')
      assert.notStrictEqual(setSnap, set, 'setSnap !== set')

      const obj = { a: 1, b: 2 }
      const objSnap = µ._mjs_snap(obj)
      assert.notStrictEqual(objSnap, obj, 'objSnap !== obj')
      assert.deepEqual(objSnap, obj, 'même contenu')

      // Valeurs scalaires : passthrough
      assert.equal(µ._mjs_snap(42), 42)
      assert.equal(µ._mjs_snap('hello'), 'hello')
      assert.equal(µ._mjs_snap(null), null)
      assert.equal(µ._mjs_snap(undefined), undefined)
    })

    it('le To affiché est déproxifié (jamais un Proxy opaque)', () => {
      const { µ, MjsInspectTest } = sandbox
      const el = new MjsInspectTest()
      µ.activeComponent = el
      µ.inspect('arr')
      µ.activeComponent = null
      µ._set(el, 'arr', [1, 2, 3])
      // Force un Proxy dans _state (cas d'escape : µproxy / mutation non-traçable).
      el._state.arr = el._mjs_wrapDeep([1, 2, 3], 'arr')
      const { logs } = captureConsole(() => µ._mjs_deepSet(el, ['arr', 0], 9))
      // Le 'To' loggé ne doit JAMAIS être un Proxy : µ._mjs_snap déproxifie.
      const toLog = logs.find(args => typeof args[0] === 'string' && args[0].includes('To'))
      assert.ok(toLog, `log 'To' attendu: ${JSON.stringify(logs)}`)
      const toValue = toLog![2]
      // Un Proxy d'array passe Array.isArray ; le vrai test est que ce n'est
      // PAS le proxy lui-même mais un clone nu (µ._mjs_snap retourne un .slice()).
      assert.ok(Array.isArray(toValue), 'To doit être un array')
      assert.notStrictEqual(toValue, el._state.arr, 'To doit être un CLONE, pas le proxy _state.arr')
      assert.deepEqual(toValue, [9, 2, 3], `To déproxifié attendu [9,2,3]: ${JSON.stringify(toValue)}`)
    })
  })

  // --------------------------------------------------------------------------
  // Bugs #7-#11 — compilateur/runtime découverts pendant l'alignement des
  // tutos sur Svelte. Les 273 tests passaient mais ces
  // cas n'étaient pas couverts → trous de couverture.
  // --------------------------------------------------------------------------
  describe('compilateur — cas non couverts (alignement tutos)', () => {
    // Bug #7 — `{for}` imbriqué dans `{await}` crashait le compilateur
    // ("Cannot read properties of undefined (reading 'item')").
    it('{for} dans une branche {await} ne crashe pas le compilateur', async () => {
      const src = [
        '<script>$posts = Promise.resolve([{title:"a"},{title:"b"}])</script>',
        '{await $posts}Chargement…',
        '{success posts}',
        '  {for p in posts}<article>{p.title}</article>{end}',
        '{end}',
      ].join('\n')
      // Avant le fix : throw. Maintenant : compile normalement.
      const { output } = await transpile(src, { moduleName: 'reg-await-for' })
      assert.ok(output && output.length > 100, 'compile sans crash')
      assert.match(output, /_mjs_updAwait/, 'structure {await} générée')
    })

    // Bug #8 — `{for}` imbriqué générait `const _nref_X = _nref_X;`
    // (ReferenceError "before initialization") via la 2e passe d'extraction.
    it('{for} imbriqué ne génère pas d\'auto-référence `_nref_X = _nref_X`', async () => {
      const src = [
        '<script>$grid = [[1,2],[3,4]]</script>',
        '{for row in $grid}<ul>{for cell in row}<li>{cell}</li>{end}</ul>{end}',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg-nested-for' })
      assert.doesNotMatch(
        output,
        /const (_nref_[A-Za-z0-9_]+) = \1\b/,
        'aucune ligne `const _nref_X = _nref_X` (auto-référence)'
      )
    })

    // Bug #9 — le binding two-way composant (`<mjs-x foo=!{$y}>`) lisait
    // `e.detail` (toujours null) alors que le runtime émet la valeur en `e.data`.
    it('binding two-way composant lit e.data (pas e.detail)', async () => {
      const src = '<script>$x = 1</script>\n<mjs-child foo=!{$x}></mjs-child>'
      const { output } = await transpile(src, { moduleName: 'reg-bind-comp' })
      assert.match(output, /e\.data\b/, 'le listener mjs-bind doit lire e.data')
      assert.doesNotMatch(output, /e\.detail\b/, 'ne doit PAS lire e.detail')
    })

    // Bug #10 — `_mjs_invalidate('_awaits_')` ne relançait pas `_mjs_renderStruct`
    // (la clé spéciale `_awaits_` n'était pas reconnue) → {await} bloqué sur
    // la branche pending. Guard : le fix doit rester dans le source runtime.
    it("_mjs_invalidate reconnaît la clé '_awaits_' pour relancer _mjs_renderStruct", () => {
      const elemSrc = readFileSync(resolvePath('src/runtime/mjs_element.ts'), 'utf-8')
      assert.match(
        elemSrc,
        /__needsStruct\s*=\s*k === ['"]_awaits_['"]\s*\|\|/,
        "le calcul de __needsStruct doit inclure `k === '_awaits_'`"
      )
    })

    // Bug #11 — `syncProps` ignorait une prop déclarée si son nom coïncidait
    // avec un attribut HTML natif (`title`, `src`, `name`…). Guard : le skip
    // des attrs natifs doit être conditionné par `!_isDeclaredProp`.
    it('syncProps ne skippe pas une prop déclarée homonyme d\'un attr HTML natif', () => {
      const elemSrc = readFileSync(resolvePath('src/runtime/mjs_element.ts'), 'utf-8')
      assert.match(
        elemSrc,
        /MJS_NATIVE_ATTRS\.has\([^)]+\)\s*&&\s*!_isDeclaredProp/,
        'le skip MJS_NATIVE_ATTRS doit être conditionné par `!_isDeclaredProp`'
      )
    })

    // Bug #12 — l'interpolation INITIALE d'une branche `{if}/{elsif}/{else}`
    // active au mount n'était pas appliquée.
    //
    // Cause : les `_mjs_updText('tN', …)` des branches sont enregistrés dans
    // `effectsByVar` / `effectsAll` ; au mount, `effectsAll` tourne AVANT
    // `_mjs_renderStruct`, donc avant que `_mjs_updIf` n'ait créé la branche → le node
    // `tN` n'existe pas encore → l'update no-op. `_mjs_renderStruct` crée ensuite
    // la branche mais ne ré-applique jamais l'init → valeur initiale ratée.
    //
    // Fix (compileIf, cas root) : les updates de branche sont aussi inlinées
    // dans le `ifUpdate` (classé "struct"), exécutées APRÈS `_mjs_updIf` — quand
    // les refs de la branche active ont été mergées dans `this._mjs_nodes`.
    it("l'interpolation initiale d'une branche {if}/{elsif} est appliquée (struct)", async () => {
      const src = [
        '<script>$x = 0</script>',
        '<div>{if $x > 10}<p>{$x} big</p>',
        '{elsif $x < 5}<p>{$x} small</p>',
        '{else}<p>{$x} mid</p>{end}</div>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg-if-init' })

      // Le _mjs_renderStruct doit contenir le bloc `if (_c_if1 >= 0)` qui ré-exécute
      // les updates de la branche active après _mjs_updIf.
      // (`_mjs_cfn`, pas `cfn` nu ; `_c_if1`, pas `c`
      // nu : une variable de SCRIPT
      // nommée `c`, visible dans la closure `init` où tournent les updates root,
      // provoquait `const c = (c > 3) ? …` → TDZ. Voir reserved-names-collision.)
      assert.match(
        output,
        /this\._mjs_updIf\('if1', _mjs_cfn\);[\s\S]*?if \(_c_if1 >= 0\) \{/,
        'le ifUpdate doit ré-exécuter les updates de branche après _mjs_updIf (init)'
      )
      // Les 3 _mjs_updText des branches doivent apparaître dans le branchExec.
      const branchExec = output.slice(output.indexOf('if (_c_if1 >= 0)'))
      for (const t of ['t2', 't3', 't4']) {
        assert.match(
          branchExec,
          new RegExp(`if \\(_c_if1 === \\d\\) \\{ \\{ this\\._mjs_updText\\('${t}'`),
          `le branchExec doit contenir l'init de ${t}`
        )
      }
      // Réactivité ultérieure conservée : effectsByVar garde les updates.
      assert.match(output, /_mjs_effectsByVar\s*=\s*\{"x":/, 'effectsByVar["x"] conservé')
    })

    // Bug #12bis — `{if}` actif au mount avec interpolation : vérification
    // runtime (happy-dom) que le text node a la bonne valeur AVANT mutation.
    it("monte un {if}/{elsif} actif et affiche l'interpolation initiale (runtime)", async function () {
      this.timeout(30000)
      const { Window } = await import('happy-dom')
      const { Bundler, terminateSharedWorkerPool } = await import('../src/bundler/index.js')
      const { mkdirSync, writeFileSync, readFileSync: rf, readdirSync } =
        await import('node:fs')
      const { join } = await import('node:path')

      const root = mjsTmp('reg-ifinit')
      const srcDir = join(root, 'src')
      const outDir = join(root, 'out')
      mkdirSync(srcDir, { recursive: true })

      writeFileSync(join(srcDir, 'ifinit.mjs'), [
        '<script lang="coffee">',
        '$count = 0',
        'incr = => $count = $count + 1',
        '</script>',
        '<div>',
        '{if $count > 10}<p class="branch">{$count} is big</p>',
        '{elsif $count < 5}<p class="branch">{$count} is less than 5</p>',
        '{else}<p class="branch">{$count} is mid</p>{end}',
        '</div>',
      ].join('\n'))

      const bundler = new Bundler({
        sourceDir: srcDir,
        outputDir: outDir,
        manifestPath: join(root, 'bundle.js'),
      })
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

      const window = new Window({ url: 'http://localhost/' })
      const document: any = window.document

      const files = readdirSync(outDir)
      const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
      const compFile = files.find((f: string) => /^ifinit-/.test(f))
      assert.ok(coreFile && compFile, 'core et composant compilés')

      const stripEsm = (s: string) => s
        .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
        .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
        .replace(/\bexport\s+default\s+/g, '')
        .replace(/\bexport\s+/g, '')
        .replace(/import\.meta\.url/g, "'http://localhost/'")
      const coreCode = stripEsm(rf(join(outDir, coreFile!), 'utf-8'))
      const compCode = stripEsm(rf(join(outDir, compFile!), 'utf-8'))

      window.eval(`
        ${coreCode}
        globalThis.µ = µ;
        ${compCode}
      `)

      const tag = 'mjs-ifinit'
      assert.ok(window.customElements.get(tag), `${tag} enregistré`)
      document.body.innerHTML = `<${tag}></${tag}>`
      const el: any = document.body.firstElementChild
      await new Promise(r => setTimeout(r, 50))

      // AVANT toute mutation : la branche {elsif $count < 5} est active
      // ($count = 0). Le <p> doit afficher "0 is less than 5".
      const p = el._shadow?.querySelector('p.branch')
      assert.ok(p, 'le <p> de la branche active doit exister au mount')
      assert.equal(
        (p.textContent ?? '').trim(),
        '0 is less than 5',
        "l'interpolation initiale {$count} (= 0) doit être appliquée AVANT tout clic"
      )

      // APRÈS mutation : l'interpolation reste réactive.
      window.eval(`µ._set(document.querySelector('${tag}'), 'count', 3);`)
      await new Promise(r => setTimeout(r, 50))
      assert.equal(
        (el._shadow.querySelector('p.branch').textContent ?? '').trim(),
        '3 is less than 5',
        'mutation ($count = 3) : branche inchangée, interpolation mise à jour'
      )

      // Passage à une autre branche : {else} ($count entre 5 et 10).
      window.eval(`µ._set(document.querySelector('${tag}'), 'count', 7);`)
      await new Promise(r => setTimeout(r, 50))
      assert.equal(
        (el._shadow.querySelector('p.branch').textContent ?? '').trim(),
        '7 is mid',
        'changement de branche : la nouvelle branche affiche son interpolation'
      )

      window.close?.()
      await terminateSharedWorkerPool()
    })
  })

  // --------------------------------------------------------------------------
  // Bug #13 — Event handler : `{onXXX}` (raccourci d'attribut) génère un
  // attribut HTML `onXXX=""` natif → le navigateur parse son contenu comme du
  // code (SyntaxError au mouseover). Un binding event MJS doit utiliser
  // `@event` → addEventListener propre, jamais d'attribut `onXXX` dans le DOM.
  // --------------------------------------------------------------------------
  describe('event handler — pas d\'attribut onXXX parasite', () => {
    it('`@pointermove={fn}` génère un event listener, pas un attribut HTML onpointermove', async () => {
      const src = [
        '<script>$m = { x: 0 }\nmove = (e) -> $m.x = e.clientX</script>',
        '<div @pointermove={move}>{$m.x}</div>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg13a' })
      // Le template cloné ne doit PAS contenir l'attribut onpointermove.
      const tpl = output.match(/_mjs_cloneTpl\("([^"]+)"\)/)
      assert.ok(tpl, 'template trouvé')
      assert.doesNotMatch(tpl![1], /onpointermove\s*=/, "le template ne doit PAS avoir d'attribut onpointermove= (handler inline natif)")
      // L'event doit être routé via _mjs_bindEvents (event delegation).
      assert.match(output, /_mjs_bindEvents\(\{[^}]*pointermove/, 'pointermove doit être un event délégué (_mjs_bindEvents)')
    })
  })

  // --------------------------------------------------------------------------
  // Bug #14 — Sucre `@event` (forme abrégée) sur les macros globales
  // `<@window>/<@document>/<@body>/<@head>`. Avant, seul `@event={handler}`
  // était supporté ; `<@document @selectionchange>` (sans valeur) était ignoré.
  // Le sucre doit appeler la fonction du nom de l'event.
  // --------------------------------------------------------------------------
  describe('macro globale — sucre @event abrégé', () => {
    it('`<@document @selectionchange>` (sans valeur) bind selectionchange → fonction du même nom', async () => {
      const src = [
        '<script>$sel = ""\nselectionchange = -> $sel = "x"</script>',
        '<@document @selectionchange />',
        '<p>{$sel}</p>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg14a' })
      // addEventListener('selectionchange', ...) doit être généré
      assert.match(output, /addEventListener\('selectionchange'/, "le sucre @selectionchange doit générer addEventListener('selectionchange')")
      // Le handler abrégé appelle la fonction du nom de l'event : selectionchange(e)
      assert.match(output, /selectionchange\(e\)/, "forme abrégée : appelle selectionchange(e)")
    })

    it('`<@window @resize={handler}>` (forme complète) toujours supportée', async () => {
      const src = [
        '<script>$w = 0\nonResize = -> $w = window.innerWidth</script>',
        '<@window @resize={onResize()} />',
        '<p>{$w}</p>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg14b' })
      assert.match(output, /addEventListener\('resize'/, "forme complète @resize={...} toujours supportée")
    })
  })

  // --------------------------------------------------------------------------
  // Bug #15 — `@event.propagate` : modèle « un seul listener ».
  // `.propagate` n'attache PAS de listener natif séparé. Il reste dans la
  // table de délégation, mais marqué `[idx]` (tableau) au lieu de `idx`
  // (nombre) → le routeur runtime continue sa remontée après ce handler au
  // lieu de s'arrêter au plus proche. Un seul `addEventListener` par event.
  // --------------------------------------------------------------------------
  describe('@event.propagate — un seul listener, marqueur [idx] dans la table', () => {
    it('`@keydown.propagate` est routé via _mjs_bindEvents avec une valeur tableau [idx]', async () => {
      const src = [
        '<div @keydown={(e) -> alert(e.key)}>',
        '  <input @keydown.propagate={(e) -> alert(e.key)} />',
        '</div>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg15a' })
      // Aucun listener natif séparé : tout passe par la délégation.
      assert.doesNotMatch(output, /addEventListener\('keydown'/, "pas de listener natif séparé pour .propagate")
      // La route keydown existe.
      const bind = output.match(/_mjs_bindEvents\((\{[\s\S]*?\})\)/)
      assert.ok(bind, '_mjs_bindEvents présent')
      const routes = JSON.parse(bind![1])
      assert.ok(routes.keydown, 'route keydown présente')
      const slots = Object.values(routes.keydown)
      // Le handler `.propagate` (l'input) est un tableau [idx] ; le handler
      // normal (le div) est un nombre.
      assert.ok(slots.some(v => Array.isArray(v)), "le handler .propagate doit être marqué par un tableau [idx]")
      assert.ok(slots.some(v => typeof v === 'number'), "le handler normal reste un nombre")
    })

    it('sans `.propagate`, tous les handlers restent de simples nombres', async () => {
      const src = [
        '<div @keydown={(e) -> alert(e.key)}>',
        '  <input @keydown={(e) -> alert(e.key)} />',
        '</div>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg15b' })
      const bind = output.match(/_mjs_bindEvents\((\{[\s\S]*?\})\)/)
      assert.ok(bind, '_mjs_bindEvents présent')
      const routes = JSON.parse(bind![1])
      assert.ok(Object.values(routes.keydown).every(v => typeof v === 'number'),
        "aucun .propagate → aucune valeur tableau")
    })

    it('`.stop` compile en e.stopPropagation() (pas stopImmediatePropagation)', async () => {
      const src = '<div @click.stop={-> doThing()}>x</div>'
      const { output } = await transpile(src, { moduleName: 'reg15c' })
      assert.match(output, /stopPropagation\(\)/, ".stop doit appeler stopPropagation()")
      assert.doesNotMatch(output, /stopImmediatePropagation/, "plus de stopImmediatePropagation")
    })
  })

  // --------------------------------------------------------------------------
  // Bug #16 — `.once` : la route est marquée `[idx, flags]` avec le bit 1 du
  // bitmask (flags & 2). Le routeur runtime supprime la route après le 1er
  // déclenchement. Combinable avec `.propagate` (bit 0) → flags = 3.
  // --------------------------------------------------------------------------
  describe('@event.once — marqueur de route, bitmask flags', () => {
    it('`.once` seul → route `[idx, 2]`', async () => {
      const { output } = await transpile('<button @click.once={f()}>x</button>', { moduleName: 'reg16a' })
      const routes = JSON.parse(output.match(/_mjs_bindEvents\((\{[\s\S]*?\})\)/)![1])
      const slot = Object.values(routes.click)[0] as any
      assert.ok(Array.isArray(slot), '.once doit produire une route tableau')
      assert.equal(slot[1] & 2, 2, 'le bit 1 (.once) doit être posé')
      assert.equal(slot[1] & 1, 0, 'le bit 0 (.propagate) ne doit PAS être posé')
    })

    it('`.propagate.once` combiné → flags = 3 (bits 0 et 1)', async () => {
      const { output } = await transpile('<button @click.propagate.once={f()}>x</button>', { moduleName: 'reg16b' })
      const routes = JSON.parse(output.match(/_mjs_bindEvents\((\{[\s\S]*?\})\)/)![1])
      const slot = Object.values(routes.click)[0] as any
      assert.deepEqual(slot[1], 3, 'propagate (1) + once (2) = 3')
    })
  })

  // --------------------------------------------------------------------------
  // Bug #17 — Auto-passive : touchstart/touchmove/wheel sont enregistrés en
  // listener `passive` (2ᵉ arg de `_mjs_bindEvents`) pour un scroll fluide — SAUF
  // si un handler de ce type utilise preventDefault (modifier `.prevent` ou
  // appel direct), auquel cas le type reste non-passif.
  // --------------------------------------------------------------------------
  describe('auto-passive — touch/wheel sans preventDefault', () => {
    it('@touchmove + @wheel sans preventDefault → listés passifs', async () => {
      const { output } = await transpile('<div @touchmove={f()} @wheel={g()}>x</div>', { moduleName: 'reg17a' })
      const m = output.match(/_mjs_bindEvents\(\{[\s\S]*?\}\s*,\s*(\[[^\]]*\])\)/)
      assert.ok(m, 'un 2ᵉ argument (liste passive) doit être émis')
      const passive = JSON.parse(m![1])
      assert.deepEqual(passive.sort(), ['touchmove', 'wheel'])
    })

    it('`.prevent` sur @touchmove → ce type est EXCLU de la liste passive', async () => {
      const { output } = await transpile('<div @touchmove.prevent={f()} @wheel={g()}>x</div>', { moduleName: 'reg17b' })
      const m = output.match(/_mjs_bindEvents\(\{[\s\S]*?\}\s*,\s*(\[[^\]]*\])\)/)
      assert.ok(m, 'liste passive émise')
      const passive = JSON.parse(m![1])
      assert.deepEqual(passive, ['wheel'], 'touchmove exclu (preventDefault), wheel reste passif')
    })

    it('preventDefault appelé dans le corps (sans modifier) → type exclu aussi', async () => {
      const { output } = await transpile('<div @wheel={(e) -> e.preventDefault()}>x</div>', { moduleName: 'reg17c' })
      const m = output.match(/_mjs_bindEvents\(\{[\s\S]*?\}\s*,\s*(\[[^\]]*\])\)/)
      assert.equal(m, null, 'wheel avec preventDefault dans le corps → aucune liste passive')
    })

    it('@click n\'est jamais passif (pas un event de scroll)', async () => {
      const { output } = await transpile('<button @click={f()}>x</button>', { moduleName: 'reg17d' })
      // Isole les arguments du call (jusqu'à la 1ʳᵉ `)`) : ni objet routes ni
      // liste passive ne contiennent de parenthèse.
      const call = output.match(/_mjs_bindEvents\(([^)]*)\)/)
      assert.ok(call, '_mjs_bindEvents présent')
      assert.doesNotMatch(call![1], /,\s*\[/, '@click → pas de 2ᵉ argument passif')
    })
  })

  // --------------------------------------------------------------------------
  // Bug #18 — Sigils `$x` dans les interpolations de chaîne. Le lexer passait
  // les chaînes inertes — donc un `$x` dans un `#{...}` (Coffee/Civet) ou un
  // `${...}` (template literal) restait littéral → `ReferenceError: $x is not
  // defined` au runtime. Fix : `interpolateSigils` tokenise le contenu des
  // interpolations.
  // --------------------------------------------------------------------------
  describe('lexer — sigils $x dans les interpolations de chaîne', () => {
    it('`$x` dans un `#{...}` est transformé en `$.x`', async () => {
      const src = [
        '<script>',
        '  $sel = undefined',
        '  go = -> alert("question #{$sel.id} ok")',
        '</script>',
        '<button @click={go}>x</button>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg18a' })
      assert.match(output, /\$\.sel\.id/, "$sel dans #{...} doit devenir $.sel")
      assert.doesNotMatch(output, /[^.]\$sel\b/, "plus aucun $sel littéral non préfixé")
    })

    it('`$x` dans un `${...}` de template literal est transformé en `$.x`', async () => {
      const src = [
        '<script>',
        '  $n = 0',
        '  go = -> console.log(`count ${$n} done`)',
        '</script>',
        '<button @click={go}>x</button>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg18b' })
      assert.match(output, /\$\{\$\.n\}/, "$n dans ${...} doit devenir $.n")
    })

    it('un `$x` dans une chaîne SANS interpolation reste littéral', async () => {
      const src = [
        '<script>',
        '  label = "prix : $x dollars"',
        '</script>',
        '<p>{label}</p>',
      ].join('\n')
      const { output } = await transpile(src, { moduleName: 'reg18c' })
      assert.match(output, /\$x dollars/, "le $x en contenu de chaîne pure n'est PAS transformé")
    })
  })
})

// ----------------------------------------------------------------------------
// µ._glCl / µ._glSt — liaisons class/style sur élément global partagé
// (<@body>/<@html>). Sémantique verrouillée : classe REFCOMPTÉE
// (deux composants posant la même classe → elle reste tant qu'UN des deux est
// éveillé ; des classes différentes s'additionnent — rien n'est jamais écrasé),
// contribution idempotente par composant (les µeffects/hooks awake rejouent),
// style dernier-écrivain-gagnant (documenté, pas de refcount).
// ----------------------------------------------------------------------------
describe('runtime µ._glCl / µ._glSt (liaisons globales <@body>/<@html>)', () => {
  let µ: any

  before(() => {
    // Charge le runtime en sandbox (même pattern que le describe µ.inspect). µ._glCl/µ._glSt
    // vivent désormais dans mjs_body.ts (DÉTACHÉ de mjs_runes.ts, cf. bundler/index.ts
    // scanRuntimeFeatures) — concaténé juste après, même esprit que bundleRuntime().
    const initJs  = readFileSync(resolvePath('src/runtime/mjs_init.ts'), 'utf-8')
    const elemJs  = readFileSync(resolvePath('src/runtime/mjs_element.ts'), 'utf-8')
    const runesJs = readFileSync(resolvePath('src/runtime/mjs_runes.ts'), 'utf-8')
    const bodyJs  = readFileSync(resolvePath('src/runtime/mjs_body.ts'), 'utf-8')
    const setup = `
      class HTMLElement {
        constructor() {}
        attachShadow(opts) { return { adoptedStyleSheets: [], appendChild() {} }; }
        addEventListener() {} removeEventListener() {} dispatchEvent() {}
        getAttribute() { return null }; setAttribute() {}
      }
      class CustomEvent { constructor(name, init) { this.type = name; Object.assign(this, init || {}); } }
      class CSSStyleSheet { replaceSync() {} }
      class Node { static ELEMENT_NODE = 1; static TEXT_NODE = 3; static COMMENT_NODE = 8; static DOCUMENT_FRAGMENT_NODE = 11; }
      const customElements = { get: () => null, define: () => {} };
      const document = { adoptedStyleSheets: [] };
      ${initJs.replace(/export\s*\{[^}]*\}/, '')}
      ${elemJs}
      ${runesJs.replace(/^import[^;]*;?$/gm, '').replace(/export\s*\{[^}]*\}/, '')}
      ${bodyJs.replace(/^import[^;]*;?$/gm, '').replace(/export\s*\{[^}]*\}/, '')}
      return { µ };
    `
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    µ = (new Function(setup))().µ
  })

  // Faux élément global (body/html) : classList → Set traçant, style → Map.
  function fakeGlobalEl() {
    const classes = new Set<string>()
    const styles  = new Map<string, string>()
    return {
      classes, styles,
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      style: { setProperty: (p: string, v: string) => styles.set(p, v), removeProperty: (p: string) => styles.delete(p) },
    }
  }

  it('refcount : 2 composants posent la MÊME classe → retirée seulement après les 2 retraits', () => {
    const el = fakeGlobalEl()
    const compA: any = {}, compB: any = {}
    µ._glCl(compA, el, 'no-scroll', true)
    assert.ok(el.classes.has('no-scroll'), 'classe posée par A')
    µ._glCl(compB, el, 'no-scroll', true)
    µ._glCl(compA, el, 'no-scroll', false)
    assert.ok(el.classes.has('no-scroll'), 'B la veut encore → la classe RESTE')
    µ._glCl(compB, el, 'no-scroll', false)
    assert.ok(!el.classes.has('no-scroll'), 'plus personne → retirée')
  })

  it('idempotence : rejouer la même contribution (µeffect re-run, awake rejoué) ne fausse pas le compteur', () => {
    const el = fakeGlobalEl()
    const comp: any = {}
    µ._glCl(comp, el, 'x', true)
    µ._glCl(comp, el, 'x', true)   // re-run : no-op, compteur toujours à 1
    µ._glCl(comp, el, 'x', false)
    assert.ok(!el.classes.has('x'), 'un seul retrait suffit malgré la double pose')
  })

  it("classes différentes s'ADDITIONNENT : retirer l'une ne touche pas l'autre", () => {
    const el = fakeGlobalEl()
    const compA: any = {}, compB: any = {}
    µ._glCl(compA, el, 'a', true)
    µ._glCl(compB, el, 'b', true)
    assert.ok(el.classes.has('a') && el.classes.has('b'), 'les deux classes coexistent')
    µ._glCl(compA, el, 'a', false)
    assert.ok(!el.classes.has('a') && el.classes.has('b'), "retrait de 'a' sans effet sur 'b'")
  })

  it('retrait sans pose préalable : compteur jamais négatif, pas de crash', () => {
    const el = fakeGlobalEl()
    const compA: any = {}, compB: any = {}
    µ._glCl(compA, el, 'k', false)   // teardown avant toute pose (sleep précoce)
    µ._glCl(compB, el, 'k', true)
    assert.ok(el.classes.has('k'), 'la pose de B doit suffire (0→1, pas -1→0)')
  })

  it('µ._glSt : setProperty avec String(value), null → removeProperty (dernier-écrivain-gagnant)', () => {
    const el = fakeGlobalEl()
    const compA: any = {}, compB: any = {}
    µ._glSt(compA, el, 'overflow', 'hidden')
    assert.equal(el.styles.get('overflow'), 'hidden')
    µ._glSt(compB, el, 'overflow', 12)
    assert.equal(el.styles.get('overflow'), '12', 'valeur stringifiée, dernier écrivain gagne')
    µ._glSt(compA, el, 'overflow', null)
    assert.ok(!el.styles.has('overflow'), 'null retire la propriété (même posée par un autre — documenté)')
  })
})

// ----------------------------------------------------------------------------
// µasset dans <@head> (verrou fonts) — idiome consacré pour
// charger une police sans le piège Shadow DOM (@font-face en adoptedStyleSheets
// composant, cf. cssTrapWarnings dans transpiler/index.ts) :
//   <@head><style>@font-face { … src: url(µasset('…')) }</style></@head>
// Deux bugs verrouillés ici (trouvés en écrivant CE test) :
//   1. `buildHeadInjection` (transpiler/macros.ts) traitait TOUTE accolade
//      `{…}` du contenu <@head> comme une interpolation réactive — un bloc
//      CSS (`@font-face { … }`) tombait dedans, Civet cassait (ParseError,
//      `µ._esc(font-family: 'X'; src: …)` n'est pas une expression valide).
//      Fix : <style>/<script> masqués avant le scan (contenu figé, cf.
//      commentaire de buildHeadInjection).
//   2. Une fois le parse réparé, le contenu de <@head> part en chaîne Civet
//      SIMPLE-QUOTE avec échappement `\'` — `µasset('…')` y devient
//      `µasset(\'…\')`. L'ancien `ASSET_RE` (bundler/index.ts) n'acceptait
//      qu'un guillemet NU : la substitution du bundler ratait SILENCIEUSEMENT
//      (police jamais chargée, aucune erreur). Fix : `ASSET_RE` tolère et
//      ré-échappe symétriquement (cf. son commentaire, exporté pour ce test).
// ----------------------------------------------------------------------------
describe('µasset dans <@head> (verrou fonts)', () => {
  it("survit à l'échappement Civet : µasset() dans un @font-face de <@head> reste matchable par ASSET_RE", async () => {
    const src = [
      "<@head><style>@font-face { font-family: 'TestFont'; src: url(µasset('fonts/test.woff2')) format('woff2') }</style></@head>",
      '<p>x</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'headfonta' })

    assert.match(output, /fonts\/test\.woff2/, "la référence à l'asset doit survivre à la compilation Civet")

    const matches = [...output.matchAll(ASSET_RE)]
    const hit = matches.find(m => m[4] === 'fonts/test.woff2')
    assert.ok(hit, `ASSET_RE (bundler/index.ts) doit matcher l'appel µasset() malgré l'échappement Civet (\\') — sinon la substitution du bundler rate SILENCIEUSEMENT, la police n'est jamais chargée. output:\n${output}`)
  })

  it("interpolation réactive + µasset cohabitent dans le même <@head> (<title>{$titre}</title> avant le <style>)", async () => {
    const src = [
      '<script>$titre = "Bonjour"</script>',
      "<@head><title>{$titre}</title><style>@font-face { font-family: 'TestFont'; src: url(µasset('fonts/test.woff2')) format('woff2') }</style></@head>",
      '<p>x</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'headfontb' })

    const matches = [...output.matchAll(ASSET_RE)]
    const hit = matches.find(m => m[4] === 'fonts/test.woff2')
    assert.ok(hit, `µasset() doit rester matchable même avec une interpolation réactive AVANT le <style>. output:\n${output}`)
    assert.match(output, /\$\.titre\b/, "l'interpolation réactive {$titre} doit survivre, réécrite en $.titre (tokenize)")
  })
})
