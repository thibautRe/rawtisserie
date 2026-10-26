import { HStack, Text } from '@chakra-ui/react';

export function Logo({ size = 'md' }: { size?: 'md' | 'xl' }) {
  return (
    <HStack gap="2" fontSize={size === 'xl' ? '3xl' : 'lg'} fontWeight="bold" letterSpacing="tight">
      <span aria-hidden>🍗</span>
      <Text as="span">
        <Text as="span" color="orange.fg">
          RAW
        </Text>
        tisserie
      </Text>
    </HStack>
  );
}
