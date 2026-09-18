// Tests path tracking compile-time

import assert from 'node:assert/strict'
import * as acorn from 'acorn'
import { applyPathTracking } from '../src/generator/path-tracker.js'
import { transformReactiveWrites } from '../src/generator/transform-reactive.js'

describe('applyPathTracking', () => {

  describe('mutations profondes directes', () => {
    it('$.box.width = 200 → µ._mjs_deepSet', () => {
      const out = applyPathTracking(`$.box.width = 200;`)
      assert.match(out, /µ\._mjs_deepSet\(_mjsThis, \["box", "width"\], 200\)/)
    })

    it('chaîne de profondeur 3+', () => {
      const out = applyPathTracking(`$.deeply.nested.thing = 42;`)
      assert.match(out, /µ\._mjs_deepSet\(_mjsThis, \["deeply", "nested", "thing"\], 42\)/)
    })

    it('ne touche PAS au top-level $.x = y (déjà géré ailleurs)', () => {
      const out = applyPathTracking(`$.count = 5;`)
      assert.equal(out.includes('_mjs_deepSet'), false)
    })
  })

  describe('alias trackés', () => {
    it('let obj = $.box; obj.x = 1 → deepSet via alias', () => {
      const out = applyPathTracking(`let obj = $.box; obj.x = 1;`)
      assert.match(out, /µ\._mjs_deepSet\(_mjsThis, \["box", "x"\], 1\)/)
    })

    it('alias transitif : let a = $.box; let b = a; b.y = 2', () => {
      const out = applyPathTracking(`let a = $.box; let b = a; b.y = 2;`)
      assert.match(out, /µ\._mjs_deepSet\(_mjsThis, \["box", "y"\], 2\)/)
    })
  })

  describe('suppression de clé (delete)', () => {
    it('delete $.obj.clé → µ._mjs_deepDelete', () => {
      const out = applyPathTracking(`delete $.obj.cle;`)
      assert.match(out, /µ\._mjs_deepDelete\(_mjsThis, \["obj", "cle"\]\)/)
    })

    it('top-level delete $.x → µ._mjs_deepDelete (path profondeur 1)', () => {
      const out = applyPathTracking(`delete $.flag;`)
      assert.match(out, /µ\._mjs_deepDelete\(_mjsThis, \["flag"\]\)/)
    })

    it('via alias : let o = $.box; delete o.w', () => {
      const out = applyPathTracking(`let o = $.box; delete o.w;`)
      assert.match(out, /µ\._mjs_deepDelete\(_mjsThis, \["box", "w"\]\)/)
    })

    it('clé dynamique littérale/identifiant : delete $.map[k]', () => {
      const out = applyPathTracking(`delete $.map[k];`)
      assert.match(out, /µ\._mjs_deepDelete\(_mjsThis, \["map", k\]\)/)
    })

    it('ne touche PAS un objet local non tracké : delete local.x', () => {
      const out = applyPathTracking(`let local = {x: 1}; delete local.x;`)
      assert.equal(out.includes('_mjs_deepDelete'), false)
    })
  })

  describe('méthodes mutatives', () => {
    it('$.list.push(item) → µ._mjs_deepCall', () => {
      const out = applyPathTracking(`$.list.push(42);`)
      assert.match(out, /µ\._mjs_deepCall\(_mjsThis, \["list"\], 'push', \[42\]\)/)
    })

    it('$.list.splice(i, 1) avec args multiples', () => {
      const out = applyPathTracking(`$.list.splice(0, 1);`)
      assert.match(out, /µ\._mjs_deepCall\(_mjsThis, \["list"\], 'splice', \[0, 1\]\)/)
    })

    it('$.mySet.add(x) Set mutation', () => {
      const out = applyPathTracking(`$.mySet.add('foo');`)
      assert.match(out, /µ\._mjs_deepCall\(_mjsThis, \["mySet"\], 'add', \['foo'\]\)/)
    })

    it('$.myMap.set(k, v) Map mutation', () => {
      const out = applyPathTracking(`$.myMap.set('k', 'v');`)
      assert.match(out, /µ\._mjs_deepCall\(_mjsThis, \["myMap"\], 'set', \['k', 'v'\]\)/)
    })

    it('via alias : let arr = $.list; arr.push(x)', () => {
      const out = applyPathTracking(`let arr = $.list; arr.push(99);`)
      assert.match(out, /µ\._mjs_deepCall\(_mjsThis, \["list"\], 'push', \[99\]\)/)
    })
  })

  describe('cas non touchés', () => {
    it('lecture pure $.box.x (pas de mutation)', () => {
      const src = `const x = $.box.x;`
      assert.equal(applyPathTracking(src), src)
    })

    it('méthode non-mutative .filter, .map → laisse le Proxy faire', () => {
      const src = `const r = $.list.filter(x => x > 0);`
      assert.equal(applyPathTracking(src).includes('_mjs_deepCall'), false)
    })

    it('code sans $. non touché', () => {
      const src = `const x = 1; foo(x);`
      assert.equal(applyPathTracking(src), src)
    })
  })

  describe('faux alias : méthodes non-mutatives ne créent PAS d\'alias', () => {
    it('const arr = $.data.slice(); arr[0] = 5 → PAS de deepSet', () => {
      const src = `const arr = $.data.slice(); arr[0] = 5;`
      const out = applyPathTracking(src)
      assert.equal(out.includes('_mjs_deepSet'), false,
        'slice() retourne une copie : arr ne doit pas être un alias')
    })

    it('const m = $.list.map(x => x); m[0] = 5 → PAS de deepSet', () => {
      const src = `const m = $.list.map(x => x); m[0] = 5;`
      assert.equal(applyPathTracking(src).includes('_mjs_deepSet'), false)
    })

    it('const f = $.list.filter(x => x > 0); f.push(1) → PAS de deepCall sur list', () => {
      const src = `const f = $.list.filter(x => x > 0); f.push(1);`
      const out = applyPathTracking(src)
      // push sur f ne doit pas être transformé en _mjs_deepCall(_mjsThis, ["list"], 'push', ...)
      assert.equal(out.includes('_mjs_deepCall(_mjsThis, ["list"]'), false)
    })

    it('const c = $.a.concat($.b); c[0] = 1 → PAS de deepSet', () => {
      const src = `const c = $.a.concat($.b); c[0] = 1;`
      assert.equal(applyPathTracking(src).includes('_mjs_deepSet'), false)
    })

    it('const r = $.list.toReversed(); r[0] = 1 → PAS de deepSet', () => {
      const src = `const r = $.list.toReversed(); r[0] = 1;`
      assert.equal(applyPathTracking(src).includes('_mjs_deepSet'), false)
    })

    it('alias en chaîne : const a = $.list; const b = a.slice(); b[0] = 1 → PAS de deepSet sur b', () => {
      const src = `const a = $.list; const b = a.slice(); b[0] = 1;`
      const out = applyPathTracking(src)
      // b ne doit pas remonter à $.list
      assert.equal(out.includes('_mjs_deepSet(_mjsThis, ["list", 0]'), false)
    })

    it('mutation directe sur $.data.slice() reste possible via alias source', () => {
      // contrôle inverse : $.data.push(x) reste tracké
      const src = `$.data.push(99);`
      assert.match(applyPathTracking(src), /µ\._mjs_deepCall\(_mjsThis, \["data"\], 'push'/)
    })
  })

  describe('robustesse', () => {
    it('JS invalide → retourne tel quel', () => {
      const src = `this is not valid !!!`
      assert.equal(applyPathTracking(src), src)
    })
  })

  // Sûreté du TAINT : un alias ne doit PAS être suivi quand son
  // nom est shadowé/réassigné/déstructuré — sinon une mutation locale était
  // émise comme µ._mjs_deepSet sur le STATE (corruption silencieuse).
  describe('taint — ne pas corrompre le state via un homonyme local', () => {
    it('paramètre de fonction shadowant un alias → PAS de _mjs_deepSet', () => {
      const out = applyPathTracking(`const box = $.box; function f(box){ box.x = 1 }`)
      assert.doesNotMatch(out, /_mjs_deepSet/)
    })
    it('paramètre de callback (forEach) shadowant → PAS de _mjs_deepSet', () => {
      const out = applyPathTracking(`const row = $.row; $.items.forEach((row) => { row.sel = true })`)
      assert.doesNotMatch(out, /row.*sel.*_mjs_deepSet|_mjs_deepSet.*\["row"/)
    })
    it('réassignation nue de l\'alias (t = {}) → PAS de _mjs_deepSet ensuite', () => {
      const out = applyPathTracking(`let t = $.box; t = {}; t.x = 1`)
      assert.doesNotMatch(out, /_mjs_deepSet/)
    })
    it('déstructuration const {items} = $.data → PAS d\'alias suivi', () => {
      const out = applyPathTracking(`const { items } = $.data; items.push(5)`)
      assert.doesNotMatch(out, /_mjs_deepCall|_mjs_deepSet/)
    })
    it('clé littérale "__dyn:…" reste une STRING quotée (pas du code injecté)', () => {
      // L'ancien préfixe string __dyn: était forgeable : `p.slice(6)` émettait
      // `alert(1)` SANS quotes → exécution. Le marqueur OBJET {dyn} corrige :
      // une clé Literal n'est jamais un segment dynamique → JSON.stringify.
      const out = applyPathTracking(`$.obj["__dyn:alert(1)"].x = 1`)
      assert.match(out, /"__dyn:alert\(1\)"/)       // string quotée = sûre
      assert.doesNotMatch(out, /,\s*alert\(1\)\s*,/) // PAS d'expression nue exécutable
    })
    it('le vrai alias non-shadowé reste suivi (non-régression)', () => {
      const out = applyPathTracking(`const box = $.box; box.width = 9`)
      assert.match(out, /µ\._mjs_deepSet\(_mjsThis, \["box", "width"\], 9\)/)
    })
  })

  // Édits de bordure MagicString : une transformation imbriquée dans le RHS
  // doit survivre (avant : le RHS était recopié depuis le source original).
  describe('édits de bordure (mutation imbriquée dans le RHS)', () => {
    it('$.a.b = ($.c.d = 5) → les DEUX deepSet émis', () => {
      const out = applyPathTracking(`$.a.b = ($.c.d = 5)`)
      assert.match(out, /_mjs_deepSet\(_mjsThis, \["a", "b"\]/)
      assert.match(out, /_mjs_deepSet\(_mjsThis, \["c", "d"\], 5\)/)
    })
  })

  // Un alias capturé sur
  // un index DYNAMIQUE (`it = $.list[i]`) ne doit JAMAIS être tracké — le path
  // stocké garde le NOM de la variable (`{dyn:'i'}`), réinjecté tel quel
  // (identifiant nu) dans CHAQUE usage futur de l'alias. Si `i` change entre
  // la capture et l'usage (`i++` typiquement dans une boucle), `_mjs_deepSet`
  // réévalue `i` APRÈS coup → mute le MAUVAIS élément (corruption silencieuse,
  // AUCUNE erreur). Sans alias tracké, `it` reste la valeur brute captée à la
  // lecture — déjà un Proxy vivant (identité figée) posé par le runtime
  // (`_mjs_wrapDeep`), qui mute et notifie correctement le BON élément peu importe
  // l'évolution ultérieure de `i`. Seul l'ALIASING d'un index dynamique est
  // désactivé : un accès direct non aliasé reste tracké (aucun décalage
  // temporel possible, `i` y est lu au même endroit que l'original).
  describe('alias à index DYNAMIQUE : jamais tracké', () => {
    it("répro exacte : it=$.list[i]; i++; it.x=1 → PAS de _mjs_deepSet (le Proxy du filet mute le bon élément)", () => {
      const out = applyPathTracking(`let it = $.list[i]; i++; it.x = 1;`)
      assert.equal(out.includes('_mjs_deepSet'), false,
        "AVANT le fix : émettait _mjs_deepSet(_mjsThis, ['list', i, 'x'], 1) — " +
        "'i' réévalué APRÈS i++, mutation du MAUVAIS élément de la liste")
    })

    it('alias à index dynamique + mutation directe (sans i++) : toujours PAS de _mjs_deepSet (cohérence, pas de tracking à moitié)', () => {
      const out = applyPathTracking(`let it = $.list[i]; it.x = 1;`)
      assert.equal(out.includes('_mjs_deepSet'), false)
    })

    it('alias à index dynamique + méthode mutative : PAS de _mjs_deepCall', () => {
      const out = applyPathTracking(`let it = $.list[i]; it.push(1);`)
      assert.equal(out.includes('_mjs_deepCall'), false)
    })

    it('alias à index dynamique + delete : PAS de _mjs_deepDelete', () => {
      const out = applyPathTracking(`let it = $.list[i]; delete it.x;`)
      assert.equal(out.includes('_mjs_deepDelete'), false)
    })

    it('accès DIRECT (non aliasé) à index dynamique : reste tracké normalement (pas de régression — aucun décalage temporel possible)', () => {
      const out = applyPathTracking(`$.list[i].x = 1;`)
      assert.match(out, /µ\._mjs_deepSet\(_mjsThis, \["list", i, "x"\], 1\)/)
    })

    it('alias à index STATIQUE (littéral) : reste tracké normalement (seul le DYNAMIQUE est concerné)', () => {
      const out = applyPathTracking(`let it = $.list[0]; it.x = 1;`)
      assert.match(out, /µ\._mjs_deepSet\(_mjsThis, \["list", 0, "x"\], 1\)/)
    })

    it('alias transitif VIA un alias à index dynamique : la chaîne entière reste non trackée', () => {
      const out = applyPathTracking(`let row = $.list[i]; let cell = row.cells; cell.value = 5;`)
      assert.equal(out.includes('_mjs_deepSet'), false)
    })
  })

  // Bug d'intégration : le store
  // (`µ.store.x`, origine 'store') n'a AUCUN filet Proxy contrairement au state
  // LOCAL (`_mjs_wrapDeep` intercepte une mutation profonde en place même sans
  // réécriture ici). `µ.store.obj.a += 1` généré tel quel (branche compound
  // sautée sans distinction d'origine) mutait donc en silence, zéro
  // notification — prouvé en montant un composant réel (DOM figé, valeur
  // brute progressant quand même). Fixé : compound/update expandés en
  // lecture+`_mjs_storeDeepSet` explicite, UNIQUEMENT pour l'origine 'store'
  // ('local' reste skip, son filet marche déjà).
  describe('store ($$) — compound/update sur chemin profond', () => {
    it('µ.store.obj.a += 1 (depth 2) → µ._mjs_storeDeepSet, PAS de mutation en place non notifiée', () => {
      const out = applyPathTracking(`µ.store.obj.a += 1;`)
      assert.match(out, /µ\._mjs_storeDeepSet\("obj", \["a"\], µ\.store\.obj\.a \+ \(1\)\)/)
      assert.equal(/µ\.store\.obj\.a \+= 1/.test(out), false, 'plus de += brut résiduel')
    })

    it('µ.store.a.b.c -= 5 (depth 3)', () => {
      const out = applyPathTracking(`µ.store.a.b.c -= 5;`)
      assert.match(out, /µ\._mjs_storeDeepSet\("a", \["b", "c"\], µ\.store\.a\.b\.c - \(5\)\)/)
    })

    it('`µ.store.x = v` top-level (depth 1) → µ._storeSet, plus l\'accesseur natif seul (cas limite : _mjs_storeDelete peut le rendre plat)', () => {
      const out = applyPathTracking(`µ.store.x = 5;`)
      assert.match(out, /µ\._storeSet\("x", 5\)/)
    })

    it('`µ.store.x += 1` top-level (depth 1) → µ._storeSet(key, lecture + rhs), PAS de _mjs_storeDeepSet', () => {
      const out = applyPathTracking(`µ.store.x += 1;`)
      assert.match(out, /µ\._storeSet\("x", µ\.store\.x \+ \(1\)\)/)
      assert.equal(out.includes('_mjs_storeDeepSet'), false)
    })

    it('`µ.store.flag ||= true` top-level : court-circuit natif préservé (baseOp = vrai opérateur JS)', () => {
      const out = applyPathTracking(`µ.store.flag ||= true;`)
      assert.match(out, /µ\._storeSet\("flag", µ\.store\.flag \|\| \(true\)\)/)
    })

    it('`µ.store.x++`/`--µ.store.x` top-level → µ._storeSet, fidélité pré/postfixe', () => {
      const outPost = applyPathTracking(`y = µ.store.x++;`)
      assert.match(outPost, /\(\(_v\) => \(µ\._storeSet\("x", _v \+ 1\), _v\)\)\(µ\.store\.x\)/)
      const outPre = applyPathTracking(`y = --µ.store.x;`)
      assert.match(outPre, /\(µ\._storeSet\("x", µ\.store\.x - 1\), µ\.store\.x\)/)
    })

    it('µ.store.obj.a++ (postfix, depth 2) → _mjs_storeDeepSet + valeur ANCIENNE retournée', () => {
      const out = applyPathTracking(`x = µ.store.obj.a++;`)
      assert.match(out, /\(_v\) => \(µ\._mjs_storeDeepSet\("obj", \["a"\], _v \+ 1\), _v\)/)
    })

    it('++µ.store.obj.a (prefix, depth 2) → _mjs_storeDeepSet + valeur NOUVELLE retournée', () => {
      const out = applyPathTracking(`y = ++µ.store.obj.a;`)
      assert.match(out, /µ\._mjs_storeDeepSet\("obj", \["a"\], µ\.store\.obj\.a \+ 1\), µ\.store\.obj\.a\)/)
    })

    it('compound sur alias LOCAL profond ($.box.width += 1) : toujours SKIP (filet Proxy _mjs_wrapDeep suffisant, non-régression)', () => {
      const out = applyPathTracking(`$.box.width += 1;`)
      assert.equal(out.includes('_mjs_deepSet'), false)
      assert.match(out, /\$\.box\.width \+= 1/, 'laissé brut, le Proxy runtime intercepte')
    })
  })

  // Sûreté du TAINT — réassignation PAR MOTIF (`[t] = […]`, `({t} = o)`) : avant
  // le fix, seule la réassignation NUE (`t = {}`) taintait l'alias — un motif de
  // gauche laissait l'ancien path dans aliasMap, une mutation suivante réécrivait
  // dans le MAUVAIS emplacement d'état.
  describe('réassignation par motif — alias périmé', () => {
    it('[box] = [{}] (ArrayPattern) → PAS de _mjs_deepSet après réassignation', () => {
      const out = applyPathTracking(`let box = $.box; [box] = [{}]; box.w = 1;`)
      assert.doesNotMatch(out, /_mjs_deepSet/)
    })

    it('({box} = {box: {}}) (ObjectPattern) → PAS de _mjs_deepSet après réassignation', () => {
      const out = applyPathTracking(`let box = $.box; ({box} = {box: {}}); box.w = 1;`)
      assert.doesNotMatch(out, /_mjs_deepSet/)
    })

    it('[box = {}] = [] (AssignmentPattern) → PAS de _mjs_deepSet après réassignation', () => {
      const out = applyPathTracking(`let box = $.box; [box = {}] = []; box.w = 1;`)
      assert.doesNotMatch(out, /_mjs_deepSet/)
    })

    it('[[box]] = [[{}]] (motif imbriqué) → PAS de _mjs_deepSet après réassignation', () => {
      const out = applyPathTracking(`let box = $.box; [[box]] = [[{}]]; box.w = 1;`)
      assert.doesNotMatch(out, /_mjs_deepSet/)
    })

    it('témoin : réassignation nue (sans motif) reste trackée normalement', () => {
      const out = applyPathTracking(`let box = $.box; box.w = 1;`)
      assert.match(out, /µ\._mjs_deepSet\(_mjsThis, \["box", "w"\], 1\)/)
    })

    it('témoin : une cible MEMBRE dans le motif ([$.a] = [1]) ne taint pas box', () => {
      const out = applyPathTracking(`let box = $.box; [$.a] = [1]; box.w = 1;`)
      assert.match(out, /µ\._mjs_deepSet\(_mjsThis, \["box", "w"\], 1\)/)
    })
  })

  // Une AssignmentExpression dont `left` est un motif
  // (ArrayPattern/ObjectPattern) CIBLANT LE STORE échappait à la garde
  // MemberExpression du visiteur AssignmentExpression : `[$$a, $$b] = [$$b,
  // $$a]` (compilé `[µ.store.a, µ.store.b] = [µ.store.b, µ.store.a]`) mutait
  // l'accesseur natif À NU, aucun `µ._storeSet`, aucune notification. Panne
  // réelle : `delete $$a` PUIS, dans le MÊME handler,
  // `[$$a, $$b] = [$$b, $$a]` — l'accesseur de `a` vient d'être supprimé, la
  // lecture RHS `µ.store.a` rend `undefined`, ce `undefined` s'écrit dans `b`
  // (notifié via l'accesseur natif de `b`, encore vivant : `b` perd sa valeur
  // en silence) et `a` redevient une propriété PLATE (plus jamais notifiée —
  // le trou déjà corrigé plus haut revient par cette porte). Même patron
  // que le motif LOCAL de transform-reactive.ts — nommage `_mjsS*`/`_mjsSR`
  // DIFFÉRENT pour ne jamais collisionner sur un motif MIXTE.
  describe('écriture par motif sur le store', () => {
    it('tableau : [µ.store.a, µ.store.b] = [µ.store.b, µ.store.a] émet les deux _storeSet, forme void, parse OK', () => {
      const out = applyPathTracking(`[µ.store.a, µ.store.b] = [µ.store.b, µ.store.a];`)
      assert.match(out, /µ\._storeSet\("a", _mjsS0\)/)
      assert.match(out, /µ\._storeSet\("b", _mjsS1\)/)
      assert.ok(out.startsWith('void ((_mjsSR)'), out)
      assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
    })

    it('objet : ({a: µ.store.a} = o) émet un _storeSet, parse OK', () => {
      const out = applyPathTracking(`({a: µ.store.a} = o);`)
      assert.match(out, /µ\._storeSet\("a", _mjsS0\)/)
      assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
    })

    it('profond : [µ.store.o.k] = [1] → _mjs_storeDeepSet, parse OK', () => {
      const out = applyPathTracking(`[µ.store.o.k] = [1];`)
      assert.match(out, /µ\._mjs_storeDeepSet\("o", \["k"\], _mjsS0\)/)
      assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
    })

    it('position VALEUR (return) : pas de void, la valeur du motif se propage', () => {
      const out = applyPathTracking(`function f() { return [µ.store.a] = xs }`)
      assert.ok(!out.includes('void ('), out)
      assert.match(out, /return _mjsSR/)
      assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
    })

    it('motif mixte, APRÈS transformReactiveWrites : les deux réécritures cohabitent, parse OK', () => {
      const step1 = transformReactiveWrites(`[$.a, µ.store.b] = [1, 2];`)
      const out   = applyPathTracking(step1)
      assert.match(out, /µ\._set\(_mjsThis, 'a', _mjsD0\)/)
      assert.match(out, /µ\._storeSet\("b", _mjsS0\)/)
      assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
    })

    it('motif sans store : sortie strictement identique à l\'entrée', () => {
      const src = `[x, y] = [y, x];`
      assert.equal(applyPathTracking(src), src)
    })
  })
})
