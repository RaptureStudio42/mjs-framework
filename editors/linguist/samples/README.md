# Échantillons pour `samples/ModularJS/`

Quatre composants **réels**, pris tels quels dans le framework — le catalogue de GitHub
refuse les « Hello World » de tutoriel et demande du code de production. Ils couvrent
volontairement les quatre formes qu'un composant peut prendre :

| Fichier | Ce qu'il montre |
| --- | --- |
| `select.mjs` | un composant complet : `<script>` Civet, gabarit à blocs `{if}`/`{for}`, `<style>` SASS, `::part()` |
| `field.mjs` | un composant à props et à `<slot>` |
| `image.mjs` | un composant court, avec un bloc `<theme>` et des variables de thème `$$` |
| `theme-viewer.mjs` | une page entière : état, dérivés, `µ.ajax`, listes filtrées |

**Licence** : MIT, comme tout ModularJS — voir [`LICENSE`](../../../LICENSE) à la racine du
dépôt. Auteur : Matrix (RaptureStudio). Ils peuvent être redistribués dans linguist sans
autre formalité ; c'est ce que demande le gabarit de demande de fusion.

Ils sont **copiés**, pas liés : si le framework évolue, rafraîchis-les avant d'envoyer la
demande (`cp ../../src/core-modules/*.mjs .`), pour que les échantillons montrent la
syntaxe réellement en vigueur.
