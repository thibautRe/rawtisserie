import { Box, Button, Center, Flex, Heading, Progress, Spinner, Stack, Text } from '@chakra-ui/react';
import {
  AUTO_RECIPE_LABEL,
  type PhotoMetadata,
  denoiseKeyName,
  normalizeEditParams,
  originalRecipe,
} from '@rawtisserie/pipeline';
import { FolderOpen, LibraryBig, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api/client.ts';
import { fetchDenoised, fetchOriginal, keepDenoised } from '../api/originals.ts';
import { useMe, usePhoto, useSaveHistory, type UploadResult } from '../api/hooks.ts';
import { AppMenu } from '../components/AppMenu.tsx';
import { toaster } from '../components/toaster.tsx';
import { type LibraryReturnState, libraryPath } from '../library/libraryView.ts';
import { PHOTO_ACCEPT } from '../lib/format.ts';
import { useLeaveWarning } from '../lib/useLeaveWarning.ts';
import { DeveloperView } from './DeveloperView.tsx';
import { FilmRoll } from './FilmRoll.tsx';
import { fileExportInfo, photoExportInfo } from './exportInfo.ts';
import type { HistoryOp, HistorySnapshot } from './history.ts';
import { VersionMenu } from './VersionMenu.tsx';
import { LocalRenderBackend } from './localRenderBackend.ts';
import { fetchDenoiseModel } from './denoiseModels.ts';
import { lutTable } from './luts.ts';
import { defaultRecipeFor, preloadLensfun } from './lensfun.ts';

function useLocalBackend() {
  const [backend, setBackend] = useState<LocalRenderBackend | null>(null);
  useEffect(() => {
    const b = new LocalRenderBackend();
    b.setLutSource(lutTable);
    setBackend(b);
    return () => b.dispose();
  }, []);
  return backend;
}

function Loading({ label, progress }: { label: string; progress?: number }) {
  return (
    <Center h="full">
      <Stack align="center" gap="4" w="xs">
        <Spinner color="orange.solid" size="lg" />
        <Text color="fg.muted">{label}</Text>
        {progress !== undefined && (
          <Progress.Root value={progress * 100} w="full" size="xs" colorPalette="orange">
            <Progress.Track>
              <Progress.Range />
            </Progress.Track>
          </Progress.Root>
        )}
      </Stack>
    </Center>
  );
}

// ── Public developer: local files, processed entirely in the browser ──────────

export function LocalDevelopPage() {
  const backend = useLocalBackend();
  const { data: me } = useMe();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [loaded, setLoaded] = useState<{ file: File; metadata: PhotoMetadata } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!backend || !file) return;
    let cancelled = false;
    setLoaded(null);
    setError(null);
    // Nothing kept for local files: their denoising runs again each time they're opened.
    backend.setDenoiseSource({ model: fetchDenoiseModel, original: () => file.arrayBuffer() });
    file
      .arrayBuffer()
      .then((bytes) => backend.load(bytes))
      // Its first entry may use lensfun's database (`autoApplied`).
      .then(async (metadata) => (await preloadLensfun(metadata), metadata))
      .then((metadata) => !cancelled && setLoaded({ file, metadata }))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [backend, file]);

  /** Upload the file, then save the whole in-memory history to its version. */
  const saveToLibrary = async ({ entries, end }: HistorySnapshot) => {
    if (!loaded) return;
    setSavingToLibrary(true);
    try {
      const form = new FormData();
      form.append('files', loaded.file);
      // Asked for this one file: added even if it was deleted for good before.
      const { created, skipped } = await api.post<UploadResult>('/api/photos?allowDeleted=true', form);
      const version = created[0];
      if (!version) throw new Error(skipped[0]?.reason ?? 'Upload failed');
      if (entries.length) {
        const ops: HistoryOp[] = [{ type: 'splice', from: 1, entries: [...entries], end }];
        await api.post(`/api/versions/${version.id}/history`, { ops });
      }
      toaster.create({ type: 'success', title: 'Added to your library' });
      navigate(`/versions/${version.id}/develop`);
    } catch (err) {
      toaster.create({
        type: 'error',
        title: 'Could not add to library',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSavingToLibrary(false);
    }
  };

  const picker = (
    <input
      ref={input}
      type="file"
      accept={PHOTO_ACCEPT}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) setFile(f);
        e.target.value = '';
      }}
    />
  );

  if (backend && loaded) {
    return (
      <>
        {picker}
        <DeveloperView
          key={loaded.file.name + loaded.file.lastModified}
          backend={backend}
          filename={loaded.file.name}
          metadata={loaded.metadata}
          exportInfo={fileExportInfo(loaded.file.name, loaded.metadata)}
          original={originalRecipe(loaded.metadata)}
          initialHistory={autoApplied(loaded.metadata)}
          actions={(history) => (
            <>
              {/* Edits live only in this tab: anything past the automatic entry is lost on leaving. */}
              <LeaveWarning active={history.entries.length > 1} />
              <Button size="sm" variant="ghost" onClick={() => input.current?.click()}>
                <FolderOpen /> Open…
              </Button>
              {me && (
                <Button
                  size="sm"
                  colorPalette="orange"
                  loading={savingToLibrary}
                  onClick={() => void saveToLibrary(history)}
                >
                  <LibraryBig /> Add to library
                </Button>
              )}
            </>
          )}
        />
      </>
    );
  }

  if (file && !error) return <Loading label={`Decoding ${file.name}…`} />;

  return (
    <Center
      h="full"
      p="6"
      position="relative"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) setFile(f);
      }}
    >
      {picker}
      <Box position="absolute" top="2" left="3">
        <AppMenu />
      </Box>
      <Stack
        align="center"
        gap="5"
        textAlign="center"
        maxW="lg"
        p="12"
        borderWidth="2px"
        borderStyle="dashed"
        borderRadius="xl"
        borderColor={dragging ? 'orange.solid' : 'border'}
        bg={dragging ? 'orange.subtle' : undefined}
      >
        <Text fontSize="5xl" lineHeight="1">
          🍗
        </Text>
        <Heading size="2xl">Develop a RAW file</Heading>
        <Text color="fg.muted">
          Drop a RAW file here (ARW, CR2, CR3, NEF, DNG, RAF, ORF, RW2…) to develop it: exposure, white balance, tone
          mapping, colour, sharpening, crop & straighten. Export the result as a JPEG. JPEG, PNG, TIFF and WebP images
          open too, for lighter touches.
        </Text>
        <Button colorPalette="orange" size="lg" onClick={() => input.current?.click()} disabled={!backend}>
          <FolderOpen /> Open a RAW file
        </Button>
        <Text textStyle="sm" color="fg.muted" display="flex" alignItems="center" gap="1.5">
          <ShieldCheck size={16} /> Processed entirely in your browser — your file is never uploaded.
        </Text>
        {error && (
          <Box color="fg.error" textStyle="sm">
            Could not open this file: {error}
          </Box>
        )}
      </Stack>
    </Center>
  );
}

