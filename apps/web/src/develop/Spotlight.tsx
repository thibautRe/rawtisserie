/**
 * The spotlight (roadmap 2.6, a prototype): Ctrl+Space, then a few letters naming a
 * module, a tab or a control ("filcon": Filmic › Contrast, "cbm": Color balance › Mixer,
 * "temp": a Temperature slider). It sits at the top of the right panel, which shows only
 * the module named meanwhile (`ModulePanel`'s `only`), on the tabs named. Enter closes
 * it and focuses what was named (a slider: the arrow keys move it), with the module where
 * it was on screen (`onClose`'s `top`: the developer keeps it there). Esc closes it.
 *
 * Controls are found in the page: those of every module as the panel shows them when it
 * opens, then those of each module it shows (`seen`, kept for the tab's session).
 */
import { HStack, Input, Kbd, Stack, Text } from '@chakra-ui/react';
import { type EditParams, MODULE_KINDS, type ModuleKind, hasKind } from '@rawtisserie/pipeline';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { MODULE_TITLES, instanceTitle } from './changes.ts';
import { type PanelFocus, SPOTLIGHT_VIEWS } from './ModulePanel.tsx';
import {
  type ShownControls,
  type SpotlightControl,
  type SpotlightEntry,
  type SpotlightModule,
  type SpotlightView,
  buildEntries,
  entryKey,
  rankEntries,
} from './spotlight.ts';

/** Matches listed below the query. */
const SHOWN = 7;

/** What Enter focuses, found again once the whole panel is back. */
export type SpotlightTarget = { control: SpotlightControl } | { tab: string } | { first: true };

/** What the spotlight was closed on: the module, where it was on screen, and what to focus. */
export interface SpotlightResult {
  id: string;
  top: number;
  target: SpotlightTarget;
}

/** Controls seen, by instance id then views (JSON): for the tab's session. */
const seen = new Map<string, Map<string, ShownControls>>();

interface Found extends SpotlightControl {
  /** What takes the focus (a slider's thumb). */
  focus: HTMLElement;
  /** What is outlined while it's the match. */
  outline: HTMLElement;
}

const SLIDER = '[data-scope="slider"][data-part="root"]';

/** The controls in a module's block, in the page's order. */
function controlsIn(block: Element): Found[] {
  const out: Found[] = [];
  const count = new Map<string, number>();
  const add = (
    kind: Found['kind'],
    label: string | null | undefined,
    focus: HTMLElement | null,
    outline: HTMLElement,
  ) => {
    const name = label?.trim();
    if (!name || !focus) return;
    const key = `${kind}:${name}`;
    const nth = count.get(key) ?? 0;
    count.set(key, nth + 1);
    out.push({ kind, label: name, nth, focus, outline });
  };
  for (const el of block.querySelectorAll<HTMLElement>(`${SLIDER}, button, select`)) {
    if (el.matches(SLIDER)) {
      add('slider', el.querySelector('[data-part="label"]')?.textContent, el.querySelector('[data-part="thumb"]'), el);
    } else if (el.closest(SLIDER) || ['tab', 'radio'].includes(el.getAttribute('role') ?? '')) {
      // A slider's number, or a tab (tabs are views).
    } else if (el instanceof HTMLSelectElement) {
      const label = el.id ? block.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : null;
      add('select', label ?? el.getAttribute('aria-label'), el, el);
    } else {
      add('button', el.getAttribute('aria-label') ?? (el.textContent || el.title), el, el);
    }
  }
  return out;
}

/** Remembers the controls of the module blocks in `root`. True when anything was new. */
function learn(root: Element): boolean {
  let changed = false;
  for (const block of root.querySelectorAll<HTMLElement>('[data-instance]')) {
    const id = block.dataset.instance!;
    const views = block.dataset.views ?? '{}';
    const controls = controlsIn(block).map(({ kind, label, nth }) => ({ kind, label, nth }));
    const known = seen.get(id) ?? new Map<string, ShownControls>();
    seen.set(id, known);
    if (JSON.stringify(known.get(views)?.controls) === JSON.stringify(controls)) continue;
    known.set(views, { views: JSON.parse(views) as Record<string, string>, controls });
    changed = true;
  }
  return changed;
}

/** The element `target` names in a module's block. */
export function findTarget(block: Element, target: SpotlightTarget): Found | null {
  const controls = controlsIn(block);
  if ('control' in target) {
    const c = target.control;
    return controls.find((f) => f.kind === c.kind && f.label === c.label && f.nth === c.nth) ?? null;
  }
  if ('tab' in target) {
    const name = target.tab.toLowerCase();
    const tab = [...block.querySelectorAll<HTMLElement>('[role="tab"], [role="radio"]')].find(
      (t) => (t.getAttribute('aria-label') ?? t.textContent ?? '').trim().toLowerCase() === name,
    );
    if (tab) return { kind: 'button', label: target.tab, nth: 0, focus: tab, outline: tab };
  }
  return controls.find((f) => f.kind === 'slider') ?? controls[0] ?? null;
}

const targetOf = (e: SpotlightEntry): SpotlightTarget =>
  e.control ? { control: e.control } : e.views.length ? { tab: e.views.at(-1)!.labels[0]! } : { first: true };

