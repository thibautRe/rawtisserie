import { Box, HStack, Text } from '@chakra-ui/react';
import { useMemo, useState } from 'react';
import { useAllTags } from '../api/hooks.ts';
import { fold, fuzzyFilter } from '../lib/fuzzy.ts';
import { displayTag, normalizeTag } from '../lib/tags.ts';

/** The info panel's tag input (one photo or several): T focuses it. */
export const TAG_INPUT_ID = 'library-tag-input';
const LIST_ID = `${TAG_INPUT_ID}-suggestions`;
const optionId = (i: number) => `${LIST_ID}-${i}`;

/** Focus the info panel's tag input, if it's shown. */
export function focusTagInput(): boolean {
  const input = document.getElementById(TAG_INPUT_ID);
  input?.focus();
  return !!input;
}

/**
 * Suggests the library's tags matching what's typed (fuzzy: typos and accents are
 * forgiven), most used first. Tags are paths (`People|Alice`, typed with `|`). Arrows move through them, Enter picks one; the last
 * option creates the tag as typed. Spread `inputProps` on the input (they make it an
 * ARIA combobox, which also tells Chakra's TagsInput to leave Enter to us) and render
 * `list` just below it, in a `position: relative` box.
 */
export function useTagCompletion({
  input,
  exclude,
  onPick,
}: {
  input: string;
  /** Tags already there: not suggested. */
  exclude: readonly string[];
  onPick: (tag: string) => void;
}) {
  const { data: tags } = useAllTags();
  const [highlight, setHighlight] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Levels separated by `|`, matched as shown (`People › Alice`) too.
  const typed = normalizeTag(input);

  const matches = useMemo(() => {
    if (!typed || !tags) return [];
    const taken = new Set(exclude.map(fold));
    return fuzzyFilter(
      typed,
      tags.filter((t) => !taken.has(fold(t.value))),
      { key: (t) => t.value, weight: (t) => t.count },
    );
  }, [typed, tags, exclude]);
  const create =
    typed && !matches.some((m) => fold(m.value) === fold(typed)) && !exclude.some((t) => fold(t) === fold(typed));
  const options = [...matches.map((m) => m.value), ...(create ? [typed] : [])];
  const open = focused && !dismissed && matches.length > 0;
  const active = Math.min(highlight, options.length - 1);

  const pick = (tag: string) => {
    onPick(tag);
    setHighlight(0);
  };

  const inputProps = {
    id: TAG_INPUT_ID,
    role: 'combobox',
    autoComplete: 'off',
    'aria-autocomplete': 'list',
    'aria-controls': LIST_ID,
    'aria-expanded': open,
    'aria-activedescendant': open ? optionId(active) : undefined,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onInput: () => {
      setDismissed(false);
      setHighlight(0);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!open) return;
      const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (step) setHighlight((active + step + options.length) % options.length);
      else if (e.key === 'Enter') pick(options[active]!);
      else if (e.key === 'Escape') setDismissed(true);
      else return;
      e.preventDefault();
    },
  } as const;

  const list = open && (
    <Box
      id={LIST_ID}
      role="listbox"
      position="absolute"
      top="100%"
      insetX="0"
      mt="1"
      zIndex="dropdown"
      bg="bg.panel"
      borderWidth="1px"
      rounded="l2"
      shadow="md"
      py="1"
    >
      {options.map((tag, i) => {
        const count = matches[i]?.count;
        return (
          <HStack
            key={`${i}-${tag}`}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            px="2"
            py="1"
            gap="2"
            cursor="pointer"
            textStyle="xs"
            bg={i === active ? 'bg.emphasized' : undefined}
            onMouseEnter={() => setHighlight(i)}
            // Keep the focus in the input.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(tag)}
          >
            {count == null ? (
              <Text flex="1" truncate>
                Add “{displayTag(tag)}”
              </Text>
            ) : (
              <>
                <Text flex="1" truncate>
                  {displayTag(tag)}
                </Text>
                <Text color="fg.muted">{count}</Text>
              </>
            )}
          </HStack>
        );
      })}
    </Box>
  );

  return { inputProps, list };
}
