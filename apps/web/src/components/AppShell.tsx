import { Box } from '@chakra-ui/react';
import { Outlet } from 'react-router';

/** Full-height page. Navigation lives in each page's toolbar (see `AppMenu`). */
export function AppShell() {
  return (
    <Box as="main" h="100vh">
      <Outlet />
    </Box>
  );
}
