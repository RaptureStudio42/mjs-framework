// TypeScript adapter — `<script lang="ts">`. Strippe les types via esbuild.

import type { LanguageAdapter, CompileSourceOpts, CompileResult } from './index.js'

export const tsAdapter: LanguageAdapter = {
  name: 'ts',

  async compileToJs(source: string, opts: CompileSourceOpts = {}): Promise<CompileResult> {
    const esbuild = await import('esbuild')
    const result = await esbuild.transform(source, {
      loader: 'ts',
      format: 'esm',
      target: 'es2022',
      sourcefile: opts.fileName ?? 'inline.ts',
      sourcemap: true,  // carte v3 remontée jusqu'à `transpile()`
    })
    return { code: result.code, map: result.map }
  },
}
