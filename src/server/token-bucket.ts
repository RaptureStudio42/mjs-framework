// token-bucket — seau à jetons PARTAGÉ (index.ts et render-server.ts en portaient chacun une
// copie IDENTIQUE, « TRANSPOSÉE ici en local »). EXTRAIT ici plutôt que
// simplement exporté depuis l'un des deux : ni l'un ni l'autre n'a à importer le graphe complet
// de son frère pour cette seule classe. `pruneIdleBuckets` répare l'autre moitié du défaut : la
// `Map<string, TokenBucket>` par IP ne retirait JAMAIS une entrée — une adresse vue une fois y
// restait à vie (fuite mémoire lente, un serveur longue durée derrière beaucoup d'IP différentes).

/** Seau à jetons — refill continu (pas de fenêtre fixe), ~capacity jetons, recharge refillPerSecond/s. */
export class TokenBucket {
  private _tokens: number
  private _lastRefill: number

  constructor(private _capacity: number, private _refillPerSecond: number) {
    this._tokens     = _capacity
    this._lastRefill = Date.now()
  }

  /** consomme `cost` jeton(s) ; false si le seau est vide (message/requête à rejeter) */
  take(cost = 1): boolean {
    this._refill()
    if (this._tokens < cost) return false
    this._tokens -= cost
    return true
  }

  /** vrai si le seau est REVENU plein (après recharge) — sert de critère d'éviction, cf. pruneIdleBuckets */
  isIdle(): boolean {
    this._refill()
    return this._tokens >= this._capacity
  }

  private _refill(): void {
    const now     = Date.now()
    const elapsed = (now - this._lastRefill) / 1000
    if (elapsed <= 0) return
    this._tokens     = Math.min(this._capacity, this._tokens + elapsed * this._refillPerSecond)
    this._lastRefill = now
  }
}

/**
 * Purge paresseuse d'une carte de seaux PAR IP — ne fait rien tant que `buckets.size <= max`
 * (coût nul dans le cas courant) ; au-delà, retire toutes les entrées `isIdle()` (seau REVENU
 * plein, donc sans jeton consommé récemment). Un seau qui vient de consommer reste, même au-delà
 * du plafond — seule l'inactivité vide une entrée, jamais son ancienneté brute.
 */
export function pruneIdleBuckets(buckets: Map<string, TokenBucket>, max = 1000): void {
  if (buckets.size <= max) return
  for (const [ip, bucket] of buckets) {
    if (bucket.isIdle()) buckets.delete(ip)
  }
}
