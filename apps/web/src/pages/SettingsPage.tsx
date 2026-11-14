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
  Separator,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { ChevronRight, Copy, KeyRound, Send, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  useAccessTokens,
  useChangePassword,
  useConnectInstance,
  useCreateAccessToken,
  useDisconnectInstance,
  useInstances,
  useMe,
  useRevokeAccessToken,
  useStorage,
  useTrashSummary,
} from '../api/hooks.ts';
import type { AccessToken, RemoteInstance } from '../api/types.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { hostOf, startTransfer } from '../components/transfer.tsx';
import { AppMenu } from '../components/AppMenu.tsx';
import { StorageBreakdown } from '../components/StorageMeter.tsx';
import { toaster } from '../components/toaster.tsx';
import { TRASH_PATH } from '../components/trash.tsx';
import { formatBytes, formatDateTime } from '../lib/format.ts';

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
          <InstancesSection />
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

  const close = () => setEditing(false);
  // Once it's closed: emptied while it fades out, it would flash.
  const reset = () => {
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

      <Dialog.Root open={editing} onOpenChange={(e) => !e.open && close()} onExitComplete={reset} size="sm">
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

/** A row of a list in a section: an icon, what it is, and its actions. */
function ItemRow({
  icon,
  title,
  detail,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <HStack gap="3" p="3" borderWidth="1px" borderRadius="md" justify="space-between">
      <HStack gap="3" minW="0">
        <Box color="fg.muted">{icon}</Box>
        <Box minW="0">
          <Text fontWeight="medium" truncate>
            {title}
          </Text>
          <Text textStyle="sm" color="fg.muted" truncate>
            {detail}
          </Text>
        </Box>
      </HStack>
      <HStack gap="2" flexShrink={0}>
        {children}
      </HStack>
    </HStack>
  );
}

/** Sending photos to other instances, and receiving them from there. */
function InstancesSection() {
  return (
    <Section title="Other instances">
      <Stack gap="6">
        <SendingPart />
        <Separator />
        <ReceivingPart />
      </Stack>
    </Section>
  );
}

function PartHeading({ children }: { children: React.ReactNode }) {
  return (
    <Heading size="sm" mb="-1">
      {children}
    </Heading>
  );
}

/** Sending: the instances connected here, to send photos to. */
function SendingPart() {
  const { data: instances } = useInstances();
  const disconnect = useDisconnectInstance();
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<RemoteInstance | null>(null);
  return (
    <>
      <Stack gap="3">
        <PartHeading>Sending</PartHeading>
        <Text textStyle="sm" color="fg.muted">
          Send photos to another RAWtisserie (with their edits, culling and metadata), from the library or all at once.
        </Text>
        {instances?.map((i) => (
          <ItemRow key={i.id} icon={<Server size={18} />} title={hostOf(i.url)} detail={i.account}>
            <Button size="xs" variant="outline" onClick={() => void startTransfer(i, { everything: true })}>
              <Send /> Send everything
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setDisconnecting(i)}>
              Disconnect
            </Button>
          </ItemRow>
        ))}
        <Button size="sm" variant="outline" alignSelf="start" onClick={() => setConnecting(true)}>
          Connect an instance…
        </Button>
      </Stack>
      <ConnectDialog open={connecting} onClose={() => setConnecting(false)} />
      <ConfirmDialog
        text={
          disconnecting && {
            title: `Disconnect ${hostOf(disconnecting.url)}?`,
            body:
              `You won’t be able to send photos to ${disconnecting.account} there any more. ` +
              'What you sent stays there. To send again, connect it with a new token from there.',
          }
        }
        confirm="Disconnect"
        onConfirm={() => {
          disconnect.mutate(disconnecting!.id);
          setDisconnecting(null);
        }}
        onClose={() => setDisconnecting(null)}
      />
    </>
  );
}

