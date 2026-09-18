# 18 · Pièges & bonnes pratiques

> 📚 Pas de chapitre de tuto unique : cette page est une **synthèse** des pièges récurrents, croisés à travers tout le parcours. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Chaque piège est présenté **symptôme → cause → solution**. La plupart viennent de la nature **compile-time** de MJS (la réactivité et le rendu sont résolus à la compilation, pas par un Proxy au runtime) ou des idiomes du langage **Civet**.

## 1. Réactivité statique — un `$` caché dans une fonction

**Symptôme** : un affichage ne se met pas à jour alors que la donnée a changé. Le binding semble correct, mais reste figé sur sa valeur de départ.

**Cause** : MJS détecte les dépendances réactives par **analyse statique** du binding — il lit les `$x` qui apparaissent **directement** dans l'expression. Un `$x` lu *à l'intérieur* d'une fonction appelée par le binding n'est **pas** vu : l'effet est alors classé « mount-only » (joué une fois au montage, jamais re-déclenché).

```html
<script>
  $hidden = 1
  compute = -> $hidden * 2     # $hidden lu DANS la fonction → invisible au compilateur
</script>

<!-- ✗ figé : {compute()} ne dépend (visiblement) d'aucun $ → mount-only -->
<p>{compute()}</p>

<!-- ✓ : $hidden apparaît en clair dans le binding → tracké -->
<p>{compute($hidden)}</p>
```

**Solution** : faites apparaître le `$` **en clair** dans le binding (en l'argument), ou utilisez une **valeur dérivée** `$resultat = compute($hidden)` (le dérivé, lui, voit le `$hidden` qu'il lit). La règle : *ce que le binding doit suivre doit être lisible dans le binding*.

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi MJS ne « regarde pas dans » la fonction&nbsp;?</summary>

D'autres frameworks enveloppent vos données dans un Proxy et notent *au moment de l'exécution* quelle donnée a été lue. MJS, lui, fait ce travail **à la compilation** : il lit le texte de votre binding et y repère les `$`. C'est ce qui le rend rapide (zéro surcoût au runtime).

Le revers : il ne peut voir que ce qui est **écrit dans le binding**. Si la donnée réactive est planquée dans le corps d'une fonction, le compilateur ne la « voit » pas et ne sait pas qu'il faut rafraîchir quand elle change. D'où la règle : montrez-lui le `$`.

</details>

## 2. Mutation imbriquée échappée — objet qui « sort » de la portée trackée

**Symptôme** : `$todos[0].fait = true` re-rend normalement le `{for}` (réactivité profonde, path-tracking compile-time) — mais une mutation faite **après que l'objet a transité par une fonction externe non trackée**, ou sur un **alias réassigné**, ne déclenche rien.

**Cause** : MJS suit à la **compilation** les alias de `$x` dans la portée du `<script>` et réécrit chaque mutation profonde reconnue en appel direct au runtime (`µ._mjs_deepSet`/`µ._mjs_deepCall`) — pas de Proxy sur le chemin nominal. Le suivi est délibérément **conservateur** : un nom devient « intraçable » (jamais traité comme alias) s'il est réassigné en dur (`t = {}`), paramètre de fonction, ou déclaré plus d'une fois — perdre le tracking d'un alias réassigné est préférable à corrompre l'état. Pour les échappements courants (appel de fonction externe, `.push` d'un alias…), le compilateur pose automatiquement un **Proxy ciblé** de secours à la frontière — la réactivité reste donc préservée dans l'immense majorité des cas, y compris échappés.

```html
<script>
  $todos = [{ fait: false, texte: 'a' }]

  # ✓ réactif — alias direct, suivi à la compilation :
  cocher = -> $todos[0].fait = true

  # ⚠️ cas limite — alias RÉASSIGNÉ en dur avant mutation :
  cochePeutEtreRatee = ->
    t = $todos[0]
    t = { ...t }        # réassignation nue → `t` devient intraçable
    t.fait = true        # ne notifie PAS (mutation sur une copie détachée, de toute façon)
</script>

<ul>{for t in $todos}<li>{t.texte} — {t.fait}</li>{end}</ul>
```

**Solution** : dans le doute (alias qui transite par un helper externe complexe, structure de contrôle inhabituelle), **réaffecte la variable racine** (`$todos = $todos.map(...)`) — la réassignation est toujours reconnue sans ambiguïté. Pour une donnée que tu remplaces *systématiquement* en bloc plutôt que de muter, utilise `µraw` ([État brut](11-etat-brut.md)) — c'est la seule forme d'état où la réaffectation est **obligatoire**, jamais suivie même en profondeur.

## 3. Nommage des fichiers — kebab-case obligatoire

**Symptôme** : un composant ne s'affiche pas, aucune erreur claire — la balise `<mjs-...>` reste vide ou non définie.

**Cause** : l'autoloader résout `<mjs-mon-composant>` vers le fichier `mon-composant.mjs` via une clé **mise en minuscules**. Un fichier nommé en camelCase (`MonComposant.mjs`, `monComposant.mjs`) produit une clé qui ne correspond plus au tag attendu → l'autoloading échoue **silencieusement**.

**Solution** : nommez **tous** les fichiers composants en **kebab-case minuscule**.

```
✓ mon-composant.mjs     → <mjs-mon-composant>
✓ card-item.mjs         → <mjs-card-item>
✗ MonComposant.mjs      (casse cassée, non trouvé)
✗ monComposant.mjs      (idem)
```

## 4. Idiomes Civet — interpolation et constructeur

Le `<script>` d'un composant est écrit en **Civet** (dialecte proche de Coffee/TypeScript). Deux écueils fréquents :

**Interpolation** — utilisez `"#{expr}"` (style Coffee) : c'est la **convention maison**, à préférer aux backticks template-literal JS (qui compilent aussi, mais sortent du style Coffee — cf. l'encart débutant ci-dessous) :

