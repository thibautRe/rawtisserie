import { CloseButton, Drawer, HStack, Portal } from '@chakra-ui/react';
import type { ReactNode } from 'react';

/**
 * A side panel (the library's filters or info, the trash's) where it is on wide screens,
 * or on phones (`narrow`) in a drawer: from the side it's docked on, or a sheet from the
 * bottom. Inside the drawer the panel's own width and border give way to the drawer's.
 */
export function PanelDrawer({
  narrow,
  open,
  onClose,
  placement,
  title,
  children,
}: {
  narrow: boolean;
  open: boolean;
  onClose: () => void;
  placement: 'start' | 'bottom';
  /** The drawer's name, at its top. */
  title: ReactNode;
  children: ReactNode;
}) {
  if (!narrow) return children;
  return (
    <Drawer.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement={placement} size="xs">
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content
            maxH={placement === 'bottom' ? '85dvh' : undefined}
            w={placement === 'start' ? 'min(20rem, 88vw)' : undefined}
            roundedTop={placement === 'bottom' ? 'l3' : undefined}
            overflow="hidden"
          >
            <HStack px="4" py="2" borderBottomWidth="1px" flexShrink={0}>
              <Drawer.Title flex="1" textStyle="sm" fontWeight="semibold">
                {title}
              </Drawer.Title>
              <Drawer.CloseTrigger asChild position="static">
                <CloseButton size="sm" />
              </Drawer.CloseTrigger>
            </HStack>
            <Drawer.Body
              p="0"
              display="flex"
              flexDirection="column"
              minH="0"
              css={{ '& > aside': { width: 'full', flex: '1', minHeight: 0, borderWidth: 0 } }}
            >
              {children}
            </Drawer.Body>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}
