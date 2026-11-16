import { Box } from '@chakra-ui/react';
import { Outlet } from 'react-router';
import { ExportProgress } from '../export/ExportProgress.tsx';

/** Full-height page. Navigation lives in each page's toolbar (see `AppMenu`). */
export function AppShell() {
  return (
    // dvh: on phones, the height between the browser's toolbars as they are now.
    <Box as="main" h="100dvh">
      <Outlet />
      {/* A library export keeps going from one page to the next. */}
      <ExportProgress />
    </Box>
  );
}
