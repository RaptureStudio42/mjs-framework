// action-pipeline — pipeline PARTAGÉ des verbes MUTANTS (`.server.mjs` actions), consommé à
// l'identique par `mjs serve` (render-server.ts) et `mjs dev` (server/index.ts). Vivait
// jusque-là dupliqué dans render-server.ts seul ; sorti ici pour que les deux modes restent
// alignés PAR CONSTRUCTION — un correctif posé ici vaut pour les deux serveurs, jamais un copier-
// coller à refaire deux fois.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MjsConfig, RenderConfig } from '../bundler/config.js'
import type { ServeEntry } from './serve-entry.js'
import { isPlainObject } from './serve-entry.js'
import { resolvePage } from './render-routes.js'
import type { RecordServerFn } from './journal.js'
import { readBuildVersion } from './build-version.js'
import { t } from '../messages/index.js'

// verbes MUTANTS acceptés par la branche formulaire plus bas (POST historique + PUT/PATCH/
// DELETE, décision produit actée : mêmes garde origin/content-type/plafond/action/303/422 pour les 4).
export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// target/method/cache (config.render) : posés dans la fiche SEULEMENT si configurés,
// disent au client QUEL contenant remplacer (sélecteur CSS), COMMENT le module s'y installe, et
// COMBIEN DE TEMPS la page qui arrive reste digne de confiance en cache (µ.pageCache côté client).
export function navExtras(render: RenderConfig | undefined): { target?: string, method?: 'update' | 'replace' | 'append', cache?: 'cache-first' | 'revalidate' | 'no-cache' } {
  const extras: { target?: string, method?: 'update' | 'replace' | 'append', cache?: 'cache-first' | 'revalidate' | 'no-cache' } = {}
  if (render?.target) extras.target = render.target
  if (render?.method) extras.method = render.method
  if (render?.cache) extras.cache = render.cache
  return extras
}

// multipart/form-data : découpe binaire-sûre sur --<boundary> (Buffer.indexOf) ; seuls les
// champs TEXTE alimentent `body` — une partie FICHIER (attribut filename présent, même vide) est
// ignorée + avertie une fois (l'exploitation des fichiers reste à faire plus tard, hors périmètre
// ici). Une partie sans name exploitable est ignorée en silence. Retourne null si le boundary
// n'apparaît nulle part dans le corps (multipart malformé) ; {} reste un résultat VALIDE (aucun champ
// texte, ex. un formulaire 100 % fichiers).
// CORRECTIF — RFC 2046 : une frontière n'est JAMAIS que
// `CRLF--boundary` ; un indexOf brut de `--boundary` (sans le CRLF devant) prenait pour une frontière
// une occurrence FORTUITE de cette même suite d'octets en PLEIN MILIEU de la valeur d'un champ texte
// (ex. valeur `ok--<boundary>trap`) — troncature silencieuse de la valeur. Seule
// la recherche du délimiteur SUIVANT (`next`, à l'intérieur de la boucle) est concernée : la toute
// première occurrence (ouverture, avant la boucle) reste un indexOf brut, un préambule avant elle
// n'étant pas garanti se terminer par CRLF (cas dégénéré, hors périmètre).
// (CWE-1321) — `__proto__` atteint le SETTER hérité d'Object.prototype (Annex B) sur
// `body[champ] = v` : comme la valeur est toujours une chaîne, c'est un no-op PAR SPEC (aucune
// pollution réelle), mais la valeur soumise est perdue SANS AUCUNE TRACE. `constructor`/`prototype`
// n'ont pas ce problème de setter (propriétés de données normales) mais écraseraient une clé sans
// avertir non plus. Refus explicite des 3, même garde que `µ._mjs_guardPath`/`µ._mjs_safeKey`
// (runtime/mjs_init.ts:559-576).
function isUnsafeFieldName(champ: string): boolean {
  return champ === '__proto__' || champ === 'constructor' || champ === 'prototype'
}

