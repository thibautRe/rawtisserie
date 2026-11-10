/**
 * A dialog listing the user's own LUTs, presets or styles, to rename and delete them.
 * Each row shows its thumbnail (inside the developer), its name (click the pencil, or
 * double-click the name, to rename: Enter saves, Escape cancels) and a delete button
 * that asks once more. Mount it to open it.
 */
import { Box, Button, CloseButton, Dialog, HStack, IconButton, Input, Portal, Stack, Text } from '@chakra-ui/react';
import type { EditParams } from '@rawtisserie/pipeline';
import { Check, Pencil, Search, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { MenuThumbnail } from './thumbnails.tsx';

export interface ManagedItem {
  id: string;
  name: string;
  /** A short hint after the name (what it sets, how many modules). */
  detail?: string | null;
  /** The recipe its thumbnail shows. */
  recipe?: () => EditParams;
}

/** Above this many items, the list gets a filter field. */
const FILTER_FROM = 8;

const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

export function ManagerDialog<T extends ManagedItem>({
  title,
  description,
  items,
  empty = 'Nothing here yet',
  onRename,
  onDelete,
  onClose,
}: {
  title: string;
  description?: string;
  items: readonly T[];
  /** What the list says when there's nothing in it. */
  empty?: string;
  /** Rename an item; rejects with what went wrong (a name that's taken). */
  onRename: (item: T, name: string) => Promise<unknown>;
  onDelete: (item: T) => unknown;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  // One row is edited or asks to confirm a deletion at a time.
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);

  const query = filter.trim().toLowerCase();
  const shown = query ? items.filter((i) => i.name.toLowerCase().includes(query)) : items;

  const startEditing = (item: T) => {
    setConfirming(null);
    setError(null);
    setEditing({ id: item.id, name: item.name });
  };
  const saveName = async (item: T) => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name || name === item.name) return setEditing(null);
    setBusy(item.id);
    try {
      await onRename(item, name);
      setEditing(null);
      setError(null);
    } catch (err) {
      setError({ id: item.id, text: message(err) });
    } finally {
      setBusy(null);
    }
  };
  const remove = async (item: T) => {
    setBusy(item.id);
    try {
      await onDelete(item);
      setConfirming(null);
    } catch (err) {
      setError({ id: item.id, text: message(err) });
    } finally {
      setBusy(null);
    }
  };

  const row = (item: T) => {
    const isEditing = editing?.id === item.id;
    const isConfirming = confirming === item.id;
    const isBusy = busy === item.id;
    return (
      <Stack key={item.id} gap="0.5" px="2" py="1" rounded="l2" _hover={{ bg: 'bg.muted' }}>
        <HStack gap="2" minH="10">
          {item.recipe && <MenuThumbnail recipe={item.recipe} />}
          {isEditing ? (
            <Input
              size="xs"
              flex="1"
              autoFocus
              maxLength={200}
              aria-label={`New name for ${item.name}`}
              value={editing.name}
              disabled={isBusy}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setEditing({ id: item.id, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void saveName(item);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditing(null);
                  setError(null);
                }
              }}
            />
          ) : (
            <Stack gap="0" flex="1" minW="0" onDoubleClick={() => startEditing(item)}>
              <Text textStyle="sm" truncate title={item.name}>
                {item.name}
              </Text>
              {item.detail && (
                <Text textStyle="2xs" color="fg.muted" truncate title={item.detail}>
                  {item.detail}
                </Text>
              )}
            </Stack>
          )}
          {isEditing ? (
            <HStack gap="0.5">
              <IconButton
                size="2xs"
                variant="ghost"
                aria-label="Save the name"
                title="Save (Enter)"
                loading={isBusy}
                onClick={() => void saveName(item)}
              >
                <Check />
              </IconButton>
              <IconButton
                size="2xs"
                variant="ghost"
                aria-label="Cancel renaming"
                title="Cancel (Escape)"
                disabled={isBusy}
                onClick={() => {
                  setEditing(null);
                  setError(null);
                }}
              >
                <X />
              </IconButton>
            </HStack>
          ) : isConfirming ? (
            <HStack gap="1">
              <Button size="2xs" colorPalette="red" loading={isBusy} onClick={() => void remove(item)}>
                Delete
              </Button>
              <Button size="2xs" variant="ghost" disabled={isBusy} onClick={() => setConfirming(null)}>
                Keep
              </Button>
            </HStack>
          ) : (
            <HStack gap="0.5">
              <IconButton
                size="2xs"
                variant="ghost"
                aria-label={`Rename ${item.name}`}
                title="Rename"
                onClick={() => startEditing(item)}
              >
                <Pencil />
              </IconButton>
              <IconButton
                size="2xs"
                variant="ghost"
                aria-label={`Delete ${item.name}`}
                title="Delete"
                onClick={() => {
                  setEditing(null);
                  setError(null);
                  setConfirming(item.id);
                }}
              >
                <Trash2 />
              </IconButton>
            </HStack>
          )}
        </HStack>
        {error?.id === item.id && (
          <Text textStyle="xs" color="fg.error">
            {error.text}
          </Text>
        )}
      </Stack>
    );
  };

  return (
    <Dialog.Root
      open
      size="md"
      scrollBehavior="inside"
      onOpenChange={(e) => !e.open && onClose()}
      // Escape leaves the name being edited (or the deletion asked about) first.
      onEscapeKeyDown={(e) => {
        if (editing || confirming) {
          e.preventDefault();
          setEditing(null);
          setConfirming(null);
          setError(null);
        }
      }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Stack gap="0.5">
                <Dialog.Title>{title}</Dialog.Title>
                {description && <Dialog.Description color="fg.muted">{description}</Dialog.Description>}
              </Stack>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="2">
                {items.length > FILTER_FROM && (
                  <HStack gap="2" px="2">
                    <Box color="fg.muted" asChild>
                      <Search size="14" />
                    </Box>
                    <Input
                      size="xs"
                      variant="flushed"
                      placeholder="Filter by name"
                      aria-label="Filter by name"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </HStack>
                )}
                <Stack gap="0">
                  {shown.map(row)}
                  {!shown.length && (
                    <Text px="2" py="3" textStyle="sm" color="fg.muted">
                      {items.length ? 'No name matches' : empty}
                    </Text>
                  )}
                </Stack>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline">Done</Button>
              </Dialog.ActionTrigger>
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
