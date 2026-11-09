import { AUTO_TUNE_SIZE, type AutoTuneMeasures } from '@rawtisserie/pipeline';
import type { RenderBackend } from './renderBackend.ts';

/** Auto-tune measures (roadmap 8.7) taken by a render backend, at the fixed `AUTO_TUNE_SIZE`. */
export function backendMeasures(backend: RenderBackend): AutoTuneMeasures {
  return {
    filmic: async (recipe) => {
      const result = await backend.autoTuneFilmic(recipe, AUTO_TUNE_SIZE, AUTO_TUNE_SIZE);
      return result && [result.white, result.black];
    },
    toneFit: async (recipe, id) => {
      const input = await backend.toneCurveInput(recipe, id, AUTO_TUNE_SIZE, AUTO_TUNE_SIZE);
      return input && [input.fit[0], input.fit[1]];
    },
  };
}
