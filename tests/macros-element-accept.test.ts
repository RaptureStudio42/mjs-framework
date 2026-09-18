// Attribut `accept="a b"` sur <@element $tag>/<@module $comp> — volet COMPILATEUR.
// Le runtime (µ._mjs_dynTagsRefuses, 4e argument
// `accept`, casse normalisée côté valeurs) est déjà livré et testé côté pur runtime dans
// tests/runtime-dynamic-element-accept.test.ts : ce fichier prouve seulement que macros.ts
// reconnaît l'attribut, le retire des attributs rendus sur l'élément, et l'émet en 4e
// argument JS de µ._updDynEl/µ._updModule — jusqu'au DOM réel (bout en bout, e6).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { processGlobalMacros } from '../src/transpiler/macros.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('<@element>/<@module> accept="…" — compilation (macros.ts)', function () {
  it('(e1) accept="iframe" : 4e argument [\'iframe\'], jamais rendu comme attribut sur l\'élément', () => {
    const r = processGlobalMacros('<@element $tag accept="iframe">x</@element>')
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\), \['iframe'\]\)/)
    assert.doesNotMatch(r.html, /accept/)
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
  })

  it('(e2) accept="IFRAME Style" : noms normalisés en minuscules, ordre d\'écriture conservé', () => {
    const r = processGlobalMacros('<@element $tag accept="IFRAME Style">x</@element>')
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\), \['iframe', 'style'\]\)/)
    assert.doesNotMatch(r.html, /accept/i)
  })

  it('(e3) sans accept : appel à 3 arguments, setup/html BYTE-IDENTIQUES au comportement précédent (golden HEAD)', () => {
    const rEl = processGlobalMacros('<@element $tag>x</@element>')
    assert.equal(rEl.html, '<div mjs-el="0">x</div>')
    assert.equal(rEl.setup, '\nµeffect =>\n  µ._updDynEl(@, \'0\', ($tag))')
    assert.equal(rEl.errors.length, 0)

    const rMod = processGlobalMacros('<@module $comp>x</@module>')
    assert.equal(rMod.html, '<div mjs-mod="0">x</div>')
    assert.equal(rMod.setup, '\nµeffect =>\n  µ._updModule(@, \'0\', ($comp))')
    assert.equal(rMod.errors.length, 0)
  })

  it('(e4) <@module $comp accept="script"> : 4e argument [\'script\']', () => {
    const r = processGlobalMacros('<@module $comp accept="script">x</@module>')
    assert.match(r.setup, /µ\._updModule\(@, '0', \(\$comp\), \['script'\]\)/)
    assert.doesNotMatch(r.html, /accept/)
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
  })

  it('(e5) accept invalide (vide / dynamique / nom mal formé) : 1 erreur chacune, message citant la valeur, jamais rendu sur l\'élément', () => {
    const rVide = processGlobalMacros('<@element $tag accept="">x</@element>')
    assert.equal(rVide.errors.length, 1, JSON.stringify(rVide.errors))
    assert.match(rVide.errors[0], /accept="\s*"/)
    assert.doesNotMatch(rVide.html, /accept/)
    assert.match(rVide.setup, /µ\._updDynEl\(@, '0', \(\$tag\)\)/, 'accept invalide ⇒ retombe sur l\'appel à 3 arguments')

    const rDyn = processGlobalMacros('<@element $tag accept={$x}>x</@element>')
    assert.equal(rDyn.errors.length, 1, JSON.stringify(rDyn.errors))
    assert.match(rDyn.errors[0], /\$x/)
    assert.doesNotMatch(rDyn.html, /accept/)

    const rInvalide = processGlobalMacros('<@element $tag accept="<x>">x</@element>')
    assert.equal(rInvalide.errors.length, 1, JSON.stringify(rInvalide.errors))
    assert.match(rInvalide.errors[0], /<x>/)
    assert.doesNotMatch(rInvalide.html, /accept/)
  })

  it('doublon toléré (pas une erreur) : dédoublonné, insensible à la casse', () => {
    const r = processGlobalMacros('<@element $tag accept="iframe iframe IFRAME">x</@element>')
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\), \['iframe'\]\)/)
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
  })

  it('guillemets simples acceptés (accept=\'iframe\')', () => {
    const r = processGlobalMacros(`<@element $tag accept='iframe'>x</@element>`)
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\), \['iframe'\]\)/)
    assert.equal(r.errors.length, 0)
  })

  it('nom "accept" insensible à la casse (ACCEPT="iframe")', () => {
    const r = processGlobalMacros('<@element $tag ACCEPT="iframe">x</@element>')
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\), \['iframe'\]\)/)
    assert.doesNotMatch(r.html, /accept/i)
  })

  it('non-régression : <@element $tag title={$n > 1}> (attribut dynamique NON accept) traverse intact', () => {
    // même cas que macros-accolades-et-head.test.ts (c) — vérifie que extractAcceptAttr ne
    // mord jamais dans un attribut qui ne s'appelle pas accept.
    const r = processGlobalMacros('<@element $tag title={$n > 1}>x</@element>')
    assert.equal(r.html, '<div mjs-el="0" title={$n > 1}>x</div>')
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\)\)/)
  })
})

