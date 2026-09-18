# 12 · Snippets & composants paramétrés

> 📚 Tuto interactif correspondant : **Chapitre 11 — Snippets et composants paramétrés**. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Certains frameworks proposent des *snippets* — des fragments de template **paramétrés**, définis et invoqués directement dans le markup. **MJS n'a pas de syntaxe dédiée** : il n'y a ni `@snippet`, ni `{@render}`, ni `<@render>`. À la place, on s'appuie sur ce que les Web Components offrent déjà :

- un fragment **paramétré par des valeurs** (texte, nombres, expressions) → un **sous-composant** à attributs réactifs ;
- un emplacement **à remplir avec du contenu arbitraire** (titre, actions, corps libre) → un **slot** (`<@slot>`).

> ⚠️ N'écris pas `{#snippet}` ni `{@render}` dans un composant MJS : ces mots-clés n'existent pas et ne sont pas reconnus par le compilateur. Le pendant naturel d'un snippet, c'est un sous-composant Web Component (vu ci-dessous) ou un slot.

## Fragment paramétré → sous-composant à attributs

Un snippet comme `monkey(emoji, description)` isole la structure d'une ligne et est invoqué plusieurs fois avec des paramètres différents. En MJS, on **isole cette structure dans un composant** dont les attributs HTML deviennent automatiquement des variables `$` réactives.

```html
<!-- tuto-monkey.mjs — l'équivalent du snippet -->
<div class="cell">{$emoji}</div>
<div class="cell">{$description}</div>
<div class="cell code">\u{$emoji.charCodeAt(0).toString(16)}</div>
<div class="cell code">&amp;#{$emoji.codePointAt(0)}</div>

<style @display="contents">
</style>
```

```html
<!-- l'invocation = du HTML standard, un appel par ligne -->
<div class="grid">
  <@tuto-monkey emoji="🙈" description="see no evil">
  <@tuto-monkey emoji="🙉" description="hear no evil">
  <@tuto-monkey emoji="🙊" description="speak no evil">
</div>
```

Les attributs `emoji` et `description` alimentent **directement** les variables `$emoji` et `$description` — pas besoin de les déclarer dans un `<script>`, MJS les bind automatiquement (voir [Props & attributs](04-props.md)). Chaque balise est un « appel » : on passe les paramètres en attributs, comme `{@render monkey(...)}` passe ses arguments.

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi un composant plutôt qu'une fonction&nbsp;?</summary>

Un snippet ressemble à une petite fonction qui renvoie du markup. En MJS, l'unité de markup réutilisable, c'est le **composant**. Tu écris une fois la structure d'une ligne dans `tuto-monkey.mjs`, puis tu l'« appelles » autant de fois que tu veux en plaçant la balise `<@tuto-monkey …>` avec des attributs différents.

Avantage : c'est du **HTML standard**, sans syntaxe spéciale à apprendre. Les attributs jouent le rôle des paramètres, et le composant les interpole dans son template.

</details>

## `@display="contents"` — rendre le composant transparent

Par défaut, un composant `<mjs-tuto-monkey>` est **un seul élément** dans le flux de son parent : dans un CSS `grid`, il occuperait une seule cellule (donc une ligne entière bloquée). L'attribut **`@display="contents"`** du `<style>` de base rend le custom element **transparent au flow** : ses enfants deviennent enfants directs du parent.

```html
<style @display="contents">
</style>
```

Dans l'exemple, le `.grid` a 4 colonnes ; grâce à `@display="contents"`, les 4 `<div class="cell">` de chaque monkey deviennent enfants directs du grid et s'alignent sur ses colonnes. Sans cet attribut, chaque composant occuperait une cellule unique.

> ⚠️ `@display` est un attribut du `<style>` de base (un seul par composant) qui fixe le `display` du `:host`. `@display="contents"` ⇒ `:host { display: contents }`. C'est le moyen idiomatique de poser `display: contents` sans dépendre de la cascade.

## Emplacement à remplir → slot

Quand on veut offrir un **trou à remplir** avec du contenu arbitraire fourni par le parent (et non des valeurs en attributs), on utilise un **slot**. Un slot anonyme `<@slot>` reçoit le contenu projeté ; un texte entre les balises sert de **contenu par défaut** quand le parent n'en fournit pas.

```html
<!-- tuto-implicit-snippets-alert.mjs -->
<div class="alert">
  <@slot>Une erreur s'est produite.</@slot>
</div>
```

```html
<!-- le parent : avec ou sans contenu -->
<@tuto-implicit-snippets-alert>                  <!-- → "Une erreur s'est produite." -->

<@tuto-implicit-snippets-alert>
  <strong>Succès</strong> : opération terminée.     <!-- → contenu projeté -->
</@tuto-implicit-snippets-alert>
```

### Slots nommés