function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connect = useConnectInstance();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const close = onClose;
  const reset = () => {
    setUrl('');
    setToken('');
    connect.reset();
  };
  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && close()} onExitComplete={reset} size="sm">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content asChild>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                connect.mutate(
                  { url, token },
                  {
                    onSuccess: (i) => {
                      toaster.create({
                        type: 'success',
                        title: `Connected to ${hostOf(i.url)}`,
                        description: i.account,
                      });
                      close();
                    },
                  },
                );
              }}
            >
              <Dialog.Header>
                <Dialog.Title>Connect an instance</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Stack gap="4">
                  <Text textStyle="sm" color="fg.muted">
                    On the other instance, make an access token (Settings, Access tokens), then paste it here.
                  </Text>
                  <Field.Root>
                    <Field.Label>Address</Field.Label>
                    <Input
                      autoFocus
                      placeholder="photos.example.com"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                    />
                  </Field.Root>
                  <Field.Root invalid={connect.isError}>
                    <Field.Label>Access token</Field.Label>
                    <Input
                      type="password"
                      autoComplete="off"
                      placeholder="rtt_…"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                    <Field.ErrorText>{connect.error?.message}</Field.ErrorText>
                  </Field.Root>
                </Stack>
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button variant="outline">Cancel</Button>
                </Dialog.ActionTrigger>
                <Button type="submit" colorPalette="orange" loading={connect.isPending} disabled={!url || !token}>
                  Connect
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
  );
}

/** Receiving: tokens another instance uses to send photos here. */
function ReceivingPart() {
  const { data: tokens } = useAccessTokens();
  const revoke = useRevokeAccessToken();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<AccessToken | null>(null);
  return (
    <>
      <Stack gap="3">
        <PartHeading>Receiving: access tokens</PartHeading>
        <Text textStyle="sm" color="fg.muted">
          For another instance to send photos here. A token can only add to your library.
        </Text>
        {tokens?.map((t) => (
          <ItemRow
            key={t.id}
            icon={<KeyRound size={18} />}
            title={t.name}
            detail={
              `Made ${formatDateTime(t.createdAt)}` +
              (t.lastUsedAt ? ` · last used ${formatDateTime(t.lastUsedAt)}` : ' · never used')
            }
          >
            <Button size="xs" variant="ghost" colorPalette="red" onClick={() => setRevoking(t)}>
              Revoke
            </Button>
          </ItemRow>
        ))}
        <Button size="sm" variant="outline" alignSelf="start" onClick={() => setCreating(true)}>
          New token…
        </Button>
      </Stack>
      <NewTokenDialog open={creating} onClose={() => setCreating(false)} />
      <ConfirmDialog
        text={
          revoking && {
            title: `Revoke “${revoking.name}”?`,
            body:
              'Any instance using this token won’t be able to send photos here any more. ' +
              'What it sent stays in your library.',
          }
        }
        confirm="Revoke"
        onConfirm={() => {
          revoke.mutate(revoking!.id);
          setRevoking(null);
        }}
        onClose={() => setRevoking(null)}
      />
    </>
  );
}

function NewTokenDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateAccessToken();
  const [name, setName] = useState('');
  const [made, setMade] = useState<AccessToken | null>(null);
  const close = onClose;
  // Once it's closed, not while it closes: the first step would show again meanwhile.
  const reset = () => {
    setName('');
    setMade(null);
    create.reset();
  };
  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && close()} onExitComplete={reset} size="sm">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content asChild>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (made) return close();
                create.mutate(name, { onSuccess: setMade });
              }}
            >
              <Dialog.Header>
                <Dialog.Title>{made ? 'Your new token' : 'New access token'}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {made ? (
                  <Stack gap="3">
                    <Text textStyle="sm" color="fg.muted">
                      Paste it into the other instance (Settings, Other instances). It won’t be shown again.
                    </Text>
                    <HStack gap="2">
                      <Input readOnly value={made.token} fontFamily="mono" onFocus={(e) => e.target.select()} />
                      <Button
                        variant="outline"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(made.token!)
                            .then(() => toaster.create({ type: 'success', title: 'Token copied', duration: 2000 }))
                        }
                      >
                        <Copy /> Copy
                      </Button>
                    </HStack>
                  </Stack>
                ) : (
                  <Field.Root invalid={create.isError}>
                    <Field.Label>Name</Field.Label>
                    <Input autoFocus placeholder="My laptop" value={name} onChange={(e) => setName(e.target.value)} />
                    <Field.HelperText>Where it will be used, to know which to revoke.</Field.HelperText>
                    <Field.ErrorText>{create.error?.message}</Field.ErrorText>
                  </Field.Root>
                )}
              </Dialog.Body>
              <Dialog.Footer>
                {made ? (
                  <Button type="submit" colorPalette="orange">
                    Done
                  </Button>
                ) : (
                  <>
                    <Dialog.ActionTrigger asChild>
                      <Button variant="outline">Cancel</Button>
                    </Dialog.ActionTrigger>
                    <Button type="submit" colorPalette="orange" loading={create.isPending} disabled={!name.trim()}>
                      Create token
                    </Button>
                  </>
                )}
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
}
