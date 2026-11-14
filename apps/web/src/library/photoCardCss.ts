import type { SystemStyleObject } from '@chakra-ui/react';

/** The grid's gap, in px. */
export const GRID_GAP = 8;

/** The box behind a photo, highlighted with its other versions on hover. */
export const GROUP_BOX_CLASS = 'photo-group-box';

/**
 * The library grid's cards (`PhotoCard`, and its placeholders), as one global stylesheet
 * (`theme.ts`): cards mount by the row as the grid scrolls, and with style props each of
 * their elements would resolve its styles as it mounts, which is most of what scrolling
 * costs. Their state is in data attributes.
 */
export const PHOTO_CARD_CSS: Record<string, SystemStyleObject> = {
  '.photo-placeholder': { aspectRatio: '1', bg: 'bg.panel', borderRadius: 'md' },
  '.photo-card': {
    position: 'relative',
    aspectRatio: '1',
    cursor: 'pointer',
    userSelect: 'none',
    // The hovered photo's box: highlighted at once (no transition on the way in), fading
    // back with the box's own transition.
    [`&:hover > .${GROUP_BOX_CLASS}`]: { bg: 'bg.emphasized', transition: 'none' },
  },
  // The box shared by the photo's versions, across the gap to the next one.
  [`.${GROUP_BOX_CLASS}`]: {
    position: 'absolute',
    inset: '0',
    bg: 'bg.panel',
    transition: 'background-color 0.2s',
    borderRadius: 'md',
    '[data-join-left] > &': { borderLeftRadius: '0' },
    '[data-join-right] > &': { borderRightRadius: '0', right: `-${GRID_GAP}px` },
  },
  '.photo-card-frame': {
    position: 'absolute',
    inset: '0',
    borderRadius: 'md',
    borderWidth: '2px',
    borderColor: 'transparent',
    overflow: 'hidden',
    '[data-focused] > &': { borderColor: 'border.emphasized' },
    '[data-selected] > &': { bg: 'bg.emphasized', borderColor: 'orange.solid' },
  },
  '.photo-card-thumb': {
    position: 'absolute',
    inset: '2',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    '[data-rejected] &': { opacity: 0.35 },
    '& > img': { maxW: 'full', maxH: 'full', objectFit: 'contain', boxShadow: 'md' },
  },
  '.photo-card-bar': {
    position: 'absolute',
    insetX: '0',
    bottom: '0',
    display: 'flex',
    alignItems: 'center',
    px: '2',
    py: '1',
    gap: '1',
    bg: 'blackAlpha.600',
    color: 'white',
    '& > .stars': { display: 'flex', color: 'orange.300', flex: '1' },
    '& > .edited': {
      display: 'inline-flex',
      alignItems: 'center',
      px: '1',
      minH: '4',
      borderRadius: 'l2',
      textStyle: '2xs',
      fontWeight: 'medium',
      whiteSpace: 'nowrap',
      bg: 'blackAlpha.700',
    },
    '& > .label': { w: '2.5', h: '2.5', borderRadius: 'full', flexShrink: 0 },
  },
};
