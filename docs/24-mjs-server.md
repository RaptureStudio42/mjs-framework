# 24 · MJS-Server — la salle de partie (au-dessus de MJS-WS)

> **Module optionnel.** MJS-Server compose une couche « salle de partie » — appariement, sièges, tour par tour, vue par joueur — **par-dessus** [23 · MJS-WS](23-mjs-ws.md), sans le modifier. Tant que tu n'importes pas `mjs-framework/mjs-server`, son coût est **nul** : zéro octet, zéro `Map`, zéro minuterie.

```civet
// serveur — dialecte Civet des composants (§12 doc 23)
import { mjsServer } from 'mjs-framework/mjs-server'

app = mjsServer({ auth: (hello)-> { id: hello.auth?.id } })

app.game('morpion', {
  seats: 2
  state: (game)-> { grille: Array(9).fill(null) }
  moves: {
    jouer: (game, player, p)->
      game.state.grille[p.i] = player.id
      game.next()
  }
})

await app.listen()
```

Côté client, un simple `sock.game('morpion')` suffit — file d'attente, sièges, vue par joueur et reconnexion sont **déjà gérés** :

```civet
game = sock.game('morpion')
```
```html
{if game.state.status === 'playing'}
  {game.state.grille[0]}…
{end}
```

C'est tout ce qu'il faut pour une salle de partie tour par tour complète — appariement, sièges à expiration, tour par tour, vue filtrée par joueur, reconnexion avec rattrapage, et une persistance optionnelle. Les trames `µgame:*` qui transportent tout ça restent **invisibles** : ni l'appli serveur ni l'appli cliente n'y touchent directement.

---

## Sommaire

