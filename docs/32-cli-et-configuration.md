# 32 · CLI & configuration (mjs.config.json)

> 📚 Pas de chapitre de tuto interactif dédié (la ligne de commande et son fichier de configuration vivent hors de l'éditeur live) : cette page se suffit à elle-même. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Les chapitres précédents documentent le langage MJS côté client — composant, réactivité, événements… Celui-ci documente l'autre moitié, tout aussi nécessaire dès la première minute passée sur un projet : la commande `mjs` et le fichier `mjs.config.json` qui la configure.

## 1. Les commandes

| Commande | Ce qu'elle fait |
|---|---|
| `mjs init` | scaffolde `mjs.config.json` et la structure de départ du projet |
| `mjs build` | compile une fois et sort |
| `mjs dev` | watch + rechargement à chaud (serveur HTTP+WS sur `--port`, défaut 3939) |
| `mjs check` | vérifie la config et liste les composants détectés (compile réellement, comme `build`) |
| `mjs serve` | sert le rendu SSR/prérendu par requête (`render.routes`) — bloc `render` requis dans `mjs.config.json` (port 3000 par défaut) |
| `mjs ws` | lance le serveur temps réel (MJS-WS) — fichier d'entry `ws.server.mjs`/`ws.js`/`server/ws.js`… |
| `mjs serveur` | lance le serveur de jeu (MJS-Server, `mjsServer` + `app.game`) — fichier d'entry `serveur.server.mjs`/`serveur.js`/`server/serveur.js`… |

### `mjs init`

Scaffolde un projet MJS **autonome** — aucune dépendance à Rails/Sprockets ni à un autre framework, le dossier de sortie est servi tel quel par n'importe quel serveur statique. Elle crée, à la racine du projet, huit éléments :

- les dossiers `app/modularjs/`, `app/modularjs/styles/`, `app/modularjs/examples/` et `public/modularjs/` ;
- le fichier `mjs.config.json` de départ ;
- le composant d'exemple `app/modularjs/hello.mjs` (un compteur, `<script>` en Civet + `<style lang="scss">`) ;
- dans `app/modularjs/examples/` : `hello-world.mjs` (un composant de référence qui montre les cinq blocs d'un fichier `.mjs` dans l'ordre canonique, et affiche cette liste lui-même) et `README.md` (la convention énoncée en clair).

Le `mjs.config.json` écrit est celui-ci, mot pour mot :

```json
{
  "sourceDir": "app/modularjs",
  "outputDir": "public/modularjs",
  "manifestPath": "public/modularjs/bundle.js",
  "stylesheetsDir": "app/modularjs/styles",
  "lang": "fr",
  "defaultScriptLang": "civet"
}
```

> **Développement ou production ?** C'est la **commande** qui tranche, pas le fichier : `mjs build` construit en développement, `mjs build --prod` en production. `minify` ne fait que minifier : un projet peut vouloir un bundle compact **en développement** sans perdre pour autant le panneau d'inspection ni les cartes de source.

`mjs init` n'écrase **jamais** un fichier ou un dossier déjà présent : elle le saute et l'annonce (« ↪️ … (existe déjà) ») plutôt que d'écrire par-dessus. En fin de commande, elle affiche les prochaines étapes telles quelles :

```
Pour démarrer :
  npx mjs dev
  → http://127.0.0.1:3939

Inclure le HMR client dans votre HTML :
  <script src="http://127.0.0.1:3939/__mjs_hmr/client.js"></script>
  <script type="module" src="/modularjs/bundle.js"></script>
  <mjs-hello></mjs-hello>
```

### `mjs check`

Imprime d'abord les chemins résolus :

```
Source dir   : …
Output dir   : …
Manifest     : …
Stylesheets  : …
Default lang : …
```

puis compile **pour de vrai** — ce n'est **pas** une compilation à blanc : les fichiers sont écrits dans le dossier de sortie, exactement comme `mjs build`, et la commande le rappelle elle-même avant de lancer la compilation (« 'mjs check' compile réellement (comme 'build') — les fichiers … seront écrits/écrasés »). Elle liste ensuite les composants détectés (les 20 premiers, puis un compte des suivants), et sort avec le code **1** à la moindre erreur de compilation, **0** sinon.

C'est la porte d'entrée naturelle d'un pipeline d'intégration continue : un `mjs check` qui sort en 1 casse le pipeline sans qu'il soit besoin de lancer le moindre serveur.

### `mjs build`, `mjs dev`, `mjs serve`

- **`mjs build`** — compile une fois, écrit les fichiers, sort.
- **`mjs dev`** — watch + rechargement à chaud, serveur HTTP+WS sur le port `--port` (défaut **3939**).
- **`mjs serve`** — sert le rendu SSR/prérendu par requête (`render.routes`), bloc `render` requis dans `mjs.config.json`, port `--port` (défaut **3000**).

> 🛑 **`mjs build` refuse de construire le vide.** Si la racine visée n'a ni `mjs.config.json` ni dossier source — ou si le dossier source existe mais ne contient pas un seul `.mjs` — la commande **sort en erreur (code 1) sans rien écrire**, en nommant le dossier qu'elle a cherché. C'est la protection du **manifeste** : un build sans source écrivait un `µ.paths = {}` par-dessus celui d'un site en place — plus un composant connu, page blanche — en annonçant « ✅ 2 fichiers écrits », code 0. Le cas se produit dès qu'on lance la commande depuis le mauvais dossier, ou qu'on oublie `--root`.

> 🛑 **Un composant qui ne compile pas fait échouer le build.** `mjs build` sort en **code 1**, et le composant fautif ne garde **aucune** entrée au manifeste : rien de périmé n'est servi à sa place. C'est la contrepartie d'un piège réel — la sortie précédente survit sur le disque, mais elle importe le runtime de son propre build, `mjs_core-<empreinte>.js`, qui n'existe plus après une recompilation du framework : la page meurt au navigateur pendant que le build s'achève. `mjs dev`, lui, continue de servir la dernière version valide du composant, avec un avertissement (overlay HMR) : le temps de corriger une faute de frappe, le reste du site reste utilisable. `mjs serve` n'a pas ce filet : la compilation tourne AVANT l'ouverture du port, et la moindre erreur sort en code 1 sans jamais écouter — rien n'est servi tant que l'erreur n'est pas corrigée.

**`mjs dev` sert aussi la page du projet.** Sans bloc `render`, tout chemin qui n'est pas un fichier compilé (`urlPrefix`) est cherché dans la racine du projet (le dossier de `mjs.config.json`, ou `--root`) : `/` et tout chemin finissant par `/` servent l'`index.html` de ce dossier, sinon le fichier demandé, avec son type MIME. Un fichier ou un dossier caché (`.git`, `.env`…) et `node_modules/` ne sont jamais servis ; un lien symbolique qui sortirait de la racine répond 404. Une page HTML servie ainsi reçoit le client de rechargement quand il est actif. Avec un bloc `render`, `render.routes` garde la main.


Le rendu piloté par la config (`render`, SSR, prérendu) est détaillé au chapitre [19 · SSR](19-ssr.md) — pas repris ici.

### `mjs ws` et `mjs serveur`

- **`mjs ws`** — lance le serveur temps réel (MJS-WS). Détail complet : [23 · MJS-WS](23-mjs-ws.md).
- **`mjs serveur`** — lance le serveur de jeu (MJS-Server, composé par-dessus MJS-WS). Détail complet : [24 · MJS-Server](24-mjs-server.md).

`mjs ws` et `mjs serveur` acceptent en plus `--host <adresse>` (ou `ws.host`/`serveur.host` dans `mjs.config.json` selon la commande, `--host` prioritaire) — sans l'un ni l'autre, le transport écoute en local (`127.0.0.1`, MÊME défaut que le pont). Qui veut exposer le serveur le dit explicitement avec `--host ::`. `--port` (comme `ws.port`/`serveur.port`) est validé **entier 1-65535** : hors bornes, la commande sort en erreur avant même de tenter d'ouvrir le port.

### Drapeaux communs

| Drapeau | Rôle |
|---|---|
| `--root <dossier>` | racine du projet (défaut : répertoire courant) |
| `--manifest <chemin>` | chemin du bundle (point d'entrée), remplace `manifestPath` |
| `--output <chemin>` | répertoire de sortie des fichiers compilés, remplace `outputDir` |
| `--entry <chemin>` | fichier d'entry du serveur ws/serveur (`mjs ws`/`mjs serveur`), défauts propres à chaque commande |
| `--host <adresse>` | hôte d'écoute — `mjs ws`/`mjs serveur` (défaut `127.0.0.1`, `--host ::` pour toutes les interfaces) |
| `--port <n>` | port du serveur — `mjs dev` (3939), `mjs serve` (3000), `mjs ws` (4000), `mjs serveur` (4001) |
| `--once` | force la commande sur `build` (compile et sort) |
| `--dev` | build de **développement** — panneau d'inspection embarqué, pas de minification, cartes de source (c'est le défaut) |
| `--prod` | build de **production** — minifié, fragments i18n hachés, aucun outil de développement |
| `-h`, `--help` | affiche l'aide et sort |

`mjs build`, `mjs check`, `mjs dev` et `mjs serve` annoncent en clair le mode retenu et d'où il vient — c'est cette ligne qu'on relit dans un journal de déploiement pour vérifier qu'on a bien construit ce qu'on croit.

### Sur ma machine, en développement ; sur le serveur, en production

**Un build est en développement, sauf si on demande le contraire.** Non minifié, panneau d'inspection embarqué, cartes de source, fragments i18n aux noms lisibles : c'est ce qu'on veut sur son poste, et c'est ce qu'on obtient sans rien configurer.

Le **serveur**, lui, ne se devine pas. Le framework ne regarde ni le nom d'hôte, ni le port, ni l'adresse, ni aucune variable d'environnement : `mjs build` lancé par un script de déploiement sur un shell non interactif produit exactement ce qu'il produit sur un portable. **C'est au script de déploiement de le dire**, et il n'y a qu'une façon :

```bash
mjs build --prod
```

Une seule ligne, dans un seul fichier — celui qui déploie. Rien de versionné ne peut se tromper de machine, et aucune variable héritée d'un shell ne peut basculer un build sans qu'on l'ait demandé.

> ⚠️ Sans `--prod`, le déploiement pousse un build de développement en ligne : bundle non minifié, `window.µ` exposé, panneau d'inspection livré aux visiteurs, et **fragments i18n non hachés** — donc servis depuis le cache des navigateurs après une correction de traduction. Le bandeau imprimé par `mjs build` (« 🛠️ Build de DÉVELOPPEMENT… ») l'écrit noir sur blanc dans le journal de déploiement : c'est la ligne à relire en cas de doute.

Cette indifférence à l'environnement ne vaut que pour le CHOIX DU BUILD (minification, panneau d'inspection embarqué) — la garde des routes de développement, décrite juste en dessous, accepte elle aussi `NODE_ENV=production` comme signal, en plus de `--prod`.

