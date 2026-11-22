import { HStack, Input, Slider, Text } from '@chakra-ui/react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type SliderHandle, registerSlider } from './sliderRegistry.ts';
import {
  type DragAnchor,
  type Extent,
  LINEAR,
  type SliderCurve,
  type SliderRange,
  dragTo,
  fineStep,
  growExtent,
  modifierFactor,
  nudge,
  parseTyped,
  snapTo,
  typedText,
} from './slider.ts';

interface Props {
  label: string;
  value: number;
  /** The useful range, which drags and arrow keys stay in. */
  min: number;
  max: number;
  /** What the module accepts, which typing can reach. Defaults to the useful range. */
  hardMin?: number;
  hardMax?: number;
  step: number;
  defaultValue: number;
  format?: (v: number) => string;
  /** Typed values are in display units: `value × scale`, when `format` shows that. */
  scale?: number;
  /** A CSS gradient for the track, instead of a filled range. */
  track?: string;
  /**
   * Where the filled range starts. Defaults to the middle for symmetric ranges and to the
   * start otherwise; set it for a neutral point elsewhere (0 in -50 … +200). A tick
   * marks it when it's inside the range (0 for symmetric ones; none otherwise).
   */
  origin?: number;
  /**
   * A non-linear track (see `sinhCurve`). Must be a constant: it's compared by identity,
   * and a `track` gradient must use the same one.
   */
  curve?: SliderCurve;
  /** Steps through an enumeration: shows a tick per value, with no typing or modifiers. */
  detents?: boolean;
  disabled?: boolean;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}

const signed = (digits: number) => (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
export const fmt = { ev: (v: number) => `${signed(2)(v)} EV`, signed2: signed(2), fixed2: (v: number) => v.toFixed(2) };

const KEY_STEPS: Record<string, number> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
  PageUp: 10,
  PageDown: -10,
};

/** The filled range, as `Slider.Range` draws it (orange.solid/70). */
const FILL = 'color-mix(in srgb, var(--chakra-colors-orange-solid) 70%, transparent)';

/** The part of the track outside the useful range. */
const PAST_RANGE = 'var(--chakra-colors-yellow-solid)';

/**
 * A compact labelled slider; double-click resets it to its default. Click (or right-click)
 * the number to type a value. Shift ×10 and Ctrl ×0.1 apply to drags and arrow keys.
 *
 * Drags and arrows stay on the track. Typing and values set from elsewhere (auto-tune) can
 * go past the useful range, up to the hard range: the track then grows to contain the
 * value, showing that part in another colour, and stays that way until it unmounts.
 *
 * Plain drags use the slider's own pointer handling. It ignores presses on the track with
 * Ctrl held and only reports positions on the track, so modifier drags measure the pointer
 * themselves, which lets them start anywhere on the track without a jump.
 *
 * Memoised on its value and range, ignoring `format`, `onChange` and `onCommit`: callers
 * write those inline, so they must not depend on render state (read the latest recipe at
 * call time), and a slider that gets rebound to something else needs a new `key`.
 */
