import { Box, Text } from '@chakra-ui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useOwnTags } from '../api/hooks.ts';
import { TAG_INPUT_ID } from './TagCompletion.tsx';
import {
  type KeyPress,
  SEQUENCE_TIMEOUT,
  type Shortcut,
  ShortcutMatcher,
  formatShortcut,
  isTyping,
  pressOf,
} from '../lib/keys.ts';

/**
 * The tags' shortcuts (set from a tag's menu in the filters): `onToggle` gets the tag whose shortcut
 * was pressed; null turns them off (another view has them). A sequence that's going on
 * shows at the bottom of the screen; until it ends, its keys do nothing else.
 *
 * Call it before the view's own key handlers are set up: it listens first (capture),
 * so that a key continuing a sequence (`P` in `Ctrl+Alt+O, P`) isn't also theirs.
 */
export function useTagShortcuts(onToggle: ((tag: string) => void) | null) {
  const { data: own } = useOwnTags();
  const matcher = useMemo(
    () => new ShortcutMatcher((own ?? []).flatMap((o) => (o.shortcut ? [{ shortcut: o.shortcut, value: o.tag }] : []))),
    [own],
  );
  const [pending, setPending] = useState<Shortcut | null>(null);
  const latest = useRef({ onToggle, matcher });
  latest.current = { onToggle, matcher };

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const { onToggle, matcher } = latest.current;
      if (!onToggle || e.repeat) return;
      // Dialogs and menus have their keys.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"]')) return;
      const press = pressOf(e);
      if (!press) return;
      // Text fields keep their keys, but the info panel's tag input takes shortcuts that
      // can't be typed (with Ctrl, Alt or ⌘), and a sequence's next keys.
      if (isTyping(e.target) && !(inTagInput(e.target) && (notTyped(press) || matcher.pending))) return;
      const result = matcher.feed(press);
      if (result.type === 'none') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      clearTimeout(timer);
      if (result.type === 'pending') {
        setPending(result.sofar);
        timer = setTimeout(() => {
          latest.current.matcher.reset();
          setPending(null);
        }, SEQUENCE_TIMEOUT);
      } else setPending(null);
      if (result.type === 'match') onToggle(result.value);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(timer);
    };
  }, []);

  return pending && <PendingSequence sofar={pending} />;
}

/** The info panel's tag inputs (one photo's, or the selection's). */
const inTagInput = (target: EventTarget | null) => target instanceof HTMLElement && target.id === TAG_INPUT_ID;

/** A press that types no text (with Ctrl, Alt or ⌘). */
const notTyped = (p: KeyPress) => p.ctrl || p.alt || p.meta;

/** A sequence going on: its keys so far, waiting for the next. */
function PendingSequence({ sofar }: { sofar: Shortcut }) {
  return (
    <Box
      position="fixed"
      bottom="6"
      left="50%"
      transform="translateX(-50%)"
      zIndex="toast"
      px="3"
      py="1.5"
      rounded="l2"
      bg="bg.inverted"
      color="fg.inverted"
      shadow="lg"
      data-shortcut-pending
    >
      <Text textStyle="sm" fontFamily="numeric">
        {formatShortcut(sofar)}, …
      </Text>
    </Box>
  );
}
