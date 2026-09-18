// render-routes — logique PURE de résolution d'une PAGE (niveau 1).
//
// À partir du bloc `render` de mjs.config.json, répond à : « pour cette URL de
// requête, quel composant rendre, dans quel mode, avec quels params ? ». Utilisé
// par le prérendu au build ET par le serveur de rendu par requête.
//
// La nav in-app `#/…` (niveau 2) ne passe JAMAIS ici : elle reste 100% client
// (routeur hash). Ce module ne voit que les vraies URLs (paths) déclarées.

import type { RenderConfig, RenderMode, RenderRoute, RenderEngine, RenderStartupMode } from '../bundler/config.js'

/** Mode appliqué quand ni la route ni `render.default` ne le précisent. */
export const FALLBACK_MODE: RenderMode = 'prerender'

/** Démarrage appliqué quand ni la route ni `render.startup` ne le précisent. */
export const FALLBACK_STARTUP: RenderStartupMode = 'preload'

const VALID_MODES = new Set<string>([
  'csr', 'prerender', 'ssr', 'ssr:replace', 'ssr:markers', 'ssr:positional', 'ssr:diff',
])

export interface ResolvedPage {
  /** Composant à rendre (ex. 'mjs-blog'). */
  component: string
  /** Mode résolu, forme canonique (`ssr` → `ssr:replace`). */
  mode: RenderMode
  /** Params de route capturés (`/produit/:id` sur `/produit/42` → {id:'42'}) ;
   *  le joker `*` pose `rest` (chaîne) ET `all` (tableau) — cf. matchPattern. */
  params: Record<string, string | string[]>
  /** Délai de stabilisation (ms) de la route résolue, si posé (`route.settleMs`).
   *  Simple TRANSIT ici — ni défaut ni consommation. */
  settleMs?: number
  /** Moteur de rendu de la route résolue, si posé (`route.engine`). Simple
   *  TRANSIT ici — ni défaut ni consommation. */
  engine?: RenderEngine
  /** Démarrage de la route résolue, si posé (`route.startup`). Simple TRANSIT
   *  ici — le défaut vit dans `pickStartup` ci-dessous. */
  startup?: RenderStartupMode
  /** Racine à monter en mode léger, si posé (`route.light`). Simple TRANSIT ici —
   *  ni défaut ni consommation. */
  light?: boolean
}

/** `ssr` seul ≡ `ssr:replace` (stratégie d'hydratation par défaut). */
export function normalizeMode(m: RenderMode): RenderMode {
  return m === 'ssr' ? 'ssr:replace' : m
}

/** Nombre de segments LITTÉRAUX d'un motif (pour trier par spécificité). */
function staticSegs(pattern: string): number {
  return pattern.split('/').filter(s => s && s[0] !== ':' && s !== '*').length
}

/**
 * Matche un motif d'URL contre un path concret. `:param` capture un segment,
 * `*` capture tout le reste : `rest` (chaîne, reconstruire une URL) et `all`
 * (tableau des segments, itérer/compter). Retourne les params, ou `null` si
 * pas de match. Longueur exacte exigée (sauf `*`).
 *   matchPattern('/produit/:id', '/produit/42') → { id: '42' }
 *   matchPattern('/blog',        '/blog/x')     → null
 *   matchPattern('/files/*',     '/files/a/b')  → { rest: 'a/b', all: ['a', 'b'] }
 */
export function matchPattern(pattern: string, path: string): Record<string, string | string[]> | null {
  const pp = pattern.split('/').filter(Boolean)
  const cp = path.split('/').filter(Boolean)
  const params: Record<string, string | string[]> = {}
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i]
    if (seg === '*') { const segs = cp.slice(i); params.all = segs; params.rest = segs.join('/'); return params }
    if (cp[i] === undefined) return null
    if (seg[0] === ':') {
      try { params[seg.slice(1)] = decodeURIComponent(cp[i]) }
      catch { params[seg.slice(1)] = cp[i] }
    } else if (seg !== cp[i]) {
      return null
    }
  }
  return pp.length === cp.length ? params : null
}

// Coût serveur croissant par mode :
// `csr` (rien), `prerender` (lecture fichier, ou repli SSR si absent),
// `ssr:*` (compile + eval happy-dom + render PAR REQUÊTE, le plus coûteux).
function modeCost(m: RenderMode): number {
  if (m === 'csr') return 0
  if (m === 'prerender') return 1
  return 2   // toute variante ssr:*
}

