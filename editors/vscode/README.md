# ModularJS pour VS Code

Coloration syntaxique des composants ModularJS. Un fichier `.mjs` du framework n'est pas un
module JavaScript de Node : c'est un composant qui réunit un script Civet, un gabarit, des
variables de thème et un style SASS. Sans cette extension, l'éditeur le lit comme du
JavaScript et le souligne en erreurs de la première à la dernière ligne.

## Ce qu'elle colore

- les blocs `<script module>`, `<script>`, `<theme>` et `<style>`, chacun dans le langage annoncé
  par son `lang="…"` (Civet et SASS par défaut — voir plus bas), y compris la forme nommée
  `<style name="…">` ;
- le bloc racine `<routes target="…">` : chemins, paramètres `:id`, segments facultatifs
  `(:an)` et `(fr)`, joker `*`, noms de composants et commentaires `#` ;
- la table **calculée** `@routes = {…}` d'un `<script>`, et l'ajout ciblé
  `@routes['vue']['/x'] = 'x-page'` : mêmes couleurs de chemin, mêmes noms de composants ;
- le gabarit : balises, balises-directives `<@view>`, `<@slot>`…, attributs ;
- les directives d'attribut `@click={…}`, `@transition.fly={…}`, les liaisons `value=!{…}` ;
- les directives de premier niveau `@import`, `@css`, `@persist`, `@routes` ;
- les blocs de gabarit `{if}`, `{elsif}`, `{else}`, `{end}`, `{for … in …}`, `{await}` ;
- les symboles : `$x` (état local), `$$x` (global et variables de thème), `§x` et `§§x`
  (contexte), `µx` (runes du framework), `@x` et `@@x` (l'instance).

## Le langage des blocs `<script>`

Le compilateur accepte quatre langages de script (`src/languages/index.ts`) et l'extension suit le
même `lang` :

| balise | coloration | accepté par le compilateur |
| --- | --- | --- |
| `<script>`, `<script module>`, `<script lang="coffee">` | CoffeeScript | oui |
| `<script lang="ts">` | TypeScript | oui |
| `<script lang="js">` | JavaScript | oui |
| `<script lang="civet">` | CoffeeScript, faute de grammaire Civet | oui |

Dans un bloc `coffee`, `ts`, `js` ou `civet` — donc dans TOUS les blocs `<script>`, `<script>` nu
compris — les symboles du framework (`$x`, `$$x`, `§x`, `µx`, `@x`) gardent leur couleur même au fond
d'une construction du langage hôte — `if (a) $etat = 1`, `{ k: $etat }`, `compte = if $etat then 1` —
sans jamais déteindre sur une chaîne ni sur un commentaire.

Civet n'a pas de grammaire dans VS Code — aucune extension installée ne publie `source.civet`. Ses
blocs reçoivent celle de CoffeeScript, la plus proche : affectations, fonctions `->`, chaînes,
nombres et commentaires `#` sortent juste ; les emprunts de Civet à TypeScript (annotations de type,
`class` moderne) non. C'est aussi ce que reçoit un `<script>` nu, dont le langage par défaut est
pourtant Civet côté compilateur.

## Le langage des blocs `<style>` et `<theme>`

Comme le compilateur, l'extension lit **SASS indenté par défaut** et suit l'attribut `lang` quand il
est là :

| balise | coloration | accepté par le compilateur |
| --- | --- | --- |
| `<style>`, `<style lang="sass">`, `<theme>` | SASS indenté (défaut) | oui |
| `<style lang="scss">`, `<theme lang="scss">` | SCSS | oui |
| `<style lang="css">`, `<theme lang="css">` | CSS | oui |
| `<style lang="less">`, `<theme lang="less">` | Less | **non** |
| `<style lang="stylus">`, `<theme lang="stylus">` | SASS indenté, faute de grammaire Stylus | **non** |

Les deux dernières lignes ne colorent que l'éditeur : `mjs build` n'accepte que `sass`, `scss` et
`css` (`src/transpiler/sections.ts`) et refusera un bloc en `less` ou en `stylus`. Elles sont là
pour un composant en cours de portage, où l'on veut déjà lire son style correctement.

Stylus n'a pas de grammaire dans VS Code — aucune extension installée ne publie `source.stylus`. Ses
blocs reçoivent donc la grammaire SASS, dont la syntaxe indentée est la plus proche : les propriétés
et les valeurs sortent juste, l'interpolation `{...}` et les mixins propres à Stylus non.

L'ordre des attributs est libre : `<style name="bandeau" lang="scss">` marche aussi. Un `lang` d'une
autre valeur retombe sur le SASS. Attention, `data-lang="css"` n'est pas un `lang=` et ne change rien.

Un `<theme>` ne contient que des déclarations (`--variable: valeur`), jamais de sélecteur : ses blocs
`scss`, `css` et `less` sont donc colorés par un sous-ensemble borné à la ligne, où le point-virgule final
reste facultatif. Un `<style>`, lui, est une feuille de style entière et reçoit la grammaire complète
du langage — avec sa contrepartie, la même que dans un fichier HTML ordinaire : une accolade laissée
ouverte fait déborder la coloration au-delà du `</style>`, jusqu'à ce que la règle soit refermée.

## Le bloc `<routes>`

La table de routes déclarative — `<routes target="…">`, une route par ligne — est colorée comme une
petite grammaire à elle seule :

| ce qui est écrit | scope TextMate | rôle |
| --- | --- | --- |
| `routes`, `target="…"` | `entity.name.tag.routes.html` | la balise, traitée comme `<script>` ou `<theme>` |
| `/agenda`, `/profil/plus` | `string.unquoted.route.segment.modularjs` | segment littéral du chemin |
| `:id`, `:onglet` | `variable.parameter.route.modularjs` | paramètre capturé |
| `(:an)`, `(fr)` | idem + `punctuation.definition.route.optional.*` | segment facultatif, capturant ou littéral |
| `*` | `constant.language.wildcard.route.modularjs` | attrape-tout, dernier segment |
| `foyer-page` | `entity.name.tag.route.modularjs` | le composant visé — la couleur de la balise qu'il produit |
| `#` en tête de ligne | `comment.line.number-sign.routes.modularjs` | commentaire de table |

Le bloc se **replie** comme les autres, et sa balise ouvrante doit commencer sa ligne : c'est la
condition qu'impose déjà le compilateur. Un `<routes>` posé en plein milieu d'une ligne ou enfermé
dans un commentaire HTML reste inerte des deux côtés — le compilateur l'ignore, l'extension ne le
colore pas.

### Ce que la table refuse

Une ligne que le compilateur rejetterait porte `invalid.illegal.…` : chemin sans `/` initial, trois
jetons sur la ligne (le commentaire de fin de ligne n'existe pas dans cette table), nom de composant
hors kebab-case ; et dans le chemin, `:12` ou `:id-bis` (paramètre mal formé), `(:x` non refermé, `*`
ailleurs qu'en dernier segment. Les motifs sont repris de `parseRoutesLines` et `validateRoutePath`
(`src/transpiler/sections.ts`) — même verdict des deux côtés. Une ligne en cours de frappe, le chemin
seul sans son composant, n'est **pas** signalée.

Beaucoup de thèmes — Monokai compris — ne peignent pas `invalid` : la ligne fautive garde alors la
couleur du texte ordinaire. Pour la voir, une règle dans les réglages :

```json
"editor.tokenColorCustomizations": {
  "textMateRules": [
    { "scope": "invalid.illegal", "settings": { "foreground": "#F92672", "fontStyle": "underline" } }
  ]
}
```

## La table calculée `@routes`

Une table qui se construit en boucle (un sommaire de documentation qui fabrique ses routes, par
exemple) ne peut pas s'écrire dans un bloc `<routes>` : elle vit dans le `<script>`, sous la forme
`@routes = {…}`. Elle est colorée avec **le même vocabulaire** que le bloc — chemin lu segment par
segment, nom de composant à la couleur de la balise qu'il produit :

```civet
  @routes =
    'app-view':
      '/':            'home-page'
      '/guide/:id':   'guide-page'
      '/docs/*':      'docs-shell'

  @routes['app-view']['/extra'] = 'extra-page'
```

Trois règles la délimitent, et elles comptent :

- seul un chemin **littéral** est lu comme un chemin. `"/#{page.slug}"` reste une chaîne ordinaire :
  l'extension ne devine pas ce que la boucle va produire ;
- la reconnaissance s'arrête au bloc — l'affectation `@routes =` et tout ce qui est **indenté sous
  elle**. La ligne suivante à la même colonne n'en fait plus partie ;
- **le même verdict qu'au bloc**. Une écriture se peint pareil où
  qu'elle soit posée : `/perdu/*/suite`, `/pas-ferme/(:x` ou `/mauvais/:id-bis` rougissent ici comme
  là-bas. Le compilateur, lui, ne relit toujours pas cette table — `validateRoutePath` n'est appelé
  que par `parseRoutesLines`. Le rouge y dit donc « cette route est fautive », pas « le build va
  échouer » : le routeur, seul juge au montage, y avale le reste après l'étoile, cherche les
  caractères `(:x` dans l'URL, et capture sous un nom qu'aucun `&param` ne sait relire.

  Le NOM DE COMPOSANT, lui, reste sans verdict : `'Mauvais-Composant'` fait échouer le bloc et ne
  déclenche rien ici — la paire ne se reconnaît même pas, faute de composant bien formé.

Le banc `tests/vscode-grammar-routes-parity.test.ts` tient les deux bouts : il tokenise chaque forme
avec le vrai moteur de VS Code, la passe à `parseRoutesLines`, et échoue au moindre écart.

## Les autres blocs — ce qui a été vérifié

Le même examen a été passé à `<theme>`, `<style name="…">` et aux macros `<@…>` : une règle du
compilateur sans reflet dans la grammaire est un piège muet. Trois trous comblés :

| ce qui est écrit | ce que fait le compilateur | ce que fait l'extension |
| --- | --- | --- |
| `$$or: gold` dans un `<theme>` ou un `<style>` | variable de **thème** → `--mjs-or` | `keyword.control.directive.store.modularjs` + `variable.other.readwrite.store.modularjs`, comme dans un `<script>` — avant, la grammaire SASS la peignait comme une variable `$sass` ordinaire, qui n'est pas la même chose |
| `<style name="Compact">`, `<theme name="Gold">` | **échoue** : `THEME_NAME_RE = /^[a-z][a-z0-9-]*$/` | `invalid.illegal.theme-name.modularjs` sur la valeur, la balise et le reste inchangés |
| `<@include "./x.html">` | la cible ne matche pas `INCLUDE_RE` : le tag reste **brut dans le DOM**, sans un mot | `invalid.illegal.include-cible.modularjs` ; une cible bien formée passe en `string.unquoted.include.modularjs` |
| `<style @css="…">`, `<theme @x>` | attribut de bloc | le `@` entre enfin dans le jeton (`punctuation.definition.symbol.modularjs`), comme sur `<@x @click={…}>` |

Deux écarts sont **assumés** et ne seront pas comblés : un doublon de chemin dans une table est un
état d'ensemble qu'une grammaire lisant ligne par ligne ne peut pas voir, et `@viewTransition` guillemeté
sur un `<style name="…">` demande de croiser deux attributs de la même balise — hors de portée d'un
motif TextMate.

## Installation

Sans passer par la place de marché — copiez le dossier dans les extensions de votre éditeur,
puis relancez-le :

```
cp -r editors/vscode ~/.vscode/extensions/modularjs-syntax
```

(Sous VS Codium : `~/.vscode-oss/extensions/`. Sous Windows :
`%USERPROFILE%\.vscode\extensions\`.)

## Le cas de l'extension `.mjs`

`.mjs` est aussi l'extension des modules JavaScript de Node, et VS Code l'associe à
JavaScript par défaut. L'extension revendique `.mjs` de son côté ; dans un projet qui contient
les deux — des composants ModularJS **et** de vrais scripts Node — tranchez par chemin, dans
les réglages du projet (`.vscode/settings.json`) :

```json
{
  "files.associations": {
    "**/app/modularjs/**/*.mjs": "modularjs",
    "**/script/**/*.mjs": "javascript"
  }
}
```

Les motifs de `files.associations` priment toujours sur l'association par extension : ce que
vous écrivez là gagne.

## Ce que l'extension ne fait pas

Elle colore, elle ne comprend pas : ni complétion, ni navigation vers la définition, ni
diagnostics. Les erreurs de compilation restent celles du compilateur — `mjs dev` les affiche
au terminal et dans le journal d'erreurs (`/__mjs/errors`).
