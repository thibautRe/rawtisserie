/**
 * The spotlight (roadmap 2.6, a prototype): Ctrl+Space, a few letters naming a module, its
 * tabs and a slider ("filcon": Filmic › Contrast), and the mouse drives that slider, no
 * click needed: moving right raises it. A click or Enter applies, Esc puts it back. It
 * sits at the top of the right panel, which shows only the module named meanwhile
 * (`ModulePanel`'s `only`). The pointer is locked while it's open, so moves never stop at
 * the screen's edge.
 */
import { Box, HStack, Input, Kbd, Stack, Text } from '@chakra-ui/react';
import { type EditParams, MODULE_KINDS, type ModuleKind, hasKind } from '@rawtisserie/pipeline';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { MODULE_TITLES, instanceTitle } from './changes.ts';
import { type PanelFocus, SPOTLIGHT_VIEWS } from './ModulePanel.tsx';
import { type DragAnchor, dragTo, fineStep, modifierFactor } from './slider.ts';
import { type SliderHandle, slidersIn } from './sliderRegistry.ts';
import { type SpotlightModule, type SpotlightTarget, matchSlider, parseQuery } from './spotlight.ts';

/** Pixels of mouse travel across a slider's whole useful range. */
const TRAVEL_PX = 500;
/** Targets listed below the query. */
const SHOWN = 6;

/** A gesture on one slider: where it started and the pointer's travel since. */
interface Gesture {
  label: string;
  start: number;
  value: number;
  x: number;
  anchor: DragAnchor;
}

const focusOf = (t: SpotlightTarget | undefined): PanelFocus | null =>
  t ? { id: t.module.id, view: Object.fromEntries(t.views.map((v) => [v.field, v.value])) } : null;

