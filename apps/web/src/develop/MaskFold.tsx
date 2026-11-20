/**
 * The fold at the bottom of a maskable module (roadmap 4.13): the mask's switch, what it
 * does (`maskSummary`), a click to show or hide its editor, and the editor under it. A
 * module whose mask is on has its fold in the other appearance (light in the dark app),
 * open or closed, so that masked modules stand out in the panel.
 */
import { Box, HStack, IconButton, Stack, Switch, Text, Theme, chakra } from '@chakra-ui/react';
import { ChevronDown, ScanEye } from 'lucide-react';
import { type ReactNode, useState, useSyncExternalStore } from 'react';

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
  onOpen,
  onSwitch,
  showing,
  onShow,
  children,
}: {
  title: string;
  /** `maskSummary`, without a mask null. */
  summary: string | null;
  state: 'none' | 'on' | 'off';
  open: boolean;
  /** Show or hide the editor (only with a mask). */
  onOpen: (open: boolean) => void;
  /** Switch the mask on (adding it) or off. */
  onSwitch: (on: boolean) => void;
  /** Whether the image shows where the module applies. */
  showing: boolean;
  onShow: (show: boolean) => void;
  /** The editor, when open. */
  children?: ReactNode;
}) {
  const other = useOtherAppearance();
  // Shown switched at once, the recipe changed a frame later: the commit re-renders the
  // module (its editor too), which would hold the switch and the colours back.
  const [pending, setPending] = useState<boolean | null>(null);
  const on = pending ?? state === 'on';
  const foldable = state !== 'none';
  const expanded = foldable && open;
  const header = (
    <HStack gap="1.5" h="7">
      <Switch.Root
        size="xs"
        colorPalette="orange"
        checked={on}
        onCheckedChange={(d) => {
          setPending(d.checked);
          requestAnimationFrame(() =>
            setTimeout(() => {
              onSwitch(d.checked);
              setPending(null);
            }),
          );
        }}
        title={
          on
            ? 'Switch the mask off: the module applies everywhere'
            : 'Switch the mask on: apply the module only to parts of the image, or blend it with its input (opacity, blend mode)'
        }
      >
        <Switch.HiddenInput aria-label={`${title} mask`} />
        <Switch.Control />
      </Switch.Root>
      <chakra.button
        type="button"
        flex="1"
        minW="0"
        h="full"
        display="flex"
        alignItems="center"
        gap="1.5"
        textAlign="start"
        cursor={foldable ? 'pointer' : 'default'}
        disabled={!foldable}
        aria-expanded={foldable ? open : undefined}
        aria-label={`${title} mask settings`}
        title={
          foldable ? (open ? 'Hide the mask and blending settings' : 'Show the mask and blending settings') : undefined
        }
        onClick={() => onOpen(!open)}
      >
        <Text as="span" {...LABEL_PROPS} color={on ? 'fg' : 'fg.muted'}>
          Mask
        </Text>
        <Text as="span" textStyle="2xs" color={on ? 'fg.muted' : 'fg.subtle'} truncate flex="1" fontFamily="numeric">
          {summary}
        </Text>
      </chakra.button>
      {expanded && (
        <IconButton
          size="2xs"
          variant={showing ? 'subtle' : 'ghost'}
          colorPalette={showing ? 'yellow' : 'gray'}
          aria-pressed={showing}
          aria-label={showing ? 'Hide the mask' : 'Show the mask'}
          title={showing ? 'Hide the mask' : 'Show where the module applies, in yellow'}
          onClick={() => onShow(!showing)}
        >
          <ScanEye />
        </IconButton>
      )}
      {foldable && (
        <IconButton
          size="2xs"
          variant="ghost"
          color="fg.muted"
          aria-label={open ? 'Hide the mask settings' : 'Show the mask settings'}
          tabIndex={-1}
          onClick={() => onOpen(!open)}
        >
          <Box transform={open ? 'rotate(180deg)' : undefined}>
            <ChevronDown />
          </Box>
        </IconButton>
      )}
    </HStack>
  );
  const body = expanded && children;
  // A card at the module's foot, inside it, the same size on or off (no shift when
  // switched). On, its header is in the other appearance, so masked modules stand out;
  // its settings stay in the app's, a shade off the module (a whole card in the other
  // appearance drew the eye off the photo). Off, the header is like the settings.
  const headerBox = {
    px: '2',
    py: '1',
    borderWidth: '1px',
    borderTopRadius: 'md',
    borderBottomRadius: body ? '0' : 'md',
  } as const;
  return (
    <Box data-mask-fold mt="1">
      {/* One element either way: switching restyles the header rather than remounting it. */}
      <Theme
        appearance={on ? other : other === 'light' ? 'dark' : 'light'}
        {...headerBox}
        {...(on
          ? { borderColor: 'bg' }
          : { bg: 'bg.nested', borderColor: 'border.emphasized', borderBottomColor: body ? 'bg.nested' : undefined })}
      >
        {header}
      </Theme>
      {body && (
        <Stack
          gap="1.5"
          bg="bg.nested"
          px="2"
          pt="2"
          pb="2.5"
          borderWidth="1px"
          borderTopWidth="0"
          borderColor="border.emphasized"
          borderBottomRadius="md"
        >
          {body}
        </Stack>
      )}
    </Box>
  );
}
