import { version } from '@tachyon-charts/core';

const target = document.querySelector<HTMLElement>('#version');
if (target) {
  target.textContent = version;
}
