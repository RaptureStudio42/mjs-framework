# 30 · Modules cœur & personnalisation

> 📚 Pas de chapitre de tuto interactif dédié : cette page se suffit à elle-même. Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

Une petite bibliothèque de composants **prêts à l'emploi**, livrée avec le framework : un menu déroulant, une enveloppe de champ, une case à cocher, un bouton radio, un interrupteur, une pastille de couleur et une image (module à part, voir [35 · Images](35-images.md)). Chacun gère lui-même le clavier, le lecteur d'écran et sa participation à un `<form>` natif — et chacun est **100&nbsp;% stylisable** depuis ton propre CSS, sans jamais avoir besoin d'un `!important`.

## Le raccourci `<@nom>`

Un module cœur s'invoque avec la **même notation** qu'un composant du projet, `<@nom>` : la résolution cherche d'abord un composant du projet, et à défaut le module cœur du même nom, qui compile en `<mjs-nom>` et entre au bundle **automatiquement** dès qu'une balise le référence — rien à importer, rien à déclarer. Détail complet du mécanisme (résolution, override par homonymie, erreurs de frappe) : [15 · Éléments spéciaux](15-elements-speciaux.md) → *Le raccourci `<@nom>`*.

```html
<@select name="country" value=!{$country}>
```

## `<@select>` — liste déroulante

```html
<@select name value=!{$x} search multiple placeholder search-placeholder empty-label>
  <@option value={…} icon={…}>libellé</@option>
  …
</@select>
```

| Attribut | Rôle |
|---|---|
| `name` | nom de champ posé sur le(s) `<input type="hidden">` internes, un par valeur sélectionnée |
| `value=!{$x}` | valeur sélectionnée, two-way — une chaîne, ou un tableau de chaînes en mode `multiple` |
| `search` | bascule la recherche : un champ de filtre apparaît en tête du panneau |
| `multiple` | sélection multiple (coche plusieurs options, `value` devient un tableau) |
| `icon-checked` | icône d'une option cochée, mode `multiple` seulement — texte échappé, jamais du HTML — défaut `✔` |
| `icon-unchecked` | icône d'une option non cochée, mode `multiple` seulement — texte échappé, jamais du HTML — défaut vide |
| `placeholder` | texte affiché quand rien n'est sélectionné — défaut « Choisir… » |
| `search-placeholder` | placeholder du champ de recherche — défaut « Rechercher… » |
| `empty-label` | message quand le filtre ne trouve rien — défaut « Aucun résultat » |

Chaque `<@option value={…} icon={…}>` déclare une entrée ; `icon` est un texte affiché tel quel (emoji, caractère, petit mot) — la valeur est lue par `getAttribute` puis rendue par une interpolation ÉCHAPPÉE, jamais du HTML (`<svg>`…). La recherche filtre insensible aux accents ; le clavier répond aux flèches Haut/Bas, `Enter` (choisir), `Escape` (fermer), `Home`/`End` (première/dernière option) ; le bouton porte `role="combobox"` et les attributs ARIA associés (`aria-expanded`, `aria-controls`, `aria-activedescendant`) se tiennent à jour tout seuls.