Les routes de développement que `mjs dev`/`mjs serve` exposent — l'atelier de variables de thème (`GET /__mjs/theme`, [34 · Déboguer](34-deboguer.md) §3) et le journal d'erreurs (`GET /__mjs/errors`, [19 · SSR](19-ssr.md) § *Journal d'erreurs*) — suivent une garde complémentaire : ces routes sont fermées dès que la commande tourne avec `--prod`, et aussi quand `NODE_ENV=production` est posé, même sans `--prod`.

## 2. Le fichier `mjs.config.json`

Toutes les clés sont optionnelles ; les chemins qu'elles contiennent sont résolus relativement au dossier qui contient `mjs.config.json`. Trente-deux clés racine sont reconnues :

| Clé | Type | Défaut | Rôle |
|---|---|---|---|
| `sourceDir` | chaîne | `app/modularjs` | dossier des sources `.mjs` |
| `outputDir` | chaîne | `public/modularjs` | dossier de sortie des fichiers compilés |
| `manifestPath` | chaîne | `public/modularjs/bundle.js` | chemin du point d'entrée du bundle (le fichier chargé par la page) |
| `manifestExternal` | chaîne | `app/modularjs/manifest.civet` s'il existe, sinon `app/modularjs/manifest.coffee` | manifeste externe façon Sprockets (`#= require`, `require_dir`, `require_tree`) pour bundler du JS/Coffee/Civet hors composants |
| `urlPrefix` | chaîne | dérivé de `outputDir` — détail plus bas | préfixe URL public des fichiers émis |
| `defaultScriptLang` | `'civet'` \| `'coffee'` \| `'ts'` \| `'js'` | `civet` | langage par défaut des `<script>` sans `lang=` |
| `languages` | objet `{ script?, template? }` | aucun propre — `script` retombe sur `defaultScriptLang`, `template` sur `civet` | forme à deux axes qui remplace progressivement `defaultScriptLang` — [2 · Anatomie d'un composant](02-composant.md) |
| `minify` | booléen \| `'auto'` | `auto` | minification **seule** : `auto` suit le mode du build, `true` minifie même en développement, `false` ne minifie jamais — même en production. Ne décide pas de l'environnement : ça, c'est `--prod` |
| `dev` | objet `{ port?, host? }` | aucun propre — `port` : 3939 en `mjs dev`, 3000 en `mjs serve` ; `host` : `127.0.0.1` | port/hôte du serveur de développement |
| `stylesheetsDir` | chaîne | `app/modularjs/styles` | dossier des feuilles de style partagées — détail plus bas |
| `runtimeDir` | chaîne | aucun (auto-détecté) | dossier du runtime du framework — détail plus bas |
| `sigil` | `'µ'` \| `'mjs'` | `µ` | symbole d'API tapé dans la source — [2 · Anatomie d'un composant](02-composant.md) |
| `contextAlias` | booléen | `false` | alias ASCII `__context`/`__shared` pour `§`/`§§` — [13 · Contexte](13-contexte.md) |
| `render` | objet | aucun (bloc absent = pas de rendu piloté par la config) | rendu par URL — [19 · SSR](19-ssr.md) |
| `render.startup` | `'preload'` \| `'bundle'` \| `'none'` | `'preload'` | ce qu'une page prérendue charge au démarrage — cf. [`render.startup`](#renderstartup) |
| `preload` | chaîne \| objet `{ view?, page? }` | `view: 'hover'`, `page: 'off'` | préchargement des liens — [17 · Router](17-router.md) |
| `viewTransition` | chaîne | `none` (désactivé) | transition de page par défaut — [17 · Router](17-router.md) |
| `lint` | objet `{ maxStateVars?, a11y?, ujsForm? }` | aucun propre — cf. `lint.maxStateVars`, `lint.a11y` et `lint.ujsForm` plus bas | avertissements de compilation : seuil d'état, contrôles d'accessibilité, formulaire sans action/méthode |
| `runtime` | `'all'` \| `'core'` \| tableau de chaînes | `all` | sélection des modules runtime embarqués au bundle — [22 · Aide-mémoire](22-aide-memoire.md) |
| `css` | `'bundle'` \| `'split'` \| `'lazy'` | `bundle` | comment les feuilles partagées (`stylesheetsDir`) voyagent : `bundle` = un seul fichier pour toutes, chargé avec le manifeste ; `split` = un fichier par feuille, importé par le JavaScript des modules qui la déclarent (`@css`) ; `lazy` = un vrai `.css` par feuille, demandé au montage du premier composant qui la déclare et mis en cache par URL. Détail et critères de choix : [2 · Composant](02-composant.md) |
| `js` | `'split'` \| `'bundle'` | `split` | comment le cœur, les composants et les modules voyagent : `split` = un fichier haché par unité (comportement historique) ; `bundle` = TOUT (cœur, styles, animations, manifeste externe, modules, composants) fusionné dans le seul fichier `manifestPath` — une requête JS au lieu d'une cascade. Exige `css: 'bundle'` — cf. `js` plus bas |
| `image` | objet `{ widths?, formats?, quality? }` | aucun propre — cf. `image` plus bas | politique des variantes produites par `µimage` — [35 · Images](35-images.md) |
| `ws` | objet | aucun | démarrage de `mjs ws` — [23 · MJS-WS](23-mjs-ws.md) |
| `serveur` | objet | aucun | démarrage de `mjs serveur` — [24 · MJS-Server](24-mjs-server.md) |
| `i18n` | objet | aucun (dossier `i18n/` absent ⇒ désactivé) | traduction — [29 · i18n](29-i18n.md) ; `i18n.source` (chaîne, facultative) active le contrôle d'empreinte des traductions — [29 · i18n](29-i18n.md#empreinte) |
| `lang` | chaîne | `fr` | langue des messages CLI/compilateur (`fr`, `en` ; toute autre valeur retombe sur `fr`) |
| `journal` | objet | aucun bloc — défauts internes `server: true`, `client: false`, `viewer: true` | journal d'erreurs à 3 étages — [19 · SSR](19-ssr.md) § *Journal d'erreurs* |
| `varPrefix` | chaîne | `mjs` | préfixe des variables de thème — [31 · Thèmes](31-themes.md) |
| `defaultTheme` | chaîne | `light` | thème qui vaut sans attribut — [31 · Thèmes](31-themes.md) |
| `csp` | booléen | `false` | compatibilité avec une politique de sécurité de contenu stricte : plus aucun `<style>` ni `<script>` en ligne dans ce que MJS écrit — cf. `csp` plus bas |
| `sourceMap` | `'never'` \| `'dev'` \| `'prod'` \| `'always'` | `dev` | quand émettre les cartes de source, qui font retomber un point d'arrêt sur la ligne du `.mjs` — cf. `sourceMap` plus bas |
| `prune` | booléen | `true` | après un `mjs build` sans erreur, retire d'`outputDir` les fichiers hachés qu'aucun build ne produit plus (composant renommé ou supprimé) — cf. `prune` plus bas |
| `logLevel` | chaîne \| objet `{ dev?, prod? }` | dev `log`, prod `warn` | niveau de la console — navigateur ET sortie du build, réglés ensemble — cf. `logLevel` plus bas |

Quelques clés méritent un mot de plus.

### `urlPrefix`

Préfixe URL public sous lequel les fichiers compilés sont servis (`<script src="{urlPrefix}/bundle.js">`). Absent, il est **dérivé** de `outputDir` (`deriveUrlPrefix`, `src/bundler/index.ts`) selon la convention « la plupart des hébergements servent leur racine documentaire depuis un dossier `public/` » :

| `outputDir` | `urlPrefix` dérivé |
|---|---|
| `public/modularjs` | `/modularjs` |
| `public/assets/X` | `/assets/X` |
| `dist` | `/dist` (convention non respectée, mais accepté quand même) |

Un `outputDir` **absolu** suit la même logique en cherchant `/public/` dans le chemin (ex. `/var/www/monapp/public/modularjs` → `/modularjs`) ; un chemin absolu qui ne contient `public/` nulle part retombe sur son seul nom de dossier final.

### `stylesheetsDir`

Dossier des feuilles de style **partagées** — celles que l'attribut `@css="nom"` du `<style>` de base va chercher depuis un composant, par opposition au `<style>` scopé d'un `.mjs`, propre à ce seul composant. Défaut `app/modularjs/styles`.

### `runtimeDir`

Dossier où trouver le runtime du framework (les fichiers `mjs_*` du cœur), si différent de l'emplacement auto-détecté (`Bundler.locateRuntimeDir`). Un projet qui consomme le paquet npm n'a normalement jamais besoin de le poser : le défaut suit l'installation.

### `lint.maxStateVars`

Plafond d'alerte sur le nombre de variables d'état (`$x`) distinctes déclarées dans **un seul** composant. Défaut réel **40** (`src/transpiler/index.ts`, étalonnage constaté : modules sains 5-20 variables, monolithe pathologique observé à 182). `0` désactive le lint. Au-delà du seuil : un **avertissement** au build, jamais une erreur — un signal d'architecture, rien d'incorrect à l'exécution.

### `lint.a11y`

Contrôles d'accessibilité sur le HTML, **activés par défaut** (`true`). Comme le lint précédent : de simples **avertissements** au build, jamais une erreur. Sept contrôles, choisis pour ne parler que quand c'est vraiment un problème :

| ce qui est signalé | pourquoi |
| --- | --- |
| `<img>` sans `alt` sous aucune forme | une image sans alternative est muette pour un lecteur d'écran — `alt=""` est valide et ne dit rien (image décorative) |
| `<iframe>` sans `title` | rien n'annonce ce que contient le cadre |
| `tabindex` positif (`1` et plus) | casse l'ordre de tabulation de la page ; `0` et `-1` sont légitimes |
| `@click` sur `div`, `span`, `li`, `p`, `section`… sans `role` ni `tabindex` | ce qui se clique à la souris ne s'atteint ni au clavier ni au lecteur d'écran |
| `<button>` sans nom accessible | le bouton-icône : rien que du graphique dedans, ni `aria-label`, ni `aria-labelledby`, ni `title` |
| `<a>` sans nom accessible | même cas |
| champ de saisie sans étiquette | `<input>`, `<select>`, `<textarea>` sans `aria-label`/`aria-labelledby`/`title`, et sans `<label>` qui les désigne |

Deux garde-fous volontaires, pour que le contrôle reste crédible :

- Les blocs `<pre>` sont ignorés entièrement, et les `<code>` ne sont pas inspectés comme du markup — une page qui **montre** du HTML dans ses exemples n'est pas punie pour ça. Le texte d'un `<code>` compte en revanche comme texte visible : `<a href="…"><code>&lt;@view&gt;</code></a>` est un lien correctement nommé.
- Sur les champs sans `id`, l'alerte ne tombe que si le HTML ne contient aucun `<label>` — un champ enveloppé dans son étiquette ne déclenche rien.

Pour couper : `"lint": { "a11y": false }`.

### `lint.ujsForm`

Avertissement sur un `<form>` qui n'a **ni** `action`, **ni** `@method`/`mjs-method`, **ni** `@noUJS` : le pont UJS l'intercepte quand même — le contrat reste « tout `<form>` est intercepté » — et sans destination déclarée, la soumission repart en navigation vers l'URL courante. `action=""` compte comme absente (même piège que l'absence pure et simple). Un `@submit.prevent` sur le formulaire ne change rien : le pont shadow attache son écouteur en phase capture, avant le `_mjs_bindEvents` du composant. **Activé par défaut** (`true`), simple **avertissement**, jamais une erreur. Même garde-fou que `lint.a11y` : les `<pre>`/`<code>` d'exemple sont ignorés.

