// Accroche d'appariement : _mjs_updKey/_mjs_updIf posent _mjs_pairedWith
// sur chaque ancien noeud parti en sortie (outro), pointant vers le premier
// élément du fragment neuf — lu par les sorties reveal/flip/cube/turn
// (µ._mjs_fixPosition, setupOut) pour épingler l'ancien à sa place.
//
// Harnais : Bundler réel + happy-dom (calqué sur tests/key-blocs-freres.test.ts),
// avec un double GLOBAL de `Element.prototype.animate` dont `finished` est une
// promesse JAMAIS résolue — l'outro `@transition.fade` démarre (node.animate
// appelé) mais ne se termine jamais pendant le test : l'ancien noeud reste dans
// le DOM, marqué `_mjs_dying`, exactement le fenêtre où observer l'appariement.
// `fade` est tree-shaké hors du bundle isolé (2 chunks seulement, cf.
// nested-for-revive-during-outro.test.ts) → stub minimal intro+outro.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js';
import { mjsTmp } from './helpers/tmp.js';

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'");

// {key} et {if} portent chacun un noeud @transition.fade — sert à observer,
// une fois l\'ancien en sortie (outro jamais résolue), la pose de
// _mjs_pairedWith par _mjs_updKey/_mjs_updIf.
const COMPONENT = `
<script>
$k = 0
$visible = true
</script>

<div>
  {key $k}
    <div class="a" @transition.fade>a {$k}</div>
  {end}
  {if $visible}
    <div class="b" @transition.fade>b</div>
  {end}
</div>
`;

async function monter(): Promise<{ window: any; hote: any }> {
  const root = mjsTmp('pairing-hook');
  const srcDir = join(root, 'src');
  const outDir = join(root, 'out');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'pairing.mjs'), COMPONENT);

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') });
  const stats = await bundler.compile();
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'));

  const files = readdirSync(outDir);
  const pick = (re: RegExp) => {
    const f = files.find((f) => re.test(f));
    assert.ok(f, `chunk attendu ${re} parmi ${files.join(', ')}`);
    return f!;
  };
  const code = [pick(/^mjs_core-/), pick(/^pairing-/)].map((f) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))).join('\n');

  const window: any = new Window({ url: 'http://localhost/' });
  // double GLOBAL de node.animate (WAAPI) — `finished` JAMAIS résolue : l\'outro
  // démarre mais ne finit jamais, l\'ancien noeud stagne en DOM `_mjs_dying`.
  window.Element.prototype.animate = function () {
    return {
      finished: new Promise(() => {}),
      cancel: () => {},
      pause: () => {},
      play: () => {},
      finish: () => {},
      playState: 'running',
      effect: { getComputedTiming: () => ({ progress: 0 }) }
    };
  };
  window.eval(code + '\nglobalThis.µ = µ;');
  window.eval("µ.anim = µ.anim || {}; µ.anim.fade = function() { var cfg = { duration: 30, css: function(t, u) { return { opacity: String(t) }; } }; return { intro: cfg, outro: cfg }; };");
  window.document.body.innerHTML = '<mjs-pairing></mjs-pairing>';
  await new Promise((r) => setTimeout(r, 80));
  return { window, hote: window.document.body.querySelector('mjs-pairing') };
}

describe('runtime — _mjs_updKey/_mjs_updIf posent _mjs_pairedWith sur l\'ancien noeud en sortie', function () {
  this.timeout(40000);

  after(async () => {
    await terminateSharedWorkerPool();
  });

  it('clé changée ($k 0→1) : ancien .a en sortie apparié au neuf (_mjs_pairedWith)', async () => {
    const { window, hote } = await monter();
    assert.ok(hote && hote._shadow, 'le composant doit être monté avec son shadow root');

    hote._set('k', 1);
    await new Promise((r) => setTimeout(r, 80));

    const nodesA: any[] = [...hote._shadow.querySelectorAll('.a')];
    assert.equal(nodesA.length, 2, 'deux .a doivent coexister : ancien en sortie + neuf');

    const oldA = nodesA.find((n: any) => n._mjs_dying === true);
    const newA = nodesA.find((n: any) => n._mjs_dying !== true);
    assert.equal(!!oldA, true, 'un .a doit être en sortie (_mjs_dying)');
    assert.equal(!!newA, true, 'un .a neuf (non dying) doit exister');
    assert.equal(oldA._mjs_pairedWith === newA, true, 'l\'ancien .a doit être apparié au neuf (premier élément du fragment neuf)');

    window.close?.();
  });

  it('{if} refermé ($visible true→false) : ancien .b en sortie SANS appariement (_mjs_pairedWith undefined)', async () => {
    const { window, hote } = await monter();
    assert.ok(hote && hote._shadow, 'le composant doit être monté avec son shadow root');

    hote._set('visible', false);
    await new Promise((r) => setTimeout(r, 80));

    const nodesB: any[] = [...hote._shadow.querySelectorAll('.b')];
    assert.equal(nodesB.length, 1, 'un seul .b doit rester : l\'ancien en sortie, aucun neuf créé');

    const oldB: any = nodesB[0];
    assert.equal(oldB._mjs_dying === true, true, 'l\'ancien .b doit être en sortie (_mjs_dying)');
    assert.equal(oldB._mjs_pairedWith === undefined, true, 'aucun appariement quand le bloc se referme sans createFn');

    window.close?.();
  });
});
