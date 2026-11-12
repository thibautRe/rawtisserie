import { Box, Button, CloseButton, HStack, Progress, Stack, Text } from '@chakra-ui/react';
import { useEffect } from 'react';
import { RotateCcw } from 'lucide-react';
import { cancelExport, dismissExport, retryFailed, useExportRun } from './bulkExport.ts';

/**
 * The library export's progress (roadmap 8.4), on every page: n of N, the photo being
 * exported and a cancel button, then the photos that failed, if any. Leaving the app
 * while it runs asks first.
 */
export function ExportProgress() {
  const run = useExportRun();
  const running = run?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);
  if (!run) return null;

  return (
    <Box
      position="fixed"
      bottom="4"
      left="4"
      zIndex="toast"
      w="xs"
      p="3"
      bg="bg.panel"
      borderWidth="1px"
      borderRadius="l2"
      boxShadow="lg"
      role="status"
      aria-label="Export"
    >
      {running ? (
        <Stack gap="2">
          <HStack justify="space-between" gap="2">
            <Text textStyle="sm" fontWeight="medium" fontVariantNumeric="tabular-nums">
              Exporting: {run.done} of {run.total} done
            </Text>
            <Button size="2xs" variant="ghost" onClick={cancelExport}>
              Cancel
            </Button>
          </HStack>
          <Progress.Root value={(run.done / run.total) * 100} size="xs" colorPalette="orange">
            <Progress.Track>
              <Progress.Range />
            </Progress.Track>
          </Progress.Root>
          <Text textStyle="xs" color="fg.muted" truncate title={run.current.join('\n')}>
            {run.current.join(', ')}
            {run.parts ? ` · ${run.parts} ZIP ${run.parts === 1 ? 'file' : 'files'} saved` : ''}
            {run.failed.length ? ` · ${run.failed.length} failed` : ''}
          </Text>
        </Stack>
      ) : (
        <Stack gap="2">
          <HStack justify="space-between" align="start" gap="2">
            <Text textStyle="sm" fontWeight="medium">
              {run.exported
                ? `Exported ${run.exported} of ${run.total} photos${run.parts > 1 ? ` in ${run.parts} ZIP files` : ''}`
                : `Could not export ${run.total === 1 ? 'the photo' : 'the photos'}`}
            </Text>
            <HStack gap="1">
              {/* The failed ones again, same settings and names, in an archive of their own. */}
              <Button size="2xs" variant="outline" onClick={retryFailed}>
                <RotateCcw /> Retry {run.failed.length}
              </Button>
              <CloseButton size="2xs" onClick={dismissExport} aria-label="Dismiss" />
            </HStack>
          </HStack>
          <Stack gap="1" maxH="40" overflowY="auto">
            {run.failed.map((f, i) => (
              <Text key={i} textStyle="xs" color="fg.muted">
                <Text as="span" color="fg">
                  {f.photo.filename}
                </Text>
                : {f.error}
              </Text>
            ))}
          </Stack>
        </Stack>
      )}
    </Box>
  );
}
