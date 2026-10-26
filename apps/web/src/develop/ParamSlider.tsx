import { HStack, Slider, Text } from '@chakra-ui/react';

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

/** A labelled slider; double-click resets it to its default. */
export function ParamSlider({ label, value, min, max, step, defaultValue, format = fmt.signed2, disabled, onChange, onCommit }: Props) {
  return (
    <Slider.Root
      size="sm"
      min={min}
      max={max}
      step={step}
      value={[value]}
      disabled={disabled}
      colorPalette="orange"
      // Bipolar parameters fill from their neutral point.
      origin={min < 0 && max > 0 ? 'center' : 'start'}
      onValueChange={(e) => onChange(e.value[0]!)}
      onValueChangeEnd={(e) => onCommit(e.value[0]!)}
      onDoubleClick={() => onCommit(defaultValue)}
      title="Double-click to reset"
    >
      <HStack justify="space-between">
        <Slider.Label textStyle="xs" color="fg.muted" fontWeight="normal">
          {label}
        </Slider.Label>
        <Text textStyle="xs" fontVariantNumeric="tabular-nums" color={value === defaultValue ? 'fg.subtle' : 'fg'}>
          {format(value)}
        </Text>
      </HStack>
      <Slider.Control>
        <Slider.Track>
          <Slider.Range />
        </Slider.Track>
        <Slider.Thumbs />
      </Slider.Control>
    </Slider.Root>
  );
}
