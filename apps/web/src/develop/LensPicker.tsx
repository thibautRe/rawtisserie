/**
 * The lens module's source (roadmap 3.6): the file's embedded data, or a lens from
 * lensfun's database, matched automatically or picked here. A picked lens is
 * interpolated for this shot (its focal length and aperture) and kept in the recipe.
 */
import { Box, Button, CloseButton, Dialog, HStack, Input, Portal, Spinner, Stack, Text } from '@chakra-ui/react';
import type { Lensfun, LensfunLens, LensfunProfile, LensfunShot } from '@rawtisserie/pipeline';
import { memo, useEffect, useMemo, useState } from 'react';
import { loadLensfun } from './lensfun.ts';

/** Rows shown at once: the rest is found by searching. */
const MAX_ROWS = 150;

/** What a lensfun profile corrects, as a short list. */
export function lensfunParts(p: LensfunProfile): string {
  const parts = [p.distortion && 'distortion', p.tca && 'chromatic aberration', p.vignetting && 'vignetting'];
  return parts.filter(Boolean).join(', ');
}

/** The lens section's first row: where the correction comes from, and a button to change it. */
export const LensSource = memo(function LensSource({
  embedded,
  lensfun,
  shot,
  onPick,
}: {
  /** Source of the file's embedded data (`PhotoMetadata.lensCorrection`), if any. */
  embedded: string | null;
  /** The recipe's lensfun profile, if it uses one. */
  lensfun: LensfunProfile | null;
  shot: LensfunShot;
  /** A lensfun profile, or null for the file's embedded data. */
  onPick: (profile: LensfunProfile | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = lensfun ? lensfun.lens : embedded ? `Camera data (${makerName(embedded)})` : null;
  return (
    <Stack gap="1">
      <HStack justify="space-between" gap="2">
        <Box minW="0">
          <Text textStyle="xs" truncate title={name ?? undefined} color={name ? undefined : 'fg.subtle'}>
            {name ?? 'No lens profile'}
          </Text>
          <Text textStyle="2xs" color="fg.subtle" truncate>
            {lensfun
              ? `lensfun · ${lensfunParts(lensfun) || 'nothing for this shot'}`
              : embedded
                ? 'From the file'
                : shot.lensModel
                  ? `${shot.lensModel} isn't in lensfun's database`
                  : 'The file doesn’t name its lens'}
          </Text>
        </Box>
        <Button size="2xs" variant="outline" flexShrink={0} onClick={() => setOpen(true)}>
          {name ? 'Change…' : 'Choose…'}
        </Button>
      </HStack>
      {open && (
        <LensPicker
          shot={shot}
          embedded={embedded}
          current={lensfun?.lens ?? null}
          onClose={() => setOpen(false)}
          onPick={(p) => {
            setOpen(false);
            onPick(p);
          }}
        />
      )}
    </Stack>
  );
});

const makerName = (source: string) => source.charAt(0).toUpperCase() + source.slice(1);

interface Row {
  lens: LensfunLens;
  profile: LensfunProfile | null;
}

/** Lenses with a calibration for this shot first (the generic ones have none), in order otherwise. */
const usableFirst = (rows: Row[]) => [...rows.filter((r) => r.profile), ...rows.filter((r) => !r.profile)];

function LensPicker({
  shot,
  embedded,
  current,
  onClose,
  onPick,
}: {
  shot: LensfunShot;
  embedded: string | null;
  current: string | null;
  onClose: () => void;
  onPick: (profile: LensfunProfile | null) => void;
}) {
  const [db, setDb] = useState<Lensfun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let cancelled = false;
    loadLensfun()
      .then((lf) => !cancelled && setDb(lf))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const camera = useMemo(() => db?.findCamera(shot.make, shot.model)?.camera ?? null, [db, shot]);
  const detected = useMemo(
    () => (db && shot.lensModel ? db.findLenses(camera, shot.lensModel).slice(0, 5) : []),
    [db, camera, shot],
  );
  const lists = useMemo(() => {
    if (!db) return null;
    const row = (lens: LensfunLens): Row => ({ lens, profile: db.profile(lens, camera?.crop ?? null, shot) });
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = db.lenses(camera);
    if (words.length) {
      const hay = (l: LensfunLens) => [...l.maker, ...l.model].join(' ').toLowerCase();
      const found = all.filter((l) => words.every((w) => hay(l).includes(w)));
      return {
        detected: [],
        others: usableFirst(found.map(row)).slice(0, MAX_ROWS),
        more: Math.max(0, found.length - MAX_ROWS),
      };
    }
    const shown = new Set(detected.map((d) => d.lens));
    const mounts = camera ? db.mountsFor(camera.mount) : [];
    const fitting = all.filter((l) => !shown.has(l) && l.mounts.some((m) => mounts.includes(m)));
    return {
      detected: detected.map((d) => row(d.lens)),
      others: usableFirst(fitting.map(row)).slice(0, MAX_ROWS),
      more: Math.max(0, (camera ? fitting.length : all.length) - MAX_ROWS),
    };
  }, [db, camera, detected, query, shot]);

  const focal = shot.focalLength ? `${Math.round(shot.focalLength)} mm` : 'unknown focal length';
  const aperture = shot.fNumber ? ` f/${shot.fNumber}` : '';
  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} size="md" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header flexDirection="column" alignItems="stretch" gap="2">
              <Dialog.Title>Lens profile</Dialog.Title>
              <Text textStyle="xs" color="fg.muted">
                {shot.make} {shot.model}
                {camera ? '' : ' (not in lensfun’s database)'} · {shot.lensModel ?? 'lens not named'} · {focal}
                {aperture}
              </Text>
              <Input
                size="sm"
                placeholder="Search lensfun’s lenses"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                autoFocus
              />
            </Dialog.Header>
            <Dialog.Body>
              {error ? (
                <Text textStyle="sm" color="fg.error">
                  Could not load lensfun’s database: {error}
                </Text>
              ) : !lists ? (
                <HStack justify="center" py="6">
                  <Spinner size="sm" color="orange.solid" />
                </HStack>
              ) : (
                <Stack gap="3">
                  {embedded && !query && (
                    <Group title="From the file">
                      <PickRow
                        name={`Camera data (${makerName(embedded)})`}
                        detail="The correction the camera recorded in the file"
                        selected={!current}
                        onClick={() => onPick(null)}
                      />
                    </Group>
                  )}
                  {lists.detected.length > 0 && (
                    <Group title={`Matching “${shot.lensModel}”`}>
                      {lists.detected.map((r) => (
                        <LensRow key={r.lens.model[0]} row={r} current={current} onPick={onPick} />
                      ))}
                    </Group>
                  )}
                  <Group
                    title={
                      query
                        ? 'Lenses found'
                        : camera
                          ? `Other lenses for ${camera.mount}`
                          : 'Lenses in lensfun’s database'
                    }
                  >
                    {lists.others.map((r) => (
                      <LensRow key={r.lens.model[0]} row={r} current={current} onPick={onPick} />
                    ))}
                    {lists.others.length === 0 && (
                      <Text textStyle="xs" color="fg.subtle" px="2">
                        No lens found
                      </Text>
                    )}
                    {lists.more > 0 && (
                      <Text textStyle="2xs" color="fg.subtle" px="2" pt="1">
                        {lists.more} more: search to find them
                      </Text>
                    )}
                  </Group>
                  <Text textStyle="2xs" color="fg.subtle">
                    Profiles from the lensfun project’s database, CC BY-SA 3.0.
                  </Text>
                </Stack>
              )}
            </Dialog.Body>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack gap="0.5">
      <Text textStyle="label" color="fg.muted" px="2">
        {title}
      </Text>
      {children}
    </Stack>
  );
}

