import {
  Badge,
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Circle,
  HStack,
  IconButton,
  Input,
  SegmentGroup,
  Stack,
  Text,
} from '@chakra-ui/react';
import { Check, ChevronDown, ChevronRight, Star, X } from 'lucide-react';
import { type MouseEvent, memo, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useFacets } from '../api/hooks.ts';
import { COLOR_LABELS, type FacetValue, type ImportFacet } from '../api/types.ts';
import { TagSearch } from '../components/TagSearch.tsx';
import { formatAgo, formatDateTime } from '../lib/format.ts';
import { type TagNode, displayTag, filterTagTree, isUnder, tagTree } from '../lib/tags.ts';
import { TAG_MANAGER_PATH } from '../lib/tagManager.ts';
import { FilterPresetMenu } from './FilterPresetMenu.tsx';
import { BLOCKS_PROPS, PanelBlock } from './PanelBlock.tsx';
import {
  TOP_LEVEL,
  clickStar,
  cycleTag,
  isAny,
  ratingSet,
  setUntagged,
  tagGroups,
  tagState,
  toggleAny,
} from './tagFilter.ts';
import type { LibrarySearch } from './useLibrarySearch.ts';

function FacetList({ name, values, search }: { name: string; values: FacetValue[]; search: LibrarySearch }) {
  const selected = search.params.getAll(name);
  // Keep selected values visible even if the other filters leave no match.
  const all = [
    ...values,
    ...selected.filter((s) => !values.some((v) => v.value === s)).map((value) => ({ value, count: 0 })),
  ];
  if (!all.length)
    return (
      <Text textStyle="xs" color="fg.subtle">
        Nothing yet
      </Text>
    );
  return (
    <Stack gap="1" maxH="40" overflowY="auto">
      {all.map(({ value, count }) => (
        <Checkbox.Root
          key={value}
          size="xs"
          checked={selected.includes(value)}
          onCheckedChange={() => search.toggle(name, value)}
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label flex="1" truncate title={value} textStyle="xs">
            {value}
          </Checkbox.Label>
          <Text textStyle="xs" color="fg.muted" {...NUMERIC}>
            {count}
          </Text>
        </Checkbox.Root>
      ))}
    </Stack>
  );
}

/**
 * The tags as a tree: a click on a tag shows the photos with it or one under it
 * (`People`: all of People's), again those without it, again all. Picked tags with the
 * same parent go together: all of them, or any (the switch on the parent, or above the
 * tree for top-level tags); different parents' must all match. An excluded tag leaves
 * out photos with it, except for the picked tags under it (`People › Alice` picked and
 * `People` excluded: Alice and nobody else). Folded below the top, except where a tag is
 * picked or excluded, and while searching: then it shows the tags found and the way to
 * them. "No tags" picks the photos without any, and can't go with a picked tag (nothing
 * would match): picking one unpicks the other.
 */
