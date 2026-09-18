# 14 · Stores

> 📚 Tuto interactif correspondant : **ModularJS Avancé → Stores**. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Quand un état doit être partagé entre **plusieurs composants éloignés** (sans relation parent/enfant), le faire remonter/redescendre par props devient fastidieux. Un *store* est un conteneur d'état **global**, déclaré une fois dans un fichier dédié et consommable depuis n'importe quel composant.

MJS offre deux mécanismes, du plus léger au plus structuré : le **symbole store `µ$$`** et la **classe `µStore`** (importée et consommée, elle aussi, avec `µ$$`). Tous deux s'appuient sur le même moteur de réactivité universelle — toute mutation re-rend automatiquement les composants qui lisent la donnée.

## 1. Symbole store léger — `µ$$`

Le plus simple : une valeur ordinaire préfixée par `µ$$`, exportée depuis un module.

> 🔤 **Syntaxe.** Le store double le `$` de la variable réactive : `$x` (variable) → `$$x` (store). On écrit `µ$$x` en module externe (le `µ` = « on invoque le framework », comme `µ$x` pour les variables), et `$$x` nu en script/template de composant. Tout est en **ASCII** (clavier sans touche exotique).

```html
# tuto_count_shared.module.civet — le store, dans son fichier dédié
export µ$$count = { value: 0 }
```

On l'importe via `@import µ$$count` (le module, lui, **déclare/exporte** avec ce même symbole), puis on le **consomme dans le composant via ce même `µ$$count`** — on le lit et le mute **directement** :

```html
@import µ$$count 'tuto/10/10-5/tuto_count_shared.module.civet'

<button @click={µ$$count.value++}>
  clics : {µ$$count.value}
</button>
```

Trois `<@tuto-counter>` qui importent ce module partagent **la même valeur** : cliquer sur l'un incrémente le compteur de tous, parce qu'ils lisent et écrivent dans le même singleton.

> ⚠️ **Un seul symbole, un seul rôle** : le module **déclare** le store avec `µ$$count` (le `µ` = « on invoque le framework »), et le composant l'**importe et le consomme** avec ce **même** `µ$$count` — symétrie totale entre déclaration, import et usage. L'ancienne forme `@import §§count` lève une **erreur de compilation** explicite qui oriente vers `@import µ$$count` ; `@import $count` (dollar simple) est pareillement rejeté à la compilation ; consommer le singleton importé via `$count`, `$$count` ou `§§count` est également une erreur (seul `µ$$count` est valide). Ne confonds pas `§` (contexte d'arbre, non réactif), `§§` (contexte réactif de sous-arbre — jamais un import) et `µ$$` (déclaration, import et consommation d'un singleton, un seul et même symbole). Le store **zéro-import** `$$x` (→ `µ.store.x`) est une autre voie, sans `@import` ni `export`.

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi un fichier séparé&nbsp;?</summary>

Un store doit être **une seule et même valeur** pour tous les composants qui le partagent. En le mettant dans un module à part et en l'`export`-ant, le système de modules garantit qu'il n'est créé **qu'une fois** : chaque `@import` pointe vers la même instance. Si tu déclarais `µ$$count` à l'intérieur d'un composant, chaque instance du composant aurait *son propre* compteur — l'inverse de ce qu'on veut.

</details>

## 2. Classe `µStore` — état structuré, consommé via `µ$$`

Pour un état plus riche (plusieurs champs, objets imbriqués, méthodes intégrées), on instancie la classe `µStore` (alias `µ.Store`). On l'`export`-e depuis un module, et on accède à son contenu via la propriété **`.data`** (un proxy réactif) :

```html
# stores/feed.mjs
export feedStore = new µStore(version: 0)
```

```html
# stores/page.mjs — un store « page » maison
export pageStore = new µStore(url: window.location, params: {})

window.addEventListener 'popstate', ->
  pageStore.data.url = new URL(window.location)
```

Côté composant, on importe le store avec `@import µ$$feed 'chemin'` — le **même** symbole que le singleton léger — puis on lit/écrit ses champs directement avec `µ$$feed` :

```html
@import µ$$feed 'stores/feed.mjs'

<script>
  µ$$feed.version    # lu → dépendance enregistrée, le composant re-rend si version change
  µ$$feed.version++  # écrit → tous les abonnés à cette clé sont invalidés
</script>
```

