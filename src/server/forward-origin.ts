// server/forward-origin — logique PARTAGÉE de render.forwardOrigin (résolution +
// garde SSRF), sans dépendance vers render-request.ts/renderToString.ts/
// render-browser.ts (module FEUILLE) : les trois l'importent directement, sans
// cycle — render-request.ts crée les deux moteurs (createSSRRenderer,
// createBrowserRenderer), donc CE fichier ne peut pas passer PAR render-request.ts
// pour atteindre les moteurs sous peine d'import circulaire.
//
// (SSRF) — contrat AVANT ce fichier : `computeForwardedOrigin`
// dérivait l'origine de proxy DIRECTEMENT du Host brut de la requête entrante, sans
// AUCUNE validation. Un attaquant posant `Host: 169.254.169.254` (métadonnées
// cloud) ou `Host: 10.x.x.x` (réseau interne) faisait exécuter par happy-dom
// (renderToString.ts) ou le proxy du moteur navigateur (render-browser.ts) une
// VRAIE requête sortante vers CETTE cible, réfléchie dans le HTML — lecture du
// réseau interne / des métadonnées cloud depuis l'extérieur. Fix : JAMAIS de
// dérivation depuis Host/X-Forwarded-* sans autorisation EXPLICITE en config, et
// défense en profondeur (`isBlockedForwardTarget`) même quand une autorisation
// existe — cf. leurs commentaires respectifs plus bas.
//
// NOUVEAU CONTRAT `render.forwardOrigin` — trois formes :
//   - `false`            : désactivé, jamais de forwarding (inchangé).
//   - chaîne              : ORIGINE FIXE imposée par le dev (ex. 'https://back.exemple.com')
//                           — JAMAIS dérivée du Host entrant, c'est TOUJOURS cette
//                           valeur qui sert de cible (le Host du client est ignoré).
//   - { trustedHosts: [] } : ALLOWLIST d'hôtes de confiance — seul un Host ENTRANT
//                           qui y figure EXACTEMENT autorise le forwarding (vers
//                           CE Host, avec x-forwarded-proto) ; tout Host absent de
//                           la liste retombe sur le défaut sûr (aucun forwarding).
//   - absent, ou `true`   : DÉFAUT SÛR — `true` n'est PAS une autorisation d'hôte
//                           (il ne l'a jamais été explicitement avant ce fix, mais
//                           se comportait COMME SI il en était une : c'est
//                           exactement le trou qu'on ferme). Aucune dérivation
//                           depuis Host : les moteurs de rendu retombent sur leur
//                           origine locale câblée en dur (`http://localhost/`,
//                           cf. renderToString.ts/render-browser.ts), qui n'est
//                           JAMAIS influencée par une entrée client — changement de
//                           défaut ASSUMÉ (sécurité), documenté dans docs/19-ssr.md.
import type { RenderConfig } from '../bundler/config.js'

/**
 * Retire le port (et les crochets IPv6 éventuels) d'un `host` HTTP brut
 * (`'127.0.0.1:3000'` → `'127.0.0.1'`, `'[::1]:3000'` → `'::1'`, `'exemple.com'`
 * inchangé). Une IPv6 SANS crochets contient déjà plusieurs `:` — on ne retire un
 * `:port` final que s'il y a EXACTEMENT UN `:` dans la chaîne (IPv4/hostname).
 */
function stripPort(host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }
  const colonCount = (trimmed.match(/:/g) || []).length
  return colonCount === 1 ? trimmed.slice(0, trimmed.indexOf(':')) : trimmed
}

/**
 * Décode une adresse IPv4-mappée-IPv6 sous SA FORME HEX COMPRESSÉE
 * (`::ffff:HHHH:HHHH`) — celle RÉELLEMENT produite par `new URL().host`
 * (`new URL('http://[::ffff:169.254.169.254]/').host` → `'[::ffff:a9fe:a9fe]'`,
 * jamais la forme dotted-decimal `::ffff:a.b.c.d`). Retourne l'IPv4
 * dotted-decimal équivalente, ou `null` si `host` n'a pas cette forme.
 */
function decodeV4MappedHex(host: string): string | null {
  const m = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!m) return null
  const g1 = parseInt(m[1], 16)
  const g2 = parseInt(m[2], 16)
  return `${(g1 >> 8) & 0xff}.${g1 & 0xff}.${(g2 >> 8) & 0xff}.${g2 & 0xff}`
}

