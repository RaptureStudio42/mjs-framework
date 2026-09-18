// garde-fous du compilateur (transpiler/index.ts, transpiler/template.ts) :
// neuf cas, un describe par cas.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as acorn from 'acorn'
import { Window } from 'happy-dom'
import { transpile, transpileFile } from '../src/transpiler/index.js'
import { mjsTmp } from './helpers/tmp.js'

// ----------------------------------------------------------------------------
// Harnais happy-dom partagé — la sortie de transpile() SEULE (sans bundler) porte le
// placeholder `import { µ } from µ.asset('mjs_core.js')` (résolu normalement par le BUNDLER,
// jamais par transpile()) : jamais valide tel quel comme spécificateur d'import, ni évaluable par
// `window.eval` (import/export interdits en script indirect). Corrigé ICI, au niveau du harnais
// de test — sans rapport avec les failles sondées. `µ` reste un STUB MINIMAL (seulement ce que le
// squelette de classe touche pendant construct()/init()) — jamais
// le runtime réel (src/runtime, hors périmètre ici).
// ----------------------------------------------------------------------------
function fixImportSpecifier(output: string): string {
  return output.replace(/from\s+µ\.asset\([^)]*\)/, "from 'mjs_core.js'")
}

function stripEsmForEval(output: string): string {
  return fixImportSpecifier(output)
    .replace(/^\s*import\s*\{[^}]*\}\s*from\s*'[^']*'\s*;\s*$/m, '')
    .replace(/\bexport\s+default\s+/, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
}

function installMjsStub(window: any): void {
  window.eval(`
    class __MjsElementStub extends HTMLElement {
      _mjs_mount() {}
      _mjs_injectSlots() {}
    }
    globalThis.µ = {
      Element: __MjsElementStub,
      activeComponent: null,
      Autoloader: null,
      warn(...a) { (globalThis.__warns ??= []).push(a.join(' ')) },
      error() {},
      asset(s) { return s },
      _set(t, k, v) { t[k] = v },
      // aide de définition du cœur (runtime mjs_dom.ts), que le module compilé appelle pour
      // enregistrer sa balise. Même garde, avertissement RÉDUIT : le texte réel du cœur est prouvé
      // sur le cœur réel (tests/bundler-def-aide-coeur.test.ts), le recopier ici n'en dirait rien.
      _def(tag, C) { if(!customElements.get(tag)) customElements.define(tag, C); else µ.warn('collision ' + tag) },
      _mjs_cloneTpl() { return document.createDocumentFragment() },
    }
    globalThis.__warns = []
  `)
}