**Parts** : `button`, `panel`, `search`, `option`. **Variables** : `--mjs-select-bg`/`-fg`/`-border`/`-radius`/`-hover`/`-panel-bg`/`-panel-shadow`/`-selected`, plus `--mjs-select-max` (largeur préférée maximale, 22rem par défaut — cf. plus bas). Une dixième, `--mjs-select-panel-max`, est **posée par le module lui-même** (rien à définir de ton côté) : hauteur maximale du panneau, recalculée à chaque ouverture **et à chaque redimensionnement de la fenêtre pendant qu'il est ouvert** (le clavier virtuel d'un mobile qui rétrécit la vue, typiquement), selon la place réellement disponible du côté choisi (haut ou bas), plafonnée à 280px — c'est ce qui évite qu'un panneau ouvert vers le haut dans un conteneur court sorte par le haut de l'écran, là où aucun défilement ne va le chercher. La place disponible fait toujours loi : quand elle est courte, le panneau rétrécit d'autant (deux options visibles et un défilement interne, plutôt qu'un sommet inatteignable). Le champ de recherche reste `position: sticky` en tête pendant le défilement des options.

**La largeur suit la plus longue option.** Quand rien ne contraint le contrôle (une ligne en `flex`, une cellule qui s'ajuste à son contenu), il se dimensionne sur l'option la plus longue plutôt que sur celle qui se trouve affichée — sinon un select posé sur `3` se réduit à trois pixels et son panneau tronque `illimité`. Le calcul est purement CSS (une jauge invisible de hauteur nulle, qui empile toutes les étiquettes dans la même cellule de grille), donc il suit tout seul un ajout d'option, un changement de police ou une traduction. Dans un conteneur qui impose sa largeur, rien ne change : le select la remplit comme avant et les étiquettes trop longues sont coupées par des points de suspension. Deux bornes évitent qu'une option à rallonge ne tire toute la page : la largeur préférée est plafonnée par `--mjs-select-max` (22rem par défaut, à toi de la relever), et le contrôle reste **compressible** — dans une ligne `flex` trop étroite il rétrécit au lieu de faire déborder la ligne.

## `<@field>` — enveloppe de champ

```html
<@field label="Email" help="On ne le partage jamais." ok-label="Disponible !">
  <input type="email" name="email" value=!{$email}>
</@field>
```

Enveloppe n'importe quel champ (projeté par slot) et lit **toute seule** `µres.errors[name]` (le sac d'erreurs par champ d'un formulaire refusé en 422, cf. [21 · Navigation](21-navigation.md)) : une erreur affichée efface l'aide le temps qu'elle dure, puis s'efface elle-même à la réponse qui corrige le champ — le 422 devient entièrement **déclaratif**, rien à câbler à la main.

| Attribut | Rôle |
|---|---|
| `name` | clé lue dans `µres.errors` — **facultatif** : à défaut, le `name` du champ enveloppé fait foi (voir juste en dessous) |
| `label` | libellé au-dessus du champ (`for` posé automatiquement sur le premier élément projeté) |
| `help` | texte d'aide, masqué tant qu'une erreur est affichée |
| `ok-label` | message affiché à l'état succès — vide par défaut (rien ne s'affiche sans cette clé) |

**`name` ne s'écrit qu'une fois.** Le champ enveloppé porte déjà le sien — sans lui, aucun formulaire ne le ramasse — et `<@field>` n'a qu'un seul enfant projeté : c'est forcément celui-là. L'enveloppe lit donc ce `name` toute seule (ou, si le champ est lui-même dans un conteneur, celui du premier descendant qui en porte un), et s'en sert comme clé dans `µres.errors`. L'écrire une seconde fois sur l'enveloppe reste possible et **prend le dessus** : c'est ce qu'il faut quand la clé du sac d'erreurs diffère du nom du champ (`user[email]` côté formulaire, `email` côté erreurs). L'erreur au montage ne se déclenche que si personne, ni l'enveloppe ni le champ, ne porte de nom.

L'état **succès** (bordure et message en vert, `--mjs-field-ok-color`) n'apparaît jamais au tout premier rendu — il faut une réponse du serveur. À partir de la première, tout champ sans erreur passe au vert, qu'il ait été refusé auparavant ou non : c'est un accusé de validité, daté de la dernière réponse reçue, pas seulement un accusé de correction.

**Parts** : `field`, `label`, `help`, `error`, `ok`.

## `<@checkbox>` / `<@radio>` / `<@switch>` — cases et interrupteurs

Trois habillages d'un contrôle **natif** (`<input type="checkbox">`/`radio`), entièrement restylisés — le comportement clavier, focus et formulaire reste celui du navigateur.

```html
<@checkbox name="terms" checked=!{$accept}>J'accepte les conditions</@checkbox>

<@radio name="size" value="m" group=!{$size}>M</@radio>
<@radio name="size" value="l" group=!{$size}>L</@radio>

<@switch name="notify" checked=!{$notify}>Notifications</@switch>
```

`<@checkbox>` : `name`, `checked=!{$x}` (two-way), `value` (valeur du champ, défaut `'on'`), `disabled`, `indeterminate={$x}` (le tiret « une partie », transmis à la case native). `<@radio>` : `name` (les boutons d'un même groupe partagent leur `name`, qui les coordonne), `value`, `group=!{$x}` (two-way — porte la valeur du bouton actuellement sélectionné dans le groupe). `<@switch>` : mêmes attributs que la case à cocher, sans `indeterminate`, rôle ARIA `switch` au lieu de `checkbox`.

Une case d'en-tête posée au-dessus d'une liste porte les **trois états** de la case à cocher : vide quand rien n'est coché, cochée quand tout l'est, tiret (`indeterminate`) quand seule une partie de la liste l'est.

```html
<script>
  $all  = $mails.every (m)-> m.checked
  $some = $mails.some((m)-> m.checked) and not $all
</script>

<@checkbox checked=!{$all} indeterminate={$some}>Tout sélectionner</@checkbox>
```

| Composant | Parts |
|---|---|
| `<@checkbox>` | `wrap`, `box`, `label` |
| `<@radio>` | `wrap`, `dot`, `label` |
| `<@switch>` | `wrap`, `pill`, `label` |

Variables : `--mjs-check-size`/`-radius`/`-accent`/`-color`/`-border` pour la case et le radio (le radio n'a pas de `-radius`, il est rond) ; `--mjs-switch-width`/`-height`/`-accent`/`-color`/`-border` pour l'interrupteur.

## `<@color>` — pastille de couleur

```html
<@color value="#f472b6">

<@color value=!{$c} editable>
```

Affiche le code de la couleur écrit tel quel, suivi de la pastille — **lecture seule par défaut**, sans la moindre option à poser. La couleur passe par la variable `--mjs-color-value`, jamais par un style inline sur le DOM (`background: var(--mjs-color-value)` vit dans le `<style>` du module) : `oklch(…)`, `color-mix(…)`, `rgb(…)`, un nom CSS ou un hexadécimal fonctionnent tous identiquement, c'est le navigateur qui peint.

| Attribut | Rôle |
|---|---|
| `value` | la couleur, dans n'importe quelle syntaxe CSS valide — obligatoire |
| `editable` | bascule la pastille en vrai sélecteur de couleur natif (`<input type="color">`) |
| `compact` | pastille seule, sans le code écrit à côté |
| `label` | étiquette accessible de l'`<input>` en mode `editable` — défaut « Couleur » |
| `before` | place la pastille **avant** le code plutôt qu'après |

**Édition, opt-in explicite.** Avec `editable`, la pastille devient un `<input type="color">` natif ; comme cet input n'accepte que `#rrggbb`, le module résout `value` en hexadécimal en le posant sur un élément jetable (créé, attaché à `document.body`, retiré aussitôt après lecture) et en lisant `getComputedStyle(...).backgroundColor` — ce qui couvre n'importe quelle syntaxe CSS, exactement comme en lecture seule. Si le navigateur ne sait pas résoudre la valeur (`oklch()`/`color-mix()` sur un moteur qui ne les connaît pas, syntaxe invalide…), le module retombe **silencieusement** sur la pastille en lecture seule plutôt que d'afficher un sélecteur menteur — aucune erreur, aucun `input` rendu. Choisir une nouvelle couleur émet **`change`** (`e.data` = la nouvelle valeur, au format `#rrggbb`) et met à jour `value`, ce qui rend la liaison two-way `value=!{$x}` opérante — comme sur `<@select>`, dont le two-way porte lui aussi sur `value` (celui de `<@checkbox>` et de `<@switch>` porte sur `checked`). `@change` reste disponible pour tout ce qui n'est pas la simple recopie de la valeur.

**Accessibilité de la pastille en lecture seule.** Ce n'est pas un contrôle (aucun arrêt de tabulation), mais la couleur ne doit jamais être portée par la seule teinte. En mode normal, le code écrit à côté suffit — la pastille est alors retirée de l'arbre d'accessibilité (`aria-hidden="true"`) pour ne pas doubler l'annonce. En `compact`, il n'y a plus de code écrit : la pastille prend `role="img"` + `aria-label`/`title` portant la valeur, le patron standard pour exposer un élément purement graphique porteur de sens.

**Parts** : `swatch` (pastille en lecture seule), `picker` (`<input type="color">` en édition), `code` (le texte de la valeur). **Variables** : `--mjs-color-size`/`-radius`/`-border` (dimension, arrondi, bordure de la pastille et du picker — la dimension vaut `1em` par défaut, soit la hauteur du texte à côté duquel la pastille s'aligne) ; `--mjs-color-value` est posée par le module lui-même à partir de `value` — rien à en faire côté thème, c'est un canal de données, pas un réglage esthétique. `--mjs-color-line` porte la hauteur de ligne du code écrit ; le module réserve toujours cette hauteur, même en `compact` où il n'y a plus de texte, pour qu'une pastille compacte reste alignée sur ses voisines et sur le texte qui l'entoure.

## Tous compatibles `<form>` natif

Les cinq modules de saisie — select compris, et à l'exception de la pastille `<@color>`, qui montre une couleur sans rien soumettre — maintiennent chacun un ou plusieurs `<input type="hidden">` internes qui reflètent leur valeur courante. Un `<form method="post">` classique les ramasse donc comme n'importe quel champ natif, sans un `µ.ajax` ni un `@submit` à écrire : c'est cette même mécanique qui rend `<@field>` capable de lire `µres.errors[name]` — le `name` posé sur le module est le même que celui reçu côté serveur.

## Thème clair/sombre — `µtheme`

Une globale réactive, `µtheme`, porte le thème courant du site — `'light'` ou `'dark'`. Elle se lit comme n'importe quelle rune (dans le HTML, un `µeffect`…) et s'écrit directement pour basculer :

```html
<button @click={µtheme = µtheme === 'dark' ? 'light' : 'dark'}>Changer de thème</button>

<p>Thème actuel : {µtheme}</p>
```

Au démarrage, deux sources possibles, la première trouvée gagne : si la page pose déjà `<html data-mjs-theme="…">` (rendu serveur, script inline…), cette valeur fait foi ; sinon la préférence système (`prefers-color-scheme`) initialise `µtheme` **et** l'attribut, et le framework **suit** les changements système jusqu'à la première écriture applicative de `µtheme`, qui fige le choix.

Toute mise à jour de `µtheme` répercute l'attribut `data-mjs-theme` sur `<html>` : c'est le canal CSS. Un `<style>` — global ou dans un composant, la custom property traverse le Shadow DOM — style le thème avec `:root[data-mjs-theme='dark']` ou les variables ci-dessous.

Une valeur autre que `'light'`/`'dark'` déclenche un avertissement console et n'est pas retenue.

### Variables de thème globales

Un jeu de custom properties **sémantiques**, dont la valeur bascule automatiquement avec le thème — ils traversent le Shadow DOM, sont consommés par les modules cœur, et se surchargent sur `:root` pour ta propre palette :

| Variable | Rôle |
|---|---|
| `--mjs-surface` | fond des surfaces (panneaux, champs) |
| `--mjs-fg` | texte principal |
| `--mjs-fg-muted` | texte secondaire, atténué |
| `--mjs-border` | bordures |
| `--mjs-hover` | fond au survol |
| `--mjs-selected` | fond d'un élément sélectionné/coché |
| `--mjs-accent` | couleur d'accent |
| `--mjs-shadow` | ombres portées |

```css
:root {
  --mjs-accent: #0055aa;
}
:root[data-mjs-theme='dark'] {
  --mjs-accent: #8be9fd;
}
```

## `@title` — infobulle universelle

Une info-bulle posable sur **n'importe quelle balise**, native ou composant — pas un module à part, une directive du cœur du langage.

```html
<button @title="Supprime définitivement cette ligne">🗑</button>

<span @title={$counter + ' éléments sélectionnés'}>{$counter}</span>

<button @title={ text: 'Version bêta', delay: 400, side: 'bottom', transition: 'slide' }>⚠</button>

<span @title={{ '<b>' + $counter + '</b> éléments sélectionnés' }}>{$counter}</span>
```

Quatre formes : une chaîne statique `@title="texte"` ; une expression réactive `@title={$expr}`, relue à chaque changement (texte toujours brut, jamais interprété comme HTML) ; un objet **statique** `@title={ text: '…', delay: 400, side: 'top'|'bottom', dur: 150, transition: 'fade'|'slide' }` (`text` obligatoire, `delay`/`dur` en millisecondes, aucune expression dans les clés) ; une expression **HTML brut** `@title={{ expr }}` — même convention que `{{ }}`/`{ }` en interpolation de texte ([Bindings → HTML brut](07-bindings.md)), le contenu de la bulle est posé en `innerHTML`, réactif comme la forme `{$expr}`. Les deux accolades ouvrantes doivent être **accolées** (`{{`, sans espace) pour déclencher cette forme ; un objet littéral en tête de la forme simple reste écrivable en glissant un espace entre les deux accolades (`@title={ { text: '…' } }`, cas rare) — l'objet y est alors une expression ordinaire, pas la forme statique ci-dessus. Un élément qui porte à la fois `mjs-title` et `mjs-title-html` (deux directives `@title` sur la même balise) voit le **HTML gagner** : c'est la forme la plus riche, choisie explicitement par le développeur. **Sécurité** : porte ouverte volontaire, exactement comme `{{ }}` en interpolation de texte — aucune désinfection, ne l'alimente jamais avec une saisie non maîtrisée. Un `<script>` posé dans le HTML reste inerte (règle du navigateur pour `innerHTML`), mais un attribut `onerror`/`onload` (`<img src=x onerror=…>`) s'exécute réellement : ce n'est pas un bac à sable.

La bulle apparaît au survol, au focus clavier (accessibilité) et à l'appui long tactile, après le délai configuré, bascule automatiquement en haut ou en bas selon la place disponible, et se ferme immédiatement en sortant ou à `Escape`. Au tactile, l'appui doit durer 500 ms (un glissement de plus de 10 px avant l'échéance annule l'apparition), la bulle survit 1,5 s après le relâcher, et le menu contextuel du navigateur reste neutralisé tant qu'elle est affichée pour cette cible. Un `aria-describedby` relie la bulle à l'élément pendant qu'elle est affichée, retiré à la fermeture. La bulle MJS **se substitue** au `title` natif de l'élément qu'elle décore, jamais les deux affichées ensemble : le `title` natif est mis de côté tant que `mjs-title`/`mjs-title-html` reste posé, et restitué à l'identique (chaîne vide comprise) dès que la bulle disparaît. Si ce retrait laissait l'élément sans aucun nom accessible (pas de texte visible, pas de `aria-label`/`aria-labelledby` déjà posé), un `aria-label` reprenant la valeur native prend le relais le temps de la substitution — jamais si l'auteur en a déjà un.

Détail utile pour le style : la bulle naît **dans l'arbre du composant survolé** (via l'API Popover du navigateur — la couche visuelle la plus haute, au-dessus de tout le reste de la page) — elle est donc stylable directement depuis le `<style>` de ce composant, comme n'importe quel élément qu'il rend. Posée sur une balise hors composant (light DOM), elle rejoint une bulle globale.

Thème par défaut : variables `--mjs-title-bg`/`-fg`/`-radius`/`-pad`/`-shadow`/`-offset`/`-dur`, et une config globale pour les délais/orientation par défaut :

```js
µconfig.title = { delay: 400, side: 'top', dur: 150, transition: 'fade' }
```

## Personnaliser — trois leviers, une règle de fair-play

Tout ce qui précède — modules cœur, `@title`, et [la modale maison](06-evenements.md) (`µ.modal.fire`) — se retouche de la même façon, à trois niveaux :

**1. Les variables `--mjs-*`** — le thème, y compris les variables globales clair/sombre décrites plus haut (§ *Thème clair/sombre*). Elles traversent le Shadow DOM (une variable posée sur `:root`, ou sur le composant lui-même, est lue par le module encapsulé) : c'est le levier le plus simple, celui à essayer en premier.

> 🔗 Ces variables sont exactement les **variables de thème** du chapitre [31 · Thèmes](31-themes.md) : `--mjs-select-radius` s'écrit `$$select-radius` dans un bloc `<theme>`, et un thème posé sur une section ne repeint que cette section — modules cœur compris.

```css
:root {
  --mjs-select-radius: 12px;
  --mjs-check-accent: #e5484d;
}
```

**2. `::part()`** — la retouche ciblée. Chaque zone marquante d'un module porte un attribut `part="…"` (listé plus haut, par module) ; `::part(nom)` la cible depuis n'importe quelle feuille de style, y compris depuis le `<style>` d'un **de tes propres composants** — dans ce cas, la règle ne s'applique qu'aux modules cœur présents dans **ce** composant précis, jamais au reste du site.

```html
<!-- dans le <style> de mon-formulaire.mjs -->
<style>
  mjs-field::part(label)
    text-transform: uppercase
    font-size: .8rem
</style>
```

**3. L'éjection** — le contrôle total. Le fichier source d'un module cœur (`select.mjs`, `field.mjs`…) est un `.mjs` ordinaire : copie-le tel quel dans les sources de ton projet, **sous le même nom** (`select.mjs`, par exemple). Il devient aussitôt un composant du projet, qui remplace le module cœur partout où `<@select>` est écrit — rien à renommer ailleurs. Tu en modifies le markup, le style ou la logique librement ; il ne suit plus, en échange, les mises à jour du module d'origine. (Un autre nom, `my-select.mjs` par exemple, fonctionne aussi — les deux coexistent alors, le module cœur restant disponible sous son nom d'origine.)

**Deux régimes de style, selon où vit l'élément.** Un module cœur vit dans son **Shadow DOM** : son apparence lui appartient, et le CSS ambiant de la page ne la défait pas par accident — une règle `button { … }` écrite quelque part dans ton application ne repeint pas le bouton d'un `<@select>`. Pour le personnaliser, tu passes par les trois leviers ci-dessus, qui visent le module explicitement.

Exception assumée — le contenu **projeté par slot** (`<@field>`, qui enveloppe ton propre `<input>`/`<select>`/`<textarea>`) : cet élément t'appartient, il vit dans TA feuille de style, pas dans celle du module — une règle `input { border: … }` de ta page peut donc, sans le vouloir, repeindre par-dessus la bordure d'état que `<@field>` pose via `::slotted()` (le Shadow DOM ne protège que ce qu'un module écrit lui-même dans son propre HTML, pas ce que TU lui confies). Pour que la bordure d'état (`has-error`/`has-ok`) reste visible quoi que ta page déclare, `<@field>` protège cette seule déclaration avec `!important` — les variables `--mjs-field-error-color`/`--mjs-field-ok-color` restent le levier de personnalisation normal, `!important` ne change que qui gagne la bordure, jamais la couleur qu'elle prend.

Les éléments **flottants** — modale, toasts, bulle `@title` — vivent au contraire dans la page elle-même, hors de tout Shadow DOM : leurs styles par défaut sont enveloppés dans `:where(…)`, un enrobage qui ramène leur poids dans la cascade à **zéro**. N'importe quelle règle à toi, même une classe seule, l'emporte alors sans `!important` ni sélecteur alambiqué. Les **variables de thème** (§ *Thème clair/sombre*) suivent la même règle : posées en `:where(:root)`, elles cèdent devant la moindre redéfinition venue de ta feuille de styles.

Dans les deux cas, les couleurs, tailles et formes par défaut ne sont là que tant que tu n'as rien dit de plus précis.

---

📚 **Voir aussi** : [15 · Éléments spéciaux](15-elements-speciaux.md) pour le raccourci `<@nom>` en général ; [6 · Événements](06-evenements.md) pour la modale maison (`µ.modal.fire`, ses raccourcis, ses toasts) ; [21 · Navigation](21-navigation.md) pour `µres.errors`, que `<@field>` consomme.