Pour couper : `"lint": { "ujsForm": false }`.

### `image`

Politique des variantes produites par `µimage` (cf. [35 · Images](35-images.md)) : `widths` (largeurs à produire, défaut `[480, 960, 1920]`, jamais au-delà de la largeur native), `formats` (parmi `avif`/`webp`/`jpeg`/`png`, défaut `['webp']`), `quality` (1-100, défaut `78`). Ces variantes exigent `sharp`, dépendance **optionnelle** (`npm i -D sharp`) — absente, l'image d'origine passe telle quelle et un avertissement unique le dit ; les **dimensions natives**, elles, sont toujours lues (en-tête du fichier, aucune dépendance) et ne dépendent pas de ce bloc.

```json
{
  "image": { "widths": [320, 640, 1280], "formats": ["avif", "webp"], "quality": 80 }
}
```

### Ce que porte le manifeste

Le fichier `manifestPath` est servi sur **chaque** page : tout ce qu'il embarque est payé à chaque
visite. Il porte donc la table des composants et les réglages, jamais la prose du site.

- **Table des chemins** — `µ.paths`, un nom logique par composant/module. Les valeurs partagent
  toutes le même début d'URL (`urlPrefix`) : ce préfixe est publié **une seule fois**
  (`µ.pathsPrefix`) et chaque valeur ne garde que son suffixe (`about-<empreinte>.js`) ; qui lit un
  chemin recolle les deux. Sur un site à ~1 400 composants, c'est 37 Ko de préfixe recopié en moins
  sur chaque page. En `js: 'bundle'`, la forme ne change pas (chaque nom pointe le fichier unique).
