# 25 · Protocole MJS-WS — spécification de référence

> Référence **bas niveau** du protocole `µ:` (et de son extension `µgame:*`) porté par [23 · MJS-WS](23-mjs-ws.md) — assez précise pour écrire un client MJS-WS dans un **autre** langage, dans l'esprit du protocole DDP de Meteor (« ce que le fil transporte, octet par octet »). Si tu écris une appli MJS ordinaire, tu n'as **pas** besoin de cette page : le client `µsocket` ([20 · Temps réel](20-temps-reel.md)) et le serveur `mjsWs` ([23 · MJS-WS](23-mjs-ws.md)) parlent déjà ce protocole l'un à l'autre. Cette page rassemble et précise ce qui est autrement éparpillé entre [20 · Temps réel §7](20-temps-reel.md), [23 · MJS-WS](23-mjs-ws.md) et [24 · MJS-Server](24-mjs-server.md) — vérifié contre le code source (`src/mjs-ws/`, `src/mjs-server/`, `src/schema/core.ts`), jamais contre les docs elles-mêmes.

## Sommaire

0. [Version et conventions](#conventions)
1. [Trames de contrôle `µ:`](#controle)
2. [Flux à deltas — `stream`](#flux-spec)
3. [Trames de jeu `µgame:*`](#jeu-spec)
4. [Format binaire µschema](#binaire-spec)
5. [Sécurité du pont HTTP](#securite-spec)

---

<a id="conventions"></a>
## 0. Version et conventions

**Version du protocole.** Un seul champ de version existe à ce jour : `protocol` dans `µ:hello` (§1.1), qui doit valoir **exactement** le nombre `1` — c'est la **seule** version actuellement définie par `mjsWs`. Toute autre valeur (y compris absente, ou la chaîne `"1"`) est refusée (`µ:denied`) avant même de regarder le reste du hello. Il n'existe pas, séparément, de version de « protocole applicatif » (pub/sub, requêtes) — seule la charge µschema (§4) porte sa **propre** version (hash du registre de schémas, orthogonal à `protocol`).

**Enveloppe.** Toute trame **texte** (JSON) suit la même enveloppe minimale :

```
{ "t": "<type>", "p": <charge>, "id"?: <valeur> }
```

- `t` (`string`, obligatoire) — le **type** de la trame. Un `t` qui commence par `µ:` est une trame de **contrôle** réservée (§1) — en émettre un qui ne fait pas partie de la liste exhaustive du §1.1 est une erreur protocolaire (`µ:error`, cf. §1.1). Un `t` **sans** ce préfixe est un type **applicatif** (pub/sub §1.1 dernière ligne, ou delta de flux §2, ou trame de jeu `µgame:*` §3 — ce dernier préfixe est réservé par [24 · MJS-Server](24-mjs-server.md#philosophie), pas par `mjsWs` lui-même).
- `p` — la charge, structure propre à chaque `t` (détaillée §1/§2/§3). Absente ou non-objet selon les cas ; toujours présente en pratique côté trames connues.
- `id` (`string | number`, optionnel) — porté par une trame de type **requête** (§1.1 dernière ligne) et par son `µ:ack` de réponse (§1.2) ; **seule** exception parmi les trames de contrôle, `µ:refresh` (§1.1) honore aussi un `id` optionnel de la même façon. Valeur choisie par l'**émetteur** (la référence `mjs_socket.ts` utilise un compteur local croissant, mais **rien** dans le protocole n'impose ce choix) — le serveur ne lui donne **aucun** sens propre, il la restitue **telle quelle** dans le `µ:ack` correspondant. Un `id` n'a de sens que par rapport à l'**émetteur** qui l'a choisi ; deux clients peuvent réutiliser les mêmes valeurs sans collision (portée par connexion). Absent sur toutes les autres trames — y compris `µ:join`/`µ:leave`/`µ:sub-stream`/etc., qui ne déclenchent **jamais** de `µ:ack` même si un `id` leur était ajouté.

**Encodage.** Par défaut, toutes les trames sont du JSON UTF-8 envoyé en trame WebSocket **texte** (`JSON.stringify`/`JSON.parse`, personnalisables via `opts.parse`/`opts.serialize` — cf. [23 §1](23-mjs-ws.md#options), mais alors les **deux** côtés doivent s'accorder). Les trames de **contrôle** `µ:` restent **toujours** JSON, quel que soit le codec (§4) — le hello ne peut pas dépendre d'un schéma pas encore synchronisé. Seuls les messages **applicatifs** pub/sub (jamais les requêtes, jamais les deltas de flux, jamais `µgame:*`) peuvent voyager en trame WebSocket **binaire** à la place, si le `t` a un schéma déclaré ET que `ws.codec ≠ 'json'` — cf. §4 pour l'enveloppe binaire complète.

> ⚠️ **Pourquoi `µgame:*` est exclu — et où l'exclusion est tenue.** Elle ne tient **pas** à l'enveloppe : le choke point d'encodage (`sendRaw`) n'écarte que les types de **contrôle** `µ:` et les deltas de flux (repérés par leur `seq` de premier niveau, que les trames de jeu portent dans `p`). C'est une **garde explicite** de MJS-Server (§3) qui refuse le préfixe : `app.schema('µgame:…', …)` et une clé `µgame:` dans `opts.schemas` lèvent au démarrage. Motif : la charge d'une trame de jeu porte sa vue dans `view` (ou `delta`) — un **objet**, la seule forme que µschema v1 ne sait pas décrire (scalaires, `list()`, `bits()` — §4). Or un champ d'un type inattendu s'encode en valeur **zéro** sans lever : sans la garde, la trame partirait bien en binaire et l'état du jeu arriverait **vide**, en silence. Pour envoyer de l'état de jeu en binaire, il faut donc un type applicatif **à toi** (préfixe libre) dont la charge est **plate**, envoyé par `app.send` à côté de `µgame:state`.

**Transport.** Le protocole ci-dessous est indépendant du transport WebSocket concret — `mjsWs` l'expose au-dessus de `ws`, `uWebSockets.js`, ou tout transport maison implémentant `MjsWsTransport` (cf. [23 §12](23-mjs-ws.md#transport-facade)). Tout ce qui suit ne suppose rien de plus qu'une connexion full-duplex qui délivre des messages **texte** ou **binaires** dans l'ordre d'émission.

---

<a id="controle"></a>
## 1. Trames de contrôle `µ:`

Le namespace `µ:` est **réservé** au protocole lui-même — dix-sept trames au total, exhaustif. Un type qui commence par `µ:` et n'apparaît **pas** dans les deux tableaux ci-dessous n'existe pas : l'émettre déclenche `µ:error { message: "type inconnu '<t>'" }` côté receveur (jamais un routage silencieux vers de l'applicatif). Un serveur ou un client tiers ne doit donc **jamais** inventer un type `µ:xxx` applicatif — c'est le rôle des types **sans** préfixe (pub/sub, requêtes) ou du préfixe `µgame:` (§3, réservé séparément par MJS-Server).

<a id="controle-c2s"></a>
### 1.1 Client → Serveur

#### `µ:hello` — handshake d'ouverture

Premier message **obligatoire** de toute connexion — tout autre `t` reçu avant lui entraîne un refus immédiat (`µ:denied`, puis fermeture WebSocket code **4001**). Un `µ:hello` reçu une **seconde** fois sur une connexion déjà authentifiée est refusé (`µ:error { message: 'hello déjà reçu' }`, connexion inchangée) — pour rafraîchir une identité en vol, cf. `µ:refresh` plus bas.

| Champ | Type | Oblig. | Sens |
|---|---|---|---|
| `protocol` | `number` | oui | doit valoir **exactement** `1` (§0) — toute autre valeur, absence comprise → `µ:denied { message: 'protocole non supporté' }` |
| `auth` | `any` | non | opaque pour l'enveloppe elle-même — transmis **tel quel** à `opts.auth(hello, meta)` (fonction) ou au proxy de décisions (objet `{url,secret,...}`, [23 §7.11](23-mjs-ws.md#pont)) |
| `resub` | `string[]` | non | noms des types pub/sub actifs avant coupure — cf. note ⚠️ ci-dessous |
| `rooms` | `string[]` | non | noms des salons actifs avant coupure — cf. note ⚠️ ci-dessous |
| `session` | `{ id: string, key: string }` | non | reprise de session ([23 §8](23-mjs-ws.md#reprise-session)) — porte le `session` reçu au dernier `µ:welcome` |
| `schemaHash` | `string` | non | hash FNV-1a du registre µschema **client** (§4) — absent = client sans registre, aucun `µ:schema` ne sera jamais poussé en retour |

Déclenche, dans l'ordre : `opts.auth` (ou le proxy) → si `session` est fourni ET l'auth accueillie, tentative de reprise ([23 §8](23-mjs-ws.md#reprise-session)) qui court-circuite le reste sur succès → sinon `opts.welcome` → `µ:welcome` (§1.2, toujours envoyé sauf coupure en cours de route) → `µ:schema` (§1.2) si `schemaHash` diverge du registre serveur.

> ⚠️ **`resub`/`rooms` sont informatifs — le serveur `mjsWs` actuel ne les exploite pas.** La resynchronisation réelle passe par les messages **dédiés** que le client renvoie lui-même, explicitement, juste après avoir reçu `µ:welcome` : `µ:sub-stream` (ou `µ:resync` si ce flux avait déjà une séquence en cours, cf. §2) par flux repris, `µ:join` par salon, `µ:sub-presence` pour la présence. Un client tiers peut donc omettre `resub`/`rooms` sans rien perdre côté `mjsWs` — ils documentent une **intention** (utile à un futur serveur, ou à un serveur maison qui choisirait de les exploiter), pas un contrat consommé aujourd'hui.

#### `µ:ping` — battement

`p = { ts: any }` — valeur libre (généralement un timestamp numérique), renvoyée **verbatim** par le serveur dans le `µ:pong` correspondant (même en cas de valeur non numérique — jamais recalculée côté serveur). Émis par le client à intervalle régulier (option cliente `heartbeat`, défaut 15000 ms — indépendante de l'option **serveur** du même nom, qui ne fixe qu'un seuil de watchdog, cf. [23 §3](23-mjs-ws.md#protections)). Déclenche `µ:pong` + met à jour `client.latency` côté serveur (mesuré entre deux `µ:ping` reçus, pas via `ts`).

#### `µ:refresh` — rafraîchit le jeton en vol

`p = { auth: any }` — **même** forme que `hello.auth`. Re-vérifie via le **même** `opts.auth` que le hello, mais **refuse** tout changement de `identity.id` (une session ne change jamais d'identité en vol — casserait présence/salons). Réponse conditionnée à la présence d'un `id` sur la trame :

| Résultat | `id` fourni | `id` absent |
|---|---|---|
| Succès | `µ:ack { id, p: { exp: number \| null } }` — `exp` = nouvelle échéance en **secondes** epoch, ou `null` si le serveur ne suit aucune échéance | **rien** — succès silencieux |
| Échec (identité refusée, ou `identity.id` changé) | `µ:error { code: 'refresh-denied' }` **puis** `µ:ack { id, e: true, p: 'refresh-denied' }` | `µ:error { code: 'refresh-denied' }` **seul** |

Un `µ:refresh` raté ne ferme **jamais** la connexion — elle continue de vivre jusqu'à son échéance courante. Détail complet : [23 §7.9](23-mjs-ws.md#pont).

#### `µ:sub-stream` — abonnement à un flux

`p = { stream: string }` (obligatoire — une charge sans `stream` de type `string` est ignorée **silencieusement**, aucune trame en retour). Déclenche un abonnement + un delta `reset` immédiat (§2) — instantané complet même si le flux n'a jamais changé depuis l'abonnement précédent. Un flux jamais déclaré côté serveur (`app.stream(nom)` jamais appelé) répond honnêtement un `reset` **vide** (`seq: 0`) plutôt que de laisser le client sans réponse.

#### `µ:resync` — rattrapage après un trou

`p = { stream: string, from: number }` — `stream` obligatoire (même garde silencieuse que `µ:sub-stream`) ; `from` absent ou non-numérique-fini retombe sur `0` (rejeu complet si le journal le permet, sinon `reset`). Détail complet de la logique de rattrapage : §2.

#### `µ:sub-presence` — abonnement à la présence

`p = { room?: string }` — `room` absent (ou de type différent de `string`) = présence **globale** ; sinon présence du salon nommé (être **abonné** à la présence d'un salon ne rend pas **membre** de ce salon, cf. `µ:join` ci-dessous). Déclenche un `µ:presence { op: 'reset' }` immédiat (§1.2).

#### `µ:join` — rejoindre un salon

`p = { room: string }` (obligatoire, même garde silencieuse). Déclenche la garde `opts.rooms.join` (fonction ou proxy, [23 §7.11](23-mjs-ws.md#pont), async autorisée) puis, si acceptée : adhésion, delta de présence `join` (**seulement** si c'est la 1ʳᵉ connexion de cette identité dans ce salon — agrégation multi-onglets, [23 §4](23-mjs-ws.md#salons-presence)), et rejeu de l'historique du salon s'il en a un ([23 §4.1](23-mjs-ws.md#salons-presence)). Un `µ:join` en double (déjà membre) est un no-op silencieux. Un refus (`false`/`throw` de la garde) répond `µ:error { message }`, throttlé à 1/s. **Jamais de `µ:ack`**, même si la trame portait un `id`.

#### `µ:leave` — quitter un salon

`p = { room: string }` (obligatoire, même garde silencieuse). Déclenche le retrait + delta de présence `leave` (dernière connexion de cette identité dans ce salon). Client-initié : contrairement à un `kick` serveur, **aucun `µ:left` n'est renvoyé à l'émetteur** — il sait déjà qu'il part. `µ:leave` d'un non-membre est un no-op silencieux.

#### *(requête applicative)* — **sans** préfixe `µ:`

`{ t: <type>, p, id }` — `t` ne commence **pas** par `µ:` (sinon cf. la garde générale en tête de §1). `id` présent ET un `app.serve(t, ...)` existe → traité comme une **requête**, réponse `µ:ack` garantie (§1.2). `id` absent, OU `id` présent mais **seul** un `app.on(t, ...)` existe (pas de `serve`) → traité comme du pub/sub, tous les `on(t)` sont invoqués, **aucun `µ:ack`** n'est jamais émis dans ce cas (une requête envoyée vers un type sans `serve()` expire donc côté émetteur, cf. [24 §14](24-mjs-server.md#limites) pour un cas réel). `t` sans **aucun** `serve()` ni `on()` enregistré → `µ:error { message: "type inconnu '<t>'" }`.

<a id="controle-s2c"></a>
### 1.2 Serveur → Client

#### `µ:welcome` — fin du handshake

`p` = fusion de trois sources, dans cet ordre : le retour libre de `opts.welcome(client)` (`{}` si absent, ou si `welcome()` a levé — l'erreur est loguée, jamais fatale) ; **puis** `schemaHash` (`string`) SI le registre µschema serveur n'est pas vide (§4) ; **puis**, **seulement** si `opts.resume` est actif côté serveur ([23 §8](23-mjs-ws.md#reprise-session)) : `session: { id: string, key: string }` (clé **tournée** à chaque welcome — y compris une reprise) et `resumed: boolean` (`true` = ce welcome clôt une reprise réussie). Sans `opts.resume`, `session`/`resumed` sont **absents** — pas même `resumed: false` — comportement byte-identique à avant l'existence de la reprise.

Obligatoire — envoyé quoi qu'il arrive dès l'authentification acceptée (sauf coupure de la connexion **pendant** `opts.welcome()`, cas limite où rien n'est envoyé à personne). Déclenche côté client : état → `open`, la file d'attente hors-ligne est rejouée, le heartbeat démarre, et le client renvoie lui-même ses abonnements (`µ:sub-stream`/`µ:resync`/`µ:join`/`µ:sub-presence`, cf. note ⚠️ du hello en §1.1).

#### `µ:denied` — authentification refusée

`p = { message: string }` — toujours ce champ, jamais d'autre. Déclenche une fermeture WebSocket **définitive**, code **4001** — aucune reconnexion n'est tentée côté client de référence (`mjs_socket.ts`), contrairement à une simple coupure réseau.

**Exception, code 4004** — la session exclusive par identité en mode `'refuse'` (`sessionExclusive: 'refuse'`, [23 §8.5](23-mjs-ws.md#reprise-session)) refuse un `µ:hello` frais avec `µ:denied { message: 'session déjà active pour cette identité' }`, puis ferme avec le code **4004** (au lieu de 4001) — **seul** le code change, la connexion existante de cette identité n'est jamais touchée. Le client de référence (`mjs_socket.ts`) traite ce code comme **définitif** au même titre qu'un `µ:denied` ordinaire, y compris si la trame elle-même s'est perdue en route (`lastError` retombe alors sur `{ code: 'refused' }` — même filet de sécurité que le code 4003, cf. `µ:bye` plus bas).

#### `µ:pong` — réponse au battement

`p = { ts: <valeur reçue dans le µ:ping correspondant, verbatim> }`. Sert de corrélation pour calculer la latence côté récepteur — le serveur ne calcule ni n'interprète jamais `ts` lui-même.

#### `µ:ack` — réponse à une requête

| Champ | Type | Oblig. | Sens |
|---|---|---|---|
| `id` | `string \| number` | oui | **Même** valeur (type et contenu) que l'`id` de la requête correspondante — restituée telle quelle |
| `e` | `bool` | non | `true` = la requête a échoué (le `serve()` a levé ou rejeté) ; absent/`false` = succès |
| `p` | `any` | oui | valeur de retour du `serve()` si succès ; message d'erreur (généralement `string`) si `e: true` |

Une seule trame `µ:ack` par requête, jamais plus. `id` est le **seul** lien entre une requête et sa réponse — deux requêtes en vol avec le même `id` (mauvaise génération côté client) produiraient un comportement indéterminé côté émetteur, jamais côté serveur (qui traite chaque requête reçue indépendamment). Cette forme générique couvre les requêtes applicatives (`serve()`, §1.1) et `µgame:*` (§3) ; `µ:refresh` (§1.1) est la **seule** exception — sa charge `p` de succès a une forme dédiée (`{ exp }`), jamais un retour de `serve()`.

#### `µ:error` — erreur non fatale

Trois formes possibles, **jamais** combinées dans la même trame :

| Forme | Quand |
|---|---|
| `{ message: string }` | forme **générique** — type inconnu, débit dépassé, `µ:join`/`µ:refresh` refusé, `welcome()`/`on()` qui a levé, désaccord µschema en mode strict (§4)… tous les cas non listés ci-dessous |
| `{ code: 'token-expired' }` | l'échéance du jeton authentifié est dépassée ([23 §7.9](23-mjs-ws.md#pont)) — précède **toujours** une fermeture serveur **sans** `µ:bye` (reconnexion possible avec un jeton neuf) |
| `{ code: 'refresh-denied' }` | un `µ:refresh` a échoué — la connexion n'est **pas** affectée, elle continue de vivre jusqu'à son échéance courante |

Jamais fatal en lui-même — alimente `lastError` côté client, rien de plus. Plusieurs causes protocolaires partagent la **même** forme générique `{message}` avec un **texte** différent (throttlé à 1/s pour la plupart — débit, `join` refusé, désaccord µschema) : un client tiers doit traiter `message` comme un texte **d'affichage**, jamais comme une clé de branchement (seuls les **deux** `code` ci-dessus sont des valeurs stables destinées à être testées par égalité).

#### `µ:presence` — delta de présence

`p.room` (`string | undefined`) : `undefined` (absent du JSON, jamais `null`) pour la présence **globale**, nom du salon sinon — **même** valeur que celle passée à `µ:sub-presence`. `p.op` distingue trois formes **disjointes** :

| `op` | Champs présents | Sens |
|---|---|---|
| `'reset'` | `peers: { [id: string]: meta }` — un **objet** clé→méta, **jamais un tableau** | instantané complet, envoyé immédiatement en réponse à `µ:sub-presence` |
| `'join'` | `id: string`, `meta: any` | un pair (agrégé par identité — cf. ci-dessous) vient d'apparaître |
| `'leave'` | `id: string` (pas de `meta`) | un pair vient de disparaître |

`id` est **toujours** une chaîne (`identity.id` coercé en `String(...)`, ou l'id de connexion en repli). `meta` = ce que `opts.rooms.meta(client)` a retourné (`{}` par défaut). **Agrégation multi-onglets** : la clé d'un pair est l'**identité** (`identity.id`), pas la connexion — deux onglets du même utilisateur ne produisent qu'un **seul** `join` (au premier onglet) et qu'un **seul** `leave` (au dernier), jamais un par onglet ; `meta` reflète alors la connexion la plus **récente**. Détail : [23 §4](23-mjs-ws.md#salons-presence).

> ⚠️ **La forme `peers` d'un `reset` ici (objet `{id: meta}`) diffère de celle du pont HTTP `GET /presence` ([23 §7.3](23-mjs-ws.md#pont)), qui renvoie un tableau `[{id, meta}, ...]`.** Deux représentations légitimes de la **même** donnée, choisies indépendamment (le WebSocket suit la forme interne, le pont HTTP une forme JSON plus déroulée) — un client qui consomme les deux voies doit les traiter séparément, jamais supposer la même forme.

#### `µ:left` — expulsion d'un salon (kick)

`p = { room: string, reason?: string }` — `reason` absent si aucune raison fournie à `.kick(client, reason?)`. Envoyé **uniquement** au client expulsé (jamais aux autres membres, qui reçoivent un delta de présence `leave` ordinaire) — la connexion elle-même reste **ouverte**, ce n'est pas un `µ:bye`. Ne survient **jamais** pour un `µ:leave` volontaire (cf. §1.1).

#### `µ:bye` — fermeture propre décidée par le serveur

`p = {}` si aucune raison, `p = { reason: string }` sinon. Déclenche une fermeture **définitive** — pas de reconnexion côté client de référence (même famille que `µ:denied`, mais après une session authentifiée plutôt qu'au handshake). Émis par `client.close(reason?)` (un client précis) ou `app.stop()` (tous, en boucle, avant de fermer le transport) — code de fermeture WebSocket **1000** dans ces deux cas.

**Exception, code 4003** — la session exclusive par identité en mode `'replace'` (`sessionExclusive: 'replace'` ≡ `true`, [23 §8.5](23-mjs-ws.md#reprise-session)) éjecte l'ancienne connexion d'une identité qui vient de rouvrir ailleurs avec `µ:bye { reason: 'replace' }`, puis ferme avec le code **4003** (au lieu de 1000) — jamais parquée ni reprise, quand bien même `resume` serait actif. Le client de référence (`mjs_socket.ts`) traite ce code comme **définitif** au même titre qu'un `µ:bye` ordinaire, y compris si la trame elle-même s'est perdue en route : le code de fermeture seul suffit à couper toute reconnexion (`lastError` retombe alors sur `{ code: 'replaced' }` — filet de sécurité, sans lui le client rejouerait un `µ:hello` que le serveur re-refuserait aussitôt). Mode inverse `'refuse'` : voir le code **4004**, sur `µ:denied` ci-dessus.

#### `µ:schema` — synchronisation du registre binaire

Poussée **immédiatement après** `µ:welcome` SI ET **seulement** SI le `schemaHash` annoncé dans `µ:hello` diverge du hash serveur (et qu'au moins un schéma existe côté serveur). `p.version` (`string`) = hash serveur courant. `p.definitions` porte la sérialisation **complète** du registre — **sa forme est celle de `definitions_json()`** (§4), donc à nouveau `{ hash, schemas }` (avec `p.definitions.hash === p.version`, redondant mais réel — les deux existent indépendamment dans le code source) :

```json
{
  "t": "µ:schema",
  "p": {
    "version": "1a2b3c4d",
    "definitions": {
      "hash": "1a2b3c4d",
      "schemas": [
        { "nom": "pos",  "champs": [["x", "i16"], ["y", "i16"]] },
        { "nom": "etat", "champs": [["hp", "u8"], ["tags", { "kind": "list", "of": "str8" }]] }
      ]
    }
  }
}
```

`fields` est un tableau de paires `[nom, type]` **dans l'ordre** fil (§4) — `type` est soit une chaîne scalaire (`"u8"`, `"str8"`…) soit un objet `{kind:'list', of: <scalaire>}` / `{kind:'bits', noms: [...]}`. Détail complet des types : §4.

#### *(delta de flux)* — `{ t: <nomFlux>, seq, p: {...} }`

**Sans** préfixe `µ:` — `t` est le **nom** du flux. Détail complet : §2.

#### *(trame binaire, µschema)*

Aucune enveloppe `{t,p}` — octets bruts `[u8 idSchéma][charge]`, en trame WebSocket **binaire**. Détail complet : §4.

---

<a id="flux-spec"></a>
## 2. Flux à deltas — `stream`

Source de vérité côté serveur : `app.stream(nom)` ([23 §5](23-mjs-ws.md#flux)) — un état courant (`clé → donnée`) dont chaque mutation est numérotée, diffusée et journalisée. Un flux existe **indépendamment** de toute connexion, créé par le code serveur ; un client s'y abonne, jamais ne le crée.

### Enveloppe

```
{ "t": "<nomFlux>", "seq": <number>, "p": { "op": "...", ... } }
```

`t` = nom du flux (**sans** préfixe `µ:`, choisi par l'appli). `seq` = entier **strictement** croissant, **propre** à ce flux (jamais un timestamp — un compteur dédié, potentiellement partagé entre process via l'adaptateur, cf. [23 §9.3](23-mjs-ws.md#adaptateur-redis)).

### Les 4 opérations — `p.op`

| `op` | Champs de `p` | Effet côté récepteur |
|---|---|---|
| `'reset'` | `values: { [id: string]: any }` | remplace l'état **complet** — nouvelle « époque », vide tout historique de rattrapage |
| `'add'` | `key: string`, `value: any` | ajoute/remplace l'entrée `key` |
| `'update'` | `key: string`, `patch: object` | fusion **1 niveau** (`{ ...existant, ...patch }`) — **pas** une fusion profonde : une clé absente de `patch` reste inchangée, une clé présente **remplace** (jamais fusionnée elle-même) |
| `'remove'` | `key: string` | retire l'entrée |

`reset` peut survenir à **n'importe quel** `seq` (aucune contrainte de contiguïté) — c'est le point de resynchronisation universel, et il **vide** le journal serveur (aucun rejeu ne traversera jamais un `reset`). `add`/`update`/`remove` doivent avoir un `seq` **contigu** par rapport au précédent vu sur CE flux ; un trou détecté côté récepteur déclenche un `µ:resync` (§1.1).

### Cycle de vie d'un abonnement

1. `µ:sub-stream { stream }` (§1.1) → réponse **immédiate** `{ op: 'reset', values: <état courant> }` au `seq` courant (état vide si le flux n'a encore rien reçu).
2. Chaque mutation serveur (`stream.add/update/remove/reset(...)`) diffuse `{ t, seq: ++compteur, p }` à **tous** les abonnés de ce flux, et journalise l'entrée dans un anneau borné (sauf `reset`, qui **vide** le journal — taille par défaut 200 deltas, réglable **par** flux).
3. Un abonné qui reçoit un `seq` ≠ (dernier `seq` vu + 1) — donc un **trou** — envoie lui-même `µ:resync { stream, from: dernierSeqVu }` (§1.1). Entièrement automatique côté client de référence : rien à coder.

### `µ:resync` — la décision serveur

| Situation au `µ:resync { from }` | Réponse |
|---|---|
| `from === seq` courant | **Rien** — zéro octet, le récepteur est déjà à jour |
| `from > seq` courant (serveur redémarré, compteur reparti à zéro) | `reset` complet, nouvelle époque |
| Tous les deltas `from+1 … seq` sont encore dans le journal | **Rejeu** de **ces** deltas **seuls**, avec leurs `seq` **d'origine** (jamais renumérotés) — un récepteur qui ignore tout `seq ≤` son dernier vu peut donc recevoir un doublon sans risque |
| Trou plus large que ce que couvre le journal | `reset` complet |

Un `µ:sub-stream`/`µ:resync` vers un nom de flux **jamais** déclaré côté serveur (`app.stream(nom)` jamais appelé) répond honnêtement `{ op: 'reset', values: {} }` au `seq: 0` — jamais une création fantôme, jamais un silence qui laisserait le récepteur sans réponse.

### Hors de portée de µschema

Un delta de flux n'est **jamais** schématisable en binaire (§4) — sa forme porte un `seq` que µschema ne modélise pas. `t`/`seq`/`p` restent **toujours** en JSON, quel que soit `ws.codec`.

---

<a id="jeu-spec"></a>
## 3. Trames de jeu `µgame:*`

Préfixe **réservé** par [24 · MJS-Server](24-mjs-server.md), une couche composée **au-dessus** de `mjsWs` (pas `mjsWs` lui-même) — `app.serve`/`app.on` d'un type qui commence par `µgame:`, et `app.schema`/`opts.schemas` d'un **schéma** sous ce préfixe (cf. l'encart du §0), lèvent une erreur claire côté application hôte ; jamais improvisable en dehors de MJS-Server. Chaque trame `µgame:*` est un message **applicatif** ordinaire au sens du §1 (aucun statut protocolaire spécial dans `mjsWs`) : les 4 premières ci-dessous voyagent comme des **requêtes** `{t,p,id}` (§1.1), les autres comme du pub/sub.

<a id="jeu-c2s"></a>
### 3.1 Client → Serveur (requêtes, `µ:ack` en retour)

#### `µgame:play` — s'asseoir (file publique ou partie privée)

`p = { type: string, code?: true | string }` — `type` = nom du jeu déclaré (`app.game(type, def)`) ; `code` discriminé par **type**, jamais par sa seule présence :

| `code` | Effet |
|---|---|
| absent | file d'attente **publique** — la partie se crée dès que `def.seats` joueurs sont accumulés |
| `true` (booléen) | crée une partie **privée** neuve (exige `def.code: true` à la déclaration, sinon erreur) — le code généré revient dans la réponse |
| `"XXXXX"` (chaîne) | rejoint la partie privée existant à ce code — code inconnu → erreur |

Réponse `µ:ack.p` — **deux** formes :

- **pas encore assis** (file publique, quota pas atteint) : `{ attente: number }` (position dans la file) ;
- **assis** : `{ game: string, seat: number, phase, turn, seq, code: string | undefined, ...infoMode }`, où `infoMode` vaut `{ view: any }` en mode `'authoritative'` (défaut), ou `{ seed: number, journal: [...] }` en mode `'lockstep'` ([24 §13](24-mjs-server.md#netcode)) — la graine déterministe + l'historique **complet** des ordres depuis la genèse, à rejouer côté client.

Une reconnexion sur la **même** identité (déjà assise) via `code` est **idempotente** — renvoie la même réponse de siège, ne recrée rien.

#### `µgame:move` — jouer un coup

`p = { game: string, move: string, p?: any }` — `game`/`move` obligatoires (chaînes), `p` = charge libre du coup. Réponse `µ:ack.p = { ok: true, result: <retour de def.moves[move]/def.intents[move]> }` en succès ; un `throw` interne (coup illégal, partie introuvable) devient un `µ:ack` d'erreur — **même** mécanisme générique que n'importe quel `serve()` qui lève (§1.2).

> 🔗 **Extension `_n`/`_ack` (prédiction, `µ.predict`).** Quand `game.move()` est enveloppé par `µ.predict` ([24 §13](24-mjs-server.md#netcode)), `p._n` (compteur croissant **côté client**) se glisse **dans** la charge `p` — le serveur le détache **avant** `def.intents[move]` (jamais vu par la logique de jeu) et reflète le **plus grand** `_n` appliqué dans une méta `_ack` sur `µgame:state` (3.2). Uniquement pour `def.intents` (jamais `def.moves`) — un client qui n'utilise pas `µ.predict` n'a jamais à s'en soucier.

#### `µgame:leave` — quitter la partie (vide le siège)

`p = { game: string }`. Réponse `µ:ack.p = { ok: true }`. Contrairement à une simple déconnexion (qui **garde** le siège, en attente de reconnexion), `µgame:leave` vide le siège immédiatement — déclenche `µgame:left` et `µgame:seat` (3.2) vers les autres sièges.

#### `µgame:resync` — vue fraîche complète (reconnexion)

`p = { game: string }`. Réponse `µ:ack.p = { game, seat, phase, turn, seq, code, ...infoMode }` — **même** forme que la réponse « assis » de `µgame:play` ci-dessus. **Toujours une vue complète**, jamais un delta même si `def.deltas: true` — ce qui vient d'être envoyé devient la nouvelle baseline pour le **prochain** delta (3.2).

#### `µgame:hash` — annonce de hash (lockstep seul) — **aucun** `µ:ack`

`p = { game: string, tick: number, h: string }` — trois champs obligatoires (sinon ignoré silencieusement, best-effort). **fire-and-forget** : jamais de réponse, même avec un `id`. Significatif **seulement** en mode `def.mode: 'lockstep'` ([24 §13](24-mjs-server.md#netcode)) — anti-triche par **quorum** (majorité absolue des sièges courants, jamais le premier hash vu) : la référence d'un tick se fige au premier hash qui atteint ce quorum, un siège en auto-contradiction (deux hash différents pour le même tick) est flaggé suspect immédiatement (cf. `µgame:event` de type `'divergence'`, 3.2).

<a id="jeu-s2c"></a>
### 3.2 Serveur → Client (poussées, sans `µ:ack`)

#### `µgame:state` — l'état du jeu, **pour CE joueur**

Base commune : `{ game: string, phase, turn, seq }`, plus `_ack: number` SI CE joueur a déjà fait appliquer au moins un `_n` (cf. `µgame:move` ci-dessus — absent sinon, jamais dans la vue du jeu elle-même). Puis **exactement** un des cas suivants :

| `def.deltas` | Champ ajouté | Quand |
|---|---|---|
| `false` (défaut) | `view: any` | à chaque diffusion — vue **complète**, calculée par `def.view(game, player)` |
| `true` | `delta: [{ p: 'chemin.a.b', v: <valeur> }, { p: 'chemin.c', x: 1 }, ...]` | changement normal — `v` pose/remplace la valeur au chemin `p` (à points) ; `x: 1` supprime la clé finale du chemin |
| `true`, repli | `view: any` | 1ʳᵉ diffusion à ce joueur, OU un `µgame:resync` (toujours vue complète), OU un delta dont le JSON dépasse 60 % de celui de la vue complète |
| `true`, rien n'a changé **pour CE joueur** | *(aucune trame)* | zéro octet, pas même une trame vide |

Diffusée par microtâche (mode événementiel, `tick: 0` — les mutations d'un même tour de boucle sont groupées) ou une fois par tick (mode action, `tick > 0`). Absente en mode `'lockstep'` — le serveur n'y simule rien, cf. `µgame:orders` plus bas. Détail des deltas : [24 §11](24-mjs-server.md#deltas).

#### `µgame:event` — événement applicatif libre

`p = { game: string, type: string, p: any }` — émis par `game.send(type, p)` côté jeu, forme et sens entièrement définis par l'application (aucune contrainte au-delà de l'enveloppe). Cas réservé : `type: 'divergence'` en mode lockstep, poussé par le serveur lui-même quand un `µgame:hash` (3.1) contredit la référence du tick (ou qu'un siège s'auto-contredit) — `p.p = { tick: number, suspects: number[], reason: string }` (même objet que `def.onDivergence`, [24 §13](24-mjs-server.md#netcode)).

#### `µgame:seat` — roster (places et connexions)

`p = { game: string, seats: number, seats: Array<{ seat: number, connected: bool } | null> }` — un élément par place déclarée (`def.seats`, longueur **fixe**), `null` = place vide. Poussé à **chaque** changement (arrivée, départ, (dé)connexion) — jamais fusionné avec `µgame:state`.

#### `µgame:start` — la partie démarre (places complètes)

`p = { game: string, seat: number, phase, turn, seq, code, ...infoMode }` — **même** forme que la réponse « assis » de `µgame:play` (3.1). Poussé **une seule** fois, la 1ʳᵉ fois que `seats` est atteint, à tous les sièges qui n'ont pas eux-mêmes déclenché la complétion via leur propre réponse `µgame:play`/`µgame:resync` (celui qui déclenche reçoit l'équivalent directement dans SA réponse — jamais un `µgame:start` en double pour lui).

#### `µgame:end` — fin de partie

`p = { game: string, result: any }` — **deux** origines, cycle de vie **différent** après l'envoi :

| Origine | `result` | Après l'envoi |
|---|---|---|
| `game.end(result)` (applicatif) | l'argument **tel quel** | la partie survit encore `def.emptyTtl` ms — un dernier `µgame:resync` peut encore voir l'issue avant destruction |
| Annulation (fenêtre `seatTtl` expirée sans confirmation, [24 §6](24-mjs-server.md#appariement)) | `{ cancelled: true, reason: 'seat-expired' }` — v1 n'a qu'**une** seule raison connue | destruction **immédiate**, aucune grâce — un `µgame:resync` ultérieur trouve la partie introuvable |

#### `µgame:left` — un **autre** siège est parti

`p = { game: string, seat: number }` — envoyé à **tous** les sièges connectés à la suite d'un `µgame:leave` volontaire (3.1). Ne **pas** confondre avec `µ:left` (§1.2, expulsion d'un **salon** `mjsWs` générique) — préfixe différent, mécanisme différent, aucun rapport entre les deux.

#### `µgame:orders` — mode lockstep seul, à **chaque** tick clos

`p = { game: string, tick: number, orders: [{ player: string, move: string, p: any }, ...] }` — `orders` peut être **vide** (le tick lui-même est l'horloge commune, jamais sauté faute d'ordre). **Même** trame diffusée à l'**identique** à tous les sièges connectés — l'égalité d'entrée entre clients est le cœur du déterminisme lockstep ([24 §13](24-mjs-server.md#netcode)). Remplace `µgame:state` dans ce mode — un `def.mode: 'lockstep'` ne pousse **jamais** de `µgame:state`.

---

<a id="binaire-spec"></a>
## 4. Format binaire µschema

Couche opt-in qui remplace le JSON par des octets compacts pour un type applicatif **déclaré** — jamais les trames de contrôle `µ:`, jamais les requêtes, jamais les deltas de flux (§2), jamais `µgame:*` (garde de MJS-Server, cf. l'encart du §0). Vue d'ensemble et déclaration (`app.schema`/`µ.schema`) : [23 §3.1](23-mjs-ws.md#µschema). Ici : la forme **exacte** des octets, pour qui doit l'encoder/décoder hors JS.

### Enveloppe fil (WebSocket)

```
[u8 idSchéma][charge]
```

Trame WebSocket **binaire** entière — pas de `{t,p,id}` JSON autour. `idSchéma` (1 octet, 0-255) identifie le schéma, attribué dans l'**ordre** de déclaration (`app.schema`/`µ.schema`), **jamais** choisi à la main — deux registres déclarés dans le **même** ordre obtiennent les **mêmes** ids (condition du hash stable, plus bas). `fields` (à la déclaration) est un objet **ordonné** `{ nom: type, ... }` — l'**ordre des clés** fait foi sur le fil, figé à la déclaration, jamais recalculé.

### Types scalaires

| Type | Taille | Encodage |
|---|---|---|
| `u8` / `i8` | 1 octet | entier non signé / signé |
| `u16` / `i16` | 2 octets | entier non signé / signé, **little-endian** |
| `u32` / `i32` | 4 octets | entier non signé / signé, little-endian |
| `f32` | 4 octets | flottant simple précision IEEE 754, little-endian |
| `f64` | 8 octets | flottant double précision IEEE 754, little-endian |
| `bool` | 1 octet | `0x00` = `false` ; encodé `0x01` pour `true` (décodé : tout octet non nul = `true`) |
| `str8` | 1 (préfixe) + N octets | préfixe `u8` = longueur EN **octets** UTF-8 (max 255), puis les octets UTF-8 |
| `str16` | 2 (préfixe) + N octets | préfixe `u16` little-endian = longueur EN **octets** UTF-8 (max 65535), puis les octets |

**Toutes les valeurs multi-octets sont little-endian, sans exception** (u16/i16/u32/i32/f32/f64, et les préfixes de longueur u16 de `str16`/`list`).

### Types composites — `list()` / `bits()`

| Type | Encodage | Notes |
|---|---|---|
| `list(scalaire)` | `u16` (compteur, little-endian, max 65535) puis `scalaire` répété N fois | v1 : `scalaire` **uniquement** — pas de `list(list(...))`, pas de sous-schéma imbriqué |
| `bits([noms])` | 1 octet — bit `i` (`1 << i`) porte `noms[i]` | jusqu'à 8 noms ; décodé en objet `{ [nom]: bool, ... }` |

### Encodage d'une trame

```
octet 0     : idSchéma (u8)
octet 1..N  : fields, DANS L'ORDRE DE DÉCLARATION, chacun selon son type
```

Une valeur absente ou d'un type inattendu s'encode en valeur **zéro** (`0`, `false`, chaîne vide, liste vide) plutôt que de lever — **seules** les erreurs **structurelles** (schéma inconnu à l'encodage/décodage, chaîne ou liste trop longue pour son préfixe) déclenchent une exception.

**Exemple** — schéma `pos: { x: 'i16', y: 'i16' }` déclaré EN **premier** (id `0`), valeur `{x: 300, y: -20}` :

```
octet    0     1     2     3     4
valeur   0x00  0x2C  0x01  0xEC  0xFF
sens     id    x = 300 (i16 LE)  y = -20 (i16 LE, complément at deux : 0xFFEC)
```

5 octets au total (1 id + 2 × 2 octets) contre 18 pour `{"x":300,"y":-20}` en JSON.

### Garde d'évolution — **ajout-seul**

Un schéma déjà déclaré est **immuable** (mêmes champs, mêmes types, **même** ordre). Le ré-affirmer À **l'identique** (rechargement à chaud d'un entry) est un no-op silencieux, id inchangé ; le ré-affirmer sous une forme **différente** lève une erreur claire au boot. Fais évoluer ton protocole en déclarant un schéma à un **nom neuf**, jamais en mutant un schéma existant.

### Hash du registre — FNV-1a 32 bits

`hashRegistre()` calcule un FNV-1a 32 bits, rendu en **hex** sur **exactement** 8 caractères (zéros de tête inclus), sur la chaîne :

```
nom1:champA=type,champB=type|nom2:champC=type|...
```

— schémas dans l'ordre de **leur** id, champs dans l'ordre du fil, type décrit `u8`/`str8`/… tel quel, ou `list(u8)` / `bits(a+b+c)` pour un composite. Sert à détecter un **désaccord** entre deux registres (client/serveur, ou deux implémentations dans deux langages) — **pas** une preuve d'intégrité cryptographique (FNV-1a n'est pas conçu pour résister à une collision volontaire).

> ⚠️ **Suppose des noms ASCII.** L'algorithme diverge entre une implémentation JS (`charCodeAt`, unités UTF-16) et une implémentation Ruby/Python (`each_byte`, octets UTF-8) **seulement** si un nom de schéma ou de champ contient un caractère non-ASCII — jamais sur les **valeurs** des champs eux-mêmes (celles-ci suivent l'encodage scalaire ci-dessus, indépendant du hash).

### Sérialisation JSON du registre — `µ:schema` (§1.2) et rafraîchissement HTTP

```json
{
  "hash": "1a2b3c4d",
  "schemas": [
    { "nom": "pos",  "champs": [["x", "i16"], ["y", "i16"]] },
    { "nom": "etat", "champs": [["hp", "u8"], ["tags", { "kind": "list", "of": "str8" }], ["drapeau", { "kind": "bits", "noms": ["vivant", "arme", "vip"] }]] }
  ]
}
```

`fields` = tableau de paires `[nom, type]` **dans l'ordre** fil — `type` est une chaîne pour un scalaire, ou un objet `{kind:'list', of: <scalaire>}` / `{kind:'bits', noms: [...]}` pour un composite (déjà des objets **inertes**, JSON-safe — jamais une fonction embarquée). C'est **cette** forme, précisément, que porte `µ:schema.p.definitions` (§1.2) — un récepteur qui la reçoit peut reconstruire un registre complet sans connaître le code source de l'application.

### µschema-HTTP — même charge, 8 octets de version en préfixe

`µ.ajax.binary(url, opts)` (opt-in **par point d'accès**, [23 §3.2](23-mjs-ws.md#µschema)) réutilise **exactement** l'enveloppe ci-dessus, préfixée de 8 octets ASCII :

```
[8 octets ASCII — hash hex, LITTÉRAL, PAS un entier packé][u8 idSchéma][charge]
```

Les 8 octets sont `hashRegistre()` écrits **tels quels** en caractères ASCII (lisibles dans un dump hexa sans le moindre calcul bit à bit) — le reste de la trame est identique à l'enveloppe WebSocket ci-dessus. Une réponse dont la version diffère du registre local déclenche un rafraîchissement (un `GET` sur l'endpoint schéma, un seul aller-retour, jamais une boucle) plutôt qu'un échec. Détail complet + recette Rails `Array#pack`/`String#unpack1` (sans dépendance) : [23 §3.2](23-mjs-ws.md#µschema).

### Trois modes de transport — `ws.codec`

Détermine **quand** le binaire remplace le JSON pour un type **schématisé** — détail complet (y compris la garde de débit/taille partagée avec le texte) : [23 §3.1](23-mjs-ws.md#µschema).

| `codec` | Sortant (`send`/`sendUser`/`broadcast`/`room().send`) | Entrant |
|---|---|---|
| `'auto'` (défaut) | type schématisé → binaire ; sinon JSON, comme sans µschema | accepte texte ET binaire |
| `'binary'` (**strict**) | type schématisé → binaire ; type applicatif **sans** schéma → **lève** immédiatement, avant tout envoi | trame **texte** applicative (hors `µ:`) → **rejetée** (`µ:error` throttlé, jamais routée) |
| `'json'` | toujours JSON, même un type schématisé (coupe-circuit débogage) | accepte texte ET binaire |

Les trames de contrôle `µ:` (§1) restent **toujours** JSON, quel que soit `codec` — le bootstrap du hello ne peut pas dépendre d'un schéma pas encore synchronisé.

---

<a id="securite-spec"></a>
## 5. Sécurité du pont HTTP

Tout ce qui précède (§1-§4) ne couvre **que** la connexion WebSocket. Un second canal existe pour qu'un back **hors** `mjsWs` (Rails, PHP, un worker) pousse du temps réel ou reçoive des décisions déléguées : le **pont universel** ([23 §7](23-mjs-ws.md#pont)) — un serveur HTTP séparé, signé, embarqué dans le même process. Cette section **renvoie** au détail complet (endpoints, webhooks, jetons, proxy de décisions, recettes par langage) plutôt que de le dupliquer ; elle résume seulement la mécanique de signature, utile pour l'implémenter dans un langage sans recette déjà écrite.

### La chaîne canonique

Chaque requête **signée** (tout le pont **sauf** `GET /health`, et le proxy de décisions, [23 §7.11](23-mjs-ws.md#pont)) porte deux en-têtes :

| En-tête | Contenu |
|---|---|
| `x-mjs-ws-timestamp` | heure UNIX EN **secondes** au moment de la signature |
| `x-mjs-ws-signature` | HMAC-SHA256 **hexadécimal** de la chaîne canonique, avec le secret partagé |

Chaîne canonique du pont admin/webhooks — champs encodés en **longueur-préfixée** (`{longueur}:{champ}`, injectif) et concaténés, `direction` en premier champ ([23 §7.2](23-mjs-ws.md#pont)) :

```
{lp(direction)}{lp(timestamp)}{lp(MÉTHODE)}{lp(chemin+query)}{lp(corps brut)}[{lp(nonce)}]
```

`direction` vaut `'in'` (commande admin, ton back → le pont) ou `'out'` (webhook, le pont → ton back) — **jamais** interchangeables, **même** secret partagé ; `{MÉTHODE}` en **majuscules** ; `{chemin+query}` tel qu'il apparaît dans l'URL (jamais domaine ni port) ; `{corps brut}` = le JSON envoyé **texte pour texte** (jamais re-sérialisé — l'ordre des clés compte), chaîne **vide** pour un `GET`. Le nonce optionnel ([23 §7.10](23-mjs-ws.md#pont)) s'ajoute en **dernier** champ.

### Vérification et fenêtre anti-rejeu

Comparaison en temps **constant** (`crypto.timingSafeEqual` ou équivalent — jamais une comparaison de chaînes naïve, qui fuiterait la validité par le temps de réponse). Fenêtre anti-rejeu par défaut : `|now − timestamp| > 300s` → `401`, même avec une signature juste. Un nonce optionnel ([23 §7.10](23-mjs-ws.md#pont)) ferme cette fenêtre complètement (chaque requête devient à usage unique).

### Qui signe quoi

| Sens | Signataire | Vérificateur | `direction` |
|---|---|---|---|
| Ton back → pont (`/broadcast`, `/send`, `/room/send`, `/room/kick`, `/stream`, `/presence`) | ton back | le pont | `'in'` |
| Pont → ton back (webhooks, [23 §7.5](23-mjs-ws.md#pont)) | le pont | ton back | `'out'` |
| `mjsWs` → ton back (proxy de décisions `auth`/`rooms.join`, [23 §7.11](23-mjs-ws.md#pont)) | `mjsWs` | ton back | — (chaîne **historique**, pas de `direction` — cf. [23 §7.11](23-mjs-ws.md#pont)) |

**Même** algorithme longueur-préfixée pour les **deux** premiers sens (pont admin/webhooks) — seul `direction` change entre eux ; le proxy de décisions (3e ligne) reste sur la chaîne **historique** `'.'`-jointe, secret et canal séparés (`bridge.secret`/`webhooks.secret` ≠ secret du proxy). Ton back doit donc savoir signer (requêtes sortantes) ET vérifier (requêtes entrantes) — les **deux** formats s'il utilise le pont ET le proxy. Recettes par langage : jetons JWT ([23 §7.6](23-mjs-ws.md#pont), Ruby/PHP/Python sans dépendance + gem `jwt`), pont depuis Rails ([23 §7.7](23-mjs-ws.md#pont)), trois recettes combinées bout en bout ([23 §7.12](23-mjs-ws.md#pont)).

### Ce qui reste **hors** du pont

Les jetons `µ:hello`/`µ:refresh` (§1) sont un mécanisme **séparé** (JWT HS256, [23 §7.6](23-mjs-ws.md#pont)) — pas de chaîne canonique HMAC, pas de fenêtre anti-rejeu par requête (l'échéance `exp` du jeton joue ce rôle, suivie en continu côté serveur, [23 §7.9](23-mjs-ws.md#pont)). Les deux mécanismes de signature (pont HTTP, jetons WebSocket) sont **indépendants** et utilisent généralement des secrets **différents** — ne pas les confondre en déploiement (`bridge.secret` ≠ `auth`/`rooms.join` proxy secret ≠ secret de signature JWT applicatif).

---

*Voir aussi : [20 · Temps réel](20-temps-reel.md) pour le client `µsocket` (ce que ce protocole rend inutile à réécrire à la main), [23 · MJS-WS](23-mjs-ws.md) pour le serveur de référence qui l'implémente, [24 · MJS-Server](24-mjs-server.md) pour la couche de jeu composée par-dessus.*