1. [Philosophie](#philosophie)
2. [Démarrer](#demarrer)
3. [Déclarer un jeu — `app.game(type, def)`](#declarer-un-jeu)
4. [Les coups](#les-coups)
5. [La vue par joueur](#la-vue)
6. [L'appariement](#appariement)
7. [Le client — `sock.game`](#le-client)
8. [La persistance](#persistance)
9. [Configuration](#configuration)
10. [Le mode action : tick et intentions](#mode-action)
11. [Les deltas](#deltas)
12. [Les zones d'intérêt](#zones-interet)
13. [Le réseau des jeux d'action (netcode)](#netcode)
14. [Limites v1 — honnêtement](#limites)
15. [Annexe — le protocole `µgame:*`](#protocole)

---

<a id="philosophie"></a>
## 1. Philosophie

[23 · MJS-WS](23-mjs-ws.md) parle un protocole `µ:` générique — handshake, pub/sub, requêtes, salons, flux. Suffisant pour à peu près tout, mais un **jeu à sièges** (2 joueurs qui s'affrontent, 4 qui coopèrent…) redemande à chaque fois la même mécanique : appariement, qui a la main, qui voit quoi, ce que devient la partie si quelqu'un part. MJS-Server fournit cette mécanique **une fois**, composée par-dessus MJS-WS — jamais par réimplémentation : `app.game()` pose ses propres handlers `µgame:*` sur la **même** app MJS-WS, avec l'API publique (`app.serve`, `app.on`, `app.send`, `app.stop`…) exactement telle que documentée en [23 · MJS-WS §2](23-mjs-ws.md#app-api).

Deux conséquences directes de cette composition :

- **Optionnel, coût nul si absent.** Ne pas importer `mjs-framework/mjs-server` = zéro impact sur une app MJS-WS classique (chat, présence, flux…).
- **Magique pour l'appli.** L'appli hôte ne voit jamais une trame `µgame:*` — le préfixe est **réservé** (`app.serve('µgame:x', …)` ou `app.on('µgame:x', …)` lèvent une erreur claire) —, seulement `app.game(type, def)` côté serveur et `sock.game(type)` côté client. Toute la plomberie (file d'attente, sièges, diffusion groupée par microtâche…) reste interne.

Le socle de MJS-Server reste **tour par tour événementiel** — un coup, une réaction, une diffusion, cf. [§4](#les-coups). Pour un monde qui bouge en continu (une arène, un jeu d'esquive, un espace partagé…), le **mode action** (`def.tick > 0`) ajoute une boucle à fréquence fixe, des intentions et des deltas ([§10](#mode-action), [§11](#deltas)), plus une zone d'intérêt optionnelle ([§12](#zones-interet)). Dans les deux modes, MJS-Server reste un **assemblage** de mécaniques **réseau** (appariement, sièges, diffusion) — jamais un moteur physique : détection de collision, pathfinding, autorité anti-triche fine restent entièrement à ta charge dans `def.simulate`/`def.moves`.

---

<a id="demarrer"></a>
## 2. Démarrer

La commande déclarative `mjs serveur` (commande **sœur** de [`mjs ws`](23-mjs-ws.md#mjs-ws), même contrat) évite d'écrire toi-même le script qui construit l'app et l'écoute : elle charge un **fichier d'entry**, y branche `mjsServer()`, le rechargement à chaud et l'arrêt propre, puis démarre.

```bash
mjs serveur                        # serveur.server.mjs ou serveur.js (résolution complète : §2.2), port 4001 par défaut
mjs serveur --entry arene.server.mjs --port 4110
mjs serveur --root chemin/vers/le/projet
```

### 2.1 Le fichier d'entry

Un fichier serveur MJS-Server se pose **exactement** comme un fichier serveur MJS-WS ([23 · MJS-WS §6.1](23-mjs-ws.md#mjs-ws)) — même dialecte Civet (assignations nues auto-déclarées, `->`, hash sans virgules entre lignes, `"…#{x}…"`…), même contrat `export default { …options, setup(app) }` (port/host/onLog réservées au CLI, ignorées avec un avertissement), même compilation vers un fichier réel sous le cache et même grammaire `@import` pour importer un fichier du projet ([23 · MJS-WS §13](23-mjs-ws.md#civet-entry)). La seule différence : `setup(app)` reçoit une app construite par `mjsServer()` (qui expose `.game()`), pas `mjsWs()` :

```civet
// arene.server.mjs — dialecte Civet des composants (§12 doc 23)
export default {
  auth: (hello)-> { id: hello.auth?.id, pseudo: hello.auth?.pseudo }

  setup: (app)->
    app.game 'morpion', {
      seats: 2
      state: (game)-> { grille: Array(9).fill(null) }
      moves: {
        jouer: (game, player, p)->
          throw new Error('case occupée') if game.state.grille[p.i]?
          game.state.grille[p.i] = player.id
          game.next()
      }
    }
}
```

Les accolades explicites du hash **racine** sont nécessaires ici : deux clés fratries (`auth`, `setup`) dont une à corps multi-lignes, sans elles, compilent en un objet **appelé** comme une fonction (« `{(intermediate value)} is not a function` » au chargement) plutôt qu'en un seul objet — même piège que l'exemple `.server.mjs` de [23 · MJS-WS §6.1](23-mjs-ws.md#mjs-ws).

Si le default export est absent ou n'est pas un objet, `mjs serveur` refuse de démarrer avec une erreur claire. Si **aucun** fichier d'entry n'est trouvé, l'erreur imprime directement un squelette minimal à copier-coller.

### 2.2 Résolution de l'entry

| Source | Priorité |
|---|---|
| `--entry <chemin>` | 1 — toujours respecté tel quel ; erreur immédiate si le fichier n'existe pas |
| `serveur.entry` (mjs.config.json) | 2 — même règle : erreur immédiate si absent |
| `serveur.server.mjs` (racine du projet) | 3 — format **recommandé** |
| `server/serveur.server.mjs` | 4 |
| `serveur.js` (racine du projet) | 5 |
| `serveur.civet` (racine du projet) | 6 |
| `server/serveur.js` | 7 |
| `server/serveur.civet` | 8 |

Ces défauts ne recoupent **jamais** ceux de `mjs ws` (`ws.server.mjs`/`ws.js`/…) — les deux commandes coexistent sans collision dans un même projet (ex. un chat MJS-WS sur un port, une salle de jeu MJS-Server sur un autre).

### 2.3 Configuration — section `serveur` de mjs.config.json

**Mêmes** clés que `ws` ([23 · MJS-WS §6.3](23-mjs-ws.md#mjs-ws)) — `mjsServer()` accepte **exactement** les mêmes options que `mjsWs()` — plus `antiCheat` ([§9](#configuration)) :

```json
{
  "serveur": {
    "entry": "server/arene.server.mjs",
    "port": 4110,
    "antiCheat": { "movesPerIdentity": [40, 1000], "codePerIp": [10, 60000] }
  }
}
```

Port : priorité `--port` > `serveur.port` > `4001` (**distinct** du `4000` de `mjs ws`). Hôte d'écoute : `127.0.0.1` par défaut, `--host ::` pour exposer sur toutes les interfaces. Chaque clé partagée avec `ws` (transport/codec/heartbeat/limits/token/bridge/resume/adapter/stats/sessionExclusive/verifyOrigin), ainsi qu'`antiCheat`, est définissable **ici** **ou** dans l'entry — en cas de doublon, l'**entry prime EN bloc**, avec un avertissement (**même** règle que §6.4 doc 23). `persist` ([§8](#persistance)) reste **entry-only** : ses adaptateurs exposent des fonctions (`load`/`save`/`remove`), non représentables en JSON.

Rechargement à chaud et arrêt propre : **même** comportement que `mjs ws` ([23 · MJS-WS §6.5-§6.6](23-mjs-ws.md#mjs-ws)).

### 2.4 Lancement programmatique

Le fichier d'entry ci-dessus reste un module ordinaire — rien n'empêche de construire et d'écouter l'app toi-même, sans passer par `mjs serveur` (utile en dehors du CLI, ou pour composer avec un serveur HTTP existant) :

```civet
import { mjsServer } from 'mjs-framework/mjs-server'

app = mjsServer({ auth: (hello)-> { id: hello.auth?.id } })
app.game('morpion', { seats: 2, state: (game)-> { grille: Array(9).fill(null) }, moves: { … } })
await app.listen()
```

---

<a id="declarer-un-jeu"></a>
## 3. Déclarer un jeu — `app.game(type, def)`

`app.game(type, def)` déclare un type de partie — throw immédiat si `type` est déjà déclaré, ou si `def` contient une clé inconnue ou mal typée (même validation stricte que `mjs.config.json` : suggestion orthographique incluse). Voici le morpion fil rouge de cette page, **champ par champ** :

```civet
app.game('morpion', {
  seats:   2                         # sièges requis pour démarrer — entier ≥ 1
  code:     true                      # autorise les parties privées par code court (§6)
  seatTtl:  15000                     # fenêtre de confirmation des sièges issus de la file (§6), défaut 10000
  emptyTtl: 60000                     # partie sans plus aucun siège CONNECTÉ → détruite après ce délai, défaut 60000

  state: (game)-> { grille: Array(9).fill(null), lettres: {}, secrets: {} }

  moves: {
    jouer: (game, player, p)->     # cf. §4
      throw new Error('case occupée') if game.state.grille[p.i]?
      game.state.grille[p.i] = game.state.lettres[player.id]
      game.next()
  }

  view: (game, player)-> game.state   # vue filtrée par joueur — défaut montré ici, cf. §5 pour l'exemple qui masque un champ

  phases: {
    attente: ['pret']
    jeu:     ['jouer']
    fin:     []
  }

  turns: {
    order:   'roundrobin'             # ou une fonction (game)-> player|id|null
    timeout: 30000                    # ms — minuterie 'µturn' réarmée à chaque game.next()
  }

  timers: {
    rappel: (game)-> game.send('rappel', { pour: game.turn })   # minuterie NOMMÉE — cf. §4
  }

  limits: {
    moves: [10, 10000]                # seau à jetons PAR SIÈGE — 10 coups / 10 s max
  }

  hooks: {
    onCreate:      (game)-> µ.log('partie créée', game.id)
    onJoin:        (game, player)-> µ.log('siège', player.seat, 'occupé')
    onLeave:       (game, player)-> µ.log('siège', player.seat, 'libéré')
    onEnd:         (game, result)-> µ.log('partie finie', result)
    onTurnTimeout: (game)-> game.next()   # défaut si non fourni (cf. §4)
  }
})
```

| Champ | Type | Défaut | Rôle |
|---|---|---|---|
| `seats` | entier ≥ 1 | — (requis) | sièges requis pour démarrer la partie |
| `code` | booléen | `false` | autorise les parties privées par code court (§6) |
| `seatTtl` | nombre > 0 (ms) | `10000` | fenêtre de confirmation des sièges issus de la **file** (§6) |
| `tick` | nombre ≥ 0 | `0` | `0` = tour par tour événementiel (§4) ; de `1` à `60` = mode **action**, boucle à tick (§10) |
| `state` | `(game)-> état` | — (requis) | état initial, appelé une fois à la création |
| `moves` | `{ nom: (game, player, p)-> résultat }` | — (requis) | les coups déclarés (§4) |
| `view` | `(game, player)-> view` | état entier, non filtré | vue par joueur (§5) |
| `phases` | `{ phase: [moves permis] }` | aucune restriction | coups autorisés par phase (§4) |
| `turns` | `{ order?, timeout? }` | pas de tour suivi | ordre + minuterie de tour (§4) |
| `timers` | `{ nom: (game)-> void }` | `{}` | minuteries **nommées** (§4) |
| `limits` | `{ moves?: [n, fenêtreMs] }` | `[30, 1000]` (30 coups/s) | anti-abus par siège (réutilise le seau à jetons de MJS-WS) — mettre `null` pour un jeu action haute fréquence |
| `emptyTtl` | nombre > 0 (ms) | `60000` | grâce avant destruction d'une partie sans plus aucun siège connecté |
| `hooks` | `{ onCreate?, onJoin?, onLeave?, onEnd?, onTurnTimeout? }` | `{}` | points d'extension (§4) |

> 🔤 **Vocabulaire.** `game` est l'instance vivante (état, sièges, phase, tour…) ; `player` est un **siège** (`{ seat, id, connected }` — `id` = identité stable, cf. [§7](#le-client) sur la reconnexion) ; `p` est la charge libre envoyée par le client avec son coup.

---

<a id="les-coups"></a>
## 4. Les coups

Un coup arrive par `µgame:move { game, move, p? }` (§15) — mais l'appli ne voit jamais cette trame, seulement l'appel à `def.moves[move](game, player, p)`. Avant cet appel, MJS-Server vérifie dans l'ordre :

1. **Assis ?** — la connexion doit occuper un siège de **cette** partie, sinon `"vous n'êtes pas assis dans cette partie"`.
2. **Phase ?** — si `def.phases` est déclaré, le coup doit figurer dans la liste de la phase courante, sinon `"coup '<x>' interdit en phase '<phase>'"`.
3. **Tour ?** — si `def.turns` est déclaré ET qu'un tour a déjà été établi (`game.turn !== null` — donc jamais bloquant **avant** le premier `.next()`, par exemple pendant une phase d'attente), le siège doit être celui dont c'est le tour, sinon `"ce n'est pas votre tour"`.
4. **Débit ?** — si `def.limits.moves` est déclaré, le seau à jetons DE CE **siège** doit avoir un jeton, sinon `"trop de coups, ralentis"`.

Seulement alors `def.moves[move](game, player, p)` s'exécute. **Un `throw`** — dans une de ces 4 gardes internes OU dans le move lui-même — devient un refus : la `Promise` de `game.move(...)` côté client est **rejetée** avec le message, exactement comme un `app.serve()` MJS-WS ordinaire qui lève ([23 · MJS-WS §1](23-mjs-ws.md#options)). Aucun état n'est jamais modifié par un coup refusé.

Un coup **accepté** est journalisé (`{ move, player, p, at }`, borné à 200 entrées — usage interne, sérialisation/persistance §8, jamais diffusé aux clients) puis déclenche une diffusion groupée : toute mutation de `game.state` (ou `.to()`/`.next()`) faite dans le même move est regroupée en **une seule** trame `µgame:state` par joueur, envoyée à la microtâche suivante — jamais une par ligne de code.

### Tour par tour — `turns` + `.next()`

`game.next()` fait tourner `game.turn` : `turns.order === 'roundrobin'` (défaut) prend le siège occupé suivant dans l'ordre des places (connecté ou non — v1 ne saute **jamais** un absent automatiquement, cf. [§14](#limites)) ; une fonction `(game)-> player|id|null` calcule le tour toi-même. `.next()` sans `def.turns` déclaré ne fait rien. Chaque appel réarme aussi la minuterie de tour (`turns.timeout`, réservée en interne sous le nom `'µturn'`) : à l'échéance, `hooks.onTurnTimeout(game)` s'exécute si fourni, sinon MJS-Server appelle `.next()` lui-même (le tour passe simplement au suivant). Sans `turns.timeout` déclaré, aucune minuterie n'est armée : un siège qui ne joue jamais son tour bloque la partie pour tous, sans filet automatique.

### Minuteries **nommées** — `timers` + `.timer()`

Au-delà du tour, `def.timers` déclare des échéances arbitraires — `game.timer('rappel', 5000)` arme (ou réarme) une minuterie nommée `'rappel'` ; à l'échéance, `def.timers.rappel(game)` s'exécute. Sérialisables par construction (`{ name, at }`, jamais une fermeture stockée — cf. §8) : elles survivent à une restauration depuis la persistance. Trois noms sont **réservés** à MJS-Server (`'µturn'`, `'µmatch'`, `'µempty'`) — les utiliser dans `def.timers` ou en argument de `.timer()` lève une erreur claire.

### `game.to(phase)`

Change `game.phase` — validé contre `def.phases` SI déclaré (phase inconnue → erreur), libre sinon. `.end()` n'impose **aucune** phase de fin : pour fermer les coups après la victoire, déclare ta propre phase (`fin: []` dans l'exemple du §3) et atteins-la toi-même via `.to('fin')`.

### Finir — `game.end(result)`

Diffuse `µgame:end { result }` à tous les sièges connectés, appelle `hooks.onEnd?.(game, result)`, puis arme la destruction après `def.emptyTtl` (la partie reste interrogeable — un dernier `µgame:resync` fonctionne encore — le temps que les clients encaissent la fin).

---

<a id="la-vue"></a>
## 5. La vue par joueur

`def.view(game, player)` calcule ce qu'UN siège voit — appelée à chaque diffusion, par joueur, jamais un envoi brut de `game.state`. Sans `view` fourni, le défaut renvoie `game.state` **entier, non filtré** — tout le monde voit tout. Le morpion fil rouge masque un champ privé :

```civet
state: (game)-> { grille: Array(9).fill(null), lettres: {}, secrets: {} }

hooks: {
  onJoin: (game, player)->
    lettre = if game.players.filter(Boolean).length == 1 then 'X' else 'O'
    game.state.lettres[player.id] = lettre
    game.state.secrets[player.id] = "c'est toi qui commences" if lettre == 'X'
}

view: (game, player)->
  { secrets, ...pub } = game.state
  { ...pub, monSecret: player ? secrets[player.id] : null }
```

X et O voient tous les deux `grille`/`lettres` (publics), mais `monSecret` diffère : X voit son mot, O voit `null` — et le champ brut `secrets` (la carte **complète**, avec le secret de l'autre) ne quitte **jamais** le serveur, puisque `view()` ne renvoie que `pub` (déstructuré **sans** `secrets`) plus `monSecret`. C'est le patron général pour tout état « caché » (main de cartes, rôle secret…) : garde-le dans une clé à part de `game.state`, et ne le fais jamais transiter tel quel par `view()`.

> 🔤 `player` reçu par `view()` peut être `null` : c'est le cas d'un **spectateur** (`µgame:play { spectator: true }`, par code de partie), qui n'occupe pas de siège. La vue sûre du spectateur passe par `def.spectatorView(game)` si défini, sinon `view(game, null)` — jamais l'état brut par défaut. Cf. la couche anti-triche (§ anti-triche).

---

<a id="appariement"></a>
## 6. L'appariement

`sock.game(type, opts?)` peut viser trois destinations, discriminées par la **forme** de `opts.code` — **jamais** par sa seule présence :

| `opts.code` | Destination | Exige |
|---|---|---|
| absent | file d'attente **publique** du type | — |
| `true` | crée une partie **privée** neuve, code généré | `def.code === true` |
| `"ABCDE"` (chaîne) | rejoint la partie privée à ce code | `def.code === true` — code inconnu → erreur |

### La file publique

Chaque type a sa propre file FIFO. Un ticket s'ajoute à chaque `µgame:play` sans code ; tant que `seats` n'est pas atteint, le client reçoit `{ queue: n }` (sa position) — pas encore assis. Dès que `seats` est atteint, une partie **naît complète** : tous les tickets prennent siège d'un coup. Le siège de la connexion dont la requête a complété le groupe est confirmé immédiatement (c'est sa propre réponse) ; les autres sièges — déjà en file, prévenus par une poussée `µgame:start` — ont `seatTtl` pour se manifester (un coup ou un `µgame:resync` suffit à confirmer). **Personne ne se manifeste ? La partie entière est annulée** (pas de re-complétion partielle depuis la file) : `µgame:end { result: { cancelled: true, reason: 'seat-expired' } }` à qui restait connecté, partie détruite. C'est le choix le plus simple des deux envisagés au départ — documenté ici, pas de configuration plus fine en v1.

### Les parties privées — `code: true`

`def.code: true` autorise deux usages : `opts.code: true` crée une partie **neuve** avec un code court généré (5 caractères, alphabet sans `0`/`O`/`1`/`I` — ambiguïté typographique — porté par la réponse) ; `opts.code: "ABCDE"` rejoint cette partie. Le fondateur d'une partie par code est confirmé par SA **propre** requête (rien à surveiller via `seatTtl` tant qu'il reste connecté) — `emptyTtl` suffit à purger un fondateur qui repart sans jamais recevoir personne. Rejouer `µgame:play` avec le même code depuis la **même** connexion déjà assise est **idempotent** (renvoie le siège existant, ne throw pas).

### La grâce des parties vides — `emptyTtl`

Indépendamment de `seatTtl` : dès qu'**aucun** siège n'est plus connecté (tout le monde a fermé son onglet), une partie (file ou code) est détruite après `emptyTtl` (défaut 60 s) — un retour d'un siège avant l'échéance désarme la destruction. C'est le filet qui évite qu'une partie orpheline vive indéfiniment en mémoire.

---

<a id="le-client"></a>
## 7. Le client — `sock.game`

Posé par-dessus `µ.socket` (module runtime `game`, cf. [§9](#configuration)) :

```civet
game = sock.game('morpion')                     # file publique
game = sock.game('morpion', { code: true })      # crée une partie privée (code généré)
game = sock.game('morpion', { code: 'ABCDE' })   # rejoint ce code (inconnu → statut 'error')
```

`sock.game()` renvoie la **poignée immédiatement** — jamais une Promise nue (même choix que `stream()`/`presence()`, [20 · Temps réel](20-temps-reel.md)) : l'appli affiche l'attente dès le premier tick, sans rien attendre.

### Le store réactif — À **plat**

`game.state` est un store réactif µ — les clés de LA **vue** (celle que `def.view` a calculée pour ce joueur, §5) sont fusionnées **telles quelles à la racine**, à côté de méta-clés réservées :

| Clé | Type | Sens |
|---|---|---|
| `gameId` | chaîne \| `null` | `null` tant que jamais assis |
| `seat` | nombre \| `null` | numéro de siège |
| `phase` | chaîne \| `null` | `game.phase` côté serveur |
| `turn` | chaîne \| `null` | identité stable du siège dont c'est le tour |
| `seq` | nombre \| `null` | dernier numéro de séquence appliqué |
| `code` | chaîne \| `null` | code de partie privée si `def.code`, sinon `null` |
| `queue` | nombre \| `null` | position dans la file publique, `null` sinon |
| `status` | `'waiting'\|'playing'\|'finished'\|'left'\|'error'` | cycle de vie de LA **poignée** |
| `seats` | tableau \| `null` | dernier roster `µgame:seat` — `[{seat,connected}\|null, …]` |
| `result` | — \| `null` | résultat de `µgame:end` |
| `error` | chaîne \| `null` | message du dernier refus **serveur** |

Le reste — les clés propres à `def.view` (ici `grille`, `lettres`, `monSecret`) — se lit directement, sans indirection :

```html
{if game.state.status === 'waiting'}
  en file, position {game.state.queue}
{end}
{if game.state.status === 'playing'}
  {game.state.grille[0]}…
{end}
```

> ⚠️ **Collision de noms.** Si `def.view` renvoie une clé qui porte le **même** nom qu'une des méta-clés ci-dessus (par exemple un jeu qui aurait sa propre notion de `code` ou de `status`), elle est **écrasée** par la méta-clé — même compromis assumé que le `'reset'` d'un flux MJS-WS. À connaître avant de nommer les champs de ta vue.

### Jouer — `.move()`

```civet
try
  result = await game.move('jouer', { i: 4 })
catch e
  µ.error 'coup refusé :', e
```

`.move(nom, p)` renvoie une **Promise**, résolue par le `result` du move côté serveur, rejetée par le motif de refus (chaîne = refus applicatif du serveur ; objet `{code,message}` = refus transport, même contrat que `sock.request()`). Rejette aussi `{code:'not-seated'}` si appelée avant tout siège connu.

### Les 7 événements — `.on()`

```civet
off = game.on('end', (p)-> µ.log 'partie finie :', p.result)
```

`'state'` (à chaque mutation), `'seat'` (roster), `'event'` (`game.send()` libre, §4), `'start'` (assis — appel direct ou poussée), `'end'`, `'left'` (un **autre** siège est parti), et `'error'` — ce dernier n'est **pas** une trame serveur : c'est le seul moyen d'observer un refus de `play`/`resync`, puisque `sock.game()` ne renvoie pas de Promise.

### Reconnexion — resync **automatique**

Au `µ:welcome` d'une reconnexion (cf. [23 · MJS-WS §8](23-mjs-ws.md#reprise-session)) : chaque partie **déjà assise** (`status: 'playing'`) relance `µgame:resync` toute seule — siège retrouvé par identité **stable** (`opts.auth` de `µsocket`, cf. [§14](#limites)) ; chaque partie encore **en file** (`status: 'waiting'`) rejoue `µgame:play` depuis zéro (la file ne survit pas à une déconnexion côté serveur). Un refus **serveur** sur l'un ou l'autre chemin est **terminal** — jamais retenté en boucle, seulement `status: 'error'` + l'événement `'error'`. Rien à coder côté appli.

### Plusieurs parties à la fois

Chaque `sock.game()` renvoie une poignée **indépendante** — aucun singleton par type (contrairement à `stream()`/`presence()`). Limite connue : si le **même** socket met en file plusieurs types **simultanément** (plusieurs `sock.game()` pas encore assis en même temps), la correspondance entre une poussée `µgame:start` de complétion de **file** et LA **bonne** poignée en attente se fait par ordre FIFO (la plus ancienne poignée non assise) — fiable tant qu'un seul message est traité à la fois côté serveur (toujours vrai), moins évident à suivre visuellement si tu ouvres beaucoup de files d'un coup.

### Interpoler côté client — `µsmooth`

En mode action ([§10](#mode-action)), les entités reçues par `µgame:state` sautent d'un tick à l'autre (15-20 Hz typique) — un mouvement saccadé si `game.state` est affiché tel quel. `µsmooth` (cf. [20 · Temps réel](20-temps-reel.md) §6 « Lissage réseau ») interpole entre les dernières positions reçues, à la fréquence d'affichage (60 fps), indépendamment de la cadence réseau :

```civet
game = sock.game('arene', { code: true })
$$fluide = µsmooth game.state.entites, { delay: 100, owner: @ }
```
```html
{if game.state.status === 'playing'}
  {for id, e in $$fluide}
    <@entity x={e.x} y={e.y}>
  {end}
{end}
```

`game.state.entites` (ou tout champ de ta vue qui est un dictionnaire `{id: {x, y, …}}`) sert directement de **source** — `µsmooth` ne demande aucun câblage supplémentaire côté MJS-Server, que la vue soit complète ou reconstruite à partir de deltas ([§11](#deltas), transparent pour le client). `owner: @` (le composant appelant) permet à `$$fluide` de s'auto-disposer à la destruction du composant — sans lui, sa boucle d'interpolation tourne À **vie**.

> 🔗 Ce lissage générique suffit pour un affichage simple. Pour un vrai jeu d'action sous latence (mouvement distant + tir + éventuellement un mode déterministe), [§13 « Le réseau des jeux d'action »](#netcode) va plus loin : `µ.interp` (période auto-mesurée, extrapolation puis gel), `µ.predict` (réponse immédiate sur ta propre entité) et la compensation de lag côté serveur (`def.history`/`game.rewind`).

<a id="contrat-type-jeu"></a>
### Contrat typé (optionnel)

**Même** surcouche de typage optionnelle que MJS-WS ([23 · MJS-WS §11](23-mjs-ws.md#contrat-type) — lis-la
d'abord pour la **réalité** complète : compilation séparée `.server.mjs`/`.mjs`, coût nul à
l'exécution), appliquée ici à `app.game`/`sock.game` : `src/mjs-server/contract.ts` fournit
`MjsServerGameContract` (la forme de `view`/`moves` **vue du client**) et `TypedGame<G>` — `game.state`
et `game.move()` typés, sans rien changer au protocole `µgame:*`.

```ts
// contrat.ts — partagé entre ws.server.mjs et le composant qui affiche le morpion
import type { MjsServerGameContract } from 'mjs-framework/mjs-server'

export interface MorpionContrat extends MjsServerGameContract {
  view: { grille: Array<string | null> }
  moves: {
    jouer: (p: { i: number }) => boolean   // result renvoyé par def.moves.jouer
  }
}
```

Côté composant — `sock.game()` reste identique, `asTypedGame` ne fait que caster la poignée :

```civet
<script>
  import type { MorpionContrat } from '../contrat.ts'
  import { asTypedGame } from 'mjs-framework/mjs-server'

  game = asTypedGame<MorpionContrat>(sock.game('morpion'))
</script>
```
```html
{if game.state.status === 'playing'}
  {game.state.grille[0]}…           <!-- 'grille' inféré Array<string|null>, méta RÉSERVÉES aussi typées -->
{end}
```
```civet
result = await game.move('jouer', { i: 4 })   # résultat inféré boolean
```

Un `game.move('jouer', { j: 4 })` (mauvaise clé) ou un `game.state.gril` (typo) sont des erreurs
`tsc`, pas des bugs à l'exécution — cf. `tests/contract-types.test.ts` pour la liste vérifiée.

`TypedGameDef<G>`/`defineTypedGame(def)` bordent symétriquement le bout **serveur** (`app.game(type,
def)`) sur le MÊME contrat — `def.view`/`def.moves[...]` typés contre `G`, `game`/`player`
restent les vrais types serveur (`Game`/`MjsServerSeat`). `.on()` (les 7 événements, ci-dessus)
reste en dehors du contrat — payload `any`, comme aujourd'hui.

---

<a id="persistance"></a>
## 8. La persistance

Optionnelle — `opts.persist` absent = **aucun** hook armé (pas une `Map`, pas une minuterie créées). Le contrat, par duck-typing **strict** (n'importe quel objet qui expose ces fonctions convient) :

```ts
interface MjsServerPersistAdapter {
  load(): Promise<Array<{ id: string; data: MjsServerGameSnapshot }>>   // lu UNE FOIS au boot
  save(id: string, data: MjsServerGameSnapshot): void | Promise<void>  // jamais attendu par l'appelant
  remove(id: string): void | Promise<void>
  flush?(): void | Promise<void>                                          // appelé par app.stop(), après la rafale finale
}
```

```civet
app = mjsServer({ persist: { adapter: new MemoryPersistAdapter(), debounce: 150, snapshotEvery: 0 } })
```

`opts.persist` accepte l'adaptateur NU (défauts appliqués) ou `{ adapter, debounce?, snapshotEvery? }`. **Débounce** (défaut 150 ms) : chaque mutation diffusée d'une partie réarme une minuterie — N mutations rapprochées → UN seul `save()`, celui qui capture l'état après la dernière. **`snapshotEvery`** (défaut `0` = désactivé) est le **plancher** : sous mutation continue (chaque coup réarme le débounce avant qu'il n'expire), un débounce pur ne sauve jamais — `snapshotEvery` force un `save()` des parties encore sales à intervalle fixe.

Au démarrage, `app.listen()` **charge avant d'écouter** — aucun client ne peut arriver sur une partie pas encore restaurée. À l'arrêt, `app.stop()` sauve une dernière fois les parties encore sales **puis** `flush()` l'adaptateur, **puis** coupe les minuteries — un ordre inversé perdrait les minuteries en cours au prochain redémarrage. Détruire une partie pour un **arrêt serveur** ne l'efface **jamais** du stockage (elle revit au prochain boot via `load()`) — seule une **vraie** fin (`.end()`, `emptyTtl`, annulation de sièges) appelle `remove()`.

### Les adaptateurs fournis

| Adaptateur | Fichier | Stockage |
|---|---|---|
| `MemoryPersistAdapter` | `persist.ts` | en mémoire — tests, ou dev sans rien installer |
| `FilePersistAdapter({ dir })` | `persist-file.ts` | un fichier JSON par partie, écriture **atomique** (tmp + rename) ; fichier corrompu au `load()` → ignoré + `warn`, jamais un crash de boot |
| `BridgePersistAdapter({ url, secret })` | `persist-bridge.ts` | **Pousse** vers un back HTTP par requêtes signées HMAC-SHA256 (même machinerie que le pont MJS-WS) — le back garde la vraie base ; 3 tentatives puis abandon + `warn`, jamais bloquant |
| `RedisPersistAdapter({ url\|host/port, prefix? })` | `persist-redis.ts` | UN hash Redis pour tout le process (`HSET`/`HDEL`/`HGETALL`) — cf. ci-dessous |
| `SqlPersistAdapter({ query, table?, dialect? })` | `persist-sql.ts` | **Une** table SQL générique, pilote injecté par l'appli — cf. ci-dessous |
| instance maison | — | n'importe quel objet `{ load, save, remove, flush? }` |

### La règle — du **texte**, encodé par l'adaptateur lui-même

Aucun adaptateur ne confie le typage de `data` au moteur de stockage : il encode **lui-même** et stocke du **texte** — `data TEXT` dans le DDL SQL, un champ de hash Redis, un fichier `.json`. Jamais une colonne `JSON`/`JSONB` typée. La raison est mesurée, pas théorique : le **même** schéma déclarant une colonne `json` rend un objet sous MySQL et une **chaîne** sous MariaDB (où `json` n'est qu'un alias de `LONGTEXT` + `CHECK json_valid`) — un back qui délègue son typage au moteur change de comportement en changeant de machine, sans qu'une ligne de code ait bougé. Le texte, lui, se relit pareil partout : c'est aussi pourquoi `dialect` ne sert **qu'à** la syntaxe des paramètres bind (`?` contre `$1`), jamais au typage.

La paire d'encodage est exportée — un adaptateur **maison** utilise exactement la même que les nôtres, et hérite du jour où l'un des trois devra traiter un cas particulier (valeur cyclique, `Date`, très gros payload) :

```ts
import { mjsServer, encodeSnapshot, decodeSnapshot } from 'mjs-framework/mjs-server'

const store = new Map<string, string>()                                                       // que du TEXTE
const app   = mjsServer({ persist: {
  save(id, data) { store.set(id, encodeSnapshot(data)) },
  remove(id)     { store.delete(id) },
  async load()   { return [...store].map(([id, raw]) => ({ id, data: decodeSnapshot(raw) })) }
}})
```

`decodeSnapshot` **lève** sur une entrée illisible : les adaptateurs fournis attrapent, journalisent un `warn` et **sautent** l'entrée — une partie corrompue n'empêche jamais les autres de revivre.

### La recette pont — pousser vers Rails (ou équivalent)

`BridgePersistAdapter` attend **une** URL, 3 opérations : `POST {op:'save', id, data}`, `POST {op:'remove', id}`, `GET` (corps vide) → `{ok:true, games:[{id,data}, …]}`. Côté back (n'importe quel langage qui sait vérifier une HMAC ; Ruby/Rails ci-dessous, pseudo-code fidèle à l'en-tête de `persist-bridge.ts`) :

```ruby
SECRET = ENV.fetch('MJS_SERVEUR_PERSIST_SECRET')                # même secret que { secret: … } côté TS

def verifie!(ts, corps)                                      # halt 401 si signature/horodatage invalides
  halt 401 if ts.nil? || (Time.now.to_i - ts.to_i).abs > 300
  attendue = OpenSSL::HMAC.hexdigest('SHA256', SECRET, "#{ts}.#{request.request_method}.#{request.path}.#{corps}")
  halt 401 unless Rack::Utils.secure_compare(attendue, request.env['HTTP_X_MJS_WS_SIGNATURE'].to_s)
end

post('/mjs-server/persist') do
  corps = request.body.read
  verifie!(request.env['HTTP_X_MJS_WS_TIMESTAMP'], corps)
  body = JSON.parse(corps)                                   # {op, id, data?} — APRÈS vérification
  case body['op']
  when 'save'   then Game.upsert(id: body['id'], data: body['data'].to_json)
  when 'remove' then Game.where(id: body['id']).delete_all
  end
end

get('/mjs-server/persist') do
  verifie!(request.env['HTTP_X_MJS_WS_TIMESTAMP'], '')        # GET = corps vide → même chaîne canonique
  { ok: true, games: Game.all.map { |p| { id: p.id, data: JSON.parse(p.data) } } }.to_json
end
```

La vérification ci-dessus suit la **même** recette que le pont MJS-WS (en-têtes `x-mjs-ws-timestamp`/`x-mjs-ws-signature`, chaîne canonique `${ts}.${MÉTHODE}.${chemin}.${corps}`, anti-rejeu ± 300 s) — cf. [23 · MJS-WS §7.5](23-mjs-ws.md#pont) pour le webhook (Node) et §7.11 pour la même vérification côté Rails. Copier le bloc ci-dessus **sans** `verifie!` expose save/remove/load de n'importe quelle partie à qui sait faire un POST.

### Redis et SQL

```civet
import { mjsServer, RedisPersistAdapter } from 'mjs-framework/mjs-server'

app = mjsServer({ persist: new RedisPersistAdapter({ url: 'redis://localhost:6379', prefix: 'mjs-server:' }) })
```

`RedisPersistAdapter` réutilise le mini-client RESP maison de MJS-WS (**zéro** dépendance npm) — connexion **paresseuse** (rien d'ouvert avant le premier `save`/`remove`/`load`), un seul hash Redis pour tout le process (`<prefix>games`, un **champ** par partie : `HSET`/`HDEL`/`HGETALL`).

`SqlPersistAdapter` ne pilote **aucun** pilote lui-même — l'appli injecte SA fonction `query`, déjà branchée sur son propre pool :

```js
// mysql2 — dialecte '?' (paramètres positionnels), défaut
import mysql from 'mysql2'
import { mjsServer, SqlPersistAdapter } from 'mjs-framework/mjs-server'

const pool  = mysql.createPool({ host: '…', database: '…' }).promise()
const query = async (sql, params) => { const [rows] = await pool.query(sql, params); return rows }

app = mjsServer({ persist: new SqlPersistAdapter({ query, dialect: '?' }) })
```

```js
// pg — dialecte '$' (paramètres numérotés $1 $2 …)
import pg from 'pg'
import { mjsServer, SqlPersistAdapter } from 'mjs-framework/mjs-server'

const client = new pg.Client({ connectionString: '…' })
await client.connect()
const query = async (sql, params) => { const { rows } = await client.query(sql, params); return rows }

app = mjsServer({ persist: new SqlPersistAdapter({ query, dialect: '$' }) })
```

`SqlPersistAdapter` crée sa table (`CREATE TABLE IF NOT EXISTS <table> (id VARCHAR(64) PRIMARY KEY, data TEXT, updated_at BIGINT)`, **ddl** dialecte-agnostique) une seule fois à la construction, puis `save()` est un **upsert** en un aller-retour (`ON DUPLICATE KEY UPDATE` en `?`, `ON CONFLICT … DO UPDATE` en `$`). `updated_at` est posé à chaque `save()` (horodatage ms) et n'est jamais relu par le serveur : il est là pour toi, pour trier ou diagnostiquer.

> ⚠️ **Trois pièges à connaître avant de câbler l'un ou l'autre.**
> - **`opts.query` doit renvoyer un tableau de lignes pour un `SELECT`** (`rows`, jamais `{rows}` ni la paire `[rows, fields]` brute d'un pilote — désenveloppe-le toi-même dans ta fonction `query`, cf. les deux recettes ci-dessus qui le font déjà) : `load()` fait `Array.isArray(lignes) ? lignes : []` — un mauvais format ne throw **pas**, le serveur démarre juste **sans** restauration, silencieusement.
> - **`flush()` ferme la connexion Redis.** Appelé une seule fois par `app.stop()`, `RedisPersistAdapter.flush()` attend la file en vol **puis** coupe le socket — au-delà de ce qu'exige le contrat `MjsServerPersistAdapter` minimal, mais nécessaire : sans cette fermeture, le cycle de reconnexion à backoff de la connexion RESP tournerait indéfiniment après l'arrêt du serveur. Ne réutilise jamais un `RedisPersistAdapter` après `app.stop()`.
> - **Redis injoignable → 5 s puis abandon, jamais un blocage.** Toute attente de connexion (au boot comme en cours de vie) est bornée à 5 s : passé ce délai, `save()`/`remove()` abandonnent avec un `warn` (« le prochain `save()` rattrapera l'état »), et `load()` démarre **sans** restauration plutôt que de geler `app.listen()` indéfiniment.

### Migrer un stockage écrit par une version antérieure

L'instantané a changé de vocabulaire en même temps que le reste de MJS-Server (cf. CHANGELOG). Quatre endroits parlaient encore français :

| Avant | Maintenant |
|---|---|
| `minuteries: [{ nom, à }]` | `timers: [{ name, at }]` |
| `journal: [{ coup, joueur, p, à }]` | `journal: [{ move, player, p, at }]` |
| `lockstep.journal[].ordres: [{ joueur, coup, p }]` | `lockstep.journal[].orders: [{ player, move, p }]` |
| `id: 'partie<n>'` — **et le fichier**, nommé `<id>.json` | `id: 'game<n>'` |

`type`, `code`, `state`, `phase`, `turn`, `seq` et `seats` sont **inchangés**. Les trois minuteries réservées ont aussi changé de nom (`'µtour'`/`'µappariement'`/`'µvide'` → `'µturn'`/`'µmatch'`/`'µempty'`) : une partie restaurée sans traduction ne réarmerait plus son tour.

L'**identifiant** est le seul de ces quatre à circuler aussi **sur le fil** (`µgame:*.game`) : `app.game()` le fabrique en `game1`, `game2`… Ne pas migrer ne casse rien — les deux formes ne se croisent jamais, le compteur ne réattribue qu'un `game<n>` — mais la base continue de parler français. Le script renomme le **fichier** en même temps que l'id ; il refuse d'écraser une cible déjà présente (avertissement, les deux fichiers restent) et laisse intact tout id d'une autre forme.

> ⚠️ **Lockstep — la graine dépend de l'id.** Elle n'est pas stockée : elle est re-dérivée de l'identifiant à chaque restauration (`deterministicSeed`). Renommer l'id d'une partie lockstep **en cours** change donc sa graine : au retour, les clients reçoivent `{seed, journal}` et rejouent le journal avec un autre flux d'aléatoire qu'avant l'arrêt. Sans conséquence pour un jeu lockstep sans hasard ; sinon, migre entre deux parties plutôt qu'au milieu d'une partie vivante.

```bash
node scripts/migrate-games-fr-to-en.mjs ./data/parties --dry-run   # montre, n'écrit rien
node scripts/migrate-games-fr-to-en.mjs ./data/parties             # migre
```

Le script est **idempotent** (un instantané déjà à jour est laissé tel quel) et écrit de façon **atomique** (fichier temporaire puis `rename`, le même geste que `FilePersistAdapter`) : une coupure en cours de route ne laisse jamais une partie à moitié écrite.

Les autres adaptateurs demandent un geste de plus :
- **SQL** — trois gestes, et les **colonnes** sont obligatoires : le serveur écrit `data` et `updated_at`, une table restée en `donnees`/`maj` fera échouer chaque `save()` (avertissement, aucune sauvegarde) et repartira sans restauration.

  ```sql
  ALTER TABLE mjs_server_parties RENAME TO mjs_server_games;              -- 1. la table
  ALTER TABLE mjs_server_games RENAME COLUMN donnees TO data;              -- 2. les colonnes
  ALTER TABLE mjs_server_games RENAME COLUMN maj TO updated_at;
  UPDATE mjs_server_games SET id = REPLACE(id, 'partie', 'game') WHERE id LIKE 'partie%';   -- 3. les ids
  ```

  Le nom de **table**, lui, reste au choix (`new SqlPersistAdapter({ table: 'mjs_server_parties', … })` garde l'ancien) — les colonnes, non : elles sont écrites en dur dans les requêtes. `RENAME COLUMN` demande MySQL ≥ 8.0 ; en 5.7, écris `CHANGE donnees data TEXT` et `CHANGE maj updated_at BIGINT`. La colonne de données contient le même JSON — le script ci-dessus s'applique à son contenu ; l'id vit là **aussi** en clé primaire, d'où la dernière ligne.
- **Pont** — le corps HTTP passe de `{op, id, données}` à `{op, id, data}`, et la réponse du `GET` de `{ok, parties}` à `{ok, games}`. Le back doit suivre **avant** la mise à jour du serveur, sinon `load()` repart d'un tableau vide (sans crash, mais sans restauration).
- **Redis** — la clé du hash passe de `<prefix>parties` à `<prefix>games` : `RENAME mjs-server:parties mjs-server:games`. Le hash contient le même JSON, migre-le avec le même jeu de renommages. Le **champ**, lui, porte l'id : Redis n'a pas de « renommer un champ », relis-le, réécris-le sous le nouveau nom, supprime l'ancien (`HGET`/`HSET`/`HDEL`).

---

<a id="configuration"></a>
## 9. Configuration

`mjsServer(opts)` accepte **exactement** les mêmes options que `mjsWs(opts)` ([23 · MJS-WS §1](23-mjs-ws.md#options)) — `auth`, `welcome`, `rooms`, `heartbeat`, `limits`, `bridge`, `resume`, `onDisconnect`… — augmentées de deux clés propres à MJS-Server :

| Clé | Type | Rôle |
|---|---|---|
| `persist` | adaptateur ou `{ adapter, debounce?, snapshotEvery? }` | cf. [§8](#persistance) — absent = désactivé |
| `antiCheat` | `{ movesPerIdentity?, codePerIp? }` | deux garde-fous anti-abus, chacun `[n, fenêtreMs]` ou `null` (désactivé) — absent = défaut |

`antiCheat.movesPerIdentity` plafonne les coups d'une **même identité**, toutes parties confondues (absent = désactivé). `antiCheat.codePerIp` plafonne les tentatives de **partie par code** venues d'une même adresse IP — c'est le verrou qui empêche de balayer l'espace des codes à cinq caractères ; son défaut actif est `[10, 60000]` (dix tentatives par minute), et `null` le désactive franchement. Les deux clés sont représentables en JSON, donc définissables dans `mjs.config.json` aussi bien que dans l'entry (en cas de doublon, l'entry prime en bloc).

Côté client, le module runtime s'appelle **`game`** (à côté de `socket`, `router`, `ajax`…) :

```json
{ "runtime": ["socket", "game"] }
```

Sélectionner `'game'` sans `'socket'` compile quand même (le bundler avertit : `sock.game` restera `undefined`) — `'game'` patche `MjsSocket.prototype`, il lui faut donc le module `'socket'` déjà présent. Le défaut `"runtime": "all"` (pas de config du tout) inclut les deux, comme le reste du runtime.

```civet
import { mjsServer } from 'mjs-framework/mjs-server'
```

---

<a id="mode-action"></a>
## 10. Le mode action : tick et intentions

Le socle de MJS-Server (§3-§9) est **tour par tour événementiel** — un coup, une réaction, une diffusion groupée par microtâche (§4). Pour un jeu où des entités bougent en continu (une arène, un espace partagé, un jeu d'esquive…), `def.tick` bascule la partie en **mode action** : une boucle qui tourne à fréquence **fixe**, qui applique les intentions reçues puis simule le monde.

```civet
app.game('arene', {
  seats: 8
  tick:   20                          # Hz — de 1 à 60, boucle réelle (setInterval)

  state: (game)-> { entites: {} }

  intents: {
    bouger: (game, player, p)->    # même signature qu'un move — mais jamais exécuté à réception
      e = game.state.entites[player.id]
      e.x += p.dx; e.y += p.dy
  }

  simulate: (game, dt)->           # une fois PAR TICK, après les intentions — dt = ms RÉELLES écoulées
    for id in Object.keys(game.state.entites)
      ent = game.state.entites[id]
      ent.pv = Math.min(100, ent.pv + dt * 0.001)   # regen lente

  moves: {
    chat: (game, player, p)-> game.send('chat', { de: player.id, texte: p.texte })   # move classique — immédiat, hors boucle
  }
})
```

`def.tick` (nombre, défaut `0`) n'accepte que `0` (socle événementiel) ou une valeur DE 1 À 60 (Hz) — toute autre valeur lève une erreur claire à la déclaration. `def.intents`, `def.simulate` et `def.slowTick` exigent tous les trois `tick > 0` (sans boucle, rien ne les appellerait jamais) — throw clair à la déclaration si tu les fournis avec `tick: 0`.

### Intentions — `def.intents`, dernière valeur gagne

Un coup envoyé sur un nom déclaré dans `def.intents` (au lieu de `def.moves`) n'est **jamais exécuté à réception** — il est mis en **file**, une par joueur et par **nom** : trois `bouger` envoyés dans la même fenêtre de tick ne s'accumulent **pas**, seule la **dernière** valeur compte. La file est vidée à chaque tick (ordre des **sièges**, jamais l'ordre d'arrivée réseau) juste avant `def.simulate`. Un nom ne peut pas être À LA **fois** un move classique et une intention (`def.intents.bouger` + `def.moves.bouger` → erreur à la déclaration).

### `simulate(game, dt)` — une fois par tick

Appelée **après** les intentions en file, `dt` est l'écart **réel** (ms, mesuré) depuis le tick précédent — jamais la période nominale figée (`1000/tick`) : le `setInterval` sous-jacent peut dériver légèrement, `simulate` reçoit quand même le temps **vraiment** écoulé.

### `slowTick` — une deuxième cadence, indépendante

```civet
slowTick: { hz: 1, fn: (game)-> game.state.vagueSpawn() }   # 1×/s, indépendant de `tick`
```

Utile pour tout ce qui n'a pas besoin de la cadence complète (régénération, spawn, IA lente) sans polluer `simulate` d'un compteur de frames maison.

### Diffusion — une trame par tick, jamais par mutation

En mode événementiel (`tick: 0`), chaque mutation de `game.state` planifie une diffusion groupée à la **microtâche** suivante (§4). En mode action, cette planification est **suspendue** : la cadence de diffusion appartient exclusivement à la boucle — `µgame:state` part à chaque siège **une fois par tick**, après `simulate`, quel que soit le nombre de mutations survenues pendant ce tick (intentions de plusieurs joueurs comprises). Les **moves classiques** restent eux **immédiats** (§4) — utile pour un `chat` ou une action ponctuelle qui n'a pas besoin d'attendre le prochain tick pour partir.

> 🔤 Boucle démarrée dès le 1ᵉʳ siège **connecté** (pas besoin que `seats` soit atteint), coupée à la vidange complète, à `.end()` et à la destruction — jamais de `setInterval` résiduel.

---

<a id="deltas"></a>
## 11. Les deltas

Par défaut, `µgame:state` porte la vue **complète** à chaque diffusion — correct pour un état léger (une grille de morpion), coûteux pour un monde de plusieurs dizaines d'entités qui ne bougent qu'en partie à chaque tick. `def.deltas: true` fait calculer, **par joueur**, un diff entre la vue qui vient d'être calculée et la **dernière** vue effectivement **envoyée** à ce joueur — seuls les champs qui ont changé partent sur le fil.

```civet
app.game('arene', {
  tick:   20
  deltas: true                        # orthogonal à tick — utilisable aussi en mode événementiel (tick: 0)
})
```

### Ce que reçoit le client — transparent

Le client (`sock.game`, §7) n'a **rien à faire de spécial** : `game.state` reste le **même** store réactif À **plat** (§7), qu'il soit alimenté par une vue complète ou par un delta — l'application du delta sur le store local est **interne**, invisible pour ton code applicatif. Sur le fil, seule la **charge** change de forme :

| Situation | Charge `µgame:state` |
|---|---|
| `deltas: false` (défaut) | `{ game, view, phase, turn, seq }` — inchangé depuis le socle v1 |
| `deltas: true`, changement normal | `{ game, phase, turn, seq, delta: [{p:'chemin.a.b', v}, {p:'chemin.c', x:1}, …] }` — `v` pose/remplace la valeur au chemin `p` (à points), `x: 1` supprime la clé finale du chemin |
| `deltas: true`, repli (cf. ci-dessous) | `{ ..., view }` — vue complète, comme si `deltas` était `false` pour cette trame |
| `deltas: true`, rien n'a changé pour CE joueur | **aucune trame** — zéro octet, pas même une trame vide |

### Repli vue complète

Trois situations retombent sur une vue **complète** plutôt qu'un delta, **jamais** un delta partiel : la **1ʳᵉ diffusion** pour un joueur donné (rien à comparer) ; **`µgame:resync`**, **toujours** une vue complète — ce qui vient d'être envoyé devient la nouvelle baseline pour le prochain delta ; et un **delta trop gros** — si son JSON dépasse 60 % du JSON de la vue complète, MJS-Server envoie la vue complète à la place (un état qui a presque tout changé ne gagne rien à être décrit champ par champ).

### Limite — pas de point littéral dans une clé

Le chemin `p` d'une opération de delta est une chaîne à **points** (`'entites.e3.x'`, jamais échappés) — une clé de ta vue qui contiendrait elle-même un point littéral (par exemple une clé `'127.0.0.1'`) casserait la reconstruction du chemin côté client. Vrai pour n'importe quelle clé de dictionnaire dynamique : préfère un id opaque (`e3`) à une clé qui pourrait contenir un point.

`deltas` est **orthogonal** à `tick` — utilisable aussi bien en mode tour par tour événementiel (`tick: 0`, un état qui change rarement mais gagne quand même à ne transmettre que la différence) qu'en mode action.

---

<a id="zones-interet"></a>
## 12. Les zones d'intérêt

Pour un monde qui dépasse la poignée d'entités (une arène à 50 joueurs, une carte ouverte…), envoyer À **chaque** joueur la position de **tout le monde** gaspille de la bande passante pour des entités hors de vue. `def.space: { cell }` déclare un index spatial **optionnel** — un simple **utilitaire**, sans magie imposée : c'est ton `def.simulate`/`def.view` qui décide quand et comment s'en servir.

```civet
app.game('arene', {
  tick:  20
  space: { cell: 100 }                # taille de cellule (mêmes unités que tes x/y) — grille CARRÉE

  state: (game)-> { entites: {} }

  simulate: (game, dt)->
    for id in Object.keys(game.state.entites)
      ent = game.state.entites[id]
      game.space.set(id, ent.x, ent.y)   # à toi de tenir l'index à jour à chaque déplacement

  view: (game, player)->
    moi = game.state.entites[player.id]
    return { entites: {} } unless moi
    voisins = game.space.query(moi.x, moi.y, 300)   # rayon 300 — mêmes unités que `cell`
    entites = {}
    for id in voisins
      entites[id] = game.state.entites[id]
    { entites }

  moves: {}
})
```

`game.space` (`null` si `def.space` absent) expose trois méthodes : `.set(id, x, y)` pose ou déplace une entité (retire de son ancienne cellule si besoin, no-op si elle reste dans la **même** cellule), `.remove(id)` la retire, `.query(x, y, rayon)` renvoie les ids dans le carré de cellules couvrant ce rayon — filtré finement à la distance de Tchebychev (`max(|dx|,|dy|)`, pas un cercle euclidien, cohérent avec le balayage grossier en cellules carrées). Coût de `.query()` proportionnel aux **cellules** couvertes, jamais au nombre total d'entités.

> ⚠️ **Limite — non repeuplé après restauration.** `game.space` est un index **dérivé**, jamais sérialisé par la persistance (§8) : une partie restaurée depuis `load()` repart avec un `game.space` **vide**, même si `game.state` contient déjà des positions. À ton jeu de le repeupler lui-même (typiquement au premier `simulate`/`view` qui suit une reprise, en rappelant `.set()` pour chaque entité de `game.state`) — aucune magie de repopulation automatique ici.

---

<a id="netcode"></a>
## 13. Le réseau des jeux d'action (netcode)

Le mode action ([§10](#mode-action)) diffuse l'état à la cadence du tick — parfait en local, mais un vrai aller-retour réseau (100-200 ms n'a rien d'exceptionnel) expose deux symptômes très reconnaissables : les entités des **autres** sautent d'un tick à l'autre, et un tir qui semblait bien ajusté **rate** quand même. Cette section couvre trois techniques **client**/**serveur** pour vivre avec cette latence sans la faire disparaître — interpolation, prédiction, compensation de lag — puis un **mode de partie** entier, le lockstep déterministe, pour les jeux où l'autorité serveur classique ne convient pas.

| Technique | Où | Symptôme réglé | Module runtime |
|---|---|---|---|
| Interpolation — `µ.interp` | Client, entités **distantes** | Le mouvement saute | `'interp'` |
| Prédiction — `µ.predict` | Client, SA **propre** entité | La réponse au clavier accuse la latence | `'predict'` |
| Compensation de lag — `def.history` | Serveur | Le tir rate | déjà inclus dans `'game'` |
| Lockstep — `def.mode:'lockstep'` | Serveur + client | Coût réseau d'un monde à beaucoup d'entités déterministes | `'lockstep'` + `'det'` |

### Le problème — 200 ms, et ça se voit

`µgame:state` part une fois par tick ([§10](#mode-action)) — à 15-20 Hz, c'est déjà 50-65 ms entre deux trames **sans** compter le réseau. Ajoute un aller-retour de 200 ms (une connexion mobile, un pair loin géographiquement) et deux choses se voient à l'œil nu :

- **Le mouvement saute.** `game.state.entites[id]` affiché tel quel avance par à-coups : la position reste figée entre deux trames puis **saute** à la valeur suivante — d'autant plus visible que le tick est lent.
- **Le tir rate.** Le tireur vise la position qu'il **voit** — déjà vieille du temps de trajet aller (son propre rendu) — puis son tir met un aller-retour **entier** à atteindre le serveur, qui compare (naïvement) contre la position **courante**, déjà avancée depuis. Une cible qui bouge à seulement 100 px/s peut ainsi se décaler de 20-40 px entre ce que le tireur a visé et ce que le serveur valide.

Les techniques qui suivent répondent chacune à UN symptôme précis : l'interpolation répare le premier (visuel, sur les entités **distantes**) ; la prédiction répare l'input lag local (pas un symptôme visible chez l'adversaire, mais chez **soi**) ; la compensation de lag répare le second (le tir).

### Interpolation à tampon — `µ.interp`

Sur les entités **distantes** (celles des autres joueurs), affiche un peu dans le passé plutôt que la dernière valeur brute reçue — le mouvement redevient continu au prix d'un léger retard assumé. `µ.interp` (module runtime `'interp'`, cf. [§9](#configuration)) se pose **par-dessus** `sock.game()` :

```civet
game = sock.game('arene', { code: true })
$view   = µ.interp(game, { fields: ['entites'], delay: 2 })   # 2 périodes de retard (défaut)
```
```html
{for id, e in $view.entites}
  <@entity x={e.x} y={e.y}>
{end}
```

`fields` liste les clés de `game.state` qui sont des **dicts** `{id: entité}` (la forme de `def.view`, cf. [§5](#la-vue)) — **seules** ces clés sont interpolées ; le reste (statut, phase, tour…) se lit directement sur `game.state`. `delay` (en **périodes**, défaut 2) fixe l'ancienneté affichée : `µ.interp` mesure **lui-même** la période réseau (moyenne glissante des écarts d'arrivée) — rien à deviner en millisecondes. Un trou d'arrivée (paquet perdu, `def.deltas` sans changement) **extrapole** sur la vélocité mesurée pendant ~1 période, puis **gèle** plutôt que de projeter indéfiniment. Seuls les champs **numériques** sont lissés (lerp) ; le reste (chaînes, booléens…) recopie la valeur la plus récente — v1 volontairement simple, pas d'angles (cf. [§14](#limites)).

> 🔗 Besoin de lisser un simple dictionnaire de positions, sans les autres mécaniques de cette section ? La recette générique `µsmooth` ([§7](#le-client)) suffit toujours. `µ.interp` est la version bâtie spécifiquement pour `sock.game()` : elle mesure sa propre période, expose un miroir dédié aux champs déclarés, extrapole puis gèle plutôt que de simplement lisser vers la dernière valeur connue.

### Prédiction du mouvement propre — `µ.predict`

Sur TA **propre** entité (jamais celle des autres), applique chaque intention **localement**, avant même l'aller-retour serveur — les touches répondent immédiatement, quelle que soit la latence :

```civet
appliquerDeplacement = (state, nom, p)->    # DOIT être la MÊME logique que def.intents.bouger
  return unless nom == 'bouger'             # côté serveur — cf. fichier partagé, note ci-dessous
  state.moi.x += p.dx
  state.moi.y += p.dy

game = sock.game('arene', { code: true })
$moi   = µ.predict(game, { fields: ['moi'], apply: appliquerDeplacement })

game.move('bouger', { dx: 4, dy: 0 })   # inchangé pour l'appelant — µ.predict enveloppe .move
```

> ⚠️ **`apply` doit être la même logique que `def.intents` côté serveur.** Un désaccord entre les deux — même minime (un clamp oublié, un ordre d'opérations différent) — fait **diverger** le fragment local de la vérité serveur à chaque frame, jusqu'à la prochaine réconciliation. Mets cette fonction dans un fichier **partagé**, importé des deux côtés (`@import`, des deux côtés — composant ET fichier serveur, cf. [23 · MJS-WS §13](23-mjs-ws.md#civet-entry)).

Chaque `game.move()` enveloppé reçoit un numéro `_n` croissant, glissé dans le payload réseau ; le serveur le retire avant `def.intents[move]` et reflète le **dernier** `_n` appliqué dans une méta de trame `_ack` (**jamais** dans la vue du jeu). À chaque `µgame:state` : le fragment prédit repart de l'état **serveur** des champs déclarés, purge de sa file d'attente tout `_n <= _ack`, puis **rejoue** `apply` sur ce qui reste — une correction serveur (un clamp, un refus) n'est donc jamais « moyennée », le fragment **snappe** à la vérité puis rejoue par-dessus.

> ⚠️ **Limite connue — mélanger intentions et moves classiques sur la même poignée.** Seules les **intentions** (`def.intents`) reçoivent un `_ack` — un move classique (`def.moves`) enveloppé n'en reçoit jamais. Filet v1 : tant qu'**aucune** trame de cette partie n'a jamais porté `_ack`, la réconciliation vide la file en entier à chaque frame plutôt que de rejouer (correct pour un jeu 100 % moves classiques) — mais dès qu'un `_ack` est vu une 1ʳᵉ fois, ce filet se désarme **pour toujours**. Un jeu qui mélange les deux sur la même poignée prédite reste hors-scope v1 (cf. [§14](#limites)).

### Compensation de lag — `def.history` + `game.rewind`

Le tir se valide **côté serveur** — mais pas forcément contre la position **courante** : `def.history` déclare un tampon circulaire d'instantanés, `game.rewind` retrouve celui du passé, et le jeu y valide son tir **comme** SI aucun aller-retour n'avait eu lieu :

```civet
app.game('arene', {
  seats: 8
  tick:   20
  history:  { ticks: 40, interp: 100 }        # tampon ~2 s d'historique (extracteur par défaut : def.space)
  space:  { cell: 100 }

  state: (game)-> { entites: {} }
  moves: {}

  intents: {
    tirer: (game, player, p)->           # p = { cibleId, x, y } — la visée du tireur
      touché = game.rewind game.timeSeenBy(player), (positions)->
        target = positions[p.cibleId]
        target? and Math.hypot(p.x - target.x, p.y - target.y) <= 20
      game.send('touche', { par: player.id, target: p.cibleId }) if touché
  }
})
```

`def.history.ticks` fixe la profondeur du tampon (en **ticks**, pas en ms) ; `def.history.extract(game)` produit l'instantané léger `{id: {x, y}}` poussé à **chaque** tick — omis, il retombe sur un snapshot de `def.space` ([§12](#zones-interet)) si déclaré, sinon la déclaration lève une erreur claire. `def.history.interp` (ms, défaut `2 × period de tick`) est le retard de rendu que TU **déclares** avoir côté client — garde-le cohérent avec le `delay` réellement passé à `µ.interp` côté client : ce sont deux nombres séparés qui décrivent la **même** idée.

`game.rewind(instantMs, fn)` retrouve l'entrée la plus proche de `instantMs` (borné : trop ancien → la plus vieille entrée dispo, futur → l'entrée du tick courant) et passe à `fn` une **copie gelée** (`Object.freeze`) — jamais l'original mutable du tampon. `game.timeSeenBy(player)` calcule l'instant que CE joueur voyait au moment d'agir : `Date.now() − (latence + def.history.interp)`, la latence étant lue sur `client.latency` (MJS-WS, réservoir ping/pong du 1ᵉʳ client connecté de ce siège) — `null`/déconnecté replient sur `0`, jamais un throw pour une mesure simplement absente.

> ⚠️ **`client.latency` a besoin d'un heartbeat client court.** `µsocket(url, opts)` n'hérite **pas** le `heartbeat` du serveur — sans le redéclarer explicitement côté client (`heartbeat: 300` par exemple), le heartbeat du client reste sur son défaut (15 000 ms) et `client.latency` ne se met À **peu près jamais** à jour dans la durée de vie réaliste d'un tir : `timeSeenBy` retombe alors sur `0 + def.history.interp` seulement (cf. [§14](#limites), constaté au banc de la démo ci-dessous).

### Le mode déterministe — lockstep

Une alternative **radicale** aux trois techniques ci-dessus : plutôt que masquer la latence, `def.mode: 'lockstep'` la rend **équitable** — le serveur NE **simule rien**, il se contente de regrouper et diffuser les **ordres** (chaque `µgame:move`) tick par tick, **identiques** pour tous ; chaque client simule **exactement** la même partie à partir des mêmes ordres, dans le même ordre.

```civet
app.game('rts', {
  seats: 2
  tick:   20
  mode:   'lockstep'
  moves:  {}                                # requis même vide — aucun coup n'est de toute façon exécuté ici
  onDivergence: (game, info)-> µ.log("divergence au tick #{info.tick}")
  lockstepJournal: { maxTicks: 500 }        # opt-in — journal d'ordres plafonné en anneau, cf. limites v1
})
```

Liste **fermée** d'interdits avec `mode: 'lockstep'` : `state`/`view`/`deltas`/`intents`/`simulate`/`space`/`history` — déclarer l'un d'eux lève une erreur claire à l'`app.game(...)`. `tick` devient obligatoire (> 0, cadence de regroupement des ordres) ; `onDivergence` n'a de sens QU'en lockstep (erreur sinon). `lockstepJournal: { maxTicks }` (entier ≥ 1), même contrainte de mode : plafonne le journal d'ordres en anneau au lieu de le laisser grandir sans limite (cf. [§14](#limites)).

**Quand le choisir.** L'autorité serveur ([§3](#declarer-un-jeu)-[§12](#zones-interet), plus les trois techniques ci-dessus) **masque** la latence — le serveur reste la seule vérité, chaque client voit midi à sa porte mais le rendu reste fluide ; c'est le bon choix dès qu'un client ne doit **pas** voir à l'avance les décisions des autres (tir, main cachée), ou que la simulation n'est pas reproductible bit-à-bit (physique tierce, `Math.random` non maîtrisé). Le lockstep ne masque rien — le ressenti reste au rythme du tick, sans prédiction possible sur les actions des autres — mais coûte une **fraction** de la bande passante d'une diffusion d'état complet (les ordres sont minuscules comparés aux positions) : le bon choix pour un monde à beaucoup d'entités simulées **identiquement** partout (**rts**, wargame, replay compétitif).

Côté client, `µ.lockstep` (module `'lockstep'`, requiert aussi `'det'` ci-dessous, cf. [§9](#configuration)) déroule les ordres reçus :

```civet
game = sock.game('rts', { code: true })
$state  = µ.lockstep(game, {
  state0:     -> { unites: {} }
  apply: (state, ordre)->
    return unless ordre.move == 'bouger'
    state.unites[ordre.player] ?= { x: 0, y: 0 }
    u = state.unites[ordre.player]
    u.x += ordre.p.dx
    u.y += ordre.p.dy
  every: 30
})

game.move('bouger', { dx: 4, dy: 0 })   # émet l'ORDRE — inchangé, µ.lockstep n'enveloppe PAS .move
```

`µgame:orders { tick, orders }` arrive tick par tick, appliqué en séquence **stricte** (un tick en avance sur `nextTick` est mis en réserve, jamais un saut). La graine n'est jamais choisie par le jeu : `µgame:start`/`resync` la dérive **déterministiquement** de l'id de partie (hash FNV-1a) et la porte avec le **journal** complet des ordres depuis la genèse — `$state.rng` (un `µ.random(seed)` **partagé**) est prêt dès l'assise. La rejouabilité est donc **gratuite** : à la 1ʳᵉ assise comme à toute résync après coupure, le client **rejoue** le journal reçu avant de reprendre le direct — restaurer une partie côté serveur, c'est juste renvoyer le journal.

**Déterminisme cross-moteur — `µ.random`/`µ.det`.** `Math.random()` est banni (état global partagé, jamais reproductible) ; `Math.sin`/`cos`/`atan2` ne sont **pas** garantis identiques bit-à-bit d'un moteur JS à l'autre (fonctions transcendantes non spécifiées au bit près) — deux clients lockstep sur des moteurs différents pourraient calculer des trajectoires légèrement différentes et diverger sans qu'aucun bug applicatif ne soit en cause :

```civet
rng = µ.random(42)                     # graine → générateur INDÉPENDANT (jamais un état global)
de  = rng.int(1, 6)                    # entier BORNÉ INCLUSIF [1, 6] — un dé à 6 faces

angle = µ.det.atan2(dy, dx)            # RADIANS, même signature que Math.atan2 — déterministe cross-moteur
rayon = Math.sqrt(dx * dx + dy * dy)   # sqrt reste NATIF — déjà déterministe IEEE 754
```

`µ.det.sin/cos/atan2` n'utilisent que `+`/`-`/`×`/`÷`/`Math.imul`/`Math.floor` — déjà déterministes IEEE 754 — pour une précision **mesurée** d'environ 0,16 % d'erreur absolue max (sin/cos) et 0,086° (atan2) : largement suffisant pour une visée ou une orientation de jeu, pas pour un calcul scientifique. `Math.sqrt` (et les opérateurs `+ - × ÷`) restent volontairement **natifs** — déjà déterministes, aucune raison de les réapprocher.

**Détecter la divergence.** Toutes les `every` ticks (60 par défaut), chaque client hache son état (FNV-1a de `JSON.stringify(state)`) et l'annonce en `µgame:hash` — **fire-and-forget**, jamais de `µ:ack`. Le serveur ne retient **pas** le premier hash vu comme référence — durcissement anti-triche par **quorum** : la référence d'un tick ne se fige **que** quand un hash atteint la majorité absolue des sièges courants, un siège qui rapporte deux hash différents pour le même tick est en plus flaggé suspect immédiatement (auto-contradiction). Limite assumée du quorum à **deux** sièges exactement : la majorité absolue vaut 2, un désaccord 1 contre 1 ne fige donc jamais de référence — en duel, seule l'auto-contradiction d'un siège est détectable (à 3 sièges et plus, le quorum tranche). Un écart identifié déclenche `def.onDivergence(game, {tick, suspects, reason})` côté serveur ET diffuse `µgame:event` de type `'divergence'` à tous les clients — jamais deux fois pour le même siège/tick. Le jeu **décide** de la suite (log, resync forcé en renvoyant le journal, fin de partie) — rien d'automatique n'est imposé.

### Les chiffres de la démo

Mesurés sur un mini-jeu à 2 joueurs (tick 15 Hz, 200 ms d'aller-retour artificiel injecté par un shim `WebSocket`, 2 passes indépendantes) :

| Mode | Saut inter-frame moyen | Taux de touche |
|---|---|---|
| **Sans** netcode (position brute, tir sur position courante) | ≈ 6,0 px/échantillon | 0 % (0/8-9 tirs) |
| **Avec** netcode (`µ.interp` + `µ.predict` + `rewind`) | ≈ 1,5 px/échantillon | 100 % (8-9/8-9 tirs) |

Le mouvement distant devient ~4× plus lisse (saut divisé), et le tir passe de systématiquement raté à systématiquement touché — l'écart moyen entre la visée et la position validée serveur tombe d'environ 25 px à moins de 2 px. Reproductible : même sens de gain aux deux passes.

### Limites v1 — honnêtement (netcode)

- **`µ.interp` est scalaire — pas d'angles.** Seuls les champs numériques sont lerpés linéairement ; un champ d'**angle** (orientation, direction du regard) lerpé naïvement traverse le mauvais côté du cercle près de ±180°. Gère les angles en delta courte-voie côté vue, ou n'interpole pas ce champ.
- **Le journal lockstep est borné en opt-in seulement.** `def.lockstepJournal: { maxTicks }` plafonne le journal en **anneau** (éviction FIFO des ticks les plus anciens à chaque tick clos), plafond aussi appliqué à la restauration depuis la persistance — absent, comportement **historique** inchangé : illimité, l'historique **complet** grandit sans limite pour toute la durée de vie de la partie. Trade-off honnête : un client qui a raté plus de `maxTicks` ticks (déconnexion longue) reçoit à la reconnexion un journal **tronqué** — la resync déterministe depuis le tick 1 n'est alors plus possible pour lui ; c'est la détection de divergence par hash (quorum, ci-dessus) qui finit par le signaler via `onDivergence`, aucun snapshot d'état de secours n'existe à ce jour. Le client détecte et signale ce journal tronqué **dès** le resync — sans attendre le quorum de hash : log explicite + événement client `'divergence'` (raison `'journal_tronque'`) sur le même canal que la vraie divergence serveur, le rejeu continue ensuite avec ce qu'il a reçu.
- **`µ.predict` : mélanger intentions et moves classiques sur la même poignée reste hors-scope** (cf. l'encart ⚠️ plus haut) — le filet v1 se désarme définitivement dès le premier `_ack` vu.
- **`client.latency` suit le heartbeat client, pas une mesure indépendante.** Redéclare `heartbeat` dans les opts de `µsocket` (pas seulement côté serveur) pour une latence utilisable par `timeSeenBy` — un heartbeat par défaut (15 s) la laisse bien trop obsolète pour un jeu d'action ; vise 200-400 ms.

---

<a id="limites"></a>
## 14. Limites v1 — honnêtement

- **Coups synchrones seulement.** `def.moves[nom]` doit renvoyer sa valeur directement — une fonction `async` « marche » sans erreur de compilation, mais son résultat (une `Promise`) part tel quel comme `result`, jamais attendu. Pareil pour `def.intents`/`def.simulate` ([§10](#mode-action)).
- **Appli anonyme = pas de reprise.** Sans `opts.auth` posant une identité **stable** côté MJS-WS, chaque reconnexion change d'`id` (repli sur l'id de connexion) — `µgame:resync` ne retrouve alors **jamais** un siège après coupure. Une identité stable est le prix de la reprise.
- **`µgame:*` n'est jamais binaire.** Deltas ([§11](#deltas)) et zones d'intérêt ([§12](#zones-interet)) réduisent le volume, mais restent 100 % JSON — le protocole interne de MJS-Server ne passe jamais par `µschema` ([23 · MJS-WS §3.1](23-mjs-ws.md#µschema)) : ses trames (`view`/`delta` en particulier) ont une forme **dynamique**, propre à chaque jeu, que le registre à champs **fixes** de `µschema` ne sait pas décrire. Un état qui doit vraiment voyager en binaire se pousse en messages **custom**, à côté de `µgame:*`, via `app.schema(...)` — cf. le banc mesuré ci-dessous.
- **`ws.codec: 'binary'` strict casse tout `sock.request()` — donc tout MJS-Server.** L'API cliente de MJS-Server n'envoie **que** des requêtes id-bearing (`µgame:play`/`move`/`leave`/`resync`, [§15](#protocole)) — or l'enveloppe binaire de `µschema` ne porte **aucun** id de corrélation (une requête reste **toujours** en JSON côté client, cf. [20 · Temps réel](20-temps-reel.md) §7.4 « pub/sub seulement »), et le mode **strict** rejette en retour toute trame **texte** applicative hors `µ:`, id ou pas. Constat vérifié directement : en `codec: 'binary'`, `sock.request('µgame:move', …)` expire systématiquement (jamais de `µ:ack`) — `ws.codec: 'binary'` est donc **incompatible** avec MJS-Server en l'état ; réserve-le à une app MJS-WS pure, entièrement pub/sub.
- **Mode spectateur (ajouté par la couche anti-triche).** `µgame:play { spectator: true }` (par code de partie) rejoint sans occuper de siège ; le spectateur reçoit `µgame:state` avec une vue **sûre** (`def.spectatorView(game)`, sinon `view(game, null)`, sinon `{}` + avertissement — jamais l'état brut), tout coup de sa part est rejeté. Limite v1 : seul `µgame:state` lui est relayé (pas `end`/`left`), et l'entrée se fait par code (pas via la file publique).
- **Le banc mesuré.** Mini-monde réaliste (30 entités dont 4 mobiles, 15 Hz, 2 clients) : ≈ 63 000 octets/s en JSON vue complète, ≈ 19 200 en messages `µschema` binaires par entité (≈ 0,30×), ≈ 8 100 en deltas JSON (`def.deltas: true`, **même** monde, ≈ 0,13×). Sur CE monde, ne transmettre que ce qui a changé bat l'encodage binaire de l'état entier — le rapport dépend directement de la part d'entités qui bougent réellement à chaque tick.

---

<a id="protocole"></a>
## 15. Annexe — le protocole `µgame:*`

Comme le protocole `µ:` de MJS-WS ([20 · Temps réel](20-temps-reel.md)), invisible en usage normal — utile pour déboguer, ou pour implémenter un client dans un autre langage. Préfixe `µgame:` **réservé** : `app.serve`/`app.on` d'un type qui commence par `µgame:` lève une erreur côté appli hôte.

### Client → Serveur (requêtes, `µ:ack` en retour)

| Trame | Charge `p` | Réponse (`µ:ack`) |
|---|---|---|
| `µgame:play` | `{ type, code? }` | `{ queue: n }` (file, pas encore assis) OU `{ game, seat, view, phase, turn, seq, code }` (assis) |
| `µgame:move` | `{ game, move, p? }` | `{ ok: true, result }` — throw interne ou du move → `µ:ack` d'erreur |
| `µgame:leave` | `{ game }` | `{ ok: true }` — vide le siège (≠ déconnexion, qui le garde) |
| `µgame:resync` | `{ game }` | `{ game, seat, view, phase, turn, seq, code }` — vue fraîche **complète** |
| `µgame:hash` | `{ game, tick, h }` | **Aucune** — **fire-and-forget**, jamais de `µ:ack` (mode `'lockstep'` seul, [§13](#netcode) : annonce périodique du hash d'état pour la détection de divergence) |

`code` dans `µgame:play` est discriminé par **type**, jamais par sa seule présence : absent = file publique, `true` = crée une partie privée neuve, chaîne = rejoint ce code (§6).

### Serveur → Client (poussées, sans ack)

| Trame | Charge `p` | Quand |
|---|---|---|
| `µgame:state` | `{ game, view, phase, turn, seq }` (défaut) ou `{ game, phase, turn, seq, delta }` (`def.deltas:true`, [§11](#deltas)) | à chaque mutation, SA vue par joueur, groupée par microtâche (tour par tour, `tick:0`) — ou une fois par tick (mode action, [§10](#mode-action)) |
| `µgame:event` | `{ game, type, p }` | `game.send(type, p)` — libre, applicatif |
| `µgame:seat` | `{ game, seatCount, seats }` | roster, à chaque changement (`seats: [{seat,connected}\|null, …]`) |
| `µgame:start` | `{ game, seat, view, phase, turn, seq, code }` | 1ʳᵉ fois que `seats` est atteint — aux sièges qui n'ont pas eux-mêmes déclenché la complétion |
| `µgame:end` | `{ game, result }` | `game.end(result)`, ou annulation (`result: {cancelled:true, reason}`, §6) |
| `µgame:left` | `{ game, seat }` | départ volontaire (`µgame:leave`) d'un **autre** siège |
| `µgame:orders` | `{ game, tick, orders }` | mode `'lockstep'` seul, [§13](#netcode) : à **chaque** tick clos, `orders: [{player, move, p}, …]` (groupe éventuellement vide — le tick lui-même est l'horloge commune) |

---

*Voir aussi : [20 · Temps réel](20-temps-reel.md) pour le client `µsocket` de base, [23 · MJS-WS](23-mjs-ws.md) pour le transport qui porte tout ça.*
