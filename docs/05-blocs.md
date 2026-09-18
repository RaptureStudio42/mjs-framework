# 5 · Blocs logiques

> 📚 Tuto interactif correspondant : **Chapitre 4 — Blocs logiques**. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Le template MJS ne contient pas de JavaScript de contrôle de flux : on décrit le rendu avec des **blocs** entre accolades. Cinq familles : `{if}` (conditionnel), `{for}` (liste), `{await}` (promesse), `{key}` (re-montage forcé), `{const}` (constante locale). Les quatre premiers se ferment par `{end}` — il n'y a pas de balise de fermeture nommée comme `{/if}` ; `{const}` ne s'ouvre pas de bloc, c'est une simple déclaration en ligne (voir plus bas).

## Conditionnel — `{if}` / `{elsif}` / `{else}`

```html
<script>
  $count = 0
  increment = -> $count += 1
</script>
<button @click={increment}>Clicked {$count}</button>

{if $count > 10}
  <p>{$count} is greater than 10</p>
{elsif $count < 5}
  <p>{$count} is less than 5</p>
{else}
  <p>{$count} is between 5 and 10</p>
{end}
```

Le mot-clé « sinon si » est **`{elsif}`** (un seul mot, comme en Ruby) — **pas** `{else if}`. `{else}` et chaque `{elsif}` sont facultatifs ; seul `{end}` est obligatoire. La condition est une expression Civet quelconque ; tout `$` qu'elle lit devient une dépendance, et la bonne branche est ré-affichée à chaque changement.

> ⚠️ N'utilise pas `{else if}` (deux mots) ni `{elif}` : le seul mot-clé reconnu est `{elsif}`. Oublier le `{end}` final lève une erreur de compilation explicite (« unclosed block »).

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi des accolades et pas un vrai <code>if</code> JavaScript&nbsp;?</summary>

Dans beaucoup de frameworks tu écrirais le `if` en JavaScript autour du HTML. En MJS, le template est compilé : MJS doit savoir *quel morceau de DOM dépend de quelle condition* pour ne mettre à jour que lui. Les blocs `{if …}…{end}` lui donnent exactement cette information. Tu décris « ce bloc n'apparaît que si la condition est vraie », et MJS se charge d'ajouter/retirer le DOM au bon moment, sans que tu touches à un seul `appendChild`.

</details>

## Listes — `{for … in …}`

```html
<script>
  colors = ['red', 'orange', 'yellow', 'green', 'blue']
  $selected = colors[0]
</script>

<div>
  {for i, color in colors}
    <button
      style="background: {color}"
      aria-current={$selected === color}
      @click={$selected = color}
    >{i + 1}</button>
  {end}
</div>
```

La forme générale est :

```
{for [index,] item in liste [by clé]}
```

- `item` est l'élément courant ; `index` (facultatif, **avant** la virgule) est sa position.
- `liste` est n'importe quel itérable (tableau, ou objet — itéré sur `Object.values`).
- On itère avec **`in`**, jamais `of` : `{for x of arr}` lève une erreur de compilation (« utilisez « in », pas « of » »).

> ⚠️ Muter `$liste[i].champ` re-rend le `{for}` — la mutation profonde est suivie, **d'où qu'elle vienne** : handler `@event` ou méthode ordinaire du `<script>` (voir [Réactivité](03-reactivite.md) → état profond).

### Suivi keyé — `by <clé>`

```html
<script>
  $things = [
    { id: 1, name: 'apple' }
    { id: 2, name: 'banana' }
    { id: 3, name: 'carrot' }
  ]
</script>
<button @click={$things.shift()}>Remove first thing</button>

{for thing in $things by id}
  <@thing name={thing.name}>
{end}
```

`by id` indique à MJS d'**identifier** chaque ligne par cette clé (ici la propriété `id` de chaque élément) plutôt que par sa position. Sans clé, MJS suit les éléments **par index** : si tu retires le premier élément d'une liste, l'index 0 contient maintenant l'ancien index 1, et MJS met à jour *le contenu* du premier nœud existant au lieu de retirer le bon — état interne, focus, transitions et composants enfants peuvent alors se retrouver « décalés » sur la mauvaise ligne. Avec `by id`, MJS retrouve chaque ligne par son identité, retire précisément la bonne, et **préserve** l'état des autres.

<details>
<summary>🎓 <b>Pour débutants</b> — quand est-ce que <code>by</code> change vraiment quelque chose&nbsp;?</summary>

Tant que ta liste ne fait que grandir par la fin, index et identité coïncident, et `by` ne change rien de visible. La différence apparaît dès que tu **insères ou supprimes au milieu / au début**, ou que tu **réordonnes**. Exemple : une liste de composants avec un champ de saisie. Sans clé, supprimer la première ligne laisse le texte tapé « glisser » vers le haut, car MJS a recyclé les nœuds par position. Avec `by id`, c'est la ligne supprimée qui disparaît, les autres gardent leur saisie. Règle simple : dès que tes éléments ont une identité stable (`id`, `uuid`…), mets un `by`.

</details>

## Promesses — `{await}` / `{success}` / `{error}`

