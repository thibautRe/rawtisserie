import { Button, CloseButton, Dialog, Portal, Text } from '@chakra-ui/react';
import { useRef } from 'react';

/**
 * Asking before something that can't be undone (`danger`, red), or that's large (orange):
 * open while `text` is non-null. The text stays while it closes, so it doesn't empty
 * during the animation.
 */
export function ConfirmDialog({
  text,
  confirm,
  onConfirm,
  onClose,
  danger = true,
}: {
  text: { title: string; body?: string } | null;
  /** The button doing it. */
  confirm: string;
  /** Red, for what can't be undone or loses something; else the app's orange. */
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const shown = useRef(text);
  if (text) shown.current = text;
  return (
    <Dialog.Root open={!!text} onOpenChange={(e) => !e.open && onClose()} role="alertdialog">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{shown.current?.title}</Dialog.Title>
            </Dialog.Header>
            {shown.current?.body && (
              <Dialog.Body>
                <Text>{shown.current.body}</Text>
              </Dialog.Body>
            )}
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline">Cancel</Button>
              </Dialog.ActionTrigger>
              <Button colorPalette={danger ? 'red' : 'orange'} onClick={onConfirm}>
                {confirm}
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
