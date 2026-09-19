// catalogue FR — textes du compilateur, du CLI et des serveurs Node (langue par défaut).
// RÈGLE : la valeur fr reproduit EXACTEMENT le texte historique (émoji, espaces, \n compris) ;
// toute nouvelle chaîne utilisateur du périmètre Node DOIT naître ici (jamais en dur en source).

import type { MsgEntry, MsgVars } from './index.js'

export const fr = {

  // ═══ CLI (src/cli.ts, src/cli/) ══════════════════════════════════════════════════════════
  'cli.flag-valeur-manquante': ({ flag }: MsgVars) => `⚠️  ${flag} ignoré : valeur manquante.`,
  // — cli.ts
  // imprimée AVANT 'cli.build-rapport' quand stats.errors est non vide :
  // sans elle, la ligne ✅ s'affichait même sur un build partiellement en échec.
  'cli.build-rapport-echecs': ({ nb }: MsgVars) => `✗ ${nb} en échec`,
  'cli.build-rapport': ({ nb, ms }: MsgVars) => `\n✅ ${nb} fichiers écrits en ${ms}ms`,
  // purge des orphelins d'outputDir après un build sans erreur (cli.ts case 'build' → Bundler.pruneOrphans)
  'cli.build-purge': ({ nb, dossier }: MsgVars) => `🧹 ${nb} ${Number(nb) > 1 ? 'fichiers orphelins retirés' : 'fichier orphelin retiré'} de ${dossier} (plus produits par aucun build)`,
  'cli.build-purge-fichier': ({ fichier }: MsgVars) => `   – ${fichier}`,
  'cli.build-purge-echec': ({ fichier }: MsgVars) => `⚠️  ${fichier} : orphelin non retiré (suppression refusée par le système de fichiers)`,
  // `skipped` (Bundler.pruneOrphans) n'était JAMAIS
  // affiché côté CLI (seuls { removed, failed } étaient déstructurés) : un registre illisible/vide
  // ou un cache-hit sautait la purge SANS UN MOT, indiscernable d'un run sain « rien à purger ».
  'cli.build-purge-registre-illisible': ({ dossier }: MsgVars) => `⚠️  purge ignorée : le registre '.mjs-outputs.json' de ${dossier} est illisible ou de forme inattendue — relance un build pour le régénérer`,
  'cli.build-purge-registre-vide': ({ dossier }: MsgVars) => `⚠️  purge ignorée : le registre '.mjs-outputs.json' de ${dossier} ne liste aucune extension exploitable — relance un build pour le régénérer`,
  'cli.build-purge-cache': ({ dossier }: MsgVars) => `⚠️  purge ignorée : ce build a resservi au moins un composant depuis le cache — les assets annexes ne sont pas tous réémis, purger ${dossier} maintenant risquerait de retirer un fichier encore utilisé`,
  'cli.plus-n-autres': ({ nb }: MsgVars) => `+ ${nb} autres`,
  'cli.usage': `
mjs — ModularJS V2 compiler

Commands:
  mjs init        Scaffold mjs.config.json + structure de projet
  mjs build       Compile une fois et sort
  mjs dev         Watch + HMR (HTTP+WS sur --port, défaut 3939)
  mjs check       Vérifie la config et liste les composants détectés (compile réellement, comme 'build')
  mjs serve       Sert le rendu SSR/prérendu par requête (render.routes) — bloc render requis dans mjs.config.json (port 3000 par défaut)
  mjs ws          Lance le serveur temps réel (MJS-WS) — fichier d'entry ws.js/server/ws.js, cf. docs/23-mjs-ws.md
  mjs serveur     Lance le serveur de jeu (MJS-Server, mjsServer + app.game) — fichier d'entry serveur.js/server/serveur.js, cf. docs/24-mjs-server.md

Options:
  --root <dir>    Chemin racine du projet (défaut : cwd)
  --manifest <p>  Chemin du bundle_modular.js (entrypoint)
  --output <p>    Répertoire de sortie des fichiers compilés
  --port <n>      Port du serveur dev (défaut : 3939), du serveur ws (défaut : 4000) ou du serveur de jeu (défaut : 4001)
  --entry <p>     Fichier d'entry du serveur ws/serveur (mjs ws/mjs serveur) — défauts propres à chaque commande
  --once          Compile et sort, alias de build
  --dev           Force un build de DÉVELOPPEMENT (panneau d'inspection, pas de minification)
  --prod          Force un build de PRODUCTION (minifié, i18n haché, sans outils de dév)
                  Sans l'un ni l'autre : la clé 'env' de mjs.config.json, sinon NODE_ENV.
  -v, --version   Affiche la version de mjs et sort
  -h, --help      Affiche cette aide et sort
`,
  // `mjs --version` / `-v` — numéro NU précédé du nom de la commande, identique dans les deux
  // langues : un script qui le parse ne doit pas dépendre de la langue du projet
  'cli.version': ({ version }: MsgVars) => `mjs ${version}`,
  'cli.version-illisible': `❌ Version introuvable : le package.json du paquet mjs est illisible ou sans champ "version".`,
  'cli.port-invalide': ({ valeur }: MsgVars) => `⚠️  --port ignoré : "${valeur}" n'est pas un nombre valide (défaut conservé).`,
  'cli.flag-inconnu': ({ arg }: MsgVars) => `⚠️  Flag inconnu ignoré : "${arg}" (vérifie l'orthographe — voir 'mjs --help').`,
  'cli.argument-non-reconnu': ({ arg }: MsgVars) => `⚠️  Argument non reconnu ignoré : "${arg}" (commande mal orthographiée ? voir 'mjs --help').`,
  'cli.config-trouve': ({ dossier }: MsgVars) => `📋 mjs.config.json : ${dossier}/mjs.config.json`,
  'cli.env-dev': ({ origine }: MsgVars) => `🛠️  Build de DÉVELOPPEMENT (${origine}) — non minifié, panneau d'inspection inclus (Ctrl+Shift+Espace).`,
  'cli.source-origine-config': `« sourceDir » de mjs.config.json`,
  'cli.source-origine-defaut': `chemin par défaut, aucun « sourceDir » en config`,
  'cli.build-racine-vide': ({ commande, racine, source, origine }: MsgVars) => `
❌ [ModularJS] Dossier source INTROUVABLE — « mjs ${commande} » ANNULÉ, aucun fichier écrit.
   Cherché : ${source}
   (${origine})
   Lancé depuis : ${racine}

   Tu es probablement dans le mauvais dossier, il manque « --root <projet> », ou le chemin
   de la config ne correspond plus à ce qui est sur le disque.
   Sans ce refus, le build aurait écrit un manifeste VIDE (µ.paths = {}) par-dessus celui
   d'un site en place : plus un composant connu, page blanche, et code de sortie 0.`,
  'cli.build-aucun-composant': ({ commande, source }: MsgVars) => `
❌ [ModularJS] Aucun composant à construire — « mjs ${commande} » ANNULÉ, aucun fichier écrit.
   Dossier source : ${source}
   Il existe, mais ne contient pas un seul fichier « .mjs ».

   Vérifie « sourceDir » dans mjs.config.json, ou la racine que tu vises.
   C'est exactement le cas qui remplace un manifeste par un manifeste vide.`,
  'cli.env-prod': ({ origine }: MsgVars) => `🚀 Build de PRODUCTION (${origine}) — minifié, fragments i18n hachés, aucun outil de développement.`,
  'cli.env-origine-flag': 'imposé par --dev/--prod',
  'cli.env-origine-defaut': 'défaut de `mjs build` — `--prod` pour un build de production',
  'cli.avertissements-titre': ({ nb }: MsgVars) => `\n⚠️  ${nb} avertissement(s) :`,
  'cli.prerendu-debut': `\n🖨️  Prérendu des pages (render.routes) …`,
  'cli.prerendu-resultat': ({ nb, dossier }: MsgVars) => `   → ${nb} page(s) écrite(s) dans ${dossier}`,
  'cli.prerendu-page-ignoree': ({ url, raison }: MsgVars) => `   – ${url} ignorée : ${raison}`,
  'cli.prerendu-aucune-page': `   (aucune page en mode prerender déclarée)`,
  'cli.prerendu-echec': ({ erreur }: MsgVars) => `⚠️  Prérendu ignoré : ${erreur}`,
  'cli.ssr-requiert-happy-dom': '   (le SSR requiert happy-dom : `npm i -D happy-dom`)',
  'cli.css-seul-recharge': '🎨 CSS seul — rechargé à chaud (sans reload de page)',
  'cli.serve-bloc-render-requis': '⚠️  `mjs serve` nécessite un bloc `render` dans mjs.config.json.',
  'cli.serve-demarre': ({ hote, port }: MsgVars) => `\n🖥️  mjs serve — rendu par requête sur http://${hote}:${port}`,
  'cli.serve-mode-info': '   Mode par URL (render.routes) · override header X-MJS-Render · Ctrl+C pour arrêter.',
  'cli.serve-arret-echec': ({ erreur }: MsgVars) => `❌ mjs serve — l'arrêt n'a pas pu tout refermer : ${erreur}`,
  'cli.source-dir-introuvable': ({ dossier }: MsgVars) => `❌ Source dir introuvable : ${dossier}`,
  'cli.lancez-mjs-init': '   Lancez `mjs init` pour créer la structure de base.',
  'cli.check-compile-reel': ({ dossier }: MsgVars) => `⚠️  'mjs check' compile réellement (comme 'build') — les fichiers dans ${dossier} seront écrits/écrasés.`,
  'cli.composants-detectes': ({ nb }: MsgVars) => `📦 ${nb} composants détectés`,
  'cli.et-n-autres': ({ nb }: MsgVars) => `   ... et ${nb} autres`,
  'cli.erreurs-compilation': ({ nb }: MsgVars) => `❌ ${nb} erreurs de compilation :`,
  'cli.tout-compile-ok': ({ nb }: MsgVars) => `✅ Tout compile sans erreur (${nb} fichiers écrits).`,
  'cli.commande-inconnue': ({ commande }: MsgVars) => `Commande inconnue : ${commande}`,
  // une page render.routes DÉCLARÉE dont le RENDU échoue (par
  // opposition à route paramétrée/mode non buildable, skips voulus) fait échouer le build.
  'cli.prerendu-echec-fatal': ({ nb }: MsgVars) => `✗ ${nb} page(s) prérendue(s) en échec — build en échec.`,
  // i18n.default sans dictionnaire réel dans sourceDir/i18n/.
  'cli.i18n-default-sans-dictionnaire': ({ defaut, langues }: MsgVars) => `⚠️  i18n.default : '${defaut}' ne correspond à AUCUN dictionnaire trouvé dans sourceDir/i18n/ (langues présentes : ${langues}) — les visiteurs qui atterrissent sur la langue par défaut n'auront AUCUNE traduction.`,
  // --output/--manifest : garde AVANT compilation + repli catalogue.
  'cli.chemin-non-inscriptible': ({ cle, chemin, ancetre, erreur }: MsgVars) => `❌ ${cle} (${chemin}) : dossier non accessible en écriture (${ancetre}) — ${erreur}`,
  // --output pointe vers un FICHIER déjà existant.
  'cli.output-doit-etre-dossier': ({ cle, chemin }: MsgVars) => `❌ ${cle} (${chemin}) : doit être un dossier — un FICHIER existe déjà à ce chemin.`,
  // --manifest pointe vers un DOSSIER déjà existant (contrainte symétrique).
  'cli.manifest-doit-etre-fichier': ({ cle, chemin }: MsgVars) => `❌ ${cle} (${chemin}) : doit être un fichier — un DOSSIER existe déjà à ce chemin.`,
  // --output et --manifest désignent le même chemin résolu.
  'cli.output-manifest-identiques': ({ chemin }: MsgVars) => `❌ --output et --manifest désignent le MÊME chemin (${chemin}) — l'un écraserait l'autre en pleine compilation. Choisis deux chemins distincts.`,
  'cli.erreur-ecriture': ({ code, chemin, erreur }: MsgVars) => `❌ [mjs] impossible d'écrire (${code}) : ${chemin}\n   ${erreur}`,

  // — testing/index.ts (harnais de test des applications)
  'testing.pas-de-projet': ({ racine }: MsgVars) => `[mjs/testing] aucun mjs.config.json trouvé depuis ${racine}, et aucun sourceDir donné — passe { root: '…' } ou { sourceDir: '…' } à createHarness().`,
  'testing.compilation-en-echec': ({ detail }: MsgVars) => `[mjs/testing] le projet ne compile pas, le harnais ne peut rien monter :\n${detail}`,
  'testing.happy-dom-absent': `[mjs/testing] le DOM simulé est absent — installe-le : npm i -D happy-dom (dépendance optionnelle, le framework ne l'impose à personne).`,
  'testing.runtime-introuvable': ({ dossier }: MsgVars) => `[mjs/testing] aucun mjs_core-<empreinte>.js dans ${dossier} — le build n'a rien écrit là où le harnais regarde (vérifie outputDir).`,
  'testing.composant-en-echec': ({ nom, detail }: MsgVars) => `[mjs/testing] le composant '${nom}' n'a pas pu être chargé : ${detail}`,
  'testing.composant-inconnu': ({ nom, connus }: MsgVars) => `[mjs/testing] aucun composant '${nom}' dans le projet compilé. Connus : ${connus}`,
  'testing.selecteur-sans-noeud': ({ selecteur, tag }: MsgVars) => `[mjs/testing] aucun nœud ne correspond à '${selecteur}' dans <${tag}>.`,
  // — cli/init.ts
  'cli.init.dossier-existe': ({ d }: MsgVars) => `  ↪️  ${d} (existe déjà)`,
  'cli.init.dossier-cree': ({ d }: MsgVars) => `  ✅ ${d}/ créé`,
  'cli.init.config-existe': '  ↪️  mjs.config.json (existe déjà)',
  'cli.init.config-cree': '  ✅ mjs.config.json créé',
  'cli.init.hello-existe': '  ↪️  app/modularjs/hello.mjs (existe déjà)',
  'cli.init.hello-cree': '  ✅ app/modularjs/hello.mjs créé',
  'cli.init.fichier-existe': ({ f }: MsgVars) => `  ↪️  ${f} (existe déjà)`,
  'cli.init.fichier-cree': ({ f }: MsgVars) => `  ✅ ${f} créé`,
  'cli.init.resume': ({ cree, ignores }: MsgVars) => `📦 ${cree} fichiers/dossiers créés, ${ignores} ignorés`,
  'cli.init.pour-demarrer': 'Pour démarrer :',
  'cli.init.hmr-html': 'Inclure le HMR client dans votre HTML :',

  // — cli/ws.ts (+ clés partagées avec cli/server.ts, cf. risques §8)
  'cli.entry-cli-introuvable': ({ cliEntry, chemin }: MsgVars) => `--entry '${cliEntry}' → '${chemin}' introuvable.`,
  'cli.entry-config-introuvable': ({ champ, valeur, chemin }: MsgVars) => `${champ} '${valeur}' (mjs.config.json) → '${chemin}' introuvable.`,
  'cli.entry-aucun-trouve': ({ liste, racine }: MsgVars) => `aucun fichier d'entry trouvé (cherché : ${liste}, relatifs à --root '${racine}').`,
  'cli.ws.entry-introuvable': ({ raison, squelette }: MsgVars) => `[mjs ws] ${raison}\n\nCrée un fichier d'entry pour démarrer, par exemple 'ws.server.mjs' à la racine du projet (même dialecte que le <script> de tes composants) :\n\n${squelette}\nPuis relance 'mjs ws' (ou précise --entry <chemin>).`,
  'cli.aucun-export-defaut': 'aucun export par défaut',
  'cli.un-tableau': 'un tableau',
  'cli.entry-doit-export-default': ({ produit, entryPath, recu }: MsgVars) => `[${produit}] l'entry '${entryPath}' doit faire 'export default { ... }' (un OBJET) — reçu : ${recu}`,
  'cli.entry-cle-ignoree': ({ cle }: MsgVars) => `entry.${cle} ignorée : gérée par le CLI/la config`,
  'cli.entry-setup-doit-etre-fonction': ({ produit, entryPath, recu }: MsgVars) => `[${produit}] l'entry '${entryPath}' : 'setup' doit être une fonction (app) => … , reçu : ${recu}`,
  'cli.entry-config-doublon': ({ champ, chemin }: MsgVars) => `${champ} défini à la fois dans l'entry et dans mjs.config.json (${chemin}) — l'entry prime`,
  // — cli/server-entry.ts (grammaire @import d'une entry serveur)
  'cli.entry-directive-interdite': ({ entryPath, directive }: MsgVars) => `'${entryPath}' : la directive ${directive} n'a pas de sens dans une entry serveur — seule @import est admise.`,
  'cli.entry-import-cycle': ({ entryPath, chaine }: MsgVars) => `'${entryPath}' : cycle d'import détecté entre fichiers d'entry serveur (${chaine}).`,
  'cli.entry-import-introuvable': ({ entryPath, cible }: MsgVars) => `'${entryPath}' : cible @import '${cible}' introuvable (ni à côté de l'entry, ni sous --root).`,
  'cli.entry-import-natif-interdit': ({ section, source }: MsgVars) => `'${section}' : import ES natif interdit dans une entry serveur (« import … from '${source}' ») — écris @import nom '${source}' en tête de fichier, comme dans un composant.`,
  'cli.entry-import-dynamique-interdit': ({ section }: MsgVars) => `'${section}' : import('…') d'un chemin littéral interdit dans une entry serveur — écris @import nom 'chemin' en tête de fichier ; import(variable) reste autorisé.`,
  'cli.entry-reexport-interdit': ({ section, source }: MsgVars) => `'${section}' : ré-export ES interdit dans une entry serveur (« export … from '${source}' ») — importe le nom avec @import puis exporte-le.`,
  'cli.transport-ws': "ws (bibliothèque 'ws')",
  'cli.transport-personnalise': "personnalisé (instance fournie par l'entry)",
  'cli.banniere-port': ({ port, hote }: MsgVars) => `écoute sur le port ${port}${hote}`,
  'cli.desactive': 'désactivé',
  'cli.banniere-heartbeat': ({ etat }: MsgVars) => `heartbeat ${etat}`,
  'cli.illimite': 'illimité',
  // hôte effectif affiché en bannière même par défaut (mjs ws)
  'cli.toutes-interfaces': 'toutes les interfaces',
  'cli.banniere-limites': ({ rate, burst, kickAfter, maxPayload, maxBuffered, maxConnections, maxConnectionsPerIp }: MsgVars) => `limites : rate=${rate}/s burst=${burst} kickAfter=${kickAfter} maxPayload=${maxPayload}o maxBuffered=${maxBuffered}o maxConnections=${maxConnections} maxConnectionsPerIp=${maxConnectionsPerIp}`,
  'cli.banniere-salons-proxy': ({ url }: MsgVars) => `salons (join) : proxy ${url}`,
  'cli.banniere-jeton': ({ sweep, marge }: MsgVars) => `jeton : balayage ${sweep}s (marge ${marge}s)`,
  'cli.banniere-pont': ({ host, port }: MsgVars) => `pont universel : http://${host}:${port}`,
  'cli.banniere-webhooks-actifs': ({ url, evenements }: MsgVars) => `webhooks → ${url} (événements : ${evenements})`,
  'cli.banniere-webhooks-desactives': 'webhooks désactivés (opts.bridge.webhooks absent)',
  'cli.banniere-rate-limit-actif': ({ capacite, fenetre, echecsCapacite, echecsFenetre }: MsgVars) => `limite de débit : ${capacite} req/${fenetre}s par IP (échecs de signature : ${echecsCapacite}/${echecsFenetre}s)`,
  'cli.banniere-rate-limit-desactive': 'limite de débit désactivée (opts.bridge.rateLimit === false)',
  'cli.banniere-etat': ({ host, port }: MsgVars) => `état : http://${host}:${port}/state`,
  'cli.banniere-reprise-session': ({ grace, maxBuffered, maxBytes }: MsgVars) => `reprise de session : ${grace} s (tampon ${maxBuffered} trames / ${maxBytes}o)`,
  'cli.banniere-multi-processus-redis': ({ redis, prefixe }: MsgVars) => `multi-processus : ${redis} (préfixe ${prefixe})`,
  'cli.banniere-multi-processus-custom': ({ prefixe }: MsgVars) => `multi-processus : adaptateur personnalisé fourni (préfixe ${prefixe})`,
  'cli.ctrl-c-arreter': 'Ctrl-C pour arrêter',
  'cli.ws.erreur-compilation-civet': ({ entryPath, erreur }: MsgVars) => `[mjs ws] erreur de compilation Civet dans '${entryPath}' : ${erreur}`,
  'cli.ws.entry-markup-composant': ({ entryPath, indice }: MsgVars) => `[mjs ws] '${entryPath}' contient du markup de composant (${indice}) — un fichier serveur '*.server.mjs' n'est pas un composant .mjs : pas de <template>/<style>/HTML, seulement du Civet/JS ('export default { setup(app) { … } }').`,
  'cli.ws.erreur-compilation': ({ entryPath, erreur }: MsgVars) => `[mjs ws] erreur de compilation dans '${entryPath}' : ${erreur}`,
  // --port hors plage — même règle que ws.port (bundler/config.ts)
  'cli.ws.port-hors-plage': ({ valeur }: MsgVars) => `[mjs ws] port ${valeur} hors plage — attendu un entier entre 1 et 65535 (même règle que ws.port dans mjs.config.json)`,
  // --port hors plage pour `mjs serveur` — MÊME règle que ws.port-hors-plage ci-dessus
  'cli.serveur.port-hors-plage': ({ valeur }: MsgVars) => `[mjs serveur] port ${valeur} hors plage — attendu un entier entre 1 et 65535 (même règle que serveur.port dans mjs.config.json)`,
  'cli.reload-import-echec': ({ erreur }: MsgVars) => `rechargement ignoré — import de l'entry en échec : ${erreur} (l'ancien serveur continue de tourner)`,
  'cli.reload-echec-generique': ({ erreur }: MsgVars) => `rechargement ignoré — ${erreur} (l'ancien serveur continue de tourner)`,
  'cli.redemarre': ({ chemin }: MsgVars) => `♻️  redémarré (${chemin})`,
  'cli.reload-echec-fatal': ({ erreur }: MsgVars) => `rechargement échoué après l'arrêt de l'ancien serveur — plus aucun serveur actif : ${erreur}`,

  // — cli/server.ts (clés propres ; réutilise aussi les clés partagées ci-dessus)
  'cli.serveur.entry-introuvable': ({ raison, squelette }: MsgVars) => `[mjs serveur] ${raison}\n\nCrée un fichier d'entry pour démarrer, par exemple 'serveur.server.mjs' à la racine du projet (même dialecte que le <script> de tes composants ; l'app mjsServer() est construite par le CLI et passée à setup(app) — aucun import à écrire) :\n\n${squelette}\nPuis relance 'mjs serveur' (ou précise --entry <chemin>).`,
  'cli.serveur.anti-triche': ({ n, fenetre }: MsgVars) => `anti-triche : quota ${n} coups/identité par ${fenetre}s (toutes parties confondues)`,

  // — cli/dev-lock.ts
  'cli.dev-lock.deja-actif': ({ pid }: MsgVars) => `❌ Un autre 'mjs dev' tourne déjà (PID ${pid}).`,
  'cli.dev-lock.lockfile-chemin': ({ chemin }: MsgVars) => `   Lockfile : ${chemin}`,
  'cli.dev-lock.pour-forcer': ({ pid }: MsgVars) => `   Pour forcer : 'kill ${pid}' (ou supprime le lockfile s'il est obsolète).`,
  'cli.dev-lock.orphelin': ({ pid }: MsgVars) => `⚠️  Lockfile orphelin (PID ${pid} mort ou recyclé) — récupération.`,
  'cli.dev-lock.echec-acquisition': ({ chemin }: MsgVars) => `❌ Impossible d'acquérir le lock dev (${chemin}) — un autre processus vient de le reprendre.`,

  // — cli/dev-prerender.ts
  'cli.dev-prerender.echec': ({ erreur }: MsgVars) => `⚠️  Prérendu (dev) ignoré : ${erreur}`,

  // ═══ SIGILS (src/sigils.ts) ══════════════════════════════════════════════════════════════
  // — sigils.ts
  'sigils.vault-retire': ({ nom }: MsgVars) => `[ModularJS] « &$${nom} » : le sigil « &$ » (vault) a été retiré — utilise « $$${nom} » (store global réactif, zéro import).`,
  'sigils.singleton-importe': ({ nom }: MsgVars) => `[ModularJS] « $$${nom} » : « ${nom} » est un singleton importé (@import µ$$${nom}) — consomme-le avec « µ$$${nom} », pas « $$${nom} » (qui désigne le store GLOBAL, un autre espace).`,

  // ═══ BUNDLER (src/bundler/) ════════════════════════════════════════════════════════════════════
  // — config.ts
  'bundler.config.runtime-paquet-non-implemente': ({ paquet }: MsgVars) => `[mjs.config.json] runtime : paquet '${paquet}' pas encore implémenté`,
  'bundler.config.vt-valeur-vide': 'valeur vide',
  'bundler.config.vt-valeur-malformee': ({ valeur }: MsgVars) => `valeur malformée '${valeur}'`,
  'bundler.config.vt-direction-dans-nom': ({ nom, avant }: MsgVars) => `la direction ne s'écrit plus dans le nom ('${nom}') — utilise la clé 'direction'/'dir' en option (ex. ${avant}={ dir: left }).`,
  'bundler.config.vt-nom-invalide': ({ nom }: MsgVars) => `nom invalide '${nom}'`,
  'bundler.config.vt-option-malformee': ({ option }: MsgVars) => `option malformée '${option}' — attendu 'clé: valeur'`,
  'bundler.config.vt-option-cle-inconnue': ({ cle, hint, valides }: MsgVars) => `clé inconnue '${cle}'${hint} (clés valides : ${valides})`,
  'bundler.config.vt-cle-double': ({ cle, court }: MsgVars) => `clé en double '${cle}' — '${cle}' et '${court}' désignent la MÊME option, ne la pose qu'une fois`,
  'bundler.config.vt-direction-non-directionnelle': ({ base, bases }: MsgVars) => `clé 'direction' invalide sur la base '${base}' (non directionnelle) — bases directionnelles : ${bases}`,
  'bundler.config.vt-direction-invalide': ({ valeur, valides }: MsgVars) => `direction invalide '${valeur}' — valeurs valides : ${valides}`,
  'bundler.config.vt-duration-invalide': `duration : un nombre nu en millisecondes (comme setTimeout) — ex. dur: 600`,
  'bundler.config.vt-priority-invalide': ({ valeur }: MsgVars) => `priority invalide '${valeur}' — entier ≥ 0 attendu`,
  'bundler.config.doit-etre-objet-racine': ({ chemin }: MsgVars) => `[mjs.config.json] doit être un objet (${chemin})`,
  'bundler.config.env-vient-de-la-commande': ({ chemin }: MsgVars) => `[mjs.config.json] la clé 'env' n'existe pas : l'environnement du build vient de la COMMANDE.\n  \`mjs build\` construit en développement, \`mjs build --prod\` en production.\n  Retire la clé de ${chemin}.`,
  'bundler.config.cle-inconnue-racine': ({ cle, chemin, valides }: MsgVars) => `[mjs.config.json] clé inconnue '${cle}' dans ${chemin}\n  Clés valides : ${valides}`,
  'bundler.config.valeur-invalide-simple': ({ cle, valeur, valides }: MsgVars) => `[mjs.config.json] ${cle} invalide : '${valeur}'\n  Valeurs valides : ${valides}`,
  'bundler.config.sigil-invalide': ({ valeur, valides }: MsgVars) => `[mjs.config.json] sigil invalide : '${valeur}'\n  Valeurs valides : ${valides}`,
  'bundler.config.doit-etre-chaine': ({ cle, valeur, type }: MsgVars) => `[mjs.config.json] ${cle} doit être une chaîne, reçu : ${valeur} (${type})`,
  // urlPrefix sans slash initial (chemin ambigu).
  'bundler.config.urlprefix-slash-initial-exige': ({ valeur }: MsgVars) => `[mjs.config.json] urlPrefix doit commencer par '/', reçu : ${valeur}`,
  'bundler.config.doit-etre-booleen': ({ cle, valeur, type }: MsgVars) => `[mjs.config.json] ${cle} doit être un booléen (true/false), reçu : ${valeur} (${type})`,
  'bundler.config.dev-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] 'dev' doit être un objet { port?, host? } (${chemin})`,
  'bundler.config.dev-cle-inconnue': ({ cle }: MsgVars) => `[mjs.config.json] dev.${cle} : clé inconnue (valides: port, host)`,
  'bundler.config.dev-port-doit-etre-nombre': ({ valeur, type }: MsgVars) => `[mjs.config.json] dev.port doit être un nombre, reçu : ${valeur} (${type})`,
  'bundler.config.port-hors-plage': ({ cle, valeur }: MsgVars) => `[mjs.config.json] ${cle} doit être un entier entre 1 et 65535, reçu : ${valeur}`,
  'bundler.config.view-transition-invalide-generique': ({ valeur, bases, basesDir }: MsgVars) => `[mjs.config.json] viewTransition invalide : '${valeur}'\n  Valeur attendue : "none", une base (${bases}), éventuellement suivie d'options "base={ direction: …, duration: …, priority: … }" (direction réservée aux bases directionnelles : ${basesDir}) — aucun booléen accepté`,
  'bundler.config.view-transition-invalide-detail': ({ valeur, erreur }: MsgVars) => `[mjs.config.json] viewTransition invalide : '${valeur}' — ${erreur}`,
  'bundler.config.default-script-lang-conflit': ({ a, b }: MsgVars) => `[mjs.config.json] defaultScriptLang ('${a}') et languages.script ('${b}') diffèrent — garde une seule des deux clés.`,
  'bundler.config.runtime-invalide-chaine': ({ valeur, modules }: MsgVars) => `[mjs.config.json] runtime invalide : '${valeur}'\n  Valeurs valides : 'all', 'core', ou un tableau de modules optionnels (${modules})`,
  'bundler.config.runtime-doit-etre-tableau': ({ valeur, type, chemin }: MsgVars) => `[mjs.config.json] runtime doit être 'all', 'core' ou un tableau de modules, reçu : ${valeur} (${type}) (${chemin})`,
  'bundler.config.runtime-module-doit-etre-chaine': ({ valeur, type }: MsgVars) => `[mjs.config.json] runtime[] : chaque module doit être une chaîne, reçu : ${valeur} (${type})`,
  'bundler.config.runtime-module-core': ({ module, modules }: MsgVars) => `[mjs.config.json] runtime : '${module}' fait déjà partie du CŒUR (toujours inclus) — ne le liste pas.\n  Modules optionnels valides : ${modules}`,
  'bundler.config.runtime-module-inconnu': ({ module, modules, presets }: MsgVars) => `[mjs.config.json] runtime : module inconnu '${module}'\n  Modules optionnels valides : ${modules} — ou un préréglage : ${presets}`,
  'bundler.config.preload-invalide': ({ valeur, valides }: MsgVars) => `[mjs.config.json] preload invalide : '${valeur}'\n  Valeurs valides : ${valides} (ou un objet { view?, page? })`,
  'bundler.config.preload-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] 'preload' doit être une chaîne ou un objet { view?, page? } (${chemin})`,
  'bundler.config.preload-axes-renommes': `[mjs.config.json] preload : les axes « local »/« server » ont été renommés — écris « view » (préchargement du module de vue) et « page » (préchargement de la page serveur).`,
  'bundler.config.cle-inconnue': ({ cle, valides }: MsgVars) => `[mjs.config.json] ${cle} : clé inconnue\n  Clés valides : ${valides}`,
  'bundler.config.preload-axis-invalide': ({ axe, valeur, valides }: MsgVars) => `[mjs.config.json] preload.${axe} invalide : '${valeur}'\n  Valeurs valides : ${valides}`,
  'bundler.config.css-mode-invalide': ({ valeur, valides }: MsgVars) => `[mjs.config.json] css invalide : '${valeur}'\n  Valeurs valides : ${valides}`,
  'bundler.config.js-mode-invalide': ({ valeur, valides }: MsgVars) => `[mjs.config.json] js invalide : '${valeur}'\n  Valeurs valides : ${valides}`,
  'bundler.config.js-bundle-exige-css-bundle': () => `[mjs.config.json] js: 'bundle' est incompatible avec css: 'split'/'lazy'.\n  Le mode fusionné regroupe TOUT (cœur, styles, animations, composants) dans un seul fichier — un CSS déjà découpé en fichiers séparés contredirait « un seul fichier JS ».\n  Correctif : retirez la clé css (défaut 'bundle') ou posez js: 'split'.`,
  'bundler.config.csp-incompatible-js-bundle': () => `[mjs.config.json] csp: true est incompatible avec js: 'bundle'.\n  Le mode strict exige un CSS DÉCOUPÉ (des <link> vers des feuilles séparées) ; le mode js fusionné exige au contraire un CSS FUSIONNÉ (css: 'bundle', un seul fichier JS) — aucune valeur de css ne peut satisfaire les deux à la fois.\n  Correctif : retirez csp (ou posez-le à false), ou repassez js à 'split'.`,
  'bundler.config.source-map-mode-invalide': ({ valeur, valides }: MsgVars) => `[mjs.config.json] sourceMap invalide : ${valeur}\n  Valeurs valides : ${valides}`,
  'bundler.config.csp-exige-css-decoupe': () => `[mjs.config.json] csp: true est incompatible avec css: 'bundle'.\n  Le mode strict remplace les <style> en ligne du rendu serveur par des <link> vers les feuilles émises, qui n'existent qu'en CSS découpé.\n  Correctif : posez css: 'split' (une feuille par module) ou css: 'lazy' (chargée à la demande).`,
  'bundler.config.lint-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] 'lint' doit être un objet { maxStateVars?, a11y? } (${chemin})`,
  'bundler.config.lint-max-state-vars-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] lint.maxStateVars doit être un entier ≥ 0 (0 pour désactiver l'avertissement), reçu : ${valeur} (${type})`,
  'bundler.config.lint-a11y-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] lint.a11y doit être un booléen (true/false), reçu : ${valeur} (${type})`,
  'bundler.config.lint-ujs-form-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] lint.ujsForm doit être un booléen (true/false), reçu : ${valeur} (${type})`,
  'bundler.config.log-level-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] 'logLevel' doit être une chaîne ou un objet { dev?, prod? } (${chemin})`,
  'bundler.config.log-level-invalide': ({ valeur, valides }: MsgVars) => `[mjs.config.json] logLevel invalide : '${valeur}'\n  Valeurs valides : ${valides} (ou un objet { dev?, prod? })`,
  'bundler.config.log-level-env-invalide': ({ env, valeur, valides }: MsgVars) => `[mjs.config.json] logLevel.${env} invalide : '${valeur}'\n  Valeurs valides : ${valides}`,
  'bundler.config.ws-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] 'ws' doit être un objet { entry?, transport?, port?, host?, heartbeat?, limits?, resume?, bridge? } (${chemin})`,
  'bundler.config.cle-inconnue-hint': ({ cle, hint, valides }: MsgVars) => `[mjs.config.json] ${cle} : clé inconnue${hint}\n  Clés valides : ${valides}`,
  'bundler.config.transport-invalide': ({ cle, valeur, hint, valides }: MsgVars) => `[mjs.config.json] ${cle} invalide : ${valeur}${hint}\n  Valeurs valides : ${valides} (une instance MjsWsTransport maison se fournit depuis l'entry, pas la config)`,
  'bundler.config.codec-invalide': ({ cle, valeur, hint, valides }: MsgVars) => `[mjs.config.json] ${cle} invalide : ${valeur}${hint}\n  Valeurs valides : ${valides}`,
  'bundler.config.entier-positif-ms-invalide': ({ cle, valeur, type }: MsgVars) => `[mjs.config.json] ${cle} doit être un entier > 0 (ms), reçu : ${valeur} (${type})`,
  'bundler.config.limits-doit-etre-objet': ({ cle, chemin }: MsgVars) => `[mjs.config.json] ${cle} doit être un objet { rate?, burst?, kickAfter?, maxPayload?, maxBuffered?, maxConnections?, maxConnectionsPerIp?, maxRoomsPerClient? } (${chemin})`,
  'bundler.config.limits-cle-invalide': ({ cle, suffixe, valeur, type }: MsgVars) => `[mjs.config.json] ${cle} doit être un entier > 0${suffixe}, reçu : ${valeur} (${type})`,
  'bundler.config.adapter-doit-etre-objet': ({ cle, chemin }: MsgVars) => `[mjs.config.json] '${cle}' doit être un objet { redis, prefix?, antiEntropy? } (${chemin})`,
  'bundler.config.adapter-redis-requis': ({ cle }: MsgVars) => `[mjs.config.json] ${cle} est requis (chaîne non vide, ex. 'redis://127.0.0.1:6379')`,
  'bundler.config.chaine-non-vide-invalide': ({ cle, valeur, type }: MsgVars) => `[mjs.config.json] ${cle} doit être une chaîne non vide, reçu : ${valeur} (${type})`,
  'bundler.config.entier-ou-false-invalide': ({ cle, valeur, type }: MsgVars) => `[mjs.config.json] ${cle} doit être un entier > 0 (ms) ou false, reçu : ${valeur} (${type})`,
  'bundler.config.token-doit-etre-objet': ({ cle, valeur, type, chemin }: MsgVars) => `[mjs.config.json] '${cle}' doit être un objet { sweep?, slack? }, reçu : ${valeur} (${type}) (${chemin})`,
  'bundler.config.entier-positif-invalide': ({ cle, valeur, type }: MsgVars) => `[mjs.config.json] ${cle} doit être un entier > 0, reçu : ${valeur} (${type})`,
  'bundler.config.resume-doit-etre-objet': ({ cle, valeur, type, chemin }: MsgVars) => `[mjs.config.json] ${cle} doit être true, false ou un objet { grace?, maxBuffered?, maxBytes? }, reçu : ${valeur} (${type}) (${chemin})`,
  'bundler.config.bridge-doit-etre-objet': ({ cle, chemin }: MsgVars) => `[mjs.config.json] '${cle}' doit être un objet { port?, host?, secret?, webhooks?, rateLimit?, nonce? } (${chemin})`,
  'bundler.config.webhooks-doit-etre-objet': ({ cle, chemin }: MsgVars) => `[mjs.config.json] ${cle} doit être un objet { url, secret?, events, timeoutMs? } (${chemin})`,
  'bundler.config.webhooks-url-requis': ({ cle }: MsgVars) => `[mjs.config.json] ${cle} est requis (chaîne non vide)`,
  'bundler.config.webhooks-events-invalide': ({ cle }: MsgVars) => `[mjs.config.json] ${cle} doit être un tableau NON VIDE de chaînes (ex. ['connect', 'message:chat'])`,
  'bundler.config.doit-etre-booleen-simple': ({ cle, valeur, type }: MsgVars) => `[mjs.config.json] ${cle} doit être un booléen, reçu : ${valeur} (${type})`,
  'bundler.config.route-light-sans-effet-csr': ({ url }: MsgVars) => `[mjs.config.json] render.routes['${url}'].light est sans effet sur une route 'csr' : le serveur n'y rend rien, la racine est montée par le client seul.`,
  'bundler.config.ratelimit-doit-etre-objet': ({ cle, valeur, type, chemin }: MsgVars) => `[mjs.config.json] ${cle} doit être 'false' ou un objet { perIp?, fails? }, reçu : ${valeur} (${type}) (${chemin})`,
  'bundler.config.ratelimit-tuple-invalide': ({ cle, valeur }: MsgVars) => `[mjs.config.json] ${cle} doit être un tableau [capacité, fenêtreMs] de 2 entiers > 0, reçu : ${valeur}`,
  'bundler.config.serveur-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] 'serveur' doit être un objet { entry?, transport?, port?, host?, heartbeat?, limits?, resume?, bridge?, antiCheat? } (${chemin})`,
  'bundler.config.session-exclusive-invalide': ({ cle, valeur, hint, valides }: MsgVars) => `[mjs.config.json] ${cle} invalide : ${valeur}${hint}\n  Valeurs valides : true, false, ${valides}`,
  'bundler.config.verify-origin-invalide': ({ cle, valeur }: MsgVars) => `[mjs.config.json] ${cle} doit être un tableau non vide de chaînes non vides, reçu : ${valeur}`,
  'bundler.config.antitriche-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] 'serveur.antiCheat' doit être un objet { movesPerIdentity?, codePerIp? } (${chemin})`,
  'bundler.config.moves-per-identity-invalide': ({ valeur }: MsgVars) => `[mjs.config.json] serveur.antiCheat.movesPerIdentity doit être [n entier ≥ 1, fenêtreMs entier > 0] ou null, reçu : ${valeur}`,
  'bundler.config.code-per-ip-invalide': ({ valeur }: MsgVars) => `[mjs.config.json] serveur.antiCheat.codePerIp doit être [n entier ≥ 1, fenêtreMs entier > 0] ou null, reçu : ${valeur}`,
  'bundler.config.languages-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] 'languages' doit être un objet { script?, template? } (${chemin})`,
  'bundler.config.i18n-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] 'i18n' doit être un objet { default?, placeholder?, hash? } (${chemin})`,
  'bundler.config.i18n-default-invalide': ({ valeur }: MsgVars) => `[mjs.config.json] i18n.default doit être une chaîne non vide (code langue), reçu : ${valeur}`,
  'bundler.config.i18n-placeholder-invalide': ({ valeur, valides }: MsgVars) => `[mjs.config.json] i18n.placeholder invalide : '${valeur}'\n  Valeurs valides : ${valides} (défaut 'auto')`,
  'bundler.config.i18n-source-invalide': ({ valeur }: MsgVars) => `[mjs.config.json] i18n.source doit être une chaîne non vide (code langue), reçu : ${valeur}`,
  'bundler.config.journal-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] 'journal' doit être un objet { server?, client?, viewer?, maxEntries?, maxBytes? } (${chemin})`,
  'bundler.config.journal-viewer-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] journal.viewer doit être un booléen ou une chaîne non vide (jeton), reçu : ${valeur} (${type})`,
  'bundler.config.booleen-defaut-invalide': ({ cle, defaut, valeur }: MsgVars) => `[mjs.config.json] ${cle} doit être un booléen (défaut ${defaut}), reçu : ${valeur}`,
  'bundler.config.forward-origin-vide': `[mjs.config.json] render.forwardOrigin (origine) ne peut pas être une chaîne vide — attendu une URL d'origine, ex. 'https://exemple.com'`,
  'bundler.config.forward-origin-url-invalide': ({ valeur }: MsgVars) => `[mjs.config.json] render.forwardOrigin doit être une URL d'origine valide (ex. 'https://exemple.com'), reçu : ${valeur}`,
  'bundler.config.forward-origin-cle-inconnue': ({ cle }: MsgVars) => `[mjs.config.json] ${cle} : clé inconnue\n  Clé valide : trustedHosts`,
  'bundler.config.trusted-hosts-invalide': ({ valeur }: MsgVars) => `[mjs.config.json] render.forwardOrigin.trustedHosts doit être un tableau non vide de noms d'hôte (chaînes), reçu : ${valeur}`,
  'bundler.config.trusted-host-item-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] render.forwardOrigin.trustedHosts[] : chaque hôte doit être une chaîne non vide, reçu : ${valeur} (${type})`,
  'bundler.config.forward-origin-trusted-host-invalide': ({ index, valeur }: MsgVars) => `[mjs.config.json] render.forwardOrigin.trustedHosts[${index}] : ${valeur} — attendu un nom d'hôte nu, sans port, sans crochets, sans chemin ; une IPv4 mappée s'écrit en hexadécimal (\`::ffff:102:304\`), jamais en pointé (\`::ffff:1.2.3.4\`)`,
  'bundler.config.forward-origin-trusted-host-non-canonique': ({ index, valeur, canonique }: MsgVars) => `[mjs.config.json] render.forwardOrigin.trustedHosts[${index}] : ${valeur} n'est pas la forme canonique de cet hôte — écrire "${canonique}" (c'est cette forme, normalisée, que le serveur compare à l'en-tête Host)`,
  // avertissement NON bloquant (pas un throw) : un hôte
  // ACCEPTÉ (regex + forme canonique) mais désignant une cible interne reste listé, le build
  // continue — cf. `validateForwardOrigin`, bundler/config.ts.
  'bundler.config.forward-origin-trusted-host-interne': ({ index, valeur }: MsgVars) => `[mjs.config.json] render.forwardOrigin.trustedHosts[${index}] : ${valeur} est un hôte interne (loopback, réseau privé, lien-local, métadonnées) — listé ici mais toujours bloqué à l'exécution par la défense en profondeur du forwarding : cette entrée n'activera jamais rien`,
  'bundler.config.forward-origin-type-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] render.forwardOrigin doit être un booléen, une origine (chaîne, ex. 'https://exemple.com') ou { trustedHosts: string[] }, reçu : ${valeur} (${type})`,
  'bundler.config.render-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] 'render' doit être un objet (${chemin})`,
  'bundler.config.doit-etre-chaine-simple': ({ cle, chemin }: MsgVars) => `[mjs.config.json] ${cle} doit être une chaîne (${chemin})`,
  'bundler.config.render-outdir-hors-projet': ({ valeur, chemin }: MsgVars) => `[mjs.config.json] render.outDir doit rester dans le dossier du projet (${chemin}) — le prérendu y écrit ses fragments ET en retire les périmés ; reçu : '${valeur}'`,
  'bundler.config.render-target-invalide': ({ valeur }: MsgVars) => `[mjs.config.json] render.target doit être une chaîne non vide (sélecteur CSS du contenant), reçu : ${valeur}`,
  'bundler.config.render-cache-invalide': ({ valeur, valides }: MsgVars) => `[mjs.config.json] render.cache invalide : '${valeur}'\n  Valeurs valides : ${valides}`,
  'bundler.config.startup-bundle-avec-js-bundle': () => `[mjs.config.json] render.startup: 'bundle' et js: 'bundle' ensemble : incompatibles.\n  js: 'bundle' livre déjà TOUT le projet dans un fichier unique — un fichier de page n'aurait rien à assembler.\n  Garde l'un des deux : js: 'split' (défaut) avec render.startup: 'bundle', ou js: 'bundle' avec render.startup: 'preload'.`,
  'bundler.config.startup-slug-collision': ({ slug, urls }: MsgVars) => `[mjs.config.json] render.startup: 'bundle' — ces routes donnent le même nom de fichier de page (mjs_page-${slug}) : ${urls}\n  Le nom vient de l'URL (tout ce qui n'est pas une lettre ou un chiffre devient un tiret) : une seule des deux garderait son fichier.\n  Change l'une des URLs, ou pose "startup": "preload" sur l'une d'elles.`,
  'bundler.config.render-routes-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] render.routes doit être un objet { "<url>": { component, mode? } } (${chemin})`,
  'bundler.config.route-doit-etre-objet': ({ url }: MsgVars) => `[mjs.config.json] render.routes['${url}'] doit être un objet { component, mode? }`,
  'bundler.config.route-component-requis': ({ url }: MsgVars) => `[mjs.config.json] render.routes['${url}'].component (nom du composant) est requis`,
  'bundler.config.locales-invalide': ({ valeur, type, chemin }: MsgVars) => `[mjs.config.json] render.locales doit être un tableau de langues (chaînes), reçu : ${valeur} (${type}) (${chemin})`,
  'bundler.config.locale-item-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] render.locales[] : chaque langue doit être une chaîne non vide, reçu : ${valeur} (${type})`,
  'bundler.config.render-engine-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] render.engine doit être un objet { prerender?, request? } (${chemin})`,
  'bundler.config.browserpool-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] render.browserPool doit être un objet { size?, keepAlive?, maxAgeMs?, renderTimeoutMs? } (${chemin})`,
  'bundler.config.browserpool-size-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] render.browserPool.size doit être un entier ≥ 1, reçu : ${valeur} (${type})`,
  'bundler.config.browserpool-maxagems-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] render.browserPool.maxAgeMs doit être un entier ≥ 0, reçu : ${valeur} (${type})`,
  'bundler.config.browserpool-rendertimeoutms-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] render.browserPool.renderTimeoutMs doit être un entier ≥ 1, reçu : ${valeur} (${type})`,
  'bundler.config.renderqueue-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] render.renderQueue doit être un objet { concurrency?, maxQueue? } (${chemin})`,
  'bundler.config.renderqueue-concurrency-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] render.renderQueue.concurrency doit être un entier ≥ 1, reçu : ${valeur} (${type})`,
  'bundler.config.renderqueue-maxqueue-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] render.renderQueue.maxQueue doit être un entier ≥ 0, reçu : ${valeur} (${type})`,
  'bundler.config.image-doit-etre-objet': ({ chemin }: MsgVars) => `[mjs.config.json] image doit être un objet { widths?, formats?, quality? } (${chemin})`,
  'bundler.config.image-widths-invalide': ({ valeur }: MsgVars) => `[mjs.config.json] image.widths doit être une liste non vide d'entiers ≥ 1, reçu : ${valeur}`,
  'bundler.config.image-formats-invalide': ({ valeur, valides }: MsgVars) => `[mjs.config.json] image.formats doit être une liste non vide parmi ${valides}, reçu : ${valeur}`,
  'bundler.config.image-quality-invalide': ({ valeur }: MsgVars) => `[mjs.config.json] image.quality doit être un entier de 1 à 100, reçu : ${valeur}`,
  'bundler.config.suggestion-hint': ({ suggestion }: MsgVars) => ` — tu voulais dire '${suggestion}' ?`,
  'bundler.config.limite-nullable-suffixe': ' (ou null = illimité)',
  'bundler.config.allowed-origins-invalide': ({ valeur, type }: MsgVars) => `[mjs.config.json] render.allowedOrigins doit être un tableau de chaînes (ou false), reçu : ${valeur} (${type})`,
  'bundler.config.allowed-origins-item-invalide': ({ index, valeur, type }: MsgVars) => `[mjs.config.json] render.allowedOrigins[${index}] doit être une chaîne non vide, reçu : ${valeur} (${type})`,
  'bundler.config.parse-error': ({ chemin, erreur }: MsgVars) => `[mjs.config.json] erreur de syntaxe JSON dans ${chemin} : ${erreur}`,
  // — index.ts
  'bundler.index.collision-basename-tag': ({ cle, prev, fichier }: MsgVars) => `[bundler] Collision de basename : '${cle}' est publié à la fois par ${prev} ET ${fichier} (tag <mjs-${cle}>). L'autoloader ne pourra résoudre qu'un seul des deux composants (le dernier compilé) — l'autre restera inerte, silencieusement. Renommez l'un des fichiers.`,
  'bundler.index.erreur-fichier': ({ fichier, raison }: MsgVars) => `[bundler] ${fichier}: ${raison}`,
  // repêchage réussi : l'ancien fichier hashé du composant en échec est
  // toujours servi, aucune coupure pour l'utilisateur (juste une version figée).
  'bundler.index.composant-echec-ancienne-version': ({ nom, fichier }: MsgVars) => `[bundler] ${nom} : compilation en échec — l'ancienne version (${fichier}) reste servie.`,
  'bundler.index.composant-echec-non-repeche': ({ nom }: MsgVars) => `[bundler] ${nom} : compilation en échec — le build échoue et l'ancienne version n'est plus référencée ; corrige le composant, ou lance \`mjs dev\` pour continuer à servir la précédente.`,
  'bundler.index.animation-inconnue': ({ nom, dossier }: MsgVars) => `[bundler] Animation inconnue : '${nom}' référencée via @transition/@in/@out mais absente de ${dossier} (typo ?). Le composant qui l'utilise échouera SILENCIEUSEMENT à l'exécution ('µ.anim.${nom}' est undefined).`,
  'bundler.index.collision-basename-module': ({ nom, precedent, fichier }: MsgVars) => `[bundler] Collision de basename : '${nom}' présent dans ${precedent} ET ${fichier}. Les deux modules compilent vers le même fichier → écrasement + import 404 dans le .mjs qui référence le perdant. Renommez l'un des fichiers.`,
  'bundler.index.runtime-module-inconnu-ignore': ({ module, modules }: MsgVars) => `[bundler] runtime : module inconnu '${module}' ignoré (optionnels : ${modules})`,
  'bundler.index.runtime-hint-ujs': `[bundler] runtime : 'ujs' intercepte les liens vers µ.Router, absent de ta sélection — l'interception restera inerte. Ajoute 'router' (et 'ajax' pour le préchargement) pour la nav SPA.`,
  'bundler.index.runtime-hint-game': `[bundler] runtime : 'game' ajoute sock.game() à µ.socket, absent de ta sélection — sock.game restera indéfini. Ajoute 'socket'.`,
  'bundler.index.runtime-hint-chat': `[bundler] runtime : 'chat' ajoute sock.chat() à µ.socket, absent de ta sélection — sock.chat restera indéfini. Ajoute 'socket'.`,
  'bundler.index.runtime-hint-accounts': `[bundler] runtime : 'accounts' ajoute sock.account à µ.socket, absent de ta sélection — sock.account restera indéfini. Ajoute 'socket'.`,
  'bundler.index.runtime-hint-lobby': `[bundler] runtime : 'lobby' ajoute sock.lobby() à µ.socket, absent de ta sélection — sock.lobby restera indéfini. Ajoute 'socket'.`,
  'bundler.index.runtime-hint-schema': `[bundler] runtime : 'schema' ajoute le binaire à schéma à µ.socket, absent de ta sélection — µ.schema() reste utilisable (registre pur) mais jamais branché au réseau. Ajoute 'socket'.`,
  'bundler.index.runtime-hint-optimistic': `[bundler] runtime : 'optimistic' s'utilise typiquement avec sock.request(), 'socket' absent de ta sélection — µ.optimistic() reste utilisable seul (ex. via: -> fetch(...)) mais jamais avec sock.request. Ajoute 'socket' si besoin.`,
  'bundler.index.runtime-hint-interp': `[bundler] runtime : 'interp' interpole les parties de sock.game(), 'game' absent de ta sélection — µ.interp() n'aura aucune partie à observer. Ajoute 'game'.`,
  'bundler.index.runtime-hint-predict': `[bundler] runtime : 'predict' prédit/réconcilie les intentions de sock.game(), 'game' absent de ta sélection — µ.predict() n'aura aucune partie à piloter. Ajoute 'game'.`,
  'bundler.index.runtime-hint-lockstep-game': `[bundler] runtime : 'lockstep' pilote les parties de sock.game(), 'game' absent de ta sélection — µ.lockstep() n'aura aucune partie à piloter. Ajoute 'game'.`,
  'bundler.index.runtime-hint-lockstep-det': `[bundler] runtime : 'lockstep' utilise µ.random (graine déterministe) pour rejouer le journal, 'det' absent de ta sélection — µ.lockstep restera indéfini. Ajoute 'det'.`,
  'bundler.index.runtime-introuvable': ({ manquants, total, dossier, liste }: MsgVars) => `[bundler] Runtime introuvable : ${manquants}/${total} fichier(s) manquant(s) dans '${dossier}' (${liste}). Vérifie 'runtimeDir' dans mjs.config.json ou l'installation de ModularJS.`,
  'bundler.index.contrat-coeur-rompu': ({ manquants, nb, modules }: MsgVars) => `[bundler] Cœur incomplet — build REFUSÉ : ${nb} symbole(s) interne(s) que tes composants appellent n'existe(nt) nulle part dans le mjs_core.js produit (${modules} modules assemblés) : ${manquants}.\nÀ l'exécution, chacun donnerait « this.<nom> is not a function » sur la première vue qui s'en sert.\nDeux causes, dans cet ordre : soit 'runtime' (mjs.config.json) retire un module dont tu te sers — nomme-le dans le tableau ; soit le compilateur émet un nom que la détection ne reconnaît plus, et c'est un bogue du framework : signale-le.`,
  'bundler.index.cycle-import-detecte': ({ chaine }: MsgVars) => `[bundler] Cycle @import/µasset détecté : ${chaine}. Un module ne peut pas s'importer lui-même, directement ou indirectement.`,
  'bundler.index.dep-jamais-resolue': ({ unite, deps }: MsgVars) => `[bundler] '${unite}' : émission impossible — dépendance jamais résolue (${deps}). La dépendance a probablement échoué à compiler ailleurs ; corrige-la d'abord.`,
  'bundler.index.repere-jamais-resolu-manifeste': ({ cle }: MsgVars) => `[bundler] '${cle}' : repère interne jamais résolu dans le manifeste — l'entrée est retirée plutôt que publiée cassée. Signale ce cas, c'est un bogue du bundler.`,
  'bundler.index.repere-non-resolu-emission': ({ unite }: MsgVars) => `[bundler] '${unite}' : repère interne encore présent après résolution de ses dépendances — écriture refusée. Signale ce cas, c'est un bogue du bundler.`,
  'bundler.index.repere-non-resolu-ecriture': ({ fichier }: MsgVars) => `[bundler] '${fichier}' : écriture refusée — contient encore un repère interne non résolu. Signale ce cas, c'est un bogue du bundler.`,
  'bundler.index.js-bundle-module-virtuel-introuvable': ({ specificateur }: MsgVars) => `[bundler] js: 'bundle' — spécificateur virtuel '${specificateur}' sans contenu en mémoire. Signale ce cas, c'est un bogue du bundler.`,
  'bundler.index.js-bundle-echec': ({ raison }: MsgVars) => `[bundler] js: 'bundle' — l'assemblage en un seul fichier a échoué : ${raison}`,
  'bundler.startup.echec': ({ page, raison }: MsgVars) => `[bundler] démarrage de '${page}' — l'assemblage du fichier de page a échoué : ${raison}`,
  'bundler.startup.fichier-de-page': ({ page, fichier, nb }: MsgVars) => `   ✓ ${page} → ${fichier} (${nb} composants assemblés)`,
  'bundler.startup.bundle-hors-production': () => `   ℹ️  render.startup: 'bundle' — construction de développement : préchargement seul, le fichier de page n'est assemblé qu'en \`--prod\`.`,
  'bundler.startup.fichier-unique': () => `   ℹ️  js: 'bundle' — le fichier unique porte déjà le cœur et tous les composants : aucun en-tête de démarrage dans les fragments.`,
  'bundler.index.compilation-bloquee': ({ fichier, timeout, chaine }: MsgVars) => `[bundler] Compilation de '${fichier}' bloquée depuis ${timeout}ms en attente d'une compilation déjà en vol — probable dépendance circulaire entre modules TOUS DEUX top-level (chacun attend l'autre via @import/µasset). Chaîne actuelle : ${chaine}.`,
  'bundler.index.erreur-fichier-detail': ({ fichier, detail }: MsgVars) => `[bundler] ${fichier} : ${detail}`,
  'bundler.index.singleton-import-module-ligne': ({ fichier, ligne }: MsgVars) => `[ModularJS] ${fichier} : « ${ligne} » — un singleton réactif exporté (µ$$, anciennement §§) est un mécanisme de COMPOSANT (.mjs), pas de module autonome (.civet/.coffee) — remplace par \`@import nom 'chemin'\` (valeur simple, non réactive).`,
  'bundler.index.singleton-import-module-dollar': ({ fichier, noms }: MsgVars) => `[ModularJS] ${fichier} : @import d'un singleton réactif (« ${noms} ») — réservé aux composants .mjs, pas à un module autonome (.civet/.coffee) — remplace par \`@import nom 'chemin'\` (valeur simple, non réactive).`,
  'bundler.index.css-sass-erreurs': ({ erreurs }: MsgVars) => `[bundler] erreur(s) de compilation CSS/SASS dans stylesheetsDir :\n${erreurs}`,
  // vocabulaire des thèmes — `@css nom` désigne une FEUILLE PARTAGÉE de stylesheetsDir ;
  // le mot « thème » est désormais pris par le vrai bloc <theme>, il ne doit plus servir ici
  'bundler.index.feuille-partagee-manquante': ({ themes, dossier }: MsgVars) => `[bundler] @css : feuille(s) partagée(s) introuvable(s) dans ${dossier} : ${themes} (aucun fichier .sass/.scss/.css correspondant). Vérifie le nom, ou ajoute le fichier manquant.`,
  'bundler.index.precache-echec': ({ raison }: MsgVars) => `[bundler] mjs-precache.json n'a pas pu être écrit : ${raison}. Le build reste valide — seule la liste de pré-cache manque.`,
  'bundler.index.image-sharp-absent': `[bundler] µimage : 'sharp' n'est pas installé — les images passent telles quelles, sans variantes de largeur. Les dimensions natives, elles, sont bien écrites (pas de saut de mise en page). Pour produire les variantes : npm i -D sharp`,
  'bundler.index.img-src-introuvable': ({ chemin, extrait }: MsgVars) => `[bundler] <@img src="${chemin}"> : fichier introuvable dans sourceDir — ${extrait}`,
  'bundler.index.img-widths-invalide': ({ valeur, extrait }: MsgVars) => `[bundler] <@img widths="${valeur}"> : largeurs invalides — des entiers ≥ 1 séparés par des espaces ou des virgules — ${extrait}`,
  'bundler.index.img-attribut-duplique': ({ attribut, extrait }: MsgVars) => `[bundler] <@img> : l'attribut « ${attribut} » est écrit deux fois — garde-en un seul — ${extrait}`,
  // confinement RÉEL (realpathSync) : un lien symbolique posé dans
  // sourceDir et pointant hors de sourceDir passait le contrôle lexical
  'bundler.index.img-src-symlink-hors-racine': ({ chemin, cible, extrait }: MsgVars) => `[bundler] <@img src="${chemin}"> : ce chemin est un lien symbolique dont la cible réelle ('${cible}') est HORS de sourceDir — jamais copié, pour ne pas publier un fichier hors du projet. Retire ce lien ou pointe-le vers un chemin interne à sourceDir — ${extrait}`,
  'bundler.index.css-lazy-feuilles-jamais-reclamees': ({ feuilles }: MsgVars) => `[bundler] css lazy : feuille(s) partagée(s) qu'aucun module ne déclare (@css) et qu'aucune vue ne réclame — écrite(s) sur disque mais JAMAIS chargée(s) : ${feuilles}. Ajoute '@css <nom>' au(x) module(s) qui les utilisent, ou retire le fichier.`,
  'bundler.index.css-split-feuilles-eager': ({ feuilles }: MsgVars) => `[bundler] css split : feuille(s) partagée(s) qu'aucun module ne déclare (@css) — reste(nt) importée(s) par le manifeste (eager) : ${feuilles}. Ajoute '@css <nom>' au(x) module(s) qui les utilisent pour réduire le CSS chargé par page.`,
  'bundler.index.css-split-feuilles-eager-view': ({ feuilles }: MsgVars) => `[bundler] css split : feuille(s) partagée(s) réclamée(s) par un '<@view css="…">' — reste(nt) importée(s) par le manifeste (eager) même si un module les déclare déjà via @css ailleurs : ${feuilles}. Une page qui charge cette vue sans charger ce module en aurait sinon hérité vide (cf. runtime/mjs_element.ts, avertissement « Orphelin CSS hérité »).`,
  'bundler.index.asset-introuvable': ({ chemin }: MsgVars) => `[bundler] Asset introuvable : '${chemin}' référencé via µasset()/µimage()/µ.asset()/mjs.asset() n'a pas pu être résolu (fichier absent du disque, ou chemin dynamique non pré-résolvable). Vérifie le chemin ou que le fichier existe.`,
  // confinement RÉEL par realpathSync (findFiles ET
  // resolveOneAsset) : un symlink posé dans sourceDir (dossier ou fichier) et pointant hors de
  // sourceDir était suivi/copié sans un mot, le contrôle existant (resolve()/startsWith) étant
  // purement lexical, donc aveugle à un lien. Un symlink INTERNE (cible sous sourceDir) reste
  // accepté — seule une cible RÉELLE hors racine déclenche cette erreur.
  'bundler.index.symlink-hors-racine': ({ lien, cible }: MsgVars) => `[bundler] '${lien}' est un lien symbolique dont la cible réelle ('${cible}') est HORS de sourceDir — jamais suivi ni copié, pour ne pas publier un fichier hors du projet dans outputDir. Retire ce lien ou pointe-le vers un chemin interne à sourceDir.`,
  // lien PENDANT (cible absente) :
  // realpathSync levait un ENOENT Node brut, jamais catalogué.
  'bundler.index.symlink-pendant': ({ lien }: MsgVars) => `[bundler] '${lien}' est un lien symbolique PENDANT (sa cible n'existe pas) — jamais suivi, son confinement ne peut pas être vérifié. Retire ce lien ou répare sa cible.`,
  'bundler.index.require-introuvable': ({ spec, dossier }: MsgVars) => `[bundler] require introuvable : '${spec}' (depuis ${dossier})`,
  'bundler.index.require-dir-introuvable': ({ spec, dossier }: MsgVars) => `[bundler] require_dir introuvable : '${spec}' (depuis ${dossier})`,
  'bundler.index.i18n-yaml-manquant': ({ fichier }: MsgVars) => `[bundler] i18n : dictionnaire YAML détecté (${fichier}) mais le paquet 'yaml' n'est pas installé — installe-le (npm i -D yaml) ou convertis tes dictionnaires en .json`,
  'bundler.index.i18n-fichier-invalide': ({ chemin, erreur }: MsgVars) => `[bundler] i18n : fichier invalide '${chemin}' — ${erreur}`,
  'bundler.index.i18n-dossier-absent': ({ dossier }: MsgVars) => `[bundler] i18n : config.i18n renseigné mais '${dossier}' est absent — aucun dictionnaire i18n ne sera émis.`,
  'bundler.index.i18n-default-manquant': `[mjs.config.json] i18n/ présent : précise i18n.default dans mjs.config.json`,
  'bundler.index.i18n-section-invalide': ({ section, chemin }: MsgVars) => `[bundler] i18n : nom de section invalide '${section}' (${chemin}) — doit matcher /^[a-z0-9_-]+$/`,
  'bundler.index.i18n-source-langue-inconnue': ({ langue }: MsgVars) => `[mjs.config.json] i18n.source vaut '${langue}' mais aucun dictionnaire pour cette langue n'existe dans i18n/`,
  'bundler.index.i18n-source-scellee': ({ fichier }: MsgVars) => `[bundler] i18n : '${fichier}' porte un __source — la langue source ne se scelle pas, clé retirée`,
  'bundler.index.i18n-source-introuvable': ({ fichier, langue }: MsgVars) => `[bundler] i18n : '${fichier}' rejeté — aucune source '${langue}' correspondante, dictionnaire non émis`,
  'bundler.index.i18n-empreinte-absente': ({ fichier, attendu }: MsgVars) => `[bundler] i18n : '${fichier}' rejeté — __source absent, empreinte attendue : ${attendu}`,
  'bundler.index.i18n-empreinte-perimee': ({ fichier, attendu }: MsgVars) => `[bundler] i18n : '${fichier}' rejeté — __source périmé, empreinte attendue : ${attendu}`,
  'bundler.index.watch-erreur': '💥 [mjs watch] erreur du watcher :',
  'bundler.index.watch-recompilation': ({ fichier }: MsgVars) => `\n⚡ ${fichier} — recompilation...`,
  'bundler.index.watch-build-initial': `\n⚡ Build initial...`,
  'bundler.index.watch-build-termine': ({ ecrits, duree, erreurs }: MsgVars) => `✅ ${ecrits} fichiers en ${duree}ms (errors: ${erreurs})`,
  'bundler.index.watch-recompilation-echouee': '💥 [mjs watch] recompilation échouée :',
  'bundler.index.watch-watching': ({ chemins }: MsgVars) => `👀 Watching ${chemins}...`,
  'bundler.index.esm-check-ni-esm-ni-script': ({ filename, line, col, erreur, src }: MsgVars) => `[bundler/esm-check] ${filename}${line ? `:${line}:${col}` : ''} — ${erreur} (ni module ESM ni script classique)\n  ${src}`,
  // un SVG copié tel quel est servi depuis la MÊME origine que le site.
  // libellé généralisé : le motif n'est plus toujours un <script>
  // littéral (entité encodée, injection SMIL, <foreignObject>/<iframe> embarquant une autre
  // origine) — « exécutable »/« Retire le script » ne décrivait plus fidèlement tous les cas.
  'bundler.index.svg-script-refuse': ({ fichier, motif }: MsgVars) => `[bundler] ${fichier} : SVG refusé — contient ${motif}, dangereux si le fichier est servi directement (chargement top-level, <object>, <iframe>) ou via <img>. Retire ce contenu avant de le référencer via µasset()/µimage()/<@img>.`,
  // raccourci <@nom> (resolveTagShortcuts) ; notation UNIQUE (résolution
  // projet PUIS cœur), <@mjs-nom> retirée (tag-raccourci-mjs-retire)
  'bundler.index.tag-nom-reserve': ({ fichier, nom }: MsgVars) => `[bundler] ${fichier} : '${nom}' est une balise RÉSERVÉE de ModularJS (<@${nom}>) — un composant (basename ou alias court) ne peut pas revendiquer ce nom. Renomme le fichier.`,
  'bundler.index.tag-nom-core-prefixe': ({ fichier, nom }: MsgVars) => `[bundler] ${fichier} : '${nom}' commence par 'core-', préfixe RÉSERVÉ au catalogue interne des modules cœur ModularJS (invoqués via <@nom>) — un composant du projet (basename ou alias court) ne peut pas l'utiliser. Renomme le fichier.`,
  'bundler.index.tag-nom-mjs-prefixe': ({ fichier, nom, propre }: MsgVars) => `[bundler] ${fichier} : '${nom}' commence par 'mjs-', préfixe RÉSERVÉ au framework — le tag d'un composant est DÉJÀ 'mjs-<nom de fichier>' (celui-ci donnerait <mjs-${nom}>), et tout attribut 'mjs-*' est réservé aux internes. Renomme le fichier en '${propre}.mjs' : son tag sera <mjs-${propre}>.`,
  // alias court (shortName) en collision avec une réservée/core- : abandonné + avertissement (jamais bloquant, contrairement au basename)
  'bundler.index.tag-alias-reserve-ignore': ({ fichier, nom }: MsgVars) => `[bundler] ${fichier} : l'alias court '${nom}' est ignoré — nom réservé ; le composant reste utilisable par son nom complet.`,
  'bundler.index.tag-raccourci-mjs-retire': ({ fichier, nom }: MsgVars) => `[bundler] ${fichier} : « <@mjs-${nom}> » est retirée — écris « <@${nom}> » (résolution projet puis modules cœur).`,
  'bundler.index.tag-coeur-litterale-interdite': ({ fichier, tag, nom }: MsgVars) => `[bundler] ${fichier} : la balise <${tag}> n'existe plus — écris <@${nom}>.`,
  'bundler.index.tag-dev-inconnu': ({ fichier, nom }: MsgVars) => `[bundler] ${fichier} : balise <@${nom}> inconnue (résolution projet puis cœur) — ni balise réservée, ni composant du projet, ni module cœur.`,
  'bundler.index.tag-suggestion': ({ nom, nature }: MsgVars) => {
    const label = nature === 'coeur' ? 'module cœur' : nature === 'reservee' ? 'balise réservée' : 'composant du projet'
    return ` Vouliez-vous <@${nom}> (${label}) ?`
  },
  'bundler.index.tag-litteral-dev-inconnue': ({ fichier, tag }: MsgVars) => `[bundler] ${fichier} : <${tag}> ne correspond à aucun composant compilé (ni basename ni alias court) — tag inerte au runtime si c'est une faute de frappe sur un composant du projet.`,
  // alias court AMBIGU : deux composants se le disputent, personne ne le publie (claimShortName,
  // kind 'poisoned') — la balise courte n'est jamais enregistrée, elle reste inerte
  'bundler.index.tag-alias-ambigu': ({ fichier, tag, sources, premier }: MsgVars) => `[bundler] ${fichier} : <${tag}> — alias ambigu : ${sources} se disputent ce raccourci, aucun ne le publie (balise jamais enregistrée, inerte au runtime). Écris la balise complète, par exemple <mjs-${premier}>.`,
  // variants — layout="x"/template="x" littéral dont le nom n'est pas une
  // variant <style name="…"> connu du module ciblé (parser/index.ts, TagRef.layoutLiteral)
  'bundler.index.tag-layout-litteral-inconnue': ({ fichier, tag, nom, connus }: MsgVars) => `[bundler] ${fichier} : <${tag} layout="${nom}"> — variant '${nom}' inconnu de ce composant (connus : ${connus}). Corrige la faute de frappe ou ajoute <style name="${nom}"> à ce composant.`,
  // — minify.ts
  'bundler.minify.label-acces-indexe': "accès indexé `obj['_mjs_X']`",
  'bundler.minify.label-acces-template': 'accès template literal `obj[`_mjs_${...}`]`',
  'bundler.minify.label-define-property': "Object.defineProperty(*, '_mjs_X', ...) — string non manglée",
  'bundler.minify.label-reflect': "Reflect.X(*, '_mjs_X', ...) — string non manglée",
  'bundler.minify.label-concat': "concaténation `'_mjs_' + X` — nom fabriqué à l'exécution",
  'bundler.minify.label-in': "test `'_mjs_X' in obj` — string non manglée",
  'bundler.minify.mjs-prop-access-invalide': ({ fichier, ligne, label, contenu }: MsgVars) => `[bundler/minify] ${fichier}:${ligne} — ${label}\n  → ${contenu}\n  Les props \`_mjs_*\` sont manglées par esbuild via mangleCache pour cohérence inter-fichiers.\n  Un accès indirect ne participe PAS au mangle → crash runtime.\n  Fix : utiliser la notation pointée (\`obj._mjs_X\`) au lieu de l'accès string.`,
  // — worker-pool.ts
  'bundler.worker-pool.worker-sorti': ({ code }: MsgVars) => `WorkerPool: worker sorti avec le code ${code}`,
  'bundler.worker-pool.deja-termine': `WorkerPool: déjà terminé`,
  'bundler.worker-pool.aucun-worker-vivant': `WorkerPool: aucun worker vivant (pool à recréer)`,
  'bundler.worker-pool.erreur-inconnue': `worker: erreur inconnue`,
  'bundler.worker-pool.plus-aucun-worker': ({ message }: MsgVars) => `WorkerPool: plus aucun worker vivant (${message})`,
  'bundler.worker-pool.terminate-queue': `WorkerPool: terminate() pendant tâche en queue`,
  'bundler.worker-pool.terminate-inflight': `WorkerPool: terminate() pendant tâche in-flight`,
  'bundler.worker-pool.worker-ts-introuvable': ({ chemin }: MsgVars) => `[worker-pool] worker.ts introuvable : ${chemin}`,
  // délai maximal par tâche dispatchée
  'bundler.worker-pool.tache-timeout': ({ fichier, ms }: MsgVars) => `WorkerPool: tâche '${fichier}' sans réponse après ${ms}ms — worker retiré du pool`,
  // — worker.ts
  'bundler.worker.parent-port-manquant': `worker.ts doit être exécuté à l'intérieur d'un Worker (parentPort manquant)`,

  'bundler.theme-nom-fichier': ({ nom, fichier }: MsgVars) => `[ModularJS] ${fichier} : « ${nom} » n'est pas un nom de thème valide — minuscules, chiffres et tirets uniquement (le nom du fichier EST le nom du thème : sombre.theme.mjs donne le thème « sombre »).`,
  'bundler.theme-fichier-sans-bloc': ({ fichier }: MsgVars) => `[ModularJS] ${fichier} : aucun bloc <theme> — un fichier de thème ne contient que ça.`,
  'bundler.theme-fichier-impur': ({ fichier, quoi }: MsgVars) => `[ModularJS] ${fichier} contient ${quoi} — un fichier de thème ne contient qu'un bloc <theme> : il déclare des variables, il ne rend rien. Pour du style ou du balisage, écris un composant.`,
  'bundler.theme-fichier-multi': ({ fichier }: MsgVars) => `[ModularJS] ${fichier} contient plusieurs blocs <theme> — un fichier = un thème. Pour un deuxième thème, un deuxième fichier.`,
  'bundler.theme-fichier-name': ({ fichier, nom }: MsgVars) => `[ModularJS] ${fichier} : <theme name="${nom}"> — dans un fichier de thème le nom vient du FICHIER, pas de l'attribut. Retire name="${nom}" (ou renomme le fichier en ${nom}.theme.mjs). L'attribut name ne sert que dans un composant, pour une variante.`,
  'bundler.page-nom-fichier-vide': ({ fichier }: MsgVars) => `[ModularJS] ${fichier} : nom de page vide — une fois le marqueur « .page » retiré, il ne reste aucun nom (le nom du fichier EST le nom du composant : accueil.page.mjs donne 'accueil'). Renomme le fichier.`,
  'bundler.page-marqueur-double': ({ fichier, reste, suggestion }: MsgVars) => `[ModularJS] ${fichier} : marqueur « .page » en double — un seul est retiré, il reste « ${reste} » qui finit encore par « .page ». Renomme le fichier en '${suggestion}'.`,
  // même garde que bundler.theme-nom-fichier (bundler/themes.ts) : un nom
  // de composant hors kebab-case casse l'autoloader (majuscule) ou customElements.define() (espace)
  'bundler.composant-nom-fichier': ({ nom, fichier, suggestion }: MsgVars) => `[ModularJS] ${fichier} : « ${nom} » n'est pas un nom de composant valide — minuscules, chiffres et tirets uniquement (le nom du fichier détermine à la fois la clé du manifeste ET le tag <mjs-…>). Renomme le fichier en '${suggestion}'.`,

  // registre des variables de thème — deux niveaux : un nom que personne ne déclare est presque
  // toujours une faute de frappe (avertissement), un nom déclaré par plusieurs composants est
  // légitime mais mérite d'être su (information, jamais un reproche)
  'bundler.variable-inconnue': ({ nom, lus }: MsgVars) => `[ModularJS] $$${nom} est lu par ${lus}, mais personne ne le déclare — ni un thème de l'application, ni un composant, ni le framework. Faute de frappe probable : la valeur sera vide à l'écran. Déclare-le dans un <theme>, ou corrige le nom.`,
  'bundler.variable-partagee': ({ nom, modules }: MsgVars) => `[ModularJS] $$${nom} est déclaré par ${modules} — rappel : une variable de thème n'appartient à personne, elle cascade. Chacun de ces composants impose sa valeur à toute sa descendance ; le plus proche l'emporte.`,

  // ═══ COMPILATEUR (lexer/parser/generator/analyzer/transpiler/languages/schema) ═══════════

  // — src/lexer/index.ts —
  'lexer.hook-arobase-retire': ({ hook }: MsgVars) => `[ModularJS] « @${hook} -> » : la forme @ des hooks est retirée — écris « µ${hook} -> » (rune de cycle de vie). Le nom « ${hook} » reste libre pour tes méthodes (« @${hook} = -> »).`,
  'lexer.symbole-declare-civet': ({ varName, preview }: MsgVars) => `[ModularJS] « ${varName} := ${preview} » : « := » est l'opérateur de déclaration Civet, invalide sur un symbole $ — écris « ${varName} = ${preview} » (les symboles $ sont auto-déclarés, « := » y est toujours superflu).`,
  'lexer.derived-expr-vide': ({ varName }: MsgVars) => `[ModularJS] « µderived $${varName} = » : expression manquante avant la liste de dépendances forcées.`,
  'lexer.derived-dep-invalide': ({ varName, dep }: MsgVars) => `[ModularJS] « µderived $${varName} = …, ${dep} » : chaque dépendance forcée doit être un symbole $ nu (ex. $a), reçu « ${dep} ».`,

  // — src/parser/index.ts —
  'parser.nom-reserve': ({ ligne, bloc, nom, alt, listeNoms }: MsgVars) => `

🚨 [NOM RÉSERVÉ] Ligne ${ligne}, bloc \`{${bloc}}\` : le nom \`${nom}\` est utilisé
   en interne par le code JS généré par ModularJS. Le choisir comme variable
   de template provoque une collision silencieuse au runtime.
👉 Renommez cette variable (ex: \`${nom}\` → \`${alt}\`).
   Noms réservés : ${listeNoms}

`,
  'parser.symbole-reserve-template': ({ ligne, nom, kind }: MsgVars) => `[ModularJS] ligne ${ligne} : « ${nom} » est un symbole du framework — $ (état), $$ (store), µ (runtime) — il ne peut pas nommer une variable d'un bloc {${kind}}. Renomme-le (par exemple « item »).`,
  'parser.astuce-if-ternaire': `Astuce : pour un ternaire en ligne (une valeur, pas un bloc), utilisez\n   la syntaxe JS \`{cond ? a : b}\` — une interpolation \`{…}\` est du JS ;\n   sinon fermez le bloc \`{if …}\` par \`{end}\`.`,
  'parser.astuce-for-end': `Astuce : chaque \`{for item in liste}\` doit être fermé par \`{end}\` sur une ligne distincte.`,
  'parser.astuce-await-end': `Astuce : chaque \`{await promise}\` doit être fermé par \`{end}\` (après \`{success}\` / \`{error}\`).`,
  'parser.astuce-key-end': `Astuce : \`{key expr}\` délimite un sous-arbre recréé quand \`expr\` change ; il doit être fermé par \`{end}\`.`,
  'parser.chaine-non-fermee': ({ ligne, quote, extrait }: MsgVars) => `

🚨 [CHAÎNE NON FERMÉE] La chaîne ouverte par \`${quote}\` ligne ${ligne} n'est jamais refermée.
   Fin de fichier atteinte : tout le HTML suivant a été avalé par l'expression.
👉 Fermez la chaîne. Attention, \`\\\\\` est un antislash LITTÉRAL : il n'échappe pas le
   guillemet qui le suit (\`'c:\\\\'\` ferme bien la chaîne, \`'c:\\'\` ne la ferme pas).
   Début avalé : ${extrait}

`,
  'parser.delimiteur-non-ferme': ({ ligne, ouvrant, fermant, extrait }: MsgVars) => `

🚨 [EXPRESSION NON FERMÉE] \`${ouvrant}\` ouvert ligne ${ligne} n'a pas de \`${fermant}\` correspondant.
   Fin de fichier atteinte : tout le HTML suivant a été avalé par l'expression.
👉 Fermez l'expression par \`${fermant}\` (une accolade à afficher telle quelle s'écrit \`&#123;\`).
   Début avalé : ${extrait}

`,
  'parser.bloc-non-ferme': ({ kind, expr, ligne, astuce }: MsgVars) => `

🚨 [BLOC NON FERMÉ] \`{${kind} ${expr}}\` ouvert ligne ${ligne} n'a pas de \`{end}\` correspondant.
   Fin de fichier atteinte avant la fermeture.
👉 ${astuce}

`,
  'parser.attribut-nu-non-supporte': ({ expr, ligne, tag }: MsgVars) => `🚨 [parser] \`{${expr}}\` nu (ligne ${ligne}) : un \`{expr}\` seul n'est un attribut que sur \`<@slot {…}>\` (nom de slot évalué). Sur <${tag}>, écris \`nom={${expr}}\` (attribut nommé).`,
  'parser.const-syntaxe-invalide': ({ ligne }: MsgVars) => `🚨 [parser] {const …} invalide (ligne ${ligne}) : syntaxe attendue « {const NOM = EXPR} »`,
  'parser.const-expression-vide': ({ nom, ligne }: MsgVars) => `🚨 [parser] {const ${nom} = …} (ligne ${ligne}) : expression vide.`,
  'parser.for-item-index-homonyme': ({ item, index, ligne }: MsgVars) => `[ModularJS] {for ${item}, ${index} in …} (ligne ${ligne}) : l'item et l'index ne peuvent pas porter le même nom « ${item} ».`,
  'parser.for-syntaxe-invalide': ({ expr, ligne, astuceOf }: MsgVars) => `🚨 [parser] {for ${expr}} invalide (ligne ${ligne}) : syntaxe attendue « {for [idx,] item in liste [by clé]} »${astuceOf}`,
  'parser.for-astuce-in-pas-of': ` — utilisez « in », pas « of »`,
  // piège JSX/Svelte : `{else if cond}` n'est reconnu ni par `{elsif ...}`
  // ni par `{else}` (tous deux stricts) → tombait en expression Civet nue,
  // erreur cryptique très loin de la vraie cause.
  'parser.else-if-non-supporte': ({ expr, ligne }: MsgVars) => `🚨 [parser] {${expr}} (ligne ${ligne}) : \`{else if …}\` n'existe pas en MJS — utilisez \`{elsif …}\`.`,
  'parser.erreur-fatale': ({ extrait }: MsgVars) => `

🚨 [ERREUR DE PARSING FATALE]
Le compilateur ModularJS est bloqué sur une syntaxe invalide ou un caractère illégal.
Extrait incriminé : ${extrait}
👉 Diagnostic : L'analyseur lexical ne parvient pas à consommer la chaîne.

`,
  'parser.balise-fermante-orpheline': ({ nom, ligne }: MsgVars) => `

🚨 [BALISE FERMANTE ORPHELINE] \`</${nom}>\` ligne ${ligne} : aucune balise ouvrante correspondante.
   Sans erreur, tout le template qui suit cette balise serait ignoré en silence.
👉 Supprimez cette fermante en trop, ou ajoutez la balise ouvrante manquante.

`,
  'parser.view-auto-fermeture-interdite': ({ nom, ligne }: MsgVars) => `🚨 [parser] <@view${nom ? ' ' + nom : ''}/> (ligne ${ligne}) : auto-fermeture interdite — <@view> reçoit son contenu du routeur à l'exécution, écris <@view${nom ? ' ' + nom : ''}></@view>.`,
  // Bloc de slot <@fill nom>…</@fill> (nom tenu par FILL_DIRECTIVE) : les 6 messages
  // suivants prennent tous `directive` (jamais « fill » en dur) et la `ligne` du nœud fautif.
  'parser.fill-sans-nom': ({ directive, ligne }: MsgVars) => `🚨 [parser] <@${directive}> sans nom (ligne ${ligne}) : le bloc de slot exige un nom littéral, comme <@slot nom> — écris <@${directive} nom>…</@${directive}>.`,
  'parser.fill-nom-dynamique': ({ directive, expr, ligne }: MsgVars) => `🚨 [parser] <@${directive} {${expr}}> (ligne ${ligne}) : nom dynamique refusé — le bloc de slot exige un nom LITTÉRAL (identifiant nu), comme <@slot nom>.`,
  // Un second attribut (nom en trop, `class=`, `{...$rest}`…) était ignoré en
  // silence par expandFillBlock ; `extrait` reprend les attributs TELS QU'ÉCRITS (describeFillAttr).
  'parser.fill-un-seul-nom': ({ directive, ligne, extrait }: MsgVars) => `🚨 [parser] <@${directive} …> (ligne ${ligne}) : un seul nom de slot, rien d'autre — « ${extrait} »`,
  'parser.fill-texte-nu': ({ directive, nom, ligne }: MsgVars) => `🚨 [parser] texte nu dans <@${directive} ${nom}> (ligne ${ligne}) : un texte ne peut pas viser un slot nommé — enveloppe-le dans un élément (ex. <span slot="${nom}">…</span>).`,
  'parser.fill-slot-deja-pose': ({ directive, nom, tag, ligne }: MsgVars) => `🚨 [parser] <${tag} slot="…"> (ligne ${ligne}) : cet enfant de <@${directive} ${nom}> porte déjà son propre slot= — retire l'un des deux.`,
  'parser.fill-imbrique': ({ directive, ligne }: MsgVars) => `🚨 [parser] <@${directive}> imbriqué (ligne ${ligne}) : un bloc <@${directive}> ne peut pas en contenir un autre — sépare-les en enfants directs du composant appelé.`,

  // — src/generator/compile.ts —
  'generator.await-imbrique-non-supporte': `Await imbriqué non supporté`,
  'generator.const-hors-for': ({ nom, expr }: MsgVars) => `
🚨 [ModularJS] {const ${nom} = …} hors d'un {for} n'est pas supporté.
   Au niveau racine, déclare plutôt une dérivée réactive dans le <script> :
   \`$${nom} = ${expr}\`  (auto-derived), puis lis \`{$${nom}}\`.
   Le {const} local reste réservé aux blocs {for} (cas Svelte {@const}).
`,
  // attribut STATIQUE contenant littéralement `#{…}` (interpolation Civet,
  // réservée au <script>) : n'interpole PAS, avertissement seul (jamais bloquant).
  'generator.interpolation-civet-attribut': ({ module, attr, valeur }: MsgVars) => `[ModularJS] ${module} : attribut "${attr}" — « #{ … } » n'est pas l'interpolation d'attribut : le « # » s'affichera tel quel devant la valeur (${valeur}). Écris { … } sans « # » ; #{ } n'existe que dans le <script> Civet.`,

  // — src/generator/paths.ts —
  'generator.extract-paths-boucle-infinie': ({ i, len, extrait }: MsgVars) => `[ModularJS] extractPaths : boucle infinie détectée (index bloqué à ${i}/${len}). HTML probablement malformé près de : ${extrait}`,
  'generator.create-fn-body-boucle-infinie': ({ i, len, extrait }: MsgVars) => `[ModularJS] generateCreateFnBodyImperative : boucle infinie détectée (index bloqué à ${i}/${len}). HTML probablement malformé près de : ${extrait}`,

  // — src/generator/utils.ts —
  'generator.hook-cycle-vie-interpolation': ({ nom }: MsgVars) => `[ModularJS] « µ${nom} » : les hooks de cycle de vie se déclarent dans le <script> du composant, pas dans une interpolation {…} ni un handler.`,
  // (src/generator/utils.ts:312 réutilise 'lexer.symbole-declare-civet' — garde jumelle, texte identique)
  // (réutilisée aussi par src/transpiler/index.ts:2062)
  'generator.every-hors-script': `[ModularJS] « µevery » : se déclare dans le <script> du composant (niveau racine), pas dans une interpolation {…} ni un handler.`,
  'generator.derived-hors-script': `[ModularJS] « µderived » : se déclare dans le <script> du composant (niveau racine), pas dans une interpolation {…} ni un handler.`,
  'generator.hint-ternaire-colle': ` Indice : ternaire collé « a?b:c » détecté — ajoute des espaces (« a ? b : c ») ; l'existentiel Coffee « a ? b » (sans « : ») s'écrit « a ?? b » en Civet.`,
  'generator.hint-dans-module': ({ moduleName }: MsgVars) => ` dans « ${moduleName} »`,
  'generator.interpolation-echec-civet': ({ moduleHint, rawExprForError, civetMsg, gluedTernaryHint }: MsgVars) => `[ModularJS] interpolation : échec de compilation Civet${moduleHint} — « ${rawExprForError} » — ${civetMsg}${gluedTernaryHint}`,

  // — src/generator/attributes/index.ts —
  'generator.this-ref-reactive': ({ varExpr, plain }: MsgVars) => `[mjs] @this=!{${varExpr}} : référence DOM liée à une variable RÉACTIVE « $ ». Chaque écriture (${varExpr}.style.x = …) passe alors par la réactivité (coût µ._mjs_deepSet). Pour une simple référence DOM, utilise une variable SANS « $ » : @this=!{${plain}}. Cf. docs/09-directives-dom.md.`,
  // littéral émis DANS le code généré (navigateur) — cf. risques §5, insertion ${JSON.stringify(t(...))} au site d'appel
  'generator.erreur-intro': `[ModularJS] Erreur intro:`,
  'generator.echec-intro': `[ModularJS] Échec intro:`,
  'generator.hint-cast-suffixe-nom': ({ attrName, cast }: MsgVars) => ` Pour un cast de type, le suffixe va sur le NOM de l'attribut : « ${attrName}.${cast}=!{…} » (et non « ${attrName}=!.${cast}{…} »).`,
  'generator.hint-syntaxe-two-way': ({ attrName }: MsgVars) => ` La syntaxe d'une liaison two-way est « ${attrName}=!{expression} » (des accolades autour de l'expression).`,
  'generator.liaison-two-way-malformee': ({ attrName, rawVal, hint }: MsgVars) => `[ModularJS] Liaison two-way mal formée : « ${attrName}=${rawVal} ».${hint}`,
  'generator.emit-forme-non-reconnue': ({ attrName }: MsgVars) => `[ModularJS] « ${attrName} » : forme d'émission non reconnue — utilise @emit.NOM_EVENEMENT={expr} ou @emit.once.NOM_EVENEMENT={expr}.`,
  'generator.emit-evenement-brut': ({ module, nomEvenement }: MsgVars) => `[ModularJS] ${module} : « µemit '${nomEvenement}', e » relaie l'ÉVÉNEMENT reçu, pas sa charge — le parent lira « e.data » sur le CustomEvent et trouvera undefined. Envoie « e.data » (ou l'expression voulue), pas « e » tel quel.`,
  // Sucre « au geste, émets » (@click.emit.NOM) + garde anti-faute-de-frappe sur les
  // modificateurs d'événement — BLOQUANTS tous les deux.
  'generator.event-emit-forme': ({ attrName, evt }: MsgVars) => `[ModularJS] « ${attrName} » : forme d'émission sur le geste non reconnue — écris « @${evt}.emit.NOM » (avec charge utile : « @${evt}.emit.NOM={expr} »). Le nom émis est le DERNIER segment : les modificateurs se posent avant (« @${evt}.stop.emit.NOM »), et ce nom ne peut contenir ni point ni apostrophe.`,
  'generator.event-modificateur-inconnu': ({ attrName, mod, hint }: MsgVars) => `[ModularJS] « ${attrName} » : « .${mod} » n'est pas un modificateur d'événement — les seuls reconnus sont .prevent, .stop, .self, .once, .propagate, plus le sucre .emit.NOM.${hint} Un nom d'événement ne peut pas contenir de point non plus : le point sépare les segments.`,
  'generator.hint-modificateur-suggestion': ({ suggestion }: MsgVars) => ` Tu voulais dire « .${suggestion} » ?`,
  'generator.macro-modificateur-non-gere': ({ evt, suffixe }: MsgVars) => `[ModularJS] « @${evt}.${suffixe} » sur une macro globale (<@window>/<@document>/<@body>/<@head>) : les modificateurs et le sucre d'émission n'y sont PAS gérés — ces écouteurs sont posés en direct, hors du routeur délégué. Écris « @${evt}={…} » et appelle « µemit » dans le corps si tu veux émettre.`,
  'generator.event-deux-points-abrege': ({ evt }: MsgVars) => `[ModularJS] « @${evt} » : forme abrégée interdite pour un événement à deux-points — écris « @${evt}={…} » avec le code à exécuter. La forme abrégée appelle la méthode du même nom que l'événement, et « ${evt} » n'est pas un nom de méthode possible (le deux-points compilait un objet jeté, sans la moindre erreur).`,

  // — src/analyzer/index.ts —
  'analyzer.prefixe-mjs-reserve': ({ varName, nomCourt }: MsgVars) => `[ModularJS] ⚠️  $.${varName} : préfixe '_mjs_' est réservé au framework. Renommer en $.${nomCourt} ou autre pour éviter une collision avec les props internes.`,
  'analyzer.effect-lit-ecrit-boucle': ({ liste }: MsgVars) => `[ModularJS] ⚠️  µeffect qui LIT et ÉCRIT ${liste} — risque de boucle réactive (l'effet se re-déclenche lui-même). Écris une AUTRE variable (ex. $double = $n * 2), ou garantis la convergence. Sinon le garde-fou runtime abandonne le rendu.`,
  'analyzer.resolve-dependance-non-convergent': `[ModularJS] resolveDependencyGraph : >100 passes sans convergence — closure de dépendances possiblement incomplète (graphe réactif anormalement profond).`,
  'analyzer.cycle-reactif-detecte': ({ func }: MsgVars) => `[ModularJS] Cycle réactif détecté sur '${func}', auto-résolution.`,
  'analyzer.derived-hors-racine': `[ModularJS] « µderived » doit être déclaré au niveau racine du <script> du composant, pas à l'intérieur d'une fonction.`,

  // — src/transpiler/directives.ts —
  'transpiler.i18n-double': ({ ancienneSection, section }: MsgVars) => `[ModularJS] @i18n en double : « ${ancienneSection} » puis « ${section} » — un seul \`@i18n\` par module.`,
  'transpiler.i18n-section-invalide': ({ section }: MsgVars) => `[ModularJS] @i18n : « ${section} » n'est pas un nom de section valide — minuscules, chiffres, tirets et underscores uniquement (ex. @i18n 'panier').`,
  'transpiler.i18n-placeholder-mode-invalide': ({ mode }: MsgVars) => `[ModularJS] @i18nPlaceholder : « ${mode} » n'est pas un mode valide — utilise auto, key ou wait.`,
  // partagée avec src/transpiler/index.ts:1348,1378 (texte identique)
  'transpiler.vt-off-nexiste-pas': ({ label }: MsgVars) => `[ModularJS] ${label} : 'off' n'existe pas — forme nue pour activer, 'none' pour couper.`,
  // partagée avec src/transpiler/index.ts:1349,1379 (texte identique)
  'transpiler.vt-on-implicite': ({ label }: MsgVars) => `[ModularJS] ${label} : 'on' est implicite — écris la directive nue pour activer.`,
  // partagée avec src/transpiler/index.ts:1353 (texte identique) :
  // `example` PROPRE à chaque appelant, @pageTransition (lien, forme CHAÎNE) n'a pas la même
  // syntaxe que les 4 positions @viewTransition (forme à POINT) — un seul exemple pour les deux
  // était trompeur (@pageTransition.cube={...} n'existe pas)
  'transpiler.vt-direction-plus-dans-nom': ({ label, example }: MsgVars) => `[ModularJS] ${label} : la direction ne s'écrit plus dans le nom — écris ${example}.`,
  'transpiler.vt-nom-erreur-parsing': ({ label, nameAndDir, erreur }: MsgVars) => `[ModularJS] ${label}.${nameAndDir} : ${erreur}`,
  'transpiler.vt-ancienne-ecriture-remplacee': ({ label }: MsgVars) => `[ModularJS] ${label} : l'ancienne écriture '${label} <nom> [priorité]' a été remplacée — écris ${label}.<nom>={ direction: …, duration: …, priority: … } (options facultatives).`,
  'transpiler.i18n-placeholder-wait-sans-section': `[ModularJS] @i18nPlaceholder wait : exige une section @i18n à attendre — ajoute @i18n 'nom' (ou utilise auto/key, qui ne dépendent pas d'une section).`,
  // RELOGEMENT — @css/@display/@viewTransition/@vt quittent la racine du
  // fichier, ce sont désormais des attributs de <style> (cf. transpiler/sections.ts).
  'transpiler.css-racine-interdite': ({ ligne, remplacement }: MsgVars) => `[ModularJS] @css ne s'écrit plus à la racine du fichier : c'est un attribut de <style>.\nRemplace la ligne « ${ligne} » par : ${remplacement}`,
  'transpiler.display-racine-interdite': ({ ligne, remplacement }: MsgVars) => `[ModularJS] @display ne s'écrit plus à la racine du fichier : c'est un attribut de <style>.\nRemplace la ligne « ${ligne} » par : ${remplacement}`,
  'transpiler.viewtransition-racine-interdite': ({ label, ligne, remplacement }: MsgVars) => `[ModularJS] ${label} ne s'écrit plus à la racine du fichier : c'est un attribut de <style>.\nRemplace la ligne « ${ligne} » par : ${remplacement}`,
  'transpiler.style-attr-sur-layout': ({ attribut, nom }: MsgVars) => `[ModularJS] ${attribut} n'est valide que sur le <style> de base (sans name=) — trouvé sur <style name="${nom}">.`,
  'transpiler.viewtransition-guillemets-sur-style': ({ label }: MsgVars) => `[ModularJS] ${label}="…" avec guillemets n'existe plus sur <style> — écris ${label}.<nom>={ direction: …, duration: …, priority: … } (options facultatives).`,
  'transpiler.viewtransition-forme-invalide-sur-style': ({ label, rest }: MsgVars) => `[ModularJS] ${label}${rest} sur <style> : forme invalide — écris ${label}.<nom>={ direction: …, duration: …, priority: … }, ou ${label} nu.`,
  'transpiler.vt-alias-sur-style-interdit': `[ModularJS] @vt n'est pas un alias sur <style> — écris @viewTransition.<nom>={ … } (ou @viewTransition nu).`,
  // RENOMMAGE — @vt sur <a> devient @pageTransition, seule orthographe
  // du mécanisme de transition de PAGE niveau UJS (cf. transpiler/index.ts).
  'transpiler.vt-renomme-pagetransition': ({ ligne, remplacement }: MsgVars) => `[ModularJS] @vt ne s'écrit plus ainsi : c'est désormais @pageTransition.\nRemplace la ligne « ${ligne} » par : ${remplacement}`,
  // @pageTransition (lien) accepte aussi la syntaxe OBJET `nom={ direction: …, duration: … }`
  // (MÊME mini-grammaire que <@view>/<style> ci-dessus, parseVtValue). `priority`/`p`
  // REFUSÉ ici (pas une clé neuve à la grammaire, un refus délibéré) : la cascade d'un lien n'a que 2
  // niveaux (lien, config, cf. µ._mjs_vtResolvePage), aucun arbitrage départ/arrivée à départager
  // (_vtWinner/_vtResolveWithPriority sont réservés au routeur/<@view>, mjs_router.ts).
  'transpiler.pagetransition-forme-invalide': ({ label, val }: MsgVars) => `[ModularJS] ${label}="${val}" : forme invalide — écris ${label}="<nom>", "on", "off", ou ${label}="<nom>={ direction: …, duration: … }".`,
  'transpiler.pagetransition-erreur-parsing': ({ label, valeur, erreur }: MsgVars) => `[ModularJS] ${label}="${valeur}" : ${erreur}`,
  'transpiler.pagetransition-priority-sans-effet': ({ label, valeur }: MsgVars) => `[ModularJS] ${label}="${valeur}" : 'priority'/'p' n'a pas d'effet sur un lien — la cascade n'a que 2 niveaux (lien, config), rien à départager (_vtWinner/_vtResolveWithPriority sont réservés au routeur/<@view>) ; retire l'option.`,
  'transpiler.persist-nom-invalide': ({ nomVar }: MsgVars) => `[ModularJS] @persist : « ${nomVar} » n'est pas un nom de variable valide — sépare les variables par un espace (@persist $a $b).`,
  'transpiler.import-virgule-interdite': ({ rawVars, targetPath }: MsgVars) => `[ModularJS] @import ${rawVars} '${targetPath}' : virgule interdite entre les noms — sépare-les par un espace (@import nomA nomB '${targetPath}').`,
  // les balises de section (<style>/<script>/<theme>/<routes>)
  // n'atteignent jamais le DOM : un attribut qu'elles ne reconnaissent pas, ou une directive
  // racine mal écrite (@improt, @persit), arrête désormais la compilation
  'transpiler.section-attribut-inconnu': ({ tag, attribut, attendus }: MsgVars) => `[ModularJS] <${tag} ${attribut}> : attribut inconnu — une balise <${tag}> n'atteint jamais le DOM, seuls ${attendus} y ont un sens.`,
  'transpiler.section-attribut-inconnu-suggestion': ({ tag, attribut, suggestion, attendus }: MsgVars) => `[ModularJS] <${tag} ${attribut}> : attribut inconnu — tu voulais dire « ${suggestion} » ? Sur <${tag}>, seuls ${attendus} ont un sens.`,
  'transpiler.directive-racine-inconnue': ({ nom, suggestion }: MsgVars) => `[ModularJS] « @${nom} » en tête de ligne n'est pas une directive racine — tu voulais dire « @${suggestion} » ? (directives racines : @import, @persist)`,

  // — src/transpiler/sections.ts —
  'transpiler.script-module-double': ({ n, nAutres }: MsgVars) => `[ModularJS] ${n} balises <script module> trouvées — un seul bloc est permis par composant : fusionne-les en un seul (avant cette règle, le contenu des ${nAutres} autre(s) était jeté en silence).`,
  'transpiler.script-double': ({ n, nAutres }: MsgVars) => `[ModularJS] ${n} balises <script> (hors module) trouvées — un seul bloc est permis par composant : fusionne-les en un seul (avant cette règle, le contenu des ${nAutres} autre(s) était jeté en silence).`,
  'transpiler.style-double': ({ n, nAutres }: MsgVars) => `[ModularJS] ${n} balises <style> trouvées — un seul bloc est permis par composant : fusionne-les en un seul, ou utilise plusieurs sélecteurs dans le même bloc (avant cette règle, le contenu des ${nAutres} autre(s) était jeté en silence).`,
  'transpiler.theme-double': ({ nom }: MsgVars) => `[ModularJS] deux blocs <theme${nom === '' ? '' : ` name="${nom}"`}> dans le même composant — un seul bloc sans nom, et un seul par nom.`,
  'transpiler.theme-name-invalide': ({ nom }: MsgVars) => `[ModularJS] <theme name="${nom}"> : nom de variante invalide — minuscules, chiffres et tirets uniquement (ex. <theme name="gold">).`,
  'transpiler.layout-name-invalide': ({ nom }: MsgVars) => `[ModularJS] <style name="${nom}"> : nom de variant invalide — minuscules, chiffres et tirets uniquement (ex. <style name="bandeau">).`,
  'transpiler.layout-double': ({ nom }: MsgVars) => `[ModularJS] deux blocs <style name="${nom}"> dans le même composant — un variant par nom.`,
  'transpiler.variable-racine-sans-selecteur': ({ nom, ligne, bloc }: MsgVars) => `[ModularJS] $$${nom} est déclaré à la racine du ${bloc} (ligne ${ligne}) — une surcharge a besoin d'un sélecteur (:host, une classe…) pour s'accrocher. Range la ligne sous un sélecteur, ou déclare la variable dans un <theme> si elle doit valoir pour tout le composant.`,
  'transpiler.balise-orpheline-html': ({ balise }: MsgVars) => `[ModularJS] un ${balise} orphelin traîne dans le HTML du composant — l'extraction des sections est partie en vrille. Causes probables : une chaîne non terminée qui contient ${balise} par erreur de frappe, ou une balise d'ouverture en majuscules non reconnue (ex. <SCRIPT>/<STYLE>). Remède : échappe/scinde la balise dans la chaîne (ex. '</scr' + 'ipt>'), vérifie la fermeture de tes chaînes, ou repasse la balise d'ouverture en minuscules.`,
  'transpiler.routes-target-manquant': `[ModularJS] <routes> : l'attribut target="…" est obligatoire — c'est l'id du <@view id="…"> (outlet) que ces routes alimentent.`,
  'transpiler.routes-target-double': ({ target }: MsgVars) => `[ModularJS] deux blocs <routes target="${target}"> dans le même composant — un seul bloc par target.`,
  'transpiler.routes-ligne-invalide': ({ target, ligne, texte }: MsgVars) => `[ModularJS] <routes target="${target}">, ligne ${ligne} : « ${texte} » — attendu un chemin puis un nom de composant, séparés par un espace (ex. /guide/:id  guide-page).`,
  'transpiler.routes-chemin-sans-slash': ({ target, ligne, chemin }: MsgVars) => `[ModularJS] <routes target="${target}">, ligne ${ligne} : le chemin « ${chemin} » doit commencer par /.`,
  'transpiler.routes-chemin-mal-forme': ({ target, ligne, chemin }: MsgVars) => `[ModularJS] <routes target="${target}">, ligne ${ligne} : chemin « ${chemin} » mal formé — segments acceptés : littéral, :param, (:param) ou (littéral) optionnel (à n'importe quelle position), * catch-all en fin de route uniquement.`,
  'transpiler.routes-composant-invalide': ({ target, ligne, composant }: MsgVars) => `[ModularJS] <routes target="${target}">, ligne ${ligne} : « ${composant} » n'est pas un nom de composant valide — minuscules, chiffres et tirets, sans le préfixe mjs- (ex. guide-page).`,
  'transpiler.routes-chemin-double': ({ target, chemin }: MsgVars) => `[ModularJS] <routes target="${target}"> : le chemin « ${chemin} » apparaît deux fois dans le même bloc.`,
  'transpiler.routes-script-reassigne': `[ModularJS] ⚠️ le script RÉASSIGNE @routes alors qu'un bloc <routes> existe : la table déclarative est remplacée. Si tu veux seulement l'enrichir, complète-la (@routes['cible']['/x'] = 'composant') au lieu de la réassigner.`,

  // — src/transpiler/macros.ts —
  'transpiler.failed-retry-invalide': ({ valeur }: MsgVars) => `[ModularJS] <@failed> : « ${valeur} » — retry attend un entier positif ou nul (ex. retry="3", retry="0" pour interdire tout réessai).`,
  'transpiler.failed-boundary-retry-epuise': ({ limit }: MsgVars) => `[ModularJS] <@failed> : limite de réessai atteinte (${limit}) — abandon, plus de nouvelle tentative automatique.`,
  'transpiler.head-attr-interpolation-sans-guillemets': ({ macro, ligne, forme, correction }: MsgVars) => `[ModularJS] <@${macro}> ligne ${ligne} : « ${forme} » — dans une balise, une interpolation doit être entre guillemets, sinon un espace dans la valeur ajoute un attribut. Écrivez ${correction}.`,
  'transpiler.head-interpolation-position-attribut': ({ macro, ligne, forme }: MsgVars) => `[ModularJS] <@${macro}> ligne ${ligne} : « ${forme} » — une expression ne peut pas tenir lieu d'attribut dans une balise. Nommez l'attribut et mettez la valeur entre guillemets : <meta name="…" content="{$x}">.`,
  'transpiler.head-interpolation-position-balise': ({ macro, ligne, forme }: MsgVars) => `[ModularJS] <@${macro}> ligne ${ligne} : « ${forme} » — une expression ne peut pas tenir lieu de nom de balise. Écrivez la balise en clair et mettez la donnée dans un attribut entre guillemets ou en texte.`,
  'transpiler.include-slash-final-interdit': ({ target, selfClose, clean }: MsgVars) => `<@include ${target}${selfClose}> : slash final interdit — écrire <@include ${clean}>`,
  'transpiler.include-partial-introuvable': ({ target, baseDir }: MsgVars) => `Partial introuvable : <@include ${target}> (depuis ${baseDir})`,
  'transpiler.include-circulaire': ({ target }: MsgVars) => `<@include> circulaire détecté sur « ${target} » — inclusion ignorée.`,
  'transpiler.include-sans-basedir': ({ target }: MsgVars) => `<@include ${target}> ignoré : compilation sans chemin de fichier (baseDir absent), le partial ne peut pas être résolu`,
  'transpiler.include-hors-racine': ({ target, chemin }: MsgVars) => `<@include ${target}> : ce chemin ('${chemin}') est HORS de sourceDir — jamais suivi ni inliné, pour ne pas publier un fichier hors du projet. Retire ce chemin ou pointe-le vers un partial interne à sourceDir.`,
  'transpiler.window-propriete-non-liable': ({ prop, liables }: MsgVars) => `[ModularJS] <@window ${prop}=!{…}> : propriété non liable. Liables : ${liables}`,
  'transpiler.macro-class-interpolation-non-supportee': ({ macro }: MsgVars) => `<@${macro} class="…{…}…"> : interpolation non supportée dans class= d'une macro globale — utilise @class{cond}="classe".`,
  'transpiler.macro-style-inline-interdit': ({ macro }: MsgVars) => `<@${macro} style="…"> : style inline interdit (règle MJS zéro-CSS-inline). Utilise @style.prop={expr}, --var={expr}, ou la feuille de style globale.`,
  'transpiler.macro-class-non-supportee-cible': ({ macro }: MsgVars) => `<@${macro} class=…> : liaisons class/style non supportées sur cette cible (réservées à <@body>/<@html>).`,
  'transpiler.macro-auto-fermeture-interdite': ({ macro }: MsgVars) => `<@${macro}/> : auto-fermeture interdite — <@${macro}> attend un contenu, ferme-le explicitement (<@${macro}>…</@${macro}>).`,
  'transpiler.macro-balise-non-fermee': ({ macro, extrait }: MsgVars) => `balise <@${macro}> jamais refermée (accolade ou guillemet ouvert sans fermeture) : « ${extrait}… »`,
  'transpiler.include-malforme': ({ extrait }: MsgVars) => `<@include> mal formé : « ${extrait}… » — la forme attendue est <@include chemin> (un chemin seul, sans attribut)`,
  'transpiler.element-accept-invalide': ({ valeur }: MsgVars) => `attribut accept="${valeur}" invalide sur <@element>/<@module> : une liste de noms de balises séparés par des espaces, littérale (ex. accept="iframe style").`,
  'transpiler.element-variable-attendue': ({ macro, extrait }: MsgVars) => `<@${macro}> : la variable de balise doit venir en premier, avant les attributs (${extrait})`,
  'transpiler.element-expression-interdite': ({ macro, extrait }: MsgVars) => `<@${macro}> : le tag est une variable ($tag), pas une expression entre accolades — calcule la valeur dans une dérivée (${extrait})`,

  // — src/transpiler/index.ts —
  'transpiler.import-singleton-ancienne-forme': ({ nom }: MsgVars) => `[ModularJS] « @import §§${nom} » : cette écriture n'existe plus — un singleton s'importe désormais avec « @import µ$$${nom} », puis se consomme en « µ$$${nom} » (§§${nom} reste réservé au contexte réactif d'ancêtres, jamais à l'import).`,
  'transpiler.singleton-mauvaise-consommation': ({ nom }: MsgVars) => `[ModularJS] Le singleton importé « ${nom} » se consomme avec « µ$$${nom} », pas « $${nom} » / « $$${nom} » / « §§${nom} » (@import µ$$${nom} = l'import ; µ$$${nom} = la lecture réactive ; §§${nom} reste le contexte réactif d'ancêtres, un espace différent).`,
  'transpiler.singleton-sans-import': ({ nom }: MsgVars) => `[ModularJS] « µ$$${nom} » utilisé sans « @import µ$$${nom} » correspondant (ni « export µ$$${nom} » dans ce fichier) — µ$$ ne se lit que pour un nom explicitement importé, ou exporté depuis ce même module.`,
  'transpiler.rune-effect-dans-module': ({ rune, ligne }: MsgVars) => `[ModularJS] « ${rune} » dans <script module> (ligne ${ligne}) — le module s'exécute à l'import, sans composant actif : µeffect/µinspect s'appellent au TOP-LEVEL du <script> composant.`,
  'transpiler.rune-effect-imbriquee': ({ rune, ligne }: MsgVars) => `[ModularJS] « ${rune} » imbriqué (ligne ${ligne} du <script>) — µeffect/µinspect s'appellent au TOP-LEVEL du composant : déplace l'appel au niveau racine du <script> (imbriqué — handler, hook, setTimeout… — il était ignoré en silence au runtime).`,
  'transpiler.rune-emit-dans-module': ({ rune, ligne }: MsgVars) => `[ModularJS] « ${rune} » dans <script module> (ligne ${ligne}) — le module s'exécute à l'import, sans composant actif : aucun élément à qui faire émettre l'événement. L'émission appartient au <script> (ou à une méthode appelée depuis lui).`,
  'transpiler.rune-separee-du-symbole': ({ symbole, rune, lieu, ligne }: MsgVars) => `[ModularJS] « ${symbole} » séparé de sa rune « ${rune} » par un espace ou un retour à la ligne (${lieu}, ligne ${ligne}) — écris ${symbole}.${rune} d'un seul tenant, sur une seule ligne : coupée ainsi, la rune échappe à la réécriture et à la détection du compilateur, et le code peut planter à l'exécution.`,
  'transpiler.on-url-change-legacy': ({ moduleName }: MsgVars) => `[ModularJS] ⚠️  ${moduleName} : « @onUrlChange = -> » : forme V1 retirée — le routeur ne l'appelle plus ; écris la rune « µurlChange (path, params) -> ».`,
  // Fragments de « forme trouvée », interpolés dans
  // transpiler.page-marqueur-manquant ci-dessous (même patron que hint-ligne-civet plus bas).
  'transpiler.page-forme-bloc-routes': `le bloc « <routes> »`,
  'transpiler.page-forme-directive-routes': `la directive « @routes »`,
  'transpiler.page-forme-vue': `la balise « <@view> »`,
  'transpiler.page-marqueur-manquant': ({ moduleName, suggestion, forme }: MsgVars) => `[ModularJS] '${moduleName}.mjs' utilise ${forme} sans porter le marqueur « .page.mjs » — hors d'un fichier .page.mjs, cette forme est un refus de compilation. Renomme le fichier en '${suggestion}'.`,
  'transpiler.nom-jamais-declare': ({ nom }: MsgVars) => `[ModularJS] « ${nom} = … » : nom jamais déclaré (Civet n'auto-déclare pas, contrairement à Coffee) — provoquera un « ReferenceError: ${nom} is not defined » à l'exécution. Utilise « ${nom} := … » pour déclarer une nouvelle variable (fonctionne aussi bien avec -> qu'avec =>).`,
  'transpiler.reexport-es-interdit': ({ section, source }: MsgVars) => `[ModularJS] ré-export ES interdit dans ${section} (« export … from '${source}' ») — seule la directive « @import nom 'chemin' » (racine du fichier, hors <script>) est un import MJS valide.`,
  'transpiler.import-es-classique-interdit': ({ section, source }: MsgVars) => `[ModularJS] import ES classique interdit dans ${section} (« import ... '${source}' ») — seule la directive « @import nom 'chemin' » (racine du fichier, hors <script>) est un import MJS valide.`,
  'transpiler.import-dynamique-interdit': ({ section }: MsgVars) => `[ModularJS] import('…') d'un chemin littéral interdit dans ${section} — fichier connu au build : « @import nom 'chemin' » (bundle principal) ou « await µimport('chemin.js') » (chargement paresseux, empreinte résolue au build) ; URL calculée à l'exécution : import(variable) est autorisé tel quel.`,
  'transpiler.rune-import-litteral-requis': ({ section }: MsgVars) => `[ModularJS] µimport exige un chemin littéral dans ${section} (fichier connu au build, empreinte résolue pour toi) — pour une URL calculée à l'exécution, écris import(variable) directement.`,
  'transpiler.rune-import-extension-js': ({ chemin, section }: MsgVars) => `[ModularJS] µimport ne charge que des modules ES « .js » — chemin reçu dans ${section} : ${chemin}.`,
  'transpiler.rune-toggle-cible': ({ section, recu }: MsgVars) => `[ModularJS] µtoggle attend un chemin assignable en premier argument dans ${section} (« $x », « $$x », « §x », « µtheme », « @prop », un nom de variable, éventuellement suivi de « .clé » ou « [0] »), reçu « ${recu} » — c'est lui qui est réaffecté : ni appel, ni « ++ », ni index calculé, car la bascule le relit une fois par test.`,
  'transpiler.rune-toggle-valeur': ({ section, recu }: MsgVars) => `[ModularJS] µtoggle n'accepte que des valeurs littérales dans ${section} (chaîne, nombre, true/false, null), reçu « ${recu} » — une expression serait évaluée deux fois par la bascule.`,
  'transpiler.rune-toggle-doublon': ({ section, recu }: MsgVars) => `[ModularJS] µtoggle : la valeur ${recu} apparaît deux fois dans le cycle (${section}) — le cycle s'y arrêterait pour de bon.`,
  'transpiler.rune-acces-brut-forme': `[ModularJS] µread/µwrite vise un symbole d'état : « µread $x » ou « µread($x) », rien d'autre entre les parenthèses. Pour écrire : « µwrite $x, v » ou « µwrite($x, v) ».`,
  'transpiler.rune-write-ancienne-forme': `[ModularJS] µwrite écrit un symbole d'état avec une virgule : « µwrite $x, v » ou « µwrite($x, v) », jamais un signe égal.`,
  'transpiler.rune-toggle-appel': ({ section }: MsgVars) => `[ModularJS] µtoggle s'écrit toujours en appel parenthésé dans ${section} : « µtoggle($x, 'a', 'b') » — jamais nu ni sans parenthèses.`,
  'transpiler.handler-var-jamais-declaree': ({ moduleName, nom }: MsgVars) => `[ModularJS] '${moduleName}.mjs' : dans un gestionnaire d'événement, « ${nom} » se relit dans sa propre déclaration — ce nom n'existe nulle part (ni <script>, ni <script module>, ni variable de boucle). Il serait recréé à chaque appel et lèverait « Cannot access '${nom}' before initialization » au premier clic. Déclare-le en tête de ton <script> (« ${nom} = … »), ou écris « $${nom} » si tu veux un état réactif.`,
  'transpiler.handler-const-reaffectee': ({ moduleName, nom }: MsgVars) => `[ModularJS] '${moduleName}.mjs' : un gestionnaire d'événement réaffecte « ${nom} », déclaré CONSTANT dans le <script> (« ${nom} := … »). JavaScript lèverait « Assignment to constant variable » au premier clic. Déclare-le avec « = » si tu veux pouvoir le changer, ou écris « $${nom} » pour un état réactif.`,
  // — src/generator/reserved-symbols.ts —
  'transpiler.symbole-reserve-declare': ({ moduleName, section, nom, extrait }: MsgVars) => `[ModularJS] '${moduleName}.mjs' (${section}) : « ${nom} » est un symbole du framework — $ (état), $$ (store), µ (runtime) — il ne peut pas servir de nom de variable, de paramètre ni d'import : « ${extrait} ». Renomme-le (par exemple « el » pour un élément du DOM).`,
  'transpiler.symbole-reserve-nu': ({ nom }: MsgVars) => `[ModularJS] « ${nom} » seul n'est pas un nom : c'est un symbole du framework (§ contexte figé, §§ contexte réactif) — il s'écrit toujours suivi d'un nom (« §theme », « §§count ») et ne peut pas servir de variable, de paramètre ni de valeur.`,
  'transpiler.isnt-identifiant-reserve': `[ModularJS] « isnt » est un opérateur Coffee/Civet (≡ is not) — identifiant réservé, renomme (ex. « isnt_ », « estPas »).`,
  'transpiler.desequilibre-structurel': ({ moduleName, tag, opens, closes }: MsgVars) => `
❌ [Erreur de Syntaxe ModularJS] Dans '${moduleName}.mjs' :
   Le composant <${tag}> présente un déséquilibre structurel.
   Ouvertures : ${opens}, Fermetures : ${closes}.
   Solution : Utilisez <${tag} /> pour les composants vides.`,
  // @callback (forme accolades interdite ET nom invalide, même message pour les deux pièges)
  'transpiler.callback-nom-attendu': ({ valeur }: MsgVars) => `[ModularJS] @callback=${valeur} : la directive attend un NOM de méthode entre guillemets (ex. @callback="maMethode") — pas une expression entre accolades, pas un identifiant composé.`,
  // @permanent : forme NUE seulement, l'appariement se fait par id
  'transpiler.permanent-valeur-refusee': ({ valeur }: MsgVars) => `[ModularJS] @permanent=${valeur} : cette directive ne prend jamais de valeur — l'appariement entre deux navigations se fait par l'id de l'élément, jamais par un nom porté par @permanent ; écris @permanent seul, avec un id stable sur l'élément.`,
  'transpiler.preload-eager-renomme': ({ ou }: MsgVars) => `[ModularJS] @preload : la valeur « eager » n'existe pas — écris « on » (${ou}).`,
  // @confirm forme objet (littéral statique text/ok/cancel seulement) : ne
  // parle plus que du CONTENU d'un hash d'options, une expression SANS « clé: » est désormais un
  // attribut réactif à part (mjs-confirm={expr}), qui ne passe plus par ce message
  'transpiler.confirm-objet-invalide': ({ raw }: MsgVars) => `[ModularJS] @confirm={${raw}} : forme objet invalide — dans un hash d'options, seules les clés text/ok/cancel sont acceptées, en valeurs chaîne littérale entre guillemets simples ou doubles (ex. @confirm={ text: 'Vraiment supprimer ?', ok: 'Supprimer' }) — aucune expression ni variable pour ces clés (une expression seule, sans « clé: », est un attribut réactif : @confirm={maVar}).`,
  // @title forme objet (même esprit que @confirm : littéral statique, une clé catalogue
  // PARTAGÉE pour toutes les erreurs de cette forme — text absent, clé inconnue, valeur non
  // littérale, side/transition hors énumération)
  'transpiler.title-objet-invalide': ({ raw }: MsgVars) => `[ModularJS] @title={${raw}} : forme objet invalide — clés acceptées text (obligatoire)/delay/side/dur/transition, en valeurs chaîne ou nombre littérales (side: 'top'/'bottom', transition: 'fade'/'slide') — aucune expression ni variable.`,
  // @title={{ expr }} (forme HTML) : les deux accolades ouvrantes ACCOLÉES exigent deux
  // fermantes ACCOLÉES symétriques — un corps jamais refermé (fin de fichier) ou refermé par
  // une seule accolade tombent sur ce MÊME message.
  'transpiler.title-html-non-ferme': ({ raw }: MsgVars) => `[ModularJS] @title={{${raw}}} : la forme HTML n'est jamais refermée par une double accolade fermante "}}" — deux accolades fermantes ACCOLÉES sont attendues, symétriques des deux ouvrantes (@title={{ expression }}).`,
  'transpiler.title-html-triple-accolade': ({ extrait }: MsgVars) => `[ModularJS] ${extrait}… : trois accolades ouvrantes ACCOLÉES ("{{{") — ni la forme texte (@title={expr}, une accolade), ni la forme HTML (@title={{expr}}, deux) : la troisième glisserait dans le corps comme un objet littéral, affiché "[object Object]" au survol. Utilise UNE accolade ou DEUX, jamais plus.`,
  // @flash (vocabulaire fermé popup/console/silent, même garde anti-écouteur-fantôme que @callback)
  'transpiler.flash-valeur-invalide': ({ valeur }: MsgVars) => `[ModularJS] @flash=${valeur} : la directive attend "popup", "console" ou "silent" entre guillemets (ex. @flash="popup") — pas une expression entre accolades, pas une autre valeur.`,
  'transpiler.viewtransition-nu-sur-view': ({ label }: MsgVars) => `[ModularJS] ${label} nu sur une <@view> n'a pas d'effet propre — précise un nom (${label}.fade) ; la forme nue (activer avec héritage) n'existe qu'à la racine d'un module.`,
  'transpiler.viewtransition-forme-invalide-sur-view': ({ label, rest }: MsgVars) => `[ModularJS] ${label}${rest} sur <@view> : forme invalide — écris ${label}.<nom>={ direction: …, duration: …, priority: … } (options facultatives).`,
  'transpiler.viewtransition-erreur-parsing-sur-view': ({ label, nameAndDir, erreur }: MsgVars) => `[ModularJS] ${label}.${nameAndDir} sur <@view> : ${erreur}`,
  'transpiler.viewtransition-ancienne-forme-view': ({ label, val, nameOnly }: MsgVars) => {
    const nom = nameOnly || '<nom>'
    return `[ModularJS] ${label}="${val}" remplacé — écris ${label}.${nom} ; la forme dynamique ${label}={expr} reste valable.`
  },
  'transpiler.viewtransition-morph-options-interdites': ({ morphName }: MsgVars) => `[ModularJS] @viewTransition.${morphName}={...} : options réservées aux niveaux de navigation (config, module, <@view>) pour l'instant.`,
  'transpiler.viewtransition-ancienne-forme': ({ val }: MsgVars) => {
    const nom = val || '<nom>'
    return `[ModularJS] @viewTransition="${val}" remplacé — écris @viewTransition.${nom}.`
  },
  'transpiler.viewtransition-etiquette-calculee-interdite': ({ expr }: MsgVars) => `[ModularJS] @viewTransition={${expr}} : étiquette calculée retirée — @viewTransition.<nom> reste fixe. Pour une valeur calculée, écris @style.view-transition-name={${expr}}.`,
  'transpiler.viewtransition-etiquette-conditionnelle-interdite': ({ cond, val }: MsgVars) => `[ModularJS] @viewTransition{${cond}}="${val}" : étiquette conditionnelle retirée — @viewTransition.<nom> reste fixe. Pour une valeur conditionnelle, écris @style.view-transition-name{${cond}}="${val}".`,
  'transpiler.css-trap-fontface': `<style> composant : @font-face en Shadow DOM ne charge PAS la police (limite navigateur). Déclare-la au niveau document : <@head><style>@font-face { font-family: '…'; src: url(µasset('fonts/….woff2')) }</style></@head>. (Sans objet si le composant est monté en mjs-light.)`,
  'transpiler.css-trap-import': `<style> composant : @import est ignoré dans une feuille construite (adoptedStyleSheets). Feuille externe (Google Fonts…) → <@head><link rel="stylesheet" href="…"></@head> ; fichier local → url(µasset('…')).`,
  'transpiler.hint-spread-else-civet': ` Piste : « if … then {…} else {...x} » (objet 100 % spread en else) déclenche un bug Civet amont — contourne avec « Object.assign({}, x) », une clé explicite (« {…, k: v} »), ou un if/else classique.`,
  // même piste, second motif : spread dans le corps-objet d'une flèche
  // FINE `->` (`(x) -> { ...x, k: v }`) — même bug Civet amont, deux contournements.
  'transpiler.hint-spread-fleche-fine-civet': ` Piste : « (x) -> { ...x, k: v } » (spread dans le corps-objet d'une flèche fine) déclenche un bug Civet amont — contourne avec des parenthèses explicites « -> ({ ...x, k: v }) » ou une flèche grasse « => ».`,
  'transpiler.trop-de-variables-etat': ({ moduleName, n, seuil }: MsgVars) => `[ModularJS] ⚠️  ${moduleName} déclare ${n} variables d'état ($) — seuil ${seuil} : découpe en sous-composants/écrans ou structure l'état (objets/tableaux) ; réglage lint.maxStateVars (0 pour désactiver).`,
  // — lint a11y (transpiler/a11y.ts), activé par défaut —
  'transpiler.a11y-img-alt-manquant': ({ moduleName, ligne }: MsgVars) => `[ModularJS] ⚠️  ${moduleName} (ligne ${ligne}) : <img> sans attribut alt — ajoute alt="…" (texte descriptif), ou alt="" si l'image est purement décorative.`,
  'transpiler.a11y-iframe-title-manquant': ({ moduleName, ligne }: MsgVars) => `[ModularJS] ⚠️  ${moduleName} (ligne ${ligne}) : <iframe> sans attribut title — ajoute title="…" décrivant le contenu intégré.`,
  'transpiler.a11y-tabindex-positif': ({ moduleName, ligne, valeur }: MsgVars) => `[ModularJS] ⚠️  ${moduleName} (ligne ${ligne}) : tabindex="${valeur}" positif casse l'ordre de tabulation naturel — utilise tabindex="0" (ordre du DOM) ou réordonne le HTML, jamais un tabindex positif.`,
  'transpiler.a11y-click-non-interactif': ({ moduleName, ligne, tag }: MsgVars) => `[ModularJS] ⚠️  ${moduleName} (ligne ${ligne}) : @click sur <${tag}> non interactif, sans role ni tabindex — ajoute role="button" tabindex="0" (+ la gestion clavier), ou utilise un <button>/<a>.`,
  'transpiler.a11y-bouton-nom-manquant': ({ moduleName, ligne }: MsgVars) => `[ModularJS] ⚠️  ${moduleName} (ligne ${ligne}) : <button> sans nom accessible (rien que des icônes ou du vide) — ajoute aria-label="…" ou du texte visible.`,
  'transpiler.a11y-lien-nom-manquant': ({ moduleName, ligne }: MsgVars) => `[ModularJS] ⚠️  ${moduleName} (ligne ${ligne}) : <a> sans nom accessible (rien que des icônes ou du vide) — ajoute aria-label="…" ou du texte visible.`,
  'transpiler.a11y-champ-etiquette-manquante': ({ moduleName, ligne, tag }: MsgVars) => `[ModularJS] ⚠️  ${moduleName} (ligne ${ligne}) : <${tag}> sans étiquette associée — ajoute <label for="…">…</label> (ou aria-label="…").`,
  'transpiler.a11y-rappel-desactivation': ({ moduleName }: MsgVars) => `[ModularJS] ${moduleName} : pour couper ce contrôle d'accessibilité, "lint": { "a11y": false } dans mjs.config.json.`,
  // — lint ujs-form (transpiler/ujs-form.ts), activé par défaut —
  'transpiler.lint.ujs-form': ({ file, ligne }: MsgVars) => `[ModularJS] ⚠️  ${file}:${ligne} — ce <form> n'a ni action ni @method : UJS l'intercepte quand même et la soumission repart en navigation vers l'URL courante. Pose @noUJS s'il est purement local.`,
  'transpiler.hint-ligne-civet': ({ ligne, ligneFautive }: MsgVars) => ` (ligne ${ligne} indiquée par Civet : \`${ligneFautive}\`)`,
  // (transpiler/index.ts:2062 réutilise 'generator.hint-ternaire-colle' — texte identique, cf. risques §8)
  'transpiler.handler-inline-echec-civet': ({ moduleName, lineHint, civetMsg, gluedTernaryHint }: MsgVars) => `[ModularJS] handler inline : échec de compilation Civet dans « ${moduleName} »${lineHint} — ${civetMsg}${gluedTernaryHint}`,

  // — src/languages/coffee.ts —
  'languages.source-coffee-depreciee': ({ fichier }: MsgVars) => `[ModularJS] ⚠️  source CoffeeScript dépréciée (${fichier}) — migre vers .civet ; l'adaptateur Coffee sera retiré dans une version future.`,

  // — src/languages/index.ts —
  'languages.langage-inconnu': ({ lang, supportes }: MsgVars) => `[languages] langage inconnu : "${lang}". Supportés : ${supportes}`,

  // — src/schema/core.ts —
  'schema.type-inconnu': ({ schema, champ, type, indice, valides }: MsgVars) => `[µschema] schéma '${schema}', champ '${champ}' : type inconnu '${type}'${indice} — types valides : ${valides}, list(type), bits([noms])`,
  'schema.suggestion-type': ({ suggestion }: MsgVars) => ` — tu voulais dire '${suggestion}' ?`,
  'schema.list-type-scalaire': ({ schema, champ, valides, typeDe }: MsgVars) => `[µschema] schéma '${schema}', champ '${champ}' : list() attend un type scalaire (${valides}) — sous-schémas/list imbriquée non supportés en v1, reçu '${typeDe}'`,
  'schema.bits-noms-vides': ({ schema, champ }: MsgVars) => `[µschema] schéma '${schema}', champ '${champ}' : bits() attend un tableau de noms non vide`,
  'schema.bits-trop-de-noms': ({ schema, champ, nb }: MsgVars) => `[µschema] schéma '${schema}', champ '${champ}' : bits() accepte au plus 8 booléens dans son octet (reçu ${nb})`,
  'schema.bits-noms-double': ({ schema, champ }: MsgVars) => `[µschema] schéma '${schema}', champ '${champ}' : bits() — noms en double`,
  'schema.type-champ-invalide': ({ schema, champ }: MsgVars) => `[µschema] schéma '${schema}', champ '${champ}' : type de champ invalide (ni chaîne scalaire, ni list(), ni bits())`,
  'schema.forme-differente': ({ nom, ancien, nouveau }: MsgVars) => `[µschema] schéma '${nom}' déjà déclaré avec une forme différente — garde AJOUT-SEUL : un schéma existant est IMMUABLE (jamais de champ ajouté/retiré/retypé/réordonné). Déclare un schéma à un NOM neuf pour faire évoluer le protocole.
  ancien   : ${ancien}
  nouveau  : ${nouveau}`,
  'schema.registre-plein': ({ nom }: MsgVars) => `[µschema] registre plein — 256 schémas déjà déclarés (id u8 épuisé), impossible d'ajouter '${nom}'`,
  'schema.chaine-trop-longue': ({ type, octets, max }: MsgVars) => `[µschema] chaîne trop longue pour ${type} (${octets} octets UTF-8, max ${max})`,
  'schema.list-trop-longue': ({ of, n }: MsgVars) => `[µschema] list(${of}) : ${n} éléments, max 65535 (compteur u16)`,
  'schema.decode-hors-bornes': `[µschema] decode : trame tronquée/malformée — lecture hors bornes`,
  'schema.encode-schema-inconnu': ({ nom }: MsgVars) => `[µschema] encode() : schéma inconnu '${nom}' — déclare-le d'abord (defSchema/app.schema)`,
  'schema.decode-trame-vide': `[µschema] decode() : trame vide, octet id de schéma attendu`,
  'schema.decode-id-inconnu': ({ id }: MsgVars) => `[µschema] decode() : id de schéma inconnu (${id}) — registre local incomplet ou désynchronisé`,

  // ═══ SERVEURS (src/server/, src/mjs-server/) ════════════════════════════════════════════

  // --- src/server/index.ts ---
  'server.index-hmr-actif': ({ host, port }: MsgVars) => `🔥 HMR actif (ws://${host}:${port}/__mjs_hmr)`,
  'server.index-ecoute': ({ host, port, pathPrefix }: MsgVars) => `📡 Serveur ModularJS : http://${host}:${port}${pathPrefix}/...`,
  // avertissement de configuration — le viseur du journal est une page de
  // consultation SANS authentification : ouverte en production, elle sert les traces de pile
  // complètes (arborescence du serveur, noms de fichiers internes) à qui connaît l'URL
  'server.index-journal-viewer-en-prod': "[ModularJS] ⚠️  journal.viewer est ouvert alors que NODE_ENV vaut 'production' : la page de consultation du journal d'erreurs est servie SANS authentification (messages, URL et traces de pile). Retire `journal.viewer: true` de ta configuration si ce n'est pas volontaire.",

  // --- src/server/hmr.ts ---
  'server.hmr-connecte': '[HMR] connecté',
  'server.hmr-deconnecte': '[HMR] déconnecté — nouvel essai dans {wait} ms',
  'server.hmr-compilation-echouee': '[ModularJS HMR] Échec de compilation :',
  'server.hmr-aucun-message': '(aucun message)',

  // --- src/server/prerender.ts ---
  'server.prerender-route-parametree': 'route paramétrée → prérendu build impossible (passer en mode ssr + serveur)',
  'server.prerender-mode-non-buildable': ({ mode }: MsgVars) => `mode ${mode} (rendu au client/serveur, pas au build)`,
  'server.prerender-banner': ({ url, lang }: MsgVars) => `Page prérendue par MJS (mjs build) pour '${url}'${lang ? ` (langue '${lang}')` : ''} — ne pas éditer à la main.`,
  'server.prerender-echec-rendu': ({ component, langTag, err }: MsgVars) => `échec rendu (${component}${langTag}) : ${err}`,

  // --- src/server/render-request.ts ---
  'server.render-handler-ferme': '[mjs] handler de rendu déjà fermé',
  'server.render-erreur-interne': 'erreur interne',
  'server.render-echec-html': ({ component, pathname, detail }: MsgVars) => `<!-- [mjs] échec du rendu de ${component} pour '${pathname}' : ${detail} -->`,

  // --- src/server/render-browser.ts ---
  'server.browser-erreurs-compilation': ({ errors }: MsgVars) => `[mjs-ssr-browser] erreurs de compilation :\n${errors}`,
  'server.browser-core-introuvable': '[mjs-ssr-browser] mjs_core introuvable après compilation',
  'server.browser-playwright-manquant': "[mjs-ssr-browser] le moteur navigateur requiert Playwright — installe-le : npm i -D playwright (ou configure render.engine.prerender / render.engine.request: 'happy-dom').",
  'server.browser-ferme-pendant-creation': "[mjs-ssr-browser] renderer fermé pendant la création d'une page",
  'server.browser-deja-ferme': '[mjs-ssr-browser] renderer déjà fermé',
  'server.browser-forward-refuse-interne': ({ tag, host }: MsgVars) => `[mjs-ssr-browser] render.forwardOrigin refusé pour <${tag}> : cible réseau interne bloquée (${host}) — proxy désactivé.`,
  'server.browser-prop-invalide': ({ keyJson }: MsgVars) => `[mjs-ssr-browser] nom de prop invalide ignoré : ${keyJson}`,
  'server.browser-composant-non-enregistre': ({ tag }: MsgVars) => `[mjs-ssr-browser] composant <${tag}> non enregistré (vérifiez le nom de fichier en kebab-case minuscule)`,
  'server.browser-non-stabilise': ({ tag, settleMs }: MsgVars) => `[mjs-ssr-browser] rendu de <${tag}> non stabilisé en ${settleMs}ms (scheduler occupé ou {await} encore pending) — HTML potentiellement incomplet, divergence possible à l'hydratation.`,
  'server.browser-erreur-page': ({ tag, err }: MsgVars) => `[mjs-ssr-browser] erreur non interceptée dans la page pour <${tag}> : ${err}`,
  'server.browser-erreur-non-geree': ({ tag }: MsgVars) => `[mjs-ssr-browser] erreur non gérée pendant le rendu de <${tag}> (crash intercepté par le framework sans frontière <@failed> pour l'absorber) — ce rendu est en échec.`,
  'server.browser-shadow-closed': ({ tag }: MsgVars) => `[mjs-ssr-browser] shadowMode:'closed' pour <${tag}> : le client ne peut PAS reprendre la main sur ce rendu (Shadow DOM closed non détectable/adoptable) — le composant échouera à s'hydrater. Utilisez shadowMode:'open' (défaut) si ce composant doit rester interactif côté client.`,
  'server.browser-render-timeout': ({ tag, renderTimeoutMs }: MsgVars) => `[mjs-ssr-browser] rendu de <${tag}> abandonné après ${renderTimeoutMs}ms (timeout de rendu — montage/fetch proxifié probablement bloqué).`,
  'server.browser-ferme-pendant-attente': '[mjs-ssr-browser] renderer fermé pendant une attente de page',
  'server.browser-prerender-happydom-fallback': '[mjs] prérendu happy-dom : installe playwright pour le moteur navigateur (npm i -D playwright).',
  'server.browser-plusieurs-core': ({ files, first }: MsgVars) => `[mjs-ssr-browser] plusieurs mjs_core-*.js présents (${files}) — chargement déterministe de ${first}.`,
  'server.browser-popup-fermee': ({ tag }: MsgVars) => `[mjs-ssr-browser] popup fermée (window.open non suivi, jamais fermé par Playwright) pour <${tag}>`,

  // --- src/server/renderToString.ts ---
  'server.ssr-import-circulaire': ({ names }: MsgVars) => `[mjs-ssr] @import circulaire détecté — ces modules ne peuvent pas être ordonnés pour le rendu serveur : ${names}. Contrairement au bundle client (liaisons ESM natives, live), le SSR évalue chaque module dans une IIFE séquentielle et ne supporte pas les dépendances circulaires. Retirez le cycle entre ces fichiers.`,
  'server.ssr-erreurs-compilation': ({ errors }: MsgVars) => `[mjs-ssr] erreurs de compilation :\n${errors}`,
  'server.ssr-core-introuvable': '[mjs-ssr] mjs_core introuvable après compilation',
  'server.ssr-plusieurs-core': ({ files, first }: MsgVars) => `[mjs-ssr] plusieurs mjs_core-*.js présents (${files}) — chargement déterministe de ${first} ; nettoyez les anciens hachés de l'outputDir pour éviter un core périmé.`,
  'server.ssr-happydom-manquant': '[mjs-ssr] le rendu serveur requiert "happy-dom". Installez-le : npm i happy-dom',
  'server.ssr-eval-echec': ({ message }: MsgVars) => `[mjs-ssr] éval du bundle dans happy-dom : ${message}`,
  'server.ssr-composant-non-enregistre': ({ tag }: MsgVars) => `[mjs-ssr] composant <${tag}> non enregistré (vérifiez le nom de fichier en kebab-case minuscule)`,
  'server.ssr-erreur-non-geree': ({ tag }: MsgVars) => `[mjs-ssr] erreur non gérée pendant le rendu de <${tag}> (crash intercepté par le framework sans frontière <@failed> pour l'absorber) — ce rendu est en échec.`,
  'server.ssr-injection-store-echec': ({ message }: MsgVars) => `[mjs-ssr] injection du store global : ${message}`,
  'server.ssr-prop-invalide': ({ keyJson }: MsgVars) => `[mjs-ssr] nom de prop invalide ignoré : ${keyJson}`,
  'server.ssr-serialisation-echec': ({ expr, errMsg }: MsgVars) => `[mjs-ssr] échec de sérialisation de ${expr} (client démarrera sans cet état) : ${errMsg}`,
  'server.ssr-non-stabilise': ({ tag, settleMs }: MsgVars) => `[mjs-ssr] rendu de <${tag}> non stabilisé en ${settleMs}ms (scheduler occupé ou {await} encore pending) — HTML potentiellement incomplet, divergence possible à l'hydratation.`,
  'server.ssr-shadow-closed': ({ tag }: MsgVars) => `[mjs-ssr] shadowMode:'closed' pour <${tag}> : le client ne peut PAS reprendre la main sur ce rendu (Shadow DOM closed non détectable/adoptable) — le composant échouera à s'hydrater. Utilisez shadowMode:'open' (défaut) si ce composant doit rester interactif côté client.`,
  'server.ssr-forward-refuse-interne': ({ tag, host }: MsgVars) => `[mjs-ssr] render.forwardOrigin refusé pour <${tag}> : cible réseau interne bloquée (${host}) — repli sur l'origine locale.`,
  'server.ssr-forward-url-invalide': ({ tag }: MsgVars) => `[mjs-ssr] render.forwardOrigin refusé pour <${tag}> : forwardedUrl invalide — repli sur l'origine locale.`,
  'server.ssr-await-rejete-sans-branche': ({ tag, message }: MsgVars) => `[mjs-ssr] {await} rejetée dans <${tag}> sans branche {error} pour la consommer (${message}) — rendu vide côté serveur, ajoute {error err}…{end} pour l'afficher.`,

  // --- src/server/serve-entry.ts (chargeurs props/actions .server.mjs) ---
  'server.entry-charge': ({ fichier }: MsgVars) => `[mjs serve] chargeurs serveur : ${fichier}`,
  'server.entry-echec': ({ fichier, erreur, actif }: MsgVars) => `[mjs serve] échec du chargement de '${fichier}' : ${erreur} — ${actif ? 'ancien chargeur conservé' : 'chargeur inactif'}`,
  'server.entry-cle-ignoree': ({ cle }: MsgVars) => `[mjs serve] clé '${cle}' ignorée dans l'entry serveur (attendu : props/actions)`,
  'server.entry-props-invalides': ({ pathname }: MsgVars) => `[mjs serve] props invalides renvoyées pour '${pathname}' (attendu un objet) — ignorées`,
  'server.entry-props-echec': ({ pathname, erreur }: MsgVars) => `[mjs serve] échec du chargeur de props pour '${pathname}' : ${erreur}`,

  // --- src/server/render-server.ts (formulaires POST) ---
  'server.form-cible-invalide': ({ pathname, cible }: MsgVars) => `[mjs serve] action pour '${pathname}' : redirection invalide (attendu une chaîne commençant par '/'), reçu : ${cible}`,
  'server.form-resultat-invalide': ({ pathname }: MsgVars) => `[mjs serve] action pour '${pathname}' : forme de retour invalide (attendu { redirect } ou { errors })`,
  'server.form-fichier-ignore': ({ pathname, champ }: MsgVars) => `[mjs serve] action pour '${pathname}' : champ fichier '${champ}' ignoré (fichiers non pris en charge pour l'instant)`,
  'server.form-champ-reserve-ignore': ({ pathname, champ }: MsgVars) => `[mjs serve] action pour '${pathname}' : champ '${champ}' refusé (nom réservé) — valeur ignorée`,
  // journal du catch de l'exécution d'action (500 imprévu, cas le plus courant en dev).
  'server.action-exception': ({ pathname, erreur }: MsgVars) => `[mjs serve] action pour '${pathname}' : exception non interceptée (${erreur})`,
  // journal du catch global (dernier filet, 500 imprévu quel qu'il soit).
  'server.erreur-imprevue': ({ url, erreur }: MsgVars) => `[mjs serve] erreur imprévue pour '${url}' : ${erreur}`,
  // µres au 1er chargement HTML : échec de sérialisation (référence circulaire...), jamais un 500.
  'server.res-serialisation-echec': ({ pathname, erreur }: MsgVars) => `[mjs serve] échec de sérialisation de µres pour '${pathname}' (page servie sans cet état) : ${erreur}`,

  // --- src/server/journal.ts (journal d'erreurs 3 étages) ---
  'server.journal-ecriture-echec': ({ erreur }: MsgVars) => `[mjs] journal d'erreurs : échec d'écriture (${erreur}) — nouvel essai silencieux aux prochains signalements`,
  'server.journal-viewer-compile-echec': ({ erreur }: MsgVars) => `[mjs] visionneuse du journal d'erreurs : échec de compilation (${erreur})`,
  'server.journal-viewer-manifest-absent': `manifeste introuvable (mjs build requis)`,
  'server.journal-viewer-core-introuvable': `import du cœur introuvable dans le manifeste`,

  // --- src/server/theme-viewer.mjs / viewer-page.ts (atelier /__mjs/theme) ---
  'server.theme-viewer-compile-echec': ({ erreur }: MsgVars) => `[mjs] atelier des variables de thème : échec de compilation (${erreur})`,

  // --- src/server/ssr-head.ts (<head> thématisé SSR anti-flash) ---
  'server.ssr-head-echec': ({ erreur }: MsgVars) => `[mjs] construction du <head> thématisé SSR : échec (${erreur}) — page servie sans thème inliné`,

  // --- src/server/prerender.ts ---
  'server.prerender-fichier-perime-supprime': ({ file }: MsgVars) => `fichier périmé supprimé (${file})`,
  'server.prerender-fragment-sans-route': ({ file }: MsgVars) => `fragment sans route supprimé (${file})`,
  'server.prerender-dossier-vide-retire': ({ dir }: MsgVars) => `dossier vidé de ses fragments retiré (${dir})`,
  'server.prerender-echec-suppression': ({ file, err }: MsgVars) => `échec de la suppression du fichier périmé ${file} : ${err}`,

  // --- src/mjs-server/index.ts ---
  'serveur.index-movesperidentity-invalide': ({ received }: MsgVars) => `[MJS-Server] opts.antiCheat.movesPerIdentity doit être [n entier ≥ 1, fenêtreMs > 0] ou null/absent (désactive le quota), reçu : ${received}`,
  'serveur.index-codeperip-invalide': ({ received }: MsgVars) => `[MJS-Server] opts.antiCheat.codePerIp doit être [n entier ≥ 1, fenêtreMs > 0] ou null (désactive le verrou) ou absent (défaut), reçu : ${received}`,
  'serveur.index-serve-prefixe-reserve': ({ type, prefix }: MsgVars) => `[MJS-Server] app.serve('${type}', …) : préfixe réservé — '${prefix}' est la plomberie interne de MJS-Server, invisible pour l'appli hôte`,
  'serveur.index-on-prefixe-reserve': ({ type, prefix }: MsgVars) => `[MJS-Server] app.on('${type}', …) : préfixe réservé — '${prefix}' est la plomberie interne de MJS-Server, invisible pour l'appli hôte`,
  'serveur.index-schema-prefixe-reserve': ({ type, prefix }: MsgVars) => `[MJS-Server] schéma '${type}' : préfixe réservé — '${prefix}' ne peut pas voyager en binaire, sa charge porte une vue de jeu (un objet), que µschema v1 ne sait pas décrire ; la vue s'encoderait en valeur vide SANS lever`,
  'serveur.index-game-deja-declare': ({ type }: MsgVars) => `[MJS-Server] app.game('${type}', …) : déjà déclaré`,

  // --- src/mjs-server/history.ts ---
  'serveur.histo-ticks-invalide': ({ received }: MsgVars) => `[MJS-Server] history.ticks doit être un entier ≥ 1, reçu : ${received}`,
  'serveur.histo-tampon-vide': '[MJS-Server] game.rewind() : tampon vide (aucun tick encore écoulé, ou partie détruite)',

  // --- src/mjs-server/space.ts ---
  'serveur.space-cell-invalide': ({ received }: MsgVars) => `[MJS-Server] space.cell doit être un nombre > 0, reçu : ${received}`,

  // --- src/mjs-server/matchmaking.ts ---
  // file d'attente publique pleine (plafond DEFAULT_QUEUE_CAP)
  'serveur.matchmaking-file-pleine': ({ type }: MsgVars) => `file d'attente pleine pour '${type}' — réessaie plus tard`,
  'serveur.matchmaking-trop-tentatives-code': 'trop de tentatives de code — patiente',
  'serveur.matchmaking-code-inconnu': ({ code }: MsgVars) => `code inconnu '${code}'`,
  'serveur.matchmaking-play-type-manquant': 'µgame:play : type de jeu manquant',
  'serveur.matchmaking-type-jeu-inconnu': ({ type }: MsgVars) => `type de jeu inconnu '${type}'`,
  'serveur.matchmaking-spectateur-doit-etre-bool': 'µgame:play : spectator doit être true ou absent',
  'serveur.matchmaking-spectateur-sans-code-prive': ({ type }: MsgVars) => `le jeu '${type}' ne supporte pas les parties privées — un spectateur doit désigner une partie existante par code`,
  'serveur.matchmaking-spectateur-code-requis': 'µgame:play : spectator nécessite un code de partie existante',
  'serveur.matchmaking-jeu-sans-parties-privees': ({ type }: MsgVars) => `le jeu '${type}' ne supporte pas les parties privées`,
  'serveur.matchmaking-code-invalide': 'code invalide',
  'serveur.matchmaking-move-partie-manquante': 'µgame:move : partie manquante',
  'serveur.matchmaking-move-coup-manquant': 'µgame:move : coup manquant',
  'serveur.matchmaking-partie-introuvable': 'partie introuvable',
  'serveur.matchmaking-leave-partie-manquante': 'µgame:leave : partie manquante',
  'serveur.matchmaking-resync-partie-manquante': 'µgame:resync : partie manquante',

  // --- src/mjs-server/persist.ts ---
  'serveur.cle-inconnue': ({ prefix, k, hint, clesValides }: MsgVars) => `${prefix}.${k} : clé inconnue${hint}\n  Clés valides : ${clesValides}`,
  'serveur.cle-inconnue-suggestion': ({ suggestion }: MsgVars) => ` — tu voulais dire '${suggestion}' ?`,
  'serveur.persist-option-invalide': ({ prefix, received }: MsgVars) => `${prefix} : attendu un adaptateur { load, save, remove } ou { adapter, debounce?, snapshotEvery? }, reçu : ${received}`,
  'serveur.persist-adaptateur-invalide': ({ prefix, received }: MsgVars) => `${prefix}.adapter doit exposer { load(), save(id, data), remove(id) }, reçu : ${received}`,
  'serveur.persist-debounce-invalide': ({ prefix, received }: MsgVars) => `${prefix}.debounce doit être un nombre ≥ 0 (ms), reçu : ${received}`,
  'serveur.persist-snapshotevery-invalide': ({ prefix, received }: MsgVars) => `${prefix}.snapshotEvery doit être un nombre ≥ 0 (ms, 0 = désactivé), reçu : ${received}`,
  'serveur.persist-save-echoue': ({ id }: MsgVars) => `[MJS-Server] persist.save('${id}') a échoué`,
  'serveur.persist-remove-echoue': ({ id }: MsgVars) => `[MJS-Server] persist.remove('${id}') a échoué`,
  'serveur.persist-load-echoue': '[MJS-Server] persist.load() a échoué — démarrage SANS restauration',
  'serveur.persist-partie-ignoree': ({ id, type }: MsgVars) => `[MJS-Server] persist : partie '${id}' ignorée — type '${type}' non déclaré (app.game() manquant ?)`,
  'serveur.persist-restauration-echouee': ({ id }: MsgVars) => `[MJS-Server] persist : restauration de '${id}' a échoué`,

  // --- src/mjs-server/persist-sql.ts ---
  'serveur.persist-sql-query-manquant': '[MJS-Server] persist-sql : opts.query manquant — attendu (sql, params) => Promise',
  'serveur.persist-sql-dialect-invalide': ({ received }: MsgVars) => `[MJS-Server] persist-sql : opts.dialect doit être '?' ou '$', reçu : ${received}`,
  'serveur.persist-sql-table-invalide': ({ table }: MsgVars) => `[MJS-Server] persist-sql : opts.table '${table}' n'est pas un identifiant SQL valide`,

  // --- src/mjs-server/persist-bridge.ts ---
  'serveur.persist-bridge-delai-depasse': 'délai de requête dépassé',
  'serveur.persist-bridge-url-manquant': '[MJS-Server] persist-bridge : opts.url manquant',
  'serveur.persist-bridge-secret-manquant': '[MJS-Server] persist-bridge : opts.secret manquant',
  'serveur.persist-bridge-http-non-loopback': ({ url }: MsgVars) => `[MJS-Server] persist-bridge (${url}) : http:// non-loopback = risque de falsification de l'état restauré par MITM — utilise https:// ou, en connaissance de cause, { allowInsecure: true }`,
  'serveur.persist-bridge-reponse-http': ({ status }: MsgVars) => `réponse HTTP ${status}`,

  // --- src/mjs-server/persist-file.ts ---
  'serveur.persist-file-dir-manquant': '[MJS-Server] persist-file : opts.dir manquant',

  // --- src/mjs-server/game.ts ---
  'serveur.game-def-invalide': ({ prefix }: MsgVars) => `${prefix} : la définition doit être un objet { seats, state, moves, ... }`,
  'serveur.game-places-invalide': ({ prefix, received }: MsgVars) => `${prefix}.seats doit être un entier ≥ 1, reçu : ${received}`,
  'serveur.game-code-invalide': ({ prefix, received, receivedType }: MsgVars) => `${prefix}.code doit être un booléen, reçu : ${received} (${receivedType})`,
  'serveur.game-seatttl-invalide': ({ prefix, received }: MsgVars) => `${prefix}.seatTtl doit être un nombre > 0 (ms), reçu : ${received}`,
  'serveur.game-tick-invalide': ({ prefix, received }: MsgVars) => `${prefix}.tick doit être un nombre ≥ 0, reçu : ${received}`,
  'serveur.game-tick-hors-plage': ({ prefix, tickHz }: MsgVars) => `${prefix}.tick doit être 0 (événementiel) ou compris entre 1 et 60 (Hz), reçu : ${tickHz}`,
  'serveur.game-mode-invalide': ({ prefix, received }: MsgVars) => `${prefix}.mode doit être 'authoritative' ou 'lockstep', reçu : ${received}`,
  'serveur.game-tick-requis-lockstep': ({ prefix }: MsgVars) => `${prefix}.tick doit être > 0 en mode 'lockstep' — cadence de regroupement des ordres, cf. def.mode`,
  'serveur.game-state-interdit-lockstep': ({ prefix }: MsgVars) => `${prefix}.state interdit en mode 'lockstep' — la salle ne simule rien (aucun état serveur), cf. def.mode`,
  'serveur.game-state-requis': ({ prefix, received }: MsgVars) => `${prefix}.state est requis — fonction (partie) => état initial, reçu : ${received}`,
  'serveur.game-moves-requis': ({ prefix }: MsgVars) => `${prefix}.moves est requis — objet { nom: (partie, joueur, p) => résultat }`,
  'serveur.game-moves-nom-invalide': ({ prefix, nom, received }: MsgVars) => `${prefix}.moves.${nom} doit être une fonction, reçu : ${received}`,
  'serveur.game-view-interdit-lockstep': ({ prefix }: MsgVars) => `${prefix}.view interdit en mode 'lockstep' — aucun état serveur à filtrer, cf. def.mode`,
  'serveur.game-view-invalide': ({ prefix, received }: MsgVars) => `${prefix}.view doit être une fonction (partie, joueur) => vue, reçu : ${received}`,
  'serveur.game-ondivergence-hors-lockstep': ({ prefix }: MsgVars) => `${prefix}.onDivergence nécessite mode: 'lockstep' — aucune détection de divergence hors lockstep`,
  'serveur.game-ondivergence-invalide': ({ prefix, received }: MsgVars) => `${prefix}.onDivergence doit être une fonction (partie, {tick, suspects, raison}) => void, reçu : ${received}`,
  'serveur.game-lockstepjournal-hors-lockstep': ({ prefix }: MsgVars) => `${prefix}.lockstepJournal nécessite mode: 'lockstep' — aucun journal d'ordres hors lockstep`,
  'serveur.game-lockstepjournal-invalide': ({ prefix }: MsgVars) => `${prefix}.lockstepJournal doit être un objet { maxTicks }`,
  'serveur.game-lockstepjournal-maxticks-invalide': ({ prefix, received }: MsgVars) => `${prefix}.lockstepJournal.maxTicks doit être un entier ≥ 1, reçu : ${received}`,
  'serveur.game-phases-invalide': ({ prefix }: MsgVars) => `${prefix}.phases doit être un objet { phase: [coups permis] }`,
  'serveur.game-phases-valeur-invalide': ({ prefix, phase, received }: MsgVars) => `${prefix}.phases.${phase} doit être un tableau de noms de coups (string[]), reçu : ${received}`,
  'serveur.game-turns-invalide': ({ prefix }: MsgVars) => `${prefix}.turns doit être un objet { order?, timeout? }`,
  'serveur.game-turns-order-invalide': ({ prefix, received }: MsgVars) => `${prefix}.turns.order doit être 'roundrobin' ou une fonction (partie) => joueur, reçu : ${received}`,
  'serveur.game-turns-timeout-invalide': ({ prefix, received }: MsgVars) => `${prefix}.turns.timeout doit être un nombre > 0 (ms), reçu : ${received}`,
  'serveur.game-timers-invalide': ({ prefix }: MsgVars) => `${prefix}.timers doit être un objet { nom: (partie) => void }`,
  'serveur.game-timers-nom-reserve': ({ prefix, nom }: MsgVars) => `${prefix}.timers.${nom} : nom de minuterie RÉSERVÉ (interne à MJS-Server) — choisis un autre nom`,
  'serveur.game-timers-nom-invalide': ({ prefix, nom, received }: MsgVars) => `${prefix}.timers.${nom} doit être une fonction, reçu : ${received}`,
  'serveur.game-limits-invalide': ({ prefix }: MsgVars) => `${prefix}.limits doit être un objet { moves?: [n, fenêtreMs] }`,
  'serveur.game-limits-moves-invalide': ({ prefix, received }: MsgVars) => `${prefix}.limits.moves doit être [n entier ≥ 1, fenêtreMs > 0] ou null (désactive le quota), reçu : ${received}`,
  'serveur.game-limits-moveintervalms-invalide': ({ prefix, received }: MsgVars) => `${prefix}.limits.moveIntervalMs doit être un nombre > 0 (ms), reçu : ${received}`,
  'serveur.game-emptyttl-invalide': ({ prefix, received }: MsgVars) => `${prefix}.emptyTtl doit être un nombre > 0 (ms), reçu : ${received}`,
  'serveur.game-hooks-invalide': ({ prefix }: MsgVars) => `${prefix}.hooks doit être un objet { onCreate?, onJoin?, onLeave?, onEnd?, onTurnTimeout? }`,
  'serveur.game-hooks-nom-invalide': ({ prefix, nom, received }: MsgVars) => `${prefix}.hooks.${nom} doit être une fonction, reçu : ${received}`,
  'serveur.game-intents-interdit-lockstep': ({ prefix }: MsgVars) => `${prefix}.intents interdit en mode 'lockstep' — chaque µgame:move devient un ORDRE diffusé tel quel, cf. def.mode`,
  'serveur.game-intents-invalide': ({ prefix }: MsgVars) => `${prefix}.intents doit être un objet { nom: (partie, joueur, p) => void }`,
  'serveur.game-intents-tick-requis': ({ prefix }: MsgVars) => `${prefix}.intents nécessite tick > 0 (mode action) — sans boucle, les intentions ne seraient jamais appliquées`,
  'serveur.game-intents-nom-invalide': ({ prefix, nom, received }: MsgVars) => `${prefix}.intents.${nom} doit être une fonction, reçu : ${received}`,
  'serveur.game-intents-nom-collision': ({ prefix, nom }: MsgVars) => `${prefix}.intents.${nom} : nom déjà pris par moves.${nom} — un coup ne peut pas être à la fois un move classique et une intention`,
  'serveur.game-simulate-interdit-lockstep': ({ prefix }: MsgVars) => `${prefix}.simulate interdit en mode 'lockstep' — le serveur ne calcule rien, cf. def.mode`,
  'serveur.game-simulate-invalide': ({ prefix, received }: MsgVars) => `${prefix}.simulate doit être une fonction (partie, dt) => void, reçu : ${received}`,
  'serveur.game-simulate-tick-requis': ({ prefix }: MsgVars) => `${prefix}.simulate nécessite tick > 0 (mode action)`,
  'serveur.game-slowtick-invalide': ({ prefix }: MsgVars) => `${prefix}.slowTick doit être un objet { hz, fn }`,
  'serveur.game-slowtick-hz-invalide': ({ prefix, received }: MsgVars) => `${prefix}.slowTick.hz doit être un nombre > 0, reçu : ${received}`,
  'serveur.game-slowtick-fn-invalide': ({ prefix, received }: MsgVars) => `${prefix}.slowTick.fn doit être une fonction (partie) => void, reçu : ${received}`,
  'serveur.game-slowtick-tick-requis': ({ prefix }: MsgVars) => `${prefix}.slowTick nécessite tick > 0 (mode action)`,
  'serveur.game-deltas-interdit-lockstep': ({ prefix }: MsgVars) => `${prefix}.deltas interdit en mode 'lockstep' — rien à diffuser en delta (aucun état), cf. def.mode`,
  'serveur.game-deltas-invalide': ({ prefix, received }: MsgVars) => `${prefix}.deltas doit être un booléen, reçu : ${received}`,
  'serveur.game-space-interdit-lockstep': ({ prefix }: MsgVars) => `${prefix}.space interdit en mode 'lockstep' — aucune zone d'intérêt sans état serveur, cf. def.mode`,
  'serveur.game-space-invalide': ({ prefix }: MsgVars) => `${prefix}.space doit être un objet { cell }`,
  'serveur.game-space-cell-invalide': ({ prefix, received }: MsgVars) => `${prefix}.space.cell doit être un nombre > 0, reçu : ${received}`,
  'serveur.game-histo-interdit-lockstep': ({ prefix }: MsgVars) => `${prefix}.history interdit en mode 'lockstep' — pas de positions serveur à historiser, cf. def.mode`,
  'serveur.game-histo-invalide': ({ prefix }: MsgVars) => `${prefix}.history doit être un objet { ticks, extract?, interp? }`,
  'serveur.game-histo-tick-requis': ({ prefix }: MsgVars) => `${prefix}.history nécessite tick > 0 (mode action) — sans boucle, aucun tick à historiser`,
  'serveur.game-histo-ticks-invalide': ({ prefix, received }: MsgVars) => `${prefix}.history.ticks doit être un entier ≥ 1, reçu : ${received}`,
  'serveur.game-histo-extraire-invalide': ({ prefix, received }: MsgVars) => `${prefix}.history.extract doit être une fonction (game) => positions, reçu : ${received}`,
  'serveur.game-histo-extraire-requis': ({ prefix }: MsgVars) => `${prefix}.history.extract est requis quand def.space n'est pas déclaré — aucun extracteur par défaut sans zone d'intérêt`,
  'serveur.game-histo-interp-invalide': ({ prefix, received }: MsgVars) => `${prefix}.history.interp doit être un nombre ≥ 0 (ms) — 0 = aucun retard d'interpolation déclaré, reçu : ${received}`,
  'serveur.game-suspect-invalide': ({ prefix, received }: MsgVars) => `${prefix}.suspect doit être une fonction (coup, contexte) => résultat, reçu : ${received}`,
  'serveur.game-antirejeu-invalide': ({ prefix, received }: MsgVars) => `${prefix}.antiReplay doit être true (ou absent), reçu : ${received}`,
  'serveur.game-onsuspicion-invalide': ({ prefix, received }: MsgVars) => `${prefix}.onSuspicion doit être une fonction (evenement) => void, reçu : ${received}`,
  'serveur.game-spectatorview-invalide': ({ prefix, received }: MsgVars) => `${prefix}.spectatorView doit être une fonction (partie) => vue, reçu : ${received}`,
  'serveur.game-view-absente-avertissement': ({ type }: MsgVars) => `game('${type}') : def.view absente — l'état COMPLET est diffusé à tous les sièges ; définis def.view pour masquer l'état secret`,

  // --- src/mjs-server/game.ts ---
  'serveur.partie-phase-inconnue': ({ phase, phases }: MsgVars) => `[MJS-Server] game.to('${phase}') : phase inconnue — phases déclarées : ${phases}`,
  'serveur.partie-timer-nom-reserve': ({ nom }: MsgVars) => `[MJS-Server] game.timer('${nom}', …) : nom réservé (interne à MJS-Server)`,
  'serveur.partie-vuede-lockstep': "[MJS-Server] game.viewFor() : indisponible en mode 'lockstep' (aucun état serveur, cf. def.mode)",
  'serveur.partie-rembobiner-sans-histo': '[MJS-Server] game.rewind() nécessite def.history — cf. game.ts',
  'serveur.partie-instantvupar-sans-histo': '[MJS-Server] game.timeSeenBy() nécessite def.history — cf. game.ts',
  'serveur.partie-complete': 'partie complète',
  'serveur.partie-pas-dans-partie': "vous n'êtes pas dans cette partie",
  'serveur.partie-spectateur-sans-vue': ({ type }: MsgVars) => `game('${type}') : spectateur sans def.spectatorView/def.view — aucun état diffusé (anti-fuite)`,
  'serveur.partie-pas-assis': "vous n'êtes pas assis dans cette partie",
  'serveur.partie-terminee': 'partie terminée',
  'serveur.partie-spectateur-lecture-seule': 'spectateur : lecture seule',
  'serveur.partie-coup-interdit-phase': ({ coup, phase }: MsgVars) => `coup '${coup}' interdit en phase '${phase}'`,
  'serveur.partie-pas-votre-tour': "ce n'est pas votre tour",
  'serveur.partie-trop-de-coups': 'trop de coups, ralentis',
  'serveur.partie-coup-inconnu': ({ coup }: MsgVars) => `coup inconnu '${coup}'`,
  'serveur.partie-tick-rejete': ({ quoi, msg }: MsgVars) => `boucle de tick — ${quoi} a rejeté : ${msg}`,
  'serveur.partie-tick-leve': ({ quoi, msg }: MsgVars) => `boucle de tick — ${quoi} a levé : ${msg}`,
  'serveur.partie-coup-rejete-suspect': ({ coup, raison }: MsgVars) => `[MJS-Server] coup '${coup}' rejeté — suspect (${raison})`,
  'serveur.partie-coup-rejete-rejeu': ({ coup, seq, dernier }: MsgVars) => `[MJS-Server] coup '${coup}' rejeté — rejeu détecté (seq ${seq} ≤ ${dernier})`,
  'serveur.partie-coup-rejete-sequence-avance': ({ coup, seq, dernier }: MsgVars) => `[MJS-Server] coup '${coup}' rejeté — séquence trop en avance (seq ${seq}, dernier ${dernier})`,
  'serveur.partie-coup-rejete-cadence': ({ coup }: MsgVars) => `[MJS-Server] coup '${coup}' rejeté — cadence trop rapide`,
  'serveur.partie-coup-rejete-quota-identite': ({ coup }: MsgVars) => `[MJS-Server] coup '${coup}' rejeté — quota de coups par identité dépassé`,

  // --- src/mjs-server/persist-redis.ts + persist-bridge.ts + persist-sql.ts + persist-file.ts (mutualisées) ---
  'serveur.persist-backend-rejet-non-intercepte': ({ backend, label }: MsgVars) => `persist-${backend} : ${label} — rejet non intercepté`,
  'serveur.persist-backend-load-echoue': ({ backend }: MsgVars) => `persist-${backend} : load() a échoué — démarrage SANS restauration`,
  'serveur.persist-backend-save-echouee': ({ backend, id }: MsgVars) => `persist-${backend} : save('${id}') a échoué`,
  'serveur.persist-backend-remove-echouee': ({ backend, id }: MsgVars) => `persist-${backend} : remove('${id}') a échoué`,
  'serveur.persist-backend-entree-illisible': ({ backend, id }: MsgVars) => `persist-${backend} : entrée '${id}' illisible (JSON invalide) — ignorée`,

  // --- src/mjs-server/persist-redis.ts ---
  'serveur.persist-redis-operation-echouee': ({ label }: MsgVars) => `persist-redis : ${label} a échoué`,
  'serveur.persist-redis-connexion-indisponible': ({ label, timeout }: MsgVars) => `persist-redis : ${label} abandonné — connexion Redis indisponible après ${timeout} ms (le prochain save() rattrapera l'état)`,
  'serveur.persist-redis-load-delai-depasse': ({ timeout }: MsgVars) => `persist-redis : load() délai de connexion Redis dépassé (${timeout} ms) — démarrage SANS restauration`,

  // --- src/mjs-server/persist-bridge.ts ---
  'serveur.persist-bridge-load-tentative-echouee': ({ tentative }: MsgVars) => `persist-bridge : load() tentative ${tentative} échouée`,
  'serveur.persist-bridge-load-abandonne': 'persist-bridge : load() abandonné — démarrage SANS restauration',
  'serveur.persist-bridge-load-reponse-illisible': 'persist-bridge : load() réponse illisible',
  // entrées {id,data} malformées reçues du back, filtrées avant restitution
  'serveur.persist-bridge-load-entrees-invalides': ({ nb }: MsgVars) => `persist-bridge : load() ${nb} entrée(s) malformée(s) ignorée(s) (id/data invalides)`,
  'serveur.persist-bridge-tentative-echouee': ({ label, tentative }: MsgVars) => `persist-bridge : ${label} tentative ${tentative} échouée`,
  'serveur.persist-bridge-abandonne-apres-tentatives': ({ label, tentatives }: MsgVars) => `persist-bridge : ${label} abandonné après ${tentatives} tentative(s)`,

  // --- src/mjs-server/persist-sql.ts (suite) ---
  'serveur.persist-sql-table-creation-echouee': ({ table }: MsgVars) => `persist-sql : création de la table '${table}' a échoué`,

  // --- src/mjs-server/persist-file.ts (suite) ---
  'serveur.persist-file-fichier-corrompu': ({ fichier }: MsgVars) => `persist-file : fichier corrompu ignoré '${fichier}'`,

  // ═══ MJS-WS (src/mjs-ws/) ════════════════════════════════════════════════════════════════

  // avertissement de configuration — l'authentification par COOKIE rejoue le
  // cookie de la requête d'ouverture ; le navigateur l'attache tout seul, y compris depuis une
  // page tierce (une ouverture WebSocket n'est pas soumise à la politique des requêtes ordinaires).
  // Sans contrôle d'origine, une page tierce ouvre donc une connexion AUTHENTIFIÉE. Le patron par
  // jeton explicite n'a pas ce défaut : la page tierce ne peut pas lire le jeton
  'ws.core.origine-non-verifiee-avec-cookie': "[mjs-ws] ⚠️  authentification par cookie SANS verifyOrigin : n'importe quelle page tierce peut ouvrir une connexion authentifiée au nom de tes visiteurs (le navigateur joint le cookie tout seul). Arme verifyOrigin avec la liste des origines de ton application — cf. docs/23-mjs-ws.md § Vérifier l'origine.",

  // — adapter-redis.ts
  'ws.adapter-redis.entier-invalide': ({ line }: MsgVars) => `[mjs-ws/adapter-redis] entier RESP invalide '${line}' — flux corrompu ou pas du RESP`,
  'ws.adapter-redis.longueur-bulk-invalide': ({ line }: MsgVars) => `[mjs-ws/adapter-redis] longueur bulk RESP invalide '${line}' — flux corrompu ou pas du RESP`,
  'ws.adapter-redis.longueur-tableau-invalide': ({ line }: MsgVars) => `[mjs-ws/adapter-redis] longueur de tableau RESP invalide '${line}' — flux corrompu ou pas du RESP`,
  'ws.adapter-redis.octet-inattendu': ({ hex }: MsgVars) => `[mjs-ws/adapter-redis] octet RESP inattendu 0x${hex} — flux corrompu ou pas du RESP`,
  'ws.adapter-redis.url-invalide': ({ raw }: MsgVars) => `[mjs-ws/adapter-redis] URL Redis invalide '${raw}'`,
  'ws.adapter-redis.url-schema-invalide': ({ raw, protocol }: MsgVars) => `[mjs-ws/adapter-redis] URL Redis invalide '${raw}' — schéma attendu 'redis://' (ou 'rediss://'), reçu '${protocol}'`,
  'ws.adapter-redis.url-base-invalide': ({ raw, path }: MsgVars) => `[mjs-ws/adapter-redis] URL Redis invalide '${raw}' — base '${path}' n'est pas un entier`,
  'ws.adapter-redis.auth-echec': ({ role, err }: MsgVars) => `[mjs-ws/adapter-redis] authentification Redis en échec (${role}) : ${err}`,
  'ws.adapter-redis.flux-corrompu': ({ role, err }: MsgVars) => `[mjs-ws/adapter-redis] flux RESP corrompu (${role}) — connexion fermée pour reconnexion propre : ${err}`,
  'ws.adapter-redis.reconnexion-backoff': ({ role, delay }: MsgVars) => `[mjs-ws/adapter-redis] reconnexion Redis (${role}) dans ${delay} ms`,
  'ws.adapter-redis.connexion-perdue': ({ role }: MsgVars) => `connexion Redis perdue (${role})`,
  'ws.adapter-redis.connexion-indisponible': ({ role }: MsgVars) => `connexion Redis indisponible (${role})`,
  'ws.adapter-redis.adaptateur-arrete': ({ role }: MsgVars) => `adaptateur arrêté (${role})`,
  'ws.adapter-redis.message-non-json': ({ channel }: MsgVars) => `[mjs-ws/adapter-redis] message non-JSON reçu sur '${channel}' — ignoré`,
  'ws.adapter-redis.publish-echec': ({ channel, err }: MsgVars) => `[mjs-ws/adapter-redis] publish('${channel}') en échec : ${err}`,
  'ws.adapter-redis.subscribe-echec': ({ channel, err }: MsgVars) => `[mjs-ws/adapter-redis] subscribe('${channel}') en échec : ${err}`,

  // — bridge.ts
  'ws.bridge.secret-manquant': ({ label }: MsgVars) => `[MJS-WS] ${label} manquant — un secret est OBLIGATOIRE pour activer le pont (chaîne littérale, ou 'env:NOM_VAR')`,
  'ws.bridge.secret-env-absent': ({ label, varName }: MsgVars) => `[MJS-WS] ${label} référence la variable d'environnement '${varName}' — absente ou vide`,
  'ws.bridge.webhooks-url-manquant': '[MJS-WS] opts.bridge.webhooks.url manquant',
  'ws.bridge.webhooks-events-vide': "[MJS-WS] opts.bridge.webhooks.events doit être un tableau non vide (ex. ['connect', 'message:chat'])",
  'ws.bridge.signature-manquante': 'signature manquante (en-têtes x-mjs-ws-timestamp / x-mjs-ws-signature requis)',
  'ws.bridge.timestamp-invalide': 'x-mjs-ws-timestamp invalide (unix, en secondes, attendu)',
  'ws.bridge.horodatage-hors-fenetre': 'horodatage hors fenêtre — requête trop vieille ou rejeu suspect',
  'ws.bridge.nonce-requis': ({ min, max }: MsgVars) => `x-mjs-ws-nonce requis (chaîne de ${min} à ${max} caractères) — nonce anti-rejeu actif (ws.bridge.nonce)`,
  'ws.bridge.signature-invalide': 'signature invalide',
  'ws.bridge.corps-trop-volumineux': 'corps de requête trop volumineux (max 1 Mo)',
  'ws.bridge.erreur-lecture-corps': 'erreur de lecture du corps de la requête',
  'ws.bridge.type-requis': "'type' requis (chaîne non vide)",
  'ws.bridge.except-invalide': "'except' doit être une chaîne ou un tableau de chaînes",
  'ws.bridge.client-ou-user': "fournis exactement l'un de 'client' ou 'user' (pas les deux, pas aucun)",
  'ws.bridge.client-user-chaine': "'client'/'user' doit être une chaîne non vide",
  'ws.bridge.room-requis': "'room' requis (chaîne non vide)",
  'ws.bridge.name-requis': "'name' requis (chaîne non vide)",
  'ws.bridge.op-invalide': "'op' doit être 'add', 'update', 'remove' ou 'reset'",
  'ws.bridge.id-requis-add': "'id' requis pour op 'add'",
  'ws.bridge.value-requis-add': "'value' requis pour op 'add'",
  'ws.bridge.id-requis-update': "'id' requis pour op 'update'",
  'ws.bridge.value-objet-update': "'value' doit être un objet (le patch) pour op 'update'",
  'ws.bridge.id-requis-remove': "'id' requis pour op 'remove'",
  'ws.bridge.values-objet-reset': "'values' doit être un objet pour op 'reset'",
  'ws.bridge.chemin-inconnu': ({ route }: MsgVars) => `chemin inconnu '${route}'`,
  'ws.bridge.requete-refusee': ({ error }: MsgVars) => `pont : requête refusée (${error})`,
  'ws.bridge.json-invalide': 'JSON invalide',
  'ws.bridge.erreur-interne': 'pont : erreur interne',
  'ws.bridge.delai-webhook-depasse': 'délai de webhook dépassé',
  'ws.bridge.reponse-http-non-2xx': 'réponse HTTP non-2xx',
  'ws.bridge.webhook-abandonne': ({ event, tentative }: MsgVars) => `pont : webhook '${event}' abandonné après ${tentative} tentative(s)`,
  'ws.bridge.file-webhooks-pleine': ({ max, event }: MsgVars) => `pont : file de webhooks pleine (${max}) — événement '${event}' abandonné`,
  'ws.bridge.erreur-interne-non-geree': 'pont : erreur interne non gérée',
  'ws.bridge.ecoute-pont': ({ host, port, nonce }: MsgVars) => `pont universel en écoute sur http://${host}:${port}${nonce ? ' (nonce : exigé)' : ''}`,
  // validation d'entrée AVANT tout envoi (broadcast/send/room-send/stream)
  'ws.bridge.charge-non-serialisable': ({ depth }: MsgVars) => `charge ('p'/'value'/'values') non sérialisable ou trop imbriquée (> ${depth} niveaux)`,
  'ws.bridge.echec-envoi': 'pont : échec d\'envoi — l\'encodage réseau du message a échoué côté serveur',

  // — chat.ts
  // canJoin/moderators qui lèvent : détail au journal serveur
  // (ces 2 clés), message GÉNÉRIQUE au client ('chat-denied', déjà catalogué par le handler appelant)
  'ws.chat.canjoin-a-leve': 'canJoin() a levé',
  'ws.chat.moderators-a-leve': 'moderators() a levé',

  // — accounts.ts
  'ws.accounts.dir-manquant': '[MJS-WS] FileAccountsPersistAdapter : opts.dir manquant',
  'ws.accounts.fichier-corrompu-ignore': ({ fichier }: MsgVars) => `comptes:file : fichier corrompu ignoré '${fichier}'`,
  'ws.accounts.remove-echoue': ({ id }: MsgVars) => `comptes:file : remove('${id}') a échoué`,
  'ws.accounts.rejet-non-intercepte': ({ label }: MsgVars) => `comptes:file : ${label} — rejet non intercepté`,
  'ws.accounts.save-echoue': ({ id }: MsgVars) => `comptes:file : save('${id}') a échoué`,
  'ws.accounts.secret-manquant': '[MJS-WS] accountsPackage : opts.secret manquant — DOIT être le MÊME secret que accountsAuth(secret) posé en mjsWs({ auth }) (cf. docs/27-accounts.md « Élévation »)',
  'ws.accounts.adaptateur-memoire-defaut': 'adaptateur mémoire (défaut) — les comptes NE SURVIVENT PAS à un redémarrage. DEV SEULEMENT : fournis opts.persist (FileAccountsPersistAdapter, ou un adaptateur maison) en production.',
  'ws.accounts.persist-load-echoue': 'persist.load() a échoué — démarrage SANS comptes restaurés',
  'ws.accounts.persist-echec': ({ name }: MsgVars) => `persist.save() a échoué — compte '${name}' non créé`,

  // — core.ts
  'ws.core.envoi-ignore-contre-pression': ({ clientId }: MsgVars) => `envoi ignoré (contre-pression) vers ${clientId}`,
  'ws.core.close-contre-pression-persistante': 'contre-pression persistante',
  'ws.core.echec-envoi-binaire': "échec d'envoi (binaire)",
  'ws.core.echec-serialisation': ({ type }: MsgVars) => `échec de sérialisation (type '${type}')`,
  'ws.core.echec-envoi': "échec d'envoi",
  'ws.core.client-expulse': ({ clientId, reason }: MsgVars) => `client ${clientId} expulsé (${reason})`,
  'ws.core.close-jeton-expire': 'jeton expiré',
  'ws.core.connexion-refusee-origine': ({ origin, address }: MsgVars) => `connexion refusée — origine non autorisée (${origin ?? 'absente'}, ${address ?? 'ip inconnue'})`,
  'ws.core.close-origine-refusee': 'origine refusée',
  'ws.core.plafond-global-atteint': ({ max }: MsgVars) => `plafond global de connexions atteint (${max})`,
  'ws.core.plafond-par-ip-atteint': ({ ip, max }: MsgVars) => `plafond par IP atteint (${ip}, ${max})`,
  'ws.core.connexion-refusee-raison': ({ reason }: MsgVars) => `connexion refusée — ${reason}`,
  'ws.core.close-reessayez-plus-tard': 'réessayez plus tard',
  'ws.core.verifyorigin-exception': 'connexion refusée — verifyOrigin a levé une exception',
  'ws.core.close-inactivite': 'inactivité',
  'ws.core.erreur-interne-non-geree': 'erreur interne non gérée',
  'ws.core.close-payload-trop-volumineux': 'payload trop volumineux',
  'ws.core.hello-attendu-premier': 'µ:hello attendu en premier message',
  'ws.core.hello-deja-recu': 'hello déjà reçu',
  'ws.core.type-inconnu': ({ type }: MsgVars) => `type inconnu '${type}'`,
  'ws.core.json-invalide-recu': ({ clientId }: MsgVars) => `JSON invalide reçu de ${clientId}`,
  'ws.core.close-trop-messages-invalides': 'trop de messages invalides',
  'ws.core.debit-depasse-ralentis': 'débit dépassé, ralentis',
  'ws.core.close-debit-depasse': 'débit dépassé',
  'ws.core.close-trame-binaire-trop-volumineuse': 'trame binaire trop volumineuse',
  'ws.core.accroche-binaire-a-leve': "l'accroche binaire interne a levé",
  'ws.core.close-protocole-non-supporte': 'protocole non supporté',
  'ws.core.auth-exception-interne': ({ clientId, err }: MsgVars) => `opts.auth a levé une exception interne pour ${clientId} — message masqué au client : ${err}`,
  'ws.core.close-authentification-refusee': 'authentification refusée',
  'ws.core.close-session-deja-active': 'session déjà active pour cette identité',
  'ws.core.welcome-a-leve': 'welcome() a levé — µ:welcome envoyé quand même (charge {})',
  'ws.core.client-repris': ({ clientId, sessionId, count }: MsgVars) => `client ${clientId} repris (session ${sessionId}, ${count} trame(s) rejouée(s))`,
  'ws.core.serve-a-leve': ({ type }: MsgVars) => `serve('${type}') a levé`,
  'ws.core.on-a-leve': ({ type }: MsgVars) => `on('${type}') a levé`,
  'ws.core.uncaught-exception-survit': 'uncaughtException — process survit',
  'ws.core.unhandled-rejection-survit': 'unhandledRejection — process survit',
  'ws.core.paquet-deja-installe': ({ nom }: MsgVars) => `paquet '${nom}' déjà installé — installation ignorée`,
  'ws.core.installer-a-leve': ({ nom }: MsgVars) => `installer('${nom}') a levé — paquet NON installé`,
  'ws.core.process-distant-bail-expire': ({ pid }: MsgVars) => `[MJS-WS] process distant '${pid}' — bail expiré, purge de ses pairs de présence`,
  'ws.core.verification-baux-echec': ({ err }: MsgVars) => `[MJS-WS] vérification des baux distants en échec : ${err}`,
  'ws.core.renouvellement-bail-echec': ({ err }: MsgVars) => `[MJS-WS] renouvellement du bail en échec : ${err}`,

  // — index.ts
  'ws.index.adapter-redis-manquant': "[MJS-WS] opts.adapter.redis manquant — attendu une URL 'redis://...' (ou une instance MjsWsAdapter déjà construite)",
  'ws.index.transport-invalide': ({ raw }: MsgVars) => `[MJS-WS] transport invalide : '${raw}' — valeurs valides : 'ws', 'uws', ou une instance MjsWsTransport`,
  'ws.index.session-exclusive-invalide': ({ raw }: MsgVars) => `[MJS-WS] sessionExclusive invalide : ${raw} — valeurs valides : true, false, 'replace', 'refuse'`,

  // — lobby.ts
  // clé HISTORIQUE inchangée (lobby.ts la référence telle quelle) —
  // seul le TEXTE est corrigé : l'option réelle est `opts.onJoin`, jamais `onRejoindre`.
  'ws.lobby.onrejoindre-a-leve': 'onJoin a levé',
  // moderators qui lève (lobby:withdraw) : détail au journal
  // serveur (cette clé), message GÉNÉRIQUE au client ('lobby-denied', déjà catalogué par le handler)
  'ws.lobby.moderators-a-leve': 'moderators() a levé',

  // — proxy.ts
  'ws.proxy.secret-manquant': ({ label }: MsgVars) => `[MJS-WS] ${label} : 'secret' manquant — OBLIGATOIRE (chaîne littérale, ou 'env:NOM_VAR')`,
  'ws.proxy.secret-env-absent': ({ label, varName }: MsgVars) => `[MJS-WS] ${label} : 'secret' référence la variable d'environnement '${varName}' — absente ou vide`,
  'ws.proxy.url-manquante': "[MJS-WS] proxy de décision : 'url' manquante (chaîne non vide attendue)",
  'ws.proxy.url-invalide': ({ url }: MsgVars) => `[MJS-WS] proxy de décision : 'url' invalide : ${url}`,
  'ws.proxy.http-non-loopback': ({ url }: MsgVars) => `[MJS-WS] proxy de décision (${url}) : http:// non-loopback = risque d'usurpation d'identité par MITM — utilise https:// ou, en connaissance de cause, { allowInsecure: true }`,
  'ws.proxy.cache-ttl-invalide': ({ url }: MsgVars) => `[MJS-WS] proxy de décision (${url}) : 'cache.ttl' doit être un entier > 0 (ms)`,
  'ws.proxy.signature-absente': 'non signée (en-têtes x-mjs-ws-timestamp/x-mjs-ws-signature absents)',
  'ws.proxy.timestamp-invalide': 'x-mjs-ws-timestamp invalide',
  'ws.proxy.horodatage-hors-fenetre': 'horodatage hors fenêtre (rejeu suspect)',
  'ws.proxy.reponse-statut-refus': ({ url, status, event }: MsgVars) => `proxy de décision — ${url} a répondu ${status} (event '${event}') — décision de refus`,
  'ws.proxy.reponse-signature-refus': ({ url, erreur, event }: MsgVars) => `proxy de décision — ${url} : réponse ${erreur} (event '${event}') — décision de refus`,
  'ws.proxy.reponse-json-invalide': ({ url, event }: MsgVars) => `proxy de décision — ${url} : réponse JSON invalide (event '${event}') — décision de refus`,
  'ws.proxy.requete-en-echec': ({ url, event }: MsgVars) => `proxy de décision — ${url} en échec (event '${event}') — décision de refus`,
  'ws.proxy.authentification-refusee': 'authentification refusée (proxy)',
  // plafond de la réponse du back (MÊME esprit que le corps entrant du pont)
  'ws.proxy.reponse-trop-volumineuse': ({ url, event, max }: MsgVars) => `proxy de décision — ${url} : réponse trop volumineuse (plafond ${max} octets, event '${event}') — décision de refus`,

  // — rooms.ts
  'ws.rooms.meta-a-leve': 'rooms.meta() a levé',
  // join/canSeePresence qui lèvent : détail au journal serveur
  // (ces 2 clés), même message GÉNÉRIQUE au client que le refus explicite (false), juste en dessous
  'ws.rooms.join-a-leve': 'join() a levé',
  'ws.rooms.acces-salon-refuse': 'accès au salon refusé',
  'ws.rooms.can-see-presence-a-leve': 'canSeePresence() a levé',
  'ws.rooms.acces-presence-refuse': 'accès à la présence du salon refusé',
  'ws.rooms.trop-de-salons': 'trop de salons',

  // — schema.ts
  'ws.schema.codec-invalide': ({ raw }: MsgVars) => `[MJS-WS] ws.codec invalide : '${raw}' — valeurs valides : 'auto', 'binary', 'json'`,
  'ws.schema.binaire-strict-refuse': ({ type }: MsgVars) => `[MJS-WS] ws.codec 'binary' strict — envoi du type applicatif '${type}' SANS schéma déclaré. Déclare-le d'abord : app.schema('${type}', { ... }) (ou opts.schemas en masse), ou repasse en ws.codec 'auto'/'json' si ce type doit vraiment voyager en JSON.`,
  'ws.schema.decodage-echec': 'µschema — décodage en échec (trame corrompue ?)',
  'ws.schema.id-inconnu-desynchronise': ({ id }: MsgVars) => `id de schéma inconnu (${id}) — registre local désynchronisé, cf. µ:schema`,
  'ws.schema.trame-binaire-corrompue': 'trame binaire corrompue',
  'ws.schema.texte-strict-rejete': ({ type }: MsgVars) => `ws.codec 'binary' strict — type applicatif texte '${type}' rejeté, déclare-le via app.schema() (ou repasse en codec 'auto'/'json')`,

  // — sessions.ts
  'ws.sessions.expiree-purge-differee': ({ id, clientId }: MsgVars) => `session ${id} expirée sans retour — purge différée de ${clientId}`,
  'ws.sessions.client-parque': ({ clientId, id, grace }: MsgVars) => `client ${clientId} parqué (session ${id}, grâce ${grace} ms)`,
  'ws.sessions.tampon-reprise-deborde': ({ clientId, id }: MsgVars) => `tampon de reprise débordé pour ${clientId} (session ${id}) — session non reprenable`,
  'ws.sessions.session-revoquee': ({ id, clientId }: MsgVars) => `session ${id} révoquée (identité déjà reconnectée ailleurs) — purge de ${clientId}`,

  // — streams.ts
  'ws.streams.mutation-clusterisee-echec': ({ name }: MsgVars) => `flux '${name}' — mutation clusterisée en échec`,
  'ws.streams.flux-non-declare': ({ via, name }: MsgVars) => `${via} vers un flux non déclaré '${name}' — reset vide renvoyé`,
  'ws.streams.application-avec-trou': ({ name, reason, count }: MsgVars) => `flux '${name}' — ${reason} : application avec un trou (${count} delta(s) en attente)`,
  'ws.streams.tampon-reordonnancement-plein': ({ max }: MsgVars) => `tampon de réordonnancement plein (${max})`,
  'ws.streams.delai-reordonnancement-depasse': ({ ms }: MsgVars) => `délai de réordonnancement dépassé (${ms} ms)`,
  // garde d'ABONNEMENT (canSubscribe/room, cf. MjsWsStreamOptions)
  'ws.streams.room-sans-accroche': ({ name, room }: MsgVars) => `flux '${name}' — option 'room' ('${room}') exige un accroche que le moteur ne câble pas encore (createStreamsEngine, paramètre hasRoomMember absent) : app.stream() refuse de démarrer plutôt que de laisser 'room' silencieusement sans effet — utilise canSubscribe: (client) => app.room('${room}').has(client) en attendant`,
  'ws.streams.abonnement-refuse': ({ via, name }: MsgVars) => `${via} refusé vers le flux '${name}' — garde d'accès non satisfaite (canSubscribe/room)`,
  'ws.streams.acces-flux-refuse': 'accès au flux refusé',
  // garde de profondeur/sérialisation (add/update/reset)
  'ws.streams.entree-non-serialisable': ({ name, op, depth }: MsgVars) => `flux '${name}' — ${op}() refusé : valeur non sérialisable ou trop imbriquée (> ${depth} niveaux) — jamais stockée (empoisonnerait durablement snapshot()/µ:sub-stream pour tout futur abonné)`,

  // — transport-uws.ts
  'ws.transport-uws.paquet-requis': "le paquet uWebSockets.js est requis pour transport: 'uws' — npm install uNetworking/uWebSockets.js#v20.52.0",
  'ws.transport-uws.echec-ecoute': ({ port, host }: MsgVars) => `[mjs-ws/transport-uws] échec d'écoute sur le port ${port}${host ? ` (${host})` : ''} — port déjà utilisé ?`,
  'ws.transport-uws.echec-ecoute-socket': ({ path }: MsgVars) => `[mjs-ws/transport-uws] échec du bind sur la socket unix ${path} — répertoire absent, droits refusés, ou un process y écoute déjà ?`,
  'ws.transport-uws.socket-trop-longue': ({ path, bytes, max }: MsgVars) => `[mjs-ws/transport-uws] chemin de socket unix trop long (${bytes} octets, ${max} au plus) : ${path}`,

  // — transport-ws.ts
  'ws.watchdog.arme': ({ periode, fenetre }: MsgVars) => `[mjs-ws/watchdog] chien de garde systemd armé — battement toutes les ${periode} ms (fenêtre ${fenetre} ms)`,
  'ws.watchdog.notifier-introuvable': ({ notifier }: MsgVars) => `[mjs-ws/watchdog] ${notifier} est introuvable alors que systemd arme un chien de garde (WATCHDOG_USEC) : sans lui le service serait abattu toutes les WatchdogSec secondes, en silence — arrêt immédiat`,
  'ws.watchdog.notifier-refuse': ({ notifier, code }: MsgVars) => `[mjs-ws/watchdog] ${notifier} a rendu ${code} au premier battement — vérifie NotifyAccess=all dans l'unité systemd (le défaut, main, REFUSE le message d'un enfant et fait tuer un service sain) — arrêt immédiat`,

  'ws.transport-ws.paquet-requis': 'le paquet "ws" est requis pour mjs ws — npm install ws',

  // — transport.ts
  'ws.transport.send-non-ouvert': '[MemoryTransport] send() sur un WebSocket non ouvert',
  'ws.transport.arrete': 'transport arrêté',
  'ws.transport.connect-avant-start': '[MemoryTransport] connect() avant start()',

  // ═══ MJS-WS — dashboard d'état (src/mjs-ws/stats-page.ts, hors inventaire, cf. risques §6) ═══

  'ws.stats.titre-page': 'µWS — état du serveur',
  'ws.stats.pied-de-page': 'auto-rafraîchi toutes les 2 s — dernière mise à jour',
  'ws.stats.titre-connexions': 'Connexions',
  'ws.stats.titre-salons': 'Salons',
  'ws.stats.titre-flux': 'Flux',
  'ws.stats.titre-messages': 'Messages',
  'ws.stats.titre-garde': 'Garde (kicks)',
  'ws.stats.titre-pont': 'Pont',
  'ws.stats.titre-adaptateur': 'Adaptateur',
  'ws.stats.titre-sessions': 'Sessions',
  'ws.stats.titre-latences': 'Latences ping (ms)',
  'ws.stats.titre-memoire': 'Mémoire / uptime',
  'ws.stats.champ-actives': 'actives',
  'ws.stats.champ-parquees': 'parquées',
  'ws.stats.champ-accueillies': 'accueillies',
  'ws.stats.champ-refusees': 'refusées',
  'ws.stats.champ-refusees-plafond': 'refusées (plafond)',
  'ws.stats.champ-refusees-origine': 'refusées (origine)',
  'ws.stats.champ-fermees': 'fermées',
  'ws.stats.champ-nombre': 'nombre',
  'ws.stats.champ-membres-total': 'membres au total',
  'ws.stats.champ-abonnes-presence': 'abonnés présence',
  'ws.stats.champ-deltas-emis': 'deltas émis',
  'ws.stats.champ-resyncs-rejeu': 'resyncs (rejeu)',
  'ws.stats.champ-resyncs-reset': 'resyncs (reset)',
  'ws.stats.champ-recus': 'reçus',
  'ws.stats.champ-envoyes': 'envoyés',
  'ws.stats.champ-tamponnes': 'tamponnés',
  'ws.stats.champ-rejoues': 'rejoués',
  'ws.stats.champ-rejetes': 'rejetés',
  'ws.stats.champ-binaire-recues': 'binaires reçues',
  'ws.stats.champ-binaire-ignorees': 'binaires ignorées',
  'ws.stats.champ-kicks-debit': 'débit',
  'ws.stats.champ-kicks-silence': 'silence',
  'ws.stats.champ-kicks-engorgement': 'engorgement',
  'ws.stats.champ-kicks-charge-utile': 'charge utile',
  'ws.stats.champ-expirations-jeton': 'jeton expiré',
  'ws.stats.champ-rate-limited': 'limitées (429)',
  'ws.stats.champ-webhooks-envoyes': 'webhooks envoyés',
  'ws.stats.champ-webhooks-echoues': 'webhooks échoués',
  'ws.stats.champ-webhooks-abandonnes': 'webhooks abandonnés',
  'ws.stats.champ-publies': 'publiés',
  'ws.stats.champ-ignores-origin': 'ignorés (origin)',
  'ws.stats.champ-reordonnances': 'réordonnancés',
  'ws.stats.champ-reconnexions': 'reconnexions',
  'ws.stats.champ-emises': 'émises',
  'ws.stats.champ-reprises': 'reprises',
  'ws.stats.champ-expirees': 'expirées',
  'ws.stats.champ-debordees': 'débordées',
  'ws.stats.champ-echantillon': 'échantillon',
  'ws.stats.sub-process': 'process ',
  'ws.stats.sub-depuis': ' — actif depuis ',
  'ws.stats.sub-s': ' s',

  // commentaire HTML `<!-- … -->` jamais refermé : même famille que
  // parser.chaine-non-fermee/delimiteur-non-ferme (bannière « fin de fichier atteinte »).
  'parser.commentaire-non-ferme': ({ ligne }: MsgVars) => `

🚨 [COMMENTAIRE NON FERMÉ] \`<!--\` ouvert ligne ${ligne} n'a pas de \`-->\` correspondant.
   Fin de fichier atteinte : tout le HTML suivant a été avalé par le commentaire.
👉 Fermez le commentaire par \`-->\`.

`,
  // balise HTML jamais refermée jusqu'à la fin du fichier : même famille que
  // parser.balise-fermante-orpheline (symétrique, fermante SANS ouvrante).
  'parser.balise-non-fermee': ({ nom, ligne }: MsgVars) => `

🚨 [BALISE NON FERMÉE] \`<${nom}>\` ouverte ligne ${ligne} n'a pas de \`</${nom}>\` correspondante.
   Fin de fichier atteinte avant la fermeture.
👉 Ajoutez la balise fermante manquante, ou rendez la balise auto-fermante (\`<${nom} />\`) si elle n'a pas de contenu.

`,
  // filet GÉNÉRIQUE côté parseur : un nom
  // d'attribut vu deux fois sur la même balise, quelle que soit sa forme d'origine (directive
  // `@…=` déjà réécrite, attribut natif dupliqué, forme non couverte par la détection textuelle
  // de preprocessHtml qui ne voit que SES marqueurs reconnus). `@class{cond}`/`@style.prop{cond}`
  // incluent la condition dans le nom : deux conditions différentes ne collisionnent jamais.
  'parser.attribut-duplique': ({ attribut, tag, ligne }: MsgVars) => `

🚨 [ATTRIBUT DUPLIQUÉ] \`${attribut}\` apparaît deux fois sur <${tag}> (ligne ${ligne}).
   Un attribut HTML dupliqué ne garde que la PREMIÈRE valeur au DOM ; le second est silencieusement ignoré.
👉 Retire l'un des deux.

`,
  // @import $X (dollar simple, sans µ$) : un nom importé ne porte
  // jamais `$` seul, un singleton s'importe et se consomme UNIQUEMENT par `µ$$X` (docs/14-stores.md
  // § « Un seul symbole, un seul rôle ») — `@import $counter` compilait en silence.
  'transpiler.import-nom-dollar': ({ nom, base }: MsgVars) => `[ModularJS] @import ${nom} : un nom importé ne porte jamais « $ » — un singleton s'importe et se consomme par « µ$$${base} » (déclaration « export µ$$${base} = … » dans le module).`,
  // @no-ujs/@noUJS : forme NUE seulement, même politique que @permanent
  // (transpiler/index.ts) — l'appariement UJS ne porte aucune valeur, une valeur qui traîne serait
  // un bogue muet (attribut mjs-no-ujs='valeur' posé au lieu du marqueur nu attendu).
  'transpiler.no-ujs-valeur-refusee': ({ valeur }: MsgVars) => `[ModularJS] @no-ujs=${valeur} : cette directive ne prend jamais de valeur — elle désactive l'interception UJS pour l'élément entier, rien à préciser ; écris @no-ujs seul (ou @noUJS).`,
  // préfixe le nom du module devant TOUT message d'erreur du pipeline
  // transpile()/transpileFile() qui ne le porte pas déjà (~25 erreurs de preprocessHtml sans
  // fichier ni ligne, erreur de l'analyseur sans fichier) — sur un build multi-fichiers, savoir
  // LEQUEL des composants a échoué.
  'transpiler.erreur-dans-module': ({ moduleName, message }: MsgVars) => `'${moduleName}' : ${message}`,
  // même directive posée deux fois sur la MÊME balise (ex. @confirm=…
  // @confirm=…) : seule la première valeur survit au DOM (attribut HTML dupliqué), la seconde,
  // écrite par le dev, est silencieusement ignorée — refusé au build plutôt que laissé muet.
  'transpiler.directive-dupliquee': ({ directive, balise }: MsgVars) => `[ModularJS] ${directive} est posé deux fois sur <${balise}> — un attribut HTML dupliqué ne garde que la PREMIÈRE valeur au DOM ; retire l'un des deux.`,
  // deux hooks du même nom (µmount/µawake/µsleep/µdestroy/µfailed/µurlChange)
  // dans le même <script> : `_mjs_hooks[name]` est un slot UNIQUE au runtime, le second écrase
  // le premier SANS le moindre signal — refusé ICI, à la compilation.
  'transpiler.hook-duplique': ({ moduleName, hook }: MsgVars) => `[ModularJS] '${moduleName}.mjs' déclare µ${hook} deux fois — le second écrase le premier au runtime (un seul emplacement par hook), le premier ne s'exécute jamais ; regroupe les deux blocs en un seul.`,
  // cible d'@import contenant un guillemet/antislash/retour à la ligne/NUL : cette
  // valeur s'insère telle quelle dans la chaîne double-quote générée (fromClause) — jamais admise.
  'transpiler.import-cible-invalide': ({ cible }: MsgVars) => `[ModularJS] @import : cible '${cible}' invalide — elle ne peut être vide ni contenir un guillemet, un antislash, un accent grave, une interpolation #{…}/\${…} ou un retour à la ligne (forme attendue : @import nom 'chemin').`,
  // entry .civet BRUTE (compileRawCivetFile) : une directive MJS (@import, @css…)
  // en colonne 0 y compile en Civet ordinaire sans jamais faire ce qu'elle promet (erreur muette
  // au runtime seulement) — refusée avant compilation, renvoie vers .server.mjs.
  'cli.entry-civet-brut-directive': ({ entryPath, directive }: MsgVars) => `'${entryPath}' : la directive ${directive} n'existe pas dans une entry '.civet' brute (aucune pré-passe MJS) — renomme le fichier en '.server.mjs' pour utiliser ${directive}.`,
  // $__proto__/$constructor/$prototype : nom d'état réservé, rejeté AVANT
  // l'analyse (sinon expandOneDep plante en silence sur le prototype JS, TypeError non orienté).
  'analyzer.nom-etat-reserve': ({ name }: MsgVars) => `[ModularJS] $${name} : nom d'état réservé — « ${name} » appartient au prototype JavaScript, choisis un autre nom.`,
  // repli Civet du suivi de dépendances (getEffectVars) épuisé :
  // dernier avertissement avant de classer l'effet « mountOnly » à tort (vue jamais remise à jour).
  'generator.deps-non-analysables': ({ expr, moduleHint }: MsgVars) => `[ModularJS] ⚠️  dépendances non analysables pour « ${expr} »${moduleHint} — la vue ne se remettra pas à jour.`,
  // @__proto__/@constructor/@prototype : nom de MÉTHODE
  // réservé, rejeté AVANT l'analyse (sinon methodReads['__proto__'] retombe sur
  // Object.prototype, TypeError « reads is not iterable » non orienté).
  'analyzer.nom-methode-reserve': ({ name }: MsgVars) => `[ModularJS] @${name} : nom de méthode réservé — « ${name} » appartient au prototype JavaScript, choisis un autre nom.`,
  // <p> refermé d'office par le navigateur devant un élément de flow
  // content (div, section, table…) : le chemin calculé au build visait un enfant
  // qui n'existe jamais dans l'arbre réel (CRASH au montage). Refusé à la compilation.
  'generator.p-contenu-interdit': ({ tag, ligne }: MsgVars) => `[ModularJS] <p> (ligne ${ligne}) : <${tag}> ne peut pas être un enfant d'un <p> — le navigateur referme le <p> tout seul avant d'ouvrir <${tag}>, et le chemin calculé au build viserait alors un enfant qui n'existe plus. Referme le <p> avant <${tag}>, ou utilise un élément inline à la place (span, a, em…).`,
  // {await} imbriqué dans {for} dégradait en silence en un placeholder
  // visible des utilisateurs finaux, sans la moindre erreur de compilation.
  'generator.await-imbrique-interdit': ({ ligne }: MsgVars) => `[ModularJS] {await} (ligne ${ligne}) : un {await} imbriqué dans un {for} n'est pas supporté — sors-le du {for} (un {await} imbriqué dans un {if} à la racine reste permis).`,
  // guillemet d'attribut resté ouvert jusqu'à la fin du gabarit : le tag
  // fautif ET tout ce qui le suit disparaissaient du fragment généré, sans erreur.
  'generator.attribut-guillemet-non-ferme': ({ tag }: MsgVars) => `[ModularJS] <${tag}> : un guillemet resté ouvert dans un attribut n'est jamais refermé avant la fin du gabarit — vérifie les guillemets/apostrophes de ses attributs.`,
  'transpiler.derived-await-interdit': ({ varName }: MsgVars) => `[ModularJS] « µderived $${varName} = … » : un dérivé µderived est synchrone — pour une valeur asynchrone, écris un µeffect qui attend puis écrit une variable d'état.`,

} satisfies Record<string, MsgEntry>
