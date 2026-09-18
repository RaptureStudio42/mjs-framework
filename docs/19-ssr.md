# 19 · SSR — rendu côté serveur

> 📚 Pas de chapitre de tuto interactif pour le SSR (il s'exécute côté serveur, hors de l'éditeur live) : cette page se suffit à elle-même. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Le **SSR** (*Server-Side Rendering*) fait rendre un composant **en HTML côté serveur**, pour deux gains : la page s'affiche **immédiatement** (sans attendre le JavaScript) et son contenu est **visible des moteurs de recherche** (SEO).

MJS suit la stratégie **« rendre puis remplacer »** (*render-then-replace*) :

1. le serveur rend le composant en HTML, emballé en **Declarative Shadow DOM** (styles inclus) ;
2. le navigateur **affiche** ce HTML sans exécuter de JS ;
3. quand le bundle arrive, le composant **adopte** ce Shadow DOM puis **reconstruit** sa vraie vue interactive à la place (le *swap*) — l'interactivité reprend.

> Le SSR requiert le paquet **`happy-dom`** (le DOM serveur utilisé pour rendre). Il est importé dynamiquement : un projet **client-only** n'en a aucun besoin. Installe-le pour le SSR : `npm i happy-dom`.

## 1. Rendre un composant — `renderToString`

```js
import { renderToString } from 'mjs-framework'

const { html, sharedScript } = await renderToString({
  sourceDir: './app/mjs',     // dossier des composants .mjs
  tag: 'mjs-page',            // composant racine à rendre
  props:  { article },        // données LOCALES (→ attribut sur la balise)
  store:  { user, panier },   // état GLOBAL de l'appli ($$x / µ.store) → sérialisé inline
})
```

> ℹ️ **L'état global se passe par `store`** — c'est le vrai état global de l'appli (`$$x` → `µ.store`), lu côté client par le store zéro-import. Il n'y a **plus** d'option `shared`/`§§` côté SSR (retirée) : `§§` nu est **toujours** un **contexte réactif de sous-arbre**, pas un espace global — rien à sérialiser à l'échelle de la page (cf. [Contexte](13-contexte.md)). Pour un singleton `µ$$x` importé (déclaré, importé et consommé avec ce même symbole — cf. [Stores](14-stores.md)), passe sa valeur initiale par `store` sous la clé correspondante, ou laisse le module l'initialiser lui-même.

`renderToString` **compile** les composants, les **monte** dans un DOM serveur, attend la fin du rendu, puis renvoie :

| Champ | Contenu |
|---|---|
| `html` | la balise complète : `<mjs-page …><template shadowrootmode="open">…</template></mjs-page>` |
| `sharedScript` | le `<script>` JSON de l'état global (`store`), à placer **une fois** dans la page (vide si aucun `store`) |
| `hydrateScript` | le `<script>` qui active l'hydratation côté client, à placer **avant** le bundle (vide si `ssrMode` vaut `'replace'`, le défaut — voir §6 ; vide aussi pour tout composant `mjs-light`, quel que soit `ssrMode` — voir piège plus bas) |
| `shadowHtml` | le markup rendu du shadow (sans le wrapper), utile pour des tests |
| `css` | le CSS scopé du composant (déjà inliné dans `html`) |
| `light` | `true` si le composant est en mode `mjs-light` (pas de Shadow DOM) |
| `warnings` | avertissements de compilation |

Options : `ssrMode` (la stratégie de reprise en main — voir §6), `props`, `store`, `shadowMode` (`'open'` par défaut — **requis** pour la reprise en main), `settleMs` (plafond d'attente, défaut 1000 ms), `light` (racine sans Shadow DOM — §7), `outputDir`, `defaultScriptLang`.

<details>
<summary>🎓 <b>Pour débutants</b> — c'est quoi le Declarative Shadow DOM&nbsp;?</summary>

Un composant MJS vit dans un *Shadow DOM* (un mini-document isolé, avec ses styles à lui). Normalement ce Shadow DOM est créé **par le JavaScript**. Le **Declarative Shadow DOM** permet de l'écrire **directement en HTML**, avec une balise `<template shadowrootmode="open">` : le navigateur la rencontre au chargement et reconstruit le Shadow DOM **tout seul, sans JS**. C'est ce qui rend l'affichage instantané possible côté serveur.

</details>

## 2. Brancher le rendu dans une page

L'ordre dans la page compte : le `sharedScript` doit venir **avant** le bundle MJS (il est lu au démarrage du runtime). `sharedScript` porte en réalité **deux** balises JSON concaténées : `#__mjs_store` (l'état global, `store`) et `#__mjs_i18n` (langue + sections i18n **effectivement consultées** pendant CE rendu — cf. [i18n](29-i18n.md) §2). Les deux se posent **avant** le bundle, dans cet ordre ; chacune est **absente** (chaîne vide) si elle n'a rien à transporter — aucun `store`, ou aucune section i18n consultée.

`hydrateScript` rejoint le même bloc, **avant** le bundle lui aussi, dès que `ssrMode` diffère de `'replace'` (§6 — `markers`/`positional`/`diff`) : c'est le `<script>` qui active l'hydratation choisie côté client. Sans lui, le client ne sait jamais qu'un mode d'hydratation a été demandé et retombe silencieusement en `replace` (les nœuds sont recréés plutôt qu'adoptés). Absent (chaîne vide) tant que `ssrMode` vaut `'replace'`, le défaut, et absent de la même façon pour tout composant `mjs-light`, quel que soit `ssrMode` : sans Shadow DOM, aucun mode d'hydratation n'a de nœud à reprendre en main (piège `mjs-light` plus bas).

```html
<!DOCTYPE html>
<html>
  <body>
    <!-- 1. le HTML rendu, à l'emplacement voulu -->
    <mjs-page mjs-ssr>
      <template shadowrootmode="open">…contenu pré-rendu…</template>
    </mjs-page>

    <!-- 2. l'état global ET la graine i18n, UNE fois chacune, AVANT le bundle -->
    <script type="application/json" id="__mjs_store">{"user":…}</script>
    <script type="application/json" id="__mjs_i18n">{"lang":"fr","sections":{"fr":{"panier":…}}}</script>

    <!-- 3. le bundle MJS : adopte le Shadow DOM, réhydrate $$ et les sections i18n semées, reprend la main -->
    <script src="/assets/mjs-bundle.js"></script>
  </body>
</html>
```

Côté serveur, on insère `html` à l'étape 1 et `sharedScript` (+ `hydrateScript`, si `ssrMode` n'est pas `'replace'`) à l'étape 2 — un seul bloc, les balises s'y concatènent dans le bon ordre. Tant que le bundle n'est pas chargé, la page est **affichée mais figée** ; dès qu'il s'exécute, elle devient interactive.

