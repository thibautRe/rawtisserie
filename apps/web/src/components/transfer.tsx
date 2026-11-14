import { Box, Button, CloseButton, HStack, Link, Progress, Spinner, Stack, Text } from '@chakra-ui/react';
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleX,
  ExternalLink,
  Equal,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { sendToInstance, useCancelTransfer, useRetryTransfer, useTransfer } from '../api/hooks.ts';
import type { RemoteInstance, Transfer } from '../api/types.ts';
import { toaster } from './toaster.tsx';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const hostOf = (url: string) => new URL(url).host;

/**
 * Send versions (or everything) to another instance: the server does it, this toast
 * follows it until closed.
 */
export async function startTransfer(instance: RemoteInstance, what: { ids: string[] } | { everything: true }) {
  try {
    const transfer = await sendToInstance(instance.id, what);
    toaster.create({
      id: `transfer-${transfer.id}`,
      type: 'info',
      duration: Infinity,
      closable: false,
      meta: { render: () => <LiveTransfer id={transfer.id} /> },
    });
    return transfer;
  } catch (err) {
    toaster.create({
      type: 'error',
      title: `Could not send to ${hostOf(instance.url)}`,
      description: err instanceof Error ? err.message : undefined,
    });
    return null;
  }
}

function LiveTransfer({ id }: { id: string }) {
  const { data } = useTransfer(id);
  const retry = useRetryTransfer();
  const cancel = useCancelTransfer();
  if (!data) return null;
  return (
    <TransferSummary
      transfer={data}
      onRetry={() => retry.mutate(id)}
      onCancel={() => cancel.mutate(id)}
      onClose={() => toaster.dismiss(`transfer-${id}`)}
    />
  );
}

/**
 * A transfer's progress, then its outcome: new there, updated, already up to date,
 * failed (to retry), with a link to see what arrived there (as one import).
 */
export function TransferSummary({
  transfer: t,
  onRetry,
  onCancel,
  onClose,
}: {
  transfer: Transfer;
  onRetry: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const busy = t.status === 'running';
  const host = hostOf(t.url);
  const finished = t.total - t.waiting;
  const problems = t.failed > 0 || t.status === 'failed';
  const title = busy
    ? `Sending ${plural(t.total, 'photo')} to ${host}`
    : t.status === 'failed'
      ? `Couldn’t send to ${host}`
      : t.status === 'cancelled'
        ? `Stopped sending to ${host}`
        : `Sent to ${host}`;
  const sentSomething = t.created + t.updated > 0;

  return (
    <HStack align="start" gap="3" w="full" data-transfer-state={busy ? 'busy' : 'done'}>
      <Box pt="0.5" color={busy ? 'fg.subtle' : problems ? 'orange.fg' : 'green.fg'}>
        {busy ? (
          <Spinner size="sm" color="fg.subtle" />
        ) : problems ? (
          <CircleAlert size={18} />
        ) : (
          <CircleCheck size={18} />
        )}
      </Box>
      <Stack gap="2" flex="1" minW="0">
        <HStack gap="2" justify="space-between">
          <Text fontWeight="semibold" textStyle="sm">
            {title}
          </Text>
          {busy && <Action onClick={onCancel}>Stop</Action>}
        </HStack>
        {busy && (
          <Stack gap="1">
            <Progress.Root
              size="xs"
              colorPalette="orange"
              value={t.total ? (100 * finished) / t.total : 0}
              aria-label="Transfer progress"
            >
              <Progress.Track>
                <Progress.Range />
              </Progress.Track>
            </Progress.Root>
            <Text textStyle="xs" color="fg.muted" fontFamily="numeric" fontVariantNumeric="tabular-nums">
              {finished} of {t.total}
            </Text>
          </Stack>
        )}
        <Stack gap="1" textStyle="sm">
          {t.error && (
            <Line icon={<CircleX size={14} />} color="red.fg">
              {t.error}
            </Line>
          )}
          {t.created > 0 && <Line icon={<Plus size={14} />}>{plural(t.created, 'new photo')} there</Line>}
          {t.updated > 0 && <Line icon={<RefreshCw size={14} />}>{plural(t.updated, 'photo')} updated</Line>}
          {t.unchanged > 0 && <Line icon={<Equal size={14} />}>{plural(t.unchanged, 'photo')} already up to date</Line>}
          {t.extrasSent > 0 && (
            <Line icon={<Plus size={14} />}>
              {plural(t.extrasSent, 'preset, style or LUT', 'presets, styles and LUTs')}
            </Line>
          )}
          {t.failed > 0 && (
            <Line icon={<CircleX size={14} />} color="red.fg">
              {plural(t.failed, 'photo')} failed
            </Line>
          )}
        </Stack>
        {!busy && (
          <HStack gap="2">
            {sentSomething && (
              <Button size="2xs" variant="outline" asChild>
                <Link href={`${t.url}/?import=${t.id}`} target="_blank" rel="noreferrer">
                  Open there <ExternalLink />
                </Link>
              </Button>
            )}
            {problems && <Action onClick={onRetry}>Retry</Action>}
          </HStack>
        )}
        {!busy && t.failures.length > 0 && <Failures items={t.failures} />}
      </Stack>
      {!busy && <CloseButton size="2xs" onClick={onClose} aria-label="Close" mt="-1" me="-1" />}
    </HStack>
  );
}

function Line({ icon, color = 'fg.muted', children }: { icon: ReactNode; color?: string; children: ReactNode }) {
  return (
    <HStack gap="2" minH="6" align="start">
      <Box color={color} flexShrink={0} pt="1">
        {icon}
      </Box>
      <Text flex="1">{children}</Text>
    </HStack>
  );
}

function Action({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button size="2xs" variant="outline" onClick={onClick} flexShrink={0}>
      {children}
    </Button>
  );
}

/** Shown at once, not animated: the toaster measures a toast when its content changes. */
function Failures({ items }: { items: Transfer['failures'] }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap="1">
      <Button size="2xs" variant="ghost" color="fg.muted" alignSelf="start" px="1" onClick={() => setOpen((o) => !o)}>
        Details {open ? <ChevronUp /> : <ChevronDown />}
      </Button>
      {open && (
        <Stack gap="1" maxH="40" overflowY="auto" textStyle="xs">
          {items.map((i) => (
            <Box key={i.versionId} minW="0">
              <Text truncate title={i.filename} fontWeight="medium">
                {i.filename}
              </Text>
              <Text color="fg.muted">{i.error}</Text>
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