- **Réglages** — préchargement (`preload`), niveau de journal, libellés du framework, thèmes.
- **i18n** — les **réglages** seulement (langue par défaut, mode placeholder, détection…), plus la
  liste des langues et l'URL du **fichier de chaque langue** ; dictionnaires et table des sections
  vivent dans ces fichiers, chargés pour la seule langue affichée — cf.
  [29 · i18n](29-i18n.md) §2.

Conséquence pratique : le manifeste ne **porte** plus la prose du site (site de référence : 142 Ko
bruts, 33 Ko gzip de moins par page servie), et un visiteur ne télécharge que la langue affichée —
plus la langue par défaut si elle diffère, qui porte les replis. Ce fichier se paie **une** fois :
sur la première page le solde est de −16,6 Ko gzip en français et à peu près nul en anglais (deux
fichiers) ; dès la deuxième page il vient du cache et le gain est plein. Changer une **traduction**
change le fichier de sa langue **et** l'empreinte que le manifeste en garde : le manifeste change
donc encore, comme à chaque construction ; les fichiers des autres langues et le JavaScript des
composants, eux, ne bougent pas.

### `js`

Par défaut (`"js": "split"`, ou la clé absente), chaque composant, chaque module `.civet`/`.coffee` et le cœur du runtime deviennent leur propre fichier haché (`mjs_core-<empreinte>.js`, `mon-composant-<empreinte>.js`…) dans `outputDir`, et le manifeste (`manifestPath`) se contente de les orchestrer — un `import()` dynamique par unité, chargée quand sa balise apparaît dans la page (`µ.Autoloader`). Sur un site à nombreux composants répartis sur plusieurs pages, c'est ce qui permet à une page de ne charger QUE ce qu'elle affiche.

