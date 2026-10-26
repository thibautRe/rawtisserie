import { Button, Center, Heading, Stack, Text } from '@chakra-ui/react';
import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <Center h="full">
      <Stack align="center" gap="3">
        <Heading size="2xl">Undercooked 🍗</Heading>
        <Text color="fg.muted">This page doesn't exist.</Text>
        <Button asChild variant="outline">
          <Link to="/">Back to the library</Link>
        </Button>
      </Stack>
    </Center>
  );
}
