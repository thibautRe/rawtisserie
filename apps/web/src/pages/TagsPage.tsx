import {
  Badge,
  Box,
  Button,
  Center,
  Code,
  CloseButton,
  Dialog,
  Field,
  HStack,
  Heading,
  IconButton,
  Input,
  Menu,
  Portal,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import { ChevronDown, ChevronRight, CornerDownRight, Ellipsis, Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTagChange, useTagManager } from '../api/hooks.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { TagSearch } from '../components/TagSearch.tsx';
import { toaster } from '../components/toaster.tsx';
import { type Shortcut, formatShortcut, pressOf } from '../lib/keys.ts';
import { type TagInfo, describeDelete, managedTags, pathLevels, planEdit, plural } from '../lib/tagManager.ts';
import { SEPARATOR, type TagNode, displayTag, filterTagTree, isUnder, tagName } from '../lib/tags.ts';
import { useTagCompletion } from '../library/TagCompletion.tsx';

/**
 * What the tag editor opens on: a tag to edit, or a new one (under `parent`), and the
 * field to start with. Places in the app open it with what they know filled in.
 */
export interface EditorTarget {
  /** The tag edited; absent for a new one. */
  tag?: string;
  /** For a new one: where it goes. */
  parent?: string | null;
  focus?: 'path' | 'shortcut';
}

/**
 * The tag manager (Settings › Tags): every tag as a tree, with its photos, to create,
 * edit (name, place in the tree, shortcut), merge (moved onto another) or delete them.
 * What a change will do is said before it's made; it applies to every photo with the
 * tag, the trash included, and to the tags inside it.
 */
export function TagsSettings() {
  const { data, isPending } = useTagManager();
  const change = useTagChange();
  const [query, setQuery] = useState('');
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const { tree, info } = useMemo(
    () => (data ? managedTags(data) : { tree: [], info: new Map<string, TagInfo>() }),
    [data],
  );

  // Searching shows the tags matching and the way to them, unfolded.
  const searching = query.trim() !== '';
  const found = useMemo(() => filterTagTree(tree, query), [tree, query]);
  const rows = (nodes: TagNode[], depth: number): ReactNode[] =>
    nodes.flatMap((n) => {
      const i = info.get(n.path)!;
      const open = searching || !folded.has(n.path);
      return [
        <HStack
          key={n.path}
          data-managed-tag={n.path}
          gap="2"
          ps={`${8 + depth * 20}px`}
          pe="2"
          py="1.5"
          borderBottomWidth="1px"
          _hover={{ bg: 'bg.muted' }}
        >
          {n.children.length ? (
            <IconButton
              size="2xs"
              variant="ghost"
              aria-label={open ? `Fold ${n.name}` : `Unfold ${n.name}`}
              onClick={() =>
                setFolded((f) => {
                  const next = new Set(f);
                  if (!next.delete(n.path)) next.add(n.path);
                  return next;
                })
              }
            >
              {open ? <ChevronDown /> : <ChevronRight />}
            </IconButton>
          ) : (
            <Box w="6" flexShrink={0} />
          )}
          <Tag size={14} />
          <Text
            as="button"
            textStyle="sm"
            flex="1"
            truncate
            textAlign="start"
            cursor="pointer"
            title={`Edit ${displayTag(n.path)}`}
            onClick={() => setEditing({ tag: n.path })}
          >
            {n.name}
          </Text>
          {i.shortcut && (
            <Text as="kbd" textStyle="xs" fontFamily="numeric" px="1.5" borderWidth="1px" rounded="l1" color="fg.muted">
              {formatShortcut(i.shortcut)}
            </Text>
          )}
          <Text
            textStyle="xs"
            color="fg.muted"
            fontFamily="numeric"
            fontVariantNumeric="tabular-nums"
            minW="20"
            textAlign="end"
          >
            {plural(i.photos, 'photo')}
          </Text>
          <Menu.Root positioning={{ placement: 'bottom-end' }}>
            <Menu.Trigger asChild>
              <IconButton size="2xs" variant="ghost" aria-label={`Change ${n.name}`}>
                <Ellipsis />
              </IconButton>
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner>
                <Menu.Content>
                  <Menu.Item value="edit" onSelect={() => setEditing({ tag: n.path })}>
                    <Pencil /> Edit…
                  </Menu.Item>
                  <Menu.Item value="create" onSelect={() => setEditing({ parent: n.path })}>
                    <CornerDownRight /> New child tag…
                  </Menu.Item>
                  <Menu.Separator />
                  <Menu.Item value="delete" color="fg.error" onSelect={() => setDeleting(n.path)}>
                    <Trash2 /> Delete…
                  </Menu.Item>
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
        </HStack>,
        ...(open ? rows(n.children, depth + 1) : []),
      ];
    });

  return (
    <Stack gap="4">
      <HStack gap="3">
        <Heading size="lg" flex="1">
          Tags
        </Heading>
        <Button size="sm" colorPalette="orange" onClick={() => setEditing({ parent: null })}>
          <Plus /> New tag
        </Button>
      </HStack>
      <Text textStyle="sm" color="fg.muted">
        Tags can contain other tags: <b>People › Alice</b> is the tag Alice, inside People. When tagging a photo, type{' '}
        <b>|</b> between the levels: <Code size="sm">People|Alice</Code>
      </Text>
      <TagSearch value={query} onChange={setQuery} maxW="xs" />
      {isPending ? (
        <Center py="10">
          <Spinner color="orange.solid" />
        </Center>
      ) : tree.length === 0 ? (
        <Text textStyle="sm" color="fg.subtle" py="6" textAlign="center">
          No tags yet: add some to photos in the library, or create one here.
        </Text>
      ) : found.length === 0 ? (
        <Text textStyle="sm" color="fg.subtle" py="6" textAlign="center">
          No tag matches “{query.trim()}”.
        </Text>
      ) : (
        <Box borderTopWidth="1px">{rows(found, 0)}</Box>
      )}
      <TagEditor target={editing} info={info} onClose={() => setEditing(null)} />
      <ConfirmDialog
        text={deleting ? { title: `Delete ${displayTag(deleting)}?`, body: describeDelete(deleting, info) } : null}
        confirm="Delete"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const tag = deleting!;
          setDeleting(null);
          change.mutate(
            { type: 'delete', tag },
            {
              onSuccess: (n) =>
                toaster.create({
                  type: 'success',
                  title: `Deleted ${displayTag(tag)}${n ? ` from ${plural(n, 'photo')}` : ''}`,
                }),
              onError: (err) =>
                toaster.create({ type: 'error', title: 'Could not delete it', description: err.message }),
            },
          );
        }}
      />
    </Stack>
  );
}

