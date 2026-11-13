import {
  Box,
  Button,
  Card,
  CloseButton,
  Dialog,
  Field,
  Flex,
  HStack,
  Heading,
  Input,
  Portal,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { ChevronRight, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useChangePassword, useMe, useStorage, useTrashSummary } from '../api/hooks.ts';
import { AppMenu } from '../components/AppMenu.tsx';
import { StorageBreakdown } from '../components/StorageMeter.tsx';
import { toaster } from '../components/toaster.tsx';
import { TRASH_PATH } from '../components/trash.tsx';
import { formatBytes } from '../lib/format.ts';

/** The user's own settings: their account and password, their storage, and the trash. */
export function SettingsPage() {
  return (
    <Flex direction="column" h="full">
      <HStack px="3" py="2" gap="2" borderBottomWidth="1px">
        <AppMenu />
        <Heading size="sm">Settings</Heading>
      </HStack>
      <Box flex="1" overflowY="auto">
        <Stack p="6" maxW="3xl" mx="auto" gap="6">
          <StorageSection />
          <AccountSection />
        </Stack>
      </Box>
    </Flex>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card.Root variant="outline">
      <Card.Header>
        <Heading size="md">{title}</Heading>
      </Card.Header>
      <Card.Body>{children}</Card.Body>
    </Card.Root>
  );
}

function StorageSection() {
  const { data: storage } = useStorage();
  const { data: trash } = useTrashSummary();
  return (
    <Section title="Storage">
      <Stack gap="5">
        {storage ? <StorageBreakdown usage={storage} /> : <Skeleton h="24" />}
        <HStack
          asChild
          justify="space-between"
          gap="3"
          p="3"
          borderWidth="1px"
          borderRadius="md"
          _hover={{ bg: 'bg.muted' }}
          focusRing="outside"
        >
          <Link to={TRASH_PATH}>
            <HStack gap="3">
              <Trash2 size={18} />
              <Box>
                <Text fontWeight="medium">Trash</Text>
                <Text textStyle="sm" color="fg.muted">
                  {trash
                    ? trash.total
                      ? `${trash.total === 1 ? '1 item' : `${trash.total} items`}, ${formatBytes(trash.bytes)} · deleted for good after ${trash.days} days`
                      : `Empty · what you delete stays there for ${trash.days} days`
                    : '…'}
                </Text>
              </Box>
            </HStack>
            <ChevronRight size={16} />
          </Link>
        </HStack>
      </Stack>
    </Section>
  );
}

function AccountSection() {
  const { data: me } = useMe();
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitted, setSubmitted] = useState(false);
  /** The password dialog is open. */
  const [editing, setEditing] = useState(false);
  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = submitted && confirm !== next;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!current || next.length < 8 || confirm !== next) return;
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          toaster.create({
            type: 'success',
            title: 'Password changed',
          });
          close();
        },
      },
    );
  };

  const close = () => {
    setEditing(false);
    setCurrent('');
    setNext('');
    setConfirm('');
    setSubmitted(false);
    change.reset();
  };

  return (
    <Section title="Account">
      <HStack justify="space-between" gap="4">
        <Box>
          <Text fontWeight="medium">{me?.displayName}</Text>
          <Text textStyle="sm" color="fg.muted">
            {me?.email}
          </Text>
        </Box>
        <Button
          size="sm"
          variant="outline"
          bg="bg.emphasized"
          borderColor="border.emphasized"
          _hover={{ bg: 'bg.muted' }}
          onClick={() => setEditing(true)}
        >
          Change password…
        </Button>
      </HStack>

      <Dialog.Root open={editing} onOpenChange={(e) => !e.open && close()} size="sm">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content asChild>
              <form onSubmit={submit}>
                <Dialog.Header>
                  <Dialog.Title>Change password</Dialog.Title>
                </Dialog.Header>
                <Dialog.Body>
                  <Stack gap="4">
                    <Field.Root invalid={change.isError}>
                      <Field.Label>Current password</Field.Label>
                      <Input
                        autoFocus
                        type="password"
                        autoComplete="current-password"
                        value={current}
                        onChange={(e) => setCurrent(e.target.value)}
                      />
                      <Field.ErrorText>{change.error?.message}</Field.ErrorText>
                    </Field.Root>
                    <Field.Root invalid={tooShort}>
                      <Field.Label>New password</Field.Label>
                      <Input
                        type="password"
                        autoComplete="new-password"
                        value={next}
                        onChange={(e) => setNext(e.target.value)}
                      />
                      {!tooShort && <Field.HelperText>At least 8 characters.</Field.HelperText>}
                      <Field.ErrorText>At least 8 characters.</Field.ErrorText>
                    </Field.Root>
                    <Field.Root invalid={mismatch}>
                      <Field.Label>Repeat the new password</Field.Label>
                      <Input
                        type="password"
                        autoComplete="new-password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                      />
                      <Field.ErrorText>The two passwords differ.</Field.ErrorText>
                    </Field.Root>
                    <Text textStyle="sm" color="fg.muted">
                      Your other sessions will be signed out.
                    </Text>
                  </Stack>
                </Dialog.Body>
                <Dialog.Footer>
                  <Dialog.ActionTrigger asChild>
                    <Button variant="outline">Cancel</Button>
                  </Dialog.ActionTrigger>
                  <Button
                    type="submit"
                    colorPalette="orange"
                    loading={change.isPending}
                    disabled={!current || !next || !confirm}
                  >
                    Change password
                  </Button>
                </Dialog.Footer>
                <Dialog.CloseTrigger asChild>
                  <CloseButton size="sm" />
                </Dialog.CloseTrigger>
              </form>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Section>
  );
}
