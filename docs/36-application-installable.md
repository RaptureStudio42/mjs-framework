# 36 · Rendre son application installable

> 📚 Pas de chapitre de tuto interactif dédié (le sujet vit hors de l'éditeur live du tuto — fichier de build, service worker, outils du navigateur) : cette page se suffit à elle-même.

## 1. Ce que le framework fait, et ce qu'il ne fait pas

**Il fait** : à chaque build réussi, écrire la liste complète de ce qu'il a émis — bundles JS, feuilles CSS, tout fichier haché — avec leurs empreintes, dans `<outputDir>/mjs-precache.json`, accompagnée de l'identifiant du build.

**Il ne fait pas** : fournir un service worker. Ce n'est pas une paresse, c'est un choix délibéré — les stratégies de cache (réseau d'abord, cache d'abord, quand vider) sont des décisions d'**application**, qui dépendent de ce que fait l'application : un site vitrine, une messagerie temps réel et un éditeur hors ligne n'ont pas la même réponse à « que faire si le réseau manque ? ». Un service worker imposé par un framework est un service worker qu'on finit par combattre.

Ce que l'auteur ne pourrait en revanche **pas deviner tout seul**, c'est la liste elle-même : les noms des fichiers émis par le build portent une empreinte (un hash) qui change à chaque build — impossible d'écrire en dur `main-a1b2c3d4.js` dans un service worker et d'espérer que ça survive au prochain déploiement. Cette liste-là, le build la connaît déjà en la produisant ; autant la lui faire écrire.

## 2. Le fichier `mjs-precache.json`

Sa forme exacte, écrite par `writePrecacheManifest()` à la fin d'un build :

```json
{
  "version": "a1b2c3d4",
  "assets": [
    "/modularjs/mjs_core-1a2b3c4d.js",
    "/modularjs/page-5e6f7a8b.js"
  ]
}
```

Quatre garanties, chacune vérifiée par un test dédié :

- la liste `assets` est **triée** — un diff git ne bouge pas d'une ligne pour rien d'un build à l'autre ;
- le fichier n'est **pas réécrit** quand son contenu ne change pas — un build sans rien de neuf ne salit pas l'arbre de travail ;
- un build en **échec** n'écrit aucune liste — mieux vaut pas de liste qu'une liste fausse ;
- `version` est exactement `µ.version`, l'identifiant du build (un hash hexadécimal de 8 caractères) : un service worker qui la compare à la sienne sait précisément quand vider son cache, sans deviner ni comparer des dates.

La liste couvre **tout** ce que le build a émis sous `outputDir`, les fichiers de page `mjs_page-<page>-<empreinte>.js` de [`render.startup: "bundle"`](32-cli-et-configuration.md#renderstartup) compris — ils sont assemblés après le reste, et la liste est republiée pour les y faire entrer. Un fichier que les pages d'entrée démarrent serait sinon le seul que le cache n'aurait pas.

## 3. La recette, en trois pièces

Rien de tout ceci n'est fourni par MJS : chaque ligne qui suit est un choix de l'auteur, pas une convention imposée. Voici la forme la plus simple qui tienne debout.

### Le manifeste web

`manifest.webmanifest` déclare le nom, les icônes, la couleur de thème et le mode d'affichage :

```json
{
  "name": "My App",
  "short_name": "App",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#111111",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

Déclaré dans le `<head>` — une balise que la navigation SPA de MJS ne touche jamais, elle ne fait pas partie du sous-ensemble piloté (voir [21 · Navigation](21-navigation.md)) :

```html
<link rel="manifest" href="/manifest.webmanifest">
```

### Le service worker

```js
const manifestUrl = '/mjs-precache.json'
const cachePrefix = 'mjs-'

async function sync() {
  const { version, assets } = await fetch(manifestUrl).then((res) => res.json())
  const cache = await caches.open(cachePrefix + version)
  await cache.addAll(assets)
  const names = await caches.keys()
  const stale = names.filter((name) => name.startsWith(cachePrefix) && name !== cachePrefix + version)
  await Promise.all(stale.map((name) => caches.delete(name)))
}

self.addEventListener('install', (event) => event.waitUntil(sync()))
self.addEventListener('activate', (event) => event.waitUntil(sync()))

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.mode === 'navigate') {
    event.waitUntil(sync())
    event.respondWith(fetch(request).catch(() => caches.match(request)))
    return
  }
  event.respondWith(caches.match(request).then((hit) => hit || fetch(request)))
})
```

`sync()` fait tout le travail utile : elle lit `mjs-precache.json`, ouvre un cache nommé `mjs-<version>`, y range tous les fichiers listés, puis supprime les caches des autres versions. Elle tourne à l'installation, à l'activation, et à **chaque navigation** — ce dernier appel est celui qui compte vraiment : `sw.js` lui-même ne change jamais d'un build à l'autre (ce n'est pas un fichier émis par le build, rien à y hacher), le navigateur ne le redétecte donc jamais comme « nouveau », et sans ce rappel à chaque navigation, ce service worker ne remarquerait jamais qu'un nouveau build existe.

Le gestionnaire `fetch` applique deux stratégies distinctes selon la requête : **réseau d'abord pour les navigations** (une page), **cache d'abord pour le reste** (les fichiers listés dans `mjs-precache.json`). La raison tient en une phrase : un fichier empreinté ne change **jamais** de contenu — seul son nom change à chaque build — alors qu'une page, elle, si.

### L'enregistrement

Deux lignes, côté page :

```html
<script>
  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('/sw.js')
