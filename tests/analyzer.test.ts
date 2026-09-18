// Tests de l'analyzer — port direct de l'API V1 (modular_js_analyzer.rb)
// + ast_daemon.js (script section).

import assert from 'node:assert/strict'
import {
  analyze,
  analyzeSnippet,
  analyzeAttachMode,
  Analyzer,
} from '../src/analyzer/index.js'

describe('analyzer', () => {

  describe('analyze() — script complet', () => {
    it('détecte les state vars via $.x', () => {
      const out = analyze(`$.count = 0; $.name = 'foo';`)
      assert.deepEqual(out.state.sort(), ['count', 'name'])
    })

    it('détecte un computed quand RHS contient $.y', () => {
      const out = analyze(`$.count = 0; $.double = $.count * 2;`)
      assert.deepEqual(out.computed.double, ['count'])
      assert.match(out.modifiedCode, /\{ _mjs_c: true, f: \(\) => \(\$\.count \* 2\) \}/)
    })

    it('skip si RHS = µ.snap(...) (opt-out snapshot)', () => {
      const out = analyze(`$.count = 0; $.snap = µ.snap($.count + 1);`)
      assert.equal(out.computed.snap, undefined)
    })

    it('skip les assignations dans une fonction', () => {
      const out = analyze(`$.count = 0; const inc = () => { $.count = $.count + 1 };`)
      assert.equal(out.computed.count, undefined)
    })

    it('skip si RHS est déjà une fonction (no wrap)', () => {
      const out = analyze(`$.count = 0; $.fn = () => $.count + 1;`)
      assert.deepEqual(out.computed.fn, ['count'])
      // Pas de wrapping dans `_mjs_c` parce que RHS est déjà une fonction
      assert.doesNotMatch(out.modifiedCode, /\{ _mjs_c: true/)
    })

    it('§§y (contexte RÉACTIF) : $.x = _mjs_getRCtx wrappé en computed LAZY (faille §4 refermée)', () => {
      const out = analyze(`$.x = this._mjs_getRCtx('theme');`)
      assert.match(out.modifiedCode, /\{ _mjs_c: true, f: \(\) => \(this\._mjs_getRCtx\('theme'\)\) \}/)
    })

    it('§ctx (contexte non réactif) : $.x = _mjs_getContext wrappé lazy aussi (régression)', () => {
      const out = analyze(`$.x = this._mjs_getContext('theme');`)
      assert.match(out.modifiedCode, /\{ _mjs_c: true/)
    })
  })

  describe('analyze() — µderived (marqueur µ._mjs_forceDeps posé par le lexer)', () => {
    it('deps forcées ajoutées aux deps naturelles — calc() ne référence $.a/$.b nulle part texte', () => {
      const out = analyze(`$.a=1; $.b=2; $.var = µ._mjs_forceDeps(calc(), $.a, $.b); function calc(){}`)
      assert.deepEqual(out.computed.var.sort(), ['a', 'b'])
      assert.doesNotMatch(out.modifiedCode, /_mjs_forceDeps/)
    })

    it('marqueur effacé → wrap computed strictement identique à un derived écrit à la main', () => {
      const out = analyze(`$.a = 1; $.c = µ._mjs_forceDeps($.a + 1);`)
      assert.deepEqual(out.computed.c, ['a'])
      assert.match(out.modifiedCode, /\{ _mjs_c: true, f: \(\) => \(\$\.a \+ 1\) \}/)
      assert.doesNotMatch(out.modifiedCode, /_mjs_forceDeps/)
    })

    it('zéro dépendance forcée ET zéro dep naturelle : dégénère en simple affectation (pas de wrap)', () => {
      const out = analyze(`$.x = µ._mjs_forceDeps(5);`)
      assert.equal(out.computed.x, undefined)
      assert.doesNotMatch(out.modifiedCode, /_mjs_c: true/)
      assert.doesNotMatch(out.modifiedCode, /_mjs_forceDeps/)
      assert.match(out.modifiedCode, /\$\.x = 5;/)
    })

    it('hors racine (dans une fonction) : marqueur jamais effacé → erreur de compilation explicite', () => {
      assert.throws(
        () => analyze(`const inc = () => { $.x = µ._mjs_forceDeps($.a + 1, $.b); };`),
        /µderived[\s\S]*niveau racine/
      )
    })
  })

  // Civet abaisse `$.x = if … else …` SANS
  // parenthèses, AU TOP-LEVEL, en 3 statements séparés dont le dernier RHS
  // est l'identifiant NU `ref` (jamais `$.qqch`) : le handler AssignmentExpression
  // normal ne le reconnaît jamais comme derived → instantané figé à vie, en
  // silence. Formes ci-dessous VÉRIFIÉES contre la sortie réelle de
  // @danielx/civet (`compile('$.x = if $.sel then $.a else $.b', {js:true})`).
  describe('analyze() — dérivée if/switch/try SANS parenthèses (abaissement Civet)', () => {
    it('cas nominal if/else : wrap computed + deps des 2 branches', () => {
      const src = `let ref;if ($.sel) ref = $.selTasks; else ref = $.visible;$.display = ref`
      const out = analyze(src)
      assert.match(out.modifiedCode, /_mjs_c/)
      assert.match(out.modifiedCode, /return ref/)
      assert.deepEqual(out.computed.display.sort(), ['sel', 'selTasks', 'visible'])
    })

    it('variante `µ.snap(ref)` (opt-out `=:`) : source INTACTE', () => {
      const src = `let ref;if ($.sel) ref = $.selTasks; else ref = $.visible;$.snap = µ.snap(ref);`
      const out = analyze(src)
      assert.equal(out.modifiedCode, src)
      assert.equal(out.computed.snap, undefined)
    })

    it('refN réutilisé APRÈS s2 (`console.log(ref)`) : source INTACTE', () => {
      const src = `let ref;if ($.sel) ref = $.selTasks; else ref = $.visible;$.display = ref;console.log(ref);`
      const out = analyze(src)
      assert.equal(out.modifiedCode, src)
    })

    it('branches SANS aucune lecture réactive (identifiants nus) : source INTACTE', () => {
      const src = `let ref;if (cond) ref = a; else ref = b;$.display = ref;`
      const out = analyze(src)
      assert.equal(out.modifiedCode, src)
      assert.equal(out.computed.display, undefined)
    })

    it('SwitchStatement : wrap computed, deps = discriminant + branches', () => {
      const src = `let ref;switch ($.a) { case 1: ref = $.b; break; default: ref = $.c };$.x = ref;`
      const out = analyze(src)
      assert.match(out.modifiedCode, /_mjs_c/)
      assert.deepEqual(out.computed.x.sort(), ['a', 'b', 'c'])
    })

    it('TryStatement : wrap computed, deps = try + catch', () => {
      const src = `let ref;try { ref = $.a } catch (e) { ref = $.b };$.x = ref;`
      const out = analyze(src)
      assert.match(out.modifiedCode, /_mjs_c/)
      assert.deepEqual(out.computed.x.sort(), ['a', 'b'])
    })

    it('await dans une branche : `f: async () => { … }`', () => {
      const src = `let ref;if ($.sel) ref = await fetchData(); else ref = $.fallback;$.x = ref;`
      const out = analyze(src)
      assert.match(out.modifiedCode, /f: async \(\) => \{/)
      assert.deepEqual(out.computed.x.sort(), ['fallback', 'sel'])
    })

    it('nom `ref1` (2e derived du fichier chez Civet) : reconnu pareil', () => {
      const src = `let ref1;if ($.sel) ref1 = $.a; else ref1 = $.b;$.x = ref1;`
      const out = analyze(src)
      assert.match(out.modifiedCode, /_mjs_c/)
      assert.match(out.modifiedCode, /return ref1/)
      // la condition `$.sel` du if fait AUSSI partie de s1 : dep légitime (si
      // $.sel change, les branches peuvent basculer, le computed doit rejouer)
      assert.deepEqual(out.computed.x.sort(), ['a', 'b', 'sel'])
    })

    it('§§y (`this._mjs_getRCtx`) dans une branche : wrappé même avec deps VIDE (readsReactiveSource)', () => {
      const src = `let ref;if (drapeau) ref = this._mjs_getRCtx('y'); else ref = this._mjs_getRCtx('z');$.x = ref;`
      const out = analyze(src)
      assert.match(out.modifiedCode, /_mjs_c/)
      assert.match(out.modifiedCode, /return ref/)
      assert.equal(out.computed.x, undefined) // deps.size === 0 → pas d'entrée dans `computed` (même convention que le chemin normal)
    })
  })

  describe('analyze() — warning boucle réactive (µeffect lit ET écrit la même $var)', () => {
    function warnsLoop(code: string): boolean {
      const orig = console.warn
      let warned = false
      console.warn = (...a: any[]) => { if (String(a[0]).includes('boucle réactive')) warned = true }
      try { analyze(code) } finally { console.warn = orig }
      return warned
    }
    it('warn : µeffect -> $n = $n + 1', () => {
      assert.equal(warnsLoop(`$.n = 0; µeffect(() => { $.n = $.n + 1; });`), true)
    })
    it('warn : µeffect -> $n++ (UpdateExpression)', () => {
      assert.equal(warnsLoop(`$.n = 0; µeffect(() => { $.n++; });`), true)
    })
    it('warn : µeffect -> $n += 1 (compound lit aussi la cible)', () => {
      assert.equal(warnsLoop(`$.n = 0; µeffect(() => { $.n += 1; });`), true)
    })
    it('PAS de warn : µeffect écrit une AUTRE var ($double = $n * 2)', () => {
      assert.equal(warnsLoop(`$.n = 0; µeffect(() => { $.double = $.n * 2; });`), false)
    })
    it('PAS de warn : µeffect en lecture seule', () => {
      assert.equal(warnsLoop(`$.n = 0; µeffect(() => { log($.n); });`), false)
    })
    it('FORME RÉELLE `µ.effect(...)` (post-sucre, callee MemberExpression) : warne AUSSI', () => {
      // Avant, la garde n'acceptait que l'Identifier `µeffect` — jamais
      // atteinte sur un composant réel (toujours déjà pointé `µ.effect`).
      assert.equal(warnsLoop(`$.n = 0; µ.effect(() => { $.n = $.n + 1; });`), true)
      assert.equal(warnsLoop(`$.n = 0; µ.effect(() => { $.double = $.n * 2; });`), false)
    })
  })

  describe('analyzeSnippet()', () => {
    it('extrait les deps simples', () => {
      assert.deepEqual(analyzeSnippet('[$.x, $.y]').sort(), ['x', 'y'])
    })

    it('retourne [] sur code invalide', () => {
      assert.deepEqual(analyzeSnippet('this is not js'), [])
    })

    // `@fmt()` dans un snippet de template compile en `this.fmt()`
    // (generator/utils.ts) ; `@@fmt()` en `_mjsThis.fmt()`. Les deux émettent
    // le marqueur '@fmt', résolu plus tard par resolveSnippetDeps (classe
    // Analyzer, via this.methodReads).
    it('this.fmt()/_mjsThis.fmt() émettent la dep marqueur \'@fmt\'', () => {
      assert.deepEqual(analyzeSnippet('this.fmt()'), ['@fmt'])
      assert.deepEqual(analyzeSnippet('_mjsThis.fmt()'), ['@fmt'])
    })
  })

  describe('analyzeAttachMode()', () => {
    it('"factory" pour tooltip($msg)', () => {
      assert.equal(analyzeAttachMode('tooltip($.msg)'), 'factory')
    })

    it('"direct" si _node est un argument', () => {
      assert.equal(analyzeAttachMode('setup(_node, options)'), 'direct')
    })

    it('"factory" pour Identifier nu', () => {
      assert.equal(analyzeAttachMode('slow'), 'factory')
    })
  })

  describe('Analyzer class', () => {
    // V2 — bitmask retiré, dispatch direct par varName. `_mjs_var_bits` est
    // conservé comme registre de présence (valeur 1 pour chaque var) pour
    // rétro-compat avec les stores universels (qui font
    // `_mjs_var_bits[k] !== undefined`). Plus de mode BigInt.
    it('enregistre chaque state var dans varBitsDict (présence)', () => {
      const a = new Analyzer(`$.count = 0; $.name = 'foo';`)
      assert.equal(a.varBitsDict.count, 1)
      assert.equal(a.varBitsDict.name, 1)
      assert.equal(a.isBigInt, false)
    })

    it('enregistre aussi les computeds dans varBitsDict', () => {
      const a = new Analyzer(`$.a = 0; $.b = 0; $.c = $.a + $.b;`)
      assert.equal(a.varBitsDict.a, 1)
      assert.equal(a.varBitsDict.b, 1)
      assert.equal(a.varBitsDict.c, 1)
    })

    it('closure transitive (computed -> computed) : deps réduites au state', () => {
      const a = new Analyzer(`$.a = 0; $.b = $.a + 1; $.c = $.b * 2;`)
      // c → b → a : computedDeps.c contient 'a' transitivement
      assert.ok(a.computedDeps.c.includes('a'))
    })

    it('plus de mode BigInt au-delà de 31 state vars (limite levée)', () => {
      const decls = Array.from({ length: 35 }, (_, i) => `$.v${i} = 0;`).join(' ')
      const a = new Analyzer(decls)
      assert.equal(a.isBigInt, false)
      assert.equal(a.varBitsDict.v0, 1)
      assert.equal(a.varBitsDict.v34, 1)
      assert.equal(a.stateVars.length, 35)
    })

    it('autoDeclareFromTemplate ajoute $xxx du HTML', () => {
      const a = new Analyzer(`$.count = 0;`)
      a.autoDeclareFromTemplate('<p>{$count} - {$missing}</p>')
      assert.deepEqual(a.stateVars.sort(), ['count', 'missing'])
      assert.equal(a.varBitsDict.missing, 1)
    })

    it('autoDeclareFromTemplate déclare $store et $props (réservation vestigiale retirée)', () => {
      const a = new Analyzer(`$.count = 0;`)
      a.autoDeclareFromTemplate('<p>{$store.x} - {$props.y}</p>')
      assert.deepEqual(a.stateVars.sort(), ['count', 'props', 'store'])
    })

    // le 1er caractère
    // après `$` était restreint à `[a-zA-Z]` (le RESTE du nom acceptait déjà
    // `_`) : `$_privee` (underscore juste après le sigil, convention "privé"
    // courante) n'était JAMAIS auto-déclaré depuis le template — le texte
    // s'affichait une fois au mount (l'interpolation elle-même compile) puis
    // restait figé à vie (`_mjs_effectsByVar` vide pour ce nom, aucune mutation
    // ultérieure ne le ré-invalidait jamais).
    it("autoDeclareFromTemplate ajoute $_privee (underscore juste après $)", () => {
      const a = new Analyzer('')
      a.autoDeclareFromTemplate('<p>{$_secret}</p>')
      assert.deepEqual(a.stateVars, ['_secret'],
        "AVANT le fix : jamais ajouté à stateVars — _mjs_effectsByVar['_secret'] restait vide, texte figé à vie")
      assert.equal(a.varBitsDict._secret, 1)
    })

    it("autoDeclareFromTemplate : $_a et $a sont deux noms DISTINCTS (pas de collision)", () => {
      const a = new Analyzer('')
      a.autoDeclareFromTemplate('<p>{$_a} - {$a}</p>')
      assert.deepEqual(a.stateVars.sort(), ['_a', 'a'])
    })

    it('batchCalculateVars cache les listes de vars par snippet', () => {
      const a = new Analyzer(`$.x = 0; $.y = 0;`)
      a.batchCalculateVars(['[$.x]', '[$.x, $.y]'])
      assert.deepEqual(a.getEffectVars('[$.x]').sort(), ['x'])
      assert.deepEqual(a.getEffectVars('[$.x, $.y]').sort(), ['x', 'y'])
      assert.deepEqual(a.getEffectVars('[$.unknown]'), []) // pas dans cache
    })

    // resolveSnippetDeps (privée, exercée via getEffectVars) étend '@nom'
    // en lectures de LA méthode (point-fixées par resolveMethodReadsPointFixe).
    it('resolveSnippetDeps étend \'@fmt\' en lectures de la méthode', () => {
      const a = new Analyzer(`$.prix = 0; $.devise = 'EUR'; this.fmt = function() { return $.prix + $.devise; };`)
      a.batchCalculateVars(['this.fmt()'])
      assert.deepEqual(a.getEffectVars('this.fmt()').sort(), ['devise', 'prix'])
    })

    it('\'@inconnu\' (méthode jamais déclarée) est ignoré en silence', () => {
      const a = new Analyzer(`$.prix = 0;`)
      a.batchCalculateVars(['this.inconnu()'])
      assert.deepEqual(a.getEffectVars('this.inconnu()'), [])
    })

    it('la clé \'@nom\' elle-même n\'est jamais dans la sortie', () => {
      const a = new Analyzer(`$.prix = 0; this.fmt = function() { return $.prix; };`)
      a.batchCalculateVars(['this.fmt()'])
      const vars = a.getEffectVars('this.fmt()')
      assert.ok(!vars.some(v => v.startsWith('@')), `pas de clé '@' dans ${JSON.stringify(vars)}`)
    })

    it('détection de cycle auto-résolution', () => {
      // a dépend de b, b dépend de a → cycle
      const orig = console.warn
      let warned = false
      console.warn = () => { warned = true }
      try {
        const a = new Analyzer(`$.a = $.b + 1; $.b = $.a + 1;`)
        assert.equal(warned, true)
        // Pas de stack overflow / boucle infinie
        assert.ok(a.varBitsDict.a !== undefined)
      } finally {
        console.warn = orig
      }
    })

    it('toJsDict produit un objet litéral JS valide (registre de présence)', () => {
      const a = new Analyzer(`$.x = 0; $.y = 0;`)
      const dict = a.toJsDict()
      assert.match(dict, /"x": 1/)
      assert.match(dict, /"y": 1/)
    })
  })

  describe('analyzer — membre calculé $[cle]', () => {
    it('membre calculé `$[cle]` : ni state var fantôme, ni wrap auto-derived', () => {
      const out = analyze('const key = "a"; $[key] = $.b + 1;')
      assert.deepEqual(out.state, ['b'])                 // `key` n'est PAS une state var
      assert.ok(!out.modifiedCode.includes('_mjs_c'))    // le slot reçoit la valeur, pas l'objet-marqueur
    })

    it('`$[cle]` en lecture (snippet) ne pollue pas les deps', () => {
      assert.deepEqual(analyzeSnippet('$[key] + $.z'), ['z'])
    })
  })
})
