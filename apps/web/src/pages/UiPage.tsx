/**
 * The UI's building blocks on one page (`/ui`), with static data and no API: to see the
 * type, colours and components together, and write down which pattern is for what. See the design system in docs/ROADMAP.md (M9).
 */
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
  Progress,
  SegmentGroup,
  Separator,
  Spinner,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { Circle, Download, Hexagon, MoreHorizontal, Pencil, RotateCcw, Square, Trash2 } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CompactTab, CompactTabs } from '../components/CompactTabs.tsx';
import { InfoTip } from '../components/InfoTip.tsx';
import { TagSearch } from '../components/TagSearch.tsx';
import { Module, PageTabs } from '../develop/ModulePanel.tsx';
import { ParamSlider, fmt } from '../develop/ParamSlider.tsx';
import { tracks } from '../develop/slider.ts';
import { PanelBlock } from '../library/PanelBlock.tsx';
import { Culling } from '../library/InfoPanel.tsx';
import { SelectionBar } from '../library/LibraryStatusBar.tsx';
import { PanelDrawer } from '../components/PanelDrawer.tsx';
import { ManagerDialog } from '../develop/ManagerDialog.tsx';
import { StorageBreakdown, StorageMeter } from '../components/StorageMeter.tsx';
import { TransferSummary } from '../components/transfer.tsx';
import { ImportSummary, InterruptedImport } from '../library/ImportToast.tsx';
import { type Review, ReviewBody, sampleReview } from '../library/ImportReview.tsx';
import { type ImportRun, sampleRun } from '../library/imports.ts';
import type { ColorLabel, Flag, Transfer } from '../api/types.ts';

/**
 * Sets the colour mode on the whole document (menus and popovers are portalled out of
 * the page), and puts back the app's on leaving.
 */
function useDocumentLook(mode: 'dark' | 'light') {
  useEffect(() => {
    const html = document.documentElement;
    html.classList.toggle('dark', mode === 'dark');
    html.classList.toggle('light', mode === 'light');
    html.style.colorScheme = mode;
    return () => {
      html.classList.add('dark');
      html.classList.remove('light');
      html.style.colorScheme = 'dark';
    };
  }, [mode]);
}

/** The font tokens (`theme.ts`): which family, what for, and how to apply. */
const FONT_ROLES = [
  {
    token: 'heading',
    family: 'Geologica',
    sample: { text: 'Develop your photos', props: { fontFamily: 'heading', fontWeight: 'semibold', textStyle: 'md' } },
    use: 'Page and dialog titles; the file name in the info panel.',
    how: '<Heading> (default)',
  },
  {
    token: 'body',
    family: 'Geologica',
    sample: { text: 'Beach at dusk', props: { fontFamily: 'body', textStyle: 'sm' } },
    use: 'Everything else in words: field labels and values, menus, buttons, names (camera, lens, tags).',
    how: 'default',
  },
  {
    token: 'label',
    family: 'Geologica, uppercase',
    sample: {
      text: 'Capture',
      props: {
        fontFamily: 'label',
        textStyle: 'xs',
        fontWeight: 'bold',
        textTransform: 'uppercase',
        letterSpacing: 'wider',
      },
    },
    use: 'Small uppercase titles: module and panel block titles, tabs within a module.',
    how: 'fontFamily="label" textTransform="uppercase" letterSpacing="wider"',
  },
  {
    token: 'numeric',
    family: 'Lilex, tabular figures',
    sample: {
      text: '1/250 · ƒ/2.8 · 35 mm',
      props: { fontFamily: 'numeric', textStyle: 'xs', fontVariantNumeric: 'tabular-nums' },
    },
    use: 'Numbers and measurements: slider readouts, zoom, counts, dimensions and file sizes, exposure settings, dates, coordinates.',
    how: 'fontFamily="numeric" fontVariantNumeric="tabular-nums"',
  },
] as const;

