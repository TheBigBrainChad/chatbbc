# ChatBBC icon artwork

`chatbbc-mark.svg` is the original, editable source of the ChatBBC mark. Its 64 × 64
viewBox contains one continuous rounded speech bubble with a lower-left tail and
three unboxed geometric BBC glyphs. The source uses ink `#0c0c0e` and paper
`#f4f4f6` on transparency. The renderer sprite and README illustration reuse
this geometry; the companion uses the generated icon rather than another mark.

Run `npm run icon` to rasterize the SVG with Sharp into the generated
`app-icon-source.png` (non-interlaced 8-bit RGBA), then regenerate the existing
app/runtime, multi-resolution ICO, and four companion PNG sizes. The generator
retains its connected-alpha crop and two-tone resampling, so all outputs derive
from this single vector source.
