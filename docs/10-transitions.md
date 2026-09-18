# 10 · Transitions & animations

> 📚 Tuto interactif correspondant : **Transitions** (directive, paramètres, in/out, CSS & JS, événements, global), **Animation** (interpolations, ressorts) et **Transitions avancées** (transitions différées, cross-fade, `@flip`). Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

MJS anime un élément quand il **entre** ou **sort** du DOM (au gré d'un `{if}`, d'un `{for}`, d'un `{key}`). Les directives sont déclaratives : on les pose sur l'élément, MJS joue l'animation aux bons moments et la nettoie tout seul.

> 💡 Ici, on anime des **éléments** (`@transition`, entrée/sortie d'un nœud). Pour animer un changement de **page** (la permutation des vues du routeur), c'est `@viewTransition` → [17 · Router](17-router.md).

## La directive `@transition`

`@transition.nom` joue l'animation **à l'entrée et à la sortie** (symétrique). Les animations intégrées (`fade`, `fly`, `slide`, `scale`, `blur`, `draw`… et les effets de vue `iris`, `bars`…) se nomment après le point.

```html
<script>
  $visible = true
</script>

<label>
  <input type="checkbox" checked=!{$visible} /> visible
</label>

{if $visible}
  <p @transition.fade>
    Apparaît et disparaît en fondu
  </p>
{end}
```

> ⚠️ Une transition ne se joue que sur un élément qui **entre ou sort** réellement du DOM. Un élément déjà présent au montage n'anime rien : il faut le révéler/masquer via `{if}`, `{for}`, ou `{key}`.

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi un <code>{if}</code> autour&nbsp;?</summary>

Une transition d'entrée/sortie a besoin d'un *avant* et d'un *après* : l'élément doit naître ou mourir pour qu'il y ait quelque chose à animer. Le `{if $visible}` est ce qui le fait apparaître/disparaître ; la directive `@transition.fade` ne fait qu'habiller ce passage. Sans bloc conditionnel autour, l'élément reste là en permanence et il n'y a rien à animer.

</details>

## Paramètres

On passe un objet de paramètres entre accolades. Les clés courantes : `duration` (ms), `delay` (ms), `easing`, plus les paramètres propres à chaque animation (`y`/`x` pour `fly`, etc.).

```html
{if $visible}
  <p @transition.fly={ y: 200, duration: 2000 }>
    Vole en entrant et en sortant
  </p>
{end}
```

## Entrée OU sortie : `@in` / `@out`

`@transition` est symétrique. Pour dissocier les deux sens, utilise `@in.nom` (entrée seule) et `@out.nom` (sortie seule) — chacun avec ses propres paramètres :

```html
{if $visible}
  <p @in.fly={ y: 200, duration: 2000 } @out.fade>
    Vole en entrant, s'estompe en sortant
  </p>
{end}
```

## Effets de vue sur un élément

Les préréglages de page de `@viewTransition` (`zoom`, `volet`, `reveal`, `flip`, `cube`, `turn`, `iris`, `swipe`, `bars`, `blocks`…) sont tous disponibles comme animations `@transition`/`@in`/`@out`, posées sur un **élément** plutôt que sur une page entière — un par un, sans calque noir. Pour la version page (le routeur qui permute une vue entière), voir [17 · Router](17-router.md).

`duration` (ms), `delay` (ms, `0` par défaut), `easing` et `steps` (résolution de la keyframe interne, `60` par défaut) sont communs aux onze ; le tableau ci-dessous détaille les options propres à chacun.

```html
{if $visible}
  <img src="/logo.svg" @transition.iris>
  <p @in.volet={ dir: 'down' } @out.swipe={ dir: 'left' }>
    Descend au montage, balayé au démontage
  </p>
  <section @transition.bars={ dir: 'up', duration: 900 }>
    Révélée en huit bandes
  </section>
{end}
```

| Nom | Options (défaut) | Effet |
|---|---|---|
| `zoom` | `start` `0.55`, `opacity` `0`, `duration` `450`, `easing` `'cubic-bezier(0.2, 0.7, 0.3, 1)'` | surgit de 55 % en s'opacifiant |
| `zoomOut` | `start` `1.45`, sinon comme `zoom` | retombe depuis 145 % |
| `volet` | `dir` `'down'`, `duration` `380`, `easing` `'ease-out'` | le contenu entre en glissant dans sa propre boîte comme un store (transform + clip-path) ; `down` descend depuis le haut, `up` monte, `left` entre par la droite, `right` par la gauche |
| `reveal` | `dir` `'up'`, `duration` `380`, `easing` `'ease-in'` | l'entrée grossit et s'éclaircit depuis un léger retrait ; la sortie glisse hors champ dans la direction choisie en passant au-dessus (`zIndex`) |
| `flip` | `dir` `'left'`, `duration` `550`, `easing` `'ease-in-out'` | retournement rigide en place autour d'un axe central ; la passation entre l'ancienne face et la nouvelle se joue pile à mi-course, par bascule de visibilité (`backface-visibility`) |
| `cube` | `dir` `'left'`, `duration` `600`, `easing` `'cubic-bezier(.45,.05,.55,.95)'` | les deux faces tournent comme les pans d'un cube autour d'un axe commun enfoncé à mi-épaisseur de l'élément, avec un assombrissement synchronisé |
| `turn` | `dir` `'left'`, `duration` `600`, `easing` `'linear'` (entrée) / `'ease-in'` (sortie) | un pli pivote au-delà de 90° sur son bord et disparaît ; la nouvelle remonte de l'ombre par simple éclaircissement, sans rotation |
| `iris` | `duration` `380`, `easing` `'ease-out'`, pas de direction | un rond s'ouvre au centre (`clip-path: circle()`) |
| `swipe` | `dir` `'right'`, `duration` `320`, `easing` `'ease-out'` | un front doux balaie l'élément et le révèle derrière lui (`mask-image`/`mask-position`) |
| `bars` | `dir` `'down'`, `count` `8`, `duration` `640`, `easing` `'linear'` | huit bandes révèlent l'élément l'une après l'autre (cascade interne, 45 ms d'écart) |
| `blocks` | `cols` `6`, `rows` `4`, `duration` `620`, `easing` `'linear'`, pas de direction | vingt-quatre tuiles arrivent en tournant d'un quart de tour, en vague diagonale depuis le coin haut gauche (cascade interne, 40 ms d'écart) |