function TagTree({ values, untagged, search }: { values: FacetValue[]; untagged: number; search: LibrarySearch }) {
  const p = search.params;
  const picked = p.getAll('tag');
  const excluded = p.getAll('notTag');
  const used = [...picked, ...excluded];
  const groups = tagGroups(p);
  const noTags = p.get('untagged') === 'true';
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  // Tags in the filters stay listed even when the other filters leave no photo with them.
  const tree = tagTree([
    ...values,
    ...used.filter((s) => !values.some((v) => v.value === s)).map((value) => ({ value, count: 0 })),
  ]);
  if (!tree.length && !noTags)
    return (
      <Text textStyle="xs" color="fg.subtle">
        Nothing yet
      </Text>
    );
  const toggle = (path: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  /** All or any of a group's picked tags, when it has several. */
  const groupSwitch = (group: string) =>
    (groups.get(group)?.length ?? 0) > 1 && (
      <AnySwitch any={isAny(p, group)} onToggle={() => search.edit((next) => toggleAny(next, group))} />
    );
  const rows = (nodes: TagNode[], depth: number): React.ReactNode[] =>
    nodes.flatMap((n) => {
      // Open by the user, holding a tag in the filters, or searched.
      const unfolded = searching || open.has(n.path) || used.some((s) => s !== n.path && isUnder(s, n.path));
      const state = tagState(p, n.path);
      return [
        <HStack key={n.path} gap="1" ps={`${depth * 14}px`} data-tag={n.path} data-state={state ?? undefined}>
          {n.children.length ? (
            <IconButton
              size="2xs"
              variant="ghost"
              minW="4"
              h="4"
              aria-label={unfolded ? `Fold ${n.name}` : `Unfold ${n.name}`}
              disabled={searching}
              onClick={() => toggle(n.path)}
            >
              {unfolded ? <ChevronDown /> : <ChevronRight />}
            </IconButton>
          ) : (
            <Box w="4" flexShrink={0} />
          )}
          <Checkbox.Root
            size="xs"
            flex="1"
            minW="0"
            colorPalette={state === 'exclude' ? 'red' : undefined}
            checked={state === 'include' ? true : state === 'exclude' ? 'indeterminate' : false}
            title={
              state === 'include'
                ? `With ${displayTag(n.path)}: click for the photos without it`
                : state === 'exclude'
                  ? `Without ${displayTag(n.path)}: click to stop filtering by it`
                  : `${displayTag(n.path)}: click for the photos with it, twice for those without`
            }
            onCheckedChange={() => search.edit((next) => cycleTag(next, n.path))}
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label
              flex="1"
              truncate
              textStyle="xs"
              textDecoration={state === 'exclude' ? 'line-through' : undefined}
              color={state === 'exclude' ? 'fg.muted' : undefined}
            >
              {n.name}
            </Checkbox.Label>
            <Text textStyle="xs" color="fg.muted" {...NUMERIC}>
              {n.count}
            </Text>
          </Checkbox.Root>
          {groupSwitch(n.path)}
        </HStack>,
        ...(unfolded ? rows(n.children, depth + 1) : []),
      ];
    });
  const found = filterTagTree(tree, query);
  return (
    <Stack gap="2">
      <TagSearch size="xs" value={query} onChange={setQuery} />
      {!searching && (
        <Checkbox.Root
          size="xs"
          ps="5"
          checked={noTags}
          onCheckedChange={() => search.edit((next) => setUntagged(next, !noTags))}
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label flex="1" textStyle="xs" fontStyle="italic">
            No tags
          </Checkbox.Label>
          <Text textStyle="xs" color="fg.muted" {...NUMERIC}>
            {untagged}
          </Text>
        </Checkbox.Root>
      )}
      {groupSwitch(TOP_LEVEL) && (
        <HStack ps="5" justify="space-between">
          <Text textStyle="xs" color="fg.muted">
            Top-level tags
          </Text>
          {groupSwitch(TOP_LEVEL)}
        </HStack>
      )}
      {found.length ? (
        <Stack gap="1" maxH="60" overflowY="auto">
          {rows(found, 0)}
        </Stack>
      ) : (
        <Text textStyle="xs" color="fg.subtle">
          No tag matches
        </Text>
      )}
    </Stack>
  );
}

/** A group's picked tags: all of them, or any. */
function AnySwitch({ any, onToggle }: { any: boolean; onToggle: () => void }) {
  return (
    <Button
      size="2xs"
      variant="outline"
      h="4"
      minW="8"
      px="1"
      textStyle="label"
      flexShrink={0}
      title={
        any
          ? 'Photos with any of the tags picked under it: click for all of them'
          : 'Photos with all of the tags picked under it: click for any of them'
      }
      onClick={onToggle}
    >
      {any ? 'any' : 'all'}
    </Button>
  );
}

/** Recent imports shown before "Show more". */
const IMPORTS_SHOWN = 5;

/**
 * The imports, newest first, to show some of them (the files an upload or a transfer
 * brought). A click shows one (again: the whole library), Ctrl/⌘-click adds or removes
 * one, Shift-click shows those between the last one clicked and this one (an import
 * that went in several goes).
 */
function ImportList({ imports, search }: { imports: ImportFacet[]; search: LibrarySearch }) {
  const selected = search.params.getAll('import');
  const [more, setMore] = useState(false);
  const anchor = useRef<string | null>(null);
  // The ones shown stay listed, even when they aren't among them (still starting, or old).
  const missing = selected.filter((id) => !imports.some((i) => i.value === id));
  const all = [...missing.map((value) => ({ value, count: 0, importedAt: null, source: null })), ...imports];
  if (!all.length)
    return (
      <Text textStyle="xs" color="fg.subtle">
        Nothing yet
      </Text>
    );
  const shown = more ? all : all.filter((i, n) => n < IMPORTS_SHOWN || selected.includes(i.value));
  const pick = (e: MouseEvent, id: string) => {
    const from = all.findIndex((i) => i.value === (anchor.current ?? selected[0]));
    if (e.shiftKey && from >= 0) {
      const to = all.findIndex((i) => i.value === id);
      const [a, b] = from < to ? [from, to] : [to, from];
      search.setAll(
        'import',
        all.slice(a, b + 1).map((i) => i.value),
      );
      return;
    }
    anchor.current = id;
    if (e.ctrlKey || e.metaKey) search.toggle('import', id);
    else search.setAll('import', selected.length === 1 && selected[0] === id ? [] : [id]);
  };
  return (
    <Stack gap="0.5">
      {shown.map((i) => {
        const active = selected.includes(i.value);
        return (
          <HStack
            as="button"
            key={i.value}
            aria-pressed={active}
            data-import={i.value}
            onClick={(e) => pick(e, i.value)}
            // Shift-click selects a range, not the text.
            onMouseDown={(e) => e.shiftKey && e.preventDefault()}
            title={i.importedAt ? `Imported ${formatDateTime(i.importedAt)}` : undefined}
            justify="space-between"
            gap="2"
            px="2"
            py="1"
            mx="-2"
            borderRadius="sm"
            textAlign="start"
            textStyle="xs"
            bg={active ? 'bg.emphasized' : undefined}
            _hover={{ bg: active ? 'bg.emphasized' : 'bg.muted' }}
            focusRing="outside"
          >
            <Stack gap="0" minW="0">
              <Text truncate fontWeight={active ? 'semibold' : undefined}>
                {i.importedAt ? formatAgo(i.importedAt) : 'This import'}
              </Text>
              {i.source && (
                <Text truncate color="fg.muted">
                  from {i.source}
                </Text>
              )}
            </Stack>
            <Text color="fg.muted" {...NUMERIC}>
              {i.count || ''}
            </Text>
          </HStack>
        );
      })}
      {all.length > IMPORTS_SHOWN && (
        <Button size="2xs" variant="ghost" color="fg.muted" alignSelf="start" px="1" onClick={() => setMore((m) => !m)}>
          {more ? 'Show fewer' : `Show ${all.length - IMPORTS_SHOWN} more`}
        </Button>
      )}
    </Stack>
  );
}

function RangeInputs({
  search,
  min,
  max,
  placeholder,
}: {
  search: LibrarySearch;
  min: string;
  max: string;
  placeholder: [unknown, unknown];
}) {
  return (
    <HStack gap="1.5" flex="1">
      <Input
        size="xs"
        type="number"
        {...NUMERIC}
        placeholder={placeholder[0] != null ? String(placeholder[0]) : 'min'}
        value={search.params.get(min) ?? ''}
        onChange={(e) => search.set(min, e.target.value)}
      />
      <Text color="fg.muted">–</Text>
      <Input
        size="xs"
        type="number"
        {...NUMERIC}
        placeholder={placeholder[1] != null ? String(placeholder[1]) : 'max'}
        value={search.params.get(max) ?? ''}
        onChange={(e) => search.set(max, e.target.value)}
      />
    </HStack>
  );
}

/** Counts, dates and measurements: the numeric font. */
const NUMERIC = { fontFamily: 'numeric', fontVariantNumeric: 'tabular-nums' } as const;

export const LABEL_COLORS: Record<string, string> = {
  red: 'red.500',
  yellow: 'yellow.400',
  green: 'green.500',
  blue: 'blue.500',
  purple: 'purple.500',
};

/** The camera and capture settings filters, folded away by default. */
const TECHNICAL_FILTERS = ['camera', 'lens', 'isoMin', 'isoMax', 'focalMin', 'focalMax', 'apertureMin', 'apertureMax'];
const TECHNICAL_OPEN_KEY = 'library.filters.technicalOpen';
const IMPORTS_OPEN_KEY = 'library.filters.importsOpen';

/** The flags shown: any combination, none set meaning all of them. */
const FLAG_FILTERS = [
  { value: 'picked', label: 'Picks', icon: <Check /> },
  { value: 'unflagged', label: 'Unflagged', icon: null },
  { value: 'rejected', label: 'Rejects', icon: <X /> },
] as const;

function FlagFilter({ search }: { search: LibrarySearch }) {
  // Older links' "no rejects".
  const shown = search.params.getAll('flag').flatMap((f) => (f === 'notRejected' ? ['picked', 'unflagged'] : [f]));
  const toggle = (value: string) => {
    const next = shown.includes(value) ? shown.filter((f) => f !== value) : [...shown, value];
    search.setAll('flag', next.length === FLAG_FILTERS.length ? [] : next);
  };
  return (
    <ButtonGroup size={{ base: 'sm', md: 'xs' }} variant="outline" attached w="full">
      {FLAG_FILTERS.map((f) => {
        const on = shown.includes(f.value);
        return (
          <Button
            key={f.value}
            flex="1"
            px="1"
            variant={on ? 'subtle' : 'outline'}
            colorPalette={on ? 'orange' : 'gray'}
            aria-pressed={on}
            title={on ? `Hide ${f.label.toLowerCase()}` : `Show ${f.label.toLowerCase()}`}
            onClick={() => toggle(f.value)}
          >
            {f.icon} {f.label}
          </Button>
        );
      })}
    </ButtonGroup>
  );
}

/** A label left of its control, as the developer's rows. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <HStack gap="2">
      <Text textStyle="xs" color="fg.muted" w="16" flexShrink={0}>
        {label}
      </Text>
      {children}
    </HStack>
  );
}

/** A small title over a list within a block. */
function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text textStyle="2xs" fontWeight="medium" color="fg.muted" pt="1">
      {children}
    </Text>
  );
}

