import { Box, Button, CloseButton, Dialog, HStack, Portal, Spinner, Stack, Text } from '@chakra-ui/react';
import { Ban, Copy, FileImage, FolderMinus } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { formatBytes } from '../lib/format.ts';
import type { Picked, PickedFile } from './pickedFiles.ts';

/** What an import is about to do, while it's being looked at, then once it's known. */
export type Review =
  { phase: 'scanning'; label: string | null } | { phase: 'ready'; picked: Picked; known: ReadonlySet<PickedFile> };

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const bytes = (files: readonly PickedFile[]) => formatBytes(files.reduce((s, f) => s + f.file.size, 0));

/** The counts the review shows. */
export function reviewCounts(picked: Picked, known: ReadonlySet<PickedFile>) {
  const fresh = picked.files.filter((f) => !known.has(f));
  return { raw: picked.files, fresh, known: picked.files.length - fresh.length };
}

/**
 * Before anything is sent: how many RAW files were found, how many the library has
 * already (by name, size and date), and how many are new. Open while `review` is
 * non-null; the last one stays while it closes.
 */
export function ImportReview({
  review,
  onImport,
  onClose,
}: {
  review: Review | null;
  onImport: () => void;
  onClose: () => void;
}) {
  const shown = useRef(review);
  if (review) shown.current = review;
  const r = shown.current;
  const label = r?.phase === 'ready' ? r.picked.label : (r?.label ?? null);
  const counts = r?.phase === 'ready' ? reviewCounts(r.picked, r.known) : null;
  const picked = r?.phase === 'ready' ? r.picked : null;
  const title = label
    ? `Import from ${label}`
    : picked
      ? `Import ${plural(picked.files.length + picked.refused.length, 'file')}`
      : 'Import';

  return (
    <Dialog.Root open={!!review} onOpenChange={(e) => !e.open && onClose()} size="sm">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content data-import-review={r?.phase}>
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <ReviewBody review={r} />
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline">{counts && !counts.fresh.length ? 'Close' : 'Cancel'}</Button>
              </Dialog.ActionTrigger>
              {(!counts || counts.fresh.length > 0) && (
                <Button colorPalette="orange" disabled={!counts} onClick={onImport}>
                  Import {counts ? plural(counts.fresh.length, 'photo') : ''}
                </Button>
              )}
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

/** The dialog's body: what's being looked through, then what will be imported. */
export function ReviewBody({ review }: { review: Review | null }) {
  if (review?.phase !== 'ready')
    return (
      <HStack gap="2" color="fg.muted" textStyle="sm">
        <Spinner size="sm" />
        Looking through {review?.label ?? 'the files'}…
      </HStack>
    );
  const { picked } = review;
  const counts = reviewCounts(picked, review.known);
  return (
    <Stack gap="2" textStyle="sm">
      <Line icon={<FileImage size={14} />}>
        {plural(counts.raw.length, 'RAW file')}
        <Muted>{bytes(counts.raw)}</Muted>
      </Line>
      {counts.known > 0 && (
        <Line icon={<Copy size={14} />} muted>
          {counts.known.toLocaleString()} already in your library
        </Line>
      )}
      {picked.refused.length > 0 && (
        <Line icon={<Ban size={14} />} muted>
          {plural(picked.refused.length, 'file')} not RAW (not imported)
        </Line>
      )}
      {picked.ignored > 0 && (
        <Line icon={<FolderMinus size={14} />} muted>
          {plural(picked.ignored, 'other file')} left out (JPEGs, videos…)
        </Line>
      )}
      <Text fontWeight="semibold" pt="1">
        {counts.fresh.length
          ? `${plural(counts.fresh.length, 'new photo')} · ${bytes(counts.fresh)}`
          : 'Nothing new to import'}
      </Text>
    </Stack>
  );
}

/** A review of `n` files from a card, `known` of them in the library already (for `/ui`). */
export function sampleReview(n: number, known: number, ignored: number): Review {
  const files = Array.from({ length: n }, (_, i) => ({
    path: `DCIM/100MSDCF/DSC0${1000 + i}.ARW`,
    file: new File([], `DSC0${1000 + i}.ARW`),
  }));
  // Sizes without the bytes: what the review adds up.
  for (const f of files) Object.defineProperty(f.file, 'size', { value: 36e6 });
  return {
    phase: 'ready',
    picked: { files, refused: [], ignored, label: 'DCIM' },
    known: new Set(files.slice(0, known)),
  };
}

function Line({ icon, muted, children }: { icon: ReactNode; muted?: boolean; children: ReactNode }) {
  return (
    <HStack gap="2" color={muted ? 'fg.muted' : undefined}>
      <Box color="fg.muted" flexShrink={0}>
        {icon}
      </Box>
      <HStack gap="2" flex="1" justify="space-between">
        {children}
      </HStack>
    </HStack>
  );
}

const Muted = ({ children }: { children: ReactNode }) => (
  <Text as="span" color="fg.muted" fontFamily="numeric" fontVariantNumeric="tabular-nums">
    {children}
  </Text>
);