Le balisage rendu par le serveur **reste visible jusqu'au premier rendu client**, qui le remplace : chaque élément `mjs-*` rendu porte l'attribut `mjs-ssr` (posé par le rendu serveur, racine et imbriqués), et le masquage anti-FOUC du runtime — qui cache tout composant pas encore défini — épargne les éléments qui le portent. Un composant que le serveur n'a pas rendu reste, lui, masqué jusqu'à sa définition. Rien à faire côté page : l'attribut voyage avec le HTML, et le client n'a pas à le retirer.

`mjs-ssr` est **réservé au rendu serveur** : ne l'écris jamais à la main. Sur un composant `mjs-light`, il dit « ce contenu est la photo du serveur » — la balise qui le porte **remplace ses enfants** à la reprise en main du client, comme le ferait un Shadow DOM déclaratif. Posé à la main sur un léger qui porte des enfants écrits par l'auteur, il les fait donc disparaître au montage.

## 2-bis. Poser la balise soi-même, SANS SSR

La balise `#__mjs_store` **fonctionne sans aucun SSR** : une appli Rails qui ne rend jamais de composant côté serveur peut tout de même déposer ses données initiales de cette façon — le runtime la lit au boot (avant que les composants ne montent) et fusionne chaque clé dans `$$`, exactement comme après un `renderToString`. Deux règles s'appliquent, que le SSR soit utilisé ou non :

- **la balise précède le bundle** — même contrainte qu'à l'étape 1/2 ci-dessus : elle doit être lue **avant** que le JS du bundle ne démarre ;
- **l'échappement porte sur TOUT `<`**, pas seulement `</` : un `<` isolé dans une valeur (ex. `"a < b"`) peut lui aussi rouvrir une balise si le JSON est injecté tel quel dans le HTML — `renderToString`/`sharedScript` échappe déjà chaque `<` en `<` ; une génération manuelle (vue ERB, builder Ruby) doit faire la même chose, pas seulement sur `</script>`.

La même règle vaut pour une balise `#__mjs_i18n` posée à la main (forme `{"lang":"fr","sections":{"fr":{"panier":{…}}}}` — `sections` nichée par langue puis par section, cf. [i18n](29-i18n.md) §2, même échappement) : elle se pose JUSTE APRÈS `#__mjs_store`, JUSTE AVANT le bundle — utile pour semer, sans SSR, les traductions qu'une page rend déjà côté serveur par un autre moyen (vue ERB, etc.).

```erb
<%# côté Rails, par exemple %>
<script type="application/json" id="__mjs_store"><%= raw({ user: @user, settings: @settings }.to_json.gsub('<', '\u003c')) %></script>
<script src="/assets/mjs-bundle.js"></script>
```

