# 26 · Chat — module temps réel prêt à l'emploi (au-dessus de MJS-WS)

> **Module optionnel.** Le paquet Chat compose des salons de discussion à historique — par-dessus [23 · MJS-WS](23-mjs-ws.md), sans le modifier, via le mécanisme des paquets activables (`app.use`). Tant que tu n'appelles pas `app.use(chatPackage(...))`, son coût est **nul**.

```ts
// serveur — TypeScript classique (chatPackage est une simple composition app.use(), pas une
// déclaration façon app.game() de MJS-Server — pas de dialecte Civet dédié ici)
import { mjsWs, chatPackage } from 'modularjs-framework/ws'

const app = mjsWs({ auth: (hello) => ({ id: hello.auth?.id, name: hello.auth?.name }) })
app.use(chatPackage())
await app.listen()
```

Côté client, `sock.chat('general')` suffit — rejeu de l'historique au join, envoi, indicateur de frappe et résolution de l'identité sont **déjà gérés** :

```civet
room = sock.chat('general')

sendOnEnter = (e)->
  return unless e.key is 'Enter'
  room.send($text)
  $text = ''
```
```html
{for m in room.messages}
  <p>{m.from.name} : {m.text}</p>
{end}
<input value=!{$text} @input={room.typing()} @keydown={sendOnEnter}>
```

---

## Sommaire

