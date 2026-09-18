// littéraux regex `/…/` dans les runes µimport/µtoggle — le scanner manuel
// PARTAGÉ rewriteMuImport/rewriteMuToggle/skipInertFrom (sigils.ts) ignorait le regex comme zone
// inerte, contrairement au lexer (scanInertAt) et au générateur (mapCodeSegments), déjà corrigés.
// Conséquences AVANT ce correctif :
//   · un `#` non-alpha DANS le regex (`/#-/`) était pris pour un commentaire Coffee — tout le
//     reste de la LIGNE (donc la rune qui suit) était sauté ;
//   · un `'` DANS le regex (`/'/`) ouvrait une fausse chaîne qui courait jusqu'au PROCHAIN `'` du
//     source — souvent le guillemet d'un argument légitime plus loin, tout le scan désynchronisé ;
//   · un backtick DANS le regex (`` /`/ ``) ouvrait une fausse chaîne à backticks — sortie
//     corrompue (backtick fantôme ajouté) ;
//   · un `//` interne au regex (slashes échappés, `/\/\//`) était pris pour un commentaire de
//     ligne — tout le reste sauté.
// Résultat : rune non consommée (ReferenceError au navigateur, build resté vert) ou sortie
// corrompue — panne MUETTE. Effet de bord corrigé en prime : une regex qui MENTIONNE la rune
// (`re = /µtoggle/`) reste muette, elle ne lève plus `rune-toggle-appel`.

import assert from 'node:assert/strict'
import { rewriteMuImport, rewriteMuToggle } from '../src/sigils.js'
import { transpile } from '../src/transpiler/index.js'

