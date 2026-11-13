import '@fontsource-variable/geologica';
import '@fontsource-variable/lilex';
import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { setOriginalsUser } from './api/originals.ts';
import type { User } from './api/types.ts';
import { Toaster } from './components/toaster.tsx';
import { router } from './router.tsx';
import { system } from './theme.ts';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

// The originals kept in the browser are the signed-in user's: follow who that is, as soon
// as it's known (before any page opens a photo).
queryClient.getQueryCache().subscribe(({ query }) => {
  if (query.queryKey[0] === 'me' && query.state.status === 'success')
    setOriginalsUser((query.state.data as User | null)?.id ?? null);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChakraProvider value={system}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
      </QueryClientProvider>
    </ChakraProvider>
  </StrictMode>,
);