Voir [Stores](14-stores.md#déclarer-les-clés-attendues-du-serveur-init) pour déclarer, côté composant, les clés que cette balise doit fournir.

## 3. Réutiliser un renderer — `createSSRRenderer`

`renderToString` recompile à chaque appel. Pour rendre **plusieurs** composants (ou servir plusieurs requêtes), compile **une seule fois** avec `createSSRRenderer` :

```js
import { createSSRRenderer } from 'mjs-framework'

const renderer = await createSSRRenderer({ sourceDir: './app/mjs' })

// à chaque requête — pas de recompilation :
const a = await renderer.renderToString('mjs-page', { props: { article } })
const b = await renderer.renderToString('mjs-card', { props: { item } })

await renderer.close()   // libère le bundler en fin de vie
```

## 4. Passer des données

MJS distingue deux portées, **transmises différemment** (voir aussi [Props](04-props.md) et [Stores](14-stores.md)) :

### Données locales → `props` (attribut)

Les props propres à un composant passent par un **attribut** sur sa balise. Les valeurs scalaires sont posées telles quelles ; les **objets et tableaux** sont sérialisés en **JSON** et ré-hydratés automatiquement au montage — côté serveur **et** côté client.

```js
await renderToString({ sourceDir, tag: 'mjs-card',
  props: { title: 'Stylo', item: { price: 3, tags: ['neuf'] } } })
// → <mjs-card title="Stylo" item="{…JSON…}">…</mjs-card>
```

Comme l'attribut est porté par la balise dans le HTML envoyé, le client le **relit gratuitement** lors de la reprise en main : la donnée locale n'a pas besoin d'un transport séparé.

### État global → `store` (store `$$` inline)

L'état global de l'appli (`$$`, c.-à-d. `µ.store`) est injecté côté serveur via `store`, sérialisé dans `sharedScript`, et **réhydraté au démarrage** du runtime — avant que les composants ne montent.

```js
const { html, sharedScript } = await renderToString({ sourceDir, tag: 'mjs-header',
  store: { user: { name: 'Ada' }, theme: 'dark' } })
```

```html
<script>
  $$user.name     # lu côté composant → la valeur réhydratée du serveur
</script>
<header>Bonjour {$$user.name}</header>
```

Aucun appel réseau au montage : l'état voyage **dans la page** (la stratégie de Next.js / Nuxt). On ne re-fetch pas ce que le serveur connaît déjà.

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi pas un appel AJAX pour charger l'état&nbsp;?</summary>

Le serveur a **déjà** les données (il vient de s'en servir pour rendre le HTML). Refaire un appel réseau au démarrage du client, ce serait : attendre une réponse (la page « clignote »), refaire le travail, et charger le serveur pour rien. En **sérialisant l'état dans la page**, le client l'a immédiatement et reconstruit la vue à l'identique, sans aller-retour. On garde l'AJAX pour ce qui est chargé **plus tard** (défilement infini, données secondaires).

</details>

## 5. Comment la reprise en main fonctionne

Au chargement du bundle, chaque composant constate qu'un Shadow DOM (le DSD du serveur) **existe déjà** : au lieu d'en créer un nouveau (ce qui lèverait une erreur), il le **réutilise**, en vide le contenu pré-rendu, et y reconstruit sa vraie vue interactive. C'est le *swap* : un seul rendu visible, sans doublon, et l'interactivité (événements, réactivité) est branchée.

Le rendu serveur **attend** la fin du travail asynchrone avant de produire le HTML : un bloc `{await}` qui charge des données est rendu **résolu** (le contenu final), pas son état de chargement.

> ⚠️ En mode SSR le Shadow DOM est en **`open`** (pour que le client puisse récupérer le DSD du serveur). En rendu purement client, il reste `closed` comme d'habitude — le SSR ne change donc rien au comportement d'une appli non rendue côté serveur.

## 6. Choisir la stratégie de reprise en main — `ssrMode`

La reprise en main (rendre la page interactive au boot) peut suivre **quatre stratégies**, choisies via l'option `ssrMode` :

```js
await renderToString({ sourceDir, tag: 'mjs-page', ssrMode: 'markers' })
```

| `ssrMode` | Comment | Nœuds recréés au boot | Idéal pour |
|---|---|---|---|
| `'replace'` *(défaut)* | reconstruit la vue à côté et **remplace** la photo serveur | tous | le plus simple ; suffit dans la plupart des cas |
| `'markers'` | le serveur **étiquette** les nœuds réactifs ; le client les **adopte** | **0** | économiser le CPU au boot (le plus efficace) |
| `'positional'` | adopte par **position** (sans étiquette ; HTML propre) | tous\* | HTML serveur minimal, structure stable |
| `'diff'` | adopte en **comparant/corrigeant** (réconciliation) | tous\* | robustesse à un écart serveur/client |

\* `positional` et `diff` recréent un arbre temporaire pour s'aligner, puis le jettent : ils **réutilisent le DOM serveur** (état préservé : focus, défilement) mais n'économisent pas la création. Seul `markers` ne recrée rien.

> 💡 Les trois modes d'hydratation (`markers` / `positional` / `diff`) réutilisent les nœuds du serveur : ils **préservent l'état du DOM** (focus, scroll, champ en cours) et évitent tout clignotement. `replace` reconstruit tout — c'est le plus simple, et déjà sans flash visible (le remplacement est synchrone).

<details>
<summary>🎓 <b>Pour débutants</b> — laquelle choisir&nbsp;?</summary>

Commence par **`replace`** (le défaut) : le plus simple, il marche partout. Passe à **`markers`** si tu veux que la page se « réveille » sans rien refabriquer (le navigateur travaille moins au démarrage). `positional` et `diff` gardent un HTML serveur sans étiquettes ; `diff` est le plus tolérant si le rendu serveur et le rendu client diffèrent un peu.

</details>

> ℹ️ Périmètre actuel des trois hydratations : **éléments + interpolations de texte**. Les blocs `{if}` / `{for}` restent rendus par `replace` en attendant leur prise en charge.

> ⚙️ **Le moteur d'hydratation n'est embarqué que s'il sert.** Le build lit le bloc `render` (§7) : dès qu'une page y demande `ssr:markers`, `ssr:positional` ou `ssr:diff` — par `render.default` ou par le `mode` d'une route — les trois approches d'adoption partent dans le cœur. `csr`, `prerender` et `ssr`/`ssr:replace` n'adoptent rien : elles n'en ont pas besoin, et le cœur est d'autant plus léger.
>
> Deux cas demandent le module explicitement, par `"runtime": ["hydrate"]` dans `mjs.config.json` : un serveur qui rend par l'**API** (`renderToString`/`createSSRRenderer`, avec `ssrMode`) sans bloc `render` dans la configuration ; et une route configurée `ssr`/`ssr:replace` dont les clients demandent une variante d'hydratation par l'en-tête `render.header` (le header peut changer de stratégie à coût égal, le build ne le voit pas).
>
> Si la page demande une hydratation que le cœur n'embarque pas, **rien ne casse** : un avertissement en console (une seule fois), puis la vue est reconstruite façon `replace` — même rendu, sans le gain.

## 7. Piloter le rendu par la config — le bloc `render`

Tu n'as pas à appeler `renderToString` toi-même : **déclare quelle URL rend quel composant, dans quel mode**, et MJS s'en charge. Le mode d'une page n'est **ni** un réglage du composant **ni** un drapeau global — c'est **ce que le serveur/build fait de la page**, piloté par `mjs.config.json` :

```json
{
  "sourceDir": "app/mjs",
  "outputDir": "public/mjs",
  "render": {
    "default": "prerender",
    "routes": {
      "/":            { "component": "mjs-landing" },
      "/blog":        { "component": "mjs-blog" },
      "/produit/:id": { "component": "mjs-produit", "mode": "ssr" },
      "/app":         { "component": "mjs-app", "mode": "csr" }
    }
  }
}
```

**Deux niveaux de routage, à ne pas confondre :**

- **Niveau 1 — les pages** (vraies URLs : `/`, `/blog`, `/produit/42`). Ce sont les points d'entrée (liens partagés, robots, premier chargement). C'est ce niveau que `render.routes` déclare, et **le seul** qui a besoin de SSR/prérendu.
- **Niveau 2 — la navigation in-app** (`#/…`). Une fois la page chargée, la navigation interne reste **100 % client** (routeur hash MJS) — le `#` n'est jamais envoyé au serveur, donc rien à rendre côté serveur pour ces routes.

**Les modes :**

| mode | ce qui se passe | serveur au runtime&nbsp;? |
|---|---|---|
| `csr` | le back sert le shell, le navigateur monte `<mjs-x>` | non |
| `prerender` | HTML figé au `mjs build`, servi tel quel | non (build) |
| `ssr` (= `ssr:replace`) | rendu serveur à la requête, client remplace | oui (`mjs serve`) |
| `ssr:markers` / `positional` / `diff` | rendu serveur + hydratation (cf. §6) | oui (`mjs serve`) |

Une route sans `mode` hérite de `render.default` (recommandé&nbsp;: `"prerender"`, pour le SEO + le cache). Une route paramétrée (`:id`) ou catch-all (`*`) ne peut pas être prérendue au build (les valeurs sont inconnues) → passe-la en `ssr`.

### Racine en mode léger — `light`

`"light": true` sur une route monte son composant racine **sans Shadow DOM** (`mjs-light`, cf. le piège `mjs-light` plus bas) : le HTML rendu est `<mjs-x mjs-light mjs-ssr>` avec le contenu en **enfants directs**, aucun `<template shadowrootmode>`, et la feuille scopée du composant voyage dans le fragment — `:host` y est réécrit en nom de balise, un léger n'ayant pas d'hôte réel à désigner.

```json
{
  "render": { "routes": { "/": { "component": "mjs-weather-app", "light": true } } }
}
```

À poser quand la page monte déjà sa racine en léger (`<mjs-weather-app mjs-light>` dans la coquille) : le fragment décrit alors **le même arbre** que celui que le client rebâtit, et le remontage se fait sur une racine qui porte déjà l'attribut. Sans la clé, la racine est rendue à Shadow DOM déclaratif, quel que soit le mode que la coquille demande — deux arbres différents pour la même page. La clé vaut pour le prérendu au build comme pour le rendu par requête. Défaut&nbsp;: `false`. Sur une route `csr`, où le serveur ne rend rien, elle n'a rien à décider : la configuration reste valide et la lecture du fichier le signale en une ligne.

Comme pour tout composant léger, `hydrateScript` reste vide (§1)&nbsp;: sans Shadow DOM, aucun mode d'hydratation n'a de nœud à reprendre en main — la racine est reconstruite par le client.

### Prérendu au build — `mjs build`

`mjs build` **prérend automatiquement** toutes les pages `prerender` **concrètes** de `render.routes` : il rend chaque composant en Declarative Shadow DOM et écrit le HTML dans `render.outDir` (défaut&nbsp;: `<outputDir>/../mjs_pages/`), une page par fichier (`/` → `index.html`, `/blog` → `blog.html`). Ton back sert ces fichiers pour les URLs correspondantes&nbsp;; le bundle client hydrate par-dessus (render-then-replace). **Tu n'écris aucun code de rendu.** Les routes non prérendables (paramétrées, `ssr`, `csr`) sont listées dans la sortie du build — jamais ignorées en silence.

**Le fragment porte ce que sa page démarre.** En tête de chaque page écrite, sous la ligne de bandeau, `mjs build` pose un `<link rel="modulepreload">` par composant que cette page affiche — plus ceux dont ils dépendent directement, et les modules qu'ils importent. Le navigateur les récupère dès la première vague, sans attendre que le manifeste soit téléchargé puis exécuté pour les découvrir. En construction de production, `render.startup: "bundle"` va plus loin : les composants de la page sont assemblés en un fichier unique par page, et une fiche JSON dit au manifeste d'y pointer. Valeurs, arbitrages et surcharge par route : [32 · CLI & configuration](32-cli-et-configuration.md#renderstartup).

Avec `js: "bundle"` ([32 · CLI & configuration](32-cli-et-configuration.md#js)), il n'y a rien à démarrer page par page : le fichier unique que la coquille charge porte déjà le cœur et tous les composants. Les fragments ne reçoivent alors aucun en-tête de démarrage, et le build le dit en une ligne.

Cet en-tête est délimité par deux lignes de commentaire, `<!-- mjs:demarrage -->` et `<!-- /mjs:demarrage -->` : c'est la zone que le build possède dans le fichier, tout le reste étant le HTML rendu. Un fragment dont le HTML rendu ne change pas n'est **pas réécrit** — ni son corps, ni son en-tête quand il est déjà le bon : deux constructions de suite laissent les fichiers intacts, à la date près, et le watcher de `mjs dev` ne se redéclenche pas sur sa propre écriture.

Le build tient le dossier des pages figées, et n'y touche QUE ce qu'il a écrit : un fragment dont plus aucune route prérendue n'attend le fichier (route retirée, renommée, passée en `csr`/`ssr`, langue retirée de `locales` — jusqu'à la dernière page prérendue du projet) est supprimé à la construction suivante, avec une ligne de journal par fichier — un fragment absent est honnête, un fragment périmé qui pointerait des fichiers disparus ne l'est pas. Un fragment se reconnaît à sa **première ligne**&nbsp;: elle porte la marque `<!-- mjs:prerender` (les fragments des constructions antérieures à cette marque sont reconnus à leur ancien bandeau, `<!-- Page prérendue par MJS …`). Tout autre `.html` est intouchable — la coquille de ton application, une page écrite à la main, la sortie d'un autre outil — et `render.outDir` peut donc être un dossier public partagé, ou la racine du projet. La marque est le seul critère&nbsp;: un fichier étranger dont la première ligne l'imite est traité comme un fragment, et retiré comme tel. Le dossier doit rester **dans** le projet&nbsp;; un `..` ou un chemin absolu ailleurs est refusé à la lecture de la configuration. Le balayage couvre **tout le dossier**, sous-dossiers compris (le fragment d'une route imbriquée `/a/b` vit dans `a/b.html`), et un sous-dossier vidé de ses fragments part avec eux&nbsp;; `node_modules` et les dossiers cachés sont laissés de côté. Une construction dont le prérendu a échoué ne supprime rien.

### Rendu par requête — `mjs serve`

Pour le SSR **dynamique** (contenu qui change à chaque requête, ou routes paramétrées `/produit/:id`), il faut un serveur de rendu Node. MJS le fournit : lance **`mjs serve`**. Il compile le projet, sert les assets, et pour chaque page applique le mode de `render.routes` — `prerender` (fichier figé), `ssr` (rendu à la volée), `csr` (le client monte). Les params d'URL (`:id`) sont passés au composant en `props` (lus via `&id`) — un joker `*` en fin de route pose de même `rest` (chaîne) et `all` (tableau), lus via `&rest`/`&all`.

**Override par requête (header).** Une requête peut forcer un mode via un en-tête HTTP (nom réglé par `render.header`, ex. `X-MJS-Render`). Pratique pour un appel AJAX qui veut le shell brut&nbsp;: `X-MJS-Render: csr`. La réponse indique le mode réellement appliqué dans `X-MJS-Mode`.

**Dans un back existant (Rails, Express…).** Plutôt que `mjs serve` en frontal, réutilise le handler en **sidecar / middleware**&nbsp;: `createRenderHandler(config, dir)` retourne `handle(path, headers) → { kind, status, body }`. Ton back délègue le rendu des pages à MJS et garde la main sur le reste (layout, auth…). Un projet 100&nbsp;% prérendu/CSR n'a besoin d'aucun runtime Node.

> 🔎 **SEO — pourquoi prérendre&nbsp;?** Un robot d'indexation (Google…) qui charge une page en **CSR pur** reçoit un shell quasi vide (`<mjs-x></mjs-x>`)&nbsp;: il doit exécuter le JS pour voir le contenu, ce que tous les robots ne font pas correctement. En **prérendu/SSR**, le serveur renvoie le **HTML complet** immédiatement → contenu indexable **et** premier affichage instantané (bon pour le référencement comme pour la vitesse perçue). Corollaire du modèle à 2 niveaux&nbsp;: ce qui vit derrière `#/…` (niveau 2) n'est **pas indexé individuellement**. Mets donc en **page déclarée** (niveau 1) tout ce qui doit être partagé/référencé (accueil, articles, fiches produit)&nbsp;; garde en `#/…` le reste (panier, filtres, étapes internes).

### `mjs dev` sert aussi `render.routes`

Pas besoin de basculer sur `mjs serve` pour prévisualiser le rendu en développement : le serveur de `mjs dev` (watch + HMR) applique **aussi** `render.routes` — chaque page déclarée est servie dans son mode réel (`prerender`/`ssr`/`csr`), régénérée à **chaque recompilation** (les pages `prerender` ne restent jamais figées sur une ancienne version pendant que tu développes).

## 8. Le moteur de rendu — `render.engine` et `render.browserPool`

Le rendu HTML tourne sur un **moteur d'exécution**, choisi par `render.engine`, sur **deux axes indépendants** — le prérendu (`mjs build`, et les recompiles `mjs dev`) et le SSR par requête (`mjs serve`) n'ont pas forcément le même besoin de fidélité :

```json
{
  "render": {
    "default": "prerender",
    "engine": { "prerender": "browser", "request": "happy-dom" },
    "browserPool": { "size": 2, "keepAlive": true, "maxAgeMs": 300000 },
    "forwardOrigin": { "trustedHosts": ["exemple.com", "www.exemple.com"] },
    "routes": { "/produit/:id": { "component": "mjs-produit", "mode": "ssr", "settleMs": 2000 } }
  }
}
```

| Valeur | Moteur | Fidélité | Coût |
|---|---|---|---|
| `'happy-dom'` | DOM simulé en pur JS | correcte pour la majorité des composants | léger, aucune dépendance binaire |
| `'browser'` | vrai Chromium headless (Playwright) | maximale (CSS/JS complets, comme un vrai visiteur) | lance/maintient un processus navigateur |

**Défauts** (non appliqués dans la config, résolus à l'usage) : `request` → toujours `'happy-dom'` (jamais de navigateur implicite par requête, trop coûteux à lancer à la volée sans configuration explicite) ; `prerender` → `'browser'` **si Playwright est installé** (`npm i -D playwright`), sinon repli `'happy-dom'` (message informatif, une fois par process). Priorité de résolution : `route.engine` (par route, cf. table `render.routes` — `engine`/`settleMs` s'y règlent **par page**) > `render.engine.<axe>` (config globale) > défaut.

**Le pool de navigateurs** (`browserPool`, moteur `'browser'` seulement) réutilise des emplacements (contexte + page) entre rendus plutôt que de relancer un processus Chromium à chaque fois (~200-500&nbsp;ms de lancement). Options — défauts résolus à l'usage : `size` (2, nombre d'emplacements maintenus), `keepAlive` (`true`, processus navigateur réutilisé entre rendus), `maxAgeMs` (300000 = 5&nbsp;min, recyclage d'un emplacement trop ancien). Chaque rendu ré-navigue sur son emplacement (nouveau Realm JS, `localStorage`/`sessionStorage` vidés) : l'isolation entre deux rendus du même emplacement est garantie sans relancer le processus.

### `render.forwardOrigin` — ⚠️ ne fais **jamais** confiance au `Host` du client

`render.forwardOrigin` transmet l'**origine et les cookies** au moteur de rendu, pour le **SSR par requête uniquement** (`mjs serve` — le prérendu au build n'a par définition aucune requête entrante à transmettre) : sans ça, un `{await fetch('/api/x')}` dans un composant rendu côté serveur partirait vers une origine par défaut qui ne répond jamais, et une page qui dépend de la session de l'utilisateur (cookie d'auth) rendrait un contenu anonyme.

> ⚠️ **Pourquoi ne jamais dériver l'origine du `Host` brut de la requête entrante.** Le `Host` HTTP est une donnée **client**, falsifiable à volonté (`curl -H "Host: 169.254.169.254" …`). Un serveur qui construit son origine de proxy directement à partir de ce `Host` (comportement d'une version antérieure de MJS, **corrigé** — faille SSRF) laisse un attaquant faire exécuter par le moteur de rendu (happy-dom ET moteur navigateur, tous deux de **vrais** clients HTTP) une requête sortante vers **n'importe quelle cible** — réseau interne de l'hébergeur, métadonnées cloud (`169.254.169.254`)… — et **réfléchir la réponse dans le HTML SSR**. `render.forwardOrigin` n'accepte donc **plus jamais** de dériver silencieusement une cible du `Host` client.

