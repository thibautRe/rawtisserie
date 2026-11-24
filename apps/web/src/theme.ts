import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';
import { collapsibleAnatomy, menuAnatomy, nativeSelectAnatomy } from '@chakra-ui/react/anatomy';
import { PHOTO_CARD_CSS } from './library/photoCardCss.ts';
import { ZEN_CSS } from './develop/zen.tsx';

const config = defineConfig({
  globalCss: {
    'html, body, #root': { height: '100%' },
    body: { bg: 'bg', color: 'fg' },
    ...PHOTO_CARD_CSS,
    ...ZEN_CSS,
  },
  theme: {
    tokens: {
      fonts: {
        // Geologica, with Lilex for values (see M9 in docs/ROADMAP.md). Tried before: Inter, Barlow
        // Semi Condensed (too narrow for rows of similar sliders), Asta Sans (centred ellipsis).
        heading: { value: `'Geologica Variable', system-ui, sans-serif` },
        body: { value: `'Geologica Variable', system-ui, sans-serif` },
        /** Small uppercase labels: module titles, filter and panel section labels. */
        label: { value: `'Geologica Variable', system-ui, sans-serif` },
        /** Numbers and measurements: sliders' readouts, zoom, counts, dimensions, exposure settings. Fixed-width figures. */
        numeric: { value: `'Lilex Variable', ui-monospace, monospace` },
      },
    },
    semanticTokens: {
      colors: {
        // A neutral, slightly warm darkroom grey: photos should be the only colourful thing on screen.
        // (Keep `_light` before `_dark`: Chakra emits condition blocks in first-seen order.)
        // (Nested under `DEFAULT`: a `value` directly on `bg` would drop Chakra's other bg.* tokens.)
        bg: {
          DEFAULT: { value: { _light: '#f7f5f2', _dark: '#1b1a19' } },
          panel: { value: { _light: '#ffffff', _dark: '#232120' } },
          muted: { value: { _light: '#eeebe6', _dark: '#2c2a28' } },
          emphasized: { value: { _light: '#e2ded8', _dark: '#3b3836' } },
          // What's tied to a block of `panel` inside it (a mask fold's settings): a shade off it.
          nested: {
            DEFAULT: { value: { _light: '#faf9f7', _dark: '#292725' } },
            // The same, standing out a little (a mask fold while the mask is on).
            on: { value: { _light: '#f3f1ed', _dark: '#302e2b' } },
          },
        },
        // Developer surround: neutral middle grey (sRGB 119 ≈ L* 50) to judge exposure and colour.
        canvas: { value: { _light: '#777777', _dark: '#777777' } },
      },
    },
    recipes: {
      // Hover states show at once and fade out: transitions on the way in feel sluggish.
      button: { base: { _hover: { transitionDuration: '0s' } } },
      // A muted fill, as for selects: the outline variant's border barely shows on panels.
      input: { defaultVariants: { variant: 'subtle' } },
      textarea: { defaultVariants: { variant: 'subtle' } },
    },
    slotRecipes: {
      collapsible: {
        slots: collapsibleAnatomy.keys(),
        base: { content: { _open: { animationDuration: 'fast' } } },
      },
      // A muted fill: the outline variant's border barely shows on the panels.
      nativeSelect: {
        slots: nativeSelectAnatomy.keys(),
        defaultVariants: { variant: 'subtle' },
      },
      menu: {
        slots: menuAnatomy.keys(),
        base: {
          // Opens at once (entry animations feel slow); closing keeps its animation.
          content: { _open: { animationDuration: '0s' } },
          item: { _disabled: { cursor: 'default' } },
        },
        variants: {
          variant: {
            subtle: { item: { _highlighted: { bg: 'bg.emphasized' } } },
          },
          size: {
            md: {
              content: { padding: '1', scrollPadding: '1' },
              item: { fontSize: '13px', py: '1', '& svg': { boxSize: '3.5' } },
            },
          },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
