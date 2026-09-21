// mjs-ws/comptes — paquet COMPTES & IDENTITÉS v1. MÊME patron que packages.ts::paquetEcho et
// chat.ts::chatPackage (definirPaquet + installer composé SUR l'API PUBLIQUE app.serve — jamais par
// accès à l'interne de core.ts) : accountsPackage(opts) déclare 3 trames (préfixe `account:`)
// utilisables APRÈS un hello anonyme, pour qu'une appli MJS autonome (SANS back Rails) puisse créer
// des comptes, se connecter, rester connectée — et que les AUTRES paquets (chat/jeu/lobby) reçoivent
// une identité STABLE + des rôles.
//
//   import { mjsWs, accountsPackage, accountsAuth } from 'modularjs-framework/ws'
//   const SECRET = process.env.MJS_COMPTES_SECRET!
//   app = mjsWs({ auth: accountsAuth(SECRET) })   // PAS jwtAuth(SECRET) nu — cf. « Élévation » ci-dessous
//   app.use(accountsPackage({ secret: SECRET }))
//   await app.listen()
//
// Protocole (préfixe 'account:' — simple CONVENTION de nommage, comme 'chat:', PAS une réservation
// façon µgame:) — utilisable dès le hello anonyme (aucun `auth` requis à la CONNEXION) :
//   account:create       CLIENT→SERVEUR (requête, µ:ack)  { pseudo, secret }  → { ok, jeton } (création
//                       + connexion immédiate) ; refus : 'account-name-invalid' (format), 'account-
//                       secret-short' (< 8), 'account-name-taken' (unicité, casse-insensible),
//                       'account-throttled' (seau anti-DoS PAR IP épuisé juste avant le hachage scrypt,
//                       cf. « Anti-DoS création » plus bas — durci : accessible en hello
//                       ANONYME + scrypt coûteux, aucune limite jusque-là), 'account-limit-reached'
//                       (opts.maxComptes atteint).
//   account:login   CLIENT→SERVEUR (requête, µ:ack)  { pseudo, secret }  → { ok, jeton } ; refus
//                       'account-denied' (message IDENTIQUE pseudo inexistant OU secret faux — jamais
//                       d'énumération de comptes) ; 'account-throttled' (seau d'échecs épuisé).
//   account:logout CLIENT→SERVEUR (requête, µ:ack)  {}  → { ok: true } — ferme la connexion
//                       authentifiée courante (cf. « Déconnexion » plus bas), no-op sur une identité
//                       déjà anonyme.
//
// Élévation invité→compte — `account:create`/`account:login` ne font que MINTER un jeton
// (signToken, cf. token.ts) : un paquet n'a AUCUN moyen d'écrire `client.identity` directement
// (lecture seule dans l'API publique MjsWsClient, cf. core.ts). L'élévation RÉELLE de la connexion
// N'EST PAS `µ:refresh`/`sock.refresh(jeton)`, contrairement à l'intuition de départ :
// `handleRefresh` (core.ts) réinvoque `authFn` mais REFUSE tout changement
// d'`identityIdOf` — passer d'anonyme (aucun `id`) à un compte (`id` généré) EST un tel changement,
// donc TOUJOURS `refresh-denied`, quel que soit le jeton (invariant « une session ne change jamais
// d'identité en vol », core.ts). L'élévation passe donc par une
// RECONNEXION contrôlée côté client (`sock.close()` + `sock.connect()` avec le jeton en `auth`) —
// un hello FRAIS n'a AUCUNE identité antérieure à comparer, cf. `src/runtime/mjs_accounts.ts`
// (`sock.account`, fonction `_compteElever`) qui l'orchestre. Ce qui NE change PAS : `opts.secret`
// DOIT être le MÊME secret que celui donné à `mjsWs({ auth })` (le hello, lui, vérifie bien le
// jeton via `authFn`) ; `jwtAuth(secret)` NU refuserait la connexion anonyme elle-même (renvoie
// `false` pour tout hello SANS jeton) — cf. `accountsAuth(secret)` ci-dessous, le wrapper qui
// autorise l'anonyme ET vérifie le jeton compte quand il est présent.
//
// Déconnexion — v1 sans état (jetons JWT sans dépendance, cf. token.ts) : il n'existe PAS de liste de
// révocation par jeton (aucun `jti`, aucun magasin de sessions à sa taille). `account:logout` fait
// donc la seule chose RÉELLEMENT révocable en v1 : fermer la connexion authentifiée courante
// (`client.close`, APRÈS l'envoi de l'accusé — jamais avant, cf. son commentaire) — l'identité élevée
// ne survit donc jamais à la fermeture. Le CLIENT (mjs_accounts.ts) purge son jeton local en parallèle :
// une reconnexion ultérieure repart anonyme (sous réserve qu'aucune AUTRE copie du jeton ne traîne
// ailleurs — onglet/appareil distinct —, cf. docs/27-accounts.md « Limites »).
//
// Persistance — CONTRAT PROPRE à ce fichier (`MjsWsAccountsPersistAdapter`), PAS un réemploi de
// `mjs-server/persist.ts` : ce dernier est typé 1:1 sur `MjsServerPartieSnapshot` (état de PARTIE,
// cf. son en-tête) — l'importer aurait entraîné tout le module jeu (matchmaking/partie) pour un
// enregistrement de compte SANS RAPPORT. MÊME FORME duck-typée (load/save/remove/flush?), MÊME
// philosophie (mémoire fournie ICI comme défaut dev, adaptateurs réels — fichier ICI, Redis/SQL/pont
// HTTP maison — au choix de l'appli hôte) : cf. docs/27-accounts.md.
//
// Anti-force-brute — seau d'échecs PAR IP ET PAR PSEUDO, MÊME PATRON que mjs-ws/bridge.ts
// (createBridgeRateLimiter) mais COPIÉ plutôt qu'importé : bridge.ts est le pont HTTP (pas une
// dépendance saine pour un paquet WS pur). Une identité DÉJÀ en pénalité
// (verrouillée par un échec PRÉCÉDENT) est bloquée AVANT tout calcul de hachage — y compris le
// hachage FACTICE anti-énumération ci-dessous — pour qu'un attaquant déjà repéré ne fasse plus
// jamais payer de coût CPU au serveur ; l'échec qui fait déborder le seau POUR LA PREMIÈRE FOIS a,
// lui, déjà payé son hachage avant d'être reclassé 'account-throttled' (TokenBucket n'expose aucun
// « peek », MÊME limite assumée que bridge.ts::rejectUnauthorized — cf. FailureBucket::recordFailure).
//
// Anti-DoS création (durci : `account:create` n'avait AUCUNE limite
// de débit jusque-là, alors qu'il est accessible en hello ANONYME et déclenche le MÊME scrypt coûteux
// que ci-dessus : DoS CPU + croissance mémoire/disque non bornée depuis une seule IP) — seau SÉPARÉ
// (`createFailuresByIp`, MÊME classe FailureBucket, jamais partagé avec `failuresByIp`/`failuresByName`
// ci-dessus), clé = IP SEULE (le pseudo diffère à CHAQUE tentative pour un attaquant qui en génère
// des nouveaux, une clé pseudo ne contiendrait donc rien). `recordFailure` est appelé JUSTE AVANT
// le calcul scrypt, APRÈS les refus bon marché (format/unicité, AUCUN hachage) : ceux-ci ne consomment
// PAS le seau, seule une tentative qui atteindrait le hachage compte — exactement le chemin visé par
// le défaut (DoS CPU via scrypt), sans pénaliser un client qui enchaîne des essais de format invalide
// (ex. validation côté formulaire). La tentative qui fait déborder le seau n'a donc payé AUCUN
// hachage, contrairement à `account:login` où l'échec qui déborde a déjà haché (cf. plus haut).
// Clé de repli 'inconnue' si l'IP n'est pas exposée par le transport (cf. `ipDe`) — jamais un accès
// non limité. Défaut CONSERVATEUR (création = action rare, plus stricte que forceBrute car scrypt
// coûte plus cher qu'une comparaison) : cf. `DEFAULT_CREATION_CAPACITY`/`opts.creationParIp`.
//
// Secret — hachage scrypt de Node (crypto.scrypt, sel aléatoire PAR COMPTE, comparaison
// timingSafeEqual) — AUCUNE dépendance externe (MÊME ethos que token.ts), AUCUN secret en clair
// nulle part (ni logs, ni erreurs, ni le jeton lui-même qui ne porte que id/pseudo/roles).

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { MjsWsClient, MjsWsHelloPayload, MjsWsLogFn, MjsWsLogLevel } from './core.js'
import { definePackage } from './packages.js'
import type { MjsPackage } from './packages.js'
import { signToken, jwtAuth } from './token.js'
import { TokenBucket } from './guard.js'
import { identityIdOf } from './sessions.js'
import type { MjsWsRemoteInfo } from './transport.js'
import { t } from '../messages/index.js'

