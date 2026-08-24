const pixelLayer = document.querySelector("[data-wavey-pixels]");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

if (pixelLayer && !reducedMotion.matches) {
  const palette = [
    "rgba(230, 109, 255, 0.86)",
    "rgba(168, 44, 255, 0.82)",
    "rgba(84, 240, 255, 0.70)",
    "rgba(255, 43, 214, 0.78)",
  ];
  const pixels = Array.from({ length: 64 }, (_, index) => {
    const pixel = document.createElement("span");
    pixel.className = "wavey-credit-pixel";
    pixel.style.setProperty("--wavey-pixel-alpha", index % 3 === 0 ? "0.52" : "0.24");
    pixelLayer.append(pixel);
    return pixel;
  });

  let frame = 0;
  window.setInterval(() => {
    frame += 1;
    pixels.forEach((pixel, index) => {
      const column = index % 8;
      const row = Math.floor(index / 8);
      const beat = (row * 3 + column * 5 + frame) % 11;
      const alpha = beat < 2 ? 0.78 : beat < 5 ? 0.42 : 0.18;
      pixel.style.setProperty("--wavey-pixel-alpha", String(alpha));
      pixel.style.setProperty("--wavey-pixel-color", palette[(row + column + frame) % palette.length]);
    });
  }, 120);
}
