<template>
  <div class="segmented" role="group"><slot /></div>
</template>

<style>
.segmented {
  display: inline-flex;
  border: 1px solid var(--field-line);
  border-radius: var(--radius);
  overflow: hidden;
}
.segmented button {
  min-width: 42px;
  border: 0;
  border-radius: 0;
}
.segmented button + button {
  border-left: 1px solid var(--line);
}
.segmented button[aria-pressed='true'] {
  color: white;
  background: var(--brand);
}
.segmented button[aria-pressed='true']:enabled:hover {
  background: var(--brand-hover);
}
.segmented button:focus-visible {
  outline-offset: -3px;
  outline: 2px solid var(--yellow);
}
</style>
