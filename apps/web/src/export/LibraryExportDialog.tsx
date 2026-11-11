import type { ExportSettings } from '@rawtisserie/pipeline';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Photo } from '../api/types.ts';
import { toaster } from '../components/toaster.tsx';
import { ExportDialog } from '../develop/ExportDialog.tsx';
import { photoFilenameFields } from '../develop/exportInfo.ts';
import { useExportSetup } from '../develop/useExportSettings.ts';
import { useStableCallback } from '../develop/useStableCallback.ts';
import { startExport } from './bulkExport.ts';

/**
 * The export dialog for library photos (roadmap 8.4): the developer's settings and
 * presets, with `preview` (one of them) shown in the frame preview, then the export runs
 * in the background (`startExport`).
 */
export function LibraryExportDialog({
  photos,
  preview,
  onClose,
}: {
  /** The photos to export, in order; null when closed. */
  photos: readonly Photo[] | null;
  preview: Photo | null;
  onClose: () => void;
}) {
  const setup = useExportSetup();
  const image = useRef<HTMLImageElement | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const url = photos ? preview?.previewUrl : null;
  useEffect(() => {
    setImageSize(null);
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      image.current = img;
      setImageSize({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = url;
    return () => {
      img.onload = null;
    };
  }, [url]);

  // The last photos stay while the dialog closes, so its title doesn't change as it fades.
  const [shown, setShown] = useState(photos);
  if (photos && photos !== shown) setShown(photos);
  const fields = useMemo(() => (shown ?? []).map(photoFilenameFields), [shown]);
  const onExport = useStableCallback((settings: ExportSettings) => {
    if (!photos) return;
    setup.remember(settings);
    if (!startExport(photos, settings))
      toaster.create({ type: 'info', title: 'An export is already running', duration: 3000 });
  });

  return (
    <ExportDialog
      open={!!photos}
      source={image}
      imageSize={imageSize}
      exact={false}
      initial={setup.initial}
      presets={setup.presets}
      filenameFields={fields}
      onClose={onClose}
      onExport={onExport}
      onSavePreset={setup.savePreset}
      onDeletePreset={setup.deletePreset}
    />
  );
}
