/**
 * The warning over an imported edit (`importedEdits.ts` in the pipeline package): while
 * the current history entry is the import, the image is the other application's edit as
 * close as our modules get, never the same. Says so, and lists how each of its modules
 * came through (the report, worked out again from the edits kept with the version).
 */
import { Alert, Box, Button, HStack, Stack, Text } from '@chakra-ui/react';
import {
  IMPORT_APP_NAMES,
  type ImportReport,
  type ImportReportItem,
  type ImportStatus,
  type PhotoMetadata,
  importEdits,
  isImportLabel,
  originalEditParams,
} from '@rawtisserie/pipeline';
import { memo, useEffect, useState } from 'react';
import { useUserLutNames } from './luts.ts';
import { ZEN_HIDE } from './zen.tsx';

const STATUS_TEXT: Record<ImportStatus, string> = {
  mapped: 'Came through',
  approximated: 'Approximated',
  needsFile: 'Waiting for a file: add it to your LUTs (the LUT module’s menu), photos waiting for it pick it up',
  skipped: 'Left out',
  builtIn: 'Done by RAWtisserie its own way',
};
const ORDER: readonly ImportStatus[] = ['needsFile', 'skipped', 'approximated', 'mapped', 'builtIn'];

const name = (i: ImportReportItem) => (i.instance ? `${i.module} (${i.instance})` : i.module);

/** The report of `edits` for this photo, once worked out (null: none, or not readable). */
function useReport(edits: string | null, metadata: PhotoMetadata): ImportReport | null {
  const [report, setReport] = useState<ImportReport | null>(null);
  // Which LUTs it's waiting for: the user's, as they are now.
  const luts = useUserLutNames();
  useEffect(() => {
    let cancelled = false;
    setReport(null);
    if (!edits || !luts) return;
    // The report doesn't depend on the starting recipe: any will do.
    importEdits(edits, { base: originalEditParams, metadata, luts })
      .then((r) => !cancelled && setReport(r?.report ?? null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [edits, metadata, luts]);
  return report;
}

export const ImportNotice = memo(function ImportNotice({
  edits,
  metadata,
  label,
}: {
  /** The edits the version was imported with (`PhotoDetail.importedEdits`). */
  edits: string | null;
  metadata: PhotoMetadata;
  /** The current history entry's label: shown only while it's the import's. */
  label: string | undefined;
}) {
  const report = useReport(edits, metadata);
  if (!report || !label || !isImportLabel(label)) return null;
  return <ImportReportNotice report={report} />;
});

/** The warning itself, for a report (`/ui` shows it with a sample). */
export function ImportReportNotice({ report }: { report: ImportReport }) {
  const [open, setOpen] = useState(false);
  const count = (s: ImportStatus) => report.items.filter((i) => i.status === s).length;
  const summary = [
    `${count('mapped')} modules came through`,
    count('approximated') && `${count('approximated')} approximated`,
    count('needsFile') && `${count('needsFile')} waiting for a LUT file`,
    count('skipped') && `${count('skipped')} left out`,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <Alert.Root status="warning" size="sm" borderRadius="0" flexShrink={0} data-import-notice {...ZEN_HIDE}>
      <Alert.Indicator />
      <Alert.Content>
        <HStack gap="2" justify="space-between" align="flex-start">
          <Box>
            <Alert.Title>Imported from {IMPORT_APP_NAMES[report.app]}: an approximation</Alert.Title>
            <Alert.Description>
              Its modules aren’t ours, so this isn’t quite the image it made. {summary}.
            </Alert.Description>
          </Box>
          <Button size="2xs" variant="ghost" onClick={() => setOpen((o) => !o)} flexShrink={0}>
            {open ? 'Hide' : 'Details'}
          </Button>
        </HStack>
        {open && (
          <Stack gap="2" pt="2" textStyle="xs" maxH="40vh" overflowY="auto">
            {ORDER.map((status) => {
              const items = report.items.filter((i) => i.status === status);
              if (!items.length) return null;
              return (
                <Box key={status}>
                  <Text fontWeight="semibold">{STATUS_TEXT[status]}</Text>
                  {status === 'builtIn' ? (
                    <Text color="fg.muted">{items.map(name).join(', ')}</Text>
                  ) : (
                    items.map((i, n) => (
                      <Text key={n} color="fg.muted">
                        {name(i)}
                        {i.note && ` — ${i.note}`}
                        {i.file && ` (there: ${i.file.path})`}
                      </Text>
                    ))
                  )}
                </Box>
              );
            })}
          </Stack>
        )}
      </Alert.Content>
    </Alert.Root>
  );
}
