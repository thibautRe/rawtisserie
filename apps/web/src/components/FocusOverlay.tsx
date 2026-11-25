/**
 * Where a photo is in focus (roadmap 8.9), over it: the sharp parts tinted, and the
 * focus area outlined. Fills its parent, which must be the photo's box (it moves and
 * zooms with it).
 */
import { Box } from '@chakra-ui/react';
import type { FocusView } from '@rawtisserie/pipeline';
import { memo, useEffect, useRef } from 'react';
import { FOCUS_TINT, focusOverlayPixels } from '../lib/focusOverlay.ts';

export const FocusOverlay = memo(function FocusOverlay({ view }: { view: FocusView }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    c.width = view.cols;
    c.height = view.rows;
    ctx.putImageData(new ImageData(focusOverlayPixels(view), view.cols, view.rows), 0, 0);
  }, [view]);
  const area = view.area;
  const tint = `rgb(${FOCUS_TINT.join(' ')})`;
  return (
    <Box position="absolute" inset="0" pointerEvents="none" data-focus-overlay>
      {/* Stretched smoothly: blobs rather than cells. */}
      <canvas ref={canvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      {area && (
        <Box
          position="absolute"
          borderWidth="2px"
          borderStyle="dashed"
          rounded="sm"
          style={{
            borderColor: tint,
            left: `${area.x * 100}%`,
            top: `${area.y * 100}%`,
            width: `${area.width * 100}%`,
            height: `${area.height * 100}%`,
          }}
        />
      )}
    </Box>
  );
});