export const FilterSidebar = memo(function FilterSidebar({ search }: { search: LibrarySearch }) {
  const { data: facets } = useFacets(search.search);
  const p = search.params;
  const technicalFilters = TECHNICAL_FILTERS.filter((k) => p.has(k)).length;
  // Open when it was left open, or when one of its filters is set (a shared link).
  const [technicalOpen, setTechnicalOpen] = useState(
    () => localStorage.getItem(TECHNICAL_OPEN_KEY) === '1' || technicalFilters > 0,
  );
  useEffect(() => localStorage.setItem(TECHNICAL_OPEN_KEY, technicalOpen ? '1' : '0'), [technicalOpen]);
  // Open when it was left open; showing an import opens it too.
  const [importsOpen, setImportsOpen] = useState(() => localStorage.getItem(IMPORTS_OPEN_KEY) === '1');
  useEffect(() => localStorage.setItem(IMPORTS_OPEN_KEY, importsOpen ? '1' : '0'), [importsOpen]);
  const shownImports = p.getAll('import').length;
  useEffect(() => {
    if (shownImports) setImportsOpen(true);
  }, [shownImports]);
  const stars = ratingSet(p);
  // The last star clicked: where a Shift-click's range starts.
  const ratingAnchor = useRef<number | null>(null);
  const onStar = (n: number, mods: { toggle: boolean; range: boolean }) => {
    search.edit((next) => clickStar(next, n, mods, ratingAnchor.current));
    if (!mods.range) ratingAnchor.current = n;
  };
  const r = facets?.ranges;

  return (
    <Stack as="aside" {...BLOCKS_PROPS} w="64" flexShrink={0} borderRightWidth="1px">
      <PanelBlock
        title="Filters"
        badge={
          search.activeFilterCount > 0 && (
            <Badge size="xs" {...NUMERIC}>
              {search.activeFilterCount}
            </Badge>
          )
        }
        actions={
          <HStack gap="0.5">
            {search.activeFilterCount > 0 && (
              <Button size="2xs" variant="ghost" onClick={search.clear}>
                Clear all
              </Button>
            )}
            <FilterPresetMenu search={search} />
          </HStack>
        }
      >
        <HStack justify="space-between" rowGap="2" wrap="wrap">
          <HStack gap="0">
            {[1, 2, 3, 4, 5].map((n) => (
              <IconButton
                key={n}
                aria-label={`${n} stars`}
                aria-pressed={stars.includes(n)}
                title={`${n} stars and up · Ctrl/⌘: ${n} stars in or out · Shift: a range`}
                size={{ base: 'sm', md: '2xs' }}
                variant="ghost"
                color={stars.includes(n) ? 'orange.fg' : 'fg.subtle'}
                onClick={(e) => onStar(n, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })}
                // The same from the keyboard: Enter or Space, with Ctrl/⌘ or Shift.
                onKeyDown={(e) => {
                  if ((e.key !== 'Enter' && e.key !== ' ') || !(e.ctrlKey || e.metaKey || e.shiftKey)) return;
                  e.preventDefault();
                  onStar(n, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
                }}
              >
                <Star fill={stars.includes(n) ? 'currentColor' : 'none'} />
              </IconButton>
            ))}
          </HStack>
          <HStack gap={{ base: '3', md: '1.5' }}>
            {COLOR_LABELS.map((c) => {
              const active = p.getAll('colorLabel').includes(c);
              return (
                <Circle
                  key={c}
                  as="button"
                  size={{ base: '6', md: '4' }}
                  bg={LABEL_COLORS[c]}
                  opacity={active ? 1 : 0.35}
                  outline={active ? '2px solid' : 'none'}
                  outlineColor="fg"
                  outlineOffset="1px"
                  aria-label={`${c} label`}
                  aria-pressed={active}
                  onClick={() => search.toggle('colorLabel', c)}
                />
              );
            })}
          </HStack>
        </HStack>
        <FlagFilter search={search} />
        <Row label="Edited">
          <SegmentGroup.Root
            size="xs"
            flex="1"
            value={p.get('edited') ?? 'any'}
            onValueChange={(e) => search.set('edited', e.value === 'any' ? null : e.value)}
          >
            <SegmentGroup.Indicator />
            <SegmentGroup.Items
              flex="1"
              items={[
                { value: 'any', label: 'Any' },
                { value: 'true', label: 'Yes' },
                { value: 'false', label: 'No' },
              ]}
            />
          </SegmentGroup.Root>
        </Row>
      </PanelBlock>

      <PanelBlock title="Date taken">
        <Row label="From">
          <Input
            size="xs"
            type="date"
            {...NUMERIC}
            value={p.get('from') ?? ''}
            onChange={(e) => search.set('from', e.target.value)}
          />
        </Row>
        <Row label="To">
          <Input
            size="xs"
            type="date"
            {...NUMERIC}
            value={p.get('to')?.slice(0, 10) ?? ''}
            onChange={(e) => search.set('to', e.target.value && `${e.target.value}T23:59:59`)}
          />
        </Row>
      </PanelBlock>

      <PanelBlock
        title="Tags"
        actions={
          <Button asChild size="2xs" variant="ghost" color="fg.muted">
            <Link to={TAG_MANAGER_PATH}>Manage</Link>
          </Button>
        }
      >
        <TagTree values={facets?.tags ?? []} untagged={facets?.ranges.untagged ?? 0} search={search} />
      </PanelBlock>

      <PanelBlock
        title="Recent imports"
        badge={
          shownImports > 0 && (
            <Badge size="xs" {...NUMERIC}>
              {shownImports}
            </Badge>
          )
        }
        open={importsOpen}
        onOpenChange={setImportsOpen}
      >
        <ImportList imports={facets?.imports ?? []} search={search} />
      </PanelBlock>

      <PanelBlock
        title="Technical"
        badge={
          technicalFilters > 0 && (
            <Badge size="xs" {...NUMERIC}>
              {technicalFilters}
            </Badge>
          )
        }
        open={technicalOpen}
        onOpenChange={setTechnicalOpen}
      >
        <SubTitle>Camera</SubTitle>
        <FacetList name="camera" values={facets?.cameras ?? []} search={search} />
        <SubTitle>Lens</SubTitle>
        <FacetList name="lens" values={facets?.lenses ?? []} search={search} />
        <Box h="1" />
        <Row label="ISO">
          <RangeInputs search={search} min="isoMin" max="isoMax" placeholder={[r?.isoMin, r?.isoMax]} />
        </Row>
        <Row label="Focal (mm)">
          <RangeInputs search={search} min="focalMin" max="focalMax" placeholder={[r?.focalMin, r?.focalMax]} />
        </Row>
        <Row label="Aperture">
          <RangeInputs
            search={search}
            min="apertureMin"
            max="apertureMax"
            placeholder={[r?.apertureMin, r?.apertureMax]}
          />
        </Row>
      </PanelBlock>
    </Stack>
  );
});
