import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeBlob, encodeBlob, parseDarktableXmp, activeEntries } from './darktable/xmp.ts';
import { Layout, writeStruct } from './darktable/struct.ts';
import {
  detectImportedEdits,
  importEdits,
  importLabel,
  isImportLabel,
  startingHistory,
  type ImportMetadata,
} from './importedEdits.ts';
import {
  AUTO_RECIPE_LABEL,
  defaultEditParams,
  findModule,
  lutIds,
  normalizeEditParams,
  resolveLutRefs,
  unresolvedLutNames,
} from './params.ts';

const EXPOSURE_V7 = new Layout([
  ['mode', 'i32'],
  ['black', 'f32'],
  ['exposure', 'f32'],
  ['deflicker_percentile', 'f32'],
  ['deflicker_target_level', 'f32'],
  ['compensate_exposure_bias', 'gboolean'],
  ['compensate_hilite_pres', 'gboolean'],
]);

interface FixtureEntry {
  operation: string;
  modversion?: number;
  enabled?: boolean;
  params?: string;
  multiPriority?: number;
  multiName?: string;
}

/** A sidecar as darktable 5 writes it (attributes on each `rdf:li`). */
function sidecar(entries: FixtureEntry[], { app = 'darktable', historyEnd = entries.length } = {}) {
  const hashes =
    app === 'darktable'
      ? '\n    darktable:history_basic_hash="00"\n    darktable:history_auto_hash="00"\n    darktable:history_current_hash="00"'
      : '\n    darktable:history_current_hash="00"';
  const items = entries
    .map(
      (e, num) => `
     <rdf:li
      darktable:num="${num}"
      darktable:operation="${e.operation}"
      darktable:enabled="${e.enabled === false ? 0 : 1}"
      darktable:modversion="${e.modversion ?? 1}"
      darktable:params="${e.params ?? '00000000'}"
      darktable:multi_name="${e.multiName ?? ''}"
      darktable:multi_name_hand_edited="0"
      darktable:multi_priority="${e.multiPriority ?? 0}"
      darktable:blendop_version="14"
      darktable:blendop_params="gz11eJxjYGBgkGAAgRNODGiAEV0AJ2iwh+CRyscOAAdeGQQ="/>`,
    )
    .join('');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:darktable="http://darktable.sf.net/"
    xmp:Rating="3"
    darktable:xmp_version="5"
    darktable:raw_params="0"
    darktable:auto_presets_applied="1"
    darktable:history_end="${historyEnd}"
    darktable:iop_order_version="5"${hashes}>
   <darktable:history>
    <rdf:Seq>${items}
    </rdf:Seq>
   </darktable:history>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

const exposure = (values: Record<string, unknown>, compress = false) =>
  encodeBlob(writeStruct(EXPOSURE_V7, { deflicker_percentile: 50, deflicker_target_level: -4, ...values }), compress);

const LUT3D_V3 = new Layout([
  ['filepath', { char: 512 }],
  ['colorspace', 'i32'],
  ['interpolation', 'i32'],
  ['nb_keypoints', 'i32'],
  ['c_clut', { array: 'u8', n: 2048 * 2 * 3 }],
  ['lutname', { char: 128 }],
]);
const lut3d = (values: Record<string, unknown>) => encodeBlob(writeStruct(LUT3D_V3, values), true);

const metadata: ImportMetadata = { make: 'SONY', model: 'ILCE-7M3', exposureBias: -0.7 };

test('decodes parameters as hex and as compressed base64', async () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 7);
  assert.deepEqual(await decodeBlob(await encodeBlob(bytes)), bytes);
  const gz = await encodeBlob(bytes, true);
  assert.match(gz, /^gz\d\d/);
  assert.deepEqual(await decodeBlob(gz), bytes);
  // darktable's own default blending parameters (`exif.cc`): v13's struct.
  assert.ok((await decodeBlob('gz11eJxjYGBgkGAAgRNODGiAEV0AJ2iwh+CRyscOAAdeGQQ='))!.length > 100);
  assert.equal(await decodeBlob('abc'), null);
  assert.equal(await decodeBlob('gz12!!!'), null);
});

