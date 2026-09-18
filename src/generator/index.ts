// generator — entrypoint qui réexporte la fonction compile principale.
// La logique est dans compile.ts.

export { compile, preprocess, walk } from './compile.js'
export { state, reset, genId, dedent, getEffectVars, registerEffect, CompilerState } from './state.js'
export { cleanJs, cleanJsExpr, parseMixedString } from './utils.js'

export interface GenerateOpts {
  externalVars?: string[]
}

export function generate(_parsedAST: unknown, _analyzerOutput: unknown, _opts: GenerateOpts = {}) {
  throw new Error('[generator.generate] not yet implemented (use compile() directly for now)')
}