describe('littéraux regex `/…/` : zone inerte pour µimport/µtoggle', function () {
  describe('rewriteMuImport — regex devant la rune', function () {
    it('U1 — un `#` non-alpha dans le regex n\'ouvre plus un faux commentaire', function () {
      assert.equal(rewriteMuImport("re = /#-/; m = µimport('mod.js')", 'test'), "re = /#-/; m = µ._mjs_import(µasset('mod.js'))")
    })

    it('U2 — un `\'` dans le regex n\'ouvre plus une fausse chaîne', function () {
      assert.equal(rewriteMuImport("re = /'/; m = µimport('mod.js')", 'test'), "re = /'/; m = µ._mjs_import(µasset('mod.js'))")
    })

    it('U3 — un backtick dans le regex n\'ouvre plus une fausse chaîne à backticks', function () {
      assert.equal(rewriteMuImport("re = /`/; m = µimport('mod.js')", 'test'), "re = /`/; m = µ._mjs_import(µasset('mod.js'))")
    })

    it('U4 — un `//` interne au regex (slashes échappés) n\'est plus pris pour un commentaire', function () {
      assert.equal(rewriteMuImport("re = /\\/\\//; m = µimport('mod.js')", 'test'), "re = /\\/\\//; m = µ._mjs_import(µasset('mod.js'))")
    })
  })

  describe('rewriteMuToggle — regex devant la rune', function () {
    it('U5 — un `#` non-alpha dans le regex n\'ouvre plus un faux commentaire', function () {
      assert.equal(rewriteMuToggle("re = /#-/; µtoggle($x, 'a')", 'test'), "re = /#-/; $x = ($x === 'a' ? '' : 'a')")
    })

    it('U6 — un `\'` dans le regex n\'ouvre plus une fausse chaîne', function () {
      assert.equal(rewriteMuToggle("re = /'/; µtoggle($x, 'a')", 'test'), "re = /'/; $x = ($x === 'a' ? '' : 'a')")
    })

    it('U7 — un backtick dans le regex n\'ouvre plus une fausse chaîne à backticks', function () {
      assert.equal(rewriteMuToggle("re = /`/; µtoggle($x, 'a')", 'test'), "re = /`/; $x = ($x === 'a' ? '' : 'a')")
    })

    it('U8 — une regex qui MENTIONNE la rune reste muette, plus de rune-toggle-appel', function () {
      const code = 're = /µtoggle/'
      assert.doesNotThrow(() => rewriteMuToggle(code, 'test'))
      assert.equal(rewriteMuToggle(code, 'test'), code)
    })
  })

  describe('fenêtres `${…}` : comptage d\'accolades CONSCIENT du regex', function () {
    it('U9 — un `}` DANS un regex de la fenêtre ne referme plus la fenêtre en avance (µtoggle)', function () {
      const src = 's = `v: ${ /}/.test(y) ? µtoggle($x) : 0 } fin`'
      assert.equal(rewriteMuToggle(src, 'test'), 's = `v: ${ /}/.test(y) ? $x = !$x : 0 } fin`')
    })

    it('U10 — un `\'` DANS un regex de la fenêtre n\'avale plus la fenêtre entière (µimport)', function () {
      const src = "s = `v: ${ /'/.test(y) ? µimport('mod.js') : 0 } fin`"
      assert.equal(rewriteMuImport(src, 'test'), "s = `v: ${ /'/.test(y) ? µ._mjs_import(µasset('mod.js')) : 0 } fin`")
    })
  })

  describe('non-régression : division, jamais confondue avec une regex', function () {
    it('N1 — rewriteMuToggle : `/` de division devant la rune', function () {
      assert.equal(rewriteMuToggle('a = b / c; µtoggle($x)', 'test'), 'a = b / c; $x = !$x')
    })

    it('N2 — rewriteMuImport : deux `/` de division devant la rune', function () {
      assert.equal(rewriteMuImport("a = b / c / d; m = µimport('mod.js')", 'test'), "a = b / c / d; m = µ._mjs_import(µasset('mod.js'))")
    })

    it('N3 — rewriteMuImport : une regex qui mentionne µimport (parenthèse échappée) reste intacte', function () {
      const code = 're = /µimport\\(/'
      assert.equal(rewriteMuImport(code, 'test'), code)
    })

    // N4 — une chaîne '…µtoggle($x)…' et un commentaire // µtoggle($x) restent intacts : déjà
    // couvert par tests/rune-toggle.test.ts, describe 'ce qui reste intact', it 'une mention dans
    // un commentaire ou une chaîne n'est pas touchée' (lignes 112-115) — non dupliqué ici.
  })

  describe('bout en bout (transpile)', function () {
    // note : `/#-/` (comme U1/U5) fait choir le tokenizer Civet lui-même (heregex,
    // interpolation `#{}`) — panne SANS RAPPORT avec ce correctif, sur `/#-/` SEUL
    // (hors µtoggle). `/'/`  (U2/U6) exerce la MÊME zone inerte sans ce piège.
    it('E1 — handler : regex inerte devant µtoggle, rune consommée', async function () {
      const { output } = await transpile("<button @click={re = /'/; µtoggle($open)}>x</button>\n", { moduleName: 'sigils-regex-test' })
      assert.ok(!output.includes('µtoggle'), `rune non consommée : ${output}`)
      assert.match(output, /!\$\.open/, `affectation absente : ${output}`)
    })

    it('E2 — <script> : regex inerte devant µimport, rune consommée', async function () {
      // µimport en <script> passe par rewriteMuImportAst (AST post-Civet), PAS par
      // rewriteMuImport — chemin non couvert ici, gardé en
      // NON-RÉGRESSION plutôt que retiré, la forme collant à la demande.
      const src = "<script>\n  re := /'/\n  m := µimport('mod.js')\n</script>\n<p>{m}</p>\n"
      const { output } = await transpile(src, { moduleName: 'sigils-regex-test' })
      assert.ok(!output.includes('µimport('), `rune non consommée : ${output}`)
      assert.match(output, /µ\._mjs_import\(µ\.?asset\('mod\.js'\)\)/, `réécriture absente : ${output}`)
    })
  })

  // le correctif ci-dessus (regex comme zone inerte dans
  // skipInertFrom) a introduit DEUX régressions, non couvertes par les cas U1-U10/N1-N4/E1-E2 :
  //   RÉGRESSION 1 — DANS une fenêtre `${…}`/`#{…}`, un `#` pris pour un commentaire Coffee (la
  //     branche `#` de skipInertFrom, réutilisée telle quelle pour le comptage d'accolades) saute
  //     jusqu'au `\n` OU la fin de `content` — `content` étant la sous-chaîne d'UNE chaîne, souvent
  //     SANS `\n`, le `}` fermant la fenêtre est avalé : `depth` n'atteint jamais 0, la fenêtre
  //     ressort avec une accolade dupliquée (corruption SILENCIEUSE). Or un `#` DANS une expression
  //     `${…}` est un champ privé/`#longueur` Civet, jamais un commentaire — remède : `skipInertFrom`
  //     reçoit un 3e paramètre `diese`, `false` pour les fenêtres (cf. bandeaux datés sur
  //     skipInertFrom/rewriteMuImportWindows/rewriteMuToggleWindows plus haut dans sigils.ts).
  //   RÉGRESSION 2 — perf quasi-quadratique de `ouvreUneRegex`, appelée à CHAQUE `/` par
  //     skipInertFrom : `gauche.replace(/\s+$/, '')` scanne toute la chaîne déjà émise à chaque
  //     appel (O(i)), sur potentiellement O(n) positions `/` → O(n²) (mesures : cf. describe perf
  //     ci-dessous). Remède : ne regarder que la QUEUE de `gauche` (whitespace trailing
  //     + 16 derniers caractères), signature et sémantique inchangées pour les appelants.
  describe('régression 1 : corruption des fenêtres sur `#`/champ privé', function () {
    it('W1 — un commentaire `#` DANS une fenêtre `${…}` ne dévore plus le `}` fermant (µtoggle)', function () {
      assert.equal(rewriteMuToggle('s = `v: ${ a # commentaire } fin`; µtoggle($x)', 'test'), 's = `v: ${ a # commentaire } fin`; $x = !$x')
    })

    it('W2 — un commentaire `#` DANS une fenêtre `#{…}` ne dévore plus le `}` fermant (µimport)', function () {
      assert.equal(rewriteMuImport("s = \"v: #{ a # c } fin\"; m = µimport('mod.js')", 'test'), "s = \"v: #{ a # c } fin\"; m = µ._mjs_import(µasset('mod.js'))")
    })

    it('W3 — un champ privé `o.#x` DANS une fenêtre `${…}` reste intact (non-régression, déjà vert avant ce correctif)', function () {
      assert.equal(rewriteMuToggle('s = `v: ${ o.#x } fin`; µtoggle($x)', 'test'), 's = `v: ${ o.#x } fin`; $x = !$x')
    })

    it('W4 — fenêtre `${…}` jamais refermée : sortie byte-identique à l\'entrée, aucun `}` synthétisé', function () {
      const src = 's = `v: ${ a `'
      assert.equal(rewriteMuImport(src, 'test'), src)
    })

    it('W5 — bout en bout (transpile) : commentaire `#` dans une fenêtre d\'un handler µtoggle, jamais d\'accolade dupliquée', async function () {
      // NOTE — l'exemple `${ 1 }` (sans `#`) ne déclenche PAS la régression
      // (sondé avant correctif : `fin\`` présent, pas de `fin}}`) ; repris ici avec le même
      // contenu problématique que W1 (`# commentaire`) pour exercer réellement le chemin
      // bout-en-bout — sondé ROUGE avant correctif : sortie contenait `fin}}`, jamais `fin\``.
      const src = '<button @click={s = `v: ${ a # commentaire } fin`; µtoggle($open)}>x</button>\n'
      const { output } = await transpile(src, { moduleName: 'sigils-regex-test-2' })
      assert.ok(output.includes('fin`'), `template corrompu, "fin\`" absent : ${output}`)
      assert.ok(!output.includes('fin}}'), `accolade dupliquee (fin}}) : ${output}`)
    })
  })

  describe('régression 2 : perf `ouvreUneRegex`', function () {
    it('P1 — rewriteMuToggle sur 20 000 divisions reste sous 500 ms (mesuré ~3,4 s avant correctif)', function () {
      const src   = 'a = b / c; '.repeat(20000) + 'µtoggle($x)'
      const debut = Date.now()
      const out   = rewriteMuToggle(src, 'test')
      const duree = Date.now() - debut
      assert.ok(out.endsWith('$x = !$x'), `rune non reecrite : ${out.slice(-40)}`)
      assert.ok(duree < 500, `duree observee : ${duree} ms (borne large)`)
    })
  })
})