```html
<script>
  # ✓ convention maison :
  message = "Bonjour #{$nom}, #{$age} ans"
  # ✓ compile et fonctionne aussi, mais DÉCONSEILLÉ (hors convention) : message = `Bonjour ${$nom}`
</script>
```

**Constructeur** — écrivez `constructor(args)` **explicitement**. Le raccourci `@(args)` (assignation automatique des arguments) **n'existe pas** ici :

```html
<script>
  class Box
    # ✓ correct :
    constructor(width, height)
      @width  = width
      @height = height
    # ✗ n'existe pas : @(width, height)
</script>
```

> ⚠️ Rappel de style : dans le code MJS, on utilise la flèche **`->`** (style Coffee) ; `=>` n'est réservé qu'aux cas où la liaison de `this` est nécessaire (typiquement un `µeffect` qui doit toucher le composant via `@`).

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi pas les backticks, j'en fais en JS&nbsp;?</summary>

En JavaScript moderne, on écrit `` `Bonjour ${nom}` `` avec des accents graves (backticks) et `${...}`. C'est l'habitude, mais le `<script>` MJS n'est **pas** du JS : c'est du Civet, qui suit la tradition CoffeeScript. Là, l'interpolation se note `"#{...}"` à l'intérieur de guillemets normaux.

Les backticks compilent en réalité tout aussi bien (Civet les laisse passer tel quel, `${...}` y fonctionne normalement, sigils `$var` compris) — ce n'est donc **pas** une erreur de compilation. Mais la convention de ce projet reste `"#{...}"`, pour rester dans l'esprit CoffeeScript et cohérent avec le reste du code MJS. Réflexe à prendre : guillemets `"…"` + `#{…}`, même si `` `${...}` `` fonctionnerait aussi.

</details>

## 5. Footguns de cast — la position du suffixe compte

**Symptôme** : tu places le suffixe de cast après le `=!` → **le compilateur s'arrête** avec un message clair : *« Liaison two-way mal formée… le suffixe va sur le NOM de l'attribut »*.

**Cause** : le suffixe de cast doit être collé **au nom de l'attribut**, *avant* `=!`. Placé après le `=!`, il ne fait pas partie d'une liaison valide.

```html
<!-- ✓ correct — le cast est sur le NOM, avant =! -->
<input type="range" value.number=!{$stiffness} min="0" max="1" step="0.01">
<input type="checkbox" checked.bool=!{$accepte} />

<!-- ✗ erreur de compilation — suffixe de cast mal placé (après le =!) -->
<input value=!.number{$stiffness}>
```

**Solution** : écrivez le suffixe **sur le nom de l'attribut** : `value.number=!{$n}`, `checked.bool=!{$ok}`. Casts disponibles : `.number`, `.int`, `.float`, `.string`, `.bool` (alias `.boolean`).

> 💡 Sans cast, un `value=!{$x}` two-way renvoie toujours une **chaîne** (la valeur d'un `<input>` l'est nativement). Pour un nombre, `value.number=!{$x}` est quasi toujours ce que vous voulez sur un `type="number"`/`type="range"`.

