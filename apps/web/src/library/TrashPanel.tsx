import { Box, Button, Grid, Image, Stack, Text } from '@chakra-ui/react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { Fragment } from 'react';
import type { TrashItem } from '@rawtisserie/api';
import { deletedIn } from '../components/trashText.ts';
import { formatBytes, formatDateTime, versionLabel } from '../lib/format.ts';
import { CaptureDetails, PANEL_PROPS } from './InfoPanel.tsx';
import { BLOCKS_PROPS, PanelBlock } from './PanelBlock.tsx';
import { commandLabel } from '../lib/keys.ts';

interface Props {
  selected: TrashItem[];
  /** How many are in the trash, and the storage its originals take. */
  total: number;
  bytes: number;
  days: number;
  onRestore: (items: TrashItem[]) => void;
  onDelete: (items: TrashItem[]) => void;
}

/** The trash's side panel, in the library's place: what's selected, when it goes, and what to do with it. */
export function TrashPanel({ selected, total, bytes, days, onRestore, onDelete }: Props) {
  if (!selected.length) {
    return (
      <Stack {...PANEL_PROPS} bg="bg.panel" p="4" justify="center" align="center" color="fg.muted" textAlign="center">
        <Text>
          {total === 1 ? '1 item' : `${total} items`} in the trash, {formatBytes(bytes)} of storage.
        </Text>
        <Text textStyle="sm">
          Items are deleted for good {days} days after they’re moved here. Until then, their original files count
          towards your storage.
        </Text>
        <Text textStyle="xs">
          Shortcuts: <b>Space</b> view · <b>{commandLabel('Ctrl+A')}</b> select all · <b>Del</b> delete permanently ·
          arrows to move
        </Text>
      </Stack>
    );
  }
  const actions = (
    <PanelBlock title="Actions">
      <Button size="xs" variant="outline" onClick={() => onRestore(selected)}>
        <RotateCcw /> {selected.length === 1 ? 'Restore' : `Restore ${selected.length}`}
      </Button>
      <Button size="xs" variant="outline" colorPalette="red" onClick={() => onDelete(selected)} title="Delete (Del)">
        <Trash2 /> {selected.length === 1 ? 'Delete permanently' : `Delete ${selected.length} permanently`}
      </Button>
    </PanelBlock>
  );

  if (selected.length > 1) {
    const first = selected.reduce((a, b) => (a.deleteAt < b.deleteAt ? a : b));
    return (
      <Stack {...PANEL_PROPS} {...BLOCKS_PROPS}>
        <PanelBlock title={`${selected.length} selected`}>
          <Details
            rows={[
              ['First deleted', `${formatDateTime(first.deleteAt)} (${deletedIn(first.deleteAt)})`],
              ['Last deleted', formatDateTime(selected.reduce((a, b) => (a.deleteAt > b.deleteAt ? a : b)).deleteAt)],
            ]}
          />
        </PanelBlock>
        {actions}
      </Stack>
    );
  }

  const item = selected[0]!;
  return (
    <Stack {...PANEL_PROPS} {...BLOCKS_PROPS}>
      <PanelBlock>
        <Box position="relative" w="full" aspectRatio="1" flexShrink={0} bg="bg.muted" borderRadius="sm">
          {(item.previewUrl ?? item.thumbUrl) && (
            <Image
              src={item.previewUrl ?? item.thumbUrl!}
              alt=""
              position="absolute"
              inset="0"
              w="full"
              h="full"
              objectFit="contain"
            />
          )}
        </Box>
        <Box minW="0">
          <Text textStyle="sm" fontWeight="semibold" truncate title={item.filename}>
            {item.filename}
            {item.versionCount > 1 && (
              <Text as="span" fontWeight="normal" color="fg.muted">
                {' · '}
                {versionLabel({ name: item.versionName, index: item.versionIndex })}
              </Text>
            )}
          </Text>
          <Text textStyle="xs" color="fg.muted" fontFamily="numeric" fontVariantNumeric="tabular-nums">
            {[item.width && item.height && `${item.width} × ${item.height}`, formatBytes(item.fileSize)]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </Box>
      </PanelBlock>
      <PanelBlock title="In the trash">
        <Details
          rows={[
            ['Moved here', formatDateTime(item.trashedAt)],
            ['Deleted', `${formatDateTime(item.deleteAt)} (${deletedIn(item.deleteAt)})`],
          ]}
        />
        {!item.photoInTrash && (
          <Text textStyle="xs" color="fg.muted">
            Other versions of this photo are in your library: its original file stays when this one is deleted.
          </Text>
        )}
      </PanelBlock>
      {actions}
      <PanelBlock title="Capture">
        <CaptureDetails photo={item} />
      </PanelBlock>
    </Stack>
  );
}

function Details({ rows }: { rows: [string, string | null][] }) {
  return (
    <Grid templateColumns="var(--chakra-sizes-20) 1fr" columnGap="2" rowGap="1" textStyle="xs">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <Text color="fg.muted">{label}</Text>
          <Text fontFamily="numeric" fontVariantNumeric="tabular-nums">
            {value}
          </Text>
        </Fragment>
      ))}
    </Grid>
  );
}
