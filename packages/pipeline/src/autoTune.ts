/**
 * Auto-tunes asked for by presets and styles (roadmap 8.7). Applying one marks the
 * instances whose auto-tune is to run (`autoTune: true`); whoever renders the recipe
 * next with the image at hand resolves them: the server while rendering the library's
 * preview (then writes the result into the history entry), or the developer (as part
 * of the edit that applied the preset, or once the photo is opened).
 *
 * The measures are taken on a render of a fixed size (`AUTO_TUNE_SIZE`), so that they
 * depend on the recipe and the image only, not on where they're taken: the zoom, the
 * preview's size. They match within ~0.03 EV between renderers; full size would differ
 * more for filmic's black exposure (noise in the deep shadows), not for the rest.
 */
import { type EditParams, type ModuleInstance, updateInstance } from './params.ts';

/** The long side of the render auto-tunes measure (the library's preview size). */
export const AUTO_TUNE_SIZE = 2048;

/** The measures auto-tunes need, on `recipe` rendered within `AUTO_TUNE_SIZE`. Null: nothing to measure. */
export interface AutoTuneMeasures {
  /** Filmic's white and black relative exposures (EV). */
  filmic(recipe: EditParams): [number, number] | null | Promise<[number, number] | null>;
  /** The node range that fits what tone curve instance `id` reads on its input (EV). */
  toneFit(recipe: EditParams, id: string): [number, number] | null | Promise<[number, number] | null>;
}

export const hasPendingAutoTune = (recipe: EditParams | null | undefined): boolean =>
  !!recipe?.modules.some((m) => m.autoTune);

/** Filmic's measured exposures, as the auto-tune button sets them. */
export const roundFilmicExposure = (v: number) => Math.round(v * 100) / 100;
/** A tone curve's fitted range, as the wand sets it. */
export const roundToneRange = (v: number) => Math.round(v * 10) / 10;

function settled(recipe: EditParams, id: string): EditParams {
  return {
    ...recipe,
    modules: recipe.modules.map((m) => {
      if (m.id !== id) return m;
      const { autoTune: _, ...rest } = m;
      return rest as ModuleInstance;
    }),
  };
}

/** `recipe` without its pending auto-tunes (e.g. when they can't run). */
export function clearAutoTunes(recipe: EditParams): EditParams {
  return recipe.modules.reduce((r, m) => (m.autoTune ? settled(r, m.id) : r), recipe);
}

/**
 * Run the pending auto-tunes of `recipe`, in pipeline order (a tone curve's range is
 * fitted before filmic measures what comes out of it), and clear their marks. One that
 * can't measure anything is cleared too, leaving its values as they were.
 */
export async function resolveAutoTunes(recipe: EditParams, measure: AutoTuneMeasures): Promise<EditParams> {
  let out = recipe;
  for (const m of recipe.modules) {
    if (!m.autoTune) continue;
    if (m.kind === 'toneCurve') {
      const fit = await measure.toneFit(out, m.id);
      if (fit)
        out = updateInstance(out, 'toneCurve', m.id, {
          params: { range: [roundToneRange(fit[0]), roundToneRange(fit[1])] },
        });
    } else if (m.kind === 'filmic') {
      const result = await measure.filmic(out);
      if (result) {
        const [white, black] = result.map(roundFilmicExposure) as [number, number];
        out = updateInstance(out, 'filmic', m.id, { params: { whiteExposure: white, blackExposure: black } });
      }
    }
    out = settled(out, m.id);
  }
  return out;
}

/** The measures of a pipeline `Developer` (in a worker or Node: it renders synchronously). */
export function developerMeasures(dev: {
  autoTuneFilmic(params: string, maxWidth: number, maxHeight: number): Float32Array | number[];
  toneCurveInput(params: string, id: string, maxWidth: number, maxHeight: number): Float32Array | number[];
}): AutoTuneMeasures {
  return {
    filmic: (recipe) => {
      const [white, black] = dev.autoTuneFilmic(JSON.stringify(recipe), AUTO_TUNE_SIZE, AUTO_TUNE_SIZE);
      return white === undefined || black === undefined ? null : [white, black];
    },
    toneFit: (recipe, id) => {
      const [low, high] = dev.toneCurveInput(JSON.stringify(recipe), id, AUTO_TUNE_SIZE, AUTO_TUNE_SIZE);
      return low === undefined || high === undefined ? null : [low, high];
    },
  };
}
