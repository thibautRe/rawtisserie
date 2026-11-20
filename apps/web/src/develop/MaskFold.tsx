/**
 * The fold at the bottom of a maskable module (roadmap 4.13): what its mask does
 * (`maskSummary`), a click to add one or to show or hide its editor, and the editor
 * under it. A module with a mask has its fold in the other appearance (light in the
 * dark app), open or closed, so that masked modules stand out in the panel.
 */
import { Box, Button, Text, Theme } from '@chakra-ui/react';
import { ChevronDown, Plus, VenetianMask } from 'lucide-react';
import { type ReactNode, useSyncExternalStore } from 'react';

const LABEL_PROPS = {
  textStyle: '2xs',
  fontWeight: 'medium',
  fontFamily: 'label',
  textTransform: 'uppercase',
  letterSpacing: 'wider',
} as const;

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** The appearance the app isn't in (the document's `dark` class), followed as it changes. */
function useOtherAppearance(): 'light' | 'dark' {
  const dark = useSyncExternalStore(subscribe, () => document.documentElement.classList.contains('dark'));
  return dark ? 'light' : 'dark';
}

export function MaskFold({
  title,
  summary,
  state,
  open,
  onClick,
  children,
}: {
  title: string;
  /** `maskSummary`, without a mask null. */
  summary: string | null;
  state: 'none' | 'on' | 'off';
  open: boolean;
  onClick: () => void;
  /** The editor, when open. */
  children?: ReactNode;
}) {
  const other = useOtherAppearance();
  const masked = state !== 'none';
  const button = (
    <Button
      size="2xs"
      variant="ghost"
      w="full"
      justifyContent="flex-start"
      gap="1.5"
      px="1"
      aria-expanded={masked ? open : undefined}
      aria-label={masked ? `${title} mask` : `Add a mask to ${title}`}
      title={
        !masked
          ? 'Add a mask: apply the module only to parts of the image, or blend it with its input (opacity, blend mode)'
          : open
            ? 'Hide the mask and blending settings'
            : 'Show the mask and blending settings'
      }
      onClick={onClick}
    >
      <Box color={state === 'on' ? 'orange.fg' : 'fg.muted'}>
        <VenetianMask />
      </Box>
      <Text as="span" {...LABEL_PROPS} color={state === 'on' ? 'fg' : 'fg.muted'}>
        Mask
      </Text>
      <Text
        as="span"
        textStyle="2xs"
        color={masked ? 'fg.muted' : 'fg.subtle'}
        truncate
        flex="1"
        textAlign="start"
        fontFamily="numeric"
      >
        {summary ?? 'Add…'}
      </Text>
      <Box color="fg.muted" transform={open && masked ? 'rotate(180deg)' : undefined}>
        {masked ? <ChevronDown /> : <Plus />}
      </Box>
    </Button>
  );
  if (!masked)
    return (
      <Box borderTopWidth="1px" borderStyle="dashed" mt="1" pt="1">
        {button}
      </Box>
    );
  // A card at the module's foot, inside it, in the other appearance.
  return (
    <Theme
      appearance={other}
      data-mask-fold
      mt="1"
      borderRadius="md"
      px="2"
      py="1"
      display="flex"
      flexDirection="column"
      gap="1.5"
      css={{ '& > :not(button)': { px: '1', pb: '1.5' } }}
    >
      {button}
      {children}
    </Theme>
  );
}