`"js": "bundle"` change cette stratégie du tout au tout : le cœur, les feuilles partagées, les animations utilisées, le manifeste externe, les modules et TOUS les composants du projet sont assemblés dans le seul fichier `manifestPath` — plus aucun autre `.js` dans `outputDir` (les satellites CSS de variants et les images restent des fichiers, inchangés). Une page ne fait plus qu'une seule requête JavaScript, tout est chargé et défini d'un coup, `µ.Autoloader` n'a plus rien à découvrir puisque rien n'arrive plus tard. C'est le choix pertinent pour une petite application ou une page unique où « tout charger tout de suite » coûte moins qu'une cascade de petites requêtes — pas pour un site qui étale ses composants sur de nombreuses pages, où ce serait l'inverse (chaque page paierait le poids de composants qu'elle n'affiche jamais).

Trois choses à savoir :

- **Le mode exige `css: 'bundle'`** (le défaut). C'est mécanique, à l'envers du raisonnement de `csp` ci-dessous : fusionner en un seul fichier un CSS déjà DÉCOUPÉ en fichiers séparés (`"css": "split"` ou `"css": "lazy"`) contredirait « un seul fichier JS ». Avec l'un de ces deux réglages, le build refuse de partir et le message nomme le correctif.
- **Incompatible avec `csp: true`** : le mode strict exige justement un CSS découpé (cf. `csp` plus bas), l'inverse de ce que `js: 'bundle'` impose — aucune valeur de `css` ne peut jamais satisfaire les deux à la fois, un message dédié le dit avant même de parler de `css`.
- **L'Autoloader n'est pas embarqué** : tout composant est défini dès le chargement du fichier unique, il n'a plus rien à découvrir. Un contrôle unique, après la définition de tous les composants, signale en console toute balise `mjs-…` présente dans la page et inconnue du projet (une faute de frappe, ou un web component tiers voulu). `"runtime": ["autoloader"]` le remet si un projet en a besoin.
- **Le rendu serveur et le rendu navigateur restent TOUJOURS en `'split'`**, quel que soit ce réglage : ils rechargent le cœur et chaque composant fichier par fichier pour leurs propres besoins internes (prérendu, tests Chromium). Sous `js: 'bundle'`, cette recompilation de service écrit dans un **dossier temporaire à elle**, retiré aussitôt : `outputDir` et son fichier unique sortent du prérendu intacts, à l'octet près. Les URLs d'assets du HTML rendu (images `µasset`, feuilles, liens) restent celles du vrai build — ce détail d'implémentation ne change jamais ce qu'un visiteur reçoit.

