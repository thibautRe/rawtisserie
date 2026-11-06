import { Box, HStack, Heading, IconButton, Stack, Text } from '@chakra-ui/react';
import type { EditParams, ModuleKind } from '@rawtisserie/pipeline';
import {
  Aperture,
  AudioWaveform,
  Bandage,
  Contrast,
  Crop,
  Droplet,
  Film,
  FoldVertical,
  Image as ImageIcon,
  Layers,
  type LucideIcon,
  Palette,
  Rainbow,
  Spline,
  Sun,
  Thermometer,
  Triangle,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef } from 'react';
import { describeChange } from './changes.ts';
import type { HistoryEntry } from './history.ts';

const MODULE_ICONS: Record<ModuleKind, LucideIcon> = {
  retouch: Bandage,
  lens: Aperture,
  geometry: Crop,
  blur: Droplet,
  sharpen: Triangle,
  contrastEqualizer: AudioWaveform,
  exposure: Sun,
  colorCalibration: Thermometer,
  color: Palette,
  shadowsHighlights: Contrast,
  colorPrimaries: Rainbow,
  toneCurve: Spline,
  filmic: Film,
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
}

function Row({
  seq,
  label,
  icon: Icon,
  title,
  selected,
  undone,
  onClick,
}: {
  seq: number;
  label: string;
  icon: LucideIcon;
  title?: string;
  selected: boolean;
  undone: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <HStack
      asChild
      gap="2"
      px="3"
      py="1"
      textAlign="start"
      textStyle="xs"
      title={title}
      color={undone ? 'fg.subtle' : selected ? 'orange.fg' : 'fg'}
      bg={selected ? 'orange.subtle' : undefined}
      _hover={{ bg: selected ? 'orange.subtle' : 'bg.muted' }}
    >
      <button ref={ref} type="button" onClick={onClick}>
        <Text as="span" w="6" flexShrink={0} textAlign="end" color="fg.subtle" fontVariantNumeric="tabular-nums">
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
  );
}

/** The history stack, newest first: click an entry to go back to it. */
export const HistoryPanel = memo(function HistoryPanel({ original, entries, end, onSelect, onCompress }: Props) {
  const icons = useMemo(
    () => entries.map((e, i) => entryIcon(entries[i - 1]?.recipe ?? original, e.recipe)),
    [original, entries],
  );
  return (
    <Stack gap="0" h="full">
      <HStack justify="space-between" px="3" h="10" flexShrink={0} borderBottomWidth="1px">
        <Heading size="xs" fontSize="2xs" textTransform="uppercase" letterSpacing="wider" color="fg.muted">
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
              onClick={() => onSelect(i + 1)}
            />
          ))
          .reverse()}
        <Row
          seq={0}
          label="Original"
          icon={ImageIcon}
          selected={end === 0}
          undone={false}
          onClick={() => onSelect(0)}
        />
      </Stack>
    </Stack>
  );
});
