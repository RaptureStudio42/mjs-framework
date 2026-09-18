# 34 · Déboguer une application

> 📚 Pas de leçon de tuto interactive dédiée : cette page se suffit à elle-même.

Le reste de cette documentation montre comment écrire une application MJS ; ce chapitre montre comment regarder à l'intérieur pendant qu'elle tourne, dans la page, en développement.

## 1. Le panneau d'inspection

**Ouverture** : `Ctrl+Shift+Espace` dans la page — une combinaison qu'aucun navigateur ne reprend nativement, donc sans conflit de raccourci — ou `µ.devPanel()` depuis la console. La fonction **bascule** : elle ouvre si le panneau est fermé, ferme s'il est ouvert, et renvoie l'état obtenu (`true` : ouvert, `false` : fermé). Pour lever l'ambiguïté, `µ.devPanel(true)` ouvre et `µ.devPanel(false)` ferme, quel que soit l'état de départ. Une **chaîne** ouvre le panneau (si besoin) et sélectionne directement le premier composant que ce sélecteur CSS désigne dans l'arbre — pratique pour isoler en un seul appel le composant qu'on veut inspecter, même caché derrière plusieurs frontières Shadow DOM.

```js
µ.devPanel()             // bascule
µ.devPanel(true)         // ouvre, sans ambiguïté
µ.devPanel(false)        // ferme, sans ambiguïté
µ.devPanel('.panier')    // ouvre et sélectionne le premier composant qui correspond au sélecteur
```

`µ.devObject(valeur, nom?)` ouvre le panneau (si besoin) directement sur l'**inspecteur d'objets générique** — la même vue que l'onglet État utilise pour une valeur composée, mais sur n'importe quelle valeur choisie à la main, sans passer par un composant : `µ.devObject($$panier)` depuis la console. `nom` sert de titre au bloc ouvert ; sans lui, le panneau déduit un libellé du type de la valeur (`Array(3)`, `Objet Panier`…).

Le raccourci se change avec `µ.config.devPanelKey` : une valeur d'`e.code`, le code **physique** de la touche, jamais la lettre qu'elle produit — comparée seulement quand `Ctrl` et `Shift` sont maintenus. Sans réglage, la touche vaut `'Space'`.

```js
µ.config.devPanelKey = 'KeyD'   // Ctrl+Shift+D, à la place de Ctrl+Shift+Espace
```

### Absent des builds de production

Le panneau n'existe pas dans un bundle de production : le compilateur n'ajoute son fichier qu'aux builds **non-prod** — exactement la même règle que pour le module d'inspection de console (§2), les deux sont embarqués ensemble. Ce n'est pas un garde qui s'active à l'exécution : c'est une **absence**. Le code n'est simplement pas dans ce qui part chez qui déploie — zéro poids, zéro coût. Un test le verrouille : il cherche `µ.devPanel` dans un bundle compilé en production, et vérifie qu'il n'y est pas.