// --- l'enregistrement compte ------------------------------------------------------------------

/** Un compte persisté — `hash`/`sel` ne quittent JAMAIS ce process (ni jeton, ni log, ni erreur). */
export interface MjsWsAccountRecord {
  /** stable, généré une fois pour toutes (cf. genId) — c'est CET id qui porte l'identité STABLE
   *  dans le jeton (élévation, sessionExclusive, quotas par identité — cf. tête de fichier). */
  id: string
  /** casse D'ORIGINE conservée (affichage) — unicité comparée EN MINUSCULES (cf. byName). */
  name: string
  /** scrypt(secret, sel), hex */
  hash: string
  /** sel aléatoire PAR COMPTE, hex */
  salt: string
  roles: string[]
  /** ms epoch — création */
  createdAt: number
  /** ms epoch — dernière connexion réussie (account:login) */
  seenAt: number
  /** libre — jamais interprété ici, extension applicative (cf. `opts.roles`) */
  meta: Record<string, unknown>
}

// --- le contrat de persistance (duck-typing STRICT, MÊME esprit que mjs-server/persist.ts — cf.
// tête de fichier pour le POURQUOI d'un contrat séparé plutôt qu'un réemploi) --------------------
//   load()            → Promise<MjsWsAccountRecord[]> — lu UNE FOIS, paresseusement, avant la
//                        première trame compte:* traitée (cf. assurerCharge plus bas)
//   save(id, compte)  → void | Promise<void> — écrit/remplace l'entrée, jamais attendue par le
//                        client (l'ack part dès que le jeton est signé, cf. accountsPackage)
//   remove(id)        → void | Promise<void> — aucune trame v1 ne l'appelle (pas de suppression de
//                        compte au protocole) ; présente pour la SYMÉTRIE du contrat et un usage
//                        direct par l'appli hôte (outillage admin), cf. docs/27-accounts.md « Limites »
//   flush()?          → void | Promise<void> — optionnel, jamais appelée par ce fichier (aucune
//                        notion d'arrêt de paquet — contrairement à mjs-server/persist.ts, un paquet
//                        n'a pas de cycle de vie stop() propre, cf. packages.ts)

