// Tests des macros V1 portées : <@include partial> et <@window/document/body/head>

import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { transpile, applyMjsSugarToScript } from '../src/transpiler/index.js'
import { processGlobalMacros } from '../src/transpiler/macros.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('processGlobalMacros', () => {
  it('strip <@window @event={...}> et génère le bind/unbind', () => {
    const r = processGlobalMacros(`<@window @scroll={@onScroll} />\n<p>x</p>`)
    assert.match(r.html, /<p>x<\/p>/)
    assert.doesNotMatch(r.html, /<@window/)
    assert.match(r.setup, /window\.addEventListener\('scroll'/)
    assert.match(r.teardown, /window\.removeEventListener\('scroll'/)
    // cycle SYMÉTRIQUE — attache à chaque réveil (hook awake),
    // détache à chaque sleep (l'ancien chaînage destroy n'était JAMAIS
    // invoqué → fuite). Chaînage via l'API interne _mjs_hook.
    assert.match(r.setup, /@_mjs_hook 'awake', =>/)
    assert.match(r.teardown, /@_mjs_hook 'sleep', =>/)
  })

  // <@window>/<@document>/<@body>/<@html> SANS slash final (forme nue) :
  // openRe (`<@${macro}([^>]*)>`) ne conditionne déjà rien sur un `/` précédant
  // le `>` — vérifié : sortie STRICTEMENT identique à la forme autofermante,
  // aucune regex à assouplir ici (contrairement à <@include>/<@element>/
  // <@module>/<@failed>, qui EUX rejettent l'auto-fermeture).
  it('forme NUE <@window @scroll={...}> (sans /) : sortie IDENTIQUE à la forme autofermante', () => {
    const selfClosed = processGlobalMacros(`<@window @scroll={@onScroll} />\n<p>x</p>`)
    const nue = processGlobalMacros(`<@window @scroll={@onScroll}>\n<p>x</p>`)
    assert.deepEqual(nue, selfClosed)
  })

  it('forme NUE <@document>/<@body>/<@html> (sans /) : sortie IDENTIQUE à la forme autofermante', () => {
    const cases: Array<[string, string]> = [
      [`<@document @visibilitychange={@onVis} />`, `<@document @visibilitychange={@onVis}>`],
      [`<@body class="a b" />`, `<@body class="a b">`],
      [`<@html @style.overflow={$open ? 'hidden' : ''} />`, `<@html @style.overflow={$open ? 'hidden' : ''}>`],
    ]
    for (const [selfClose, nue] of cases) {
      assert.deepEqual(processGlobalMacros(nue), processGlobalMacros(selfClose), `divergence pour ${nue}`)
    }
  })

  // RÉGRESSION : le wrapper awake/sleep DOIT être un IIFE
  // INVOQUÉ — `((p = …) => …)()` — et SURTOUT PAS `do (p = …) =>`,
  // que Civet compile en do-block `{ (p) => {…} }` (flèche JAMAIS appelée) →
  // le hook n'était jamais réassigné → AUCUN listener <@window>/<@document>/
  // <@body> ne s'attachait (bug introduit par 816d64f, tuto 16-1 muet au clavier).
  it('le wrapper awake/sleep est un IIFE INVOQUÉ (pas un do-block mort)', () => {
    const r = processGlobalMacros(`<@window @keydown={@onKey} />`)
    // forme IIFE-paren, jamais la forme `do (`
    assert.match(r.setup, /\(\(_mjs_prevAwake = @_mjs_hooks\?\.awake\) =>/)
    assert.match(r.setup, /\)\(\)\s*$/)              // ← invoqué
    assert.doesNotMatch(r.setup, /\bdo \(_mjs_prevAwake/)
    assert.match(r.teardown, /\(\(_mjs_prevSleep = @_mjs_hooks\?\.sleep\) =>/)
    assert.match(r.teardown, /\)\(\)\s*$/)
    assert.doesNotMatch(r.teardown, /\bdo \(_mjs_prevSleep/)
  })

  it('<@document @visibilitychange={...}> cible document', () => {
    const r = processGlobalMacros(`<@document @visibilitychange={@onVis} />`)
    assert.match(r.setup, /document\.addEventListener\('visibilitychange'/)
  })

  it('<@body> cible document.body', () => {
    const r = processGlobalMacros(`<@body @click={@onClick} />`)
    assert.match(r.setup, /document\.body\.addEventListener\('click'/)
  })

  it('<@head> cible document.head', () => {
    const r = processGlobalMacros(`<@head @scroll={@onScroll} />`)
    assert.match(r.setup, /document\.head\.addEventListener\('scroll'/)
  })

  it('<@head> avec contenu → injection réactive (µ._setHead) dans le head', () => {
    const r = processGlobalMacros(`<@head>\n  <link rel="stylesheet" href={themeCss[$selected]}>\n</@head>`)
    // µeffect qui appelle µ._setHead avec la chaîne HTML reconstruite
    assert.match(r.setup, /µeffect =>/)
    assert.match(r.setup, /µ\._setHead\(@,/)
    // l'expression de binding `href={…}` devient une valeur quotée concaténée
    assert.match(r.setup, /<link rel="stylesheet" href="/)
    assert.match(r.setup, /\(themeCss\[\$selected\]\)/)
    // teardown : nettoyage des nœuds injectés
    assert.match(r.teardown, /µ\._clearHead\(@\)/)
    // le contenu est retiré du HTML (pas rendu inline dans le shadow)
    assert.doesNotMatch(r.html, /<link/)
    assert.doesNotMatch(r.html, /<@head/)
  })

  it('<@head> avec <title> texte interpolé → concaténation ÉCHAPPÉE (µ._esc, anti-XSS)', () => {
    const r = processGlobalMacros(`<@head><title>{$selected} — Site</title></@head>`)
    assert.match(r.setup, /'<title>' \+ µ\._esc\(\$selected\) \+ ' — Site<\/title>'/)
  })

  it('<@element $var> (tag bare variable) → placeholder + µeffect _updDynEl', () => {
    const r = processGlobalMacros(`<@element $tag>\n  I'm a <code>&lt;{$tag}&gt;</code> element\n</@element>`)
    // placeholder qui garde les enfants (rendus normalement)
    assert.match(r.html, /<div mjs-el="0">/)
    assert.match(r.html, /<code>&lt;\{\$tag\}&gt;<\/code>/)  // enfants intacts
    assert.doesNotMatch(r.html, /<@element/)
    assert.doesNotMatch(r.html, /<\/@element>/)
    // µeffect (fat arrow pour capter le composant) → µ._updDynEl(@, 'N', (tag))
    assert.match(r.setup, /µeffect =>/)
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\)\)/)
  })

  it('<@element $tag class="x"> → attrs statiques reportés sur le placeholder', () => {
    const r = processGlobalMacros(`<@element $tag class="x">hi</@element>`)
    assert.match(r.html, /<div mjs-el="0" class="x">/)
    assert.match(r.setup, /µ\._updDynEl\(@, '0', \(\$tag\)\)/)
  })

  it('<@module $comp> (composant dynamique) → placeholder mjs-mod + µeffect _updModule', () => {
    const r = processGlobalMacros(`<@module $comp>\n  <p>fallback</p>\n</@module>`)
    assert.match(r.html, /<div mjs-mod="0">/)
    assert.match(r.html, /<p>fallback<\/p>/)        // enfants (slots) intacts
    assert.doesNotMatch(r.html, /<@module/)
    assert.doesNotMatch(r.html, /<\/@module>/)
    assert.match(r.setup, /µeffect =>/)
    assert.match(r.setup, /µ\._updModule\(@, '0', \(\$comp\)\)/)
  })

  it('<@module $comp class="x"> → attrs statiques reportés sur le placeholder', () => {
    const r = processGlobalMacros(`<@module $comp class="x">hi</@module>`)
    assert.match(r.html, /<div mjs-mod="0" class="x">/)
    assert.match(r.setup, /µ\._updModule\(@, '0', \(\$comp\)\)/)
  })

  it('µdebug $x → se réécrit en effet réactif (log + debugger)', () => {
    const out = applyMjsSugarToScript('µdebug $count', 'coffee')
    assert.match(out, /µ\.effect =>/)
    assert.match(out, /µ\.log\('\[µdebug\] count =', \$count\)/)
    assert.match(out, /debugger/)
  })

  it('<@failed err reset> → builder _mjs_fallback, @click=reset = listener direct', () => {
    const r = processGlobalMacros(`<@failed err reset>\n  <p>💥 {err.message}</p>\n  <button @click=reset>Reset</button>\n</@failed>`)
    assert.doesNotMatch(r.html, /<@failed/)                       // bloc retiré
    assert.match(r.setup, /@_mjs_fallback = \(err, reset\) =>/)   // builder
    assert.match(r.setup, /createElement\('div'\)/)
    assert.match(r.setup, /\(err\.message\)/)                     // interpolation évaluée
    assert.match(r.setup, /addEventListener\('click', reset\)/)   // @click=reset natif
    assert.doesNotMatch(r.setup, /mjs-reset/)                     // plus de marqueur
  })

  it('garde : un <@…> dans un commentaire HTML est neutralisé', () => {
    const r = processGlobalMacros(`<!-- ex : <@failed> ... -->\n<p>ok</p>`)
    assert.doesNotMatch(r.setup, /_mjs_fallback/)
    assert.match(r.html, /<p>ok<\/p>/)
  })

  it('handler nu @method auto-ajoute (e)', () => {
    const r = processGlobalMacros(`<@window @keydown={@onKey} />`)
    assert.match(r.setup, /@onKey\(e\)/)
  })

  it('multiples @event= sur la même balise', () => {
    const r = processGlobalMacros(`<@window @scroll={@onScroll} @resize={@onResize} />`)
    assert.match(r.setup, /addEventListener\('scroll'/)
    assert.match(r.setup, /addEventListener\('resize'/)
  })

  it('aucune macro → setup et teardown vides', () => {
    const r = processGlobalMacros(`<p>hello</p>`)
    assert.equal(r.setup, '')
    assert.equal(r.teardown, '')
    assert.equal(r.html, '<p>hello</p>')
  })

  // Les modificateurs
  // (`.passive`, etc.) ne sont PAS supportés sur les macros globales
  // (<@window>/<@document>/<@body>/<@head>) : `@scroll.passive={...}` doit
  // être ignoré (aucun addEventListener émis), PAS interprété comme une
  // forme tronquée. Un 1er correctif basé sur un lookahead négatif après un
  // quantifieur glouton (`/@([\w-]+)(?!\.)/`) semblait correct mais le moteur
  // regex BACKTRACK sur un échec : `scroll` (7 lettres) échoue `(?!\.)`
  // (suivi d'un point) → repli sur `scrol` (6 lettres, suivi de `l` — PAS un
  // point) → `(?!\.)` réussit sur ce préfixe TRONQUÉ → un handler fantôme
  // `addEventListener('scrol', …)` était posé (event inexistant, silencieux),
  // ET la vraie forme `.passive` restait de toute façon ignorée.
  it("@scroll.passive={...} (modificateur non supporté) : ignoré ENTIÈREMENT, aucun handler fantôme tronqué", () => {
    const r = processGlobalMacros(`<@window @scroll.passive={@onScroll} />`)
    assert.doesNotMatch(r.setup, /addEventListener\('scrol'/,
      "AVANT le fix : addEventListener('scrol', ...) — un event TRONQUÉ (backtracking regex), silencieusement inerte")
    assert.doesNotMatch(r.setup, /addEventListener\('scroll'/,
      "les modificateurs ne sont pas supportés : la forme complète NE DOIT PAS non plus s'attacher (pas de faux espoir d'un .passive honoré)")
  })

  it('@scroll={...} SANS modificateur continue de fonctionner normalement (pas de régression du fix précédent)', () => {
    const r = processGlobalMacros(`<@window @scroll={@onScroll} />`)
    assert.match(r.setup, /addEventListener\('scroll'/)
  })

  // LIAISONS <@window prop=!{$var}> (équivalent bind:scrollY/innerWidth de
  // <svelte:window>).
  describe('liaisons de propriétés window (=!{…})', () => {
    it('scrollY=!{$y} : init + écouteur scroll + écriture two-way', () => {
      const r = processGlobalMacros(`<@window scrollY=!{$y} />`)
      assert.match(r.setup, /\$y = window\.scrollY/)                 // valeur initiale
      assert.match(r.setup, /addEventListener\('scroll'/)           // écouteur (attaché à @awake)
      assert.match(r.teardown, /removeEventListener\('scroll'/)     // détaché à @sleep
      // two-way : un µeffect pousse $y vers window quand il change
      assert.match(r.setup, /µeffect =>/)
      assert.match(r.setup, /window\.scrollTo\(window\.scrollX, \$y\)/)
      assert.equal(r.html.trim(), '')                               // la balise ne produit aucun DOM
    })

    it('innerWidth=!{$w} : init + écouteur resize, PAS de two-way (lecture seule)', () => {
      const r = processGlobalMacros(`<@window innerWidth=!{$w} />`)
      assert.match(r.setup, /\$w = window\.innerWidth/)
      assert.match(r.setup, /addEventListener\('resize'/)
      assert.match(r.teardown, /removeEventListener\('resize'/)
      assert.doesNotMatch(r.setup, /scrollTo/)                      // innerWidth = lecture seule
    })

    it('online=!{$on} : écoute online ET offline, lit navigator.onLine', () => {
      const r = processGlobalMacros(`<@window online=!{$on} />`)
      assert.match(r.setup, /\$on = navigator\.onLine/)
      assert.match(r.setup, /addEventListener\('online'/)
      assert.match(r.setup, /addEventListener\('offline'/)
    })

    it('liaisons multiples + écouteur @event cohabitent sur la même balise', () => {
      const r = processGlobalMacros(`<@window scrollY=!{$y} innerWidth=!{$w} @keydown={onKey} />`)
      assert.match(r.setup, /\$y = window\.scrollY/)
      assert.match(r.setup, /\$w = window\.innerWidth/)
      assert.match(r.setup, /addEventListener\('keydown'/)
    })

    it('propriété inconnue → ignorée + erreur explicite (pas de codegen)', () => {
      const orig = console.error
      let msg = ''
      console.error = (m: string) => { msg = m }
      try {
        const r = processGlobalMacros(`<@window fooBar=!{$x} />`)
        assert.doesNotMatch(r.setup, /\$x =/)
      } finally {
        console.error = orig
      }
      assert.match(msg, /non liable/)
    })

    it('les liaisons sont RÉSERVÉES à <@window> (pas <@document>/<@body>)', () => {
      const r = processGlobalMacros(`<@body scrollY=!{$y} />`)
      assert.doesNotMatch(r.setup, /\$y = window\.scrollY/)
    })
  })

  // Liaisons class/style sur <@body>/<@html>. Réservées à ces
  // deux cibles ; sur les autres (<@window>/<@document>/<@head>), toute forme
  // détectée devient une ERREUR de compile (jamais un écouteur fantôme).
  describe('liaisons class/style <@body>/<@html>', () => {
    it('<@body class="a b" /> : classes statiques ajoutées au réveil, retirées au sommeil', () => {
      const r = processGlobalMacros(`<@body class="a b" />`)
      assert.match(r.setup, /µ\._glCl\(@, document\.body, 'a', true\)/)
      assert.match(r.setup, /µ\._glCl\(@, document\.body, 'b', true\)/)
      assert.match(r.teardown, /µ\._glCl\(@, document\.body, 'a', false\)/)
      assert.match(r.teardown, /µ\._glCl\(@, document\.body, 'b', false\)/)
      assert.doesNotMatch(r.html, /<@body/)
      assert.equal(r.errors.length, 0)
    })

    it('<@body @class{$open}="no-scroll" /> : classe conditionnelle réactive (µeffect)', () => {
      const r = processGlobalMacros(`<@body @class{$open}="no-scroll" />`)
      assert.match(r.setup, /µeffect =>/)
      assert.match(r.setup, /µ\._glCl\(@, document\.body, 'no-scroll', !!\(\$open\)\)/)
      assert.match(r.teardown, /µ\._glCl\(@, document\.body, 'no-scroll', false\)/)
      // RÉGRESSION : @class{…} ne doit plus jamais être pris pour un écouteur
      // fantôme de l'événement « class » par parseListeners.
      assert.doesNotMatch(r.setup, /addEventListener\('class'/)
    })

    it('<@body @class{fn({a: 1})}="x" /> : accolades imbriquées dans la condition correctement capturées', () => {
      const r = processGlobalMacros(`<@body @class{fn({a: 1})}="x" />`)
      assert.match(r.setup, /µ\._glCl\(@, document\.body, 'x', !!\(fn\(\{a: 1\}\)\)\)/)
    })

    it("<@body @style.overflow={…} /> : style réactif (µeffect)", () => {
      const r = processGlobalMacros(`<@body @style.overflow={$open ? 'hidden' : ''} />`)
      assert.match(r.setup, /µ\._glSt\(@, document\.body, 'overflow', \(\$open \? 'hidden' : ''\)\)/)
      assert.match(r.teardown, /µ\._glSt\(@, document\.body, 'overflow', null\)/)
    })

    it('<@body --accent={$c} /> : custom property réactive', () => {
      const r = processGlobalMacros(`<@body --accent={$c} />`)
      assert.match(r.setup, /µ\._glSt\(@, document\.body, '--accent', \(\$c\)\)/)
    })

    it('<@html @class{$dark}="dark" /> : cible document.documentElement', () => {
      const r = processGlobalMacros(`<@html @class{$dark}="dark" />`)
      assert.match(r.setup, /µ\._glCl\(@, document\.documentElement, 'dark', !!\(\$dark\)\)/)
    })

    it('<@html @click={@go} /> : les événements ciblent aussi document.documentElement (nouvelle cible)', () => {
      const r = processGlobalMacros(`<@html @click={@go} />`)
      assert.match(r.setup, /document\.documentElement\.addEventListener\('click'/)
    })

    it('<@body style="overflow:hidden" /> : erreur (règle zéro-CSS-inline)', () => {
      const r = processGlobalMacros(`<@body style="overflow:hidden" />`)
      assert.ok(r.errors.length > 0, 'errors ne doit pas être vide')
      assert.match(r.errors.join(' | '), /style inline/)
    })

    it('<@body class="badge {$tone}" /> : erreur interpolation non supportée', () => {
      const r = processGlobalMacros(`<@body class="badge {$tone}" />`)
      assert.ok(r.errors.length > 0, 'errors ne doit pas être vide')
      assert.match(r.errors.join(' | '), /interpolation non supportée/)
    })

    it('<@window class="x" /> : erreur, liaisons réservées à <@body>/<@html>', () => {
      const r = processGlobalMacros(`<@window class="x" />`)
      assert.ok(r.errors.length > 0, 'errors ne doit pas être vide')
      assert.match(r.errors.join(' | '), /non supportées sur cette cible/)
    })

    it('<@body class="k" @click={@go} /> : classe statique ET écouteur cohabitent', () => {
      const r = processGlobalMacros(`<@body class="k" @click={@go} />`)
      assert.match(r.setup, /µ\._glCl\(@, document\.body, 'k', true\)/)
      assert.match(r.setup, /document\.body\.addEventListener\('click'/)
    })
  })
})

// Généralisation de <@include nom/> (slash final
// interdit) à <@element>/<@module>/<@failed> : ces 3 macros À
// CONTENU n'ont jamais eu de forme auto-fermée valide. <@head> délibérément
// ÉCARTÉ (découvert en écrivant CES tests, cf. describe suivant) —
// voir le commentaire dédié dans macros.ts § 1.
describe('auto-fermeture interdite — <@element>/<@module>/<@failed>', () => {
  it('<@element $tag/> → erreur accumulée (errors), tag retiré du html', () => {
    const r = processGlobalMacros(`<@element $tag/>`)
    assert.ok(r.errors.some(e => /<@element\/>/.test(e)), r.errors.join(' | '))
    assert.match(r.errors.join(' | '), /auto-fermeture interdite/)
    assert.doesNotMatch(r.html, /<@element/)
  })

  it('<@element $tag class="x"/> (avec attrs) → erreur accumulée aussi', () => {
    const r = processGlobalMacros(`<@element $tag class="x"/>`)
    assert.ok(r.errors.some(e => /<@element\/>/.test(e)), r.errors.join(' | '))
  })

  it('<@module $comp/> → erreur accumulée', () => {
    const r = processGlobalMacros(`<@module $comp/>`)
    assert.ok(r.errors.some(e => /<@module\/>/.test(e)), r.errors.join(' | '))
    assert.doesNotMatch(r.html, /<@module/)
  })

  it('<@failed err reset/> → erreur accumulée, ne retombe PAS non traité sur le parser générique', () => {
    const r = processGlobalMacros(`<@failed err reset/>`)
    assert.ok(r.errors.some(e => /<@failed\/>/.test(e)), r.errors.join(' | '))
    assert.doesNotMatch(r.html, /<@failed/)
  })

  it('<@failed/> (bare, sans args) → erreur accumulée', () => {
    const r = processGlobalMacros(`<@failed/>`)
    assert.ok(r.errors.some(e => /<@failed\/>/.test(e)), r.errors.join(' | '))
  })

  it('non-régression — les 3 formes FERMÉES EXPLICITEMENT restent 100% valides (zéro erreur)', () => {
    const r = processGlobalMacros([
      '<@element $tag>hi</@element>',
      '<@module $comp>hi</@module>',
      '<@failed err reset><p>{err.message}</p></@failed>',
    ].join('\n'))
    assert.equal(r.errors.length, 0, r.errors.join(' | '))
  })

  // SANS espace avant le `/` (`<@element/>`, `<@module/>`),
  // boundaryOk rejetait la frontière `/` (seule celle espacée, `<@element $tag/>` ci-dessus, passait
  // par le callback) : la balise entière traversait en silence, jamais vue par la garde auto-
  // fermeture-interdite. `/` collé rejoint désormais les frontières valides, au même titre que `>`
  // collé.
  it('<@element/> (collé, zéro espace avant le /) → même erreur auto-fermeture-interdite que la forme espacée', () => {
    const r = processGlobalMacros(`<@element/>x`)
    assert.ok(r.errors.some(e => /<@element\/>/.test(e)), r.errors.join(' | '))
    assert.match(r.errors.join(' | '), /auto-fermeture interdite/)
    assert.doesNotMatch(r.html, /<@element/)
  })

  it('<@module/> (collé) → même garde côté <@module>', () => {
    const r = processGlobalMacros(`<@module/>x`)
    assert.ok(r.errors.some(e => /<@module\/>/.test(e)), r.errors.join(' | '))
    assert.match(r.errors.join(' | '), /auto-fermeture interdite/)
    assert.doesNotMatch(r.html, /<@module/)
  })

  it('non-régression : <@element $tag/> (espacé, déjà couvert ci-dessus) reste inchangé', () => {
    const r = processGlobalMacros(`<@element $tag/>`)
    assert.ok(r.errors.some(e => /<@element\/>/.test(e)), r.errors.join(' | '))
  })

  it("non-régression : <@element> nu (frontière '>' collée) reste 1 erreur, ouvrante disparue", () => {
    const r = processGlobalMacros('<@element>x</@element>')
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors))
    assert.doesNotMatch(r.html, /<@element>/)
  })

  it("non-régression : <@elementx> (nom plus long, PAS la macro <@element>) traverse intact, zéro erreur", () => {
    const r = processGlobalMacros('<@elementx>x</@elementx>')
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
    assert.equal(r.html, '<@elementx>x</@elementx>')
  })
})

// Non-régression EXPLICITE — <@window>/<@document>/<@body>/<@html>
// sont VOLONTAIREMENT hors du périmètre ci-dessus : 100% de leur usage réel/
// documenté est auto-fermé, en faire une erreur casserait du code qui marche.
// <@head> REJOINT ce groupe (pas celui du describe précédent) : DÉCOUVERT en
// écrivant ces tests — `head` est AUSSI une clé de TARGETS (boucle "2. Macros
// « écouteurs »" plus bas dans macros.ts), donc <@head @event={...} /> est un
// DEUXIÈME usage 100% légitime et DÉJÀ testé plus haut (describe
// 'processGlobalMacros', « <@head> cible document.head ») — le rejeter aurait
// cassé ce mécanisme qui marche. Seule sa forme À CONTENU (<@head>…</@head>,
// fermeture explicite) reste concernée par la règle « injection », mais rien
// ne distingue syntaxiquement un <@head/> bare d'un « listener vide » — voir
// le commentaire détaillé dans macros.ts § 1.
describe('auto-fermeture — non-régression EXPLICITE <@window>/<@document>/<@body>/<@html>/<@head> (jamais concernées)', () => {
  it('<@window .../> auto-fermé : zéro erreur (comportement inchangé)', () => {
    const r = processGlobalMacros(`<@window @scroll={@onScroll} />`)
    assert.equal(r.errors.length, 0, r.errors.join(' | '))
  })

  it('<@document .../> auto-fermé : zéro erreur', () => {
    const r = processGlobalMacros(`<@document @visibilitychange={@onVis} />`)
    assert.equal(r.errors.length, 0, r.errors.join(' | '))
  })

  it('<@body .../> auto-fermé : zéro erreur', () => {
    const r = processGlobalMacros(`<@body @click={@onClick} />`)
    assert.equal(r.errors.length, 0, r.errors.join(' | '))
  })

  it('<@html .../> auto-fermé : zéro erreur', () => {
    const r = processGlobalMacros(`<@html @click={@go} />`)
    assert.equal(r.errors.length, 0, r.errors.join(' | '))
  })

  it('<@head @scroll={...} /> auto-fermé (forme écouteur, cible TARGETS) : zéro erreur — NE PAS confondre avec la forme à contenu', () => {
    const r = processGlobalMacros(`<@head @scroll={@onScroll} />`)
    assert.equal(r.errors.length, 0, r.errors.join(' | '))
    assert.match(r.setup, /document\.head\.addEventListener\('scroll'/)
  })

  it('<@head/> bare (sans attrs) auto-fermé : zéro erreur, no-op silencieux (même famille que <@window/> bare)', () => {
    const r = processGlobalMacros(`<@head/>`)
    assert.equal(r.errors.length, 0, r.errors.join(' | '))
  })
})

// RÉGRESSION — preuve au niveau du JS FINAL (après Civet) que le
// listener <@window> s'attache vraiment. C'est le test qui aurait attrapé le bug :
// la source contenait bien `@onAwake = =>`, mais `do (p) =>` compilait en un
// do-block dont la flèche n'était JAMAIS appelée → @onAwake jamais réassigné.
describe('<@window> — le listener s\'attache vraiment (IIFE invoqué dans le JS final)', () => {
  it('le JS compilé invoque le wrapper onAwake et appelle addEventListener', async function () {
    this.timeout(15000)   // transpile() lance Civet (compile à froid lente)
    const src = `<script>\n  onKey = (e) ->\n    $last = e.key\n</script>\n<@window @keydown={onKey} />\n<p>{$last}</p>`
    const { output } = await transpile(src, { moduleName: 'win-regress' })
    // l'écouteur est bien posé…
    assert.match(output, /addEventListener\(['"]keydown['"]/)
    // …dans un IIFE réellement INVOQUÉ : `((_mjs_prevAwake = this._mjs_hooks?.awake) => {…})()`
    assert.match(output, /\(\(_mjs_prevAwake = this\._mjs_hooks\?\.awake\) =>/)
    assert.match(output, /\}\s*\)\s*\(\)/)   // fermeture + invocation )()
    // …et JAMAIS la forme do-block morte `{ (_mjs_prevAwake = …) => … }`
    assert.doesNotMatch(output, /\{\s*\(_mjs_prevAwake = this\._mjs_hooks\?\.awake\) =>/)
    // symétrie : le teardown du hook sleep aussi
    assert.match(output, /\(\(_mjs_prevSleep = this\._mjs_hooks\?\.sleep\) =>/)
    assert.match(output, /removeEventListener\(['"]keydown['"]/)
  })
})

describe('<@include partial>', () => {
  it('inline le template du partial', async () => {
    const root = mjsTmp('incl')
    writeFileSync(join(root, '_bar.mjs'),
      `<script lang="coffee">$x = 0</script>\n<span>BAR</span>`)
    const src = `<script lang="coffee">$y = 0</script>\n<div><@include bar></div>`
    const { data } = await transpile(src, { moduleName: 'foo', baseDir: root })
    assert.match(data.surgicalHtml, /<span>BAR<\/span>/)
  })

  it('concatène les scripts et styles des partials au parent', async () => {
    const root = mjsTmp('incl')
    writeFileSync(join(root, '_helper.mjs'), `
<script lang="coffee">
$z = 99
</script>
<style lang="css">
.helper { color: blue; }
</style>
<span>HELPER</span>
`)
    const src = `<script lang="coffee">$y = 0</script>
<style lang="css">.parent { color: red; }</style>
<div><@include helper></div>`
    const { data } = await transpile(src, { moduleName: 'foo', baseDir: root })
    assert.match(data.surgicalHtml, /HELPER/)
    // CSS du partial doit apparaître dans baseCss (avec compaction)
    assert.match(data.baseCss, /\.helper/)
    assert.match(data.baseCss, /\.parent/)
    // Le state var $z du partial doit être détecté par l'analyzer
    assert.match(data.varBitsStr, /"z":/)
  })

  it('strip silencieusement si baseDir manquant', async () => {
    const src = `<script lang="coffee">$y = 0</script>
<div><@include unknown></div>`
    const { data } = await transpile(src, { moduleName: 'foo' })
    assert.doesNotMatch(data.surgicalHtml, /<@include/)
  })

  it('console.error si partial introuvable', async () => {
    const root = mjsTmp('incl')
    let errored = false
    const orig = console.error
    console.error = () => { errored = true }
    try {
      const src = `<script lang="coffee">$y = 0</script>\n<div><@include missing></div>`
      await transpile(src, { moduleName: 'foo', baseDir: root })
    } finally {
      console.error = orig
    }
    assert.equal(errored, true)
  })

  it('partials récursifs (un partial qui include un autre)', async () => {
    const root = mjsTmp('incl')
    writeFileSync(join(root, '_inner.mjs'), `<span>INNER</span>`)
    writeFileSync(join(root, '_outer.mjs'), `<div><@include inner></div>`)
    const src = `<script lang="coffee">$x = 0</script>\n<@include outer>`
    const { data } = await transpile(src, { moduleName: 'foo', baseDir: root })
    assert.match(data.surgicalHtml, /<span>INNER<\/span>/)
    assert.match(data.surgicalHtml, /<div>/)
  })

  // RÉGRESSION — ordre des passes 4-bis/4-ter/4a (alias sigil + µasset) vs 4b
  // (<@include>) dans transpiler/index.ts : quand elles tournaient AVANT
  // l'inlining du partial, son contenu n'existait pas encore dans `html`/
  // `script.raw` → tout `µasset(...)` DANS un partial (ex. le logo de
  // tuto/_header.mjs ou doc/_header.mjs) restait littéral, figé en `&#39;`
  // après passage dans le générateur HTML → 404 sur l'asset. Fix : µasset/
  // alias tournent désormais APRÈS `<@include>`.
  it("µasset() résolu DANS un partial inclus, template ET script (régression : logo <@include> restait littéral → 404)", async () => {
    const root = mjsTmp('incl')
    writeFileSync(join(root, '_header.mjs'), `
<script lang="coffee">
  $logoSrc = µasset('img/y.webp')
</script>
<img src="µasset('img/x.webp')">
`)
    const src = `<script lang="coffee">$y = 0</script>\n<div><@include header></div>`
    const resolved: string[] = []
    const resolveAsset = async (p: string) => {
      resolved.push(p)
      return `/assets/${p.replace(/[^a-zA-Z0-9]+/g, '-')}-HASH.webp`
    }
    const { output } = await transpile(src, { moduleName: 'incl-asset', baseDir: root, resolveAsset })
    assert.ok(resolved.includes('img/x.webp'), `resolveAsset doit être appelé pour img/x.webp du template (appelés: ${JSON.stringify(resolved)})`)
    assert.ok(resolved.includes('img/y.webp'), `resolveAsset doit être appelé pour img/y.webp du script (appelés: ${JSON.stringify(resolved)})`)
    assert.match(output, /\/assets\/img-x-webp-HASH\.webp/, "le chemin résolu de l'image du partial doit apparaître dans l'output")
    assert.match(output, /\/assets\/img-y-webp-HASH\.webp/, "le chemin résolu de la référence script du partial doit apparaître dans l'output")
    assert.doesNotMatch(output, /µasset/, "AVANT le fix : µasset() d'un partial <@include> restait littéral (résolu APRÈS l'inlining, ordre 4a/4b) — 404")
  })
})

describe('<@include> — slash final interdit', () => {
  it('forme collée <@include bar/> → erreur slash final, partial pas inliné', async () => {
    const root = mjsTmp('incl-slash')
    writeFileSync(join(root, '_bar.mjs'), `<span>BAR</span>`)
    let msg = ''
    const orig = console.error
    console.error = (m: string) => { msg = m }
    let data: any = null
    try {
      const src = `<script lang="coffee">$y = 0</script>\n<div><@include bar/></div>`
      data = (await transpile(src, { moduleName: 'foo', baseDir: root })).data
    } finally {
      console.error = orig
    }
    assert.match(msg, /slash final interdit/)
    assert.doesNotMatch(data.surgicalHtml, /BAR/)
    assert.doesNotMatch(data.surgicalHtml, /<@include/)
  })

  it('forme espacée <@include bar /> → erreur slash final, partial pas inliné', async () => {
    const root = mjsTmp('incl-slash')
    writeFileSync(join(root, '_bar.mjs'), `<span>BAR</span>`)
    let msg = ''
    const orig = console.error
    console.error = (m: string) => { msg = m }
    let data: any = null
    try {
      const src = `<script lang="coffee">$y = 0</script>\n<div><@include bar /></div>`
      data = (await transpile(src, { moduleName: 'foo', baseDir: root })).data
    } finally {
      console.error = orig
    }
    assert.match(msg, /slash final interdit/)
    assert.doesNotMatch(data.surgicalHtml, /BAR/)
    assert.doesNotMatch(data.surgicalHtml, /<@include/)
  })

  it('double slash <@include bar//> → erreur slash final, partial pas inliné', async () => {
    const root = mjsTmp('incl-slash')
    writeFileSync(join(root, '_bar.mjs'), `<span>BAR</span>`)
    let msg = ''
    const orig = console.error
    console.error = (m: string) => { msg = m }
    let data: any = null
    try {
      const src = `<script lang="coffee">$y = 0</script>\n<div><@include bar//></div>`
      data = (await transpile(src, { moduleName: 'foo', baseDir: root })).data
    } finally {
      console.error = orig
    }
    assert.match(msg, /slash final interdit/)
    assert.doesNotMatch(data.surgicalHtml, /BAR/)
    assert.doesNotMatch(data.surgicalHtml, /<@include/)
  })

  it('contrôle <@include bar> sans slash → inliné, zéro erreur', async () => {
    const root = mjsTmp('incl-slash')
    writeFileSync(join(root, '_bar.mjs'), `<span>BAR</span>`)
    let msg = ''
    const orig = console.error
    console.error = (m: string) => { msg = m }
    let data: any = null
    try {
      const src = `<script lang="coffee">$y = 0</script>\n<div><@include bar></div>`
      data = (await transpile(src, { moduleName: 'foo', baseDir: root })).data
    } finally {
      console.error = orig
    }
    assert.equal(msg, '')
    assert.match(data.surgicalHtml, /<span>BAR<\/span>/)
  })

  it('chemin <@include sub/inner> → slash interne conservé (feature), résolu, zéro erreur', async () => {
    const root = mjsTmp('incl-slash')
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'sub', '_inner.mjs'), `<span>INNER</span>`)
    let msg = ''
    const orig = console.error
    console.error = (m: string) => { msg = m }
    let data: any = null
    try {
      const src = `<script lang="coffee">$y = 0</script>\n<div><@include sub/inner></div>`
      data = (await transpile(src, { moduleName: 'foo', baseDir: root })).data
    } finally {
      console.error = orig
    }
    assert.equal(msg, '')
    assert.match(data.surgicalHtml, /<span>INNER<\/span>/)
  })
})

// RÉGRESSION — le test ci-dessus (transpile() appelé DIRECT, resolveAsset à
// accès disque immédiat) valide le fix d'ordre des passes du TRANSPILER, mais
// PAS le pipeline réel de `mjs build` : celui-ci passe par le Bundler complet
// (worker_threads, cf. bundler/worker.ts), où `resolveAsset` n'est qu'un
// lookup dans un dict PRÉ-rempli côté master par `preResolveAssets` — lequel
// ne scannait QUE le contenu du fichier top-level, jamais celui des partials
// <@include>. Un µasset() qui ne vit QUE dans un partial (cas réel : le logo
// de tuto/_header.mjs) retombait donc encore sur `/MISSING_MJS_ASSET:X`, que
// `resolveMagicAssets` (post-compile) détecte désormais comme une ERREUR DE
// BUILD (`mjs build` sortait en erreur, `bundle_modular.js` perdait l'entrée
// manifest du composant en échec). Fix : `preResolveAssets` descend
// maintenant récursivement dans les <@include> (bundler/index.ts).
describe('Bundler.compile() — µasset() DANS un partial, pipeline réel (worker pool)', function () {
  this.timeout(30000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("le composant qui <@include> un partial référençant µasset() compile SANS erreur et référence l'asset hashé", async () => {
    const root = mjsTmp('partial-asset-worker')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    writeFileSync(join(srcDir, 'logo.webp'), Buffer.from([1, 2, 3, 4]))
    writeFileSync(join(srcDir, '_header.mjs'), [
      '<img src="µasset(\'logo.webp\')" alt="Logo">',
    ].join('\n'))
    writeFileSync(join(srcDir, 'shell.mjs'), [
      '<@include header>',
      '<p>corps</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0,
      `AVANT le fix : « Asset introuvable » — preResolveAssets ne voyait pas le µasset() du partial. Erreurs : ${stats.errors.map(e => e.message).join(' ; ')}`)

    const logoFile = readFileSync(
      join(outDir, readdirSync(outDir).find((f: string) => /^shell-/.test(f))!),
      'utf8',
    )
    assert.doesNotMatch(logoFile, /MISSING_MJS_ASSET/, 'le composant compilé ne doit plus contenir de placeholder non résolu')
    assert.doesNotMatch(logoFile, /µasset/, 'le composant compilé ne doit plus contenir de µasset() littéral')
    const logoHashed = readdirSync(outDir).find((f: string) => /^logo-/.test(f))
    assert.ok(logoHashed, `l'asset logo.webp doit avoir été copié/hashé dans outDir (contenu: ${readdirSync(outDir).join(', ')})`)
    assert.match(logoFile, new RegExp(logoHashed!.replace(/\.webp$/, '')), 'le composant compilé doit référencer le chemin hashé du logo')

    await bundler.close()
  })
})
