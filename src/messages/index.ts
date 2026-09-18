// messages — catalogue centralisé des textes du compilateur, du CLI et des serveurs Node.
// Tout texte en dur destiné à un humain vit dans fr.ts + en.ts (clés partagées) ; la langue
// vient de mjs.config.json (clé `lang` : 'fr' défaut, 'en', toute autre valeur → fr). Les
// messages émis AVANT la lecture de la config (parse argv, config introuvable) sortent en fr.

import { fr } from './fr.js'
import { en } from './en.js'

export type MsgVars  = Record<string, string | number | boolean | undefined>
export type MsgEntry = string | ((v: MsgVars) => string)
export type MsgKey   = keyof typeof fr

let LANG: 'fr' | 'en' = 'fr'

// applique la langue du projet ; tout sauf 'en' retombe sur fr (contrat de la clé `lang`)
export function setMessagesLang(lang: unknown): void {
  LANG = lang === 'en' ? 'en' : 'fr'
}

export function getMessagesLang(): 'fr' | 'en' {
  return LANG
}

// résout une clé dans la langue courante ; entrée fonction = modèle à variables
export function t(key: MsgKey, vars?: MsgVars): string {
  const entry = (LANG === 'en' ? (en as Record<MsgKey, MsgEntry>)[key] : fr[key]) ?? fr[key]
  return typeof entry === 'function' ? entry(vars ?? {}) : entry
}