function parseMultipart(buffer: Buffer, boundary: string, pathname: string): Record<string, string> | null {
  const delim = Buffer.from('--' + boundary)
  const delimAfterCrlf = Buffer.from('\r\n--' + boundary)
  let pos = buffer.indexOf(delim)
  if (pos === -1) return null
  const body: Record<string, string> = {}
  const champsAvertis = new Set<string>()   // un seul console.error par champ, pas un par partie
  while (true) {
    pos += delim.length
    if (buffer.toString('latin1', pos, pos + 2) === '--') break   // --boundary-- : délimiteur terminal
    const nextCrlf = buffer.indexOf(delimAfterCrlf, pos)
    const next = nextCrlf === -1 ? -1 : nextCrlf + 2   // +2 : repositionne sur le '--' (comme avant), après le CRLF
    const fin = next === -1 ? buffer.length : next
    const headerEnd = buffer.indexOf('\r\n\r\n', pos)
    if (headerEnd !== -1 && headerEnd < fin) {
      const headers = buffer.toString('utf-8', pos, headerEnd)
      const dispo = headers.match(/Content-Disposition\s*:\s*([^\r\n]+)/i)
      if (dispo) {
        const nameMatch = dispo[1].match(/name="([^"]*)"/i)
        if (nameMatch) {
          const champ = nameMatch[1]
          if (/filename="[^"]*"/i.test(dispo[1])) {
            if (!champsAvertis.has(champ)) {
              champsAvertis.add(champ)
              console.error(t('server.form-fichier-ignore', { pathname, champ }))
            }
          } else if (isUnsafeFieldName(champ)) {
            // nom réservé (cf. isUnsafeFieldName) : refusé + tracé, jamais absorbé en silence.
            if (!champsAvertis.has(champ)) {
              champsAvertis.add(champ)
              console.error(t('server.form-champ-reserve-ignore', { pathname, champ }))
            }
          } else {
            // CRLF séparateur juste avant le prochain délimiteur : exclu de la valeur (toléré absent)
            const crlf = buffer.toString('latin1', fin - 2, fin) === '\r\n'
            body[champ] = buffer.toString('utf-8', headerEnd + 4, crlf ? fin - 2 : fin)
          }
        }
      }
    }
    if (next === -1) break
    pos = next
  }
  return body
}

export interface ActionPipelineDeps {
  config: MjsConfig
  entry: ServeEntry
  recordServer: RecordServerFn
  manifestPath: string | null
}

