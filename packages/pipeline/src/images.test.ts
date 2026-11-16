/**
 * Images that aren't RAW files (roadmap 8.11) decode and render through the WebAssembly
 * build too: a JPEG of a golden RAW's render goes back in, reads as a JPEG, starts with
 * an empty recipe, and comes out as it went in. Skipped until
 * `./scripts/fetch-golden-raws.sh` has run; CI runs it.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Developer, defaultRecipeWasm, initPipeline, readMetadata } from './node.ts';
import { defaultRecipe } from './params.ts';

const raw = new URL('../../../crates/pipeline/tests/golden/raws/sony-ilce-7m3.arw', import.meta.url);

test('a JPEG goes through the wasm build unchanged', { skip: !existsSync(raw) && 'golden RAWs not fetched' }, () => {
  initPipeline();
  const source = new Developer(readFileSync(raw));
  const jpeg = source.renderJpeg('{}', 600, 600, 100);
  const rendered = source.renderThumbnail('{}', 600, 600).takeData();
  source.free();

  const meta = JSON.parse(readMetadata(jpeg));
  assert.equal(meta.imageFormat, 'jpeg');
  assert.ok(meta.width > 0 && meta.height > 0);
  const recipe = JSON.parse(defaultRecipeWasm(JSON.stringify(meta)));
  assert.deepEqual(recipe, defaultRecipe(meta));
  assert.deepEqual(recipe.modules, []);

  const dev = new Developer(jpeg);
  try {
    assert.equal(JSON.parse(dev.metadata()).imageFormat, 'jpeg');
    const out = dev.render(JSON.stringify(recipe), 0, 0, '{}');
    assert.deepEqual([out.width, out.height], [meta.width, meta.height]);
    // The same pixels as the render the JPEG was made of, but for its compression.
    const data = out.takeData();
    assert.equal(data.length, rendered.length);
    const bias = [0, 0, 0];
    let diff = 0;
    for (let i = 0; i < data.length; i++) {
      if (i % 4 === 3) continue;
      bias[i % 4]! += data[i]! - rendered[i]!;
      diff += Math.abs(data[i]! - rendered[i]!);
    }
    const n = data.length / 4;
    assert.ok(diff / (n * 3) < 1, `mean difference ${diff / (n * 3)}`);
    // No colour cast: each channel's mean stays put.
    for (const b of bias) assert.ok(Math.abs(b / n) < 0.1, `bias ${bias.map((b) => b / n)}`);
    // Exports work from it too.
    assert.deepEqual([...dev.renderJpeg(JSON.stringify(recipe), 256, 256, 80).subarray(0, 2)], [0xff, 0xd8]);
  } finally {
    dev.free();
  }
});
