//! Image operations ("modules", in darktable parlance), applied in pipeline order.

pub mod blend;
pub mod calibration;
pub mod clipping;
pub mod clut;
pub mod diffuse;
pub mod color_balance;
pub mod equalizer;
pub mod filmic;
pub mod filters;
pub mod geometry;
pub mod glow;
pub mod lut;
pub mod lines;
pub mod mask;
pub mod multiple_exposure;
pub mod perspective;
pub mod point;
pub mod primaries;
pub mod retouch;
pub mod tone_curve;