// pipeline partagé entre `mjs serve` (render-server.ts) et `mjs dev` (server/index.ts) :
// gardes origin/content-type/plafond corps, résolution + exécution d'action, interprétation du
// retour (redirect/errors). Retourne false SANS RIEN écrire quand `req.method` n'est pas un verbe
// mutant (l'appelant garde alors la main sur son propre pipeline GET/HEAD) ; retourne toujours true
// dès que le verbe EST mutant — la réponse HTTP est alors intégralement posée ici, quel que soit son
// statut final (aucune action déclarée ⇒ 405, corps refusé ⇒ 413/415/400, origine refusée ⇒ 403,
// action en échec ⇒ 500, retour `{errors}` ⇒ 422, retour `{redirect}` ⇒ 303).
export async function handleMutatingRequest(req: IncomingMessage, res: ServerResponse, pathname: string, reqUrl: string, deps: ActionPipelineDeps): Promise<boolean> {
  if (!req.method || !MUTATING_METHODS.has(req.method)) return false
  const { config, entry, recordServer, manifestPath } = deps

  // a. garde same-origin — décision de sécurité par défaut : Origin ABSENT ne bloque rien
  // (nombreux clients légitimes ne l'envoient pas sur un POST classique) ; PRÉSENT et
  // différent du Host de la requête → 403 (repli sûr contre un formulaire tiers/CSRF).
  // configurable via render.allowedOrigins : `false` coupe le contrôle en entier ;
  // un tableau élargit à ces origines EN PLUS du same-origin (comparaison sur l'origine
  // normalisée protocole://host:port, jamais une sous-chaîne) ; le joker `["*"]` accepte
  // TOUT (forme assumée et documentée, pas une erreur de config) ; une valeur mal typée (ni
  // tableau ni `false`) retombe sur le same-origin strict, silencieusement (repli sûr).
  const origin = req.headers.origin
  if (origin) {
    const allowedOrigins = config.render?.allowedOrigins
    if (allowedOrigins !== false) {
      let sameOrigin = false
      try { sameOrigin = new URL(origin).host === (req.headers.host || '') } catch { sameOrigin = false }
      let allowed = sameOrigin
      if (!allowed && Array.isArray(allowedOrigins)) {
        // joker : `["*"]` = TOUTE origine acceptee (equivalent assume de `allowedOrigins: false`,
        // ecrit en liste blanche ; garde-fou : un `*` colle a autre chose ("*.exemple.fr") n'est
        // PAS un motif, il retombe dans la comparaison d'origine ci-dessous et ne matchera jamais)
        if (allowedOrigins.includes('*')) allowed = true
        else {
          let originOrigin = ''
          try { originOrigin = new URL(origin).origin } catch { originOrigin = '' }
          allowed = originOrigin !== '' && allowedOrigins.some((o) => { try { return new URL(o).origin === originOrigin } catch { return false } })
        }
      }
      if (!allowed) { res.statusCode = 403; res.end('Forbidden'); return true }
    }
  }

  // b. content-type attendu — SEULEMENT si un corps est réellement présent : un verbe qui
  // part sans corps ni Content-Type (DELETE, cf. commentaire de branche ci-dessus) n'a pas à
  // subir le 415, ses paramètres-corps restent vides (même lecture qu'un corps urlencoded
  // vide, cf. c/d plus bas) — le 415 ne vaut que pour un corps PRÉSENT d'un type inattendu.
  // `req.headers['content-type'] || ''` confondait en-tête ABSENT et
  // en-tête PRÉSENT-MAIS-VIDE (`Content-Type:` sans valeur) : les deux s'écrasaient sur la
  // même chaîne '', donc un Content-Type explicitement vide contournait le 415 alors que
  // rien n'a jamais décidé de tolérer CE cas précis (seule l'absence totale est voulue,
  // cf. commentaire ci-dessus) — sonde brute (raw socket) : PUT Content-Type:<vide> + corps
  // urlencoded passait tel quel (303, corps parsé) avant ce correctif. `undefined` explicite
  // restaure la distinction ; l'absence totale (DELETE sans Content-Type) reste inchangée.
  const contentType = req.headers['content-type']
  if (contentType !== undefined && !contentType.startsWith('application/x-www-form-urlencoded') && !contentType.startsWith('multipart/form-data')) {
    res.statusCode = 415; res.end('Unsupported Media Type'); return true
  }

  // action déclarée pour ce pathname, vérifiée ICI (AVANT la lecture du corps) :
  // sans elle, un verbe mutant SANS action bufferisait jusqu'à 1 Mo pour finir en 405 —
  // travail perdu, et pire, un corps hostile >1 Mo y gagnait à tort un 413 (cf. c plus bas).
  const actionMatch = entry.actionFor(pathname)
  if (!actionMatch) {
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD')
    res.end('Method Not Allowed')
    return true
  }

  // c. corps plafonné à 1 Mo — au-delà : 413, lecture arrêtée (jamais de buffer illimité
  // en mémoire sur un corps hostile), connexion fermée proprement.
  const chunks: Buffer[] = []
  let total = 0
  let rejected = false
  await new Promise<void>((done) => {
    req.on('data', (chunk: Buffer) => {
      if (rejected) return
      total += chunk.length
      if (total > 1_048_576) {
        rejected = true
        res.statusCode = 413
        res.setHeader('Connection', 'close')
        res.end('Payload Too Large')
        req.destroy()
        done(); return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done())
    req.on('error', () => done())
  })
  if (rejected) return true

  // d. parse — multipart (champs texte seulement) ou urlencoded ; dernière valeur gagne
  // (URLSearchParams itère dans l'ordre d'insertion, parseMultipart dans l'ordre d'apparition).
  const body: Record<string, string> = {}
  if (contentType && contentType.startsWith('multipart/form-data')) {
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]*)"|([^;]+))/i)
    const boundary = (boundaryMatch ? (boundaryMatch[1] ?? boundaryMatch[2]) : '').trim()
    if (!boundary) { res.statusCode = 400; res.end('Bad Request'); return true }
    const champs = parseMultipart(Buffer.concat(chunks), boundary, pathname)
    if (!champs) { res.statusCode = 400; res.end('Bad Request'); return true }
    Object.assign(body, champs)
  } else {
    for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf-8'))) {
      // même garde que parseMultipart (cf. isUnsafeFieldName) : nom réservé refusé + tracé.
      if (isUnsafeFieldName(k)) { console.error(t('server.form-champ-reserve-ignore', { pathname, champ: k })); continue }
      body[k] = v
    }
  }

  // e. page déclarée pour ce pathname (component pour la réponse JSON, cf. serve-entry.ts).
  const page = resolvePage(pathname, config.render, null)

  // f. exécution — le SENS du retour est interprété ICI (l'action elle-même ne fait que
  // router vers la bonne fonction, cf. serve-entry.ts).
  let resultat: unknown
  try {
    resultat = await actionMatch.fn(actionMatch.params, body, req)
  } catch (e: any) {
    console.error(t('server.action-exception', { pathname, erreur: e && e.message ? e.message : String(e) }))
    // (point 2 de capture).
    recordServer({ message: e && e.message ? e.message : String(e), pile: e && e.stack, url: pathname })
    res.statusCode = 500; res.end('Internal Server Error'); return true
  }
  if (isPlainObject(resultat) && 'redirect' in resultat) {
    const cible = (resultat as any).redirect
    // cible INTERNE seulement : `//evil.example` et `/\evil` commencent par `/` mais sont
    // lus comme des URL protocole-relatives par le navigateur → open redirect (sonde).
    // `/\t/evil.example` (tabulation) passait CETTE garde : Node envoie
    // l'en-tête Location tel quel, mais le navigateur RETIRE les tabulations/sauts de ligne en
    // analysant l'URL → `//evil.example` → même redirection externe. Refus de tout caractère
    // de contrôle en plus.
    if (typeof cible === 'string' && cible.startsWith('/') && cible[1] !== '/' && cible[1] !== '\\' && !/[\x00-\x1f\x7f]/.test(cible)) {
      res.statusCode = 303
      res.setHeader('Location', cible)
      res.end()
      return true
    }
    console.error(t('server.form-cible-invalide', { pathname, cible: String(cible) }))
    res.statusCode = 500; res.end('Internal Server Error'); return true
  }
  if (isPlainObject(resultat) && isPlainObject((resultat as any).errors)) {
    const version = readBuildVersion(manifestPath)
    const propsRechargees = page ? await entry.propsFor(pathname, req).catch(() => ({})) : {}
    res.statusCode = 422
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Vary', 'X-MJS-Nav')
    if (version) res.setHeader('X-MJS-Version', version)
    // title: null — même clé que le protocole nominal, mais un 422 n'est jamais lu comme un titre : le
    // client ne fait qu'un µ._mjs_resSet(props) sur ce chemin (cf. mjs_ujs.ts, branche 422 de µ._mjs_navDispatch),
    // aucune installation n'a lieu, donc aucun contact avec document.title.
    res.end(JSON.stringify({ module: page ? page.component : null, props: { ...propsRechargees, errors: (resultat as any).errors }, url: reqUrl, title: null, version, ...navExtras(config.render) }))
    return true
  }
  console.error(t('server.form-resultat-invalide', { pathname }))
  res.statusCode = 500; res.end('Internal Server Error'); return true
}
