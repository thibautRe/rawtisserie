import { Button, HStack, IconButton, Menu, Portal, Separator, Text } from '@chakra-ui/react';
import { ChevronDown, Frame, SunMoon, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ClipMode } from './protocol.ts';

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
  const update = (patch: Partial<ClippingSettings>) => setSettings((s) => ({ ...s, ...patch }));
  return [settings, update] as const;
}

interface Props {
  /** Render time of the last frame, if any. */
  ms: number | null;
  clipping: ClippingSettings;
  onClippingChange: (patch: Partial<ClippingSettings>) => void;
  assessment: boolean;
  onAssessmentChange: (on: boolean) => void;
}

/** A slim bar under the image: render time and view toggles. */
export function StatusBar({ ms, clipping, onClippingChange, assessment, onAssessmentChange }: Props) {
  return (
    <HStack h="7" px="2" gap="1" borderTopWidth="1px" bg="bg.panel" flexShrink={0}>
      <Text textStyle="2xs" color="fg.subtle" fontVariantNumeric="tabular-nums" px="1" flex="1">
        {ms !== null && `${Math.round(ms)} ms`}
      </Text>

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
                  <Menu.RadioItemGroup value={clipping.zebra ? 'zebra' : 'solid'} onValueChange={(e) => onClippingChange({ zebra: e.value === 'zebra' })}>
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
    </HStack>
  );
}
