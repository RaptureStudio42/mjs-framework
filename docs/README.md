# Documentation de référence — ModularJS (MJS)

Référence du **langage MJS côté client** : concise, exhaustive, orientée « comment fais-je X ? ».

**Deux niveaux de lecture dans chaque page :**
- le corps de page est la **référence dense** (tu connais les bases, tu cherches vite) ;
- les encarts dépliables **🎓 Pour débutants** donnent l'explication pas-à-pas (le mode « guide » s'active à la demande, sans alourdir la lecture experte) ;
- chaque page renvoie au **tuto interactif** correspondant — le vrai parcours d'apprentissage progressif.

> Le **SSR** (rendu côté serveur) est documenté au chapitre [19 · SSR](19-ssr.md). Le full-stack avancé (handlers serveur, modes de rendu, params de route avancés…) viendra s'y greffer.

## Sommaire

1. [Introduction](01-introduction.md) — philosophie, compile-time, custom elements + Shadow DOM
2. [Anatomie d'un composant](02-composant.md) — fichier `.mjs`, `<script>`, template, `<style>`
3. [Réactivité](03-reactivite.md) — `$x`, valeurs dérivées, `µeffect`
4. [Props & attributs](04-props.md) — passage parent→enfant, valeurs par défaut
5. [Blocs logiques](05-blocs.md) — `{if}`, `{for … by}`, `{key}`, `{await}`
6. [Événements](06-evenements.md) — `@click`, modificateurs, délégation
7. [Bindings two-way](07-bindings.md) — `value=!`, `@group`, casts, `@html`, dimensions
8. [Classes & styles](08-class.md) — `@class{$cond}="classe"`, `@style.<prop>`, `--var={}`
9. [Directives DOM](09-directives-dom.md) — `@attach`, `@this`
10. [Transitions & animations](10-transitions.md) — `@transition/@in/@out`, `@flip`, `µspring`
11. [État brut](11-etat-brut.md) — `µraw`
12. [Snippets & composants paramétrés](12-snippets.md)
13. [Contexte](13-contexte.md) — `§`, `§§`
14. [Stores](14-stores.md) — `µ$$`, `µStore`
15. [Éléments spéciaux](15-elements-speciaux.md) — `<@window>`, `<@head>`, `<@element>`, `<@failed>`
16. [Cycle de vie](16-cycle-de-vie.md) — `µmount/µdestroy/µawake/µsleep/µurlChange/µevery`
17. [Router (client)](17-router.md) — `@routes`, `<@view>`, params `:id`
18. [Pièges & bonnes pratiques](18-pieges.md) — réactivité statique, mutation imbriquée, footguns
19. [SSR (rendu serveur)](19-ssr.md) — `renderToString`, render-then-replace, props & `§§` sérialisés inline
20. [Temps réel (µsocket)](20-temps-reel.md) — état réactif, `send`/`on`, `request`, `stream`, `presence`/`room`, `µsmooth`, **protocole serveur `µ:`**, options
21. [Navigation (µ.ajax & UJS)](21-navigation.md) — interception liens/formulaires, zone de montage, `@noUJS`, PRG/422, `µ.pageCache`, `µnav`, préchargement au survol

**Annexe**

22. [🃏 Aide-mémoire](22-aide-memoire.md) — fiche de référence : symboles, casse `µ`, runes, hooks, balises `<@…>`, blocs (résumé condensé, tout en tableaux)
23. [🔌 MJS-WS — serveur compagnon (Node)](23-mjs-ws.md) — module complet : cœur du protocole `µ:`, protections de série, salons/présence, flux à journal borné, commande `mjs ws`, pont universel (API HTTP signée + webhooks + jetons JWT), reprise de session opt-in, adaptateur multi-processus (Redis, zéro dépendance), état du serveur (`app.stats()`, `/stats`, `/metrics` Prometheus, page `/state`), transport interchangeable — leçon tuto : [Le serveur officiel (mjs ws)](/tuto#/serveur-mjs-ws)
24. [🎮 MJS-Server — la salle de partie](24-mjs-server.md) — module optionnel composé par-dessus MJS-WS : `app.game(type, def)` (sièges, tour par tour, minuteries nommées), vue filtrée par joueur, appariement par file ou code privé, client `sock.game` (store réactif à plat, reconnexion avec resync automatique), persistance optionnelle (mémoire/fichier/pont HTTP signé/adaptateur maison)
25. [📡 Protocole MJS-WS — spécification de référence](25-protocole-mjs-ws.md) — inventaire **bas niveau** de toutes les trames `µ:`/`µgame:*` (champs exacts, sens, déclencheurs), le format binaire µschema octet par octet, la sécurité du pont HTTP — assez précis pour écrire un client MJS-WS dans un **autre** langage (esprit DDP)
26. [💬 Chat — module temps réel prêt à l'emploi](26-chat.md) — paquet serveur `app.use(chatPackage(opts))` composé sur `room().history()` : salons à historique, débit par identité+salon, modération (suppression/muet), indicateur de frappe ; client `sock.chat` (store réactif à plat, reconnexion avec resync automatique)
27. [🪪 Comptes & identités — comptes persistés](27-accounts.md) — paquet serveur `app.use(accountsPackage({ secret }))` : création/connexion (scrypt, anti-force-brute, anti-énumération), jetons JWT réutilisant `token.ts`, rôles (`hasRole`) ; client `sock.account` (élévation invité→compte par reconnexion contrôlée, persistance locale du jeton)
28. [🛋️ Lobby — hall d'accueil et présence riche](28-lobby.md) — paquet serveur `app.use(lobbyPackage(opts))` : présence riche (statuts libre/occupe/absent, absent auto), invitations anti-spam (blocage silencieux), annonces de tables génériques avec hook d'appariement (`onJoin`, aucun import du module jeu) ; client `sock.lobby` (store réactif à plat, TTL local des invitations/annonces)
29. [🌐 i18n — traduction & internationalisation](29-i18n.md) — module optionnel (`runtime: 'i18n'`) : rune `µt('clé')` + directive `@i18n 'section'` (préfixage compile-time), un fichier par langue (racine + table des sections, chargé pour la seule langue affichée) et un fragment par section (fetché au 1ᵉʳ montage, cache-singleton par langue), langue courante `µlang`, interpolation `%{var}`/pluriel, 3 modes placeholder (`auto`/`key`/`wait`), obfuscation des fragments en production
30. [🧩 Modules cœur & personnalisation](30-modules-coeur.md) — bibliothèque prête à l'emploi (`<@select>`, `<@field>`, `<@checkbox>`, `<@radio>`, `<@switch>`, `<@color>`, `<@code>`) et l'info-bulle universelle `@title` ; doctrine de personnalisation en trois leviers (variables `--mjs-*`, `::part()`, éjection du source sous le même nom) sous une règle commune de fair-play CSS (`:where()`)
31. [🎨 Thèmes, variables & variants](31-themes.md) — la variable de thème `$$nom` (lue et déclarée dans tout contexte de style), les thèmes nommés d'un composant (`theme="gold"`), les thèmes de document (`nom.theme.mjs`, imbriquables sur n'importe quel élément), les variants (`<style name="banner">` + `layout=`), la rune `µtheme`, les réglages `varPrefix`/`defaultTheme` et le registre des variables
32. [⌨️ Ligne de commande & configuration](32-cli-et-configuration.md) — les sept commandes (`mjs init`, `build`, `dev`, `check`, `serve`, `ws`, `serveur`), leurs drapeaux et leurs codes de sortie, puis la table complète des clés racine de `mjs.config.json` avec leurs types et leurs vraies valeurs par défaut
33. [🧪 Tester son application](33-tester-son-application.md) — le harnais `createHarness`/`mount` : compile le projet avec le vrai compilateur, charge un DOM simulé, monte un composant, agit dessus (`click`, `fire`, `type`, `set`) et lit ce qu'il affiche (`text`, `html`, `find`, `state`) ; pas un lanceur de tests, le même exemple tourne avec Mocha, Vitest ou Jest ; dépendance optionnelle `happy-dom`
34. [🔍 Déboguer une application](34-deboguer.md) — le panneau d'inspection dans la page (Ctrl+Shift+Espace, `µ.devPanel()`) : arbre des composants montés, état modifiable, dérivés **avec leurs dépendances** venues du compilateur ; les outils de console ; renvois vers le journal d'erreurs et l'atelier des variables de thème ; absent des builds de production
35. [🖼️ Images (`µimage` & `<@img>`)](35-images.md) — résolution au build en `{ src, srcset, sizes, width, height }` : dimensions natives sans dépendance (PNG/JPEG/GIF/WebP/AVIF/SVG, supprime le saut de mise en page) et variantes de largeur optionnelles (`sharp`, `npm i -D sharp`, jamais de build cassé) ; bloc de configuration `image` (`widths`/`formats`/`quality`) ; module cœur `<@img>`, lint d'accessibilité identique à `<img>`
36. [📲 Rendre son application installable](36-application-installable.md) — le build écrit `<outputDir>/mjs-precache.json` (liste triée des fichiers émis + leurs empreintes, version, rien en cas d'échec) à chaque build réussi ; aucun service worker fourni par le framework — la recette complète (manifeste web, service worker, enregistrement) est dans le chapitre ; la rune `µonline` pour un bandeau hors ligne ou un bouton désactivé

[📖 Glossaire — terminologie figée (français ↔ anglais)](glossaire.md) — le vocabulaire du framework fixé des deux côtés : un concept, un mot, dans toutes les pages et tous les messages. À lire avant d'écrire ou de traduire une page.

---
*Le tuto interactif (144 leçons) reste le parcours d'apprentissage de référence ; cette doc en est le pendant « consultation rapide ».*