## 6. Auto-derived — une seule expression

**Symptôme** : une valeur dérivée censée se recalculer ne réagit pas, ou le compilateur ne la reconnaît pas comme dérivé.

**Cause** : un `$y = ...` au niveau racine du `<script>` ne devient un **dérivé automatique** que si sa partie droite est **une seule expression**. Un bloc `if/else` multi-lignes n'est pas auto-dérivé.

```html
<script>
  $n = 5
  # ✓ dérivé auto (une expression, ternaire) :
  $parite = if $n % 2 == 0 then 'pair' else 'impair'
  # ✗ pas auto-dérivé (bloc multi-instructions) :
  #   $label =
  #     if $n > 10
  #       msg = 'grand'
  #       msg.toUpperCase()
  #     else 'petit'
</script>
```

**Solution** : ramenez le calcul à **une expression** (ternaire, appel de fonction pure). Si plusieurs instructions sont vraiment nécessaires, passez par un **`µeffect`** qui écrit dans le `$` cible.

> 🔗 Voir [Réactivité](03-reactivite.md) pour les valeurs dérivées et `µeffect`.

## 7. `@font-face` / `@import` dans le `<style>` d'un composant

**Symptôme** : la police déclarée ne s'affiche jamais (repli silencieux sur la police système), ou une feuille externe `@import`-ée ne s'applique jamais — dans les deux cas, **aucune erreur**, aucun avertissement dans la console du navigateur.

**Cause** : le `<style>` d'un composant est compilé puis adopté en `adoptedStyleSheets` sur son **Shadow DOM** — une feuille *construite*. Une feuille construite **ignore** ses propres `@import` (interdits par le navigateur dans ce type de feuille), et un `@font-face` déclaré dans une feuille shadow **n'enregistre jamais** la police (limite navigateur). Le composant continue de fonctionner, juste sans la police ou la feuille attendue.

```html
<!-- ✗ n'enregistre jamais la police, aucune erreur -->
<style>
  @font-face { font-family: 'Ma Police'; src: url(µasset('fonts/x.woff2')) }
  :host { font-family: 'Ma Police', sans-serif }
</style>
```

**Solution** : déclarez `@font-face` (ou la feuille externe) au niveau **document**, via `<@head>` — son contenu échappe au Shadow DOM :

```html
<@head>
  <style>
    @font-face { font-family: 'Ma Police'; src: url(µasset('fonts/x.woff2')) format('woff2') }
  </style>
</@head>

<style>
  :host { font-family: 'Ma Police', sans-serif }
</style>
```

Feuille externe (Google Fonts…) : même principe, avec un `<link>` au lieu d'un `@font-face` — `<@head><link rel="stylesheet" href="…"></@head>`.

> 💡 Le compilateur détecte lui-même un `@font-face`/`@import` oublié dans le `<style>` d'un composant et pousse un **warning de compile** (non-fatal, le build continue) qui pointe vers cet idiome — plus besoin de le découvrir à l'usage.

> 🔗 Voir [Éléments spéciaux](15-elements-speciaux.md) — section `<@head>` — pour l'idiome complet (`µasset`, dédup navigateur, feuilles externes).

## 8. Outils de débogage — `µdebug`, `µinspect`, `µ.debugMode`

Trois outils, tous **dev-only** (aucun ne doit rester dans du code livré tel quel — les appels `µdebug`/`console.*` sont retirés à la minification en prod) :

**`µdebug $x`** — point d'arrêt **réactif** : sucre pur, réécrit en effet qui `console.log` la valeur **et** pose un `debugger;` à **chaque** changement de `$x`.

```html
<script>
  µdebug $count   # à chaque changement de $count : log + pause debugger
</script>
```

**`µinspect $x`** — appelé à l'initialisation du composant, active un suivi console (`console.group`) qui affiche **From**/**To** à chaque mutation de `$x`, y compris les mutations profondes (`_mjs_deepSet`/`_mjs_deepCall`) — pratique pour traquer *où* une valeur change sans poser de `debugger` qui bloque l'exécution.

```html
<script>
  µinspect $todos   # chaque mutation de $todos loggée (avant/après), sans pause
</script>
```

