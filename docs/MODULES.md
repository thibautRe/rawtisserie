# Image modules

Notes on the pixel modules: what they port from Ansel and darktable, and where they
deviate. The pipeline around them is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Filmic

`crates/pipeline/src/ops/filmic.rs` ports Ansel's `filmicrgb`, limited to what Ansel ships
by default: the v3 spline with "perceptual" sigmoid toe and shoulder, auto hardness,
and colour science v8 "AgX" with all five bleach variants. Highlight reconstruction,
deprecated in Ansel, is left out. Defaults match Ansel's for RAW files (white +3.15 EV,
black −8.85 EV, contrast 1.18, latitude 10 %, medium bleach) together with the +0.7 EV
exposure default. One deviation in the controls: Ansel's latitude and shadows/highlights
balance are replaced by independent **toe** and **shoulder** settings (the linear share of
each side of middle grey; higher means more contrast); toe = shoulder = 10 % is Ansel's
latitude 10 %, balance 0.

**Auto-tune** follows Ansel's `autoset`. It measures filmic's input over the image as
displayed (after crop): white relative exposure from the brightest max(R, G, B), black
from the darkest luminance, both scaled by _dynamic range scaling_. The one deviation
is that the extreme 0.01 % at each end is ignored, so a few noisy or hot pixels can't
decide the range.

## Colour calibration

`ops/calibration.rs` ports Ansel's `channelmixerrgb` ("color calibration"), the way Ansel
does white balance: the base image is balanced with the camera's _reference_
multipliers, which make D65 light neutral, and colour calibration adapts the scene's
light to D65 with CAT16 (or linear Bradford, XYZ, or none). Every recipe starts with an
instance set to the **as-shot** light, which follows the file; the illuminant can also be
daylight or black body at a temperature, a CIE standard (A, E, F1–F12, LEDs), a custom
hue/chroma, or detected from the image (Ansel's "surfaces" and "edges", which are rough
guesses). It also does gamut compression and mixing in the adaptation's space: channel
mixer, colourfulness, brightness and grey (monochrome). The channel mixer can also be
edited as primaries, as in Ansel (`packages/pipeline/src/mixer.ts`): each input
channel's hue and purity plus the white's hue, purity and gain, or a white-preserving
rotation and saturation per channel. These views read and write the same 3×3 matrix; a
mix that shifts the white can be reduced to its white-preserving part. Blown highlights are clipped at
the as-shot white in the base stage, so they stay neutral. Deviations from Ansel, mainly
from the D65 working space, are listed in the module. Recipes from before v6 had
warmth/tint instead; it is folded into the channel mixer when they're read.

## Colour balance

`ops/color_balance.rs` merges two Ansel modules: the master tab of `colorbalancergb`
(hue shift, vibrance, and linear chroma, perceptual saturation and brilliance, globally
and per range, with its dt UCS gamut mapping) and `splittoningrgb` (per range, a CAT16
correction from a light's temperature, 6504 K changing nothing, and a 3×3 channel mix,
edited with colour calibration's mixer views). The shadows, mid-tones and highlights are
two logistic steps along the luminance (a fulcrum, a mid-tones width and two fall-offs),
so their weights always add up to 1: the same settings in every range act like a global
one, and the range matrices blend like a mix of lights. The settings tab draws the
weights and can show each range over the image. Ansel's 4 ways and contrast are left out
(the mixers cover tinting, the tone curve contrast). Recipes from before v7 had colour
(saturation/vibrance) and shadows/highlights instead; they become colour balance
instances, approximately, when they're read.

## Colour primaries and contrast equalizer

`ops/primaries.rs` ports Ansel's `colorprimaries` (and the parts of `colorequal_shared`
it uses): six control colours edited in dt UCS hue/saturation/brightness, spread over
all colours by a local field around the grey axis of HLG-encoded Rec.2020, baked into
a 3D table. The one deviation: the table stores each colour's linear change, which
skips the HLG decode per pixel and leaves colours outside the edits' reach untouched.
It is as close to the exact field as Ansel's table.

`ops/equalizer.rs` follows Ansel's `atrous` (contrast equalizer): an edge-aware à-trous
wavelet decomposition with per-band gain and denoise curves over detail size, from 5 px
to a fifth of the image. It deviates for speed: it decomposes log₂ luminance and colour
relative to luminance instead of Lab, so exposure only shifts the residual, and each
5×5 edge-aware filter is applied as a row pass then a column pass. Luminance and colour
are decomposed separately, and a neutral one is skipped. Thresholds and edge weights
are converted from Lab units at about 12 L* per EV and 50 a*b* per unit of colour.

## Retouch

`ops/retouch.rs` follows Ansel's `retouch` and `heal`: spots heal (copy the source, then
blend it into the target's surroundings with a Laplace solve on square roots), clone,
fill with a colour, or blur. They work on the base image, in the sensor frame, so they
stay put when the crop, rotation or lens correction changes. The base is retouched in
place, and each spot keeps the pixels it overwrote, so moving a spot only redoes the
spots, not the demosaic. A zoomed-in region develops a patch that also covers what the
spots touching it read. The heal solve starts from a coarse-to-fine estimate and stops on
the mean change per pixel rather than Ansel's total; deviations are listed in the module.
In the developer, the spots are drawn over the image (`develop/ShapeOverlay.tsx`) through
the frame's sensor mapping, which the pipeline worker sends with each render.

## Masks

Any module before filmic (except retouch, lens and geometry) can have a mask
(`ops/mask.rs`): drawn shapes combined with union, intersection, difference or
exclusion, times smooth ranges of luminance, saturation, hue and each RGB channel measured on the
module's input, feathered (a guided filter that follows the image's edges, or a blur),
then inverted and scaled by an opacity. The drawn part only depends on the shapes and
the geometry, so it is rasterised in the sensor frame, resampled with the image and
cached with the spatial stages; the pool workers get it with their strip. Without a
feather, the ranges are evaluated per pixel in the fused pass, so a masked colour slider
costs about as much as an unmasked one. A feathered mask with ranges is computed whole
with the spatial stages instead, on the module's input: edits before it then re-render
like spatial edits. Spatial modules blend their output through the mask.
The editor shows a mask (or one of its ranges alone) in yellow over the image, and can
paint the module's input as luminance, saturation, hue or one channel in the colours of the range
sliders' tracks, to see how the image is laid out along each. It edits a mask's shapes
with the same overlay as retouch.
