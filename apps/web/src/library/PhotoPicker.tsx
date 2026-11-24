import {
  Badge,
  Box,
  Button,
  Center,
  CloseButton,
  Dialog,
  Flex,
  HStack,
  IconButton,
  Input,
  InputGroup,
  Portal,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Photo } from '@rawtisserie/api';
import { Filter, Search } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useLibraryPhotos } from '../api/hooks.ts';
import { PanelDrawer } from '../components/PanelDrawer.tsx';
import { useNarrow } from '../lib/useNarrow.ts';
import { FilterSidebar } from './FilterSidebar.tsx';
import { PhotoGrid } from './PhotoGrid.tsx';
import { HEADER_SIZE, SortSelect } from './SortSelect.tsx';
import { useStateSearch } from './useLibrarySearch.ts';

/** Columns of the picker's grid. */
const COLUMNS = { wide: 5, narrow: 3 };

/**
 * Choose a photo from the library (roadmap 4.16): its grid, with its search, sort and
 * filters (the sidebar as in the library, saved filters included), kept in the picker's
 * own state and starting from `start` (a query string: `photoPickerStart`). A click
 * selects a photo, a double click or Enter chooses it. For anything that refers to a
 * photo (multiple exposure's).
 */
export function PhotoPicker({
  title,
  description,
  start,
  isCurrent,
  confirm = 'Choose',
  onClose,
}: {
  title: string;
  description?: ReactNode;
  start: string;
  /** The photo chosen before, selected when it's listed. */
  isCurrent?: (photo: Photo) => boolean;
  /** The button that chooses the photo selected. */
  confirm?: string;
  /** The photo chosen, or null. */
  onClose: (photo: Photo | null) => void;
}) {
  const search = useStateSearch(start);
  const narrow = useNarrow();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const library = useLibraryPhotos(search.search);
  const { items, total } = library;
  const columns = narrow ? COLUMNS.narrow : COLUMNS.wide;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const shownId = selectedId ?? (isCurrent && items.find((p) => !!p && isCurrent(p))?.id) ?? null;
  const index = useMemo(() => items.findIndex((p) => p?.id === shownId), [items, shownId]);
  const selected = index >= 0 ? items[index]! : null;
  const selection = useMemo(() => new Set(shownId ? [shownId] : []), [shownId]);
  const onClick = useCallback((_: React.MouseEvent, photo: Photo) => setSelectedId(photo.id), []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'Enter' && selected) {
      e.preventDefault();
      onClose(selected);
      return;
    }
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[e.key];
    if (!step) return;
    e.preventDefault();
    const to = Math.min(Math.max(index < 0 ? 0 : index + step, 0), total - 1);
    const photo = items[to];
    if (photo) setSelectedId(photo.id);
  };

  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose(null)} size={{ base: 'full', md: 'cover' }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            // A column the window's height: the sidebar and the grid scroll in it.
            display="flex"
            flexDirection="column"
            h={{ base: '100dvh', md: 'full' }}
            minH="0"
            overflow="hidden"
            onKeyDown={onKeyDown}
          >
            <Dialog.Header pb="2">
              <Stack gap="1">
                <Dialog.Title>{title}</Dialog.Title>
                {description && (
                  <Dialog.Description textStyle="sm" color="fg.muted">
                    {description}
                  </Dialog.Description>
                )}
              </Stack>
            </Dialog.Header>
            <Dialog.Body p="0" display="flex" flex="1" minH="0" overflow="hidden" borderTopWidth="1px">
              <PanelDrawer
                narrow={narrow}
                open={filtersOpen}
                onClose={() => setFiltersOpen(false)}
                placement="start"
                title="Sort and filter"
              >
                {narrow && (
                  <Box px="3" pt="3" pb="1.5" bg="bg.panel">
                    <SortSelect search={search} />
                  </Box>
                )}
                <FilterSidebar search={search} />
              </PanelDrawer>
              <Flex direction="column" flex="1" minW="0">
                <HStack px="3" py="2" borderBottomWidth="1px" gap={{ base: '2', md: '3' }}>
                  <InputGroup
                    startElement={<Search size={14} />}
                    maxW={{ md: 'xs' }}
                    flex={{ base: '1', md: 'initial' }}
                  >
                    <Input
                      size={HEADER_SIZE}
                      placeholder="Search filename, title, tags…"
                      defaultValue={search.params.get('q') ?? ''}
                      onChange={(e) => search.set('q', e.target.value)}
                    />
                  </InputGroup>
                  {narrow ? (
                    <IconButton
                      size={HEADER_SIZE}
                      variant="outline"
                      aria-label="Sort and filter"
                      onClick={() => setFiltersOpen(true)}
                      position="relative"
                    >
                      <Filter />
                      {search.activeFilterCount > 0 && (
                        <Badge
                          size="xs"
                          colorPalette="orange"
                          variant="solid"
                          position="absolute"
                          top="-1.5"
                          insetEnd="-1.5"
                          rounded="full"
                          fontFamily="numeric"
                        >
                          {search.activeFilterCount}
                        </Badge>
                      )}
                    </IconButton>
                  ) : (
                    <SortSelect search={search} />
                  )}
                </HStack>
                {library.isPending ? (
                  <Center flex="1">
                    <Spinner color="orange.solid" />
                  </Center>
                ) : total === 0 ? (
                  <Center flex="1">
                    <Stack align="center" gap="3" textAlign="center" maxW="sm" px="4">
                      <Text fontWeight="semibold">
                        {search.activeFilterCount ? 'No photos match these filters' : 'Your library is empty'}
                      </Text>
                      {search.activeFilterCount > 0 && (
                        <Button size="sm" variant="outline" onClick={search.clear}>
                          Clear filters
                        </Button>
                      )}
                    </Stack>
                  </Center>
                ) : (
                  <PhotoGrid
                    items={items}
                    selection={selection}
                    focusedId={shownId}
                    focusedIndex={index}
                    columns={columns}
                    onRange={library.want}
                    onClick={onClick}
                    onOpen={onClose}
                  />
                )}
              </Flex>
            </Dialog.Body>
            <Dialog.Footer borderTopWidth="1px" py="3">
              <Text textStyle="sm" color="fg.muted" flex="1" truncate>
                {selected ? selected.filename : `${total} ${total === 1 ? 'photo' : 'photos'}`}
              </Text>
              <Button variant="outline" size="sm" onClick={() => onClose(null)}>
                Cancel
              </Button>
              <Button size="sm" colorPalette="orange" disabled={!selected} onClick={() => onClose(selected)}>
                {confirm}
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
