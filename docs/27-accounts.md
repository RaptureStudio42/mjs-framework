# 27 · Comptes & identités — comptes persistés, prêts à l'emploi (au-dessus de MJS-WS)

> **Module optionnel.** Le paquet Comptes gère création de compte, connexion et identité **stable** — par-dessus [23 · MJS-WS](23-mjs-ws.md), sans le modifier, via le mécanisme des paquets activables (`app.use`). Tant que tu n'appelles pas `app.use(accountsPackage(...))`, son coût est **nul**.

```ts
// serveur — TypeScript classique (accountsPackage est une simple composition app.use(), comme
// chatPackage — pas de dialecte Civet dédié ici)
import { mjsWs, accountsPackage, accountsAuth } from 'modularjs-framework/ws'

const SECRET = process.env.MJS_COMPTES_SECRET!
const app = mjsWs({ auth: accountsAuth(SECRET) })   // PAS jwtAuth(SECRET) nu — cf. §5
app.use(accountsPackage({ secret: SECRET }))
await app.listen()
```

Côté client, `sock.account` suffit — création, connexion, élévation de la session et persistance locale du jeton sont **déjà gérées** :

```civet
account = sock.account

creer = ->
  try
    await account.create($name, $secret)
  catch
    // account.error reflète déjà le refus — rien de plus à faire ici
```
```html
{if account.loggedIn}
  <p>Bonjour {account.name}</p>
  <button @click={account.logout()}>Se déconnecter</button>
{else}
  <input value=!{$name} placeholder="pseudo">
  <input value=!{$secret} type="password">
  <button @click={creer()}>Créer un compte</button>
  {if account.error}<p class="erreur">{account.error}</p>{end}
{end}
```

---

## Sommaire

