import { Box, IconButton, Menu, Portal, Text } from '@chakra-ui/react';
import { Aperture, Images, LogIn, LogOut, Settings, ShieldCheck } from 'lucide-react';
import { memo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useLogout, useMe, useStorage } from '../api/hooks.ts';
import { libraryPath } from '../library/libraryView.ts';
import { StorageMeter } from './StorageMeter.tsx';

/**
 * App navigation and account, folded into one button at the start of each page's
 * toolbar (there is no app-wide header, to leave the vertical space to photos).
 */
export const AppMenu = memo(function AppMenu() {
  const { data: user } = useMe();
  const { data: storage } = useStorage(!!user);
  const logout = useLogout();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <IconButton aria-label="RAWtisserie menu" title="RAWtisserie" size="sm" variant="ghost" fontSize="lg">
          <span aria-hidden>🍗</span>
        </IconButton>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="52">
            {user && (
              <Menu.Item value="library" disabled={pathname === '/'} onClick={() => navigate(libraryPath())}>
                <Images /> Library
              </Menu.Item>
            )}

            <Menu.Item value="develop" disabled={pathname === '/develop'} onClick={() => navigate('/develop')}>
              <Aperture /> Develop a local file
            </Menu.Item>
            <Menu.Separator />
            {user ? (
              <>
                <Box px="2" py="1.5">
                  <Text textStyle="sm">{user.displayName}</Text>
                  <Text textStyle="xs" color="fg.muted">
                    {user.email}
                  </Text>
                  {storage && (
                    <Box mt="2">
                      <StorageMeter usage={storage} />
                    </Box>
                  )}
                </Box>
                <Menu.Item
                  value="settings"
                  disabled={pathname.startsWith('/settings')}
                  onClick={() => navigate('/settings')}
                >
                  <Settings /> Settings
                </Menu.Item>
                {user.isAdmin && (
                  <Menu.Item value="admin" disabled={pathname === '/admin'} onClick={() => navigate('/admin')}>
                    <ShieldCheck /> Admin
                  </Menu.Item>
                )}
                <Menu.Item
                  value="logout"
                  onClick={() => logout.mutate(undefined, { onSuccess: () => navigate('/login') })}
                >
                  <LogOut /> Log out
                </Menu.Item>
              </>
            ) : (
              <Menu.Item value="login" onClick={() => navigate('/login')}>
                <LogIn /> Log in
              </Menu.Item>
            )}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
});
