/**
 * Presets and styles in the developer (roadmap 4.2): the preset menu in a module's
 * header, the styles menu in the toolbar, and their save dialogs. The logic lives in
 * `@rawtisserie/pipeline` (`presets.ts`); saved ones are the user's (`/api/presets`).
 */
import {
  Box,
  Button,
  Checkbox,
  CloseButton,
  Dialog,
  HStack,
  IconButton,
  Input,
  Menu,
  Portal,
  SegmentGroup,
  Stack,
  Text,
} from '@chakra-ui/react';
import {
  AUTO_TUNE_KINDS,
  BUILTIN_PRESETS,
  BUILTIN_STYLES,
  type EditParams,
  type Mask,
  type ModuleKind,
  type ModuleParams,
  type Shape,
  type ModulePreset,
  PRESET_GROUPS,
  type PresetGroup,
  SINGLE_INSTANCE_KINDS,
  type Style,
  type StyleMode,
  type StylePick,
  defaultStyleMode,
  modulePresetPayload,
  styleFromRecipe,
} from '@rawtisserie/pipeline';
import {
  Bookmark,
  BookmarkPlus,
  ChevronDown,
  ClipboardPaste,
  Copy,
  Palette,
  Pencil,
  Plus,
  WandSparkles,
} from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useShiftKey } from '../lib/useShiftKey.ts';
import {
  type PresetInput,
  useDeletePreset,
  useMe,
  useRenamePreset,
  useSavePreset,
  useUserPresets,
} from '../api/hooks.ts';
import { toaster } from '../components/toaster.tsx';
import { ManagerDialog } from './ManagerDialog.tsx';
import { CROP_KINDS, MenuThumbnail } from './thumbnails.tsx';
import { instanceTitle } from './changes.ts';
import { useStableCallback } from './useStableCallback.ts';
import { commandLabel } from '../lib/keys.ts';
import { HEADER_SIZE } from '../lib/headerSize.ts';

export const NO_PRESETS: readonly ModulePreset[] = [];
const NO_STYLES: readonly Style[] = [];

/** What a kind's auto-tune does to each photo a preset or style is applied to (roadmap 8.7). */
const AUTO_TUNE_LABELS: Partial<Record<ModuleKind, string>> = {
  filmic: 'Auto-tune white and black exposure on each photo',
  toneCurve: 'Fit the node range to each photo',
};

/** Marks an auto-tune among the other choices: it runs on each photo, it isn't a setting. */
const AutoTuneIcon = () => (
  <Box as="span" display="inline-flex" verticalAlign="-2px" mr="1.5" color="orange.fg" title="Auto-tune">
    <WandSparkles size={13} aria-hidden />
  </Box>
);

const groupsOf = (kind: ModuleKind) =>
  Object.entries((PRESET_GROUPS[kind] ?? {}) as Record<string, PresetGroup<ModuleKind>>);

export interface PresetLibrary {
  /** Module presets by kind, built-in ones first. Each list keeps its identity until it changes. */
  modulePresets: Partial<Record<ModuleKind, readonly ModulePreset[]>>;
  styles: readonly Style[];
  /** Null without an account: built-in presets only. */
  save: ((input: PresetInput) => void) | null;
  /** Rename one of the user's; rejects if the name is taken (for its kind). */
  rename: (preset: ModulePreset | Style, name: string) => Promise<unknown>;
  remove: (preset: ModulePreset | Style) => void;
}

