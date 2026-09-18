# 6 · Événements

> 📚 Tuto interactif correspondant : **Chapitre 5 — Événements**. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

On écoute un événement avec un attribut **`@<événement>`** : `@click`, `@input`, `@pointermove`, `@keydown`… Trois formes selon ce qu'on met à droite, plus une famille de **modificateurs** suffixés par un point. Sous le capot, MJS n'attache pas un `addEventListener` par nœud : il pose **un seul listener délégué** par type d'événement.

> 🔤 Les corps de handlers (`@click={ … }`) sont compilés en **Civet** par défaut (comme le `<script>` du composant, cf. [Anatomie d'un composant](02-composant.md)) : le ternaire **espacé** `cond ? a : b` est accepté, `??` (opérateur existentiel) fonctionne, et un ternaire **collé** (`cond?a:b`) lève une erreur de compilation orientante plutôt qu'un comportement surprenant (`?` collé est l'opérateur d'existence Civet). Un projet en `languages: { template: "js" }` (repli explicite) retrouve le comportement historique par regex, plus permissif mais moins idiomatique.

## Les trois formes

### Corps de handler — `@click={ … }`

Entre accolades, on écrit **directement le corps** du handler — pas une fonction à part entière. L'événement DOM est disponible sous `e`, le nœud sous `el`.

```html
<div
  @pointermove={
    $m.x = e.clientX
    $m.y = e.clientY
  }
>
  The pointer is at {Math.round($m.x)} x {Math.round($m.y)}
</div>
```

On peut aussi mettre directement une expression : `@click={$count += 1}` ou `@click={$selected = color}`. Pas de currying ni de wrapping : c'est exécuté tel quel quand l'événement survient.

> ⚠️ **Piège fréquent** : n'enveloppe **pas** le corps dans une fonction (`@pointermove={(event)-> …}`) — l'accolade attend le **corps exécuté**, pas une fonction à appeler. `@click={(e)-> $count += 1}` ne fait *rien* au clic : ça construit une fonction et la jette (jamais invoquée), sans erreur ni avertissement. Écris le corps directement (`@click={$count += 1}`), et utilise `e`/`el` — déjà en scope — plutôt que de redéclarer un paramètre.

### Référence de fonction — `@click={maMethode}`

Si l'accolade contient **un simple identifiant**, c'est traité comme une référence : la fonction est appelée avec `(e, el)`.

```html
<script>
  increment = -> $count += 1
</script>
<button @click={increment}>Clicked {$count}</button>
```

### Forme nue — `@click`

`@<événement>` **sans valeur** appelle la méthode **du même nom** déclarée dans le `<script>`.

```html
<script>
  pointermove = (event)->
    $m.x = event.clientX
    $m.y = event.clientY
</script>
<div @pointermove role="presentation">
  The pointer is at {Math.round($m.x)} x {Math.round($m.y)}
</div>
```

Ici `@pointermove` (nu) appelle `pointermove`. C'est le raccourci idiomatique quand le nom du handler = le nom de l'événement.

Un nom d'événement qui contient un **deux-points** (`mjs:load`, `commande:validee` — la convention des événements applicatifs, et celle du framework lui-même) s'écrit toujours **avec son corps** : `@commande:validee={@traiter(e)}`. La forme nue n'y est pas disponible — elle appellerait une méthode nommée `commande:validee`, ce qu'aucun langage n'accepte ; le compilateur la refuse avec un message explicite plutôt que de laisser passer un handler qui ne tirera jamais.

<details>
<summary>🎓 <b>Pour débutants</b> — quelle forme choisir&nbsp;?</summary>

- **Une ligne de logique simple** (incrémenter, basculer un booléen) → corps inline : `@click={$open = !$open}`.
- **Une méthode déjà nommée**, réutilisée ailleurs → référence : `@click={save}`.
- **Méthode dont le nom colle à l'événement** → forme nue : `@submit` appelle `submit`.

Dans les trois cas tu reçois `e` (l'événement) et `el` (l'élément). Pas besoin de `.bind(this)` ni de flèche `=>` : MJS lie le contexte pour toi (utilise `->`, le style par défaut).

</details>

## Modificateurs

On enchaîne des suffixes `.mot` sur le nom de l'événement. Ils s'appliquent **au moment du dispatch**, avant ton code (sauf `.once`, géré au niveau de la route).

| Modificateur | Effet |
|---|---|
| `.prevent` | `e.preventDefault()` |
| `.stop` | `e.stopPropagation()` — arrête la remontée |
| `.self` | n'exécute le handler que si `e.target` est bien **ce** nœud (pas un descendant) |
| `.once` | le handler ne se déclenche qu'**une seule fois** (la route est retirée après) |
| `.propagate` | placé **sur l'enfant** : laisse l'événement **continuer à remonter** vers les ancêtres |
| `.emit.<nom>` | n'exécute aucun code : **émet** l'événement `<nom>` vers le parent (cf. [Émettre depuis le geste](#émettre-depuis-le-geste--clickemitnom)) |

```html
<!-- le <div> ET l'<input> réagissent : .propagate laisse l'événement remonter -->
<div @keydown={alert("<div> " + e.key)}>
  <input @keydown.propagate={alert("<input> " + e.key)} />
</div>

<!-- ici l'input « avale » l'événement : seul l'input réagit -->
<div @keydown={alert("<div> " + e.key)}>
  <input @keydown={alert("<input> " + e.key)} />
</div>
```

> ⚠️ **Un suffixe inconnu est une erreur de compilation.** `@click.stopp`, `@click.prevnet`, `@click.emit` (sans nom) : le build s'arrête et nomme le fautif, avec la suggestion quand la faute est proche d'un modificateur réel. Corollaire à connaître : **un nom d'événement ne peut pas contenir de point** — `@user.created` est lu comme l'événement `user` suffixé du modificateur `created`, donc refusé. Nomme l'événement `user-created`.

> ⚠️ **`.capture` n'existe pas** en MJS. La phase de capture n'est pas exposée. Le modificateur de remontée, c'est **`.propagate`** : par défaut le routeur s'arrête au premier handler trouvé (le plus proche de la cible) ; `.propagate` sur ce handler lui dit de *laisser l'événement poursuivre* vers les ancêtres. C'est l'inverse logique du `.stop` de la plupart des frameworks — ici on **n'a pas** à stopper, on choisit explicitement de propager.
>
> 🚪 **L'échappatoire, pour le cas rare.** Un vrai besoin de phase de capture — piéger le focus, pré-empter un handler tiers *avant* qu'il ne s'exécute — se pose à la main, hors du modèle délégué, dans `µmount` : `node.addEventListener('click', h, { capture: true })`, retiré dans `µdestroy`. On sort alors de la délégation en pleine conscience, pour ce seul nœud ; c'est assez rare pour ne pas mériter un modificateur dédié (qui imposerait un second pipeline délégué en phase de capture).

## Le modèle : un seul listener délégué

MJS ne pose pas un écouteur par bouton. Pour chaque **type** d'événement utilisé dans le composant, il enregistre **un unique listener** sur la racine du composant. Quand l'événement survient, ce listener remonte de `e.target` vers la racine et route vers le(s) handler(s) du nœud concerné. Conséquences pratiques :

- **Coût constant** quelle que soit la taille des listes : 1 000 boutons `@click` = 1 listener, pas 1 000.
- Les nœuds ajoutés dynamiquement (`{for}`, `{if}`) sont **immédiatement** écoutés, sans ré-attachement.
- Comme il n'y a pas de listeners voisins à couper, **`.stop`** se contente de `stopPropagation()` (pas de `stopImmediatePropagation`).
- La délégation fonctionne **aussi pour les événements qui ne bouillonnent pas** (`pointermove`, etc.) : c'est un seul listener, pas une dépendance au bubbling natif — d'où le `@pointermove` du premier exemple qui marche directement.
- Pour `touchstart` / `touchmove` / `wheel`, le listener est `passive` par défaut (scroll fluide) ; il bascule en non-passif automatiquement si le handler appelle `preventDefault` (via `.prevent` ou dans le corps).

<details>
<summary>🎓 <b>Pour débutants</b> — « délégation », concrètement&nbsp;?</summary>

Imagine une liste de 500 lignes, chacune avec un bouton « supprimer ». L'approche naïve attache 500 écouteurs — lourd à créer, à nettoyer, et à maintenir quand la liste change. La délégation pose **un seul** écouteur sur le conteneur : quand tu cliques, l'événement « remonte » jusqu'à lui, et MJS regarde *quel* élément a été cliqué pour appeler le bon handler. Tu n'as rien à gérer : tu écris `@click` sur chaque ligne comme d'habitude, MJS optimise dessous.

</details>

## Événements de composant — `µemit`

Un composant enfant communique vers son parent en **émettant** un événement avec `µemit`, que le parent écoute comme un événement DOM via `@<nom>`.

```html
<!-- enfant : stepper -->
<script>
  inc := -> µemit 'increment'
  dec := -> µemit 'decrement'
</script>
<button @click={dec}>-</button>
<button @click={inc}>+</button>
```

```html
<!-- parent -->
<script>
  $value = 0
</script>
<p>The current value is {$value}</p>

<@stepper
  @increment={$value += 1}
  @decrement={$value -= 1}
>
```

`µemit 'increment'` déclenche, côté parent, le handler `@increment`. On peut passer une charge utile en second argument (`µemit 'increment', payload`), récupérée via `e.data` côté parent (MJS expose la charge utile sur `e.data`, **pas** `e.detail` — le nom natif `CustomEvent.detail` a été volontairement abandonné).

### Émettre depuis le geste — `@click.emit.<nom>`

L'immense majorité des `µemit` ne fait qu'une chose : émettre, au clic, un nom fixe. Écrire un handler pour cette seule ligne est du bruit — d'où le suffixe `.emit.<nom>`, qui se pose sur **n'importe quel** événement écouté et n'exécute aucun autre code.

```html
<!-- enfant : stepper — sans une ligne de <script> -->
<button @click.emit.decrement>-</button>
<button @click.emit.increment>+</button>
```

C'est exactement l'équivalent du `µemit 'increment'` écrit plus haut : même événement, même remontée, même écoute côté parent (`@increment={…}`).

La **charge utile** se pose dans la valeur de l'attribut, comme partout ailleurs dans le framework — c'est une expression, pas un nom :

```html
<!-- un émetteur par ligne, chacun avec l'identifiant de SA ligne -->
{for row in rows}
  <li @click.emit.select={row.id}>{row.label}</li>
{end}
```

Le parent lit `e.data` (`row.id` ici), à l'identique de `µemit`. Les modificateurs se combinent, et se posent **avant** — le nom émis se lit toujours en dernier :

```html
<form @submit.prevent.emit.saved={$draft}>…</form>
```

> ⚠️ `emit.<nom>` **clôt** le nom d'attribut. `@click.emit.save.stop` est refusé à la compilation (le `.stop` se pose avant : `@click.stop.emit.save`), et le nom émis ne peut contenir ni point ni apostrophe — `row-selected` et `mjs:done` passent, `user.created` non.

**Quand rester sur `µemit`** : dès que le geste fait autre chose qu'émettre — valider, calculer, écrire un état. `@click.emit.<nom>` est le raccourci du cas où il n'y a *rien* d'autre à faire.

### Écriture déclarative — `@emit.`

`µemit` s'écrit dans un handler, à l'initiative d'un geste. Il existe une seconde écriture, purement déclarative, posée directement en attribut sur un nœud du template de l'enfant : `@emit.<nom>={valeur}` émet l'événement `<nom>` vers le parent **chaque fois que la valeur change** — sans le moindre handler à écrire.

```html
<!-- enfant : indicateur de présence -->
<script>
  $online = navigator.onLine
</script>
<div @emit.status={$online}>{$online ? 'en ligne' : 'hors ligne'}</div>
```

```html
<!-- parent -->
<@presence @status={console.log('statut reçu :', e.data)}>
```

Le parent écoute exactement comme pour `µemit` : `@status={…}`, charge utile dans `e.data`. `@emit.once.<nom>={valeur}` est la variante « une seule fois » : l'émission a lieu **au montage**, jamais ensuite, même si la valeur change plus tard.

```html
<script>
  $id = crypto.randomUUID()
</script>
<div @emit.once.created={$id}>…</div>
```

**Quand choisir quoi**, les trois écritures d'un seul coup d'œil :

| Écriture | L'émission est déclenchée par | Exemple |
|---|---|---|
| `@click.emit.<nom>` | un **geste**, et le geste ne fait rien d'autre | `<button @click.emit.increment>` |
| `µemit '<nom>'` | un **geste**, au milieu d'autre code (validation, calcul, écriture d'état) | `save := -> …; µemit 'saved', $id` |
| `@emit.<nom>={valeur}` | une **valeur qui change** — aucun geste, aucun handler | `<div @emit.status={$online}>` |

> ⚠️ Une forme qui n'est ni `@emit.<nom>={…}` ni `@emit.once.<nom>={…}` (un nom vide, un troisième segment, un `once` mal placé…) est une erreur de compilation.

### Portée de l'événement — `bubbles`, `composed`

`µemit` construit son `CustomEvent` avec **`bubbles: true`** et **`composed: true`** par défaut. `bubbles` le fait remonter le DOM comme n'importe quel événement natif ; `composed` le fait en plus traverser **toutes les frontières de shadow DOM ancêtres**, jusqu'au `document` — pas seulement celle du composant parent direct, mais chacune des frontières intermédiaires, quelle que soit la profondeur d'imbrication.

> ⚠️ **Piège du double relais.** Un composant petit-enfant qui émet `paint`, un parent qui écoute ce `paint` et **relaie** l'information en émettant lui-même un événement du même nom, et un écran grand-parent qui écoute `@paint` : ce dernier reçoit **les deux** événements — le relais du parent, et l'original du petit-enfant, qui continue sa remontée au-delà du parent sans s'arrêter au premier écouteur satisfait. Le second, à cet étage, arrive avec un `e.data` qui n'est plus le bon (celui du petit-enfant, pas celui recalculé par le relais).

```html
<!-- canvas.mjs — petit-enfant, émet paint tel quel -->
<script>
  paint := -> µemit 'paint', { x, y }
</script>
```

```html
<!-- panel.mjs — parent, relaie sous un nom DISTINCT, jamais le même que celui reçu -->
<script>
  onPaint := (e)-> µemit 'panel-paint', e.data
</script>
<@canvas @paint={onPaint}>
```

Le remède tient dans cet exemple : des noms distincts par étage (`paint` puis `panel-paint`), pour qu'un `@paint` plus haut ne capte jamais l'original en transit. L'autre option est de couper la portée à la source, avec le **troisième argument** de `µemit` — un objet d'options fusionné dans l'initialisation du `CustomEvent` : toute clé **sauf `detail`** (qui n'a pas cours côté MJS, cf. plus haut) y est acceptée, `bubbles`/`composed` inclus.

```html
<script>
  paint := -> µemit 'paint', { x, y }, { bubbles: false }
</script>
```

Avec `{ bubbles: false }`, l'événement n'est capté que par un `@paint` posé sur l'élément qui émet lui-même : la remontée s'arrête net à la source, sans dépendre d'un `.stop` côté écouteur.

### Traverser la frontière — un natif remonte tout seul

Un événement natif déclenché **dans** un composant enfant remonte jusqu'au parent sans le moindre relais à écrire. Poser `@click` sur la balise de l'enfant suffit : le handler du parent joue, que l'enfant déclare ou non un `@click` de son côté.

```html
<!-- parent : rien à ajouter dans l'enfant -->
<@stepper @click={onAnyClick}>
```

Deux étages se superposent. D'abord le **DOM natif** : `click` est `bubbles: true` *et* `composed: true`, il traverse donc toutes les frontières de shadow DOM — y compris les *closed* de MJS — et remonte jusqu'au `document`. Ensuite le **routeur MJS**, qui a posé son unique listener sur le shadow root du composant en **phase de capture** : quand l'événement passe, il part de `e.target` et remonte vers sa racine pour trouver un nœud porteur d'un handler ; s'il n'en trouve pas, il rend la main sans jamais appeler `stopPropagation`. L'événement poursuit donc sa route intacte, d'où la remontée « gratuite ».

Conséquence directement observable : **le parent est prévenu avant l'enfant**. L'événement descend d'abord (capture) et croise le shadow root du parent avant celui de l'enfant. Un `.stop` posé **dans l'enfant** ne coupe donc pas le handler du parent — quand l'enfant appelle `stopPropagation`, le parent a déjà joué ; `.stop` coupe ce qui vient *après* (le `document` et les écouteurs tiers).

Cas d'usage typique : un composant « habillage » dont on veut simplement récupérer le clic sans lui faire déclarer quoi que ce soit.

```html
<script>
  audio = new Audio()
  audio.src = µasset('tuto/5/5-5/horn.mp3')   # µasset('chemin') résout un asset LOCAL (copié/hashé au build)
  honk = ->
    audio.load()
    audio.play()
</script>
<@big-red-button @click={honk}>
```

> 💡 **`µasset('chemin')`** résout un fichier **local** (image, son, police…) référencé depuis le script ou un attribut : le chemin est validé et remplacé par l'URL **hashée** finale au **build** (chemin absent → erreur de build explicite, jamais un lien mort silencieux). Marche aussi dans le `<style>` (`url(µasset('…'))`, cf. [Pièges](18-pieges.md) → polices). ⚠️ L'argument doit être un **littéral chaîne écrit en dur** (`µasset('x.png')`) — c'est une résolution **compile-time** (avant même la compilation du langage), pas un appel runtime : `µasset(variable)` n'est **pas** reconnu et part tel quel dans le JS compilé, où `µasset` n'existe pas.

> ⚠️ **Ça remonte — mais le parent ne sait pas *quoi* a été touché.** À cause du *retargeting* du shadow DOM, l'événement qui arrive chez le parent porte `e.target` = **l'hôte** (`<mjs-stepper>`), et son `composedPath()` commence à l'hôte : les nœuds internes de l'enfant sont invisibles (le shadow DOM est clos). Le parent apprend donc « on a cliqué quelque part là-dedans », jamais « on a cliqué sur le bouton + ». C'est exploitable pour fermer un menu, marquer un panneau actif, poser un focus — et rien de plus. **Dès qu'il faut distinguer un geste d'un autre, ou lire une donnée, c'est `µemit`** : un nom sémantique par geste, la charge utile dans `e.data`.

### Les natifs qui ne traversent pas — `composed: false`

Tous les événements natifs ne sont pas `composed`. Ceux qui ne le sont pas **meurent à la frontière du shadow DOM** : le parent ne voit rien, et aucun `@…` posé sur la balise de l'enfant ne se déclenchera jamais.

| `composed` | Événements | Le parent les reçoit-il ? |
|---|---|---|
| `true` | `click`, `mousedown`, `mouseover`, `pointerdown`, `wheel`, `contextmenu`, `input`, `keydown`, `keyup`, `focus`, `focusin`, `focusout`, `copy` | ✅ oui |
| `false` | `change`, `reset`, `select`, `invalid`, `load`, `error`, `scroll`, `play`, `pause`, `animationend`, `transitionend` | ❌ non — ils s'arrêtent dans l'enfant |
| *le drapeau ment* | `submit` — `composed: false` sous Firefox, **`composed: true` sous Chrome** | ❌ non — il ne sort ni de l'un ni de l'autre |

Le cas qui pique le plus est `change` : `bubbles: true` mais `composed: false`, il remonte donc bien **à l'intérieur** de l'enfant, où un `@change` local fonctionne parfaitement, mais il ne sort pas du shadow DOM. Même effet pour `submit` — un `@submit` posé sur la balise d'un composant qui contient le `<form>` ne partira jamais — mais pour une raison différente : là, Chrome annonce `composed: true` et retient quand même l'événement dans le shadow DOM (Firefox, lui, annonce `false`). Sur ce type précis, c'est le comportement qui fait foi, pas le drapeau. Le remède est un relais explicite côté enfant :

```html
<!-- enfant -->
<input value=!{$v} @change={-> µemit 'change', $v}>
```

```html
<!-- parent -->
<@field @change={console.log('valeur validée :', e.data)}>
```

> 🔎 **Diagnostic en une ligne.** Un `@…` du parent qui ne part jamais, alors que le geste a bien lieu dans l'enfant : coller `console.log e.composed` dans un handler de l'enfant. Si c'est `false`, aucun réglage côté parent n'y changera rien — il faut relayer par `µemit`. **Une exception connue : `submit`**, qui répond `true` sous Chrome sans pour autant traverser ; s'il s'agit de ce type, ne cherchez pas plus loin et relayez.

> 🙋 **`mouseenter` / `mouseleave` : l'exception qui trompe.** Ils sont `composed: false` *et* `bubbles: false`, et pourtant un `@mouseenter` posé sur la balise de l'enfant se déclenche bien. Ce n'est pas l'événement interne qui a traversé : le navigateur en émet un **deuxième, distinct**, directement sur l'hôte, quand le pointeur entre dans l'élément. Le parent est donc prévenu que le pointeur est entré **dans le composant** — jamais qu'il est entré dans tel ou tel élément interne.

> 🔗 Voir aussi : [Bindings two-way](07-bindings.md) (`value=!`, `@group` — qui s'appuient sur le même système d'événements) et [Binding de classe](08-class.md) (un cas de dispatch « filtré » dérivé du même moteur).

## Navigation — `@confirm`, `@method` et `@callback`

Trois directives posées sur un lien (`<a>`) ou un formulaire branchent du comportement de **navigation** — elles sont converties à la compilation en attributs `mjs-confirm`/`mjs-method`/`mjs-callback`, lus par la couche [Navigation (UJS)](21-navigation.md) qui intercepte clics et soumissions. Les attributs `mjs-*` compilés fonctionnent aussi tels quels dans du **HTML servi par le back** (pas de composant MJS requis) — la couche UJS les lit au niveau du DOM, pas du composant.

```html
<a href="/posts/42" @method="delete" @confirm="Supprimer ce billet ?">Supprimer</a>
```

- **`@confirm="message"`** — au clic, la question s'affiche et **rien ne part** tant que l'utilisateur n'a pas répondu. Refus → rien du tout : aucune requête, l'URL ne bouge pas, le formulaire n'est pas envoyé, et un `@click` de composant posé sur le même élément ne s'exécute pas non plus. Acceptation → l'action repart d'elle-même, comme si la question n'avait pas existé. La boîte affichée est la **modale maison** du framework, aux couleurs de ta CSS ; on peut lui préférer celle du navigateur, ou brancher la sienne (ci-dessous).

  `@confirm` accepte aussi une **forme objet**, pour habiller les boutons de la modale maison sans toucher à `µ.config.confirm` : `@confirm={ text: 'Message', ok: 'Oui, supprimer', cancel: 'Garder' }` — littéral **statique** (clés `text`/`ok`/`cancel`, valeurs chaîne uniquement, aucune expression). `ok`/`cancel` habillent respectivement le bouton de confirmation et le bouton Annuler (`confirmButtonText`/`cancelButtonText` de `µ.modal.fire`, ci-dessous) ; omis, les libellés par défaut du framework s'appliquent.

  Une troisième forme, **expression** — `@confirm={$message}`, `@confirm={$a || $b}`, `@confirm={calculerMessage()}` — passe l'attribut tel quel dans le pipeline générique (même mécanisme que `title={$expr}` natif) : le message est **réactif**, relu à chaque clic (le framework lit l'attribut au moment du clic, jamais figé à celui du montage). Se distingue de la forme objet par son contenu : un hash d'options porte toujours au moins une `clé:` en tête, tout le reste est une expression.

- **`@method="delete|post|put|patch"`** — en HTML, un `<a>` ne sait que **demander** une page (`GET`) ; supprimer une ressource réclame un `DELETE`, qu'un lien nu ne peut pas envoyer — d'où les `<form>` invisibles écrits à la main dans les applications classiques. `@method` fait ce travail : au clic, requête au **verbe HTTP** demandé, form-encodée avec le jeton CSRF automatique (même chemin que la soumission d'un `<form>`). Le temps de la requête, le lien porte `aria-disabled="true"` et un second clic est ignoré — pas de double suppression sur une connexion lente.
- **`@callback="methodName"`** — un rappel posé sur un lien ou un formulaire, appelé uniquement sur une navigation qui **aboutit** (nouvelle page installée, ou fiche `method: 'none'`) — jamais sur un 422, un échec de transport ou un retour `Précédent`/`Suivant` (le veilleur `flash`/`error` du chapitre [Navigation (UJS)](21-navigation.md) couvre ces cas-là). `@callback={…}` (une expression entre accolades) est une **erreur de compilation** : la directive attend un simple nom de méthode entre guillemets. Détail complet — recherche de la méthode, forme du rappel : [Navigation (UJS)](21-navigation.md) → *`@callback` — un rappel après navigation*.

**Modale personnalisée** — le point d'entrée est `µ.config.confirm` :

- `true` *(défaut)* → modale maison **`µ.modal.fire`** (ci-dessous), appelée avec `{ text: message, icon: 'question', showCancelButton: true }` — confirmé si `isConfirmed`. Module `modal` absent du build (sélection `runtime` explicite qui l'exclut) → repli `window.confirm` et un avertissement console (une seule fois).
- `false` → `window.confirm(message)`, la boîte grise du navigateur.
- toute autre valeur → même repli, avec le même avertissement (une seule fois) : seules `true`/`false` sont des valeurs valides.

Pour un contrôle total, `µ.confirm` est une fonction **remplaçable** qui prime sur la config, quelle qu'elle soit : réassigne-la (`µ.confirm = (message, el) -> …`) pour brancher directement ta propre modale. Retour booléen (décision immédiate) ou **promesse de booléen** (modale asynchrone) : le temps que la boîte s'affiche, le clic d'origine est annulé — puis, dès que la promesse répond `true`, le framework **rejoue l'action lui-même**, à l'identique (lien re-cliqué, formulaire re-soumis avec son bouton d'envoi d'origine). Rien à relancer à la main ; pendant l'attente, les clics répétés sur le même élément sont avalés.

### `µ.modal.fire` — la modale maison, API publique autonome

`µ.modal.fire(options) → Promise<{isConfirmed, isDenied, isDismissed, value, dismiss}>` ouvre directement la modale maison — utilisable par une appli **indépendamment** de `@confirm`/`µ.config.confirm`, partout où une confirmation, une saisie ou un message bloquant est utile. Zéro dépendance externe, zéro CSS inline (classes `mjs-modal-*` posées via une feuille adoptée). Ne rejette **jamais** : quelle que soit la cause de fermeture, la promesse se résout.

> 🛡️ **Options vérifiées à l'appel.** Les options sont validées **et recopiées** avant que la promesse n'existe. Un appel malformé — mauvais type, valeur non convertible en texte, getter qui lève — provoque une `TypeError` **synchrone** dont le message nomme l'option fautive (`` `customClass.box` attend du texte, reçu symbol ``). Une erreur de programmation reste donc bruyante et pointe votre code, au lieu de se déguiser en « l'utilisateur a annulé ». Un nom **inconnu** d'`icon` ou d'`input`, lui, ne bloque rien : avertissement en console, puis repli (aucune icône / champ `text`).

| Option | Type | Défaut | Effet |
|---|---|---|---|
| `title` | chaîne | — | titre (texte brut, jamais interprété) |
| `text` | chaîne | — | contenu (texte brut) |
| `html` | chaîne | — | contenu HTML de confiance (interprété — même contrat que `@html`) ; prime sur `text` |
| `icon` | chaîne — `success`, `error`, `warning`, `info` ou `question` | — | icône SVG inline colorée ; absente/inconnue → aucune icône |
| `showConfirmButton` | booléen | `true` | affiche le bouton de confirmation ; `false` = boîte sans bouton (ex. `µ.modal.wait`, ci-dessous) — le focus initial retombe alors sur la boîte elle-même |
| `showCancelButton` / `showDenyButton` | booléen | `false` | affiche le bouton Annuler / Non |
| `confirmButtonText` / `cancelButtonText` / `denyButtonText` | chaîne | libellé framework (fr/en selon `lang`) | texte des boutons |
| `input` | chaîne — `text`, `textarea`, `select` ou `checkbox` | — | ajoute un champ de saisie dans la boîte |
| `inputValue` | chaîne ou booléen | — | valeur initiale (booléen pour `checkbox`) |
| `inputOptions` | objet ou `Map` | — | options du `select` (`{valeur: libellé}`) |
| `inputPlaceholder` | chaîne | — | placeholder du champ |
| `inputValidator(value)` | fonction → chaîne, `null` ou Promise | — | message d'erreur pour bloquer, faux/`null` pour valider |
| `preConfirm(value)` | fonction → valeur ou Promise | — | transforme la valeur finale ; renvoyer `false` annule (modale conservée ouverte) |
| `timer` | nombre (ms) | — | fermeture automatique (`dismiss: 'timer'`) |
| `allowOutsideClick` / `allowEscapeKey` | booléen | `true` | clic hors modale / touche Échap ferme (`dismiss: 'backdrop'` / `'esc'`) |
| `customClass` | objet | — | classes CSS additionnelles par zone (`backdrop`, `box`, `icon`, `title`, `htmlContainer`, `input`, `validationMessage`, `actions`, `confirmButton`, `denyButton`, `cancelButton`) |

Le résultat distingue l'issue et sa cause exacte : un seul de `isConfirmed`/`isDenied`/`isDismissed` est `true` ; `value` porte la saisie (ou le retour de `preConfirm`) côté confirmation ; `dismiss` vaut `'cancel'`/`'esc'`/`'backdrop'`/`'timer'` sur une fermeture non confirmée, sinon `undefined`. Piège de focus actif tant que la modale est ouverte (Tab/Shift+Tab bouclent dans la boîte) ; à la fermeture, le focus revient automatiquement à l'élément qui l'avait avant l'ouverture.

```html
<script>
  supprimer = ->
    result = await µmodal.fire
      title:            'Supprimer le compte ?'
      text:             'Cette action est irréversible.'
      icon:             'warning'
      showCancelButton: true
    if result.isConfirmed
      $supprime = true
</script>
<button @click={supprimer}>Supprimer mon compte</button>
```

### Personnalisation visuelle — variables CSS

La modale s'affiche via une feuille adoptée par `document` (`µ._mjs_modalSheet`) — donc APRÈS les `<style>` de la page dans la cascade. Aucune couleur n'y est en dur : chaque teinte, bordure, rayon et ombre passe par une variable CSS `--mjs-modal-*`, lue depuis `:root` (la modale vit en light DOM sur `document.body`, jamais dans un shadow root). Une appli qui ne déclare rien voit exactement le rendu par défaut ci-dessous ; en déclarer une seule suffit à la retenir.

| Variable | Rôle | Repli |
|---|---|---|
| `--mjs-modal-bg` | fond de la boîte | `#fff` |
| `--mjs-modal-fg` | texte principal (titre, contenu par défaut) | `#222` |
| `--mjs-modal-muted` | texte secondaire (`.mjs-modal-content`) | `#444` |
| `--mjs-modal-radius` | arrondi de la boîte | `8px` |
| `--mjs-modal-shadow` | ombre portée de la boîte | `0 10px 40px rgba(0,0,0,.25)` |
| `--mjs-modal-backdrop` | fond du calque derrière la boîte | `rgba(0,0,0,.55)` |
| `--mjs-modal-border` | bordure du champ de saisie | `#d0d0d0` |
| `--mjs-modal-input-bg` | fond du champ de saisie (text/textarea/select/checkbox) | `transparent` |
| `--mjs-modal-input-fg` | texte du champ de saisie | `inherit` |
| `--mjs-modal-btn-radius` | arrondi partagé — champ de saisie, bandeau de validation, boutons | `4px` |
| `--mjs-modal-confirm-bg` / `--mjs-modal-confirm-fg` | bouton de confirmation | `#3085d6` / `#fff` |
| `--mjs-modal-deny-bg` / `--mjs-modal-deny-fg` | bouton « Non » | `#e0a020` / `#fff` |
| `--mjs-modal-cancel-bg` / `--mjs-modal-cancel-fg` | bouton Annuler | `#e8e8e8` / `#333` |
| `--mjs-modal-error-bg` / `--mjs-modal-error-fg` | bandeau d'erreur de validation | `color-mix(in srgb, var(--mjs-modal-icon-error) 14%, transparent)` / `var(--mjs-modal-icon-error)` — suit la teinte de l'icône d'erreur (`#d64545` par défaut), pas une valeur figée |
| `--mjs-modal-icon-success` | icône succès | `#2e9e5b` |
| `--mjs-modal-icon-error` | icône erreur | `#d64545` |
| `--mjs-modal-icon-warning` | icône avertissement | `#e0a020` |
| `--mjs-modal-icon-info` | icône information | `#3085d6` |
| `--mjs-modal-icon-question` | icône question (et teinte par défaut avant icône spécifique) | `#6b7280` |

Thème sombre complet, prêt à copier dans le CSS de la page (aucune classe à renommer, aucun `!important`) :

```css
:root {
  --mjs-modal-bg: #1c2230;
  --mjs-modal-fg: #e8ebf1;
  --mjs-modal-muted: #a7b0c0;
  --mjs-modal-radius: 10px;
  --mjs-modal-shadow: 0 10px 40px rgba(0,0,0,.6);
  --mjs-modal-backdrop: rgba(0,0,0,.7);
  --mjs-modal-border: #3a4254;
  --mjs-modal-input-bg: #131722;
  --mjs-modal-input-fg: #e8ebf1;
  --mjs-modal-btn-radius: 6px;
  --mjs-modal-confirm-bg: #3085d6;
  --mjs-modal-confirm-fg: #fff;
  --mjs-modal-deny-bg: #e0a020;
  --mjs-modal-deny-fg: #1c2230;
  --mjs-modal-cancel-bg: #2c3446;
  --mjs-modal-cancel-fg: #e8ebf1;
  --mjs-modal-error-bg: #3a1f22;
  --mjs-modal-error-fg: #f28b8b;
  --mjs-modal-icon-success: #4ade80;
  --mjs-modal-icon-error: #f87171;
  --mjs-modal-icon-warning: #fbbf24;
  --mjs-modal-icon-info: #60a5fa;
  --mjs-modal-icon-question: #9ca3af;
}
```

### Raccourci global — `µmodal`

`µmodal` est le raccourci global de `µ.modal` (même convention que `µRouter`/`µStore`) : les deux écritures sont strictement interchangeables pour tout ce qui suit.

### Raccourcis — `µmodal.success/error/info/warn`

Quatre fabriques prêtes à l'emploi, une par icône, chacune acceptant soit un **message** (chaîne), soit un **objet** d'options `µ.modal.fire` fusionné par-dessus ses défauts (l'objet gagne) :

```civet
µmodal.success('Enregistré')
µmodal.error({ title: 'Échec', text: 'Le serveur n\'a pas répondu.' })
```

| Raccourci | Icône | Défauts |
|---|---|---|
| `µmodal.success(arg)` | `success` | `timer: 2000`, `showConfirmButton: false` |
| `µmodal.info(arg)` | `info` | `timer: 2000`, `showConfirmButton: false` |
| `µmodal.warn(arg)` | `warning` | `timer: 2000`, `showConfirmButton: false` |
| `µmodal.error(arg)` | `error` | bloquante — ni `timer`, ni bouton masqué (`showConfirmButton` reste à son défaut `true`) |

Les trois premiers s'auto-ferment (2 secondes) sans réclamer de clic ; une erreur, elle, reste affichée jusqu'à ce que l'utilisateur la ferme lui-même. Les quatre rendent la **même promesse** que `µ.modal.fire` — ce sont de simples fabriques par-dessus.

### Toasts — `µmodal.notify`

```civet
µmodal.notify(message, options?) → { close() }
```

Une notification empilée, **en haut à droite** de l'écran par défaut (position réglable, cf. `µ.config.notifyPosition` ci-dessous — plusieurs toasts coexistent), avec une croix de fermeture et une barre de vie animée qui matérialise le décompte avant disparition automatique.

| Option | Type | Défaut | Effet |
|---|---|---|---|
| `type` | chaîne — `success`, `error`, `warning` ou `info` | `info` | choisit l'icône, le titre par défaut, la couleur du dégradé + de la barre de vie, et le rôle ARIA (`error` → `role="alert"` ; les trois autres → `role="status"` + `aria-live="polite"`) |
| `title` | chaîne ou valeur fausse | titre par défaut du `type` (`Succès`/`Erreur`/`Attention`/`Info`) | titre en gras au-dessus du message ; une chaîne l'impose, une valeur fausse (`false`, `''`, `null`) retire le titre — toast compact, une seule ligne |
| `duration` | nombre (ms) | `µ.config.notifyDuration` (`4000` par défaut) | délai avant retrait automatique ; `0` = **permanent** (ni barre de vie, ni auto-fermeture — seuls la croix ou `close()` le retirent) |
| `sound` | booléen ou chaîne | — | surcharge ponctuelle de la couche sonore (ci-dessous) pour ce seul appel |

`notify()` rend `{ close() }` — de quoi retirer la notification par code, en plus de la croix.

### Position des toasts — `µ.config.notifyPosition`

```civet
µconfig.notifyPosition = 'top-right'                     # défaut
µconfig.notifyPosition = 'quarter-bottom-left'
µconfig.notifyPosition = { top: '80px', right: '12px' }   # placement libre, en longueurs CSS
```

Huit préréglages : `top-right` *(défaut)*, `top-left`, `bottom-right`, `bottom-left`, et leurs quatre variantes `quarter-top-right`/`quarter-top-left`/`quarter-bottom-right`/`quarter-bottom-left` — ancrées à 25&nbsp;% de la hauteur de l'écran (côté haut ou bas) plutôt que collées au bord. Un objet `{ top?, right?, bottom?, left? }` de longueurs CSS (`'80px'`, `'2rem'`…) place la pile au pixel près, hors de tout préréglage. Une pile ancrée en **bas** empile ses toasts vers le **haut** (le plus récent pousse les précédents) — l'inverse d'une pile ancrée en haut ; un placement libre, lui, n'a pas de préréglage pour le décider et suit `notifyFlow` ci-dessous. La valeur est relue à **chaud** : un changement s'applique à la prochaine notification, sans rien redémarrer.

### Sens du flux — `µ.config.notifyFlow`

```civet
µconfig.notifyFlow = 'auto'   # défaut — le préréglage de position décide
µconfig.notifyFlow = 'up'     # le nouveau toast arrive AU-DESSUS des précédents
µconfig.notifyFlow = 'down'   # le nouveau toast arrive EN DESSOUS
```

L'**ordre d'empilement**, à ne pas confondre avec le sens de croissance de la pile — celui-là est dicté par l'ancrage (une pile collée en bas grandit forcément vers le haut, quoi qu'on demande ici). `notifyFlow` répond seulement à : « le prochain toast, il apparaît de quel côté des précédents ? ». En `'auto'`, les ancrages bas empilent vers le haut et tous les autres vers le bas. Le réglage sert surtout au **placement libre** `{ top, bottom… }`, qui n'a aucun préréglage pour trancher. Relu à chaud comme les autres, valeur inconnue → avertissement et repli sur `'auto'`.

### Durée par défaut des toasts — `µ.config.notifyDuration`

```civet
µconfig.notifyDuration = 4000   # défaut, en ms
µconfig.notifyDuration = 0      # tous les toasts deviennent permanents par défaut
```

Durée par défaut d'un toast avant retrait automatique. `opts.duration`, posé sur un appel `notify()` précis, **prime** sur ce réglage global (cf. tableau ci-dessus). `0` — au global comme par appel — rend le toast **permanent** : ni barre de vie, ni auto-fermeture, seuls la croix ou `close()` le retirent.

### File des toasts — `µ.config.notifyMax`

```civet
µconfig.notifyMax = 5        # défaut — 5 toasts affichés au maximum en même temps
µconfig.notifyMax = false    # aucun plafond de NOMBRE — 0 ou Infinity itou
```

Passé ce plafond, les toasts suivants ATTENDENT en file FIFO plutôt que de s'afficher tout de suite — zéro éviction, un toast déjà affiché n'est jamais chassé pour faire de la place à un autre (un toast `duration: 0`, permanent, occupe ainsi sa place tant que la croix ou `close()` ne l'a pas fermé). Une place libérée fait avancer la file : le toast suivant s'affiche avec sa durée de vie PLEINE, jamais un reliquat — le son automatique de `notify()` joue à ce moment précis, jamais à la mise en file. La poignée `{ close() }` rendue par `notify()` reste valide pour un toast encore en attente : la fermer avant l'affichage le retire simplement de la file, il ne s'affichera jamais. Le plafond est relu à chaque affichage — un changement à chaud profite au prochain toast qui se présente, jamais rétroactivement.

**La place à l'écran est un second plafond, toujours actif.** Un toast qui ferait sortir la pile de la fenêtre n'est pas affiché : il reste en file, exactement comme s'il avait buté sur `notifyMax`, et apparaît quand une place se libère. Le plafond réel est donc le plus bas des deux — `notifyMax` et ce que la fenêtre peut montrer —, ce qui rend `false` (« aucun plafond de nombre ») sûr même sur un petit écran : la pile ne déborde jamais, et rien n'est perdu. Ce sont les toasts eux-mêmes qui sont mesurés, jamais leur conteneur : un placement libre qui pose `top` **et** `bottom` donne à celui-ci une hauteur imposée par la fenêtre, que son contenu déborde ou non. Seul le bord **opposé à l'ancrage** est contrôlé — le bord ancré est votre choix, pas l'affaire du framework. Trois garde-fous, donc : un toast SEUL n'est jamais refusé, même s'il dépasse à lui tout seul (mieux vaut un toast qui dépasse qu'un écran vide) ; une pile dont le point d'ancrage est lui-même hors de l'écran (`{ top: '700px' }` dans une fenêtre de 300&nbsp;px) sort forcément avec lui, aucun calcul ne rattrape ça ; et sans mise en page mesurable (rendu serveur), seul `notifyMax` s'applique.

### Modale d'attente — `µmodal.wait`

```civet
µmodal.wait(message?) → { close() }
```

Une modale bloquante avec spinner, sans bouton, sans fermeture au clic hors modale ni à Échap (`allowOutsideClick`/`allowEscapeKey` à `false`) — seul le code appelant la referme, via le `close()` rendu ou `µ.modal.close()`. Argument optionnel : une chaîne (titre) ou un objet fusionné sur les défauts (`title: 'Veuillez patienter…'`, `spinner: true`).

### Fermeture programmatique — `µ.modal.close`

```civet
µmodal.close(result?)
```

Ferme la modale **courante** (une seule ouverte à la fois) sans attendre un clic, avec `dismiss: 'close'` — c'est ce qu'utilise `wait` en interne (`notify` a son propre retrait, via la poignée `{ close() }` qu'il rend), et ce qu'une appli peut appeler directement (un événement serveur qui rend une attente inutile, par exemple). `result` se fusionne par-dessus le résultat par défaut (`{ isConfirmed: false, isDenied: false, isDismissed: true, value: undefined, dismiss: 'close' }`) — les clés fournies l'emportent. Sans modale ouverte : ne fait rien.

### Sons — `µ.config.modalSound`

Une petite couche sonore, **coupée par défaut** :

```civet
µconfig.modalSound = false                                                    # défaut — silence total
µconfig.modalSound = true                                                     # 4 signatures embarquées (success/error/warning/info) : une modale joue celle de son icône, un toast celle de son type (info par défaut)
µconfig.modalSound = { success: '/sounds/ok.mp3', error: '/sounds/ko.mp3' }   # fichiers par type ; type absent → repli signature embarquée
```

`true` joue une courte signature synthétisée (oscillateurs WebAudio, zéro fichier à livrer) — une par icône pour une modale, une par TYPE pour un toast (`notify()`) : succès deux notes, avertissement deux bips, info une note, erreur la scie  — un toast sans `type` est un toast `info`, il joue donc la note d'info ; le ping `notify` ne sert qu'à `µsound()` sans argument. Un objet peut mélanger fichiers et repli : les types non couverts retombent sur leur signature embarquée. Surcharge **par appel**, prioritaire sur la config globale : `µmodal.error({ text: '…', sound: false })`, `sound: true` (joue la signature embarquée du type, même si la couche globale est coupée), ou un nom de signature (`sound: 'error'`), ou un chemin de fichier (`sound: '/autre.mp3'`). Politique **autoplay** des navigateurs respectée : un son avant le premier geste de l'utilisateur sur la page est simplement silencieux, jamais une erreur.

### Son à la demande — `µ.sound`

```civet
µsound('success')                # une des 5 signatures — success/error/warning/info/notify (défaut)
µsound('success', false)         # silence pour cet appel
µsound('success', '/ok.mp3')     # ce fichier précis, quel que soit µconfig.modalSound
```

`µ.sound(type?, override?)` (sucre global `µsound`) joue une des 5 signatures sonores de la couche modale n'importe où dans l'app — pas seulement au fil d'une modale ou d'un toast — et joue TOUJOURS, même avec `µ.config.modalSound: false` : ce réglage ne coupe que les sons **automatiques** des modales/toasts, jamais un appel direct à `µ.sound`. `type` vaut `'notify'` par défaut ; si `µ.config.modalSound` est un objet `{ type: 'fichier.mp3' }`, c'est le fichier du type demandé qui joue, sinon la signature WebAudio embarquée. `override`, par appel, prime sur tout le reste : `false` (silence), un chemin de fichier, ou le nom d'une autre signature. Un `type` qui ne correspond à aucune des 5 signatures avertit en console, sans rien jouer. Fonction du module `modal` : absente du bundle si l'app exclut ce module au tree-shake.

### Variables des toasts

En plus des `--mjs-modal-*` ci-dessus, les toasts posent leurs propres variables — certaines replient sur la `--mjs-modal-*` correspondante si elle n'est pas déclarée (`--mjs-toast-border`, `--mjs-toast-success`/`-error`/`-warning`/`-info`), `--mjs-toast-bg`/`--mjs-toast-fg`/`--mjs-toast-radius`/`--mjs-toast-shadow` exceptés (variables propres, sans équivalent modale) :

| Variable | Rôle | Repli |
|---|---|---|
| `--mjs-toast-bg` | fond du toast | dégradé du type vers `--mjs-toast-bg-base` (`#22242F`) |
| `--mjs-toast-fg` | texte du toast | `#fff` |
| `--mjs-toast-color` | couleur pilote — icône, dégradé de fond et barre de vie en même temps, posée automatiquement par le type (`success`/`error`/`warning`/`info`) | `--mjs-toast-border` |
| `--mjs-toast-border` | repli neutre de `--mjs-toast-color` (toast sans classe de type) | `--mjs-modal-border` |
| `--mjs-toast-success` / `--mjs-toast-error` / `--mjs-toast-warning` / `--mjs-toast-info` | teinte `--mjs-toast-color` selon `type` (icône, dégradé et barre suivent ensemble) | icône `--mjs-modal-icon-*` correspondante |
| `--mjs-toast-shadow` | ombre portée du toast — double couche à étalement négatif, resserrée sous la boîte plutôt qu'en halo débordant | `0 10px 30px -8px var(--mjs-shadow), 0 2px 8px -4px var(--mjs-shadow)` |
| `--mjs-toast-radius` | arrondi du toast | `5px` |
| `--mjs-toast-bg-base` | extrémité sombre du dégradé de fond | `#22242F` |
| `--mjs-toast-width` | largeur de la pile — bornée en plus par `calc(100vw - 32px)`, la pile ne déborde donc jamais d'une fenêtre étroite | `400px` |
| `--mjs-toast-cols` | colonnes de la grille du toast — icône, contenu, croix | `70px 1fr 70px` |
| `--mjs-toast-padding` | marge intérieure du toast | `10px` |
| `--mjs-toast-icon-size` | côté du carré de l'icône | `28px` |
| `--mjs-toast-title-size` | corps du titre | `x-large` |
| `--mjs-toast-entree-duree` | durée de l'animation d'entrée (glissé avec dépassement, depuis le bord d'ancrage) | `.3s` |

Sans déclaration de `--mjs-toast-radius`, le toast garde un rayon fixe de `5px`, indépendant de celui de la boîte modale (`--mjs-modal-radius`, `8px` par défaut).

`--mjs-toast-duration` existe aussi, mais c'est un canal **interne** (posé par `notify()` pour piloter la durée de la barre de vie) — rien à en attendre côté thème.

Le fond et le texte du toast sont fixes (dégradé vers `--mjs-toast-bg-base`, `#22242F` par défaut, texte `#fff`), indépendants du thème clair/sombre de la page ; seuls `--mjs-toast-border`/`--mjs-toast-shadow` suivent encore les variables `--mjs-border`/`--mjs-shadow` de la modale (cf. [30 · Modules cœur](30-modules-coeur.md) § *Thème clair/sombre*). Les accents par type (`success`/`error`/`warning`/`info`, `--mjs-modal-icon-*` ci-dessus) restent, eux, inchangés d'un thème à l'autre.

Soumettre un `<form>` **désactive automatiquement** ses boutons de soumission (+ pose `aria-busy="true"` sur le formulaire) le temps de la requête — restauré dans tous les cas (succès, erreur, 422). Opt-out : `mjs-no-disable` sur le `<form>`. Après tout remplacement de page (clic, formulaire, retour arrière), le **focus** est déplacé automatiquement vers le nouveau contenu (`[autofocus]` > premier `<h1>` > le conteneur lui-même) — un lecteur d'écran ne suit pas un remplacement de DOM sans ce geste explicite.

Une navigation UJS émet en plus trois événements de cycle — `mjs:before-visit`, `mjs:visit`, `mjs:load` — mais sur `document`, jamais sur le composant : ce chapitre couvre les événements du composant, pas ceux-là. Détail des noms, du contenu de `detail` et de l'ordre : [Navigation (UJS)](21-navigation.md) → *Événements de cycle de navigation*.

> 🔗 Détails complets de la couche de navigation (interception liens/formulaires, cache de pages, CSRF, `µnav` réactif) : [Navigation (UJS)](21-navigation.md).

---

📚 **Apprendre en pratiquant** : ce chapitre correspond au **Tuto interactif n°5 (Événements)** — handlers DOM, handlers inline, modificateurs, événements de composant (`µemit`), transfert d'événements.
