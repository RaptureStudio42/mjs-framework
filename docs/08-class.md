# 8 · Classes & styles

> 📚 Tuto interactif correspondant : **Chapitre 7 — Classes & styles**. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Pour ajouter ou retirer une classe CSS selon une condition, MJS fournit la directive **`@class{<condition>}="<classe>"`**. La condition (booléenne) va entre accolades, le nom de la classe entre guillemets. C'est un mécanisme dédié, plus direct qu'une interpolation dans l'attribut `class`.

## Syntaxe

```html
<script>
  $flipped = false
</script>
<div class="container">
  Flip the card
  <button
    class="card" @class{$flipped}="flipped"
    @click={$flipped = !$flipped}
  >
    <div class="front"><span class="symbol">♠</span></div>
    <div class="back"><div class="pattern"></div></div>
  </button>
</div>

<style>
  .card
    transform: rotateY(180deg)
    transition: transform 0.4s
    &.flipped
      transform: rotateY(0)
</style>
```

Décortiqué :

- **`class="card"`** : les classes fixes restent dans l'attribut `class` normal.
- **`@class{$flipped}="flipped"`** : la classe `flipped` est **présente quand `$flipped` est vrai**, absente sinon. Les deux coexistent sans conflit sur le même nœud.

La condition est une expression quelconque (pas seulement une variable) : `@class{$count > 10}="hot"`, `@class{$selected === item}="active"`. Tout `$` qu'elle lit devient une dépendance.

> ⚠️ La condition va entre **accolades** `{ … }`, la classe entre **guillemets** `" … "`. Le nom de la classe est **littéral** (une chaîne fixe) : seul l'état *présent / absent* est réactif, pas le nom lui-même. Pour faire varier le nom de la classe, utilise une interpolation dans l'attribut `class` standard (`class="badge {$tone}"`).

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi pas juste <code>class="{$flipped ? 'flipped' : ''}"</code>&nbsp;?</summary>

Tu *peux* interpoler une classe dans l'attribut `class`. Mais alors MJS doit, à chaque changement, recalculer toute la chaîne de classes et la réécrire sur le nœud — et il faut gérer toi-même le `: ''` pour le cas faux. Avec `@class{cond}="flipped"`, tu déclares une intention claire : « cette classe-là suit ce booléen-là ». MJS bascule alors *uniquement* cette classe, sans toucher aux autres. C'est plus lisible (les classes fixes restent dans `class=`, les conditionnelles à côté) et plus rapide.

</details>

## Un dispatch « filtré » optimisé

Sous le capot, `@class{cond}="x"` ne réécrit pas l'attribut `class` entier : il **bascule directement la classe sur le nœud** via `classList.toggle('x', cond)`, gardé pour ne rien faire si l'état n'a pas changé (pas de mutation DOM inutile). Schématiquement, le code généré ressemble à :

```js
const v = !!(cond)
if (node._mjsCl_x !== v) {
  node.classList.toggle('x', v)
  node._mjsCl_x = v
}
```

Mieux : dans une boucle `{for}`, MJS reconnaît le motif **« une seule ligne active »** — typiquement `@class{$selected === item}="active"`. Au lieu de réévaluer la condition sur **toutes** les lignes à chaque changement de `$selected`, il enregistre un dispatch *filtré* : retirer la classe de l'ancienne ligne, l'ajouter à la nouvelle. Sur une longue liste, on passe de N mises à jour à 2.

```html
{for item in $items by id}
  <li @class{$selected === item.id}="active" @click={$selected = item.id}>
    {item.label}
  </li>
{end}
```

Cette optimisation est **automatique** : aucune annotation à ajouter, il suffit d'écrire le motif `@class{$x === <item>}="…"`.

<details>
<summary>🎓 <b>Pour débutants</b> — qu'est-ce que ça change pour moi&nbsp;?</summary>

Rien dans ce que tu écris : tu poses `@class{condition}="classe"` et c'est tout. Le point à retenir, c'est que c'est *efficace même sur de grandes listes* — un cas (la « ligne sélectionnée » d'un menu, d'un onglet, d'un tableau) où une implémentation naïve recalculerait chaque ligne à chaque clic. MJS détecte ce motif tout seul et ne touche qu'aux deux lignes concernées (l'ancienne qu'on désélectionne, la nouvelle qu'on sélectionne).

</details>

## Binding de style — `@style.<prop>`

Pour piloter **une propriété de style ciblée**, `@style.<prop>={expression}` : MJS n'écrit que `node.style.<prop>` quand l'expression change, sans toucher au reste de l'attribut `style`.

```html
<div @style.color={$couleur} @style.transform={$flipped ? 'rotateY(0)' : ''}>…</div>
```

- Le nom de la propriété est dans le **nom de la directive** : `@style.color`, `@style.border-color`, `@style.transform`.
- La **valeur** est une expression entre accolades, réactive — comme `@class`, seule la propriété ciblée est mise à jour (pas tout l'attribut `style`).

> ⚠️ Une propriété composée s'écrit en **kebab-case** dans la directive (`@style.border-color`), comme en CSS — pas en camelCase JS.

> ⚠️ La valeur est posée **telle quelle** : une propriété de longueur (`width`, `margin`, `font-size`…) veut son unité DANS l'expression (`@style.width={$n + 'px'}`) — un nombre nu (`100`) est une valeur CSS invalide, rejetée sans bruit par le navigateur.

> 🔗 Un suffixe `!important` en fin de valeur (casse et espaces libres) est reconnu et posé comme priorité CSS : `@style.color={$urgent ? 'red !important' : 'inherit'}`. Sans le suffixe, la priorité reste vide.

## Custom properties réactives — `--var={…}`

Une **variable CSS** (custom property) se lie comme un attribut, sa valeur entre accolades. C'est le moyen idiomatique de passer une valeur réactive au `<style>` du composant — la variable **traverse le Shadow DOM** :

```html
<script>
  $couleur = 'tomato'
</script>
<div --couleur={$couleur}>
  <span>coloré</span>
</div>
<style>
  span
    color: var(--couleur)
</style>
```

Changer `$couleur` met à jour la custom property sur le nœud ; le `<style>` qui fait `var(--couleur)` suit — sans recalculer de classe ni réécrire un style en ligne.

> 🔗 `@class{…}`, `@style.<prop>` et `--var={…}` fonctionnent aussi sur [`<@body>` / `<@html>`](15-elements-speciaux.md) — classe `no-scroll` de modale, theming `:root`/dark-mode.

> 🔗 Voir aussi : [Événements](06-evenements.md) — le « dispatch filtré » de `@class` réutilise le moteur de routage des événements.

> 🔗 Une valeur de style que **plusieurs composants** doivent partager (couleur de marque, espacement, rayon) ne se passe pas de proche en proche : elle se déclare une fois dans un thème et descend toute seule — [31 · Thèmes, variables & variants](31-themes.md).

---

📚 **Apprendre en pratiquant** : ce chapitre correspond au **Tuto interactif n°7 (Classes & styles)** — directive `@class`, directive `@style`, styles scopés du composant.
