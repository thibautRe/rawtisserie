/**
 * LUT tables: one per id, packed (`Clut::to_packed`). Built-in ones ship with the app
 * (`builtinLutUrl`); uploaded ones are in the object store. No database here: worker
 * threads read LUTs through this.
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { LUT_ID, isBuiltinLut } from '@rawtisserie/pipeline';
import { builtinLutUrl } from '@rawtisserie/pipeline/node';
import { storage } from '../storage/index.ts';

export const uploadedLutKey = (id: string) => `luts/${id.slice(0, 2)}/${id}.clut`;

function checked(id: string): string {
  if (!LUT_ID.test(id)) throw new Error(`invalid LUT id ${id}`);
  return id;
}

/** A LUT's packed table, or null when it isn't stored. */
export async function readLut(id: string): Promise<Buffer | null> {
  return isBuiltinLut(checked(id)) ? readFile(builtinLutUrl(id)) : storage.read(uploadedLutKey(id));
}

/** A LUT's packed table as a stream, or null when it isn't stored. */
export async function streamLut(id: string): Promise<Readable | null> {
  return isBuiltinLut(checked(id)) ? createReadStream(builtinLutUrl(id)) : storage.get(uploadedLutKey(id));
}

/** Store a packed LUT under its id (a concurrent upload of the same LUT writes the same bytes). */
export async function storeLut(id: string, packed: Uint8Array): Promise<void> {
  await storage.put(uploadedLutKey(checked(id)), packed);
}

export async function deleteLut(id: string): Promise<void> {
  await storage.delete(uploadedLutKey(checked(id)));
}