export interface MjsWsAccountsPersistAdapter {
  load(): Promise<MjsWsAccountRecord[]>
  save(id: string, account: MjsWsAccountRecord): void | Promise<void>
  remove(id: string): void | Promise<void>
  flush?(): void | Promise<void>
}

// --- adaptateur mémoire (défaut) — DEV SEULEMENT, cf. accountsPackage (avertissement au boot) ----

export class MemoryAccountsPersistAdapter implements MjsWsAccountsPersistAdapter {
  private _store = new Map<string, MjsWsAccountRecord>()

  async load(): Promise<MjsWsAccountRecord[]> { return Array.from(this._store.values()) }
  save(id: string, account: MjsWsAccountRecord): void { this._store.set(id, account) }
  remove(id: string): void { this._store.delete(id) }
  flush(): void {}
}

// --- adaptateur fichier réel — MÊME technique que mjs-server/persist-file.ts (écriture ATOMIQUE
// tmp+rename, tolérance aux fichiers corrompus, suffixe tmp ALÉATOIRE), adaptée à
// MjsWsAccountRecord (fichier `<id>.json` par compte) — cf. son en-tête pour le détail des garanties
// (ENOENT idempotent, mkdir jamais réessayé si rejeté, PAS de WAL v1) : mêmes limites assumées ici. --

export interface FileAccountsPersistAdapterOpts {
  /** dossier de stockage — créé (récursif) s'il n'existe pas encore */
  dir: string
  /** défaut : console, préfixe '[mjs-ws:accounts:file]' */
  onLog?: MjsWsLogFn
}

function defaultLog(level: MjsWsLogLevel, message: string, meta?: unknown): void {
  const line = `[mjs-ws:accounts] ${message}`
  if (level === 'error') console.error(line, meta ?? '')
  else if (level === 'warn') console.warn(line, meta ?? '')
  else console.log(line, meta ?? '')
}

function fileDefaultLog(level: MjsWsLogLevel, message: string, meta?: unknown): void {
  const line = `[mjs-ws:accounts:file] ${message}`
  if (level === 'error') console.error(line, meta ?? '')
  else if (level === 'warn') console.warn(line, meta ?? '')
  else console.log(line, meta ?? '')
}

function estENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

export class FileAccountsPersistAdapter implements MjsWsAccountsPersistAdapter {
  private _dir: string
  private _onLog: MjsWsLogFn
  private _pret: Promise<void>
  private _enVol = new Set<Promise<void>>()

  constructor(opts: FileAccountsPersistAdapterOpts) {
    if (!opts.dir) throw new Error(t('ws.accounts.dir-manquant'))
    this._dir   = opts.dir
    this._onLog = opts.onLog ?? fileDefaultLog
    this._pret  = mkdir(this._dir, { recursive: true }).then(() => {})
  }

  private _chemin(id: string): string { return join(this._dir, id + '.json') }

  async load(): Promise<MjsWsAccountRecord[]> {
    await this._pret
    let fichiers: string[]
    try { fichiers = await readdir(this._dir) } catch { return [] }
    const résultats: MjsWsAccountRecord[] = []
    for (const fichier of fichiers) {
      if (!fichier.endsWith('.json') || fichier.endsWith('.tmp.json')) continue   // '.tmp.json' termine aussi par '.json' — l'exclusion doit passer en second
      try {
        const brut   = await readFile(join(this._dir, fichier), 'utf8')
        const account = JSON.parse(brut) as MjsWsAccountRecord
        résultats.push(account)
      } catch (err) {
        this._onLog('warn', t('ws.accounts.fichier-corrompu-ignore', { fichier }), { err: err instanceof Error ? err.message : String(err) })
      }
    }
    return résultats
  }

