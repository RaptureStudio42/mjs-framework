<script>
  $country = null
  $email   = ''
  $accept  = false
  $size    = null
  $alerts  = false
  $langues = []
</script>

<form id="demo-form">
  <@select name="country" search value=!{$country} placeholder="Choisir un pays">
    <@option value="fr" icon="🇫🇷">France</@option>
    <@option value="de" icon="🇩🇪">Allemagne</@option>
    <@option value="be" icon="🇧🇪">Belgique</@option>
    <@option value="ch" icon="🇨🇭">Suisse</@option>
    <@option value="ca" icon="🇨🇦">Canada</@option>
  </@select>

  <@select name="langues" multiple value=!{$langues} placeholder="Langues parlées">
    <@option value="fr">Français</@option>
    <@option value="en">Anglais</@option>
    <@option value="de">Allemand</@option>
  </@select>

  <@field name="email" label="Email" help="On ne le partage jamais." ok-label="Adresse valide">
    <input type="email" name="email" value=!{$email}>
  </@field>

  <@checkbox name="terms" checked=!{$accept}>J'accepte les conditions</@checkbox>

  <@radio name="size" value="s" group=!{$size}>S</@radio>
  <@radio name="size" value="m" group=!{$size}>M</@radio>
  <@radio name="size" value="l" group=!{$size}>L</@radio>

  <@switch name="alerts" checked=!{$alerts}>Notifications</@switch>

  <button type="button" id="btn-delete" @title="Supprime définitivement cette ligne">🗑</button>
  <button type="button" id="btn-submit" @title="Valide le formulaire">✔</button>
</form>

<style>
  form
    display: flex
    flex-direction: column
    gap: 12px
    max-width: 360px
    padding: 16px

  // règle de PAGE volontairement collisionnante : une déclaration normale de CET arbre (celui où
  // l'input EST écrit en markup) doit perdre face au ::slotted() de mjs-field
  // pour la bordure d'état, grâce au !important du module — sonde de non-régression.
  input[type="email"]
    border: 1px solid #586273
</style>
