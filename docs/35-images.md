# 35 · Images (`µimage` & `<@img>`)

> 📚 Leçon de tuto associée : [Images optimisées (<@img> et µimage)](/tuto#/images).

Sans rien faire, un téléphone télécharge la photo de 1920 pixels pour l'afficher dans 380 — quatre fois trop d'octets, sur la connexion la plus lente. Et une image sans dimensions déclarées fait **sauter la mise en page** dès qu'elle arrive : le navigateur ne connaît sa hauteur qu'après le premier octet de pixels, tout ce qui suit dans la page se décale au moment où elle apparaît. `µimage` et la forme courte `<@img src="…">` répondent aux deux problèmes au **build**, jamais à l'exécution.

## `<@img src="…">` — la forme courte, résolue au build

```html
<@img src="hero.jpg" alt="Description utile">
```

Un `src` écrit en dur (chaîne entre guillemets, chemin relatif à `sourceDir`) est résolu au build comme un `µimage('hero.jpg')` : le fichier est lu, ses dimensions natives et ses variantes calculées, et la balise ressort complète :

```html
<@img src="/assets/hero-3f2a91c8.jpg" srcset="/assets/hero-480-….webp 480w, …" sizes="100vw" width="1920" height="800" alt="Description utile">
```

- **Un attribut écrit à la main garde la main** : `sizes`, `width`, `height` ou `srcset` posés par l'auteur ne sont jamais remplacés — seuls les attributs absents sont remplis.
- **`widths="320 640"`** (espaces ou virgules) choisit les largeurs de variantes pour cette image seule, comme les largeurs littérales de `µimage` ; l'attribut ne survit pas dans le HTML émis.
- **Rien n'est résolu** pour un `src={…}` dynamique, un chemin absolu (`/images/x.png`, servi par le serveur) ou une URL (`https://…`, `data:`) : la balise passe telle quelle.
- **Fichier introuvable = build en échec**, en nommant la balise et le chemin — même contrat que `µimage` et `µasset`.
- **L'image est suivie comme dépendance** : la modifier recompile le composant.
- **Un `widths` calculé** (`widths={$w}`), ou un `src`/`widths` écrit **deux fois** sur la même balise, fait échouer le build : ces deux formes ne se résolvent pas au build, et rien ne disparaît en silence.

`µimage` garde sa place quand une résolution sert à plusieurs endroits (une vignette et son agrandissement), quand on affiche ses valeurs (`{photo.width} × {photo.height}`, le `srcset` produit), ou sur un `<img>` natif.

## `µimage('chemin'[, largeur…])`

```html
<script>
  photo = µimage('hero.jpg')
  vignette = µimage('hero.jpg', 320, 640)
</script>

<img src={photo.src} srcset={photo.srcset} sizes={photo.sizes} width={photo.width} height={photo.height} alt="Description utile">
```

L'appel est résolu au **build** et remplacé par un objet littéral — `{ src, srcset, sizes, width, height }` — le compilateur ne voit jamais un appel de fonction dans le code émis. Mêmes règles d'écriture que `µasset('…')` (cf. [15 · Éléments spéciaux](15-elements-speciaux.md)) : le chemin est un **littéral chaîne écrit en dur**, relatif à `sourceDir`, résolu au build — jamais une variable. Les largeurs, elles aussi littérales, sont facultatives et entières (`µimage('hero.jpg', 480, 960)`). Alias tolérés : `µ.image`, `mjsimage`, `mjs.image`.

Deux appels au **même fichier** avec des largeurs différentes sont deux entrées distinctes — chacune résolue et indexée séparément par le texte exact de l'appel.

## Deux niveaux, délibérément séparés

### 1. Les dimensions natives — sans aucune dépendance

La largeur et la hauteur natives sont lues directement dans l'**en-tête** du fichier, sans décoder la moindre image : PNG, JPEG, GIF, WebP (VP8/VP8L/VP8X), AVIF/HEIC (bloc `ispe` de l'ISOBMFF), et le SVG par ses attributs `width`/`height` ou, à défaut, son `viewBox`. Cette lecture ne lève jamais — un format inconnu rend simplement `null`, `width`/`height` valent alors `null` dans l'objet résolu. C'est ce niveau, universel, qui **supprime le saut de mise en page** : le gain le plus visible, et il marche chez tout le monde, aucune dépendance à installer.

### 2. Les variantes — qui exigent `sharp`, dépendance optionnelle

Produire plusieurs largeurs et des formats modernes (webp, avif…) demande un vrai encodeur d'images : `sharp`. C'est une dépendance **optionnelle**, jamais celle du framework — installée, elle vit dans le `node_modules` du **projet** :

```
npm i -D sharp
```