export const ParamSlider = memo(
  function ParamSlider({
    label,
    value,
    min,
    max,
    hardMin = min,
    hardMax = max,
    step,
    defaultValue,
    format = fmt.signed2,
    scale = 1,
    track,
    origin,
    curve = LINEAR,
    detents,
    disabled,
    onChange,
    onCommit,
  }: Props) {
    const range: SliderRange = { min, max, step, fine: step };
    const [typing, setTyping] = useState(false);
    const [extent, setExtent] = useState<Extent>(() => growExtent([min, max], value, range));
    const grown = growExtent(extent, value, range);
    if (grown !== extent) setExtent(grown);
    const [lo, hi] = grown;
    const drag = useRef<{ anchor: DragAnchor; value: number } | null>(null);
    const stopTracking = useRef<(() => void) | null>(null);
    useEffect(() => () => stopTracking.current?.(), []);

    // Others may drive it (the spotlight): as last rendered.
    const root = useRef<HTMLDivElement>(null);
    const handle = useRef<SliderHandle>(null!);
    handle.current = {
      root: root.current,
      label,
      value,
      range,
      extent: grown,
      curve,
      format,
      disabled: !!disabled || !!detents,
      onChange,
      onCommit,
    };
    useLayoutEffect(() => registerSlider(() => ({ ...handle.current, root: root.current })), []);

    const fine = (): SliderRange => ({ ...range, fine: fineStep(step, format, scale) });

    const step_ = (steps: number, factor: number) => {
      const next = nudge(value, steps, detents ? 1 : factor, fine(), grown);
      if (next !== value) onCommit(next);
    };

    const onPointerDownCapture = (e: React.PointerEvent) => {
      const control = e.target instanceof Element ? e.target.closest('[data-part="control"]') : null;
      if (disabled || !control || e.button !== 0) return;
      drag.current = { anchor: null, value };
      const unitsPerPixel = (curve.toPosition(hi) - curve.toPosition(lo)) / control.getBoundingClientRect().width;
      const follow = (ev: PointerEvent) => {
        const current = drag.current;
        const factor = modifierFactor(ev);
        if (detents || !current || (!current.anchor && factor === 1)) return;
        const next = dragTo(current.anchor, ev.clientX * unitsPerPixel, factor, current.value, fine(), grown, curve);
        drag.current = next;
        if (next.value !== current.value) onChange(next.value);
      };
      const stop = () => {
        window.removeEventListener('pointermove', follow, true);
        window.removeEventListener('pointerup', finish, true);
        window.removeEventListener('pointercancel', finish, true);
        stopTracking.current = null;
      };
      // Not the slider's end event: it ignores presses on the track with Ctrl held.
      const finish = () => {
        stop();
        if (drag.current) onCommit(drag.current.value);
        drag.current = null;
      };
      stopTracking.current?.();
      // Capturing runs this before the slider's handling of the same event.
      window.addEventListener('pointermove', follow, true);
      window.addEventListener('pointerup', finish, true);
      window.addEventListener('pointercancel', finish, true);
      stopTracking.current = stop;
      follow(e.nativeEvent);
    };

    const onKeyDownCapture = (e: React.KeyboardEvent) => {
      if (disabled || typing) return;
      const steps = KEY_STEPS[e.key];
      if (steps) step_(steps, modifierFactor(e));
      else if (e.key === 'Home' && value !== lo) onCommit(lo);
      else if (e.key === 'End' && value !== hi) onCommit(hi);
      else if (e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      e.stopPropagation();
    };

    const finishTyping = (text: string | null) => {
      setTyping(false);
      const v = text === null ? null : parseTyped(text, scale, hardMin, hardMax);
      if (v !== null && v !== value) onCommit(v);
    };
    const startTyping = (e: React.SyntheticEvent) => {
      e.preventDefault();
      setTyping(true);
    };

    const pos = curve.toPosition;
    const percent = (v: number) => `${((pos(v) - pos(lo)) / (pos(hi) - pos(lo))) * 100}%`;
    const segment: React.CSSProperties = { position: 'absolute', top: 0, bottom: 0 };
    // The neutral point, which a tick marks (detents have a dot per value instead).
    const neutral = origin ?? (min === -max ? 0 : undefined);
    const tick = !detents && neutral !== undefined && neutral > min && neutral < max ? neutral : null;

    return (
      <Slider.Root
        ref={root}
        size="sm"
        // In track positions: the same as values, unless there's a curve.
        min={pos(lo)}
        max={pos(hi)}
        // Ten times finer than the values: `snapTo` does that.
        step={detents ? step : step / 10}
        value={[pos(value)]}
        disabled={disabled}
        colorPalette="orange"
        // Symmetric bipolar parameters fill from their neutral (middle) point.
        origin={min === -max ? 'center' : 'start'}
        getAriaValueText={() => format(value)}
        onPointerDownCapture={onPointerDownCapture}
        onValueChange={(e) => {
          // Only a plain drag: `onPointerDownCapture` handles the rest.
          const current = drag.current;
          if (!current || current.anchor) return;
          const next = snapTo(e.value[0]!, grown, range, curve);
          drag.current = { anchor: null, value: next };
          if (next !== current.value) onChange(next);
        }}
        onKeyDownCapture={onKeyDownCapture}
        onDoubleClick={() => typing || onCommit(defaultValue)}
        title="Double-click to reset"
        gap="0"
      >
        <HStack justify="space-between" lineHeight="1.2">
          <Slider.Label textStyle="xs" color="fg.muted" fontWeight="normal">
            {label}
          </Slider.Label>
          {typing ? (
            <Input
              size="2xs"
              h="3.5"
              minH="0"
              w="16"
              px="1"
              textStyle="xs"
              fontFamily="numeric"
              textAlign="right"
              aria-label={label}
              autoFocus
              defaultValue={typedText(value, scale)}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => finishTyping(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') finishTyping(e.currentTarget.value);
                else if (e.key === 'Escape') {
                  // Tells the developer's shortcuts this press is taken.
                  e.preventDefault();
                  finishTyping(null);
                }
              }}
            />
          ) : detents ? (
            <Text textStyle="xs" fontFamily="numeric" color={value === defaultValue ? 'fg.subtle' : 'fg'}>
              {format(value)}
            </Text>
          ) : (
            <Text
              as="button"
              textStyle="xs"
              fontFamily="numeric"
              fontVariantNumeric="tabular-nums"
              color={value === defaultValue ? 'fg.subtle' : 'fg'}
              cursor={disabled ? undefined : 'text'}
              title="Click to type a value"
              aria-label={`${label}: ${format(value)}, type a value`}
              {...{ type: 'button', disabled }}
              onClick={startTyping}
              onContextMenu={startTyping}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {format(value)}
            </Text>
          )}
        </HStack>
        <Slider.Control minH="3.5">
          <Slider.Track h="1px" bg="bg.emphasized" overflow="visible">
            {track ? (
              <div
                style={{ ...segment, left: percent(min), right: `calc(100% - ${percent(max)})`, background: track }}
              />
            ) : detents ? (
              // From the first dot, which is inset like the thumb (the slider's range starts at the track's edge).
              <div
                style={{
                  ...segment,
                  left: 'calc(var(--slider-thumb-width) / 2)',
                  width: 'calc(var(--slider-thumb-offset-0) - var(--slider-thumb-width) / 2)',
                  background: FILL,
                }}
              />
            ) : origin !== undefined ? (
              <div
                style={{
                  ...segment,
                  left: percent(Math.min(origin, value)),
                  right: `calc(100% - ${percent(Math.max(origin, value))})`,
                  background: FILL,
                }}
              />
            ) : (
              <Slider.Range bg="orange.solid/70" />
            )}
            {lo < min && <div style={{ ...segment, left: 0, width: percent(min), background: PAST_RANGE }} />}
            {hi > max && <div style={{ ...segment, left: percent(max), right: 0, background: PAST_RANGE }} />}
            {tick !== null && (
              <div
                aria-hidden
                style={{
                  ...segment,
                  top: -3,
                  bottom: -3,
                  left: `calc(${percent(tick)} - 0.5px)`,
                  width: 1,
                  background: 'var(--chakra-colors-fg-muted)',
                }}
              />
            )}
          </Slider.Track>
          <Slider.Thumb
            index={0}
            boxSize="2.5"
            bg="fg.muted"
            borderWidth="0"
            boxShadow="xs"
            _hover={{ bg: 'fg' }}
            _focusVisible={{ bg: 'fg', outline: '2px solid', outlineColor: 'orange.solid' }}
          >
            <Slider.HiddenInput />
          </Slider.Thumb>
          {/*
          Chakra places the dots for its own thumb size: centre them on the track, spanning it
          like the thumb. In the thumb's colour, also on the filled range (Chakra's turn into holes there), and
          under the thumb (whose z-index drops to the dots' while it has focus).
        */}
          {detents && (
            <Slider.MarkerGroup top="calc(50% - var(--slider-marker-size) / 2)" insetInline="0" zIndex="0">
              {Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => min + i * step).map((v) => (
                <Slider.Marker key={v} value={v}>
                  <Slider.MarkerIndicator bg="fg.muted" />
                </Slider.Marker>
              ))}
            </Slider.MarkerGroup>
          )}
        </Slider.Control>
      </Slider.Root>
    );
  },
  (a, b) =>
    a.value === b.value &&
    a.label === b.label &&
    a.min === b.min &&
    a.max === b.max &&
    a.hardMin === b.hardMin &&
    a.hardMax === b.hardMax &&
    a.step === b.step &&
    a.defaultValue === b.defaultValue &&
    a.scale === b.scale &&
    a.track === b.track &&
    a.origin === b.origin &&
    a.curve === b.curve &&
    a.detents === b.detents &&
    a.disabled === b.disabled,
);
