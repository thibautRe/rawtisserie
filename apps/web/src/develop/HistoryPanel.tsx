import { Box, HStack, Heading, IconButton, Stack, Text } from '@chakra-ui/react';
import type { EditParams, ModuleKind } from '@rawtisserie/pipeline';
import {
  Aperture,
  AudioWaveform,
  Bandage,
  Blend,
  Crop,
  Film,
  FoldVertical,
  Image as ImageIcon,
  Layers,
  type LucideIcon,
  Palette,
  Rainbow,
  Sparkles,
  Spline,
  SplitSquareHorizontal,
  Sun,
  SwatchBook,
  Thermometer,
  Eraser,
  Waves,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef } from 'react';
import { describeChange } from './changes.ts';
import type { HistoryEntry } from './history.ts';

const MODULE_ICONS: Record<ModuleKind, LucideIcon> = {
  rawDenoise: Eraser,
  multipleExposure: Blend,
  retouch: Bandage,
  lens: Aperture,
  geometry: Crop,
  diffuse: Waves,
  contrastEqualizer: AudioWaveform,
  glow: Sparkles,
  exposure: Sun,
  colorCalibration: Thermometer,
  colorBalance: Palette,
  colorPrimaries: Rainbow,
  toneCurve: Spline,
  filmic: Film,
  lut: SwatchBook,
};

/** The icon of the module an entry changed (several modules: a stack). */
function entryIcon(before: EditParams, after: EditParams): LucideIcon {
  const { moduleId } = describeChange(before, after);
  const m = after.modules.find((x) => x.id === moduleId) ?? before.modules.find((x) => x.id === moduleId);
  return m ? MODULE_ICONS[m.kind] : Layers;
}

interface Props {
  original: EditParams;
  entries: readonly HistoryEntry[];
  end: number;
  onSelect: (seq: number) => void;
  onCompress: () => void;
  /** The entry the image is compared with (roadmap M5), or null. */
  compared: number | null;
  /** Compare the image with an entry. */
  onCompare: (seq: number) => void;
}

function Row({
  seq,
  label,
  icon: Icon,
  title,
  selected,
  undone,
  compared,
  onClick,
  onCompare,
}: {
  seq: number;
  label: string;
  icon: LucideIcon;
  title?: string;
  selected: boolean;
  undone: boolean;
  compared: boolean;
  onClick: () => void;
  onCompare: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <HStack
      className="group"
      gap="0"
      pe="1"
      color={undone ? 'fg.subtle' : selected ? 'orange.fg' : 'fg'}
      bg={selected ? 'orange.subtle' : undefined}
      _hover={{ bg: selected ? 'orange.subtle' : 'bg.muted' }}
    >
      <HStack asChild flex="1" minW="0" gap="2" ps="3" py="1" textAlign="start" textStyle="xs" title={title}>
        <button ref={ref} type="button" onClick={onClick}>
          <Text
            as="span"
            w="6"
            flexShrink={0}
            textAlign="end"
            color="fg.subtle"
            fontFamily="numeric"
            fontVariantNumeric="tabular-nums"
          >
            {seq}
          </Text>
          <Box as="span" flexShrink={0} opacity={undone ? 0.5 : 1}>
            <Icon size={14} />
          </Box>
          <Text as="span" truncate>
            {label}
          </Text>
        </button>
      </HStack>
      <IconButton
        aria-label={compared ? 'Compared with this entry' : 'Compare with this entry'}
        title={compared ? 'The image is compared with this entry' : 'Compare with this entry'}
        size="2xs"
        variant="ghost"
        minW="5"
        h="5"
        color={compared ? 'orange.fg' : 'fg.muted'}
        opacity={compared ? 1 : 0}
        _groupHover={{ opacity: 1 }}
        _focusVisible={{ opacity: 1 }}
        onClick={onCompare}
      >
        <SplitSquareHorizontal />
      </IconButton>
    </HStack>
  );
}

/** The history stack, newest first: click an entry to go back to it. */
export const HistoryPanel = memo(function HistoryPanel({
  original,
  entries,
  end,
  onSelect,
  onCompress,
  compared,
  onCompare,
}: Props) {
  const icons = useMemo(
    () => entries.map((e, i) => entryIcon(entries[i - 1]?.recipe ?? original, e.recipe)),
    [original, entries],
  );
  return (
    <Stack gap="0" h="full">
      <HStack justify="space-between" px="3" h="10" flexShrink={0} borderBottomWidth="1px">
        <Heading
          size="xs"
          fontSize="2xs"
          fontFamily="label"
          textTransform="uppercase"
          letterSpacing="wider"
          color="fg.muted"
        >
          History
        </Heading>
        <IconButton
          aria-label="Compress history"
          title="Compress history: one entry per module, dropping undone entries"
          size="2xs"
          variant="ghost"
          disabled={end === 0 && entries.length === 0}
          onClick={onCompress}
        >
          <FoldVertical />
        </IconButton>
      </HStack>
      <Stack gap="0" py="1" overflowY="auto" flex="1">
        {entries
          .map((e, i) => (
            <Row
              key={i}
              seq={i + 1}
              label={e.label}
              icon={icons[i]!}
              title={`${e.label}\n${new Date(e.createdAt).toLocaleString()}`}
              selected={end === i + 1}
              undone={i + 1 > end}
              compared={compared === i + 1}
              onClick={() => onSelect(i + 1)}
              onCompare={() => onCompare(i + 1)}
            />
          ))
          .reverse()}
        <Row
          seq={0}
          label="Original"
          icon={ImageIcon}
          selected={end === 0}
          undone={false}
          compared={compared === 0}
          onClick={() => onSelect(0)}
          onCompare={() => onCompare(0)}
        />
      </Stack>
    </Stack>
  );
});
