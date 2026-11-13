import {
  Badge,
  Box,
  Button,
  Checkbox,
  CloseButton,
  Dialog,
  Field,
  Flex,
  HStack,
  Heading,
  IconButton,
  Input,
  Portal,
  Stack,
  Switch,
  Table,
  Text,
} from '@chakra-ui/react';
import { Copy, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  type NewInvitation,
  useAdminUsers,
  useCreateInvitation,
  useInvitations,
  useMe,
  useRevokeInvitation,
  useUpdateAdminUser,
} from '../api/hooks.ts';
import type { AdminUser, Invitation, InvitationStatus } from '../api/types.ts';
import { AppMenu } from '../components/AppMenu.tsx';
import { StorageMeter } from '../components/StorageMeter.tsx';
import { toaster } from '../components/toaster.tsx';
import { GB, formatBytes } from '../lib/format.ts';
import { NotFoundPage } from './NotFoundPage.tsx';

const NUMERIC = { fontFamily: 'numeric', fontVariantNumeric: 'tabular-nums' } as const;

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null;
const formatQuota = (quota: number | null) => (quota === null ? 'Unlimited' : formatBytes(quota));
const invitationLink = (code: string) => `${location.origin}/login?invite=${code}`;

async function copyLink(code: string) {
  await navigator.clipboard.writeText(invitationLink(code));
  toaster.create({ type: 'success', title: 'Invitation link copied' });
}

/** Users' storage quotas and invitations. Admins only (the API checks too). */
export function AdminPage() {
  const { data: me } = useMe();
  if (!me?.isAdmin) return <NotFoundPage />;
  return (
    <Flex direction="column" h="full">
      <HStack px="3" py="2" gap="2" borderBottomWidth="1px">
        <AppMenu />
        <Heading size="sm">Admin</Heading>
      </HStack>
      <Box flex="1" overflowY="auto">
        <Stack gap="10" p="6" maxW="6xl" mx="auto">
          <UsersSection myId={me.id} />
          <InvitationsSection />
        </Stack>
      </Box>
    </Flex>
  );
}

// ── Users ───────────────────────────────────────────────────────────────────

