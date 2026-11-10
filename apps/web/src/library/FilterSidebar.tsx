import {
  Badge,
  Box,
  Button,
  Checkbox,
  Circle,
  Collapsible,
  Flex,
  HStack,
  Heading,
  IconButton,
  Input,
  SegmentGroup,
  Stack,
  Text,
} from '@chakra-ui/react';
import { ChevronDown, Star, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useFacets } from '../api/hooks.ts';
import { COLOR_LABELS, type FacetValue } from '../api/types.ts';
import type { LibrarySearch } from './useLibrarySearch.ts';

function Section({ title, children, onClear }: { title: string; children: React.ReactNode; onClear?: () => void }) {
  return (
    <Stack gap="2">
      <HStack justify="space-between" minH="6">
        <Heading size="xs" textTransform="uppercase" letterSpacing="wider" color="fg.muted">
          {title}
        </Heading>
        {onClear && (
          <IconButton aria-label={`Clear ${title}`} size="2xs" variant="ghost" onClick={onClear}>
            <X />
          </IconButton>
        )}
      </HStack>
      {children}
    </Stack>
  );
}

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
    <Stack gap="1" maxH="48" overflowY="auto">
      {all.map(({ value, count }) => (
        <Checkbox.Root
          key={value}
          size="sm"
          checked={selected.includes(value)}
          onCheckedChange={() => search.toggle(name, value)}
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label flex="1" truncate title={value}>
            {value}
          </Checkbox.Label>
          <Text textStyle="xs" color="fg.muted">
            {count}
          </Text>
        </Checkbox.Root>
      ))}
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
    <HStack>
      <Input
        size="xs"
        type="number"
        placeholder={placeholder[0] != null ? String(placeholder[0]) : 'min'}
        value={search.params.get(min) ?? ''}
        onChange={(e) => search.set(min, e.target.value)}
      />
      <Text color="fg.muted">–</Text>
      <Input
        size="xs"
        type="number"
        placeholder={placeholder[1] != null ? String(placeholder[1]) : 'max'}
        value={search.params.get(max) ?? ''}
        onChange={(e) => search.set(max, e.target.value)}
      />
    </HStack>
  );
}

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

export function FilterSidebar({ search }: { search: LibrarySearch }) {
  const { data: facets } = useFacets(search.search);
  const p = search.params;
  const technicalFilters = TECHNICAL_FILTERS.filter((k) => p.has(k)).length;
  // Open when it was left open, or when one of its filters is set (a shared link).
  const [technicalOpen, setTechnicalOpen] = useState(
    () => localStorage.getItem(TECHNICAL_OPEN_KEY) === '1' || technicalFilters > 0,
  );
  useEffect(() => localStorage.setItem(TECHNICAL_OPEN_KEY, technicalOpen ? '1' : '0'), [technicalOpen]);
  const ratingMin = Number(p.get('ratingMin') ?? 0);
  const r = facets?.ranges;

  return (
    <Stack as="aside" gap="5" p="4" w="64" flexShrink={0} borderRightWidth="1px" bg="bg.panel" overflowY="auto">
      <HStack justify="space-between">
        <Heading size="sm">Filters</Heading>
        {search.activeFilterCount > 0 && (
          <Button size="2xs" variant="ghost" onClick={search.clear}>
            Clear all <Badge size="xs">{search.activeFilterCount}</Badge>
          </Button>
        )}
      </HStack>

      <Section title="Flag">
        <SegmentGroup.Root
          size="xs"
          value={p.get('flag') ?? 'all'}
          onValueChange={(e) => search.set('flag', e.value === 'all' ? null : e.value)}
        >
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
      </Section>

      <Section title="Rating" onClear={ratingMin ? () => search.set('ratingMin', null) : undefined}>
        <HStack gap="0.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <IconButton
              key={n}
              aria-label={`At least ${n} stars`}
              size="xs"
              variant="ghost"
              color={n <= ratingMin ? 'orange.fg' : 'fg.subtle'}
              onClick={() => search.set('ratingMin', n === ratingMin ? null : String(n))}
            >
              <Star fill={n <= ratingMin ? 'currentColor' : 'none'} />
            </IconButton>
          ))}
          <Text textStyle="xs" color="fg.muted" ms="1">
            {ratingMin ? 'and up' : 'any'}
          </Text>
        </HStack>
      </Section>

      <Section title="Colour label">
        <HStack>
          {COLOR_LABELS.map((c) => {
            const active = p.getAll('colorLabel').includes(c);
            return (
              <Circle
                key={c}
                as="button"
                size="5"
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
      </Section>

      <Section title="Tags">
        <FacetList name="tag" values={facets?.tags ?? []} search={search} />
      </Section>

      <Section title="Edited">
        <SegmentGroup.Root
          size="xs"
          value={p.get('edited') ?? 'any'}
          onValueChange={(e) => search.set('edited', e.value === 'any' ? null : e.value)}
        >
          <SegmentGroup.Indicator />
          <SegmentGroup.Items
            items={[
              { value: 'any', label: 'Any' },
              { value: 'true', label: 'Edited' },
              { value: 'false', label: 'Unedited' },
            ]}
          />
        </SegmentGroup.Root>
      </Section>

      <Section title="Date taken">
        <Stack gap="1.5">
          <Flex align="center" gap="2">
            <Text textStyle="xs" w="8" color="fg.muted">
              From
            </Text>
            <Input
              size="xs"
              type="date"
              value={p.get('from') ?? ''}
              onChange={(e) => search.set('from', e.target.value)}
            />
          </Flex>
          <Flex align="center" gap="2">
            <Text textStyle="xs" w="8" color="fg.muted">
              To
            </Text>
            <Input
              size="xs"
              type="date"
              value={p.get('to')?.slice(0, 10) ?? ''}
              onChange={(e) => search.set('to', e.target.value && `${e.target.value}T23:59:59`)}
            />
          </Flex>
        </Stack>
      </Section>

      <Collapsible.Root open={technicalOpen} onOpenChange={(e) => setTechnicalOpen(e.open)}>
        <Collapsible.Trigger asChild>
          <Button variant="ghost" size="xs" w="full" justifyContent="space-between" px="0">
            <HStack>
              <Heading size="xs" textTransform="uppercase" letterSpacing="wider" color="fg.muted">
                Technical
              </Heading>
              {technicalFilters > 0 && <Badge size="xs">{technicalFilters}</Badge>}
            </HStack>
            <ChevronDown
              style={{ transform: technicalOpen ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }}
            />
          </Button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <Stack gap="5" pt="3">
            <Section title="Camera">
              <FacetList name="camera" values={facets?.cameras ?? []} search={search} />
            </Section>
            <Section title="Lens">
              <FacetList name="lens" values={facets?.lenses ?? []} search={search} />
            </Section>
            <Section title="ISO">
              <RangeInputs search={search} min="isoMin" max="isoMax" placeholder={[r?.isoMin, r?.isoMax]} />
            </Section>
            <Section title="Focal length (mm)">
              <RangeInputs search={search} min="focalMin" max="focalMax" placeholder={[r?.focalMin, r?.focalMax]} />
            </Section>
            <Section title="Aperture (ƒ)">
              <RangeInputs
                search={search}
                min="apertureMin"
                max="apertureMax"
                placeholder={[r?.apertureMin, r?.apertureMax]}
              />
            </Section>
          </Stack>
        </Collapsible.Content>
      </Collapsible.Root>
      <Box h="4" />
    </Stack>
  );
}
