// bundler/worker — worker_threads pour parallélisation du `transpile()`.
//
// Le profilage a montré que 66% du temps de compilation est passé dans
// `transpile()` (Civet parser + analyzer + generator). Comme JS est
// single-threaded, `Promise.all` ne donne PAS de parallélisme CPU réel —
// on a besoin de worker_threads.
//
// Architecture :
//   - Master (Bundler) : maintient l'état partagé (cache, mangleCache,
//     manifest, partialDependents). Pour chaque `.mjs` à compiler :
//       1. Pre-résout les `µasset('...')` litéraux (cf. preResolveAssets)
//       2. Submit au pool : `{ type: 'transpile', content, opts, preResolved }`
//       3. Reçoit `{ output, data }` du worker
//       4. Fait resolveMagicAssets (post-compile pour les cas dynamiques)
//       5. Fait minify (séquentiel — mangleCache partagé esbuild)
//       6. Écrit le fichier hashé
//
//   - Worker (ce fichier) : reçoit le message et délègue à `transpileFromMsg`
//     (transpile-msg.ts), partagé avec le chemin « dans le processus principal »
//     que le master emprunte sous le seuil de fichiers — une seule définition de
//     l'appel à `transpile()` et de la projection du TranspileData.
//
// Gain mesuré attendu : ~2.4× sur build prod 474 fichiers (41.5s → ~17s).

import { parentPort } from 'node:worker_threads'
import { transpileFromMsg, type TranspileMsg } from './transpile-msg.js'
import { t } from '../messages/index.js'

if (!parentPort) {
  throw new Error(t('bundler.worker.parent-port-manquant'))
}

parentPort.on('message', async (msg: TranspileMsg) => {
  if (msg.type !== 'transpile') {
    parentPort!.postMessage({
      id: msg.id,
      ok: false,
      error: `Unknown message type: ${(msg as any).type}`,
    })
    return
  }

  try {
    const result = await transpileFromMsg(msg)
    parentPort!.postMessage({ id: msg.id, ok: true, result })
  } catch (e: any) {
    parentPort!.postMessage({
      id: msg.id,
      ok: false,
      error: e?.message ?? String(e),
      stack: e?.stack,
    })
  }
})