  save(id: string, account: MjsWsAccountRecord): void {
    const p = this._ecrireAtomique(id, account)
    this._suivre(p, `save('${id}')`)
  }

  remove(id: string): void {
    const p = unlink(this._chemin(id)).catch((err) => {
      if (estENOENT(err)) return
      this._onLog('warn', t('ws.accounts.remove-echoue', { id }), { err: err instanceof Error ? err.message : String(err) })
    })
    this._suivre(p, `remove('${id}')`)
  }

  async flush(): Promise<void> {
    await Promise.allSettled(Array.from(this._enVol))
  }

  private _suivre(p: Promise<void>, label: string): void {
    this._enVol.add(p)
    p.catch(err => this._onLog('warn', t('ws.accounts.rejet-non-intercepte', { label }), { err: err instanceof Error ? err.message : String(err) }))
      .finally(() => this._enVol.delete(p))
  }

  private async _ecrireAtomique(id: string, account: MjsWsAccountRecord): Promise<void> {
    const tmp = join(this._dir, id + '.' + randomBytes(4).toString('hex') + '.tmp.json')
    try {
      await this._pret
      await writeFile(tmp, JSON.stringify(account))
      await rename(tmp, this._chemin(id))
    } catch (err) {
      this._onLog('warn', t('ws.accounts.save-echoue', { id }), { err: err instanceof Error ? err.message : String(err) })
      await unlink(tmp).catch(() => {})
    }
  }
}

// --- scrypt (secret de compte) — clé dérivée 64 octets, défauts Node (N=16384, r=8, p=1) --------

const SCRYPT_KEYLEN = 64

function hacherSecret(secret: string, salt: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey.toString('hex'))
    })
  })
}

// comparaison à temps constant — longueur d'abord (timingSafeEqual lève sur une longueur
// différente), MÊME garde que token.ts::safeEqualB64/sessions.ts::keysEqual
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// sel FIXE (jamais un compte réel) — hachage FACTICE d'un pseudo inexistant, MÊME coût CPU qu'un
// hachage réel : sans lui, répondre 'account-denied' pour un pseudo absent serait plus RAPIDE que
// pour un pseudo existant + mauvais secret — un oracle de timing qui révélerait l'existence d'un
// compte MALGRÉ le message identique (cf. tête de fichier « anti-énumération »).
const DUMMY_SALT = Buffer.from('0'.repeat(32), 'hex')

// --- anti-force-brute — seau d'échecs PAR CLÉ (IP ou pseudo), MÊME PATRON que
// mjs-ws/bridge.ts::createBridgeRateLimiter (copié — cf. tête de fichier pour le pourquoi d'un
// import évité) : TokenBucket réutilisé TEL QUEL (guard.ts), verrou `blockedUntil` posé au moment où
// un `take()` de comptage échoue, éviction PARESSEUSE bornée (Map ordonnée par dernier accès). -----

const ECHEC_ENTRY_TTL_MS = 10 * 60 * 1000   // entrée intacte depuis > 10 min → purgée au passage
const ECHEC_SWEEP_MAX    = 8                // borne le coût d'un passage

interface EchecEntry { bucket: TokenBucket; blockedUntil: number; lastSeen: number }

/**
 * Seau d'échecs — `isBlocked(cle)` / `recordFailure(cle)`. EXPORTÉE pour ses propres tests
 * unitaires (isolation de deux clés indépendantes) — MÊME raison que `TokenBucket` (guard.ts) :
 * une isolation IP-vs-pseudo n'est pas observable de bout en bout via MemoryTransport, qui n'expose
 * jamais d'adresse distincte en test (cf. tests/mjs-ws-accounts.test.ts pour le détail).
 */
export class FailureBucket {
  private _map = new Map<string, EchecEntry>()

  constructor(private _capacity: number, private _windowMs: number) {}

  private _touch(key: string, now: number): EchecEntry {
    let evicted = 0
    for (const [k, e] of this._map) {
      if (now - e.lastSeen <= ECHEC_ENTRY_TTL_MS) break   // Map ordonnée par ancienneté d'accès — le reste est plus récent
      this._map.delete(k)
      if (++evicted >= ECHEC_SWEEP_MAX) break
    }
    let entry = this._map.get(key)
    if (entry) {
      entry.lastSeen = now
      this._map.delete(key); this._map.set(key, entry)   // ré-insère en fin — ordre = ancienneté de dernier accès
    } else {
      entry = { bucket: new TokenBucket(this._capacity, this._capacity / (this._windowMs / 1000)), blockedUntil: 0, lastSeen: now }
      this._map.set(key, entry)
    }
    return entry
  }

