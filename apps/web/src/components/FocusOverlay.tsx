/**
 * Where a photo is in focus (roadmap 8.9), over it: its edges, more opaque the sharper
 * they are. Fills its parent, which must be the photo's box (it moves and zooms with it).
 */
import { Box } from '@chakra-ui/react';
import type { FocusView } from '@rawtisserie/pipeline';
import { memo, useEffect, useRef } from 'react';
import { focusOverlayPixels } from '../lib/focusOverlay.ts';

export const FocusOverlay = memo(function FocusOverlay({ view }: { view: FocusView }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    c.width = view.width;
    c.height = view.height;
    ctx.putImageData(new ImageData(focusOverlayPixels(view), view.width, view.height), 0, 0);
  }, [view]);
  return (
    <Box position="absolute" inset="0" pointerEvents="none" data-focus-overlay>
      <canvas ref={canvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
    </Box>
  );
});
