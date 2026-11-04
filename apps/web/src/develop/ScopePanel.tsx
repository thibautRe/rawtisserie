import { Box, Button, HStack, Heading, IconButton } from '@chakra-ui/react';
import { Activity, ChevronDown, ChevronRight, Columns3, Crosshair, type LucideIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { SCOPE_MODES, SKIN_TONE_ANGLE, type ScopeMode, VECTORSCOPE_ZOOMS, vectorscopePoint } from './scopes.ts';

/** Scope settings; display options, not part of the recipe. */
export interface ScopeSettings {
  open: boolean;
  mode: ScopeMode;
  /** Vectorscope magnification (`VECTORSCOPE_ZOOMS`). */
  zoom: number;
}

const DEFAULT_SCOPE: ScopeSettings = { open: true, mode: 'waveform', zoom: 1 };

/** Scope settings, remembered across sessions. */
export function useScopeSettings() {
  const [settings, setSettings] = useState<ScopeSettings>(() => {
    try {
      const saved = { ...DEFAULT_SCOPE, ...JSON.parse(localStorage.getItem('developer.scope') ?? '{}') };
      if (!SCOPE_MODES.includes(saved.mode)) return DEFAULT_SCOPE;
      return VECTORSCOPE_ZOOMS.includes(saved.zoom) ? saved : { ...saved, zoom: 1 };
    } catch {
      return DEFAULT_SCOPE;
    }
  });
  useEffect(() => localStorage.setItem('developer.scope', JSON.stringify(settings)), [settings]);
  const update = useCallback((patch: Partial<ScopeSettings>) => setSettings((s) => ({ ...s, ...patch })), []);
  return [settings, update] as const;
}

/** Height of a scope `width` CSS pixels wide. */
export const scopeHeight = (mode: ScopeMode, width: number) =>
  mode === 'vectorscope' ? width : Math.round(width * 0.6);

const MODES: { mode: ScopeMode; label: string; icon: LucideIcon }[] = [
  { mode: 'waveform', label: 'Waveform', icon: Activity },
  { mode: 'parade', label: 'RGB parade', icon: Columns3 },
  { mode: 'vectorscope', label: 'Vectorscope', icon: Crosshair },
];

const LINE = 'rgba(255, 255, 255, 0.16)';
/** Levels marked on the waveforms (dashed: 25 and 75 %), in %; 0 and 100 are the frame's edges. */
const LEVELS = [25, 50, 75];

function WaveformGraticule({ width, height, parade }: { width: number; height: number; parade: boolean }) {
  return (
    <>
      {LEVELS.map((l) => {
        const y = Math.round((1 - l / 100) * (height - 1)) + 0.5;
        return (
          <line key={l} x1={0} x2={width} y1={y} y2={y} stroke={LINE} strokeDasharray={l % 50 ? '2 3' : undefined} />
        );
      })}
      {parade &&
        [1, 2].map((i) => {
          const x = Math.round((i * width) / 3) + 0.5;
          return <line key={i} x1={x} x2={x} y1={0} y2={height} stroke={LINE} />;
        })}
    </>
  );
}

/** The primaries and secondaries (their 100 % targets). */
const TARGETS: { label: string; rgb: [number, number, number]; color: string }[] = [
  { label: 'R', rgb: [1, 0, 0], color: '#ff6060' },
  { label: 'Yl', rgb: [1, 1, 0], color: '#ffff60' },
  { label: 'G', rgb: [0, 1, 0], color: '#60ff60' },
  { label: 'Cy', rgb: [0, 1, 1], color: '#60ffff' },
  { label: 'B', rgb: [0, 0, 1], color: '#8080ff' },
  { label: 'Mg', rgb: [1, 0, 1], color: '#ff60ff' },
];

/**
 * The 100 % targets are small circles; beyond the edge (zoomed in), a tick on the rim
 * in their direction.
 */
function VectorscopeGraticule({ size, zoom }: { size: number; zoom: number }) {
  const c = size / 2;
  const s = Math.max(1.5, size * 0.011);
  const inside = (x: number, y: number) => Math.hypot(x - c, y - c) < c - s;
  const angle = (SKIN_TONE_ANGLE * Math.PI) / 180;
  return (
    <>
      <circle cx={c} cy={c} r={c - 0.5} fill="none" stroke={LINE} />
      <circle cx={c} cy={c} r={c / 2} fill="none" stroke={LINE} strokeDasharray="2 3" />
      <line x1={c} x2={c} y1={0} y2={size} stroke={LINE} strokeDasharray="2 3" />
      <line x1={0} x2={size} y1={c} y2={c} stroke={LINE} strokeDasharray="2 3" />
      <line
        x1={c}
        y1={c}
        x2={c + Math.cos(angle) * (c - 1)}
        y2={c - Math.sin(angle) * (c - 1)}
        stroke="rgba(255, 200, 150, 0.35)"
      >
        <title>Skin tones</title>
      </line>
      {TARGETS.map(({ label, rgb, color }) => {
        const [x, y] = vectorscopePoint(...rgb, size, zoom);
        // Unit vector from the centre towards the colour.
        const d = Math.hypot(x - c, y - c) || 1;
        const ux = (x - c) / d;
        const uy = (y - c) / d;
        return (
          <g key={label} stroke={color} strokeOpacity={0.6} fill="none">
            {inside(x, y) ? (
              <circle cx={x} cy={y} r={s} />
            ) : (
              <line x1={c + ux * (c - s * 2.5)} y1={c + uy * (c - s * 2.5)} x2={c + ux * c} y2={c + uy * c} />
            )}
          </g>
        );
      })}
    </>
  );
}

interface Props {
  settings: ScopeSettings;
  onChange: (patch: Partial<ScopeSettings>) => void;
  /** Size of the scope, in CSS pixels. */
  width: number;
  height: number;
  /** Where the developer puts the scope of each new frame. */
  canvasRef: React.Ref<HTMLCanvasElement>;
}

/**
 * Waveform, RGB parade or vectorscope of the displayed image, above the history.
 * Memoised: new frames only reach its canvas, so a drag leaves it alone.
 */
export const ScopePanel = memo(function ScopePanel({ settings, onChange, width, height, canvasRef }: Props) {
  const { open, mode, zoom } = settings;
  return (
    <Box flexShrink={0} borderBottomWidth="1px">
      <HStack justify="space-between" px="3" h="10" gap="1">
        <HStack
          asChild
          gap="1"
          color="fg.muted"
          cursor="pointer"
          aria-expanded={open}
          title={open ? 'Hide scopes' : 'Show scopes'}
        >
          <button type="button" onClick={() => onChange({ open: !open })}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Heading size="xs" fontSize="2xs" textTransform="uppercase" letterSpacing="wider" color="fg.muted">
              Scopes
            </Heading>
          </button>
        </HStack>
        <HStack gap="0">
          {open && mode === 'vectorscope' && (
            <Button
              size="2xs"
              variant="ghost"
              px="1"
              minW="0"
              fontVariantNumeric="tabular-nums"
              title={zoom === 1 ? 'Zoom in on low saturations' : 'Show all saturations'}
              onClick={() => onChange({ zoom: zoom === 1 ? 2 : 1 })}
            >
              {zoom}×
            </Button>
          )}
          {MODES.map(({ mode: m, label, icon: Icon }) => (
            <IconButton
              key={m}
              aria-label={label}
              aria-pressed={open && mode === m}
              title={label}
              size="2xs"
              variant={open && mode === m ? 'subtle' : 'ghost'}
              onClick={() => onChange({ mode: m, open: true })}
            >
              <Icon />
            </IconButton>
          ))}
        </HStack>
      </HStack>
      {open && width > 0 && (
        <Box px="2" pb="2">
          <Box
            position="relative"
            style={{ width, height }}
            bg="#121212"
            borderRadius="sm"
            overflow="hidden"
            title={mode === 'vectorscope' ? 'Middle click to zoom' : undefined}
            onMouseDown={(e) => {
              if (e.button !== 1 || mode !== 'vectorscope') return;
              // No autoscroll.
              e.preventDefault();
              onChange({ zoom: zoom === 1 ? 2 : 1 });
            }}
          >
            {/* A new canvas per mode: the last scope of another mode is never stretched into it. */}
            <canvas
              key={mode}
              ref={canvasRef}
              data-scope-view
              style={{ width: '100%', height: '100%', display: 'block' }}
            />
            <svg
              width={width}
              height={height}
              style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
              aria-hidden
            >
              {mode === 'vectorscope' ? (
                <VectorscopeGraticule size={Math.min(width, height)} zoom={zoom} />
              ) : (
                <WaveformGraticule width={width} height={height} parade={mode === 'parade'} />
              )}
            </svg>
          </Box>
        </Box>
      )}
    </Box>
  );
});
