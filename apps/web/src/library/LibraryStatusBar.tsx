import { HStack, Separator, Slider, Spinner, Text } from '@chakra-ui/react';
import { Grid3x3 } from 'lucide-react';
import { memo, useEffect, useState } from 'react';

export const MIN_COLUMNS = 3;
export const MAX_COLUMNS = 12;
const KEY = 'library.columns';

/** Photos per row in the library's grid, remembered across sessions. */
export function useColumns() {
  const [columns, setColumns] = useState(() => {
    let n = NaN;
    try {
      n = Number(localStorage.getItem(KEY));
    } catch {
      // Unavailable: the default.
    }
    return n >= MIN_COLUMNS && n <= MAX_COLUMNS ? n : 6;
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, String(columns));
    } catch {
      // Not remembered.
    }
  }, [columns]);
  return [columns, setColumns] as const;
}

const NUMERIC = { fontFamily: 'numeric', fontVariantNumeric: 'tabular-nums' } as const;

/** A slim bar under the library's grid, as the developer's: counts, and the grid's size. */
export const LibraryStatusBar = memo(function LibraryStatusBar({
  selected,
  total,
  developing,
  loading,
  columns,
  onColumnsChange,
}: {
  selected: number;
  total: number;
  /** Photos in the pages that are in whose previews are being rendered. */
  developing: number;
  /** Pages being fetched. */
  loading: boolean;
  columns: number;
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
          w="28"
          size="sm"
          min={MIN_COLUMNS}
          max={MAX_COLUMNS}
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
