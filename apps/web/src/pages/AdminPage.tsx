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
  SimpleGrid,
  Stack,
  Stat,
  Switch,
  Table,
  Text,
} from '@chakra-ui/react';
import { Copy, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import {
  type NewInvitation,
  useAdminStats,
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
import { GB, formatBytes, formatDuration } from '../lib/format.ts';
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

const TABS = [
  { value: '', label: 'Overview' },
  { value: 'users', label: 'Users' },
  { value: 'invitations', label: 'Invitations' },
] as const;

const adminPath = (tab: string) => (tab ? `/admin/${tab}` : '/admin');

/**
 * The admin pages (`/admin`, `/admin/users`, `/admin/invitations`), one tab each. Admins
 * only: anyone else gets "not found", and the API refuses them too.
 */
export function AdminLayout() {
  const { data: me } = useMe();
  if (!me?.isAdmin) return <NotFoundPage />;
  return (
    <Flex direction="column" h="full">
      <HStack px="3" gap="4" borderBottomWidth="1px">
        <HStack gap="2" py="2">
          <AppMenu />
          <Heading size="sm">Admin</Heading>
        </HStack>
        {/* Pages, not panels: a nav of links (styled like line tabs), the current one marked. */}
        <HStack as="nav" aria-label="Admin pages" gap="0" alignSelf="stretch">
          {TABS.map((t) => (
            <Box
              key={t.value}
              asChild
              display="flex"
              alignItems="center"
              h="full"
              px="3"
              textStyle="sm"
              fontWeight="medium"
              color="fg.muted"
              borderBottomWidth="2px"
              borderColor="transparent"
              mb="-1px"
              _hover={{ color: 'fg' }}
              _currentPage={{ color: 'fg', borderColor: 'fg' }}
              focusRing="inside"
            >
              <NavLink to={adminPath(t.value)} end>
                {t.label}
              </NavLink>
            </Box>
          ))}
        </HStack>
      </HStack>
      <Box flex="1" overflowY="auto">
        <Box p="6" maxW="6xl" mx="auto">
          <Outlet />
        </Box>
      </Box>
    </Flex>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();
/** Exact below 10,000, compact above (12.3K). */
const formatCount = (n: number) => (n < 10_000 ? whole.format(n) : compact.format(n));
/** The start (or with `plus`, a later) hour of a render stats bucket, in local time. */
const formatHour = (iso: string, plus = 0) =>
  new Date(new Date(iso).getTime() + plus * 3600_000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Stat.Root borderWidth="1px" rounded="md" p="4" bg="bg.panel">
      <Stat.Label>{label}</Stat.Label>
      <Stat.ValueText fontWeight="semibold">{value}</Stat.ValueText>
      {detail && <Stat.HelpText color="fg.muted">{detail}</Stat.HelpText>}
    </Stat.Root>
  );
}

function OverviewGroup({
  title,
  link,
  children,
}: {
  title: string;
  link?: { to: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <Stack gap="3">
      <HStack justify="space-between">
        <Heading size="md">{title}</Heading>
        {link && (
          <Button asChild size="xs" variant="ghost">
            <Link to={link.to}>{link.label}</Link>
          </Button>
        )}
      </HStack>
      {children}
    </Stack>
  );
}

/** A row of tiles, optionally under a small label ("Last 24 hours"). */
function Tiles({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <Stack gap="2">
      {label && (
        <Text textStyle="xs" color="fg.muted" fontFamily="label" textTransform="uppercase" letterSpacing="wider">
          {label}
        </Text>
      )}
      <SimpleGrid minChildWidth="56" gap="3">
        {children}
      </SimpleGrid>
    </Stack>
  );
}

/** The instance at a glance. "Recent" is the last 30 days. */
export function AdminOverview() {
  const { data: stats, error } = useAdminStats();
  if (error) return <Text color="fg.error">{error.message}</Text>;
  if (!stats) return null;
  const { users, photos, storage, renders, invitations, instance } = stats;
  return (
    <Stack gap="10">
      <OverviewGroup title="Users" link={{ to: '/admin/users', label: 'Manage users' }}>
        <Tiles>
          <StatTile
            label="Accounts"
            value={formatCount(users.total)}
            detail={`${plural(users.admins, 'admin')} · ${formatCount(users.recent)} joined in the last 30 days`}
          />
          <StatTile
            label="From invitations"
            value={formatCount(users.invited)}
            detail={`${plural(invitations.active, 'active invitation')}`}
          />
        </Tiles>
      </OverviewGroup>
      <OverviewGroup title="Photos and storage">
        <Tiles>
          <StatTile
            label="Photos"
            value={formatCount(photos.total)}
            detail={
              `${formatCount(photos.recent)} imported in the last 30 days · ${plural(photos.versions, 'version')}` +
              (photos.trashed ? ` · ${formatCount(photos.trashed)} in the trash` : '')
            }
          />
          <StatTile
            label="Originals stored"
            value={formatBytes(storage.used)}
            detail={
              storage.trash
                ? `RAW files, across all users · ${formatBytes(storage.trash)} in the trash`
                : 'RAW files, across all users'
            }
          />
          <StatTile
            label="Quotas granted"
            value={formatBytes(storage.allocated)}
            detail={`Plus ${plural(storage.unlimitedUsers, 'account')} with unlimited storage`}
          />
        </Tiles>
      </OverviewGroup>
      <OverviewGroup title="Renders">
        <Tiles label="Now">
          <StatTile
            label="Waiting"
            value={formatCount(renders.pending)}
            detail={renders.oldestWaitMs ? `The oldest for ${formatDuration(renders.oldestWaitMs)}` : 'Nothing waiting'}
          />
          <StatTile label="Failed" value={formatCount(renders.failed)} detail="Previews the server couldn’t develop" />
        </Tiles>
        <Tiles label="Last 24 hours">
          <StatTile
            label="Peak queue"
            value={formatCount(renders.day.peakPending)}
            detail={[
              renders.day.peakAt &&
                `Between ${formatHour(renders.day.peakAt)} and ${formatHour(renders.day.peakAt, 1)}`,
              `${formatCount(renders.week.peakPending)} over 7 days`,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
          <StatTile
            label="Longest wait"
            value={formatDuration(renders.day.maxWaitMs)}
            detail={`From queued to started · ${formatDuration(renders.week.maxWaitMs)} over 7 days`}
          />
          <StatTile
            label="Rendered"
            value={formatCount(renders.day.renders)}
            detail={[
              renders.day.averageMs !== null && `${formatDuration(renders.day.averageMs)} each on average`,
              `${formatCount(renders.day.failures)} failed`,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        </Tiles>
      </OverviewGroup>
      <OverviewGroup title="Instance">
        <Tiles>
          <StatTile label="Storage" value={instance.storage} />
          <StatTile
            label="Sign-up"
            value={instance.signup === 'open' ? 'Open to anyone' : 'By invitation'}
            detail={
              instance.signup === 'open'
                ? `New accounts get ${formatQuota(instance.defaultStorageQuota).toLowerCase()}`
                : 'Create invitations in the Invitations tab'
            }
          />
        </Tiles>
      </OverviewGroup>
    </Stack>
  );
}

// ── Users ───────────────────────────────────────────────────────────────────

export function AdminUsers() {
  const { data: me } = useMe();
  return me ? <UsersSection myId={me.id} /> : null;
}

function UsersSection({ myId }: { myId: string }) {
  const { data: users, error } = useAdminUsers();
  const update = useUpdateAdminUser();
  const [editing, setEditing] = useState<AdminUser | null>(null);

  return (
    <Stack gap="3">
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

export function AdminInvitations() {
  const { data: invitations, error } = useInvitations();
  const create = useCreateInvitation();
  const revoke = useRevokeInvitation();
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const setRevoked = (inv: Invitation, revoked: boolean) =>
    revoke.mutate(
      { id: inv.id, revoke: revoked },
      {
        onSuccess: () =>
          toaster.create({
            type: 'success',
            title: revoked ? `Revoked “${inv.label ?? 'Untitled'}”` : `Reactivated “${inv.label ?? 'Untitled'}”`,
          }),
        onError: (err) => toaster.create({ type: 'error', title: err.message }),
      },
    );
  const [creating, setCreating] = useState(false);

  return (
    <Stack gap="3">
      <HStack justify="space-between">
        <Text textStyle="sm" color="fg.muted">
          Each invitation is a link that creates accounts with the storage you choose.
        </Text>
        <Button size="sm" colorPalette="orange" onClick={() => setCreating(true)}>
          <Plus /> New invitation
        </Button>
      </HStack>
      {error && <Text color="fg.error">{error.message}</Text>}
      {invitations?.length === 0 && (
        <Text color="fg.muted" textStyle="sm">
          No invitations yet.
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
                <InvitationRow
                  key={inv.id}
                  invitation={inv}
                  onRevoke={() => setRevoking(inv)}
                  onReactivate={() => setRevoked(inv, false)}
                />
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      )}
      <RevokeDialog
        invitation={revoking}
        onClose={() => setRevoking(null)}
        onConfirm={(inv) => {
          setRevoked(inv, true);
          setRevoking(null);
        }}
      />
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

function InvitationRow({
  invitation: inv,
  onRevoke,
  onReactivate,
}: {
  invitation: Invitation;
  onRevoke: () => void;
  onReactivate: () => void;
}) {
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
        {inv.status === 'revoked' && (
          <Button size="xs" variant="outline" onClick={onReactivate}>
            Reactivate
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

/** Revoking stops the link; it can be reactivated, but whoever has it is turned away meanwhile. */
function RevokeDialog({
  invitation,
  onConfirm,
  onClose,
}: {
  invitation: Invitation | null;
  onConfirm: (invitation: Invitation) => void;
  onClose: () => void;
}) {
  const left = invitation ? invitation.maxUses - invitation.uses : 0;
  return (
    <Dialog.Root open={!!invitation} onOpenChange={(e) => !e.open && onClose()} role="alertdialog" size="sm">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Revoke “{invitation?.label ?? 'Untitled'}”?</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="3">
                <Text>
                  Its link stops working: the {left === 1 ? 'account' : `${left} accounts`} it could still create won’t
                  be. Accounts already created with it are not affected.
                </Text>
                <Text color="fg.muted" textStyle="sm">
                  You can reactivate it later from this list; the link stays the same.
                </Text>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline">Cancel</Button>
              </Dialog.ActionTrigger>
              <Button colorPalette="red" onClick={() => invitation && onConfirm(invitation)} autoFocus>
                Revoke
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