/** Le mode effectif d'une route : header (borné) > route.mode > default > fallback. */
function pickMode(route: RenderRoute, render: RenderConfig, headerMode?: string | null): RenderMode {
  const configured = route.mode
    ? normalizeMode(route.mode)
    : render.default ? normalizeMode(render.default) : FALLBACK_MODE

  if (headerMode && VALID_MODES.has(headerMode)) {
    const wanted = normalizeMode(headerMode as RenderMode)
    // Le header `X-MJS-Render` est fourni PAR LE CLIENT (en-tête HTTP arbitraire,
    // sans authentification NI vérification d'origine) et surchargeait le mode
    // SANS AUCUNE BORNE : n'importe quel appelant pouvait forcer `ssr` (coûteux :
    // compile + eval happy-dom + render PAR REQUÊTE) sur une route configurée
    // `csr`/`prerender` (bon marché) — amplification DoS triviale (1 requête client
    // ~gratuite → 1 rendu serveur complet, répétable en boucle). Le SEUL usage
    // légitime documenté (cf. en-tête de fichier) est la DÉGRADATION cliente
    // (`X-MJS-Render: csr` sur un appel AJAX in-app pour éviter un re-rendu
    // serveur inutile) — jamais l'inverse. Fix : le header ne peut que RÉDUIRE
    // le coût par rapport au mode CONFIGURÉ de la route, jamais l'augmenter.
    if (modeCost(wanted) <= modeCost(configured)) return wanted
  }
  return configured
}

/**
 * Résout la PAGE pour une URL : quel composant, quel mode, quels params.
 * Retourne `null` si l'URL n'est PAS une page déclarée → le back sert alors le
 * shell (CSR) comme aujourd'hui. Tri par SPÉCIFICITÉ (plus de segments littéraux
 * d'abord) pour que `/blog/new` gagne sur `/blog/:slug`.
 * `headerMode` surcharge le mode si fourni et valide.
 */
export function resolvePage(
  path: string,
  render: RenderConfig | undefined,
  headerMode?: string | null,
): ResolvedPage | null {
  if (!render || !render.routes) return null
  const patterns = Object.keys(render.routes).sort(
    (a, b) => staticSegs(b) - staticSegs(a) || b.length - a.length,
  )
  for (const pattern of patterns) {
    const params = matchPattern(pattern, path)
    if (params) {
      const route = render.routes[pattern]
      // Spread CONDITIONNEL (pas `settleMs: route.settleMs` en dur) : une clé
      // présente mais à `undefined` n'égale PAS une clé absente pour
      // `assert.deepEqual` (Object.keys() diffère) — on ne veut pas casser la
      // forme historique `{ component, mode, params }` des routes qui ne
      // posent ni l'un ni l'autre.
      return {
        component: route.component,
        mode: pickMode(route, render, headerMode),
        params,
        ...(route.settleMs !== undefined ? { settleMs: route.settleMs } : {}),
        ...(route.engine !== undefined ? { engine: route.engine } : {}),
        ...(route.startup !== undefined ? { startup: route.startup } : {}),
        ...(route.light !== undefined ? { light: route.light } : {}),
      }
    }
  }
  return null
}

/**
 * Ce que le fragment figé d'une page dit de charger au démarrage : `route.startup` >
 * `render.startup` > `FALLBACK_STARTUP`. Le motif de route est cherché TEL QUEL dans la table (une
 * page prérendue est concrète par construction, cf. isBuildPrerenderable) : aucun `matchPattern` ici.
 */
export function pickStartup(render: RenderConfig | undefined, url: string): RenderStartupMode {
  if (!render) return FALLBACK_STARTUP
  return render.routes?.[url]?.startup ?? render.startup ?? FALLBACK_STARTUP
}

/**
 * Nom de fichier de l'ensemble de démarrage d'une route (`mjs_page-<nom>-<empreinte>.js`, cf.
 * bundler/startup.ts) : dérivé de l'URL DE LA ROUTE, jamais du nom du fragment — deux routes de
 * basename identique (`/` et `/a/index`) ont chacune le sien, et les langues d'une même route
 * partagent le leur (même URL). Minuscules, tout ce qui n'est pas `[a-z0-9]` devient un tiret ;
 * `/` donne `index`. Deux URLs qui rendent le même nom sont refusées à la validation de la
 * configuration (cf. bundler/config.ts) : une seule des deux garderait son fichier.
 */
export function startupSlug(url: string): string {
  const nu = url.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
  return nu === '' ? 'index' : nu.replace(/[^a-z0-9]/g, '-')
}

/** Une route est-elle prérendable au build ? Non si paramétrée (`:x`/`*` : on ne
 *  connaît pas les valeurs au build) — celles-là relèvent du SSR par requête. */
export function isBuildPrerenderable(pattern: string, mode: RenderMode): boolean {
  if (mode !== 'prerender') return false
  return !pattern.split('/').some(s => s[0] === ':' || s === '*')
}
