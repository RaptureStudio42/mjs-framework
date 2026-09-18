# 7 · Bindings two-way

> 📚 Tuto interactif correspondant : **Chapitre 6 — Liaisons d'entrées** et **Chapitre 13 — Bindings avancés**. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Un **binding two-way** relie une valeur réactive à un attribut d'élément **dans les deux sens** : la variable met à jour le DOM, et l'interaction de l'utilisateur (frappe, clic, sélection) met à jour la variable. La syntaxe est le `!` collé au `=` :

```
attribut=!{$variable}
```

> ⚠️ Il n'y a **pas** de `@bind:value` ni `@bind:checked` en MJS. La seule forme officielle est `=!{…}` — le `!` se place entre le `=` et l'accolade ouvrante. À l'inverse, `attribut={…}` (sans `!`) est un binding **one-way** : la variable écrit dans le DOM, mais l'interaction ne remonte pas.

## Champ texte

Le binding le plus simple : `<input value=!{$x}>`. Frapper dans le champ écrit dans `$x`, et toute modification de `$x` réécrit le champ.

```html
<script>
  $name = 'world'
</script>

<input value=!{$name} />
<h1>Hello {$name}!</h1>
```

<details>
<summary>🎓 <b>Pour débutants</b> — « two-way », ça change quoi&nbsp;?</summary>

Avec un binding **one-way** (`value={$name}`), MJS écrit `$name` dans le champ — mais si tu tapes au clavier, la variable `$name` **ne bouge pas**. Tu devrais écouter l'événement `@input` et réaffecter `$name` toi-même.

Le `!` (`value=!{$name}`) fait les **deux** d'un coup : MJS pose l'écouteur pour toi, et tient la variable et le champ synchronisés en permanence. Tu déclares le lien une fois, MJS gère la circulation dans les deux sens.

</details>

## Cases à cocher — `checked=!`

Sur un `<input type="checkbox">`, on lie l'état coché à un booléen avec **`checked`** (pas `value`) :

```html
<script>
  $yes = false
</script>

<label>
  <input type="checkbox" checked=!{$yes} />
  Yes! Send me regular email spam
</label>

<button disabled={!$yes}>Subscribe</button>
```

Ici `disabled={!$yes}` est un binding **one-way** (calculé à partir de `$yes`) : on ne lie pas l'attribut `disabled` lui-même, on le dérive.

