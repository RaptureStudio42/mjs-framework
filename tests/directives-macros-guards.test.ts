// Test du compilateur MJS V2, un describe par point. Chaque point
// reprend la preuve/reproduction de chaque bogue sous forme de test mocha.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { transpile } from '../src/transpiler/index.js'
import { checkA11y } from '../src/transpiler/a11y.js'
import { processGlobalMacros } from '../src/transpiler/macros.js'
import { findMacroTagEnd } from '../src/transpiler/macro-tag.js'
import { compileServerFile } from '../src/cli/server-entry.js'
import { mjsTmp } from './helpers/tmp.js'

describe('injection JS par la cible de @import (guillemet mixte)', function () {
  this.timeout(10000)

  it("guillemet mixte ('x\"; …; \"') → rejette (donc aucune sortie compilée ne peut embarquer __PWNED__)", async () => {
    const payload = `x"; globalThis.__PWNED__=1337; "`
    const src = `@import Foo '${payload}'\n<div>x</div>`
    await assert.rejects(() => transpile(src, { moduleName: 'probeb21a' }))
  })

  it("cible './fo\"o.mjs' (guillemet interne, même famille que le simple d'ouverture) → erreur claire nommant la cible", async () => {
    const src = `@import Foo './fo"o.mjs'\n<div>x</div>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'probeb21b' }),
      (err: any) => {
        assert.match(err.message, /fo"o\.mjs/)
        return true
      }
    )
  })

  it('cibles normales inchangées : ./a.civet, "lib/x.js", modularjs-framework/ws, https://…', async () => {
    for (const cible of [`'./a.civet'`, `"lib/x.js"`, `'modularjs-framework/ws'`, `'https://cdn.example.test/lib.js'`]) {
      const src = `@import Foo ${cible}\n<div>x</div>`
      const { output } = await transpile(src, { moduleName: 'probeb21c' })
      assert.match(output, /import \{ Foo \} from/)
    }
  })

  it('server-entry — compileServerFile sur une entry avec cible @import invalide → rejette', async () => {
    const root = mjsTmp('b21-server-entry')
    mkdirSync(join(root, 'node_modules'))   //cache SOUS node_modules, même convention que server-entry-raw-import.test.ts
    const entryPath = join(root, 'entry.server.mjs')
    writeFileSync(entryPath, `@import a 'x"; globalThis.__PWNED3__=1; "'\n\nexport default { setup(app) { return null } }\n`)
    await assert.rejects(() => compileServerFile(entryPath, root))
    rmSync(root, { recursive: true, force: true })
  })
})

// @import $nom (dollar simple) → erreur : BLOQUÉ, non implémenté.
// Preuve empirique posant le blocage : la pré-passe 0-bis de transpile() (transpiler/index.ts:3152-3193)
// aplatit toute occurrence de µ$$X en $X AVANT extractDirectives — au moment
// où cette dernière voit la ligne @import, un import de singleton légitime (`@import µ$$counter '...'`)
// et un `@import $counter '...'` tapé à la main sont un seul et même texte, indiscernables. Un garde-fou
// générique « nom commençant par $ → erreur » posé DANS directives.ts casse donc, de façon prouvée par
// exécution réelle, 4 tests déjà présents dans le dépôt : tests/transpiler.test.ts
// (« extrait @import named et populate externalReactives », l.32-36 ; « @import populate l'auto-import
// dans le module », l.266-273) et tests/import-singleton-consume.test.ts (plusieurs `it`, câblage
// @import µ$$X entier). Correctif hors d'atteinte ici (directives.ts
// seul, jamais transpiler/index.ts).

describe('<@window constructor=!{$y}> : crash TypeError (garde de prototype)', function () {
  this.timeout(10000)

  // espionne console.error le temps d'un transpile (même motif que warningsFor, tests/a11y-lint.test.ts)
  async function errorsFor(src: string, moduleName: string): Promise<string[]> {
    const orig = console.error
    const caught: string[] = []
    console.error = (...a: unknown[]) => { caught.push(String(a[0])) }
    try { await transpile(src, { moduleName }) } finally { console.error = orig }
    return caught
  }

  for (const prop of ['constructor', 'toString', 'hasOwnProperty']) {
    it(`<@window ${prop}=!{$y}> : message propre « non liable », pas de TypeError`, async () => {
      const errs = await errorsFor(`<@window ${prop}=!{$y}>\n<div>{$y}</div>`, 'probeb23' + prop)
      assert.ok(errs.some(m => m.includes('non liable')), `messages capturés : ${JSON.stringify(errs)}`)
    })
  }

  it('scrollY=!{$y} reste liable (témoin, aucune régression)', async () => {
    const errs = await errorsFor(`<@window scrollY=!{$y}>\n<div>{$y}</div>`, 'probeb23scrolly')
    assert.deepEqual(errs, [])
  })
})

describe('findMacroTagEnd sans borne : perte de contenu silencieuse', () => {
  it("accolade d'attribut jamais refermée + <div>/<p> intermédiaires → erreur nommant la macro, rien n'est avalé en silence", () => {
    const html = `<@window @click={foo(bar>\n<div>SECTION-INTERMEDIAIRE-A</div>\n<p>APRES-1</p>\nbaz}>\n<p>APRES-2</p>`
    const r = processGlobalMacros(html)
    assert.ok(r.errors.some(e => e.includes('window')), `errors: ${JSON.stringify(r.errors)}`)
    assert.ok(r.html.includes('SECTION-INTERMEDIAIRE-A'), `html: ${JSON.stringify(r.html)}`)
    assert.ok(r.html.includes('APRES-1'), `html: ${JSON.stringify(r.html)}`)
  })

  it('témoin — comparaison < dans un handler sur une seule ligne (if $a < $b) : aucune erreur', () => {
    const html = `<@window @click={ if $a < $b then f() }>`
    const r = processGlobalMacros(html)
    assert.deepEqual(r.errors, [])
  })

  it('témoin — handler multi-lignes légitime (sans <) : aucune erreur', () => {
    const html = `<@window @click={\n  x := 1\n  f(x)\n}>`
    const r = processGlobalMacros(html)
    assert.deepEqual(r.errors, [])
  })
})

describe('a11y : role="presentation"/"none" coupe l\'alerte à tort', () => {
  // dernier message = rappel de désactivation (ajouté dès qu'il y a ≥1 alerte), même convention que tests/a11y-lint.test.ts
  function realAlerts(msgs: string[]): string[] {
    return msgs.length ? msgs.slice(0, -1) : msgs
  }

  it('role="presentation" + @click sur <div> non interactif : alerte quand même (le rôle retire la sémantique, ne la donne pas)', () => {
    const alerts = realAlerts(checkA11y('<div role="presentation" @click={f()}>x</div>', 'modb25a'))
    assert.equal(alerts.length, 1, JSON.stringify(alerts))
  })

  it('role="none" + @click : alerte quand même (même famille que "presentation")', () => {
    const alerts = realAlerts(checkA11y('<div role="none" @click={f()}>x</div>', 'modb25b'))
    assert.equal(alerts.length, 1, JSON.stringify(alerts))
  })

  it('role="button" (témoin, rôle réellement interactif) : aucune alerte', () => {
    assert.deepEqual(checkA11y('<div role="button" @click={f()}>x</div>', 'modb25c'), [])
  })
})

// Trois angles morts supplémentaires :
// le premier rouvre @import sur #{…}/${…}/backtick + cible vide ; le deuxième corrige une RÉGRESSION
// du correctif précédent sur findMacroTagEnd (heredoc Civet pris pour une balise ouverte) ; le
// troisième corrige une RÉGRESSION du correctif précédent sur l'alerte a11y
// (role="presentation" + écouteur clavier, motif ARIA de fond de modale).

describe('@import : #{…}/${…}/backtick (interpolation) et cible vide contournent la validation', function () {
  this.timeout(10000)

  it("cible bénigne 'x#{1+1}y' (sans effet de bord) → rejette désormais (avant : compilait en import mort, spécificateur littéral jamais résolu par Node)", async () => {
    const src = `@import Foo 'x#{1+1}y'\n<div>x</div>\n`
    await assert.rejects(() => transpile(src, { moduleName: 'b41benin' }))
  })

  it("charge à effet de bord 'x#{globalThis.__PWNED_T347B4__=1337}y' → rejette avec un message clair (jamais un ParseError Civet illisible)", async () => {
    const src = `@import Foo 'x#{globalThis.__PWNED_T347B4__=1337}y'\n<div>x</div>\n`
    await assert.rejects(
      () => transpile(src, { moduleName: 'b41pwned' }),
      (err: any) => {
        assert.match(err.message, /cible/)
        assert.doesNotMatch(err.message, /Failed to parse/)
        return true
      }
    )
  })

  it('gabarit JS ${…} et backtick nu dans la cible → rejettent aussi', async () => {
    for (const payload of ['x${1+1}y', 'x`y']) {
      const src = `@import Foo '${payload}'\n<div>x</div>\n`
      await assert.rejects(() => transpile(src, { moduleName: 'b41tmpl' }), `payload ${payload} aurait dû rejeter`)
    }
  })

  it("server-entry — compileServerFile sur une entry avec cible 'x#{1+1}y' → rejette (même garde que directives.ts)", async () => {
    const root = mjsTmp('b41-server-entry')
    mkdirSync(join(root, 'node_modules'))   //cache SOUS node_modules, même convention que server-entry-raw-import.test.ts
    const entryPath = join(root, 'entry.server.mjs')
    writeFileSync(entryPath, `@import a 'x#{1+1}y'\n\nexport default { setup(app) { return null } }\n`)
    await assert.rejects(() => compileServerFile(entryPath, root))
    rmSync(root, { recursive: true, force: true })
  })

  it('cible normale inchangée : ./a.civet, "lib/x.js" compilent toujours', async () => {
    for (const cible of [`'./a.civet'`, `"lib/x.js"`]) {
      const src = `@import Foo ${cible}\n<div>x</div>\n`
      const { output } = await transpile(src, { moduleName: 'b41normal' })
      assert.match(output, /import \{ Foo \} from/)
    }
  })

  it("cible vide ('' ou \"\") → rejette, ne fuit plus en texte brut dans le HTML rendu (_mjs_cloneTpl)", async () => {
    for (const q of [`''`, `""`]) {
      const src = `@import Foo ${q}\n<div>x</div>\n`
      await assert.rejects(() => transpile(src, { moduleName: 'b41vide' }), `cible ${q} aurait dû rejeter`)
    }
  })
})

