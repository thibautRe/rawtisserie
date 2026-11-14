import { Box, Button, CloseButton, HStack, Progress, Spinner, Stack, Text } from '@chakra-ui/react';
import { ChevronDown, ChevronUp, CircleAlert, CircleCheck, CircleX, Copy, Trash2, Ban } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { formatBytes } from '../lib/format.ts';
import { type ImportItem, type ImportRun, summarize } from './imports.ts';

export interface ImportActions {
  /** Show the import's photos in the library (absent: already shown). */
  onShow?: () => void;
  onRetry: () => void;
  onUploadDeleted: () => void;
  /** Dismiss it: offered once it's over, so the outcome stays until read. */
  onClose?: () => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * An import's progress, then its outcome: what was imported, what was already there or
 * deleted before (to upload anyway), what failed (to retry) and what was refused.
 */
export function ImportSummary({ run, onShow, onRetry, onUploadDeleted, onClose }: { run: ImportRun } & ImportActions) {
  const s = summarize(run);
  const busy = !run.done;
  const problems = s.failed.length + s.deleted.length + s.refused.length;
  const notImported = [...s.failed, ...s.deleted, ...s.refused, ...s.duplicates];
  // Everything imported: the title says it all, with the way to see them.
  const clean = !busy && s.imported.length === s.total;
  const title = busy
    ? `Importing ${plural(s.total, 'file')}`
    : s.imported.length
      ? `Imported ${plural(s.imported.length, 'photo')}`
      : 'Nothing imported';

  return (
    <HStack align="start" gap="3" w="full" data-import-state={busy ? 'busy' : 'done'}>
      <Box pt="0.5" color={busy ? 'fg.subtle' : problems ? 'orange.fg' : 'green.fg'}>
        {busy ? (
          <Spinner size="sm" color="fg.subtle" />
        ) : problems ? (
          <CircleAlert size={18} />
        ) : (
          <CircleCheck size={18} />
        )}
      </Box>
      <Stack gap="2" flex="1" minW="0">
        <HStack gap="2" justify="space-between">
          <Text fontWeight="semibold" textStyle="sm">
            {title}
          </Text>
          {clean && onShow && <Action onClick={onShow}>Show</Action>}
        </HStack>
        {busy && (
          <Stack gap="1">
            <Progress.Root
              size="xs"
              colorPalette="orange"
              value={s.totalBytes ? (100 * s.sentBytes) / s.totalBytes : 0}
              aria-label="Import progress"
            >
              <Progress.Track>
                <Progress.Range />
              </Progress.Track>
            </Progress.Root>
            <Text textStyle="xs" color="fg.muted" fontFamily="numeric" fontVariantNumeric="tabular-nums">
              {s.finished} of {s.total} · {formatBytes(s.sentBytes)} of {formatBytes(s.totalBytes)}
            </Text>
          </Stack>
        )}
        <Stack gap="1" textStyle="sm">
          {s.imported.length > 0 && !clean && onShow && (
            <Line icon={<CircleCheck size={14} />} color="green.fg">
              {plural(s.imported.length, 'photo')} imported
              <Action onClick={onShow}>Show</Action>
            </Line>
          )}
          {s.duplicates.length > 0 && (
            <Line icon={<Copy size={14} />}>{plural(s.duplicates.length, 'file')} already in your library</Line>
          )}
          {s.deleted.length > 0 && (
            <Line icon={<Trash2 size={14} />}>
              {plural(s.deleted.length, 'file')} you deleted before
              {!busy && <Action onClick={onUploadDeleted}>Upload anyway</Action>}
            </Line>
          )}
          {s.failed.length > 0 && (
            <Line icon={<CircleX size={14} />} color="red.fg">
              {plural(s.failed.length, 'file')} failed
              {!busy && <Action onClick={onRetry}>Retry</Action>}
            </Line>
          )}
          {s.refused.length > 0 && (
            <Line icon={<Ban size={14} />}>
              {plural(s.refused.length, 'file')} not imported ({refusedWhy(s.refused)})
            </Line>
          )}
        </Stack>
        {!busy && notImported.length > 0 && <Details items={notImported} />}
      </Stack>
      {!busy && onClose && <CloseButton size="2xs" onClick={onClose} aria-label="Close" mt="-1" me="-1" />}
    </HStack>
  );
}

function refusedWhy(items: ImportItem[]) {
  const kinds = new Set(items.map((i) => i.kind));
  return [
    kinds.has('unsupported') && 'not RAW files',
    kinds.has('tooLarge') && 'too large',
    kinds.has('quota') && 'storage full',
  ]
    .filter(Boolean)
    .join(', ');
}

function Line({ icon, color = 'fg.muted', children }: { icon: ReactNode; color?: string; children: ReactNode }) {
  return (
    <HStack gap="2" minH="6">
      <Box color={color} flexShrink={0}>
        {icon}
      </Box>
      <HStack gap="2" flex="1" justify="space-between">
        {children}
      </HStack>
    </HStack>
  );
}

function Action({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button size="2xs" variant="outline" onClick={onClick} flexShrink={0}>
      {children}
    </Button>
  );
}

/**
 * The files not imported, with why. Shown at once rather than animated open: the toaster
 * measures a toast when its content changes, and would miss a height that's still growing.
 */
function Details({ items }: { items: ImportItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap="1">
      <Button size="2xs" variant="ghost" color="fg.muted" alignSelf="start" px="1" onClick={() => setOpen((o) => !o)}>
        Details {open ? <ChevronUp /> : <ChevronDown />}
      </Button>
      {open && (
        <Stack gap="1" maxH="40" overflowY="auto" textStyle="xs">
          {items.map((i) => (
            <Box key={i.key} minW="0">
              <Text truncate title={i.name} fontWeight="medium">
                {i.name}
              </Text>
              <Text color="fg.muted">{i.reason}</Text>
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
