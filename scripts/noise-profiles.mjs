#!/usr/bin/env node
// Build crates/pipeline/data/noiseprofiles.bin, the camera noise profiles raw denoise
// conditions on (roadmap 3.5), from darktable/Ansel's data/noiseprofiles.json (GPL-3.0),
// pinned to an Ansel commit. Run again with another commit to update.
//
// Format (little-endian): "RTNP1\0", u32 model count, then per model: u8 maker length,
// maker, u8 model length, model (UTF-8), u16 profile count, and per profile, by
// increasing ISO: f32 iso, f32 a[3], f32 b[3]. Profiles marked `skip` are left out.
import { writeFileSync } from 'node:fs';

const COMMIT = '1061a7d021f3a2c6eb4781222a1387b4e540db30';
const url = `https://raw.githubusercontent.com/aurelienpierreeng/ansel/${process.argv[2] ?? COMMIT}/data/noiseprofiles.json`;
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: ${res.status}`);
const { noiseprofiles } = await res.json();

const parts = [];
let models = 0;
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
    models++;
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
count.writeUInt32LE(models);
const out = Buffer.concat([Buffer.from('RTNP1\0'), count, ...parts]);
writeFileSync(new URL('../crates/pipeline/data/noiseprofiles.bin', import.meta.url), out);
console.log(`${models} models, ${out.length} bytes`);
