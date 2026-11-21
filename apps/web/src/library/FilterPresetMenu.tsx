import { IconButton, Menu, Portal, Text } from '@chakra-ui/react';
import { Bookmark, BookmarkPlus, Check, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useDeleteFilterPreset, useFilterPresets, useRenameFilterPreset, useSaveFilterPreset } from '../api/hooks.ts';
import type { FilterPreset } from '@rawtisserie/api';
import { toaster } from '../components/toaster.tsx';
import { ManagerDialog } from '../develop/ManagerDialog.tsx';
import { NameField, SaveDialog } from '../develop/presets.tsx';
import { describeFilters, filtersOf, sameFilters, withFilters } from './filterPresets.ts';
import type { LibrarySearch } from './useLibrarySearch.ts';

const failed = (title: string) => (err: unknown) =>
  toaster.create({ type: 'error', title, description: err instanceof Error ? err.message : undefined });

/**
 * Saved filters, as a module's preset menu: pick one to replace the filters with its
 * own (the sort stays), save the current ones under a name, rename and delete them.
 */
export function FilterPresetMenu({ search }: { search: LibrarySearch }) {
  const { data: presets = [] } = useFilterPresets();
  const save = useSaveFilterPreset();
  const rename = useRenameFilterPreset();
  const remove = useDeleteFilterPreset();
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const current = filtersOf(search.params);

  const apply = (preset: FilterPreset) =>
    search.edit((next) => {
      const replaced = withFilters(next, preset.query);
      for (const key of [...next.keys()]) next.delete(key);
      for (const [k, v] of replaced) next.append(k, v);
    });

  const saveAs = (name: string, query: string) =>
    save.mutate(
      { name, query },
      {
        onSuccess: (p) => toaster.create({ type: 'success', title: `Saved filter preset “${p.name}”` }),
        onError: failed('Could not save'),
      },
    );

  const del = (preset: FilterPreset) =>
    remove.mutateAsync(preset.id).then(
      () =>
        toaster.create({
          type: 'info',
          title: `Deleted filter preset “${preset.name}”`,
          action: { label: 'Undo', onClick: () => saveAs(preset.name, preset.query) },
        }),
      failed('Could not delete'),
    );

  return (
    <>
      <Menu.Root
        lazyMount
        unmountOnExit
        onSelect={({ value }) => {
          if (value === 'save') return setSaving(true);
          if (value === 'manage') return setManaging(true);
          const preset = presets.find((p) => `apply:${p.id}` === value);
          if (preset) apply(preset);
        }}
      >
        <Menu.Trigger asChild>
          <IconButton aria-label="Filter presets" title="Filter presets" size="2xs" variant="ghost">
            <Bookmark />
          </IconButton>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="64" maxW="md">
              {presets.length > 0 ? (
                <Menu.ItemGroup>
                  <Menu.ItemGroupLabel>Own</Menu.ItemGroupLabel>
                  {presets.map((p) => (
                    <Menu.Item key={p.id} value={`apply:${p.id}`} py="1">
                      <Text flex="1" truncate>
                        {p.name}
                      </Text>
                      <Text textStyle="2xs" color="fg.subtle" truncate maxW="40" title={describeFilters(p.query)}>
                        {describeFilters(p.query)}
                      </Text>
                      {sameFilters(p.query, current) && <Check aria-label="Current filters" />}
                    </Menu.Item>
                  ))}
                </Menu.ItemGroup>
              ) : (
                <Text px="2" py="1.5" textStyle="xs" color="fg.muted">
                  No presets yet
                </Text>
              )}
              <Menu.Separator />
              <Menu.Item value="save" disabled={!current}>
                <BookmarkPlus /> Save filters as preset…
              </Menu.Item>
              {presets.length > 0 && (
                <Menu.Item value="manage">
                  <Pencil /> Manage presets…
                </Menu.Item>
              )}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
      {saving && (
        <SaveFilterPresetDialog
          query={current}
          presets={presets}
          onClose={() => setSaving(false)}
          onSave={(name) => saveAs(name, current)}
        />
      )}
      {managing && (
        <ManagerDialog
          title="Filter presets"
          description="Rename or delete your filter presets."
          items={presets.map((p) => ({ id: p.id, name: p.name, detail: describeFilters(p.query), preset: p }))}
          empty="No filter presets"
          onRename={(item, name) => rename.mutateAsync({ id: item.preset.id, name })}
          onDelete={(item) => del(item.preset)}
          onClose={() => setManaging(false)}
        />
      )}
    </>
  );
}

function SaveFilterPresetDialog({
  query,
  presets,
  onClose,
  onSave,
}: {
  query: string;
  presets: readonly FilterPreset[];
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const taken = presets.some((p) => p.name === trimmed);
  return (
    <SaveDialog
      title="New filter preset"
      subtitle={describeFilters(query)}
      replacing={taken}
      canSave={!!trimmed}
      onClose={onClose}
      onSubmit={() => onSave(trimmed)}
    >
      <NameField value={name} onChange={setName} taken={taken} />
    </SaveDialog>
  );
}