test('reads C struct layouts with their alignment', () => {
  assert.equal(EXPOSURE_V7.size, 28);
  const padded = new Layout([
    ['a', 'bool'],
    ['b', 'f32'],
    ['c', { char: 3 }],
  ]);
  assert.equal(padded.size, 12);
  const read = padded.read(writeStruct(padded, { a: 1, b: 1.5, c: 'hi' }))!;
  assert.deepEqual(read, { a: true, b: 1.5, c: 'hi' });
  assert.equal(padded.read(new Uint8Array(11)), null);
});

test('tells darktable from Ansel, and needs a history', () => {
  assert.equal(detectImportedEdits(sidecar([{ operation: 'exposure' }])), 'darktable');
  assert.equal(detectImportedEdits(sidecar([{ operation: 'exposure' }], { app: 'ansel' })), 'ansel');
  // Modules (and versions) only one of them has decide over the header.
  assert.equal(detectImportedEdits(sidecar([{ operation: 'sigmoid', modversion: 3 }], { app: 'ansel' })), 'darktable');
  assert.equal(detectImportedEdits(sidecar([{ operation: 'diffuse', modversion: 3 }])), 'ansel');
  assert.equal(detectImportedEdits(sidecar([{ operation: 'exposure', modversion: 7 }], { app: 'ansel' })), 'darktable');
  assert.equal(detectImportedEdits('<x:xmpmeta><rdf:Description xmp:Rating="2"/></x:xmpmeta>'), null);
  assert.equal(importLabel('ansel'), 'Imported from Ansel');
  assert.ok(isImportLabel('Imported from darktable'));
  assert.ok(!isImportLabel(AUTO_RECIPE_LABEL));
});

test('replays the history up to its end, the last entry of each instance', async () => {
  const xmp = parseDarktableXmp(
    sidecar(
      [
        { operation: 'exposure', params: 'aa' },
        { operation: 'exposure', params: 'bb' },
        { operation: 'exposure', params: 'cc', multiPriority: 1, multiName: 'sky' },
        { operation: 'exposure', params: 'dd' },
      ],
      { historyEnd: 3 },
    ),
  )!;
  assert.equal(xmp.entries.length, 4);
  assert.deepEqual(
    activeEntries(xmp).map((e) => [e.params, e.multiName]),
    [
      ['bb', ''],
      ['cc', 'sky'],
    ],
  );
});

test('imports exposure, keeps what nothing imported decides, and reports every module', async () => {
  const text = sidecar([
    { operation: 'rawprepare' },
    { operation: 'demosaic' },
    { operation: 'exposure', modversion: 7, params: await exposure({ exposure: 1, compensate_exposure_bias: 1 }) },
    { operation: 'grain', modversion: 2 },
    { operation: 'vignette', enabled: false },
    {
      operation: 'exposure',
      modversion: 7,
      params: await exposure({ exposure: -0.5 }, true),
      multiPriority: 1,
      multiName: 'shadows',
      enabled: false,
    },
    { operation: 'lens', modversion: 99 },
  ]);
  const imported = (await importEdits(text, { base: defaultEditParams, metadata }))!;
  assert.equal(imported.label, 'Imported from darktable');
  const exposures = imported.recipe.modules.filter((m) => m.kind === 'exposure');
  assert.equal(exposures.length, 2);
  assert.ok(Math.abs((exposures[0]!.params as { ev: number }).ev - 1.7) < 1e-6);
  assert.equal(exposures[1]!.enabled, false);
  assert.equal(exposures[1]!.label, 'shadows');
  // Not translated yet: the starting recipe's stays.
  assert.ok(findModule(imported.recipe, 'filmic'));
  assert.deepEqual(
    imported.report.items.map((i) => [i.module, i.status]),
    [
      ['raw black/white point', 'builtIn'],
      ['demosaic', 'builtIn'],
      ['exposure', 'mapped'],
      ['grain', 'skipped'],
      ['lens correction', 'skipped'],
    ],
  );
});

