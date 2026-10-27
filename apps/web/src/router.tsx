import { createBrowserRouter } from 'react-router';
import { AppShell } from './components/AppShell.tsx';
import { RequireAuth } from './components/RequireAuth.tsx';
import { LibraryDevelopPage, LocalDevelopPage } from './develop/DevelopPage.tsx';
import { LibraryPage } from './library/LibraryPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/login', element: <LoginPage /> },
      // The developer works on local files without an account: nothing is uploaded.
      { path: '/develop', element: <LocalDevelopPage /> },
      {
        element: <RequireAuth />,
        children: [
          { path: '/', element: <LibraryPage /> },
          { path: '/versions/:id/develop', element: <LibraryDevelopPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
