import { Menu, Portal, Stack, Text } from '@chakra-ui/react';
import { type ModuleKind, MODULE_KINDS, type ModulePreset, type Style, type StyleMode } from '@rawtisserie/pipeline';
import { usePresetLibrary } from '../develop/presets.tsx';
import { MODULE_TITLES } from '../develop/changes.ts';
import { type BatchEdit, presetEdit, styleEdit } from './batchEdit.ts';

/**
 * Apply a style or a module preset to the selected versions (roadmap 8.1). A style asks
 * whether to replace or append, once for the whole selection. With `onPreview`, the
 * highlighted edit is previewed (null: none) while the menu is open (`onOpenChange`).
 */
export function ApplyMenu({
  onApply,
  onPreview,
  onOpenChange,
  children,
}: {
  onApply: (edit: BatchEdit) => void;
  onPreview?: (edit: BatchEdit | null) => void;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const { styles, modulePresets } = usePresetLibrary();
  const kinds = MODULE_KINDS.filter((k) => modulePresets[k]?.length) as ModuleKind[];

  const styleItem = (s: Style) => (
    <Menu.Root
      key={s.id}
      positioning={{ placement: 'left-start', gutter: 2 }}
      onSelect={({ value }) => onApply(styleEdit(s, value as StyleMode))}
      onHighlightChange={({ highlightedValue: v }) => onPreview?.(v ? styleEdit(s, v as StyleMode) : null)}
    >
      <Menu.TriggerItem onPointerEnter={() => onPreview?.(styleEdit(s, 'replace'))}>
        <Text flex="1" truncate>
          {s.name}
        </Text>
        <Text textStyle="2xs" color="fg.subtle">
          {s.payload.modules.length}
        </Text>
      </Menu.TriggerItem>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="56">
            <Menu.Item value="replace">
              <Stack gap="0">
                <Text>Apply</Text>
                <Text textStyle="2xs" color="fg.muted">
                  Replaces the modules it has
                </Text>
              </Stack>
            </Menu.Item>
            <Menu.Item value="append">
              <Stack gap="0">
                <Text>Append</Text>
                <Text textStyle="2xs" color="fg.muted">
                  Adds its modules as new instances
                </Text>
              </Stack>
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
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
        <Menu.TriggerItem onPointerEnter={() => onPreview?.(null)}>{MODULE_TITLES[kind]}</Menu.TriggerItem>
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
    <Menu.Root lazyMount unmountOnExit onOpenChange={({ open }) => onOpenChange?.(open)}>
      <Menu.Trigger asChild>{children}</Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="52">
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel>Styles</Menu.ItemGroupLabel>
              {styles.map(styleItem)}
              {!styles.length && (
                <Text px="2" py="1.5" textStyle="xs" color="fg.muted">
                  No styles yet: create them in the developer
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
