#!/usr/bin/env node
// Build lensfun's database for lens correction (roadmap 3.6):
// packages/pipeline/lensfun/lensfun.json, from lensfun's data/db (CC BY-SA 3.0),
// pinned to a lensfun commit. `packages/pipeline/src/lensfun.ts` reads it: matching,
// interpolation and the profile a recipe keeps are there, not here.
//
// The file keeps what lensfun's loader (`database.cpp`) reads, compacted: mounts and
// their compatible mounts; cameras (makers and models in every language, mount, crop
// factor), with the names rawler gives them (`rawler`: its clean make and model, joined
// on the make and model the file says, which lensfun records); lenses (names, mounts,
// crop factor and aspect ratio of the calibration, type, focal and aperture ranges
// when given) and their calibrations, terms in lensfun's order with its defaults:
//   distortion: [focal, model, ...terms]  poly3: k1; poly5: k1, k2; ptlens: a, b, c
//   tca:        [focal, model, ...terms]  linear: kr, kb; poly3: vr, vb, cr, cb, br, bb
//   vignetting: [focal, aperture, distance, k1, k2, k3]  (pa)
// Models this app doesn't evaluate (acm, none) are left out, with a count.
//
// Run again after updating rawler (it reads the one Cargo uses) or to take a newer
// lensfun: change LENSFUN. Recipes keep their interpolated profile, so an update only
// changes what new photos (or a lens picked again) get.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const LENSFUN = '37238fcef563196fb798f6151cb9023968b26c40';
const out = new URL('../packages/pipeline/lensfun/lensfun.json', import.meta.url);

// ── A tarball of the pinned commit: its data/db/*.xml ──
const res = await fetch(`https://codeload.github.com/lensfun/lensfun/tar.gz/${LENSFUN}`);
if (!res.ok) throw new Error(`lensfun ${LENSFUN}: ${res.status}`);
const tar = gunzipSync(Buffer.from(await res.arrayBuffer()));
const files = new Map();
for (let at = 0; at + 512 <= tar.length;) {
  const header = tar.subarray(at, at + 512);
  const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
  if (!name) break;
  const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
  const size = parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
  const full = prefix ? `${prefix}/${name}` : name;
  if (/\/data\/db\/[^/]+\.xml$/.test(full))
    files.set(path.basename(full), tar.toString('utf8', at + 512, at + 512 + size));
  at += 512 + Math.ceil(size / 512) * 512;
}
if (!files.size) throw new Error('no data/db/*.xml in the tarball');

