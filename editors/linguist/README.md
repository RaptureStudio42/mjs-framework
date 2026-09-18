# Faire entrer ModularJS au catalogue de GitHub (linguist)

Ce dossier est une **demande de fusion prête à partir**, pas une demande envoyée. Elle ne
peut pas l'être aujourd'hui, et la raison n'est pas technique.

## Pourquoi on ne peut pas encore l'envoyer

Le catalogue de GitHub — [github-linguist/linguist](https://github.com/github-linguist/linguist)
— a un seuil d'entrée, écrit dans son `CONTRIBUTING.md` :

> at least 2000 files per extension or filename indexed in the last year (the number you
> see at the top of the search results), excluding forks […] the results should show a
> reasonable distribution across unique `:user/:repo` combinations.

Autrement dit : **2000 fichiers portant l'extension, indexés dans l'année, répartis sur un
nombre raisonnable de dépôts distincts**. Un framework qui n'est pas publié n'a, par
construction, aucun fichier chez personne. Le seuil se franchit après l'adoption, jamais
avant. Ce n'est pas un « non » : c'est un « pas encore ».

## La difficulté propre à ModularJS

`.mjs` est **déjà attribuée** à JavaScript dans le catalogue (les modules ES de Node). Une
demande d'ajout doit donc fournir, en plus de l'entrée de langage, une **règle de
désambiguïsation** : de quoi distinguer un composant ModularJS d'un module Node à la
lecture du fichier. Le catalogue prévoit exactement ce mécanisme (il l'utilise déjà pour
`.h`, disputée entre C, C++ et Objective-C) — la règle est écrite ci-dessous et elle est
solide, parce que les deux formats n'ont rien en commun : un composant ModularJS ouvre par
un bloc `<script>`, `<style>` ou `<theme>`, ou par une directive de premier niveau.

## La règle a été éprouvée sur du vrai

Pas sur trois exemples choisis : sur **la totalité** des composants des deux dépôts, et sur
de vrais modules Node de la même extension.

| Mesure | Résultat |
| --- | --- |
| Composants ModularJS reconnus | **648 / 648** |
| Modules JavaScript de Node pris à tort pour du ModularJS | **0** |

Le motif décisif est le plus simple : un composant qui n'a que du gabarit — le cas
majoritaire (422 des 648) — commence par un chevron, et un module JavaScript ne le peut
pas (`<` en première position est une erreur de syntaxe).

## Ce qui est prêt ici

| Fichier | À quoi il sert |
| --- | --- |
| `languages.yml.entry` | l'entrée à coller dans `lib/linguist/languages.yml`, alphabétiquement |
| `heuristics.yml.entry` | la règle de désambiguïsation `.mjs`, à coller dans `lib/linguist/heuristics.yml` |
| `samples/` | des composants réels, sous licence MIT, pour `samples/ModularJS/` |

La **grammaire** vit déjà dans le dépôt : [`editors/vscode/`](../vscode/). Le catalogue
l'attache en sous-module depuis un dépôt public — il faudra donc l'avoir publiée seule
(voir « le jour où » ci-dessous).

## Le jour où le compteur y sera

1. Vérifier le seuil : sur GitHub, chercher `extension:mjs` et lire le nombre de résultats,
   forks exclus. Il faut 2000 fichiers **et** une vraie diversité de dépôts.
2. Publier la grammaire dans son propre dépôt public (par exemple
   `RaptureStudio42/modularjs-tmbundle`), avec sa licence.
3. Forker linguist, puis :
   ```bash
   script/add-grammar https://github.com/RaptureStudio42/modularjs-tmbundle
   # coller l'entrée de languages.yml.entry (ordre alphabétique, SANS language_id)
   # coller la règle de heuristics.yml.entry (ordre alphabétique par extension)
   # copier les échantillons dans samples/ModularJS/
   script/update-ids     # attribue le language_id définitif
   bundle exec rake test
   ```
4. Ouvrir la demande de fusion **avec le gabarit imposé** : sans lui, la revue ne démarre
   pas. Y joindre le décompte de l'étape 1 et la licence des échantillons.

## Ce qu'on fait en attendant

Le dépôt porte un `.gitattributes` qui emprunte la grammaire HTML pour les `.mjs` et les
sort des statistiques de langage. Les exemples s'affichent correctement, et le dépôt
s'annonce en TypeScript — ce qu'est réellement le compilateur. C'est une solution
d'attente honnête : elle ne prétend pas être notre nom, elle évite juste que nos pages de
syntaxe s'affichent comme du JavaScript cassé.
