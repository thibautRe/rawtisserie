#!/usr/bin/env node
// Build the camera noise profiles raw denoise conditions on (roadmap 3.5):
//
// - crates/pipeline/data/noiseprofiles.bin, from darktable/Ansel's
//   data/noiseprofiles.json (GPL-3.0), pinned to an Ansel commit;
// - crates/pipeline/data/noise-profile-aliases.json, the cameras the database files
//   under another name than rawler's.
//
// The database names cameras as darktable does: by rawspeed's canonical name for the
// camera (its `<ID>`), which folds variants into one (the A7R III A is "ILCE-7RM3") and
// spells some differently from rawler ("Z 6_2" for rawler's "Z 6 2"; "OM System" for
// "OM Digital Solutions"). Both rawler's camera files and rawspeed's cameras.xml record
// the make and model a file says (EXIF): joined on those, each rawler camera gets its
// canonical name, and an alias when the database has it only under that name.
//
// Run again after updating rawler (it reads the one Cargo uses), or with other pinned
// commits. Matching is the one `denoise::noise_profile` does: the database's maker
// within the camera's, the model equal, both ignoring case.
//
// noiseprofiles.bin (little-endian): "RTNP1\0", u32 model count, then per model: u8
// maker length, maker, u8 model length, model (UTF-8), u16 profile count, and per
// profile, by increasing ISO: f32 iso, f32 a[3], f32 b[3]. Profiles marked `skip` are
// left out.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ANSEL = '1061a7d021f3a2c6eb4781222a1387b4e540db30';
const RAWSPEED = '2baa3a2f4d67c6d4a9b8b763dd986c3449b6f969';
const out = (name) => new URL(`../crates/pipeline/data/${name}`, import.meta.url);

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res;
}

const { noiseprofiles } = await (
  await get(`https://raw.githubusercontent.com/aurelienpierreeng/ansel/${ANSEL}/data/noiseprofiles.json`)
).json();
const camerasXml = await (
  await get(`https://raw.githubusercontent.com/darktable-org/rawspeed/${RAWSPEED}/data/cameras.xml`)
).text();

// ── The profiles ──
const parts = [];
/** The database's cameras with profiles: [maker, model]. */
const profiled = [];
const u8 = (n) => parts.push(Buffer.from([n]));
const str = (s) => {
  const b = Buffer.from(s, 'utf8');
  if (b.length > 255) throw new Error(`name too long: ${s}`);
  u8(b.length);
  parts.push(b);
};
for (const { maker, models: list } of noiseprofiles) {
  for (const { model, profiles } of list) {
    const kept = profiles.filter((p) => !p.skip).sort((a, b) => a.iso - b.iso);
    if (!kept.length) continue;
    profiled.push([maker, model]);
    str(maker);
    str(model);
    const head = Buffer.alloc(2);
    head.writeUInt16LE(kept.length);
    parts.push(head);
    const body = Buffer.alloc(kept.length * 28);
    kept.forEach((p, i) => [p.iso, ...p.a, ...p.b].forEach((v, j) => body.writeFloatLE(v, i * 28 + j * 4)));
    parts.push(body);
  }
}
const count = Buffer.alloc(4);
count.writeUInt32LE(profiled.length);
const bin = Buffer.concat([Buffer.from('RTNP1\0'), count, ...parts]);
writeFileSync(out('noiseprofiles.bin'), bin);

/** The database's entry for a camera, as `noise_profile` finds it. */
const findProfiled = (make, model) =>
  profiled.find(([m, mo]) => make.toLowerCase().includes(m.toLowerCase()) && model.toLowerCase() === mo.toLowerCase());

// ── rawspeed: the file's make and model (and its aliases) → the canonical name ──
const unescape = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? unescape(m[1]) : null;
};
const canonical = new Map();
const key = (make, model) => `${make.trim()}\u0000${model.trim()}`;
for (const [, open, body] of camerasXml.matchAll(/<Camera\b([^>]*)>([\s\S]*?)<\/Camera>/g)) {
  const make = attr(open, 'make');
  const model = attr(open, 'model');
  const id = body.match(/<ID\b[^>]*>/)?.[0];
  if (!make || !model || !id) continue;
  const name = { make: attr(id, 'make'), model: attr(id, 'model') };
  if (!name.make || !name.model) continue;
  const aliases = [...body.matchAll(/<Alias\b([^>]*)>([^<]*)<\/Alias>/g)].flatMap(([, a, text]) =>
    [unescape(text), attr(a, 'id')].filter(Boolean),
  );
  for (const m of [model, ...aliases]) if (!canonical.has(key(make, m))) canonical.set(key(make, m), name);
}

// ── rawler: its cameras, with the file's names and its own ──
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1'], { encoding: 'utf8' }));
const rawler = metadata.packages.find((p) => p.name === 'rawler');
const camerasDir = path.join(path.dirname(rawler.manifest_path), 'data', 'cameras');
const tomls = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tomls(path.join(dir, e.name)) : e.name.endsWith('.toml') ? [path.join(dir, e.name)] : [],
  );
/** The `key = "value"` lines before the first table. */
const topLevel = (text) => {
  const fields = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) break;
    const m = line.match(/^(\w+)\s*=\s*"([^"]*)"/);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
};

const aliases = new Map();
let direct = 0;
let none = 0;
for (const file of tomls(camerasDir)) {
  const { make, model, clean_make: cleanMake, clean_model: cleanModel } = topLevel(readFileSync(file, 'utf8'));
  if (!make || !model || !cleanMake || !cleanModel) continue;
  if (findProfiled(cleanMake, cleanModel)) {
    direct++;
    continue;
  }
  const name = canonical.get(key(make, model));
  const entry = name && findProfiled(name.make, name.model);
  if (entry) aliases.set(key(cleanMake, cleanModel), [cleanMake, cleanModel, ...entry]);
  else none++;
}
const list = [...aliases.values()].sort((a, b) => a.join(' ').localeCompare(b.join(' ')));
writeFileSync(out('noise-profile-aliases.json'), `[\n${list.map((a) => `  ${JSON.stringify(a)}`).join(',\n')}\n]\n`);
console.log(
  `${profiled.length} profiled models (${bin.length} bytes); rawler ${rawler.version}: ` +
    `${direct} cameras by their own name, ${list.length} through an alias, ${none} without a profile`,
);
