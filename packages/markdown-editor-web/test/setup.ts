// jsdom lacks a few layout APIs that Lexical and CodeMirror touch.
const emptyRect: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};

if (typeof Range !== 'undefined') {
  Range.prototype.getBoundingClientRect = () => emptyRect;
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects();
}

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = NoopResizeObserver;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