/** Built-in presets plus the user's, and stable handlers to save and delete theirs. */
export function usePresetLibrary(): PresetLibrary {
  const { data: me } = useMe();
  const { data: own } = useUserPresets();
  const saveMutation = useSavePreset();
  const deleteMutation = useDeletePreset();
  const renameMutation = useRenamePreset();

  const failed = (title: string) => (err: unknown) =>
    toaster.create({ type: 'error', title, description: err instanceof Error ? err.message : undefined });

  const save = useStableCallback((input: PresetInput) =>
    saveMutation.mutate(input, {
      onSuccess: (p) =>
        toaster.create({ type: 'success', title: `Saved ${p.type === 'style' ? 'style' : 'preset'} “${p.name}”` }),
      onError: failed('Could not save'),
    }),
  );
  const remove = useStableCallback((preset: ModulePreset | Style) =>
    deleteMutation.mutate(preset.id, {
      onSuccess: () =>
        toaster.create({
          type: 'info',
          title: `Deleted ${preset.type === 'style' ? 'style' : 'preset'} “${preset.name}”`,
          action: {
            label: 'Undo',
            onClick: () =>
              save(
                preset.type === 'style'
                  ? { type: 'style', name: preset.name, payload: preset.payload }
                  : { type: 'module', moduleKind: preset.moduleKind, name: preset.name, payload: preset.payload },
              ),
          },
        }),
      onError: failed('Could not delete'),
    }),
  );

  const rename = useStableCallback((preset: ModulePreset | Style, name: string) =>
    renameMutation.mutateAsync({ id: preset.id, name }),
  );

  const modulePresets = useMemo(() => {
    const byKind: Partial<Record<ModuleKind, ModulePreset[]>> = {};
    for (const p of [...BUILTIN_PRESETS, ...(own ?? [])]) {
      if (p.type === 'module') (byKind[p.moduleKind] ??= []).push(p);
    }
    return byKind;
  }, [own]);
  // The built-in ones first, as for module presets.
  const styles = useMemo(
    () => [...BUILTIN_STYLES, ...((own?.filter((p) => p.type === 'style') as Style[] | undefined) ?? NO_STYLES)],
    [own],
  );

  return { modulePresets, styles, save: me ? save : null, rename, remove };
}

/**
 * What part of its module a preset sets, when it leaves some of the groups alone. Built-in
 * presets set only a few parameters of a group, so this counts the groups they touch.
 */
function presetHint(preset: ModulePreset): string | null {
  const groups = groupsOf(preset.moduleKind);
  const touched = groups.filter(([, g]) => g.keys.some((k) => k in preset.payload.params));
  if (!touched.length || touched.length === groups.length) return null;
  return touched.map(([, g]) => g.label).join(', ');
}

/**
 * A module header's preset menu. The highlighted preset is previewed (`onPreview`)
 * until the menu closes (`onEndPreview`). Its handlers go through `latest` in the panel,
 * so they're left out when comparing props.
 */
