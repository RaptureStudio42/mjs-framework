# 2 · Anatomie d'un composant

> 📚 Tuto interactif correspondant : **Chapitre 1 — Introduction**. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Un composant = **un fichier `.mjs`**. Il réunit plusieurs blocs de premier niveau, tous optionnels : un `<script module>` (code partagé, exécuté une seule fois), un `<script>` (logique de l'instance), du **markup HTML**, un ou plusieurs `<theme>` (variables de thème — voir [Thèmes](31-themes.md)), et un `<style>` (CSS scopé, avec son bloc nommé `<style name="…">` pour un variant). Le nom du fichier détermine la balise.

L'ordre conventionnel dans le fichier : `<script module>` puis `<script>` en tête, le HTML ensuite, puis les blocs `<theme>` éventuels, et le `<style>` en dernier.

## Fichier → balise : kebab-case obligatoire

Le compilateur dérive le nom de balise du nom de fichier : `tagName = "mjs-" + nom.toLowerCase()`.

| Fichier | Balise générée | Utilisation |
|---|---|---|
| `mon-bouton.mjs` | `<mjs-mon-bouton>` | `<mjs-mon-bouton />` |
| `nested.mjs` | `<mjs-nested>` | `<mjs-nested />` |

Les noms de fichiers composants sont donc en **kebab-case minuscule**, impérativement.

> ⚠️ Un nom de fichier en **camelCase** (`monBouton.mjs`) **casse l'autoloader** : la balise est construite en `.toLowerCase()` → `<mjs-monbouton>`, qui ne correspond à rien d'attendu. Toujours `mon-bouton.mjs`, jamais `monBouton.mjs`.

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi le préfixe <code>mjs-</code> et le tiret&nbsp;?</summary>

Ce n'est pas une lubie de MJS : la **norme des Custom Elements** du navigateur exige qu'un nom de balise personnalisée contienne un **tiret** (`-`). C'est ce qui les distingue des balises natives (`<div>`, `<p>`…), qui n'en ont jamais. MJS préfixe donc tout par `mjs-`, ce qui garantit le tiret et évite les collisions de noms. Ton fichier `carte-produit.mjs` devient `<mjs-carte-produit>`.

</details>

## La section `<script>` — Civet par défaut

La logique vit dans `<script>`. Le langage par défaut est **Civet** (proche de CoffeeScript) : indentation significative, pas de `;`, pas de `{}` pour les blocs.

```html
<script>
  name = 'ModularJS'
  shout = -> name.toUpperCase()
</script>

<h1>{shout()}</h1>
```

### Méthodes en `->`

On définit les fonctions/méthodes avec la flèche **`->`** (style Coffee), pas `=>` :

```html
<script>
  greet = (who)-> "Bonjour #{who}"   # -> classique
</script>
```

> ⚠️ N'utilise `=>` **que** si tu as besoin de lier `this` (cas rare, ex. certains `µeffect` qui touchent le composant). Par défaut, **`->`**. Voir [Cycle de vie](16-cycle-de-vie.md) et [Pièges](18-pieges.md).

### Interpolation de chaîne : `"#{x}"`

En Civet, on interpole dans une chaîne avec **`#{ … }`** (guillemets doubles), à la CoffeeScript :

```html
<script>
  who = 'monde'
  msg = "Bonjour #{who} !"      # ✓ Civet
</script>
```

> ⚠️ **Évite les backticks `` `${x}` ``** (chaînes à backticks JS) dans un `<script>` Civet : `` `Bonjour ${who}` `` **compile et fonctionne** (Civet les laisse passer tel quel), mais c'est **hors convention** ici — utilise toujours `"#{who}"` (style Coffee, cohérent avec le reste du code MJS).

### Choisir un autre langage : `lang="…"`

Civet est le défaut, mais on peut écrire le `<script>` en `ts`, `coffee` ou `js` via l'attribut `lang` :

```html
<script lang="ts">
  const name: string = 'ModularJS'
</script>
```

Valeurs reconnues : `civet` (défaut), `coffee`, `ts`, `js`. Le défaut global est configurable dans `mjs.config.json` via `"defaultScriptLang"`, ou la forme à deux axes **`languages`** :

```json
{ "languages": { "script": "civet", "template": "civet" } }
```

- **`languages.script`** — même rôle que `defaultScriptLang` (langage par défaut des `<script>` sans `lang=`).
- **`languages.template`** — grammaire des **interpolations** `{…}` du template et des **handlers inline** (`@click={…}`) : `"civet"` (défaut — ternaire espacé, existentiel `??`, `->`/`not`/`and`/`or` nativement compris) ou `"js"` (repli historique par regex, plus permissif mais moins idiomatique — cf. [Événements](06-evenements.md)).

> ⚠️ Si `defaultScriptLang` **et** `languages.script` sont posées, `languages.script` prime — poser des valeurs **différentes** est une erreur de config (garde une seule des deux clés).

> 🪦 **`.coffee` est déprécié.** Le langage `coffee` (`lang="coffee"`) reste accepté (une version figée, non maintenue) mais n'est plus la voie recommandée — Civet en est le successeur direct (même famille syntaxique, types optionnels, pipeline unifié). Le **manifeste externe** (fichier qui liste des scripts à bundler en plus des composants `.mjs`, clé `manifestExternal`) suit la même bascule : `manifest.civet` est cherché en premier par défaut, `manifest.coffee` reste un repli pour les projets non migrés.

> ⌨️ **Clavier non-AZERTY ? Le réglage `sigil`.** L'API du framework s'écrit sous le préfixe `µ` (la lettre grecque « Mu », pour **M**odularJS) : `µeffect`, `µ.state`, `µinspect`, `µ$count`… Sur un clavier **AZERTY** (français), `µ` a une touche dédiée ; ailleurs, il est peu accessible. Deux solutions :
>
> 1. **Saisir le caractère `µ`** via le système : `Alt`+`0181` (Windows), `⌥ Option`+`M` (macOS), `AltGr`+`M`/touche *Compose* (Linux), ou copier-coller.
> 2. **Régler `"sigil": "mjs"`** dans `mjs.config.json` et écrire **`mjs.`** à la place de `µ` :
>
> ```json
> { "sourceDir": "app/modularjs", "sigil": "mjs" }
> ```
> ```coffee
> mjs.inspect $count             # ≡ µinspect $count
> mjs.effect ->                  # ≡ µeffect ->
> incr = -> mjs.emit('change')   # ≡ µemit('change')
> ```
>
> Le **séparateur est obligatoire** : il n'existe pas de forme courte collée (`mjseffect`), afin de ne jamais corrompre un identifiant comme `mjsonp` ou `music`. Deux séparateurs seulement : le **point** (`mjs.effect`) et le **`$`** devant un symbole d'état ou de store (`mjs$count` ≡ `µ$count`, `mjs$$panier` ≡ `µ$$panier`). En interne, `µ` reste le symbole **canonique** (runtime, bundle) ; `mjs.` n'est qu'une commodité de saisie, réécrite en `µ` à la compilation. Valeurs : `"µ"` (défaut) ou `"mjs"`.

> ⚠️ **Pas d'`import … from`** JavaScript dans un `<script>`, quel que soit le langage. Les dépendances entre composants/modules passent par la directive **`@import`** au niveau racine du fichier (`@import nom 'chemin'`). Voir [Pièges](18-pieges.md) et la section *Importer un module* ci-dessous.

<details>
<summary>🎓 <b>Pour débutants</b> — Civet, c'est quoi par rapport à JavaScript&nbsp;?</summary>

**Civet** est un langage qui se *compile vers* JavaScript : tu écris une syntaxe plus courte, MJS la traduit en JS standard. Concrètement, par rapport à JS :

- pas de point-virgule en fin de ligne ;
- pas d'accolades pour les blocs : c'est l'**indentation** qui structure (comme Python) ;
- les fonctions s'écrivent `nom = (args)-> corps` ;
- l'interpolation dans les chaînes utilise `"#{variable}"` au lieu des backticks.

Si tu connais CoffeeScript, tu es chez toi. Sinon, retiens les trois habitudes à prendre : `->` (pas `=>`), indentation propre, `"#{x}"` (convention du projet — préférée aux backticks `` `${x}` ``, qui compilent et fonctionnent aussi, mais sortent du style Coffee). Tu peux aussi écrire en JS pur avec `<script lang="js">` le temps de t'habituer.

</details>

### Importer un module — `@import`

Les dépendances entre composants/modules passent par la directive **`@import`**, au niveau **racine** du fichier (hors `<script>`, jamais un `import … from` JavaScript). Trois formes :

```html
@import maFonction 'utils/helpers.civet'          <!-- export nommé -->
@import a b c 'utils/helpers.civet'                <!-- plusieurs exports nommés, séparés par un espace -->
@import default MonWidget 'widgets/mon-widget.civet'  <!-- export par défaut -->
```

Le chemin est résolu comme un **asset local** (mêmes règles que `µasset('…')` : validé et réécrit vers son URL finale au build — chemin absent → erreur de build explicite) sauf s'il s'agit d'une URL complète (`http://…`/`https://…`), laissée telle quelle. Un nom préfixé par `$` (`@import $x 'module.civet'`) marque la variable importée comme **externe réactive** — utile pour un état importé qui doit rester suivi par le compilateur.

```html
<!-- module.civet -->
export trapFocus = (_node)-> …
export default class MonWidget
```

> 🔗 `@import µ$$X 'chemin'` est la forme spécifique aux **stores légers** (importe le singleton `export`é `µ$$X` par le module, consommé ensuite avec ce **même** `µ$$X` — jamais `$X`, `$$X` ni `§§X` directement en composant) : voir [Stores](14-stores.md).

> 🔗 Un module `.civet`/`.coffee` **autonome** peut lui-même `@import` un autre module (chaînage module→module, ex. `a.civet` importe `b.civet`) — le compilateur suit la chaîne à **n'importe** quelle profondeur (recompilation transitive : `b.civet` change → `a.civet` ET le `.mjs` qui l'importe recompilent) et refuse un cycle (`A → B → A`) avec une erreur de build explicite.