> ⚠️ **`aria-*` à `false` reste écrit, jamais retiré.** Un attribut `aria-*` lié à une valeur `false` s'écrit `aria-x="false"` : pour un lecteur d'écran, un panneau *replié* (`aria-expanded="false"`, l'attribut est bien présent) n'a pas le même sens qu'un élément qui *n'a pas cette propriété* (attribut absent). `null`/`undefined` retirent l'attribut normalement, `aria-*` compris — seule la valeur `false` fait exception, et seulement pour un nom d'attribut `aria-*`. Tout autre attribut (`disabled`, `hidden`, `data-*`…) retire bien l'attribut dès que sa valeur vaut `false`, `null` ou `undefined`.

## Casts de type — le suffixe sur le **nom** de l'attribut

Un `<input>` renvoie une **chaîne** — sauf `type="number"`/`"range"`, que MJS convertit d'office en nombre. Pour les autres types, ou pour un entier/flottant/booléen explicite, on ajoute un suffixe de cast **sur le nom de l'attribut**, avant le `=!` :

```html
<script>
  $a = 1
</script>

<input type="number" value.number=!{$a} min="0" max="10" />
<input type="range"  value.number=!{$a} min="0" max="10" />

<p>somme = {$a + 5}</p>
```

Casts reconnus (le suffixe vient **toujours** sur le nom, jamais sur l'accolade) :

| Suffixe | Conversion appliquée | Exemple |
|---|---|---|
| `.number` | `Number(v)` | `value.number=!{$prix}` |
| `.int` | `parseInt(v, 10)` | `value.int=!{$age}` |
| `.float` | `parseFloat(v)` | `value.float=!{$taux}` |
| `.string` | `String(v)` | `value.string=!{$txt}` |
| `.bool` / `.boolean` | vrai si `true`/`'true'`/`'1'`/`1` | `value.bool=!{$ok}` |

> ⚠️ Le suffixe se met sur le **nom de l'attribut** : `value.number=!{$n}` ✓. Les formes `value=!.number{$n}` ou `value=!{$n}.number` sont **incorrectes** et ne compilent pas comme un cast. Sur `type="number"`/`"range"`, `value=!{$a}` **sans** `.number` donne déjà un nombre ; sur les autres types, il reste une chaîne : `"3" + "5"` donnerait `"35"`.

Les mêmes suffixes valent sur une liaison de **composant** (`<mon-champ value.number=!{$n}>`) : le composant reçoit la propriété `value`, et c'est la valeur qu'il **remonte** qui est convertie. La conversion ne joue en effet que dans ce sens-là, ici comme sur une balise native — descendante, la valeur vient de ton modèle, elle est déjà du bon type ; montante, elle vient de ce que quelqu'un a tapé.

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi mon nombre se comporte comme du texte&nbsp;?</summary>

En HTML, la valeur d'un champ est une chaîne de caractères — sauf sur `type="number"` et `type="range"`, que MJS convertit d'office en nombre. Sur les autres types, si tu lies `value=!{$a}` puis que tu fais `$a + $b`, tu obtiens une concaténation (`"1" + "2"` = `"12"`) au lieu d'une addition.

Le suffixe `.number` dit à MJS : « quand tu remontes la valeur du champ vers la variable, convertis-la d'abord en nombre ». Du coup `$a` contient bien `1` (le nombre), et `$a + $b` fait `3`.

</details>

## Boutons radio & cases groupées — `@group=!`

Quand plusieurs entrées partagent **une même variable**, on les lie avec **`@group=!{$x}`**. MJS adapte le comportement selon le type :

- **radios** → `$x` reçoit la `value` de l'entrée sélectionnée (valeur unique) ;
- **checkboxes** → `$x` est un **tableau** des `value` cochées.

```html
<script>
  $scoops = 1
  $flavours = []
  menu = ['cookies and cream', 'mint choc chip', 'raspberry ripple']
</script>

{for number in [1, 2, 3]}
  <label>
    <input type="radio" name="scoops" value={number} @group=!{$scoops} />
    {number} {number === 1 ? 'scoop' : 'scoops'}
  </label>
{end}

{for flavour in menu}
  <label>
    <input type="checkbox" name="flavours" value={flavour} @group=!{$flavours} />
    {flavour}
  </label>
{end}
```

Les casts s'appliquent aussi : `@group.number=!{$scoops}` remonterait des nombres au lieu de chaînes.

> ⚠️ La `value` de chaque entrée est posée en **one-way** (`value={number}`), c'est `@group` qui porte le `=!`. Ne mets pas `value=!` sur des radios groupées.

## Listes déroulantes — `<select>`

Sur un `<select>`, `value=!{$x}` lie l'option choisie. Avec l'attribut `multiple`, `$x` devient un **tableau**.

```html
<script>
  $selectedId = 1
  $flavours = []
  questions = [{ id: 1, text: 'A' }, { id: 2, text: 'B' }]
</script>

<select value=!{$selectedId}>
  {for q in questions}
    <option value={q.id}>{q.text}</option>
  {end}
</select>

<select multiple value=!{$flavours}>
  {for flavour in ['vanille', 'fraise', 'menthe']}
    <option>{flavour}</option>
  {end}
</select>
```

> ⚠️ La valeur d'une `<option>` est une **chaîne** (`"1"`, pas `1`). Pour comparer à un identifiant numérique, force la conversion à la lecture (`questions.find (x)-> x.id == +$selectedId`) ou pose un cast `value.number=!{$selectedId}`.

## Zone de texte & contenu riche

`<textarea>` se lie comme un `<input>`, avec `value=!{$x}` (et non via le contenu entre les balises) :

```html
<textarea rows="8" value=!{$value}></textarea>
```

`@text=!{$x}` lie le `textContent` d'un nœud dans les deux sens : la variable écrit dans le nœud, et taper dans un `contenteditable` remonte la saisie vers la variable.

```html
<script>
  $note = 'Prends des notes ici'
</script>

<div @text=!{$note} contenteditable></div>
<p>{$note}</p>
```

Il n'existe pas de forme unidirectionnelle `@text={expr}` : pour simplement **afficher** une valeur sans la rendre éditable, l'interpolation `{expr}` suffit. `@text=!` est le choix sûr pour un contenu éditable — rien n'y est jamais interprété comme du HTML, à la différence de son jumeau ci-dessous.

Pour du HTML éditable, **`@html=!{$html}`** lie l'`innerHTML` du nœud dans les deux sens — frapper dans un `contenteditable` met à jour la variable :

```html
<script>
  $html = '<p>Écris du <strong>texte</strong> !</p>'
</script>

<div @html=!{$html} contenteditable></div>
<pre>{$html}</pre>
```

> ⚠️ Le HTML brut expose au **XSS** : `@html=!` pose l'`innerHTML` sans la moindre sanitisation, exactement comme `{{ }}` ci-dessous — un contenu utilisateur (commentaire relu depuis la base, par exemple) n'y va jamais sans nettoyage côté serveur.

### HTML brut en affichage — `{{ expr }}`

`@html=!` **édite** du HTML (deux sens). Pour seulement **afficher** du HTML sans l'échapper, utilise l'interpolation à **double accolade** `{{ expr }}` — le simple `{ expr }` échappe toujours le texte :

```html
<div>{{ $articleHtml }}</div>
```

> ⚠️ Le HTML brut expose au **XSS**. N'utilise `{{ }}` que sur du contenu de confiance, jamais une saisie utilisateur non assainie.

## Bindings sur une propriété d'objet

La cible d'un `=!` n'est pas forcément une variable nue : ce peut être un **champ d'objet** ou un **getter/setter d'instance**. Pratique dans un `{for}` où chaque ligne lie son propre élément :

```html
<script>
  $todos = [{ done: false, text: 'finir le tuto' }]
</script>

{for todo in $todos}
  <li @class{todo.done}="done">
    <input type="checkbox" checked=!{todo.done} />
    <input type="text" value=!{todo.text} />
  </li>
{end}
```

On peut aussi lier directement les propriétés d'une instance de classe : `value.number=!{$box.width}` écrit dans le setter `width` de l'objet `$box`.

## Dimensions de l'élément (lecture seule)

`clientWidth=!{$w}` et `clientHeight=!{$h}` exposent les dimensions **mesurées** du nœud dans des variables réactives — MJS installe un `ResizeObserver` qui réécrit `$w`/`$h` à chaque changement de taille. Ce sont des grandeurs **en lecture seule** : écrire dans `$w` ne redimensionne pas l'élément.

```html
<script>
  $size = 42
</script>

<input type="range" value.number=!{$size} min="10" max="100" />

<div clientWidth=!{$w} clientHeight=!{$h}>
  <span style="font-size: {$size}px" contenteditable>edit this text</span>
  <span>{$w} x {$h}px</span>
</div>
```

> ⚠️ Pas besoin de déclarer `$w` / `$h` dans le `<script>` : un `$` lu dans le template est auto-déclaré. Ils valent `0` avant le premier calcul de layout.

## Bindings de médias — `<audio>` / `<video>`

Sur un élément média, plusieurs propriétés sont bindables. La plupart sont **read-write** ; `duration` est **read-only** (le navigateur la fournit, on ne peut pas l'imposer).

```html
<audio
  src={$src}
  currentTime=!{$time}
  duration=!{$duration}
  paused=!{$paused}
></audio>

<button @click={$paused = !$paused}>{$paused ? '▶' : '⏸'}</button>
```

| Binding | Sens | Effet |
|---|---|---|
| `currentTime=!` | read-write | position de lecture (secondes) |
| `paused=!` | read-write | écrire `false` appelle `play()`, `true` → `pause()` |
| `volume=!` `muted=!` `playbackRate=!` | read-write | volume / sourdine / vitesse |
| `duration=!` | **read-only** | durée totale (renseignée par le navigateur) |

## Bindings sur un composant enfant

`=!{…}` fonctionne aussi sur une **prop** de composant : la valeur circule dans les deux sens entre parent et enfant. Côté enfant, la prop est une variable `$` **ordinaire** — rien à déclarer.

```html
<!-- parent -->
<@tuto-keypad value=!{$pin} @submit>
```

```html
<!-- enfant tuto-keypad.mjs -->
<script>
  $value ?= ''                      # prop ordinaire, bindable depuis le parent
  select = (digit)-> $value += digit
</script>
```

Chaque écriture de `$value` côté enfant remonte vers `$pin` côté parent. La référence à **l'instance** du composant (pour appeler ses méthodes) passe par `@this`, traité au chapitre [Directives DOM](09-directives-dom.md).

> 🔗 Voir aussi : [Directives DOM](09-directives-dom.md) → `@this=!{ref}` (référence au nœud / à l'instance, **sans `$`**) et `@attach` (actions DOM).

---

📚 **Apprendre en pratiquant** : ce chapitre correspond aux **Tutos interactifs n°6 (Liaisons d'entrées)** — texte, numériques, cases, `<select>`, groupes, `<select multiple>`, `<textarea>` — et **n°13 (Bindings avancés)** — `contenteditable`/`@html`, bindings dans un `{for}`, médias, dimensions, `@this`, bindings de composant.
