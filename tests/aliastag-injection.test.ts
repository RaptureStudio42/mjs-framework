// `data.aliasTag` (transpiler/index.ts) inséré SANS
// échappement dans les deux littéraux de la ligne d'alias — aujourd'hui `µ._al("${data.aliasTag}", …)`,
// l'aide du cœur qui porte l'enregistrement (injectTemplate) — même défaut que pour moduleName/tagName (cf. tests/transpiler-index-injection-
// guards.test.ts) mais sur `aliasTag`, jamais couvert. Fix : même `escapeJsString`
// locale que pour [[MOD_NAME]]/[[TAG_NAME]].
// Harnais (installMjsStub/evalAndConstruct/stripEsmForEval) copié de tests/transpiler-index-injection-
// guards.test.ts : les fichiers de test ne s'importent jamais
// entre eux.

import assert from 'node:assert/strict'
import * as acorn from 'acorn'
import { Window } from 'happy-dom'
import { transpile } from '../src/transpiler/index.js'

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
      _al(tag, key, C) { customElements.define(tag, class extends C {}) },
      _def(tag, C) { if(!customElements.get(tag)) customElements.define(tag, C) },
      _mjs_cloneTpl() { return document.createDocumentFragment() },
    }
    globalThis.__warns = []
  `)
}

// évalue `code` (déjà dépouillé) dans `window`, tolère l'échec ATTENDU de l'auto-define du tag
// alias (un aliasTag malveillant reste un nom de balise custom-element INVALIDE, même bien
// échappé au sens JS — hors sujet ici, seule l'injection de CODE compte, pas la validité du tag).
function evalAndConstruct(window: any, code: string, className: string): void {
  installMjsStub(window)
  try { window.eval(code) } catch { /* auto-define potentiellement en échec (tag invalide) — attendu */ }
  window.eval(`
    try { new ${className}() }
    catch {
      try { customElements.define('mjs-b32-safe-'+ Math.random().toString(36).slice(2), ${className}) } catch {}
      try { new ${className}() } catch {}
    }
  `)
}

describe('injection JS via aliasTag non échappé', function () {
  this.timeout(20000)

  async function pwnedStaysUndefined(aliasTag: string): Promise<void> {
    const r = await transpile('<script>$x=1</script><p>{$x}</p>', { moduleName: 'probeb32', aliasTag })
    assert.doesNotThrow(() => acorn.parse(fixImportSpecifier(r.output), { ecmaVersion: 'latest', sourceType: 'module' }), 'la sortie de transpile() doit rester du JS valide (acorn, sourceType module)')
    const window: any = new Window({ url: 'http://localhost/' })
    evalAndConstruct(window, stripEsmForEval(r.output), r.data.className)
    assert.equal(window.eval('typeof globalThis.MJS_B32_PWNED'), 'undefined', 'globalThis.MJS_B32_PWNED ne doit JAMAIS être posé par un aliasTag malveillant')
  }

  it('aliasTag avec guillemet double : sortie JS valide, MJS_B32_PWNED jamais exécuté', async () => {
    await pwnedStaysUndefined('x"; globalThis.MJS_B32_PWNED = 1; //')
  })

  it("témoin — aliasTag normal, sortie inchangée (appel à l'aide du cœur posé)", async () => {
    const r = await transpile('<script>$x=1</script><p>{$x}</p>', { moduleName: 'probeb32temoin', aliasTag: 'mjs-alias-normal' })
    assert.equal(r.data.aliasTag, 'mjs-alias-normal')
    assert.match(r.output, /µ\._al\("mjs-alias-normal", "alias-normal", [A-Za-z_$][\w$]*\);/)
  })
})