  /** true = clé actuellement en pénalité (trop d'échecs récents, verrouillée par un appel PRÉCÉDENT
   *  à `recordFailure`) → 'account-throttled' immédiat, AUCUN calcul de hachage pour cette requête. */
  isBlocked(key: string, now = Date.now()): boolean { return now < this._touch(key, now).blockedUntil }

  /**
   * À appeler après un échec CONFIRMÉ (secret faux/pseudo absent) — verrouille `windowMs` si le
   * budget déborde, MÊME mécanique que bridge.ts::recordFailure. Retourne `true` = encore DANS le
   * budget (échec normal, capacité RESTAIT > 0 avant CET appel) ; `false` = ce même appel VIENT de
   * faire déborder le seau — TokenBucket n'expose qu'un `take()` consommateur, aucun « peek »
   * (cf. bridge.ts, même limite assumée) : la requête qui fait déborder le seau a donc DÉJÀ payé son
   * calcul de hachage avant que ce retour ne soit connu — c'est l'APPELANT qui doit alors reclasser
   * SA PROPRE réponse en 'account-throttled' plutôt que 'account-denied' (cf. accountsPackage,
   * account:login). Seules les requêtes SUIVANTES sont bloquées AVANT tout hachage (`isBlocked`
   * ci-dessus, déjà vrai grâce à `blockedUntil`).
   */
  recordFailure(key: string, now = Date.now()): boolean {
    const entry  = this._touch(key, now)
    const within = entry.bucket.take(1)
    if (!within) entry.blockedUntil = now + this._windowMs
    return within
  }

  /** nombre de clés actuellement suivies — tests d'éviction uniquement. */
  get size(): number { return this._map.size }
}

// --- rôles — helper exporté, utilisable par les hooks des AUTRES paquets (ex. chat.moderateurs) --

/** `hasRole(identity, 'admin')` — `identity` = `client.identity` (duck-typé `{roles: string[]}`,
 *  forme posée par le jeton compte, cf. emettreJeton) : `false` pour toute forme inattendue, jamais
 *  un throw (identité anonyme, jeton d'un AUTRE mécanisme sans `roles`…). */
export function hasRole(identity: unknown, role: string): boolean {
  if (!identity || typeof identity !== 'object') return false
  const roles = (identity as Record<string, unknown>).roles
  return Array.isArray(roles) && roles.includes(role)
}

// --- validation pseudo ---------------------------------------------------------------------------
// 3-24 caractères, [a-z0-9_-] — `i` (insensible à la casse) : la casse D'ORIGINE reste acceptée et
// conservée pour l'affichage (cf. MjsWsAccountRecord.pseudo), seule la comparaison d'UNICITÉ est
// systématiquement faite en minuscules (cf. accountsPackage, byName).

const PSEUDO_RE = /^[a-z0-9_-]{3,24}$/i

function isValidName(name: unknown): name is string {
  return typeof name === 'string' && PSEUDO_RE.test(name)
}

// --- options ---------------------------------------------------------------------------------

export interface MjsWsAccountsOptions {
  /**
   * Secret HMAC des jetons de compte (signToken/token.ts) — DOIT être IDENTIQUE au secret donné à
   * `accountsAuth(secret)` posé en `mjsWs({ auth })` (cf. tête de fichier « Élévation ») : sans ce
   * jumelage, le hello de la RECONNEXION d'élévation (cf. `_compteElever`, mjs_accounts.ts) sera
   * TOUJOURS refusé (`µ:denied`), même après un `account:create`/`account:login` réussi — le
   * jeton fraîchement signé ne serait vérifiable par PERSONNE côté serveur. Requis — AUCUN défaut
   * (un secret par défaut serait une faille, cf. token.ts/bridge.ts, même exigence).
   */
  secret: string
  /** Stockage des comptes — défaut : `MemoryAccountsPersistAdapter` (DEV SEULEMENT, avertit au
   *  boot) ; `FileAccountsPersistAdapter`/adaptateur maison pour la prod, cf. docs/27-accounts.md. */
  persist?: MjsWsAccountsPersistAdapter
  /** Durée de vie du jeton émis, SECONDES (défaut 7 jours = 604800). */
  ttl?: number
  /** Enrichit/recalcule les rôles portés par le jeton à CHAQUE émission (creer ET connecter) — reçoit
   *  l'enregistrement PERSISTÉ (roles/meta inclus), retourne la liste EFFECTIVE du jeton. Absent =
   *  `compte.roles` tel que persisté. Cf. `hasRole` pour la lecture côté hooks (chat.moderateurs…). */
  roles?(account: MjsWsAccountRecord): string[] | Promise<string[]>
  /** Anti-force-brute (account:login SEULEMENT — cf. tête de fichier) — défaut 5 échecs/minute
   *  PAR IP ET PAR PSEUDO (le premier budget épuisé bloque, cf. FailureBucket). */
  bruteForce?: { capacity?: number; windowMs?: number }
  /** Anti-DoS création (account:create SEULEMENT, PAR IP — cf. tête de fichier « Anti-DoS création »,
   *  durci) — défaut CONSERVATEUR, 3 créations/minute/IP (seau
   *  SÉPARÉ de `forceBrute`, MÊME mécanisme FailureBucket/TokenBucket, guard.ts). */
  createPerIp?: { capacity?: number; windowMs?: number }
  /** Plafond OPTIONNEL du nombre TOTAL de comptes — au-delà, account:create refuse avec
   *  'account-limit-reached'. Absent = illimité (v1 par défaut, comportement historique). */
  maxAccounts?: number
  /** défaut : console, préfixe '[mjs-ws:accounts]' (même sobriété que mjs-ws/index.ts defaultLog) */
  onLog?: MjsWsLogFn
}