1. [Philosophie](#philosophie)
2. [Démarrer](#demarrer)
3. [Options — `accountsPackage(opts)`](#options)
4. [Le client — `sock.account`](#le-client)
5. [Élévation invité→compte — par **reconnexion**](#elevation)
6. [Sécurité](#securite)
7. [Rôles — `opts.roles` + `hasRole`](#roles)
8. [Limites v1 — honnêtement](#limites)
9. [Annexe — erreurs `compte-*` et protocole](#annexe)

---

<a id="philosophie"></a>
## 1. Philosophie

Une appli MJS-WS a tôt ou tard besoin d'une identité qui survit à une reconnexion, à un changement d'appareil — un **compte**. Le paquet Comptes la fournit **une fois**, avec le minimum honnête pour une v1 : pseudo + secret, hachage scrypt, anti-force-brute, jetons JWT qui réutilisent [23 · MJS-WS §7](23-mjs-ws.md#jetons) (`token.ts`) — sans base de données obligatoire (adaptateur mémoire par défaut, adaptateur fichier réel fourni, n'importe quel autre au choix de l'appli). Une appli MJS **autonome, sans back Rails**, peut ainsi laisser ses visiteurs créer un compte, se connecter, rester connectés — et transmettre cette identité aux **autres** paquets (chat, jeu, lobby) via `client.identity`, la **même** monnaie que tout le reste de MJS-WS.

---

<a id="demarrer"></a>
## 2. Démarrer

```ts
// comptes.server.ts
import { mjsWs, accountsPackage, accountsAuth } from 'modularjs-framework/ws'

const SECRET = process.env.MJS_COMPTES_SECRET!

const app = mjsWs({
  auth: accountsAuth(SECRET),
})

app.use(accountsPackage({ secret: SECRET }))

await app.listen()
```

```civet
// composant .mjs — dialecte Civet des composants
account = sock.account

creer = ->
  try { await account.create($name, $secret) } catch {}

connecter = ->
  try { await account.login($name, $secret) } catch {}
```
```html
{if account.loggedIn}
  <p><strong>{account.name}</strong> — rôles : {account.roles.join(', ') or 'aucun'}</p>
  <button @click={account.logout()}>Se déconnecter</button>
{else}
  <input value=!{$name} placeholder="pseudo (3-24, lettres/chiffres/_/-)">
  <input value=!{$secret} type="password" placeholder="secret (8 caractères min.)">
  <button @click={creer()}>Créer un compte</button>
  <button @click={connecter()}>Se connecter</button>
  {if account.error}<p class="erreur">{account.error}</p>{end}
{end}
```

C'est tout ce qu'il faut — création, connexion, élévation de la session en cours, persistance locale du jeton et reconnexion automatique au retour sont **déjà gérées**. Le protocole `account:*` qui transporte tout ça reste **invisible** (cf. [§9](#annexe) pour l'inventaire bas niveau).

> ⚠️ **`auth: accountsAuth(SECRET)`, jamais `auth: jwtAuth(SECRET)` nu.** Cf. [§5](#elevation) — `jwtAuth` seul refuserait la connexion **anonyme** elle-même (aucun jeton au premier hello), avant même de pouvoir appeler `account:create`.

---

<a id="options"></a>
## 3. Options — `accountsPackage(opts)`

| Clé | Défaut | Effet |
|---|---|---|
| `secret` | — **requise** | Secret HMAC des jetons de compte (`signToken`/`token.ts`). **Doit** être le **même** secret que celui donné à `accountsAuth(secret)`/`mjsWs({ auth })` — cf. [§5](#elevation). Absente/vide → `throw` immédiat à la construction, jamais un démarrage à moitié fait. |
| `persist` | adaptateur **mémoire** | Stockage des comptes — cf. [§6](#securite) pour le contrat, [§8](#limites) pour l'avertissement au boot. `FileAccountsPersistAdapter` fourni pour un stockage disque réel ; n'importe quel adaptateur maison satisfaisant `{ load, save, remove, flush? }` convient. |
| `ttl` | `604800` (7 jours) | Durée de vie du jeton émis, en **secondes**. |
| `roles` | absent | `(account) => string[] \| Promise<string[]>` — enrichit/recalcule les rôles portés par le jeton à **chaque** émission (`account:create` ET `account:login`), à partir de l'enregistrement **persisté** (`meta` inclus). Absent = `account.roles` tel que persisté. |
| `bruteForce` | `{ capacity: 5, windowMs: 60000 }` | Anti-force-brute (`account:login` seulement, cf. [§6](#securite)) — seau d'échecs **par IP et par nom de compte**. |
| `createPerIp` | `{ capacity: 3, windowMs: 60000 }` | Anti-DoS création (`account:create` seulement, **par** IP, cf. [§6](#securite)) — `account:create` est accessible en hello **anonyme** et déclenche le même scrypt coûteux que `account:login`, sans limite jusque-là. |
| `maxAccounts` | absent (illimité) | Plafond **optionnel** du nombre total de comptes — au-delà, `account:create` refuse avec `account-limit-reached`. |
| `onLog` | console, préfixe `[mjs-ws:accounts]` | Callback de log — utilisé pour l'avertissement « adaptateur mémoire » (§8) et les échecs de `persist.load()`/adaptateur fichier. |

---

<a id="le-client"></a>
## 4. Le client — `sock.account`

Posé par-dessus `µ.socket` (module runtime `comptes`, cf. [§8](#limites) pour la sélection du runtime) — **propriété**, pas un appel : une seule identité de compte par connexion, contrairement à `sock.chat(nom)`/`sock.game()`.

```civet
account = sock.account   # store réactif plat, SINGLETON par socket
```

| Clé | Type | Sens |
|---|---|---|
| `loggedIn` | booléen | `true` une fois l'élévation réussie (cf. [§5](#elevation)). |
| `name` | chaîne \| `null` | Décodé du jeton — `null` tant qu'aucune élévation n'a réussi. |
| `roles` | tableau de chaînes | Décodé du jeton — cf. `opts.roles` ([§3](#options)) et `hasRole` ([§7](#roles)). |
| `token` | chaîne \| `null` | Le jeton **courant**, en lecture — intégration back maison (ex. l'attacher à un appel `fetch()` applicatif). |
| `error` | chaîne \| `null` | Dernier refus — un code `compte-*` (cf. [§9](#annexe)) OU un refus d'élévation, **toujours** normalisé en chaîne affichable. |
| `create(pseudo, secret)` | fonction → Promise | Crée un compte + élève la session en cours (cf. [§5](#elevation)). |
| `login(pseudo, secret)` | fonction → Promise | Connecte un compte existant + élève la session en cours. |
| `logout()` | fonction → Promise | Ferme la session compte (cf. [§5](#elevation)) et purge le jeton local. |

### Persistance locale du jeton

`localStorage`, clé configurable (`µ.socket(url, { account: { key: 'my-token' } })`, défaut `'mjs-token'`), accès **toujours** gardé (`typeof localStorage !== 'undefined'` — absent en SSR/certains environnements de test, jamais un crash). Au premier accès à `sock.account` — avant même un `sock.connect()` explicite de l'appli — un jeton stocké déclenche **immédiatement** l'élévation : **reconnexion connectée d'office**, sans jamais rappeler `login()`. Un jeton mort (expiré, invalide, révoqué) est purgé automatiquement — jamais de nouvelle tentative sur un jeton qui ne marchera plus.

---

<a id="elevation"></a>
## 5. Élévation invité→compte — par **reconnexion**

> Cette section documente une découverte faite EN **écrivant** ce module : l'intuition de départ — élever la session en cours via `sock.refresh(jeton)` ([23 · MJS-WS](23-mjs-ws.md)) — est en réalité **impossible**, pour une raison structurelle qui mérite d'être comprise avant de brancher ce paquet dans une appli qui ferait ses propres suppositions.

`µ:refresh`/`sock.refresh()` réinvoque la fonction `auth` de l'appli, mais **refuse tout changement d'identité** (`identityIdOf(nouvelle) !== identityIdOf(courante)` → refusé, invariant strict de `core.ts` : « une session ne change jamais d'identité en vol »). Passer d'anonyme (aucun `id`) à un compte (`id` généré à la création) **est** un tel changement — `sock.refresh(jeton)` renvoie donc **toujours** `refresh-denied` pour cet usage, quel que soit le jeton.

Un hello **frais** (une nouvelle connexion), en revanche, n'a **aucune** identité antérieure à comparer — c'est donc par là que passe l'élévation. `sock.account` orchestre ceci tout seul (`src/runtime/mjs_accounts.ts`) :

1. Le jeton reçu (`account:create`/`account:login`, ou relu du `localStorage` au boot) est posé comme `auth` du socket.
2. La connexion courante est fermée puis rouverte (`sock.close()` + `sock.connect()`) — **même** socket, salons/abonnements ré-abonnés automatiquement par le welcome suivant (cf. [20 · Temps réel](20-temps-reel.md)).
3. Ce hello, tout neuf, porte le jeton — `client.identity` devient celle du compte.

**Conséquences pratiques :**
- Une fois élevé, `sock.opts.auth` reste posé sur ce jeton : une reconnexion **future** (coupure réseau) le réutilise automatiquement, sans repasser par ce module. `logout()` restaure l'`auth` d'**origine** de l'appli (celui d'avant toute élévation) — une reconnexion après déconnexion explicite ne ressuscite donc pas le compte.
- L'élévation entraîne une **vraie** reconnexion (visible réseau) — pas juste un aller-retour logique. Salons/flux sont réabonnés automatiquement, mais un état purement **local** à l'ancienne connexion (aucun ici, mais à garder en tête pour toute extension future) ne survivrait pas.
- `accountsAuth(secret)` (exportée à côté de `accountsPackage`) est le wrapper qui rend tout ça possible côté **serveur** : un hello **sans** jeton → identité anonyme **autorisée** (`undefined`, comme avant toute auth) ; un hello (ou un `µ:refresh` pour un usage qui n'est **pas** l'élévation, ex. renouveler un jeton avant expiration EN **gardant** le même `id`) **avec** jeton → délégué à `jwtAuth(secret)`. `jwtAuth(secret)` NU refuserait l'anonyme (renvoie `false` pour tout hello sans jeton) — d'où l'avertissement du [§2](#demarrer).

---

<a id="securite"></a>
## 6. Sécurité

**Secrets.** Hachage `scrypt` de Node (`crypto.scrypt`, zéro dépendance — cf. [23 · MJS-WS §7](23-mjs-ws.md#jetons) pour `token.ts`, même ethos), sel aléatoire **par compte** (16 octets), comparaison à temps constant (`timingSafeEqual`). Le secret en clair, le sel et le hachage ne quittent **jamais** ce process — ni dans une trame réseau, ni dans un log, ni dans une erreur (vérifié par test).

**Anti-énumération.** `account:login` renvoie le **même** message (`account-denied`) que le pseudo existe ou non. Pour qu'un pseudo **inexistant** ne réponde pas plus **vite** (ce qui révélerait son absence par le temps de réponse malgré le message identique), un hachage **factice** de coût identique est calculé même quand le pseudo n'existe pas.

**Anti-force-brute.** Deux seaux à jetons (`account:login` uniquement) — un **par** IP, un **par pseudo** (casse-insensible) — défaut 5 échecs/minute chacun, **même** patron que le limiteur du pont universel (`bridge.ts::createBridgeRateLimiter`, [23 · MJS-WS](23-mjs-ws.md)), réimplémenté ici (paquet WS pur, sans dépendre du pont HTTP). Au-delà : `account-throttled`, avant tout calcul de hachage — **sauf** pour l'échec qui fait déborder le seau **pour la première fois**, qui a déjà payé son hachage avant d'être reclassé (`TokenBucket` n'expose aucun « peek », même limite assumée que `bridge.ts`) : seules les tentatives **suivantes** sont bloquées avant tout calcul.

**Anti-DoS création.** `account:create` est accessible en hello **anonyme** et déclenche le **même** scrypt coûteux que ci-dessus — il n'avait jusque-là **aucune** limite de débit (DoS CPU + croissance mémoire/disque non bornée depuis une seule IP). Un seau **séparé** (`opts.createPerIp`, **même** mécanisme `FailureBucket`/`TokenBucket`), clé = IP **seule** (le pseudo diffère à chaque tentative d'un attaquant qui en génère de nouveaux — une clé pseudo ne contiendrait rien) — défaut **conservateur**, 3 créations/minute/IP (plus strict que `bruteForce` : la création est une action rare, et scrypt coûte plus cher qu'une simple comparaison). Le seau est consulté **juste avant** le calcul scrypt, **après** les refus bon marché (format/unicité, sans hachage) — ceux-ci ne consomment pas le budget, seule une tentative qui atteindrait le hachage compte : exactement le chemin coûteux à protéger, sans pénaliser un client qui enchaîne des essais de format invalide. La tentative qui fait déborder le seau n'a donc payé **aucun** hachage. Clé de repli `'inconnue'` si l'IP n'est pas exposée par le transport — jamais un accès non limité. Au-delà : `account-throttled` (**même** code que l'anti-force-brute de `account:login` — un client ne distingue pas les deux causes).

**Expiration.** Le jeton porte une échéance (`ttl`, [§3](#options)) — un jeton expiré est refusé **dès le hello** (`µ:denied`), qu'il soit utilisé pour une connexion fraîche ou pour l'élévation (qui **est** une connexion fraîche, cf. [§5](#elevation)).

**Unicité du pseudo.** Comparaison **toujours** en minuscules — `Zora`/`zora`/`ZORA` sont le **même** compte. La casse **d'origine** est conservée pour l'affichage (le jeton porte le pseudo tel que créé, pas tel que tapé pour se connecter).

---

<a id="roles"></a>
## 7. Rôles — `opts.roles` + `hasRole`

```ts
app.use(accountsPackage({
  secret: SECRET,
  roles: (account) => account.meta.moderator ? ['moderator'] : [],
}))
```

`hasRole(identity, role)` (exportée à côté de `accountsPackage`) lit `identity.roles` (le duck-type posé par le jeton) — utilisable par les hooks des **autres** paquets, par exemple pour brancher la modération du chat sur les rôles du compte :

```ts
import { accountsPackage, hasRole } from 'modularjs-framework/ws'
import { chatPackage } from 'modularjs-framework/ws'

app.use(accountsPackage({ secret: SECRET, roles: (c) => c.meta.moderator ? ['moderator'] : [] }))
app.use(chatPackage({ moderators: (identity) => hasRole(identity, 'moderator') }))
```

`opts.roles` est réévalué à **chaque** émission de jeton (`create`/`login`), à partir de l'enregistrement **persisté** — un changement de rôle (ex. `account.meta.moderator` basculé par un outil admin séparé) n'est donc visible qu'à la **prochaine** émission d'un jeton pour ce compte (prochaine connexion), jamais poussé en live à une session déjà élevée — cf. [§8](#limites).

---

<a id="limites"></a>
## 8. Limites v1 — honnêtement

- **Pas de courriel, pas de récupération de secret oublié, pas de 2FA.** Assumé pour v1 — un secret oublié = un compte perdu, aucun mécanisme de contournement n'existe.
- **Aucune révocation de jeton.** Les jetons sont des JWT **sans état** (cf. `token.ts`) — il n'existe pas de liste de comptes/jetons révoqués. `account:logout` ferme la connexion authentifiée **courante** (l'identité élevée ne survit pas à la fermeture) et le client purge son jeton local, mais une **autre** copie du même jeton — un autre onglet, un autre appareil — reste valide jusqu'à sa propre expiration naturelle.
- **Anti-force-brute/anti-DoS en mémoire process, non répliqué.** Comme la modération du chat ([26 · Chat §7](26-chat.md#limites)) — sur un déploiement multi-processus, les seaux (échecs ET création) ne sont pas partagés entre processus ; un attaquant distribué sur plusieurs processus (répartition de charge) reste sous le radar de **chaque** seau individuellement.
- **Pas de suppression de compte au protocole.** `MjsWsAccountsPersistAdapter.remove()` existe (symétrie du contrat, outillage admin direct sur l'adaptateur) mais aucune trame `compte:*` ne l'appelle en v1.
- **Rôles recalculés à l'émission, jamais poussés en live.** Cf. [§7](#roles) — un changement de rôle n'est visible qu'à la prochaine connexion/reconnexion de ce compte.
- **L'élévation est une vraie reconnexion.** Cf. [§5](#elevation) — visible réseau, pas un simple aller-retour logique ; salons/flux sont réabonnés automatiquement, mais l'opération a un coût (un hello complet) plus élevé qu'un `sock.refresh()` simple.
- **Pas de page de démonstration dédiée** sur le site vitrine — laissé à une itération ultérieure.
- **`sock.account` n'est pas auto-sélectionné.** Comme `sock.chat`/`sock.game`, il exige le module runtime `comptes` (cf. [§9](#annexe)) — absent de la sélection `runtime`, `sock.account` reste indéfini (avertissement du bundler à la construction, jamais un crash silencieux).

---

<a id="annexe"></a>
## 8bis. Migrer un dossier de comptes écrit par l'ancienne version

Le paquet s'appelait `comptes` et ses champs stockés portaient des noms français. Quatre clés de
l'enregistrement persisté ont changé — `id`, `hash`, `roles` et `meta`, eux, sont **inchangés** :
les secrets restent vérifiables tels quels, **personne n'a à se reconnecter**.

| Avant | Maintenant |
|---|---|
| `pseudo` | `name` |
| `sel` | `salt` |
| `cree` | `createdAt` |
| `vu` | `seenAt` |

Un script fait la traduction sur place, un fichier à la fois :

```bash
node scripts/migrate-accounts-fr-to-en.mjs ./data/comptes --dry-run   # montre, n'écrit rien
node scripts/migrate-accounts-fr-to-en.mjs ./data/comptes             # migre
```

Il est **idempotent** (un enregistrement déjà migré est laissé tel quel) et écrit **atomiquement**
(fichier temporaire + `rename`, même geste que l'adaptateur lui-même) — une coupure en cours de
route ne laisse jamais un compte à moitié écrit. Un adaptateur de persistance maison (base de
données) applique la même correspondance à sa façon.

---

## 9. Annexe — erreurs `account-*` et protocole

### Erreurs

| Code (`µ:error`/rejet de Promise) | Déclencheur |
|---|---|
| `account-name-invalid` | Pseudo absent/non-chaîne, ou hors du format `[a-z0-9_-]{3,24}` (insensible à la casse). |
| `account-secret-short` | Secret absent/non-chaîne, ou strictement inférieur à 8 caractères. |
| `account-name-taken` | Pseudo déjà utilisé (comparaison casse-insensible). |
| `account-denied` | Pseudo inexistant OU secret incorrect — message **identique** dans les deux cas (anti-énumération, cf. [§6](#securite)). |
| `account-throttled` | `account:login` : seau d'échecs (IP ou pseudo) épuisé. `account:create` : seau anti-DoS **par** IP épuisé. **Même** code dans les deux cas — cf. [§6](#securite). |
| `account-limit-reached` | `account:create` — `opts.maxAccounts` atteint (absent par défaut, illimité). |
| `account-persist-failed` | `account:create` — l'adaptateur de persistance (`persist.save()`) a levé une exception : sauvegarde échouée, pseudo libéré (jamais inscrit en mémoire) ; le détail traduit part au journal serveur (`onLog`) seulement, jamais au client. |

### Le protocole `account:*` — préfixe de convention, pas une réservation

Comme `chat:` ([26 · Chat](26-chat.md#annexe)), `account:` n'est **pas réservé** — une simple convention de nommage.

| Trame | Sens | Charge `p` |
|---|---|---|
| `account:create` | CLIENT→SERVEUR (requête, `µ:ack`) | `{ name, secret }` → `{ ok, token }` |
| `account:login` | CLIENT→SERVEUR (requête, `µ:ack`) | `{ name, secret }` → `{ ok, token }` |
| `account:logout` | CLIENT→SERVEUR (requête, `µ:ack`) | `{}` → `{ ok: true }` |

Aucune de ces trames ne modifie `client.identity` directement (impossible depuis un paquet, cf. [§5](#elevation)) — elles ne font que **minter** un jeton ; l'élévation réelle passe par la reconnexion contrôlée décrite au [§5](#elevation).

---

*Voir aussi : [20 · Temps réel](20-temps-reel.md) pour le client `µsocket` de base, [23 · MJS-WS](23-mjs-ws.md) pour le protocole `µ:` et les jetons JWT (`token.ts`), [26 · Chat](26-chat.md) pour l'autre paquet applicatif de référence (branchement `hasRole`/`chat.moderators`).*
