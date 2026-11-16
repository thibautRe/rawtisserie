import { Link } from '@chakra-ui/react';
import { useNavigate } from 'react-router';
import { useMoveToTrash, useRestoreFromTrash } from '../api/hooks.ts';
import type { Target } from '../api/types.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { toaster } from './toaster.tsx';
import { type Version, describeVersions } from './trashText.ts';

export const TRASH_PATH = '/settings/trash';

/**
 * Moving to the trash, with an Undo in its toast. Resolves once they're in the trash;
 * rejects (with nothing moved) if that failed.
 */
export function useTrashWithUndo() {
  const trash = useMoveToTrash();
  const restore = useRestoreFromTrash();
  // The toaster is outside the router: its link navigates with this.
  const navigate = useNavigate();
  /** `versions`, or with `target` what a filter matches (`versions` those of them shown). */
  return async (versions: Version[], target?: Target) => {
    const { trashed } = await trash.mutateAsync(target ?? { ids: versions.map((v) => v.id) });
    const what = target ? (trashed.length === 1 ? '1 photo' : `${trashed.length} photos`) : describeVersions(versions);
    toaster.create({
      type: 'info',
      title: `Moved ${what} to the trash`,
      description: (
        <Link
          href={TRASH_PATH}
          onClick={(e) => {
            e.preventDefault();
            navigate(TRASH_PATH);
          }}
        >
          Open the trash
        </Link>
      ),
      action: {
        label: 'Undo',
        onClick: () =>
          restore.mutate(trashed, {
            onSuccess: () => toaster.create({ type: 'success', title: `Restored ${what}` }),
            onError: (err) => toaster.create({ type: 'error', title: 'Could not restore', description: err.message }),
          }),
      },
    });
  };
}

export function DeleteForeverDialog({
  text,
  confirm = 'Delete permanently',
  onConfirm,
  onClose,
}: {
  /** What it deletes; the dialog is open while this is non-null. */
  text: { title: string; body: string } | null;
  confirm?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return <ConfirmDialog text={text} confirm={confirm} onConfirm={onConfirm} onClose={onClose} />;
}
