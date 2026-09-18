// server/hmr — WebSocket HMR (Hot Module Replacement) en mode dev.
//
// Architecture minimale :
//   - Server WebSocket sur le même HTTP server que StaticServer (upgrade)
//   - Le bundler appelle `hmr.notifyReload(filePath)` après une recompile
//   - Le client (script injecté) écoute et :
//      * reload module entier si .js bundle ou .mjs
//      * patch le shadow CSS si .css (zéro flicker)
//      * fallback location.reload() en dernier recours
//
// Le diff est fait côté bundler (CompileStats.cssOnly) —
// un changement 100 % CSS passe par 'css-update' (hot-swap µ._hotCss, sans
// reload), tout le reste garde le reload complet.

import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { CssOnlyPayload } from '../bundler/index.js'
import { t } from '../messages/index.js'

export interface HMRMessage {
  type: 'reload' | 'css-update' | 'connected' | 'error'
  modules?: string[]
  message?: string
  /** Charge d'un `css-update` : CSS frais par composant/feuille
   * (cf. CssOnlyPayload, bundler). Consommée côté page par `µ._hotCss`. */
  css?: CssOnlyPayload
}

// Ni ce serveur WebSocket HMR
// (connexion ouverte sans vérifier `Origin`) ni le serveur statique
// (`index.ts`, `Access-Control-Allow-Origin: *` inconditionnel) ne
// restreignaient l'origine des appelants. En dev, ces serveurs tournent sur
// `127.0.0.1` — un navigateur N'APPLIQUE PAS la same-origin policy au
// HANDSHAKE WebSocket lui-même (contrairement à fetch/XHR, où le CORS
// bloque la LECTURE de la réponse mais laisse partir la requête), donc
// N'IMPORTE QUEL site web ouvert dans le même navigateur peut se connecter à
// `ws://127.0.0.1:PORT/__mjs_hmr` — et via DNS rebinding (le domaine d'une
// page attaquante résout d'abord ailleurs pour passer une vérification
// quelconque, puis bascule vers 127.0.0.1 avec un TTL DNS très court), même
// une vérification naïve de `Origin` côté client ne protège pas : c'est au
// SERVEUR de refuser les origines non locales. Borné au dev (`mjs dev`
// uniquement), mais un principe de moindre privilège de base. Fix : n'accepter
// que les origines localhost/127.0.0.1/[::1] (avec port variable — le
// dashboard/l'app peuvent tourner sur un port différent du serveur HMR).
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

/** true si `origin` est une origine locale de confiance (ou absente — CLI/curl, pas un navigateur). */
export function isTrustedDevOrigin(origin: string | string[] | undefined): boolean {
  if (origin === undefined) return true   // pas de navigateur (curl, requête serveur-à-serveur en dev)
  const v = Array.isArray(origin) ? origin[0] : origin
  return LOCAL_ORIGIN_RE.test(v)
}

export class HMRServer {
  wss: WebSocketServer
  clients: Set<WebSocket>

  constructor(httpServer: HttpServer, opts: { path?: string } = {}) {
    this.wss = new WebSocketServer({
      server: httpServer,
      path: opts.path ?? '/__mjs_hmr',
    })
    this.clients = new Set()

    this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      if (!isTrustedDevOrigin(request.headers.origin)) {
        ws.close(1008, 'Origin not allowed')
        return
      }
      this.clients.add(ws)
      this.send(ws, { type: 'connected' })
      ws.on('close', () => this.clients.delete(ws))
      ws.on('error', () => this.clients.delete(ws))
    })
  }

  notifyReload(modules: string[] = []): void {
    this.broadcast({ type: 'reload', modules })
  }

  // Rechargement CSS à chaud : un recompile où SEUL le CSS a changé
  // (cf. bundler `CompileStats.cssOnly`) diffuse le CSS frais lui-même, le
  // client le pose EN PLACE (µ._hotCss) sans reload — l'état de la page survit.
  notifyCssUpdate(css: CssOnlyPayload): void {
    this.broadcast({ type: 'css-update', css })
  }

  notifyError(message: string): void {
    this.broadcast({ type: 'error', message })
  }

  close(): void {
    for (const ws of this.clients) ws.close()
    this.wss.close()
  }

  private send(ws: WebSocket, msg: HMRMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  private broadcast(msg: HMRMessage): void {
    const payload = JSON.stringify(msg)
    // Un `ws.send` qui throw
    // (socket à demi fermée, buffer plein…) interrompait la boucle et privait
    // TOUS les clients suivants de la notification. try/catch par client +
    // retrait du client fautif (la suppression pendant l'itération d'un Set
    // est sûre en JS) : la diffusion continue quoi qu'il arrive.
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      try { ws.send(payload) }
      catch { this.clients.delete(ws) }
    }
  }
}