/**
 * Défense en profondeur SSRF — vrai si `hostWithPort` (Host HTTP brut, port
 * optionnel) désigne une cible RÉSEAU INTERNE (privée/loopback/lien-local) qui ne
 * doit JAMAIS recevoir de requête sortante déclenchée par un rendu, MÊME quand la
 * config l'autorise explicitement (allowlist trop large, faute de frappe, origine
 * fixe mal configurée…) — appelée AVANT toute requête sortante réelle, aux DEUX
 * points de consommation (renderToString.ts : `new Window({url})` ; render-browser.ts
 * : `slot.forwardBox.current`/le fetch du proxy).
 *
 * Plages couvertes : `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (privées
 * RFC 1918) ; `127.0.0.0/8` (loopback) ; `169.254.0.0/16` (lien-local — INCLUT les
 * métadonnées cloud `169.254.169.254`) ; `0.0.0.0/8` ; `::1`/`::` (loopback/non
 * spécifiée IPv6) ; `fc00::/7` (ULA) ; `fe80::/10` (lien-local IPv6) ; adresses
 * IPv4-mappées, forme HEX `::ffff:HHHH:HHHH` COMME dotted-decimal
 * `::ffff:a.b.c.d` (les deux décodées puis re-testées comme IPv4 — seule la
 * forme HEX est réellement produite par `new URL().host`, la dotted-decimal
 * est gardée en ceinture-bretelles) ; l'hôte littéral `localhost`/`*.localhost`
 * (RFC 6761, résout en loopback).
 *
 * Hors périmètre, VOLONTAIREMENT : un NOM d'hôte (pas un littéral IP) qui
 * résoudrait en interne via DNS (rebinding). Aucune résolution DNS n'est faite ici
 * (fonction pure, sans I/O) — se combine avec l'allowlist (`trustedHosts`), qui
 * borne déjà les noms d'hôte acceptés à une liste choisie par le dev.
 */
export function isBlockedForwardTarget(hostWithPort: string): boolean {
  const host = stripPort(hostWithPort).toLowerCase().replace(/\.$/, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true

  // canonicalisation VIA LE PARSEUR (WHATWG) : une IPv4 non canonique
  // (décimal pur `2130706433`, hexadécimal `0x7f000001`, octal `0177.0.0.1`, notation courte
  // `127.1`) DÉSIGNE une IP réelle pour `new URL()` mais ne matchait pas la regex dotted-decimal
  // ci-dessous — non bloquée. On range `host` dans sa forme standard avant le test des plages ;
  // un hôte que le parseur REFUSE (espace, forme invalide) est bloqué par prudence.
  let canon: string
  try {
    canon = new URL('http://' + (host.includes(':') ? '[' + host + ']' : host) + '/').hostname.replace(/^\[|\]$/g, '')
  } catch { return true }

  const v4 = canon.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const parts = v4.slice(1).map(Number)
    if (parts.some((p) => p > 255)) return true   // IP malformée → refus par prudence
    const [a, b] = parts
    if (a === 127) return true                    // 127.0.0.0/8 — loopback
    if (a === 10) return true                      // 10.0.0.0/8 — privé
    if (a === 172 && b >= 16 && b <= 31) return true   // 172.16.0.0/12 — privé
    if (a === 192 && b === 168) return true         // 192.168.0.0/16 — privé
    if (a === 169 && b === 254) return true         // 169.254.0.0/16 — lien-local + métadonnées cloud
    if (a === 100 && b >= 64 && b <= 127) return true   // 100.64.0.0/10 — espace partagé CGNAT
    if (a >= 224) return true                        // 224.0.0.0/4 + 240.0.0.0/4 — multidiffusion/réservé/diffusion
    if (a === 0) return true                        // 0.0.0.0/8 — « cette machine »
    return false
  }

  if (canon.includes(':')) {
    if (canon === '::1' || canon === '::') return true          // loopback / non spécifiée
    if (canon.startsWith('::ffff:')) {
      const hex = decodeV4MappedHex(canon)   // forme HEX réelle de new URL().host
      if (hex) return isBlockedForwardTarget(hex)
      return isBlockedForwardTarget(canon.slice('::ffff:'.length))   // forme dotted-decimal — ceinture-bretelles
    }
    if (/^fe[89ab][0-9a-f]:/.test(canon)) return true           // fe80::/10 — lien-local
    if (/^f[cd][0-9a-f]{2}:/.test(canon)) return true           // fc00::/7 — ULA
    return false
  }

  return false   // nom d'hôte (pas un littéral IP) — hors périmètre, cf. JSDoc
}