function LensRow({
  row,
  current,
  onPick,
}: {
  row: Row;
  current: string | null;
  onPick: (profile: LensfunProfile) => void;
}) {
  const { lens, profile } = row;
  const about = [lens.maker[0], lens.mounts.join(', '), lens.type].filter(Boolean).join(' · ');
  return (
    <PickRow
      name={lens.model[0]!}
      detail={profile ? `${about} · ${lensfunParts(profile)}` : `${about} · no calibration for this sensor or shot`}
      selected={current === lens.model[0]}
      disabled={!profile}
      onClick={() => profile && onPick(profile)}
    />
  );
}

function PickRow({
  name,
  detail,
  selected,
  disabled,
  onClick,
}: {
  name: string;
  detail: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Box
      as="button"
      textAlign="start"
      px="2"
      py="1.5"
      borderRadius="l2"
      bg={selected ? 'orange.subtle' : undefined}
      _hover={disabled ? undefined : { bg: selected ? 'orange.subtle' : 'bg.muted' }}
      opacity={disabled ? 0.5 : 1}
      cursor={disabled ? 'not-allowed' : 'pointer'}
      aria-disabled={disabled}
      aria-pressed={selected}
      onClick={disabled ? undefined : onClick}
    >
      <Text textStyle="sm" truncate>
        {name}
      </Text>
      <Text textStyle="2xs" color="fg.muted" truncate>
        {detail}
      </Text>
    </Box>
  );
}
