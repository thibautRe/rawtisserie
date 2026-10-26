import { Center, Spinner } from '@chakra-ui/react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useMe } from '../api/hooks.ts';

export function RequireAuth() {
  const { data: user, isPending } = useMe();
  const location = useLocation();
  if (isPending) {
    return (
      <Center h="full">
        <Spinner color="orange.solid" />
      </Center>
    );
  }
  if (!user) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  return <Outlet />;
}