export function Spotlight({
  params,
  imageFormat,
  panel,
  onFocus,
  onRevert,
  onClose,
}: {
  params: EditParams;
  imageFormat: string | null;
  /** Where the panel's sliders are. */
  panel: RefObject<HTMLElement | null>;
  /** What the panel shows meanwhile. */
  onFocus: (focus: PanelFocus | null) => void;
  /** Back to the committed recipe (a gesture cancelled). */
  onRevert: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState(0);
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
  const targets = useMemo(
    () => parseQuery(query, modules, SPOTLIGHT_VIEWS as Record<string, never>).slice(0, SHOWN),
    [query, modules],
  );
  const target = targets[Math.min(choice, targets.length - 1)];
  const focus = focusOf(target);
  const focusKey = JSON.stringify(focus);
  useEffect(() => onFocus(focus), [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The slider the rest of the query names, once the panel shows the module (its tabs
  // render a frame or two later).
  const [bound, setBound] = useState<string | null>(null);
  const rest = target?.rest ?? '';
  useEffect(() => {
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const sliders = panel.current ? slidersIn(panel.current).filter((s) => !s.disabled) : [];
        const i = matchSlider(
          rest,
          sliders.map((s) => s.label),
        );
        setBound(i === null ? null : sliders[i]!.label);
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [focusKey, rest, panel]);

  // A slider moved, then the query changed: it goes back.
  const gesture = useRef<Gesture | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (gesture.current && gesture.current.label !== bound) {
      gesture.current = null;
      setShown(null);
      onRevert();
    }
  }, [bound]); // eslint-disable-line react-hooks/exhaustive-deps

  const find = (label: string | null): SliderHandle | undefined =>
    label && panel.current ? slidersIn(panel.current).find((s) => s.label === label && !s.disabled) : undefined;

  // The bound slider, outlined.
  useEffect(() => {
    const root = find(bound)?.root;
    if (!root) return;
    root.style.outline = '1px solid var(--chakra-colors-orange-solid)';
    root.style.outlineOffset = '3px';
    root.style.borderRadius = '2px';
    return () => {
      root.style.outline = '';
      root.style.outlineOffset = '';
    };
  });

  const boundRef = useRef(bound);
  boundRef.current = bound;
  const closing = useRef(false);
  const header = useRef<HTMLDivElement>(null);

  const finish = (apply: boolean) => {
    if (closing.current) return;
    closing.current = true;
    const g = gesture.current;
    if (g && apply) find(g.label)?.onCommit(g.value);
    else if (g) onRevert();
    gesture.current = null;
    if (document.pointerLockElement) document.exitPointerLock();
    onFocus(null);
    onClose();
  };
  const latestFinish = useRef(finish);
  latestFinish.current = finish;

  useEffect(() => {
    const root = document.documentElement;
    let locked = false;
    // Opened from a key press: it may lock the pointer (and may not: then moves stop at the edges).
    void Promise.resolve(root.requestPointerLock?.()).catch(() => undefined);
    const onLock = () => {
      if (document.pointerLockElement) locked = true;
      // Esc with the pointer locked only unlocks it (the page doesn't get the key): cancel.
      else if (locked) latestFinish.current(false);
    };
    const move = (e: MouseEvent) => {
      const s = find(boundRef.current);
      if (!s || !e.movementX) return;
      let g = gesture.current;
      if (!g || g.label !== s.label) {
        // Another slider since: the last one goes back first.
        if (g) onRevert();
        g = { label: s.label, start: s.value, value: s.value, x: 0, anchor: null };
      }
      const [lo, hi] = s.extent;
      const unitsPerPixel = (s.curve.toPosition(hi) - s.curve.toPosition(lo)) / TRAVEL_PX;
      const x = g.x + e.movementX;
      const range = { ...s.range, fine: fineStep(s.range.step, s.format, 1) };
      const next = dragTo(g.anchor, x * unitsPerPixel, modifierFactor(e), g.value, range, s.extent, s.curve);
      gesture.current = { ...g, x, anchor: next.anchor, value: next.value };
      if (next.value !== g.value) {
        s.onChange(next.value);
        setShown(s.format(next.value));
      }
    };
    const down = (e: MouseEvent) => {
      // Unlocked, the query and its list stay clickable.
      if (!document.pointerLockElement && header.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      latestFinish.current(true);
    };
    document.addEventListener('pointerlockchange', onLock);
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mousedown', down, true);
    return () => {
      document.removeEventListener('pointerlockchange', onLock);
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mousedown', down, true);
      if (document.pointerLockElement) document.exitPointerLock();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const slider = find(bound);
  return (
    <Stack ref={header} gap="1.5" px="3" py="2.5" bg="bg.panel" borderBottomWidth="1px" data-spotlight>
      <Input
        size="sm"
        autoFocus
        placeholder="exp, filcon, cbmb…"
        aria-label="Module and slider"
        fontFamily="numeric"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setChoice(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(true);
          else if (e.key === 'Escape') finish(false);
          else if (e.key === 'ArrowDown') setChoice((c) => Math.min(c + 1, targets.length - 1));
          else if (e.key === 'ArrowUp') setChoice((c) => Math.max(c - 1, 0));
          else return;
          // Taken: the developer's shortcuts leave it alone.
          e.preventDefault();
        }}
      />
      {targets.length > 0 ? (
        <Stack gap="0">
          {targets.map((t, i) => (
            <HStack
              key={JSON.stringify(focusOf(t))}
              as="button"
              textStyle="xs"
              px="1.5"
              py="0.5"
              borderRadius="l1"
              bg={t === target ? 'bg.emphasized' : undefined}
              color={t === target ? 'fg' : 'fg.muted'}
              onClick={() => setChoice(i)}
            >
              <Text truncate>
                {[t.module.title, ...t.views.map((v) => v.labels[0])].join(' › ')}
                {t.rest && <Text as="span" color="fg.subtle">{` · ${t.rest}…`}</Text>}
              </Text>
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
      {target && (
        <HStack textStyle="xs" justify="space-between" color={slider ? 'orange.fg' : 'fg.subtle'}>
          <Text truncate>{slider ? `↔ ${slider.label}` : `No slider matches “${rest}”`}</Text>
          {slider && (
            <Text fontFamily="numeric" fontVariantNumeric="tabular-nums">
              {gesture.current?.label === slider.label && shown ? shown : slider.format(slider.value)}
            </Text>
          )}
        </HStack>
      )}
      <Text textStyle="2xs" color="fg.subtle">
        Move the mouse to change it (<Kbd size="sm">Shift</Kbd> ×10, <Kbd size="sm">Ctrl</Kbd> ×0.1) · click or{' '}
        <Kbd size="sm">Enter</Kbd> applies · <Kbd size="sm">Esc</Kbd> cancels · <Kbd size="sm">↑</Kbd>
        <Kbd size="sm">↓</Kbd> another match
      </Text>
    </Stack>
  );
}
