import {
  Box,
  Button,
  Center,
  CloseButton,
  Dialog,
  Field,
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
  Keyboard,
  Pencil,
  Plus,
  Search,
  Tag,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTagChange, useTagManager } from '../api/hooks.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { toaster } from '../components/toaster.tsx';
import { fold } from '../lib/fuzzy.ts';
import { type Shortcut, formatShortcut, pressOf } from '../lib/keys.ts';
import { type TagInfo, describeDelete, managedTags, planEdit, plural } from '../lib/tagManager.ts';
import { type TagNode, displayTag, isUnder, tagName, tagParent } from '../lib/tags.ts';

/**
 * What the tag editor opens on: a tag to edit, or a new one (under `parent`), and the
 * field to start with. Places in the app open it with what they know filled in.
 */
export interface EditorTarget {
  /** The tag edited; absent for a new one. */
  tag?: string;
  /** For a new one: where it goes. */
  parent?: string | null;
  focus?: 'name' | 'shortcut';
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
                  <Menu.Item value="shortcut" onSelect={() => setEditing({ tag: n.path, focus: 'shortcut' })}>
                    <Keyboard /> Shortcut…
                  </Menu.Item>
                  <Menu.Item value="create" onSelect={() => setEditing({ parent: n.path })}>
                    <CornerDownRight /> New tag inside it…
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
      <Stack gap="2" textStyle="sm" color="fg.muted">
        <Text>
          Tags can contain other tags: <b>People › Alice</b> is the tag Alice, inside People. Filtering the library by
          People shows the photos tagged People or any tag inside it.
        </Text>
        <Text>
          When tagging a photo, type <b>|</b> between the levels: <b>People|Alice</b>. A tag can also get a keyboard
          shortcut, to add it to the selected photos or remove it.
        </Text>
        <Text>Changes made here apply to every photo with the tag, those in the trash too.</Text>
      </Stack>
      <InputGroup startElement={<Search size={14} />} maxW="xs">
        <Input size="sm" placeholder="Find a tag…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </InputGroup>
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

/**
 * Creating a tag or editing one: where it goes (Parent), its name, its shortcut. What
 * saving will do is said below, as it's edited (`planEdit`), before the button doing it.
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
        document.querySelector<HTMLElement>(t?.focus === 'shortcut' ? '[data-shortcut-recorder]' : '[data-tag-name]')
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
  info,
  onDone,
}: {
  target: EditorTarget;
  info: ReadonlyMap<string, TagInfo>;
  onDone: () => void;
}) {
  const change = useTagChange();
  const tag = target.tag ?? null;
  const [parent, setParent] = useState((tag === null ? target.parent : tagParent(tag)) ?? '');
  const [name, setName] = useState(tag === null ? '' : tagName(tag));
  const [shortcut, setShortcut] = useState<Shortcut | null>(tag === null ? null : (info.get(tag)?.shortcut ?? null));
  const [saving, setSaving] = useState(false);
  const plan = planEdit({ tag, parent, name, shortcut }, info);
  // Where it can go: anywhere but inside itself.
  const parents = [...info.keys()].filter((p) => tag === null || !isUnder(p, tag)).sort((a, b) => a.localeCompare(b));

  const save = async () => {
    if (plan.problem !== null || saving) return;
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
            <Field.Label>Parent</Field.Label>
            <NativeSelect.Root size="sm">
              <NativeSelect.Field value={parent} onChange={(e) => setParent(e.target.value)} aria-label="Parent">
                <option value="">None (top level)</option>
                {parents.map((p) => (
                  <option key={p} value={p}>
                    {displayTag(p)}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field.Root>
          <Field.Root>
            <Field.Label>Name</Field.Label>
            <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} data-tag-name />
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
