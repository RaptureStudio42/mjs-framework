// Civet adapter — par défaut pour les .mjs côté utilisateur en V2.
// https://civet.dev/

import type { LanguageAdapter, CompileSourceOpts, CompileResult } from './index.js'

// Civet émet du JS DIRECT (`js: true` ci-dessous strippe les types) :
// pas de passe TS→esbuild (l'ancien commentaire décrivait un pipeline inexistant).

export const civetAdapter: LanguageAdapter = {
  name: 'civet',

  async compileToJs(source: string, opts: CompileSourceOpts = {}): Promise<CompileResult> {
    const { compile: civetCompile } = await import('@danielx/civet')
    const fileName = opts.fileName ?? 'inline.civet'
    const { code, sourceMap } = await civetCompile(source, {
      filename: fileName,
      js: true,          // émet du JS direct (pas du TS) — Civet strippe les types
      sourceMap: true,   // carte v3 remontée jusqu'à `transpile()`
    })
    return { code, map: JSON.stringify(sourceMap.json(fileName, `${fileName}.js`)) }
  },
}
