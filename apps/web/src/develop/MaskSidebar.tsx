/**
 * The mask editor in a sidebar of its own (roadmap 4.13's prototype, `push` and `overlay`
 * layouts): the mask of one module instance, with the recipe's other masks listed to
 * jump between them. The module panel keeps only its header's mask button.
 */
import { Box, Button, HStack, IconButton, Stack, Text } from '@chakra-ui/react';
import { ArrowLeft, ChevronDown, Plus, VenetianMask, X } from 'lucide-react';
import type { ReactNode } from 'react';

export interface MaskedInstance {
  id: string;
  title: string;
  /** `maskSummary`. */
  summary: string;
  enabled: boolean;
}

const LABEL_PROPS = {
  textStyle: '2xs',
  fontWeight: 'medium',
  color: 'fg.muted',
  fontFamily: 'label',
  textTransform: 'uppercase',
  letterSpacing: 'wider',
} as const;

export function MaskSidebar({
  layout,
  title,
  current,
  masked,
  onSelect,
  onClose,
  onAdd,
  children,
}: {
  layout: 'push' | 'overlay';
  /** The instance's title. */
  title: string;
  current: string;
  /** Every instance with a mask, in the pipeline's order. */
  masked: MaskedInstance[];
  onSelect: (id: string) => void;
  onClose: () => void;
  /** It has no mask (removed meanwhile): add one. */
  onAdd: (() => void) | null;
  /** The editor, if it has a mask. */
  children: ReactNode;
}) {
  const others = masked.filter((m) => m.id !== current);
  return (
    <Stack gap="1.5" py="1.5" minH="full" data-mask-sidebar>
      <HStack
        px="2"
        py="1.5"
        gap="1"
        bg="bg.panel"
        position="sticky"
        top="-1.5"
        zIndex="1"
        borderBottomWidth="1px"
        borderColor="border.subtle"
      >
        <IconButton
          size="2xs"
          variant="ghost"
          aria-label={layout === 'overlay' ? 'Back to the modules' : 'Close the mask'}
          title={layout === 'overlay' ? 'Back to the modules' : 'Close the mask'}
          onClick={onClose}
        >
          {layout === 'overlay' ? <ArrowLeft /> : <X />}
        </IconButton>
        <Box color="orange.fg" flexShrink={0}>
          <VenetianMask size={14} />
        </Box>
        <Text {...LABEL_PROPS} color="fg" fontWeight="bold" fontSize="xs" truncate>
          {title}
        </Text>
        <Text {...LABEL_PROPS}>mask</Text>
      </HStack>
      <Stack gap="1.5" px="3" pt="1" pb="3" bg="bg.panel">
        {children ?? (
          <Stack align="start" gap="2">
            <Text textStyle="xs" color="fg.muted">
              {title} has no mask: it applies everywhere.
            </Text>
            {onAdd && (
              <Button size="xs" variant="outline" onClick={onAdd}>
                <Plus /> Add a mask
              </Button>
            )}
          </Stack>
        )}
      </Stack>
      {others.length > 0 && (
        <Stack gap="0.5" px="3" pt="2" pb="3" bg="bg.panel">
          <Text {...LABEL_PROPS} mb="1">
            Other masks
          </Text>
          {others.map((m) => (
            <Button
              key={m.id}
              size="2xs"
              variant="ghost"
              justifyContent="flex-start"
              gap="2"
              onClick={() => onSelect(m.id)}
              title={`Edit ${m.title}’s mask`}
            >
              <Text as="span" fontWeight="semibold" flexShrink={0} opacity={m.enabled ? 1 : 0.6}>
                {m.title}
              </Text>
              <Text as="span" color="fg.muted" truncate fontFamily="numeric">
                {m.summary}
              </Text>
            </Button>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * The accordion layout's fold at the bottom of a maskable module: what its mask does,
 * and a click to show or hide the editor under it (or to add a mask).
 */
export function MaskFold({
  title,
  summary,
  state,
  open,
  onClick,
}: {
  title: string;
  /** `maskSummary`, without a mask null. */
  summary: string | null;
  state: 'none' | 'on' | 'off';
  open: boolean;
  onClick: () => void;
}) {
  return (
    <Box borderTopWidth="1px" borderStyle="dashed" mt="1" pt="1">
      <Button
        size="2xs"
        variant="ghost"
        w="full"
        justifyContent="flex-start"
        gap="1.5"
        px="1"
        aria-expanded={state === 'none' ? undefined : open}
        aria-label={state === 'none' ? `Add a mask to ${title}` : `${title} mask`}
        title={
          state === 'none'
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
        <Text as="span" textStyle="2xs" color="fg.subtle" truncate flex="1" textAlign="start" fontFamily="numeric">
          {summary ?? 'Add…'}
        </Text>
        <Box color="fg.muted" transform={open && state !== 'none' ? 'rotate(180deg)' : undefined}>
          {state === 'none' ? <Plus /> : <ChevronDown />}
        </Box>
      </Button>
    </Box>
  );
}
