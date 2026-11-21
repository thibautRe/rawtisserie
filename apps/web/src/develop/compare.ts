import { type EditParams, MODULE_KINDS, type ModuleKind } from '@rawtisserie/pipeline';

/** How the compared image shows beside the edited one (roadmap M5). */
export type CompareLayout = 'split' | 'sideBySide';

/** What the edited image is compared with: an entry of its history (0: the original), or another version. */
export type CompareTarget = { kind: 'history'; seq: number } | { kind: 'version'; id: string };

/** Another version of the photo, offered to compare with. */
export interface CompareVersion {
  id: string;
  label: string;
  thumbUrl: string | null;
  /** Its current recipe. */
  recipe: () => Promise<EditParams>;
}

/**
 * The kinds the compared recipe takes from the edited one: lens correction and geometry
 * (crop, rotation, straightening, perspective). Both images then frame the photo the
 * same way, so that what differs is the look.
 */
export const FRAMING_KINDS: readonly ModuleKind[] = ['lens', 'geometry'];

const framing = (kind: ModuleKind) => FRAMING_KINDS.includes(kind);

/** `other` with the lens correction and geometry of `current` (see `FRAMING_KINDS`). */
export function compareRecipe(other: EditParams, current: EditParams): EditParams {
  const order = (kind: ModuleKind) => MODULE_KINDS.indexOf(kind);
  // Stable: instances of the same kind keep their order.
  const modules = [
    ...other.modules.filter((m) => !framing(m.kind)),
    ...current.modules.filter((m) => framing(m.kind)),
  ].sort((a, b) => order(a.kind) - order(b.kind));
  return { ...other, modules };
}

/**
 * What changes the compared recipe when the edited one changes: its framing instances,
 * as a string (the same while they are), so that editing the look doesn't render the
 * compared image again.
 */
export function framingKey(current: EditParams): string {
  return JSON.stringify(current.modules.filter((m) => framing(m.kind)));
}

/** The short name of a target, for the label over the compared image. */
export function targetLabel(
  target: CompareTarget,
  entries: readonly { label: string }[],
  versions: readonly CompareVersion[],
): string {
  if (target.kind === 'version') return versions.find((v) => v.id === target.id)?.label ?? 'Another version';
  if (target.seq === 0) return 'Original';
  const entry = entries[target.seq - 1];
  return entry ? `${target.seq}. ${entry.label}` : 'Original';
}