### Chargement paresseux — `µimport`

Un composant embarque parfois un **gros module** utile seulement à une minorité de visiteurs (éditeur avancé, visualisation 3D, lecteur vidéo…) : le charger au **boot** de la page pénaliserait tout le monde pour l'usage de quelques-uns. La rune **`µimport`** charge ce module **à l'usage** (typiquement un clic), pas au montage :

```html
<script>
  loadScene = ->
    THREE = await µimport('vendor/three.js')
    new THREE.Scene()
</script>
```

L'alias clavier **`mjsimport`** (sans `µ`) existe, comme pour `µasset`/`mjsasset`.

Le chemin suit exactement la convention de `µasset('…')` : un **littéral chaîne écrit en dur**, relatif à `sourceDir`, résolu au **build** — jamais une variable. Seul un fichier **`.js`** (module ES) est accepté en cible.

Au build, le fichier référencé est **copié avec une empreinte dans son nom** (`lib-a1b2c3d4.js`) et l'appel `µimport('…')` devient un **import dynamique** de ce chemin hashé : cache navigateur long (le nom ne change que si le contenu change), et le fichier ne pèse **rien** dans le chargement initial — il n'est téléchargé qu'au moment où la ligne s'exécute réellement.

`µimport` retourne la **promesse du module** (son namespace ES), qu'on peut déstructurer ou garder en bloc :