const focusOf = (e: SpotlightEntry | undefined): PanelFocus | null =>
  e ? { id: e.module.id, view: Object.fromEntries(e.views.map((v) => [v.field, v.value])) } : null;

/** How an entry reads in the list: the module, the tabs named, the control. */
const describe = (e: SpotlightEntry) =>
  [e.module.title, ...e.views.filter((v) => !v.isDefault || !e.control).map((v) => v.labels[0]), e.control?.label]
    .filter(Boolean)
    .join(' › ');

export function Spotlight({
  params,
  imageFormat,
  panel,
  onFocus,
  onClose,
}: {
  params: EditParams;
  imageFormat: string | null;
  /** The panel's modules. */
  panel: RefObject<HTMLElement | null>;
  /** What the panel shows meanwhile. */
  onFocus: (focus: PanelFocus | null) => void;
  /** Closed: on what (Enter), or nothing (Esc). */
  onClose: (result: SpotlightResult | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState(0);
  // Bumped when controls are learnt, to rebuild the entries.
  const [learnt, setLearnt] = useState(0);
  useEffect(() => {
    if (panel.current && learn(panel.current)) setLearnt((n) => n + 1);
  }, [panel]);

  const modules = useMemo<SpotlightModule[]>(
    () =>
      MODULE_KINDS.filter((k) => hasKind({ imageFormat }, k)).flatMap((kind: ModuleKind) => {
        const list = params.modules.filter((m) => m.kind === kind);
        return list.length
          ? list.map((m) => ({ id: m.id, kind, title: instanceTitle(params, m) }))
          : [{ id: kind, kind, title: MODULE_TITLES[kind] }];
      }),
    [params, imageFormat],
  );
  const entries = useMemo(
    () => buildEntries(modules, SPOTLIGHT_VIEWS as Record<string, SpotlightView[]>, seen),
    [modules, learnt],
  );
  const matches = useMemo(() => rankEntries(query, entries).slice(0, SHOWN), [query, entries]);
  const entry = matches[Math.min(choice, matches.length - 1)]?.entry;
  const focus = focusOf(entry);
  const focusKey = JSON.stringify(focus);
  useEffect(() => onFocus(focus), [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once the panel shows the module (its tabs render a frame later): learn its controls,
  // and outline the match.
  const block = () =>
    entry && panel.current?.querySelector<HTMLElement>(`[data-instance="${CSS.escape(entry.module.id)}"]`);
  const target = entry ? targetOf(entry) : null;
  const targetKey = JSON.stringify(target);
  useEffect(() => {
    let outlined: HTMLElement | null = null;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const b = block();
        if (!b || !target) return;
        if (learn(b)) setLearnt((n) => n + 1);
        outlined = findTarget(b, target)?.outline ?? null;
        if (outlined) {
          outlined.style.outline = '1px solid var(--chakra-colors-orange-solid)';
          outlined.style.outlineOffset = '3px';
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      if (outlined) {
        outlined.style.outline = '';
        outlined.style.outlineOffset = '';
      }
    };
  }, [focusKey, targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = (apply: boolean) => {
    const b = apply ? block() : null;
    const result = b && entry && target ? { id: entry.module.id, top: b.getBoundingClientRect().top, target } : null;
    onFocus(null);
    onClose(result);
  };

  return (
    <Stack gap="1.5" px="3" py="2.5" bg="bg.panel" borderBottomWidth="1px" data-spotlight>
      <Input
        size="sm"
        autoFocus
        placeholder="exp, filcon, cbm, temp…"
        aria-label="Module, tab or control"
        fontFamily="numeric"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setChoice(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') close(true);
          else if (e.key === 'Escape') close(false);
          else if (e.key === 'ArrowDown') setChoice((c) => Math.min(c + 1, matches.length - 1));
          else if (e.key === 'ArrowUp') setChoice((c) => Math.max(c - 1, 0));
          else return;
          // Taken: the developer's shortcuts leave it alone.
          e.preventDefault();
        }}
      />
      {matches.length > 0 ? (
        <Stack gap="0" role="listbox" aria-label="Matches">
          {matches.map(({ entry: m }, i) => (
            <HStack
              key={entryKey(m)}
              as="button"
              role="option"
              aria-selected={m === entry}
              textStyle="xs"
              px="1.5"
              py="0.5"
              borderRadius="l1"
              bg={m === entry ? 'bg.emphasized' : undefined}
              color={m === entry ? 'fg' : 'fg.muted'}
              // Keeps the focus in the query.
              onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
              onClick={() => setChoice(i)}
            >
              <Text truncate>{describe(m)}</Text>
            </HStack>
          ))}
        </Stack>
      ) : (
        query && (
          <Text textStyle="xs" color="fg.subtle">
            Nothing matches
          </Text>
        )
      )}
      <Text textStyle="2xs" color="fg.subtle">
        <Kbd size="sm">Enter</Kbd> focuses it · <Kbd size="sm">Esc</Kbd> closes · <Kbd size="sm">↑</Kbd>
        <Kbd size="sm">↓</Kbd> another match
      </Text>
    </Stack>
  );
}