export const PresetMenu = memo(
  ({
    title,
    presets,
    canSave,
    canAppend,
    onApply,
    onPreview,
    onEndPreview,
    recipeFor,
    onSave,
    onRename,
    onDelete,
  }: {
    title: string;
    presets: readonly ModulePreset[];
    canSave: boolean;
    /** Whether the kind takes more instances: with Shift, a preset is applied as a new one (`asNew`). */
    canAppend: boolean;
    onApply: (preset: ModulePreset, asNew: boolean) => void;
    /** Show the image with this preset (or without any, null) for now. */
    onPreview: (preset: ModulePreset | null, asNew: boolean) => void;
    /** Go back to the recipe from before the previews. */
    onEndPreview: () => void;
    /** The recipe from before the previews with this preset applied: its thumbnail. */
    recipeFor: (preset: ModulePreset) => EditParams;
    onSave: () => void;
    /** Rename one of the user's presets; rejects if the name is taken. */
    onRename: (preset: ModulePreset, name: string) => Promise<unknown>;
    onDelete: (preset: ModulePreset) => void;
  }) => {
    const [managing, setManaging] = useState(false);
    const [open, setOpen] = useState(false);
    const [highlighted, setHighlighted] = useState<ModulePreset | null>(null);
    const shift = useShiftKey(open);
    const asNew = (held: boolean) => canAppend && held;
    useEffect(() => {
      if (open) onPreview(highlighted, asNew(shift.held));
    }, [open, highlighted, shift.held]); // eslint-disable-line react-hooks/exhaustive-deps
    const builtIn = presets.filter((p) => p.builtIn);
    const own = presets.filter((p) => !p.builtIn);
    const find = (id: string) => presets.find((p) => p.id === id);
    const item = (p: ModulePreset) => {
      const hint = presetHint(p);
      return (
        <Menu.Item key={p.id} value={`apply:${p.id}`} py="1">
          <MenuThumbnail recipe={() => recipeFor(p)} crop={CROP_KINDS.includes(p.moduleKind)} />
          <Text flex="1" truncate>
            {p.name}
          </Text>
          {hint && (
            <Text textStyle="2xs" color="fg.subtle" truncate maxW="48" title={hint}>
              {hint}
            </Text>
          )}
        </Menu.Item>
      );
    };
    return (
      <>
        <Menu.Root
          lazyMount
          unmountOnExit
          onHighlightChange={({ highlightedValue: value }) =>
            setHighlighted((value?.startsWith('apply:') && find(value.slice(6))) || null)
          }
          onOpenChange={({ open }) => {
            setOpen(open);
            if (!open) {
              setHighlighted(null);
              onEndPreview();
            }
          }}
          onSelect={({ value }) => {
            if (value === 'save') return onSave();
            if (value === 'manage') return setManaging(true);
            const preset = value.startsWith('apply:') && find(value.slice(6));
            if (preset) onApply(preset, asNew(shift.ref.current));
          }}
        >
          <Menu.Trigger asChild>
            <IconButton aria-label={`${title} presets`} title="Presets" size="2xs" variant="ghost">
              <Bookmark />
            </IconButton>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content minW="72" maxW="md">
                {builtIn.length > 0 && (
                  <Menu.ItemGroup>
                    <Menu.ItemGroupLabel>Built-in</Menu.ItemGroupLabel>
                    {builtIn.map(item)}
                  </Menu.ItemGroup>
                )}
                {own.length > 0 && (
                  <Menu.ItemGroup>
                    <Menu.ItemGroupLabel>Own</Menu.ItemGroupLabel>
                    {own.map(item)}
                  </Menu.ItemGroup>
                )}
                {!presets.length && (
                  <Text px="2" py="1.5" textStyle="xs" color="fg.muted">
                    No presets yet
                  </Text>
                )}
                {canAppend && presets.length > 0 && (
                  <Text px="2" pb="1" textStyle="2xs" color="fg.subtle">
                    Shift: as a new instance
                  </Text>
                )}
                {canSave && (
                  <>
                    <Menu.Separator />
                    <Menu.Item value="save">
                      <BookmarkPlus /> Save as preset…
                    </Menu.Item>
                    {own.length > 0 && (
                      <Menu.Item value="manage">
                        <Pencil /> Manage presets…
                      </Menu.Item>
                    )}
                  </>
                )}
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
        {managing && (
          <ManagerDialog
            title={`${title} presets`}
            description="Rename or delete your presets."
            items={own.map((p) => ({
              id: p.id,
              name: p.name,
              detail: presetHint(p),
              recipe: () => recipeFor(p),
              preset: p,
            }))}
            empty="No presets of your own"
            onRename={(item, name) => onRename(item.preset, name)}
            onDelete={(item) => onDelete(item.preset)}
            onClose={() => setManaging(false)}
          />
        )}
      </>
    );
  },
  (a, b) => a.title === b.title && a.presets === b.presets && a.canSave === b.canSave && a.canAppend === b.canAppend,
);

/** A name field that says when saving will replace an existing preset. */
export function NameField({
  value,
  onChange,
  taken,
}: {
  value: string;
  onChange: (v: string) => void;
  taken: boolean;
}) {
  return (
    <Stack gap="1">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Name" maxLength={200} autoFocus />
      {taken && (
        <Text textStyle="xs" color="fg.warning">
          You already have one with this name: it will be replaced.
        </Text>
      )}
    </Stack>
  );
}