**`µ.debugMode`** (booléen, `false` par défaut — se met à `true` depuis la console du navigateur) active une **télémétrie visuelle** : chaque composant qui se re-rend est brièvement entouré (outline vert, ~300&nbsp;ms) — utile pour repérer à l'œil les re-rendus superflus. `µ.instances` (un `Set`) recense, en mode introspection, toutes les instances de composants MJS actuellement montées dans la page.

> 💡 Dans les DevTools du navigateur, les instances de composants (`<mjs-…>`) s'affichent avec un **formatter personnalisé** : `console.log(el)` sur un élément MJS déplie directement son état réactif (`_state`), ses nœuds DOM référencés et ses props/masques — sans avoir à naviguer `el._state` à la main.

## 9. `isnt` — identifiant réservé (opérateur Coffee/Civet)

**Symptôme** : `ParseError` Civet cryptique à la compilation (par exemple *« Found: "not" »*), sans rapport apparent avec le code écrit.

**Cause** : `isnt` est un opérateur Coffee/Civet (`a isnt b` → `a !== b`) — la pré-passe qui le convertit en `is not` réécrit le **texte**, aveuglément. Un `isnt` utilisé comme **identifiant** (`isnt = 5`, `$isnt`) est donc mangé de la même façon (`isnt = 5` devient `is not = 5`) avant même d'atteindre Civet.

```html
<script>
  # ✗ identifiant réservé — erreur de compilation explicite :
  isnt = 5
  $isnt = 5

  # ✓ usage OPÉRATEUR — jamais concerné :
  actif = etat isnt 'ferme'
</script>
```

**Solution** : MJS refuse ces deux formes à la compilation (message explicite qui cite `isnt` et précise « identifiant réservé ») — renommez (`isnt_`, `estPas`…). L'opérateur `a isnt b` reste, lui, disponible sans restriction.

> 💡 Piège voisin (même mécanisme d'auto-déclaration du `<script>`) : `x =` avec le membre droit à la ligne **suivante** n'est jamais promu en déclaration — seule la même ligne que le `=` est reconnue ; Civet compile alors une réassignation à un nom jamais déclaré, et MJS lève l'erreur pédagogique habituelle (« Utilise `x := …` ») — gardez le membre droit sur la même ligne que `=`.

## 10. `$`, `$$`, `µ`, `§`, `§§` — jamais comme nom de variable

**Symptôme** : une mutation censée toucher un élément (ou tout autre objet passé en paramètre) reste sans effet — **aucune erreur**, le build passe, rien ne bouge à l'écran. Ou bien une erreur de syntaxe cryptique du compilateur sous-jacent, sans rapport apparent avec le composant.

**Cause** : `$` (état du composant), `$$` (store), `µ` (runtime), `§` (contexte figé) et `§§` (contexte réactif) sont des symboles du framework. Un paramètre ou une variable qui porte le **même nom** que `$`/`$$`/`µ` masque le symbole dans tout le corps qui suit — le compilateur ne peut alors plus distinguer une vraie mutation d'état d'un accès à ce paramètre : les deux s'écrivent `$.xxx`. `§` et `§§`, eux, s'écrivent toujours suivis d'un nom (`§theme`, `§§count`) — utilisés seuls, ils ne forment aucun sucre reconnu et atteignent le compilateur sous-jacent tels quels.

```html
<script>
  $style = { color: 'black' }
  # ✗ le paramètre $ masque l'état — $.style.color part dans $style, pas dans l'élément voulu
  paint = ($) ->
    $.style.color = 'red'
</script>
```

**Solution** : le build refuse un paramètre, une variable, un import ou une écriture nue qui s'appellerait `$`, `$$` ou `µ` (message qui cite le nom et la ligne fautive), et refuse tout autant un `§`/`§§` isolé, non suivi d'un nom (message qui cite le symbole) — renommez (`el` pour un élément du DOM, `§theme`/`§§count` pour un contexte, par exemple). Le même refus couvre la variable et l'index d'un `{for}` (et tout autre nom introduit par le template — `{const}`, argument de `{success}`/`{error}`) : `{for $ in $list}` est refusé au même titre qu'un paramètre `$` dans le `<script>`.

```html
<script>
  $style = { color: 'black' }
  # ✓ el ne collisionne avec rien
  paint = (el) ->
    el.style.color = 'red'
</script>
```

---

📚 **Apprendre en pratiquant** : ces pièges n'ont pas de chapitre dédié — ils se rencontrent au fil des **34 chapitres du tuto interactif**. Gardez cette page sous la main comme aide-mémoire de débogage.