```html
<script>
  loadScene = ->
    { WebGLRenderer } = await µimport('vendor/three.js')   # export nommé
    # ou
    THREE = await µimport('vendor/three.js')                # namespace entier
</script>
```

Utilisable dans un `<script>`, un `<script module>`, et les gestionnaires inline du HTML :

```html
<button @click={ THREE = await µimport('vendor/three.js') }>Charger la scène</button>
```

> ⚠️ Deux garde-fous, tous deux des **erreurs de compilation** : un argument qui n'est **pas un littéral chaîne** — le build ne peut pas connaître le fichier à l'avance — oriente vers `import(variable)` (ci-dessous, pour une URL connue seulement à l'exécution) ; une extension **autre que `.js`** est également refusée, seul un module ES étant une cible valide de chargement paresseux.

#### URL connue seulement à l'exécution — `import(variable)`

Quand l'adresse du module n'existe qu'au **runtime** (empreinte posée par le serveur de l'application, réponse d'API, valeur portée par un attribut), l'`import()` dynamique **natif** de JavaScript reste légal tel quel — à condition que son argument soit une **variable ou une expression**, jamais un chemin écrit en dur :

```html
<script>
  loadModule = (url)-> await import(url)
</script>
```

Un chemin **littéral** dans `import(...)` reste **refusé à la compilation** : un fichier connu d'avance doit passer par une directive que le compilateur peut suivre — `@import` (bundle principal) ou `µimport` (chargement paresseux) — pour que le graphe de dépendances le voie ; un `import('./x.js')` littéral y échapperait silencieusement.

> 🔗 **La règle de partage.** Chemin connu **au build** (fichier du projet, écrit en dur) → `@import` ou `µimport`. URL connue seulement **à l'exécution** (variable, expression) → `import(variable)` natif. Cas type : three.js (815 Ko) servi par le pipeline d'assets de l'application sous un nom qui change à chaque déploiement (`three-bundle-7ef951a4.js`) — l'URL vient d'un attribut ou d'une config, et `await import(url)` s'exécute au clic.

## Le markup (le HTML du composant)

Tout ce qui n'est ni `<script>` (module ou non), ni `<style>`, ni `<theme>`, est le **HTML** affiché par le composant. C'est du HTML, avec deux ajouts :

- **interpolation `{ expr }`** dans le texte et les attributs ;
- **composants imbriqués** : on pose simplement une autre balise `<@…>` ;
- **commentaire HTML `<!-- … -->`** : ignoré à la compilation, jamais posé dans le DOM final, son contenu n'est jamais interprété (une `{expr}` qui y traînerait reste du texte mort).

```html
<script>
  src = '/tutorial/image.gif'
  name = 'Rick Astley'
</script>

<img src={src} alt="{name} dances." />
<@nested>
```

`src={src}` pose l'attribut par son **nom** — la valeur vient de la variable `src` du script. `alt="{name} dances."` interpole dans une valeur d'attribut. `<@nested>` insère le composant du fichier `nested.mjs`.

> ℹ️ Pour insérer du **HTML brut** (non échappé) plutôt que du texte, on utilise la double accolade `{{ expr }}`. À manier avec prudence (XSS) — voir [Bindings → HTML brut](07-bindings.md).

## La section `<style>` — scopé par Shadow DOM

Le `<style>` d'un composant est **isolé** : ses règles ne s'appliquent qu'au composant (Shadow DOM), ne fuient pas, et ne sont pas écrasées par le CSS global. Par défaut, on écrit du **SASS indenté** (pas de `{}` ni `;`) :

```html
<style>
  p
    color: purple
    font-family: 'Comic Sans MS', cursive
    font-size: 2em
    margin: 0
</style>

<p>This is a paragraph.</p>
```

Le `<style>` accepte aussi `lang="scss"` (SCSS avec accolades) ou `lang="css"`.

### Une feuille partagée par plusieurs composants — `@css`

Le style isolé est confortable, mais on ne veut pas recopier la même palette ou la même grille dans dix composants. `@css="nom"`, posé en **attribut du `<style>` de base** du composant (celui sans `name=`), rattache au composant une feuille commune :

```html
<div class="card">…</div>

<style @css="theme">
  .card
    padding: var(--gap)
</style>
```

Le nom se résout dans le dossier des feuilles partagées — clé `stylesheetsDir` de `mjs.config.json`, `app/modularjs/styles/` par défaut — et le fichier peut être `.sass`, `.scss` ou `.css`. Un nom qui ne correspond à aucun fichier fait échouer le build, avec le nom cherché : pas de style manquant en silence.

Plusieurs feuilles se déclarent dans le même attribut, séparées par des espaces :

```html
<style @css="theme grid">
```

La feuille partagée est adoptée **avant** le `<style>` du composant : le style local a donc toujours le dernier mot, sans qu'on ait à se battre en spécificité. Quand deux feuilles sont déclarées, la dernière l'emporte sur la première.

Tout autre attribut posé sur `<style>` (comme sur `<script>`, `<theme>` ou `<routes>`) est refusé à la compilation, avec une suggestion quand le nom est proche d'un attribut attendu.

### Comment ces feuilles arrivent au navigateur — la clé `css`

Une seule clé de `mjs.config.json` décide, pour tout le projet, de la façon dont les feuilles partagées voyagent. Le comportement de `@css` ne change jamais : ce qui change, c'est ce que le navigateur télécharge.

| valeur | ce qui part au navigateur | pour quel projet |
| --- | --- | --- |
| `'bundle'` *(défaut)* | **un seul** fichier qui contient TOUTES les feuilles de `stylesheetsDir`, chargé avec le manifeste | le cas courant : peu de feuilles, ou des feuilles utilisées presque partout |
| `'split'` | **un fichier par feuille**, importé par le JavaScript des composants qui la déclarent | plusieurs feuilles bien séparées : une page ne paie que celles de ses composants |
| `'lazy'` | **un vrai `.css` par feuille**, demandé au montage du premier composant qui la déclare | des feuilles lourdes que peu d'écrans utilisent : rien ne part tant que personne n'en a besoin |

En `'lazy'`, une feuille réclamée par dix composants ne fait qu'**une** requête : le résultat est mis en cache par URL, et les neuf autres montages le réutilisent. Le composant reste masqué le temps de l'aller-retour (le même bouclier anti-clignotement qui masque tout composant avant son premier rendu), puis apparaît habillé — jamais nu.

Trois choses à savoir avant de choisir `'lazy'` :

- La feuille `mjs_root` reste chargée d'emblée dans les deux modes découpés. Elle habille le document entier, personne ne la déclare, et elle porte souvent les variables de thème : la différer ferait clignoter toute la page.
- Une feuille que **personne** ne déclare n'est jamais chargée. Le fichier est écrit, son adresse reste connue, mais aucune requête ne part — le build vous la nomme pour que ce ne soit pas une surprise.
- Une page rendue au serveur arrive **sans** les feuilles partagées, et c'est vrai dans les **trois** modes : le HTML servi n'inline que le style propre du composant et le thème. Ce qui change, c'est le moment où le navigateur les applique. En `'bundle'` et `'split'`, les octets du CSS voyagent dans le graphe JavaScript déjà en train de se charger : la feuille est là au montage. En `'lazy'`, une requête part **après** le montage, et le composant reste masqué le temps de l'aller-retour. Sur une page prérendue que vous voulez habillée dès la première image, ce délai se voit : gardez `'bundle'` ou `'split'` pour ce projet.

> 🔗 La clé et ses voisines : [32 · Ligne de commande & configuration](32-cli-et-configuration.md).

> ⚠️ L'isolation Shadow DOM a des conséquences : un `@font-face` déclaré dans le `<style>` d'un composant **ne charge pas** la police (il faut l'injecter dans `document.head`). De même, le CSS global ne « descend » pas dans le composant, sauf via les **custom properties** (`--ma-var`) qui, elles, traversent la frontière. Voir [Pièges](18-pieges.md).

<details>
<summary>🎓 <b>Pour débutants</b> — « style scopé », pourquoi c'est confortable&nbsp;?</summary>

Sur une page web classique, écrire `p { color: purple }` colore **tous** les paragraphes du site — y compris ceux que tu ne voulais pas toucher. C'est la grande douleur du CSS : tout est global, tout peut s'entrechoquer.

Avec le Shadow DOM, le `<style>` d'un composant est enfermé dans une bulle : `p { color: purple }` ne colore que les `<p>` **de ce composant**. Tu peux donc écrire des sélecteurs simples et courts (`p`, `.title`, `button`) sans craindre d'effets de bord ailleurs, et sans inventer de noms de classes alambiqués.

</details>

---

📚 **Apprendre en pratiquant** : ce chapitre correspond au **Tuto interactif n°1 (Introduction)** — premier composant, dynamique, attributs, stylisation, composants imbriqués. Voir ensuite [Réactivité](03-reactivite.md) (`$x`) et [Props & attributs](04-props.md) (passer des données à un composant imbriqué).
