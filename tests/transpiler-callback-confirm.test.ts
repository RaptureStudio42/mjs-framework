// compile : directive @callback (nouvelle) + @confirm forme OBJET (extension). Volet
// COMPILE seulement (preprocessHtml, transpiler/index.ts) — le volet runtime est couvert par
// tests/ujs-callback.test.ts et tests/ujs-confirm-object.test.ts. Même style que
// tests/transpiler.test.ts (transpile() appelé directement, pas le Bundler complet — inutile ici,
// aucune de ces 2 directives ne touche au système de fichiers/imports).
//
// @confirm={expr} (forme EXPRESSION) s'ajoute ici aussi (compile),
// PLUS un unique test bout en bout (Bundler + happy-dom, même harnais que
// tests/ujs-shadow-confirm.test.ts) qui prouve que la valeur lue au clic suit la variable réactive.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { transpile } from '../src/transpiler/index.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

// runtimeHtmlOf — le générateur embarque le HTML dans un littéral JS DOUBLE-quotes
// (µ._mjs_cloneTpl("...")) : un backslash déjà présent dans l'attribut (ex. co9, réintroduit par
// JSON.stringify pour échapper un guillemet) y est RE-échappé (\\) pour survivre à l'embarquement
// JS — CORRECT, pas un bug (le runtime le résout d'un coup à l'exécution, même chose qu'un
// navigateur exécutant _mjs_cloneTpl). On rejoue ce dernier pas ici pour
// observer la valeur RÉELLE plutôt que le texte-source encore doublement échappé.
function runtimeHtmlOf(output: string): string {
  const start = output.indexOf('_mjs_cloneTpl(')
  const qi = output.indexOf('"', start)
  let i = qi + 1
  while (output[i] !== '"') { if (output[i] === '\\') i++; i++ }
  return Function(`return ${output.slice(qi, i + 1)}`)()
}

