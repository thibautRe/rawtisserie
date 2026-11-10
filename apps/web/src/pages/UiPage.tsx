/**
 * The UI's building blocks on one page (`/ui`), with static data and no API: to see the
 * type, colours and components together, try the fonts, and write down which pattern
 * is for what. See the design system in docs/ROADMAP.md (M9).
 */
import '@fontsource-variable/big-shoulders/opsz.css';
import '@fontsource-variable/chivo';
import '@fontsource-variable/chivo-mono';
import {
  Box,
  Button,
  ButtonGroup,
  Center,
  Checkbox,
  Code,
  Container,
  Grid,
  HStack,
  Heading,
  IconButton,
  Input,
  Menu,
  NativeSelect,
  Portal,
  SegmentGroup,
  Separator,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { Circle, Download, Hexagon, MoreHorizontal, Pencil, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CompactTab, CompactTabs } from '../components/CompactTabs.tsx';
import { Module, PageTabs } from '../develop/ModulePanel.tsx';
import { ParamSlider, fmt } from '../develop/ParamSlider.tsx';
import { tracks } from '../develop/slider.ts';
import { Section as FilterSection } from '../library/FilterSidebar.tsx';
import { Culling } from '../library/InfoPanel.tsx';
import type { ColorLabel, Flag } from '../api/types.ts';

const INTER = "'Inter Variable', Inter, system-ui, sans-serif";
/** Font pairings to compare: headings, body, and small uppercase labels (module titles, section labels). */
const FONTS = {
  current: { heading: INTER, body: INTER, label: INTER },
  new: {
    heading: "'Big Shoulders Variable', 'Inter Variable', sans-serif",
    body: "'Chivo Mono Variable', ui-monospace, monospace",
    label: "'Chivo Variable', 'Inter Variable', sans-serif",
  },
} as const;
const FONT_ROLES = ['heading', 'body', 'label'] as const;
type Fonts = keyof typeof FONTS;

/**
 * Sets the fonts and colour mode on the whole document (menus and popovers are portalled
 * out of the page), and puts back the app's on leaving.
 */
function useDocumentLook(fonts: Fonts, mode: 'dark' | 'light') {
  useEffect(() => {
    const html = document.documentElement;
    for (const role of FONT_ROLES) html.style.setProperty(`--chakra-fonts-${role}`, FONTS[fonts][role]);
    html.classList.toggle('dark', mode === 'dark');
    html.classList.toggle('light', mode === 'light');
    html.style.colorScheme = mode;
    return () => {
      for (const role of FONT_ROLES) html.style.removeProperty(`--chakra-fonts-${role}`);
      html.classList.add('dark');
      html.classList.remove('light');
      html.style.colorScheme = 'dark';
    };
  }, [fonts, mode]);
}

function Block({ title, guide, children }: { title: string; guide?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Stack as="section" gap="4" py="8" borderBottomWidth="1px">
      <Stack gap="1">
        <Heading size="xl">{title}</Heading>
        {guide && (
          <Text textStyle="sm" color="fg.muted" maxW="3xl">
            {guide}
          </Text>
        )}
      </Stack>
      {children}
    </Stack>
  );
}

/** A labelled example. */
function Example({ label, children, w }: { label: string; children: React.ReactNode; w?: string }) {
  return (
    <Stack gap="2" w={w}>
      <Text textStyle="2xs" color="fg.subtle" fontFamily="mono">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

/** A side panel's width and look, for components that live in one. */
function Panel({ children, w = '72' }: { children: React.ReactNode; w?: string }) {
  return (
    <Stack w={w} p="3" gap="2" bg="bg.panel" borderWidth="1px" rounded="l2">
      {children}
    </Stack>
  );
}

const SAMPLE = 'From raw to well done: 0123456789 — ƒ/2.8 · 1/250 s · ISO 400 · +0.33 EV';
const COLOURS = [
  ['bg', 'page'],
  ['bg.panel', 'panels'],
  ['bg.muted', 'fields, hover'],
  ['bg.emphasized', 'selected'],
  ['canvas', 'developer surround (L* 50)'],
  ['fg', 'text'],
  ['fg.muted', 'labels'],
  ['fg.subtle', 'hints'],
  ['border', 'separators'],
  ['orange.solid', 'accent, primary actions'],
  ['orange.fg', 'modified, active'],
  ['green.solid', 'picked'],
  ['red.solid', 'rejected, destructive'],
] as const;

export function UiPage() {
  const [params, setParams] = useSearchParams();
  const fonts: Fonts = params.get('fonts') === 'new' ? 'new' : 'current';
  const mode = params.get('mode') === 'light' ? 'light' : 'dark';
  const setParam = (key: string, value: string | null) =>
    setParams(
      (p) => {
        if (value) p.set(key, value);
        else p.delete(key);
        return p;
      },
      { replace: true },
    );
  useDocumentLook(fonts, mode);

  const [exposure, setExposure] = useState(0.7);
  const [hue, setHue] = useState(-12);
  const [contrast, setContrast] = useState(1);
  const [preset, setPreset] = useState(2);
  const [page, setPage] = useState<'scene' | 'look' | 'options'>('scene');
  const [enabled, setEnabled] = useState(true);
  const [range, setRange] = useState<'global' | 'shadows' | 'midtones' | 'highlights'>('shadows');
  const [culling, setCulling] = useState<{ rating: number; flag: Flag | null; colorLabel: ColorLabel | null }>({
    rating: 3,
    flag: 'picked',
    colorLabel: 'blue',
  });
  const [tags, setTags] = useState(['beach', 'golden hour']);

  return (
    <Box h="full" overflowY="auto" bg="bg">
      <Box position="sticky" top="0" zIndex="sticky" bg="bg.panel" borderBottomWidth="1px">
        <Container maxW="6xl" py="3">
          <HStack justify="space-between" wrap="wrap" gap="3">
            <Heading size="md">🍗 UI</Heading>
            <HStack gap="4" wrap="wrap">
              <SegmentGroup.Root
                size="xs"
                value={fonts}
                onValueChange={(e) => setParam('fonts', e.value === 'new' ? 'new' : null)}
              >
                <SegmentGroup.Indicator />
                <SegmentGroup.Items
                  items={[
                    { value: 'current', label: 'Inter' },
                    { value: 'new', label: 'Big Shoulders + Chivo Mono + Chivo' },
                  ]}
                />
              </SegmentGroup.Root>
              <SegmentGroup.Root
                size="xs"
                value={mode}
                onValueChange={(e) => setParam('mode', e.value === 'light' ? 'light' : null)}
              >
                <SegmentGroup.Indicator />
                <SegmentGroup.Items
                  items={[
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' },
                  ]}
                />
              </SegmentGroup.Root>
            </HStack>
          </HStack>
        </Container>
      </Box>

      <Container maxW="6xl" pb="16">
        <Block
          title="Typography"
          guide="Headings use the heading face, everything else the body face. Panels mostly use the 2xs–sm text styles; numbers that change during a drag need fixed-width figures."
        >
          <Stack gap="3">
            {(['4xl', '3xl', '2xl', 'xl', 'lg', 'md', 'sm', 'xs'] as const).map((size) => (
              <HStack key={size} gap="4" align="baseline">
                <Text w="10" textStyle="2xs" color="fg.subtle" fontFamily="mono" flexShrink={0}>
                  {size}
                </Text>
                <Heading size={size}>Develop your photos</Heading>
              </HStack>
            ))}
          </Stack>
          <Separator />
          <Stack gap="3">
            {(['lg', 'md', 'sm', 'xs', '2xs'] as const).map((style) => (
              <HStack key={style} gap="4" align="baseline">
                <Text w="10" textStyle="2xs" color="fg.subtle" fontFamily="mono" flexShrink={0}>
                  {style}
                </Text>
                <Text textStyle={style}>{SAMPLE}</Text>
              </HStack>
            ))}
          </Stack>
          <Separator />
          <Grid templateColumns="repeat(auto-fill, minmax(16rem, 1fr))" gap="6">
            <Example label="Section label (uppercase)">
              <Heading size="xs" fontFamily="label" textTransform="uppercase" letterSpacing="wider" color="fg.muted">
                Colour label
              </Heading>
            </Example>
            <Example label="Panel heading (sentence case)">
              <Heading size="xs">Description</Heading>
            </Example>
            <Example label="Muted / subtle text">
              <Text textStyle="xs" color="fg.muted">
                Metadata edits are stored in your library.
              </Text>
              <Text textStyle="xs" color="fg.subtle">
                Nothing yet
              </Text>
            </Example>
            <Example label="Code">
              <Code size="sm">GET /api/tags</Code>
            </Example>
          </Grid>
        </Block>

        <Block
          title="Colours"
          guide="A neutral, slightly warm darkroom grey: photos should be the only colourful thing on screen. Orange is the one accent."
        >
          <Grid templateColumns="repeat(auto-fill, minmax(11rem, 1fr))" gap="3">
            {COLOURS.map(([token, use]) => (
              <HStack key={token} gap="3">
                {token.startsWith('fg') ? (
                  <Center boxSize="10" rounded="l2" bg="bg.panel" borderWidth="1px" color={token} flexShrink={0}>
                    <Text fontWeight="semibold">Aa</Text>
                  </Center>
                ) : (
                  <Box
                    boxSize="10"
                    rounded="l2"
                    bg={token === 'border' ? 'bg' : token}
                    borderWidth="1px"
                    borderColor={token === 'border' ? 'border' : 'border.muted'}
                    flexShrink={0}
                  />
                )}
                <Stack gap="0">
                  <Text textStyle="xs" fontFamily="mono">
                    {token}
                  </Text>
                  <Text textStyle="2xs" color="fg.muted">
                    {use}
                  </Text>
                </Stack>
              </HStack>
            ))}
          </Grid>
        </Block>

        <Block
          title="Buttons"
          guide="Solid orange for the one primary action of a view (Develop, Import, Export). Outline for secondary actions, ghost in toolbars and dense panels, red outline for destructive ones."
        >
          <Stack gap="4">
            {(['solid', 'subtle', 'surface', 'outline', 'ghost'] as const).map((variant) => (
              <HStack key={variant} gap="3" wrap="wrap">
                <Text w="16" textStyle="2xs" color="fg.subtle" fontFamily="mono">
                  {variant}
                </Text>
                {(['2xs', 'xs', 'sm', 'md'] as const).map((size) => (
                  <Button
                    key={size}
                    size={size}
                    variant={variant}
                    colorPalette={variant === 'solid' ? 'orange' : 'gray'}
                  >
                    <Download /> Export {size}
                  </Button>
                ))}
                <IconButton size="sm" variant={variant} aria-label="More">
                  <MoreHorizontal />
                </IconButton>
              </HStack>
            ))}
            <HStack gap="3">
              <Text w="16" textStyle="2xs" color="fg.subtle" fontFamily="mono">
                danger
              </Text>
              <Button size="sm" variant="outline" colorPalette="red">
                <Trash2 /> Delete
              </Button>
              <IconButton size="sm" variant="outline" colorPalette="red" aria-label="Delete">
                <Trash2 />
              </IconButton>
            </HStack>
          </Stack>
        </Block>

        <Block
          title="Switching views and values"
          guide={
            <>
              Four patterns are in use today. Proposed: <b>tabs (line)</b> for pages of a panel, a{' '}
              <b>segmented control</b> for choosing a value, <b>attached icon buttons</b> for tools. Subtle tabs (mixer
              views, colour balance ranges, tone channels) would become one of the others.
            </>
          }
        >
          <Grid templateColumns="repeat(auto-fill, minmax(18rem, 1fr))" gap="8">
            <Example label="Tabs line — pages of a panel (module pages, mask ranges)">
              <Panel>
                <PageTabs
                  label="Filmic pages"
                  pages={['scene', 'look', 'options'] as const}
                  labels={{ scene: 'Scene', look: 'Look', options: 'Options' }}
                  titles={{ scene: 'Scene', look: 'Look', options: 'Options' }}
                  value={page}
                  modified={(p) => p === 'look'}
                  onChange={setPage}
                />
              </Panel>
            </Example>
            <Example label="Tabs subtle — mixer views, ranges, tone channels">
              <Panel>
                <HStack gap="2" alignItems="baseline">
                  <Text textStyle="2xs" color="fg.subtle" flexShrink={0}>
                    Range
                  </Text>
                  <CompactTabs label="Range" value={range} onChange={setRange}>
                    {(['global', 'shadows', 'midtones', 'highlights'] as const).map((r) => (
                      <CompactTab key={r} value={r} textTransform="capitalize">
                        {r}
                      </CompactTab>
                    ))}
                  </CompactTabs>
                </HStack>
              </Panel>
            </Example>
            <Example label="Segmented control — a choice of value (filters, style modes)">
              <Panel>
                <SegmentGroup.Root size="xs" defaultValue="notRejected">
                  <SegmentGroup.Indicator />
                  <SegmentGroup.Items
                    items={[
                      { value: 'all', label: 'All' },
                      { value: 'picked', label: 'Picks' },
                      { value: 'notRejected', label: 'No rejects' },
                      { value: 'rejected', label: 'Rejects' },
                    ]}
                  />
                </SegmentGroup.Root>
              </Panel>
            </Example>
            <Example label="Attached buttons — tools (shapes)">
              <Panel>
                <ButtonGroup size="xs" variant="outline" attached>
                  <IconButton aria-label="Circle" variant="solid" colorPalette="orange">
                    <Circle />
                  </IconButton>
                  <IconButton aria-label="Rectangle">
                    <Square />
                  </IconButton>
                  <IconButton aria-label="Polygon">
                    <Hexagon />
                  </IconButton>
                  <IconButton aria-label="Brush">
                    <Pencil />
                  </IconButton>
                </ButtonGroup>
              </Panel>
            </Example>
          </Grid>
        </Block>

        <Block
          title="Sliders"
          guide="ParamSlider: drag, scroll, arrows (Shift for coarse, Ctrl for fine), double-click to reset, click the value to type one. Symmetric ranges fill from the middle; gradient tracks show what the value does; detents step through a list."
        >
          <Panel w="80">
            <ParamSlider
              label="Exposure"
              value={exposure}
              min={-3}
              max={4}
              step={0.01}
              defaultValue={0}
              format={fmt.ev}
              onChange={setExposure}
              onCommit={setExposure}
            />
            <ParamSlider
              label="Red hue"
              value={hue}
              min={-180}
              max={180}
              step={0.5}
              defaultValue={0}
              track={tracks.hue(0)}
              format={(v) => `${v.toFixed(1)}°`}
              onChange={setHue}
              onCommit={setHue}
            />
            <ParamSlider
              label="Contrast"
              value={contrast}
              min={0}
              max={2}
              step={0.01}
              defaultValue={1}
              track={tracks.grey}
              format={fmt.fixed2}
              onChange={setContrast}
              onCommit={setContrast}
            />
            <ParamSlider
              label="Preserve hue (detents)"
              value={preset}
              min={0}
              max={4}
              step={1}
              defaultValue={0}
              detents
              format={(v) => ['None', 'Low', 'Medium', 'High', 'Full'][v] ?? String(v)}
              onChange={setPreset}
              onCommit={setPreset}
            />
            <ParamSlider
              label="Disabled"
              value={0.3}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0}
              format={fmt.fixed2}
              disabled
              onChange={() => {}}
              onCommit={() => {}}
            />
          </Panel>
        </Block>

        <Block
          title="Section headers"
          guide="Three header styles today: the filters' uppercase labels (with a clear button), the modules' smaller uppercase titles (orange when modified, with switch and reset), and the info panel's sentence-case headings. To settle on one or two."
        >
          <Grid templateColumns="repeat(auto-fill, minmax(18rem, 1fr))" gap="8">
            <Example label="Filter section">
              <Panel w="64">
                <FilterSection title="Rating" onClear={() => {}}>
                  <Text textStyle="xs" color="fg.muted">
                    Content
                  </Text>
                </FilterSection>
              </Panel>
            </Example>
            <Example label="Module">
              <Panel w="80">
                <Module
                  title="Exposure"
                  enabled={enabled}
                  modified={exposure !== 0}
                  onToggle={setEnabled}
                  onReset={() => setExposure(0)}
                  menu={
                    <Menu.Root>
                      <Menu.Trigger asChild>
                        <IconButton aria-label="Instance menu" size="2xs" variant="ghost">
                          <MoreHorizontal />
                        </IconButton>
                      </Menu.Trigger>
                      <Portal>
                        <Menu.Positioner>
                          <Menu.Content>
                            <Menu.Item value="duplicate">
                              Duplicate <Menu.ItemCommand>Ctrl+D</Menu.ItemCommand>
                            </Menu.Item>
                            <Menu.Item value="rename">Rename…</Menu.Item>
                            <Menu.Separator />
                            <Menu.Item value="delete" color="fg.error">
                              Delete
                            </Menu.Item>
                          </Menu.Content>
                        </Menu.Positioner>
                      </Portal>
                    </Menu.Root>
                  }
                >
                  <ParamSlider
                    label="Exposure"
                    value={exposure}
                    min={-3}
                    max={4}
                    step={0.01}
                    defaultValue={0}
                    format={fmt.ev}
                    onChange={setExposure}
                    onCommit={setExposure}
                  />
                </Module>
              </Panel>
            </Example>
            <Example label="Info panel heading">
              <Panel w="80">
                <Heading size="xs">Capture</Heading>
                <Text textStyle="xs" color="fg.muted">
                  Content
                </Text>
              </Panel>
            </Example>
          </Grid>
        </Block>

        <Block title="Fields" guide="Inputs are xs in panels. Labels above, in xs muted text.">
          <Grid templateColumns="repeat(auto-fill, minmax(16rem, 1fr))" gap="6">
            <Example label="Input">
              <Input size="xs" placeholder="1/250" />
            </Example>
            <Example label="Native select (subtle)">
              <NativeSelect.Root size="xs">
                <NativeSelect.Field defaultValue="srgb">
                  <option value="srgb">sRGB</option>
                  <option value="p3">Display P3</option>
                  <option value="rec2020">Rec. 2020</option>
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
            </Example>
            <Example label="Textarea">
              <Textarea size="xs" rows={2} placeholder="Caption" />
            </Example>
            <Example label="Tags">
              <TagsInput.Root size="xs" value={tags} onValueChange={(e) => setTags(e.value)}>
                <TagsInput.Control>
                  <TagsInput.Items />
                  <TagsInput.Input placeholder="Add tag…" />
                </TagsInput.Control>
              </TagsInput.Root>
            </Example>
            <Example label="Checkbox and switch">
              <HStack gap="6">
                <Checkbox.Root size="sm" defaultChecked>
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label>Sony A7 IV</Checkbox.Label>
                </Checkbox.Root>
                <Switch.Root size="xs" colorPalette="orange" defaultChecked>
                  <Switch.HiddenInput />
                  <Switch.Control />
                  <Switch.Label>Enabled</Switch.Label>
                </Switch.Root>
              </HStack>
            </Example>
            <Example label="Ghost icon button in a dense row">
              <HStack justify="space-between">
                <Text textStyle="xs">Reset all</Text>
                <IconButton size="2xs" variant="ghost" aria-label="Reset">
                  <RotateCcw />
                </IconButton>
              </HStack>
            </Example>
          </Grid>
        </Block>

        <Block
          title="Culling"
          guide="Rating, flag and colour label, as in the library's info panel (shortcuts 0–5, P/X/U, 6–9)."
        >
          <Panel w="80">
            <Culling {...culling} onChange={(patch) => setCulling((c) => ({ ...c, ...patch }))} />
          </Panel>
        </Block>
      </Container>
    </Box>
  );
}
