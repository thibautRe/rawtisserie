//! Develop a RAW file from the command line:
//!
//! ```sh
//! cargo run --release --example develop -- photo.ARW out.jpg [max-size] [params.json|-] [lut…]
//! ```
//!
//! Without `params.json` (or with `-`), the image gets the recipe of a new import, plus
//! an instance for each LUT file given (`.cube` or Hald CLUT PNG). With a recipe, the
//! LUT files are loaded for the LUT instances that refer to them.

use std::time::Instant;

use rawtisserie_pipeline::params::{Lut, LutRef};
use rawtisserie_pipeline::{Developer, EditParams, Quality, RenderSize, encode};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: develop <input> <output.jpg> [max-size] [params.json|-] [lut…]");
        std::process::exit(2);
    }
    let max: u32 = args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(2048);
    let bytes = std::fs::read(&args[1])?;
    let t = Instant::now();
    let mut dev = Developer::from_bytes(&bytes)?;
    eprintln!("decoded in {:?}", t.elapsed());
    eprintln!("{}", serde_json::to_string_pretty(dev.metadata())?);

    let mut params = match args.get(4).filter(|a| *a != "-") {
        Some(path) => EditParams::from_json(&std::fs::read_to_string(path)?)?,
        None => EditParams::default_for(dev.metadata()),
    };
    for path in args.iter().skip(5) {
        let id = dev.luts_mut().load(&std::fs::read(path)?)?;
        eprintln!("{path}: {id}");
        if args.get(4).is_none_or(|a| a == "-") {
            params.add(Lut { lut: Some(LutRef { id, name: path.clone(), path: None }), ..Default::default() });
        }
    }

    let t = Instant::now();
    let img = dev.render(&params, RenderSize::fit(max, max), Quality::Final);
    eprintln!("rendered {}×{} in {:?}", img.width, img.height, t.elapsed());

    std::fs::write(&args[2], encode::jpeg(&img, 90)?)?;
    Ok(())
}