```json
{
  "js": "bundle"
}
```

> **Changer de mode purge peu.** Passer de `'split'` à `'bundle'` (ou l'inverse) sur un `outputDir` déjà construit laisse les anciennes sorties de l'AUTRE mode sur place (les `mjs_core-*.js`/`<composant>-*.js` d'un ancien `'split'` ne sont jamais reconnus comme orphelins par un build en `'bundle'`, qui n'écrit plus rien de tel) : `prune` ne les retire pas. Videz `outputDir` à la main après un changement de mode.

### `csp`

Certains hébergements — banque, santé, secteur public, ou simple politique interne — imposent une **politique de sécurité de contenu** stricte : l'en-tête `Content-Security-Policy` y interdit tout style et tout script écrits *en ligne* dans la page, du genre `script-src 'self'; style-src 'self'` sans la moindre échappatoire `'unsafe-inline'`. Le navigateur refuse alors purement et simplement d'exécuter un `<script>` sans `src`, et d'appliquer un `<style>` posé dans le HTML.

`"csp": true` met MJS en conformité avec une telle politique : à partir de là, **rien de ce que MJS écrit ne serait refusé**. Le CSS du thème part en fichier avec empreinte et arrive par un `<link>` ; les feuilles de composant rendues au serveur passent elles aussi par un `<link>`, à l'intérieur du shadow root — pour **chaque** composant du HTML rendu, racine comme sous-composant, à ombre comme léger ; le drapeau d'hydratation devient un attribut au lieu d'un script ; et les quelques endroits où le runtime fabriquait une balise `<style>` à la volée adoptent une feuille de style construite en mémoire, que la politique ne regarde pas.

Trois choses à savoir :

- **MJS n'impose aucune politique.** Il n'émet jamais d'en-tête `Content-Security-Policy` lui-même : écrire cet en-tête reste l'affaire de l'application ou du serveur de façade. La clé rend MJS *compatible*, elle ne décide rien à votre place.
- **Le mode exige un CSS découpé** (`"css": "split"` ou `"css": "lazy"`). C'est mécanique : remplacer un `<style>` en ligne par un `<link>` suppose qu'un fichier existe à pointer. Avec `"css": "bundle"`, le build refuse de partir et le message nomme le correctif — et donc, transitivement, `"csp": true` est aussi incompatible avec `"js": "bundle"` (cf. `js` plus haut), qui exige justement `css: 'bundle'`.
- **`mjs serve` et `mjs dev` les servent au préfixe DÉRIVÉ.** Ces feuilles sont référencées par leur URL publique, celle que le projet déclare dans `urlPrefix` ou, à défaut, celle que MJS dérive du dossier de sortie (`public/modularjs` → `/modularjs`, cf. [`urlPrefix`](#urlprefix)) — même règle côté écriture et côté service, donc rien à accorder à la main. Ne déclare `urlPrefix` que si ton back monte le dossier ailleurs que ne le dit cette convention.
- **Les feuilles écrites par le rendu ne sont jamais purgées.** Celles-là (`mjs_ssr_style…`, `mjs_ssr_head…`) naissent au prérendu, pas à la compilation : `prune` les épargne par leur nom, sans quoi le build les retirerait aussitôt écrites et les `<link>` des fragments pointeraient dans le vide. En contrepartie, la feuille d'un composant **supprimé du projet** reste sur disque, orpheline — elle n'est plus référencée par aucun fragment, son nom porte l'empreinte de son contenu, elle ne peut donc rien écraser ni rien servir de faux. Vide `outputDir` à la main quand ce résidu te gêne.
- **Le défaut reste `false`**, et le chemin par défaut ne change pas d'un octet. Ce n'est pas de la prudence de façade : une feuille adoptée en mémoire passe *après* les `<style>` et les `<link>` du document dans l'ordre de cascade. Basculer tout le monde changerait donc qui gagne un conflit de règles, et pourrait casser une surcharge d'application qui marche très bien aujourd'hui.

```json
{
  "csp": true,
  "css": "split"
}
```

### `sourceMap`

Une **carte de source** est le petit fichier `.map` qui relie le JavaScript livré au navigateur au fichier que vous avez écrit. Sans elle, un point d'arrêt tombe au milieu du code compilé ; avec elle, il tombe sur *votre* ligne, dans *votre* `.mjs`.

| Valeur | Émission |
|---|---|
| `'dev'` | en développement seulement — le défaut |
| `'prod'` | en build de production seulement |
| `'always'` | dans les deux |
| `'never'` | jamais |

Le défaut `'dev'` découle directement de là : la carte est émise là où elle sert — pendant que vous développez — et absente de la production, où elle publierait la forme lisible de votre code à qui ouvre les outils du navigateur. `'prod'` rétablit le comportement des versions précédentes.

> **Ce que la carte couvre.** Le `<script>` de votre composant, ligne par ligne : le navigateur vous affiche votre `.mjs` d'origine — Civet, Coffee ou TypeScript — et non le JavaScript assemblé, y compris sur un fichier minifié. Le source du `.mjs` est embarqué dans la carte, il n'a donc pas besoin d'être servi. Restent en dehors : le bloc `<script module>` (code de module, hors de la classe du composant) et les gestionnaires écrits directement dans le HTML (`@click={…}`), assemblés à part.

### `prune`

Le build remplace déjà l'empreinte d'un fichier qui **change** — `cleanupOldHashes` retire l'ancienne version dès que la nouvelle est écrite. Un nom qui **disparaît** (composant renommé ou supprimé) est un cas différent : personne ne le retire, son fichier reste dans `outputDir` indéfiniment.

Rien ne le sert — le manifeste ne le référence plus — mais sa seule présence fait mentir le dossier sur ce que le site contient réellement : c'est ce qu'on relit six mois plus tard en se demandant pourquoi `outputDir` pèse dix fois ce que le dernier build a écrit.

Après un build **sans erreur** (jamais après un build partiel — cf. § *Validation stricte* ci-dessous), avant le prérendu, `mjs build` retire donc d'`outputDir` tout fichier nommé comme une de ses propres sorties (`nom-<empreinte>.ext`, son `.map`, une variante d'image) qu'il n'a pas produit ce tour-ci.

Chaque retrait est annoncé, jamais silencieux : `🧹 8 fichiers orphelins retirés de public/modularjs`, suivi du nom de chacun (vingt au plus, puis `+ N autres`).

Jamais touchés : les sous-dossiers (`i18n/`, les pages de `render.outDir`), le manifeste, les feuilles `.css` de layout, les fichiers de travail du bundler (`.mangle-cache.json`…), et toute extension absente du registre `.mjs-outputs.json` (un `.pdf`/`.zip` posé à la main, par exemple) — un fichier étranger qui reprend une extension déjà connue de ce registre (un `.js` ou un `.png` déjà émis un jour) et la forme `nom-<empreinte>.ext` n'est PAS protégé : non référencé par le build courant, il est purgé comme une vraie sortie orpheline.

`"prune": false` désactive la purge — le dossier accumule alors comme avant. `mjs dev` et `mjs serve` ne la déclenchent jamais : seul `mjs build` le fait.

À savoir : un onglet resté ouvert sur un build précédent peut perdre ses imports différés au rechargement, les empreintes changeant à chaque déploiement. Garder les anciens fichiers à disposition le temps qu'un onglet oublié se recharge, c'est `"prune": false`.

Le nom seul ne suffit pas à reconnaître une sortie du bundler : un fichier étranger déposé à la main peut, par pure coïncidence, prendre la forme `nom-<empreinte>.ext` (ex. `rapport-1a2b3c4d.pdf`) sans jamais avoir été écrit par un build. Un second filtre porte donc sur l'**extension** : à côté du manifeste, un registre `.mjs-outputs.json` liste les extensions que ce bundler a produites (`.js`/`.css`/`.map` toujours, les formats d'image configurés, plus toute extension effectivement rencontrée) — seul un fichier dont l'extension y figure est candidat à la purge. Registre absent : base minimale `.js`/`.css`/`.map` + formats d'image configurés. Registre présent mais illisible (JSON corrompu ou de forme inattendue) : la purge entière est sautée, aucun fichier retiré — mieux vaut ne rien purger que deviner sur un registre douteux.

### `render.renderQueue`

Plafond de **concurrence** sur le rendu SSR par requête (`mjs dev`/`mjs serve`, bloc `render` — cf. [19 · SSR](19-ssr.md) pour `render.engine`/`render.browserPool`, les autres réglages du moteur de rendu) : `concurrency` (entier ≥ 1, défaut **4**) borne le nombre de rendus EN MÊME TEMPS, `maxQueue` (entier ≥ 0, défaut **32**) le nombre de requêtes qui patientent derrière avant refus. Sans ce plafond, une route paramétrée (`/produit/:id`) ouvre un espace d'URLs quasi infini, chacune un rendu complet lancé sans limite.

```json
{
  "render": { "renderQueue": { "concurrency": 8, "maxQueue": 64 } }
}
```

Au-delà de `concurrency` + `maxQueue` requêtes simultanées, le serveur répond `503 Service Unavailable` plutôt que de laisser la file grossir sans borne ou de saturer le process — `mjs dev` et `mjs serve` posent tous deux l'en-tête `Retry-After` (secondes avant nouvel essai) sur ce `503`.

### `render.startup`

Ce que le HTML figé d'une page prérendue dit au navigateur de charger, **avant** que le manifeste (`bundle_modular.js`) n'ait été téléchargé puis exécuté. Le manifeste est le seul à savoir quels composants une page affiche : sans cette clé, ils ne partent qu'après lui, en seconde vague. La page prérendue, elle, le sait dès sa construction — c'est ce que cette clé exploite. Surchargeable par route (`render.routes["/"].startup`) ; ne concerne que les routes `prerender`.

| Valeur | Ce que le navigateur charge |
|---|---|
| `preload` (défaut) | le fragment porte un `<link rel="modulepreload">` par unité de son **ensemble de démarrage** — composants ET modules — en tête du fichier. Un fichier par composant, `µ.paths` intact : seule la date de départ change (première vague au lieu de la seconde) |
| `bundle` | en **plus**, un `mjs_page-<page>-<empreinte>.js` par page assemble ses composants : le fragment porte un lien vers ce fichier, un lien par module, et une fiche JSON que le manifeste relit pour y repointer `µ.paths`. Une requête de composants au lieu de N |
| `none` | aucun en-tête : la balise du composant racine et son HTML prérendu, rien devant |

Avec `js: "bundle"`, le fragment reste nu quelle que soit cette clé : le fichier unique livre déjà le cœur et tous les composants, il n'y a rien à précharger page par page. Le build le signale en une ligne.

L'**ensemble de démarrage** d'une page, ce sont les composants dont la balise est dans son HTML prérendu, plus la fermeture de leurs dépendances directes : un enfant qu'un `{if}` faux n'a pas rendu en fait partie (il s'affichera au premier clic sans aller-retour), les modules `@import`-és par ces composants aussi.

```json
{
  "render": { "default": "prerender", "startup": "bundle", "routes": { "/": { "component": "mjs-landing" } } }
}
```

Le fichier de page n'est assemblé qu'en **construction de production** (`mjs build --prod`) : en développement, `bundle` se comporte comme `preload`, avec une ligne d'information au journal du build — le rechargement à chaud n'est pas mêlé à un second assemblage. Restent **externes** au fichier de page : le cœur, les feuilles partagées, les animations, les fichiers de langue, le manifeste externe, et les **modules** — un module doit rester une instance unique, un store exporté par un module et dupliqué dans un fichier de page casserait l'état partagé. Les fichiers séparés de chaque composant existent toujours : une autre page les charge seuls, le rendu serveur les lit un par un.

Une page de moins de deux composants n'a rien à factoriser : elle reçoit le préchargement seul. `render.startup: "bundle"` avec `js: "bundle"` est refusé à la lecture de la configuration — le fichier unique livre déjà tout le projet, un fichier de page n'aurait rien à assembler.

Le nom du fichier de page vient de l'**URL de la route** : `/` donne `mjs_page-index-<empreinte>.js`, `/a/index` donne `mjs_page-a-index-<empreinte>.js` (tout ce qui n'est ni lettre ni chiffre devient un tiret). Deux routes qui arriveraient au même nom sont refusées à la lecture de la configuration, nommées toutes les deux : une seule garderait son fichier. Avec `render.locales`, les langues d'une même route partagent leur URL, donc leur fichier de page — il assemble l'**union** des composants de toutes les langues, et chaque fragment déclare dans sa fiche l'ensemble de démarrage de SA langue, fermé par les dépendances statiques du gabarit — un enfant déclaré dans une branche `{if}` sur la langue est donc déclaré dans les deux. Un composant qui n'apparaît qu'en anglais est déjà chargé quand la bascule de langue le fait entrer.

`csp: true` est compatible : la fiche est un `<script type="application/json">`, de la donnée qu'aucune politique de sécurité n'exécute — rien d'exécutable n'est ajouté au fragment. Les fichiers de page figurent dans `mjs-precache.json` comme le reste des sorties du build, cf. [36 · Application installable](36-application-installable.md).

`mjs serve` sur une route `prerender` dont le fichier figé n'existe pas encore rend la page à la volée : ce HTML-là n'a pas d'en-tête de démarrage — il se comporte comme `none`, les composants partent après le manifeste.

Ce que coûte `bundle` : un composant partagé par plusieurs pages est téléchargé une fois **par** fichier de page qui l'embarque (le cache ne le reconnaît pas d'un fichier à l'autre), et la moindre modification de l'un d'eux change l'empreinte de tout le fichier de page. C'est un arbitrage : une seule requête au démarrage contre une invalidation plus large. Les pages d'entrée, chargées « à froid » par un visiteur qui ne connaît rien du site, sont les premières à y gagner.

### `logLevel`

Le niveau de la console — **côté navigateur** (`µ.log`/`µ.warn`/`µ.error`) et **côté build** (ce que le minifieur retire du bundle, les avertissements du terminal) — réglé par la MÊME clé, du plus bavard au plus muet :

| Niveau | Montre |
|---|---|
| `'log'` | tout — traces, avertissements, erreurs |
| `'warn'` | avertissements et erreurs |
| `'error'` | erreurs seules |
| `'silent'` | rien |

Une chaîne (`"logLevel": "warn"`) pose le MÊME niveau dans les deux environnements. Un objet `{ dev?, prod? }` pose un niveau par environnement — chaque sous-clé absente retombe sur le défaut de SON environnement :

```json
{ "logLevel": { "dev": "log", "prod": "error" } }
```

Défauts : `dev` → `'log'` (tout, pendant qu'on développe), `prod` → `'warn'` (avertissements et erreurs, silence sur les traces). Le niveau de PRODUCTION gouverne aussi ce que le minifieur retire du bundle. Détail complet, et l'échappatoire `µ.debug` : [34 · Déboguer](34-deboguer.md).

## 3. Validation stricte

Comme pour chaque bloc imbriqué (`ws`, `ws.limits`, `render`, `lint`…), la validation de `mjs.config.json` est **stricte** : une clé absente de la liste ci-dessus fait échouer le build, avec un message qui nomme la clé fautive et rappelle la liste complète des clés valides. Une faute de frappe n'est donc jamais absorbée en silence.

---

📚 **Voir aussi** : [19 · SSR](19-ssr.md) pour le bloc `render` et le journal d'erreurs ; [23 · MJS-WS](23-mjs-ws.md) et [24 · MJS-Server](24-mjs-server.md) pour `ws`/`serveur` ; [29 · i18n](29-i18n.md) pour `i18n` ; [31 · Thèmes, variables & variants](31-themes.md) pour `varPrefix`/`defaultTheme` ; [35 · Images](35-images.md) pour `image`.
