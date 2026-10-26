//! Develop a RAW file from the command line:
//!
//! ```sh
//! cargo run --release --example develop -- photo.ARW out.jpg [max-size] [params.json]
//! ```

use std::time::Instant;

use rawtisserie_pipeline::{Developer, EditParams, RenderSize, encode};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: develop <input> <output.jpg> [max-size] [params.json]");
        std::process::exit(2);
    }
    let max: u32 = args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(2048);
    let params = match args.get(4) {
        Some(path) => EditParams::from_json(&std::fs::read_to_string(path)?)?,
        None => EditParams::default(),
    };

    let bytes = std::fs::read(&args[1])?;
    let t = Instant::now();
    let mut dev = Developer::from_bytes(&bytes)?;
    eprintln!("decoded in {:?}", t.elapsed());
    eprintln!("{}", serde_json::to_string_pretty(dev.metadata())?);

    let t = Instant::now();
    let img = dev.render(&params, RenderSize::fit(max, max));
    eprintln!("rendered {}×{} in {:?}", img.width, img.height, t.elapsed());

    std::fs::write(&args[2], encode::jpeg(&img, 90)?)?;
    Ok(())
}
