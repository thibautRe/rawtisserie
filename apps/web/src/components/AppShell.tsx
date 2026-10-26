import { Box, Button, Flex, HStack, Menu, Portal, Spacer, Text } from '@chakra-ui/react';
import { Aperture, Images, LogOut } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useLogout, useMe } from '../api/hooks.ts';
import { Logo } from './Logo.tsx';

function NavItem({ to, icon, children }: { to: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <NavLink to={to} end>
      {({ isActive }) => (
        <Button as="span" size="sm" variant={isActive ? 'subtle' : 'ghost'} colorPalette={isActive ? 'orange' : 'gray'}>
          {icon}
          {children}
        </Button>
      )}
    </NavLink>
  );
}

export function AppShell() {
  const { data: user } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <Flex direction="column" h="100vh">
      <HStack as="header" px="4" h="12" borderBottomWidth="1px" bg="bg.panel" flexShrink={0} gap="4">
        <NavLink to={user ? '/' : '/develop'}>
          <Logo />
        </NavLink>
        <HStack gap="1">
          {user && (
            <NavItem to="/" icon={<Images />}>
              Library
            </NavItem>
          )}
          <NavItem to="/develop" icon={<Aperture />}>
            Developer
          </NavItem>
        </HStack>
        <Spacer />
        {user ? (
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button size="sm" variant="ghost">
                {user.displayName}
              </Button>
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner>
                <Menu.Content>
                  <Box px="2" py="1.5">
                    <Text textStyle="xs" color="fg.muted">
                      {user.email}
                    </Text>
                  </Box>
                  <Menu.Separator />
                  <Menu.Item
                    value="logout"
                    onClick={() => logout.mutate(undefined, { onSuccess: () => navigate('/login') })}
                  >
                    <LogOut /> Log out
                  </Menu.Item>
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
        ) : (
          <Button size="sm" colorPalette="orange" onClick={() => navigate('/login')}>
            Log in
          </Button>
        )}
      </HStack>
      <Box as="main" flex="1" minH="0">
        <Outlet />
      </Box>
    </Flex>
  );
}
