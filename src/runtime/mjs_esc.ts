// mjs_esc — échappement HTML des interpolations qui partent en innerHTML : `<@head>` (tête
// vivante) et le repli d'une frontière `<@failed>`. DÉTACHÉ de mjs_init.ts : le transpileur émet
// `µ._esc(` LITTÉRALEMENT pour CHAQUE interpolation de ces deux blocs (transpiler/macros.ts), et
// personne d'autre ne l'appelle au runtime — hors production, le panneau de développement s'en
// sert pour son propre affichage, d'où sa présence d'office dans un build de dev
// (bundler/features.ts et resolveRuntimeFiles, clé `esc`).

// Échappement HTML minimal pour les interpolations destinées à un innerHTML
// (<@head>, fallback <@failed>). Couvre les contextes texte ET valeur d'attribut
// quotée en `"` comme en `'` (apostrophe incluse : un binding écrit à la main en
// simple-quote dans <@head> pourrait sinon sortir de l'attribut).
µ._esc = function(v) {
  var s = String(v);
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};