Absente, `µimage` ne casse jamais le build : l'image d'origine passe telle quelle (`srcset` vide, `src` seul), et un avertissement **unique** (une seule fois par build, quel que soit le nombre d'images concernées) le rappelle en console :

> `[bundler] µimage : 'sharp' n'est pas installé — les images passent telles quelles, sans variantes de largeur. Les dimensions natives, elles, sont bien écrites (pas de saut de mise en page). Pour produire les variantes : npm i -D sharp`

Même patron que le moteur de rendu `browser` (Playwright, cf. [19 · SSR](19-ssr.md)) : un poste qui ne peut pas compiler un binaire natif n'a jamais un build cassé pour autant.

## Les règles exactes

- **Jamais d'agrandissement** : une largeur demandée plus grande que l'original est écartée avant même d'appeler `sharp` — une variante plus large que la source n'apporterait rien.
- **Le SVG n'est jamais redimensionné** : une seule ressource, `srcset` reste vide — un vectoriel s'adapte tout seul à n'importe quelle taille d'affichage.
- **`src` reste toujours l'image d'origine**, même quand des variantes existent : c'est le repli d'un navigateur qui ne comprendrait pas `srcset`.
- **Une image introuvable fait ÉCHOUER le build**, en nommant le fichier fautif — même contrat qu'un `µasset` absent : jamais un chemin cassé qui part en production.
- **L'image est suivie comme dépendance** : la modifier (même en gardant le même nom de fichier) invalide et recompile tout composant qui l'utilise, exactement comme un `.civet` importé.

## Le bloc de configuration `image`

| Clé | Type | Défaut | Rôle |
|---|---|---|---|
| `widths` | tableau d'entiers ≥ 1 | `[480, 960, 1920]` | largeurs de variantes à produire (bornées par `sharp`, jamais au-delà de la largeur native) |
| `formats` | tableau parmi `avif`/`webp`/`jpeg`/`png` | `['webp']` | formats de variantes à produire |
| `quality` | entier 1-100 | `78` | qualité d'encodage transmise à `sharp` |

```json
{
  "image": { "widths": [320, 640, 1280], "formats": ["avif", "webp"], "quality": 80 }
}
```

Validation **stricte**, comme le reste de `mjs.config.json` (cf. [32 · CLI & configuration](32-cli-et-configuration.md)) : une clé hors `widths`/`formats`/`quality`, une largeur qui n'est pas un entier ≥ 1, un format hors liste ou une qualité hors 1-100 font échouer le build avec un message qui nomme la valeur reçue. Un appel `µimage('chemin', 320, 640)` avec des largeurs **explicites** ignore `image.widths` pour cet appel précis — les largeurs littérales de l'appel priment.

Une variante émise porte un nom haché — `hero-960-3f2a91c8.webp` (`<base>-<largeur>-<empreinte>.<format>`) — et son `srcset` liste chaque largeur produite (`960w`) ; `sizes` vaut `100vw` dès qu'au moins une variante existe, chaîne vide sinon (SVG, `sharp` absent, ou toutes les largeurs demandées supérieures à l'original).

## Le module cœur `<@img>`

Forme courte, `src` littéral résolu au build (cf. plus haut) :

```html
<@img src="hero.jpg" alt="Description utile">
```

Forme longue, appuyée sur un `µimage('chemin')` déjà résolu :

```html
<@img src={$photo.src} srcset={$photo.srcset} sizes={$photo.sizes} width={$photo.width} height={$photo.height} alt="Description utile">
```

| Prop | Défaut | Rôle |
|---|---|---|
| `src` | `''` | URL de l'image (repli `srcset`) |
| `srcset` | `''` | variantes de largeur, format `url Nw` |
| `sizes` | `'100vw'` | indice de taille d'affichage pour le choix de variante |
| `alt` | `''` | texte alternatif — voir *Accessibilité* plus bas |
| `width` / `height` | `null` | dimensions natives, réservent l'espace avant chargement |
| `loading` | `'lazy'` | attribut natif `loading` |
| `decoding` | `'async'` | attribut natif `decoding` |
| `fit` | `'cover'` | posé en `object-fit` via `@style.objectFit` |

Compile en `<img>` nu avec ces mêmes attributs. Une variable de thème, `$$img-radius` (défaut `0`), arrondit les coins ; le style embarqué pose `max-width: 100%` / `height: auto` — l'image reste fluide sans rien écrire côté appelant.

## Accessibilité

Le lint `lint.a11y` (cf. [32 · CLI & configuration](32-cli-et-configuration.md) → `lint.a11y`) traite `<@img>` **exactement comme un `<img>` natif** : sans attribut `alt` sous aucune forme, il déclenche le même avertissement de build (« sans attribut alt — ajoute `alt="…"` … ou `alt=""` si l'image est purement décorative »), quel que soit celui des deux qui manque de l'attribut.

<details>
<summary>🎓 <b>Pour débutants</b> — pourquoi deux dimensions séparées des variantes ?</summary>

Parce qu'elles ne coûtent pas la même chose. Lire la largeur et la hauteur d'une image ne demande que quelques octets de son en-tête — aucun décodage, aucune dépendance, ça marche à l'instant sur n'importe quel poste. Produire une variante de 640 pixels d'un JPEG de 4000, en revanche, demande un vrai décodeur/encodeur d'image (`sharp`), qui compile un binaire natif selon le système — pas toujours possible ou souhaité partout. En séparant les deux, `µimage` garantit que le bénéfice le plus important (plus de saut de mise en page) est **toujours** acquis, et fait du reste (l'économie d'octets par variantes) un bonus qui s'active en une commande, sans jamais pouvoir casser un build.

</details>

---

📚 **Voir aussi** : [15 · Éléments spéciaux](15-elements-speciaux.md) pour `µasset` (assets génériques : polices, sons…) et son idiome CSS ; [30 · Modules cœur](30-modules-coeur.md) pour les autres composants prêts à l'emploi et leurs trois leviers de personnalisation ; [32 · CLI & configuration](32-cli-et-configuration.md) pour la table complète des clés racine et `lint.a11y`.