1. [Philosophie](#philosophie)
2. [Démarrer](#demarrer)
3. [Options — `chatPackage(opts)`](#options)
4. [Le client — `sock.chat`](#le-client)
5. [Modération](#moderation)
6. [Frappe](#frappe)
7. [Limites v1 — honnêtement](#limites)
8. [Annexe — erreurs `chat-*` et protocole](#annexe)

---

<a id="philosophie"></a>
## 1. Philosophie

Un salon de discussion redemande toujours la même mécanique — historique au join, débit par utilisateur, modération, indicateur de frappe. Le paquet Chat la fournit **une fois**, composée **sur** l'API publique de [23 · MJS-WS](23-mjs-ws.md#salons-presence) (`app.room(x).history(n)` en épine dorsale) — jamais par réimplémentation des salons eux-mêmes. L'état ne fait confiance à **rien** venu du client : identité, pseudo et horodatage de chaque message sont toujours résolus côté serveur.

---

<a id="demarrer"></a>
## 2. Démarrer

```ts
// chat.server.ts
import { mjsWs, chatPackage } from 'modularjs-framework/ws'

const app = mjsWs({
  auth: (hello) => ({ id: hello.auth?.id, name: hello.auth?.name }),
})

app.use(chatPackage({
  moderators: (identity) => (identity as { role?: string })?.role === 'admin',
}))

await app.listen()
```

```civet
// composant .mjs — dialecte Civet des composants
room = sock.chat('general')

sendOnEnter = (e)->
  return unless e.key is 'Enter'
  room.send($text)
  $text = ''
```
```html
{for m in room.messages}
  <p><strong>{m.from.name}</strong> : {m.text}</p>
{end}

{if room.typingUsers.length}
  <p class="frappe">{room.typingUsers.join(', ')} écrit…</p>
{end}

<input value=!{$text} @keydown={sendOnEnter} @input={room.typing()}>
```

C'est tout ce qu'il faut pour un salon complet — historique rejoué au join, débit par identité, modération et indicateur de frappe. Le protocole `chat:*` qui transporte tout ça reste **invisible** ; ni l'appli serveur ni l'appli cliente n'y touchent directement (cf. [§8](#annexe) pour l'inventaire bas niveau).

---

<a id="options"></a>
## 3. Options — `chatPackage(opts)`

| Clé | Défaut | Effet |
|---|---|---|
| `prefix` | `'chat:'` | Préfixe des noms de salon MJS-WS — `app.room(prefix + room)`. |
| `maxLength` | `2000` | Longueur maximale d'un message (caractères). Au-delà, ou texte vide/non-chaîne : rejet `chat-length`. |
| `rateLimit` | `{ rate: 1, burst: 5 }` | Seau à jetons **par identité ET par salon** (cf. `MjsWsLimits.rate`/`burst`, même vocabulaire) — au-delà : `chat-rate`. |
| `history` | `100` | Messages rejoués au join (`room().history(n)`, [23 · MJS-WS §4.1](23-mjs-ws.md#salons-presence)). `<= 0` désactive le rattrapage. |
| `canJoin` | absent | Garde d'accès à un salon, **réévaluée à chaque action chat** (send/typing/modération) — même contrat que `MjsWsRoomsOptions.join` (rooms.ts), cf. encart ci-dessous. |
| `onMessage` | absent | `(ctx) => …` — transforme (retour `{ text }`) ou rejette (retour `false`/throw → `chat-denied`) un message déjà validé, juste avant diffusion. |
| `moderators` | absent | `(identity) => bool` — réservé aux actions de modération ([§5](#moderation)). |

> ⚠️ **`canJoin` n'est pas un filtre sur `µ:join`.** Un paquet installé via `app.use()` est composé **après** la construction de l'app (`mjsWs()`) — il ne peut pas s'y raccrocher : l'adhésion au salon MJS-WS bas niveau (présence, `.has(client)`, rejeu d'historique) reste **seule** gouvernée par `mjsWs({ rooms: { join } })`, cf. [23 · MJS-WS §4](23-mjs-ws.md#salons-presence). `canJoin` ici est un filet **supplémentaire**, au niveau message : si tu veux réellement empêcher l'adhésion à un salon `chat:*`, configure `rooms.join` sur `mjsWs()` — chatPackage délègue à cette garde existante plutôt que d'en réinventer une (même contrat `MjsWsJoinFn`, réutilisable tel quel aux deux endroits).

`ctx` transmis à `onMessage` : `{ text, room, client, identity }` (`identity` est un raccourci vers `client.identity`).

---

<a id="le-client"></a>
## 4. Le client — `sock.chat`

Posé par-dessus `µ.socket` (module runtime `chat`, cf. [§7](#limites) pour la sélection du runtime) :

```civet
room = sock.chat('general')                        # store réactif plat, join immédiat
room = sock.chat('general', { prefix: 'room:' })  # préfixe personnalisé — DOIT correspondre à
                                                       # chatPackage(opts).prefix côté serveur
```

`sock.chat()` renvoie le store **immédiatement** — jamais une Promise nue (même choix que `stream()`/`presence()`/`sock.game()`, [20 · Temps réel](20-temps-reel.md)).

| Clé | Type | Sens |
|---|---|---|
| `messages` | tableau | Ordonnés par `ts` **serveur**, dédupliqués par `id` (rejeu d'historique au join ET à la reconnexion). Un message retiré (modération, [§5](#moderation)) en est filtré. |
| `typingUsers` | tableau de chaînes | Pseudos en train d'écrire — expiration locale ~5 s sans nouvelle frappe reçue (cf. [§6](#frappe)). |
| `me` | `{id, name}` \| `null` | Identité résolue **côté serveur** (requête `chat:me`) — `null` tant que la réponse n'est pas encore revenue. |
| `send(text)` | fonction | Envoie un message — **fire-and-forget** (aucun ack, aucune Promise, cf. [§8](#annexe)). |
| `typing()` | fonction | Signale « je suis en train d'écrire » — throttlé **serveur** (~3 s par identité, [§6](#frappe)). |
| `close()` | fonction | Quitte le salon (`µ:leave`) et purge le store local. |
| `remove(id)` | fonction | Retire un message — réservé aux `moderators` ([§5](#moderation)). |
| `mute(identityId, durationMs)` | fonction | Rend muette une identité pour une durée — réservé aux `moderators` ([§5](#moderation)). |

> ⚠️ **`remove`/`mute` vont au-delà du store minimal envisagé au départ** (`{ messages, send, typing, typingUsers, me, close }`) : sans eux, la modération ([§5](#moderation)) resterait inatteignable depuis `sock.chat()` — un appel par un compte non-`moderators` est rejeté serveur (`chat-denied`), sans effet visible.

### Erreurs — `sock.lastError`

`send()`/`typing()` ne renvoient rien (pas de Promise, contrairement à `game.move()` de [24 · MJS-Server](24-mjs-server.md#le-client)) : un refus serveur arrive en `µ:error {message: 'chat-length'|'chat-rate'|'chat-denied'|'chat-muted'}`, exposé via `sock.lastError` — même mécanique que le reste de MJS-WS (cf. [20 · Temps réel](20-temps-reel.md)). Cf. [§8](#annexe) pour le détail de chaque code.

### Reconnexion — resync **automatique**

Aucune logique dédiée : `sock.room()` (posé en interne par `sock.chat()`) rejoint le salon à nouveau automatiquement à la reconnexion — le salon MJS-WS rejoue alors son historique comme à tout `µ:join`, la dédup par `id` absorbe les doublons. `.me` n'est demandé qu'une fois (au premier join disponible), pas à chaque reconnexion — l'identité ne change pas en cours de session dans l'usage normal.

### Plusieurs salons, plusieurs poignées

Chaque `sock.chat(nom)` est une poignée **indépendante** (aucun singleton par nom, même choix que `sock.game()`) — ouvrir deux fois le même nom sur un même socket duplique le store en mémoire mais partage la **même** adhésion `sock.room()` sous-jacente : fermer l'une des deux quitte le salon pour de bon, même si l'autre poignée reste ouverte (limite déjà assumée par `sock.room()` lui-même).

---

<a id="moderation"></a>
## 5. Modération

Réservée aux identités pour lesquelles `opts.moderators(identity)` renvoie `true` — vérifiée à chaque action de modération, jamais mise en cache.

```civet
room.remove(messageId)                    # retire un message
room.mute(someIdentityId, 5 * 60 * 1000)  # 5 minutes de silence
```

**Suppression.** `room.remove(id)` diffuse un événement de retrait (`chat:removed`) consommé par **tous** les clients du salon — le message disparaît de `.messages` chez chacun, qu'il ait déjà été affiché ou qu'il arrive après coup. `room().history()` (23 · MJS-WS §4.1) n'offre **aucune primitive de suppression rétroactive** d'une entrée de son journal (anneau append-only, cf. [23 · MJS-WS §4.1](23-mjs-ws.md#salons-presence)) : le retrait ne réécrit donc jamais le passé, il diffuse seulement un événement ultérieur — **tombstone côté client**, jamais une vraie purge du journal serveur. Un retrait est toujours envoyé **après** son message, jamais évincé du journal avant lui (il est structurellement plus récent) : un rejoueur tardif peut recevoir un message déjà retiré (rare, si le retrait est lui-même tombé de l'anneau depuis), **jamais l'inverse**.

**Muet.** `room.mute(identityId, durationMs)` rejette les messages de cette identité (`chat-muted`) pendant `durationMs`, dans CE salon uniquement — mémoire **process** (v1) : sur un déploiement multi-processus (adaptateur cluster, [23 · MJS-WS §9](23-mjs-ws.md#adaptateur-redis)), un client reconnecté sur un **autre** processus n'est pas muet, cf. [§7](#limites). L'identité mutée n'est pas notifiée proactivement — elle le découvre au premier message rejeté.

Les deux actions exigent aussi l'adhésion au salon (même garde `isAllowed` que `send`/`typing`, cf. [§3](#options)) : un modérateur doit avoir lui-même rejoint le salon (`sock.chat(...)`) pour pouvoir le modérer.

---

<a id="frappe"></a>
## 6. Frappe

```civet
room.typing()   # à appeler à chaque frappe clavier, ex. @input={room.typing()}
```

Diffusée aux **autres** membres du salon (jamais à l'émetteur), throttlée côté serveur à environ une diffusion toutes les 3 secondes par identité — appeler `typing()` à chaque touche ne spamme donc jamais le réseau. **Jamais journalisée** : `room().history()` ne voit passer que les `chat:message`/`chat:removed` (diffusés via `room().send()`) — la frappe est diffusée directement aux membres courants (`room().clients`), en dehors du journal, pour ne jamais polluer le rattrapage d'un nouvel arrivant avec un indicateur éphémère.

Côté client, `typingUsers` expire après ~5 secondes sans nouvelle frappe reçue de la même identité (`MJS_CHAT_TYPING_TTL_MS`, `mjs_chat.ts`) — le protocole ne porte aucun signal explicite de « fin de frappe », cette expiration est un choix côté client pour éviter un pseudo qui resterait affiché indéfiniment après une pause.

---

<a id="limites"></a>
## 7. Limites v1 — honnêtement

- **Aucune persistance au-delà de la mémoire du process.** `room().history()` est un journal **en mémoire**, purgé quand le salon se vide (cf. [23 · MJS-WS §4.1](23-mjs-ws.md#salons-presence)) — un redémarrage du serveur, ou un salon qui se vide puis se repeuple, perd l'historique. Aucun hook `opts.persist` n'existe ici (celui de `mjs-server/persist.ts` est un mécanisme séparé, scopé aux `game` de MJS-Server) : un vrai stockage (base de données, fichier, pont HTTP…) reste à la charge de l'appli hôte, via `opts.onMessage` (qui voit passer chaque message avant diffusion) pour l'écriture — rien d'équivalent n'existe pour relire un historique plus long que le journal en mémoire au démarrage.
- **Le store client `sock.chat()` garde les 100 derniers messages.** `.messages` est borné (aligné sur l'historique serveur, [23 · MJS-WS §4.1](23-mjs-ws.md#salons-presence)) — au-delà, le plus ancien est évincé.
- **Seaux de débit et muets sont bornés en mémoire, mais pas de la même façon.** Les seaux à jetons (`opts.rateLimit`) — et le throttle de frappe ([§6](#frappe)) — sont purgés dès qu'un salon n'a plus aucun membre : reconstituer un seau neuf (ou repasser une frappe) au prochain arrivant est sans enjeu. Un muet (`room.mute(identityId, durationMs)`), lui, n'est **jamais** levé par ce vidage : l'échéance posée survit tant qu'elle n'est pas atteinte, salon vide ou pas, et n'est balayée (à l'accès, ou lors d'un balayage périodique opportuniste — jamais une minuterie dédiée) qu'une fois expirée.
- **Muet est en mémoire process, non répliqué.** Sur un déploiement multi-processus, un client dont la connexion bascule sur un autre processus (reconnexion, répartition de charge) redevient audible tant que ce processus-là ne l'a pas lui-même muté — l'adaptateur cluster ([23 · MJS-WS §9](23-mjs-ws.md#adaptateur-redis)) ne réplique aujourd'hui que la présence, pas cet état de modération.
- **Suppression = tombstone, jamais une réécriture d'historique.** Cf. [§5](#moderation) — `room().history()` n'expose pas de primitive pour retirer une entrée précise de son journal.
- **`canJoin` ne gouverne pas l'adhésion `µ:join`.** Cf. l'encart du [§3](#options) — seule `mjsWs({ rooms: { join } })` le peut ; `canJoin` est un filet de second niveau, réévalué par message.
- **Pas de page de démonstration dédiée** sur le site vitrine — laissé à une itération ultérieure.
- **`sock.chat` n'est pas auto-sélectionné.** Comme `sock.game`, il exige le module runtime `chat` (cf. [§8](#annexe)) — absent de la sélection `runtime`, `sock.chat` reste indéfini (avertissement du bundler à la construction, jamais un crash silencieux).

---

<a id="annexe"></a>
## 8. Annexe — erreurs `chat-*` et protocole

### Erreurs

| Code (`µ:error.message`) | Déclencheur |
|---|---|
| `chat-length` | Texte non-chaîne, vide (après trim), ou au-delà de `maxLength` — y compris après transformation par `onMessage`. |
| `chat-rate` | Seau à jetons épuisé pour cette identité, dans ce salon (`opts.rateLimit`). |
| `chat-denied` | Pas membre du salon, `canJoin` refuse, `onMessage` rejette (retour `false`/throw), ou action de modération par une identité non-`moderators`. |
| `chat-muted` | Identité mutée dans ce salon (`mute(...)`), pendant sa durée. |

### Le protocole `chat:*` — préfixe de convention, pas une réservation

Contrairement au préfixe `µgame:` de MJS-Server, `chat:` n'est **pas réservé** — c'est une simple convention de nommage (`app.serve`/`app.on` d'un type `chat:x` par une **autre** partie de l'appli hôte ne lève rien, contrairement à `µgame:*`).

| Trame | Sens | Charge `p` |
|---|---|---|
| `chat:me` | CLIENT→SERVEUR (requête, `µ:ack`) | `{}` → `{ id, name }` |
| `chat:send` | CLIENT→SERVEUR (fire-and-forget) | `{ room, text }` |
| `chat:message` | SERVEUR→CLIENT (diffusion, journalisée) | `{ room, id, text, from: {id, name}, ts }` |
| `chat:typing` | **Les deux sens** (fire-and-forget, jamais journalisée) | `{ room }` (client→serveur) / `{ room, from: {id, name} }` (serveur→client) |
| `chat:remove` | CLIENT→SERVEUR (fire-and-forget, modérateur) | `{ room, id }` |
| `chat:removed` | SERVEUR→CLIENT (diffusion, journalisée) | `{ room, id }` |
| `chat:mute` | CLIENT→SERVEUR (fire-and-forget, modérateur) | `{ room, identityId, durationMs }` |

Identité — `from.id`/`from.name` sont toujours résolus depuis `client.identity` (duck-typé `{id, ...meta}`, cf. [23 · MJS-WS §1](23-mjs-ws.md#options)) : `name` = `identity.name`, repli l'id lui-même. `ts` est toujours `Date.now()` serveur. Rien de tout ceci ne peut être usurpé depuis la charge du client.

---

*Voir aussi : [20 · Temps réel](20-temps-reel.md) pour le client `µsocket` de base, [23 · MJS-WS](23-mjs-ws.md) pour les salons/l'historique qui portent ce paquet, [24 · MJS-Server](24-mjs-server.md) pour l'autre paquet applicatif de référence (salle de partie).*