</script>
```

## 4. Ce qui est particulier à MJS

**La navigation compare déjà les versions.** Le protocole de navigation du framework compare la version du bundle chargé à celle que porte chaque réponse, et recharge la page en entier dès qu'elles diffèrent (voir [21 · Navigation](21-navigation.md)). Un service worker qui servirait une ancienne page depuis son cache irait à l'encontre de ce mécanisme — deux systèmes qui décideraient chacun de leur côté ce qu'il faut afficher. C'est précisément pour ça que la stratégie ci-dessus garde les navigations **réseau d'abord** : c'est toujours la page la plus fraîche qui doit avoir le dernier mot, jamais une copie en cache.

**`µonline` existe déjà.** Une rune, un booléen réactif qui dit si le navigateur a du réseau — pas besoin d'écouter `online`/`offline` à la main. C'est avec elle qu'on affiche un bandeau ou qu'on désactive un bouton d'envoi :

```html
<button disabled={!µonline}>Envoyer</button>
{if not µonline}<span class="badge-offline">Hors ligne</span>{end}
```

**Prérendu contre rendu par requête.** Les pages du bloc `render` en mode `prerender` sont de vrais fichiers HTML, écrits sur disque au moment du build (voir [19 · SSR](19-ssr.md)) — mais elles ne figurent **pas** dans `mjs-precache.json` : leur nom n'est pas empreinté (`/` reste `/`, `blog` reste `blog.html`, d'un build à l'autre), la liste du build ne couvre que ses propres fichiers hachés. Ça ne change rien à la stratégie : une page prérendue reste une **page**, elle suit donc déjà la règle réseau d'abord ci-dessus, jamais la règle des fichiers empreintés. Les pages en mode `ssr` (rendues à la demande) ou `csr` (montées côté client) n'existent tout simplement pas comme fichiers : rien à précacher de ce côté, la navigation réseau d'abord les couvre déjà.

## 5. Vérifier que ça marche

Trois vérifications, dans les outils du navigateur :

1. **Onglet Application** — le manifeste apparaît (nom, icônes lues correctement), le service worker est actif, et le cache créé porte le nom `mjs-<version>` avec la liste attendue dedans.
2. **Mode hors ligne** — coche « Offline » dans le même onglet, recharge : la page s'affiche depuis le cache, `µonline` passe à `false`, le bandeau ou le bouton réagit.
3. **Purge au nouveau build** — relance un build, puis recharge la page une fois (une seule suffit avec la recette ci-dessus, qui se resynchronise à chaque navigation plutôt que d'attendre que le navigateur détecte un `sw.js` modifié — lui ne change jamais) : dans l'onglet Application, l'ancien cache `mjs-<ancienne-version>` a disparu, seul le nouveau reste.

---

📚 **Voir aussi** : [21 · Navigation](21-navigation.md) pour le mécanisme qui recharge la page quand la version du bundle a changé ; [19 · SSR](19-ssr.md) pour la différence entre pages prérendues, `ssr` et `csr` ; [3 · Réactivité](03-reactivite.md) pour `µonline`/`µvisible`/`µready`.
