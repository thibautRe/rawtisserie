import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLibraryPhotos } from '../api/hooks.ts';
import type { Photo } from '@rawtisserie/api';
import { FilmRoll as Roll } from '../library/FilmRoll.tsx';
import { savedLibraryView } from '../library/libraryView.ts';

/**
 * The library's photos (with the filters and sort it was left with) as a strip under
 * the developer, the current one in the middle. A click develops another one.
 */
export const FilmRoll = memo(function FilmRoll({ currentId }: { currentId: string }) {
  const navigate = useNavigate();
  // The library's query when the developer was opened: it doesn't change from one photo
  // to the next. And where the photo was in it, so its page is asked for first.
  const [opened] = useState(() => {
    const view = savedLibraryView();
    return { search: view?.search ?? '', index: Math.max(0, view?.focusedIndex ?? 0) };
  });
  const library = useLibraryPhotos(opened.search);
  const { items, want } = library;
  useEffect(() => want(opened.index, opened.index), [want, opened.index]);

  // Where the current photo is: where it was picked, or found among the pages in.
  const lastIndex = useRef(opened.index);
  const current = useMemo(
    () =>
      items[lastIndex.current]?.id === currentId ? lastIndex.current : items.findIndex((p) => p?.id === currentId),
    [items, currentId],
  );
  if (current >= 0) lastIndex.current = current;

  const open = useCallback(
    (photo: Photo, index: number) => {
      lastIndex.current = index;
      navigate(`/versions/${photo.id}/develop`);
    },
    [navigate],
  );

  if (!library.total) return null;
  return <Roll items={items} current={current} onRange={want} onSelect={open} />;
});
