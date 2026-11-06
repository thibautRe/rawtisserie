//! Export a RAW file with export options, as the app does:
//!
//! ```sh
//! cargo run --release --example export -- photo.ARW out.tif '{"format":"tiff","colorSpace":"displayP3"}' [params.json]
//! ```
//!
//! The options are `ExportOptions` JSON; the metadata is the file's. Without
//! `params.json`, the image gets the recipe of a new import.

use std::time::Instant;

use rawtisserie_pipeline::export::{self, ExportMetadata, ExportOptions};
use rawtisserie_pipeline::{Developer, EditParams};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: export <input> <output> <options.json> [params.json]");
        std::process::exit(2);
    }
    let options: ExportOptions = serde_json::from_str(&args[3])?;
    let mut dev = Developer::from_bytes(&std::fs::read(&args[1])?)?;
    let params = match args.get(4) {
        Some(path) => EditParams::from_json(&std::fs::read_to_string(path)?)?,
        None => EditParams::default_for(dev.metadata()),
    };
    let metadata = ExportMetadata { photo: dev.metadata().clone(), ..Default::default() };
    let t = Instant::now();
    let file = export::render(&mut dev, &params, &options, &metadata)?;
    eprintln!("exported {} bytes in {:?}", file.len(), t.elapsed());
    std::fs::write(&args[2], file)?;
    Ok(())
}