**Contrat (3 formes + défaut) :**

| Config | Comportement |
|---|---|
| absente (défaut), ou `true` | **sûr** — aucune dérivation depuis `Host`. Les moteurs retombent sur leur origine locale câblée en dur (`http://localhost/`), jamais influencée par le client. `true` **n'autorise aucun hôte** : ce n'est pas une bascule « fais confiance au Host », juste « active le mécanisme, avec le défaut sûr ». |
| `false` | Désactivé — jamais de forwarding. |
| chaîne (`"https://back.exemple.com"`) | **Origine fixe** imposée par toi — toujours cette valeur, quel que soit le `Host` envoyé par le client (le `Host` client est totalement ignoré). |
| `{ "trustedHosts": [...] }` | **Allowlist** — seul un `Host` entrant qui figure **exactement** dans la liste autorise le forwarding (vers ce `Host`, avec `x-forwarded-proto`) ; tout `Host` absent de la liste retombe sur le défaut sûr. |

**Défense en profondeur, même autorisée explicitement** : une cible qui résout vers une IP privée/loopback/lien-local (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16` — dont les métadonnées cloud —, `::1`, `fc00::/7`, `localhost`…) est **toujours refusée**, y compris si elle figure dans `trustedHosts` ou en origine fixe — protège contre une allowlist trop large ou une faute de frappe. Repli, dans tous les cas de refus : origine locale, le `fetch` relatif de l'app échoue proprement côté client (pas de crash serveur, pas de fuite) ; un avertissement est loggé (`warnings` du résultat de rendu).

> 💡 **Changement de défaut assumé (sécurité).** Avant ce correctif, le défaut (`forwardOrigin` absent, ou `true`) dérivait l'origine du `Host` de la requête entrante — pratique, mais c'était exactement le trou SSRF. Le nouveau défaut ne fait plus jamais confiance au `Host` : si ton app SSR a besoin d'atteindre un back réel via un fetch relatif, déclare-le explicitement en `trustedHosts` (multi-hôtes légitimes, ex. domaines i18n) ou en origine fixe (un seul back connu).

> 💡 **Le moteur navigateur exécute `µmount`/`µawake` pour de vrai.** Contrairement à happy-dom (où `µ._isServer` court-circuite ces hooks), un vrai Chromium charge le bundle comme un visiteur réel : `µmount` s'exécute réellement pendant CE rendu. Corollaire à connaître : un composant dont `µmount` fait un vrai `fetch()` ou ouvre un vrai `WebSocket` le fera aussi **pendant le rendu serveur** (prérendu ou par requête) — comportement attendu d'un « vrai client », pas une fuite à corriger.

## `µserver` — savoir qu'on est côté serveur

La rune publique **`µserver`** (forme courte de `µ.server`) est un booléen : `true` pendant un rendu serveur (SSR/prérendu, **sur les deux moteurs** — happy-dom et navigateur), `false` côté client. Utile pour du code strictement client (accès à `localStorage`, mesure DOM, lib tierce qui suppose un vrai navigateur) qui planterait sinon pendant le rendu serveur :

```html
{if not µserver}
  <canvas @this=!{canvas}></canvas>
{end}
```

> ⚠️ `µserver` n'est **pas réactif** (l'environnement d'exécution ne change jamais en cours de vie d'une instance — un composant ne bascule pas serveur→client à chaud, il est **re-monté** côté client après hydratation) et n'est **pas** l'inverse d'un hook de cycle de vie : `µeffect` continue de **tourner** côté serveur (ce n'est pas court-circuité, contrairement à `µmount`/`µawake` en mode happy-dom) — un `µeffect` qui doit rester client-only doit lui aussi tester `µserver`.

## 9. Clé en main : les chargeurs `serve.server.mjs`

Pour une pile **100&nbsp;% MJS**, `mjs serve` **et `mjs dev`** savent déjà parler le protocole de navigation décrit au chapitre [Navigation (UJS)](21-navigation.md) → *Le protocole serveur* : pas une ligne de code réseau à écrire, juste déclarer les **données** de chaque page. Les deux commandes partagent le même pipeline d'exécution des actions — un `serve.server.mjs` posé une fois marche à l'identique en développement (`mjs dev`) et une fois servi par requête (`mjs serve`).

### Où vit le fichier — `render.entry`

`mjs serve` et `mjs dev` cherchent par défaut **`serve.server.mjs`** à la racine du projet, puis **`server/serve.server.mjs`** ; un autre emplacement se déclare explicitement dans la config :

```json
{ "render": { "entry": "server/serve.server.mjs" } }
```

Le fichier compile dans le **même dialecte** que les `<script>` de composants (`languages.script`, Civet par défaut) et est **rechargé à chaud** dès qu'il change — aucun redémarrage du processus, aucune coupure des requêtes en cours. Aucun fichier trouvé à aucun des emplacements&nbsp;? La navigation-composant fonctionne quand même (`module` continue d'être résolu normalement par `render.routes`) — `props` est simplement vide.

### Le contrat — `props` et `actions`

```civet
// serve.server.mjs — dialecte Civet des composants
export default {
  props: {
    '/products/:id': (params, req) -> { id: params.id, name: 'Chair' }
  }
  actions: {
    '/products/:id': (params, body, req) ->
      if body.name is '' then { errors: { name: 'required' } }
      else { redirect: "/products/#{params.id}" }
  }
}
```

> ⚠️ Les accolades autour de `props` et `actions` ne sont pas décoratives : un hash Civet sans accolades portant deux clés fratries à valeurs multi-lignes compile en `{props: …}({actions: …})` — le premier objet « appelé » comme une fonction. Le chargeur reste alors inactif, sans un mot.

Deux tables, indexées par les mêmes **patterns de route** que `render.routes` et le routeur client (`:param` capturé, `(:opt)` segment facultatif, `*` sous-arbre — cf. [Router](17-router.md)) :

- **`props['<route>']`** — `(params, req) -> objet`, appelé sur un `GET` qui matche la route ; l'objet renvoyé rejoint la réponse de navigation. Un retour non-objet est **ignoré** (objet vide) plutôt que de casser la réponse.
- **`actions['<route>']`** — `(params, body, req) -> { redirect }` ou `{ errors }`, appelé sur un `POST` qui matche la route ; `redirect` produit le **303**, `errors` produit le **422** — fusionné dans les `props` rechargées de la page (cf. [Navigation](21-navigation.md) → *Le protocole serveur*). Une route sans `actions` déclarée répond **405**.

### `µ.version`

L'identifiant de build renvoyé dans `version`/`X-MJS-Version` est un hash de 8&nbsp;caractères hexadécimaux du contenu du manifest, calculé une fois et exposé sous `µ.version` — un décalage entre deux navigations dit qu'un rebuild a eu lieu pendant que l'onglet restait ouvert.

## 10. Journal d'erreurs — le bloc `journal`

`mjs dev` et `mjs serve` tiennent chacun un **journal d'erreurs** à trois étages, avec exactement les mêmes routes et les mêmes réglages&nbsp;: le serveur consigne ses propres accidents, un navigateur peut lui signaler les siens, et une page dédiée permet de consulter l'ensemble — sans base de données ni service externe, juste deux fichiers NDJSON à côté du projet.

```json
{
  "journal": {
    "server": true,
    "client": false,
    "viewer": true,
    "maxEntries": 200,
    "maxBytes": 1048576
  }
}
```

Les valeurs ci-dessus sont **les défauts**&nbsp;: un bloc `journal` absent de `mjs.config.json` produit exactement ce comportement. `server` (booléen, défaut `true`) coupe la capture serveur si passé à `false`&nbsp;; `client` (booléen, défaut `false`) ouvre le point d'entrée qui reçoit les erreurs envoyées par un navigateur&nbsp;; `viewer` (booléen ou chaîne, défaut `true`) contrôle qui peut consulter le journal, cf. l'étage&nbsp;3 ci-dessous&nbsp;; `maxEntries` (200) et `maxBytes` (1&nbsp;Mo) bornent chaque fichier. Comme le reste de `mjs.config.json`, ce bloc est validé strictement&nbsp;: une clé qui n'est pas parmi ces cinq, ou une valeur du mauvais type, est refusée avec une erreur explicite qui rappelle les clés attendues.

### Étage 1 — la capture serveur

Une erreur imprévue sur une requête, une exception levée par une action `.server.mjs`, un échec de rendu SSR, un échec de chargement du fichier `serve.server.mjs` lui-même, ou un chargeur de props qui casse pendant le rendu HTML d'une page&nbsp;: dans chacun de ces cas, la réponse HTTP habituelle part sans changement (500, page d'erreur…) et, en plus, l'incident s'écrit dans `log/mjs-errors-server.ndjson` à la racine du projet. Le journal observe la requête, il n'y participe jamais.

Un composant qui LÈVE sans qu'aucune frontière `<@failed>` (cf. [Éléments spéciaux](15-elements-speciaux.md)) n'absorbe l'erreur est lui aussi un échec de rendu&nbsp;: en moteur `browser`, une exception non interceptée venant du projet compte pareil qu'un crash rattrapé par le panneau fatal du framework. À la volée (`mjs serve`), la réponse part en 500&nbsp;; au prérendu (`mjs build`), la page part en échec, le fichier HTML périmé est supprimé et la commande sort avec un code de sortie différent de zéro. Poser un `<@failed>` sur un ancêtre du composant qui peut lever est la façon de garder la page servie malgré l'erreur, avec un rendu de repli affiché à la place du panneau fatal.

### Étage 2 — le canal navigateur

Le module optionnel `journal` (inclus par `runtime: [..., "journal"]`, ou par défaut avec `"all"`) pose côté client une veille sur les erreurs JS non interceptées, les promesses rejetées sans `.catch`, et les appels à `µ.error` (qui continue par ailleurs son travail habituel). Cette veille reste inerte tant que l'application ne met pas explicitement `µ.config.journal = true` — et même alors, le serveur doit *lui aussi* avoir `journal.client: true`&nbsp;: les deux portes s'ouvrent indépendamment, l'une sans l'autre ne laisse jamais rien fuiter. Une fois les deux ouvertes, chaque erreur détectée (au plus 20 par session de navigation, dédupliquée par signature&nbsp;: la même erreur répétée ne compte qu'une fois) part en un petit paquet plafonné à quelques Ko vers `/__mjs/errors`, via `sendBeacon` (repli automatique en `fetch`). Côté serveur, ce dépôt écrit dans `log/mjs-errors-client.ndjson`&nbsp;: le corps est plafonné, un seau à jetons par IP limite le débit, et tout ce que le navigateur prétend sur sa provenance est ignoré — la source enregistrée est toujours forcée à `"client"`.

### Étage 3 — la visionneuse

`GET /__mjs/errors` sert une petite page (un composant MJS compilé à la volée) qui liste les entrées des deux fichiers avec un filtre serveur/client, le détail de la pile par entrée, et des boutons de purge (serveur, client, ou tout). `GET /__mjs/errors.json` renvoie la même liste en JSON brut&nbsp;; `DELETE /__mjs/errors` purge. L'accès à ces trois routes dépend de `journal.viewer`&nbsp;: `true` (le défaut) ne les sert qu'en dehors de la production&nbsp;; une chaîne les transforme en jeton exigé en toute circonstance, développement compris (`?token=<jeton>`, comparé sans fuite de timing)&nbsp;; `false` les ferme complètement. Un accès refusé, quelle qu'en soit la raison, répond toujours par un 404 anodin, jamais par un 403 qui trahirait l'existence de la route.

Chaque entrée regroupe une **signature** d'erreur (même message, même pile, même URL) plutôt qu'une ligne par occurrence&nbsp;: une erreur qui se répète incrémente un compteur et met à jour sa date de dernière occurrence (et la version du build à ce moment-là), au lieu de faire grossir le fichier sans fin. Au-delà de `maxEntries`/`maxBytes`, l'entrée la plus ancienne (par date de dernière occurrence) est purgée pour faire de la place. L'écriture sur disque est atomique (fichier temporaire puis renommage) et regroupée&nbsp;: les écritures rapprochées patientent environ une seconde avant de s'exécuter, pour qu'une rafale d'erreurs ne déclenche pas une rafale d'écritures. Aucune opération du journal — enregistrer, lister, purger — ne peut faire planter le serveur qu'il surveille&nbsp;: une défaillance disque se traduit par un avertissement, jamais par une requête en échec. Le tampon en attente est vidé à la sortie normale du processus et sur un signal `SIGTERM` (l'arrêt d'un service via `systemctl stop`, par exemple)&nbsp;: redémarrer ou redéployer ne perd pas les dernières erreurs consignées.

**La version de build.** Chaque entrée porte l'identifiant du build en vigueur au moment de l'erreur — celui de la ligne `µ.version` du manifeste. Une erreur qu'on n'arrive plus à reproduire se lit donc avec la version qui l'a produite, et on voit tout de suite si elle vient d'un build périmé.

### `mjs dev` contre `mjs serve`

Les quatre routes, les cinq clés de config et les trois étages sont **identiques** dans les deux commandes. Ce qui diffère&nbsp;:

| Ce point | `mjs dev` | `mjs serve` |
|---|---|---|
| Port par défaut (clé `dev.port`) | 3939 | 3000 |
| Démarrage | fonctionne sans bloc `render` | exige un bloc `render`&nbsp;; refuse de démarrer sans lui |
| Journal disponible | seulement si un `mjs.config.json` a été trouvé (sinon aucune des quatre routes n'existe) | toujours |
| Capture serveur | le rendu de page | le rendu de page, **plus** les actions et les props des pages servies (module d'entrée `render.entry`, cf. §9) |

> 🔎 **Voir le journal en un clic.** `http://127.0.0.1:3939/__mjs/errors` en `mjs dev`, `http://127.0.0.1:3000/__mjs/errors` en `mjs serve`.

## Récapitulatif

| Besoin | API / mécanisme |
|---|---|
| Choisir le rendu par URL (sans code) | bloc `render` dans `mjs.config.json` : `default` + `routes[url] = { component, mode }` |
| Rendre un composant en HTML | `renderToString({ sourceDir, tag, … })` |
| Rendre plusieurs fois (1 compilation) | `createSSRRenderer({ sourceDir })` puis `.renderToString(tag, …)` |
| Données locales d'un composant | `props` → attribut (objets en JSON, auto-ré-hydratés) |
| État global partagé | `store` → `sharedScript` à placer une fois, réhydrate `$$` au boot |
| Stratégie de reprise en main | `ssrMode: 'replace'` (défaut) · `'markers'` · `'positional'` · `'diff'` |
| Mode du Shadow DOM | `shadowMode: 'open'` (défaut, requis pour la reprise en main) |
| Racine sans Shadow DOM | `light: true` — option de rendu, ou clé de route `render.routes[url].light` |
| Plafond d'attente du rendu | `settleMs` (défaut 1000 ms ; s'arrête dès que c'est stable) — surchargeable **par route** dans `render.routes` |
| Moteur de rendu | `render.engine.prerender` / `.request` : `'browser'` (Playwright) ou `'happy-dom'` — surchargeable **par route** |
| Pool de navigateurs (moteur `'browser'`) | `render.browserPool` : `size`, `keepAlive`, `maxAgeMs` |
| Origine + cookies transmis au SSR par requête | `render.forwardOrigin` : `false` / origine fixe (chaîne) / `{trustedHosts}` — défaut **sûr** (jamais dérivé du `Host` client) |
| Savoir si on rend côté serveur | `µserver` — vrai sur les deux moteurs, non réactif |

## Pièges

- **`happy-dom` manquant** → `renderToString` lève une erreur explicite. Installe-le (`npm i happy-dom`) ; c'est une dépendance du SSR uniquement (le moteur `'browser'` demande, lui, `npm i -D playwright`).
- **`sharedScript` placé après le bundle** → l'état global n'est pas réhydraté à temps. Mets-le **avant** le `<script>` du bundle.
- **Props ET store partagent la même limite JSON** (fonctions et classes disparaissent silencieusement, `Map`/`Set` deviennent `{}`, `Date` devient une chaîne) → ce qui doit survivre au rendu serveur doit être sérialisable en JSON, sinon ça se recalcule au montage côté client. Changer de portée (`props` → `store`) n'échappe pas à cette limite. Une référence circulaire n'est PAS silencieuse comme les cas ci-dessus : fournie par l'appelant (dans `props` ou dans `store`), elle fait lever `renderToString` ; seule une référence circulaire créée par le composant LUI-MÊME pendant son rendu (ex. une écriture réactive `$$a.self = $$a`) est écartée clé par clé, avec un avertissement dans `warnings` — les autres clés survivent.
- **Composant en `mjs-light`** → pas de Shadow DOM, donc pas de Declarative Shadow DOM : `html` contient le markup en clair (pas de `<template>`). Le SSR fonctionne, mais sans isolation shadow. Ce mode s'active **par instance**, indépendamment du SSR :
  ```html
  <@foo>                <!-- défaut : Shadow DOM -->
  <@foo mjs-light>      <!-- light DOM : rendu à plat, pas de <template shadowrootmode> -->
  ```
  ou, en dur sur la classe (utile quand l'attribut n'est pas lisible avant le constructeur, ex. certains harnais de test) : `static mjsLight = true`. Pour la RACINE d'une page rendue, c'est la clé de route `light` qui le demande (§7) — le mode se décide au constructeur, avant que l'attribut de la balise racine soit lisible. Conséquences : `<slot>` ne fonctionne pas en light DOM (API Shadow-DOM-only), le CSS scopé du composant est injecté une seule fois comme `<style>` dans `document.head` (au lieu d'`adoptedStyleSheets`, qui n'existe pas sur un élément sans shadow). `hydrateScript` (§1) reste également vide pour ce mode, quel que soit `ssrMode` : sans Shadow DOM, aucun mode d'hydratation n'a de nœud à reprendre en main.
- **Route paramétrée (`/produit/:id`) en `prerender`** → impossible au build (les valeurs de `:id` sont inconnues) : `mjs build` la signale et la saute. Passe-la en `mode: "ssr"` (rendu par requête).
- **Modules partagés de même nom** → aucun souci. En SSR, tout est évalué dans un seul contexte, mais chaque fichier (module **et** composant) est isolé dans sa **propre portée** — comme un vrai module ES : ses variables privées **et** ses exports lui restent locaux. Deux modules peuvent déclarer une variable ou exporter un nom identiques sans se télescoper ; chaque importateur reçoit l'export du module qu'il a réellement importé.

---

📚 **Pour aller plus loin** : la portée des données est détaillée dans [Props](04-props.md) (local) et [Stores](14-stores.md) (`$$` global) ; les blocs `{await}` dans [Blocs logiques](05-blocs.md).