describe('transpiler — @callback', () => {
  it('@callback="nom" (guillemets doubles) → mjs-callback=\'nom\' dans le composant compilé', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @callback="onSaved">Enregistrer</button>`
    const { output } = await transpile(src, { moduleName: 'cb1' })
    assert.match(output, /mjs-callback=['"]onSaved['"]/)
  })

  it("@callback='nom' (guillemets simples) → même résultat", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @callback='onSaved'>Enregistrer</button>`
    const { output } = await transpile(src, { moduleName: 'cb2' })
    assert.match(output, /mjs-callback=['"]onSaved['"]/)
  })

  it('nom composé valide ($_$99 etc., identifiant simple [A-Za-z_$][\\w$]*) → compile', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @callback="_onSaved$2">x</a>`
    const { output } = await transpile(src, { moduleName: 'cb3' })
    assert.match(output, /mjs-callback=['"]_onSaved\$2['"]/)
  })

  it('forme ACCOLADES @callback={expr} → ERREUR de compile explicite (piège écouteur DOM fantôme)', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @callback={someHandler}>x</button>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'cb4' }),
      /@callback.*NOM de méthode entre guillemets.*pas une expression entre accolades/s,
    )
  })

  it('nom commençant par un chiffre → ERREUR (identifiant invalide)', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @callback="123abc">x</button>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'cb5' }),
      /@callback.*NOM de méthode entre guillemets/s,
    )
  })

  it('nom avec tiret → ERREUR (identifiant invalide, même message que la forme accolades)', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @callback="foo-bar">x</button>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'cb6' }),
      /@callback.*NOM de méthode entre guillemets/s,
    )
  })

  it('forme ACCOLADES avec accolades IMBRIQUÉES → la garde détecte quand même, même erreur', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @callback={ foo: {bar} }>x</button>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'cb7' }),
      /@callback.*NOM de méthode entre guillemets.*pas une expression entre accolades/s,
    )
  })
})

describe('transpiler — @confirm forme objet (extension)', () => {
  it("forme CHAÎNE (comportement historique) INCHANGÉE : @confirm=\"...\" → mjs-confirm='...' littéral", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm="Vraiment supprimer ?">Suppr</a>`
    const { output } = await transpile(src, { moduleName: 'co1' })
    assert.match(output, /mjs-confirm=['"]Vraiment supprimer \?['"]/)
  })

  it('forme CHAÎNE avec accolade LITTÉRALE dans le message → survit, échappée puis décodable', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm="Supprimer {tout} ?">Suppr</a>`
    const { output } = await transpile(src, { moduleName: 'co1b' })
    const m = output.match(/mjs-confirm=(["'])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-confirm introuvable')
    assert.doesNotMatch(m![2], /[{}]/, 'aucune accolade LITTÉRALE dans l\'attribut émis')
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.equal(decoded, 'Supprimer {tout} ?')
  })

  it('forme OBJET complète {text,ok,cancel} → mjs-confirm porte du JSON STRICT (échappé, décodable)', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm={ text: 'Vraiment supprimer ?', ok: 'Supprimer', cancel: 'Annuler' }>Suppr</a>`
    const { output } = await transpile(src, { moduleName: 'co2' })
    const m = output.match(/mjs-confirm=(['"])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-confirm introuvable dans le composant compilé')
    // entités HTML : accolades ET guillemets échappés (même piège que data-mjs-vt — sinon le
    // pipeline générique d'attributs prendrait la valeur pour une interpolation JS).
    const raw = m![2]
    assert.doesNotMatch(raw, /[{}]/, 'aucune accolade LITTÉRALE dans l\'attribut émis')
    const decoded = raw.replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    const parsed = JSON.parse(decoded)
    assert.deepEqual(parsed, { text: 'Vraiment supprimer ?', ok: 'Supprimer', cancel: 'Annuler' })
  })

  it('forme OBJET partielle (SEULEMENT text) → JSON ne porte que la clé fournie', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm={ text: 'Continuer ?' }>x</a>`
    const { output } = await transpile(src, { moduleName: 'co3' })
    const m = output.match(/mjs-confirm=(['"])((?:(?!\1)[\s\S])*)\1/)
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.deepEqual(JSON.parse(decoded), { text: 'Continuer ?' })
  })

  it('guillemets doubles ACCEPTÉS pour les valeurs (pas seulement simples)', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm={ text: "Vraiment ?", ok: "Oui" }>x</a>`
    const { output } = await transpile(src, { moduleName: 'co4' })
    const m = output.match(/mjs-confirm=(['"])((?:(?!\1)[\s\S])*)\1/)
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.deepEqual(JSON.parse(decoded), { text: 'Vraiment ?', ok: 'Oui' })
  })

  it("accolade LITTÉRALE dans une valeur : @confirm={ text: 'a{b', ok: \"l'ouest\" } → JSON valide, texte intact", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm={ text: 'a{b', ok: "l'ouest" }>Suppr</a>`
    const { output } = await transpile(src, { moduleName: 'co4b' })
    const m = output.match(/mjs-confirm=(['"])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-confirm introuvable (accolade dans la chaîne a fait échouer l\'extraction)')
    assert.doesNotMatch(m![2], /[{}]/, 'aucune accolade LITTÉRALE dans l\'attribut émis')
    // &#39; : apostrophe échappée par le générateur (attribut statique re-émis en guillemets
    // simples, cf. src/generator/attributes/index.ts) — DÉCODÉE au parse HTML, même
    // mécanisme que &quot;/&#123;/&#125; posés par escapeVtAttrValue.
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/&#39;/g, "'")
    const parsed = JSON.parse(decoded)
    assert.equal(parsed.text, 'a{b')
    assert.equal(parsed.ok, "l'ouest")
  })

  it('accolades IMBRIQUÉES dans une valeur ({a{b}c}) → extraction équilibrée, texte intact', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm={ text: '{a{b}c}' }>x</a>`
    const { output } = await transpile(src, { moduleName: 'co4c' })
    const m = output.match(/mjs-confirm=(['"])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-confirm introuvable')
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.deepEqual(JSON.parse(decoded), { text: '{a{b}c}' })
  })

  it('clé HORS text/ok/cancel → ERREUR de compile explicite', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm={ text: 'x', danger: 'y' }>x</a>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'co5' }),
      /@confirm=\{.*forme objet invalide.*text\/ok\/cancel/s,
    )
  })

  it('valeur VARIABLE (pas une chaîne littérale) → ERREUR, aucune expression tolérée', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm={ text: messageVar }>x</a>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'co6' }),
      /forme objet invalide/,
    )
  })

  it('valeur EXPRESSION (concaténation) → ERREUR, même garde', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm={ text: 'a' + 'b' }>x</a>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'co7' }),
      /forme objet invalide/,
    )
  })
})