```html
<script>
  roll = ->
    new Promise (fulfil, reject)->
      setTimeout(->
        if Math.random() < 0.5
          reject(new Error('Something went wrong'))
          return
        fulfil(Math.floor(Math.random() * 100))
      , 500)

  $promise = roll()
</script>

<button @click={$promise = roll()}>roll the dice</button>

{await $promise}
  <p>...rolling</p>
{success number}
  <p>you rolled a {number}!</p>
{error err}
  <p style="color: red">{err.message}</p>
{end}
```

Trois branches, dans cet ordre :

| Branche | Affichée… | Lie une variable |
|---|---|---|
| `{await $promesse}` | pendant que la promesse est en attente | — |
| `{success <nom>}` | quand elle se résout | la valeur résolue → `<nom>` |
| `{error <nom>}` | quand elle est rejetée | l'erreur → `<nom>` |

Les mots-clés sont bien **`success`** et **`error`** — pas `then`/`catch`. Les noms liés (`number`, `err` ci-dessus) sont libres mais ne peuvent pas être des mots réservés. Réaffecter `$promise` (ici via le bouton) relance le cycle : on repasse par la branche d'attente. Une promesse remplacée pendant l'attente est ignorée quand elle se résout ou échoue : seule la dernière assignée peut encore faire basculer l'affichage.

> ⚠️ La branche d'attente (`{await …}` → `{success …}`) et les noms liés sont positionnels : `{success}` vient avant `{error}`, et chacun introduit *sa* variable, visible uniquement dans sa branche.

> 💡 **Le contenu d'une branche `{await}` est un instantané, pas réactif.** Une interpolation `{expr}` à l'intérieur de `{await}`/`{success}`/`{error}` est calculée **une fois**, au moment où MJS bascule sur cette branche — elle ne se remet **pas** à jour si un `$x` qu'elle lit change ensuite tant que la branche reste affichée. C'est cohérent avec le rôle du bloc (afficher un état figé d'une promesse à un instant donné) ; pour du contenu qui doit rester réactif à l'intérieur, passe par un sous-composant.

> ⚠️ Un `{await}` **imbriqué dans un `{for}`** n'est pas supporté et lève une erreur de compilation explicite — sors-le du `{for}`. Un `{await}` imbriqué dans un `{if}` **à la racine** du template reste, lui, permis.

## Re-montage forcé — `{key}`

```html
{key $valeur}
  <mon-composant prop={$x} />
{end}
```

`{key <expr>}` lie le bloc à une expression. **Tant que l'expression ne change pas**, rien de spécial. **Dès qu'elle change**, MJS **détruit entièrement** le contenu du bloc puis le **recrée à neuf** : les composants enfants repassent par leur cycle complet (destruction puis montage), et les transitions / animations d'entrée **rejouent**. C'est le seul bloc dont le rôle n'est pas de choisir *si* afficher, mais de forcer un **remplacement** plutôt qu'une mise à jour en place.

Usage typique : rejouer une animation d'entrée à chaque changement de valeur, ou repartir d'un état interne vierge dans un composant enfant quand une identité change.

> ⚠️ `{key}` est coûteux par nature (démontage + remontage complet). Ne l'emploie que lorsque tu veux *vraiment* repartir de zéro ; pour une simple mise à jour réactive, un `{if}` ou une liaison suffit.

> ⚠️ L'expression doit être une **valeur stable** : nombre, chaîne, identifiant. Un littéral objet ou tableau (`{key {a: $x}}`) fabrique une valeur **différente à chaque évaluation** — le bloc remonte à chaque passe, même quand `$x` ne change pas.

> 🔗 Voir aussi : [Transitions & animations](10-transitions.md) (les transitions d'entrée rejouées par `{key}`).

## Constante locale — `{const}`

`{const NOM = expr}` déclare une **constante locale**, réutilisable dans les interpolations qui suivent au sein du **même bloc**. Utile pour factoriser un calcul répété plusieurs fois dans une ligne d'un `{for}` :

```html
{for produit in $produits by id}
  {const prixTTC = produit.prixHT * 1.2}
  <li>{produit.nom} — {prixTTC.toFixed(2)}€ TTC (HT : {produit.prixHT}€)</li>
{end}
```

`prixTTC` est recalculé à chaque item, et re-recalculé si un `$` qu'il lit change (le `{for}` parent se reconcilie). Comme `{const}` ne produit aucun DOM, ce n'est pas un bloc à fermer par `{end}` — c'est une ligne, au même titre qu'un `{if}`/`{for}` dans le corps du bloc qui le contient.

> ⚠️ **`{const}` n'est supporté qu'à l'intérieur d'un `{for}` (ou d'une branche `{await}`)** — au **niveau racine** du template, il n'est **pas** supporté (V1) et lève une erreur de compilation explicite. Pour une constante au niveau racine, déclare plutôt une **dérivée réactive** dans le `<script>` : `$nom = expression` (auto-derived, cf. [Réactivité](03-reactivite.md)), puis lis `{$nom}`.

---

📚 **Apprendre en pratiquant** : ce chapitre correspond au **Tuto interactif n°4 (Blocs logiques)** — `{if}`, `{else}`/`{elsif}`, listes `{for}`, listes keyées `by`, et `{await}`.
