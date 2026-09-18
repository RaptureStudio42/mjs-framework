// mjs-ws/watchdog — LE CHIEN DE GARDE systemd, étage 1 de la supervision. `Restart=always`
// relève un process MORT ; il ne voit RIEN d'un process VIVANT MAIS GELÉ — boucle d'événements bloquée
// par un calcul sans fin, ou `kill -STOP`. Le battement ci-dessous vit DANS la boucle d'événements
// (`setInterval`) : s'il cesse, c'est que la boucle est morte, et systemd le sait au bout de
// `WatchdogSec` — sans qu'aucune sonde extérieure n'ait à s'en apercevoir.
//
// AUCUNE DÉPENDANCE, ET C'EST LA PARTIE INTÉRESSANTE. `NOTIFY_SOCKET` est une socket unix de type
// DATAGRAMME, et node ne sait pas en ouvrir : `dgram.createSocket('unix_dgram')` rend
// `ERR_SOCKET_BAD_TYPE` (mesuré sur node 22 ET 24), `net` ne fait que du flux, et il n'y a
// pas de FFI. Le seul chemin sans module natif est donc `systemd-notify`, un binaire de 18 Ko livré
// avec systemd, qui lit `NOTIFY_SOCKET` dans SON environnement — hérité du nôtre — et écrit le
// datagramme à notre place. Un fork toutes les `WatchdogSec/2` secondes : 5 760 par jour à 30 s de
// fenêtre, invisible au compteur.
//
// ⚠️ `NotifyAccess=all` EST OBLIGATOIRE DANS L'UNITÉ, et ce n'est pas un réglage de confort : avec le
// défaut (`main`), systemd REFUSE le message d'un process enfant — et le chien de garde tue alors un
// service parfaitement SAIN toutes les `WatchdogSec` secondes. Éprouvé dans les DEUX SENS,
// sur systemd 259 (poste) et 252 (serveur) : avec `all` le pid ne bouge pas de trois fenêtres, avec
// `main` le service est relancé à la première. C'est écrit ici parce que la ligne manquante ne se
// remarque pas — elle transforme le gardien en bourreau.
//
// ⚠️ `LimitCORE=0` AUSSI, POUR UNE AUTRE RAISON. Le signal du chien de garde est `SIGABRT` par défaut
// — le bon choix, c'est le seul qui traverse une boucle bloquée (un `SIGTERM` que l'application a
// pris en charge par `process.on` n'est plus jamais traité quand la boucle est morte : systemd doit
// alors attendre `TimeoutStopSec` puis tuer au `SIGKILL`). Mais `SIGABRT` vide la mémoire du process
// sur le disque : mesuré sur le serveur, un moteur de 120 Mio écrit un fichier `core` de 12 Mo dans
// son `WorkingDirectory` — c'est-à-dire dans la racine de l'application — à CHAQUE gel. `LimitCORE=0`
// et le noyau n'écrit rien du tout (les deux sens mesurés).

import { spawn as spawnReel } from 'node:child_process'
import type { MjsWsLogFn } from './core.js'
import { t } from '../messages/index.js'

/** ce que les tests injectent à la place du vrai monde — jamais renseigné en production. */
export interface MjsWsWatchdogDeps {
  spawn?:   typeof spawnReel
  env?:     NodeJS.ProcessEnv
  pid?:     number
  quitter?: (code: number) => void
}

export interface MjsWsWatchdogHandle { stop(): void }

const NOTIFIER = 'systemd-notify'

/** arme le battement, ou rend `null` quand personne ne le réclame (poste de développement, unité sans
 *  `WatchdogSec`) — l'appelant n'a rien à tester, `null` veut dire « il n'y avait rien à faire ». */
export function armWatchdog(log: MjsWsLogFn, deps: MjsWsWatchdogDeps = {}): MjsWsWatchdogHandle | null
{
  const spawn   = deps.spawn   ?? spawnReel
  const env     = deps.env     ?? process.env
  const pid     = deps.pid     ?? process.pid
  const quitter = deps.quitter ?? ((code: number) => process.exit(code))

  const usec = Number.parseInt(env.WATCHDOG_USEC || '0', 10)
  if (!Number.isFinite(usec) || usec <= 0) return null
  // systemd pose `WATCHDOG_PID` à côté de `WATCHDOG_USEC` : le battement n'est attendu QUE de ce
  // process. Un enfant qui hérite de l'environnement et rebattrait tiendrait le chien en laisse à la
  // place de son père — un père déjà gelé (contrat sd_watchdog_enabled). Absent = on bat.
  if (env.WATCHDOG_PID && env.WATCHDOG_PID !== String(pid)) return null

  // la moitié de la fenêtre, jamais moins d'une seconde : c'est la marge que recommande systemd, et
  // elle laisse passer un ralentissement sans réveiller le chien
  const periode = Math.max(1000, Math.floor(usec / 2000))
  let vivant    = true

  // LE PREMIER BATTEMENT EST VÉRIFIÉ, LES SUIVANTS NON, ET C'EST DÉLIBÉRÉ. Si `systemd-notify` est
  // introuvable ou refusé, le service serait tué toutes les `WatchdogSec` secondes sans qu'une seule
  // ligne ne dise pourquoi — la panne muette exacte qu'il s'agit d'empêcher ici. On échoue
  // donc TOUT DE SUITE, en nommant la cause : un démarrage qui s'arrête net est lisible, un service
  // abattu en boucle ne l'est pas. Ensuite, un échec ponctuel ne prouve rien et le chien tranchera.
  function battre(premier: boolean): void {
    const enfant = spawn(NOTIFIER, ['WATCHDOG=1'], { stdio: 'ignore' })
    enfant.on('error', (err: Error) => { if (premier) echouer(t('ws.watchdog.notifier-introuvable', { notifier: NOTIFIER }), err) })
    enfant.on('exit', (code: number | null) => { if (premier && code !== 0) echouer(t('ws.watchdog.notifier-refuse', { notifier: NOTIFIER, code: String(code) })) })
  }

  function echouer(message: string, err?: Error): void {
    if (!vivant) return
    vivant = false
    clearInterval(minuterie)
    log('error', message, err)
    quitter(1)
  }

  battre(true)
  const minuterie = setInterval(() => battre(false), periode)
  // `unref` : le battement ne doit pas EMPÊCHER le process de finir. C'est l'écoute du transport qui
  // tient la boucle en vie — même choix que l'éviction périodique des salons.
  minuterie.unref()
  log('info', t('ws.watchdog.arme', { periode: String(periode), fenetre: String(Math.floor(usec / 1000)) }))

  return { stop() { vivant = false; clearInterval(minuterie) } }
}
