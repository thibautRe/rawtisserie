import { Box, HStack, Heading, IconButton, Menu, Portal, Stack, Text } from '@chakra-ui/react';
import type { EditParams, ModuleKind } from '@rawtisserie/pipeline';
import {
  Aperture,
  AudioWaveform,
  Bandage,
  Blend,
  ChevronDown,
  ChevronRight,
  Crop,
  Ellipsis,
  Film,
  FoldVertical,
  Image as ImageIcon,
  Layers,
  type LucideIcon,
  Palette,
  Redo2,
  RotateCcw,
  Rainbow,
  Sparkles,
  Spline,
  SplitSquareHorizontal,
  Sun,
  SwatchBook,
  Thermometer,
  Undo2,
  Eraser,
  Waves,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { commandLabel } from '../lib/keys.ts';
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

/** Whether the history's list is shown, remembered across sessions (folded at first). */
export function useHistoryOpen() {
  const [open, setOpen] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('developer.history') ?? '{}').open === true;
    } catch {
      return false;
    }
  });
  useEffect(() => localStorage.setItem('developer.history', JSON.stringify({ open })), [open]);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  return [open, toggle] as const;
}

interface Props {
  original: EditParams;
  entries: readonly HistoryEntry[];
  end: number;
  /** The list is shown (folded: the header alone). */
  open: boolean;
  onToggle: () => void;
  onSelect: (seq: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onCompress: () => void;
  /** Asks to start again from the automatic recipe, as a new import does. */
  onReset: () => void;
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
  open,
  onToggle,
  onSelect,
  onUndo,
  onRedo,
  onCompress,
  onReset,
  compared,
  onCompare,
}: Props) {
  const icons = useMemo(
    () => entries.map((e, i) => entryIcon(entries[i - 1]?.recipe ?? original, e.recipe)),
    [original, entries],
  );
  return (
    <Stack gap="0" h={open ? 'full' : undefined}>
      <HStack justify="space-between" px="3" h="10" gap="1" flexShrink={0} borderBottomWidth={open ? '1px' : undefined}>
        <HStack
          asChild
          gap="1"
          color="fg.muted"
          cursor="pointer"
          aria-expanded={open}
          title={open ? 'Hide history' : 'Show history'}
        >
          <button type="button" onClick={onToggle}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
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
          </button>
        </HStack>
        <HStack gap="0">
          <IconButton
            aria-label={`Undo (${commandLabel('Ctrl+Z')})`}
            title={`Undo (${commandLabel('Ctrl+Z')})`}
            size="2xs"
            variant="ghost"
            disabled={end === 0}
            onClick={onUndo}
          >
            <Undo2 />
          </IconButton>
          <IconButton
            aria-label={`Redo (${commandLabel('Ctrl+Shift+Z')})`}
            title={`Redo (${commandLabel('Ctrl+Shift+Z')})`}
            size="2xs"
            variant="ghost"
            disabled={end >= entries.length}
            onClick={onRedo}
          >
            <Redo2 />
          </IconButton>
          <Menu.Root
            positioning={{ placement: 'bottom-end' }}
            onSelect={({ value }) => (value === 'compress' ? onCompress() : value === 'reset' && onReset())}
          >
            <Menu.Trigger asChild>
              <IconButton aria-label="More history actions" title="More" size="2xs" variant="ghost">
                <Ellipsis />
              </IconButton>
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner>
                <Menu.Content minW="56">
                  <Menu.Item
                    value="compress"
                    disabled={end === 0 && entries.length === 0}
                    title="One entry per module, dropping undone entries"
                  >
                    <FoldVertical /> Compress history
                  </Menu.Item>
                  <Menu.Separator />
                  <Menu.Item value="reset" color="fg.error" _highlighted={{ bg: 'bg.error', color: 'fg.error' }}>
                    <RotateCcw /> Reset history…
                  </Menu.Item>
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
        </HStack>
      </HStack>
      {open && (
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
      )}
    </Stack>
  );
});
