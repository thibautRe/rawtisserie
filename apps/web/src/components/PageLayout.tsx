import { Box, Flex, HStack, Heading } from '@chakra-ui/react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { AppMenu } from './AppMenu.tsx';

export interface PageTab {
  label: string;
  /** Its path. */
  to: string;
}

/**
 * A page of several tabs (Settings, Admin): the app menu, the page's title and its
 * tabs, links styled like line tabs (pages, not panels: each has its address), the
 * current one marked. The tab's content scrolls below.
 */
export function TabbedPage({
  title,
  tabs,
  label,
  children,
  maxW = '6xl',
}: {
  title: string;
  tabs: readonly PageTab[];
  /** For the tabs' nav (`Admin pages`). */
  label: string;
  children: ReactNode;
  maxW?: string;
}) {
  return (
    <Flex direction="column" h="full">
      <HStack px="3" gap={{ base: '2', md: '4' }} borderBottomWidth="1px" bg="bg.panel">
        <HStack gap="2" py="2">
          <AppMenu />
          <Heading size="sm">{title}</Heading>
        </HStack>
        <HStack as="nav" aria-label={label} gap="0" alignSelf="stretch" minW="0" overflowX="auto" scrollbarWidth="none">
          {tabs.map((t) => (
            <Box
              key={t.to}
              asChild
              display="flex"
              alignItems="center"
              h="full"
              px={{ base: '2', md: '3' }}
              flexShrink={0}
              textStyle="sm"
              fontWeight="medium"
              color="fg.muted"
              borderBottomWidth="2px"
              borderColor="transparent"
              mb="-1px"
              _hover={{ color: 'fg' }}
              _currentPage={{ color: 'fg', borderColor: 'fg' }}
              focusRing="inside"
            >
              <NavLink to={t.to} end>
                {t.label}
              </NavLink>
            </Box>
          ))}
        </HStack>
      </HStack>
      <Box flex="1" overflowY="auto">
        <Box p={{ base: '4', md: '6' }} maxW={maxW} mx="auto">
          {children}
        </Box>
      </Box>
    </Flex>
  );
}