describe('<@element>/<@module> — la variable de balise doit venir en premier', () => {
  it('<@element accept="iframe" $tag> : attribut avant la variable → 1 erreur, rien émis en setup, $tag ne fuit pas dans le html', () => {
    const r = processGlobalMacros('<@element accept="iframe" $tag>x</@element>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.match(r.errors[0], /<@element>/)
    assert.doesNotMatch(r.setup, /µ\._updDynEl/)
    assert.doesNotMatch(r.html, /\$tag/)
  })

  it('<@element title="x" $tag> : même défaut (n\'importe quel attribut en tête), même garde', () => {
    const r = processGlobalMacros('<@element title="x" $tag>x</@element>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.doesNotMatch(r.setup, /µ\._updDynEl/)
    assert.doesNotMatch(r.html, /\$tag/)
  })

  it('<@module accept="script" $comp> : même garde côté <@module>', () => {
    const r = processGlobalMacros('<@module accept="script" $comp>x</@module>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.match(r.errors[0], /<@module>/)
    assert.doesNotMatch(r.setup, /µ\._updModule/)
    assert.doesNotMatch(r.html, /\$comp/)
  })

  it('<@module title="x" $comp> : même défaut côté <@module>', () => {
    const r = processGlobalMacros('<@module title="x" $comp>x</@module>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.doesNotMatch(r.setup, /µ\._updModule/)
    assert.doesNotMatch(r.html, /\$comp/)
  })

  it('non-régression : <@element $tag accept="iframe"> (ordre correct) reste intact', () => {
    const r = processGlobalMacros('<@element $tag accept="iframe">x</@element>')
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\), \['iframe'\]\)/)
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
  })

  it('non-régression : <@element $tag title="x"> (ordre correct) reste intact', () => {
    const r = processGlobalMacros('<@element $tag title="x">x</@element>')
    assert.equal(r.html, '<div mjs-el="0" title="x">x</div>')
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\)\)/)
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
  })
})

describe('<@element>/<@module> — accept dupliqué', () => {
  it('<@element $tag accept="a" accept="b"> : HTML sans aucun accept, 1 erreur', () => {
    const r = processGlobalMacros('<@element $tag accept="a" accept="b">x</@element>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.doesNotMatch(r.html, /accept/)
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\)\)/, 'accept invalide (doublon) ⇒ retombe sur l\'appel à 3 arguments')
  })

  it('<@module $comp accept="a" accept="b"> : même garde côté <@module>, HTML sans aucun accept', () => {
    const r = processGlobalMacros('<@module $comp accept="a" accept="b">x</@module>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.doesNotMatch(r.html, /accept/)
    assert.match(r.setup, /µ\._updModule\(@, '0', \(\$comp\)\)/)
  })

  it('triplé (3 occurrences) : purge quand même TOUTES les occurrences', () => {
    const r = processGlobalMacros('<@element $tag accept="a" accept="b" accept="c">x</@element>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.doesNotMatch(r.html, /accept/)
  })
})

