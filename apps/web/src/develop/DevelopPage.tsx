import { Box, Button, Center, Heading, Progress, Spinner, Stack, Text } from '@chakra-ui/react';
import { type EditParams, type PhotoMetadata, defaultEditParams, normalizeEditParams } from '@rawtisserie/pipeline';
import { ArrowLeft, FolderOpen, LibraryBig, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, fetchBytes } from '../api/client.ts';
import { useMe, usePhoto, useSaveEdit, type UploadResult } from '../api/hooks.ts';
import { toaster } from '../components/toaster.tsx';
import { RAW_ACCEPT } from '../lib/format.ts';
import { DeveloperView } from './DeveloperView.tsx';
import { PipelineClient } from './pipelineClient.ts';

function usePipelineClient() {
  const [client, setClient] = useState<PipelineClient | null>(null);
  useEffect(() => {
    const c = new PipelineClient();
    setClient(c);
    return () => c.dispose();
  }, []);
  return client;
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
  const client = usePipelineClient();
  const { data: me } = useMe();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [loaded, setLoaded] = useState<{ file: File; metadata: PhotoMetadata } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!client || !file) return;
    let cancelled = false;
    setLoaded(null);
    setError(null);
    file
      .arrayBuffer()
      .then((bytes) => client.load(bytes))
      .then((metadata) => !cancelled && setLoaded({ file, metadata }))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [client, file]);

  const saveToLibrary = async (params: EditParams) => {
    if (!loaded) return;
    setSavingToLibrary(true);
    try {
      const form = new FormData();
      form.append('files', loaded.file);
      const { created, skipped } = await api.post<UploadResult>('/api/photos', form);
      const photo = created[0];
      if (!photo) throw new Error(skipped[0]?.reason ?? 'Upload failed');
      await api.put(`/api/photos/${photo.id}/edit`, { params });
      toaster.create({ type: 'success', title: 'Added to your library' });
      navigate(`/photos/${photo.id}/develop`);
    } catch (err) {
      toaster.create({ type: 'error', title: 'Could not add to library', description: err instanceof Error ? err.message : undefined });
    } finally {
      setSavingToLibrary(false);
    }
  };

  const picker = (
    <input
      ref={input}
      type="file"
      accept={RAW_ACCEPT}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) setFile(f);
        e.target.value = '';
      }}
    />
  );

  if (client && loaded) {
    return (
      <>
        {picker}
        <DeveloperView
          key={loaded.file.name + loaded.file.lastModified}
          client={client}
          filename={loaded.file.name}
          metadata={loaded.metadata}
          initialParams={defaultEditParams}
          actions={(params) => (
            <>
              <Button size="sm" variant="ghost" onClick={() => input.current?.click()}>
                <FolderOpen /> Open…
              </Button>
              {me && (
                <Button size="sm" colorPalette="orange" loading={savingToLibrary} onClick={() => void saveToLibrary(params)}>
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
          Drop a RAW file here (ARW, CR2, CR3, NEF, DNG, RAF, ORF, RW2…) to develop it: exposure, white balance,
          tone mapping, colour, sharpening, crop & straighten. Export the result as a JPEG.
        </Text>
        <Button colorPalette="orange" size="lg" onClick={() => input.current?.click()} disabled={!client}>
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

// ── Library developer: originals fetched from the server, recipes saved back ──

export function LibraryDevelopPage() {
  const { id } = useParams();
  const client = usePipelineClient();
  const { data: photo, error: photoError } = usePhoto(id);
  const saveEdit = useSaveEdit();
  const [progress, setProgress] = useState(0);
  const [metadata, setMetadata] = useState<PhotoMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const originalUrl = photo?.originalUrl;

  useEffect(() => {
    if (!client || !originalUrl) return;
    let cancelled = false;
    setMetadata(null);
    setError(null);
    fetchBytes(originalUrl, setProgress)
      .then((bytes) => client.load(bytes))
      .then((m) => !cancelled && setMetadata(m))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [client, originalUrl]);

  const err = error ?? (photoError instanceof Error ? photoError.message : null);
  if (err) {
    return (
      <Center h="full">
        <Stack align="center">
          <Text color="fg.error">{err}</Text>
          <Button asChild variant="outline">
            <Link to="/">Back to library</Link>
          </Button>
        </Stack>
      </Center>
    );
  }
  if (!photo || !client) return <Loading label="Loading…" />;
  if (!metadata) return <Loading label={progress < 1 ? `Downloading ${photo.filename}…` : `Decoding ${photo.filename}…`} progress={progress} />;

  return (
    <DeveloperView
      key={photo.id}
      client={client}
      filename={photo.filename}
      metadata={metadata}
      initialParams={photo.editParams ? normalizeEditParams(photo.editParams) : defaultEditParams}
      onSave={(params) => saveEdit.mutateAsync({ id: photo.id, params })}
      saving={saveEdit.isPending}
      actions={() => (
        <Button asChild size="sm" variant="ghost">
          <Link to="/">
            <ArrowLeft /> Library
          </Link>
        </Button>
      )}
    />
  );
}
