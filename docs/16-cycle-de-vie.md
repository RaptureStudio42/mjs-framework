# 16 · Cycle de vie

> 📚 Tuto interactif correspondant : **Chapitre 2 — Effets** (les hooks de cycle de vie y sont présentés comme alternative explicite à `µeffect`). Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Un composant MJS a une vie : il est **créé**, **monté** dans le DOM, parfois déplacé (donc déconnecté puis reconnecté), enfin **détruit**. Six hooks permettent de brancher du code sur ces moments, en **runes µ** — la rune, suivie directement du callback `->` — comme le reste des runes du framework. À la différence d'une rune telle que `µraw`/`µurl` (valable aussi dans une expression du gabarit), ces six hooks, eux, ne s'écrivent que **dans le `<script>`** du composant : les citer dans une interpolation `{…}` ou un attribut lève une erreur de compilation qui oriente vers le `<script>`.

| Hook | Quand | Combien de fois |
|------|-------|-----------------|
| `µmount ->` | après le **premier** rendu, nœud attaché au DOM | 1× |
| `µawake ->` | à **chaque** (re)connexion au DOM | ≥ 1× |
| `µsleep ->` | à **chaque** déconnexion du DOM | ≥ 0× |
| `µdestroy ->` | au **teardown définitif** (nettoyage final) | 1× |
| `µurlChange (path, params)->` | à chaque navigation (composant *router-aware*) | ≥ 0× |
| `µfailed (err, reset)->` | quand un **descendant** plante (frontière d'erreur) | ≥ 0× |

> 💡 **Pourquoi µ et pas `@` ?** Le préfixe dit qui parle : `µ` = **le framework** (le hook est une API MJS), `@` = **votre instance** (`@clear = ->` est une méthode à vous, `@_interval` un rangement à vous). Les noms `mount`, `awake`, `sleep`, `destroy`, `urlChange`, `failed` sont donc des noms de méthodes **libres** — `@mount = ->` est une méthode utilisateur ordinaire, sans lien avec le hook. L'ancienne forme historique `@mount ->` (qui reposait sur un `=` piégeux) est **retirée** : l'écrire déclenche une **erreur de compilation** explicite qui oriente vers `µmount ->`.

> ⚠️ **Un seul hook de chaque nom par composant.** Écrire deux fois `µmount ->` (ou tout autre hook de ce tableau) ne cumule pas les deux corps : la compilation refuse le fichier et nomme le hook en double — un seul corps par hook, la logique commune se factorise dans une fonction appelée par ce corps.

## `µmount` — initialisation unique

Exécuté **une seule fois**, juste après le premier rendu : le Shadow DOM est en place, toutes les références `@this=!{ref}` (variables **sans `$`** — cf. [Directives DOM](09-directives-dom.md)) sont résolues, le nœud est mesurable (`getBoundingClientRect`, etc.). C'est l'endroit pour brancher une librairie tierce ou un observateur sur un nœud précis.

Comme `µeffect` et `@attach`, **retourner une fonction l'enregistre comme nettoyage** : appelée une seule fois, à la destruction définitive du composant — jamais à `µsleep`.

```html
<script>
  canvas = null

  µmount ->
    context = canvas.getContext('2d')
    ro = new ResizeObserver(resize)
    ro.observe(canvas)
    -> ro.disconnect()
</script>

<canvas @this=!{canvas}></canvas>
```

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi pas mettre ce code à la racine du <code>&lt;script&gt;</code>&nbsp;?</summary>

Le code écrit directement à la racine du `<script>` s'exécute dans le **constructeur** du composant : **avant** que le nœud ne soit dans la page. Conséquences : `canvas` n'existe pas encore (la référence n'est posée qu'au montage), le DOM n'est pas mesurable, et rien n'est nettoyé au démontage.

`µmount` règle ça : il diffère son corps jusqu'à ce que le composant soit *réellement* dans la page et rendu une première fois. C'est le « top départ » fiable de votre composant.

</details>

> ℹ️ **Ce que `µmount` écrit s'anime.** Une transition d'entrée (`@in`, `@transition`) ne joue jamais sur le **premier** rendu — sinon la page entière clignoterait au chargement. Mais `µmount` s'exécute *après* ce premier rendu : un état écrit là déclenche donc un rendu **suivant**, et les nœuds que ce rendu crée jouent leur transition d'entrée normalement. C'est ce qui permet d'animer l'apparition d'un contenu dès l'arrivée sur la page, sans avoir à marquer la transition `.global`. La même chose vaut pour le premier tir de [`µevery`](#µevery--répéter-en-partant-tout-de-suite), qui a lieu au montage.

> ℹ️ **Cascade de montage : l'enfant avant le parent.** Dans un arbre de composants imbriqués, le `µmount` d'un enfant s'exécute avant celui de son parent — chaque connexion au DOM programme son propre montage, et celle de l'enfant a lieu pendant que celle du parent est encore en cours. Utile pour un parent qui doit lire, dès son propre `µmount`, un état ou une réf déjà posée par ses enfants.

## `µdestroy` — nettoyage final

Appelé une fois, au démontage définitif (le composant quitte le DOM pour de bon : `{if}` qui passe à `false`, item retiré d'un `{for}`, changement de route). MJS nettoie **automatiquement** ses propres ressources — effets `µeffect`, abonnements aux stores, contextes, transitions en cours. `µdestroy` sert pour **ce que MJS ne connaît pas** : timers, `WebSocket`, listeners posés sur `window`/`document`.

```html
<script>
  µmount ->
    @timer = setInterval(tick, 1000)

  µdestroy ->
    clearInterval(@timer)
</script>
```

Équivalent au retour de `µmount` (ci-dessus) pour une ressource unique ; `µdestroy` reste préférable pour **regrouper** plusieurs nettoyages sans rapport entre eux dans un seul bloc.

> 💡 Pour ce cas précis — **un timer qui se répète** — la rune [`µevery`](#µevery--répéter-en-partant-tout-de-suite) fait les deux moitiés d'un coup, et tire dès le montage.

> 💡 Pour une ressource attachée à un nœud précis du template (lib tierce, observateur d'intersection), préférez la directive **`@attach`** (chapitre [Directives DOM](09-directives-dom.md)) : elle co-localise mise en place et nettoyage sur l'élément, et se rejoue à chaque apparition/disparition (utile sous un `{if}`).

## `µevery` — répéter, en partant tout de suite

Le couple `µmount` + `µdestroy` ci-dessus, c'est **le** motif du timer : poser un `setInterval` au montage, le couper au démontage, et ne pas oublier la seconde moitié. `µevery` fait les deux d'un bloc :

```html
<script>
  $message = ''

  µevery 2500, ->
    $message = tirerUnMessage()
</script>
```

Trois choses, dans cet ordre :

1. **le premier tir a lieu tout de suite**, au montage — pas au bout de 2 500 ms. C'est la différence avec un `setInterval` nu, qui laisse l'écran vide le temps du premier délai ;
2. ensuite, le corps est rejoué **toutes les `2500` ms** ;
3. au démontage définitif du composant, l'intervalle est **coupé automatiquement**. Rien à écrire.

Le corps n'est **pas** un effet : il ne s'abonne à rien, ne relit rien. C'est le **tir** qui est périodique. Les écritures `$x` qu'il fait, elles, restent parfaitement réactives — l'écran suit.

`µevery` **rend une main d'arrêt**, pour les cas où la répétition doit cesser avant le démontage :

```html
<script>
  $reste = 10

  arreter = µevery 1000, ->
    $reste = $reste - 1
    arreter() if $reste is 0
</script>
```

> ⚠️ `µevery` se déclare à la **racine du `<script>`**, comme les hooks : elle s'accroche au montage du composant. Dans une interpolation `{…}` ou un handler, c'est une **erreur de compilation**.

### Les options

Entre le délai et la fonction, `µevery` accepte un **hash d'options**, facultatif — la forme courte ci-dessus ne change pas :

```html
<script>
  $etat = 'en cours'

  µevery 3000, pause: true, while: (-> $etat is 'en cours'), ->
    $etat = await sonderLaConversion()
</script>
```

| Option | Effet |
| --- | --- |
| `immediate: false` | Pas de tir au montage : le premier tir a lieu **après** le délai, comme un `setInterval` nu. |
| `times: n` | **n** tirs, puis arrêt automatique. Le tir du montage compte pour un. |
| `while: -> cond` | La condition est évaluée **avant chaque tir** : dès qu'elle est fausse, la répétition s'arrête et ce tir-là n'a pas lieu. |
| `pause: true` | Suspend la répétition quand le composant **quitte le DOM sans être détruit** (hibernation du cache de pages, déplacement d'un nœud), reprend à son retour. |
| `onStop: ->` | Appelé **une seule fois**, à l'arrêt — main d'arrêt, `times` épuisé, `while` tombé, démontage ou crash du composant. C'est l'endroit où relâcher une ressource ou prévenir le serveur. |

`times` et `while` remplacent la main d'arrêt écrite à la main dans les deux cas courants — le compte à rebours et le sondage « jusqu'à ce que ce soit fini ».

Une **clé inconnue** (faute de frappe) est signalée dans la console, et une valeur du mauvais type retombe sur le défaut de sa clé : dans les deux cas le timer tourne quand même.

Le corps peut être **`async`** : un échec après un `await` part vers la frontière d'erreur du composant, exactement comme un échec immédiat. La condition `while`, elle, doit rendre un **booléen synchrone** — une fonction `async` rend une promesse, toujours vraie, ce qui ne s'arrêterait jamais ; MJS le signale et arrête la répétition.

> ⚠️ « Au démontage » veut dire **au démontage définitif**, comme le nettoyage de `µmount`. Une page mise en **hibernation** par le cache du routeur (elle quitte le DOM mais garde son état pour un retour instantané) n'est pas détruite : sans `pause: true`, son `µevery` **continue de tourner** jusqu'à l'éviction du cache.

> ℹ️ `pause: true` **reprend** la répétition, il ne la redémarre pas : la fraction de période déjà écoulée au moment de la mise en veille est perdue, et le retour dans le DOM ne provoque pas de tir de rattrapage.

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi le premier tir est-il si important&nbsp;?</summary>

Un `setInterval(f, 2500)` n'appelle **jamais** `f` immédiatement : il attend 2,5 secondes, puis commence. Pour une horloge ou un carrousel, ça veut dire un écran vide (ou figé sur une valeur de départ bidon) pendant tout le premier délai — le défaut saute aux yeux, et le remède naïf (appeler `f()` juste avant) s'écrit une fois sur deux au mauvais endroit : dans un `µeffect`, l'appel lit *et* écrit la même variable, l'effet se relance lui-même, et la page part en boucle.

`µevery` tire d'abord, répète ensuite. C'est le comportement qu'on veut dans la quasi-totalité des cas, et il n'y a plus rien à oublier.

</details>

## `µawake` / `µsleep` — connexion & déconnexion

`µmount`/`µdestroy` encadrent la vie **entière** du composant. `µawake`/`µsleep` encadrent **chaque** passage dans le DOM : un nœud déplacé (réordonnancement de liste, animation FLIP entre conteneurs, hibernation du cache de pages du routeur) est déconnecté puis reconnecté — `µmount` ne se redéclenche pas, mais `µawake`/`µsleep` si. Le couple est **symétrique** : ce que `µawake` met en place, `µsleep` le retire.

```html
<script>
  µawake ->
    @_interval = setInterval (-> $i++), 2500

  µsleep ->
    clearInterval(@_interval)
</script>
```

> ⚠️ Comme `µawake`/`µsleep` peuvent se rejouer plusieurs fois, stockez la ressource sur l'instance (`@_interval`) pour la retrouver côté `µsleep`. Une seule mise en place dans `µmount` + nettoyage dans `µsleep` ne se relancerait **pas** après une reconnexion (la ressource resterait perdue).

<details>
<summary>🎓 <b>Pour débutants</b> — <code>µeffect</code>, <code>µmount</code>, <code>µawake</code> : lequel choisir&nbsp;?</summary>

- **`µeffect`** : pour un effet de bord qui doit **réagir à l'état** (`$x` qui change) et se nettoyer tout seul. C'est le choix par défaut, le plus concis (mise en place et nettoyage dans une même fermeture). En gros, `µeffect ≈ µawake + µsleep`, avec en bonus la sensibilité automatique aux `$`.
- **`µmount`** : pour de l'**init pure une fois** (brancher une lib tierce, mesurer le DOM) qui n'a pas à réagir à l'état.
- **`µawake` / `µsleep`** : style explicite cycle-de-vie, ou quand la mise en place et le nettoyage sont vraiment distincts et que vous préférez deux blocs séparés.

</details>

## `µurlChange` — réagir à la navigation

Appelé par le routeur (`µRouter`) à chaque changement d'URL, sur **tout composant qui déclare un objet `@routes`**. Signature : `(path, params)` où `path` est le chemin après le `#` (ex. `/posts/42`) et `params` l'objet des segments dynamiques capturés (ex. `{ id: '42' }`).

```html
<script>
  @routes =
    'main':
      '/posts/:id': 'post-page'

  µurlChange (path, params)->
    $id = params.id
</script>
```

> ⚠️ `µurlChange` n'est appelé **que** si le composant est *router-aware*. C'est la **présence de `@routes`** (ou du hook `µurlChange` lui-même) qui l'enregistre auprès du routeur. Sans `@routes`, le hook reste inerte — et les `<@view>` ne s'injectent jamais. Détails au chapitre suivant.

Ordre d'exécution à chaque navigation : URL détectée → `µurlChange` appelé sur chaque composant aware → le routeur injecte le composant-page dans son `<@view>` → ce nouveau composant joue **son propre** `µmount`.

> 🔗 Le routeur, l'objet `@routes`, les zones `<@view>` et les routes paramétrées sont détaillés au chapitre [Router (client)](17-router.md).

## `µfailed` — frontière d'erreur (forme script)

`µfailed (err, reset)->` est l'**équivalent script** de la balise spéciale `<@failed err reset>…</@failed>` ([Éléments spéciaux](15-elements-speciaux.md)) : si un composant **descendant** plante (et n'a pas sa propre frontière), l'erreur remonte jusqu'ici. `err` est l'erreur capturée, `reset` une fonction qui re-monte le composant (nouvelle tentative).

```html
<script>
  µfailed (err, reset)->
    "<p>Oups : #{err.message}</p><button mjs-reset>Réessayer</button>"
</script>
```

> ⚠️ Contrairement à `<@failed>` (un vrai bloc template compilé, `@click=reset` devient un listener réel), la forme script `µfailed` renvoie une **chaîne HTML brute** : pas d'interpolation `{…}` ni de directives `@` compilées dedans. Le bouton de reset s'y marque par l'attribut `mjs-reset` (câblé automatiquement au clic), pas par `@click=reset`. Pour un fallback avec du vrai markup MJS (réactif, événements typés), préférez `<@failed>` — `µfailed` reste l'échappatoire pour un fallback texte minimal composé dynamiquement.

---

📚 **Apprendre en pratiquant** : les hooks sont introduits dans le **Tuto interactif n°2 (Effets)** comme pendant explicite de `µeffect` ; `µmount`/`µsleep` sont mis en œuvre dans les chapitres canvas (n°13) et le hook `µurlChange` dans les chapitres de routage (n°19–20, 31).
