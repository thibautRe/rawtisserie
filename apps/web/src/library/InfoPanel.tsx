import {
  Box,
  Button,
  ButtonGroup,
  Circle,
  Field,
  Grid,
  HStack,
  Heading,
  IconButton,
  Image,
  Input,
  RatingGroup,
  Separator,
  Stack,
  TagsInput,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { Aperture, Check, Download, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useBulkUpdate, usePhoto, useUpdatePhoto } from '../api/hooks.ts';
import { COLOR_LABELS, type ColorLabel, type Flag, type Photo, type PhotoPatch } from '../api/types.ts';
import { formatBytes, formatExposureTime, toDateTimeLocal } from '../lib/format.ts';
import { LABEL_COLORS } from './FilterSidebar.tsx';

const PANEL_PROPS = {
  as: 'aside',
  w: '80',
  flexShrink: 0,
  borderLeftWidth: '1px',
  bg: 'bg.panel',
  overflowY: 'auto',
  p: '4',
  gap: '4',
} as const;

export function InfoPanel({ selected, onDelete }: { selected: Photo[]; onDelete: (ids: string[]) => void }) {
  if (selected.length === 0) {
    return (
      <Stack {...PANEL_PROPS} justify="center" align="center" color="fg.muted" textAlign="center">
        <Text>Select a photo to see and edit its metadata.</Text>
        <Text textStyle="xs">
          Shortcuts: <b>0–5</b> rate · <b>P</b> pick · <b>X</b> reject · <b>U</b> unflag · <b>6–9</b> labels ·{' '}
          <b>D</b> develop · <b>Del</b> delete · arrows to move
        </Text>
      </Stack>
    );
  }
  if (selected.length > 1) return <BulkPanel photos={selected} onDelete={onDelete} />;
  return <SinglePanel photo={selected[0]!} onDelete={onDelete} />;
}

// ── Shared culling controls ─────────────────────────────────────────────────

function Culling({
  rating,
  flag,
  colorLabel,
  onChange,
}: {
  rating: number | null;
  flag: Flag | null | undefined;
  colorLabel: ColorLabel | null | undefined;
  onChange: (patch: { rating?: number; flag?: Flag | null; colorLabel?: ColorLabel | null }) => void;
}) {
  return (
    <Stack gap="3">
      <HStack justify="space-between">
        <RatingGroup.Root
          count={5}
          value={rating ?? 0}
          onValueChange={(e) => onChange({ rating: e.value })}
          colorPalette="orange"
          size="sm"
        >
          <RatingGroup.HiddenInput />
          <RatingGroup.Control />
        </RatingGroup.Root>
        <Button size="2xs" variant="ghost" disabled={rating === 0} onClick={() => onChange({ rating: 0 })}>
          Clear
        </Button>
      </HStack>
      <HStack justify="space-between">
        <ButtonGroup size="xs" attached variant="outline">
          <Button
            colorPalette={flag === 'picked' ? 'green' : 'gray'}
            variant={flag === 'picked' ? 'solid' : 'outline'}
            onClick={() => onChange({ flag: flag === 'picked' ? null : 'picked' })}
          >
            <Check /> Pick
          </Button>
          <Button
            colorPalette={flag === 'rejected' ? 'red' : 'gray'}
            variant={flag === 'rejected' ? 'solid' : 'outline'}
            onClick={() => onChange({ flag: flag === 'rejected' ? null : 'rejected' })}
          >
            <X /> Reject
          </Button>
        </ButtonGroup>
        <HStack gap="1.5">
          {COLOR_LABELS.map((c) => (
            <Circle
              key={c}
              as="button"
              size="4"
              bg={LABEL_COLORS[c]}
              opacity={colorLabel === c ? 1 : 0.35}
              outline={colorLabel === c ? '2px solid' : 'none'}
              outlineColor="fg"
              outlineOffset="1px"
              aria-label={`${c} label`}
              onClick={() => onChange({ colorLabel: colorLabel === c ? null : c })}
            />
          ))}
        </HStack>
      </HStack>
    </Stack>
  );
}

// ── Single photo ────────────────────────────────────────────────────────────

/** A text input that commits its value on blur / Enter. */
function MetaField({
  label,
  value,
  type = 'text',
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  type?: 'text' | 'number' | 'datetime-local';
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <Field.Root>
      <Field.Label textStyle="xs" color="fg.muted">
        {label}
      </Field.Label>
      <Input
        size="xs"
        type={type}
        step={type === 'number' ? 'any' : type === 'datetime-local' ? 1 : undefined}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setDraft(value);
        }}
      />
    </Field.Root>
  );
}