/** Where each text style fits. */
const TEXT_STYLES = [
  { style: 'lg', use: 'Empty states, dialog leads.' },
  { style: 'md', use: 'Dialog body text.' },
  { style: 'sm', use: 'Toolbars, buttons, the file name in a panel.' },
  { style: 'xs', use: 'Panel content: field labels and values, lists, slider labels.' },
  { style: '2xs', use: 'Hints, notes, sub-titles within a block.' },
] as const;

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
function Panel({ children, w = '72', modules }: { children: React.ReactNode; w?: string; modules?: boolean }) {
  // The developer's module panel: modules are blocks of their own on the darker background.
  return (
    <Stack
      w={w}
      p={modules ? '0' : '3'}
      py={modules ? '1.5' : undefined}
      gap="2"
      bg={modules ? 'bg' : 'bg.panel'}
      borderWidth="1px"
      rounded="l2"
      overflow="hidden"
    >
      {children}
    </Stack>
  );
}

/** Sample items for the manager dialog. */
const MANAGED = [
  { id: 'a', name: 'Portra-ish', detail: '3 modules' },
  { id: 'b', name: 'Bleach bypass', detail: '1 module' },
  { id: 'c', name: 'Night street, cold shadows', detail: '5 modules' },
];

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
  useDocumentLook(mode);

  const [exposure, setExposure] = useState(0.7);
  const [hue, setHue] = useState(-12);
  const [contrast, setContrast] = useState(1);
  const [preset, setPreset] = useState(2);
  const [page, setPage] = useState<'scene' | 'look' | 'options'>('scene');
  const [enabled, setEnabled] = useState(true);
  const [range, setRange] = useState<'global' | 'shadows' | 'midtones' | 'highlights'>('shadows');
  const [blockOpen, setBlockOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [culling, setCulling] = useState<{ rating: number; flag: Flag | null; colorLabel: ColorLabel | null }>({
    rating: 3,
    flag: 'picked',
    colorLabel: 'blue',
  });
  const [managed, setManaged] = useState(MANAGED);
  const [managing, setManaging] = useState(false);
  const [tags, setTags] = useState(['beach', 'golden hour']);
  const [tagQuery, setTagQuery] = useState('ali');

  return (
    <Box h="full" overflowY="auto" bg="bg">
      <Box position="sticky" top="0" zIndex="sticky" bg="bg.panel" borderBottomWidth="1px">
        <Container maxW="6xl" py="3">
          <HStack justify="space-between" wrap="wrap" gap="3">
            <Heading size="md">🍗 UI</Heading>
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
        </Container>
      </Box>

      <Container maxW="6xl" pb="16">
        <Block
          title="Typography"
          guide="Two families in four roles (tokens in theme.ts): Geologica for text, Lilex for numbers. Panels mostly use the 2xs–sm text styles."
        >
          <Grid templateColumns="auto auto 1fr" columnGap="6" rowGap="3" alignItems="baseline">
            {FONT_ROLES.map((f) => (
              <Fragment key={f.token}>
                <Stack gap="0">
                  <Text textStyle="xs" fontFamily="mono">
                    {f.token}
                  </Text>
                  <Text textStyle="2xs" color="fg.subtle">
                    {f.family}
                  </Text>
                </Stack>
                <Text {...f.sample.props} whiteSpace="nowrap">
                  {f.sample.text}
                </Text>
                <Stack gap="0">
                  <Text textStyle="xs" color="fg.muted">
                    {f.use}
                  </Text>
                  <Text textStyle="2xs" color="fg.subtle" fontFamily="mono">
                    {f.how}
                  </Text>
                </Stack>
              </Fragment>
            ))}
          </Grid>
          <Separator />
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
            {TEXT_STYLES.map(({ style, use }) => (
              <HStack key={style} gap="4" align="baseline">
                <Text w="10" textStyle="2xs" color="fg.subtle" fontFamily="mono" flexShrink={0}>
                  {style}
                </Text>
                <Text textStyle={style} flex="1">
                  {SAMPLE}
                </Text>
                <Text textStyle="2xs" color="fg.subtle" w="64" flexShrink={0}>
                  {use}
                </Text>
              </HStack>
            ))}
          </Stack>
          <Separator />
          <Grid templateColumns="repeat(auto-fill, minmax(16rem, 1fr))" gap="6">
            <Example label="Block title (label, uppercase)">
              <Heading size="xs" fontFamily="label" textTransform="uppercase" letterSpacing="wider" color="fg.muted">
                Colour label
              </Heading>
            </Example>
            <Example label="Muted / subtle text">
              <Text textStyle="xs" color="fg.muted">
                Metadata edits are stored in your library.
              </Text>
              <Text textStyle="xs" color="fg.subtle">
                Nothing yet
              </Text>
            </Example>
            <Example label="Values (numeric: readouts, counts, measurements)">
              <Text textStyle="xs" fontFamily="numeric" fontVariantNumeric="tabular-nums">
                +0.70 EV · −12.0° · 4538 K · 100 % · 0.015 %
              </Text>
              <Text textStyle="xs" fontFamily="numeric" fontVariantNumeric="tabular-nums" color="fg.muted">
                6000 × 4000 · 23.8 MB · 1/250 · ƒ/2.8 · ISO 400
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
          guide="One style: small uppercase titles on blocks a shade lighter than the panel. The developer's modules (orange when modified, with switch and reset) and the library's panel blocks (with actions, optionally foldable)."
        >
          <Grid templateColumns="repeat(auto-fill, minmax(18rem, 1fr))" gap="8">
            <Example label="Library panel blocks">
              <Panel w="64" modules>
                <PanelBlock
                  title="Capture"
                  actions={
                    <Button size="2xs" variant="ghost" color="fg.muted">
                      Unlock
                    </Button>
                  }
                >
                  <Text textStyle="xs" color="fg.muted">
                    Content
                  </Text>
                </PanelBlock>
                <PanelBlock title="Description" open={blockOpen} onOpenChange={setBlockOpen}>
                  <Text textStyle="xs" color="fg.muted">
                    Folded content
                  </Text>
                </PanelBlock>
              </Panel>
            </Example>
            <Example label="Module">
              <Panel w="80" modules>
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
            <Example label="Tag search (tag manager, filters)">
              <TagSearch size="xs" value={tagQuery} onChange={setTagQuery} />
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
            <Example label="Work in progress, with an info tip (raw denoise)">
              <Stack gap="1" textStyle="xs" color="fg.muted">
                <HStack gap="1.5">
                  <Spinner size="xs" color="fg.subtle" />
                  <Text>Denoising… 12 / 77</Text>
                  <InfoTip label="About denoising">
                    The image is shown without denoising until it&apos;s done. Keep editing the rest of the picture
                    meanwhile.
                  </InfoTip>
                </HStack>
                <Progress.Root value={16} size="xs" colorPalette="orange">
                  <Progress.Track>
                    <Progress.Range />
                  </Progress.Track>
                </Progress.Root>
              </Stack>
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
          title="Managing a list"
          guide="The user's own LUTs, module presets and styles: “Manage…” at the bottom of their menu opens this dialog. Rename in place (pencil or double-click; Enter saves, Escape cancels), delete with a second click."
        >
          <Button size="xs" variant="outline" alignSelf="start" onClick={() => setManaging(true)}>
            <Pencil /> Manage styles…
          </Button>
          {managing && (
            <ManagerDialog
              title="Styles"
              description="Rename or delete your styles."
              items={managed}
              onRename={async (item, name) => {
                if (managed.some((m) => m.id !== item.id && m.name.toLowerCase() === name.toLowerCase()))
                  throw new Error(`There is already a style named “${name}”`);
                setManaged((list) => list.map((m) => (m.id === item.id ? { ...m, name } : m)));
              }}
              onDelete={(item) => setManaged((list) => list.filter((m) => m.id !== item.id))}
              onClose={() => setManaging(false)}
            />
          )}
        </Block>

        <Block
          title="Culling"
          guide="Rating, flag and colour label, as in the library's info panel (shortcuts 0–5, P/X/U, 6–9)."
        >
          <Panel w="80">
            <Culling {...culling} onChange={(patch) => setCulling((c) => ({ ...c, ...patch }))} />
          </Panel>
        </Block>

        <Block
          title="Phones"
          guide="Below md (768 px, `useNarrow`), the library's side panels open as drawers (`PanelDrawer`: filters from the start, the info panel as a sheet from the bottom), a tap opens the loupe and a long press selects. While photos are selected, the selection bar replaces the status bar. Touch targets grow to sm there (`size={{ base: 'sm', md: '2xs' }}`)."
        >
          <HStack gap="6" align="start" wrap="wrap">
            <Box w="96" maxW="full" borderWidth="1px" rounded="l2" overflow="hidden">
              <SelectionBar
                selected={3}
                total={42}
                onSelectAll={() => {}}
                onDetails={() => setSheetOpen(true)}
                onDone={() => {}}
              />
            </Box>
            <Button size="sm" variant="outline" onClick={() => setSheetOpen(true)}>
              Open a panel as a sheet
            </Button>
          </HStack>
          <PanelDrawer narrow open={sheetOpen} onClose={() => setSheetOpen(false)} placement="bottom" title="Details">
            <Stack as="aside" gap="1.5" py="1.5" bg="bg">
              <PanelBlock title="3 photos selected">
                <Culling {...culling} onChange={(patch) => setCulling((c) => ({ ...c, ...patch }))} />
              </PanelBlock>
            </Stack>
          </PanelDrawer>
        </Block>

        <Block
          title="Storage"
          guide="Original files against the quota, in the app menu and on the admin page. Red from 90 %; unlimited has no bar."
        >
          <HStack gap="8" align="start">
            <StorageMeter usage={{ used: 12.3 * 1024 ** 3, quota: 50 * 1024 ** 3 }} />
            <StorageMeter usage={{ used: 47.5 * 1024 ** 3, quota: 50 * 1024 ** 3 }} />
            <StorageMeter usage={{ used: 312 * 1024 ** 3, quota: null }} />
          </HStack>
        </Block>

        <Block
          title="Storage breakdown"
          guide="On the settings page: the library and the trash against the quota (or splitting what's stored, when unlimited)."
        >
          <HStack gap="8" align="start">
            <Box w="64">
              <StorageBreakdown usage={{ used: 32.4 * 1024 ** 3, trash: 6.1 * 1024 ** 3, quota: 50 * 1024 ** 3 }} />
            </Box>
            <Box w="64">
              <StorageBreakdown usage={{ used: 46.2 * 1024 ** 3, trash: 1.2 * 1024 ** 3, quota: 50 * 1024 ** 3 }} />
            </Box>
            <Box w="64">
              <StorageBreakdown usage={{ used: 312 * 1024 ** 3, trash: 40 * 1024 ** 3, quota: null }} />
            </Box>
          </HStack>
        </Block>

        <Block
          title="Import"
          guide="An import interrupted (a reload, the browser closed) is offered again: resumed where the browser kept the files, else picked again. Every import is reviewed first (a dialog: what's new, what the library has already, found by name, size and date). Then the toast shows its progress (bytes), and the outcome until it's closed: what to retry, what to upload anyway."
        >
          <Stack gap="6">
            <HStack gap="4" align="start" wrap="wrap">
              {IMPORT_REVIEWS.map(([label, review]) => (
                <Example key={label} label={label} w="80">
                  <Box p="4" borderWidth="1px" borderRadius="l2" bg="bg.panel" boxShadow="lg">
                    <ReviewBody review={review} />
                  </Box>
                </Example>
              ))}
            </HStack>
            <HStack gap="4" align="start" wrap="wrap">
              {INTERRUPTED.map(([label, run]) => (
                <Example key={label} label={label} w="96">
                  <Box p="4" borderWidth="1px" borderRadius="l2" bg="bg.panel" boxShadow="lg">
                    <InterruptedImport run={run} pending={120} onResume={() => {}} onDiscard={() => {}} />
                  </Box>
                </Example>
              ))}
            </HStack>
            <HStack gap="4" align="start" wrap="wrap">
              {IMPORT_TOASTS.map(([label, run]) => (
                <Example key={label} label={label} w="96">
                  <Box p="4" borderWidth="1px" borderRadius="l2" bg="bg.panel" boxShadow="lg">
                    <ImportSummary
                      run={run}
                      onShow={() => {}}
                      onRetry={() => {}}
                      onUploadDeleted={() => {}}
                      onClose={() => {}}
                    />
                  </Box>
                </Example>
              ))}
            </HStack>
          </Stack>
        </Block>

        <Block
          title="Sending to another instance"
          guide="The server sends; the toast follows it (polled), then stays with the outcome: what's new there, updated or already up to date, what failed (Retry), and a link to see it there as one import."
        >
          <HStack gap="4" align="start" wrap="wrap">
            {TRANSFER_TOASTS.map(([label, transfer]) => (
              <Example key={label} label={label} w="96">
                <Box p="4" borderWidth="1px" borderRadius="l2" bg="bg.panel" boxShadow="lg">
                  <TransferSummary transfer={transfer} onRetry={() => {}} onCancel={() => {}} onClose={() => {}} />
                </Box>
              </Example>
            ))}
          </HStack>
        </Block>
      </Container>
    </Box>
  );
}