Ce qui fait qu'un build est « de production », c'est le drapeau `--prod` de la commande : `mjs build` construit en développement, `mjs build --prod` en production (`mjs dev --prod` pour reproduire en local un bogue qui ne sort qu'en production). Rien d'autre n'entre dans ce choix — ni fichier de config, ni variable d'environnement. **`minify` n'y entre pas non plus** : un projet peut demander un bundle compact en développement sans perdre le panneau. Chaque build annonce en clair le mode retenu, et d'où il vient.

Cette indifférence à l'environnement ne vaut que pour ce choix de build — la garde des deux routes de l'atelier de variables de thème (§ *L'atelier des variables de thème* plus bas) accepte, elle, `NODE_ENV=production` comme second signal, en plus de `--prod`.

Même règle pour un bundle réduit au strict `"core"` (aucun module optionnel embarqué, cf. [22 · Aide-mémoire](22-aide-memoire.md)) : ni le panneau ni le module de console n'y figurent, en développement comme en production.

### Ce qu'il montre

Le panneau s'ouvre **ancré en bas de la fenêtre**, sur toute la largeur, comme la console d'un navigateur : la page reste visible et cliquable au-dessus — indispensable, puisque survoler une ligne de l'arbre **encadre le composant correspondant dans la page**.

**Ancré, il rend sa place à la page.** La console d'un navigateur rétrécit le viewport lui-même ; aucun script d'une page ne peut faire ça. Le panneau fait donc les deux gestes qui restent, et ils couvrent les deux mises en page possibles :

- il pose un **`padding-bottom`** de sa hauteur sur l'élément qui défile — une page qui défile au document gagne exactement la course qu'il lui prend, et son bas redevient atteignable ;
- il pose **`--mjs-devpanel-h`** sur `<html>` (plus l'attribut `data-mjs-devpanel-dock`), pour les mises en page **à hauteur de fenêtre** — celles-là ne défilent pas, elles sont simplement coupées, et aucun padding n'y peut rien. Une ligne suffit à s'y accrocher :

```sass
:host
  height: calc(100vh - var(--mjs-devpanel-h, 0px))   // rétrécit quand le panneau est ancré, 100vh sinon
```

La variable disparaît dès que le panneau est détaché ou fermé ; le repli `0px` fait que la règle vaut `100vh` le reste du temps. Un élément de la page en `position: fixed` collé en bas reste, lui, couvert — rien ne peut l'en sortir depuis un script.

**Ce qu'on tape n'est pas emporté par le rafraîchissement.** Le panneau se redessine deux fois par seconde environ pour suivre la page ; il **passe son tour** tant que le focus est dans un de ses champs — sans quoi la valeur d'état qu'on est en train de saisir disparaîtrait sous les doigts. Le rafraîchissement reprend dès qu'on quitte le champ. Le défilement de l'arbre, lui, est conservé d'un rendu à l'autre.

Le bandeau du haut affiche le nombre de composants actuellement montés dans la page (« 2 composants montés », par exemple), et quatre boutons : « clignoter au rendu », « rafraîchir », « détacher », « fermer ». Le panneau se redessine de lui-même toutes les 700 ms ; le bouton « rafraîchir » force une repasse immédiate.

**Le déplacer, le redimensionner.** Tirer le **bord supérieur** change sa hauteur. Tirer le **bandeau** le décroche et le transforme en fenêtre libre, qu'on repositionne à volonté et qu'on redimensionne par la poignée du coin bas-droit ; « ancrer en bas » le remet en place. La géométrie choisie est retenue d'une ouverture à l'autre (stockage local du navigateur) — et retombe sur l'ancrage par défaut si ce stockage est indisponible.

À gauche, l'**arbre des composants réellement montés** — pas la hiérarchie des balises source, celle des instances vivantes. Un composant enfant apparaît sous son parent même si une frontière Shadow DOM les sépare : le panneau la franchit pour reconstituer l'arbre réel. Chaque ligne porte aussi le nombre de rendus du composant depuis son montage.

À droite, une fois un composant choisi dans l'arbre, quatre blocs :

- **État** — les variables `$x` propres au composant (les dérivés sont exclus, listés à part, de même que les clés internes du framework) ;
- **Dérivés et leurs dépendances** — chaque dérivé, sa valeur, et la liste des `$` dont il dépend ;
- **Ce que chaque variable met à jour** — pour chaque variable d'état, le nombre de liaisons (bindings du HTML) qu'elle déclenche quand elle change ;
- **Contexte** — les valeurs posées via le symbole `§` que ce composant a reçues.

**Le point qui compte** : les dépendances affichées sous « Dérivés et leurs dépendances » ne sont pas devinées à l'exécution, elles viennent du **compilateur**. La réactivité de MJS étant résolue à la compilation, chaque composant embarque déjà son graphe de dépendances. Le panneau ne fait que l'afficher — il répond donc à la seule question qui compte quand un écran reste figé : *de quoi ce dérivé dépend-il, et la variable que je change en fait-elle partie ?*

```html
<script>
  computeTotal = -> $price * $quantity
  µderived $total = computeTotal(), $price, $quantity
</script>
<p>{$total}</p>
```

Sélectionner ce composant dans le panneau affiche, sous « Dérivés et leurs dépendances » : `$total ← $price, $quantity`. `computeTotal()` cache `$price`/`$quantity` dans une fonction appelée — une dérivation automatique ne les verrait pas — mais `µderived` les déclare explicitement ; c'est justement le cas que couvre [3 · Réactivité](03-reactivite.md).

Survoler une ligne de l'arbre **situe le composant dans la page** : un cadre le surligne, sans toucher à son style à lui.

Les valeurs d'état **scalaires** (texte, nombre, booléen, `null`) sont modifiables directement dans le panneau — de quoi essayer un cas sans toucher au code. Écrire une valeur et valider met vraiment à jour l'état du composant, avec les mêmes conséquences qu'un changement fait depuis le code : les dérivés qui en dépendent se recalculent. Les valeurs non scalaires (objets, tableaux, fonctions) restent en lecture seule, affichées en aperçu.

Le bouton « clignoter au rendu » bascule `µ.debugMode` — la télémétrie visuelle décrite au §2 : chaque composant qui se re-rend s'éclaire un instant.

## 2. Les outils de console

Quatre outils, dont trois sont définis dans le même module que le panneau — donc soumis à la même règle : absents d'un bundle de production, ou d'un bundle réduit au strict `"core"`.

- **`µ.instances`** — un `Set` qui recense les instances de composants MJS connectées à la page, mis à jour à chaque connexion et déconnexion. C'est le registre que le panneau lit pour construire son arbre.
- **`µ.debugMode`** — booléen, `false` par défaut. À `true`, chaque composant qui se re-rend est brièvement entouré (un contour vert, environ 300&nbsp;ms) — le repère à l'œil pour les rendus superflus. Se bascule depuis la console (`µ.debugMode = true`) ou depuis le bouton « clignoter au rendu » du panneau.
- **L'afficheur maison des éléments `<mjs-…>`** — dans les DevTools du navigateur, `console.log(el)` sur une instance de composant MJS déplie directement son état réactif, ses nœuds DOM référencés et ses props/masques, plutôt qu'un objet DOM générique à explorer à la main.

Le quatrième, **`µ.debug`**, est différent : il vit dans le cœur du framework, donc il est présent dans **tous** les builds, production comprise. À `false` par défaut. Voir « Le niveau de la console » ci-dessous : il force le réglage le plus bavard, quel que soit ce qui est configuré.

### Le niveau de la console (`logLevel`)

`µ.log`, `µ.warn` et `µ.error` consultent un **niveau effectif**, du plus bavard au plus muet : `'log'` (tout) → `'warn'` (avertissements et erreurs) → `'error'` (erreurs seules) → `'silent'` (rien). Ce niveau vient de la clé `logLevel` de `mjs.config.json` (cf. [32 · CLI & configuration](32-cli-et-configuration.md)) — un par environnement, défauts `dev` → `'log'`, `prod` → `'warn'`.

**`µ.debug = true`**, posé à la main dans la console, **force le niveau `'log'`** — tout redevient visible, quel que soit le réglage de `logLevel`. C'est l'échappatoire de mise au point. Elle ne sert toutefois à rien sur un site déployé en production : `window.µ` n'y est pas exposé, il n'existe pas de `µ` à atteindre depuis la console.

En production, un niveau plus strict que `'warn'` retire aussi les appels correspondants **du bundle lui-même** (`console.warn`/`µ.warn` disparaissent au niveau `'error'`, `console.error`/`µ.error` s'y ajoutent au niveau `'silent'`) — pas seulement une case masquée à l'exécution : du poids en moins dans ce qui part chez qui déploie.

Le chapitre [18 · Pièges](18-pieges.md) (§8) documente deux outils compagnons, `µdebug $x` et `µinspect $x` — des directives compilées à l'intérieur d'un composant, pas des fonctions à taper dans la console : ils ne sont pas repris ici.

## 3. Les deux autres visionneuses

Deux autres pages, servies aussi bien par `mjs dev` que par `mjs serve`, complètent le panneau — chacune sur son propre sujet, hors de la page en cours d'inspection :

- Le **journal d'erreurs** (`GET /__mjs/errors`) liste les erreurs serveur et client consignées par l'application. Détail complet : [19 · SSR](19-ssr.md).
- L'**atelier des variables de thème** (`GET /__mjs/theme`) affiche le registre de toutes les variables de thème du projet — qui déclare quoi, qui la lit, où c'est redéclaré. Détail complet : [31 · Thèmes, variables & variants](31-themes.md).

## 4. Quand le panneau ne suffit pas

Le panneau montre l'**état** — ce que le composant sait. Il ne montre pas le **rendu** — ce que l'écran affiche. Pour une mise en page qui déborde, une transition qui saccade ou une mesure de performance, l'outil qui compte est l'inspecteur du navigateur lui-même : ses onglets Éléments, Animations, Performance en disent plus sur ce qui se **voit** que n'importe quelle vue de l'état.

Et pour ce qu'aucun outil ne montre — une erreur de conception plutôt qu'un bug ponctuel — le chapitre [18 · Pièges](18-pieges.md) reste la référence.

---

📚 **Voir aussi** : [3 · Réactivité](03-reactivite.md) pour `µderived` — la dépendance qui ne se voit pas dans le texte, justement ce que le panneau révèle ; [18 · Pièges](18-pieges.md) pour `µdebug`/`µinspect` (§8) et les erreurs de conception qu'aucun outil ne montre ; [19 · SSR](19-ssr.md) pour le journal d'erreurs à trois étages ; [31 · Thèmes, variables & variants](31-themes.md) pour l'atelier des variables de thème ; [32 · CLI & configuration](32-cli-et-configuration.md) pour la clé `logLevel`.
