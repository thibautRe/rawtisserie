import { Button, Center, HStack, IconButton, Menu, Portal, Separator, Spinner, Text } from '@chakra-ui/react';
import { ChevronDown, CloudAlert, CloudCheck, Frame, SunMoon, Zap, ZoomIn } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import type { ClipMode } from './protocol.ts';
import type { SaveStatus } from './useAutosave.ts';

/** Clipping indicator settings; display options, not part of the recipe. */
export interface ClippingSettings {
  display: boolean;
  sensor: boolean;
  mode: ClipMode;
  zebra: boolean;
}

const DEFAULT_CLIPPING: ClippingSettings = { display: false, sensor: false, mode: 'anyChannel', zebra: false };

const MODES: { value: ClipMode; label: string }[] = [
  { value: 'anyChannel', label: 'Any channel' },
  { value: 'luminance', label: 'Luminance' },
  { value: 'saturation', label: 'Saturation (gamut)' },
];

/** Clipping settings, remembered across sessions. */
export function useClippingSettings() {
  const [settings, setSettings] = useState<ClippingSettings>(() => {
    try {
      return { ...DEFAULT_CLIPPING, ...JSON.parse(localStorage.getItem('developer.clipping') ?? '{}') };
    } catch {
      return DEFAULT_CLIPPING;
    }
  });
  useEffect(() => localStorage.setItem('developer.clipping', JSON.stringify(settings)), [settings]);
  const update = useCallback((patch: Partial<ClippingSettings>) => setSettings((s) => ({ ...s, ...patch })), []);
  return [settings, update] as const;
}

interface Props {
  /** Autosave state (library mode only). */
  save?: { status: SaveStatus; retry: () => void };
  /** Render time of the last frame, if any. */
  ms: number | null;
  /** Zoom level (device pixels per full-resolution pixel), or null at fit. */
  zoom: number | null;
  /** The zoom level at fit. */
  fitScale: number;
  /** Set the zoom level (null: fit); unavailable (e.g. while cropping) if not given. */
  onZoom?: (scale: number | null) => void;
  clipping: ClippingSettings;
  onClippingChange: (patch: Partial<ClippingSettings>) => void;
  assessment: boolean;
  onAssessmentChange: (on: boolean) => void;
}

/** A slim bar under the image: save state, render time and view toggles. */
export function StatusBar({
  save,
  ms,
  zoom,
  fitScale,
  onZoom,
  clipping,
  onClippingChange,
  assessment,
  onAssessmentChange,
}: Props) {
  return (
    <HStack h="7" px="2" gap="1" borderTopWidth="1px" bg="bg.panel" flexShrink={0}>
      {save && <SaveIndicator {...save} />}
      <Text textStyle="2xs" color="fg.subtle" fontFamily="numeric" fontVariantNumeric="tabular-nums" px="1" flex="1">
        {ms !== null && `${Math.round(ms)} ms`}
      </Text>
      <ZoomMenu zoom={zoom} fitScale={fitScale} onZoom={onZoom} />
      <Separator orientation="vertical" h="4" mx="1" />
      <ViewToggles
        clipping={clipping}
        onClippingChange={onClippingChange}
        assessment={assessment}
        onAssessmentChange={onAssessmentChange}
      />
    </HStack>
  );
}