const TRANSFER: Transfer = {
  id: 'sample',
  url: 'https://photos.example.com',
  everything: false,
  status: 'running',
  error: null,
  total: 87,
  created: 20,
  updated: 3,
  unchanged: 11,
  failed: 0,
  waiting: 53,
  extrasSent: 0,
  failures: [],
};
const TRANSFER_TOASTS = [
  ['Sending', TRANSFER],
  ['Sent', { ...TRANSFER, status: 'done', created: 70, updated: 6, unchanged: 11, waiting: 0, extrasSent: 14 }],
  [
    'Sent, with failures',
    {
      ...TRANSFER,
      status: 'done',
      created: 70,
      updated: 6,
      unchanged: 9,
      failed: 2,
      waiting: 0,
      failures: [
        { versionId: 'a', filename: 'DSC04411.ARW', error: 'Not enough storage: 49.8 GB of 50 GB used' },
        { versionId: 'b', filename: 'DSC04412.ARW', error: 'Couldn’t reach https://photos.example.com' },
      ],
    },
  ],
  [
    'Failed',
    {
      ...TRANSFER,
      status: 'failed',
      error: 'The other instance refused the token (revoked?)',
      created: 0,
      updated: 0,
      unchanged: 0,
      waiting: 87,
    },
  ],
] as [string, Transfer][];

