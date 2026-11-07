# Built-in LUTs

Creative LUTs that ship with RAWtisserie, in the packed form (`Clut::to_packed` in
`crates/pipeline/src/ops/clut.rs`), each named by its id: the SHA-256 of its canonical
form. They are listed in `../src/luts.ts` (`BUILTIN_LUTS`).

Recipes refer to these ids, so a file here must never be removed or changed. A LUT
that's no longer offered gets `retired: true` in the list instead.

To add one, pack it with `cargo run --release --example lut -- packages/pipeline/luts file.png`
and list the printed id in `BUILTIN_LUTS` with its name and credits.

## Credits and licence

From the **RawTherapee Film Simulation Collection** (version 2015-09-20) by Pat David,
Pavlov Dmitry and Michael Ezra, licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
(<https://rawpedia.rawtherapee.com/Film_Simulation>, via
<https://github.com/cedeber/hald-clut>). Converted losslessly from Hald CLUT PNGs to the
packed form and renamed. These files are distributed under the same licence.

| File (id)        | Name       | Source                                    |
| ---------------- | ---------- | ----------------------------------------- |
| `c9807b26….clut` | Vivid      | Color/Kodak/Kodak Elite ExtraColor 100    |
| `93adbf94….clut` | Sunlit     | Color/Kodak/Kodak Elite Color 200         |
| `615fe950….clut` | Deep Sky   | Color/Kodak/Kodak Elite Color 400         |
| `25ebaf42….clut` | Cool Slide | Color/Kodak/Kodak E-100 GX Ektachrome 100 |
| `3b610da3….clut` | Rich Slide | Color/Kodak/Kodak Ektachrome 100 VS       |

The product names in the sources' file names only identify which film stock each LUT
approximates; the authors and RAWtisserie aren't affiliated with or endorsed by their
owners.
