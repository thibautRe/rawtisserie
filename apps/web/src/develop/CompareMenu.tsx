import { Box, Button, HStack, IconButton, Image, Menu, Portal, Text } from '@chakra-ui/react';
import { ChevronDown, SplitSquareHorizontal } from 'lucide-react';
import { memo } from 'react';
import type { CompareLayout, CompareTarget, CompareVersion } from './compare.ts';
import { HEADER_SIZE } from '../lib/headerSize.ts';

const LAYOUTS: { value: CompareLayout; label: string }[] = [
  { value: 'split', label: 'Split' },
  { value: 'sideBySide', label: 'Side by side' },
];

/** A target as a menu value. */
export const targetValue = (t: CompareTarget) => (t.kind === 'history' ? `h:${t.seq}` : `v:${t.id}`);

function parseTarget(value: string): CompareTarget {
  return value.startsWith('v:')
    ? { kind: 'version', id: value.slice(2) }
    : { kind: 'history', seq: Number(value.slice(2)) };
}

/**
 * The toolbar's Compare button (roadmap M5): on or off, and a menu for the layout and
 * what the edited image is compared with (a history entry, or another version).
 */
export const CompareMenu = memo(function CompareMenu({
  on,
  layout,
  target,
  entries,
  versions,
  onToggle,
  onLayout,
  onTarget,
}: {
  on: boolean;
  layout: CompareLayout;
  target: CompareTarget;
  entries: readonly { label: string }[];
  versions: readonly CompareVersion[];
  onToggle: () => void;
  onLayout: (layout: CompareLayout) => void;
  /** Also turns the comparison on. */
  onTarget: (target: CompareTarget) => void;
}) {
  const value = targetValue(target);
  const pick = (e: { value: string }) => onTarget(parseTarget(e.value));
  return (
    <HStack gap="0">
      <Button
        size={HEADER_SIZE}
        variant={on ? 'subtle' : 'ghost'}
        colorPalette={on ? 'orange' : undefined}
        aria-pressed={on}
        title={
          on
            ? 'Stop comparing (Y or Esc)'
            : 'Compare with an earlier history entry or another version (Y). Hold \\ to see the original.'
        }
        onClick={onToggle}
      >
        <SplitSquareHorizontal /> Compare
      </Button>
      <Menu.Root positioning={{ placement: 'bottom-end' }}>
        <Menu.Trigger asChild>
          <IconButton aria-label="Compare options" size={HEADER_SIZE} variant="ghost" minW="6">
            <ChevronDown />
          </IconButton>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="60" maxH="min(32rem, 80vh)" overflowY="auto">
              <Menu.ItemGroup>
                <Menu.ItemGroupLabel>Layout</Menu.ItemGroupLabel>
                <Menu.RadioItemGroup value={layout} onValueChange={(e) => onLayout(e.value as CompareLayout)}>
                  {LAYOUTS.map((l) => (
                    <Menu.RadioItem key={l.value} value={l.value}>
                      {l.label}
                      <Menu.ItemIndicator />
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioItemGroup>
              </Menu.ItemGroup>
              <Menu.Separator />
              {versions.length > 0 && (
                <Menu.ItemGroup>
                  <Menu.ItemGroupLabel>Other versions</Menu.ItemGroupLabel>
                  <Menu.RadioItemGroup value={value} onValueChange={pick}>
                    {versions.map((v) => (
                      <Menu.RadioItem key={v.id} value={`v:${v.id}`}>
                        <Box w="8" h="6" flexShrink={0} bg="bg.muted" borderRadius="xs" overflow="hidden">
                          {v.thumbUrl && <Image src={v.thumbUrl} alt="" w="full" h="full" objectFit="cover" />}
                        </Box>
                        <Text flex="1" truncate>
                          {v.label}
                        </Text>
                        <Menu.ItemIndicator />
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioItemGroup>
                </Menu.ItemGroup>
              )}
              <Menu.ItemGroup>
                <Menu.ItemGroupLabel>History</Menu.ItemGroupLabel>
                <Menu.RadioItemGroup value={value} onValueChange={pick}>
                  {entries
                    .map((e, i) => (
                      <Menu.RadioItem key={i} value={`h:${i + 1}`}>
                        <Text
                          as="span"
                          w="5"
                          flexShrink={0}
                          textAlign="end"
                          color="fg.subtle"
                          fontFamily="numeric"
                          fontVariantNumeric="tabular-nums"
                        >
                          {i + 1}
                        </Text>
                        <Text flex="1" truncate>
                          {e.label}
                        </Text>
                        <Menu.ItemIndicator />
                      </Menu.RadioItem>
                    ))
                    .reverse()}
                  <Menu.RadioItem value="h:0">
                    <Text
                      as="span"
                      w="5"
                      flexShrink={0}
                      textAlign="end"
                      color="fg.subtle"
                      fontFamily="numeric"
                      fontVariantNumeric="tabular-nums"
                    >
                      0
                    </Text>
                    <Text flex="1">Original</Text>
                    <Menu.ItemIndicator />
                  </Menu.RadioItem>
                </Menu.RadioItemGroup>
              </Menu.ItemGroup>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </HStack>
  );
});
