import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeBlob, encodeBlob, parseDarktableXmp, activeEntries } from './darktable/xmp.ts';
import { Layout, writeStruct } from './darktable/struct.ts';
import { FilmicCurve, fitFilmic } from './darktable/tone.ts';
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
  defaultModuleParams,
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

/** A starting recipe with a module no darktable one maps to. */
const withGlow = normalizeEditParams({
  ...defaultEditParams,
  modules: [...defaultEditParams.modules, { kind: 'glow', id: 'glow', enabled: true, label: null, params: {} }],
});

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
  const imported = (await importEdits(text, { base: withGlow, metadata }))!;
  assert.equal(imported.label, 'Imported from darktable');
  const exposures = imported.recipe.modules.filter((m) => m.kind === 'exposure');
  assert.equal(exposures.length, 2);
  assert.ok(Math.abs((exposures[0]!.params as { ev: number }).ev - 1.7) < 1e-6);
  assert.equal(exposures[1]!.enabled, false);
  assert.equal(exposures[1]!.label, 'shadows');
  // Nothing of theirs decides it: the starting recipe's stays.
  assert.ok(findModule(imported.recipe, 'glow'));
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
  const { recipe } = (await importEdits(text, { base: withGlow, metadata }))!;
  assert.equal(findModule(recipe, 'exposure'), undefined);
  assert.equal(findModule(recipe, 'colorCalibration'), undefined);
  // Nothing of theirs decides it: the starting recipe's stays.
  assert.ok(findModule(recipe, 'glow'));
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

test("our filmic's curve in TS gives Rust's values (filmic.rs's ts_parity)", () => {
  const cases: [Partial<typeof defaultModuleParams.filmic>, number[], number[]][] = [
    [{}, [0, 0.08, 0.1845, 1, 6], [0.00015176, 0.0650907, 0.1845, 0.8075885, 1]],
    [
      {
        whiteExposure: 5,
        blackExposure: -7,
        contrast: 1.6,
        toe: 30,
        shoulder: 5,
        autoHardness: false,
        hardness: 3,
        blackTarget: 0.5,
        whiteTarget: 90,
      },
      [0.001, 0.05, 0.1845, 2, 12],
      [0.005, 0.0203031, 0.1845, 0.851754, 0.9],
    ],
  ];
  for (const [p, xs, want] of cases) {
    const curve = new FilmicCurve({ ...defaultModuleParams.filmic, ...p });
    xs.forEach((x, i) =>
      assert.ok(Math.abs(curve.toneMap(x) - want[i]!) < 1e-5, `${x}: ${curve.toneMap(x)} vs ${want[i]}`),
    );
  }
});

test('a curve that is our filmic is fitted back onto it', () => {
  const p = {
    ...defaultModuleParams.filmic,
    whiteExposure: 4.5,
    blackExposure: -9,
    contrast: 1.4,
    toe: 25,
    shoulder: 15,
    autoHardness: false,
    hardness: 2.5,
  };
  const curve = new FilmicCurve(p);
  const fit = fitFilmic((v) => curve.toneMap(v), defaultModuleParams.filmic);
  assert.ok(fit.error < 0.005, `error ${fit.error}`);
  assert.ok(Math.abs(fit.offset) < 0.05, `offset ${fit.offset}`);
});

// ── Phase 1 translators, on synthetic histories ─────────────────────────────

const f32s = (...v: number[]) => v.map((x) => ['f32', x] as const);
/** Parameters as a C struct from (type, value) pairs, in order. */
function packed(fields: readonly (readonly [string, unknown])[]) {
  const layout = new Layout(fields.map(([t], i) => [`f${i}`, t as never] as const));
  return encodeBlob(writeStruct(layout, Object.fromEntries(fields.map(([, v], i) => [`f${i}`, v]))));
}
const calibrationV3 = (illuminant: number, temperature: number, adaptation = 1) =>
  packed([
    ['f32', 1],
    ['f32', 0],
    ['f32', 0],
    ['f32', 0],
    ['f32', 0],
    ['f32', 1],
    ['f32', 0],
    ['f32', 0],
    ['f32', 0],
    ['f32', 0],
    ['f32', 1],
    ['f32', 0],
    ...Array.from({ length: 12 }, () => ['f32', 0] as const),
    ...Array.from({ length: 6 }, () => ['gboolean', 1] as const),
    ['i32', illuminant],
    ['i32', 2],
    ['i32', 4],
    ['i32', adaptation],
    ...f32s(0.33, 0.33, temperature, 1),
    ['gboolean', 1],
    ['i32', 3],
  ]);