describe('injection JS via moduleName/tagName non échappé', function () {
  this.timeout(20000)

  // évalue `code` (déjà dépouillé) dans `window`, tolère l'échec ATTENDU de l'auto-define du
  // script (le tag dérivé d'un moduleName malveillant reste un nom de balise INVALIDE même bien
  // échappé au sens JS — hors sujet ici : on vise l'injection de CODE, pas la validité du nom de
  // balise), puis construit une instance sous un tag de secours si l'auto-define n'a pas abouti.
  function evalAndConstruct(window: any, code: string, className: string): void {
    installMjsStub(window)
    try { window.eval(code) } catch { /* auto-define potentiellement en échec (tag invalide) — attendu */ }
    window.eval(`
      try { new ${className}() }
      catch {
        try { customElements.define('mjs-b1-1-safe-'+ Math.random().toString(36).slice(2), ${className}) } catch {}
        try { new ${className}() } catch {}
      }
    `)
  }

  async function pwnedStaysUndefined(moduleName: string): Promise<void> {
    const r = await transpile('<script>$x=1</script><p>{$x}</p>', { moduleName })
    assert.doesNotThrow(() => acorn.parse(fixImportSpecifier(r.output), { ecmaVersion: 'latest', sourceType: 'module' }), 'la sortie de transpile() doit rester du JS valide (acorn, sourceType module)')
    const window: any = new Window({ url: 'http://localhost/' })
    evalAndConstruct(window, stripEsmForEval(r.output), r.data.className)
    assert.equal(window.eval('typeof globalThis.MJS_PWNED'), 'undefined', 'globalThis.MJS_PWNED ne doit JAMAIS être posé par un moduleName malveillant')
  }

  it('moduleName avec guillemet double : sortie JS valide, MJS_PWNED jamais exécuté', async () => {
    await pwnedStaysUndefined('inj"; globalThis.MJS_PWNED = 1; //')
  })

  it('moduleName avec guillemet simple : même garde', async () => {
    await pwnedStaysUndefined("inj'; globalThis.MJS_PWNED = 1; //")
  })

  it('témoin — nom de module normal, sortie inchangée', async () => {
    const r = await transpile('<script>$x=1</script><p>{$x}</p>', { moduleName: 'temoinnormal' })
    assert.equal(r.data.moduleName, 'temoinnormal')
    assert.match(r.output, /this\._mjs_modName = "temoinnormal"/)
    assert.match(r.output, /µ\._def\("mjs-temoinnormal"/)
  })
})

describe("this['routes'] = … contourne detectRoutesReassignment/detectRouterAware", function () {
  it("notation crochet this['routes'] déclenche la même garde .page.mjs que la notation pointée", async () => {
    const dot     = '<script lang="js">this.routes = { root: { \'/\': \'home\' } };</script><p>x</p>'
    const bracket = '<script lang="js">this[\'routes\'] = { root: { \'/\': \'home\' } };</script><p>x</p>'
    await assert.rejects(transpile(dot, { moduleName: 'pgdot', isPageModule: false }), /\.page\.mjs/, 'témoin (notation pointée) : garde attendue')
    await assert.rejects(transpile(bracket, { moduleName: 'pgbracket', isPageModule: false }), /\.page\.mjs/, 'notation crochet : même garde attendue')
  })

  it("notation crochet this['routes'] = … pose _mjs_is_router_aware, comme this.routes = …", async () => {
    const bracket = '<script lang="js">this[\'routes\'] = { root: { \'/\': \'home\' } };</script><p>x</p>'
    const { output } = await transpile(bracket, { moduleName: 'rtbracket' })
    assert.match(output, /_mjs_is_router_aware = true/)
  })

  it("this['autreChose'] (pas 'routes') n'active aucune des deux gardes", async () => {
    const src = '<script lang="js">this[\'autreChose\'] = 1;</script><p>x</p>'
    const { output } = await transpile(src, { moduleName: 'rtautre' })
    assert.doesNotMatch(output, /_mjs_is_router_aware/)
  })
})

describe('@no-ujs="valeur" avale une valeur en silence', function () {
  it('@no-ujs="Vraiment ?" est refusé', async () => {
    await assert.rejects(transpile('<button @no-ujs="Vraiment ?">X</button>', { moduleName: 'nu1' }), /@no-ujs/)
  })

  it('@noUJS="x" est refusé (casse alternative)', async () => {
    await assert.rejects(transpile('<button @noUJS="x">X</button>', { moduleName: 'nu2' }), /@no-ujs/)
  })

  it('@no-ujs nu (sans valeur) reste accepté, pose mjs-no-ujs', async () => {
    const { output } = await transpile('<button @no-ujs>X</button>', { moduleName: 'nu3' })
    assert.match(output, /mjs-no-ujs/)
  })

  it('@noUJS nu (sans valeur) reste accepté, pose mjs-no-ujs', async () => {
    const { output } = await transpile('<button @noUJS>X</button>', { moduleName: 'nu4' })
    assert.match(output, /mjs-no-ujs/)
  })
})

describe('erreurs de preprocessHtml/analyzer sans nom de module', function () {
  it('une erreur de preprocessHtml est préfixée du nom du module quand il est fourni', async () => {
    await assert.rejects(transpile('<button @confirm={ text: 3 }>y</button>', { moduleName: 'mon-composant-important' }), /mon-composant-important/)
  })

  it('une erreur qui contient déjà moduleName (ex. garde .page.mjs) n\'est pas préfixée deux fois', async () => {
    const src = '<script lang="js">this.routes = {};</script><p>x</p>'
    try {
      await transpile(src, { moduleName: 'pagesansmarqueur', isPageModule: false })
      assert.fail('devait lever une erreur')
    }
    catch (e: any) {
      // le message légitime (garde .page.mjs) porte DÉJÀ moduleName deux fois (nom du fichier +
      // suggestion de renommage) — ce qui compte ici : AUCUN préfixe "'pagesansmarqueur' : " en
      // tête (wrapModuleError doit avoir reconnu que le nom y figurait déjà et n'avoir rien ajouté).
      assert.doesNotMatch(e.message, /^'pagesansmarqueur' : /, `pas de double préfixe attendu : ${e.message}`)
      assert.match(e.message, /pagesansmarqueur/, 'le message doit tout de même nommer le module')
    }
  })

  it('sans moduleName, le message reste inchangé (aucun préfixe)', async () => {
    try {
      await transpile('<button @confirm={ text: 3 }>y</button>')
      assert.fail('devait lever une erreur')
    }
    catch (e: any) {
      assert.doesNotMatch(e.message, /^'[^']*' : /, "aucun préfixe \"'…' : \" attendu sans moduleName")
    }
  })
})

describe('directive refusée DANS un commentaire HTML', function () {
  it('@permanent="nom" (forme refusée) écrit dans un commentaire ne fait pas échouer la compilation', async () => {
    const { output } = await transpile('<!-- exemple : <a @permanent="nom">l</a> --><p>contenu</p>', { moduleName: 'com1' })
    assert.match(output, /contenu/)
  })

  it('la même forme refusée HORS commentaire continue de lever (non-régression)', async () => {
    await assert.rejects(transpile('<a @permanent="nom">l</a>', { moduleName: 'com2' }), /@permanent/)
  })
})

describe('directive dupliquée sur une même balise', function () {
  it('@confirm posé deux fois sur le même bouton → erreur', async () => {
    await assert.rejects(transpile('<button @confirm="A" @confirm="B">X</button>', { moduleName: 'dup1' }), /@confirm/)
  })

  it('@title posé deux fois sur le même bouton → erreur', async () => {
    await assert.rejects(transpile('<button @title="A" @title="B">X</button>', { moduleName: 'dup2' }), /@title/)
  })

  it('deux directives DIFFÉRENTES sur la même balise → OK, aucune erreur', async () => {
    const { output } = await transpile('<button @confirm="A" @title="B">X</button>', { moduleName: 'dup3' })
    assert.match(output, /mjs-confirm/)
    assert.match(output, /mjs-title/)
  })

  it('la même directive sur DEUX balises différentes → OK, aucune erreur', async () => {
    const { output } = await transpile('<button @confirm="A">X</button><button @confirm="B">Y</button>', { moduleName: 'dup4' })
    assert.match(output, /mjs-confirm='A'/)
    assert.match(output, /mjs-confirm='B'/)
  })
})

describe('deux hooks du même nom dans un composant', function () {
  it('deux µmount -> dans le même <script> → erreur', async () => {
    const src = ['<script>', '@a = 0', '@b = 0', '', 'µmount ->', '  @a = 1', '', 'µmount ->', '  @b = 2', '</script>', '<p>{@a}{@b}</p>'].join('\n')
    await assert.rejects(transpile(src, { moduleName: 'hookdup' }), /mount/)
  })

  it('µmount -> + µawake -> (deux noms différents) → OK, aucune erreur', async () => {
    const src = ['<script>', '@a = 0', '@b = 0', '', 'µmount ->', '  @a = 1', '', 'µawake ->', '  @b = 2', '</script>', '<p>{@a}{@b}</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'hookok' })
    assert.match(output, /_mjs_hook\('mount'/)
    assert.match(output, /_mjs_hook\('awake'/)
  })
})

describe('deux bundles définissant le même tag : collision à l\'enregistrement', function () {
  this.timeout(20000)

  it('la sortie de transpile() délègue son enregistrement à l\'aide du cœur, qui porte la garde', async () => {
    const { output } = await transpile('<script>$x=1</script><p>{$x}</p>', { moduleName: 'coll1' })
    assert.match(output, /µ\._def\("mjs-coll1", [A-Za-z_$][\w$]*\);/)
    assert.equal(output.includes('customElements.define('), false, 'la garde ne doit plus être recopiée dans le module')
  })

  it('montage happy-dom : deux évaluations (2 "bundles" distincts) → un avertissement, aucune exception', async () => {
    const { output } = await transpile('<script>$x=1</script><p>{$x}</p>', { moduleName: 'coll2' })
    const code = stripEsmForEval(output)
    const window: any = new Window({ url: 'http://localhost/' })
    installMjsStub(window)
    // IIFE — chaque "bundle" a sa PROPRE portée de module en réalité (deux fichiers ES distincts,
    // même moduleName ⇒ même nom de classe) : seul `customElements` est un registre PARTAGÉ. Un
    // double eval() À PLAT redéclarerait la MÊME classe dans LE MÊME scope global (SyntaxError
    // sans rapport avec la garde sondée) — l'IIFE isole chaque "bundle" comme le ferait un vrai
    // module, tout en laissant `customElements`/`µ` réellement partagés.
    window.eval(`(function(){\n${code}\n})();`)
    assert.doesNotThrow(() => window.eval(`(function(){\n${code}\n})();`), 'la 2e définition ne doit jamais lever')
    const warnCount = window.eval('globalThis.__warns.length')
    assert.ok(warnCount >= 1, `au moins un avertissement attendu à la 2e définition (obtenu : ${warnCount})`)
  })
})

describe('ligne d\'erreur Civet décalée', function () {
  it('erreur de syntaxe franche à la ligne réelle 4 (script qui ne démarre pas en ligne 1) → le message cite la ligne 4', async () => {
    const src = ['<!-- description -->', '<script>', '$a = 1', '$c = = 2', '</script>', '<p>{$a}{$c}</p>'].join('\n')
    try {
      await transpile(src, { moduleName: 'lignerreur' })
      assert.fail('devait lever une erreur de syntaxe')
    }
    catch (e: any) {
      assert.match(e.message, /lignerreur\.script:4:/, `la ligne réelle (4) doit apparaître dans : ${e.message}`)
    }
  })

  it('témoin — <script> en ligne 1 : la ligne réelle reste correcte (décalage nul)', async () => {
    const src = ['<script>', '$a = 1', '$b = 2', '$c = = 2', '</script>', '<p>{$a}{$b}{$c}</p>'].join('\n')
    try {
      await transpile(src, { moduleName: 'lignerreur2' })
      assert.fail('devait lever une erreur de syntaxe')
    }
    catch (e: any) {
      assert.match(e.message, /lignerreur2\.script:4:/, `la ligne réelle (4) doit apparaître dans : ${e.message}`)
    }
  })
})

// ----------------------------------------------------------------------------
// six trous prouvés par les tests ci-dessous, un describe par point, même discipline que
// ci-dessus.
// ----------------------------------------------------------------------------

describe("this[`routes`] (gabarit sans expression) contourne encore detectRouterAware/detectRoutesReassignment", function () {
  it("notation gabarit this[`routes`] déclenche la même garde .page.mjs que la notation pointée", async () => {
    const dot      = '<script lang="js">this.routes = { root: { \'/\': \'home\' } };</script><p>x</p>'
    const template = '<script lang="js">this[`routes`] = { root: { \'/\': \'home\' } };</script><p>x</p>'
    await assert.rejects(transpile(dot, { moduleName: 'pgdotb5', isPageModule: false }), /\.page\.mjs/, 'témoin (notation pointée) : garde attendue')
    await assert.rejects(transpile(template, { moduleName: 'pgtplb5', isPageModule: false }), /\.page\.mjs/, 'notation gabarit : même garde attendue')
  })

  it("notation gabarit this[`routes`] = … pose _mjs_is_router_aware, comme this.routes = …", async () => {
    const template = '<script lang="js">this[`routes`] = { root: { \'/\': \'home\' } };</script><p>x</p>'
    const { output } = await transpile(template, { moduleName: 'rttplb5' })
    assert.match(output, /_mjs_is_router_aware = true/)
  })
})

describe("wrapModuleError : moduleName court, faux négatif par sous-chaîne (ex. 'a')", function () {
  it("moduleName='a' (piège : 'a' est une lettre de presque tout message) : le message est désormais préfixé", async () => {
    try {
      await transpile('<button @confirm={ text: 3 }>y</button>', { moduleName: 'a' })
      assert.fail('devait lever une erreur')
    }
    catch (e: any) {
      assert.match(e.message, /^'a' : /, `message préfixé attendu : ${e.message}`)
    }
  })

  it("moduleName='a' à travers transpileFile (double appel réel wrapModuleError, transpile() PUIS transpileFile()) : le préfixe n'apparaît qu'une fois", async function () {
    this.timeout(8000)
    const root = mjsTmp('wrapmodule-b5-2')
    const file = join(root, 'a.mjs')
    writeFileSync(file, '<button @confirm={ text: 3 }>y</button>')
    try {
      await transpileFile(file)
      assert.fail('devait lever une erreur')
    }
    catch (e: any) {
      assert.match(e.message, /^'a' : /, `message préfixé attendu : ${e.message}`)
      const occurrences = (e.message.match(/'a' : /g) ?? []).length
      assert.equal(occurrences, 1, `le préfixe ne doit apparaître qu'une seule fois : ${e.message}`)
    }
  })
})

describe('<!-- littéral dans une valeur d\'attribut avale le HTML jusqu\'au prochain --> réel', function () {
  it('<div title="<!--">…</div> suivi d\'une directive légitime : @confirm survit à la compilation', async () => {
    const src = '<div title="<!--">Hi</div><a @confirm="A">GO</a><!-- end --><p>fin</p>'
    const { output } = await transpile(src, { moduleName: 'trapcommentb5' })
    assert.match(output, /mjs-confirm='A'/, `la directive @confirm="A" doit survivre : ${output}`)
  })

  it('non-régression : un VRAI commentaire contenant @permanent="x" reste masqué', async () => {
    const src = '<!-- exemple : <a @permanent="x">l</a> --><p>contenu</p>'
    const { output } = await transpile(src, { moduleName: 'comb53' })
    assert.match(output, /contenu/)
  })
})

describe('directive dupliquée masquée par un > dans la valeur d\'un AUTRE attribut de la même balise', function () {
  it('> caché dans data-x=">" ENTRE deux @confirm de la même balise → transpiler.directive-dupliquee', async () => {
    await assert.rejects(transpile('<a @confirm="A" data-x=">" @confirm="B">x</a>', { moduleName: 'gtbetweenb5' }), /@confirm/)
  })

  it('non-régression : la même directive sur deux balises différentes → OK', async () => {
    const { output } = await transpile('<a @confirm="A">x</a><a @confirm="B">y</a>', { moduleName: 'diffb5' })
    assert.match(output, /mjs-confirm='A'/)
    assert.match(output, /mjs-confirm='B'/)
  })

  it('> caché dans title AVANT un unique @confirm (pas de doublon) → OK', async () => {
    const { output } = await transpile('<a title=">" @confirm="A">x</a>', { moduleName: 'gtattrb5' })
    assert.match(output, /mjs-confirm='A'/)
  })
})

describe("detectDuplicateHook : faux positif sur une CHAÎNE contenant _mjs_hook('mount', …)", function () {
  it('chaîne piège + un seul µmount -> légitime → OK, aucune erreur', async () => {
    const src = ['<script>', '@a = 0', 'this.msg = "_mjs_hook(\'mount\', 1)"', '', 'µmount ->', '  @a = 1', '</script>', '<p>{@a}</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'fauxposb5' })
    assert.match(output, /_mjs_hook\('mount'/)
  })

  it('non-régression : deux VRAIS µmount -> dans le même <script> → erreur toujours levée', async () => {
    const src = ['<script>', '@a = 0', '@b = 0', '', 'µmount ->', '  @a = 1', '', 'µmount ->', '  @b = 2', '</script>', '<p>{@a}{@b}</p>'].join('\n')
    await assert.rejects(transpile(src, { moduleName: 'hookdupb5' }), /mount/)
  })

  it('non-régression : µmount -> + µawake -> (deux noms différents) → OK', async () => {
    const src = ['<script>', '@a = 0', '@b = 0', '', 'µmount ->', '  @a = 1', '', 'µawake ->', '  @b = 2', '</script>', '<p>{@a}{@b}</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'hookokb5' })
    assert.match(output, /_mjs_hook\('mount'/)
    assert.match(output, /_mjs_hook\('awake'/)
  })
})

describe('remapAdapterErrorLine ne couvre pas <script module> (seul <script> composant l\'était)', function () {
  it('erreur de syntaxe Civet DANS <script module> précédé de 2 lignes HTML : le message cite la ligne réelle, pas la ligne relative au module seul', async () => {
    const src = ['<!-- l1 -->', '<!-- l2 -->', '<script module>', 'x = 1', 'y = = 2', '</script>', '<p>y</p>'].join('\n')
    try {
      await transpile(src, { moduleName: 'modlignerreurb5' })
      assert.fail('devait lever une erreur de syntaxe')
    }
    catch (e: any) {
      assert.doesNotMatch(e.message, /modlignerreurb5\.module:2:/, `ne doit PAS citer la ligne relative au module seul (2), décalée : ${e.message}`)
      assert.match(e.message, /modlignerreurb5\.module:5:/, `la ligne réelle (5) doit apparaître dans : ${e.message}`)
    }
  })

  it('témoin — <script> composant, même piège (non-régression)', async () => {
    const src = ['<script>', '$a = 1', '$b = 2', '$c = = 2', '</script>', '<p>{$a}{$b}{$c}</p>'].join('\n')
    try {
      await transpile(src, { moduleName: 'temoinb5' })
      assert.fail('devait lever une erreur de syntaxe')
    }
    catch (e: any) {
      assert.match(e.message, /temoinb5\.script:4:/, `la ligne réelle (4) doit apparaître dans : ${e.message}`)
    }
  })
})
