// mjs-ws/token — jetons JWT HS256 SANS dépendance (base64url header.payload.signature,
// node:crypto seul) : signToken/verifyToken bas niveau + jwtAuth(secret), une aide prête
// à brancher sur `opts.auth` de mjsWs(). Autonome — n'a besoin d'AUCUNE connaissance du
// pont universel (bridge.ts), réutilisable tel quel même sans lui. Interopérable avec les
// bibliothèques JWT standard (gem jwt Ruby, firebase/php-jwt, pyjwt) : alg HS256 STRICT
// (jamais 'none', faille classique des vérificateurs laxistes), typ JWT, base64url SANS
// padding — format vérifié à la lettre. cf. docs/23-mjs-ws.md pour les recettes par langage.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { MjsWsHelloPayload } from './core.js'
import type { MjsWsRemoteInfo } from './transport.js'

// --- base64url (RFC 4648 §5), SANS padding ------------------------------------------------

function b64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(input: string): Buffer {
  let s = input.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4 !== 0) s += '='
  return Buffer.from(s, 'base64')
}

// comparaison à temps constant sur 2 chaînes base64url — longueur d'abord (timingSafeEqual
// lève sur une longueur différente), jamais un court-circuit sur le contenu
function safeEqualB64(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// --- signature bas niveau ------------------------------------------------------------------

export interface SignTokenOpts {
  /** durée de vie en SECONDES — pose `exp` (iat + ttl) ; absent = jeton sans expiration */
  ttl?: number
}

/** Signe un jeton HS256 — pose `iat` (maintenant, secondes) et `exp` si `ttl` fourni. */
export function signToken(payload: Record<string, unknown>, secret: string, opts: SignTokenOpts = {}): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const iat    = Math.floor(Date.now() / 1000)
  const body: Record<string, unknown> = { ...payload, iat }
  if (opts.ttl != null) body.exp = iat + opts.ttl

  const headerB64    = b64url(Buffer.from(JSON.stringify(header), 'utf8'))
  const payloadB64   = b64url(Buffer.from(JSON.stringify(body), 'utf8'))
  const signingInput = headerB64 +'.'+ payloadB64
  const sigB64        = b64url(createHmac('sha256', secret).update(signingInput).digest())
  return signingInput +'.'+ sigB64
}

/** Vérifie un jeton HS256 — `null` sur tout format/signature/expiration invalide (jamais un throw). */
export function verifyToken(token: string, secret: string): Record<string, unknown> | null {
  if (typeof token !== 'string' || token === '') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts

  let header: any
  try { header = JSON.parse(b64urlDecode(headerB64).toString('utf8')) }
  catch { return null }
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') return null   // jamais 'none' — faille classique

  const expected = b64url(createHmac('sha256', secret).update(headerB64 +'.'+ payloadB64).digest())
  if (!safeEqualB64(expected, sigB64)) return null

  let payload: any
  try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) }
  catch { return null }
  if (payload && typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) >= payload.exp) return null   // expiré
  return payload
}

// --- aide prête pour opts.auth --------------------------------------------------------------

/**
 * `jwtAuth(secret)` → fonction directement branchable sur `opts.auth` de mjsWs() : lit
 * `hello.auth.token` (ou `hello.auth` si c'est DIRECTEMENT une chaîne), vérifie, et pose
 * `client.identity = payload` (avec `id = payload.id ?? payload.sub` — compatible des
 * jetons émis par une gem/lib tierce qui n'utilise que `sub`). Jeton absent/invalide/expiré
 * → `false` (µ:denied côté client, via le mécanisme auth existant de core.ts).
 */
export function jwtAuth(secret: string): (hello: MjsWsHelloPayload, meta: MjsWsRemoteInfo) => unknown {
  return (hello: MjsWsHelloPayload) => {
    const raw   = hello?.auth as unknown
    const token = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw as any).token : undefined)
    if (typeof token !== 'string' || token === '') return false
    const payload = verifyToken(token, secret)
    if (!payload) return false
    const id = (payload as any).id ?? (payload as any).sub
    return { ...payload, id }
  }
}
