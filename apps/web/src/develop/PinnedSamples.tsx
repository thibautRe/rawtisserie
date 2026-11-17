/**
 * The colour picker's pinned samples (roadmap 2.7): their markers over the image and
 * the row of their values above the status bar. Their values come from the sample
 * store, like the pointer's, and follow every edit.
 */
import { Box, Button, HStack, IconButton, Text } from '@chakra-ui/react';
import { X } from 'lucide-react';
import { formatEv, lch, useSamples } from './picker.ts';
import type { PixelSample } from './protocol.ts';

/**
 * Pads numbers to a fixed width (a digit's, in the numeric font's tabular figures), so
 * that values going from 3 digits to 1 don't move what follows.
 */
export const FIGURE_SPACE = '\u2007';

/** Most samples pinned at once. */
export const MAX_PINS = 4;

/**
 * The pins over the image, at their places in the frame (normalised). Inside the zoomed
 * stage: `zoom` (its scale over the fitted size) keeps them the same size on screen.
 */
export function PinMarkers({ places, zoom }: { places: readonly (readonly [number, number])[]; zoom: number }) {
  return places.map(([u, v], i) => (
    // A zero-size anchor at the place, scaled back to screen size around it.
    <Box
      key={i}
      position="absolute"
      left={`${u * 100}%`}
      top={`${v * 100}%`}
      w="0"
      h="0"
      pointerEvents="none"
      style={{ transform: `scale(${1 / zoom})` }}
      data-pin={i + 1}
    >
      <Box
        position="absolute"
        left="-7px"
        top="-7px"
        boxSize="14px"
        rounded="full"
        borderWidth="2px"
        borderColor="white"
        boxShadow="0 0 0 1px rgba(0,0,0,0.7)"
      />
      <Text
        position="absolute"
        left="9px"
        top="-16px"
        lineHeight="1"
        textStyle="2xs"
        fontFamily="numeric"
        fontWeight="semibold"
        color="white"
        css={{ textShadow: '0 0 2px black, 0 0 2px black' }}
      >
        {i + 1}
      </Text>
    </Box>
  ));
}

/** The values of a pixel, as the status bar's readout shows them. */
export function SampleValues({ sample }: { sample: PixelSample }) {
  const [r, g, b] = sample.display;
  const { l, c, h } = lch(sample.display);
  const label = (text: string) => (
    <Text as="span" color="fg.subtle">
      {text}
    </Text>
  );
  const pad = (n: number) => String(n).padStart(3, FIGURE_SPACE);
  // L, C and h: next to their letter, the room left after them (right-aligned, a single
  // digit would read as the previous letter's).
  const after = (text: string, width: number) => text.padEnd(width, FIGURE_SPACE);
  return (
    <>
      <HStack gap="1.5">
        <Box
          boxSize="2.5"
          rounded="xs"
          borderWidth="1px"
          borderColor="border"
          style={{ background: `rgb(${r} ${g} ${b})` }}
        />
        <Text title="Displayed colour, 8-bit RGB">
          {label('RGB')} {pad(r)} {pad(g)} {pad(b)}
        </Text>
      </HStack>
      <Text title="Displayed colour, CIE LCh: lightness, chroma, hue">
        {label('L')} {after(String(Math.round(l)), 3)} {label('C')} {after(String(Math.round(c)), 3)} {label('h')}{' '}
        {after(`${Math.round(h) % 360}°`, 4)}
      </Text>
      <Text title="Scene luminance before tone mapping, from middle grey">
        {formatEv(sample.sceneEv).padStart(8, FIGURE_SPACE)}
      </Text>
    </>
  );
}

/** The pinned samples' values, floating along the bottom of the image's area; each can be removed. */
export function PinnedSamples({
  count,
  onRemove,
  onClear,
}: {
  count: number;
  onRemove: (index: number) => void;
  onClear: () => void;
}) {
  const { pins } = useSamples();
  return (
    <HStack
      position="absolute"
      bottom="2"
      left="2"
      maxW="calc(100% - 16px)"
      minH="7"
      px="2"
      gap="4"
      rounded="l2"
      borderWidth="1px"
      bg="bg.panel"
      shadow="md"
      textStyle="2xs"
      color="fg.muted"
      fontFamily="numeric"
      fontVariantNumeric="tabular-nums"
      whiteSpace="nowrap"
      overflowX="auto"
      data-pinned-samples
    >
      {Array.from({ length: count }, (_, i) => {
        const sample = pins[i];
        return (
          <HStack key={i} gap="3" data-pinned-sample={i + 1}>
            <Text fontWeight="semibold" color="fg">
              {i + 1}
            </Text>
            {sample ? (
              <SampleValues sample={sample} />
            ) : (
              <Text color="fg.subtle" title="Outside what's rendered (zoomed in elsewhere), or rendering">
                —
              </Text>
            )}
            <IconButton size="2xs" variant="ghost" aria-label={`Remove sample ${i + 1}`} onClick={() => onRemove(i)}>
              <X />
            </IconButton>
          </HStack>
        );
      })}
      <Button size="2xs" variant="ghost" fontFamily="body" onClick={onClear}>
        Clear samples
      </Button>
    </HStack>
  );
}