const numOrNull = (s: string) => (s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s));
const textOrNull = (s: string) => s.trim() || null;

/** "1/250", "0.004", "2" → seconds. */
function parseExposure(s: string): number | null {
  const m = s.trim().match(/^1\/(\d+(?:\.\d+)?)$/);
  if (m) return 1 / Number(m[1]);
  return numOrNull(s.replace(/[″"s]$/, ''));
}

function SinglePanel({ photo: listPhoto, onDelete }: { photo: Photo; onDelete: (ids: string[]) => void }) {
  const { data: detail } = usePhoto(listPhoto.id);
  const photo = detail ?? listPhoto;
  const update = useUpdatePhoto();
  const navigate = useNavigate();
  const save = (patch: PhotoPatch) => update.mutate({ id: photo.id, patch });

  return (
    <Stack {...PANEL_PROPS}>
      {photo.previewUrl && (
        <Image src={photo.previewUrl} alt="" borderRadius="sm" maxH="56" objectFit="contain" bg="canvas" />
      )}
      <Box>
        <Text fontWeight="semibold" truncate title={photo.filename}>
          {photo.filename}
        </Text>
        <Text textStyle="xs" color="fg.muted">
          {[photo.width && photo.height && `${photo.width} × ${photo.height}`, formatBytes(photo.fileSize)]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </Box>

      <HStack>
        <Button size="sm" colorPalette="orange" flex="1" onClick={() => navigate(`/photos/${photo.id}/develop`)}>
          <Aperture /> Develop
        </Button>
        <IconButton asChild size="sm" variant="outline" aria-label="Download original">
          <a href={photo.originalUrl} download>
            <Download />
          </a>
        </IconButton>
        <IconButton size="sm" variant="outline" colorPalette="red" aria-label="Delete" onClick={() => onDelete([photo.id])}>
          <Trash2 />
        </IconButton>
      </HStack>

      <Culling rating={photo.rating} flag={photo.flag} colorLabel={photo.colorLabel} onChange={save} />

      <Separator />
      <Heading size="xs">Description</Heading>
      <MetaField label="Title" value={photo.title ?? ''} onCommit={(v) => save({ title: textOrNull(v) })} />
      <Field.Root>
        <Field.Label textStyle="xs" color="fg.muted">
          Caption
        </Field.Label>
        <DescriptionInput value={photo.description ?? ''} onCommit={(v) => save({ description: textOrNull(v) })} />
      </Field.Root>
      <TagsInput.Root
        size="xs"
        value={photo.tags}
        onValueChange={(e) => save({ tags: e.value })}
        addOnPaste
        delimiter=","
      >
        <TagsInput.Label textStyle="xs" color="fg.muted">
          Tags
        </TagsInput.Label>
        <TagsInput.Control>
          <TagsInput.Items />
          <TagsInput.Input placeholder="Add tag…" />
        </TagsInput.Control>
      </TagsInput.Root>

      <Separator />
      <Heading size="xs">Capture</Heading>
      <MetaField
        label="Date taken"
        type="datetime-local"
        value={toDateTimeLocal(photo.capturedAt)}
        onCommit={(v) => save({ capturedAt: v ? new Date(v).toISOString() : null })}
      />
      <Grid templateColumns="1fr 1fr" gap="2">
        <MetaField label="Camera make" value={photo.cameraMake ?? ''} onCommit={(v) => save({ cameraMake: textOrNull(v) })} />
        <MetaField label="Camera model" value={photo.cameraModel ?? ''} onCommit={(v) => save({ cameraModel: textOrNull(v) })} />
      </Grid>
      <MetaField label="Lens" value={photo.lens ?? ''} onCommit={(v) => save({ lens: textOrNull(v) })} />
      <Grid templateColumns="1fr 1fr" gap="2">
        <MetaField
          label="Exposure time"
          value={formatExposureTime(photo.exposureTime) ?? ''}
          placeholder="1/250"
          onCommit={(v) => save({ exposureTime: parseExposure(v) })}
        />
        <MetaField label="Aperture (ƒ)" type="number" value={photo.fNumber?.toString() ?? ''} onCommit={(v) => save({ fNumber: numOrNull(v) })} />
        <MetaField label="ISO" type="number" value={photo.iso?.toString() ?? ''} onCommit={(v) => save({ iso: numOrNull(v) })} />
        <MetaField
          label="Focal length (mm)"
          type="number"
          value={photo.focalLength?.toString() ?? ''}
          onCommit={(v) => save({ focalLength: numOrNull(v) })}
        />
        <MetaField
          label="Exposure bias (EV)"
          type="number"
          value={photo.exposureBias?.toString() ?? ''}
          onCommit={(v) => save({ exposureBias: numOrNull(v) })}
        />
      </Grid>
      <Grid templateColumns="1fr 1fr" gap="2">
        <MetaField label="Latitude" type="number" value={photo.gpsLatitude?.toString() ?? ''} onCommit={(v) => save({ gpsLatitude: numOrNull(v) })} />
        <MetaField label="Longitude" type="number" value={photo.gpsLongitude?.toString() ?? ''} onCommit={(v) => save({ gpsLongitude: numOrNull(v) })} />
      </Grid>

      <Separator />
      <Heading size="xs">Rights</Heading>
      <MetaField label="Artist" value={photo.artist ?? ''} onCommit={(v) => save({ artist: textOrNull(v) })} />
      <MetaField label="Copyright" value={photo.copyright ?? ''} onCommit={(v) => save({ copyright: textOrNull(v) })} />
      <Text textStyle="xs" color="fg.subtle">
        Metadata edits are stored in your library; the original RAW file is never modified.
      </Text>
    </Stack>
  );
}

function DescriptionInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Textarea
      size="xs"
      rows={3}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
    />
  );
}

// ── Several photos ──────────────────────────────────────────────────────────

function BulkPanel({ photos, onDelete }: { photos: Photo[]; onDelete: (ids: string[]) => void }) {
  const bulk = useBulkUpdate();
  const ids = photos.map((p) => p.id);
  const same = <T,>(get: (p: Photo) => T): T | undefined => {
    const first = get(photos[0]!);
    return photos.every((p) => get(p) === first) ? first : undefined;
  };
  const [tag, setTag] = useState('');
  const commonTags = photos[0]!.tags.filter((t) => photos.every((p) => p.tags.includes(t)));

  return (
    <Stack {...PANEL_PROPS}>
      <Heading size="sm">{photos.length} photos selected</Heading>
      <Culling
        rating={same((p) => p.rating) ?? null}
        flag={same((p) => p.flag)}
        colorLabel={same((p) => p.colorLabel)}
        onChange={(patch) => bulk.mutate({ ids, patch })}
      />
      <Separator />
      <Heading size="xs">Tags in common</Heading>
      <HStack wrap="wrap" gap="1">
        {commonTags.length === 0 && (
          <Text textStyle="xs" color="fg.muted">
            None
          </Text>
        )}
        {commonTags.map((t) => (
          <Button key={t} size="2xs" variant="subtle" onClick={() => bulk.mutate({ ids, patch: { removeTags: [t] } })}>
            {t} <X />
          </Button>
        ))}
      </HStack>
      <HStack
        as="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!tag.trim()) return;
          bulk.mutate({ ids, patch: { addTags: [tag.trim()] } });
          setTag('');
        }}
      >
        <Input size="xs" placeholder="Add a tag to all…" value={tag} onChange={(e) => setTag(e.target.value)} />
        <Button size="xs" type="submit" variant="outline">
          Add
        </Button>
      </HStack>
      <Separator />
      <Button size="sm" variant="outline" colorPalette="red" onClick={() => onDelete(ids)}>
        <Trash2 /> Delete {photos.length} photos
      </Button>
    </Stack>
  );
}
