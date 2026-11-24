import { NativeSelect } from '@chakra-ui/react';
import { HEADER_SIZE } from '../lib/headerSize.ts';
import type { LibrarySearch } from './useLibrarySearch.ts';

const SORTS = [
  { value: 'capturedDesc', label: 'Newest first' },
  { value: 'capturedAsc', label: 'Oldest first' },
  { value: 'importedDesc', label: 'Recently imported' },
  { value: 'ratingDesc', label: 'Highest rated' },
  { value: 'filename', label: 'Filename' },
];

/** The library's sort, kept with its filters (`sort`; none: newest first). */
export function SortSelect({ search }: { search: LibrarySearch }) {
  return (
    <NativeSelect.Root size={HEADER_SIZE} w={{ base: 'full', md: '40' }}>
      <NativeSelect.Field
        aria-label="Sort"
        value={search.params.get('sort') ?? 'capturedDesc'}
        onChange={(e) => search.set('sort', e.target.value === 'capturedDesc' ? null : e.target.value)}
      >
        {SORTS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}