// ----------------------------------------------------------------------------
// Client snippet : à injecter dans la page de dev. Écoute le WS et :
//   - 'reload'      → location.reload()
//   - 'css-update'  → hot-swap du CSS composants/feuilles via µ._hotCss
//                     (sans reload ni perte d'état ; repli
//                     location.reload() si le swap n'est pas sûr) + force
//                     re-fetch des <link rel=stylesheet>
//   - 'error'       → affiche un overlay plein écran avec le message
//   - 'reload' suivant un error → cache l'overlay
// ----------------------------------------------------------------------------
export const hmrClientSnippet = (wsUrl: string) => `
(() => {
  const OVERLAY_ID = '__mjs_hmr_overlay'
  const STYLE_ID = '__mjs_hmr_style'

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = \`
      .__mjs_hmr_overlay {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(20, 20, 28, 0.95);
        color: #fbb;
        font: 14px/1.5 ui-monospace, monospace;
        padding: 32px;
        overflow: auto;
        white-space: pre-wrap;
      }
    \`
    document.head.appendChild(s)
  }

  const showError = (msg) => {
    ensureStyle()
    let div = document.getElementById(OVERLAY_ID)
    if (!div) {
      div = document.createElement('div')
      div.id = OVERLAY_ID
      div.className = '__mjs_hmr_overlay'
      document.body.appendChild(div)
    }
    div.textContent = ${JSON.stringify(t('server.hmr-compilation-echouee'))} + '\\n\\n' + msg
  }

  const hideError = () => {
    const div = document.getElementById(OVERLAY_ID)
    if (div) div.remove()
  }

  let retries = 0
  const connect = () => {
    const ws = new WebSocket('${wsUrl}')
    ws.addEventListener('open', () => {
      retries = 0
      console.log(${JSON.stringify(t('server.hmr-connecte'))})
    })
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'reload')      { hideError(); location.reload() }
        if (msg.type === 'css-update')  {
          hideError()
          // Hot-swap du CSS des composants/feuilles partagées via le runtime
          // (µ._hotCss, mjs_hotcss.ts — dev seulement, ABSENT d'un bundle de
          // production). Retour \`false\` = swap PAS sûr (composant jamais
          // chargé, feuille partagée entre tags divergents…) → repli reload
          // complet, au moindre doute. MÊME repli si la fonction est ABSENTE
          // (\`window.µ\` présent mais sans \`_hotCss\`, ex. bundle de prod servi
          // par erreur sous \`mjs dev\`) : avant, \`ok\` restait à sa valeur
          // initiale \`true\` (le \`if (hot)\` ne s'exécutait juste pas), le
          // remplacement de CSS devenait inerte EN SILENCE au lieu de
          // recharger. µ absent (page sans runtime) reste le seul cas où on
          // NE recharge PAS : rien à échanger, le re-fetch des <link> suffit.
          // >>> extrait-test hmr-hotcss-fallback
          let ok = true
          try {
            if (window.µ) ok = typeof window.µ._hotCss === 'function' && window.µ._hotCss.call(window.µ, msg.css || {}) !== false
          } catch { ok = false }
          if (!ok) { location.reload(); return }
          // <<< extrait-test hmr-hotcss-fallback
          for (const link of document.querySelectorAll('link[rel=stylesheet]')) {
            const u = new URL(link.href)
            u.searchParams.set('_hmr', Date.now().toString())
            link.href = u.toString()
          }
        }
        if (msg.type === 'error')       { showError(msg.message || ${JSON.stringify(t('server.hmr-aucun-message'))}) }
      } catch {}
    })
    ws.addEventListener('close', () => {
      retries++
      const wait = Math.min(retries * 500, 5000)
      console.warn(${JSON.stringify(t('server.hmr-deconnecte'))}.replace('{wait}', wait))
      setTimeout(connect, wait)
    })
  }
  connect()
})()
`.trim()