const DEFAULT_TTL                    = 7 * 24 * 3600   // 7 jours, secondes (signToken attend un ttl en secondes)
const DEFAULT_FORCE_BRUTE_CAPACITY   = 5
const DEFAULT_FORCE_BRUTE_WINDOW_MS  = 60000            // 1 minute
const DEFAULT_CREATION_CAPACITY      = 3                // créations/IP/fenêtre — conservateur (scrypt coûteux, hello anonyme)
const DEFAULT_CREATION_WINDOW_MS     = 60000            // 1 minute

// clé de seau-échecs pour un pseudo qui n'est même pas une chaîne — un SEUL panier partagé par tout
// payload malformé (pas d'explosion de clés, cf. ECHEC_SWEEP_MAX) ; le seau IP reste, lui, TOUJOURS
// discriminant (cf. ipDe) — un payload malformé n'échappe donc jamais à la limite de débit.
const ECHEC_CLE_INVALIDE = '\0invalide'

function ipDe(client: MjsWsClient): string { return client.meta.address ?? 'inconnue' }

/**
 * Complément : `opts.auth`
 * d'une appli qui veut « connexion anonyme, puis élévation » (cf. tête de fichier) ne peut PAS être
 * `jwtAuth(secret)` NU — `jwtAuth` renvoie `false` (donc `µ:denied`) pour TOUT hello SANS jeton, ce
 * qui rejetterait la connexion anonyme elle-même, avant même de pouvoir appeler `account:create`.
 * `accountsAuth(secret)` est le wrapper minimal qui manque : hello SANS jeton → `undefined` (identité
 * anonyme, MÊME valeur que le champ `client.identity` avant toute auth, cf. core.ts) ; hello (ou
 * µ:refresh) AVEC jeton → délégué tel quel à `jwtAuth(secret)` (`false` si invalide/expiré/signature
 * fausse). Sans lui, ce paquet n'est PAS branchable tel que documenté en tête de fichier — cf.
 * docs/27-accounts.md « Démarrer ».
 */
export function accountsAuth(secret: string): (hello: MjsWsHelloPayload, meta: MjsWsRemoteInfo) => unknown {
  const verifier = jwtAuth(secret)
  return (hello, meta) => {
    const raw   = hello?.auth as unknown
    const token = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw as { token?: unknown }).token : undefined)
    if (typeof token !== 'string' || token === '') return undefined   // pas de jeton — anonyme AUTORISÉ
    return verifier(hello, meta)
  }
}

/**
 * Paquet COMPTES & IDENTITÉS — `app.use(accountsPackage(opts))` (cf. tête de fichier pour le
 * protocole complet + le mécanisme d'élévation). `opts.secret` est REQUISE — lève IMMÉDIATEMENT
 * (avant même `app.use`, jamais un démarrage à moitié fait) si absente/vide, MÊME esprit que
 * bridge.ts (secret manquant) et FilePersistAdapter (opts.dir manquant).
 */