/**
 * Résout `render.forwardOrigin` pour UNE requête entrante — logique PURE, sans
 * réseau (cf. tests/render-forward-origin.test.ts). Retourne `{}` (aucun
 * forwarding) dès que la config/l'entrée ne satisfait pas le nouveau contrat
 * SÉCURISÉ (cf. en-tête de fichier) — les appelants (render-request.ts) et les
 * moteurs de rendu (renderToString.ts/render-browser.ts) retombent alors sur leur
 * origine locale câblée en dur, jamais sur une valeur fournie par le client.
 */
export function computeForwardedOrigin(
  render: RenderConfig | undefined,
  pathname: string,
  headers: Record<string, string | string[] | undefined>,
): { forwardedUrl?: string; forwardedCookie?: string } {
  const cfg = render?.forwardOrigin
  if (cfg === false) return {}
  const first = (v: string | string[] | undefined): string | undefined => Array.isArray(v) ? v[0] : v
  const cookie = first(headers['cookie'])
  const cookieOut = cookie ? { forwardedCookie: cookie } : {}

  // Origine FIXE imposée par le dev : JAMAIS dérivée du Host entrant.
  if (typeof cfg === 'string') {
    let originHost: string
    try { originHost = new URL(cfg).host } catch { return {} }   // config invalide → repli sûr
    if (isBlockedForwardTarget(originHost)) return {}   // défense en profondeur, même config dev
    return { forwardedUrl: cfg.replace(/\/+$/, '') + pathname, ...cookieOut }
  }

  // Allowlist d'hôtes de confiance : seul un Host ENTRANT qui y figure EXACTEMENT
  // autorise le forwarding — tout le reste retombe sur le défaut sûr plus bas.
  //
  // DEUX trous ici avant ce fix. 1) `proto` (X-Forwarded-Proto)
  // venait du CLIENT sans validation : `X-Forwarded-Proto: http://attaquant.example/?` combiné à
  // un Host autorisé composait `http://attaquant.example/?://hote-autorise/chemin`, et
  // `new URL(...)` y lit l'hôte attaquant.example (le garde des consommateurs ne bloque que les
  // IP internes, une cible EXTERNE passait). 2) un `Host: hote.example:80@attaquant.example`
  // franchissait `stripPort` (un seul `:` requis) sous la forme `hote.example`, listée dans
  // l'allowlist — puis l'URL composée pointait attaquant.example via la syntaxe userinfo
  // (`user:pass@hote`). Fix : `proto` restreint à http/https, `Host` restreint à un format
  // hôte/IPv6 sans userinfo ni espace, et ceinture finale sur l'URL composée.
  if (cfg && typeof cfg === 'object' && Array.isArray((cfg as any).trustedHosts)) {
    const host = first(headers['host'])
    if (!host) return {}
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) && !/^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(host)) return {}   // forme de Host suspecte (userinfo, espace…) → repli sûr
    const bareHost = stripPort(host).toLowerCase()
    const trustedHosts = (cfg as any).trustedHosts as string[]
    if (!trustedHosts.some((h) => h.toLowerCase() === bareHost)) return {}   // Host non autorisé → repli sûr
    if (isBlockedForwardTarget(host)) return {}   // défense en profondeur — IP interne refusée même listée
    const rawProto = (first(headers['x-forwarded-proto']) || '').trim().toLowerCase()
    const proto = rawProto === 'http' || rawProto === 'https' ? rawProto : 'http'   // jamais le schéma brut du client
    const forwardedUrl = `${proto}://${host}${pathname}`
    try {
      const u = new URL(forwardedUrl)
      if (u.username || u.password) return {}   // syntaxe userinfo (user:pass@hote) → jamais fiable
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return {}
      if (stripPort(u.host) !== bareHost) return {}   // l'URL composée doit viser EXACTEMENT le Host validé
    } catch { return {} }   // URL non composable (port hors bornes…) → repli sûr
    return { forwardedUrl, ...cookieOut }
  }

  // Défaut SÛR (rien configuré, ou `true` explicite — CE N'EST PAS une
  // autorisation d'hôte) : aucune dérivation depuis Host/X-Forwarded-*.
  return {}
}
