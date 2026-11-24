import { Box, Button, Image, Menu, Portal, Text } from '@chakra-ui/react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Copy, CopyPlus, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useDuplicateVersion, useMoveVersion, useUpdatePhoto } from '../api/hooks.ts';
import type { PhotoDetail } from '@rawtisserie/api';
import { RenameDialog } from '../components/RenameDialog.tsx';
import { toaster } from '../components/toaster.tsx';
import { useTrashWithUndo } from '../components/trash.tsx';
import { versionLabel } from '../lib/format.ts';
import { libraryPath } from '../library/libraryView.ts';

const failed = (title: string) => (err: unknown) =>
  toaster.create({ type: 'error', title, description: err instanceof Error ? err.message : undefined });

/** The version switcher next to the file name: switch, duplicate, rename, reorder, delete. */
export function VersionMenu({ photo, whenSaved }: { photo: PhotoDetail; whenSaved: () => Promise<void> }) {
  const navigate = useNavigate();
  const duplicate = useDuplicateVersion();
  const move = useMoveVersion();
  const update = useUpdatePhoto();
  const moveToTrash = useTrashWithUndo();
  const [renaming, setRenaming] = useState(false);
  const index = photo.versions.findIndex((v) => v.id === photo.id);
  const several = photo.versions.length > 1;
  const label = versionLabel({ name: photo.versionName, index: photo.versionIndex });

  const open = (id: string, replace = false) => navigate(`/versions/${id}/develop`, { replace });

  const onSelect = async (value: string) => {
    if (value.startsWith('go:')) return open(value.slice(3));
    switch (value) {
      case 'duplicate':
      case 'original': {
        const fromOriginal = value === 'original';
        // The copy is made from the saved history: save pending changes first.
        if (!fromOriginal) await whenSaved();
        const copy = await duplicate.mutateAsync({ id: photo.id, fromOriginal });
        return open(copy.id);
      }
      case 'rename':
        return setRenaming(true);
      case 'earlier':
      case 'later':
        return move.mutateAsync({ id: photo.id, position: index + (value === 'earlier' ? -1 : 1) });
      case 'delete':
        return trash();
    }
  };

  const trash = async () => {
    // Nothing must be saved to it afterwards.
    await whenSaved().catch(() => {});
    await moveToTrash([photo]);
    const next = photo.versions[index + 1] ?? photo.versions[index - 1];
    if (next) open(next.id, true);
    else navigate(libraryPath(), { replace: true });
  };

  return (
    <>
      <Menu.Root onSelect={(d) => void onSelect(d.value).catch(failed('Something went wrong'))}>
        <Menu.Trigger asChild>
          <Button
            size="2xs"
            h="4"
            px="1"
            variant="ghost"
            color="fg.muted"
            flexShrink={0}
            title="Versions of this photo"
          >
            {photo.versionCount > 1 ? `${label} (${photo.versionIndex}/${photo.versionCount})` : label}
            <ChevronDown />
          </Button>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="64">
              {/* With a single version, there's no other to go to or to move it past. */}
              {several && (
                <>
                  <Menu.ItemGroup>
                    <Menu.ItemGroupLabel>Versions</Menu.ItemGroupLabel>
                    {photo.versions.map((v) => (
                      <Menu.Item key={v.id} value={`go:${v.id}`}>
                        <Box w="8" h="6" flexShrink={0} bg="bg.muted" borderRadius="xs" overflow="hidden">
                          {v.thumbUrl && <Image src={v.thumbUrl} alt="" w="full" h="full" objectFit="cover" />}
                        </Box>
                        <Text flex="1" truncate>
                          {versionLabel(v)}
                        </Text>
                        {v.edited && (
                          <Text textStyle="2xs" color="fg.subtle">
                            edited
                          </Text>
                        )}
                        <Box w="4">{v.id === photo.id && <Check size={14} />}</Box>
                      </Menu.Item>
                    ))}
                  </Menu.ItemGroup>
                  <Menu.Separator />
                </>
              )}
              <Menu.Item value="duplicate">
                <Copy /> Duplicate
              </Menu.Item>
              <Menu.Item value="original">
                <CopyPlus /> Duplicate from original
              </Menu.Item>
              <Menu.Item value="rename">
                <Pencil /> Rename…
              </Menu.Item>
              {several && (
                <>
                  <Menu.Item value="earlier" disabled={index <= 0}>
                    <ArrowUp /> Move earlier
                  </Menu.Item>
                  <Menu.Item value="later" disabled={index < 0 || index >= photo.versions.length - 1}>
                    <ArrowDown /> Move later
                  </Menu.Item>
                </>
              )}
              <Menu.Separator />
              <Menu.Item value="delete" color="fg.error" _highlighted={{ bg: 'bg.error', color: 'fg.error' }}>
                <Trash2 /> Move to trash
              </Menu.Item>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>

      <RenameDialog
        title="Rename version"
        hint="Leave empty to number it automatically."
        maxLength={200}
        open={renaming}
        name={photo.versionName}
        placeholder={`Version ${photo.versionIndex}`}
        onClose={() => setRenaming(false)}
        onRename={(versionName) =>
          update.mutate({ id: photo.id, patch: { versionName } }, { onError: failed('Could not rename') })
        }
      />
    </>
  );
}