```html
# déclarer un CONTEXTE partagé directement à la racine de l'appli (sans module ni `new µStore`), lu par tout composant descendant — ceci reste `§§`, ce n'est PAS un import :
§§cfg = await fetch('/api/config').then (r)-> r.json()
```

Tout champ lu via `µ$$feed.x` enregistre le composant comme abonné à la clé `x` ; toute écriture `µ$$feed.x = …` (ou mutation d'un tableau/Map/Set, ou `++`) notifie précisément les abonnés de cette clé.

> ⚠️ **`§§` n'est jamais un « global ».** Le symbole `§§` est, sans exception, un **contexte réactif de sous-arbre** (même mécanisme que `§`, en réactif — chapitre [Contexte](13-contexte.md)) : deux composants sans ancêtre commun déclarant `§§clé` ne partagent **rien**. Ni le singleton léger du §1, ni une instance `µStore` importée, ne passent par `§§` : les deux s'importent et se consomment avec le **même** symbole `µ$$` (`@import µ$$feed 'chemin'` → `µ$$feed.version`), qu'ils viennent d'un `export µ$$X = …` ou d'un `export feedStore = new µStore(…)`. `§§` reste réservé à la déclaration/lecture de contexte (`§§clé = valeur` posé par un ancêtre, lu par ses descendants) — y compris la variante « racine d'appli » vue plus haut (`§§cfg`), qui n'est jamais un import.

### Méthodes et collections

`.data` enveloppe récursivement les objets imbriqués, et intercepte les **mutateurs** des collections natives (`push`, `pop`, `splice`, `shift`, `unshift`, `sort`, `reverse` sur les tableaux ; `set`, `add`, `delete`, `clear` sur `Map`/`Set` ; les `setX` des `Date`). Muter une collection du store via ces méthodes notifie donc les abonnés, sans réaffectation.

```html
# layout.mjs — état de session chargé au montage, lisible par toutes les pages
@import sessionStore './stores/session.mjs'

<script>
  µmount ->
    res = await fetch('/api/me')
    sessionStore.data.user = await res.json()
</script>
```

> ⚠️ Comme partout ailleurs dans un composant MJS, l'import se fait par la directive **`@import nom 'chemin'`**, au niveau **racine** du fichier (hors `<script>`) — jamais `import … from` JavaScript, qui est une erreur de compilation (cf. [Anatomie d'un composant](02-composant.md)).