/** Memoised: the bar around it updates with every frame. */
const ViewToggles = memo(function ViewToggles({
  clipping,
  onClippingChange,
  assessment,
  onAssessmentChange,
}: Pick<Props, 'clipping' | 'onClippingChange' | 'assessment' | 'onAssessmentChange'>) {
  return (
    <>
      <HStack gap="0">
        <Button
          size="2xs"
          variant={clipping.display ? 'subtle' : 'ghost'}
          title="Display clipping: pixels the output can't show (O)"
          onClick={() => onClippingChange({ display: !clipping.display })}
        >
          <SunMoon /> Clipping
        </Button>
        <Menu.Root>
          <Menu.Trigger asChild>
            <IconButton aria-label="Clipping indicator options" size="2xs" variant="ghost" minW="5">
              <ChevronDown />
            </IconButton>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content minW="44">
                <Menu.ItemGroup>
                  <Menu.ItemGroupLabel>Display clipping</Menu.ItemGroupLabel>
                  <Menu.RadioItemGroup
                    value={clipping.mode}
                    onValueChange={(e) => onClippingChange({ mode: e.value as ClipMode, display: true })}
                  >
                    {MODES.map((m) => (
                      <Menu.RadioItem key={m.value} value={m.value}>
                        {m.label}
                        <Menu.ItemIndicator />
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioItemGroup>
                </Menu.ItemGroup>
                <Menu.Separator />
                <Menu.ItemGroup>
                  <Menu.ItemGroupLabel>Indicators</Menu.ItemGroupLabel>
                  <Menu.RadioItemGroup
                    value={clipping.zebra ? 'zebra' : 'solid'}
                    onValueChange={(e) => onClippingChange({ zebra: e.value === 'zebra' })}
                  >
                    <Menu.RadioItem value="solid">
                      Solid
                      <Menu.ItemIndicator />
                    </Menu.RadioItem>
                    <Menu.RadioItem value="zebra">
                      Zebra
                      <Menu.ItemIndicator />
                    </Menu.RadioItem>
                  </Menu.RadioItemGroup>
                </Menu.ItemGroup>
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
      </HStack>
      <Button
        size="2xs"
        variant={clipping.sensor ? 'subtle' : 'ghost'}
        title="Sensor clipping: saturated photosites (Shift+O)"
        onClick={() => onClippingChange({ sensor: !clipping.sensor })}
      >
        <Zap /> Sensor
      </Button>

      <Separator orientation="vertical" h="4" mx="1" />
      <Button
        size="2xs"
        variant={assessment ? 'subtle' : 'ghost'}
        title="Colour assessment, ISO 12646 (Ctrl/⌘+B)"
        onClick={() => onAssessmentChange(!assessment)}
      >
        <Frame /> Assessment
      </Button>
    </>
  );
});

/** Zoom levels offered in the menu, besides fit (device pixels per full-resolution pixel). */
const ZOOM_LEVELS = [0.5, 1, 2, 4, 8];

/** The zoom level, and a menu to set it. Memoised like the toggles. */
const ZoomMenu = memo(function ZoomMenu({ zoom, fitScale, onZoom }: Pick<Props, 'zoom' | 'fitScale' | 'onZoom'>) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button
          size="2xs"
          variant={zoom === null ? 'ghost' : 'subtle'}
          disabled={!onZoom}
          title="Zoom: mouse wheel or pinch, middle click for 100 % on a point (again for fit), drag to pan"
          fontVariantNumeric="tabular-nums"
        >
          <ZoomIn /> {zoom === null ? 'Fit' : `${Math.round(zoom * 100)} %`} <ChevronDown />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="28">
            <Menu.RadioItemGroup
              value={zoom === null ? 'fit' : String(zoom)}
              onValueChange={(e) => onZoom?.(e.value === 'fit' ? null : Number(e.value))}
            >
              <Menu.RadioItem value="fit">
                Fit
                <Menu.ItemIndicator />
              </Menu.RadioItem>
              {ZOOM_LEVELS.map((level) => (
                <Menu.RadioItem key={level} value={String(level)} disabled={level <= fitScale}>
                  {level * 100} %
                  <Menu.ItemIndicator />
                </Menu.RadioItem>
              ))}
            </Menu.RadioItemGroup>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
});

/** Only show the saving state once a save has taken this long. */
const SAVING_DELAY_MS = 1000;

/** A fixed-size icon, so state changes don't move anything. */
function SaveIndicator({ status, retry }: { status: SaveStatus; retry: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (status !== 'saving') return;
    const timer = setTimeout(() => setSlow(true), SAVING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);

  if (status === 'error' || status === 'conflict') {
    const conflict = status === 'conflict';
    return (
      <IconButton
        aria-label={conflict ? 'Changed elsewhere — reload' : 'Not saved — retry'}
        title={conflict ? 'This version changed elsewhere — click to reload' : 'Not saved — click to retry'}
        size="2xs"
        variant="ghost"
        color="fg.error"
        minW="5"
        onClick={conflict ? () => location.reload() : retry}
      >
        <CloudAlert />
      </IconButton>
    );
  }
  const saving = status === 'saving' && slow;
  return (
    <Center
      boxSize="5"
      color="fg.subtle"
      title={saving ? 'Saving…' : 'All changes saved'}
      aria-label={saving ? 'Saving' : 'Saved'}
    >
      {saving ? <Spinner size="xs" borderWidth="1.5px" /> : <CloudCheck size={14} />}
    </Center>
  );
}
