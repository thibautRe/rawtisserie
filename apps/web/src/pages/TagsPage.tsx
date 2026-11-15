import {
  Box,
  Button,
  Center,
  CloseButton,
  Dialog,
  Field,
  Flex,
  HStack,
  Heading,
  IconButton,
  Input,
  InputGroup,
  Menu,
  NativeSelect,
  Portal,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Ellipsis,
  FolderInput,
  Keyboard,
  Pencil,
  Plus,
  Search,
  Tag,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { type TagChange, useTagChange, useTagManager } from '../api/hooks.ts';
import { type TagInfo, describeDelete, describeRename, managedTags, plural } from '../lib/tagManager.ts';
import { AppMenu } from '../components/AppMenu.tsx';
import { toaster } from '../components/toaster.tsx';
import { libraryPath } from '../library/libraryView.ts';
import { fold } from '../lib/fuzzy.ts';
import { type Shortcut, formatShortcut, pressOf, shortcutConflict } from '../lib/keys.ts';
import {
  SEPARATOR,
  type TagNode,
  displayTag,
  isUnder,
  normalizeTag,
  retag,
  tagName,
  tagParent,
  tagTree,
} from '../lib/tags.ts';

/** What the open dialog is for. */
type Editing =
  | { type: 'create'; parent: string | null }
  | { type: 'rename'; tag: string }
  | { type: 'move'; tag: string }
  | { type: 'delete'; tag: string }
  | { type: 'shortcut'; tag: string };

/**
 * The tag manager: every tag as a tree, with its photos (and those in the trash), to
 * create, rename, move, merge or delete them, each through a dialog that says what
 * will happen. Renaming and deleting apply to the tags under it too.
 */
export function TagsPage() {
  const { data, isPending } = useTagManager();
  const change = useTagChange();
  const [query, setQuery] = useState('');
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const { tree, info } = useMemo(() => (data ? managedTags(data) : { tree: [], info: new Map() }), [data]);

  const apply = (c: TagChange, done: (versions: number) => string) =>
    change.mutate(c, {
      onSuccess: (versions) => {
        setEditing(null);
        toaster.create({ type: 'success', title: done(versions) });
      },
      onError: (err) => toaster.create({ type: 'error', title: 'Could not change the tags', description: err.message }),
    });

  // Searching shows the tags matching and the way to them.
  const q = fold(query.trim());
  const shown = (n: TagNode): boolean => !q || fold(n.path).includes(q) || n.children.some(shown);
  const rows = (nodes: TagNode[], depth: number): ReactNode[] =>
    nodes.filter(shown).flatMap((n) => {
      const i = info.get(n.path)!;
      const open = q ? true : !folded.has(n.path);
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
          <Text textStyle="sm" flex="1" truncate title={displayTag(n.path)}>
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
                  <Menu.Item value="rename" onSelect={() => setEditing({ type: 'rename', tag: n.path })}>
                    <Pencil /> Rename…
                  </Menu.Item>
                  <Menu.Item value="move" onSelect={() => setEditing({ type: 'move', tag: n.path })}>
                    <FolderInput /> Move…
                  </Menu.Item>
                  <Menu.Item value="shortcut" onSelect={() => setEditing({ type: 'shortcut', tag: n.path })}>
                    <Keyboard /> Shortcut…
                  </Menu.Item>
                  <Menu.Item value="create" onSelect={() => setEditing({ type: 'create', parent: n.path })}>
                    <CornerDownRight /> New tag under it…
                  </Menu.Item>
                  <Menu.Separator />
                  <Menu.Item
                    value="delete"
                    color="fg.error"
                    onSelect={() => setEditing({ type: 'delete', tag: n.path })}
                  >
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
    <Flex direction="column" h="full">
      <HStack px="3" py="2" borderBottomWidth="1px" gap="2">
        <AppMenu />
        <HStack gap="1" color="fg.muted" textStyle="sm">
          <Link to={libraryPath()}>Library</Link>
          <ChevronRight size={14} />
        </HStack>
        <Heading size="sm">Tags</Heading>
        <Box flex="1" />
        <InputGroup startElement={<Search size={14} />} maxW="xs">
          <Input size="sm" placeholder="Find a tag…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </InputGroup>
        <Button size="sm" colorPalette="orange" onClick={() => setEditing({ type: 'create', parent: null })}>
          <Plus /> New tag
        </Button>
      </HStack>
      <Box flex="1" overflowY="auto">
        <Stack maxW="3xl" mx="auto" p="4" gap="3">
          <Text textStyle="sm" color="fg.muted">
            Tags are a tree: a photo tagged People › Alice is found under People too. Type <b>|</b> between levels when
            tagging (People|Alice). Renaming, moving or deleting a tag changes it on every photo, the trash included,
            and the tags under it with it.
          </Text>
          {isPending ? (
            <Center py="10">
              <Spinner color="orange.solid" />
            </Center>
          ) : tree.length === 0 ? (
            <Text textStyle="sm" color="fg.subtle" py="6" textAlign="center">
              No tags yet: add some to photos in the library, or create one here.
            </Text>
          ) : (
            <Box borderTopWidth="1px">{rows(tree, 0)}</Box>
          )}
        </Stack>
      </Box>
      <TagDialog
        editing={editing}
        info={info}
        busy={change.isPending}
        onClose={() => setEditing(null)}
        onApply={apply}
      />
    </Flex>
  );
}

/**
 * Creating, renaming, moving or deleting a tag: what it'll be, then what will happen
 * (in words, updated as it's typed or picked) before the button doing it.
 */
function TagDialog({
  editing,
  info,
  busy,
  onClose,
  onApply,
}: {
  editing: Editing | null;
  info: ReadonlyMap<string, TagInfo>;
  busy: boolean;
  onClose: () => void;
  onApply: (c: TagChange, done: (versions: number) => string) => void;
}) {
  // Kept while it closes, so it doesn't empty during the animation.
  const shown = useRef(editing);
  if (editing) shown.current = editing;
  const e = shown.current;
  return (
    <Dialog.Root
      open={!!editing}
      onOpenChange={(ev) => !ev.open && onClose()}
      role={e?.type === 'delete' ? 'alertdialog' : 'dialog'}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          {/* A new one starts from the tag as it is. */}
          {e && <TagForm key={JSON.stringify(e)} e={e} info={info} busy={busy} onApply={onApply} />}
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function TagForm({
  e,
  info,
  busy,
  onApply,
}: {
  e: Editing;
  info: ReadonlyMap<string, TagInfo>;
  busy: boolean;
  onApply: (c: TagChange, done: (versions: number) => string) => void;
}) {
  const [name, setName] = useState(e.type === 'rename' ? tagName(e.tag) : '');
  const [parent, setParent] = useState(e.type === 'move' ? (tagParent(e.tag) ?? '') : '');
  const [keys, setKeys] = useState<Shortcut>([]);

  let title = '';
  let body: ReactNode = null;
  let text = '';
  let action = '';
  let change: TagChange | null = null;
  let done = (_: number) => '';
  let problem = '';
  if (e.type === 'create') {
    const path = normalizeTag([e.parent, name].filter(Boolean).join(SEPARATOR));
    title = e.parent ? `New tag under ${displayTag(e.parent)}` : 'New tag';
    body = (
      <NameField
        value={name}
        onChange={setName}
        hint="Type | between levels to create several at once (Places|Paris)."
      />
    );
    if (!normalizeTag(name)) problem = ' ';
    else if (info.has(path)) problem = `${displayTag(path)} exists already.`;
    text = `Creates ${displayTag(path)}. No photo has it yet: it’s listed here and suggested when tagging.`;
    action = 'Create';
    change = { type: 'create', tag: path };
    done = () => `Created ${displayTag(path)}`;
  } else if (e.type === 'rename') {
    const to = normalizeTag([tagParent(e.tag), name.replaceAll(SEPARATOR, ' ')].filter(Boolean).join(SEPARATOR));
    title = `Rename ${displayTag(e.tag)}`;
    body = <NameField value={name} onChange={setName} hint="Its place in the tree stays: Move… changes it." />;
    if (!normalizeTag(name) || to === e.tag) problem = ' ';
    else ({ text, action } = describeRename(e.tag, to, info));
    change = { type: 'rename', from: e.tag, to };
    done = (n) => `Renamed to ${displayTag(to)}${n ? ` on ${plural(n, 'photo')}` : ''}`;
  } else if (e.type === 'move') {
    const to = parent ? `${parent}${SEPARATOR}${tagName(e.tag)}` : tagName(e.tag);
    title = `Move ${displayTag(e.tag)}`;
    const options = [...info.keys()].filter((t) => !isUnder(t, e.tag)).sort((a, b) => a.localeCompare(b));
    body = (
      <Field.Root>
        <Field.Label>Under</Field.Label>
        <NativeSelect.Root size="sm">
          <NativeSelect.Field value={parent} onChange={(ev) => setParent(ev.target.value)} aria-label="Move under">
            <option value="">The top level</option>
            {options.map((t) => (
              <option key={t} value={t}>
                {displayTag(t)}
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
      </Field.Root>
    );
    if (to === e.tag) problem = ' ';
    else ({ text, action } = describeRename(e.tag, to, info));
    change = { type: 'rename', from: e.tag, to };
    done = (n) => `Moved to ${displayTag(to)}${n ? ` on ${plural(n, 'photo')}` : ''}`;
  } else if (e.type === 'shortcut') {
    const current = info.get(e.tag)?.shortcut ?? null;
    title = `Shortcut for ${displayTag(e.tag)}`;
    body = (
      <Stack gap="3">
        <ShortcutRecorder value={keys} onChange={setKeys} />
        {current && (
          <HStack gap="2" textStyle="sm" color="fg.muted">
            <Text flex="1">Now: {formatShortcut(current)}</Text>
            <Button
              size="xs"
              variant="outline"
              loading={busy}
              onClick={() =>
                onApply({ type: 'shortcut', tag: e.tag, shortcut: null }, () => `${displayTag(e.tag)} has no shortcut`)
              }
            >
              Remove it
            </Button>
          </HStack>
        )}
      </Stack>
    );
    const others = [...info].flatMap(([tag, i]) => (tag !== e.tag ? [{ tag, shortcut: i.shortcut }] : []));
    if (!keys.length) problem = ' ';
    else problem = shortcutConflict(keys, others, displayTag) ?? '';
    if (keys.length)
      text = `${formatShortcut(keys)} will add or remove ${displayTag(e.tag)}: on the selected photos in the library, on the photo shown when culling.`;
    action = 'Save';
    change = { type: 'shortcut', tag: e.tag, shortcut: keys };
    done = () => `${formatShortcut(keys)} toggles ${displayTag(e.tag)}`;
  } else if (e.type === 'delete') {
    title = `Delete ${displayTag(e.tag)}?`;
    text = describeDelete(e.tag, info);
    action = 'Delete';
    change = { type: 'delete', tag: e.tag };
    done = (n) => `Deleted ${displayTag(e.tag)}${n ? ` from ${plural(n, 'photo')}` : ''}`;
  }

  return (
    <Dialog.Content
      as="form"
      data-tag-dialog={e.type}
      onSubmit={(ev: React.FormEvent) => {
        ev.preventDefault();
        if (change && !problem && !busy) onApply(change, done);
      }}
    >
      <Dialog.Header>
        <Dialog.Title>{title}</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <Stack gap="4">
          {body}
          {problem.trim() ? (
            <Text textStyle="sm" color="fg.error">
              {problem}
            </Text>
          ) : (
            text && (
              <Text textStyle="sm" data-tag-effect>
                {text}
              </Text>
            )
          )}
        </Stack>
      </Dialog.Body>
      <Dialog.Footer>
        <Dialog.ActionTrigger asChild>
          <Button variant="outline">Cancel</Button>
        </Dialog.ActionTrigger>
        <Button type="submit" colorPalette={e.type === 'delete' ? 'red' : 'orange'} disabled={!!problem} loading={busy}>
          {action}
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
function ShortcutRecorder({ value, onChange }: { value: Shortcut; onChange: (s: Shortcut) => void }) {
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
      <Field.Label>Keys</Field.Label>
      <Box
        tabIndex={0}
        role="textbox"
        aria-label="Press the keys"
        data-shortcut-recorder
        w="full"
        px="3"
        py="2"
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
          const goesOn = value.length > 0 && value.length < 4 && now - last.current < RECORD_GAP;
          last.current = now;
          onChange(goesOn ? [...value, press] : [press]);
        }}
      >
        {value.length ? (
          formatShortcut(value)
        ) : (
          <Text as="span" color="fg.subtle">
            Click here, then press the keys
          </Text>
        )}
      </Box>
      <Field.HelperText>
        For a sequence, press the first keys, release, then the next within a second and a half (Ctrl+Alt+O,
        Ctrl+Alt+A). While it’s typed, no other shortcut fires.
      </Field.HelperText>
    </Field.Root>
  );
}

function NameField({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint: string }) {
  return (
    <Field.Root>
      <Field.Label>Name</Field.Label>
      <Input size="sm" value={value} onChange={(e) => onChange(e.target.value)} autoFocus data-tag-name />
      <Field.HelperText>{hint}</Field.HelperText>
    </Field.Root>
  );
}
