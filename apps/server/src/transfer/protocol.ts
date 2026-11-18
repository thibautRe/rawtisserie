/**
 * What two instances say to each other when one sends a user's versions, presets,
 * styles and LUTs to the other (`send.ts` → `receive.ts`). Both ends are this code, maybe
 * at different releases: `PROTOCOL` changes when they'd no longer understand each other.
 */
import { z } from 'zod';
import { CollectionPath } from '../photos/collections.ts';
import { HistoryEntryInput, Sha256, VersionPatch } from '../photos/routes.ts';

export const PROTOCOL = 1;

/** `GET /api/transfer/hello`: who's there. */
export const Hello = z.object({
  protocol: z.number().int(),
  /** The instance's id (`instance` table). */
  instance: z.uuid(),
  /** The newest recipe version it can read (`EDIT_PARAMS_VERSION`). */
  editParamsVersion: z.number().int(),
  /** The account the token is for. */
  account: z.object({ displayName: z.string(), email: z.string() }),
});
export type Hello = z.infer<typeof Hello>;

/** Where a copy comes from: the sending instance and its version (or preset) id. */
export const Origin = z.object({
  instance: z.uuid(),
  id: z.uuid(),
  /** How the sender calls itself, for "Sent from …" (its address). */
  label: z.string().trim().min(1).max(200),
});

/** A photo's value as files carry it (longer than an edit may make it). */
const fileText = z.string().max(5000).nullable().optional();
const fileNumber = z.number().nonnegative().nullable().optional();

/**
 * The library's edits, but with the photo's values as files carry them: a manual lens
 * records an aperture and focal length of 0, which an edit couldn't set, and the copy
 * must have them as they are.
 */
const SentPatch = VersionPatch.extend({
  cameraMake: fileText,
  cameraModel: fileText,
  lens: fileText,
  artist: fileText,
  copyright: fileText,
  iso: fileNumber,
  exposureTime: fileNumber,
  fNumber: fileNumber,
  focalLength: fileNumber,
});

/** `POST /api/transfer/versions` (the `meta` field, before the original if it's needed). */
export const SentVersion = z.object({
  origin: Origin,
  /** The transfer: the receiver shows what it brought as one import. */
  importId: z.uuid(),
  sha256: Sha256,
  filename: z.string().trim().min(1).max(500),
  /** The original's modification time when it was imported (ms since the epoch), if known. Optional: added after `PROTOCOL` 1. */
  fileModifiedAt: z.number().int().nullable().optional(),
  /**
   * The photo's collection, as a path of names (made on the receiving side if needed).
   * Optional: added after `PROTOCOL` 1 (an older receiver ignores it).
   */
  collection: CollectionPath.nullable().optional(),
  /** Culling, metadata and the photo's corrections, as the library edits them. */
  patch: SentPatch,
  /** The photo's extracted metadata, so the receiver doesn't extract it over the corrections. */
  exif: z.record(z.string(), z.unknown()).nullable(),
  history: z.object({ end: z.number().int().min(0), entries: z.array(HistoryEntryInput).max(5000) }),
});
export type SentVersion = z.infer<typeof SentVersion>;

/** `PUT /api/transfer/presets`: a module preset or a style. */
export const SentPreset = z.object({
  origin: Origin,
  kind: z.enum(['module', 'style']),
  moduleKind: z.string().max(50).nullable(),
  name: z.string().trim().min(1).max(200),
  payload: z.record(z.string(), z.unknown()),
});
export type SentPreset = z.infer<typeof SentPreset>;

export type ReceivedStatus = 'created' | 'updated';
