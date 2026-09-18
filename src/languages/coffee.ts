// Coffee adapter — rétrocompat avec les .mjs V1.
//
// GEL + DÉPRÉCIATION — le défaut projet bascule
// vers Civet ; l'adaptateur Coffee reste fonctionnel (stdlib utils/*.coffee)
// mais chaque compilation d'une VRAIE source .coffee
// avertit désormais, pour orienter la migration.

import type { LanguageAdapter, CompileSourceOpts, CompileResult } from './index.js'
import { t } from '../messages/index.js'

// Fichiers déjà signalés — une fois par fichier et par PROCESSUS (les workers
// du bundler sont persistants : pas de spam à chaque recompile HMR du même
// fichier). Clé = `opts.fileName`, alimenté par TOUS les appelants réels
// (bundleExternalManifest/_compileScriptModuleInner du bundler, script/module
// du transpiler) SAUF `<moduleName>.inlines` : ce marqueur synthétique désigne
// les handlers d'événements, encodés en Coffee EN INTERNE par le generator
// quel que soit le langage réellement choisi par le dev — avertir dessus
// spammerait même les projets 100% Civet qui n'ont jamais écrit une ligne
// de Coffee.
const warnedFiles = new Set<string>()

export const coffeeAdapter: LanguageAdapter = {
  name: 'coffee',

  async compileToJs(source: string, opts: CompileSourceOpts = {}): Promise<CompileResult> {
    const fileName = opts.fileName ?? 'inline.coffee'
    if(!fileName.endsWith('.inlines') && !warnedFiles.has(fileName)) {
      warnedFiles.add(fileName)
      console.warn(t('languages.source-coffee-depreciee', { fichier: fileName }))
    }
    const coffee = await import('coffeescript')
    try {
      const result = coffee.default.compile(source, {
        bare: opts.bare ?? true,
        filename: fileName,
        sourceMap: true,  // carte v3 remontée jusqu'à `transpile()`
      })
      if (typeof result === 'string') return { code: result }
      const r = result as any
      return { code: r.js, map: r.v3SourceMap }
    } catch (err: any) {
      // l'erreur BRUTE porte `.location` + un `.toString()` avec ligne/colonne/
      // caret, mais bundler/index.ts:1661 (`r.reason?.message`) ne relaie que le motif nu
      // (« missing " ») — position perdue. Reconstruit `.message` (ligne:colonne + ligne
      // source + caret) AVANT de relancer, pour que la position survive au relais.
      if (err && err.location && typeof err.location.first_line === 'number') {
        const line   = err.location.first_line + 1
        const col    = (err.location.first_column ?? 0) + 1
        const brut   = String(err.toString?.() ?? '').split('\n')
        const detail = brut.slice(1).join('\n')  // ligne source + caret, fournis par CoffeeScript
        err.message = `${line}:${col}: ${err.message}` + (detail ? `\n${detail}` : '')
      }
      throw err
    }
  },
}