describe('<@element>/<@module> — garde « variable en premier » ÉLARGIE', () => {
  // La garde précédente ne détectait qu'un attribut À VALEUR (`nom=…`) en tête. Un attribut BOOLÉEN
  // (`hidden`, sans `=`) ressemble à un identifiant nu ORDINAIRE — ATTR_LIKE_RE (qui exige un
  // `=`) le laissait passer tel quel comme expression de balise, `$tag` fuyait en HTML SANS
  // erreur. Même défaut pour `<@element>` vide (aucune variable DU TOUT).
  it("<@element hidden \$tag> : attribut booléen en tête (sans =) → 1 erreur, rien émis, \$tag ne fuit pas", () => {
    const r = processGlobalMacros('<@element hidden $tag>x</@element>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.match(r.errors[0], /<@element>/)
    assert.doesNotMatch(r.setup, /µ\._updDynEl/)
    assert.doesNotMatch(r.html, /\$tag/)
  })

  it('<@element disabled {expr}> : même défaut avec une expression (accolade) en 2ᵉ position', () => {
    const r = processGlobalMacros('<@element disabled {expr}>x</@element>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.doesNotMatch(r.setup, /µ\._updDynEl/)
    assert.doesNotMatch(r.html, /\{expr\}/)
  })

  it("<@element> vide (aucune variable du tout) : 1 erreur, l'ouvrante littérale disparaît (jamais dépareillée face au </div>)", () => {
    const r = processGlobalMacros('<@element>x</@element>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.match(r.errors[0], /<@element>/)
    assert.doesNotMatch(r.html, /<@element>/, 'l\'ouvrante ne doit plus rester littérale (custom element fantôme face à </div>)')
  })

  it("<@module hidden \$comp> : même garde côté <@module>", () => {
    const r = processGlobalMacros('<@module hidden $comp>x</@module>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.match(r.errors[0], /<@module>/)
    assert.doesNotMatch(r.setup, /µ\._updModule/)
    assert.doesNotMatch(r.html, /\$comp/)
  })

  it("non-régression : <@element tag> (identifiant nu SEUL, rien après) reste licite (variable de module possible)", () => {
    const r = processGlobalMacros('<@element tag>x</@element>')
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(tag\)\)/)
  })

  it("non-régression : <@element \$tag hidden> (ordre correct, attribut booléen APRÈS) reste intact", () => {
    const r = processGlobalMacros('<@element $tag hidden>x</@element>')
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
    assert.equal(r.html, '<div mjs-el="0" hidden>x</div>')
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\)\)/)
  })

  it("non-régression : <@element \$tag.x> (accès de membre sur la variable) reste intact", () => {
    const r = processGlobalMacros('<@element $tag.x>x</@element>')
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\.x\)\)/)
  })

  it("RETOURNÉ — <@element {a || 'div'}> (expression avec espaces internes) : ancien cas ACCEPTÉ, devient une ERREUR explicite", () => {
    // Jusqu'ici : la troncature de l'expression au 1er espace INTERNE ({a || 'div'} → tagExpr="{a",
    // reste "|| 'div'}" collé en HTML) était un défaut PRÉEXISTANT ; ce test
    // vérifiait juste l'absence d'une fausse erreur EN PLUS. Le tag est
    // une VARIABLE ($tag), jamais une expression entre accolades — calcul dans une dérivée. La
    // forme devient une ERREUR de build explicite, extrait = le token entier.
    const r = processGlobalMacros(`<@element {a || 'div'}>x</@element>`)
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.match(r.errors[0], /\{a \|\| 'div'\}/)
    assert.equal(r.setup, '')
    assert.doesNotMatch(r.html, /\|\|/)
    assert.doesNotMatch(r.html, /'div'/)
  })
})