> ⚠️ Une clé **ajoutée après construction** (`store.data.nouvelle = x`) est réactive (le registre d'abonnés est créé à la volée). Mais déclarer dès le départ les champs connus dans le constructeur reste plus lisible et évite les surprises.

<details>
<summary>🎓 <b>Pour débutants</b> — <code>µ$$</code> ou <code>µStore</code>&nbsp;?</summary>

- `µ$$` : la valeur la plus simple possible, partagée. Parfait pour un compteur, un drapeau, une petite donnée. On la lit/mute directement (`µ$$count.value++`).
- `µStore` : une classe pour de l'état structuré — plusieurs champs, objets imbriqués, abonnement *par champ* (un composant qui ne lit que `µ$$feed.version` ne re-rend pas si une autre clé change). À privilégier pour le vrai état d'application (session, panier, page).

Les deux sont des sources de vérité globales ; choisis selon la richesse de la donnée.

</details>

## Sous le capot depuis la statisation

Le store zéro-import (`$$x` → `µ.store.x`, cf. §1) est **dispatché finement, clé par clé** : un
composant qui lit `$$score` ne se re-rend **que** quand la clé `score` change — jamais quand une **autre**
clé du store est mutée à côté (`$$autreChose`, par exemple). Fini le re-rendu global qu'un store
générique imposerait à tous ses lecteurs.

Accès **non réactif** : `µread $$x` (lecture brute, n'enregistre aucun abonnement) et
`µwrite $$x, v` (écriture brute, ne notifie personne) — utiles pour poser une valeur de départ ou
lire ponctuellement sans provoquer de re-rendu.

> ⚠️ **Règle d'aliasing.** Une mutation écrite **en clair** sur `$$obj.a.b` est suivie, **même** via un
> alias local direct assigné dans le même bloc (`sous = $$obj.a` puis `sous.b = 5` reste tracké et
> notifie). Mais dès que la référence traverse la frontière d'un **appel de fonction** (le
> sous-objet du store passé en argument à une fonction qui le mute de son côté), plus rien ne
> notifie : le store n'a pas de filet de rattrapage à l'exécution (contrairement à l'état local
> d'un composant, qui en a un).
>
> ```civet
> # NOTIFIE : mutation écrite en clair, la clé racine 'panier' est suivie
> $$panier.articles.push(article)
>
> # NE NOTIFIE PAS : la mutation a lieu DANS une fonction, sur un simple paramètre
> ajouterArticle = (liste, item)-> liste.push(item)
> ajouterArticle($$panier.articles, article)   # panier réellement muté, mais aucun re-rendu
> ```
>
> La voie sûre : muter `$$obj.a` en clair, à l'endroit même où c'est lu — jamais passer un
> sous-objet du store à une fonction qui le mute de son côté.

> ⚠️ **Ne jamais `Object.assign` un JSON externe dans un store.** `Object.assign($$cfg, JSON.parse(texte))` échappe à toute garde : une clé `__proto__` dans le JSON remplace le prototype de `$$cfg` lui-même. Écris les clés une par une, ou filtre-les avant de les copier.

## Ne pas exporter de `$foo` réactif

Les variables réactives d'instance (`$foo`) sont liées à **une instance** d'un composant, pas au module : ne les `export`-e pas pour faire du partage d'état. Pour partager, utilise un `µ$$`, un `µStore`, ou un `§` contexte selon la portée voulue.

## Lire une clé que le serveur n'a peut-être pas garnie

Le store zéro-import `$$x` (→ `µ.store.x`) se remplit typiquement au boot depuis la balise
`<script type="application/json" id="__mjs_store">` (cf. [SSR](19-ssr.md#2-bis-poser-la-balise-soi-même-sans-ssr) —
fonctionne aussi **sans SSR**, une appli Rails classique peut la poser à la main). Cette fusion a
lieu **avant que le moindre composant ne monte** : aucune déclaration n'est nécessaire nulle part,
`$$me` et `$$settings` sont lisibles depuis n'importe quel module dès la première ligne.

Une clé que le serveur n'a pas envoyée vaut `undefined`, et `$$settings.theme` lève alors une vraie
erreur. C'est le comportement voulu : mieux vaut planter franchement que rendre une page à moitié
garnie sur des données absentes. La parade est **au point de lecture**, avec l'accès optionnel :

```html
<p>Thème : {$$settings?.theme ?? 'clair'}</p>
<p>Bonjour {$$me?.pseudo}</p>
```

Les trois situations où une clé manque, et où l'accès optionnel s'impose :

- le composant est ouvert **hors du serveur** qui pose la balise — aperçu de tutoriel, banc, page
  d'essai ;
- la page est **prérendue** puis servie en fichier figé, sans application derrière ;
- le serveur **rend la page pour un visiteur non connecté** : l'utilisateur courant est nul, la clé
  n'est pas émise.

## Récapitulatif des symboles partagés

| Forme | Mécanisme | Déclaration | Consommation |
|---|---|---|---|
| `µ$$x` | Symbole store léger (valeur unique partagée) | `export µ$$x = …` dans un module | `µ$$x` (lecture/écriture directes) |
| `µStore` / `µ.Store` | Classe d'état structuré | `export s = new µStore({…})` | `µ$$x` (après import, lecture/écriture des champs) |
| `§§x` | Symbole de lecture/écriture réactive — contexte de sous-arbre, toujours (cf. [Contexte](13-contexte.md)) ; jamais un import de singleton, ni léger ni `µStore` (voir `µ$$x` ci-dessus) | `§§x = …` (déclaré par un ancêtre) | `§§x` (lecture = abonnement, écriture = invalidation) |

> 🔗 À ne pas confondre avec `§` (contexte d'arbre, scopé à un ancêtre — chapitre [Contexte](13-contexte.md)) ni avec `µ$` (variable réactive universelle, même moteur que `µ$$` mais sémantique « variable » et non « store »).

---

📚 **Apprendre en pratiquant** : ce chapitre correspond à la section **Stores** du tuto interactif (chapitre *ModularJS Avancé*) — plusieurs composants partageant un même compteur via un module dédié.