Plusieurs emplacements distincts → des **slots nommés**. Côté enfant `<@slot nom>` ; côté parent, on cible un slot avec l'attribut `slot="nom"` sur l'élément projeté — pour **un seul** élément. Dès que **plusieurs** éléments visent le même slot nommé, on les regroupe dans un bloc `<@fill nom>…</@fill>` : le compilateur pose lui-même `slot="nom"` sur chacun de ses enfants (sucre de compilation, l'attribut natif reste la forme sous-jacente). Sans contenu de repli à délimiter, la fermante `</@slot>` est facultative — `<@slot nom>` et `<@slot>` seuls (ci-dessous) suffisent.

```html
<!-- enfant : trois emplacements + un corps libre -->
<div class="header"><@slot header></div>
<div class="content"><@slot></div>
```

```html
<!-- parent : remplit le slot "header" (deux éléments → bloc) et le slot par défaut -->
<@tuto-passing-snippets-list search=!{$search}>
  <@fill header>
    <span>name</span>
    <span>hex</span>
  </@fill>

  {for d in $filtered}
    <@tuto-passing-snippets-row name={d.name} hex={d.hex}>
  {end}
</@tuto-passing-snippets-list>
```

Le contenu sans attribut `slot=` ni bloc `<@fill>` (ici la boucle `{for}`) tombe dans le slot **anonyme** `<@slot>`. Un texte nu ne peut pas viser un slot nommé à l'intérieur d'un bloc `<@fill>` — enveloppe-le dans un élément (`<span>`, `<p>`…). On combine ainsi les deux idiomes : le conteneur (`list`) offre les emplacements via slots, et chaque ligne projetée (`row`) est elle-même un sous-composant paramétré par attributs.

<details>
<summary>🎓 <b>Pour débutants</b> — sous-composant ou slot, lequel choisir&nbsp;?</summary>

La question à te poser : **« qui décide du contenu&nbsp;? »**

- Le **fragment lui-même** connaît sa structure, seules quelques **valeurs** changent (un emoji, un nom, une couleur) → **sous-composant à attributs**. Tu passes les valeurs : `<@monkey emoji="🙈">`.
- Le **parent** veut injecter du **markup libre** (un titre riche, des boutons d'action, un corps quelconque) → **slot**. Le composant offre l'emplacement, le parent le remplit avec ce qu'il veut.

Souvent on mélange les deux, comme dans l'exemple de la liste de couleurs : un conteneur à slots, peuplé de lignes qui sont des sous-composants paramétrés.

</details>

> 🔗 Voir aussi : [Props & attributs](04-props.md) → les attributs HTML deviennent des `$` réactifs. Les trois régimes de `<@slot>` (anonyme, nommé littéral `<@slot nom>`, nommé évalué `<@slot {expr}>`) sont détaillés dans le tuto interactif n°12.

## Fragment textuel — `<@include>`

`<@include nom>` inline un **partial** : le contenu d'un fichier `_nom.mjs` est littéralement collé à la compilation, à l'emplacement de la balise — script, style et markup **fusionnés** dans le composant appelant. Ce n'est **pas** une unité d'architecture comme un composant (pas de balise `<mjs-…>`, pas de Shadow DOM propre, pas d'instance) : c'est un **copier-coller compile-time**, l'équivalent le plus proche d'un `render 'partial'` Rails.

`<@include nom>` s'écrit toujours **nu** — pas de contenu, pas de balise fermante : toute tentative de la fermer soi-même fait échouer la compilation.

```html
<!-- _entete.mjs — le partial, préfixé d'un underscore -->
<header class="entete">
  <h1>{$titre}</h1>
</header>
```

```html
<!-- page.mjs — l'inclusion -->
<script>
  $titre = 'Bienvenue'
</script>

<@include entete>
<main>…</main>
```

**Résolution du nom**, deux modes distincts, choix explicite par la syntaxe :

- **Nom simple** (`<@include entete>`) : cherche d'abord `_entete.mjs` **à côté** du fichier appelant, puis, si absent, dans `shared/_entete.mjs` (à la racine de `sourceDir`) — convention zero-config qui évite les chemins relatifs à rallonge, et permet à un dossier de redéfinir localement son propre partial.
- **Chemin relatif** (`<@include ../shared/entete>`, `<@include sous-dossier/entete>`) : résolution **stricte**, sans fallback — le déclencheur est la présence d'un `/` ou d'un `.` dans le nom. Absent → erreur de compilation explicite. Un chemin **absolu** (`<@include /var/x/entete>`) suit la même règle mais reste **confiné à `sourceDir`** : un fichier hors du dossier des sources (chemin absolu ou `../` qui en sort) est refusé à la compilation, comme pour un `@import`.

Le script et le style du partial sont **concaténés** à ceux du composant parent (même portée — les variables du partial et du parent se voient mutuellement) ; un partial peut lui-même contenir des `<@include>` (récursion), avec une **garde anti-cycle** : une inclusion circulaire (`A` inclut `B` qui inclut `A`) échoue à la compilation plutôt que de boucler à l'infini.

> 🔗 Pour du contenu **paramétré par valeurs** avec une vraie frontière d'instance (attributs réactifs, cycle de vie propre), préfère un sous-composant — voir plus haut. `<@include>` reste l'outil pour du HTML/script/style **littéralement dupliqué**, sans vouloir l'isoler en composant à part entière.

---

📚 **Apprendre en pratiquant** : ce chapitre correspond au **Tuto interactif n°11 (Snippets & composants paramétrés)** — le tableau « monkey » (sous-composant + `@display="contents"`), la liste de couleurs filtrable (slots nommés + lignes paramétrées) et l'alerte à contenu par défaut (slot anonyme avec fallback).
