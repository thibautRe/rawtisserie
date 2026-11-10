/**
 * The LUT module's picker: built-in LUTs and the user's, previewed on the image while
 * highlighted (like module presets), plus adding a file and removing the user's.
 */
import { Box, Button, Menu, Portal, Stack, Text } from '@chakra-ui/react';
import type { EditParams, LutRef } from '@rawtisserie/pipeline';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { memo, useRef } from 'react';
import { LUT_ACCEPT, type LutChoice } from './luts.ts';
import { MenuThumbnail } from './thumbnails.tsx';

export const LutMenu = memo(
  ({
    triggerId,
    title,
    current,
    builtIn,
    own,
    local,
    onPick,
    onPreview,
    onEndPreview,
    recipeFor,
    onAdd,
    onRemove,
  }: {
    triggerId: string;
    title: string;
    current: LutRef | null;
    builtIn: readonly LutChoice[];
    own: readonly LutChoice[];
    /** The user's LUTs are kept in this browser. */
    local: boolean;
    /** Use this LUT. */
    onPick: (lut: LutChoice) => void;
    /** Show the image with this LUT (undefined: as it was) for now. */
    onPreview: (lut: LutChoice | undefined) => void;
    /** Go back to the recipe from before the previews. */
    onEndPreview: () => void;
    /** The recipe from before the previews with this LUT: its thumbnail. */
    recipeFor: (lut: LutChoice) => EditParams;
    onAdd: (file: File) => void;
    onRemove: (lut: LutChoice) => void;
  }) => {
    const input = useRef<HTMLInputElement>(null);
    const find = (value: string | null | undefined): LutChoice | undefined => {
      if (!value?.startsWith('lut:')) return undefined;
      const id = value.slice(4);
      return [...builtIn, ...own].find((l) => l.id === id);
    };
    const item = (l: LutChoice) => (
      <Menu.Item key={l.id} value={`lut:${l.id}`} py="1">
        <MenuThumbnail recipe={() => recipeFor(l)} />
        <Stack gap="0" flex="1" minW="0">
          <Text truncate fontWeight={l.id === current?.id ? 'semibold' : undefined}>
            {l.name}
          </Text>
          {l.description && (
            <Text textStyle="2xs" color="fg.muted" truncate>
              {l.description}
            </Text>
          )}
        </Stack>
      </Menu.Item>
    );
    return (
      <>
        <input
          ref={input}
          type="file"
          accept={LUT_ACCEPT}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onAdd(file);
            e.target.value = '';
          }}
        />
        <Menu.Root
          // The trigger keeps the menu's id for it (the label points at it), or the
          // menu can't find it to position itself.
          ids={{ trigger: triggerId }}
          lazyMount
          unmountOnExit
          onHighlightChange={({ highlightedValue }) => onPreview(find(highlightedValue))}
          onOpenChange={({ open }) => !open && onEndPreview()}
          onSelect={({ value }) => {
            if (value === 'add') return input.current?.click();
            const lut = find(value);
            if (lut) onPick(lut);
          }}
        >
          <Menu.Trigger asChild>
            <Button size="xs" variant="outline" flex="1" minW="0" justifyContent="space-between">
              <Text truncate color={current ? undefined : 'fg.muted'}>
                {current ? current.name || 'Unnamed LUT' : 'Choose a LUT…'}
              </Text>
              <ChevronDown />
            </Button>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content minW="64" maxW="sm" maxH="96" overflowY="auto" aria-label={`${title}: LUTs`}>
                {builtIn.length > 0 && (
                  <Menu.ItemGroup>
                    <Menu.ItemGroupLabel>Built-in</Menu.ItemGroupLabel>
                    {builtIn.map(item)}
                  </Menu.ItemGroup>
                )}
                {own.length > 0 && (
                  <Menu.ItemGroup>
                    <Menu.ItemGroupLabel>{local ? 'Own (in this browser)' : 'Own'}</Menu.ItemGroupLabel>
                    {own.map(item)}
                  </Menu.ItemGroup>
                )}
                <Menu.Separator />
                <Menu.Item value="add">
                  <Plus /> Add a LUT…
                  <Box as="span" ms="auto" textStyle="2xs" color="fg.subtle">
                    .cube, Hald PNG
                  </Box>
                </Menu.Item>
                {own.length > 0 && (
                  <Menu.Root
                    positioning={{ placement: 'right-start', gutter: 2 }}
                    onSelect={({ value }) => {
                      const lut = own.find((l) => l.id === value);
                      if (lut) onRemove(lut);
                    }}
                  >
                    <Menu.TriggerItem>
                      <Trash2 /> Remove a LUT
                    </Menu.TriggerItem>
                    <Portal>
                      <Menu.Positioner>
                        <Menu.Content>
                          {own.map((l) => (
                            <Menu.Item key={l.id} value={l.id}>
                              {l.name}
                            </Menu.Item>
                          ))}
                        </Menu.Content>
                      </Menu.Positioner>
                    </Portal>
                  </Menu.Root>
                )}
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
      </>
    );
  },
  (a, b) =>
    a.triggerId === b.triggerId &&
    a.title === b.title &&
    a.current === b.current &&
    a.builtIn === b.builtIn &&
    a.own === b.own &&
    a.local === b.local,
);
