import { useState } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { LARGE_SELECTION } from './selectionText.ts';

interface Question {
  title: string;
  body?: string;
  confirm: string;
  /** Red: it can't be undone, or loses something. */
  danger?: boolean;
}

/**
 * Actions on a large selection ask first, with the number (roadmap 8.13): `ask` runs
 * `run` at once for up to `LARGE_SELECTION` photos, else after the dialog it returns
 * (to render) is confirmed.
 */
export function useConfirmLarge() {
  const [asking, setAsking] = useState<(Question & { run: () => void }) | null>(null);
  const ask = (count: number, question: Question, run: () => void) => {
    if (count > LARGE_SELECTION) setAsking({ ...question, run });
    else run();
  };
  const dialog = (
    <ConfirmDialog
      text={asking && { title: asking.title, body: asking.body }}
      confirm={asking?.confirm ?? ''}
      danger={asking?.danger ?? false}
      onConfirm={() => {
        asking?.run();
        setAsking(null);
      }}
      onClose={() => setAsking(null)}
    />
  );
  return [ask, dialog] as const;
}
