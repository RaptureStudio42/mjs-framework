# 4 · Props & attributs

> 📚 Tuto interactif correspondant : **Chapitre 3 — Props**. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Une **prop** est une donnée passée d'un parent à un composant enfant, via un **attribut** de balise. Côté parent on écrit l'attribut ; côté enfant on le lit comme un `$` réactif. Aucune déclaration de prop n'est nécessaire.

## Passer une prop (parent → enfant)

Le parent pose l'attribut sur la balise enfant. La valeur entre **accolades `{ }`** est une expression ; entre **guillemets `" "`** c'est une chaîne littérale.

```html
<!-- parent : app.mjs -->
<@nested answer={42}>
<@nested titre="Bonjour">
```

Dans l'enfant, l'attribut `answer` se lit `$answer`, `titre` se lit `$titre` — préfixés par `$`, donc **réactifs** :

```html
<!-- enfant : nested.mjs -->
<p>La réponse est {$answer}</p>
```

> ⚠️ **Ne déclare pas** `$answer = ''` (ou toute autre valeur vide) « pour annoncer la prop » par réflexe venu d'autres frameworks. Un `$answer` lu dans le HTML de l'enfant est **auto-déclaré** : il reçoit directement la valeur passée par le parent. Une initialisation à vide ne sert à rien et brouille la lecture.

<details>
<summary>🎓 <b>Pour débutants</b> — props, attributs : c'est la même chose&nbsp;?</summary>

Quand tu écris une balise HTML normale, tu lui donnes des **attributs** : `<img src="…" alt="…">`. Une **prop** (propriété), c'est exactement ça, mais pour un composant MJS : `<@nested answer={42}>`. Tu « branches » une donnée sur l'enfant via la balise.

Côté enfant, cette donnée arrive sous forme de variable réactive : l'attribut `answer` devient `$answer`. L'enfant n'a rien à réclamer ni à déclarer — il lit `$answer` là où il en a besoin, et MJS se charge de le remplir avec ce que le parent a passé.

Différence accolades vs guillemets : `answer={42}` passe le **nombre** 42 (expression évaluée) ; `answer="42"` passerait la **chaîne** `"42"`. Pour autre chose qu'un texte (nombre, booléen, objet, variable), utilise les accolades.

</details>

## Attribut sans valeur

Sur une balise de composant, un attribut écrit sans valeur passe `true` — `<@checkbox disabled>` équivaut à `disabled={true}`, exactement comme `<input disabled>` en HTML natif. `title=""` (valeur écrite mais vide) passe `''`.

```html
<@checkbox disabled>   <!-- équivaut à disabled={true} -->
```

> ℹ️ Le runtime lit les textes `"true"` et `"false"` comme des booléens. Dans du HTML servi par un back, où aucun compilateur MJS ne passe, écris `disabled="true"` explicitement — un attribut nu y arrive comme `''`.

## Valeurs par défaut

Si le parent **omet** l'attribut, la prop est `undefined` côté enfant. On donne une valeur par défaut en **initialisant simplement la variable** dans le `<script>` de l'enfant :

```html
<!-- enfant : nested.mjs -->
<script>
  $answer = 'un mystère'
</script>

<p>La réponse est {$answer}</p>
```

Le parent peut alors fournir la valeur ou non :

```html
<!-- parent : app.mjs -->
<@nested answer={42}>     <!-- affiche : La réponse est 42 -->
<@nested>                 <!-- affiche : La réponse est un mystère -->
```

> 🔎 **Le parent gagne toujours, sans précaution particulière.** Le `<script>` s'exécute au *constructeur* ; les attributs, eux, sont lus au *montage* (`connectedCallback`), donc **après**. Une affectation simple `=` ne peut donc pas écraser la valeur du parent — y compris quand celle-ci est `0`, `false` ou `''`, qui arrivent intactes.

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi pas <code>?=</code>&nbsp;?</summary>

`$answer ?= 'un mystère'` (« assigne seulement si vide ») est du Civet parfaitement valide, et on le croise dans du code plus ancien. Mais ici il ne change **rien** : au moment où le `<script>` tourne, la prop du parent n'est pas encore arrivée — `$answer` est toujours vide, la condition est toujours vraie. Autant écrire `=`, plus court et plus simple à lire.

</details>

## Les props sont réactives

Une prop n'est pas une copie figée au montage : si la donnée **change chez le parent**, l'enfant se met à jour automatiquement. Le lien parent → enfant est vivant, exactement comme un `$` interne. Rien de spécial à faire côté enfant : il lit `$answer`, et tout endroit du HTML qui l'affiche suit les changements.

## Propagation (spread) : `{...obj}`

Quand un enfant attend beaucoup de props, les énumérer une à une devient verbeux. La syntaxe **spread `{...obj}`** développe un objet en une série d'attributs :

```html
<script>
  pkg = {
    name: 'modularjs'
    version: 2
    description: 'ultra rapide'
    website: 'https://modularjs.rapturestudio.fr'
  }
</script>

<@info {...pkg}>
```

L'enfant reçoit `$name`, `$version`, `$description`, `$website`. La propagation est **réactive bit à bit** : remplacer tout l'objet ou une seule de ses clés propage le changement.

On peut **mélanger** spread et attributs nommés. Comme avec `Object.assign`, l'ordre décide : un attribut explicite **après** le spread l'écrase ; **avant**, il est écrasé par l'objet.

```html
<@info {...pkg} version="1.7-beta">   <!-- version reste "1.7-beta" -->
```

> ℹ️ Le spread marche aussi sur une **balise HTML native** (`<input {...attrs} />`) : chaque clé est passée à `setAttribute` — pratique pour relayer un lot d'attributs de formulaire ou d'accessibilité (`aria-*`) stockés dans un objet.

---

📚 **Apprendre en pratiquant** : ce chapitre correspond au **Tuto interactif n°3 (Props)** — déclaration d'attributs, valeurs par défaut, propagation (spread). Voir aussi [Réactivité](03-reactivite.md) (les `$` côté enfant) et [Anatomie d'un composant](02-composant.md) (interpolation d'attributs et composants imbriqués).
