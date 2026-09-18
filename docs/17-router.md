# 17 · Router (client)

> 📚 Tuto interactif correspondant : section **Routage** (introduction, pages, layouts, paramètres de route) et section **Routage avancé** (paramètres optionnels/rest, groupes, sortir des layouts). Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Le routeur de MJS (`µRouter`) opère **côté client**, *à l'intérieur* d'une page servie par le backend : il échange des sous-vues selon le hash de l'URL, **sans rechargement**. C'est un routage *hash-based* (`#/chemin`) — complémentaire du routage serveur (Rails sert la page racine ; le client navigue dedans).

## L'objet `@routes`

Un composant déclare ses routes internes via `@routes`, un objet à **deux niveaux** : `{ 'id-de-vue': { '/chemin': 'nom-composant' } }`. La clé externe désigne une zone `<@view>`, la clé interne un chemin, la valeur le composant à y injecter.

```html
<script>
  @routes =
    'app-view':
      '/':         'home-page'
      '/about':    'about-page'
      '/settings': 'settings-page'
</script>
```

Ici, quand l'URL est `#/`, MJS injecte `<mjs-home-page>` dans la vue `app-view` ; sur `#/about`, `<mjs-about-page>` ; etc. Le nom de composant est résolu en tag : `'home-page'` → `<mjs-home-page>` (et donc le fichier `home-page.mjs`).