test("darktable's black level correction becomes ours", async () => {
  const text = sidecar([{ operation: 'exposure', modversion: 7, params: await exposure({ exposure: 1, black: 0.1 }) }]);
  const { recipe } = (await importEdits(text, { base: defaultEditParams, metadata }))!;
  const p = findModule(recipe, 'exposure')!.params;
  // Theirs: (x − b) / (2^-ev − b); ours: (x − b) · 2^ev.
  assert.ok(Math.abs(2 ** p.ev - 1 / (0.5 - 0.1)) < 1e-5);
  assert.ok(Math.abs(p.black - 0.1) < 1e-6);
});

test('a module darktable never applied is left out', async () => {
  const text = sidecar([{ operation: 'rawprepare' }]);
  const { recipe } = (await importEdits(text, { base: defaultEditParams, metadata }))!;
  assert.equal(findModule(recipe, 'exposure'), undefined);
  assert.ok(findModule(recipe, 'colorCalibration'));
});

test('the starting history: the import after the starting recipe, if there is one', async () => {
  const text = sidecar([{ operation: 'exposure', modversion: 7, params: await exposure({ exposure: 2 }) }]);
  const entries = await startingHistory(defaultEditParams, AUTO_RECIPE_LABEL, text, metadata);
  assert.deepEqual(
    entries.map((e) => e.label),
    [AUTO_RECIPE_LABEL, 'Imported from darktable'],
  );
  assert.equal((await startingHistory(defaultEditParams, AUTO_RECIPE_LABEL, null, metadata)).length, 1);
  assert.equal((await startingHistory(defaultEditParams, AUTO_RECIPE_LABEL, '<x/>', metadata)).length, 1);
});

test('a LUT is referred to by name until the user has one of that name', async () => {
  assert.equal(LUT3D_V3.size, 12940);
  const astia = 'HaldCLUT/Color/Fuji/Fuji Astia 100 Generic.png';
  const text = sidecar([
    { operation: 'lut3d', modversion: 3, params: await lut3d({ filepath: astia, interpolation: 1 }) },
    {
      operation: 'lut3d',
      modversion: 3,
      params: await lut3d({ filepath: 'Kodak/Portra.cube', colorspace: 4 }),
      multiPriority: 1,
      multiName: 'portra',
    },
  ]);
  const { recipe, report } = (await importEdits(text, { base: defaultEditParams, metadata }))!;
  const refs = recipe.modules.filter((m) => m.kind === 'lut').map((m) => (m.params as { lut: unknown }).lut);
  assert.deepEqual(refs, [
    { id: '', name: 'Fuji Astia 100 Generic', path: astia },
    { id: '', name: 'Portra', path: 'Kodak/Portra.cube' },
  ]);
  assert.deepEqual(
    report.items.map((i) => [i.status, i.file?.name]),
    [
      ['needsFile', 'Fuji Astia 100 Generic.png'],
      ['needsFile', 'Portra.cube'],
    ],
  );
  // Kept through normalisation (as stored), without counting as a LUT to load.
  const stored = normalizeEditParams(JSON.parse(JSON.stringify(recipe)));
  assert.deepEqual(lutIds(stored), []);
  assert.deepEqual(unresolvedLutNames(stored), ['Fuji Astia 100 Generic', 'Portra']);
  const resolved = resolveLutRefs(stored, [{ id: 'f'.repeat(64), name: 'fuji astia 100 generic ' }]);
  assert.deepEqual(lutIds(resolved), ['f'.repeat(64)]);
  assert.deepEqual(unresolvedLutNames(resolved), ['Portra']);
  assert.equal(resolveLutRefs(resolved, []), resolved);

  // The user has it already: used at once, with darktable's interpolation.
  const withLuts = (await importEdits(text, {
    base: defaultEditParams,
    metadata,
    luts: [{ id: 'a'.repeat(64), name: 'Fuji Astia 100 Generic' }],
  }))!;
  const astiaInstance = withLuts.recipe.modules.find((m) => m.kind === 'lut')!;
  assert.deepEqual(astiaInstance.params, {
    lut: { id: 'a'.repeat(64), name: 'Fuji Astia 100 Generic', path: astia },
    interpolation: 'trilinear',
  });
  assert.deepEqual(
    withLuts.report.items.map((i) => i.status),
    ['mapped', 'needsFile'],
  );
  assert.match(withLuts.report.items[1]!.note!, /Applied on sRGB, not linear Rec2020/);
});
