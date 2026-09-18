// Tests du parser HTML — port des tests Coffee correspondants.

import assert from 'node:assert/strict'
import { parse } from '../src/parser/index.js'

describe('parser.parse', () => {

  describe('tags', () => {
    it('simple tag', () => {
      const root = parse('<p>hello</p>')
      assert.equal(root.children.length, 1)
      assert.equal(root.children[0].type, 'tag')
      assert.equal(root.children[0].name, 'p')
      assert.equal(root.children[0].children[0].type, 'text')
      assert.equal(root.children[0].children[0].content, 'hello')
    })

    it('self-closing', () => {
      const root = parse('<input />')
      assert.equal(root.children[0].name, 'input')
      assert.equal(root.children[0].children.length, 0)
    })

    it('void tag without explicit close', () => {
      const root = parse('<br>')
      assert.equal(root.children[0].name, 'br')
    })

    it('nested', () => {
      const root = parse('<div><span>x</span></div>')
      assert.equal(root.children[0].name, 'div')
      assert.equal(root.children[0].children[0].name, 'span')
    })
  })

  describe('attributes', () => {
    it('static string', () => {
      const root = parse('<p class="foo">x</p>')
      const attr = root.children[0].attrs[0]
      assert.equal(attr.type, 'static')
      assert.equal(attr.name, 'class')
      assert.equal(attr.val, 'foo')
    })

    it('dynamic {expr}', () => {
      const root = parse('<p title={$name}>x</p>')
      const attr = root.children[0].attrs[0]
      assert.equal(attr.type, 'dynamic')
      assert.equal(attr.name, 'title')
      assert.equal(attr.expr, '$name')
    })

    it('boolean (nom hors allowlist native)', () => {
      const root = parse('<mjs-foo bar/>')
      const attr = root.children[0].attrs[0]
      assert.equal(attr.type, 'boolean')
      assert.equal(attr.name, 'bar')
    })

    it('booléen HTML5 nu → dynamique littéral true', () => {
      // sucre « booléens de props » : sur allowlist MJS_NATIVE_BOOLEAN_ATTRS,
      // un attribut NU devient la liaison `disabled={true}` au lieu du marqueur
      // inerte ci-dessus (couverture complète : native-boolean-attr-shorthand)
      const root = parse('<input disabled>')
      const attr = root.children[0].attrs[0]
      assert.equal(attr.type, 'dynamic')
      assert.equal(attr.name, 'disabled')
      assert.equal(attr.expr, 'true')
    })

    it('spread {...obj}', () => {
      const root = parse('<mjs-info {...$pkg} />')
      const attr = root.children[0].attrs[0]
      assert.equal(attr.type, 'spread')
      assert.equal(attr.expr, '$pkg')
    })

    it('@class{cond}=val', () => {
      const root = parse(`<p @class{$active}="on">x</p>`)
      const attr = root.children[0].attrs[0]
      assert.equal(attr.type, 'static')
      assert.equal(attr.name, '@class{$active}')
      assert.equal(attr.val, 'on')
    })
  })

  describe('expressions', () => {
    it('{$x}', () => {
      const root = parse('{$count}')
      const n = root.children[0]
      assert.equal(n.type, 'expr')
      assert.equal(n.expr, '$count')
      assert.equal(n._is_raw, false)
    })

    it('{{$html}} = raw', () => {
      const root = parse('{{$html}}')
      const n = root.children[0]
      assert.equal(n.type, 'expr')
      assert.equal(n.expr, '$html')
      assert.equal(n._is_raw, true)
    })
  })

  describe('{if}', () => {
    it('simple if', () => {
      const root = parse('{if $x}<p>x</p>{end}')
      const n = root.children[0]
      assert.equal(n.type, 'if')
      assert.equal(n.branches.length, 1)
      assert.equal(n.branches[0].expr, '$x')
      assert.equal(n.branches[0].children[0].name, 'p')
    })

    it('if/else', () => {
      const root = parse('{if $x}<p>a</p>{else}<p>b</p>{end}')
      const n = root.children[0]
      assert.equal(n.branches.length, 2)
      assert.equal(n.branches[1].expr, null)
    })

    it('if/elsif/else', () => {
      const root = parse('{if $a}1{elsif $b}2{else}3{end}')
      const n = root.children[0]
      assert.equal(n.branches.length, 3)
      assert.equal(n.branches[1].expr, '$b')
    })

    // piège JSX/Svelte : `{else if cond}` ne matche NI `{elsif ...}` NI
    // `{else}` (tous deux stricts, cf. ci-dessus) → AVANT ce fix, tombait comme
    // une expression Civet quelconque et explosait très loin de la vraie cause
    // (erreur cryptique parlant d'imports/exports).
    it("{else if cond} (forme JSX/Svelte, n'existe pas en MJS) → erreur dédiée orientant vers {elsif}, PAS une erreur Civet", () => {
      assert.throws(() => parse('{if $a}A{else if $b}B{end}'), /n'existe pas en MJS/)
      try {
        parse('{if $a}A{else if $b}B{end}')
        assert.fail('devait throw')
      } catch (e: any) {
        assert.match(e.message, /elsif/, "l'erreur doit orienter vers la forme correcte {elsif}")
        assert.doesNotMatch(e.message, /import|export/i,
          "AVANT le fix : {else if} partait comme expression Civet nue, erreur cryptique parlant d'imports/exports")
      }
    })
  })

  describe('{for}', () => {
    it('simple', () => {
      const root = parse('{for x in $list}<li>{x}</li>{end}')
      const n = root.children[0]
      assert.equal(n.type, 'for')
      assert.equal(n.item, 'x')
      assert.equal(n.iterable, '$list')
      assert.equal(n.index, 'index')
    })

    it('with index', () => {
      const root = parse('{for i, x in $list}{x}{end}')
      const n = root.children[0]
      assert.equal(n.index, 'i')
      assert.equal(n.item, 'x')
    })

    it('with by clé', () => {
      const root = parse('{for thing in $things by id}{thing.name}{end}')
      const n = root.children[0]
      assert.equal(n.key, 'id')
    })
  })

  describe('{const}', () => {
    it('{const x = 5} → Node const, name x, expr 5', () => {
      const root = parse('{const x = 5}')
      const n = root.children[0]
      assert.equal(n.type, 'const')
      assert.equal(n.name, 'x')
      assert.equal(n.expr, '5')
      // Ne produit AUCUN nœud texte (≠ {expr}).
      assert.equal(root.children.length, 1)
    })

    it('{const t = a.b * c} → expr = "a.b * c"', () => {
      const root = parse('{const t = a.b * c}')
      const n = root.children[0]
      assert.equal(n.type, 'const')
      assert.equal(n.name, 't')
      assert.equal(n.expr, 'a.b * c')
    })

    it('{const} dans un {for} → enfant du for, pas de texte', () => {
      const root = parse('{for ligne in $arr}{const total = ligne.prix * ligne.qte}<td>{total}</td>{end}')
      const forNode = root.children[0]
      assert.equal(forNode.type, 'for')
      const c0 = forNode.children[0]
      assert.equal(c0.type, 'const')
      assert.equal(c0.name, 'total')
      assert.equal(c0.expr, 'ligne.prix * ligne.qte')
    })

    it('EXPR avec objet littéral (accolades imbriquées)', () => {
      const root = parse('{const o = {a: 1, b: 2}}')
      const n = root.children[0]
      assert.equal(n.type, 'const')
      assert.equal(n.name, 'o')
      assert.equal(n.expr, '{a: 1, b: 2}')
    })

    it('rejette un nom réservé', () => {
      assert.throws(() => parse('{const node = 1}'), /NOM RÉSERVÉ/)
    })

    it('rejette une syntaxe sans `=`', () => {
      assert.throws(() => parse('{const x}'), /\{const/)
    })
  })

  describe('{await}', () => {
    it('with success/error', () => {
      const root = parse('{await $p}loading{success n}<p>{n}</p>{error err}<p>{err.message}</p>{end}')
      const n = root.children[0]
      assert.equal(n.type, 'await')
      assert.equal(n.expr, '$p')
      assert.equal(n.branches.length, 3)
      assert.equal(n.branches[0].type, 'pending')
      assert.equal(n.branches[1].type, 'success')
      assert.equal(n.branches[1].arg, 'n')
      assert.equal(n.branches[2].type, 'error')
      assert.equal(n.branches[2].arg, 'err')
    })
  })

  describe('@view / @slot', () => {
    it('<@view app-content> → metamjs-view id="app-content"', () => {
      const root = parse('<@view app-content></@view>')
      const n = root.children[0]
      assert.equal(n.name, 'metamjs-view')
      const attr = n.attrs[0]
      assert.equal(attr.name, 'id')
      assert.equal(attr.val, 'app-content')
    })

    it('<@slot 0> → slot name="0" (identifiant nu = nom littéral)', () => {
      const root = parse('<@slot 0></@slot>')
      const n = root.children[0]
      assert.equal(n.name, 'slot')
      const attr = n.attrs[0]
      assert.equal(attr.name, 'name')
      // Nouveau contrat : nu = littéral (plus de préfixe `mjs-slot-`, plus de
      // magie de scope). Pour un nom évalué/indexé → accolades `<@slot {0}>`.
      assert.equal(attr.val, '0')
    })

    it('<@slot {i}> → slot name="{i}" (accolades = nom dynamique évalué)', () => {
      const root = parse('<@slot {i}></@slot>')
      const n = root.children[0]
      assert.equal(n.name, 'slot')
      const attr = n.attrs[0]
      assert.equal(attr.name, 'name')
      assert.equal(attr.val, '{i}')
    })

    it('<@slot title> → slot name="title" (nom littéral)', () => {
      const root = parse('<@slot title></@slot>')
      const n = root.children[0]
      const attr = n.attrs[0]
      assert.equal(attr.name, 'name')
      assert.equal(attr.val, 'title')
    })
  })

  // généralisation de <@include nom/> (slash final
  // interdit) à <@view> : une vue reçoit TOUJOURS son contenu du routeur,
  // l'auto-fermeture n'a jamais été une forme valide.
  describe('auto-fermeture — <@view> interdite', () => {
    it('<@view/> (bare, self-close collé) → erreur explicite', () => {
      assert.throws(() => parse('<@view/>'), /auto-fermeture interdite/)
    })

    it('<@view app-content /> (avec id, self-close espacé) → erreur explicite', () => {
      assert.throws(() => parse('<@view app-content />'), /auto-fermeture interdite/)
    })

    it('<@view app-content></@view> (fermeture explicite) reste valide (non-régression)', () => {
      assert.doesNotThrow(() => parse('<@view app-content></@view>'))
    })
  })

  // Non-régression EXPLICITE — <@slot/> (idiome légitime SANS
  // contenu de repli) et tout composant personnalisé ordinaire restent
  // VOLONTAIREMENT hors du périmètre de la règle ci-dessus.
  describe('auto-fermeture — non-régression EXPLICITE <@slot/> et composants ordinaires (jamais concernés)', () => {
    it('<@slot/> (self-close, sans nom) reste valide — slot par défaut', () => {
      const root = parse('<@slot/>')
      assert.equal(root.children[0].name, 'slot')
    })

    it('<@slot title/> (self-close AVEC nom) reste valide', () => {
      const root = parse('<@slot title/>')
      assert.equal(root.children[0].name, 'slot')
      assert.equal(root.children[0].attrs[0].val, 'title')
    })

    it('<mon-composant/> (composant personnalisé ordinaire) reste valide', () => {
      const root = parse('<mon-composant/>')
      assert.equal(root.children[0].name, 'mon-composant')
    })

    it('<input/> (balise HTML native void) reste valide', () => {
      assert.doesNotThrow(() => parse('<input/>'))
    })
  })

  describe('erreurs', () => {
    it('unclosed if', () => {
      assert.throws(() => parse('{if $x}<p>x</p>'), /BLOC NON FERMÉ/)
    })

    it('reserved name in for', () => {
      assert.throws(() => parse('{for node in $list}{node}{end}'), /NOM RÉSERVÉ/)
    })
  })

  // ==========================================================================
  // Cas limites du parser : chaque test reproduit un scénario ciblé.
  // ==========================================================================
  describe('parser — cas limites', () => {
    it('fermante orpheline dans {if}/{for}/{await}/{key} : throw, PAS de boucle infinie', () => {
      // Avant : `parseChildren` remontait `close_tag` sans consommer → 100 % CPU.
      assert.throws(() => parse('{if $x}</div>{end}'), /BLOC NON FERMÉ/)
      assert.throws(() => parse('{for x in y}</div>{end}'), /BLOC NON FERMÉ/)
      assert.throws(() => parse('{await $p}</div>{end}'), /BLOC NON FERMÉ/)
      assert.throws(() => parse('{key $k}</div>{end}'), /BLOC NON FERMÉ/)
    })

    it('extractBalanced : un `\\` littéral échappé ne rend plus la chaîne infermable', () => {
      const root = parse("{$path.replace('c:\\\\', '')}<p>fin</p>")
      assert.equal(root.children.length, 2)
      assert.equal(root.children[0].type, 'expr')
      assert.equal(root.children[1].name, 'p')          // le <p> n'est PLUS avalé
    })

    it('`_` dans un nom d\'attribut : data-user_id reste entier (id natif non écrasé)', () => {
      const attrs = parse('<div data-user_id="3" data_plain="x">y</div>').children[0].attrs
      assert.equal(attrs.length, 2)
      assert.equal(attrs[0].name, 'data-user_id')
      assert.equal(attrs[0].val, '3')
      assert.equal(attrs[1].name, 'data_plain')
    })

    it('fermante orpheline au niveau RACINE : throw (plus de markup jeté en silence)', () => {
      assert.throws(() => parse('<header>A</header>\n</div>\n<footer>B</footer>'), /ORPHELINE/)
    })

    it('{key} : expr équilibrée (pas de troncature) + {end} désormais exigé', () => {
      assert.equal(parse('{key f({a:1})}<b>x</b>{end}').children[0].expr, 'f({a:1})')
      assert.throws(() => parse('{key $id}<p>a</p>'), /BLOC NON FERMÉ/)
    })

    it('`</div >` (blanc avant `>`) accepté', () => {
      const n = parse('<div>a</div >').children[0]
      assert.equal(n.name, 'div')
      assert.equal(n.children[0].content, 'a')
    })

    it('`{expr}` nu en position d\'attribut sur un tag ≠ slot : erreur claire', () => {
      assert.throws(() => parse('<div {$cls}>x</div>'), /slot/)
      // sur <@slot> il reste valide (nom de slot évalué)
      assert.equal(parse('<@slot {i}></@slot>').children[0].attrs[0].val, '{i}')
    })

    it('valeur non quotée n\'avale plus le `/` de `/>`', () => {
      const kids = parse('<img src=x/><p>fin</p>').children
      assert.equal(kids[0].attrs[0].val, 'x')
      assert.equal(kids[1].name, 'p')
    })

    it('familles réservées SUFFIXÉES (__arr_0, _nref_x…) rejetées ; nom exact `__arr` libre', () => {
      assert.throws(() => parse('{for __arr_0 in $rows}<li>x</li>{end}'), /NOM RÉSERVÉ/)
      assert.throws(() => parse('{for _nref_x in $rows}<li>x</li>{end}'), /NOM RÉSERVÉ/)
      assert.equal(parse('{for __arr in $rows}<li>x</li>{end}').children[0].item, '__arr')
    })
  })

  // forme NUE d'un raccourci `<@x>` (hors 12 réservées) ouverte SANS `/>` : si AUCUNE
  // fermante ne survient plus loin (comptage équilibré du même nom), la balise devient VOID —
  // même émission que l'autofermant, aucun enfant avalé.
  describe('forme nue <@x> = void quand aucune fermante n\'arrive', () => {
    it('(a) <@card> suivi d\'un frère <p> (jamais de </@card> dans tout le document) : <@card> void, le <p> N\'EST PAS avalé', () => {
      const root = parse('<@card><p>x</p>')
      assert.equal(root.children.length, 2)
      assert.equal(root.children[0].name, 'mjs-card')
      assert.equal(root.children[0].children.length, 0)
      assert.equal(root.children[1].name, 'p')
      assert.equal(root.children[1].children[0].content, 'x')
    })

    it('(b) <@card> void PUIS un couple <@card>…</@card> plus loin : seul le PREMIER reste void', () => {
      const root = parse('<@card><@card>B</@card>')
      assert.equal(root.children.length, 2)
      assert.equal(root.children[0].name, 'mjs-card')
      assert.equal(root.children[0].children.length, 0, 'le premier <@card> reste void')
      assert.equal(root.children[1].name, 'mjs-card')
      assert.equal(root.children[1].children.length, 1)
      assert.equal(root.children[1].children[0].content, 'B')
    })

    it('(c) paire imbriquée même nom <@card>A<@card>B</@card>C</@card> : enfants corrects (nesting inchangé)', () => {
      const root = parse('<@card>A<@card>B</@card>C</@card>')
      assert.equal(root.children.length, 1)
      const outer = root.children[0]
      assert.equal(outer.name, 'mjs-card')
      assert.equal(outer.children.length, 3)
      assert.equal(outer.children[0].content, 'A')
      assert.equal(outer.children[1].name, 'mjs-card')
      assert.equal(outer.children[1].children[0].content, 'B')
      assert.equal(outer.children[2].content, 'C')
    })

    it('(d) <@card>texte</@card> : enfants inchangés (non-régression)', () => {
      const root = parse('<@card>texte</@card>')
      assert.equal(root.children[0].name, 'mjs-card')
      assert.equal(root.children[0].children.length, 1)
      assert.equal(root.children[0].children[0].content, 'texte')
    })

    it('(e) autofermant <@card/> continue de compiler (compat, AUCUN retrait du support)', () => {
      const root = parse('<@card/>')
      assert.equal(root.children[0].name, 'mjs-card')
      assert.equal(root.children[0].children.length, 0)
    })

    // une balise jamais refermée jusqu'à EOF lève désormais
    // « BALISE NON FERMÉE » (garde-fou parser/index.ts) : le cas ci-dessous n'avale plus le
    // <p> en silence jusqu'à EOS, il lève. L'assertion change de forme mais la portée testée
    // reste la MÊME qu'à l'origine : une balise LITTÉRALE (hors raccourci `@`) n'emprunte
    // jamais la sonde void de la forme nue (`willClose`, réservée aux raccourcis) — si elle prenait
    // ce chemin, `parse()` réussirait avec <p> en FRÈRE (comme le cas (a) plus haut), pas en
    // erreur.
    it('portée stricte au RACCOURCI @ (hors 12 réservées) : une balise LITTÉRALE mjs-card sans fermante lève BALISE NON FERMÉE (pas de sonde void, pas d\'avalage silencieux jusqu\'à EOS)', () => {
      assert.throws(() => parse('<mjs-card><p>x</p>'), /BALISE NON FERMÉE/)
    })
  })
})