describe('transpiler — @confirm apostrophe échappée', () => {
  it("forme OBJET, cas EXACT du verdict : @confirm={ text: 'l\\'ouest {c}', ok: 'Oui' } → JSON décodable, text intact (apostrophe échappée ET accolade littérale)", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm={ text: 'l\\'ouest {c}', ok: 'Oui' }>Suppr</a>`
    const { output } = await transpile(src, { moduleName: 'co8' })
    const m = output.match(/mjs-confirm=(['"])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-confirm introuvable (apostrophe échappée a fait échouer l\'extraction)')
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/&#39;/g, "'")
    const parsed = JSON.parse(decoded)
    assert.equal(parsed.text, "l'ouest {c}")
    assert.equal(parsed.ok, 'Oui')
  })

  it('forme OBJET, guillemets doubles échappés dans une valeur : @confirm={ text: "dit \\"salut\\"", ok: "Oui" } → JSON décodable, guillemet littéral intact (valeur RUNTIME, cf. runtimeHtmlOf)', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm={ text: "dit \\"salut\\"", ok: "Oui" }>Suppr</a>`
    const { output } = await transpile(src, { moduleName: 'co9' })
    const html = runtimeHtmlOf(output)
    const m = html.match(/mjs-confirm=(['"])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-confirm introuvable')
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/&#39;/g, "'")
    const parsed = JSON.parse(decoded)
    assert.equal(parsed.text, 'dit "salut"')
  })

  it("forme CHAÎNE avec apostrophe échappée : @confirm='J\\'accepte vraiment' → attribut PROPRE (pas de corruption), gabarit isométrique", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @confirm='J\\'accepte vraiment'>go</button>`
    const { output } = await transpile(src, { moduleName: 'co10' })
    const m = output.match(/mjs-confirm=(['"])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-confirm introuvable')
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/&#39;/g, "'")
    assert.equal(decoded, "J'accepte vraiment")
    assert.equal((output.match(/<\/button>/g) || []).length, 1, 'le gabarit doit rester équilibré, une seule fermeture </button>')
  })

  it('forme CHAÎNE avec guillemets doubles échappés : @confirm="Elle dit \\"stop\\"" → décodé exact', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @confirm="Elle dit \\"stop\\"">go</button>`
    const { output } = await transpile(src, { moduleName: 'co11' })
    const m = output.match(/mjs-confirm=(['"])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-confirm introuvable')
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.equal(decoded, 'Elle dit "stop"')
  })

  it("forme CHAÎNE JAMAIS refermée (@confirm='abc sans guillemet final) → ERREUR de compile explicite, jamais de HTML corrompu", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<button @confirm='abc</button>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'co12' }),
      /@confirm=\{.*forme objet invalide/s,
    )
  })
})

describe('transpiler — @confirm forme EXPRESSION', () => {
  // même disambiguation que @title={...} (tests/transpiler-title.test.ts, ti15/ti16) : un hash
  // d'options porte toujours au moins une « clé: » en tête, tout le reste PASSE-PLAT en
  // mjs-confirm={expr}, réactif — slot vide dans le template statique + `_mjs_updAttr` séparé, PAS
  // une recherche du texte `{$message}` verbatim dans la sortie.
  it("@confirm={$message} (variable seule) → passe-plat réactif, PAS d'erreur", async () => {
    const src = `<script lang="coffee">\n$message = 'Vraiment ?'\n</script>\n<button @confirm={$message}>Suppr</button>`
    const { output } = await transpile(src, { moduleName: 'coe1' })
    assert.match(output, /mjs-confirm=''/, 'slot vide dans le template statique, pas de texte figé')
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-confirm',\s*\$\.message\)/, 'câblage réactif, même mécanisme que mjs-title={expr}')
  })

  it('@confirm={ $message } (espaces autour) → même passe-plat', async () => {
    const src = `<script lang="coffee">\n$message = 'Vraiment ?'\n</script>\n<button @confirm={ $message }>Suppr</button>`
    const { output } = await transpile(src, { moduleName: 'coe2' })
    assert.match(output, /mjs-confirm=''/)
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-confirm',\s*\$\.message\)/)
  })

  it('@confirm={$a || $b} (expression logique) → passe-plat réactif', async () => {
    const src = `<script lang="coffee">\n$a = ''\n$b = 'Sûr ?'\n</script>\n<button @confirm={$a || $b}>Suppr</button>`
    const { output } = await transpile(src, { moduleName: 'coe3' })
    assert.match(output, /mjs-confirm=''/)
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-confirm',\s*\$\.a \|\| \$\.b\)/)
  })

  it('@confirm={maFonction()} (appel de fonction) → passe-plat réactif', async () => {
    const src = `<script lang="coffee">\nmaFonction = -> 'Vraiment ?'\n</script>\n<button @confirm={maFonction()}>Suppr</button>`
    const { output } = await transpile(src, { moduleName: 'coe4' })
    assert.match(output, /mjs-confirm=''/)
    assert.match(output, /_mjs_updAttr\('[^']+',\s*'mjs-confirm',\s*maFonction\(\)\)/)
  })

  it("@confirm={ text: 'Sûr ?' } (une SEULE clé, forme objet) → comportement INCHANGÉ, toujours l'objet strict", async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm={ text: 'Sûr ?' }>Suppr</a>`
    const { output } = await transpile(src, { moduleName: 'coe5' })
    const m = output.match(/mjs-confirm=(['"])((?:(?!\1)[\s\S])*)\1/)
    assert.ok(m, 'attribut mjs-confirm introuvable (forme objet toujours attendue)')
    const decoded = m![2].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.deepEqual(JSON.parse(decoded), { text: 'Sûr ?' })
  })

  it("@confirm={ text: maVar } → TOUJOURS l'erreur confirm-objet-invalide (une valeur de clé reste un littéral, même après l'ajout de la forme expression)", async () => {
    const src = `<script lang="coffee">\n$x = 0\nmaVar = 'Sûr ?'\n</script>\n<a @confirm={ text: maVar }>Suppr</a>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'coe6' }),
      /forme objet invalide/,
    )
  })

  it('@confirm="chaîne" (forme historique) INCHANGÉE — non-régression après l\'ajout de la forme expression', async () => {
    const src = `<script lang="coffee">\n$x = 0\n</script>\n<a @confirm="Vraiment supprimer ?">Suppr</a>`
    const { output } = await transpile(src, { moduleName: 'coe7' })
    assert.match(output, /mjs-confirm=['"]Vraiment supprimer \?['"]/)
  })
})

describe('transpiler — @confirm forme EXPRESSION, bout en bout (composant réel, happy-dom)', function () {
  this.timeout(40000)

  it('la valeur lue par le runtime au clic suit la variable réactive — PAS celle figée au montage (même harnais que tests/ujs-shadow-confirm.test.ts)', async function () {
    const COMPONENT = `
<script>
$msg = 'Un ?'
$count = 0
changeMsg = -> $msg = 'Deux ?'
go = -> $count = $count + 1
</script>
<button id="chg" @click={changeMsg()}>Changer</button>
<button id="go" @confirm={$msg} @click={go()}>Aller</button>
<p id="cnt">{$count}</p>
`
    const root = mjsTmp('confirm-expr-e2e')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'confirmexpr.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^confirmexpr-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
    window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    const confirmCalls: string[] = []
    window.confirm = function (msg: string) { confirmCalls.push(msg); return true }
    // boîte native SYNCHRONE (même choix que ujs-shadow-confirm.test.ts) : la décision est
    // rendue dans le même tour d'événement, pas de promesse à attendre en plus.
    window.µ.config.confirm = false

    assert.ok(window.customElements.get('mjs-confirmexpr'), 'mjs-confirmexpr enregistré')
    document.body.innerHTML = '<mjs-confirmexpr></mjs-confirmexpr>'
    const el = document.body.firstElementChild
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(el._shadow, 'shadow root monté')

    function click(id: string) {
      const btn = el._shadow.querySelector('#' + id)
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 }))
    }
    function count(): string {
      return el._shadow.querySelector('#cnt').textContent
    }

    click('go')
    await new Promise((r) => setTimeout(r, 50))
    click('chg')
    await new Promise((r) => setTimeout(r, 50))
    click('go')
    await new Promise((r) => setTimeout(r, 50))

    assert.deepEqual(confirmCalls, ['Un ?', 'Deux ?'], 'la valeur lue au 2e clic doit être la NOUVELLE, pas celle figée au montage')
    assert.equal(count(), '2', 'les deux clics sur #go ont bien tourné (confirm accepté les deux fois)')

    window.close?.()
    await terminateSharedWorkerPool()
  })
})
