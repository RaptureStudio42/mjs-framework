// µtoggle — bascule / cycle d'état.
//
// La rune remplace un ternaire qui répète le nom de l'état trois fois. Ce que ces tests
// verrouillent, et pourquoi :
//   · LA RÈGLE — la liste des arguments EST la liste des états, en boucle : un cycle à N
//     valeurs n'oscille QU'ENTRE elles, il ne passe JAMAIS par le vide (c'était la demande) ;
//   · le vide n'entre dans le cycle que s'il est ÉCRIT (`µtoggle($x, '', 'a')`) ;
//   · la forme à UNE valeur reste le raccourci présent/absent (un cycle d'un seul état ne
//     basculerait rien) et la forme SANS valeur, la bascule booléenne ;
//   · une valeur courante hors liste retombe sur le PREMIER état, jamais sur `undefined` ;
//   · sucre PUR : la sortie est une affectation ordinaire, le setter réactif étant posé par
//     les passes du dessous (µ._set pour `$x`, µ._storeSet pour `$$x`) — donc la rune marche
//     À L'IDENTIQUE dans un <script> et dans un handler, les DEUX moteurs de sucre ;
//   · toute écriture douteuse est REFUSÉE à la compilation (cible non-état, valeur calculée,
//     doublon dans le cycle, forme nue) : jamais un silence, jamais une double évaluation.

import assert from 'node:assert/strict'
import { rewriteMuToggle } from '../src/sigils.js'
import { transpile } from '../src/transpiler/index.js'
import { cleanJs } from '../src/generator/utils.js'

