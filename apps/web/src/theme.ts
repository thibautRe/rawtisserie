import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

const config = defineConfig({
  globalCss: {
    'html, body, #root': { height: '100%' },
    body: { bg: 'bg', color: 'fg' },
  },
  theme: {
    tokens: {
      fonts: {
        heading: { value: `'Inter Variable', Inter, system-ui, sans-serif` },
        body: { value: `'Inter Variable', Inter, system-ui, sans-serif` },
      },
    },
    semanticTokens: {
      colors: {
        // A neutral, slightly warm darkroom grey: photos should be the only colourful thing on screen.
        // (Keep `_light` before `_dark`: Chakra emits condition blocks in first-seen order.)
        bg: { value: { _light: '#f7f5f2', _dark: '#1b1a19' } },
        'bg.panel': { value: { _light: '#ffffff', _dark: '#232120' } },
        'bg.muted': { value: { _light: '#eeebe6', _dark: '#2c2a28' } },
        canvas: { value: { _light: '#dcd8d2', _dark: '#121110' } },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
