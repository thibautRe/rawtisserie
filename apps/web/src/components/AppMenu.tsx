import { Box, IconButton, Menu, Portal, Text } from '@chakra-ui/react';
import { Aperture, Images, LogIn, LogOut } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { useLogout, useMe } from '../api/hooks.ts';

/**
 * App navigation and account, folded into one button at the start of each page's
 * toolbar (there is no app-wide header, to leave the vertical space to photos).
 */
export function AppMenu() {
  const { data: user } = useMe();
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
              <Menu.Item value="library" disabled={pathname === '/'} onClick={() => navigate('/')}>
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
                </Box>
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
}
