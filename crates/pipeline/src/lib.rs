//! 🍗 RAWtisserie pixel pipeline — from raw to well done.
//!
//! The pipeline is scene-referred (in the spirit of Ansel/darktable): pixels stay
//! linear, unbounded floats in a Rec.2020 working space for as long as possible
//! and are only squeezed into display range by the tone mapper at the very end.
//!
//! ```text
//! RAW bytes ─▶ decode ─▶ demosaic/bin ─▶ reference (D65) white balance ─▶ camera → working   (cached "base")
//!          ─▶ retouch spots (sensor frame, in place on the base)
//!          ─▶ geometry (lens, orientation, straighten, crop, resample)
//!          ─▶ blur ─▶ sharpen ─▶ contrast equalizer
//!          ─▶ exposure ─▶ colour calibration ─▶ saturation/vibrance ─▶ … ─▶ tone mapping ─▶ sRGB output
//! ```
//!
//! The crate is plain Rust with no platform dependencies so that it can be compiled
//! natively (tests, CLI) and to WebAssembly (browser developer and Node thumbnailer).

pub mod color;
pub mod decode;
pub mod demosaic;
pub mod encode;
pub mod frame;
pub mod image;
pub mod lens;
pub mod metadata;
pub mod ops;
pub mod params;
pub mod pipeline;
pub mod shapes;

pub use decode::RawPhoto;
pub use image::{Image, Region, Rgba8};
pub use metadata::PhotoMetadata;
pub use params::EditParams;
pub use pipeline::{Developer, Quality, RenderSize};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not decode RAW file: {0}")]
    Decode(String),
    #[error("unsupported RAW file: {0}")]
    Unsupported(String),
    #[error("invalid edit parameters: {0}")]
    Params(#[from] serde_json::Error),
    #[error("could not encode image: {0}")]
    Encode(String),
}

pub type Result<T> = std::result::Result<T, Error>;
