// JavaScript adapter — `<script lang="js">`. Pass-through, rien à faire.

import type { LanguageAdapter, CompileResult } from './index.js'

export const jsAdapter: LanguageAdapter = {
  name: 'js',
  compileToJs(source: string): CompileResult {
    return { code: source }
  },
}
