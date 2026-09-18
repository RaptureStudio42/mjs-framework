# 28 · Lobby — hall d'accueil et présence riche (au-dessus de MJS-WS)

> **Module optionnel.** Le paquet Lobby compose un hall d'accueil — qui est en ligne (avec statut),
> s'inviter, annoncer une table/partie ouverte et la rejoindre en un clic — par-dessus
> [23 · MJS-WS](23-mjs-ws.md), sans le modifier, via le mécanisme des paquets activables (`app.use`).
> Tant que tu n'appelles pas `app.use(lobbyPackage(...))`, son coût est **nul**.

```ts
// serveur — TypeScript classique (lobbyPackage est une simple composition app.use(), comme
// chatPackage/accountsPackage — pas de dialecte Civet dédié ici)
import { mjsWs, lobbyPackage } from 'mjs-framework/ws'

const app = mjsWs({ auth: (hello) => ({ id: hello.auth?.id, name: hello.auth?.name }) })
app.use(lobbyPackage())
await app.listen()
```

Côté client, `sock.lobby()` suffit — présence riche, invitations et annonces de tables sont **déjà
gérées** :

```civet
hall = sock.lobby()

inviterQuelquun = (id)-> hall.invite(id, 'viens jouer')
```
```html
{for p in hall.members}
  <p>{p.name} — {p.status}{if p.text} ({p.text}){end}</p>
{end}

{for a in hall.listings}
  <button @click={hall.join(a)}>{a.title}</button>
{end}
```

---

## Sommaire

