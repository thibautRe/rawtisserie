# Features

What RAWtisserie does, in more detail than the README.

- **Library**: every photo you own (RAW files, and JPEG, PNG, TIFF and WebP images),
  filterable by EXIF metadata (camera, lens, ISO,
  focal length, aperture, date), tags, rating, flags and colour labels. Cull with the
  keyboard (rate, pick/reject, label, delete), in the grid or in a full-window loupe
  that zooms to 100 % (tiles rendered by the server), and correct metadata. Going back from the
  developer restores the filters, scroll position and selection. Originals are never
  modified; edits live in the database. Each photo has one or more _versions_ (like
  darktable duplicates), each with its own rating, labels and edit history.
- **Developer**: a film roll of the library's current photos along the bottom, lens correction from the camera's embedded data (Sony) or
  lensfun's database (both auto-applied to new imports), exposure, colour calibration (white balance by chromatic adaptation and
  channel mixing), colour balance (chroma, saturation and brilliance by tonal range, and
  split-toning: a light correction and channel mix per range), colour primaries and a
  contrast equalizer (ports of Ansel's), filmic tone mapping (a port of Ansel's filmic
  rgb with its AgX colour science), creative 3D LUTs (after filmic: a few built-in film
  looks, or your own `.cube` and Hald CLUT PNG files, previewed as you hover them),
  diffuse or sharpen (a port of Ansel's: lens deblur, local contrast, dehaze, denoise,
  highlight inpainting, softening), glow (bloom, halation and diffusion-filter looks),
  rotation/flip, straightening, perspective correction (fitted to detected or drawn
  guide lines) and cropping. The image sits on a
  neutral grey surround, with an ISO 12646 colour-assessment frame on Ctrl/⌘+B, and
  display (O) and sensor (Shift+O) clipping indicators. Zoom with the mouse wheel or a
  touchpad pinch (fit to 800 %), middle click for 100 % at the pointer (again for fit),
  and drag to pan. Module presets (built-in and
  your own, optionally limited to part of a module, e.g. colour calibration's mixer) and
  styles (a set of modules to apply to other photos) are in each module's header and
  the toolbar, and can be applied to a whole selection from the library.
  Export to JPEG, or 16-bit PNG or TIFF, in sRGB, Display P3, Adobe RGB or Rec.2020
  (with its ICC profile), at a chosen size with optional output sharpening, a frame
  (border, aspect ratio, line around the photo), EXIF/XMP metadata and a file name
  pattern; export presets are kept per user. It runs **in your browser** on a
  WebAssembly build of the pixel pipeline.
- **Headless rendering**: the same WebAssembly module runs on the server (in worker
  threads) to render thumbnails and previews from your saved edits.
- **Public developer**: `/develop` works without an account. Files are processed
  locally and nothing is uploaded.