La direction se règle par la clé `dir` ou `direction`, mais ici l'objet est du vrai code évalué (pas la mini-grammaire texte de `@viewTransition`) : la valeur s'écrit en **chaîne**, guillemets obligatoires — `@transition.volet={ dir: 'down' }` — là où `@viewTransition.volet={ dir: down }` écrit le mot nu. Une direction inconnue affiche un avertissement dans la console et retombe sur la direction par défaut de l'effet.

Deux effets de page n'ont pas de jumeau propre : `fade` se pose tel quel (`@transition.fade`), et le glissement de page s'obtient avec `fly={ x: '100%', opacity: 1 }` — le `slide` d'élément, lui, reste l'accordéon (une animation différente).

> ⚠️ `swipe` repose sur les propriétés `mask-*` sans préfixe (`mask-image`, `mask-position`) : Chromium 120+, Firefox, Safari 15.4+.

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi la sortie <em>rejoue</em>-t-elle l'entrée à l'envers&nbsp;?</summary>

Ces sept effets sont symétriques : `iris` qui s'ouvrait au centre pour l'entrée se referme au centre pour la sortie, `volet` qui descendait remonte. C'est la même animation que MJS joue simplement à l'envers — pas la peine d'écrire une version « sortie » séparée, `@transition.nom` suffit ; `@in`/`@out` restent là pour choisir une paire différente de chaque côté (comme dans l'exemple ci-dessus).

</details>

`reveal`, `flip`, `cube` et `turn` sont appariés : leur entrée et leur sortie sont deux animations différentes, la sortie ne rejoue pas l'entrée à l'envers. Dans un `{key}` ou un `{if}`, le framework insère le nouveau nœud à côté de l'ancien pendant que celui-ci joue sa sortie ; l'ancien est alors épinglé à sa place, hors du flux, pour que les deux se superposent le temps de l'effet — mais l'épinglage ne joue que si un remplaçant est bien arrivé, un `{if}` qui se referme seul joue sa sortie comme d'habitude, sans épinglage. La perspective 3D de `cube`, `flip` et `turn` vit entièrement dans le `transform` de chaque face ; rien n'est posé sur le parent.

```html
{key $k}
  <div @transition.cube>
    Une face, puis l'autre
  </div>
{end}
```

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi certains effets ne jouent-ils que leur moitié&nbsp;?</summary>