export function SaveDialog({
  title,
  subtitle,
  replacing,
  submitLabel,
  canSave,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Saving replaces an existing one. */
  replacing: boolean;
  /** The submit button's label, instead of Create/Replace. */
  submitLabel?: string;
  canSave: boolean;
  onClose: () => void;
  onSubmit: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} size="sm">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content asChild>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!canSave) return;
                onSubmit();
                onClose();
              }}
            >
              <Dialog.Header>
                <Stack gap="0.5">
                  <Dialog.Title>{title}</Dialog.Title>
                  {subtitle && <Dialog.Description color="fg.muted">{subtitle}</Dialog.Description>}
                </Stack>
              </Dialog.Header>
              <Dialog.Body>
                <Stack gap="4">{children}</Stack>
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button variant="outline">Cancel</Button>
                </Dialog.ActionTrigger>
                <Button type="submit" colorPalette="orange" disabled={!canSave}>
                  {submitLabel ?? (replacing ? 'Replace' : 'Create')}
                </Button>
              </Dialog.Footer>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function CheckItem({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Checkbox.Root size="sm" colorPalette="orange" checked={checked} onCheckedChange={(e) => onChange(!!e.checked)}>
      <Checkbox.HiddenInput />
      <Checkbox.Control />
      <Checkbox.Label>{children}</Checkbox.Label>
    </Checkbox.Root>
  );
}

const toggle = <T,>(list: readonly T[], item: T, on: boolean) =>
  on ? [...list, item] : list.filter((x) => x !== item);

/** Save an instance's parameters (or some groups of them) as a preset of its kind. Mount it to open it. */
export function SavePresetDialog({
  kind,
  title,
  params,
  mask,
  shapes,
  existing,
  onClose,
  onSave,
}: {
  kind: ModuleKind;
  /** The instance's title. */
  title: string;
  params: ModuleParams[ModuleKind];
  /** The instance's mask, which the preset can include. */
  mask: Mask | undefined;
  /** The recipe's shapes: the preset keeps those `params` (and the mask) use. */
  shapes: Record<string, Shape> | undefined;
  existing: readonly ModulePreset[];
  onClose: () => void;
  onSave: (input: PresetInput) => void;
}) {
  const groups = groupsOf(kind);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState(() => groups.map(([g]) => g));
  // Off by default: ranges travel well between photos, drawn shapes rarely.
  const [withMask, setWithMask] = useState(false);
  const [autoTune, setAutoTune] = useState(false);
  const trimmed = name.trim();
  const taken = existing.some((p) => !p.builtIn && p.name === trimmed);
  return (
    <SaveDialog
      title="New preset"
      subtitle={title}
      replacing={taken}
      canSave={!!trimmed && (!groups.length || selected.length > 0)}
      onClose={onClose}
      onSubmit={() =>
        onSave({
          type: 'module',
          moduleKind: kind,
          name: trimmed,
          payload: modulePresetPayload(
            kind,
            params,
            shapes,
            groups.length ? selected : undefined,
            withMask ? mask : undefined,
            autoTune,
          ),
        })
      }
    >
      <NameField value={name} onChange={setName} taken={taken} />
      {mask && (
        <CheckItem checked={withMask} onChange={setWithMask}>
          Include the mask{mask.drawn.length ? ' (its shapes stay where they are on the sensor)' : ''}
        </CheckItem>
      )}
      {AUTO_TUNE_KINDS.includes(kind) && (
        <CheckItem checked={autoTune} onChange={setAutoTune}>
          <AutoTuneIcon />
          {AUTO_TUNE_LABELS[kind]} when applied
        </CheckItem>
      )}
      {groups.length > 0 && (
        <Stack gap="2">
          <Text textStyle="xs" color="fg.muted">
            Settings to include (the others are left as they are when applying it):
          </Text>
          {groups.map(([g, { label }]) => (
            <CheckItem key={g} checked={selected.includes(g)} onChange={(on) => setSelected((s) => toggle(s, g, on))}>
              {label}
            </CheckItem>
          ))}
        </Stack>
      )}
    </SaveDialog>
  );
}

