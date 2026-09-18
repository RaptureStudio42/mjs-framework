// Dispatcher de langages — pour les .mjs côté utilisateur.
//
// Le user déclare `<script lang="…">` (ou laisse vide pour fallback config).
// Chaque adapter compile son input vers du **JS standard** que le lexer
// ModularJS post-traite ensuite avec le sucre `$/§/§§/@@/@x`.

export type SupportedLang = 'civet' | 'coffee' | 'ts' | 'js'

export interface CompileSourceOpts {
  fileName?: string
  bare?: boolean
}

/** Retour d'un adapter : le JS, plus sa carte de source v3 (JSON stringifié) si le
 * compilateur sait en produire une. `map` absent = pas de carte pour ce langage/appel
 * (ex. adapter `js`, pur passe-plat). */
export interface CompileResult {
  code: string
  map?: string
}

export interface LanguageAdapter {
  name: SupportedLang
  /** Source originale → JS standard (pas encore traité par lexer ModularJS) */
  compileToJs(source: string, opts?: CompileSourceOpts): CompileResult | Promise<CompileResult>
}

import { civetAdapter } from './civet.js'
import { coffeeAdapter } from './coffee.js'
import { tsAdapter } from './typescript.js'
import { jsAdapter } from './javascript.js'
import { t } from '../messages/index.js'

export const adapters: Record<SupportedLang, LanguageAdapter> = {
  civet: civetAdapter,
  coffee: coffeeAdapter,
  ts: tsAdapter,
  js: jsAdapter,
}

/** Récupère l'adapter pour un langage. Throws si inconnu. */
export function getAdapter(lang: SupportedLang | string): LanguageAdapter {
  const a = adapters[lang as SupportedLang]
  if (!a) {
    throw new Error(t('languages.langage-inconnu', { lang, supportes: Object.keys(adapters).join(', ') }))
  }
  return a
}

/** Auto-détection du langage : priorité = lang attribut → config projet → default 'civet' */
export function resolveLang(scriptLangAttr: string | null, projectDefault?: SupportedLang): SupportedLang {
  if (scriptLangAttr) return scriptLangAttr as SupportedLang
  if (projectDefault) return projectDefault
  return 'civet'
}
