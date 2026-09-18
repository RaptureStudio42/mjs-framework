// mjs-ws/packages — paquets ACTIVABLES : regrouper les briques en paquets qui marchent
// ensemble. Symétrique CÔTÉ SERVEUR des
// préréglages `runtime` déjà livrés côté CLIENT (mjs.config.json, cf. bundler/config.ts) : LÀ, on
// choisit quelles briques du CORE embarquer dans le bundle ; ICI, on active des briques SERVEUR
// cohérentes au-dessus de `mjsWs()`/`mjsServer()`, composées SUR l'API PUBLIQUE (app.serve/on/
// room/stream/schema…) — jamais par accès à l'interne de core.ts.
//
// Ce fichier pose l'INTERFACE + `app.use` (branché dans core.ts) + UN exemple de référence
// (paquetEcho) qui PROUVE le contrat. Les paquets applicatifs (chat, comptes, lobby)
// vivent chacun dans leur propre fichier, composés de la MÊME façon — jamais de
// logique dupliquée ici.

import type { MjsWsApp } from './core.js'

/**
 * Contrat d'un paquet serveur. `nom` l'identifie pour `app.use` (double installation du MÊME
 * nom = warn, ignorée — cf. son commentaire dans core.ts) ; `installer` enregistre ses handlers/
 * conventions sur l'app REÇUE. SYNCHRONE — l'enregistrement de handlers via app.serve/app.on est
 * lui-même synchrone, comme tout le reste de l'API MJS-WS avant `.listen()`. Une init ASYNCHRONE
 * éventuelle d'un futur paquet (ex. connexion à une base au démarrage) se branchera sur
 * `app.listen()` côté appli hôte (ou un hook dédié à inventer le jour venu) — PAS ici :
 * `installer` reste un simple enregistrement, jamais un boot.
 */
export interface MjsPackage {
  nom: string
  installer(app: MjsWsApp): void
}

/** fabrique ergonomique — `definirPaquet('nom', app => { ... })` ≡ littéral `{ nom, installer }`. */
export function definePackage(nom: string, installer: (app: MjsWsApp) => void): MjsPackage {
  return { nom, installer }
}

// --- exemple de RÉFÉRENCE ---------------------------------------------------------------------
// paquetEcho — exemple/patron pour les futurs paquets (chat/comptes/lobby) : PROUVE l'interface
// (un paquet enregistre un handler via app.serve, `app.use` le branche) sans rien décider côté
// jeu/métier. 'echo' renvoie sa charge telle quelle — trivial par construction, jamais destiné à
// un usage réel au-delà de la démonstration/du test du mécanisme lui-même.
export function echoPackage(): MjsPackage {
  return definePackage('echo', app => {
    app.serve('echo', p => p)
  })
}