function UsersSection({ myId }: { myId: string }) {
  const { data: users, error } = useAdminUsers();
  const update = useUpdateAdminUser();
  const [editing, setEditing] = useState<AdminUser | null>(null);

  return (
    <Stack gap="3">
      <Heading size="md">Users</Heading>
      {error && <Text color="fg.error">{error.message}</Text>}
      <Table.ScrollArea borderWidth="1px" rounded="md">
        <Table.Root size="sm">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>User</Table.ColumnHeader>
              <Table.ColumnHeader>Joined</Table.ColumnHeader>
              <Table.ColumnHeader>Invitation</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="end">Photos</Table.ColumnHeader>
              <Table.ColumnHeader>Storage</Table.ColumnHeader>
              <Table.ColumnHeader />
              <Table.ColumnHeader>Admin</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {users?.map((u) => (
              <Table.Row key={u.id}>
                <Table.Cell>
                  <Text>{u.displayName}</Text>
                  <Text textStyle="xs" color="fg.muted">
                    {u.email}
                  </Text>
                </Table.Cell>
                <Table.Cell>{formatDate(u.createdAt)}</Table.Cell>
                <Table.Cell color={u.invitation ? undefined : 'fg.muted'}>{u.invitation ?? '—'}</Table.Cell>
                <Table.Cell textAlign="end" {...NUMERIC}>
                  {u.photos}
                </Table.Cell>
                <Table.Cell>
                  <StorageMeter usage={{ used: u.storageUsed, quota: u.storageQuota }} />
                </Table.Cell>
                <Table.Cell>
                  <Button size="xs" variant="outline" onClick={() => setEditing(u)}>
                    Quota…
                  </Button>
                </Table.Cell>
                <Table.Cell>
                  <Switch.Root
                    size="sm"
                    colorPalette="orange"
                    checked={u.isAdmin}
                    disabled={u.id === myId}
                    title={u.id === myId ? 'You can’t remove your own admin rights' : undefined}
                    onCheckedChange={(e) =>
                      update.mutate(
                        { id: u.id, isAdmin: e.checked },
                        { onError: (err) => toaster.create({ type: 'error', title: err.message }) },
                      )
                    }
                    aria-label={`${u.displayName} is an admin`}
                  >
                    <Switch.HiddenInput />
                    <Switch.Control />
                  </Switch.Root>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Table.ScrollArea>
      <QuotaDialog
        user={editing}
        onClose={() => setEditing(null)}
        onSave={(storageQuota) =>
          editing &&
          update.mutate(
            { id: editing.id, storageQuota },
            {
              onSuccess: () => setEditing(null),
              onError: (err) => toaster.create({ type: 'error', title: err.message }),
            },
          )
        }
        saving={update.isPending}
      />
    </Stack>
  );
}

/** A quota in GB, or unlimited. Lowering it below the usage deletes nothing. */
function QuotaFields({ initial }: { initial: number | null }) {
  const [unlimited, setUnlimited] = useState(initial === null);
  return (
    <Stack gap="3">
      <Field.Root disabled={unlimited}>
        <Field.Label>Storage quota (GB)</Field.Label>
        <Input
          name="quotaGb"
          type="number"
          min="0"
          step="any"
          required={!unlimited}
          defaultValue={initial === null ? 50 : Number((initial / GB).toFixed(2))}
          {...NUMERIC}
        />
        <Field.HelperText>Original RAW files only; previews don’t count.</Field.HelperText>
      </Field.Root>
      <Checkbox.Root name="unlimited" checked={unlimited} onCheckedChange={(e) => setUnlimited(!!e.checked)}>
        <Checkbox.HiddenInput />
        <Checkbox.Control />
        <Checkbox.Label>Unlimited</Checkbox.Label>
      </Checkbox.Root>
    </Stack>
  );
}

/** The quota from `QuotaFields`, in bytes (null: unlimited). */
function readQuota(form: FormData): number | null {
  if (form.get('unlimited')) return null;
  return Math.round(Number(form.get('quotaGb')) * GB);
}

function QuotaDialog({
  user,
  onClose,
  onSave,
  saving,
}: {
  user: AdminUser | null;
  onClose: () => void;
  onSave: (quota: number | null) => void;
  saving: boolean;
}) {
  return (
    <Dialog.Root open={!!user} onOpenChange={(e) => !e.open && onClose()} size="sm">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content asChild>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onSave(readQuota(new FormData(e.currentTarget)));
              }}
            >
              <Dialog.Header>
                <Dialog.Title>Storage for {user?.displayName}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {user && (
                  <Stack gap="4">
                    <Text textStyle="sm" color="fg.muted">
                      Using {formatBytes(user.storageUsed)} for {user.photos} photos. A quota below that deletes
                      nothing; it only stops new imports.
                    </Text>
                    <QuotaFields key={user.id} initial={user.storageQuota} />
                  </Stack>
                )}
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button variant="outline">Cancel</Button>
                </Dialog.ActionTrigger>
                <Button type="submit" colorPalette="orange" loading={saving}>
                  Save
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

// ── Invitations ─────────────────────────────────────────────────────────────

const STATUS: Record<InvitationStatus, { label: string; palette: string }> = {
  active: { label: 'Active', palette: 'green' },
  used: { label: 'Used up', palette: 'gray' },
  expired: { label: 'Expired', palette: 'orange' },
  revoked: { label: 'Revoked', palette: 'red' },
};

function InvitationsSection() {
  const { data: invitations, error } = useInvitations();
  const create = useCreateInvitation();
  const revoke = useRevokeInvitation();
  const [creating, setCreating] = useState(false);

  return (
    <Stack gap="3">
      <HStack justify="space-between">
        <Heading size="md">Invitations</Heading>
        <Button size="sm" colorPalette="orange" onClick={() => setCreating(true)}>
          <Plus /> New invitation
        </Button>
      </HStack>
      {error && <Text color="fg.error">{error.message}</Text>}
      {invitations?.length === 0 && (
        <Text color="fg.muted" textStyle="sm">
          No invitations yet. Each one is a link that creates accounts with the storage you choose.
        </Text>
      )}
      {!!invitations?.length && (
        <Table.ScrollArea borderWidth="1px" rounded="md">
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Invitation</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Accounts</Table.ColumnHeader>
                <Table.ColumnHeader>Storage each</Table.ColumnHeader>
                <Table.ColumnHeader>Expires</Table.ColumnHeader>
                <Table.ColumnHeader>Status</Table.ColumnHeader>
                <Table.ColumnHeader />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {invitations.map((inv) => (
                <InvitationRow key={inv.id} invitation={inv} onRevoke={() => revoke.mutate(inv.id)} />
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      )}
      <NewInvitationDialog
        open={creating}
        onClose={() => setCreating(false)}
        saving={create.isPending}
        onCreate={(body) =>
          create.mutate(body, {
            onSuccess: ({ invitation }) => {
              setCreating(false);
              void copyLink(invitation.code);
            },
            onError: (err) => toaster.create({ type: 'error', title: err.message }),
          })
        }
      />
    </Stack>
  );
}

function InvitationRow({ invitation: inv, onRevoke }: { invitation: Invitation; onRevoke: () => void }) {
  const status = STATUS[inv.status];
  return (
    <Table.Row>
      <Table.Cell>
        <HStack gap="1">
          <Stack gap="0" flex="1" minW="0">
            <Text truncate>{inv.label ?? 'Untitled'}</Text>
            <Text textStyle="xs" color="fg.muted" truncate>
              {formatDate(inv.createdAt)}
              {inv.createdBy && ` · ${inv.createdBy}`}
            </Text>
          </Stack>
          {inv.status === 'active' && (
            <IconButton
              size="xs"
              variant="ghost"
              aria-label="Copy the link"
              title="Copy the link"
              onClick={() => void copyLink(inv.code)}
            >
              <Copy />
            </IconButton>
          )}
        </HStack>
      </Table.Cell>
      <Table.Cell textAlign="end" {...NUMERIC}>
        {inv.uses} of {inv.maxUses}
      </Table.Cell>
      <Table.Cell {...NUMERIC}>{formatQuota(inv.storageQuota)}</Table.Cell>
      <Table.Cell color={inv.expiresAt ? undefined : 'fg.muted'}>{formatDate(inv.expiresAt) ?? 'Never'}</Table.Cell>
      <Table.Cell>
        <Badge colorPalette={status.palette}>{status.label}</Badge>
      </Table.Cell>
      <Table.Cell textAlign="end">
        {inv.status === 'active' && (
          <Button size="xs" variant="outline" colorPalette="red" onClick={onRevoke}>
            Revoke
          </Button>
        )}
      </Table.Cell>
    </Table.Row>
  );
}

function NewInvitationDialog({
  open,
  onClose,
  onCreate,
  saving,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (body: NewInvitation) => void;
  saving: boolean;
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
                const form = new FormData(e.currentTarget);
                const expires = String(form.get('expires') ?? '');
                onCreate({
                  label: String(form.get('label') ?? '').trim() || undefined,
                  maxUses: Number(form.get('maxUses')),
                  storageQuota: readQuota(form),
                  // To the end of that day, in local time.
                  expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
                });
              }}
            >
              <Dialog.Header>
                <Dialog.Title>New invitation</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {open && (
                  <Stack gap="4">
                    <Field.Root>
                      <Field.Label>Label</Field.Label>
                      <Input name="label" maxLength={200} placeholder="Who it’s for" autoFocus />
                      <Field.HelperText>Only admins see it.</Field.HelperText>
                    </Field.Root>
                    <Field.Root required>
                      <Field.Label>Accounts it can create</Field.Label>
                      <Input name="maxUses" type="number" min="1" max="10000" defaultValue="1" {...NUMERIC} />
                    </Field.Root>
                    <QuotaFields initial={50 * GB} />
                    <Field.Root>
                      <Field.Label>Expires</Field.Label>
                      <Input name="expires" type="date" />
                      <Field.HelperText>Leave empty for no expiry.</Field.HelperText>
                    </Field.Root>
                  </Stack>
                )}
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button variant="outline">Cancel</Button>
                </Dialog.ActionTrigger>
                <Button type="submit" colorPalette="orange" loading={saving}>
                  Create and copy link
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
