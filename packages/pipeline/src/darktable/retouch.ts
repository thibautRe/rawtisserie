/**
 * darktable's (`retouch.c`, v3) and Ansel's (v4) retouch as ours, a port of Ansel's:
 * each of their forms (`rt_forms`, the shapes in `masks_history`) is a spot, in list
 * order, with its algorithm (clone, heal, blur, fill), its shape (`shapeOf`: in the
 * same sensor coordinates), its source as an offset (`mask_src`, from the shape's
 * centre or first node) and its opacity in the module's group. Their forms' slots
 * start the struct in both versions (its tails differ). Retouching one wavelet scale
 * becomes retouching the whole.
 */
import { type ModuleParams, type Spot, defaultSpot } from '../params.ts';
import type { Shape } from '../shapes.ts';
import { BLEND_PARAMS, groupOpacities, shapeOf, sourceOffset } from './masks.ts';
import { Layout } from './struct.ts';
import { type Translation, type Translator, instance, unreadable } from './translate.ts';
import { decodeBlob } from './xmp.ts';

const FORMS = 300;
const FORM_DATA = new Layout([
  ['formid', 'i32'],
  ['scale', 'i32'],
  ['algorithm', 'i32'],
  ['blur_type', 'i32'],
  ['blur_radius', 'f32'],
  ['fill_mode', 'i32'],
  ['fill_color', { array: 'f32', n: 3 }],
  ['fill_brightness', 'f32'],
  ['distort_mode', 'i32'],
]);
/** `dt_iop_retouch_algo_type_t`. */
const MODES: Readonly<Record<number, Spot['mode']>> = { 1: 'clone', 2: 'heal', 3: 'blur', 4: 'fill' };
const FILL_COLOR = 1;
const BLUR_BILATERAL = 1;

export const retouch: Translator = {
  operations: ['retouch'],
  kinds: ['retouch'],
  async translate(entry, bytes, ctx): Promise<Translation> {
    if ((entry.modversion !== 3 && entry.modversion !== 4) || bytes.length < FORM_DATA.size * FORMS)
      return unreadable(entry);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const blend = entry.blendopParams ? await decodeBlob(entry.blendopParams) : null;
    const group = blend && BLEND_PARAMS.read(blend);
    const opacities = group ? await groupOpacities(ctx.forms, group.mask_id as number) : new Map<number, number>();
    const notes = new Set<string>();
    const spots: Spot[] = [];
    const shapes: Record<string, Shape> = {};
    for (let i = 0; i < FORMS; i++) {
      const d = FORM_DATA.readAt(view, i * FORM_DATA.size);
      const id = d.formid as number;
      if (!id) continue;
      const mode = MODES[d.algorithm as number];
      const form = ctx.forms.find((f) => f.id === id);
      if (!mode || !form) continue;
      const shape = await shapeOf(form, ctx.aspect, 1);
      if ('why' in shape) {
        notes.add(shape.why);
        continue;
      }
      if ((d.scale as number) !== 0) notes.add('Spots on one wavelet scale applied to the whole image');
      if (mode === 'blur' && d.blur_type === BLUR_BILATERAL) notes.add('Bilateral blur done as Gaussian');
      const key = `dt${id}`;
      shapes[key] = shape.shape;
      const [r, g, b] = d.fill_color as number[];
      const brightness = d.fill_brightness as number;
      const color: [number, number, number] =
        d.fill_mode === FILL_COLOR
          ? ([r! + brightness, g! + brightness, b! + brightness].map((v) => Math.max(0, v)) as [number, number, number])
          : [Math.max(0, brightness), Math.max(0, brightness), Math.max(0, brightness)];
      spots.push({
        ...defaultSpot,
        shape: key,
        mode,
        source: mode === 'clone' || mode === 'heal' ? await sourceOffset(form, shape.shape) : [0, 0],
        opacity: opacities.get(id) ?? 1,
        color,
        radius: Math.max(0.1, d.blur_radius as number),
      });
    }
    if (!spots.length) return { instance: null, status: 'skipped', note: [...notes].join('. ') || 'No spots' };
    const params: ModuleParams['retouch'] = { spots };
    return {
      instance: instance('retouch', params),
      shapes,
      status: notes.size ? 'approximated' : 'mapped',
      ...(notes.size && { note: [...notes].join('. ') }),
    };
  },
};