Seuls, ces quatre effets ne jouent que leur moitié : un `{if}` qui se referme joue la sortie seule — l'ancien nœud s'en va, sans épinglage puisque personne n'arrive à côté — et un bloc qui s'ouvre joue l'entrée seule. C'est dans un `{key}`, où l'ancien et le nouveau coexistent un instant, que les deux moitiés se superposent et donnent l'illusion d'un seul mouvement continu.

</details>

## Transitions CSS personnalisées — `µanim.create` (forme `css`)

Pour une transition pilotée par CSS, on l'enregistre une fois avec `µanim.create nom, config`. La config fournit `duration`, `easing`, et une fonction `css(t, u)` qui renvoie un **objet de styles** ; `t` va de 0→1 (entrée) et `u = 1 - t` :

```html
<script>
  $visible = true

  µanim.create 'spin',
    duration: 8000
    easing: µeasing.elasticOut
    css: (t, u)->
      transform: "scale(#{t}) rotate(#{t * 1080}deg)"
      color: "hsl(#{Math.trunc(t * 360)}, #{Math.min(100, 1000 * u)}%, #{Math.min(50, 500 * u)}%)"
</script>

{if $visible}
  <div @in.spin={duration: 8000} @out.fade>
    <span>transitions !</span>
  </div>
{end}
```

Une fois enregistrée, la transition `spin` s'utilise comme une intégrée : `@transition.spin`, `@in.spin`, `@out.spin`, avec ou sans paramètres.

> ⚠️ `css` renvoie un **objet de propriétés** (`{ transform: …, color: … }`), pas une chaîne CSS.

## Transitions JS personnalisées — `µanim.create` (forme `tick`)

Quand l'animation a besoin de muter le DOM image par image (texte, canvas…), on passe à `µanim.create` une **fonction de setup** `(node, params)-> config`. Le setup s'exécute par-nœud (capture en closure), et la config expose un `tick(t)` appelé à chaque frame :

```html
<script>
  $visible = false

  # setup par-nœud : capture le texte, renvoie { duration, tick }
  µanim.create 'customTyper', (node, {speed = 1} = {})->
    valid = node.childNodes.length is 1 and node.childNodes[0].nodeType is Node.TEXT_NODE
    throw new Error('Cette transition exige un unique nœud texte') unless valid

    text = node.textContent

    duration: text.length / (speed * 0.01)
    tick: (t)->
      i = Math.trunc(text.length * t)
      node.textContent = text.slice(0, i)
</script>

{if $visible}
  <p @transition.customTyper>
    Le vif zéphyr jubile sur les kumquats du clown gracieux
  </p>
{end}
```

L'animation intégrée `typewriter` (`@transition.typewriter`, `@in.typewriter`…) applique exactement le même contrat : elle aussi exige un unique nœud texte, et refuse le reste avec une erreur explicite plutôt que de continuer sur une structure qu'elle ne saurait pas restituer proprement.

<details>
<summary>🎓 <b>Pour débutants</b> — <code>css</code> ou <code>tick</code>&nbsp;?</summary>

`css` est préférable quand c'est possible : MJS génère de vraies keyframes CSS, l'animation tourne sur le compositeur du navigateur (fluide, hors du thread JS). `tick` est l'échappatoire pour ce que le CSS ne sait pas faire — réécrire du texte, dessiner dans un `<canvas>`, etc. — au prix d'un appel JS par frame.

</details>

## Événements de transition

Quatre événements DOM sont émis sur l'élément pendant ses transitions : `@introstart`, `@introend`, `@outrostart`, `@outroend`.

```html
<script>
  $visible = true
  $status = 'en attente…'
</script>
<p>statut : {$status}</p>

{if $visible}
  <p
    @transition.fly={ y: 200, duration: 2000 }
    @introstart={$status = 'intro démarrée'}
    @outrostart={$status = 'outro démarrée'}
    @introend={$status = 'intro terminée'}
    @outroend={$status = 'outro terminée'}
  >
    Vole en entrant et en sortant
  </p>
{end}
```

## Transitions globales — `.global`

Par défaut une transition ne se joue que si **son propre bloc** est ajouté/retiré. Avec le modificateur `.global`, l'élément s'anime aussi quand c'est un **bloc parent** qui apparaît/disparaît :