test("colour calibration: their D50 is our D65, 'pipeline' and 'as shot' keep their meaning", async () => {
  const run = async (illuminant: number, temperature: number) => {
    const text = sidecar([
      { operation: 'channelmixerrgb', modversion: 3, params: await calibrationV3(illuminant, temperature) },
    ]);
    return findModule((await importEdits(text, { base: defaultEditParams, metadata }))!.recipe, 'colorCalibration')!
      .params;
  };
  const d50 = await run(2, 5003);
  assert.equal(d50.illuminant, 'daylight');
  assert.ok(Math.abs(d50.temperature - 6504) < 60, `${d50.temperature}`);
  assert.equal((await run(0, 5003)).illuminant, 'pipeline');
  assert.equal((await run(10, 5003)).illuminant, 'asShot');
});

test('a white balance other than the camera reference is folded into colour calibration', async () => {
  const cameraWhite = {
    asShot: [2.4, 1, 1.5] as [number, number, number],
    reference: [2.74, 1, 1.37] as [number, number, number],
    xyzFromCamera: [
      [0.665, 0.253, 0.033],
      [0.261, 0.966, -0.227],
      [0.034, -0.209, 1.264],
    ] as never,
  };
  const temperature = (r: number, b: number, preset: number) => packed([...f32s(r, 1, b, 1), ['i32', preset]]);
  const text = async (r: number, b: number, preset: number) =>
    sidecar([
      { operation: 'temperature', modversion: 4, params: await temperature(r, b, preset) },
      { operation: 'channelmixerrgb', modversion: 3, params: await calibrationV3(0, 5003) },
    ]);
  const imported = async (r: number, b: number, preset: number) =>
    (await importEdits(await text(r, b, preset), { base: defaultEditParams, metadata: { ...metadata, cameraWhite } }))!;
  // The reference, or darktable 5's late correction: nothing to fold.
  for (const [r, b, preset] of [
    [2.74, 1.37, 3],
    [2.4, 1.5, 4],
  ] as const) {
    const p = findModule((await imported(r, b, preset)).recipe, 'colorCalibration')!.params;
    assert.equal(p.illuminant, 'pipeline');
  }
  // Warmer than the reference (less blue gain): the light it took as white is warmer than D65.
  const folded = await imported(2.4, 1.1, -1);
  const p = findModule(folded.recipe, 'colorCalibration')!.params;
  assert.notEqual(p.illuminant, 'pipeline');
  assert.equal(p.adaptation, 'cat16');
  assert.ok(folded.report.items.some((i) => i.module === 'white balance' && i.status === 'approximated'));
});

test("sigmoid's default curve fits our filmic closely, middle grey kept", async () => {
  const sigmoid = await packed([
    ...f32s(1.5, 0, 100, 0.0152),
    ['i32', 0],
    ...f32s(100, 0, 0, 0, 0, 0, 0, 0),
    ['i32', 0],
  ]);
  const { recipe, report } = (await importEdits(sidecar([{ operation: 'sigmoid', modversion: 3, params: sigmoid }]), {
    base: defaultEditParams,
    metadata,
  }))!;
  const filmic = findModule(recipe, 'filmic')!;
  assert.ok(!filmic.autoTune);
  const within = Number(/within ([\d.]+) %/.exec(report.items[0]!.note!)![1]);
  assert.ok(within < 1.5, `${within} %`);
  // Sigmoid keeps middle grey: no brightness exposure added.
  assert.equal(recipe.modules.filter((m) => m.kind === 'exposure').length, 0);
});

test('geometry: orientation as ours on top of the camera, and a crop', async () => {
  const flip = (o: number) => packed([['i32', o]]);
  const crop = packed([...f32s(0.1, 0.2, 0.9, 0.7), ['i32', -1], ['i32', -1]]);
  const geometryOf = async (entries: FixtureEntry[], orientation: number) =>
    findModule(
      (await importEdits(sidecar(entries), {
        base: defaultEditParams,
        metadata: { ...metadata, width: 6000, height: 4000, orientation },
      }))!.recipe,
      'geometry',
    )!.params;
  // "Autodetect": the camera's own, nothing on top.
  let g = await geometryOf([{ operation: 'flip', modversion: 2, params: await flip(-1) }], 6);
  assert.deepEqual([g.rotation, g.flipHorizontal, g.autoCrop], [0, false, 'aspect']);
  // Rotated a quarter turn clockwise in darktable (ORIENTATION_ROTATE_CW_90_DEG).
  g = await geometryOf([{ operation: 'flip', modversion: 2, params: await flip(5) }], 1);
  assert.deepEqual([g.rotation, g.flipHorizontal], [1, false]);
  // A crop: the same rectangle, with nothing else.
  g = await geometryOf(
    [
      { operation: 'flip', modversion: 2, params: await flip(-1) },
      { operation: 'crop', modversion: 3, params: await crop },
    ],
    1,
  );
  const c = g.crop;
  assert.ok(Math.abs(g.angle) < 0.01 && Math.abs(g.vertical) < 0.01, JSON.stringify(g));
  assert.ok(
    Math.abs(c.x - 0.1) < 1e-3 &&
      Math.abs(c.y - 0.2) < 1e-3 &&
      Math.abs(c.width - 0.8) < 1e-3 &&
      Math.abs(c.height - 0.5) < 1e-3,
    JSON.stringify(c),
  );
});

