import {
  Box,
  Button,
  Center,
  Circle,
  Field,
  Grid,
  HStack,
  IconButton,
  Image,
  Input,
  Menu,
  Portal,
  Spinner,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import {
  Aperture,
  Check,
  Copy,
  CopyPlus,
  Download,
  Ellipsis,
  Folder,
  FolderInput,
  ImageDown,
  Lock,
  LockOpen,
  Palette,
  Send,
  Star,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useCollections, useInstances, usePhoto, useUpdatePhoto } from '../api/hooks.ts';
import { collectionPath, displayCollection } from '../lib/collections.ts';
import { photoCount } from './selectionText.ts';
import {
  type BulkPatch,
  COLOR_LABELS,
  type ColorLabel,
  type Flag,
  type Photo,
  type PhotoPatch,
  type RemoteInstance,
} from '@rawtisserie/api';
import { hostOf } from '../components/transfer.tsx';
import {
  formatAperture,
  formatBias,
  formatBytes,
  formatDateTime,
  formatExposureTime,
  formatFocal,
  formatIso,
  toDateTimeLocal,
  versionLabel,
} from '../lib/format.ts';
import { displayTag, normalizeTag } from '../lib/tags.ts';
import { ApplyMenu } from './ApplyMenu.tsx';
import type { BatchEdit } from './batchEdit.ts';
import { useEditPreview } from './useEditPreview.ts';
import { LABEL_COLORS } from './FilterSidebar.tsx';
import { TAG_INPUT_ID, useTagCompletion } from './TagCompletion.tsx';
import { BLOCKS_PROPS, PanelBlock } from './PanelBlock.tsx';

export const PANEL_PROPS = { as: 'aside', w: '80', flexShrink: 0, borderLeftWidth: '1px' } as const;

/** The single-photo preview's box, square so photos of either orientation look the same size: the panel's width inside its block (CSS px). */
export const PREVIEW_SIZE = 295;

interface Actions {
  /** Move the selection to the trash (`versions`: those of it shown). */
  onDelete: (versions: Photo[]) => void;
  /** Rate, flag, label or tag the whole selection (several photos). */
  onPatch: (patch: BulkPatch) => void;
  /** Duplicate the selected versions. */
  onDuplicate: (fromOriginal: boolean) => void;
  /** Apply a preset or style to the selected versions. */
  onApplyEdit: (edit: BatchEdit) => void;
  /** Pick settings of the selected version to copy. */
  onCopy: () => void;
  /** Export the selected versions. */
  onExport: () => void;
  /** Send the selected versions to another instance (connected in the settings). */
  onSend: (instance: RemoteInstance) => void;
  /** Put the selected photos in a collection (picked in a dialog; `current`: where they are, if all in one). */
  onMoveToCollection: (current: string | null) => void;
  /** Show the library's photos with a tag, or in a collection (and those under it): that filter alone. */
  onShowFilter: (key: 'tag' | 'collection', value: string) => void;
}

/** A photo's collection, as a path (`2026 › 2026-11-09`). */
function CollectionName({ id, onShow }: { id: string | null; onShow: (id: string) => void }) {
  const { data: list = [] } = useCollections();
  const path = id ? collectionPath(new Map(list.map((c) => [c.id, c])), id) : [];
  if (!id || !path.length)
    return (
      <Text textStyle="xs" color="fg.muted" fontStyle="italic">
        No collection
      </Text>
    );
  return (
    <HStack gap="1" data-photo-collection>
      <Box color="fg.muted" flexShrink={0}>
        <Folder size={12} />
      </Box>
      <Text
        as="button"
        textStyle="xs"
        truncate
        textAlign="start"
        cursor="pointer"
        _hover={{ textDecoration: 'underline' }}
        focusRing="outside"
        title={`Show the photos in ${displayCollection(path)}`}
        onClick={() => onShow(id)}
      >
        {displayCollection(path)}
      </Text>
    </HStack>
  );
}

/** Duplicate / Duplicate from original. */
export function DuplicateMenu({
  onDuplicate,
  children,
}: {
  onDuplicate: Actions['onDuplicate'];
  children: React.ReactNode;
}) {
  return (
    <Menu.Root onSelect={(d) => onDuplicate(d.value === 'original')}>
      <Menu.Trigger asChild>{children}</Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content>
            <Menu.Item value="copy">
              Duplicate <Menu.ItemCommand>Ctrl+D</Menu.ItemCommand>
            </Menu.Item>
            <Menu.Item value="original">
              Duplicate from original <Menu.ItemCommand>Ctrl+Shift+D</Menu.ItemCommand>
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

export function InfoPanel({
  selected,
  count = selected.length,
  inLoupe,
  ...actions
}: {
  /** The selected photos shown (loaded). */
  selected: Photo[];
  /** How many are selected, shown or not (roadmap 8.13: all the filters match). */
  count?: number;
  /** Under the loupe (phones): without the preview and the rating, flag and label, which the loupe has. */
  inLoupe?: boolean;
} & Actions) {
  if (count === 0) {
    return (
      <Stack {...PANEL_PROPS} bg="bg.panel" p="4" justify="center" align="center" color="fg.muted" textAlign="center">
        <Text>Select a photo to see and edit its metadata.</Text>
        <Text textStyle="xs">
          Shortcuts: <b>0–5</b> rate · <b>P</b> pick · <b>X</b> reject · <b>U</b> unflag · <b>6–9</b> labels · <b>T</b>{' '}
          tag · <b>D</b> develop · <b>Ctrl+D</b> duplicate · <b>Ctrl+C</b>/<b>Ctrl+V</b> copy and paste settings ·{' '}
          <b>Ctrl+E</b> export · <b>Del</b> move to trash · arrows to move. Tags get shortcuts of their own:{' '}
          <b>Edit…</b> in a tag’s menu, in the filters.
        </Text>
      </Stack>
    );
  }
  if (count > 1 || !selected[0]) return <BulkPanel photos={selected} count={count} {...actions} />;
  return <SinglePanel photo={selected[0]} inLoupe={inLoupe} {...actions} />;
}

// ── Shared culling controls ─────────────────────────────────────────────────

export function Culling({
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
    <HStack justify="space-between" gap="1" rowGap="2" wrap="wrap">
      <HStack gap="0" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => {
          const on = n <= (rating ?? 0);
          return (
            <IconButton
              key={n}
              size={{ base: 'sm', md: '2xs' }}
              variant="ghost"
              role="radio"
              aria-checked={n === rating}
              aria-label={`${n} star${n > 1 ? 's' : ''} (${n})`}
              title={n === rating ? 'Clear the rating (0)' : `${n} star${n > 1 ? 's' : ''} (${n})`}
              color={on ? 'orange.fg' : 'fg.subtle'}
              onClick={() => onChange({ rating: n === rating ? 0 : n })}
            >
              <Star fill={on ? 'currentColor' : 'none'} />
            </IconButton>
          );
        })}
      </HStack>
      <HStack gap="0.5">
        <IconButton
          size={{ base: 'sm', md: '2xs' }}
          variant={flag === 'picked' ? 'solid' : 'ghost'}
          colorPalette={flag === 'picked' ? 'green' : 'gray'}
          aria-label="Pick (P)"
          title="Pick (P)"
          onClick={() => onChange({ flag: flag === 'picked' ? null : 'picked' })}
        >
          <Check />
        </IconButton>
        <IconButton
          size={{ base: 'sm', md: '2xs' }}
          variant={flag === 'rejected' ? 'solid' : 'ghost'}
          colorPalette={flag === 'rejected' ? 'red' : 'gray'}
          aria-label="Reject (X)"
          title="Reject (X)"
          onClick={() => onChange({ flag: flag === 'rejected' ? null : 'rejected' })}
        >
          <X />
        </IconButton>
      </HStack>
      <HStack gap={{ base: '3', md: '1.5' }}>
        {COLOR_LABELS.map((c) => (
          <Circle
            key={c}
            as="button"
            size={{ base: '6', md: '3.5' }}
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
    <Field.Root orientation="horizontal" gap="2">
      <FieldLabel>{label}</FieldLabel>
      <Input
        flex="1"
        size="xs"
        variant="subtle"
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

/** A field's label, left of it. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Field.Label textStyle="xs" color="fg.muted" w="20" flexShrink={0} fontWeight="normal">
      {children}
    </Field.Label>
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

function SinglePanel({
  photo: listPhoto,
  onDelete,
  onDuplicate,
  onApplyEdit,
  onCopy,
  onExport,
  onSend,
  onMoveToCollection,
  onShowFilter,
  inLoupe,
}: { photo: Photo; inLoupe?: boolean } & Actions) {
  const { data: instances = [] } = useInstances();
  const { data: detail } = usePhoto(listPhoto.id);
  // The render state comes from the list: it's polled while previews are rendered, the detail isn't.
  const photo = detail
    ? {
        ...detail,
        renderStatus: listPhoto.renderStatus,
        renderError: listPhoto.renderError,
        thumbUrl: listPhoto.thumbUrl,
        previewUrl: listPhoto.previewUrl,
      }
    : listPhoto;
  const preview = useEditPreview(detail, PREVIEW_SIZE, PREVIEW_SIZE);
  const update = useUpdatePhoto();
  const navigate = useNavigate();
  const save = (patch: PhotoPatch) => update.mutate({ id: photo.id, patch });
  // Capture details come from the file: locked against accidental edits, per photo.
  const [captureUnlocked, setCaptureUnlocked] = useState(false);
  useEffect(() => setCaptureUnlocked(false), [photo.id]);
  const locked = !captureUnlocked;
  // Folded when there's nothing in it, per photo.
  const described = !!(photo.title || photo.description || photo.versionName);
  const [descriptionOpen, setDescriptionOpen] = useState(described);
  useEffect(() => setDescriptionOpen(described), [photo.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Stack {...PANEL_PROPS} {...BLOCKS_PROPS}>
      <PanelBlock>
        <Box
          position="relative"
          w="full"
          aspectRatio="1"
          flexShrink={0}
          bg="bg.muted"
          borderRadius="sm"
          display={inLoupe ? 'none' : undefined}
        >
          {photo.previewUrl && (
            <Image
              src={photo.previewUrl}
              alt=""
              position="absolute"
              inset="0"
              w="full"
              h="full"
              objectFit="contain"
              opacity={photo.renderStatus === 'pending' || preview.status === 'loading' ? 0.6 : 1}
              transition="opacity 0.15s"
            />
          )}
          {/* Previews of the highlighted preset or style, while the apply menu is open. */}
          <Box
            asChild
            position="absolute"
            inset="0"
            w="full"
            h="full"
            objectFit="contain"
            bg="bg.muted"
            borderRadius="sm"
            visibility={preview.active ? 'visible' : 'hidden'}
          >
            <canvas ref={preview.canvasRef} />
          </Box>
          {(photo.renderStatus === 'pending' || preview.status === 'loading') && (
            <Center position="absolute" inset="0" pointerEvents="none">
              <Spinner color="orange.solid" />
            </Center>
          )}
        </Box>
        <HStack align="start" gap="2">
          <Box flex="1" minW="0">
            <Text textStyle="sm" fontWeight="semibold" truncate title={photo.filename}>
              {photo.filename}
              {photo.versionCount > 1 && (
                <Text as="span" fontWeight="normal" color="fg.muted">
                  {' · '}
                  {versionLabel({ name: photo.versionName, index: photo.versionIndex })}
                </Text>
              )}
            </Text>
            <Text textStyle="xs" color="fg.muted" fontFamily="numeric" fontVariantNumeric="tabular-nums">
              {[photo.width && photo.height && `${photo.width} × ${photo.height}`, formatBytes(photo.fileSize)]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </Box>
          <Menu.Root
            onSelect={({ value }) => {
              if (value === 'develop') navigate(`/versions/${photo.id}/develop`);
              else if (value === 'export') onExport();
              else if (value === 'duplicate' || value === 'original') onDuplicate(value === 'original');
              else if (value === 'delete') onDelete([photo]);
              else if (value === 'collection') onMoveToCollection(photo.collectionId);
              else if (value.startsWith('send:')) onSend(instances.find((i) => `send:${i.id}` === value)!);
            }}
          >
            <Menu.Trigger asChild>
              <IconButton size="xs" variant="ghost" aria-label="Actions" title="Actions">
                <Ellipsis />
              </IconButton>
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner>
                <Menu.Content minW="56">
                  <Menu.Item value="develop">
                    <Aperture /> Develop <Menu.ItemCommand>D</Menu.ItemCommand>
                  </Menu.Item>
                  <Menu.Item value="export">
                    <ImageDown /> Export… <Menu.ItemCommand>Ctrl+E</Menu.ItemCommand>
                  </Menu.Item>
                  <Menu.Item value="download" asChild>
                    <a href={photo.originalUrl} download>
                      <Download /> Download original
                    </a>
                  </Menu.Item>
                  <Menu.Separator />
                  <ApplyMenu
                    submenu
                    onApply={onApplyEdit}
                    onCopy={onCopy}
                    onPreview={preview.onPreview}
                    onOpenChange={preview.onOpenChange}
                  >
                    <Palette /> Apply a preset or style
                  </ApplyMenu>
                  <Menu.Item value="duplicate">
                    <Copy /> Duplicate <Menu.ItemCommand>Ctrl+D</Menu.ItemCommand>
                  </Menu.Item>
                  <Menu.Item value="original">
                    <CopyPlus /> Duplicate from original <Menu.ItemCommand>Ctrl+Shift+D</Menu.ItemCommand>
                  </Menu.Item>
                  <Menu.Item value="collection">
                    <FolderInput /> Move to collection…
                  </Menu.Item>
                  {instances.map((i) => (
                    <Menu.Item key={i.id} value={`send:${i.id}`}>
                      <Send /> Send to {hostOf(i.url)}
                    </Menu.Item>
                  ))}
                  <Menu.Separator />
                  <Menu.Item value="delete" color="fg.error" _highlighted={{ bg: 'bg.error', color: 'fg.error' }}>
                    <Trash2 /> Move to trash <Menu.ItemCommand>Del</Menu.ItemCommand>
                  </Menu.Item>
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
        </HStack>

        {!inLoupe && <Culling rating={photo.rating} flag={photo.flag} colorLabel={photo.colorLabel} onChange={save} />}
      </PanelBlock>

      <PanelBlock
        title="Collection"
        actions={
          <Button size="2xs" variant="ghost" color="fg.muted" onClick={() => onMoveToCollection(photo.collectionId)}>
            Move…
          </Button>
        }
      >
        <CollectionName id={photo.collectionId} onShow={(id) => onShowFilter('collection', id)} />
      </PanelBlock>

      <PanelBlock title="Tags">
        <PhotoTags
          key={photo.id}
          tags={photo.tags}
          onChange={(tags) => save({ tags })}
          onShow={(tag) => onShowFilter('tag', tag)}
        />
      </PanelBlock>

      <PanelBlock
        title="Capture"
        actions={
          <Button
            size="2xs"
            variant="ghost"
            color="fg.muted"
            onClick={() => setCaptureUnlocked((u) => !u)}
            title={locked ? 'Edit to correct the details read from the file' : 'Lock'}
          >
            {locked ? <Lock /> : <LockOpen />} {locked ? 'Unlock' : 'Lock'}
          </Button>
        }
      >
        {locked ? (
          <CaptureDetails photo={photo} />
        ) : (
          <>
            <MetaField
              label="Date taken"
              type="datetime-local"
              value={toDateTimeLocal(photo.capturedAt)}
              onCommit={(v) => save({ capturedAt: v ? new Date(v).toISOString() : null })}
            />
            <MetaField
              label="Make"
              value={photo.cameraMake ?? ''}
              onCommit={(v) => save({ cameraMake: textOrNull(v) })}
            />
            <MetaField
              label="Model"
              value={photo.cameraModel ?? ''}
              onCommit={(v) => save({ cameraModel: textOrNull(v) })}
            />
            <MetaField label="Lens" value={photo.lens ?? ''} onCommit={(v) => save({ lens: textOrNull(v) })} />
            <MetaField
              label="Exposure"
              value={formatExposureTime(photo.exposureTime) ?? ''}
              placeholder="1/250"
              onCommit={(v) => save({ exposureTime: parseExposure(v) })}
            />
            <MetaField
              label="Aperture (ƒ)"
              type="number"
              value={photo.fNumber?.toString() ?? ''}
              onCommit={(v) => save({ fNumber: numOrNull(v) })}
            />
            <MetaField
              label="ISO"
              type="number"
              value={photo.iso?.toString() ?? ''}
              onCommit={(v) => save({ iso: numOrNull(v) })}
            />
            <MetaField
              label="Focal (mm)"
              type="number"
              value={photo.focalLength?.toString() ?? ''}
              onCommit={(v) => save({ focalLength: numOrNull(v) })}
            />
            <MetaField
              label="Bias (EV)"
              type="number"
              value={photo.exposureBias?.toString() ?? ''}
              onCommit={(v) => save({ exposureBias: numOrNull(v) })}
            />
            <MetaField
              label="Latitude"
              type="number"
              value={photo.gpsLatitude?.toString() ?? ''}
              onCommit={(v) => save({ gpsLatitude: numOrNull(v) })}
            />
            <MetaField
              label="Longitude"
              type="number"
              value={photo.gpsLongitude?.toString() ?? ''}
              onCommit={(v) => save({ gpsLongitude: numOrNull(v) })}
            />
          </>
        )}
      </PanelBlock>

      <PanelBlock title="Description" open={descriptionOpen} onOpenChange={setDescriptionOpen}>
        <MetaField label="Title" value={photo.title ?? ''} onCommit={(v) => save({ title: textOrNull(v) })} />
        <Field.Root orientation="horizontal" gap="2" alignItems="start">
          <FieldLabel>Caption</FieldLabel>
          <DescriptionInput value={photo.description ?? ''} onCommit={(v) => save({ description: textOrNull(v) })} />
        </Field.Root>
        <MetaField
          label="Version name"
          value={photo.versionName ?? ''}
          placeholder={`Version ${photo.versionIndex}`}
          onCommit={(v) => save({ versionName: textOrNull(v) })}
        />
      </PanelBlock>

      <PanelBlock title="Rights">
        <MetaField label="Artist" value={photo.artist ?? ''} onCommit={(v) => save({ artist: textOrNull(v) })} />
        <MetaField
          label="Copyright"
          value={photo.copyright ?? ''}
          onCommit={(v) => save({ copyright: textOrNull(v) })}
        />
        <Text textStyle="2xs" color="fg.subtle">
          Metadata edits are stored in your library; the original file is never modified.
        </Text>
      </PanelBlock>
    </Stack>
  );
}

/** What the file says about the capture, as a list (the empty ones left out). */
export function CaptureDetails({ photo }: { photo: Photo }) {
  const camera = [photo.cameraMake, photo.cameraModel].filter(Boolean).join(' ');
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || null;
  // Label, value, and whether it's a number (in the numeric font).
  const rows: [string, string | null, boolean?][] = [
    ['Taken', formatDateTime(photo.capturedAt), true],
    // Settings first, then the gear (as `captureLine`).
    ['Focal length', formatFocal(photo.focalLength), true],
    [
      'Exposure',
      join(formatAperture(photo.fNumber), formatExposureTime(photo.exposureTime), formatIso(photo.iso)),
      true,
    ],
    ['Bias', photo.exposureBias ? formatBias(photo.exposureBias) : null, true],
    ['Lens', photo.lens],
    ['Camera', camera || null],
    [
      'Location',
      photo.gpsLatitude != null && photo.gpsLongitude != null
        ? `${photo.gpsLatitude.toFixed(5)}, ${photo.gpsLongitude.toFixed(5)}`
        : null,
      true,
    ],
  ];
  const shown = rows.filter((row): row is [string, string, boolean?] => !!row[1]);
  if (!shown.length)
    return (
      <Text textStyle="xs" color="fg.muted">
        Nothing read from the file.
      </Text>
    );
  return (
    <Grid templateColumns="var(--chakra-sizes-20) 1fr" columnGap="2" rowGap="1" textStyle="xs">
      {shown.map(([label, value, numeric]) => (
        <Fragment key={label}>
          <Text color="fg.muted">{label}</Text>
          <Text
            truncate
            title={value}
            fontFamily={numeric ? 'numeric' : undefined}
            fontVariantNumeric={numeric ? 'tabular-nums' : undefined}
          >
            {value}
          </Text>
        </Fragment>
      ))}
    </Grid>
  );
}

/** One photo's tags, completed from the library's. */
function PhotoTags({
  tags,
  onChange,
  onShow,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  /** Show the library's photos with this tag. */
  onShow: (tag: string) => void;
}) {
  return (
    <Stack gap="1.5">
      <TagInput exclude={tags} placeholder="Add tag…" onAdd={(added) => onChange([...new Set([...tags, ...added])])} />
      <TagList tags={tags} onShow={onShow} onRemove={(tag) => onChange(tags.filter((t) => t !== tag))} />
    </Stack>
  );
}

/** The tag input (T focuses it), completed from the library's tags; commas add several, levels by `|`. */
function TagInput({
  exclude,
  placeholder,
  onAdd,
}: {
  exclude: readonly string[];
  placeholder: string;
  onAdd: (tags: string[]) => void;
}) {
  const [input, setInput] = useState('');
  const add = (typed: string) => {
    const added = typed.split(',').map(normalizeTag).filter(Boolean);
    if (added.length) onAdd(added);
    setInput('');
  };
  const completion = useTagCompletion({ input, exclude, onPick: (tag) => add(tag) });
  return (
    <Box
      as="form"
      position="relative"
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault();
        add(input);
      }}
    >
      <Input
        size="xs"
        variant="subtle"
        placeholder={placeholder}
        aria-label={placeholder.replace(/…$/, '')}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        {...completion.inputProps}
      />
      {completion.list}
    </Box>
  );
}

/** Tags, one per line: a click shows the library's photos with it, the bin next to it removes it. */
function TagList({
  tags,
  onShow,
  onRemove,
}: {
  tags: readonly string[];
  onShow: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  if (!tags.length) return null;
  return (
    <Stack gap="0.5" data-photo-tags>
      {[...tags]
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
        .map((tag) => (
          <HStack key={tag} data-photo-tag={tag} gap="1">
            <Box color="fg.muted" flexShrink={0}>
              <Tag size={12} />
            </Box>
            <Text
              as="button"
              minW="0"
              truncate
              textAlign="start"
              textStyle="xs"
              cursor="pointer"
              _hover={{ textDecoration: 'underline' }}
              focusRing="outside"
              title={`Show the photos with ${displayTag(tag)}`}
              onClick={() => onShow(tag)}
            >
              {displayTag(tag)}
            </Text>
            <IconButton
              size="2xs"
              variant="ghost"
              minW="4"
              h="4"
              flexShrink={0}
              color="fg.subtle"
              _hover={{ color: 'fg.error', bg: 'transparent' }}
              aria-label={`Remove ${displayTag(tag)}`}
              title={`Remove ${displayTag(tag)}`}
              onClick={() => onRemove(tag)}
            >
              <Trash2 />
            </IconButton>
          </HStack>
        ))}
    </Stack>
  );
}

function DescriptionInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Textarea
      size="xs"
      variant="subtle"
      flex="1"
      rows={3}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
    />
  );
}

// ── Several photos ──────────────────────────────────────────────────────────

/**
 * Several photos: what they have in common (among those shown: a selection by filter may
 * hold photos not loaded yet), and what to do with all of them.
 */
function BulkPanel({
  photos,
  count,
  onDelete,
  onPatch,
  onDuplicate,
  onApplyEdit,
  onExport,
  onSend,
  onMoveToCollection,
  onShowFilter,
}: { photos: Photo[]; count: number } & Actions) {
  const { data: instances = [] } = useInstances();
  const same = <T,>(get: (p: Photo) => T): T | undefined => {
    if (!photos[0]) return undefined;
    const first = get(photos[0]);
    return photos.every((p) => get(p) === first) ? first : undefined;
  };
  const commonTags = (photos[0]?.tags ?? []).filter((t) => photos.every((p) => p.tags.includes(t)));
  const n = count.toLocaleString('en-US');

  return (
    <Stack {...PANEL_PROPS} {...BLOCKS_PROPS}>
      <PanelBlock title={`${photoCount(count)} selected`}>
        <Culling
          rating={same((p) => p.rating) ?? null}
          flag={same((p) => p.flag)}
          colorLabel={same((p) => p.colorLabel)}
          onChange={onPatch}
        />
      </PanelBlock>
      <PanelBlock title={count > photos.length ? 'Tags in common (of those shown)' : 'Tags in common'}>
        <TagInput exclude={commonTags} placeholder="Add a tag to all…" onAdd={(tags) => onPatch({ addTags: tags })} />
        {commonTags.length ? (
          <TagList
            tags={commonTags}
            onShow={(tag) => onShowFilter('tag', tag)}
            onRemove={(tag) => onPatch({ removeTags: [tag] })}
          />
        ) : (
          <Text textStyle="xs" color="fg.muted">
            None in common
          </Text>
        )}
      </PanelBlock>
      <PanelBlock title="Actions">
        <ApplyMenu onApply={onApplyEdit}>
          <Button size="xs" variant="outline">
            <Palette /> Apply a preset or style to {n}
          </Button>
        </ApplyMenu>
        <Button size="xs" variant="outline" onClick={onExport} title="Export (Ctrl+E)">
          <ImageDown /> Export {photoCount(count)}
        </Button>
        <DuplicateMenu onDuplicate={onDuplicate}>
          <Button size="xs" variant="outline">
            <Copy /> Duplicate {n}
          </Button>
        </DuplicateMenu>
        <Button size="xs" variant="outline" onClick={() => onMoveToCollection(same((p) => p.collectionId) ?? null)}>
          <FolderInput /> Move {n} to a collection…
        </Button>
        {instances.map((i) => (
          <Button key={i.id} size="xs" variant="outline" onClick={() => onSend(i)}>
            <Send /> Send {n} to {hostOf(i.url)}
          </Button>
        ))}
        <Button size="xs" variant="outline" colorPalette="red" onClick={() => onDelete(photos)}>
          <Trash2 /> Move {n} to trash
        </Button>
      </PanelBlock>
    </Stack>
  );
}
