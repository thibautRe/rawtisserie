/**
 * Where the library was when it was left (its query string, scroll position, selection),
 * so that going back to it from the developer restores it like the browser's back
 * button would. Kept for the tab's session.
 */
export interface LibraryView {
  /** The URL's query string (filters and sort), without `?`. */
  search: string;
  scrollTop: number;
  selection: string[];
  focusedId: string | null;
  /** Where the focused photo is in the list, so the film roll asks for its page first. */
  focusedIndex?: number;
}

const KEY = 'library.view';

export function saveLibraryView(view: LibraryView) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(view));
  } catch {
    // Storage full or unavailable: going back just starts at the top.
  }
}

export function savedLibraryView(): LibraryView | null {
  try {
    const view = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as LibraryView | null;
    return view && typeof view.search === 'string' ? view : null;
  } catch {
    return null;
  }
}

/** The library's URL, with the filters and sort it was left with. */
export function libraryPath(): string {
  const search = savedLibraryView()?.search;
  return search ? `/?${search}` : '/';
}

/** What `navigate(libraryPath(), { state })` passes: the version to show in the grid. */
export interface LibraryReturnState {
  focus?: string;
}
