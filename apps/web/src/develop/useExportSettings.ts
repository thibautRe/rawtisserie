import { useMemo } from 'react';
import type { ExportPreset, ExportSettings } from '@rawtisserie/pipeline';
import {
  useDeleteExportPreset,
  useExportSettings,
  useMe,
  useSaveExportPreset,
  useSaveLastExportSettings,
} from '../api/hooks.ts';
import { toaster } from '../components/toaster.tsx';
import { exportSettings, loadLocalExportSettings, saveLocalExportSettings } from './ExportDialog.tsx';
import { useStableCallback } from './useStableCallback.ts';

/**
 * The export dialog's settings and presets. With an account, the last export's
 * settings and the presets are the user's, on the server; without one (or before they
 * load), the last settings are this browser's.
 */
export function useExportSetup() {
  const { data: me } = useMe();
  const { data } = useExportSettings();
  const saveLast = useSaveLastExportSettings();
  const savePresetMutation = useSaveExportPreset();
  const deletePresetMutation = useDeleteExportPreset();

  const serverSettings = data?.settings;
  const initial = useMemo(
    () => (serverSettings ? exportSettings(serverSettings) : (loadLocalExportSettings() ?? exportSettings(undefined))),
    [serverSettings],
  );
  const presets = me ? (data?.presets ?? null) : null;

  /** Remember an export's settings for the next one. */
  const remember = useStableCallback((settings: ExportSettings) => {
    saveLocalExportSettings(settings);
    if (me) saveLast.mutate(settings);
  });
  const savePreset = useStableCallback((name: string, settings: ExportSettings) =>
    savePresetMutation.mutate(
      { name, settings },
      {
        onSuccess: (p) => toaster.create({ type: 'success', title: `Saved export preset “${p.name}”` }),
        onError: (err) =>
          toaster.create({ type: 'error', title: 'Could not save the preset', description: err.message }),
      },
    ),
  );
  const deletePreset = useStableCallback((preset: ExportPreset) =>
    deletePresetMutation.mutate(preset.id, {
      onSuccess: () => toaster.create({ type: 'info', title: `Deleted export preset “${preset.name}”` }),
      onError: (err) =>
        toaster.create({ type: 'error', title: 'Could not delete the preset', description: err.message }),
    }),
  );
  return { initial, presets, remember, savePreset, deletePreset };
}
