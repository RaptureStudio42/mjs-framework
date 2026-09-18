# 20 · Temps réel (µsocket)

> 📚 Tuto interactif correspondant : **Temps réel → Réseau réactif** (client) et **Temps réel → Côté serveur** (protocole `µ:`). Les encarts 🎓 *Pour débutants* dépliables donnent l'explication pas-à-pas ; le corps de la page reste la référence dense.

`µsocket` est une couche **WebSocket réactive** : on ouvre une connexion, et l'état de cette connexion (`state`, `latency`, `connected`, `lastError`) ainsi que les données qu'elle transporte (**flux**, **présence**) sont des valeurs **réactives** — elles re-rendent les composants qui les lisent, sans `µeffect` ni abonnement manuel.

Un `µsocket(url)` est un **singleton par URL**, référence-compté : deux composants qui ouvrent la même URL partagent la **même** connexion. La connexion est **paresseuse** — elle ne s'ouvre qu'au premier `on`/`send`/`request`/`stream`, ou explicitement via `.connect()`.

```html
<script>
  @sock = µsocket "wss://jeu/play"
</script>

<p>État : {@sock.state} · latence : {@sock.latency} ms</p>
```

> 🔤 **Syntaxe.** `µsocket url` est le sucre sans point de `µ.socket(url)`. `µsmooth` de même pour `µ.smooth`. Les deux formes sont équivalentes.

---

## 1. État réactif de la connexion

| Propriété | Type | Sens |
|---|---|---|
| `state` | `'closed' \| 'connecting' \| 'reconnecting' \| 'open'` | Cycle de vie. `open` n'est atteint **qu'après le handshake** `µ:welcome`. |
| `connected` | `bool` | Raccourci `state === 'open'`. |
| `latency` | `number \| null` | Aller-retour du dernier `µ:ping`/`µ:pong`, en ms. |
| `lastError` | `object \| null` | Dernière erreur (`µ:error`, `µ:denied`, coupure réseau…). |

Toutes sont réactives : `<span class="dot" @class{@sock.connected}="on">` bascule tout seul.

---

## 2. Publier / s'abonner — `send` / `on`

```html
off = @sock.on 'chat', (p)-> $messages.push(p)   # abonnement, renvoie un dé-abonnement
@sock.send 'chat', { texte: 'salut' }             # publication
```

`on(type, handler)` renvoie une fonction de **dé-abonnement**. Le type est ré-envoyé au serveur en `resub` après une reconnexion (rien à re-brancher à la main). 3ᵉ argument optionnel `{ owner: @ }` : dé-abonnement **automatique** à la destruction du composant appelant (même mécanisme que `owner` de `µsmooth`, § 6) — sans lui, `off()` (ou la fonction rendue) reste à rappeler à la main.

### Anti-spam à l'envoi

`send` accepte un 3ᵉ argument d'options :

| Option de `.send(type, p, opts)` | Rôle |
|---|---|
| `cooldown` | Millisecondes minimales entre deux envois du **même type** ; un envoi trop tôt est **jeté** (retourne `false`). |
| `coalesce` | **Millisecondes** minimales entre deux envois du même type (ou `true` → `coalesceMs`) : ne garde que le **dernier** payload et l'émet à cette cadence. Idéal pour un curseur, un joystick, une position. Même unité que `cooldown`. `0` = au prochain tour de boucle ; une valeur négative vaut 0. |
| `debounce` | **Millisecondes** de silence sur le même type avant émission (ou `true` → `debounceMs`) : à la différence de `coalesce` (cadence fixe même sous activité continue), rien ne part tant que les envois s'enchaînent — seul le **dernier** payload part, à la première pause. Idéal pour un champ de recherche, un curseur qu'on relâche. `0` = au prochain tour de boucle ; une valeur négative vaut 0. |

Une chaîne numérique est acceptée (`'300'`) ; toute autre valeur non numérique est ignorée avec un avertissement.

Les deux options sont exclusives sur un même envoi : si `debounce` est présent, il l'emporte et `coalesce` est ignoré.

```html
@sock.send 'curseur', { x, y }, { coalesce: 33 }   # au plus 1 envoi / 33 ms (~30 trames/s), la dernière gagne
```

### L'accueil du serveur — `sock.on('welcome', …)` / `sock.resumed`

