import { HStack, Slider, Text } from '@chakra-ui/react';
import { memo } from 'react';

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  format?: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}

const signed = (digits: number) => (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
export const fmt = { ev: (v: number) => `${signed(2)(v)} EV`, signed2: signed(2), fixed2: (v: number) => v.toFixed(2) };

/**
 * A compact labelled slider; double-click resets it to its default.
 *
 * Memoised on its value and range, ignoring `format`, `onChange` and `onCommit`: callers
 * write those inline, so they must not depend on render state (read the latest recipe at
 * call time), and a slider that gets rebound to something else needs a new `key`.
 */
export const ParamSlider = memo(function ParamSlider({ label, value, min, max, step, defaultValue, format = fmt.signed2, disabled, onChange, onCommit }: Props) {
  return (
    <Slider.Root
      size="sm"
      min={min}
      max={max}
      step={step}
      value={[value]}
      disabled={disabled}
      colorPalette="orange"
      // Symmetric bipolar parameters fill from their neutral (middle) point.
      origin={min === -max ? 'center' : 'start'}
      onValueChange={(e) => onChange(e.value[0]!)}
      onValueChangeEnd={(e) => onCommit(e.value[0]!)}
      onDoubleClick={() => onCommit(defaultValue)}
      title="Double-click to reset"
      gap="0"
    >
      <HStack justify="space-between" lineHeight="1.2">
        <Slider.Label textStyle="xs" color="fg.muted" fontWeight="normal">
          {label}
        </Slider.Label>
        <Text textStyle="xs" fontVariantNumeric="tabular-nums" color={value === defaultValue ? 'fg.subtle' : 'fg'}>
          {format(value)}
        </Text>
      </HStack>
      <Slider.Control minH="3.5">
        <Slider.Track h="2px" bg="bg.emphasized">
          <Slider.Range bg="orange.solid/70" />
        </Slider.Track>
        <Slider.Thumb index={0} boxSize="2.5" bg="fg.muted" borderWidth="0" boxShadow="xs" _hover={{ bg: 'fg' }} _focusVisible={{ bg: 'fg', outline: '2px solid', outlineColor: 'orange.solid' }}>
          <Slider.HiddenInput />
        </Slider.Thumb>
      </Slider.Control>
    </Slider.Root>
  );
}, (a, b) =>
  a.value === b.value &&
  a.label === b.label &&
  a.min === b.min &&
  a.max === b.max &&
  a.step === b.step &&
  a.defaultValue === b.defaultValue &&
  a.disabled === b.disabled,
);
