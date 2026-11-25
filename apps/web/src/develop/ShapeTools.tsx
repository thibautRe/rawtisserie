import { ButtonGroup, HStack, IconButton } from '@chakra-ui/react';
import type { ModuleKind } from '@rawtisserie/pipeline';
import { Circle, Egg, Eye, EyeOff, MousePointer2, Paintbrush, PenTool, Sunrise } from 'lucide-react';
import type { ReactNode } from 'react';
import { ParamSlider } from './ParamSlider.tsx';
import { DEFAULT_SHAPE_UI, type ShapeTarget, type ShapeTool, type ShapeUi, isEditing } from './retouch.ts';
import type { ShapeSettings } from './shapeSettings.ts';

export const SHAPE_TOOLS: [ShapeTool, typeof Circle, string][] = [
  ['select', MousePointer2, 'Select and edit shapes'],
  ['circle', Circle, 'Circle: click, or drag for its size'],
  ['ellipse', Egg, 'Ellipse: click, or drag for its size'],
  ['gradient', Sunrise, 'Gradient: drag from where it applies fully to where it stops'],
  ['path', PenTool, 'Path: click to add nodes (drag for curves); click the first node or press Enter to close'],
  ['brush', Paintbrush, 'Brush: paint a stroke'],
];

/**
 * The shape tools for the spots of a retouch instance or the mask of an instance (`id`,
 * of kind `kind`), and the switch that shows them on the image. Clicking the active
 * tool again steps back, as Esc does on the image.
 */
export function ShapeToolBar({
  ui,
  target,
  id,
  kind,
  noun,
  onUi,
  children,
}: {
  ui: ShapeUi;
  target: ShapeTarget;
  id: string;
  kind: ModuleKind;
  /** What the shapes are, plural ("spots"). */
  noun: string;
  onUi: (patch: Partial<ShapeUi>) => void;
  /** More buttons after the tools, in the same group (a mask's "mask of another module"). */
  children?: ReactNode;
}) {
  const editing = isEditing(ui, target, id);
  const sel = editing ? ui.selected : null;
  /** What Esc does on the image: leave the tool, then the selection, then the overlay. */
  const back = () => {
    if (ui.tool !== 'select') onUi({ tool: 'select' });
    else if (sel !== null) onUi({ selected: null });
    else onUi({ editing: false });
  };
  const start = (tool: ShapeTool) =>
    onUi({ editing: true, target, instance: id, kind, tool, selected: editing ? ui.selected : null });
  return (
    <HStack justify="space-between">
      <ButtonGroup size="xs" variant="outline" attached>
        {SHAPE_TOOLS.map(([tool, Icon, label]) => {
          const on = editing && ui.tool === tool;
          return (
            <IconButton
              key={tool}
              aria-label={label}
              title={on ? `${label} (click again or Esc to leave)` : label}
              aria-pressed={on}
              variant={on ? 'solid' : 'outline'}
              colorPalette={on ? 'orange' : 'gray'}
              onClick={() => (on ? back() : start(tool))}
            >
              <Icon />
            </IconButton>
          );
        })}
        {children}
      </ButtonGroup>
      <IconButton
        size="xs"
        variant="ghost"
        aria-label={editing ? `Hide ${noun} on the image` : `Show ${noun} on the image`}
        title={editing ? `Hide ${noun} on the image (Esc)` : `Show ${noun} on the image`}
        onClick={() =>
          onUi(
            editing
              ? { editing: false, tool: 'select' }
              : { editing: true, target, instance: id, kind, tool: 'select', selected: null },
          )
        }
      >
        {editing ? <Eye /> : <EyeOff />}
      </IconButton>
    </HStack>
  );
}

/** Size and hardness of the brush tool. */
export function BrushSettings({ ui, onUi }: { ui: ShapeUi; onUi: (patch: Partial<ShapeUi>) => void }) {
  return (
    <>
      <ParamSlider
        label="Brush size"
        min={2}
        max={200}
        step={1}
        format={(v) => `${Math.round(v)} px`}
        value={ui.brushSize}
        defaultValue={DEFAULT_SHAPE_UI.brushSize}
        onChange={(v) => onUi({ brushSize: v })}
        onCommit={(v) => onUi({ brushSize: v })}
      />
      <ParamSlider
        label="Brush hardness"
        min={0}
        max={1}
        step={0.01}
        scale={100}
        format={(v) => `${Math.round(v * 100)} %`}
        value={ui.brushHardness}
        defaultValue={DEFAULT_SHAPE_UI.brushHardness}
        onChange={(v) => onUi({ brushHardness: v })}
        onCommit={(v) => onUi({ brushHardness: v })}
      />
    </>
  );
}

const percent1 = (v: number) => `${(v * 100).toFixed(1)} %`;

/** Sliders for a shape's settings (`shapeSettings`); `opacity: false` leaves its opacity out. */
export function ShapeSettingsSliders({
  settings,
  opacity = true,
  onChange,
  onCommit,
}: {
  settings: ShapeSettings;
  opacity?: boolean;
  onChange: (patch: Partial<ShapeSettings>) => void;
  /** `what` names the setting, for the history label ("feather"). */
  onCommit: (patch: Partial<ShapeSettings>, what: string) => void;
}) {
  const bind = (key: 'opacity' | 'feather' | 'size' | 'hardness', what: string) => ({
    value: settings[key] ?? 0,
    onChange: (v: number) => onChange({ [key]: v }),
    onCommit: (v: number) => onCommit({ [key]: v }, what),
  });
  return (
    <>
      {opacity && (
        <ParamSlider
          label="Opacity"
          min={0}
          max={1}
          step={0.01}
          scale={100}
          format={(v) => `${Math.round(v * 100)} %`}
          defaultValue={1}
          {...bind('opacity', 'opacity')}
        />
      )}
      {settings.feather !== undefined && (
        <ParamSlider
          label="Feather"
          min={0}
          max={settings.featherMax ?? 0.1}
          hardMax={2}
          step={0.001}
          scale={100}
          format={percent1}
          defaultValue={0}
          {...bind('feather', 'feather')}
        />
      )}
      {settings.size !== undefined && (
        <ParamSlider
          label="Stroke size"
          min={0.001}
          max={0.1}
          hardMin={0.0001}
          hardMax={1}
          step={0.001}
          scale={100}
          format={percent1}
          defaultValue={0.02}
          {...bind('size', 'stroke size')}
        />
      )}
      {settings.hardness !== undefined && (
        <ParamSlider
          label="Stroke hardness"
          min={0}
          max={1}
          step={0.01}
          scale={100}
          format={(v) => `${Math.round(v * 100)} %`}
          defaultValue={DEFAULT_SHAPE_UI.brushHardness}
          {...bind('hardness', 'stroke hardness')}
        />
      )}
    </>
  );
}