export function accountsPackage(opts: MjsWsAccountsOptions): MjsPackage {
  if (!opts || typeof opts.secret !== 'string' || opts.secret === '') {
    throw new Error(t('ws.accounts.secret-manquant'))
  }
  const onLog = opts.onLog ?? defaultLog
  const persist = opts.persist ?? new MemoryAccountsPersistAdapter()
  if (!opts.persist) {
    onLog('warn', t('ws.accounts.adaptateur-memoire-defaut'))
  }
  const ttl = opts.ttl ?? DEFAULT_TTL
  const forceBruteCapacity = opts.bruteForce?.capacity ?? DEFAULT_FORCE_BRUTE_CAPACITY
  const forceBruteWindowMs = opts.bruteForce?.windowMs ?? DEFAULT_FORCE_BRUTE_WINDOW_MS
  const failuresByIp     = new FailureBucket(forceBruteCapacity, forceBruteWindowMs)
  const failuresByName = new FailureBucket(forceBruteCapacity, forceBruteWindowMs)

  // anti-DoS création (account:create SEULEMENT, PAR IP — cf. tête de fichier « Anti-DoS création »)
  const creationCapacity = opts.createPerIp?.capacity ?? DEFAULT_CREATION_CAPACITY
  const creationWindowMs = opts.createPerIp?.windowMs ?? DEFAULT_CREATION_WINDOW_MS
  const createFailuresByIp = new FailureBucket(creationCapacity, creationWindowMs)

  // index EN MÉMOIRE pseudo(minuscule)→compte + id→compte, chargé PARESSEUSEMENT (1re trame
  // compte:* traitée) et tenu à jour à CHAQUE création — évite un load()/scan de l'adaptateur à
  // chaque tentative de connexion (cf. mjs-server/persist.ts, même esprit d'un index local devant
  // un adaptateur potentiellement lent/distant, ex. FileAccountsPersistAdapter/pont HTTP).
  const byName = new Map<string, MjsWsAccountRecord>()
  const byId     = new Map<string, MjsWsAccountRecord>()
  // pseudos RÉSERVÉS le temps d'une création EN COURS — consultée
  // EN PLUS de byName au contrôle d'unicité, posée AVANT l'await scrypt (cf. account:create) : sans
  // elle, deux créations concurrentes du MÊME pseudo passent TOUTES LES DEUX le contrôle synchrone
  // (race TOCTOU) et persistent chacune un compte distinct sous le même nom.
  const pendingNames = new Set<string>()
  let charge: Promise<void> | null = null

  function assurerCharge(): Promise<void> {
    if (!charge) {
      charge = Promise.resolve(persist.load()).then(rows => {
        for (const c of rows) { byName.set(c.name.toLowerCase(), c); byId.set(c.id, c) }
      }).catch(err => {
        onLog('warn', t('ws.accounts.persist-load-echoue'), { err: err instanceof Error ? err.message : String(err) })
        // garde muette — SANS ça, `charge` restait posé (promesse
        // déjà réglée) même après un échec : une panne TRANSITOIRE (réseau, disque) rendait TOUS les
        // comptes déjà persistés invisibles à vie et autorisait des doublons de pseudo silencieux.
        // Retenté au PROCHAIN appel — jamais de retentative dans la foulée (pas de boucle serrée).
        charge = null
      })
    }
    return charge
  }

  // id de compte UNIQUE — revérifie `byId` (même patron que
  // sessions.ts::issue(), qui reboucle déjà tant que son registre connaît l'id tiré ; asymétrie
  // notée, collision négligeable en pratique à 64 bits d'aléa mais sans coût à
  // corriger). `draw` isolé en paramètre optionnel pour le SEUL test unitaire de la boucle — tout
  // appelant réel garde le tirage `randomBytes` par défaut, AUCUN changement de comportement.
  function genId(draw: () => string = () => randomBytes(8).toString('hex')): string {
    let id = draw()
    while (byId.has(id)) id = draw()
    return id
  }

  async function resoudreRoles(account: MjsWsAccountRecord): Promise<string[]> {
    return opts.roles ? await opts.roles(account) : account.roles
  }

  function emettreJeton(account: MjsWsAccountRecord, roles: string[]): string {
    return signToken({ id: account.id, name: account.name, roles }, opts.secret, { ttl })
  }

  const pkg = definePackage('accounts', app => {

    app.serve('account:create', async (p, client) => {
      await assurerCharge()
      if (opts.maxAccounts != null && byName.size >= opts.maxAccounts) throw new Error('account-limit-reached')
      const name = p?.name
      const secret = p?.secret
      if (!isValidName(name)) throw new Error('account-name-invalid')
      if (typeof secret !== 'string' || secret.length < 8) throw new Error('account-secret-short')
      const key = name.toLowerCase()
      if (byName.has(key) || pendingNames.has(key)) throw new Error('account-name-taken')

      // réserve le pseudo AVANT l'await scrypt (race TOCTOU — le
      // contrôle ci-dessus est synchrone, deux créations concurrentes du MÊME pseudo passaient donc
      // TOUTES LES DEUX) — libérée dans le `finally`, quelle que soit l'issue : sur succès, `byName`
      // porte déjà le compte réel avant la libération (le contrôle ci-dessus reste vrai ensuite).
      pendingNames.add(key)
      try {
        // anti-DoS création — PAR IP, JUSTE AVANT le calcul scrypt (coûteux, cf. tête de fichier
        // « Anti-DoS création ») : les refus bon marché ci-dessus (format/unicité, AUCUN hachage) ne
        // consomment PAS le seau — seule une tentative qui atteindrait le hachage compte, exactement le
        // chemin que le défaut visait (DoS CPU via scrypt). MÊME shape d'erreur que account:login —
        // un client ne distingue pas les deux causes.
        const ip = ipDe(client)
        if (!createFailuresByIp.recordFailure(ip)) throw new Error('account-throttled')

        const salt  = randomBytes(16)
        const hash = await hacherSecret(secret, salt)
        const now = Date.now()
        const account: MjsWsAccountRecord = {
          id: genId(), name, hash, salt: salt.toString('hex'), roles: [], createdAt: now, seenAt: now, meta: {},
        }
        // n'inscrit dans byName/byId qu'après une sauvegarde RÉUSSIE —
        // AVANT, l'inscription précédait persist.save() : un échec de sauvegarde laissait un compte
        // FANTÔME en mémoire (jeton reçu valide), bloquant le pseudo pour toute création légitime
        // tout en restant, lui, à jamais injoignable par account:login (jamais écrit sur disque).
        try {
          await Promise.resolve(persist.save(account.id, account))
        } catch (err) {
          onLog('error', t('ws.accounts.persist-echec', { name }), { err: err instanceof Error ? err.message : String(err) })
          throw new Error('account-persist-failed')
        }
        byName.set(key, account); byId.set(account.id, account)

        const roles = await resoudreRoles(account)
        return { ok: true, token: emettreJeton(account, roles) }
      } finally {
        pendingNames.delete(key)
      }
    })

    app.serve('account:login', async (p, client) => {
      await assurerCharge()
      const name = p?.name
      const secret = p?.secret
      const ip         = ipDe(client)
      const nameKey  = typeof name === 'string' ? name.toLowerCase() : ECHEC_CLE_INVALIDE

      // anti-force-brute — AVANT tout calcul de hachage (y compris factice, cf. tête de fichier) :
      // un seul des deux seaux suffit à bloquer, message IDENTIQUE quel que soit celui qui déborde.
      if (failuresByIp.isBlocked(ip) || failuresByName.isBlocked(nameKey)) throw new Error('account-throttled')

      const account = typeof name === 'string' ? byName.get(name.toLowerCase()) : undefined

      // reclassement (cf. FailureBucket::recordFailure) — l'échec qui fait DÉBORDER le seau a déjà
      // payé son calcul de hachage (aucun « peek » possible), mais SA PROPRE réponse doit quand même
      // devenir 'account-throttled' plutôt que 'account-denied' : sans ça, un client verrait un
      // 'account-denied' de plus AVANT de percuter le mur au coup suivant, alors que ce coup-ci a
      // DÉJÀ fait déborder le budget — seules les requêtes ULTÉRIEURES bénéficient du court-circuit
      // `isBlocked` avant tout hachage (cf. tête de fonction ci-dessus).
      if (!account) {
        await hacherSecret(typeof secret === 'string' ? secret : '', DUMMY_SALT)   // coût constant — anti-énumération par timing (cf. DUMMY_SALT)
        const okIp     = failuresByIp.recordFailure(ip)
        const okPseudo = failuresByName.recordFailure(nameKey)
        throw new Error((okIp && okPseudo) ? 'account-denied' : 'account-throttled')
      }

      const essai = typeof secret === 'string' ? await hacherSecret(secret, Buffer.from(account.salt, 'hex')) : null
      if (!essai || !safeEqualHex(essai, account.hash)) {
        const okIp     = failuresByIp.recordFailure(ip)
        const okPseudo = failuresByName.recordFailure(nameKey)
        throw new Error((okIp && okPseudo) ? 'account-denied' : 'account-throttled')
      }

      account.seenAt = Date.now()
      await Promise.resolve(persist.save(account.id, account))
      const roles = await resoudreRoles(account)
      return { ok: true, token: emettreJeton(account, roles) }
    })

    // v1 sans état (cf. tête de fichier « Déconnexion ») — rien à révoquer pour une identité déjà
    // anonyme (identityIdOf null) : no-op { ok: true }, jamais de fermeture gratuite d'une connexion
    // invité. Fermeture DIFFÉRÉE (setTimeout 0) : l'accusé de réception doit partir AVANT la coupure
    // (routeAppMessage envoie le µ:ack juste après le retour de ce handler, cf. core.ts) — fermer
    // SYNCHRONEMENT ici ferait courir le risque que l'ack ne parte jamais (client déjà 'closing').
    app.serve('account:logout', async (_p, client) => {
      if (identityIdOf(client.identity) != null) {
        setTimeout(() => client.close('deconnexion'), 0)
      }
      return { ok: true }
    })
  })

  // accès à l'état interne à des fins de TEST UNIQUEMENT — MÊME précédent que chat.ts (_buckets/
  // _mutedUntil) et lobby.ts (_presence/_listings) : aucune primitive publique n'expose `byId` ni
  // ne permet de piloter `genId()` (indispensable pour prouver la revérification de collision —
  // une collision réelle à 64 bits d'aléa n'est pas observable de bout en bout).
  ;(pkg as any)._byId  = byId
  ;(pkg as any)._genId = genId
  return pkg
}
