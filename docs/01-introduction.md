# 1 · Introduction

> 📚 Tuto interactif correspondant : **Chapitre 1 — Introduction**. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

**ModularJS (MJS)** est un framework de composants compilé. Tu écris des fichiers `.mjs` (markup + logique + style) ; un **compilateur** les transforme en `.js` standard, prêt à tourner dans le navigateur sans dépendance de runtime lourde. La philosophie tient en trois points : réactivité résolue à la **compilation**, composants = **Custom Elements** natifs, style **scopé** par Shadow DOM.

## Réactivité résolue à la compilation

En MJS, une variable réactive se note `$x`. Le compilateur **analyse le code** (AST) et sait, statiquement, quel nœud du DOM dépend de quelle donnée. Il génère du JS qui met à jour **précisément** ces nœuds — pas de re-rendu de composant, pas de diff de DOM virtuel, **pas de `Proxy` au runtime**.

C'est la différence majeure avec un framework qui enveloppe l'état dans un `Proxy` pour intercepter les lectures/écritures : ce travail est ici fait **une fois, à la compilation**, pas à chaque accès en production. Gain direct : moins de code expédié, pas d'overhead d'interception, des mises à jour chirurgicales.

<details>
<summary>🎓 <b>Pour débutants</b> — « compilé » vs « interprété », ça change quoi&nbsp;?</summary>

Beaucoup de frameworks sont des **bibliothèques** : tu télécharges leur moteur, et c'est lui qui, dans le navigateur de ton visiteur, lit ton code et décide quoi afficher. Ce moteur a un coût (poids + temps de calcul).

MJS fait le gros du travail **avant**, sur ta machine, au moment où tu construis le projet : il lit ton `.mjs` et écrit à la place un `.js` déjà optimisé, qui sait exactement quoi faire. Le navigateur du visiteur n'a plus qu'à exécuter des instructions simples. Tu paies l'intelligence une fois (à la compilation) au lieu de la repayer à chaque visite.

</details>

## Composants = Custom Elements + Shadow DOM

Un composant MJS n'est pas une abstraction maison : c'est un **Custom Element** standard du navigateur. Un fichier `mon-bouton.mjs` devient la balise `<mjs-mon-bouton>`, enregistrée via `customElements.define`. Tu peux l'utiliser comme n'importe quelle balise HTML, l'inspecter dans les outils du navigateur, l'imbriquer.

Son `<style>` est attaché en **Shadow DOM** : les règles CSS sont **isolées**, elles ne fuient pas vers le reste de la page et ne sont pas écrasées par le CSS global. Pas besoin de conventions de nommage (**bem**) ni de CSS-in-JS pour éviter les collisions — c'est le navigateur qui garantit l'isolation.

## Parenté avec Svelte

MJS s'inspire de **Svelte** : même esprit « compilateur plutôt que runtime », même structure de fichier composant (`<script>` + markup + `<style>`), et le **parcours du tuto interactif suit chapitre pour chapitre celui de Svelte**. Si tu connais Svelte, tu retrouveras tes repères.

Mais MJS a ses **spécificités**, et c'est là que ce calque s'arrête :

- **Langage par défaut : Civet** (proche de CoffeeScript), pas du JavaScript. Méthodes en `->`, interpolation `"#{x}"`.
- **Custom Elements + Shadow DOM** natifs, là où Svelte génère ses propres scopes de style.
- **Symbole `$`** pour le réactif (vs `let` + runes `$state`), avec **auto-déclaration** et **dérivés automatiques** (`$y = expr($x)`).
- **Pas d'`import … from`** dans un `<script>` : on importe avec la directive `@import` (voir [Anatomie d'un composant → Importer un module](02-composant.md) et [Pièges & bonnes pratiques](18-pieges.md)).
- Sucre propre à MJS : `value=!`, `@event` nu, `--var={}`, blocs `{if}`/`{for}`, etc.

> ⚠️ Ne recopie pas la syntaxe d'un autre framework — des `$props()`, `$state`, `<svelte:*>` n'existent pas en MJS. La doc et les tutos te donnent l'idiome exact : suis-le plutôt que de deviner par analogie.

## Mini-exemple « Hello »

Le plus petit composant utile : un `<script>`, un peu de markup, une interpolation.

```html
<script>
  name = 'ModularJS'
</script>

<h1>Hello {name.toUpperCase()}!</h1>
```

Le `<script>` est en Civet ; `name` est une variable locale, et `{ … }` dans le markup **interpole** une expression — ici l'appel de méthode `name.toUpperCase()`. Rendu : `Hello MODULARJS!`.

> ℹ️ Ici `name` est une simple variable (pas de `$`) : sa valeur est figée au rendu. Pour qu'un changement de valeur **mette à jour l'affichage tout seul**, on préfixe par `$` → c'est l'objet du [chapitre Réactivité](03-reactivite.md).

<details>
<summary>🎓 <b>Pour débutants</b> — d'où vient le HTML hors balises&nbsp;?</summary>

Un fichier `.mjs` se lit du haut vers le bas comme un petit document : d'abord (optionnel) un bloc `<script>` pour la logique, puis du **markup HTML** posé directement, puis (optionnel) un bloc `<style>`. Tout ce qui n'est ni `<script>` ni `<style>` est le **HTML** affiché par le composant.

Les accolades `{ … }` sont des « trous » dans ce HTML : MJS y insère le résultat de l'expression JavaScript/Civet que tu écris. `{name}` affiche la valeur de `name` ; `{name.toUpperCase()}` affiche cette valeur en majuscules.

</details>

---

📚 **Apprendre en pratiquant** : ce chapitre correspond au **Tuto interactif n°1 (Introduction)** — premier composant, dynamique, attributs, stylisation, composants imbriqués, balisage HTML. La structure d'un composant est détaillée dans [Anatomie d'un composant](02-composant.md).
