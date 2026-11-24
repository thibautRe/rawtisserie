import { Box, Menu, Portal, Text } from '@chakra-ui/react';
import { type ModuleKind, MODULE_KINDS, type ModulePreset, type Style } from '@rawtisserie/pipeline';
import { useEffect, useState } from 'react';
import { usePresetLibrary } from '../develop/presets.tsx';
import { MODULE_TITLES } from '../develop/changes.ts';
import { useShiftKey } from '../lib/useShiftKey.ts';
import { pasteEdit, readClipboard, useClipboard } from '../develop/editClipboard.ts';
import { ChevronRight, ClipboardPaste, Copy } from 'lucide-react';
import { type BatchEdit, presetEdit, styleEdit } from './batchEdit.ts';
import { commandLabel } from '../lib/keys.ts';

/**
 * Apply a style or a module preset to the selected versions (roadmap 8.1). A style
 * applies each module as it was saved (replace or append), or with Shift appends them
 * all. With `onPreview`, the highlighted edit is previewed (null: none) while the menu is
 * open (`onOpenChange`). With `submenu`, it opens from `children`, an item of another menu.
 */
export function ApplyMenu({
  onApply,
  onPreview,
  onOpenChange,
  onCopy,
  submenu = false,
  children,
}: {
  onApply: (edit: BatchEdit) => void;
  /** Copy the photo's settings (one photo selected): opens the copy dialog. */
  onCopy?: () => void;
  onPreview?: (edit: BatchEdit | null) => void;
  onOpenChange?: (open: boolean) => void;
  submenu?: boolean;
  children: React.ReactNode;
}) {
  const { styles, modulePresets } = usePresetLibrary();
  const kinds = MODULE_KINDS.filter((k) => modulePresets[k]?.length) as ModuleKind[];
  const [open, setOpen] = useState(false);
  const clipboard = useClipboard();
  // The highlighted style or paste, previewed with Shift's mode as it changes.
  const [highlighted, setHighlighted] = useState<Style | 'paste' | null>(null);
  const shift = useShiftKey(open);
  const editOf = (item: Style | 'paste', appendAll: boolean) => {
    if (item !== 'paste') return styleEdit(item, appendAll);
    const clip = readClipboard();
    return clip && pasteEdit(clip, appendAll);
  };
  useEffect(() => {
    if (open && highlighted) onPreview?.(editOf(highlighted, shift.held));
  }, [open, highlighted, shift.held]); // eslint-disable-line react-hooks/exhaustive-deps
  const findStyle = (value: string | null) =>
    value === 'paste' ? 'paste' : (styles.find((s) => value === `style:${s.id}`) ?? null);

  const styleItem = (s: Style) => (
    <Menu.Item key={s.id} value={`style:${s.id}`}>
      <Text flex="1" truncate>
        {s.name}
      </Text>
      <Text textStyle="2xs" color="fg.subtle">
        {s.payload.modules.length}
      </Text>
    </Menu.Item>
  );

  const presetGroup = (kind: ModuleKind) => {
    const presets = modulePresets[kind]!;
    const item = (p: ModulePreset) => (
      <Menu.Item key={p.id} value={p.id}>
        {p.name}
      </Menu.Item>
    );
    return (
      <Menu.Root
        key={kind}
        positioning={{ placement: 'left-start', gutter: 2 }}
        onSelect={({ value }) => {
          const preset = presets.find((p) => p.id === value);
          if (preset) onApply(presetEdit(preset));
        }}
        onHighlightChange={({ highlightedValue: v }) => {
          const preset = presets.find((p) => p.id === v);
          onPreview?.(preset ? presetEdit(preset) : null);
        }}
      >
        <Menu.TriggerItem
          onPointerEnter={() => {
            setHighlighted(null);
            onPreview?.(null);
          }}
        >
          {MODULE_TITLES[kind]}
          <SubmenuChevron />
        </Menu.TriggerItem>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="52" maxW="md">
              {presets.some((p) => p.builtIn) && (
                <Menu.ItemGroup>
                  <Menu.ItemGroupLabel>Built-in</Menu.ItemGroupLabel>
                  {presets.filter((p) => p.builtIn).map(item)}
                </Menu.ItemGroup>
              )}
              {presets.some((p) => !p.builtIn) && (
                <Menu.ItemGroup>
                  <Menu.ItemGroupLabel>Own</Menu.ItemGroupLabel>
                  {presets.filter((p) => !p.builtIn).map(item)}
                </Menu.ItemGroup>
              )}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    );
  };

  return (
    <Menu.Root
      lazyMount
      unmountOnExit
      positioning={submenu ? { placement: 'left-start', gutter: 2 } : undefined}
      onOpenChange={({ open }) => {
        setOpen(open);
        if (!open) setHighlighted(null);
        onOpenChange?.(open);
      }}
      onHighlightChange={({ highlightedValue: value }) => {
        const style = findStyle(value);
        setHighlighted(style);
        if (!style) onPreview?.(null);
      }}
      onSelect={({ value }) => {
        if (value === 'copy') return onCopy?.();
        const item = findStyle(value);
        const edit = item && editOf(item, shift.ref.current);
        if (edit) onApply(edit);
      }}
    >
      {submenu ? (
        <Menu.TriggerItem>
          {children}
          <SubmenuChevron />
        </Menu.TriggerItem>
      ) : (
        <Menu.Trigger asChild>{children}</Menu.Trigger>
      )}
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="52">
            {(clipboard || onCopy) && (
              <>
                <Menu.ItemGroup>
                  {onCopy && (
                    <Menu.Item value="copy">
                      <Copy /> Copy settings… <Menu.ItemCommand>{commandLabel('Ctrl+Shift+C')}</Menu.ItemCommand>
                    </Menu.Item>
                  )}
                  {clipboard && (
                    <Menu.Item value="paste">
                      <ClipboardPaste />
                      <Text flex="1" truncate maxW="48">
                        Paste from {clipboard.source}
                      </Text>
                      <Menu.ItemCommand>{commandLabel('Ctrl+V')}</Menu.ItemCommand>
                    </Menu.Item>
                  )}
                </Menu.ItemGroup>
                <Menu.Separator />
              </>
            )}
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel>Styles</Menu.ItemGroupLabel>
              {styles.map(styleItem)}
              {!styles.length && (
                <Text px="2" py="1.5" textStyle="xs" color="fg.muted">
                  No styles yet: create them in the developer
                </Text>
              )}
              {styles.length > 0 && (
                <Text px="2" pb="1" textStyle="2xs" color="fg.subtle">
                  Shift: append all of its modules (also when pasting)
                </Text>
              )}
            </Menu.ItemGroup>
            <Menu.Separator />
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel>Module presets</Menu.ItemGroupLabel>
              {kinds.map(presetGroup)}
            </Menu.ItemGroup>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

/** Marks an item opening a submenu (the usual right chevron, whichever side it opens on). */
function SubmenuChevron() {
  return (
    <Box asChild ms="auto" color="fg.subtle">
      <ChevronRight />
    </Box>
  );
}
