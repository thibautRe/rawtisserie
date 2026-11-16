import { Box, Button, Checkbox, CloseButton, Dialog, HStack, Portal, Spinner, Stack, Text } from '@chakra-ui/react';
import { Ban, Copy, FileImage, FolderMinus, Image, Tags } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { formatBytes } from '../lib/format.ts';
import type { FileTags } from './fileTags.ts';
import { type Picked, type PickedFile, isRaw, withPairs } from './pickedFiles.ts';

/**
 * What an import is about to do, while it's being looked at, then once it's known.
 * `includePairs`: whether the JPEGs next to their RAW files are imported too.
 */
export type Review =
  | { phase: 'scanning'; label: string | null }
  | {
      phase: 'ready';
      picked: Picked;
      known: ReadonlySet<PickedFile>;
      includePairs: boolean;
      /** What the photos get from their files (`readFileTags`). */
      fileTags: ReadonlyMap<PickedFile, FileTags>;
    };

/** What a ready review imports: its files, and the JPEGs next to their RAWs if asked for. */
export const reviewedFiles = (r: Extract<Review, { phase: 'ready' }>) => withPairs(r.picked, r.includePairs);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const bytes = (files: readonly PickedFile[]) => formatBytes(files.reduce((s, f) => s + f.file.size, 0));

/** The counts the review shows (`picked` with the pairs it imports, if any, in its files). */
export function reviewCounts(
  picked: Picked,
  known: ReadonlySet<PickedFile>,
  fileTags: ReadonlyMap<PickedFile, FileTags> = new Map(),
) {
  const fresh = picked.files.filter((f) => !known.has(f));
  const raw = picked.files.filter((f) => isRaw(f.path));
  const images = picked.files.filter((f) => !isRaw(f.path));
  const tagged = fresh.filter((f) => fileTags.has(f)).length;
  return { raw, images, fresh, known: picked.files.length - fresh.length, tagged };
}

/**
 * Before anything is sent: how many RAW files and images were found, how many the
 * library has already (by name, size and date), and how many are new. JPEGs next to
 * their RAW files are left out unless asked for. Open while `review` is non-null; the
 * last one stays while it closes.
 */
export function ImportReview({
  review,
  onImport,
  onIncludePairs,
  onClose,
}: {
  review: Review | null;
  onImport: () => void;
  onIncludePairs: (include: boolean) => void;
  onClose: () => void;
}) {
  const shown = useRef(review);
  if (review) shown.current = review;
  const r = shown.current;
  const label = r?.phase === 'ready' ? r.picked.label : (r?.label ?? null);
  const picked = r?.phase === 'ready' ? reviewedFiles(r) : null;
  const counts = r?.phase === 'ready' ? reviewCounts(picked!, r.known) : null;
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
              <ReviewBody review={r} onIncludePairs={onIncludePairs} />
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
export function ReviewBody({
  review,
  onIncludePairs,
}: {
  review: Review | null;
  onIncludePairs?: (include: boolean) => void;
}) {
  if (review?.phase !== 'ready')
    return (
      <HStack gap="2" color="fg.muted" textStyle="sm">
        <Spinner size="sm" />
        Looking through {review?.label ?? 'the files'}…
      </HStack>
    );
  const picked = reviewedFiles(review);
  const pairs = review.picked.pairs;
  const counts = reviewCounts(picked, review.known, review.fileTags);
  return (
    <Stack gap="2" textStyle="sm">
      {(counts.raw.length > 0 || !counts.images.length) && (
        <Line icon={<FileImage size={14} />}>
          {plural(counts.raw.length, 'RAW file')}
          <Muted>{bytes(counts.raw)}</Muted>
        </Line>
      )}
      {counts.images.length > 0 && (
        <Line icon={<Image size={14} />}>
          {plural(counts.images.length, 'image')} (JPEG, PNG, TIFF, WebP)
          <Muted>{bytes(counts.images)}</Muted>
        </Line>
      )}
      {counts.known > 0 && (
        <Line icon={<Copy size={14} />} muted>
          {counts.known.toLocaleString()} already in your library
        </Line>
      )}
      {counts.tagged > 0 && (
        <Line icon={<Tags size={14} />} muted>
          {plural(counts.tagged, 'new photo')} with tags, ratings or labels from their files
        </Line>
      )}
      {pairs.length > 0 && (
        <Checkbox.Root
          size="sm"
          checked={review.includePairs}
          disabled={!onIncludePairs}
          onCheckedChange={(e) => onIncludePairs?.(!!e.checked)}
          alignItems="flex-start"
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control mt="0.5" />
          <Checkbox.Label fontWeight="normal">
            {pairs.length === 1
              ? 'Also import the JPEG next to its RAW file'
              : `Also import the ${pairs.length.toLocaleString()} JPEGs next to their RAW files`}
            <Text as="span" display="block" color="fg.muted" textStyle="xs">
              Same name, same folder: the camera’s own rendering of the RAW. Their tags, rating and
              label go to the RAW either way.
            </Text>
          </Checkbox.Label>
        </Checkbox.Root>
      )}
      {picked.refused.length > 0 && (
        <Line icon={<Ban size={14} />} muted>
          {plural(picked.refused.length, 'file')} not a RAW file or an image (not imported)
        </Line>
      )}
      {picked.ignored > 0 && (
        <Line icon={<FolderMinus size={14} />} muted>
          {plural(picked.ignored, 'other file')} left out (videos…)
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

/**
 * A review of `n` files from a card, `known` of them in the library already, with
 * `pairs` JPEGs next to their RAWs (for `/ui`).
 */
export function sampleReview(n: number, known: number, ignored: number, pairs = 0): Review {
  const files = Array.from({ length: n }, (_, i) => ({
    path: `DCIM/100MSDCF/DSC0${1000 + i}.ARW`,
    file: new File([], `DSC0${1000 + i}.ARW`),
  }));
  const jpegs = files.slice(0, pairs).map((f) => ({
    path: f.path.replace('.ARW', '.JPG'),
    file: new File([], f.file.name.replace('.ARW', '.JPG')),
  }));
  // Sizes without the bytes: what the review adds up.
  for (const f of files) Object.defineProperty(f.file, 'size', { value: 36e6 });
  for (const f of jpegs) Object.defineProperty(f.file, 'size', { value: 9e6 });
  return {
    phase: 'ready',
    picked: { files, pairs: jpegs, sidecars: [], refused: [], ignored, label: 'DCIM' },
    known: new Set(files.slice(0, known)),
    includePairs: false,
    fileTags: new Map(files.slice(known, known + pairs).map((f) => [f, { tags: ['Holidays'] }])),
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