describe('findMacroTagEnd : heredoc/chaîne à profondeur > 0 pris pour une balise ouverte (régression du correctif précédent)', function () {
  this.timeout(10000)

  it("heredoc Civet '''…''' contenant un <b> en tête de ligne dans un handler @click : aucune erreur « balise jamais refermée » (AVANT la borne : trouvée ligne 59 ; borne seule : -1, régression)", () => {
    const html = `<@window @click={\n  html := '''\n<b>gras</b>\n'''\n  f(html)\n}>\n<div>x</div>`
    const r = processGlobalMacros(html)
    assert.deepEqual(r.errors, [], `errors: ${JSON.stringify(r.errors)}`)
  })

  it('findMacroTagEnd directement → 59, même résultat qu\'avant la borne', () => {
    const html = `<@window @click={\n  html := '''\n<b>gras</b>\n'''\n  f(html)\n}>\n<div>x</div>`
    const nameEnd = '<@window'.length
    assert.equal(findMacroTagEnd(html, nameEnd), 59)
    assert.equal(html[59], '>')
  })

  it('même heredoc, compilation Civet réelle bout en bout (transpile()) : compile sans erreur, f(html) présent', async () => {
    const src = `<script>\n  f = (h)-> console.log(h)\n</script>\n\n<@window @click={\n  html := '''\n<b>gras</b>\n'''\n  f(html)\n}>\n<div>x</div>\n`
    const { output } = await transpile(src, { moduleName: 'b42heredoc' })
    assert.match(output, /f\(html\)/)
  })

  it('accolade dans une chaîne à profondeur > 0 (@click={ s := "}" }) : fin de balise correcte', () => {
    const html = `<@window @click={ s := "}" }>\n<div>x</div>`
    const r = processGlobalMacros(html)
    assert.deepEqual(r.errors, [], `errors: ${JSON.stringify(r.errors)}`)
    const nameEnd = '<@window'.length
    const end = findMacroTagEnd(html, nameEnd)
    assert.equal(end, 28)
    assert.equal(html[end], '>')
  })

  it('témoin non-régression — accolade jamais refermée + HTML avalé reste une erreur nommant la macro (même garde, hors chaîne)', () => {
    const html = `<@window @click={foo(bar>\n<div>SECTION-INTERMEDIAIRE-A</div>\n<p>APRES-1</p>\nbaz}>\n<p>APRES-2</p>`
    const r = processGlobalMacros(html)
    assert.ok(r.errors.some(e => e.includes('window')), `errors: ${JSON.stringify(r.errors)}`)
    const nameEnd = '<@window'.length
    assert.equal(findMacroTagEnd(html, nameEnd), -1)
  })
})

describe('a11y : role="presentation"/"none" + écouteur clavier justifie (régression du correctif précédent)', () => {
  function realAlerts(msgs: string[]): string[] {
    return msgs.length ? msgs.slice(0, -1) : msgs
  }

  it('fragment réel (modale de fond, fermeture au clic et au clavier) : role="presentation" + @click.self + @keydown → 0 alerte', () => {
    const html = `<div\n  role="presentation"\n  class="modal-background"\n  @click.self={$showMenu = false}\n  @keydown={handleKeydown}\n>\n  x\n</div>`
    assert.deepEqual(checkA11y(html, 'b43modale'), [])
  })

  it('role="presentation" + @click SANS clavier : alerte toujours (comportement inchangé)', () => {
    const alerts = realAlerts(checkA11y('<div role="presentation" @click={f()}>x</div>', 'b43sansclavier'))
    assert.equal(alerts.length, 1, JSON.stringify(alerts))
  })

  it('role="button" (témoin, rôle réellement interactif) : aucune alerte', () => {
    assert.deepEqual(checkA11y('<div role="button" @click={f()}>x</div>', 'b43bouton'), [])
  })
})
