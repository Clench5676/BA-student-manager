// Synthetic canvas contract: tests can inspect pixels and transforms without
// exporting or depending on any game image.
export function maskCanvas() {
  const canvases = [], calls = [];
  return { canvases, calls, document: { createElement: () => {
    const canvas = { width: 0, height: 0, pixels: null, transform: null };
    canvas.getContext = () => ({
      scale: (...args) => { canvas.scale = args; },
      transform: (...args) => { canvas.transform = args; },
      drawImage: (...args) => { canvas.image = args[0]; calls.push(args); },
      getImageData: () => ({ width: canvas.width, height: canvas.height,
        data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255) }),
      putImageData: (image) => { canvas.pixels = image; },
    });
    canvas.toDataURL = () => `data:image/png;base64,synthetic-${canvases.indexOf(canvas)}`;
    canvases.push(canvas); return canvas;
  } } };
}
