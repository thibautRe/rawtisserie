import { memo } from 'react';
import { Button, CloseButton, Dialog, HStack, Input, Portal, Text } from '@chakra-ui/react';

/** Asks for a name; an empty one is reported as null. Memoised: pass stable handlers. */
export const RenameDialog = memo(function RenameDialog({
  title,
  hint,
  maxLength,
  open,
  name,
  placeholder,
  onClose,
  onRename,
}: {
  title: string;
  hint: string;
  maxLength: number;
  open: boolean;
  name: string | null;
  placeholder: string;
  onClose: () => void;
  onRename: (name: string | null) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} size="sm">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content asChild>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const value = String(new FormData(e.currentTarget).get('name') ?? '').trim();
                onRename(value || null);
                onClose();
              }}
            >
              <Dialog.Header>
                <Dialog.Title>{title}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Input name="name" defaultValue={name ?? ''} placeholder={placeholder} maxLength={maxLength} autoFocus />
                <Text textStyle="xs" color="fg.muted" mt="2">
                  {hint}
                </Text>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack>
                  <Dialog.ActionTrigger asChild>
                    <Button variant="outline">Cancel</Button>
                  </Dialog.ActionTrigger>
                  <Button type="submit" colorPalette="orange">
                    Rename
                  </Button>
                </HStack>
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
});
