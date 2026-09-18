// mjs-ws/guard — « le videur » : protections de série contre un client qui
// dérape (débit, taille, contre-pression) et contre un handler applicatif qui
// plante. Primitives pures/réutilisables, sans dépendance au transport ni au
// protocole µ: — core.ts les branche mais n'en réimplémente aucune.

/** Seau à jetons — rate/burst par connexion (refill continu, pas de fenêtre fixe). */
export class TokenBucket {
  private _tokens: number
  private _lastRefill: number

  constructor(private _capacity: number, private _refillPerSecond: number) {
    this._tokens     = _capacity
    this._lastRefill = Date.now()
  }

  /** consomme `cost` jeton(s) ; false si le seau est vide (message à rejeter) */
  take(cost = 1): boolean {
    this._refill()
    if (this._tokens < cost) return false
    this._tokens -= cost
    return true
  }

  private _refill(): void {
    const now     = Date.now()
    const elapsed = (now - this._lastRefill) / 1000
    if (elapsed <= 0) return
    this._tokens     = Math.min(this._capacity, this._tokens + elapsed * this._refillPerSecond)
    this._lastRefill = now
  }
}

/** Minuteur d'inactivité — se réarme à chaque pet(), déclenche onTimeout si aucun pet() avant `ms`. `ms <= 0` = désactivé. */
export class Watchdog {
  private _timer: ReturnType<typeof setTimeout> | null = null

  constructor(private _ms: number, private _onTimeout: () => void) {}

  pet(): void {
    if (this._ms <= 0) return
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(this._onTimeout, this._ms)
  }

  stop(): void {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
  }
}

// kick au-delà de N drops de contre-pression CONSÉCUTIFS — constante fixe (pas
// dans `limits`, hors du contrat resolveé par index.ts) : au-delà, la connexion
// est jugée irrécupérable (le pair ne vide plus jamais son buffer).
export const MAX_CONSECUTIVE_DROPS = 50

// throttle des µ:error de dépassement de débit — UN message par fenêtre, pas un
// par trame jetée (sinon le throttle lui-même spamme le client en retour).
export const RATE_ERROR_THROTTLE_MS = 1000

/** true si le message DOIT être jeté (buffer du transport déjà trop plein). */
export function isBackpressured(bufferedAmount: number, maxBuffered: number): boolean {
  return bufferedAmount > maxBuffered
}

/** message lisible depuis un throw/reject quelconque (Error ou non). */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// clé sûre pour une écriture par crochets dans un objet JS ordinaire — anti-
// pollution de prototype (__proto__/constructor/prototype). Homologue du
// _safeKey côté client (runtime/mjs_socket.ts). Nécessaire pour toute
// conversion Map → objet simple dont les clés dérivent d'une valeur réseau
// (ex. identity.id d'un µ:hello écrit tel quel dans les peers de présence) —
// PAS pour les Map elles-mêmes (insensibles à ce risque) ni pour un spread
// ({...a, ...b}, déjà sûr : CreateDataProperty, pas le setter __proto__).
export function safeKey(k: string): boolean {
  return k !== '__proto__' && k !== 'constructor' && k !== 'prototype'
}