test('colour balance: global and range settings add up; contrast becomes a tone curve', async () => {
  const values: number[] = Array(32).fill(0);
  Object.assign(values, { 12: 1, 14: 1, 28: 0.1845, 30: 0.1845 });
  values[17] = 0.2; // chroma global
  values[15] = 0.1; // chroma shadows
  values[19] = 0.3; // saturation global
  values[23] = 0.4; // hue angle
  values[31] = 0.25; // contrast
  const params = await packed([...values.map((v) => ['f32', v] as const), ['i32', 1]]);
  const { recipe } = (await importEdits(sidecar([{ operation: 'colorbalancergb', modversion: 5, params }]), {
    base: defaultEditParams,
    metadata,
  }))!;
  const cb = findModule(recipe, 'colorBalance')!.params;
  assert.deepEqual(
    cb.chroma.map((v) => Math.round(v * 100) / 100),
    [0.3, 0.2, 0.2],
  );
  assert.deepEqual(
    cb.saturation.map((v) => Math.round(v * 100) / 100),
    [0.3, 0.3, 0.3],
  );
  const curve = findModule(recipe, 'toneCurve')!;
  assert.equal(curve.label, 'Colour balance contrast');
  // EV offsets growing with exposure, through 0 at middle grey (the fulcrum).
  assert.ok(curve.params.rgb[0]! < 0 && curve.params.rgb.at(-1)! > 0);
});

test("lens correction: the photo's own choice, with their corrections as strengths", async () => {
  const withLens = normalizeEditParams({
    ...defaultEditParams,
    modules: [{ kind: 'lens', id: 'lens', enabled: true, label: null, params: {} }, ...defaultEditParams.modules],
  });
  // Built field by field (the strings): distortion and vignetting, no TCA.
  const layout = new Layout([
    ['method', 'i32'],
    ['modify_flags', 'i32'],
    ['inverse', 'i32'],
    ['scale', 'f32'],
    ['crop', 'f32'],
    ['focal', 'f32'],
    ['aperture', 'f32'],
    ['distance', 'f32'],
    ['target_geom', 'i32'],
    ['camera', { char: 128 }],
    ['lens', { char: 128 }],
    ['tca_override', 'gboolean'],
    ['tca_r', 'f32'],
    ['tca_b', 'f32'],
    ['cor_dist_ft', 'f32'],
    ['cor_vig_ft', 'f32'],
    ['cor_ca_r_ft', 'f32'],
    ['cor_ca_b_ft', 'f32'],
    ['scale_md_v1', 'f32'],
    ['md_version', 'i32'],
    ['scale_md', 'f32'],
    ['has_been_set', 'gboolean'],
    ['v_strength', 'f32'],
    ['v_radius', 'f32'],
    ['v_steepness', 'f32'],
    ['reserved', { array: 'f32', n: 2 }],
  ]);
  const params = await encodeBlob(
    writeStruct(layout, { method: 1, modify_flags: 6, scale: 1, target_geom: 1, scale_md: 1 }),
  );
  const lens = findModule(
    (await importEdits(sidecar([{ operation: 'lens', modversion: 10, params }]), { base: withLens, metadata }))!.recipe,
    'lens',
  )!;
  assert.deepEqual([lens.params.distortion, lens.params.vignetting, lens.params.tca], [1, 1, 0]);
  // None in their history: none here either.
  const none = (await importEdits(sidecar([{ operation: 'rawprepare' }]), { base: withLens, metadata }))!;
  assert.equal(findModule(none.recipe, 'lens'), undefined);
});

test("tone equalizer: our Tones preserving detail, nodes where their mask's −8 … 0 EV are", async () => {
  const sliders = [0, 0, 0, 0.5, 0.5, 0, 0, -1, -1];
  const params = await packed([...f32s(...sliders, 5, Math.SQRT2, 1, 0, 0, -1), ['i32', 4], ['i32', 4], ['i32', 1]]);
  const { recipe } = (await importEdits(sidecar([{ operation: 'toneequal', modversion: 2, params }]), {
    base: defaultEditParams,
    metadata,
  }))!;
  const t = findModule(recipe, 'toneCurve')!.params;
  assert.deepEqual([t.preserveDetail, t.preserveColors, t.smoothing, t.edgeRefinement], [true, 'norm', 0.05, 1]);
  // Mask: the 2-norm (√3 a grey's value), 1 EV down: its 0 EV is a grey at log2(2 / (√3·0.1845)) EV.
  assert.ok(Math.abs(t.range[1]! - Math.log2(2 / (Math.sqrt(3) * 0.1845))) < 1e-3, `${t.range}`);
  assert.ok(Math.abs(t.range[1]! - t.range[0]! - 8) < 1e-3);
  // The fitted Gaussians pass near the sliders.
  t.rgb.forEach((v, i) => assert.ok(Math.abs(v - sliders[i]!) < 0.15, `node ${i}: ${v} vs ${sliders[i]}`));
});
