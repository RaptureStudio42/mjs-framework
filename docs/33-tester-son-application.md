# 33 · Tester son application

> 📚 Pas de chapitre de tuto interactif dédié (le harnais tourne côté Node, hors de l'éditeur live du tuto) : cette page se suffit à elle-même.

## 1. Pourquoi ce module existe

Le framework se teste lui-même, avec des milliers de cas, et ne proposait rien à ceux qui l'utilisent : aucune façade publique pour monter un composant hors du navigateur et vérifier ce qu'il affiche. Le module `testing` ouvre une porte sur la mécanique qui existait déjà en interne : compiler le projet avec le **vrai** compilateur (le même `Bundler` que `mjs build`), charger le résultat dans un DOM simulé, monter un composant, agir dessus, lire ce qu'il affiche.

**Ce n'est pas un lanceur de tests.** Le module n'impose ni Mocha, ni Vitest, ni Jest : on monte, on agit, on lit — l'assertion reste celle de l'outil que l'auteur préfère.

## 2. Installation

Le DOM simulé dans lequel le harnais charge le projet compilé vient de `happy-dom` — une dépendance **optionnelle** (même patron que `playwright` pour le moteur de rendu navigateur : le framework ne l'impose à personne), déclarée en pair optionnel dans `package.json`. Son absence ne fait pas tomber une erreur de résolution de module au visage de l'auteur : elle donne un message qui dit quoi installer (§6).

```bash
npm i -D happy-dom
```

```ts
import { createHarness } from 'modularjs-framework/testing'
```

## 3. Un exemple complet

Deux petits composants, dans le dossier des sources du projet :

```html
<!-- my-counter.mjs -->
<script>
  $start  ?= 0
  $count  = $start
  $double = $count * 2
</script>

<div class="counter">
  <span class="value">{$count}</span>
  <span class="double">{$double}</span>
  <button class="plus" @click={$count++}>+</button>
</div>
```

```html
<!-- my-greeter.mjs -->
<script>
  $name     ?= "monde"
  $greeting = "Bonjour, " + $name + " !"
</script>

<p class="hello">{$greeting}</p>
<input class="field" value=!{$name}>
```

Et le fichier de test, du début à la fin :

```ts
// tests/my-components.test.ts
import assert from 'node:assert/strict'
import { createHarness } from 'modularjs-framework/testing'

describe('my-counter & my-greeter', function () {
  this.timeout(60000)

  let app: any

  before(async () => {
    app = await createHarness()
  })

  after(async () => {
    await app.destroy()
  })

  it('monte un composant et lit ce qu\'il affiche', async () => {
    const c = await app.mount('my-counter', { start: 3 })
    assert.equal(c.text('.value'), '3')
    assert.equal(c.text('.double'), '6')
    assert.equal(c.state.count, 3)
    c.destroy()
  })

  it('click() agit et attend le rendu', async () => {
    const c = await app.mount('my-counter', { start: 3 })
    await c.click('.plus')
    assert.equal(c.text('.value'), '4')
    assert.equal(c.state.count, 4)
    c.destroy()
  })

  it('type() remplit un champ et la liaison remonte', async () => {
    const c = await app.mount('my-greeter')
    assert.equal(c.text('.hello'), 'Bonjour, monde !')
    await c.type('.field', 'Ada')
    assert.equal(c.state.name, 'Ada')
    assert.equal(c.text('.hello'), 'Bonjour, Ada !')
    c.destroy()
  })

  it('set() change une prop depuis le parent', async () => {
    const c = await app.mount('my-greeter')
    await c.set({ name: 'Ada' })
    assert.equal(c.text('.hello'), 'Bonjour, Ada !')
    c.destroy()
  })
})
```

Lancé avec Mocha (le lanceur de ce dépôt) : `npx mocha tests/my-components.test.ts --extension ts --require tsx/esm --exit`. Le même fichier tourne tel quel avec un autre lanceur — Vitest, Jest, `node:test` — seules les fonctions `describe`/`it`/`assert` changent, rien d'autre dans ce fichier ne dépend de l'un d'entre eux.

## 4. Les verbes

Depuis l'interface `MountedComponent` — ce que rend `app.mount(nom, props?)` :

| Membre | Ce qu'il fait |
|---|---|
| `el` | l'élément lui-même (`<mjs-…>`), pour les cas que le harnais ne couvre pas |
| `shadow` | son shadow root — là où vivent les nœuds du HTML du composant |
| `state` | l'état réactif du composant, en lecture (`$count` se lit `state.count`) |
| `find(selecteur)` | premier nœud du composant qui correspond au sélecteur, ou `null` |
| `findAll(selecteur)` | tous les nœuds qui correspondent au sélecteur |
| `text(selecteur?)` | texte affiché — du composant entier, ou du premier nœud qui correspond |
| `html()` | markup rendu, pour une assertion de forme ou un message d'échec lisible |
| `click(selecteur)` | clique, puis attend que le rendu ait eu lieu |
| `fire(selecteur, type, init?)` | déclenche n'importe quel événement, puis attend le rendu |
| `type(selecteur, valeur)` | saisit une valeur dans un champ (valeur posée + événement `input`), puis attend le rendu |
| `set(props)` | change des props depuis le parent, puis attend le rendu |
| `tick()` | attend que le rendu en attente ait eu lieu |
| `destroy()` | retire le composant de la page (ses hooks de démontage tournent) |

Les quatre verbes d'action (`click`, `fire`, `type`, `set`) attendent le rendu tout seuls — `tick()` est rarement nécessaire, les verbes ci-dessus le font déjà.

Et depuis `Harness` — ce que rend `createHarness(opts?)` :

| Membre | Ce qu'il fait |
|---|---|
| `mount(nom, props?)` | monte un composant par son nom de fichier (`my-counter.mjs` → `'my-counter'`) |
| `window` | la fenêtre simulée, pour les cas limites (horloge, taille, `localStorage`…) |
| `document` | son document |
| `µ` | le runtime du framework, tel que la page le voit |
| `components` | les composants trouvés dans le projet compilé, par nom |
| `destroy()` | ferme la fenêtre et libère le compilateur — à appeler en fin de fichier de test |

Et les options de `createHarness(opts)` :

| Option | Défaut | Rôle |
|---|---|---|
| `root` | dossier courant | racine du projet — c'est là que `mjs.config.json` est cherché |
| `sourceDir` | — | surcharge ponctuelle (projet sans `mjs.config.json` : bacs à sable, tests du framework lui-même) |
| `outputDir` | — | idem |
| `manifestPath` | — | idem |
| `stylesheetsDir` | — | idem |
| `url` | `http://localhost/` | URL de la page simulée — utile pour tester un routeur |
| `only` | tout le projet | ne charge QUE ces composants, par nom de fichier sans extension |

## 5. Trois surprises

- **Un harnais par fichier de test suffit.** La compilation est le gros du coût, le montage est instantané : on crée le harnais une fois (`before`), on le ferme une fois (`after`) — c'est ce que fait l'exemple du §3.
- **Tout le projet est chargé par défaut, pas seulement le composant testé.** Un composant imbriqué dans celui qu'on monte se monte donc tout seul, sans rien déclarer. Sur un très gros projet, l'option `only` restreint la liste chargée — au prix de devoir nommer explicitement les enfants que le composant testé embarque.
- **`set()` ne fait pas la même chose selon la valeur.** Une valeur scalaire (chaîne, nombre, booléen, `null`) passe par l'**attribut** — le mécanisme réel qu'observe un composant dans une vraie page (`null`/`false` retire l'attribut, `true` pose un attribut vide, comme un attribut booléen HTML). Une valeur qu'un attribut ne saurait porter (objet, tableau, fonction) passe par l'écriture d'état du runtime, celle que le compilateur émet dans ce même cas. **Au montage en revanche**, `mount('nom', { … })` pose les props directement sur l'élément avant sa mise à niveau par le compilateur : objets et tableaux passent donc tels quels, sans détour par l'attribut.

## 6. Les messages d'erreur

Le harnais parle quand il ne peut pas faire ce qu'on lui demande :

| Message | Se déclenche quand |
|---|---|
| `[mjs/testing] aucun mjs.config.json trouvé depuis ${racine}, et aucun sourceDir donné — passe { root: '…' } ou { sourceDir: '…' } à createHarness().` | ni `mjs.config.json` (en remontant depuis `root`), ni `sourceDir` fourni en option |
| `[mjs/testing] le projet ne compile pas, le harnais ne peut rien monter :\n${detail}` | le projet compile avec des erreurs — `detail` reprend les messages du compilateur |
| `[mjs/testing] le DOM simulé est absent — installe-le : npm i -D happy-dom (dépendance optionnelle, le framework ne l'impose à personne).` | `happy-dom` n'est pas installé |
| `[mjs/testing] aucun mjs_core-<empreinte>.js dans ${dossier} — le build n'a rien écrit là où le harnais regarde (vérifie outputDir).` | le dossier de sortie ne contient pas le cœur du runtime compilé |
| `[mjs/testing] le composant '${nom}' n'a pas pu être chargé : ${detail}` | le composant existe dans le projet compilé mais son chargement a levé une erreur |
| `[mjs/testing] aucun composant '${nom}' dans le projet compilé. Connus : ${connus}` | `mount()` reçoit un nom absent des composants chargés — faute de frappe, ou composant exclu par `only` — le message liste les noms connus |
| `[mjs/testing] aucun nœud ne correspond à '${selecteur}' dans <${tag}>.` | `click`/`fire`/`type` visent un sélecteur que le composant monté ne contient pas — le message nomme le composant visé |

## 7. Ce que le harnais ne fait pas

Il ne remplace pas un test de navigateur réel. Le DOM simulé (`happy-dom`) n'a ni mise en page, ni animations réelles, ni moteur de rendu : il expose les mêmes API DOM que le composant utilise (`querySelector`, `dispatchEvent`, attributs…), mais ne dessine rien. Une transition CSS ne joue pas, une mesure de position ou de taille ne reflète aucune vraie disposition, un focus visuel ne se voit pas. Pour tout ce qui **se voit** — transitions, mise en page, focus, rendu pixel — il faut un vrai navigateur. Le harnais couvre le comportement (ce que l'état devient, ce que le texte affiche, ce qui se déclenche), pas ce que l'œil verrait.

Il ne donne accès, sur l'élément monté, qu'à **deux** propriétés internes : `_shadow` (la racine d'ombre, ou l'élément lui-même en mode léger) et `_state` (l'état du composant). Ce sont les seules dont le nom est garanti stable — le harnais s'en sert lui-même pour `shadow` et `state`. Tout le reste de la mécanique interne porte des noms préfixés `_mjs_` que la construction de production **raccourcit** (un nom d'une ou deux lettres, différent d'un projet à l'autre) : un test qui lit `el._mjs_quelqueChose` marche sur un build de développement et rend `undefined` sur un build de production, sans la moindre erreur. Passe par les verbes du harnais (`state`, `text()`, `html()`, `find()`), jamais par une propriété interne autre que ces deux-là.

Il ne charge pas non plus les feuilles de style **partagées** en mode `css: 'lazy'` ([32 · CLI & configuration](32-cli-et-configuration.md) § `css`) : ce mode produit de vrais fichiers `.css`, demandés par le runtime au montage du premier composant qui les déclare — un fetch que `createHarness()` ne simule pas. `µ.CSS` reste vide, sans le moindre avertissement : un composant `@css="marque"` monte et s'affiche normalement, juste sans le style partagé appliqué. Pour tester un comportement lié au CSS partagé (thème, classes issues d'une feuille `@css`), compile le projet en `css: 'bundle'` (le défaut) ou `css: 'split'` — les deux seuls modes où le harnais charge réellement ces feuilles.

---

📚 **Voir aussi** : [32 · CLI & configuration](32-cli-et-configuration.md) pour `mjs.config.json`, que `createHarness()` lit exactement comme `mjs build`/`mjs check` ; [4 · Props & attributs](04-props.md) pour la manière dont un composant reçoit ce que `mount()`/`set()` lui passent ; [6 · Événements](06-evenements.md) pour ce que `click()`/`fire()` déclenchent réellement.
