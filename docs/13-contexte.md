# 13 · Contexte

> 📚 Tuto interactif correspondant : **API de Contexte** — *setContext et getContext*. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Entre une **prop** (passage explicite, un niveau à la fois) et un **store** (partage global, à travers toute l'appli), il y a le **contexte** : une donnée partagée par un *ancêtre* avec toute sa sous-arborescence, sans la faire transiter par les props de chaque niveau intermédiaire. Idéal pour un thème, une locale, un service utilitaire, une configuration de formulaire multi-étapes.

Le contexte utilise le symbole **`§`**.

## Fournir un contexte — `§clé = valeur`

Dans le `<script>` d'un composant **ancêtre**, `§clé = valeur` enregistre une valeur de contexte (équivaut à un `setContext`) :

```html
# formulaire.mjs (le parent)
<script>
  §theme = 'dark'
</script>

<@champ>
<@bouton>
```

Tout composant instancié dans la descendance de ce `Formulaire` — à n'importe quelle profondeur — pourra lire `§theme`.

> ⌨️ **Clavier sans `§` ?** Le symbole `§` n'est pas en accès direct sur les claviers QWERTY US/UK. Active l'option `contextAlias: true` dans `mjs.config.json` (désactivée par défaut) pour écrire les formes **ASCII** : `__context.theme` ≡ `§theme` (contexte) et `__shared.x` ≡ `§§x` (partagé). `§`/`§§` restent les formes canoniques. *(Le store, lui, s'écrit déjà en ASCII : `$$x` / `µ$$x`.)*

## Lire un contexte — `§clé`

Dans un composant **descendant**, lire `§clé` remonte l'arborescence jusqu'au premier ancêtre ayant déclaré cette clé (équivaut à un `getContext`) :

```html
# champ.mjs (un descendant)
<script>
  $couleur = if §theme is 'dark' then '#ccc' else '#222'
</script>

<label @style.color={$couleur}>
  {$label} : <input type="text"/>
</label>
```

La lecture traverse **transparemment** les niveaux intermédiaires : pas de prop à passer manuellement à travers cinq composants.

<details>
<summary>🎓 <b>Pour débutants</b> — prop, contexte ou store&nbsp;?</summary>

- **Prop** : tu passes une valeur d'un parent à *son enfant direct*, explicitement (`<@champ theme={…}>`). Clair, mais pénible si la donnée doit descendre de cinq niveaux (chaque niveau doit la relayer).
- **Contexte (`§`)** : un ancêtre *pose* la valeur, n'importe quel descendant la *lit*, sans relais intermédiaire. Scopé à cet ancêtre : deux sous-arbres peuvent avoir chacun leur `§theme`.
- **Store (`µ$$`, `µStore`)** : une valeur unique, globale à toute l'appli, indépendante de l'arborescence.

Règle pratique : contexte pour ce qui a du sens *localement* (le thème d'une section, la config d'un formulaire) ; store pour le véritable état d'application (utilisateur connecté, panier).

</details>

## Fournir un objet / un service

La valeur de contexte n'est pas limitée à une chaîne : on y met souvent un objet exposant des méthodes, ce qui permet à un descendant d'**appeler** l'ancêtre sans couplage direct. Exemple d'un `<Grille>` qui collecte les dessins de ses `<Carré>` enfants via un canvas partagé :

```html
# grille.mjs (l'ancêtre)
<script>
  canvas = null
  items   = new Set()

  redraw = ->
    return unless canvas
    ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    items.forEach (fn)-> fn(ctx)

  addItem = (fn)->
    items.add(fn)
    redraw()

  §canvas = { addItem }   # le service exposé aux descendants

  µmount -> redraw()
</script>

<canvas @this=!{canvas} width={$width} height={$height}></canvas>
<@slot>
```

```html
# carre.mjs (un descendant)
<script>
  draw = (ctx)->
    ctx.save()
    ctx.translate($x, $y)
    ctx.rotate($rotate)
    ctx.strokeRect(-$size / 2, -$size / 2, $size, $size)
    ctx.restore()

  µmount ->
    §canvas?.addItem(draw)   # remonte au premier ancêtre qui a posé §canvas
</script>
```

> ℹ️ Le markup de `grille.mjs` se termine par `<@slot>` sans fermante : sans repli à délimiter, la balise nue suffit en fin de composant — même idiome que `<@slot/>`.

> ⚠️ Lis le contexte de façon défensive avec `?.` (`§canvas?.addItem(draw)`) : si aucun ancêtre n'a posé la clé, `§canvas` est *absent* (ne plante pas, mais l'appel direct le ferait). Pose toujours `§clé` dans l'ancêtre **avant** que les descendants ne le lisent — typiquement en l'affectant à la racine du `<script>` du parent, ce qui s'exécute à la construction, donc avant le montage des enfants.

## `§` (contexte) vs `§§` (partagé)

C'est la distinction à ne **jamais** confondre :

| Symbole | Sens | Portée | Durée de vie |
|---|---|---|---|
| `§clé` | **Contexte** d'arbre, lu à la consommation | la sous-arborescence de l'ancêtre qui l'a posé | disparaît quand l'ancêtre est démonté |
| `§§clé` | **Contexte réactif** de sous-arbre (abonnant) | la sous-arborescence de l'ancêtre qui l'a posé | disparaît quand l'ancêtre est démonté |

- `§foo` (un seul symbole) = contexte d'arbre, *parent → descendants*. Deux ancêtres distincts peuvent poser chacun leur `§foo` sans interférer.
- `§§foo` (deux symboles) = **même portée** (parent → descendants), mais **réactif** : les lecteurs se ré-abonnent et re-rendent quand la valeur change. ⚠️ Ce n'est **pas** un état global indépendant de l'arborescence : `§§foo` remonte la chaîne des ancêtres (`_mjs_getRCtx`) — deux composants sans ancêtre déclarant commun **ne partagent rien** via `§§`.
- **Aucune exception** : `§§X` reste **toujours** un contexte de sous-arbre, jamais un accès direct à un store global. Pour un singleton exporté par un module (`export µ$$X`), l'import et la consommation se font avec le **même** symbole `µ$$X` (`@import µ$$X 'chemin'`, puis `µ$$X` dans le composant) — jamais `§§X` : voir [Stores](14-stores.md).

Le contexte (`§`/`§§`) est le bon choix pour partager quelque chose **qui a du sens localement dans un sous-arbre** (un thème de section, une config de formulaire multi-étapes). Pour un **véritable état d'application global** (utilisateur connecté, panier), utilise le **store** `$$x` (→ `µ.store`) ou un singleton `µ$$x` importé — **pas** `§§` nu.

> 🔗 Voir aussi : [Stores](14-stores.md) → le symbole store léger `µ$$` (déclaré ET consommé avec ce même symbole), le store zéro-import `$$`, et la classe `µStore`.

---

📚 **Apprendre en pratiquant** : ce chapitre correspond à la section **API de Contexte** du tuto interactif — `setContext` et `getContext` via le symbole `§`, partage parent→descendants sans passer par les props.
