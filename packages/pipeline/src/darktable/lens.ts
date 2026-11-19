/**
 * darktable's lens correction (`lens.cc`, v10: embedded metadata, lensfun or a manual
 * vignette) and Ansel's (`lens.c`, v5: lensfun) as ours. Which correction applies is
 * what our own defaults chose for the photo (the file's embedded data, else lensfun's
 * profile for its camera and lens, in the starting recipe); theirs sets the strengths:
 * the corrections it applies, with their fine-tuning.
 */
import type { ModuleInstance } from '../params.ts';
import { Layout } from './struct.ts';
import { type Translation, type Translator, instance, unreadable } from './translate.ts';

const LENS_DT_V10 = new Layout([
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
const LENS_ANSEL_V5 = new Layout([
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
  ['modified', 'i32'],
]);

/** `DT_IOP_LENS_METHOD_*`, and the `modify_flags` bits: darktable's own, Ansel's lensfun's (`LF_MODIFY_*`). */
const EMBEDDED = 0;
const ONLY_VIGNETTE = 2;
const TCA = 1;
const VIGNETTING = 2;
const DISTORTION_DT = 4;
const DISTORTION_LENSFUN = 8;
/** Rectilinear, in both (`dt_iop_lens_lenstype_t`, `dt_lens_type_t`). */
const RECTILINEAR = 1;

export const lens: Translator = {
  operations: ['lens'],
  kinds: ['lens'],
  translate(entry, bytes, { base, metadata }): Translation {
    const dt = entry.modversion === 10;
    const p = (dt ? LENS_DT_V10 : entry.modversion === 5 ? LENS_ANSEL_V5 : null)?.read(bytes) as Record<
      string,
      number
    > | null;
    if (!p) return unreadable(entry);
    const ours = base.modules.find((m): m is ModuleInstance<'lens'> => m.kind === 'lens');
    if (dt && p.method === ONLY_VIGNETTE)
      return { instance: null, status: 'skipped', note: 'Only its manual vignette' };
    if (!ours) return { instance: null, status: 'skipped', note: 'No correction data for this lens here' };
    const notes: string[] = [];
    const flags = p.modify_flags!;
    const embedded = dt && p.method === EMBEDDED;
    const fine = (k: string) => (embedded ? p[k]! : 1);
    const strengths = {
      distortion: flags & (dt ? DISTORTION_DT : DISTORTION_LENSFUN) ? fine('cor_dist_ft') : 0,
      vignetting: flags & VIGNETTING ? fine('cor_vig_ft') : 0,
      tca: flags & TCA ? (fine('cor_ca_r_ft') + fine('cor_ca_b_ft')) / 2 : 0,
    };
    const usesLensfun = !!ours.params.lensfun;
    if (embedded && usesLensfun) notes.push("With lensfun's profile (the file's own data isn't read here)");
    if (!embedded && !usesLensfun) notes.push("With the file's own correction data rather than lensfun's");
    if (p.inverse) notes.push('Its "distort" mode left out');
    if (!embedded && p.target_geom !== RECTILINEAR) notes.push('Projection change left out');
    if (p.tca_override) notes.push('Manual TCA left out');
    if (dt && p.v_strength! > 0) notes.push('Manual vignette left out');
    return {
      instance: instance('lens', { ...structuredClone(ours.params), ...strengths }),
      status: notes.length ? 'approximated' : 'mapped',
      ...(notes.length && { note: notes.join('. ') }),
    };
  },
};
