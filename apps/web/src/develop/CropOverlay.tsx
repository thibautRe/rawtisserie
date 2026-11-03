import { Box } from '@chakra-ui/react';
import type { CropRect } from '@rawtisserie/pipeline';
import { useRef } from 'react';

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

interface Props {
  rect: CropRect;
  /** Required width/height ratio in pixels, or null for free-form. */
  aspect: number | null;
  /** Pixel aspect (width / height) of the uncropped frame. */
  frameAspect: number;
  onChange: (rect: CropRect) => void;
}

const MIN = 0.02;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Fit `rect` to an aspect ratio, keeping its centre and staying in the frame. */
export function constrainAspect(rect: CropRect, aspect: number | null, frameAspect: number): CropRect {
  if (!aspect) return rect;
  // In normalised units, width/height must equal aspect / frameAspect.
  const k = aspect / frameAspect;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  let w = Math.sqrt(rect.width * rect.height * k);
  let h = w / k;
  const scale = Math.min(1, 1 / w, 1 / h);
  w *= scale;
  h *= scale;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), width: w, height: h };
}

/** Interactive crop rectangle drawn over the (uncropped) preview. */
export function CropOverlay({ rect, aspect, frameAspect, onChange }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: Handle; start: CropRect; x: number; y: number } | null>(null);

  const onPointerDown = (handle: Handle) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { handle, start: rect, x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = box.current;
    if (!d || !el) return;
    const bounds = el.getBoundingClientRect();
    const dx = (e.clientX - d.x) / bounds.width;
    const dy = (e.clientY - d.y) / bounds.height;
    const s = d.start;
    if (d.handle === 'move') {
      onChange({ ...s, x: clamp(s.x + dx, 0, 1 - s.width), y: clamp(s.y + dy, 0, 1 - s.height) });
      return;
    }
    let { x, y, width, height } = s;
    let right = x + width;
    let bottom = y + height;
    if (d.handle.includes('w')) x = clamp(s.x + dx, 0, right - MIN);
    if (d.handle.includes('e')) right = clamp(right + dx, x + MIN, 1);
    if (d.handle.includes('n')) y = clamp(s.y + dy, 0, bottom - MIN);
    if (d.handle.includes('s')) bottom = clamp(bottom + dy, y + MIN, 1);
    width = right - x;
    height = bottom - y;
    if (aspect) {
      const k = aspect / frameAspect;
      // Drive by the dominant axis of the drag, then anchor the opposite edge.
      if (d.handle === 'n' || d.handle === 's' || Math.abs(dy) > Math.abs(dx)) width = height * k;
      else height = width / k;
      if (width > 1) [width, height] = [1, 1 / k];
      if (height > 1) [width, height] = [k, 1];
      if (d.handle.includes('w')) x = right - width;
      if (d.handle.includes('n')) y = bottom - height;
      x = clamp(x, 0, 1 - width);
      y = clamp(y, 0, 1 - height);
    }
    onChange({ x, y, width, height });
  };

  const handle = (h: Handle, css: Record<string, string>) => (
    <Box
      key={h}
      position="absolute"
      w="3"
      h="3"
      bg="white"
      borderRadius="2px"
      boxShadow="0 0 0 1px rgba(0,0,0,.5)"
      transform="translate(-50%, -50%)"
      cursor={`${h}-resize`}
      onPointerDown={onPointerDown(h)}
      {...css}
    />
  );

  const pct = (v: number) => `${v * 100}%`;
  return (
    <Box
      ref={box}
      position="absolute"
      inset="0"
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
      touchAction="none"
    >
      <Box
        position="absolute"
        left={pct(rect.x)}
        top={pct(rect.y)}
        w={pct(rect.width)}
        h={pct(rect.height)}
        boxShadow="0 0 0 9999px rgba(0,0,0,0.55)"
        outline="1px solid white"
        cursor="move"
        onPointerDown={onPointerDown('move')}
      >
        {/* rule of thirds */}
        {[1, 2].map((i) => (
          <Box
            key={`v${i}`}
            position="absolute"
            top="0"
            bottom="0"
            left={`${(i * 100) / 3}%`}
            borderLeft="1px solid rgba(255,255,255,.35)"
          />
        ))}
        {[1, 2].map((i) => (
          <Box
            key={`h${i}`}
            position="absolute"
            left="0"
            right="0"
            top={`${(i * 100) / 3}%`}
            borderTop="1px solid rgba(255,255,255,.35)"
          />
        ))}
        {handle('nw', { left: '0', top: '0' })}
        {handle('ne', { left: '100%', top: '0' })}
        {handle('sw', { left: '0', top: '100%' })}
        {handle('se', { left: '100%', top: '100%' })}
        {handle('n', { left: '50%', top: '0' })}
        {handle('s', { left: '50%', top: '100%' })}
        {handle('w', { left: '0', top: '50%' })}
        {handle('e', { left: '100%', top: '50%' })}
      </Box>
    </Box>
  );
}
