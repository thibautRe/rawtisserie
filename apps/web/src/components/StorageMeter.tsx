import { Box, Flex, Grid, Progress, Stack, Text } from '@chakra-ui/react';
import type { StorageUsage } from '../api/types.ts';
import { formatBytes } from '../lib/format.ts';

/** Share of the quota from which the meter warns. */
const NEARLY_FULL = 0.9;

/**
 * Original files stored against the quota: "12.3 GB of 50.0 GB" over a bar, or "12.3 GB
 * · unlimited". Orange, red from 90 % (uploads are refused once it's full).
 */
export function StorageMeter({ usage, label }: { usage: Pick<StorageUsage, 'used' | 'quota'>; label?: string }) {
  const { used, quota } = usage;
  const ratio = quota === null ? 0 : quota === 0 ? 1 : used / quota;
  return (
    <Stack gap="1" minW="40">
      <Text textStyle="xs" color="fg.muted" fontFamily="numeric">
        {label && `${label} `}
        {quota === null ? `${formatBytes(used)} · unlimited` : `${formatBytes(used)} of ${formatBytes(quota)}`}
      </Text>
      {quota !== null && (
        <Progress.Root
          value={Math.min(100, ratio * 100)}
          size="xs"
          colorPalette={ratio >= NEARLY_FULL ? 'red' : 'orange'}
          aria-label="Storage used"
        >
          <Progress.Track>
            <Progress.Range />
          </Progress.Track>
        </Progress.Root>
      )}
    </Stack>
  );
}

const PARTS = [
  { key: 'library', label: 'Library', color: 'orange.solid' },
  { key: 'trash', label: 'Trash', color: 'fg.subtle' },
] as const;

/**
 * Where the storage goes: originals in the library, and in the trash (they count until
 * they're deleted for good), against the quota. Without a quota, the bar splits what's
 * stored.
 */
export function StorageBreakdown({ usage }: { usage: StorageUsage }) {
  const { used, trash, quota } = usage;
  const sizes = { library: used - trash, trash };
  const scale = quota ?? used;
  const full = quota !== null && used >= quota * NEARLY_FULL;
  return (
    <Stack gap="2">
      <Text textStyle="sm" fontWeight="semibold" fontFamily="numeric">
        {quota === null
          ? `${formatBytes(used)} used · unlimited`
          : `${formatBytes(used)} of ${formatBytes(quota)} used`}
      </Text>
      <Flex
        h="2"
        gap="2px"
        bg="bg.muted"
        borderRadius="full"
        overflow="hidden"
        role="img"
        aria-label={`Library ${formatBytes(sizes.library)}, trash ${formatBytes(trash)}`}
      >
        {PARTS.map(
          (p) =>
            sizes[p.key] > 0 && (
              <Box
                key={p.key}
                bg={p.key === 'library' && full ? 'red.solid' : p.color}
                w={`${scale ? (100 * sizes[p.key]) / scale : 0}%`}
                minW="2px"
              />
            ),
        )}
      </Flex>
      <Grid templateColumns="auto 1fr auto" columnGap="2" rowGap="1" alignItems="center" textStyle="sm">
        {PARTS.map((p) => (
          <StorageRow
            key={p.key}
            color={p.key === 'library' && full ? 'red.solid' : p.color}
            label={p.label}
            value={formatBytes(sizes[p.key])}
          />
        ))}
        {quota !== null && <StorageRow label="Free" value={formatBytes(Math.max(0, quota - used))} />}
      </Grid>
    </Stack>
  );
}

function StorageRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <>
      <Box w="2.5" h="2.5" borderRadius="xs" bg={color ?? 'bg.muted'} borderWidth={color ? 0 : '1px'} />
      <Text color="fg.muted">{label}</Text>
      <Text textAlign="right" fontFamily="numeric" fontVariantNumeric="tabular-nums">
        {value}
      </Text>
    </>
  );
}
