import { Box, Collapsible, HStack, Heading, Stack } from '@chakra-ui/react';
import { ChevronDown } from 'lucide-react';

/** The library's side panels: blocks on the panel's background, as the developer's modules. */
export const BLOCKS_PROPS = { gap: '1.5', py: '1.5', bg: 'bg', overflowY: 'auto' } as const;

/** As a span inside a foldable block's button (no heading may go in one). */
function BlockTitle({ children, inButton }: { children: React.ReactNode; inButton?: boolean }) {
  return (
    <Heading
      as={inButton ? 'span' : undefined}
      size="xs"
      fontSize="xs"
      fontWeight="bold"
      fontFamily="label"
      textTransform="uppercase"
      letterSpacing="wider"
      color="fg.muted"
    >
      {children}
    </Heading>
  );
}

/**
 * A block of a library side panel, styled like the developer's modules: an uppercase
 * title with `actions` on its right, over its content. Foldable with `open` and
 * `onOpenChange` (`badge` shows next to the title, folded or not).
 */
export function PanelBlock({
  title,
  actions,
  badge,
  open,
  onOpenChange,
  children,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  badge?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  if (onOpenChange)
    return (
      <Collapsible.Root asChild open={open} onOpenChange={(e) => onOpenChange(e.open)}>
        <Stack gap="0" px="3" pt="2" pb={open ? '3' : '2'} bg="bg.panel">
          <HStack justify="space-between" h="6">
            <Collapsible.Trigger
              display="flex"
              alignItems="center"
              flex="1"
              h="full"
              cursor="pointer"
              gap="2"
              borderRadius="sm"
              focusRing="outside"
            >
              <BlockTitle inButton>{title}</BlockTitle>
              {badge}
              <Box
                asChild
                ms="auto"
                color="fg.muted"
                transform={open ? 'rotate(180deg)' : undefined}
                transition="transform 0.15s"
              >
                <ChevronDown size={14} />
              </Box>
            </Collapsible.Trigger>
            {actions}
          </HStack>
          <Collapsible.Content>
            <Stack gap="1.5" pt="1.5">
              {children}
            </Stack>
          </Collapsible.Content>
        </Stack>
      </Collapsible.Root>
    );
  return (
    <Stack gap="1.5" px="3" pt={title ? '2' : '3'} pb="3" bg="bg.panel">
      {title && (
        <HStack justify="space-between" h="6">
          <HStack gap="2">
            <BlockTitle>{title}</BlockTitle>
            {badge}
          </HStack>
          {actions}
        </HStack>
      )}
      {children}
    </Stack>
  );
}
