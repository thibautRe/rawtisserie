import { Progress, Stack, Text } from '@chakra-ui/react';
import type { StorageUsage } from '../api/types.ts';
import { formatBytes } from '../lib/format.ts';

/** Share of the quota from which the meter warns. */
const NEARLY_FULL = 0.9;

/**
 * Original files stored against the quota: "12.3 GB of 50.0 GB" over a bar, or "12.3 GB
 * · unlimited". Orange, red from 90 % (uploads are refused once it's full).
 */
export function StorageMeter({ usage, label }: { usage: StorageUsage; label?: string }) {
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