/** The editor's path input. */
const PATH_INPUT_ID = 'tag-editor-path';
const NONE: readonly string[] = [];

/**
 * Creating a tag or editing one: its path (levels separated by `|`, missing ones created
 * with it) and its shortcut. What saving will do is said below, as it's edited
 * (`planEdit`), before the button doing it.
 */
export function TagEditor({
  target,
  info,
  onClose,
}: {
  target: EditorTarget | null;
  info: ReadonlyMap<string, TagInfo>;
  onClose: () => void;
}) {
  // Kept while it closes, so it doesn't empty during the animation.
  const shown = useRef(target);
  if (target) shown.current = target;
  const t = shown.current;
  return (
    <Dialog.Root
      open={!!target}
      onOpenChange={(e) => !e.open && onClose()}
      // The field it was opened for (the dialog moves the focus as it opens).
      initialFocusEl={() =>
        document.querySelector<HTMLElement>(t?.focus === 'shortcut' ? '[data-shortcut-recorder]' : `#${PATH_INPUT_ID}`)
      }
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          {/* A new one starts from the tag as it is. */}
          {t && <EditorForm key={JSON.stringify(t)} target={t} info={info} onDone={onClose} />}
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function EditorForm({
  target,
  info: liveInfo,
  onDone,
}: {
  target: EditorTarget;
  info: ReadonlyMap<string, TagInfo>;
  onDone: () => void;
}) {
  const change = useTagChange();
  const tag = target.tag ?? null;
  // From a save on, the tags as they were: the list refreshes as each change lands, and
  // the tag renamed is gone from it while the dialog closes.
  const frozen = useRef<ReadonlyMap<string, TagInfo> | null>(null);
  const info = frozen.current ?? liveInfo;
  // A new one inside another starts after it: `People|`.
  const [path, setPath] = useState(tag ?? (target.parent ? target.parent + SEPARATOR : ''));
  const [shortcut, setShortcut] = useState<Shortcut | null>(tag === null ? null : (info.get(tag)?.shortcut ?? null));
  const [saving, setSaving] = useState(false);
  const plan = planEdit({ tag, path, shortcut }, info);
  const levels = pathLevels(path, info);
  // Suggested as it's typed: where it can go, anywhere but inside itself. Picking one
  // goes on inside it.
  const places = useMemo(
    () => [...info].flatMap(([value, i]) => (tag !== null && isUnder(value, tag) ? [] : [{ value, count: i.photos }])),
    [info, tag],
  );
  const completion = useTagCompletion({
    input: path,
    exclude: NONE,
    onPick: (p) => setPath(p + SEPARATOR),
    id: PATH_INPUT_ID,
    tags: places,
    create: false,
  });
  // Editing a tag starts with its name selected (typing renames it), a new one after
  // where it goes (typing names it). After the dialog's focus, which selects it all.
  const placed = useRef(false);
  const place = (e: React.FocusEvent<HTMLInputElement>) => {
    completion.inputProps.onFocus();
    if (placed.current) return;
    placed.current = true;
    const el = e.currentTarget;
    const end = el.value.length;
    requestAnimationFrame(() => el.setSelectionRange(tag === null ? end : end - tagName(tag).length, end));
  };

  const save = async () => {
    if (plan.problem !== null || saving) return;
    frozen.current = info;
    setSaving(true);
    try {
      let photos = 0;
      // In order: a rename, then the shortcut on its new path.
      for (const c of plan.changes) photos += await change.mutateAsync(c);
      const first = plan.changes[0]!;
      const path = first.type === 'rename' ? first.to : first.tag;
      toaster.create({
        type: 'success',
        title: `${tag === null ? 'Created' : 'Saved'} ${displayTag(path)}${
          photos ? `: ${plural(photos, 'photo')} changed` : ''
        }`,
      });
      onDone();
    } catch (err) {
      // What did land shows: the dialog stays open on the tags as they are now.
      frozen.current = null;
      toaster.create({ type: 'error', title: 'Could not save the tag', description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Content
      as="form"
      data-tag-editor={tag === null ? 'new' : 'edit'}
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault();
        void save();
      }}
    >
      <Dialog.Header>
        <Dialog.Title>{tag === null ? 'New tag' : `Edit ${displayTag(tag)}`}</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <Stack gap="4">
          <Field.Root>
            <Field.Label>Tag</Field.Label>
            <Box position="relative" w="full">
              <Input
                size="sm"
                placeholder="People|Friends|Alice"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                {...completion.inputProps}
                onFocus={place}
              />
              {completion.list}
            </Box>
            <Field.HelperText>
              Type <b>|</b> between the levels; those that don’t exist yet are created with it.
            </Field.HelperText>
            {levels.length > 0 && (
              <HStack gap="1" wrap="wrap" textStyle="sm" data-tag-levels>
                {levels.map((l, i) => (
                  <Fragment key={l.path}>
                    {i > 0 && <Text color="fg.subtle">›</Text>}
                    <HStack gap="1" data-new={l.isNew || undefined}>
                      <Text fontWeight={i === levels.length - 1 ? 'semibold' : undefined}>{l.name}</Text>
                      {l.isNew && (
                        <Badge size="xs" colorPalette="orange" variant="subtle">
                          new
                        </Badge>
                      )}
                    </HStack>
                  </Fragment>
                ))}
              </HStack>
            )}
          </Field.Root>
          <ShortcutRecorder value={shortcut} onChange={setShortcut} />
          {plan.problem ? (
            <Text textStyle="sm" color="fg.error" data-tag-problem>
              {plan.problem}
            </Text>
          ) : (
            plan.effects.length > 0 && (
              <Stack gap="1" textStyle="sm" data-tag-effect>
                {plan.effects.map((e) => (
                  <Text key={e}>{e}</Text>
                ))}
              </Stack>
            )
          )}
        </Stack>
      </Dialog.Body>
      <Dialog.Footer>
        <Dialog.ActionTrigger asChild>
          <Button variant="outline">Cancel</Button>
        </Dialog.ActionTrigger>
        <Button type="submit" colorPalette="orange" disabled={plan.problem !== null} loading={saving}>
          {plan.action}
        </Button>
      </Dialog.Footer>
      <Dialog.CloseTrigger asChild>
        <CloseButton size="sm" />
      </Dialog.CloseTrigger>
    </Dialog.Content>
  );
}

/** Keys pressed apart by more than this start a new shortcut rather than continuing one. */
const RECORD_GAP = 1500;

interface LayoutMap {
  get(code: string): string | undefined;
}

/**
 * Records a shortcut: focus it and press the keys, one press after another for a
 * sequence (Ctrl+Alt+O, then Ctrl+Alt+A). A pause starts it again. Escape and Tab
 * aren't recorded (they close the dialog, move the focus).
 */
function ShortcutRecorder({ value, onChange }: { value: Shortcut | null; onChange: (s: Shortcut | null) => void }) {
  const last = useRef(0);
  // What each key shows without modifiers (Chrome, Edge): `A` on AZERTY, not `Q`.
  const layout = useRef<LayoutMap | null>(null);
  useEffect(() => {
    const keyboard = (navigator as { keyboard?: { getLayoutMap?(): Promise<LayoutMap> } }).keyboard;
    void keyboard
      ?.getLayoutMap?.()
      .then((m) => (layout.current = m))
      .catch(() => {});
  }, []);
  return (
    <Field.Root>
      <Field.Label>Shortcut</Field.Label>
      <HStack w="full" gap="2">
        <Box
          tabIndex={0}
          role="textbox"
          aria-label="Shortcut: press the keys"
          data-shortcut-recorder
          flex="1"
          px="3"
          py="1.5"
          borderWidth="1px"
          rounded="l2"
          bg="bg.subtle"
          fontFamily="numeric"
          textStyle="sm"
          cursor="text"
          _focus={{ outline: '2px solid', outlineColor: 'orange.focusRing', outlineOffset: '-1px' }}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape' || ev.key === 'Tab') return;
            ev.preventDefault();
            ev.stopPropagation();
            const press = pressOf(ev.nativeEvent);
            if (!press || ev.repeat) return;
            const shown = layout.current?.get(press.code);
            if (shown) press.key = shown;
            else if (!/^[\p{L}\p{N}]$/u.test(press.key) || press.ctrl || press.alt || press.meta)
              press.key = press.code.replace(/^(Key|Digit)/, '');
            const now = Date.now();
            const goesOn = !!value && value.length < 4 && now - last.current < RECORD_GAP;
            last.current = now;
            onChange(goesOn ? [...value, press] : [press]);
          }}
        >
          {value ? (
            formatShortcut(value)
          ) : (
            <Text as="span" color="fg.subtle" fontFamily="body">
              None: click here, then press the keys
            </Text>
          )}
        </Box>
        <Button size="sm" variant="outline" disabled={!value} onClick={() => onChange(null)}>
          Clear
        </Button>
      </HStack>
      <Field.HelperText>
        Adds the tag to the selected photos, or removes it. For a sequence, press the first keys, release, then the next
        within a second and a half (Ctrl+Alt+O, Ctrl+Alt+A); while it’s typed, no other shortcut fires.
      </Field.HelperText>
    </Field.Root>
  );
}
