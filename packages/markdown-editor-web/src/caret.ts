/**
 * Where a character of a textarea sits on screen (QC-070: the source-mode
 * selection toolbar stands beside the selected line). A hidden mirror with the
 * textarea's text styles lays out the text up to `offset`; the marker after it
 * gives the line's top. Returned in viewport coordinates, scroll included.
 */
const COPIED = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'tabSize',
  'textIndent',
  'textTransform',
  'wordSpacing',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
] as const;

export function textareaLineRect(
  el: HTMLTextAreaElement,
  offset: number,
): { top: number; left: number; height: number } {
  const style = window.getComputedStyle(el);
  const mirror = document.createElement('div');
  for (const p of COPIED) mirror.style[p] = style[p];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.textContent = el.value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineTop = marker.offsetTop;
  const lineHeight = marker.offsetHeight || parseFloat(style.lineHeight) || 20;
  mirror.remove();
  const box = el.getBoundingClientRect();
  return { top: box.top + lineTop - el.scrollTop, left: box.left, height: lineHeight };
}
