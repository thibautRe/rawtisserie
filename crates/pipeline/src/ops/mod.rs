//! Image operations ("modules", in darktable parlance), applied in pipeline order.

pub mod blend;
pub mod calibration;
pub mod clipping;
pub mod clut;
pub mod equalizer;
pub mod filmic;
pub mod filters;
pub mod geometry;
pub mod lut;
pub mod lines;
pub mod mask;
pub mod perspective;
pub mod point;
pub mod primaries;
pub mod retouch;
pub mod tone_curve;