Le serveur peut joindre des données à son accueil (option `welcome(client)` côté `mjsWs`, cf. [23 · MJS-WS](23-mjs-ws.md)) — un horodatage, une identité validée, ou `resumed` après une reprise de session (§8 de [23 · MJS-WS](23-mjs-ws.md)). Ça se lit ainsi, côté client :

```html
@sock.on 'welcome', (p)->
  µ.log 'accueil serveur :', p.serverTime
  µ.log 'reprise à chaud :', @sock.resumed
```

`@sock.resumed` (bool, `false` par défaut) dit si **ce** `µ:welcome` clôt une reprise de session réussie (`true`) ou un accueil neuf (`false`) — mis à jour à chaque welcome. `p` reçu par le handler `'welcome'` est une copie de la charge envoyée par le serveur, **sans** le champ `session` (la carte de session est de la plomberie interne à la reprise — id et clé n'ont rien à faire dans les mains de l'appli).

> ⚠️ **Nom réservé.** `'welcome'` devient un nom d'événement réservé côté client : un message applicatif serveur qui s'appellerait littéralement `welcome` déclencherait les **mêmes** handlers (même mécanisme `on`/`send` que n'importe quel autre type pub/sub).

### Le refus du serveur — `sock.on('denied', …)`

Miroir exact de `'welcome'` : le serveur refuse l'authentification (jeton absent, signature fausse, **jeton expiré**), envoie `µ:denied`, et le socket se ferme **définitivement** — plus de reconnexion automatique, le minuteur est annulé, `sock.state` reste `'closed'`. C'est voulu : réessayer avec le même laissez-passer donnerait le même refus, en boucle.

C'est donc à l'appli d'aller chercher un laissez-passer frais et de rouvrir. `'denied'` est le signal qui le lui dit :

```html
@sock.on 'denied', (p)->
  µ.error 'fil refusé :', p.message
  µ.ajax.get '/api/token', (res)->
    return unless res?.ok
    $$session.token = res.token   # relu par l'option `auth` à la prochaine ouverture
    @@sock.connect()              # le socket est déjà au repos : connect() rouvre pour de bon
```

Le handler tourne **après** la fermeture, exactement comme `'welcome'` tourne après l'ouverture : `connect()` appelé depuis là repart proprement. Prévois une **borne** au nombre de reprises (un secret changé côté serveur refusera aussi le jeton neuf) — remise à zéro au `'welcome'` suivant.

Pour renouveler un jeton **sans** fermer le fil (en vol, avant l'échéance), c'est `sock.refresh(auth)` — cf. [23 · MJS-WS](23-mjs-ws.md).

> ⚠️ **Nom réservé**, même réserve que `'welcome'` : un message applicatif serveur littéralement nommé `denied` déclencherait les mêmes handlers.

---

## 3. Requête / réponse — `request`

Contrairement à `send` (sans retour), `request` renvoie une **Promise** résolue par la réponse du serveur (`µ:ack`).

```html
try
  solde = await @sock.request 'achat', { item: 'épée' }
catch e
  µ.error e.code, e.message   # 'timeout' | 'offline' | erreur applicative
```

| Option de `.request(type, p, opts)` | Défaut | Rôle |
|---|---|---|
| `timeout` | `opts.timeout` du socket, sinon **5000** ms | Délai avant `reject({ code: 'timeout' })`. |
| `waitForOpen` | `false` | `false` = `reject({ code: 'offline' })` immédiat si le socket n'est pas `open`. `true` = ne rejette pas tout de suite (laisse courir jusqu'au `timeout`). |

**Changer le timeout :**

```html
# par requête (prioritaire)
await @sock.request 'achat', p, { timeout: 15000 }

# global, pour TOUTES les requêtes du socket
@sock = µsocket url, { timeout: 15000 }   # défaut 5000 ms
```

Côté serveur, une requête arrive **sans préfixe `µ:`**, sous la forme `{ t: <type>, p, id }`. Le serveur **doit** répondre `{ t: 'µ:ack', id, e?, p }` avec le **même `id`** — `e` vrai → la Promise `reject(p)`, sinon `resolve(p)`.

### UI optimiste — `µ.optimistic`

Pour une mutation qui **doit** paraître instantanée (incrémenter un compteur, poster un message qui apparaît tout de suite dans le fil) sans attendre l'aller-retour de `request` ci-dessus, `µ.optimistic` (module runtime `'optimistic'`) applique le changement **localement, tout de suite**, sur n'importe quel store — puis annule (**rollback**) si la requête échoue. Façon Meteor :

```html
<script>
  $compteur = µ.state({ n: 0 })

  incrementer = ->
    µ.optimistic $compteur, {
      apply: (state)-> state.n += 1                # brouillon — MUTE en place (ou renvoie un nouvel état)
      via:       -> @sock.request 'incrementer', {}    # la vraie requête, typiquement sock.request
    }
</script>

<button @click={incrementer}>{$compteur.n}</button>   <!-- bouge IMMÉDIATEMENT, avant tout retour serveur -->
```

`µ.optimistic(store, opts)` renvoie une **Promise** qui résout `{ ok: true, response }` en cas de succès, `{ ok: false, error }` sinon — **jamais un rejet** : pas de `try/catch` à écrire, juste lire `.ok`.

- **Succès** — la valeur optimiste est **gardée**. Avec un `after: (state, response)-> …` optionnel, ré-applique la **réponse** serveur par-dessus (utile si le serveur calcule une valeur différente de la devinette locale — un `id`/horodatage généré serveur, un compteur **partagé** entre plusieurs clients) :

  ```html
  µ.optimistic $messages, {
    apply: (state)-> state.liste.push { texte: texte, pending: true }   # apparaît TOUT DE SUITE
    via:       -> @sock.request 'poster', { texte: texte }
    after:      (state, response)-> state.liste[state.liste.length - 1] = response.message   # remplacé par la version serveur (id définitif…)
  }
  ```

- **Échec** (throw serveur, `µ:error`, timeout réseau — n'importe quel rejet de `via()`) — **rollback** automatique : le store revient **exactement** à l'état d'avant l'appel.

**Plusieurs `µ.optimistic` empilés sur le même store** (deux clics rapprochés) restent cohérents : chaque appel a sa propre entrée dans une file, rejouée par-dessus une base commune. Un échec ne retire **que** sa propre entrée — jamais l'effet d'une sœur encore en vol (cf. l'en-tête de `src/runtime/mjs_optimistic.ts` pour le détail de la stratégie, « snapshot chaîné + rejeu séquentiel »).

> 🔗 Pour un **jeu** (`sock.game()`), `µ.predict` ([24 · MJS-Server « Prédiction du mouvement propre »](24-mjs-server.md#prédiction-du-mouvement-propre-µpredict)) est le cousin **spécialisé** de `µ.optimistic` — même patron (snapshot + rejeu), pensé pour des **intentions** rejouées contre un état serveur autoritaire par tick plutôt qu'une requête/réponse générique.

---

## 4. Flux réactif — `stream`

Pour une liste que le **serveur** maintient (ennemis, positions, objets au sol), `stream(type)` renvoie un **store réactif** `{ id → donnée }` que le serveur remplit par petits **deltas numérotés**, avec **resynchronisation automatique** si un paquet manque.

```html
<script>
  @sock    = µsocket "wss://jeu/play"
  @ennemis = @sock.stream 'ennemis'
</script>

{for id, en in @ennemis}
  <circle cx={en.x} cy={en.y} r="6" />
{end}
```

Les **quatre opérations** de delta (champ `op`) :

| `op` | Charge | Sens |
|---|---|---|
| `reset` | `p.values = { id → donnée }` | Instantané complet (réponse à `µ:sub-stream` / `µ:resync`). |
| `add` | `p.key` + `p.value` | Nouvel élément. |
| `update` | `p.key` + `p.patch` | Fusion partielle sur un élément existant. |
| `remove` | `p.key` | Retrait d'un élément. |

Enveloppe : `{ t: 'ennemis', seq, p: { op, key?, value?, patch?, values? } }`. Chaque delta porte un **`seq` contigu** ; si le client détecte un trou, il émet **automatiquement** `µ:resync` et le serveur renvoie un `reset`. **Rien à coder côté client.**

---

## 5. Présence & salons — `presence` / `room`

```html
@players = @sock.presence()          # présence globale (ou d'un salon : presence('lobby'))
salon    = @sock.room 'partie-42'    # rejoint un salon (µ:join)
salon.on 'coup', (p)-> …            # écoute scopée au salon
salon.send 'coup', { case: 12 }
salon.leave()                        # quitte (µ:leave)

@sock.sendTo 'partie-42', 'coup', { case: 12 }   # raccourci SANS rejoindre le salon (aucun µ:join)
```

`presence()` renvoie un store réactif `{ id → méta }`, alimenté par des deltas `join`/`leave`/`reset`. `room(name)` renvoie un objet scopé (`on`/`send`/`request`/`stream`/`presence`/`leave`) dont les types sont préfixés `name/`. Le serveur peut **exclure** un client (`µ:left`) → callback `salon.onLeft(fn)`.

`sendTo(salon, type, p, opts?)` est le raccourci **sans cérémonie** pour un envoi ponctuel scopé à un salon : équivaut à `send(salon + '/' + type, p, opts)` (mêmes options `cooldown`/`coalesce`/`debounce` que `send`), mais **sans rejoindre** le salon — contrairement à `room(salon).send(...)`, qui joint d'abord (`µ:join`) s'il ne l'a pas déjà fait.

---

## 6. Lissage réseau — `µsmooth`

Les positions réseau arrivent par à-coups (10–20 Hz). `µsmooth(source, opts)` prend un store **multi-entités** `{ id → position }` (typiquement `stream()`, §4) et renvoie un store réactif du même type, qui affiche à chaque frame la position « il y a `retard` ms » en interpolant entre les deux échantillons horodatés qui l'encadrent :

```html
<script>
  @sock    = µsocket "wss://jeu/play"
  @ennemis = @sock.stream 'ennemis'
  @fluide  = µsmooth @ennemis, { retard: 100, owner: @ }
</script>

{for id, p in @fluide}
  <circle cx={p.x} cy={p.y} r="6" />
{end}
```

Le store renvoyé se consomme comme n'importe quel store réactif (`{for id, p in ...}`) — il n'a ni `.set()` ni `.value` : c'est la **source** (`@ennemis` ci-dessus) qu'on met à jour, `µsmooth` se charge de lisser l'affichage tout seul, à partir de ce qu'elle contient.

| Option de `µsmooth(source, opts)` | Défaut | Rôle |
|---|---|---|
| `retard` (alias `delay`) | `100` ms | Fenêtre de lissage — plus grand lisse davantage, au prix d'un peu plus de latence visuelle. |
| `maxSamples` | `30` | Taille max du tampon d'échantillons conservés par entité. |
| `owner` | — | Composant appelant (`@`) : auto-dispose à sa destruction. |

Sans `owner`, `@fluide` tourne **à vie** (boucle perpétuelle, contrairement à `µspring`/`µ.interpolate` qui se stabilisent seuls dès la cible atteinte) tant que `@fluide.dispose()` n'est pas appelé à la main.

---

## 7. Le protocole serveur `µ:`

Le client parle un protocole JSON dont **toutes les trames de contrôle** portent le préfixe réservé **`µ:`**. Les messages applicatifs (pub/sub, requêtes, deltas de flux) n'ont **pas** ce préfixe. Voici l'**inventaire exhaustif** — c'est le contrat qu'un serveur (Node `ws`, Rails ActionCable custom, Go…) doit implémenter.

> 🔌 **Tu n'as pas à l'implémenter toi-même.** Côté serveur : voir [23 · MJS-WS](23-mjs-ws.md), le serveur compagnon officiel (Node) qui parle déjà ce protocole — `mjs ws` le lance en une commande. Prise en main pas à pas : leçon tuto [Le serveur officiel (mjs ws)](/tuto#/serveur-mjs-ws). Besoin d'une salle de partie (appariement, tour par tour, vue par joueur) par-dessus ? Voir [24 · MJS-Server](24-mjs-server.md), une couche optionnelle composée sur MJS-WS.

### 7.1 Client → Serveur

| Trame | Charge `p` | Quand / rôle |
|---|---|---|
| `µ:hello` | `{ auth, protocol: 1, resub: [types], rooms: [noms], schemaHash? }` | Handshake d'ouverture, émis dès l'ouverture WS. L'état reste `connecting` tant que le serveur n'a pas répondu `µ:welcome`. `resub`/`rooms` = ré-abonnements après reconnexion. `schemaHash` (`µschema`, [23 · MJS-WS §3.1](23-mjs-ws.md#µschema)) = hash du registre **client** (miroir local) — différent du serveur → celui-ci pousse `µ:schema` juste après le welcome. |
| `µ:ping` | `{ ts }` | Battement, toutes les `heartbeat` ms (défaut 15 s). Le serveur doit renvoyer `µ:pong`. |
| `µ:sub-stream` | `{ stream }` | S'abonner à un flux → le serveur répond par un delta `reset`. |
| `µ:resync` | `{ stream, from: dernierSeq }` | Trou de séquence détecté → redemande la suite. **Automatique.** |
| `µ:sub-presence` | `{ room }` | S'abonner à la présence (globale si `room` absent). |
| `µ:join` | `{ room }` | Rejoindre un salon. |
| `µ:leave` | `{ room }` | Quitter un salon. |
| `µ:refresh` | `{ auth }` | Rafraîchit le jeton **en vol** (`sock.refresh(...)`), sans rouvrir la connexion — **même** charge que `hello.p.auth`. Ré-authentifie via `opts.auth` ; `identity.id` doit rester **identique** (sinon refusé). Porte toujours un `id` → répond par un `µ:ack` (charge `{ exp }`, échéance neuve en secondes epoch, ou absente si le serveur ne suit pas d'échéance). |
| *(requête)* | `{ t: <type>, p, id }` | **Pas de préfixe `µ:`.** Attend un `µ:ack` de même `id`. |
| *(binaire, `µschema`)* | `[u8 idSchéma][charge]` — **aucun** `t`/`p` JSON | Un message applicatif dont le `type` a un schéma déclaré côté serveur (`app.schema`) part encodé, si `ws.codec ≠ 'json'` — décodé et routé vers `app.on`/`app.serve` **comme un message texte normal**, couche invisible pour le code applicatif. Sous la **même** garde de débit/taille qu'un message texte (cf. [23 · MJS-WS §3.1](23-mjs-ws.md#µschema)). En mode `codec: 'binary'` **strict**, une trame **texte** applicative (hors préfixe `µ:`) est **rejetée** (comptée, `µ:error` throttlé) — le client doit alors tout envoyer schématisé. |

### 7.2 Serveur → Client

| Trame | Charge `p` | Effet côté client |
|---|---|---|
| `µ:welcome` | `{}` (libre) + `schemaHash?` | Fin du handshake → état `open`, vide la file hors-ligne. **Obligatoire.** `schemaHash` (`µschema`) présent dès qu'un registre existe côté serveur — hash stable (FNV-1a) du registre (noms+types+ordre). |
| `µ:schema` | `{ version, definitions }` | (`µschema`, [23 · MJS-WS §3.1](23-mjs-ws.md#µschema)) Poussée juste après `µ:welcome` SI `hello.schemaHash` différait du serveur — `definitions` = registre complet sérialisé (JSON-safe), à recharger pour régénérer le miroir local à la volée. |
| `µ:denied` | `{ message, … }` | Auth refusée → fermeture **définitive**, aucune reconnexion. |
| `µ:pong` | `{ ts }` | Réponse au ping → calcule `latency`, calme le watchdog. |
| `µ:ack` | `{ id, e?, p }` | Réponse à une requête. `e` vrai → `reject(p)` ; sinon `resolve(p)`. |
| `µ:error` | `{ message }` (générique) — ou `{ code: 'token-expired' \| 'refresh-denied' }` (causes dédiées) | Erreur applicative **non fatale** → alimente `lastError`. `'token-expired'` **précède** une fermeture par le serveur (jeton expiré côté suivi `opts.token` — reconnexion possible, pas un `µ:bye`) ; `'refresh-denied'` répond à un `µ:refresh` raté — la connexion n'est **pas** affectée. |
| `µ:presence` | `{ room, op: 'reset'\|'join'\|'leave', peers\|id\|meta }` | Delta de présence. |
| `µ:left` | `{ room, reason }` | Le serveur t'a exclu d'un salon (kick) → callback `onLeft`. |
| `µ:bye` | `{ … }` | Fermeture propre décidée par le serveur → close, pas de reconnexion. |
| *(delta de flux)* | `{ t: <flux>, seq, p: { op, … } }` | Voir §4. `t` = nom du flux, **pas** de préfixe `µ:`. **Jamais** schématisé (`seq` est le signal qui l'exclut de `µschema`, cf. 23 §3.1). |
| *(binaire, `µschema`)* | `[u8 idSchéma][charge]` | **Même** enveloppe que la direction Client → Serveur (§7.1) — tout `app.send`/`sendUser`/`broadcast`/`room().send` d'un type schématisé, si `ws.codec ≠ 'json'`. |

### 7.3 Serveur `ws` de référence (Node)

```js
import { WebSocketServer } from 'ws'
const wss = new WebSocketServer({ port: 8080 })
const monde = {}                       // état du flux 'ennemis'
let seq = 0

const diffuser = (op) => {
  const msg = JSON.stringify({ t: 'ennemis', seq: ++seq, p: op })
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg)
}

wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    const m = JSON.parse(buf)
    switch (m.t) {
      case 'µ:hello':                   // 1. handshake → welcome (ou µ:denied)
        ws.send(JSON.stringify({ t: 'µ:welcome', p: {} }))
        break
      case 'µ:ping':                    // 2. battement
        ws.send(JSON.stringify({ t: 'µ:pong', p: { ts: m.p.ts } }))
        break
      case 'µ:sub-stream':              // 3. abonnement flux → instantané reset
        ws.send(JSON.stringify({ t: 'ennemis', seq: ++seq, p: { op: 'reset', values: monde } }))
        break
      case 'µ:resync':                  // 4. trou → on renvoie un reset complet
        ws.send(JSON.stringify({ t: 'ennemis', seq: ++seq, p: { op: 'reset', values: monde } }))
        break
      default:                          // 5. requête applicative → µ:ack (même id)
        if (m.id != null) ws.send(JSON.stringify({ t: 'µ:ack', id: m.id, p: { ok: true } }))
    }
  })
})

// 6. boucle de jeu : numérote et diffuse des deltas
setInterval(() => {
  const id = 'e' + Math.floor(Math.random() * 4)
  monde[id] = { x: Math.random() * 240, y: Math.random() * 120 }
  diffuser({ op: 'add', key: id, value: monde[id] })
}, 500)
```

### 7.4 µschema côté client — le binaire, invisible

`µ.schema(nom, champs)` déclare (côté navigateur) un registre binaire **miroir** de celui du serveur (`app.schema`, cf. [23 · MJS-WS §3.1](23-mjs-ws.md#µschema)) — même vocabulaire de types (`u8`…`f64`, `bool`, `str8`/`str16`, `µ.list(type)`, `µ.bits([noms])`). Dès qu'un type a un schéma déclaré des **deux** côtés, `send`/`on` (§2) l'encodent/décodent en binaire automatiquement, **sans rien changer au code applicatif** :

```html
<script>
  µ.schema 'pos', { x: 'i16', y: 'i16' }   # UNE FOIS (ou dans un fichier partagé, cf. plus bas)

  @sock = µsocket "wss://jeu/play"
</script>

@sock.send 'pos', { x, y }              # part en binaire — quelques octets au lieu d'un JSON verbeux
@sock.on 'pos', (p)-> …                # reçoit l'objet décodé — AUCUNE différence avec du JSON
```

**Déclaration partagée (recommandé).** Un fichier `.mjs`/`.civet`/`.js` commun à l'appli, importé à la fois par l'entry serveur (`app.schema(...)`) et un composant client (`µ.schema(...)`) — mêmes noms/types/ordre des deux côtés ⇒ même hash ⇒ **aucun** aller-retour `µ:schema` au handshake. Alternative paresseuse : ne rien déclarer côté client — le serveur pousse `µ:schema` dès la première connexion (1 aller-retour de plus, zéro fichier à tenir synchronisé à la main).

**`binary: false` — coupe-circuit à l'envoi seulement.**

```html
@sock = µsocket url, { binary: false }   # sock.send() reste TOUJOURS en JSON, même pour un type schématisé
```

La **réception**, elle, continue de décoder toute trame binaire entrante — l'encodage sortant est une décision 100 % **serveur** (`ws.codec`, cf. [23 · MJS-WS §3.1](23-mjs-ws.md#µschema)), indépendante de ce que ce client précis annonce dans son hello. Un client qui arrêterait *aussi* de décoder deviendrait sourd aux messages légitimes dès que le serveur schématise — seul l'envoi est un choix local sûr à couper.

**Limite : pub/sub seulement.** L'enveloppe binaire ne porte **aucun id de corrélation** — `request()` (§3, accusés de réception) reste **toujours** en JSON, même vers un type schématisé. En `ws.codec: 'binary'` **strict** (serveur), ceci a une conséquence à connaître : le serveur rejette *toute* trame texte applicative hors `µ:`, id ou pas — une `request()` vers un type sans schéma y expire donc systématiquement (jamais de `µ:ack`), le `µ:error` retourné l'explique.

---

## 8. Options du socket — `µsocket(url, opts)`

| Option | Défaut | Rôle |
|---|---|---|
| `auth` | — | Fonction (sync/async) ou valeur → jeton envoyé dans `µ:hello`. Ex. `auth: -> { token: $$session.token }` (fonction) ou `auth: { token: '…' }` (valeur directe). |
| `protocols` | — | Sous-protocoles WebSocket. |
| `parse` / `serialize` | `JSON.parse` / `JSON.stringify` | (Dé)sérialisation personnalisée (binaire, MessagePack…). |
| `heartbeat` | `15000` ms | Intervalle des `µ:ping`. `0` = désactivé. |
| `timeout` | `5000` ms | Timeout **par défaut** des requêtes. |
| `reconnect` | `{ enabled: true, retries: ∞, backoff: [500,1000,2000,5000], jitter: 0.3 }` | Politique de reconnexion (backoff exponentiel + gigue). |
| `queueOffline` | `true` | Bufferise les `send` émis hors-ligne, rejoués au `µ:welcome`. |
| `maxQueue` | `1000` | Taille max de la file hors-ligne (les plus vieux sont jetés). |
| `coalesceMs` | `50` ms | Intervalle par défaut du `coalesce` (quand on passe `true`). |
| `debounceMs` | `200` ms | Silence par défaut du `debounce` (quand on passe `true`). |

`sock.refresh(a)` renvoie le jeton **même** contrat que l'option `auth` ci-dessus (valeur ou fonction, sync/async) — mais re-vérifie l'authentification EN **vol**, sans rouvrir la connexion. Utile face à un serveur `mjsWs` qui suit l'expiration du jeton (cf. [23 · MJS-WS § Expiration et rafraîchissement du jeton](23-mjs-ws.md)) : rafraîchir un peu avant l'échéance connue évite la fermeture. Renvoie une Promise (patron `request`, résolue/rejetée via `µ:ack`) — `'refresh'` n'est **pas** un nom d'événement réservé côté `on()`, seule la méthode existe.

```civet
try
  await @sock.refresh -> { token: $$session.token }   # nouveau jeton — même contrat que `auth`
catch e
  µ.error 'jeton refusé au rafraîchissement :', e   # connexion INCHANGÉE, vivante jusqu'à son échéance courante
```

---

## 9. Pièges

- **`open` ≠ WS ouvert.** L'état ne passe `open` qu'au `µ:welcome`. Un serveur qui n'envoie jamais `µ:welcome` laisse le client bloqué en `connecting` (les `send` sont mis en file, pas envoyés).
- **`seq` doit être contigu et strictement croissant** par flux. Un `seq` qui recule ou se répète est ignoré ; un trou déclenche un `µ:resync`. Utilise **un compteur par flux**, pas un timestamp.
- **`close()` vs `destroy()`.** `close()` ferme mais garde le singleton (réutilisable via `connect()`). `destroy()` décrémente le ref-count et ne démonte qu'au **dernier** détenteur. Fermer le socket annule les envois `debounce`/`coalesce` en attente : rien ne repart au `connect()` suivant.
- **Sans `owner` ni `off()`, fuite.** Le socket est un singleton référence-compté PARTAGÉ entre plusieurs composants : `on(type, handler)` renvoie une fonction de dé-abonnement, mais rien ne la relie au cycle de vie de l'appelant sauf à passer `{ owner: @ }` (même mécanisme que `owner` de `µsmooth`). Un composant qui ne rappelle jamais cette fonction (ni `sock.off(type, handler)`, ni `owner`) laisse le handler — et les closures qu'il capture — enregistré à vie sur le socket. Forme recommandée : `@sock.on 'chat', ((p)-> …), { owner: @ }` — sinon, à la main : `@off = @sock.on 'chat', (p)-> …` dans le `<script>`, puis `µdestroy -> @off()`.
- **SVG dans `{for}`** (ex. `<circle>`) : rendu correctement (namespace SVG géré par `µ._mjs_cloneTpl`). Voir [18 · Pièges](18-pieges.md).
- **`µ.optimistic` redevient la seule source de vérité tant qu'un appel est en vol** sur une store donnée : une mutation extérieure posée sur **cette même** store pendant la fenêtre (autre code, un autre flux réseau) est écrasée au rejeu suivant. Dédie une petite store à ce que `µ.optimistic` pilote.