// évalue la sortie de la rune sur un état donné et rend la valeur suivante
function pas(rune: string, valeur: unknown): unknown {
  const nom  = /µtoggle\(\s*\$([a-zA-Z_]\w*)/.exec(rune)?.[1] ?? ''
  const code = rewriteMuToggle(rune, 'test').replace(/\$([a-zA-Z_]\w*)/g, 's.$1')
  const s: Record<string, unknown> = { [nom]: valeur }
  new Function('s', code)(s)
  return s[nom]
}

// déroule N pas de cycle depuis une valeur de départ
function cycle(rune: string, depart: unknown, n: number): unknown[] {
  const sortie: unknown[] = []
  let v = depart
  for (let i = 0; i < n; i++) { v = pas(rune, v); sortie.push(v) }
  return sortie
}

describe('µtoggle — bascule et cycle d\'état', function () {
  describe('la sémantique du cycle', function () {
    it('deux valeurs oscillent ENTRE ELLES, jamais par le vide', function () {
      assert.deepEqual(cycle("µtoggle($t, 'gold', 'dark')", 'gold', 4), ['dark', 'gold', 'dark', 'gold'])
    })

    it('trois valeurs bouclent dans l\'ordre écrit', function () {
      assert.deepEqual(cycle("µtoggle($t, 'a', 'b', 'c')", 'a', 4), ['b', 'c', 'a', 'b'])
    })

    it('le vide n\'entre dans le cycle que s\'il est ÉCRIT', function () {
      assert.deepEqual(cycle("µtoggle($t, '', 'a', 'b')", '', 4), ['a', 'b', '', 'a'])
    })

    it('une valeur hors liste retombe sur le PREMIER état', function () {
      assert.equal(pas("µtoggle($t, 'a', 'b', 'c')", 'inconnu'), 'a')
      assert.equal(pas("µtoggle($t, 'a', 'b')", undefined), 'a')
    })

    it('une seule valeur = présent / absent', function () {
      assert.deepEqual(cycle("µtoggle($t, 'banner')", '', 3), ['banner', '', 'banner'])
    })

    it('aucune valeur = bascule booléenne', function () {
      assert.deepEqual(cycle('µtoggle($ouvert)', false, 3), [true, false, true])
    })

    it('des nombres bouclent comme des chaînes', function () {
      assert.deepEqual(cycle('µtoggle($t, 1, 2, 3)', 1, 4), [2, 3, 1, 2])
    })
  })

  describe('la sortie compilée', function () {
    it('un cycle à N valeurs ne contient AUCUNE chaîne vide fabriquée', function () {
      const out = rewriteMuToggle("µtoggle($theme, 'gold', 'dark')", 'test')
      assert.ok(!out.includes("''"), `le vide ne doit pas s'inviter : ${out}`)
      assert.equal(out, "$theme = ($theme === 'gold' ? 'dark' : 'gold')")
    })

    it('la forme à une valeur, elle, pose bien le vide', function () {
      assert.equal(rewriteMuToggle("µtoggle($layout, 'banner')", 'test'), "$layout = ($layout === 'banner' ? '' : 'banner')")
    })

    it('la cible sort VERBATIM — c\'est la passe suivante qui pose le setter', function () {
      assert.equal(rewriteMuToggle('µtoggle($ouvert)', 'test'), '$ouvert = !$ouvert')
      assert.match(rewriteMuToggle("µtoggle($$mode, 'jour', 'nuit')", 'test'), /^\$\$mode = /)
    })
  })

  describe('les deux moteurs de sucre', function () {
    it('dans un handler, la rune devient le setter réactif', async function () {
      const { data } = await transpile("<button @click={µtoggle($layout, 'banner')}>x</button>\n", { moduleName: 'card' })
      assert.match(data.jsInitBase, /µ\._set\(_mjsThis, 'layout', \$\.layout === 'banner' \? '' : 'banner'\)/)
    })

    it('dans un <script>, même sortie', async function () {
      const src = "<script>\n  @bascule = ->\n    µtoggle($theme, 'gold', 'dark')\n</script>\n<div>{$theme}</div>\n"
      const { data } = await transpile(src, { moduleName: 'card' })
      assert.match(data.jsInitBase, /µ\._set\(_mjsThis, 'theme', \$\.theme === 'gold' \? 'dark' : 'gold'\)/)
    })

    it('un store `$$x` part par µ._storeSet', async function () {
      const { data } = await transpile("<button @click={µtoggle($$mode, 'jour', 'nuit')}>x</button>\n", { moduleName: 'card' })
      assert.match(data.jsInitBase, /µ\._storeSet\("mode", µ\.store\.mode === 'jour' \? 'nuit' : 'jour'\)/)
    })

    it('un cycle à trois valeurs compile en ternaires imbriqués valides', async function () {
      const { data } = await transpile("<button @click={µtoggle($t, 'a', 'b', 'c')}>x</button>\n", { moduleName: 'card' })
      assert.match(data.jsInitBase, /\$\.t === 'a' \? 'b' : \$\.t === 'b' \? 'c' : 'a'/)
    })
  })

  describe('ce qui reste intact', function () {
    it('une mention dans un commentaire ou une chaîne n\'est pas touchée', function () {
      assert.equal(rewriteMuToggle("// µtoggle($x, 'a') en commentaire", 'test'), "// µtoggle($x, 'a') en commentaire")
      assert.equal(rewriteMuToggle("'µtoggle($x, 1)'", 'test'), "'µtoggle($x, 1)'")
    })

    it('une virgule DANS une valeur ne coupe pas l\'argument', function () {
      assert.equal(rewriteMuToggle("µtoggle($x, 'a,b', 'c')", 'test'), "$x = ($x === 'a,b' ? 'c' : 'a,b')")
    })

    it('un code sans la rune ressort à l\'octet près', function () {
      const code = "$x = 'toggle' + µtogglette\n"
      assert.equal(rewriteMuToggle(code, 'test'), code)
    })
  })

  // Trois défauts, chacun remis
  // sous test. Les deux premiers étaient MUETS.
  describe('défauts corrigés', function () {
    it('DANS une fenêtre `${…}`, la rune est consommée — les deux moteurs, pas seulement le lexer', function () {
      const out = cleanJs("`${µtoggle($layout, 'banner')}`")
      assert.ok(!out.includes('µtoggle'), `rune non consommée : ${out}`)
      assert.match(out, /\$\.layout = \(\$\.layout === 'banner' \? '' : 'banner'\)/)
    })

    it('… y compris à deux niveaux de chaîne à backticks', function () {
      const out = cleanJs("`a ${ `b ${µtoggle($x, 'v')}` }`")
      assert.ok(!out.includes('µtoggle'), `rune non consommée : ${out}`)
    })

    it('un composant qui niche la rune dans une chaîne à backticks compile SANS la laisser au runtime', async function () {
      const src = "<script>\n  $layout = ''\n</script>\n<div>{`etat: ${µtoggle($layout, 'banner')}`}</div>\n"
      const { data } = await transpile(src, { moduleName: 'card' })
      assert.ok(!data.jsInitBase.includes('µtoggle'), 'µtoggle ne doit jamais survivre dans le JS livré')
    })

    it('… et dans un handler, sans message d\'erreur trompeur sur la cible', async function () {
      const src = "<button @click={`${µtoggle($layout, 'banner')}`}>x</button>\n"
      const { data } = await transpile(src, { moduleName: 'card' })
      assert.ok(!data.jsInitBase.includes('µtoggle'))
    })

    it('un doublon se voit sur la VALEUR, pas sur le texte source', function () {
      assert.throws(() => rewriteMuToggle('µtoggle($x, \'a\', "a")', 'test'), /deux fois/)
      assert.throws(() => rewriteMuToggle('µtoggle($x, 1, 1.0)', 'test'), /deux fois/)
      assert.throws(() => rewriteMuToggle('µtoggle($x, 1, 1e0)', 'test'), /deux fois/)
    })

    it('la notation exponentielle est un nombre comme un autre', function () {
      assert.equal(rewriteMuToggle('µtoggle($x, 1e3, 2e3)', 'test'), '$x = ($x === 1e3 ? 2e3 : 1e3)')
    })
  })

  describe('ce qui est refusé — bruyant, jamais muet', function () {
    it('une cible qui n\'est pas un chemin assignable', function () {
      assert.throws(() => rewriteMuToggle("µtoggle(f(), 'a')", 'test'), /premier argument/)
      assert.throws(() => rewriteMuToggle("µtoggle($x++, 'a')", 'test'), /premier argument/)
      assert.throws(() => rewriteMuToggle("µtoggle($arr[$i], 'a')", 'test'), /premier argument/)
      assert.throws(() => rewriteMuToggle("µtoggle($a + $b, 'a')", 'test'), /premier argument/)
      assert.throws(() => rewriteMuToggle("µtoggle()", 'test'), /premier argument/)
    })

    it('un mot que JS ne laisse pas réaffecter', function () {
      // sans la garde, `null = (…)` sortait tel quel : SyntaxError du navigateur, muette ici
      assert.throws(() => rewriteMuToggle("µtoggle(null, 'a')", 'test'), /premier argument/)
      assert.throws(() => rewriteMuToggle("µtoggle(this, 'a')", 'test'), /premier argument/)
      assert.throws(() => rewriteMuToggle("µtoggle(true, 'a')", 'test'), /premier argument/)
      // la garde porte sur la RACINE : `null.x` sortait sinon un `null.x = …` tout aussi cassé
      // (TypeError au premier clic)
      assert.throws(() => rewriteMuToggle("µtoggle(null.x, 'a')", 'test'), /premier argument/)
      assert.throws(() => rewriteMuToggle("µtoggle(NaN.x, 'a')", 'test'), /premier argument/)
      assert.throws(() => rewriteMuToggle("µtoggle(undefined.x, 'a')", 'test'), /premier argument/)
      assert.throws(() => rewriteMuToggle("µtoggle(this.x, 'a')", 'test'), /premier argument/)
    })

    it('une valeur calculée (elle serait évaluée deux fois)', function () {
      assert.throws(() => rewriteMuToggle('µtoggle($x, bar)', 'test'), /littérales/)
      assert.throws(() => rewriteMuToggle('µtoggle($x, $autre)', 'test'), /littérales/)
      assert.throws(() => rewriteMuToggle("µtoggle($x, 'a' + b)", 'test'), /littérales/)
    })

    it('une valeur répétée dans le cycle', function () {
      assert.throws(() => rewriteMuToggle("µtoggle($x, 'a', 'b', 'a')", 'test'), /deux fois/)
    })

    it('la forme nue ou sans parenthèses', function () {
      assert.throws(() => rewriteMuToggle("µtoggle $x, 'a'", 'test'), /appel parenthésé/)
      assert.throws(() => rewriteMuToggle('f = µtoggle', 'test'), /appel parenthésé/)
      assert.throws(() => rewriteMuToggle("µtoggle($x, 'a'", 'test'), /appel parenthésé/)
    })

    it('l\'erreur remonte jusqu\'au build d\'un composant', async function () {
      await assert.rejects(() => transpile("<button @click={µtoggle(f(), 'a')}>x</button>\n", { moduleName: 'card' }), /premier argument/)
    })

    it('une variable nue que RIEN ne déclare : refusée au build, jamais au premier clic', async function () {
      // c'est le « $ oublié » : sans garde, le handler posait un `let sens = (sens === …)`
      // local — « Cannot access 'sens' before initialization » au clic, sans un mot au build
      await assert.rejects(
        () => transpile("<button @click={µtoggle(sens, 'asc', 'desc')}>x</button>\n", { moduleName: 'card' }),
        /se relit dans sa propre déclaration/,
      )
    })
  })

  // ─── la CIBLE, élargie ────────────────────
  // La contrainte n'a jamais été « un état » : c'est un chemin ASSIGNABLE et PUR à la
  // lecture, parce que la chaîne de ternaires relit la cible une fois par test. Tout ce
  // qui est assignable est donc admis — y compris ce qui n'est PAS réactif (`@prop`,
  // `§x`, une variable ordinaire) : la bascule a bien lieu, c'est le re-rendu qui manque,
  // et c'est assumé. Reste refusé : ce qui aurait un effet de bord dédoublé.
  describe('la cible — tout chemin assignable et pur', function () {
    it('les racines réactives, chacune avec son propre setter', async function () {
      const sortie = async (rune: string) => (await transpile(`<button @click={${rune}}>x</button>\n`, { moduleName: 'card' })).output
      assert.match(await sortie("µtoggle($$mode, 'jour', 'nuit')"), /µ\._storeSet\("mode", µ\.store\.mode === 'jour' \? 'nuit' : 'jour'\)/)
      assert.match(await sortie("µtoggle(µtheme, 'clair', 'sombre')"), /µ\._storeSet\("__mjsTheme", µ\.store\.__mjsTheme === 'clair'/)
      assert.match(await sortie("µtoggle(µlang, 'fr', 'en')"), /µ\._storeSet\("__mjsLang", µ\.store\.__mjsLang === 'fr'/)
      assert.match(await sortie("µtoggle(§§ui, 'a', 'b')"), /_mjs_setRCtx\('ui'/)
    })

    it('un chemin profond passe par µ._mjs_deepSet, index littéral compris', async function () {
      const sortie = async (rune: string) => (await transpile(`<button @click={${rune}}>x</button>\n`, { moduleName: 'card' })).output
      assert.match(await sortie("µtoggle($o.a.b, 'a', 'b')"), /µ\._mjs_deepSet\(_mjsThis, \["o", "a", "b"\]/)
      assert.match(await sortie("µtoggle($arr[0], 'a', 'b')"), /µ\._mjs_deepSet\(_mjsThis, \["arr", 0\]/)
    })

    it('ce qui bascule sans être réactif est admis quand même', async function () {
      const sortie = async (rune: string) => (await transpile(`<button @click={${rune}}>x</button>\n`, { moduleName: 'card' })).output
      assert.match(await sortie("µtoggle(@mode, 'a', 'b')"), /this\.mode = \(this\.mode === 'a' \? 'b' : 'a'\)/)
      assert.match(await sortie("µtoggle(§ui, 'a', 'b')"), /_mjs_setContext\('ui'/)
    })

    it('une variable ordinaire du <script> bascule VRAIMENT — et persiste d\'un clic à l\'autre', async function () {
      const { output } = await transpile("<script>\n  sens = 'asc'\n</script>\n<button @click={µtoggle(sens, 'asc', 'desc')}>x</button>\n", { moduleName: 'card' })
      // pas de `let` dans le handler : le nom vise bien la var du <script>, vue par closure
      assert.match(output, /return sens = \(sens === 'asc' \? 'desc' : 'asc'\)/)
      assert.doesNotMatch(output.slice(output.indexOf('_mjs_inline')), /let sens/)
    })
  })
})
