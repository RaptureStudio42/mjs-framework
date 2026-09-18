// Globals injectés au runtime ModularJS — `µ` est l'objet API exposé sur
// `globalThis` après que `mjs_init.ts` se soit exécuté. Les fichiers du
// runtime peuvent le référencer librement, ce fichier les en informe TS.

declare global {
  // eslint-disable-next-line no-var
  var µ: any
  // eslint-disable-next-line @typescript-eslint/naming-convention
  interface Window {
    µ: any
  }
}

export {}
