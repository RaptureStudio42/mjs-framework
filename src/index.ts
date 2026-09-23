// Public API entry point — pour intégration programmatique dans d'autres outils
// (IDE plugins, custom build pipelines, tests, etc.).
//
// Usage :
//   import { transpile, Bundler, Analyzer } from 'modularjs-framework'
//
//   // Compile un .mjs en string
//   const { output, data } = await transpile(source, { moduleName: 'foo' })
//
//   // Pipeline complet sur un projet
//   const bundler = new Bundler({ sourceDir: './src', outputDir: './dist' })
//   const stats = await bundler.compile()

// Compile pipeline
export { transpile, transpileFile, injectTemplate } from './transpiler/index.js'
export type { TranspileOpts, TranspileData } from './transpiler/index.js'

// Bundler / watcher
export { Bundler } from './bundler/index.js'
export type { BundlerOpts, CompileStats, SizeReport, CssOnlyPayload } from './bundler/index.js'
export { findConfig, resolveBundlerOpts } from './bundler/config.js'
export type { MjsConfig } from './bundler/config.js'
export { minifyJs } from './bundler/minify.js'
export type { MinifyResult, MinifyOpts } from './bundler/minify.js'

// Server / HMR
export { StaticServer } from './server/index.js'
export type { ServerOpts } from './server/index.js'
export { HMRServer, hmrClientSnippet } from './server/hmr.js'
export type { HMRMessage } from './server/hmr.js'

// SSR — rendu serveur (render-then-replace). Requiert happy-dom
// (importé dynamiquement, donc sans impact pour un usage client-only).
export { renderToString, createSSRRenderer } from './server/renderToString.js'
export type {
  SSRRendererOptions, SSRRenderer, RenderOptions, RenderResult, RenderToStringOptions,
} from './server/renderToString.js'

// Building blocks (pour les outils qui veulent moins de magie)
export { tokenize } from './lexer/index.js'
export type { TokenizeOpts } from './lexer/index.js'
export { applyMjsSugarToScript } from './transpiler/index.js'
export { parse } from './parser/index.js'
export type { Node, Attr, NodeType, AttrType } from './parser/index.js'
export { compile as compileHtml } from './generator/index.js'
export { transformReactiveWrites } from './generator/transform-reactive.js'
export { Analyzer, analyze, analyzeSnippet, analyzeAttachMode } from './analyzer/index.js'
export type { AnalyzerOutput, AnalyzeSnippetResult } from './analyzer/index.js'

// Languages
export { getAdapter, resolveLang, adapters } from './languages/index.js'
export type { LanguageAdapter, SupportedLang, CompileSourceOpts } from './languages/index.js'

// CSS
export { compileCss } from './transpiler/css.js'
export type { StyleLang } from './transpiler/css.js'
