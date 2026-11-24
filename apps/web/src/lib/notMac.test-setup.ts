// Shortcuts are written as the platform writes them (`keys.ts` reads `navigator.platform`
// once, when it loads), so tests that expect `Ctrl+Alt` import this first, before
// anything that imports `keys.ts`: they then pass on a Mac too, as on CI.
Object.defineProperty(globalThis, 'navigator', {
  value: { platform: 'Linux x86_64' },
  configurable: true,
});