1. [Philosophie](#philosophie)
2. [Démarrer](#demarrer)
3. [Options — `lobbyPackage(opts)`](#options)
4. [Le client — `sock.lobby`](#le-client)
5. [Présence riche + statuts](#presence)
6. [Absent auto](#absent-auto)
7. [Invitations](#invitations)
8. [Annonces de tables + recette d'intégration jeu](#annonces)
9. [Limites v1 — honnêtement](#limites)
10. [Annexe — erreurs `lobby-*` et protocole](#annexe)

---

<a id="philosophie"></a>
## 1. Philosophie

Une appli temps réel a presque toujours besoin d'un **hall d'accueil** : savoir qui est en ligne, se
signaler occupé/absent, inviter quelqu'un qu'on y voit, annoncer une table ouverte et la rejoindre en
un clic. Le paquet Lobby fournit ce socle **une fois**, composé **sur** l'API publique de
[23 · MJS-WS](23-mjs-ws.md) (`app.room`, `app.sendUser`) — jamais par réimplémentation d'un registre
de présence : la présence riche (statut/texte/depuis) est une agrégation propre à ce paquet, mais
l'appartenance au hall (qui est réellement connecté) reste **toujours** gouvernée par le salon MJS-WS
sous-jacent (`app.room('lobby:' + hall)`), jamais dupliquée.

**Générique, pas un module de jeu.** Les annonces de table n'importent **rien** du module jeu
(mjs-server) — le hook `opts.onJoin` est le **seul** point de branchement vers un appariement
réel, à la charge de l'appli hôte (cf. [§8](#annonces)).

---

<a id="demarrer"></a>
## 2. Démarrer

```ts
// lobby.server.ts
import { mjsWs, lobbyPackage } from 'mjs-framework/ws'

const app = mjsWs({
  auth: (hello) => ({ id: hello.auth?.id, name: hello.auth?.name }),
})

app.use(lobbyPackage({
  moderators: (identity) => (identity as { role?: string })?.role === 'admin',
}))

await app.listen()
```

```civet
// composant .mjs — dialecte Civet des composants
hall = sock.lobby()
```
```html
{for p in hall.members}
  <p>{p.name} — {p.status}</p>
{end}

<button @click={hall.status('busy', 'en partie')}>Je suis occupé</button>

{for inv in hall.invitations}
  <p>{inv.from.name} : {inv.note}</p>
  <button @click={hall.reply(inv, true)}>Accepter</button>
  <button @click={hall.reply(inv, false)}>Refuser</button>
{end}

<button @click={hall.advertise({ title: 'Partie rapide', seats: 4 })}>Annoncer une table</button>

{for a in hall.listings}
  <button @click={hall.join(a)}>{a.title} ({a.seats} places)</button>
{end}
```

C'est tout ce qu'il faut pour un hall complet — présence riche, invitations et annonces de tables. Le
protocole `lobby:*` qui transporte tout ça reste **invisible** (cf. [§10](#annexe) pour l'inventaire
bas niveau).

---

<a id="options"></a>
## 3. Options — `lobbyPackage(opts)`

| Clé | Défaut | Effet |
|---|---|---|
| `prefix` | `'lobby:'` | Préfixe des noms de hall MJS-WS — `app.room(prefix + hall)`. |
| `statusTextMaxLength` | `60` | Longueur max du texte court de statut. Au-delà : `lobby-text-invalid`. |
| `statusRateMs` | `5000` | Intervalle minimal entre deux changements de statut, **par identité**. Au-delà : `lobby-rate`. |
| `awayAfterMs` | `300000` (5 min) | Seuil d'absence automatique (cf. [§6](#absent-auto)). `null` désactive le mécanisme. |
| `invitationTtlMs` | `60000` | Durée de vie d'une invitation. |
| `invitationRate` | `{ rate: 6/60, burst: 6 }` | Seau à jetons **par identité émettrice** ≈ 6 invitations/minute. Au-delà : `lobby-rate`. |
| `noteMaxLength` | `200` | Longueur max de la note d'invitation — **non imposée par une spécification externe**, valeur par défaut retenue. |
| `listingTitleMaxLength` | `80` | Longueur max du titre d'une annonce. Au-delà : `lobby-title-invalid`. |
| `listingCodeMaxLength` | `40` | Longueur max du code d'une annonce — **idem, défaut retenu**. Au-delà : **tronqué**, jamais un refus. |
| `listingTtlMs` | `300000` (5 min) | Durée de vie d'une annonce. |
| `moderators` | absent | `(identity) => bool` — réservé au retrait de l'annonce d'un **autre** ([§8](#annonces)). |
| `onJoin` | absent | `(ctx) => …` — hook d'appariement (cf. [§8](#annonces)), best-effort. |
| `onLog` | console, préfixe `[mjs-ws:lobby]` | Utilisé **uniquement** si `onJoin` lève. |

---

<a id="le-client"></a>
## 4. Le client — `sock.lobby`

Posé par-dessus `µ.socket` (module runtime `lobby`, cf. [§9](#limites) pour la sélection du
runtime) :

```civet
hall = sock.lobby()                   # store réactif plat, hall par défaut ('hall')
vip  = sock.lobby('vip')              # hall nommé — n'importe quel nom rejoint/crée le sien
```

| Clé | Type | Sens |
|---|---|---|
| `members` | tableau | `{id, name, status, text, since}` — état complet au join, deltas ensuite. |
| `me` | `{id, name}` \| `null` | Identité résolue **côté serveur** — `null` tant que la réponse n'est pas encore revenue. |
| `invitations` | tableau | Invitations **reçues**, en attente de réponse — `{id, from, note, expiresAt}`. TTL **local** (cf. [§7](#invitations)). |
| `listings` | tableau | Tables ouvertes connues (les miennes comprises) — `{id, from, title, code, seats, meta, expiresAt}`. TTL **local**. |
| `applicants` | tableau | `{id, from}` reçus quand quelqu'un `join()` MA table. |
| `replies` | tableau | `{id, from, accepted}` reçus en réponse à **mes** invitations envoyées. |
| `status(status, text?)` | fonction | `'free'\|'busy'\|'away'` + texte court optionnel — **fire-and-forget**. |
| `invite(identityId, note?)` | fonction | Invite une identité présente dans CE hall — **fire-and-forget**. |
| `reply(inv, accepted)` | fonction | `inv` = un id OU l'objet invitation lui-même — **fire-and-forget**. |
| `advertise({title, code?, seats?, meta?})` | fonction | 1 annonce active par identité (la nouvelle remplace l'ancienne) — **fire-and-forget**. |
| `withdraw(id?)` | fonction | Sans argument : retire SA **propre** annonce. |
| `join(listing)` | fonction | `listing` = un id OU l'objet annonce lui-même — **fire-and-forget**. |
| `block(identityId)` | fonction | Ignore silencieusement les invitations futures de cette identité (session). |
| `close()` | fonction | Quitte le hall (`µ:leave`) et purge le store local (minuteurs compris). |

> ⚠️ **`applicants`/`replies` vont au-delà du store minimal envisagé au
> départ** (`{members, me, status, invitations, invite, reply, listings, advertise, withdraw,
> join, block, close}`) : sans eux, `lobby:applicant` (« untel veut rejoindre **ma** table ») et
> `lobby:replied` (« untel a répondu à **mon** invitation ») resteraient invisibles depuis `sock.lobby()`
> — même raison d'être que `remove`/`mute` ajoutés par `sock.chat` ([26 · Chat §4](26-chat.md#le-client)).
> Tableaux qui s'accumulent (aucune notion de « lu » en v1) — vide-les toi-même si besoin
> (`hall.applicants = []`).

### Erreurs — `sock.lastError`

Toutes les actions ci-dessus (sauf l'entrée dans le hall, automatique) sont **fire-and-forget** : un
refus serveur arrive en `µ:error {message: 'lobby-*'}`, exposé via `sock.lastError` — même mécanique
que [26 · Chat](26-chat.md#le-client). Cf. [§10](#annexe) pour le détail de chaque code.

---

<a id="presence"></a>
## 5. Présence riche + statuts

```civet
hall.status('busy', 'en partie')
hall.status('free')          # texte omis → efface le texte court
```

Trois statuts : `free`, `busy`, `away`. Le texte court (`text`) est optionnel et borné à
`statusTextMaxLength` (défaut 60) : au-delà, il est refusé, jamais tronqué. Un changement de statut est diffusé à **tout le hall, soi-même
compris** — chaque `sock.lobby()` ouvert reçoit le même delta `lobby:member`, qui met à jour
`.members` par id (upsert). Débit : `statusRateMs` (défaut 5 s) par identité — au-delà,
`lobby-rate`.

---

<a id="absent-auto"></a>
## 6. Absent auto

Par défaut, une identité sans **action lobby réussie** depuis `awayAfterMs` (5 min par défaut)
passe automatiquement `away` — détecté au balayage opportuniste (même famille que le balayage
mémoire de [26 · Chat §7](26-chat.md#limites), aucune minuterie dédiée). Elle **revient
automatiquement** à son statut précédent dès sa prochaine action réussie (n'importe laquelle —
`status()`, `invite()`, `advertise()`…), et ce retour est lui aussi diffusé au hall.

Un statut `'away'` choisi **explicitement** (`hall.status('away', '...')`) ne porte jamais ce
drapeau automatique — il ne revient donc **jamais** tout seul, seul un nouveau `status()` explicite
le change.

`awayAfterMs: null` désactive entièrement le mécanisme.

> **Ce que « action » veut dire ici.** Le paquet ne peut pas lire un horodatage de trame bas niveau
> (non exposé par l'API publique de MJS-WS, cf. la tête de fichier de `lobby.ts`) — seule une action
> `lobby:*` qui **réussit sa validation** (avant toute mutation) compte comme activité ; un rejet
> (débit, forme invalide…) ne réarme pas le seuil. Cf. [§9](#limites).

---

<a id="invitations"></a>
## 7. Invitations

```civet
hall.invite(unAutrePresentId, 'viens jouer')   # note optionnelle, ≤ 200 caractères (défaut)
```

- `invite(identityId, note?)` — l'invité (**toutes ses connexions**, plusieurs onglets compris)
  reçoit `lobby:invitation {id, from, note, expiresAt}`. Refus visibles : cible absente du hall
  (`lobby-away`), auto-invitation (`lobby-self-invite`), débit émetteur ≈ 6/min
  (`lobby-rate`, seau `invitationRate`).
- `reply(inv, accepted)` — le demandeur reçoit `lobby:replied {id, from, accepted}`. Une invitation
  inconnue **et** une invitation qui n'est pas la mienne renvoient la **même erreur**
  (`lobby-invitation-unknown`) — anti-énumération, même esprit que
  [27 · Comptes §6](27-accounts.md#securite).
- TTL 60 s par défaut (`invitationTtlMs`) — expire **silencieusement**, ni notification ni trame
  serveur dédiée : le client purge lui-même localement sur l'`expiresAt` absolu reçu à la création (cf.
  [§4](#le-client)).

**Blocage.** `hall.block(identityId)` — les invitations futures de cette identité sont ensuite
ignorées **silencieusement** : l'émetteur ne voit **aucune différence** de comportement (pas
d'erreur, pas de confirmation distincte) que sa cible l'ait bloqué ou non — impossible de sonder si
on a été bloqué. Mémoire **session/process**, même limite v1 que le muet du chat
([26 · Chat §7](26-chat.md#limites)) : redémarrage, ou reconnexion sur un autre processus (cluster),
efface le blocage.

---

<a id="annonces"></a>
## 8. Annonces de tables + recette d'intégration jeu

```civet
hall.advertise({ title: 'Partie rapide', seats: 4, code: 'ABCD' })
hall.withdraw()                       # retire MA propre annonce
hall.join(uneAnnonceDeHallAnnonces)
```

**1 annonce active par identité** — en annoncer une nouvelle retire silencieusement l'ancienne
(diffusion `lobby:withdrawn` puis `lobby:listing`, jamais les deux en même temps visibles). `title`
requis (≤ 80 caractères, `lobby-title-invalid` sinon) ; `code`/`seats`/`meta` libres, jamais
interprétés par ce paquet — `meta` est un simple passe-plat applicatif.

`withdraw(id?)` — sans argument, retire SA **propre** annonce ; avec un id, retire une annonce
**arbitraire** si l'identité appelante est `moderators`. `lobby-listing-unknown` si rien à
retirer (id inconnu, déjà expiré, ou aucune annonce active sans id) ; `lobby-denied` si ni
propriétaire ni modérateur.

`join(listing)` — notifie l'annonceur (`lobby:applicant {id, from}`, **toutes** ses connexions) **et**
renvoie l'annonce au demandeur (même type `lobby:listing`, envoyé directement — pas de round-trip
supplémentaire). Le hook `opts.onJoin(ctx)` est ensuite appelé **best-effort** — il ne
conditionne **jamais** les deux étapes précédentes (même s'il lève, notification et renvoi ont déjà eu
lieu) : `ctx = { listing, client, identity }`.

### Recette — brancher l'appariement mjs-server

Le paquet Lobby n'importe **jamais** le module jeu (aucune dépendance dure). Pour brancher un vrai
appariement de partie :

```ts
import { mjsWs, lobbyPackage } from 'mjs-framework/ws'
import { mjsServer } from 'mjs-framework/mjs-server'   // module jeu — importé par TON appli, pas par lobby.ts

const app = mjsServer(mjsWs({ auth }))

app.use(lobbyPackage({
  onJoin: async (ctx) => {
    // ctx.listing.code porte le code de la table (posé à `hall.advertise({ code })` côté créateur) —
    // l'appariement RÉEL reste celui de MJS-Server (24 · MJS-Server), jamais réinventé ici.
    await app.game('ma-partie').joinWithCode(ctx.client, ctx.listing.code)
  },
}))
```

Côté créateur de table : appeler `hall.advertise({ title, code })` juste après avoir créé la partie
(le code d'appariement de MJS-Server devient le `code` de l'annonce) — cf.
[24 · MJS-Server](24-mjs-server.md) pour la création/le code d'appariement eux-mêmes, hors mandat
de ce paquet.

---

<a id="limites"></a>
## 9. Limites v1 — honnêtement

- **Présence riche = agrégation maison, pas un registre réinventé.** L'appartenance au hall (qui est
  réellement connecté) reste intégralement gouvernée par `app.room('lobby:' + hall)` (MJS-WS) ; ce
  paquet n'ajoute qu'une couche de métadonnées (statut/texte/depuis) par-dessus, tenue à jour à
  `lobby:enter` et nettoyée au balayage opportuniste — cf. le point suivant pour le délai que ça
  implique.
- **Un départ met jusqu'à ~50 actions lobby (tout le paquet confondu) à être signalé aux autres.**
  Comme les seaux de débit du chat ([26 · Chat §7](26-chat.md#limites)), aucun hook « connexion
  fermée » n'est accessible depuis un paquet composé sur l'API publique : la disparition de
  `.members`/`.listings` chez les **autres** clients (`lobby:left`/`lobby:withdrawn`) est détectée au
  balayage opportuniste, pas instantanément. La présence **réelle** (côté serveur, pour l'autorisation)
  reste, elle, toujours exacte (`app.room().clients`) — seule la **propagation** aux autres clients a ce
  délai.
- **« Action » = une action lobby qui réussit sa validation.** Un rejet (débit, forme invalide) ne
  réarme pas le seuil d'absence auto — simplification assumée (cf. [§6](#absent-auto)) : le paquet ne
  peut pas observer un horodatage de trame bas niveau, contrairement au watchdog de silence interne
  de MJS-WS (non exposé aux paquets).
- **Blocage et anti-force-brute des invitations sont en mémoire process, non répliqués.** Comme la
  modération du chat et l'anti-force-brute des comptes — un déploiement multi-processus ne partage ni
  les blocages, ni les seaux de débit entre processus.
- **`onJoin` ne fait aucune vérification de cohérence pour toi.** Places restantes, double
  candidature, annonce déjà pleine… tout ça reste à la charge de l'appli hôte dans son propre hook
  — le paquet se contente de notifier et de transmettre.
- **Pas de page de démonstration dédiée** sur le site vitrine — laissé à une
  itération ultérieure.
- **`sock.lobby` n'est pas auto-sélectionné.** Comme `sock.chat`/`sock.account`, il exige le module
  runtime `lobby` (cf. [§10](#annexe)) — absent de la sélection `runtime`, `sock.lobby` reste
  indéfini (avertissement du bundler à la construction, jamais un crash silencieux).

---

<a id="annexe"></a>
## 10. Annexe — erreurs `lobby-*` et protocole

### Erreurs

| Code (`µ:error.message`) | Déclencheur |
|---|---|
| `lobby-denied` | Pas membre du hall, action avant `lobby:enter`, ou retrait d'annonce ni propriétaire ni modérateur. |
| `lobby-status-invalid` | `status` absent/hors énumération `free\|busy\|away`. |
| `lobby-text-invalid` | Texte de statut OU note d'invitation non-chaîne ou trop longue. |
| `lobby-rate` | Débit de changement de statut (1/5 s) OU d'envoi d'invitations (≈ 6/min) épuisé. |
| `lobby-self-invite` | Tentative de s'inviter soi-même. |
| `lobby-away` | Identité invitée non présente dans CE hall. |
| `lobby-invitation-unknown` | Invitation inconnue, expirée, ou qui n'est pas la mienne (anti-énumération). |
| `lobby-title-invalid` | Titre d'annonce absent/vide/trop long (> 80 par défaut). |
| `lobby-listing-unknown` | Annonce inconnue, expirée, ou aucune annonce active à retirer sans id. |

### Le protocole `lobby:*` — préfixe de convention, pas une réservation

Comme `chat:`/`account:` ([26 · Chat](26-chat.md#annexe)/[27 · Comptes](27-accounts.md#annexe)),
`lobby:` n'est **pas réservé** — une simple convention de nommage. `hall` figure dans **chaque** trame
(optionnel côté client, défaut `'hall'`) — plusieurs halls isolés (`sock.lobby('vip')`) sont
possibles avec le **même** paquet installé une seule fois.

| Trame | Sens | Charge `p` |
|---|---|---|
| `lobby:enter` | CLIENT→SERVEUR (requête, `µ:ack`) | `{hall?}` → `{me:{id,name}, members:[...]}` |
| `lobby:status` | CLIENT→SERVEUR (fire-and-forget) | `{hall?, status, text?}` |
| `lobby:member` | SERVEUR→CLIENT (diffusion, delta) | `{hall, id, name, status, text, since}` |
| `lobby:left` | SERVEUR→CLIENT (diffusion, delta) | `{hall, id}` |
| `lobby:invite` | CLIENT→SERVEUR (fire-and-forget) | `{hall?, identityId, note?}` |
| `lobby:invitation` | SERVEUR→CLIENT (ciblé, `sendUser`) | `{hall, id, from:{id,name}, note, expiresAt}` |
| `lobby:reply` | CLIENT→SERVEUR (fire-and-forget) | `{hall?, id, accepted}` |
| `lobby:replied` | SERVEUR→CLIENT (ciblé, `sendUser`) | `{hall, id, from:{id,name}, accepted}` |
| `lobby:advertise` | CLIENT→SERVEUR (fire-and-forget) | `{hall?, title, code?, seats?, meta?}` |
| `lobby:listing` | SERVEUR→CLIENT (diffusion + ciblé au rejoindre) | `{hall, id, from, title, code, seats, meta, expiresAt}` |
| `lobby:withdraw` | CLIENT→SERVEUR (fire-and-forget) | `{hall?, id?}` — id absent = SA **propre** annonce |
| `lobby:withdrawn` | SERVEUR→CLIENT (diffusion) | `{hall, id}` |
| `lobby:join` | CLIENT→SERVEUR (fire-and-forget) | `{hall?, id}` |
| `lobby:applicant` | SERVEUR→CLIENT (ciblé, `sendUser`) | `{hall, id, from:{id,name}}` |
| `lobby:block` | CLIENT→SERVEUR (fire-and-forget) | `{hall?, identityId}` |

Identité — `from.id`/`from.name` sont toujours résolus depuis `client.identity` (duck-typé
`{id, ...meta}`) : `name` = `identity.name`, repli l'id lui-même. Rien de
tout ceci ne peut être usurpé depuis la charge du client.

---

*Voir aussi : [20 · Temps réel](20-temps-reel.md) pour le client `µsocket` de base, [23 · MJS-WS](23-mjs-ws.md)
pour les salons/la présence qui portent ce paquet, [24 · MJS-Server](24-mjs-server.md) pour
l'appariement réel (recette du [§8](#annonces)), [26 · Chat](26-chat.md) et
[27 · Comptes](27-accounts.md) pour les deux autres paquets applicatifs de référence.*
