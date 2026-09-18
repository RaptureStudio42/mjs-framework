# Glossaire — terminologie figée (français ↔ anglais)

> **À quoi sert cette page.** Le français est la langue **source** de ModularJS : toute la
> documentation, le tuto, le site et les messages de la ligne de commande s'écrivent d'abord en
> français, puis se traduisent. Ce glossaire fige le vocabulaire des deux côtés pour qu'un même
> concept porte **toujours** le même mot, dans toutes les pages et dans tous les messages.
>
> Règle d'usage : un terme de cette table ne se remplace jamais par un synonyme « pour varier le
> style ». Si un mot manque, on l'ajoute ici **avant** de l'employer.

---

## 1. Termes du framework

| Français | Anglais | Ce que ça désigne |
|---|---|---|
| composant | component | un fichier `.mjs`, monté comme custom element |
| symbole | sigil | `µ`, `$`, `$$`, `§`, `§§` — le caractère qui ouvre une écriture du langage |
| rune | rune | une écriture `µquelquechose` (`µeffect`, `µt`, `µlang`…) |
| directive | directive | une écriture `@quelquechose` posée sur une balise ou à la racine |
| bloc logique | logic block | `{if}`, `{for}`, `{key}`, `{await}` |
| prop | prop | valeur passée du parent vers l'enfant |
| attribut | attribute | attribut HTML posé sur la balise |
| liaison two-way | two-way binding | `value=!{$x}` |
| état | state | les `$x` d'un composant |
| valeur dérivée | derived value | une valeur recalculée à partir d'autres |
| effet | effect | `µeffect` — du code rejoué quand ses dépendances changent |
| store | store | conteneur d'état partagé (`$$`, `µ$$`, `µStore`) |
| contexte | context | `§` (figé) et `§§` (réactif de sous-arbre) |
| snippet | snippet | fragment de HTML paramétré, réutilisable dans le composant |
| hook de cycle de vie | lifecycle hook | `µmount`, `µdestroy`, `µawake`, `µsleep`, `µurlChange`, `µfailed` |
| thème de document | document theme | un fichier `nom.theme.mjs`, posable sur n'importe quel élément |
| thème nommé | named theme | `<theme name="gold">` + `theme="gold"` — une palette alternative du composant |
| variable de thème | theme variable | `$$nom` en contexte de style, compilée en `var(--mjs-nom)` |
| **variant** | **variant** | `<style name="banner">` + `layout="banner"` — un jeu de **règles de mise en page** du composant, sorti en fichier à part et chargé à la demande |
| module cœur | core module | `<@select>`, `<@field>`, `<@color>`… — la bibliothèque livrée avec le framework |
| élément spécial | special element | `<@window>`, `<@head>`, `<@element>`, `<@failed>`, `<@view>`, `<@slot>`, `<@fill>` |
| routeur | router | le routeur client (`@routes`, `<@view>`) |
| rendu côté serveur | server-side rendering (SSR) | le HTML produit avant l'envoi au navigateur |
| prérendu | prerendering | le HTML produit **au build**, servi tel quel |
| hydratation | hydration | la reprise en main du HTML déjà rendu par le code client |
| manifeste | manifest | le fichier d'entrée écrit par le build |
| empreinte | fingerprint | le condensé qui identifie un contenu (cache, fraîcheur) |
| dictionnaire | dictionary | un fichier de langue (`i18n/fr.yml`, `i18n/fr/panier.yml`) |
| section (i18n) | section | l'espace de clés d'un module, déclaré par `@i18n 'panier'` |
| fragment | fragment | le dictionnaire d'une section, chargé quand la section s'affiche |
| langue de repli | fallback language | la langue servie quand la langue demandée manque |
| page périmée | stale page | une traduction en retard sur sa source française |

### Le cas `variant` — pourquoi ce mot des deux côtés

Le mot **variant** ne se traduit pas : il s'écrit et se lit pareil en français et en anglais. Il
désigne **une seule chose** — un bloc `<style name="…">` activé par `layout="…"`, c'est-à-dire des
**règles** de mise en page (une grille, un ordre, un bloc masqué).

À ne pas confondre avec le **thème nommé** (`<theme name="gold">` + `theme="gold"`), qui porte des
**valeurs** (couleurs, espacements, rayons) et non des règles. Les deux mots sont distincts et le
restent : « variant » pour la forme, « thème nommé » pour la palette.

> L'ancien mot français pour un variant était « déclinaison ». Il est abandonné : un seul mot,
> aucune traduction à retenir.

---

## 2. Mots qui ne se traduisent pas

Ces mots s'écrivent à l'identique dans les deux langues, y compris au cœur d'une phrase française :

`ModularJS`, `MJS`, `MJS-WS`, `MJS-Server`, `prop`, `store`, `snippet`, `variant`, `rune`,
`shadow DOM`, `custom element`, `template literal`, `hash`, `build`, `bundle`, `commit`, `push`,
`hook`, `layout` (l'attribut), `theme` (l'attribut), et **tous** les noms d'API : `µeffect`,
`µlang`, `µt`, `@i18n`, `mjs build`, `mjs.config.json`, `sourceDir`…

Un identifiant de code — nom de fichier, de classe, de méthode, de clé de configuration, de clé de
traduction — **ne se traduit jamais**, dans aucune langue.

---

## 3. Mots interdits (et par quoi les remplacer)

| Interdit | À écrire | Pourquoi |
|---|---|---|
| sigil (en français) | symbole | mot anglais inutile en français ; « sigil » ne survit que dans la clé de configuration `sigil` et les commentaires de `src/` |
| gabarit | HTML, ou « chaîne à backticks » pour le littéral JS | « gabarit » ne dit rien au lecteur |
| déclinaison | variant | cf. § 1 |
| proxy | filet de sécurité | réservé aux vrais objets `Proxy` du langage, inévitables |
| template (en français) | HTML du composant | ambigu avec le `<template>` du DOM |
| écriture inclusive (point médian, doublets, parenthèses de genre) | masculin générique | règle d'écriture du projet, sans exception |
| ombre, frontière d'ombre, racine d'ombre | shadow DOM, shadow root | le nom technique du § 2 ne se traduit pas, même noyé dans une phrase |
| élément personnalisé | custom element | idem § 2 |
| crochet, point d'accroche (au sens API) | hook | idem § 2 ; « crochet » reste valide pour le caractère `[` |
| magasin | store | idem § 2 |

---

## 4. Règles de traduction

1. **Le français est la source.** Une correction ne s'écrit jamais d'abord en anglais. Une page
   anglaise en retard sur sa source française n'est **pas servie** — cf. le contrôle d'empreinte
   du chapitre [29 · i18n](29-i18n.md).
2. **Le code reste en anglais, la prose en français.** Noms de classes, de méthodes, de variables,
   de clés : anglais. Commentaires et textes affichés : français (puis traduits).
3. **Les exemples ne se traduisent pas au hasard** : les identifiants d'exemple sont en anglais
   (`cart`, `user`, `count`), leur prose d'accompagnement suit la langue de la page.
4. **Un bloc de code ne se traduit pas.** Seuls ses commentaires et les chaînes affichées à
   l'utilisateur peuvent l'être — et seulement si la page l'exige.
5. **Une clé de traduction ne se renomme pas** pour cause de reformulation : la clé est un
   identifiant, la phrase est la valeur.