function LeaveWarning({ active }: { active: boolean }) {
  useLeaveWarning(active);
  return null;
}

/**
 * The history a new file starts with: what the server records for a new upload
 * (`addDefaultRecipe` in the render queue). Its auto-tunes run once the image is in.
 */
function autoApplied(metadata: PhotoMetadata): HistorySnapshot {
  const recipe = defaultRecipeFor(metadata);
  return { entries: [{ label: AUTO_RECIPE_LABEL, recipe, createdAt: new Date().toISOString() }], end: 1 };
}

// ── Library developer: originals fetched from the server, recipes saved back ──

export function LibraryDevelopPage() {
  const id = useParams().id!;
  return (
    <Flex direction="column" h="full">
      <Box flex="1" minH="0">
        <LibraryDeveloper id={id} />
      </Box>
      {/* Outside the developer: it stays while the next photo loads. */}
      <FilmRoll currentId={id} />
    </Flex>
  );
}

function LibraryDeveloper({ id }: { id: string }) {
  const backend = useLocalBackend();
  const { data: photo, error: photoError } = usePhoto(id);
  const save = useSaveHistory(id);
  const navigate = useNavigate();
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState<{ url: string; metadata: PhotoMetadata } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const originalUrl = photo?.originalUrl;
  // Versions of the same photo share the original: switching between them keeps it loaded.
  const loadedUrl = useRef<string | null>(null);

  // The recipe the photo opens with: its denoised photo, if one is kept, opens instead of the RAW file.
  const openingKey = photo?.editParams ? denoiseKeyName(normalizeEditParams(photo.editParams)) : null;
  const opening = useRef(openingKey);
  opening.current = openingKey;

  useEffect(() => {
    if (!backend || !originalUrl) return;
    backend.setDenoiseSource({
      model: fetchDenoiseModel,
      original: () => fetchOriginal(originalUrl),
      keep: (key, file) => keepDenoised(originalUrl, key, file),
    });
  }, [backend, originalUrl]);

  useEffect(() => {
    if (!backend || !originalUrl || loadedUrl.current === originalUrl) return;
    let cancelled = false;
    let done = false;
    loadedUrl.current = originalUrl;
    setLoaded(null);
    setError(null);
    const key = opening.current;
    (key ? fetchDenoised(originalUrl, key) : Promise.resolve(null))
      .then(async (denoised) => {
        if (denoised) {
          setProgress(1);
          return backend.loadDenoised(denoised);
        }
        return backend.load(await fetchOriginal(originalUrl, { onProgress: setProgress }));
      })
      // For `autoApplied`, if the server hasn't recorded the first entry yet.
      .then(async (metadata) => (await preloadLensfun(metadata), metadata))
      .then((metadata) => !cancelled && setLoaded({ url: originalUrl, metadata }))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => (done = !cancelled));
    return () => {
      cancelled = true;
      // An interrupted load must start over next time.
      if (!done && loadedUrl.current === originalUrl) loadedUrl.current = null;
    };
  }, [backend, originalUrl]);
  const metadata = loaded && loaded.url === originalUrl ? loaded.metadata : null;

  const err = error ?? (photoError instanceof Error ? photoError.message : null);
  if (err) {
    return (
      <Center h="full">
        <Stack align="center">
          <Text color="fg.error">{err}</Text>
          <Button asChild variant="outline">
            <Link to={libraryPath()}>Back to library</Link>
          </Button>
        </Stack>
      </Center>
    );
  }
  if (!photo || !backend) return <Loading label="Loading…" />;
  if (!metadata)
    return (
      <Loading
        label={progress < 1 ? `Downloading ${photo.filename}…` : `Decoding ${photo.filename}…`}
        progress={progress}
      />
    );

  return (
    <DeveloperView
      key={photo.id}
      backend={backend}
      filename={photo.filename}
      metadata={metadata}
      exportInfo={photoExportInfo(photo, metadata)}
      original={originalRecipe(metadata)}
      initialHistory={{
        entries: photo.history.map((h) => ({ ...h, recipe: normalizeEditParams(h.recipe) })),
        end: photo.historyEnd,
      }}
      save={save}
      revision={photo.revision}
      // No history: the server hasn't rendered it yet, and would record its automatic
      // entry after the developer opened (the version keeps it either way).
      startWith={photo.history.length === 0 ? autoApplied(metadata) : null}
      versions={(whenSaved) => <VersionMenu photo={photo} whenSaved={whenSaved} />}
      onBack={() => navigate(libraryPath(), { state: { focus: photo.id } satisfies LibraryReturnState })}
    />
  );
}
