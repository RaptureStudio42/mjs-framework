# 23 · MJS-WS — serveur compagnon (Node)

> **Module complet.** Contrat client : voir [20 · Temps réel](20-temps-reel.md) · prise en main pas à pas : leçon tuto [Le serveur officiel (mjs ws)](/tuto#/serveur-mjs-ws).

`mjsWs` est le **serveur compagnon officiel** de `µsocket` : un moteur Node qui parle nativement le protocole `µ:` (handshake, ping/pong, requêtes/accusés de réception, pub/sub, salons, présence, flux à deltas numérotés, protections anti-abus…) pour que tu n'aies plus jamais à le ré-écrire à la main derrière une `WebSocketServer` nue.

```js
import { mjsWs } from 'modularjs-framework/ws'

const app = mjsWs({
  auth:    (hello, meta) => hello.auth?.token === PROCESS_SECRET ? { id: hello.auth.userId, pseudo: hello.auth.pseudo } : false,
  welcome: (client) => ({ serverTime: Date.now(), userId: client.identity.id }),
  rooms:   { join: (room, client) => room !== 'vip' || client.identity.admin, meta: (client) => ({ pseudo: client.identity.pseudo }) },
})

app.serve('achat', (p, client) => {
  if (p.prix > 100) throw new Error('solde insuffisant')
  return { solde: 100 - p.prix }
})

app.on('chat', (p, client) => app.broadcast('chat', p, { except: client }))

const ennemis = app.stream('ennemis')            // flux : état + deltas numérotés + rattrapage auto
ennemis.add('e1', { x: 10, y: 20 })

app.room('partie-42').kick(tricheur, 'triche')   // expulsion d'un salon (µ:left), connexion gardée

await app.listen()   // démarre le transport `ws` par défaut (port 8080)
```

C'est **tout** ce qu'il faut pour un serveur `µsocket` complet et protégé, conforme au contrat : le handshake (`µ:hello`/`µ:welcome`/`µ:denied`), le battement (`µ:ping`/`µ:pong`), les accusés de réception (`µ:ack`), les salons et la présence (`µ:join`/`µ:leave`/`µ:sub-presence`), les flux avec resynchronisation (`µ:sub-stream`/`µ:resync`) et la salve de re-souscription post-(re)connexion sont **déjà gérés**.

---

## Sommaire

1. [Options — `mjsWs(opts)`](#options)
2. [`app` — API](#app-api)
3. [Protections de série (« le videur »)](#protections)
4. [Salons & présence](#salons-presence)
5. [Les flux qui se rattrapent — `app.stream`](#flux)
6. [Lancer le serveur — `mjs ws`](#mjs-ws)
7. [Le pont universel](#pont)
8. [La reprise de session](#reprise-session)
9. [Plusieurs processus — l'adaptateur Redis](#adaptateur-redis)
10. [L'état du serveur](#etat-serveur)
11. [Contrat typé (optionnel)](#contrat-type)
12. [La façade transport : brancher uWebSockets.js (ou autre chose)](#transport-facade)
13. [Écrire son fichier serveur — le dialecte de tes composants](#civet-entry)
14. [Statut du module](#statut)
15. [Aller plus loin](#aller-plus-loin)

---

<a id="options"></a>
## 1. Options — `mjsWs(opts)`

| Option | Défaut | Rôle |
|---|---|---|
| `transport` | `'ws'` (bibliothèque `ws`) sur `port`/`host` | `'ws'` ou `'uws'` (uWebSockets.js intégré), ou une **instance** `MjsWsTransport` déjà construite (`MemoryTransport` en test, un transport maison). Cf. §12 « La façade transport » pour tout brancher soi-même. |
| `port` / `host` | `8080` / — | Ignorés si `transport` est une instance déjà construite. |
| `auth(hello, meta)` | — (aucune auth : `identity` vaut `undefined`) | `hello` = charge du `µ:hello` (`{ auth, protocol, resub, rooms }`), `meta` = `{ origin?, headers? }`. Le retour alimente `client.identity`. `false` ou `throw` → `µ:denied { message }` (fermeture définitive côté client). Accepte aussi un objet-proxy `{ url, secret, timeout?, cache? }` qui délègue la décision à un back HTTP signé — cf. §7.11 « Proxy de décisions ». |
| `welcome(client)` | `() => ({})` | Construit la charge du `µ:welcome`, envoyée **immédiatement** après l'auth — rien d'autre ne s'intercale (piège client documenté en [20 · Temps réel](20-temps-reel.md)). |
| `parse` / `serialize` | `JSON.parse` / `JSON.stringify` | (Dé)sérialisation personnalisée des trames. |
| `heartbeat` | `15000` ms | Période **attendue** des `µ:ping` client. `0` = watchdog serveur désactivé. |
| `limits` | cf. §3 | Quotas anti-abus par connexion. |
| `verifyOrigin` | désactivé | Vérification d'origine à l'admission, opt-in strict — tableau (allowlist d'origines exactes, insensible à la casse) OU fonction `(origin, remote) => boolean` (contrôle total). Refus = fermeture immédiate code **1008**, **avant** le hello. Cf. §3.3 « Vérification d'origine ». |
| `rooms.join(room, client)` | — (tout accepté) | Garde d'admission aux salons. `false` ou `throw` → refus (`µ:error { message }`, throttlé), le client n'entre pas. Async autorisée. Accepte aussi un objet-proxy `{ url, secret, timeout?, cache? }` (§7.11). Cf. §4. |
| `rooms.meta(client)` | `() => ({})` | Méta de présence associée à une connexion (pseudo, avatar…), diffusée dans les deltas `µ:presence`. Cf. §4. |
| `guardProcess` | `false` | Si `true`, pose des filets `uncaughtException`/`unhandledRejection` qui **loggent sans tuer** le process. |
| `onLog(niveau, message, meta?)` | `console` (format sobre) | `niveau` : `'debug' \| 'info' \| 'warn' \| 'error'`. |
| `resume` | désactivé | Reprise de session après micro-coupure — `true` (défauts : grâce 30 s, 500 trames, 256 Ko) ou `{ grace?, maxBuffered?, maxBytes? }`. Cf. §8. |
| `sessionExclusive` | `false` | Session exclusive par identité, **deux** modes — `true`/`'replace'` : un 2e `µ:hello` **frais** de la **même** identité éjecte proprement l'ancienne connexion (`µ:bye {reason:'replace'}` + fermeture code **4003**). `'refuse'` (inverse) : ce 2e `µ:hello` est **refusé** si une connexion vivante existe déjà (`µ:denied` + fermeture code **4004**). Cf. §8.5. |
| `onDisconnect(client, reason?)` | — | Rappelée à la déconnexion **définitive** d'un client (immédiate sans `resume`, différée à la fin de la grâce sinon) — **toujours** disponible, sans `opts.bridge`. Cf. §8.2 point 5. |
| `stats` | désactivé | Expose GET /stats, /metrics, /state sur le pont (`bridge` requis pour les servir en HTTP). Le registre de compteurs (`app.stats()`) tourne **toujours**, quelle que soit cette valeur. Cf. §10. |
| `codec` | `'auto'` | `'auto'` (type schématisé → binaire, reste JSON) / `'binary'` (**strict**, refuse tout texte applicatif sans schéma) / `'json'` (coupe-circuit débogage, tout en JSON). Cf. §3.1 « µschema ». |
| `schemas` | — | Déclaration EN **masse** de schémas `{ nom: champs, ... }`, équivalent à autant de `app.schema(nom, champs)` avant `.listen()`. Cf. §3.1. |

<a id="app-api"></a>
## 2. `app` — API

| Méthode | Rôle |
|---|---|
| `.serve(type, (p, client) => résultat)` | Requêtes `{t,p,id}` → `µ:ack` **automatique** (retour → `p` ; `throw`/reject → `{e:true, p:message}`). |
| `.on(type, (p, client) => …)` | Pub/sub — aucune réponse attendue. |
| `.send(client, type, p)` | Envoi ciblé à **une** connexion précise (déjà en main, ex. dans un handler). |
| `.sendUser(id, type, p)` | Envoi à **toutes** les connexions d'un utilisateur (`identity.id`, repli id de connexion) — même résolution que le pont universel (`POST /send { user }`, §7), cluster-aware. |
| `.broadcast(type, p, { except? })` | Diffusion à tous les clients authentifiés (`except` : un client ou un tableau de clients). |
| `.error(client, message)` | Émet un `µ:error { message }` (non fatal côté client). |
| `.use(pkg)` | Installe un paquet activable (`app.use(a).use(b)`, chaînable — retourne toujours `app`) : enregistre les handlers/conventions du paquet sur cette app. Double installation du même nom de paquet : ignorée. Exemples : [26 · Chat](26-chat.md), [27 · Comptes](27-accounts.md), [28 · Lobby](28-lobby.md). |
| `.room(nom)` | Poignée de salon — diffusion aux membres, présence, expulsion. Cf. §4. |
| `.stream(nom, { journal? })` | Flux à journal borné — état + deltas numérotés + rattrapage. Cf. §5. |
| `.stats()` | Instantané JSON de l'état du serveur (connexions, messages, salons, flux, garde, pont, sessions, latences…) — **toujours** disponible, cf. §10. |
| `.schema(nom, champs)` | Déclare (ou ré-affirme à l'identique) un schéma binaire nommé — `champs` = objet **ordonné** `{ nom: type, ... }`. Cf. §3.1 « µschema ». |
| `.clients` | Itérable des clients **authentifiés** (le handshake en cours n'y figure pas). |
| `.listen()` | Démarre le transport. Promesse résolue une fois prêt. |
| `.stop()` | `µ:bye` à tous les clients, fermeture propre des connexions, puis du transport. |

`client` : `.id` (identifiant interne), `.identity` (retour de `auth`), `.latency` (dernier écart entre deux `µ:ping` reçus, ms), `.meta` (`{origin?, headers?}`), `.send(type, p)`, `.close(reason?)` (envoie `µ:bye` puis ferme — départ **définitif**, le client ne reconnecte pas).

---

<a id="protections"></a>
## 3. Protections de série (« le videur »)

Actives par défaut, aucune configuration requise :

| Limite | Défaut | Effet au dépassement |
|---|---|---|
| `limits.rate` / `limits.burst` | 40 msg/s / 80 | Seau à jetons par connexion. Trame en trop **ignorée** + `µ:error` (throttlé — un seul message, pas un par trame jetée) ; expulsion après `limits.kickAfter` violations. |
| `limits.maxPayload` | 65536 octets | Trame surdimensionnée → fermeture immédiate, code **1009**. |
| `limits.maxBuffered` | 1048576 octets | Contre-pression à l'émission : un envoi est jeté si le buffer du transport déborde déjà ; expulsion après 50 rejets **consécutifs**. |
| `limits.kickAfter` | 50 | Aussi réutilisé pour le JSON invalide (1 `warn` + compteur dédié par connexion). |
| `limits.maxConnections` | `null` (illimité, opt-in) | Plafond GLOBAL de connexions simultanées. Une connexion entrante au-delà est refusée avant authentification : fermeture immédiate, code **1013**. |
| `limits.maxConnectionsPerIp` | 100 | Plafond de connexions simultanées PAR IP. Même refus (code **1013**) ; une IP inconnue (transport sans `remoteInfo.address`) n'est jamais comptée par ce plafond. |
| `limits.maxRoomsPerClient` | 50 | Plafond de salons qu'un même client a rejoints en même temps. Au-delà, `µ:join` est refusé (`µ:error`, throttlé) — la connexion, elle, reste ouverte. |
| `heartbeat × 2.5` | 37,5 s par défaut | Watchdog serveur : une connexion muette (aucune trame reçue, `µ:ping` compris) au-delà de ce délai est expulsée. `heartbeat: 0` le désactive. |
| — | — | **Tout** handler applicatif (`auth`/`welcome`/`serve`/`on`) tourne sous garde : une exception ne fait jamais planter le process ni geler la connexion. |
| `guardProcess: true` | désactivé | Filet process entier (`uncaughtException`/`unhandledRejection`) — défense en profondeur au-delà des handlers connus. |

Nuance importante : une expulsion de **protection** (débit, taille, contre-pression, watchdog) ferme la connexion **sans `µ:bye`** — le client peut reconnecter normalement, utile si la coupure était transitoire. Seuls `.stop()` et `client.close()` sont des départs **définitifs et annoncés** (`µ:bye`, aucune reconnexion cliente).

<a id="µschema"></a>
### 3.1 µschema — le binaire à schéma

Une trame WebSocket **binaire** (par opposition au texte JSON du protocole `µ:`) passe sous le **même videur** qu'un message texte — rien ne contourne la garde de débit (`limits.rate`/`limits.burst`) ni la garde de taille (`limits.maxPayload`, même code de fermeture **1009** au dépassement). `µschema` est la couche qui donne un **sens** à ces octets : un **registre de schémas** déclaré par ton code, une enveloppe fil `[u8 idSchéma][charge]`, et un encodage/décodage **transparent** — `app.on`/`app.serve` reçoivent le message décodé comme s'il était arrivé en JSON, sans rien savoir de la façon dont il a voyagé.

#### Déclarer un schéma — `app.schema(nom, champs)`

```js
import { mjsWs, list, bits } from 'modularjs-framework/ws'

const app = mjsWs({ codec: 'auto' })

app.schema('pos', { x: 'i16', y: 'i16' })
app.schema('etat', {
  hp:      'u8',
  pseudo:  'str8',                          // préfixe de longueur EN OCTETS UTF-8 (u8, max 255)
  tags:    list('str8'),                    // tableau homogène, compteur u16
  drapeau: bits(['vivant', 'arme', 'vip']),  // jusqu'à 8 booléens dans 1 octet — sous-objet en sortie
})
```

Même déclaration, en `ws.server.mjs` (dialecte Civet des composants, §6.1/§13) :

```civet
// ws.server.mjs
export default {
  codec: 'auto'

  setup: (app)->
    app.schema 'pos', { x: 'i16', y: 'i16' }
    app.schema 'etat', {
      hp:     'u8'
      pseudo: 'str8'
    }

    app.on 'pos', (p, client)-> app.broadcast('pos', p, { except: client })
}
```

`champs` est un objet **ordonné** `{ nom: type, ... }` — l'**ordre** des clés fait foi sur le fil (jamais recalculé). Types scalaires : `u8`/`i8`/`u16`/`i16`/`u32`/`i32`/`f32`/`f64` (numériques), `bool` (1 octet), `str8`/`str16` (chaîne UTF-8, préfixe de longueur u8/u16). `list(type)` (compteur u16 puis `type` répété — v1 : scalaire/chaîne **seulement**, pas de sous-schéma imbriqué) et `bits([noms])` (≤ 8 booléens, décodés en `{ nom: bool, ... }`) complètent la liste. Un id **u8** est attribué à chaque schéma **dans l'ordre de déclaration** (0, 1, 2…) — c'est cet id qui ouvre chaque trame binaire.

**Garde ajout-seul** : un schéma déjà déclaré est **immuable** (mêmes champs, mêmes types, même ordre). Le ré-affirmer à l'identique est un no-op silencieux (un entry rechargé à chaud, §6.5, peut ré-exécuter ses `app.schema(...)` sans planter) ; le ré-affirmer avec une forme **différente** lève une erreur claire au boot — fais évoluer ton protocole en déclarant un schéma à un **nom neuf**, jamais en mutant un schéma existant.

#### Les trois modes — `codec`

| `codec` | Comportement |
|---|---|
| `'auto'` (défaut) | Un type applicatif **avec** schéma déclaré part en binaire ; le reste (types non déclarés) part en JSON, comme avant `µschema`. |
| `'binary'` | **strict** — envoyer un type applicatif **sans** schéma déclaré **lève** immédiatement (`app.send`/`sendUser`/`broadcast`/`room().send`, erreur de dev claire, **avant** même de chercher un destinataire) ; recevoir une trame **texte** applicative (hors préfixe `µ:`) est **rejeté** (compté `app.stats().messages.texteRejete`, `µ:error` throttlé). |
| `'json'` | Coupe-circuit débogage — **tout** part en JSON, même un type schématisé (utile pour inspecter le trafic en clair pendant qu'on développe). |

Les trames de **contrôle** `µ:` (`µ:hello`, `µ:welcome`, `µ:ping`…) restent **toujours** en JSON, quel que soit `codec` — le bootstrap du hello ne peut pas dépendre d'un schéma pas encore synchronisé. Sans **aucun** schéma déclaré, la voie JSON reste **byte-identique** à avant `µschema` — activer `codec` ne change rien tant que rien n'est schématisé.

#### Synchronisation à chaud — hash + `µ:schema`

Chaque `µ:welcome` porte un `schemaHash` (dès qu'au moins un schéma est déclaré) — un hash **stable** du registre (noms + types + ordre, FNV-1a). Si le client annonce, dans son `µ:hello`, un `schemaHash` **différent** du serveur, celui-ci pousse **immédiatement après le welcome** une trame `µ:schema { version, definitions }` : `definitions` est la sérialisation JSON-safe complète du registre (`list()`/`bits()` sont déjà des objets inertes, jamais des fonctions embarquées) — de quoi régénérer un miroir local à la volée, sans redémarrage ni redéploiement du client. (Le décodage `µ:schema` côté client arrive avec le runtime, cf. [20 · Temps réel](20-temps-reel.md).)

#### Ce qui n'encode **jamais** en binaire

Les deltas de `app.stream()` (§5) restent inchangés — un flux n'est jamais schématisable (sa forme `{ t, seq, p }` porte un numéro de séquence que `µschema` ne connaît pas). Un `app.room(nom).send(type, p)` encode en binaire exactement comme `app.send`/`app.broadcast` dès que `type` a un schéma — c'est le **même** choix, au **même** endroit (`sendRaw`), pour tous les chemins d'envoi.

#### Id de schéma inconnu à la réception

Une trame binaire dont l'octet d'id ne correspond à **aucun** schéma connu (registre local en retard) est comptée `app.stats().messages.binaireIgnorees` ; en mode `'binary'`, elle déclenche en plus un `µ:error` throttlé (1/s) — en `'auto'`/`'json'`, silence volontaire (pas de canal de reconnaissance gratuit pour qui sonderait le protocole avant le hello).

#### Limite — pub/sub seulement, jamais une requête

L'enveloppe binaire `[u8 idSchéma][charge]` ne porte **aucun** id de corrélation : un frame avec `id` (`sock.request()`, accusés de réception) reste **toujours** en JSON côté client, quel que soit le schéma du type — µschema est un mécanisme **pub**/**sub**, jamais un transport de requêtes (cf. le tableau des 3 modes ci-dessus). Conséquence en `codec: 'binary'` **strict** : ce mode rejette aussi toute trame **texte** applicative hors `µ:`, id ou pas — une `sock.request()` vers un type sans schéma y expire donc systématiquement, sans jamais recevoir de `µ:ack` (cas réel : [24 · MJS-Server §14](24-mjs-server.md#limites), dont l'API cliente entière repose sur des requêtes id-bearing).

Chiffres (30 entités à 15 Hz, 2 clients) : des messages `µschema` binaires par entité coûtent ≈ 0,30× le volume JSON équivalent — tableau complet en [24 · MJS-Server §14](24-mjs-server.md#limites).

### 3.2 µschema-HTTP — AJAX binaire (opt-in)

Le binaire à schéma n'est pas réservé au WebSocket : `µ.ajax.binary(url, options)` (runtime `mjs_ajax.ts`) fait voyager une requête/réponse AJAX en octets µschema au lieu de JSON — **opt-in par point d'accès** (`options.schema`), jamais un défaut global. Sans cette option, `µ.ajax.get/post/put/patch/delete` restent **byte-identiques** à toujours : le JSON reste **recommandé par défaut**, parce que ton back est un monde ouvert (n'importe quel client, n'importe quel outil de debug HTTP doit pouvoir le lire) — µschema-HTTP cible les points d'accès **chauds**, à deux bouts maison (ton client MJS, ton back qui veut bien s'aligner sur le format).

```js
µ.schema('demandeProfil', { id: 'u32' })
µ.schema('profil', { id: 'u32', pseudo: 'str8', score: 'u16' })

µ.ajax.binary('/api/profil', {
  method:  'POST',
  schema:  'demandeProfil',     // nom déclaré — active le binaire pour CET appel, requête ET réponse
  data:    { id: 42 },
  success: (profil) => console.log(profil.pseudo, profil.score),
  error:   (err) => µ.error(err),
})
```

| Option | Rôle |
|---|---|
| `schema` | nom de schéma déclaré — **obligatoire** pour activer le binaire ; absent = comportement JSON inchangé |
| `codec` | registre explicite (sinon le singleton du module `'schema'`, rempli par `µ.schema(...)`) |
| `schemaUrl` | endpoint de rafraîchissement explicite (sinon `url` + `schema=1` en paramètre, cf. plus bas) |
| `data`/`method`/`success`/`error`/`always`/`timeout`/`signal` | identiques à `_request` — mêmes règles que le reste de `µ.ajax` |

Forme choisie plutôt qu'un paramètre de plus sur `µ.ajax.get/post/put/patch/delete` : ces cinq fonctions sont déjà **positionnelles** (6 à 7 paramètres selon le verbe) — y ajouter `schema` aurait été la forme la **plus** invasive possible, avec une arité différente par verbe. `µ.ajax.binary(url, options)` garde `url` en 1er paramètre (cohérent avec les cinq autres) et fait voyager tout le reste dans un objet unique — zéro paramètre ajouté aux fonctions existantes, zéro site d'appel existant à toucher.

#### Le contrat fil — 8 octets de version, puis l'enveloppe habituelle

```
[8 octets ASCII — hash hex du registre][u8 idSchéma][charge µschema, cf. §3.1]
```

Les 8 premiers octets sont `hashRegistre()` (FNV-1a, **toujours** 8 caractères hexadécimaux, cf. §3.1) écrits **tels quels** en ASCII — pas un entier packé : lisible dans un dump hexa, relisible dans n'importe quel langage sans le moindre calcul bit à bit (`bytes[0,8]` suffit). Le reste de la trame est **exactement** `[u8 idSchéma][charge]`, le même format que le binaire WebSocket (§3.1) — la version est un préfixe **additionnel**, jamais une réécriture.

#### Mise à jour à chaud

La **réponse** porte la version du registre **serveur**. Si elle diffère de celle du registre **client** :

1. la requête d'origine **n'échoue pas** — elle patiente ;
2. un `GET` est lancé en arrière-plan sur l'endpoint schéma (`options.schemaUrl`, ou par défaut la même URL + `schema=1` en paramètre) — réponse JSON attendue = **exactement** la forme de `serialiserDefinitions()` (§3.1, `{ hash, schemas: [...] }`, la **même** que la trame `µ:schema` du WebSocket) ;
3. le registre client est rechargé (remplace le singleton du module `'schema'` en place si `options.codec` n'a pas été fourni) ;
4. la charge **déjà reçue** est re-décodée avec le registre frais — un seul aller-retour de rafraîchissement, jamais de boucle : un second désaccord après rafraîchissement est une vraie erreur, routée vers `options.error`.

#### Dépendance au module runtime `'schema'`

µschema-HTTP réutilise le codec du module `'schema'` (`mjs_schema.ts`, déjà nécessaire pour `µ.schema()`/`µ.list()`/`µ.bits()`) — il n'est **jamais** réimplémenté une 3e fois dans `mjs_ajax.ts`. Si `'schema'` n'est pas dans ta sélection `runtime` (`mjs.config.json`) au moment où `µ.ajax.binary({ schema: '...' })` est appelé, l'appel échoue proprement (`options.error`, message explicite) **avant tout `fetch()`** — jamais un `ReferenceError` cru, jamais une requête réseau pour rien.

#### Recette back — Rails, sans dépendance (`String#pack`/`#unpack`)

Aucune gem : juste `Array#pack`/`String#unpack1` en little-endian, miroir exact des types de `src/schema/core.ts`. Les **deux** côtés doivent déclarer les **mêmes** schémas dans le **même** ordre (pas de fichier partagé possible entre Ruby et JS) — recopie manuelle, comme pour tout accord de protocole inter-langages (cf. les recettes JWT, §7.6). ⚠️ l'algorithme de hash suppose des noms de schéma/champ **ASCII** (le cas normal) — `charCodeAt` (JS, unités UTF-16) et `each_byte` (Ruby, octets UTF-8) ne peuvent diverger **que** sur des noms non-ASCII, jamais sur les **valeurs** des champs eux-mêmes.

```ruby
# app/lib/mj_schema_http.rb — recette : les 11 types scalaires sont couverts, list()/bits() restent
# à écrire à la main sur le MÊME principe (cf. src/schema/core.ts) si tu en as besoin
module MjSchemaHttp
  # id u8 = position dans SCHEMAS, DANS L'ORDRE — miroir de la déclaration cliente
  # (µ.schema('demandeProfil', ...) PUIS µ.schema('profil', ...))
  SCHEMAS = [
    ['demandeProfil', { id: 'u32' }],
    ['profil',         { id: 'u32', pseudo: 'str8', score: 'u16' }],
  ].freeze

  def self.decrire_type(t)
    return t if t.is_a?(String)
    t[:kind] == 'list' ? "list(#{t[:of]})" : "bits(#{t[:noms].join('+')})"
  end

  def self.fnv1a(chaine)
    h = 0x811c9dc5
    chaine.each_byte { |o| h ^= o; h = (h * 0x01000193) & 0xffffffff }
    h.to_s(16).rjust(8, '0')
  end

  def self.hash_registre(schemas = SCHEMAS)
    parties = schemas.map { |nom, champs| "#{nom}:#{champs.map { |c, t| "#{c}=#{decrire_type(t)}" }.join(',')}" }
    fnv1a(parties.join('|'))
  end

  VERSION = hash_registre.freeze

  def self.lire_champ(bytes, offset, type)
    case type
    when 'u8'   then [bytes.getbyte(offset), offset + 1]
    when 'i8'   then [bytes.byteslice(offset, 1).unpack1('c'), offset + 1]
    when 'bool' then [bytes.getbyte(offset) != 0, offset + 1]
    when 'u16'  then [bytes.byteslice(offset, 2).unpack1('v'), offset + 2]
    when 'i16'  then [bytes.byteslice(offset, 2).unpack1('s<'), offset + 2]
    when 'u32'  then [bytes.byteslice(offset, 4).unpack1('V'), offset + 4]
    when 'i32'  then [bytes.byteslice(offset, 4).unpack1('l<'), offset + 4]
    when 'f32'  then [bytes.byteslice(offset, 4).unpack1('e'), offset + 4]
    when 'f64'  then [bytes.byteslice(offset, 8).unpack1('E'), offset + 8]
    when 'str8'
      len = bytes.getbyte(offset)
      [bytes.byteslice(offset + 1, len).force_encoding('UTF-8'), offset + 1 + len]
    when 'str16'
      len = bytes.byteslice(offset, 2).unpack1('v')
      [bytes.byteslice(offset + 2, len).force_encoding('UTF-8'), offset + 2 + len]
    else raise "[MjSchemaHttp] type de champ non géré : #{type} (list()/bits() : même principe, cf. src/schema/core.ts)"
    end
  end

  def self.decoder(bytes, schemas = SCHEMAS)
    version     = bytes.byteslice(0, 8)
    id          = bytes.getbyte(8)
    nom, champs = schemas[id]
    raise "[MjSchemaHttp] id de schéma inconnu (#{id})" if nom.nil?
    offset = 9
    objet  = {}
    champs.each { |c, t| valeur, offset = lire_champ(bytes, offset, t); objet[c] = valeur }
    { version: version, nom: nom, objet: objet }
  end

  def self.ecrire_champ(valeur, type)
    case type
    when 'u8'    then [valeur & 0xff].pack('C')
    when 'i8'    then [valeur].pack('c')
    when 'bool'  then [valeur ? 1 : 0].pack('C')
    when 'u16'   then [valeur].pack('v')
    when 'i16'   then [valeur].pack('s<')
    when 'u32'   then [valeur].pack('V')
    when 'i32'   then [valeur].pack('l<')
    when 'f32'   then [valeur].pack('e')
    when 'f64'   then [valeur].pack('E')
    when 'str8'  then o = valeur.to_s.b; [o.bytesize].pack('C') + o
    when 'str16' then o = valeur.to_s.b; [o.bytesize].pack('v') + o
    else raise "[MjSchemaHttp] type de champ non géré : #{type} (list()/bits() : même principe, cf. src/schema/core.ts)"
    end
  end

  def self.encoder(nom, objet, schemas = SCHEMAS, version = VERSION)
    id = schemas.index { |n, _| n == nom }
    raise "[MjSchemaHttp] schéma inconnu '#{nom}'" if id.nil?
    _, champs = schemas[id]
    corps = champs.map { |c, t| ecrire_champ(objet[c], t) }.join
    [version].pack('a8') + [id].pack('C') + corps
  end

  def self.definitions_json(schemas = SCHEMAS, version = VERSION)
    { hash: version, schemas: schemas.map { |nom, champs| { nom: nom, champs: champs.to_a } } }
  end
end
```

Utilisation dans un contrôleur :

```ruby
class ProfilsController < ApplicationController
  def show
    requete = MjSchemaHttp.decoder(request.body.read.b)
    profil  = Profil.find(requete[:objet][:id])
    corps   = MjSchemaHttp.encoder('profil', { id: profil.id, pseudo: profil.pseudo, score: profil.score })
    render body: corps, content_type: 'application/octet-stream'
  end

  # GET /api/profil?schema=1 — endpoint de rafraîchissement (convention par défaut du client)
  def schema
    render json: MjSchemaHttp.definitions_json
  end
end
```

**Honnête** : c'est nettement plus lourd qu'un `render json: ...`. La recette ci-dessus exige de garder les déclarations Ruby/JS en accord manuel, sans le filet des gardes **ajout-seul** de `defSchema` (§3.1) côté Ruby — une déclaration qui diverge silencieusement (ordre, type) produit un hash différent, jamais une erreur explicite côté Rails. Réserve µschema-HTTP à de vrais points chauds (payload répété à haute fréquence, ex. polling serré) où le gain d'octets/CPU JSON justifie l'entretien — le JSON classique (`µ.ajax.get/post`) reste le choix par défaut recommandé pour tout le reste.

### 3.3 Vérification d'origine

Absente (défaut), aucune connexion n'est refusée pour son origine — comportement historique **strict**, opt-in. Posée, `verifyOrigin` contrôle **chaque connexion entrante à l'admission**, **avant** le `µ:hello` (pas de `µ:denied`, une connexion refusée n'a même pas eu l'occasion de dire bonjour) :

- **Forme tableau** — allowlist stricte d'origines exactes (schéma+hôte+port, ex. `'https://exemple.com'`), comparaison **insensible à la casse** (compilée en `Set` minuscule une seule fois, jamais recalculée par connexion). Un `Origin` absent ou non listé est refusé.
- **Forme fonction** — contrôle total : `(origin, remote) => boolean`, reçoit l'`Origin` brut (`string | undefined`) et le `MjsWsRemoteInfo` de la connexion (`{origin?, headers?, address?}`), retourne `true` pour admettre. Une exception levée = refus (**fail-closed**).

Refus = fermeture immédiate, code **1008** (« Policy Violation », définitif — contrairement au **1013** des plafonds de connexions §3, ce n'est pas transitoire : réessayer avec la même origine échouera toujours). Compteur dédié `stats.connexions.refuseesOrigine` (cf. §10).

```js
const app = mjsWs({
  verifyOrigin: ['https://mon-site.example', 'https://admin.mon-site.example'],
})
```

Avec `mjs ws` (§6), se configure aussi dans `mjs.config.json` (`ws.verifyOrigin`, **seule** la forme tableau y est représentable) ou dans l'entry (`verifyOrigin`, tableau OU fonction) — même règle que `heartbeat`/`limits` : si les **deux** sont posés, l'entry prime EN **bloc** (cf. §6.4).

> ⚠️ **Obligatoire avec l'authentification par cookie.** Si `opts.auth` rejoue le cookie de la requête d'upgrade (patron « `mjsWs` rejoue le cookie lui-même », §7.12) — le navigateur le joint tout seul, page tierce comprise — `verifyOrigin` n'est plus une option. Avec un jeton explicite (`hello.auth.token`, §7.6), il reste facultatif : une page tierce ne peut pas lire ce jeton.

---

<a id="salons-presence"></a>
## 4. Salons & présence

Un **salon** est un groupe nommé de connexions : le client demande à entrer (`sock.room('partie-42')` → `µ:join`), le serveur tient le registre, et l'application peut diffuser **aux seuls membres**. La **présence** est la liste réactive « qui est là » — globale (tout le serveur) ou par salon — que le client consomme telle quelle via `sock.presence()` (voir [20 · Temps réel §5](20-temps-reel.md)).

```js
const app = mjsWs({
  auth:  (hello) => ({ id: hello.auth.userId, pseudo: hello.auth.pseudo }),
  rooms: {
    join: async (room, client) => {                    // garde d'admission (async autorisée)
      if (room.startsWith('privé-')) return estInvité(client.identity.id, room)
      return true                                      // false ou throw → refus, µ:error côté client
    },
    meta: (client) => ({ pseudo: client.identity.pseudo }),   // ce que les autres voient de lui
  },
})

const partie = app.room('partie-42')
partie.send('partie-42/coup', { case: 12 })            // diffusion aux membres seulement
partie.send('partie-42/coup', { case: 12 }, { except: joueur })
partie.size                                            // nombre de connexions membres
partie.has(client)                                     // ce client est-il membre ?
partie.kick(client, 'triche')                          // expulsion du salon — la connexion reste ouverte

app.sendTo('partie-42', 'coup', { case: 12 })          // sucre : équivaut à la ligne app.room(...).send(...) ci-dessus
```

| `app.room(nom)` | Rôle |
|---|---|
| `.send(type, p, { except? })` | Diffuse `{t: type, p}` aux membres. `type` est envoyé **tel quel** — pour viser les écouteurs scopés du client (`salon.on('coup')`), préfixe toi-même (`'partie-42/coup'`) : le préfixe de salon est une convention **cliente**, le serveur n'ajoute rien. |
| `.clients` / `.size` | Les connexions membres / leur nombre. |
| `.has(client)` | Appartenance d'une connexion. |
| `.kick(clientOuId, raison?)` | Expulse du salon : le visé reçoit **un unique** `µ:left { room, reason }` (→ son callback `onLeft(raison)`, purge locale du salon), les abonnés-présence reçoivent le delta `leave`. La **connexion reste ouverte** — c'est une expulsion de salon, pas un `µ:bye`. Par chaîne : id de connexion **ou** id d'utilisateur (`identity.id` — expulse alors tous ses onglets du salon). |

**Raccourci `app.sendTo(salon, type, p)`** — sucre pour `app.room(salon).send(salon + '/' + type, p)` : évite la double mention du nom de salon pour un envoi ponctuel où tu n'as pas besoin de garder la référence (pas d'`except`, pas de `.size`/`.kick`/`.has` ensuite — pour ça, garde `app.room(salon)`).

Ce qui est géré sans que tu t'en occupes :

- **Adhésions** : `µ:join` en double = silencieux (déjà membre) ; `µ:leave` d'un non-membre = silencieux ; une déconnexion quitte tous ses salons proprement.
- **Refus** : garde `join` qui rend `false` ou lève → le client n'entre pas et reçoit un `µ:error` (throttlé à un par seconde — une boucle de re-tentatives ne se fait pas mitrailler en retour).
- **Présence globale** : un client authentifié « apparaît » aux abonnés dès son `µ:welcome` et « disparaît » à sa déconnexion — indépendamment de tout salon.
- **Agrégation multi-onglets** : la clé d'un pair de présence est `client.identity.id` (repli : id de connexion). Un même utilisateur ouvert dans **deux onglets = un seul pair** — le delta `join` ne part qu'à l'ouverture du **premier**, le delta `leave` qu'à la fermeture du **dernier**, et sa méta est celle de la connexion la plus récente. Personne ne « clignote » parce qu'il ouvre un deuxième onglet.
- **Abonné ≠ membre** : `µ:sub-presence` d'un salon renseigne sans faire entrer — on peut afficher « qui joue » sans jouer.

### 4.1 Salon avec historique — `room(x).history(n)`

Le cas revient partout : un salon de chat (ou un fil de commentaires) où un **retardataire** qui rejoint veut voir les derniers échanges, pas repartir de zéro. `room(x).history(n)` adosse au salon un petit **journal borné** des `n` derniers `send()` — opt-in, coût nul tant qu'il n'est pas appelé.

```civet
salon = app.room('chat-42')
salon.history(50)                       // garde les 50 derniers messages — appel UNIQUE, avant ou après le 1er membre

app.on 'chat', (p, client)->
  salon.send('chat-42/message', { pseudo: client.identity.pseudo, texte: p.texte })
```

Dès cet appel, chaque `salon.send(type, p)` qui suit est **aussi** journalisé (anneau : au-delà de `n`, les plus vieux tombent). Un **nouvel arrivant** (`µ:join` accepté) reçoit automatiquement les `n` derniers messages, **avant** tout trafic live — rien à coder côté client, `sock.room('chat-42').on('message', cb)` les reçoit exactement comme un message live.

| `room(nom).history(n)` | Effet |
|---|---|
| `n > 0` | Active (ou redimensionne) le journal à `n` entrées. Rétrécir retaille tout de suite (les plus vieilles tombent) ; agrandir garde le contenu existant. |
| `n === 0` (ou tout `n` ≤ 0) | Purge et désactive — retour au comportement sans historique. |

**Le choix : rejeu transparent, pas de trame dédiée.** Au join, le serveur ne pousse pas un message spécial du genre `µ:history { messages: [...] }` — il **rejoue** chaque entrée du journal **exactement** comme au moment de son `send()` d'origine (`{t: type, p}`, aucune enveloppe). Le nouvel arrivant ne voit donc **aucune différence** entre un message d'historique et un message live : même écouteur (`sock.on(type)`), même forme, zéro code client à écrire pour gérer un rattrapage. Le prix : pas de marqueur « ceci est du passé » — une appli qui en a besoin l'ajoute elle-même à sa charge (ex. un champ `at: Date.now()` posé à l'envoi).

À savoir :

- **Opt-in par salon, pas par défaut** : un salon jamais configuré avec `.history()` se comporte **exactement** comme avant cette fonctionnalité (aucun journal, aucun coût, `send()` inchangé).
- **Un membre déjà présent ne reçoit jamais de rejeu** — seul le nouvel arrivant (même dédup que `µ:join`, ci-dessus).
- **Le journal disparaît avec le salon vide** : plus aucun membre → purge automatique, même sort que la présence de salon. Un salon qui repeuple après ça repart **sans** historique tant que `.history(n)` n'est pas rappelé.
- **Indépendant du rattrapage des flux** (`µ:resync`, §5 ci-dessous) — deux mécanismes séparés, l'un pour un salon événementiel (`room().send`), l'autre pour un état (`app.stream`) ; rien ne les mélange.
- **Purement local** : comme `stream().destroy()` (§5), l'historique d'un salon n'est pas répliqué entre plusieurs process (§9) — chaque process garde le sien.

---

<a id="flux"></a>
## 5. Les flux qui se rattrapent — `app.stream`

Côté client, `sock.stream('ennemis')` est un store réactif alimenté par deltas numérotés ([20 · Temps réel §4](20-temps-reel.md)). Côté serveur, `app.stream('ennemis')` est la **source** de ce flux : un état courant (clé → valeur) dont chaque mutation est **numérotée** (`seq` strictement croissant, propre au flux), **diffusée** aux abonnés et **journalisée**.

```js
const ennemis = app.stream('ennemis', { journal: 200 })   // garde les 200 derniers deltas (défaut)

ennemis.add('e1', { x: 10, y: 20 })      // delta {op:'add'} → seq++, diffusé + au journal
ennemis.update('e1', { x: 11 })          // fusion 1 niveau (y conservé), comme côté client
ennemis.remove('e1')
ennemis.reset({ e9: { x: 0, y: 0 } })    // remplacement COMPLET — nouvelle époque, journal vidé
ennemis.size                             // nombre d'éléments courants
ennemis.snapshot()                       // photo { clé → valeur } de l'état courant
ennemis.destroy()                        // retire le flux du registre — plus JAMAIS itéré (cf. note ci-dessous)
```

**`destroy()` — flux dynamiques (un par partie, par salon, par session…) :** un `app.stream(nom)` déclaré et jamais détruit reste en mémoire pour toujours (journal, abonnés, compteur `seq`) — pour un nom de flux **fixe** ce n'est jamais un problème, mais pour un flux créé **à la volée par identifiant** (`app.stream('partie-' + id)`), sans `destroy()` à la fin de sa vie utile, le registre grossit sans borne. Détruit, un flux redevient **exactement** comme s'il n'avait jamais existé : un `µ:sub-stream`/`µ:resync` ultérieur sur ce nom retombe sur le repli honnête (`reset` vide + `warn`). `destroy()` n'envoie rien aux abonnés courants — préviens-les toi-même avant si besoin (dernier message applicatif). Purement **local** : en cluster (§9), les autres process gardent leur propre état pour ce nom tant qu'ils ne le détruisent pas eux-mêmes chacun de leur côté.

**Le principe, simplement :** le serveur numérote chaque changement (1, 2, 3…) et garde les `journal` derniers dans un carnet. Un client qui s'abonne (`µ:sub-stream`) reçoit d'abord une **photo complète** (`reset` au `seq` courant). Un client qui **décroche puis revient** annonce le dernier numéro qu'il a vu (`µ:resync { from }`) : si tout ce qu'il a raté est encore dans le carnet, le serveur **rejoue juste ces deltas-là**, dans l'ordre, **avec leurs numéros d'origine** — quelques dizaines d'octets au lieu d'une photo. S'il a raté plus que le carnet n'en garde, photo complète. S'il n'a rien raté, **rien** — pas un octet.

| Situation au `µ:resync { from }` | Réponse du serveur |
|---|---|
| Tous les deltas `from+1 … seq` sont au journal | **Rejeu** de ces deltas, seq d'origine (le client dédoublonne déjà tout `seq` ≤ dernier vu — rejouer avec les numéros d'origine est ce qui rend l'opération sûre même en cas de doublon). |
| Trou plus large que le journal, ou `reset` survenu entre-temps | `reset` complet au `seq` courant. |
| `from` = `seq` courant | Rien — le client est à jour. |
| `from` > `seq` courant (serveur redémarré, compteur reparti) | `reset` complet — le client raccroche à la nouvelle époque. |

**`reset()` = nouvelle époque.** Le remplacement complet vide le journal : aucun rejeu ne traversera jamais un `reset` (les deltas d'avant décrivent un monde qui n'existe plus). Le client, lui, accepte un `reset` à n'importe quel `seq` — c'est le point de re-synchronisation universel.

À savoir :

- Le rattrapage est **entièrement automatique** : le client détecte les trous en cours de flux et redemande, et après une reconnexion il envoie `µ:resync { from: dernierSeq }` de lui-même pour tout flux déjà entamé. Rien à coder, d'aucun côté.
- Les abonnements sont nettoyés à la déconnexion — pas de fantômes qui gonflent la diffusion.
- Un `µ:sub-stream` vers un flux **jamais déclaré** par l'application répond honnêtement un `reset` vide (`seq: 0`) + un `warn` dans `onLog`, sans créer d'abonnement : déclare tes flux côté serveur (`app.stream(nom)`), c'est lui la source.
- `journal` se règle par flux : gros trafic + clients qui décrochent souvent → carnet plus grand ; flux paisible → 200 par défaut suffit largement.

**Le nom d'un flux n'est pas un secret** : `app.stream('game-42')` reste lisible par n'importe quel client authentifié qui devine (ou connaît) ce nom — `µ:sub-stream` n'exige par défaut aucune appartenance à un salon. Pour un flux privé, deux gardes combinables (§4) : `canSubscribe(client, name)` (fonction sync ou async, refus sur `false`/throw, MÊME contrat que `rooms.join`) ou le sucre `room: 'nom'` (exige l'appartenance au salon du même nom).

```js
app.stream('partie-42', { canSubscribe: (client) => app.room('partie-42').has(client) })   // ou, plus court : { room: 'partie-42' }
```

---

<a id="mjs-ws"></a>
## 6. Lancer le serveur — `mjs ws`

Le module `mjsWs` (§1-§5) est une **librairie** — il faut un peu de code pour le brancher et l'écouter. La commande `mjs ws` évite d'écrire ce code toi-même : elle charge un **fichier d'entry** (le tien), y branche les protections/logs/rechargement, et démarre.

```bash
mjs ws                        # ws.server.mjs ou ws.js (résolution complète : §6.2), port 4000 par défaut
mjs ws --entry serveur/temps-reel.js --port 4010
mjs ws --root chemin/vers/le/projet
```

### 6.1 Le fichier d'entry

Un module qui exporte, **en défaut**, un **objet** — les mêmes options que `mjsWs()` (§1), moins `transport`/`port`/`host`/`onLog` (réservées au CLI, cf. §6.3 — présentes quand même dans l'entry : ⚠️ un avertissement les signale, puis elles sont ignorées), plus une fonction `setup(app)` optionnelle (sync ou async), appelée juste après la création de l'app et juste **avant** `listen()` : c'est là que tu déclares `serve()`/`on()`/`stream()`.

**Format recommandé — `ws.server.mjs`** (ou `server/ws.server.mjs`) : compilé avec le **même dialecte Civet** que le `<script>` de tes composants — assignations nues auto-déclarées, interpolation Coffee `"…#{x}…"`, `isnt`, flèches `->`, hash sans accolades. Le JS classique (`ws.js`/`ws.mjs`/`ws.cjs`, importé tel quel, sans aucune compilation) reste bien sûr accepté ; le Civet **brut** (`ws.civet`, sans les pré-passes ci-dessous) reste une variante documentée (§13).

Exemple minimal complet — auth, un salon, un flux, et `setup`, en `ws.server.mjs` :

```civet
// ws.server.mjs — fichier d'entry du serveur temps réel (mjs ws), dialecte Civet des composants
@import soldeMax 'limites.civet'

export default {
  // auth/welcome/rooms/heartbeat/limits : mêmes options que mjsWs() (§1).
  auth: (hello)->
    return false unless hello.auth?.token is process.env.SECRET
    { id: hello.auth.userId, pseudo: hello.auth.pseudo }

  welcome: (client)-> { serverTime: Date.now(), userId: client.identity.id }

  rooms: {
    join: (room, client)-> room isnt 'vip' or client.identity.admin
    meta: (client)-> { pseudo: client.identity.pseudo }
  }

  setup: (app)->
    app.serve 'achat', (p, client)->
      throw new Error('solde insuffisant') if p.prix > soldeMax
      { solde: soldeMax - p.prix }

    app.on 'chat', (p, client)-> app.broadcast('chat', p, { except: client })

    ennemis = app.stream('ennemis')
    ennemis.add('e1', { x: 10, y: 20 })
}
```

`@import soldeMax 'limites.civet'` importe une constante d'un fichier voisin (`limites.civet` à côté de l'entry) — la SEULE directive qui a un sens dans un fichier serveur, détaillée en §13.2 : un chemin relatif, un paquet npm, ou `node:*`, jamais autre chose.

> **Pourquoi un format dédié — les 3 pièges du Civet brut.** Un `.civet` ordinaire (§13) est compilé par le compilateur Civet **seul**, sans les pré-passes que le framework applique au `<script>` de tes composants — trois habitudes prises en composant y deviennent des pièges **silencieux** :
> 1. **Assignation nue** — `compteur = 0` ne déclare rien en Civet natif (seul `compteur := 0` déclare) → `ReferenceError: compteur is not defined` au chargement, à toute profondeur (top-level ou imbriquée dans une fonction).
> 2. **Interpolation Coffee** — `"salut-#{nom}"` reste un **littéral** : la chaîne envoyée contient `#{nom}` mot pour mot, jamais la valeur de `nom`.
> 3. **`isnt`** — Civet ne le connaît pas nativement : `a isnt b` se lit comme l'appel `a(isnt(b))` → crash.
>
> `ws.server.mjs` applique exactement les mêmes pré-passes que tes composants (assignations auto-déclarées, interpolation traduite en template literal, `isnt` traduit en `!==`…) — le code s'y comporte comme dans un `<script>`, sans surprise.

Un `.server.mjs` qui contient du **markup** de composant (`<template>`, `<style>`, une balise HTML en tête de fichier) est refusé avec une erreur claire dès la lecture — ce n'est pas un composant, juste du Civet/JS.

Si le default export est absent ou n'est pas un objet, `mjs ws` refuse de démarrer avec une erreur claire. Si **aucun** fichier d'entry n'est trouvé (cf. résolution ci-dessous), l'erreur imprime directement un squelette minimal à copier-coller pour démarrer.

### 6.2 Résolution de l'entry

| Source | Priorité |
|---|---|
| `--entry <chemin>` | 1 — toujours respecté tel quel ; erreur immédiate si le fichier n'existe pas (aucun repli sur la suite) |
| `ws.entry` (mjs.config.json) | 2 — même règle : erreur immédiate si absent |
| `ws.server.mjs` (racine du projet) | 3 — format **recommandé**, cf. §6.1 |
| `server/ws.server.mjs` | 4 |
| `ws.js` (racine du projet) | 5 |
| `ws.civet` (racine du projet) | 6 — cf. §13 « Écrire son fichier serveur — le dialecte de tes composants » |
| `server/ws.js` | 7 |
| `server/ws.civet` | 8 |

Les chemins sont relatifs à `--root` (défaut : le répertoire courant). Le premier trouvé dans cet ordre gagne : un `ws.server.mjs` prime donc **toujours** sur un `ws.js`/`ws.civet` du même dossier, eux-mêmes prioritaires sur tout ce qui vit dans `server/`. Un `--entry` pointant explicitement vers un `.server.mjs` (même hors des noms par défaut ci-dessus) suit exactement le même chemin de compilation.

### 6.3 Configuration — section `ws` de mjs.config.json

```json
{
  "ws": {
    "entry": "server/ws.server.mjs",
    "port": 4001,
    "host": "::",
    "heartbeat": 20000,
    "limits": { "rate": 60, "burst": 120 }
  }
}
```

| Clé | Type | Rôle |
|---|---|---|
| `entry` | chaîne | cf. §6.2 |
| `transport` | `'ws'` \| `'uws'` | cf. §12 « La façade transport » — une **instance** maison ne se met **que** dans l'entry (pas représentable en JSON), qui prime alors sur cette clé (cf. §6.4) |
| `port` | entier 1-65535 | port du serveur — priorité `--port` > `ws.port` > `4000` |
| `host` | chaîne | host du transport `ws` — défaut `127.0.0.1` (loopback, MÊME défaut que le pont §7) ; `--host ::` (ou `ws.host: "::"`) pour exposer sur toutes les interfaces |
| `codec` | `'auto'` \| `'binary'` \| `'json'` | cf. §3.1 « µschema » — définissable **ici** **ou** dans l'entry (cf. §6.4). **Pas** de pendant pour `schemas` : `list()`/`bits()` ne sont pas représentables en JSON, réservé à l'entry. |
| `heartbeat` | entier > 0 (ms) | cf. §1 — définissable **ici** **ou** dans l'entry (cf. §6.4) |
| `limits` | objet `{ rate?, burst?, kickAfter?, maxPayload?, maxBuffered? }` (entiers > 0) | cf. §3 — définissable **ici** **ou** dans l'entry (cf. §6.4) |
| `resume` | `true`, `false` ou objet `{ grace?, maxBuffered?, maxBytes? }` (entiers > 0) | reprise de session, cf. §8 — définissable **ici** **ou** dans l'entry (cf. §6.4). Actif : la bannière de `mjs ws` affiche « reprise de session : 30 s ». |
| `sessionExclusive` | booléen \| `'replace'` \| `'refuse'` | session exclusive par identité, **deux** modes, cf. §8.5 — définissable **ici** **ou** dans l'entry (cf. §6.4). |
| `verifyOrigin` | tableau de chaînes non vide | allowlist stricte d'origines exactes, cf. §1/§3.3 « Vérification d'origine » — **seule** la forme tableau est représentable en JSON (la forme fonction reste réservée à l'entry) — définissable **ici** **ou** dans l'entry (cf. §6.4). |

Validation stricte, comme le reste de `mjs.config.json` : une clé inconnue (dans `ws`, `ws.limits` ou `ws.resume`) lève une erreur avec une suggestion orthographique sur les fautes de frappe ; un type ou une plage invalide lève immédiatement, sans jamais démarrer sur une valeur bancale.

### 6.4 Qui décide, en cas de doublon ?

- **Port** : `--port` > `ws.port` (config) > `4000`.
- **Host** : `--host` > `ws.host` (config) > `127.0.0.1` (défaut, loopback — MÊME règle que le pont §7). Qui veut exposer le serveur le dit explicitement avec `--host ::`.
- **Transport / codec / heartbeat / limits / resume / bridge / verifyOrigin** : définissables dans l'entry ET dans `ws.*` — s'ils sont posés **aux deux endroits**, l'entry prime EN **bloc** (le code de l'appli l'emporte sur la config globale) et un avertissement te le signale, pour ne jamais laisser un doublon passer inaperçu. Cas particulier de `transport` : la config ne peut exprimer qu'une **chaîne** (`'ws'`/`'uws'`, seule forme représentable en JSON) — une **instance** maison (§12) ne peut venir **que** de l'entry, qui prime alors systématiquement. Même limite pour `schemas` (§3.1) : `list()`/`bits()` ne sont pas représentables en JSON, réservé à l'entry (`app.schema(...)` dans `setup(app)`). Même limite pour `verifyOrigin` : la config ne peut exprimer qu'un **tableau** (allowlist), la forme fonction ne peut venir **que** de l'entry.

### 6.5 Rechargement à chaud

Dès qu'un fichier `.js`/`.mjs`/`.cjs`/`.json` change dans le **dossier** de l'entry, le serveur se recharge tout seul — pas besoin de le relancer à la main pendant que tu développes.

**Le principe, simplement :** à chaque changement détecté (fenêtre de 150 ms — plusieurs sauvegardes rapprochées ne déclenchent qu'UN seul rechargement), `mjs ws` réimporte l'entry **avant** de toucher au serveur en cours. Si le nouveau code a une erreur de syntaxe (ou lève à l'import), l'erreur est affichée et l'**ancien** serveur continue de tourner exactement comme avant — zéro coupure, aucune connexion perdue. C'est seulement si le nouveau code s'importe sans problème que l'ancien serveur s'arrête proprement (`µ:bye` à ses clients, cf. §2) et que le nouveau prend sa place, sur le même port.

À savoir :

- La surveillance porte sur le **dossier** de l'entry, À **plat** (pas les sous-dossiers) — et elle ne regarde que le dossier, pas les imports : un fichier `.js`/`.mjs`/`.cjs`/`.json` qui change dans ce dossier déclenche un rechargement même s'il n'a rien à voir avec l'entry.
- À l'inverse — limite **assumée** — un fichier importé **par** l'entry mais rangé EN **dehors** de son dossier n'est **pas** surveillé : garde ton entry et ses dépendances proches les unes des autres si tu comptes sur le rechargement à chaud.
- Le rechargement réimporte l'**entry** elle-même à chaque fois ; les imports internes DE l'entry (vers d'autres modules) suivent le cache habituel de Node — un module annexe importé par l'entry n'est vraiment rafraîchi que si l'entry elle-même est réimportée après son propre changement.

### 6.6 Arrêt propre

`Ctrl-C` (**sigint**) ou un **sigterm** envoyé au process : le serveur prévient tous ses clients (`µ:bye`), ferme proprement ses connexions puis son transport, et quitte.

### 6.7 Flags

| Flag | Rôle |
|---|---|
| `--entry <chemin>` | force le fichier d'entry (prioritaire sur tout, cf. §6.2) |
| `--port <n>` | force le port (prioritaire sur `ws.port`, cf. §6.4) |
| `--root <dir>` | racine du projet (défaut : répertoire courant) — l'entry et `ws.entry` s'y résolvent |

Un entry qui déclare `app.game(...)` (salle de partie) veut la commande **sœur** `mjs serveur` — **même** contrat, résolution d'entry et rechargement à chaud, mais construite via `mjsServer()` : cf. [24 · MJS-Server §2](24-mjs-server.md#demarrer).

---

<a id="pont"></a>
## 7. Le pont universel — n'importe quel back pousse du temps réel

Jusqu'ici, tout ce qui parle à `mjsWs` est un client `µ.socket` connecté en WebSocket. Mais la **logique** de ton application — commandes, paiements, notifications, tout ce qui décide **quoi** pousser — vit sans doute ailleurs : un contrôleur Rails, un script PHP, un worker Python, un autre service Node. Le **pont universel** évite de dupliquer cette logique ou de faire parler ton back en WebSocket : ton back garde SA logique telle quelle (Rails reste Rails, PHP reste PHP) et pousse du temps réel par un simple **POST HTTP signé** — un `curl`, une requête `net/http`, `requests`, peu importe le langage. En retour, `mjsWs` peut **prévenir** ton back par **webhooks** : un client se connecte, rejoint un salon, envoie un message — ton back le sait sans avoir à interroger `mjsWs` en boucle.

Le pont est un **second serveur HTTP**, embarqué dans le même process que `mjsWs`, sur un port **séparé** (par défaut le port du WebSocket + 1) et lié à `127.0.0.1` par défaut — c'est **ton** back qui l'appelle, pas Internet. Il ne dépend d'**aucun** paquet npm supplémentaire (`node:http` + `node:crypto` de la stdlib Node, rien d'autre).

### 7.1 Activer le pont — `opts.bridge`

```js
import { mjsWs } from 'modularjs-framework/ws'

const app = mjsWs({
  // ... auth/welcome/rooms/etc., comme d'habitude (§1) ...
  bridge: {
    secret: 'env:MJS_WS_BRIDGE_SECRET',   // OBLIGATOIRE — littérale, ou 'env:NOM_VAR' lue dans process.env
    // port: 4001,                       // défaut : port du WebSocket + 1
    // host: '127.0.0.1',                // défaut — loopback, jamais exposé sur Internet directement
    webhooks: {
      url:    'https://mon-back.example.com/mjs-ws/hook',
      events: ['connect', 'disconnect', 'join', 'leave', 'message:chat'],
      // secret: '...',                  // défaut : le même secret que le pont
      // timeoutMs: 5000,
    },
  },
})

await app.listen()   // démarre le WebSocket ET le pont
```

| Option | Défaut | Rôle |
|---|---|---|
| `secret` | — (**obligatoire**) | Chaîne littérale, ou `'env:NOM_VAR'` résolue via `process.env.NOM_VAR` au démarrage. Absente/vide → erreur claire, immédiate (avant même `.listen()`). |
| `port` | port du WebSocket + 1 | Port TCP du serveur HTTP du pont. |
| `host` | `'127.0.0.1'` | Host d'écoute — loopback : c'est **ton** back qui appelle le pont, jamais l'inverse. |
| `webhooks.url` | — | URL de **ton** back qui reçoit les webhooks (§7.5). Absente = aucun webhook émis (le pont reste utilisable en lecture/écriture, juste muet). |
| `webhooks.secret` | celui du pont | Secret de signature des webhooks — même forme (littérale ou `env:NOM_VAR`). |
| `webhooks.events` | — (**obligatoire si `webhooks` est fourni**) | Liste d'événements à transmettre : `'connect'`, `'disconnect'`, `'join'`, `'leave'`, `'message:<type>'` (§7.5). |
| `webhooks.timeoutMs` | `5000` | Délai avant abandon d'**une** tentative de livraison. |

`app.listen()` démarre les **deux** serveurs (WebSocket + pont) ; `app.stop()` les arrête tous les deux (le pont en premier, pour ne plus accepter de nouvelles requêtes pendant que les clients WebSocket reçoivent leur `µ:bye`).

Avec `mjs ws` (§6), le pont se configure aussi dans `mjs.config.json` (`ws.bridge`, **mêmes** clés) ou dans l'entry (`bridge: {...}`) — même règle que `heartbeat`/`limits` : si les **deux** sont posés, l'entry prime EN **bloc** et un avertissement te le signale. La bannière de démarrage affiche l'URL du pont et les événements webhooks actifs.

### 7.2 La signature, pas à pas

Chaque requête (**sauf** `GET /health`) doit porter deux en-têtes :

| En-tête | Contenu |
|---|---|
| `x-mjs-ws-timestamp` | l'heure UNIX **en secondes**, au moment de la signature |
| `x-mjs-ws-signature` | HMAC-SHA256 **hexadécimal** de la « chaîne canonique » (ci-dessous), avec ton `secret` |

> ⚠️ **Changement de protocole** — la chaîne canonique décrite ci-dessous
> **Diffère** de la concaténation simple `'.'`-jointe des versions précédentes de cette page. Deux durcissements :
> **séparation de domaine** (un `direction` dédié empêche de rejouer la signature d'une commande admin entrante
> comme un webhook sortant, ou l'inverse, **même** secret partagé) et **injectivité** (l'ancien format permettait,
> en théorie, deux découpages `{chemin}`/`{corps}` distincts de produire la **même** chaîne s'il y avait un `.` au
> bon endroit — plus possible). Aucun back en production ne suivait encore l'ancienne recette au moment de ce
> changement — si le tien la suit déjà, adapte-le à la recette ci-dessous (§7.3/§7.5/§7.7/§7.10).

La chaîne canonique est la concaténation de **champs encodés en longueur-préfixée** (`{longueur}:{champ}`,
comme un netstring — rend la concaténation **sans ambiguïté**, impossible à re-découper autrement) :

```
{longueur(direction)}:{direction}{longueur(ts)}:{ts}{longueur(MÉTHODE)}:{MÉTHODE}{longueur(chemin)}:{chemin}{longueur(corps)}:{corps}
```

- `{direction}` — `'in'` pour une commande admin **entrante** (ton back → le pont, §7.3), `'out'` pour un webhook
  **Sortant** (le pont → ton back, §7.5) ; **toujours** le **premier** champ — c'est lui qui sépare les deux domaines de
  signature ;
- `{ts}` — l'horodatage UNIX en secondes, tel qu'envoyé dans `x-mjs-ws-timestamp` ;
- `{MÉTHODE}` en **majuscules** (`POST`, `GET`) ;
- `{chemin}` avec la query string, tel qu'il apparaît dans l'URL (`/broadcast`, `/presence?room=zone-42`) — jamais le domaine, jamais le port ;
- `{corps}` = le JSON envoyé, **texte pour texte**, tel qu'il part sur le réseau (pas une re-sérialisation — l'ordre des clés compte) ; **chaîne vide** pour une requête `GET` (jamais de corps) ;
- un `{nonce}` (§7.10, optionnel) s'ajoute en **dernier** champ, encodé de la même façon.

Exemple pour `POST /broadcast` avec le corps `{"type":"annonce","p":{"texte":"salut"}}`, à l'instant `1735689600`, direction `'in'` :

```
2:in10:17356896004:POST10:/broadcast40:{"type":"annonce","p":{"texte":"salut"}}
```

Le pont recalcule la **même** chaîne à réception (avec `direction = 'in'` **toujours** côté vérification des commandes
admin) et compare les deux signatures en temps constant (`crypto.timingSafeEqual`) — jamais une comparaison de
chaînes naïve, qui fuiterait la validité par le temps de réponse. Deux protections de plus :

- **anti-rejeu** : si `|maintenant − timestamp| > 300 s`, la requête est refusée (401) même si la signature est juste — une requête interceptée et rejouée plus tard ne passe pas ;
- **corps trop gros** : au-delà d'1 Mo, 413 immédiat.

Toute erreur de signature/format répond `401 {"ok": false, "error": "…"}` (message en français) ; un JSON invalide répond `400` ; un chemin inconnu répond `404`.

**Séparation de domaine du secret** — `webhooks.secret` (§7.1) reste la meilleure isolation (compromission d'un canal sans effet sur l'autre), mais grâce au préfixe `direction`, un secret **partagé** (`webhooks.secret` absent, valeur par défaut) est sûr aussi : une signature calculée pour `'in'` ne vérifie **jamais** comme `'out'`, ni l'inverse — même avec le **même** secret des deux côtés.

### 7.3 Les endpoints

Un petit script bash réutilisé par tous les exemples ci-dessous (adapte `secret` et le port) :

```bash
secret='ton-secret-du-pont'
pont='http://127.0.0.1:4001'

lp() { printf '%s' "${#1}:$1"; }   # encodage longueur-préfixée d'UN champ, cf. §7.2

signer_et_envoyer() {
  local methode="$1" chemin="$2" corps="$3"
  local ts=$(date +%s)
  local canonique="$(lp 'in')$(lp "$ts")$(lp "$methode")$(lp "$chemin")$(lp "$corps")"   # direction 'in' — commande admin entrante
  local sig=$(printf '%s' "$canonique" | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/^.* //')
  curl -s -X "$methode" "$pont$chemin" \
    -H "x-mjs-ws-timestamp: $ts" \
    -H "x-mjs-ws-signature: $sig" \
    ${corps:+-H "content-type: application/json"} \
    ${corps:+-d "$corps"}
}
```

**`POST /broadcast`** — diffuse à tous les clients authentifiés (`except` optionnel : un id de connexion, un id agrégé `identity.id`, ou un tableau des deux mélangés).

```bash
signer_et_envoyer POST /broadcast '{"type":"annonce","p":{"texte":"maintenance dans 5 min"}}'
# → {"ok":true}
```

**`POST /send`** — un client précis (`client`, id de connexion) OU toutes les connexions d'un utilisateur (`user`, `identity.id` — pratique pour un utilisateur ouvert dans plusieurs onglets). Fournis **exactement** l'un des deux.

```bash
signer_et_envoyer POST /send '{"user":"42","type":"notif","p":{"texte":"commande expédiée"}}'
# → {"ok":true,"sent":2}   (2 connexions de l'utilisateur 42 — ex. 2 onglets ouverts)
```

**`POST /room/send`** — diffuse aux membres d'un salon **seulement**. `type` part **tel quel** (le préfixe `salon/type` est une convention côté client, le pont n'y touche pas — **même** règle que `app.room(nom).send()`, §4).

```bash
signer_et_envoyer POST /room/send '{"room":"partie-42","type":"partie-42/coup","p":{"case":12}}'
# → {"ok":true}
```

**`POST /room/kick`** — expulse un membre du salon (`client` ou `user`, comme `/send`) ; `reason` optionnelle, transmise au visé (`µ:left {room, reason}`). La connexion reste ouverte — c'est une expulsion de **salon**, pas une déconnexion.

```bash
signer_et_envoyer POST /room/kick '{"room":"partie-42","user":"7","reason":"triche"}'
# → {"ok":true,"kicked":1}
```

**`POST /stream`** — pilote un flux à journal borné (§5) depuis le back : `op` vaut `'add'`, `'update'`, `'remove'` ou `'reset'`. Le flux est créé À LA **volée** s'il n'existait pas encore.

| `op` | Champs requis | Effet |
|---|---|---|
| `add` | `id`, `value` | ajoute/remplace l'entrée `id` |
| `update` | `id`, `value` (objet — le PATCH) | fusion 1 niveau, comme `stream.update()` |
| `remove` | `id` | retire l'entrée |
| `reset` | `values` (objet complet) | nouvelle époque — remplace tout, journal vidé |

```bash
signer_et_envoyer POST /stream '{"name":"ennemis","op":"add","id":"e1","value":{"x":10,"y":20}}'
# → {"ok":true}
```

**`GET /presence`** — présence agrégée, telle que la voit `sock.presence()` côté client. Sans `?room=`, c'est la présence **globale**.

```bash
signer_et_envoyer GET '/presence?room=partie-42' ''
# → {"ok":true,"peers":[{"id":"7","meta":{"pseudo":"Zora"}}]}
```

**`GET /health`** — **seul** endpoint **sans** signature, pour un simple contrôle de vie (load balancer, orchestrateur…) :

```bash
curl http://127.0.0.1:4001/health
# → 200, corps texte "ok"
```

### 7.4 Vérifier une signature reçue (le sens inverse)

Le pont applique le **même** algorithme (longueur-préfixée, §7.2) pour vérifier ce qu'il reçoit ET pour signer ce qu'il envoie (les webhooks, §7.5) — ton back doit donc savoir faire les **deux** : signer une requête sortante vers le pont (`direction = 'in'`), et vérifier une requête entrante (un webhook) venant du pont (`direction = 'out'`). **Seul** le champ `direction` change entre les deux sens — cf. les recettes par langage en §7.6.

### 7.5 Les webhooks — le pont te prévient

Quand `webhooks` est configuré, `mjsWs` POST vers `webhooks.url` à chaque événement listé dans `events`, signé avec la **même** chaîne canonique que tes propres requêtes entrantes (§7.2), **sauf** le champ `direction` : `'out'` au lieu de `'in'` — c'est exactement ce qui empêche de rejouer la signature d'un webhook comme une commande admin, ou l'inverse. Mêmes en-têtes (`POST`, le **chemin** de ton URL de webhook, le corps JSON). C'est du **fire-and-forget** : la réponse de ton back n'est **jamais** renvoyée au client d'origine, et un échec ne bloque **jamais** le serveur temps réel.

| Événement | Payload | Quand |
|---|---|---|
| `connect` | `{event, at, client: {id, identity, meta}}` | une connexion franchit le `µ:welcome` (authentifiée) |
| `disconnect` | `{event, at, client: {id, identity, meta}, reason?}` | une connexion authentifiée se ferme |
| `join` | `{event, at, room, user: {id, meta}}` | un **utilisateur** (agrégé, `identity.id`) entre dans un salon — au premier onglet, pas à chaque connexion |
| `leave` | `{event, at, room, user: {id, meta}}` | un utilisateur **quitte** un salon — au dernier onglet fermé/parti |
| `message:<type>` | `{event: 'message', type, p, client: {id, identity}}` | un client envoie un message applicatif de CE type précis (ex. `message:chat`) — que le serveur ait un `serve()`/`on()` dessus ou non |

`join`/`leave` suivent **exactement** les mêmes règles que la présence de salon (§4) : deux onglets du même utilisateur ne déclenchent qu'un `join` (au premier) et qu'un `leave` (au dernier) — jamais de doublon par onglet.

**Livraison** — bornée et jamais bloquante : file d'attente de 1000 événements maximum (au-delà, l'événement en trop est abandonné avec un avertissement dans `onLog`, jamais une pile qui grossit sans fin), 4 livraisons en vol au maximum en parallèle, 3 tentatives par événement (immédiate, puis +2 s, puis +10 s) avant abandon définitif (avec un avertissement). Un événement absent de `events` n'est **jamais** calculé ni envoyé — configure exactement ce dont ton back a besoin.

Côté back, un webhook reçu ressemble à ceci (Node, exemple minimal) :

```js
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'

const SECRET = process.env.MJS_WS_BRIDGE_SECRET

// encodage longueur-préfixée d'UN champ (§7.2)
const lp = (champ) => `${champ.length}:${champ}`

createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const corps       = Buffer.concat(chunks).toString('utf8')
    // direction 'out' — c'est un webhook (le pont → toi), JAMAIS 'in' (une commande admin toi → le pont)
    const canonique    = ['out', req.headers['x-mjs-ws-timestamp'], 'POST', req.url, corps].map(lp).join('')
    const attendue     = createHmac('sha256', SECRET).update(canonique).digest('hex')
    const recueBuf     = Buffer.from(req.headers['x-mjs-ws-signature'], 'hex')
    const attendueBuf  = Buffer.from(attendue, 'hex')
    if (recueBuf.length !== attendueBuf.length || !timingSafeEqual(recueBuf, attendueBuf)) {
      res.writeHead(401); res.end(); return
    }
    const evt = JSON.parse(corps)
    console.log('événement MJS-WS reçu :', evt.event, evt)
    res.writeHead(200); res.end('ok')
  })
}).listen(3000)
```

### 7.6 Jetons — signer/vérifier sans dépendance (`modularjs-framework/ws`)

`mjsWs` fournit des jetons **JWT HS256** sans aucune dépendance (base64url + HMAC-SHA256, `node:crypto` seul) — interopérables avec les bibliothèques JWT standard de n'importe quel langage (même algorithme, même format).

```js
import { signToken, verifyToken, jwtAuth } from 'modularjs-framework/ws'

// émission (ex. après un login classique, côté ton API)
const jeton = signToken({ id: utilisateur.id, pseudo: utilisateur.pseudo }, process.env.JWT_SECRET, { ttl: 3600 })

// côté MJS-WS — jwtAuth() est une fonction opts.auth toute prête :
const app = mjsWs({
  auth: jwtAuth(process.env.JWT_SECRET),   // lit hello.auth.token (ou hello.auth si c'est déjà une chaîne)
  // ... reste des options ...
})
```

`jwtAuth` pose `client.identity = payload` (les clés du jeton), avec `identity.id = payload.id ?? payload.sub` — compatible des jetons émis par une lib tierce qui n'utilise que `sub` (convention JWT standard). Un jeton absent, mal signé, ou expiré → refus (`µ:denied`), comme n'importe quelle fonction `auth` qui retourne `false`.

Émettre ce jeton peut se faire dans **n'importe quel** langage — le format est standard (`base64url(entête).base64url(corps).base64url(signature)`, HMAC-SHA256, sans padding). Quatre recettes :

**Ruby — sans gem (stdlib `openssl`/`base64`/`json`)**

```ruby
require 'openssl'
require 'base64'
require 'json'

def signer_jeton(payload, secret, ttl: nil)
  entete = { alg: 'HS256', typ: 'JWT' }
  iat    = Time.now.to_i
  corps  = payload.merge(iat: iat)
  corps[:exp] = iat + ttl if ttl
  b64 = ->(s) { Base64.urlsafe_encode64(s, padding: false) }
  entete_charge = "#{b64.call(entete.to_json)}.#{b64.call(corps.to_json)}"
  signature = OpenSSL::HMAC.digest('SHA256', secret, entete_charge)
  "#{entete_charge}.#{b64.call(signature)}"
end

jeton = signer_jeton({ id: current_user.id, pseudo: current_user.pseudo }, ENV.fetch('JWT_SECRET'), ttl: 3600)
```

**Ruby — avec la gem `jwt`** (si elle est déjà dans ton `Gemfile`)

```ruby
require 'jwt'
jeton = JWT.encode({ id: current_user.id, pseudo: current_user.pseudo, iat: Time.now.to_i }, ENV.fetch('JWT_SECRET'), 'HS256')
```

**PHP — sans dépendance (`hash_hmac`)**

```php
<?php
function signer_jeton(array $payload, string $secret, ?int $ttl = null): string {
  $entete = ['alg' => 'HS256', 'typ' => 'JWT'];
  $iat    = time();
  $corps  = $payload + ['iat' => $iat];
  if ($ttl !== null) $corps['exp'] = $iat + $ttl;
  $b64 = fn($s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
  $entete_charge = $b64(json_encode($entete)) . '.' . $b64(json_encode($corps));
  $signature = hash_hmac('sha256', $entete_charge, $secret, true);
  return $entete_charge . '.' . $b64($signature);
}

$jeton = signer_jeton(['id' => $utilisateur->id, 'pseudo' => $utilisateur->pseudo], getenv('JWT_SECRET'), 3600);
```

**Python — stdlib (`hmac`/`hashlib`/`base64`/`json`)**

```python
import base64, hashlib, hmac, json, os, time

def signer_jeton(payload: dict, secret: str, ttl: int | None = None) -> str:
    entete = {'alg': 'HS256', 'typ': 'JWT'}
    iat    = int(time.time())
    corps  = {**payload, 'iat': iat}
    if ttl is not None:
        corps['exp'] = iat + ttl
    b64 = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b'=')
    entete_charge = b64(entete) + b'.' + b64(corps)
    signature     = hmac.new(secret.encode(), entete_charge, hashlib.sha256).digest()
    sig64         = base64.urlsafe_b64encode(signature).rstrip(b'=')
    return (entete_charge + b'.' + sig64).decode()

jeton = signer_jeton({'id': utilisateur.id, 'pseudo': utilisateur.pseudo}, os.environ['JWT_SECRET'], ttl=3600)
```

### 7.7 Recette « depuis Rails » — pousser sans toucher au process `mjsWs`

Un petit module qu'on appelle depuis n'importe quel contrôleur/job Rails — aucune gem HTTP exotique, juste `net/http` de la stdlib :

```ruby
require 'net/http'
require 'openssl'
require 'json'
require 'uri'

module Realtime
  MJS_WS_URL    = ENV.fetch('MJS_WS_BRIDGE_URL', 'http://127.0.0.1:4001')
  MJS_WS_SECRET = ENV.fetch('MJS_WS_BRIDGE_SECRET')

  def self.rt_broadcast(type, payload = {}, except: nil)
    poster('/broadcast', { type: type, p: payload, except: except }.compact)
  end

  def self.rt_send(user:, type:, payload: {})
    poster('/send', { user: user.to_s, type: type, p: payload })
  end

  def self.rt_room(room:, type:, payload: {})
    poster('/room/send', { room: room, type: type, p: payload })
  end

  # encodage longueur-préfixée d'UN champ (§7.2)
  def self.lp(champ)
    "#{champ.bytesize}:#{champ}"
  end

  def self.poster(chemin, corps_hash)
    corps = corps_hash.to_json
    ts    = Time.now.to_i
    # direction 'in' — c'est TOI qui pousses vers le pont (commande admin entrante), jamais 'out' (réservé aux webhooks)
    chaine_canonique = [lp('in'), lp(ts.to_s), lp('POST'), lp(chemin), lp(corps)].join
    signature = OpenSSL::HMAC.hexdigest('SHA256', MJS_WS_SECRET, chaine_canonique)

    uri = URI.join(MJS_WS_URL, chemin)
    req = Net::HTTP::Post.new(uri)
    req['content-type']      = 'application/json'
    req['x-mjs-ws-timestamp'] = ts.to_s
    req['x-mjs-ws-signature'] = signature
    req.body = corps

    Net::HTTP.start(uri.host, uri.port) { |http| http.request(req) }
  end
end
```

Utilisation, depuis n'importe où dans l'appli Rails (contrôleur, job Sidekiq, callback ActiveRecord…) — **aucune** connaissance du protocole `µ:`, juste un appel Ruby normal :

```ruby
# app/models/commande.rb
after_update_commit :notifier_expedition, if: :expediee?

def notifier_expedition
  Realtime.rt_send(user: user, type: 'notif', payload: { commande_id: id, statut: 'expediee' })
  Realtime.rt_broadcast('stats_maj', { total_commandes: Commande.count })
end
```

### 7.8 Limite de débit

La signature (§7.2) protège l'**intégrité** des requêtes — pas le matraquage : une boucle folle côté back, ou quelqu'un qui essaie de deviner ton secret à coups de signatures au hasard, passerait au travers. Le pont applique donc une limite de débit **par IP source, active par défaut** :

- un **seau général** : `120` requêtes / `10 s` par IP, sur **toutes** les routes **sauf** `GET /health` (toujours libre — c'est la sonde de ton orchestrateur/load-balancer) ;
- un **seau séparé, plus strict**, pour les échecs de signature : `10` réponses `401` / `60 s` par IP — au-delà, `429` **immédiat**, sans même vérifier la signature (protection contre le brute-force).

Dépassement (l'un ou l'autre seau) → `429 {"ok": false, "error": "rate-limited"}`, sans autre détail.

```js
bridge: {
  secret: 'env:MJS_WS_BRIDGE_SECRET',
  // rateLimit: false,                                       // désactive complètement
  // rateLimit: { perIp: [200, 10000], fails: [5, 60000] },   // ajuste un seau ou les deux
},
```

| Option | Défaut | Rôle |
|---|---|---|
| `rateLimit.perIp` | `[120, 10000]` | `[capacité, fenêtreMs]` du seau général. |
| `rateLimit.fails` | `[10, 60000]` | `[capacité, fenêtreMs]` du seau des échecs de signature. |
| `rateLimit` | actif (défauts ci-dessus) | `false` désactive les **deux** seaux. |

Même règle que le reste de `ws.bridge` en config (`mjs.config.json` `ws.bridge.rateLimit`, ou l'entry) : la bannière de `mjs ws` affiche l'état effectif (« limite de débit : 120 req/10s par IP (échecs de signature : 10/60s) », ou « limite de débit désactivée »).

### 7.9 Expiration et rafraîchissement du jeton

Un jeton (§7.6) porte une échéance (`exp`) — mais elle n'était vérifiée **qu'au** `µ:hello`. Sans rien de plus, un jeton qui expire **après** la connexion ne ferme jamais la socket : le client reste connecté indéfiniment avec une identité qui n'est plus censée être valide. `mjsWs` suit cette échéance en continu, dès que `opts.auth` (donc `jwtAuth`, ou toute fonction maison qui pose un `exp` numérique sur l'identity retournée) l'expose.

**Suivi automatique — rien à activer.** Dès qu'UN client authentifié porte une échéance, un balayage périodique **global** (jamais un minuteur par connexion) la surveille : passé l'échéance (+ une tolérance d'horloge), le client reçoit `µ:error { code: 'token-expired' }` puis sa connexion est fermée — **sans** `µ:bye` (le client peut reconnecter avec un jeton neuf, exactement comme un kick des protections de série, §3). Tant qu'**aucune** auth n'expose jamais d'échéance, ce balayage n'est jamais armé : zéro minuteur, zéro coût.

```js
const app = mjsWs({
  auth:  jwtAuth(process.env.JWT_SECRET),   // pose identity.exp — le suivi s'arme tout seul
  token: { sweep: 10000, slack: 5000 },     // valeurs par défaut — période du balayage / tolérance d'horloge
})
```

| Option `token.*` | Défaut | Rôle |
|---|---|---|
| `sweep` | `10000` ms | Période du balayage global. |
| `slack` | `5000` ms | Tolérance d'horloge — un jeton expiré depuis **moins** que ça n'est pas encore fermé. |

**Rafraîchir avant l'échéance — `µ:refresh`.** Plutôt que de laisser la connexion se faire fermer, le client peut envoyer un jeton neuf EN **vol** : le serveur re-vérifie par le **même** chemin que le hello (`opts.auth`), mais refuse tout changement d'identité (`identity.id`) — un rafraîchissement n'est jamais un moyen détourné de changer d'utilisateur, ça casserait présence/salons déjà établis sur l'ancienne identité. Un rafraîchissement raté (`µ:error { code: 'refresh-denied' }`) ne ferme **rien** — la connexion continue de vivre jusqu'à son échéance courante.

Côté client, `sock.refresh(a)` — **même** contrat que l'option `auth` du constructeur (valeur ou fonction, sync/async) :

```civet
@sock = µsocket "wss://jeu/play", { auth: -> { token: $$session.token } }

try
  await @sock.refresh -> { token: $$session.token }   # nouveau jeton — même contrat que `auth`
catch e
  µ.error 'jeton refusé au rafraîchissement :', e   # connexion INCHANGÉE, vivante jusqu'à son échéance courante
```

> ⚠️ **Pas de minuterie côté client.** `sock.refresh` ne re-tente jamais tout seul et n'arme aucun minuteur — c'est à l'appli de décider quand rafraîchir (ex. depuis l'échéance connue de son propre jeton, ou un `setInterval` maison).

### 7.10 Nonce anti-rejeu (optionnel)

La fenêtre anti-rejeu de base (§7.2) tolère qu'une requête **capturée** soit rejouable pendant toute sa durée (± 300 s) — documenté, acceptable pour la plupart des usages. `ws.bridge.nonce: true` ferme cette fenêtre : chaque requête signée doit alors porter, EN **plus** des deux en-têtes habituels, un `x-mjs-ws-nonce` (chaîne choisie par **ton** back, 8 à 64 caractères — un identifiant aléatoire suffit), **suffixé** en **dernier** champ (encodé en longueur-préfixée, comme les autres — §7.2) à la chaîne canonique :

```
{lp(direction)}{lp(ts)}{lp(MÉTHODE)}{lp(chemin+query)}{lp(corps brut)}{lp(nonce)}
```

```js
bridge: {
  secret: 'env:MJS_WS_BRIDGE_SECRET',
  nonce:  true,   // défaut false — COMPATIBILITÉ : les recettes de §7.3, vérifiées mot pour mot,
                  // continuent de marcher SANS aucun changement tant que cette option reste absente
},
```

Fabriquer un nonce, côté back (n'importe quelle chaîne aléatoire de 8 à 64 caractères convient) :

```ruby
nonce = SecureRandom.hex(16)   # 32 caractères hexadécimaux
```

```bash
nonce=$(openssl rand -hex 16)
```

Le pont retient chaque nonce vu pendant ± 300 s (store borné, éviction automatique — même esprit que la limite de débit, §7.8) :

| Cas | Réponse |
|---|---|
| en-tête `x-mjs-ws-nonce` absent, ou hors format (8-64 caractères) | `401` |
| nonce déjà vu dans la fenêtre ± 300 s (rejeu) | `401 {"ok":false,"error":"nonce-rejoué"}` |

Les deux cas **créditent** le seau-échecs de la limite de débit (§7.8) — exactement comme une signature invalide, un flot de rejeux se fait donc aussi verrouiller en `429` au-delà du budget configuré.

| Option | Défaut | Rôle |
|---|---|---|
| `nonce` | `false` | `true` exige `x-mjs-ws-nonce` sur chaque requête signée (**sauf** `GET /health`, jamais signé). |

### 7.11 Proxy de décisions (auth/join délégués)

`opts.auth` et `opts.rooms.join` sont des callbacks — rien n'empêchait déjà d'y appeler ton back à la main (`fetch`/`net/http`/…). Le **proxy de décisions** retire ce dernier bout de code : pointe une URL, `mjsWs` fait l'appel HTTP **signé** à ta place, avec timeout et cache courts intégrés. Façon Centrifugo « proxy ».

> ℹ️ **Format de signature — différent du pont admin/webhooks.** Le proxy de décisions garde volontairement la
> chaîne canonique **historique**, `'.'`-jointe **sans** le préfixe `direction` (§7.2) : `{ts}.POST.{chemin}.{corps}`,
> et `{ts}.RESPONSE.{chemin}.{corps}` pour `verifyResponse` (le champ **méthode** joue déjà ce rôle de séparation
> ici). Ce n'est **pas** le même canal ni le même secret que `bridge.secret`/`webhooks.secret` — les recettes
> ci-dessous restent telles quelles, rien à changer côté back existant pour cette section.

```js
const app = mjsWs({
  // fonction historique — continue de marcher, RIEN ne change (rétro-compat totale)
  // auth: (hello, meta) => hello.auth?.token === SECRET ? { id: 1 } : false,

  // proxy de décisions — le dev ne code plus l'appel HTTP lui-même
  auth: {
    url:    'https://mon-back.example.com/mjs-ws/connect',
    secret: 'env:MJS_WS_PROXY_SECRET',   // littérale, ou 'env:NOM_VAR' — MÊME patron que bridge.secret
    // timeout: 5000,                   // ms, défaut 5000 — au-delà : décision de REFUS, jamais bloquant
    // cache:   { ttl: 2000 },          // ms, optionnel — évite de marteler le back sur des reconnexions rapprochées
  },
  rooms: {
    join: { url: 'https://mon-back.example.com/mjs-ws/subscribe', secret: 'env:MJS_WS_PROXY_SECRET' },
  },
})
```

| Option | Défaut | Rôle |
|---|---|---|
| `url` | — (**obligatoire**) | URL de **ton** back qui décide. |
| `secret` | — (**obligatoire**) | Chaîne littérale, ou `'env:NOM_VAR'` — **même** forme que `opts.bridge.secret`. |
| `timeout` | `5000` ms | Au-delà : décision de **refus**, jamais bloquant/pendant — le client reçoit un `µ:denied`/`µ:error` tout à fait normal, comme n'importe quel refus. |
| `cache.ttl` | — (pas de cache) | Cache court, par requête — une reconnexion/un rejoin identique dans la fenêtre ne repart **jamais** vers ton back, la décision précédente est réutilisée telle quelle. Absent = chaque appel repart vers ton back (comportement par défaut, rien de caché). |
| `verifyResponse` | `false` | Exige que la **réponse** du back soit elle-même signée (mêmes en-têtes, `RESPONSE` à la place de `POST`) — cf. « Durcissement — signer la réponse » plus bas. |

**Le contrat HTTP** — un POST signé, **mêmes** en-têtes que le pont (`x-mjs-ws-timestamp` / `x-mjs-ws-signature`), mais chaîne canonique **historique** (cf. note ci-dessus — **pas** celle, longueur-préfixée + dirigée, du pont admin/webhooks §7.2) : `{ts}.POST.{chemin}.{corps}`.

| Événement | Corps envoyé | Réponse attendue |
|---|---|---|
| `connect` (`opts.auth`) | `{event:'connect', hello, cookie?}` — `hello` = charge **exacte** du `µ:hello` reçu ; `cookie` = en-tête `Cookie` **brut** de la requête d'upgrade, **clé absente** s'il n'y en a pas | `{ok:true, identity}` → `client.identity`, `µ:welcome` ; `{ok:false, raison?}` → `µ:denied {message: raison}` |
| `subscribe` (`rooms.join`) | `{event:'subscribe', room, identity}` | `{ok:true}` → adhésion ; tout le reste (`{ok:false}`, statut non-2xx, JSON invalide, timeout) → refus (`µ:error`, throttlé comme d'habitude, §4) |

Un statut non-2xx, une réponse JSON invalide, ou le délai `timeout` dépassé sont **tous** traités comme `{ok:false}` — jamais un `throw` qui ferait pendre le handshake, toujours une décision (de refus).

> ℹ️ **`cookie` — c'est ce qui rend le patron « `mjsWs` rejoue le cookie » (§7.12) compatible avec ce proxy.** Le
> `connect` porte l'en-tête `Cookie` **brut** de la requête d'upgrade : ton back peut donc décider sur la **session**
> du visiteur, sans jeton intermédiaire, tout en gardant la signature, le `timeout` et le cache de cette section.
> C'est le **seul** en-tête transmis — ni `authorization`, ni `user-agent`, ni le reste : un back n'a pas à recevoir
> ce qu'il n'a pas demandé. Sans cookie sur l'upgrade, la clé est **absente** du corps (jamais une chaîne vide) :
> un back déjà en place ne voit **aucun** changement. Le cookie fait partie de la **clé de cache** (`cache.ttl`) —
> le cache est donc par **visiteur**, jamais partagé entre deux identités. Et la garde TLS ci-dessous (`http://`
> hors loopback refusé sauf `allowInsecure`) reste ce qui empêche ce cookie de voyager en clair.

**Vérifier la signature côté Rails** — **rigoureusement** la même recette que pour un webhook du pont reçu (§7.4/§7.5) : le corps change, l'algorithme non.

```ruby
ts, sig  = request.headers['x-mjs-ws-timestamp'], request.headers['x-mjs-ws-signature']
corps    = request.raw_post
attendue = OpenSSL::HMAC.hexdigest('SHA256', ENV.fetch('MJS_WS_PROXY_SECRET'), "#{ts}.POST.#{request.path}.#{corps}")
head :unauthorized and return unless ActiveSupport::SecurityUtils.secure_compare(attendue, sig.to_s)

evt = JSON.parse(corps)
case evt['event']
when 'connect'   then render json: autoriser_connexion(evt['hello'])   # { ok:true, identity: {...} } ou { ok:false, raison: '...' }
when 'subscribe' then render json: { ok: peut_rejoindre?(evt['room'], evt['identity']) }
end
```

**Rétro-compat totale** : `auth` en proxy et `rooms.join` en fonction locale (ou l'inverse) se mélangent librement, rien n'impose de tout migrer d'un coup — les deux formes cohabitent sans réglage supplémentaire.

> **Pas dans `mjs.config.json`.** Contrairement à `bridge`/`resume` (purement déclaratifs), `auth`/`rooms.join` restent réservés à l'entry/`mjsWs()` (fonction OU objet-proxy) — pas de `ws.auth`/`ws.rooms` dans la config JSON pour l'instant. Rien ne l'empêche techniquement plus tard si le besoin se confirme.

#### Durcissement — signer la réponse (`verifyResponse: true`)

La recette ci-dessus fait confiance à la réponse HTTP telle quelle dès que le statut est 2xx — la garde TLS (loopback ou `https://`, cf. `resolveProxyOptions`) protège le **transport**, pas le **contenu** de la réponse elle-même : un maillon compromis en aval (proxy, back mal isolé…) pourrait en théorie forger une réponse `{ok:true}`. `verifyResponse: true` ferme cette dernière fenêtre : la réponse doit à son tour porter les **deux** en-têtes habituels, **même** secret, mais avec `RESPONSE` à la place de `POST` dans la chaîne canonique (jamais `POST` — pour ne jamais confondre la signature de la requête avec celle de sa propre réponse) :

```
{timestamp}.RESPONSE.{chemin avec la query string}.{corps de la RÉPONSE}
```

```js
auth: {
  url:    'https://mon-back.example.com/mjs-ws/connect',
  secret: 'env:MJS_WS_PROXY_SECRET',
  verifyResponse: true,   // défaut false — COMPATIBILITÉ : la recette ci-dessus (réponse NON signée)
                          // continue de marcher SANS aucun changement tant que cette option reste absente
},
```

Côté Rails — calculer `ts`/`sig` sur le corps de la **réponse** (pas celui de la requête) et poser les deux en-têtes **avant** `render` — la chaîne signée doit être **exactement** le corps envoyé, jamais reconstruite après coup :

```ruby
corps = autoriser_connexion(evt['hello']).to_json   # { ok:true, identity: {...} } ou { ok:false, raison: '...' }
ts    = Time.now.to_i
sig   = OpenSSL::HMAC.hexdigest('SHA256', ENV.fetch('MJS_WS_PROXY_SECRET'), "#{ts}.RESPONSE.#{request.path}.#{corps}")
response.set_header('x-mjs-ws-timestamp', ts.to_s)
response.set_header('x-mjs-ws-signature', sig)
render plain: corps, content_type: 'application/json; charset=utf-8'
```

| Cas (réponse reçue par MJS-WS) | Décision |
|---|---|
| en-têtes `x-mjs-ws-timestamp`/`x-mjs-ws-signature` absents | refus (`null`, journalisé via `onLog('warn', …)`) |
| `x-mjs-ws-timestamp` hors fenêtre ± 300 s (§7.2) | refus |
| signature invalide (mauvais secret, corps altéré en chemin…) | refus |
| signature valide | réponse traitée normalement — `JSON.parse` puis la décision habituelle (`connect`/`subscribe`) |

`verifyResponse` est optionnel et **rétro-compatible** : **absent** (défaut `false`), la réponse est acceptée telle quelle — **exactement** la recette non signée ci-dessus, rien ne change tant que le back n'est pas mis à jour pour signer sa réponse.

### 7.12 Recettes côté serveur applicatif

Trois patrons éprouvés (application Rails hôte : chaîne Ruby stdlib → pont HMAC → deux navigateurs) — la manière de combiner §7.6 (jetons), §7.7 (pont) et §7.11 (proxy) côté back applicatif.

**a) Session héritée → jeton (Rails/PHP déjà authentifié).** Ton appli a **déjà** une session (cookie Rails/Devise, `$_SESSION` PHP) — `mjsWs` ne connaît rien de cette session, il ne parle **que** `µ:hello`/jeton. Deux façons d'y raccorder, **même** jeton produit par §7.6 (`signer_jeton`, jamais réinventé) :

*Le client échange son cookie contre un jeton (recommandé — le plus simple).* Une route Rails **ordinaire**, protégée par le middleware d'auth habituel (le navigateur y envoie donc déjà le cookie de session, sans rien faire de spécial), renvoie un jeton :

```ruby
# app/controllers/mjs-ws_tokens_controller.rb
class MjsWsTokensController < ApplicationController
  before_action :authenticate_user!   # middleware Devise/Rails habituel — rien de spécifique à MJS-WS

  def create
    jeton = signer_jeton({ id: current_user.id, pseudo: current_user.pseudo }, ENV.fetch('JWT_SECRET'), ttl: 3600)   # §7.6, réutilisée telle quelle
    render json: { token: jeton }
  end
end
```

```ruby
# config/routes.rb
post '/mjs-ws/token', to: 'mjs_ws_tokens#create'
```

Côté client, un `fetch` ordinaire **avant** d'ouvrir la socket (le cookie part tout seul, même origine) :

```civet
reponse       = await fetch('/mjs-ws/token', { method: 'POST' })
{ token }     = await reponse.json()
@sock         = µsocket "wss://jeu/play", { auth: { token } }
```

Côté serveur `mjsWs`, **rien** de plus que §7.6 : `auth: jwtAuth(process.env.JWT_SECRET)`.

*Alternative — `mjsWs` rejoue le cookie lui-même (`/auth-session`).* Si le client ne doit **jamais** voir de jeton (une seule requête, le handshake WS lui-même), `opts.auth` peut transmettre le cookie de la requête d'upgrade à une route Rails dédiée — `meta.headers` (§1) porte les en-têtes **bruts** de cette requête, `cookie` compris :

```js
const app = mjsWs({
  auth: async (hello, meta) => {
    const cookie = meta.headers?.cookie
    if (!cookie) return false
    const res = await fetch('https://mon-rails.example.com/auth-session', { headers: { cookie } })
    if (!res.ok) return false
    return await res.json()   // { id, pseudo, ... } — devient client.identity
  },
})
```

```ruby
# app/controllers/auth_session_controller.rb — vérifie la session Rails NORMALE (Devise/warden),
# ne réémet même pas de jeton : MJS-WS n'a besoin que de l'identité, pas d'un JWT ici
class AuthSessionController < ApplicationController
  before_action :authenticate_user!

  def show
    render json: { id: current_user.id, pseudo: current_user.pseudo }
  end
end
```

**Honnête** : ce 2ᵉ patron suppose que `mjsWs` et Rails partagent le **même** domaine (un cookie n'est scopé ni par port ni par sous-domaine par défaut — `wss://exemple.com:8080` reçoit bien le cookie posé par `https://exemple.com:3000`, `SameSite` compris tant que le site reste le même) ; sur deux domaines séparés, repasse par le 1ᵉʳ patron (jeton explicite, aucune dépendance à un cookie).

> ⚠️ **Ce patron exige `verifyOrigin`.** Le cookie part **tout seul** avec la requête d'upgrade, y compris depuis une page tierce (une ouverture WebSocket n'obéit pas à la politique des requêtes ordinaires) — sans `verifyOrigin`, n'importe quel site peut ouvrir une connexion authentifiée au nom du visiteur. Arme `verifyOrigin: ['https://mon-site.example']` (§3.3) avant de déployer ce patron.

*Le même patron, par le proxy de décisions (§7.11) — recommandé.* Le `connect` du proxy porte le `cookie` de la requête d'upgrade : la fonction `auth` ci-dessus devient une **option**, et tu récupères au passage la signature HMAC, le `timeout` et le cache court sans écrire une ligne de crypto.

```js
const app = mjsWs({
  auth: {
    url:    'https://mon-rails.example.com/mjs-ws/connect',
    secret: 'env:MJS_WS_PROXY_SECRET',
    cache:  { ttl: 30000 },   // 30 s — une reconnexion en rafale (wifi qui saute) ne martèle pas Rails ; clé = hello + cookie, donc PAR visiteur
  },
  verifyOrigin: [ 'https://mon-site.example' ],   // §3.3 — OBLIGATOIRE avec ce patron, cf. l'avertissement ci-dessus
})
```

```ruby
# Rails — MÊME route que §7.11, la session se lit dans le cookie transmis
evt = JSON.parse(request.raw_post)
if evt['event'] == 'connect'
  user = User.from_session_cookie(evt['cookie'])   # ta propre lecture de session, à partir du Cookie brut
  return render(json: { ok: false, raison: 'session inconnue' }) unless user

  render json: { ok: true, identity: { id: user.id, pseudo: user.pseudo } }
end
```

**b) Salons dérivés d'un attribut d'identité (équipe, guilde…).** `client.identity` porte déjà ce qu'`auth` a retourné (§7.6/§7.11) — par exemple `equipe`. Le salon `equipe-<id>` n'a besoin d'**aucun** choix manuel côté utilisateur : c'est l'appli qui calcule le nom depuis l'identité, ET le serveur qui vérifie qu'elle n'en usurpe pas un autre :

```js
const app = mjsWs({
  auth:  jwtAuth(process.env.JWT_SECRET),   // identity.equipe vient du jeton (§7.6) — posé au login
  rooms: {
    join: (room, client) => {
      const m = room.match(/^equipe-(.+)$/)
      if (!m) return true                              // salons hors convention 'equipe-*' : libres (ou une autre garde)
      return m[1] === String(client.identity.equipe)    // seule SON équipe — jamais celle d'un autre
    },
  },
})
```

```civet
# côté client — le nom se CALCULE, l'utilisateur ne choisit jamais de salon
salon = @sock.room "equipe-#{identity.equipe}"
salon.on 'coup', (p)-> …
```

Si la décision vit dans Rails (roster d'équipe qui change en cours de partie, logique métier trop riche pour vivre dans `mjsWs`) : remplace la fonction locale par le proxy de décisions (§7.11), **même** convention de nom de salon — la garde part côté back :

```js
rooms: { join: { url: 'https://mon-back.example.com/mjs-ws/subscribe', secret: 'env:MJS_WS_PROXY_SECRET' } },   // §7.11, inchangé
```

```ruby
# évt reçu : { event: 'subscribe', room: 'equipe-42', identity: { id: 7, equipe: 42, ... } } — §7.11
when 'subscribe' then render json: { ok: evt['room'] == "equipe-#{evt.dig('identity', 'equipe')}" }
```

**c) Pousser depuis un job Sidekiq/worker (hors requête web).** Le moteur de combat tourne dans un job — aucune connexion WS, aucune requête HTTP en cours. Il pousse par le pont (§7.7, `Realtime`, réutilisé **tel quel**, jamais une 2ᵉ implémentation) :

```ruby
# app/jobs/resolution_combat_job.rb
class ResolutionCombatJob
  include Sidekiq::Job

  def perform(partie_id)
    resultat = MoteurCombat.resoudre(partie_id)   # logique métier — hors sujet ici
    Realtime.rt_room(room: "partie-#{partie_id}", type: "partie-#{partie_id}/resultat", payload: { vainqueur: resultat.vainqueur_id, score: resultat.score })   # §7.7
    Realtime.rt_send(user: resultat.vainqueur_id, type: 'notif', payload: { texte: 'victoire !' })   # §7.7
  end
end
```

Rien de spécifique à Sidekiq dans `Realtime` (§7.7) — juste `Net::HTTP` + HMAC, appelable depuis **n'importe quel** contexte Ruby hors requête (job, rake task, console, callback ActiveRecord déjà illustré en §7.7).

---

<a id="reprise-session"></a>
## 8. La reprise de session — une micro-coupure ne perd rien

Le scénario que tout le monde connaît : ton utilisateur passe sous un tunnel, son wifi saute dix secondes, il verrouille son téléphone dans l'ascenseur. Sans reprise, c'est une **déconnexion complète** : il « part » (les autres le voient disparaître de la présence), il « revient » (delta join, webhook connect), et tout ce que le serveur lui a envoyé entre-temps — un message de chat, une notification, une expulsion de salon — est **perdu à jamais**. Avec la reprise : **l'utilisateur ne voit rien**, et les autres non plus. Il n'est jamais parti.

### 8.1 Activer — `resume`

```js
const app = mjsWs({
  // ... auth/welcome/rooms, comme d'habitude (§1) ...
  resume: true,                 // défauts : grâce 30 s, tampon 500 trames / 256 Ko
  // resume: { grace: 60000, maxBuffered: 1000, maxBytes: 524288 },   // ou réglé finement
})
```

| Réglage | Défaut | Rôle |
|---|---|---|
| `grace` | `30000` ms | Durée pendant laquelle un client coupé peut revenir reprendre sa session. |
| `maxBuffered` | `500` trames | Trames retenues au maximum pendant son absence. |
| `maxBytes` | `262144` (256 Ko) | Octets retenus au maximum (sérialisation comprise). |

**Opt-in strict** : sans `resume`, rien ne change — pas un octet de différence dans les trames, pas un timer de plus. Avec `mjs ws`, la clé se pose dans `mjs.config.json` (`ws.resume`, cf. §6.3) ou dans l'entry (`resume`), l'entry primant en bloc en cas de doublon (§6.4).

### 8.2 Comment ça marche, simplement

1. **Au `µ:welcome`**, le serveur glisse une carte de visite : `session: { id, key }` (aléatoire crypto). Le client `µ.socket` la range — **rien à coder côté client**.
2. **À la coupure** (peu importe la cause, sauf un `µ:bye`), le client n'est pas purgé : il est **parqué**. Ses salons et sa présence sont **conservés** — pour tout le monde, il est encore là (`app.clients`, `GET /presence` du pont et les webhooks `join`/`leave` le comptent toujours). Une minuterie de grâce démarre.
3. **Pendant la grâce**, tout ce qui lui est destiné (`app.send`, `room().send`, `broadcast`, et même le `µ:left` d'un kick de salon) est **tamponné** au lieu d'être envoyé.
4. **À son retour**, le client rejoue `{ id, key }` dans son `µ:hello`. L'auth normale tourne **d'abord** (une reprise n'est jamais un contournement — le jeton est re-vérifié comme toujours), puis la clé est comparée à temps constant et l'identité doit être la même. Tout est bon ? Le **même** client est recyclé : `µ:welcome` avec `resumed: true`, le même `session.id`, une **clé neuve** (la clé tourne à chaque welcome — une clé volée hier ne vaut rien aujourd'hui), puis le tampon est rejoué **dans l'ordre**, juste après le welcome. Aucun delta de présence n'est émis, aucun webhook `connect`/`disconnect` : il n'est jamais parti.
5. **Sans retour à temps** : à l'expiration de la grâce seulement, la purge historique complète a lieu — leave de présence (agrégé : si l'utilisateur a un autre onglet vivant, rien ne part), purge des salons, et webhook `disconnect` du pont, **différé à ce moment-là**. `opts.onDisconnect` (§1) tire **au même instant** — c'est le seul signal générique d'une déconnexion vraiment définitive.

Échec de reprise (session inconnue ou expirée, clé fausse, identité différente, tampon débordé) → accueil **frais** classique, `resumed: false`, sans erreur ni fuite d'information — exactement comme un premier arrivant.

> Côté client, lisez l'accueil via `sock.on('welcome', …)` et `sock.resumed` — la charge complète du `µ:welcome` (sans la carte de session) et le booléen de reprise, cf. [20 · Temps réel](20-temps-reel.md).

### 8.3 Ce qui est rejoué, et ce qui ne l'est pas

| Pendant l'absence | Au retour |
|---|---|
| Messages applicatifs (`app.send`, `room().send`, `broadcast`) | **Rejoués**, dans l'ordre, juste après le `µ:welcome`. |
| `µ:left` (kick de salon d'un parqué) | **Rejoué** — une expulsion pendant l'absence doit arriver. |
| Deltas de flux (`app.stream`, trames à `seq`) | **Jamais tamponnés** : le client redemande lui-même la suite (`µ:resync { from }`, cf. §5) — les rejouer en plus créerait des doublons. Le journal du flux fait le travail, au numéro près. |
| `µ:presence` | **Jamais tamponné** : le `µ:sub-presence` du retour renvoie une photo complète — plus simple et toujours juste. |
| `µ:ping` / `µ:pong` / `µ:error` | Jamais tamponnés — battement et erreurs n'ont de sens qu'en direct. |

**Le tampon est borné** (`maxBuffered` trames OU `maxBytes` octets) : au débordement, la session devient **non reprenable** — au retour, accueil frais. Jamais de rejeu partiel : la moitié d'une histoire est pire que pas d'histoire du tout (l'application croirait avoir tout reçu).

### 8.4 La limite à connaître

Les sessions vivent **en mémoire, par processus** : un client qui revient doit retomber sur le **même** process `mjsWs`. Sur une machine unique, rien à faire. En multi-processus/multi-machines (répartition de charge), il faut l'adaptateur Redis (§9) — mais la reprise elle-même reste **locale** au process : cf. §9.6 pour le détail (répartiteur collant).

### 8.5 Session exclusive par identité — `sessionExclusive`

Un utilisateur ouvre un 2e onglet, ou reconnecte depuis un autre appareil, **avec la même identité** (`identity.id`) — par défaut, MJS-WS laisse cohabiter les deux connexions (comme n'importe quel autre utilisateur : rien ne change). Certaines applications (jeux compétitifs, ressources limitées par utilisateur, anti-triche) veulent l'inverse : **une seule connexion par identité**. Deux logiques opposées, **deux** modes opt-in :

- **`'replace'`** (≡ `true`) — la nouvelle connexion gagne, l'ancienne est évincée. Comportement historique.
- **`'refuse'`** (inverse) — l'existant gagne, la nouvelle connexion est refusée tant que l'ancienne vit.

```js
const app = mjsWs({
  auth: (hello) => ({ id: hello.auth.userId }),   // sessionExclusive a besoin d'un identity.id
  sessionExclusive: 'replace',                    // ou 'refuse' (inverse) ; désactivé par défaut ; true ≡ 'replace'
})
```

#### Mode `'replace'` (≡ `true`) — la nouvelle connexion gagne

Au `µ:hello` **frais** (jamais sur une reprise, §8 — un retour de session n'est jamais un « 2e hello ») d'une identité déjà connue :

1. Toute **autre** connexion **vivante** de cette identité reçoit `µ:bye { reason: 'replace' }` puis une fermeture **définitive**, code **4003** — jamais parquée ni reprise, même si `resume` est actif. Son nettoyage (salons, présence) suit le chemin normal d'un départ définitif.
2. Si `resume` est actif et qu'une session de cette identité est encore **parquée** (l'ancien onglet a coupé mais sa grâce n'a pas expiré), elle est révoquée elle aussi — sinon l'ancien onglet pourrait « reprendre » sa place en douce à sa reconnexion (la révocation la rend simplement introuvable : accueil frais, jamais `resumed: true`).
3. Multi-processus (§9) : l'éviction se propage aux autres process via l'adaptateur — même patron que `room().kick()`.

#### Mode `'refuse'` (inverse) — l'existant gagne

Au `µ:hello` **frais** d'une identité déjà connue :

1. S'il existe déjà une connexion **vivante** de cette identité, le nouveau hello est **refusé** tel quel : `µ:denied { message: 'session déjà active pour cette identité' }` puis fermeture **définitive**, code **4004**. La connexion existante n'est **jamais** touchée — elle continue d'échanger normalement.
2. S'il n'existe **que** des sessions **parquées** de cette identité (ou aucune connexion du tout), le nouveau hello est accueilli normalement, et les sessions parquées sont révoquées (même mécanisme qu'en mode `'replace'`) — sinon l'ancien onglet parqué pourrait « reprendre » sa place en douce à sa reconnexion.
3. Multi-processus (§9) : `sessionExclusive: 'refuse'` garantit l'exclusivité **par process** seulement — `clientsByIdentity` (l'index qui sait « qui est vivant ») est une structure **locale** à chaque process `mjsWs`, jamais répliquée. Derrière un répartiteur de charge multi-process, un hello frais qui atterrit sur un **autre** process que la connexion vivante n'est actuellement **pas** refusé (aucune requête cluster synchrone n'a été ajoutée — limite v1 assumée, sur-ingénierie évitée) : il est **accueilli** normalement, comme au point 2. **Ce hello accueilli ne touche cependant jamais une session vivante ailleurs dans le cluster** — seules les sessions **parquées** de cette identité, sur **n'importe** quel process, sont purgées à travers le canal `identity:kick` (même garde-fou que le nettoyage local du point 2, propagée). Une connexion vivante distante, elle, continue d'échanger sans interruption — le pire cas observable est donc « deux connexions vivantes coexistent, une par process », jamais « une session vivante tuée à distance ». Sur une machine unique (un seul process), l'exclusivité reste totale.

Une identité **anonyme** (`auth` qui ne pose jamais `id`, cf. `identityIdOf`) n'est **jamais** concernée, quel que soit le mode : `sessionExclusive` n'a d'effet qu'entre connexions d'une **même** identité connue.

> ⚠️ Présence **agrégée par identité** (§4) : en mode `'replace'`, si la nouvelle connexion rejoint la présence globale avant que l'ancienne ne soit purgée (c'est le cas), l'identité ne « disparaît » jamais aux yeux des autres — comme n'importe quel changement d'onglet. Seules les présences de **salon** auxquelles seule l'ancienne connexion avait adhéré émettent un vrai `leave`. En mode `'refuse'`, la connexion refusée n'a jamais rejoint quoi que ce soit (refusée avant le `µ:welcome`) — aucun impact sur la présence.

Avec `mjs ws` (§6), la clé se pose aussi dans `mjs.config.json` (`ws.sessionExclusive`, booléen ou `'replace'`/`'refuse'`) ou dans l'entry (`sessionExclusive`), l'entry primant en bloc en cas de doublon (§6.4).

---

<a id="adaptateur-redis"></a>
## 9. Plusieurs processus — l'adaptateur Redis

Jusqu'ici, tout ce chapitre suppose **un seul process** `mjsWs`. En pratique, dès que le trafic grossit, on fait tourner **plusieurs process** derrière un répartiteur de charge — PM2 en mode cluster, plusieurs conteneurs, plusieurs machines. Problème : chaque process ne connaît que **ses propres connexions WebSocket**. Sans coordination, `app.broadcast()` posé sur le process A n'atteint **que** les clients connectés à A — ceux connectés à B ou C ne voient rien. L'**adaptateur** résout ça : chaque process publie ce qu'il fait sur un canal partagé (Redis), et rejoue ce que les **autres** process publient — comme si tout le monde tournait dans le même process.

### 9.1 Activer — `opts.adapter`

```js
const app = mjsWs({
  // ... auth/welcome/rooms/etc., comme d'habitude (§1) ...
  adapter: {
    redis:  'redis://127.0.0.1:6379',   // ou 'redis://:motDePasse@hôte:port/base'
    // prefix: 'mjs-ws',                 // défaut — espace de noms des canaux/clés Redis
  },
})

await app.listen()   // démarre le WebSocket, LE CLUSTER, puis le pont si activé
```

| Option | Défaut | Rôle |
|---|---|---|
| `redis` | — (**obligatoire**) | URL Redis complète : `redis://[[:motDePasse]@]hôte[:port][/base]`. |
| `prefix` | `'mjs-ws'` | Espace de noms des canaux/clés — change-le si **plusieurs** applis différentes partagent le **même** Redis (sinon leurs flux/présences se mélangeraient). |

`opts.adapter` accepte aussi directement une **instance** déjà construite (un `MemoryAdapter` en test, ou un adaptateur maison qui implémente l'interface `MjsWsAdapter`) — utile pour les tests d'appli (2+ apps `mjsWs` dans le même process, reliées par un bus en mémoire au lieu d'un vrai Redis).

Avec `mjs ws` (§6), ça se configure aussi dans `mjs.config.json` (`ws.adapter`, **mêmes** clés) ou dans l'entry (`adapter: {...}`) — même règle que `bridge`/`resume` : si les **deux** sont posés, l'entry prime EN **bloc** et un avertissement te le signale. La bannière de démarrage affiche `multi-processus : redis://... (préfixe MJS-WS)`.

**Aucune dépendance ajoutée** : ni `redis`, ni `ioredis`. Le client Redis est un mini-client RESP écrit à la main sur `node:net`/`node:crypto` — le protocole texte de Redis (`PING`, `PUBLISH`, `SUBSCRIBE`, `INCR`, `SET`/`GET`/`DEL`, `KEYS`) est simple, et MJS-WS n'en a besoin que d'un sous-ensemble minuscule.

### 9.2 Ce qui traverse, simplement

| Action | Comportement multi-processus |
|---|---|
| `app.broadcast(type, p)` | Chaque process diffuse à **ses** clients authentifiés. |
| `app.room(nom).send(...)` | Chaque process diffuse à **ses** membres **locaux** de ce salon. |
| `app.room(nom).kick(...)` | Le membre visé est expulsé sur **quel que** process il se trouve. |
| `POST /send` (pont, `user`) | Toutes les connexions de cet utilisateur reçoivent, sur **tous** les process. |
| `app.stream(nom).add/update/remove/reset(...)` | Numéroté **globalement** (§9.3), appliqué et diffusé sur **chaque** process. |
| Présence (`µ:presence`, `GET /presence`) | **Fusionnée** — montre les pairs de **tous** les process (§9.4). |
| Sessions (reprise, §8) | Restent **locales** — jamais partagées entre process (§9.5). |

**Le principe, simplement :** chaque process applique **d'abord** localement (ses propres clients voient l'effet immédiatement, sans même passer par Redis), **puis** publie un petit message sur Redis pour dire aux autres process « fais pareil ». Les autres process reçoivent ce message et l'appliquent à **leurs** propres clients — jamais à celui qui a produit le message (chaque message porte l'identité du process qui l'a émis, et ce process s'ignore lui-même). Le pont universel (§7) profite de tout ça **gratuitement** : un `POST /broadcast` reçu par **n'importe quel** process touche toute la flotte, puisque `app.broadcast()` lui-même est déjà multi-processus.

### 9.3 Les flux à travers plusieurs process — le numéro doit rester **unique**

Un flux (§5) numérote chaque mutation (`seq`, strictement croissant). Avec un seul process, un simple compteur local suffit. Avec **plusieurs** process qui peuvent tous les deux appeler `.add()` au même instant, un compteur local ferait des **doublons** (A et B produiraient chacun leur propre « seq 12 ») — le client ne saurait plus s'y retrouver.

**La solution :** le seq devient un compteur **partagé** dans Redis (`INCR`). Avant d'appliquer sa mutation, un process demande à Redis « donne-moi le prochain numéro » — Redis répond un nombre **unique**, jamais donné deux fois, même si dix process le demandent à la même microseconde. Le process applique ensuite localement **avec** ce numéro, et le publie aux autres.

Conséquence pratique : `add()`/`update()`/`remove()`/`reset()` restent des méthodes qu'on appelle sans `await`, mais avec l'adaptateur actif, leur effet n'est plus instantané — il attend l'aller-retour Redis (quelques millisecondes). Sans adaptateur, rien ne change (compteur local, toujours instantané).

**Et si deux messages arrivent dans le désordre ?** Le réseau ne garantit pas l'ordre d'arrivée entre deux publications de **deux** process différents. Chaque process garde donc un petit **tampon de réordonnancement** (100 deltas en attente au maximum, par flux) : un delta qui arrive « trop tôt » (un trou avant lui) est mis de côté jusqu'à ce que le trou se comble. Si le trou ne se comble pas sous 2 secondes (ou si le tampon déborde), le process applique quand même ce qu'il a, dans l'ordre, en sautant le trou — avec un avertissement dans `onLog`. Le client qui détecte un saut de numéro (`seq` en avance sur ce qu'il attendait) redemande automatiquement un rattrapage (`µ:resync`, §5) — le système s'auto-corrige.

Un `µ:resync` couvre aussi bien les deltas produits localement que ceux venus d'un **autre** process : une fois appliqué, un delta distant rejoint le **même** journal que les deltas locaux.

### 9.4 La présence fusionnée — qui est là, sur **toute** la flotte

Chaque process connaît la présence de **ses** propres clients (§4). Pour savoir qui est là sur **toute** la flotte, chaque process publie ses propres arrivées/départs (`join`/`leave`, globaux et par salon) et écoute ceux des autres — il tient alors une vue **fusionnée** : la sienne (réelle, liée à ses connexions) plus celle des autres (un miroir, alimenté par ce qu'ils publient). `GET /presence` (pont) et les abonnements `µ:presence` lisent cette vue fusionnée — un client connecté au process A voit apparaître/disparaître les utilisateurs connectés au process B exactement comme s'ils étaient sur A.

**Et si un process meurt brutalement** (crash, kill -9, machine coupée) — sans prévenir personne ? Ses pairs resteraient « fantômes » indéfiniment dans la vue des autres. Le **bail de vie** règle ça : chaque process pose une petite clé dans Redis avec une durée de vie de 10 secondes (`SET ... EX 10`), et la renouvelle toutes les ~3 secondes tant qu'il est vivant. Les autres process vérifient périodiquement (même cadence, ~3 s) que les process dont ils connaissent des pairs distants ont **toujours** un bail vivant. Dès qu'un bail a expiré (le process n'a pas renouvelé — mort, ou réseau coupé), ses pairs distants sont purgés **partout** ailleurs, avec les `leave` correspondants envoyés aux abonnés locaux — exactement comme une vraie déconnexion.

### 9.4bis Anti-entropie de présence

Le bail ci-dessus ne corrige que la mort d'un process **entier** — un pair fantôme ou manquant sur un process resté **vivant** (coupure Redis brève, message pub/sub perdu) peut y survivre indéfiniment, puisque rien ne le détecte. Chaque process publie donc, toutes les **15 secondes** (configurable), un instantané compact de sa présence **locale** ; les autres le comparent à leur vue distante de ce process précis et corrigent les écarts EN **silence** (pair inconnu → `join`, pair disparu → `leave`, avec les **mêmes** trames `µ:presence` que d'habitude) — un instantané déjà conforme à la vue locale ne produit ni trame ni mutation.

Se désactive avec `antiEntropy: false` (racine des options `mjsWs()`, ou `ws.adapter.antiEntropy` dans `mjs.config.json`/l'entry) — comportement alors identique à avant ce mécanisme.

### 9.5 Sessions et reprise — restent **locales**

La reprise de session (§8) vit **en mémoire, par process** — l'adaptateur ne la rend **pas** globale. Un client qui revient après une coupure doit retomber sur le **même** process pour que sa session soit reconnue ; s'il retombe sur un **autre** process (répartiteur qui l'envoie ailleurs), ce process ne connaît pas sa session → accueil **frais**, automatiquement et sans erreur (c'est déjà le comportement par défaut d'une session inconnue, §8.2 — rien à coder de plus).

**Pour profiter de la reprise en multi-processus :** configure ton répartiteur de charge en **sessions collantes** (« sticky sessions » — chaque client WebSocket est ré-envoyé au **même** process tant que sa connexion tient). Nginx (`ip_hash` ou un cookie), HAProxy, la plupart des load balancers cloud savent le faire. Sans ça, la reprise ne casse rien (elle échoue juste silencieusement, accueil frais) — mais elle ne sert à rien non plus.

### 9.6 Coupure Redis — la limite honnête

L'adaptateur reconnecte tout seul en cas de coupure Redis (backoff 1 s, 2 s, 5 s, 10 s — puis reste à 10 s). Pendant la coupure :

- Les **publications** (broadcast, salon, présence…) échouent silencieusement côté émetteur — un avertissement dans `onLog`, jamais un crash ni un blocage. Les clients **locaux** du process ne sont pas affectés (l'application locale a déjà eu lieu **avant** la publication, §9.2).
- Les **deltas de flux** produits par un **autre** process **pendant** la coupure ne sont jamais reçus — à la reconnexion, rien ne les rattrape automatiquement (Redis pub/sub n'a pas de mémoire : un message publié pendant que tu n'écoutais pas est perdu pour toujours, contrairement au journal **local** d'un flux, §5, qui lui ne connaît pas Redis). **Conséquence honnête : une divergence est possible** entre les process pendant/après une coupure Redis.
- **Le remède pratique :** un `stream.reset(valeurs)` (n'importe quel process, une fois Redis revenu) republie l'état complet et fait repartir tout le monde de la **même** photo — la façon la plus simple de refermer une divergence.
- **La solution complète** (aucune perte, même pendant une coupure) demanderait un journal **persistant** côté Redis (Redis Streams, avec relecture depuis le dernier point vu) — hors périmètre de cette étape, notée comme piste pour plus tard.

### 9.7 Zéro dépendance — le mini-client Redis maison

Aucun paquet `redis`/`ioredis`/`node-redis` n'est ajouté. `src/mjs-ws/adapter-redis.ts` parle directement le protocole texte de Redis (RESP) sur une connexion `node:net` brute : encodage des commandes (`PING`, `PUBLISH`, `SUBSCRIBE`, `INCR`, `SET ... EX`, `GET`, `DEL`, `KEYS`), et un petit parseur **incrémental** qui sait reconstituer une réponse même arrivée en plusieurs morceaux sur le réseau (TCP ne respecte pas les frontières de message). Deux connexions par process — une dédiée aux abonnements (`SUBSCRIBE`), une aux commandes — parce que Redis l'exige (une connexion abonnée ne peut plus parler qu'un sous-ensemble limité de commandes).

### 9.8 Tester sans Redis — `MemoryAdapter`

Comme `MemoryTransport` (transport en mémoire, pour les tests) a son pendant : `MemoryAdapter`, un bus **partagé** en mémoire, à donner à plusieurs `mjsWs()` **dans le même** process de test — simule fidèlement plusieurs process réels (même filtrage « je m'ignore moi-même », même compteur global pour les flux, même mécanique de bail de vie avec horloge injectable pour simuler une expiration sans vrai délai).

```js
import { mjsWs, MemoryAdapter, createMemoryAdapterBus } from 'modularjs-framework/ws'

const bus  = createMemoryAdapterBus()
const appA = mjsWs({ adapter: new MemoryAdapter({ bus }), /* ... */ })
const appB = mjsWs({ adapter: new MemoryAdapter({ bus }), /* ... */ })
// appA.broadcast(...) est reçu par les clients connectés à appB, et réciproquement
```

---

<a id="etat-serveur"></a>
## 10. L'état du serveur

Un registre de compteurs **léger** — connexions, messages, salons, flux, garde, pont, adaptateur, sessions, latences ping, erreurs/avertissements — tourne **en permanence** dans `mjsWs`, sans configuration : `app.stats()` renvoie un instantané JSON à tout moment (uptime, id de processus, mémoire, et toutes les familles ci-dessus). Le coût est négligeable (des `++` sur des compteurs déjà là), donc ce registre n'a **pas d'interrupteur** — seule son **exposition en HTTP** (sur le pont, §7) est une option.

### 10.1 Activer — `opts.stats`

```js
const app = mjsWs({
  bridge: { secret: 'env:MJS_WS_BRIDGE_SECRET' },   // requis pour SERVIR les endpoints en HTTP
  stats:  true,
})
```

`stats: true` ajoute trois endpoints au pont (§7) :

| Endpoint | Rôle |
|---|---|
| `GET /stats` | Le même instantané que `app.stats()`, en JSON. |
| `GET /metrics` | Le même instantané, au format texte **Prometheus** (`# TYPE mjs_ws_x gauge` puis `mjs_ws_x 3`, tous les noms préfixés `mjs_ws_`, latences en `mjs_ws_ping_p50_ms`/`mjs_ws_ping_p95_ms`). |
| `GET /state` | Une page HTML **sombre**, autonome (aucune ressource externe), qui affiche une grille de cartes par famille et se rafraîchit toute seule toutes les 2 s (`fetch('/stats')`, même origine). Pratique pour un coup d'œil en dev, sans outil externe. |

Sans `opts.bridge`, `stats: true` n'a **aucun effet observable** : il n'y a pas de serveur HTTP pour servir ces trois routes. Sans `opts.stats` (défaut), ces trois routes répondent **404** (même pont, mêmes autres endpoints) — mais `app.stats()` fonctionne quand même, tout le temps.

### 10.2 La règle de signature — loopback = libre, distant = signé

Ces trois endpoints suivent la **même** règle de signature que le reste du pont (§7.2, HMAC-SHA256) — **sauf un cas** : si le pont écoute sur `127.0.0.1` ou `::1` (le défaut), `/stats`, `/metrics` et `/state` répondent **sans aucune signature**. C'est un outil de dev local : sur ta machine, un simple `curl http://127.0.0.1:4001/state` ou un onglet de navigateur suffit, pas besoin de fabriquer une requête signée à la main.

Dès que le pont écoute ailleurs (`host` configuré à autre chose que loopback — accessible depuis le réseau), la signature redevient **obligatoire partout**, sans exception : ces trois endpoints exposent l'état interne du serveur, jamais sans preuve d'identité en dehors de la machine elle-même. Cette question (« le host est-il loopback ? ») est tranchée à un **seul** endroit (`isLoopbackHost`, exportée), réutilisé pour la gate de signature ET pour la bannière de `mjs ws` (qui n'affiche le lien `état : http://…/state` que lorsqu'il est vraiment cliquable sans signature).

### 10.3 Stats par processus — la limite honnête avec l'adaptateur

Le registre est **local à chaque processus** — il ne connaît que ce que CE process a vu passer. Avec l'adaptateur multi-processus (§9), chaque process `mjsWs` a le **sien**, jamais fusionné automatiquement : `app.stats()` (ou `GET /stats`) sur le process A ne montre **que** l'activité de A, pas celle de B ou C. Pour une vue de toute la flotte, ton back interroge `GET /stats` sur **chaque** process (round-robin derrière le répartiteur, ou une adresse directe par process) et additionne côté back — exactement comme `GET /presence` (§9.4) le ferait s'il n'était pas, lui, fusionné en interne. Deux compteurs de la famille `adaptateur` (`ignoresOrigin`, `reconnexions`) restent à `0` avec l'adaptateur Redis à ce stade (câblés pour `MemoryAdapter`, dont le bus en mémoire les expose directement ; l'instrumentation du mini-client Redis pour ces deux-là reste à faire) — `publies`, `recus` (pub/sub cross-process) et `reordonnances` (tampon de réordonnancement des flux, §9.3) sont, eux, exacts avec les deux adaptateurs.

<a id="contrat-type"></a>
## 11. Contrat typé (optionnel) — auto-complétion + erreurs de compilation

`serve`/`on`/`send`/`request` acceptent un nom de type en **chaîne libre** — pratique, mais rien
n'empêche un `.server.mjs` et un composant `.mjs` de diverger silencieusement (un `prix` renommé
`prixTTC` côté serveur, l'ancien nom continue de compiler côté client, l'erreur n'apparaît qu'au
run). `src/mjs-ws/contract.ts` ajoute une **surcouche de typage optionnelle** — patron [tRPC](https://trpc.io)
adapté à MJS : l'appli déclare UN contrat TypeScript partagé, importé **en type** des deux côtés.
Toucher un mauvais payload, un nom de type inconnu, ou un mauvais type de retour devient une
erreur `tsc`, avant même d'ouvrir le navigateur.

### 11.1 La réalité, honnêtement

Un `.server.mjs` et un composant `.mjs` sont compilés **séparément** (dialecte Civet propre à
chacun, cf. §6.1/§13) — il n'existe **aucun lien runtime** entre les deux. Le contrat ne change
rien à ça : c'est un fichier `.ts` **ordinaire**, importé `import type { ... }` des deux côtés au
moment où **l'outillage TypeScript de ton appli** (ton éditeur, ton `tsc` à toi, pas celui de
ModularJS) type-checke tes fichiers — jamais exécuté, jamais bundlé. `asTypedApp`/`asTypedSocket`
sont des fonctions qui **renvoient leur argument tel quel** :

```ts
export function asTypedApp<C extends MjsWsContract>(app: MjsWsApp, contract?: C): TypedApp<C> {
  return app as TypedApp<C>
}
```

Zéro branche nouvelle, zéro octet ajouté au bundle client, zéro coût serveur — seulement des
`type`/`interface`/generics, effacés à la compilation comme n'importe quelle annotation TS.

### 11.2 Le contrat partagé

```ts
// contrat.ts — partagé entre ws.server.mjs et tes composants, importé EN TYPE des deux côtés
import type { MjsWsContract } from 'modularjs-framework/ws'

export interface MonContrat extends MjsWsContract {
  serves: {
    achat: (p: { prix: number }) => { solde: number }
  }
  sends: {
    chat: { texte: string; auteur: string }
  }
}
```

Les trois clés de `MjsWsContract` (`serves`, `sends`, `presences`) sont **optionnelles** —
adoption incrémentale : un contrat qui ne déclare que `sends` laisse `serve`/`request` aussi
libres qu'aujourd'hui. `extends MjsWsContract` n'est même pas obligatoire, le typage structurel de
TS suffit — une interface qui a la même forme convient.

### 11.3 Côté serveur — `ws.server.mjs`

```civet
import type { MonContrat } from './contrat.ts'
@import asTypedApp 'modularjs-framework/ws'

export default {
  auth: (hello)-> hello.auth?.token is process.env.SECRET and { id: hello.auth.userId }

  setup: (app)->
    typed = asTypedApp<MonContrat>(app)
    typed.serve 'achat', (p, client)->
      throw new Error('solde insuffisant') if p.prix > 100
      { solde: 100 - p.prix }                      # p.prix inféré number, retour vérifié {solde}

    typed.on 'chat', (p, client)-> typed.broadcast('chat', p, { except: client })
}
```

### 11.4 Côté client — un composant `.mjs`

```civet
<script>
  import type { MonContrat } from '../contrat.ts'
  import { asTypedSocket } from 'modularjs-framework/ws'

  sock  = µ.socket('wss://jeu/play')
  typed = asTypedSocket<MonContrat>(sock)

  achete = ->
    try
      resp = await typed.request('achat', { prix: 40 })   # résultat inféré {solde: number}
      µ.log "nouveau solde : #{resp.solde}"
    catch e
      µ.error 'achat refusé :', e
</script>
```

### 11.5 Ce que `tsc` attrape

Renomme `achat` en `achatTTC` côté serveur (ou change la forme de `p`) sans toucher au client :

```ts
await typed.request('achat', { prix: 40 })
//                   ~~~~~~~
// error TS2345: Argument of type '"achat"' is not assignable to parameter of type '"achatTTC"'.
```

Un mauvais payload (`{ pri: 40 }` au lieu de `{ prix: 40 }`) ou un mauvais type de retour côté
`serve` (`{ sold }` au lieu de `{ solde }`) donnent le même genre d'erreur, **avant** de lancer
quoi que ce soit — cf. `tests/contract-types.test.ts` pour la liste vérifiée (chaque cas y est
prouvé par un `// @ts-expect-error` que `tsc --noEmit` doit valider).

`TypedApp<C>`/`TypedSocket<C>` ne bornent que `serve`/`on`/`send`/`sendUser`/`request`/`presence`
— `room`/`stream`/`broadcast`/`schema`/`stats`… traversent **inchangés**, aussi libres qu'avant.
Pour le contrat d'un jeu (`app.game`/`sock.game`), cf. [24 · MJS-Server « Contrat typé »](24-mjs-server.md#contrat-type-jeu).

---

<a id="transport-facade"></a>
## 12. La façade transport : brancher uWebSockets.js (ou autre chose)

Tout ce que `mjsWs` fait avec le réseau passe par **une** interface, `MjsWsTransport` — le cœur du protocole (§1-§10) ne connaît **jamais** `ws` ni un socket natif directement. `opts.transport` (§1) accepte trois formes :

| Forme | Résultat |
|---|---|
| absent, ou `'ws'` | `WsTransport` — bibliothèque [`ws`](https://github.com/websockets/ws), déjà une dépendance de ModularJS, rien à installer. **Le défaut.** |
| `'uws'` | `UwsTransport` — [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js), pour les très gros volumes de connexions (§12.1). Paquet natif à installer À **part** (§12.3) — **pas** une dépendance de ModularJS. |
| une instance déjà construite | Utilisée **telle quelle** — `MemoryTransport` en test (§2, aucun socket réseau), ou un transport **maison** (§12.4) qui parle un tout autre canal bas niveau. |

```js
import { mjsWs } from 'modularjs-framework/ws'

const app = mjsWs({ transport: 'uws', /* ...auth/welcome/rooms, comme d'habitude (§1)... */ })
await app.listen()
```

Avec `mjs ws` (§6), le choix se fait aussi dans `mjs.config.json` (`ws.transport: 'ws'|'uws'`, validation stricte avec suggestion orthographique sur une faute de frappe) ou dans l'entry (`transport: new MonTransport()`, une **instance** — la config JSON ne peut exprimer qu'une chaîne) : même règle que `heartbeat`/`limits` (§6.4), l'entry prime EN **bloc** en cas de doublon. La bannière de démarrage affiche le transport actif (`transport : ws (bibliothèque 'ws')`, `transport : uws (uWebSockets.js)`, ou `transport : personnalisé (instance fournie par l'entry)`).

### 12.1 Pourquoi changer de transport ?

`ws` est une bibliothèque JS pure, simple et largement éprouvée — le bon choix par défaut. `uWebSockets.js` est écrit en C++ (binding natif) et vise **une** chose : encaisser **beaucoup** plus de connexions simultanées avec **beaucoup** moins de mémoire et de CPU par connexion. La différence ne se voit qu'à partir de dizaines de milliers de connexions concurrentes — en dessous, `ws` suffit largement et évite d'installer un paquet natif (compilation binaire propre à chaque plateforme).

### 12.2 Activer uWebSockets.js — `transport: 'uws'`

```js
const app = mjsWs({
  transport: 'uws',
  // port/host s'appliquent pareil qu'avec 'ws' (§1)
})
```

Transparent pour l'application — le protocole `µ:`, les protections (§3), les salons (§4), les flux (§5)… tout est **identique**. Deux réglages internes sont nécessairement différents, et déjà câblés pour toi :

| Réglage uWS natif | Valeur posée | Pourquoi |
|---|---|---|
| `maxPayloadLength` | `limits.maxPayload` (§3, 65536 par défaut) | uWS refuse nativement une trame plus grande que ce réglage — sans ce câblage, son propre défaut (16 Ko) serait **plus petit** que celui de MJS-WS et rejetterait des trames que `ws` aurait acceptées telles quelles. |
| `idleTimeout` | `0` (désactivé) | MJS-WS a **déjà** son propre Watchdog applicatif (`heartbeat × 2.5`, §3) — **seule** autorité d'inactivité pour **tous** les transports (`ws` non plus n'a pas de kill natif). Garder le timeout natif de uWS EN **plus** ferait doublonner la protection avec une fermeture hors du contrat `µ:` (code natif, pas de raison lisible, compteurs de garde faussés). Alignement retenu : une seule autorité, un comportement **identique** quel que soit le transport — y compris `heartbeat: 0` (jamais de kick, des deux côtés). |

### 12.3 Installer le paquet

```bash
npm install uNetworking/uWebSockets.js#v20.52.0
```

uWebSockets.js n'est **pas** une dépendance de ModularJS (paquet natif, une release par version de Node/OS — l'installer systématiquement alourdirait **tous** les projets ModularJS, même ceux qui n'en ont jamais besoin). Sans lui, `transport: 'uws'` échoue au démarrage (`.listen()`) avec un message clair, jamais un crash silencieux :

```
le paquet uWebSockets.js est requis pour transport: 'uws' — npm install uNetworking/uWebSockets.js#v20.52.0
```

### 12.4 Brancher **autre chose** — l'interface `MjsWsTransport`

```ts
interface MjsWsConnection {
  readonly bufferedAmount: number
  readonly remoteInfo: { origin?: string; headers?: Record<string, string | string[] | undefined> }
  send(data: string): void
  close(code?: number, reason?: string): void
  onMessage: ((data: string) => void) | null
  onClose: ((code: number, reason: string) => void) | null
}

interface MjsWsTransport {
  onConnection(handler: (conn: MjsWsConnection) => void): void
  start(): Promise<void>
  stop(): Promise<void>
}
```

C'est **tout** ce que `mjsWs` demande à un transport — trois méthodes, une poignée de connexion. Squelette d'adaptateur maison (un canal **ipc**, un pont vers un autre protocole bas niveau, une queue de messages…) :

```ts
import type { MjsWsConnection, MjsWsRemoteInfo, MjsWsTransport } from 'modularjs-framework/ws'

class MonTransportMaison implements MjsWsTransport {
  private handler: ((conn: MjsWsConnection) => void) | null = null

  onConnection(handler: (conn: MjsWsConnection) => void): void {
    this.handler = handler   // core.ts appelle ceci UNE fois, avant start()
  }

  async start(): Promise<void> {
    // ... branche ton canal bas niveau ici (écoute, upgrade, whatever) ...
    // à CHAQUE nouvelle connexion entrante :
    const remoteInfo: MjsWsRemoteInfo = { origin: undefined, headers: {} }
    const conn: MjsWsConnection = {
      // getter — pas une constante figée : DOIT refléter la mesure COURANTE de ton
      // canal à chaque lecture (0 si ton canal n'a pas de notion de tampon)
      get bufferedAmount() { return 0 },
      remoteInfo,
      send(data) { /* ... envoie `data` (une chaîne JSON) au pair ... */ },
      close(code, reason) { /* ... ferme proprement, informe le pair si ton protocole le permet ... */ },
      onMessage: null,   // core.ts POSE ce callback juste après — jamais avant
      onClose: null,     // idem
    }
    this.handler?.(conn)
    // ... et quand une trame arrive vraiment : conn.onMessage?.(texteRecu) ...
    // ... et quand ça se ferme vraiment (peu importe qui a fermé) : conn.onClose?.(code, raison) ...
  }

  async stop(): Promise<void> {
    // ... arrête d'accepter de nouvelles connexions ...
  }
}

const app = mjsWs({ transport: new MonTransportMaison() })
```

Contrat à respecter (core.ts s'appuie dessus **sans** vérification défensive supplémentaire) :

- `onConnection(handler)` est appelé **une** fois, avant `start()` — stocke juste `handler`.
- `start()` ne résout **que** quand le transport est prêt à accepter des connexions (`app.listen()` attend cette promesse).
- Pour **chaque** connexion entrante, appelle `handler(conn)` — c'est core.ts qui pose **ensuite** `conn.onMessage`/`conn.onClose` : ton transport ne fait que les **appeler** quand un événement survient, jamais les définir lui-même.
- `send()`/`close()` ne doivent **jamais** lancer d'exception — ni pour un envoi normal, ni pour un envoi sur une connexion qui vient de se fermer (le silence est attendu : `guard.ts`, le videur, compte déjà lui-même la contre-pression et les échecs au niveau applicatif).
- `bufferedAmount` doit rester lisible à tout moment (`0` si ton canal n'a pas de notion de tampon).

### 12.5 Le piège spécifique à uWebSockets.js (pour qui lirait/adapterait transport-uws.ts)

⚠️ **Un objet `ws` uWebSockets.js devient invalide dès l'instant où sa connexion se ferme** — le toucher après (même juste **lire** une propriété comme `getBufferedAmount()`) fait planter le **process Node entier**, pas juste lever une exception JavaScript rattrapable. `transport-uws.ts` pose donc un drapeau `_closed` sur chaque connexion, réglé **avant** tout appel natif de fermeture et vérifié en tête de `send()`/`close()`/`bufferedAmount` — jamais un accès direct à l'objet natif ailleurs. Ce piège n'existe **pas** avec `ws` (bibliothèque JS pure, tolère un appel tardif — silencieusement ou via une exception normale) : c'est spécifique aux bibliothèques natives/bindings C++, à garder en tête pour tout **autre** transport natif qu'on brancherait un jour.

---

<a id="civet-entry"></a>
## 13. Écrire son fichier serveur — le dialecte de tes composants

L'entry de `mjs ws` (§6.1) est compilée À LA **volée**, sans étape de build séparée — que ce soit au format **recommandé** `ws.server.mjs` (dialecte Civet des composants, exemple complet en §6.1) ou dans la variante Civet brut `ws.civet` (§13.3 ci-dessous).

### 13.1 Comment ça marche, simplement

À chaque (re)chargement de l'entry, `mjs ws` lit le fichier et le compile en JavaScript via le compilateur Civet **déjà utilisé par ModularJS** pour tes composants `.mjs` (`@danielx/civet` — **même** API, **aucune** dépendance de plus) — pour un `.server.mjs`, en appliquant **d'abord** les mêmes pré-passes de dialecte que le `<script>` de tes composants (assignations nues auto-déclarées, interpolation `"#{x}"`, `isnt`… — cf. l'encadré des 3 pièges, §6.1), **aucune** transformation de symbole réactif ($x/@x/§/µ-runes) : un fichier serveur n'a ni réactivité ni DOM. Le résultat est écrit dans un **vrai fichier**, sous `<root>/node_modules/.cache/mjs/server/` (repli `os.tmpdir()` si `<root>/node_modules` n'existe pas), puis importé par une URL `file://`. Le rechargement à chaud (§6.5) fonctionne **pareil** qu'avec un entry `.js` : cache-busting explicite (`?v=n` sur l'URL, incrémenté à chaque recompilation).

Une erreur de syntaxe est rapportée clairement, avec le nom du fichier :

```
[mjs ws] erreur de compilation dans '/chemin/vers/ws.server.mjs' : ws.server.mjs:3:5 Failed to parse …
```

Au démarrage, cette erreur empêche `mjs ws` de partir (comme un entry `.js` invalide). En rechargement à chaud, **même** comportement que pour du JS cassé (§6.5) : l'erreur est loguée et l'**ancien** serveur continue de tourner, zéro coupure.

Un `.server.mjs` qui contient du **markup** de composant (`<template>`, `<style>`, une balise HTML en tête de fichier) est refusé avant même la tentative de compilation, avec une erreur qui nomme la balise trouvée : un fichier serveur n'est pas un composant.

### 13.2 Importer quelque chose — la grammaire `@import`

Le fichier compilé vit dans le dossier de **cache** ci-dessus, pas à côté de ton entry — un `import … from` **natif** (JS/Civet standard), un ré-export `export … from '…'`, ou un `import('…')` **dynamique** d'un chemin littéral sont refusés à la compilation, avec un message qui nomme ton entry et la cible visée (`import(variable)`, calculé à l'exécution, reste possible). La seule façon d'importer un fichier du **projet** est la directive `@import`, celle-là même qu'utilisent tes composants `.mjs` — seule directive qui ait un sens hors DOM dans un fichier serveur :

| Cible `@import` | Résolution |
|---|---|
| `@import x './un-fichier.civet'` (relatif), ou `@import x 'lib/un-fichier.civet'` (SANS préfixe mais présent à côté de l'entry ou sous `--root` — forme **composant**) | ✅ Résolue à côté de l'entry, puis sous `--root` — compilée récursivement (même dialecte ; des `@import` imbriqués sont suivis, avec détection de cycle). |
| `@import default x 'un-paquet-npm'` (nu, par nom — AVEC ou SANS sous-chemin/`@scope` : `un-paquet-npm/sous-chemin`, `@scope/pkg`, `@scope/pkg/sous-chemin`) | ✅ Résolue par Node depuis le dossier de cache — fonctionne dès que `<root>/node_modules` existe (le cache y vit justement, sous `.cache/mjs/server/`) ; repli `os.tmpdir()` sinon, alors introuvable. Un `/` dans le spécificateur ne le fait pas basculer en chemin de projet à lui seul — seule une extension `.civet`/`.mjs` SANS préfixe (ligne ci-dessus) compte comme telle. |
| `@import x 'node:fs'` (et tout `node:*`) | ✅ Toujours — résolution spéciale de Node, indépendante de l'emplacement du fichier. |
| `@import x 'https://…'` | ✅ Laissée telle quelle (aucune résolution : à toi de fournir une URL que Node sait charger). |
| toute autre directive (`@i18n`, `@routes`, `@css`…) | ❌ Erreur de compilation explicite. |

Un commentaire (`#…`, `###…###`, `//…`, `/*…*/`) ou une chaîne (multi-lignes comprise, `'…'`/`"…"`/`'''…'''`/`"""…"""`/`` `…` ``) qui contiendrait du texte ressemblant à une directive (`@param`, `@foo`…) n'est **jamais** lu comme telle — seul du code réel en colonne 0 déclenche la détection.

**En pratique :** un besoin de paquet npm dans l'entry marche directement dès que `npm install` a été lancé dans le projet (`node_modules` présent) — plus besoin d'un entry `.js`/`.mjs` à part ni d'une URL `file://` absolue à la main.

### 13.3 Variante — Civet brut (`ws.civet`)

`ws.civet`/`server/ws.civet` (résolution complète : §6.2) restent une variante documentée : du [Civet](https://civet.dev/) **standard**, compilé **sans** les pré-passes de dialecte du format `.server.mjs` (§6.1, §13.1) — ni assignation nue auto-déclarée, ni interpolation `"#{x}"`, ni `isnt` (les 3 pièges de l'encadré, §6.1), et sans la grammaire `@import` (§13.2) : seuls des imports **natifs** JS/Civet standard sont possibles — un chemin relatif échoue quand même en pratique (le fichier compilé vit dans le dossier de cache, pas à côté du tien), un paquet npm nu ou un `node:*` fonctionnent. Une ligne en colonne 0 qui commence par une directive MJS (`@import`, `@css`, `@routes`…) reste une erreur de compilation explicite, ces directives n'existant que dans le dialecte `.server.mjs`. À réserver à qui veut du Civet nu, sans magie ajoutée par le framework, et connaît ces limites.

```civet
// ws.civet
export default {
  auth: (hello)->
    return false unless hello.auth?.token is process.env.SECRET
    { id: hello.auth.userId, pseudo: hello.auth.pseudo }

  welcome: (client)-> { serverTime: Date.now() }

  setup: (app)->
    app.serve 'achat', (p, client)->
      throw new Error('solde insuffisant') if p.prix > 100
      { solde: 100 - p.prix }

    app.on 'chat', (p, client)-> app.broadcast('chat', p, { except: client })
}
```

(Les accolades du hash **racine** restent nécessaires dès que plusieurs clés portent des fonctions à
**Corps multi-lignes** — l'écriture indentée sans accolades, réservée aux hash simples, redevient
ambiguë pour le parseur au-delà — **même** règle pour `.server.mjs` (cf. l'exemple §6.1, deux clés dont
`setup` à corps multi-lignes). `app.serve`/`app.on` internes, eux, restent en `->` normal.)

---

<a id="statut"></a>
## 14. Statut du module

`mjsWs` couvre :

- le **cœur du protocole `µ:`** — handshake, ping/pong, requêtes/accusés de réception, pub/sub, diffusion ;
- les **protections de série** (§3, « le videur ») — seau à jetons, taille de trame, contre-pression, watchdog, garde process ;
- les **salons et la présence agrégée** (§4 : garde d'admission, méta, expulsion `µ:left`, agrégation multi-onglets par utilisateur) ;
- les **flux à journal borné** (§5 : deltas numérotés, resynchronisation incrémentale, rejeu aux numéros d'origine, `reset` = nouvelle époque) ;
- la **commande `mjs ws`** (§6 : fichier d'entry, section `ws` de la config, rechargement à chaud sans coupure, arrêt propre) ;
- le **pont universel** (§7 : API HTTP signée HMAC-SHA256 anti-rejeu, webhooks sortants à tentatives bornées, jetons JWT HS256 sans dépendance) ;
- la **reprise de session** (§8 : opt-in, client parqué pendant la grâce, tampon borné rejoué dans l'ordre, clé tournée à chaque welcome, présence et webhook disconnect différés) ;
- l'**adaptateur multi-processus** (§9 : mini-client Redis RESP maison zéro dépendance, broadcast/salon/ciblé/flux/présence traversent les process, seq global par `INCR` + tampon de réordonnancement, présence fusionnée à bail de vie, `MemoryAdapter` pour les tests) ;
- l'**état du serveur** (§10 : registre de compteurs toujours actif, `app.stats()`, `GET /stats` JSON + `GET /metrics` Prometheus + page `GET /state` sombre auto-rafraîchie, signés comme le reste du pont sauf en loopback, stats par processus avec l'adaptateur) ;
- **`µschema`** (§3.1) — registre de schémas binaires (`app.schema`/`opts.schemas`, types scalaires/`list`/`bits`, garde d'évolution ajout-seul), trois modes `codec` (`auto`/`binary` strict/`json`), encodage/décodage transparent sur `send`/`sendUser`/`broadcast`/`room().send`, hash stable du registre synchronisé à chaud via `µ:schema` sur désaccord ;
- le **contrat typé** (§11) — surcouche TypeScript optionnelle (`TypedApp`/`TypedSocket`), auto-complétion et erreurs de compilation sur `serve`/`request`/`on`/`send`, coût nul à l'exécution ;
- le **proxy de décisions** (§7.11) — `auth`/`rooms.join` acceptent aussi un objet `{ url, secret, timeout?, cache? }` délégant la décision à un back HTTP signé (façon Centrifugo « proxy »), fonction et objet-proxy cohabitant librement ;
- la **session exclusive par identité** (§8.5) — option opt-in à **deux** modes qui garantit une **seule** connexion par identité : `'replace'` (≡ `true`) — la nouvelle connexion remplace l'ancienne (`µ:bye {reason:'replace'}` + fermeture 4003), y compris les sessions parquées et à travers plusieurs process ; `'refuse'` (inverse) — la connexion existante gagne, la nouvelle est refusée (`µ:denied` + fermeture 4004) tant que l'ancienne vit ; exclusivité par process seulement dans ce 2e mode.

Le tout derrière une **façade de transport ouverte** (`ws` par défaut, `uws`/uWebSockets.js intégré en option, `MemoryTransport` en test, ou un adaptateur maison — cf. §12) et un fichier d'entry qui peut s'écrire dans le **dialecte Civet de tes composants** (`.server.mjs`, **recommandé**), en Civet brut ou en JS classique (§13), testé en boucle complète contre le vrai client `µ.socket` — reconnexions réelles comprises — et contre un vrai Redis local pour l'adaptateur.

---

<a id="aller-plus-loin"></a>
## 15. Aller plus loin

Le module couvre l'usage courant de bout en bout. Pistes **non couvertes**, honnêtes, pour qui voudrait pousser plus loin :

- **Journal Redis Streams contre la divergence en coupure** (cf. §9.6) — la solution complète (aucune perte de delta multi-process pendant une coupure Redis) demande un journal persistant côté Redis, hors périmètre actuel.
- **Topics typés TS — comblé partiellement** (§11) — `serve`/`request`, `send`/`on` (MJS-WS) et `move`/`state` (MJS-Server, [24 · MJS-Server](24-mjs-server.md#contrat-type-jeu)) ont un contrat TypeScript optionnel, à coût nul à l'exécution. Restent en nom de canal **libre**, non bornés au contrat : `stream`/`presence` côté MJS-WS, `room().send`, et les intentions du mode action (MJS-Server `def.intents`).
- **Codec binaire** — `parse`/`serialize` sont personnalisables (§1) mais aucun codec binaire clé-en-main (MessagePack, Protobuf…) n'est fourni.
- **Compensation de latence côté client** — `µsmooth` ([20 · Temps réel §6](20-temps-reel.md)) lisse déjà l'affichage par interpolation, mais une vraie compensation (extrapolation, réconciliation serveur) reste à la charge de l'application.
- **Module serveur de jeu** — boucle de simulation, autorité serveur, zones d'intérêt : hors périmètre de `mjsWs`, qui reste un transport temps réel générique, pas un moteur de jeu. Le tour par tour événementiel (appariement, sièges, vue par joueur), lui, est couvert par [24 · MJS-Server](24-mjs-server.md), une couche optionnelle composée par-dessus — la boucle à tick/simulation continue reste hors périmètre pour l'un comme pour l'autre.

👉 Pour voir tout ça tourner : la leçon tuto **[Le serveur officiel (mjs ws)](/tuto#/serveur-mjs-ws)**.
