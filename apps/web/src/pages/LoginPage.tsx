import { Alert, Box, Button, Card, Center, Field, Input, Link as ChakraLink, Stack, Text } from '@chakra-ui/react';
import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { useAuthConfig, useLogin, useMe, useSignup } from '../api/hooks.ts';
import { Logo } from '../components/Logo.tsx';

export function LoginPage() {
  const [params] = useSearchParams();
  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/';
  const { data: me } = useMe();
  const { data: authConfig } = useAuthConfig();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ email: '', password: '', displayName: '' });
  const login = useLogin();
  const signup = useSignup();
  const pending = login.isPending || signup.isPending;
  const error = (mode === 'login' ? login.error : signup.error)?.message;

  if (me) return <Navigate to={next} replace />;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'login') login.mutate({ email: form.email, password: form.password });
    else signup.mutate(form);
  };
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Center h="full" p="4">
      <Stack gap="6" w="full" maxW="sm" align="center">
        <Stack align="center" gap="1">
          <Logo size="xl" />
          <Text color="fg.muted">from raw to well done</Text>
        </Stack>
        <Card.Root w="full" as="form" onSubmit={submit}>
          <Card.Body>
            <Stack gap="4">
              {mode === 'signup' && (
                <Field.Root required>
                  <Field.Label>Name</Field.Label>
                  <Input value={form.displayName} onChange={set('displayName')} autoComplete="name" />
                </Field.Root>
              )}
              <Field.Root required>
                <Field.Label>Email</Field.Label>
                <Input type="email" value={form.email} onChange={set('email')} autoComplete="email" autoFocus />
              </Field.Root>
              <Field.Root required>
                <Field.Label>Password</Field.Label>
                <Input
                  type="password"
                  value={form.password}
                  onChange={set('password')}
                  minLength={8}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
                {mode === 'signup' && <Field.HelperText>At least 8 characters.</Field.HelperText>}
              </Field.Root>
              {error && (
                <Alert.Root status="error" size="sm">
                  <Alert.Indicator />
                  <Alert.Title>{error}</Alert.Title>
                </Alert.Root>
              )}
              <Button type="submit" colorPalette="orange" loading={pending}>
                {mode === 'login' ? 'Log in' : 'Create account'}
              </Button>
            </Stack>
          </Card.Body>
        </Card.Root>
        {authConfig?.allowSignup && (
          <Text textStyle="sm" color="fg.muted">
            {mode === 'login' ? 'New here? ' : 'Already have an account? '}
            <ChakraLink as="button" color="orange.fg" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
              {mode === 'login' ? 'Create an account' : 'Log in'}
            </ChakraLink>
          </Text>
        )}
        <Box textAlign="center">
          <Text textStyle="sm" color="fg.muted">
            Just want to develop a RAW file?{' '}
            <ChakraLink asChild color="orange.fg">
              <Link to="/develop">Open the developer</Link>
            </ChakraLink>{' '}
            — no account needed, your file never leaves your browser.
          </Text>
        </Box>
      </Stack>
    </Center>
  );
}
