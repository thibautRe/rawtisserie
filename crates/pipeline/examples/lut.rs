//! Decode LUT files (`.cube`, Hald CLUT PNG) and write them packed, named by id:
//!
//! ```sh
//! cargo run --release --example lut -- out-dir file.cube hald.png …
//! ```
//!
//! Prints each file's id, grid and sizes. Built-in LUTs are made this way
//! (`packages/pipeline/luts/`).

use std::time::Instant;

use rawtisserie_pipeline::ops::clut::Clut;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((out, files)) = args.split_first() else {
        eprintln!("usage: lut <out-dir> <file>…");
        std::process::exit(2);
    };
    std::fs::create_dir_all(out)?;
    for path in files {
        let bytes = std::fs::read(path)?;
        let t = Instant::now();
        let lut = Clut::parse(&bytes)?;
        let parsed = t.elapsed();
        let packed = lut.to_packed();
        let t = Instant::now();
        let back = Clut::parse(&packed)?;
        let unpacked = t.elapsed();
        assert_eq!(back.id(), lut.id());
        std::fs::write(std::path::Path::new(out).join(format!("{}.clut", lut.id())), &packed)?;
        println!(
            "{}\t{}\t{}³ {}-bit\t{} → {} bytes packed\tparsed in {parsed:.0?}, unpacked in {unpacked:.0?}",
            lut.id(),
            path,
            lut.size(),
            lut.bit_depth(),
            bytes.len(),
            packed.len()
        );
    }
    Ok(())
}
