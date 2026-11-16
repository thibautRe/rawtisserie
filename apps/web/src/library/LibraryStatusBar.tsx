import { Button, CloseButton, HStack, Separator, Slider, Spinner, Text } from '@chakra-ui/react';
import { Grid3x3, Info } from 'lucide-react';
import { memo, useCallback, useState } from 'react';

/** Photos per row: the range and default, and where it's remembered, on wide screens and phones. */
export const COLUMNS = {
  wide: { min: 3, max: 12, initial: 6, key: 'library.columns' },
  narrow: { min: 2, max: 6, initial: 3, key: 'library.columns.narrow' },
} as const;

const storedColumns = (narrow: boolean) => {
  const { min, max, initial, key } = COLUMNS[narrow ? 'narrow' : 'wide'];
  let n = NaN;
  try {
    n = Number(localStorage.getItem(key));
  } catch {
    // Unavailable: the default.
  }
  return n >= min && n <= max ? n : initial;
};

/** Photos per row in the library's grid, remembered across sessions (apart on phones). */
export function useColumns(narrow = false) {
  const [columns, setColumns] = useState(() => ({ wide: storedColumns(false), narrow: storedColumns(true) }));
  const mode = narrow ? 'narrow' : 'wide';
  const set = useCallback(
    (n: number) => {
      setColumns((c) => ({ ...c, [mode]: n }));
      try {
        localStorage.setItem(COLUMNS[mode].key, String(n));
      } catch {
        // Not remembered.
      }
    },
    [mode],
  );
  return [columns[mode], set, COLUMNS[mode]] as const;
}

const NUMERIC = { fontFamily: 'numeric', fontVariantNumeric: 'tabular-nums' } as const;

/** A slim bar under the library's grid, as the developer's: counts, and the grid's size. */
export const LibraryStatusBar = memo(function LibraryStatusBar({
  selected,
  total,
  developing,
  loading,
  columns,
  range = COLUMNS.wide,
  onColumnsChange,
}: {
  selected: number;
  total: number;
  /** Photos in the pages that are in whose previews are being rendered. */
  developing: number;
  /** Pages being fetched. */
  loading: boolean;
  columns: number;
  /** The slider's limits (`useColumns`'s third value). */
  range?: { min: number; max: number };
  onColumnsChange: (columns: number) => void;
}) {
  return (
    <HStack h="7" px="3" gap="2" borderTopWidth="1px" bg="bg.panel" flexShrink={0}>
      <Text textStyle="2xs" color="fg.muted" {...NUMERIC}>
        {selected ? `${selected} of ` : ''}
        {total} photo{total === 1 ? '' : 's'}
      </Text>
      {developing > 0 && (
        <>
          <Separator orientation="vertical" h="4" />
          <HStack gap="1.5" color="fg.muted">
            <Spinner size="xs" color="orange.solid" />
            <Text textStyle="2xs" {...NUMERIC}>
              Developing {developing}
            </Text>
          </HStack>
        </>
      )}
      {loading && !developing && <Spinner size="xs" color="fg.subtle" />}
      <HStack gap="2" ms="auto" color="fg.muted" title="Photos per row">
        <Grid3x3 size={14} />
        <Slider.Root
          w={{ base: '20', md: '28' }}
          size="sm"
          min={range.min}
          max={range.max}
          step={1}
          value={[columns]}
          onValueChange={(e) => onColumnsChange(e.value[0]!)}
          aria-label={['Photos per row']}
        >
          <Slider.Control>
            <Slider.Track h="1px">
              <Slider.Range />
            </Slider.Track>
            <Slider.Thumbs />
          </Slider.Control>
        </Slider.Root>
        <Text textStyle="2xs" w="5" textAlign="end" {...NUMERIC}>
          {columns}
        </Text>
      </HStack>
    </HStack>
  );
});

/**
 * Phones, while photos are selected (a long press starts it, taps add or remove): in
 * place of the status bar, how many, and what to do with them (`details` opens the
 * info panel's drawer: culling, tags, export…).
 */
export function SelectionBar({
  selected,
  total,
  onSelectAll,
  onDetails,
  onDone,
}: {
  selected: number;
  total: number;
  onSelectAll: () => void;
  onDetails: () => void;
  /** Clear the selection. */
  onDone: () => void;
}) {
  return (
    <HStack h="12" px="2" gap="1" borderTopWidth="1px" bg="bg.panel" flexShrink={0}>
      <CloseButton size="sm" aria-label="Clear the selection" onClick={onDone} />
      <Text textStyle="sm" fontWeight="medium" flex="1" {...NUMERIC}>
        {selected} selected
      </Text>
      {selected < total && (
        <Button size="sm" variant="ghost" onClick={onSelectAll}>
          Select all
        </Button>
      )}
      <Button size="sm" variant="subtle" onClick={onDetails}>
        <Info /> Details
      </Button>
    </HStack>
  );
}
