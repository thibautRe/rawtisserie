# Features

What RAWtisserie does, in more detail than the README. Keys are listed in
[Keyboard shortcuts](keyboard-shortcuts.md).

RAWtisserie opens RAW files and JPEG, PNG, TIFF and WebP images. Originals are never
modified: edits are saved as a history of recipes, and the photo is developed from them
each time.

## Library

### Importing

- Pick or drop files, whole folders (walked through) or a memory card. Imports keep going
  while you browse.
- Every import is reviewed first. Files already in the library, or in the trash, are
  recognised by name, size and date and skipped without being uploaded.
- Tags, rating and colour label are read from the files' XMP/IPTC metadata and `.xmp`
  sidecars.
- Edits made in darktable or Ansel can come along from their sidecars; the developer
  reports how each of their modules was carried over. darktable duplicates become
  versions.
- The review proposes collections for the new photos, from their capture dates.

### Organising

- **Collections**: where photos come from, as a tree of folders.
- **Versions**: each photo can have several (like darktable's duplicates), each with its
  own rating, flags, labels and edit history.
- **Rating, flags and labels**: 0–5 stars, pick or reject, and colour labels.
- **Tags**: hierarchical (People › Alice), counted under their parents. They are managed
  from the Tags filter: rename, move, merge or delete them everywhere at once, and give
  them keyboard shortcuts (single keys or sequences).
- **Metadata**: capture details can be corrected.
- **Trash**: deleted photos go to the trash first, and can be restored from there.

### Finding

- Filter by camera, lens, ISO, focal length, aperture, date, collection, rating range,
  flags, labels and tags. Tags can be combined: all of them, any of them, or excluded.
- Save filters to come back to them.
- Ctrl/⌘+A selects everything the filters match, not only the photos loaded on screen.

### Culling

- Rate, flag, label and delete from the keyboard, in the grid or in a full-window loupe.
- The loupe zooms to 100 %, and can advance to the next photo after each rating.
- Going to the developer and back keeps the filters, scroll position and selection.

### Working on many photos

- Apply a preset or style to a whole selection.
- Copy a photo's edits (all of them, or the modules you pick) and paste them onto others.
- Export a single photo or a selection.
- Send photos, or your whole library with its presets, styles and LUTs, to another
  RAWtisserie instance.

## Developer

### The workspace

- A film roll of the library's current photos along the bottom.
- The image sits on a neutral grey surround, with an ISO 12646 colour-assessment frame,
  and display and sensor clipping indicators.
- Zoom with the mouse wheel or a touchpad pinch (fit to 800 %), middle click for 100 %
  at the pointer, and drag to pan.
- Scopes: waveform, RGB parade and vectorscope.
- A colour picker that follows the pointer, with pins to keep samples in place.
- Every change goes into the history, saved as you work, and any entry can be gone back to.
- Compare the edit with an earlier entry of its history (the original included) or with
  another version of the photo, side by side or split.
- A spotlight (Ctrl+Space, experimental) to jump to any slider by typing a few letters.

### Modules

Most of these are ports of [Ansel](https://ansel.photos)'s modules; the
[module notes](../MODULES.md) say how they differ.

**Lens and framing**

- Lens correction from the camera's embedded data (Sony) or lensfun's database, applied
  to new photos automatically.
- Rotation, flip, straightening and cropping.
- Perspective correction, fitted to detected or drawn guide lines.

**Exposure and tones**

- Exposure.
- Filmic tone mapping, with its AgX colour science and an auto-tune.
- Tones: a tone curve, which can also work as a tone equalizer that preserves local
  contrast.

**Colour**

- Colour calibration: white balance by chromatic adaptation, gamut compression and a
  channel mixer.
- Colour balance: chroma, saturation and brilliance by tonal range, and split-toning.
- Colour primaries: shift six control colours' hue, saturation and brightness.
- Creative 3D LUTs: a few built-in film looks, or your own `.cube` and Hald CLUT PNG
  files, previewed as you hover them.

**Detail and effects**

- Raw denoise, by a neural network (Ansel's), before demosaicing.
- Diffuse or sharpen: lens deblur, local contrast, dehaze, denoise, highlight
  inpainting and softening.
- Contrast equalizer: contrast and denoise by detail size.
- Glow: bloom, halation and diffusion-filter looks.
- Multiple exposure: blend another photo into this one.

**Retouch and masks**

- Retouch: heal, clone, fill or blur spots.
- Masks on most modules: drawn shapes (ellipses, gradients, paths, brush strokes), ranges
  of luminance, saturation, hue or a channel, another module's mask, feathering that
  follows edges, opacity and blend modes.

A module can be used more than once in a recipe, each instance with its own settings and
mask.

### Presets and styles

- Module presets, built-in and your own, for a whole module or part of one (colour
  calibration's mixer, for example).
- Styles: a set of modules to apply to other photos, appended or replacing per module.
- Auto-tunes asked for by a preset or style run when it's applied.

### Export

- JPEG, or 16-bit PNG or TIFF.
- sRGB, Display P3, Adobe RGB or Rec.2020, with the ICC profile.
- A chosen size, optional output sharpening, a frame (border, aspect ratio, a line
  around the photo), EXIF/XMP metadata and a file name pattern.
- Export presets are kept per user.

## Anywhere

- **In the browser**: photos are developed in your browser, by a WebAssembly build of the
  pipeline. The server runs the same build to render the library's previews from your
  saved edits.
- **Without an account**: `/develop` opens files locally; nothing is uploaded.
- **On a phone**: the library and settings work on small screens. The developer needs a
  larger one for now.
- **Self-hosting**: sign-up by invitation, storage quotas per user, and originals stored
  on disk or in an S3-compatible bucket. See [Deployment](../DEPLOYMENT.md).
