/**
 * darktable's and Ansel's diffuse or sharpen (`diffuse.c`: darktable's v2, Ansel's v3,
 * the same struct and, as Ansel is built, the same band weighting) as ours, a port of
 * Ansel's: parameter for parameter, in the same units.
 */
import type { ModuleParams } from '../params.ts';
import { Layout } from './struct.ts';
import { type Translation, type Translator, instance, unreadable } from './translate.ts';

const DIFFUSE = new Layout([
  ['iterations', 'i32'],
  ['sharpness', 'f32'],
  ['radius', 'i32'],
  ['regularization', 'f32'],
  ['variance_threshold', 'f32'],
  ['anisotropy_first', 'f32'],
  ['anisotropy_second', 'f32'],
  ['anisotropy_third', 'f32'],
  ['anisotropy_fourth', 'f32'],
  ['threshold', 'f32'],
  ['first', 'f32'],
  ['second', 'f32'],
  ['third', 'f32'],
  ['fourth', 'f32'],
  ['radius_center', 'i32'],
]);

export const diffuse: Translator = {
  operations: ['diffuse'],
  kinds: ['diffuse'],
  translate(entry, bytes): Translation {
    const p =
      entry.modversion === 2 || entry.modversion === 3 ? (DIFFUSE.read(bytes) as Record<string, number> | null) : null;
    if (!p) return unreadable(entry);
    const params: ModuleParams['diffuse'] = {
      iterations: p.iterations!,
      radiusCenter: p.radius_center!,
      radius: p.radius!,
      speed1: p.first!,
      speed2: p.second!,
      speed3: p.third!,
      speed4: p.fourth!,
      anisotropy1: p.anisotropy_first!,
      anisotropy2: p.anisotropy_second!,
      anisotropy3: p.anisotropy_third!,
      anisotropy4: p.anisotropy_fourth!,
      sharpness: p.sharpness!,
      edgeSensitivity: p.regularization!,
      edgeThreshold: p.variance_threshold!,
      luminanceThreshold: p.threshold!,
    };
    return { instance: instance('diffuse', params), status: 'mapped' };
  },
};
