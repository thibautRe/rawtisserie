import { IconButton, Portal, Tooltip } from '@chakra-ui/react';
import { Info } from 'lucide-react';
import { useState } from 'react';

/**
 * A small "i" that explains what's next to it in a tooltip: on hover, on keyboard
 * focus, and on a tap (touch screens have no hover).
 */
export function InfoTip({ children, label = 'More about this' }: { children: React.ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Root open={open} onOpenChange={(e) => setOpen(e.open)} openDelay={200} closeOnPointerDown={false}>
      <Tooltip.Trigger asChild>
        <IconButton
          size="2xs"
          variant="ghost"
          color="fg.subtle"
          aria-label={label}
          minW="auto"
          h="auto"
          p="0"
          onClick={() => setOpen((o) => !o)}
        >
          <Info />
        </IconButton>
      </Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content maxW="64" textStyle="xs">
            {children}
          </Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );
}