```html
{if $showItems}
  {for item in items.slice(0, $i)}
    <div @transition.slide.global>
      {item}
    </div>
  {end}
{end}
```

> ⚠️ Sans `.global`, masquer le `{if $showItems}` entier ferait disparaître les `<div>` **sans transition** (seul leur ancêtre change, pas eux). `.global` est exactement fait pour ce cas : « anime-moi même quand c'est un parent qui bouge ».

### Le premier rendu n'anime pas — mais le montage, si

Aucune transition d'entrée ne joue sur le **premier** rendu d'un composant : sans cette règle, la page entière clignoterait au chargement. La frontière est le **rendu**, pas le chargement : tout ce qui vient après ce premier rendu anime normalement, y compris ce qui part du montage lui-même.

Concrètement, un état écrit depuis [`µmount`](16-cycle-de-vie.md#µmount--initialisation-unique) ou depuis le premier tir de [`µevery`](16-cycle-de-vie.md#µevery--répéter-en-partant-tout-de-suite) — tous deux exécutés *après* le premier rendu — déclenche un rendu suivant, et les nœuds que ce rendu crée jouent bien leur `@in`. C'est ce qui permet d'animer l'apparition d'un contenu dès l'arrivée sur la page **sans** marquer la transition `.global` :

```html
<script>
  $i =: -1

  µevery 2500, ->
    $i = ($i + 1) % $messages.length
</script>

{key $i}
  <p @in.typewriter={speed: 10}>{$messages[$i] or ''}</p>
{end}
```

Le premier message se tape, comme les suivants.

## `.shared` — animation mutualisée

`.shared` se cumule avec `.global` dans n'importe quel ordre — `@transition.fly.global.shared={y: -10}` est valide. Il bascule l'animation sur un `@keyframes` CSS injecté **une seule fois** et partagé par tous les nœuds qui l'utilisent, au lieu d'une animation par nœud : pensé pour la grosse volumétrie, des dizaines d'éléments qui apparaissent ensemble.

```html
{for item in items}
  <li @transition.fade.shared>{item}</li>
{end}
```

> ⚠️ En mode `.shared`, une transition ne sait pas reprendre une interruption à mi-course : une nouvelle valeur affectée pendant l'animation ne prolonge pas le mouvement depuis sa position actuelle, elle redémarre à 0. Pour un élément qui bascule souvent, le mode standard (sans `.shared`) reste le bon choix.

> ⚠️ `.shared` posé sur `@in.x` vaut aussi pour le `@out.y` du même nœud : le mode se décide **pour le nœud**, pas attribut par attribut.

## `@childtransition` — cascade de sortie

Posé sur l'élément qui **enveloppe** un `{if}`/`{for}`/`{key}`, `@childtransition="all"` fait que le retrait de son contenu **attend** la sortie des descendants porteurs d'une transition, avant de les retirer du DOM. C'est une cascade de **sortie**, et rien d'autre : ça ne déclenche aucune entrée au premier rendu — ce rôle-là reste celui de `.global`, par élément. Les deux mécanismes sont distincts et se complètent.

```html
<div @childtransition="all">
  {if $visible}
    {for item in items.slice(0, $i)}
      <div @transition.fade>
        {item}
      </div>
    {end}
  {end}
</div>
```

> ⚠️ Sans `@childtransition`, la fermeture de `{if $visible}` retirerait les `<div>` intérieurs **sans laisser jouer** leur `@transition.fade` (seul un descendant `.global` y échapperait, comme au paragraphe précédent). `@childtransition="all"` étend cette attente à **tous** les descendants porteurs d'une transition, sans avoir à marquer chacun `.global` individuellement.

`@childtransition` accepte `"all"`, `"out"` et `"transition"` — les trois valeurs se comportent à l'identique, `"all"` est la forme à écrire. Toute autre valeur ne fait **rien**, en silence.

## Transitions et `{key}`

Un bloc `{key expr}` re-monte son contenu à chaque changement de `expr` : l'ancien sort, le nouveau entre. C'est la combinaison idiomatique pour rejouer une transition d'entrée à chaque valeur :

```html
{key $i}
  <p @in.typewriter={speed: 10}>
    {messages[$i] or ''}
  </p>
{end}
```

## `@flip` — réordonnancement de liste

`@flip` anime le **déplacement** d'un élément quand sa position change dans un `{for}` (technique FLIP : First-Last-Invert-Play). Forme courte `@flip=durée`, ou objet `@flip={duration: …}` :

```html
{for todo in $todos.filter((t)-> not t.done) by id}
  <li @flip=200>
    <span>{todo.description}</span>
  </li>
{end}
```

`mjs-flip-delay="600"` (attribut) ajoute un délai avant le glissement — utile pour laisser un cross-fade se terminer avant de réarranger :

```html
<li @in.todoReceive={key: todo.id} @out.todoSend={key: todo.id} @flip=200 mjs-flip-delay="600">…</li>
```

Côté liste qui **reçoit** l'élément, ce délai est ignoré et ramené à `0` — le trou d'accueil s'ouvre immédiatement, pour laisser le cross-fade atterrir sans attendre ; seule la liste qui **perd** l'élément respecte réellement `mjs-flip-delay`.

La durée, le délai et l'easing acceptent une **expression** — relue à chaque animation, donc pilotable en direct :

```html
<li @flip={duration: 200 * $ralenti}>…</li>
```

> ⚠️ `@flip` ne fonctionne que dans un `{for … by clé}` **keyé** : MJS doit reconnaître chaque élément par son identité pour savoir qu'il s'est *déplacé* (et non détruit puis recréé).

## Cross-fade — transitions coordonnées entre deux listes

Un cross-fade fait *voler* un élément d'un endroit vers un autre : il sort d'une liste et **réapparaît** dans une autre, à sa nouvelle position. On enregistre une **paire** send/receive avec `µanim.crossfade nom, config`, qui crée deux transitions nommées `nomSend` (à poser sur `@out`) et `nomReceive` (sur `@in`), appariées par une **clé** :

```html
# transitions.module.civet — paire crossfade partagée par les deux listes
export setupCrossfade = ->
  fallback := (node)->
    style := window.getComputedStyle(node)
    tf := if style.transform is 'none' then '' else style.transform
    css := (t)->
      transform: "#{tf} scale(#{t})"
      opacity: t
      transformOrigin: 'center'   # centre explicite, sinon rétrécit vers un coin
    { duration: 600, easing: µ.easing.quintOut, css }
  µanim.crossfade 'todo', { duration: 600, fallback }
```

```html
@import setupCrossfade 'tuto/14/14-1/transitions.module.civet'

<script>
  setupCrossfade()   # enregistre todoSend / todoReceive
  # …
</script>

{for todo in $todos.filter((t)-> not t.done) by id}
  <li @in.todoReceive={key: todo.id} @out.todoSend={key: todo.id} @flip=200 mjs-flip-delay="600">…</li>
{end}

{for todo in $todos.filter((t)-> t.done) by id}
  <li @in.todoReceive={key: todo.id} @out.todoSend={key: todo.id} @flip=200 mjs-flip-delay="600">…</li>
{end}
```

Quand une todo passe de la liste « à faire » à « fait », elle a la **même clé** dans les deux listes : MJS apparie le `todoSend` (sortie d'un côté) avec le `todoReceive` (entrée de l'autre) et l'anime en vol d'une position à l'autre. Le `fallback` est l'animation jouée quand un élément part **sans homologue** (suppression simple) — ici, il rétrécit vers son centre en s'estompant. Le même `fallback` joue aussi côté réception, pour un élément qui **arrive** sans homologue sortant — l'effet s'inverse alors (ici, il grandirait en s'estompant depuis son centre, plutôt que d'y rétrécir).

<details>
<summary>🎓 <b>Pour débutants</b> — le rôle de la clé dans un cross-fade</summary>

Le cross-fade a besoin de savoir *quel* élément sortant correspond à *quel* élément entrant. La clé (`key: todo.id`) est ce lien : un `todoSend` portant la clé `4` cherche un `todoReceive` portant aussi la clé `4`, et anime le vol entre les deux. Si personne ne « réceptionne » cette clé (l'élément a juste été supprimé), MJS joue le `fallback` à la place.

</details>

## Animations fluides : `µinterpolate` et `µspring`

Au-delà des transitions d'entrée/sortie, deux **runes** animent en continu une valeur réactive. On les lit via `.current` (la valeur animée du moment) et on les pilote en **affectant** la rune (`$x = nouvelleCible`) — l'affectation est interceptée et anime *vers* la cible.

### `µinterpolate` — interpolation à durée fixe

`µinterpolate(valeurInitiale, duréeMs)` : transition à durée fixe vers chaque nouvelle cible (équivalent d'un *tween*).

```html
<script>
  # $progress = X est intercepté → anime vers X ; .current = valeur courante
  $progress = µinterpolate(0, 400)
</script>

<div class="track">
  <div class="bar" @style.width="{$progress.current}%"/>
</div>

<button @click={$progress = 0}>0%</button>
<button @click={$progress = 25}>25%</button>
<button @click={$progress = 100}>100%</button>
```

### `µspring` — ressort (physique)

`µspring(valeurInitiale, raideur, amortissement)` : anime via un modèle de ressort (rebond naturel), idéal pour suivre un pointeur ou réagir à une saisie. La rune accepte une valeur **scalaire** (un nombre) **ou composite** (un objet `{x, y}`, ou un tableau) — dans les deux cas, **un seul ressort** pilote toutes les composantes avec une raideur/amortissement **partagés** : pas besoin d'un ressort par axe. `.stiffness` et `.damping` sont modifiables à chaud.

```html
<script>
  # UN ressort pour les deux axes — {x, y}
  $ball = µspring({ x: 120, y: 120 }, 0.1, 0.25)

  $stiffness = 0.1
  $damping = 0.25

  # propager les réglages live au ressort
  µeffect ->
    $ball.stiffness = $stiffness
    $ball.damping = $damping

  track = (e)->
    $ball = { x: e.offsetX, y: e.offsetY }   # affecter la cible : le ressort tend vers elle
</script>

<div class="field" @mousemove={track}>
  <div class="ball" @style.left="{$ball.current.x}px" @style.top="{$ball.current.y}px"/>
</div>
```

> ⚠️ On lit **toujours** `.current` dans le template (`$ball.current`, ou `$ball.current.x` pour une composante d'un objet/tableau), jamais `$ball` directement : `$ball` est l'objet rune, `.current` est la valeur animée. Et on **affecte** `$ball = …` pour fixer une nouvelle cible — c'est l'affectation qui déclenche l'animation, pas une mutation de `.current`. Une valeur **scalaire** simple (`$x = µspring(120, 0.1, 0.25)`, `.current` = un nombre) reste parfaitement valide quand un seul axe suffit.

<details>
<summary>🎓 <b>Pour débutants</b> — interpolation ou ressort&nbsp;?</summary>

`µinterpolate` met *exactement* la durée demandée pour aller à la cible, en suivant une courbe (easing) : parfait pour une barre de progression, une valeur chiffrée, un timing maîtrisé. `µspring` n'a pas de durée fixe : il *poursuit* la cible avec une inertie de ressort (accélère, dépasse un peu, revient) — c'est ce qui donne le côté vivant quand on suit la souris ou qu'on réagit à un geste.

</details>

## Easing — `µeasing`

L'objet `µeasing` (alias `µ.easing`) fournit les courbes standard : `linear`, `cubicIn/Out/InOut`, `quintOut`, `elasticOut`, `bounceOut`, `backInOut`, `circOut`, `expoOut`, etc. On les passe au paramètre `easing` d'une transition ou d'un `µanim.create`.

> ⚠️ **Dans un attribut de template**, employez la forme **pointée** `µ.easing.X` : `@transition.fly={ easing: µ.easing.cubicOut }`. La forme courte `µeasing` (sans point) n'est réécrite en `µ.easing` que dans un `<script>` ; dans une interpolation `{…}` elle resterait littérale → `ReferenceError`.

`easing` accepte aussi une **chaîne CSS** — `'linear'`, `'ease'`, `'ease-in'`, `'ease-out'`, `'ease-in-out'`, ou `'cubic-bezier(x1, y1, x2, y2)'` — partout où une courbe `µeasing` est attendue. `µ.easing.bezier(x1, y1, x2, y2)` rend la fonction JS équivalente. Dans les deux cas, `x1`/`x2` hors de l'intervalle [0, 1] retombe sur `cubicOut`, avec un avertissement en mode debug.

---

📚 **Apprendre en pratiquant** : ces notions se répartissent sur trois sections du tuto interactif — **Transitions** (directive, paramètres, in/out, CSS & JS, événements, transitions globales), **Animation** (valeurs interpolées, ressorts) et **Transitions avancées** (transitions différées, cross-fade, `@flip`).