**Le fichier qui déclare `@routes` (celui de l'exemple ci-dessus) se nomme `<nom>.page.mjs`** — même règle pour un fichier qui porte un bloc `<routes target="…">` ou une balise `<@view>` (les deux formes suivantes de ce chapitre). Hors d'un fichier `.page.mjs`, ces trois formes sont un refus de compilation : le message nomme le fichier, la forme trouvée et le renommage attendu. Le marqueur `.page` est retiré du nom AVANT toute dérivation — tag, classe, alias court, clé de manifeste — un `accueil.page.mjs` produit exactement le même `<mjs-accueil>` qu'un `accueil.mjs` en produirait. Une des trois formes qui vit dans un partiel inclus (`<@include nom>`, fichier `_nom.mjs`) ne compte pas pour LUI : c'est le fichier HÔTE qui doit porter le marqueur.

Les modules de simple **destination** (`home-page.mjs`, `about-page.mjs`, `settings-page.mjs` ci-dessus) restent libres de leur nom — le suffixe `-page` qu'ils portent ici est une habitude qui les distingue d'un coup d'œil dans la table de routes, jamais une obligation : ils ne déclarent eux-mêmes ni `@routes`, ni `<routes>`, ni `<@view>`.

> ⚠️ **`@routes` et le hook `µurlChange` rendent chacun, indépendamment, le composant *router-aware*.** L'un ou l'autre — pas besoin des deux — suffit à l'enregistrer auprès de `µRouter`. Un composant qui ne déclare **ni l'un ni l'autre** ignore les changements d'URL, et ses `<@view>` (s'il en a) **ne s'injectent jamais**.

## Le bloc `<routes target="…">` — routes FIXES

Pour une table qui ne dépend d'aucun calcul (pas de boucle sur un sommaire, pas de génération dynamique), le bloc racine `<routes target="…">` est une alternative déclarative à `@routes` : une route par ligne, hors du `<script>`.

```html
<routes target="app-view">
  /              home-page
  /guide/:id     guide-page
  /archive/(:an) archive-page
  /docs/*        docs-shell
</routes>

<@view app-view>
```

- `target="…"` est **obligatoire** : c'est l'id de la `<@view>` (l'outlet) que ces routes alimentent.
- Une route par ligne : le **chemin**, puis des espaces ou tabulations, puis le **nom du composant** (sans le préfixe `mjs-`, comme dans `@routes`). Ligne vide ignorée ; ligne commençant par `#` = commentaire.
- Le chemin accepte exactement ce que `@routes` accepte : segments littéraux, `:param`, `(:param)` et `(littéral)` optionnels (à n'importe quelle position), `*` catch-all (en fin de route uniquement).
- Le bloc est **répétable** — un bloc par `<@view>` à alimenter, chacun avec son propre `target`.

Le bloc compile en `this.routes = { '<target>': { '<chemin>': '<composant>', … } }`, posé **avant** le code du `<script>` : le composant devient router-aware, et le préchargement compile-time des composants de route s'applique comme avec `@routes`.

Le `<script>` peut **compléter** la table posée par le bloc :

```html
<script>
  @routes['app-view']['/extra'] = 'extra-page'
</script>
```

**Réassigner** `this.routes` (`@routes = …`) dans le `<script>` alors qu'un bloc `<routes>` est présent reste **autorisé** : le script s'exécute après le bloc, sa table **remplace** celle du bloc, en tout ou en partie. C'est le geste à faire quand tu veux reprendre la main entièrement — sur une table calculée à partir d'une source de données, par exemple.

Comme l'écrasement est invisible à la lecture, la compilation émet un **avertissement** (non bloquant) pour le signaler. Si ton intention était seulement d'**ajouter** des routes à la table du bloc, écris `@routes['cible']['/x'] = 'composant'` (ci-dessus) : pas d'écrasement, pas d'avertissement.

**Quand utiliser lequel** : `<routes>` pour une table écrite à la main, connue à l'avance (le cas courant) ; `@routes` reste réservé aux tables **calculées** — construites en boucle depuis une source de données (un sommaire de documentation qui fabrique ses ~300 routes, par exemple).

## La zone `<@view>`

`<@view nom>` marque l'**emplacement d'injection** : le routeur y place le composant correspondant au chemin courant. L'identifiant doit correspondre à une clé externe de `@routes`.

```html
<nav>
  <a href="#/">Accueil</a>
  <a href="#/about">À propos</a>
  <a href="#/settings">Paramètres</a>
</nav>

<@view app-view>
```

La navigation se fait par des **liens à hash** : `<a href="#/about">`. Le routeur les intercepte (le `#` ne déclenche aucun rechargement serveur) et procède à l'échange de vue.

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi un <code>#</code> dans les liens&nbsp;?</summary>

Un lien classique `<a href="/about">` demande au navigateur d'aller chercher une **nouvelle page** au serveur : rechargement complet. Le `#` (le *hash*) est différent : c'est une ancre **interne** à la page courante. Changer le hash ne recharge rien — le navigateur prévient juste la page « le hash a changé ».

MJS écoute ce signal : sur `#/about`, il regarde votre `@routes`, trouve `about-page`, et **remplace** le contenu du `<@view>` par ce composant. Tout se passe dans la page déjà chargée, instantanément.

</details>

## Layouts — vues imbriquées

Comme la valeur de `@routes` est un composant comme un autre, ce composant-page peut **lui-même** déclarer `@routes` + `<@view>`. On compose ainsi des layouts (un cadre persistant — nav, footer — autour d'une zone qui change).

```html
<script>
  @routes =
    'main':
      '/': 'home-page'
</script>

<header><@nav></header>
<main><@view main></main>
<footer>© 2026</footer>
```

> 💡 Une route matche l'adresse qu'elle décrit, **exactement** : `'/a'` ne matche que `/a`. Pour qu'un layout reste en place pendant que sa vue interne suit `/section/detail`, déclarez-le sur un **sous-arbre** : `'/section/*'` — le `*` dit « cette route couvre tout ce qui commence ici », et le reste du chemin devient lisible dans `&rest` (chaîne) et `&all` (tableau). En cas d'ambiguïté (`/a` matché à la fois par `'/a'` et `'/a/*'`), le chemin **le plus spécifique** gagne — ici `'/a'`.

## Routes paramétrées — `:param` et le symbole `&id`

Un segment préfixé par `:` est **capturé** : `'/posts/:id'` matche `/posts/42`. La page routée le lit **directement** via le **symbole de param `&id`** — réactif, remis à jour à chaque navigation, zéro câblage :

```html
<script>
  @routes =
    'main':
      '/posts/:id': 'post-page'
</script>

<@view main>
```

```html
<!-- post-page.mjs — rien à déclarer, &id lit le param -->
<h2>Billet n°{&id}</h2>
```

`&id` est la forme courte de `µurl.params.id` (cf. section suivante), exactement comme `$x` abrège l'état. Le symbole `&` distingue un param d'URL de *votre* état `$`, et n'injecte **aucun attribut DOM** — aucune collision avec un vrai `id="…"` posé sur la balise. Plusieurs segments paramétrés sont possibles (`'/posts/:tag/:page'`), un segment `*` capture tout le reste dans `&rest` (chaîne) et `&all` (tableau) — cf. section suivante « Sous-arbre » — et la valeur capturée est **décodée** (`decodeURIComponent`).

> ⚠️ `&id` est toujours une **chaîne** (`'42'`, pas `42`) : c'est un segment d'URL. Convertissez explicitement si besoin (`Number(&id)`).

<details>
<summary>🎓 <b>Pour débutants</b> — où récupérer le paramètre&nbsp;?</summary>

- **Dans la page injectée** (`post-page`) : lisez simplement `&id` dans le template ou le script — c'est réactif, la valeur suit chaque navigation. C'est le chemin normal.
- **Pour un effet de bord** (fil d'Ariane, titre, analytics) : le hook `µurlChange (path, params)->`, appelé sur les composants *router-aware* (ceux qui ont `@routes` et/ou `µurlChange`) à chaque changement d'URL. Inutile pour *afficher* un param — `&id` suffit.

</details>

### Segment optionnel façon Rails — `(:id)`

Un segment entre **parenthèses** est **facultatif** : `'/posts/(:id)'` matche **aussi bien** `/posts` que `/posts/42`, sans écrire deux routes. Absent de l'URL, le param correspondant vaut explicitement `undefined` :

```html
<script>
  @routes =
    'main':
      '/posts/(:id)': 'posts-page'   # liste (sans id) ET détail (avec id) : même composant
</script>
```

```html
<!-- posts-page.mjs -->
{if &id}
  <h2>Billet n°{&id}</h2>
{else}
  <h2>Tous les billets</h2>
{end}
```

Un littéral entre parenthèses (`'/(archive)/posts'`) est également facultatif, sans capturer de valeur — utile pour un préfixe d'URL optionnel. La parenthèse peut se trouver **n'importe où** dans la route (pas seulement en fin de chemin) : `/a/(:x)/b` matche `/a/b` (x = `undefined`) **et** `/a/42/b` (x = `'42'`).

### Sous-arbre — `*` et les symboles `&rest` / `&all`

Un segment `*` capture **tout le reste du chemin**, décodé segment par segment, sous DEUX formes complémentaires : `&rest`, la queue rejointe par `/` (une **chaîne**, pratique pour reconstruire une URL), et `&all`, le **tableau** des segments (pratique pour itérer ou compter — `&all.join('/')` redonne exactement `&rest`). C'est la façon de dire « cette route couvre tout ce qui commence ici » — et donc la façon d'écrire un **layout** qui doit rester monté pendant que ses enfants routent la suite :

```html
<script>
  @routes =
    'main':
      '/':        'home-page'
      '/admin/*': 'admin-layout'   # /admin, /admin/users, /admin/users/42…
</script>
```

```html
<!-- admin-layout.mjs — sur /admin/users/42 : &rest = 'users/42', &all = ['users', '42'] -->
<a href="#/admin/{&rest}">Actualiser</a>
<p>Profondeur : {&all.length}</p>
{for segment in &all}
  <span class="fil">{segment}</span>
{end}
```

`'/admin'` **seul** ne matcherait que `/admin` : une route décrit une adresse **exacte**, tous ses segments et tous ceux de l'URL doivent être consommés. C'est ce qui rend `/admin/nimportequoi` détectable au lieu d'être servi comme `/admin`.

## Aucune route ne correspond

Si l'URL courante ne matche **aucune route d'aucun composant routé**, ce n'est pas un état normal : le framework l'écrit en console (`[Router] Aucune route ne correspond à '…'`) et affiche un panneau **Page introuvable** dans la première `<@view>` — plutôt qu'un écran blanc sans explication. Sous `µ.debug`, le panneau liste aussi les routes déclarées.

La bonne façon de servir *votre* 404 est une **route de repli**, qui rend ce cas inatteignable :

```html
<script>
  @routes =
    'main':
      '/':       'home-page'
      '/about':  'about-page'
      '/*':      'not-found-page'   # tout le reste
</script>
```

Le vidage d'**une seule** zone reste silencieux : une page à plusieurs `<@view>` aux tables indépendantes a le droit de n'en remplir qu'une (une barre latérale routée sur les seules pages qui la méritent). Seul le cas « rien nulle part » déclenche l'erreur. Réglage : `µ.config.routeNotFound` — `'error'` *(défaut)*, `'warn'` (console seule) ou `'silent'`.

## Préchargement des liens — `@preload`

Un lien routé (`<a href="#/produit/42">`) peut précharger sa destination **avant** le clic : le clic devient instantané (le module — ou la page — est déjà là). Le réglage se fait en cascade sur **3 niveaux**, du plus large au plus précis, sur **deux axes** indépendants :

- **`view`** — liens routés MJS (`#/…`) : précharge le **module** du composant-page (import quasi gratuit).
- **`page`** — liens inter-pages (routage serveur, cf. [SSR](19-ssr.md)) : précharge le **HTML** (coûte un aller-retour réseau) — opt-in, coûteux.

| Niveau | Où | Forme |
|---|---|---|
| Config | `mjs.config.json`, clé `preload` | `{ "view": "hover", "page": "off" }` (ou raccourci chaîne, ex. `"hover"` ≡ `{view:"hover", page:"off"}`) |
| Module | racine du composant routeur | `@preload hover` (ou `@preload = "on"`, `@preload="off"`) |
| Lien | sur le `<a>` | `<a href="#/produit/42" @preload="on">` |

Trois modes : **`off`** (jamais), **`hover`** (au survol du lien), **`on`** (dès l'apparition du lien dans le DOM, sans attendre le survol). Défauts : `view: "hover"`, `page: "off"`.

```json
{ "preload": "hover" }
```

```html
<script>
  @preload on
</script>
```

```html
<a href="#/produit/42" @preload="on">Produit vedette</a>
```

> 🔗 La couche de préchargement HTML (`page`) partage son moteur avec la navigation UJS (interception de liens, zone de montage, cache de pages) — détails au chapitre [Navigation (UJS)](21-navigation.md).

## L'URL réactive — `µurl`

Le routeur maintient un objet réactif dédié, **`µurl`** (forme courte de `µ.url`, namespace framework — pas votre store `$$`). Lisible partout, sans import : tout composant qui lit un champ au rendu se re-rend quand il change.

```
µurl.href      # URL complète
µurl.path      # chemin de route (ce qui suit le #)
µurl.params    # params de route matchés — sucre de lecture : &id
µurl.query     # query string parsée, ex. {tri: 'date'}
µurl.hash      # fragment brut
```

Une clé dupliquée dans la query (`?a=1&a=2`) garde la **dernière** valeur : pas de support multi-valeurs (tableau).

Navigation programmatique : **`µRouter.to '/produits/42'`** — jamais de `#`, le routeur travaille par définition sur le fragment. `µurl` se met à jour dans la foulée.

## Réagir à la navigation — `µurlChange`

`µurlChange (path, params)->` est appelé à **chaque** changement d'URL, sur tout composant *router-aware*. Cas d'usage : mettre à jour un fil d'Ariane, activer un lien de nav, ajuster le titre de page, déclencher un événement d'analytics.

> 🔗 La signature, l'ordre d'exécution et le piège de la forme **sans `=`** (`µurlChange (path, params)->`, jamais `= ->`) sont détaillés au chapitre [Cycle de vie](16-cycle-de-vie.md).

> 📌 **Portée de cette doc** : il s'agit du routage **client** (sous-vues d'une page). Le routage **serveur** (Rails — `routes.rb`, contrôleurs, params de route côté backend, modes de rendu SSR) relève de la doc full-stack séparée.

## Transitions de page — `@viewTransition`

Quand le routeur client permute une vue (`<@view>`), `@viewTransition` enveloppe la permutation dans `document.startViewTransition` : le navigateur photographie l'**avant** et l'**après**, puis anime le passage — un fondu croisé par défaut, zéro CSS à écrire.

> 🔗 À ne pas confondre avec `@transition` ([Transitions & animations](10-transitions.md)) : cette directive anime l'entrée/sortie d'un **élément** au gré d'un `{if}`/`{for}`/`{key}`. `@viewTransition` opère un cran au-dessus, au niveau de la **page** entière — c'est la permutation de vue elle-même qui est animée, pas un nœud isolé.

### Les niveaux de réglage

Le réglage se fait en cascade — le plus précis l'emporte. Aux niveaux **composant routeur** et **page routée**, `@viewTransition` est un attribut du `<style>` de base (celui sans `name=`), pas une directive de racine — sa valeur suit une syntaxe **objet**, calquée sur `@transition.fly={ y: 200, duration: 2000 }` — mini-grammaire **texte** (pas du JS évalué) :

```
<style @viewTransition[.<nom>[={ direction: …, duration: …, priority: … }]]>
```

| Niveau | Où | Forme |
|---|---|---|
| Config | `mjs.config.json` | `"viewTransition": "fade"` ou `"viewTransition": "cube={ direction: left, duration: 600, priority: 2 }"` *(**chaîne** uniquement, aucun booléen — `"none"` = désactivé, défaut)* |
| Composant routeur | attribut du `<style>` de base, dans le composant qui déclare `@routes` | `<style @viewTransition>` (nue = activer avec héritage) ou `<style @viewTransition.none>` — **seul niveau** où la forme nue existe |
| Balise | sur une `<@view>` | `<@view main @viewTransition.fade>` ou `<@view main @viewTransition.none>` — un **nom** est obligatoire ici, la forme nue n'a pas d'effet propre sur une `<@view>` (erreur de compilation, cf. encadré ci-dessous) |
| **Page routée elle-même** | attribut du `<style>` de base, dans le composant **injecté** dans la vue (`galerie-page.mjs`, `photo-page.mjs`…) | `<style @viewTransition.<nom>={ priority: … }>` — le niveau le **plus spécifique**, cf. *Priorité départ/arrivée* ci-dessous |

Dès qu'**au moins une vue concernée** résout « on », **toute** la permutation de la navigation est enveloppée : `startViewTransition` est une API globale au document — une seule transition par navigation, jamais une par vue.

> ⚠️ **`on`/`off` n'existent plus en toutes lettres.** La forme **nue** (`@viewTransition` sans valeur) active avec héritage — **exclusivement en attribut du `<style>` de base d'un module** ; `="none"` coupe à tous les niveaux, y compris la config. Écrire `@viewTransition.off`, `@viewTransition.on`, la forme à guillemets (`@viewTransition="cube"`), ou la forme **nue sur une `<@view>`** (`<@view main @viewTransition>`, sans nom — sans effet propre, réservée au `<style>` de base) sont des **erreurs de compilation** qui pointent vers la syntaxe actuelle (migration automatiquement orientée par le message).

> 💡 Le réglage de config est aussi exposé au runtime : `µ.viewTransition` (chaîne, modifiable à chaud — `µ.viewTransition = "fade"`, ou `"none"` pour couper).

Deux façons équivalentes d'activer les transitions pour tout un routeur — au choix, sans les cumuler :

```json
{ "viewTransition": "fade" }
```

— ou, sans toucher à la config, directement sur le composant routeur :

```html
<script>
  @routes =
    'main':
      '/':      'galerie-page'
      '/photo': 'photo-page'
</script>

<nav><a href="#/">Galerie</a> <a href="#/photo">Photo</a></nav>
<@view main>

<style @viewTransition>
</style>
```

Naviguer entre « Galerie » et « Photo » joue désormais un fondu croisé automatique — aucune classe, aucune keyframe à écrire.

### Options — `direction`, `duration`, `priority` (clés longues ou courtes)

Un nom de préréglage accepte un bloc d'options `={ … }`, en paires `clé: valeur` séparées par des virgules (guillemets facultatifs autour des valeurs). Chaque clé a une forme **courte**, mixable librement avec la forme longue — jamais les **deux** pour la **même** option (erreur « clé en double ») :

```html
<style @viewTransition.cube={ direction: left, duration: 600, priority: 2 }>
</style>
```
```html
<style @viewTransition.cube={ dir: left, dur: 600, p: 2 }>      <!-- équivalent, clés courtes -->
</style>
```
```html
<style @viewTransition.cube={ dir: left, duration: 600, p: 2 }> <!-- mixe toléré -->
</style>
```

| Clé | Forme courte | Valeurs | Effet |
|---|---|---|---|
| `direction` | `dir` | `left` / `right` / `up` / `down` | réservée aux 8 bases directionnelles — **seule** façon d'orienter une base |
| `duration` | `dur` | un **nombre nu**, en millisecondes (comme `setTimeout` — aucune unité) | **remplace** la durée par défaut du préréglage — un facteur (`duration demandée ÷ durée par défaut de la base`) met à l'échelle **proportionnellement** chaque jeton temporel du CSS généré (durées ET délais de cascade `bars`/`blocks`) ; pour les rideaux, les minuteries internes (couverture/révélation) suivent le même facteur |
| `priority` | `p` | entier ≥ 0 | façon `z-index`, défaut `1` — cf. *Priorité départ/arrivée* ci-dessous ; à égalité, la page de **départ** gagne |

> ⚠️ **Aucun raccourci `nom:direction`.** La direction s'écrit **uniquement** via la clé d'option — `@viewTransition.cube:left` est une **erreur de compilation** (« la direction ne s'écrit plus dans le nom »), aux quatre positions où la directive s'écrit, nom de morph compris : écris `@viewTransition.cube={ dir: left }`.
>
> ⚠️ **Le NOM du préréglage n'est vérifié à aucun niveau** — ni sur `<style>`, ni sur `<@view>`, ni sur une balise. `µ._vtPresets` est un dictionnaire que l'appli peut garnir à son démarrage (`µ._vtPresets.diamant = '…'`), et un nom qui n'existe pas encore au build existera peut-être au runtime : le refuser fermerait la porte à un préréglage maison. Un nom qu'on ne retrouve pas à l'animation donne un `µ.warn` de console et aucune transition. Toute clé `direction`/`dir`, `duration`/`dur`, `priority`/`p` — ou la même option posée deux fois (forme courte **et** longue) — est aussi une erreur (avec suggestion de proximité sur une faute de frappe, ex. `duraction` → « tu voulais dire 'duration'/'dur' ? »).

### Priorité départ/arrivée — quand les deux pages ne sont pas d'accord

Une navigation change **deux** pages à la fois : celle qu'on **quitte** (départ) et celle qu'on **affiche** (arrivée). Rien n'empêche chacune de déclarer sa propre transition :

```html
<!-- galerie-page.mjs -->
<style @viewTransition.zoom>
</style>
```
```html
<!-- photo-page.mjs -->
<style @viewTransition.turn={ dir: left }>
</style>
```

Naviguer de la galerie vers la photo : lequel des deux noms joue, `zoom` ou `turn={ dir: left }` ? La règle :

1. **Par défaut, c'est la page de départ qui gagne** — peu importe ce que demande la page d'arrivée.
2. L'option **`priority`** (ou sa forme courte **`p`**), façon `z-index` (défaut `1`), donne une **priorité** — la plus grosse l'emporte, **quel que soit le côté** qui la porte :

```html
<style @viewTransition.turn={ dir: left, priority: 5 }>   <!-- cette page impose SA transition, même en tant qu'arrivée -->
</style>
```

| Départ | Arrivée | Résultat |
|---|---|---|
| `zoom` (priorité 1, défaut) | `turn={ dir: left }` (priorité 1, défaut) | **`zoom`** — égalité → le départ gagne |
| `zoom` (priorité 1) | `turn={ dir: left, priority: 5 }` | **`turn`** — l'arrivée impose sa priorité plus grande |
| `zoom={ priority: 9 }` | `turn={ dir: left, priority: 5 }` | **`zoom`** — le départ reste prioritaire, même explicitement |

La priorité se pose sur **n'importe quel niveau** de la cascade (`@viewTransition.<nom>={ priority: N }` en attribut du `<style>` de base d'une page, ou `<@view main @viewTransition.<nom>={ priority: N }>` côté outlet) — le niveau le plus spécifique de chaque côté (départ / arrivée) est résolu indépendamment avant comparaison.

> 💡 Ce départage n'existe **que** côté routeur (`<@view>`/pages). `@pageTransition` sur un `<a>` (section suivante, permutations **hors routeur**) reste une cascade à 2 niveaux simple (lien > config) : la page de destination n'étant pas forcément une page MJS déjà chargée, sa préférence n'est pas connaissable avant le clic.

### Élément partagé — un nom de transition sur une balise

Sur une balise **ordinaire** (pas une `<@view>`), `@viewTransition.nom` donne un **nom de transition** à l'élément — un raccourci compilé vers `@style.view-transition-name=…`. `nom` n'est ici **pas** limité à la bibliothèque de préréglages (n'importe quel identifiant `[a-zA-Z][a-zA-Z0-9_-]*`) et n'accepte **pas** de bloc d'options `={ … }` — `direction`/`duration`/`priority` n'ont de sens qu'aux niveaux de **navigation** (config, module, `<@view>`), pas sur un simple nom de morph. Deux éléments portant le **même nom** de part et d'autre d'une navigation sont automatiquement appariés : le navigateur les *morphe* l'un vers l'autre.

```html
<img src="…" @viewTransition.hero>   <!-- galerie-page.mjs — la vignette -->
<img src="…" @viewTransition.hero>   <!-- photo-page.mjs — l'image pleine page -->
```

Naviguer de la galerie vers la photo anime la vignette qui grossit jusqu'à occuper toute la vue. `@viewTransition.nom` ne prend qu'une étiquette **fixe** — pour un nom **calculé** ou **conditionnel**, passe par l'attribut de style natif `@style.view-transition-name` :

```html
<img src={item.thumb} @style.view-transition-name={'p-' + item.id}>       <!-- nom calculé, un par item d'un {for} -->
<img src={item.thumb} @style.view-transition-name{$featured}="hero">      <!-- nom posé seulement si $featured -->
```

> ⚠️ Sur une balise ordinaire, l'étiquette se pose **après le point** : `@viewTransition.hero`. La forme à guillemets `@viewTransition="hero"`, la forme calculée `@viewTransition={expr}` et la forme conditionnelle `@viewTransition{cond}="nom"` sont refusées à la compilation — passe par `@style.view-transition-name` pour un nom calculé ou conditionnel.

> ⚙️ **Sous le capot — couche de lévitation.** Le navigateur ignore un `view-transition-name` posé **dans un shadow tree** (transition document, noms *tree-scoped*) — or tout composant MJS vit en shadow. Le moteur lève donc automatiquement chaque élément nommé dans une couche `#mjs-vt-hoist` au-dessus du `body` (DOM lumière) le temps des deux captures : fantôme visuellement identique (clone + styles calculés recopiés), original masqué, nettoyage à `ready`. Fidèle pour du contenu concret (images, blocs, texte) ; un **sous-composant MJS imbriqué** dans l'élément nommé n'est pas répliqué (shadow fermé, non clonable) — nommez l'élément de contenu, pas un composant entier.

### Bibliothèque de préréglages

Au-delà de la forme **nue** `@viewTransition` (fondu natif — réservée à l'attribut du `<style>` de base d'un module, cf. encadré plus haut), chaque niveau accepte une **chaîne** : `none` (coupé) ou un nom de **base**. Les 8 bases **directionnelles** (`slide`, `volet`, `reveal`, `flip`, `cube`, `turn`, `swipe`, `bars`) déclinent la **même animation** selon `left`/`right`/`up`/`down`, réglée par l'option `direction`/`dir` — `cube={ dir: up }`, `turn={ dir: right }`, `bars={ dir: left }`… Sans direction précisée, chaque base a son défaut (cf. tableau *Valeurs par défaut* ci-dessous).

| Base | Effet | Directions |
|---|---|---|
| `fade` | fondu croisé (.5 s) | — |
| `slide` | glissement | ✓ (défaut `left`) |
| `zoom` / `zoom-out` | zoom avant / arrière franc | — |
| `volet` | la nouvelle recouvre, l'ancienne immobile dessous | ✓ (défaut `down` : store qui descend) |
| `reveal` | l'ancienne sort, la nouvelle attend dessous en retrait | ✓ (défaut `up`) |
| `flip` | vrai retournement en place (passation à la tranche) | ✓ (défaut `left`) |
| `cube` | rotation cube 3D, axe partagé (maths adaptées d'une implémentation interne antérieure) | ✓ (défaut `left`) |
| `turn` | pli de page sur le bord (esprit adapté d'une implémentation interne antérieure) | ✓ (défaut `left`) |
| `iris` | **rideau iris** — un rond noir net naît au centre, couvre, la page permute sous le noir, puis le noir s'ouvre | — |
| `swipe` | **rideau balayage** — front doux qui traverse (la technique de masque de `transition.swipe.js`, sur un vrai calque) | ✓ (défaut `right`) |
| `bars` | **rideau bandes** — 8 bandes tombent en cascade, puis continuent leur course | ✓ (défaut `down`) |
| `blocks` | **rideau damier** — vague diagonale de tuiles qui s'effondrent | — |

> ⚙️ **Pourquoi des « rideaux » ?** Le cliché d'une page vivante est **indivisible** : impossible de la découper en bandes/tuiles comme flux le faisait avec des *images* (`background-position` par bloc) — et les masques/découpes se peignent mal sur les pseudo-éléments de transition avec du contenu composité. Les rideaux contournent tout : de **vrais éléments DOM** au-dessus du `body` couvrent l'écran (masques, cascades et délais y sont fiables à 100 %), la permutation se fait **sous le noir**, puis le rideau révèle — la grammaire des écrans de combat. Pendant un rideau, il n'y a **pas** de transition View Transitions (donc pas de morph d'élément partagé : il serait invisible sous le noir).

```json
{ "viewTransition": "slide={ dir: left }" }
```

```html
<@view main @viewTransition.zoom>
```

Un nom **hors de cette liste** est rejeté à la validation de `mjs.config.json` (config statique) ; posé dynamiquement au runtime (`µ.viewTransition = 'n-importe-quoi'`), c'est tolérant : no-op + avertissement, jamais un crash. Le mécanisme reste **ouvert** : pendant la transition, le runtime pose `html[data-mjs-vt="nom"]` pour chaque préréglage **natif** (`fade`, `slide`, `zoom`, `zoom-out`, `volet`, `reveal`, `flip`, `cube`, `turn`) et pour un **nom inconnu** de la bibliothèque — le cas où le hook devient utile, puisque MJS n'injecte alors aucun CSS pour vous : un projet peut définir ses propres règles `html[data-mjs-vt="mon-nom"] { ::view-transition-old(root){…} }` dans sa feuille globale, MJS pose l'attribut, votre CSS prend le relais. L'attribut est retiré dès la fin de la transition. Les quatre **rideaux** (`iris`, `swipe`, `bars`, `blocks`) ne passent jamais par l'API View Transitions et ne posent JAMAIS cet attribut : leur habillage vient des classes de leur propre calque (`#mjs-vt-curtain`/`.mjs-vtc-*`).

> 🎨 **Tous les préréglages ci-dessus sont du CSS pur** (`perspective`/`rotateY`/`preserve-3d`/`clip-path` sur les pseudo-éléments racine) — **aucune librairie n'est nécessaire**, même pour la 3D. Le navigateur capture l'ancien/nouvel état de la page comme une vraie image (texture), transformable en 3D exactement comme n'importe quel élément.

#### Recréer un effet « grille de tuiles » (façon écran de combat)

Certains effets spectaculaires (l'écran de combat d'un jeu, par exemple) reposent sur **plusieurs fragments indépendants** qui s'animent séparément (une grille de tuiles qui rétrécissent, un rideau qui se découpe…) — un seul pseudo-élément racine ne peut pas faire ça seul. Pas besoin d'un moteur générique : le primitif **élément partagé** (`@viewTransition.nom`, section précédente) suffit à recréer la recette, appliqué à une grille plutôt qu'à un seul élément :

```html
<!-- galerie-page.mjs -->
{for tile in $tiles}
  <div class="tuile" @style.view-transition-name={'tuile-' + tile.id} @style.animation-delay={tile.id * 20 + 'ms'}></div>
{end}
```

Chaque tuile porte un nom **unique et apparié** des deux côtés de la navigation (même `tile.id` sur la page cible) — le navigateur anime **chaque** paire indépendamment, avec un `animation-delay` en cascade pour l'effet « tuiles qui tombent en rafale ». C'est exactement le primitif qui a servi à recréer la vignette→photo de la leçon tuto, généralisé à une grille.

### Valeurs par défaut

Tout ce que `@viewTransition` applique **sans que tu précises rien** :

| Réglage | Valeur par défaut | Détail |
|---|---|---|
| Config (`mjs.config.json`, clé `viewTransition`) | `"none"` (absente ≡ `"none"`) | **désactivé** — aucune transition tant qu'aucun niveau ne l'active explicitement |
| `priority` (option, tous niveaux) | `1` | façon `z-index` — à égalité (le cas courant, `1` partout), c'est **toujours la page de départ** qui gagne, cf. *Priorité départ/arrivée* plus haut |
| `direction`/`dir` (bases directionnelles, si omise) | dépend de la base — cf. tableau ci-dessous | chaque base directionnelle a **son** défaut propre, pas un défaut global unique |
| `duration`/`dur` (si omise) | dépend de la base — cf. tableau ci-dessous | la durée « naturelle » du préréglage, mesurée pour rester lisible sans être lente |

| Base | Famille | Direction par défaut | Durée par défaut |
|---|---|---|---|
| `fade` | pseudo | — (non directionnelle) | 500 ms |
| `slide` | pseudo | `left` | 260 ms |
| `zoom` | pseudo | — (non directionnelle) | 450 ms |
| `zoom-out` | pseudo | — (non directionnelle) | 450 ms |
| `volet` | pseudo | `down` | 380 ms |
| `reveal` | pseudo | `up` | 380 ms |
| `flip` | pseudo | `left` | 550 ms |
| `cube` | pseudo | `left` | 600 ms |
| `turn` | pseudo | `left` | 600 ms |
| `iris` | rideau | — (non directionnelle) | 720 ms |
| `swipe` | rideau | `right` | 620 ms |
| `bars` | rideau | `down` | 1260 ms |
| `blocks` | rideau | — (non directionnelle) | 1220 ms |

> 💡 La durée par défaut d'un **rideau** (iris/swipe/bars/blocks) est le **cycle complet** — couverture + révélation (ex. `bars` = 620 ms de couverture + 640 ms de révélation = 1260 ms). `duration:` sur un rideau met à l'échelle les **deux** phases par le même facteur, cf. *Options* ci-dessus.

### Accessibilité

`@viewTransition` respecte deux préférences **avant** de jamais démarrer une transition — la même garde d'environnement (`_mjs_vtEnabled`) protège tous les niveaux (routeur `<@view>` **et** transitions de page `@pageTransition` sur un lien, cf. section suivante) :

- **`prefers-reduced-motion: reduce`** — dès que l'utilisateur (système ou navigateur) demande de réduire les animations, MJS **n'enveloppe jamais** la permutation dans `startViewTransition` : le changement de vue/page se fait directement, comme si `@viewTransition` était absent. Aucune configuration à faire — c'est automatique et prioritaire sur tout réglage `@viewTransition` actif.
- **Dégradé gracieux** — sur un navigateur qui n'implémente pas `document.startViewTransition` (API récente), même chemin : permutation directe, silencieuse, **sans erreur ni avertissement**. Le site reste 100 % fonctionnel, juste sans l'animation.

Dans les deux cas, aucun code à écrire : ces deux gardes sont vérifiées automatiquement à chaque navigation, quel que soit le préréglage demandé.

### Transitions de page (hors routeur) — `@pageTransition` sur un lien

Les préréglages s'appliquent aussi aux **permutations de page** pilotées par la couche [Navigation (UJS)](21-navigation.md) — un lien classique qui déclenche un remplacement de la zone de montage, pas une vue du routeur `#/…`. Cascade dédiée, résolue par lien : attribut `@pageTransition` (converti en `mjs-vt`) sur le `<a>` cliqué, sinon repli sur la config globale `µ.viewTransition` — pas de niveau composant/vue ici (une transition de page n'a pas de « vue routée »).

```html
<a href="/produits/42" @pageTransition="zoom">Voir le produit</a>
```

`@pageTransition` accepte aussi un nom **seul**, `on`, `off`, ou la même syntaxe **objet** que les autres niveaux (`nom={ direction: …, duration: … }`, clés longues ou courtes, guillemets facultatifs autour des valeurs — cf. *Options* ci-dessus) :

```html
<a href="/produits/42" @pageTransition="cube={ dir: left }">Voir le produit</a>
```

> ⚠️ Comme aux autres positions, **aucun raccourci `nom:direction`** — `@pageTransition="cube:left"` est une erreur de compilation, la direction se pose uniquement via la clé d'option. **`priority` n'a pas cours ici** : la cascade d'un lien n'a que deux niveaux (lien, config), rien à départager — seuls le routeur et la page routée connaissent un arbitrage départ/arrivée (cf. *Priorité départ/arrivée* ci-dessus). Poser `priority`/`p` sur `@pageTransition` est donc une erreur de compilation plutôt qu'une option silencieusement sans effet.

### Personnaliser l'animation (CSS)

Le navigateur expose la transition via des **pseudo-éléments standards**, animables en CSS pur :

| Pseudo-élément | Cible |
|---|---|
| `::view-transition-old(root)` | capture *avant* la navigation |
| `::view-transition-new(root)` | capture *après* la navigation |
| `::view-transition-group(nom)` | le groupe d'un élément nommé (morph) |

> ⚠️ Ces pseudo-éléments vivent sur le document **racine**, jamais dans le Shadow DOM d'un composant : une règle posée dans le `<style>` d'un composant MJS ne les atteint jamais (même limite que `@font-face`). La feuille doit donc être **globale** — celle du site, ou injectée via `<@head>` (cf. [Éléments spéciaux](15-elements-speciaux.md)).

```css
::view-transition-old(root),
::view-transition-new(root) {
  animation-duration: 400ms;
}

::view-transition-group(hero) {
  animation-duration: 600ms;
}
```

### Bon à savoir

- **Dégradé gracieux** : navigateur sans `startViewTransition` → permutation directe, sans erreur.
- **Accessibilité** : `prefers-reduced-motion: reduce` → MJS n'enveloppe pas, permutation directe.
- **Même composant, autre paramètre** (`/posts/42` → `/posts/77`) : ce n'est pas une permutation de vue (le composant se met à jour via `µurl`) → pas de transition de page. Une `<@view>` qui résout encore le même module ne participe pas non plus au choix de la transition (une autre vue de la page qui change, elle, joue la sienne).
- **Jamais côté serveur** : le SSR ignore `@viewTransition`, c'est un mécanisme purement client.

---

📚 **Apprendre en pratiquant** : ce chapitre correspond aux tutos interactifs de la section **Routage** (introduction, pages, layouts, paramètres de route) et de la section **Routage avancé** (paramètres optionnels, joker `*` → `&rest`/`&all`, groupes de routes, sortir des layouts).
