import type { Options } from 'element-plus/es/components/popper';

// Measure from the active control, including after a scroll, resize or soft keyboard.
export const dropdownPosition: Partial<Options> = {
  strategy: 'fixed',
  modifiers: [
    { name: 'flip', options: { padding: 6 } },
    { name: 'preventOverflow', options: { padding: 6 } },
    {
      name: 'availableHeight',
      enabled: true,
      phase: 'beforeRead',
      fn({ state }) {
        const { reference, popper } = state.elements;
        const anchor = reference.getBoundingClientRect();
        const viewport = popper.ownerDocument.defaultView?.visualViewport;
        const top = viewport?.offsetTop ?? 0;
        const bottom =
          top + (viewport?.height ?? popper.ownerDocument.documentElement.clientHeight);
        // Allow for the 4px gap and 6px viewport padding on the larger side.
        const space =
          Math.max(0, Math.floor(Math.max(anchor.top - top, bottom - anchor.bottom) - 10)) + 'px';
        if (popper.style.getPropertyValue('--dropdown-space') !== space) {
          popper.style.setProperty('--dropdown-space', space);
          state.rects.popper.height = popper.offsetHeight;
        }
      },
    },
  ],
};