describe('<@element>/<@module> — expression entre accolades interdite comme tag', () => {
  it("<@element {$x}> : 1ᵉʳ token à accolades → 1 erreur citant l'expression ENTIÈRE, rien émis, aucun résidu en HTML", () => {
    const r = processGlobalMacros('<@element {$x}>x</@element>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.match(r.errors[0], /\{\$x\}/)
    assert.match(r.errors[0], /<@element>/)
    assert.equal(r.setup, '')
    assert.doesNotMatch(r.html, /\$x/)
  })

  it('<@module {c}> : même garde côté <@module>', () => {
    const r = processGlobalMacros('<@module {c}>x</@module>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.match(r.errors[0], /\{c\}/)
    assert.match(r.errors[0], /<@module>/)
    assert.equal(r.setup, '')
    assert.doesNotMatch(r.html, /\{c\}/)
  })

  it('non-régression : <@element $tag> (variable simple) reste intact', () => {
    const r = processGlobalMacros('<@element $tag>x</@element>')
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\)\)/)
  })

  it('non-régression : <@element $tag.x> (accès de membre) reste intact', () => {
    const r = processGlobalMacros('<@element $tag.x>x</@element>')
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\.x\)\)/)
  })

  it('non-régression : <@element tag> (identifiant nu) reste intact', () => {
    const r = processGlobalMacros('<@element tag>x</@element>')
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(tag\)\)/)
  })
})

describe('<@element>/<@module> accept="…" — bout en bout (e6, transpile réel + happy-dom)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")

  it('accept="iframe" monte un <iframe> réel ; sans accept, le placeholder reste (refusé, warn)', async () => {
    const root   = mjsTmp('a3r2b-accept')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'a3r2bel.mjs'), [
      '<script lang="coffee">',
      "$tag = 'iframe'",
      '</script>',
      '<@element $tag accept="iframe">accepted</@element>',
      '<@element $tag>refused</@element>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any   = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const warnCalls: any[] = []
    window.console.warn = (...args: any[]) => { warnCalls.push(args) }

    const files    = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^a3r2bel-/.test(f))
    assert.ok(coreFile && compFile, `bundle introuvable parmi : ${files.join(', ')}`)
    window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
    document.body.innerHTML = '<mjs-a3r2bel></mjs-a3r2bel>'
    const el: any = document.body.firstElementChild
    await new Promise((r) => setTimeout(r, 80))

    const iframes = el._shadow.querySelectorAll('iframe')
    assert.equal(iframes.length, 1, 'accept="iframe" doit monter UN <iframe>')
    assert.equal(iframes[0].textContent.trim(), 'accepted')

    const placeholders = el._shadow.querySelectorAll('[mjs-el]')
    assert.equal(placeholders.length, 1, 'sans accept, le placeholder <div mjs-el> reste en place (refusé)')
    assert.equal(placeholders[0].textContent.trim(), 'refused')

    assert.ok(
      warnCalls.some(args => String(args[0]).includes('iframe') && String(args[0]).includes('accept=')),
      `attendu un warn citant iframe/accept=, reçu : ${JSON.stringify(warnCalls)}`
    )
  })

  it('accept="iframe" + $tag=\'p\' : aucun <p> créé, 1 warn « hors de la liste » (liste FERMÉE)', async () => {
    const root   = mjsTmp('a3r2d-accept-liste-fermee')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'a3r2del.mjs'), [
      '<script lang="coffee">',
      "$tag = 'p'",
      '</script>',
      '<@element $tag accept="iframe">refused</@element>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any   = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const warnCalls: any[] = []
    window.console.warn = (...args: any[]) => { warnCalls.push(args) }

    const files    = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^a3r2del-/.test(f))
    assert.ok(coreFile && compFile, `bundle introuvable parmi : ${files.join(', ')}`)
    window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
    document.body.innerHTML = '<mjs-a3r2del></mjs-a3r2del>'
    const el: any = document.body.firstElementChild
    await new Promise((r) => setTimeout(r, 80))

    const ps = el._shadow.querySelectorAll('p')
    assert.equal(ps.length, 0, 'accept="iframe" est une liste FERMÉE : \'p\' est hors liste, même hors du pool des 8')

    const placeholders = el._shadow.querySelectorAll('[mjs-el]')
    assert.equal(placeholders.length, 1, 'refusé : le placeholder <div mjs-el> reste en place')
    assert.equal(placeholders[0].textContent.trim(), 'refused')

    assert.ok(
      warnCalls.some(args => String(args[0]).includes('hors de la liste')),
      `attendu un warn « hors de la liste », reçu : ${JSON.stringify(warnCalls)}`
    )
  })
})