const IMPORT_REVIEWS: [string, Review][] = [
  ['Review: looking through', { phase: 'scanning', label: 'DCIM', progress: { step: 'listing', found: 2140 } }],
  ['Review: reading tags', { phase: 'scanning', label: null, progress: { step: 'reading', done: 1873, total: 5936 } }],
  ['Review: a card', sampleReview(412, 380, 415)],
  ['Review: RAW + JPEG', sampleReview(212, 0, 3, 212)],
  ['Review: nothing new', sampleReview(24, 24, 0)],
];

const INTERRUPTED: [string, ImportRun][] = [
  [
    'Interrupted (Chrome, Edge: files kept)',
    { ...sampleRun([], false), label: 'DCIM', from: { kind: 'folder', handles: [] } },
  ],
  ['Interrupted (other browsers)', { ...sampleRun([], false), label: 'DCIM', from: { kind: 'folder', handles: null } }],
];

const IMPORT_TOASTS = [
  [
    'Importing',
    sampleRun(
      [
        ...Array(30).fill({ status: 'imported' }),
        { status: 'skipped', kind: 'duplicate', reason: 'Already in your library as DSC01003.ARW' },
        { status: 'uploading', sent: 12e6 },
        ...Array(55).fill({}),
      ],
      false,
    ),
  ],
  ['Done', sampleRun(Array(87).fill({ status: 'imported' }), true)],
  [
    'Done, with problems',
    sampleRun(
      [
        ...Array(80).fill({ status: 'imported' }),
        ...Array(3).fill({ status: 'skipped', kind: 'duplicate', reason: 'Already in your library as DSC00412.ARW' }),
        { status: 'skipped', kind: 'deleted', reason: 'You deleted this file before' },
        { status: 'failed', reason: 'Upload failed: the connection was lost' },
        { status: 'skipped', kind: 'unsupported', reason: 'Not a RAW file or an image we read' },
        { status: 'skipped', kind: 'quota', reason: 'Not enough storage: 49.8 GB of 50 GB used' },
      ],
      true,
    ),
  ],
] as const;