/** Instances of a recipe picked for a style (or a copy), with their modes and groups. */
export interface StyleSelection extends Required<StylePick> {
  ids: readonly string[];
}

/**
 * The recipe's enabled instances, except those of `exclude` (they belong to the image
 * they were made for), whole and with their default modes.
 */
export function defaultSelection(recipe: EditParams, exclude: readonly ModuleKind[]): StyleSelection {
  return {
    ids: recipe.modules.filter((m) => m.enabled && !exclude.includes(m.kind)).map((m) => m.id),
    modes: {},
    groups: {},
    autoTune: {},
  };
}

/** Whether every picked instance has something to take. */
export const selectionValid = (recipe: EditParams, s: StyleSelection) =>
  s.ids.length > 0 &&
  s.ids.every((id) => {
    const m = recipe.modules.find((i) => i.id === id);
    return !m || !groupsOf(m.kind).length || (s.groups[id] ?? groupsOf(m.kind).map(([g]) => g)).length > 0;
  });

/**
 * Pick some of a recipe's instances (roadmap 8.6, 8.8): for each, whether it replaces the
 * target's instance or is appended, and for kinds with `PRESET_GROUPS`, which parts of it.
 */
export function StylePicker({
  recipe,
  value,
  onChange,
}: {
  recipe: EditParams;
  value: StyleSelection;
  onChange: (value: StyleSelection) => void;
}) {
  const all = recipe.modules.map((m) => m.id);
  return (
    <Stack gap="2">
      <HStack gap="1">
        <Button
          size="2xs"
          variant="outline"
          disabled={value.ids.length === all.length}
          onClick={() => onChange({ ...value, ids: all })}
        >
          Select all
        </Button>
        <Button
          size="2xs"
          variant="outline"
          disabled={value.ids.length === 0}
          onClick={() => onChange({ ...value, ids: [] })}
        >
          Select none
        </Button>
      </HStack>
      {recipe.modules.map((m) => {
        const checked = value.ids.includes(m.id);
        const groups = groupsOf(m.kind);
        const picked = value.groups[m.id] ?? groups.map(([g]) => g);
        const partial = picked.length < groups.length;
        const mode = value.modes[m.id] ?? defaultStyleMode(recipe, m.id);
        const canAppend = !SINGLE_INSTANCE_KINDS.includes(m.kind) && !partial;
        return (
          <Stack key={m.id} gap="1">
            <HStack justify="space-between" minH="6">
              <CheckItem checked={checked} onChange={(on) => onChange({ ...value, ids: toggle(value.ids, m.id, on) })}>
                {instanceTitle(recipe, m)}
                {!m.enabled && (
                  <Box as="span" color="fg.subtle">
                    {' '}
                    (off)
                  </Box>
                )}
              </CheckItem>
              {checked && canAppend && (
                <SegmentGroup.Root
                  size="xs"
                  value={mode}
                  onValueChange={(e) => onChange({ ...value, modes: { ...value.modes, [m.id]: e.value as StyleMode } })}
                >
                  <SegmentGroup.Indicator />
                  <SegmentGroup.Items
                    items={[
                      { value: 'replace', label: <span title="Takes the place of the photo's instance">Replace</span> },
                      { value: 'append', label: <span title="Added as a new instance">Append</span> },
                    ]}
                  />
                </SegmentGroup.Root>
              )}
            </HStack>
            {checked && AUTO_TUNE_KINDS.includes(m.kind) && (
              <Box pl="6">
                <CheckItem
                  checked={!!value.autoTune[m.id]}
                  onChange={(on) => onChange({ ...value, autoTune: { ...value.autoTune, [m.id]: on } })}
                >
                  <Text as="span" textStyle="xs">
                    <AutoTuneIcon />
                    {AUTO_TUNE_LABELS[m.kind]}
                  </Text>
                </CheckItem>
              </Box>
            )}
            {checked && groups.length > 0 && (
              <Stack gap="1" pl="6">
                {groups.map(([g, { label }]) => (
                  <CheckItem
                    key={g}
                    checked={picked.includes(g)}
                    onChange={(on) =>
                      onChange({ ...value, groups: { ...value.groups, [m.id]: toggle(picked, g, on) } })
                    }
                  >
                    <Text as="span" textStyle="xs">
                      {label}
                    </Text>
                  </CheckItem>
                ))}
              </Stack>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

/** Make a style out of some of the recipe's instances. Mount it to open it. */
export function CreateStyleDialog({
  recipe,
  existing,
  onClose,
  onSave,
}: {
  recipe: EditParams;
  existing: readonly Style[];
  onClose: () => void;
  onSave: (input: PresetInput) => void;
}) {
  const [name, setName] = useState('');
  // Auto-tunes on: a style goes onto other photos, which their measures fit.
  const [selection, setSelection] = useState(() => ({
    ...defaultSelection(recipe, ['geometry', 'lens']),
    autoTune: Object.fromEntries(
      recipe.modules.filter((m) => AUTO_TUNE_KINDS.includes(m.kind)).map((m) => [m.id, true]),
    ),
  }));
  const trimmed = name.trim();
  const taken = existing.some((s) => !s.builtIn && s.name === trimmed);
  return (
    <SaveDialog
      title="New style"
      replacing={taken}
      canSave={!!trimmed && selectionValid(recipe, selection)}
      onClose={onClose}
      onSubmit={() =>
        onSave({ type: 'style', name: trimmed, payload: styleFromRecipe(recipe, selection.ids, selection) })
      }
    >
      <NameField value={name} onChange={setName} taken={taken} />
      <Stack gap="2">
        <Text textStyle="xs" color="fg.muted">
          Modules to include, with their current settings. Each replaces the photo&apos;s first instance of its kind
          (its second for a second one…), or is appended as a new one.
        </Text>
        <StylePicker recipe={recipe} value={selection} onChange={setSelection} />
      </Stack>
    </SaveDialog>
  );
}

/**
 * Pick what to copy of the recipe (roadmap 8.6), starting from `initial` (what was
 * picked last time). Mount it to open it.
 */
export function CopyEditsDialog({
  recipe,
  initial,
  onClose,
  onCopy,
}: {
  recipe: EditParams;
  initial: StyleSelection;
  onClose: () => void;
  onCopy: (selection: StyleSelection) => void;
}) {
  const [selection, setSelection] = useState(initial);
  return (
    <SaveDialog
      title="Copy settings"
      replacing={false}
      submitLabel="Copy"
      canSave={selectionValid(recipe, selection)}
      onClose={onClose}
      onSubmit={() => onCopy(selection)}
    >
      <Text textStyle="xs" color="fg.muted">
        Modules to copy, with their current settings. Pasted, each replaces the photo&apos;s instance of its kind or is
        appended as a new one.
      </Text>
      <StylePicker recipe={recipe} value={selection} onChange={setSelection} />
    </SaveDialog>
  );
}

/**
 * The toolbar's styles menu: apply one, create, delete, and copy and paste settings
 * (roadmap 8.6). A style applies each module as it was saved (replacing or appending);
 * with Shift, all of them are appended. The highlighted style (or paste) is previewed
 * until the menu closes. Memoised.
 */
export const StyleMenu = memo(function StyleMenu({
  styles,
  paste,
  onApply,
  onPreview,
  onEndPreview,
  recipeFor,
  onCreate,
  onRename,
  onDelete,
  onCopy,
  onPaste,
}: {
  styles: readonly Style[];
  /** What the clipboard holds (its source's name), or null. */
  paste: string | null;
  onApply: (style: Style, appendAll: boolean) => void;
  /** Show the image with this style or the paste (or without any, null) for now. */
  onPreview: (style: Style | 'paste' | null, appendAll: boolean) => void;
  /** Go back to the recipe from before the previews. */
  onEndPreview: () => void;
  /** The recipe from before the previews with this style applied: its thumbnail. */
  recipeFor: (style: Style) => EditParams;
  onCreate: () => void;
  /** Rename one of the user's styles; rejects if the name is taken. */
  onRename: (style: Style, name: string) => Promise<unknown>;
  onDelete: (style: Style) => void;
  /** Open the copy dialog. */
  onCopy: () => void;
  onPaste: (appendAll: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [highlighted, setHighlighted] = useState<Style | 'paste' | null>(null);
  const shift = useShiftKey(open);
  useEffect(() => {
    if (open) onPreview(highlighted, shift.held);
  }, [open, highlighted, shift.held]); // eslint-disable-line react-hooks/exhaustive-deps
  const find = (value: string | null) =>
    value === 'paste' ? 'paste' : (styles.find((s) => value === `apply:${s.id}`) ?? null);
  const own = styles.filter((s) => !s.builtIn);
  return (
    <>
      <Menu.Root
        lazyMount
        unmountOnExit
        onHighlightChange={({ highlightedValue: value }) => setHighlighted(find(value))}
        onOpenChange={({ open }) => {
          setOpen(open);
          if (!open) {
            setHighlighted(null);
            onEndPreview();
          }
        }}
        onSelect={({ value }) => {
          if (value === 'create') return onCreate();
          if (value === 'copy') return onCopy();
          if (value === 'manage') return setManaging(true);
          const found = find(value);
          if (found === 'paste') onPaste(shift.ref.current);
          else if (found) onApply(found, shift.ref.current);
        }}
      >
        <Menu.Trigger asChild>
          <Button size={HEADER_SIZE} variant="ghost" title="Styles: sets of modules to apply to other photos">
            <Palette /> Styles <ChevronDown />
          </Button>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="56">
              {styles.map((s) => (
                <Menu.Item key={s.id} value={`apply:${s.id}`} py="1">
                  <MenuThumbnail recipe={() => recipeFor(s)} />
                  <Text flex="1" truncate>
                    {s.name}
                  </Text>
                  <Text textStyle="2xs" color="fg.subtle">
                    {s.payload.modules.length}
                  </Text>
                </Menu.Item>
              ))}
              {styles.length > 0 && (
                <Text px="2" pb="1" textStyle="2xs" color="fg.subtle">
                  Shift: append all of its modules (also when pasting)
                </Text>
              )}
              {styles.length > 0 && <Menu.Separator />}
              <Menu.Item value="copy">
                <Copy /> Copy settings… <Menu.ItemCommand>{commandLabel('Ctrl+Shift+C')}</Menu.ItemCommand>
              </Menu.Item>
              <Menu.Item value="paste" disabled={!paste}>
                <ClipboardPaste />
                <Text flex="1" truncate maxW="48">
                  {paste ? `Paste from ${paste}` : 'Paste'}
                </Text>
                <Menu.ItemCommand>{commandLabel('Ctrl+V')}</Menu.ItemCommand>
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item value="create">
                <Plus /> Create style…
              </Menu.Item>
              {own.length > 0 && (
                <Menu.Item value="manage">
                  <Pencil /> Manage styles…
                </Menu.Item>
              )}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
      {managing && (
        <ManagerDialog
          title="Styles"
          description="Rename or delete your styles."
          items={own.map((s) => ({
            id: s.id,
            name: s.name,
            detail: s.payload.modules.length === 1 ? '1 module' : `${s.payload.modules.length} modules`,
            recipe: () => recipeFor(s),
            style: s,
          }))}
          empty="No styles yet"
          onRename={(item, name) => onRename(item.style, name)}
          onDelete={(item) => onDelete(item.style)}
          onClose={() => setManaging(false)}
        />
      )}
    </>
  );
});