// ── XML, as lensfun writes it: elements, attributes, text, comments ──
const unescape = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
function parse(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const token =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:-]+)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  for (const [all, close, name, attrText, selfClosing, text] of xml.matchAll(token)) {
    const top = stack.at(-1);
    if (text !== undefined) top.text += unescape(text);
    if (!name) {
      if (all.startsWith('<') && !/^<(!--|\?|!DOCTYPE)/.test(all)) throw new Error(`can't read ${all}`);
      continue;
    }
    if (close) {
      if (top.name !== name) throw new Error(`</${name}> closes <${top.name}>`);
      stack.pop();
      continue;
    }
    const attrs = Object.fromEntries(
      [...attrText.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map(([, k, v]) => [k, unescape(v)]),
    );
    const node = { name, attrs, children: [], text: '' };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`<${stack.at(-1).name}> isn't closed`);
  return root;
}
const all = (node, name) => node.children.filter((c) => c.name === name);
const one = (node, name) => all(node, name)[0];
const text = (node) => node.text.trim().replace(/\s+/g, ' ');
/** A multilingual string: the default (no `lang`) first. */
const names = (node, name) => {
  const list = all(node, name).sort((a, b) => Number('lang' in a.attrs) - Number('lang' in b.attrs));
  return [...new Set(list.map(text))];
};
const num = (v, fallback = 0) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const mounts = {};
const cameras = [];
const lenses = [];
const skipped = { distortion: 0, tca: 0, vignetting: 0 };
for (const [file, xml] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  const db = one(parse(xml), 'lensdatabase');
  if (!db) throw new Error(`${file}: no <lensdatabase>`);
  if (db.attrs.version !== '2') throw new Error(`${file}: database version ${db.attrs.version}, expected 2`);
  for (const m of all(db, 'mount')) mounts[text(one(m, 'name'))] = all(m, 'compat').map(text);
  for (const c of all(db, 'camera')) {
    cameras.push({
      maker: names(c, 'maker'),
      model: names(c, 'model'),
      mount: text(one(c, 'mount')),
      crop: num(text(one(c, 'cropfactor') ?? { text: '' }), 1),
    });
  }
  for (const l of all(db, 'lens')) {
    const sets = all(l, 'calibration');
    if (sets.length > 1 || sets.some((s) => Object.keys(s.attrs).length))
      throw new Error(`${file}: ${names(l, 'model')[0]} has calibration sets of their own: read them`);
    const lens = {
      maker: names(l, 'maker'),
      model: names(l, 'model'),
      mounts: all(l, 'mount').map(text),
      crop: num(one(l, 'cropfactor') && text(one(l, 'cropfactor')), 1),
    };
    const aspect = one(l, 'aspect-ratio') && text(one(l, 'aspect-ratio'));
    if (aspect) {
      // "3:2" or "1.5"
      const [w, h] = aspect.split(':').map(Number);
      lens.aspect = h ? w / h : w;
    }
    const type = one(l, 'type') && text(one(l, 'type'));
    if (type && type !== 'rectilinear') lens.type = type;
    for (const range of ['focal', 'aperture']) {
      const r = one(l, range);
      if (r) lens[range] = [num(r.attrs.min ?? r.attrs.value), num(r.attrs.max ?? r.attrs.value)];
    }
    const calib = sets[0];
    if (calib) {
      const distortion = [];
      for (const { attrs: a } of all(calib, 'distortion')) {
        const focal = num(a.focal);
        if (a.model === 'poly3') distortion.push([focal, 'poly3', num(a.k1)]);
        else if (a.model === 'poly5') distortion.push([focal, 'poly5', num(a.k1), num(a.k2)]);
        else if (a.model === 'ptlens') distortion.push([focal, 'ptlens', num(a.a), num(a.b), num(a.c)]);
        else skipped.distortion++;
      }
      const tca = [];
      for (const { attrs: a } of all(calib, 'tca')) {
        const focal = num(a.focal);
        if (a.model === 'linear') tca.push([focal, 'linear', num(a.kr, 1), num(a.kb, 1)]);
        else if (a.model === 'poly3')
          tca.push([focal, 'poly3', num(a.vr, 1), num(a.vb, 1), num(a.cr), num(a.cb), num(a.br), num(a.bb)]);
        else skipped.tca++;
      }
      const vignetting = [];
      for (const { attrs: a } of all(calib, 'vignetting')) {
        if (a.model === 'pa')
          vignetting.push([num(a.focal), num(a.aperture), num(a.distance), num(a.k1), num(a.k2), num(a.k3)]);
        else skipped.vignetting++;
      }
      if (distortion.length) lens.distortion = distortion;
      if (tca.length) lens.tca = tca;
      if (vignetting.length) lens.vignetting = vignetting;
    }
    lenses.push(lens);
  }
}

// ── rawler's names for the cameras: joined on the file's make and model ──
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
// As lensfun's `_lf_strcmp`: ignoring case, and spaces at either end or repeated.
const fold = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const byExif = new Map();
for (const c of cameras)
  for (const maker of c.maker) for (const model of c.model) byExif.set(`${fold(maker)}\0${fold(model)}`, c);
let joined = 0;
for (const file of tomls(camerasDir)) {
  const { make, model, clean_make: cleanMake, clean_model: cleanModel } = topLevel(readFileSync(file, 'utf8'));
  if (!make || !model || !cleanMake || !cleanModel) continue;
  const camera = byExif.get(`${fold(make)}\0${fold(model)}`);
  if (!camera) continue;
  camera.rawler ??= [];
  if (!camera.rawler.some(([m, mo]) => m === cleanMake && mo === cleanModel)) {
    camera.rawler.push([cleanMake, cleanModel]);
    joined++;
  }
}

const db = {
  source: `lensfun ${LENSFUN}, data/db`,
  license: 'CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/), the lensfun project',
  mounts,
  cameras,
  lenses,
};
mkdirSync(new URL('.', out), { recursive: true });
// One record per line: diffs between updates stay readable.
const lines = (list) => list.map((x) => `    ${JSON.stringify(x)}`).join(',\n');
writeFileSync(
  out,
  `{\n  "source": ${JSON.stringify(db.source)},\n  "license": ${JSON.stringify(db.license)},\n` +
    `  "mounts": ${JSON.stringify(mounts)},\n  "cameras": [\n${lines(cameras)}\n  ],\n` +
    `  "lenses": [\n${lines(lenses)}\n  ]\n}\n`,
);
const size = readFileSync(out).length;
console.log(
  `${lenses.length} lenses, ${cameras.length} cameras (${joined} rawler names joined), ` +
    `${Object.keys(mounts).length} mounts; ${(size / 1024).toFixed(0)} KiB; ` +
    `left out: ${Object.entries(skipped)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ')}`,
);
