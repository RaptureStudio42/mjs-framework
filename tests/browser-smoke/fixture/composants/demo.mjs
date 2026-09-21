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

<div class="code-box">
  <@code>
    <pre><code>total = 0
step01 = total + 1
step02 = step01 + 1
step03 = step02 + 1
step04 = step03 + 1
step05 = step04 + 1
step06 = step05 + 1
step07 = step06 + 1
step08 = step07 + 1
step09 = step08 + 1
step10 = step09 + 1
step11 = step10 + 1
step12 = step11 + 1
step13 = step12 + 1
step14 = step13 + 1
step15 = step14 + 1
step16 = step15 + 1
step17 = step16 + 1
step18 = step17 + 1
step19 = step18 + 1
step20 = step19 + 1
step21 = step20 + 1
step22 = step21 + 1
step23 = step22 + 1
step24 = step23 + 1
step25 = step24 + 1
step26 = step25 + 1
step27 = step26 + 1
step28 = step27 + 1
step29 = step28 + 1
step30 = step29 + 1
step31 = step30 + 1
step32 = step31 + 1
step33 = step32 + 1
step34 = step33 + 1
step35 = step34 + 1
step36 = step35 + 1
step37 = step36 + 1
step38 = step37 + 1
total = step38</code></pre>
  </@code>
</div>

<div class="code-short">
  <@code>npm install modularjs-framework</@code>
</div>

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

  .code-box
    max-width: 360px
    height: 160px
    overflow: auto

  .code-short
    max-width: 360px
</style>
