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
    // A long press selects (phones): no image menu (iOS) or tap highlight over it.
    WebkitTouchCallout: 'none',
    WebkitTapHighlightColor: 'transparent',
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
    '[data-focused] > &': { borderColor: 'fg.subtle' },
    '[data-selected] > &': { bg: 'bg.emphasized', borderColor: 'orange.solid' },
    // The photo the keyboard moves from: a brighter ring inside the selection's border.
    '[data-selected][data-focused] > &': { boxShadow: 'inset 0 0 0 2px var(--chakra-colors-orange-fg)' },
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
  // A photo's rating, flag, label (`PhotoBadges`), centred along the bottom of its
  // thumbnail: in the grid's cards and the film roll (`data-size="sm"`).
  '.photo-badges': {
    position: 'absolute',
    insetX: '0',
    bottom: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    px: '2',
    py: '1',
    gap: '1.5',
    bg: 'blackAlpha.600',
    color: 'white',
    pointerEvents: 'none',
    '& > .stars': { display: 'flex', color: 'orange.300' },
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
    '&[data-size=sm]': { h: '3.5', px: '1', py: '0', gap: '1' },
    '&[data-size=sm] > .label': { w: '1.5', h: '1.5' },
  },
};
