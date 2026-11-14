import { Button, CloseButton, Dialog, Portal, Text } from '@chakra-ui/react';
import { useRef } from 'react';

/**
 * Asking before something that can't be undone: open while `text` is non-null. The text
 * stays while it closes, so it doesn't empty during the animation.
 */
export function ConfirmDialog({
  text,
  confirm,
  onConfirm,
  onClose,
}: {
  text: { title: string; body: string } | null;
  /** The button doing it (red). */
  confirm: string;
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
            <Dialog.Body>
              <Text>{shown.current?.body}</Text>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline">Cancel</Button>
              </Dialog.ActionTrigger>
              <Button colorPalette="red" onClick={onConfirm}>
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
