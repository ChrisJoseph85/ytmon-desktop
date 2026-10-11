/** Minimal browser API polyfills jsdom does not implement. */

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  if (!('clipboard' in navigator)) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => undefined, readText: async () => '' },
      configurable: true,
    });
  }

  if (!('scrollTo' in window)) {
    (window as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
  }
}

export {};