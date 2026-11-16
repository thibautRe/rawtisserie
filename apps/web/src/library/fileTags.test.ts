import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findXmp, iptcKeywords, mergeTags, parseXmp, readEmbedded, readFileTags } from './fileTags.ts';
import { type PickedFile, sortPicked } from './pickedFiles.ts';

/** As Lightroom writes it: every level in `dc:subject` too, the rating as an attribute. */
const LIGHTROOM = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
 <rdf:Description rdf:about="" xmp:Rating="4" xmp:Label="Green">
  <dc:subject><rdf:Bag><rdf:li>People</rdf:li><rdf:li>Alice</rdf:li><rdf:li>sunset</rdf:li><rdf:li>Rock &amp; Roll</rdf:li></rdf:Bag></dc:subject>
  <lr:hierarchicalSubject><rdf:Bag><rdf:li>People|Alice</rdf:li></rdf:Bag></lr:hierarchicalSubject>
 </rdf:Description></rdf:RDF></x:xmpmeta>`;

test('XMP: Lightroom keywords, hierarchy, rating and label', () => {
  assert.deepEqual(parseXmp(LIGHTROOM), {
    tags: ['People|Alice', 'sunset', 'Rock & Roll'],
    rating: 4,
    label: 'green',
  });
});

test('XMP: digiKam tags, darktable labels, a rejected photo, elements rather than attributes', () => {
  const digikam = `<x:xmpmeta><rdf:Description>
    <digiKam:TagsList><rdf:Seq><rdf:li>Places/France/Paris</rdf:li></rdf:Seq></digiKam:TagsList>
    <xmp:Rating>-1</xmp:Rating>
    <darktable:colorlabels><rdf:Seq><rdf:li>4</rdf:li></rdf:Seq></darktable:colorlabels>
  </rdf:Description></x:xmpmeta>`;
  assert.deepEqual(parseXmp(digikam), { tags: ['Places|France|Paris'], rejected: true, label: 'purple' });
  assert.deepEqual(parseXmp('<x:xmpmeta xmp:Rating="0" xmp:Label="Second"></x:xmpmeta>'), {});
});

/** A JPEG's start: SOI, an APP1 XMP segment, an APP13 IPTC one, then SOS. */
function jpeg({ xmp, keywords }: { xmp?: string; keywords?: string[] }): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const segment = (marker: number, data: Uint8Array) => {
    const out = new Uint8Array(4 + data.length);
    out.set([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]);
    out.set(data, 4);
    return out;
  };
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (xmp) parts.push(segment(0xe1, enc.encode(`http://ns.adobe.com/xap/1.0/\0${xmp}`)));
  if (keywords) {
    const records = keywords.flatMap((k) => {
      const b = enc.encode(k);
      return [0x1c, 2, 25, b.length >> 8, b.length & 0xff, ...b];
    });
    const size = records.length;
    const block = [
      ...enc.encode('8BIM'),
      0x04,
      0x04,
      0,
      0,
      ...[size >>> 24, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff],
      ...records,
      ...(size % 2 ? [0] : []),
    ];
    parts.push(segment(0xed, new Uint8Array([...enc.encode('Photoshop 3.0\0'), ...block])));
  }
  parts.push(new Uint8Array([0xff, 0xda, 0, 2, 1, 2, 3]));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
}

test('embedded: XMP found in a JPEG, IPTC keywords when there is no XMP', async () => {
  const withXmp = jpeg({ xmp: LIGHTROOM, keywords: ['ignored'] });
  assert.match(findXmp(withXmp)!, /^<x:xmpmeta/);
  assert.deepEqual((await readEmbedded(new Blob([withXmp]))).tags, ['People|Alice', 'sunset', 'Rock & Roll']);

  const iptc = jpeg({ keywords: ['été', 'Paris'] });
  assert.deepEqual(iptcKeywords(iptc), ['été', 'Paris']);
  assert.deepEqual(await readEmbedded(new Blob([iptc])), { tags: ['été', 'Paris'] });
  assert.deepEqual(await readEmbedded(new Blob([jpeg({})])), {});
});

test('merged: tags together, the first rating and label; a rating wins over a rejection', () => {
  assert.deepEqual(
    mergeTags([{ tags: ['a'], label: 'red' }, { tags: ['a', 'b'], rating: 2, label: 'blue' }, { rejected: true }]),
    { tags: ['a', 'b'], rating: 2, label: 'red' },
  );
  assert.deepEqual(mergeTags([{}, { rejected: true }]), { rejected: true });
});

const file = (path: string, bytes: Uint8Array | string = ''): PickedFile => ({
  path,
  file: new File([bytes as BlobPart], path.split('/').at(-1)!),
});

test('a RAW file gets the tags of the JPEG next to it, and of its sidecar', async () => {
  const picked = sortPicked([
    file('DCIM/DSC1.ARW'),
    file('DCIM/DSC1.JPG', jpeg({ xmp: LIGHTROOM })),
    file('DCIM/DSC2.ARW'),
    file('DCIM/DSC2.ARW.xmp', '<x:xmpmeta xmp:Rating="5"><dc:subject><rdf:Bag><rdf:li>dog</rdf:li></rdf:Bag></dc:subject></x:xmpmeta>'),
    file('DCIM/DSC3.ARW'),
    file('DCIM/IMG4.jpg', jpeg({ keywords: ['cat'] })),
  ]);
  // Sidecars aren't photos, nor files left out.
  assert.deepEqual(
    [picked.files.length, picked.pairs.length, picked.sidecars.length, picked.ignored],
    [4, 1, 1, 0],
  );
  const tags = await readFileTags(picked);
  const of = (path: string) => tags.get([...picked.files, ...picked.pairs].find((f) => f.path === path)!);
  assert.deepEqual(of('DCIM/DSC1.ARW'), { tags: ['People|Alice', 'sunset', 'Rock & Roll'], rating: 4, label: 'green' });
  assert.deepEqual(of('DCIM/DSC1.JPG'), of('DCIM/DSC1.ARW'));
  assert.deepEqual(of('DCIM/DSC2.ARW'), { tags: ['dog'], rating: 5 });
  assert.equal(of('DCIM/DSC3.ARW'), undefined);
  assert.deepEqual(of('DCIM/IMG4.jpg'), { tags: ['cat'] });
});
