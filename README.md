# ModularJS (MJS)

**Un framework front compile-time : la réactivité est résolue à la compilation, pas au runtime.** Pas de Proxy ni de Virtual DOM — chaque composant est un *Custom Element* avec son *Shadow DOM*, et le compilateur génère des mises à jour DOM chirurgicales.

<!-- Badges (à activer après publication) :
[![npm](https://img.shields.io/npm/v/mjs-framework)](https://www.npmjs.com/package/mjs-framework)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
-->

```html
<script>
  $count = 0
  increment = -> $count += 1
</script>

<button @click={increment}>
  Cliqué {$count} fois
</button>
```

## Pourquoi MJS

- **Rapide.** Performances au niveau de Svelte (parité sur le benchmark officiel), et **meilleures sur la sélection de ligne et le vidage de liste** ; pas de Proxy au runtime → renders à liaisons lourdes ~10× plus légers.
- **Idiomatique.** Une syntaxe `.mjs` concise (Civet par défaut) : `$x` réactif, dérivés automatiques, blocs `{if}` / `{for}` / `{await}` / `{key}`, liaisons `value=!{$x}`, événements `@click`, transitions, stores, contexte, router.
- **Isolé par design.** Chaque composant vit dans son *Shadow DOM* : styles scopés, pas de collision.
- **Thémable.** Des variables de thème (`$$brand`) qui cascadent à travers les composants, même par-delà le Shadow DOM ; le plus proche gagne.
- **Équipé.** Une bibliothèque de modules cœur prêts à l'emploi (`<@select>`, `<@field>`, `<@checkbox>`…), personnalisable sans forker le source.
- **International.** Traduction et pluriel intégrés (`µt`, `@i18n`), dictionnaires chargés à la demande.

## Installation

```bash
npm install mjs-framework
```

### Coloration dans l'éditeur

`.mjs` est aussi l'extension des modules JavaScript de Node : sans rien faire, l'éditeur lit un composant MJS comme du JavaScript et le souligne en erreurs de bout en bout. L'extension VS Code du dépôt règle ça — installation et réglage par chemin dans [`editors/vscode/`](./editors/vscode/).

## Premiers pas

Un composant est un fichier `.mjs` en kebab-case (`mon-compteur.mjs` → balise `<mjs-mon-compteur>`) :

```html
<script>
  $count = 0
</script>

<button @click={$count++}>{$count}</button>

<style>
  button
    font-size: 1.4rem
</style>
```

Compiler un projet, ou lancer le serveur de dev avec rechargement à chaud (HMR) :

```bash
npx mjs build --root /chemin/vers/app      # compile .mjs → .js
npx mjs dev --port 3939                     # dev + HMR
```

```html
<!-- snippet HMR à inclure en mode dev -->
<script src="http://127.0.0.1:3939/__mjs_hmr/client.js"></script>
```

## Documentation

- 📖 **[Référence du langage](./docs/)** — 36 sections : le langage (réactivité, blocs, bindings, événements, transitions, stores, contexte, router, cycle de vie, SSR, temps réel, navigation, i18n, pièges…), une fiche d'aide-mémoire condensée, et l'outillage — ligne de commande et configuration, harnais de test des applications, panneau d'inspection, images, application installable. Chaque page : référence dense + encarts dépliables *Pour débutants*.
- 🎓 **Tuto interactif** — 144 leçons avec éditeur live (le parcours d'apprentissage pas-à-pas).

## Configuration — `mjs.config.json`

À la racine du projet (le bundler le cherche en remontant depuis le dossier courant) :

```json
{
  "sourceDir": "app/assets/modularJS",
  "outputDir": "public/assets/modularJS_compiled",
  "manifestPath": "app/assets/javascripts/bundle_modular.js",
  "lang": "fr",
  "defaultScriptLang": "civet",
  "minify": false
}
```

Les flags CLI (`--output`, `--manifest`) ont la priorité sur le fichier de config.

## Langages source

`<script lang="…">` accepte `civet` (défaut), `coffee`, `ts`, `js` ; `<style>` accepte SASS (indenté) ou SCSS.

```html
<script lang="ts">
  $count: number = 0
</script>

<button @click={$count++}>{$count}</button>
```

## Contribuer

```bash
git clone https://github.com/RaptureStudio42/mjs-framework.git
cd mjs-framework
npm install
npm run build:self   # construit le compilateur (dist/)
npm test             # suite de tests
```

Une faille de sécurité à signaler ? Voir [SECURITY.md](./SECURITY.md).

## Licence

[MIT](./LICENSE) © Matrix
